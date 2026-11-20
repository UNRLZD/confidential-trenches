// The live check of card app-chart-check-inside-its-bound replays its recorded answers: the good one passes, the bad
// one (the deployed helper before the card) fails, and planted cases hold each verdict.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, judge } from "./app-chart-check-inside-its-bound.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "app-chart-check-inside-its-bound.answers.json"), "utf8"));
const pair = (filling, bars = 2) => ({ whole_ms: 0, status: 200, bars, filling });

test("recorded good answer: a coin whose tape says whole_ms 0 has a chart not filling: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(EXIT[r.verdict], 0);
});

test("recorded bad answer: the deployed helper 207, coins whose tapes say whole_ms 0 with charts filling at both reads: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.equal(EXIT[r.verdict], 1);
});

test("planted: a chart filling once, then not (the stream quiet between the reads), is no BAD line", () => {
  assert.equal(judge({ coins: [{ pairs: [pair(true), pair(false)] }] }).verdict, "PASS");
});

test("planted: one whole coin's chart filling twice fails the run beside a whole coin that passes", () => {
  assert.equal(judge({ coins: [{ pairs: [pair(false)] }, { pairs: [pair(true), pair(true)] }] }).verdict, "FAIL");
});

test("planted: no tape said whole_ms 0, or a whole coin's chart refused: INCONCLUSIVE", () => {
  assert.equal(judge({ coins: [{ whole_ms: 1795108551000, pairs: [] }] }).verdict, "INCONCLUSIVE");
  assert.equal(judge({ coins: [{ pairs: [{ whole_ms: 0, status: 429, bars: null, filling: false }] }] }).verdict, "INCONCLUSIVE");
  assert.equal(judge({ coins: [] }).verdict, "INCONCLUSIVE");
});

test("the recorded answers keep no token address", () => {
  const text = JSON.stringify([A.good, A.bad]);
  assert.doesNotMatch(text, /[1-9A-HJ-NP-Za-km-z]{32,44}/);
});
