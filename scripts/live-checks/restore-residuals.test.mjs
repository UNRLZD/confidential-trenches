// node --test scripts/live-checks/restore-residuals.test.mjs: the live check replays its recorded answers
// (restore-residuals.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served before the card:
// FAIL, each fact named. Planted on the good one: another /app.js, no pin, each fact taken away: each FAIL. Planted in
// this tree's build: each rule broken in place: its fact false.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { facts, judge, WHY } from "./restore-residuals.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./restore-residuals.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, each fact named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, Object.values(WHY).map((w) => `BAD ${w}`));
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [k, why] of Object.entries(WHY)) assert.deepEqual(judge({ ...g, [k]: false }).lines, [`BAD ${why}`], k);
});

test("this tree's build holds every fact; each rule broken in place in it turns its fact false", () => {
  const dir = signBuilt();
  const js = readFileSync(`${dir}/public/app.js`, "utf8");
  const f = (text) => facts("", text);
  const all = (x) => ({ kept: x.kept, part: x.part, shape: x.shape, lock: x.lock, again: x.again });
  assert.deepEqual(all(f(js)), { kept: true, part: true, shape: true, lock: true, again: true });
  const mut = (from, to) => {
    assert.equal([...js.matchAll(new RegExp(from.source, "g"))].length, 1, String(from));
    return f(js.replace(from, to));
  };
  // kept: on the highest note alone, or on another run's marker
  assert.equal(mut(/\.filter\(\(\[([\w$]+),,([\w$]+),([\w$]+)\]\)=>\2===\(([\w$]+)\[\1\]\?\?null\)&&\3===([\w$]+)\[\1\]\)/, ".filter(([$1,,$2,$3])=>$2===($4[$1]??null))").kept, false, "highest alone");
  assert.equal(mut(/([\w$]+)\?\.run===([\w$]+)\?new Map\(\(\1\.read\?\./, "$1!==null?new Map(($1.read?.").kept, false, "another run's marker");
  // part: on the highest note alone
  assert.equal(mut(/\.filter\(\(\[([\w$]+),,,([\w$]+),([\w$]+)\]\)=>\2===\(([\w$]+)\[\1\]\?\?null\)&&\3===([\w$]+)\[\1\]\)/, ".filter(([$1,,,$2,$3])=>$2===($4[$1]??null))").part, false, "part on highest alone");
  // shape: readTo off its lane taken, or no count
  assert.equal(mut(/&&([\w$]+)\[1\]%8===\1\[0\]&&\(\1\[2\]===null/, "&&($1[2]===null").shape, false, "readTo off its lane");
  assert.equal(mut(/\.length===4&&Number\.isInteger\(([\w$]+)\[0\]\)&&\1\[0\]>=0&&\1\[0\]<8&&Number\.isInteger\(\1\[1\]\)/, ".length===3&&Number.isInteger($1[0])&&$1[0]>=0&&$1[0]<8&&Number.isInteger($1[1])").shape, false, "the shape before the count");
  // lock: skipped when another tab holds it
  assert.equal(mut(/\{mode:`exclusive`,signal:([\w$]+)\},async\(\)=>\{\1\.throwIfAborted\(\),await ([\w$]+)\(\)\}\)/, "{mode:`exclusive`,ifAvailable:!0},async l=>{l!==null&&($1.throwIfAborted(),await $2())})").lock, false, "skipped while held");
  // again: a joining request not marked, or the run's end starting nothing
  assert.equal(mut(/\(([\w$]+)\.reading&&\(([\w$]+)=!0\),/, "(").again, false, "not marked");
  assert.equal(mut(/&&([\w$]+)===null&&([\w$]+)\(!1,([\w$]+)\.finding\)/, "&&!1").again, false, "nothing started");
});
