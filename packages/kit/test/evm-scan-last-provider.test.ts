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
import { evmPaceReset, evmPaceTake } from "../src/checks/evm/pace.ts";
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
 *  signal ends it, HTTP 429, HTTP 503 or no connection (`refused`, as a browser's "Failed to fetch"); undefined: its
 *  recorded answer; `late`, its recorded answer LATE_MS after it is sent. */
type Act = (quote: number, host: string, calls: Call[]) => "hang" | "429" | "503" | "refused" | "late" | undefined;
/** A `late` post's answer time: inside the last provider's bound (EVM_SCAN_LAST_MS, 4 s), as Pocket's 1,670 ms at most
 *  from the Mac (24 Nov 12:1xZ). */
const LATE_MS = 2_500;


/** The recording's taps replayed, each quote's time on the test clock; with `hang`, the first post of that quote it
 *  names hangs until its signal ends it (the provider's 10 s timeout), as a post no provider answers. Each run on its
 *  own instance of the quote module, so no scan, plan or measure of one run reaches the next. */
let runs = 0;
const run = async (act?: Act, before?: (quote: number) => void) => {
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
      if (a === "refused") throw new TypeError("Failed to fetch");
      await new Promise((go) => setTimeout(go, a === "late" ? LATE_MS : POST_MS));
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
      before?.(quote);
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

// card rh-scan-last-provider-case: the helper's live runs since 23 Nov 20:12Z (evm-rpc-spare-list, robinhood-torch with
// the scan list's first two refused or 503) ended every held quote rpc_error "the last scan provider did not answer
// within 4000 ms" at 4013 to 4632 ms, and so did the same quotes from the Mac (24 Nov 12:1xZ) while Pocket answered
// every post in 358 to 1,670 ms: the kit paces Pocket at 2 calls a second (pace.ts), a handed warm scan is about 8 calls,
// and the bound ran from the ask, so the kit's own pace wait counted as the provider's silence: the cut came on a head
// read that waited 3.8 s for its turn, then 178 ms for its answer. As the live check does (a quote with every provider
// answering, then held ones), the two cold taps run as recorded; at the warm tap the first two refuse every post (no
// connection), Pocket answers each LATE_MS after it is sent (inside the bound), and another reader's 3 posts of 2 calls
// wait on Pocket's pace ahead of it (the pace is the device's, every reader's: pace.ts), so its turns come seconds late.
// The warm tap ends ok as recorded, inside the last provider's bound. On main it ends rpc_error "the last scan provider
// did not answer within 4000 ms". (A cold tap is the first's alone: no spare carries Robinhood's 10M blocks.)
const RH = "rpc.mainnet.chain.robinhood.com";
const POCKET_URL = `https://${POCKET}`;
test("L3 the warm tap's first two refuse every post and Pocket's turns come late: it ends ok as recorded, inside the last provider's bound", { timeout: 300_000 }, async () => {
  let pocketPosts = 0;
  const r = await run(
    (q, host) => {
      if (q !== 2) return undefined;
      if (host === POCKET) pocketPosts++;
      return host === RH || host === DAYBREAK ? "refused" : host === POCKET ? "late" : undefined;
    },
    (q) => {
      if (q !== 2) return;
      for (let i = 0; i < 3; i++)
        void Promise.resolve(evmPaceTake(POCKET_URL, [{ method: "eth_getLogs" }, { method: "eth_getBlockByNumber" }])).then((give) => setTimeout(() => give(true), POST_MS));
    },
  );
  console.log(`L3: ${JSON.stringify(r.out)}, Pocket asked ${pocketPosts} posts in the warm tap`);
  assert.equal((F.quotes as Q[])[2]!.phase, "warm");
  assert.ok(pocketPosts > 0, "the warm tap never asked Pocket");
  for (const [k, q] of r.out.entries()) assert.equal(q.outcome.split(" ")[0], String((F.quotes as Q[])[k]!.outcome).split(" ")[0], `quote ${k} ended ${q.outcome}: ${r.why.join(" | ")}`);
  assert.ok(r.out[2]!.ms <= ENDS_WITHIN_MS, `the warm tap took ${r.out[2]!.ms} ms`);
});

// card rh-scan-last-provider-case, the other side: every tap's first two refuse every post and Pocket answers each in
// POST_MS. The cold taps leave the warm one more than Pocket's pace carries (41 getLogs in the replay), so the warm tap
// must stop at the last provider's whole bound (EVM_SCAN_LAST_WHOLE_MS), never grind on to the quote's deadline:
// with each request's bound alone it ended rpc_error at 33.4 s, and stale_quote at 32.8 s with the bound from the post.
test("L4 every tap's first two refuse every post: the warm tap still ends inside the last provider's bound, never stale_quote", { timeout: 300_000 }, async () => {
  const r = await run((_q, host) => (host === RH || host === DAYBREAK ? "refused" : undefined));
  console.log(`L4: ${JSON.stringify(r.out)}`);
  assert.equal((F.quotes as Q[])[2]!.phase, "warm");
  assert.notEqual(r.out[2]!.outcome, "stale_quote", "the warm tap ran out its deadline");
  assert.ok(r.out[2]!.ms <= ENDS_WITHIN_MS, `the warm tap took ${r.out[2]!.ms} ms (${r.out[2]!.outcome})`);
});

// L1 and L2 with the first provider failing the blocks too: since card base-warm-quote-rides-a-stalled-last-scan, a
// request the first passed over unsent (held or paced) is asked of it again once the last fails it, so L1 and L2 end
// inside the bound by that ride, and the last provider's own bounds (its post's EVM_SCAN_LAST_MS and the hand-off's
// stop at its 429) went untested: the nightly sweep on main 465ecc471 (run 45726510072, parts 6 and 7) found mutants
// of all three passing L1 and L2. Here the first answers 503 to every getLogs, so no request comes back to it, and only
// the last provider's bounds end the quote: rpc_error at 4.4 s (L5) and 0.4 to 1.5 s (L6); with the post's bound gone,
// 60.2 s each (L5), and with the stop at the handed 429 gone, 57.4 to 58.5 s (L6).
for (const [name, act] of [
  ["L5 the first and daybreak answer 503 to every getLogs and Pocket, the last, never answers one it is handed", on({ [RH]: "503", [DAYBREAK]: "503", [POCKET]: "hang" })],
  ["L6 the first and daybreak answer 503 to every getLogs and Pocket, the last, answers 429 to every one it is handed", on({ [RH]: "503", [DAYBREAK]: "503", [POCKET]: "429" })],
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
