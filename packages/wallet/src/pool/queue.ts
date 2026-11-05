// The proof queue: proofs made ahead for the notes the next taps will spend, so a buy at the tap needs only W's
// signature (card wallet-pool-ladder; architecture v2, M349; the lite paper §3 "Buy"; the held note, wallet.md §2.3
// l.385-391 at research 6d3a34c; the proof pool, wallet.md W:732-746 and WU-11).
//
// - The ready set: up to readySetSize UNSPENT notes of the pool's scope, landed, each covering a rung, largest chunk
//   first. A note's chunk is the largest rung at or below its value (./ladder.ts chunkOf); the proof withdraws exactly
//   that. One proof per note, so taps in a row draw on several notes (the ladder's job).
// - Epochs (./pool.ts): each pass works in the pool's current epoch. Every proof proves against the epoch root
//   (trees(epoch start)), binds the deadline epoch start + lifeMs and the relayer's fee for the epoch, so every proof
//   of an epoch shares its root, label root, deadline and fee. At each new epoch the ready set is made again, and a
//   proof of the epoch before stays ready and takeable while its note's new proof is made: the new one replaces it in
//   one store write (HELD -> HELD, the old context pruned), so the ready set never empties at a boundary and a tap
//   during the remake takes the old proof. A remake that finishes after that take is dropped, never sent. A deposit's
//   own note (a deposit note, or a second arrival of a deposit from U) that landed after the epoch's start is proved
//   at once on the newest root, so the first buy never waits for a boundary; take() hands that proof out past its
//   epoch only until its replacement is made and never past the next boundary + NEWEST_GRACE_MS. Every other note
//   (change, refund, return, move) waits for the next epoch: a root right after its own leaf would link two Ws.
// - W: the fresh wallet W_{chain, l, j} (derive/keys.ts freshWallet), with l the note's label and j its change index
//   (keys.ts changeIndex: a label's first note gives 0, change note k gives k + 1). So each note has its own W, fixed
//   by the note, and a restore finds it. W's secret key is zeroed at once; the pool gets only its address and public
//   key.
// - One proof per note: only an UNSPENT note is proved, passes run one after another, and the store's compare-and-set
//   move UNSPENT -> HELD refuses a note another tab or pass holds. The context goes on the note with that move, before
//   the proof starts (notes/store.ts).
// - HELD until sent or dropped: a ready proof keeps its note HELD. take() writes HELD -> RESERVED before it hands the
//   proof out, so nothing leaves before the store has it, and refuses a proof made before the previous epoch (on
//   resume the queue makes them again first), a newest-root proof past its grace, and one with less than the send
//   margin + TAKE_SLACK_MS left. drop() and close() free the note (HELD -> UNSPENT). take, drop, close and a
//   remake's swap run one at a time per note, so a tap never meets a half-made swap. A reader that pairs the ready list
//   with the notes (the signing page's state: a proof counts while its note is HELD by its attempt, ./balances.ts) reads
//   both through readyWith, in the view's turn, which a swap's write and its ready list update also take: so the read
//   sees both before the swap or both after, never the note's new attempt with the old proof (card pool-ready-no-flicker). A proof that fails frees its
//   note; a free whose write fails is tried again at the next pass. A page that dies leaves HELD notes the store frees
//   on its next open (the dead tab's lock).
// - Only while the app is in front: a pass in the background does nothing, so a hidden page spends no battery.
// - One prover at a time: the device's one thread budget, min(hardwareConcurrency - 1, 4), goes to that prover's own
//   threads (the kit's prover worker, card signpage-prover-threads), never to more provers side by side. Below 3 cores
//   the prover runs single thread and the pool is still one. Same speed as a pool of three single-thread provers at
//   about a third of the memory (WebKit, 3 proofs: one threaded prover about 0.45 to 0.6 GB against 1.28 to 1.44 GB
//   for a pool of three; an iPhone page is ended near 1.5 GB). A note's proof depends only on the note, its pool and
//   the epoch, so the pool's size never changes a proof.
// - The seed is copied, and the copy zeroed on close(). Nothing here logs.
import { poolProveWithdraw, type VaultProver } from "@blindfill/kit";
import { changeIndex, freshWallet } from "../derive/index.ts";
import { noteSecrets, type NoteRef } from "../notes/secrets.ts";
import type { NoteRecord, NoteStore } from "../notes/store.ts";
import { checkLadder, chunkOf } from "./ladder.ts";
import { checkBinding, checkPool, NEWEST_GRACE_MS, TAKE_SLACK_MS, type Pool, type PoolTrees, type ReadyProof } from "./pool.ts";

/** Proofs kept ready: min(hardwareConcurrency - 1, 3), at least 1, all made by the one prover in turn. */
export function readySetSize(hardwareConcurrency: number | undefined): number {
  const h = typeof hardwareConcurrency === "number" && Number.isInteger(hardwareConcurrency) ? hardwareConcurrency : 1;
  return Math.max(1, Math.min(h - 1, 3));
}

/** Provers side by side: one, whatever hardwareConcurrency is; the thread budget goes to that prover's threads. */
export function proofPoolSize(_hardwareConcurrency: number | undefined): number {
  return 1;
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
  /** Whether the app is in front; by default the page is not hidden. */
  inFront?: () => boolean;
  /** Notes the queue leaves alone, read each pass: a note a withdraw still owes a send for (its W is the spend's W). */
  skip?: () => Promise<ReadonlySet<string>>;
};

/** What one pass did: the notes it proved, the notes whose proof was made again, and each failure. */
export type QueuePass = { made: string[]; remade: string[]; failed: { noteId: string; error: string }[] };
const NOTHING = (): QueuePass => ({ made: [], remade: [], failed: [] });

export interface ProofQueue<R> {
  /** One pass: lets go of proofs whose note moved, makes again those of an earlier epoch (each stays ready until its
   * new one replaces it), then proves notes that have no proof. Passes run one after another. */
  refresh(signal?: AbortSignal): Promise<QueuePass>;
  /** The proofs ready now, in leaf order. */
  ready(): ReadyProof<R>[];
  /** The proofs ready now with `read`'s answer (the caller's read of the notes), both in one turn that no swap's write
   * and ready list update falls inside: the list and the notes agree on each note's attempt. */
  readyWith<T>(read: () => Promise<T>): Promise<{ ready: ReadyProof<R>[]; value: T }>;
  /** At the tap: refused (and its note freed) for a proof made before the previous epoch, a newest-root proof past the
   * next boundary + NEWEST_GRACE_MS, or one with less than sendMarginMs + TAKE_SLACK_MS left; else HELD -> RESERVED,
   * then it is handed out. With `attempt` (the ready proof the caller built its transaction on), refused in the note's
   * turn, before any write, when the note's ready proof is another attempt (a remake swapped it in meanwhile): the note
   * stays HELD with its new proof ready, never RESERVED for bytes no one sends. */
  take(noteId: string, attempt?: string): Promise<ReadyProof<R>>;
  /** The proof is dropped and its note goes back to UNSPENT. */
  drop(noteId: string): Promise<void>;
  /** Frees every ready proof's note (HELD -> UNSPENT), then zeroes the seed's copy; the queue does nothing more. */
  close(): Promise<void>;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The change index of the spend of this note (keys.ts changeIndex): its W is W_{chain, label, jOf(ref)}. */
export function jOf(ref: NoteRef): number {
  return ref.kind === "change" ? changeIndex({ kind: "change", j: ref.j }) : changeIndex({ kind: "deposit" });
}

const notHidden = (): boolean => (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState !== "hidden";
const byChunkThenLeaf = (l: Pool["ladder"]) => (x: NoteRecord, y: NoteRecord): number => {
  const cx = chunkOf(l, x.leaf!.value)!, cy = chunkOf(l, y.leaf!.value)!;
  if (cx !== cy) return cx > cy ? -1 : 1;
  return x.leaf!.leafIndex < y.leaf!.leafIndex ? -1 : 1;
};

export function openProofQueue<R>(a: ProofQueueArgs<R>): ProofQueue<R> {
  if (!(a.seed64 instanceof Uint8Array) || a.seed64.length !== 64) throw new Error("seed64: not 64 bytes");
  checkPool(a.pool as Pool);
  checkLadder(a.pool.ladder);
  if (!Array.isArray(a.provers) || a.provers.length === 0) throw new Error("provers: at least one");
  const seed = Uint8Array.from(a.seed64);
  const { notes, pool } = a;
  const inFront = a.inFront ?? notHidden;
  const provers = a.provers.slice(0, proofPoolSize(a.hardwareConcurrency));
  const readySize = readySetSize(a.hardwareConcurrency);
  const ready = new Map<string, ReadyProof<R>>();
  const inFlight = new Map<string, { dropped: boolean }>();
  const order = new Map<string, bigint>(); // a note's leaf index, for ready()'s leaf order
  const unfreed = new Map<string, string>(); // a note whose free failed -> its attempt, tried again each pass
  const noteTurns = new Map<string, Promise<unknown>>(); // take, drop, close and a remake's swap: one at a time per note
  let closed = false;
  let passes: Promise<unknown> = Promise.resolve();
  let view: Promise<unknown> = Promise.resolve(); // readyWith's reads and the swaps' writes: one at a time
  const inView = <T>(f: () => Promise<T>): Promise<T> => {
    const run = view.then(f);
    view = run.catch(() => undefined);
    return run;
  };

  const onNote = <T>(id: string, f: () => Promise<T>): Promise<T> => {
    const run = (noteTurns.get(id) ?? Promise.resolve()).then(f);
    const tail = run.catch(() => undefined);
    noteTurns.set(id, tail);
    void tail.then(() => {
      if (noteTurns.get(id) === tail) noteTurns.delete(id);
    });
    return run;
  };

  const live = (): void => {
    if (closed) throw new Error("the proof queue is closed");
  };
  const free = async (id: string, attempt: string): Promise<void> => {
    try {
      await notes.move(id, "HELD", "UNSPENT", { attempt });
      unfreed.delete(id);
    } catch {
      const n = await notes.get(id).catch(() => undefined);
      if (n === undefined || n.state !== "HELD" || n.attempt !== attempt) unfreed.delete(id); // someone else moved it
      else unfreed.set(id, attempt);
    }
  };
  const epochOf = (t: bigint): bigint => t - (t % pool.epochMs);

  // A fresh proof (prev undefined) holds its UNSPENT note first; a remake (prev: the note's ready proof of an earlier
  // epoch) leaves prev ready and the note HELD while it proves, then replaces prev in one write.
  async function prove(n: NoteRecord, prover: VaultProver, trees: PoolTrees, root: "epoch" | "newest", epochStartMs: bigint, prev: ReadyProof<R> | undefined, signal?: AbortSignal): Promise<void> {
    const flight = inFlight.get(n.id)!;
    const leaf = n.leaf!;
    const chunk = chunkOf(pool.ladder, leaf.value)!;
    const j = jOf(n.ref);
    const w = freshWallet(seed, pool.chain, leaf.label, j);
    w.secretKey.fill(0);
    const deadlineMs = epochStartMs + pool.lifeMs;
    const refundPrecommitment = noteSecrets(seed, { kind: "refund", l: leaf.label, j }).precommitment;
    const binding = await pool.bind({ chunk, wallet: { address: w.address, publicKey: w.publicKey }, refundPrecommitment, epochStartMs, deadlineMs }, signal);
    checkBinding(pool as Pool, binding, chunk);
    live();
    // a fresh proof: the note is HELD by this attempt, with its context, before the proof starts; a failed write stops
    // here. A remake writes its context with the swap below, before its proof can be taken.
    const attempt = prev === undefined ? (await notes.move(n.id, "UNSPENT", "HELD", { deadlineMs, context: binding.context.toString() })).attempt! : undefined;
    try {
      live(); // closed during the write: the seed's copy may be zeroed
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
      // the kit refused any answer whose 8 signals are not this input's: the chunk, the trees' roots and the context
      live();
      if (flight.dropped) throw new Error("dropped while it was proved");
      const made = (holder: string): ReadyProof<R> => ({
        noteId: n.id,
        attempt: holder,
        poolId: pool.id,
        wallet: { chain: pool.chain, l: leaf.label, j, path: w.path, address: w.address },
        chunk,
        epochStartMs,
        deadlineMs,
        root,
        binding,
        proof: p.proof,
        publicSignals: p.publicSignals,
      });
      if (attempt !== undefined) {
        order.set(n.id, leaf.leafIndex);
        ready.set(n.id, made(attempt));
        return;
      }
      // the swap: only while prev is still the note's ready proof (not taken, dropped or freed meanwhile); one write
      // replaces prev's attempt and context with this one's, the note HELD throughout
      await onNote(n.id, async () => {
        if (closed || flight.dropped || ready.get(n.id) !== prev) throw new Error("taken or dropped while it was made again: this proof is never sent");
        // the new attempt's write and the ready list's update in one turn of the view: no readyWith read between them
        await inView(async () => {
          const held = await notes.move(n.id, "HELD", "HELD", { attempt: prev!.attempt, deadlineMs, context: binding.context.toString() });
          ready.set(n.id, made(held.attempt!));
        });
      });
    } catch (e) {
      if (attempt !== undefined) await free(n.id, attempt);
      throw e;
    }
  }

  async function pass(signal?: AbortSignal): Promise<QueuePass> {
    live();
    const out = NOTHING();
    if (!inFront()) return out;
    const nowMs = await pool.now(signal);
    if (typeof nowMs !== "bigint" || nowMs < 0n) throw new Error(`pool ${pool.id}: now is not a bigint`);
    const start = epochOf(nowMs);
    for (const [id, attempt] of [...unfreed]) await free(id, attempt);
    // let go of proofs whose note the store moved; those of an earlier epoch stay ready (and HELD) until remade
    const all = await notes.list();
    const byId = new Map(all.map((n) => [n.id, n]));
    const again: NoteRecord[] = [];
    for (const r of [...ready.values()]) {
      const n = byId.get(r.noteId);
      if (n === undefined || n.state !== "HELD" || n.attempt !== r.attempt) ready.delete(r.noteId);
      else if (r.epochStartMs < start) again.push(n);
    }
    const want = readySize - ready.size + again.length;
    if (want <= 0) return out;
    const skipped = (await a.skip?.()) ?? new Set<string>();
    const open = all
      .filter((n) => n.scope === pool.scope && n.state === "UNSPENT" && n.leaf !== undefined && chunkOf(pool.ladder, n.leaf.value) !== null && !skipped.has(n.id))
      .sort(byChunkThenLeaf(pool.ladder));
    if (open.length === 0 && again.length === 0) return out;
    const epochTrees = await pool.trees(start, signal);
    // the newest trees, read once for every deposit note of this pass; a failed read fails those notes only, and the
    // epoch's remakes and other notes still run
    let newest: PoolTrees | Error | undefined;
    const todo: { n: NoteRecord; trees: PoolTrees; root: "epoch" | "newest"; prev?: ReadyProof<R> }[] = [];
    // the ready set's own notes first (each landed before the epoch began), then the open notes
    for (const n of again.sort(byChunkThenLeaf(pool.ladder))) todo.push({ n, trees: epochTrees, root: "epoch", prev: ready.get(n.id)! });
    for (const n of open) {
      if (todo.length === want) break;
      if (n.leaf!.leafIndex < BigInt(epochTrees.stateTree.size)) todo.push({ n, trees: epochTrees, root: "epoch" });
      else if (n.ref.kind === "deposit" || (n.ref.kind === "second" && n.ref.id.id === "U")) {
        newest ??= await pool.trees(nowMs + 1n, signal, { newest: true }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))); // every leaf up to now
        if (newest instanceof Error) out.failed.push({ noteId: n.id, error: msg(newest) });
        else todo.push({ n, trees: newest, root: "newest" });
      } // any other note that landed in this epoch (change, refund, return, move) waits for the next
    }
    let k = 0;
    const lane = async (prover: VaultProver): Promise<void> => {
      for (let t = todo[k++]; t !== undefined; t = todo[k++]) {
        if (closed || signal?.aborted) return;
        inFlight.set(t.n.id, { dropped: false });
        try {
          await prove(t.n, prover, t.trees, t.root, start, t.prev, signal);
          (t.prev !== undefined ? out.remade : out.made).push(t.n.id);
        } catch (e) {
          out.failed.push({ noteId: t.n.id, error: msg(e) });
        } finally {
          inFlight.delete(t.n.id);
        }
      }
    };
    await Promise.all(provers.map(lane));
    return out;
  }

  const sorted = (): ReadyProof<R>[] => [...ready.values()].sort((x, y) => (order.get(x.noteId)! < order.get(y.noteId)! ? -1 : 1));
  return {
    refresh(signal) {
      const run = passes.then(() => pass(signal));
      passes = run.catch(() => undefined);
      return run;
    },
    ready: () => sorted(),
    readyWith: (read) => inView(async () => ({ ready: sorted(), value: await read() })),
    take(noteId, attempt) {
      live();
      return onNote(noteId, async () => {
        live();
        const r = ready.get(noteId);
        if (r === undefined) throw new Error(`no ready proof for note ${noteId}`);
        if (attempt !== undefined && r.attempt !== attempt) throw new Error(`note ${noteId}'s ready proof is another attempt: it was made again, so it is not taken`);
        const nowMs = await pool.now();
        const why =
          epochOf(nowMs) > r.epochStartMs + pool.epochMs
            ? "is from before the previous epoch"
            : r.root === "newest" && nowMs >= r.epochStartMs + pool.epochMs + NEWEST_GRACE_MS
              ? `is on the newest root and its epoch ended over ${NEWEST_GRACE_MS} ms ago`
              : r.deadlineMs - nowMs < pool.sendMarginMs + TAKE_SLACK_MS
                ? `has less than the send margin + ${TAKE_SLACK_MS} ms left`
                : undefined;
        if (why !== undefined) {
          ready.delete(noteId);
          await free(noteId, r.attempt);
          throw new Error(`the proof for note ${noteId} ${why}: it is made again first`);
        }
        ready.delete(noteId);
        try {
          await notes.move(noteId, "HELD", "RESERVED", { attempt: r.attempt });
        } catch (e) {
          await free(noteId, r.attempt);
          throw e;
        }
        return r;
      });
    },
    async drop(noteId) {
      const f = inFlight.get(noteId);
      if (f !== undefined) f.dropped = true;
      await onNote(noteId, async () => {
        const r = ready.get(noteId);
        if (r === undefined) return;
        ready.delete(noteId);
        await free(noteId, r.attempt); // a failed write is tried again at the next pass
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const f of inFlight.values()) f.dropped = true;
      // each in its note's turn, so a swap already writing finishes first and its new attempt is the one freed
      for (const id of [...ready.keys()])
        await onNote(id, async () => {
          const r = ready.get(id);
          ready.delete(id);
          if (r !== undefined) await free(id, r.attempt);
        });
      seed.fill(0);
      await passes; // a proof still being made sees the queue closed and frees its own note
    },
  };
}
