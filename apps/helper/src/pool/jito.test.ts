// node --test apps/helper/src/pool/jito.test.ts: the bundle-only sender's answers from a block engine, each hostile
// input bounded (M362 (4)), and its one pacer per region (M369 (M1)). The sender's use of it is in solana-attacks.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_JITO_TIP_MIN } from "@blindfill/kit";
import { JITO_QUEUE_MAX_MS, JITO_TIMEOUT_MS, jitoSender, SOLANA_JITO_BLOCK_ENGINES } from "./jito.ts";

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

test("a throttle is only Jito's documented answer (a 429, or an error naming a rate limit); other words, \"too many\" ones included, are a refusal", async () => {
  const err = (message: string) => answer(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32097, message } }));
  const limited = await jitoSender({ fetch: err("Rate limit exceeded. Limit: 1 per second for txn requests"), intervalMs: 0 }).send("AA==", SIG, 0);
  assert.deepEqual([limited.kind, (limited as { throttled?: boolean }).throttled], ["busy", true]);
  const other = await jitoSender({ fetch: err("bundle has too many transactions") }).send("AA==", SIG);
  assert.equal(other.kind, "refused");
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

test("M369 (M1): by default each region takes one request a second (Jito's keyless limit): the ninth first send at once waits a second", async () => {
  const e = ok();
  const j = jitoSender({ fetch: e.fetch });
  const t0 = performance.now();
  const r = await Promise.all(Array.from({ length: 9 }, () => j.send("AA==", SIG)));
  assert.ok(r.every((x) => x.kind === "ok"));
  const waited = e.seen[8]!.at - t0;
  assert.ok(waited >= 990 && waited < 1_500, `the ninth waited ${Math.round(waited)} ms`);
  assert.equal(e.seen[8]!.host, e.seen[0]!.host, "the region whose second ended first");
});

// M374 (2): the review's R4-J1 saw two sends to one region 0.1 ms apart under load: both waits were booked a second
// apart, but the event loop stalled past both, so both timers fired in one turn. A real stall here (a busy loop).
test("M374 (2): an event loop that stalls past two booked seconds never sends twice to one region inside one interval", async () => {
  const at: number[] = [];
  const fetchFn = async () => (at.push(performance.now()), new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: SIG })));
  const j = jitoSender({ fetch: fetchFn, regions: [SOLANA_JITO_BLOCK_ENGINES[0]!], intervalMs: 200 });
  const sends = [j.send("AA==", SIG), j.send("AA==", SIG), j.send("AA==", SIG)]; // the first now, then booked at 200 and 400 ms
  const stall = performance.now() + 500;
  while (performance.now() < stall); // both later sends' timers are past due when the loop comes back
  const r = await Promise.all(sends);
  assert.ok(r.every((x) => x.kind === "ok"));
  assert.equal(at.length, 3);
  for (let k = 1; k < at.length; k++) assert.ok(at[k]! - at[k - 1]! >= 199, `sends ${k - 1} and ${k} went ${(at[k]! - at[k - 1]!).toFixed(1)} ms apart`);
  // and a rebroadcast is held to the last actual send too, not to the booking
  assert.equal((await j.rebroadcast(SOLANA_JITO_BLOCK_ENGINES[0]!, "AA==", SIG)).kind, "busy");
});

// The review's G2 (fold 4, R4f): the default queue limit is in use, not only a constant. Every region booked 3 s ahead:
// a default sender's next first send is busy at once.
test("G2: by default a first send never waits past JITO_QUEUE_MAX_MS: a 17th booking is refused at once", async () => {
  const j = jitoSender({ fetch: ok().fetch, intervalMs: 1_500 });
  const all = Array.from({ length: 16 }, () => j.send("AA==", SIG)); // booked in this tick: every region's next second 3 s on
  const t0 = performance.now();
  const r = await j.send("AA==", SIG);
  assert.equal(r.kind, "busy");
  assert.ok(performance.now() - t0 < 100);
  await Promise.all(all);
});

// R4g: the default per-region timeout is in use: a region that never answers is given up at about 2 s.
test("a default sender gives up on a hung region at about JITO_TIMEOUT_MS (2 s): transport", async () => {
  const hung = (_u: string, init: RequestInit) => new Promise<Response>((_, no) => init.signal!.addEventListener("abort", () => no(new Error("timeout"))));
  const j = jitoSender({ fetch: hung, regions: [SOLANA_JITO_BLOCK_ENGINES[0]!] });
  const t0 = performance.now();
  const r = await j.send("AA==", SIG);
  const ms = performance.now() - t0;
  assert.equal(r.kind, "transport");
  assert.ok(ms >= 1_900 && ms < 2_600, `gave up after ${Math.round(ms)} ms`);
  assert.equal(JITO_TIMEOUT_MS, 2_000);
});

// The review's G5, G6 and G7 (fold 5): the pacing rules of M374 (2) a late timer can reach. G5: the wait is re-read
// after it, or two sends waiting out one region's interval after a stall go together. A, then B, C and D booked 200 ms
// apart; the loop stalls past all three bookings: B goes at the stall's end, C and D both wait for B's interval.
test("G5: two sends waiting out one region's interval after a stall never go together", async () => {
  const at: number[] = [];
  const fetchFn = async () => (at.push(performance.now()), new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: SIG })));
  const j = jitoSender({ fetch: fetchFn, regions: [SOLANA_JITO_BLOCK_ENGINES[0]!], intervalMs: 200 });
  const sends = [0, 1, 2, 3].map(() => j.send("AA==", SIG)); // A now, then B, C, D booked at 200, 400 and 600 ms
  const stall = performance.now() + 700;
  while (performance.now() < stall);
  const r = await Promise.all(sends);
  assert.ok(r.every((x) => x.kind === "ok"));
  assert.equal(at.length, 4);
  const sorted = [...at].sort((x, y) => x - y);
  for (let k = 1; k < sorted.length; k++) assert.ok(sorted[k]! - sorted[k - 1]! >= 199, `sends ${k - 1} and ${k} went ${(sorted[k]! - sorted[k - 1]!).toFixed(1)} ms apart`);
});

const okFetch = () => {
  const at: number[] = [];
  return { at, fetch: async () => (at.push(performance.now()), new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: SIG }))) };
};
const R0 = SOLANA_JITO_BLOCK_ENGINES[0]!;

// G6 (F2g): a rebroadcast never takes a second a first send booked and has not yet used, even when that send's timer
// is late (here the loop stalls past it): the booking, not the last actual send, is what holds the rebroadcast back.
test("G6: a rebroadcast is refused while a booked first send is overdue", async () => {
  const e = okFetch();
  const j = jitoSender({ fetch: e.fetch, regions: [R0], intervalMs: 200 });
  assert.equal((await j.rebroadcast(R0, "AA==", SIG)).kind, "ok"); // the region's second, now
  const a = j.send("AA==", SIG); // books the next second, 200 ms on, and sleeps
  const stall = performance.now() + 250;
  while (performance.now() < stall); // its timer is overdue
  const r = j.rebroadcast(R0, "AA==", SIG); // in the same turn, before the late timer runs
  assert.equal((await r).kind, "busy", "the rebroadcast took the booked second");
  assert.equal((await a).kind, "ok");
});

// G7 (F2c): a first send that goes late marks its region without pulling down a later booking, so a rebroadcast cannot
// take the next booked second either.
test("G7: a late first send leaves the next booking in place", async () => {
  const e = okFetch();
  const j = jitoSender({ fetch: e.fetch, regions: [R0], intervalMs: 200 });
  assert.equal((await j.rebroadcast(R0, "AA==", SIG)).kind, "ok"); // t0
  const a = j.send("AA==", SIG); // booked t0 + 200
  const b = j.send("AA==", SIG); // booked t0 + 400
  const stall = performance.now() + 250;
  while (performance.now() < stall); // a goes about 50 ms late
  await new Promise((r) => setTimeout(r, 0)); // a's overdue timer runs first: it marked and sent
  assert.equal(e.at.length, 2);
  const late = e.at[1]!;
  const probe = await new Promise<string>((ok) =>
    setTimeout(() => {
      while (performance.now() < late + 205); // past a's interval, before b went
      void j.rebroadcast(R0, "AA==", SIG).then((x) => ok(x.kind));
    }, Math.max(0, late + 190 - performance.now())),
  );
  assert.equal(probe, "busy", "the rebroadcast took b's booked second");
  assert.ok((await Promise.all([a, b])).every((x) => x.kind === "ok"));
});
