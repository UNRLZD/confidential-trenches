// node --test scripts/live-checks/app-sell-shows-what-you-receive.test.mjs: the live check replays its recorded answers
// (app-sell-shows-what-you-receive.answers.json). good: this card's builds (apps/terminal/dist, packages/signpage's
// index.html and public/app.js), the app asking pool.sell.dry and asking again on busy or not_funded, the page
// answering it, its buy giving its hosts back at sent and its preview reading the Ws bought since the positions pass:
// PASS. liveBefore: APP_HOST and SIGN_HOST before this card's deploy (read 11 Nov 03:50Z): FAIL, every mark named.
// beforeSince: the signing page built at main 314835ca (the preview on the pass's holding alone; devnet run 116's 7.6 s
// of not_funded after a Filled): FAIL on that mark alone. Planted on the good one: another script, no pin, each mark
// taken away: each FAIL.
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

test("recorded good answer: this card's builds, the app asking pool.sell.dry and the page answering it: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.deepEqual(v, { ok: true, lines: [] });
});

test("recorded bad answer liveBefore: the hosts before this card: FAIL, every mark named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_ASK, NO_KIND, NO_AGAIN, NO_RELEASE, NO_SINCE]);
});

test("recorded bad answer beforeSince: the signing page at main 314835ca, its preview on the pass's holding alone: FAIL on that mark", () => {
  assert.deepEqual(judge(ANSWERS.beforeSince), { ok: false, lines: [NO_SINCE] });
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
  assert.equal(judge(null).ok, false);
});

test("the facts read from the scripts, each mark its own code", () => {
  const app = { index: "", js: "let a;try{a=await e(`pool.sell.dry`,i.params).outcome}catch{};const Xo=new Set([`busy`,`not_funded`]);" };
  const sign = { index: "", js: 'buy:g,...s,"pool.sell.dry":e=>d(e),...VK?{}:{};sent:t=>{a||(a={result:{stage:`sent`}}),c(),h.release?.()};bought:e=>$q?.boughtSince(e)??Promise.resolve([]);boughtSince:async t=>{let n=await e.store(),[r,i,a]=await Promise.all([n.get(`meta`,TU),n.get(`meta`,BN),n.get(`meta`,IN)]);return gW(t,r,i,a)},proofs:v' };
  const f = facts(app, sign);
  assert.equal(f.app.ask && f.sign.kind && f.app.again && f.sign.release && f.sign.since, true);
  assert.equal(facts(app, { ...sign, js: sign.js.replace("bought:e=>$q?.boughtSince(e)", "bought:e=>Promise.resolve([])") }).sign.since, false, "the wiring that reads nothing");
  assert.equal(facts(app, { ...sign, js: sign.js.replace("return gW(t,r,i,a)", "return[]") }).sign.since, false, "a store read whose records are not used");
  assert.equal(facts({ ...app, js: app.js.replace("`not_funded`", "`down`") }, sign).app.again, false, "busy and down is the earlier set");
  assert.equal(facts({ ...app, js: app.js.replace("new Set([`busy`,`not_funded`])", "new Set([`busy`,`down`])") }, sign).app.again, false);
  assert.equal(facts(app, { ...sign, js: sign.js.replace("h.release?.()", "h.end?.()") }).sign.release, false, "the run's end is not its sent");
  assert.equal(facts({ ...app, js: app.js.replace("`pool.sell.dry`", "`pool.sell`") }, sign).app.ask, false, "the dry kind, not the sale");
  assert.equal(facts({ ...app, js: "const k=[`deposit.dry`,`pool.sell.dry`];" }, sign).app.ask, false, "a name in the kit's list is no ask");
  assert.equal(facts(app, { ...sign, js: '"pool.sell.dry":1e4' }).sign.kind, false, "a timeout entry is no kind");
  assert.equal(facts(app, { ...sign, js: '"pool.sell.dry":fl' }).sign.kind, false, "a schema entry is no kind");
});
