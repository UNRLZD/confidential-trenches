// node --test scripts/live-checks/one-balance-buys-on-every-chain.test.mjs: the live check replays its recorded answers
// (one-balance-buys-on-every-chain.answers.json). good: this card's SIGN_HOST build: PASS. liveBefore: SIGN_HOST as
// served before this card: FAIL, every mark named. Planted on the good one: another script, no pin, each mark taken
// away: each FAIL; and each mark's minified line as this card's build spells it, changed so its rule no longer holds:
// each FAIL. The good answer is re-read from the build at 55538dc73 on (a tap reads its venue only when Cash or a
// move on its way can add to it).
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

test("recorded answer partOne (part 1's build, a0bd91187, before pool.move): FAIL, poolMove alone named", () => {
  assert.deepEqual(judge(ANSWERS.partOne).lines, [`BAD ${SAYS.poolMove}`]);
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
  "let s=await o.any()?await o.tapMax(i):n.amount;if(s<n.amount&&await o.need(n.amount-s)){try{r?.route?.({move:`cash`})}catch{}}",
  "return e!==null&&`result`in e&&n!==null?{...e,result:{...e.result,with_cash:n}}:e;",
  "return i(Th[0],Th[1])?`current`:i(1,14)?`1.14`:i(1,13)?`1.13`:`1.4`}",
  "Gh=(e,t)=>{if(typeof t!=`object`||!t||e!==`pool.buy.dry`)return t;let{with_cash:n,...r}=t;return r};",
  "x=`1.15`",
  'var zz=e=>[{step:`vault_out`,chain:`near`},{step:`intents`,chain:e},{step:`pool_in`,chain:e}];',
  'function Uz(e){return{"pool.move":(t,n)=>{let r=Hz(t);if(`error`in r)return r;return r},"pool.move.dry":t=>{let n=Hz(t);return n}}}',
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
    // the tap read when nothing can add to it is skipped the other way round: a tap with Cash never read
    ["tap", JS.replace("await o.any()?await o.tapMax(i):n.amount", "await o.any()?n.amount:await o.tapMax(i)")],
    // no with_cash in the dry answer
    ["max", JS.replace(",with_cash:n}", "}")],
    // kit-v1.14 read in full, or with_cash never stripped
    ["level", JS.replace("i(1,14)?`1.14`:", "")],
    ["level", JS.replace("let{with_cash:n,...r}=t;return r", "return t")],
    ["version", JS.replace("x=`1.15`", "x=`1.14`")],
    // pool.move not checked before the mover, no dry of its own, or a route other than the paper's
    ["poolMove", JS.replace("if(`error`in r)return r;return r", "return r")],
    ["poolMove", JS.replace('"pool.move.dry":t=>', '"pool.move.x":t=>')],
    ["poolMove", JS.replace("{step:`intents`,chain:e},", "")],
    ["poolMove", JS.replace("{step:`pool_in`,chain:e}", "{step:`pool_in`,chain:`base`}")],
  ];
  for (const [mark, js] of cuts) {
    assert.notEqual(js, JS, `${mark}: the cut changed nothing`);
    assert.deepEqual(judge(facts(INDEX(js), js)).lines, [`BAD ${SAYS[mark]}`], `${mark}: ${js.slice(0, 80)}`);
  }
});

test("the tap as each build spells it: before any() (15b7ae910), with any() (part 1), and with the move op told (pool.move): PASS; the op one never asking the mover, or telling another op: FAIL", () => {
  const forms = [
    "let s=await o.tapMax(i);if(s<n.amount&&await o.need(n.amount-s)){try{r?.route?.({move:`cash`})}catch{}}",
    "let s=await o.any()?await o.tapMax(i):n.amount;if(s<n.amount&&await o.need(n.amount-s)){try{r?.route?.({move:`cash`})}catch{}}",
    "let s=await o.any()?await o.tapMax(i):n.amount,c=s<n.amount?await o.need(n.amount-s):null;if(c!==null){try{r?.route?.({move:`cash`,op:c})}catch{}}",
  ];
  for (const f of forms) assert.equal(facts("", f).tap, true, f);
  const op = forms[2];
  assert.equal(facts("", op.replace("await o.need(n.amount-s)", "null")).tap, false);
  assert.equal(facts("", op.replace("op:c})", "op:s})")).tap, false);
});
