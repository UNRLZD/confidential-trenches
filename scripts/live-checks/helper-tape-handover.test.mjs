// node --test scripts/live-checks/helper-tape-handover.test.mjs: the live check replays its runs
// (helper-tape-handover.answers.json, from the helper's code on the recorded Base hour, see its `about`). good: a helper
// restored from the old one's books answers every row at its first read: PASS. bad: the same start with no handover, its
// first reads past the open's bound: a first answer of 0 rows, 50 a read later: FAIL. Made from them: the same short
// answer on a warm helper is INCONCLUSIVE; rows newer than a first answer's newest are not judged; a first answer of 50
// rows misses none below its oldest; a chain with no coin read FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAINS, judge, missed, RESTART_MS } from "./helper-tape-handover.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-tape-handover.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const BASE = ["base"];

test("recorded good run: a restored helper 120 s old answers every row of its span at the first read: PASS", () => {
  const r = judge(A.good.run, BASE);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => l.startsWith("GOOD")).length, 1 + A.good.run.chains.base.tapes.length, r.lines.join("\n"));
});

test("recorded bad run: a helper with no handover answers ICNT 0 rows at its first read and 50 a read later: FAIL", () => {
  const r = judge(A.bad.run, BASE);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.equal(bad(r).length, 1, r.lines.join("\n"));
  assert.match(bad(r)[0], /^BAD \[base 0xe0cd4cacddcbf4f36e845407ce53e87717b6601d\] first answer 0 rows \(filling\), last 50 rows .*: 50 row\(s\) at or below its first answer's span filled in after it on a helper 120 s old/);
});

test("the bad run's short answer on a warm helper is INCONCLUSIVE, not FAIL", () => {
  const run = structuredClone(A.bad.run);
  run.health.started = String(run.health.at - RESTART_MS);
  assert.equal(judge(run, BASE).verdict, "INCONCLUSIVE");
});

test("rows newer than the first answer's newest (the blocks since a rested book) are not judged; rows inside its span are", () => {
  const first = { rows: [["a", 100], ["b", 90]] };
  assert.deepEqual(missed(first, { rows: [["n", 110], ["a", 100], ["b", 90]] }), []);
  assert.deepEqual(missed(first, { rows: [["a", 100], ["x", 95], ["b", 90], ["y", 80]] }), [["x", 95], ["y", 80]], "under 50 rows: below its oldest is judged too");
  const full = { rows: Array.from({ length: 50 }, (_, i) => [`t${i}`, 1_000 - i]) };
  assert.deepEqual(missed(full, { rows: [["new", 2_000], ...full.rows.slice(0, 49)] }), [], "50 rows: older ones pushed out by newer are not missed");
});

test("a chain with no coin read, or a first read that is no 200, FAILs; the live run reads every chain", () => {
  assert.deepEqual(CHAINS, ["base", "robinhood"]);
  assert.equal(judge(A.good.run).verdict, "FAIL", "robinhood unread");
  const run = structuredClone(A.good.run);
  run.chains.base.tapes[0].first = { ...run.chains.base.tapes[0].first, status: 503, rows: null };
  assert.equal(judge(run, BASE).verdict, "FAIL");
});
