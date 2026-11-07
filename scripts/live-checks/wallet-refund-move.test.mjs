// node --test scripts/live-checks/wallet-refund-move.test.mjs: the live check replays its recorded answers
// (wallet-refund-move.answers.json). good: this card's SIGN_HOST build as committed (packages/signpage/index.html and
// public/app.js), the helper's live refund move quote and intents.near's live reads of 7 Nov 14:4xZ, and /v1/intents as
// the kit's contract answers an empty body (HTTP 400 bad_shape, SIGN_HOST's origin allowed; the route is not deployed
// yet): PASS. bad: SIGN_HOST as served on 7 Nov, the same live reads, and /v1/intents as the helper answered on 7 Nov
// 19:18Z (HTTP 404 {error: "not_found"}, no code by the device's rule): FAIL, each fact named. Planted on the good one:
// another /app.js, no move in the bundle, a quote the rule refused or did not read, a quote that is not a refund move's,
// a quote answered 502, the salts or heights apart, a used nonce, a 404 relay, a listed code at 200, 399 or 500, a code
// not listed, an answer SIGN_HOST may not read (no access-control-allow-origin, "*", another origin): each FAIL. The
// relay's answer is read as the device reads it (bytes capped at 1024, strict UTF-8): a 1025-byte refusal is no code.
// /v1/intents read again 8 Nov 21:09:59Z: still 404 {"error":"not_found"}, so the good answer's relay stays the contract's. The quote is kept as facts (status, the rule's verdict at read time, depositType, to U), not its signature.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { INTENTS_URL, judge, read, RELAY_ANSWER_MAX_BYTES, relayAnswer, relayCode } from "./wallet-refund-move.mjs";

const A = JSON.parse(readFileSync(new URL("./wallet-refund-move.answers.json", import.meta.url), "utf8"));

test("recorded good answer: the card's build carries the move, the live quote passes SIGN_HOST's rule, intents.near agrees at one block, the relay answers its own refusal: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
  assert.deepEqual({ ...A.good.quote, depositAddress: undefined }, { status: 201, verdict: "pass", depositType: "INTENTS", toU: true, depositAddress: undefined });
});

test("recorded bad answer: SIGN_HOST before the card and the helper with no /v1/intents: FAIL, each fact named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    `BAD SIGN_HOST's bundle carries no refund move (${INTENTS_URL})`,
    "BAD the helper carries no id's intent: POST /v1/intents answers 404 null",
  ]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  const quote = (o) => ({ ...g, quote: { ...g.quote, ...o } });
  const planted = [
    [{ ...g, sha384: "sha384-other" }, "BAD SIGN_HOST's served /app.js is not the one index.html pins"],
    [{ ...g, intents_url: false }, `BAD SIGN_HOST's bundle carries no refund move (${INTENTS_URL})`],
    [{ ...g, quote: { ...g.quote, status: 502 } }, "BAD the helper's 1Click proxy answers the refund move's quote 502"],
    [quote({ verdict: "refund-kind request not allowed: recipient" }), "BAD SIGN_HOST's rule refuses the live refund move quote"],
    [quote({ verdict: null }), "BAD SIGN_HOST's rule refuses the live refund move quote"],
    [quote({ depositType: "ORIGIN_CHAIN" }), "BAD the live quote is not a refund move's"],
    [quote({ toU: false }), "BAD the live quote is not a refund move's"],
    [{ ...g, near: [g.near[0], { ...g.near[1], salt: "00000000" }] }, "BAD intents.near's two RPCs disagree at one block"],
    [{ ...g, near: [g.near[0], { ...g.near[1], height: g.near[1].height + 1 }] }, "BAD intents.near's two RPCs disagree at one block"],
    [{ ...g, near: [g.near[0], { ...g.near[1], used: true }] }, "BAD is_nonce_used does not answer false for a fresh nonce on both RPCs"],
    [{ ...g, relay: { ...g.relay, status: 404, code: null } }, "BAD the helper carries no id's intent: POST /v1/intents answers 404 null"],
    // the device's own rule: a listed code counts only at a status in 400-499, and only a listed one
    [{ ...g, relay: { ...g.relay, status: 200 } }, "BAD the helper carries no id's intent: POST /v1/intents answers 200 \"bad_shape\""],
    [{ ...g, relay: { ...g.relay, status: 500 } }, "BAD the helper carries no id's intent: POST /v1/intents answers 500 \"bad_shape\""],
    [{ ...g, relay: { ...g.relay, status: 399 } }, "BAD the helper carries no id's intent: POST /v1/intents answers 399 \"bad_shape\""],
    [{ ...g, relay: { ...g.relay, code: "not_found" } }, "BAD the helper carries no id's intent: POST /v1/intents answers 400 \"not_found\""],
    // SIGN_HOST reads the answer cross-origin: the helper must name it
    [{ ...g, relay: { ...g.relay, cors: "*" } }, "BAD SIGN_HOST may not read the helper's /v1/intents answer: access-control-allow-origin \"*\""],
    [{ ...g, relay: { ...g.relay, cors: null } }, "BAD SIGN_HOST may not read the helper's /v1/intents answer: access-control-allow-origin null"],
    [{ ...g, relay: { ...g.relay, cors: "https://confidential.unrealized.trade" } }, "BAD SIGN_HOST may not read the helper's /v1/intents answer"],
  ];
  for (const [a, line] of planted) {
    const v = judge(a);
    assert.equal(v.ok, false, line);
    assert.ok(v.lines.some((l) => l.startsWith(line)), `${line}\n${v.lines.join("\n")}`);
  }
  assert.equal(judge({}).ok, false, "an empty answer");
});

test("read() asks SIGN_HOST's / and /app.js, the quote for a fresh U by POST, intents.near on both RPCs at one block, and the relay", async () => {
  const asked = [];
  const fetchFn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    asked.push([init.method ?? "GET", url, body?.params?.method_name ?? null, body?.params?.block_id ?? body?.params?.finality ?? null]);
    if (url.endsWith("/app.js")) return new Response(`x ${INTENTS_URL}`);
    if (url.startsWith("https://sign.")) return new Response(A.good.index);
    if (url.endsWith("/v0/quote")) return Response.json({ quote: {}, quoteRequest: { recipient: "e1".repeat(32) } }, { status: 201 });
    if (url.endsWith("/v1/intents")) return Response.json({ error: { code: "bad_shape" } }, { status: 400, headers: { "access-control-allow-origin": "https://sign.confidential.unrealized.trade" } });
    const h = url.includes("fastnear") ? 101 : 100;
    const value = body.params.method_name === "current_salt" ? "252812b3" : false;
    return Response.json({ result: { block_height: body.params.block_id ?? h, result: [...Buffer.from(JSON.stringify(value))] } });
  };
  const a = await read(fetchFn, Date.parse("2026-11-07T14:40:00Z"));
  // the mock answers a quote for another U than the fresh one asked: the rule refuses it, and the facts say so
  assert.notEqual(a.quote.verdict, "pass");
  assert.equal(a.quote.toU, false);
  assert.deepEqual(a.near, [{ height: 100, salt: "252812b3", used: false }, { height: 100, salt: "252812b3", used: false }]);
  assert.deepEqual(a.relay, { status: 400, code: "bad_shape", cors: "https://sign.confidential.unrealized.trade" });
  assert.equal(a.intents_url, true);
  const reads = asked.filter((x) => x[2] !== null).map((x) => JSON.stringify(x.slice(2)));
  assert.deepEqual(reads.slice(0, 2), [JSON.stringify(["current_salt", "final"]), JSON.stringify(["current_salt", "final"])], "each RPC's final first");
  assert.deepEqual(reads.slice(2).sort(), [["current_salt", 100], ["current_salt", 100], ["is_nonce_used", 100], ["is_nonce_used", 100]].map((x) => JSON.stringify(x)).sort(), "then both at the lower height");
});

test("the relay's code read as the device reads it: only a route refusal {error: {code}}; the helper's 404 {error: \"not_found\"} is no code", () => {
  assert.equal(relayCode({ error: { code: "bad_shape" } }), "bad_shape");
  assert.equal(relayCode({ error: "not_found" }), null);
  assert.equal(relayCode({ error: { code: 1 } }), null);
  assert.equal(relayCode({ code: "bad_shape" }), null);
  assert.equal(relayCode(null), null);
});

test("the relay's answer read as the device reads it: bytes capped at the device's 1024, strict UTF-8; an answer over the cap is no code", async () => {
  // the device's cap, INTENTS_ANSWER_MAX_BYTES, is pinned at 1024 by packages/wallet/test/deposit-refund.test.ts ("pin
  // (delta)"); the live check reaches only the kit, so it holds the same number here
  assert.equal(RELAY_ANSWER_MAX_BYTES, 1024);
  const refusal = (n) => {
    const head = '{"error":{"code":"bad_shape","detail":"';
    const tail = '"}}';
    return head + "x".repeat(n - head.length - tail.length) + tail;
  };
  const stream = (text) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { status: 400 });
  assert.equal(refusal(1024).length, 1024);
  assert.equal(await relayAnswer(new Response(refusal(1024), { status: 400 })), "bad_shape", "1024 B: read");
  assert.equal(await relayAnswer(stream(refusal(1024))), "bad_shape", "1024 B streamed: read");
  // planted: 1025 B, declared or streamed with no length, is no code (the device's probe reads none)
  assert.equal(await relayAnswer(new Response(refusal(1025), { status: 400 })), null, "1025 B: no code");
  assert.equal(await relayAnswer(stream(refusal(1025))), null, "1025 B streamed: no code");
  // planted: not strict UTF-8 (a lone 0xff in the detail) is no code
  const bytes = new TextEncoder().encode(refusal(100));
  bytes[40] = 0xff;
  assert.equal(await relayAnswer(new Response(bytes, { status: 400 })), null, "bad UTF-8: no code");
  assert.equal(await relayAnswer(new Response("not json", { status: 400 })), null);
  assert.equal(await relayAnswer(Response.json({ error: "not_found" }, { status: 404 })), null);
});

test("read() reads the relay's answer through the cap: a 1025-byte refusal from /v1/intents records no code", async () => {
  const big = '{"error":{"code":"bad_shape","detail":"' + "x".repeat(1025) + '"}}';
  const fetchFn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.endsWith("/app.js")) return new Response(`x ${INTENTS_URL}`);
    if (url.startsWith("https://sign.")) return new Response(A.good.index);
    if (url.endsWith("/v0/quote")) return Response.json({ quote: {}, quoteRequest: {} }, { status: 201 });
    if (url.endsWith("/v1/intents")) return new Response(big, { status: 400, headers: { "access-control-allow-origin": "https://sign.confidential.unrealized.trade" } });
    const value = body.params.method_name === "current_salt" ? "252812b3" : false;
    return Response.json({ result: { block_height: body.params.block_id ?? 100, result: [...Buffer.from(JSON.stringify(value))] } });
  };
  const a = await read(fetchFn, Date.parse("2026-11-07T14:40:00Z"));
  assert.deepEqual(a.relay, { status: 400, code: null, cors: "https://sign.confidential.unrealized.trade" });
  assert.ok(judge(a).lines.some((l) => l.startsWith("BAD the helper carries no id's intent: POST /v1/intents answers 400 null")));
});
