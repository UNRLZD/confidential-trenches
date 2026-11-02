// The H-1c-shaped 1Click mock of test/rules-deposit-quote.test.ts, shared with test/deposit-wire.test.ts: a fetch standing
// in for the helper's 1Click proxy that answers in 1Click's own shape and signs each answer with a throwaway ed25519
// key, which the importing test process alone adds to the kit's pinned set, as the harness's test build does.
/// <reference types="node" />
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { ONECLICK_SIGNING_KEYS, type OneClickRequest } from "../../kit/src/checks/oneclick.ts";

export const U = "5d".repeat(32); // a test U: any 64-hex id; no key of it is used here
export const ATTACKER = "e1".repeat(32);
export const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
export const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const COLLECTOR = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
export const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"; // the mock's deposit address
export const NOW = Date.parse("2026-11-02T06:00:00.000Z");
export const H72 = 72 * 3_600_000;

// base58 (Bitcoin alphabet) of bytes; the package has no base58 dependency of its own.
export const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const base58 = {
  encode(b: Uint8Array): string {
    let n = 0n, s = "";
    for (const x of b) n = (n << 8n) | BigInt(x);
    for (; n > 0n; n /= 58n) s = B58[Number(n % 58n)] + s;
    for (const x of b) { if (x !== 0) break; s = "1" + s; }
    return s;
  },
};

export const mockKey = generateKeyPairSync("ed25519");
export const otherKey = generateKeyPairSync("ed25519");
export const rawPublic = (k: KeyObject): string => `ed25519:${base58.encode(Buffer.from(k.export({ format: "jwk" }).x as string, "base64url"))}`;
(ONECLICK_SIGNING_KEYS as string[]).push(rawPublic(mockKey.publicKey));

export type Answer = { quote: Record<string, unknown>; quoteRequest: Record<string, unknown>; signature: string; timestamp: string } & Record<string, unknown>;

// The signed bytes, built apart from the kit (node:crypto, not noble): bs58(sha256(stable-json)) as UTF-8 (D2-D4).
export function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}
export function signAnswer(a: Answer, key: KeyObject): void {
  const r = a.quoteRequest, q = a.quote, u = (x: unknown) => (x ? x : undefined);
  const req = { dry: r.dry, swapType: r.swapType, slippageTolerance: r.slippageTolerance, originAsset: r.originAsset, depositType: r.depositType,
    destinationAsset: r.destinationAsset, amount: r.amount, refundTo: r.refundTo, refundType: r.refundType, recipient: r.recipient,
    recipientType: r.recipientType, deadline: r.deadline, quoteWaitingTimeMs: u(r.quoteWaitingTimeMs), referral: u(r.referral),
    virtualChainRecipient: u(r.virtualChainRecipient), virtualChainRefundRecipient: u(r.virtualChainRefundRecipient),
    customRecipientMsg: u(r.customRecipientMsg) };
  const base = { amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountInUsd: q.amountInUsd, minAmountIn: q.minAmountIn,
    amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd, minAmountOut: q.minAmountOut };
  const quote = r.dry ? base : { ...base, depositAddress: u(q.depositAddress), depositMemo: u(q.depositMemo), deadline: u(q.deadline),
    timeWhenInactive: u(q.timeWhenInactive), timeEstimate: u(q.timeEstimate), refundFee: u(q.refundFee), withdrawFee: u(q.withdrawFee) };
  const h = base58.encode(createHash("sha256").update(stable({ ...req, ...quote, timestamp: a.timestamp })).digest());
  a.signature = `ed25519:${base58.encode(sign(null, Buffer.from(h, "utf8"), key))}`;
}

// 25 USDC from Solana on the partner path (F 20, S 15): the floor is 25,000,000 − 5,328 − ⌊25,000,000 × 35 / 10,000⌋
// = 24,907,172 for amountOut and ⌈24,907,172 × 9,900 / 10,000⌉ = 24,658,101 for minAmountOut.
export const FLOOR_OUT = 24_907_172n, FLOOR_MIN = 24_658_101n;
export function liveAnswer(req: OneClickRequest, timestamp: number): Answer {
  return {
    quote: {
      amountIn: req.amount, amountInFormatted: "25.0", amountInUsd: "24.9950", minAmountIn: req.amount,
      amountOut: "24950000", amountOutFormatted: "24.95", amountOutUsd: "24.9400", minAmountOut: "24700500",
      depositAddress: ADDRESS, deadline: new Date(Date.parse(req.deadline) + H72).toISOString(),
      timeWhenInactive: new Date(Date.parse(req.deadline) + H72).toISOString(), timeEstimate: 20, refundFee: "0", withdrawFee: "5328",
    },
    quoteRequest: { ...req, depositMode: "SIMPLE", confidentiality: "public", quoteWaitingTimeMs: 0, insured: false,
      appFees: [{ recipient: COLLECTOR, fee: 20 }] },
    signature: "",
    timestamp: new Date(timestamp).toISOString(),
    correlationId: "00000000-0000-4000-8000-000000000000",
  };
}

export interface Mock {
  before?: (a: Answer) => void; // a change 1Click signs (the mock signs after it)
  after?: (a: Answer) => void; // a change after the signature
  key?: KeyObject;
  status?: number;
  throws?: boolean;
  stampedAt?: number;
}
export interface Sent {
  url: string;
  init: RequestInit;
  request: OneClickRequest;
}
export function h1c(m: Mock = {}): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as OneClickRequest;
    sent.push({ url: String(url), init: init ?? {}, request });
    if (m.throws) throw new TypeError("fetch failed");
    if (m.status !== undefined && m.status !== 200)
      return new Response(JSON.stringify({ error: { code: "upstream" } }), { status: m.status, headers: { "content-type": "application/json" } });
    const a = liveAnswer(request, m.stampedAt ?? NOW - 500);
    m.before?.(a);
    signAnswer(a, m.key ?? mockKey.privateKey);
    m.after?.(a);
    return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json", "x-helper-source": "oneclick" } });
  }) as typeof fetch;
  return { fetch: fetchFn, sent };
}

