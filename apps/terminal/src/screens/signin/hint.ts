// The sign-in hint (card app-header-first-paint-auth): APP_HOST's own record of the last sign-in state the signing
// page's snapshot said, "in" or "out" and nothing else (no way, no balance, no key). The header reads it in its first
// render, before the first paint, and draws its loading state at the shape it will land in (Account.tsx), so the state
// landing moves nothing (BAR-10 CLS 0); the account box is reserved only for the "in" shape (Header.tsx, search.css).
// With no hint (a new visitor, a bad value, blocked storage) the shape is "out": a new visitor is signed out, so the
// first load already has R5's room before Sign in. A load keeps its "in" box when it lands signed out, so nothing
// moves; a load drawn "out" that lands signed in (a stale hint, or app storage cleared while the signing page kept its
// own) grows the box once. The hint is written whenever a snapshot holds a state, so a wrong one is corrected for the
// next load. Display only.
import type { SignpageClientSnapshot } from "@blindfill/kit";
import type { HeaderModel } from "./model.ts";

export type Hint = "in" | "out";
export const HINT_KEY = "ct-signin-hint";

type Store = Pick<Storage, "getItem" | "setItem"> | null;

/** The page's storage, or null where it cannot be reached. */
function local(): Store {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The stored hint: "in" or "out", else null (none, another value, or storage that cannot be read). */
export function readHint(store: Store = local()): Hint | null {
  try {
    const v = store?.getItem(HINT_KEY);
    return v === "in" || v === "out" ? v : null;
  } catch {
    return null;
  }
}

/** Stores the hint when it changes. */
export function writeHint(h: Hint, store: Store = local()): void {
  try {
    if (store && store.getItem(HINT_KEY) !== h) store.setItem(HINT_KEY, h);
  } catch {
    // blocked storage: the next load reads no hint ("out")
  }
}

/** The hint a snapshot gives: its state's own sign-in, or null while it holds no state. */
export const hintOf = (snap: SignpageClientSnapshot): Hint | null => (snap.state ? (snap.state.signed_in ? "in" : "out") : null);

/** The shape the first render draws: the stored hint, "out" (a new visitor) without one. */
export const firstShape = (stored: Hint | null): Hint => stored ?? "out";

/** The account side's shape for this load: the first render's until the state lands; then "in" once signed in, and
 *  the first render's when signed out (an "in" box keeps its room, so Sign in landing in it moves nothing). */
export const shapeOf = (kind: HeaderModel["kind"], first: Hint): Hint => (kind === "loading" || kind === "out" ? first : "in");
