// node --test scripts/live-checks/signpage-error-after-timeout.test.mjs: the live check replays its recorded answers
// (signpage-error-after-timeout.answers.json). good: this card's SIGN_HOST build, the api posting a trade kind's end as
// progress after its answer: PASS. bad: main 79701e4's build: FAIL. badM1..badM3: this card's build planted (buy out of
// the trade set; no refused for a refusal; the Running branch not handing the verdict to give): each FAIL. liveBefore:
// SIGN_HOST before this card's deploy: FAIL. Planted on the good one: another /app.js, no pin, a kind or an end stage
// missing, the rule not read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./signpage-error-after-timeout.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-error-after-timeout.answers.json", import.meta.url), "utf8"));
const NONE = "BAD the bundle does not post a trade kind's end as progress after its answer: a trade refused past the client's 10 s leaves the app's button stuck";

test("recorded good answer: this card's build posts a trade kind's end as progress after its answer: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
  assert.deepEqual(ANSWERS.good.kinds, ["buy", "pool.buy", "pool.sell", "pool.deposit"]);
});

for (const [k, line] of [
  ["bad", NONE],
  ["badM1", "BAD the bundle's trade kinds whose end goes out as progress miss buy"],
  ["badM2", NONE],
  ["badM3", NONE],
  ["liveBefore", NONE],
]) {
  test(`recorded bad answer ${k}: FAIL, that fact named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [line]);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  assert.equal(judge({ ...g, kinds: ["buy", "pool.buy", "pool.sell"] }).ok, false, "pool.deposit missing");
  assert.equal(judge({ ...g, kinds: null }).ok, false, "the set not read");
  assert.equal(judge({ ...g, ends: ["filled", "part_filled", "not_landed"] }).ok, false, "refused missing");
  for (const k of ["running", "rule"]) assert.equal(judge({ ...g, [k]: null }).ok, false, `${k} not read`);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  const js = "ks=new Set([`buy`,`pool.buy`,`pool.sell`,`pool.deposit`]),es=new Set([`filled`,`part_filled`,`not_landed`,`refused`]);if(h&&`running`in h){t.set(u,{sha:d,answer:null});let e=ks.has(l.type);h.after.catch(()=>{}).then(()=>s(u,d,h.answer(),p,e));return}if(s){let e=c?c.result.stage:l===`id_reused`?null:`refused`;typeof e==`string`&&es.has(e)&&!d.includes(e)&&o(e)}";
  const f = facts("", js);
  assert.deepEqual([f.kinds, f.ends], [["buy", "pool.buy", "pool.sell", "pool.deposit"], ["filled", "part_filled", "not_landed", "refused"]]);
  assert.equal(facts("", js.replace("`id_reused`?null:`refused`", "`id_reused`?null:null")).rule, null);
  assert.equal(facts("", js.replace(",p,e))", ",p))")).running, null);
});

test("the facts read from a bundle of card kit-frame-version's shape (the kind read once and handed to give first)", () => {
  const js = "ks=new Set([`buy`,`pool.buy`,`pool.sell`,`pool.deposit`]);n.set(f,[]);let _=d.type,v=fl(e,d,{id:f,sha:p,progress:h,route:g});if(v&&`running`in v){t.set(f,{sha:p,kind:_,answer:null});let e=ks.has(_);v.after.catch(()=>{}).then(()=>l(_,f,p,v.answer(),h,e));return}";
  const f = facts("", js);
  assert.deepEqual(f.kinds, ["buy", "pool.buy", "pool.sell", "pool.deposit"]);
  // the verdict not handed to give, or the set asked of another value than the request's kind: not read
  assert.equal(facts("", js.replace(",h,e))", ",h))")).running, null);
  assert.equal(facts("", js.replace("ks.has(_)", "ks.has(x)")).running, null);
  assert.equal(facts("", js.replace("l(_,f,p,", "l(x,f,p,")).running, null);
});
