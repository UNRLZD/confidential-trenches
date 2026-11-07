// The signing page's rules for the money a one-time id holds and for W's return (card signpage-refund-kinds;
// docs/plan1/wallet.md §2.8 at research 1476ae8: the refund move and V's move row W:914, the return row W:922, the
// withdraw-from-a-one-time-id row W:928, the ft_withdraw-out-of-intents.near row W:930; tests WU-05 W:1067; row W4.4
// W:1140). The helper's side of the same intents is markets.md H4.3 "The ids' intents on /v1/intents" (l.1922-1975):
// every intent that row refuses is refused here too, before anything is signed. Every input but the device's own is
// hostile: the app's request, the 1Click answer, the helper's builds and every RPC answer. A field is checked only
// from the signed bytes, from a signature under the pinned 1Click keys (the kit's checkOneClickQuote), or from the
// device's own reads on two RPCs, which must agree; never from a reply of our servers. A refusal is "not_allowed" with
// nothing signed; `rule` names the field for the device's own log.
//
// - A quote (refund move or V's move, a withdraw from an id to another chain, a return): the device's own 1Click
//   request, live only (a dry answer's signature does not cover its deposit address, D4), with the recipient, refund
//   and deposit types the row names, its slippage at most the deposit quote's own (DEPOSIT_QUOTE_SLIPPAGE_BPS, which
//   the floors and the price reads' agreement both use), then the kit's one check (signature, echo, signed deadline,
//   fresh timestamp, floors; MIN_DEPOSIT when the output goes into the vault).
// - An id's intent (raw_ed25519, signed over the payload's UTF-8 bytes; near/intents 16d04f6, read for
//   proofs/g1-arm-swap/intent.mjs): exactly one intent, in one spelling (canonical JSON, the five keys in order),
//   signer_id the id, verifying_contract intents.near, deadline the lower of the two RPCs' final-block times + 120 s,
//   a V1 versioned nonce whose deadline is the intent's, and a fresh intent for the same money only once the earlier
//   one's deadline has passed on both RPCs (intents.near nonces are not sequential: the deadline keeps two from both
//   landing). The caller always says which: the earlier deadline, or null when there is none.
//   - transfer (the refund move, V's move, and a withdraw from inside intents.near to another chain): exactly one
//     tokens entry, the quote's origin asset, for exactly the quote's signed amount in, to the quote's signed deposit
//     address; at most what the id holds there (less one base unit for a withdraw, so restore still finds the id);
//   - ft_withdraw (a withdraw from inside intents.near to a typed NEAR account): the token the id holds there, one of
//     the USDC the deposit path takes (FT_WITHDRAW_TOKENS), its code hash the one pinned for it, read on two RPCs; to
//     the typed account, never the vault, intents.near or a listed token; a named account must exist on two RPCs; the
//     receiver's registration read on two RPCs must agree; no memo, msg or storage_deposit; at most what the id holds
//     less one base unit.
//   A withdraw (both kinds) is signed only while the id's key list reads exactly its own key, or no account at all,
//   on two RPCs (W:928).
// - W's return send: only from a W whose arm is the device's own withdrawal; one native send of exactly the quote's
//   signed amount in to its signed deposit address, within W's balance less the fee, nothing else in the transaction
//   (Solana: one System transfer, W the only signer; EVM: one type 2 send with no data).
//
// Each signer below signs only a payload a check passed, as the check read it (a checked-payload WeakMap per kind, as
// the deposit and pool kinds do): a copy, a byte or field changed after the check, or another key is refused
// "unchecked" or "key". One ask gives one signature: a checked quote passes one intent or one send, and a checked
// payload signs once; a second needs a fresh quote (and, for an intent, the first one's deadline).
//
// Not here (named in the card's hand-off): the on-token branch of the withdraw from an id (the plain ft_transfer, the
// onward delegate into intents.near, the self-submit transaction and its registration), an arming account A's moves
// (card signpage-arming-kinds), a return from a NEAR W, the reads themselves and the postMessage wiring.
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64 } from "@scure/base";
import { checkOneClickQuote, type OneClickCheckOptions, type OneClickChecked, type OneClickRequest } from "../../../kit/src/checks/oneclick.ts";
import { SOLANA_MAX_TX_BYTES, solanaDecodeMessage, solanaResolveKeys } from "../../../kit/src/checks/solana/message.ts";
import { SOLANA_SYSTEM_PROGRAM } from "../../../kit/src/checks/solana/checks.ts";
import { NEAR_NETWORKS, type NearNetwork } from "../../../kit/src/near/networks.ts";
import { VAULT_TOKEN_CODE_HASH } from "../../../kit/src/vault/shapes.ts";
import { DEPOSIT_QUOTE_SLIPPAGE_BPS } from "../../../wallet/src/deposit/quote.ts";
import { EVM_CHAIN_IDS } from "../../../wallet/src/pool/evm.ts";
import { INTENTS, addressForm } from "../withdraw/checks.ts";
import { DEPOSIT_DESTINATION_ASSET } from "./deposit.ts";
import { EVM_ADDRESS, SOL_KEY } from "./pool.ts";

/** An id's intent deadline: the lower of the two RPCs' final-block times + this (W:914). */
export const ID_INTENT_WINDOW_MS = 120_000;
/** intents.near's V1 versioned nonce: magic 5628f6c6, version 0 (near/intents 16d04f6 nonce/versioned.rs:9-23). */
export const VERSIONED_NONCE_V1 = Uint8Array.of(0x56, 0x28, 0xf6, 0xc6, 0);
/** The native coin of each chain a W returns from, as 1Click names it: SOL (a recorded 1Click answer,
 *  proofs/g1-arm-swap/armtime.answers.json:54), ETH on Base and on Robinhood (GET /v0/tokens, research
 *  docs/research/chains-bnb-robinhood-tron.md:158 and :427). */
export const RETURN_NATIVE: Readonly<Record<ReturnChain, string>> = Object.freeze({ solana: "nep141:sol.omft.near", base: "nep141:base.omft.near", robinhood: "nep141:hood.omft.near" });
export type ReturnChain = "solana" | "base" | "robinhood";
/** RETURN_NATIVE's omft accounts (sol.omft.near, base.omft.near, hood.omft.near): token contracts, so never a typed
 *  ft_withdraw receiver, where the money would sit on the token's own account. */
const RETURN_NATIVE_TOKENS: ReadonlySet<string> = new Set(Object.values(RETURN_NATIVE).map((a) => a.slice("nep141:".length)));
/**
 * The tokens an id can hold inside intents.near and take out by ft_withdraw (W:930: "token = the asset it holds
 * there"): every USDC the deposit path takes (rules/deposit-dry.ts DEPOSIT_ASSET_CHAINS, the kit's ONECLICK_USDC_ASSETS),
 * a refund under U landing in the asset the deposit came in. Each maps to its code hash: NEAR USDC's is the vault's pin;
 * the two omft tokens' were read 2026-11-07T12:24Z by view_account at final on free.rpc.fastnear.com (FastNear) and
 * near.drpc.org (dRPC), two operators (blocks 223465873-223465875), the two equal. A token upgraded since reads another hash, and
 * nothing is signed until the release pins it.
 */
export const FT_WITHDRAW_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  [NEAR_NETWORKS.mainnet.usdc]: VAULT_TOKEN_CODE_HASH,
  "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near": "Ba6uZKxsuRPW5X7XVQrSnYEYScEjFLJLMqMWvZ1aS3tC", // gitleaks:allow (a public code hash)
  "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": "2VUeqHTx9sk2AjDrs88HazLqS6LUgVQorjWcacotNCDP", // gitleaks:allow (a public code hash)
});
/** A plain EVM send's gas, and the most a Nitro (Robinhood) send's own estimate may be (rules/pool.ts's onward bounds). */
export const RETURN_EVM_GAS = 21_000n;
export const RETURN_EVM_GAS_MAX = 100_000n;

/** A refusal: the answer is "not_allowed"; `rule` names the field for the device's own log, never the app's. */
export class RefundRuleRefused extends Error {
  readonly code = "not_allowed";
  readonly rule: string;
  constructor(rule: string) {
    super(`refund-kind request not allowed: ${rule}`);
    this.name = "RefundRuleRefused";
    this.rule = rule;
  }
}
const refuse = (rule: string): never => {
  throw new RefundRuleRefused(rule);
};

const IMPLICIT = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const U128 = 1n << 128n;
const U256 = 1n << 256n;
const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysExactly = (o: Record<string, unknown>, ks: readonly string[]): boolean => Object.keys(o).join() === ks.join();
const lower = (s: string): string => s.toLowerCase();
/** Two RPCs' answers to one read: they must agree, and each must be what `ok` allows; else no read at all. */
const agreed = <T>(pair: readonly [T, T] | undefined, ok: (x: unknown) => boolean, rule = "reads"): T => {
  if (!Array.isArray(pair) || pair.length !== 2 || !ok(pair[0]) || pair[0] !== pair[1]) return refuse(rule);
  return pair[0];
};
const isU = (x: unknown): x is bigint => typeof x === "bigint" && x >= 0n && x < U256;

// ---------- the one-time id ----------

/** A one-time id the device derived (wallet.md:64): U_{s,i}, R_{c,l,j} or V_{l,j}, its 64-hex id its own key. */
export interface OneTimeId {
  role: "U" | "R" | "V";
  id: string;
  publicKey: Uint8Array;
}
const idOf = (s: OneTimeId): Readonly<OneTimeId> => {
  if (!isObj(s) || !["U", "R", "V"].includes(s.role as string)) return refuse("signer");
  if (!(s.publicKey instanceof Uint8Array) || s.publicKey.length !== 32 || typeof s.id !== "string" || !IMPLICIT.test(s.id) || s.id !== hexOf(s.publicKey)) return refuse("signer");
  return Object.freeze({ role: s.role, id: s.id, publicKey: Uint8Array.from(s.publicKey) });
};

// ---------- the quotes ----------

type QuoteKind = "refund" | "withdraw" | "return";
/** What a quote check read for the step after it: the signed deposit address, amount in and deadline, the origin. */
type QuoteRead = { readonly kind: QuoteKind; readonly signer: string; readonly origin: string; readonly depositAddress: string; readonly amountIn: bigint; readonly deadlineMs: number; readonly chain?: ReturnChain };
// every quote a check passed, by identity, with what the check read: an intent or a send is checked only against these
const QUOTES = new WeakMap<object, QuoteRead>();
/** A checked quote: the kit's result, frozen. Only the object a check returned is known to the steps after it. */
export type RefundQuote = Readonly<OneClickChecked>;

const QUOTE_KEYS = new Set(["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline", "quoteWaitingTimeMs", "referral"]);
/** The request read once into a plain copy: the rule and the kit's echo see one request, whatever getters it has. */
const requestOf = (request: OneClickRequest): OneClickRequest => {
  if (!isObj(request)) return refuse("request");
  const req = { ...request } as OneClickRequest;
  if (Object.keys(req).some((k) => !QUOTE_KEYS.has(k))) return refuse("request");
  // live only: the next step pays the signed deposit address, which a dry answer leaves unsigned (D4)
  if (req.dry !== false) return refuse("dry");
  if (req.swapType !== "EXACT_INPUT") return refuse("swapType");
  // the floors and the two price reads' agreement both take this slippage: at most the deposit quote's own
  if (!Number.isInteger(req.slippageTolerance) || req.slippageTolerance < 0 || req.slippageTolerance > DEPOSIT_QUOTE_SLIPPAGE_BPS) return refuse("slippage");
  return req;
};
const passQuote = (checked: OneClickChecked, read: Omit<QuoteRead, "depositAddress" | "amountIn" | "deadlineMs">): RefundQuote => {
  if (typeof checked.depositAddress !== "string" || typeof checked.deadline !== "string") return refuse("live");
  const out = Object.freeze({ ...checked });
  QUOTES.set(out, Object.freeze({ ...read, depositAddress: checked.depositAddress, amountIn: checked.amountIn, deadlineMs: Date.parse(checked.deadline) }));
  return out;
};
const quoteRead = (q: RefundQuote, kind: QuoteKind): QuoteRead => {
  const r = isObj(q) ? QUOTES.get(q) : undefined;
  if (!r || r.kind !== kind) return refuse("unchecked");
  return r;
};

export interface RefundQuoteContext {
  network: NearNetwork;
  /** U (the refund move) or V_{l,j} (V's move), derived on the device. */
  signer: OneTimeId;
  /** The one asset the id holds inside intents.near, its 1Click id ("nep141:<token>"). */
  origin: string;
  /** The kit's check options but the output's place: a refund move's output goes into the vault. */
  check: Omit<OneClickCheckOptions, "intoVault">;
}

/** The refund move (§2.4 point 8) and V's move (§2.5), W:914: origin the id's one asset inside intents.near
 *  (depositType INTENTS), destination the vault's asset, delivered to the id itself on the token (recipient the id,
 *  DESTINATION_CHAIN), refunded to the id inside intents.near (refundTo the id, INTENTS). */
export function checkRefundMoveQuote(request: OneClickRequest, answer: unknown, ctx: RefundQuoteContext): RefundQuote {
  const s = idOf(ctx.signer);
  if (s.role === "R") return refuse("signer"); // a return's refund goes to W on its own chain, never under R
  if (!Object.hasOwn(NEAR_NETWORKS, ctx.network) || ctx.network !== "mainnet") return refuse("network");
  const req = requestOf(request);
  if (typeof ctx.origin !== "string" || req.originAsset !== ctx.origin) return refuse("originAsset");
  if (req.depositType !== "INTENTS") return refuse("depositType");
  if (req.destinationAsset !== DEPOSIT_DESTINATION_ASSET) return refuse("destinationAsset");
  if (req.recipient !== s.id) return refuse("recipient");
  if (req.recipientType !== "DESTINATION_CHAIN") return refuse("recipientType");
  if (req.refundTo !== s.id) return refuse("refundTo");
  if (req.refundType !== "INTENTS") return refuse("refundType");
  const checked = checkOneClickQuote(req, answer, { ...ctx.check, intoVault: true });
  return passQuote(checked, { kind: "refund", signer: s.id, origin: req.originAsset });
}

export interface IdWithdrawQuoteContext {
  network: NearNetwork;
  signer: OneTimeId;
  origin: string;
  /** The address typed by the user on SIGN_HOST's top-level withdraw form, on the destination chain. */
  typed: string;
  check: Omit<OneClickCheckOptions, "intoVault">;
}

/** A withdraw from inside intents.near to another chain (W:928): the same quote as a deposit's but with depositType
 *  INTENTS, recipient the typed address (DESTINATION_CHAIN) and refundTo the id (INTENTS). Never into the vault. */
export function checkIdWithdrawQuote(request: OneClickRequest, answer: unknown, ctx: IdWithdrawQuoteContext): RefundQuote {
  const s = idOf(ctx.signer);
  if (!Object.hasOwn(NEAR_NETWORKS, ctx.network) || ctx.network !== "mainnet") return refuse("network");
  const net = NEAR_NETWORKS[ctx.network];
  const req = requestOf(request);
  if (typeof ctx.origin !== "string" || req.originAsset !== ctx.origin) return refuse("originAsset");
  if (req.depositType !== "INTENTS") return refuse("depositType");
  // to another chain: the vault's own asset on NEAR goes by ft_withdraw, and nothing here ever pays the vault
  if (req.destinationAsset === DEPOSIT_DESTINATION_ASSET) return refuse("destinationAsset");
  const typed = ctx.typed;
  if (typeof typed !== "string" || typed === "" || typed !== typed.trim() || typed === s.id || typed === INTENTS || typed === net.usdc || (net.vault !== null && typed === net.vault)) return refuse("typed");
  if (req.recipient !== typed) return refuse("recipient");
  if (req.recipientType !== "DESTINATION_CHAIN") return refuse("recipientType");
  if (req.refundTo !== s.id) return refuse("refundTo");
  if (req.refundType !== "INTENTS") return refuse("refundType");
  const checked = checkOneClickQuote(req, answer, { ...ctx.check, intoVault: false });
  return passQuote(checked, { kind: "withdraw", signer: s.id, origin: req.originAsset });
}

export interface ReturnQuoteContext {
  chain: ReturnChain;
  /** W, the fresh wallet the device derived, and whether its arm (l, j) is the device's own withdrawal (§2.3). */
  wallet: string;
  ownArm: boolean;
  /** R_{c,l,j} of this wallet, derived on the device. */
  returnId: OneTimeId;
  check: Omit<OneClickCheckOptions, "intoVault">;
}

/** The return (§2.5), W:922: from W's native coin on its own chain (depositType ORIGIN_CHAIN), destination the vault's
 *  asset delivered to R_{c,l,j} on the token (DESTINATION_CHAIN), refunded to W on its own chain (ORIGIN_CHAIN). */
export function checkReturnQuote(request: OneClickRequest, answer: unknown, ctx: ReturnQuoteContext): RefundQuote {
  if (ctx.ownArm !== true) return refuse("own_arm");
  const chain = ctx.chain;
  if (!Object.hasOwn(RETURN_NATIVE, chain)) return refuse("chain");
  const w = ctx.wallet;
  if (typeof w !== "string" || !(chain === "solana" ? SOL_KEY(w) : EVM_ADDRESS.test(w))) return refuse("wallet");
  const r = idOf(ctx.returnId);
  if (r.role !== "R") return refuse("recipient");
  const req = requestOf(request);
  if (req.originAsset !== RETURN_NATIVE[chain]) return refuse("originAsset");
  if (req.depositType !== "ORIGIN_CHAIN") return refuse("depositType");
  if (req.destinationAsset !== DEPOSIT_DESTINATION_ASSET) return refuse("destinationAsset");
  if (req.recipient !== r.id) return refuse("recipient");
  if (req.recipientType !== "DESTINATION_CHAIN") return refuse("recipientType");
  if (req.refundTo !== w) return refuse("refundTo");
  if (req.refundType !== "ORIGIN_CHAIN") return refuse("refundType");
  const checked = checkOneClickQuote(req, answer, { ...ctx.check, intoVault: true });
  const out = passQuote(checked, { kind: "return", signer: chain === "solana" ? w : lower(w), origin: req.originAsset, chain });
  const addr = out.depositAddress as string;
  if (chain === "solana" ? !SOL_KEY(addr) || addr === w : !EVM_ADDRESS.test(addr) || lower(addr) === lower(w)) return refuse("deposit_address");
  return out;
}

// ---------- an id's intent ----------

/** One RPC's reads at its final block, made on the device just before it signs. */
export interface IdIntentRead {
  /** The final block's timestamp, ns. */
  blockTimeNs: bigint;
  /** mt_balance_of(id, the asset) on intents.near. */
  held: bigint;
  /** view_access_key_list(id): every public key ("ed25519:<base58>"), or "absent" when the id has no account. A
   *  withdraw needs it; the refund move does not (W:928). */
  keys?: readonly string[] | "absent";
}

export interface IdIntentContext {
  network: NearNetwork;
  signer: OneTimeId;
  reads: readonly [IdIntentRead, IdIntentRead];
  /** The deadline of this id's earlier intent for the same money not seen to land, or null when there is none: always
   *  said, so a caller that forgets it signs nothing. */
  priorDeadline: string | null;
}

/** For an ft_withdraw, also: the asset the id's `held` reads are of, and per RPC as the two answered (they must agree):
 *  the typed account exists (view_account; not read for an implicit id), it is registered on the token
 *  (storage_balance_of not null), the token's code hash. */
export interface FtWithdrawReads {
  /** The asset `reads[].held` is of, its 1Click id ("nep141:<token>"): the token the intent takes out must be it. */
  asset: string;
  receiverExists?: readonly [boolean, boolean];
  receiverRegistered: readonly [boolean, boolean];
  codeHash: readonly [string, string];
}

type IntentRead = { readonly payload: string; readonly signer: Readonly<OneTimeId>; readonly kind: "transfer" | "ft_withdraw"; readonly amount: bigint; readonly receiver: string; readonly deadline: string };
// every intent a check passed, by identity, with the payload the check read: signIdIntent signs only that payload
const INTENTS_CHECKED = new WeakMap<object, IntentRead>();
/** A checked intent: what the check read, frozen; only the object a check returned is signed. */
export type IdIntent = Readonly<Omit<IntentRead, "signer"> & { signer: string }>;

/** The parts every id intent shares: one spelling, the five keys, the signer, the contract, the deadline and nonce
 *  rule, the reads agreed. Returns the one intent object and the agreed balance. */
function intentFrame(payload: string, ctx: IdIntentContext, s: Readonly<OneTimeId>, withdraw: boolean): { it: Record<string, unknown>; held: bigint; deadline: string; deadlineMs: number } {
  if (!Object.hasOwn(NEAR_NETWORKS, ctx.network) || ctx.network !== "mainnet") return refuse("network");
  if (typeof payload !== "string") return refuse("payload");
  let p: unknown;
  try {
    p = JSON.parse(payload);
  } catch {
    return refuse("payload");
  }
  // one spelling: no whitespace, no repeated key, the keys in this order, so intents.near reads what was checked
  if (!isObj(p) || JSON.stringify(p) !== payload || !keysExactly(p, ["signer_id", "verifying_contract", "deadline", "nonce", "intents"])) return refuse("payload");
  if (p.signer_id !== s.id) return refuse("signer_id");
  if (p.verifying_contract !== INTENTS) return refuse("verifying_contract");

  const reads = ctx.reads;
  if (!Array.isArray(reads) || reads.length !== 2) return refuse("reads");
  for (const r of reads) if (!isObj(r) || typeof r.blockTimeNs !== "bigint" || r.blockTimeNs <= 0n || !isU(r.held)) return refuse("reads");
  const held = agreed([reads[0].held, reads[1].held], isU, "held");
  const t0 = reads[0].blockTimeNs / 1_000_000n, t1 = reads[1].blockTimeNs / 1_000_000n;
  const lowMs = Number(t0 < t1 ? t0 : t1), highMs = Number(t0 < t1 ? t1 : t0);

  // the deadline: exactly the lower final-block time + 120 s, still ahead of the higher one
  const deadline = p.deadline;
  if (typeof deadline !== "string" || !ISO_MS.test(deadline)) return refuse("deadline");
  const deadlineMs = Date.parse(deadline);
  if (Number.isNaN(deadlineMs) || new Date(deadlineMs).toISOString() !== deadline) return refuse("deadline");
  if (deadlineMs !== lowMs + ID_INTENT_WINDOW_MS || deadlineMs <= highMs) return refuse("deadline");
  // a fresh intent for the same money only once the earlier one's deadline has passed on both RPCs
  if (ctx.priorDeadline !== null) {
    // the same one spelling as the intent's own deadline: ISO 8601 UTC to the millisecond, and only a real instant
    const prior = typeof ctx.priorDeadline === "string" && ISO_MS.test(ctx.priorDeadline) ? Date.parse(ctx.priorDeadline) : Number.NaN;
    if (Number.isNaN(prior) || new Date(prior).toISOString() !== ctx.priorDeadline || !(lowMs > prior)) return refuse("prior_deadline");
  }
  // the nonce: base64 of 32 bytes, a V1 versioned nonce whose own deadline is the intent's (intents.near refuses an
  // intent whose deadline is after its nonce's)
  let n: Uint8Array;
  try {
    n = typeof p.nonce === "string" ? base64.decode(p.nonce) : new Uint8Array(0);
  } catch {
    return refuse("nonce");
  }
  if (n.length !== 32 || base64.encode(n) !== p.nonce || VERSIONED_NONCE_V1.some((b, k) => n[k] !== b)) return refuse("nonce");
  if (new DataView(n.buffer, n.byteOffset).getBigUint64(9, true) !== BigInt(deadlineMs) * 1_000_000n) return refuse("nonce");

  if (!Array.isArray(p.intents) || p.intents.length !== 1 || !isObj(p.intents[0])) return refuse("intents");
  if (withdraw) {
    // a withdraw only while the id's key list reads exactly its own key, or no account at all, on two RPCs
    const own = `ed25519:${base58.encode(s.publicKey)}`;
    const k = reads.map((r) => (r.keys === "absent" ? "absent" : Array.isArray(r.keys) && r.keys.length === 1 && r.keys[0] === own ? "own" : "other"));
    if (k[0] === "other" || k[0] !== k[1]) return refuse("keys");
  }
  return { it: p.intents[0] as Record<string, unknown>, held, deadline, deadlineMs };
}

const passIntent = (read: IntentRead): IdIntent => {
  const out: IdIntent = Object.freeze({ payload: read.payload, signer: read.signer.id, kind: read.kind, amount: read.amount, receiver: read.receiver, deadline: read.deadline });
  INTENTS_CHECKED.set(out, Object.freeze(read));
  return out;
};

/** An id's one transfer intent to a checked quote's deposit address (W:914; W:928 inside intents.near to another
 *  chain): `quote` is the object checkRefundMoveQuote or checkIdWithdrawQuote returned for this same id. */
export function checkIdTransferIntent(payload: string, quote: RefundQuote, ctx: IdIntentContext): IdIntent {
  const s = idOf(ctx.signer);
  const r = isObj(quote) ? QUOTES.get(quote) : undefined;
  if (!r || (r.kind !== "refund" && r.kind !== "withdraw")) return refuse("unchecked");
  if (r.signer !== s.id) return refuse("signer_id");
  const withdraw = r.kind === "withdraw";
  const { it, held, deadline, deadlineMs } = intentFrame(payload, ctx, s, withdraw);
  // a transfer of exactly its three fields: no memo, no msg, no notification
  if (it.intent !== "transfer" || !keysExactly(it, ["intent", "receiver_id", "tokens"])) return refuse("intent");
  const net = NEAR_NETWORKS[ctx.network];
  const to = it.receiver_id;
  // the quote's signed deposit address, never the vault, intents.near, the token or the id itself
  if (typeof to !== "string" || to !== r.depositAddress) return refuse("receiver_id");
  if (to === INTENTS || to === net.usdc || to === s.id || (net.vault !== null && to === net.vault)) return refuse("receiver_id");
  const tokens = it.tokens;
  if (!isObj(tokens) || Object.keys(tokens).length !== 1 || !Object.hasOwn(tokens, r.origin)) return refuse("tokens");
  const amount = tokens[r.origin];
  if (typeof amount !== "string" || !DECIMAL.test(amount) || amount === "0" || BigInt(amount) >= U128) return refuse("amount");
  // exactly the quote's signed amount in, at most what the id holds (less one base unit for a withdraw)
  if (BigInt(amount) !== r.amountIn) return refuse("amount");
  if (BigInt(amount) > (withdraw ? held - 1n : held)) return refuse("held");
  // the intent dies before the quote's address does
  if (deadlineMs > r.deadlineMs) return refuse("deadline");
  // one ask, one intent: the quote passes no second one
  QUOTES.delete(quote);
  return passIntent({ payload, signer: s, kind: "transfer", amount: BigInt(amount), receiver: to, deadline });
}

/** An id's ft_withdraw out of intents.near to the account typed on SIGN_HOST's top-level form (W:930). */
export function checkIdFtWithdrawIntent(payload: string, typed: string, ctx: IdIntentContext & { ft: FtWithdrawReads }): IdIntent {
  const s = idOf(ctx.signer);
  const { it, held, deadline } = intentFrame(payload, ctx, s, true);
  const net = NEAR_NETWORKS[ctx.network];
  // exactly the four fields: no memo, no msg, no storage_deposit, no min_gas (D46)
  if (it.intent !== "ft_withdraw" || !keysExactly(it, ["intent", "token", "receiver_id", "amount"])) return refuse("intent");
  // the token the id holds there (the asset its balance was read on), one the deposit path takes, at its pinned code hash
  const ft = isObj(ctx.ft) ? ctx.ft : refuse("reads");
  const token = it.token;
  if (typeof token !== "string" || !Object.hasOwn(FT_WITHDRAW_TOKENS, token) || ft.asset !== `nep141:${token}`) return refuse("token");
  if (agreed(ft.codeHash, (x) => typeof x === "string") !== FT_WITHDRAW_TOKENS[token]) return refuse("code_hash");
  // the typed account, as typed: a NEAR account id, never the vault, intents.near, the id itself, a listed token or a
  // native coin's omft token (withdrawn to a token contract, the money would sit on the token's own account)
  const form = addressForm(typed);
  if (form === null || form.account !== typed || it.receiver_id !== typed) return refuse("receiver_id");
  if (typed === INTENTS || typed === s.id || Object.hasOwn(FT_WITHDRAW_TOKENS, typed) || RETURN_NATIVE_TOKENS.has(typed) || (net.vault !== null && typed === net.vault)) return refuse("receiver_id");
  // a named account must exist on two RPCs; an implicit id, which no stranger can create, passes unread
  if (form.kind === "named" && agreed(ft.receiverExists, (x) => typeof x === "boolean", "receiver") !== true) return refuse("receiver");
  // registered or not, the two reads must agree: the relayer registers a null one before it sends (card
  // intents-register-receiver); while they disagree nothing is signed
  agreed(ft.receiverRegistered, (x) => typeof x === "boolean", "registration");
  const amount = it.amount;
  if (typeof amount !== "string" || !DECIMAL.test(amount) || amount === "0" || BigInt(amount) >= U128) return refuse("amount");
  // at most what the id holds less one base unit, which stays so restore still finds the id (§2.3 step 5)
  if (BigInt(amount) > held - 1n) return refuse("held");
  return passIntent({ payload, signer: s, kind: "ft_withdraw", amount: BigInt(amount), receiver: typed, deadline });
}

/** The id's signed intent, raw_ed25519 (ed25519 over the payload's UTF-8 bytes): only an intent a check above passed,
 *  only with the id's own key. The shape POST /v1/intents takes (kit helper/v1.ts HelperSignedIntent). */
export function signIdIntent(secretKey: Uint8Array, intent: IdIntent): { standard: "raw_ed25519"; payload: string; public_key: string; signature: string } {
  const read = isObj(intent) ? INTENTS_CHECKED.get(intent) : undefined;
  if (!read) return refuse("unchecked");
  let pub: Uint8Array;
  try {
    pub = ed25519.getPublicKey(secretKey);
  } catch {
    return refuse("key");
  }
  if (hexOf(pub) !== read.signer.id) return refuse("key");
  // a checked intent signs once
  INTENTS_CHECKED.delete(intent);
  const signature = ed25519.sign(new TextEncoder().encode(read.payload), secretKey);
  return { standard: "raw_ed25519", payload: read.payload, public_key: `ed25519:${base58.encode(pub)}`, signature: `ed25519:${base58.encode(signature)}` };
}

// ---------- W's return send ----------

/** The device's reads for W's Solana return send, each as its two RPCs answered: the blockhash, W's balance, the
 *  network's fee for this very message (getFeeForMessage). */
export type SolanaReturnReads = { readonly blockhash: string; readonly balance: readonly [bigint, bigint]; readonly fee: readonly [bigint, bigint] };
// a Solana wire is an array its holder can still write to: the bytes the check read are kept beside it
const SOLANA_RETURN_CHECKED = new WeakMap<Uint8Array, { bytes: Uint8Array; wallet: string }>();

/** W's Solana return send: one System transfer of exactly the quote's signed amount in to its signed deposit address,
 *  W the only signer and fee payer, no lookup table, nothing else in the transaction, within W's balance less the fee. */
export function checkReturnSolana(wire: Uint8Array, quote: RefundQuote, reads: SolanaReturnReads): void {
  const q = quoteRead(quote, "return");
  if (q.chain !== "solana") return refuse("chain");
  if (!(wire instanceof Uint8Array) || wire.length < 1 || wire.length > SOLANA_MAX_TX_BYTES || wire[0] !== 1) return refuse("wire");
  const bytes = wire.slice();
  let m: ReturnType<typeof solanaDecodeMessage>;
  try {
    m = solanaDecodeMessage(bytes.subarray(65));
  } catch {
    return refuse("decode");
  }
  if (m.lookups.length !== 0) return refuse("lookups");
  if (typeof reads?.blockhash !== "string" || m.blockhash !== reads.blockhash) return refuse("blockhash");
  const keys = solanaResolveKeys(m, {});
  const signers = keys.filter((k) => k.signer);
  if (signers.length !== 1 || signers[0]!.key !== q.signer) return refuse("signers");
  if (m.instructions.length !== 1) return refuse("instructions");
  const ix = m.instructions[0]!;
  const program = keys[ix.programIndex];
  const d = ix.data;
  if (!program || program.key !== SOLANA_SYSTEM_PROGRAM || d.length !== 12 || d[0] !== 2 || d[1] !== 0 || d[2] !== 0 || d[3] !== 0) return refuse("transfer");
  const [from, to] = ix.accounts.map((i) => keys[i]);
  if (ix.accounts.length !== 2 || !from || !to || from.key !== q.signer || !from.signer || !from.writable || to.key !== q.depositAddress || !to.writable) return refuse("transfer_to");
  const amount = new DataView(d.buffer, d.byteOffset + 4, 8).getBigUint64(0, true);
  if (amount !== q.amountIn) return refuse("transfer_amount");
  const balance = agreed(reads.balance, isU);
  const fee = agreed(reads.fee, isU);
  if (amount + fee > balance) return refuse("balance");
  // one ask, one send: the quote passes no second one
  QUOTES.delete(quote);
  SOLANA_RETURN_CHECKED.set(wire, { bytes, wallet: q.signer });
}

/** W's ed25519 signature of the Solana return send checkReturnSolana passed, as it read it, with W's own key. */
export function signReturnSolana(secretKey: Uint8Array, wire: Uint8Array): Uint8Array {
  const read = wire instanceof Uint8Array ? SOLANA_RETURN_CHECKED.get(wire) : undefined;
  if (!read || read.bytes.length !== wire.length || read.bytes.some((b, i) => b !== wire[i])) return refuse("unchecked");
  let pub: Uint8Array;
  try {
    pub = ed25519.getPublicKey(secretKey);
  } catch {
    return refuse("key");
  }
  if (base58.encode(pub) !== read.wallet) return refuse("key");
  // a checked send signs once
  SOLANA_RETURN_CHECKED.delete(wire);
  return ed25519.sign(read.bytes.subarray(65), secretKey);
}

/** W's EVM return send: an EIP-1559 (type 2) transaction; `data` hex ("0x" for a plain send). */
export type EvmReturnSend = {
  readonly type: 2;
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint;
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  readonly accessList: readonly unknown[];
};
/** The device's reads for W's EVM return send, each as its two RPCs answered: W's nonce and balance, whether the
 *  deposit address has code, eth_estimateGas of the send (Robinhood's Nitro charges L1 data as gas), the base fee, the
 *  L1 data fee on an OP Stack chain (Base; 0 elsewhere), with the device's own cap on the priority fee. */
export type EvmReturnReads = {
  readonly nonce: readonly [bigint, bigint];
  readonly balance: readonly [bigint, bigint];
  readonly toHasCode: readonly [boolean, boolean];
  readonly estimate: readonly [bigint, bigint] | null;
  readonly baseFee: readonly [bigint, bigint];
  readonly l1Fee: readonly [bigint, bigint];
  readonly priorityCap: bigint;
};
const SEND_KEYS = "accessList,chainId,data,gasLimit,maxFeePerGas,maxPriorityFeePerGas,nonce,to,type,value";
type SendRead = EvmReturnSend & { readonly wallet: string };
const EVM_RETURN_CHECKED = new WeakMap<object, SendRead>();
/** The send's fields, each read once, into a frozen copy. */
function sendCopy(tx: EvmReturnSend): EvmReturnSend {
  if (!isObj(tx) || Object.keys(tx).sort().join() !== SEND_KEYS || tx.type !== 2) return refuse("type");
  const t = { type: 2 as const, chainId: tx.chainId, nonce: tx.nonce, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, maxFeePerGas: tx.maxFeePerGas, gasLimit: tx.gasLimit, to: tx.to, value: tx.value, data: tx.data, accessList: tx.accessList };
  if (![t.chainId, t.maxPriorityFeePerGas, t.maxFeePerGas, t.gasLimit, t.value].every(isU) || !isU(t.nonce) || t.nonce >= (1n << 64n) - 1n) return refuse("tx_fields");
  if (typeof t.to !== "string" || typeof t.data !== "string" || !Array.isArray(t.accessList)) return refuse("tx_fields");
  return Object.freeze({ ...t, accessList: Object.freeze([...t.accessList]) });
}

/** W's EVM return send: exactly the quote's signed amount in to its signed deposit address, on the pinned chain, at
 *  W's nonce, a plain send with no data or access list, within W's balance less the fee bound. */
export function checkReturnEvm(tx: EvmReturnSend, quote: RefundQuote, reads: EvmReturnReads): void {
  const q = quoteRead(quote, "return");
  if (q.chain !== "base" && q.chain !== "robinhood") return refuse("chain");
  const t = sendCopy(tx);
  const nonce = agreed(reads?.nonce, isU);
  const balance = agreed(reads.balance, isU);
  const hasCode = agreed(reads.toHasCode, (x) => typeof x === "boolean");
  const baseFee = agreed(reads.baseFee, isU);
  const l1Fee = agreed(reads.l1Fee, isU);
  const nitro = q.chain === "robinhood";
  if (!isU(reads.priorityCap)) return refuse("reads");
  if (t.chainId !== EVM_CHAIN_IDS[q.chain]) return refuse("chain_id");
  if (lower(t.to) !== q.depositAddress.toLowerCase()) return refuse("transfer_to");
  // 1Click's deposit address is an account with no code: a contract there is not the address it quoted
  if (hasCode) return refuse("to_code");
  if (t.nonce !== nonce) return refuse("nonce");
  if (t.data !== "0x") return refuse("data");
  if (t.accessList.length !== 0) return refuse("access_list");
  if (nitro) {
    if (l1Fee !== 0n) return refuse("l1_fee");
    if (t.gasLimit !== agreed(reads.estimate ?? undefined, isU) || t.gasLimit > RETURN_EVM_GAS_MAX) return refuse("gas_limit");
  } else if (t.gasLimit !== RETURN_EVM_GAS) return refuse("gas_limit");
  if (t.maxPriorityFeePerGas > reads.priorityCap || t.maxPriorityFeePerGas > t.maxFeePerGas) return refuse("priority_fee");
  if (t.maxFeePerGas > 2n * baseFee + reads.priorityCap || t.maxFeePerGas < baseFee) return refuse("max_fee");
  if (t.value !== q.amountIn) return refuse("value");
  if (t.value + t.gasLimit * t.maxFeePerGas + l1Fee > balance) return refuse("balance");
  // one ask, one send: the quote passes no second one
  QUOTES.delete(quote);
  EVM_RETURN_CHECKED.set(tx, Object.freeze({ ...t, wallet: q.signer }));
}

// RLP (the Ethereum yellow paper, appendix B), as rules/pool.ts writes W's onward send
const beBytes = (v: bigint): Uint8Array => {
  const b: number[] = [];
  for (let x = v; x > 0n; x >>= 8n) b.unshift(Number(x & 0xffn));
  return Uint8Array.from(b);
};
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const rlpHead = (n: number, short: number): Uint8Array => {
  if (n <= 55) return Uint8Array.of(short + n);
  const l = beBytes(BigInt(n));
  return Uint8Array.of(short + 55 + l.length, ...l);
};
const rlpBytes = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? b : cat(rlpHead(b.length, 0x80), b));
const rlpUint = (v: bigint): Uint8Array => rlpBytes(beBytes(v));
const rlpList = (items: Uint8Array[]): Uint8Array => cat(rlpHead(items.reduce((n, i) => n + i.length, 0), 0xc0), ...items);
const hexBytes = (h: string): Uint8Array => {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(h)) return refuse("tx_fields");
  return Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));
};
const sendFields = (t: EvmReturnSend): Uint8Array[] => [rlpUint(t.chainId), rlpUint(t.nonce), rlpUint(t.maxPriorityFeePerGas), rlpUint(t.maxFeePerGas), rlpUint(t.gasLimit), rlpBytes(hexBytes(t.to)), rlpUint(t.value), rlpBytes(hexBytes(t.data)), rlpList([])];
const be32 = (b: Uint8Array): bigint => BigInt("0x" + (hexOf(b) || "0"));

/** W's signed EVM return send, the raw transaction 0x02 ‖ rlp([...the nine fields, yParity, r, s]), s low: only the
 *  send checkReturnEvm passed, while it reads as the check read it, and only with W's own key. */
export function signReturnEvm(secretKey: Uint8Array, tx: EvmReturnSend): Uint8Array {
  const read = isObj(tx) ? EVM_RETURN_CHECKED.get(tx) : undefined;
  if (!read) return refuse("unchecked");
  let now: EvmReturnSend;
  try {
    now = sendCopy(tx);
  } catch {
    return refuse("unchecked");
  }
  const fields = ["type", "chainId", "nonce", "maxPriorityFeePerGas", "maxFeePerGas", "gasLimit", "to", "value", "data"] as const;
  if (fields.some((k) => now[k] !== read[k]) || now.accessList.length !== 0) return refuse("unchecked");
  let address: string;
  try {
    address = "0x" + hexOf(keccak_256(secp256k1.getPublicKey(secretKey, false).subarray(1)).subarray(12));
  } catch {
    return refuse("key");
  }
  if (address !== read.wallet) return refuse("key");
  // a checked send signs once
  EVM_RETURN_CHECKED.delete(tx);
  const rec = secp256k1.sign(keccak_256(cat(Uint8Array.of(2), rlpList(sendFields(read)))), secretKey, { prehash: false, lowS: true, format: "recovered" });
  // noble's recovered form is the recovery bit, then r and s
  const sig = [rlpUint(BigInt(rec[0]!)), rlpUint(be32(rec.subarray(1, 33))), rlpUint(be32(rec.subarray(33, 65)))];
  return cat(Uint8Array.of(2), rlpList([...sendFields(read), ...sig]));
}
