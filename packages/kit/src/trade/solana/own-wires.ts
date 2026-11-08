// The Solana wires the kit's trade flow built and checked (card signers-own-bytes, merge note M366 (2)): each with a
// copy of the bytes its checks passed, the only bytes the flow hands a signer. Not in the kit's public entry
// (index.ts re-exports flow.ts, never this file), so an app or a server cannot add a wire: flow.ts adds one only once
// its checks pass on it, and solanaSignedWire refuses any wire not here, or changed since, before a signer is asked.
const OWN = new WeakMap<object, Uint8Array>();

/** `tx` is the flow's own, its checks passed on `checked` (copied here). */
export function ownSolanaWire(tx: object, checked: Uint8Array): void {
  OWN.set(tx, Uint8Array.from(checked));
}

/** Whether `tx` is a wire the flow built and checked, its bytes still the ones checked. */
export function isOwnSolanaWire(tx: { readonly wire: Uint8Array }): boolean {
  const own = OWN.get(tx);
  return own !== undefined && own.length === tx.wire.length && tx.wire.every((b, i) => b === own[i]);
}
