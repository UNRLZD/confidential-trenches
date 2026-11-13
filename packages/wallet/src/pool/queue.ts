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
// - Pieces (card buy-spends-several-pieces): a pool with piecesMax above 1 (Solana) lets one buy pay one W from several
//   notes, in two tiers. Tier 1 is the ready set above, each note's proof bound to its own W (ReadyProof.own), so a buy
//   one note pays is one piece and back-to-back buys each take a ready proof. Tier 2 is made in the same pass: the
//   primary is the note with the largest chunk (ties: the earlier leaf) of the ready set as the pass leaves it, and each
//   of the piecesMax - 1 largest other landed notes of the pool (UNSPENT, or HELD by this queue) gets a second proof
//   bound to the primary's W. The order (card max-ready-seconds-after-a-load): first what raises Max, the primary's own
//   proof and then its tier 2 proofs, so Max stands after min(usable notes, piecesMax) proofs; then the remakes (a
//   newest-root one first, then Max's set); then the other notes' own proofs. A tier 2 proof waits for the primary's own:
//   none is made while the primary has no ready proof. A buy past every single note spends the primary's own proof and some of these (the signing
//   page's pick), so every W a buy pays is still the own W of a note it spent: the restore finds it as before
//   (./buy-wallets.ts). A note can so hold two unsent proofs at once, its tier 1 and its tier 2 (the store's second
//   attempt, notes/store.ts); taking either drops the other in the same store write, and the queue lets it go. After a
//   take, the other notes' tier 1 proofs stay ready as they are; at the next pass a tier 2 proof bound to
//   another W than the new primary's (or of an earlier epoch) is made again, kept meanwhile as a remake's, and one whose
//   note left the room (the primary's own among them) is let go, its note still HELD by its tier 1 proof.
// - One proof per note per tier: only an UNSPENT note, or one this queue holds by its other tier's proof, is proved,
//   passes run one after another, and the store's compare-and-set moves (UNSPENT -> HELD, a second attempt on a note
//   held by this attempt) refuse a note another tab or pass holds. The context goes on the note with that move, before
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
import { heldBy, type NoteRecord, type NoteStore } from "../notes/store.ts";
import { checkLadder, chunkOf } from "./ladder.ts";
import { checkBinding, checkPool, failAs, NEWEST_GRACE_MS, PassFail, NOW_REUSE_MS, TAKE_SLACK_MS, type ChainNow, type PassReason, type Pool, type PoolTrees, type ReadyProof } from "./pool.ts";

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
  /** The device's monotonic clock in ms; by default performance.now (a test moves it). */
  monotonic?: () => number;
};

/** What one pass did: the notes it proved, the notes whose proof was made again, and each failure. */
export { PassFail, type PassReason } from "./pool.ts";
// a bind's read that got no answer keeps its own error (callers read its class: a throttle's wait, an EVM read's
// EvmUnansweredError), so the pass names it by that class: "network", never the fee_refused of a refusal
const UNANSWERED = new Set(["SolanaRpcTransportError", "EvmUnansweredError", "EvmOperatorsUnanswered", "EvmLagError", "TimeoutError"]);
const bindFail = (e: unknown): never => failAs(UNANSWERED.has(String((e as { name?: unknown } | null)?.name)) ? "network" : "fee_refused")(e);
/** `small`: the pool's UNSPENT landed notes below its smallest rung, never proved (none: absent). */
export type QueuePass = { made: string[]; remade: string[]; failed: { noteId: string; error: string; reason?: PassReason }[]; small?: number };
const NOTHING = (): QueuePass => ({ made: [], remade: [], failed: [] });

export interface ProofQueue<R> {
  /** One pass: lets go of proofs whose note moved, makes again proofs of an earlier epoch (each stays ready until its new
   * one replaces it), proves notes that have no tier 1 proof, and with piecesMax above 1 makes tier 2 for the primary,
   * in the order "Pieces" above names. Passes run one after another. Each bind takes the pass's read of the pool's time
   * while it stands (pool.ts bindNow), and a bind that reads its own hands its read to the binds after it. */
  refresh(signal?: AbortSignal): Promise<QueuePass>;
  /** The proofs ready now that take() would hand out (proofLate: none late at the pool's time as this queue last read it,
   * plus the device's time since), both tiers, in leaf order (a note's tier 1 proof before its tier 2 one). A late one
   * stays out until its remake replaces it, so no screen offers, and no pick takes, a proof the tap is refused. */
  ready(): ReadyProof<R>[];
  /** ready() at the time the take reads (takeNow: `early`'s ms plus the time since while it stands, else the pool's time
   * read here): the list a pick that goes on to take() picks from, on the take's own clock. */
  readyAt(early?: Promise<ChainNow>): Promise<ReadyProof<R>[]>;
  /** ready() with `read`'s answer (the caller's read of the notes), both in one turn that no swap's write and ready list
   * update falls inside: the list and the notes agree on each note's attempts. `making`: the notes a proof is being made
   * for now (card buy-spends-several-pieces: state.pools' making counts those with none ready), and each note whose
   * every ready proof is late, made again at the next pass. */
  readyWith<T>(read: () => Promise<T>): Promise<{ ready: ReadyProof<R>[]; value: T; making: string[] }>;
  /** At the tap: refused (and its attempt let go) for a proof made before the previous epoch, a newest-root proof past
   * the next boundary + NEWEST_GRACE_MS, or one with less than sendMarginMs + TAKE_SLACK_MS left; else HELD -> RESERVED,
   * then it is handed out. With `attempt` (the ready proof the caller built its transaction on: either tier's), refused
   * in the note's turn, before any write, when the note's ready proof is another attempt (a remake swapped it in
   * meanwhile, or the note's other proof was taken): the note stays as it was, never RESERVED for bytes no one sends.
   * Without it, the note's tier 1 proof (else its tier 2 one). The note's other proof goes with the HELD -> RESERVED
   * write (notes/store.ts) and from the ready list. `early` (card sol-buy-reads-side-by-side): the pool's time read
   * before the take (chainNow), its ms plus the time since its start (ChainNow: the larger of the device's two clocks',
   * both within NOW_REUSE_MS); else, or when that read failed, the pool's time is read here. `lastHeight`: the height
   * past which the one transaction the caller signed on this proof can no longer land (a Solana blockhash's);
   * `nullifier`: the proof's (an EVM buy's). Each written on the note's mark with HELD -> RESERVED, never in the note
   * (notes/store.ts ReservedMark). */
  take(noteId: string, attempt?: string, early?: Promise<ChainNow>, lastHeight?: bigint, nullifier?: bigint): Promise<ReadyProof<R>>;
  /** take() of several notes at once, for one bundle of transactions that lands whole or not at all (card
   *  buy-spends-several-pieces): every note's turn held together, every refusal decided before any write, so a set
   *  refused leaves none RESERVED (a late proof's attempt let go and made again, as take() does; the others HELD, their
   *  proofs ready). Then each HELD -> RESERVED in order, with `lastHeight` on each one's mark. A write that fails there
   *  lets its own attempt go and throws: the ones written before it stay RESERVED for transactions that never left the
   *  device, and the state reads free them once both RPCs' finalized height is past `lastHeight`
   *  (solana-restore.ts solanaSettleReserved). */
  takeSet(items: readonly { noteId: string; attempt: string }[], early?: Promise<ChainNow>, lastHeight?: bigint): Promise<ReadyProof<R>[]>;
  /** The note's proofs are dropped and it goes back to UNSPENT. */
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

/** Why a ready proof is too late to take at the pool's time `nowMs` (it is made again first), or undefined: one made
 *  before the previous epoch, a newest-root proof NEWEST_GRACE_MS past its epoch's end, or one with less than the send
 *  margin + TAKE_SLACK_MS left. take() refuses on it, and ready() leaves out what it names. */
export function proofLate(r: Pick<ReadyProof<unknown>, "epochStartMs" | "root" | "deadlineMs">, nowMs: bigint, pool: Pick<Pool<unknown>, "epochMs" | "sendMarginMs">): string | undefined {
  return nowMs - (nowMs % pool.epochMs) > r.epochStartMs + pool.epochMs
    ? "is from before the previous epoch"
    : r.root === "newest" && nowMs >= r.epochStartMs + pool.epochMs + NEWEST_GRACE_MS
      ? `is on the newest root and its epoch ended over ${NEWEST_GRACE_MS} ms ago`
      : r.deadlineMs - nowMs < pool.sendMarginMs + TAKE_SLACK_MS
        ? `has less than the send margin + ${TAKE_SLACK_MS} ms left`
        : undefined;
}

export function openProofQueue<R>(a: ProofQueueArgs<R>): ProofQueue<R> {
  if (!(a.seed64 instanceof Uint8Array) || a.seed64.length !== 64) throw new Error("seed64: not 64 bytes");
  checkPool(a.pool as Pool);
  checkLadder(a.pool.ladder);
  if (!Array.isArray(a.provers) || a.provers.length === 0) throw new Error("provers: at least one");
  const seed = Uint8Array.from(a.seed64);
  const { notes, pool } = a;
  const inFront = a.inFront ?? notHidden;
  const mono = a.monotonic ?? (() => performance.now());
  // the pool's latest time this queue read (a pass's start, a take's own read), on both device clocks at the read's start
  let seen: { ms: bigint; at: number; wall: number } | undefined;
  const readNow = async (signal?: AbortSignal): Promise<bigint> => {
    const at = mono();
    const wall = Date.now();
    const ms = await pool.now(signal);
    if (typeof ms === "bigint" && (seen === undefined || ms >= seen.ms)) seen = { ms, at, wall };
    return ms;
  };
  // the pool's time now as ready() takes it: the last read plus the larger of the two clocks' time since (a sleep stops
  // the monotonic one; counting from the read's start only makes it later, so a proof leaves the list early, never late)
  const nowSeen = (): bigint | undefined => (seen === undefined ? undefined : seen.ms + BigInt(Math.max(0, Math.ceil(Math.max(mono() - seen.at, Date.now() - seen.wall)))));
  const provers = a.provers.slice(0, proofPoolSize(a.hardwareConcurrency));
  const readySize = readySetSize(a.hardwareConcurrency);
  const altRoom = Math.max(0, (pool.piecesMax ?? 1) - 1); // tier 2's notes at most
  // the W a tier 2 proof pays: the primary note's own
  type To = { l: bigint; j: number; address: string };
  const ready = new Map<string, ReadyProof<R>>(); // tier 1, by note
  const alt = new Map<string, ReadyProof<R>>(); // tier 2, by note
  // a note whose proof is being made; `attempt`: a fresh proof's, once its note is held
  const inFlight = new Map<string, { dropped: boolean; attempt?: string }>();
  const order = new Map<string, bigint>(); // a note's leaf index, for ready()'s leaf order
  const unfreed = new Map<string, string>(); // an attempt whose free failed -> its note, tried again each pass
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
  // lets one attempt go: that attempt alone while another of this queue holds the note too (its other tier's proof,
  // ready or being made), else the note HELD -> UNSPENT
  const free = async (id: string, attempt: string): Promise<void> => {
    const other = [ready.get(id)?.attempt, alt.get(id)?.attempt, inFlight.get(id)?.attempt].some((x) => x !== undefined && x !== attempt);
    try {
      if (other) await notes.release(id, attempt);
      else await notes.move(id, "HELD", "UNSPENT", { attempt });
      unfreed.delete(attempt);
    } catch {
      const n = await notes.get(id).catch(() => undefined);
      if (n === undefined || !heldBy(n, attempt)) unfreed.delete(attempt); // someone else moved it
      else unfreed.set(attempt, id);
    }
  };
  /** The tier `r` is ready in. */
  const tierOf = (r: ReadyProof<R>): Map<string, ReadyProof<R>> => (ready.get(r.noteId) === r ? ready : alt);
  /** Lets the note's proof of one tier go, in the note's turn. */
  const letGoOf = async (m: Map<string, ReadyProof<R>>, id: string): Promise<void> => {
    const r = m.get(id);
    if (r === undefined) return;
    m.delete(id);
    await free(id, r.attempt);
  };
  /** Lets both of the note's proofs go (tier 2's first, so tier 1's free frees the note), in the note's turn. */
  const letGo = async (id: string): Promise<void> => {
    await letGoOf(alt, id);
    await letGoOf(ready, id);
  };
  /** The note's ready proof of `attempt` when it is its tier 2 one, else its tier 1 proof, else its tier 2 one. */
  const proofOf = (id: string, attempt?: string): ReadyProof<R> | undefined => {
    const p = alt.get(id);
    return p !== undefined && p.attempt === attempt ? p : (ready.get(id) ?? p);
  };
  const epochOf = (t: bigint): bigint => t - (t % pool.epochMs);

  // A fresh proof (prev undefined) holds its note first: UNSPENT -> HELD, or, on a note this queue holds by its other
  // tier's proof, a second attempt beside that one. A remake (prev: the note's proof of this tier, of an earlier epoch
  // or, in tier 2, to another W) leaves prev ready and the note HELD while it proves, then replaces prev in one write.
  // `to`: tier 2's W (the primary's own), null for tier 1 (this note's own W).
  async function prove(n: NoteRecord, prover: VaultProver, trees: PoolTrees, root: "epoch" | "newest", epochStartMs: bigint, prev: ReadyProof<R> | undefined, to: To | null, signal?: AbortSignal): Promise<void> {
    const flight = inFlight.get(n.id)!;
    const tier = to === null ? ready : alt;
    const leaf = n.leaf!;
    const chunk = chunkOf(pool.ladder, leaf.value)!;
    const j = jOf(n.ref);
    const wl = to === null ? leaf.label : to.l;
    const wj = to === null ? j : to.j;
    const w = freshWallet(seed, pool.chain, wl, wj);
    w.secretKey.fill(0);
    const deadlineMs = epochStartMs + pool.lifeMs;
    const refundPrecommitment = noteSecrets(seed, { kind: "refund", l: leaf.label, j }).precommitment;
    // the pool's time this queue last read (the pass's own read, a take's or a bind's), for the bind's send-margin guard:
    // the bind takes it while it stands (pool.ts bindNow) and reads its own once it is too old or the epoch may have
    // turned, which the binds after it then take
    const now = seen === undefined ? undefined : { ms: seen.ms, at: performance.now() - (mono() - seen.at), wall: seen.wall };
    const readNowOf = (c: ChainNow): void => {
      if (seen === undefined || c.ms >= seen.ms) seen = { ms: c.ms, at: mono() - (performance.now() - c.at), wall: c.wall };
    };
    const binding = await pool.bind({ chunk, wallet: { address: w.address, publicKey: w.publicKey }, refundPrecommitment, epochStartMs, deadlineMs, ...(now === undefined ? {} : { now }), readNow: readNowOf }, signal).catch(bindFail);
    try {
      checkBinding(pool as Pool, binding, chunk);
    } catch (e) {
      failAs("fee_refused")(e);
    }
    live();
    const context = binding.context.toString();
    // a fresh proof: the note is HELD by this attempt, with its context, before the proof starts; a failed write stops
    // here. A remake writes its context with the swap below, before its proof can be taken.
    let attempt: string | undefined;
    if (prev === undefined) {
      const other = (to === null ? alt : ready).get(n.id);
      attempt = other === undefined ? (await notes.move(n.id, "UNSPENT", "HELD", { deadlineMs, context }).catch(failAs("held_elsewhere"))).attempt! : (await notes.holdSecond(n.id, other.attempt, { deadlineMs, context }).catch(failAs("held_elsewhere"))).second!.attempt;
      flight.attempt = attempt;
    }
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
      }).catch(failAs("prover_failed"));
      // the kit refused any answer whose 8 signals are not this input's: the chunk, the trees' roots and the context
      live();
      if (flight.dropped) throw new Error("dropped while it was proved");
      const made = (holder: string): ReadyProof<R> => ({
        noteId: n.id,
        attempt: holder,
        poolId: pool.id,
        wallet: { chain: pool.chain, l: wl, j: wj, path: w.path, address: w.address },
        ...(to === null ? { own: true as const } : {}),
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
        tier.set(n.id, made(attempt));
        return;
      }
      // the swap: only while prev is still the note's proof of this tier (not taken, dropped or freed meanwhile); one
      // write replaces prev's attempt and context with this one's, the note HELD throughout, its other attempt as it was
      await onNote(n.id, async () => {
        if (closed || flight.dropped || tier.get(n.id) !== prev) throw new Error("taken or dropped while it was made again: this proof is never sent");
        // the new attempt's write and the ready list's update in one turn of the view: no readyWith read between them
        await inView(async () => {
          const held = await notes.move(n.id, "HELD", "HELD", { attempt: prev!.attempt, deadlineMs, context }).catch(failAs("held_elsewhere"));
          tier.set(n.id, made(held.second?.context === context ? held.second.attempt : held.attempt!));
        });
      });
    } catch (e) {
      if (attempt !== undefined) await free(n.id, attempt);
      throw e;
    }
  }

  type Todo = { n: NoteRecord; trees: PoolTrees; root: "epoch" | "newest"; prev?: ReadyProof<R>; to?: To };

  async function pass(signal?: AbortSignal): Promise<QueuePass> {
    live();
    const out = NOTHING();
    // a note in skip (a withdraw planned it, any tab's) is let go, in front or not: its ready proofs freed, one in flight never kept
    // a.skip and notes.list below are the device's own store: no pool step a walk tells apart (a closed or broken store
    // fails every read the same), so their throw stays untagged and prints no line
    const skipped = (await a.skip?.()) ?? new Set<string>();
    for (const id of skipped) {
      const f = inFlight.get(id);
      if (f !== undefined) f.dropped = true;
      if (ready.has(id) || alt.has(id)) await onNote(id, () => letGo(id));
    }
    if (!inFront()) return out;
    const nowMs = await readNow(signal).catch(failAs("network"));
    if (typeof nowMs !== "bigint" || nowMs < 0n) throw new PassFail("network", new Error(`pool ${pool.id}: now is not a bigint`));
    const start = epochOf(nowMs);
    for (const [attempt, id] of [...unfreed]) await free(id, attempt);
    // let go of proofs whose attempt no longer holds its note; those of an earlier epoch stay ready (and HELD) until remade
    const all = await notes.list();
    const byId = new Map(all.map((n) => [n.id, n]));
    for (const m of [ready, alt])
      for (const r of [...m.values()]) {
        const n = byId.get(r.noteId);
        if (n === undefined || !heldBy(n, r.attempt)) m.delete(r.noteId);
      }
    const byChunk = byChunkThenLeaf(pool.ladder);
    const usable = (n: NoteRecord): boolean => n.scope === pool.scope && n.leaf !== undefined && chunkOf(pool.ladder, n.leaf.value) !== null && !skipped.has(n.id);
    const small = all.filter((n) => n.scope === pool.scope && n.state === "UNSPENT" && n.leaf !== undefined && chunkOf(pool.ladder, n.leaf.value) === null).length;
    if (small > 0) out.small = small;
    // tier 1: a note with no tier 1 proof, UNSPENT or held by its tier 2 proof
    const open = all.filter((n) => usable(n) && !ready.has(n.id) && (n.state === "UNSPENT" || (n.state === "HELD" && alt.has(n.id)))).sort(byChunk);
    const again: NoteRecord[] = [];
    for (const r of ready.values()) if (r.epochStartMs < start) again.push(byId.get(r.noteId)!);
    const want = readySize - ready.size + again.length;
    let epochTrees: PoolTrees | undefined;
    // the newest trees, read once for every note of this pass that landed this epoch; a failed read fails those notes
    // only, and the epoch's remakes and the epoch's notes still run
    let newest: PoolTrees | Error | undefined;
    const t1: Todo[] = [];
    if (want > 0 && (open.length > 0 || again.length > 0)) {
      epochTrees = await pool.trees(start, signal).catch(failAs("network"));
      // the ready set's own notes first (each landed before the epoch began), then the open notes, up to the ready set
      // a take or a drop during the epoch-tree read above removes a ready proof: that note is left out of the remakes
      for (const n of again.filter((x) => ready.has(x.id))) t1.push({ n, trees: epochTrees, root: "epoch", prev: ready.get(n.id)! });
      for (const n of open) {
        if (t1.length === want) break;
        if (n.leaf!.leafIndex < BigInt(epochTrees.stateTree.size)) t1.push({ n, trees: epochTrees, root: "epoch" });
        else {
          newest ??= await pool.trees(nowMs + 1n, signal, { newest: true }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))); // every leaf up to now
          if (newest instanceof Error) out.failed.push({ noteId: n.id, error: msg(newest), reason: "network" });
          // a leaf past the pool's time (its landing read before both RPCs' final block reached it) waits for the next pass
          else if (n.leaf!.leafIndex < BigInt(newest.stateTree.size)) t1.push({ n, trees: newest, root: "newest" });
        }
      }
    }
    // tier 2, in the same pass (card max-ready-seconds-after-a-load): the primary is the note with the largest chunk
    // (ties: the earlier leaf) of the ready set as this pass leaves it (its ready proofs and the ones it makes); the
    // altRoom largest other notes (UNSPENT, or held by this queue) each get a proof to its W. A tier 2 proof of a note out
    // of that room (the primary's own among them) is let go, its note still HELD by its tier 1 proof if it has one; one
    // to another W or of an earlier epoch is made again, kept ready meanwhile.
    const t2: Todo[] = [];
    let pid: string | undefined;
    if (altRoom > 0) {
      const set = new Map<string, NoteRecord>();
      for (const r of ready.values()) {
        const n = byId.get(r.noteId);
        if (n !== undefined) set.set(n.id, n);
      }
      for (const t of t1) set.set(t.n.id, t.n);
      const p = [...set.values()].sort(byChunk)[0];
      pid = p?.id;
      let to: To | undefined;
      let kept: NoteRecord[] = [];
      if (p !== undefined) {
        const j = jOf(p.ref);
        const w = freshWallet(seed, pool.chain, p.leaf!.label, j);
        w.secretKey.fill(0);
        to = { l: p.leaf!.label, j, address: w.address };
        kept = all.filter((n) => usable(n) && n.id !== p.id && (n.state === "UNSPENT" || (n.state === "HELD" && (ready.has(n.id) || alt.has(n.id))))).sort(byChunk).slice(0, altRoom);
      }
      const room = new Set(kept.map((n) => n.id));
      for (const id of [...alt.keys()]) if (!room.has(id)) await onNote(id, () => letGoOf(alt, id));
      for (const n of kept) {
        const r = alt.get(n.id);
        if (r !== undefined && r.epochStartMs === start && r.wallet.address === to!.address) continue;
        epochTrees ??= await pool.trees(start, signal).catch(failAs("network"));
        let trees: PoolTrees = epochTrees;
        let root: "epoch" | "newest" = "epoch";
        if (n.leaf!.leafIndex >= BigInt(epochTrees.stateTree.size)) {
          newest ??= await pool.trees(nowMs + 1n, signal, { newest: true }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
          if (newest instanceof Error) {
            if (!out.failed.some((f) => f.noteId === n.id)) out.failed.push({ noteId: n.id, error: msg(newest), reason: "network" });
            continue;
          }
          if (n.leaf!.leafIndex >= BigInt(newest.stateTree.size)) continue; // waits for the next pass
          trees = newest;
          root = "newest";
        }
        t2.push({ n, trees, root, ...(r === undefined ? {} : { prev: r }), to: to! });
      }
    }
    // the order (card max-ready-seconds-after-a-load): first what raises Max, the primary's own proof when it has none,
    // then its tier 2 proofs that have none to its W; then the remakes, a newest-root proof first (take refuses it
    // NEWEST_GRACE_MS past the boundary, an epoch-root one stays takeable all epoch), then Max's set, then by chunk and
    // leaf; then the other notes' own proofs. So Max stands after min(usable notes, piecesMax) proofs, and a remake
    // never leaves Max's set late behind the rest.
    const raises = (t: Todo): boolean => t.prev === undefined || (t.to !== undefined && t.prev.wallet.address !== t.to.address);
    const inSet = (t: Todo): boolean => t.to !== undefined || t.n.id === pid;
    const remakes = [...t1, ...t2].filter((t) => !raises(t)).sort((x, y) => {
      const a = x.prev!.root === "newest", b = y.prev!.root === "newest";
      if (a !== b) return a ? -1 : 1;
      if (inSet(x) !== inSet(y)) return inSet(x) ? -1 : 1;
      return byChunk(x.n, y.n);
    });
    const todo: Todo[] = [...t1.filter((t) => raises(t) && t.n.id === pid), ...t2.filter(raises), ...remakes, ...t1.filter((t) => raises(t) && t.n.id !== pid)];
    let k = 0;
    const lane = async (prover: VaultProver): Promise<void> => {
      for (let t = todo[k++]; t !== undefined; t = todo[k++]) {
        if (closed || signal?.aborted) return;
        // a tier 2 proof pays the primary's W: none while the primary has no ready proof of its own (it failed)
        if (t.to !== undefined && (pid === undefined || !ready.has(pid))) continue;
        inFlight.set(t.n.id, { dropped: false });
        try {
          await prove(t.n, prover, t.trees, t.root, start, t.prev, t.to ?? null, signal);
          (t.prev !== undefined ? out.remade : out.made).push(t.n.id);
        } catch (e) {
          out.failed.push({ noteId: t.n.id, error: msg(e), ...(e instanceof PassFail ? { reason: e.reason } : {}) });
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
    return readNow();
  };
  const lateOf = (r: ReadyProof<R>, nowMs: bigint): string | undefined => proofLate(r, nowMs, pool);
  /** Each note HELD -> RESERVED in the order given; a write that fails lets its own attempt go and throws. The store
   *  drops the note's other attempt in that write, so its other proof leaves the ready list (and one being made is
   *  never kept). */
  const reserve = async (rs: readonly ReadyProof<R>[], lastHeight: bigint | undefined, nullifier?: bigint): Promise<void> => {
    for (const r of rs) {
      tierOf(r).delete(r.noteId);
      try {
        await notes.move(r.noteId, "HELD", "RESERVED", { attempt: r.attempt, ...(lastHeight === undefined ? {} : { lastHeight }), ...(nullifier === undefined ? {} : { nullifier }) });
      } catch (e) {
        await free(r.noteId, r.attempt);
        throw e;
      }
      ready.delete(r.noteId);
      alt.delete(r.noteId);
      const f = inFlight.get(r.noteId);
      if (f?.attempt !== undefined) f.dropped = true;
    }
  };
  // leaf order; of one note, its tier 1 proof first
  const sorted = (): ReadyProof<R>[] =>
    [...ready.values(), ...alt.values()].sort((x, y) => {
      const a = order.get(x.noteId)!, b = order.get(y.noteId)!;
      return a !== b ? (a < b ? -1 : 1) : x.own === true ? -1 : y.own === true ? 1 : 0;
    });
  /** The ready proofs takeable at `nowMs` and NOW_REUSE_MS past it (none late), and the notes whose every ready proof is
   *  late: a list leaves a proof the reuse window before take() would refuse it, so the pick's own reads, signing and
   *  writes between the pick and the take never meet a proof that went late meanwhile (review P3-1 of b57f4eb28); take()
   *  keeps the exact rule. */
  const takeableAt = (nowMs: bigint | undefined): { ready: ReadyProof<R>[]; late: string[] } => {
    const all = sorted();
    if (nowMs === undefined) return { ready: all, late: [] };
    const ok = all.filter((r) => lateOf(r, nowMs + BigInt(NOW_REUSE_MS)) === undefined);
    const kept = new Set(ok.map((r) => r.noteId));
    return { ready: ok, late: [...new Set(all.filter((r) => !kept.has(r.noteId)).map((r) => r.noteId))] };
  };
  return {
    refresh(signal) {
      const run = passes.then(() => pass(signal));
      passes = run.catch(() => undefined);
      return run;
    },
    ready: () => takeableAt(nowSeen()).ready,
    readyAt: async (early) => takeableAt(await takeNow(early)).ready,
    readyWith: (read) =>
      inView(async () => {
        const t = takeableAt(nowSeen());
        return { ready: t.ready, value: await read(), making: [...new Set([...inFlight.keys(), ...t.late])] };
      }),
    take(noteId, attempt, early, lastHeight, nullifier) {
      live();
      return onNote(noteId, async () => {
        live();
        const r = proofOf(noteId, attempt);
        if (r === undefined) throw new Error(`no ready proof for note ${noteId}`);
        if (attempt !== undefined && r.attempt !== attempt) throw new Error(`note ${noteId}'s ready proof is another attempt: it was made again, so it is not taken`);
        const nowMs = await takeNow(early);
        const why = lateOf(r, nowMs);
        if (why !== undefined) {
          tierOf(r).delete(noteId);
          await free(noteId, r.attempt);
          throw new Error(`the proof for note ${noteId} ${why}: it is made again first`);
        }
        await reserve([r], lastHeight, nullifier);
        return r;
      });
    },
    // take() of several notes: their turns held together (taken in id order, so two sets never wait on each other),
    // every refusal before any write, then each HELD -> RESERVED in the order given
    takeSet(items, early, lastHeight) {
      if (!Array.isArray(items) || items.length === 0 || new Set(items.map((x) => x.noteId)).size !== items.length || items.some((x) => typeof x.attempt !== "string")) {
        return Promise.reject(new Error("takeSet: one or more notes, each once, each with its attempt"));
      }
      live();
      const ids = items.map((x) => x.noteId).sort();
      const inTurns = (k: number, f: () => Promise<ReadyProof<R>[]>): Promise<ReadyProof<R>[]> => (k === ids.length ? f() : onNote(ids[k]!, () => inTurns(k + 1, f)));
      return inTurns(0, async () => {
        live();
        const rs = items.map(({ noteId, attempt }) => {
          const r = proofOf(noteId, attempt);
          if (r === undefined) throw new Error(`no ready proof for note ${noteId}`);
          if (r.attempt !== attempt) throw new Error(`note ${noteId}'s ready proof is another attempt: it was made again, so it is not taken`);
          return r;
        });
        const nowMs = await takeNow(early);
        const late = rs.map((r) => lateOf(r, nowMs));
        const at = late.findIndex((why) => why !== undefined);
        if (at >= 0) {
          // every late proof's attempt let go, to be made again; the set's others stay HELD with their proofs ready
          for (const [k, why] of late.entries()) {
            if (why === undefined) continue;
            tierOf(rs[k]!).delete(rs[k]!.noteId);
            await free(rs[k]!.noteId, rs[k]!.attempt);
          }
          throw new Error(`the proof for note ${rs[at]!.noteId} ${late[at]}: it is made again first`);
        }
        await reserve(rs, lastHeight);
        return rs;
      });
    },
    async drop(noteId) {
      const f = inFlight.get(noteId);
      if (f !== undefined) f.dropped = true;
      await onNote(noteId, () => letGo(noteId)); // a failed write is tried again at the next pass
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const f of inFlight.values()) f.dropped = true;
      // each in its note's turn, so a swap already writing finishes first and its new attempt is the one freed
      for (const id of new Set([...ready.keys(), ...alt.keys()])) await onNote(id, () => letGo(id));
      seed.fill(0);
      await passes; // a proof still being made sees the queue closed and frees its own note
    },
  };
}
