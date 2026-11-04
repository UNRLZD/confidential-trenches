// Every word Portfolio (S10) and Activity (S14) draw, each with where the owner OK'd it (the shape of
// src/screens/deposit/words.ts). A word the owner's lists do not hold yet is `draft: true`: drawn with data-draft-copy and
// listed in the card's report. Amounts, symbols, percents, counts and dates are data, not copy.
//
// The owner's lists: the signed CN rows of docs/spec/09-design-brief.md (CN-09, CN-22, CN-25, CN-28, CN-64, CN-65,
// CN-100, CN-101, CN-102, CN-103, CN-116: owner round 16, M160 O1), the words other screens already carry with the
// owner's OK (src/screens/deposit/words.ts), and the owner's picks in docs/owner-decisions.md. A label the R5 prototype
// (design/proto/portfolio-1440.html, portfolio-390.html at design-lock-r5) draws through P.dc, P.pw or with no signed
// row is R5's draft and stays a draft here (M172: the prototype governs layout and look, the brief governs words) until
// the owner picks it: the Nov 2 words page took every such label as drafted (owner 2 Nov 06:08Z, all approved).

export interface Word {
  text: string;
  source: string;
  draft: boolean;
}

const ok = (text: string, source: string): Word => ({ text, source, draft: false });
const draft = (text: string, source: string): Word => ({ text, source, draft: true });

export const WORDS = {
  // signed
  total: ok("Total", "CN-100, words round 4, signed (M160 O1; M163 (2))"),
  token: ok("Token", "CN-22, signed (owner round 16)"),
  holding: ok("Holding", "CN-22, signed (owner round 16)"),
  value: ok("Value", "CN-22, signed (owner round 16)"),
  pnl: ok("PnL", "CN-22, signed (owner round 16)"),
  realized: ok("Realized", "CN-22, signed (owner round 16)"),
  tpsl: ok("TP/SL", "CN-22, signed (owner round 16)"),
  h24: ok("24h", "CN-09, signed (owner round 16)"),
  search: ok("Search", "CN-101 and CN-103, signed (words round 4)"),
  hideSmall: ok("Hide small", "CN-102, signed (words round 4)"),
  minSize: ok("Min size", "CN-103, signed (words round 4)"),
  feesPaid: ok("Fees paid", "CN-116, signed (words round 4)"),
  kBuy: ok("Buy", "CN-28, signed (owner round 16)"),
  kSell: ok("Sell", "CN-28, signed (owner round 16)"),
  kDeposit: ok("Deposit", "CN-28, signed (owner round 16); src/screens/deposit/words.ts"),
  kWithdraw: ok("Withdraw", "CN-28, signed (owner round 16); src/screens/deposit/words.ts"),
  kExport: ok("Export", "CN-28, signed (owner round 16)"),
  receipt: ok("Receipt", "CN-28, signed (owner round 16)"),
  tx: ok("Tx ↗", "CN-25, signed (owner round 16)"),
  keyExported: ok("Key exported", "CN-64, signed (owner round 16)"),
  viewKey: ok("View key", "CN-65, signed (owner round 16)"),
  deposit: ok("Deposit", "R5 app.js:626 (dseg); src/screens/deposit/words.ts"),
  withdraw: ok("Withdraw", "R5 app.js:626 (dseg); src/screens/deposit/words.ts"),
  processing: ok("Processing", "R5 app.js:653 (S4.15); src/screens/deposit/words.ts"),
  refunded: ok("Refunded", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S4.17 / S12.15 [draft copy: Refunded]"),
  more: draft("More", "the row overflow button's accessible name only (never drawn; R5 draws the icon)"),
  close: ok("Close", "owner 1 Nov 16:45Z (Keep the drafts); the close icon's accessible name only (never drawn)"),
  // drafts: the brief's [draft copy: ...] rows
  cash: ok("Cash", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 PnL header [draft copy: Cash]"),
  unrealized: ok("Unrealized", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 PnL header [draft copy: Unrealized]"),
  realized30: ok("Realized · 30d", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 PnL header [draft copy: Realized · 30d]"),
  returnPerTrade: ok("Return per trade", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 PnL header [draft copy: Return per trade]"),
  winRate: ok("win rate", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 PnL header [draft copy: win rate]"),
  r1D: ok("1D", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 [draft copy: 1D]"),
  r1W: ok("1W", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 [draft copy: 1W]"),
  r1M: ok("1M", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 [draft copy: 1M]"),
  rAll: ok("All", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 [draft copy: All]"),
  open: ok("Open", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 Open / Closed [draft copy: Open]"),
  closed: ok("Closed", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 Open / Closed [draft copy: Closed]"),
  bought: ok("Bought", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 row columns [draft copy: Bought]"),
  sold: ok("Sold", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 row columns [draft copy: Sold]"),
  sell: ok("Sell", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 row actions [draft copy: Sell]"),
  export: ok("Export", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 row actions [draft copy: Export]"),
  share: ok("Share", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 Share [draft copy: Share]"),
  initials: ok("Initials", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10 row quick sells (Initials), R5 portfolio-390.html S10.13"),
  exitPlan: ok("Exit plan", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10.13 (Exit plan), R5 portfolio-390.html S10.13"),
  noPositions: ok("No positions", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10.2 [draft copy: No positions]"),
  offline: ok("Offline", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10.5 [draft copy: Offline]"),
  noRoute: ok("No route", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10.6 [draft copy: No route]"),
  reverted: ok("Reverted", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10.7 [draft copy: Reverted]"),
  held: ok("Held", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10.8 [draft copy: Held]"),
  sending: ok("Sending", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10.12 (Sending)"),
  landing: ok("Landing", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S10.12 (Landing 0.5s)"),
  noActivity: ok("No activity", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S14.1 [draft copy: No activity]"),
  today: ok("Today", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S14 day headers [draft copy: Today]"),
  yesterday: ok("Yesterday", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S14 day headers [draft copy: Yesterday]"),
  notRestorable: ok("Older history not restorable", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S14.3 [draft copy: Older history not restorable]"),
  // drafts: R5's own labels (P.dc / P.pw / unsigned), CN-136 still open
  whereItIs: ok("Where it is", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html P.pw(\"Where it is\", \"PV-36\"); CN-136 open"),
  positions: ok("Positions", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html (table title, tile); CN-136 open"),
  onTheWay: ok("On the way", "owner 2 Nov 06:08Z, all approved; drafted from R5 private.js pvEquity; CN-136 open"),
  activity: ok("Activity", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html P.dc(\"Activity\"); 09-design-brief S14 base"),
  allocation: ok("Allocation", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html P.dc(\"Allocation\")"),
  orders: ok("Orders", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-390.html msegs; 09-design-brief S10 phone segments"),
  stats: ok("Stats", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-390.html msegs; 09-design-brief S10 phone segments"),
  howYouTrade: ok("How you trade", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html P.dc(\"How you trade\")"),
  closedTrades: ok("closed trades", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html P.dc(\"closed trades\")"),
  avgWin: ok("Avg win", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html P.dc(\"Avg win\")"),
  avgLoss: ok("Avg loss", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html P.dc(\"Avg loss\")"),
  avgHold: ok("Avg hold", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html P.dc(\"Avg hold\")"),
  greenDays: ok("green days", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html P.dc(\"green days\")"),
  red: ok("red", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html P.dc(\"red\")"),
  heldFor: ok("Held", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html table column P.dc(\"Held\") (time held)"),
  addExit: ok("Add exit plan", "owner 2 Nov 06:08Z, all approved; drafted from R5 portfolio-1440.html (the EXITIC tile's label)"),
  // card balances-per-chain (v2 A1), the per-chain pool rows: kept as drafted with their placement (owner 3 Nov 09:17Z)
  privateBalance: ok("Private balance", "owner 3 Nov 09:17Z, keep; drafted on card balances-per-chain; R5 portfolio-1440.html round 3 note (owner round 15) names \"private balance\""),
  balance: ok("Balance", "owner 3 Nov 09:17Z, keep; drafted on card balances-per-chain; approved on Verify (src/screens/verify/words.ts balance, owner 2 Nov 06:08Z), new on this screen"),
  ready: ok("Ready", "owner 3 Nov 09:17Z, keep; drafted on card balances-per-chain: the part with a proof ready to buy"),
  pending: ok("Pending", "owner 3 Nov 09:17Z, keep; drafted on card balances-per-chain: the part still being proved"),
  noBalance: ok("No balance", "owner 3 Nov 09:17Z, keep; drafted on card balances-per-chain: no pool holds anything"),
  // card app-export-every-wallet: drafts in research board/words-pending.json until the owner's next picks page
  exportKey: draft("Export key", "card app-export-every-wallet draft: the export icon's hover label and accessible name (words-pending)"),
  wallets: draft("Wallets", "card app-export-every-wallet draft: the heading over the wallets that hold money and no position (words-pending)"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
