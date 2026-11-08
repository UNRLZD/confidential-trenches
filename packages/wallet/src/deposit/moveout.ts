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
//   list (exactly its own key) and nonce, U's NEAR and storage, U's USDC, storage_balance_of(the typed account) and the
//   gas price. amount = U's USDC less one base unit (restore still finds U by ft_balance_of, W:929). The registration
//   rides in the same transaction when the typed account reads null on both (both actions in one receipt, which rolls
//   back whole), its deposit the token's storage minimum (arming/accounts.ts readTokenStorageMin, the same read).
// - U's NEAR pays the gas (W:934: what it holds, or a plain Transfer from the typed account, never another account of the
//   seed). U is created with its storage only (apps/helper/src/bind/create.ts CREATE_YOCTO), so the first answer is
//   usually `gas`: how much NEAR U needs, sent from the typed account.
// - Never twice: the signed bytes are written into the op (follow.out) by a compare-and-set before they are sent; an op
//   that holds one signs nothing new. A reload sends the same bytes again and reads them. A new transaction only once the
//   recorded one reads FINAL and failed on both RPCs (nothing moved), or can never land: U's key nonce below it at heights
//   past its block + TX_VALIDITY_BLOCKS on both, and then at the same nonce, so at most one of the two can land.
// - The end: the transaction FINAL on both RPCs with every receipt a success, then the op is held with why "moved_out".
// - U's key: depositId(seed, s, i), the derivation the refund move opens (follow.ts openKey), under deps.seedLock, checked
//   to be U and zeroed at once. Nothing here logs. Each read names U, the token or the typed account; the send carries
//   the signed bytes alone.
import { HELPER_RPC_METHODS, VAULT_CONSTANTS } from "@blindfill/kit";
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
  /** FINAL and failed on both RPCs: nothing moved; the next call signs again. */
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
 * list is not exactly U's own key, or USDC's view fails (a halt is never a zero).
 */
export async function readMoveOut(u: string, to: string, token: string, rpcs: readonly [MoveOutRpc, MoveOutRpc]): Promise<MoveOutRead | null> {
  const own = `ed25519:${base58.encode(Uint8Array.from(u.match(/../g)!, (h) => parseInt(h, 16)))}`;
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
      const [b, keys, acct, bal, reg, gp] = await Promise.all([
        r.block({ block_id: at }),
        r.query({ request_type: "view_access_key_list", account_id: u, block_id: at }),
        r.query({ request_type: "view_account", account_id: u, block_id: at }),
        r.query({ request_type: "call_function", account_id: token, method_name: "ft_balance_of", args_base64: viewArgs({ account_id: u }), block_id: at }),
        r.query({ request_type: "call_function", account_id: token, method_name: "storage_balance_of", args_base64: viewArgs({ account_id: to }), block_id: at }),
        r.call("gas_price", [at]),
      ]);
      const head = isObj(b) && isObj(b.result) && isObj(b.result.header) ? b.result.header : undefined;
      if (!head || head.height !== at || typeof head.hash !== "string") return null;
      const k = resultAt(keys, at);
      const list = k?.keys;
      if (!Array.isArray(list) || list.length !== 1 || !isObj(list[0]) || list[0].public_key !== own || !isObj(list[0].access_key)) return null;
      const nonce = big(list[0].access_key.nonce);
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

/** The payload rule (WU-05's plain move rows): what is signed is exactly this shape, or it is refused. */
export function checkMoveCalls(u: string, to: string, token: string, calls: readonly MoveCall[], usdc: bigint, storageMin: bigint): void {
  if (!IMPLICIT.test(u) || to === u || to === token) throw new MoveOutRefused("the typed account is U or the token");
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
/** One RPC's read of the move's tx: ok (FINAL, every receipt a success), failed (FINAL, a failure), or unknown. */
async function txState(r: MoveOutRpc, hash: string, u: string): Promise<"ok" | "failed" | "unknown"> {
  try {
    const a = await r.tx({ tx_hash: hash, sender_account_id: u, wait_until: "FINAL" });
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
async function readBoth(rpcs: readonly [MoveOutRpc, MoveOutRpc], hash: string, u: string): Promise<"ok" | "failed" | "unknown"> {
  const [a, b] = await Promise.all(rpcs.map((r) => txState(r, hash, u)));
  return a === b ? a! : "unknown";
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
  ops: Pick<WalletStore, "get" | "update">;
  rpcs: readonly [MoveOutRpc, MoveOutRpc];
  /** Opens the seed for the signature only: a fresh copy each call, zeroed here once U's key is derived. */
  seed64: () => Promise<Uint8Array>;
  seedLock?: <T>(fn: () => Promise<T>) => Promise<T>;
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

/**
 * Moves what held op `opId`'s U holds on the token, less one base unit, to `to` (checked by the page's checkRecipient),
 * or resumes the move the op already holds (then `to` is not used: the recorded one is). Answers how far it got.
 */
export async function moveOutHeld(opId: string, to: string | null, deps: MoveOutDeps): Promise<MoveOutOutcome> {
  const { ops, rpcs } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const seedLock = deps.seedLock ?? (<T>(fn: () => Promise<T>) => fn());
  let op = await heldOpOf(ops, opId);
  const network = op.follow.network as NearNetwork;
  if (nearPairNetwork(rpcs) !== network) throw new MoveOutRefused("the RPCs are not the op's network's release pair");
  const U = op.follow.u;
  const token = NEAR_NETWORKS[network].usdc;

  const follow = async (r: MoveOutRecord, resend: boolean): Promise<MoveOutOutcome> => {
    const shown = { to: r.to, amount: BigInt(r.amount), hash: r.hash };
    for (let k = 0; k < FINAL_TRIES; k++) {
      const st = await readBoth(rpcs, r.hash, U);
      if (st === "ok") {
        await ops.update("ops", opId, (v) => {
          const o = v as DepositOp | undefined;
          return isObj(o) && o.follow.out?.hash === r.hash && o.follow.why !== "moved_out" ? { ...o, follow: { ...o.follow, why: "moved_out" } } : undefined;
        });
        return { kind: "moved", ...shown };
      }
      if (st === "failed") return { kind: "failed", ...shown };
      if (resend && k === 0) {
        // the same bytes; refused by both for U's NEAR: kept, sent again once U holds the cost (never signed anew)
        const lack = shortOf(await sendBoth(rpcs, r.signed));
        if (lack !== null) return { kind: "gas", need: lack, u: U };
      }
      await sleep(deps.pollMs ?? 1_000);
    }
    return { kind: "sent", ...shown };
  };

  // a move already written: its bytes again, never a new signature while they can land
  const had = op.follow.out;
  if (had !== undefined) {
    if (op.follow.why === "moved_out") return { kind: "moved", to: had.to, amount: BigInt(had.amount), hash: had.hash };
    const st = await readBoth(rpcs, had.hash, U);
    if (st !== "failed") {
      const r = await readMoveOut(U, had.to, token, rpcs).catch(() => null);
      const dead = st === "unknown" && r !== null && r.nonce < BigInt(had.nonce) && BigInt(r.height) > BigInt(had.height) + TX_VALIDITY_BLOCKS;
      if (!dead) return follow(had, true);
    }
    // FINAL and failed on both (nothing moved), or never landable: cleared, and signed again below
    await ops.update("ops", opId, (v) => {
      const o = v as DepositOp | undefined;
      if (!isObj(o) || o.follow.out?.hash !== had.hash) return undefined;
      const { out: _gone, ...rest } = o.follow;
      return { ...o, follow: rest };
    });
    op = await heldOpOf(ops, opId);
    if (op.follow.out !== undefined) return follow(op.follow.out, true);
    to ??= had.to;
  }
  if (to === null) throw new MoveOutRefused("no typed account");

  const read = await readMoveOut(U, to, token, rpcs);
  if (read === null) return { kind: "unread" };
  if (read.usdc <= 1n) return { kind: "empty" };
  const storageMin = read.registered ? 0n : await readTokenStorageMin(network, rpcs);
  const calls = moveCalls(to, read.usdc - 1n, !read.registered, storageMin);
  checkMoveCalls(U, to, token, calls, read.usdc, storageMin);
  const gas = calls.reduce((a, c) => a + c.gas, MOVE_GAS.send);
  const need = gas * read.gasPrice * GAS_PRICE_MARGIN + calls.reduce((a, c) => a + c.deposit, 0n);
  if (read.free < need) return { kind: "gas", need: need - read.free, u: U };
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
  const record: MoveOutRecord = { to, amount: (read.usdc - 1n).toString(), nonce: nonce.toString(), height: read.height, register: !read.registered, hash: tx.hash, signed: tx.signed };
  // written before it is sent; of two writers only the first sends, the other follows it
  await ops.update("ops", opId, (v) => {
    const o = v as DepositOp | undefined;
    return isObj(o) && o.stage === "held" && o.follow.out === undefined ? { ...o, follow: { ...o.follow, out: record } } : undefined;
  });
  const now = await heldOpOf(ops, opId);
  if (now.follow.out === undefined) throw new MoveOutRefused("the move could not be written");
  return follow(now.follow.out, true);
}
