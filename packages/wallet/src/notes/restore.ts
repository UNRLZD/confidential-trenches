// Restore of notes from the 12 words and the vault's public pages (card wallet-restore-notes, lane W2.5;
// docs/plan1/wallet.md §2.3 "Restore" steps 2-3 l.263-276, Secrets l.176-192, the deposit index rule l.346-356, device
// lanes l.245-254, the change index l.116-124, the held note l.392; P-03 l.1067).
//
// - Step 2: the vault's deposits, spends and leaves, read whole, page by page, through the kit's vaultSync on two RPCs
//   that must agree byte for byte at one block (06b §6.2, the vault paper 2.5.6). Only views are read, never a receipt
//   or its logs, so a refused deposit (which logs nothing and writes no row) is never seen. No request names a note:
//   every read is a page (from, limit), and the matching happens here, on the device. Then config() at each RPC's
//   final block: equal bytes, its scope the one computed from (vault, token) and its asset the token, so a wrong token
//   cannot give an empty restore that looks valid; both final heights are returned for step 7's wait.
// - Step 3, the deposit index walk: in each of the 8 lanes, deposit indices i = lane, lane + 8, ... are derived and
//   matched against the deposits' precommitments, with no request, until RESTORE_GAP indices of that lane in a row
//   have no note (the lane rule, l.252: every "in a row" counts within one lane). A note found resets only its own
//   lane's count. The lanes are independent: a caller may run walkLane in the proof pool's workers and hand each lane's
//   walk in (restoreNotes `walk`, which is given the lane, scope and gap the restore checks; restorePages `lanes`). A
//   walk handed in must name its lane's own indices, ascending, each one matched again here, and the last index it read
//   with that index's precommitment, recomputed here: so a walk on another scope or seed, or one that stopped before
//   `gap` misses past its last note, stops the restore instead of returning fewer notes.
// - Every note found is followed: its nullifier hash into the spends; for a withdrawal (l, j) of ours (l its label, j 0
//   for the first note of a label, k + 1 for change note k): change note j, which must be the leaf the spend names
//   unless the spend is a ragequit (context 0, which inserts no change); the refund note once settle has written it (a
//   refund still pending is handed back to be settled), and any refund of value on a precommitment that is not
//   refund note (l, j) stops the restore, so a drift in either derivation never loses a note quietly; the move note of V_{l,j},
//   the return note of R_{c,l,j} on all six chain tags, and the second arrivals of U_{s,i}, V_{l,j}, A_{l,j} and each
//   R_{c,l,j}, each walked from n = 0 to the first miss. Every note found that way is followed the same way.
// - States: SPENT once its nullifier hash is in the spends (any status: the vault never un-spends), else UNSPENT. HELD
//   and RESERVED live only in the lost device's store, so a restore finds such a note UNSPENT (l.392); a proof the lost
//   store sent can still land, and the spends of a later sync then show it.
// - Every input is hostile: a deposit row whose commitment is not the state tree's leaf at its index, a change or
//   refund leaf at another index than its spend names, or a precommitment or nullifier hash the vault holds twice
//   stops the restore with nothing returned.
// - Keys stay here: seed64 is the caller's and is never copied; the masters and note secrets are bigints, which JS
//   cannot zero, as in ../derive. Nothing here logs or sends a secret: the only requests are vaultSync's page reads.
import {
  VAULT_SYNC_LAG_MAX,
  vaultScopeOf,
  vaultSync,
  vaultSyncStart,
  type VaultDepositRow,
  type VaultSpendRow,
  type VaultSyncCursor,
  type VaultSyncRpc,
} from "@blindfill/kit";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { nearPairNetwork, nearPairRule } from "../deposit/account.ts";
import { CHAINS, type Chain, masters, type SecondId } from "../derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "./secrets.ts";
import { refKey, type Landed, type Leaf, type NoteRecord, type NoteState, type NoteStore } from "./store.ts";

/** Indices of one lane in a row with no note before the deposit index walk stops (wallet.md l.271-272). */
export const RESTORE_GAP = 10_000;
/** The device lanes: a device names only deposit indices ≡ d (mod 8) (wallet.md l.249-250). */
export const RESTORE_LANES = 8;

/**
 * The seed opened for one use only: `use` runs on it and it is zeroed after (the signing page opens it under the seed
 * lock for that use alone, so a restore's reads never hold the lock; card wallet-restore-id-reader-wired, review P2-2).
 * `use` is synchronous: nothing of the seed outlives it.
 */
export type SeedUse = <T>(use: (seed64: Uint8Array) => Sync<T>) => Promise<T>;
/** A use's result that is no promise: a use that awaits would hold the seed past its end (review of e31892ef, P3-5). */
export type Sync<T> = T extends PromiseLike<unknown> ? never : T;
/** `use` on the seed: a SeedUse opens it for that use; a seed given as bytes is the caller's to hold and zero. */
export function withSeed<T>(seed: Uint8Array | SeedUse, use: (seed64: Uint8Array) => Sync<T>): Promise<T> {
  return typeof seed === "function" ? seed(use) : Promise.resolve().then(() => use(seed));
}
const U32 = 0xffffffff;
const CHAIN_TAGS = /* @__PURE__ */ Object.keys(CHAINS) as Chain[];

/** A note restore found, as the device writes it: its ref, scope, precommitment and leaf, and its state. */
export type RestoredNote = {
  ref: NoteRef;
  scope: bigint;
  precommitment: bigint;
  leaf: Leaf;
  state: "UNSPENT" | "SPENT";
  /** a change or refund note: the refKey of the note whose withdrawal made it */
  parent?: string;
  /** an EVM pool note whose leaf is in a block above the round's finalized one (../pool/evm-restore.ts) */
  landed?: Landed;
};
/** A spend of one of our notes: the withdrawal (l, j) and the vault's row for it. */
export type RestoredSpend = { l: bigint; j: number; note: string; spend: VaultSpendRow };

export type NoteRestore = {
  /** the block every page was read at: the lower of the two RPCs' final heights */
  height: number;
  /** both RPCs' final heights read after the pages, in rpcs order (step 7's wait starts from the higher) */
  finalHeights: [number, number];
  blockHash: string;
  /** the next sync's start (every list read to its end at `height`) */
  cursor: VaultSyncCursor;
  /** every note found, each parent before its children */
  notes: RestoredNote[];
  /** every withdrawal of ours, in spend order */
  spends: RestoredSpend[];
  /** our withdrawals whose refund is refund_pending: settle them, and the next restore finds the refund note */
  pendingRefunds: RestoredSpend[];
  /** per lane, the highest deposit index with a note, or null for an empty lane (steps 5 and 7 start from it) */
  laneHighest: (number | null)[];
  /** per lane, the last index the walk read (gap past its last note or its reach): step 5 holds its ids to it */
  laneWalked: number[];
};

export type RestoreArgs = {
  /** the store's seed64 (from the 12 words); read, never copied or kept */
  seed64: Uint8Array;
  vault: string;
  /** the vault's token: the scope is computed from the vault and its token as the vault computes it */
  token: string;
  /** two RPCs of different operators: a network's release pair, each named by its URL (../deposit/account.ts nearPairNetwork) */
  rpcs: readonly [VaultSyncRpc, VaultSyncRpc];
  signal?: AbortSignal;
  /** tests only: RESTORE_GAP unless given */
  gap?: number;
  /**
   * Per lane, the index the walk reads to at least before its gap counts (null: none), as step 5's walk-end error
   * names it ("restore again with reach[lane] = i"): a user whose ids with history run past the walk's end restores
   * again with it, and hands the same reach to restoreDepositIds.
   */
  reach?: readonly (number | null)[];
  /**
   * The deposit index walk of one lane, run where the caller likes (the proof pool's workers): walkLane(seed64, scope,
   * lane, p => precommitments.has(p), gap, reach) for exactly the lane, scope, gap and reach given. walkLane on this
   * thread unless given.
   */
  walk?: (lane: number, scope: bigint, gap: number, precommitments: ReadonlySet<bigint>, reach: number | null) => Promise<LaneWalk>;
  /**
   * The height the vault's pages are read at or above (vaultSync's cursor.height: "behind" below it), 0 unless given.
   * Step 7's second scan (../restore/after.ts secondScan) reads them at or past its bound block.
   */
  atLeast?: number;
};

/** Steps 2 and 3: the vault's pages on two RPCs, then every note of this seed found in them. */
export async function restoreNotes(a: RestoreArgs): Promise<NoteRestore> {
  // two hosts of one operator are one read: a pair that is not a release pair is refused before any read
  if (nearPairNetwork(a.rpcs) === null) throw new Error(nearPairRule());
  const scope = vaultScopeOf(keccak_256, a.vault, a.token);
  if (a.atLeast !== undefined && (!Number.isSafeInteger(a.atLeast) || a.atLeast < 0)) throw new Error("atLeast is a block height");
  const cursor = { ...vaultSyncStart(a.vault), height: a.atLeast ?? 0 };
  const s = await vaultSync({ vault: a.vault, rpcs: a.rpcs, cursor, lists: ["deposits", "spends", "leaves"], ...(a.signal ? { signal: a.signal } : {}) });
  if (s.leaves.length !== s.stateTree.size) throw new Error("the leaves read are not the whole state tree");
  // the vault's own scope and token, read on both RPCs: a wrong token string would give an empty restore that looks valid
  const finalHeights = await readConfig(a.rpcs, a.vault, a.token, scope, s.height, a.signal);
  const gap = a.gap ?? RESTORE_GAP;
  const reach = checkReach(a.reach);
  let lanes: LaneWalk[] | undefined;
  if (a.walk) {
    const ps: ReadonlySet<bigint> = new Set(s.deposits.map((r) => r.precommitment));
    lanes = await untilAbort(Promise.all(Array.from({ length: RESTORE_LANES }, (_, lane) => a.walk!(lane, scope, gap, ps, reach[lane]!))), a.signal);
  }
  return { height: s.height, finalHeights, blockHash: s.blockHash, cursor: s.cursor, ...restorePages(a.seed64, scope, s, { gap, reach, ...(lanes ? { lanes } : {}) }) };
}

// config() at each RPC's final block: the same bytes on both, its scope the one computed from (vault, token) and its
// asset the token; returns the two final heights, each at or above the height the pages were read at. Exported for the
// signing page's restore (its vault walk opens the seed only for each use, so it calls vaultSync, this and restorePages
// itself: ../../../signpage/src/pool-restore.ts nearVaultRestoreNotes)
export async function readConfig(rpcs: readonly [VaultSyncRpc, VaultSyncRpc], vault: string, token: string, scope: bigint, height: number, signal?: AbortSignal): Promise<[number, number]> {
  const params = { request_type: "call_function", account_id: vault, method_name: "config", args_base64: btoa("{}"), finality: "final" };
  const one = async (rpc: VaultSyncRpc): Promise<{ bytes: string; height: number }> => {
    const a = (await rpc.query(params, signal)) as { error?: unknown; result?: { error?: unknown; result?: unknown; block_height?: unknown } } | null;
    const r = a?.error === undefined ? a?.result : undefined;
    const bytes = r?.error === undefined ? r?.result : undefined;
    if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) || !Number.isSafeInteger(r?.block_height))
      throw new Error(`${rpc.name}: config: not a view result`);
    if ((r!.block_height as number) < height) throw new Error(`${rpc.name}: config: its final height ${String(r!.block_height)} is below the pages' ${height}`);
    return { bytes: new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes as number[])), height: r!.block_height as number };
  };
  signal?.throwIfAborted();
  const [x, y] = await untilAbort(Promise.all([one(rpcs[0]), one(rpcs[1])]), signal);
  // as vaultSync's probe: final heights further apart than the device's window mean one RPC is stuck or lying, and step
  // 7's wait counted from the higher would never end on the honest one
  if (Math.abs(x.height - y.height) > VAULT_SYNC_LAG_MAX) throw new Error(`config: the RPCs' final heights ${x.height} and ${y.height} are over ${VAULT_SYNC_LAG_MAX} blocks apart`);
  if (x.bytes !== y.bytes) throw new Error("config: the RPCs' answers differ");
  const c = JSON.parse(x.bytes) as { scope?: unknown; asset?: unknown };
  if (c?.scope !== scope.toString()) throw new Error(`config: the vault's scope ${String(c?.scope)} is not the one computed from ${vault} and ${token}`);
  if (c.asset !== token) throw new Error(`config: the vault's asset ${String(c.asset)} is not ${token}`);
  return [x.height, y.height];
}

/** p, or the signal's reason once it aborts, whichever comes first. */
function untilAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** A walk's reach per lane (RestoreArgs `reach`): an index of the lane or null, one per lane; none given, all null. */
export function checkReach(reach: readonly (number | null)[] | undefined): (number | null)[] {
  if (reach === undefined) return Array<null>(RESTORE_LANES).fill(null);
  if (!Array.isArray(reach) || reach.length !== RESTORE_LANES) throw new Error("reach: one per lane");
  return reach.map((x, lane) => {
    if (x !== null && (!Number.isSafeInteger(x) || x < lane || x > U32 || x % RESTORE_LANES !== lane)) throw new Error(`reach[${lane}]: not an index of lane ${lane}`);
    return x;
  });
}

/** One lane's walk: the indices with a note, ascending, and the last index read with its precommitment. */
export type LaneWalk = { found: number[]; last: number; lastPrecommitment: bigint };

/**
 * The deposit index walk of one lane: every index of the lane with a note, in order, until `gap` indices of the lane
 * in a row have none. `has` tells whether the vault holds a precommitment (a lookup in pages already read).
 */
export function walkLane(seed64: Uint8Array, scope: bigint, lane: number, has: (precommitment: bigint) => boolean, gap: number = RESTORE_GAP, reach: number | null = null): LaneWalk {
  return walkLaneOf(masters(seed64, "deposit"), scope, lane, has, gap, reach);
}

/**
 * walkLane from the deposit note masters alone (masters(seed64, "deposit")), so a walk Worker is handed the two
 * masters and never the seed (../restore/walk.ts).
 */
export function walkLaneOf(m: { nullifier: bigint; secret: bigint }, scope: bigint, lane: number, has: (precommitment: bigint) => boolean, gap: number = RESTORE_GAP, reach: number | null = null): LaneWalk {
  const steps = walkSteps(m, scope, lane, has, gap, reach);
  for (let r = steps.next(); ; r = steps.next()) if (r.done) return r.value;
}

/** Lane `lane` of 8 walks handed in, held to a whole walk of that lane on this seed and scope (checkedWalk), or the restore stops. */
export function laneOf(lanes: readonly LaneWalk[], lane: number, seed64: Uint8Array, scope: bigint, gap: number = RESTORE_GAP): LaneWalk {
  if (!Array.isArray(lanes) || lanes.length !== RESTORE_LANES) throw new Error(`lanes: ${String(lanes?.length)} walks, not ${RESTORE_LANES}`);
  const w = lanes[lane]!;
  checkedWalk(w, lane, seed64, scope, gap, null);
  return w;
}

/**
 * A lane's walk run elsewhere (on the page's yielding loop, or handed in), held to what a whole walk on this seed and
 * scope returns before a note is taken from it: the lane's own indices, ascending; read to `gap` misses past its last
 * note or its reach (walkEnd); its last index's precommitment recomputed from the seed. A walk that stopped early, or
 * ran on another seed or scope, throws here, so the restore stops instead of returning fewer notes.
 */
export function checkedWalk(w: LaneWalk, lane: number, seed64: Uint8Array, scope: bigint, gap: number, reach: number | null): { found: number[]; end: number } {
  const found = Array.isArray(w?.found) ? [...w.found] : null;
  if (found === null || !found.every((i, k) => Number.isInteger(i) && i >= 0 && i <= U32 && i % RESTORE_LANES === lane && (k === 0 || i > found[k - 1]!)))
    throw new Error(`lane ${lane}: the walk's indices are not this lane's, ascending`);
  const end = walkEnd(lane, found, gap, reach);
  if (w.last !== end) throw new Error(`lane ${lane}: the walk ended at ${String(w.last)}, not ${end} (gap ${gap} past its last note${reach === null ? "" : ` or its reach ${reach}`})`);
  if (w.lastPrecommitment !== noteSecrets(seed64, { kind: "deposit", s: scope, i: w.last }).precommitment)
    throw new Error(`lane ${lane}: the walk's last precommitment is not this seed's and scope's`);
  return { found, end };
}

/** The longest stretch, in ms, a yielding walk runs before it gives the event loop a turn. */
export const WALK_SLICE_MS = 8;
/** One turn of the event loop: a message on a channel of its own (never a timer, which browsers hold to 4 ms once nested). */
export const turn = (): Promise<void> =>
  new Promise((ok) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => (c.port1.close(), c.port2.close(), ok());
    c.port2.postMessage(null);
  });

/**
 * walkLaneOf as a page runs it: the same walk, giving the event loop a turn every WALK_SLICE_MS of work and checking
 * `signal` at each, so the lane's RESTORE_GAP indices never hold the page (a sign out, another tab's, a frame's message
 * and the screen all run between slices) and a signal that ends stops it at the next slice with its reason, no index
 * after (card restore-first-sign-in-under-two-minutes: release 114's walk held the main thread 15 to 70 s).
 */
export async function walkLaneYielding(m: { nullifier: bigint; secret: bigint }, scope: bigint, lane: number, has: (precommitment: bigint) => boolean, gap: number = RESTORE_GAP, reach: number | null = null, signal?: AbortSignal, s: Slices = slices(signal)): Promise<LaneWalk> {
  signal?.throwIfAborted();
  const steps = walkSteps(m, scope, lane, has, gap, reach);
  for (let r = steps.next(); ; r = steps.next()) {
    if (r.done) return r.value;
    if (s.due()) await s.pass();
  }
}

/** The clock a slice is measured on: the page's own; a test gives one of its own (read once a step). */
export const sliceClock = (): number => performance.now();
/**
 * One restore's slices: a single WALK_SLICE_MS budget across its 8 lanes and the notes after them, so short lanes run
 * back to back still give the event loop a turn every slice. `due` once a slice is spent; `pass` gives the turn, then
 * checks the signal (its reason thrown) and starts the next slice.
 */
export type Slices = { due(): boolean; pass(): Promise<void> };
export function slices(signal?: AbortSignal, now: () => number = sliceClock): Slices {
  let at = now();
  return {
    due: () => now() - at >= WALK_SLICE_MS,
    pass: async () => {
      await turn();
      signal?.throwIfAborted();
      at = now();
    },
  };
}

// the walk itself, one index a step: walkLaneOf runs it through, walkLaneYielding a slice at a time
function* walkSteps(m: { nullifier: bigint; secret: bigint }, scope: bigint, lane: number, has: (precommitment: bigint) => boolean, gap: number, reach: number | null): Generator<void, LaneWalk, void> {
  if (!Number.isInteger(lane) || lane < 0 || lane >= RESTORE_LANES) throw new Error("a lane is 0-7");
  if (!Number.isSafeInteger(gap) || gap < 1) throw new Error("gap is a count above 0");
  if (reach !== null && (!Number.isSafeInteger(reach) || reach < lane || reach > U32 || reach % RESTORE_LANES !== lane)) throw new Error(`reach: not an index of lane ${lane}`);
  // a reach (the index a walk-end error named) is read as a note is for the stop rule: misses count only past it
  const floor = reach ?? -1;
  // depositNote's derivation (../derive/notes.ts) with its masters read once for the whole walk; every hit is checked
  // against noteSecrets below, so a drift between the two stops the restore instead of losing a note
  const found: number[] = [];
  let last = lane;
  let lastPrecommitment = 0n;
  for (let i = lane, misses = 0; misses < gap && i <= U32; i += RESTORE_LANES) {
    const n = poseidon3([m.nullifier, scope, BigInt(i)]);
    const sc = poseidon3([m.secret, scope, BigInt(i)]);
    last = i;
    lastPrecommitment = poseidon2([n, sc]);
    if (has(lastPrecommitment)) {
      found.push(i);
      misses = 0;
    } else if (i > floor) misses++;
    yield;
  }
  return { found, last, lastPrecommitment };
}

// The last index a whole walk of the lane reads: `gap` indices of the lane past its last note or its reach, whichever
// is higher (the lane's first gap indices when it has neither), or the lane's last index below 2^32. Exported for the
// pools' walks, which return their notes only: step 5 (../restore/wallets.ts restoreDepositIds) holds a pool lane's ids
// to it (the signing page's restore kind, packages/signpage/src/pool-restore.ts)
export function walkEnd(lane: number, found: readonly number[], gap: number, reach: number | null = null): number {
  const from = Math.max(found.length === 0 ? lane - RESTORE_LANES : found[found.length - 1]!, reach ?? -Infinity);
  const end = from + RESTORE_LANES * gap;
  const top = lane + RESTORE_LANES * Math.floor((U32 - lane) / RESTORE_LANES);
  return Math.min(end, top);
}

type RestorePagesArgs = [
  scope: bigint,
  pages: { deposits: readonly VaultDepositRow[]; spends: readonly VaultSpendRow[]; leaves: readonly bigint[] },
  opts?: { gap?: number; reach?: readonly (number | null)[]; lanes?: readonly LaneWalk[] },
];
export type PagesRestored = Omit<NoteRestore, "height" | "finalHeights" | "blockHash" | "cursor">;

/** Step 3 on pages both RPCs gave: the deposits, the spends and the whole state tree's leaves. */
export function restorePages(seed64: Uint8Array, ...args: RestorePagesArgs): PagesRestored {
  const steps = restorePagesSteps(...args);
  for (let r = steps.next(); ; r = steps.next(seed64)) if (r.done) return r.value;
}

/**
 * restorePages a note derivation at a time: each step waits for the seed and reads it only until the next wait, so a
 * page gives it the seed in short synchronous uses with the event loop a turn between them (the signing page's vault
 * walk, packages/signpage/src/pool-restore.ts nearVaultRestoreNotes), as solanaRestoreSteps (../pool/solana-restore.ts).
 * Its checks on the arguments and the pages run before the first wait.
 */
export function* restorePagesSteps(scope: bigint, pages: RestorePagesArgs[1], opts: NonNullable<RestorePagesArgs[2]> = {}): Generator<void, PagesRestored, Uint8Array> {
  const gap = opts.gap ?? RESTORE_GAP;
  const reach = checkReach(opts.reach);
  if (opts.lanes !== undefined && (!Array.isArray(opts.lanes) || opts.lanes.length !== RESTORE_LANES)) throw new Error("lanes: one walk per lane");
  const byP = new Map<bigint, VaultDepositRow>();
  for (const r of pages.deposits) {
    if (byP.has(r.precommitment)) throw new Error(`the vault holds precommitment ${r.precommitment} twice`);
    byP.set(r.precommitment, r);
  }
  const byNh = new Map<bigint, VaultSpendRow>();
  for (const r of pages.spends) {
    if (byNh.has(r.nullifierHash)) throw new Error(`the vault spent nullifier hash ${r.nullifierHash} twice`);
    byNh.set(r.nullifierHash, r);
  }
  const leafAt = new Map<bigint, number>();
  pages.leaves.forEach((c, k) => leafAt.has(c) || leafAt.set(c, k));
  const treeHas = (commitment: bigint, at: bigint, what: string): void => {
    if (at >= BigInt(pages.leaves.length) || pages.leaves[Number(at)] !== commitment) throw new Error(`${what}: its commitment is not the state tree's leaf ${at}`);
  };

  const notes: RestoredNote[] = [];
  const spends: RestoredSpend[] = [];
  const pendingRefunds: RestoredSpend[] = [];
  const seen = new Set<string>();
  const queue: RestoredNote[] = [];
  const put = (ref: NoteRef, precommitment: bigint, leaf: Leaf, parent?: string): void => {
    const key = refKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    const n: RestoredNote = { ref, scope, precommitment, leaf, state: "UNSPENT", ...(parent === undefined ? {} : { parent }) };
    notes.push(n);
    queue.push(n);
  };
  // a note the vault holds as a deposit (deposit, return, move and second-arrival notes): matched by precommitment
  const asDeposit = function* (ref: NoteRef): Generator<void, boolean, Uint8Array> {
    const P = noteSecrets(yield, ref).precommitment;
    const r = byP.get(P);
    if (r === undefined) return false;
    const commitment = noteCommitment(r.value, r.label, P);
    treeHas(commitment, r.leafIndex, `deposit row ${r.index}`);
    put(ref, P, { value: r.value, label: r.label, commitment, leafIndex: r.leafIndex });
    return true;
  };
  const seconds = function* (id: SecondId): Generator<void, void, Uint8Array> {
    for (let n = 0; n <= U32 && (yield* asDeposit({ kind: "second", id, n })); n++);
  };

  // the deposit index walk, lane by lane
  const laneHighest: (number | null)[] = [];
  const laneWalked: number[] = [];
  for (let lane = 0; lane < RESTORE_LANES; lane++) {
    const seed64: Uint8Array = yield;
    const w = opts.lanes ? opts.lanes[lane]! : walkLane(seed64, scope, lane, (P) => byP.has(P), gap, reach[lane]!);
    // a walk run elsewhere is held to a whole walk's end on this seed and scope; each index the vault holds (asDeposit below)
    const { found, end } = checkedWalk(w, lane, seed64, scope, gap, reach[lane]!);
    for (const i of found) {
      const ref: NoteRef = { kind: "deposit", s: scope, i };
      if (!(yield* asDeposit(ref))) throw new Error(`deposit index ${i}: the walk's precommitment is not the note's`);
    }
    laneHighest.push(found.length === 0 ? null : found[found.length - 1]!);
    laneWalked.push(end);
  }

  // every note found, followed
  for (let k = 0; k < queue.length; k++) {
    const note = queue[k]!;
    const ref = note.ref;
    if (ref.kind === "deposit") yield* seconds({ id: "U", s: ref.s, i: ref.i });
    const spend = byNh.get(noteSecrets(yield, ref).nullifierHash);
    if (spend === undefined) continue;
    note.state = "SPENT";
    const l = note.leaf.label;
    const j = ref.kind === "change" ? ref.j + 1 : 0; // the change index (l.116-124): 0 for a label's first note
    if (j > U32) throw new Error("change index out of range");
    const key = refKey(ref);
    const mine: RestoredSpend = { l, j, note: key, spend };
    spends.push(mine);
    // the change note, at the leaf its commitment is; a ragequit inserts none
    if (spend.withdrawn > note.leaf.value) throw new Error(`spend ${spend.index} withdrew more than its note held`);
    const cref: NoteRef = { kind: "change", l, j };
    const cP = noteSecrets(yield, cref).precommitment;
    const cValue = note.leaf.value - spend.withdrawn;
    const cCommitment = noteCommitment(cValue, l, cP);
    const cAt = leafAt.get(cCommitment);
    if (cAt !== undefined && BigInt(cAt) !== spend.newLeafIndex) throw new Error(`spend ${spend.index}: its change is at leaf ${cAt}, not ${spend.newLeafIndex}`);
    // a withdraw always inserts its change (2.5.2 row 12); only a ragequit, which writes context 0 (vault.md l.99),
    // inserts none. A withdraw of ours whose new leaf is not our change is a drift in the derivation: stop, never lose it
    if (spend.context !== 0n) {
      treeHas(cCommitment, spend.newLeafIndex, `spend ${spend.index}'s change note (l ${l}, j ${j})`);
      put(cref, cP, { value: cValue, label: l, commitment: cCommitment, leafIndex: spend.newLeafIndex }, key);
    } else if (cAt !== undefined) put(cref, cP, { value: cValue, label: l, commitment: cCommitment, leafIndex: spend.newLeafIndex }, key);
    // the refund note the vault writes when a payout bounced (2.5.4-2.5.5), on this withdrawal's refund precommitment
    const rref: NoteRef = { kind: "refund", l, j };
    const rP = noteSecrets(yield, rref).precommitment;
    // money came back on a refund precommitment of ours that is not refundNote(l, j): a drift; stop, never lose it
    if (spend.refundValue > 0n && spend.refundPrecommitment !== rP) throw new Error(`spend ${spend.index}: its refund is on a precommitment that is not refund note (l ${l}, j ${j})`);
    if (spend.refundValue > 0n) {
      if (spend.status === "settled") {
        const commitment = noteCommitment(spend.refundValue, spend.refundLabel, rP);
        treeHas(commitment, spend.refundLeafIndex, `spend ${spend.index}'s refund note`);
        put(rref, rP, { value: spend.refundValue, label: spend.refundLabel, commitment, leafIndex: spend.refundLeafIndex }, key);
      } else if (spend.status === "refund_pending") pendingRefunds.push(mine);
    }
    // what the arm brings back, each on its own id: V's move note, R's return notes, and every second arrival
    yield* asDeposit({ kind: "move", l, j });
    yield* seconds({ id: "V", l, j });
    yield* seconds({ id: "A", l, j });
    for (const c of CHAIN_TAGS) {
      yield* asDeposit({ kind: "return", c, l, j });
      yield* seconds({ id: "R", c, l, j });
    }
  }
  spends.sort((x, y) => x.spend.index - y.spend.index);
  pendingRefunds.sort((x, y) => x.spend.index - y.spend.index);
  return { notes, spends, pendingRefunds, laneHighest, laneWalked };
}

/** A note restore found that writeRestored left as the store holds it, for the caller to act on. */
export type LeftAlone = {
  key: string;
  ref: NoteRef;
  /** the store's state for it, or null when it is not in the store (its parent was left alone) */
  stored: NoteState | null;
  /** its state in the vault */
  vault: "UNSPENT" | "SPENT";
  /**
   * taken: an index this store marked TAKEN that the vault holds a note on (another device's deposit on this seed);
   * incoming: a note in flight in this store that the vault shows landed (the deposit's own confirm moves it; INCOMING
   * has no edge to SPENT, so a spent one is reported here); parent: its parent is INCOMING and it waits for that note to
   * land. A PLANNED note the vault shows landed is never left alone: writeRestored lands it (E5)
   */
  why: "taken" | "incoming" | "parent";
};
export type RestoreWrite = { notes: NoteRecord[]; leftAlone: LeftAlone[] };

/**
 * Writes what a restore found into the note store, parents first, so each change and refund note names its parent and
 * the parent goes to SPENT with it (store.add); a spent note with no child found (a ragequit) is moved to SPENT. A note
 * the store already holds as landed is kept, unless the vault shows it spent; one it holds INCOMING or TAKEN is left as
 * it is and returned in leftAlone. The notes below an INCOMING one are held back with it (returned as "parent"); those
 * below a TAKEN one are written. Returns the store's notes and those left alone. Its notes may be the vault's
 * (restoreNotes) or a pool's (../pool/solana-restore.ts, ../pool/evm-restore.ts): one shape, one write.
 *
 * A note the store holds PLANNED that the restore found (card restore-first-sign-in-under-two-minutes, E5): the page
 * names a deposit index at the sign-in, before the walk, so a new lane that is one the lost store used names an index
 * the lost store funded. The restore found it on the same reads every note it writes rests on (both RPCs of the pair
 * agreeing, at finalized on Solana, its commitment the state tree's leaf at its index: restoreNotes, solana-restore.ts,
 * evm-restore.ts), so it is landed: it is moved as any landing moves it (landNote, the pool deposit's own for a taken
 * precommitment, src/pool-deposit.ts), and its children are written below it. Left PLANNED, it and every note below it
 * stayed unshown and unspendable until a deposit of that index happened to find the precommitment taken.
 */
export async function writeRestored(store: NoteStore, r: Pick<NoteRestore, "notes">): Promise<RestoreWrite> {
  const have = new Map((await store.list()).map((n) => [refKey(n.ref), n]));
  const leftAlone: LeftAlone[] = [];
  const blocked = new Set<string>();
  const WHY: Partial<Record<NoteState, LeftAlone["why"]>> = { TAKEN: "taken", INCOMING: "incoming" };
  // the notes below an INCOMING note wait for it to land (store.add needs a landed parent); TAKEN is terminal, so the
  // notes below it are written with no parent, else the other device's change would stay out of reach for good
  const HOLDS: readonly NoteState[] = ["INCOMING"];
  for (const n of r.notes) {
    const key = refKey(n.ref);
    const cur = have.get(key);
    if (cur !== undefined) {
      if (cur.precommitment !== n.precommitment) throw new Error(`note ${key} in the store has another precommitment`);
      // a PLANNED index the restore found landed (E5, above): landed now, with the leaf the restore read
      if (cur.state === "PLANNED") {
        have.set(key, await landNote(store, cur, n.leaf, n.landed));
        continue;
      }
      const why = WHY[cur.state];
      if (why !== undefined) {
        leftAlone.push({ key, ref: n.ref, stored: cur.state, vault: n.state, why });
        if (HOLDS.includes(cur.state)) blocked.add(key);
      }
      continue;
    }
    if (n.parent !== undefined && blocked.has(n.parent)) {
      leftAlone.push({ key, ref: n.ref, stored: null, vault: n.state, why: "parent" });
      blocked.add(key);
      continue;
    }
    have.set(key, await store.add({ ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: "UNSPENT", leaf: n.leaf, ...(n.landed === undefined ? {} : { landed: n.landed }) }));
  }
  const now = new Map((await store.list()).map((n) => [refKey(n.ref), n]));
  for (const n of r.notes) {
    if (n.state !== "SPENT" || blocked.has(refKey(n.ref))) continue;
    const cur = now.get(refKey(n.ref))!;
    if (cur.state === "UNSPENT" || cur.state === "HELD" || cur.state === "RESERVED") await store.move(cur.id, cur.state, "SPENT");
  }
  return { notes: await store.list(), leftAlone };
}

/**
 * A note whose precommitment the chain shows landed, at `leaf`, moved to UNSPENT as a landing moves it: PLANNED to
 * INCOMING first (the only edge out of PLANNED to a landing), then INCOMING to UNSPENT with the leaf, which the store
 * checks against the note's precommitment. The one move for a note landed by another deposit than its own send: the
 * pool deposit's taken precommitment (src/pool-deposit.ts) and the restore's PLANNED index (writeRestored).
 */
export async function landNote(store: Pick<NoteStore, "move">, n: NoteRecord, leaf: Leaf, landed?: Landed): Promise<NoteRecord> {
  const incoming = n.state === "PLANNED" ? await store.move(n.id, "PLANNED", "INCOMING") : n;
  return store.move(incoming.id, "INCOMING", "UNSPENT", { leaf, ...(landed === undefined ? {} : { landed }) });
}
