// cash-to-pool.ts (card one-balance-buys-on-every-chain, part 1): a Solana buy larger than what the pool's ready proofs
// pay moves the shortfall from Cash into the pool inside the same tap (the vault pays 1Click's deposit address for a
// quote into the pool's U_X, which the follow carries into the pool), waits until one tap can spend the ask, then buys.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolAsk } from "../src/rules/pool.ts";
import type { HostRefusal, KindContext, Running } from "../src/api.ts";
import { cashFirst, cashLamportsFor, cashUsdcFor, CASH_MOVE_POLL_MS, CASH_MOVE_WAIT_MS, type CashQuote, type CashRail, type CashToPoolDeps } from "../src/cash-to-pool.ts";

const TOKEN = "So11111111111111111111111111111111111111112";
const ask = (amount: bigint): PoolAsk => ({ kind: "pool.buy", chain: "solana", token: TOKEN, amount, slippageBps: 100, decimals: 6 });
const ctx = (): KindContext & { stages: string[]; routes: unknown[] } => {
  const stages: string[] = [], routes: unknown[] = [];
  return { id: "r1", sha: "00", stages, routes, progress: (s) => void stages.push(String(s)), route: (r) => void routes.push(r) };
};
const ADDRESS = "a".repeat(64);
const quoteOf = (over: Partial<CashQuote> = {}): CashQuote => ({ address: ADDRESS, amountIn: 21_000_000n, minOut: 300_000_000n, deadlineMs: 10_000_000, ...over });

type Calls = { inner: bigint[]; quoted: bigint[]; ids?: string[]; paid: { recipient: string; amount: bigint; fee: bigint }[] };
function deps(o: { taps: bigint[]; cash?: bigint; quote?: CashQuote | { error: string }; end?: string; fee?: bigint; rails?: CashRail[]; byRail?: Partial<Record<CashRail, CashQuote | { error: string }>> }, calls: Calls & { rails?: string[] }): CashToPoolDeps {
  let t = 0;
  let clock = 0;
  return {
    tapMax: async () => o.taps[Math.min(t++, o.taps.length - 1)]!,
    cash: async () => o.cash ?? 100_000_000n,
    rails: o.rails ?? ["1click"],
    quote: async (short, id, rail) => (calls.quoted.push(short), (calls.ids ??= []).push(id), (calls.rails ??= []).push(rail), o.byRail?.[rail] ?? o.quote ?? quoteOf()),
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
const run = async (r: HostRefusal | Running<"pool.buy">): Promise<unknown> => {
  if (!("running" in r)) return { ...r };
  await r.after;
  // copied plainly: a HostAnswer's optional `then` is never returned from an async function
  return { ...(r.answer() as object) };
};
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
  assert.deepEqual(calls.ids, ["r1/cash"], "the quote's follow is keyed under the tap's own id");
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

test("cashFirst: a deposit address that is not a NEAR implicit account (the vault, intents.near, a named account) is refused before anything is withdrawn", async () => {
  for (const address of ["intents.near", "vault.blindfill.near", "A".repeat(64), "a".repeat(63)]) {
    const calls = fresh();
    const a = await run(cashFirst(innerOf(calls), () => deps({ taps: [100_000_000n], quote: quoteOf({ address }) }, calls))(ask(400_000_000n), ctx()));
    assert.deepEqual(a, { error: "quote_check_failed" }, address);
    assert.deepEqual(calls.paid, [], address);
  }
});

test("cashFirst: a far quote deadline never holds the tap past CASH_MOVE_WAIT_MS", async () => {
  const calls = fresh();
  let reads = 0;
  const d = deps({ taps: [100_000_000n], quote: quoteOf({ deadlineMs: 3 * 86_400_000 }) }, calls);
  const tapMax = d.tapMax;
  d.tapMax = async (t) => (reads++, tapMax(t));
  const a = await run(cashFirst(innerOf(calls), () => d)(ask(400_000_000n), ctx()));
  assert.deepEqual(a, { error: "not_funded" });
  assert.ok(reads <= CASH_MOVE_WAIT_MS / CASH_MOVE_POLL_MS + 2, `${reads} reads`);
});

test("cashUsdcFor / cashLamportsFor: the shortfall and the least rung at the device's price, 3% over, rounded against the user never", () => {
  // SOL at 80.00000000 USD (Pyth's expo -8): 0.3 SOL short + 0.01 SOL rung = 24.8 USD, 3% over = 25.544 USD
  const p = { price: "8000000000", expo: -8 };
  assert.equal(cashUsdcFor(300_000_000n, p), 25_544_000n);
  // the inverse: what that USDC buys back, less the rung, is the shortfall (never more)
  const back = cashLamportsFor(25_544_000n, p);
  assert.ok(back <= 300_000_000n && back >= 299_999_990n, String(back));
  assert.equal(cashUsdcFor(0n, p), null);
  assert.equal(cashUsdcFor(1n, { price: "-1", expo: -8 }), null);
  assert.equal(cashLamportsFor(100n, p), 0n, "dust buys nothing past the rung");
});

test("cashFirst: the rails are asked in order, Relay first; Relay's refusal falls back to 1Click under its own id", async () => {
  const calls: Calls & { rails?: string[] } = fresh();
  const a = await run(cashFirst(innerOf(calls), () => deps({ taps: [100_000_000n, 400_000_000n], rails: ["relay", "1click"], byRail: { relay: { error: "not_available" } } }, calls))(ask(400_000_000n), ctx()));
  assert.deepEqual(a, { result: { stage: "filled", txs: [] } });
  assert.deepEqual(calls.rails, ["relay", "1click"]);
  assert.deepEqual(calls.ids, ["r1/cash", "r1/cash/1click"]);
  assert.deepEqual(calls.paid.length, 1);
});

test("cashFirst: Relay's quote, when it gives one, carries the move and 1Click is not asked", async () => {
  const calls: Calls & { rails?: string[] } = fresh();
  await run(cashFirst(innerOf(calls), () => deps({ taps: [100_000_000n, 400_000_000n], rails: ["relay", "1click"] }, calls))(ask(400_000_000n), ctx()));
  assert.deepEqual(calls.rails, ["relay"]);
});
