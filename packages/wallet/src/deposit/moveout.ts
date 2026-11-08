// A held deposit's way out (card held-deposit-way-out; docs/plan1/wallet.md §2.4 "Struck" W:467-472, the §2.8 rows
// plain move out on the token W:929 and self-submit W:934, at research HEAD): the USDC a held op's one-time id U holds on
// the token moves to the NEAR account the user typed, by U's own transaction.
//
// - Why self-submitted: a struck U is final at our relayer (markets H4.3 R3), so its money "leaves by its own
//   self-submitted plain ft_transfer" (kit helper/v1.ts HELPER_BIND_ONWARD_CODES), and /v1/bind carries no plain move
//   today (apps/helper/src/bind/checks.ts: an ft_transfer is not_ft_transfer_call). One way for every hold: the struck
//   one, amount_above_balance after SHORT_READ_CALLS short reads, and a bind refusal.
// - The typed account is checked by the signing page's one rule (packages/signpage/src/withdraw/checks.ts
//   checkRecipient) before it reaches here; this file checks the payload it signs: receiver the release's token,
//   [storage_deposit(the typed account, registration_only)] then ft_transfer(the typed account, amount) with 1 yocto and
//   no memo, the typed account never U itself.
// - Every read at one block on both RPCs of the release pair, all equal, or nothing is signed: the block's hash, U's key
//   list (exactly its own key) and nonce, U's NEAR and storage, the token's code hash (the kit's pin, W:928), U's USDC,
//   storage_balance_of(the typed account) and the gas price. amount = U's USDC less one base unit (restore still finds U by ft_balance_of, W:929). The registration
//   rides in the same transaction when the typed account reads null on both (both actions in one receipt, which rolls
//   back whole), its deposit the token's storage minimum (arming/accounts.ts readTokenStorageMin, the same read).
// - U's NEAR pays the gas (W:934: what it holds, or a plain Transfer from the typed account, never another account of the
//   seed). U is created with its storage only (apps/helper/src/bind/create.ts CREATE_YOCTO), so the first answer is
//   usually `gas`: how much NEAR U needs, sent from the typed account.
// - Never twice: the signed bytes are written into the op (follow.out) by a compare-and-set before they are sent; an op
//   that holds one signs nothing new. A reload sends the same bytes again and reads them. A record is gone, never to land,
//   only when it reads FINAL and failed on both RPCs (nothing moved); or unknown on both and either expired (U's key nonce
//   below it at a height past its block + TX_VALIDITY_BLOCKS) or taken (U's key nonce at or past it SETTLE_BLOCKS below
//   the read height too: nearcore refuses a nonce at or below the key's, so those bytes never land, and a tx included
//   that far back has run every receipt). A gone record goes to follow.out_past, and a new transaction is signed only on
//   the user's tap (a typed account), never on a resume (null): review of d791adda, M1 and L6.
// - One move of U at a time: the read, the signature and the compare-and-set run under deps.uLock (the page's
//   FOLLOW_LOCK/<network>/<U>, taken only if free, so no deposit follow of U binds U's USDC meanwhile), and while another
//   op of U holds a live record, that record is followed and nothing is signed.
// - The end: the transaction FINAL on both RPCs with every receipt a success, then the op is held with why "moved_out".
// - U's key: depositId(seed, s, i), the derivation the refund move opens (follow.ts openKey), under deps.seedLock, checked
//   to be U and zeroed at once. Nothing here logs. Each read names U, the token or the typed account; the send carries
//   the signed bytes alone.
import { HELPER_RPC_METHODS, VAULT_CONSTANTS, VAULT_TOKEN_CODE_HASH } from "@blindfill/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { readTokenStorageMin } from "../arming/accounts.ts";
import { depositId } from "../derive/keys.ts";
import type { WalletStore } from "../store/index.ts";
import { heightSpreadOver, NEAR_NETWORKS, nearPairNetwork, type NearNetwork, RPC_TIMEOUT_MS } from "./account.ts";
import { type FollowRpc, followRpc, type DepositOp } from "./follow.ts";

/** What the op keeps of its move out (op.follow.out), written before the send: plain values, the signed bytes public. */
export interface MoveOutRecord {
  to: string;
  /** USDC base units. */
  amount: string;
  nonce: string;
  /** The block the reads and the transaction's block hash are at. */
  height: number;
  register: boolean;
  /** The transaction's hash (base58 sha256 of its bytes) and its signed bytes (base64). */
  hash: string;
  signed: string;
}

export type MoveOutOutcome =
  /** FINAL on both RPCs, every receipt a success: the op is held with why "moved_out". */
  | { kind: "moved"; to: string; amount: bigint; hash: string }
  /** Sent (or sent again), not yet read FINAL on both: a later call reads it again and signs nothing. */
  | { kind: "sent"; to: string; amount: bigint; hash: string }
  /** The record can never land (FINAL and failed on both RPCs, expired, or its nonce taken): the next tap signs anew. */
  | { kind: "failed"; to: string; amount: bigint; hash: string }
  /** U's NEAR is short of the transaction's cost: `need` yocto more, from the typed account. */
  | { kind: "gas"; need: bigint; u: string }
  /** U holds one base unit or less on the token: nothing to move. */
  | { kind: "empty" }
  /** A read failed or the two RPCs disagree: nothing signed. */
  | { kind: "unread" };

export class MoveOutRefused extends Error {
  constructor(detail: string) {
    super(`move out refused: ${detail}`);
    this.name = "MoveOutRefused";
  }
}

/** nearcore's transaction_validity_period on mainnet and testnet: a block hash older than this many heights is refused. */
export const TX_VALIDITY_BLOCKS = 86_400n;
const TGAS = 1_000_000_000_000n;
/** ft_transfer's and storage_deposit's gas (the kit's), and the transaction's own send cost on top. */
export const MOVE_GAS = { ft_transfer: BigInt(VAULT_CONSTANTS.GAS_FT_TRANSFER_TGAS) * TGAS, storage_deposit: BigInt(VAULT_CONSTANTS.GAS_STORAGE_DEPOSIT_TGAS) * TGAS, send: 5n * TGAS };
/**
 * What the signer must hold for its prepaid gas, over the gas price read: nearcore charges the prepaid gas at its
 * pessimistic price (the inflation compounded over the receipt depth), about 9x on testnet (InvalidTxError
 * NotEnoughBalance for this card's 25 Tgas move: cost 26,720,497,453,181,500,000,000 yocto at gas price 100,000,000, read
 * 8 Nov 02:00Z), so the need is counted at 12x. What the gas does not burn goes back to U.
 */
export const GAS_PRICE_MARGIN = 12n;
/** near-sdk's storage_byte_cost(), yocto per byte: what U's own storage holds back of its NEAR. */
const BYTE_COST = 10_000_000_000_000_000_000n;
/** How many tx reads one call waits for FINAL before it answers `sent`. */
export const FINAL_TRIES = 20;

/** A provider by URL for query, tx, block, gas_price and send_tx (all on the kit's NEAR method list). */
export interface MoveOutRpc extends FollowRpc {
  call(method: string, params: unknown): Promise<unknown>;
}
for (const m of ["gas_price", "send_tx"]) if (!(HELPER_RPC_METHODS.near as readonly string[]).includes(m)) throw new Error(`"${m}" is not on the kit's NEAR method list`);
export function moveOutRpc(url: string, fetchFn: typeof fetch = fetch, timeoutMs = RPC_TIMEOUT_MS): MoveOutRpc {
  return {
    ...followRpc(url, fetchFn, timeoutMs),
    async call(method, params) {
      const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "blindfill", method, params }), signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
  };
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const DIGITS = /^(0|[1-9][0-9]*)$/;
const IMPLICIT = /^[0-9a-f]{64}$/;
const big = (x: unknown): bigint | null => (typeof x === "string" && DIGITS.test(x) ? BigInt(x) : typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : null);
const resultAt = (a: unknown, at: number): Obj | undefined => {
  const r = isObj(a) && a.error === undefined ? a.result : undefined;
  return isObj(r) && r.error === undefined && r.block_height === at ? r : undefined;
};
const viewArgs = (args: Obj) => base64.encode(new TextEncoder().encode(JSON.stringify(args)));
const decodeView = (r: Obj | undefined): unknown => {
  const bytes = r?.result;
  if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error("no view");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes as number[])));
};

const ownKey = (u: string) => `ed25519:${base58.encode(Uint8Array.from(u.match(/../g)!, (h) => parseInt(h, 16)))}`;
/** U's key nonce from a view_access_key_list answer at `at`: the list is exactly U's own key, else null. */
function keyNonce(keys: unknown, at: number, own: string): bigint | null {
  const k = resultAt(keys, at);
  const list = k?.keys;
  if (!Array.isArray(list) || list.length !== 1 || !isObj(list[0]) || list[0].public_key !== own || !isObj(list[0].access_key)) return null;
  return big(list[0].access_key.nonce);
}
/** U's key nonce at block `at` on both RPCs, equal, else null. */
async function keyNonceAt(u: string, at: number, rpcs: readonly [MoveOutRpc, MoveOutRpc]): Promise<bigint | null> {
  const own = ownKey(u);
  const [a, b] = await Promise.all(rpcs.map((r) => r.query({ request_type: "view_access_key_list", account_id: u, block_id: at }).then((k) => keyNonce(k, at, own), () => null)));
  return a === null || b === null || a !== b ? null : a;
}

/** What the move needs read, at one block on both RPCs. */
export interface MoveOutRead {
  height: number;
  blockHash: string;
  nonce: bigint;
  /** U's NEAR free of its own storage, yocto. */
  free: bigint;
  usdc: bigint;
  registered: boolean;
  gasPrice: bigint;
}

/**
 * U's state and the typed account's registration at one block on both RPCs: each RPC's final, the heights within
 * HEIGHT_SPREAD_MAX, then everything at the lower height on both, equal. null when anything fails or differs, U's key
 * list is not exactly U's own key, the token's code hash is not the kit's pin, or USDC's view fails (a halt is never a
 * zero).
 */
export async function readMoveOut(u: string, to: string, token: string, rpcs: readonly [MoveOutRpc, MoveOutRpc]): Promise<MoveOutRead | null> {
  const own = ownKey(u);
  const finals = await Promise.all(rpcs.map(async (r) => {
    try {
      const a = await r.block({ finality: "final" });
      const h = isObj(a) && isObj(a.result) && isObj(a.result.header) ? a.result.header.height : undefined;
      return typeof h === "number" && Number.isSafeInteger(h) && h > 0 ? h : null;
    } catch {
      return null;
    }
  }));
  if (finals.some((h) => h === null) || heightSpreadOver(finals as number[]) !== null) return null;
  const at = Math.min(...(finals as number[]));
  const side = async (r: MoveOutRpc) => {
    try {
      const [b, keys, acct, code, bal, reg, gp] = await Promise.all([
        r.block({ block_id: at }),
        r.query({ request_type: "view_access_key_list", account_id: u, block_id: at }),
        r.query({ request_type: "view_account", account_id: u, block_id: at }),
        r.query({ request_type: "view_account", account_id: token, block_id: at }),
        r.query({ request_type: "call_function", account_id: token, method_name: "ft_balance_of", args_base64: viewArgs({ account_id: u }), block_id: at }),
        r.query({ request_type: "call_function", account_id: token, method_name: "storage_balance_of", args_base64: viewArgs({ account_id: to }), block_id: at }),
        r.call("gas_price", [at]),
      ]);
      const head = isObj(b) && isObj(b.result) && isObj(b.result.header) ? b.result.header : undefined;
      if (!head || head.height !== at || typeof head.hash !== "string") return null;
      const nonce = keyNonce(keys, at, own);
      if (resultAt(code, at)?.code_hash !== VAULT_TOKEN_CODE_HASH) return null; // the token's code is the pin (W:928)
      const a = resultAt(acct, at);
      const amount = big(a?.amount), usage = big(a?.storage_usage);
      const usdc = decodeView(resultAt(bal, at));
      const registration = decodeView(resultAt(reg, at));
      const price = isObj(gp) && isObj(gp.result) ? big(gp.result.gas_price) : null;
      if (nonce === null || amount === null || usage === null || typeof usdc !== "string" || !DIGITS.test(usdc) || price === null) return null;
      if (registration !== null && !isObj(registration)) return null;
      return { blockHash: head.hash, nonce, free: amount - usage * BYTE_COST, usdc: BigInt(usdc), registered: registration !== null, gasPrice: price };
    } catch {
      return null;
    }
  };
  const [x, y] = await Promise.all(rpcs.map(side));
  if (!x || !y || x.blockHash !== y.blockHash || x.nonce !== y.nonce || x.free !== y.free || x.usdc !== y.usdc || x.registered !== y.registered || x.gasPrice !== y.gasPrice) return null;
  return { height: at, ...x };
}

// ---------- the transaction (borsh, as nearcore reads Transaction V0 and SignedTransaction) ----------
class Borsh {
  private parts: Uint8Array[] = [];
  private int(x: bigint, n: number) {
    const b = new Uint8Array(n);
    for (let k = 0; k < n; k++) b[k] = Number((x >> BigInt(8 * k)) & 0xffn);
    this.parts.push(b);
    return this;
  }
  u8 = (x: number) => this.int(BigInt(x), 1);
  u32 = (x: number) => this.int(BigInt(x), 4);
  u64 = (x: bigint) => this.int(x, 8);
  u128 = (x: bigint) => this.int(x, 16);
  fixed = (b: Uint8Array) => (this.parts.push(b), this);
  bytes = (b: Uint8Array) => this.u32(b.length).fixed(b);
  string = (s: string) => this.bytes(new TextEncoder().encode(s));
  done(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((a, p) => a + p.length, 0));
    let at = 0;
    for (const p of this.parts) out.set(p, (at += p.length) - p.length);
    return out;
  }
}
export type MoveCall = { method: "storage_deposit" | "ft_transfer"; args: Obj; gas: bigint; deposit: bigint };

/** The move's actions: the registration first when due, then the ft_transfer (W:929, W:934). */
export function moveCalls(to: string, amount: bigint, register: boolean, storageMin: bigint): MoveCall[] {
  const send: MoveCall = { method: "ft_transfer", args: { receiver_id: to, amount: amount.toString() }, gas: MOVE_GAS.ft_transfer, deposit: 1n };
  return register ? [{ method: "storage_deposit", args: { account_id: to, registration_only: true }, gas: MOVE_GAS.storage_deposit, deposit: storageMin }, send] : [send];
}

/** intents.near: nothing sent to it is the user's (signpage withdraw/checks.ts INTENTS, W:930). */
const INTENTS = "intents.near";
/**
 * The payload rule (WU-05's plain move rows): what is signed is exactly this shape, or it is refused. The typed account
 * is never U, the token, the token's network's vault or intents.near, whoever calls (review of d791adda, L1).
 */
export function checkMoveCalls(u: string, to: string, token: string, calls: readonly MoveCall[], usdc: bigint, storageMin: bigint): void {
  if (!IMPLICIT.test(u) || to === u || to === token) throw new MoveOutRefused("the typed account is U or the token");
  const net = Object.values(NEAR_NETWORKS).find((n) => n.usdc === token);
  if (net === undefined) throw new MoveOutRefused("the token is no release's USDC");
  if (to === net.vault || to === INTENTS) throw new MoveOutRefused("the typed account is the vault or intents.near: nothing sent there is the user's");
  const last = calls.at(-1);
  if (calls.length < 1 || calls.length > 2 || !last || last.method !== "ft_transfer" || last.deposit !== 1n || last.gas !== MOVE_GAS.ft_transfer) throw new MoveOutRefused("one ft_transfer with 1 yocto, last");
  if (Object.keys(last.args).join() !== "receiver_id,amount" || last.args.receiver_id !== to) throw new MoveOutRefused("ft_transfer names the typed account and an amount, no memo");
  const amount = big(last.args.amount);
  if (amount === null || amount < 1n || amount > usdc - 1n) throw new MoveOutRefused("the amount is above U's USDC less one base unit");
  if (calls.length === 2) {
    const r = calls[0]!;
    if (r.method !== "storage_deposit" || r.args.account_id !== to || r.args.registration_only !== true || Object.keys(r.args).length !== 2 || r.deposit !== storageMin || r.gas !== MOVE_GAS.storage_deposit)
      throw new MoveOutRefused("the registration is storage_deposit(the typed account, registration_only) with the token's minimum");
  }
}

/** The transaction's bytes, its hash and the signed bytes, U's key given. */
export function signMoveTx(u: string, publicKey: Uint8Array, secretKey: Uint8Array, nonce: bigint, token: string, blockHash: string, calls: readonly MoveCall[]): { hash: string; signed: string } {
  const tx = new Borsh().string(u).u8(0).fixed(publicKey).u64(nonce).string(token).fixed(base58.decode(blockHash)).u32(calls.length);
  for (const c of calls) tx.u8(2).string(c.method).bytes(new TextEncoder().encode(JSON.stringify(c.args))).u64(c.gas).u128(c.deposit);
  const bytes = tx.done();
  const digest = sha256(bytes);
  const signature = ed25519.sign(digest, secretKey);
  const signed = new Borsh().fixed(bytes).u8(0).fixed(signature).done();
  return { hash: base58.encode(digest), signed: base64.encode(signed) };
}

// ---------- reading the transaction back ----------
/**
 * One RPC's read of the move's tx: ok (FINAL, every receipt a success), failed (FINAL, a failure), absent (the RPC's own
 * UNKNOWN_TRANSACTION, as scripts/ci/money-gate.mjs reads "missing"), or unknown: a timeout, a 429 or 5xx, receipts
 * still running or any other answer is no word on whether the tx exists.
 */
async function txState(r: MoveOutRpc, hash: string, u: string): Promise<"ok" | "failed" | "absent" | "unknown"> {
  try {
    const a = await r.tx({ tx_hash: hash, sender_account_id: u, wait_until: "FINAL" });
    if (isObj(a) && isObj(a.error) && isObj(a.error.cause) && a.error.cause.name === "UNKNOWN_TRANSACTION") return "absent";
    const res = isObj(a) && a.error === undefined ? a.result : undefined;
    if (!isObj(res) || res.final_execution_status !== "FINAL" || !isObj(res.transaction) || res.transaction.hash !== hash || res.transaction.signer_id !== u) return "unknown";
    const outs = res.receipts_outcome;
    if (!Array.isArray(outs) || outs.length === 0) return "unknown";
    const failed = (s: unknown) => isObj(s) && Object.hasOwn(s, "Failure");
    if (failed(res.status) || outs.some((o) => isObj(o) && isObj(o.outcome) && failed(o.outcome.status))) return "failed";
    return isObj(res.status) && Object.hasOwn(res.status, "SuccessValue") ? "ok" : "unknown";
  } catch {
    return "unknown";
  }
}
/** The tx on both RPCs: ok, failed, absent or unknown when both read the same; split when they differ (then nothing is decided). */
async function readBoth(rpcs: readonly [MoveOutRpc, MoveOutRpc], hash: string, u: string): Promise<"ok" | "failed" | "absent" | "unknown" | "split"> {
  const [a, b] = await Promise.all(rpcs.map((r) => txState(r, hash, u)));
  return a === b ? a! : "split";
}
const sendBoth = (rpcs: readonly [MoveOutRpc, MoveOutRpc], signed: string) =>
  Promise.all(rpcs.map((r) => r.call("send_tx", { signed_tx_base64: signed, wait_until: "NONE" }).catch(() => null)));
/** Both RPCs refused the bytes for U's balance (InvalidTxError NotEnoughBalance, equal): the yocto U lacks, else null. */
function shortOf(answers: unknown[]): bigint | null {
  const one = (a: unknown): bigint | null => {
    const e = isObj(a) && isObj(a.error) && isObj(a.error.data) && isObj(a.error.data.TxExecutionError) && isObj(a.error.data.TxExecutionError.InvalidTxError) ? a.error.data.TxExecutionError.InvalidTxError.NotEnoughBalance : undefined;
    const cost = isObj(e) ? big(e.cost) : null, balance = isObj(e) ? big(e.balance) : null;
    return cost !== null && balance !== null && cost > balance ? cost - balance : null;
  };
  const [a, b] = answers.map(one);
  return a != null && a === b ? a : null;
}

export interface MoveOutDeps {
  ops: Pick<WalletStore, "get" | "update" | "keys">;
  rpcs: readonly [MoveOutRpc, MoveOutRpc];
  /** Opens the seed for the signature only: a fresh copy each call, zeroed here once U's key is derived. */
  seed64: () => Promise<Uint8Array>;
  seedLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** U's own lock (the page's FOLLOW_LOCK/<network>/<U>, exclusive), taken only if free: null when another holds it. */
  uLock?: <T>(fn: () => Promise<T>) => Promise<T | null>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

/** The held deposit op this device holds for U, or a refusal: held, on the token (not a struck intents route), ours. */
export async function heldOpOf(ops: Pick<WalletStore, "get">, opId: string): Promise<DepositOp> {
  const op = (await ops.get("ops", opId)) as DepositOp | undefined;
  if (!isObj(op) || op.kind !== "deposit" || !isObj(op.follow)) throw new MoveOutRefused("no deposit op of this device");
  if (op.stage !== "held") throw new MoveOutRefused(`the op is ${String(op.stage)}, not held`);
  if (op.follow.intents_struck === true) throw new MoveOutRefused("the money waits inside intents.near: not the token's way out");
  if (typeof op.follow.u !== "string" || !IMPLICIT.test(op.follow.u) || !Object.hasOwn(NEAR_NETWORKS, op.follow.network)) throw new MoveOutRefused("the op names no one-time id");
  return op;
}

/** How far below the read height U's key nonce must already be at or past a record's nonce for the record to be taken. */
export const SETTLE_BLOCKS = 100;

/** A record that is gone (can never land): why, with U's USDC when it was read. */
type Gone = { gone: "failed" | "expired" | "taken"; usdc: bigint | null };
/** Whether record `had` of U can still land (live: follow it), or is gone, read on both RPCs. */
async function recordState(U: string, token: string, had: MoveOutRecord, rpcs: readonly [MoveOutRpc, MoveOutRpc]): Promise<"live" | Gone> {
  const st = await readBoth(rpcs, had.hash, U);
  if (st === "failed") return { gone: "failed", usdc: null };
  if (st !== "absent" && st !== "unknown") return "live";
  const r = await readMoveOut(U, had.to, token, rpcs).catch(() => null);
  if (r === null) return "live";
  if (r.nonce < BigInt(had.nonce) && BigInt(r.height) > BigInt(had.height) + TX_VALIDITY_BLOCKS) return { gone: "expired", usdc: r.usdc };
  // taken: only when both RPCs say the tx does not exist; a read that times out may be U's own move still running
  if (st === "absent" && r.nonce >= BigInt(had.nonce) && r.height > SETTLE_BLOCKS) {
    const past = await keyNonceAt(U, r.height - SETTLE_BLOCKS, rpcs).catch(() => null);
    if (past !== null && past >= BigInt(had.nonce)) return { gone: "taken", usdc: r.usdc };
  }
  return "live";
}

/**
 * Moves what held op `opId`'s U holds on the token, less one base unit, to `to` (checked by the page's checkRecipient),
 * or resumes the move the op already holds (then `to` is not used: the recorded one is). With `to` null it only
 * resumes: it sends recorded bytes again and reads them, and never signs. Answers how far it got.
 */
export async function moveOutHeld(opId: string, to: string | null, deps: MoveOutDeps): Promise<MoveOutOutcome> {
  const { ops, rpcs } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const seedLock = deps.seedLock ?? (<T>(fn: () => Promise<T>) => fn());
  const uLock = deps.uLock ?? (<T>(fn: () => Promise<T>) => fn());
  let op = await heldOpOf(ops, opId);
  const network = op.follow.network as NearNetwork;
  if (nearPairNetwork(rpcs) !== network) throw new MoveOutRefused("the RPCs are not the op's network's release pair");
  const U = op.follow.u;
  const token = NEAR_NETWORKS[network].usdc;
  const shownOf = (r: MoveOutRecord) => ({ to: r.to, amount: BigInt(r.amount), hash: r.hash });

  // record r of op `owner`: its same bytes again, read until FINAL on both
  const follow = async (r: MoveOutRecord, owner: string): Promise<MoveOutOutcome> => {
    const shown = shownOf(r);
    for (let k = 0; k < FINAL_TRIES; k++) {
      const st = await readBoth(rpcs, r.hash, U);
      if (st === "ok") {
        await ops.update("ops", owner, (v) => {
          const o = v as DepositOp | undefined;
          return isObj(o) && o.follow.out?.hash === r.hash && o.follow.why !== "moved_out" ? { ...o, follow: { ...o.follow, why: "moved_out" } } : undefined;
        });
        return { kind: "moved", ...shown };
      }
      if (st === "failed") return { kind: "failed", ...shown };
      if (k === 0) {
        // the same bytes; refused by both for U's NEAR: kept, sent again once U holds the cost (never signed anew)
        const lack = shortOf(await sendBoth(rpcs, r.signed));
        if (lack !== null) return { kind: "gas", need: lack, u: U };
      }
      await sleep(deps.pollMs ?? 1_000);
    }
    return { kind: "sent", ...shown };
  };
  // a gone record of op `id` leaves follow.out for follow.out_past (a compare-and-set on its hash)
  const clear = (id: string, r: MoveOutRecord) =>
    ops.update("ops", id, (v) => {
      const o = v as DepositOp | undefined;
      if (!isObj(o) || o.follow.out?.hash !== r.hash) return undefined;
      const { out: _gone, ...rest } = o.follow;
      return { ...o, follow: { ...rest, out_past: [...(o.follow.out_past ?? []), r] } };
    });

  // a move already written: its bytes again, never a new signature while they can land
  const had = op.follow.out;
  if (had !== undefined) {
    if (op.follow.why === "moved_out") return { kind: "moved", ...shownOf(had) };
    const st = await recordState(U, token, had, rpcs);
    if (st === "live") return follow(had, opId);
    // gone: a new signature only on the user's tap
    if (to === null) return st.gone === "taken" && st.usdc !== null && st.usdc <= 1n ? { kind: "empty" } : { kind: "failed", ...shownOf(had) };
    await clear(opId, had);
  }
  if (to === null) throw new MoveOutRefused("no typed account");
  const typed = to;

  type Signed = { follow: MoveOutRecord; owner: string } | { outcome: MoveOutOutcome };
  const signed = await uLock(async (): Promise<Signed> => {
    op = await heldOpOf(ops, opId);
    if (op.follow.out !== undefined) return { follow: op.follow.out, owner: opId }; // another tab wrote one meanwhile
    // another op of U with a live record: that move is U's one move; gone ones are cleared
    for (const k of await ops.keys("ops")) {
      if (k === opId) continue;
      const o = (await ops.get("ops", k).catch(() => undefined)) as DepositOp | undefined;
      const r = isObj(o) && o.kind === "deposit" && isObj(o.follow) && o.follow.u === U && o.follow.network === network && o.follow.why !== "moved_out" ? o.follow.out : undefined;
      if (r === undefined) continue;
      if ((await recordState(U, token, r, rpcs)) === "live") return { follow: r, owner: k };
      await clear(k, r);
    }
    const read = await readMoveOut(U, typed, token, rpcs);
    if (read === null) return { outcome: { kind: "unread" } };
    if (read.usdc <= 1n) return { outcome: { kind: "empty" } };
    const storageMin = read.registered ? 0n : await readTokenStorageMin(network, rpcs);
    const calls = moveCalls(typed, read.usdc - 1n, !read.registered, storageMin);
    checkMoveCalls(U, typed, token, calls, read.usdc, storageMin);
    const gas = calls.reduce((a, c) => a + c.gas, MOVE_GAS.send);
    const need = gas * read.gasPrice * GAS_PRICE_MARGIN + calls.reduce((a, c) => a + c.deposit, 0n);
    if (read.free < need) return { outcome: { kind: "gas", need: need - read.free, u: U } };
    const nonce = read.nonce + 1n;

    const tx = await seedLock(async () => {
      const seed = await deps.seed64();
      try {
        if (!(seed instanceof Uint8Array) || seed.length !== 64) throw new MoveOutRefused("seed64 must be 64 bytes");
        const k = depositId(seed, BigInt(op.follow.s), op.follow.i);
        try {
          if (k.id !== U) throw new MoveOutRefused("the seed's U_{s,i} is not the op's U");
          return signMoveTx(U, k.publicKey, k.secretKey, nonce, token, read.blockHash, calls);
        } finally {
          k.secretKey.fill(0);
        }
      } finally {
        seed.fill(0);
      }
    });
    const record: MoveOutRecord = { to: typed, amount: (read.usdc - 1n).toString(), nonce: nonce.toString(), height: read.height, register: !read.registered, hash: tx.hash, signed: tx.signed };
    // written before it is sent; of two writers only the first sends, the other follows it
    await ops.update("ops", opId, (v) => {
      const o = v as DepositOp | undefined;
      return isObj(o) && o.stage === "held" && o.follow.out === undefined ? { ...o, follow: { ...o.follow, out: record } } : undefined;
    });
    const now = await heldOpOf(ops, opId);
    if (now.follow.out === undefined) throw new MoveOutRefused("the move could not be written");
    return { follow: now.follow.out, owner: opId };
  });
  if (signed === null) return { kind: "unread" }; // U's lock is held: another op of U is being followed
  return "outcome" in signed ? signed.outcome : follow(signed.follow, signed.owner);
}
