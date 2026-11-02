// Every word the trade box's buy side draws, each with where the owner OK'd it (the shape of src/screens/token/words.ts).
// A word the owner's lists do not hold yet is `draft: true`: drawn with data-draft-copy and listed in the card's report.
// Amounts, symbols, counters and fee values are data, not copy.
//
// The owner's lists: the signed CN rows and the `[owner: round 16]` picks of docs/spec/09-design-brief.md S8, the
// locked R5 prototype's own labels (research repo design/proto at design-lock-r5: assets/token.js U.ticket and
// trenches-1440.html's ticket; a label R5 draws through P.dc stays a draft), and src/screens/token/words.ts.

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
  sending: draft("Sending", "09-design-brief S8.9 [draft copy: Sending]"),
  landing: draft("Landing", "09-design-brief S8.10 [draft copy: Landing 0.4s]"),
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
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
