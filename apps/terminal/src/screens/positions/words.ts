// Every word the sell side and Your position draw, each with where the owner OK'd it (the shape of
// src/screens/trade/words.ts). A word another screen already carries is that screen's own entry, not a copy. A word the
// owner's lists do not hold yet is `draft: true`: drawn with data-draft-copy and listed in the card's report. Amounts,
// symbols, percents and counters are data, not copy.
//
// The owner's lists: 09-design-brief S8 (the Sell tab, Sell presets and Your position rows), the locked R5 prototype's
// labels (research repo design/proto at design-lock-r5: assets/token.js U.ticket at S8.29 and U.position), and the words
// of src/screens/trade/words.ts and src/screens/portfolio/words.ts.
import { WORDS as PF } from "../portfolio/words.ts";
import { WORDS as TR } from "../trade/words.ts";

export interface Word {
  text: string;
  source: string;
  draft: boolean;
}

const ok = (text: string, source: string): Word => ({ text, source, draft: false });
const draft = (text: string, source: string): Word => ({ text, source, draft: true });

export const WORDS = {
  // the trade box's own
  buy: TR.buy,
  sell: TR.sell,
  market: TR.market,
  limit: TR.limit,
  tpsl: TR.tpsl,
  receive: TR.receive,
  route: TR.route,
  slippage: TR.slippage,
  network: TR.network,
  fee: TR.fee,
  sending: PF.sending,
  landing: PF.landing,
  filled: TR.filled,
  // Portfolio's own (CN-22 and the 2 Nov words page)
  holding: PF.holding,
  bought: PF.bought,
  sold: PF.sold,
  realized: PF.realized,
  initials: PF.initials,
  share: PF.share,
  noRoute: PF.noRoute,
  // new here
  // the pool path (card trade-box-pool): the sell's proceeds go back into the chain's pool, the user's Cash
  toPool: ok("Back to Cash", "owner 8 Nov 07:55Z, kept; drafted on card trade-box-pool (plan v2 A2): pool.sell deposits the proceeds into the pool in the same transaction"),
  held: draft("held", "R5 token.js U.ticket at S8.29, the balance slot (trenches-1440.html: `${fmtK(tokens)} ${sym} held`)"),
  sellCta: draft("Sell", "09-design-brief S8 main button [draft copy: Sell 50%] (the percent is data)"),
  percent: draft("Percent of your bag", "R5 token.js U.ticket amount input aria-label (sell side); 09-design-brief S8 Sell tab [copy needed: CN-16, the custom % field]; the field's accessible name only"),
  yourPosition: draft("Your position", "09-design-brief S8 Your position [draft copy: Your position]; R5 token.js U.position"),
  unrealizedPnl: draft("Unrealized PnL", "R5 token.js U.position tk-posHero label"),
  totalPnl: draft("Total PnL", "R5 token.js U.position, the row under the rule"),
  avgEntry: draft("Avg entry", "R5 token.js U.position tk-posMeta"),
  heldFor: draft("Held for", "R5 token.js U.position tk-posMeta"),
  all: draft("All", "09-design-brief S8 Your position quick sells [draft copy: All]; R5 token.js U.position tk-quick"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
