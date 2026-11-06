// The vault's pages, read on two RPCs and matched on the device (card vault-kit-sync; the vault paper V4.1, 2.5.6 and
// 2.10 (c), docs/plan1/vault.md l.1230, l.492-501, l.674-676). Every list the vault pages (deposits, spends, leaves,
// labels) and both trees' heads, read from a cursor so a caller resumes where it stopped instead of from 0.
//
// - One block on both RPCs. Each RPC's final height is read first (state_tree at final); every read after it names
//   the lower of the two by block_id, so two honest RPCs answer the same state and any difference is a lie or a fault,
//   never lag. An RPC ahead of the other only waits: its newer rows come in the next sync. Both answers must carry
//   that height and the same block hash. Final heights more than VAULT_SYNC_LAG_MAX (the device's window W) apart
//   stop the sync ("lag"): one RPC is stuck or lying, and a read at its height would be stale. A caller that needs a
//   block at or above a height (a signed call's max_block_height + 5) puts it in cursor.height ("behind" below it).
// - Byte for byte. Each view's answer bytes must be equal on both RPCs (vault paper 2.12 step 2), else the sync stops
//   (VaultSyncStopped "disagree"): an extra, missing or changed row on one RPC, a tree head that differs, another
//   block. One RPC down, or an answer that is not a view result, stops it too ("rpc"). Nothing is returned from a
//   stopped sync and the caller's cursor is never changed, so a stop costs a read again, never a row.
// - Rows as the vault writes them. Every row is checked as contracts/vault/src/lib.rs's views write it: its exact
//   fields, in its order, once each, compact, so the answer must be the bytes the vault's serializer writes for
//   the rows parsed from it; its index at its place, decimals canonical and below p, amounts u128, account ids NEAR
//   ids ("row").
// - The cursor moves only past rows both RPCs gave. A reported count never moves it: the leaves and labels read must
//   end at their tree's size, which both RPCs gave equal ("count" otherwise, and for a cursor past that size), and the
//   deposits and spends cursors move by the rows read; a deposits or spends cursor c > 0 that reads no row must find
//   row c - 1 ("count" otherwise), so a cursor past the list's end never skips the rows written later. Every list is
//   append-only (2.5.6), so the rows below a cursor never change, with one exception: a spend's status and refund
//   fields change until it is settled (2.5.5), so the spends cursor stops at the first spend not settled and the next
//   sync reads it again (a row read again replaces the earlier copy, by its index).
// - No lookup of one secret-derived value: whole pages only, matched here (2.5.6). Deposits are confirmed from these
//   rows, never from a transaction read by hash (2.10 (c)).
// - Pages any public RPC serves (review R-03): each list starts at VAULT_SYNC_PAGE rows, at most 125 Tgas a view, and a
//   page an RPC refuses as too heavy is read again at half its rows on both RPCs, so the list still reads whole.
// - An abort ends the sync at once, even inside a read an RPC never answers; the signal goes to the RPC's query too.
// The kit names no provider: the caller passes two RPCs of different operators (the wallet's NEAR_NETWORKS pair).
import { VAULT_CONSTANTS, VAULT_FIELD_P, vaultAccountId, vaultDecimal, type VaultSpendStatus } from "./shapes.ts";

/**
 * A NEAR JSON-RPC provider's `query` method: the params of one query, its whole JSON-RPC answer. The signal is the
 * sync's; a provider may end its request on it (the sync stops waiting on its own either way).
 */
export interface VaultSyncRpc {
  name: string;
  query(params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

/**
 * The most the two RPCs' final heights may differ, in blocks: the device's window W, 120 blocks or about 70 s (vault
 * paper 2.10 (b), docs/plan1/vault.md l.670-672). Two honest RPCs differ by a block or two.
 */
export const VAULT_SYNC_LAG_MAX = 120;

/** The lists the vault pages (2.5.6). */
export const VAULT_SYNC_LISTS = ["deposits", "spends", "leaves", "labels"] as const;
export type VaultSyncList = (typeof VAULT_SYNC_LISTS)[number];

/**
 * Each list's first page, in rows: as many as one view call can carry at no more than 125 Tgas (vault review R-03,
 * research docs/reviews/vault-review-opus-contract.md l.45). The view caps:
 * - The protocol's is 1,000 Tgas today; it was 200 Tgas, then 300 from protocol 52, then 1,000 from 83 (near-parameters
 *   0.37.4 res/runtime_configs/52.yaml l.2, 83.yaml l.8, parameters.snap l.203). A node can set its own lower one
 *   (near-chain-configs 0.37.4 client_config.rs l.836, max_gas_burnt_view).
 * - On the six RPCs the kit and the exit tool list (NEAR_NETWORKS, EXIT_NETWORKS), a view that grows with its input
 *   gave the same cap: social's get with K copies of one empty key passed at K = 15,412 to 15,429 and stopped at
 *   15,451 to 15,546 on every one, testnet and mainnet (read 2026-11-06 05:48-05:49Z). So none of them caps below
 *   the others. The lowest cap any nearcore has had is 200 Tgas, so 125 Tgas leaves over a third of it spare.
 * The gas per page was measured with the release build in near-sandbox 2.13.4, with each list's largest rows
 * (contracts/vault/tests/review_viewgas.rs, review R-03):
 * - spends: 250 rows 125.135 Tgas (500 rows 249.148, 1,000 rows 497.053), so 250;
 * - deposits: 1,000 rows 276.385 Tgas, at most 0.277 a row with the call's own cost in it, so 450 (at most 124.4);
 * - leaves: 1,000 rows 162.548 Tgas, at most 0.163 a row, so 750 (at most 121.9);
 * - labels: the same view code as leaves (lib.rs `labels` and `leaves` are both tree_page), so 750.
 * A page an RPC still refuses as too heavy (vaultViewTooHeavy) is read again at half its rows, down to one row.
 */
export const VAULT_SYNC_PAGE: Readonly<Record<VaultSyncList, number>> = Object.freeze({ deposits: 450, spends: 250, leaves: 750, labels: 750 });

/**
 * Whether one RPC's answer to a view refuses it as too heavy, so the same rows read in a smaller page can pass:
 * - nearcore's gas cap: `result.error` is "wasm execution failed with error: HostError(GasLimitExceeded)" at HTTP 200,
 *   the exact answer of all six listed RPCs to a view over the cap (read 2026-11-06 05:47-05:49Z on
 *   rpc.mainnet.fastnear.com, rpc.mainnet.near.org, near.drpc.org, test.rpc.fastnear.com, rpc.testnet.near.org and
 *   near-testnet.drpc.org);
 * - dRPC's free plan's time cap: `error.code` 30 with "Request timeout on the free plan, please upgrade to paid plan",
 *   at HTTP 408. near.drpc.org and near-testnet.drpc.org gave it to a slow view that FastNEAR answered in 640 ms
 *   (read 2026-11-06 05:47Z). The RPC adapters give that answer back rather than throw on it (nearRpc, exitRpc).
 * Any other answer is not this one: another error stops the read as before, so a fault never halves a page forever.
 */
export function vaultViewTooHeavy(a: unknown): boolean {
  if (!isObj(a)) return false;
  if (isObj(a.result) && typeof a.result.error === "string") return a.result.error.includes("HostError(GasLimitExceeded)");
  return isObj(a.error) && a.error.code === 30 && typeof a.error.message === "string" && a.error.message.startsWith("Request timeout on the free plan");
}

/**
 * Where the next sync starts: per list, the first row it reads; the height the last sync read at, which the next must
 * not be below. JSON numbers only, so a caller stores it as is.
 */
export type VaultSyncCursor = { vault: string; height: number } & Record<VaultSyncList, number>;

/** The cursor of a vault never read: every list from 0. */
export function vaultSyncStart(vault: string): VaultSyncCursor {
  return { vault: vaultAccountId(vault, "vault"), height: 0, deposits: 0, spends: 0, leaves: 0, labels: 0 };
}

/** A row of the deposits view (DepositView). */
export type VaultDepositRow = { index: number; precommitment: bigint; label: bigint; value: bigint; leafIndex: bigint; depositor: string };
/** A row of the spends view (SpendView): the spend, its request data and its refund note's fields. */
export type VaultSpendRow = {
  index: number;
  nullifierHash: bigint;
  withdrawn: bigint;
  newLeafIndex: bigint;
  refundPrecommitment: bigint;
  refundValue: bigint;
  refundLabel: bigint;
  refundLeafIndex: bigint;
  status: VaultSpendStatus;
  payer: string;
  reserve: bigint;
  recipient: string;
  fee: bigint;
  context: bigint;
};
/** state_tree() or label_tree(). */
export type VaultTreeHead = { size: number; depth: number; root: bigint };

export type VaultSyncResult = {
  /** The block every read named, on both RPCs. */
  height: number;
  blockHash: string;
  stateTree: VaultTreeHead;
  labelTree: VaultTreeHead;
  /** Each list's rows from the cursor given to its end at `height`; a list not asked for is empty. */
  deposits: VaultDepositRow[];
  spends: VaultSpendRow[];
  /** Leaves and labels from the cursor's leaves and labels index on. */
  leaves: bigint[];
  labels: bigint[];
  /** The next sync's start. */
  cursor: VaultSyncCursor;
};

export type VaultSyncStopCode = "input" | "rpc" | "disagree" | "row" | "count" | "behind" | "lag";
export class VaultSyncStopped extends Error {
  readonly code: VaultSyncStopCode;
  constructor(code: VaultSyncStopCode, detail: string) {
    super(`vault sync stopped (${code}): ${detail}`);
    this.name = "VaultSyncStopped";
    this.code = code;
  }
}

export type VaultSyncArgs = {
  vault: string;
  /** Two RPCs of different operators. */
  rpcs: readonly [VaultSyncRpc, VaultSyncRpc];
  /** vaultSyncStart(vault) on a first read; else the cursor the last sync returned. */
  cursor: VaultSyncCursor;
  /** The lists to read; all four unless given. Lists not read keep their cursor. */
  lists?: readonly VaultSyncList[];
  signal?: AbortSignal;
};

/** Reads the vault's pages from `cursor` on both RPCs at one block and returns the rows both gave, byte for byte. */
export async function vaultSync(args: VaultSyncArgs): Promise<VaultSyncResult> {
  const { vault, rpcs, cursor, signal } = args;
  const lists = args.lists ?? VAULT_SYNC_LISTS;
  checkInput(vault, rpcs, cursor, lists);

  // The two final heights; every read after this one names the lower.
  signal?.throwIfAborted();
  const probe = call(vault, "state_tree", {}, { finality: "final" });
  const finals = await Promise.all([answer(rpcs[0], probe, signal), answer(rpcs[1], probe, signal)]);
  if (Math.abs(finals[0].height - finals[1].height) > VAULT_SYNC_LAG_MAX)
    throw new VaultSyncStopped("lag", `the RPCs' final heights ${finals[0].height} and ${finals[1].height} are over ${VAULT_SYNC_LAG_MAX} blocks apart`);
  const height = Math.min(finals[0].height, finals[1].height);
  if (height < cursor.height) throw new VaultSyncStopped("behind", `the RPCs' final height ${height} is below the cursor's ${cursor.height}`);

  let blockHash = "";
  const read = async (method: string, a: Record<string, number>): Promise<unknown> => {
    signal?.throwIfAborted();
    const at = call(vault, method, a, { block_id: height });
    const [x, y] = await Promise.all([answer(rpcs[0], at, signal), answer(rpcs[1], at, signal)]);
    if (x.height !== height || y.height !== height) throw new VaultSyncStopped("rpc", `${method}: an answer not at block ${height}`);
    if (x.hash !== y.hash || (blockHash !== "" && x.hash !== blockHash)) throw new VaultSyncStopped("disagree", `${method}: two blocks at height ${height}`);
    blockHash = x.hash;
    if (!sameBytes(x.bytes, y.bytes)) throw new VaultSyncStopped("disagree", `${method}(${JSON.stringify(a)}): the RPCs' answers differ`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(x.bytes);
    } catch {
      throw new VaultSyncStopped("row", `${method}: not UTF-8`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new VaultSyncStopped("row", `${method}: not JSON`);
    }
    if (JSON.stringify(inVaultOrder(method, value)) !== text)
      throw new VaultSyncStopped("row", `${method}: not the vault's own bytes (field order, a repeated field, spacing or a number's form)`);
    return value;
  };

  const stateTree = head(await read("state_tree", {}), "state_tree");
  const labelTree = head(await read("label_tree", {}), "label_tree");
  const next: VaultSyncCursor = { ...cursor, height };
  const out: VaultSyncResult = { height, blockHash, stateTree, labelTree, deposits: [], spends: [], leaves: [], labels: [], cursor: next };

  for (const list of VAULT_SYNC_LISTS) {
    if (!lists.includes(list)) continue;
    const from = cursor[list];
    const size = list === "leaves" ? stateTree.size : list === "labels" ? labelTree.size : null;
    const rows: unknown[] = [];
    // A page an RPC refuses as too heavy is read again at half its rows, on both RPCs, so both still answer the same
    // rows; the smaller page holds for the rest of this list. One row refused stops the sync.
    let limit = VAULT_SYNC_PAGE[list];
    for (let at = from; ; ) {
      let page: unknown;
      try {
        page = await read(list, { from: at, limit });
      } catch (e) {
        if (!(e instanceof TooHeavy) || limit === 1) throw e;
        limit = Math.floor(limit / 2);
        continue;
      }
      if (!Array.isArray(page) || page.length > limit) throw new VaultSyncStopped("row", `${list}: not a page`);
      page.forEach((x, k) => rows.push(parseRow(list, x, at + k)));
      if (page.length < limit) break;
      at += limit;
    }
    // A deposits or spends cursor past the list's end would read no row and wait there, skipping every row written
    // below it later: an empty read from c > 0 must find row c - 1.
    if (size === null && rows.length === 0 && from > 0) {
      const last = await read(list, { from: from - 1, limit: 1 });
      if (!Array.isArray(last) || last.length !== 1) throw new VaultSyncStopped("count", `${list}: the cursor ${from} is past the list's end`);
      parseRow(list, last[0], from - 1);
    }
    const end = from + rows.length; // a cursor past the list's end reads no row, so it ends past the tree's size too
    if (size !== null && end !== size) throw new VaultSyncStopped("count", `${list}: the pages end at ${end}, the tree's size is ${size}`);
    if (list === "deposits") out.deposits = rows as VaultDepositRow[];
    else if (list === "spends") out.spends = rows as VaultSpendRow[];
    else out[list] = rows as bigint[];
    // A spend can change until it is settled: the next sync starts at the first one that is not.
    const open = list === "spends" ? out.spends.findIndex((s) => s.status !== "settled") : -1;
    next[list] = open === -1 ? end : from + open;
  }
  return out;
}

// ---------- reads ----------
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

function call(vault: string, method: string, a: Record<string, number>, at: { finality: "final" } | { block_id: number }): Obj {
  return { request_type: "call_function", account_id: vault, method_name: method, args_base64: btoa(JSON.stringify(a)), ...at };
}

/** One RPC's answer to one view call: its bytes, height and block hash, or a stop ("rpc"). */
async function answer(rpc: VaultSyncRpc, params: Obj, signal?: AbortSignal): Promise<{ bytes: Uint8Array; height: number; hash: string }> {
  let a: unknown;
  try {
    a = await untilAbort(rpc.query(params, signal), signal);
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    throw new VaultSyncStopped("rpc", `${rpc.name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (vaultViewTooHeavy(a)) throw new TooHeavy(`${rpc.name}: ${String(params.method_name)}: refused as too heavy`);
  const r = isObj(a) && a.error === undefined ? a.result : undefined;
  const bytes = isObj(r) && r.error === undefined ? r.result : undefined;
  if (
    !isObj(r) ||
    !Number.isSafeInteger(r.block_height) ||
    (r.block_height as number) <= 0 ||
    typeof r.block_hash !== "string" ||
    !Array.isArray(bytes) ||
    !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  )
    throw new VaultSyncStopped("rpc", `${rpc.name}: ${String(params.method_name)}: not a view result`);
  return { bytes: Uint8Array.from(bytes as number[]), height: r.block_height as number, hash: r.block_hash };
}

/**
 * An RPC's answer that a view is too heavy (vaultViewTooHeavy): a stop ("rpc") like any other, except that a list read
 * of more than one row catches it and halves its page.
 */
class TooHeavy extends VaultSyncStopped {
  constructor(detail: string) {
    super("rpc", detail);
  }
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function checkInput(vault: string, rpcs: readonly [VaultSyncRpc, VaultSyncRpc], cursor: VaultSyncCursor, lists: readonly VaultSyncList[]): void {
  const no = (d: string) => new VaultSyncStopped("input", d);
  try {
    vaultAccountId(vault, "vault");
  } catch (e) {
    throw no((e as Error).message);
  }
  if (!Array.isArray(rpcs) || rpcs.length !== 2 || !rpcs.every((r) => isObj(r) && typeof r.query === "function" && typeof r.name === "string"))
    throw no("two RPCs, each with a name and query");
  if (rpcs[0] === rpcs[1] || rpcs[0].name === rpcs[1].name) throw no("the two RPCs are one");
  if (!isObj(cursor) || cursor.vault !== vault) throw no("the cursor is not this vault's");
  for (const k of ["height", ...VAULT_SYNC_LISTS] as const) if (!Number.isSafeInteger(cursor[k]) || cursor[k] < 0) throw no(`cursor.${k}: not a whole number`);
  if (!Array.isArray(lists) || !lists.every((l) => (VAULT_SYNC_LISTS as readonly string[]).includes(l))) throw no(`lists: only ${VAULT_SYNC_LISTS.join(", ")}`);
}

// ---------- rows, as the vault's views write them (contracts/vault/src/lib.rs) ----------
const DEPOSIT_FIELDS = ["index", "precommitment", "label", "value", "leaf_index", "depositor"];
const SPEND_FIELDS = [
  "index",
  "nullifier_hash",
  "withdrawn",
  "new_leaf_index",
  "refund_precommitment",
  "refund_value",
  "refund_label",
  "refund_leaf_index",
  "status",
  "payer",
  "reserve",
  "recipient",
  "fee",
  "context",
];
const TREE_FIELDS = ["size", "depth", "root"];
const STATUSES: readonly VaultSpendStatus[] = ["in_flight", "paid", "refund_pending", "settled"];

/** A view's value with each object's fields in the vault's struct order, as its serializer writes them. */
function inVaultOrder(method: string, v: unknown): unknown {
  const order = method === "deposits" ? DEPOSIT_FIELDS : method === "spends" ? SPEND_FIELDS : method.endsWith("_tree") ? TREE_FIELDS : null;
  if (order === null) return v;
  const pick = (o: unknown) => (isObj(o) ? Object.fromEntries(order.map((k) => [k, o[k]])) : o);
  return Array.isArray(v) ? v.map(pick) : pick(v);
}

function parseRow(list: VaultSyncList, x: unknown, at: number): unknown {
  try {
    if (list === "leaves" || list === "labels") return field(x, "leaf");
    const o = fields(x, list === "deposits" ? DEPOSIT_FIELDS : SPEND_FIELDS);
    if (o.index !== at) throw new Error(`index ${String(o.index)} at ${at}`);
    if (list === "deposits")
      return {
        index: at,
        precommitment: field(o.precommitment, "precommitment"),
        label: field(o.label, "label"),
        value: u128(o.value, "value"),
        leafIndex: u64(o.leaf_index, "leaf_index"),
        depositor: vaultAccountId(o.depositor as string, "depositor"),
      } satisfies VaultDepositRow;
    if (!STATUSES.includes(o.status as VaultSpendStatus)) throw new Error("status: not a spend status");
    return {
      index: at,
      nullifierHash: field(o.nullifier_hash, "nullifier_hash"),
      withdrawn: u128(o.withdrawn, "withdrawn"),
      newLeafIndex: u64(o.new_leaf_index, "new_leaf_index"),
      refundPrecommitment: field(o.refund_precommitment, "refund_precommitment"),
      refundValue: u128(o.refund_value, "refund_value"),
      refundLabel: field(o.refund_label, "refund_label"),
      refundLeafIndex: u64(o.refund_leaf_index, "refund_leaf_index"),
      status: o.status as VaultSpendStatus,
      payer: vaultAccountId(o.payer as string, "payer"),
      reserve: u128(o.reserve, "reserve"),
      recipient: vaultAccountId(o.recipient as string, "recipient"),
      fee: u128(o.fee, "fee"),
      context: field(o.context, "context"),
    } satisfies VaultSpendRow;
  } catch (e) {
    throw new VaultSyncStopped("row", `${list} row ${at}: ${(e as Error).message}`);
  }
}

function head(x: unknown, what: string): VaultTreeHead {
  try {
    const o = fields(x, TREE_FIELDS);
    const depth = o.depth;
    if (!Number.isSafeInteger(depth) || (depth as number) < 0 || (depth as number) > VAULT_CONSTANTS.MAX_TREE_DEPTH) throw new Error("depth");
    return { size: Number(u64(o.size, "size")), depth: depth as number, root: field(o.root, "root") };
  } catch (e) {
    throw new VaultSyncStopped("row", `${what}: ${(e as Error).message}`);
  }
}

/** An object with every one of these fields (an extra, repeated or reordered field is refused before, by the bytes check in read). */
function fields(x: unknown, names: readonly string[]): Obj {
  if (!isObj(x)) throw new Error("not an object");
  const keys = Object.keys(x);
  if (!names.every((n) => keys.includes(n))) throw new Error(`fields: not ${names.join(", ")}`);
  return x;
}
function field(x: unknown, what: string): bigint {
  const n = vaultDecimal(x as string, what);
  if (n >= VAULT_FIELD_P) throw new Error(`${what}: not below p`);
  return n;
}
function u128(x: unknown, what: string): bigint {
  const n = vaultDecimal(x as string, what);
  if (n >= 1n << 128n) throw new Error(`${what}: not a u128`);
  return n;
}
/** A u64 the vault writes as a JSON number: a safe integer here, since every index is below 2^53. */
function u64(x: unknown, what: string): bigint {
  if (!Number.isSafeInteger(x) || (x as number) < 0) throw new Error(`${what}: not a whole number`);
  return BigInt(x as number);
}
