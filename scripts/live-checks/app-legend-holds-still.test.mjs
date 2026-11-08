// node --test scripts/live-checks/app-legend-holds-still.test.mjs: the live check's verdict replays recorded answers
// (app-legend-holds-still.answers.json), each read on 2026-11-08 by app-legend-holds-still.mjs collect() with the
// paced walk of card app-legend-crosshair-proof:
//   good: the terminal build with the legend reading the crosshair's bar from its x (chart.ts), at APP_HOST's name in
//         the stand-in shell, the helper live: the crosshair moved the legend through texts of its own at both widths,
//         30 s of ticks and zero layout shifts: PASS;
//   bad:  APP_HOST as deployed (main 4f133769): the legend never followed the crosshair, only the ticks and the Price
//         press changed it: FAIL at both widths.
// Planted from the good answer: one shift (named by its element), a legend that never drew, a walk short in time or in
// points, Price never pressed, a page error, one width missing; a point that reads what the rest read before or after
// it (a tick, the Price press) is never the crosshair's; too few crosshair texts on a chart of few bars is
// INCONCLUSIVE (exit 3), on a chart of many a FAIL; the press's own redraw (marked as following input) passes, the same
// shift unmarked fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, MIN_BARS, MIN_TEXTS, crosshairTexts, judge } from "./app-legend-holds-still.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-legend-holds-still.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
// every point reads the rest text read before it: the legend never followed the crosshair
const stuck = (l) => {
  let rest = null;
  for (const r of l.reads) {
    if (r.kind === "rest") rest = r.text;
    else r.text = rest;
  }
};

test("recorded good answer: the crosshair moved the legend at both widths, which held still: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  for (const l of ANSWERS.good.loads) assert.ok(crosshairTexts(l.reads).size >= MIN_TEXTS, `${l.width} moved the legend`);
});

test("recorded bad answer: the deployed legend never followed the crosshair, only ticks and the Price press moved it: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.verdict, "FAIL");
  assert.equal(EXIT[r.verdict], 1);
  for (const w of ["phone", "desktop"]) assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: the crosshair moved the legend through 0 text(s) of its own`)), r.lines.join("\n"));
  const desk = ANSWERS.bad.loads.find((l) => l.width === "desktop");
  assert.ok(desk.toggled === true && new Set(desk.reads.map((x) => x.text)).size >= 2, "the desktop's legend changed, by the press and the ticks alone");
});

test("planted: one shift fails and names its element and rects", () => {
  const r = mut((rec) => rec.loads[1].shifts.push({ at: 1808, value: 0.00001, input: false, sources: ["span.tkp-lgkv 355,145 92x10 -> 349,145 92x10"] }));
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => l.includes("1 layout shift(s) [+1808ms 0.00001: span.tkp-lgkv 355,145 92x10 -> 349,145 92x10]")), r.lines.join("\n"));
});

test("planted: no legend, a short walk, Price never pressed, a page error or a missing width fails", () => {
  for (const f of [
    (rec) => (rec.loads[0].legend = false),
    (rec) => (rec.loads[1].heldMs = 12_000),
    (rec) => (rec.loads[0].reads = rec.loads[0].reads.slice(0, 9)),
    (rec) => (rec.loads[1].toggled = false),
    (rec) => rec.loads[1].errors.push("TypeError: x is undefined"),
    (rec) => rec.loads.pop(),
    (rec) => (rec.loads = []),
  ]) {
    assert.equal(mut(f).verdict, "FAIL");
  }
});

test("planted: a point that reads the rest text before or after it is never the crosshair's (a tick, the Price press)", () => {
  const reads = [
    { kind: "rest", text: "A" },
    { kind: "point", text: "B" }, // a tick moved the newest bar between the reads: the next rest reads B
    { kind: "rest", text: "B" },
    { kind: "point", text: "B" },
    { kind: "rest", text: "P" }, // the Price press: the rest reads anew
    { kind: "point", text: "X" },
    { kind: "rest", text: "P" },
    { kind: "point", text: "Y" }, // the last point with no rest after it is not counted
  ];
  assert.deepEqual([...crosshairTexts(reads)], ["X"]);
});

test("planted: under 3 crosshair texts is a FAIL on a chart of many bars, INCONCLUSIVE (exit 3) on one of few, never a PASS", () => {
  const many = mut((rec) => stuck(rec.loads[0]));
  assert.equal(many.verdict, "FAIL", many.lines.join("\n"));
  const few = mut((rec) => {
    stuck(rec.loads[0]);
    rec.loads[0].bars = MIN_BARS - 1;
  });
  assert.equal(few.verdict, "INCONCLUSIVE", few.lines.join("\n"));
  assert.equal(EXIT[few.verdict], 3);
  assert.ok(few.lines.some((l) => l.startsWith("INCONCLUSIVE phone: the crosshair moved the legend through 0 text(s)")), few.lines.join("\n"));
  // a page fault beside it still fails
  const both = mut((rec) => {
    stuck(rec.loads[0]);
    rec.loads[0].bars = 2;
    rec.loads[1].errors.push("TypeError: x is undefined");
  });
  assert.equal(both.verdict, "FAIL");
});

test("planted: the Price press's own redraw passes only while marked as following the press", () => {
  const shift = { at: 16_000, value: 0.002, sources: ["span.tkp-lgkv 239,6 79x14 -> 232,6 72x14"] };
  assert.equal(mut((rec) => rec.loads[1].shifts.push({ ...shift, input: true })).verdict, "PASS");
  assert.equal(mut((rec) => rec.loads[1].shifts.push({ ...shift, input: false })).verdict, "FAIL");
  assert.equal(mut((rec) => rec.loads[0].shifts.push({ ...shift, input: true })).verdict, "FAIL");
});
