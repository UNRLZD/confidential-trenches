// Replays sol-pool-buy-lands-on-mainnet-helper.answers.json: the good answer (this card's helper, in process) passes and
// the bad one (the helper at c338a184, which simulated W's bytes alone) fails, with cases made from the good one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judgeAll as judgeLive } from "./sol-pool-buy-lands-on-mainnet-helper.mjs";
import { poolsToRead, RECORDED_ON } from "./pool-senders-next-page-helper.mjs";

const A = JSON.parse(readFileSync(new URL("./sol-pool-buy-lands-on-mainnet-helper.answers.json", import.meta.url), "utf8"));
const edit = (runs, asked, f) => runs.map((run) => ({ ...run, reads: run.reads.map((x) => (x.asked === asked ? f(x) : x)) }));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

// The recordings were made on the devnet move's two pools (pool-senders-next-page-helper.mjs RECORDED_ON): a replay judges
// each on them; the live run reads poolsToRead(), the mainnet record's pool (card helper-mainnet-pools-only).
const RECORDED = RECORDED_ON.map((m) => ({ cluster: "devnet", pool: m.pool }));
const judgeAll = (runs) => judgeLive(runs, RECORDED);

test("the live run reads the mainnet pool: planted, the devnet recordings alone FAIL it (no run for that pool)", () => {
  assert.deepEqual(poolsToRead().map((w) => w.cluster), ["mainnet"]);
  assert.equal(judgeLive(A.good).ok, false);
});

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
