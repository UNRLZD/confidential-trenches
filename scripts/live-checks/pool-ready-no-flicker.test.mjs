// node --test scripts/live-checks/pool-ready-no-flicker.test.mjs: the live check's verdict replays recorded runs
// (pool-ready-no-flicker.answers.json), each read by pool-ready-no-flicker.mjs collect() over the devnet run's record
// (pool-ready-no-flicker.devnet.json):
//   good: --harness, this card's signing page bundle as SIGN_HOST's, and the devnet run: ready "0.02" on every read after
//         the first, over 4 epochs and 3 remakes: PASS;
//   bad:  live SIGN_HOST, serving release-36's bundle from before this card (its sha384 is not the checkout's): FAIL.
// Planted from the good run: one read of ready "0" (the flicker), reads over too few epochs, no remake while read, a
// gap of a minute between reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./pool-ready-no-flicker.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "pool-ready-no-flicker.answers.json"), "utf8"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: this card's bundle, and the devnet run's ready never left 0.02 over 4 epochs: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: live SIGN_HOST on release-36, before this card: FAIL", () => {
  fails(judge(ANSWERS.bad), /is this checkout's signing page bundle/);
});

test("planted: one read of ready 0 during a remake: FAIL", () => {
  fails(mut((rec) => (rec.run.states[Math.floor(rec.run.states.length / 2)].ready = "0")), /every read after it/);
});

test("planted: reads over too few epochs, no remake while read, a minute between reads: FAIL", () => {
  fails(mut((rec) => (rec.run.states = rec.run.states.slice(0, 5))), /epochs, want at least 4/);
  fails(mut((rec) => rec.run.states.forEach((x) => (x.attempts = [rec.run.states[0].attempts[0]]))), /made again 0 times/);
  fails(mut((rec) => rec.run.states.splice(3, 20)), /the longest gap/);
});
