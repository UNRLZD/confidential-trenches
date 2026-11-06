// The deposit sheet's reads before any address (card kit-deposit-assets-dry; src/rules/deposit-dry.ts, src/deposit-wire.ts
// depositReadHosts): deposit.assets and deposit.dry through the frame's API over the real wallet store (fake-indexeddb,
// src/state.ts frameState, as the frame runs), and below_min in deposit.quote and deposit.dry, before any request and
// off a verified answer. 1Click is a mock that answers dry quotes in its own shape, signed with a throwaway key the
// importing test process adds to the kit's pinned set (./oneclick-mock.ts), and the token list as 1Click lists it.
//   node --test test/deposit-dry.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStoreReader, type DepositRecord } from "@blindfill/wallet/store";
import { ONECLICK_USDC_ASSETS, ONECLICK_VAULT_MIN_OUT, oneClickFloors, type OneClickRequest } from "../../kit/src/checks/oneclick.ts";
import { DEPOSIT_DRY_PLACEHOLDER, DEPOSIT_REFUSALS, SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import * as KIT from "../../kit/src/index.ts";
import { APP_ORIGIN, signedOutState, startApi, type IncomingMessage } from "../src/api.ts";
import { depositQuoteHost, depositReadHosts, type DepositPublic } from "../src/deposit-wire.ts";
import { DEPOSIT_TOKENS_MAX, DEPOSIT_TOKENS_URL, belowDepositBound, depositMinimum, signedWithdrawFee } from "../src/rules/deposit-dry.ts";
import { depositQuoteKind } from "../src/rules/deposit-quote.ts";
import { frameState } from "../src/state.ts";
import { COLLECTOR, NEAR_USDC, NOW, SOL_USDC, U, mockKey, signAnswer, type Answer } from "./oneclick-mock.ts";

const BASE_USDC = ONECLICK_USDC_ASSETS[2]!;
const W = 5_538n; // 1Click's withdraw fee into a fresh NEAR id (wallet.md D52)
const TOKENS = [
  { assetId: NEAR_USDC, decimals: 6, blockchain: "near", symbol: "USDC", price: 0.9995 },
  { assetId: BASE_USDC, decimals: 6, blockchain: "base", symbol: "USDC", price: 0.9995 },
  { assetId: SOL_USDC, decimals: 6, blockchain: "sol", symbol: "USDC", price: 0.9995 },
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 2.4 },
];

const dec6 = (v: bigint): string => {
  const s = v.toString().padStart(7, "0");
  const f = s.slice(-6).replace(/0+$/, "");
  return f ? `${s.slice(0, -6)}.${f}` : s.slice(0, -6);
};

/** 1Click's dry answer to `req`, honest: `spread` bps over its fee (5; 15 is the device's own cap, an answer at its
 *  floor), W off, min out 1 % under. */
function dryAnswer(req: OneClickRequest, w = W, spread = 5, fee = 20): Answer {
  const a = BigInt(req.amount);
  const same = req.originAsset === req.destinationAsset;
  const out = a - w - (a * BigInt((same ? 0 : fee) + spread)) / 10_000n;
  const min = (out * 9_900n + 9_999n) / 10_000n;
  return {
    quote: { amountIn: req.amount, amountInFormatted: dec6(a), amountInUsd: "0", minAmountIn: req.amount, amountOut: out.toString(),
      amountOutFormatted: dec6(out), amountOutUsd: "0", minAmountOut: min.toString(), timeEstimate: 20, refundFee: "0", withdrawFee: w.toString() },
    quoteRequest: { ...req, depositMode: "SIMPLE", confidentiality: "public", quoteWaitingTimeMs: 0, insured: false,
      appFees: same ? [] : [{ recipient: COLLECTOR, fee }] },
    signature: "",
    timestamp: new Date(NOW - 500).toISOString(),
  };
}

interface Net {
  tokens?: { status?: number; body?: unknown; throws?: boolean; response?: () => Response };
  /** Every request waits until its signal aborts (`deaf`: forever, its signal unheard). */
  hang?: "heard" | "deaf";
  quote?: { status?: number; throws?: boolean; w?: bigint; spread?: number; fee?: number; before?: (a: Answer) => void; after?: (a: Answer) => void };
  /** Per-origin overrides of `quote`. */
  by?: Record<string, Net["quote"]>;
}
/** The helper's 1Click proxy, as data: every request it got. */
function helper(net: Net = {}) {
  const sent: { url: string; method: string; body?: OneClickRequest }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (net.hang) {
      sent.push({ url: u, method });
      return new Promise<Response>((_ok, no) => {
        if (net.hang === "heard") init?.signal?.addEventListener("abort", () => no(init.signal!.reason), { once: true });
      });
    }
    if (u === DEPOSIT_TOKENS_URL) {
      sent.push({ url: u, method });
      // the helper takes a proxy call as a POST only (apps/helper/src/server.ts), whatever the upstream's method
      if (method !== "POST") return new Response(JSON.stringify({ error: { code: "method_not_allowed" } }), { status: 405 });
      const t = net.tokens ?? {};
      if (t.throws) throw new TypeError("fetch failed");
      if (t.response) return t.response();
      return new Response(JSON.stringify(t.body ?? TOKENS), { status: t.status ?? 200, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body)) as OneClickRequest;
    sent.push({ url: u, method, body });
    const q = net.by?.[body.originAsset] ?? net.quote ?? {};
    if (q.throws) throw new TypeError("fetch failed");
    if (q.status !== undefined && q.status !== 200) return new Response("{}", { status: q.status, headers: { "content-type": "application/json" } });
    const a = dryAnswer(body, q.w, q.spread, q.fee);
    q.before?.(a);
    signAnswer(a, mockKey.privateKey);
    q.after?.(a);
    // 1Click answers a quote 201 (wallet.md D52), and the helper passes the status on
    return new Response(JSON.stringify(a), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchFn, sent };
}

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));
let n = 0;
/** The frame's page over a real, empty wallet store (signed out), answering the two reads, as main.ts wires the frame. */
function frame(net: Net = {}, deadlineMs?: number) {
  const h = helper(net);
  const idb = new IDBFactory();
  const fs = frameState((onEvent) => openWalletStoreReader({ indexedDB: idb, name: `deposit-dry-${process.pid}-${n++}`, onEvent }), () => {});
  closers.push(() => fs.close());
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown, to: string) => void (to === APP_ORIGIN && posted.push(msg)) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  const api = startApi({ parent, listen: (fn) => (listener = fn), state: fs.state, watch: fs.watch, kinds: { ...depositReadHosts({ fetch: h.fetch, now: () => NOW, deadlineMs }) } });
  const send = (data: unknown) => listener!({ origin: APP_ORIGIN, source: parent, data });
  send({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION });
  // the reads are Running kinds (src/deposit-wire.ts): the queue does not wait for them, so wait for the answer itself
  const answerOf = async (id: string, count = 1) => {
    for (let i = 0; i < 2_000; i++) {
      await api.idle();
      const got = posted.filter((m) => (m as { id?: string }).id === id);
      if (got.length >= count) return got.at(-1) as { ok: boolean; result?: Record<string, unknown>; error?: { code: string } };
      await new Promise((ok) => setTimeout(ok, 1));
    }
    assert.fail(`no answer to ${id}`);
  };
  const ask = async (data: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    send({ v: 1, id, ...data });
    return answerOf(id);
  };
  return { ask, send, answerOf, idle: () => api.idle(), sent: h.sent, posted, fs };
}

const ASSETS = { type: "deposit.assets" };
const dry = (amount: string, origin_asset = SOL_USDC) => ({ type: "deposit.dry", origin_asset, amount });

// ------------------------------------------------------------------------------------------------ the minimum
test("the minimum is the least amount whose floor clears MIN_DEPOSIT at the fee, found on oneClickFloors itself", () => {
  // by hand: amountOut ≥ 1,010,101 makes ⌈amountOut × 0.99⌉ ≥ 1,000,000; then A − ⌊A × 35 / 10,000⌋ ≥ 1,010,101 + 5,538
  assert.equal(depositMinimum(SOL_USDC, W), 1_019_206n);
  assert.equal(depositMinimum(BASE_USDC, W), 1_019_206n);
  // the same asset pays no fee to 1Click: A − ⌊A × 15 / 10,000⌋ ≥ 1,015,639
  assert.equal(depositMinimum(NEAR_USDC, W), 1_017_164n);
  // with no withdraw fee; on the keyless path (fee 1): A − ⌊A × 16 / 10,000⌋ ≥ 1,015,639
  assert.equal(depositMinimum(SOL_USDC, 0n), 1_013_648n);
  assert.equal(depositMinimum(SOL_USDC, W, "keyless"), 1_017_266n);
  for (const [asset, w, path] of [[SOL_USDC, W, "partner"], [NEAR_USDC, W, "partner"], [SOL_USDC, 0n, "partner"], [SOL_USDC, 123_456n, "partner"], [SOL_USDC, W, "keyless"], [SOL_USDC, 0n, "keyless"]] as const) {
    const m = depositMinimum(asset, w, path)!;
    const f = (a: bigint) => oneClickFloors({ amountIn: a, withdrawFee: w, slippageBps: 100, feeBps: asset === NEAR_USDC ? 0 : path === "partner" ? 20 : 1, pricing: "usdc", decimalsIn: 6, decimalsOut: 6, intoVault: false }).minAmountOut;
    assert.ok(f(m) >= ONECLICK_VAULT_MIN_OUT && f(m - 1n) < ONECLICK_VAULT_MIN_OUT, `${asset} at ${w} on ${path}`);
  }
  // a fee no amount up to the cap clears: no minimum
  assert.equal(depositMinimum(SOL_USDC, 10n ** 12n), null);
  // the bound before any request: no withdraw fee, the least path fee (keyless, 1): A − ⌊A × 16 / 10,000⌋ ≥ 1,010,101
  assert.equal(depositMinimum(SOL_USDC, 0n, "keyless"), 1_011_719n);
  assert.equal(belowDepositBound(SOL_USDC, 1_011_718n), true);
  assert.equal(belowDepositBound(SOL_USDC, 1_011_719n), false);
});

// ------------------------------------------------------------------------------------------------ deposit.assets
test("deposit.assets through the frame, signed out: the three assets as 1Click lists them, each minimum at the fee just quoted, the cap as max_usd", async () => {
  const f = frame();
  const a = await f.ask(ASSETS);
  assert.deepEqual(a.result, {
    assets: [
      { origin_asset: NEAR_USDC, chain: "near", symbol: "USDC", decimals: 6, min: "1.017164", max_usd: "1000" },
      { origin_asset: SOL_USDC, chain: "solana", symbol: "USDC", decimals: 6, min: "1.019206", max_usd: "1000" },
      { origin_asset: BASE_USDC, chain: "base", symbol: "USDC", decimals: 6, min: "1.019206", max_usd: "1000" },
    ],
  });
  assert.equal(SIGNPAGE_RESULT_SCHEMAS["deposit.assets"](a.result), true, "the kit's client takes it");
  // the token list, then one dry quote per asset, each to the placeholder: nothing of the user's
  assert.deepEqual(f.sent.map((s) => s.method), ["POST", "POST", "POST", "POST"]);
  for (const s of f.sent.slice(1)) {
    assert.equal(s.body!.dry, true);
    assert.equal(s.body!.recipient, DEPOSIT_DRY_PLACEHOLDER);
    assert.equal(s.body!.refundTo, DEPOSIT_DRY_PLACEHOLDER);
  }
});

test("deposit.assets: the minimum follows 1Click's quoted withdraw fee, per asset", async () => {
  const f = frame({ by: { [SOL_USDC]: { w: 0n } } });
  const a = await f.ask(ASSETS);
  const sol = (a.result!.assets as { origin_asset: string; min: string }[]).find((x) => x.origin_asset === SOL_USDC)!;
  assert.equal(sol.min, "1.013648");
});

test("deposit.assets: an asset 1Click does not list as the release has it, or whose quote fails a check, is left out", async () => {
  const cases: [string, Net, string[]][] = [
    ["Solana's USDC not listed", { tokens: { body: TOKENS.filter((t) => t.assetId !== SOL_USDC) } }, [NEAR_USDC, BASE_USDC]],
    ["another symbol", { tokens: { body: TOKENS.map((t) => (t.assetId === BASE_USDC ? { ...t, symbol: "USDT" } : t)) } }, [NEAR_USDC, SOL_USDC]],
    ["other decimals", { tokens: { body: TOKENS.map((t) => (t.assetId === BASE_USDC ? { ...t, decimals: 18 } : t)) } }, [NEAR_USDC, SOL_USDC]],
    ["another blockchain", { tokens: { body: TOKENS.map((t) => (t.assetId === SOL_USDC ? { ...t, blockchain: "near" } : t)) } }, [NEAR_USDC, BASE_USDC]],
    ["a quote signed by another key", { by: { [SOL_USDC]: { after: (x) => void (x.quote.amountOut = String(BigInt(String(x.quote.amountOut)) + 1n)) } } }, [NEAR_USDC, BASE_USDC]],
    ["a quote to another recipient", { by: { [BASE_USDC]: { before: (x) => void (x.quoteRequest.recipient = U) } } }, [NEAR_USDC, SOL_USDC]],
    ["a fee no amount clears", { by: { [NEAR_USDC]: { w: 900_000_000n } } }, [SOL_USDC, BASE_USDC]],
  ];
  for (const [name, net, ids] of cases) {
    const a = await frame(net).ask(ASSETS);
    assert.deepEqual((a.result?.assets as { origin_asset: string }[] | undefined)?.map((x) => x.origin_asset), ids, name);
  }
  const none = await frame({ tokens: { body: [] } }).ask(ASSETS);
  assert.deepEqual(none.error, { code: "not_available" }, "none left");
  const notList = await frame({ tokens: { body: { tokens: TOKENS } } }).ask(ASSETS);
  assert.deepEqual(notList.error, { code: "not_available" }, "a list that is not one");
});

test("deposit.assets: the helper busy or down answers that code, not kept, so the same request again runs again", async () => {
  for (const [net, code] of [
    [{ tokens: { status: 429 } }, "busy"], [{ tokens: { status: 503 } }, "down"], [{ tokens: { throws: true } }, "down"], [{ tokens: { status: 500 } }, "not_available"],
    [{ by: { [BASE_USDC]: { status: 429 } } }, "busy"], [{ quote: { status: 503 } }, "down"], [{ by: { [SOL_USDC]: { throws: true } } }, "down"],
  ] as [Net, string][]) {
    const f = frame(net);
    const id = crypto.randomUUID();
    f.send({ v: 1, id, ...ASSETS });
    assert.deepEqual(await f.answerOf(id), { v: 1, id, ok: false, error: { code } }, JSON.stringify(net));
    const before = f.sent.length;
    f.send({ v: 1, id, ...ASSETS });
    await f.answerOf(id, 2);
    const again = f.sent.length > before;
    assert.equal(again, code === "busy" || code === "down", `${code}: run again only when not now`);
  }
});

// ------------------------------------------------------------------------------------------------ deposit.dry
test("deposit.dry through the frame, signed out: the checked dry quote's lines in USD and 1Click's own time, to the placeholder", async () => {
  const f = frame();
  const a = await f.ask(dry("25"));
  // 25,000,000 − 5,538 − ⌊25,000,000 × 25 / 10,000⌋ = 24,931,962; min out ⌈× 0.99⌉ = 24,682,643
  assert.deepEqual(a.result, { amount_out_usd: "24.931962", min_amount_out_usd: "24.682643", fee_usd: "0.068038", time_estimate_s: 20 });
  assert.equal(SIGNPAGE_RESULT_SCHEMAS["deposit.dry"](a.result), true, "the kit's client takes it");
  assert.equal(f.sent.length, 1);
  const r = f.sent[0]!.body!;
  assert.deepEqual(r, {
    dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: SOL_USDC, depositType: "ORIGIN_CHAIN",
    destinationAsset: NEAR_USDC, amount: "25000000", refundTo: DEPOSIT_DRY_PLACEHOLDER, refundType: "INTENTS",
    recipient: DEPOSIT_DRY_PLACEHOLDER, recipientType: "DESTINATION_CHAIN", deadline: new Date(NOW + 30 * 60_000).toISOString(),
  });
});

test("deposit.dry and deposit.assets: a fee entry of 1Click's keyless path (fee 1, as the helper's dry quotes named on 6 Nov 14:06Z) is taken, its floor held at that fee; any other fee is quote_check_failed", async () => {
  const keyless: Net = { quote: { fee: 1 } };
  // 25,000,000 − 5,538 − ⌊25,000,000 × 6 / 10,000⌋ = 24,979,462, less the live quote's 19 bps more (47,500): the lines
  // at deposit.quote's fee (card review item 3)
  assert.deepEqual((await frame(keyless).ask(dry("25"))).result, { amount_out_usd: "24.931962", min_amount_out_usd: "24.682168", fee_usd: "0.068038", time_estimate_s: 20 });
  const sol = ((await frame({ by: { [SOL_USDC]: { fee: 1 } } }).ask(ASSETS)).result!.assets as { origin_asset: string; min: string }[]).find((x) => x.origin_asset === SOL_USDC)!;
  // the minimum at the live quote's fee (partner, 20), never the dry entry's (keyless 1 gives 1.017266)
  assert.equal(sol.min, "1.019206");
  // the keyless floor on an answer cut to the partner's fee: refused, the floor is the fee the entry names
  assert.deepEqual((await frame({ quote: { fee: 1, spread: 24 } }).ask(dry("25"))).error, { code: "quote_check_failed" });
  for (const fee of [0, 2, 19, 21, 100]) assert.deepEqual((await frame({ quote: { fee } }).ask(dry("25"))).error, { code: "quote_check_failed" }, String(fee));
  assert.deepEqual((await frame({ quote: { after: (x) => void (x.quoteRequest.appFees = [{ recipient: U, fee: 1 }]) } }).ask(dry("25"))).error, { code: "quote_check_failed" }, "another collector");
});

test("deposit.dry: the time is the dry answer's own (not signed), checked as a whole number of seconds", async () => {
  assert.equal((await frame({ quote: { after: (x) => void (x.quote.timeEstimate = 45) } }).ask(dry("25"))).result!.time_estimate_s, 45);
  for (const t of [-1, 1.5, "20", undefined, Number.MAX_SAFE_INTEGER + 2])
    assert.deepEqual((await frame({ quote: { after: (x) => void (x.quote.timeEstimate = t) } }).ask(dry("25"))).error, { code: "quote_check_failed" }, String(t));
});

test("deposit.dry: below_min before any request, under the bound no fee lowers; above_max over the cap; a bad asset or amount not_allowed", async () => {
  for (const [amount, code] of [["1.011718", "below_min"], ["0.5", "below_min"], ["0.000001", "below_min"], ["1000.000001", "above_max"], ["0", "not_allowed"], ["1.0000001", "not_allowed"]]) {
    const f = frame();
    assert.deepEqual((await f.ask(dry(amount))).error, { code }, amount);
    assert.equal(f.sent.length, 0, `${amount}: nothing sent`);
  }
  for (const origin of ["nep141:wrap.near", "nep141:attacker.near"]) {
    const f = frame();
    assert.deepEqual((await f.ask(dry("25", origin))).error, { code: "not_allowed" }, origin);
    assert.equal(f.sent.length, 0);
  }
  // at the bound the request goes, and the quote at 1Click's fee says it is still below: below_min off the checked answer
  const f = frame();
  assert.deepEqual((await f.ask(dry("1.011719"))).error, { code: "below_min" });
  assert.equal(f.sent.length, 1);
  // an answer at the device's own floor: at the minimum deposit.assets gave it lands, one unit under it is below_min
  const atFloor: Net = { quote: { spread: 15 } };
  assert.equal((await frame(atFloor).ask(dry("1.019206"))).ok, true);
  assert.deepEqual((await frame(atFloor).ask(dry("1.019205"))).error, { code: "below_min" });
  // a kinder answer than the floor clears MIN_DEPOSIT under the minimum: the device takes it, it never refuses a quote that lands
  assert.equal((await frame().ask(dry("1.019205"))).ok, true);
});

test("deposit.dry: an answer that fails a check is quote_check_failed, never below_min, even under the minimum", async () => {
  const cases: [string, Net][] = [
    ["a changed amount out after signing", { quote: { after: (x) => void (x.quote.amountOut = "1") } }],
    ["another recipient", { quote: { before: (x) => void (x.quoteRequest.recipient = U) } }],
    ["a live answer to a dry request", { quote: { before: (x) => void (x.quoteRequest.dry = false) } }],
    ["1Click's floor cut, signed", { quote: { before: (x) => void ((x.quote.amountOut = "900000"), (x.quote.amountOutFormatted = "0.9"), (x.quote.minAmountOut = "890000")) } }],
  ];
  for (const [name, net] of cases) {
    assert.deepEqual((await frame(net).ask(dry("1.011719"))).error, { code: "quote_check_failed" }, `${name} at the bound`);
    assert.deepEqual((await frame(net).ask(dry("25"))).error, { code: "quote_check_failed" }, `${name} at 25`);
  }
});

test("deposit.dry: the helper's codes, busy and down not kept", async () => {
  for (const [q, code] of [[{ status: 429 }, "busy"], [{ status: 503 }, "down"], [{ throws: true }, "down"], [{ status: 400 }, "not_available"]] as const)
    assert.deepEqual((await frame({ quote: q }).ask(dry("25"))).error, { code }, code);
});

// ------------------------------------------------------------------------------------------------ deposit.quote
const RECORD: DepositRecord = { v: 1, scope: "7", index: 3, id: U };
const SAVED: DepositPublic = { status: { source: "code", code_saved: true }, deposit: RECORD };
/** deposit.quote's page (src/deposit-wire.ts) with `fetch` as the helper. */
function quotePage(fetchFn: typeof fetch) {
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  const api = startApi({ parent, listen: (fn) => (listener = fn), state: () => signedOutState(),
    kinds: { "deposit.quote": depositQuoteHost({ scope: () => 7n, read: async () => SAVED, fetch: fetchFn, now: () => NOW, checked: async () => {} }) } });
  return async (amount: string) => {
    const id = crypto.randomUUID();
    listener!({ origin: APP_ORIGIN, source: parent, data: { v: 1, id, type: "deposit.quote", origin_asset: SOL_USDC, amount } });
    await api.idle();
    return posted.at(-1) as { ok: boolean; error?: { code: string } };
  };
}
/** 1Click's live answer to a deposit to U, honest at its fee, signed. */
function liveFetch(sent: OneClickRequest[], tamper?: (a: Answer) => void, spread = 15, status = 201, fee = 20): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as OneClickRequest;
    sent.push(req);
    const a = dryAnswer(req, W, spread, fee);
    const deadline = new Date(Date.parse(req.deadline) + 72 * 3_600_000).toISOString();
    Object.assign(a.quote, { depositAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", deadline, timeWhenInactive: deadline });
    tamper?.(a);
    signAnswer(a, mockKey.privateKey);
    return new Response(JSON.stringify(a), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("deposit.quote: 1Click's 201 is an answer, as its 200 (it answered 201 through the helper, 6 Nov 14:02Z); any other status not_available", async () => {
  for (const status of [200, 201]) assert.equal((await quotePage(liveFetch([], undefined, 15, status))("25")).ok, true, String(status));
  for (const status of [202, 302, 400]) assert.deepEqual((await quotePage(liveFetch([], undefined, 15, status))("25")).error, { code: "not_available" }, String(status));
});

test("deposit.quote: below_min before any request under the bound, and off the verified answer above it; the address at the minimum", async () => {
  const sent: OneClickRequest[] = [];
  const ask = quotePage(liveFetch(sent));
  assert.deepEqual((await ask("1.011718")).error, { code: "below_min" });
  assert.deepEqual((await ask("0.5")).error, { code: "below_min" });
  assert.equal(sent.length, 0, "nothing sent under the bound");
  assert.deepEqual((await ask("1.011719")).error, { code: "below_min" });
  assert.deepEqual((await ask("1.019205")).error, { code: "below_min" });
  assert.equal(sent.length, 2);
  assert.equal((await ask("1.019206")).ok, true);
  // an answer that fails another check stays quote_check_failed under the minimum
  const ask2 = quotePage(liveFetch([], (a) => void (a.quoteRequest.refundTo = DEPOSIT_DRY_PLACEHOLDER)));
  assert.deepEqual((await ask2("1.011719")).error, { code: "quote_check_failed" });
});

// ------------------------------------------------------------------------------------------------ the kit's entry
test("the kit's entry names the refusals, the placeholder and the shapes an app reads", () => {
  assert.deepEqual([...KIT.DEPOSIT_REFUSALS], ["below_min", "above_max", "not_available", "busy", "down", "quote_check_failed", "not_allowed"]);
  assert.equal(KIT.DEPOSIT_REFUSALS, DEPOSIT_REFUSALS);
  assert.equal(KIT.DEPOSIT_DRY_PLACEHOLDER, DEPOSIT_DRY_PLACEHOLDER);
  assert.match(DEPOSIT_DRY_PLACEHOLDER, /^[0-9a-f]{64}$/);
  assert.ok(KIT.SIGNPAGE_KINDS.includes("deposit.assets") && KIT.SIGNPAGE_KINDS.includes("deposit.dry"));
});

// ------------------------------------------------------------------------------------------------ review folds
test("review 2: a withdrawFee rewritten after 1Click signed cannot move the minimum past what the signed amounts allow", async () => {
  // 1Click's answer at its fee and W exactly (no spread), so the signed amounts leave room for W and no more
  const minOf = async (q: Net["quote"]) =>
    ((await frame({ quote: q }).ask(ASSETS)).result!.assets as { origin_asset: string; min: string }[]).find((x) => x.origin_asset === SOL_USDC)!.min;
  const honest = await minOf({ spread: 0 });
  assert.equal(honest, "1.019206");
  for (const w of ["5000000", "9900000"])
    assert.equal(await minOf({ spread: 0, after: (x) => void (x.quote.withdrawFee = w) }), honest, `withdrawFee rewritten to ${w}`);
  // one the fees then take the whole probe with: the device's own floor refuses the answer, the asset is left out
  assert.deepEqual((await frame({ quote: { spread: 0, after: (x) => void (x.quote.withdrawFee = "999999999") } }).ask(ASSETS)).error, { code: "not_available" });
  // with 1Click's own 5 bps spread the room is W + 5 bps of the probe: the figure counts up to that and no more
  const room = await minOf({ spread: 5, after: (x) => void (x.quote.withdrawFee = "9900000") });
  assert.equal(room, (Number(depositMinimum(SOL_USDC, 5_538n + 5_000n)) / 1e6).toString());
  // the bound itself
  assert.equal(signedWithdrawFee({ amountIn: 10_000_000n, amountOut: 9_974_462n, unsignedDryWithdrawFee: 9_000_000n }, 20), 5_538n);
  assert.equal(signedWithdrawFee({ amountIn: 10_000_000n, amountOut: 9_974_462n, unsignedDryWithdrawFee: 4_000n }, 20), 4_000n);
  assert.equal(signedWithdrawFee({ amountIn: 10_000_000n, amountOut: 10_000_000n, unsignedDryWithdrawFee: 4_000n }, 20), 0n);
});

test("review 3: at the minimum deposit.assets showed from keyless dry entries, the live deposit.quote (partner, at its floor) gives the address", async () => {
  const shown = ((await frame({ quote: { fee: 1 } }).ask(ASSETS)).result!.assets as { origin_asset: string; min: string }[]).find((x) => x.origin_asset === SOL_USDC)!.min;
  assert.equal((await quotePage(liveFetch([], undefined, 15))(shown)).ok, true, `deposit.quote at the shown ${shown}`);
  // and a dry quote under the live fee's minimum is below_min even when the keyless entry would clear it
  assert.deepEqual((await frame({ quote: { fee: 1, spread: 15 } }).ask(dry("1.017266"))).error, { code: "below_min" });
});

test("review 4: each read answers within its deadline, down, and holds no other message meanwhile (a Running kind)", async () => {
  for (const hang of ["heard", "deaf"] as const) {
    for (const kind of [ASSETS, dry("25")]) {
      const f = frame({ hang }, 50);
      const id = crypto.randomUUID();
      const t0 = Date.now();
      f.send({ v: 1, id, ...kind });
      // a state request after it is answered first: the read holds no queue
      const sid = crypto.randomUUID();
      f.send({ v: 1, id: sid, type: "state" });
      const st = await f.answerOf(sid);
      assert.equal(st.ok, true);
      assert.equal(f.posted.some((m) => (m as { id?: string }).id === id), false, "the read is still running");
      assert.deepEqual(await f.answerOf(id), { v: 1, id, ok: false, error: { code: "down" } }, `${hang} ${kind.type}`);
      assert.ok(Date.now() - t0 < 2_000, "cut at the deadline");
    }
  }
  // the deadline the page runs at sits inside the kit client's window for both kinds
  const { DEPOSIT_READ_DEADLINE_MS } = await import("../src/deposit-wire.ts");
  const { SIGNPAGE_TIMEOUT_MS } = await import("../../kit/src/signpage/client.ts");
  assert.ok(DEPOSIT_READ_DEADLINE_MS < SIGNPAGE_TIMEOUT_MS["deposit.assets"]! && DEPOSIT_READ_DEADLINE_MS < SIGNPAGE_TIMEOUT_MS["deposit.dry"]!);
});

test("review 6: the token list's cap, declared or streamed, and a list that is not JSON, are not_available", async () => {
  // each a good list but for its size, so only the cap refuses it
  const list = JSON.stringify(TOKENS);
  const big = new TextEncoder().encode(list.padEnd(DEPOSIT_TOKENS_MAX + 1, " "));
  const cases: [string, () => Response][] = [
    ["declared over the cap", () => new Response(list, { status: 200, headers: { "content-length": String(DEPOSIT_TOKENS_MAX + 1) } })],
    ["streamed over the cap", () => new Response(new ReadableStream({ start(c) { c.enqueue(big.slice(0, 1_000)); c.enqueue(big.slice(1_000)); c.close(); } }), { status: 200 })],
    ["not JSON", () => new Response("<html>", { status: 200 })],
  ];
  for (const [name, response] of cases) assert.deepEqual((await frame({ tokens: { response } }).ask(ASSETS)).error, { code: "not_available" }, name);
  // at the cap exactly, it is read
  const at = JSON.stringify(TOKENS).padEnd(DEPOSIT_TOKENS_MAX, " ");
  assert.equal((await frame({ tokens: { response: () => new Response(at, { status: 200 }) } }).ask(ASSETS)).ok, true);
});

test("review 6: deposit.dry refuses above_max off a signed amount out over the cap, even when the amount in is not", async () => {
  const over: Net = { quote: { before: (x) => void ((x.quote.amountOut = "1000500000"), (x.quote.amountOutFormatted = "1000.5")) } };
  assert.deepEqual((await frame(over).ask(dry("1000"))).error, { code: "above_max" });
  assert.equal((await frame().ask(dry("1000"))).ok, true);
});

test("review 6: the bound before any request is USDC's alone: an asset the device prices otherwise is asked, never below_min on USDC's bound", async () => {
  let asked = 0;
  const got = await depositQuoteKind({ origin_asset: "nep141:gold.near", amount: "2" }, {
    seed: { source: "code", code_saved: true }, depositId: U, now: () => NOW,
    priced: (o) => (o === "nep141:gold.near" ? { decimals: 2, pricing: { in: ["50", "50"], out: ["1", "1"] } } : null),
    fetch: (async () => (asked++, new Response("{}", { status: 503 }))) as unknown as typeof fetch,
  });
  // 200 base units, $100: the request goes (the helper is down)
  assert.deepEqual(got, { ok: false, code: "down" });
  assert.equal(asked, 1);
});

test("review 6: the live deposit.quote refuses 1Click's keyless fee entry: the dry paths never reach the live check", async () => {
  assert.deepEqual((await quotePage(liveFetch([], undefined, 15, 201, 1))("25")).error, { code: "quote_check_failed" });
  assert.equal((await quotePage(liveFetch([], undefined, 15, 201, 20))("25")).ok, true);
});
