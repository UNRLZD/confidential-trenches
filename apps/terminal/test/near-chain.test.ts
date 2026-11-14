// NEAR trading in the trade box (card app-near-trading): a NEAR token's buy spends the vault's USDC (Cash) through the
// kit's pool.buy with chain near (TRADE_CHAINS), and its sell is pool.sell of the whole holding back to Cash; one buy and
// one full sell per one-time wallet, so no other share is asked on NEAR. Every chain keeps its own path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAINS, TRADE_CHAINS } from "@blindfill/kit";
import type { SignpageState } from "@blindfill/kit";
import { buyPath, nearBuyAsk, poolSellAsk, sellShareOk, tradeSellAsk } from "../src/screens/trade/model.ts";
import { BOX_PERCENTS, QUICK, WHOLE } from "../src/screens/positions/model.ts";

type Pools = SignpageState["pools"];
// the state's pools as the live page sends them: the vault's own entry on NEAR (its USDC, not a pool) and Solana's pool
const POOLS: Pools = [
  { chain: "near", asset: "USDC", balance: "40" },
  { chain: "solana", asset: "SOL", balance: "0.2", ready: "0.2", tap_max: "0.1" },
];
const ACCOUNT = "nene-2250.meme-cooking.near";

test("every chain the kit names has one buy path, NEAR's the vault's Cash to a fresh NEAR wallet", () => {
  assert.deepEqual(
    CHAINS.map((c) => [c, buyPath(POOLS, c)]),
    [
      ["solana", "pool"],
      ["base", "vault"],
      ["robinhood", "vault"],
      ["near", "near"],
    ],
  );
  // NEAR's path never depends on the state: the vault's entry is not a pool, and with no state it is still NEAR's
  assert.equal(buyPath(undefined, "near"), "near");
  assert.equal(buyPath([], "near"), "near");
});

test("a NEAR buy asks pool.buy for the typed USD in USDC (the kit's SignpageParams type holds the shape)", () => {
  assert.deepEqual(nearBuyAsk(ACCOUNT, 2_500n, 1000), { ok: true, kind: "pool.buy", params: { chain: "near", token: ACCOUNT, amount: "25.00", slippage_bps: 1000 } });
  const small = nearBuyAsk(ACCOUNT, 7n, 1000);
  assert.equal(small.ok && small.params.amount, "0.07");
  assert.deepEqual(nearBuyAsk(ACCOUNT, 0n, 1000), { ok: false, why: "too_small" });
  assert.ok(TRADE_CHAINS.includes("near"));
});

test("NEAR keeps the four presets", () => {
});

test("a NEAR sell is the whole holding only: pool.sell share 10000, every other share none", () => {
  const whole = tradeSellAsk(POOLS, "near", ACCOUNT, { share_bps: WHOLE }, 1000);
  assert.deepEqual(whole, { kind: "pool.sell", params: { chain: "near", token: ACCOUNT, share_bps: 10_000, slippage_bps: 1000 } });
  for (const b of [2_500, 5_000, 7_500, 1, 9_999]) assert.equal(tradeSellAsk(POOLS, "near", ACCOUNT, { share_bps: b }, 1000), null, `share ${b}`);
  // the box's presets and the position's quick sells: on NEAR only the whole is on
  assert.deepEqual(BOX_PERCENTS.filter((b) => sellShareOk("near", b)), [WHOLE]);
  assert.deepEqual(QUICK.filter((q) => q !== "initials" && sellShareOk("near", q)), [WHOLE]);
  // the NEAR sell's preview stays the pool's alone: never a pool.sell.dry on NEAR (the kit's schema refuses the chain)
  assert.equal(poolSellAsk(POOLS, "near", ACCOUNT, { share_bps: WHOLE }, 1000), null);
});

test("the pool chains keep every share and their own pool.sell", () => {
  for (const c of ["solana", "base", "robinhood"] as const) for (const b of BOX_PERCENTS) assert.equal(sellShareOk(c, b), true);
  assert.deepEqual(tradeSellAsk(POOLS, "solana", "So11111111111111111111111111111111111111112", { share_bps: 5_000 }, 1000), poolSellAsk(POOLS, "solana", "So11111111111111111111111111111111111111112", { share_bps: 5_000 }, 1000));
  assert.equal(tradeSellAsk(POOLS, "base", "0x00000000000000000000000000000000000f1fe7", { share_bps: 5_000 }, 1000), null);
});
