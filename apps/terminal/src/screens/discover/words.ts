// Every word Discover draws, in one table, each with where the owner OK'd it. A word the owner's lists do not hold yet
// is `draft: true`: it is drawn with data-draft-copy on its element and listed in the card's report for the owner's
// pick; a pick changes only its text here. Numbers, symbols, token names and launchpad ids are data, not copy.
//
// The owner's lists: the column names of owner round 15 (research repo docs/owner-decisions.md:174, dr2-discover:
// "the columns are New, Trending, Hot and Graduating"), CN-09 (`Price` `MC` `Vol`, signed; 09-design-brief S5 Row),
// owner-words-pass (owner-decisions.md:351) and the locked R5 prototype's own labels (design/proto/assets/app.js and
// discover-ui.js at design-lock-r5).

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
  noTokens: draft("No tokens", "09-design-brief S5.3 Empty [draft copy: No tokens]"),
  offline: draft("Offline", "09-design-brief S5.5 Offline [draft copy: Offline]"),
  loading: draft("Loading", "S5.1 skeleton rows: the list's accessible name only (never drawn)"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

/** The words still waiting for the owner's pick. */
export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
