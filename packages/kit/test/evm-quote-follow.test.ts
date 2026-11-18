// node --test test/evm-quote-follow.test.ts (from packages/kit). In its own file: the recorded quote replays only from
// a cold module (no scans, warm plans or read sizes another test's quote left).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as Q from "../src/checks/evm/quote.ts";
import { evmJsonRpc, evmPoolBuyQuoteWith, evmPoolIndexReset, evmPoolIndexUse, evmProviders, evmRanked, evmSpeedReset, type EvmHeadWatch, type EvmPoolBuyQuoteRequest } from "../src/checks/evm/quote.ts";
// read through the module so the test runs, and fails on its assertions, where they are not (main)
const evmAgreedReset = (): void => (Q as { evmAgreedReset?: () => void }).evmAgreedReset?.();
const evmQuoteWarmReset = (): void => (Q as { evmQuoteWarmReset?: () => void }).evmQuoteWarmReset?.();
import { evmPaceReset } from "../src/checks/evm/pace.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { callKey } from "./evm-quote-calls-record.ts";
import { onTestClock } from "./test-clock.ts";

const F = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/evm-quote-calls.json.gz", import.meta.url))).toString("utf8"));
const POST_MS = 200;
/** The recording's answers, each POST answered POST_MS of the test clock after it is sent; posts counted per host. */
const replay = () => {
  const answers = new Map<string, unknown>(F.calls);
  const own = new Map<string, unknown>(F.own);
  const missed: string[] = [];
  const sent = new Map<string, number>();
  let posts = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    sent.set(host, (sent.get(host) ?? 0) + 1);
    posts++;
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
  }) as typeof fetch;
  return { fetchFn, missed, sent, posts: () => posts };
};

// Card evm-cold-multihop-quote-inside-the-kpi: the buy tap follows a refusal's reference at the refused quote's block
// (`at`). A quote at a block another quote read sends only the reads that quote's providers did not agree on there: the
// recorded USDG quote asked again at its own block sends no read at all (its one post the scan provider's head), and picks the same quote. At main it read
// every one again: 194 posts, 7 s of the clock (and a follow on Base, 0x07b3d9's WETH-USDC-coin reference, a second
// cold round of about 40 posts, 1.4 s, mainnet from the Mac 2026-11-18).
test("FOLLOW the recorded USDG quote asked again at its own block (`at`) sends no read and picks the same quote", () => onTestClock(async () => {
  evmSpeedReset();
  evmPaceReset();
  evmPoolIndexReset();
  evmAgreedReset();
  evmQuoteWarmReset();
  const ix = F.index;
  evmPoolIndexUse("robinhood", {
    index: { chainId: ix.chainId, poolManager: ix.poolManager, from: ix.from },
    coversThrough: ix.coversThrough,
    pools: ix.pools.map(([currency0, currency1, fee, tickSpacing, hooks]: [string, string, number, number, string]) => ({ key: { currency0, currency1, fee, tickSpacing, hooks } })),
  });
  const v = evmPoolVenues().robinhood;
  const { buys, ...rest } = F.request;
  const req: EvmPoolBuyQuoteRequest = { ...rest, token: buys, amountIn: BigInt(F.request.amountIn) };
  const scansOf = (r: ReturnType<typeof replay>) => [v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => evmJsonRpc(u, r.fetchFn, 16 << 20));
  const r1 = replay();
  const q1 = await evmPoolBuyQuoteWith(req, evmProviders(evmRanked(v.providers!), r1.fetchFn), F.now, scansOf(r1));
  assert.deepEqual(r1.missed, []);
  // the block as the device's head watch confirmed it: its header as the recording holds it
  const head = (F.calls as [string, { result?: { baseFeePerGas?: string } }][]).find(([k]) => k === callKey({ method: "eth_getBlockByNumber", params: ["0x" + q1.block.number.toString(16), false] }))?.[1].result;
  const block = { number: q1.block.number, hash: q1.block.hash, timestamp: q1.block.timestamp, baseFeePerGas: head?.baseFeePerGas === undefined ? null : BigInt(head.baseFeePerGas) };
  const watch: EvmHeadWatch = {
    head: () => Promise.reject(new Error("a follow agrees on no new head")),
    keep: () => {},
    peek: () => null,
    held: (h: string) => (h === block.hash ? block : null),
  };
  // the follow's own reads are the cold quote's (no warm plan of the first), so each is one the first agreed on
  evmQuoteWarmReset();
  const r2 = replay();
  const q2 = await evmPoolBuyQuoteWith({ ...req, at: q1.block.hash }, evmProviders(evmRanked(v.providers!), r2.fetchFn), F.now, scansOf(r2), watch).catch((e) => {
    throw new Error(`${e}; ${r2.posts()} posts, missed ${r2.missed.length}: ${r2.missed.slice(0, 3).join(" | ")}`);
  });
  assert.equal(q2.block.hash, q1.block.hash, "the follow read at another block");
  assert.equal(q2.amountOut, q1.amountOut);
  assert.equal(q2.minOut, q1.minOut);
  assert.deepEqual(q2.route, q1.route);
  // no read sent: the one post left is the scan provider's head, the lag rule every block is held to (agreedAt)
  const scanHosts = new Set([v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => new URL(u).host));
  const reads = [...r2.sent].filter(([h]) => !scanHosts.has(h)).reduce((n, [, k]) => n + k, 0);
  assert.equal(reads, 0, `the follow sent ${reads} read posts, ${JSON.stringify(Object.fromEntries(r2.sent))}`);
  assert.ok(r2.posts() <= 1, `the follow sent ${r2.posts()} posts, ${JSON.stringify(Object.fromEntries(r2.sent))}`);
  assert.ok(r1.posts() > 100, `the first sent ${r1.posts()} posts`);
}));

