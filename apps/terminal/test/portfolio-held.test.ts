// Portfolio's live market data (card market-token-reads): each held token's symbol, name and price from the kit's held
// read, and the value line the kit computes from the signing page's positions and ops, ending at Portfolio's total.
// Whether a token sells now is not read here (route null), so no row is marked as having no route on the helper's word.
//   node --test apps/terminal/test/portfolio-held.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HeldMarket, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { heldData, heldRefs } from "../src/screens/portfolio/held.ts";
import { line, portfolio } from "../src/screens/portfolio/model.ts";

const H = 3_600_000;
const NOW = Date.parse("2026-11-10T03:00:00Z");
const state: SignpageState = {
  release: "signpage-v1",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "40.50",
  wallets: [],
  positions: [
    { chain: "solana", token: "MINTA", amount: "1000", cost: "3.06", wallets: ["a"] },
    { chain: "base", token: "0xAbC", amount: "2", cost: "1.00", wallets: ["b"] },
    { chain: "solana", token: "MINTA", amount: "1", cost: "0.01", wallets: ["c"] },
  ],
  orders: [],
  held: [],
  ops: [{ id: "b1", kind: "buy", stage: "filled", txs: [], created_ms: NOW - 2 * H, chain: "solana", token: "MINTA", amount_usd: "3.06" }],
};
const snap: SignpageClientSnapshot = { status: "ready", release: "signpage-v1", stale: false, state };
const markets: HeldMarket[] = [
  { chain: "solana", token: "MINTA", symbol: "AAA", name: "Token A", price_usd: "0.005" },
  { chain: "base", token: "0xAbC", symbol: null, name: null, price_usd: null },
];

test("the refs: each held token once, chain and token only", () => {
  assert.deepEqual(heldRefs(state), [{ chain: "base", token: "0xAbC" }, { chain: "solana", token: "MINTA" }]);
  assert.deepEqual(heldRefs(null), []);
});

test("a held token draws the kit's symbol, name and price; one it names nothing for draws as before; no route mark", () => {
  const d = heldData(snap, markets, new Map(), NOW);
  assert.deepEqual(d.market("solana", "MINTA"), { symbol: "AAA", name: "Token A", price: "0.005", route: null });
  assert.equal(d.market("base", "0xAbC"), null);
  const p = portfolio(snap, d, NOW);
  const a = p.rows.find((r) => r.token === "MINTA" && r.units === "1000")!;
  assert.equal(a.symbol, "AAA");
  assert.equal(a.value, 500n); // 1000 x 0.005 = $5.00
  assert.equal(a.mark, null);
});

test("the value line ends at Portfolio's total and rises with the token's closes", () => {
  const history = new Map([["solana:MINTA", [[NOW - 3 * H, "0.001"], [NOW - 2 * H, "0.002"], [NOW - H, "0.004"]] as [number, string][]]]);
  const d = heldData(snap, markets, history, NOW);
  const total = portfolio(snap, d, NOW).totals!.total;
  const pts = line(d.series, "1D", NOW);
  assert.equal(pts.at(-1)![0], NOW);
  assert.equal(pts.at(-1)![1], total);
  // in positions now: $5.00 + $0.005 (1 x 0.005) + the unpriced token's $1.00 cost = $6.005, rounded down once to 600
  // cents. Before the buy the two MINTA rows count at their cost; after it at each close, the exact sum rounded once
  assert.deepEqual(pts.map(([, c]) => total - c), [600n - 407n, 600n - 300n, 600n - 500n, 0n]);
});

test("no state: no market and no line", () => {
  const d = heldData({ status: "connecting", release: null, stale: false, state: null }, [], new Map(), NOW);
  assert.deepEqual(d.series, []);
  assert.equal(d.market("solana", "MINTA"), null);
});
