// node --test apps/helper/src/pool/jito.test.ts: the bundle-only sender's answers from a block engine, each hostile
// input bounded (M362 (4)), and its one pacer per region (M369 (M1)). The sender's use of it is in solana-attacks.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_JITO_TIP_MIN } from "@blindfill/kit";
import { JITO_QUEUE_MAX_MS, jitoSender, SOLANA_JITO_BLOCK_ENGINES } from "./jito.ts";

const SIG = "5".repeat(88);
const answer = (body: string, status = 200) => async () => new Response(body, { status });

test("the block engines are Jito's eight mainnet regions, each bundle-only, not the global name; the least tip is the kit's 1,000 lamports", () => {
  assert.equal(SOLANA_JITO_BLOCK_ENGINES.length, 8);
  assert.equal(new Set(SOLANA_JITO_BLOCK_ENGINES.map((r) => new URL(r).host)).size, 8);
  for (const r of SOLANA_JITO_BLOCK_ENGINES) {
    const u = new URL(r);
    assert.equal(u.protocol, "https:");
    assert.match(u.host, /^[a-z]+\.mainnet\.block-engine\.jito\.wtf$/);
    assert.equal(u.pathname, "/api/v1/transactions");
    assert.equal(u.search, "?bundleOnly=true");
  }
  assert.ok(Object.isFrozen(SOLANA_JITO_BLOCK_ENGINES));
  assert.equal(SOLANA_JITO_TIP_MIN, 1_000n);
});

test("an answer that is not this transaction's signature, not JSON, or a 4xx is a refusal that ends the try", async () => {
  let n = 0;
  const count = (f: () => Promise<Response>) => async () => (n++, f());
  for (const [f, what] of [
    [answer(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "another" })), "another signature"],
    [answer("<html>"), "not JSON"],
    [answer(JSON.stringify({ jsonrpc: "2.0", id: 1, result: SIG }), 403), "a 403"],
  ] as const) {
    n = 0;
    const r = await jitoSender({ fetch: count(f) }).send("AA==", SIG);
    assert.equal(r.kind, "refused", what);
    assert.equal(n, 1, `${what}: one region asked`);
  }
});

test("an answer over 16 KB or a timeout is a transport failure: every region is tried, then transport", async () => {
  let n = 0;
  const big = async () => (n++, new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: SIG, pad: "x".repeat(20_000) })));
  assert.equal((await jitoSender({ fetch: big }).send("AA==", SIG)).kind, "transport");
  assert.equal(n, 8);
  const slow = (_u: string, init: RequestInit) => new Promise<Response>((_, no) => init.signal!.addEventListener("abort", () => no(new Error("timeout"))));
  const t0 = Date.now();
  assert.equal((await jitoSender({ fetch: slow, timeoutMs: 20 }).send("AA==", SIG)).kind, "transport");
  assert.ok(Date.now() - t0 < 2_000);
});

test("M369 (L1): any HTTP status is the region's word, never transport: a 5xx or a 429 from every region is busy", async () => {
  for (const status of [500, 502, 503, 504, 429]) {
    let n = 0;
    const r = await jitoSender({ fetch: async () => (n++, new Response("", { status })) }).send("AA==", SIG);
    assert.equal(r.kind, "busy", `HTTP ${status}`);
    assert.equal(n, 8, `HTTP ${status}: every region asked`);
  }
  // a 5xx with a JSON-RPC refusal in it is still busy: the region did not take the request
  const r = await jitoSender({ fetch: answer(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "x" } }), 503) }).send("AA==", SIG);
  assert.equal(r.kind, "busy");
});

// M369 (M1): one pacer per region, shared by every carry
const ok = () => {
  const seen: { host: string; at: number }[] = [];
  const fetch = async (u: string) => (seen.push({ host: new URL(u).host, at: performance.now() }), new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: SIG })));
  return { seen, fetch };
};

test("M369 (M1): first sends at once take a region each; the ninth waits for the first region's next second, never two in one second", async () => {
  const e = ok();
  const j = jitoSender({ fetch: e.fetch, intervalMs: 300 });
  const t0 = performance.now();
  const r = await Promise.all(Array.from({ length: 9 }, () => j.send("AA==", SIG)));
  assert.ok(r.every((x) => x.kind === "ok"));
  assert.equal(new Set(e.seen.slice(0, 8).map((x) => x.host)).size, 8, "eight regions at once");
  assert.ok(e.seen[8]!.at - t0 >= 290, `the ninth waited ${Math.round(e.seen[8]!.at - t0)} ms`);
  for (const a of e.seen) for (const b of e.seen) if (a !== b && a.host === b.host) assert.ok(Math.abs(a.at - b.at) >= 290, a.host);
});

test("M369 (M1): a rebroadcast goes only to its region, only in a second nobody took or booked, and never walks", async () => {
  const e = ok();
  const j = jitoSender({ fetch: e.fetch, intervalMs: 200 });
  const first = await j.send("AA==", SIG);
  assert.equal(first.kind, "ok");
  const region = (first as { region: string }).region;
  assert.equal((await j.rebroadcast(region, "AA==", SIG)).kind, "busy", "the first send's second");
  assert.equal(e.seen.length, 1, "nothing sent");
  await new Promise((r) => setTimeout(r, 210));
  assert.equal((await j.rebroadcast(region, "AA==", SIG)).kind, "ok");
  assert.deepEqual(e.seen.map((x) => x.host), [new URL(region).host, new URL(region).host]);
  assert.equal((await j.rebroadcast("https://example.invalid/", "AA==", SIG)).kind, "refused", "not a block engine");
  // its region busy: one request, no other region asked
  let n = 0;
  const busy = jitoSender({ fetch: async (u) => (n++, assert.equal(u, SOLANA_JITO_BLOCK_ENGINES[3]), new Response("", { status: 429 })) });
  assert.equal((await busy.rebroadcast(SOLANA_JITO_BLOCK_ENGINES[3]!, "AA==", SIG)).kind, "busy");
  assert.equal(n, 1);
});

test("M369 (M1): a first send books its region's next second ahead of every rebroadcast", async () => {
  const e = ok();
  const j = jitoSender({ fetch: e.fetch, intervalMs: 300 });
  // every region's second just taken by a rebroadcast
  for (const r of SOLANA_JITO_BLOCK_ENGINES) assert.equal((await j.rebroadcast(r, "AA==", SIG)).kind, "ok");
  const f = j.send("AA==", SIG); // books the region whose second ends first, and waits for it
  await new Promise((r) => setTimeout(r, 400));
  const sent = await f;
  assert.equal(sent.kind, "ok");
  const booked = (sent as { region: string }).region;
  // the first send took that region's second: a rebroadcast there now is refused unsent; the others go
  const before = e.seen.length;
  for (const r of SOLANA_JITO_BLOCK_ENGINES) assert.equal((await j.rebroadcast(r, "AA==", SIG)).kind, r === booked ? "busy" : "ok", r);
  assert.equal(e.seen.length, before + 7);
});

test("the request: POST sendTransaction, base64, no redirect followed", async () => {
  const seen: RequestInit[] = [];
  await jitoSender({ fetch: async (_u, init) => (seen.push(init), new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: SIG }))) }).send("AQID", SIG);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.redirect, "error");
  assert.deepEqual(JSON.parse(String(seen[0]!.body)), { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["AQID", { encoding: "base64" }] });
});

test("M369 (M1): a first send waits at most JITO_QUEUE_MAX_MS for a second; past it, every region booked, it is busy and sends nothing", async () => {
  const e = ok();
  const j = jitoSender({ fetch: e.fetch, intervalMs: 1_000, queueMaxMs: 100 });
  const r = await Promise.all(Array.from({ length: 8 }, () => j.send("AA==", SIG)));
  assert.ok(r.every((x) => x.kind === "ok"));
  const t0 = performance.now();
  const ninth = await j.send("AA==", SIG);
  assert.equal(ninth.kind, "busy");
  assert.ok(performance.now() - t0 < 100, "it did not wait");
  assert.equal(e.seen.length, 8, "nothing sent");
  assert.equal(JITO_QUEUE_MAX_MS, 2_000);
});
