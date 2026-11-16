// node --test scripts/live-checks/sell-box-says-quoting.test.mjs: the live check replays its recorded answers
// (sell-box-says-quoting.answers.json). good: this card's APP_HOST build: PASS. liveBefore: APP_HOST as served before
// this card: FAIL, every mark named. Planted on the good one: another script, no pin, each mark taken away: each FAIL;
// and the minified lines as this card's build spells them, each changed so its rule no longer holds: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, marks, SAYS } from "./sell-box-says-quoting.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sell-box-says-quoting.answers.json", import.meta.url), "utf8"));
const ALL = Object.values(SAYS).map((s) => `BAD ${s}`);

test("recorded good answer: this card's APP_HOST build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded answer liveBefore (APP_HOST before this card): FAIL, every mark named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD APP_HOST's served script is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD APP_HOST's index.html pins no script"]);
  for (const [i, k] of Object.keys(SAYS).entries()) assert.deepEqual(judge({ ...g, [k]: false }).lines, [ALL[i]], k);
  assert.equal(judge(null).ok, false);
});

// The minified lines as this card's build spells them (pnpm --filter terminal build), each changed so its rule no
// longer holds.
const TAG = "var t_=(e,t)=>t===null?null:`${e}|${t}`;";
const RULE = "function n_(e,t,n,r){return!e&&r!==null&&r===t_(t,n)}";
const WIRED = ";let ee=x?mm(x.out_usd):null,j=n_(ee!==null,e.token,b,k);";
const CELL = '(0,U.jsx)(`span`,{"data-pending":A||void 0,"data-testid":`sell-receive`,children:ee===null?j?(0,U.jsx)(mC,{id:`quoting`}):`—`:`≈ ${h_(ee)}`})';
const JS = [TAG, RULE, WIRED, CELL].join("");

test("the minified lines: all four PASS; each changed so its rule no longer holds FAILs", () => {
  assert.deepEqual(marks(JS), { rule: true, wired: true, drawn: true });
  // the tag no longer the token and the amount
  assert.deepEqual(marks(JS.replace("`${e}|${t}`", "`${e}`")), { rule: false, wired: false, drawn: false });
  // Quoting while a number shows
  assert.deepEqual(marks(JS.replace("return!e&&", "return ")), { rule: false, wired: false, drawn: false });
  // Quoting for any ask, not this token's and amount's
  assert.deepEqual(marks(JS.replace("r===t_(t,n)", "r!==null")), { rule: false, wired: false, drawn: false });
  // the rule read without the number
  assert.deepEqual(marks(JS.replace("n_(ee!==null,", "n_(!1,")).drawn, false);
  // the cell: the dash in Quoting's place, or Quoting with a number shown
  assert.deepEqual(marks(JS.replace("j?(0,U.jsx)(mC,{id:`quoting`}):`—`", "`—`")).drawn, false);
  assert.deepEqual(marks(JS.replace("{id:`quoting`}", "{id:`receive`}")).drawn, false);
  assert.deepEqual(marks(JS.replace("ee===null?j?", "ee===null?!0?")).drawn, false);
});
