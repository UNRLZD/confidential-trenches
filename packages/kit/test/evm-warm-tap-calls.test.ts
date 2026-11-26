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
import { EVM_NOOP_HOOK_CODE, evmAgreedReset, evmJsonRpc, evmPoolBuyQuoteWith, evmPoolIndexReset, evmPoolIndexUse, evmProviders, evmQuoteWarmReset, evmRanked, evmSpeedReset, type EvmPoolBuyQuoteRequest } from "../src/checks/evm/quote.ts";
import { evmPaceReset, evmProviderHold } from "../src/checks/evm/pace.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { callKey, hookSpeculation } from "./evm-quote-calls-record.ts";
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
 *  a warm quote speculates with a hook of its plan replaced that the recording predates is answered as a provider's
 *  error and set apart (`spec`, hookSpeculation). Any other call the recording does not hold is missed, as before. */
const replay = (rec: Rec = F) => {
  let phase: Phase = "cold";
  let quote = 0;
  const answers = new Map<string, [string, unknown][]>(rec.calls);
  const latest = answers.get(JSON.stringify(["eth_getBlockByNumber", ["latest", false]])) ?? [];
  if (latest.length !== 2 * rec.quotes.length) throw new Error(`the recording holds ${latest.length} heads at "latest" for ${rec.quotes.length} quotes, not two a quote`);
  const spec: string[] = [];
  const speculated = hookSpeculation(answers.keys());
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
      if (all === undefined && speculated(c)) {
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
  // the four reads the warm quote speculates with the plan's hook replaced, and no other (review of 7c0291eb2, LOW)
  assert.equal(r.spec.length, 4, `reads set apart: ${r.spec.join("; ")}`);
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
const HOOK = "0xe5e7000000000000000000000000000000000044";
const STRANGER = "0x5e5e000000000000000000000000000000000044";
const call = (data: string, overrides: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MC3, data }, "0x64", overrides] });
const quoteOf = (hook: string, n: number) => "0x82ad56cb" + hook.slice(2).padStart(64, "0") + n.toString(16).padStart(64, "0");
const tiny = (): Rec => ({
  quotes: [{}],
  calls: [
    [JSON.stringify(["eth_call", call(quoteOf(HOOK, 1), { [HOOK]: { code: EVM_NOOP_HOOK_CODE } }).params]), [["robinhood-rpc.publicnode.com", { result: "0x" }]]],
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

test("RP3 the replay sets apart only a read with a hook of its plan replaced by the no-op hook, and misses a swap-fit read or a read replacing any other code that the recording lacks", () => onTestClock(async () => {
  const r = replay(tiny());
  r.at("warm", 0);
  // a read of the plan's hook the recording predates: a provider's error, set apart
  assert.ok((await post(r, call(quoteOf(HOOK, 2), { [HOOK]: { code: EVM_NOOP_HOOK_CODE } }))).error !== undefined);
  assert.deepEqual([r.spec.length, r.missed], [1, []]);
  // a swap fit the recording lacks (its override a balance): missed
  await post(r, call(SEL_BUY_SWAP + HOOK.slice(2).padStart(64, "0"), { "0x9306359400000000000000000000000000000001": { balance: "0x1" } }));
  assert.equal(r.missed.length, 1, "a swap-fit read the recording lacks was set apart");
  // a swap fit with the plan's hook replaced: still missed
  await post(r, call(SEL_BUY_SWAP + HOOK.slice(2).padStart(64, "0"), { [HOOK]: { code: EVM_NOOP_HOOK_CODE } }));
  assert.equal(r.missed.length, 2, "a swap-fit read with a hook replaced was set apart");
  // the no-op at a hook outside the plan, or other code at the plan's hook: missed
  await post(r, call(quoteOf(STRANGER, 2), { [STRANGER]: { code: EVM_NOOP_HOOK_CODE } }));
  await post(r, call(quoteOf(HOOK, 3), { [HOOK]: { code: "0x00" } }));
  // the plan's hook given the no-op code in a read that names another pool's hook
  await post(r, call(quoteOf(STRANGER, 3), { [HOOK]: { code: EVM_NOOP_HOOK_CODE } }));
  assert.deepEqual([r.spec.length, r.missed.length], [1, 5], "a read replacing a hook outside the plan, other code, or a hook the read does not name, was set apart");
}));

// Card evm-quote-fewer-rounds: a warm tap's reads beside its first round (the kept swap fits, the plan's early and held
// reads, the pruned pools') were sent before the round's own, so at a paced provider they took its turns first. With
// dRPC held after its own 429s, a warm Robinhood ANT tap's 17 kept fits held bloXroute (6 calls a second) until 3.1 s
// and the round's own posts left it from 3.6 to 10.7 s (read only from the Mac, 2026-11-25 23:0xZ). Here, dRPC held
// for the recorded warm tap: 2,402 ms of the test clock with them sent first, 1,868 behind the round's own
const WARM_HELD_MS = 2_000;
test("BS1 card evm-quote-fewer-rounds: with dRPC held, the recorded warm PONS tap's reads beside its first round wait behind the round's own at bloXroute's pace, so it ends inside 2,000 ms of the test clock, quoting what the recording quoted", { timeout: 120_000 }, async () => {
  // its own instance of the quote module, so no scan, plan or measure of the replay above reaches it (as
  // test/evm-scan-last-provider.test.ts runs each replay); the pace module is the one both share, reset here
  const run = "bs1";
  const q = (await import(`../src/checks/evm/quote.ts?run=${run}`)) as typeof import("../src/checks/evm/quote.ts");
  await onTestClock(async () => {
    q.evmSpeedReset();
    evmPaceReset();
    q.evmPoolIndexReset();
    q.evmAgreedReset();
    q.evmQuoteWarmReset();
    const ix = F.index;
    q.evmPoolIndexUse("robinhood", {
      index: { chainId: ix.chainId, poolManager: ix.poolManager, from: ix.from },
      coversThrough: ix.coversThrough,
      pools: ix.pools.map(([currency0, currency1, fee, tickSpacing, hooks]: [string, string, number, number, string]) => ({ key: { currency0, currency1, fee, tickSpacing, hooks } })),
    });
    const v = evmPoolVenues().robinhood;
    const r = replay();
    const scans = [v.scan!.url, ...(v.scan!.spares ?? []).map((s) => s.url)].map((u) => q.evmJsonRpc(u, r.fetchFn, 16 << 20));
    let providers = q.evmProviders(q.evmRanked(v.providers!), r.fetchFn);
    const outcomes: string[] = [];
    // the warm tap's bound, a timer of the test clock set as the tap starts: it fires only if the tap runs past it
    let warmPast: boolean | undefined;
    for (const [k, x] of (F.quotes as { phase: Phase; now: number; request: Record<string, unknown>; outcome: string }[]).entries()) {
      r.at(x.phase, k);
      if (x.phase === "warm") {
        // dRPC held as its 429 holds it, and the device's order taken again for the tap, as each tap takes it
        evmProviderHold("https://robinhood.drpc.org", 120_000);
        providers = q.evmProviders(q.evmRanked(v.providers!), r.fetchFn);
        assert.deepEqual(q.evmRanked(v.providers!).slice(0, 2), ["https://robinhood-rpc.publicnode.com", "https://robinhood.rpc.blxrbdn.com"], "with dRPC held, bloXroute is the second seat");
      }
      let past = false;
      const bound = x.phase === "warm" ? setTimeout(() => (past = true), WARM_HELD_MS) : undefined;
      const { buys, ...rest } = x.request;
      const req = { ...rest, token: buys, amountIn: BigInt(String(x.request.amountIn)) } as EvmPoolBuyQuoteRequest;
      outcomes.push(await q.evmPoolBuyQuoteWith(req, providers, x.now, scans).then((a) => `ok ${a.amountOut} ${a.block.hash}`, (e) => String((e as { code?: unknown }).code ?? e)));
      clearTimeout(bound);
      if (x.phase === "warm") warmPast = past;
    }
    evmPaceReset();
    assert.equal(warmPast, false, `the warm tap with dRPC held ran past ${WARM_HELD_MS} ms of the test clock`);
    assert.deepEqual(r.missed, []);
    assert.deepEqual(outcomes, F.quotes.map((x: { outcome: string }) => x.outcome), "every quote of the replay ends as the recording's did");
  });
});
