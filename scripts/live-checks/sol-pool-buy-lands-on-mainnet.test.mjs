// node --test scripts/live-checks/sol-pool-buy-lands-on-mainnet.test.mjs: the live check replays its recorded answers
// (sol-pool-buy-lands-on-mainnet.answers.json). good: this card's mainnet build, the buy tipping 100,000 and the sell
// paying a priority fee: PASS. bad: SIGN_HOST's release 116, the buy at Jito's 1,000 minimum and no sell priority: FAIL,
// each fact named. Planted on the good one: another /app.js, a tip at the minimum or over the cap, no sell budget, no
// preview priority, facts not read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./sol-pool-buy-lands-on-mainnet.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sol-pool-buy-lands-on-mainnet.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's mainnet build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
  assert.equal(ANSWERS.good.buyTip, "100000");
});

test("recorded bad answer: release 116 as served: FAIL, the 1,000 tip and the sell's missing priority named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    "BAD the mainnet buy tips 1000 lamports, not over Jito's 1,000 minimum",
    "BAD the bundle builds no compute budget for a mainnet sell",
    "BAD the sell box's preview counts no mainnet priority fee",
  ]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  for (const [name, a] of [
    ["another /app.js", { ...g, sha384: "sha384-x" }],
    ["no pin", { ...g, index: "<html></html>" }],
    ["tip at the minimum", { ...g, buyTip: "1000" }],
    ["tip over the cap", { ...g, buyTip: "1000001" }],
    ["tip not read", { ...g, buyTip: null }],
    ["no sell budget", { ...g, sellBudget: false }],
    ["no preview priority", { ...g, sellPriority: null }],
    ["a zero preview priority", { ...g, sellPriority: "0" }],
  ])
    assert.equal(judge(a).ok, false, name);
  assert.equal(judge({ ...g, buyTip: "1000000" }).ok, true, "the cap itself passes");
});

test("facts read the minified shapes: the buy's pick, the sell's budget, the preview's sum", () => {
  const js = "var Sd=1000n,Cd=100000n,HU=100000n;let v=e.cluster===`mainnet`?Cd:0n,y=new Map;Te=e.cluster===`mainnet`?UU(null):null;g=Qy+(e.cluster===`mainnet`?HU:0n)";
  const f = facts("", js);
  assert.deepEqual([f.buyTip, f.sellBudget, f.sellPriority], ["100000", true, "100000"]);
  const none = facts("", "let v=e.cluster===`mainnet`?Sd:0n,y=new Map;var Sd=1000n;");
  assert.deepEqual([none.buyTip, none.sellBudget, none.sellPriority], ["1000", false, null]);
});
