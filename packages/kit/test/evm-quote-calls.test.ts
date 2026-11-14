// A recorded Robinhood mainnet buy quote (test/evm-quote-calls-record.ts: USDG, its reference search over every USDG
// pool of the device's pool index) replayed call by call through the quote's own providers, each POST answered after
// POST_MS, the measured average (card robinhood-quotes-inside-provider-limits: 61-66 KB posts answered in 175-250 ms on
// robinhood-rpc.publicnode.com and robinhood.drpc.org, 2026-11-14 04:55-05:08Z). Each provider takes as many requests
// at once as the venue list pins for it: one in-flight limit for every provider, the scan's 2, held this quote's
// hundreds of posts in a queue for 10 s and more on mainnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { evmJsonRpc, evmPoolBuyQuoteWith, evmPoolIndexReset, evmPoolIndexUse, evmProviders, evmRanked, evmSpeedReset, type EvmPoolBuyQuoteRequest } from "../src/checks/evm/quote.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { callKey } from "./evm-quote-calls-record.ts";

const F = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/evm-quote-calls.json.gz", import.meta.url))).toString("utf8"));
const POST_MS = 200;
// The bound: the recorded quote's 195 posts at POST_MS a post took 6.3 s through each provider's pinned limit and
// 10.7 s through one limit of 2 for every provider (the replay's own work 0.9 s of each, with no wait a post), so a
// runner twice as slow stays inside it and the one limit of 2 never does
const BOUND_MS = 8_000;

const replay = () => {
  const answers = new Map<string, unknown>(F.calls);
  const own = new Map<string, unknown>(F.own);
  const missed: string[] = [];
  const flying = new Map<string, number>();
  const most = new Map<string, number>();
  let posts = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    flying.set(host, (flying.get(host) ?? 0) + 1);
    most.set(host, Math.max(most.get(host) ?? 0, flying.get(host)!));
    posts++;
    try {
      await new Promise((r) => setTimeout(r, POST_MS));
      const sent = JSON.parse(String(init?.body));
      const one = (c: { id: unknown; method: string; params: unknown }) => {
        const k = callKey(c);
        if (own.has(`${host} ${k}`)) return { jsonrpc: "2.0", id: c.id, ...(own.get(`${host} ${k}`) as object) };
        if (!answers.has(k)) {
          missed.push(k.slice(0, 120));
          return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
        }
        return { jsonrpc: "2.0", id: c.id, ...(answers.get(k) as object) };
      };
      return new Response(JSON.stringify(Array.isArray(sent) ? sent.map(one) : one(sent)), { status: 200, headers: { "content-type": "application/json" } });
    } finally {
      flying.set(host, flying.get(host)! - 1);
    }
  }) as typeof fetch;
  return { fetchFn, missed, most, posts: () => posts };
};

test("the recorded USDG quote's reads finish inside the bound through each provider's own in-flight limit, and pick the same quote", async () => {
  evmSpeedReset();
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
  const t = performance.now();
  const q = await evmPoolBuyQuoteWith(req, evmProviders(evmRanked(v.providers!), r.fetchFn), F.now, scans).catch((e) => {
    throw new Error(`${e}; calls not in the recording: ${r.missed.length} ${JSON.stringify(r.missed.slice(0, 4))}`);
  });
  const ms = performance.now() - t;
  console.log(`replayed in ${Math.round(ms)} ms, ${r.posts()} posts, most at once per host ${JSON.stringify(Object.fromEntries(r.most))}`);
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
  assert.ok(ms <= BOUND_MS, `the quote's reads took ${Math.round(ms)} ms at ${POST_MS} ms a post, past ${BOUND_MS} ms`);
});

test("each mainnet quote provider has its own in-flight pin, and no pin names another URL", () => {
  for (const chain of ["base", "robinhood"] as const) {
    const v = evmPoolVenues()[chain];
    assert.deepEqual(Object.keys(v.inflight ?? {}).sort(), [...v.providers!].sort(), chain);
    for (const n of Object.values(v.inflight!)) assert.ok(Number.isSafeInteger(n) && n >= 1 && n <= 8, `${chain}: ${n}`);
  }
  // the chain's own Robinhood RPC, the scan's seat, stays at the 2 at once the helper's pace records for it
  assert.equal(evmPoolVenues().robinhood.inflight!["https://rpc.mainnet.chain.robinhood.com"], 2);
});
