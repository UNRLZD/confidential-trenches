// The money figures' one rule (card portfolio-counts-money-an-open-buy-holds, review of 98d75c8cb): a row's figures are
// its exact figures to the nearest cent, its PnL the exact difference so (a zero with no sign, the percent from the exact
// figures), every total the exact sum rounded down once (never a sum of rounded rows, so never more than there is), and
// Initials, the share the device signs, from the exact cost and value. Red at 98d75c8cb: Initials came from the rounded
// cents (3334 for 5937), twenty $0.005 rows drew Positions $0.20 and Unrealized +$0.20, and a zero drew "+$0.00".
//   node --test test/portfolio-exact.test.ts      (from apps/terminal)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { bps, calendar, closedRows, NO_DATA, pct, portfolio, shareOf, signOf, soldOutRow, usd } from "../src/screens/portfolio/model.ts";
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

// Percents and tones (round 3): a percent to the nearest tenth from the exact figures, as an amount to the nearest cent
// (red at c833d1310: cut, so $118.9999962 on $100 drew "+118.9%" beside "+$119.00"); a tone from the exact sign, never
// the rounded figure (red at c833d1310: an exact loss drawn "$0.00" took the up tone beside its "−2.5%").
test("a percent to the nearest tenth from the exact figures; one that rounds to 0.0 has no sign", () => {
  const up = row("100", "1234567.891234", "0.00017739");
  // the Total PnL's figures: $118.9999962 on $100
  assert.equal(pct(bps(up.valueX! - up.costX! + up.realizedX, up.costX!)), "+119.0%");
  assert.equal(pct(up.pnlBps), "+119.0%");
  assert.equal(pct(-245), "−2.5%");
  assert.equal(pct(-244), "−2.4%");
  assert.equal(pct(4), "0.0%");
  assert.equal(pct(-4), "0.0%");
  assert.equal(pct(5), "+0.1%");
});

test("a tone from the exact sign: a loss drawn $0.00 is a loss, only an exact zero is neutral", () => {
  // the open row: $0.0975 on $0.10 draws "$0.00", a loss
  const down = row("0.1", "1", "0.0975");
  assert.deepEqual([down.pnl, down.pnlSign, pct(down.pnlBps)], [0n, -1n, "−2.5%"]);
  const flat = row("0.1", "1", "0.1");
  assert.deepEqual([flat.pnl, flat.pnlSign, pct(flat.pnlBps)], [0n, 0n, "0.0%"]);
  // the closed row: bought $0.1, sold $0.0975, as the pool-trades fixture's
  const NOW2 = Date.parse("2026-11-12T12:00:00Z");
  const d: PortfolioData = { ...NO_DATA, closed: [{ chain: "solana", token: "T", bought: "0.1", sold: "0.0975", opened_at: NOW2 - 60_000, closed_at: NOW2 - 1_000 }] as PortfolioData["closed"] };
  const [c] = closedRows(d);
  assert.deepEqual([c!.realized, signOf(c!.realizedX!), pct(c!.realizedBps)], [0n, -1n, "−2.5%"]);
  // its calendar day and month: $0.00, red by the exact sign, counted a red day
  const cal = calendar([c!], NOW2);
  const day = cal.days.find((x) => x.pnl !== null)!;
  assert.deepEqual([day.pnl, day.sign, cal.sum, cal.sumSign, cal.green, cal.red], [0n, -1n, 0n, -1n, 0, 1]);
  // the totals: Unrealized $0.00, its tone down
  const pf = portfolio(snap(state([{ chain: "solana", token: "T", amount: "1", cost: "0.1", wallets: ["W"] }])), priced({ T: "0.0975" }), NOW);
  assert.deepEqual([pf.totals!.unreal, pf.totals!.unrealSign], [0n, -1n]);
});
