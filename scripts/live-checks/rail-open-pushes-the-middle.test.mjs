// node --test scripts/live-checks/rail-open-pushes-the-middle.test.mjs: the live check's verdict replays recorded runs
// (rail-open-pushes-the-middle.answers.json), each read by rail-open-pushes-the-middle.mjs collect() with --build, the
// terminal's build served at APP_HOST's name inside the stand-in shell, HELPER_HOST live, headless Chrome:
//   good: card rail-and-legend-hold-on-r5 at 436f7cb2c (19 Nov): at 1024 and 1099, the widths token.css and the fit zoom draw
//         the slim rail at, the opened rail takes its own 340 column, the chart and the orders move right by what it grew,
//         nothing overlaps, the header's symbol stays whole, and « brings the rings and the chart back; at 1440 and 1280
//         the full rail in its own 340 column with no »: PASS;
//   bad_178: the build of main at 2c400ebcb (release 178) read by the check as it was (widths 1440 and 1280, taken to be
//         slim): the full rail drawn there, no » to open, so no state read (the live run 44429326442's failure): FAIL;
//   bad_1024_open: the same build read by this check: at 1024 the opened rail leaves the header so narrow that the
//         symbol is cut (mihao drawn as m), every other rule held: FAIL;
//   bad (13 Nov): the build of main at 4c1826a75 (the opened rail drawn over the chart, its column still 78): the chart
//         and the orders unmoved under the rail's box: FAIL;
//   bad_long_symbol (13 Nov): the build of main at bd3fb3097 with Anthropic on top (the live run 43449871228's failure):
//         opened, the symbol cut at 1440 and 1280 with every other rule held: FAIL.
// The two 13 Nov records were read when 1440 and 1280 drew the slim rail; their views carry no `want`, which the judge
// reads as slim, as their collector did.
// Planted from the good run: the rail drawn over the chart, a missing width, a close that leaves the rail open, the
// identity run under the strip or its symbol cut, a full width drawn slim, a page not the screen's width.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FULL_WIDTHS, MODES, SLIM_WIDTHS, WIDTHS, judge, modeAt, pageAt, railModes, slimWidths } from "./rail-open-pushes-the-middle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "rail-open-pushes-the-middle.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const at = (rec, w) => rec.views.find((v) => v.width === w);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
/** The widths the 13 Nov records were read at. */
const OLD = [1440, 1280];

test("the widths come from token.css and the fit zoom: slim at 1024 to 1099, full at 1440 and 1280", () => {
  assert.deepEqual(MODES, { none: 1179.98, slim: 1526.98 });
  assert.deepEqual(SLIM_WIDTHS, [1024, 1099]);
  assert.deepEqual(WIDTHS, [...SLIM_WIDTHS, ...FULL_WIDTHS]);
  // the edges: under 1024 nothing is zoomed (a 1023 page has no rail), 1100 is a 1527.8 page (full)
  assert.equal(modeAt(1023), "none");
  assert.equal(modeAt(1100), "full");
  assert.ok(Math.abs(pageAt(1440) - 1920) < 1e-9 && modeAt(1440) === "full" && modeAt(1280) === "full");
  // a token.css that moves the slim mode moves the widths, and one that names no mode is refused
  assert.deepEqual(slimWidths(railModes("@container tkp-page (max-width: 1599.98px) { .x { --tkr-mode: slim; } } @container tkp-page (max-width: 1179.98px) { .x { --tkr-mode: none; } }")), [1024, 1151]);
  assert.throws(() => railModes(".tkp-desk > .tkr { --tkr-mode: full; }"), /names no none and slim/);
});

test("recorded good answer: slim at 1024 and 1099 the opened rail pushes the middle, full at 1440 and 1280: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(ANSWERS.good.views.map((v) => v.width), WIDTHS);
  assert.deepEqual(ANSWERS.good.views.map((v) => v.want), ["slim", "slim", "full", "full"]);
});

test("recorded bad answer: release 178 read only at 1440 and 1280, where no » is drawn: FAIL", () => {
  const r = judge(ANSWERS.bad_178);
  assert.equal(r.ok, false);
  for (const w of OLD) assert.ok(bad(r.lines).includes(`BAD / at ${w}: the token page is ready, a state not read`), r.lines.join("\n"));
  assert.ok(bad(r.lines).some((l) => l.startsWith("BAD 2 view(s) at 1440, 1280, want one at each of 1024, 1099, 1440, 1280")), r.lines.join("\n"));
  // and what it read there was the full rail
  for (const w of OLD) assert.equal(at(ANSWERS.bad_178, w).closed.slim, "false");
});

test("recorded bad answer: at 1024, the narrowest slim screen, the opened rail leaves the header too narrow and the symbol is cut: FAIL", () => {
  const r = judge(ANSWERS.bad_1024_open);
  assert.equal(r.ok, false);
  // the one rule broken: 1099, 1440 and 1280 hold, and 1024 closed holds
  assert.equal(bad(r.lines).length, 1, r.lines.join("\n"));
  assert.ok(bad(r.lines)[0].startsWith("BAD / at 1024: opened, the identity's content ends at 410.625 against the strip's 420.703125"), r.lines.join("\n"));
  assert.ok(bad(r.lines)[0].includes("symbol cut true, tiles price change"), r.lines.join("\n"));
});

test("recorded bad answer: main's opened rail lies over the chart and the orders: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const w of OLD) {
    assert.ok(bad(r.lines).some((l) => new RegExp(`^BAD / at ${w}: opened, the rail is 340 wide in a 7[78](\\.\\d+)? column`).test(l)), r.lines.join("\n"));
    assert.ok(bad(r.lines).some((l) => l.startsWith(`BAD / at ${w}: opened, the rail's right edge`) && l.endsWith("want no overlap")), r.lines.join("\n"));
  }
});

test("recorded bad answer: main's header cuts a long symbol with the rail opened: FAIL", () => {
  const r = judge(ANSWERS.bad_long_symbol);
  assert.equal(r.ok, false);
  for (const w of OLD) assert.ok(bad(r.lines).some((l) => l.startsWith(`BAD / at ${w}: opened, the identity's content ends`) && l.includes("symbol cut true")), r.lines.join("\n"));
  // the symbol is the only rule broken at a width (the record also misses today's widths)
  assert.equal(bad(r.lines).filter((l) => l.startsWith("BAD / at")).length, OLD.length, r.lines.join("\n"));
});

test("planted: the chart left under the rail, a missing width, a close that leaves it open each fail", () => {
  const [lo, hi] = SLIM_WIDTHS;
  const over = mut((rec) => {
    at(rec, lo).open.chartLeft = at(rec, lo).closed.chartLeft;
  });
  assert.ok(bad(over.lines).some((l) => new RegExp(`at ${lo}: opened, the rail grew`).test(l)), over.lines.join("\n"));
  assert.ok(bad(over.lines).some((l) => new RegExp(`at ${lo}: .*want no overlap`).test(l)), over.lines.join("\n"));
  const missing = mut((rec) => {
    rec.views = rec.views.filter((v) => v.width !== hi);
  });
  assert.equal(missing.ok, false);
  const stuck = mut((rec) => {
    at(rec, hi).shut = at(rec, hi).open;
  });
  assert.ok(bad(stuck.lines).some((l) => new RegExp(`at ${hi}: closed by «`).test(l)), stuck.lines.join("\n"));
  const ident = mut((rec) => {
    at(rec, hi).open.identInk = at(rec, hi).open.stripLeft + 30;
    at(rec, lo).closed.symCut = true;
  });
  assert.ok(bad(ident.lines).some((l) => new RegExp(`at ${hi}: opened, the identity's content ends`).test(l)), ident.lines.join("\n"));
  assert.ok(bad(ident.lines).some((l) => new RegExp(`at ${lo}: closed, the identity's content ends.*symbol cut true`).test(l)), ident.lines.join("\n"));
  const unread = mut((rec) => {
    at(rec, lo).open = null;
  });
  assert.equal(unread.ok, false);
});

test("planted: a full width drawn slim, its rail not read, a page not the screen's width each fail", () => {
  const slimAt1440 = mut((rec) => {
    Object.assign(at(rec, 1440).closed, { mode: "slim", slim: "true", railW: 78, track: 78, expand: true });
  });
  assert.ok(bad(slimAt1440.lines).some((l) => l.startsWith("BAD / at 1440: the rail is slim (slim true), 78 wide in a 78 column, » shown")), slimAt1440.lines.join("\n"));
  const unread = mut((rec) => {
    at(rec, 1280).closed = null;
  });
  assert.ok(bad(unread.lines).some((l) => l.startsWith("BAD / at 1280: the token page is ready, the rail not read")), unread.lines.join("\n"));
  const framed = mut((rec) => {
    at(rec, 1280).closed.page -= 20;
    at(rec, SLIM_WIDTHS[0]).closed.page -= 20;
  });
  assert.ok(bad(framed.lines).some((l) => l.startsWith("BAD / at 1280: the page is")), framed.lines.join("\n"));
  assert.ok(bad(framed.lines).some((l) => l.startsWith(`BAD / at ${SLIM_WIDTHS[0]}: the page is`)), framed.lines.join("\n"));
  const slimRead = mut((rec) => {
    at(rec, SLIM_WIDTHS[1]).closed.mode = "full";
  });
  assert.ok(bad(slimRead.lines).some((l) => l.startsWith(`BAD / at ${SLIM_WIDTHS[1]}: closed, the rail is`)), slimRead.lines.join("\n"));
});
