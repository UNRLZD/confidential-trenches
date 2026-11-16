// node --test scripts/live-checks/robinhood-quote-answers-cold.test.mjs: card robinhood-quote-answers-cold. The live
// check replays its recorded answers (robinhood-quote-answers-cold.answers.json). good: this card's branch, its committed
// snapshots read from the build folder: PASS. bad: the live SIGN_HOST before the card's deploy, whose
// /evm-index/<chain>.json is the page's index: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check, committed } from "./robinhood-quote-answers-cold.mjs";

const A = JSON.parse(readFileSync(new URL("./robinhood-quote-answers-cold.answers.json", import.meta.url), "utf8"));
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes", () => {
  const r = check(A.good.run, A.want);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer fails: SIGN_HOST answered the snapshot paths with its index", () => {
  const r = check(A.bad.run, A.want);
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r).map((l) => l.split(",").slice(0, 2).join(",")), ["BAD [base] snapshot HTTP 200, 382 bytes", "BAD [robinhood] snapshot HTTP 200, 382 bytes"]);
});

test("a snapshot past the head, or with no head read, fails", () => {
  const ahead = structuredClone(A.good.run);
  ahead.snapshots.robinhood.through = ahead.snapshots.robinhood.head + 1;
  assert.equal(check(ahead, A.want).ok, false, "a snapshot past the head");
  const blind = structuredClone(A.good.run);
  blind.snapshots.base.head = null;
  assert.equal(check(blind, A.want).ok, false, "no head");
});

test("the committed snapshots are what the good run read", () => {
  assert.deepEqual(committed(), A.want, "the committed snapshots changed: record the good run again (--site <the build folder of deploy.mjs --build> --record)");
});
