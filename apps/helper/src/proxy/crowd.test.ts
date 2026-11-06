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

// card helper-page-jup-429: Jupiter Free counts 10 sends in any 10 s (proxy.ts PACED), and a device past its share
// leaves a share of them to the other devices (fold 4), so its second trade inside the same 10 s waits for the window:
// a 503 naming the seconds, nothing sent, then served (the kit waits a Retry-After out)
test("card helper-crowd-429: one device's 8 builds inside 10 s (two trades back to back): its share and one more at once, the rest served once the window has room, never a 429", async () => {
  const j = jupiterFree();
  const p = createProxy(ENV, { fetch: j.fetch as never, now: j.clock.now, sleep: j.clock.sleep });
  const answers = [];
  for (let i = 0; i < 8; i++) {
    let a = await p.handle("jupiter", BUILD, `n=${i}`, "", "198.51.100.7");
    if (a.status === 503) {
      assert.ok(Number(a.headers["Retry-After"]) >= 1 && /cause;desc="budget"/.test(String(a.timing)), `${a.why} ${a.timing}`);
      j.clock.add(Number(a.headers["Retry-After"]) * 1000);
      a = await p.handle("jupiter", BUILD, `n=${i}`, "", "198.51.100.7");
    }
    answers.push(a);
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

test("card helper-crowd-429: two devices contending for Jupiter's callers' part: the minute's cap is never passed, the heavy one keeps a share a minute and is lent only above what the others keep, and the other is never starved of its share", async () => {
  const j = jupiterFree();
  // a refused build's queue wait passes no time here, so the three minutes are the clock's own
  const p = createProxy(ENV, { fetch: j.fetch as never, now: j.clock.now, sleep: async () => {} });
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
  console.log(`  [contention] heavy ${heavy} builds in three minutes, light ${light}, peak ${j.stats().peak}`);
  // fold 4: the heavy device keeps one share a minute on the total alone and is lent above LEND_NEW_SHARES shares and
  // one for the light device (16 of the callers' 26); at fold 2 this read 39 only because each refused build's queue
  // wait moved the fake clock 3 s, so its "three minutes" ran far longer
  assert.ok(heavy >= 3 * 4, `the heavy device keeps a share a minute: ${heavy} builds in three minutes`);
});

test("card helper-crowd-429 fold 3: two heavy devices drawing Jupiter as fast as they are served for two minutes never make a third or a fourth device wait or 429 for a trade inside its own share", async () => {
  const j = jupiterFree();
  // a refused build's queue wait passes no time here (each poll counted), so the schedule below is the clock's own:
  // with the fake clock's sleep, every refused heavy build moved the clock 3 s and spread two minutes over half an hour
  let polls = 0;
  const p = createProxy(ENV, { fetch: j.fetch as never, now: j.clock.now, sleep: async () => void polls++ });
  const refused: string[] = [];
  let heavy = 0;
  // the third device trades (4 builds, 200 ms apart) every minute from 20 s, the fourth every minute from 35 s: each
  // trade inside its 10 s share, while the two heavy ones ask a build every 200 ms each
  const trades: [string, number][] = [["198.51.100.3", 20_000], ["198.51.100.4", 35_000]];
  for (let ms = 0; ms < 120_000; ms += 200) {
    for (const ip of ["198.51.100.1", "198.51.100.2"]) if ((await p.handle("jupiter", BUILD, `h=${ip}-${ms}`, "", ip)).status === 200) heavy++;
    for (const [ip, from] of trades) {
      if (ms < from || (ms - from) % 60_000 >= 4 * 200) continue;
      const p0 = polls;
      const a = await p.handle("jupiter", BUILD, `l=${ip}-${ms}`, "", ip);
      // card helper-page-jup-429: a build beside a heavy device's goes at once in the window (proxy.ts PACED), at most one
      // sleep here (the still clock); any wait past it is the budget's queue
      if (a.status !== 200 || polls - p0 > 1) refused.push(`${ip} at ${ms} ms: ${a.status} ${a.why ?? ""} after ${polls - p0} queue polls`);
    }
    j.clock.add(200);
  }
  assert.deepEqual(refused, [], "every build of the third and fourth device served on its turn, never queued for the budget");
  assert.equal(j.stats().throttled, 0, "Jupiter never throttled");
  assert.ok(j.stats().peak <= 60, `peak ${j.stats().peak} in a sliding minute`);
  assert.ok(heavy > 0, `the heavy devices still lent what is left: ${heavy}`);
});

test("card helper-crowd-429 fold 4: one heavy device drawing Jupiter as fast as it is served for two minutes, beside a device trading inside its share, never makes a third, fourth or fifth first-time device wait or 429", async () => {
  const j = jupiterFree();
  // a refused build's queue wait passes no time here (each poll counted), so the schedule below is the clock's own:
  // with the fake clock's sleep, every refused heavy build moved the clock 3 s and spread two minutes over half an hour
  let polls = 0;
  const p = createProxy(ENV, { fetch: j.fetch as never, now: j.clock.now, sleep: async () => void polls++ });
  const refused: string[] = [];
  let heavy = 0;
  // the normal device trades (4 builds, 200 ms apart) every 30 s from 5 s; three first-time devices trade once each,
  // at 20 s, 70 s and 100 s, while the heavy one asks a build every 200 ms from the start
  const trades: [string, number, number][] = [["198.51.100.2", 5_000, 30_000], ["198.51.100.3", 20_000, Infinity], ["198.51.100.4", 70_000, Infinity], ["198.51.100.5", 100_000, Infinity]];
  for (let ms = 0; ms < 120_000; ms += 200) {
    if ((await p.handle("jupiter", BUILD, `h=${ms}`, "", "198.51.100.1")).status === 200) heavy++;
    for (const [ip, from, every] of trades) {
      if (ms < from || (ms - from) % every >= 4 * 200 || (every === Infinity && ms - from >= 4 * 200)) continue;
      const p0 = polls;
      const a = await p.handle("jupiter", BUILD, `l=${ip}-${ms}`, "", ip);
      // card helper-page-jup-429: a build beside a heavy device's goes at once in the window (proxy.ts PACED), at most one
      // sleep here (the still clock); any wait past it is the budget's queue
      if (a.status !== 200 || polls - p0 > 1) refused.push(`${ip} at ${ms} ms: ${a.status} ${a.why ?? ""} after ${polls - p0} queue polls`);
    }
    j.clock.add(200);
  }
  assert.deepEqual(refused, [], "every build of the normal and the first-time devices served on its turn, never queued for the budget");
  assert.equal(j.stats().throttled, 0, "Jupiter never throttled");
  assert.ok(j.stats().peak <= 60, `peak ${j.stats().peak} in a sliding minute`);
  assert.ok(heavy > 0, `the heavy device still lent what is left: ${heavy}`);
});
