// Replays the sign-in e2e's recorded launches through its verdict (card app-harness-signin-e2e): the good launches
// recorded pass, and each planted launch fails on the line its plant breaks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, RUNS } from "./run.mjs";

const answers = JSON.parse(readFileSync(new URL("./run.answers.json", import.meta.url), "utf8"));

test("every good launch passes, each at both widths", () => {
  assert.deepEqual(answers.good.map((r) => r.run), RUNS);
  for (const rec of answers.good) {
    const v = judge(rec);
    assert.equal(v.ok, true, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
    assert.deepEqual(rec.widths.map((w) => w.width), ["390", "1440"]);
  }
});

const WANT = {
  jump: /BAR-04 CLS in step signin/,
  "missing-frame": /AS-01 shots: missing fr-P1-S2.1/,
  "prf-off": /prf\.enabled on the create: false \(want true\)/,
};
for (const [plant, line] of Object.entries(WANT)) {
  test(`the planted ${plant} fails at both widths`, () => {
    const rec = answers.bad[plant];
    assert.equal(rec.plant, plant);
    const v = judge(rec);
    assert.equal(v.ok, false);
    for (const width of ["390", "1440"]) assert.ok(v.lines.some((l) => l.startsWith(`BAD prf @${width}`) && line.test(l)), `${plant} @${width}: ${v.lines.join("\n")}`);
  });
}

test("a launch with no widths, or a width that broke, fails", () => {
  assert.equal(judge({ run: "prf", widths: [] }).ok, false);
  assert.equal(judge({ run: "wallet", widths: [{ width: "390", error: "boom" }] }).ok, false);
});
