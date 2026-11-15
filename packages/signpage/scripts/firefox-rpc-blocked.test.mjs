// node --test packages/signpage/scripts/firefox-rpc-blocked.test.mjs: the check's verdict and its bound on recorded runs.
//
// Card firefox-restore-holds-on-every-runner: the same code restored in 39 s on one GitHub runner of the label
// ubuntu-24.04 (AWS) and in 48 and 64 s on others (Azure), so the bound is scaled to the machine that runs it, and every
// walk Worker must say it hashed on WebAssembly. Card firefox-bound-times-the-walk-itself: its first yardstick, a fixed JS
// integer loop, put the Azure eastus runner of queue run 43681047546 at 1.49 times the box (bound 67.1 s) while its
// restore ran 63.75 s, 3.4 times the box's: a 5% margin. The yardstick is now the restore's own walk (walkSpeed: the
// shipped /walk-worker.js on one Solana and three precommitment pools at gap 1000, as many Workers at once as the walk
// starts), timed once for the job and again right before each run.
//
// Recorded on the heavy box (Intel i5-14600K, taskset to 2 physical cores with their 4 threads, or 1 core with 2;
// Playwright Firefox 155.0, Strict tracking protection, hardwareConcurrency 16, so 8 walk Workers), at this card's code,
// `--hosts mainnet.base.org`, the box's load 2.9 at the start, the numbers as the check printed them:
//   - taskset -c 0-3: the walk 2.46 s (runs 2.44, 2.49, 2.46); nothing failed, balance 13.43 s, restore 21.77 s;
//     mainnet.base.org failed, 11.65 s and 18.76 s;
//   - taskset -c 0-1: the walk 3.93 s (runs 4.16, 3.93, 3.93); nothing failed, 22.96 s and 37.38 s; mainnet.base.org
//     failed, 23.21 s and 37.78 s.
// And the whole matrix at taskset -c 0-3 with the box's load 7 rising to 15: the walk 3.33 s, 11 runs ending 18.39 to
// 26.34 s, every one inside its bound.
// The fixed share of a restore that no CPU speeds (each read answered 150 ms late by the harness): a line through the
// two quiet points, restore = a + k * walk, gives a = -5.1 s; the reads overlap the walk, and the restore grows a little
// faster than the walk alone (the page's and the harness's own work share the cores), so no fixed share is kept apart.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BOUND_S, REF_WALK_MS, scaledBound, verdict } from "./firefox-rpc-blocked.mjs";
import { hashedOf, hashText, speedOf } from "./restore-speed-browser.mjs";

const run = (shown, done, hashed = { wasm: 32, bigint: 0 }, workerEvents = 32) => ({ shownMs: shown * 1000, doneMs: done * 1000, hashed, workerEvents, unanswered: [], after: { ended: true, how: "reason down", ms: 900 } });
const wasm = (ms) => ({ ms, workers: 8, hashes: { wasm: 32, bigint: 0, other: 0 } });

// the quiet box runs
const BOX4 = { walk: 2460, done: [21.77, 18.76], shown: [13.43, 11.65] };
const BOX2 = { walk: 3930, done: [37.38, 37.78], shown: [22.96, 23.21] };
// queue run 43681047546 (Azure eastus, hardwareConcurrency 4, 4 walk Workers): every run of the matrix that walked all
// four pools, [balance, restore] in s
const EASTUS = [[36.78, 63.75], [36.93, 63.83], [36.83, 63.83], [24.18, 63.99], [36.95, 63.53], [36.7, 62.95], [36.91, 63.52], [36.77, 63.32], [36.61, 63.38], [36.88, 63.93]];
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;

test("the bound is 45 s on the bound's machine, where the walk took 2.44 s", () => {
  assert.equal(BOUND_S, 45);
  assert.equal(REF_WALK_MS, 2440);
});

test("on the box, the walk's ratio from 4 cores to 2 tracks the restore's within 20%", () => {
  const walk = BOX2.walk / BOX4.walk;
  const restore = mean(BOX2.done) / mean(BOX4.done);
  assert.equal(walk.toFixed(2), "1.60");
  assert.equal(restore.toFixed(2), "1.85");
  assert.ok(Math.abs(walk / restore - 1) <= 0.2, `${walk} against ${restore}`);
});

test("the box's runs pass at their own machine's bound: 4 cores and 2 cores", () => {
  for (const b of [BOX4, BOX2]) b.done.forEach((d, k) => assert.deepEqual(verdict(run(b.shown[k], d), scaledBound(BOUND_S, b.walk)), { ok: true, why: [] }));
  assert.equal(scaledBound(BOUND_S, BOX4.walk).toFixed(1), "45.4");
  assert.equal(scaledBound(BOUND_S, BOX2.walk).toFixed(1), "72.5");
  assert.equal(scaledBound(BOUND_S, 1000), 45, "never below its own bound");
});

test("eastus (queue run 43681047546): the old loop's bound left 5%; the walk's leaves at least 25%", () => {
  // the loop's figure there: 2.58 s against 1.73 s on the box, bound 67.1 s
  const loop = BOUND_S * (2580 / 1730);
  assert.ok(loop / Math.max(...EASTUS.map((x) => x[1])) < 1.06, "the margin that blocked the queue");
  // the walk's figure there, read from its log: from Base's walk written to Robinhood's (Solana's, the vault's and
  // Robinhood's walks between) 49.5 s against the box's 14.2 s (5.6 to 19.8 s, the same code at 4 cores), 3.49 times;
  // queue run 43681047546 predates walkSpeed, so this is the walk's own time read off that run, not a walkSpeed print
  const walkThere = REF_WALK_MS * (49.5 / 14.2);
  const bound = scaledBound(BOUND_S, walkThere);
  for (const [s, d] of EASTUS) {
    assert.deepEqual(verdict(run(s, d), bound), { ok: true, why: [] });
    assert.ok(bound / d >= 1.25, `${bound.toFixed(1)} s against ${d} s`);
  }
  assert.equal(bound.toFixed(1), "156.9");
  // and the least walk time there that still leaves 25%: 1.78 times the box's, against the 3.49 its log shows
  const least = (1.25 * Math.max(...EASTUS.map((x) => x[1]))) / BOUND_S;
  assert.equal(least.toFixed(2), "1.78");
});

test("a walk on BigInt fails at any bound, and never sets one", () => {
  for (const walk of [REF_WALK_MS, 10_000, 1e9]) {
    const v = verdict(run(18.02, 31.69, { wasm: 0, bigint: 32 }), scaledBound(BOUND_S, walk));
    assert.deepEqual(v, { ok: false, why: ["32 walk Workers hashed on BigInt, not WebAssembly"] });
  }
  // pre-WebAssembly code says no hash path: it fails however slow the machine (merge queue run 43663711503, 92.03 s)
  assert.ok(verdict(run(50.83, 92.03, null), scaledBound(BOUND_S, 1e9)).why.includes('the page never said which field the walk hashed on (no "restore: the walk Workers hashed on" line)'));
  // the yardstick refuses a walk that is not WebAssembly in every lane
  assert.equal(speedOf([wasm(2460), wasm(2440), wasm(2490)]).ms, 2460);
  for (const hashes of [{ wasm: 0, bigint: 32, other: 0 }, { wasm: 31, bigint: 1, other: 0 }, { wasm: 31, bigint: 0, other: 1 }, { wasm: 24, bigint: 0, other: 0 }])
    assert.throws(() => speedOf([wasm(2460), { ms: 9000, workers: 8, hashes }]), /the speed walk did not hash on WebAssembly in every lane/);
  assert.throws(() => speedOf([]), /did not hash on WebAssembly/);
});

test("past its scaled bound still fails, on the slower machine too", () => {
  assert.deepEqual(verdict(run(22.45, 80), scaledBound(BOUND_S, BOX2.walk)).why, ["the restore ended at 80.0 s, past 72.5 s"]);
  assert.deepEqual(verdict(run(73, 40), scaledBound(BOUND_S, BOX2.walk)).why, ["the balance drew at 73.0 s, past 72.5 s"]);
});

test("walk Workers started but not counted fail: a lane that fell back to the page or never answered", () => {
  assert.deepEqual(verdict(run(11.69, 18.82, { wasm: 31, bigint: 0 }), BOUND_S).why, ["31 walk Workers answered a walk of the 32 started"]);
  assert.deepEqual(verdict(run(11.69, 18.82, { wasm: 32, bigint: 0 }, 40), BOUND_S).why, ["32 walk Workers answered a walk of the 40 started"]);
});

test("the page's lines give the hash path, summed over passes, and the run line says it", () => {
  const box = ["restore: base walked @5.7s", "restore: solana walked @13.7s", "restore: near walked @16.4s", "restore: robinhood walked @19.9s", "restore: the walk Workers hashed on wasm 32, bigint 0 @19.9s"];
  assert.deepEqual(hashedOf(box), { wasm: 32, bigint: 0 });
  assert.deepEqual(hashedOf([...box, "restore: the walk Workers hashed on wasm 6, bigint 2 @40.0s"]), { wasm: 38, bigint: 2 });
  assert.equal(hashedOf(box.slice(0, 4)), null);
  assert.equal(hashText({ wasm: 32, bigint: 0 }), "the walk hashed on WebAssembly in 32 Workers, on BigInt in 0");
  assert.equal(hashText(null), "the walk's hash path not said by the page");
});
