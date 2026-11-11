// node --test scripts/live-checks/pool-tree-read-waits-for-its-second.test.mjs: the live check replays its recorded
// answers (pool-tree-read-waits-for-its-second.answers.json, its _note says where each was read). good: this card's
// signing page build with mainnet's cadence read on two providers: PASS. bad: SIGN_HOST as served before the card:
// FAIL, every mark named. planted: the good answer with one thing changed each: FAIL on it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKS, REACH_WAITS, judge } from "./pool-tree-read-waits-for-its-second.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-tree-read-waits-for-its-second.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const no = (k) => `BAD the served bundle does not carry: ${k}`;
const KEYS = Object.keys(MARKS);

test("recorded good answer: this card's build, and mainnet reaching now + 1 s within the cap on both providers: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.equal(v.lines.filter((l) => l.startsWith("ok ")).length, 2);
});

test("recorded bad answer: SIGN_HOST before the card carries none of the marks: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(bads(v), KEYS.map(no));
});

test("planted on good: another /app.js, no pin, each mark missing, a provider past the cap, one provider: each FAIL", () => {
  const g = A.good;
  assert.deepEqual(bads(judge({ ...g, sha384: "sha384-x" })), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(bads(judge({ ...g, index: "<html></html>" })), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of KEYS) assert.deepEqual(bads(judge({ ...g, carries: { ...g.carries, [k]: false } })), [no(k)], k);
  const stalled = { ...g.chain[0], reached: false, waits: REACH_WAITS };
  assert.deepEqual(bads(judge({ ...g, chain: [stalled, g.chain[1]] })), [`BAD ${stalled.provider}: its confirmed block did not reach now + 1 s within ${REACH_WAITS} waits`]);
  assert.deepEqual(bads(judge({ ...g, chain: [g.chain[0]] })), ["BAD no mainnet read on two providers"]);
});
