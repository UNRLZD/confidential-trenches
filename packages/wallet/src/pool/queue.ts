// The proof queue: one proof made ahead for every note a pool can release a chunk from, so a buy at the tap needs only
// W's signature (card wallet-pool-ladder; architecture v2, M349; the lite paper §3 "Buy"; the held note, wallet.md
// §2.3 l.385-391 at research 6d3a34c; the proof pool, wallet.md W:732-746 and WU-11).
//
// - Which notes: every UNSPENT note of the pool's scope, landed, whose value covers the smallest rung. Its chunk is the
//   largest rung at or below its value (./ladder.ts chunkOf); the proof withdraws exactly that.
// - W: the fresh wallet W_{chain, l, j} (derive/keys.ts freshWallet), with l the note's label and j its change index
//   (keys.ts changeIndex: a label's first note gives 0, change note k gives k + 1). So each note has its own W, fixed
//   by the note, and a restore finds it. W's secret key is zeroed at once; the pool gets only its address and public
//   key.
// - One proof per note: only an UNSPENT note is proved, passes run one after another, and the store's compare-and-set
//   move UNSPENT -> HELD refuses a note another tab or pass holds. The context goes on the note with that move, before the proof
//   starts (notes/store.ts). The pool's context function binds W, the fee cap and the deadline (./pool.ts).
// - HELD until sent or dropped: a ready proof keeps its note HELD. take() writes HELD -> RESERVED before it hands the
//   proof out, so nothing leaves before the store has it; drop() writes HELD -> UNSPENT. A proof that fails frees its
//   note. A page that dies leaves HELD notes the store frees on its next open (the dead tab's lock), and the queue
//   proves them again.
// - Made again only when its deadline nears (the pool's time at or past deadline less the pool's remake margin) or
//   after a spend (the change note is a new UNSPENT note). Each pass reads the pool's time and trees once.
// - Side by side: min(hardwareConcurrency - 1, 3) provers at a time, at least 1 (wallet.md W:732-746: a bigger pool
//   runs out of phone memory). Each prover runs one proof at a time. The notes are taken in leaf order, so a pool of
//   one and a pool of three make the same proofs.
// - The seed is copied, and the copy zeroed on close(). Nothing here logs.
import { poolProveWithdraw, type VaultProver } from "@blindfill/kit";
import { changeIndex, freshWallet } from "../derive/index.ts";
import { noteSecrets, type NoteRef } from "../notes/secrets.ts";
import type { NoteRecord, NoteStore } from "../notes/store.ts";
import { checkLadder, chunkOf } from "./ladder.ts";
import { checkBinding, checkPool, type Pool, type PoolTrees, type ReadyProof } from "./pool.ts";

/** Provers side by side: min(hardwareConcurrency - 1, 3), at least 1. */
export function proofPoolSize(hardwareConcurrency: number | undefined): number {
  const h = typeof hardwareConcurrency === "number" && Number.isInteger(hardwareConcurrency) ? hardwareConcurrency : 1;
  return Math.max(1, Math.min(h - 1, 3));
}

export type ProofQueueArgs<R> = {
  /** The 64-byte seed: copied, and the copy zeroed on close(). */
  seed64: Uint8Array;
  notes: NoteStore;
  pool: Pool<R>;
  /** One prover per worker (the kit's startProver); the queue uses proofPoolSize of them. */
  provers: readonly VaultProver[];
  /** navigator.hardwareConcurrency. */
  hardwareConcurrency: number | undefined;
};

/** What one pass did: the notes it proved, the notes whose proof was made again, and each failure. */
export type QueuePass = { made: string[]; remade: string[]; failed: { noteId: string; error: string }[] };

export interface ProofQueue<R> {
  /** One pass: drops what is stale, then proves every note that has no proof. Passes run one after another. */
  refresh(signal?: AbortSignal): Promise<QueuePass>;
  /** The proofs ready now, in leaf order. */
  ready(): ReadyProof<R>[];
  /** At the tap: the note goes HELD -> RESERVED, then its proof is handed out and leaves the queue. */
  take(noteId: string): Promise<ReadyProof<R>>;
  /** The proof is dropped and its note goes back to UNSPENT. */
  drop(noteId: string): Promise<void>;
  /** Zeroes the seed's copy; the queue does nothing more. */
  close(): void;
}

const leafOrder = (x: NoteRecord, y: NoteRecord): number => (x.leaf!.leafIndex < y.leaf!.leafIndex ? -1 : x.leaf!.leafIndex > y.leaf!.leafIndex ? 1 : 0);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The change index of the spend of this note (keys.ts changeIndex).
function jOf(ref: NoteRef): number {
  return ref.kind === "change" ? changeIndex({ kind: "change", j: ref.j }) : changeIndex({ kind: "deposit" });
}

export function openProofQueue<R>(a: ProofQueueArgs<R>): ProofQueue<R> {
  if (!(a.seed64 instanceof Uint8Array) || a.seed64.length !== 64) throw new Error("seed64: not 64 bytes");
  checkPool(a.pool as Pool);
  checkLadder(a.pool.ladder);
  if (!Array.isArray(a.provers) || a.provers.length === 0) throw new Error("provers: at least one");
  const seed = Uint8Array.from(a.seed64);
  const { notes, pool } = a;
  const provers = a.provers.slice(0, proofPoolSize(a.hardwareConcurrency));
  const ready = new Map<string, ReadyProof<R>>();
  const inFlight = new Map<string, { dropped: boolean }>();
  const order = new Map<string, bigint>(); // a note's leaf index, for ready()'s leaf order
  let closed = false;
  let passes: Promise<unknown> = Promise.resolve();

  const live = (): void => {
    if (closed) throw new Error("the proof queue is closed");
  };
  const free = (id: string, attempt: string): Promise<unknown> => notes.move(id, "HELD", "UNSPENT", { attempt }).catch(() => undefined);

  async function prove(n: NoteRecord, prover: VaultProver, trees: PoolTrees, nowMs: bigint, signal?: AbortSignal): Promise<void> {
    const flight = inFlight.get(n.id)!;
    const leaf = n.leaf!;
    const chunk = chunkOf(pool.ladder, leaf.value)!;
    const j = jOf(n.ref);
    const w = freshWallet(seed, pool.chain, leaf.label, j);
    w.secretKey.fill(0);
    const refundPrecommitment = noteSecrets(seed, { kind: "refund", l: leaf.label, j }).precommitment;
    const binding = await pool.bind({ chunk, wallet: { address: w.address, publicKey: w.publicKey }, refundPrecommitment }, signal);
    checkBinding(pool as Pool, binding, chunk, nowMs);
    live();
    // the note is HELD by this attempt, with its context, before the proof starts; a failed write stops here
    const held = await notes.move(n.id, "UNSPENT", "HELD", { deadlineMs: binding.deadlineMs, context: binding.context.toString() });
    const attempt = held.attempt!;
    try {
      const spent = noteSecrets(seed, n.ref);
      const next = noteSecrets(seed, { kind: "change", l: leaf.label, j });
      const p = await poolProveWithdraw(prover, {
        stateTree: trees.stateTree,
        labelTree: trees.labelTree,
        newestStateRoot: trees.stateRoot,
        newestLabelRoot: trees.labelRoot,
        note: { value: leaf.value, label: leaf.label, nullifier: spent.nullifier, secret: spent.secret },
        newNullifier: next.nullifier,
        newSecret: next.secret,
        withdrawn: chunk,
        context: binding.context,
      });
      // the kit checked the answer against this input; these are the fields the pool and W rely on
      const s = p.publicSignals;
      if (s[2] !== chunk.toString() || s[7] !== binding.context.toString() || s[3] !== trees.stateRoot.toString() || s[5] !== trees.labelRoot.toString())
        throw new Error("proof: its chunk, roots or context are not this binding's");
      live();
      if (flight.dropped) throw new Error("dropped while it was proved");
      order.set(n.id, leaf.leafIndex);
      ready.set(n.id, {
        noteId: n.id,
        attempt,
        poolId: pool.id,
        wallet: { chain: pool.chain, l: leaf.label, j, path: w.path, address: w.address },
        chunk,
        binding,
        proof: p.proof,
        publicSignals: s,
      });
    } catch (e) {
      await free(n.id, attempt);
      throw e;
    }
  }

  async function pass(signal?: AbortSignal): Promise<QueuePass> {
    live();
    const out: QueuePass = { made: [], remade: [], failed: [] };
    const nowMs = await pool.now(signal);
    if (typeof nowMs !== "bigint") throw new Error(`pool ${pool.id}: now is not a bigint`);
    const all = await notes.list();
    const byId = new Map(all.map((n) => [n.id, n]));
    // stale: a note no longer HELD by its proof's attempt, or a deadline within the remake margin
    const stale = new Set<string>();
    for (const r of [...ready.values()]) {
      const n = byId.get(r.noteId);
      if (n === undefined || n.state !== "HELD" || n.attempt !== r.attempt) {
        ready.delete(r.noteId);
        continue;
      }
      if (nowMs >= r.binding.deadlineMs - pool.remakeMarginMs) {
        ready.delete(r.noteId);
        await notes.move(r.noteId, "HELD", "UNSPENT", { attempt: r.attempt });
        stale.add(r.noteId);
      }
    }
    const fresh = await notes.list();
    const todo = fresh
      .filter((n) => n.scope === pool.scope && n.state === "UNSPENT" && n.leaf !== undefined)
      .filter((n) => chunkOf(pool.ladder, n.leaf!.value) !== null)
      .sort(leafOrder);
    if (todo.length === 0) return out;
    const trees = await pool.trees(signal);
    let next = 0;
    const lane = async (prover: VaultProver): Promise<void> => {
      for (let k = next++; k < todo.length; k = next++) {
        const n = todo[k]!;
        if (closed || signal?.aborted) return;
        inFlight.set(n.id, { dropped: false });
        try {
          await prove(n, prover, trees, nowMs, signal);
          (stale.has(n.id) ? out.remade : out.made).push(n.id);
        } catch (e) {
          out.failed.push({ noteId: n.id, error: msg(e) });
        } finally {
          inFlight.delete(n.id);
        }
      }
    };
    await Promise.all(provers.map(lane));
    return out;
  }

  return {
    refresh(signal) {
      const run = passes.then(() => pass(signal));
      passes = run.catch(() => undefined);
      return run;
    },
    ready: () => [...ready.values()].sort((x, y) => (order.get(x.noteId)! < order.get(y.noteId)! ? -1 : 1)),
    async take(noteId) {
      live();
      const r = ready.get(noteId);
      if (r === undefined) throw new Error(`no ready proof for note ${noteId}`);
      ready.delete(noteId);
      try {
        await notes.move(noteId, "HELD", "RESERVED", { attempt: r.attempt });
      } catch (e) {
        await free(noteId, r.attempt);
        throw e;
      }
      return r;
    },
    async drop(noteId) {
      const f = inFlight.get(noteId);
      if (f !== undefined) f.dropped = true;
      const r = ready.get(noteId);
      if (r === undefined) return;
      ready.delete(noteId);
      await notes.move(noteId, "HELD", "UNSPENT", { attempt: r.attempt });
    },
    close() {
      closed = true;
      seed.fill(0);
      ready.clear();
    },
  };
}
