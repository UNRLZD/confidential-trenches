// Every word the trade box's buy side draws, each with where the owner OK'd it (the shape of src/screens/token/words.ts).
// A word the owner's lists do not hold yet is `draft: true`: drawn with data-draft-copy and listed in the card's report.
// Amounts, symbols, counters and fee values are data, not copy.
//
// The owner's lists: the signed CN rows and the `[owner: round 16]` picks of docs/spec/09-design-brief.md S8, the
// locked R5 prototype's own labels (research repo design/proto at design-lock-r5: assets/token.js U.ticket and
// trenches-1440.html's ticket; a label R5 draws through P.dc stays a draft), and src/screens/token/words.ts.
import { WORDS as PF } from "../portfolio/words.ts";

export interface Word {
  text: string;
  source: string;
  draft: boolean;
}

const ok = (text: string, source: string): Word => ({ text, source, draft: false });
const draft = (text: string, source: string): Word => ({ text, source, draft: true });

export const WORDS = {
  buy: ok("Buy", "R5 token.js U.ticket tk-side; src/screens/token/words.ts buy (the side switch and the main button's `Buy SYM`)"),
  sell: ok("Sell", "R5 token.js U.ticket tk-side; src/screens/token/words.ts sell"),
  bal: ok("Bal", "09-design-brief S8 Balance: `Bal` (CN-14, signed; v2.0.9, M165 (16))"),
  usd: ok("USD", "R5 token.js U.ticket tk-unit"),
  amountLabel: ok("Amount", "09-design-brief S8 Size: `Amount` (CN-13, signed; v2.0.10, M166 (14)); the field's accessible name only"),
  market: draft("Market", "09-design-brief S8 Order tabs [draft copy: Market]"),
  limit: draft("Limit", "09-design-brief S8 Order tabs [draft copy: Limit]"),
  tpsl: draft("TP/SL", "09-design-brief S8 Order tabs [draft copy: TP/SL]"),
  receive: draft("You receive", "09-design-brief S8 Estimate label [draft copy: You receive]"),
  max: draft("Max", "09-design-brief S8 Max [draft copy: Max $100] (the number is the chain's max buy)"),
  route: draft("Route & fees", "09-design-brief S8 Route & fees [draft copy: Route & fees]"),
  slippage: ok("Slippage", "09-design-brief S8 Slippage (CN-15, signed); the settings cell's accessible name only"),
  network: draft("Network", "09-design-brief S8 Network fee [draft copy: Network $0.02]; the settings cell's accessible name only"),
  fee: draft("Fee", "09-design-brief S8 Platform fee [draft copy: Fee 1%]; the settings cell's accessible name only"),
  // signed out (R5 trenches-1440.html ticket: `o.cta = "Sign in to trade"`, token-390.html the sheet's button; S8.1) and the
  // exit plan block's two lines (R5 token.js U.exitBlock, UNRLZD's own words; drawn off, its card turns it on)
  signInToTrade: draft("Sign in to trade", "09-design-brief S8.1 [draft copy: Sign in to trade]; R5 trenches-1440.html ticket and token-390.html sheet button"),
  exitPlan: ok("Exit plan", "R5 token.js U.exitBlock tk-blockHead; the toggle's accessible name too"),
  exitPlanSub: ok("Sells automatically once this buy fills", "R5 token.js U.exitBlock tk-blockHead"),
  // the safety grid under the box (R5 token.js U.riskGrid and app.js P.riskCells at design-lock-r5: UNRLZD's RiskGrid labels)
  top10: ok("Top 10 %", "R5 app.js P.riskCells"),
  dev: ok("Dev %", "R5 app.js P.riskCells"),
  snipers: ok("Snipers %", "R5 app.js P.riskCells"),
  holders: ok("Holders", "R5 app.js P.riskCells"),
  liq: ok("Liq", "R5 app.js P.riskCells"),
  age: ok("Age", "R5 app.js P.riskCells"),
  insiders: ok("Insiders", "R5 app.js P.riskCells"),
  tax: ok("Tax", "R5 app.js P.riskCells"),
  mintAuth: ok("Mint auth", "R5 app.js P.riskCells"),
  freezeAuth: ok("Freeze auth", "R5 app.js P.riskCells"),
  lp: ok("LP", "R5 app.js P.riskCells (CN-92, signed round 14)"),
  lpCurve: ok("Curve", "R5 app.js P.riskCells LP value (CN-92, signed round 14)"),
  honeypot: draft("Honeypot", "R5 token.js U.riskGrid, drawn through P.dc (owner round 15 brought it back)"),
  // the owner's approved entries for the same words (Portfolio's S10.12, owner 2 Nov 06:08Z): an approved word never
  // goes back to draft, so the buy and the sell side draw these, not drafts of their own (09-design-brief S8.9, S8.10)
  sending: PF.sending,
  landing: PF.landing,
  filled: draft("Filled", "09-design-brief S8.12 [draft copy: Filled 1.1s]"),
  slow: draft("Slow", "09-design-brief S8.11 [draft copy: Slow 6.2s] (the time is data)"),
  failed: draft("Failed", "09-design-brief S8.23 and S8.32 [draft copy: Failed · slippage]; the reason on its own line"),
  retry: draft("Retry", "09-design-brief S8.23 and S8.32 [draft copy: Retry]"),
  notLanded: draft("Not landed", "09-design-brief S8.36 [draft copy: Not landed]; S8.24's `· refunded` left out: no refund step, the money never left W (app.md CH-050)"),
  priceCheck: draft("Price check failed", "09-design-brief S8.20 [draft copy: Price check failed]; the kit's quote_check_failed"),
  notSent: draft("Not sent", "09-design-brief S8.28 [draft copy: Not sent]; the kit's signpage_down (never posted)"),
  filledOf: draft("filled", "app.md CH-045 (the filled part shown), after 09-design-brief S8.35 [draft copy: 2/3 sold]: `2/3 filled`"),
  soldOf: draft("sold", "09-design-brief S8.35 [draft copy: 2/3 sold]"),
  partFilled: draft("Part filled", "app.md CH-045 (set partly filled); drawn when the kit gives no count"),
  partSold: draft("Part sold", "09-design-brief S8.35, drawn when the kit gives no count"),
  // the pool's proof (card trade-box-pool, plan v2 A2): a terse label from state.pools, nothing drawn when none
  proofReady: draft("Proof ready", "card trade-box-pool (plan v2 A2): the chain's pool has a proof ready to buy"),
  proofMaking: draft("Making proof", "card trade-box-pool (plan v2 A2): notes landed, their first proof still being made"),
  // the buy route strip (card app-buy-route-strip): the spec's words (docs/drafts/buy-route-strip-spec.md, "Words on
  // screen", owner 3 Nov 10:11Z, the film's still) and the locked design's PV-01 and PV-02 (round-3 proposals, unsigned),
  // drafts until the owner's words page. "Private balance" is Portfolio's approved entry. The venue is data: the pool's
  // label is the venue's name and "pool"; `poolBare` is the label while no event has named the venue.
  privateBalance: PF.privateBalance,
  newWallet: draft("New one-time wallet", "buy-route-strip-spec.md Words on screen; design-lock-r5 P.pvTrade PV-02"),
  poolSuffix: draft("pool", "buy-route-strip-spec.md Words on screen: `<Venue> pool` (PV-03, the venue's name + ` pool`)"),
  final: draft("Final", "buy-route-strip-spec.md Words on screen: the tag beside Filled (S8.12)"),
  poolBare: draft("Pool", "card app-buy-route-strip: the pool step's label before an event names the venue (words-pending)"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
