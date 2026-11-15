// The tap's wait for a move from Cash (cash-to-pool.ts cashFirst; card buy-shows-every-step) is never ended by one read
// of what a tap spends: a read that throws (the dry refused down or quote_check_failed on a slow RPC) failed the buy at
// once with its money already moved, and one that never answered held the tap past CASH_MOVE_WAIT_MS with the pool buy
// never run (red at 23eab91ab: the first answers failed with no pool buy, the second never settles). Now each read is
// bounded by the wait's time left and a bad one counts as nothing yet; the pool buy runs when the money is there, or at
// the wait's end with its own answer. No import of the trace here, so the same file runs at the base.
//   node --test test/tap-wait-bad-read.test.ts      (from packages/signpage)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolAsk } from "../src/rules/pool.ts";
import type { HostRefusal, KindContext, Running } from "../src/api.ts";
import { cashFirst, CASH_MOVE_WAIT_MS, type CashToPoolDeps } from "../src/cash-to-pool.ts";

const BOUND = { timeout: 3_000 };
const ask = (amount: bigint): PoolAsk => ({ kind: "pool.buy", chain: "solana", token: "So11111111111111111111111111111111111111112", amount, slippageBps: 100, decimals: 6 });
const ctx = (): KindContext => ({ id: "buy-1", sha: "00", progress: () => {}, route: () => {} });
const inner = (calls: bigint[]) => (a: PoolAsk): HostRefusal | Running<"pool.buy"> => {
  calls.push(a.amount);
  return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "filled", txs: [] } }) };
};
const answerOf = async (r: HostRefusal | Running<"pool.buy">): Promise<unknown> => {
  if (!("running" in r)) return { ...r };
  await r.after;
  return { ...(r.answer() as object) };
};

test("a read that throws mid-wait is nothing yet: the pool buy runs once the money is there", BOUND, async () => {
  const calls: bigint[] = [];
  let k = 0, clock = 0;
  const reads = [0n, "down", "down", 400_000_000n] as const;
  const d: CashToPoolDeps = {
    any: async () => true,
    tapMax: async () => {
      const v = reads[Math.min(k++, reads.length - 1)]!;
      if (v === "down") throw new Error("down");
      return v;
    },
    need: async () => "cash/solana/7",
    wait: async (ms) => void (clock += ms),
    now: () => clock,
  };
  const a = await answerOf(cashFirst(inner(calls), () => d)(ask(400_000_000n), ctx()));
  assert.deepEqual(calls, [400_000_000n], "the pool buy ran for the whole ask");
  assert.deepEqual(a, { result: { stage: "filled", txs: [] } });
});

test("a read that never answers holds the tap no longer than CASH_MOVE_WAIT_MS: the pool buy then runs", BOUND, async () => {
  const calls: bigint[] = [];
  let clock = 0;
  const d: CashToPoolDeps = {
    any: async () => true,
    tapMax: async () => (clock === 0 ? 100_000_000n : new Promise<bigint>(() => {})),
    need: async () => "cash/solana/7",
    // the first wait goes to the wait's last 5 ms
    wait: async (ms) => void (clock += clock === 0 ? CASH_MOVE_WAIT_MS - 5 : ms),
    now: () => clock,
  };
  await answerOf(cashFirst(inner(calls), () => d)(ask(400_000_000n), ctx()));
  assert.deepEqual(calls, [400_000_000n]);
});
