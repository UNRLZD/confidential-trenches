#!/usr/bin/env node
// The held deposit's way out on NEAR testnet (card held-deposit-way-out), on the team's test USDC only: U, a one-time
// id of this run's own seed, holds USDC on the token with its deposit op held (sender_struck), and the wallet's own
// move (src/deposit/moveout.ts moveOutHeld) sends it to a typed account X by U's own transaction, the registration of
// X in the same transaction. Then a second call, as a reload makes, must send nothing new and read moved.
//
// Accounts:
//   H  the token's holder (holder.<token>, its key text on stdin, kept in this process only, never printed): creates U
//      with NEAR (the stand-in for the NEAR the user sends U from the typed account), registers U and sends it USDC.
//   U  U_{1,0} of this run's seed (--state, outside the repo, mode 600; made once, never printed).
//   X  the typed account: a 64-hex implicit id from this run's seed, never created and not registered on the token.
//
//   <the holder's key text on stdin> node packages/wallet/scripts/held-way-out-testnet.ts --state <path> [--out <file>]
import "../../../scripts/net-window.mjs";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
// @ts-expect-error: a plain .mjs script of the vault's, with no types
import { act, encodeTx } from "../../../contracts/vault/scripts/testnet-usdc.mjs";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import type { DepositOp } from "../src/deposit/follow.ts";
import { moveOutHeld, moveOutRpc, type MoveOutRpc } from "../src/deposit/moveout.ts";
import * as d from "../src/derive/index.ts";
import { depositId } from "../src/derive/keys.ts";
import { openWalletStore } from "../src/store/index.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = realpathSync.native(path.resolve(HERE, "../../.."));
const NET = NEAR_NETWORKS.testnet;
const TOKEN = NET.usdc;
const HOLDER = `holder.${TOKEN}`;
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const U_NEAR = NEAR / 50n; // 0.02 N
const STORAGE_MIN = 1_250_000_000_000_000_000_000n;
const USDC = 2_000_000n;
const SEND = NET.fastnear[0];

function args() {
  const v: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    if (!["--state", "--out"].includes(a[i]!) || a[i + 1] === undefined) throw new Error(`unknown argument ${a[i]}`);
    v[a[i]!] = a[i + 1]!;
  }
  if (!v["--state"]) throw new Error("--state <path> is required");
  const st = path.resolve(v["--state"]);
  if (st.startsWith(ROOT + path.sep)) throw new Error("--state is inside the repository: a seed never lives in the repo");
  return { state: st, out: v["--out"] ?? path.join(ROOT, "scripts/live-checks/held-deposit-way-out.md") };
}
async function rpc(url: string, method: string, params: unknown): Promise<any> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "hwo", method, params }), signal: AbortSignal.timeout(60_000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
}
const view = async (url: string, account: string, method: string, a: object) =>
  JSON.parse(Buffer.from((await rpc(url, "query", { request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(a)).toString("base64"), finality: "final" })).result).toString());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function holderSend(secret: Uint8Array, pub: Uint8Array, receiver: string, actions: unknown[]): Promise<string> {
  const keys = await rpc(SEND, "query", { request_type: "view_access_key", account_id: HOLDER, public_key: `ed25519:${base58.encode(pub)}`, finality: "final" });
  const block = await rpc(SEND, "block", { finality: "final" });
  const tx = encodeTx({ signer: HOLDER, publicKey: pub, nonce: BigInt(keys.nonce) + 1n, receiver, blockHash: base58.decode(block.header.hash), actions });
  const digest = sha256(tx);
  const signed = Buffer.concat([tx, Buffer.from([0]), ed25519.sign(digest, secret)]);
  const r = await rpc(SEND, "send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" });
  const hash = base58.encode(digest);
  const failed = [r.status, ...r.receipts_outcome.map((o: any) => o.outcome.status)].some((s: any) => s && "Failure" in s);
  if (failed) throw new Error(`${hash} failed`);
  return hash;
}

async function main() {
  const { state, out } = args();
  if (!existsSync(state)) writeFileSync(state, JSON.stringify({ entropy: randomBytes(16).toString("hex") }), { mode: 0o600 });
  const seed = d.wordsToSeed64(d.entropyToWords(Uint8Array.from(Buffer.from(JSON.parse(readFileSync(state, "utf8")).entropy, "hex"))));
  const U = depositId(seed, 1n, 0).id;
  const X = Buffer.from(createHash("sha256").update(seed).update("hwo/x").digest()).toString("hex");
  const text = readFileSync(0, "utf8").trim();
  const raw = base58.decode((text.startsWith("{") ? JSON.parse(text).private_key : text).replace(/^ed25519:/, ""));
  const secret = raw.slice(0, 32), pub = ed25519.getPublicKey(secret);
  const txs: [string, string][] = [];
  const log = (s: string) => console.log(`hwo: ${s}`);

  // H creates U with NEAR, registers it on the token and sends it USDC (skipped where already done: a rerun)
  const have = await view(SEND, TOKEN, "ft_balance_of", { account_id: U }).catch(() => "0");
  if (BigInt(have) < USDC) {
    txs.push([await holderSend(secret, pub, U, [act.transfer(U_NEAR)]), HOLDER]);
    txs.push([await holderSend(secret, pub, TOKEN, [act.call("storage_deposit", { account_id: U, registration_only: true }, 10n * TGAS, STORAGE_MIN), act.call("ft_transfer", { receiver_id: U, amount: USDC.toString() }, 15n * TGAS, 1n)]), HOLDER]);
    log(`U funded: ${txs.map(([h]) => h).join(" ")}`);
  }
  await sleep(3_000);

  // the device: a held op for U, then the wallet's move, then a second call as a reload makes it
  const ops = await openWalletStore({ indexedDB: new IDBFactory() });
  const op: DepositOp = { kind: "deposit", stage: "held", txs: [], created_ms: Date.now(), held_id: U, follow: { network: "testnet", s: "1", i: 0, u: U, address: "testnet-run", deadline_ms: 1, origin: `nep141:${TOKEN}`, min_out: "1000000", why: "sender_struck" } };
  await ops.put("ops", "held-run", op);
  let sends = 0;
  const counted = (r: MoveOutRpc): MoveOutRpc => ({ ...r, call: (m, p) => (m === "send_tx" && sends++, r.call(m, p)) });
  const rpcs = [counted(moveOutRpc(NET.fastnear[0])), counted(moveOutRpc(NET.drpc))] as const;
  const before = { u: await view(SEND, TOKEN, "ft_balance_of", { account_id: U }), x: await view(SEND, TOKEN, "ft_balance_of", { account_id: X }), xReg: await view(SEND, TOKEN, "storage_balance_of", { account_id: X }) };
  const t0 = Date.now();
  let first = await moveOutHeld("held-run", X, { ops, rpcs, seed64: async () => seed.slice(), pollMs: 1_000 });
  const asked: string[] = [first.kind];
  // U short of NEAR: the "typed account" (H, the stand-in) sends U what the device asks, then the same tap again
  let topUp = 0n;
  if (first.kind === "gas") {
    topUp = first.need;
    txs.push([await holderSend(secret, pub, U, [act.transfer(first.need)]), HOLDER]);
    await sleep(3_000);
    first = await moveOutHeld("held-run", X, { ops, rpcs, seed64: async () => seed.slice(), pollMs: 1_000 });
    asked.push(first.kind);
  }
  secret.fill(0);
  for (let k = 0; first.kind === "sent" && k < 10; k++) (first = await moveOutHeld("held-run", null, { ops, rpcs, seed64: async () => seed.slice(), pollMs: 1_000 })), asked.push(first.kind);
  const ms = Date.now() - t0;
  log(`first: ${first.kind}`);
  if (first.kind !== "moved") throw new Error(`the move did not land: ${JSON.stringify(first, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  const sentBefore = sends;
  let opened = 0;
  const again = await moveOutHeld("held-run", "someone-else.testnet", { ops, rpcs, seed64: async () => (opened++, seed.slice()), pollMs: 1_000 });
  if (again.kind !== "moved" || sends !== sentBefore || opened !== 0) throw new Error("the second call signed or sent something");
  const rec = ((await ops.get("ops", "held-run")) as DepositOp).follow;
  txs.push([rec.out!.hash, U]);
  await sleep(3_000);
  const sides = await Promise.all([NET.fastnear[0], NET.drpc].map(async (u) => ({ u: await view(u, TOKEN, "ft_balance_of", { account_id: U }), x: await view(u, TOKEN, "ft_balance_of", { account_id: X }) })));
  if (sides.some((s) => s.u !== "1" || s.x !== (BigInt(before.x) + BigInt(before.u) - 1n).toString())) throw new Error(`read-back: ${JSON.stringify(sides)}`);
  const lines = [
    "CARD held-deposit-way-out / live: PASS",
    "Money path: yes",
    ...txs.map(([h, s]) => `Tx: near-testnet ${h} ${s}`),
    "",
    `The run: packages/wallet/scripts/held-way-out-testnet.ts on NEAR testnet, the team's test USDC ${TOKEN}; the move is the wallet's own moveOutHeld (src/deposit/moveout.ts) on the release's testnet pair ${NET.fastnear[0]} and ${NET.drpc}, from a held deposit op (why sender_struck) in a fake-indexeddb wallet store.`,
    `Accounts: H ${HOLDER} (funds U: the stand-in for the NEAR the user sends U from the typed account), U ${U} (U_{1,0} of this run's seed), X ${X} (the typed account: an implicit id, never created, registration ${before.xReg === null ? "null" : "set"} before the move).`,
    `Steps: H sends U ${U_NEAR} yocto NEAR (creates U); H registers U on the token and sends it ${USDC}; the device reads U and X at one block on both RPCs, signs U's transaction [storage_deposit(X, registration_only) ${STORAGE_MIN} yocto, ft_transfer(X, ${BigInt(before.u) - 1n}) 1 yocto] at U's key nonce + 1, records it in the op, sends it to both RPCs and reads it FINAL on both, every receipt a success; the op ends held with why ${rec.why}.`,
    `The device's answers in order: ${asked.join(", ")}${topUp > 0n ? `; on gas it asked for ${topUp} yocto more NEAR in U, which H sent (the stand-in for the user's send from the typed account)` : ""}.`,
    `Resume: a second call (as a reload makes, with another account typed) answered ${again.kind}, opened no seed and sent nothing (send_tx calls ${sentBefore} before, ${sends} after).`,
    `Balances before: U ${before.u}, X ${before.x}. After, on both RPCs: ${JSON.stringify(sides)}.`,
    `Times: first call to moved ${ms} ms.`,
    "Every Tx above read back FINAL on both testnet RPCs by the wallet (U's) or by send_tx wait_until FINAL (H's); then node scripts/ci/money-gate.mjs on this file.",
    "",
  ];
  writeFileSync(out, lines.join("\n"));
  log(`wrote ${path.relative(ROOT, out)}`);
  ops.close();
}
main().catch((e) => {
  console.error(`hwo: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
