// node --test scripts/live-checks/app-legend-holds-still.test.mjs: the live check's verdict replays recorded answers
// (app-legend-holds-still.answers.json), each read on 2026-11-08 by app-legend-holds-still.mjs collect():
//   good: this card's terminal build at APP_HOST's name in the stand-in shell, the helper live: the legend drew at both
//         widths, the crosshair moved it, 30 s of ticks and zero layout shifts: PASS;
//   bad:  APP_HOST as deployed before this card (main 8600ea2d): the legend's values moved as their length changed: FAIL.
// Planted from the good answer: one shift (named by its element), a legend that never drew, a crosshair that never
// moved it, a hold cut short, Price never pressed, a page error, one width missing; the press's own redraw (marked as
// following input) passes, the same shift unmarked fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./app-legend-holds-still.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-legend-holds-still.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the legend held still through 30 s of ticks and crosshair moves at both widths: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const l of ANSWERS.good.loads) assert.ok(l.texts >= 2 && l.moves > 0, `${l.width} moved the legend`);
});

test("recorded bad answer: the deployed legend's values moved as their length changed: FAIL, each shift named", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /layout shift\(s\) \[.*span\.tkp-lgkv/.test(l)), r.lines.join("\n"));
});

test("planted: one shift fails and names its element and rects", () => {
  const r = mut((rec) => rec.loads[1].shifts.push({ at: 1808, value: 0.00001, input: false, sources: ["span.tkp-lgkv 355,145 92x10 -> 349,145 92x10"] }));
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes("1 layout shift(s) [+1808ms 0.00001: span.tkp-lgkv 355,145 92x10 -> 349,145 92x10]")), r.lines.join("\n"));
});

test("planted: no legend, a legend the crosshair never moved, a short hold, a page error or a missing width fails", () => {
  for (const f of [
    (rec) => (rec.loads[0].legend = false),
    (rec) => (rec.loads[0].texts = 1),
    (rec) => (rec.loads[1].heldMs = 12_000),
    (rec) => (rec.loads[1].toggled = false),
    (rec) => rec.loads[1].errors.push("TypeError: x is undefined"),
    (rec) => rec.loads.pop(),
    (rec) => (rec.loads = []),
  ]) {
    assert.equal(mut(f).ok, false);
  }
});

test("planted: the Price press's own redraw passes only while marked as following the press", () => {
  const shift = { at: 16_000, value: 0.002, sources: ["span.tkp-lgkv 239,6 79x14 -> 232,6 72x14"] };
  assert.equal(mut((rec) => rec.loads[1].shifts.push({ ...shift, input: true })).ok, true);
  assert.equal(mut((rec) => rec.loads[1].shifts.push({ ...shift, input: false })).ok, false);
  assert.equal(mut((rec) => rec.loads[0].shifts.push({ ...shift, input: true })).ok, false);
});
