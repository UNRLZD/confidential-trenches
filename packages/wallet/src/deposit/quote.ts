// The deposit quote's request and its trip through the helper (card wallet-deposit-quote; docs/plan1/wallet.md at
// research 3a6b03e: §2.4 step 2, W:408, and step 3, W:409; the deposit quote row of §2.8, W:888). The device asks 1Click
// for a quote whose output goes to U, the one-time NEAR id of this deposit, and whose refund goes to U too:
//   dry false, EXACT_INPUT, the origin asset as the user picked it, depositType ORIGIN_CHAIN, the vault's asset on NEAR
//   as the destination, recipient U with recipientType DESTINATION_CHAIN (1Click delivers on the token to U's own NEAR
//   account), refundTo U with refundType INTENTS (a refund lands under U inside intents.near, which only U's key
//   moves), and nothing else: no sessionId, connectedWallets, customRecipientMsg, referral or quoteWaitingTimeMs.
// The request goes to 1Click through the helper's proxy (it holds the 1Click key, W:408), POST
// /v1/proxy/oneclick/v0/quote on HELPER_HOST. It names U and the asset and amount only: no key, no words, no other id
// of this user (§2.9 row 3, W:925). The answer is hostile: this file hands it back as data, and the signing page's
// deposit quote rule checks it before any address is shown (packages/signpage/src/rules/deposit-quote.ts).
import { HELPER_FETCH_INIT, VAULT_CONSTANTS, type OneClickRequest } from "@blindfill/kit";
import { base58, hex } from "@scure/base";
import { toChecksum } from "../derive/keys.ts";
import { EVM_LADDER } from "../pool/evm.ts";
import { SOL_LADDER } from "../pool/solana.ts";

/** The helper's 1Click proxy on HELPER_HOST (apps/helper/src/proxy/vendors.ts: oneclick, POST /v0/quote). */
export const DEPOSIT_QUOTE_URL = "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote";
/** The vault's asset on 1Click: NEAR USDC, the release's token (§2.4 step 2). */
export const DEPOSIT_QUOTE_DESTINATION = `nep141:${VAULT_CONSTANTS.TOKEN}`;
/** The device's own slippage on a deposit quote, in bps: 100, as every 1Click quote of the G1 runs asked. */
export const DEPOSIT_QUOTE_SLIPPAGE_BPS = 100;
/**
 * The request's deadline from now: 30 minutes, as the G1 runs' live quote asked. 1Click signs the requested deadline
 * + 72 h as the address's own (the kit's ONECLICK_LIVE_DEADLINE_MS), which the check holds it to.
 */
export const DEPOSIT_QUOTE_DEADLINE_MS = 30 * 60_000;
/** The helper's own upstream timeout is 8 s (apps/helper/src/proxy/proxy.ts TIMEOUT_MS); this one is the device's. */
export const DEPOSIT_QUOTE_TIMEOUT_MS = 10_000;
/** The largest answer read: a quote is a few KB. */
export const DEPOSIT_QUOTE_ANSWER_MAX = 65_536;

const IMPLICIT = /^[0-9a-f]{64}$/;

/**
 * The request of §2.4 step 2 for a deposit of `amount` base units of `originAsset` to U (its 64-hex implicit id), asked
 * at `now` (ms). Throws on input that is not that.
 */
export function depositQuoteRequest(u: string, originAsset: string, amount: bigint, now: number, confidential = false): OneClickRequest {
  if (typeof u !== "string" || !IMPLICIT.test(u)) throw new Error("deposit quote: U must be a 64-hex implicit account id");
  if (typeof originAsset !== "string" || originAsset === "") throw new Error("deposit quote: no origin asset");
  if (typeof amount !== "bigint" || amount <= 0n) throw new Error("deposit quote: the amount must be a positive bigint");
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("deposit quote: now must be a time in ms");
  return {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: DEPOSIT_QUOTE_SLIPPAGE_BPS,
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: DEPOSIT_QUOTE_DESTINATION,
    amount: amount.toString(),
    refundTo: u,
    refundType: "INTENTS",
    recipient: u,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + DEPOSIT_QUOTE_DEADLINE_MS).toISOString(),
    // a Move into Cash (card move-one-confidential-swap): on Confidential Intents rails
    ...(confidential === true ? { confidentiality: "advanced" as const } : {}),
  };
}

/** The chains a pool runs on (the kit's PoolChain). */
export type PoolDepositChain = "solana" | "base" | "robinhood";

/**
 * Each pool's asset on 1Click (card pool-deposit-address): the chain's native coin, the asset every pool holds (SOL;
 * ETH on Base and Robinhood), as the return to the vault quotes it (packages/signpage/src/rules/refund.ts RETURN_NATIVE).
 */
export const POOL_DEPOSIT_DESTINATION: Readonly<Record<PoolDepositChain, string>> = Object.freeze({
  solana: "nep141:sol.omft.near",
  base: "nep141:base.omft.near",
  robinhood: "nep141:hood.omft.near",
});

/**
 * The network POOL_DEPOSIT_DESTINATION's assets pay out on: 1Click delivers to mainnet only (NEAR Intents has no
 * testnet). A page whose pools are pinned on another network (the testnet build's Solana devnet, Base Sepolia,
 * Robinhood testnet) gets no pool deposit quote, so no real money goes to a U_X its pool never reads.
 */
export const POOL_DEPOSIT_NETWORK = "mainnet";

/**
 * The pool's own smallest deposit, in the pool coin's base units: its ladder's least rung (pool/solana.ts SOL_LADDER.min,
 * 0.01 SOL; pool/evm.ts EVM_LADDER.min, 0.001 ETH). This is the rung only: U_X pays its deposit's fee and rents out of
 * what arrives, so the floor a pool deposit quote is held to is this plus one deposit's worst-case cost, read at quote
 * time (card pool-deposit-follow: packages/signpage/src/pool-deposit-quote.ts solanaPoolDepositFloor and
 * evmPoolDepositFloor), and no floor under this rung is taken.
 */
export const POOL_DEPOSIT_MIN_OUT: Readonly<Record<PoolDepositChain, bigint>> = Object.freeze({
  solana: SOL_LADDER.min,
  base: EVM_LADDER.min,
  robinhood: EVM_LADDER.min,
});

/**
 * The pair a pool deposit quote names (card pool-deposit-address): `wallet` is U_X, the recipient on `chain`, and
 * `refundId` the 64-hex NEAR implicit id a refund lands under inside intents.near (refundType INTENTS). The refund id is
 * U_{s,i}, the scope's own ed25519 one-time id (derive/keys.ts depositId, HKDF info "onetime/in" || s || i), the key the
 * refund move already opens and signs with (follow.ts openKey), so one signer moves a refund on every chain and none
 * signs ERC-191. On Solana U_X is that very key, so the wallet must be the base58 of the id's 32 bytes; on Base and
 * Robinhood U_X is U^evm_{s,i} of the same scope and index (EIP-55, as derived), beside the id. Throws on any other pair.
 */
export function checkPoolDepositWallet(chain: PoolDepositChain, wallet: string, refundId: string): void {
  if (!Object.hasOwn(POOL_DEPOSIT_DESTINATION, chain)) throw new Error("pool deposit quote: no pool on this chain");
  if (typeof refundId !== "string" || !IMPLICIT.test(refundId)) throw new Error("pool deposit quote: the refund id must be a 64-hex implicit account id");
  if (typeof wallet !== "string") throw new Error("pool deposit quote: no wallet");
  if (chain === "solana") {
    let key: Uint8Array;
    try {
      key = base58.decode(wallet);
    } catch {
      throw new Error("pool deposit quote: U_X is not a Solana address");
    }
    if (key.length !== 32 || base58.encode(key) !== wallet) throw new Error("pool deposit quote: U_X is not a Solana address");
    if (hex.encode(key) !== refundId) throw new Error("pool deposit quote: a Solana U_X's refund id is its own key");
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || toChecksum(wallet) !== wallet) throw new Error("pool deposit quote: U_X is not an EIP-55 address");
}

/**
 * The request for money from another chain into chain X's pool (card pool-deposit-address): `amount` base units of
 * `originAsset` to U_X (`wallet`), the chain's one-time deposit wallet the note store plans, at `now` (ms). It is the
 * vault's request (depositQuoteRequest) but for the ends: the pool's native coin on X as the destination, U_X the
 * recipient on X (DESTINATION_CHAIN: 1Click sends the coin to U_X's own address there), and the refund under the scope's
 * own one-time id U_{s,i} (`refundId`, INTENTS; checkPoolDepositWallet), so the request names that one deposit's keys
 * and no other wallet of the user. Money already on X is pool.deposit's own: an origin that is X's coin is refused.
 * Throws on input that is not that.
 */
export function poolDepositQuoteRequest(chain: PoolDepositChain, wallet: string, refundId: string, originAsset: string, amount: bigint, now: number, confidential = false): OneClickRequest {
  checkPoolDepositWallet(chain, wallet, refundId);
  const destinationAsset = POOL_DEPOSIT_DESTINATION[chain];
  if (typeof originAsset !== "string" || originAsset === "") throw new Error("pool deposit quote: no origin asset");
  if (originAsset === destinationAsset) throw new Error("pool deposit quote: the pool's own coin needs no quote");
  if (typeof amount !== "bigint" || amount <= 0n) throw new Error("pool deposit quote: the amount must be a positive bigint");
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("pool deposit quote: now must be a time in ms");
  return {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: DEPOSIT_QUOTE_SLIPPAGE_BPS,
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset,
    amount: amount.toString(),
    refundTo: refundId,
    refundType: "INTENTS",
    recipient: wallet,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + DEPOSIT_QUOTE_DEADLINE_MS).toISOString(),
    // a Move's quote (card move-one-confidential-swap): on Confidential Intents rails, so the origin is not linked to U_X
    ...(confidential === true ? { confidentiality: "advanced" as const } : {}),
  };
}

/** The helper's answer as data: its HTTP status and its JSON body, neither checked here. */
export interface DepositQuoteReply {
  status: number;
  body: unknown;
}

/**
 * 1Click's answer when no solver quoted this size at this second: HTTP 400 with `message` "No liquidity available"
 * (read 10 Nov 07:04-07:43Z through the helper, card deposit-quote-no-liquidity: Solana USDC into NEAR USDC refused at 18
 * to 150 USDC and quoted at 3.4 to 15, 75 and 250; the same 25 quoted at 18:59Z; research
 * proofs/p3-coverage/results/oneclick-sweep.json holds the same message). The answer is the helper's to pass, so a forged
 * one can only cost a re-ask (bounded below), never an address.
 */
const NO_LIQUIDITY = /^No liquidity available\b/;
/**
 * The pauses before each re-ask of the same request after a NO_LIQUIDITY answer: two re-asks at most, three asks in all.
 * A no-liquidity answer creates no deposit address, so a live request is asked again as it is, and the answer that comes
 * back is checked by its caller exactly as one answer is.
 */
export const NO_LIQUIDITY_PAUSES_MS: readonly number[] = Object.freeze([500, 1_000]);
/** No re-ask starts with less than this left of the ask's window: a quote's own answer time, 1.4 s at most read (18:59Z). */
export const NO_LIQUIDITY_ASK_MIN_MS = 2_000;

/**
 * 1Click's 400s about the request itself (card helper-says-why-a-vendor-refused): its amount ("Amount is too low for
 * bridge, try at least N", "Amount is too low for the destination chain", "Temporary swap limits: minimum swap amount is
 * $N"), its pair ("Quoting for this pair is not available"), a field it refuses ("recipient is not valid", "<asset> is not
 * supported as origin asset", "<asset> supports only ORIGIN_CHAIN refundType") or its deadline: 1Click's own words as the
 * deposit runs and research proofs/p3-coverage read them. "Invalid token" is not one: 1Click answers it for a key it does
 * not honour (401, scripts/live-checks/oneclick-partner-fee-live.answers.json bad_key_refused). The same request gets the same answer, so it
 * is shown at once. A list of messages is a list of what is wrong with the request (a validation answer).
 */
const ABOUT_THE_REQUEST: readonly RegExp[] = [/^Amount is too low\b/, /^Temporary swap limits\b/, /^Quoting for this pair is not available\b/,
  /\bis not valid\b/, /\bis not supported\b/, /\bsupports only\b/, /\bdeadline\b/i];

/**
 * True when a reply is a refusal worth asking again (card helper-says-why-a-vendor-refused): a 400 in 1Click's shape (a
 * JSON object with no helper code) that is not about the request: no liquidity at that second, "Failed to get quote", a
 * message the page does not know, or none (live runs 43276439006 and 43289730843: every quote 400 for minutes, green again
 * within half an hour). A helper's own 400 ({ error: { code } }) and a 400 about the request (ABOUT_THE_REQUEST) are not.
 */
export function askAgainFor(reply: DepositQuoteReply): boolean {
  return refusalOf(reply) === "again";
}
/** A reply's kind of refusal: a 400 of 1Click's worth asking again, a 400 of 1Click's about the request, or neither. */
function refusalOf(reply: DepositQuoteReply): "again" | "request" | null {
  const b = reply.body;
  if (reply.status !== 400 || typeof b !== "object" || b === null || Array.isArray(b)) return null;
  const o = b as { message?: unknown; error?: unknown };
  if (typeof o.error === "object" && o.error !== null && typeof (o.error as { code?: unknown }).code === "string") return null;
  if (Array.isArray(o.message)) return "request";
  return typeof o.message === "string" && ABOUT_THE_REQUEST.some((r) => r.test(o.message as string)) ? "request" : "again";
}

/** True when a reply is 1Click's no-liquidity answer: 400 with that message. */
export function noLiquidity(reply: DepositQuoteReply): boolean {
  const b = reply.body;
  return reply.status === 400 && typeof b === "object" && b !== null && typeof (b as { message?: unknown }).message === "string" &&
    NO_LIQUIDITY.test((b as { message: string }).message);
}

/**
 * One ask: POSTs `request` as it is to the helper's 1Click proxy, with no cookie and no referrer. Returns the status and
 * the parsed body; throws when the helper does not answer in DEPOSIT_QUOTE_TIMEOUT_MS, answers over
 * DEPOSIT_QUOTE_ANSWER_MAX or not in JSON. Every quote path asks through askDepositQuoteAgain, which makes this ask
 * first (card helper-says-why-a-vendor-refused: the display reads too).
 */
export function askDepositQuote(request: OneClickRequest, fetchFn: typeof fetch = fetch): Promise<DepositQuoteReply> {
  return askOnce(request, fetchFn, DEPOSIT_QUOTE_TIMEOUT_MS);
}

/** 1Click's answered statuses (wallet.md D52: a quote answers 201; 200 too). */
const ANSWERED: readonly number[] = Object.freeze([200, 201]);
/** A re-ask that failed as an ask fails (no answer in time, a failed fetch, an answer too large or not JSON); anything
 *  else (a programming error such as a RangeError) is thrown, never read as a failed re-ask. */
const askFailed = (e: unknown): boolean =>
  e instanceof DepositAnswerTooLarge || e instanceof DepositAnswerNotJson || e instanceof TypeError ||
  (typeof e === "object" && e !== null && ((e as { name?: unknown }).name === "TimeoutError" || (e as { name?: unknown }).name === "AbortError"));

/**
 * The committed asks (card deposit-quote-no-liquidity): deposit.quote, pool.address and the refund move, whose answer is
 * a deposit address. The first ask is askDepositQuote's; on 1Click's no-liquidity answer the same request is asked again
 * after each of NO_LIQUIDITY_PAUSES_MS, the clock read again after each pause, and only while NO_LIQUIDITY_ASK_MIN_MS is
 * left of the one ask's own window, DEPOSIT_QUOTE_TIMEOUT_MS (10 s) from the first send, each re-ask cut at what is left
 * (whole ms). So no caller waits longer than one ask could before this card: with 1Click's no-liquidity answers taking
 * some 3.6 s (research docs/research/intents-confidential.md C37) that is two asks, 3.6 s, then 0.5 s and 3.6 s; with
 * faster ones, three. Only a 200 or 201, or another no-liquidity answer, replaces the standing one: a re-ask the helper
 * answers 429, 503 or anything else, or that fails as an ask fails, leaves the no-liquidity answer standing and asks no
 * more. The last standing reply comes back, and every caller checks it as it checks one answer.
 * Card helper-says-why-a-vendor-refused: every 1Click 400 that is not about the request (askAgainFor) is asked again the
 * same way, and the display reads ask this way too (signpage rules/deposit-dry.ts): a sheet that asked its assets once
 * showed Not available for a few minutes of 1Click 400s (live run 43289730843). A re-ask 1Click answers about the request
 * (ABOUT_THE_REQUEST) ends the asks with that answer.
 * `signal` (review P3 of that card): the caller's stop (a refund move's, a superseded read's, the page's sign out). Once it
 * aborts, the pause ends, no ask leaves and an ask under way is cut; the asks throw its reason, never answer.
 */
export async function askDepositQuoteAgain(request: OneClickRequest, fetchFn: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = pause, clock: () => number = Date.now, signal?: AbortSignal): Promise<DepositQuoteReply> {
  signal?.throwIfAborted();
  const end = clock() + DEPOSIT_QUOTE_TIMEOUT_MS;
  let reply = await askOnce(request, fetchFn, DEPOSIT_QUOTE_TIMEOUT_MS, signal);
  for (const ms of NO_LIQUIDITY_PAUSES_MS) {
    if (!askAgainFor(reply) || end - clock() - ms < NO_LIQUIDITY_ASK_MIN_MS) break;
    await stoppable(sleep(ms), signal);
    signal?.throwIfAborted();
    // never more than the one ask's own window, whatever the clock reads (a wall clock set back mid-ask)
    const left = Math.min(Math.floor(end - clock()), DEPOSIT_QUOTE_TIMEOUT_MS);
    if (!(left >= NO_LIQUIDITY_ASK_MIN_MS)) break;
    let next: DepositQuoteReply;
    try {
      next = await askOnce(request, fetchFn, left, signal);
    } catch (e) {
      signal?.throwIfAborted();
      if (askFailed(e)) break;
      throw e;
    }
    // 1Click's answer about the request is the newest word on it and stands; a 429, 503 or anything else leaves the
    // refusal before it standing
    if (refusalOf(next) === "request") return next;
    if (!ANSWERED.includes(next.status) && !askAgainFor(next)) break;
    reply = next;
  }
  return reply;
}

const pause = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
/** `p`, ended early by `signal`'s abort (its reason thrown). */
function stoppable(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return p;
  return new Promise((ok, no) => {
    const stop = () => no(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    p.then(
      () => (signal.removeEventListener("abort", stop), ok()),
      (e) => (signal.removeEventListener("abort", stop), no(e)),
    );
  });
}

async function askOnce(request: OneClickRequest, fetchFn: typeof fetch, timeoutMs: number, signal?: AbortSignal): Promise<DepositQuoteReply> {
  const res = await fetchFn(DEPOSIT_QUOTE_URL, {
    ...HELPER_FETCH_INIT,
    redirect: "error",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const bytes = await readCapped(res, DEPOSIT_QUOTE_ANSWER_MAX);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new DepositAnswerNotJson(res.status);
  }
  return { status: res.status, body };
}

/** An answer that is not JSON. */
export class DepositAnswerNotJson extends Error {
  constructor(status: number) {
    super(`deposit quote: HTTP ${status}, not JSON`);
    this.name = "DepositAnswerNotJson";
  }
}

/** An answer refused for its size, declared or streamed (readCapped). */
export class DepositAnswerTooLarge extends Error {
  constructor(max: number) {
    super(`deposit quote: an answer over ${max} B`);
    this.name = "DepositAnswerTooLarge";
  }
}

/** The body's bytes, refused once they pass `max` (declared or streamed), without reading the rest. */
export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (Number(res.headers.get("content-length") ?? "0") > max) throw new DepositAnswerTooLarge(max);
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new DepositAnswerTooLarge(max);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
