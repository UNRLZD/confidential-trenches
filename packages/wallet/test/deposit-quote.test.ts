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
  assert.equal(seen[0].url, "https://api.confidential.unrealized.trade/v1/proxy/oneclick/v0/quote");
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
