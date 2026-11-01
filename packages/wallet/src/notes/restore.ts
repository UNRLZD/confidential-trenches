// Restore of notes from the 12 words and the vault's public pages (card wallet-restore-notes, lane W2.5;
// docs/plan1/wallet.md §2.3 "Restore" steps 2-3 l.263-276, Secrets l.176-192, the deposit index rule l.346-356, device
// lanes l.245-254, the change index l.116-124, the held note l.392; P-03 l.1067).
//
// - Step 2: the vault's deposits, spends and leaves, read whole, page by page, through the kit's vaultSync on two RPCs
//   that must agree byte for byte at one block (06b §6.2, the vault paper 2.5.6). Only views are read, never a receipt
//   or its logs, so a refused deposit (which logs nothing and writes no row) is never seen. No request names a note:
//   every read is a page (from, limit), and the matching happens here, on the device.
// - Step 3, the deposit index walk: in each of the 8 lanes, deposit indices i = lane, lane + 8, ... are derived and
//   matched against the deposits' precommitments, with no request, until RESTORE_GAP indices of that lane in a row
//   have no note (the lane rule, l.252: every "in a row" counts within one lane). A note found resets only its own
//   lane's count. The lanes are independent, so a caller may run them in parallel Workers (walkLane).
// - Every note found is followed: its nullifier hash into the spends; for a withdrawal (l, j) of ours (l its label, j 0
//   for the first note of a label, k + 1 for change note k): change note j at the leaf its commitment is, the refund
//   note once settle has written it (a refund still pending is handed back to be settled), the move note of V_{l,j},
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
import { CHAINS, type Chain, masters, type SecondId } from "../derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "./secrets.ts";
import { refKey, type Leaf, type NoteRecord, type NoteStore } from "./store.ts";

/** Indices of one lane in a row with no note before the deposit index walk stops (wallet.md l.271-272). */
export const RESTORE_GAP = 10_000;
/** The device lanes: a device names only deposit indices ≡ d (mod 8) (wallet.md l.249-250). */
export const RESTORE_LANES = 8;
const U32 = 0xffffffff;
const CHAIN_TAGS = Object.keys(CHAINS) as Chain[];

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
  height: number;
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
  /** two RPCs of different operators */
  rpcs: readonly [VaultSyncRpc, VaultSyncRpc];
  signal?: AbortSignal;
  /** tests only: RESTORE_GAP unless given */
  gap?: number;
};

/** Steps 2 and 3: the vault's pages on two RPCs, then every note of this seed found in them. */
export async function restoreNotes(a: RestoreArgs): Promise<NoteRestore> {
  const scope = vaultScopeOf(keccak_256, a.vault, a.token);
  const s = await vaultSync({ vault: a.vault, rpcs: a.rpcs, cursor: vaultSyncStart(a.vault), lists: ["deposits", "spends", "leaves"], ...(a.signal ? { signal: a.signal } : {}) });
  if (s.leaves.length !== s.stateTree.size) throw new Error("the leaves read are not the whole state tree");
  return { height: s.height, blockHash: s.blockHash, cursor: s.cursor, ...restorePages(a.seed64, scope, s, a.gap ?? RESTORE_GAP) };
}

/**
 * The deposit index walk of one lane: every index of the lane with a note, in order, until `gap` indices of the lane
 * in a row have none. `has` tells whether the vault holds a precommitment (a lookup in pages already read).
 */
export function walkLane(seed64: Uint8Array, scope: bigint, lane: number, has: (precommitment: bigint) => boolean, gap: number = RESTORE_GAP): number[] {
  if (!Number.isInteger(lane) || lane < 0 || lane >= RESTORE_LANES) throw new Error("a lane is 0-7");
  if (!Number.isSafeInteger(gap) || gap < 1) throw new Error("gap is a count above 0");
  // depositNote's derivation (../derive/notes.ts) with its masters read once for the whole walk; every hit is checked
  // against noteSecrets below, so a drift between the two stops the restore instead of losing a note
  const m = masters(seed64, "deposit");
  const found: number[] = [];
  for (let i = lane, misses = 0; misses < gap && i <= U32; i += RESTORE_LANES) {
    const n = poseidon3([m.nullifier, scope, BigInt(i)]);
    const sc = poseidon3([m.secret, scope, BigInt(i)]);
    if (has(poseidon2([n, sc]))) {
      found.push(i);
      misses = 0;
    } else misses++;
  }
  return found;
}

/** Step 3 on pages both RPCs gave: the deposits, the spends and the whole state tree's leaves. */
export function restorePages(
  seed64: Uint8Array,
  scope: bigint,
  pages: { deposits: readonly VaultDepositRow[]; spends: readonly VaultSpendRow[]; leaves: readonly bigint[] },
  gap: number = RESTORE_GAP,
): Omit<NoteRestore, "height" | "blockHash" | "cursor"> {
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
    const found = walkLane(seed64, scope, lane, (P) => byP.has(P), gap);
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
    if (cAt !== undefined) {
      if (BigInt(cAt) !== spend.newLeafIndex) throw new Error(`spend ${spend.index}: its change is at leaf ${cAt}, not ${spend.newLeafIndex}`);
      put(cref, cP, { value: cValue, label: l, commitment: cCommitment, leafIndex: spend.newLeafIndex }, key);
    }
    // the refund note the vault writes when a payout bounced (2.5.4-2.5.5), on this withdrawal's refund precommitment
    const rref: NoteRef = { kind: "refund", l, j };
    const rP = noteSecrets(seed64, rref).precommitment;
    if (spend.refundPrecommitment === rP && spend.refundValue > 0n) {
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

/**
 * Writes what a restore found into the note store, parents first, so each change and refund note names its parent and
 * the parent goes to SPENT with it (store.add); a spent note with no child found (a ragequit) is moved to SPENT. A note
 * the store already holds is kept as it is, unless the vault shows it spent. Returns the store's notes.
 */
export async function writeRestored(store: NoteStore, r: NoteRestore): Promise<NoteRecord[]> {
  const have = new Map((await store.list()).map((n) => [refKey(n.ref), n]));
  for (const n of r.notes) {
    const key = refKey(n.ref);
    const cur = have.get(key);
    if (cur !== undefined) {
      if (cur.precommitment !== n.precommitment) throw new Error(`note ${key} in the store has another precommitment`);
      continue;
    }
    have.set(key, await store.add({ ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: "UNSPENT", leaf: n.leaf }));
  }
  const now = new Map((await store.list()).map((n) => [refKey(n.ref), n]));
  for (const n of r.notes) {
    if (n.state !== "SPENT") continue;
    const cur = now.get(refKey(n.ref))!;
    if (cur.state === "UNSPENT" || cur.state === "HELD" || cur.state === "RESERVED") await store.move(cur.id, cur.state, "SPENT");
  }
  return store.list();
}
