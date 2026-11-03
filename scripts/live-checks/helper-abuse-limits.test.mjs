// node --test scripts/live-checks/helper-abuse-limits.test.mjs: the live check replays recorded answers
// (helper-abuse-limits.answers.json). good: the card's helper run locally: PASS. bad_pre_card: the helper at be4b353 run
// the same way, whose pool 429 wait a browser cannot read and whose health route is never limited: FAIL. Each other bad
// answer plants one fault in one burst of the good one (pool: no Retry-After, upstream text in the body, no 429 in 61,
// still 429 after the wait, a 503 in the burst; api: no 429 in 241, the wait not exposed, a 503, the burst missing): FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { API_BURST_MAX, BURST_MAX, HEALTH, judge, PROBE, read } from "./helper-abuse-limits.mjs";

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
