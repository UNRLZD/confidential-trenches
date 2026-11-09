// The vault's USDC on SIGN_HOST's top-level page (card signpage-state-holdings; the kit's SignpageState.vault_balance).
// The top-level page reads its own notes, read only (../../wallet/src/notes/store.ts readNotes: no lock, no write), and
// sums the notes of the vault's scope on the page's network (src/withdraw/checks.ts vaultScope) that are UNSPENT or
// HELD: readNotes' own rule, "HELD and UNSPENT both count in a balance" (store.ts readNotes' doc), the one state.pools
// sums by too (../../wallet/src/pool/balances.ts poolBalances). A RESERVED note (its withdrawal's request has left the
// device) counts its change only: what leaves is the withdrawnValue its stored request names, and the rest stays the
// user's (review P2-1: a vault withdrawal writes no op, so leaving the note out read the whole note as gone for as long
// as the hand-off runs). Never twice: the change note's add turns its parent SPENT (store.ts add, and readNotes reads
// it SPENT in memory), and a withdrawal that expires frees the note back to UNSPENT at its full value. PLANNED and
// INCOMING have not landed; SPENT and TAKEN are gone.
//
// - Top-level only, as src/pools.ts: the frame keeps no note data and never opens the note store (src/state.ts).
// - Never throws, as the API's state() must not (src/api.ts ApiHost.state): a notes read that fails, or a counted note
//   with no leaf value, gives the state as it is, never a sum guessed from part of the notes. The kit's state type holds
//   vault_balance required, so that state still says "0" (src/state.ts stateOf); with it, `pools` is absent too, as
//   src/pools.ts leaves it on the same failed read.
// - What crosses to APP_HOST: the total alone, in whole USDC as an exact decimal string, never a note. The app reads the
//   state each time the store changes, so two totals in a row can differ by a single note's value (src/pools.ts says the
//   same of the pools).
// - Signed out, or no vault named on the page's network: the state as it is, the notes never read.
// - The answer cap: a longer balance than "0" takes room the ops may fill; the oldest ops give way (src/state.ts pickOps),
//   as src/pools.ts withPools does for `pools`.
import type { SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { USDC_DECIMALS } from "./rules/deposit-quote.ts";
import { ANSWER_ROOM, pickOps } from "./state.ts";

/**
 * The vault's balance in USDC base units: its scope's UNSPENT and HELD notes, and each RESERVED note's change (review
 * P2-1): the note less the withdrawnValue its stored request names, the rule src/withdraw/handoff.ts storedRequest
 * reads its changeValue by; a RESERVED note with no request counts nothing. A counted note with no leaf value, or a
 * RESERVED one whose request is present but does not name a withdrawnValue within the note, throws.
 */
export function vaultBalanceOf(notes: readonly NoteRecord[], scope: bigint): bigint {
  let sum = 0n;
  for (const n of notes) {
    if (n.scope !== scope || (n.state !== "UNSPENT" && n.state !== "HELD" && n.state !== "RESERVED")) continue;
    // a RESERVED note with no request (one from before the request was stored, which the note store allows and
    // withdrawSettle never settles; review P3): no change can be read, so it counts nothing, never the whole balance
    if (n.state === "RESERVED" && n.request === undefined) continue;
    const v = n.leaf?.value;
    if (typeof v !== "bigint" || v < 0n) throw new Error("vault balance: a counted note has no leaf value");
    sum += n.state === "RESERVED" ? v - withdrawnOf(n, v) : v;
  }
  return sum;
}

/** A RESERVED note's withdrawnValue (public_signals[2], the kit's VAULT_WITHDRAW_SIGNALS order), from its stored request. */
function withdrawnOf(n: NoteRecord, value: bigint): bigint {
  const signals = (JSON.parse(n.request ?? "") as { public_signals?: unknown })?.public_signals;
  const w = Array.isArray(signals) ? signals[2] : undefined;
  if (typeof w !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(w) || BigInt(w) > value) throw new Error("vault balance: a reserved note's request names no withdrawn value within it");
  return BigInt(w);
}

/** units / 10^d as an exact decimal string: no trailing zeros after the point, "0" for zero. */
function decimal(units: bigint, d: number): string {
  const s = units.toString().padStart(d + 1, "0");
  const int = s.slice(0, s.length - d);
  const frac = s.slice(s.length - d).replace(/0+$/, "");
  return frac === "" ? int : `${int}.${frac}`;
}

const utf8 = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/** `state` with vault_balance from the notes `readNotes` gives, when signed in and `scope` names a vault. */
export async function withVaultBalance(state: SignpageState, readNotes: () => Promise<readonly NoteRecord[]>, scope: bigint | null): Promise<SignpageState> {
  if (!state.signed_in || scope === null) return state;
  try {
    let out: SignpageState = { ...state, vault_balance: decimal(vaultBalanceOf(await readNotes(), scope), USDC_DECIMALS) };
    if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) out = { ...out, ops: pickOps({ ...out, ops: [] }, state.ops.map((op, t) => ({ op, t }))) };
    // the ops gave all they hold and the balance still has no room: the state as it was, which fits
    if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) return state;
    return SIGNPAGE_RESULT_SCHEMAS.state(out) ? out : state;
  } catch {
    return state;
  }
}
