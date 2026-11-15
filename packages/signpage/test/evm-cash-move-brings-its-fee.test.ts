// Card evm-cash-move-brings-its-fee: a Base or Robinhood buy paid from Cash moves enough to land in one tap. The real
// cashFirst and cashMover run on a model of the pool: what 1Click delivers to U_X (the quote's least, 1% under the
// device's price) is deposited by the follow as the largest rung it carries with one deposit's gas, again and again
// (pool-deposit-evm.ts: "the largest rung U carries with its cost, the rest kept in U"), and each new note is proved
// at the epoch's relay fee (wallet evm.ts bind: feeCap the epoch fee). The tap is the tap's own plan (rules/pool.ts
// planEvmBuy over evmBuyPieces of the ready proofs, as runEvmPoolBuy plans it).
// Red at aa325bd01: the EVM move asked Cash for a whole rung of the ask only, so the note it brought spent the ask less
// its own relay fee, under the ask: the tap waited CASH_MOVE_WAIT_MS and was refused (not_funded); an ask that is no
// rung moved nothing and was refused at once.
//   node --test test/evm-cash-move-brings-its-fee.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostRefusal, KindContext, Running } from "../src/api.ts";
import { cashFirst, cashMover, CASH_MOVE_WAIT_MS, type CashMoverDeps, type CashToPoolDeps } from "../src/cash-to-pool.ts";
import * as evm from "../src/pool-buy-evm.ts";
import { planEvmBuy, PoolRuleRefused, type PoolAsk } from "../src/rules/pool.ts";
import { EVM_LADDER } from "../../wallet/src/pool/evm.ts";
import { chunkOf } from "../../wallet/src/pool/ladder.ts";

const ETH = 10n ** 18n;
const micro = (n: bigint) => (n * ETH) / 1_000_000n;
const COIN = `0x${"12".repeat(20)}`;
const ADDRESS = "a".repeat(64);
const PRICE = { price: "300000000000", expo: -8 }; // ETH at 3,000 USD
const GAS = micro(20n); // one deposit's worst-case gas from U_X: the pool's floor less its least rung
const FEE = micro(10n); // the epoch's relay fee each new note is proved at
type Ready = Parameters<typeof evm.evmBuyPieces>[0][number];
const proof = (noteId: string, chunk: bigint, feeCap: bigint): Ready =>
  ({ noteId, attempt: "a", poolId: "evm-pool", wallet: { chain: "evm", l: 1n, j: 0, path: "", address: "0x01" }, chunk, root: "epoch", binding: { feeCap } }) as unknown as Ready;
// the sizing the page gives cashFirst (main.ts cashDeps.short), when this build has it
const sizing = (evm as Record<string, unknown>).evmMoveShort as ((ready: readonly Ready[], amount: bigint, fee: bigint) => { short: bigint } | null) | undefined;

/** One tap of `amount` wei on `chain` from Cash over a pool holding `ready`, end to end through the real mover. */
async function tapFromCash(chain: "base" | "robinhood", amount: bigint, ready: Ready[]) {
  let clock = 1_000;
  const pool = { ready: [...ready], ux: 0n };
  const paid: bigint[] = [];
  const quotes = new Map<bigint, bigint>();
  // the follow: what lands at U_X goes in as the largest rung it carries with one deposit's gas, until none fits
  const land = (x: bigint) => {
    pool.ux += x;
    for (;;) {
      const r = pool.ux > GAS ? chunkOf(EVM_LADDER, pool.ux - GAS) : null;
      if (r === null) return;
      pool.ux -= r + GAS;
      pool.ready.push(proof(`moved#${pool.ready.length}`, r, FEE));
    }
  };
  const md: CashMoverDeps = {
    price: () => PRICE,
    floor: async () => EVM_LADDER.min + GAS,
    rails: ["1click"],
    // 1Click's least: the USDC at the device's price, 1% under it (its slippage)
    quote: async (_c, usdc) => {
      const minOut = (((usdc * ETH * 100_000_000n) / (300_000_000_000n * 1_000_000n)) * 9_900n) / 10_000n;
      quotes.set(usdc, minOut);
      return { address: ADDRESS, amountIn: usdc, minOut };
    },
    fee: async () => 50_000n,
    cash: async () => 1_000_000_000n,
    handoff: async (w) => (paid.push(w.amount), land(quotes.get(w.amount)!), { kind: "arrived" as const, tx: "t" }) as never,
    landed: async () => false,
    now: () => clock,
  };
  const m = cashMover(md);
  const deps: CashToPoolDeps = {
    any: async () => true,
    // state.pools' tap_max on an EVM chain: each ready note's spend, its chunk less its relay fee (evmTapSpendOf)
    tapMax: async () => pool.ready.reduce((s, p) => s + (p.chunk - p.binding.feeCap), 0n),
    ...(sizing ? { short: async (_c: unknown, _t: unknown, a: bigint) => sizing(pool.ready, a, FEE)?.short ?? null } : {}),
    need: (c, s) => m.need(c, s),
    wait: async (ms) => void (clock += ms),
    now: () => clock,
  };
  let reached: number | null = null;
  // the tap's own plan over the ready proofs, as runEvmPoolBuy plans it: refused not_funded, or the amount it buys
  const inner = (a: PoolAsk, _c: KindContext | null): HostRefusal | Running<"pool.buy"> => {
    reached = clock;
    const { pieces, bound } = evm.evmBuyPieces(pool.ready);
    let answer: unknown;
    try {
      const plan = planEvmBuy(a, pieces, bound);
      answer = { result: { stage: "filled", txs: [], bought: String(plan.amount) } };
    } catch (e) {
      if (!(e instanceof PoolRuleRefused)) throw e;
      answer = { error: "not_funded" };
    }
    return { running: true, after: Promise.resolve(), answer: () => answer as never };
  };
  const routes: unknown[] = [];
  const ctx: KindContext = { id: "r1", sha: "00", progress: () => {}, route: (r) => void routes.push(r) };
  const r = cashFirst(inner, () => deps)({ kind: "pool.buy", chain, token: COIN, amount, slippageBps: 100, decimals: 6 }, ctx);
  assert.ok("running" in r);
  await r.after;
  await m.idle();
  return { answer: { ...(r.answer() as object) }, waited: reached === null ? null : reached - 1_000, paid, routes };
}

for (const [name, chain, amount, ready] of [
  ["Base, an empty pool, an ask of one whole rung (0.005 ETH)", "base", micro(5_000n), []],
  ["Base, an empty pool, an ask that is no rung (0.0037 ETH)", "base", micro(3_700n), []],
  ["Robinhood, one ready note too small (0.002 ETH), an ask that is no rung (0.0123 ETH)", "robinhood", micro(12_300n), [proof("n1", micro(2_000n), FEE)]],
  ["Robinhood, an empty pool, an ask of one whole rung (0.01 ETH)", "robinhood", micro(10_000n), []],
] as const) {
  test(`a buy from Cash lands in one tap: ${name}`, async () => {
    const t = await tapFromCash(chain, amount, [...ready]);
    assert.deepEqual(t.answer, { result: { stage: "filled", txs: [], bought: String(amount) } }, `the whole ask bought, never refused or less (Cash moved ${t.paid.length} time(s), the tap waited ${t.waited} ms)`);
    assert.equal(t.paid.length, 1, "Cash moved once");
    assert.ok(t.waited !== null && t.waited < CASH_MOVE_WAIT_MS, `the tap went on once the move landed, not at its bound (waited ${t.waited} ms)`);
    assert.deepEqual(t.routes, [{ move: "cash", op: `cash/${chain}/1000` }]);
  });
}
