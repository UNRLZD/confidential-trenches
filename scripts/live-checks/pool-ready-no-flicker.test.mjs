// node --test scripts/live-checks/pool-ready-no-flicker.test.mjs: the live check's verdict replays recorded runs
// (pool-ready-no-flicker.answers.json), each read by pool-ready-no-flicker.mjs collect():
//   good: --harness, this card's signing page bundle as SIGN_HOST's: PASS;
//   bad:  live SIGN_HOST, serving release-36's bundle from before this card (its sha384 is not the checkout's, and its
//         text has no readyWith): FAIL.
// The live check reads SIGN_HOST and the checkout only (card live-checks-read-mainnet-only): the recordings' `run` (the
// devnet run, read when the check judged it) is no longer judged there. That run's record is replayed here instead,
// from pool-ready-no-flicker.devnet.json by runLines below: ready "0.02" on every read after the first, over 4 epochs
// and 3 remakes: PASS. Planted (made): a bundle without the readyWith state path (the page's call gone, or none at
// all); on the run, one read of ready "0" (the flicker), reads over too few epochs, no remake while read, a gap of a
// minute between reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, READ_EPOCHS, readyPath } from "./pool-ready-no-flicker.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "pool-ready-no-flicker.answers.json"), "utf8"));
/** The devnet run's record as the check once read it. */
const RUN = (() => {
  const r = JSON.parse(readFileSync(path.join(HERE, "pool-ready-no-flicker.devnet.json"), "utf8"));
  return { cluster: r.cluster, states: r.states.map((x) => ({ at: x.at, ready: x.ready, attempts: x.attempts })) };
})();
const EPOCH_MS = 60_000;
/** The verdict on the run record, as the live check gave it before it read mainnet only. */
function runLines(run) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const states = Array.isArray(run.states) ? run.states : [];
  const k = states.findIndex((x) => typeof x?.ready === "string" && /[1-9]/.test(x.ready));
  const first = k < 0 ? null : states[k].ready;
  const after = k < 0 ? [] : states.slice(k);
  const off = after.filter((x) => x.ready !== first);
  say(first !== null && run.cluster === "devnet", `the devnet run's first ready read: ${first ?? "none"}`);
  say(first !== null && off.length === 0, `every read after it gave ${first ?? "it"}: ${off.length ? off.map((x) => `${x.at} ${x.ready}`).join(", ") : `all ${after.length}`}`);
  const epochs = new Set(after.map((x) => Math.floor(Date.parse(x.at) / EPOCH_MS))).size;
  say(epochs >= READ_EPOCHS, `the reads span ${epochs} epochs, want at least ${READ_EPOCHS}`);
  const remakes = new Set(after.flatMap((x) => x.attempts ?? [])).size - 1;
  say(remakes >= READ_EPOCHS - 1, `the proof was made again ${Math.max(remakes, 0)} times while read, want at least ${READ_EPOCHS - 1}`);
  const gap = after.slice(1).reduce((m, x, i) => Math.max(m, Date.parse(x.at) - Date.parse(after[i].at)), 0);
  say(after.length > 1 && gap <= 20_000, `reads every few seconds: the longest gap ${gap} ms, want at most 20000`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const mutRun = (f) => {
  const run = structuredClone(RUN);
  f({ run });
  return runLines(run);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: this card's bundle: PASS; the live check judges the bundle only", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 2);
  assert.ok(!r.lines.some((l) => /devnet/.test(l)));
});

test("the devnet run's record (replayed, not live): ready never left 0.02 over 4 epochs: PASS; the recorded answers held that same run", () => {
  const r = runLines(RUN);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(ANSWERS.good.run, RUN);
});

test("recorded bad answer: live SIGN_HOST on release-36, before this card: FAIL", () => {
  fails(judge(ANSWERS.bad), /is this checkout's signing page bundle/);
});

test("planted: a served bundle without the readyWith state path: FAIL", () => {
  fails(mut((rec) => (rec.signBundle.readyWith = { defs: 2, calls: 1 })), /readyWith state path/);
  fails(mut((rec) => delete rec.signBundle.readyWith), /readyWith state path/);
  // the read itself: a text whose state read is back on ready() counts one call
  assert.deepEqual(readyPath("a={readyWith:e=>1};b={readyWith:async e=>a.readyWith(e)};c=b.ready()"), { defs: 2, calls: 1 });
});

test("planted: one read of ready 0 during a remake: FAIL", () => {
  fails(mutRun((rec) => (rec.run.states[Math.floor(rec.run.states.length / 2)].ready = "0")), /every read after it/);
});

test("planted: reads over too few epochs, no remake while read, a minute between reads: FAIL", () => {
  const cut = mutRun(({ run }) => (run.states = run.states.slice(0, 5)));
  fails(cut, /epochs, want at least 4/);
  fails(mutRun((rec) => rec.run.states.forEach((x) => (x.attempts = [rec.run.states[0].attempts[0]]))), /made again 0 times/);
  fails(mutRun((rec) => rec.run.states.splice(3, 20)), /the longest gap/);
});
