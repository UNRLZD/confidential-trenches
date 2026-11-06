// node --test apps/helper/src/data/solana/search.test.ts: the token page's Jupiter search (token.ts, card
// helper-token-page-cold). A mint nobody holds is searched as soon as the search's part of the Jupiter bucket has room,
// one search out at a time; a held mint's refresh keeps the batched search JUP_GAP_MS apart and leaves COLD_ROOM free;
// the searches stay inside their part of PROXY_RESERVE, so a swap build is never refused behind token pages. Every
// clock here is node:test's mock (setTimeout and Date), the upstream answering after LAT ms.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { enableTimers, resetTimers } from "../../../test/mock-timers.ts";
import { createProxy, PROXY_BUDGETS, PROXY_RESERVE } from "../../proxy/proxy.ts";
import { b58encode } from "./lists.ts";
import * as T from "./token.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/token-page.json", import.meta.url), "utf8"));
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const NOW = Date.parse("2026-11-04T14:00:00.000Z");
/** Jupiter's search, as the box read it (about 0.1-0.3 s). */
const LAT = 250;
// read as a namespace, so this file runs against the code before the card too (the red run): its constants then fall
// back to the values the card writes
const SEARCH_PER_SPAN: number = (T as Record<string, unknown>).SEARCH_PER_SPAN as number ?? 16;
const COLD_ROOM: number = (T as Record<string, unknown>).COLD_ROOM as number ?? 4;
const SEARCH_WAIT_MAX_MS: number = (T as Record<string, unknown>).SEARCH_WAIT_MAX_MS as number ?? 4_000;

/** The n-th test mint: 32 bytes, a valid address, never a real token. */
const mint = (n: number) => b58encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 + (n >> 8) : i === 1 ? n & 0xff : 7)));
/** Jupiter's row for any mint: PUMP's recorded row under the mint's id. */
const rowOf = (m: string) => ({ ...FX.tokens[PUMP].search[0], id: m });

/** The RPC path: every mint read answers PUMP's recorded mint account; the launch read finds no curve. */
const rpc = {
  async handle(_c: string, _ct: string | undefined, body: string) {
    const r = JSON.parse(body) as { params: [string[], { encoding: string }] };
    const keys = r.params[0];
    if (r.params[1].encoding === "base64") return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 464517653 }, value: keys.map(() => null) } }) };
    const rec = FX.tokens[PUMP].accounts;
    return { status: 200, body: JSON.stringify({ ...rec, result: { ...rec.result, value: keys.map(() => rec.result.value[0]) } }) };
  },
};

/** Jupiter's search behind a stand-in proxy: each call answers after LAT ms; `calls` holds each call's mints and start. */
function searchProxy() {
  const calls: { at: number; mints: string[] }[] = [];
  let out = 0;
  let most = 0;
  return {
    calls,
    most: () => most,
    async handle(_v: string, _p: string, q: string) {
      const mints = new URLSearchParams(q).get("query")!.split(",");
      calls.push({ at: Date.now(), mints });
      most = Math.max(most, ++out);
      await new Promise((ok) => setTimeout(ok, LAT));
      out--;
      return { status: 200, headers: { "X-Fetched-At": new Date().toISOString() }, body: JSON.stringify(mints.map(rowOf)) };
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((ok) => setImmediate(ok));
};
/** Move the mocked clock `ms` on, 10 ms at a time, letting every promise step run between. */
async function run(t: TestContext, ms: number) {
  for (let left = ms; left > 0; left -= 10) {
    await flush();
    t.mock.timers.tick(Math.min(10, left));
  }
  await flush();
}
/** A page read, answered with its status and the mocked ms it took. */
type Timed = { status: number; ms: number; retryAfterS?: number };
function ask(tok: ReturnType<typeof T.createSolanaToken>, m: string): { done: Timed | null; p: Promise<Timed> } {
  const t0 = Date.now();
  const h: { done: Timed | null; p: Promise<Timed> } = { done: null, p: null! };
  h.p = tok.page(m).then((a) => (h.done = { status: a.status, ms: Date.now() - t0, ...(a.retryAfterS === undefined ? {} : { retryAfterS: a.retryAfterS }) }));
  return h;
}
const clock = (t: TestContext) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout", "Date"], now: NOW });
  t.after(() => resetTimers(t.mock.timers));
};

test("card helper-token-page-cold: four cold mints arriving together 1 s after a search each answer within 1 s, in one search", async (t) => {
  clock(t);
  const proxy = searchProxy();
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  const first = ask(tok, mint(0));
  await run(t, 1_000);
  assert.equal(first.done?.status, 200);
  const four = [1, 2, 3, 4].map((n) => ask(tok, mint(n)));
  await run(t, 1_000);
  for (const [i, h] of four.entries()) {
    assert.equal(h.done?.status, 200, `mint ${i + 1} answered within 1 s (it took ${h.done?.ms ?? "over 1000"} ms)`);
    assert.ok(h.done!.ms <= 1_000);
  }
  assert.equal(proxy.calls.length, 2, "the four went in one search");
  assert.deepEqual(proxy.calls[1]!.mints, [1, 2, 3, 4].map(mint));
});

test("card helper-token-page-cold: four cold mints, each arriving 1 s after the last search, each answer within 1 s", async (t) => {
  clock(t);
  const proxy = searchProxy();
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  const first = ask(tok, mint(0));
  await run(t, 1_000);
  assert.equal(first.done?.status, 200);
  for (const n of [1, 2, 3, 4]) {
    const h = ask(tok, mint(n));
    await run(t, 1_000);
    assert.equal(h.done?.status, 200, `mint ${n} answered within 1 s (it took ${h.done?.ms ?? "over 1000"} ms)`);
    assert.ok(h.done!.ms <= 1_000);
  }
  assert.equal(proxy.calls.length, 5);
  // each went the moment it was asked (after the tick that gathers mints asked together): never on JUP_GAP_MS
  for (let i = 1; i < 5; i++) assert.ok(proxy.calls[i]!.at - proxy.calls[i - 1]!.at <= 1_010, `search ${i} went ${proxy.calls[i]!.at - proxy.calls[i - 1]!.at} ms after the one before`);
});

test("card helper-token-page-cold: one search out at a time; a cold mint asked during one goes the moment it returns", async (t) => {
  clock(t);
  const proxy = searchProxy();
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  const a = ask(tok, mint(0));
  await run(t, 100);
  const b = ask(tok, mint(1));
  const c = ask(tok, mint(2));
  await run(t, 1_000);
  assert.equal(proxy.most(), 1, "never two searches out at once");
  assert.deepEqual(proxy.calls.map((x) => x.mints), [[mint(0)], [mint(1), mint(2)]]);
  assert.ok(proxy.calls[1]!.at - proxy.calls[0]!.at <= LAT + 20, `the second went ${proxy.calls[1]!.at - proxy.calls[0]!.at} ms after the first, as it returned`);
  for (const h of [a, b, c]) assert.equal(h.done?.status, 200);
});

test("card helper-token-page-cold: a held mint's refresh keeps the batched search: JUP_GAP_MS after the last search; a cold mint asked meanwhile goes at once and carries it", async (t) => {
  clock(t);
  const proxy = searchProxy();
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  const warm = ask(tok, mint(0));
  await run(t, 13_000); // past the row's 12 s and the page's 5 s: the next read is a refresh, served at once
  assert.equal(warm.done?.status, 200);
  const other = ask(tok, mint(9));
  await run(t, 1_000); // a search 1 s ago
  assert.equal(proxy.calls.length, 2);
  const again = ask(tok, mint(0));
  await run(t, 50);
  assert.equal(again.done?.status, 200, "the held page is served at once");
  assert.ok(again.done!.ms <= 50);
  await run(t, T.JUP_GAP_MS - 1_000 - 100);
  assert.equal(proxy.calls.length, 2, "the refresh waits out the gap");
  await run(t, 200);
  assert.equal(proxy.calls.length, 3, "and goes at the gap");
  assert.deepEqual(proxy.calls[2]!.mints, [mint(0)]);
  assert.ok(proxy.calls[2]!.at - proxy.calls[1]!.at >= T.JUP_GAP_MS);
  // the same again, with a cold mint asked inside the gap: it goes at once, the refresh with it, the cold one first
  await run(t, 13_000);
  ask(tok, mint(9)); // a refresh of mint 9 (held), served at once
  await run(t, 1_000);
  const n = proxy.calls.length;
  ask(tok, mint(0)); // a refresh of mint 0, inside the gap
  await run(t, 100);
  assert.equal(proxy.calls.length, n, "held in the gap");
  const cold = ask(tok, mint(10));
  await run(t, 1_000);
  assert.equal(cold.done?.status, 200);
  assert.ok(cold.done!.ms <= 1_000);
  assert.equal(proxy.calls.length, n + 1);
  assert.deepEqual(proxy.calls[n]!.mints, [mint(10), mint(0)], "the cold mint first, the due refresh carried");
  assert.equal(other.done?.status, 200);
});

test("card helper-token-page-cold: searches stay at SEARCH_PER_SPAN in the proxy's counted minute; the next cold one goes the moment the oldest leaves it; past SEARCH_WAIT_MAX_MS it answers not ready (503, never our 429: card helper-crowd-429 fold 6) and is still read", async (t) => {
  clock(t);
  const proxy = searchProxy();
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  // SEARCH_PER_SPAN cold searches, 3.7 s apart, from second 0
  for (let n = 0; n < SEARCH_PER_SPAN; n++) {
    const h = ask(tok, mint(n));
    await run(t, 3_700);
    assert.equal(h.done?.status, 200);
  }
  assert.equal(proxy.calls.length, SEARCH_PER_SPAN);
  // now 59.2 s on: the oldest search (second 0) counts until the end of second 60, so the next goes at 61 s
  const next = ask(tok, mint(100));
  await run(t, 61_000 - SEARCH_PER_SPAN * 3_700 - 50);
  assert.equal(proxy.calls.length, SEARCH_PER_SPAN, "held while the counted minute is full");
  await run(t, 100);
  assert.equal(proxy.calls.length, SEARCH_PER_SPAN + 1, "sent as the oldest left");
  assert.ok(Math.abs(proxy.calls.at(-1)!.at - (NOW + 61_000)) <= 20);
  await run(t, 500);
  assert.equal(next.done?.status, 200);
  // another helper's minute filled at once (one search a cold mint, back to back): the next one's slot is past
  // SEARCH_WAIT_MAX_MS, so it answers not ready (never our 429), and its mint is still searched when the slot comes
  proxy.calls.length = 0;
  const tok2 = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  for (let n = 200; proxy.calls.length < SEARCH_PER_SPAN; n++) {
    ask(tok2, mint(n));
    await run(t, LAT + 20);
  }
  const late = ask(tok2, mint(999));
  await run(t, 50);
  assert.deepEqual([late.done?.status, late.done?.retryAfterS], [503, undefined], "not held for the slot, and not our 429");
  const before = proxy.calls.length;
  await run(t, 61_000); // the counted minute's oldest search leaves it
  assert.equal(proxy.calls.length, before + 1);
  assert.ok(proxy.calls.at(-1)!.mints.includes(mint(999)), "its mint was searched when the slot came");
  const retry = ask(tok2, mint(999));
  await run(t, 50);
  assert.equal(retry.done?.status, 200, "the retry is answered from the row read");
  assert.equal(proxy.calls.length, before + 1, "with no search of its own");
});

test("card helper-token-page-cold: callers ahead of refreshes: a refresh leaves COLD_ROOM of the minute free; a cold mint takes it at once", async (t) => {
  clock(t);
  const proxy = searchProxy();
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  // a held mint, then SEARCH_PER_SPAN - COLD_ROOM cold searches 1 s apart
  ask(tok, mint(0));
  await run(t, 1_000);
  for (let n = 1; n < SEARCH_PER_SPAN - COLD_ROOM; n++) {
    ask(tok, mint(n));
    await run(t, 1_000);
  }
  assert.equal(proxy.calls.length, SEARCH_PER_SPAN - COLD_ROOM);
  await run(t, 13_000);
  // mint 0's refresh: the gap is long past, but only COLD_ROOM of the minute is free: it waits
  const refresh = ask(tok, mint(0));
  await run(t, 5_000);
  assert.equal(refresh.done?.status, 200, "the held page is served");
  assert.equal(proxy.calls.length, SEARCH_PER_SPAN - COLD_ROOM, "the refresh did not take the cold mints' room");
  const cold = ask(tok, mint(50));
  await run(t, 1_000);
  assert.equal(cold.done?.status, 200);
  assert.ok(cold.done!.ms <= 1_000);
  assert.deepEqual(proxy.calls.at(-1)!.mints, [mint(50), mint(0)], "the cold one went at once, carrying the refresh");
});

test("card helper-token-page-cold: page searches at their limit leave a swap build's call unblocked (the real proxy and its budget)", async (t) => {
  clock(t);
  const searches: number[] = [];
  const proxy = createProxy({}, {
    now: () => Date.now(),
    fetch: (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/tokens/v2/search") {
        searches.push(Date.now());
        await new Promise((ok) => setTimeout(ok, LAT));
        return new Response(JSON.stringify(u.searchParams.get("query")!.split(",").map(rowOf)), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
    }) as never,
  });
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  // Discover's lists at their most in the counted minute (lists.ts: 3 reads a 12 s refresh, 6 refreshes in 61 s)
  for (let i = 0; i < 18; i++) assert.equal((await proxy.handle("jupiter", "/tokens/v2/recent", `limit=${i + 1}`, "", undefined, true)).status, 200);
  // callers' swap builds: all of their part but one
  const callers = PROXY_BUDGETS.jupiter.total - PROXY_RESERVE.jupiter;
  for (let i = 0; i < callers - 1; i++) assert.equal((await proxy.handle("jupiter", "/swap/v2/build", `q=${i}`, "", `198.51.100.${Math.floor(i / 4)}`)).status, 200, `build ${i}`);
  // a new cold mint every 400 ms for 60 s: the pages search as much as they may
  const pages: ReturnType<typeof ask>[] = [];
  for (let n = 0; n < 150; n++) {
    pages.push(ask(tok, mint(n)));
    await run(t, 400);
  }
  assert.equal(searches.length, SEARCH_PER_SPAN, "the page searches at their limit, and no more");
  assert.ok(SEARCH_PER_SPAN + 18 <= PROXY_RESERVE.jupiter, "inside the helper's own reserve with the lists");
  // still in the counted minute of every draw above: the last caller build goes
  const build = await proxy.handle("jupiter", "/swap/v2/build", "q=last", "", "198.51.100.200");
  assert.equal(build.status, 200, `a swap build is not refused behind token pages (${build.body})`);
  await run(t, 5_000);
  // card helper-crowd-429 fold 6: a page past Jupiter's room is not ready (503 upstream), never our 429
  for (const h of pages) assert.ok(h.done?.status === 200 || h.done?.status === 503, `a page answers 200 or not ready, never ${h.done?.status}`);
});

test("card helper-token-page-cold: a caller waiting on a mint already queued as a refresh makes it cold: it goes at once", async (t) => {
  clock(t);
  const proxy = searchProxy();
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  ask(tok, mint(0));
  await run(t, 13_000);
  ask(tok, mint(9)); // a search now
  await run(t, 1_000);
  ask(tok, mint(0)); // mint 0's refresh, held in the gap
  await run(t, 100);
  const n = proxy.calls.length;
  // the token screen's holders for mint 0 (no holders provider: Jupiter's count) waits for the row
  const t0 = Date.now();
  let ms = -1;
  void tok.holders(mint(0)).then((a) => (assert.equal(a.status, 200), (ms = Date.now() - t0)));
  await run(t, 1_000);
  assert.ok(ms >= 0 && ms <= 1_000, `the holders answered in ${ms} ms`);
  assert.equal(proxy.calls.length, n + 1);
  assert.deepEqual(proxy.calls[n]!.mints, [mint(0)]);
});

test("card helper-token-page-cold: after a search that failed, callers asking again wait JUP_GAP_MS from it: a refusing vendor never spends the counted minute", async (t) => {
  clock(t);
  let down = true;
  const ok = searchProxy();
  const proxy = { calls: ok.calls, handle: (v: string, p: string, q: string) => (down ? (ok.calls.push({ at: Date.now(), mints: [] }), Promise.resolve({ status: 503, headers: {}, body: '{"error":{"code":"upstream"}}' })) : ok.handle(v, p, q)) };
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  // a crowd re-asking a cold mint every 100 ms while the search fails
  const asks: ReturnType<typeof ask>[] = [];
  for (let i = 0; i < 30; i++) {
    asks.push(ask(tok, mint(0)));
    await run(t, 100);
  }
  assert.ok(proxy.calls.length <= 1 + Math.floor(3_000 / T.JUP_GAP_MS), `${proxy.calls.length} failing searches in 3 s`);
  down = false;
  await run(t, T.JUP_GAP_MS);
  const after = ask(tok, mint(0));
  await run(t, 1_000);
  assert.equal(after.done?.status, 200, "the search goes again once the gap from the failure is past");
});

test("card helper-token-page-cold: a search carries at most what the proxy's QUERY_MAX takes (100 mints of 44 characters do not fit); the rest go in the next", async (t) => {
  clock(t);
  const proxy = searchProxy();
  const real = createProxy({}, { fetch: (async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as never, now: () => Date.now() });
  const sized = { calls: proxy.calls, handle: async (v: string, p: string, q: string) => ((await real.handle(v, p, q, "", undefined, true)).status === 413 ? { status: 413, headers: {}, body: "{}" } : proxy.handle(v, p, q)) };
  const tok = T.createSolanaToken(sized, rpc, { now: () => Date.now() });
  // 100 mints of 44 characters, asked together
  const long: string[] = [];
  for (let n = 0; long.length < T.SEARCH_MAX; n++) if (mint(n).length === 44) long.push(mint(n));
  const pages = long.map((m) => ask(tok, m));
  await run(t, 2_000);
  assert.ok(pages.every((h) => h.done?.status === 200), `${pages.filter((h) => h.done?.status !== 200).length} pages not 200`);
  assert.equal(proxy.calls.length, 2, "two searches");
  assert.ok(proxy.calls.every((c) => `query=${c.mints.join(",")}`.length <= 4_096));
});

/** Card helper-crowd-429 fold 6: the helper live suite's helper-token-page-cold (16 pairs of cold page reads, PAIR_GAP_MS
 *  10 s apart, the second of a pair as soon as the first answers) through the real proxy, against a Jupiter that answers
 *  one search 429 with Retry-After `ra` (live run 41943005189 at 9beb5ba: "30 of 32 page reads answered 200; 2 did not:
 *  429 Retry-After 4, 429 Retry-After 1", the helper's log "jupiter provider 429" then "jupiter held" on /v1/market/token
 *  and /v1/proxy), and a device's swap build that arrives inside the hold. */
async function suiteWithOne429(t: TestContext, ra: number) {
  clock(t);
  let searches = 0;
  const upstream: { at: number; path: string; status: number }[] = [];
  const proxy = createProxy({}, {
    now: () => Date.now(),
    fetch: (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/tokens/v2/search" && ++searches === 9) {
        upstream.push({ at: Date.now(), path: u.pathname, status: 429 });
        await new Promise((ok) => setTimeout(ok, LAT)); // the 429 takes its round trip too
        return new Response('{"message":"Rate limit exceeded"}', { status: 429, headers: { "content-type": "application/json", "retry-after": String(ra) } });
      }
      upstream.push({ at: Date.now(), path: u.pathname, status: 200 });
      await new Promise((ok) => setTimeout(ok, LAT));
      const body = u.pathname === "/tokens/v2/search" ? u.searchParams.get("query")!.split(",").map(rowOf) : { ok: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as never,
  });
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  const pages: Timed[] = [];
  let build: { status: number; body: string } | null = null;
  for (let pair = 0; pair < 16; pair++) {
    for (let k = 0; k < 2; k++) {
      const h = ask(tok, mint(1000 + pair * 2 + k));
      if (pair === 4 && k === 0) {
        // a device's build lands while the 429's hold stands
        await run(t, LAT + 50);
        void proxy.handle("jupiter", "/swap/v2/build", "q=device", "", "198.51.100.7").then((a) => (build = a));
      }
      for (let ms = 0; h.done === null && ms < 15_000; ms += 50) await run(t, 50);
      pages.push(h.done ?? { status: 0, ms: -1 });
    }
    await run(t, 10_000);
  }
  return { pages, build: build as { status: number; body: string } | null, upstream };
}

for (const ra of [1, 2, 3, 4])
  test(`card helper-crowd-429 fold 6: the suite's 32 cold page reads with one Jupiter 429 (Retry-After ${ra}) all answer 200: the hold is waited out once, then read; a build inside it never answers 429`, async (t) => {
    const r = await suiteWithOne429(t, ra);
    assert.deepEqual(r.pages.map((p) => p.status).filter((s) => s !== 200), [], `every page read 200: ${JSON.stringify(r.pages.filter((p) => p.status !== 200))}`);
    const i = r.upstream.findIndex((u) => u.status === 429);
    const inHold = r.upstream.filter((u, j) => j > i && u.at < r.upstream[i]!.at + LAT + ra * 1000);
    assert.deepEqual(inHold, [], "nothing reached Jupiter inside its reset");
    assert.ok(r.build !== null && r.build.status !== 429, `the build inside the hold: ${r.build?.status}, never our 429`);
    if (ra * 1000 + LAT < 3_000) assert.equal(r.build!.status, 200, "inside its wait (QUEUE_WAIT_MS): served");
    // after the reset the calls that waited go one a second (Jupiter Free "1 | 60"), no burst
    const after = r.upstream.filter((u) => u.at >= r.upstream[i]!.at + LAT + ra * 1000).slice(0, 2);
    if (after.length === 2 && r.build!.status === 200) assert.ok(after[1]!.at - after[0]!.at >= 1_000, `the waiters go in turn: ${after.map((u) => u.at - r.upstream[i]!.at)}`);
  });

test("card helper-crowd-429 fold 6: a Jupiter hold past the page's budget answers the not-ready 503 upstream, never 429, and nothing reaches Jupiter inside it", async (t) => {
  clock(t);
  const upstream: number[] = [];
  const proxy = createProxy({}, {
    now: () => Date.now(),
    fetch: (async () => (upstream.push(Date.now()), new Response("{}", { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } }))) as never,
  });
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  const a = ask(tok, mint(2000));
  await run(t, 200);
  const b = ask(tok, mint(2001)); // a second cold page inside the hold
  const build = proxy.handle("jupiter", "/swap/v2/build", "q=device", "", "198.51.100.8");
  for (let ms = 0; (a.done === null || b.done === null) && ms < 20_000; ms += 50) await run(t, 50);
  await run(t, 100);
  const bd = await build;
  assert.deepEqual([a.done?.status, a.done?.retryAfterS, b.done?.status, b.done?.retryAfterS], [503, undefined, 503, undefined], "not ready, no 429 and no wait of ours named");
  assert.deepEqual([bd.status, JSON.parse(bd.body)], [503, { error: { code: "upstream" } }], "the build too: the device falls back on its public path (H2.3)");
  assert.equal(upstream.length, 1, "one call met the 429; nothing else reached Jupiter inside its reset");
});

test("card helper-ready-page-warm: a page that answers not ready names why in the refusal log (never sent): Jupiter's hold or 429, the search's room, or the mint's RPC read (live runs 42087160851 and 42104885123 attempt 1: one cold page 503 each, its cause named nowhere)", async (t) => {
  clock(t);
  const why = (tok: ReturnType<typeof T.createSolanaToken>, m: string) => tok.page(m).then((a) => [a.status, a.why, a.body]);
  // Jupiter holds the search past the page's wait (its 429 with a 30 s reset)
  const held = createProxy({}, { now: () => Date.now(), fetch: (async () => new Response("{}", { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } })) as never });
  const a = why(T.createSolanaToken(held, rpc, { now: () => Date.now() }), mint(3000));
  for (let ms = 0; ms < 20_000; ms += 50) await run(t, 50);
  assert.deepEqual(await a, [503, "jupiter held", '{"error":{"code":"upstream"}}'], "Jupiter's 429 holds it past the wait: the body unchanged, the cause logged");
  // the mint's RPC read fails
  const down = { handle: async () => ({ status: 503, body: '{"error":{"code":"upstream"}}', why: "solana held" }) };
  const ok = searchProxy();
  const b = why(T.createSolanaToken(ok, down, { now: () => Date.now() }), mint(3001));
  await run(t, 1_000);
  assert.deepEqual((await b).slice(0, 2), [503, "solana rpc: solana held"], "the RPC's own why");
});

test("card helper-ready-page-warm: a not-ready page tells its caller why in the standard Server-Timing header: search-held, search-429 (desc the proxy's reason) or rpc, never a URL, a key or the caller's input", async (t) => {
  clock(t);
  const timing = (tok: ReturnType<typeof T.createSolanaToken>, m: string) => tok.page(m).then((a) => [a.status, a.timing, a.body]);
  const proxyOf = (retryAfter: string) => createProxy({}, { now: () => Date.now(), fetch: (async () => new Response("{}", { status: 429, headers: { "content-type": "application/json", "retry-after": retryAfter } })) as never });
  const held = timing(T.createSolanaToken(proxyOf("30"), rpc, { now: () => Date.now() }), mint(3100));
  for (let ms = 0; ms < 20_000; ms += 50) await run(t, 50);
  assert.deepEqual(await held, [503, 'search-held;desc="jupiter held"', '{"error":{"code":"upstream"}}'], "Jupiter's hold past the wait");
  const twice = timing(T.createSolanaToken(proxyOf("1"), rpc, { now: () => Date.now() }), mint(3101));
  for (let ms = 0; ms < 20_000; ms += 50) await run(t, 50);
  assert.deepEqual(await twice, [503, 'search-429;desc="jupiter provider 429"', '{"error":{"code":"upstream"}}'], "Jupiter's 429 twice");
  const down = { handle: async () => ({ status: 503, body: '{"error":{"code":"upstream"}}', why: "solana held" }) };
  const r = timing(T.createSolanaToken(searchProxy(), down, { now: () => Date.now() }), mint(3102));
  await run(t, 1_000);
  assert.deepEqual((await r).slice(0, 2), [503, 'rpc;desc="solana held"'], "the mint's RPC read");
});

// card helper-page-jup-429: a cold page's search that Jupiter answers 429, 429, then 200 (resets of 1 s, inside the
// search's SEARCH_HOLD_WAIT_MS) is the page's 200; at c1525df5 the proxy retried once, so the second 429 was a 503
test("card helper-page-jup-429: a cold page's search met by a Jupiter 429, a 429 and a 200 answers the page 200", async (t) => {
  clock(t);
  let n = 0;
  const proxy = createProxy({}, {
    now: () => Date.now(),
    fetch: (async (url: string) => {
      n++;
      if (n <= 2) return new Response("{}", { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } });
      const mints = new URL(url).searchParams.get("query")!.split(",");
      return new Response(JSON.stringify(mints.map(rowOf)), { headers: { "content-type": "application/json" } });
    }) as never,
  });
  const a = ask(T.createSolanaToken(proxy, rpc, { now: () => Date.now() }), mint(3200));
  for (let ms = 0; a.done === null && ms < 20_000; ms += 50) await run(t, 50);
  assert.equal(a.done?.status, 200, `the page after two resets: ${a.done?.status}`);
  assert.equal(n, 3, "three sends: two 429s and the read");
});
