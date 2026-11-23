// Card wallet-u-restore-exit: the NEAR exit moves what the vault scope's one-time deposit ids U_{s,i} hold out to the
// typed account (vault paper 2.12 step 5, "Nothing into the vault"), on a model of the release's mainnet pair. Only the
// note scan is mocked (no note is open); the deposit ids' walk is the wallet's own (restoreDepositIds on nearIdReader at
// one pass block), and the reads, the fee wait, the moves, the sends and their read back are near-out.ts's and out.ts's
// against the model. Each signed transaction is decoded from its bytes (nearcore's borsh Transaction V0): its signer is
// that U, its receiver the token or intents.near, its one call names the typed account, and U's own key signed it.
// Module mocks need a flag, so test/near-out-ids.test.ts runs this file:
//   node --experimental-test-module-mocks --test test/near-out-ids.cases.ts
// Test secrets come from the published all-zero BIP-39 vector (packages/wallet/test/vectors/a8.json), never money.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VAULT_TOKEN_CODE_HASH, vaultScopeOf } from "@blindfill/kit";
import { depositId, wordsToSeed64 } from "@blindfill/kit/core";

const realScan = await import("../src/scan.ts");
const { EXIT_NETWORKS } = await import("../src/rpc.ts");
const { EXIT_TOKENS } = realScan;

const NET = "mainnet" as const;
const VAULT = EXIT_NETWORKS[NET].vault;
const TOKEN = EXIT_TOKENS[NET];
const [N0, N1] = EXIT_NETWORKS[NET].rpcs;
const SEED = wordsToSeed64("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
const SCOPE = vaultScopeOf(keccak_256, VAULT, TOKEN);
const uOf = (i: number) => {
  const k = depositId(SEED, SCOPE, i);
  k.secretKey.fill(0);
  return k.id;
};
const U3 = uOf(3), U7 = uOf(7), U11 = uOf(11);
const TYPED = "typed-user.near";
const H = 200_000_000;
const HASH = "11111111111111111111111111111111111111111111"; // a 44-char base58 hash for the views
const BLOCK = "11111111111111111111111111111111"; // 32 zero bytes, base58: the block a move signs on
const NEP141 = `nep141:${TOKEN}`;

// the scan: no note open, every lane walked to its gap (the note walk's end), nothing found
mock.module(new URL("../src/scan.ts", import.meta.url).href, {
  namedExports: {
    ...realScan,
    exitScanSeed: async () => ({
      height: H, finalHeights: [H, H], blockHash: HASH, cursor: {}, notes: [], spends: [], pendingRefunds: [],
      laneHighest: Array(8).fill(null), laneWalked: Array.from({ length: 8 }, (_, k) => k + 8 * 20),
      network: NET, vault: VAULT, token: TOKEN,
    }),
  },
});
const { nearExitWith } = await import("../src/near-out.ts");

// ---------- the model pair ----------
type Obj = Record<string, unknown>;
type World = { failOn?: { rpc: number; id: string } };
const ok = (result: Obj) => ({ jsonrpc: "2.0", id: "x", result: { ...result, block_height: H, block_hash: HASH } });
const viewOf = (v: unknown) => ok({ result: [...new TextEncoder().encode(JSON.stringify(v))], logs: [] });
const unknown = { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, code: -32000 } };
const broken = { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "INTERNAL_ERROR", info: {} }, code: -32000, message: "down" } };
const FUNDED = 10n ** 24n; // 1 NEAR on each U once the user sent it

function query(k: number, w: World, p: Obj): unknown {
  const args = typeof p.args_base64 === "string" ? (JSON.parse(atob(p.args_base64)) as Obj) : {};
  const who = (args.account_id ?? p.account_id) as string;
  if (w.failOn && w.failOn.rpc === k && who === w.failOn.id) return broken;
  if (p.request_type === "view_account") {
    if (p.account_id === TOKEN) return ok({ amount: "1", code_hash: VAULT_TOKEN_CODE_HASH, storage_usage: 1 });
    if (p.account_id === "intents.near" || p.account_id === TYPED) return ok({ amount: "1", code_hash: "11111111111111111111111111111111", storage_usage: 1 });
    // a U the user funded for its gas (the walk reads it at the pass block, before: so only the money ids exist)
    if (p.account_id === U3 || p.account_id === U7) return ok({ amount: FUNDED.toString(), code_hash: "11111111111111111111111111111111", storage_usage: 182 });
    return unknown;
  }
  if (p.request_type === "view_access_key_list") {
    const pk = `ed25519:${base58(Uint8Array.from(Buffer.from(p.account_id as string, "hex")))}`;
    return ok({ keys: [{ public_key: pk, access_key: { nonce: 5, permission: "FullAccess" } }] });
  }
  if (p.request_type !== "call_function") throw new Error(`unexpected ${String(p.request_type)}`);
  const m = p.method_name;
  if (p.account_id === TOKEN) {
    if (m === "storage_balance_bounds") return viewOf({ min: "1250000000000000000000", max: "1250000000000000000000" });
    if (m === "storage_balance_of") return viewOf(who === TYPED || who === U3 ? { total: "1250000000000000000000", available: "0" } : null);
    if (m === "ft_balance_of") return viewOf(who === U3 ? "2500000" : "0");
  }
  if (p.account_id === "intents.near") {
    if (m === "mt_tokens_for_owner") return viewOf(who === U7 ? [{ token_id: NEP141 }] : []);
    if (m === "mt_batch_balance_of") return viewOf(who === U7 ? ["4000000"] : []);
    if (m === "mt_balance_of") return viewOf(who === U7 ? "4000000" : "0");
  }
  throw new Error(`unexpected ${String(p.account_id)}.${String(m)}`);
}
const vrpc = (k: number, w: World) => ({ name: [N0, N1][k]!, query: async (p: Obj) => query(k, w, p) });
function mrpc(k: number, w: World, sent: string[]) {
  return {
    name: [N0, N1][k]!,
    query: async (p: Obj) => query(k, w, p),
    block: async () => ({ jsonrpc: "2.0", id: "x", result: { header: { height: H, hash: BLOCK, timestamp_nanosec: "1763000000000000000" } } }),
    tx: async () => ({}),
    call: async (method: string, params: Obj) => {
      if (method === "gas_price") return { jsonrpc: "2.0", id: "x", result: { gas_price: "100000000" } };
      if (method === "query") return query(k, w, params);
      if (method === "send_tx") return (sent.push(params.signed_tx_base64 as string), { jsonrpc: "2.0", id: "x", result: {} });
      if (method === "tx") return { jsonrpc: "2.0", id: "x", result: { final_execution_status: "FINAL", status: { SuccessValue: "" }, receipts_outcome: [] } };
      throw new Error(`unexpected ${method}`);
    },
  };
}

// ---------- the signed bytes (borsh Transaction V0, then the ed25519 signature) ----------
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(b: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`);
  let s = "";
  while (n > 0n) (s = ALPHA[Number(n % 58n)] + s), (n /= 58n);
  for (const x of b) if (x === 0) s = `1${s}`; else break;
  return s;
}
type Tx = { signer: string; pk: string; nonce: bigint; receiver: string; calls: { method: string; args: Obj; gas: bigint; deposit: bigint }[]; verified: boolean };
function decode(signed64: string): Tx {
  const b = Buffer.from(signed64, "base64");
  let at = 0;
  const u32 = () => (at += 4, b.readUInt32LE(at - 4));
  const int = (n: number) => { let x = 0n; for (let k = n - 1; k >= 0; k--) x = (x << 8n) | BigInt(b[at + k]!); at += n; return x; };
  const str = () => { const n = u32(); at += n; return b.subarray(at - n, at).toString("utf8"); };
  const signer = str();
  assert.equal(b[at++], 0, "an ed25519 key");
  const pk = b.subarray(at, (at += 32));
  const nonce = int(8);
  const receiver = str();
  at += 32;
  const calls: Tx["calls"] = [];
  for (let n = u32(); n > 0; n--) {
    assert.equal(b[at++], 2, "a FunctionCall");
    const method = str();
    const args = JSON.parse(str()) as Obj;
    calls.push({ method, args, gas: int(8), deposit: int(16) });
  }
  const body = b.subarray(0, at);
  assert.equal(b[at++], 0, "an ed25519 signature");
  const sig = b.subarray(at, at + 64);
  const verified = ed25519.verify(sig, createHash("sha256").update(body).digest(), pk);
  return { signer, pk: pk.toString("hex"), nonce, receiver, calls, verified };
}

const run = async (w: World) => {
  const sent: string[] = [];
  const said: string[] = [];
  const exit = nearExitWith({ rpcs: [vrpc(0, w), vrpc(1, w)] as never, moveRpcs: [mrpc(0, w, sent), mrpc(1, w, sent)] as never, prover: {} as never, sleep: async () => {} });
  const r = exit({ seed: SEED, to: TYPED, rpcs: [N0, N1], say: (l) => said.push(l) });
  return { r, sent, said };
};

function checkMoves(sent: string[]): void {
  const txs = sent.map(decode);
  assert.equal(txs.length, 2, `two moves sent (U_3's on the token, U_7's out of intents.near), got ${txs.length}`);
  const [a, b] = txs as [Tx, Tx];
  // U_3: its own ft_transfer on the token to the typed account, one base unit kept
  assert.deepEqual([a.signer, a.pk, a.receiver, a.verified, a.nonce], [U3, U3, TOKEN, true, 6n]);
  assert.deepEqual(a.calls.map((c) => [c.method, c.args, c.deposit]), [["ft_transfer", { receiver_id: TYPED, amount: "2499999" }, 1n]]);
  // U_7: its own ft_withdraw on intents.near to the typed account, one base unit kept
  assert.deepEqual([b.signer, b.pk, b.receiver, b.verified, b.nonce], [U7, U7, "intents.near", true, 6n]);
  assert.deepEqual(b.calls.map((c) => [c.method, c.args, c.deposit]), [["ft_withdraw", { token: TOKEN, receiver_id: TYPED, amount: "3999999" }, 1n]]);
  // nothing names the vault
  for (const t of txs) assert.ok(t.receiver !== VAULT && !JSON.stringify(t.calls.map((c) => c.args)).includes(VAULT));
}

test("no note open, U_3 holds USDC on the token and U_7 inside intents.near: the exit sends both to the typed account, each by that U's own key", async () => {
  const { r, sent, said } = await run({});
  const out = await r;
  checkMoves(sent);
  assert.deepEqual([out.sent, out.left], ["6499998", "0"], `sent ${out.sent}, left ${out.left} (said: ${said.join(" | ")})`);
  for (const t of sent.map(decode)) assert.ok(said.some((l) => new RegExp(`^move tx [1-9A-HJ-NP-Za-km-z]+ from ${t.signer}$`).test(l)), `each move said with its U (said: ${said.join(" | ")})`);
});

test("one deposit id the walk cannot read (U_11, one RPC failing on it): the money ids still move, and the run ends stopped naming U_11", async () => {
  const { r, sent } = await run({ failOn: { rpc: 1, id: U11 } });
  await assert.rejects(r, (e: Error) => {
    assert.match(e.message, new RegExp(`deposit id U_11 ${U11} is unread`));
    assert.match(e.message, /run the exit again to go on$/);
    return true;
  });
  checkMoves(sent);
});
