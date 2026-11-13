// pool-kinds.ts with `cash` (card one-balance-buys-on-every-chain, part 1): a checked Solana pool.buy above one tap's
// spend moves its shortfall from Cash before the pool's flow buys it; without `cash`, or for any other kind or chain,
// the flow alone. At 87b6244ef the page has no `cash`: the buy goes straight to the flow, which answers not_funded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolKinds, type PoolKindsDeps } from "../src/pool-kinds.ts";
import type { PoolAsk } from "../src/rules/pool.ts";
import type { CashToPoolDeps } from "../src/cash-to-pool.ts";

const SOL_TOKEN = "So11111111111111111111111111111111111111112";
const ctx = { id: "r1", sha: "00", progress: () => {} };
const BUY = { chain: "solana", token: SOL_TOKEN, amount: "0.4", slippage_bps: 100 };

async function settle(a: unknown): Promise<unknown> {
  const r = a as { after?: Promise<unknown>; answer?: () => unknown };
  if (r.after === undefined) return { ...(a as object) };
  await r.after;
  return { ...(r.answer!() as object) };
}

function page() {
  const flows: bigint[] = [];
  const paid: string[] = [];
  let pool = 100_000_000n; // one tap spends 0.1 SOL until the move lands
  const cash: CashToPoolDeps = {
    any: async () => true,
    tapMax: async () => pool,
    // the mover's need: a move on its way, which lands at once here
    need: async () => (paid.push("c".repeat(64)), (pool = 410_000_000n), "cash/solana/0"),
    wait: async () => {},
    now: () => 0,
  };
  // the flow pays only what one tap spends now, as the pool buy's pick does
  const flow = (ask: PoolAsk) => (flows.push(ask.amount), ask.amount <= pool ? { running: true as const, after: Promise.resolve(), answer: () => ({ result: { stage: "filled" as const, txs: [] } }) } : { error: "not_funded" as const });
  const deps: PoolKindsDeps = { pinned: () => true, rpcs: () => null, flow: flow as PoolKindsDeps["flow"] };
  return { flows, paid, deps, cash };
}

test("pool.buy on Solana above one tap's spend: the tap asks the mover for the shortfall, waits for it, then the flow buys the whole ask", async () => {
  const p = page();
  const k = poolKinds({ ...p.deps, cash: () => p.cash } as PoolKindsDeps);
  assert.deepEqual(await settle(k["pool.buy"](BUY, ctx)), { result: { stage: "filled", txs: [] } });
  assert.deepEqual(p.paid, ["c".repeat(64)]);
  assert.deepEqual(p.flows, [400_000_000n]);
});

test("pool.buy on Solana with no `cash`: the flow alone, as before the card", async () => {
  const p = page();
  const k = poolKinds(p.deps);
  assert.deepEqual(await settle(k["pool.buy"](BUY, ctx)), { error: "not_funded" });
  assert.deepEqual(p.paid, []);
});
