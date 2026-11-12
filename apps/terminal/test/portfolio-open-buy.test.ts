// Card portfolio-counts-money-an-open-buy-holds, from the 12 Nov mainnet buy (4HSwogMa…ZANZd3): the pool released
// 10,000,000 lamports; the coin got 121,043; the buy's one-time wallet kept 5,618,795 and its token and volume accounts
// 1,513,840 and 1,346,200 (back to it when the position sells). Portfolio counted none of the 8,478,835 lamports still
// the user's, drew a $0.01 buy as Bought $0.00, drew "Pending" (and the trade box "Making proof") for notes no proof can
// ever spend, and four chart ticks all "$3".
//   node --test apps/terminal/test/portfolio-open-buy.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { axisLabels, portfolio } from "../src/screens/portfolio/model.ts";
import type { PortfolioData } from "../src/screens/portfolio/model.ts";
import { heldData } from "../src/screens/portfolio/held.ts";

const NOW = Date.parse("2026-11-12T12:22:00Z");
// $82.37 a SOL, read 1 s ago: one SOL is 8237000000 x 10^-8 USD
const price = { price: "8237000000", expo: -8, published_s: Math.floor(NOW / 1000) - 2, read_ms: NOW - 1000 };
const MINT = "Coin1111111111111111111111111111111111111111";
const base = (over: Partial<SignpageState> = {}): SignpageState => ({
  release: "release-120",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "0",
  wallets: [],
  pools: [{ chain: "solana", asset: "SOL", balance: "0.030426", ready: "0", tap_max: "0", price }],
  positions: [{ chain: "solana", token: MINT, amount: "34210.5", cost: "0.0099999", wallets: ["W1"], decimals: 6, asset_held: "0.008478835" }],
  orders: [],
  held: [],
  ops: [{ id: "b1", kind: "buy", stage: "filled", txs: [], created_ms: NOW - 150_000, chain: "solana", token: MINT, amount_usd: "0.0099999", units: "34210.5", pool_amount: "0.000121043" }],
  ...over,
});
const snap = (s: SignpageState): SignpageClientSnapshot => ({ status: "ready", release: s.release, stale: false, state: s });
// the coin at $0.00000029: 34,210.5 x that = $0.0099210
const data = (s: SignpageState): PortfolioData => heldData(snap(s), [{ chain: "solana", token: MINT, symbol: "COIN", name: "Coin", price_usd: "0.00000029" }], new Map(), NOW);

test("end state 1: Total and Positions count what the open buy's wallet holds, at the pool's own price, once", () => {
  const s = base();
  const t = portfolio(snap(s), data(s), NOW).totals!;
  // the pool: 0.030426 x 82.37 = $2.506 -> 250 cents (down)
  assert.equal(t.cash, 250n);
  // the wallet's 0.008478835 SOL x 82.37 = $0.6983 -> 69 cents (down); the coin's row $0.0099 -> 1 cent as the row
  // shows it (the totals are the sums of the rows' own figures, review P3-1)
  assert.equal(t.held, 69n);
  assert.equal(t.inPos, 70n);
  assert.equal(t.total, 320n);
  // the value line ends at the total
  const d = data(s);
  // (the line's points are the exact sums, cut to cents: $3.1999 against the rows' rounded $3.20, a cent apart at most)
  assert.equal(d.series.at(-1)?.[1], "3.19");
  assert.ok(Math.abs(Math.round(Number(d.series.at(-1)?.[1]) * 100) - Number(t.total)) <= 1);
});

test("end state 1: no asset_held (an earlier page) counts nothing for it; no price leaves it out, never made up", () => {
  const s0 = base({ positions: [{ chain: "solana", token: MINT, amount: "34210.5", cost: "0.0099999", wallets: ["W1"], decimals: 6 }] });
  assert.equal(portfolio(snap(s0), data(s0), NOW).totals!.held, 0n);
  const s1 = base({ pools: [{ chain: "solana", asset: "SOL", balance: "0.030426", ready: "0" }] });
  const t1 = portfolio(snap(s1), data(s1), NOW).totals!;
  assert.equal(t1.held, 0n);
  assert.equal(t1.partial, true);
});

test("end state 1: a wallet the state already counts (an arm record's) is never counted twice", () => {
  const s = base({ wallets: [{ chain: "solana", address: "W1", role: "fresh", size: "0.70", state: "READY" }] });
  const t = portfolio(snap(s), data(s), NOW).totals!;
  assert.equal(t.held, 0n);
  assert.equal(t.cash, 320n);
});

test("end state 2: the row's Bought and Value read the real figure, a $0.01 buy never $0.00", () => {
  const s = base();
  const r = portfolio(snap(s), data(s), NOW).rows[0]!;
  assert.equal(r.bought, 1n);
  assert.equal(r.value, 1n);
});

test("end state 4: the chart's ticks read distinct at any range", () => {
  for (const [lo, hi] of [[2.5, 3.4], [3.31, 3.34], [0, 1], [1200, 1260], [0.004, 0.0049], [5, 5.0001]] as const) {
    const l = axisLabels(lo, hi, 4).map((x) => x.label);
    assert.equal(new Set(l).size, 4, `${lo}..${hi}: ${l.join(" ")}`);
  }
  assert.deepEqual(axisLabels(2.5, 3.4, 4).map((x) => x.label), ["$2.61", "$2.84", "$3.06", "$3.29"]);
});
