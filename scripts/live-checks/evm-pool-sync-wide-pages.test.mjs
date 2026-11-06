// node --test scripts/live-checks/evm-pool-sync-wide-pages.test.mjs: the live check replays its recorded answers
// (evm-pool-sync-wide-pages.answers.json). good: this card's SIGN_HOST build, the pool sync paging each provider from
// 100,000 blocks: PASS. bad: SIGN_HOST before this card's deploy (10,000-block pages, one per seat): FAIL. Planted on
// the good one: another /app.js, no pin, another first page, a widest page under it, halving on a timeout, the pager
// not the sync's, the retry not read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./evm-pool-sync-wide-pages.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./evm-pool-sync-wide-pages.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's build pages the pool sync from 100,000 blocks on each provider: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
  assert.deepEqual([ANSWERS.good.first, ANSWERS.good.max, ANSWERS.good.slowHalves, ANSWERS.good.usedBySync], [100_000, 800_000, false, true]);
});

test("recorded bad answer: SIGN_HOST before this card: FAIL, its 10,000-block pages named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["BAD the bundle's pool sync has no page for each provider: it pages from 10,000 blocks, about 1,300 pages a provider for a month-old Base pool"]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  assert.deepEqual(judge({ ...g, first: 10_000 }).lines, ["BAD the pool sync's first page is 10000 blocks, not 100000"]);
  assert.equal(judge({ ...g, max: 50_000 }).ok, false, "a widest page under the first");
  assert.equal(judge({ ...g, slowHalves: true }).ok, false, "halving on a timeout");
  assert.equal(judge({ ...g, usedBySync: false }).ok, false, "the pager not the sync's");
  assert.equal(judge({ ...g, retry: null }).ok, false, "the retry not read");
  assert.equal(judge({ ...g, pager: null }).ok, false);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  const js = "var Ry=10000n,zy=100000n,By=800000n,Vy=3e4;function Hb(){let e=new Map;return{rules:{max:By,ceilingPages:8,slowHalves:!1},of(t,n){let r=t.url,i=typeof r==`string`?r:`rpc ${n}`,a=e.get(i);return a===void 0&&e.set(i,a={size:zy,answered:null}),a}}}async function Ub(e,t,n,r,i,a,o,s,c=$b){let{max:l,slowHalves:u}=o.rules,d=[];let r=Fb(e);if(r!==null&&(r.kind===`throttle`||y===h||!u)){if(++g>=7)throw e;await c(wb(g,r.afterMs),s);continue}}function S(){let f=Hb(),p={address:n,topics:[[Xy,Zy,Qy]]}}";
  const f = facts("", js);
  assert.deepEqual([f.first, f.max, f.slowHalves, f.usedBySync, typeof f.retry], [100_000, 800_000, false, true, "string"]);
  assert.equal(facts("", js.replace("slowHalves:!1}", "slowHalves:!0}")).slowHalves, true);
  assert.equal(facts("", js.replace("||!u)", ")")).retry, null);
  assert.equal(facts("", js.replace("f=Hb(),p=", "f=[Ry,Ry],p=")).usedBySync, false);
  assert.equal(facts("", js.replace("new Map;", "[];")).pager, null);
});
