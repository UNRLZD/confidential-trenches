// node --test apps/helper/src/proxy/crowd.test.ts (card helper-crowd-429): Jupiter's per-client share is
// work-conserving. Helper live run 41914478396 on 262e2e0, the helper's own log:
//   21:16:52.208Z refused /v1/proxy jupiter share 1 in 10 s
// solana-jupiter-build's fifth Jupiter call from one runner inside one 10 s window (share 4), with Jupiter's budget idle.
// The total stays Jupiter Free's 60 a sliding minute, the helper's own 34 reserved (owner-decisions.md:363, "Stay on
// Free"); only who may draw it while it is idle changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProxy } from "./proxy.ts";

const ENV = {
  JUPITER_API_KEY: "fake-jupiter-key-" + "j".repeat(16),
  RELAY_API_KEY: "fake-relay-key-" + "r".repeat(16),
  LIFI_API_KEY: "fake-lifi-key-" + "l".repeat(16),
  ONECLICK_JWT: "fake.oneclick.jwt-" + "o".repeat(16),
};
const BUILD = "/swap/v2/build";

/** Jupiter Free in memory: 60 calls a sliding minute, a 429 past it; the clock advances with every call and sleep. */
function jupiterFree() {
  let t = 1_800_000_000_000;
  const calls: number[] = [];
  let throttled = 0;
  let peak = 0;
  const fetch = async () => {
    while (calls.length > 0 && t - calls[0]! >= 60_000) calls.shift();
    if (calls.length >= 60) return (throttled++, new Response("{}", { status: 429, headers: { "retry-after": "60" } }));
    calls.push(t);
    peak = Math.max(peak, calls.length);
    return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms), add: (ms: number) => void (t += ms) };
  return { fetch, clock, stats: () => ({ throttled, peak }) };
}

test("card helper-crowd-429: one device's 8 builds inside 10 s (two trades back to back) are all served while Jupiter's budget sits idle", async () => {
  const j = jupiterFree();
  const p = createProxy(ENV, { fetch: j.fetch as never, now: j.clock.now, sleep: j.clock.sleep });
  const answers = [];
  for (let i = 0; i < 8; i++) {
    answers.push(await p.handle("jupiter", BUILD, `n=${i}`, "", "198.51.100.7"));
    j.clock.add(1_100); // one build a second, as solana-jupiter-build and a device's retries go
  }
  assert.deepEqual(answers.map((a) => a.status), Array(8).fill(200), answers.map((a) => `${a.status} ${a.why ?? ""}`).join(", "));
  assert.equal(j.stats().throttled, 0);
});

test("card helper-crowd-429: solana-jupiter-build's own calls from one runner (a list read and four builds inside 10 s) get no 429", async () => {
  const j = jupiterFree();
  const p = createProxy(ENV, { fetch: j.fetch as never, now: j.clock.now, sleep: j.clock.sleep });
  const list = await p.handle("jupiter", "/tokens/v2/toptrending/1h", "limit=50", "", "203.0.113.9");
  const builds = [];
  for (let i = 0; i < 4; i++) j.clock.add(1_100), builds.push(await p.handle("jupiter", BUILD, `n=${i}`, "", "203.0.113.9"));
  assert.deepEqual([list.status, ...builds.map((a) => a.status)], [200, 200, 200, 200, 200], builds.map((a) => `${a.status} ${a.why ?? ""}`).join(", "));
});

test("card helper-crowd-429: two devices contending for Jupiter's callers' part: the minute's cap is never passed, the heavy one is lent only while half stays free, and the other is never starved of its share", async () => {
  const j = jupiterFree();
  const p = createProxy(ENV, { fetch: j.fetch as never, now: j.clock.now, sleep: j.clock.sleep });
  let heavy = 0;
  let light = 0;
  const lightRefused: string[] = [];
  // three minutes: the heavy device asks a build every 200 ms, the light one a trade's 4 builds every 30 s
  for (let ms = 0; ms < 180_000; ms += 200) {
    if ((await p.handle("jupiter", BUILD, `h=${ms}`, "", "198.51.100.1")).status === 200) heavy++;
    if (ms % 30_000 < 4 * 200) {
      const a = await p.handle("jupiter", BUILD, `l=${ms}`, "", "198.51.100.2");
      if (a.status === 200) light++;
      else lightRefused.push(`${ms}: ${a.status} ${a.why ?? ""}`);
    }
    j.clock.add(200);
  }
  assert.equal(j.stats().throttled, 0, "Jupiter never throttled");
  assert.ok(j.stats().peak <= 60, `peak ${j.stats().peak} in a sliding minute`);
  assert.deepEqual(lightRefused, [], "the light device's every build served");
  assert.ok(heavy >= 3 * 13, `the heavy device lent past its share: ${heavy} builds in three minutes`);
});
