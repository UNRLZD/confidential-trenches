// The money figures' one rule (card portfolio-counts-money-an-open-buy-holds, review of 98d75c8cb): a row's figures are
// its exact figures to the nearest cent, its PnL the exact difference so (a zero with no sign, the percent from the exact
// figures), every total the exact sum rounded down once (never a sum of rounded rows, so never more than there is), and
// Initials, the share the device signs, from the exact cost and value. Red at 98d75c8cb: Initials came from the rounded
// cents (3334 for 5937), twenty $0.005 rows drew Positions $0.20 and Unrealized +$0.20, and a zero drew "+$0.00".
//   node --test test/portfolio-exact.test.ts      (from apps/terminal)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { NO_DATA, pct, portfolio, shareOf, soldOutRow, usd } from "../src/screens/portfolio/model.ts";
import type { PortfolioData } from "../src/screens/portfolio/model.ts";

const NOW = Date.parse("2026-11-12T12:22:00Z");
type Position = SignpageState["positions"][number];
const state = (positions: Position[]): SignpageState =>
  ({ release: "signpage-v1", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "0", wallets: [], positions, orders: [], held: [], ops: [] }) as unknown as SignpageState;
const snap = (s: SignpageState): SignpageClientSnapshot => ({ status: "ready", release: s.release, stale: false, state: s });
/** Each token at its own price, by token. */
const priced = (prices: Record<string, string>): PortfolioData => ({ ...NO_DATA, market: (_c, t) => (prices[t] ? { symbol: t, name: t, price: prices[t]!, route: true } : null) });
const row = (cost: string, amount: string, price: string) => portfolio(snap(state([{ chain: "solana", token: "T", amount, cost, wallets: ["W"] }])), priced({ T: price }), NOW).rows[0]!;

test("Initials from the exact cost and value, never the rounded cents (the share_bps the device signs)", () => {
  // $0.0149 in, $0.0251 now: 0.0149 / 0.0251 = 59.36%, up to 5937 (the cents, 1 and 3, would give 3334)
  assert.equal(row("0.0149", "1", "0.0251").initials, 5937);
  assert.equal(row("0.005", "1", "0.008").initials, 6250);
  assert.equal(row("0.002", "1", "0.003").initials, 6667);
  // not up on the exact figures: none, though the cents draw $0.01 against $0.00
  assert.equal(row("0.005", "1", "0.005").initials, null);
  assert.equal(row("0.005", "1", "0.004").initials, null);
});

test("twenty rows of $0.005 at $0.004 cost: each draws $0.01, Positions is $0.10 and Unrealized +$0.02, never the rows added", () => {
  const ps = Array.from({ length: 20 }, (_, i) => ({ chain: "solana" as const, token: `T${i}`, amount: "1", cost: "0.004", wallets: [`W${i}`] }));
  const pf = portfolio(snap(state(ps)), priced(Object.fromEntries(ps.map((p) => [p.token, "0.005"]))), NOW);
  assert.ok(pf.rows.every((r) => r.value === 1n && r.cost === 0n && r.pnl === 0n), "each row its own figures to the nearest cent");
  assert.equal(pf.totals!.inPos, 10n);
  assert.equal(pf.totals!.unreal, 2n);
  assert.equal(pf.totals!.total, 10n);
});

test("the owner's open buy: Bought $0.01 for $0.0099999", () => {
  assert.equal(row("0.0099999", "4286.1", "0.00000233314").bought, 1n);
});

test("a zero draws $0.00 with no sign beside its exact percent; the $219.00 position's 50% share is $109.50", () => {
  assert.equal(`${usd(0n, true)} ${pct(-250)}`, "$0.00 −2.5%");
  assert.equal(usd(5n, true), "+$0.05");
  assert.equal(usd(-5n, true), "−$0.05");
  const up = row("100", "1234567.891234", "0.00017739");
  assert.equal(up.value, 21900n);
  assert.equal(shareOf(up, 5000), 10950n);
  // a sale that sold it all: no share left and no Initials
  const gone = soldOutRow(up);
  assert.deepEqual([gone.value, shareOf(gone, 5000), gone.initials], [0n, 0n, null]);
});
