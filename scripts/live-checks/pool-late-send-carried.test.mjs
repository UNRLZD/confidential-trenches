// node --test scripts/live-checks/pool-late-send-carried.test.mjs: the live check replays its recorded answers
// (pool-late-send-carried.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served before the
// card: FAIL, each fact named. Planted on the good one: another /app.js, no pin, each fact taken away: each FAIL.
// Planted in this tree's build: each rule broken in place: its fact false.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { facts, judge, WHY } from "./pool-late-send-carried.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-late-send-carried.answers.json", import.meta.url), "utf8"));

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
  const all = (x) => ({ window: x.window, wired: x.wired, plan: x.plan, carry: x.carry, near: x.near });
  assert.deepEqual(all(f(js)), { window: true, wired: true, plan: true, carry: true, near: true });
  const mut = (from, to) => {
    assert.equal([...js.matchAll(new RegExp(from.source, "g"))].length, 1, String(from));
    return f(js.replace(from, to));
  };
  // the window: no late on the pool's ids
  assert.equal(mut(/([\w$]+)!==null&&await ([\w$]+)\.late\(\1\);let/, "let").window, false, "no window kept");
  // step 7 never run, or run on an incomplete read, or step 5's found U_X read again
  assert.equal(mut(/([\w$]+)!==null&&([\w$]+)\.complete&&await ([\w$]+)\(/, "!1&&await $3(").wired, false, "never run");
  assert.equal(mut(/,\{ux:new Set\(([\w$]+)\.keys\(\)\),near:/, ",{ux:new Set,near:").wired, false, "step 5's U_X read again");
  // the plan: a kept lane left out, or its highest its notes' alone
  assert.equal(mut(/let ([\w$]+)=([\w$]+)\.get\(([\w$]+)\);if\(\1===void 0\)throw Error\(`lane/, "let $1=void 0;if($1===void 0)throw Error(`lane").plan, false, "a kept lane left out");
  assert.equal(mut(/=Math\.max\(([\w$]+)-168,/, "=Math.max(-1,").plan, false, "its highest its notes' alone");
  // the U_X: a note this device planned carried, no note written first, a failed read dropped
  assert.equal(mut(/if\(([\w$]+)!==void 0&&!\1\.found\)continue;(let [\w$]+=await [\w$]+\([\w$]+,[\w$]+\.chain,)/, "$2").carry, false, "an own planned note carried");
  assert.equal(mut(/,refund_id:([\w$]+)\.id\},([\w$]+)!==void 0\|\|\(([\w$]+)=>/, ",refund_id:$1.id},!0||($3=>").carry, false, "carried with no note written");
  assert.equal(mut(/\.retry\.push\(`\$\{([\w$]+)\} was not read \(/, ".held.slice(`${$1} was not read (").carry, false, "a failed read dropped");
  // NEAR: what an id holds not named as step 5 names it, a failed read taken as nothing
  assert.equal(mut(/:await ([\w$]+)\(async\(\)=>([\w$]+)\.held,\2\.id,/, ":[]||await $1(async()=>$2.held,$2.id,").near, false, "holdings not named");
  assert.equal(mut(/\?\[\{why:`was not read on NEAR \(\$\{([\w$]+)\.error\}\): read again`,retry:!0\}\]:/, "?[]:").near, false, "a failed read taken as nothing");
});
