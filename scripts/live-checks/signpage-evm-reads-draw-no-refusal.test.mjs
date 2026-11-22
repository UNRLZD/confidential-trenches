// node --test scripts/live-checks/signpage-evm-reads-draw-no-refusal.test.mjs: the live check replays its recorded
// answers (signpage-evm-reads-draw-no-refusal.answers.json). good: this card's SIGN_HOST build: PASS. bad: main
// 22753c004's build (release 130), before the card: FAIL, both marks named. Planted on the good one: another /app.js, no
// pin, each mark taken away: each FAIL. Planted in a bundle: Pocket back as the second reader, the old 10,000-block
// span, two batches at once, no batch cap, the lock without ifAvailable: each FAIL. The helper's route through a name
// (card evm-helper-429-waits-its-retry-after): PASS only where that name is bound once, to the helper's origin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NO_LOCK, NO_READERS, facts, judge } from "./signpage-evm-reads-draw-no-refusal.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-evm-reads-draw-no-refusal.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: main 22753c004's build: FAIL, both marks named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_READERS, NO_LOCK]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, readers: false }).lines, [NO_READERS]);
  assert.deepEqual(judge({ ...g, lock: false }).lines, [NO_LOCK]);
});

test("planted in a bundle: each mark broken in place FAILs", () => {
  const good = [
    "x:y_({readers:Object.freeze([`https://rpc.mainnet.chain.robinhood.com`,`https://ct-api.unrealized.trade/v1/rpc/robinhood?keyed=only`]),span:5e5,perBatch:1,parallel:1,margin:7119,cap:131072,batchMax:10})",
    "(mn?mn.request(`ct-evm-index/${e}`,{ifAvailable:!0},e=>e===null?void 0:t()):t())",
  ];
  const ok = facts("", good.join(";"));
  assert.equal(ok.readers && ok.lock, true, JSON.stringify(ok));
  const broken = (i, from, to) => facts("", good.map((s, k) => (k === i ? s.replace(from, to) : s)).join(";"));
  assert.equal(broken(0, "https://ct-api.unrealized.trade/v1/rpc/robinhood?keyed=only", "https://robinhood.api.pocket.network").readers, false);
  assert.equal(broken(0, "?keyed=only", "").readers, false);
  assert.equal(broken(0, "span:5e5", "span:1e4").readers, false);
  assert.equal(broken(0, "parallel:1", "parallel:2").readers, false);
  assert.equal(broken(0, ",batchMax:10", "").readers, false);
  assert.equal(broken(1, "{ifAvailable:!0}", "{}").lock, false);
  assert.equal(broken(1, "ct-evm-index/", "ct-evm-holdings/").lock, false);
});

// card evm-helper-429-waits-its-retry-after: the kit builds the helper's route from its one copy of the origin (pace.ts
// EVM_HELPER_ORIGIN), so the bundle names it `${<name>}/v1/rpc/robinhood?keyed=only` beside `<name>=` the origin
test("planted in a bundle: the helper's route through a bound name PASSes only where that name is the helper's origin, bound once", () => {
  const reader = (helper) =>
    `x:y_({readers:Object.freeze([\`https://rpc.mainnet.chain.robinhood.com\`,\`${helper}/v1/rpc/robinhood?keyed=only\`]),span:5e5,perBatch:1,parallel:1,margin:7119,cap:131072,batchMax:10})`;
  const bound = (...binds) => facts("", [`var a=1${binds.map((b) => `,${b}`).join("")}`, reader("${I$e}")].join(";")).readers;
  assert.equal(bound("I$e=`https://ct-api.unrealized.trade`"), true);
  assert.equal(bound('I$e="https://ct-api.unrealized.trade"'), true);
  // bound to another origin, a lookalike, not bound, bound twice, or the name only set on another object
  assert.equal(bound("I$e=`https://robinhood.api.pocket.network`"), false);
  assert.equal(bound("I$e=`https://ct-api.unrealized.trade.example.com`"), false);
  assert.equal(bound(), false);
  assert.equal(bound("I$e=`https://ct-api.unrealized.trade`", "I$e=`https://robinhood.api.pocket.network`"), false);
  assert.equal(bound("o.I$e=`https://ct-api.unrealized.trade`"), false);
  // the route's own marks still hold through the name: the keyed route and the span
  const named = (from, to) => facts("", ["var I$e=`https://ct-api.unrealized.trade`", reader("${I$e}").replace(from, to)].join(";")).readers;
  assert.equal(named("", ""), true);
  assert.equal(named("?keyed=only", ""), false);
  assert.equal(named("span:5e5", "span:1e4"), false);
});
