// The deposit.quote kind (card wallet-deposit-quote; wallet.md at research 3a6b03e, W:407-409 and the deposit quote row
// W:888) on an H-1c-shaped mock (app.md §5.0, A:1315): a fetch standing in for the helper's 1Click proxy that answers
// in 1Click's own shape (quote, quoteRequest with what 1Click adds, signature, timestamp) and signs each answer with
// the mock's throwaway ed25519 key, which this test process alone adds to the kit's pinned set, as the harness's test
// build does. A good quote gives an address; every bad answer, and a no-PRF seed with no saved backup, gives a code
// and no address.   node --test test/rules-deposit-quote.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOneClickQuote } from "../../kit/src/checks/oneclick.ts";
import { HELPER_BIND_DEPOSIT_CAP } from "../../kit/src/helper/v1.ts";
import { DEPOSIT_QUOTE_URL, depositQuoteRequest } from "../../wallet/src/deposit/quote.ts";
import { depositQuoteKind, type DepositQuoteKindAnswer, type DepositQuoteKindContext } from "../src/rules/deposit-quote.ts";
import { U, ATTACKER, SOL_USDC, NEAR_USDC, ADDRESS, NOW, H72, mockKey, otherKey, signAnswer, FLOOR_OUT, FLOOR_MIN, liveAnswer, h1c, type Answer, type Mock } from "./oneclick-mock.ts";

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

// ---------- the beta cap, the checked time estimate, the priced path (review of 8e01570) ----------

const WNEAR = "nep141:wrap.near";
/** Base units as an exact decimal, as 1Click formats them. */
const fmt = (v: bigint, d: number): string => {
  const t = v.toString().padStart(d + 1, "0");
  const f = t.slice(t.length - d).replace(/0+$/, "");
  return `${t.slice(0, t.length - d)}${f ? `.${f}` : ".0"}`;
};
/** The mock answers at the device's USDC-to-USDC floors for whatever amount was asked (partner path, F 20, S 15). */
const atUsdcFloor = (a: Answer): void => {
  const amountIn = BigInt(a.quote.amountIn as string);
  const out = amountIn - 5_328n - (amountIn * 35n) / 10_000n;
  a.quote.amountInFormatted = fmt(amountIn, 6);
  a.quote.amountOut = out.toString(); a.quote.amountOutFormatted = fmt(out, 6);
  a.quote.minAmountOut = ((out * 9_900n + 9_999n) / 10_000n).toString();
};

test("the beta cap: an amount at HELPER_BIND_DEPOSIT_CAP is quoted, one base unit over is above_max and sends nothing", async () => {
  assert.equal(HELPER_BIND_DEPOSIT_CAP, 1_000_000_000n); // $1,000 in USDC base units
  const at = h1c({ before: atUsdcFloor });
  const ok = await depositQuoteKind({ origin_asset: SOL_USDC, amount: "1000" }, ctx(at.fetch));
  assert.equal(ok.ok, true);
  assert.equal(at.sent[0].request.amount, HELPER_BIND_DEPOSIT_CAP.toString());
  for (const amount of ["1000.000001", "1000000000"]) {
    const over = h1c({ before: atUsdcFloor });
    refusedWith(await depositQuoteKind({ origin_asset: SOL_USDC, amount }, ctx(over.fetch)), "above_max");
    assert.equal(over.sent.length, 0, amount);
  }
});

test("the time estimate comes from the checked quote: the kit hands back the signed timeEstimate", () => {
  const request = depositQuoteRequest(U, SOL_USDC, 25_000_000n, NOW);
  const a = liveAnswer(request, NOW - 500);
  a.quote.timeEstimate = 37;
  signAnswer(a, mockKey.privateKey);
  const checked = checkOneClickQuote(request, a, { path: "partner", pricing: "usdc", decimalsIn: 6, decimalsOut: 6, intoVault: true, now: NOW });
  assert.equal(checked.timeEstimate, 37);
});

test("a signed timeEstimate that is not a whole number of seconds gives no address", async () => {
  for (const t of ["20", -1, 1.5]) {
    const m = h1c({ before: (a) => { a.quote.timeEstimate = t; } });
    refusedWith(await depositQuoteKind(PARAMS, ctx(m.fetch)), "quote_check_failed");
  }
});

// 10 NEAR (24 decimals) at the device's two reads 2.5 and 2.5 into NEAR USDC: the other-pair floor (partner path) is
// ⌈⌈10 × 2.5 × 10^6 × 9,965 / 10,000⌉ × 9,900 / 10,000⌉ − 5,328 = 24,663,375 − 5,328 = 24,658,047, for both amounts.
const NEAR_FLOOR = 24_658_047n;
const nearAt = (out: bigint) => (a: Answer): void => {
  a.quote.amountInFormatted = "10.0";
  a.quote.amountOut = out.toString(); a.quote.amountOutFormatted = fmt(out, 6); a.quote.minAmountOut = out.toString();
};
const near = (reads: [string, string]): Partial<DepositQuoteKindContext> => ({
  priced: (asset) => (asset === WNEAR ? { decimals: 24, pricing: { in: reads, out: ["1", "1"] } } : null),
});

test("a priced asset: a quote at the floor of the device's own price reads passes, in that asset's units", async () => {
  const m = h1c({ before: nearAt(NEAR_FLOOR) });
  const a = await depositQuoteKind({ origin_asset: WNEAR, amount: "10" }, ctx(m.fetch, near(["2.5", "2.5"])));
  assert.equal(m.sent[0].request.amount, "10000000000000000000000000");
  assert.equal(a.ok, true);
  assert.equal(a.ok && a.result.amount_in, "10");
});

test("a priced asset: the same quote under higher price reads is refused (the reads set the floor)", async () => {
  for (const reads of [["2.6", "2.6"], ["2.51", "2.52"]] as [string, string][]) { // the floor takes the lower read
    const m = h1c({ before: nearAt(NEAR_FLOOR) });
    refusedWith(await depositQuoteKind({ origin_asset: WNEAR, amount: "10" }, ctx(m.fetch, near(reads))), "quote_check_failed");
  }
  const m = h1c({ before: nearAt(NEAR_FLOOR - 1n) });
  refusedWith(await depositQuoteKind({ origin_asset: WNEAR, amount: "10" }, ctx(m.fetch, near(["2.5", "2.5"]))), "quote_check_failed");
});

test("a priced asset over the cap at the higher read is above_max before anything is sent", async () => {
  // 400 NEAR at 2.5 is $1,000, the cap: quoted. At reads 2.5 and 2.51 the higher one makes it $1,004: refused.
  const at = h1c({ before: nearAt(NEAR_FLOOR) });
  await depositQuoteKind({ origin_asset: WNEAR, amount: "400" }, ctx(at.fetch, near(["2.5", "2.5"])));
  assert.equal(at.sent.length, 1);
  const over = h1c();
  refusedWith(await depositQuoteKind({ origin_asset: WNEAR, amount: "400" }, ctx(over.fetch, near(["2.5", "2.51"]))), "above_max");
  assert.equal(over.sent.length, 0);
  for (const bad of [["0", "1"], ["x", "1"], ["1e3", "1"]] as [string, string][]) {
    const m = h1c();
    refusedWith(await depositQuoteKind({ origin_asset: WNEAR, amount: "1" }, ctx(m.fetch, near(bad))), "not_allowed");
    assert.equal(m.sent.length, 0);
  }
});

test("a signed amountOut above the cap gives no address (1Click priced it over the device's reads)", async () => {
  const m = h1c({ before: nearAt(HELPER_BIND_DEPOSIT_CAP + 1n) });
  refusedWith(await depositQuoteKind({ origin_asset: WNEAR, amount: "10" }, ctx(m.fetch, near(["2.5", "2.5"]))), "above_max");
});

test("an amount past 2^53 base units is sent exactly, never through a float", async () => {
  const m = h1c();
  const priced = { priced: () => ({ decimals: 18, pricing: { in: ["1", "1"], out: ["1", "1"] } as { in: [string, string]; out: [string, string] } }) };
  await depositQuoteKind({ origin_asset: WNEAR, amount: "0.009007199254740993" }, ctx(m.fetch, priced));
  assert.equal(m.sent.length, 1);
  assert.equal(m.sent[0].request.amount, "9007199254740993");
});
