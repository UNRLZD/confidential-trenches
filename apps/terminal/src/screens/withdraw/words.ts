// Every word the withdraw progress draws, each with where the owner OK'd it (the shape of src/screens/deposit/words.ts).
// A word the owner's lists do not hold yet is `draft: true`: drawn with data-draft-copy and listed in the card's report.
// Amounts, symbols, addresses and counters are data, not copy.
//
// The owner's lists: the signed CN rows of docs/spec/09-design-brief.md, the locked R5 prototype's own labels
// (design/proto/assets/app.js and private.js at design-lock-r5; a label R5 draws through P.dc is R5's draft copy and stays
// a draft here), and the owner's picks in docs/owner-decisions.md.

export interface Word {
  text: string;
  source: string;
  draft: boolean;
}

const ok = (text: string, source: string): Word => ({ text, source, draft: false });
const draft = (text: string, source: string): Word => ({ text, source, draft: true });

export const WORDS = {
  deposit: ok("Deposit", "R5 app.js:626 (dseg); src/screens/deposit/words.ts"),
  withdraw: ok("Withdraw", "R5 app.js:626 (dseg); src/screens/deposit/words.ts"),
  close: ok("Close", "owner 1 Nov 16:45Z (Keep the drafts); the close icon's accessible name only (never drawn)"),
  processing: ok("Processing", "R5 app.js:653 (S4.15); src/screens/deposit/words.ts"),
  sending: draft("Sending", "09-design-brief S12.11 [draft copy: Sending]"),
  sent: draft("Sent", "09-design-brief S12.14 [draft copy: Sent · 0.0995 SOL]; R5 private.js:144 (P.dc)"),
  refunded: draft("Refunded", "09-design-brief S12.15 [draft copy: Refunded]"),
  notSent: draft("Not sent", "app.md CH-123 (the kit's `stopped`: nothing moved; NEW state, words still the owner's)"),
  transaction: draft("Transaction", "R5 private.js:144 P.dc(\"Transaction\", \"CN-25\"); CN-25 still open"),
  done: draft("Done", "R5 private.js:145 (P.dc); 09-design-brief S12 Done (v2.0)"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
