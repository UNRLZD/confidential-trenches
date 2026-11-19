// node --test scripts/live-checks/sol-buy-takes-the-best-venue-it-can-trade.test.mjs: the live check replays its recorded
// answers (sol-buy-takes-the-best-venue-it-can-trade.answers.json). good: this card's SIGN_HOST build: PASS. before:
// main e1995d679's build (what SIGN_HOST serves at the release-184 cut), before this card: FAIL, every mark named.
// Planted on the good one: another script, no pin, each mark taken away: each FAIL; and each mark's minified line as
// this card's build spells it, changed so its rule no longer holds: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, SAYS } from "./sol-buy-takes-the-best-venue-it-can-trade.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sol-buy-takes-the-best-venue-it-can-trade.answers.json", import.meta.url), "utf8"));
const ALL = Object.values(SAYS).map((s) => `BAD ${s}`);

test("recorded good answer: this card's SIGN_HOST build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded answer before (main e1995d679's build): FAIL, every mark named", () => {
  const v = judge(ANSWERS.before);
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

// The minified lines as this card's build spells them (packages/signpage/scripts/build-app.mjs, mainnet).
const DECIDE =
  "function yV(e,t,n){if(!Number.isInteger(n)||n<0||n>=1e4)return{error:`quote_check_failed`};let r=[...e?.pools??[],...e?.shallow??[]].filter(e=>wm.includes(e.venue));if(r.length===0)return{error:`quote_check_failed`};let i=(e=>e.reduce((e,t)=>e===null||t.expectedOut>e.expectedOut?t:e,null))(r.filter(e=>t.has(e.venue)));if(i===null)return{error:`venue_not_pinned`};let a=e.expectedOut;return i.expectedOut*10000n<a*BigInt(1e4-n)?{error:`below_reference`}:{pool:i}}";
const TAP = "k=yV(O,new Set(y.keys()),t.slippageBps);if(`error`in k)return CU(k.error);let A=k.pool,j=A.venue";
const DRY =
  "let o=t.slippage_bps===void 0?0:t.slippage_bps;if(typeof o!=`number`)return{error:`not_allowed`};let c=t.token,l=i!==null&&i>0n?gV(s,{side:`buy`,token:c,amount:i},void 0,{early:e.early===!0}).then(e=>({ref:e}),()=>null):null,u=await a(s,c,r);if(`error`in u&&u.error===`not_funded`)return u;let d=l===null?null:await l,f=d===null?null:yV(d.ref,vV(e.tables??pk.mainnet??{}),o);if(f!==null&&`error`in f)return f;";
const QUOTE =
  "j=[...O?.pools??[],...O?.shallow??[]].find(e=>e.address===A&&e.venue===r.kind),M=Tm(O,a.slot);if(D!==i.spend)c(`QUOTE`,`x`);else{let e=j.expectedOut*BigInt(1e4-k)/10000n;j.expectedOut*10000n<O.expectedOut*BigInt(1e4-k)?c(`QUOTE`,`the venue's E ${j.expectedOut} is under the market's`):0}";
const all = (over = {}) => [over.decide ?? DECIDE, over.tap ?? TAP, over.dry ?? DRY, over.quote ?? QUOTE].join(";");

test("the minified lines as this card's build spells them pass; each rule changed fails its own mark", () => {
  const f = (js) => facts("", js);
  assert.deepEqual({ ...f(all()), index: undefined, sha384: undefined }, { index: undefined, sha384: undefined, decide: true, tap: true, dry: true, quote: true });
  // the decision on the set alone (no pool under the depth cutoff): a pinned venue's shallow pool is never found
  assert.equal(f(all({ decide: DECIDE.replace(",...e?.shallow??[]]", "]") })).decide, false);
  // no market bound: the best pinned pool always taken
  assert.equal(f(all({ decide: DECIDE.replace("return i.expectedOut*10000n<a*BigInt(1e4-n)?{error:`below_reference`}:{pool:i}", "return{pool:i}") })).decide, false);
  // the pinned venues not asked: the best of every built venue, as e1995d679 picked
  assert.equal(f(all({ decide: DECIDE.replace("r.filter(e=>t.has(e.venue))", "r") })).decide, false);
  // the tap on a slippage of its own, or its refusal dropped
  assert.equal(f(all({ tap: TAP.replace("t.slippageBps", "0") })).tap, false);
  assert.equal(f(all({ tap: TAP.replace("if(`error`in k)return CU(k.error);", "") })).tap, false);
  // the tap on venues of its own, not the pinned tables it read
  assert.equal(f(all({ tap: TAP.replace("new Set(y.keys())", "new Set(wm)") })).tap, false);
  // the dry deciding nothing, or ignoring the ask's slippage
  assert.equal(f(all({ dry: DRY.replace("if(f!==null&&`error`in f)return f;", "") })).dry, false);
  assert.equal(f(all({ dry: DRY.replace(",o);if(f", ",0);if(f") })).dry, false);
  // the kit's QUOTE check with no market bound, or on the set alone
  assert.equal(f(all({ quote: QUOTE.replace("j.expectedOut*10000n<O.expectedOut*BigInt(1e4-k)?c(`QUOTE`,`the venue's E ${j.expectedOut} is under the market's`):0", "0") })).quote, false);
  assert.equal(f(all({ quote: QUOTE.replace(",...O?.shallow??[]]", "]") })).quote, false);
});
