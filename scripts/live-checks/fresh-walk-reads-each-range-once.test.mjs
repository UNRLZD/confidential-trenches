// node --test scripts/live-checks/fresh-walk-reads-each-range-once.test.mjs: the live check replays its recorded answers
// (fresh-walk-reads-each-range-once.answers.json). good: this card's SIGN_HOST build: PASS. bad: main d01e8334d's build
// (release 161's packages), whose walk confirms a run of the wide read on both seats, the wide source's own route among
// them, and waits on both: FAIL, each mark named. Planted on the good one: another /app.js, no pin, each mark taken
// away: each FAIL; and on the bundle's own pieces.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./fresh-walk-reads-each-range-once.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./fresh-walk-reads-each-range-once.answers.json", import.meta.url), "utf8"));
const NO_OTHERS = "BAD a run of the wide read stands on a seat, so the wide source's own route can give its word twice";
const NO_RACE = "BAD a run of the wide read is not asked of two other operators at once";
const NO_STANDS = "BAD a run of the wide read waits on every provider asked, the slowest included";

test("recorded good answer: a run of the wide read stands on the first of two other operators to agree: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer (main d01e8334d, release 161's packages): FAIL, each mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_OTHERS, NO_RACE, NO_STANDS]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, others: false }).lines, [NO_OTHERS]);
  assert.deepEqual(judge({ ...g, race: false }).lines, [NO_RACE]);
  assert.deepEqual(judge({ ...g, stands: false }).lines, [NO_STANDS]);
  assert.equal(judge(null).ok, false);
});

// the bundle's pieces as this card's build minified them (its app.js), each one broken in turn
const OTHERS = "c=[...n.filter(t=>e.rpcs.includes(t.rpc)),...n.filter(t=>!e.rpcs.includes(t.rpc))].filter(e=>r!==void 0&&e.op!==a&&(s===null||o(e.rpc)!==s)&&!gu(e.rpc,r)),l=new Map;";
const RACE = "try{for(let e=0;e<_.length;e+=e===0?2:1){let t=_.slice(e,e===0?2:e+1).map((t,n)=>o(t,e+n)),n=await new Promise(e=>{let n=t.length;for(let r of t)r.then(t=>t?e(!0):--n===0&&e(!1))});if(a?.throwIfAborted(),n)return!0}return!1}";
const STANDS = "finally{r.abort(Error(`the run stands`)),a?.removeEventListener(`abort`,i)}";
const JS = ";" + [OTHERS, RACE, STANDS].join("");

test("facts over the bundle's pieces: every mark read; each piece broken loses its own mark", () => {
  const f = facts("", JS);
  assert.deepEqual({ others: f.others, race: f.race, stands: f.stands }, { others: true, race: true, stands: true });
  const broken = (from, to) => facts("", JS.replace(from, to));
  // the wide source's host no longer kept out: a plain route of the helper's host would count as a second word
  assert.equal(broken("&&(s===null||o(e.rpc)!==s)", "").others, false);
  // its name no longer kept out
  assert.equal(broken("&&e.op!==a", "").others, false);
  // every source asked one at a time
  assert.equal(broken("e+=e===0?2:1", "e+=1").race, false);
  // the run's read never ended once one agreed
  assert.equal(broken("the run stands", "a run").stands, false);
});
