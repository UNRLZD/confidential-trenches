// node --test scripts/live-checks/helper-evm-tapes-survive-a-restart.test.mjs: the live check replays its recorded runs
// (helper-evm-tapes-survive-a-restart.answers.json). bad: the deployed helper before the card, its health naming no
// start: FAIL. good: the same tape answers with the start the card names, a helper 120 s old: PASS. Made from the good
// run: a just-started helper whose every tape on a chain is still filling at FILLED_MS (run 44249482613's two tape
// checks, minutes after the deploy) FAILs; the same on a warm helper is INCONCLUSIVE; a start ahead of the read FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, RESTART_MS } from "./helper-evm-tapes-survive-a-restart.mjs";
import { FILLED_MS } from "./tape-read.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-evm-tapes-survive-a-restart.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good run with every tape of `chain` filling from its first read to FILLED_MS, the helper `ageMs` old. */
const filling = (chain, ageMs) => {
  const run = structuredClone(A.good.run);
  run.health.started = String(run.health.at - ageMs);
  for (const t of run.chains[chain].tapes) {
    const t0 = t.answers[0].at;
    t.answers = [0, FILLED_MS / 2, FILLED_MS].map((d) => ({ ...t.answers[0], at: t0 + d, filling: true, whole_ms: null }));
  }
  return run;
};

test("recorded good run: a helper 120 s old serves a complete tape on Base and on Robinhood: PASS", () => {
  const r = judge(A.good.run);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => l.startsWith("GOOD")).length, 3, r.lines.join("\n"));
});

test("recorded bad run: the deployed helper before the card names no start: FAIL", () => {
  const r = judge(A.bad.run);
  assert.equal(r.verdict, "FAIL");
  assert.equal(bad(r).length, 1, r.lines.join("\n"));
  assert.match(bad(r)[0], /^BAD \/v1\/health names the helper's start: X-Helper-Started null /);
});

for (const chain of ["base", "robinhood"]) {
  test(`${chain}: every tape still filling at FILLED_MS on a helper just started FAILs; on a warm helper it is INCONCLUSIVE`, () => {
    const young = judge(filling(chain, 60_000));
    assert.equal(young.verdict, "FAIL", young.lines.join("\n"));
    assert.ok(bad(young).some((l) => l.startsWith(`BAD [${chain}] no tape served complete within ${FILLED_MS / 1_000} s`)), young.lines.join("\n"));
    assert.equal(judge(filling(chain, RESTART_MS - 1)).verdict, "FAIL");
    const warm = judge(filling(chain, RESTART_MS));
    assert.equal(warm.verdict, "INCONCLUSIVE", warm.lines.join("\n"));
  });
}

test("a tape complete only past FILLED_MS from its first read is not served at once: FAIL on a young helper", () => {
  const run = structuredClone(A.good.run);
  const t = run.chains.robinhood.tapes.at(-1);
  t.answers.at(-1).at = t.answers[0].at + FILLED_MS + 1;
  const r = judge(run);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => l.startsWith("BAD [robinhood]")), r.lines.join("\n"));
});

test("a start ahead of the health read, or not a ms count, FAILs", () => {
  for (const started of [String(A.good.run.health.at + 1), "soon", "17949"]) {
    const run = structuredClone(A.good.run);
    run.health.started = started;
    assert.equal(judge(run).verdict, "FAIL", started);
  }
});

test("a chain with no coin read FAILs", () => {
  const run = structuredClone(A.good.run);
  run.chains.base.tapes = [];
  assert.equal(judge(run).verdict, "FAIL");
});
