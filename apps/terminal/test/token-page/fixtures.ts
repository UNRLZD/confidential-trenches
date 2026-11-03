// The token page's fixtures (card app-token-page), each a 06b §6.1 `Row` (src/screens/discover/fields.ts: the kit
// freezes no market field list, packages/kit/src/helper/v1.ts `HelperMarketAnswer = unknown`). Made up, not a read:
// one token per case the page draws differently. `curve` is still on its launchpad's curve, `pool` left it for a pool,
// `listed` has no launchpad (any token with a pool, J3 and J19, app.md:302, :552), and `edges` lacks every optional
// field and carries the longest text. Test only: the page's unit test (test/token-page.test.ts) and its run
// (run.mjs), which answers them as the helper would; nothing under src/ imports this file (test/no-test-token.test.ts).
import type { MarketRow } from "../../src/screens/discover/fields.ts";

/** The clock the fixtures' ages are drawn against, so every shot is the same: 2026-11-01 12:00:00Z. */
export const FIXTURE_NOW_MS = Date.UTC(2026, 10, 1, 12, 0, 0);
const NOW_S = FIXTURE_NOW_MS / 1000;

// Ids in their chain's form, kept apart from a `token:` key (gitleaks reads a long id beside that word as a secret).
const ID = {
  curve: "G1owFixtureCurve1111111111111111111111pump",
  pool: "Fe11xFixturePool11111111111111111111111pump",
  listed: "PythFixtureListed11111111111111111111111111",
  edges: "a-token-with-the-longest-account-id-a-fixture-can-hold.tkn.near",
};

const at = { src: "fixture", as_of_ms: FIXTURE_NOW_MS } as const;

export const TOKENS: Record<string, MarketRow> = {
  curve: {
    chain: "solana", token: ID.curve, symbol: "GLOW", name: "Glow Worm", icon: false, venue: "pump.fun", label: null,
    created_s: NOW_S - 41 * 60, price_usd: "0.0000273", mc_usd: "27300", vol_24h_usd: "132700", chg_5m_bps: 214,
    chg_1h_bps: -380, chg_24h_bps: 802, liq_usd: "9810", holders: 2680, top10_bps: 2140, ...at, creator: null,
    creator_sold_bps: null, dev_bps: 310, snipers_bps: 820, mint_auth: false, freeze_auth: false, vol_5m_usd: "4820",
    buys_5m: 61, sells_5m: 44, net_5m_usd: "730", risk_src: null, launchpad: "pump.fun", curve_bps: 6420,
    vol_1h_usd: "38100", chg_4h_bps: 1290, buys_24h: 1904, sells_24h: 1611,
  },
  pool: {
    chain: "solana", token: ID.pool, symbol: "FELIX", name: "Felix the Cat", icon: false, venue: "pumpswap", label: null,
    created_s: NOW_S - 30 * 86400, price_usd: "0.00412", mc_usd: "4120000", vol_24h_usd: "1840000", chg_24h_bps: -517,
    liq_usd: "297400", holders: 18_420, top10_bps: 1880, ...at, dev_bps: 0, launchpad: "pump.fun", curve_bps: 10000,
  },
  listed: {
    chain: "solana", token: ID.listed, symbol: "PYTH", name: "Pyth Network", icon: false, venue: "orca", label: null,
    created_s: NOW_S - 900 * 86400, price_usd: "0.1123", mc_usd: "1123000000", vol_24h_usd: "38900000",
    chg_24h_bps: 34, liq_usd: "12400000", holders: 312_000, ...at, launchpad: null, curve_bps: null,
  },
  edges: {
    chain: "near", token: ID.edges, symbol: "SUPERCALIFRAGILISTIC", name: "A token name long enough to need its ellipsis",
    icon: false, price_usd: null, ...at, launchpad: "pons", curve_bps: null,
  },
};
