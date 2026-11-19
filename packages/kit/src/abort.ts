/** A wait that ends with `signal`'s reason once it aborts, and at once when it aborted before the wait began: an aborted
 *  signal never fires its event again, so a listener added after the abort waits forever (card
 *  aborted-signal-waits-end-at-once: deposit-moveout's stalled read subscribed after an await, lost the abort and held its
 *  run 49 min). With no signal it never settles, as a wait on no signal never ends. */
export function untilAborted(signal?: AbortSignal | null): Promise<never> {
  if (signal == null) return new Promise<never>(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<never>((_, no) => signal.addEventListener("abort", () => no(signal.reason), { once: true }));
}
