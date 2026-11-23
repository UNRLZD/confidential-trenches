// POST /v1/bind's onward move (card relayer-onward-move): a fresh NEAR id A's one move of its USDC to a 1Click NEAR
// deposit address our helper quoted, carried as A's NEP-366 delegate, paying gas only. The v2 move pays the deposit
// address by a plain transfer (1Click's depositType ORIGIN_CHAIN), so A never calls intents.near and no money rests
// there (the vault refuses intents.near as a recipient, contracts/vault/src/withdraw.rs).
//
// The delegate is the kit's plain shape (helper/v1.ts HelperBindPlain): one FunctionCall TOKEN.ft_transfer({receiver_id,
// amount}), 1 yocto, the release's USDC its receiver_id. No storage_deposit rides in it: a fresh deposit address is no
// account and is not registered on USDC (storage_balance_of null on two providers, read 23 Nov 2026 09:33Z for
// 96ff33ac9804408f58c3cf75410226bfa50ffb8e8ac4a08e0f902f81006efbad), and A holds only its own record's storage, so the
// relayer registers the address before the send (intents/carry.ts, as its 9b does), and the withdrawal's fee counts it
// (withdraw/fee.ts).
//
// The checks here, in the kit's HELPER_BIND_ONWARD_CODES order, read the store's gate and quote record and two-RPC
// chain reads only; the ones that need the store's per-signer record (sender_struck, in_flight, the cap) and the
// registration, the hold, the gas account and the send are intents/carry.ts onward's:
//   1-3. checks.ts delegateHead: bad_shape, bad_signature, no_account, bad_key, bad_nonce;
//   id_not_ours: A is not an id our helper saw paid (records.ts: a withdrawal of ours landed to it, onArmed);
//   not_paid: A holds no USDC yet (the device sends the same signed bytes again while max_block_height is ahead);
//   expired: max_block_height not ahead of the final height, or over 600 blocks ahead;
//   bad_shape: not exactly one FunctionCall ft_transfer;
//   token_not_accepted: receiver_id not the release's USDC;
//   deposit_not_1_yocto; gas_too_high: over ONWARD_GAS_CAP;
//   bad_msg: args other than exactly {receiver_id, amount} as JSON.stringify writes them (a memo included);
//   not_helper_quote: the receiver is not the deposit address of our live quote record with depositType ORIGIN_CHAIN,
//     refundTo A and refundType ORIGIN_CHAIN;
//   bad_receiver: the receiver, or the quote's recipient, is the vault, intents.near or the relayer, or the quote
//     delivers into an intents.near balance (recipientType other than DESTINATION_CHAIN: the DAO that runs intents.near
//     can freeze or move a balance held there, so the move's money never rests there);
//   amount_above_balance; amount_not_whole: the amount is not A's whole USDC (A moves everything it holds, once).
import { HELPER_BIND_ONWARD_CODES } from "@blindfill/kit";
import { delegateHead, EXPIRY_MAX_BLOCKS, isAccountId, type BindReads } from "./checks.ts";
import type { QuoteRecord } from "../intents/records.ts";

export type OnwardCode = (typeof HELPER_BIND_ONWARD_CODES)[number];
/** HELPER_BIND_ONWARD_CODES, in H3.7 item 2's order. */
export const ONWARD_CODES = HELPER_BIND_ONWARD_CODES;
/** The token's method the move calls. */
export const ONWARD_METHOD = "ft_transfer";
/** A's relayed call's gas cap: the 100 Tgas the withdrawal's fee prices it at (withdraw/fee.ts FEE_G_ARM). */
export const ONWARD_GAS_CAP = 100_000_000_000_000n;
/** The one recipientType the move's quote may name: delivered on the destination chain, never an intents.near balance. */
export const ONWARD_RECIPIENT_TYPE = "DESTINATION_CHAIN";
/** intents.near: never the move's receiver (the move pays 1Click's deposit address, never an intents balance). */
export const ONWARD_NEVER = "intents.near";

export type OnwardConfig = {
  /** The release's USDC on NEAR mainnet. */
  token: string;
  /** The release's vault. */
  vault: string;
  /** The relayer's gas account (bind.<ours>.near). */
  relayer: string;
};

/** The intents store's gate and quote records (records.ts), read with no chain read. */
export type OnwardGate = {
  seen(account: string): boolean;
  quote(depositAddress: string): QuoteRecord | null;
};

/** A move that passed every check here. */
export type OnwardMove = {
  sender: string;
  nonce: bigint;
  max_block_height: bigint;
  /** The 1Click deposit address. */
  receiver: string;
  amount: bigint;
  /** The SignedDelegateAction's bytes, carried byte for byte. */
  signed_delegate: Uint8Array;
};

export type OnwardVerdict = { ok: true; move: OnwardMove } | { ok: false; code: OnwardCode; why: string };

const DEC = /^[1-9][0-9]{0,38}$/;

/** The args as an object, or null: UTF-8 JSON of one object. */
function argsOf(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The move's shape, from its own bytes with no read (bad_shape heads the kit's list): exactly one FunctionCall
 * ft_transfer whose args are one JSON object, its amount, when a string, a u128 decimal above 0.
 */
function shapeOf(d: { actions: readonly { kind: string; method_name?: string; args?: Uint8Array }[] }): string | null {
  if (d.actions.length !== 1) return "actions: not exactly one";
  const act = d.actions[0]!;
  if (act.kind !== "FunctionCall" || act.method_name !== ONWARD_METHOD || act.args === undefined) return "action: not one ft_transfer";
  const args = argsOf(act.args);
  if (args === null) return "args: not one JSON object";
  const amt = args.amount;
  if (typeof amt === "string" && (!DEC.test(amt) || BigInt(amt) >= 1n << 128n)) return "args.amount: not a u128 decimal above 0";
  return null;
}

/** The onward checks of `request` (a parsed body); a read that fails or disagrees throws, and nothing is sent. */
export async function checkOnward(request: unknown, cfg: OnwardConfig, reads: Pick<BindReads, "accessKey" | "finalHeight" | "ftBalance">, gate: OnwardGate, now: () => number = Date.now): Promise<OnwardVerdict> {
  const no = (code: OnwardCode, why: string): OnwardVerdict => ({ ok: false, code, why });
  // 1-3. The head: decoding and the move's shape (no read), the signature, the sender and its key's nonce (codes in
  // this list's own order)
  const head = await delegateHead(request, reads, shapeOf);
  if (!head.ok) return no(head.code as OnwardCode, head.why);
  const { d, bytes, sender: a, final } = head;
  const act = d.actions[0]!;
  if (act.kind !== "FunctionCall") return no("bad_shape", "action: not one ft_transfer"); // shapeOf held it; the type's narrowing
  const { receiver_id: to, amount: amt } = argsOf(act.args) as { receiver_id: unknown; amount: unknown };

  // the gate, before any read of A's money
  if (!gate.seen(a)) return no("id_not_ours", "sender_id: no withdrawal of ours paid it");
  const balance = await reads.ftBalance(a);
  if (balance === 0n) return no("not_paid", "the sender holds no USDC yet");

  if (d.max_block_height <= final) return no("expired", "max_block_height: not ahead of the final height");
  if (d.max_block_height - final > EXPIRY_MAX_BLOCKS) return no("expired", "max_block_height: over 600 blocks ahead");

  if (d.receiver_id !== cfg.token) return no("token_not_accepted", "receiver_id: not the release's USDC");
  if (act.deposit !== 1n) return no("deposit_not_1_yocto", "deposit: not 1 yocto");
  if (act.gas > ONWARD_GAS_CAP) return no("gas_too_high", "gas: over 100 Tgas");

  // exactly {receiver_id, amount}, written as JSON.stringify writes it: no memo, no other key, no escape or space
  if (typeof to !== "string" || typeof amt !== "string" || new TextDecoder().decode(act.args) !== JSON.stringify({ receiver_id: to, amount: amt })) return no("bad_msg", "args: not exactly {receiver_id, amount}");

  const q = gate.quote(to);
  if (q === null || q.deposit_type !== "ORIGIN_CHAIN" || q.refund_to !== a || q.refund_type !== "ORIGIN_CHAIN" || q.deadline_ms <= now()) return no("not_helper_quote", "receiver: not our live ORIGIN_CHAIN quote refunding to the sender");
  const never = new Set([cfg.vault, cfg.relayer, ONWARD_NEVER]);
  if (!isAccountId(to) || never.has(to) || never.has(q.recipient)) return no("bad_receiver", "receiver: the vault, intents.near or ours");
  if (q.recipient_type !== ONWARD_RECIPIENT_TYPE) return no("bad_receiver", "the quote delivers into an intents.near balance");

  const amount = BigInt(amt);
  if (amount > balance) return no("amount_above_balance", "amount: over the sender's balance");
  if (amount < balance) return no("amount_not_whole", "amount: not the sender's whole USDC");
  return { ok: true, move: { sender: a, nonce: d.nonce, max_block_height: d.max_block_height, receiver: to, amount, signed_delegate: bytes } };
}

/** Whether a decoded delegate is the onward kind: its one action is the token's ft_transfer (every other kind is the deposit carry's). */
export const isOnward = (actions: readonly { kind: string; method_name?: string }[]): boolean => actions.length === 1 && actions[0]!.kind === "FunctionCall" && actions[0]!.method_name === ONWARD_METHOD;
