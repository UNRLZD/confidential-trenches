// U's deposit from the signed call to the note's leaf (card wallet-deposit-bind, lane W2.3, W:1101; docs/plan1 at
// research 6e55c52): the device's side of the relayer's answers, wallet.md §2.4 W:446-480 and the vault paper's 2.10
// (c)-(d), V:674-692; the answers are the kit's frozen POST /v1/bind codes (HELPER_BIND_DEPOSIT_CODES, M:3341).
//
// One call per note. The note is the store's (await planDeposit, or the store's add for a second arrival, before this
// runs): its precommitment P is re-derived from the seed by its ref and must equal the record, and the note goes
// PLANNED -> INCOMING before P first leaves the device inside U's signed call (../notes/store.ts caller rules).
//   - The deposit is confirmed only from the vault's `deposits` pages, read through the kit's vaultSync (two RPCs, one
//     block, byte for byte; card wallet-bind-on-sync) and matched on the device (P, depositor U, value = amount): never
//     from the relayer's answer, a tx read by hash or a prepaid read (W:419, V:674-675). A sync that stops
//     (VaultSyncStopped: one RPC behind, down or disagreeing) confirms nothing: the device reads again.
//   - The search for P starts at 0 while the note holds no call: "no call" is only this store's word, and P comes from
//     the seed, so another device on the seed (same lane) may have landed P anywhere (review H1). The first read runs to
//     the pages' end before P leaves this device, and the note's first call records that count (searchFrom); every
//     later read, a reload's too, starts there, since no row below it can hold P. A call written before notes held a
//     start reads from 0. The note store's vault cursor gives the reads only its height (no older block than the last).
//   - Nothing landed (W:448-455, V:675-677): P counts as absent only from a sync at a block past max_block_height + 5,
//     a floor put in the sync's cursor.height so a lower block stops ("behind"); U's key nonce and USDC are read at
//     that same block (block_id), so the pages and U are one state. With P not held and U's key nonce unchanged there,
//     the device signs again, and at the same nonce, so at most one of the two calls can land (nearcore refuses a
//     delegate nonce at or below the key nonce, actions.rs l.669).
//   - Every re-sign, the lapse's and resign_needed's, is checked before anything is sent: a signed call whose nonce is
//     not the earlier call's is refused and dropped (resignDeposit). The earlier call's nonce is free only once U's key
//     nonce has moved past it.
//   - Every call U signs for the note is written with the note (the note store's calls, ../notes/store.ts) before it
//     is sent, and the relayer's tx hash for it once heard; a write that fails stops the send. A bind of a note that
//     already holds a call (a reload, a retry, another tab) settles the latest one before it signs anything, and of two
//     binds writing at once only the first sends (the write is a compare-and-set under the notes lock).
//   - Refused (W:456-458): U's nonce moved and P not held: a new call on the same P at U's nonce + 1, only once the
//     call that used that nonce is known and done: of the note's calls at that nonce, the one whose transaction both
//     RPCs read FINAL (every receipt done, wait_until FINAL) carrying exactly that signed call, with its Delegate
//     receipt run on U and succeeded (an expired or refused sibling at the same nonce is not it); the pages are read
//     once more after those reads; and U's USDC is back to what that call was signed from. Until then its USDC may
//     still be on its way to the vault, which would refuse a second call on P as a failed send (R3 strikes U after
//     three). The tx hash comes from the relayer's tx_hash answer, or from sending the same signed bytes again, once
//     per nonce (the relayer answers 200 {tx_hash} of the transaction that carried those exact bytes, before check 3;
//     sender_struck there stops as R3); a hash the device cannot verify on both RPCs, or none, means keep reading
//     and never sign (the money stays in U). These reads only hold the device back; the deposit itself is confirmed
//     only by the pages.
//   - prepay_open, R2 (W:459-460): wait until U's previous note has landed (its leaf, read from the pages, in the note
//     store), then send the same signed bytes
//     while their window is ahead, else as nothing landed. resign_needed, R4 (W:461): sign again at the same nonce
//     with a new window. sender_struck, R3 (W:462-467): stop; nothing more is signed for U this session, and the
//     outcome tells the caller to open the way out (withdraw.open, U's own plain ft_transfer; V 2.12 step 5).
//   - Never storage_unregister on U, and never DeleteAccount while a call U signed can land (W:471-480, V:682-686):
//     checkCleanup, which the clean-up signer must call first, reads every call from the note store.
// A P the pages hold for another deposit (a front-run naming P, W:456-458 and point 9) is still this device's note:
// its leaf hashes from our P, so the note goes UNSPENT with that leaf and the outcome says front_run; the caller signs
// the amount again on U's next second-arrival note.
// Nothing here logs. No request carries a key, the words or a note's secret: the relayer gets the signed delegate
// alone (sendDepositDelegate), and each read names U or the vault.
import { HELPER_RPC_METHODS, type VaultDepositRow, vaultSync, type VaultSyncCursor, vaultSyncStart, VaultSyncStopped } from "@blindfill/kit";
import { base58, base64 } from "@scure/base";
import type { BindCall, NoteRecord, NoteStore } from "../notes/store.ts";
import { noteCommitment, type NoteRef, noteSecrets } from "../notes/secrets.ts";
import { DepositAccountRefused, depositAccount, NEAR_NETWORKS, type NearNetwork, nearPairNetwork, nearPairRule, type NearRpc, nearRpc, RPC_TIMEOUT_MS, heightSpreadOver } from "./account.ts";
import { type BindAnswer, depositDelegate, sendDepositDelegate, type SignedDepositDelegate } from "./delegate.ts";

/** The margin past max_block_height, in blocks, before a call counts as dead (W:448; V:741-743 covers both readings). */
export const LAPSE_MARGIN = 5n;
export const POLL_MS = 1_000;

export type BindRefusalCode = "input" | "note" | "struck" | "early" | "nonce" | "cleanup";
export class DepositBindRefused extends Error {
  readonly code: BindRefusalCode;
  constructor(code: BindRefusalCode, detail: string) {
    super(`deposit bind refused (${code}): ${detail}`);
    this.name = "DepositBindRefused";
    this.code = code;
  }
}

export interface BindDepositArgs {
  network: NearNetwork;
  /** U = U_{s,i}. */
  s: bigint;
  i: number;
  /** The store's id of the note this call makes: U's deposit note or one of U's second-arrival notes. */
  noteId: string;
  /** In the token's base units: this call's note in the split (W:422-434). */
  amount: bigint;
  window?: number;
}

/** A NEAR provider that also reads a transaction's status (the kit's HELPER_RPC_METHODS.near names `tx`). */
export interface BindRpc extends NearRpc {
  tx(params: { tx_hash: string; sender_account_id: string; wait_until: "FINAL" }): Promise<unknown>;
}
/** A provider by URL, for both `query` (nearRpc) and `tx`. A status other than 200 or no answer in time throws. */
export function bindRpc(url: string, fetchFn: typeof fetch = fetch, timeoutMs = RPC_TIMEOUT_MS): BindRpc {
  const q = nearRpc(url, fetchFn, timeoutMs);
  return {
    name: q.name,
    query: q.query,
    async tx(params) {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "blindfill", method: TX_METHOD, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
  };
}
const TX_METHOD = "tx";
if (!(HELPER_RPC_METHODS.near as readonly string[]).includes(TX_METHOD)) throw new Error(`"${TX_METHOD}" is not on the kit's NEAR method list`);

/**
 * The account that sends the release relayer's transactions (markets.md LD3, `bind.<ours>.near`), the `tx` read's
 * sender_account_id. The release has not written it yet: while null, a refused call's transaction cannot be read, so
 * the refused branch never signs (fail closed). A wrong value only makes the read fail: the tx must carry U's own
 * signed call.
 */
export const RELEASE_RELAYER: Readonly<Record<NearNetwork, string | null>> = Object.freeze({ mainnet: null, testnet: null });

export interface BindDeps {
  store: NoteStore;
  rpcs: readonly [BindRpc, BindRpc];
  /** RELEASE_RELAYER of the network unless given (tests). */
  relayerAccount?: string | null;
  fetchFn?: typeof fetch;
  /** Waits between reads; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  /**
   * Told before every wait of the bind (a code it reads again after: a halt among them, "halted", "token_halted"; the
   * pages, "pages"; a lapse, "lapse"; the relayer's answers). A throw from it ends the bind there, the seed zeroed, with
   * what it wrote kept: a later bind of the note picks up from the store (the call written) and the pages, so a caller
   * that opens the seed only for each step (card wallet-deposit-follow) throws here and calls again.
   */
  onWait?: (code: string) => Promise<void> | void;
}

export type BindOutcome =
  /** The pages hold P for U at the amount on both RPCs; the note is UNSPENT with that leaf. */
  | { kind: "deposited"; note: NoteRecord }
  /** The pages hold P for another deposit; the note is UNSPENT with that leaf, and the amount goes on U's next note. */
  | { kind: "front_run"; note: NoteRecord }
  /** R3: nothing more is signed for U; the caller opens withdraw.open for U (V 2.12 step 5). */
  | { kind: "struck"; account: string }
  /** The relayer refused the call by one of its checks: nothing more is sent, the USDC stays in U. */
  | { kind: "refused"; code: string };

// ---------- this tab's binds, per U (the calls U signed are the note store's, see bindDeposit) ----------
const struck = new Set<string>();
const running = new Map<string, number>(); // U -> binds running for it in this tab
// note id -> the call the relayer refused for now (prepay_open, a retry code), so a bind that ended on its wait (onWait
// threw) sends the same bytes again while ahead of max_block_height, as one that waited would; a reload settles it
const resend = new Map<string, { nonce: bigint; code: string }>();

// ---------- reads on two RPCs ----------
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const DIGITS = /^(0|[1-9][0-9]*)$/;

// The release pair of `network` (account.ts nearPairNetwork, the one rule), each with `tx` when `tx` is asked; with no
// network, the pair of any network: the exported reads below take no network, and their account ids are on both.
function checkPair(network: NearNetwork | undefined, rpcs: readonly NearRpc[], tx: boolean): void {
  const net = nearPairNetwork(rpcs);
  if (net === null || (network !== undefined && net !== network) || (tx && !rpcs.every((r) => typeof (r as BindRpc).tx === "function")))
    throw new DepositBindRefused("input", nearPairRule(network));
}

function resultOf(a: unknown): Obj | undefined {
  const r = isObj(a) && a.error === undefined ? a.result : undefined;
  if (!isObj(r) || r.error !== undefined) return undefined;
  const h = r.block_height;
  return typeof h === "number" && Number.isSafeInteger(h) && h > 0 ? r : undefined;
}

/**
 * U's key nonce at final on each RPC, or at block `at` on both (a sync's height: every answer must be at that block),
 * or null when either does not answer, lacks U's key or they disagree.
 */
export type URead = { nonce: bigint; heights: [bigint, bigint] };
export async function readU(account: string, rpcs: readonly [NearRpc, NearRpc], at?: number): Promise<URead | null> {
  checkPair(undefined, rpcs, false);
  const publicKey = `ed25519:${base58.encode(Uint8Array.from(account.match(/../g)!, (h) => parseInt(h, 16)))}`;
  const block = at === undefined ? { finality: "final" } : { block_id: at };
  const sides = await Promise.all(
    rpcs.map(async (r) => {
      try {
        const res = resultOf(await r.query({ request_type: "view_access_key_list", account_id: account, ...block }));
        const keys = res?.keys;
        if (res === undefined || !Array.isArray(keys) || (at !== undefined && res.block_height !== at)) return null;
        const own = keys.find((k) => isObj(k) && k.public_key === publicKey);
        const nonce = isObj(own) && isObj(own.access_key) ? own.access_key.nonce : undefined;
        if (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0) return null;
        return { nonce: BigInt(nonce), height: BigInt(res.block_height as number) };
      } catch {
        return null;
      }
    }),
  );
  const [a, b] = sides;
  if (!a || !b || a.nonce !== b.nonce || heightSpreadOver([a.height, b.height]) !== null) return null; // a stale "final" is no read
  return { nonce: a.nonce, heights: [a.height, b.height] };
}

/** U's USDC (ft_balance_of on the network's token) at block `at` on both RPCs, equal, else null. */
async function balanceAt(account: string, token: string, rpcs: readonly [NearRpc, NearRpc], at: number): Promise<bigint | null> {
  const args = base64.encode(new TextEncoder().encode(JSON.stringify({ account_id: account })));
  const sides = await Promise.all(
    rpcs.map(async (r) => {
      try {
        const res = resultOf(await r.query({ request_type: "call_function", account_id: token, method_name: "ft_balance_of", args_base64: args, block_id: at }));
        const bytes = res?.result;
        if (res === undefined || res.block_height !== at || !Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
        const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes)));
        return typeof v === "string" && DIGITS.test(v) ? BigInt(v) : null;
      } catch {
        return null;
      }
    }),
  );
  const [a, b] = sides;
  return a === null || b === null || a !== b ? null : a;
}

/** One row of the vault's deposits view, as the kit's sync reads it (contracts/vault/src/lib.rs DepositView). */
export type DepositRow = VaultDepositRow;

/** A read of the pages: P held (its row), absent, or unsure; `height` is the block the sync read at. */
export type PagesRead = { state: "held"; row: DepositRow; height: number } | { state: "absent"; height: number } | { state: "unsure" };

/**
 * Whether the vault's deposits pages hold P, read through the kit's vaultSync (both RPCs at one block, byte for byte)
 * from `from`: held when the rows hold P, absent when they do not, unsure when the sync stops (VaultSyncStopped). With
 * a floor, the sync's block must be at or above it (cursor.height), else it stops "behind": unsure, never absent. The
 * pages only grow, so after each read the next starts at the count it reached; `from` must be a count taken before P
 * first left the device (no row below it can hold P). Each read's cursor goes to `save` (the note store's vault cursor).
 */
export class DepositsWatch {
  private cursor: VaultSyncCursor;
  readonly vault: string;
  readonly p: bigint;
  readonly rpcs: readonly [NearRpc, NearRpc];
  private readonly save: (c: VaultSyncCursor) => Promise<unknown>;
  constructor(vault: string, p: bigint, rpcs: readonly [NearRpc, NearRpc], from?: VaultSyncCursor, save: (c: VaultSyncCursor) => Promise<unknown> = async () => {}) {
    checkPair(undefined, rpcs, false);
    this.vault = vault;
    this.p = p;
    this.rpcs = rpcs;
    this.cursor = from ?? vaultSyncStart(vault);
    this.save = save;
  }
  /** The deposits row the next read starts at. */
  get from(): number {
    return this.cursor.deposits;
  }
  async read(signal?: AbortSignal, floor?: bigint): Promise<PagesRead> {
    const height = floor === undefined ? this.cursor.height : Math.max(this.cursor.height, Number(floor));
    let r;
    try {
      r = await vaultSync({ vault: this.vault, rpcs: this.rpcs, cursor: { ...this.cursor, height }, lists: ["deposits"], ...(signal ? { signal } : {}) });
    } catch (e) {
      if (e instanceof VaultSyncStopped) return { state: "unsure" };
      throw e;
    }
    await this.save(r.cursor);
    const row = r.deposits.find((x) => x.precommitment === this.p);
    if (row !== undefined) return { state: "held", row, height: r.height };
    this.cursor = r.cursor;
    return { state: "absent", height: r.height };
  }
}

// ---------- signing ----------

/** What a re-sign needs of the earlier call. */
export type EarlierCall = Pick<SignedDepositDelegate, "sender_id" | "nonce" | "max_block_height">;

/**
 * Signs U's call again at the earlier call's nonce. For the lapse ("lapse") U is read first on two RPCs, at final or at
 * block `at` (the sync's that read P absent): both heights must be past max_block_height + LAPSE_MARGIN and U's key
 * nonce still below the earlier nonce, else it is refused ("early", "nonce"). For R4 ("resign_needed") the relayer never sent the call and the same nonce is the guard.
 * Either way a signed call at another nonce is refused and dropped, never returned.
 */
export async function resignDeposit(
  seed64: Uint8Array, s: bigint, i: number, args: { network: NearNetwork; amount: bigint; precommitment: bigint; window?: number },
  earlier: EarlierCall, why: "lapse" | "resign_needed", rpcs: readonly [NearRpc, NearRpc], at?: number,
): Promise<SignedDepositDelegate> {
  const nonce = earlier.nonce;
  const mbh = earlier.max_block_height;
  const sender = earlier.sender_id;
  if (typeof nonce !== "bigint" || typeof mbh !== "bigint") throw new DepositBindRefused("input", "the earlier call's nonce and max_block_height are bigints");
  if (why === "lapse") {
    const u = await readU(sender, rpcs, at);
    if (u === null) throw new DepositBindRefused("early", "U's key nonce is not read on both RPCs");
    const low = u.heights[0] < u.heights[1] ? u.heights[0] : u.heights[1];
    if (low <= mbh + LAPSE_MARGIN) throw new DepositBindRefused("early", `final height ${low} is not past max_block_height ${mbh} + ${LAPSE_MARGIN}`);
    if (u.nonce + 1n !== nonce) throw new DepositBindRefused("nonce", `U's key nonce is ${u.nonce}: the earlier call at ${nonce} is not free to sign again`);
  } else if (why !== "resign_needed") throw new DepositBindRefused("input", "a re-sign is for a lapse or resign_needed");
  const call = await depositDelegate(seed64, s, i, args, rpcs);
  if (call.sender_id !== sender || call.nonce !== nonce)
    throw new DepositBindRefused("nonce", `the re-signed call is at ${call.nonce}, not the earlier nonce ${nonce}: dropped`);
  return call;
}

/**
 * The clean-up gate (W:471-480, V:682-686): storage_unregister on a one-time id is always refused; DeleteAccount is
 * refused while a bind for it runs in this tab, while the note store holds no call of the id (a call signed elsewhere,
 * or before the store had calls, may still land), or while a call it holds is not past max_block_height +
 * LAPSE_MARGIN on both RPCs' final heights. Every call is in the store before it is sent (bindDeposit), so a reload
 * or another tab changes nothing here. The calls are read again after the heights' read, so a call written while
 * that read was out is seen. The deposit in the pages and a zero balance are the clean-up row's own reads (W:920).
 */
export async function checkCleanup(action: string, account: string, rpcs: readonly [NearRpc, NearRpc], store: NoteStore): Promise<void> {
  if (action === "storage_unregister") throw new DepositBindRefused("cleanup", "never storage_unregister on a one-time id: the token would burn a refund to it");
  if (action !== "DeleteAccount") throw new DepositBindRefused("cleanup", `${String(action)} is not a clean-up`);
  checkPair(undefined, rpcs, false);
  const gate = async (): Promise<bigint> => {
    if (running.has(account)) throw new DepositBindRefused("cleanup", "a deposit call of this id is being sent");
    const calls = (await store.list()).flatMap((n) => n.calls ?? []).filter((c) => c.sender_id === account);
    if (calls.length === 0) throw new DepositBindRefused("cleanup", "no call of this id is in the note store: one signed elsewhere may still land");
    return calls.reduce((m, c) => (c.max_block_height > m ? c.max_block_height : m), 0n);
  };
  await gate();
  const u = await readU(account, rpcs);
  if (u === null) throw new DepositBindRefused("cleanup", "the id's heights are not read on both RPCs");
  const mbh = await gate();
  const low = u.heights[0] < u.heights[1] ? u.heights[0] : u.heights[1];
  if (low <= mbh + LAPSE_MARGIN) throw new DepositBindRefused("cleanup", `a call this id signed can land until ${mbh}; final height ${low}`);
}

// ---------- a dead call's transaction ----------

type CallBytes = Pick<SignedDepositDelegate, "signed_delegate" | "sender_id" | "receiver_id" | "nonce" | "max_block_height" | "public_key">;
const signatureOf = (call: CallBytes): string => {
  const b = base64.decode(call.signed_delegate);
  return `ed25519:${base58.encode(b.subarray(b.length - 64))}`;
};
// The one FunctionCall inside a signed call's own bytes (delegate.ts encodeDelegateAction): what its Delegate must carry.
function innerOf(call: CallBytes): { method_name: string; args: string; gas: bigint; deposit: bigint } {
  const b = base64.decode(call.signed_delegate);
  let at = 0;
  const uint = (n: number): bigint => {
    if (at + n > b.length) throw new Error("short");
    let v = 0n;
    for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(b[at + k]!);
    at += n;
    return v;
  };
  const blob = (): Uint8Array => {
    const n = Number(uint(4));
    if (at + n > b.length) throw new Error("short");
    at += n;
    return b.subarray(at - n, at);
  };
  blob(); // sender_id
  blob(); // receiver_id
  if (uint(4) !== 1n || uint(1) !== 2n) throw new Error("not one FunctionCall");
  const method_name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob());
  const args = base64.encode(blob());
  return { method_name, args, gas: uint(8), deposit: uint(16) };
}
const outcome = (st: unknown) => isObj(st) && (Object.hasOwn(st, "SuccessValue") || Object.hasOwn(st, "SuccessReceiptId") || Object.hasOwn(st, "Failure"));
const succeeded = (st: unknown) => isObj(st) && Object.keys(st).length === 1 && (Object.hasOwn(st, "SuccessValue") || Object.hasOwn(st, "SuccessReceiptId"));
const exact = (x: unknown) => (typeof x === "number" && Number.isSafeInteger(x) ? BigInt(x) : undefined);
const amount = (x: unknown) => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : typeof x === "string" && DIGITS.test(x) ? BigInt(x) : undefined);

/**
 * True only when `rpc` reads the transaction `hash` FINAL (every receipt executed and final, wait_until FINAL), sent
 * by the release's relayer to U, with exactly one action: a Delegate carrying `call` itself (its signature, sender,
 * receiver, key, nonce, window and its one inner FunctionCall), and that Delegate ran: the tx's one receipt
 * (transaction_outcome's receipt_ids[0]) ran on U and succeeded. So this is the call that used its nonce (nearcore
 * checks the signature, the window and the nonce when the Delegate runs, and a nonce is used once), and with FINAL
 * every receipt it made, the token's and the vault's, is done. Anything else, an error or no answer, is false.
 */
export async function txCarriesFinal(rpc: BindRpc, hash: string, relayer: string, call: CallBytes): Promise<boolean> {
  try {
    const a = await rpc.tx({ tx_hash: hash, sender_account_id: relayer, wait_until: "FINAL" });
    const r = isObj(a) && a.error === undefined ? a.result : undefined;
    if (!isObj(r) || r.final_execution_status !== "FINAL") return false;
    const t = r.transaction;
    if (!isObj(t) || t.hash !== hash || t.signer_id !== relayer || t.receiver_id !== call.sender_id) return false;
    if (!Array.isArray(t.actions) || t.actions.length !== 1 || !isObj(t.actions[0])) return false;
    const dl = t.actions[0].Delegate;
    const da = isObj(dl) ? dl.delegate_action : undefined;
    if (!isObj(dl) || !isObj(da) || dl.signature !== signatureOf(call)) return false;
    if (da.sender_id !== call.sender_id || da.receiver_id !== call.receiver_id || da.public_key !== call.public_key) return false;
    if (exact(da.nonce) !== call.nonce || exact(da.max_block_height) !== call.max_block_height) return false;
    const inner = innerOf(call);
    const acts = da.actions;
    if (!Array.isArray(acts) || acts.length !== 1 || !isObj(acts[0]) || Object.keys(acts[0]).length !== 1) return false;
    const fc = acts[0].FunctionCall;
    if (!isObj(fc) || fc.method_name !== inner.method_name || fc.args !== inner.args || amount(fc.gas) !== inner.gas || amount(fc.deposit) !== inner.deposit) return false;
    if (!outcome(r.status) || !Array.isArray(r.receipts_outcome) || r.receipts_outcome.length === 0) return false;
    if (!r.receipts_outcome.every((o) => isObj(o) && isObj(o.outcome) && outcome(o.outcome.status))) return false;
    // the Delegate's own receipt: the one receipt the tx became, run on U, succeeded
    const to = r.transaction_outcome;
    const ids = isObj(to) && to.id === hash && isObj(to.outcome) && to.outcome.executor_id === relayer ? to.outcome.receipt_ids : undefined;
    if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string") return false;
    const runs = r.receipts_outcome.filter((o) => isObj(o) && o.id === ids[0]);
    const run = runs.length === 1 && isObj(runs[0]) ? runs[0].outcome : undefined;
    return isObj(run) && run.executor_id === call.sender_id && succeeded(run.status);
  } catch {
    return false;
  }
}

const callOf = (c: BindCall): SignedDepositDelegate => ({
  signed_delegate: c.signed_delegate, sender_id: c.sender_id, receiver_id: c.receiver_id, nonce: c.nonce, max_block_height: c.max_block_height, public_key: c.public_key, balance: c.balance,
});

/**
 * Of the note's calls at `nonce`, the one whose transaction (by any hash heard for it) both RPCs read FINAL with its
 * Delegate run and succeeded (txCarriesFinal): the call that used the nonce, all of its receipts done. Else null.
 */
export async function findDeadCall(calls: readonly BindCall[], nonce: bigint, rpcs: readonly [BindRpc, BindRpc], relayer: string): Promise<SignedDepositDelegate | null> {
  checkPair(undefined, rpcs, true);
  for (const c of calls) {
    if (c.nonce !== nonce) continue;
    for (const h of c.tx_hashes) {
      const ok = await Promise.all(rpcs.map((r) => txCarriesFinal(r, h, relayer, c)));
      if (ok.every(Boolean)) return callOf(c);
    }
  }
  return null;
}

// ---------- the bind ----------

// The note before this one under U (R2 waits until the pages hold it): U's deposit note before second arrival 0.
function previousRef(ref: NoteRef): NoteRef | null {
  if (ref.kind !== "second") return null;
  if (ref.id.id !== "U") return null;
  return ref.n === 0 ? { kind: "deposit", s: ref.id.s, i: ref.id.i } : { kind: "second", id: ref.id, n: ref.n - 1 };
}
const isUs = (ref: NoteRef, s: bigint, i: number) =>
  (ref.kind === "deposit" && ref.s === s && ref.i === i) || (ref.kind === "second" && ref.id.id === "U" && ref.id.s === s && ref.id.i === i);

// Codes that say the call may still be (or have been) carried: the pages and U's nonce settle it.
const SETTLE = new Set(["in_flight", "expired", "bad_nonce", "p_used"]);
// Codes that say wait and send the same bytes again while their window is ahead.
const RETRY = new Set(["token_halted", "relayer_low"]);
// Codes on which the device's own reads may continue (one RPC behind or down, a halt, USDC not back yet).
const WAIT_READ = new Set(["rpc", "disagree", "height", "halted", "balance", "not_created"]);

/**
 * Sends U_{s,i}'s call for one note through the release's relayer and follows it until the pages settle it, U is
 * struck, or the relayer refuses it by a check. deps.signal stops the wait (the money stays in U, safe, and a later
 * bind on the same note picks up where the pages and U's nonce say).
 */
export async function bindDeposit(seed64: Uint8Array, args: BindDepositArgs, deps: BindDeps): Promise<BindOutcome> {
  const own: BindDepositArgs = { network: args.network, s: args.s, i: args.i, noteId: args.noteId, amount: args.amount, window: args.window };
  if (!(seed64 instanceof Uint8Array) || seed64.length !== 64) throw new DepositBindRefused("input", "seed64 must be 64 bytes");
  if (typeof own.network !== "string" || !Object.hasOwn(NEAR_NETWORKS, own.network)) throw new DepositBindRefused("input", `unknown network ${String(own.network)}`);
  const vault = NEAR_NETWORKS[own.network].vault;
  if (vault === null) throw new DepositBindRefused("input", `the release names no vault on ${own.network}`);
  const rpcs = deps.rpcs;
  checkPair(own.network, rpcs, true);
  const relayer = deps.relayerAccount === undefined ? RELEASE_RELAYER[own.network] : deps.relayerAccount;
  const seed = Uint8Array.from(seed64);
  const store = deps.store;
  const fetchFn = deps.fetchFn ?? fetch;
  const pollMs = deps.pollMs ?? POLL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const signal = deps.signal;
  const U = depositAccount(seed, own.s, own.i).account;
  const token = NEAR_NETWORKS[own.network].usdc;
  if (struck.has(U)) throw new DepositBindRefused("struck", "the relayer struck U: its USDC leaves by withdraw.open");
  running.set(U, (running.get(U) ?? 0) + 1);
  try {
    // The vault's cursor: its height, so no read is at an older block than the last one this device read.
    const stored = await store.syncCursor(vault);
    // The note: in the store before P leaves, of U, and its P the one the seed gives its ref.
    let note = await store.get(own.noteId);
    if (note === undefined) throw new DepositBindRefused("note", "the note is not in the store: await planDeposit first");
    if (!isUs(note.ref, own.s, own.i)) throw new DepositBindRefused("note", "the note is not U's deposit or second-arrival note");
    const P = note.precommitment;
    if (noteSecrets(seed, note.ref).precommitment !== P) throw new DepositBindRefused("note", "the note's precommitment is not its ref's");
    const prevRef = previousRef(note.ref);
    const previousP = prevRef === null ? null : noteSecrets(seed, prevRef).precommitment;
    const call = { network: own.network, amount: own.amount, precommitment: P, window: own.window };
    // The watch for P: from 0 until a call is written (review H1), then from the note's own start (the count read
    // before P first left; a call written before notes held a start: 0); every later read at the count it reached.
    const watch = new DepositsWatch(vault, P, rpcs, { ...stored, deposits: note.searchFrom ?? 0 }, (c) => store.saveSyncCursor(c));
    // P is absent only at a block past the call's window and margin: the floor of the sync's cursor.height.
    const lapsed = (c: EarlierCall): bigint => c.max_block_height + LAPSE_MARGIN + 1n;
    // R2: U's previous note has landed: its leaf (from the pages on both RPCs) in the note store, or its P read in the
    // pages, as for a previous note marked TAKEN whose P another device on the seed landed (review L2). That P's own
    // watch reads from 0 once, then on from the count it reached.
    let previousWatch: DepositsWatch | null = null;
    const previousLanded = async (): Promise<boolean> => {
      if (previousP === null) return false;
      if ((await store.list()).some((n) => n.precommitment === previousP && n.leaf !== undefined)) return true;
      previousWatch ??= new DepositsWatch(vault, previousP, rpcs, { ...stored, deposits: 0 }, (c) => store.saveSyncCursor(c));
      return (await previousWatch.read(signal)).state === "held";
    };
    // The note's calls as last read (the store's, so a reload, a retry or another tab sees every call signed for it).
    let calls: readonly BindCall[] = [];
    const reread = async (): Promise<NoteRecord> => {
      const n = await store.get(own.noteId);
      if (n === undefined) throw new DepositBindRefused("note", "the note left the store");
      calls = n.calls ?? [];
      return n;
    };
    // The nonces whose dead bytes this bind sent again for a tx hash: once each (the relayer answers 200 {tx_hash} of their carrier).
    const resent = new Set<bigint>();
    type Step = BindOutcome | { call: SignedDepositDelegate; send: boolean };

    const stopped = () => signal?.throwIfAborted();
    // the code the last sign waited on (an RPC behind, USDC not back, U not created): the next pause names it
    let waitOn: string | null = null;
    const pause = async (code: string) => {
      code = waitOn ?? code;
      waitOn = null;
      stopped();
      await deps.onWait?.(code);
      await sleep(pollMs);
      stopped();
    };
    const strike = (): BindOutcome => {
      struck.add(U);
      return { kind: "struck", account: U };
    };
    // The note lands with the leaf the pages give it: INCOMING -> UNSPENT, or already moved by another tab.
    const land = async (r: DepositRow): Promise<BindOutcome> => {
      const leaf = { value: r.value, label: r.label, commitment: noteCommitment(r.value, r.label, P), leafIndex: r.leafIndex };
      // a move another bind of the note made first (its compare-and-set refuses ours) is read back, not redone
      const step = async (from: "PLANNED" | "INCOMING", to: "INCOMING" | "UNSPENT", fields?: { leaf: typeof leaf }): Promise<NoteRecord> => {
        try {
          return await store.move(own.noteId, from, to, fields);
        } catch (e) {
          const n = await store.get(own.noteId);
          if (n === undefined || n.state === from) throw e;
          return n;
        }
      };
      let cur = (await store.get(own.noteId))!;
      if (cur.state === "PLANNED") cur = await step("PLANNED", "INCOMING");
      if (cur.state === "INCOMING") cur = await step("INCOMING", "UNSPENT", { leaf });
      if (cur.leaf === undefined || cur.leaf.leafIndex !== leaf.leafIndex || cur.leaf.commitment !== leaf.commitment)
        throw new DepositBindRefused("note", `the note is ${cur.state} with another leaf`);
      return { kind: r.depositor === U && r.value === own.amount ? "deposited" : "front_run", note: cur };
    };
    // A sign that the device's own reads refuse for now (an RPC behind, USDC not back) waits and reads again.
    const signing = async (f: () => Promise<SignedDepositDelegate>): Promise<SignedDepositDelegate | null> => {
      try {
        return await f();
      } catch (e) {
        if (e instanceof DepositAccountRefused && WAIT_READ.has(e.code)) return ((waitOn = e.code), null);
        if (e instanceof DepositBindRefused && (e.code === "early" || e.code === "nonce")) return null;
        throw e;
      }
    };
    // A signed call is written with the note before it leaves (one write under the notes lock; a failed write throws,
    // so nothing is sent). If another bind of the note wrote a call first, that call is followed and this one is
    // dropped, never sent: of two binds, only the first to write sends.
    // The note's first call carries its search start: the watch's count, read before P leaves.
    const commit = async (c: SignedDepositDelegate): Promise<Step> => {
      const seen = calls.length;
      const n = await store.addCall(own.noteId, { signed_delegate: c.signed_delegate, sender_id: c.sender_id, receiver_id: c.receiver_id, nonce: c.nonce, max_block_height: c.max_block_height, public_key: c.public_key, balance: c.balance }, seen, seen === 0 ? watch.from : undefined);
      calls = n.calls ?? [];
      const last = calls.at(-1);
      if (last === undefined || last.sender_id !== U) throw new DepositBindRefused("note", "the note holds no call of U");
      const mine = calls.length === seen + 1 && last.signed_delegate === c.signed_delegate;
      return { call: mine ? c : callOf(last), send: mine };
    };
    // A tx hash the relayer gives is written with the call before anything else (a failed write stops the bind). The
    // send waits as long as the helper may carry the call (the kit's HELPER_BIND_ANSWER_MS and the way back), so every
    // answer the carry gives is heard and acted on below; the bind's stop ends that wait.
    const send = async (c: SignedDepositDelegate): Promise<BindAnswer | null> => {
      stopped();
      let a: BindAnswer | null;
      try {
        a = await sendDepositDelegate(c, fetchFn, signal);
      } catch {
        stopped();
        a = null; // no answer, a timeout included: unsure, never failed. The relayer may hold it, so the pages and U's nonce settle it
      }
      if (a?.ok) calls = (await store.addCallTx(own.noteId, c, a.tx_hash)).calls ?? [];
      return a;
    };
    // Refused: U's nonce moved past `out`. A new call on the same P only once the call that used that nonce (of the
    // note's calls at it, the one whose tx both RPCs read FINAL with its Delegate run and succeeded) is done in every
    // receipt, the pages still do not hold P, and U's USDC is back to what that call was signed from. With no hash for
    // any call at that nonce, `out`'s bytes go again once for one, and nothing is signed; sender_struck to them stops.
    //   The call that used the nonce may be U's call for another note (a front-run note's call carried after this
    //   note's call was signed at the same nonce, or a stale nonce read on both RPCs): found by the same proof among
    //   U's calls in the other notes, it means none of this note's calls ran, so the next call is signed with no
    //   balance rule (nothing of this P is on its way; the signer's own read still needs U to hold the amount).
    const afterRefusal = async (out: SignedDepositDelegate): Promise<Step | null> => {
      await reread();
      let dead = relayer === null ? null : await findDeadCall(calls, out.nonce, rpcs, relayer);
      let ours = dead !== null;
      if (dead === null && relayer !== null) {
        const others = (await store.list()).filter((n) => n.id !== own.noteId).flatMap((n) => n.calls ?? []).filter((c) => c.sender_id === U);
        dead = await findDeadCall(others, out.nonce, rpcs, relayer);
        ours = false;
      }
      if (dead === null) {
        if (!calls.some((c) => c.nonce === out.nonce && c.tx_hashes.length > 0) && !resent.has(out.nonce)) {
          resent.add(out.nonce);
          const a = await send(out);
          if (a !== null && !a.ok && a.code === "sender_struck") return strike();
        }
        return null;
      }
      const used = dead;
      const gone = await watch.read(signal, lapsed(out)); // the pages once more, after the tx reads
      if (gone.state !== "absent") return null;
      // U's USDC at that same block is back to what the dead call was signed from
      if (ours) {
        const balance = await balanceAt(U, token, rpcs, gone.height);
        if (balance === null || balance < used.balance) return null;
      }
      const c = await signing(async () => {
        const c = await depositDelegate(seed, own.s, own.i, call, rpcs);
        if (c.nonce <= out.nonce) throw new DepositBindRefused("nonce", "a new call must be past the dead one's nonce");
        return c;
      });
      return c === null ? null : commit(c);
    };

    // Settles a call that may be out: the pages hold P, or the call is dead (a lapse, or refused) and a next one is
    // signed and written. Returns the outcome, or the next call (to send, or another bind's to follow).
    // P absent at a block past the window (the floor in the sync's cursor) and U's key nonce read at that block decide.
    const settle = async (out: SignedDepositDelegate): Promise<Step> => {
      for (;;) {
        let pages = await watch.read(signal);
        if (pages.state === "absent") pages = await watch.read(signal, lapsed(out));
        if (pages.state === "held") return land(pages.row);
        if (pages.state === "absent") {
          const at = pages.height;
          const u = await readU(U, rpcs, at);
          let next: Step | null = null;
          if (u !== null && u.nonce + 1n === out.nonce) {
            const c = await signing(() => resignDeposit(seed, own.s, own.i, call, out, "lapse", rpcs, at)); // nothing landed: the same nonce
            if (c !== null) next = await commit(c);
          } else if (u !== null && u.nonce >= out.nonce) next = await afterRefusal(out);
          if (next !== null) return next;
        }
        await pause("lapse");
      }
    };
    // a call the relayer refused for now: the same bytes again while ahead of max_block_height, else settled
    const sendAgain = async (out: SignedDepositDelegate): Promise<Step> => {
      resend.delete(own.noteId);
      const u = await readU(U, rpcs);
      const high = u === null ? null : u.heights[0] > u.heights[1] ? u.heights[0] : u.heights[1];
      return high !== null && high < out.max_block_height ? { call: out, send: true } : await settle(out); // the same bytes while ahead
    };
    // R2 (prepay_open): wait until the pages hold U's previous P; the note's own P landing ends it too
    const prepaid = async (): Promise<BindOutcome | null> => {
      for (;;) {
        const mine = await watch.read(signal);
        if (mine.state === "held") return await land(mine.row);
        if (await previousLanded()) return null;
        await pause("prepay_open");
      }
    };

    // Already in the pages (a reload, or another tab's bind): land it and send nothing.
    for (;;) {
      const first = await watch.read(signal);
      if (first.state === "held") return await land(first.row);
      if (first.state === "absent") break;
      await pause("pages");
    }
    note = await reread();
    if (note.state === "PLANNED") {
      try {
        note = await store.move(own.noteId, "PLANNED", "INCOMING"); // before P leaves
      } catch (e) {
        note = await reread();
        if (note.state === "PLANNED") throw e; // else another bind of the note moved it first
      }
      calls = note.calls ?? [];
    }
    if (note.state !== "INCOMING") throw new DepositBindRefused("note", `the note is ${note.state}, not PLANNED or INCOMING`);

    // A note with a call written (a reload, a retry, another tab): that call is settled before anything is signed.
    let step: Step;
    const last = calls.at(-1);
    if (last !== undefined) {
      const out = callOf(last);
      const was = resend.get(own.noteId);
      if (was?.nonce !== out.nonce) step = { call: out, send: false };
      else if (was.code === "prepay_open") step = (await prepaid()) ?? (await sendAgain(out));
      else step = await sendAgain(out);
    } else {
      let c: SignedDepositDelegate | null = null;
      while (c === null) {
        c = await signing(() => depositDelegate(seed, own.s, own.i, call, rpcs));
        if (c === null) await pause("sign");
      }
      step = await commit(c);
    }
    for (;;) {
      if (!("call" in step)) return step;
      const out = step.call;
      if (!step.send) {
        step = await settle(out);
        continue;
      }
      const answer = await send(out);
      if (answer === null || answer.ok || SETTLE.has(answer.code)) step = await settle(out);
      else if (answer.code === "sender_struck") return strike();
      else if (answer.code === "resign_needed") {
        await pause("resign_needed");
        const again: SignedDepositDelegate | null = await signing(() => resignDeposit(seed, own.s, own.i, call, out, "resign_needed", rpcs));
        step = again === null ? await settle(out) : await commit(again);
      } else if (answer.code === "prepay_open" || RETRY.has(answer.code)) {
        // R2: U's first note has no earlier P the relayer could wait for: refused, before any wait
        if (answer.code === "prepay_open" && previousP === null) return { kind: "refused", code: answer.code };
        // kept before the wait: a bind that ends on it (onWait threw) sends these bytes again on its next call
        resend.set(own.noteId, { nonce: out.nonce, code: answer.code });
        if (answer.code === "prepay_open") {
          const landed = await prepaid();
          if (landed !== null) return (resend.delete(own.noteId), landed);
        }
        await pause(answer.code);
        step = await sendAgain(out);
      } else return { kind: "refused", code: answer.code };
    }
  } finally {
    seed.fill(0);
    const n = running.get(U)! - 1;
    if (n === 0) running.delete(U);
    else running.set(U, n);
  }
}

/** Tests only: forget this tab's struck ids and running binds (a reload). */
export function resetBindSession(): void {
  struck.clear();
  running.clear();
  resend.clear();
}
