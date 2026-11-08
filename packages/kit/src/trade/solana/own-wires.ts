// The Solana wires the kit's trade flow built and checked (card signers-own-bytes, merge note M366 (2)): each with a
// copy of the bytes its checks passed and the lastValidBlockHeight it was built with, the only bytes and height the
// flow hands a signer. Not in the kit's public entry (index.ts re-exports flow.ts, never this file), so an app or a
// server cannot add a wire: flow.ts adds one only once its checks pass on it, and solanaSignedWire refuses any wire not
// here, or changed since, before a signer is asked, then signs the copy kept here, never the caller's arrays (a change
// to them while the signer awaits reaches nothing signed or sent).
const OWN = new WeakMap<object, { readonly wire: Uint8Array; readonly lastValidBlockHeight: number }>();

/** `tx` is the flow's own, its checks passed on `checked` (copied here), built for `tx.lastValidBlockHeight`. */
export function ownSolanaWire(tx: { readonly lastValidBlockHeight: number }, checked: Uint8Array): void {
  OWN.set(tx, Object.freeze({ wire: Uint8Array.from(checked), lastValidBlockHeight: tx.lastValidBlockHeight }));
}

/** A fresh copy of the checked bytes and height of `tx`, when it is a wire the flow built and checked and its bytes and
 *  height are still the ones checked; null otherwise. */
export function ownedSolanaWire(tx: { readonly wire: Uint8Array; readonly lastValidBlockHeight: number }): { wire: Uint8Array; lastValidBlockHeight: number } | null {
  const own = OWN.get(tx);
  if (own === undefined || !(tx.wire instanceof Uint8Array) || own.wire.length !== tx.wire.length || !tx.wire.every((b, i) => b === own.wire[i])) return null;
  if (!Object.is(own.lastValidBlockHeight, tx.lastValidBlockHeight)) return null;
  return { wire: Uint8Array.from(own.wire), lastValidBlockHeight: own.lastValidBlockHeight };
}
