// node --test scripts/live-checks/app-faults-seen-on-126.test.mjs: the live check's verdict replays recorded runs
// (app-faults-seen-on-126.answers.json), each read by app-faults-seen-on-126.mjs collect() in headless Chromium, signed
// out, the token chart dragged a few px at a time at 390 and 1440 and its time axis read at every offset:
//   good: this card's build at APP_HOST's name in the stand-in shell (--harness): labels at every offset, none cut at
//         either edge of the plot: PASS;
//   bad:  the deployed app of release 127 (13 Nov 06:26Z), BONK's chart: labels cut at the plot's left and right edges
//         at both widths (the fault the signed-in walk of release 126 saw as "01::"): FAIL.
// Planted from the good run: a cut label at one offset, an offset with no label read, fewer offsets than the drag,
// a chart never drawn, a run missing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./app-faults-seen-on-126.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-faults-seen-on-126.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w) => rec.runs.find((r) => r.width === w);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: time labels at every drag offset, none cut, at 390 and 1440: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: the deployed release 127 cuts labels at the plot's edges at both widths: FAIL, on those lines alone", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: a time label cut at the plot's edge`)), `${w}\n${r.lines.join("\n")}`);
  assert.ok(bad(r).every((l) => /a time label cut at the plot's edge/.test(l)), r.lines.join("\n"));
});

test("planted: a label cut at one offset fails, at either edge", () => {
  fails(mut((rec) => (run(rec, "desktop").reads[7].cut = "right")), /desktop: a time label cut at the plot's edge at 1 of 51 offsets \(dx 28 right\)/);
  fails(mut((rec) => (run(rec, "phone").reads[0].cut = "left")), /phone: a time label cut at the plot's edge at 1 of 41 offsets \(dx 0 left\)/);
});

test("planted: an offset with no label read fails, and so does a drag cut short", () => {
  fails(mut((rec) => (run(rec, "phone").reads[3].labels = 0)), /phone: no time label read at 1 offset/);
  fails(mut((rec) => run(rec, "desktop").reads.splice(10)), /desktop: 10 drag offset\(s\) read, want 51/);
});

test("planted: a chart never drawn, a run outside the shell or missing fails", () => {
  fails(mut((rec) => (run(rec, "desktop").drawn = false)), /desktop: the chart never drawn/);
  fails(mut((rec) => (run(rec, "phone").framed = false)), /phone: not inside SIGN_HOST's shell/);
  fails(mut((rec) => rec.runs.pop()), /1 run\(s\) of 2/);
});
