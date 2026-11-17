// A recorded Robinhood mainnet buy quote (test/evm-quote-calls-record.ts: USDG, its reference search over every USDG
// pool of the device's pool index) replayed call by call through the quote's own providers, each POST answered after
// POST_MS, the measured average (card robinhood-quotes-inside-provider-limits: 61-66 KB posts answered in 175-250 ms on
// robinhood-rpc.publicnode.com and robinhood.drpc.org, 2026-11-14 04:55-05:08Z). Each provider takes as many requests
// at once as the venue list pins for it: one in-flight limit for every provider, the scan's 2, held this quote's
// hundreds of posts in a queue for 10 s and more on mainnet.
// The time is virtual: the quote runs on the shared test clock (test/test-clock.ts), the pace's waits (pace.ts), its
// hedges, holds and deadlines included, and each post is answered POST_MS of that clock after it is sent. The clock
// moves only to the next timer due, so the time read is the posts' time through each provider's limit and pace, the
// same on any runner. A replay clock of its own that moved only on posts counted none of the pace's waits: the quote
// read 7.2 s on it and 13.4 s on the shared clock (card robinhood-quote-inside-the-bound-under-the-pace).
// Topped up 2026-11-17 at the recording's own block hash (card evm-buy-never-below-a-hidden-market): 27 calls the
// rule adds, read again on the providers; the quote and its reference unchanged, 194 posts in 7.07 s of the clock
// (main 195 in 7.23 s).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { evmJsonRpc, evmPoolBuyQuoteWith, evmPoolIndexReset, evmPoolIndexUse, evmProviders, evmRanked, evmSpeedReset, type EvmPoolBuyQuoteRequest } from "../src/checks/evm/quote.ts";
import { evmPaceReset } from "../src/checks/evm/pace.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { callKey } from "./evm-quote-calls-record.ts";
import { onTestClock } from "./test-clock.ts";

const F = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/evm-quote-calls.json.gz", import.meta.url))).toString("utf8"));
const POST_MS = 200;
// The bound: the recorded quote's posts at POST_MS a post take about 5.4 s of the clock through each provider's pinned
// limit and about 9.8 s through one limit of 2 for every provider (6.3 s and 10.7 s measured on the real clock, the
// replay's own work 0.9 s of each)
const BOUND_MS = 8_000;

const replay = () => {
  const answers = new Map<string, unknown>(F.calls);
  const own = new Map<string, unknown>(F.own);
  const missed: string[] = [];
  const flying = new Map<string, number>();
  const most = new Map<string, number>();
  const sent = new Map<string, number>();
  let posts = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    flying.set(host, (flying.get(host) ?? 0) + 1);
    most.set(host, Math.max(most.get(host) ?? 0, flying.get(host)!));
    sent.set(host, (sent.get(host) ?? 0) + 1);
    posts++;
    try {
      await new Promise((go) => setTimeout(go, POST_MS));
      const body = JSON.parse(String(init?.body));
      const one = (c: { id: unknown; method: string; params: unknown }) => {
        const k = callKey(c);
        if (own.has(`${host} ${k}`)) return { jsonrpc: "2.0", id: c.id, ...(own.get(`${host} ${k}`) as object) };
        if (!answers.has(k)) {
          missed.push(k.slice(0, 120));
          return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
        }
        return { jsonrpc: "2.0", id: c.id, ...(answers.get(k) as object) };
      };
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
    } finally {
      flying.set(host, flying.get(host)! - 1);
    }
  }) as typeof fetch;
  return { fetchFn, missed, most, sent, posts: () => posts };
};

test("the recorded USDG quote's reads finish inside the bound through each provider's own in-flight limit and pace, and pick the same quote", () => onTestClock(async () => {
  evmSpeedReset();
  evmPaceReset();
  evmPoolIndexReset();
  const ix = F.index;
  assert.equal(
    evmPoolIndexUse("robinhood", {
      index: { chainId: ix.chainId, poolManager: ix.poolManager, from: ix.from },
      coversThrough: ix.coversThrough,
      pools: ix.pools.map(([currency0, currency1, fee, tickSpacing, hooks]: [string, string, number, number, string]) => ({ key: { currency0, currency1, fee, tickSpacing, hooks } })),
    }),
    true,
  );
  const v = evmPoolVenues().robinhood;
  const r = replay();
  const scans = [v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => evmJsonRpc(u, r.fetchFn, 16 << 20));
  const { buys, ...rest } = F.request;
  const req: EvmPoolBuyQuoteRequest = { ...rest, token: buys, amountIn: BigInt(F.request.amountIn) };
  // the bound's mark: a timer of the clock at BOUND_MS + 1 that fires only if the quote has not ended by then
  let late = false;
  const mark = setTimeout(() => (late = true), BOUND_MS + 1);
  const t0 = performance.now();
  const q = await evmPoolBuyQuoteWith(req, evmProviders(evmRanked(v.providers!), r.fetchFn), F.now, scans)
    .catch((e) => {
      throw new Error(`${e}; calls not in the recording: ${r.missed.length} ${JSON.stringify(r.missed.slice(0, 4))}`);
    })
    .finally(() => clearTimeout(mark));
  console.log(`replayed in ${performance.now() - t0} ms of the clock, ${r.posts()} posts, most at once per host ${JSON.stringify(Object.fromEntries(r.most))}, posts per host ${JSON.stringify(Object.fromEntries(r.sent))}`);
  // the pick: the quote the recording made, every field the device signs from
  assert.deepEqual(r.missed, []);
  assert.equal(F.outcome.code, "ok");
  assert.equal(q.amountOut.toString(), F.outcome.amountOut);
  assert.equal(q.minOut.toString(), F.outcome.minOut);
  assert.deepEqual(q.route, F.outcome.route);
  assert.equal(q.block.number.toString(), F.outcome.block.number);
  assert.equal(q.block.hash, F.outcome.block.hash);
  assert.deepEqual(q.reference === null ? null : { route: q.reference.route, amountOut: q.reference.amountOut.toString() }, F.outcome.reference);
  // no provider is asked more at once than the venue list pins for it
  // (the scan's hosts are left out: their scan requests have the scan's own gate)
  const scanHosts = new Set([v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => new URL(u).host));
  for (const [host, n] of r.most) {
    if (scanHosts.has(host)) continue;
    const url = v.providers!.find((u) => new URL(u).host === host);
    const pin = url === undefined ? undefined : v.inflight?.[url];
    if (pin !== undefined) assert.ok(n <= pin, `${host}: ${n} at once, its pin ${pin}`);
  }
  assert.equal(late, false, `the quote's reads ran past ${BOUND_MS} ms of the clock at ${POST_MS} ms a post`);
}));

test("each mainnet quote provider has its own in-flight pin, and no pin names another URL", () => {
  for (const chain of ["base", "robinhood"] as const) {
    const v = evmPoolVenues()[chain];
    assert.deepEqual(Object.keys(v.inflight ?? {}).sort(), [...v.providers!].sort(), chain);
    for (const n of Object.values(v.inflight!)) assert.ok(Number.isSafeInteger(n) && n >= 1 && n <= 8, `${chain}: ${n}`);
  }
  // the chain's own Robinhood RPC, the scan's seat, stays at the 2 at once the helper's pace records for it
  assert.equal(evmPoolVenues().robinhood.inflight!["https://rpc.mainnet.chain.robinhood.com"], 2);
  // inside the helper's pace in calls at once (apps/helper/src/limits/limits.ts PROVIDER_PACE), a quote's post up to 3 calls
  assert.equal(evmPoolVenues().robinhood.inflight!["https://robinhood.drpc.org"], 5);
  assert.equal(evmPoolVenues().base.inflight!["https://base-rpc.publicnode.com"], 2);
});
