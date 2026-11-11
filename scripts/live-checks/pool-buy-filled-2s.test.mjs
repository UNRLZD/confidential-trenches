// node --test scripts/live-checks/pool-buy-filled-2s.test.mjs: the live check replays its recorded answers
// (pool-buy-filled-2s.answers.json). good: recorded from the testnet build of card
// signpage-throttled-read-is-not-asked-again-at-once (the back-off on the wallet's one rule with the buy's bounds, every
// failed read slowing the pace and only a whole round putting it back, the read-back held within the blockhash's life,
// the settle behind both RPCs' finalized slot, the gap waited, the gate's bound, the settle's own back-off): PASS. bad:
// the testnet build of main 2736dbef (a fixed second, the settle every round): FAIL. Planted on the good one, each FAIL
// with its line: a read-back wait of a fixed second or one not held to the blockhash's life; a failed read that does not
// slow, or the pace back after one; the gate gone, its bound gone, the wait every slot, no back-off after an unspent
// settle, no slow-down on a failed finalized read, the pace back after a round with a failure or never; the settle asked
// before the gate too; the back-off off the rule, the failure count gone, no back-off on a settle that throws. Planted on
// the rule, the bounds and the life (pool-buy-filled-2s.excerpt.txt, read from the same build): no Retry-After cap, no
// finite guard, another first pause, another most, another Retry-After most, another life. Another /app.js, no pin. No
// pool send: PASS with its note.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-buy-filled-2s.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-buy-filled-2s.answers.json", import.meta.url), "utf8"));
const EXCERPT = readFileSync(new URL("./pool-buy-filled-2s.excerpt.txt", import.meta.url), "utf8");
const PACE = "BAD the bundle's read-back has no pace of a slot (400 ms) that any failed read or a thrown settle doubles, on the one rule (a pause doubling to 8 s, a Retry-After when longer, at most 10 s, and finite)";
const LOOP = "BAD the bundle's finality wait is not the rule (the settle only once both RPCs' finalized slot reaches the transaction's or the gate's bound is past, held to those slots; the gap waited out; a failed read slowing the pace and only a round that went through putting it back; a settle that found no spend asked again at its doubling wait): it lists every mark of the pool before the chain can answer it, or every slot";
const SLOW = "BAD the bundle's read-back does not slow on every failed read (a 5xx as a 429), or puts the pace back after one that failed: a provider that is down is asked again at a slot's pace";
const LIFE = "BAD the bundle's read-back wait is not held within the blockhash's life (90 s): a grown pause may run past it";
/** The recorded good answer's bundle as far as the check reads it: the excerpt, then sendAndSettle. */
const JS = `${EXCERPT}${ANSWERS.good.head}${ANSWERS.good.stretch}`;

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

test("the excerpt with the recorded stretches reads as the recorded good answer (the pool send's address aside)", () => {
  const { index, sha384, poolSend, ...rest } = facts(ANSWERS.good.index, JS);
  const { index: i, sha384: h, poolSend: s, ...want } = ANSWERS.good;
  assert.deepEqual(rest, want);
});

const CASES = [
  ["a read-back wait of a fixed second", "stretch", "n>0&&await h(L(_))", "n>0&&await h(1e3)", "BAD the bundle's read-back wait is not its pace (1e3, ee): a fixed wait asks a throttled provider again at once"],
  ["a read-back wait not held to the blockhash's life", "stretch", "n>0&&await h(L(_))", "n>0&&await h(_)", "BAD the bundle's read-back wait is not its pace (_, ee): a fixed wait asks a throttled provider again at once"],
  ["a failed read-back that slows only on a 429", "stretch", ".catch(e=>(r=!0,y(e),[", ".catch(e=>(r=!0,e instanceof Ly&&y(e),[", SLOW],
  ["the pace back after a failed read-back", "stretch", "r||(_=400),I=", "_=400,I=", SLOW],
  ["the finality gate gone", "stretch", "if(r>0&&i>0){_=400,ee=Math.max(_,Math.min(r*400,EV,i));continue}", "", LOOP],
  ["the gate's bound gone", "stretch", "if(r>0&&i>0)", "if(r>0)", LOOP],
  ["the finality wait every slot, not the gap", "stretch", "ee=Math.max(_,Math.min(r*400,EV,i))", "ee=_", LOOP],
  ["an unspent settle asked again at the pace", "stretch", "if(a===!1&&(x=g(x,null)),!a){_=400,ee=x;continue}", "if(!a)continue", LOOP],
  ["a failed finalized read that does not slow", "stretch", "catch(e){y(e),ee=_;continue}", "catch(e){ee=_;continue}", LOOP],
  ["the pace back after a round with a failed read", "stretch", "v===o&&(_=400),ee=_}", "_=400,ee=_}", LOOP],
  ["no pace back after a whole round", "stretch", "v===o&&(_=400),ee=_}", "ee=_}", LOOP],
  ["the settle asked before the gate too", "stretch", "let R=f(),ee=_;", "await C();let R=f(),ee=_;", "BAD the bundle asks the settle 2 times past the read-back: once, behind the finality gate, is the rule"],
  ["the back-off off the rule", "head", "g=(e,t)=>nV(e,t instanceof Ly?t.afterMs:null,DV)", "g=(e,t)=>Math.min(e*2,8e3)", PACE],
  ["no failure count", "head", "y=e=>void(v++,_=g(_,e))", "y=e=>void(_=g(_,e))", PACE],
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

const RULE_CASES = [
  ["no Retry-After cap", "Math.min(t,n.afterMaxMs)", "t", PACE],
  ["no finite guard on the Retry-After", "Number.isFinite(t)&&t>0", "t>0||t!==t", PACE],
  ["another first pause", "firstMs:400,", "firstMs:1e3,", PACE],
  ["another most", "EV=8e3,", "EV=6e4,", PACE],
  ["another Retry-After most", "maxMs:EV,afterMaxMs:1e4", "maxMs:EV,afterMaxMs:6e4", PACE],
  ["another blockhash life", "CV=9e4,", "CV=9e5,", LIFE],
];
for (const [name, from, to, line] of RULE_CASES) {
  test(`planted on the rule, the bounds or the life, ${name}: FAIL, that fact named`, () => {
    assert.ok(EXCERPT.includes(from), "the excerpt holds the planted text");
    const f = facts(ANSWERS.good.index, JS.replace(from, to));
    const v = judge({ ...f, sha384: ANSWERS.good.sha384, poolSend: true });
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
