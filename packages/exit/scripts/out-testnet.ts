#!/usr/bin/env node
// The exit tool's moves out on NEAR testnet (card exit-ids-out, vault paper 2.12 step 5), on the team's test USDC only:
// a one-time id U and an arming account A of this run's own seed hold USDC on the token, and the exit tool reads them
// (exitHoldings), builds each one's own plain ft_transfer to the typed account X (exitBuildMove, leg "token": U keeps
// one base unit, A moves all; X's registration rides in U's transaction) and self-submits the signed bytes to the
// release's two public testnet RPCs. Every tx is then read FINAL on both, and the balances read back on both.
//
// Accounts:
//   H  the token's holder (holder.<token>, its key text on stdin, kept in this process only, never printed): the
//      stand-in for the typed account's own NEAR (it creates U and A with a plain Transfer) and for the money that
//      reached U and A (it registers each on the token and sends it USDC).
//   U  U_{1,0} and A  A_{1,0} of this run's seed (--state, outside the repo, mode 600; made once, never printed).
//   X  the typed account: a 64-hex implicit id from this run's seed, never created and not registered before the run.
//
// Testnet has no intents.near, so the intents leg and settle (which needs a refund-pending spend) are the sandbox's.
//   <the holder's key text on stdin> node packages/exit/scripts/out-testnet.ts --state <path> [--out <file>]
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entropyToWords, moveOutRpc, readMoveOutFor, wordsToSeed64, type MoveOutRpc } from "@blindfill/kit/core";
import { exitRpc, EXIT_NETWORKS } from "../src/rpc.ts";
import { EXIT_TOKENS } from "../src/scan.ts";
import { exitBuildMove, exitHoldings, exitKey, exitRecipient, type ExitAccount } from "../src/out.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = realpathSync.native(path.resolve(HERE, "../../.."));
const NET = EXIT_NETWORKS.testnet;
const TOKEN = EXIT_TOKENS.testnet;
const HOLDER = `holder.${TOKEN}`;
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const FUND = NEAR / 20n; // 0.05 N each: the move's prepaid gas at the wallet's 12x margin, most of it refunded
const USDC_U = 2_000_000n;
const USDC_A = 1_500_000n;
const [RPC_A, RPC_B] = NET.rpcs;

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
  return { state: st, out: v["--out"] ?? path.join(ROOT, "scripts/live-checks/exit-ids-out.md") };
}
async function rpc(url: string, method: string, params: unknown): Promise<any> {
  for (let k = 0; ; k++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "eio", method, params }), signal: AbortSignal.timeout(60_000) });
    const j = await r.json().catch(() => null);
    if (j && !j.error) return j.result;
    if (k >= 4) throw new Error(`${method}: ${JSON.stringify(j?.error ?? r.status).slice(0, 300)}`);
    await sleep(2_000 * (k + 1));
  }
}
const view = async (url: string, account: string, method: string, a: object) =>
  JSON.parse(Buffer.from((await rpc(url, "query", { request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(a)).toString("base64"), finality: "final" })).result).toString());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- H's own transactions (borsh Transaction V0: Transfer = 3, FunctionCall = 2), signed here with node:crypto ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) (out.push(Number(n & 0xffn)), (n >>= 8n));
  for (const c of s) if (c === "1") out.push(0); else break;
  return Uint8Array.from(out.reverse());
}
function b58encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) (s = B58[Number(n % 58n)] + s), (n /= 58n);
  for (const x of b) if (x === 0) s = "1" + s; else break;
  return s;
}
const le = (x: bigint, n: number) => Uint8Array.from({ length: n }, (_, k) => Number((x >> BigInt(8 * k)) & 0xffn));
const str = (s: string) => { const b = new TextEncoder().encode(s); return [le(BigInt(b.length), 4), b]; };
type Act = { transfer: bigint } | { method: string; args: object; gas: bigint; deposit: bigint };
function encodeTx(signer: string, pub: Uint8Array, nonce: bigint, receiver: string, blockHash: Uint8Array, actions: Act[]): Uint8Array {
  const parts: Uint8Array[] = [...str(signer), Uint8Array.of(0), pub, le(nonce, 8), ...str(receiver), blockHash, le(BigInt(actions.length), 4)];
  for (const a of actions) {
    if ("transfer" in a) parts.push(Uint8Array.of(3), le(a.transfer, 16));
    else { const args = new TextEncoder().encode(JSON.stringify(a.args)); parts.push(Uint8Array.of(2), ...str(a.method), le(BigInt(args.length), 4), args, le(a.gas, 8), le(a.deposit, 16)); }
  }
  return Buffer.concat(parts);
}
async function holderSend(key: { pub: Uint8Array; priv: ReturnType<typeof createPrivateKey> }, receiver: string, actions: Act[]): Promise<string> {
  const ak = await rpc(RPC_A, "query", { request_type: "view_access_key", account_id: HOLDER, public_key: `ed25519:${b58encode(key.pub)}`, finality: "final" });
  const block = await rpc(RPC_A, "block", { finality: "final" });
  const tx = encodeTx(HOLDER, key.pub, BigInt(ak.nonce) + 1n, receiver, b58decode(block.header.hash), actions);
  const digest = createHash("sha256").update(tx).digest();
  const signed = Buffer.concat([tx, Buffer.from([0]), sign(null, digest, key.priv)]);
  const r = await rpc(RPC_A, "send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" });
  const hash = b58encode(digest);
  if ([r.status, ...r.receipts_outcome.map((o: any) => o.outcome.status)].some((s: any) => s && "Failure" in s)) throw new Error(`${hash} failed`);
  return hash;
}

/** The tx FINAL on both RPCs with every receipt a success (polled), else throws. */
async function finalOnBoth(hash: string, signer: string): Promise<void> {
  for (let k = 0; k < 30; k++) {
    const sides = await Promise.all([RPC_A, RPC_B].map((u) => rpc(u, "tx", { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" }).catch(() => null)));
    if (sides.every((r) => r && r.final_execution_status === "FINAL")) {
      for (const r of sides) if ([r.status, ...r.receipts_outcome.map((o: any) => o.outcome.status)].some((s: any) => s && "Failure" in s)) throw new Error(`${hash} failed on chain`);
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`${hash} not FINAL on both RPCs`);
}

async function main() {
  const { state, out } = args();
  if (!existsSync(state)) writeFileSync(state, JSON.stringify({ entropy: randomBytes(16).toString("hex") }), { mode: 0o600 });
  const seed = wordsToSeed64(entropyToWords(Uint8Array.from(Buffer.from(JSON.parse(readFileSync(state, "utf8")).entropy, "hex"))));
  const U_ACC: ExitAccount = { kind: "U", s: 1n, i: 0 };
  const A_ACC: ExitAccount = { kind: "A", l: 1n, j: 0 };
  const idOf = (a: ExitAccount) => { const k = exitKey(seed, a); k.secretKey.fill(0); return k.id; };
  const U = idOf(U_ACC), A = idOf(A_ACC);
  const X = createHash("sha256").update(seed).update("eio/x").digest("hex");
  const text = readFileSync(0, "utf8").trim();
  const raw = b58decode((text.startsWith("{") ? JSON.parse(text).private_key : text).replace(/^ed25519:/, ""));
  const pub = raw.slice(32, 64);
  const priv = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: Buffer.from(raw.slice(0, 32)).toString("base64url"), x: Buffer.from(pub).toString("base64url") }, format: "jwk" });
  raw.fill(0);
  const H = { pub, priv };
  const txs: [string, string][] = [];
  const log = (s: string) => console.log(`eio: ${s}`);
  const min = BigInt((await view(RPC_A, TOKEN, "storage_balance_bounds", {})).min);

  // H funds U and A (skipped where done already: a rerun)
  for (const [id, usdc] of [[U, USDC_U], [A, USDC_A]] as const) {
    const have = BigInt(await view(RPC_A, TOKEN, "ft_balance_of", { account_id: id }).catch(() => "0"));
    if (have >= usdc) continue;
    txs.push([await holderSend(H, id, [{ transfer: FUND }]), HOLDER]);
    txs.push([await holderSend(H, TOKEN, [{ method: "storage_deposit", args: { account_id: id, registration_only: true }, gas: 10n * TGAS, deposit: min }, { method: "ft_transfer", args: { receiver_id: id, amount: usdc.toString() }, gas: 15n * TGAS, deposit: 1n }]), HOLDER]);
  }
  log(`funded: ${txs.length} H tx`);
  await sleep(4_000);

  // the exit tool: the typed account, the holdings, then each account's own move, self-submitted to both RPCs
  const vrpcs = [exitRpc(RPC_A), exitRpc(RPC_B)] as const;
  const mrpcs: readonly [MoveOutRpc, MoveOutRpc] = [moveOutRpc(RPC_A), moveOutRpc(RPC_B)];
  const typed = await exitRecipient(X, "testnet", vrpcs);
  if (!typed.ok) throw new Error(`typed account refused: ${typed.code}`);
  const before = await exitHoldings({ network: "testnet", ids: [U, A, X], rpcs: vrpcs });
  log(`before at ${before.height}: ${before.holdings.map((h) => `${h.id.slice(0, 6)} ${h.token.state === "held" ? h.token.amount : "halted"}`).join(", ")}`);
  const t0 = Date.now();
  const moved: { id: string; amount: bigint; hash: string }[] = [];
  for (const [acc, id] of [[U_ACC, U], [A_ACC, A]] as const) {
    let read = null;
    for (let k = 0; k < 5 && read === null; k++) (read = await readMoveOutFor(id, X, TOKEN, mrpcs)), read === null && (await sleep(3_000));
    if (read === null) throw new Error(`${id.slice(0, 6)}: unread on the pair`);
    const m = exitBuildMove({ seed64: seed, account: acc, network: "testnet", to: typed.recipient, move: { leg: "token", read, storageMin: min } });
    await Promise.all(mrpcs.map((r) => r.call("send_tx", { signed_tx_base64: m.signed, wait_until: "NONE" }).catch(() => null)));
    await finalOnBoth(m.hash, id);
    txs.push([m.hash, id]);
    moved.push({ id, amount: m.amount, hash: m.hash });
    log(`${acc.kind} moved ${m.amount} in ${m.hash}`);
    await sleep(3_000);
  }
  const ms = Date.now() - t0;
  seed.fill(0);
  const after = await exitHoldings({ network: "testnet", ids: [U, A, X], rpcs: vrpcs });
  const amt = (h: (typeof after.holdings)[number]) => (h.token.state === "held" ? h.token.amount : -1n);
  const [bu, ba, bx] = before.holdings.map(amt), [au, aa, ax] = after.holdings.map(amt);
  if (au !== 1n || aa !== 0n || ax !== bx! + bu! - 1n + ba!) throw new Error(`read-back: U ${au}, A ${aa}, X ${ax}`);
  const lines = [
    "CARD exit-ids-out / live: PASS",
    "Money path: yes",
    ...txs.map(([h, s]) => `Tx: near-testnet ${h} ${s}`),
    "",
    `The run: packages/exit/scripts/out-testnet.ts on NEAR testnet, the team's test USDC ${TOKEN}; the reads are the exit tool's exitHoldings and the wallet's readMoveOutFor on the release's testnet pair ${RPC_A} and ${RPC_B}, each move built by exitBuildMove (leg token) and self-submitted to both.`,
    `Accounts: H ${HOLDER} (the stand-in for the typed account's NEAR and for the money that reached U and A), U ${U} (U_{1,0} of this run's seed), A ${A} (A_{1,0}), X ${X} (the typed account: an implicit id, never created, unregistered before the run).`,
    `Steps: H sends U and A ${FUND} yocto NEAR each (creates them), registers each on the token and sends U ${USDC_U} and A ${USDC_A}; the tool reads U, A and X at one block on both RPCs, then U's own tx [storage_deposit(X, registration_only) ${min} yocto, ft_transfer(X, ${moved[0]!.amount})] and A's own tx [ft_transfer(X, ${moved[1]!.amount})], each FINAL on both RPCs, every receipt a success.`,
    `Balances (exitHoldings, both RPCs at one block): before at ${before.height} U ${bu}, A ${ba}, X ${bx}; after at ${after.height} U ${au}, A ${aa}, X ${ax}.`,
    `Times: the two moves, read to FINAL on both, ${ms} ms.`,
    "Every Tx above read back FINAL on both testnet RPCs (H's by send_tx wait_until FINAL); then node scripts/ci/money-gate.mjs on this file.",
    "",
  ];
  writeFileSync(out, lines.join("\n"));
  log(`wrote ${path.relative(ROOT, out)}`);
}
main().catch((e) => {
  console.error(`eio: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
