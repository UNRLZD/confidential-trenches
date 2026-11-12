// Portfolio from the device's own trade records (card portfolio-shows-pool-trades): the owner's private round trips on
// Solana mainnet, 12 Nov 05:36-05:40Z, replayed as the signing page records them (a deposit into the pool, a buy, a sell
// to zero, a second buy and sell to zero), and the rows the screen reads: the open position with its size, cost and
// value; each sold-out position on the closed list with its realized profit or loss in the pool's asset and in USD;
// every trade in Activity with its transaction; and the totals. The same rows from Base, Robinhood and NEAR records.
//   node --test apps/terminal/test/portfolio-pool-trades.test.ts
//
// The amounts are the chain's own (getTransaction at finalized on a public RPC, 12 Nov): each buy's SOL into the venue
// (pump's BuyExactSolIn spendable_sol_in) and the token amount W received; each sale's SOL out of the venue to W (W's
// lamports after less before, plus the fee and every lamport W paid out in the transaction). USD at the SOL price of each
// trade's own block, Pyth's SOL/USD feed write before it (the page's own feed; packages/signpage/src/trade-fill.ts
// blockPrice): $82.94890043, $82.98770947, $83.0183693 and $82.99893922. A sale's is what the fill writes on release
// 118's records (usd_from "block"); a buy's stands in for the live price its record was written with.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HeldMarket, Operation, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { heldData } from "../src/screens/portfolio/held.ts";
import { activity, closedRows, portfolio, stats } from "../src/screens/portfolio/model.ts";

const MINT = "78GaXFTJzkCWpdxkNHMSP3TXEKbhQTpb3EqMt7Uupump";
const T = (s: string) => Date.parse(`2026-11-12T${s}Z`);
const NOW = T("05:45:00");
const TX = {
  buy1: "5Qn5LtHiu7xb7irPaPTSpcwPoreem1toPSYT3XvVBPDfH42CU3hMWmKP3AMXg3ag3qdoQb3Rnxrfo6dXVGXtvB8Q",
  sell1: "32CSJ1GSPrJScgPxyF41zuszLjosxgiDbeFWFRM5p7G6DzbxHjeFWihPjqhQqCLobXhkn3aqBD6WxmenAXLu7Kwn",
  buy2: "3sPawpfvAdoYLHa9i5MRKZVv6xEGLCmRXjJTKxEMHpNYqPMSX22QZ6eyLbdyJDNA7T6TTpWWaKamEA1LiAMaDoQr",
  sell2: "3aUiLLSmj1oHFot7bPLp1VewwqHZ1eNsJnTyZvLnDFKyubfqmwK6iCq7AsSXmt497Vjx8o6AxwEbRzxeEjQr52bd",
};
const sol = (hash: string) => [{ chain: "solana" as const, hash }];

const deposit: Operation = { id: "d1", kind: "pool_deposit", stage: "in_pool", txs: [], created_ms: T("05:30:00"), chain: "solana" } as Operation;
const buy1: Operation = { id: "b1", kind: "buy", stage: "filled", txs: sol(TX.buy1), created_ms: T("05:36:50"), chain: "solana", token: MINT, amount_usd: "0.10002700069283141", units: "16041.923776", pool_amount: "0.001205887" };
const sell1: Operation = { id: "s1", kind: "sell", stage: "filled", txs: sol(TX.sell1), created_ms: T("05:38:28"), chain: "solana", token: MINT, units: "16041.923776", amount_usd: "0.04768764243129345", pool_amount: "0.000574635" };
const buy2: Operation = { id: "b2", kind: "buy", stage: "filled", txs: sol(TX.buy2), created_ms: T("05:39:30"), chain: "solana", token: MINT, amount_usd: "0.0999999427770536", units: "34154.038071", pool_amount: "0.001204552" };
const sell2: Operation = { id: "s2", kind: "sell", stage: "filled", txs: sol(TX.sell2), created_ms: T("05:39:56"), chain: "solana", token: MINT, units: "34154.038071", amount_usd: "0.09749603193780052", pool_amount: "0.001174666" };

const base = (ops: Operation[], positions: SignpageState["positions"]): SignpageClientSnapshot => ({
  status: "ready",
  release: "signpage-v1",
  stale: false,
  state: { release: "signpage-v1", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "0", wallets: [], positions, orders: [], held: [], ops, pools: [{ chain: "solana", asset: "SOL", balance: "0.019392" }] } as SignpageState,
});
const markets: HeldMarket[] = [{ chain: "solana", token: MINT, symbol: "Icm", name: "Internet cat money", price_usd: "0.00000233314178549" }];

test("the whole sequence: nothing open, both round trips closed with their realized SOL and USD, every trade in Activity", () => {
  const snap = base([deposit, buy1, sell1, buy2, sell2], []);
  const d = heldData(snap, markets, new Map(), NOW);
  const pf = portfolio(snap, d, NOW);
  assert.equal(pf.rows.length, 0);
  const closed = closedRows(d);
  assert.equal(closed.length, 2);
  const [second, first] = closed;
  // newest close first; bought and sold in cents, rounded down; realized is sold less bought
  assert.deepEqual([first!.bought, first!.sold, first!.realized, first!.realizedBps], [10n, 4n, -6n, -5232]);
  assert.deepEqual([second!.bought, second!.sold, second!.realized, second!.realizedBps], [9n, 9n, -1n, -250]);
  // the pool asset's own figures, exact
  assert.deepEqual([first!.asset, first!.realizedAsset], ["SOL", "-0.000631252"]);
  assert.deepEqual([second!.asset, second!.realizedAsset], ["SOL", "-0.000029886"]);
  assert.equal(first!.closedAt, sell1.created_ms);
  assert.equal(first!.heldMs, sell1.created_ms! - buy1.created_ms!);
  assert.equal(first!.symbol, "Icm");
  // the header's figures follow the closed list
  assert.equal(stats(closed).trades, 2);
  // the rows' own figures added, as the calendar adds them
  assert.equal(pf.totals!.realized30, -7n);
  // Activity: each trade with its own transaction and size
  const acts = activity(snap.state!.ops, d).filter((r) => r.kind === "buy" || r.kind === "sell");
  assert.deepEqual(acts.map((r) => [r.kind, r.txs[0]!.hash, r.usd]), [["sell", TX.sell2, 9n], ["buy", TX.buy2, 9n], ["sell", TX.sell1, 4n], ["buy", TX.buy1, 10n]]);
});

test("between the second buy and its sale: one open row with size, cost and value, the first round trip closed", () => {
  const snap = base([deposit, buy1, sell1, buy2], [{ chain: "solana", token: MINT, amount: "34154.038071", cost: "0.0999999427770536", wallets: ["8e8RsnpnL6Toqsa2Q1YPLvopDqPa3HFTdwEikCkqpQ7p"], decimals: 6 }]);
  const d = heldData(snap, markets, new Map(), NOW);
  const pf = portfolio(snap, d, NOW);
  assert.equal(pf.rows.length, 1);
  const r = pf.rows[0]!;
  // the row's figures to the nearest cent: a $0.0999999 buy is Bought $0.10, never $0.09; 34,154.038071 x
  // 0.00000233314178549 = $0.0797 is Value $0.08
  assert.deepEqual([r.units, r.cost, r.value, r.bought, r.sold, r.realized, r.openedAt], ["34154.038071", 10n, 8n, 10n, 0n, 0n, buy2.created_ms]);
  assert.equal(closedRows(d).length, 1);
});

test("a record with no size of its own (a sale written before its proceeds were recorded) closes with a dash, never a made-up figure", () => {
  const { amount_usd: _u, pool_amount: _p, ...bare } = sell1 as Operation & { pool_amount?: string };
  const snap = base([buy1, bare as Operation], []);
  const [c] = closedRows(heldData(snap, markets, new Map(), NOW));
  assert.equal(c!.bought, 10n);
  assert.equal(c!.sold, null);
  assert.equal(c!.realized, null);
  assert.equal(c!.realizedAsset, null);
});

// R3 (review P2-3): recordPoolBuy writes no amount_usd when the page had no SOL price at the request (positions.ts)
test("R3: a closed round trip whose buy names no USD draws a dash for bought, realized and its percent, and adds nothing to the total", () => {
  const { amount_usd: _u, ...noUsd } = buy1 as Operation & { amount_usd?: string };
  const snap = base([noUsd as Operation, sell1], []);
  const d = heldData(snap, markets, new Map(), NOW);
  const [c] = closedRows(d);
  assert.deepEqual([c!.bought, c!.sold, c!.realized, c!.realizedBps], [null, 4n, null, null]);
  assert.equal(c!.realizedAsset, "-0.000631252", "the SOL figures stand on their own");
  assert.equal(portfolio(snap, d, NOW).totals!.realized30, 0n);
});

// R4 (review P2-4): an open position whose buy names no USD: the signing page's cost "0" means unknown (positions.ts),
// never $0.00 bought and its whole value profit
test("R4: an open row whose buy names no USD has no cost, bought or PnL, and adds its value to the total but nothing to the unrealized", () => {
  const { amount_usd: _u, ...noUsd } = buy2 as Operation & { amount_usd?: string };
  const unknown = { chain: "solana" as const, token: MINT, amount: "34154.038071", cost: "0", wallets: ["8e8RsnpnL6Toqsa2Q1YPLvopDqPa3HFTdwEikCkqpQ7p"], decimals: 6 };
  const snap = base([noUsd as Operation], [unknown]);
  const pf = portfolio(snap, heldData(snap, markets, new Map(), NOW), NOW);
  const r = pf.rows[0]!;
  assert.deepEqual([r.cost, r.bought, r.value, r.pnl, r.pnlBps], [null, null, 8n, null, null]);
  assert.deepEqual([pf.totals!.inPos, pf.totals!.unreal], [7n, 0n]);
  // beside a row with a known cost: only that row's PnL counts
  const known = { ...unknown, token: "So11111111111111111111111111111111111111112", cost: "0.05" };
  const two = base([noUsd as Operation], [unknown, known]);
  const pf2 = portfolio(two, heldData(two, [...markets, { ...markets[0]!, token: known.token, symbol: "K", price_usd: "0.000003" }], new Map(), NOW), NOW);
  assert.deepEqual([pf2.totals!.inPos, pf2.totals!.unreal], [17n, 5n]);
});

test("the same rows from Base, Robinhood and NEAR records: ETH on the EVM pools, USD only on NEAR", () => {
  for (const [chain, asset] of [["base", "ETH"], ["robinhood", "ETH"], ["near", null]] as const) {
    const t = chain === "near" ? "token.near" : "0xAbC0000000000000000000000000000000000001";
    const ops: Operation[] = [
      { id: `${chain}b`, kind: "buy", stage: "filled", txs: [{ chain, hash: "0x01" }], created_ms: T("05:00:00"), chain, token: t, amount_usd: "10", units: "5", ...(asset ? { pool_amount: "0.004" } : {}) },
      { id: `${chain}s`, kind: "sell", stage: "filled", txs: [{ chain, hash: "0x02" }], created_ms: T("05:10:00"), chain, token: t, amount_usd: "12.5", units: "5", ...(asset ? { pool_amount: "0.005" } : {}) },
    ];
    const [c] = closedRows(heldData(base(ops, []), [], new Map(), NOW));
    assert.equal(c!.realized, 250n, chain);
    assert.equal(c!.asset, asset, chain);
    assert.equal(c!.realizedAsset, asset ? "0.001" : null, chain);
  }
});
