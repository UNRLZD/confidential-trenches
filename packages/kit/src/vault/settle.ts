// The device's own settle (card vault-kit-settle; the vault paper V4.1, V:1242, and 2.5.5, V:482-497): after a
// withdrawal whose payout part failed, the device settles its own refund-pending spend and stores the refund note, so no
// refund waits on anyone else.
//
// - Finding them. The device names its spends (each spent note's nullifier hash, the refund precommitment R it bound in
//   that proof, and how its note store names the refund note); the spends view, read by vaultSync on two RPCs at one
//   block byte for byte, says which are refund_pending. A row is matched by its nullifier hash only, the vault's own
//   key for a spend (contracts/vault/src/settle.rs reads `spent` by it). A row of ours whose refund_precommitment is
//   not the R the device bound stops the call: a drift, never a quiet loss.
// - Sending. settle is the vault's own call (VAULT_SETTLE), by anyone: the kit builds it (vaultSettleCall) and hands it
//   to the caller's sender, the device's own NEAR account paying the gas, or anything else that sends a call. 150 Tgas,
//   the relayer's SETTLE_GAS (apps/helper/src/withdraw/send.ts: above a refund note's 104.475 Tgas at depth 32; unused
//   gas comes back), and 148 B × 1e19 attached, two trees that may each grow a level (V:488: the reserve pays the
//   389 B, the attachment a shortfall, and the vault sends back what it does not use). The relayer settles every
//   withdrawal it carries on its own (H3.4); a spend anyone settled first is read as settled and only its note is
//   written. The sender's answer is never the outcome: the spends row read again on both RPCs is.
// - The note. A refund note is the spend row's own leaf: value refund_value, label refund_label, at refund_leaf_index,
//   whose commitment Poseidon(refund_value, refund_label, R) must be the state tree's leaf at that index on both RPCs
//   at one block. Never a leaf found by R, by its commitment, or the first or lowest leaf on R: anyone can put a second
//   note on R (a deposit on it, or a withdrawal of theirs that binds R and bounces), and that note shares the refund's
//   nullifier, so spending it would strand the refund (card wallet-refund-note-by-leaf, PR #413). The note is written
//   UNSPENT naming its parent through the note store's add (packages/wallet notes/store.ts), once: a store that holds a
//   note on R already is left as it is.
// - Every input is hostile: the vault id, the fields, the device's spends (two of one nullifier hash or one R are
//   refused), the pages (vaultSync's own checks), the sender's answer.
import { VAULT_FIELD_P, VAULT_SETTLE, VAULT_STORAGE_BYTE_COST, vaultAccountId, type VaultSettleArgs, type VaultSpendStatus } from "./shapes.ts";
import { vaultCommitment } from "./inputs.ts";
import { vaultSync, vaultSyncStart, type VaultSpendRow, type VaultSyncCursor, type VaultSyncResult, type VaultSyncRpc } from "./sync.ts";
import { deepFreeze } from "../freeze.ts";

/** settle's gas, the relayer's SETTLE_GAS: above a refund note's 104.475 Tgas at depth 32; unused gas is refunded. */
export const VAULT_SETTLE_GAS = 150_000_000_000_000n;
/** settle's attachment for a refund note: both trees may grow a level, 2 × 74 B × 1e19; the vault returns the rest. */
export const VAULT_SETTLE_REFUND_ATTACH = 148n * VAULT_STORAGE_BYTE_COST;
/** The waits, in ms, between the reads of a sent settle's row, about 60 s in all; then the call reports it unseen. */
export const VAULT_SETTLE_WAITS_MS: readonly number[] = /* @__PURE__ */ Object.freeze([1_000, 2_000, 3_000, 4_000, 5_000, 5_000, 10_000, 10_000, 10_000, 10_000]);

/** One settle call, as a NEAR FunctionCall action on the vault: what the sender signs and sends. */
export type VaultSettleCall = { receiverId: string; methodName: "settle"; args: string; gas: bigint; deposit: bigint };

/**
 * settle(nullifier_hash) on `vault`: 150 Tgas, with 148 B × 1e19 attached for a refund-pending spend (a refund note's
 * trees may grow) and nothing for a paid one (no note is written; the whole reserve goes to the payer).
 */
export function vaultSettleCall(vault: string, nullifierHash: bigint, status: "refund_pending" | "paid"): VaultSettleCall {
  vaultAccountId(vault, "vault");
  field(nullifierHash, "nullifierHash");
  if (status !== "refund_pending" && status !== "paid") throw new Error("status: settle takes refund_pending or paid");
  const body: VaultSettleArgs = { nullifier_hash: nullifierHash.toString() }; // the frozen shape's one argument, VAULT_SETTLE.args
  const args = JSON.stringify(body);
  return deepFreeze({ receiverId: vault, methodName: VAULT_SETTLE.method, args, gas: VAULT_SETTLE_GAS, deposit: status === "refund_pending" ? VAULT_SETTLE_REFUND_ATTACH : 0n });
}

/** A spend of the device's: the spent note's nullifier hash, the refund precommitment its proof bound, the refund
 *  note's name in the note store and the spent note's id there (the refund note's parent). */
export type VaultSettleSpend<Ref> = { nullifierHash: bigint; refundPrecommitment: bigint; ref: Ref; parent: string };

/** The leaf of a note, as the note store keeps it. */
export type VaultSettleLeaf = { value: bigint; label: bigint; commitment: bigint; leafIndex: bigint };

/** The part of the wallet's note store (packages/wallet notes/store.ts NoteStore) settle writes through. */
export interface VaultSettleNoteStore<Ref> {
  list(): Promise<readonly { precommitment: bigint }[]>;
  add(note: { ref: Ref; scope: bigint; precommitment: bigint; state: "UNSPENT"; parent: string; leaf: VaultSettleLeaf }): Promise<unknown>;
}

/** Sends one settle call and gives back its transaction hash. Its answer is never taken as the outcome. */
export type VaultSettleSend = (call: VaultSettleCall, signal?: AbortSignal) => Promise<string>;

export type VaultSettleOwnArgs<Ref> = {
  vault: string;
  /** the vault's scope (vaultScopeOf(vault, token)), which the store keeps with each note */
  scope: bigint;
  /** two RPCs of different operators */
  rpcs: readonly [VaultSyncRpc, VaultSyncRpc];
  /** the device's spends to look at */
  spends: readonly VaultSettleSpend<Ref>[];
  send: VaultSettleSend;
  store: VaultSettleNoteStore<Ref>;
  /** where the spends read starts (a VaultSyncCursor whose spends index is at or below the first of these spends);
   *  every spend from 0 unless given */
  cursor?: VaultSyncCursor;
  signal?: AbortSignal;
  /** VAULT_SETTLE_WAITS_MS unless given (tests) */
  waitsMs?: readonly number[];
};

/** What one spend came to. */
export type VaultSettleOutcome =
  /** its callback has not run: nothing to settle yet */
  | { nullifierHash: bigint; state: "in_flight" }
  /** paid in full, no refund: nothing of the device's to settle */
  | { nullifierHash: bigint; state: "paid" | "settled" }
  /** not in the vault's spends at the block read */
  | { nullifierHash: bigint; state: "unknown" }
  /** its callback ran only at the last read, so nothing was sent yet: call again */
  | { nullifierHash: bigint; state: "refund_pending" }
  /** settle sent (txHash) and not yet read settled on both RPCs within the waits: call again */
  | { nullifierHash: bigint; state: "sent"; txHash: string }
  /** the refund note, written now or found already in the store; txHash when this call sent the settle */
  | { nullifierHash: bigint; state: "refund_note"; leaf: VaultSettleLeaf; written: boolean; txHash?: string };

export type VaultSettleOwnResult = { height: number; blockHash: string; outcomes: VaultSettleOutcome[] };

/** The device's refund-pending spends settled, and every refund note of these spends written through the note store. */
export async function vaultSettleOwn<Ref>(a: VaultSettleOwnArgs<Ref>): Promise<VaultSettleOwnResult> {
  const vault = vaultAccountId(a.vault, "vault");
  const scope = field(a.scope, "scope");
  if (!Array.isArray(a.spends)) throw new Error("spends: not a list");
  if (typeof a.send !== "function") throw new Error("send: not a function");
  if (a.store === null || typeof a.store !== "object" || typeof a.store.add !== "function" || typeof a.store.list !== "function") throw new Error("store: not a note store");
  const mine = new Map<bigint, VaultSettleSpend<Ref>>();
  const rs = new Set<bigint>();
  for (const s of a.spends) {
    const n = field(s?.nullifierHash, "nullifierHash");
    const r = field(s.refundPrecommitment, "refundPrecommitment");
    if (r === 0n) throw new Error("refundPrecommitment: 0 is no note's");
    if (typeof s.parent !== "string" || s.parent === "") throw new Error("parent: not a note id");
    if (mine.has(n)) throw new Error(`nullifier hash ${n} named twice`);
    if (rs.has(r)) throw new Error(`refund precommitment ${r} named twice`);
    mine.set(n, s);
    rs.add(r);
  }
  const start = a.cursor ?? vaultSyncStart(vault);
  if (start.vault !== vault) throw new Error("cursor: another vault's");
  const waits = a.waitsMs ?? VAULT_SETTLE_WAITS_MS;
  const read = (cursor: VaultSyncCursor, lists: readonly ("spends" | "leaves")[]) => vaultSync({ vault, rpcs: a.rpcs, cursor, lists, ...(a.signal === undefined ? {} : { signal: a.signal }) });
  const ours = (s: VaultSyncResult): Map<bigint, VaultSpendRow> => {
    const by = new Map<bigint, VaultSpendRow>();
    for (const row of s.spends) {
      const m = mine.get(row.nullifierHash);
      if (m === undefined) continue;
      if (by.has(row.nullifierHash)) throw new Error(`spend ${row.index}: the vault holds nullifier hash ${row.nullifierHash} twice`);
      if (row.refundPrecommitment !== m.refundPrecommitment) throw new Error(`spend ${row.index}: its refund precommitment is not the one this device bound`);
      by.set(row.nullifierHash, row);
    }
    return by;
  };

  // 1. the device's spends as the vault holds them, and a settle for each refund-pending one, read again until both
  //    RPCs show every one sent settled and none in flight (a spend whose callback runs meanwhile is sent when it turns
  //    refund_pending)
  let s = await read(start, ["spends"]);
  let rows = ours(s);
  const sent = new Map<bigint, string>();
  for (let i = 0; ; i++) {
    for (const [n, row] of rows) {
      if (row.status !== "refund_pending" || sent.has(n)) continue;
      a.signal?.throwIfAborted();
      const tx = await a.send(vaultSettleCall(vault, n, "refund_pending"), a.signal);
      if (typeof tx !== "string" || tx === "") throw new Error("send: no transaction hash");
      sent.set(n, tx);
    }
    // a spend in flight waits for its callback (a few blocks); one whose callback failed (2.5.4, VT-S17) stays in flight,
    // so the waits end it, reported in_flight
    if (![...rows.values()].some((r) => r.status === "refund_pending" || r.status === "in_flight") || i >= waits.length) break;
    await sleep(waits[i] as number, a.signal);
    s = await read(start, ["spends"]);
    rows = ours(s);
  }
  // 2. each settled refund's leaf, read with its row at one block: the spend row's own leaf, checked at its index
  const leaves = new Map<bigint, bigint>();
  for (let from: bigint | null = lowestRefundLeaf(rows); from !== null; ) {
    s = await read({ ...start, height: s.height, leaves: Number(from) }, ["spends", "leaves"]);
    rows = ours(s);
    const low = lowestRefundLeaf(rows);
    if (low !== null && low < from) {
      from = low; // a spend settled between the two reads, below the leaves read: read from its leaf
      continue;
    }
    s.leaves.forEach((leaf, k) => leaves.set((from as bigint) + BigInt(k), leaf));
    from = null;
  }
  const held = new Set((await a.store.list()).map((x) => x.precommitment));
  const outcomes: VaultSettleOutcome[] = [];
  for (const [n, m] of mine) {
    const spend = rows.get(n);
    const tx = sent.get(n);
    if (spend === undefined) {
      outcomes.push(tx === undefined ? { nullifierHash: n, state: "unknown" } : { nullifierHash: n, state: "sent", txHash: tx });
      continue;
    }
    if (spend.status === "refund_pending") {
      // sent and not yet read settled, or turned refund_pending only at the last read: call again
      outcomes.push(tx === undefined ? { nullifierHash: n, state: "refund_pending" } : { nullifierHash: n, state: "sent", txHash: tx });
      continue;
    }
    if (spend.status !== "settled" || spend.refundValue === 0n) {
      outcomes.push({ nullifierHash: n, state: spend.status as Exclude<VaultSpendStatus, "refund_pending"> });
      continue;
    }
    const rP = m.refundPrecommitment;
    // the spend row's own leaf: refund_value and refund_label at refund_leaf_index, checked against the state tree
    const commitment = vaultCommitment(spend.refundValue, spend.refundLabel, rP);
    if (leaves.get(spend.refundLeafIndex) !== commitment) throw new Error(`spend ${spend.index}: the state tree's leaf ${spend.refundLeafIndex} is not its refund note`);
    const leaf: VaultSettleLeaf = { value: spend.refundValue, label: spend.refundLabel, commitment, leafIndex: spend.refundLeafIndex };
    const written = !held.has(rP);
    if (written) await a.store.add({ ref: m.ref, scope, precommitment: rP, state: "UNSPENT", parent: m.parent, leaf });
    outcomes.push({ nullifierHash: n, state: "refund_note", leaf, written, ...(tx === undefined ? {} : { txHash: tx }) });
  }
  return { height: s.height, blockHash: s.blockHash, outcomes };
}

/** The lowest refund_leaf_index of the settled spends with a refund, or null when there is none. */
function lowestRefundLeaf(rows: ReadonlyMap<bigint, VaultSpendRow>): bigint | null {
  let low: bigint | null = null;
  for (const r of rows.values()) if (r.status === "settled" && r.refundValue > 0n && (low === null || r.refundLeafIndex < low)) low = r.refundLeafIndex;
  return low;
}

function field(x: unknown, what: string): bigint {
  if (typeof x !== "bigint" || x < 0n || x >= VAULT_FIELD_P) throw new Error(`${what}: not a field element in [0, p)`);
  return x;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((ok, no) => {
    if (signal?.aborted) return no(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      ok();
    }, ms);
    const stop = () => {
      clearTimeout(t);
      no(signal?.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
