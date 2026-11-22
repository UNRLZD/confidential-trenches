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
type Rec = { quotes: unknown[]; calls: [string, [string, unknown][]][] };
const MC3 = "0xca11bde05977b3631167028862be2a173976ca11";
/** The recording's answers to each call, in the order they came, each with its host: a call is answered with the next
 *  of its answers not yet given, its host's own first, and the last once all are given. Matched by content where the
 *  order of the calls carries no meaning (card evm-quote-fewer-rounds, as a VCR replay matches): a head at "latest" is
 *  its quote's own recorded head (the recording reads two a quote, in the quotes' order), so a quote that reads its head
 *  more or fewer times than the recording did still holds the recording's block; a getLogs span the recording does not
 *  hold is answered from a recorded span of the same filter that covers it whole, its logs inside the span; and a read
 *  with a hook's code replaced (a state override other than Multicall3's own) that the recording predates is answered
 *  as a provider's error (`spec`), as the read a warm quote speculates beside its first round, whose failure ends
 *  nothing. Any other call the recording does not hold is missed, as before. */
const replay = (rec: Rec = F) => {
  let phase: Phase = "cold";
  let quote = 0;
  const answers = new Map<string, [string, unknown][]>(rec.calls);
  const latest = answers.get(JSON.stringify(["eth_getBlockByNumber", ["latest", false]])) ?? [];
  if (latest.length !== 2 * rec.quotes.length) throw new Error(`the recording holds ${latest.length} heads at "latest" for ${rec.quotes.length} quotes, not two a quote`);
  const spec: string[] = [];
  // each recorded getLogs: its filter without the span, and the span
  const spans = [...answers.entries()].flatMap(([k, all]) => {
    const [m, ps] = JSON.parse(k) as [string, { fromBlock?: string; toBlock?: string }[]];
    if (m !== "eth_getLogs" || ps[0]?.fromBlock === undefined || ps[0]?.toBlock === undefined) return [];
    const { fromBlock, toBlock, ...rest } = ps[0];
    return [{ filter: JSON.stringify(rest), from: BigInt(fromBlock), to: BigInt(toBlock), all }];
  });
  const given = new Map<string, Set<number>>();
  // each call's answer given last (the provider asked last for it), by its key
  const last = new Map<string, number>();
  const missed: string[] = [];
  const fits = { cold: 0, warm: 0 };
  // the swap-fit reads by call (each a route read at a block): a route read by every seat of a round is one route
  const fitKeys = { cold: new Set<string>(), warm: new Set<string>() };
  const calls = { cold: 0, warm: 0 };
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    // each call counted in the phase it was sent in: a cold quote's post still out when its round was agreed (a quorum's
    // third, never cut once sent) is the cold quote's, though answered after the warm tap starts
    const sentIn = phase;
    await new Promise((go) => setTimeout(go, POST_MS));
    const body = JSON.parse(String(init?.body));
    const one = (c: { id: unknown; method: string; params: unknown[] }) => {
      calls[sentIn]++;
      if (c.method === "eth_call" && String((c.params?.[0] as { data?: string })?.data).startsWith(SEL_BUY_SWAP)) {
        fits[sentIn]++;
        fitKeys[sentIn].add(callKey(c));
      }
      const k = callKey(c);
      if (c.method === "eth_getBlockByNumber" && (c.params?.[0] as unknown) === "latest") {
        const pair = latest.slice(2 * quote, 2 * quote + 2);
        if (pair.length === 0) {
          missed.push(`${sentIn} ${k.slice(0, 140)} (a head outside every recorded quote)`);
          return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
        }
        return { jsonrpc: "2.0", id: c.id, ...((pair.find(([h]) => h === host) ?? pair[0]!)[1] as object) };
      }
      let all = answers.get(k);
      if (all === undefined && c.method === "eth_getLogs") {
        const { fromBlock, toBlock, ...rest } = (c.params?.[0] ?? {}) as { fromBlock?: string; toBlock?: string };
        if (fromBlock !== undefined && toBlock !== undefined) {
          const [from, to] = [BigInt(fromBlock), BigInt(toBlock)];
          const listed = (a: unknown) => Array.isArray((a as { result?: unknown }).result);
          const cover = spans.find((x) => x.filter === JSON.stringify(rest) && x.from <= from && x.to >= to && x.all.some(([, a]) => listed(a)));
          if (cover !== undefined) {
            const logs = (cover.all.find(([, a]) => listed(a))![1] as { result: { blockNumber: string }[] }).result;
            all = [[host, { result: logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to) }]];
          }
        }
      }
      const hooked = c.method === "eth_call" && Object.keys((c.params?.[2] ?? {}) as object).some((a) => a.toLowerCase() !== MC3);
      if (all === undefined && hooked) {
        spec.push(`${sentIn} ${k.slice(0, 140)}`);
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
      }
      if (all === undefined) {
        missed.push(`${sentIn} ${k.slice(0, 140)}`);
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
      }
      const g = given.get(k) ?? new Set<number>();
      given.set(k, g);
      let i = all.findIndex(([h], j) => h === host && !g.has(j));
      // a provider the recording never asked for this call (a quorum's third, a stand-in) answers as the last one
      // given it did, at the same time; it never takes an answer recorded for a later ask (a newer head)
      if (i < 0 && last.has(k)) i = last.get(k)!;
      if (i < 0) i = all.findIndex((_, j) => !g.has(j));
      if (i < 0) i = all.length - 1;
      g.add(i);
      last.set(k, i);
      return { jsonrpc: "2.0", id: c.id, ...(all[i]![1] as object) };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, missed, spec, fits, fitKeys, calls, at: (p: Phase, k: number) => void ((phase = p), (quote = k)) };
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
  for (const [k, x] of (F.quotes as { phase: Phase; now: number; request: Record<string, unknown> & { buys: string; amountIn: string }; outcome: string }[]).entries()) {
    r.at(x.phase, k);
    const { buys, ...rest } = x.request;
    const req = { ...rest, token: buys, amountIn: BigInt(x.request.amountIn) } as EvmPoolBuyQuoteRequest;
    const got = await evmPoolBuyQuoteWith(req, providers, x.now, scans).then(
      (q) => `ok ${q.amountOut} ${q.block.hash}`,
      (e) => String((e as { code?: unknown }).code ?? e),
    );
    outcomes.push(got);
  }
  evmPaceReset();
  console.log(`fits cold ${r.fits.cold} warm ${r.fits.warm} (routes ${r.fitKeys.warm.size}); calls cold ${r.calls.cold} warm ${r.calls.warm}; speculative reads the recording predates ${r.spec.length}; outcomes ${JSON.stringify(outcomes)}`);
  assert.deepEqual(r.missed, []);
  assert.deepEqual(outcomes, F.quotes.map((x: { outcome: string }) => x.outcome), "every quote of the replay ends as the recording's did");
  assert.ok(r.fitKeys.warm.size <= WARM_FITS_MAX, `the warm tap read the swap fit of ${r.fitKeys.warm.size} routes, more than ${WARM_FITS_MAX}`);
  // each read on at most the round's three seats (the quorum, card evm-warm-tap-ends-inside-two-seconds: two agreeing of three)
  assert.ok(r.fits.warm <= 3 * WARM_FITS_MAX, `the warm tap sent ${r.fits.warm} swap-fit reads over its seats, more than ${3 * WARM_FITS_MAX}`);
}));

// the replay's own planted cases (card evm-quote-fewer-rounds): what it answers by content, and what it still misses
const post = async (r: ReturnType<typeof replay>, body: unknown) =>
  (await (await r.fetchFn("https://robinhood-rpc.publicnode.com", { method: "POST", body: JSON.stringify(body) })).json()) as { result?: unknown; error?: unknown };
const LOGS_FILTER = { address: "0x8366a39cc670b4001a1121b8f6a443a643e40951", topics: ["0xdd"] };
const logsCall = (from: number, to: number) => ({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ ...LOGS_FILTER, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }] });
const headCall = { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] };
const HEAD = { number: "0x64", hash: "0x01" };
const tiny = (): Rec => ({
  quotes: [{}],
  calls: [
    [JSON.stringify(["eth_getBlockByNumber", ["latest", false]]), [["robinhood-rpc.publicnode.com", { result: HEAD }], ["robinhood.drpc.org", { result: HEAD }]]],
    [JSON.stringify(["eth_getLogs", logsCall(10, 20).params]), [["robinhood-rpc.publicnode.com", { result: [{ blockNumber: "0xc" }, { blockNumber: "0x12" }] }]]],
  ],
});

test("RP1 the replay answers a getLogs span from a recorded span that covers it whole, its logs inside the span, and misses one it covers only in part", () => onTestClock(async () => {
  const r = replay(tiny());
  r.at("warm", 0);
  assert.deepEqual((await post(r, logsCall(15, 20))).result, [{ blockNumber: "0x12" }]);
  assert.deepEqual(r.missed, []);
  assert.ok((await post(r, logsCall(15, 25))).error !== undefined, "a span the recording covers only in part was answered");
  assert.equal(r.missed.length, 1);
}));

test("RP2 the replay answers a head at latest with its quote's own recorded head, and misses a head asked outside every recorded quote", () => onTestClock(async () => {
  const r = replay(tiny());
  r.at("cold", 0);
  for (let k = 0; k < 3; k++) assert.deepEqual((await post(r, headCall)).result, HEAD);
  assert.deepEqual(r.missed, []);
  r.at("warm", 1);
  assert.ok((await post(r, headCall)).error !== undefined, "a head outside every recorded quote was answered");
  assert.equal(r.missed.length, 1);
}));
