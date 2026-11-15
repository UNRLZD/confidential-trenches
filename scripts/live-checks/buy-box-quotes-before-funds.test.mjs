// node --test scripts/live-checks/buy-box-quotes-before-funds.test.mjs: the live check replays its recorded answers
// (buy-box-quotes-before-funds.answers.json). good: a fresh account on SIGN_HOST with this card's APP_HOST build (the
// check's --app-dir, 15 Nov 20:33Z): PASS. liveBefore: the live hosts at release 156, before this card (15 Nov 20:33Z):
// FAIL, no Max line and the amount unmarked on both chains. Planted on the good one: each fact taken away FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, TOKENS } from "./buy-box-quotes-before-funds.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./buy-box-quotes-before-funds.answers.json", import.meta.url), "utf8"));

test("recorded good answer: Max $0, the amount marked over it and Buy off on Solana and Base: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded answer liveBefore (release 156): FAIL, no Max line and the amount unmarked on both chains", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    'BAD solana: the line above Buy reads "", want "Max $0"',
    "BAD solana: the amount 5 is not marked over Max",
    'BAD base: the line above Buy reads "", want "Max $0"',
    "BAD base: the amount 5 is not marked over Max",
  ]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  const on = (chain, patch) => ({ ...g, chains: { ...g.chains, [chain]: { ...g.chains[chain], ...patch } } });
  for (const chain of Object.keys(TOKENS)) {
    assert.deepEqual(judge(on(chain, { balance: "$12 available" })).lines, [`BAD ${chain}: Bal reads "$12 available", not a fresh account's "$0 available"`]);
    assert.deepEqual(judge(on(chain, { max: "Max $5" })).lines, [`BAD ${chain}: the line above Buy reads "Max $5", want "Max $0"`]);
    assert.deepEqual(judge(on(chain, { bad: "false" })).lines, [`BAD ${chain}: the amount 5 is not marked over Max`]);
    assert.deepEqual(judge(on(chain, { ctaOff: false })).lines, [`BAD ${chain}: Buy is not off`]);
    const { [chain]: _, ...rest } = g.chains;
    assert.deepEqual(judge({ ...g, chains: rest }).lines, [`BAD ${chain}: the box was not read`]);
  }
  assert.equal(judge(null).ok, false);
});
