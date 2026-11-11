// Replays sol-pool-buy-lands-on-mainnet-helper.answers.json: the good answer (this card's helper, in process) passes and
// the bad one (the helper at c338a184, which simulated W's bytes alone) fails, with cases made from the good one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judgeAll } from "./sol-pool-buy-lands-on-mainnet-helper.mjs";

const A = JSON.parse(readFileSync(new URL("./sol-pool-buy-lands-on-mainnet-helper.answers.json", import.meta.url), "utf8"));
const edit = (runs, asked, f) => runs.map((run) => ({ ...run, reads: run.reads.map((x) => (x.asked === asked ? f(x) : x)) }));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer: both reached plants answer 422 blockhash_not_found on every pool: PASS", () => {
  const r = judgeAll(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer, the helper before the card: simulation_failed on W's bytes: FAIL on each reached plant", () => {
  const r = judgeAll(A.bad_before_card);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 4, b.join("\n"));
  assert.ok(b.every((l) => l.includes("simulation_failed")), b.join("\n"));
});

test("made from the good answer: a signature in the answer, a 200, a missing plant, a pool not read, no commit: each FAIL", () => {
  const g = A.good;
  assert.equal(judgeAll(edit(g, "next_tag3", (x) => ({ ...x, body: JSON.stringify({ error: { code: "blockhash_not_found" }, signature: "x" }) }))).ok, false);
  assert.equal(judgeAll(edit(g, "next_tag2", (x) => ({ ...x, status: 200, body: '{"signature":"x"}' }))).ok, false);
  assert.equal(judgeAll(g.map((run) => ({ ...run, reads: run.reads.filter((x) => x.asked !== "next_tag2") }))).ok, false);
  assert.equal(judgeAll(g.slice(1)).ok, false);
  assert.equal(judgeAll(edit(g, "fee", (x) => ({ ...x, headers: {} }))).ok, false);
  assert.equal(judgeAll([]).ok, false);
});
