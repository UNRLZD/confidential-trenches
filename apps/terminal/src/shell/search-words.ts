// Every word the top bar's search draws (card app-header-search-chain), each with where the owner OK'd it (the shape of
// ../screens/discover/words.ts). The terminal's own words are its screens' entries themselves, so a pick changes them
// everywhere; R5's own labels (research repo design/proto/assets/app.js P.topbar, P.chainChip and P.phHeader at
// design-lock-r5) are kept; a word R5 marks as draft copy (P.dc) or lists to confirm is `draft: true`, drawn with
// data-draft-copy and listed in the card's report. Chain names are the chain table's (../screens/market/pads.ts), token
// symbols and names are data.
import { WORDS as DISCOVER } from "../screens/discover/words.ts";
import { WORDS as PORTFOLIO } from "../screens/portfolio/words.ts";
import { WORDS as TOKEN } from "../screens/token/words.ts";

export interface Word {
  text: string;
  source: string;
  draft: boolean;
}

export const WORDS = {
  placeholder: { text: "Name, symbol or address", source: "draft, card app-header-search-chain: R5 app.js P.topbar .sph P.dc(\"Name, symbol or address\", \"CN-10\")", draft: true },
  // the field's, the icon button's and the phone button's accessible name (R5 aria-label="Search"), Portfolio's signed word
  search: PORTFOLIO.search,
  all: { text: "All", source: "R5 app.js P.chainChip (`chainLabel || \"All\"`)", draft: false },
  noResults: { text: "No results", source: "draft, card app-header-search-chain: R5 REVIEW.md Words to confirm (round 4) CN-95 `No results` (S5.13, the search's empty state)", draft: true },
  trending: DISCOVER.colTrending,
  mc: DISCOVER.mc,
  loading: DISCOVER.loading,
  offline: DISCOVER.offline,
  retry: DISCOVER.retry,
  back: TOKEN.back,
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
