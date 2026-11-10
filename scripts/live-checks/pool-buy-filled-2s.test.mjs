// node --test scripts/live-checks/pool-buy-filled-2s.test.mjs: the live check replays its recorded answers
// (pool-buy-filled-2s.answers.json). good: this card's testnet build (the read-back at a slot's pace, the settle behind
// both RPCs' finalized slot, the gap waited, the gate's bound, the settle's own back-off): PASS. bad: the testnet build
// of main 2736dbef (a fixed second, the settle every round): FAIL. Planted on the good one, each FAIL with its line: a
// read-back wait of a fixed second; the gate gone, its bound gone, the wait every slot, no back-off after an unspent
// settle, no pace back after a read; the settle asked before the gate too; no Retry-After cap, no finite guard, no
// back-off on a settle that throws; another /app.js, no pin. No pool send: PASS with its note.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./pool-buy-filled-2s.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-buy-filled-2s.answers.json", import.meta.url), "utf8"));
const PACE = "BAD the bundle's read-back has no pace of a slot (400 ms) that only a throttle or a thrown settle doubles, by a back-off capped at its own most and the Retry-After's, and finite";
const LOOP = "BAD the bundle's finality wait is not the rule (the settle only once both RPCs' finalized slot reaches the transaction's or the gate's bound is past, held to those slots; the gap waited out; the pace back after a read; a settle that found no spend asked again at its doubling wait): it lists every mark of the pool before the chain can answer it, or every slot";

test("recorded good answer: this card's testnet build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: main 2736dbef's testnet build waits a fixed second and asks the settle with no gate: FAIL, that fact named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [PACE]);
});

const CASES = [
  ["a read-back wait of a fixed second", "stretch", "n>0&&await h(_)", "n>0&&await h(1e3)", "BAD the bundle's read-back wait is not its pace (1e3, R): a fixed wait asks a throttled provider again at once"],
  ["the finality gate gone", "stretch", "if(r>0&&i>0){R=Math.max(_,Math.min(r*400,_V,i));continue}", "", LOOP],
  ["the gate's bound gone", "stretch", "if(r>0&&i>0)", "if(r>0)", LOOP],
  ["the finality wait every slot, not the gap", "stretch", "R=Math.max(_,Math.min(r*400,_V,i))", "R=_", LOOP],
  ["an unspent settle asked again at the pace", "stretch", "if(a===!1&&(x=g(x,null)),!a){R=x;continue}", "if(!a)continue", LOOP],
  ["no pace back after a read", "stretch", "_=400,R=_;let r=", "R=_;let r=", LOOP],
  ["the settle asked before the gate too", "stretch", "let L=f(),R=_;", "await C();let L=f(),R=_;", "BAD the bundle asks the settle 2 times past the read-back: once, behind the finality gate, is the rule"],
  ["no Retry-After cap", "head", "Math.min(n,vV)", "n", PACE],
  ["no finite guard on the Retry-After", "head", "Number.isFinite(n)&&n>0", "n>0||n!==n", PACE],
  ["no back-off on a settle that throws", "head", "catch(e=>(x=g(x,e),Promise.reject(e)))", "catch(e=>Promise.reject(e))", PACE],
];
for (const [name, field, from, to, line] of CASES) {
  test(`planted on the good answer, ${name}: FAIL, that fact named`, () => {
    assert.ok(ANSWERS.good[field].includes(from), "the recorded answer holds the planted text");
    const v = judge({ ...ANSWERS.good, [field]: ANSWERS.good[field].replace(from, to) });
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [line]);
  });
}

test("planted: another /app.js than index.html pins, or no pin: FAIL", () => {
  assert.deepEqual(judge({ ...ANSWERS.good, sha384: `sha384-${createHash("sha384").update("x").digest("base64")}` }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...ANSWERS.good, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
});

test("planted: a build that sends no pool transaction: PASS with its note", () => {
  const v = judge({ ...ANSWERS.good, poolSend: false });
  assert.equal(v.ok, true);
  assert.deepEqual(v.lines, ["NOTE the bundle sends no pool transaction (no pinned pool on this build)"]);
});
