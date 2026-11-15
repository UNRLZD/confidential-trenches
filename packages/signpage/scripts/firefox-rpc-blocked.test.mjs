// node --test packages/signpage/scripts/firefox-rpc-blocked.test.mjs: the check's verdict on recorded runs.
//
// Card firefox-restore-holds-on-every-runner: the same code (main f691eb4c4) restored in 39 s on one GitHub runner of
// the label ubuntu-24.04 (group run 43673429752: AWS us-east-1, image 20261111.127.1) and in 48 and 64 s on two others
// (jobs 132691451574 and 132694658281: Azure westus3 and eastus, image 20261111.370.1), the same Playwright Firefox
// 155.0 on all three; the pre-WebAssembly merge queue run 43663711503 (job 132658382556, 92.03 s) was Azure westus3
// too. A bound in seconds alone passed or failed by the machine drawn, and nothing said which field the walk hashed
// on. So the bound is scaled by machineSpeed on the machine that runs it (scaledBound), and every walk Worker must
// say it hashed on WebAssembly.
//
// The runs below were recorded on the heavy box (Intel i5-14600K, Playwright Firefox 155.0, Strict tracking
// protection, Workers, hardwareConcurrency 16, `--hosts mainnet.base.org`), at this card's code unless named, the numbers
// as the check printed them:
//   - taskset -c 0-3: a fixed loop in 8 Workers 1.73 s (runs 1.78, 1.73, 1.66); nothing failed, balance 11.69 s,
//     restore done 18.82 s; mainnet.base.org failed, 11.70 s and 18.89 s; WebAssembly in 32 Workers, BigInt in 0;
//   - taskset -c 0-1: the loop 3.37 s (runs 3.48, 3.31, 3.37); nothing failed, 22.45 s and 36.70 s; mainnet.base.org
//     failed, 22.33 s and 36.75 s; WebAssembly in 32 Workers: half the cores, twice the loop and twice the restore;
//   - taskset -c 0-3 with /walk-worker.js's policy lacking 'wasm-unsafe-eval' (public/_headers changed for the run
//     only): the loop 1.69 s; nothing failed, 18.02 s and 31.69 s; mainnet.base.org failed, 17.99 s and 31.70 s;
//     WebAssembly in 0 Workers, BigInt in 32: inside 45 s, so only the hash path tells it.
//   - the merge queue's run 43663711503 at 245496a84 (each walk on BigInt, no hash line): balance 50.83 s, restore
//     92.03 s, 32 walk Workers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BOUND_S, REF_SPEED_MS, scaledBound, verdict } from "./firefox-rpc-blocked.mjs";
import { hashedOf, hashText } from "./restore-speed-browser.mjs";

const run = (shown, done, hashed = { wasm: 32, bigint: 0 }, workerEvents = 32) => ({ shownMs: shown * 1000, doneMs: done * 1000, hashed, workerEvents, unanswered: [], after: { ended: true, how: "reason down", ms: 900 } });

test("the bound is 45 s on the bound's machine, where the fixed loop took 1.73 s", () => {
  assert.equal(BOUND_S, 45);
  assert.equal(REF_SPEED_MS, 1730);
});

test("the bound scales with the machine's loop time and never drops below its own", () => {
  assert.equal(scaledBound(BOUND_S, 1729), 45);
  assert.equal(scaledBound(BOUND_S, 1691), 45);
  assert.equal(scaledBound(BOUND_S, 1000), 45);
  assert.equal(scaledBound(BOUND_S, 3369).toFixed(1), "87.6");
  assert.equal(scaledBound(BOUND_S, 3460), 90);
});

test("the box's WebAssembly runs pass at their own machine's bound: 4 cores and 2 cores", () => {
  for (const [s, d] of [[11.69, 18.82], [11.7, 18.89]]) assert.deepEqual(verdict(run(s, d), scaledBound(BOUND_S, 1729)), { ok: true, why: [] });
  for (const [s, d] of [[22.45, 36.7], [22.33, 36.75]]) assert.deepEqual(verdict(run(s, d), scaledBound(BOUND_S, 3369)), { ok: true, why: [] });
});

test("the slow runners' restores fail a bound left in seconds (jobs 132691451574, 132694658281): the scale is what holds it", () => {
  assert.deepEqual(verdict(run(27.89, 48.37), BOUND_S).why, ["the restore ended at 48.4 s, past 45 s"]);
  assert.deepEqual(verdict(run(37.17, 63.99), BOUND_S).why, ["the restore ended at 64.0 s, past 45 s"]);
  // planted: past the scaled bound still fails, on the slower machine too
  assert.deepEqual(verdict(run(22.45, 90.4), scaledBound(BOUND_S, 3369)).why, ["the restore ended at 90.4 s, past 87.6 s"]);
  assert.deepEqual(verdict(run(88, 40), scaledBound(BOUND_S, 3369)).why, ["the balance drew at 88.0 s, past 87.6 s"]);
});

test("a walk on BigInt fails though it ends inside the bound (the box, wasm refused by the walk Worker's policy)", () => {
  for (const [s, d] of [[18.02, 31.69], [17.99, 31.7]]) {
    const v = verdict(run(s, d, { wasm: 0, bigint: 32 }), scaledBound(BOUND_S, 1691));
    assert.deepEqual(v, { ok: false, why: ["32 walk Workers hashed on BigInt, not WebAssembly"] });
  }
  // one Worker of 32 on BigInt fails too
  assert.deepEqual(verdict(run(11.69, 18.82, { wasm: 31, bigint: 1 }), BOUND_S).why, ["1 walk Workers hashed on BigInt, not WebAssembly"]);
});

test("pre-WebAssembly code fails at any machine's bound: its page never says the hash path (merge queue run 43663711503)", () => {
  for (const speed of [1730, 3460, 10_000]) {
    const v = verdict(run(50.83, 92.03, null), scaledBound(BOUND_S, speed));
    assert.equal(v.ok, false);
    assert.ok(v.why.includes('the page never said which field the walk hashed on (no "restore: the walk Workers hashed on" line)'), v.why.join("; "));
  }
  // and at the bound's machine its time fails as well
  assert.ok(verdict(run(50.83, 92.03, null), BOUND_S).why.includes("the restore ended at 92.0 s, past 45 s"));
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
