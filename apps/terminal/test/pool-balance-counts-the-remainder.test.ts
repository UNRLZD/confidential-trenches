// Card pool-balance-counts-the-remainder: a pool's one balance counts the money still at that chain's deposit wallets
// (the kit's state.deposit_wallets: a deposit wallet U_X with money not yet carried into its pool, a remainder or dust
// included), so nothing sent ever looks missing; once a carry lands, the money is counted on the pool's side alone. On
// Portfolio's pool rows, in Cash (the header, deposit and withdraw screens' one number) and on the deposit sheet.
//   node --test apps/terminal/test/pool-balance-counts-the-remainder.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { portfolio, type PortfolioData } from "../src/screens/portfolio/model.ts";
import { ownCoin, poolBalance } from "../src/screens/deposit/model.ts";
import { WORDS } from "../src/screens/deposit/words.ts";

const NOW = Date.parse("2026-11-13T11:00:00Z");
const PX = (usd: number) => ({ price: String(usd * 1e8), expo: -8, published_s: Math.floor(NOW / 1000) - 5, read_ms: NOW - 1000 });
const data: PortfolioData = { market: () => null, extra: () => null, closed: [], series: [], fees: null, exported: [] };
const snap = (state: SignpageState): SignpageClientSnapshot => ({ status: "ready", release: "signpage-v1", state, stale: false });

// a page answer (kit SignpageState) with a remainder at each pool's U_X: two on Solana, one each on Base and Robinhood,
// and the vault's NEAR one, which is no pool's
const BEFORE: SignpageState = {
  release: "signpage-v1",
  api: 1,
  signed_in: true,
  code_saved: true,
  vault_balance: "10",
  wallets: [],
  positions: [],
  orders: [],
  held: [],
  ops: [],
  pools: [
    { chain: "solana", asset: "SOL", balance: "1.5", ready: "1.5", tap_max: "1", price: PX(150) },
    { chain: "base", asset: "ETH", balance: "0.01", price: PX(3000) },
    { chain: "robinhood", asset: "ETH", balance: "0", price: PX(3000) },
  ],
  deposit_wallets: [
    { chain: "solana", address: "SoU1", asset: "SOL", amount: "0.0125" },
    { chain: "solana", address: "SoU2", asset: "SOL", amount: "0.000000001" },
    { chain: "base", address: "0xbase", asset: "ETH", amount: "0.002" },
    { chain: "robinhood", address: "0xhood", asset: "ETH", amount: "0.0003" },
    { chain: "near", address: "nearU", asset: "USDC", amount: "4" },
  ],
};

const rows = (s: SignpageState) => Object.fromEntries(portfolio(snap(s), data, NOW).pools.rows.map((r) => [r.chain, r.balance]));

test("a remainder at U_X shows in its pool's one balance, exact, for SOL on Solana and ETH on Base and Robinhood", () => {
  assert.deepEqual(rows(BEFORE), {
    near: 10_000_000n, // the vault's USDC alone: a NEAR deposit wallet is no pool's
    solana: 1_500_000_000n + 12_500_000n + 1n,
    base: 10_000_000_000_000_000n + 2_000_000_000_000_000n,
    robinhood: 300_000_000_000_000n,
  });
  // a pool whose notes hold nothing but whose U_X holds money is not empty
  assert.equal(portfolio(snap(BEFORE), data, NOW).pools.view, "rows");
  // the deposit sheet's balance reads the same number as Portfolio's row
  assert.deepEqual(poolBalance(BEFORE.pools, "solana", BEFORE.deposit_wallets), { asset: "SOL", balance: "1.512500001" });
  assert.deepEqual(poolBalance(BEFORE.pools, "base", BEFORE.deposit_wallets), { asset: "ETH", balance: "0.012" });
  assert.deepEqual(poolBalance(BEFORE.pools, "robinhood", BEFORE.deposit_wallets), { asset: "ETH", balance: "0.0003" });
});

test("Cash counts the remainder once, on its pool's chain, at the page's own price", () => {
  const t = portfolio(snap(BEFORE), data, NOW).totals!;
  // 1.512500001 SOL at $150 = $226.87; 0.012 ETH at $3,000 = $36.00; 0.0003 ETH at $3,000 = $0.90; the vault's $10.00
  assert.deepEqual(t.parts, [
    { chain: "near", cents: 1000n, moving: false },
    { chain: "solana", cents: 22687n, moving: false },
    { chain: "base", cents: 3600n, moving: false },
    { chain: "robinhood", cents: 90n, moving: false },
  ]);
  assert.equal(t.cash, 1000n + 22687n + 3600n + 90n);
  // what a chain with no pool spends (the vault path) holds none of it
  assert.equal(t.offPool, 1000n);
});

test("after the carry lands, the money moved from U_X into the pool counts once: no double count", () => {
  // U_X's 0.0125 SOL carried: 0.01 into the pool as notes, 0.0025 left at U_X; then the top-up's carry takes the rest
  const part = { ...BEFORE, pools: BEFORE.pools!.map((p) => (p.chain === "solana" ? { ...p, balance: "1.51" } : p)), deposit_wallets: BEFORE.deposit_wallets!.map((w) => (w.address === "SoU1" ? { ...w, amount: "0.0025" } : w)) };
  const all = { ...BEFORE, pools: BEFORE.pools!.map((p) => (p.chain === "solana" ? { ...p, balance: "1.5125" } : p)), deposit_wallets: BEFORE.deposit_wallets!.filter((w) => w.address !== "SoU1") };
  for (const s of [part, all]) {
    assert.equal(rows(s).solana, rows(BEFORE).solana);
    assert.equal(portfolio(snap(s), data, NOW).totals!.cash, portfolio(snap(BEFORE), data, NOW).totals!.cash);
    assert.equal(poolBalance(s.pools, "solana", s.deposit_wallets)!.balance, "1.512500001");
  }
});

test("a page that sends no deposit_wallets, or none above zero: the pool's balance is its notes alone", () => {
  const { deposit_wallets: _, ...earlier } = BEFORE;
  assert.deepEqual(rows(earlier), { near: 10_000_000n, solana: 1_500_000_000n, base: 10_000_000_000_000_000n, robinhood: 0n });
  assert.deepEqual(poolBalance(earlier.pools, "solana", earlier.deposit_wallets), { asset: "SOL", balance: "1.5" });
  const zero = { ...BEFORE, deposit_wallets: BEFORE.deposit_wallets!.map((w) => ({ ...w, amount: "0" })) };
  assert.deepEqual(rows(zero), rows(earlier));
  // an entry in another asset than its pool's adds nothing to it (the kit's schema refuses one; never summed across assets)
  const other = { ...earlier, deposit_wallets: [{ chain: "base" as const, address: "x", asset: "USDC" as const, amount: "5" }] };
  assert.deepEqual(rows(other), rows(earlier));
});

test("the deposit sheet's send rule: only under an address for the pool's own coin on its own chain, drafts each", () => {
  assert.equal(ownCoin("solana", { symbol: "SOL", chain: "Solana" }), true);
  assert.equal(ownCoin("base", { symbol: "ETH", chain: "Base" }), true);
  assert.equal(ownCoin("robinhood", { symbol: "ETH", chain: "Robinhood" }), true);
  // another coin, or the coin on another chain, has a 1Click address whose heading names its own coin and chain
  assert.equal(ownCoin("solana", { symbol: "USDC", chain: "Solana" }), false);
  assert.equal(ownCoin("base", { symbol: "ETH", chain: "Arbitrum" }), false);
  assert.equal(ownCoin("near", { symbol: "USDC", chain: "NEAR" }), false);
  assert.deepEqual([WORDS.sendOnlySolana, WORDS.sendOnlyBase, WORDS.sendOnlyRobinhood].map((w) => [w.text, w.draft]), [
    ["Send only SOL on Solana.", true],
    ["Send only ETH on Base.", true],
    ["Send only ETH on Robinhood.", true],
  ]);
});
