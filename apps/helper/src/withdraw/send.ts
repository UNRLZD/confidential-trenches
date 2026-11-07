// POST /v1/withdraw's checks 7-10 and the send, then the outcome and the settle (markets paper H3.1, M:991-1004; H3.4
// checks 7-10, M:1363-1392, with check 5's index and check 6's send record, withdraw/index.ts; the route row, M:3366).
// In order, for one request:
//
//   1-4. checks.ts (shape, context, fee, proof), with the fee quoter's fee_min (fee.ts).
//   5-6. index.ts checkNullifier: spent / index_behind / in_flight / withdraw_failed (advice; the claim decides).
//   5.   then, at one agreed final block on two NEAR RPCs: stateRoot is not 0 and is_known_state_root(stateRoot) and
//        is_known_label_root(ASPRoot) are true, else unknown_root (rows 5 and 6); withdrawnValue is at most deposited -
//        spent + returned from totals(), else bad_proof (row 9); and newCommitmentHash is not a leaf in the leaves index
//        (caught up at the spends index's final height H, as it is), which holds fewer than 2^32 leaves, else bad_proof
//        (row 12) (M:1129-1135). A proof over a tree the vault never had is refused here with nothing signed.
//   7.   register_deposit is 0 when storage_balance_of(recipient) is set, and the token's storage_balance_bounds().min
//        when it is null, both read at one agreed final block on two NEAR RPCs (fee.ts agreedBlock and viewAt); else
//        register_deposit_wrong. A send of a stored withdrawal (H3.7's send after done, a carry of the stored request,
//        the restart's send) also takes the minimum for a recipient registered after the request was taken.
//   7b.  the fee account (fee_recipient, check 3's own): storage_balance_of(fee_recipient) a NEP-145 balance (not null)
//        and is_blocklisted(fee_recipient) exactly false at check 7's block on both RPCs (fee.ts readFeeAccount), else
//        503 relayer_low with the log line "withdraw 503 relayer_low: relayer fee account not ready (<fee> on <token>:
//        registered <bool>, blocklisted <bool>)". A read that fails, disagrees or answers another shape holds the same
//        way, its line ending "not read (<why>)". The vault pays the fee in the same receipt as the recipient's amount
//        (card vault-review-fixes-1, review A-01), so a fee account the token refuses fails every payout whole into
//        refund_pending. Asked after check 10 (a halted token answers token_halted first), and read again in the queue
//        right before signing, after check 10's hold, at a fresh agreed block. The quote holds on the same reads
//        (fee.ts: GET /v1/withdraw/fee answers 503 upstream), so a device never proves for a send POST would hold.
//   8.   recipient and fee_recipient are neither the vault nor intents.near, and is_blocklisted(recipient) is exactly
//        false at check 7's block on both RPCs (a blocklisted recipient fails the one payout receipt whole, A-01, and the
//        settle would pay a refund note's storage for nothing), else bad_recipient; a blocklist answer that fails,
//        disagrees or is no boolean answers 503 upstream. Read again with check 7b in the queue: true there is
//        bad_recipient, a failed read holds as 7b's does.
//   9.   deadline_ms is at least the newest final block's time + 30 s (120 s for a request that funds A, H3.7 item 1),
//        the time read as header.timestamp_nanosec (a decimal string) / 10^6 on both providers, never header.timestamp
//        (a JSON number past 2^53) and never the helper's clock; else deadline_too_close.
//   10.  the token watch (token-status/status.ts tokenHeld): anything but a caught-up open token is 503 token_halted,
//        checked again inside the relayer's queue right before the transaction is signed.
//   A request with fund_recipient true (the kit sends it on every withdrawal): until H3.7's funding is built, it is
//   carried only when its recipient is an implicit A (64 lowercase hex) that exists with key list exactly [A's own id
//   key] and holds at least A_store, read at the same block on both providers (H3.7 item 1's resend rule, M:1567-1572);
//   anything else is recipient_refused, nothing sent (decided on card relayer-withdraw-send).
//   relayer_low (H3.5, M:1511): in the queue, before signing, the gas account must hold one more withdraw's gas bought
//   up front, its attachment and one settle's gas and attachment (WITHDRAW_FLOOR), else 503 relayer_low.
//   The send: one FunctionCall withdraw(withdrawal, proof, public_signals) on the vault, 300 Tgas, the storage the
//   vault asks attached (the kit's vaultWithdrawYocto, a tree that may grow always counted: settle returns the rest),
//   signed by one of the relayer's keys (several keys are nonce lanes, M:1044-1054), the send record claimed in one
//   durable create-if-absent write before the broadcast (index.ts claim); a claim that loses drops the signed bytes.
//   The answer is 200 {tx_hash, state: "submitted"} once the bytes are sent.
//
// The outcome rounds (every OUTCOME_ROUND_MS, and once at start before a request is taken): every open send's stored
// bytes go out again to both providers and its outcome is read from blocks only (bind/send.ts resolve, fromBlocks: D
// by the key's nonce, E by the vault's account_changes naming r_w): succeeded; failed by the deadline when E's time is
// above deadline_ms (the row is deleted and the note freed); failed otherwise (kept with its error and release
// number, check 6); never applied (deleted). Then every send that succeeded is settled: the vault's spends row for its
// nullifier, read at one final block on both providers, reads paid or refund_pending (its callback has run) and the
// relayer sends settle(nullifier_hash), with 148 B x 1e19 attached for a refund note whose tree may grow (the vault
// returns what it does not use); settled already (anyone may settle) ends it. A settle that fails on chain is kept with
// the release that signed it and is not signed again by that release (a failure that repeats would burn gas every
// round); a settle never applied is signed again.
//
// Not here: H3.7's funding of A and its relayed call (fund_recipient_wrong, and the Transfer of A_store).
import { join } from "node:path";
import { vaultWithdrawYocto, type HelperWithdrawCode } from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import { createFileStore, nearRpc, relayerKey, RPC_TIMEOUT_MS, RpcError, startRelayer, type Relayer, type Rpc, type TxOutcome, type TxRef } from "../bind/send.ts";
import { readUrls, statusesOf, tokenHeld, tokenWatchesFromEnv, USDC, type HoldAt, type TokenStatus } from "../token-status/status.ts";
import { checkWithdraw, decimal, isAccountId, type CheckedWithdraw, type WithdrawConfig, type WithdrawReads } from "./checks.ts";
import { agreedBlock, FEE_ACCOUNT_NOT_READY, feeAccountReady, FeeReadRefused, HEIGHT_SPREAD_MAX, readFeeAccount, RELAYER_ENV, STORE_ENV, TESTNET_RPCS, TESTNET_TOKEN, viewAt, type Block, type FeeAccount, type FeeNetwork, type FeeQuoter } from "./fee.ts";
import { checkNullifier, createLeavesIndex, createSpendsIndex, createWithdrawSendStore, nullifierKey, TREE_CAPACITY, type LeavesIndex, type SpendsIndex, type WithdrawSendStore } from "./index.ts";
import { pagesAt } from "../near/pages.ts";

// ---- Values ----

/** Check 9's margin for the withdrawal's own send (M:1376) [design]. */
export const SEND_MARGIN_MS = 30_000n;
/** Check 9's margin for a request that funds A first (M:1377-1386) [design]. */
export const FUND_MARGIN_MS = 120_000n;
/** The vault refuses intents.near as a recipient (row 2, V@93b827c:354). */
export const INTENTS = "intents.near";
/** The withdraw call's gas: the kit's figure (VAULT_WITHDRAW.gas_tgas, V@93b827c:392). */
export const WITHDRAW_GAS = 300_000_000_000_000n;
/** settle's gas: above G_settle's 104.475 Tgas (fee.ts FEE_G_SETTLE, a refund note at depth 32); unused gas is refunded. */
export const SETTLE_GAS = 150_000_000_000_000n;
/** settle's attachment for a refund note: a tree that grows a level, 148 B x 1e19 (M:999); the vault returns what it does not use. */
export const SETTLE_REFUND_ATTACH = 148n * 10n ** 19n;
/** The outcome rounds' period: the stored bytes go out again this often until the outcome is final (M:1337). */
export const OUTCOME_ROUND_MS = 10_000;
/** A_store: the storage of A's record and one key, 182 B x 1e19 (M:1586; W:742; the wallet's FEE_A_FUND counts it). */
export const A_STORE_YOCTO = 182n * 10n ** 19n;
/** Prepaid gas is bought at up to 1e9 yocto per gas up front (F10, M:1480; bind/send.ts RELAYER_FLOOR_YOCTO). */
const GAS_PRICE_MAX = 1_000_000_000n;
/** One settle's worst: its gas bought up front and the refund note's attachment. */
export const SETTLE_FLOOR_YOCTO = SETTLE_GAS * GAS_PRICE_MAX + SETTLE_REFUND_ATTACH;
/** relayer_low's floor for one more withdrawal (H3.5): its gas bought up front, what it attaches, and its settle. */
export const withdrawFloor = (attach: bigint): bigint => WITHDRAW_GAS * GAS_PRICE_MAX + attach + SETTLE_FLOOR_YOCTO;

const U128 = 1n << 128n;
const TOKENS: Record<FeeNetwork, string> = { mainnet: USDC, testnet: TESTNET_TOKEN };
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export type WithdrawAnswer = { status: number; body: { tx_hash: string; state: "submitted" } | { error: { code: HelperWithdrawCode | "upstream" } } };

export type WithdrawSendDeps = {
  cfg: WithdrawConfig;
  /** The network's two providers of two operators. */
  rpcs: readonly [Rpc, Rpc];
  /** Check 3's fee_min (fee.ts FeeQuoter.reads). */
  reads: WithdrawReads;
  index: SpendsIndex;
  /** Check 5's row 12: the vault's state-tree leaves, read as the spends index is. */
  leaves: LeavesIndex;
  store: WithdrawSendStore;
  /** One per relayer key (nonce lanes); each send takes the next in turn. */
  relayers: readonly Relayer[];
  /**
   * The token watch at the move's H (status.ts statusAt); anything but a caught-up open token holds. A withdrawal asks
   * at "lower", the newest block final on both providers (markets.md check 10).
   */
  tokenStatus(at: HoldAt): Promise<TokenStatus>;
  /** The helper's clock, only for the age bound on two frozen finals (fee.ts agreedBlock), never for the deadline. */
  now?: () => number;
  /** The helper's log; console.log under "helper: " by default. */
  log?: (line: string) => void;
  /**
   * A send read succeeded on chain, with its withdrawal's recipient as signed (card helper-id-intents: the arming
   * account A a valid proof landed to is the gate's second path on POST /v1/intents). Never awaited; a throw is ignored.
   */
  onLanded?: (recipient: string) => void;
};

const no = (code: HelperWithdrawCode | "upstream", status = 400): WithdrawAnswer => ({ status, body: { error: { code } } });
const held = async (deps: WithdrawSendDeps) => {
  try {
    return tokenHeld(await deps.tokenStatus("lower")); // check 10's H for a withdrawal: the lower of the two finals
  } catch {
    return true;
  }
};

// ---- Checks 7-9 ----

/**
 * The newest final block's time in ms on the two providers: each one's final header.timestamp_nanosec (a decimal
 * string) / 10^6, the finals at most HEIGHT_SPREAD_MAX apart, the higher of the two times. Throws on anything else.
 */
export async function newestFinalMs(rpcs: readonly [Rpc, Rpc]): Promise<bigint> {
  const finals = await Promise.all(
    rpcs.map(async (r, i) => {
      const b = await r("block", { finality: "final" });
      const h = isObj(b) && isObj(b.header) ? b.header : {};
      const ns = decimal(h.timestamp_nanosec, 1n << 64n);
      if (typeof h.height !== "number" || !Number.isSafeInteger(h.height) || h.height <= 0 || ns === null) throw new FeeReadRefused(`rpc ${i}: not a final header with timestamp_nanosec`);
      return { height: BigInt(h.height), ms: ns / 1_000_000n };
    }),
  );
  const [a, b] = finals as [{ height: bigint; ms: bigint }, { height: bigint; ms: bigint }];
  const spread = a.height > b.height ? a.height - b.height : b.height - a.height;
  if (spread > HEIGHT_SPREAD_MAX) throw new FeeReadRefused(`final: the providers' finals stand ${spread} blocks apart, over ${HEIGHT_SPREAD_MAX}`);
  return a.ms > b.ms ? a.ms : b.ms;
}

/** An account read at one block on both providers: absent (UNKNOWN_ACCOUNT on both), or its NEAR and its keys. */
export type AccountRead = { kind: "absent" } | { kind: "account"; amount: bigint; keys: { public_key: string; permission: unknown }[] };

export type ChainReads = {
  registered: boolean;
  registerMin: bigint;
  finalMs: bigint;
  /** Check 5's views (rows 5, 6 and 9). */
  stateKnown: boolean;
  labelKnown: boolean;
  totals: { deposited: bigint; spent: bigint; returned: bigint };
  /** The recipient, read only for a request with fund_recipient true. */
  recipient?: AccountRead;
  /** Check 7b: the fee account on the token, or why it could not be read. */
  feeAccount: FeeRead;
  /** Check 8: the recipient's is_blocklisted on the token. */
  recipientListed: boolean;
};

/** Check 7b as read: the fee account's two views, or why they could not be read (a failed read holds). */
export type FeeRead = FeeAccount | { unread: string };
export { FEE_ACCOUNT_NOT_READY, feeAccountReady, readFeeAccount, type FeeAccount };

const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** Check 8's blocklist view of the recipient at block `b`, on both providers: exactly a boolean, else it throws. */
export async function readRecipientListed(rpcs: readonly [Rpc, Rpc], b: Block, token: string, recipient: string): Promise<boolean> {
  const listed = await viewAt(rpcs, b, token, "is_blocklisted", { account_id: recipient });
  if (typeof listed !== "boolean") throw new FeeReadRefused("is_blocklisted(recipient): not a boolean");
  return listed;
}

/**
 * Checks 7b and 8 again in the queue, at one fresh agreed block: null when the fee account reads ready and the
 * recipient is not blocklisted; "bad_recipient" for a blocklisted recipient; else check 7b's hold (its reads, or why
 * they could not be read: a failed read holds).
 */
export async function queueHold(rpcs: readonly [Rpc, Rpc], token: string, fee: string, recipient: string, now: () => number = Date.now): Promise<FeeRead | "bad_recipient" | null> {
  try {
    const b = await agreedBlock(rpcs, now);
    const [f, listed] = await Promise.all([readFeeAccount(rpcs, b, token, fee), readRecipientListed(rpcs, b, token, recipient)]);
    if (listed) return "bad_recipient";
    return feeAccountReady(f) ? null : f;
  } catch (e) {
    return { unread: why(e) };
  }
}

/**
 * One provider's view of `id` at block `b`: view_account and view_access_key_list, both answered at `b`. An absent
 * account reads as nearcore answers it: view_account UNKNOWN_ACCOUNT and an empty key list (read on FastNEAR and dRPC,
 * testnet and mainnet, 2026-11-02); any other mix is refused.
 */
async function accountOn(r: Rpc, i: number, b: Block, id: string): Promise<AccountRead> {
  const at = { block_id: Number(b.height), account_id: id };
  const ask = async (request_type: string) => {
    try {
      const a = await r("query", { request_type, ...at });
      if (!isObj(a) || a.block_height !== Number(b.height) || a.block_hash !== b.hash) throw new FeeReadRefused(`rpc ${i}: ${request_type} not answered at block ${b.height}`);
      return a;
    } catch (e) {
      if (e instanceof RpcError && e.cause_name === "UNKNOWN_ACCOUNT") return null;
      throw e;
    }
  };
  const [acc, list] = await Promise.all([ask("view_account"), ask("view_access_key_list")]);
  if (acc === null && list !== null && Array.isArray(list.keys) && list.keys.length === 0) return { kind: "absent" };
  const amount = acc === null ? null : decimal(acc.amount, U128);
  if (amount === null || list === null || !Array.isArray(list.keys)) throw new FeeReadRefused(`rpc ${i}: ${id} neither absent nor an account with a key list`);
  const keys = list.keys.map((k: unknown) => {
    if (!isObj(k) || typeof k.public_key !== "string" || !isObj(k.access_key)) throw new FeeReadRefused(`rpc ${i}: ${id}'s key list is malformed`);
    return { public_key: k.public_key, permission: k.access_key.permission };
  });
  return { kind: "account", amount, keys };
}

/** The account `id` at block `b`, the same on both providers. */
export async function accountAt(rpcs: readonly [Rpc, Rpc], b: Block, id: string): Promise<AccountRead> {
  const [x, y] = await Promise.all(rpcs.map((r, i) => accountOn(r, i, b, id)));
  const text = (a: AccountRead) => JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  if (text(x!) !== text(y!)) throw new FeeReadRefused(`${id} at block ${b.height}: the providers disagree`);
  return x!;
}

/**
 * Check 5's views, check 7's two views and the recipient (fund_recipient only) at one agreed final block, and check 9's
 * time, all on both providers, read at once.
 */
export async function readChecks(rpcs: readonly [Rpc, Rpc], vault: string, token: string, w: CheckedWithdraw, now: () => number = Date.now): Promise<ChainReads> {
  const [block, finalMs] = await Promise.all([agreedBlock(rpcs, now), newestFinalMs(rpcs)]);
  const [bal, bounds, stateKnown, labelKnown, totals, recipient, feeAccount, recipientListed] = await Promise.all([
    viewAt(rpcs, block, token, "storage_balance_of", { account_id: w.recipient }),
    viewAt(rpcs, block, token, "storage_balance_bounds", {}),
    viewAt(rpcs, block, vault, "is_known_state_root", { root: w.stateRoot.toString() }),
    viewAt(rpcs, block, vault, "is_known_label_root", { root: w.ASPRoot.toString() }),
    viewAt(rpcs, block, vault, "totals", {}),
    w.fund_recipient === true ? accountAt(rpcs, block, w.recipient) : Promise.resolve(undefined),
    // check 7b's own failure is kept and answered with its own log line; every other read's fails the whole read
    readFeeAccount(rpcs, block, token, w.fee_recipient).catch((e): FeeRead => ({ unread: why(e) })),
    readRecipientListed(rpcs, block, token, w.recipient),
  ]);
  if (bal !== null && !(isObj(bal) && decimal(bal.total, U128) !== null)) throw new FeeReadRefused("storage_balance_of: neither null nor a balance");
  const registerMin = isObj(bounds) ? decimal(bounds.min, U128) : null;
  if (registerMin === null) throw new FeeReadRefused("storage_balance_bounds: no u128 min");
  if (typeof stateKnown !== "boolean" || typeof labelKnown !== "boolean") throw new FeeReadRefused("is_known_*_root: not a boolean");
  const t = isObj(totals) ? { deposited: decimal(totals.deposited, U128), spent: decimal(totals.spent, U128), returned: decimal(totals.returned, U128) } : null;
  if (t === null || t.deposited === null || t.spent === null || t.returned === null) throw new FeeReadRefused("totals: not three u128");
  return { registered: bal !== null, registerMin, finalMs, stateKnown, labelKnown, totals: t as ChainReads["totals"], feeAccount, recipientListed, ...(recipient !== undefined && { recipient }) };
}

/** Check 5's rows 5, 6 and 9 on what was read; null when they pass. */
export function check5(w: CheckedWithdraw, r: ChainReads): HelperWithdrawCode | null {
  if (w.stateRoot === 0n || !r.stateKnown || !r.labelKnown) return "unknown_root";
  if (w.withdrawnValue > r.totals.deposited - r.totals.spent + r.totals.returned) return "bad_proof";
  return null;
}

/** A's own id key: the ed25519 key whose 32 bytes are A's implicit id. */
export const idKeyOf = (a: string): string => `ed25519:${base58(Buffer.from(a, "hex"))}`;

/**
 * fund_recipient true, until H3.7 funds A: null when A is an implicit account that exists with key list exactly
 * [A's own id key, full access] and holds at least A_store (carried with no Transfer); else recipient_refused.
 */
export function checkFunded(w: CheckedWithdraw, r: ChainReads): HelperWithdrawCode | null {
  if (w.fund_recipient !== true) return null;
  const a = r.recipient;
  if (!/^[0-9a-f]{64}$/.test(w.recipient) || a === undefined || a.kind !== "account") return "recipient_refused";
  const [k, ...more] = a.keys;
  if (k === undefined || more.length > 0 || k.public_key !== idKeyOf(w.recipient) || k.permission !== "FullAccess") return "recipient_refused";
  return a.amount >= A_STORE_YOCTO ? null : "recipient_refused";
}

/**
 * Checks 7, 8 and 9 on what was read, in that order; null when all pass. `stored`: a send of a stored withdrawal,
 * which also takes the minimum for a recipient registered since. `funds`: this request funds A first (120 s margin).
 */
export function checks7to9(w: CheckedWithdraw, vault: string, r: ChainReads, opts: { stored?: boolean; funds?: boolean } = {}): HelperWithdrawCode | null {
  const rd = w.register_deposit;
  const ok7 = r.registered ? rd === 0n || (opts.stored === true && rd === r.registerMin) : rd === r.registerMin;
  if (!ok7) return "register_deposit_wrong";
  for (const a of [w.recipient, w.fee_recipient]) if (a === vault || a === INTENTS) return "bad_recipient";
  if (r.recipientListed) return "bad_recipient";
  const margin = opts.funds === true ? FUND_MARGIN_MS : SEND_MARGIN_MS;
  if (BigInt(w.deadline_ms) < r.finalMs + margin) return "deadline_too_close";
  return null;
}

// ---- The carry ----

/** A claim that lost: its signed bytes are dropped, never sent, and the request answers the row's code. */
class ClaimLost extends Error {
  readonly code: "spent" | "in_flight" | "withdraw_failed";
  constructor(code: "spent" | "in_flight" | "withdraw_failed") {
    super(`claim: ${code}`);
    this.code = code;
  }
}

/** The withdraw call's JSON arguments: the request's withdrawal, proof and signals as received (check 1 kept them). */
export function withdrawArgs(w: CheckedWithdraw): string {
  return JSON.stringify({ withdrawal: w.withdrawal, proof: w.proof, public_signals: w.public_signals });
}

let turn = 0;

/** POST /v1/withdraw: checks 1-10, then one send. Reads that fail or disagree answer 503 upstream and send nothing. */
export async function carryWithdraw(request: unknown, deps: WithdrawSendDeps): Promise<WithdrawAnswer> {
  if (deps.relayers.length === 0) throw new Error("no relayer key");
  let w: CheckedWithdraw;
  try {
    const v = await checkWithdraw(request, deps.cfg, deps.reads);
    if (!v.ok) return no(v.code);
    w = v.withdraw;
  } catch (e) {
    if (e instanceof FeeReadRefused) return no("upstream", 503);
    throw e;
  }
  const nf = w.existingNullifierHash;
  const n = await checkNullifier(nf, { index: deps.index, store: deps.store });
  if (!n.ok) return no(n.code, n.code === "index_behind" ? 503 : 400);

  // check 5's row 12 (the leaves index, at the spends index's H) and the chain's reads, at once
  const leafCheck = async (): Promise<HelperWithdrawCode | "index_behind" | null> => {
    let h: bigint;
    try {
      h = await deps.index.finalHeight();
    } catch {
      return "index_behind";
    }
    if (!(await deps.leaves.reach(h))) return "index_behind";
    return deps.leaves.has(w.newCommitmentHash) || deps.leaves.count() >= TREE_CAPACITY ? "bad_proof" : null;
  };
  const [leaf, reads] = await Promise.all([leafCheck(), readChecks(deps.rpcs, deps.cfg.vault, deps.cfg.token, w, deps.now).catch(() => null)]);
  if (leaf === "index_behind") return no("index_behind", 503);
  if (reads === null) return no("upstream", 503);
  const c = check5(w, reads) ?? leaf ?? checks7to9(w, deps.cfg.vault, reads) ?? checkFunded(w, reads);
  if (c !== null) return no(c);
  const log = deps.log ?? ((line: string) => console.log(`helper: ${line}`));
  const feeHold = (f: FeeRead) => {
    log(`withdraw 503 relayer_low: ${FEE_ACCOUNT_NOT_READY} (${w.fee_recipient} on ${deps.cfg.token}: ${"unread" in f ? `not read (${f.unread})` : `registered ${f.registered}, blocklisted ${f.blocklisted}`})`);
    return no("relayer_low", 503);
  };
  if (await held(deps)) return no("token_halted", 503); // check 10 first: a halted token holds whatever 7b reads
  if ("unread" in reads.feeAccount || !feeAccountReady(reads.feeAccount)) return feeHold(reads.feeAccount);

  const relayer = deps.relayers[turn++ % deps.relayers.length]!;
  const deposit = vaultWithdrawYocto(w.register_deposit, w.relay_fee, true);
  let feeHeld: FeeRead | null = null;
  const action = { kind: "call" as const, receiver: deps.cfg.vault, method: "withdraw", args: withdrawArgs(w), gas: WITHDRAW_GAS, deposit };
  try {
    const out = await relayer.send<HelperWithdrawCode>(
      action,
      // the hold first, check 9's margin last: a hold that waits (check 10's wait for H, a 429 waited out) never spends
      // the margin it was checked against at the reads above
      async () => {
        if (await held(deps)) return "token_halted";
        const q = await queueHold(deps.rpcs, deps.cfg.token, w.fee_recipient, w.recipient, deps.now); // checks 7b and 8 again
        if (q === "bad_recipient") return "bad_recipient";
        feeHeld = q;
        if (feeHeld !== null) return "relayer_low";
        if ((await relayer.balance()) < withdrawFloor(deposit)) return "relayer_low";
        return BigInt(w.deadline_ms) < (await newestFinalMs(deps.rpcs)) + SEND_MARGIN_MS ? "deadline_too_close" : null;
      },
      (tx) => {
        const claim = deps.store.claim({ ...tx, nullifier: nullifierKey(nf), key: relayer.key, deadline_ms: w.deadline_ms });
        if (!claim.ok) throw new ClaimLost(claim.code);
      },
      { wait: false },
    );
    if (out.kind === "guarded" && feeHeld !== null) return feeHold(feeHeld);
    if (out.kind === "guarded") return no(out.code, out.code === "token_halted" || out.code === "relayer_low" ? 503 : 400);
    return { status: 200, body: { tx_hash: out.tx_hash, state: "submitted" } };
  } catch (e) {
    if (e instanceof ClaimLost) return no(e.code);
    return no("upstream", 503); // the key read or the store failed: nothing was sent
  }
}

// ---- The outcome rounds ----

/** What a send's outcome read means for its row, or null while it is not known. */
export function outcomeOf(out: TxOutcome, deadline_ms: number): Parameters<WithdrawSendStore["settle"]>[2] | null {
  if (out.kind === "dropped") return { kind: "never_applied" };
  if (out.kind !== "final") return null;
  const r = out.receipts[0];
  if (out.receipts.length !== 1 || r === undefined) return null;
  if (r.ok) return { kind: "succeeded" };
  // the vault's block_timestamp_ms() while r_w ran is E's time: a failure past deadline_ms is the deadline's
  if (r.ms === undefined) return null;
  return r.ms > BigInt(deadline_ms) ? { kind: "deadline" } : { kind: "failed", error: r.failure };
}

/** The spend's status in the vault's spends list at one final block on both providers, or null when not read. */
async function spendStatus(deps: WithdrawSendDeps, nf: bigint): Promise<string | null> {
  let i = deps.index.indexOf(nf);
  if (i === null && (await deps.index.reach(await deps.index.finalHeight()))) i = deps.index.indexOf(nf);
  if (i === null) return null;
  const block = await agreedBlock(deps.rpcs, deps.now ?? Date.now);
  const [row] = await pagesAt(deps.rpcs, deps.cfg.vault, "spends", block.height, i, 1);
  if (row === undefined || decimal(row.nullifier_hash, 1n << 256n) !== nf) throw new Error("spends: the row is not this nullifier's");
  return typeof row.status === "string" ? row.status : null;
}

/**
 * The withdrawal's recipient in one of our signed withdraw transactions (signer, key, nonce, receiver, block hash, one
 * FunctionCall: its method and its JSON args, withdrawArgs'), or null when the bytes are not that.
 */
export function recipientOfSigned(signedTx: string): string | null {
  try {
    const b = Buffer.from(signedTx, "base64");
    let at = 0;
    const str = () => {
      const n = b.readUInt32LE(at);
      const v = b.subarray(at + 4, at + 4 + n);
      if (v.length !== n) throw new Error("short");
      at += 4 + n;
      return v;
    };
    str(); // signer
    at += 1 + 32 + 8; // key type, public key, nonce
    str(); // receiver
    at += 32; // block hash
    if (b.readUInt32LE(at) !== 1) return null;
    at += 4;
    if (b[at] !== 2) return null; // FunctionCall
    at += 1;
    if (str().toString("utf8") !== "withdraw") return null;
    const args = JSON.parse(str().toString("utf8")) as { withdrawal?: { recipient?: unknown } };
    return typeof args.withdrawal?.recipient === "string" ? args.withdrawal.recipient : null;
  } catch {
    return null;
  }
}

/** One round: every open send resent and read, then every succeeded send settled. Errors keep a row for the next round. */
export async function outcomeRound(deps: WithdrawSendDeps): Promise<void> {
  const byKey = new Map(deps.relayers.map((r) => [r.key, r]));
  for (const nf of deps.store.open()) {
    try {
      const rec = deps.store.get(nf);
      if (rec === null || rec === "unreadable" || rec.outcome !== "open") continue;
      const relayer = byKey.get(rec.key);
      if (relayer === undefined) continue; // a key no longer served: its row stays open (H3.6 route 2)
      const o = outcomeOf(await relayer.resolve(rec, { resend: true, fromBlocks: true }), rec.deadline_ms);
      if (o !== null) deps.store.settle(nf, rec.tx_hash, o);
      if (o?.kind === "succeeded" && deps.onLanded !== undefined) {
        const to = recipientOfSigned(rec.signed_tx);
        if (to !== null) {
          try {
            deps.onLanded(to);
          } catch {
            // the outcome is recorded; a failed hook changes nothing
          }
        }
      }
    } catch {
      // kept: the next round reads again
    }
  }
  for (const nf of deps.store.toSettle()) {
    try {
      await settleOne(deps, nf, byKey);
    } catch {
      // kept
    }
  }
}

async function settleOne(deps: WithdrawSendDeps, nf: bigint, byKey: Map<string, Relayer>): Promise<void> {
  const rec = deps.store.get(nf);
  if (rec === null || rec === "unreadable" || rec.outcome !== "succeeded" || rec.settle?.done === true) return;
  let mine = rec.settle?.tx ?? null;
  if (rec.settle?.failed !== undefined) {
    if (rec.settle.failed.release >= deps.store.release) return; // failed on chain under this release: not signed again
    deps.store.setSettle(nf, null); // a higher release tries once more
    mine = null;
  }
  if (mine !== null) {
    const relayer = byKey.get(mine.key);
    if (relayer === undefined) return;
    const out = await relayer.resolve(mine, { resend: true, fromBlocks: true });
    if (out.kind === "unknown") return;
    if (out.kind === "final" && out.receipts.length === 1 && out.receipts[0]!.ok) return deps.store.setSettle(nf, { tx: mine, done: true });
    // settled by another caller; else a failure on chain is kept (this release signs no more), a dropped one signed again
    const s = await spendStatus(deps, nf);
    if (s === "settled") return deps.store.setSettle(nf, { tx: mine, done: true });
    if (out.kind === "final") {
      const error = out.receipts.find((r) => !r.ok)?.failure ?? "settle: not one successful receipt";
      return deps.store.setSettle(nf, { tx: mine, done: false, failed: { release: deps.store.release, error: error.slice(0, 2_000) } });
    }
    return deps.store.setSettle(nf, null);
  }
  const status = await spendStatus(deps, nf);
  if (status === "settled") return deps.store.setSettle(nf, { tx: null, done: true }); // another caller settled it (anyone may)
  if (status !== "paid" && status !== "refund_pending") return; // in_flight: its callback has not run yet
  const relayer = deps.relayers[turn++ % deps.relayers.length]!;
  await relayer.send<"relayer_low">(
    { kind: "call", receiver: deps.cfg.vault, method: "settle", args: JSON.stringify({ nullifier_hash: nf.toString() }), gas: SETTLE_GAS, deposit: status === "refund_pending" ? SETTLE_REFUND_ATTACH : 0n },
    async () => ((await relayer.balance()) < SETTLE_FLOOR_YOCTO ? "relayer_low" : null),
    (tx: TxRef) => deps.store.setSettle(nf, { tx: { ...tx, key: relayer.key }, done: false }),
    { wait: false },
  );
}

/** The rounds: one now (the restart's rebroadcast, before a request is taken), then every `everyMs`. Returns stop. */
export async function startOutcomeRounds(deps: WithdrawSendDeps, everyMs = OUTCOME_ROUND_MS): Promise<() => void> {
  await outcomeRound(deps);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = () => {
    timer = setTimeout(async () => {
      await outcomeRound(deps).catch(() => undefined);
      if (!stopped) loop();
    }, everyMs);
  };
  loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// ---- The host's configuration ----

/** The release number (index.ts: a whole number that only goes up, one per release), from the image or the host. */
export const RELEASE_ENV = "HELPER_RELEASE";
/** Per network: the release's vault account and the relayer account's full-access keys (comma-separated "ed25519:..."), the nonce lanes. */
export const SEND_ENV = {
  mainnet: ["WITHDRAW_VAULT_MAINNET", "WITHDRAW_RELAYER_KEYS_MAINNET"],
  testnet: ["WITHDRAW_VAULT_TESTNET", "WITHDRAW_RELAYER_KEYS_TESTNET"],
} as const;
/** A network's relayer keys: at most this many lanes (four full-access keys on the server, M:1044-1047). */
export const KEYS_MAX = 8;
/**
 * The one vault mainnet withdrawals and deposits are carried for, by the kit's rule (packages/wallet/test/
 * deposit-delegate.test.ts): the account_id of contracts/vault/deployments/mainnet-v1.json once the mainnet deploy writes
 * it, else mainnet-test.json's (card vault-mainnet-test); send.test.ts holds each case. Any other WITHDRAW_VAULT_MAINNET
 * or BIND_VAULT_MAINNET stops the helper at start, so a host's .env cannot point a mainnet sender at a vault the release
 * does not name. The commit that adds mainnet-v1.json changes it here, or its test fails.
 */
export const MAINNET_VAULT = "vault-test.confidential.unrlzd.near";

export type WithdrawSender = {
  /** POST /v1/withdraw for a parsed body: the network from its token; a token this relayer does not carry is bad_shape. */
  carry(body: unknown): Promise<WithdrawAnswer>;
  /** Card helper-id-intents: `cb` hears each mainnet withdrawal read succeeded, with its recipient (deps.onLanded). */
  onLanded?(cb: (recipient: string) => void): void;
  /**
   * At the helper's start: every carried network started now, so a restart resends its open sends and settles within
   * one round whether or not a request comes; a start that fails is tried again every OUTCOME_ROUND_MS.
   */
  warm(): void;
  stop(): void;
};

/**
 * The route's sender from the host's environment. A network is carried only when its fee quoter is set (fee.ts), and
 * its vault, its relayer keys, the release number and the store folder are all set; else its requests answer
 * bad_shape (check 1: not the vault's token); a mainnet vault other than MAINNET_VAULT stops the helper at start. Every name is read, set or not, so the deploy gate sees them all. On
 * the first request (and again after a failure) it reads the vault's config() on both providers (its scope, and its
 * asset equal to the token), opens the network's stores under HELPER_STORE_DIR, starts its relayers and runs the
 * first outcome round (the restart's rebroadcast) before it takes the request; then a round every OUTCOME_ROUND_MS.
 */
export function withdrawSenderFromEnv(
  env: Record<string, string | undefined>,
  fee: FeeQuoter,
  status: Partial<Record<FeeNetwork, (at: HoldAt) => Promise<TokenStatus>>> = statusesOf(tokenWatchesFromEnv(env)),
  fetchFn: typeof fetch = fetch,
  // the one mainnet vault carried: the release's pin, never read from the host's environment (a test passes its own)
  mainnetVault: string = MAINNET_VAULT,
): WithdrawSender {
  const release = env[RELEASE_ENV] ?? "";
  const storeDir = env[STORE_ENV] ?? "";
  const set = Object.fromEntries((Object.keys(SEND_ENV) as FeeNetwork[]).map((n) => [n, SEND_ENV[n].map((k) => env[k] ?? "")])) as Record<FeeNetwork, string[]>;
  const relayerOf = Object.fromEntries((Object.keys(RELAYER_ENV) as FeeNetwork[]).map((n) => [n, env[RELAYER_ENV[n][0]] ?? ""])) as Record<FeeNetwork, string>;
  const feeTo = Object.fromEntries((Object.keys(RELAYER_ENV) as FeeNetwork[]).map((n) => [n, env[RELAYER_ENV[n][1]] ?? ""])) as Record<FeeNetwork, string>;
  const mainnet = readUrls(env, "mainnet");
  const testnet = TESTNET_RPCS.map(({ env: k, fallback }) => env[k] || fallback);
  const urls: Record<FeeNetwork, readonly string[]> = { mainnet, testnet };

  type Net = { network: FeeNetwork; vault: string; keys: string[] };
  const nets = new Map<string, Net>();
  for (const n of Object.keys(SEND_ENV) as FeeNetwork[]) {
    const [vault, keyList] = set[n];
    if (vault === "" && keyList === "") continue;
    const keys = keyList!.split(",").filter((k) => k !== "");
    if (!isAccountId(vault) || keys.length === 0 || keys.length > KEYS_MAX || !keys.every((k) => /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(k))) throw new Error(`${SEND_ENV[n].join(" and ")} must be a NEAR account id and 1 to ${KEYS_MAX} ed25519 keys`);
    if (n === "mainnet" && vault !== mainnetVault) throw new Error(`${SEND_ENV.mainnet[0]} must be ${mainnetVault}, the vault of the mainnet deploy record`);
    if (!/^[1-9][0-9]{0,8}$/.test(release)) throw new Error(`${RELEASE_ENV} must be a whole number, 1 or more, to carry withdrawals`);
    if (storeDir === "") throw new Error(`${STORE_ENV} must be set to carry withdrawals`);
    if (!isAccountId(relayerOf[n]) || !isAccountId(feeTo[n])) throw new Error(`${RELAYER_ENV[n].join(" and ")} must be set to carry withdrawals`);
    for (const k of keys) relayerKey(k); // a key that does not parse stops the helper at start, never at a request
    nets.set(TOKENS[n], { network: n, vault: vault!, keys });
  }

  const ready = new Map<FeeNetwork, Promise<WithdrawSendDeps>>();
  const landed: ((recipient: string) => void)[] = [];
  const stops: (() => void)[] = [];
  const init = async (net: Net): Promise<WithdrawSendDeps> => {
    const rpcs = urls[net.network].map((u) => nearRpc(u, fetchFn, RPC_TIMEOUT_MS)) as unknown as readonly [Rpc, Rpc];
    const block = await agreedBlock(rpcs, Date.now);
    const c = await viewAt(rpcs, block, net.vault, "config", {});
    const scope = isObj(c) ? decimal(c.scope, 1n << 256n) : null;
    if (!isObj(c) || scope === null || c.asset !== TOKENS[net.network]) throw new Error("the vault's config() names another token or no scope");
    const nonces = createFileStore(join(storeDir, `withdraw-keys-${net.network}`));
    const opened: { close(): void }[] = [nonces];
    // a start that fails after the stores open closes them, so the next try can take their locks again
    try {
      const store = createWithdrawSendStore(join(storeDir, `withdraw-send-${net.network}`), { release: Number(release), keys: nonces });
      opened.push(store);
      const relayers = await Promise.all(net.keys.map((k) => startRelayer(rpcs, rpcs[0], relayerOf[net.network], k, net.vault, nonces)));
      const watch = status[net.network];
      const deps: WithdrawSendDeps = {
        cfg: { vault: net.vault, token: TOKENS[net.network], scope, feeRecipient: feeTo[net.network] },
        rpcs,
        reads: fee.reads(net.network),
        index: createSpendsIndex(rpcs, net.vault),
        leaves: createLeavesIndex(rpcs, net.vault),
        store,
        relayers,
        // no watch for this network's token: held (token_halted), as the watch holds while it is not caught up
        tokenStatus: watch ?? (async () => ({ token: TOKENS[net.network], caught_up: false, halted: null, vault_blocked: null, code_hash_ok: null, code_hash: "", block_height: 0, last_event: null })),
        // mainnet only: intents.near, where an arming account's intents go, is a mainnet contract
        ...(net.network === "mainnet" && { onLanded: (to: string) => landed.forEach((cb) => cb(to)) }),
      };
      stops.push(await startOutcomeRounds(deps));
      return deps;
    } catch (e) {
      for (const s of opened.reverse()) s.close();
      throw e;
    }
  };
  const started = (net: Net): Promise<WithdrawSendDeps> => {
    let p = ready.get(net.network);
    if (p === undefined) {
      p = init(net);
      ready.set(net.network, p);
      p.catch(() => ready.delete(net.network)); // the next request, or the next warm try, starts it again
    }
    return p;
  };
  let stopped = false;
  const warmNet = (net: Net) =>
    started(net).catch(() => {
      if (!stopped) setTimeout(() => warmNet(net), OUTCOME_ROUND_MS).unref();
    });
  return {
    onLanded: (cb) => void landed.push(cb),
    async carry(body) {
      const token = isObj(body) ? body.token : undefined;
      const net = typeof token === "string" ? nets.get(token) : undefined;
      if (net === undefined) return no("bad_shape");
      const p = started(net);
      let deps: WithdrawSendDeps;
      try {
        deps = await p;
      } catch {
        return no("upstream", 503);
      }
      return carryWithdraw(body, deps);
    },
    warm: () => nets.forEach((net) => void warmNet(net)),
    stop: () => {
      stopped = true;
      stops.forEach((s) => s());
    },
  };
}
