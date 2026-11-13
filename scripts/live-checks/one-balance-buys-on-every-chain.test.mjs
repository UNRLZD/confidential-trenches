// node --test scripts/live-checks/one-balance-buys-on-every-chain.test.mjs: the live check replays its recorded answers
// (one-balance-buys-on-every-chain.answers.json). good: this card's SIGN_HOST build: PASS. liveBefore: SIGN_HOST as
// served before this card: FAIL, every mark named. Planted on the good one: another script, no pin, each mark taken
// away: each FAIL; and each mark's minified line as this card's build spells it, changed so its rule no longer holds:
// each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, SAYS } from "./one-balance-buys-on-every-chain.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./one-balance-buys-on-every-chain.answers.json", import.meta.url), "utf8"));
const ALL = Object.values(SAYS).map((s) => `BAD ${s}`);

test("recorded good answer: this card's SIGN_HOST build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded answer liveBefore (SIGN_HOST before this card): FAIL, every mark named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [i, k] of Object.keys(SAYS).entries()) assert.deepEqual(judge({ ...g, [k]: false }).lines, [ALL[i]], k);
  assert.equal(judge(null).ok, false);
});

// The minified lines as this card's build spells them (packages/signpage/scripts/build-app.mjs, mainnet), each changed
// so its rule no longer holds.
const JS = [
  "Ox=/^[0-9a-f]{64}$/,Oz=/^[0-9a-f]{64}$/;",
  "let u=`cash/${n}/${e.now()}`,d={error:`not_allowed`};",
  "if(`error`in d||!Oz.test(d.address)||d.amountIn!==c||d.minOut<o)return a>0n;",
  "let s=await o.tapMax(i);if(s<n.amount&&await o.need(n.amount-s)){try{r?.route?.({move:`cash`})}catch{}}",
  "return e!==null&&`result`in e&&n!==null?{...e,result:{...e.result,with_cash:n}}:e;",
  "return i(Th[0],Th[1])?`current`:i(1,14)?`1.14`:i(1,13)?`1.13`:`1.4`}",
  "Gh=(e,t)=>{if(typeof t!=`object`||!t||e!==`pool.buy.dry`)return t;let{with_cash:n,...r}=t;return r};",
  "x=`1.15`",
].join("");
const INDEX = (js) => `<script type="module" src="/app.js" integrity="${facts("", js).sha384}"></script>`;

test("the minified lines this card's build spells: PASS; each one changed so its rule no longer holds: FAIL, that mark named", () => {
  assert.deepEqual(judge(facts(INDEX(JS), JS)).lines, []);
  const cuts = [
    // the vault pays a deposit address that is not a NEAR implicit account, another amount, or a min out under the shortfall
    ["move", JS.replace("!Oz.test(d.address)||", "")],
    ["move", JS.replace("d.amountIn!==c||", "")],
    ["move", JS.replace("||d.minOut<o", "")],
    // the rule tested is not the implicit one
    ["move", JS.replace("Oz=/^[0-9a-f]{64}$/", "Oz=/^.*$/")],
    // no follow op named for the move
    ["move", JS.replace("`cash/${n}/${e.now()}`", "`x`")],
    // the tap never asks the mover, asks it for another amount, or never tells the app
    ["tap", JS.replace("await o.need(n.amount-s)", "!1")],
    ["tap", JS.replace("o.need(n.amount-s)", "o.need(n.amount)")],
    ["tap", JS.replace("r?.route?.({move:`cash`})", "0")],
    // no with_cash in the dry answer
    ["max", JS.replace(",with_cash:n}", "}")],
    // kit-v1.14 read in full, or with_cash never stripped
    ["level", JS.replace("i(1,14)?`1.14`:", "")],
    ["level", JS.replace("let{with_cash:n,...r}=t;return r", "return t")],
    ["version", JS.replace("x=`1.15`", "x=`1.14`")],
  ];
  for (const [mark, js] of cuts) {
    assert.notEqual(js, JS, `${mark}: the cut changed nothing`);
    assert.deepEqual(judge(facts(INDEX(js), js)).lines, [`BAD ${SAYS[mark]}`], `${mark}: ${js.slice(0, 80)}`);
  }
});
