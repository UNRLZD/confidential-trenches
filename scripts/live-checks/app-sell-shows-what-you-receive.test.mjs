// node --test scripts/live-checks/app-sell-shows-what-you-receive.test.mjs: the live check replays its recorded answers
// (app-sell-shows-what-you-receive.answers.json). good: this card's builds (apps/terminal/dist, packages/signpage's
// index.html and public/app.js), the app asking pool.sell.dry and asking again on busy or not_funded, the page
// answering it, its buy giving its hosts back at sent and its preview reading the Ws bought since the positions pass:
// PASS. liveBefore: APP_HOST and SIGN_HOST before this card's deploy (read 11 Nov 03:50Z): FAIL, every mark named.
// beforeSince: the signing page built at main 314835ca (the preview on the pass's holding alone; devnet run 116's 7.6 s
// of not_funded after a Filled): FAIL on its three marks. ignoresBought: this card's page built with the preview never
// asking for them (wired in, unused): FAIL on that mark alone. beforeFits: the signing page built at 6446ec37 (one call
// per W and every W read, kept 2 s: five Ws busy on every ask, a second preview inside 10 s busy): FAIL. readsEvery: this
// card's page built with every W read and the last reads never taken: FAIL on that mark alone. beforeFresh: the signing
// page built at be303082 (the kept reads taken before the trading check and across the page's own sale): FAIL.
// keptAcrossTrades: this card's page with the trade count never checked: FAIL on that mark alone. Planted on the good one:
// another script, no pin, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./app-sell-shows-what-you-receive.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./app-sell-shows-what-you-receive.answers.json", import.meta.url), "utf8"));
const NO_ASK = "BAD the app does not ask the signing page's pool.sell.dry: the sell box shows no You receive";
const NO_KIND = "BAD the signing page does not answer pool.sell.dry: the sell box's preview is refused";
const NO_AGAIN = "BAD the sell box does not ask again on busy or not_funded: a preview asked during or just after a buy stays a dash";
const NO_RELEASE = "BAD the signing page's buy holds its hosts to its Final: the sell box's preview is busy until then";
const NO_SINCE = "BAD the signing page's preview does not read a W bought since the positions pass: right after a buy it answers not_funded while the sale would plan W";
const NO_USE = "BAD the signing page's preview never asks for the Ws bought since the positions pass: right after a buy it answers not_funded";
const NO_FRESH = "BAD the signing page's preview takes reads from before a trade of the page: right after a sale it shows a number the sale would not pay";
const NO_FITS = "BAD the signing page's preview reads every W, or reads them again inside the window: a holding of five Ws or more, or a second preview inside 10 s, answers busy";

test("recorded good answer: this card's builds, the app asking pool.sell.dry and the page answering it: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.deepEqual(v, { ok: true, lines: [] });
});

test("recorded bad answer liveBefore: the hosts before this card: FAIL, every mark named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_ASK, NO_KIND, NO_AGAIN, NO_RELEASE, NO_SINCE, NO_USE, NO_FITS, NO_FRESH]);
});

test("recorded bad answer beforeSince: the signing page at main 314835ca, its preview on the pass's holding alone: FAIL on its four marks", () => {
  assert.deepEqual(judge(ANSWERS.beforeSince), { ok: false, lines: [NO_SINCE, NO_USE, NO_FITS, NO_FRESH] });
});

test("recorded bad answer beforeFits: the signing page at 6446ec37, every W read, one call each, kept 2 s: FAIL", () => {
  assert.deepEqual(judge(ANSWERS.beforeFits), { ok: false, lines: [NO_SINCE, NO_USE, NO_FITS, NO_FRESH] });
});

test("recorded bad answer beforeFresh: the signing page at be303082, its kept reads taken across the page's own sale: FAIL", () => {
  assert.deepEqual(judge(ANSWERS.beforeFresh), { ok: false, lines: [NO_FITS, NO_FRESH] });
});

test("recorded bad answer keptAcrossTrades: this card's page with the trade count never checked: FAIL on that mark", () => {
  assert.deepEqual(judge(ANSWERS.keptAcrossTrades), { ok: false, lines: [NO_FRESH] });
});

test("recorded bad answer readsEvery: this card's page reading every W and never the last reads: FAIL on that mark", () => {
  assert.deepEqual(judge(ANSWERS.readsEvery), { ok: false, lines: [NO_FITS] });
});

test("recorded bad answer ignoresBought: this card's page with a preview that never asks for the Ws bought since: FAIL on that mark", () => {
  assert.deepEqual(judge(ANSWERS.ignoresBought), { ok: false, lines: [NO_USE] });
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, app: { ...g.app, sha384: "sha384-other" } }).lines, ["BAD APP_HOST's served script is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, sign: { ...g.sign, sha384: "sha384-other" } }).lines, ["BAD SIGN_HOST's served script is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, app: { ...g.app, index: "<html></html>" } }).lines, ["BAD APP_HOST's index.html pins no script"]);
  assert.deepEqual(judge({ ...g, app: { ...g.app, ask: false } }).lines, [NO_ASK]);
  assert.deepEqual(judge({ ...g, sign: { ...g.sign, kind: false } }).lines, [NO_KIND]);
  assert.deepEqual(judge({ ...g, app: { ...g.app, again: false } }).lines, [NO_AGAIN]);
  assert.deepEqual(judge({ ...g, sign: { ...g.sign, release: false } }).lines, [NO_RELEASE]);
  assert.deepEqual(judge({ ...g, sign: { ...g.sign, since: false } }).lines, [NO_SINCE]);
  assert.deepEqual(judge({ ...g, sign: { ...g.sign, uses: false } }).lines, [NO_USE]);
  assert.deepEqual(judge({ ...g, sign: { ...g.sign, fits: false } }).lines, [NO_FITS]);
  assert.deepEqual(judge({ ...g, sign: { ...g.sign, fresh: false } }).lines, [NO_FRESH]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from the scripts, each mark its own code", () => {
  const app = { index: "", js: "let a;try{a=await e(`pool.sell.dry`,i.params).outcome}catch{};const Xo=new Set([`busy`,`not_funded`]);" };
  const sign = { index: "", js: 'buy:g,...s,"pool.sell.dry":e=>d(e),...VK?{}:{};sent:t=>{a||(a={result:{stage:`sent`}}),c(),h.release?.()};bought:e=>$q?.boughtSince(e)??Promise.resolve([]);boughtSince:async t=>{let n=await(e.held?e.held():e.store()),[r,i,a,o]=await Promise.all([n.get(`meta`,TU),n.get(`meta`,BN),n.get(`meta`,IN),n.get(`meta`,LN)]);return{since:yW(t,r,i,a,o),held:_W(t,i)}},proofs:v;let a=EW(e,i),o=e.positions()===null?void 0:await(async()=>e.bought?.(i))().catch(()=>void 0),s=(o?.since??[]).filter(e=>!a;for(let e of vW(s,c)){let t=r.find(t=>t.address===e);hW(l.length+ +!t,u.length+ +!!t)>6||(t?u.push(t):l.push(e))};if(e.trading())return{error:`busy`};let l=e.trades?.()??0,u=n.kept.get(i);u!==null&&u.trades!==l&&(n.kept.drop(i),u=null);let d=u!==null&&u.pick.pass.every(e=>a?.wallets.includes(e))&&u.pick.since.every(e=>s.some(t=>t.address===e.address)),f=u!==null&&d?u.pick:OW(e,t,a,s,o?.held??new Map);trades:()=>c.edges()+l.edges()+u.edges()+d.edges()}' };
  const f = facts(app, sign);
  assert.equal(f.app.ask && f.sign.kind && f.app.again && f.sign.release && f.sign.since && f.sign.uses && f.sign.fits && f.sign.fresh, true);
  assert.equal(facts(app, { ...sign, js: sign.js.replace("await(e.held?e.held():e.store())", "await e.store()") }).sign.since, false, "a store opened again for it (review of b7212a9e, P3-1)");
  assert.equal(facts(app, { ...sign, js: sign.js.replace("since:yW(t,r,i,a,o)", "since:yW(t,r,i,a)") }).sign.since, false, "the full sells left out");
  assert.equal(facts(app, { ...sign, js: sign.js.replace(",held:_W(t,i)", "") }).sign.since, false, "no amounts for the sale's order");
  assert.equal(facts(app, { ...sign, js: sign.js.replace("await(async()=>e.bought?.(i))().catch(()=>void 0)", "void 0") }).sign.uses, false, "never asked");
  assert.equal(facts(app, { ...sign, js: sign.js.replace(">6||", ">8||") }).sign.fits, false, "the cap widened past the window's 6");
  assert.equal(facts(app, { ...sign, js: sign.js.replace("hW(l.length+ +!t,u.length+ +!!t)>6||", "") }).sign.fits, false, "every W read");
  assert.equal(facts(app, { ...sign, js: sign.js.replace("f=u!==null&&d?u.pick:", "f=") }).sign.fits, false, "the last reads never taken");
  assert.equal(facts(app, { ...sign, js: sign.js.replace("u!==null&&u.trades!==l&&(n.kept.drop(i),u=null);", "") }).sign.fresh, false, "taken across a trade");
  assert.equal(facts(app, { ...sign, js: sign.js.replace("if(e.trading())return{error:`busy`};let l=", "let l=") }).sign.fresh, false, "taken while a trade runs");
  assert.equal(facts(app, { ...sign, js: sign.js.replace("+d.edges()", "") }).sign.fresh, false, "a pool kind not counted");
  assert.equal(facts(app, { ...sign, js: sign.js.replace("bought:e=>$q?.boughtSince(e)", "bought:e=>Promise.resolve([])") }).sign.since, false, "the wiring that reads nothing");
  assert.equal(facts(app, { ...sign, js: sign.js.replace("return{since:yW(t,r,i,a,o),held:_W(t,i)}", "return{since:[],held:new Map}") }).sign.since, false, "a store read whose records are not used");
  assert.equal(facts({ ...app, js: app.js.replace("`not_funded`", "`down`") }, sign).app.again, false, "busy and down is the earlier set");
  assert.equal(facts({ ...app, js: app.js.replace("new Set([`busy`,`not_funded`])", "new Set([`busy`,`down`])") }, sign).app.again, false);
  assert.equal(facts(app, { ...sign, js: sign.js.replace("h.release?.()", "h.end?.()") }).sign.release, false, "the run's end is not its sent");
  assert.equal(facts({ ...app, js: app.js.replace("`pool.sell.dry`", "`pool.sell`") }, sign).app.ask, false, "the dry kind, not the sale");
  assert.equal(facts({ ...app, js: "const k=[`deposit.dry`,`pool.sell.dry`];" }, sign).app.ask, false, "a name in the kit's list is no ask");
  assert.equal(facts(app, { ...sign, js: '"pool.sell.dry":1e4' }).sign.kind, false, "a timeout entry is no kind");
  assert.equal(facts(app, { ...sign, js: '"pool.sell.dry":fl' }).sign.kind, false, "a schema entry is no kind");
});
