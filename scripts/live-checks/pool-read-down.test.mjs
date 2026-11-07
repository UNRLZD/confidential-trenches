// node --test scripts/live-checks/pool-read-down.test.mjs: the live check replays its recorded answers
// (pool-read-down.answers.json). good: this card's SIGN_HOST build, every failed provider read answered down: PASS.
// bad: main 2badbf7b's build (release-47): FAIL. liveBefore: SIGN_HOST before this card's deploy (release-51, the same files as release-47): FAIL.
// Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-read-down.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-read-down.answers.json", import.meta.url), "utf8"));
const NO_KINDS = "BAD a sell whose decimals read fails on one provider is refused not_allowed: the app takes it as a no";
const NO_FLOWS = "BAD a pool buy, sell or deposit whose provider read fails before signing is not answered down: the app takes it as a no";
const NO_WIRE = "BAD a deposit quote whose read throws is refused not_allowed: the app takes it as a no";
const NO_REFERENCE = "BAD a pool trade's reference read that fails is answered quote_check_failed: a provider's outage shows as a price check";
const NO_SENT = "BAD a pool deposit whose read fails after its send is answered failed: the app shows a deposit that may land as failed";
const NO_TRADE = "BAD a vault buy whose reference read fails before signing is not answered down: the app takes it as a no";

test("recorded good answer: this card's build answers every failed provider read down: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, each path named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [NO_KINDS, NO_FLOWS, NO_WIRE, NO_REFERENCE, NO_SENT, NO_TRADE]);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, kinds: false }).lines, [NO_KINDS]);
  assert.deepEqual(judge({ ...g, flows: 2 }).lines, [NO_FLOWS]);
  assert.deepEqual(judge({ ...g, wire: false }).lines, [NO_WIRE]);
  assert.deepEqual(judge({ ...g, references: 1 }).lines, [NO_REFERENCE]);
  assert.deepEqual(judge({ ...g, sent: false }).lines, [NO_SENT]);
  assert.deepEqual(judge({ ...g, trade: 1 }).lines, [NO_TRADE]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  const js =
    "RT=Object.freeze({error:`not_allowed`}),zT=Object.freeze({error:`down`});" +
    "return e instanceof jC?{error:e.code}:!a&&e instanceof Uf?{error:`down`}:{error:`failed`};" +
    "if(!f&&e instanceof Uf)return{error:`down`};" +
    "!o&&e instanceof Uf?{error:`down`}:0;" +
    "(async()=>{})().catch(()=>{n={error:`down`}});" +
    "throw Error(`the two providers are the same provider: a reference must never rest on one provider's word`);" +
    "throw Error(`the two providers are the same provider: a reference must never rest on one provider's word`);" +
    "if(s.length)return{stage:`part_filled`,txs:s};if(c.length)return{stage:`sent`,txs:c};" +
    "if(!d)return await l(e instanceof cT?`not_armed`:g&&!_?`down`:`failed`);" +
    "if(!d)return l(g&&!_?`down`:oT(f))";
  const f = facts("", js);
  assert.deepEqual({ ...f, sha384: null }, { index: "", sha384: null, kinds: true, flows: 3, wire: true, references: 2, sent: true, trade: 2 });
  assert.equal(facts("", js.replace("zT=Object.freeze({error:`down`})", "zT=Object.freeze({error:`not_allowed`})")).kinds, false);
  assert.equal(facts("", js.replace("if(!f&&e instanceof Uf)return{error:`down`};", "")).flows, 2);
  assert.equal(facts("", js.replace("n={error:`down`}", "n={error:`not_allowed`}")).wire, false);
  assert.equal(facts("", js.replace(/throw Error\([^)]*\);/, "")).references, 1);
  assert.equal(facts("", js.replace("if(c.length)return{stage:`sent`,txs:c};", "")).sent, false);
  assert.equal(facts("", js.replace("g&&!_?`down`:oT(f)", "oT(f)")).trade, 1);
  // card pool-answer-unknown's forms: the sends of notes still open (a call), and down only in place of the kit's failed
  const next = js.replace("if(c.length)return{stage:`sent`,txs:c};", "if(u().length)return{stage:`sent`,txs:u()};").replace("g&&!_?`down`:oT(f)", "g&&!_&&w===`failed`?`down`:w");
  assert.deepEqual([facts("", next).sent, facts("", next).trade], [true, 2]);
  assert.equal(facts("", next.replace("if(u().length)return{stage:`sent`,txs:u()};", "")).sent, false);
  assert.equal(facts("", next.replace("g&&!_&&w===`failed`?`down`:w", "w")).trade, 1);
});
