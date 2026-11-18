// node --test scripts/live-checks/dry-ask-joins-the-running-quote.test.mjs: the live check replays recorded answers
// (dry-ask-joins-the-running-quote.answers.json). bad: SIGN_HOST as read before this card, no join in its /app.js: FAIL,
// each fact named. good: this card's build, as SIGN_HOST serves it once deployed: PASS. Planted on the good one: each fact
// removed alone, a served /app.js that is not the pinned one, and no pin: FAIL. Each fact is also held to the minified
// shape it reads (this card's build's): the shape passes, and the same shape with the fact broken fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FACTS, FACT_NAMES, judge } from "./dry-ask-joins-the-running-quote.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./dry-ask-joins-the-running-quote.answers.json", import.meta.url), "utf8"));

test("recorded bad answer: SIGN_HOST before this card: FAIL, every fact named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, FACT_NAMES.map((f) => `BAD the served /app.js does not hold ${f}`));
});

test("recorded good answer: the pinned /app.js holds every fact: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("planted on the good answer: each fact removed alone FAILS, naming it; another /app.js or no pin FAILS", () => {
  const g = ANSWERS.good;
  for (const f of FACT_NAMES) {
    const v = judge({ ...g, app: { ...g.app, facts: { ...g.app.facts, [f]: false } } });
    assert.equal(v.ok, false, f);
    assert.deepEqual(v.lines, [`BAD the served /app.js does not hold ${f}`]);
    const { [f]: _gone, ...rest } = g.app.facts;
    assert.equal(judge({ ...g, app: { ...g.app, facts: rest } }).ok, false, `${f} missing`);
  }
  assert.ok(judge({ ...g, app: { ...g.app, sha384: "sha384-other" } }).lines.includes("BAD the served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD index.html pins no /app.js"));
});

// this card's build, as minified (packages/signpage/src/dry-join.ts and main.ts's kinds map)
const KEY = "function nme(e){let t=e=>Array.isArray(e)?e.map(t):typeof e==`object`&&e?Object.fromEntries(Object.keys(e).sort().map(n=>[n,t(e[n])])):e;return JSON.stringify(t(e))}";
const JOIN = "function D2(e){let t=new Map;return(n=>{let r=nme(n),i=t.get(r);if(i)return{running:!0,after:i.after,answer:i.answer};let a=e(n);if(!rme(a))return a;t.set(r,a);let o=()=>void(t.get(r)===a&&t.delete(r));return a.after.then(o,o),a})}";
const WIRED = '"pool.sell.dry":D2(e=>A(e)),"pool.buy.dry":D2(e=>x(e)),';
const GOOD = `${KEY}var rme=e=>typeof e==\`object\`&&!!e&&e.running===!0;${JOIN}${WIRED}`;
const BROKEN = {
  join_answers_from_the_running_quote: GOOD.replace("if(i)return{running:!0,after:i.after,answer:i.answer};", ""),
  key_is_every_field_sorted: GOOD.replace("Object.keys(e).sort()", "Object.keys(e)"),
  fresh_once_it_ends: GOOD.replace("return a.after.then(o,o),a", "return a"),
  buy_dry_joins: GOOD.replace('"pool.buy.dry":D2(e=>x(e))', '"pool.buy.dry":e=>x(e)'),
  sell_dry_joins: GOOD.replace('"pool.sell.dry":D2(e=>A(e))', '"pool.sell.dry":e=>A(e)'),
};

test("each fact holds on its minified shape and fails on the same shape with the fact broken", () => {
  assert.deepEqual(Object.keys(BROKEN).sort(), [...FACT_NAMES].sort());
  for (const f of FACT_NAMES) {
    assert.equal(FACTS[f](GOOD), true, `${f} holds on the build's shape`);
    assert.notEqual(BROKEN[f], GOOD, `${f}: the plant changed the shape`);
    assert.equal(FACTS[f](BROKEN[f]), false, `${f} fails when broken`);
  }
});
