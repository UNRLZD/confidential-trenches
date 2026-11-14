// node --test scripts/live-checks/portfolio-counts-every-note.test.mjs: the live check replays its recorded answers
// (portfolio-counts-every-note.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served before
// the card: FAIL. Planted on the good one: another /app.js, no pin, the mark taken away: each FAIL. Planted in a bundle:
// no event after a slow answer, another state in the event, no time check, no console line: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./portfolio-counts-every-note.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./portfolio-counts-every-note.answers.json", import.meta.url), "utf8"));
const NO_SLOW = "BAD a state answer slower than the app's wait is not posted again as a state event: the app can stay on an older state";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, the path named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_SLOW]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, slow: false }).lines, [NO_SLOW]);
});

test("planted in a bundle: the mark broken in place FAILs", () => {
  const js =
    "if(lne(m)){let e=await l();o({v:1,id:h,ok:!0,result:e},Rh);let t=s()-c;t>=ane&&(console.warn(`state read took ${t} ms (the app waits ${Eh.state} ms for its answer): sent as a state event too`),o({v:1,type:`state`,state:e}));return}";
  const at = (s) => facts("", s).slow;
  assert.equal(at(js), true);
  assert.equal(at(js.replace(",o({v:1,type:`state`,state:e})", "")), false, "no event after a slow answer");
  assert.equal(at(js.replace("state:e})", "state:x})")), false, "another state in the event than the answer's");
  assert.equal(at(js.replace("t>=ane&&", "")), false, "no time check");
  assert.equal(at(js.replace("console.warn(`state read took ${t} ms (the app waits ${Eh.state} ms for its answer): sent as a state event too`),", "")), false, "no console line");
});
