// node --test scripts/live-checks/robinhood-spread-tapes-fill-inside-45s.test.mjs: the live check's verdict replays
// recorded runs (robinhood-spread-tapes-fill-inside-45s.answers.json):
//   good, good_long: the branch helper (card robinhood-spread-tapes-fill-inside-45s, the idle book rests) on the Mac,
//                 FOBO and AUTONOMO each read alone, filled, then read again 75 s on: whole at once, its newest held: PASS;
//   bad_listed_deployed: the deployed helper (main before the rest), the 12 listed coins at once: 10 still filling past
//                 45 s, and of the 2 that settled, 0x18e67423 (whole in 512 ms) read again 75 s on answered filling, read
//                 from nothing (filled 44.4 s on): FAIL;
//   bad_no_reopen: the first slice's good run (c8b2708fa), with no read past IDLE_MS: no reopen proven, FAIL;
//   bad_deployed: the deployed helper at bf32abde9, FOBO read alone: still filling 45.2 s after its first read: FAIL;
//   bad_busy_only: the deployed helper, PONS read alone: filled in 4.5 s, its 50 trades over 0.2 h: no spread coin, FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read, REOPEN_AFTER_MS, spanOf, SPREAD_MS } from "./robinhood-spread-tapes-fill-inside-45s.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "robinhood-spread-tapes-fill-inside-45s.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answers pass: a spread coin read alone on the branch helper fills inside 45 s, and read again past IDLE_MS answers its whole list at once with its newest trade held", () => {
  for (const run of [A.good, A.good_long]) {
    const r = judge(run);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.ok(run.answers[0].span_ms >= SPREAD_MS);
    assert.match(r.lines[1], /^ok {2}trades 0x[0-9a-f]{40}: filled \d+ ms after its first read \(\d+ reads\), 50 trades over \d+\.\d h$/);
    assert.match(r.lines[2], /^ok {2}1 spread coin\(s\) filled inside 45000 ms/);
    assert.match(r.lines[3], /^ok {2}1 tape\(s\) read again 75000 ms on, of 1 settled$/);
    assert.match(r.lines.at(-1), /^ok {2}reopen 0x[0-9a-f]{40}: answered whole at once in \d+ ms, 50 trades, its newest of before held$/);
  }
});

test("the recorded bad answers of the reopen fail: the deployed helper read a settled coin again from nothing (its first answer filling), and a run with no read past IDLE_MS proves no reopen", () => {
  const listed = judge(A.bad_listed_deployed);
  assert.equal(listed.ok, false);
  assert.deepEqual(bad(listed).filter((l) => l.startsWith("BAD reopen")), ["BAD reopen 0x18e674231a58c239dc7daedcffe15ec3a24cff5c: answered filling in 774 ms, read again from nothing (filled 44415 ms after its first read (20 reads)), 50 trades, its newest of before held"]);
  assert.ok(listed.lines.includes("ok  reopen 0x39dbed3a2bd333467115de45665cc57f813c4571: answered whole at once in 782 ms, 50 trades, its newest of before held"), "a busy coin's cold read fills at once even on main: the spread one tells");
  const none = judge(A.bad_no_reopen);
  assert.equal(none.ok, false);
  assert.deepEqual(bad(none), ["BAD no reopen read past 75000 ms"]);
});

test("the recorded bad answer (the deployed helper before this card) fails: the spread coin still filling past 45 s", () => {
  const r = judge(A.bad_deployed);
  assert.equal(r.ok, false);
  assert.match(bad(r)[0], /still filling 45160 ms after its first read \(20 reads\), past 45000 ms/);
  assert.ok(bad(r).some((l) => /0 spread coin\(s\) filled/.test(l)));
});

test("a run of busy coins alone proves nothing: a tape that fills fast but whose 50 trades span under 2 h is no spread coin, FAIL", () => {
  const r = judge(A.bad_busy_only);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD 0 spread coin(s) filled inside 45000 ms (50 trades over 2 h or more)", "BAD no reopen read past 75000 ms"]);
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
  // the reopen: answered filling, its newest not held, a 503, none read, read too soon
  assert.equal(edit((r) => Object.assign(r.reopen[0], { filling: true, filled: { status: 200, filling: false, shape: "tape", ms: 3_000, reads: 2 } })).ok, false);
  assert.equal(edit((r) => (r.reopen[0].kept = false)).ok, false);
  assert.equal(edit((r) => Object.assign(r.reopen[0], { status: 503, shape: null, body: "busy" })).ok, false);
  assert.equal(edit((r) => (r.reopen = [])).ok, false);
  assert.equal(edit((r) => (r.reopen_after_ms = 30_000)).ok, false);
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

test("read: the lists' tokens read at once, a filling tape read again until it fills, its span taken from the settled answer; REOPEN_AFTER_MS on, each settled tape read again, its newest trade of before looked for and never recorded", async () => {
  const t = "0x" + "ab".repeat(20);
  let n = 0;
  const slept = [];
  const tx = (i) => `0x${i.toString(16).padStart(64, "0")}`;
  // the first answer filling, then settled; the reopen's answer a trade newer on top (`shift`)
  const trades = (filling, shift = 0) => JSON.stringify({ trades: Array.from({ length: 50 }, (_, i) => ({ t_ms: 1_000_000 + i * 600_000, tx: tx(1_000 + i - shift) })), ...(filling ? { filling: true } : {}), src: "chain", as_of_ms: 1 });
  const fetchFn = async (url) => {
    if (url.includes("/v1/market/lists")) return new Response(JSON.stringify({ lists: { trending_1h: [{ token: t }] } }), { status: 200 });
    n++;
    return new Response(trades(n === 1, n >= 3 ? 1 : 0), { status: 200 });
  };
  const run = await read("http://h", fetchFn, { sleep: async (ms) => void slept.push(ms), pollMs: 0 });
  assert.equal(run.lists.tokens, 1);
  assert.equal(run.answers[0].filled.filling, false);
  assert.deepEqual([run.answers[0].n, run.answers[0].span_ms], [50, 49 * 600_000]);
  assert.ok(slept.includes(REOPEN_AFTER_MS), `waited ${slept}`);
  assert.equal(run.reopen_after_ms, REOPEN_AFTER_MS);
  assert.deepEqual(run.reopen.map((r) => [r.status, r.filling, r.n, r.kept]), [[200, undefined, 50, true]]);
  assert.doesNotMatch(JSON.stringify(run), /0x0{50}/, "no tx recorded");
  assert.equal(judge(run).ok, true, judge(run).lines.join("\n"));
});
