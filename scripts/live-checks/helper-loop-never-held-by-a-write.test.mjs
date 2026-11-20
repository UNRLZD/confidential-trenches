// node --test scripts/live-checks/helper-loop-never-held-by-a-write.test.mjs: the live check's verdict replays recorded
// runs (helper-loop-never-held-by-a-write.answers.json):
//   good: the deployed helper (f5639e5bb, release 208) read from the Mac by helper-loop-never-held-by-a-write.mjs --record,
//         20 Nov 00:55-00:56Z, no live run beside it: 30 of 30 probes 200, the slowest 1249 ms over a fastest of 522 ms: PASS;
//   bad:  a copy of the helper at e35007152 (before this card) on mainnet's public providers, read by the same --record
//         while deploy/burst.mjs opened 300 pages over 48 cold coins straight at it (the Mac, 20 Nov 01:0xZ; the copy's
//         log: "event loop held up to 1462 ms this minute"): two probes shed, each a bare 503 Retry-After 2, and one held
//         1094 ms: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { causeOf, GAP_MS, judge, PATH, PROBES, read, SLOW_MS } from "./helper-loop-never-held-by-a-write.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-loop-never-held-by-a-write.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const ok200 = (i, ms = 40) => ({ at: i * GAP_MS, status: 200, ms, retryAfter: null, timing: null });
const run = (f = () => {}) => {
  const probes = Array.from({ length: PROBES }, (_, i) => ok200(i));
  f(probes);
  return { base: "https://helper.invalid", probes };
};

test("the recorded good answer passes: every probe 200, none held past a second", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer (a copy before this card under a burst) fails: shed probes, bare, and one held past a second", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => l === "BAD 2 probes answered 503 with no cause in Server-Timing (a bare 503)"), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /by more than 1000 ms: 1 /.test(l)), r.lines.join("\n"));
});

test("planted: a shed probe, a bare 503, a probe held past SLOW_MS, an unanswered probe and a short run each fail, named", () => {
  assert.equal(judge(run()).ok, true);
  let r = judge(run((p) => Object.assign(p[3], { status: 503, retryAfter: "2", timing: 'loop;desc="past capacity"' })));
  assert.ok(bad(r).some((l) => l === "BAD 1 probes shed: the helper's loop held past a second at this load"), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /not: \+6\.0 s 503 Retry-After 2 \(loop\)/.test(l)), r.lines.join("\n"));
  assert.ok(!bad(r).some((l) => /bare/.test(l)), "the shed names its cause");
  r = judge(run((p) => Object.assign(p[4], { status: 503, retryAfter: "2", timing: null })));
  assert.ok(bad(r).some((l) => l === "BAD 1 probes answered 503 with no cause in Server-Timing (a bare 503)"), r.lines.join("\n"));
  r = judge(run((p) => Object.assign(p[5], { ms: 40 + SLOW_MS + 1 })));
  assert.ok(bad(r).some((l) => /by more than 1000 ms: 1 \(\+10\.0 s 1041 ms\)/.test(l)), r.lines.join("\n"));
  assert.equal(judge(run((p) => Object.assign(p[5], { ms: 40 + SLOW_MS }))).ok, true, "at SLOW_MS over the fastest it passes");
  r = judge(run((p) => Object.assign(p[6], { status: null, error: "TimeoutError", ms: 10_000 })));
  assert.ok(bad(r).some((l) => /not: \+12\.0 s TimeoutError/.test(l)), r.lines.join("\n"));
  r = judge(run((p) => p.splice(10)));
  assert.ok(bad(r).some((l) => /^BAD 10 probes/.test(l)), r.lines.join("\n"));
});

test("causeOf: the metric names of a 503's Server-Timing, total aside; none is bare", () => {
  assert.equal(causeOf('loop;desc="past capacity"'), "loop");
  assert.equal(causeOf('search-room;desc="x", total;dur=3'), "search-room");
  assert.equal(causeOf("total;dur=3"), null);
  assert.equal(causeOf(null), null);
});

test("read() probes the Solana lists PROBES times, GAP_MS apart, with the page's Origin, and keeps no body", async () => {
  let t = 0;
  const asked = [];
  const fetchFn = async (url, init) => {
    asked.push([url, init.headers.origin, t]);
    t += 30;
    return new Response(JSON.stringify({ lists: { trending: [{ token: "x" }] } }), { status: 200, headers: { "server-timing": "total;dur=1" } });
  };
  const r = await read("https://helper.invalid/", fetchFn, () => t, async (ms) => void (t += ms), 4);
  assert.deepEqual(asked.map((a) => a[0]), Array(4).fill(`https://helper.invalid${PATH}`));
  assert.ok(asked.every((a) => a[1] === "https://ct-app.unrealized.trade"));
  assert.deepEqual(asked.map((a) => a[2]), [0, GAP_MS, 2 * GAP_MS, 3 * GAP_MS]);
  assert.deepEqual(r.probes[0], { at: 0, status: 200, ms: 30, retryAfter: null, timing: "total;dur=1" });
  assert.ok(!JSON.stringify(r).includes("trending"), "no body kept");
});
