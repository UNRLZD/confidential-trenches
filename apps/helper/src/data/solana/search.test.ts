// node --test apps/helper/src/data/solana/search.test.ts: the token page's Jupiter search (token.ts, card
// helper-token-page-cold). A mint nobody holds is searched as soon as the search's part of the Jupiter bucket has room,
// one search out at a time; a held mint's refresh keeps the batched search JUP_GAP_MS apart and leaves COLD_ROOM free;
// the searches stay inside their part of PROXY_RESERVE, so a swap build is never refused behind token pages. Every
// clock here is node:test's mock (setTimeout and Date), the upstream answering after LAT ms.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
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
const clock = (t: TestContext) => t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });

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

test("card helper-token-page-cold: searches stay at SEARCH_PER_SPAN in the proxy's counted minute; the next cold one goes the moment the oldest leaves it; past SEARCH_WAIT_MAX_MS it answers 429 with the wait and is still read", async (t) => {
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
  // SEARCH_WAIT_MAX_MS, so it answers 429 naming the wait, and its mint is still searched when the slot comes
  proxy.calls.length = 0;
  const tok2 = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  for (let n = 200; proxy.calls.length < SEARCH_PER_SPAN; n++) {
    ask(tok2, mint(n));
    await run(t, LAT + 20);
  }
  const late = ask(tok2, mint(999));
  await run(t, 50);
  assert.equal(late.done?.status, 429, "not held for the slot");
  assert.ok(late.done!.retryAfterS! * 1000 > SEARCH_WAIT_MAX_MS);
  const before = proxy.calls.length;
  await run(t, late.done!.retryAfterS! * 1000 + 500);
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
  for (const h of pages) assert.ok(h.done?.status === 200 || h.done?.status === 429, `a page answers 200 or 429 with its wait, never ${h.done?.status}`);
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
