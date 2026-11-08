// node --test scripts/live-checks/solana-teardown-cashback.test.mjs: the live check replays its recorded answers
// (solana-teardown-cashback.answers.json). good: this card's SIGN_HOST build, its teardown claiming owed cashback before
// a volume close, and planning around a claim that does not simulate: PASS. bad: main 3a57948a's build: FAIL. liveBefore: SIGN_HOST before this card's deploy: FAIL. Planted
// on the good one: another /app.js, no pin, each mark taken away: each FAIL; and planted bundles with a mark's line
// changed: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./solana-teardown-cashback.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./solana-teardown-cashback.answers.json", import.meta.url), "utf8"));
const ALL = Object.keys(MARKS).map((k) => `BAD the served bundle has no ${k}`);

test("recorded good answer: this card's build claims owed cashback before the volume close: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, every claim mark named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, ALL);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [i, k] of Object.keys(MARKS).entries()) assert.deepEqual(judge({ ...g, carries: { ...g.carries, [k]: false } }).lines, [ALL[i]]);
  assert.equal(judge(null).ok, false);
});

// The minified lines as the good build spells them, each changed so its rule no longer holds.
const JS = [
  "x=[37,58,35,126,190,53,228,197];y=[122,243,204,65,94,116,29,55];",
  "if(a.owner!==`Tk`||e.length!==Df||z.encode(e.subarray(0,32))!==t.mint||z.encode(e.subarray(32,64))!==t.uva)throw Error(`${i} is not the volume account's ${t.mint} account`);",
  "if(d&&!w.includes(d)){l.push(`${c}: close of ${e} before its claim in this frame`);continue}",
  "if(v.length!==3||v[1]?.key!==t||v[2]?.key!==t||!v[0]?.writable||!v[1]?.writable||!g(b[e-1],T)){l.push(`${c}: close of ${T.to} not right after its claim`);continue}",
  "function Nf(e){return e.ok||!e.plan||e.plan.claim.length===0||e.results.some(e=>!e.ok&&e.id!==`SIM`)?null:`its claim did not simulate: ${(e.results.find(e=>e.id===`SIM`)?.detail??``).slice(0,160)}`}",
  "s=await o(t),c=Nf(s.verdict);return c===null?s:o(jf(e,n,c),c)}",
  "if(t!==e.fromAmount-e.amount&&y.push(`${o}: ${e.from} holds ${t??`nothing read`} after the claim (want ${e.fromAmount-e.amount})`),e.unwrap)continue;",
].join("");
test("the facts read from a bundle; a planted line with its rule changed FAILs", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  const planted = [
    [JS.replace("[37,58,35,126,190,53,228,197]", "[37,58,35,126,190,53,228,198]"), 0],
    [JS.replace("[122,243,204,65,94,116,29,55]", "[122,243,204,65,94,116,29,56]"), 1],
    [JS.replace("||z.encode(e.subarray(32,64))!==t.uva", ""), 2],
    [JS.replace("if(d&&!w.includes(d))", "if(false)"), 3],
    [JS.replace("||!g(b[e-1],T)", ""), 4],
    [JS.replace("v[1]?.key!==t||", ""), 4],
    [JS.replace("||e.results.some(e=>!e.ok&&e.id!==`SIM`)", ""), 5],
    [JS.replace("e.plan.claim.length===0||", ""), 5],
    [JS.replace("return c===null?s:o(jf(e,n,c),c)", "return s"), 6],
    [JS.replace("o(jf(e,n,c),c)", "o(jf(e,n,c))"), 6],
    [JS.replace("if(t!==e.fromAmount-e.amount&&", "if(false&&"), 7],
  ];
  for (const [js, i] of planted) {
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [Object.keys(MARKS)[i]], js.slice(0, 80));
  }
});
