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
  askDepositQuoteAgain,
  DEPOSIT_QUOTE_TIMEOUT_MS,
  NO_LIQUIDITY_ASK_MIN_MS,
  NO_LIQUIDITY_PAUSES_MS,
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

// Card deposit-quote-no-liquidity: on 1Click's 400 "No liquidity available" the committed ask (askDepositQuoteAgain:
// deposit.quote, pool.address, the refund move) asks the same request again inside the one ask's own 10 s window; the
// display ask (askDepositQuote: the dry lines, the asset list's probes) asks once. The body is 1Click's own, as the
// deployed helper passed it on 10 Nov 19:06:57Z (a dry quote of NEAR USDC into a meme no solver quotes, in 3.5 s).
const NO_LIQ = { status: 400, body: { message: "No liquidity available", correlationId: "2357c43d-9fdf-4c05-9732-edaa447fcb6a", timestamp: "2026-11-10T19:06:57.250Z", path: "/v0/quote" } };
const QUOTED = { status: 201, body: { quote: { amountOut: "24992592" } } };
/** A helper answering `answers` in turn (the last again), each after `ms[i]` of its fake clock, real time 0. */
function replay(answers: { status: number; body: unknown }[], ms: number[] = []) {
  const bodies: string[] = [];
  const timeouts: unknown[] = [];
  let now = 1_000.25;
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    timeouts.push(init?.signal);
    now += ms[bodies.length - 1] ?? 0;
    const a = answers[Math.min(bodies.length, answers.length) - 1]!;
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const waits: number[] = [];
  const sleep = async (t: number) => void (waits.push(t), (now += t));
  return { fetchFn, bodies, waits, sleep, clock: () => now, at: () => now };
}
const req = () => depositQuoteRequest(U, SOL_USDC, 25_000_000n, NOW);

test("committed ask: a no-liquidity answer is asked again, the same request, and the quote that follows comes back", async () => {
  const r = replay([NO_LIQ, NO_LIQ, QUOTED]);
  assert.deepEqual(await askDepositQuoteAgain(req(), r.fetchFn, r.sleep, r.clock), QUOTED);
  assert.deepEqual(r.bodies, Array(3).fill(JSON.stringify(req())));
  assert.deepEqual(r.waits, [...NO_LIQUIDITY_PAUSES_MS]);
  // scripts/live-checks/deposit-quote-no-liquidity.mjs reads these
  assert.deepEqual([...NO_LIQUIDITY_PAUSES_MS], [500, 1_000]);
});

test("display ask: a no-liquidity answer is the one ask's, asked once", async () => {
  const r = replay([NO_LIQ, QUOTED]);
  assert.deepEqual(await askDepositQuote(req(), r.fetchFn), NO_LIQ);
  assert.equal(r.bodies.length, 1);
});

test("review P2-1: a fractional clock and 1Click's real 3.6 s refusals: the re-ask goes, cut at whole ms, inside the one ask's 10 s", async () => {
  // real Node AbortSignal.timeout: a fractional timeout throws RangeError, which must never read as a failed re-ask
  const r = replay([NO_LIQ, NO_LIQ, QUOTED], [3_600.4, 3_600.4, 900]);
  const got = await askDepositQuoteAgain(req(), r.fetchFn, r.sleep, r.clock);
  // 3.6 s, then 0.5 s and 3.6 s: 7.7 s past the first send, 1.3 s left after the next pause: two asks, no third
  assert.deepEqual(got, NO_LIQ);
  assert.equal(r.bodies.length, 2);
  assert.ok(r.at() - 1_000.25 <= DEPOSIT_QUOTE_TIMEOUT_MS, `inside the one ask's window: ${r.at() - 1_000.25}`);
  // a faster first refusal leaves room for the quote
  const fast = replay([NO_LIQ, QUOTED], [1_500.7, 900]);
  assert.deepEqual(await askDepositQuoteAgain(req(), fast.fetchFn, fast.sleep, fast.clock), QUOTED);
  assert.equal(fast.bodies.length, 2);
});

test("review c: the clock is read again after the pause: a late timer leaves too little of the window, and no re-ask starts", async () => {
  const r = replay([NO_LIQ, QUOTED]);
  let now = 0;
  const lateSleep = async (t: number) => void (now += t + 8_000);
  assert.deepEqual(await askDepositQuoteAgain(req(), r.fetchFn, lateSleep, () => now), NO_LIQ);
  assert.equal(r.bodies.length, 1);
  // and a first answer that used the window asks no more
  const late = replay([NO_LIQ, QUOTED], [DEPOSIT_QUOTE_TIMEOUT_MS - NO_LIQUIDITY_PAUSES_MS[0]! - NO_LIQUIDITY_ASK_MIN_MS + 1]);
  assert.deepEqual(await askDepositQuoteAgain(req(), late.fetchFn, late.sleep, late.clock), NO_LIQ);
  assert.equal(late.bodies.length, 1);
});

test("review P2-2: a re-ask the helper answers 429, 503 or 500 leaves the no-liquidity answer standing and asks no more", async () => {
  for (const status of [429, 503, 500, 404]) {
    const r = replay([NO_LIQ, { status, body: { error: { code: "busy" } } }, QUOTED]);
    assert.deepEqual(await askDepositQuoteAgain(req(), r.fetchFn, r.sleep, r.clock), NO_LIQ, String(status));
    assert.equal(r.bodies.length, 2, String(status));
  }
});

test("a re-ask that fails as an ask fails leaves the no-liquidity answer standing; a programming error is thrown", async () => {
  for (const err of [new TypeError("fetch failed"), Object.assign(new Error("t"), { name: "TimeoutError" })]) {
    let n = 0;
    const f = (async () => {
      if (n++ === 0) return new Response(JSON.stringify(NO_LIQ.body), { status: 400, headers: { "content-type": "application/json" } });
      throw err;
    }) as unknown as typeof fetch;
    assert.deepEqual(await askDepositQuoteAgain(req(), f, async () => {}), NO_LIQ);
    assert.equal(n, 2);
  }
  let m = 0;
  const html = (async () => (m++ === 0 ? new Response(JSON.stringify(NO_LIQ.body), { status: 400 }) : new Response("<html>", { status: 200 }))) as unknown as typeof fetch;
  assert.deepEqual(await askDepositQuoteAgain(req(), html, async () => {}), NO_LIQ);
  let k = 0;
  const broken = (async () => {
    if (k++ === 0) return new Response(JSON.stringify(NO_LIQ.body), { status: 400 });
    throw new RangeError("a programming error");
  }) as unknown as typeof fetch;
  await assert.rejects(askDepositQuoteAgain(req(), broken, async () => {}), RangeError);
});

test("the re-ask's own timeout is what is left of the window, in whole ms", async () => {
  let m = 0;
  const hangs = ((_u: string | URL | Request, init?: RequestInit) => {
    if (m++ === 0) return Promise.resolve(new Response(JSON.stringify(NO_LIQ.body), { status: 400 }));
    return Promise.reject(init!.signal!.reason);
  }) as typeof fetch;
  // each ask's timeout as it is asked of AbortSignal.timeout, which answers a signal already cut: no real wait
  const asked: number[] = [];
  const real = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => {
    asked.push(ms);
    return AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
  }) as typeof AbortSignal.timeout;
  try {
    const times = [0.5, DEPOSIT_QUOTE_TIMEOUT_MS - NO_LIQUIDITY_PAUSES_MS[0]! - NO_LIQUIDITY_ASK_MIN_MS + 0.1, DEPOSIT_QUOTE_TIMEOUT_MS - NO_LIQUIDITY_ASK_MIN_MS - 0.3];
    assert.deepEqual(await askDepositQuoteAgain(req(), hangs, async () => {}, () => times.shift() ?? 1e9), NO_LIQ);
  } finally {
    AbortSignal.timeout = real;
  }
  assert.equal(m, 2);
  // the window ends at 10,000.5; the clock reads 7,999.7 after the pause: 2,000.8 is left, asked as 2,000 whole ms
  assert.deepEqual(asked, [DEPOSIT_QUOTE_TIMEOUT_MS, NO_LIQUIDITY_ASK_MIN_MS]);
});

// review of c5959619, P3-a: the window is read on a clock that can be set back while the ask is out
test("a clock set back mid-ask never gives a re-ask more than the one ask's own window", async () => {
  let m = 0;
  const hangs = ((_u: string | URL | Request, init?: RequestInit) => {
    if (m++ === 0) return Promise.resolve(new Response(JSON.stringify(NO_LIQ.body), { status: 400 }));
    return Promise.reject(init!.signal!.reason);
  }) as typeof fetch;
  const asked: number[] = [];
  const real = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => {
    asked.push(ms);
    return AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
  }) as typeof AbortSignal.timeout;
  try {
    for (const back of [5_000, 60_000, 3_600_000]) {
      m = 0;
      asked.length = 0;
      const times = [0, 0, -back];
      assert.deepEqual(await askDepositQuoteAgain(req(), hangs, async () => {}, () => times.shift() ?? 1e9), NO_LIQ);
      assert.deepEqual(asked, [DEPOSIT_QUOTE_TIMEOUT_MS, DEPOSIT_QUOTE_TIMEOUT_MS], String(back));
    }
  } finally {
    AbortSignal.timeout = real;
  }
});

test("any other answer is the one ask's: a 400 about the request, the helper's own 400, 429, 503, a quote", async () => {
  for (const a of [...ABOUT_THE_REQUEST, { status: 400, body: { error: { code: "upstream" } } },
    { status: 400, body: "No liquidity available" }, { status: 200, body: { message: "No liquidity available" } },
    { status: 503, body: { message: "No liquidity available" } },
    { status: 429, body: {} }, { status: 503, body: {} }, QUOTED]) {
    const r = replay([a, QUOTED]);
    assert.deepEqual(await askDepositQuoteAgain(req(), r.fetchFn, r.sleep, r.clock), a, JSON.stringify(a));
    assert.equal(r.bodies.length, 1, JSON.stringify(a));
    assert.deepEqual(r.waits, []);
  }
  assert.equal(noLiquidity(NO_LIQ), true);
});

// Card helper-says-why-a-vendor-refused: live runs 43276439006 and 43289730843 (12 Nov 18:07Z and 19:25Z) had every 1Click
// quote answered 400 for a few minutes, a message other than no liquidity, and green again within the half hour. A 400 that
// is not about the request (1Click's "Failed to get quote", a message the page does not know, none at all) is asked again
// as no liquidity is, twice inside the one ask's window; one about the request (its amount, its pair, a field 1Click
// refuses, a list of what is wrong with it: 1Click's own words, research proofs/p3-coverage and the deposit runs) is the
// one ask's, shown at once.
const ABOUT_THE_REQUEST = [
  "Amount is too low for bridge, try at least 1000000", "Amount is too low for the destination chain",
  "Temporary swap limits: minimum swap amount is $1,000", "Quoting for this pair is not available", "recipient is not valid",
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near is not supported as origin asset",
  "1cs_v1:hypercore:hip1:0x6d1e supports only ORIGIN_CHAIN refundType", "deadline must be in the future",
].map((message) => ({ status: 400, body: { message } })).concat([{ status: 400, body: { message: ["amount must be a string"] } } as never]);
const NOT_ABOUT_IT = [{ message: "Failed to get quote" }, { message: "Something else went wrong" }, { statusCode: 400 }, { message: "Not: No liquidity available" },
  { message: "Invalid token" }]
  .map((body) => ({ status: 400, body }));

test("a 400 that is not about the request is asked again, the same request, twice at most, and the quote that follows comes back", async () => {
  for (const refusal of NOT_ABOUT_IT) {
    const r = replay([refusal, refusal, QUOTED]);
    assert.deepEqual(await askDepositQuoteAgain(req(), r.fetchFn, r.sleep, r.clock), QUOTED, JSON.stringify(refusal));
    assert.deepEqual(r.bodies, Array(3).fill(JSON.stringify(req())));
    assert.deepEqual(r.waits, [...NO_LIQUIDITY_PAUSES_MS]);
    const still = replay([refusal]);
    assert.deepEqual(await askDepositQuoteAgain(req(), still.fetchFn, still.sleep, still.clock), refusal);
    assert.equal(still.bodies.length, 3, "three asks in all, then the refusal stands");
  }
});

test("a 400 about the request is shown at once: one ask, no wait", async () => {
  for (const a of ABOUT_THE_REQUEST) {
    const r = replay([a, QUOTED]);
    assert.deepEqual(await askDepositQuoteAgain(req(), r.fetchFn, r.sleep, r.clock), a, JSON.stringify(a));
    assert.equal(r.bodies.length, 1, JSON.stringify(a));
    assert.deepEqual(r.waits, []);
  }
});

test("a re-ask answered about the request leaves that answer, the request's own, and asks no more", async () => {
  const fails = NOT_ABOUT_IT[0]!;
  const low = ABOUT_THE_REQUEST[0]!;
  const r = replay([fails, low, QUOTED]);
  assert.deepEqual(await askDepositQuoteAgain(req(), r.fetchFn, r.sleep, r.clock), low);
  assert.equal(r.bodies.length, 2);
});

// Review P3 of card helper-says-why-a-vendor-refused: the caller's stop ends the asks. A sign out, a superseded read or a
// refund move's stop during the 500 ms pause sends no second ask; an ask under way is cut; a stop before the first sends none.
test("a stop during the pause ends it: no second ask leaves, and the asks throw the stop's reason", async () => {
  const r = replay([NO_LIQ, QUOTED]);
  const stop = new AbortController();
  let paused = false;
  let pauseEnded = false;
  const sleep = (t: number) => new Promise<void>((ok) => (r.waits.push(t), (paused = true), setTimeout(() => ((pauseEnded = true), ok()), 2_000).unref()));
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetchFn = ((u: string | URL | Request, init?: RequestInit) => (signals.push(init?.signal), r.fetchFn(u, init))) as typeof fetch;
  const asked = askDepositQuoteAgain(req(), fetchFn, sleep, r.clock, stop.signal);
  while (!paused) await new Promise((ok) => setImmediate(ok));
  stop.abort(new Error("signed out"));
  await assert.rejects(asked, /signed out/);
  assert.equal(pauseEnded, false, "the stop ends the pause, not its timer");
  assert.equal(r.bodies.length, 1);
  // every ask carries the stop beside its own timeout
  assert.equal(signals[0]?.aborted, true);
});

test("a stop before the first ask sends none; a stop while an ask is under way cuts it and asks no more", async () => {
  const r = replay([QUOTED]);
  const stop = new AbortController();
  stop.abort(new Error("signed out"));
  await assert.rejects(askDepositQuoteAgain(req(), r.fetchFn, r.sleep, r.clock, stop.signal), /signed out/);
  assert.equal(r.bodies.length, 0);
  const late = new AbortController();
  let sent = 0;
  const hang = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent++;
    if (sent === 1) return new Response(JSON.stringify(NO_LIQ.body), { status: 400, headers: { "content-type": "application/json" } });
    return await new Promise<Response>((_ok, no) => init!.signal!.addEventListener("abort", () => no(init!.signal!.reason)));
  }) as typeof fetch;
  const asked = askDepositQuoteAgain(req(), hang, async () => {}, () => 0, late.signal);
  while (sent < 2) await new Promise((ok) => setImmediate(ok));
  // the callers' stops are AbortErrors (src/main.ts quotesSignedOut, deposit-wire.ts), which a failed ask is too: the
  // stop is thrown, never read as a failed re-ask that leaves the standing answer
  late.abort(new DOMException("superseded", "AbortError"));
  await assert.rejects(asked, /superseded/);
  assert.equal(sent, 2);
});
