// Discover's fixtures (card app-discover-solana), shaped by 06b §6.1 `Row` and `snapshot` (src/screens/discover/
// fields.ts). `solana` is a recorded read, not made up: Jupiter's recent and top-trending lists as read on 2026-10-21
// 14:34:55Z (research repo proofs/p6-data/results/run5/jup-*.json), mapped field by field to Row through 06b's Solana
// sources (06b:1789-1815); a field Jupiter does not serve stays null. Only `curve_bps` is planted: the Graduating column
// reads it from the tape (markets.md D-S14), which that read did not record. `edges` holds the edge values the unit
// tests and the shots need: tiny prices, huge caps, rows with no optional field, hostile text.
import type { MarketRow, MarketSnapshot } from "../../src/screens/discover/fields.ts";
import read from "./solana-jupiter-2026-10-21.json" with { type: "json" };

/** The read is kept in columns, one `fields` header and each row as its values in that order (a mint under a
 *  `"token":` key reads to gitleaks' generic-api-key rule as a secret; these are public mint addresses). */
export const RECORDED_FIELDS: readonly string[] = read.fields;
const zip = (values: readonly unknown[]) => Object.fromEntries(read.fields.map((f, i) => [f, values[i]])) as unknown as MarketRow;
const rec: MarketSnapshot = {
  chain: "solana",
  as_of_ms: read.as_of_ms,
  lists: { new: read.lists.new.map(zip), trending_5m: read.lists.trending_5m.map(zip), trending_1h: read.lists.trending_1h.map(zip), trending: [] },
};

/** The read's own time: ages are drawn against it, so every shot is the same. */
export const NOW_MS: number = rec.as_of_ms;

const padded = [...rec.lists.new, ...rec.lists.trending_5m!].filter((r) => r.launchpad !== null);
const CURVE = [9420, 8810, 8125, 7650, 6100, 5230, 4300, 2210, 1480, 870, 310];
const graduating: MarketRow[] = padded.slice(0, CURVE.length).map((r, i) => ({ ...r, curve_bps: CURVE[i]! }));

export const solana: MarketSnapshot = {
  chain: "solana",
  as_of_ms: rec.as_of_ms,
  lists: {
    new: rec.lists.new,
    trending: rec.lists.trending_1h!,
    trending_5m: rec.lists.trending_5m!,
    trending_1h: rec.lists.trending_1h!,
    graduating,
  },
};

/** A row with only the fields 06b marks required. */
export const bare: MarketRow = {
  chain: "solana",
  token: "Bare1111111111111111111111111111111111111111",
  symbol: "BARE",
  name: "BARE",
  icon: false,
  price_usd: "0.000412",
  src: "jupiter",
  as_of_ms: NOW_MS,
  launchpad: null,
};

const at = (min: number) => Math.floor(NOW_MS / 1000) - min * 60;

export const edges: MarketRow[] = [
  { ...bare, token: "Tiny111111111111111111111111111111111111111", symbol: "TINY", name: "Tiny price", price_usd: "0.00000000001234", mc_usd: "12.3", created_s: at(0.2), vol_5m_usd: "0.04", buys_5m: 1, sells_5m: 0, vol_1h_usd: "0.04", launchpad: "pump.fun", curve_bps: 12, top10_bps: 9990, dev_bps: 0, holders: 2 },
  { ...bare, token: "Huge111111111111111111111111111111111111111", symbol: "HUGE", name: "A very long token name that must cut cleanly at every width", price_usd: "184223.5", mc_usd: "123456789012345", created_s: at(60 * 24 * 900), vol_5m_usd: "98765432.1", buys_5m: 123456, sells_5m: 120001, vol_1h_usd: "987654321.9", chg_5m_bps: 1234567, chg_1h_bps: -9950, holders: 12345678, top10_bps: 1200, dev_bps: 1500, launchpad: null },
  { ...bare, token: "Zalg111111111111111111111111111111111111111", symbol: "Z̢̛ͥ̀̽̽ALGO", name: "<img src=x onerror=alert(1)>", mc_usd: "999999", created_s: at(59), vol_5m_usd: "999.996", buys_5m: 0, sells_5m: 7, chg_5m_bps: -3300, holders: 999, top10_bps: 3000, dev_bps: 1000, launchpad: "met-dbc", curve_bps: 9999 },
  bare,
  // a pad the table does not know (card app-launchpad-chain-badges): no launchpad badge, never its raw id; the chain mark
  { ...bare, token: "NewPad1111111111111111111111111111111111111", symbol: "NEWPAD", name: "Unknown launchpad", launchpad: "some-new-pad", curve_bps: 10000 },
];

/** Every list empty: S5.3. */
export const empty: MarketSnapshot = { chain: "solana", as_of_ms: NOW_MS, lists: { new: [], trending: [], trending_5m: [], trending_1h: [], graduating: [] } };

/** The edge rows in every column. */
export const edgy: MarketSnapshot = { chain: "solana", as_of_ms: NOW_MS, lists: { new: edges, trending: edges, trending_5m: edges, trending_1h: edges, graduating: edges } };
