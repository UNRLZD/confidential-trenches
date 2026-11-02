// The deposit.quote kind (card wallet-deposit-quote; wallet.md at research 3a6b03e, W:407-409 and the deposit quote row
// W:888) on an H-1c-shaped mock (app.md §5.0, A:1315): a fetch standing in for the helper's 1Click proxy that answers
// in 1Click's own shape (quote, quoteRequest with what 1Click adds, signature, timestamp) and signs each answer with
// the mock's throwaway ed25519 key, which this test process alone adds to the kit's pinned set, as the harness's test
// build does. A good quote gives an address; every bad answer, and a no-PRF seed with no saved backup, gives a code
// and no address.   node --test test/rules-deposit-quote.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";
import { ONECLICK_SIGNING_KEYS, type OneClickRequest } from "../../kit/src/checks/oneclick.ts";
import { DEPOSIT_QUOTE_URL } from "../../wallet/src/deposit/quote.ts";
import { depositQuoteKind, type DepositQuoteKindAnswer, type DepositQuoteKindContext } from "../src/rules/deposit-quote.ts";

const U = "5d".repeat(32); // a test U: any 64-hex id; no key of it is used here
const ATTACKER = "e1".repeat(32);
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const COLLECTOR = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"; // the mock's deposit address
const NOW = Date.parse("2026-11-02T06:00:00.000Z");
const H72 = 72 * 3_600_000;

// base58 (Bitcoin alphabet) of bytes; the package has no base58 dependency of its own.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = {
  encode(b: Uint8Array): string {
    let n = 0n, s = "";
    for (const x of b) n = (n << 8n) | BigInt(x);
    for (; n > 0n; n /= 58n) s = B58[Number(n % 58n)] + s;
    for (const x of b) { if (x !== 0) break; s = "1" + s; }
    return s;
  },
};

const mockKey = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519");
const rawPublic = (k: KeyObject): string => `ed25519:${base58.encode(Buffer.from(k.export({ format: "jwk" }).x as string, "base64url"))}`;
(ONECLICK_SIGNING_KEYS as string[]).push(rawPublic(mockKey.publicKey));

type Answer = { quote: Record<string, unknown>; quoteRequest: Record<string, unknown>; signature: string; timestamp: string } & Record<string, unknown>;

// The signed bytes, built apart from the kit (node:crypto, not noble): bs58(sha256(stable-json)) as UTF-8 (D2-D4).
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}
function signAnswer(a: Answer, key: KeyObject): void {
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
const FLOOR_OUT = 24_907_172n, FLOOR_MIN = 24_658_101n;
function liveAnswer(req: OneClickRequest, timestamp: number): Answer {
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

interface Mock {
  before?: (a: Answer) => void; // a change 1Click signs (the mock signs after it)
  after?: (a: Answer) => void; // a change after the signature
  key?: KeyObject;
  status?: number;
  throws?: boolean;
  stampedAt?: number;
}
interface Sent {
  url: string;
  init: RequestInit;
  request: OneClickRequest;
}
function h1c(m: Mock = {}): { fetch: typeof fetch; sent: Sent[] } {
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

const ctx = (fetchFn: typeof fetch, over: Partial<DepositQuoteKindContext> = {}): DepositQuoteKindContext => ({
  seed: { source: "words", code_saved: true }, depositId: U, fetch: fetchFn, now: () => NOW, ...over,
});
const PARAMS = { origin_asset: SOL_USDC, amount: "25" };

/** A refusal: exactly the code, and nothing of the mock's address anywhere in the answer. */
function refusedWith(a: DepositQuoteKindAnswer, code: string): void {
  assert.deepEqual(a, { ok: false, code });
  assert.ok(!JSON.stringify(a).includes(ADDRESS));
}

test("a good quote to U passes and gives the signed address; the request names U as recipient and refundTo", async () => {
  const m = h1c();
  const a = await depositQuoteKind(PARAMS, ctx(m.fetch));
  assert.equal(m.sent.length, 1);
  const { url, init, request } = m.sent[0];
  assert.equal(url, DEPOSIT_QUOTE_URL);
  assert.equal(init.method, "POST");
  assert.deepEqual(request, {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: SOL_USDC, depositType: "ORIGIN_CHAIN",
    destinationAsset: NEAR_USDC, amount: "25000000", refundTo: U, refundType: "INTENTS", recipient: U,
    recipientType: "DESTINATION_CHAIN", deadline: new Date(NOW + 30 * 60_000).toISOString(),
  });
  assert.deepEqual(a, {
    ok: true,
    result: {
      deposit_address: ADDRESS, origin_asset: SOL_USDC, amount_in: "25", min_amount_out: "24.7005",
      deadline: new Date(NOW + 30 * 60_000 + H72).toISOString(), time_estimate_s: 20,
    },
  });
});

test("a quote exactly at the device's floors passes", async () => {
  const m = h1c({ before: (a) => {
    a.quote.amountOut = FLOOR_OUT.toString(); a.quote.amountOutFormatted = "24.907172"; a.quote.minAmountOut = FLOOR_MIN.toString();
  } });
  const a = await depositQuoteKind(PARAMS, ctx(m.fetch));
  assert.equal(a.ok, true);
});

test("a PRF seed is quoted before its backup is saved (the gate is for a no-PRF seed, W:888)", async () => {
  const a = await depositQuoteKind(PARAMS, ctx(h1c().fetch, { seed: { source: "prf", code_saved: false } }));
  assert.equal(a.ok, true);
});

test("a no-PRF seed whose code_saved is false is refused and no request leaves the device", async () => {
  for (const source of ["words", "code", "random", "wallet", null]) {
    const m = h1c();
    refusedWith(await depositQuoteKind(PARAMS, ctx(m.fetch, { seed: { source, code_saved: false } })), "not_allowed");
    assert.equal(m.sent.length, 0, String(source));
  }
});

// Each bad answer the helper (or 1Click) can give: the kit's check refuses it, the kind answers quote_check_failed.
const BAD: [string, Mock][] = [
  ["a bad signature (a key not pinned)", { key: otherKey.privateKey }],
  ["a signed field changed after signing (the deposit address)", { after: (a) => { a.quote.depositAddress = ATTACKER; } }],
  ["a signed field changed after signing (amountOut)", { after: (a) => { a.quote.amountOut = "25000000"; } }],
  ["a dry answer to a live request", { before: (a) => { a.quoteRequest.dry = true; } }],
  ["amountOut one unit under the floor", { before: (a) => {
    a.quote.amountOut = (FLOOR_OUT - 1n).toString(); a.quote.amountOutFormatted = "24.907171"; a.quote.minAmountOut = FLOOR_MIN.toString();
  } }],
  ["minAmountOut one unit under the floor", { before: (a) => { a.quote.minAmountOut = (FLOOR_MIN - 1n).toString(); } }],
  ["a stale timestamp", { stampedAt: NOW - 120_001 }],
  ["a timestamp ahead of the device", { stampedAt: NOW + 60_001 }],
  ["a signed deadline that is not the requested one + 72 h", { before: (a) => {
    a.quote.deadline = new Date(Date.parse(a.quoteRequest.deadline as string) + H72 - 3_600_000).toISOString();
  } }],
  ["a recipient that is not U", { before: (a) => { a.quoteRequest.recipient = ATTACKER; } }],
  ["a refundTo that is not U", { before: (a) => { a.quoteRequest.refundTo = ATTACKER; } }],
  ["refundType ORIGIN_CHAIN", { before: (a) => { a.quoteRequest.refundType = "ORIGIN_CHAIN"; } }],
  ["recipientType INTENTS", { before: (a) => { a.quoteRequest.recipientType = "INTENTS"; } }],
  ["another appFees entry (a helper's own fee)", { before: (a) => { a.quoteRequest.appFees = [{ recipient: ATTACKER, fee: 20 }]; } }],
  ["no answer body in 1Click's shape", { after: (a) => { delete (a as Record<string, unknown>).quote; } }],
];
for (const [name, m] of BAD)
  test(`refused, no address: ${name}`, async () => {
    const mock = h1c(m);
    refusedWith(await depositQuoteKind(PARAMS, ctx(mock.fetch)), "quote_check_failed");
    assert.equal(mock.sent.length, 1);
  });

test("refused, no address: the request's deadline passed before the answer came back", async () => {
  const times = [NOW, NOW + 30 * 60_000 + 1];
  const mock = h1c({ stampedAt: NOW + 30 * 60_000 });
  refusedWith(await depositQuoteKind(PARAMS, ctx(mock.fetch, { now: () => times.shift() ?? NOW })), "quote_check_failed");
});

test("the helper's own refusals give their code and no address", async () => {
  refusedWith(await depositQuoteKind(PARAMS, ctx(h1c({ status: 429 }).fetch)), "busy");
  refusedWith(await depositQuoteKind(PARAMS, ctx(h1c({ status: 503 }).fetch)), "down");
  refusedWith(await depositQuoteKind(PARAMS, ctx(h1c({ status: 400 }).fetch)), "not_available");
  refusedWith(await depositQuoteKind(PARAMS, ctx(h1c({ throws: true }).fetch)), "down");
});

test("a request no rule allows is refused before anything is sent", async () => {
  const cases: [Record<string, unknown>, Partial<DepositQuoteKindContext>][] = [
    [{ origin_asset: "nep141:wrap.near", amount: "1" }, {}], // not USDC, and no price reads
    [{ origin_asset: "nep141:wrap.near", amount: "1" }, { priced: () => null }],
    [{ origin_asset: SOL_USDC, amount: "25.0000001" }, {}], // more digits than USDC has: never rounded
    [{ origin_asset: SOL_USDC, amount: "0" }, {}],
    [{ origin_asset: SOL_USDC, amount: "-1" }, {}],
    [{ origin_asset: SOL_USDC, amount: 25 }, {}],
    [{ origin_asset: 7, amount: "25" }, {}],
    [PARAMS, { depositId: "5D".repeat(32) }], // U must be a 64-hex implicit id
    [PARAMS, { depositId: "alice.near" }],
  ];
  for (const [params, over] of cases) {
    const m = h1c();
    refusedWith(await depositQuoteKind(params, ctx(m.fetch, over)), "not_allowed");
    assert.equal(m.sent.length, 0, JSON.stringify(params));
  }
});
