// node --test scripts/live-checks/signpage-buy-route-events.test.mjs: the live check's verdict replays recorded answers
// (signpage-buy-route-events.answers.json), each read on 2026-11-04 by signpage-buy-route-events.mjs collect():
//   good: this card's checkout (--local): the signing page's committed bundle holds the route poster and hands it to the
//         kinds' context; the terminal's fresh build holds the kit client's onRoute and the trade source's seam: PASS;
//   bad:  SIGN_HOST and APP_HOST as deployed before this card, read over https: neither half: FAIL.
// Planted from the good answer: one host's script lost one marker, a script the host did not answer, a page naming no
// script, a host this check does not know, no host at all. The markers themselves are run over the bundles' own text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, MARKERS, scriptsOf } from "./signpage-buy-route-events.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-buy-route-events.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: both bundles carry their half of the route: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const h of ["sign", "app"]) assert.deepEqual(new Set(ANSWERS.good.hosts[h].js.flatMap((f) => f.found)), new Set(Object.keys(MARKERS[h])));
});

test("recorded bad answer: the hosts before this card hold neither half: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => /^BAD sign: the scripts lack the route poster, the kinds' route context$/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /^BAD app: the scripts lack the kit client's onRoute, the trade source's live seam$/.test(l)), r.lines.join("\n"));
});

test("planted: one marker lost on either host fails, naming it", () => {
  const sign = mut((rec) => {
    rec.hosts.sign.js[0].found = rec.hosts.sign.js[0].found.filter((m) => m !== "the route poster");
  });
  assert.equal(sign.ok, false);
  assert.ok(bad(sign.lines).some((l) => /sign: the scripts lack the route poster$/.test(l)), sign.lines.join("\n"));
  const app = mut((rec) => {
    rec.hosts.app.js[0].found = ["the kit client's onRoute"];
  });
  assert.equal(app.ok, false);
  assert.ok(bad(app.lines).some((l) => /app: the scripts lack the trade source's live seam$/.test(l)), app.lines.join("\n"));
});

test("planted: a script the host did not answer, a page naming no script, an unknown host or none: each fails", () => {
  assert.equal(mut((rec) => void (rec.hosts.sign.js[0].status = 404)).ok, false);
  assert.equal(mut((rec) => void (rec.hosts.app.js = [])).ok, false);
  assert.equal(mut((rec) => void (rec.hosts.app.pageStatus = 503)).ok, false);
  assert.equal(mut((rec) => void (rec.hosts.evil = rec.hosts.app)).ok, false);
  assert.equal(judge({ hosts: {} }).ok, false);
  assert.equal(judge(null).ok, false);
});

test("the markers match the bundles' own minified text and not the bundles before this card", () => {
  // the lines as the bundlers wrote them (packages/signpage/public/app.js at fold 1, apps/terminal/dist at 887c521)
  const sign = "m=e=>{let t=t=>Object.hasOwn(e,t),n=t(`wallet`)?{wallet:e.wallet}:t(`venue`)?{venue:e.venue,pool:e.pool}:t(`out`)?{out:e.out}:null,i=n&&{v:1,type:`progress`,id:u,...n};i!==null&&_c(i)&&(c=c.then(()=>r(i)).catch(()=>{}))};n.set(u,[]);let h=jc(e,l,{id:u,sha:d,progress:p,route:m});";
  const app = "onProgress(e){return c.add(e),()=>void c.delete(e)},onRoute(e){return l.add(e),()=>void l.delete(e)},request(e,t){} onProgress:t?t.onProgress.bind(t):null,route:t?ap(t.onRoute.bind(t)):null}),[t,i]);";
  for (const [name, re] of Object.entries(MARKERS.sign)) assert.match(sign, re, name);
  for (const [name, re] of Object.entries(MARKERS.app)) assert.match(app, re, name);
  // before: the stage poster alone, and the kit client with onProgress alone
  const signBefore = "let p=e=>{let t=n.get(u);if(t)return void t.push(e);c=c.then(()=>r({v:1,type:`progress`,id:u,stage:e})).catch(()=>{})};n.set(u,[]);let h=Cc(e,l,{id:u,sha:d,progress:p});";
  const appBefore = "onProgress(e){return c.add(e),()=>void c.delete(e)},request(e,t){} onProgress:t?t.onProgress.bind(t):null}),[t,i]);";
  for (const [name, re] of Object.entries(MARKERS.sign)) assert.doesNotMatch(signBefore, re, name);
  for (const [name, re] of Object.entries(MARKERS.app)) assert.doesNotMatch(appBefore, re, name);
});

test("the page's scripts: the src of each script tag", () => {
  assert.deepEqual(scriptsOf('<script type="module" src="/app.js" integrity="sha384-x"></script><link rel="stylesheet" href="/a.css">'), ["/app.js"]);
});
