// node --test scripts/live-checks/mihao-opens-first.test.mjs: the live check replays its recorded answers
// (mihao-opens-first.answers.json). good: this card's build (apps/terminal/dist), / on All opening mihao: PASS.
// liveBefore: APP_HOST before this card's deploy (read 14 Nov 21:53Z), / opening NEARKAT (card nearkat-opens-first): FAIL, named.
// Planted on the good one: another script, no pin, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MIHAO } from "./mihao-opens-first.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./mihao-opens-first.answers.json", import.meta.url), "utf8"));
const NO_OPEN = `BAD the app names no token for / to open: mihao (${MIHAO}) is not in it`;
const NO_HOME = "BAD / on All does not open mihao: it opens the top Trending token";

test("recorded good answer: this card's build, / on All opening mihao: PASS", () => {
  assert.deepEqual(judge(ANSWERS.good), { ok: true, lines: [] });
});

test("recorded bad answer liveBefore: APP_HOST before this card, / on All opening NEARKAT: FAIL, mihao named", () => {
  assert.deepEqual(judge(ANSWERS.liveBefore), { ok: false, lines: [NO_OPEN] });
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ app: { ...g.app, sha384: "sha384-other" } }).lines, ["BAD APP_HOST's served script is not the one index.html pins"]);
  assert.deepEqual(judge({ app: { ...g.app, index: "<html></html>" } }).lines, ["BAD APP_HOST's index.html pins no script"]);
  assert.deepEqual(judge({ app: { ...g.app, open: false } }).lines, [NO_OPEN]);
  assert.deepEqual(judge({ app: { ...g.app, home: false } }).lines, [NO_HOME]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from the script: the token object, and / on All reading that same object", () => {
  const js = "var Zu=`/token/:chain/:id`,Qu={chain:`solana`,id:`" + MIHAO + "`},$u=1;async function hN(e=fetch,t=`all`,n=$f){return t===`all`?mN(Qu.chain,Qu.id,e):gN(e,t,n)}";
  assert.deepEqual([facts({ index: "", js }).app.open, facts({ index: "", js }).app.home], [true, true]);
  // another mint (NEARKAT's), another chain, or All reading another object is not this card's opener
  assert.equal(facts({ index: "", js: js.replace(MIHAO, "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr") }).app.open, false);
  assert.equal(facts({ index: "", js: js.replace("chain:`solana`", "chain:`base`") }).app.open, false);
  assert.equal(facts({ index: "", js: js.replace("mN(Qu.chain,Qu.id", "mN(Xu.chain,Xu.id") }).app.home, false);
  // the token named but never read on All (the object left in, the old rule back) is no opener
  assert.equal(facts({ index: "", js: js.replace("t===`all`?mN(Qu.chain,Qu.id,e):gN(e,t,n)", "gN(e,t,n)") }).app.home, false);
});
