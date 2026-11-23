// Card evm-quote-no-30s-head-wait: a Robinhood quote never runs out its deadline on a slow scan provider. The scan's
// chain is the first (rpc.mainnet.chain.robinhood.com), daybreak, then Pocket, the last, which takes only blocks the two
// before it failed. Read-only Robinhood taps from this Mac (22 Nov 17:40-17:45Z) ended stale_quote at 29.6 to 51.6 s while
// Pocket left a getLogs unanswered 10 s, then answered in 3.9 and 6.2 s and 429. The recorded PONS taps (two cold quotes,
// the second a follow at its pinned block, then a warm one; test/evm-warm-tap-calls-record.ts) are replayed here on the
// test clock, every post answered POST_MS after it is sent, with daybreak's getLogs answering HTTP 503 (its blocks go to
// Pocket) and every Pocket getLogs either never answered (until its signal ends it) or answered 429. Each quote must end
// inside the last provider's bound and never stale_quote; Pocket alone failing changes no quote's outcome.
//   node --test test/evm-scan-last-provider.test.ts      (from packages/kit)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { EvmPoolBuyQuoteRequest } from "../src/checks/evm/quote.ts";
import { evmPaceReset } from "../src/checks/evm/pace.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { callKey } from "./evm-quote-calls-record.ts";
import { onTestClock } from "./test-clock.ts";
import { untilAborted } from "../src/abort.ts";

const F = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/evm-warm-tap-calls.json.gz", import.meta.url))).toString("utf8"));
const POST_MS = 200;
/** The longest any quote here may take with its scan's blocks on a last provider that fails them: the recorded cold
 *  quote's 3.4 s, the last provider's bound (EVM_SCAN_LAST_MS, 4 s) and 2 s of margin; main took 27.4 to 60.2 s. */
const ENDS_WITHIN_MS = 9_400;

type Call = { id: unknown; method: string; params: unknown[] };
type Q = { phase: string; now: number; request: Record<string, unknown> & { buys: string; amountIn: string }; outcome: string };
/** What a post gets, by the quote's place in the recording (0, 1 or 2), its host and its calls: no answer until its
 *  signal ends it, HTTP 429 or HTTP 503; undefined: its recorded answer. */
type Act = (quote: number, host: string, calls: Call[]) => "hang" | "429" | "503" | undefined;


/** The recording's taps replayed, each quote's time on the test clock; with `hang`, the first post of that quote it
 *  names hangs until its signal ends it (the provider's 10 s timeout), as a post no provider answers. Each run on its
 *  own instance of the quote module, so no scan, plan or measure of one run reaches the next. */
let runs = 0;
const run = async (act?: Act) => {
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
    // each call's answer given last (the provider asked last for it), by its key
    const last = new Map<string, number>();
    let quote = -1;
    const acted: string[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const host = new URL(String(url)).host;
      const body = JSON.parse(String(init?.body));
      const calls: Call[] = Array.isArray(body) ? body : [body];
      const a = act?.(quote, host, calls);
      if (a !== undefined) acted.push(`${quote}:${host}:${a}`);
      if (a === "hang") await untilAborted(init?.signal);
      if (a === "429") return new Response("Too Many Requests", { status: 429 });
      if (a === "503") return new Response("Service Unavailable", { status: 503 });
      await new Promise((go) => setTimeout(go, POST_MS));
      const one = (c: Call) => {
        const k = callKey(c);
        const all = answers.get(k);
        if (all === undefined) return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "not in the recording" } };
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
    return { out, acted, why };
  });
};


const logs = (calls: Call[]) => calls.some((c) => c.method === "eth_getLogs");
const POCKET = "robinhood.api.pocket.network";
const DAYBREAK = "robinhood.daybreak-rpc.network";
const on = (hosts: Record<string, "hang" | "429" | "503">): Act => (_q, host, calls) => (logs(calls) ? hosts[host] : undefined);

for (const [name, act] of [
  ["L1 Pocket, the last scan provider, never answers a getLogs it is handed (daybreak answers 503)", on({ [DAYBREAK]: "503", [POCKET]: "hang" })],
  ["L2 Pocket, the last scan provider, answers 429 to every getLogs it is handed (daybreak answers 503)", on({ [DAYBREAK]: "503", [POCKET]: "429" })],
] as [string, Act][]) {
  test(`${name}: every quote ends inside the last provider's bound, never stale_quote`, { timeout: 300_000 }, async () => {
    const r = await run(act);
    console.log(`${name.split(" ")[0]}: ${JSON.stringify(r.out)}`);
    assert.ok(r.acted.some((x) => x.includes(POCKET)), "the scan never handed Pocket a request");
    for (const [k, q] of r.out.entries()) {
      assert.notEqual(q.outcome, "stale_quote", `quote ${k} ran out its deadline`);
      assert.ok(q.ms <= ENDS_WITHIN_MS, `quote ${k} took ${q.ms} ms (${q.outcome})`);
    }
  });
}

for (const [name, act] of [
  ["C1 Pocket alone never answers a getLogs", on({ [POCKET]: "hang" })],
  ["C2 Pocket alone answers 429 to every getLogs", on({ [POCKET]: "429" })],
] as [string, Act][]) {
  test(`${name}: the quotes end as recorded, in the recorded time`, { timeout: 300_000 }, async () => {
    const base = await run();
    assert.deepEqual(base.out.map((x) => x.outcome), (F.quotes as Q[]).map((x) => x.outcome), "the replay as recorded");
    const r = await run(act);
    assert.deepEqual(r.out, base.out);
  });
}
