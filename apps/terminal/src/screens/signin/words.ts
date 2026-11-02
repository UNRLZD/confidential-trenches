// Every word the sign-in screens draw, in one table, each with where the owner OK'd it. A word the owner's lists do not
// hold yet is `draft: true`: it is drawn with data-draft-copy on its element and listed in the card's report for the
// owner's pick; a pick changes only its text here.
//
// The owner's lists: board card owner-words-pass ("Keep the drafts", owner 1 Nov 03:32Z, research repo
// docs/owner-decisions.md:351), the signed CN rows of docs/spec/09-design-brief.md (CN-70, CN-71, CN-79, owner round
// 14 and 16), the locked R5 prototype's own labels (design/proto/assets/app.js at design-lock-r5), and the new draft
// words (owner 1 Nov 16:45Z, keep).

export interface Word {
  text: string;
  /** Where the owner OK'd it, or for a draft the paper that asks for it. */
  source: string;
  /** True until the owner picks it. */
  draft: boolean;
}

const ok = (text: string, source: string): Word => ({ text, source, draft: false });

export const WORDS = {
  signIn: ok("Sign in", "R5 app.js:353 (S1.1 header) and :395 (phone)"),
  deposit: ok("Deposit", "R5 app.js:357"),
  withdraw: ok("Withdraw", "R5 portfolio-1440.html:73"),
  usePasskey: ok("Use passkey", "owner-words-pass (wallet-passkey-prf buttons)"),
  wallet: ok("Wallet", "CN-71 (S2 option) and CN-79 (S1.16 label), owner round 14"),
  signOut: ok("Sign out", "owner-words-pass (wallet-passkey-prf buttons)"),
  privacy: ok("Privacy", "CN-70, owner round 16"),
  retry: ok("Retry", "owner-words-pass (app-signpage-client)"),
  account: ok("Account", "R5 app.js:400 (phone tab)"),
  recoveryCode: ok("Recovery code", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S2 (S2.1 option) [draft copy]"),
  backup: ok("Backup", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S1 account menu [draft copy]"),
  sync: ok("Sync", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S19.6 and S1 account menu [draft copy]"),
  restoring: ok("Restoring", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S19.1 [draft copy: Restoring · 300 checked]"),
  nothingFound: ok("Nothing found", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S19.4 [draft copy]"),
  offline: ok("Offline", "owner 1 Nov 16:45Z, keep; drafted from 09-design-brief S19.5 [draft copy: Offline · Retry]"),
  close: ok("Close", "owner 1 Nov 16:45Z, keep; drafted from the sheet's close icon, its accessible name only (never drawn)"),
  hopRefused: ok("Not available", "owner 1 Nov 16:45Z, keep; drafted from card app-hop-refused: a tap the page's rule refuses (not_allowed), no Retry [draft copy]"),
  hopError: ok("Couldn't open", "owner 1 Nov 16:45Z, keep; drafted from card app-hop-refused: a tap the page fails (any other code), with Retry [draft copy]"),
  hopSilent: ok("No response", "owner 1 Nov 16:45Z, keep; drafted from card app-hop-refused: a tap with no answer within 5 s, with Retry [draft copy]"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

/** The words still waiting for the owner's pick. */
export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
