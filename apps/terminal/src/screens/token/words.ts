// Every word the token page draws, each with where the owner OK'd it (the shape of src/screens/discover/words.ts). A
// word the owner's lists do not hold yet is `draft: true`: drawn with data-draft-copy and listed in the card's report.
// Numbers, symbols, token names, launchpad ids and timeframe codes are data, not copy.
//
// The owner's lists: the locked R5 prototype's own labels (research repo design/proto at design-lock-r5:
// assets/token.js U.header and U.about, token-390.html's tiles, bar and timeframes) and owner-words-pass
// (docs/owner-decisions.md:351), and the new draft words (owner 1 Nov 16:45Z, keep).

import { WORDS as DISCOVER } from "../discover/words.ts";

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
  // (and trenches-1440.html's clock); the menus' rows R5 does not draw were kept as drafted (the 8 Nov words page)
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
  gridLines: ok("Grid lines", "owner 8 Nov 07:55Z, kept; drafted on card app-chart-controls: the Display menu's row (the live UNRLZD terminal's chart/display.ts)"),
  lastLine: ok("Last price line", "owner 8 Nov 07:55Z, kept; drafted on card app-chart-controls: the Display menu's row (the live UNRLZD terminal's chart/display.ts)"),
  indMA: ok("MA", "owner 8 Nov 07:55Z, kept; drafted on card app-chart-controls: the Indicators menu's row (the live UNRLZD terminal's chart/indicators.ts)"),
  indEMA: ok("EMA", "owner 8 Nov 07:55Z, kept; drafted on card app-chart-controls: the Indicators menu's row (the live UNRLZD terminal's chart/indicators.ts)"),
  indBOLL: ok("BOLL", "owner 8 Nov 07:55Z, kept; drafted on card app-chart-controls: the Indicators menu's row (the live UNRLZD terminal's chart/indicators.ts)"),
  indRSI: ok("RSI", "owner 8 Nov 07:55Z, kept; drafted on card app-chart-controls: the Indicators menu's row (the live UNRLZD terminal's chart/indicators.ts)"),
  indMACD: ok("MACD", "owner 8 Nov 07:55Z, kept; drafted on card app-chart-controls: the Indicators menu's row (the live UNRLZD terminal's chart/indicators.ts)"),
  // the lower panel and About (card app-token-lower-panel), R5 token.js U.lowerTabs, U.tradesTab, U.holdersTab and
  // U.about at design-lock-r5: R5's own labels are kept; the ones R5 marks as draft copy (P.dc) are drafts here.
  // The tabs reuse `holders` and `trades`, the MC column `mc`, the rows' sides `buy` and `sell`, the top share `top10`,
  // an empty tab `noData`.
  buyShort: ok("B", "R5 token.js U.tradesTab lp-short (the phone's side column)"),
  sellShort: ok("S", "R5 token.js U.tradesTab lp-short (the phone's side column)"),
  burnSub: ok("Burn · not circulating", "R5 token.js U.holdersTab lp-sub (`${kind} · not circulating`, kind burn: `Burn`)"),
  flowBuys: ok("buys", "R5 token.js U.about tk-flowLbl"),
  flowSells: ok("sells", "R5 token.js U.about tk-flowLbl"),
  colAge: { text: "Age", source: "draft, card app-token-lower-panel: R5 token.js U.tradesTab P.dc(\"Age\", \"CN-113\")", draft: true },
  colType: { text: "Type", source: "draft, card app-token-lower-panel: R5 token.js U.tradesTab P.dc(\"Type\", \"CN-113\")", draft: true },
  colBs: { text: "B/S", source: "draft, card app-token-lower-panel: R5 token.js U.tradesTab P.dc(\"B/S\", \"CN-113\")", draft: true },
  colAmount: { text: "Amount", source: "draft, card app-token-lower-panel: R5 token.js U.tradesTab P.dc(\"Amount\", \"CN-09\")", draft: true },
  colTotal: { text: "Total $", source: "draft, card app-token-lower-panel: R5 token.js U.tradesTab P.dc(\"Total $\", \"CN-09\")", draft: true },
  colTrader: { text: "Trader", source: "draft, card app-token-lower-panel: R5 token.js U.tradesTab and U.holdersTab P.dc(\"Trader\")", draft: true },
  colPosition: { text: "Position", source: "draft, card app-token-lower-panel: R5 token.js U.holdersTab P.dc(\"Position\", \"CN-09\")", draft: true },
  colShare: { text: "Share of supply", source: "draft, card app-token-lower-panel: R5 token.js U.holdersTab P.dc(\"Share of supply\", \"CN-09\")", draft: true },
  creatorTag: { text: "CREATOR", source: "draft, card app-token-lower-panel: R5 token.js TAG.dev P.dc(\"CREATOR\")", draft: true },
  about: { text: "About", source: "draft, card app-token-lower-panel: R5 token.js U.about P.dc(`About ${sym}`, \"CN-112\"), the symbol after it is data", draft: true },
  vol5m: { text: "5m vol", source: "draft, card app-token-lower-panel: R5 token.js U.about P.dc(\"5m vol\", \"CN-107\")", draft: true },
  buys5m: { text: "Buys", source: "draft, card app-token-lower-panel: R5 token.js U.about P.dc(\"Buys\", \"CN-107\")", draft: true },
  sells5m: { text: "Sells", source: "draft, card app-token-lower-panel: R5 token.js U.about P.dc(\"Sells\", \"CN-107\")", draft: true },
  net5m: { text: "Net", source: "draft, card app-token-lower-panel: R5 token.js U.about P.dc(\"Net\", \"CN-107\")", draft: true },
  // the left rail (card app-token-rail): Discover's own words for its lists and states, the same entries, so a pick
  // changes both screens; the slim rail's button is R5's (trenches-1440.html rail-expand aria-label)
  railTrending: DISCOVER.colTrending,
  railNew: DISCOVER.colNew,
  noTokens: DISCOVER.noTokens,
  expand: ok("Expand", "R5 trenches-1440.html rail-expand aria-label"),
  // the rail's parity pass with the live UNRLZD trenches rail (owner 12 Nov: "its UI/UX, the little details, on par with
  // the main product"): UNRLZD's own words for the same controls (its rail Rail.tsx, model.ts RAIL_CHIPS, FilterBar SORT_META)
  railTokens: ok("Tokens", "UNRLZD trenches rail tab (owner 12 Nov parity)"),
  railWatch: ok("Watchlist", "UNRLZD trenches rail chip (owner 12 Nov parity)"),
  railHot: DISCOVER.colHot,
  railGrad: DISCOVER.colGraduating,
  collapse: ok("Collapse", "UNRLZD trenches rail collapse aria-label (owner 12 Nov parity)"),
  pause: ok("Pause the list", "UNRLZD trenches rail pause aria-label (owner 12 Nov parity)"),
  resume: ok("Resume the list", "UNRLZD trenches rail pause aria-label, pressed (owner 12 Nov parity)"),
  paused: ok("Paused", "UNRLZD trenches rail pause pill (owner 12 Nov parity)"),
  sort: ok("Sort", "UNRLZD trenches rail sort button (owner 12 Nov parity)"),
  sortLiq: ok("Liquidity", "UNRLZD FilterBar SORT_META liq (owner 12 Nov parity)"),
  sortVol: ok("24h vol", "UNRLZD FilterBar SORT_META vol24 (owner 12 Nov parity)"),
  sortAge: ok("Age", "UNRLZD FilterBar SORT_META age (owner 12 Nov parity)"),
  sortChg: ok("24h change", "UNRLZD FilterBar SORT_META chg (owner 12 Nov parity)"),
  sortCurve: ok("Curve", "UNRLZD FilterBar SORT_META prog (owner 12 Nov parity)"),
  sortHolders: ok("Holders", "UNRLZD FilterBar SORT_META holders (owner 12 Nov parity)"),
  sortDefault: ok("Default", "UNRLZD trenches rail SortMenu, the no-sort item off Trending (FilterBar.tsx; owner 12 Nov parity)"),
  watchEmpty: ok("Star a token to keep it here.", "UNRLZD trenches rail Watchlist empty state (owner 12 Nov parity)"),
  board: ok("Open launch board", "UNRLZD trenches rail footer link (owner 12 Nov parity)"),
  mcLong: ok("Market cap", "UNRLZD trenches header tile (owner 12 Nov parity)"),
  vol24: ok("24h vol", "UNRLZD trenches header tile (owner 12 Nov parity)"),
  // About's parity pass (UNRLZD ticket AboutPanel.tsx: the origin line, the curve or liquidity block, the flows, the links)
  launchedOn: ok("Launched on {pad}", "UNRLZD AboutPanel launched line (owner 12 Nov parity)"),
  launchedBy: ok("Launched by {creator}", "UNRLZD AboutPanel launched line, no launchpad (owner 12 Nov parity)"),
  by: ok("by", "UNRLZD AboutPanel launched line (owner 12 Nov parity)"),
  curveProgress: ok("Curve", "UNRLZD FilterBar SORT_META prog (owner 12 Nov parity)"),
  website: ok("Website", "UNRLZD AboutPanel links (owner 12 Nov parity)"),
  twitter: ok("Twitter", "UNRLZD AboutPanel links (owner 12 Nov parity)"),
  telegram: ok("Telegram", "UNRLZD AboutPanel links (owner 12 Nov parity)"),
  phoneTrenches: ok("Trenches", "UNRLZD mobile Trenches title (mobile/trenches/Trenches.tsx; owner 12 Nov: phone home is the Trenches list)"),
  phoneLive: ok("LIVE", "UNRLZD mobile Trenches title row (owner 12 Nov parity)"),
  phoneToken: ok("Token", "UNRLZD mobile Trenches sort row (mobile/trenches/TokensView.tsx; owner 12 Nov parity)"),
  // the chart's drawing toolbar (draw/), UNRLZD's own words
  dTrend: ok("Trend line", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dRay: ok("Ray", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dExtended: ok("Extended line", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dHline: ok("Horizontal line", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dHray: ok("Horizontal ray", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dVline: ok("Vertical line", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dChannel: ok("Parallel channel", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dFib: ok("Fib retracement", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dRect: ok("Rectangle", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dMeasure: ok("Measure", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dText: ok("Text note", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dArrowUp: ok("Arrow up", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dArrowDown: ok("Arrow down", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dCross: ok("Cross", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dDot: ok("Dot", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dArrow: ok("Arrow", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dMagnetOff: ok("Magnet off", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dMagnetWeak: ok("Weak magnet", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dMagnetStrong: ok("Strong magnet", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dLines: ok("Lines", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dShapes: ok("Shapes", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dMarks: ok("Marks", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dTools: ok("Drawing tools", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dHideTools: ok("Hide drawing tools", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dCrosshair: ok("Crosshair", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dLock: ok("Lock all drawings", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dUnlock: ok("Unlock drawings", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dHide: ok("Hide all drawings", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dShow: ok("Show drawings", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dDeleteAll: ok("Delete all drawings", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dNote: ok("Note", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dNoteText: ok("Note text", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  dNotePlaceholder: ok("Text", "UNRLZD chart drawing toolbar (screens/trenches/center/chart/draw; owner 12 Nov: chart drawing tools)"),
  // the lower panel's My orders tab (card app-orders-coming-soon): orders are out of the plan for now
  tradesPause: ok("Pause", "UNRLZD center/TradesTab.tsx trades-pause (owner 12 Nov parity)"),
  pausedNew: ok("· {n} new", "UNRLZD center/TradesTab.tsx trades-paused: the trades that arrived while paused"),
  myOrders: ok("My orders", "R5 token.js U.lowerTabs lower-tab-orders and token-390.html m-tab-lower-orders"),
  soon: ok("Coming soon", "owner 10 Nov, owner-decisions row \"Order of the returned feature groups\": orders are out of the plan for now, the UI says Coming soon (card app-orders-coming-soon)"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
