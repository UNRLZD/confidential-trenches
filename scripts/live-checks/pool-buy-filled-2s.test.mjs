// node --test scripts/live-checks/pool-buy-filled-2s.test.mjs: the live check replays its recorded answers
// (pool-buy-filled-2s.answers.json). good: this card's testnet build (the read-back at a slot's pace, the settle behind
// both RPCs' finalized slot): PASS. bad: the testnet build of main 2736dbef (a fixed second, the settle every round):
// FAIL. Planted on the good one: a read-back wait of a fixed second, the gate gone, the finality wait every slot, the
// settle asked before the gate, another /app.js, no pin: each FAIL; no pool send: PASS with its note.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./pool-buy-filled-2s.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-buy-filled-2s.answers.json", import.meta.url), "utf8"));
const GATE = "if(F=Math.max(...n.map((e,t)=>(P[t]??0)-e)),F>0||!await x([n[0],n[1]]))continue;";
const WAIT = "t>0&&await h(Math.max(g,Math.min(F*400,_V))),F=0;let n;";

test("recorded good answer: this card's testnet build reads back at its pace and asks the settle only past the finality gate: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
  assert.ok(ANSWERS.good.stretch.includes(GATE) && ANSWERS.good.stretch.includes(WAIT), "the planted cases below edit the recorded gate");
});

test("recorded bad answer: main 2736dbef's testnet build waits a fixed second and asks the settle with no gate: FAIL, that fact named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["BAD the bundle's read-back has no pace of a slot (400 ms) that only a throttle or a thrown settle doubles"]);
});

const planted = (edit) => ({ ...ANSWERS.good, ...edit(ANSWERS.good) });
const CASES = [
  ["a read-back wait of a fixed second", (a) => ({ stretch: a.stretch.replace("n>0&&await h(g)", "n>0&&await h(1e3)") }), "BAD the bundle's read-back wait is not its pace (1e3): a fixed wait asks a throttled provider again at once"],
  ["the finality gate gone", (a) => ({ stretch: a.stretch.replace(GATE, "if(!await x())continue;") }), "BAD the bundle asks the settle with no gate on both RPCs' finalized slot reaching the transaction's: it lists every mark of the pool before the chain can answer it"],
  ["the finality wait every slot, not the gap", (a) => ({ stretch: a.stretch.replace(WAIT, "t>0&&await h(g),F=0;let n;") }), ["BAD the bundle's read-back wait is not its pace (g, g): a fixed wait asks a throttled provider again at once", "BAD the bundle asks the settle with no gate on both RPCs' finalized slot reaching the transaction's: it lists every mark of the pool before the chain can answer it"]],
  ["the settle asked before the gate too", (a) => ({ stretch: a.stretch.replace(WAIT, "await x();" + WAIT) }), "BAD the bundle asks the settle 2 times past the read-back: once, behind the finality gate, is the rule"],
];
for (const [name, edit, line] of CASES) {
  test(`planted on the good answer, ${name}: FAIL, that fact named`, () => {
    const v = judge(planted(edit));
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, Array.isArray(line) ? line : [line]);
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
