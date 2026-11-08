// Every word the token page draws, each with where the owner OK'd it (the shape of src/screens/discover/words.ts). A
// word the owner's lists do not hold yet is `draft: true`: drawn with data-draft-copy and listed in the card's report.
// Numbers, symbols, token names, launchpad ids and timeframe codes are data, not copy.
//
// The owner's lists: the locked R5 prototype's own labels (research repo design/proto at design-lock-r5:
// assets/token.js U.header and U.about, token-390.html's tiles, bar and timeframes) and owner-words-pass
// (docs/owner-decisions.md:351), and the new draft words (owner 1 Nov 16:45Z, keep).

export interface Word {
  text: string;
  source: string;
  draft: boolean;
}

const ok = (text: string, source: string): Word => ({ text, source, draft: false });

export const WORDS = {
  mc: ok("MC", "R5 token.js U.header hd-mcLabel; token-390.html tile mc"),
  price: ok("Price", "R5 token.js U.header tile"),
  change: ok("24h change", "R5 token.js U.header tile"),
  vol: ok("Vol", "R5 token.js U.header tile; token-390.html tile vol"),
  liq: ok("Liquidity", "R5 token.js U.header tile; token-390.html tile depth"),
  holders: ok("Holders", "R5 token.js U.header tile; token-390.html tile holders"),
  h24: ok("24h", "R5 token-390.html mt-h24"),
  sell: ok("Sell", "R5 token-390.html mb-sell"),
  buy: ok("Buy", "R5 token-390.html mb-buy (`Buy SYM`)"),
  chart: ok("Chart", "R5 token.js chart panel, the area's accessible name only (never drawn)"),
  retry: ok("Retry", "owner-words-pass (app-signpage-client)"),
  loading: ok("Loading", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S7.1 skeleton: the page's accessible name only (never drawn); as Discover's"),
  offline: ok("Offline", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S5.5 [draft copy: Offline], as Discover's error state"),
  noToken: ok("No token", "owner 1 Nov 16:45Z, keep; drafted from card app-token-page: the empty state (no token to draw)"),
  // the chart (card app-token-chart): R5's legend (token.js U.legend: `SYM · 15 · UNRLZD O … H … L … C … change`, then
  // `Vol …`), CoinGecko's fixed label (CN-110), and the chart's empty state
  lgO: ok("O", "R5 token.js U.legend cp-lgKv"),
  lgH: ok("H", "R5 token.js U.legend cp-lgKv"),
  lgL: ok("L", "R5 token.js U.legend cp-lgKv"),
  lgC: ok("C", "R5 token.js U.legend cp-lgKv"),
  lgVenue: ok("UNRLZD", "R5 token.js U.legend cp-lgHead (`SYM · 15 · UNRLZD`)"),
  gecko: ok("Powered by CoinGecko", "09-design-brief CN-110 (the fixed label, no words around it; owner round 16 words-r4, M160 O1) and R5 token.js U.chartPanel ct-vendor; CoinGecko API terms 4.4"),
  // the identity and the strip (card app-token-header), each in R5 at design-lock-r5
  tax: ok("Tax", "R5 token.js U.header tile (`Tax`); token-390.html tile tax"),
  inCurve: ok("In curve", "R5 token.js U.header tile (`In curve` for Liquidity on a curve token)"),
  top10: ok("Top 10 hold", "R5 token-390.html tile top10"),
  dev: ok("Dev holds", "R5 token-390.html tile dev"),
  searchX: ok("Search on X", "R5 token.js socials (token-x-search title)"),
  solscan: ok("Solscan", "R5 token.js EXPL.solana"),
  basescan: ok("BaseScan", "R5 token.js EXPL.base"),
  rhExplorer: ok("Robinhood explorer", "R5 token.js EXPL.robinhood"),
  nearblocks: ok("Nearblocks", "R5 token.js explorers (token-nearblocks)"),
  copy: ok("Copy contract", "R5 token.js hd-copy and token-390.html mt-ca aria-label"),
  back: ok("Back", "R5 token.js hd-back and token-390.html pp-back aria-label"),
  share: ok("Share", "R5 token-390.html m-token-share aria-label"),
  watchAdd: ok("Add {sym} to watchlist", "R5 token.js token-watch aria-label (unpressed)"),
  watchRemove: ok("Remove {sym} from watchlist", "R5 token.js token-watch and token-390.html m-token-watch aria-label (pressed)"),
  noData: ok("No data", "owner 3 Nov 20:26Z, picked; card app-token-chart: the chart's empty state (the helper holds no bars for this token and timeframe)"),
  // the chart's toolbar and bottom bar (card app-chart-controls), each in R5 token.js U.chartPanel at design-lock-r5
  // (and trenches-1440.html's clock); the menus' rows R5 does not draw are drafts
  indicators: ok("Indicators", "R5 token.js U.chartPanel chart-indicators"),
  display: ok("Display", "R5 token.js U.chartPanel chart-display"),
  mcap: ok("MCap", "R5 token.js U.chartPanel chart-mode (`Price / MCap`)"),
  usdUnit: ok("USD", "R5 token.js U.chartPanel chart-denom (`USD / NEAR`)"),
  rangeAll: ok("All", "R5 token.js U.chartPanel chart-range-All"),
  utc: ok("UTC", "R5 trenches-1440.html clock (`14:37:53 UTC`)"),
  pct: ok("%", "R5 token.js U.chartPanel chart-scale-pct"),
  pctTitle: ok("Percent scale", "R5 token.js U.chartPanel chart-scale-pct title"),
  log: ok("log", "R5 token.js U.chartPanel chart-scale-log"),
  logTitle: ok("Log scale", "R5 token.js U.chartPanel chart-scale-log title"),
  auto: ok("auto", "R5 token.js U.chartPanel chart-scale-auto"),
  autoTitle: ok("Auto-fit the price scale", "R5 token.js U.chartPanel chart-scale-auto title"),
  trades: ok("Trades", "R5 token.js U.lowerTabs lower-tab-trades; here the Display menu's row for the trade marks"),
  gridLines: { text: "Grid lines", source: "draft, card app-chart-controls: the Display menu's row (the live UNRLZD terminal's chart/display.ts)", draft: true },
  lastLine: { text: "Last price line", source: "draft, card app-chart-controls: the Display menu's row (the live UNRLZD terminal's chart/display.ts)", draft: true },
  indMA: { text: "MA", source: "draft, card app-chart-controls: the Indicators menu's row (the live UNRLZD terminal's chart/indicators.ts)", draft: true },
  indEMA: { text: "EMA", source: "draft, card app-chart-controls: the Indicators menu's row (the live UNRLZD terminal's chart/indicators.ts)", draft: true },
  indBOLL: { text: "BOLL", source: "draft, card app-chart-controls: the Indicators menu's row (the live UNRLZD terminal's chart/indicators.ts)", draft: true },
  indRSI: { text: "RSI", source: "draft, card app-chart-controls: the Indicators menu's row (the live UNRLZD terminal's chart/indicators.ts)", draft: true },
  indMACD: { text: "MACD", source: "draft, card app-chart-controls: the Indicators menu's row (the live UNRLZD terminal's chart/indicators.ts)", draft: true },
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
