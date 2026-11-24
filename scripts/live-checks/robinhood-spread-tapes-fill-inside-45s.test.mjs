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
import { verdictOf } from "../ci/live-rerun.mjs";
import { nothingToJudge } from "./provider-answer.mjs";
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

test("a run of busy coins alone proves nothing: a tape that fills fast but whose 50 trades span under 2 h is no spread coin, so no spread line passes; this run FAILs on its missing reopen", () => {
  const r = judge(A.bad_busy_only);
  assert.equal(r.ok, false);
  assert.equal(r.quiet, false);
  assert.deepEqual(bad(r), ["BAD no reopen read past 75000 ms"]);
  assert.ok(r.lines.includes("--  no spread coin listed: all 1 tape(s) settled inside 45000 ms, none with 50 trades over 2 h or more (a busy market): nothing to judge"), r.lines.join("\n"));
  assert.match(r.lines[1], /^ok {2}trades .*: filled 4479 ms .*, 50 trades over 0\.2 h$/);
});

// card spread-check-quiet-market-inconclusive: the helper live run 45401968651 (24 Nov 13:3xZ) read Robinhood's 12 listed
// coins, each filled inside 18.4 s (eleven inside 7.8 s) and each reopened whole at once with its newest trade held, all
// busy (50 trades over 0.0 to 0.8 h), and FAILed on "0 spread coin(s) filled": a busy market says nothing of the deploy.
// Every tape settled and none spread is now INCONCLUSIVE, nothing to judge; a tape that did not settle keeps the old FAIL.
test("every listed tape settled and reopened whole, none spread (the live run 45401968651's busy market): INCONCLUSIVE nothing to judge, the live run's inconclusive; a tape still filling, a reopen read from nothing, or a spread coin among them is judged as before (red at ece05a0b9: FAIL)", () => {
  const busy = (f = () => {}) => {
    const run = structuredClone(A.good);
    const a0 = run.answers[0];
    delete run.address;
    run.lists = { status: 200, ms: 10, tokens: 2 };
    run.answers = [0, 1].map((i) => ({ ...structuredClone(a0), address: `0x${String(i + 1).repeat(40)}`, span_ms: 0.4 * 3_600_000 }));
    run.reopen = run.answers.map((a) => ({ ...structuredClone(A.good.reopen[0]), address: a.address }));
    f(run);
    return judge(run);
  };
  const quiet = busy();
  assert.equal(quiet.ok, false, quiet.lines.join("\n"));
  assert.equal(quiet.quiet, true, quiet.lines.join("\n"));
  assert.deepEqual(bad(quiet), []);
  const v = nothingToJudge("robinhood-spread-tapes-fill-inside-45s", A.good.base);
  assert.equal(verdictOf("robinhood-spread-tapes-fill-inside-45s", v.code, v.line), "inconclusive");
  // judged as before: a tape still filling past 45 s (its span not known), a reopen read from nothing, a spread coin
  const filling = busy((r) => (r.answers[1].filled = { ...r.answers[1].filled, filling: true, ms: 45_100 }));
  assert.equal(filling.quiet, false);
  assert.ok(bad(filling).includes("BAD 0 spread coin(s) filled inside 45000 ms (50 trades over 2 h or more)"), filling.lines.join("\n"));
  const reread = busy((r) => Object.assign(r.reopen[0], { filling: true, filled: { status: 200, filling: false, shape: "tape", ms: 3_000, reads: 2 } }));
  assert.deepEqual([reread.ok, reread.quiet], [false, false], reread.lines.join("\n"));
  const spread = busy((r) => (r.answers[0].span_ms = SPREAD_MS));
  assert.deepEqual([spread.ok, spread.quiet], [true, false], spread.lines.join("\n"));
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

// Card spread-reopen-judges-a-busy-coin: live run 45428643869 (helper 8816ec782, 24 Nov 16:0xZ) failed the reopen of
// 0xbbb6c29b, and a local run at 16:4xZ that of 0x89cc584b: each coin's 50 newest trades spanned 86 and 95 s (read
// 16:5xZ), so 75 s and more after the first read the 50 newest were all newer than the newest of before
test("card spread-reopen-judges-a-busy-coin: a reopen without its newest trade of before passes only where it answers 50 trades, every one newer than that one; fewer, or one as old, fails as before", () => {
  const edit = (f) => {
    const run = structuredClone(A.good);
    f(run.reopen[0]);
    return judge(run);
  };
  const moved = edit((r) => Object.assign(r, { kept: false, past: true }));
  assert.equal(moved.ok, true, moved.lines.join("\n"));
  assert.match(moved.lines.at(-1), /^ok {2}reopen 0x[0-9a-f]{40}: answered whole at once in \d+ ms, 50 trades, every one newer than its newest of before$/);
  assert.equal(edit((r) => Object.assign(r, { kept: false, past: false })).ok, false);
  assert.equal(edit((r) => Object.assign(r, { kept: false })).ok, false);
  assert.equal(edit((r) => Object.assign(r, { kept: false, past: true, n: 49 })).ok, false);
  assert.equal(edit((r) => Object.assign(r, { kept: false, past: true, filling: true, filled: { status: 200, filling: false, shape: "tape", ms: 3_000, reads: 2 } })).ok, false);
});

// A kept book behind the chain answers its kept trades filling while it reads the blocks since, a new trade out of the
// answer till its trader is read (apps/helper/src/data/evm/swaps.ts behind, unread): a local run at 16:4xZ, 12 coins
// reopened at once, had 0xbbb6c29b's reopen answer filling in 4,659 ms and fill 2,286 ms on, its newest of before
// held (read alone 80 s idle at 16:5xZ, it answered whole in 777 ms); one at 16:5xZ had 0x39dbed3a's answer 49 trades
// filling, its newest of before held, and fill 2,210 ms on
test("card spread-reopen-judges-a-busy-coin: a reopen that answers filling passes only where its first answer is its kept book (the newest of before held, or 50 trades every one newer) and it fills inside 45 s; a first answer without them was read from nothing", () => {
  const edit = (f) => {
    const run = structuredClone(A.good);
    Object.assign(run.reopen[0], { filling: true, filled: { status: 200, filling: false, shape: "tape", ms: 2_286, reads: 1 } });
    f(run.reopen[0]);
    return judge(run);
  };
  const caught = edit((r) => (r.first = { n: 49, kept: true, past: false }));
  assert.equal(caught.ok, true, caught.lines.join("\n"));
  assert.match(caught.lines.at(-1), /^ok {2}reopen 0x[0-9a-f]{40}: answered filling in \d+ ms from its kept book \(49 trades\), the blocks since read \(filled 2286 ms after its first read \(1 reads\)\), 50 trades, its newest of before held$/);
  assert.equal(edit((r) => (r.first = { n: 50, kept: false, past: true })).ok, true);
  // none (an open with no book), every one newer but fewer than 50, neither held nor passed, or none recorded
  assert.equal(edit((r) => (r.first = { n: 0, kept: false, past: false })).ok, false);
  assert.equal(edit((r) => (r.first = { n: 12, kept: false, past: true })).ok, false);
  assert.equal(edit((r) => (r.first = { n: 50, kept: false, past: false })).ok, false);
  assert.equal(edit(() => {}).ok, false);
  // its kept trades at once, yet it fills past 45 s, or its settled list lost the newest of before
  assert.equal(edit((r) => Object.assign(r, { first: { n: 50, kept: true, past: false }, filled: { status: 200, filling: false, shape: "tape", ms: 45_001, reads: 30 } })).ok, false);
  assert.equal(edit((r) => Object.assign(r, { first: { n: 50, kept: true, past: false }, kept: false, past: false })).ok, false);
});

test("card spread-reopen-judges-a-busy-coin: the recorded run of the deployed helper (24 Nov 16:5xZ) passes: one coin reopened filling from its kept book, one busy coin traded past its 50 newest", () => {
  const r = judge(A.good_busy_reopen);
  assert.deepEqual([r.ok, r.quiet], [true, false], r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^ok {2}reopen 0x39dbed3a2bd333467115de45665cc57f813c4571: answered filling in 880 ms from its kept book \(49 trades\)/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  reopen 0xbbb6c29bcc3a1028a2b54310df73f4f7a3bcb373: answered whole at once in 1162 ms, 50 trades, every one newer than its newest of before"), r.lines.join("\n"));
  // the same run before the card's reading: a reopen without the newest of before, and one filling, each a FAIL
  const before = structuredClone(A.good_busy_reopen);
  for (const x of before.reopen) delete x.past, delete x.first;
  assert.equal(judge(before).ok, false);
});

test("card spread-reopen-judges-a-busy-coin: read marks a reopen past only where every trade it answers is newer than the newest of before", async () => {
  const t = "0x" + "cd".repeat(20);
  const tx = (i) => `0x${i.toString(16).padStart(64, "0")}`;
  // newest first, 2 s apart: the first read's newest at 1,000,000 ms; the reopen's 50 begin `from` ms on, tx 1000 on
  const tape = (newest, txFrom) => JSON.stringify({ trades: Array.from({ length: 50 }, (_, i) => ({ t_ms: newest - i * 2_000, tx: tx(txFrom - i) })), src: "chain", as_of_ms: 1 });
  const runWith = async (reopenBody, firstBody = tape(1_000_000, 900)) => {
    let n = 0;
    const fetchFn = async (url) => {
      if (url.includes("/v1/market/lists")) return new Response(JSON.stringify({ lists: { trending_1h: [{ token: t }] } }), { status: 200 });
      return new Response(n++ === 0 ? firstBody : reopenBody, { status: 200 });
    };
    return (await read("http://h", fetchFn, { sleep: async () => {}, pollMs: 0 })).reopen[0];
  };
  // 50 newer trades: the oldest of them 2 ms past the newest of before
  const past = await runWith(tape(1_000_000 + 98_002, 1_000));
  assert.deepEqual([past.kept, past.past], [false, true]);
  // card spread-reopen-same-second: its oldest of the same second as the newest of before, a trade the first answer
  // (reaching back past that second) never held: newer, in a later block of that second
  const same = await runWith(tape(1_000_000 + 98_000, 1_000));
  assert.deepEqual([same.kept, same.past], [false, true]);
  // the newest of before held
  const held = await runWith(tape(1_000_000 + 20_000, 910));
  assert.deepEqual([held.kept, held.past], [true, false]);
  // a trade of that second the first answer held (beside the newest of before), the newest of before gone: it should
  // be there, so not past
  const two = JSON.stringify({ trades: [{ t_ms: 1_000_000, tx: tx(900) }, { t_ms: 1_000_000, tx: tx(899) }, ...Array.from({ length: 48 }, (_, i) => ({ t_ms: 1_000_000 - (i + 1) * 2_000, tx: tx(898 - i) }))], src: "chain", as_of_ms: 1 });
  const lostBody = JSON.stringify({ trades: [...Array.from({ length: 49 }, (_, i) => ({ t_ms: 1_000_000 + 98_000 - i * 2_000, tx: tx(1_000 - i) })), { t_ms: 1_000_000, tx: tx(899) }], src: "chain", as_of_ms: 1 });
  const lost = await runWith(lostBody, two);
  assert.deepEqual([lost.kept, lost.past], [false, false]);
  // a first answer all of one second does not reach back past it, so a trade of that second it never held may be older
  // than its 50: not past
  const flat = JSON.stringify({ trades: Array.from({ length: 50 }, (_, i) => ({ t_ms: 1_000_000, tx: tx(900 - i) })), src: "chain", as_of_ms: 1 });
  const narrow = await runWith(tape(1_000_000 + 98_000, 1_000), flat);
  assert.deepEqual([narrow.kept, narrow.past], [false, false]);
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
