#!/usr/bin/env node
// The standard sweep of a one-use NEAR account (card money-gate-delete-sweep), in three txs: F funds a fresh implicit
// account A; A sends its money back to F in a plain Transfer, which waits until every receipt of it has run (so its gas
// refund reaches A while A still exists, and every receipt succeeds); then A deletes itself into F in a separate tx.
// The money gate reads the two Transfers as any tx (two operators, or the light-client proof alone once dRPC drops
// them) and A as gone (view_account UNKNOWN_ACCOUNT on dRPC and FastNEAR). The DeleteAccount tx is kept out of the
// record: NEAR's gas refund to the deleted A fails by design.
//   node scripts/live-checks/delete-refund-readback.sweep.mjs --network testnet
//       the team's testnet run: F is a fresh faucet account (helper.nearprotocol.com), A a fresh implicit account;
//       both keys live in this process only. Sends real testnet txs.
//   node scripts/live-checks/delete-refund-readback.sweep.mjs --network mainnet [--live] [--funder <F>] [--funder-key <file>]
//       without --live (the default, --dry): real reads, the plan and its cost; nothing is signed, nothing is sent.
//       --live, the owner's paste: F's key from --funder-key (opened only here); A's fresh key is written first to
//       ~/.confidential-trenches/keys/<A>.json (mode 600, never overwritten), so a stop resumes with --a <A>.
// Prints the record lines (Tx: and Deleted:) and the DeleteAccount's id on a line of its own. Prints no key.
import "../net-window.mjs";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { base58, readGone, readTx, RPCS } from "../ci/money-gate.mjs";

export const NET = {
  testnet: { chain: "near-testnet", send: "https://test.rpc.fastnear.com", fund: 10n ** 24n },
  // 0.01 NEAR: all of it comes back to F (the Transfer and the DeleteAccount's payout); the run costs only gas
  mainnet: { chain: "near", send: "https://rpc.mainnet.fastnear.com", fund: 10n ** 22n },
};
export const FUNDER = "951a5eab7965eb95c3aae56d5da9535c21b9fa70da1105b93f4bc220703bfb33"; // g1-money-loop's mainnet funder
const FAUCET = "https://helper.nearprotocol.com/account";
// what A keeps for the DeleteAccount: its storage (NEAR's 10^19 yocto a byte) and 0.001 NEAR for the two txs' gas
// (each about 0.00005 NEAR at 10^8 yocto a gas unit); the rest moves in the Transfer, the keep in the DeleteAccount
const BYTE = 10n ** 19n;
const GAS_KEEP = 10n ** 21n;
const NEAR = (y) => `${y / 10n ** 24n}.${String(y % 10n ** 24n).padStart(24, "0").slice(0, 6)}`;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function enc58(b) {
  let n = BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`);
  let s = "";
  for (; n > 0n; n /= 58n) s = ALPHABET[Number(n % 58n)] + s;
  for (const x of b) {
    if (x !== 0) break;
    s = `1${s}`;
  }
  return s;
}
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const uint = (v, bytes) => {
  const b = Buffer.alloc(bytes);
  for (let i = 0, x = BigInt(v); i < bytes; i++, x >>= 8n) b[i] = Number(x & 255n);
  return b;
};
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, "utf8")]);

/** A V0 Transaction's borsh bytes (transaction.rs:36-51): Transfer (tag 3, u128) or DeleteAccount (tag 7). */
export function txBytes({ signer, publicKey, nonce, receiver, blockHash, action }) {
  const pk = base58(publicKey.replace(/^ed25519:/, ""), 100);
  if (pk.length !== 32) throw new Error("not an ed25519 public key");
  const bh = base58(blockHash);
  if (bh.length !== 32) throw new Error("not a 32-byte block hash");
  const act = "transfer" in action ? Buffer.concat([Buffer.from([3]), uint(action.transfer, 16)]) : Buffer.concat([Buffer.from([7]), str(action.beneficiary)]);
  return Buffer.concat([str(signer), Buffer.from([0]), pk, uint(nonce, 8), str(receiver), bh, u32(1), act]);
}

// an ed25519 key held in this process: { publicKey "ed25519:<b58>", hex (the implicit id), sign(bytes) }
export function keyFromSeed(seed) {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv).export({ format: "jwk" }).x;
  const pb = Buffer.from(pub, "base64url");
  return { publicKey: `ed25519:${enc58(pb)}`, hex: pb.toString("hex"), seed, sign: (msg) => sign(null, msg, priv) };
}
const freshKey = () => keyFromSeed(Buffer.from(generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }).d, "base64url"));
// a near-cli key file ({ account_id, public_key, private_key }) for `account`, checked against itself
function keyFile(path, account) {
  const k = JSON.parse(readFileSync(path, "utf8"));
  if (k?.account_id !== account) throw new Error(`the key file ${path} is for another account`);
  const raw = base58(String(k.private_key).replace(/^ed25519:/, ""), 100);
  if (raw.length !== 64) throw new Error(`the key file ${path} holds no 64-byte ed25519 key`);
  const key = keyFromSeed(raw.subarray(0, 32));
  if (key.publicKey !== k.public_key) throw new Error(`the key file ${path}: its secret does not match its public_key`);
  return key;
}

async function call(fetchFn, url, method, params, ms = 60000) {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const j = await r.json();
  if (j.error || !j.result) throw new Error(`${new URL(url).host} ${method}: ${JSON.stringify(j.error ?? "no result").slice(0, 200)}`);
  return j.result;
}
const view = (fetchFn, url, account) => call(fetchFn, url, "query", { request_type: "view_account", account_id: account, finality: "final" });

/** Signs and sends one tx from `who` (an account and its key), waiting until every receipt ran; returns its id. */
async function send(fetchFn, url, who, receiver, action) {
  const ak = await call(fetchFn, url, "query", { request_type: "view_access_key", account_id: who.account, public_key: who.key.publicKey, finality: "final" });
  const head = await call(fetchFn, url, "block", { finality: "final" });
  const bytes = txBytes({ signer: who.account, publicKey: who.key.publicKey, nonce: BigInt(ak.nonce) + 1n, receiver, blockHash: head.header.hash, action });
  const id = createHash("sha256").update(bytes).digest();
  const signed = Buffer.concat([bytes, Buffer.from([0]), who.key.sign(id)]);
  const r = await call(fetchFn, url, "send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" }, 120000);
  if (!r.status || "Failure" in r.status) throw new Error(`tx ${enc58(id)} failed: ${JSON.stringify(r.status).slice(0, 200)}`);
  return enc58(id);
}

// a tx read back as the money gate reads it, on FastNEAR's archival RPC: "ok" or why not
async function readBack(fetchFn, chain, hash, signer) {
  const url = RPCS[chain][0];
  for (let i = 0; ; i++) {
    const r = await readTx(fetchFn, url, { chain, hash, signer });
    if (r === "ok" || i >= 4) return r;
    await new Promise((ok) => setTimeout(ok, 3000));
  }
}

/** The run. `log` prints a line; returns the record lines. */
export async function run({ network, live, funder = FUNDER, funderKey, a: resumeA, fetchFn = fetch, log = console.log }) {
  const n = NET[network];
  if (!n) throw new Error("--network must be testnet or mainnet");
  const url = n.send;
  const lines = [];
  let F;
  let A;
  if (network === "testnet") {
    const key = freshKey();
    const account = `ct-sweep-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.testnet`;
    const res = await fetchFn(FAUCET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: account, newAccountPublicKey: key.publicKey }), signal: AbortSignal.timeout(60000) });
    if (res.status >= 400) throw new Error(`faucet: HTTP ${res.status}`);
    await res.text();
    for (let i = 0; ; i++)
      try {
        await view(fetchFn, url, account);
        break;
      } catch (e) {
        if (i >= 10) throw new Error(`faucet: ${account} not created (${e.message})`);
        await new Promise((ok) => setTimeout(ok, 2000));
      }
    F = { account, key };
    log(`F ${account}: made by the testnet faucet, its key in this process only`);
  } else {
    const have = await view(fetchFn, url, funder);
    log(`F ${funder} holds ${NEAR(BigInt(have.amount))} NEAR on ${new URL(url).host}`);
    if (!live) {
      log(`DRY: F would send ${NEAR(n.fund)} NEAR to a fresh implicit A; A sends it back in a Transfer (all but its storage and 0.001 NEAR), then deletes itself into F, which gets the rest. Cost: the gas of three small txs, under 0.0002 NEAR. Nothing signed, nothing sent.`);
      return lines;
    }
    if (!funderKey) throw new Error("--live needs --funder-key <file>");
    F = { account: funder, key: keyFile(funderKey, funder) };
  }
  if (resumeA) {
    A = { account: resumeA, key: keyFile(join(homedir(), ".confidential-trenches", "keys", `${resumeA}.json`), resumeA) };
    log(`A ${resumeA}: resumed from its key file`);
  } else {
    const key = freshKey();
    A = { account: key.hex, key };
    if (network === "mainnet") {
      const path = join(homedir(), ".confidential-trenches", "keys", `${A.account}.json`);
      if (existsSync(path)) throw new Error(`refused: ${path} exists`);
      const priv = `ed25519:${enc58(Buffer.concat([key.seed, base58(key.publicKey.slice(8), 100)]))}`;
      writeFileSync(path, `${JSON.stringify({ account_id: A.account, public_key: key.publicKey, private_key: priv })}\n`, { mode: 0o600, flag: "wx" });
      log(`A ${A.account}: its key kept at ${path} (resume with --a ${A.account})`);
    }
    const fund = await send(fetchFn, url, F, A.account, { transfer: n.fund });
    log(`fund: F sent ${NEAR(n.fund)} NEAR to A in ${fund}: ${await readBack(fetchFn, n.chain, fund, F.account)}`);
    lines.push(`Tx: ${n.chain} ${fund} ${F.account}`);
  }
  const a = await view(fetchFn, url, A.account);
  const keep = BigInt(a.storage_usage) * BYTE + GAS_KEEP;
  const move = BigInt(a.amount) - keep;
  if (move <= 0n) throw new Error(`A holds ${NEAR(BigInt(a.amount))} NEAR, not more than the ${NEAR(keep)} it keeps for its DeleteAccount`);
  const sweep = await send(fetchFn, url, A, F.account, { transfer: move });
  const back = await readBack(fetchFn, n.chain, sweep, A.account);
  log(`sweep: A sent ${NEAR(move)} NEAR to F in a plain Transfer ${sweep}: ${back}`);
  if (back !== "ok") throw new Error(`the sweep Transfer reads ${back}: A is not deleted, resume with --a ${A.account}`);
  lines.push(`Tx: ${n.chain} ${sweep} ${A.account}`);
  const del = await send(fetchFn, url, A, A.account, { beneficiary: F.account });
  log(`delete: A deleted itself into F in ${del} (kept out of the record: NEAR's gas refund to the deleted A fails by design)`);
  const hosts = RPCS[n.chain].slice(0, 2); // FastNEAR's archival RPC and dRPC: two operators
  let reads = [];
  for (let i = 0; i < 10; i++) {
    reads = await Promise.all(hosts.map((h) => readGone(fetchFn, h, A.account)));
    if (reads.every((r) => r === "gone")) break;
    await new Promise((ok) => setTimeout(ok, 3000));
  }
  log(`gone: ${hosts.map((h, i) => `${reads[i]} on ${h}`).join(", ")}`);
  if (!reads.every((r) => r === "gone")) throw new Error("A does not read gone on both operators");
  lines.push(`Deleted: ${n.chain} ${A.account}`);
  return lines;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: { network: { type: "string" }, live: { type: "boolean" }, dry: { type: "boolean" }, funder: { type: "string" }, "funder-key": { type: "string" }, a: { type: "string" } } });
  try {
    if (v.live && v.dry) throw new Error("--live and --dry together");
    const lines = await run({ network: v.network, live: !!v.live, funder: v.funder ?? FUNDER, funderKey: v["funder-key"], a: v.a });
    if (lines.length) console.log(`record lines:\n${lines.join("\n")}`);
  } catch (e) {
    console.error(`sweep: ERROR: ${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(1);
  }
}
