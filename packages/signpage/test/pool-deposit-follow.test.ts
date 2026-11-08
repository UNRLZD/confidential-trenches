// The pool deposit quote's follow (card pool-deposit-follow; src/pool-deposit-follow.ts): money 1Click delivers to U_X
// goes on into X's pool with no tap, on the device's own two-RPC reads only. A status from the helper moves only the
// stage shown; a forged SUCCESS with nothing under U_X on both RPCs deposits nothing.
//   node --test test/pool-deposit-follow.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

const { askOf, followPoolQuote, POOL_FOLLOW_FAST_MS } = await import("../src/pool-deposit-follow.ts");
const { SOL_LADDER } = await import("../../wallet/src/pool/solana.ts");
const { ladderSplit } = await import("../../wallet/src/pool/ladder.ts");
type Deps = Parameters<typeof followPoolQuote>[1];
type Rec = Parameters<typeof followPoolQuote>[0];
type End = Awaited<ReturnType<Deps["deposit"]>>;

const F: Rec = { chain: "solana", s: "777", i: 3, u: "U_X", refund_id: "ab".repeat(32), address: "DEPOSIT", deadline_ms: 1, origin: "nep141:base-usdc", min_out: "20000000" };
// today's rent (5,080 lamports a byte): one deposit's worst case 2,936,160 and the 650,240 U_X keeps
const PER = 2_936_160n, KEEP = 650_240n, FLOOR = SOL_LADDER.min + PER + KEEP;

type Round = { bal: readonly [bigint, bigint]; status?: string | null; end?: End; past?: boolean };
function world(rounds: Round[], o: { refund?: Deps["refund"] } = {}) {
  const stages: string[] = [];
  const deposits: bigint[] = [];
  const sleeps: number[] = [];
  const ac = new AbortController();
  let k = 0;
  const now = () => rounds[Math.min(k, rounds.length - 1)]!;
  const deps: Deps = {
    status: async () => {
      const s = now().status;
      return s === undefined || s === null ? null : { status: s as never, delivered: null };
    },
    balances: async () => now().bal,
    costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }),
    ladder: SOL_LADDER,
    deposit: async (_f, amount) => {
      deposits.push(amount);
      return now().end ?? "filled";
    },
    past: async () => now().past === true,
    stage: async (s) => void stages.push(s),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (++k >= rounds.length + 3) ac.abort();
    },
    signal: ac.signal,
    ...(o.refund ? { refund: o.refund } : {}),
  };
  return { deps, stages, deposits, sleeps };
}

test("askOf: the largest ask U_X pays with each rung's worst-case cost and the rent kept; none under the floor", () => {
  assert.equal(askOf(SOL_LADDER, FLOOR, PER, KEEP), 10_000_000n);
  assert.equal(askOf(SOL_LADDER, FLOOR - 1n, PER, KEEP), 0n);
  // 0.2 SOL: rungs of the ladder that, with a cost each and the rent kept, fit under what U_X holds
  const have = 200_000_000n;
  const ask = askOf(SOL_LADDER, have, PER, KEEP);
  const { notes } = ladderSplit(SOL_LADDER, ask);
  assert.ok(ask + BigInt(notes.length) * PER + KEEP <= have, `${ask} with ${notes.length} rungs`);
  assert.ok(ask >= 180_000_000n, String(ask));
});

test("SUCCESS and U_X's balance on both RPCs: pool.deposit runs from U_X, in_pool, followed on to the deadline", async () => {
  const w = world([
    { bal: [0n, 0n], status: "PROCESSING" },
    { bal: [20_000_000n, 20_000_000n], status: "SUCCESS" },
    { bal: [6_000_000n, 6_000_000n], status: "SUCCESS" },
    { bal: [6_000_000n, 6_000_000n], status: "SUCCESS", past: true },
  ]);
  assert.equal(await followPoolQuote(F, w.deps), "in_pool");
  assert.deepEqual(w.deposits, [10_000_000n]);
  assert.deepEqual(w.stages, ["in_transit", "in_pool"]);
});

test("a forged SUCCESS with U_X short on one RPC deposits nothing: the lower of the two reads counts", async () => {
  const w = world([
    { bal: [20_000_000n, 0n], status: "SUCCESS" },
    { bal: [0n, 20_000_000n], status: "SUCCESS" },
    { bal: [FLOOR - 1n, FLOOR - 1n], status: "SUCCESS" },
  ]);
  assert.equal(await followPoolQuote(F, w.deps), "in_transit");
  assert.deepEqual(w.deposits, []);
});

test("the chain first: money under U_X with the helper down (no status) still goes into the pool", async () => {
  const w = world([
    { bal: [FLOOR, FLOOR + 5n], status: null },
    { bal: [0n, 0n], status: null, past: true },
  ]);
  assert.equal(await followPoolQuote(F, w.deps), "in_pool");
  assert.deepEqual(w.deposits, [10_000_000n]);
});

test("a deposit that ends not_landed or refused is no end: read again at the slow pace, then carried", async () => {
  for (const end of ["not_landed", "not_funded", "down", "sent"] as const) {
    const w = world([
      { bal: [FLOOR, FLOOR], status: "SUCCESS", end },
      { bal: [FLOOR, FLOOR], status: "SUCCESS", end: "filled" },
      { bal: [0n, 0n], status: "SUCCESS", past: true },
    ]);
    assert.equal(await followPoolQuote(F, w.deps), "in_pool", end);
    assert.deepEqual(w.deposits, [10_000_000n, 10_000_000n], end);
    assert.ok(w.sleeps[0]! > POOL_FOLLOW_FAST_MS, `${end}: no tight loop after a deposit that did not land`);
  }
});

test("a late second send to U_X after in_pool, before the deadline, is carried too", async () => {
  const w = world([
    { bal: [FLOOR, FLOOR], status: "SUCCESS" },
    { bal: [0n, 0n], status: "SUCCESS" },
    { bal: [FLOOR * 2n, FLOOR * 2n], status: "SUCCESS" },
    { bal: [0n, 0n], status: "SUCCESS", past: true },
  ]);
  assert.equal(await followPoolQuote(F, w.deps), "in_pool");
  assert.equal(w.deposits.length, 2);
});

test("a stale status never steps the stage back; no status and the deadline past shows expired", async () => {
  const w = world([
    { bal: [0n, 0n], status: "PROCESSING" },
    { bal: [0n, 0n], status: "PENDING_DEPOSIT" },
  ]);
  assert.equal(await followPoolQuote(F, w.deps), "in_transit");
  assert.deepEqual(w.stages, ["in_transit"]);
  const e = world([{ bal: [0n, 0n], status: null, past: true }]);
  assert.equal(await followPoolQuote(F, e.deps), "expired");
});

test("REFUNDED: refunded shown, and with no refund carry the follow never ends as if done", async () => {
  const w = world([{ bal: [0n, 0n], status: "REFUNDED", past: true }]);
  assert.equal(await followPoolQuote(F, w.deps), "refunded");
  assert.deepEqual(w.deposits, []);
  assert.ok(w.sleeps.length >= 3, "read on round after round until the signal stops it, never ended at refunded");
  // with a carry: the move is asked, shown, and what reaches U_X after it goes into the pool
  let asked = 0;
  const c = world(
    [
      { bal: [0n, 0n], status: "REFUNDED" },
      { bal: [0n, 0n], status: "REFUNDED" },
      { bal: [FLOOR, FLOOR], status: "REFUNDED" },
      { bal: [0n, 0n], status: "REFUNDED", past: true },
    ],
    { refund: async () => (++asked === 1 ? "moved" : "wait") },
  );
  assert.equal(await followPoolQuote(F, c.deps), "in_pool");
  assert.deepEqual(c.stages, ["refunded", "refund_move", "in_pool"]);
  assert.deepEqual(c.deposits, [10_000_000n]);
});
