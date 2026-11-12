// node --test scripts/live-checks/near-view-rhea.test.mjs: the live check replays its recorded answers
// (near-view-rhea.answers.json). good: a real read on mainnet's two providers with the card's kit: the quote equals
// get_return on both, PASS. bad: a real read at another block with the kit's pool fee taken out (the sweep's first
// mutant, test/near-rhea-mutants.mjs): the quote is above get_return, FAIL, named. Planted on the good one: another
// block, another pool, one provider's answer missing or different: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, NoAnswer, POOL, read } from "./near-view-rhea.mjs";
import { RETRY } from "./provider-answer.mjs";

const A = JSON.parse(readFileSync(new URL("./near-view-rhea.answers.json", import.meta.url), "utf8"));

test("recorded good answer: the kit's quote equals get_return on both providers: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.match(v.lines[0], /^ok: /);
});

test("recorded bad answer: a kit without the pool fee quotes above get_return: FAIL, named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.equal(v.lines.length, 2);
  for (const l of v.lines) assert.match(l, /^BAD https:\/\/\S+: get_return is \d+, the kit's quote \d+$/);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  const planted = [
    { ...g, height: g.height + 1 },
    { ...g, blockHash: "Other" },
    { ...g, hops: [{ ...g.hops[0], pool: POOL + 1 }] },
    { ...g, hops: [] },
    { ...g, getReturn: [g.getReturn[0]] },
    { ...g, getReturn: [g.getReturn[0], { ...g.getReturn[1], value: String(BigInt(g.getReturn[1].value) + 1n) }] },
    { ...g, getReturn: [g.getReturn[0], { ...g.getReturn[1], value: null, error: "boom" }] },
    { ...g, amountOut: String(BigInt(g.amountOut) - 1n) },
  ];
  for (const a of planted) assert.equal(judge(a).ok, false, JSON.stringify(a).slice(0, 200));
  assert.equal(judge({}).ok, false, "an empty answer");
});

test("read() asks only the mainnet pair and only views, through provider-answer: a provider that answers nothing is a no-answer (INCONCLUSIVE), never a FAIL", async () => {
  RETRY.ms = 0;
  const asked = new Set();
  const fetchFn = async (url, init) => {
    asked.add(url);
    const body = JSON.parse(init.body);
    assert.equal(body.method, "query");
    throw new Error("no network in tests");
  };
  await assert.rejects(read(fetchFn), (e) => e instanceof NoAnswer && /no answer/.test(e.message));
  assert.deepEqual([...asked].sort(), ["https://near.drpc.org", "https://rpc.mainnet.fastnear.com"]);
});

test("a get_return read one provider answered nothing to is INCONCLUSIVE, never PASS or FAIL; a JSON-RPC error stays a FAIL", () => {
  const g = A.good;
  const quiet = judge({ ...g, getReturn: [g.getReturn[0], { provider: g.getReturn[1].provider, noAnswer: "near.drpc.org HTTP 429: 429 Too Many Requests" }] });
  assert.equal(quiet.verdict, "INCONCLUSIVE");
  assert.equal(quiet.ok, false);
  assert.ok(quiet.lines.some((l) => /^-- {2}near\.drpc\.org HTTP 429/.test(l)), quiet.lines.join("\n"));
  assert.equal(judge(g).verdict, "PASS");
  assert.equal(judge(A.bad).verdict, "FAIL");
  // a wrong answer beside a no-answer is still a FAIL
  const both = judge({ ...g, amountOut: "1", getReturn: [g.getReturn[0], { provider: "x", noAnswer: "x: no answer" }] });
  assert.equal(both.verdict, "FAIL");
});
