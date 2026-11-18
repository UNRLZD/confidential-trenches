// node --test scripts/live-checks/robinhood-spread-tapes-fill-inside-45s.test.mjs: the live check's verdict replays
// recorded runs (robinhood-spread-tapes-fill-inside-45s.answers.json):
//   good, good_long: the branch helper at c8b2708fa on the Mac: FOBO (50 trades over 5.5 h) filled 10.4 s after its first
//                 read, AUTONOMO (12.1 h) 18.6 s: PASS;
//   bad_deployed: the deployed helper at bf32abde9, FOBO read alone: still filling 45.2 s after its first read: FAIL;
//   bad_busy_only: the deployed helper, PONS read alone: filled in 4.5 s, its 50 trades over 0.2 h: no spread coin, FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read, spanOf, SPREAD_MS } from "./robinhood-spread-tapes-fill-inside-45s.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "robinhood-spread-tapes-fill-inside-45s.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answers pass: a spread coin read alone on the branch helper fills inside 45 s, its fill time and the hours its trades span printed", () => {
  for (const run of [A.good, A.good_long]) {
    const r = judge(run);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.ok(run.answers[0].span_ms >= SPREAD_MS);
    assert.match(r.lines[1], /^ok {2}trades 0x[0-9a-f]{40}: filled \d+ ms after its first read \(\d+ reads\), 50 trades over \d+\.\d h$/);
    assert.match(r.lines.at(-1), /^ok {2}1 spread coin\(s\) filled inside 45000 ms/);
  }
});

test("the recorded bad answer (the deployed helper before this card) fails: the spread coin still filling past 45 s", () => {
  const r = judge(A.bad_deployed);
  assert.equal(r.ok, false);
  assert.match(bad(r)[0], /still filling 45160 ms after its first read \(20 reads\), past 45000 ms/);
  assert.match(bad(r).at(-1), /0 spread coin\(s\) filled/);
});

test("a run of busy coins alone proves nothing: a tape that fills fast but whose 50 trades span under 2 h is no spread coin, FAIL", () => {
  const r = judge(A.bad_busy_only);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD 0 spread coin(s) filled inside 45000 ms (50 trades over 2 h or more)"]);
  assert.match(r.lines[1], /^ok {2}trades .*: filled 4479 ms .*, 50 trades over 0\.2 h$/);
});

test("planted faults fail: a list not read, a tape 503, a spread coin short of 50 trades, a fill past 45 s", () => {
  const edit = (f) => {
    const run = structuredClone(A.good);
    f(run);
    return judge(run);
  };
  assert.equal(edit((r) => (r.answers = [])).ok, false);
  assert.equal(edit((r) => Object.assign(r.answers[0], { status: 503, shape: null, body: "busy" })).ok, false);
  assert.equal(edit((r) => (r.answers[0].n = 49)).ok, false);
  assert.equal(edit((r) => (r.answers[0].filled.ms = 45_001)).ok, false);
  assert.equal(edit((r) => (r.answers[0].filled.filling = true)).ok, false);
  const listed = structuredClone(A.good);
  delete listed.address;
  listed.lists = { status: 500, ms: 10, tokens: 1 };
  assert.equal(judge(listed).ok, false);
  listed.lists.status = 200;
  assert.equal(judge(listed).ok, true, judge(listed).lines.join("\n"));
});

test("spanOf reads a settled tape's trade count and the ms its trades span; a body with no times gives null", () => {
  assert.deepEqual(spanOf(JSON.stringify({ trades: [{ t_ms: 5_000 }, { t_ms: 1_000 }, { t_ms: 3_000 }] })), { n: 3, span_ms: 4_000 });
  assert.deepEqual(spanOf(JSON.stringify({ trades: [{ t_ms: "x" }] })), { n: 0, span_ms: null });
  assert.deepEqual(spanOf("not json"), { n: 0, span_ms: null });
});

test("read: the lists' tokens read at once, a filling tape read again until it fills, its span taken from the settled answer", async () => {
  const t = "0x" + "ab".repeat(20);
  let n = 0;
  const trades = (filling) => JSON.stringify({ trades: Array.from({ length: 50 }, (_, i) => ({ t_ms: 1_000_000 + i * 600_000 })), ...(filling ? { filling: true } : {}), src: "chain", as_of_ms: 1 });
  const fetchFn = async (url) => {
    if (url.includes("/v1/market/lists")) return new Response(JSON.stringify({ lists: { trending_1h: [{ token: t }] } }), { status: 200 });
    return new Response(trades(n++ === 0), { status: 200 });
  };
  const run = await read("http://h", fetchFn, { sleep: async () => {}, pollMs: 0 });
  assert.equal(run.lists.tokens, 1);
  assert.equal(run.answers[0].filled.filling, false);
  assert.deepEqual([run.answers[0].n, run.answers[0].span_ms], [50, 49 * 600_000]);
  assert.equal(judge(run).ok, true, judge(run).lines.join("\n"));
});
