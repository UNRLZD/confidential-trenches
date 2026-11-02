// One send per nullifier (card helper-pool-senders, M352 (3)): a release is spent once, so the helper sends it once. A
// repeat of a nullifier whose first carry is in flight or answered with a send gets that first answer and sends
// nothing, whatever bytes it carries (a device retry, a copy). A carry refused before its send, or a send the chain
// ended without spending (forget), frees the nullifier. Memory only, bounded: after a restart or an eviction the
// chain's own spent mark still refuses a second spend, so this only saves gas and keeps one answer per release.

/** The most nullifiers remembered; the oldest goes first [design: an hour of sends at about 3 a second]. */
export const POOL_SEND_MEMORY = 10_000;

export type Once<A extends { status: number }> = {
  /** The first carry of `nullifier`, or `carry()` now when there is none. */
  run(nullifier: string, carry: () => Promise<A>): Promise<A>;
  /** The first carry of `nullifier`, if remembered. */
  get(nullifier: string): Promise<A> | undefined;
  /** Frees `nullifier`: its send ended on chain without spending it. */
  forget(nullifier: string): void;
  readonly size: number;
};

export function oncePerNullifier<A extends { status: number }>(max = POOL_SEND_MEMORY): Once<A> {
  const m = new Map<string, Promise<A>>();
  const drop = (nf: string, p: Promise<A>) => {
    if (m.get(nf) === p) m.delete(nf);
  };
  return {
    run(nf, carry) {
      const prior = m.get(nf);
      if (prior) return prior;
      const p: Promise<A> = carry().then(
        (a) => {
          if (a.status !== 200) drop(nf, p);
          return a;
        },
        (e) => {
          drop(nf, p);
          throw e;
        },
      );
      m.set(nf, p);
      while (m.size > max) m.delete(m.keys().next().value as string);
      return p;
    },
    get: (nf) => m.get(nf),
    forget: (nf) => void m.delete(nf),
    get size() {
      return m.size;
    },
  };
}
