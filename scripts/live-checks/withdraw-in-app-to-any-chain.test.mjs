// node --test scripts/live-checks/withdraw-in-app-to-any-chain.test.mjs: the live check replays its recorded answers
// (withdraw-in-app-to-any-chain.answers.json). good: this card's APP_HOST build: PASS. bad (release 143's build) and
// liveBefore (APP_HOST before this card's deploy): FAIL, each fact named. Planted on the good one: each fact taken away
// FAILs. The marks are read from minified shapes as vite writes them, each planted here as written.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APP, facts, judge, read, SAYS } from "./withdraw-in-app-to-any-chain.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./withdraw-in-app-to-any-chain.answers.json", import.meta.url), "utf8"));
const ALL_BAD = [SAYS.poolRow, SAYS.hopDest, SAYS.addressOnArrival, SAYS.poolRowBare].map((s) => `BAD ${s}`);

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, each fact named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, ALL_BAD);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, scripts: 0 }).lines, [`BAD ${SAYS.scripts}`]);
  for (const k of ["poolRow", "hopDest", "addressOnArrival"]) assert.deepEqual(judge({ ...g, [k]: false }).lines, [`BAD ${SAYS[k]}`], k);
  assert.deepEqual(judge({ ...g, poolRowBare: true }).lines, [`BAD ${SAYS.poolRowBare}`]);
  assert.equal(judge(null).ok, false);
});

// the shapes as the build writes them (this card's dist, 17:52Z) and as release 143's did
const NOW_ROW = "if(e.kind===`pool-withdraw`)return f.includes(e.chain)?{to:`withdraw`,from:e.chain}:{to:`none`};";
const OLD_ROW = "if(e.kind===`pool-withdraw`)return f.includes(e.chain)?{to:`pool.withdraw`,params:{chain:e.chain}}:{to:`none`};";
const NOW_HOP = "return e.kind===`pool.withdraw`?{kind:`pool.withdraw`,params:{chain:e.chain,...o,...t===e.chain?{}:{dest:t}}}:{kind:`withdraw.open`,params:o}";
const NOT_HOP = "return e.kind===`pool.withdraw`?{kind:`pool.withdraw`,params:{chain:e.chain,...o}}:{kind:`withdraw.open`,params:o}";
const ARR = "function eL(e){return e.kind===`pool.withdraw`?Ev:[`near`]}";
const CHECK = "l=r.trim()===``?`empty`:eL(e).includes(t)&&tL(t,r)?`ok`:`bad`;";
const OLD_CHECK = "l=r.trim()===``?`empty`:tL(e,r)?`ok`:`bad`;";

test("the facts read from a bundle, as vite writes them", () => {
  assert.deepEqual(facts([NOW_ROW + NOW_HOP + ARR + CHECK]), { scripts: 1, poolRow: true, poolRowBare: false, hopDest: true, addressOnArrival: true });
  assert.deepEqual(facts([OLD_ROW + NOT_HOP + OLD_CHECK]), { scripts: 1, poolRow: false, poolRowBare: true, hopDest: false, addressOnArrival: false });
  // the other order of dest's ternary reads the same; a dest not tied to the pool's chain does not
  assert.equal(facts([NOW_HOP.replace("t===e.chain?{}:{dest:t}", "t!==e.chain?{dest:t}:{}")]).hopDest, true);
  assert.equal(facts([NOW_HOP.replace("t===e.chain?{}:{dest:t}", "t===e.chain?{}:{dest:e.chain}")]).hopDest, false);
  // the arrival check must be the arrivals function's, on the dest it fits the address to
  assert.equal(facts([ARR + CHECK.replace("tL(t,r)", "tL(e,r)")]).addressOnArrival, false);
  assert.equal(facts([CHECK]).addressOnArrival, false, "no arrivals function");
  // card cash-withdraw-in-app-to-any-chain: Cash's arrivals are the kit's list, held by name
  assert.equal(facts([ARR.replace("[`near`]", "m") + CHECK]).addressOnArrival, true, "Cash's chains by the kit's name");
  // both forms in the scripts: still a second form
  assert.equal(judge(facts([NOW_ROW + OLD_ROW + NOW_HOP + ARR + CHECK])).ok, false);
});

test("the read: APP_HOST's page and the scripts it names", async () => {
  const served = { "/": '<script type="module" crossorigin src="/assets/i.js" integrity="x"></script>', "/assets/i.js": NOW_ROW + NOW_HOP + ARR + CHECK };
  const f = async (url) => {
    const p = url.slice(APP.length);
    return url.startsWith(APP) && served[p] !== undefined ? { status: 200, text: async () => served[p] } : { status: 404, text: async () => "" };
  };
  assert.equal(judge(await read(f)).ok, true);
  served["/"] = "<html></html>";
  await assert.rejects(read(f), /names no script/);
});
