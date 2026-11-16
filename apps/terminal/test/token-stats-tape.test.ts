// card token-stats-count-every-trade: a token page's buys, sells and volume (About's 5m tiles and its 24h, 1h and 5m
// flows) are its own trades list's for every window inside the list's reach: the helper's `whole_ms` (every trade at or
// after it is in the list), raised past the oldest row when the list holds as many rows as the page asks. A window
// before the reach, a list still filling, or one with no reach keeps the token row's numbers.
// The rows, the token rows and the reaches are MADE, shaped from the live reads of 16 Nov 20:0x-20:2xZ on ct-api:
//   - Base FLOWER 0x3e12b9d6a4d12cd9b4a6d613872d0eb32f68b380: row (GeckoTerminal, its top pool) 1h 13 buys / 9 sells,
//     24h 231 / 300; the tape 17 rows, not filling, its oldest 58.5 min back (GeckoTerminal's top pool h1: 7 buys,
//     10 sells), the read back's floor an hour of 200 ms blocks (swaps.ts VENUES base tapeBack 18,000);
//   - Solana READ GAS (Jupiter row 0 buys, 1 sell, $0.07 in 5m) against its tape's 1 buy, 1 sell, $0.14;
//   - Solana BUMBA (a new pump.fun coin): row with no 5m numbers, tape 5 trades in 5 min (1 buy, 4 sells, $98.76),
//     filling;
//   - Robinhood TIBBIR 0x4db7374e966097be94c6680d49156d580f097bbf: row (DexScreener) 1h 3 buys / 1 sell;
//   - NEAR BLACKDRAGON blackdragon.tkn.near: row and engine tape alike.
//   node --test apps/terminal/test/token-stats-tape.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarketRow } from "../src/screens/discover/fields.ts";
import { aboutView } from "../src/screens/token/lower.ts";
import type { Tape, Trade } from "../src/screens/token/trades.ts";

const MIN = 60_000;
const NOW = 1_794_142_000_000;
const row = (o: Partial<MarketRow> = {}): MarketRow => ({ chain: "solana", token: "Mint", symbol: "SYM", name: "Sym", icon: false, price_usd: "2", src: "jupiter", as_of_ms: 1, launchpad: null, mc_usd: "2000000", holders: 2680, top10_bps: 1627, ...o });
const ago = (min: number, i: number, side: Trade["side"], usd: string): Trade => ({ t_ms: NOW - min * MIN, side, usd, amt: "1", trader: null, tx: `m${i}`, ...{} });
const tape = (trades: Trade[], o: Partial<Tape> = {}): Tape => ({ trades, status: "ready", ...o });
const flows = (r: MarketRow, t: Tape | undefined) => aboutView(r, t, NOW).flows.map((f) => [f.win, f.buys, f.sells]);

test("Base FLOWER: the tape reaches an hour back (the read back's block floor), so 5m and 1h are the list's, 24h the row's", () => {
  const r = row({ chain: "base", src: "geckoterminal", buys_1h: 13, sells_1h: 9, buys_24h: 231, sells_24h: 300, buys_5m: 3, sells_5m: 4, vol_5m_usd: "800", net_5m_usd: "-100" });
  // 17 rows in 58.5 min: 7 buys, 10 sells; two of them (a buy of $40 and a sell of $15) in the last 5 min
  const rows = Array.from({ length: 17 }, (_, i) => ago(i === 0 ? 1 : i === 1 ? 4 : 6 + i * 3.1, i, i < 7 ? (i === 1 ? "sell" : "buy") : i === 7 ? "buy" : "sell", i === 0 ? "40" : i === 1 ? "15" : "50"));
  // the tape opened a minute ago, its read back an hour of blocks before that
  const t = tape(rows, { whole_ms: NOW - 61 * MIN + 1_000 });
  assert.deepEqual(flows(r, t), [["24h", "231", "300"], ["1h", "7", "10"], ["5m", "1", "1"]]);
  assert.deepEqual(aboutView(r, t, NOW).five, { vol: "$55.00", buys: "1", sells: "1", net: "+$25.00", netTone: "acc" });
  // the deployed page: the row's numbers in every window, whatever the list holds
  assert.deepEqual(flows(r, tape(rows)), [["24h", "231", "300"], ["1h", "13", "9"], ["5m", "3", "4"]]);
});

test("Solana READ GAS: a tape from the coin's first signature (whole_ms 0) is every window's", () => {
  const r = row({ src: "jupiter", vol_5m_usd: "0.07", buys_5m: 0, sells_5m: 1, net_5m_usd: "-0.07", buys_1h: 0, sells_1h: 1, buys_24h: 0, sells_24h: 1 });
  const t = tape([ago(1, 1, "sell", "0.07"), ago(3, 2, "buy", "0.07")], { whole_ms: 0 });
  assert.deepEqual(aboutView(r, t, NOW).five, { vol: "$0.14", buys: "1", sells: "1", net: "+$0", netTone: "acc" });
  assert.deepEqual(flows(r, t), [["24h", "1", "1"], ["1h", "1", "1"], ["5m", "1", "1"]]);
});

test("Solana BUMBA: while the tape fills the row's stand (no numbers: the dash); settled from the first signature, the list's", () => {
  const trades = [ago(0.5, 1, "buy", "20"), ago(1, 2, "sell", "30"), ago(2, 3, "sell", "20"), ago(3, 4, "sell", "20"), ago(4, 5, "sell", "8.76")];
  const r = row({ launchpad: "pump", buys_5m: null, sells_5m: null, vol_5m_usd: null, net_5m_usd: null });
  assert.deepEqual(aboutView(r, tape(trades, { filling: true, whole_ms: 0 }), NOW).five, { vol: "—", buys: "—", sells: "—", net: "—", netTone: "none" });
  assert.deepEqual(aboutView(r, tape(trades, { whole_ms: 0 }), NOW).five, { vol: "$98.76", buys: "1", sells: "4", net: "−$58.76", netTone: "sell" });
});

test("Robinhood TIBBIR: a reach of 2 h (the oldest trade held) makes 1h and 5m the list's; 24h before it stays the row's", () => {
  const r = row({ chain: "robinhood", src: "dexscreener", buys_1h: 3, sells_1h: 1, buys_24h: 80, sells_24h: 114, buys_5m: 0, sells_5m: 0, vol_5m_usd: "0" });
  const t = tape([ago(10, 1, "buy", "300"), ago(40, 2, "buy", "200"), ago(119, 3, "sell", "90")], { whole_ms: NOW - 119 * MIN + 1_000 });
  assert.deepEqual(flows(r, t), [["24h", "80", "114"], ["1h", "2", "0"], ["5m", "0", "0"]]);
});

test("NEAR BLACKDRAGON: the engine's tape reaching back past a day is every window's", () => {
  const r = row({ chain: "near", src: "unrealized", buys_24h: 2, sells_24h: 1, buys_1h: 0, sells_1h: 0 });
  const t = tape([ago(100, 1, "buy", "5"), ago(500, 2, "sell", "4"), ago(900, 3, "buy", "3"), ago(2_000, 4, "buy", "1")], { whole_ms: NOW - 2_000 * MIN + 1_000 });
  assert.deepEqual(flows(r, t), [["24h", "2", "1"], ["1h", "0", "0"], ["5m", "0", "0"]]);
});

test("a full list (as many rows as the page asks) reaches only past its oldest row, whatever the helper claims", () => {
  const r = row({ buys_5m: 7, sells_5m: 8, vol_5m_usd: "500", net_5m_usd: "-5", buys_1h: 70, sells_1h: 80, buys_24h: 700, sells_24h: 800 });
  // 50 rows in the last 2 min: the 50 asked, so older trades are cut; a reach of 0 does not cover even 5m
  const busy = tape(Array.from({ length: 50 }, (_, i) => ago(0.04 * i, i, "buy", "1")), { whole_ms: 0 });
  assert.deepEqual(flows(r, busy), [["24h", "700", "800"], ["1h", "70", "80"], ["5m", "7", "8"]]);
  // 50 rows over 30 min: 5m is the list's
  const mid = tape(Array.from({ length: 50 }, (_, i) => ago((i * 30) / 49, i, "sell", "1")), { whole_ms: 0 });
  assert.deepEqual(flows(r, mid), [["24h", "700", "800"], ["1h", "70", "80"], ["5m", "0", "9"]]);
  // loading, failed and no tape: the row's
  for (const t of [{ trades: [], status: "loading" } as Tape, { trades: [], status: "none" } as Tape, undefined]) assert.deepEqual(flows(r, t), [["24h", "700", "800"], ["1h", "70", "80"], ["5m", "7", "8"]]);
});
