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
import { refKey, type Leaf, type NoteRecord, type NoteState, type NoteStore } from "./store.ts";

/** Indices of one lane in a row with no note before the deposit index walk stops (wallet.md l.271-272). */
export const RESTORE_GAP = 10_000;
/** The device lanes: a device names only deposit indices ≡ d (mod 8) (wallet.md l.249-250). */
export const RESTORE_LANES = 8;
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
   * The deposit index walk of one lane, run where the caller likes (the proof pool's workers): walkLane(seed64, scope,
   * lane, p => precommitments.has(p), gap) for exactly the lane, scope and gap given. walkLane on this thread unless given.
   */
  walk?: (lane: number, scope: bigint, gap: number, precommitments: ReadonlySet<bigint>) => Promise<LaneWalk>;
};

/** Steps 2 and 3: the vault's pages on two RPCs, then every note of this seed found in them. */
export async function restoreNotes(a: RestoreArgs): Promise<NoteRestore> {
  // two hosts of one operator are one read: a pair that is not a release pair is refused before any read
  if (nearPairNetwork(a.rpcs) === null) throw new Error(nearPairRule());
  const scope = vaultScopeOf(keccak_256, a.vault, a.token);
  const s = await vaultSync({ vault: a.vault, rpcs: a.rpcs, cursor: vaultSyncStart(a.vault), lists: ["deposits", "spends", "leaves"], ...(a.signal ? { signal: a.signal } : {}) });
  if (s.leaves.length !== s.stateTree.size) throw new Error("the leaves read are not the whole state tree");
  // the vault's own scope and token, read on both RPCs: a wrong token string would give an empty restore that looks valid
  const finalHeights = await readConfig(a.rpcs, a.vault, a.token, scope, s.height, a.signal);
  const gap = a.gap ?? RESTORE_GAP;
  let lanes: LaneWalk[] | undefined;
  if (a.walk) {
    const ps: ReadonlySet<bigint> = new Set(s.deposits.map((r) => r.precommitment));
    lanes = await untilAbort(Promise.all(Array.from({ length: RESTORE_LANES }, (_, lane) => a.walk!(lane, scope, gap, ps))), a.signal);
  }
  return { height: s.height, finalHeights, blockHash: s.blockHash, cursor: s.cursor, ...restorePages(a.seed64, scope, s, { gap, ...(lanes ? { lanes } : {}) }) };
}

// config() at each RPC's final block: the same bytes on both, its scope the one computed from (vault, token) and its
// asset the token; returns the two final heights, each at or above the height the pages were read at
async function readConfig(rpcs: readonly [VaultSyncRpc, VaultSyncRpc], vault: string, token: string, scope: bigint, height: number, signal?: AbortSignal): Promise<[number, number]> {
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

/** One lane's walk: the indices with a note, ascending, and the last index read with its precommitment. */
export type LaneWalk = { found: number[]; last: number; lastPrecommitment: bigint };

/**
 * The deposit index walk of one lane: every index of the lane with a note, in order, until `gap` indices of the lane
 * in a row have none. `has` tells whether the vault holds a precommitment (a lookup in pages already read).
 */
export function walkLane(seed64: Uint8Array, scope: bigint, lane: number, has: (precommitment: bigint) => boolean, gap: number = RESTORE_GAP): LaneWalk {
  return walkLaneOf(masters(seed64, "deposit"), scope, lane, has, gap);
}

/**
 * walkLane from the deposit note masters alone (masters(seed64, "deposit")), so a walk Worker is handed the two
 * masters and never the seed (../restore/walk.ts).
 */
export function walkLaneOf(m: { nullifier: bigint; secret: bigint }, scope: bigint, lane: number, has: (precommitment: bigint) => boolean, gap: number = RESTORE_GAP): LaneWalk {
  if (!Number.isInteger(lane) || lane < 0 || lane >= RESTORE_LANES) throw new Error("a lane is 0-7");
  if (!Number.isSafeInteger(gap) || gap < 1) throw new Error("gap is a count above 0");
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
    } else misses++;
  }
  return { found, last, lastPrecommitment };
}

// The last index a whole walk of the lane reads: `gap` indices of the lane past its last note (the lane's first
// gap indices when it has none), or the lane's last index below 2^32
function walkEnd(lane: number, found: readonly number[], gap: number): number {
  const from = found.length === 0 ? lane - RESTORE_LANES : found[found.length - 1]!;
  const end = from + RESTORE_LANES * gap;
  const top = lane + RESTORE_LANES * Math.floor((U32 - lane) / RESTORE_LANES);
  return Math.min(end, top);
}

/** Step 3 on pages both RPCs gave: the deposits, the spends and the whole state tree's leaves. */
export function restorePages(
  seed64: Uint8Array,
  scope: bigint,
  pages: { deposits: readonly VaultDepositRow[]; spends: readonly VaultSpendRow[]; leaves: readonly bigint[] },
  opts: { gap?: number; lanes?: readonly LaneWalk[] } = {},
): Omit<NoteRestore, "height" | "finalHeights" | "blockHash" | "cursor"> {
  const gap = opts.gap ?? RESTORE_GAP;
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
  const asDeposit = (ref: NoteRef): boolean => {
    const P = noteSecrets(seed64, ref).precommitment;
    const r = byP.get(P);
    if (r === undefined) return false;
    const commitment = noteCommitment(r.value, r.label, P);
    treeHas(commitment, r.leafIndex, `deposit row ${r.index}`);
    put(ref, P, { value: r.value, label: r.label, commitment, leafIndex: r.leafIndex });
    return true;
  };
  const seconds = (id: SecondId): void => {
    for (let n = 0; n <= U32 && asDeposit({ kind: "second", id, n }); n++);
  };

  // the deposit index walk, lane by lane
  const laneHighest: (number | null)[] = [];
  for (let lane = 0; lane < RESTORE_LANES; lane++) {
    const w = opts.lanes ? opts.lanes[lane]! : walkLane(seed64, scope, lane, (P) => byP.has(P), gap);
    const found = Array.isArray(w?.found) ? [...w.found] : null;
    // a walk run elsewhere: the lane's own indices, ascending, each one the vault holds (checked by asDeposit below) ...
    if (found === null || !found.every((i, k) => Number.isInteger(i) && i >= 0 && i <= U32 && i % RESTORE_LANES === lane && (k === 0 || i > found[k - 1]!)))
      throw new Error(`lane ${lane}: the walk's indices are not this lane's, ascending`);
    // ... read to gap misses past its last note, on this seed and scope: its last index's precommitment is recomputed
    if (w.last !== walkEnd(lane, found, gap)) throw new Error(`lane ${lane}: the walk ended at ${String(w.last)}, not ${walkEnd(lane, found, gap)} (gap ${gap} past its last note)`);
    if (w.lastPrecommitment !== noteSecrets(seed64, { kind: "deposit", s: scope, i: w.last }).precommitment)
      throw new Error(`lane ${lane}: the walk's last precommitment is not this seed's and scope's`);
    for (const i of found) {
      const ref: NoteRef = { kind: "deposit", s: scope, i };
      if (!asDeposit(ref)) throw new Error(`deposit index ${i}: the walk's precommitment is not the note's`);
    }
    laneHighest.push(found.length === 0 ? null : found[found.length - 1]!);
  }

  // every note found, followed
  for (let k = 0; k < queue.length; k++) {
    const note = queue[k]!;
    const ref = note.ref;
    if (ref.kind === "deposit") seconds({ id: "U", s: ref.s, i: ref.i });
    const spend = byNh.get(noteSecrets(seed64, ref).nullifierHash);
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
    const cP = noteSecrets(seed64, cref).precommitment;
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
    const rP = noteSecrets(seed64, rref).precommitment;
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
    asDeposit({ kind: "move", l, j });
    seconds({ id: "V", l, j });
    seconds({ id: "A", l, j });
    for (const c of CHAIN_TAGS) {
      asDeposit({ kind: "return", c, l, j });
      seconds({ id: "R", c, l, j });
    }
  }
  spends.sort((x, y) => x.spend.index - y.spend.index);
  pendingRefunds.sort((x, y) => x.spend.index - y.spend.index);
  return { notes, spends, pendingRefunds, laneHighest };
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
   * incoming or planned: a note in flight in this store that the vault shows landed (the deposit's own confirm moves
   * it; INCOMING has no edge to SPENT, so a spent one is reported here); parent: its parent is PLANNED or INCOMING and
   * it waits for that note to land
   */
  why: "taken" | "incoming" | "planned" | "parent";
};
export type RestoreWrite = { notes: NoteRecord[]; leftAlone: LeftAlone[] };

/**
 * Writes what a restore found into the note store, parents first, so each change and refund note names its parent and
 * the parent goes to SPENT with it (store.add); a spent note with no child found (a ragequit) is moved to SPENT. A note
 * the store already holds as landed is kept, unless the vault shows it spent; one it holds PLANNED, INCOMING or TAKEN
 * is left as it is and returned in leftAlone. The notes below a PLANNED or INCOMING one are held back with it (returned
 * as "parent"); those below a TAKEN one are written. Returns the store's notes and those left alone. Its notes may be the
 * vault's (restoreNotes) or a pool's (../pool/solana-restore.ts, ../pool/evm-restore.ts): one shape, one write.
 */
export async function writeRestored(store: NoteStore, r: Pick<NoteRestore, "notes">): Promise<RestoreWrite> {
  const have = new Map((await store.list()).map((n) => [refKey(n.ref), n]));
  const leftAlone: LeftAlone[] = [];
  const blocked = new Set<string>();
  const WHY: Partial<Record<NoteState, LeftAlone["why"]>> = { TAKEN: "taken", INCOMING: "incoming", PLANNED: "planned" };
  // the notes below a PLANNED or INCOMING note wait for it to land (store.add needs a landed parent); TAKEN is terminal,
  // so the notes below it are written with no parent, else the other device's change would stay out of reach for good
  const HOLDS: readonly NoteState[] = ["PLANNED", "INCOMING"];
  for (const n of r.notes) {
    const key = refKey(n.ref);
    const cur = have.get(key);
    if (cur !== undefined) {
      if (cur.precommitment !== n.precommitment) throw new Error(`note ${key} in the store has another precommitment`);
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
    have.set(key, await store.add({ ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: "UNSPENT", leaf: n.leaf }));
  }
  const now = new Map((await store.list()).map((n) => [refKey(n.ref), n]));
  for (const n of r.notes) {
    if (n.state !== "SPENT" || blocked.has(refKey(n.ref))) continue;
    const cur = now.get(refKey(n.ref))!;
    if (cur.state === "UNSPENT" || cur.state === "HELD" || cur.state === "RESERVED") await store.move(cur.id, cur.state, "SPENT");
  }
  return { notes: await store.list(), leftAlone };
}
