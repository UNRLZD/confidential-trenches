// node --test scripts/live-checks/signpage-other-apps-connect.test.mjs: the live check replays recorded answers
// (signpage-other-apps-connect.answers.json). bad: SIGN_HOST as read before this card, no gate, store or Disconnect in its
// /app.js: FAIL, each fact named. good: this card's build, as SIGN_HOST serves it once deployed: PASS. Planted on the
// good one: each fact removed alone, a served /app.js that is not the pinned one, and no pin: FAIL. Each pattern is also
// held to the shape it reads: a minified line with the fact matches, the same line with its order broken does not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FACTS, FACT_NAMES, judge } from "./signpage-other-apps-connect.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-other-apps-connect.answers.json", import.meta.url), "utf8"));

test("recorded bad answer: SIGN_HOST before this card: FAIL, every fact named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, FACT_NAMES.map((f) => `BAD the served /app.js does not hold ${f}`));
});

test("recorded good answer: the pinned /app.js holds every fact: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("planted on the good answer: each fact removed alone FAILS, naming it; another /app.js or no pin FAILS", () => {
  const g = ANSWERS.good;
  for (const f of FACT_NAMES) {
    const v = judge({ ...g, app: { ...g.app, facts: { ...g.app.facts, [f]: false } } });
    assert.equal(v.ok, false, f);
    assert.deepEqual(v.lines, [`BAD the served /app.js does not hold ${f}`]);
    const { [f]: _gone, ...rest } = g.app.facts;
    assert.equal(judge({ ...g, app: { ...g.app, facts: rest } }).ok, false, `${f} missing`);
  }
  assert.ok(judge({ ...g, app: { ...g.app, sha384: "sha384-other" } }).lines.includes("BAD the served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD index.html pins no /app.js"));
});

// the minified shapes each pattern reads (as this card's build gives them), and the same with the fact broken
const SHAPES = {
  gate_before_any_read: ["if(!h)return;let g=h.id;if(e.admit&&!await l())return s({v:1,id:g,ok:!1,error:{code:`not_allowed`}});let _=eie(await crypto.subtle.digest(`SHA-256`,u))", "let _=eie(await crypto.subtle.digest(`SHA-256`,u));if(e.admit&&!await l())return s({v:1,id:g,ok:!1,error:{code:`not_allowed`}});"],
  gate_on_state_push: ["if(h=!1,u===null||e.admit&&!await l())return;let t=u", "if(h=!1,u===null)return;let t=u"],
  gate_fails_closed: ["l=async()=>{try{return await e.admit(t())===!0}catch{return!1}}", "l=async()=>{try{return await e.admit(t())}catch{return!0}}"],
  store_own_database: ["var Zpe=`ct-connections`,x2=`origins`", "var Zpe=`ct-wallet`,x2=`origins`"],
  store_bare_origins_only: ["add:async e=>{if(!S2(e))throw TypeError(`not an origin`);await i(t=>void t.put({v:1},e))},remove:e=>i(t=>void t.delete(e)),list:async()=>(await C2(w2((await r()).transaction(x2,`readonly`).objectStore(x2).getAllKeys()),t)).filter(S2).sort()", "add:async e=>{await i(t=>void t.put({v:1},e))},list:async()=>(await C2(w2((await r()).transaction(x2,`readonly`).objectStore(x2).getAllKeys()),t)).sort()"],
  allow_keeps_then_binds: ["c7.add(e).then(()=>{L7=e,R7.textContent=`Connected ${e}`,o7.allow(e)},H7)", "o7.allow(e),c7.add(e).then(()=>{L7=e},H7)"],
  disconnect_removes_then_drops: ["var tme=`Connected apps`,nme=`Disconnect`,rme=`Disconnect failed`;function ime(e,t){let n=new Set,r=r=>{let i=t.doc.createElement(`div`);i.dataset.origin=r;let a=!1,o=null,s=t.button(`disconnect`,nme,()=>{a||(a=!0,t.store.remove(r).then(()=>{i.remove(),", "var tme=`Connected apps`,nme=`Disconnect`,rme=`Disconnect failed`;function ime(e,t){let n=new Set,r=r=>{let i=t.doc.createElement(`div`);i.dataset.origin=r;let a=!1,o=null,s=t.button(`disconnect`,nme,()=>{i.remove(),t.store.remove(r).then(()=>{"],
  signout_clears: [
    "var v2=`ct-connections`;function w2(e=globalThis.indexedDB,t=b2){return S2(new Promise((t,n)=>{if(e===void 0)return t();let r=e.deleteDatabase(v2);r.onsuccess=()=>t()}),t)}function O9(){r7||(tR(),w2().catch(()=>{}),O7())}_9=null,bA(),await w2().catch(()=>{}),await m7",
    "var v2=`ct-connections`;function w2(e=globalThis.indexedDB,t=b2){return S2(new Promise((t,n)=>{if(e===void 0)return t();let r=e.deleteDatabase(v2);r.onsuccess=()=>t()}),t)}function O9(){r7||(tR(),w2().catch(()=>{}),O7())}_9=null,bA(),await m7",
  ],
};

test("each pattern matches its fact's minified shape and not the same shape with the fact broken", () => {
  assert.deepEqual(Object.keys(SHAPES).sort(), [...FACT_NAMES].sort());
  for (const [f, [good, broken]] of Object.entries(SHAPES)) {
    assert.equal(FACTS[f].test(good), true, `${f} matches its shape`);
    assert.equal(FACTS[f].test(broken), false, `${f} refuses the broken shape`);
  }
});
