// node --test scripts/live-checks/notes-plan-at-restored-index.test.mjs: the live check replays its recorded answers
// (notes-plan-at-restored-index.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served before
// the card: FAIL, each fact named. Planted on the good one: another /app.js, no pin, each fact taken away: each FAIL.
// Planted in this tree's build: each rule broken in place: its fact false.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { facts, judge, WHY } from "./notes-plan-at-restored-index.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./notes-plan-at-restored-index.answers.json", import.meta.url), "utf8"));

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
  const all = (x) => ({ rule: x.rule, held: x.held, counter: x.counter, funded: x.funded, wired: x.wired });
  assert.deepEqual(all(f(js)), { rule: true, held: true, counter: true, funded: true, wired: true });
  const mut = (from, to) => {
    assert.equal([...js.matchAll(new RegExp(from.source, "g"))].length, 1, String(from));
    return f(js.replace(from, to));
  };
  // the read rule: one provider's word, two apart, a read of no money
  assert.equal(mut(/\.length!==2(\|\|![\w$]+\.every\(([\w$]+)=>typeof \2==`bigint`\)\)throw Error\(`a found read)/, ".length<1$1").rule, false, "one provider's word taken");
  assert.equal(mut(/if\(([\w$]+)\[0\]!==\1\[1\]\)throw Error\(`the two providers read/, "if(!1)throw Error(`the two providers read").rule, false, "two apart taken");
  assert.equal(mut(/if\(([\w$]+)\[0\]<=0n\)throw Error\(`the two providers read no money/, "if($1[0]<0n)throw Error(`the two providers read no money").rule, false, "a read of 0 taken");
  // the held index, the counter
  assert.equal(mut(/(async planFound[^]{0,400}?)if\(([\w$]+)\.some\(([\w$]+)=>([\w$]+)\(\3\.ref\)===([\w$]+)\)\)throw/, "$1if(!1)throw").held, false, "a held index taken");
  assert.equal(mut(/if\(([\w$]+)%8===([\w$]+)\.lane\)\{let ([\w$]+)=await \2\.get\(`counters`/, "if(!1){let $3=await $2.get(`counters`").counter, false, "the counter never read");
  assert.equal(mut(/\|\|!\(([\w$]+)\.next>([\w$]+)\)\)throw Error\(`deposit index/, "||!($1.next>=$2))throw Error(`deposit index").counter, false, "the counter's own index taken");
  // the found mark left out of planDeposit's one unfunded index
  assert.equal(mut(/&&([\w$]+)\.state===`PLANNED`&&!([\w$]+)\.has\(([\w$]+)\(\1\.ref\)\)(&&![\w$]+\.has\(\3\(\1\.ref\)\))?\);if/, "&&$1.state===`PLANNED`$4);if").funded, false, "a found note counted as the unfunded index");
  // step 5's found and the carry's hand-off
  assert.equal(mut(/\{s:([\w$]+),i:([\w$]+),amounts:([\w$]+)\}\)\}finally/, "{s:$1,i:$2,amounts:[$3[0],$3[0]]})}finally").wired, false, "one balance handed as both");
  assert.equal(mut(/\.has\(([\w$]+)\.i\)\|\|\(([\w$]+)=>[\w$]+\.found\([^)]*\)\),/, ".has($1.i),").wired, false, "a U_X with no note named, never written");
  assert.equal(mut(/try\{await ([\w$]+)\(\[([\w$]+),([\w$]+)\]\)\}catch/, "try{void 0}catch").wired, false, "carried with no note written");
});
