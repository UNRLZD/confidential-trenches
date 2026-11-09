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
//   only when it reads FINAL and failed on both RPCs (nothing moved); or, unless both read it FINAL success, either
//   expired (no side reads the tx and U's key nonce is below it at a height past its block + TX_VALIDITY_BLOCKS) or
//   settled (U's key nonce at or past it SETTLE_BLOCKS below the read height too: nearcore refuses a nonce at or below
//   the key's, so those bytes never land again, and a tx included that far back has run every receipt). Money in U is
//   always movable (card held-move-forgotten-tx): a settled record with U holding more than 1 base unit on the pair's
//   equal read is replaced, whatever any host says of the tx (a tap moves it); with U empty it is read once more on
//   every one of the network's archival RPCs, since the pair forgets old txs, and settled only when all answer the same:
//   FINAL success a move that landed (the op ends moved_out), FINAL failure a failed one, UNKNOWN_TRANSACTION from a
//   host that serves the record's own block a replaced one (another tx of U used the nonce), never drawn as "not
//   moved"; any other mix, or no answer, leaves it as it is. A landed move reads Moved only while U holds at most 1 base
//   unit, in every path (follow() and a moved op's resume too). A gone record goes to follow.out_past,
//   and a new transaction is signed only on the user's tap (a typed account), never on a resume (null): review of
//   d791adda, M1 and L6.
// - One move of U at a time: the read, the signature and the compare-and-set run under deps.uLock (the page's
//   FOLLOW_LOCK/<network>/<U>, taken only if free, so no deposit follow of U binds U's USDC meanwhile), and while another
//   op of U holds a live record, that record is followed and nothing is signed.
// - The end: the transaction FINAL on both RPCs with every receipt a success, then the op is held with why "moved_out".
// - U's key: depositId(seed, s, i), the derivation the refund move opens (follow.ts openKey), under deps.seedLock, checked
//   to be U and zeroed at once. Nothing here logs. Each read names U, the token or the typed account; the send carries
//   the signed bytes alone.
import { HELPER_RPC_METHODS, VAULT_CONSTANTS, VAULT_FIELD_P, VAULT_SETTLE_GAS, VAULT_SETTLE_REFUND_ATTACH, VAULT_TOKEN_CODE_HASH } from "@blindfill/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { readTokenStorageMin } from "../arming/accounts.ts";
import { depositId } from "../derive/keys.ts";
import { pacedFetch, pacedRpc, requestSignal } from "../pace.ts";
import type { WalletStore } from "../store/index.ts";
import { heightSpreadOver, NEAR_NETWORKS, nearPairNetwork, type NearNetwork, RPC_TIMEOUT_MS } from "./account.ts";
import { DEPOSIT_STATUS_TIMEOUT_MS, type FollowRpc, followRpc, type DepositOp, readDepositStatus, statusFacts } from "./follow.ts";

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
  /** Signed for an op already moved_out (a later deposit in U reopened it): the op's own money went with an earlier
   *  record, so this one carries later money only, and the op needs nothing of it to read Moved again (landed). */
  later?: true;
}

export type MoveOutOutcome =
  /** FINAL on both RPCs, every receipt a success: the op is held with why "moved_out". */
  | { kind: "moved"; to: string; amount: bigint; hash: string }
  /** Sent (or sent again), not yet read FINAL on both: a later call reads it again and signs nothing. */
  | { kind: "sent"; to: string; amount: bigint; hash: string }
  /** The record can never land (FINAL and failed, or expired): the next tap signs anew. */
  | { kind: "failed"; to: string; amount: bigint; hash: string }
  /**
   * The record never ran and never will (another tx of U used its nonce: both of the pair and every archival RPC answer
   * UNKNOWN_TRANSACTION for it), or it landed and U holds more than 1 base unit again (a later deposit), or no equal word
   * on it came while U holds more: the record is history now and nothing is moving; the account is typed again for the
   * next tap. Never "not moved" for it: the tx that took the nonce may be U's own.
   */
  | { kind: "open" }
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
/** What an id's move out leaves of each asset it holds: one base unit, so restore still finds the id by its balance
 *  (W:929; vault paper 2.12 step 5, l.988-990). The restore's pool scopes read an id holding no more as moved out. */
export const ID_KEEP = 1n;
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
export function moveOutRpc(url: string, fetchFn: typeof fetch = pacedFetch(url), timeoutMs = RPC_TIMEOUT_MS): MoveOutRpc {
  return pacedRpc({
    ...followRpc(url, fetchFn, timeoutMs),
    async call(method, params) {
      const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "blindfill", method, params }), signal: requestSignal(fetchFn, timeoutMs) });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
  }, fetchFn);
}

/** How many times an archival host is asked one read in all, and the longest wait between two asks (ms). */
export const ARCHIVAL_ASKS = 4;
export const ARCHIVAL_WAIT_MAX_MS = 10_000;
/** Retry-After in ms: delta-seconds or an HTTP date (RFC 9110 10.2.3); null when absent or unreadable. */
function retryAfterMs(h: string | null, now: number): number | null {
  if (h === null || h.trim() === "") return null;
  const s = Number(h);
  if (Number.isFinite(s)) return s >= 0 ? s * 1000 : null;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}
/**
 * An archival host (NEAR_NETWORKS[network].archival) by URL: moveOutRpc's, but a read it throttles or cannot serve
 * (HTTP 429 or 5xx, a JSON-RPC error code -429 as fastnear answers a rate limit, or no connection) is asked again
 * after the host's Retry-After, else 1 s doubled per ask, ARCHIVAL_WAIT_MAX_MS at most (the wait pool/evm.ts's
 * throttleWaitMs takes), ARCHIVAL_ASKS asks in all (as the card's live check asks near.org's, which rate-limits a few
 * quick reads with HTTP 429, read 8 Nov 2026), then its failure. A read that times out is not asked again. Delta review
 * 3 of held-move-forgotten-tx (F4): one throttled ask no longer leaves a landed forgotten move unread.
 */
export function archivalRpc(url: string, fetchFn: typeof fetch = pacedFetch(url), timeoutMs = RPC_TIMEOUT_MS, sleep: (ms: number) => Promise<void> = (ms) => new Promise((ok) => setTimeout(ok, ms))): MoveOutRpc {
  const post = async (method: string, params: unknown): Promise<unknown> => {
    for (let ask = 1; ; ask++) {
      let after: number | null = null;
      let why: string;
      try {
        const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "blindfill", method, params }), signal: requestSignal(fetchFn, timeoutMs) });
        if (res.status === 200) {
          const body: unknown = await res.json();
          if (!(isObj(body) && isObj(body.error) && body.error.code === -429)) return body;
          why = "JSON-RPC -429";
        } else if (res.status === 429 || res.status >= 500) why = `HTTP ${res.status}`;
        else throw new Error(`HTTP ${res.status}`);
        after = retryAfterMs(res.headers.get("retry-after"), Date.now());
      } catch (e) {
        if ((e as Error).name === "TimeoutError" || (e as Error).message.startsWith("HTTP ")) throw e;
        why = String(e);
      }
      if (ask >= ARCHIVAL_ASKS) throw new Error(`${url}: ${why} after ${ARCHIVAL_ASKS} asks`);
      await sleep(Math.min(ARCHIVAL_WAIT_MAX_MS, Math.max(after ?? 0, 1_000 * 2 ** (ask - 1))));
    }
  };
  return pacedRpc({ ...moveOutRpc(url, fetchFn, timeoutMs), tx: (params) => post("tx", params), block: (params) => post("block", params) }, fetchFn);
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const DIGITS = /^(0|[1-9][0-9]*)$/;
const IMPLICIT = /^[0-9a-f]{64}$/;
const big = (x: unknown): bigint | null => (typeof x === "string" && DIGITS.test(x) ? BigInt(x) : typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : null);
/** A base58 hash of exactly 32 bytes, else null. */
const hash32 = (x: unknown): Uint8Array | null => {
  if (typeof x !== "string") return null;
  try {
    const b = base58.decode(x);
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
};
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
  // a u64, as nearcore keeps it: a string answer is not capped by isSafeInteger, and Borsh keeps only 8 bytes of a
  // larger one. 2^64 - 1 itself is read (a move that landed at it is read back as landed); the tap refuses to sign past
  // it (U64_MAX at the signing below), since the nonce signed next would not fit
  const n = big(list[0].access_key.nonce);
  return n !== null && n <= U64_MAX ? n : null;
}
const U64_MAX = 2n ** 64n - 1n;
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
      if (!head || head.height !== at || typeof head.hash !== "string" || hash32(head.hash) === null) return null;
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
    // an integer that does not fit n bytes is refused, never cut to its low bytes (as delegate.ts's uint)
    if (x < 0n || x >> BigInt(8 * n) !== 0n) throw new MoveOutRefused(`an integer does not fit ${n} bytes`);
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
export function checkMoveCalls(u: string, to: string, token: string, given: readonly MoveCall[], usdc: bigint, storageMin: bigint): SealedMove {
  // the rule reads a deep copy, and the copy it passed is what can be signed (sealed below): a change to `given` later,
  // or to anything it holds, reaches nothing signed. Every name is a string: === compares a String's or a toJSON
  // object's identity while JSON.stringify signs the name it stands for (a vault passing as another account)
  const strings = "U, the typed account, the token and every account id are strings";
  if (typeof u !== "string" || typeof to !== "string" || typeof token !== "string") throw new MoveOutRefused(strings);
  let calls: MoveCall[];
  try {
    calls = structuredClone([...given]);
  } catch {
    throw new MoveOutRefused("the calls are not plain data");
  }
  // each call is exactly method, args, gas and deposit: a field of any other name is refused, never frozen or signed
  if (!calls.every((c) => isObj(c) && Object.keys(c).sort().join() === "args,deposit,gas,method" && isObj(c.args))) throw new MoveOutRefused("each call is method, args, gas and deposit, nothing else");
  // the copy's account ids, read once (a getter on `given` ran in the clone and is gone)
  if (!calls.every((c) => isObj(c) && isObj(c.args) && (c.args.receiver_id === undefined || typeof c.args.receiver_id === "string") && (c.args.account_id === undefined || typeof c.args.account_id === "string"))) throw new MoveOutRefused(strings);
  if (!IMPLICIT.test(u) || to === u || to === token) throw new MoveOutRefused("the typed account is U or the token");
  const net = Object.values(NEAR_NETWORKS).find((n) => n.usdc === token);
  if (net === undefined) throw new MoveOutRefused("the token is no release's USDC");
  if (to === net.vault || to === INTENTS) throw new MoveOutRefused("the typed account is the vault or intents.near: nothing sent there is the user's");
  const last = calls.at(-1);
  if (calls.length < 1 || calls.length > 2 || !last || last.method !== "ft_transfer" || last.deposit !== 1n || last.gas !== MOVE_GAS.ft_transfer) throw new MoveOutRefused("one ft_transfer with 1 yocto, last");
  if (Object.keys(last.args).join() !== "receiver_id,amount" || last.args.receiver_id !== to) throw new MoveOutRefused("ft_transfer names the typed account and an amount, no memo");
  const amount = typeof last.args.amount === "string" ? big(last.args.amount) : null; // a string, as NEP-141 reads it: never a JSON number
  if (amount === null || amount < 1n || amount > usdc - ID_KEEP) throw new MoveOutRefused("the amount is above U's USDC less one base unit");
  if (calls.length === 2) {
    const r = calls[0]!;
    if (r.method !== "storage_deposit" || r.args.account_id !== to || r.args.registration_only !== true || Object.keys(r.args).length !== 2 || r.deposit !== storageMin || r.gas !== MOVE_GAS.storage_deposit)
      throw new MoveOutRefused("the registration is storage_deposit(the typed account, registration_only) with the token's minimum");
  }
  return seal({ signer: u, receiver: token, calls });
}

/**
 * The typed account's rule for the moves the signing page's held path does not make (the registration alone and the
 * ft_withdraw out of intents.near): checkMoveCalls' own first lines, unchanged there so the signing page's bundle
 * stays as built; test/deposit-moveout.test.ts holds the two to refuse the same accounts. Never the moving account,
 * the token, the token's network's vault or intents.near (vault paper 2.12, "Nothing into the vault").
 */
function checkTypedAccount(u: string, to: string, token: string): void {
  namesOk(to, token);
  if (!IMPLICIT.test(u) || to === u || to === token) throw new MoveOutRefused("the typed account is U or the token");
  const net = Object.values(NEAR_NETWORKS).find((n) => n.usdc === token);
  if (net === undefined) throw new MoveOutRefused("the token is no release's USDC");
  if (to === net.vault || to === INTENTS) throw new MoveOutRefused("the typed account is the vault or intents.near: nothing sent there is the user's");
}
/** checkMoveCalls' copy rule for the other two checks: a deep copy of plain data, each call exactly method, args, gas and
 *  deposit, its account ids strings; the copy is what is checked and sealed, so a later change to `given` signs nothing. */
function plainCalls<C extends MoveCall | WithdrawCall>(given: readonly C[]): C[] {
  let calls: C[];
  try {
    calls = structuredClone([...given]);
  } catch {
    throw new MoveOutRefused("the calls are not plain data");
  }
  if (!calls.every((c) => isObj(c) && Object.keys(c).sort().join() === "args,deposit,gas,method" && isObj(c.args))) throw new MoveOutRefused("each call is method, args, gas and deposit, nothing else");
  for (const c of calls) for (const f of ["receiver_id", "account_id", "token"]) if (c.args[f] !== undefined && typeof c.args[f] !== "string") throw new MoveOutRefused("every account id is a string");
  return calls;
}

/** A move a check passed (card signers-own-bytes): U, the receiver and the calls, deep-frozen, the only thing signMoveTx
 *  signs. Only a check of this module makes one (seal, module private); a copy, a look-alike or a changed one is not. */
export type SealedMove = { readonly signer: string; readonly receiver: string; readonly calls: readonly (MoveCall | WithdrawCall | SettleCall)[] };
const SEALED = new WeakSet<object>();
const frozen = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) frozen(x);
    Object.freeze(v);
  }
  return v;
};
function seal(move: SealedMove): SealedMove {
  const v = frozen({ signer: move.signer, receiver: move.receiver, calls: move.calls });
  SEALED.add(v);
  return v;
}

/** The transaction's bytes, its hash and the signed bytes, U's key given. Module private (card signers-own-bytes): it signs
 *  only a move a check of this module sealed, as that move holds it (U, the receiver, the calls), with U's own key. */
function signMoveTx(publicKey: Uint8Array, secretKey: Uint8Array, nonce: bigint, blockHash: string, move: SealedMove): { hash: string; signed: string } {
  if (!SEALED.has(move)) throw new MoveOutRefused("the move is not one a check of this module passed");
  const { signer: u, receiver: token, calls } = move;
  // the block hash is exactly 32 bytes: one of another length moves every field after it in the bytes nearcore reads
  const blockHash32 = hash32(blockHash);
  if (blockHash32 === null) throw new MoveOutRefused("the block hash is not 32 bytes of base58");
  if (Array.from(publicKey, (b) => b.toString(16).padStart(2, "0")).join("") !== u) throw new MoveOutRefused("the key is not the move's U");
  const tx = new Borsh().string(u).u8(0).fixed(publicKey).u64(nonce).string(token).fixed(blockHash32).u32(calls.length);
  for (const c of calls) tx.u8(2).string(c.method).bytes(new TextEncoder().encode(JSON.stringify(c.args))).u64(c.gas).u128(c.deposit);
  const bytes = tx.done();
  const digest = sha256(bytes);
  const signature = ed25519.sign(digest, secretKey);
  const signed = new Borsh().fixed(bytes).u8(0).fixed(signature).done();
  return { hash: base58.encode(digest), signed: base64.encode(signed) };
}

// ---------- the exit tool's moves (card exit-ids-out; vault paper 2.12 step 5 and "Nothing into the vault") ----------
// Each builder reads its arguments once, at entry, into locals (plain copies: the key's bytes into fresh arrays, zeroed
// when it returns), checks those, and signs only those, so what is signed is what was checked (M366 (2)/(3); a getter
// or a proxy that answers one value to the check and another to the signer has nothing left to change).
/** A moving account's own key: the one-time id U, R or V, or the arming account A, as the wallet derives it. */
export interface OwnKey {
  /** the 64-hex implicit account: the public key's hex */
  id: string;
  publicKey: Uint8Array;
  /** the 32-byte ed25519 seed */
  secretKey: Uint8Array;
}
/** What the move signs: its calls, the signed bytes and their hash, the nonce, and the amount the typed account gets. */
export interface BuiltMove {
  receiver: string;
  calls: readonly (MoveCall | WithdrawCall | SettleCall)[];
  amount: bigint;
  nonce: bigint;
  hash: string;
  signed: string;
}
/** A read for a move, naming the moving account, the typed account and the token it was read for. */
export type MoveOutReadFor = MoveOutRead & { u: string; to: string; token: string };
/** A move out of intents.near's read, naming the same three. */
export type WithdrawOutReadFor = WithdrawOutRead & { u: string; to: string; token: string };
/** The registration's read: the account's nonce, the block and the typed account's registration, with the three names. */
export type RegisterOutReadFor = Pick<MoveOutReadFor, "nonce" | "blockHash" | "registered" | "u" | "to" | "token">;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** The key, copied once: the id is its public key's hex, and the secret key makes that public key. */
function ownKeyCopy(k: OwnKey): OwnKey {
  const id = k.id, pk = k.publicKey, sk = k.secretKey;
  if (!(sk instanceof Uint8Array) || !(pk instanceof Uint8Array)) throw new MoveOutRefused("the key is not a pair of 32-byte arrays");
  const key = { id, publicKey: new Uint8Array(pk), secretKey: new Uint8Array(sk) };
  if (key.secretKey.length !== 32 || key.publicKey.length !== 32 || typeof id !== "string" || !IMPLICIT.test(id) || hex(key.publicKey) !== id || hex(ed25519.getPublicKey(key.secretKey)) !== id) {
    key.secretKey.fill(0);
    throw new MoveOutRefused("the key is not the moving account's own");
  }
  return key;
}
/** The encoder's widths: a nonce is a u64 and a deposit a u128 (it would wrap a larger one silently, review 3 L1). */
const U128_LIMIT = 1n << 128n;
/**
 * The typed account and the token are strings: an object (a String, or one whose toJSON names the vault) would pass
 * the === refusals by identity while JSON.stringify signs another name (review 2, M1).
 */
function namesOk(to: unknown, token: unknown): void {
  if (typeof to !== "string" || typeof token !== "string") throw new MoveOutRefused("the typed account and the token must be strings");
}
/**
 * The read, copied once, for this account, typed account and token, or a refusal; its nonce a bigint at or above 0,
 * below 2^64 - 1 (so nonce + 1 is a u64), its block hash 32 bytes in base58 and its registration true or false.
 */
function readFor<R extends { u: string; to: string; token: string; nonce: bigint; blockHash: string; registered: boolean }>(read: R, u: string, to: string, token: string): R {
  const r = { ...read };
  if (r.u !== u || r.to !== to || r.token !== token) throw new MoveOutRefused("the read is not of this account, typed account and token");
  let hash: Uint8Array | null = null;
  try {
    hash = typeof r.blockHash === "string" ? base58.decode(r.blockHash) : null;
  } catch {
    hash = null;
  }
  // nonce + 1 is signed as a u64: the encoder would wrap a larger one silently (review 3, L1)
  if (typeof r.nonce !== "bigint" || r.nonce < 0n || r.nonce >= U64_MAX || hash === null || hash.length !== 32 || (r.registered !== true && r.registered !== false)) throw new MoveOutRefused("the read's nonce, block hash or registration is not one");
  return r;
}
/** How much of what the account holds stays: an id keeps one base unit (restore finds it by its balance, W:929); A moves all, so its DeleteAccount can follow. */
function keepOf(kind: unknown): 0n | 1n {
  if (kind === "arm") return 0n;
  if (kind === "id") return 1n;
  throw new MoveOutRefused(`no account kind ${JSON.stringify(kind)}`);
}

/** readMoveOut, naming the account, the typed account and the token it read. */
export async function readMoveOutFor(u: string, to: string, token: string, rpcs: readonly [MoveOutRpc, MoveOutRpc]): Promise<MoveOutReadFor | null> {
  const r = await readMoveOut(u, to, token, rpcs);
  return r === null ? null : { ...r, u, to, token };
}

/**
 * The move of what `key`'s account holds on the token to `to`: [storage_deposit(to)] then ft_transfer(to, amount) on
 * the token, the amount what the read holds less the keep, checked by checkMoveCalls before the private signer runs.
 * `read` is readMoveOutFor's for this account, `to` and the token; `kind` "id" (U, R, V: one base unit kept) or "arm"
 * (A: all). An unregistered typed account needs the token's storage minimum (readTokenStorageMin), never 0.
 */
export function buildMoveOut(a: { read: MoveOutReadFor; key: OwnKey; kind: "id" | "arm"; to: string; token: string; storageMin: bigint }): BuiltMove {
  const { to, token, kind, storageMin: min } = a;
  namesOk(to, token);
  const keep = keepOf(kind);
  const key = ownKeyCopy(a.key);
  try {
    const read = readFor(a.read, key.id, to, token);
    if (typeof read.usdc !== "bigint" || read.usdc <= keep) throw new MoveOutRefused("nothing to move on the token");
    if (!read.registered && (typeof min !== "bigint" || min <= 0n || min >= U128_LIMIT)) throw new MoveOutRefused("the token's storage minimum is not read");
    const storageMin = read.registered ? 0n : min;
    const calls = moveCalls(to, read.usdc - keep, !read.registered, storageMin);
    // the signing page's own rule, unchanged: it bounds the amount by its usdc argument less one base unit, so an id
    // passes what it holds (one base unit kept) and A passes one more (all of it moves)
    const move = checkMoveCalls(key.id, to, token, calls, read.usdc + 1n - keep, storageMin);
    const nonce = read.nonce + 1n;
    const tx = signMoveTx(key.publicKey, key.secretKey, nonce, read.blockHash, move);
    return { receiver: move.receiver, calls: move.calls, amount: read.usdc - keep, nonce, ...tx };
  } finally {
    key.secretKey.fill(0);
  }
}

/** The registration payload rule: exactly one storage_deposit(to, registration_only) with the token's minimum, to a typed account checkTypedAccount passes. */
export function checkRegisterCalls(u: string, to: string, token: string, given: readonly MoveCall[], storageMin: bigint): SealedMove {
  if (typeof u !== "string") throw new MoveOutRefused("U, the typed account and the token are strings");
  checkTypedAccount(u, to, token);
  const calls = plainCalls(given);
  const r = calls[0];
  if (calls.length !== 1 || !r || r.method !== "storage_deposit" || r.args.account_id !== to || r.args.registration_only !== true || Object.keys(r.args).length !== 2 || r.deposit !== storageMin || r.gas !== MOVE_GAS.storage_deposit)
    throw new MoveOutRefused("the registration is storage_deposit(the typed account, registration_only) with the token's minimum");
  return seal({ signer: u, receiver: token, calls });
}

/**
 * The typed account's registration on the token alone, by the moving account (W:777: "registered by that same
 * account ... in one of its own before the ft_withdraw"): one storage_deposit(to, registration_only) with the token's
 * minimum. Refused when the read shows it registered already.
 */
export function buildRegisterOut(a: { read: RegisterOutReadFor; key: OwnKey; to: string; token: string; storageMin: bigint }): BuiltMove {
  const { to, token, storageMin } = a;
  namesOk(to, token);
  const key = ownKeyCopy(a.key);
  try {
    const read = readFor(a.read, key.id, to, token);
    if (read.registered !== false) throw new MoveOutRefused("the typed account is registered on the token already");
    if (typeof storageMin !== "bigint" || storageMin <= 0n || storageMin >= U128_LIMIT) throw new MoveOutRefused("the token's storage minimum is not read");
    const calls = moveCalls(to, 1n, true, storageMin).slice(0, 1);
    const move = checkRegisterCalls(key.id, to, token, calls, storageMin);
    const nonce = read.nonce + 1n;
    const tx = signMoveTx(key.publicKey, key.secretKey, nonce, read.blockHash, move);
    return { receiver: move.receiver, calls: move.calls, amount: 0n, nonce, ...tx };
  } finally {
    key.secretKey.fill(0);
  }
}

/** intents.near's own ft_withdraw (defuse 16d04f6, contracts/defuse/src/contract/tokens/nep141/withdraw.rs l.24-49). */
export type WithdrawCall = { method: "ft_withdraw"; args: Obj; gas: bigint; deposit: bigint };
/**
 * ft_withdraw's gas: intents.near gives the token's plain ft_transfer 15 Tgas when no min_gas is signed (defuse 16d04f6
 * contracts/defuse/core/src/intents/tokens.rs l.171; 50 is ft_transfer_call's), ft_resolve_withdraw 15
 * (withdraw.rs l.100-111) and its own work the rest (l.136-140); unused gas comes back.
 */
export const WITHDRAW_GAS = 100n * TGAS;
/** The one call: ft_withdraw(token, receiver_id, amount) with 1 yocto, no memo and no msg (a msg would make it a call). */
export function withdrawCalls(to: string, amount: bigint, token: string): WithdrawCall[] {
  return [{ method: "ft_withdraw", args: { token, receiver_id: to, amount: amount.toString() }, gas: WITHDRAW_GAS, deposit: 1n }];
}
/** The ft_withdraw payload rule: exactly this one call, to the typed account (checkTypedAccount), at most what is held less the keep. */
export function checkWithdrawCalls(u: string, to: string, token: string, given: readonly WithdrawCall[], held: bigint, keep: 0n | 1n = 1n): SealedMove {
  if (typeof u !== "string") throw new MoveOutRefused("U, the typed account and the token are strings");
  checkTypedAccount(u, to, token);
  if (keep !== 0n && keep !== 1n) throw new MoveOutRefused("the keep is 0 or 1 base unit");
  const calls = plainCalls(given);
  const c = calls[0];
  if (calls.length !== 1 || !c || c.method !== "ft_withdraw" || c.deposit !== 1n || c.gas !== WITHDRAW_GAS) throw new MoveOutRefused("one ft_withdraw with 1 yocto");
  if (Object.keys(c.args).join() !== "token,receiver_id,amount" || c.args.token !== token || c.args.receiver_id !== to) throw new MoveOutRefused("ft_withdraw names the token, the typed account and an amount, no memo or msg");
  const amount = big(c.args.amount);
  if (typeof c.args.amount !== "string" || amount === null || amount < 1n || amount > held - keep) throw new MoveOutRefused("the amount is above what the account holds inside intents.near less the keep");
  return seal({ signer: u, receiver: INTENTS, calls });
}

/** What a move out of intents.near needs read, at one block on both RPCs. */
export interface WithdrawOutRead {
  height: number;
  blockHash: string;
  nonce: bigint;
  /** the account's NEAR free of its storage, yocto */
  free: bigint;
  /** mt_balance_of(the account, nep141:<token>) on intents.near */
  held: bigint;
  /** storage_balance_of(the typed account) on the token is not null */
  registered: boolean;
  gasPrice: bigint;
}
/**
 * readMoveOut's reads, then what the account holds inside intents.near, mt_balance_of(u, nep141:<token>), at the
 * same block on both RPCs, equal; null when any read fails or differs. readMoveOut reads the token's balance view
 * too, so while USDC is halted this is null (unread), never a zero.
 */
export async function readWithdrawOut(u: string, to: string, token: string, rpcs: readonly [MoveOutRpc, MoveOutRpc]): Promise<WithdrawOutReadFor | null> {
  const r = await readMoveOut(u, to, token, rpcs);
  if (r === null) return null;
  const params = { request_type: "call_function", account_id: INTENTS, method_name: "mt_balance_of", args_base64: viewArgs({ account_id: u, token_id: `nep141:${token}` }), block_id: r.height };
  const held = await Promise.all(
    rpcs.map(async (x) => {
      try {
        const v = decodeView(resultAt(await x.query(params), r.height));
        return typeof v === "string" && DIGITS.test(v) ? BigInt(v) : null;
      } catch {
        return null;
      }
    }),
  );
  if (held[0] === null || held[0] !== held[1]) return null;
  const { usdc: _onToken, ...rest } = r;
  return { ...rest, held: held[0], u, to, token };
}

/**
 * The move of what `key`'s account holds inside intents.near to `to`, by its own ft_withdraw on intents.near. The typed
 * account must already be registered on the token (its registration rides in a move on the token first, W:777):
 * intents.near would refund an ft_transfer the token refuses, so an unregistered one is refused here, before signing.
 */
export function buildWithdrawOut(a: { read: WithdrawOutReadFor; key: OwnKey; kind: "id" | "arm"; to: string; token: string }): BuiltMove {
  const { to, token, kind } = a;
  namesOk(to, token);
  const keep = keepOf(kind);
  const key = ownKeyCopy(a.key);
  try {
    const read = readFor(a.read, key.id, to, token);
    if (read.registered !== true) throw new MoveOutRefused("the typed account is not registered on the token: register it first");
    if (typeof read.held !== "bigint" || read.held <= keep) throw new MoveOutRefused("nothing to move inside intents.near");
    const calls = withdrawCalls(to, read.held - keep, token);
    const move = checkWithdrawCalls(key.id, to, token, calls, read.held, keep);
    const nonce = read.nonce + 1n;
    const tx = signMoveTx(key.publicKey, key.secretKey, nonce, read.blockHash, move);
    return { receiver: move.receiver, calls: move.calls, amount: read.held - keep, nonce, ...tx };
  } finally {
    key.secretKey.fill(0);
  }
}

// ---------- the exit tool's settle (card exit-ids-out; vault paper 2.12 step 4, 2.5.5) ----------
/** The vault's settle(nullifier_hash), as the kit builds it (vaultSettleCall): 150 Tgas, the refund note's 148 B attached
 *  for a refund_pending spend and nothing for a paid one. It moves no token: the vault's reserve goes to the payer. */
export type SettleCall = { method: "settle"; args: Obj; gas: bigint; deposit: bigint };
/** The settle payload rule: exactly one settle on the release's vault of a network, its one argument a canonical
 *  decimal field element (not 0), the kit's gas, and the kit's attachment for its status. Signed by the spend's own
 *  arming account A, a 64-hex implicit account, which pays the gas. */
export function checkSettleCalls(a: string, vault: string, given: readonly SettleCall[], status: "refund_pending" | "paid"): SealedMove {
  if (typeof a !== "string" || typeof vault !== "string" || !IMPLICIT.test(a)) throw new MoveOutRefused("the settle's signer is a 64-hex implicit account and the vault a string");
  if (!Object.values(NEAR_NETWORKS).some((n) => n.vault === vault)) throw new MoveOutRefused("the vault is no release's vault");
  if (status !== "refund_pending" && status !== "paid") throw new MoveOutRefused("settle takes refund_pending or paid");
  let calls: SettleCall[];
  try {
    calls = structuredClone([...given]);
  } catch {
    throw new MoveOutRefused("the calls are not plain data");
  }
  const c = calls[0];
  if (calls.length !== 1 || !isObj(c) || Object.keys(c).sort().join() !== "args,deposit,gas,method" || !isObj(c.args) || c.method !== "settle") throw new MoveOutRefused("one settle call, method, args, gas and deposit");
  if (Object.keys(c.args).join() !== "nullifier_hash" || typeof c.args.nullifier_hash !== "string") throw new MoveOutRefused("settle names the nullifier hash alone, as a string");
  const nh = big(c.args.nullifier_hash);
  if (nh === null || nh < 1n || nh >= VAULT_FIELD_P || nh.toString() !== c.args.nullifier_hash) throw new MoveOutRefused("the nullifier hash is not a canonical field element");
  if (c.gas !== VAULT_SETTLE_GAS || c.deposit !== (status === "refund_pending" ? VAULT_SETTLE_REFUND_ATTACH : 0n)) throw new MoveOutRefused("settle's gas and attachment are the kit's");
  return seal({ signer: a, receiver: vault, calls });
}
/** What a settle needs read, at one block on both RPCs: the block, A's key nonce and A's NEAR free of its storage. */
export type SettleReadFor = { height: number; blockHash: string; nonce: bigint; free: bigint; gasPrice: bigint; a: string };
/**
 * A's key nonce (its key list exactly its own key), its NEAR and the gas price at the lower final height of both RPCs,
 * equal on both, else null. A that does not exist reads null too: it is funded by a Transfer from the typed account.
 */
export async function readSettle(a: string, rpcs: readonly [MoveOutRpc, MoveOutRpc]): Promise<SettleReadFor | null> {
  if (typeof a !== "string" || !IMPLICIT.test(a)) return null;
  const own = ownKey(a);
  const finals = await Promise.all(rpcs.map(async (r) => {
    try {
      const b = await r.block({ finality: "final" });
      const h = isObj(b) && isObj(b.result) && isObj(b.result.header) ? b.result.header.height : undefined;
      return typeof h === "number" && Number.isSafeInteger(h) && h > 0 ? h : null;
    } catch {
      return null;
    }
  }));
  if (finals.some((h) => h === null) || heightSpreadOver(finals as number[]) !== null) return null;
  const at = Math.min(...(finals as number[]));
  const side = async (r: MoveOutRpc) => {
    try {
      const [b, keys, acct, gp] = await Promise.all([
        r.block({ block_id: at }),
        r.query({ request_type: "view_access_key_list", account_id: a, block_id: at }),
        r.query({ request_type: "view_account", account_id: a, block_id: at }),
        r.call("gas_price", [at]),
      ]);
      const head = isObj(b) && isObj(b.result) && isObj(b.result.header) ? b.result.header : undefined;
      if (!head || head.height !== at || typeof head.hash !== "string" || hash32(head.hash) === null) return null;
      const nonce = keyNonce(keys, at, own);
      const acc = resultAt(acct, at);
      const amount = big(acc?.amount), usage = big(acc?.storage_usage);
      const price = isObj(gp) && isObj(gp.result) ? big(gp.result.gas_price) : null;
      if (nonce === null || amount === null || usage === null || price === null) return null;
      return { blockHash: head.hash, nonce, free: amount - usage * BYTE_COST, gasPrice: price };
    } catch {
      return null;
    }
  };
  const [x, y] = await Promise.all(rpcs.map(side));
  if (!x || !y || x.blockHash !== y.blockHash || x.nonce !== y.nonce || x.free !== y.free || x.gasPrice !== y.gasPrice) return null;
  return { height: at, ...x, a };
}
/** What A must hold for one settle: its attachment and its prepaid gas at GAS_PRICE_MARGIN times the price read. */
export function settleNeed(read: Pick<SettleReadFor, "gasPrice">, status: "refund_pending" | "paid"): bigint {
  return (status === "refund_pending" ? VAULT_SETTLE_REFUND_ATTACH : 0n) + (VAULT_SETTLE_GAS + MOVE_GAS.send) * read.gasPrice * GAS_PRICE_MARGIN;
}
/**
 * settle(nullifierHash) on `vault`, signed by the spend's own arming account A (key: A's own, as armAccount derives
 * it), at A's nonce + 1 on the read's block. The call is the kit's (vaultSettleCall's shape), checked and sealed by
 * checkSettleCalls before the private signer runs; the key's copy is zeroed whichever way.
 */
export function buildSettleOut(x: { read: SettleReadFor; key: OwnKey; vault: string; nullifierHash: bigint; status: "refund_pending" | "paid" }): BuiltMove {
  const { vault, nullifierHash, status } = x;
  const key = ownKeyCopy(x.key);
  try {
    const r = { ...x.read };
    let hash: Uint8Array | null = null;
    try {
      hash = typeof r.blockHash === "string" ? base58.decode(r.blockHash) : null;
    } catch {
      hash = null;
    }
    if (r.a !== key.id || typeof r.nonce !== "bigint" || r.nonce < 0n || r.nonce >= U64_MAX || hash === null || hash.length !== 32) throw new MoveOutRefused("the read is not A's, or its nonce or block hash is not one");
    if (typeof nullifierHash !== "bigint") throw new MoveOutRefused("the nullifier hash is a bigint");
    const calls: SettleCall[] = [{ method: "settle", args: { nullifier_hash: nullifierHash.toString() }, gas: VAULT_SETTLE_GAS, deposit: status === "refund_pending" ? VAULT_SETTLE_REFUND_ATTACH : 0n }];
    const move = checkSettleCalls(key.id, vault, calls, status);
    const nonce = r.nonce + 1n;
    const tx = signMoveTx(key.publicKey, key.secretKey, nonce, r.blockHash, move);
    return { receiver: move.receiver, calls: move.calls, amount: 0n, nonce, ...tx };
  } finally {
    key.secretKey.fill(0);
  }
}

// ---------- reading the transaction back ----------
/**
 * One RPC's read of the move's tx: ok (FINAL, every receipt a success), failed (FINAL, a failure), absent (the RPC's own
 * UNKNOWN_TRANSACTION, as scripts/ci/money-gate.mjs reads "missing"), pending (an answer naming this tx, its hash and
 * U as signer, at any final_execution_status short of FINAL: its receipts still run, so it can still move U's USDC), or
 * unknown: a timeout, a 429 or 5xx or any other answer is no word on whether the tx exists. The release RPCs answer a
 * tx still running, to wait_until NONE, with its transaction, its outcomes so far and a final_execution_status of
 * INCLUDED, EXECUTED_OPTIMISTIC, INCLUDED_FINAL or EXECUTED (rpc.mainnet.fastnear.com and near.drpc.org, a just-included
 * mainnet tx read at once on both, 8 Nov 2026 13:57-13:58Z). NONE (not yet included) carries no transaction to name, so it
 * is no word here: U's nonce is not past a record whose tx was never included. Asked with wait_until NONE, which answers at
 * once with the tx's outcome so far: to FINAL a hash the RPC does not know never answers UNKNOWN_TRANSACTION (the
 * release RPCs, read 8 Nov 2026: fastnear times out, dRPC answers 408), so FINAL is checked on the answer instead.
 */
const PENDING: ReadonlySet<unknown> = new Set(["INCLUDED", "EXECUTED_OPTIMISTIC", "INCLUDED_FINAL", "EXECUTED"]);
async function txState(r: MoveOutRpc, hash: string, u: string): Promise<"ok" | "failed" | "absent" | "pending" | "unknown"> {
  try {
    const a = await r.tx({ tx_hash: hash, sender_account_id: u, wait_until: "NONE" });
    if (isObj(a) && isObj(a.error) && isObj(a.error.cause) && a.error.cause.name === "UNKNOWN_TRANSACTION") return "absent";
    const res = isObj(a) && a.error === undefined ? a.result : undefined;
    if (isObj(res) && PENDING.has(res.final_execution_status) && isObj(res.transaction) && res.transaction.hash === hash && res.transaction.signer_id === u) return "pending";
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
/** The tx on both RPCs: ok, failed, absent, pending or unknown when both read the same; split when they differ (then nothing is decided). */
async function readBoth(rpcs: readonly [MoveOutRpc, MoveOutRpc], hash: string, u: string): Promise<"ok" | "failed" | "absent" | "pending" | "unknown" | "split"> {
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
  /**
   * The network's archival RPCs: none, or exactly NEAR_NETWORKS[network].archival, each once (else refused). Every one
   * is asked, and only for a record whose nonce U's nonce is settled past while U holds at most 1 base unit: none given,
   * or any two answering apart (no answer included), and the record stays as it is.
   */
  archival?: readonly MoveOutRpc[];
  /** U's own lock (the page's FOLLOW_LOCK/<network>/<U>, exclusive), taken only if free: null when another holds it. */
  uLock?: <T>(fn: () => Promise<T>) => Promise<T | null>;
  sleep?: (ms: number) => Promise<void>;
  /** The helper's 1Click status read (the follow's reader, follow.ts readDepositStatus): asked once at the tap for each
   *  op of U whose stored status is none, PENDING_DEPOSIT or INCOMPLETE_DEPOSIT. Default: fetch. */
  fetchFn?: typeof fetch;
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

/**
 * The block hash record `signed` was signed over (its Transaction's block_hash, borsh: signer_id string, the key's type
 * byte and 32 bytes, nonce u64, receiver_id string, block_hash 32 bytes), when its signer is `u`; else null.
 */
export function signedBlockHash(signed: string, u: string): string | null {
  try {
    const b = base64.decode(signed);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 0;
    const str = (): string => {
      const n = dv.getUint32(o, true);
      const v = new TextDecoder().decode(b.subarray(o + 4, o + 4 + n));
      o += 4 + n;
      return v;
    };
    if (str() !== u || b[o] !== 0) return null;
    o += 1 + 32 + 8;
    str();
    if (o + 32 > b.length) return null;
    return base58.encode(b.subarray(o, o + 32));
  } catch {
    return null;
  }
}

/**
 * One archival host's word on record `had` of U: its tx read, but UNKNOWN_TRANSACTION only once the same host serves
 * the block the record was signed over (block_id had.height, its header hash the block_hash inside had.signed): a host
 * pruned of that era, or of another chain, has no word ("unknown").
 */
async function archivedState(h: MoveOutRpc, had: MoveOutRecord, U: string): Promise<"ok" | "failed" | "absent" | "unknown"> {
  const st = await txState(h, had.hash, U);
  // an archival host is asked only of a tx the pair forgot: a running one there is no word
  if (st === "pending") return "unknown";
  if (st !== "absent") return st;
  const want = signedBlockHash(had.signed, U);
  if (want === null) return "unknown";
  try {
    const a = await h.block({ block_id: had.height });
    const head = isObj(a) && isObj(a.result) && isObj(a.result.header) ? a.result.header : undefined;
    return head && head.height === had.height && head.hash === want ? "absent" : "unknown";
  } catch {
    return "unknown";
  }
}

/** A record that is gone (can never land): why, with U's USDC when it was read. */
type Gone = { gone: "failed" | "expired" | "replaced"; usdc: bigint | null };
/**
 * Whether record `had` of U can still land (live: follow it), landed (its nonce settled, every archival RPC reads it
 * FINAL and a success, U holds at most 1 base unit), or is gone, read on both RPCs and, once U's nonce is settled past
 * it and U is empty, on the archival RPCs.
 */
async function recordState(U: string, token: string, had: MoveOutRecord, rpcs: readonly [MoveOutRpc, MoveOutRpc], archival: readonly MoveOutRpc[]): Promise<"live" | "landed" | Gone> {
  const sides = await Promise.all(rpcs.map((r) => txState(r, had.hash, U)));
  if (sides.every((x) => x === "failed")) return { gone: "failed", usdc: null };
  // FINAL success on both: follow() reads it, and U with it
  if (sides.every((x) => x === "ok")) return "live";
  // otherwise (one side's word, or none, in any mix) U's nonce decides: expired needs no tx read; settled needs U's nonce
  // at or past the record's SETTLE_BLOCKS below the read height too
  const r = await readMoveOut(U, had.to, token, rpcs).catch(() => null);
  if (r === null) return "live";
  // expired before any one side's word (delta review 4, item 3; delta review 5, item 2): U's nonce below the record's,
  // read equal on the pair, at a height past its validity window means the tx was never included and never can be, so
  // a side that reads it running, FINAL ok or FINAL failed is wrong, never a hold. The tap signs at that same nonce and
  // the old bytes are past their window, so at most one of the two can land; unequal nonce reads hold (readMoveOut null)
  if (r.nonce < BigInt(had.nonce) && BigInt(r.height) > BigInt(had.height) + TX_VALIDITY_BLOCKS) return { gone: "expired", usdc: r.usdc };
  // its receipts still run on either RPC: it can still move U's USDC, so it is followed, whatever U holds or its nonce
  // says (delta review 3, F1: a receipt delayed past SETTLE_BLOCKS)
  if (sides.some((x) => x === "pending")) return "live";
  if (r.nonce >= BigInt(had.nonce) && r.height > SETTLE_BLOCKS) {
    const past = await keyNonceAt(U, r.height - SETTLE_BLOCKS, rpcs).catch(() => null);
    if (past !== null && past >= BigInt(had.nonce)) {
      // U's nonce is settled past it on both RPCs: the record's bytes can never land again (nearcore refuses a nonce at or
      // below the key's, and a tx included that far back has run every receipt). It landed, or another tx of U took its
      // nonce. Money in U is always movable (delta reviews of c3e71713): U holding more than 1 base unit on the pair's
      // equal read is replaced, whatever any host says of the tx (one of the pair forgetting it before the other, about 16
      // to 37 h after it, or a tx read that fails, included), so a tap moves what U holds. For an empty U the archival
      // hosts decide, which keep every tx (fastnear keeps about 100,000 to 180,000 mainnet blocks, dRPC under 230,000,
      // read 8 Nov 2026), every listed one, settled only on an equal word from all (review M1: both read one backend,
      // 8 Nov 07:56Z): FINAL success a landed move, FINAL failure a failed one, UNKNOWN_TRANSACTION from a host that
      // serves the record's block (archivedState) a replaced one. An empty U with no equal word stays as it is.
      // The hosts are asked only for an empty U (delta review 4, item 2: their word is not read otherwise, and their asks
      // wait inside U's lock), and U is read again once they answered, the decision on that read (item 1: their asks may
      // wait about 70 s, and a deposit reaching U meanwhile is open, never Moved); no new read and it stays as it is.
      if (r.usdc > 1n) return { gone: "replaced", usdc: r.usdc };
      if (archival.length === 0) return "live";
      const words = await Promise.all(archival.map((h) => archivedState(h, had, U)));
      const a = words.every((w) => w === words[0]) ? words[0]! : "unknown";
      const now = await readMoveOut(U, had.to, token, rpcs).catch(() => null);
      if (now === null) return "live";
      if (a === "ok" && now.usdc <= 1n) return "landed";
      if (a === "failed" && now.usdc <= 1n) return { gone: "failed", usdc: now.usdc };
      if (a === "absent" || now.usdc > 1n) return { gone: "replaced", usdc: now.usdc };
    }
  }
  return "live";
}

/**
 * Moves what held op `opId`'s U holds on the token, less one base unit, to `to` (checked by the page's checkRecipient),
 * or resumes the move the op already holds (then `to` is not used: the recorded one is). With `to` null it only
 * resumes: it sends recorded bytes again and reads them, and never signs. Answers how far it got.
 */
export async function moveOutHeld(opId: string, to: string | null, deps: MoveOutDeps): Promise<MoveOutOutcome> {
  // the typed account is a string or nothing, before any read (checkMoveCalls refuses it again)
  if (to !== null && typeof to !== "string") throw new MoveOutRefused("U, the typed account, the token and every account id are strings");
  return moveOut(opId, to, deps, true, { asked: new Set() });
}
/** One tap's status re-read (delta review 9, ruling 1): the ops it asked, once each over both of a tap's passes, and its
 *  one budget, DEPOSIT_STATUS_TIMEOUT_MS from its first read (delta review 10, F2). */
type TapReads = { asked: Set<string>; budget?: AbortSignal };
// `again`: a tap whose followed record (one written before it: never its own new one) turns out landed with a later
// deposit in U (open) runs once more, so that one tap signs (delta review 2 of c3e71713, L5); once only, so a tap signs
// one move at most and no pair's word can make it sign in a loop
async function moveOut(opId: string, to: string | null, deps: MoveOutDeps, again: boolean, tap: TapReads): Promise<MoveOutOutcome> {
  const { ops, rpcs } = deps;
  const archival = deps.archival ?? [];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const seedLock = deps.seedLock ?? (<T>(fn: () => Promise<T>) => fn());
  const uLock = deps.uLock ?? (<T>(fn: () => Promise<T>) => fn());
  let op = await heldOpOf(ops, opId);
  const network = op.follow.network as NearNetwork;
  if (nearPairNetwork(rpcs) !== network) throw new MoveOutRefused("the RPCs are not the op's network's release pair");
  // none, or exactly the network's archival list, each host once (delta review L4: a part of it settles on fewer words)
  const listed = NEAR_NETWORKS[network].archival as readonly string[];
  const names = archival.map((h) => h.name);
  if (archival.length !== 0 && (names.length !== listed.length || new Set(names).size !== names.length || names.some((n) => !listed.includes(n)))) throw new MoveOutRefused("an archival RPC is not the op's network's: the list must be none or exactly the network's");
  const U = op.follow.u;
  const token = NEAR_NETWORKS[network].usdc;
  const shownOf = (r: MoveOutRecord) => ({ to: r.to, amount: BigInt(r.amount), hash: r.hash });

  // a gone record of op `id` leaves follow.out for follow.out_past (a compare-and-set on its hash)
  const clear = (id: string, r: MoveOutRecord) =>
    ops.update("ops", id, (v) => {
      const o = v as DepositOp | undefined;
      if (!isObj(o) || o.follow.out?.hash !== r.hash) return undefined;
      const { out: _gone, ...rest } = o.follow;
      return { ...o, follow: { ...rest, out_past: [...(o.follow.out_past ?? []), r] } };
    });
  // the filter landed() walks and re-checks inside each write: a held deposit op of U on this network, never one inside
  // intents.near (a follower may have moved it on between the walk's read and the write: delta review 7, item 3)
  const ofU = (o: DepositOp | undefined): o is DepositOp => isObj(o) && o.kind === "deposit" && o.stage === "held" && isObj(o.follow) && o.follow.u === U && o.follow.network === network && o.follow.intents_struck !== true;
  // record r of op `owner` landed with U empty: U's held ops (the owner among them) end moved_out while the move covers
  // them: the sum of their needs at most r's amount + 1 (what U held when it was signed), as follow.ts caps done by U's
  // bound sum (delta review 6, F1 and F2). Ops this record already marked count first, at their own needs, so a second
  // landed() on one record (two SIGN_HOST tabs: settleHeld runs on every load) never marks past the cap (delta review 7,
  // item 2). Then every op 1Click named delivered, oldest first, each needing max(min_out, delivered); then each op whose
  // own status last read a send in flight (sent, KNOWN_DEPOSIT_TX or PROCESSING) when U's bind stopped (follow.ts
  // holdAll holds every op of U, and reads each one's status once as it does), oldest first, needing its min_out, the
  // device's own signed floor; then each op whose status is PENDING_DEPOSIT or none (a read that failed at holdAll, or a
  // page closed before the user paid), oldest first, at its min_out too: its worst case is a quote never paid read Moved,
  // which hides no money, and a later USDC in U reopens it (delta review 8, ruling 1). One 1Click REFUNDED (into
  // intents.near: every refund-moved op among them, its USDC in 1Click's own later tx), FAILED or INCOMPLETE_DEPOSIT
  // has no need and is never marked (delta review 3, F3; delta review 5, item 1; delta review 7, item 1). An op
  // reopened with no record (its money went with an earlier landed move: a later deposit reopened it, or follow.ts ended
  // it so), and the owner of a `later` record, need nothing. The owner is no exception (the page picks it by key order,
  // heldOpFor, not by whose money is in U): left unmarked, its landed record is history (out_past) and it stays held.
  // Each marked op gets the record, so it reads Moved as the owner does (delta review item 8). A known limit, follow.ts's
  // D2: `delivered` is 1Click's status through the helper, so a stranger's USDC in U can still cover a forged op; the
  // cap keeps the ops read Moved within what the move took. The same helper picks the ranks: one that answers REFUNDED
  // for a paid op leaves it no need, so its tap moves its money and it stays held (the page still answers moved; delta
  // review 9, ruling 3). Answers whether the owner ends marked.
  const landed = async (owner: string, r: MoveOutRecord): Promise<boolean> => {
    const cap = BigInt(r.amount) + 1n;
    const walk: { k: string; marked: boolean; rank: number; created: number; need: bigint | null }[] = [];
    for (const k of await ops.keys("ops")) {
      const o = (await ops.get("ops", k).catch(() => undefined)) as DepositOp | undefined;
      if (!ofU(o)) continue;
      if (k === owner ? o.follow.out?.hash !== r.hash : o.follow.out !== undefined && o.follow.out.hash !== r.hash) continue;
      const marked = o.follow.why === "moved_out" && o.follow.out?.hash === r.hash;
      const reopened = o.follow.why === "moved_out" && o.follow.out === undefined;
      const min = big(o.follow.min_out);
      const got = o.follow.delivered === undefined ? null : big(o.follow.delivered);
      const told = o.follow.delivered !== undefined;
      const flight = o.follow.sent === true && (o.follow.status === "KNOWN_DEPOSIT_TX" || o.follow.status === "PROCESSING");
      // the stale read (delta review 8, ruling 1): PENDING_DEPOSIT or none, held before any later status was read
      const stale = o.follow.status === undefined || o.follow.status === "PENDING_DEPOSIT";
      const need = reopened || (k === owner && r.later === true) ? 0n : min === null ? null : told ? (got === null ? null : got > min ? got : min) : flight || stale ? min : null;
      const rank = marked ? 0 : told ? 1 : flight ? 2 : 3;
      walk.push({ k, marked, rank, created: Number.isFinite(o.created_ms) ? o.created_ms : 0, need });
    }
    walk.sort((x, y) => x.rank - y.rank || x.created - y.created || (x.k < y.k ? -1 : x.k > y.k ? 1 : 0));
    let sum = 0n;
    let mine = false;
    for (const { k, marked, need } of walk) {
      if (marked) {
        sum += need ?? 0n;
        if (k === owner) mine = true;
        continue;
      }
      if (need === null || sum + need > cap) continue;
      let wrote = false;
      await ops.update("ops", k, (v) => {
        const o = v as DepositOp | undefined;
        if (!ofU(o) || (o.follow.out !== undefined && (o.follow.out.hash !== r.hash || o.follow.why === "moved_out"))) return undefined;
        wrote = true;
        return { ...o, follow: { ...o.follow, why: "moved_out", out: r } };
      });
      if (!wrote) continue;
      sum += need;
      if (k === owner) mine = true;
    }
    if (!mine) await clear(owner, r);
    return mine;
  };
  // what the page answers once a landed record was read: Moved on the page's own op's record when it is marked (delta
  // review 7, item 4); else Moved on r when it marked any op of U (the page picks its op by key order, heldOpFor: delta
  // review 8, ruling 3; a cap of amount + 1 can mark an op whose min_out is the whole move); else Moved on r when it
  // left U having held at least MIN_DEPOSIT (r's amount + 1, the cap's base and follow.ts needOf's floor for a
  // refund-moved op: delta review 11, F1), since a landed move that carried money never answers empty (delta review 8,
  // point 3 fold); under it, with none marked, it is never an op of ours but a stranger's dust: nothing to move (delta
  // review 10, F1)
  const stored = async (r: MoveOutRecord): Promise<MoveOutOutcome> => {
    const me = (await ops.get("ops", opId).catch(() => undefined)) as DepositOp | undefined;
    if (isObj(me) && isObj(me.follow) && me.follow.why === "moved_out" && me.follow.out !== undefined) return { kind: "moved", ...shownOf(me.follow.out) };
    for (const k of await ops.keys("ops")) {
      const o = (await ops.get("ops", k).catch(() => undefined)) as DepositOp | undefined;
      if (ofU(o) && o.follow.why === "moved_out" && o.follow.out?.hash === r.hash) return { kind: "moved", ...shownOf(r) };
    }
    return BigInt(r.amount) + 1n >= VAULT_CONSTANTS.MIN_DEPOSIT ? { kind: "moved", ...shownOf(r) } : { kind: "empty" };
  };
  // the ops record r marked, reopened: its record history (out_past), why kept moved_out
  const reopen = async (r: MoveOutRecord) => {
    for (const k of await ops.keys("ops"))
      await ops.update("ops", k, (v) => {
        const o = v as DepositOp | undefined;
        if (!ofU(o) || o.follow.why !== "moved_out" || o.follow.out?.hash !== r.hash) return undefined;
        const { out: _gone, ...rest } = o.follow;
        return { ...o, follow: { ...rest, out_past: [...(o.follow.out_past ?? []), r] } };
      });
  };
  // at the tap, before the other ops' records are read (so a landed one is walked on fresh ranks) and before the walk:
  // each op of U whose status is none, PENDING_DEPOSIT or INCOMPLETE_DEPOSIT (holdAll's one read failed, or came before
  // a top-up 1Click then delivered) is read once again on the follow's reader, inside U's lock, the user present, and
  // its facts kept (delta review 9, ruling 1; delta review 10, F4 and order). The reads run at once under the tap's one
  // budget, an abort a failed read (delta review 10, F2); a failed read keeps its stored status, and the tap signs with
  // the ranks it has; each op asked once a tap, never in a loop
  const reread = async () => {
    const stale: [string, DepositOp][] = [];
    for (const k of await ops.keys("ops")) {
      if (tap.asked.has(k)) continue;
      const o = (await ops.get("ops", k).catch(() => undefined)) as DepositOp | undefined;
      if (!ofU(o) || o.follow.why === "moved_out" || !(o.follow.status === undefined || o.follow.status === "PENDING_DEPOSIT" || o.follow.status === "INCOMPLETE_DEPOSIT")) continue;
      tap.asked.add(k);
      stale.push([k, o]);
    }
    if (stale.length === 0) return;
    tap.budget ??= AbortSignal.timeout(DEPOSIT_STATUS_TIMEOUT_MS);
    const budget = tap.budget;
    const read1 = ([, o]: [string, DepositOp]) => readDepositStatus(o.follow.address, U, deps.fetchFn ?? fetch, budget, Date.now()).catch(() => null);
    const reads = await Promise.all(stale.map(read1));
    for (let j = 0; j < stale.length; j++)
      await ops.update("ops", stale[j]![0], (v) => {
        const x = v as DepositOp | undefined;
        if (!ofU(x)) return undefined;
        const read = statusFacts(x.follow, reads[j]!);
        return Object.keys(read).length === 0 ? undefined : { ...x, follow: { ...x.follow, ...read } };
      });
  };
  // record r of op `owner`: its same bytes again, read until FINAL on both
  const follow = async (r: MoveOutRecord, owner: string): Promise<MoveOutOutcome> => {
    const shown = shownOf(r);
    for (let k = 0; k < FINAL_TRIES; k++) {
      const st = await readBoth(rpcs, r.hash, U);
      if (st === "ok") {
        // landed: Moved only while U holds at most 1 base unit (delta review item 2, every path); more there (a late
        // deposit) is history for this record and open for the next tap; no equal read of U, no word yet
        const now = await readMoveOut(U, r.to, token, rpcs).catch(() => null);
        if (now === null) return { kind: "unread" };
        if (now.usdc > 1n) {
          // landed with a later deposit in U: the ops it carried are marked by it, then reopened (the record history,
          // why kept moved_out), so the next tap carries `later` and they read Moved again; the money in U is open
          // (delta review 8, ruling 2)
          await landed(owner, r);
          await reopen(r);
          return { kind: "open" };
        }
        await landed(owner, r);
        return stored(r);
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

  // a move already written: its bytes again, never a new signature while they can land
  const had = op.follow.out;
  if (had !== undefined && op.follow.why === "moved_out") {
    // moved, while U holds at most 1 base unit; a later deposit in U is history for this record and open for the next
    // tap (money in U is always movable, delta review item 2); no equal read of U keeps it moved
    const now = await readMoveOut(U, had.to, token, rpcs).catch(() => null);
    if (now === null || now.usdc <= 1n) return { kind: "moved", ...shownOf(had) };
    await clear(opId, had);
    if (to === null) return { kind: "open" };
  } else if (had !== undefined) {
    const st = await recordState(U, token, had, rpcs, archival);
    if (st === "live") {
      const f = await follow(had, opId);
      return f.kind === "open" && to !== null && again ? moveOut(opId, to, deps, false, tap) : f;
    }
    if (st === "landed") {
      await landed(opId, had);
      return stored(had);
    }
    // gone: a new signature only on the user's tap; a replaced record is never shown as a move that failed
    if (to === null && st.gone === "replaced") {
      if (st.usdc !== null && st.usdc <= 1n) return { kind: "empty" };
      await clear(opId, had);
      return { kind: "open" };
    }
    if (to === null) return { kind: "failed", ...shownOf(had) };
    await clear(opId, had);
  }
  if (to === null) throw new MoveOutRefused("no typed account");
  const typed = to;

  type Signed = { follow: MoveOutRecord; owner: string; fresh?: true } | { outcome: MoveOutOutcome };
  const signed = await uLock(async (): Promise<Signed> => {
    op = await heldOpOf(ops, opId);
    if (op.follow.out !== undefined) return { follow: op.follow.out, owner: opId }; // another tab wrote one meanwhile
    await reread();
    // another op of U with a live record: that move is U's one move; gone ones are cleared
    for (const k of await ops.keys("ops")) {
      if (k === opId) continue;
      const o = (await ops.get("ops", k).catch(() => undefined)) as DepositOp | undefined;
      const r = isObj(o) && o.kind === "deposit" && isObj(o.follow) && o.follow.u === U && o.follow.network === network && o.follow.why !== "moved_out" ? o.follow.out : undefined;
      if (r === undefined) continue;
      const st = await recordState(U, token, r, rpcs, archival);
      if (st === "live") return { follow: r, owner: k };
      if (st === "landed") await landed(k, r);
      else await clear(k, r);
    }
    // another op's landed record marked this op too: it reads Moved, nothing to sign
    const mine = await heldOpOf(ops, opId);
    if (mine.follow.why === "moved_out" && mine.follow.out !== undefined) return { outcome: { kind: "moved", ...shownOf(mine.follow.out) } };
    const read = await readMoveOut(U, typed, token, rpcs);
    // U's nonce at 2^64 - 1: the nonce signed next (this + 1) would not fit the u64 nearcore reads
    if (read === null || read.nonce >= U64_MAX) return { outcome: { kind: "unread" } };
    if (read.usdc <= 1n) return { outcome: { kind: "empty" } };
    const storageMin = read.registered ? 0n : await readTokenStorageMin(network, rpcs);
    const calls = moveCalls(typed, read.usdc - ID_KEEP, !read.registered, storageMin);
    const move = checkMoveCalls(U, typed, token, calls, read.usdc, storageMin);
    const gas = move.calls.reduce((a, c) => a + c.gas, MOVE_GAS.send);
    const need = gas * read.gasPrice * GAS_PRICE_MARGIN + move.calls.reduce((a, c) => a + c.deposit, 0n);
    if (read.free < need) return { outcome: { kind: "gas", need: need - read.free, u: U } };
    const nonce = read.nonce + 1n;

    const tx = await seedLock(async () => {
      const seed = await deps.seed64();
      try {
        if (!(seed instanceof Uint8Array) || seed.length !== 64) throw new MoveOutRefused("seed64 must be 64 bytes");
        const k = depositId(seed, BigInt(op.follow.s), op.follow.i);
        try {
          if (k.id !== U) throw new MoveOutRefused("the seed's U_{s,i} is not the op's U");
          return signMoveTx(k.publicKey, k.secretKey, nonce, read.blockHash, move);
        } finally {
          k.secretKey.fill(0);
        }
      } finally {
        seed.fill(0);
      }
    });
    const record: MoveOutRecord = { to: typed, amount: (read.usdc - ID_KEEP).toString(), nonce: nonce.toString(), height: read.height, register: !read.registered, hash: tx.hash, signed: tx.signed, ...(op.follow.why === "moved_out" ? { later: true as const } : {}) };
    // written before it is sent; of two writers only the first sends, the other follows it
    await ops.update("ops", opId, (v) => {
      const o = v as DepositOp | undefined;
      // an op follow.ts ended moved_out with no move of its own (follow.ts:1023) is held again from this move on, so its
      // state reads it, its resume follows it and the other-op scan sees it (delta review item 3)
      if (!isObj(o) || o.stage !== "held" || o.follow.out !== undefined) return undefined;
      const { why, ...rest } = o.follow;
      return { ...o, follow: { ...rest, ...(why === undefined || why === "moved_out" ? {} : { why }), out: record } };
    });
    const now = await heldOpOf(ops, opId);
    if (now.follow.out === undefined) throw new MoveOutRefused("the move could not be written");
    return now.follow.out.hash === record.hash ? { follow: record, owner: opId, fresh: true } : { follow: now.follow.out, owner: opId };
  });
  if (signed === null) return { kind: "unread" }; // U's lock is held: another op of U is being followed
  if ("outcome" in signed) return signed.outcome;
  const f = await follow(signed.follow, signed.owner);
  return f.kind === "open" && again && signed.fresh !== true ? moveOut(opId, typed, deps, false, tap) : f;
}
