// Every word Discover draws, in one table, each with where the owner OK'd it. A word the owner's lists do not hold yet
// is `draft: true`: it is drawn with data-draft-copy on its element and listed in the card's report for the owner's
// pick; a pick changes only its text here. Numbers, symbols, token names and launchpad ids are data, not copy.
//
// The owner's lists: the column names of owner round 15 (research repo docs/owner-decisions.md:174, dr2-discover:
// "the columns are New, Trending, Hot and Graduating"), CN-09 (`Price` `MC` `Vol`, signed; 09-design-brief S5 Row),
// owner-words-pass (owner-decisions.md:351) and the locked R5 prototype's own labels (design/proto/assets/app.js and
// discover-ui.js at design-lock-r5), and the new draft words (owner 1 Nov 16:45Z, keep).

export interface Word {
  text: string;
  /** Where the owner OK'd it, or for a draft the paper that asks for it. */
  source: string;
  /** True until the owner picks it. */
  draft: boolean;
}

const ok = (text: string, source: string): Word => ({ text, source, draft: false });
const draft = (text: string, source: string): Word => ({ text, source, draft: true });

export const WORDS = {
  discover: ok("Discover", "R5 app.js nav (S1 top bar) and discover-1440.html title"),
  colNew: ok("New", "owner round 15 (dr2-discover)"),
  colTrending: ok("Trending", "owner round 15 (dr2-discover)"),
  colHot: ok("Hot", "owner round 15 (dr2-discover)"),
  colGraduating: ok("Graduating", "owner round 15 (dr2-discover)"),
  mc: ok("MC", "CN-09 (signed); R5 discover-ui.js dd-mcLabel"),
  vol: ok("V", "R5 discover-ui.js dd-volLabel (`V 5m`)"),
  price: ok("Price", "CN-09 (signed); the MC cell's hover"),
  pool: ok("POOL", "R5 app.js P.stageOf pill"),
  dev: ok("dev", "R5 discover-ui.js P.rowM (phone row: `dev 5.0%`)"),
  top10: ok("Top 10 holders", "R5 discover-ui.js metric pill hover"),
  creatorHolds: ok("Creator holds", "R5 discover-ui.js metric pill hover"),
  snipers: ok("Sniper wallets", "R5 discover-ui.js metric pill hover"),
  notChecked: ok("not checked", "R5 discover-ui.js metric pill hover (`<label>: not checked`)"),
  holders: ok("Holders", "R5 discover-ui.js phone row hover"),
  retry: ok("Retry", "owner-words-pass (app-signpage-client)"),
  noTokens: ok("No tokens", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S5.3 Empty [draft copy: No tokens]"),
  offline: ok("Offline", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S5.5 Offline [draft copy: Offline]"),
  loading: ok("Loading", "owner 1 Nov 16:45Z, keep; drafted from S5.1 skeleton rows: the list's accessible name only (never drawn)"),
  // {age} is data (listAge: 1m, 12m, 2h, 3d); the owner's pick changes only the words around it
  updated: ok("Updated {age} ago", "owner 8 Nov 07:55Z, kept; drafted on card app-list-age: Discover's list header, right side, muted, only when the helper's list is older than 60 s"),
  // the toolbar (card app-discover-toolbar): R5 discover-1440.html and discover-390.html's own labels (live UNRLZD's
  // Toolbar.tsx words, M160 N8), and round 4's signed CN-93, CN-94 and CN-95 (owner-decisions.md:189 words-r4)
  all: ok("All", "R5 discover-1440.html presets and discover-390.html chips"),
  fewerFlags: ok("Fewer flags", "R5 discover-1440.html presets and discover-390.html chips"),
  mc10k: ok("MC ≥ $10K", "R5 discover-1440.html chip-minMc"),
  launchpad: ok("Launchpad", "R5 discover-1440.html chip-launchpad and discover-390.html m-filter-launchpad"),
  launchpads: ok("Launchpads", "R5 discover-1440.html launchpad-menu aria-label (never drawn)"),
  padMenuTitle: ok("Launchpads by tokens now", "8 Nov 19:40Z, kept as drawn; drawn from R5 discover-1440.html launchpad-menu title, P.dc DV-13: CN-137 (09-design-brief §11.1), not signed"),
  clear: ok("Clear", "CN-93 reset (words-r4, signed); R5 discover-1440.html launchpad-clear"),
  quickBuy: ok("Quick buy", "R5 discover-1440.html discover-qb and discover-390.html m-dock"),
  usd: ok("USD", "R5 discover-1440.html discover-qb unit"),
  qbAmount: ok("Quick buy amount in USD", "R5 discover-1440.html discover-qb-amount aria-label (never drawn)"),
  search: ok("Search", "CN-94 (words-r4, signed); R5 col-search aria-label `Search <column>`"),
  clearSearch: ok("Clear search", "R5 discover-1440.html S5.14 column search aria-label (never drawn)"),
  noResults: ok("No results", "CN-95 (words-r4, signed); R5 S5.13"),
  pause: ok("Pause", "R5 discover-390.html m-pause"),
  resume: ok("Resume", "R5 discover-390.html m-pause (S5.8)"),
  paused: ok("Paused", "R5 discover-ui.js colHead pause pill"),
  // {n} is data (the count of new tokens held back)
  pausedNew: ok("Paused · {n} new", "R5 discover-390.html S5.8 `Paused · 3 new`; 09-design-brief S5 Pause"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

/** The words still waiting for the owner's pick. */
export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);

/** The list's age line: the `updated` words with the age in them. */
export const ageLine = (age: string): string => WORDS.updated.text.replace("{age}", age);
