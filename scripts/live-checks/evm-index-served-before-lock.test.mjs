// node --test scripts/live-checks/evm-index-served-before-lock.test.mjs: the live check replays its recorded answers
// (evm-index-served-before-lock.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as deployed
// before the card (release 176): FAIL, the serve inside the lock named. Planted on the good one: another /app.js, no
// pin, no lock in the bundle: each FAIL. Planted in its excerpt: the serve back inside the lock, a write in the serve,
// the write out of the sync, the lock without ifAvailable: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NO_SERVE_FIRST, SERVE_WRITES, SYNC_NO_WRITE, excerptOf, facts, judge, shape } from "./evm-index-served-before-lock.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./evm-index-served-before-lock.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, the serve inside the lock named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_SERVE_FIRST]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, excerpt: "" }).lines, [NO_SERVE_FIRST]);
  assert.equal(excerptOf("let a=1;"), "", "a bundle with no index lock has no excerpt");
  assert.equal(facts("", `x;${ANSWERS.good.excerpt}`).excerpt.includes("ct-evm-index/"), true);
});

test("planted in the excerpt: each mark broken in place FAILs", () => {
  const x = ANSWERS.good.excerpt;
  assert.deepEqual(shape(x), []);
  const run = /([\w$]+)\(([\w$]+(?:,[\w$]+)*)?\)\.catch\(\(\)=>\{\}\)\.then\(\(\)=>/.exec(x);
  assert.ok(run, "the good excerpt runs its serve first");
  const [, serve] = run;
  // the serve back inside the lock: the run starts at the lock, as release 176's
  const inside = x.replace(/[\w$]+\([\w$,]*\)\.catch\(\(\)=>\{\}\)\.then\(\(\)=>[\w$]+\.aborted\?void 0:/, "(");
  assert.notEqual(inside, x);
  assert.deepEqual(shape(inside), [NO_SERVE_FIRST]);
  // a write to the store in the serve
  const servePut = x.replace(new RegExp(`(${serve.replace(/\$/g, "\\$")}=async\\([^)]*\\)=>\\{)`), "$1await Ue?.put(t,null);");
  assert.notEqual(servePut, x);
  assert.deepEqual(shape(servePut), [SERVE_WRITES]);
  // the serve reads no kept index
  const noGet = x.replace(/\?\.get\(/, ".none(");
  assert.deepEqual(shape(noGet), [SERVE_WRITES]);
  // the write out of the sync
  const noPut = x.replace(/\?\.put\(/, ".none(");
  assert.deepEqual(shape(noPut), [SYNC_NO_WRITE]);
  // the lock without ifAvailable, or another lock's name
  assert.deepEqual(shape(x.replace("{ifAvailable:!0}", "{}")), [NO_SERVE_FIRST]);
  assert.deepEqual(shape(x.replace("ct-evm-index/", "ct-evm-holdings/")), [NO_SERVE_FIRST]);
});
