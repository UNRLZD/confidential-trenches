// Card solana-buy-never-moves-cash-for-a-coin-it-cannot-buy: a Solana coin the private buy has no venue for (no pump.fun
// curve, no PumpSwap pool: the owner's NEARKAT, 14 Nov 20:33Z) never moves money from Cash. Its pool.buy.dry refuses
// (src/pools.ts poolBuyDryKind: quote_check_failed when the venue read throws), so the tap's read of what one tap spends
// throws (solanaTapMaxOf) and cashFirst asks no move, waits for none, and answers the pool buy's own refusal at once.
// A pump.fun or PumpSwap coin is as before: its tap_max, or 0n for a pool with nothing ready, and the shortfall moves.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostRefusal, KindContext, Running } from "../src/api.ts";
import { cashFirst, solanaTapMaxOf, type CashToPoolDeps } from "../src/cash-to-pool.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const ask: PoolAsk = { kind: "pool.buy", chain: "solana", token: "NoVenueMint", amount: 400_000_000n, slippageBps: 100, decimals: 6 };
const ctx = (): KindContext & { routes: unknown[] } => {
  const routes: unknown[] = [];
  return { id: "r1", sha: "00", routes, progress: () => {}, route: (r) => void routes.push(r) };
};
const dry = (a: { result: { tap_max: string } } | { error: "quote_check_failed" | "down" | "not_funded" }): Running<"pool.buy.dry"> => ({ running: true, after: Promise.resolve(), answer: () => a as never });
const run = async (r: HostRefusal | Running<"pool.buy">): Promise<unknown> => {
  if (!("running" in r)) return { ...r };
  await r.after;
  return { ...(r.answer() as object) };
};

function tap(answer: Parameters<typeof dry>[0]) {
  const seen = { needs: 0, waited: 0, inner: [] as bigint[] };
  const d: CashToPoolDeps = {
    any: async () => true,
    tapMax: async () => solanaTapMaxOf(dry(answer)),
    need: async () => (seen.needs++, "cash/solana/7"),
    moved: async () => ({ landed: true }),
    proving: async () => false,
    wait: async (ms) => void (seen.waited += ms),
    now: () => seen.waited,
  };
  // the pool buy: a coin with no venue is refused quote_check_failed (src/pool-buy.ts, before any note is claimed)
  const inner = (a: PoolAsk, _c: KindContext | null): Running<"pool.buy"> => {
    seen.inner.push(a.amount);
    return { running: true, after: Promise.resolve(), answer: () => ({ error: "quote_check_failed" }) };
  };
  return { seen, buy: cashFirst(inner, () => d) };
}

test("a coin whose venue read throws moves nothing from Cash: no move asked, no wait, the pool buy's refusal at once", async () => {
  for (const code of ["quote_check_failed", "down"] as const) {
    const { seen, buy } = tap({ error: code });
    const c = ctx();
    const a = await run(buy(ask, c));
    assert.deepEqual(a, { error: "quote_check_failed" }, code);
    assert.equal(seen.needs, 0, `${code}: no move from Cash`);
    assert.equal(seen.waited, 0, `${code}: no wait`);
    assert.deepEqual(c.routes, [], `${code}: no "Moving from Cash"`);
    assert.deepEqual(seen.inner, [400_000_000n], `${code}: the pool buy answers`);
  }
});

test("a pump.fun or PumpSwap coin is as before: its tap_max in lamports, 0n with nothing ready, and its shortfall moves", async () => {
  assert.equal(await solanaTapMaxOf(dry({ result: { tap_max: "0.1" } })), 100_000_000n);
  assert.equal(await solanaTapMaxOf(dry({ error: "not_funded" })), 0n);
  assert.equal(await solanaTapMaxOf(dry({ result: { tap_max: "x" } })), 0n);
  const { seen, buy } = tap({ result: { tap_max: "0.1" } });
  const c = ctx();
  await run(buy(ask, c));
  assert.equal(seen.needs, 1);
  assert.deepEqual(c.routes, [{ move: "cash", op: "cash/solana/7" }]);
});
