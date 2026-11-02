#!/usr/bin/env node
// Puts the real USDC code on NEAR testnet, set up the way mainnet's token was, with test accounts in every role, so the
// testnet money runs move the real token's code (vault.md 5: "the real USDC wasm ... initialised with test accounts in
// its roles"; V3.1).
//
// 1. The wasm: mainnet USDC's deployed code (17208628…33a1), pulled by view_code on two mainnet RPCs and refused unless
//    both answer the pinned bytes (vault.md Pinned sources, USDC row: 321,491 B, sha256 b98ccd53…cfe6, code hash
//    DVJx7F3d…oNX8q). Reads only on mainnet: nothing is signed or sent there.
// 2. One testnet key, made in this process and written to the macOS Keychain (the service named by --keychain-service,
//    account = the token's id) before any account exists, then read back and compared; it is never printed or written
//    to a file. The flag is required: the script names no Keychain item of its own.
// 3. The token: a fresh named account the testnet faucet makes with that key (as mainnet's token account holds one
//    full-access key). It creates the role accounts <role>.<token>, each with the same key and 0.2 N.
// 4. One transaction signed by the token to itself, [DeployContract, FunctionCall init], as mainnet's tx
//    FEJRCgwWzY58dqG1WYiy1VAiVQZYvUMSQVkQ428t7V82 (block 79,039,311). The deployed code reads exactly six init names,
//    "admin_ids master_minter_ids owner_ids pauser_ids blocklister_id metadata ... struct Input with 6 elements" (its
//    data section); mainnet's first code also took approval_threshold and validity_period, which this one does not.
//    The metadata is mainnet's own ft_metadata, read at run time.
// 5. As mainnet then did: master minters configure two controllers for the minter, the controllers configure its
//    allowance, each by a multisig request (create, two approvals, execute); the holder registers; the minter mints to
//    the holder. The same steps ran against the same bytes in near-sandbox (research proofs/g1-vault-gas/sandbox/src/
//    payouts.rs l.135-266).
// Every transaction is read back by the money gate's own readTx on the testnet RPCs and must read ok on two of them.
// The ids, the tx hashes and the code hash go to contracts/vault/deployments/testnet-usdc.json; then run
// scripts/live-checks/vault-testnet-usdc.mjs. Testnet only; no dependency.
// --pausers 2 makes a second pauser (pauser2.<token>) at init: USDC's Pause and Unpause each want two pausers'
// approvals (InsufficientApprovals { current: 1, required: 2 } on the one-pauser token, 2026-11-02), so only such a
// token can be halted and opened again on testnet, for the token watch's halted-then-open run. Mainnet's token has four.
//   node contracts/vault/scripts/testnet-usdc.mjs --keychain-service <name> [--token <name>.testnet] [--out <file>] [--pausers 1|2]
import "../../../scripts/net-window.mjs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { b58encode, b58decode } from "./near-tx.mjs";
import { RPCS as GATE_RPCS, okOperators, proveRead, readTx } from "../../../scripts/ci/money-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const PIN = { bytes: 321_491, sha256: "b98ccd530f7e643cfef32f4529ade060ef87ff73b0101536399470777b86cfe6", codeHash: "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q" };
// two independent mainnet providers, as research proofs/g1-vault-gas/sandbox/usdc/fetch.py read the pin
export const MAINNET_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
export const TESTNET_RPCS = GATE_RPCS["near-testnet"];
const SEND_RPC = "https://test.rpc.fastnear.com";
const FAUCET = "https://helper.nearprotocol.com/account"; // near-cli-rs's testnet faucet (`create-account sponsor-by-faucet-service`)
export const ROLES = ["admin", "owner", "pauser", "blocklister", "mm1", "mm2", "minter", "ctl1", "ctl2", "holder"];
/** The role accounts for `pausers` pausers (1 or 2): a second pauser is pauser2. */
export const rolesFor = (pausers = 1) => (pausers === 2 ? [...ROLES.slice(0, 3), "pauser2", ...ROLES.slice(3)] : ROLES);
/** --pausers: 1 (the default) or 2; anything else refused. */
export function pausersOf(argv) {
  const i = argv.indexOf("--pausers");
  if (i < 0) return 1;
  const v = argv[i + 1];
  if (v !== "1" && v !== "2") throw new Error(`--pausers ${JSON.stringify(v)}: want 1 or 2`);
  return Number(v);
}
export const INIT_NAMES = ["admin_ids", "master_minter_ids", "owner_ids", "pauser_ids", "blocklister_id", "metadata"];
export const ALLOWANCE = "1000000000000000"; // 1,000,000,000 USDC of allowance for the minter
export const MINTED = "1000000000000"; // 1,000,000 USDC to the holder
const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const ROLE_FUND = NEAR / 5n;

// What is wrong with bytes offered as mainnet USDC's code: [] when they are the pin.
export function wasmProblems(buf, reportedHash) {
  const b = Buffer.from(buf);
  const sha = createHash("sha256").update(b).digest("hex");
  const h = b58encode(Buffer.from(sha, "hex"));
  const p = [];
  if (b.length !== PIN.bytes) p.push(`${b.length} B, want ${PIN.bytes}`);
  if (sha !== PIN.sha256) p.push(`sha256 ${sha}, want ${PIN.sha256}`);
  if (h !== PIN.codeHash) p.push(`code hash ${h}, want ${PIN.codeHash}`);
  if (reportedHash !== undefined && reportedHash !== h) p.push(`the RPC reports code hash ${reportedHash}, the bytes hash to ${h}`);
  // the six init names the code reads, in its own data section
  if (!b.includes("admin_idsmaster_minter_idsowner_idspauser_idsblocklister_idmetadatastruct Input with 6 elements")) p.push("its init does not read the six names");
  return p;
}

// init's arguments: the six names the deployed code reads, each role a test account
export function initArgs(token, metadata, pausers = 1) {
  const r = (x) => `${x}.${token}`;
  return {
    admin_ids: [r("admin")],
    master_minter_ids: [r("mm1"), r("mm2")],
    owner_ids: [r("owner")],
    pauser_ids: pausers === 2 ? [r("pauser"), r("pauser2")] : [r("pauser")],
    blocklister_id: r("blocklister"),
    metadata,
  };
}

// ---- Borsh, nearcore's Transaction V0 (no version tag); Action indexes CreateAccount 0, DeployContract 1,
// FunctionCall 2, Transfer 3, AddKey 5; PublicKey and Signature tag ED25519 = 0; AccessKeyPermission FullAccess = 1
class Borsh {
  parts = [];
  u8(x) { this.parts.push(Buffer.from([x])); return this; }
  u32(x) { const b = Buffer.alloc(4); b.writeUInt32LE(x); this.parts.push(b); return this; }
  u64(x) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(x)); this.parts.push(b); return this; }
  u128(x) { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(x) & 0xffffffffffffffffn); b.writeBigUInt64LE(BigInt(x) >> 64n, 8); this.parts.push(b); return this; }
  fixed(bytes) { this.parts.push(Buffer.from(bytes)); return this; }
  bytes(bytes) { return this.u32(bytes.length).fixed(bytes); }
  string(s) { return this.bytes(Buffer.from(s, "utf8")); }
  done() { return Buffer.concat(this.parts); }
}
export const act = {
  create: () => ({ kind: "CreateAccount" }),
  deploy: (wasm) => ({ kind: "DeployContract", wasm }),
  call: (method, args, gas = 100n * TGAS, deposit = 0n) => ({ kind: "FunctionCall", method, args, gas, deposit }),
  transfer: (amount) => ({ kind: "Transfer", amount }),
  fullKey: (pub) => ({ kind: "AddKey", pub }),
};
export function encodeTx({ signer, publicKey, nonce, receiver, blockHash, actions }) {
  const w = new Borsh().string(signer).u8(0).fixed(publicKey).u64(nonce).string(receiver).fixed(blockHash).u32(actions.length);
  for (const a of actions) {
    if (a.kind === "CreateAccount") w.u8(0);
    else if (a.kind === "DeployContract") w.u8(1).bytes(a.wasm);
    else if (a.kind === "FunctionCall") w.u8(2).string(a.method).bytes(Buffer.from(JSON.stringify(a.args))).u64(a.gas).u128(a.deposit);
    else if (a.kind === "Transfer") w.u8(3).u128(a.amount);
    else if (a.kind === "AddKey") w.u8(5).u8(0).fixed(a.pub).u64(0).u8(1);
    else throw new Error(`no such action ${a.kind}`);
  }
  return w.done();
}

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "testnet-usdc", method, params }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 400)}`);
  if (j.result?.error) throw new Error(`${method}: ${String(j.result.error).slice(0, 400)}`);
  return j.result;
}
const view = async (url, account, method, args = {}) => {
  const r = await rpc(url, "query", { request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), finality: "final" });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mainnet USDC's code from two mainnet RPCs, both the pin and equal; mainnet's ft_metadata from the first
async function pullMainnet() {
  const blobs = [];
  for (const url of MAINNET_RPCS) {
    const c = await rpc(url, "query", { request_type: "view_code", account_id: MAINNET_USDC, finality: "final" });
    const raw = Buffer.from(c.code_base64, "base64");
    const p = wasmProblems(raw, c.hash);
    if (p.length) throw new Error(`refused before any send: ${url}: ${p.join("; ")}`);
    blobs.push(raw);
  }
  if (!blobs[0].equals(blobs[1])) throw new Error("refused before any send: the two mainnet RPCs' bytes differ");
  const metadata = await view(MAINNET_RPCS[0], MAINNET_USDC, "ft_metadata");
  return { wasm: blobs[0], metadata };
}

/** The Keychain service from --keychain-service: required, no default, and one plain word, since it goes into the
 *  `security -i` command line below. */
export function keychainService(argv) {
  const i = argv.indexOf("--keychain-service");
  const v = i < 0 ? undefined : argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error("--keychain-service <name> is required: the Keychain service the key is written to");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(v)) throw new Error(`--keychain-service ${JSON.stringify(v)}: want letters, digits, '.', '_' or '-'`);
  return v;
}

// the Keychain: written through `security -i` on stdin, so the secret is never in a process's arguments
function keychainPut(service, account, secret) {
  execFileSync("security", ["-i"], { input: `add-generic-password -U -s ${service} -a ${account} -w ${secret}\n`, stdio: ["pipe", "ignore", "pipe"] });
  const back = execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  if (back !== secret) throw new Error("the Keychain does not read back the key it was given; nothing made");
}

async function main() {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const service = keychainService(a);
  const pausers = pausersOf(a);
  const roles = rolesFor(pausers);
  const out = opt("--out", path.join(HERE, "../deployments/testnet-usdc.json"));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "t").toLowerCase();
  const token = opt("--token", `bf-usdc-${stamp}.testnet`);
  if (!/^[a-z0-9-]+\.testnet$/.test(token)) throw new Error(`token ${token}: want a named <name>.testnet`);

  const { wasm, metadata } = await pullMainnet();
  if (metadata.symbol !== "USDC" || metadata.decimals !== 6) throw new Error(`mainnet ft_metadata: ${metadata.symbol}, ${metadata.decimals}`);
  console.log(`wasm: mainnet ${MAINNET_USDC}'s code, ${wasm.length} B, code hash ${PIN.codeHash} on ${MAINNET_RPCS.join(" and ")}, equal bytes`);

  // the key, kept in the Keychain before anything is made with it
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const pub = Buffer.from(jwk.x, "base64url");
  const seed = Buffer.from(jwk.d, "base64url");
  const pubText = `ed25519:${b58encode(pub)}`;
  keychainPut(service, token, `ed25519:${b58encode(Buffer.concat([seed, pub]))}`);
  console.log(`key ${pubText} written to the Keychain (service ${service}, account ${token}) and read back`);

  const txs = [];
  const nonces = new Map();
  async function send(signer, receiver, actions, what) {
    if (!nonces.has(signer)) {
      let ak;
      for (let i = 0; i < 30 && !ak; i++) {
        try {
          ak = await rpc(SEND_RPC, "query", { request_type: "view_access_key", account_id: signer, public_key: pubText, finality: "final" });
        } catch {
          await sleep(2000);
        }
      }
      if (!ak) throw new Error(`${signer}'s key is not visible on ${SEND_RPC}`);
      nonces.set(signer, BigInt(ak.nonce));
    }
    const nonce = nonces.get(signer) + 1n;
    nonces.set(signer, nonce);
    const block = await rpc(SEND_RPC, "block", { finality: "final" });
    const tx = encodeTx({ signer, publicKey: pub, nonce, receiver, blockHash: b58decode(block.header.hash), actions });
    const hash = createHash("sha256").update(tx).digest();
    const signed = Buffer.concat([tx, Buffer.from([0]), sign(null, hash, privateKey)]);
    const txHash = b58encode(hash);
    const r = await rpc(SEND_RPC, "send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" });
    const failed = [r.transaction_outcome, ...r.receipts_outcome].filter((o) => o.outcome.status.Failure);
    if (!("SuccessValue" in (r.status ?? {})) || failed.length) throw new Error(`${what} (${txHash}) failed: ${JSON.stringify(failed[0]?.outcome.status ?? r.status).slice(0, 400)}`);
    const gas = [r.transaction_outcome, ...r.receipts_outcome].reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
    // tx_bytes: the signed borsh Transaction, which hashes to the tx's id; the money gate proves a tx one operator
    // reads only with them (scripts/ci/money-gate.mjs txBytesFacts)
    const entry = { what, hash: txHash, signer, receiver, gas_burnt: String(gas), tx_bytes: tx.toString("base64") };
    txs.push(entry);
    console.log(`ok ${what}: ${txHash} (${signer} -> ${receiver}), ${Number(gas) / 1e12} Tgas burnt`);
    return r;
  }

  // 1. the token, from the faucet
  const res = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: token, newAccountPublicKey: pubText }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`faucet: HTTP ${res.status}: ${text.slice(0, 300)}`);
  const fo = JSON.parse(text).final_execution_outcome ?? JSON.parse(text);
  const sv = fo?.status?.SuccessValue;
  if (sv === undefined || Buffer.from(sv, "base64").toString() === "false") throw new Error(`faucet: not created: ${JSON.stringify(fo?.status).slice(0, 300)}`);
  txs.push({ what: "faucet: create the token account", hash: fo.transaction_outcome?.id ?? fo.transaction?.hash, signer: fo.transaction?.signer_id, receiver: fo.transaction?.receiver_id });
  console.log(`token ${token} made by the faucet, tx ${txs[0].hash} signed by ${txs[0].signer}`);

  // 2. the role accounts, each with the team key
  const id = (role) => `${role}.${token}`;
  for (const role of roles) await send(token, id(role), [act.create(), act.transfer(ROLE_FUND), act.fullKey(pub)], `create ${id(role)}`);

  // 3. deploy + init, signed by the token to itself
  const init = initArgs(token, metadata, pausers);
  await send(token, token, [act.deploy(wasm), act.call("init", init, 300n * TGAS)], "deploy the USDC wasm + init");
  const acct = await rpc(SEND_RPC, "query", { request_type: "view_account", account_id: token, finality: "final" });
  if (acct.code_hash !== PIN.codeHash) throw new Error(`deployed, but ${token}'s code hash is ${acct.code_hash}`);

  // 4. multisig: two controllers for the minter, then the minter's allowance
  async function multisig(by, action, approvers, executor, what) {
    const rid = await view(SEND_RPC, token, "get_next_multisig_request_id");
    await send(id(by), token, [act.call("create_multisig_request", { action })], `${what}: ${by} creates request ${rid}`);
    for (const ap of approvers) await send(id(ap), token, [act.call("approve_multisig_request", { request_id: rid })], `${what}: ${ap} approves request ${rid}`);
    await send(id(executor), token, [act.call("execute_multisig_request", { request_id: rid })], `${what}: ${executor} executes request ${rid}`);
  }
  for (const ctl of ["ctl1", "ctl2"]) await multisig("mm1", { ConfigureController: { minter_id: id("minter"), controller_id: id(ctl) } }, ["mm1", "mm2"], "mm2", `ConfigureController ${ctl}`);
  await multisig("ctl1", { ConfigureMinterAllowance: { controller_id: id("ctl1"), minter_allowance: ALLOWANCE } }, ["ctl1", "ctl2"], "ctl2", "ConfigureMinterAllowance");

  // 5. the holder registers; the minter mints to it
  const bounds = await view(SEND_RPC, token, "storage_balance_bounds");
  await send(id("holder"), token, [act.call("storage_deposit", { account_id: id("holder"), registration_only: true }, 100n * TGAS, BigInt(bounds.min))], "holder registers (storage_deposit)");
  await send(id("minter"), token, [act.call("mint", { to: id("holder"), amount: MINTED })], `minter mints ${MINTED} to the holder`);
  const bal = await view(SEND_RPC, token, "ft_balance_of", { account_id: id("holder") });
  if (bal !== MINTED) throw new Error(`the holder holds ${bal}, want ${MINTED}`);

  // 6. the record, written before the read-back so a stalled RPC never loses what landed
  const doc = {
    network: "testnet",
    account_id: token,
    code_hash: PIN.codeHash,
    wasm_sha256: PIN.sha256,
    wasm_bytes: wasm.length,
    wasm_from: `view_code of mainnet ${MAINNET_USDC} on ${MAINNET_RPCS.join(" and ")}, equal bytes`,
    key: { public_key: pubText, holders: [token, ...roles.map(id)] },
    roles: Object.fromEntries(roles.map((r) => [r, id(r)])),
    init: { ...init, metadata: { ...metadata, icon: metadata.icon ? `<mainnet's icon, ${metadata.icon.length} chars>` : null } },
    minter_allowance: ALLOWANCE,
    holder: id("holder"),
    minted: MINTED,
    storage_balance_bounds: bounds,
    txs,
    deployed_at: new Date().toISOString(),
  };
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${out}`);

  // 7. every tx read back by the money gate's readTx, in the money gate's RPC order until two operators read ok (the
  // third host, archival-rpc.testnet.near.org, is FastNEAR's again and answers 429 with a Retry-After of minutes, so
  // it is asked only when needed); none may read failed or old. A tx one operator reads passes only by its light-client
  // proof, the money gate's own rule (proveRead). The live check reads them again by the same rule.
  for (const t of txs) {
    let reads = [];
    for (let i = 0; i < 6; i++) {
      reads = [];
      for (const url of TESTNET_RPCS) {
        if (okOperators("near-testnet", reads).size >= 2) break;
        const out = {};
        reads.push({ url, r: await readTx(fetch, url, { chain: "near-testnet", hash: t.hash, signer: t.signer }, undefined, undefined, true, out), result: out.result });
      }
      if (okOperators("near-testnet", reads).size >= 2) break;
      await sleep(5000);
    }
    const reading = `${t.hash} (${t.what}) reads ${reads.map((x) => `${x.r} on ${x.url}`).join(", ")}`;
    if (reads.some((x) => /^(failed|old)/.test(x.r))) throw new Error(reading);
    if (okOperators("near-testnet", reads).size < 2)
      try {
        console.log(await proveRead(fetch, { chain: "near-testnet", hash: t.hash, signer: t.signer, bytes: t.tx_bytes }, reads, TESTNET_RPCS));
      } catch (e) {
        throw new Error(`${reading}; not proven: ${e.message}`);
      }
  }
  console.log(`every tx (${txs.length}) reads ok on two testnet operators, or is proven; next: node scripts/live-checks/vault-testnet-usdc.mjs`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(`testnet-usdc: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(1);
  });
}
