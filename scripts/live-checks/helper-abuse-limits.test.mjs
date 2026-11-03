// node --test scripts/live-checks/helper-abuse-limits.test.mjs: the live check replays recorded answers
// (helper-abuse-limits.answers.json). good: the card's helper run locally: PASS. bad_no_expose: the helper at be4b353
// run the same way, whose 429 wait a browser cannot read: FAIL. Each other bad answer plants one fault in the good
// one (no Retry-After, upstream text in the body, no 429 in 61, still 429 after the wait, a 503 in the burst): FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BURST_MAX, judge, PROBE, read } from "./helper-abuse-limits.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-abuse-limits.answers.json"), "utf8"));

// a fetch that answers the burst with the recorded statuses (the 429 with its recorded answer) and the read after the
// wait with the recorded `after`; a sleep that only records the wait asked
function replay(a) {
  let n = 0;
  const waits = [];
  const fetchFn = async (url, init) => {
    assert.equal(new URL(url).pathname + new URL(url).search, PROBE);
    assert.equal(init.headers.origin, "https://confidential.unrealized.trade");
    const i = n++;
    if (i < a.statuses.length) {
      const s = a.statuses[i];
      if (s === 429) return new Response(a.throttle.body, { status: 429, headers: a.throttle.headers });
      return new Response('{"error":{"code":"not_found"}}', { status: s, headers: { "content-type": "application/json" } });
    }
    assert.ok(a.after, "no read after the burst unless the check waited");
    return new Response(a.after.body, { status: a.after.status, headers: a.after.headers });
  };
  return { fetchFn, sleep: async (ms) => void waits.push(ms), waits };
}

test("recorded good answer (the card's helper): PASS, and the check waits the Retry-After it was told", async () => {
  const r = replay(A.good);
  const got = await read("https://api.confidential.unrealized.trade", r.fetchFn, r.sleep);
  const v = judge(got);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(r.waits, [Number(A.good.throttle.headers["retry-after"]) * 1000 + 250]);
  assert.ok(v.lines.some((l) => l.startsWith("note second client")));
});

for (const name of ["bad_no_expose", "bad_no_retry_after", "bad_upstream_text", "bad_never_429", "bad_still_throttled", "bad_503"]) {
  test(`recorded ${name}: FAIL`, async () => {
    const r = replay(A[name]);
    const v = judge(await read("https://api.confidential.unrealized.trade", r.fetchFn, r.sleep));
    assert.equal(v.ok, false, v.lines.join("\n"));
  });
}

test("the burst stops at BURST_MAX with no 429", async () => {
  const r = replay(A.bad_never_429);
  const got = await read("https://api.confidential.unrealized.trade", r.fetchFn, r.sleep);
  assert.equal(got.statuses.length, BURST_MAX);
  assert.equal(got.after, null);
});
