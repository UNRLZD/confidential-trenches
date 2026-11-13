// cash-to-pool.ts (card one-balance-buys-on-every-chain, part 1): a Solana buy larger than what the pool's ready proofs
// pay moves the shortfall from Cash into the pool inside the same tap (the vault pays 1Click's deposit address for a
// quote into the pool's U_X, which the follow carries into the pool), waits until one tap can spend the ask, then buys.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolAsk } from "../src/rules/pool.ts";
import type { HostRefusal, KindContext, Running } from "../src/api.ts";
import { cashFirst, CASH_MOVE_POLL_MS, type CashQuote, type CashToPoolDeps } from "../src/cash-to-pool.ts";

const TOKEN = "So11111111111111111111111111111111111111112";
const ask = (amount: bigint): PoolAsk => ({ kind: "pool.buy", chain: "solana", token: TOKEN, amount, slippageBps: 100, decimals: 6 });
const ctx = (): KindContext & { stages: string[]; routes: unknown[] } => {
  const stages: string[] = [], routes: unknown[] = [];
  return { id: "r1", sha: "00", stages, routes, progress: (s) => void stages.push(String(s)), route: (r) => void routes.push(r) };
};
const ADDRESS = "a".repeat(64);
const quoteOf = (over: Partial<CashQuote> = {}): CashQuote => ({ address: ADDRESS, amountIn: 21_000_000n, minOut: 300_000_000n, deadlineMs: 10_000_000, ...over });

type Calls = { inner: bigint[]; quoted: bigint[]; paid: { recipient: string; amount: bigint; fee: bigint }[] };
function deps(o: { taps: bigint[]; cash?: bigint; quote?: CashQuote | { error: string }; end?: string; fee?: bigint }, calls: Calls): CashToPoolDeps {
  let t = 0;
  let clock = 0;
  return {
    tapMax: async () => o.taps[Math.min(t++, o.taps.length - 1)]!,
    cash: async () => o.cash ?? 100_000_000n,
    quote: async (short) => (calls.quoted.push(short), o.quote ?? quoteOf()),
    fee: async () => o.fee ?? 50_000n,
    handoff: async (w, fee) => (calls.paid.push({ recipient: w.recipient, amount: w.amount, fee }), { kind: (o.end ?? "arrived") as "arrived" }),
    wait: async (ms) => void (clock += ms),
    now: () => clock,
  };
}
const innerOf = (calls: Calls) => (a: PoolAsk, _c: KindContext | null): HostRefusal | Running<"pool.buy"> => {
  calls.inner.push(a.amount);
  return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "filled", txs: [] } }) };
};
const run = async (r: HostRefusal | Running<"pool.buy">) => ("running" in r ? (await r.after, r.answer()) : r);
const fresh = (): Calls => ({ inner: [], quoted: [], paid: [] });

test("cashFirst: a buy the pool's ready proofs pay goes straight to the pool buy, no quote and no withdrawal", async () => {
  const calls = fresh();
  const a = await run(cashFirst(innerOf(calls), () => deps({ taps: [500_000_000n] }, calls))(ask(400_000_000n), ctx()));
  assert.deepEqual(a, { result: { stage: "filled", txs: [] } });
  assert.deepEqual(calls.inner, [400_000_000n]);
  assert.deepEqual(calls.quoted, []);
  assert.deepEqual(calls.paid, []);
});

test("cashFirst: a buy above what one tap spends moves the shortfall from Cash to the quote's deposit address, waits until a tap spends the ask, then buys it whole", async () => {
  const calls = fresh();
  // the pool pays 0.1 SOL now; after the move lands, one tap pays 0.4 SOL
  const c = ctx();
  const a = await run(cashFirst(innerOf(calls), () => deps({ taps: [100_000_000n, 100_000_000n, 100_000_000n, 400_000_000n] }, calls))(ask(400_000_000n), c));
  assert.deepEqual(a, { result: { stage: "filled", txs: [] } });
  assert.deepEqual(calls.quoted, [300_000_000n], "the quote is asked for the shortfall in lamports");
  assert.deepEqual(calls.paid, [{ recipient: ADDRESS, amount: 21_000_000n, fee: 50_000n }], "Cash pays the quote's amount in to its deposit address");
  assert.deepEqual(calls.inner, [400_000_000n], "then the pool buy runs once, for the whole ask");
  assert.deepEqual(c.routes[0], { move: "cash" }, "the app is told the move runs, before the buy's own route");
});

test("cashFirst: a quote whose min out is under the shortfall is refused before anything is withdrawn", async () => {
  const calls = fresh();
  const a = await run(cashFirst(innerOf(calls), () => deps({ taps: [100_000_000n], quote: quoteOf({ minOut: 299_999_999n }) }, calls))(ask(400_000_000n), ctx()));
  assert.deepEqual(a, { error: "quote_check_failed" });
  assert.deepEqual(calls.paid, []);
  assert.deepEqual(calls.inner, []);
});

test("cashFirst: Cash that cannot pay the quote and its fee is not_funded, nothing withdrawn", async () => {
  const calls = fresh();
  const a = await run(cashFirst(innerOf(calls), () => deps({ taps: [100_000_000n], cash: 21_049_999n }, calls))(ask(400_000_000n), ctx()));
  assert.deepEqual(a, { error: "not_funded" });
  assert.deepEqual(calls.paid, []);
});

test("cashFirst: the quote's refusal is the answer, nothing withdrawn", async () => {
  const calls = fresh();
  const a = await run(cashFirst(innerOf(calls), () => deps({ taps: [100_000_000n], quote: { error: "above_max" } }, calls))(ask(400_000_000n), ctx()));
  assert.deepEqual(a, { error: "above_max" });
  assert.deepEqual(calls.paid, []);
});

test("cashFirst: a withdrawal that did not pay the deposit address ends the tap with no buy", async () => {
  for (const end of ["expired", "refunded", "elsewhere", "unmatched", "fee"]) {
    const calls = fresh();
    const a = await run(cashFirst(innerOf(calls), () => deps({ taps: [100_000_000n], end }, calls))(ask(400_000_000n), ctx()));
    assert.deepEqual(a, { error: "failed" }, end);
    assert.deepEqual(calls.inner, [], end);
  }
});

test("cashFirst: money that never reaches a tap by the quote's deadline ends the tap not_funded, never a smaller buy", async () => {
  const calls = fresh();
  const a = await run(cashFirst(innerOf(calls), () => deps({ taps: [100_000_000n], quote: quoteOf({ deadlineMs: 5 * CASH_MOVE_POLL_MS }) }, calls))(ask(400_000_000n), ctx()));
  assert.deepEqual(a, { error: "not_funded" });
  assert.deepEqual(calls.inner, []);
});

test("cashFirst: a sell, an EVM buy or a NEAR buy is the inner kind's alone", async () => {
  const calls = fresh();
  const evm: PoolAsk = { ...ask(1n), chain: "base" };
  await run(cashFirst(innerOf(calls), () => deps({ taps: [0n] }, calls))(evm, ctx()));
  assert.deepEqual(calls.inner, [1n]);
  assert.deepEqual(calls.quoted, []);
});
