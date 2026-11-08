// node --test scripts/live-checks/pool-senders-next-page.test.mjs: the live check replays recorded runs
// (pool-senders-next-page.answers.json). good: the live check's read() against this card's helper sender in process
// (pool-senders-next-page.record-local.mjs: devnet, a throwaway fee payer, RPCs answering BlockhashNotFound): PASS.
// bad: the deployed helper before the card (0beea09b, api.confidential.unrealized.trade, the devnet pool), which refuses
// both next-page forms on the bytes (not_pool): FAIL. Made from the good run: a next-page plant refused on the bytes, the
// tenth account carried to the simulation, a plant missing, no run at all: each FAIL. The plants are checked against
// the helper's own byte checks, so the check plants what the route reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSolanaPoolTx } from "../../apps/helper/src/pool/solana.ts";
import { solanaPoolAccount } from "../../packages/kit/src/index.ts";
import { b58encode } from "./helper-pool-senders.mjs";
import { judge, judgeAll, plant, PLANTS } from "./pool-senders-next-page.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "pool-senders-next-page.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (runs, asked, f) => runs.map((run) => ({ ...run, reads: run.reads.map((x) => (x.asked === asked ? f(x) : x)) }));

test("recorded good run: both next-page forms reach the simulation, the tenth account is refused on the bytes: PASS", () => {
  const r = judgeAll(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad run: the deployed helper before the card refuses both next-page forms (not_pool): FAIL", () => {
  const r = judgeAll(A.bad);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 2, b.join("\n"));
  assert.ok(b[0].includes("planted next_tag2") && b[0].includes("not_pool"), b.join("\n"));
  assert.ok(b[1].includes("planted next_tag3") && b[1].includes("tag 3 flags other than bit 0"), b.join("\n"));
});

test("made from the good run: a next-page form refused, the tenth carried, a plant or the fee missing, no run: each FAIL", () => {
  const g = A.good;
  const notPool = (x) => ({ ...x, body: '{"error":{"code":"not_pool"}}' });
  assert.equal(judgeAll(edit(g, "next_tag2", notPool)).ok, false);
  assert.equal(judgeAll(edit(g, "next_tag3", notPool)).ok, false);
  assert.equal(judgeAll(edit(g, "ten_tag2", (x) => ({ ...x, body: '{"error":{"code":"simulation_failed"}}' }))).ok, false);
  assert.equal(judgeAll(edit(g, "next_tag2", (x) => ({ ...x, status: 200, body: '{"signature":"x"}' }))).ok, false);
  assert.equal(judgeAll(g.map((run) => ({ ...run, reads: run.reads.filter((x) => x.asked !== "next_tag3") }))).ok, false);
  assert.equal(judgeAll(g.map((run) => ({ ...run, reads: run.reads.filter((x) => x.asked !== "fee") }))).ok, false);
  assert.equal(judgeAll(edit(g, "fee", (x) => ({ ...x, headers: {} }))).ok, false);
  assert.equal(judgeAll([]).ok, false);
});

test("the plants are what the helper's own byte checks read: both next-page forms pass them, the tenth account is not_pool", () => {
  const program = b58encode(Buffer.alloc(32, 5));
  const pool = solanaPoolAccount(program);
  const feePayer = b58encode(Buffer.alloc(32, 6));
  const nowMs = Date.now();
  for (const [kind, code] of PLANTS) {
    const wire = plant({ program, pool, feePayer, relayFee: 1_300_000n, kind, nowMs });
    const c = checkSolanaPoolTx(new Uint8Array(wire), { program, pool, feePayer, fee: 1_300_000n, budget: 10n ** 9n, nowMs, jito: true });
    assert.equal(c.ok ? "simulation_failed" : c.code, code, `${kind}: ${c.ok ? "ok" : c.detail}`);
  }
  // the pool asked is the run's: a run for another pool than its fee answer names is a FAIL
  const run = A.good[0];
  assert.equal(judge({ ...run, pool: b58encode(Buffer.alloc(32, 7)) }).ok, false);
});
