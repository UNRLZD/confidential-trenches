// node --test scripts/live-checks/held-move-follow-resume.test.mjs: the live check replays recorded answers
// (held-move-follow-resume.answers.json). bad: this tree built with cfeeddfa7's sources (before this card): every rule
// missing, FAIL. good: this card's build, as SIGN_HOST serves it once deployed: PASS. Planted on the good answer: a
// served /app.js that is not the pinned one, each rule gone, no pin: FAIL. Planted on the build's own minified lines
// (ccae80297, as build-app.mjs writes them): each rule changed FAILs its own mark alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKERS, answerOf, judge } from "./held-move-follow-resume.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./held-move-follow-resume.answers.json", import.meta.url), "utf8"));

test("recorded bad answer: the build before this card, every rule missing: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, MARKERS.map((m) => `BAD the served /app.js lacks the held moved deposit's rule ${m}`));
});

test("recorded good answer: the pinned /app.js follows a held deposit's moved money to its end: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(ANSWERS.good.app.markers, MARKERS);
});

test("planted: a served /app.js that is not the pinned one, each rule gone, or no pin: FAIL", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, app: { ...g.app, sha384: "sha384-other" } }).lines.includes("BAD the served /app.js is not the one index.html pins"));
  for (const m of MARKERS) assert.deepEqual(judge({ ...g, app: { ...g.app, markers: MARKERS.filter((k) => k !== m) } }).lines, [`BAD the served /app.js lacks the held moved deposit's rule ${m}`], m);
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD index.html pins no /app.js"));
});

// The build's lines for each rule, as the minifier writes them at ccae80297 (the end block: this card's FIX FIRST build).
const JS = [
  ",rP=e=>e.stage===`held`&&e.follow.moved===!0&&e.follow.delivered===void 0&&e.follow.move_end===void 0,iP=e=>e.stage===`held`&&e.follow.move===void 0&&!rP(e)||e.stage===`done`&&e.follow.final===!0,",
  ";follow.status===`REFUNDED`&&(e.stage!==`held`||rP(e))",
  // card held-move-follow-resume, FIX FIRST 2-4 (this tree's build, names as above: rP heldFollowed, qN pastOnBoth, h_ VAULT_CONSTANTS)
  "}if(o)for(let[e,t]of await C()){if(!rP(t)||t.follow.move!==void 0)continue;let i=t.follow.moved_address;if(i!==void 0){if(b||y()<(ce.get(e)??0))continue;let a=await VN(i,c,h,n,y());if(a===null)continue;if(`retry_ms`in a){let t=a.retry_ms??Math.min(Math.max((le.get(e)??0)*2,2e3),6e4);le.set(e,t),ce.set(e,y()+t);continue}if(le.delete(e),a.status!==`SUCCESS`&&a.status!==`REFUNDED`&&a.status!==`FAILED`)continue;let o=await $N(c,p,s),l=S===null?[]:await Promise.all([t.follow.origin,m].map(async e=>(await r(null,e))?.held??null));if(o===null||l.some(e=>e===null))continue;let u=o>=h_.MIN_DEPOSIT?`arrived`:o>0n||l.some(e=>e>0n)?`held`:`left`;if(u===`left`&&!await qN(s,(t.follow.moved_ms??0)+18e5))continue;await w(e,`held`,E(t),{move_end:u})}else l!==null&&(l>=h_.MIN_DEPOSIT?await w(e,`held`,E(t),{move_end:`arrived`}):!b&&(S===null||x.has(t.follow.origin)&&x.has(m))&&await qN(s,(t.follow.moved_ms??0)+18e5)&&await w(e,`held`,E(t),{move_end:`left`}))}",
  ";return a.kind===`empty`&&await c7?.resume(e)===!0?{kind:`unread`}:a}",
  ";u.textContent=t.kind===`unread`?EY.busy:n2[t.kind]",
  // round_lock, as the minifier writes it after held-move-follow-resume's review M1
  ";var QX=`ct-wallet/deposit-follow/`,_he=`ct-wallet/deposit-follower/`,vhe=[`refunded`];",
  ";d=s();(d?d.request(`${_he}${g}`,{mode:`exclusive`,signal:h},u):u()).catch(n),c.set(g,_=o)}let v=_,y=s(),b=e=>y?y.request(`ct-wallet/seed`,{mode:`shared`,signal:h},e):e(),x=e=>y?y.request(`${QX}${g}`,{mode:`exclusive`,signal:h},e):e(),S=!1;",
  ";d64:()=>e.seed64(),seedLock:b,roundLock:x,signal:h,untilFinal:!0,",
  ";x=t.seedLock??(e=>e()),S=t.roundLock??(e=>e()),C=t.intents;",
  ";try{fe=await S(de),pe=0}catch{n.throwIfAborted()",
].join("\n");

test("the build's lines carry every rule; each rule changed FAILs its own mark alone", () => {
  assert.deepEqual(answerOf("", JS).app.markers, MARKERS);
  const planted = [
    // held_followed: a moved op still ended (the old rule), a delivery not read, an end read not read, followEnded not
    // leaving out heldFollowed's own name
    ["held_followed", JS.replace("e.follow.move===void 0&&!rP(e)||", "e.follow.move===void 0||")],
    ["held_followed", JS.replace("&&e.follow.delivered===void 0&&e.follow.move_end", "&&e.follow.move_end")],
    ["held_followed", JS.replace("&&e.follow.move_end===void 0,iP", ",iP")],
    ["held_followed", JS.replace("&&!rP(e)||", "&&!sP(e)||")],
    // refund_back: held ops skipped, as before
    ["refund_back", JS.replace("(e.stage!==`held`||rP(e))", "e.stage!==`held`")],
    // ends: the end block before FIX FIRST 2-4 (ccae80297's: left on a clock, no read of 1Click), as built then
    ["ends", JS.replace(/\}if\(o\)for\(let\[e,t\]of await C\(\)\)\{.*\}\)\)\}$/m, () => ";for(let[e,t]of await C())rP(t)&&t.follow.move===void 0&&l!==null&&(l>=h_.MIN_DEPOSIT?await w(e,`held`,E(t),{move_end:`arrived`}):!b&&(S===null||x.has(t.follow.origin)&&x.has(m))&&await qN(s,(t.follow.moved_ms??0)+18e5)&&await w(e,`held`,E(t),{move_end:`left`}))")],
    // ends, with the refund quote's address: no status read, a status not final (none, PROCESSING) taken as final, U not
    // read again after it, a failed read of it taken as 0, held collapsed into left, an end while a move can be offered
    ["ends", JS.replace("if(le.delete(e),a.status!==`SUCCESS`&&a.status!==`REFUNDED`&&a.status!==`FAILED`)continue;", "le.delete(e);")],
    ["ends", JS.replace("&&a.status!==`FAILED`)continue", "&&a.status!==`FAILED`&&a.status!==`PROCESSING`)continue")],
    ["ends", JS.replace("if(a===null)continue;", "")],
    ["ends", JS.replace("let o=await $N(c,p,s),", "let o=l,")],
    ["ends", JS.replace("[t.follow.origin,m].map(async e=>(await r(null,e))?.held??null)", "[t.follow.origin,m].map(e=>x.get(e)??0n)")],
    ["ends", JS.replace("if(o===null||l.some(e=>e===null))continue;", "if(o===null)continue;")],
    ["ends", JS.replace("?`held`:`left`", "?`left`:`left`")],
    ["ends", JS.replace("if(b||y()<", "if(y()<")],
    // ends, a record before the address: left on one read with no window, a window without the refund quote's 30
    // minutes, left with money to move, arrived under MIN_DEPOSIT, left with U's holdings unread, an end on U's USDC unread
    ["ends", JS.replace("else l!==null&&(", "else(")],
    ["ends", JS.replace("&&await qN(s,(t.follow.moved_ms??0)+18e5)&&", "&&")],
    ["ends", JS.replace("&&await qN(s,(t.follow.moved_ms??0)+18e5)&&await", "&&await qN(s,(t.follow.moved_ms??0))&&await")],
    // re-review of 98c86663d, M1: left on a final status alone, or past a window with no 30 minutes
    ["ends", JS.replace("if(u===`left`&&!await qN(s,(t.follow.moved_ms??0)+18e5))continue;", "")],
    ["ends", JS.replace("!await qN(s,(t.follow.moved_ms??0)+18e5))continue", "!await qN(s,(t.follow.moved_ms??0)))continue")],
    ["ends", JS.replace(":!b&&(S===null", ":(S===null")],
    ["ends", JS.replace("l>=h_.MIN_DEPOSIT?", "l>1n?")],
    ["ends", JS.replace("(S===null||x.has(t.follow.origin)&&x.has(m))&&", "")],
    // round_lock: the body under U's own lock (the fault), U's lock never handed to the follow, a second exclusive wait
    // on U's lock, the round run with no lock, the follower lock gone
    ["round_lock", JS.replace("d.request(`${_he}${g}`", "d.request(`${QX}${g}`")],
    ["round_lock", JS.replace("roundLock:x,", "")],
    ["round_lock", JS.replace(",S=!1;", ",z=e=>y.request(`${QX}${g}`,{mode:`exclusive`,signal:h},e),S=!1;")],
    ["round_lock", JS.replace("fe=await S(de),pe=0", "fe=await de(),pe=0")],
    ["round_lock", JS.replace(",_he=`ct-wallet/deposit-follower/`", "")],
    // tap_resumes: empty answered as it is, resumed but answered empty, unread drawn as other words
    ["tap_resumes", JS.replace("return a.kind===`empty`&&await c7?.resume(e)===!0?{kind:`unread`}:a}", "return a}")],
    ["tap_resumes", JS.replace("?{kind:`unread`}:a}", "?a:a}")],
    ["tap_resumes", JS.replace("`unread`?EY.busy:", "`unread`?EY.nothing:")],
  ];
  for (const [m, js] of planted) {
    assert.notEqual(js, JS, `${m}: the plant changed the lines`);
    assert.deepEqual(answerOf("", js).app.markers, MARKERS.filter((k) => k !== m), m);
  }
});
