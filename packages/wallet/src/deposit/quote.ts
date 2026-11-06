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
export function depositQuoteRequest(u: string, originAsset: string, amount: bigint, now: number): OneClickRequest {
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
  };
}

/** The helper's answer as data: its HTTP status and its JSON body, neither checked here. */
export interface DepositQuoteReply {
  status: number;
  body: unknown;
}

/**
 * POSTs `request` as it is to the helper's 1Click proxy, with no cookie and no referrer. Returns the status and the
 * parsed body; throws when the helper does not answer in time, answers over DEPOSIT_QUOTE_ANSWER_MAX or not in JSON.
 */
export async function askDepositQuote(request: OneClickRequest, fetchFn: typeof fetch = fetch): Promise<DepositQuoteReply> {
  const res = await fetchFn(DEPOSIT_QUOTE_URL, {
    ...HELPER_FETCH_INIT,
    redirect: "error",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(DEPOSIT_QUOTE_TIMEOUT_MS),
  });
  const bytes = await readCapped(res, DEPOSIT_QUOTE_ANSWER_MAX);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new Error(`deposit quote: HTTP ${res.status}, not JSON`);
  }
  return { status: res.status, body };
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
