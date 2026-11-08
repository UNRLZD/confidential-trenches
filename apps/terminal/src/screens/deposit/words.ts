// Every word the deposit sheet draws, each with where the owner OK'd it (the shape of src/screens/signin/words.ts). A
// word the owner's lists do not hold yet is `draft: true`: drawn with data-draft-copy and listed in the card's report.
// Numbers, amounts, symbols, chain names and addresses are data, not copy.
//
// The owner's lists: the signed CN rows of docs/spec/09-design-brief.md (CN-06, CN-07, CN-42; owner round 16,
// words-r12), the locked R5 prototype's own labels (design/proto/assets/app.js P.deposit at design-lock-r5; a label R5
// draws through P.dc is R5's draft copy and stays a draft here), and the owner's picks in docs/owner-decisions.md
// (owner-words-pass, 1 Nov 03:32Z; the new draft words, 1 Nov 16:45Z; the Nov 2 words page, 2 Nov 06:08Z, all approved).

export interface Word {
  text: string;
  source: string;
  draft: boolean;
}

const ok = (text: string, source: string): Word => ({ text, source, draft: false });
const draft = (text: string, source: string): Word => ({ text, source, draft: true });

export const WORDS = {
  deposit: ok("Deposit", "R5 app.js:626 (dseg); src/screens/signin/words.ts"),
  withdraw: ok("Withdraw", "R5 app.js:626 (dseg); src/screens/signin/words.ts"),
  account: ok("Account", "R5 deposit-1440.html:25 (drawer header)"),
  close: ok("Close", "owner 1 Nov 16:45Z (Keep the drafts); the close icon's accessible name only (never drawn)"),
  asset: ok("Asset", "CN-06, owner round 16"),
  chain: ok("Chain", "CN-06, owner round 16"),
  amount: ok("Amount", "CN-06, owner round 16"),
  min: ok("Min", "R5 app.js:632 (lim)"),
  quoting: ok("Quoting", "R5 app.js:637 (S4.2)"),
  getAddress: ok("Get address", "R5 app.js:665"),
  copy: ok("Copy", "R5 app.js:661"),
  waiting: ok("Waiting", "R5 app.js:652 (S4.13, S4.14)"),
  processing: ok("Processing", "R5 app.js:653 (S4.15)"),
  paused: ok("Deposits paused", "R5 app.js:640 (S4.8)"),
  deposited: ok("Deposited", "R5 app.js:656 (S4.16)"),
  expiresIn: ok("Expires in", "CN-07, owner round 16"),
  expired: ok("Address expired", "CN-42, owner round 16"),
  notAvailable: ok("Not available", "owner 1 Nov 16:45Z (Keep the drafts)"),
  backup: ok("Backup", "owner 1 Nov 16:45Z (Keep the drafts)"),
  retry: ok("Retry", "owner-words-pass (app-signpage-client)"),
  max: ok("Max", "owner 2 Nov 06:08Z, all approved; drafted from R5 app.js:632, drawn as draft copy (P.dc)"),
  youGet: ok("You get, about", "owner 2 Nov 06:08Z, all approved; drafted from R5 app.js:635-636, drawn as draft copy (P.dc)"),
  minimum: ok("Minimum", "owner 2 Nov 06:08Z, all approved; drafted from R5 app.js:635-636, drawn as draft copy (P.dc)"),
  fees: ok("Fees", "owner 2 Nov 06:08Z, all approved; drafted from R5 app.js:635-636, drawn as draft copy (P.dc)"),
  arrives: ok("Arrives", "owner 2 Nov 06:08Z, all approved; drafted from R5 app.js:635-636, drawn as draft copy (P.dc)"),
  done: ok("Done", "owner 2 Nov 06:08Z, all approved; drafted from R5 app.js:662, drawn as draft copy (P.dc)"),
  busy: ok("Busy", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S4.7 [draft copy: Busy · Retry]"),
  quoteRefused: ok("Quote refused", "owner 2 Nov 06:08Z, all approved; drafted from app.md FR-P8: the quote failed the signing page's check, no address (NEW state)"),
  short: ok("Short deposit", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S4.18 (CN-08 still open)"),
  refunded: ok("Refunded", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S4.17 [draft copy: Refunded · $X]"),
  refundedLine: ok("Refunded to this account, not to the wallet it came from.", "owner 2 Nov 06:08Z, all approved; drafted from app.md FR-D1 (S4.17's facts, CH-032)"),
  held: ok("Held", "owner 2 Nov 06:08Z, all approved; drafted from app.md FR-D3 and CH-119 (NEW state)"),
  heldLine: ok("This deposit couldn't reach your balance, so withdraw it to an address you choose.", "owner 2 Nov 06:08Z, all approved; drafted from app.md FR-D3 and CH-119"),
  recent: ok("Recent", "R5 app.js:641 (drecent), R5's own label in the picked design (card app-deposit-mount)"),
  noActivity: ok("No activity", "owner 2 Nov 06:08Z, all approved; the same word as src/screens/portfolio/words.ts noActivity"),
  // card deposit-to-pool (v2 A3): the To row's label, over the NEAR vault and the three pools (their names are data);
  // kept as drafted (the 8 Nov words page)
  to: ok("To", "owner 8 Nov 07:55Z, kept; drafted on card deposit-to-pool: the label over where the money goes (the NEAR vault, the Solana, Base and Robinhood pools)"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
