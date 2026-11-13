// node --test scripts/live-checks/rail-open-pushes-the-middle.test.mjs: the live check's verdict replays recorded runs
// (rail-open-pushes-the-middle.answers.json), each read on 13 Nov by rail-open-pushes-the-middle.mjs collect() with
// --build, the terminal's build served at APP_HOST's name inside the stand-in shell, HELPER_HOST live, headless Chrome 156:
//   good: this card's build: at 1440 and 1280 the opened rail takes its own 340 column, the chart and the orders move
//         right by what it grew, nothing overlaps, the header's identity stays whole (at 1280 open the Holders tile gives
//         way), and « brings the rings and the chart back: PASS;
//   bad:  the build of main at 4c1826a75 (the opened rail drawn over the chart, its column still 78): the chart and the
//         orders unmoved under the rail's box: FAIL.
// Planted from the good run: the rail drawn over the chart, a missing width, a close that leaves the rail open, the
// identity run under the strip or its symbol cut.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WIDTHS, judge } from "./rail-open-pushes-the-middle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "rail-open-pushes-the-middle.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the opened rail pushes the chart and the orders right at 1440 and 1280: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(ANSWERS.good.views.map((v) => v.width), WIDTHS);
});

test("recorded bad answer: main's opened rail lies over the chart and the orders: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const w of WIDTHS) {
    assert.ok(bad(r.lines).some((l) => new RegExp(`^BAD / at ${w}: opened, the rail is 340 wide in a 7[78](\\.\\d+)? column`).test(l)), r.lines.join("\n"));
    assert.ok(bad(r.lines).some((l) => l.startsWith(`BAD / at ${w}: opened, the rail's right edge`) && l.endsWith("want no overlap")), r.lines.join("\n"));
  }
});

test("planted: the chart left under the rail, a missing width, a close that leaves it open each fail", () => {
  const over = mut((rec) => {
    rec.views[0].open.chartLeft = rec.views[0].closed.chartLeft;
  });
  assert.ok(bad(over.lines).some((l) => /at 1440: opened, the rail grew/.test(l)), over.lines.join("\n"));
  assert.ok(bad(over.lines).some((l) => /at 1440: .*want no overlap/.test(l)), over.lines.join("\n"));
  const missing = mut((rec) => {
    rec.views = rec.views.slice(0, 1);
  });
  assert.equal(missing.ok, false);
  const stuck = mut((rec) => {
    rec.views[1].shut = rec.views[1].open;
  });
  assert.ok(bad(stuck.lines).some((l) => /at 1280: closed by «/.test(l)), stuck.lines.join("\n"));
  const ident = mut((rec) => {
    rec.views[1].open.identInk = rec.views[1].open.stripLeft + 30;
    rec.views[0].closed.symCut = true;
  });
  assert.ok(bad(ident.lines).some((l) => /at 1280: opened, the identity's content ends/.test(l)), ident.lines.join("\n"));
  assert.ok(bad(ident.lines).some((l) => /at 1440: closed, the identity's content ends.*symbol cut true/.test(l)), ident.lines.join("\n"));
  const unread = mut((rec) => {
    rec.views[0].open = null;
  });
  assert.equal(unread.ok, false);
});
