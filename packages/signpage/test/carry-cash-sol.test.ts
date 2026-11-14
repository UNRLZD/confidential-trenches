// node --test packages/signpage/test/carry-cash-sol.test.ts (card leftovers-carry-to-cash): a Solana wallet's leftover
// goes whole to Cash's deposit address in one checked System transfer, recorded before it leaves, read on both RPCs
// after; never sent twice. Keys from the published all-zero vector (packages/wallet/test/vectors/a8.json) only; the RPCs
// are fakes. Red at 4fecb0326: no carry-cash-sol.ts and no checkSolanaCashCarry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { depositId, freshWallet } from "../../wallet/src/derive/keys.ts";
import { solanaDecodeMessage } from "../../kit/src/checks/solana/message.ts";
import { solCashCarrySender } from "../src/carry-cash-sol.ts";
import { checkSolanaCashCarry, PoolRuleRefused } from "../src/rules/pool.ts";
import type { CarryOpen, CarrySource } from "../src/carry-cash.ts";

const SEED = () => wordsToSeed64(entropyToWords(new Uint8Array(16)));
const W = freshWallet(SEED(), "sol", 3n, 1);
W.secretKey.fill(0);
const SRC: CarrySource = { chain: "solana", kind: "w", address: W.address, l: "3", j: 1 };
const TO = base58.encode(new Uint8Array(32).fill(9));
const BH = base58.encode(new Uint8Array(32).fill(7));

function rpc(o: { lamports?: [bigint, bigint]; statuses?: [unknown, unknown]; heights?: [number, number]; simErr?: unknown } = {}) {
  const sent: string[] = [];
  const calls: string[] = [];
  const make = (n: 0 | 1) => async (method: string, params: readonly unknown[]): Promise<unknown> => {
    calls.push(method);
    if (method === "getBalance") return { value: Number((o.lamports ?? [2_005_000n, 2_005_000n])[n]) };
    if (method === "getLatestBlockhash") return { value: { blockhash: BH, lastValidBlockHeight: 900 } };
    if (method === "getFeeForMessage") return { value: 5000 };
    if (method === "simulateTransaction") return { value: { err: o.simErr ?? null } };
    if (method === "sendTransaction") return void sent.push(params[0] as string);
    if (method === "getSignatureStatuses") return { value: [(o.statuses ?? [null, null])[n]] };
    if (method === "getBlockHeight") return (o.heights ?? [10, 10])[n];
    throw new Error(method);
  };
  return { rpcs: [make(0), make(1)] as const, sent, calls };
}
const OPEN: CarryOpen = { to: TO, amount: "2000000", quote: "carry/solana/ab", quotedMs: "1", sends: [] };

test("a W's whole balance less the one fee goes to the deposit address: checked, recorded before it leaves, signed by W alone", async () => {
  const r = rpc();
  const kept: CarryOpen[] = [];
  const s = solCashCarrySender({ rpcs: r.rpcs, seed64: async () => SEED(), now: () => 5 });
  assert.equal(await s.sendable(SRC), 2_000_000n);
  assert.equal(await s.send(SRC, OPEN, async (o) => void kept.push(o)), "pending");
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.sends[0]!.lastValid, "900");
  assert.equal(r.sent.length, 2, "both RPCs");
  const wire = base64.decode(r.sent[0]!);
  const msg = wire.subarray(65);
  assert.ok(ed25519.verify(wire.subarray(1, 65), msg, base58.decode(W.address)), "W's signature");
  assert.equal(kept[0]!.sends[0]!.hash, base58.encode(wire.subarray(1, 65)));
  const m = solanaDecodeMessage(msg);
  assert.equal(m.instructions.length, 1);
  assert.deepEqual([...m.instructions[0]!.data], [2, 0, 0, 0, ...[0x80, 0x84, 0x1e, 0, 0, 0, 0, 0]]);
  // record before send: the record's write came before any sendTransaction
  assert.ok(r.calls.indexOf("sendTransaction") > r.calls.indexOf("simulateTransaction"));
});

test("a U_X (U_{s,i}) signs its own: its address is the base58 of its key", async () => {
  const k = depositId(SEED(), 7n, 2);
  k.secretKey.fill(0);
  const u: CarrySource = { chain: "solana", kind: "ux", address: base58.encode(k.publicKey), s: "7", i: 2 };
  const r = rpc();
  assert.equal(await solCashCarrySender({ rpcs: r.rpcs, seed64: async () => SEED() }).send(u, OPEN, async () => {}), "pending");
  assert.ok(ed25519.verify(base64.decode(r.sent[0]!).subarray(1, 65), base64.decode(r.sent[0]!).subarray(65), k.publicKey));
});

test("not whole, lamports that differ, a failed simulation, or a record that cannot be written: nothing is sent", async () => {
  for (const [o, want] of [[{ lamports: [2_006_000n, 2_006_000n] as [bigint, bigint] }, "short"], [{ lamports: [2_005_000n, 2_004_000n] as [bigint, bigint] }, "fault"], [{ simErr: { InstructionError: [0, "x"] } }, "fault"]] as const) {
    const r = rpc(o);
    assert.equal(await solCashCarrySender({ rpcs: r.rpcs, seed64: async () => SEED() }).send(SRC, OPEN, async () => {}), want);
    assert.equal(r.sent.length, 0);
  }
  const r = rpc();
  assert.equal(await solCashCarrySender({ rpcs: r.rpcs, seed64: async () => SEED() }).send(SRC, OPEN, async () => {
    throw new Error("store");
  }), "fault");
  assert.equal(r.sent.length, 0);
  assert.equal(await solCashCarrySender({ rpcs: rpc({ lamports: [1n, 2n] }).rpcs, seed64: async () => SEED() }).sendable(SRC), null);
});

test("a reload reads its recorded send first and never sends again: landed once both read it finalized, dead once both are past its last valid height unknown, else pending", async () => {
  const open: CarryOpen = { ...OPEN, sends: [{ hash: "Sig1", value: "2000000", sentMs: "1", lastValid: "900" }] };
  const fin = { err: null, confirmationStatus: "finalized" };
  for (const [o, want] of [[{ statuses: [fin, fin] }, "landed"], [{ statuses: [fin, null] }, "pending"], [{ heights: [901, 901] }, "dead"], [{ heights: [901, 899] }, "pending"]] as const) {
    const r = rpc(o as never);
    assert.equal(await solCashCarrySender({ rpcs: r.rpcs, seed64: async () => SEED() }).send(SRC, open, async () => {}), want, JSON.stringify(o));
    assert.equal(r.sent.length, 0);
  }
});

test("the rule: only one transfer of exactly the amount, whole, from the wallet to the deposit address, on the device's blockhash", async () => {
  const r = rpc();
  await solCashCarrySender({ rpcs: r.rpcs, seed64: async () => SEED() }).send(SRC, OPEN, async () => {});
  const signed = base64.decode(r.sent[0]!);
  const wire = signed.slice();
  wire.fill(0, 1, 65);
  const ctx = { wallet: W.address, to: TO, amount: 2_000_000n, lamports: 2_005_000n, blockhash: BH };
  checkSolanaCashCarry(wire.slice(), ctx);
  for (const [bad, rule] of [
    [{ to: base58.encode(new Uint8Array(32).fill(8)) }, "transfer_accounts"],
    [{ amount: 1_999_999n }, "amount"],
    [{ lamports: 2_006_000n }, "carry_whole"],
    [{ wallet: TO }, "carry_ctx"],
    [{ blockhash: base58.encode(new Uint8Array(32).fill(6)) }, "blockhash"],
  ] as const) assert.throws(() => checkSolanaCashCarry(wire.slice(), { ...ctx, ...bad }), (e: unknown) => e instanceof PoolRuleRefused && e.rule === rule, rule);
});
