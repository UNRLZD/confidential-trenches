/// <reference types="node" />
// Card solana-legs-share-wait: a build the helper answers 429 (past the device's share) or 503 (the vendor's total or
// reset) with a Retry-After is waited out and asked again inside the trade's bound, never a cap step; a wait that
// would end past the bound is refused; after a wait, a search with no step yet asks the cap another leg already found.
// The builds are one recorded build (test/fixtures/solana-builds.json `good`); the clock is a fake one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SolanaBuildError, fetchSolanaJupiterBuild, fetchSolanaJupiterBuildThatFits, type SolanaBuildRequest } from "../src/trade/solana/build.ts";

const G = JSON.parse(readFileSync(new URL("./fixtures/solana-builds.json", import.meta.url), "utf8")).good as { mint: string; wallet: string; shapes: { body: string }[] };
const ORIGIN = "https://api.confidential.unrealized.trade";
const R: SolanaBuildRequest = { side: "buy", wallet: G.wallet, token: G.mint, amount: 10_000_000n, slippageBps: 1000 };
const capOf = (url: string) => Number(new URL(url).searchParams.get("maxAccounts"));
const BUILT = () => new Response(G.shapes[0]!.body, { status: 200 });
const ROOM = (status: 429 | 503, s: string | null) => new Response(JSON.stringify({ error: { code: status === 429 ? "rate_limited" : "upstream" } }), { status, headers: s === null ? {} : { "retry-after": s } });

/** Answers in turn from `seq`; records each cap asked. A fake clock the waits move. */
function world(seq: (() => Response)[]) {
  const asked: number[] = [];
  let t = 0;
  const fetch = async (url: string) => { asked.push(capOf(url)); return (seq.shift() ?? BUILT)(); };
  return { asked, fetch, clock: () => t, sleep: async (ms: number) => void (t += ms), waits: [] as number[] };
}

test("429 with Retry-After 3: waited 3 s on the clock, asked again at the same cap, one step", async () => {
  const w = world([() => ROOM(429, "3")]);
  const got = await fetchSolanaJupiterBuildThatFits(ORIGIN, R, () => "ok", { fetch: w.fetch, wait: { until: 60_000, clock: w.clock, sleep: w.sleep, onWait: (ms) => w.waits.push(ms) } });
  assert.deepEqual(w.asked, [40, 40]);
  assert.equal(w.clock(), 3_000);
  assert.deepEqual(w.waits, [3_000]);
  assert.deepEqual(got.steps, [{ maxAccounts: 40, outcome: "fits" }]);
  assert.deepEqual(got.calls.map((c) => c.status), [429, 200]);
});

test("503 with Retry-After (the vendor's total or reset) is waited the same; a floor rebuild at its cap waits too", async () => {
  const w = world([() => ROOM(503, "2"), () => ROOM(503, "5")]);
  const got = await fetchSolanaJupiterBuildThatFits(ORIGIN, R, () => "ok", { fetch: w.fetch, wait: { until: 60_000, clock: w.clock, sleep: w.sleep } });
  assert.equal(got.maxAccounts, 40);
  assert.equal(w.clock(), 7_000);
  const r = world([() => ROOM(429, "4")]);
  const again = await fetchSolanaJupiterBuild(ORIGIN, R, { fetch: r.fetch, maxAccounts: 48, wait: { until: 60_000, clock: r.clock, sleep: r.sleep } });
  assert.deepEqual([r.asked, again.maxAccounts, r.clock()], [[48, 48], 48, 4_000]);
});

test("a wait that would end past the trade's bound is refused, upstream, and nothing more is asked", async () => {
  const w = world([() => ROOM(429, "3"), () => ROOM(429, "40")]);
  await assert.rejects(
    fetchSolanaJupiterBuildThatFits(ORIGIN, R, () => "ok", { fetch: w.fetch, wait: { until: 30_000, clock: w.clock, sleep: w.sleep } }),
    (e: unknown) => e instanceof SolanaBuildError && e.code === "upstream" && e.message === "upstream: HTTP 429: no room by the trade's bound (Retry-After 40 s)",
  );
  assert.deepEqual(w.asked, [40, 40]);
  assert.equal(w.clock(), 3_000);
});

test("after a wait, a search with no step yet asks the cap another leg found; a later step's wait keeps its own cap", async () => {
  const w = world([() => ROOM(429, "1")]);
  const got = await fetchSolanaJupiterBuildThatFits(ORIGIN, R, () => "ok", { fetch: w.fetch, wait: { until: 60_000, clock: w.clock, sleep: w.sleep, knownCap: () => 48 } });
  assert.deepEqual(w.asked, [40, 48]);
  assert.deepEqual(got.steps, [{ maxAccounts: 48, outcome: "fits" }]);
  const n = world([() => new Response('{"error":"No routes found"}', { status: 400 }), () => ROOM(429, "1")]);
  const on = await fetchSolanaJupiterBuildThatFits(ORIGIN, R, () => "ok", { fetch: n.fetch, wait: { until: 60_000, clock: n.clock, sleep: n.sleep, knownCap: () => 60 } });
  assert.deepEqual(n.asked, [40, 48, 48]);
  assert.deepEqual(on.steps, [{ maxAccounts: 40, outcome: "no_route" }, { maxAccounts: 48, outcome: "fits" }]);
});

test("with no wait, or a 429/503 with no Retry-After or one past a minute, the answer is upstream at once, as before", async () => {
  for (const [opts, seq] of [
    [{}, [() => ROOM(429, "3")]],
    [{ wait: { until: 60_000 } }, [() => ROOM(503, null)]],
    [{ wait: { until: 600_000 } }, [() => ROOM(429, "3600")]],
    [{ wait: { until: 600_000 } }, [() => ROOM(429, "1.5")]],
  ] as const) {
    const w = world([...seq]);
    await assert.rejects(fetchSolanaJupiterBuildThatFits(ORIGIN, R, () => "ok", { fetch: w.fetch, ...opts }), (e: unknown) => e instanceof SolanaBuildError && e.code === "upstream" && /^upstream: HTTP (429|503)/.test(e.message));
    assert.deepEqual(w.asked, [40]);
  }
});
