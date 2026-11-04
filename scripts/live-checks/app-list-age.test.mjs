// node --test scripts/live-checks/app-list-age.test.mjs: the live check's verdict replays recorded runs
// (app-list-age.answers.json), each read on 4 Nov by app-list-age.mjs collect() in headless Chromium, APP_HOST framed by
// the stand-in shell, at 1440 and 390:
//   good: this card's build at APP_HOST's name (--harness --build), every helper read recorded: the 1 Nov lists, days
//         old, draw "Updated 2d ago" both served and dated: PASS;
//   bad:  the deployed APP_HOST on 4 Nov, before this card: the dated lists, days old, draw no age: FAIL.
// Planted from the good run: an age that is not the read's, an age on a fresh read, a missing run, a Discover not ready,
// no lists read, a dated read that is not days old, no entry script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { expectedAges, judge } from "./app-list-age.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-list-age.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w, k) => rec.runs.find((r) => r.width === w && r.kind === k);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};
const NOW = Date.parse("2026-11-04T13:00:00Z");

test("the ages a read may draw: none while fresh, its age once older than 60 s, either across the page's 12 s re-read", () => {
  assert.deepEqual(expectedAges(NOW - 5_000, NOW), [null]);
  assert.deepEqual(expectedAges(NOW - 2 * 3_600_000 - 60_000, NOW), ["Updated 2h ago"]);
  assert.deepEqual(expectedAges(NOW - 2 * 3_600_000, NOW), ["Updated 2h ago", "Updated 1h ago"]);
  assert.deepEqual(expectedAges(NOW - 65_000, NOW), ["Updated 1m ago", null]);
});

test("recorded good answer: the days-old lists draw their age at both widths, served and dated: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 4);
  for (const x of ANSWERS.good.runs) assert.match(x.age ?? "", /^Updated \dd ago$/, `${x.width} ${x.kind}`);
});

test("recorded bad answer: the deployed app before this card draws no age on days-old lists: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /^BAD desktop dated: draws null for a read \d+ s old, want "Updated \dd ago"/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD phone dated: draws null/.test(l)), r.lines.join("\n"));
});

test("planted: an age that is not the read's, or an age on a fresh read, fails", () => {
  fails(mut((rec) => (run(rec, "desktop", "dated").age = "Updated 2h ago")), /^BAD desktop dated: draws "Updated 2h ago" for a read/);
  fails(mut((rec) => Object.assign(run(rec, "phone", "served"), { lists: { status: 200, asOfMs: run(rec, "phone", "served").readAtMs - 5_000 } })), /^BAD phone served: draws "Updated \dd ago" for a read 5 s old, want null/);
  fails(mut((rec) => (run(rec, "phone", "dated").age = null)), /^BAD phone dated: draws null/);
});

test("planted: a missing run, Discover not ready, no lists read, a dated read not days old, no entry script fail", () => {
  fails(mut((rec) => rec.runs.pop()), /^BAD 3 run\(s\) of 4/);
  fails(mut((rec) => (run(rec, "desktop", "served").state = "error")), /^BAD desktop served: Discover is error, not ready/);
  fails(mut((rec) => (run(rec, "desktop", "served").lists = null)), /^BAD desktop served: the page read no dated lists answer/);
  fails(mut((rec) => Object.assign(run(rec, "desktop", "dated"), { lists: { status: 200, asOfMs: run(rec, "desktop", "dated").readAtMs - 2 * 3_600_000 }, age: "Updated 2h ago" })), /^BAD desktop dated: the dated read is not days old/);
  fails(mut((rec) => (rec.entry = null)), /^BAD the served \/ names its entry script none/);
});
