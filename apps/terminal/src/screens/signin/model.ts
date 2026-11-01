// The sign-in screens' states, as pure functions of the signing page's snapshot (the kit's client): the header S1.1-S1.4
// and its backup dot (app.md CH-001, CH-010), the ways in S2.1 offers (CH-011, APU-05), and the restore screens S19
// (CH-099-CH-101). Every fact comes from SIGN_HOST's `state` answer; APP_HOST holds no note and no key.
import type { SigninWay, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";

export type HeaderKind = "out" | "loading" | "empty" | "balance";

export interface HeaderModel {
  /** S1.1 signed out, S1.2 the balance skeleton, S1.3 $0.00, S1.4 a balance. */
  kind: HeaderKind;
  /** The balance in USD cents, as a decimal-free bigint; 0 for out and loading. */
  cents: bigint;
  /** The Backup dot: signed in and the 12 words not saved yet (`code_saved` false). */
  backupDot: boolean;
  /** The way in, for S1.16's wallet label (CN-79). */
  way: SigninWay | null;
}

/** USDC decimal string to cents, rounded down (never shows more than is there). Garbage reads as 0. */
export function toCents(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return 0n;
  return BigInt(m[1]!) * 100n + BigInt(((m[2] ?? "") + "00").slice(0, 2));
}

/** "$1,234.56" from cents. */
export function usd(cents: bigint): string {
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * The balance (CH-001): the vault's notes plus the READY fresh wallets plus the positions. A position counts at its
 * cost here; its market value joins when the positions card brings prices.
 */
export function balanceCents(s: SignpageState): bigint {
  let c = toCents(s.vault_balance);
  for (const w of s.wallets) if (w.state === "READY") c += toCents(w.size);
  for (const p of s.positions) c += toCents(p.cost);
  return c;
}

/**
 * The header. Before the first `state` the skeleton shows (never "Sign in" for a user who is signed in); a signing page
 * that is down with no state known shows Sign in, whose sheet then has its options off; a stale state keeps showing.
 */
export function headerModel(snap: SignpageClientSnapshot): HeaderModel {
  const s = snap.state;
  if (!s) return { kind: snap.status === "connecting" ? "loading" : "out", cents: 0n, backupDot: false, way: null };
  if (!s.signed_in) return { kind: "out", cents: 0n, backupDot: false, way: null };
  const cents = balanceCents(s);
  return { kind: cents === 0n ? "empty" : "balance", cents, backupDot: !s.code_saved, way: s.way ?? null };
}

/**
 * The ways in S2.1 offers, in order: the passkey first (J1.F7), the wallet second (J21.1), the 12 words last. None
 * while signed in: `signin.open` never replaces a stored seed (W:921). A passkey way that failed for no PRF on this
 * device is absent (it cannot work here); "no passkey" keeps it, since SIGN_HOST's page can still create one.
 */
export function signinWays(state: SignpageState | null): SigninWay[] {
  if (state?.signed_in) return [];
  const noPrf = state?.signin_failed?.way === "passkey" && state.signin_failed.reason === "no_prf";
  return noPrf ? ["wallet", "words"] : ["passkey", "wallet", "words"];
}

export type RestoreKind = "scanning" | "done" | "nothing" | "offline";

export interface RestoreModel {
  /** The restore operation's id. */
  id: string;
  /** S19.1/S19.2 scanning (the balance grows), S19.3 done, S19.4 nothing found, S19.5 offline. */
  kind: RestoreKind;
  cents: bigint;
}

/** The latest restore operation in `state`, as S19, or null when there is none. */
export function restoreModel(s: SignpageState | null): RestoreModel | null {
  if (!s?.signed_in) return null;
  const op = s.ops.findLast((o) => o.kind === "restore");
  if (!op || op.kind !== "restore") return null;
  const cents = balanceCents(s);
  if (op.stage === "stalled") return { id: op.id, kind: "offline", cents };
  if (op.stage !== "done") return { id: op.id, kind: "scanning", cents };
  const found = cents > 0n || s.positions.length > 0 || s.held.length > 0 || s.orders.length > 0;
  return { id: op.id, kind: found ? "done" : "nothing", cents };
}

/**
 * Whether the sheet shows S19: a running or stalled restore always; a finished one only when this page saw it running
 * (a reload after the end does not bring it back); never once the user closed it.
 */
export function showRestore(r: RestoreModel | null, seenRunning: ReadonlySet<string>, closed: ReadonlySet<string>): boolean {
  if (!r || closed.has(r.id)) return false;
  if (r.kind === "scanning" || r.kind === "offline") return true;
  return seenRunning.has(r.id);
}

