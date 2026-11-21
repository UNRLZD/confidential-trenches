// card evm-warm-tap-ends-inside-two-seconds, round (E): a post that hangs to its 10 s timeout never holds a tap. A post
// out past its provider's own hedge time (the 95th percentile of its answers, never under EVM_HEDGE_MS: evmHedgeAfter)
// has the next provider asked once in its place, and the first answer is read (hedged requests, "The Tail at Scale").
// Base's sign live run 44912189713 (2026-11-21 14:14Z) had a warm tap of 11,955 ms. The recorded PONS taps on
// Robinhood (test/evm-warm-tap-calls-record.ts: two cold quotes, the second a follow at its pinned block, then a warm
// one) are replayed here, each POST answered POST_MS of the test clock after it is sent, once as recorded and then with
// one post hung until its provider's 10 s timeout: the block's confirmation by number (sequential before round E), in
// the warm quote and in the cold follow, a read batch and a head. The follow at a block the device's watch holds, whose
// pin is confirmed beside its reads (pinConfirm), is H2 in test/evm-quote-follow-hung.test.ts.
//   node --test test/evm-hung-post.test.ts      (from packages/kit)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { EvmPoolBuyQuoteRequest } from "../src/checks/evm/quote.ts";
import { evmPaceReset } from "../src/checks/evm/pace.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { callKey } from "./evm-quote-calls-record.ts";
import { onTestClock } from "./test-clock.ts";

const F = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/evm-warm-tap-calls.json.gz", import.meta.url))).toString("utf8"));
const POST_MS = 200;
/** What a hung post may add to its quote: the hedge time (EVM_HEDGE_MS's 400 ms here, every answer 200 ms) and the
 *  stand-in's answer, with a margin; a hang waited out adds its 10 s. */
const HUNG_ADDS_MAX = 1_000;

type Call = { id: unknown; method: string; params: unknown[] };
type Q = { phase: string; now: number; request: Record<string, unknown> & { buys: string; amountIn: string }; outcome: string };
/** Which post hangs: `quote` the quote's place in the recording (0, 1 or 2), `is` the post's calls. */
type Hang = { quote: number; is: (calls: Call[]) => boolean };


/** The recording's taps replayed, each quote's time on the test clock; with `hang`, the first post of that quote it
 *  names hangs until its signal ends it (the provider's 10 s timeout), as a post no provider answers. Each run on its
 *  own instance of the quote module, so no scan, plan or measure of one run reaches the next. */
let runs = 0;
const run = async (hang?: Hang) => {
  const { evmAgreedReset, evmJsonRpc, evmPoolBuyQuoteWith, evmPoolIndexReset, evmPoolIndexUse, evmProviders, evmQuoteWarmReset, evmRanked, evmSpeedReset } = (await import(
    `../src/checks/evm/quote.ts?run=${++runs}`
  )) as typeof import("../src/checks/evm/quote.ts");
  return onTestClock(async () => {
    evmSpeedReset();
    evmPaceReset();
    evmPoolIndexReset();
    evmAgreedReset();
    evmQuoteWarmReset();
    const ix = F.index;
    assert.equal(
      evmPoolIndexUse("robinhood", {
        index: { chainId: ix.chainId, poolManager: ix.poolManager, from: ix.from },
        coversThrough: ix.coversThrough,
        pools: ix.pools.map(([currency0, currency1, fee, tickSpacing, hooks]: [string, string, number, number, string]) => ({ key: { currency0, currency1, fee, tickSpacing, hooks } })),
      }),
      true,
    );
    const answers = new Map<string, [string, unknown][]>(F.calls);
    const given = new Map<string, Set<number>>();
    let quote = -1;
    let hung = 0;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const host = new URL(String(url)).host;
      const body = JSON.parse(String(init?.body));
      const calls: Call[] = Array.isArray(body) ? body : [body];
      if (hang !== undefined && hung === 0 && quote === hang.quote && hang.is(calls)) {
        hung++;
        const signal = init?.signal;
        await new Promise((_, no) => signal?.addEventListener("abort", () => no(signal.reason)));
      }
      await new Promise((go) => setTimeout(go, POST_MS));
      const one = (c: Call) => {
        const k = callKey(c);
        const all = answers.get(k);
        if (all === undefined) return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
        const g = given.get(k) ?? new Set<number>();
        given.set(k, g);
        let i = all.findIndex(([h], j) => h === host && !g.has(j));
        if (i < 0) i = all.findIndex((_, j) => !g.has(j));
        if (i < 0) i = all.length - 1;
        g.add(i);
        return { jsonrpc: "2.0", id: c.id, ...(all[i]![1] as object) };
      };
      return new Response(JSON.stringify(Array.isArray(body) ? calls.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const v = evmPoolVenues().robinhood;
    const scans = [v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => evmJsonRpc(u, fetchFn, 16 << 20));
    const providers = evmProviders(evmRanked(v.providers!), fetchFn);
    const out: { outcome: string; ms: number }[] = [];
    const why: string[] = [];
    for (const x of F.quotes as Q[]) {
      quote++;
      const { buys, ...rest } = x.request;
      const req = { ...rest, token: buys, amountIn: BigInt(x.request.amountIn) } as EvmPoolBuyQuoteRequest;
      const t0 = performance.now();
      const outcome = await evmPoolBuyQuoteWith(req, providers, x.now, scans).then(
        (q) => `ok ${q.amountOut} ${q.block.hash}`,
        (e) => {
          why.push(String((e as Error)?.message).slice(0, 240));
          return String((e as { code?: unknown }).code ?? e);
        },
      );
      out.push({ outcome, ms: Math.round(performance.now() - t0) });
    }
    evmPaceReset();
    if (why.length > 0) console.log(`refusals: ${JSON.stringify(why)}`);
    if (hang !== undefined) assert.equal(hung, 1, "the planted post was never sent");
    return out;
  });
};

const byNumber = (calls: Call[]) => calls.length === 1 && calls[0]!.method === "eth_getBlockByNumber" && calls[0]!.params[0] !== "latest";
const latest = (calls: Call[]) => calls.length === 1 && calls[0]!.method === "eth_getBlockByNumber" && calls[0]!.params[0] === "latest";
const reads = (calls: Call[]) => calls.every((c) => c.method === "eth_call");

for (const [name, hang] of [
  ["H1 the warm quote's block confirmed by number", { quote: 2, is: byNumber }],
  ["H5 the follow's block confirmed by number, a cold quote", { quote: 1, is: byNumber }],
  ["H3 a warm read batch", { quote: 2, is: reads }],
  ["H4 a warm head", { quote: 2, is: latest }],
] as [string, Hang][]) {
  test(`${name}: a post hung to its 10 s timeout adds at most the hedge time and a stand-in's answer, and the quote ends as recorded`, { timeout: 120_000 }, async () => {
    const base = await run();
    assert.deepEqual(base.map((x) => x.outcome), (F.quotes as Q[]).map((x) => x.outcome), "the replay as recorded");
    const got = await run(hang);
    console.log(`${name.split(" ")[0]} as recorded ${JSON.stringify(base.map((x) => x.ms))} ms, hung ${JSON.stringify(got.map((x) => x.ms))} ms`);
    assert.equal(got[hang.quote]!.outcome, base[hang.quote]!.outcome, "the hung post changed the quote's outcome");
    assert.ok(got[hang.quote]!.ms <= base[hang.quote]!.ms + HUNG_ADDS_MAX, `the hung post held the quote ${got[hang.quote]!.ms} ms, ${base[hang.quote]!.ms} as recorded`);
  });
}
