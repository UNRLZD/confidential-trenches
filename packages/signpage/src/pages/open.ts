// SIGN_HOST's top-level pages for the three open kinds of the account (card signpage-signin-kinds; docs/plan1/wallet.md
// §2.8 rows signin.open, signout and backup.open, W:912-914, and §2.2's wallet row, W:50, at research ffcba5e; row W4.4,
// W:1117). Which page each kind draws, from the page's own state and its own store, never from the app's word:
//
// - signin.open: only while no seed is stored here (a seed is never replaced: sign out first, W:912). The passkey way
//   draws the passkey page, the words way the typed 12 words. The wallet way reads the store first and, with no seed,
//   draws the two choices before the wallet is asked anything or any seed is made (owner pick Ask first, OD:349):
//   New account and I already have one (owner 2 Nov 06:08Z, all approved); I already have one draws Use passkey (Face ID) and
//   the typed 12 words, then restore (W:50).
// - signout: only with a seed stored. While the 12 words are the only copy and not saved (a no-PRF seed whose code_saved
//   is false) it draws the backup first, and Sign out only once the user saved them there (W:913). It deletes the store
//   and signs nothing.
// - backup.open: only with a seed stored; the 12 words are drawn on this top-level page alone (W:914).
// - withdraw.open (card signpage-withdraw-form): only with a seed stored; it draws the withdraw form (src/withdraw/),
//   where the user types the address and the amount (W:927). A withdraw.open with a one-time id (from_id, W:928) is
//   refused until the withdraw from an id is built: the form withdraws from the vault's notes only.
//
// Every open kind runs top-level only: the framed page answers no kind but state (src/main.ts starts its API with none),
// so a sign-out asked from inside a frame is refused. Each page draws in the shell's layer, and the layer's opening
// resets the activation guard (src/guard.ts shown()), so a click lined up before it cannot land on Sign out, Saved,
// Backup or Copy.
import { backupFirst } from "@blindfill/wallet/store";

/** The open kinds these pages answer. */
export type AccountKind = "signin.open" | "signout" | "backup.open" | "withdraw.open";

/** The page's own states in which no open kind is taken: a step is running, or the store is not read yet. */
const BUSY = new Set(["loading"]);

/** Whether the page has a seed stored, from the state it shows (its own store's last read). */
const SIGNED_IN = new Set(["signed-in", "backup", "signout", "withdraw"]);

/**
 * Whether `kind` may open now: `state` is the page's data-signin, `busy` whether a step is running. A refused kind is
 * answered "not_allowed" and draws nothing. The page reads its store again before it draws (pageFor).
 */
export function takes(kind: AccountKind, state: string | undefined, busy: boolean): boolean {
  if (busy || state === undefined || BUSY.has(state)) return false;
  // a seed stored: sign-in never replaces it; sign-out and backup need it
  if (kind === "signin.open") return !SIGNED_IN.has(state);
  return state === "signed-in";
}

/**
 * Whether the kind's params name a page this release builds: withdraw.open with a one-time id (from_id) is refused,
 * since the form withdraws from the vault's notes only; every other kind's params are the kit schema's alone.
 */
export function takesParams(kind: AccountKind, params: Record<string, unknown>): boolean {
  return kind !== "withdraw.open" || !Object.hasOwn(params, "from_id");
}

/** The page a kind draws, read from the store just before it draws: `seed` is the stored seed's status, or none. */
export type Page = "passkey" | "unsupported" | "words" | "choose" | "signed-in" | "backup" | "signout" | "signed-out" | "withdraw";

export function pageFor(
  kind: AccountKind,
  way: unknown,
  seed: { source: unknown; code_saved: unknown } | undefined,
  passkeys: boolean,
): Page {
  if (kind === "signin.open") {
    // a seed another tab stored meanwhile is the account shown, never replaced
    if (seed) return "signed-in";
    if (way === "wallet") return "choose";
    if (way === "words") return "words";
    return passkeys ? "passkey" : "unsupported";
  }
  if (!seed) return "signed-out";
  if (kind === "backup.open") return "backup";
  if (kind === "withdraw.open") return "withdraw";
  // signout: the backup first while the 12 words are the only copy and not saved
  return backupFirst(seed) ? "backup" : "signout";
}

/** Where Saved goes on the backup page: on to Sign out when sign-out opened it, else back to the app signed in. */
export function afterSaved(openedBy: AccountKind | null): "signout" | "signed-in" {
  return openedBy === "signout" ? "signout" : "signed-in";
}
