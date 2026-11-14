// node --test scripts/live-checks/signing-layer-says-when-it-closes.test.mjs: the live check replays its recorded
// answers (signing-layer-says-when-it-closes.answers.json). good: this card's SIGN_HOST build: PASS. bad: main
// e42f81694's build, before this card, and badBeforeReview, this card's build as reviewed (its opens with no layer
// never told): FAIL. Two source mutants built (open() records no id, runOpen's told cut) and each planted one, this
// card's build with one cut the answers' note names: FAIL, that fact named. Planted on the good answer: another
// /app.js, no pin, each fact taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./signing-layer-says-when-it-closes.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signing-layer-says-when-it-closes.answers.json", import.meta.url), "utf8"));
const NOTICE = "BAD the page has no closed notice of the type and the id alone, sent at the current level only: an app is never told an open's layer closed";
const TIMER = "BAD the shell does not tell an open's close from the timer that wakes the kept frame, after it is live, once per open, only for a layer over that frame";
const OPENS = (n, of) => `BAD ${n} of the bundle's ${of} open answers say a notice comes: an app reads no closes on the others, and keeps its own bound alone`;
const OPEN = "BAD the shell's open does not record its id over the frame it opened over: no layer's close tells its open";
const CLOSE = "BAD the shell's close does not move the ids shown on to be told and wake the frame: no open is told its layer closed";
const TOLD = "BAD the shell has no told: an open that ends with no layer shown is never told";
const TIED = "BAD the shell's open, close, told and waking timer do not share one list of ids to tell, one done set and one frame: an open may be told twice or never";
const RUN = "BAD the page's opens do not end through one run that opens the id's layer or else has the shell tell it: an open that shows no layer is never told";
const LAYER = "BAD the page's layer opens without its open's id: the shell records nothing to tell";
const FRESH = "BAD a ready does not clear the closed notice's hello at once, its queued reset setting the level back: a new app document may be sent it at the old one's level";

test("recorded good answer: this card's build tells a kit 1.13 app once, after its frame is live, that an open's layer closed: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
  assert.equal(ANSWERS.good.delay, 500);
  assert.deepEqual([ANSWERS.good.notices, ANSWERS.good.calls, ANSWERS.good.opens, ANSWERS.good.closing, ANSWERS.good.routed], [1, 1, 2, 2, 2]);
  assert.deepEqual([ANSWERS.good.level, ANSWERS.good.fresh, ANSWERS.good.tied, ANSWERS.good.layer], [true, true, true, true]);
});

test("recorded good answer goodKit114 (card solana-buy-preview-complete's build, kit 1.14): the notice at the current level or kit-v1.13's, the two that read it: PASS", () => {
  const g = ANSWERS.goodKit114;
  assert.deepEqual(judge(g).lines, []);
  assert.match(g.notice, /!==`current`&&[\w$]+!==`1\.13`\|\|/);
  assert.notEqual(g.sha384, ANSWERS.good.sha384, "another build");
  // the 1.14 shape with any other second level is no notice a kit-v1.13 app reads
  const js = (n) => `closed:e=>{!i||r!==\`current\`&&r!==\`${n}\`||o({v:1,type:\`closed\`,id:e})}`;
  assert.notEqual(facts(g.index, js("1.13")).notice, null);
  for (const n of ["1.12", "1.14", "current"]) assert.equal(facts(g.index, js(n)).notice, null, n);
});

test("recorded good answer goodKit115 (card one-balance-buys-on-every-chain's build, kit 1.15): the notice at the current level, kit-v1.14's or kit-v1.13's, the three that read it: PASS", () => {
  const g = ANSWERS.goodKit115;
  assert.deepEqual(judge(g).lines, []);
  assert.match(g.notice, /!==`current`&&[\w$]+!==`1\.14`&&[\w$]+!==`1\.13`\|\|/);
  assert.notEqual(g.sha384, ANSWERS.goodKit114.sha384, "another build");
  // the 1.15 shape with any other levels is no notice a kit-v1.13 or kit-v1.14 app reads
  const js = (m, n) => `closed:e=>{!i||r!==\`current\`&&r!==\`${m}\`&&r!==\`${n}\`||o({v:1,type:\`closed\`,id:e})}`;
  assert.notEqual(facts(g.index, js("1.14", "1.13")).notice, null);
  for (const [m, n] of [["1.12", "1.13"], ["1.14", "1.12"], ["1.15", "1.13"]]) assert.equal(facts(g.index, js(m, n)).notice, null, `${m} ${n}`);
});

test("recorded good answer goodKit116 (card move-sends-what-it-shows's build, kit 1.16): the notice at the current level, kit-v1.15's, kit-v1.14's or kit-v1.13's, the four that read it: PASS", () => {
  const g = ANSWERS.goodKit116;
  assert.deepEqual(judge(g).lines, []);
  assert.match(g.notice, /!==`current`&&[\w$]+!==`1\.15`&&[\w$]+!==`1\.14`&&[\w$]+!==`1\.13`\|\|/);
  assert.notEqual(g.sha384, ANSWERS.goodKit115.sha384, "another build");
  // the 1.16 shape with any other levels is no notice a kit-v1.13 to kit-v1.15 app reads
  const js = (l, m, n) => `closed:e=>{!i||r!==\`current\`&&r!==\`${l}\`&&r!==\`${m}\`&&r!==\`${n}\`||o({v:1,type:\`closed\`,id:e})}`;
  assert.notEqual(facts(g.index, js("1.15", "1.14", "1.13")).notice, null);
  for (const [l, m, n] of [["1.16", "1.14", "1.13"], ["1.15", "1.12", "1.13"], ["1.15", "1.14", "1.12"]]) assert.equal(facts(g.index, js(l, m, n)).notice, null, `${l} ${m} ${n}`);
});

test("recorded good answer goodKit117 (card buy-any-amount-on-every-chain's build, kit 1.17): the notice at the current level, kit-v1.16's, kit-v1.15's, kit-v1.14's or kit-v1.13's, the five that read it: PASS", () => {
  const g = ANSWERS.goodKit117;
  assert.deepEqual(judge(g).lines, []);
  assert.match(g.notice, /!==`current`&&[\w$]+!==`1\.16`&&[\w$]+!==`1\.15`&&[\w$]+!==`1\.14`&&[\w$]+!==`1\.13`\|\|/);
  assert.notEqual(g.sha384, ANSWERS.goodKit116.sha384, "another build");
  // the 1.17 shape with any other levels is no notice a kit-v1.13 to kit-v1.16 app reads
  const js = (k, l, m, n) => `closed:e=>{!i||r!==\`current\`&&r!==\`${k}\`&&r!==\`${l}\`&&r!==\`${m}\`&&r!==\`${n}\`||o({v:1,type:\`closed\`,id:e})}`;
  assert.notEqual(facts(g.index, js("1.16", "1.15", "1.14", "1.13")).notice, null);
  for (const [k, l, m, n] of [["1.17", "1.15", "1.14", "1.13"], ["1.16", "1.14", "1.14", "1.13"], ["1.16", "1.15", "1.12", "1.13"], ["1.16", "1.15", "1.14", "1.12"]]) assert.equal(facts(g.index, js(k, l, m, n)).notice, null, `${k} ${l} ${m} ${n}`);
});

test("recorded good answer goodKit118 (card move-sends-or-says-why's build, kit 1.18): the notice at the current level, kit-v1.17's, kit-v1.16's, kit-v1.15's, kit-v1.14's or kit-v1.13's, the six that read it: PASS; that build with kit-v1.12 in kit-v1.17's place (badKit118NoticeLevel): FAIL", () => {
  const g = ANSWERS.goodKit118;
  assert.deepEqual(judge(g).lines, []);
  assert.match(g.notice, /!==`current`&&[\w$]+!==`1\.17`&&[\w$]+!==`1\.16`&&[\w$]+!==`1\.15`&&[\w$]+!==`1\.14`&&[\w$]+!==`1\.13`\|\|/);
  assert.notEqual(g.sha384, ANSWERS.goodKit117.sha384, "another build");
  const bad = ANSWERS.badKit118NoticeLevel;
  assert.notEqual(bad.sha384, g.sha384, "its own build");
  assert.deepEqual(judge(bad).lines, [NOTICE]);
  // the 1.18 shape with any other levels is no notice a kit-v1.13 to kit-v1.17 app reads
  const js = (j, k, l, m, n) => `closed:e=>{!i||r!==\`current\`&&r!==\`${j}\`&&r!==\`${k}\`&&r!==\`${l}\`&&r!==\`${m}\`&&r!==\`${n}\`||o({v:1,type:\`closed\`,id:e})}`;
  assert.notEqual(facts(g.index, js("1.17", "1.16", "1.15", "1.14", "1.13")).notice, null);
  for (const [j, k, l, m, n] of [["1.18", "1.16", "1.15", "1.14", "1.13"], ["1.12", "1.16", "1.15", "1.14", "1.13"], ["1.17", "1.15", "1.15", "1.14", "1.13"], ["1.17", "1.16", "1.15", "1.14", "1.12"]]) assert.equal(facts(g.index, js(j, k, l, m, n)).notice, null, `${j} ${k} ${l} ${m} ${n}`);
});

for (const [k, lines] of [
  ["bad", [NOTICE, TIMER, OPEN, CLOSE, TOLD, RUN, OPENS(0, 2)]],
  ["badBeforeReview", [NOTICE, TIMER, CLOSE, TOLD, RUN]],
  ["badNoticeAnyLevel", [NOTICE]],
  ["badNoticeMore", [NOTICE]],
  ["badNoticeStaleLevel", [FRESH]],
  ["badNoticeBeforeLive", [TIMER]],
  ["badNoticeAnyFrame", [TIMER]],
  ["badNoticeAtOnce", ["BAD the shell tells an open's close 0 ms after it, not 500 (PROTECT_MS): the app may tap the frame while it is still inert"]],
  ["badNoRecord", [OPEN]],
  ["badNoLayerUntold", [RUN]],
  ["badToldOtherWake", [TIED]],
  ["badLayerNoId", [LAYER]],
  ["badOneOpenSaysNothing", [OPENS(1, 2)]],
]) {
  test(`recorded bad answer ${k}: FAIL, that fact named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, lines);
    assert.notEqual(ANSWERS[k].sha384, ANSWERS.good.sha384, `${k} is another build`);
    assert.deepEqual(judge(ANSWERS[k]).lines.filter((l) => l.includes("pins")), [], `${k} is pinned by its own index`);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, post: null }).lines, ["BAD the closed notice does not go through the shaper's one post"]);
  assert.deepEqual(judge({ ...g, level: false }).lines, ["BAD the closed notice's level is not the one a hello sets: an older kit may be sent it"]);
  assert.deepEqual(judge({ ...g, fresh: false }).lines, [FRESH]);
  assert.deepEqual(judge({ ...g, open: null }).lines, [OPEN]);
  assert.deepEqual(judge({ ...g, close: null }).lines, [CLOSE]);
  assert.deepEqual(judge({ ...g, told: null }).lines, [TOLD]);
  assert.deepEqual(judge({ ...g, tied: false }).lines, [TIED]);
  assert.deepEqual(judge({ ...g, run: null }).lines, [RUN]);
  assert.deepEqual(judge({ ...g, layer: false }).lines, [LAYER]);
  assert.deepEqual(judge({ ...g, routed: 1 }).lines, ["BAD 1 of the bundle's 2 open answers that say a notice comes end through that run: the others may end untold"]);
  assert.deepEqual(judge({ ...g, notices: 2 }).lines, ["BAD the bundle holds 2 closed notices, not exactly one"]);
  assert.deepEqual(judge({ ...g, calls: 2 }).lines, ["BAD the bundle calls closed( 2 times, not exactly once (the waking timer)"]);
  assert.deepEqual(judge({ ...g, opens: 0, closing: 0 }).lines, [OPENS(0, 0)]);
  assert.deepEqual(judge({ ...g, notice: null }).lines, [NOTICE]);
  assert.deepEqual(judge({ ...g, timer: null }).lines, [TIMER]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  const api = "o=(t,n)=>{let r=a(t,n);r!==null&&e.parent.postMessage(r,`*`)};let l=qg(a);if(l!==null)return void(r=Jg(l),i=!0);let p=()=>{i=!1,d=d.then(()=>{r=`1.4`,s=null}),o({v:1,type:`ready`})};return{idle:()=>d,ready:p,closed:e=>{i&&r===`current`&&o({v:1,type:`closed`,id:e})}}";
  const shell =
    "open(e=!1,t){t===void 0||y.has(t)||_.some(e=>e.id===t)||v.some(e=>e.id===t)||_.push({id:t,over:o}),i.hidden=!1}," +
    "close(){if(i.hidden=!0,g=null,v.push(..._),_=[],!o){a.hidden=!1,u=setTimeout(()=>d(e),FH)}S(o)}," +
    "told(e){if(!(y.has(e)||_.some(t=>t.id===e)||v.some(t=>t.id===e))){if(!i.hidden||!o)return void _.push({id:e,over:o});v.push({id:e,over:o}),S(o)}}};" +
    "function S(e){e.inert=!0,m!==null&&clearTimeout(m),m=setTimeout(()=>{if(m=null,o!==e||!i.hidden)return;e.inert=!1,e.focus?.();let t=v;v=[];for(let n of t)y.add(n.id),y.size>zH&&y.delete(y.values().next().value),n.over===e&&p.closed(n.id)},500)}";
  const main = "function h0(e,t){let n=!1;w2(()=>t(()=>{_0(e),n=!0})).finally(()=>{n||Q1?.told(e)})}function _0(e){Q1?.open($H.has(Z1.dataset.signin??``),e),b0()}";
  const opens = "{result:{pending:!0,closes:!0},then:()=>h0(e,a)}{result:{pending:!0,closes:!0},then:()=>h0(t,b)}";
  const f = (a = api, s = shell, m = main, o = opens) => facts("", `${a}${s}${m}${o}`);
  const g = f();
  assert.deepEqual(
    [typeof g.notice, typeof g.post, g.level, g.fresh, g.notices, typeof g.timer, g.delay, g.calls, typeof g.open, typeof g.close, typeof g.told, g.tied, typeof g.run, g.layer, g.opens, g.closing, g.routed],
    ["string", "string", true, true, 1, "string", 500, 1, "string", "string", "string", true, "string", true, 2, 2, 2],
  );
  assert.equal(f(api.replace("o=(t,n)=>{let r=a(t,n);r!==null&&", "o=(t,n)=>{let r=t;")).post, null, "the notice's post past the shaper");
  assert.equal(f(api.replace("return void(r=Jg(l),i=!0)", "return void(q=Jg(l),i=!0)")).level, false, "the notice gated on another variable");
  assert.equal(f(api.replace("return void(r=Jg(l),i=!0)", "return void(r=Jg(l))")).level, false, "a hello that sets no flag");
  assert.equal(f(api.replace("p=()=>{i=!1,", "p=()=>{")).fresh, false, "a ready that clears the flag only in its queued reset");
  assert.equal(f(api.replace("d=d.then(()=>{r=`1.4`,", "d=d.then(()=>{")).fresh, false, "a ready whose queued reset leaves the level");
  assert.equal(f(api.replace("closed:e=>{i&&", "closed:e=>{")).notice, null, "the notice with no hello flag");
  assert.equal(f(api.replace("id:e})}", "id:e,at:1})}")).notice, null, "the notice carries more");
  assert.equal(f(api.replace("id:e})}", "id:`x`})}")).notice, null, "the notice carries another id");
  assert.equal(f(api, shell.replace("y.add(n.id),", "")).timer, null, "an id told more than once");
  assert.equal(f(api, shell.replace("e.inert=!1,", "")).timer, null, "told with the frame still inert");
  assert.equal(f(api, shell.replace("n.over===e&&", "n.over&&")).timer, null, "told for a layer over another frame");
  assert.equal(f(api, shell.replace("||_.push({id:t,over:o}),i.hidden", ",i.hidden")).open, null, "open records no id");
  assert.equal(f(api, shell.replace("v.push(..._),_=[],", "_=[],")).close, null, "close moves no id on");
  assert.equal(f(api, shell.replace("a.hidden=!1,u=setTimeout(()=>d(e),FH)}S(o)}", "a.hidden=!1,u=setTimeout(()=>d(e),FH)}}")).close, null, "close wakes no frame");
  assert.equal(f(api, shell.replace("v.push({id:e,over:o}),S(o)}}", "v.push({id:e,over:o})}}")).told, null, "told wakes no frame");
  assert.equal(f(api, shell.replace("v.push({id:e,over:o}),S(o)}}", "v.push({id:e,over:o}),T(o)}}")).tied, false, "told wakes another function");
  assert.equal(f(api, shell.replace("let t=v;v=[];", "let t=w;w=[];")).tied, false, "the timer tells another list");
  assert.equal(f(api, shell, main.replace(".finally(()=>{n||Q1?.told(e)})", "")).run, null, "no told on an open that showed no layer");
  assert.equal(f(api, shell, main.replace("{_0(e),n=!0}", "{n=!0}")).run, null, "the step's layer opens nothing");
  assert.equal(f(api, shell, main.replace("``),e),b0()", "``)),b0()")).layer, false, "openLayer passes no id");
  assert.equal(f(api, shell, main, "{result:{pending:!0},then:a}{result:{pending:!0,closes:!0},then:()=>h0(t,b)}").closing, 1);
  assert.equal(f(api, shell, main, "{result:{pending:!0,closes:!0},then:a}{result:{pending:!0,closes:!0},then:()=>h0(t,b)}").routed, 1);
});
