// node --test scripts/live-checks/sol-settle-fix-review-p3s.test.mjs: the live check replays its recorded answers
// (sol-settle-fix-review-p3s.answers.json). good: recorded from this card's build: PASS. bad: SIGN_HOST's served page
// before it (a follow that runs the settle pass once): FAIL, each fact named. Planted on the good one: another /app.js,
// no pin, each fact taken away: each FAIL. Planted in the good build's own minified marks, broken in place: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./sol-settle-fix-review-p3s.mjs";

const A = JSON.parse(readFileSync(new URL("./sol-settle-fix-review-p3s.answers.json", import.meta.url), "utf8"));
const FOLLOW = "BAD a buy that ended sent is not handed to the page's late follow";
const LOOP = "BAD the late follow does not run the settle pass again at a wait doubling from 2 s to 60 s until no followed buy is left, a buy that ends sent meanwhile waking it";
const OLD = "BAD the bundle still settles a buy that ended sent once, leaving its end to the app's next state read";

test("recorded good answer: this card's build: PASS", () => {
  assert.deepEqual(judge(A.good), { ok: true, lines: [] });
});

test("recorded bad answer: SIGN_HOST's page before the card: FAIL, each fact named", () => {
  assert.deepEqual(judge(A.bad), { ok: false, lines: [FOLLOW, LOOP, OLD] });
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, follow: false }).lines, [FOLLOW]);
  assert.deepEqual(judge({ ...g, loop: false }).lines, [LOOP]);
  assert.deepEqual(judge({ ...g, old: true }).lines, [OLD]);
  assert.equal(judge(null).ok, false);
});

// the marks as the build minifies them (read from this card's public/app.js), each broken in place
const JS = [
  "F8=Object.freeze({min:2e3,max:6e4})",
  "follow:e=>{m!==null&&(Mt.set(m.noteId,{r:m,post:e,places:new Map}),Lt())}",
  "Lt=async()=>{let e=u.signal;if(On){if(Pt===e)Ft=!0,It?.();else{Pt=e;try{let t=F8.min;for(;!e.aborted;){if(Ft=!1,await kn().catch(()=>{}),Mt.size===0)return;Ft||await Rt(t,e),t=Ft?F8.min:Math.min(t*2,F8.max)}}finally{Pt===e&&(Pt=null)}}}}",
  "Rt=(e,n)=>new Promise(r=>{if(n.aborted)return r();let i=()=>{n.removeEventListener(`abort`,i),It===i&&(It=null),r()};It=i,n.addEventListener(`abort`,i,{once:!0})})",
].join(",");

test("planted in the bundle's marks: each rule broken in place FAILs", () => {
  const index = '<script src="/app.js" integrity="x"></script>';
  const f = (js) => facts(index, js);
  assert.deepEqual(f(JS), { index, sha384: f(JS).sha384, follow: true, loop: true, old: false }, "the marks hold every rule");
  const broken = (from, to) => {
    assert.ok(JS.includes(from), from);
    return f(JS.replace(from, to));
  };
  // the old follow: one settle pass, no late follow
  assert.deepEqual(broken("places:new Map}),Lt())}", "places:new Map}),kn().catch(()=>{}))}"), { index, sha384: broken("places:new Map}),Lt())}", "places:new Map}),kn().catch(()=>{}))}").sha384, follow: false, loop: false, old: true });
  // the follow hands another set's note, or the loop is another function's
  assert.equal(broken("Mt.set(m.noteId,{r:m", "Mt.set(m.id,{r:m").follow, false);
  assert.equal(broken("Lt=async()=>", "Gt=async()=>").loop, false);
  // a fixed wait, no doubling; no stop at a sign out; no end once no followed buy is left; the pass not run again
  assert.equal(broken("Math.min(t*2,F8.max)", "F8.min").loop, false);
  assert.equal(broken("for(;!e.aborted;)", "for(;;)").loop, false);
  assert.equal(broken("Mt.size===0)return;", "!1)return;").loop, false);
  assert.equal(broken("Ft||await Rt(t,e)", "Ft||void 0").loop, false);
  // a buy that ends sent meanwhile: no wake (ed8f79692's return), no pass at once, no wait back to 2 s, a wait with no wake
  assert.equal(broken("if(Pt===e)Ft=!0,It?.();", "if(Pt===e)Ft=!0;").loop, false);
  assert.equal(broken("if(Ft=!1,", "if(").loop, false);
  assert.equal(broken("t=Ft?F8.min:Math.min", "t=Ft?t:Math.min").loop, false);
  assert.equal(broken("};It=i,", "};").loop, false);
  // a loop whose session stopped waits and takes the wake (1b00ffa04's wait)
  assert.equal(broken("{if(n.aborted)return r();let i=", "{let i=").loop, false);
  // other bounds on the wait
  assert.equal(broken("{min:2e3,max:6e4}", "{min:1e3,max:6e4}").loop, false);
  assert.equal(broken("{min:2e3,max:6e4}", "{min:2e3,max:6e5}").loop, false);
});
