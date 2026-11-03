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
  curve: ok("Bonding curve", "R5 token.js U.about tk-curve"),
  h24: ok("24h", "R5 token-390.html mt-h24"),
  sell: ok("Sell", "R5 token-390.html mb-sell"),
  buy: ok("Buy", "R5 token-390.html mb-buy (`Buy SYM`)"),
  chart: ok("Chart", "R5 token.js chart panel, the area's accessible name only (never drawn)"),
  retry: ok("Retry", "owner-words-pass (app-signpage-client)"),
  loading: ok("Loading", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S7.1 skeleton: the page's accessible name only (never drawn); as Discover's"),
  offline: ok("Offline", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S5.5 [draft copy: Offline], as Discover's error state"),
  noToken: ok("No token", "owner 1 Nov 16:45Z, keep; drafted from card app-token-page: the empty state (no token to draw)"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
