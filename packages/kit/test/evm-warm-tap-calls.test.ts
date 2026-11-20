// A recorded heavy coin's taps on Robinhood mainnet (test/evm-warm-tap-calls-record.ts: PONS, a cold tap of two kit
// quotes, partial_fill on the tap's first route and its reference followed, then a warm tap of one) replayed call by
// call, each quote at its recorded block and clock, each POST answered POST_MS of the test clock after it is sent.
// Card robinhood-taps-meet-no-429: the warm quote read again, beside its first round, the swap fit of every route the
// cold quote's whole-list search had read (24 of its 47 eth_call a side on mainnet, 2026-11-20 02:3xZ), where only the
// routes at or above each list's best that fits decide a verdict; at bloXroute's pace (15 calls a second) the 23 more
// were about 1.5 s of a warm tap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { evmAgreedReset, evmJsonRpc, evmPoolBuyQuoteWith, evmPoolIndexReset, evmPoolIndexUse, evmProviders, evmQuoteWarmReset, evmRanked, evmSpeedReset, type EvmPoolBuyQuoteRequest } from "../src/checks/evm/quote.ts";
import { evmPaceReset } from "../src/checks/evm/pace.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { callKey } from "./evm-quote-calls-record.ts";
import { onTestClock } from "./test-clock.ts";

const F = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/evm-warm-tap-calls.json.gz", import.meta.url))).toString("utf8"));
const POST_MS = 200;
const SEL_BUY_SWAP = "0x25faf2a3";
/** The most swap-fit reads a warm quote of the recording sends: its route's own, and each list's best that fits and
 *  any route above it (the cold quote's lists: the route, the priced routes, the native ones; each best was the
 *  first by output), one batch of three. */
const WARM_FITS_MAX = 3;

type Phase = "cold" | "warm";
/** The recording's answers to each call, in the order they came, each with its host: a call is answered with the next
 *  of its answers not yet given, its host's own first (a head at "latest" moves on as the taps' heads did), and the
 *  last once all are given. */
const replay = () => {
  let phase: Phase = "cold";
  const answers = new Map<string, [string, unknown][]>(F.calls);
  const given = new Map<string, Set<number>>();
  const missed: string[] = [];
  const fits = { cold: 0, warm: 0 };
  const calls = { cold: 0, warm: 0 };
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    await new Promise((go) => setTimeout(go, POST_MS));
    const body = JSON.parse(String(init?.body));
    const one = (c: { id: unknown; method: string; params: unknown[] }) => {
      calls[phase]++;
      if (c.method === "eth_call" && String((c.params?.[0] as { data?: string })?.data).startsWith(SEL_BUY_SWAP)) fits[phase]++;
      const k = callKey(c);
      const all = answers.get(k);
      if (all === undefined) {
        missed.push(`${phase} ${k.slice(0, 140)}`);
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
      }
      const g = given.get(k) ?? new Set<number>();
      given.set(k, g);
      let i = all.findIndex(([h], j) => h === host && !g.has(j));
      if (i < 0) i = all.findIndex((_, j) => !g.has(j));
      if (i < 0) i = all.length - 1;
      g.add(i);
      return { jsonrpc: "2.0", id: c.id, ...(all[i]![1] as object) };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, missed, fits, calls, at: (p: Phase) => void (phase = p) };
};

test("card robinhood-taps-meet-no-429: a recorded heavy warm tap (PONS) reads the swap fit only of the routes that decide its verdict, and quotes what the recording quoted", { timeout: 120_000 }, () => onTestClock(async () => {
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
  const v = evmPoolVenues().robinhood;
  const r = replay();
  const scans = [v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => evmJsonRpc(u, r.fetchFn, 16 << 20));
  const providers = evmProviders(evmRanked(v.providers!), r.fetchFn);
  const outcomes: string[] = [];
  for (const x of F.quotes as { phase: Phase; now: number; request: Record<string, unknown> & { buys: string; amountIn: string }; outcome: string }[]) {
    r.at(x.phase);
    const { buys, ...rest } = x.request;
    const req = { ...rest, token: buys, amountIn: BigInt(x.request.amountIn) } as EvmPoolBuyQuoteRequest;
    const got = await evmPoolBuyQuoteWith(req, providers, x.now, scans).then(
      (q) => `ok ${q.amountOut} ${q.block.hash}`,
      (e) => String((e as { code?: unknown }).code ?? e),
    );
    outcomes.push(got);
  }
  evmPaceReset();
  console.log(`fits cold ${r.fits.cold} warm ${r.fits.warm}; calls cold ${r.calls.cold} warm ${r.calls.warm}; outcomes ${JSON.stringify(outcomes)}`);
  assert.deepEqual(r.missed, []);
  assert.deepEqual(outcomes, F.quotes.map((x: { outcome: string }) => x.outcome), "every quote of the replay ends as the recording's did");
  assert.ok(r.fits.warm <= 2 * WARM_FITS_MAX, `the warm tap sent ${r.fits.warm} swap-fit reads over both providers, more than ${2 * WARM_FITS_MAX}`);
}));
