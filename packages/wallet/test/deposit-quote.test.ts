// The deposit quote's request and its trip through the helper (card wallet-deposit-quote; wallet.md at research
// 3a6b03e, §2.4 step 2, W:408). The request is exactly step 2's, to U; it goes only to the helper's 1Click proxy with
// no cookie and no referrer; the answer comes back as data, capped.   node --test test/deposit-quote.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askDepositQuote,
  DEPOSIT_QUOTE_ANSWER_MAX,
  DEPOSIT_QUOTE_URL,
  depositQuoteRequest,
  NO_LIQUIDITY_ASK_MIN_MS,
  NO_LIQUIDITY_PAUSES_MS,
  NO_LIQUIDITY_SPAN_MS,
  noLiquidity,
} from "../src/deposit/quote.ts";

const U = "5d".repeat(32);
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const NOW = Date.parse("2026-11-02T06:00:00.000Z");

test("the request is §2.4 step 2's: U as recipient and refundTo, INTENTS, DESTINATION_CHAIN, live, nothing more", () => {
  assert.deepEqual(depositQuoteRequest(U, SOL_USDC, 25_000_000n, NOW), {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: SOL_USDC, depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", amount: "25000000",
    refundTo: U, refundType: "INTENTS", recipient: U, recipientType: "DESTINATION_CHAIN", deadline: "2026-11-02T06:30:00.000Z",
  });
});

test("bad input builds no request", () => {
  for (const [u, asset, amount, now] of [
    ["5D".repeat(32), SOL_USDC, 1n, NOW], ["alice.near", SOL_USDC, 1n, NOW], ["5d".repeat(31), SOL_USDC, 1n, NOW],
    [U, "", 1n, NOW], [U, SOL_USDC, 0n, NOW], [U, SOL_USDC, -1n, NOW], [U, SOL_USDC, 1, NOW], [U, SOL_USDC, 1n, Number.NaN],
  ] as [string, string, bigint, number][])
    assert.throws(() => depositQuoteRequest(u, asset, amount, now));
});

test("the request goes to the helper's 1Click proxy only, as it is, with no cookie and no referrer", async () => {
  const request = depositQuoteRequest(U, SOL_USDC, 25_000_000n, NOW);
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response('{"quote":{}}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  assert.deepEqual(await askDepositQuote(request, fetchFn), { status: 200, body: { quote: {} } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote");
  assert.equal(seen[0].url, DEPOSIT_QUOTE_URL);
  const init = seen[0].init;
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "omit");
  assert.equal(init.referrerPolicy, "no-referrer");
  assert.equal(init.redirect, "error");
  assert.equal(init.body, JSON.stringify(request));
});

test("a helper status other than 200 comes back as data, for the caller to refuse", async () => {
  const fetchFn = (async () => new Response('{"error":{"code":"upstream"}}', { status: 503 })) as unknown as typeof fetch;
  assert.deepEqual(await askDepositQuote(depositQuoteRequest(U, SOL_USDC, 1n, NOW), fetchFn), { status: 503, body: { error: { code: "upstream" } } });
});

test("an answer over the cap, or not JSON, throws", async () => {
  const request = depositQuoteRequest(U, SOL_USDC, 1n, NOW);
  const big = (async () => new Response(`"${"a".repeat(DEPOSIT_QUOTE_ANSWER_MAX)}"`, { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(askDepositQuote(request, big), /over/);
  const declared = (async () => new Response("{}", { status: 200, headers: { "content-length": String(DEPOSIT_QUOTE_ANSWER_MAX + 1) } })) as unknown as typeof fetch;
  await assert.rejects(askDepositQuote(request, declared), /over/);
  const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(askDepositQuote(request, html), /not JSON/);
  const bom = (async () => new Response("﻿{}", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(askDepositQuote(request, bom), /not JSON/);
});

// Card deposit-quote-no-liquidity: 1Click's 400 "No liquidity available" (10 Nov 07:04-07:43Z through the helper, 25 USDC
// from Solana; the body's message as research proofs/p3-coverage/results/oneclick-sweep.json holds it) is asked again,
// the same request, a bounded number of times; every other answer comes back from the one ask. The body is 1Click's own,
// as the deployed helper passed it on 10 Nov 19:06:57Z (a dry quote of NEAR USDC into a meme no solver quotes, in 3.5 s).
const NO_LIQ = { status: 400, body: { message: "No liquidity available", correlationId: "2357c43d-9fdf-4c05-9732-edaa447fcb6a", timestamp: "2026-11-10T19:06:57.250Z", path: "/v0/quote" } };
function replay(answers: { status: number; body: unknown }[]) {
  const bodies: string[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const a = answers[Math.min(bodies.length, answers.length) - 1]!;
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  return { fetchFn, bodies, waits, sleep };
}
const QUOTED = { status: 201, body: { quote: { amountOut: "24992592" } } };

test("a no-liquidity answer is asked again, the same request, and the quote that follows comes back", async () => {
  const request = depositQuoteRequest(U, SOL_USDC, 25_000_000n, NOW);
  const r = replay([NO_LIQ, NO_LIQ, QUOTED]);
  assert.deepEqual(await askDepositQuote(request, r.fetchFn, r.sleep), QUOTED);
  assert.deepEqual(r.bodies, Array(3).fill(JSON.stringify(request)));
  assert.deepEqual(r.waits, [...NO_LIQUIDITY_PAUSES_MS]);
});

test("no liquidity on every ask: three asks in all, then the last answer comes back for the caller to refuse", async () => {
  const r = replay([NO_LIQ]);
  assert.deepEqual(await askDepositQuote(depositQuoteRequest(U, SOL_USDC, 25_000_000n, NOW), r.fetchFn, r.sleep), NO_LIQ);
  assert.equal(r.bodies.length, NO_LIQUIDITY_PAUSES_MS.length + 1);
  assert.equal(r.bodies.length, 3);
});

test("the whole ask ends inside the span: each re-ask cut at what is left, none started with too little left", async () => {
  // a re-ask with ASK_MIN left starts, cut at what is left; one with less does not start
  const signals: (AbortSignal | null | undefined)[] = [];
  const r = replay([NO_LIQ, NO_LIQ, QUOTED]);
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => (signals.push(init?.signal), r.fetchFn(url, init))) as typeof fetch;
  const t1 = NO_LIQUIDITY_SPAN_MS - NO_LIQUIDITY_PAUSES_MS[0]! - NO_LIQUIDITY_ASK_MIN_MS;
  const times = [0, t1, t1 + 1];
  assert.deepEqual(await askDepositQuote(depositQuoteRequest(U, SOL_USDC, 1n, NOW), fetchFn, r.sleep, () => times.shift() ?? 1e9), NO_LIQ);
  assert.equal(r.bodies.length, 2, "the second ask starts with ASK_MIN left; the third has less and does not");
  const late = replay([NO_LIQ, QUOTED]);
  const lateTimes = [0, t1 + 1];
  assert.deepEqual(await askDepositQuote(depositQuoteRequest(U, SOL_USDC, 1n, NOW), late.fetchFn, late.sleep, () => lateTimes.shift() ?? 1e9), NO_LIQ);
  assert.equal(late.bodies.length, 1);
  // seconds, never minutes: inside the signing page's 14 s read deadline and the kit client's 15 s
  assert.ok(NO_LIQUIDITY_SPAN_MS <= 12_000 && NO_LIQUIDITY_PAUSES_MS.reduce((a, b) => a + b, 0) <= 2_000);
});

test("a re-ask that fails leaves the no-liquidity answer standing: a throw, a timeout", async () => {
  let n = 0;
  const throws = (async () => {
    if (n++ === 0) return new Response(JSON.stringify(NO_LIQ.body), { status: 400, headers: { "content-type": "application/json" } });
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  assert.deepEqual(await askDepositQuote(depositQuoteRequest(U, SOL_USDC, 1n, NOW), throws, async () => {}), NO_LIQ);
  assert.equal(n, 2, "one re-ask, then the answer stands");
  // the re-ask's own timeout is what is left of the span, never the 10 s of one ask
  let m = 0;
  const hangs = ((_u: string | URL | Request, init?: RequestInit) => {
    if (m++ === 0) return Promise.resolve(new Response(JSON.stringify(NO_LIQ.body), { status: 400 }));
    return new Promise<Response>((_ok, no) => init?.signal?.addEventListener("abort", () => no(init.signal!.reason), { once: true }));
  }) as typeof fetch;
  const t0 = Date.now();
  const times = [0, NO_LIQUIDITY_SPAN_MS - NO_LIQUIDITY_PAUSES_MS[0]! - NO_LIQUIDITY_ASK_MIN_MS];
  assert.deepEqual(await askDepositQuote(depositQuoteRequest(U, SOL_USDC, 1n, NOW), hangs, async () => {}, () => times.shift() ?? 1e9), NO_LIQ);
  const took = Date.now() - t0;
  assert.ok(took >= NO_LIQUIDITY_ASK_MIN_MS - 50 && took < NO_LIQUIDITY_ASK_MIN_MS + 1_000, `cut at what was left: ${took} ms`);
});

test("any other answer is the one ask's: a 400 of another message, 429, 503, a quote", async () => {
  for (const a of [{ status: 400, body: { message: "amount is too low" } }, { status: 400, body: { error: { code: "upstream" } } },
    { status: 400, body: "No liquidity available" }, { status: 200, body: { message: "No liquidity available" } },
    { status: 429, body: {} }, { status: 503, body: {} }, QUOTED]) {
    const r = replay([a, QUOTED]);
    assert.deepEqual(await askDepositQuote(depositQuoteRequest(U, SOL_USDC, 1n, NOW), r.fetchFn, r.sleep), a, JSON.stringify(a));
    assert.equal(r.bodies.length, 1, JSON.stringify(a));
    assert.deepEqual(r.waits, []);
  }
  assert.equal(noLiquidity(NO_LIQ), true);
});
