// node --test scripts/live-checks/a-load-proves-first-and-walks-the-restore-once.test.mjs: the live check replays its
// recorded answers (a-load-proves-first-and-walks-the-restore-once.answers.json). good: this card's SIGN_HOST build:
// PASS. bad: main fe1ad9879's build, before the card: FAIL. Planted on the good one: another /app.js, no pin, each mark
// taken away: each FAIL. Planted in a bundle: the host's bound not handed, the resume's wait gone, its bound changed,
// the read kind fixed, a Sync that joins the resume: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./a-load-proves-first-and-walks-the-restore-once.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./a-load-proves-first-and-walks-the-restore-once.answers.json", import.meta.url), "utf8"));
const NO_FIRST = "BAD a load's restore reads beside its first proof pass: the first proof waits on the restore's reads";
const NO_PASS = "BAD a load's restore reads as a trade: its walk goes beside the user's own reads";
const NO_SYNC = "BAD a Sync joins a load's restore: it is told the load's end with nothing walked for it";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: main fe1ad9879's build: FAIL, each path named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_FIRST, NO_PASS, NO_SYNC]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, first: false }).lines, [NO_FIRST]);
  assert.deepEqual(judge({ ...g, pass: false }).lines, [NO_PASS]);
  assert.deepEqual(judge({ ...g, sync: false }).lines, [NO_SYNC]);
});

test("planted in a bundle: each mark broken in place FAILs", () => {
  const js = [
    "written:()=>void b3?.proofs().catch(()=>{}),firstPass:e=>b3?.firstPass(e)??Promise.resolve(),ux:e=>1",
    "return!await n()||(e.firstPass&&await e.firstPass(e.firstPassMaxMs??2e4),!await n())?null:l(!0).first",
    "c=async(t,i,a,s)=>{let c=i?`pass`:`trade`,l=e.pools?e.pools(c):J4(kw,c),u=1}",
    "u=async()=>{for(;i?.owed;){let e=i;a?.abort(),await e.done}return l(!1)}",
  ].join(";");
  const at = (s) => facts("", s);
  assert.deepEqual([at(js).first, at(js).pass, at(js).sync], [true, true, true]);
  assert.equal(at(js.replace("firstPass:e=>b3?.firstPass(e)", "firstPass:e=>b3?.firstPass()")).first, false, "the bound not handed to the page");
  assert.equal(at(js.replace("e.firstPass&&await ", "")).first, false, "the resume does not wait");
  assert.equal(at(js.replace("2e4", "6e4")).first, false, "another bound");
  assert.equal(at(js.replace("i?`pass`:`trade`", "`trade`")).pass, false, "every run read as a trade");
  assert.equal(at(js.replace("e.pools(c)", "e.pools()")).pass, false, "the kind not handed to the pools");
  assert.equal(at(js.replace("a?.abort(),", "")).sync, false, "a Sync that waits the resume out");
  assert.equal(at(js.replace("for(;i?.owed;){let e=i;a?.abort(),await e.done}", "")).sync, false, "a Sync that joins the resume");
});
