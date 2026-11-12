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
//   during the remake takes the old proof. A remake that finishes after that take is dropped, never sent. A note of
//   any kind (deposit, change, refund, return, move, second arrival) that landed after the epoch's start is proved at
//   once on the newest root both RPCs agree on (card fresh-money-spendable-at-once: no tap waits for a boundary, only
//   for chain finality and the proof); take() hands that proof out past its epoch only until its replacement on the
//   epoch root is made and never past the next boundary + NEWEST_GRACE_MS. A root right after its own leaf is easier
//   to tie to the W whose money made that leaf, so a tap spends such a proof only when no epoch-root proof covers it
//   (the signing page's buy and withdraw pick the rested note first).
// - W: the fresh wallet W_{chain, l, j} (derive/keys.ts freshWallet), with l the note's label and j its change index
//   (keys.ts changeIndex: a label's first note gives 0, change note k gives k + 1). So each note has its own W, fixed
//   by the note, and a restore finds it. W's secret key is zeroed at once; the pool gets only its address and public
//   key.
// - Pieces (card buy-spends-several-pieces): a pool with piecesMax above 1 (Solana) has one buy pay one W from several
//   notes. Every ready proof is then bound to one W, the owner's: the W_{chain, l, j} of the ready note with the
//   smallest chunk (ties: the later leaf), so a buy that must hold the owner's note spends no larger piece than it
//   needs, and every W a buy paid is the W of a note it spent (the restore finds it as before, ./buy-wallets.ts). When
//   the owner changes (its note taken, dropped, or a smaller note ready), every proof bound to another W is made again
//   for the new one, its old proof kept ready meanwhile as a remake's (a set of them holds no owner's note, so neither
//   the tap nor the balances' Max uses it). The ready set holds as many notes as the prover makes in half an epoch at
//   the time its proofs have taken (the mean of the last PROOF_TIMES), at least 1 and at most piecesMax, the largest
//   chunks first; before any proof is timed, readySetSize. A slow device keeps fewer ready, and Max says so.
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
//   sees both before the swap or both after, never the note's new attempt with the old proof (card pool-ready-no-flicker).
//   The cost: a take, drop or close that waits on a swap's note turn also waits behind a state read, at most one
//   notes read long. A proof that fails frees its
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
import { checkBinding, checkPool, NEWEST_GRACE_MS, NOW_REUSE_MS, TAKE_SLACK_MS, type ChainNow, type Pool, type PoolTrees, type ReadyProof } from "./pool.ts";

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
  /** Tests only: the monotonic clock proofs are timed on (performance.now unless given). */
  monoNow?: () => number;
};

/** How many of the last proofs' times the ready set's size is worked out from (card buy-spends-several-pieces). */
export const PROOF_TIMES = 5;
/** A pool with piecesMax above 1 keeps ready as many proofs as the prover makes in this share of an epoch, at the
 *  proofs' mean time (card buy-spends-several-pieces): half, so the epoch's remakes never take the whole epoch. */
export function piecesReadySize(epochMs: bigint, proofMs: readonly number[], piecesMax: number, hardwareConcurrency: number | undefined): number {
  if (proofMs.length === 0) return Math.min(readySetSize(hardwareConcurrency), piecesMax);
  const mean = proofMs.reduce((a, b) => a + b, 0) / proofMs.length;
  const fit = Math.floor(Number(epochMs) / 2 / Math.max(mean, 1));
  return Math.max(1, Math.min(fit, piecesMax));
}

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
   * and ready list update falls inside: the list and the notes agree on each note's attempt. `making`: the notes whose
   * first proof is being made now, none of them ready (card buy-spends-several-pieces: state.pools' making). */
  readyWith<T>(read: () => Promise<T>): Promise<{ ready: ReadyProof<R>[]; value: T; making: string[] }>;
  /** At the tap: refused (and its note freed) for a proof made before the previous epoch, a newest-root proof past the
   * next boundary + NEWEST_GRACE_MS, or one with less than sendMarginMs + TAKE_SLACK_MS left; else HELD -> RESERVED,
   * then it is handed out. With `attempt` (the ready proof the caller built its transaction on), refused in the note's
   * turn, before any write, when the note's ready proof is another attempt (a remake swapped it in meanwhile): the note
   * stays HELD with its new proof ready, never RESERVED for bytes no one sends. `early` (card
   * sol-buy-reads-side-by-side): the pool's time read before the take (chainNow), its ms plus the time since its
   * start (ChainNow: the larger of the device's two clocks', both within NOW_REUSE_MS); else, or when that read
   * failed, the pool's time is read here. `lastHeight`: the height past which the one transaction the caller signed on
   * this proof can no longer land (a Solana blockhash's); `nullifier`: the proof's (an EVM buy's). Each written on the
   * note's mark with HELD -> RESERVED, never in the note (notes/store.ts ReservedMark). */
  take(noteId: string, attempt?: string, early?: Promise<ChainNow>, lastHeight?: bigint, nullifier?: bigint): Promise<ReadyProof<R>>;
  /** take() of several notes at once, for one bundle of transactions that lands whole or not at all (card
   *  buy-spends-several-pieces): every note's turn held together, every refusal decided before any write, so a set
   *  refused leaves none RESERVED (a late proof's note freed and made again, as take() does; the others HELD, their
   *  proofs ready). Then each HELD -> RESERVED in order, with `lastHeight` on each one's mark. A write that fails there
   *  frees its own note and throws: the ones written before it stay RESERVED for transactions that never left the
   *  device, and the state reads free them once both RPCs' finalized height is past `lastHeight`
   *  (solana-restore.ts solanaSettleReserved). */
  takeSet(items: readonly { noteId: string; attempt: string }[], early?: Promise<ChainNow>, lastHeight?: bigint): Promise<ReadyProof<R>[]>;
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
  const shared = (pool.piecesMax ?? 1) > 1;
  const monoNow = a.monoNow ?? (() => performance.now());
  const proofMs: number[] = []; // the last PROOF_TIMES proofs' times, ms
  const readySize = (): number => (shared ? piecesReadySize(pool.epochMs, proofMs, pool.piecesMax!, a.hardwareConcurrency) : readySetSize(a.hardwareConcurrency));
  // the W every ready proof is bound to, with piecesMax above 1: the owner note's own (null: none chosen yet)
  type Owner = { noteId: string; l: bigint; j: number; address: string };
  let owner: Owner | null = null;
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
  async function prove(n: NoteRecord, prover: VaultProver, trees: PoolTrees, root: "epoch" | "newest", epochStartMs: bigint, prev: ReadyProof<R> | undefined, to: Owner | null, signal?: AbortSignal): Promise<void> {
    const flight = inFlight.get(n.id)!;
    const leaf = n.leaf!;
    const chunk = chunkOf(pool.ladder, leaf.value)!;
    const j = jOf(n.ref);
    // W: the owner's with piecesMax above 1, else this note's own
    const wl = to === null ? leaf.label : to.l;
    const wj = to === null ? j : to.j;
    const w = freshWallet(seed, pool.chain, wl, wj);
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
      const t0 = monoNow();
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
      proofMs.push(monoNow() - t0);
      if (proofMs.length > PROOF_TIMES) proofMs.shift();
      live();
      if (flight.dropped) throw new Error("dropped while it was proved");
      const made = (holder: string): ReadyProof<R> => ({
        noteId: n.id,
        attempt: holder,
        poolId: pool.id,
        wallet: { chain: pool.chain, l: wl, j: wj, path: w.path, address: w.address },
        ...(wl === leaf.label && wj === j ? { own: true as const } : {}),
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
    // a note in skip (a withdraw planned it, any tab's) is let go, in front or not: its ready proof freed, one in flight never kept
    const skipped = (await a.skip?.()) ?? new Set<string>();
    for (const id of skipped) {
      const f = inFlight.get(id);
      if (f !== undefined) f.dropped = true;
      if (ready.has(id))
        await onNote(id, async () => {
          const r = ready.get(id);
          if (r === undefined) return;
          ready.delete(id);
          await free(id, r.attempt);
        });
    }
    if (!inFront()) return out;
    const nowMs = await pool.now(signal);
    if (typeof nowMs !== "bigint" || nowMs < 0n) throw new Error(`pool ${pool.id}: now is not a bigint`);
    const start = epochOf(nowMs);
    for (const [id, attempt] of [...unfreed]) await free(id, attempt);
    // let go of proofs whose note the store moved; those of an earlier epoch stay ready (and HELD) until remade
    const all = await notes.list();
    const byId = new Map(all.map((n) => [n.id, n]));
    for (const r of [...ready.values()]) {
      const n = byId.get(r.noteId);
      if (n === undefined || n.state !== "HELD" || n.attempt !== r.attempt) ready.delete(r.noteId);
    }
    const size = readySize();
    const byChunk = byChunkThenLeaf(pool.ladder);
    let open = all
      .filter((n) => n.scope === pool.scope && n.state === "UNSPENT" && n.leaf !== undefined && chunkOf(pool.ladder, n.leaf.value) !== null && !skipped.has(n.id))
      .sort(byChunk);
    let to: Owner | null = null;
    if (shared) {
      // the set to keep ready: the largest chunks of the held and the open notes, `size` of them; a held note past it
      // is let go (a slower prover keeps fewer), an open one past it waits
      const held = [...ready.values()].map((r) => byId.get(r.noteId)!);
      const keep = [...held, ...open].sort(byChunk).slice(0, size);
      const kept = new Set(keep.map((n) => n.id));
      for (const n of held)
        if (!kept.has(n.id))
          await onNote(n.id, async () => {
            const r = ready.get(n.id);
            if (r === undefined) return;
            ready.delete(n.id);
            await free(n.id, r.attempt);
          });
      open = open.filter((n) => kept.has(n.id));
      // the owner: the kept note with the smallest chunk, the later leaf on a tie
      const o = keep[keep.length - 1];
      if (o === undefined) owner = null;
      else if (owner?.noteId !== o.id) {
        const j = jOf(o.ref);
        const w = freshWallet(seed, pool.chain, o.leaf!.label, j);
        w.secretKey.fill(0);
        owner = { noteId: o.id, l: o.leaf!.label, j, address: w.address };
      }
      to = owner;
    }
    const again: NoteRecord[] = [];
    for (const r of ready.values()) if (r.epochStartMs < start || (to !== null && r.wallet.address !== to.address)) again.push(byId.get(r.noteId)!);
    const want = (shared ? size : readySize()) - ready.size + again.length;
    if (want <= 0) return out;
    if (open.length === 0 && again.length === 0) return out;
    const epochTrees = await pool.trees(start, signal);
    // the newest trees, read once for every note of this pass that landed this epoch; a failed read fails those notes
    // only, and the epoch's remakes and the epoch's notes still run
    let newest: PoolTrees | Error | undefined;
    const todo: { n: NoteRecord; trees: PoolTrees; root: "epoch" | "newest"; prev?: ReadyProof<R> }[] = [];
    // the ready set's own notes first (each landed before the epoch began), then the open notes; among the remakes a
    // newest-root proof first (take refuses it NEWEST_GRACE_MS past the boundary, an epoch-root one stays takeable all
    // epoch), then by chunk and leaf; with piecesMax above 1 the owner's note before every other (its proof is what
    // makes the others a set a buy can spend)
    if (to !== null) open.sort((x, y) => (x.id === to.noteId ? -1 : y.id === to.noteId ? 1 : 0));
    const newestFirst = (x: NoteRecord, y: NoteRecord): number => {
      if (to !== null && (x.id === to.noteId || y.id === to.noteId)) return x.id === to.noteId ? -1 : 1;
      const a = ready.get(x.id)!.root === "newest", b = ready.get(y.id)!.root === "newest";
      return a !== b ? (a ? -1 : 1) : byChunk(x, y);
    };
    // a take or a drop during the epoch-tree read above removes a ready proof: that note is left out of the remakes
    for (const n of again.filter((x) => ready.has(x.id)).sort(newestFirst)) todo.push({ n, trees: epochTrees, root: "epoch", prev: ready.get(n.id)! });
    for (const n of open) {
      if (todo.length === want) break;
      if (n.leaf!.leafIndex < BigInt(epochTrees.stateTree.size)) todo.push({ n, trees: epochTrees, root: "epoch" });
      else {
        newest ??= await pool.trees(nowMs + 1n, signal, { newest: true }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))); // every leaf up to now
        if (newest instanceof Error) out.failed.push({ noteId: n.id, error: msg(newest) });
        // a leaf past the pool's time (its landing read before both RPCs' final block reached it) waits for the next pass
        else if (n.leaf!.leafIndex < BigInt(newest.stateTree.size)) todo.push({ n, trees: newest, root: "newest" });
      }
    }
    let k = 0;
    const lane = async (prover: VaultProver): Promise<void> => {
      for (let t = todo[k++]; t !== undefined; t = todo[k++]) {
        if (closed || signal?.aborted) return;
        inFlight.set(t.n.id, { dropped: false });
        try {
          await prove(t.n, prover, t.trees, t.root, start, t.prev, to, signal);
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

  /** The take's "now": an early read's ms plus the time since its start, the larger of the monotonic and the wall
   *  clock's, while the monotonic is 0 to NOW_REUSE_MS and the wall clock's at most NOW_REUSE_MS (ChainNow); else read. */
  const takeNow = async (early: Promise<ChainNow> | undefined): Promise<bigint> => {
    const e = await early?.catch(() => undefined);
    if (e !== undefined) {
      const mono = performance.now() - e.at;
      const wall = Date.now() - e.wall;
      if (mono >= 0 && mono <= NOW_REUSE_MS && wall <= NOW_REUSE_MS) return e.ms + BigInt(Math.ceil(Math.max(mono, wall)));
    }
    return pool.now();
  };
  /** take() and takeSet(): the notes' turns held together (taken in id order, so two sets never wait on each other),
   *  every refusal before any write, then each HELD -> RESERVED in the order given. */
  const takeIn = (items: readonly { noteId: string; attempt?: string }[], early: Promise<ChainNow> | undefined, lastHeight: bigint | undefined, nullifier?: bigint): Promise<ReadyProof<R>[]> => {
    live();
    const ids = items.map((x) => x.noteId).sort();
    const inTurns = (k: number, f: () => Promise<ReadyProof<R>[]>): Promise<ReadyProof<R>[]> => (k === ids.length ? f() : onNote(ids[k]!, () => inTurns(k + 1, f)));
    return inTurns(0, async () => {
      live();
      const rs = items.map(({ noteId, attempt }) => {
        const r = ready.get(noteId);
        if (r === undefined) throw new Error(`no ready proof for note ${noteId}`);
        if (attempt !== undefined && r.attempt !== attempt) throw new Error(`note ${noteId}'s ready proof is another attempt: it was made again, so it is not taken`);
        return r;
      });
      const nowMs = await takeNow(early);
      const late = rs.map((r) =>
        epochOf(nowMs) > r.epochStartMs + pool.epochMs
          ? "is from before the previous epoch"
          : r.root === "newest" && nowMs >= r.epochStartMs + pool.epochMs + NEWEST_GRACE_MS
            ? `is on the newest root and its epoch ended over ${NEWEST_GRACE_MS} ms ago`
            : r.deadlineMs - nowMs < pool.sendMarginMs + TAKE_SLACK_MS
              ? `has less than the send margin + ${TAKE_SLACK_MS} ms left`
              : undefined,
      );
      const at = late.findIndex((why) => why !== undefined);
      if (at >= 0) {
        // every late proof's note freed, to be made again; a set's others stay HELD with their proofs ready
        for (const [k, why] of late.entries()) {
          if (why === undefined) continue;
          ready.delete(rs[k]!.noteId);
          await free(rs[k]!.noteId, rs[k]!.attempt);
        }
        throw new Error(`the proof for note ${rs[at]!.noteId} ${late[at]}: it is made again first`);
      }
      for (const r of rs) {
        ready.delete(r.noteId);
        try {
          await notes.move(r.noteId, "HELD", "RESERVED", { attempt: r.attempt, ...(lastHeight === undefined ? {} : { lastHeight }), ...(nullifier === undefined ? {} : { nullifier }) });
        } catch (e) {
          await free(r.noteId, r.attempt);
          throw e;
        }
      }
      return rs;
    });
  };
  const sorted = (): ReadyProof<R>[] => [...ready.values()].sort((x, y) => (order.get(x.noteId)! < order.get(y.noteId)! ? -1 : 1));
  return {
    refresh(signal) {
      const run = passes.then(() => pass(signal));
      passes = run.catch(() => undefined);
      return run;
    },
    ready: () => sorted(),
    readyWith: (read) => inView(async () => ({ ready: sorted(), value: await read(), making: [...inFlight.keys()].filter((id) => !ready.has(id)) })),
    take(noteId, attempt, early, lastHeight, nullifier) {
      return takeIn([{ noteId, attempt }], early, lastHeight, nullifier).then((x) => x[0]!);
    },
    takeSet(items, early, lastHeight) {
      if (!Array.isArray(items) || items.length === 0 || new Set(items.map((x) => x.noteId)).size !== items.length || items.some((x) => typeof x.attempt !== "string")) {
        return Promise.reject(new Error("takeSet: one or more notes, each once, each with its attempt"));
      }
      return takeIn(items, early, lastHeight);
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
