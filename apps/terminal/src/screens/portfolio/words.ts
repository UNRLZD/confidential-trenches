// Every word Portfolio (S10) and Activity (S14) draw, each with where the owner OK'd it (the shape of
// src/screens/deposit/words.ts). A word the owner's lists do not hold yet is `draft: true`: drawn with data-draft-copy and
// listed in the card's report. Amounts, symbols, percents, counts and dates are data, not copy.
//
// The owner's lists: the signed CN rows of docs/spec/09-design-brief.md (CN-09, CN-22, CN-25, CN-28, CN-64, CN-65,
// CN-100, CN-101, CN-102, CN-103, CN-116: owner round 16, M160 O1), the words other screens already carry with the
// owner's OK (src/screens/deposit/words.ts), and the owner's picks in docs/owner-decisions.md. A label the R5 prototype
// (design/proto/portfolio-1440.html, portfolio-390.html at design-lock-r5) draws through P.dc, P.pw or with no signed
// row is R5's draft and stays a draft here (M172: the prototype governs layout and look, the brief governs words).

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
  refunded: draft("Refunded", "09-design-brief S4.17 / S12.15 [draft copy: Refunded]"),
  more: draft("More", "the row overflow button's accessible name only (never drawn; R5 draws the icon)"),
  close: ok("Close", "owner 1 Nov 16:45Z (Keep the drafts); the close icon's accessible name only (never drawn)"),
  // drafts: the brief's [draft copy: ...] rows
  cash: draft("Cash", "09-design-brief S10 PnL header [draft copy: Cash]"),
  unrealized: draft("Unrealized", "09-design-brief S10 PnL header [draft copy: Unrealized]"),
  realized30: draft("Realized · 30d", "09-design-brief S10 PnL header [draft copy: Realized · 30d]"),
  returnPerTrade: draft("Return per trade", "09-design-brief S10 PnL header [draft copy: Return per trade]"),
  winRate: draft("win rate", "09-design-brief S10 PnL header [draft copy: win rate]"),
  r1D: draft("1D", "09-design-brief S10 [draft copy: 1D]"),
  r1W: draft("1W", "09-design-brief S10 [draft copy: 1W]"),
  r1M: draft("1M", "09-design-brief S10 [draft copy: 1M]"),
  rAll: draft("All", "09-design-brief S10 [draft copy: All]"),
  open: draft("Open", "09-design-brief S10 Open / Closed [draft copy: Open]"),
  closed: draft("Closed", "09-design-brief S10 Open / Closed [draft copy: Closed]"),
  bought: draft("Bought", "09-design-brief S10 row columns [draft copy: Bought]"),
  sold: draft("Sold", "09-design-brief S10 row columns [draft copy: Sold]"),
  sell: draft("Sell", "09-design-brief S10 row actions [draft copy: Sell]"),
  export: draft("Export", "09-design-brief S10 row actions [draft copy: Export]"),
  share: draft("Share", "09-design-brief S10 Share [draft copy: Share]"),
  initials: draft("Initials", "09-design-brief S10 row quick sells (Initials), R5 portfolio-390.html S10.13"),
  exitPlan: draft("Exit plan", "09-design-brief S10.13 (Exit plan), R5 portfolio-390.html S10.13"),
  noPositions: draft("No positions", "09-design-brief S10.2 [draft copy: No positions]"),
  offline: draft("Offline", "09-design-brief S10.5 [draft copy: Offline]"),
  noRoute: draft("No route", "09-design-brief S10.6 [draft copy: No route]"),
  reverted: draft("Reverted", "09-design-brief S10.7 [draft copy: Reverted]"),
  held: draft("Held", "09-design-brief S10.8 [draft copy: Held]"),
  sending: draft("Sending", "09-design-brief S10.12 (Sending)"),
  landing: draft("Landing", "09-design-brief S10.12 (Landing 0.5s)"),
  noActivity: draft("No activity", "09-design-brief S14.1 [draft copy: No activity]"),
  today: draft("Today", "09-design-brief S14 day headers [draft copy: Today]"),
  yesterday: draft("Yesterday", "09-design-brief S14 day headers [draft copy: Yesterday]"),
  notRestorable: draft("Older history not restorable", "09-design-brief S14.3 [draft copy: Older history not restorable]"),
  // drafts: R5's own labels (P.dc / P.pw / unsigned), CN-136 still open
  whereItIs: draft("Where it is", "R5 portfolio-1440.html P.pw(\"Where it is\", \"PV-36\"); CN-136 open"),
  positions: draft("Positions", "R5 portfolio-1440.html (table title, tile); CN-136 open"),
  onTheWay: draft("On the way", "R5 private.js pvEquity; CN-136 open"),
  activity: draft("Activity", "R5 portfolio-1440.html P.dc(\"Activity\"); 09-design-brief S14 base"),
  allocation: draft("Allocation", "R5 portfolio-1440.html P.dc(\"Allocation\")"),
  orders: draft("Orders", "R5 portfolio-390.html msegs; 09-design-brief S10 phone segments"),
  stats: draft("Stats", "R5 portfolio-390.html msegs; 09-design-brief S10 phone segments"),
  howYouTrade: draft("How you trade", "R5 portfolio-1440.html P.dc(\"How you trade\")"),
  closedTrades: draft("closed trades", "R5 portfolio-1440.html P.dc(\"closed trades\")"),
  avgWin: draft("Avg win", "R5 portfolio-1440.html P.dc(\"Avg win\")"),
  avgLoss: draft("Avg loss", "R5 portfolio-1440.html P.dc(\"Avg loss\")"),
  avgHold: draft("Avg hold", "R5 portfolio-1440.html P.dc(\"Avg hold\")"),
  greenDays: draft("green days", "R5 portfolio-1440.html P.dc(\"green days\")"),
  red: draft("red", "R5 portfolio-1440.html P.dc(\"red\")"),
  heldFor: draft("Held", "R5 portfolio-1440.html table column P.dc(\"Held\") (time held)"),
  addExit: draft("Add exit plan", "R5 portfolio-1440.html (the EXITIC tile's label)"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
