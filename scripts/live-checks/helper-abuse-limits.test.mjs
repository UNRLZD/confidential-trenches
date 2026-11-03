// node --test scripts/live-checks/helper-abuse-limits.test.mjs: the live check replays recorded answers
// (helper-abuse-limits.answers.json). good: the card's helper run locally: PASS. bad_pre_card: the helper at be4b353 run
// the same way, whose pool 429 wait a browser cannot read and whose health route is never limited: FAIL. Each other bad
// answer plants one fault in one burst of the good one (pool: no Retry-After, upstream text in the body, no 429 in 61,
// still 429 after the wait, a 503 in the burst; api: no 429 in 241, the wait not exposed, a 503, the burst missing): FAIL.
// The good answer with its pool wait set to RETRY_AFTER_MAX_S (75, the longest true wait): PASS; to 76, 0 or 1000: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RETRY_AFTER_MAX_S } from "../../apps/helper/src/limits/limits.ts";
import { API_BATCH, API_BURST_MAX, BURST_MAX, HEALTH, judge, POOL_BATCH, PROBE, read } from "./helper-abuse-limits.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-abuse-limits.answers.json"), "utf8"));

// a fetch that answers each burst with its recorded statuses (the 429 with its recorded answer) and the read after the
// wait with the recorded `after`; a sleep that only records the wait asked
function replay(a) {
  const n = { [PROBE]: 0, [HEALTH]: 0 };
  const waits = [];
  const fetchFn = async (url, init) => {
    const at = new URL(url).pathname + new URL(url).search;
    const b = at === PROBE ? a.pool : at === HEALTH ? a.api : assert.fail(`unexpected ${at}`);
    assert.equal(init.headers.origin, "https://confidential.unrealized.trade");
    const i = n[at]++;
    if (i < b.statuses.length) {
      const s = b.statuses[i];
      if (s === 429) return new Response(b.throttle.body, { status: 429, headers: b.throttle.headers });
      return new Response(at === PROBE ? '{"error":{"code":"not_found"}}' : "{}", { status: s, headers: { "content-type": "application/json" } });
    }
    assert.ok(b.after, "no read after a burst unless the check waited");
    return new Response(b.after.body, { status: b.after.status, headers: b.after.headers });
  };
  return { fetchFn, sleep: async (ms) => void waits.push(ms), waits };
}

test("recorded good answer (the card's helper): PASS on both bursts, and the check waits each Retry-After it was told", async () => {
  const r = replay(A.good);
  const got = await read("https://api.confidential.unrealized.trade", r.fetchFn, r.sleep);
  const v = judge(got);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(r.waits, [A.good.pool, A.good.api].map((b) => Number(b.throttle.headers["retry-after"]) * 1000 + 250));
  assert.equal(got.api.statuses.length, 121, "the health route's 121st request meets the 429");
  assert.ok(v.lines.some((l) => l.startsWith("ok  api: ")) && v.lines.some((l) => l.startsWith("ok  pool: ")));
  assert.ok(v.lines.some((l) => l.startsWith("note second client")));
});

for (const name of ["bad_pre_card", "bad_no_expose", "bad_no_retry_after", "bad_upstream_text", "bad_never_429", "bad_still_throttled", "bad_503", "bad_api_never_429", "bad_api_no_expose", "bad_api_503"]) {
  test(`recorded ${name}: FAIL`, async () => {
    const r = replay(A[name]);
    const v = judge(await read("https://api.confidential.unrealized.trade", r.fetchFn, r.sleep));
    assert.equal(v.ok, false, v.lines.join("\n"));
  });
}

test("recorded bad_api_missing (no health burst read): FAIL", () => {
  const v = judge(A.bad_api_missing);
  assert.equal(v.ok, false);
  assert.ok(v.lines.includes("BAD api: not read"));
});

test("each burst stops at its most with no 429", async () => {
  const r = replay(A.bad_never_429);
  const got = await read("https://api.confidential.unrealized.trade", r.fetchFn, r.sleep);
  assert.equal(got.pool.statuses.length, BURST_MAX);
  assert.equal(got.pool.after, null);
  const q = replay(A.bad_api_never_429);
  const api = (await read("https://api.confidential.unrealized.trade", q.fetchFn, q.sleep)).api;
  assert.equal(api.statuses.length, API_BURST_MAX);
  assert.equal(api.after, null);
});

// A helper as the card built it, on a clock: each client's sliding 10 s window (30 on the pool route, 120 on the rest),
// a 429 naming the wait to the window's oldest request leaving it, with CORS. Every request arrives at the clock and
// moves it a round trip on when answered; requests in flight together arrive together; the check's sleep moves it too.
function slowHelper(rttMs) {
  let t = 0;
  const seen = { [PROBE]: [], [HEALTH]: [] };
  const cap = { [PROBE]: 30, [HEALTH]: 120 };
  const fetchFn = async (url) => {
    const at = new URL(url).pathname + new URL(url).search;
    const arrived = t;
    const w = seen[at];
    while (w.length > 0 && arrived - w[0] >= 10_000) w.shift();
    let r;
    if (w.length >= cap[at]) {
      const wait = Math.max(1, Math.ceil((w[0] + 10_000 - arrived) / 1000));
      r = new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: { "retry-after": String(wait), "access-control-allow-origin": "https://confidential.unrealized.trade", "access-control-expose-headers": "X-Helper-Commit, X-Helper-Source, X-Fetched-At, Retry-After", vary: "Origin", "content-type": "application/json" } });
    } else {
      w.push(arrived);
      r = new Response(at === PROBE ? '{"error":{"code":"not_found"}}' : "{}", { status: at === PROBE ? 404 : 200, headers: { "content-type": "application/json" } });
    }
    await new Promise((ok) => setImmediate(ok));
    t = Math.max(t, arrived + rttMs);
    return r;
  };
  return { fetchFn, sleep: async (ms) => void (t += ms) };
}

test("a helper 250 ms and 1 s a round trip away: each burst still meets its 429 in its first batch, and the contract holds (one request at a time at 250 ms never meets the api's 120 in a window)", async () => {
  for (const rtt of [250, 1_000]) {
    const h = slowHelper(rtt);
    const got = await read("https://api.confidential.unrealized.trade", h.fetchFn, h.sleep);
    const v = judge(got);
    assert.equal(v.ok, true, `${rtt} ms:\n${v.lines.join("\n")}`);
    assert.deepEqual([got.pool.statuses.length, got.api.statuses.length], [POOL_BATCH, API_BATCH], `${rtt} ms: one batch each`);
    assert.deepEqual([got.pool.statuses.filter((s) => s === 429).length, got.api.statuses.filter((s) => s === 429).length], [1, 1]);
  }
});

test("recorded good_deployed (the deployed helper at 3bf53c0, about 250 ms a round trip from the Mac, read with parallel batches): PASS", async () => {
  const r = replay(A.good_deployed);
  const v = judge(await read("https://api.confidential.unrealized.trade", r.fetchFn, r.sleep));
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("the Retry-After range: 1 to RETRY_AFTER_MAX_S (75, GeckoTerminal's window, the longest true wait) passes; 76, 0 and 1000 fail", () => {
  const line = (wait) => {
    const a = structuredClone(A.good);
    a.pool.throttle.headers["retry-after"] = wait;
    return judge(a).lines.find((l) => l.includes("pool: Retry-After") || l.includes(`Retry-After "${wait}"`) || l.includes(`Retry-After ${wait}`));
  };
  assert.equal(RETRY_AFTER_MAX_S, 75);
  for (const w of ["1", "60", "75"]) assert.ok(line(w)?.startsWith("ok "), `${w}: ${line(w)}`);
  for (const w of ["76", "0", "1000"]) assert.ok(line(w)?.startsWith("BAD"), `${w}: ${line(w)}`);
});
