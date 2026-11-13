// node --test scripts/live-checks/signing-layer-says-when-it-closes.test.mjs: the live check replays its recorded
// answers (signing-layer-says-when-it-closes.answers.json). good: this card's SIGN_HOST build: PASS. bad: main
// e42f81694's build, before this card: FAIL. Each planted one, this card's build with one cut the answers' note names:
// FAIL, that fact named. Planted on the good answer: another /app.js, no pin, each fact taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./signing-layer-says-when-it-closes.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signing-layer-says-when-it-closes.answers.json", import.meta.url), "utf8"));
const NOTICE = "BAD the page has no closed notice of the type and the id alone, sent at the current level only: an app is never told an open's layer closed";
const TIMER = "BAD the shell does not tell an open's close from the timer that wakes the kept frame, after it is live, once per open, only for a layer over that frame";
const OPENS = (n, of) => `BAD ${n} of the bundle's ${of} open answers say a notice comes: an app reads no closes on the others, and keeps its own bound alone`;

test("recorded good answer: this card's build tells a kit 1.13 app once, after its frame is live, that an open's layer closed: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
  assert.equal(ANSWERS.good.delay, 500);
  assert.deepEqual([ANSWERS.good.notices, ANSWERS.good.calls, ANSWERS.good.opens, ANSWERS.good.closing], [1, 1, 2, 2]);
});

for (const [k, lines] of [
  ["bad", [NOTICE, TIMER, OPENS(0, 2)]],
  ["badNoticeAnyLevel", [NOTICE]],
  ["badNoticeMore", [NOTICE]],
  ["badNoticeBeforeLive", [TIMER]],
  ["badNoticeAnyFrame", [TIMER]],
  ["badNoticeAtOnce", ["BAD the shell tells an open's close 0 ms after it, not 500 (PROTECT_MS): the app may tap the frame while it is still inert"]],
  ["badOneOpenSaysNothing", [OPENS(1, 2)]],
]) {
  test(`recorded bad answer ${k}: FAIL, that fact named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, lines);
    if (k !== "bad") assert.notEqual(ANSWERS[k].sha384, ANSWERS.good.sha384, `${k} is re-pinned`);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, post: null }).lines, ["BAD the closed notice does not go through the shaper's one post"]);
  assert.deepEqual(judge({ ...g, level: false }).lines, ["BAD the closed notice's level is not the one a hello sets: an older kit may be sent it"]);
  assert.deepEqual(judge({ ...g, notices: 2 }).lines, ["BAD the bundle holds 2 closed notices, not exactly one"]);
  assert.deepEqual(judge({ ...g, calls: 2 }).lines, ["BAD the bundle calls closed( 2 times, not exactly once (the waking timer)"]);
  assert.deepEqual(judge({ ...g, opens: 0, closing: 0 }).lines, [OPENS(0, 0)]);
  assert.deepEqual(judge({ ...g, notice: null }).lines, [NOTICE]);
  assert.deepEqual(judge({ ...g, timer: null }).lines, [TIMER]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  const api = "o=(t,n)=>{let r=i(t,n);r!==null&&e.parent.postMessage(r,`*`)};let c=zc(i);if(c!==null)return void(r=Bc(c));return{idle:()=>u,closed:e=>{r===`current`&&o({v:1,type:`closed`,id:e})}}";
  const shell = "m=setTimeout(()=>{if(m=null,o!==e||!i.hidden)return;e.inert=!1,e.focus?.();let t=v;v=[];for(let n of t)y.add(n.id),y.size>zH&&y.delete(y.values().next().value),n.over===e&&p.closed(n.id)},500)";
  const opens = "{result:{pending:!0,closes:!0},then:a}{result:{pending:!0,closes:!0},then:b}";
  const f = (a = api, s = shell, o = opens) => facts("", `${a}${s}${o}`);
  const g = f();
  assert.deepEqual([typeof g.notice, typeof g.post, g.level, g.notices, typeof g.timer, g.delay, g.calls, g.opens, g.closing], ["string", "string", true, 1, "string", 500, 1, 2, 2]);
  assert.equal(f(api.replace("o=(t,n)=>{let r=i(t,n);r!==null&&", "o=(t,n)=>{let r=t;")).post, null, "the notice's post past the shaper");
  assert.equal(f(api.replace("return void(r=Bc(c))", "return void(q=Bc(c))")).level, false, "the notice gated on another variable");
  assert.equal(f(api.replace("id:e})}", "id:e,at:1})}")).notice, null, "the notice carries more");
  assert.equal(f(api.replace("id:e})}", "id:`x`})}")).notice, null, "the notice carries another id");
  assert.equal(f(api, shell.replace("y.add(n.id),", "")).timer, null, "an id told more than once");
  assert.equal(f(api, shell.replace("e.inert=!1,", "")).timer, null, "told with the frame still inert");
  assert.equal(f(api, shell.replace("n.over===e&&", "n.over&&")).timer, null, "told for a layer over another frame");
  assert.equal(f(api, shell, "{result:{pending:!0},then:a}{result:{pending:!0,closes:!0},then:b}").closing, 1);
});
