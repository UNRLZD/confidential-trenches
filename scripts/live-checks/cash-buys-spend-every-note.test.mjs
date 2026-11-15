// node --test scripts/live-checks/cash-buys-spend-every-note.test.mjs: the live check cash-buys-spend-every-note,
// replayed. cash-buys-spend-every-note.answers.json holds two real runs, 2026-11-15 12:5xZ (`--record`, read only; a
// `from` field added):
// - bad_live_before: SIGN_HOST as served before the card: FAIL, its bundle has no least read (a move from Cash sized on
//   the largest note alone); 1Click names its least into SOL;
// - good_built: the card branch's build (build-app.mjs --out), with the 1Click answer of the same run: PASS.
// Each plant fails on its own line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NO_LEAST, NO_MARK, facts, judge } from "./cash-buys-spend-every-note.mjs";

const A = JSON.parse(readFileSync(new URL("./cash-buys-spend-every-note.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));

test("the card's build with 1Click's least named passes", () => {
  const v = judge(A.good_built);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(bad(v), []);
});

test("SIGN_HOST before the card fails: its bundle reads no least", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.ok, false);
  assert.deepEqual(bad(v), [NO_MARK]);
});

test("1Click naming no least fails the check", () => {
  for (const oneclick of ['{"message":"Failed to get quote"}', '{"message":"recipient is not valid"}', '{"message":"Amount is too low for bridge, try at least 0"}', ""]) {
    assert.deepEqual(bad(judge({ ...A.good_built, oneclick })), [NO_LEAST], oneclick);
  }
});

test("a served bundle the index does not pin, or an index with no pin, fails", () => {
  assert.deepEqual(bad(judge({ ...A.good_built, sha384: A.bad_live_before.sha384 })), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(bad(judge({ ...A.good_built, index: "<html></html>" })), ["BAD SIGN_HOST's index.html pins no /app.js"]);
});

test("the mark is the least read's regex literal as the minifier keeps it, and nothing else", () => {
  const src = 'const R=/"message"\\s*:\\s*"Amount is too low for bridge, try at least (\\d{1,30})"/;';
  assert.equal(facts("", src, "").mark, true);
  assert.equal(facts("", "Amount is too low for bridge, try at least", "").mark, false);
});
