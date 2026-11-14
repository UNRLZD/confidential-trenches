// A pool's ready proofs kept on the device (card balance-shows-fast): the proof queue (./queue.ts) writes its ready list
// here after each pass, take, drop and at close, and a queue opened later (a reload, a hand-over to another tab) adopts
// each one it would make the same way instead of proving the note again. What a kept proof may be adopted for is the
// queue's rule (queue.ts adopt); this file only reads and writes the list.
// - Meta proofs/<pool id> in the wallet store (../store/index.ts WALLET_PROOFS_PREFIX): encrypted like every record, deleted
//   at sign out, never read by the frame's reader. A proof holds no secret: its 8 signals are public and its binding
//   pays only W at the epoch's fee cap (the context the pool checks: contracts/pool-evm/src/contracts/PrivacyPool.sol
//   ContextMismatch, contracts/pool-solana/src/release.rs context).
// - A read that fails, or a record that is not a list, is an empty list: a kept proof only saves a prover's run.
import type { WalletStore } from "../store/index.ts";
import { WALLET_PROOFS_PREFIX } from "../store/index.ts";
import type { ReadyProof } from "./pool.ts";

/** Where a queue keeps its ready proofs: load once at the first pass, save the whole list after each change. */
export type ProofKeep<R> = {
  load(): Promise<readonly ReadyProof<R>[]>;
  save(proofs: readonly ReadyProof<R>[]): Promise<void>;
};

// the store refuses undefined (a record's optional field left out is absent, never undefined)
const plain = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === "object" && !(v instanceof Uint8Array)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = plain(x);
    return o;
  }
  return v;
};

/** The pool's kept proofs in `store` (meta proofs/<poolId>). */
export function keptProofs<R>(store: Pick<WalletStore, "get" | "put">, poolId: string): ProofKeep<R> {
  const key = `${WALLET_PROOFS_PREFIX}${poolId}`;
  return {
    async load() {
      const v = await store.get("meta", key).catch(() => undefined);
      return Array.isArray(v) ? (v as ReadyProof<R>[]) : [];
    },
    async save(proofs) {
      await store.put("meta", key, plain(proofs));
    },
  };
}
