// node --test apps/helper/src/limits/key-reads.test.ts (card near-off-the-fastnear-key): the FastNEAR key's reads are
// counted per UTC day in two buckets, kept across a restart and a handover in the store, named on one header, and held
// to a daily ceiling; every other helper's file is hostile input.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KEY_READS_DIR, keyReads, NEAR_KEY_DAY_DEFAULT, nearKeyDayOf, SYNC_MS } from "./key-reads.ts";
import { DAY_SYNC_MS } from "./limits.ts";

const DAY = 86_400_000;
/** 2026-11-26 12:00Z, a still clock the tests move by hand. */
const T0 = Date.UTC(2026, 10, 26, 12);
const clock = () => {
  const c = { t: T0 };
  return { c, now: () => c.t };
};
const store = () => mkdtempSync(join(tmpdir(), "key-reads-"));

test("each request counts in its bucket; the header names today and yesterday with the ceiling, open until the two together reach it", () => {
  const { now } = clock();
  const r = keyReads(now, 5);
  assert.equal(r.header(), "2026-11-26 helper=0 seat=0 of 5 open, 2026-11-25 helper=0 seat=0 of 5 open");
  r.add("helper");
  r.add("seat", 3);
  assert.equal(r.header(), "2026-11-26 helper=1 seat=3 of 5 open, 2026-11-25 helper=0 seat=0 of 5 open");
  assert.equal(r.open(), true, "4 of 5: one more fits");
  assert.equal(r.open(2), false, "two more do not");
  r.add("seat");
  assert.equal(r.open(), false);
  assert.match(r.header(), /^2026-11-26 helper=1 seat=4 of 5 hit, /);
});

test("a new UTC day starts at zero and names the day before whole; the ceiling opens again", () => {
  const { c, now } = clock();
  const r = keyReads(now, 2);
  r.add("helper", 2);
  assert.equal(r.open(), false);
  c.t += DAY;
  assert.equal(r.open(), true);
  assert.equal(r.header(), "2026-11-27 helper=0 seat=0 of 2 open, 2026-11-26 helper=2 seat=0 of 2 hit");
});

test("kept in the store: a restarted helper (a new id) and a handover's second helper count every other helper's reads of the day", () => {
  const dir = store();
  const { c, now } = clock();
  const a = keyReads(now);
  a.attach(dir, "aaaaaaaa-0000", 100);
  a.add("helper", 7);
  a.add("seat", 11);
  a.flush();
  const b = keyReads(now);
  b.attach(dir, "bbbbbbbb-0000", 100);
  b.add("seat", 2);
  assert.equal(b.header().split(", ")[0], "2026-11-26 helper=7 seat=13 of 100 open", "b counts a's file and its own");
  b.flush();
  c.t += 1_000; // past DAY_SYNC_MS: a re-reads b's file
  assert.equal(a.header().split(", ")[0], "2026-11-26 helper=7 seat=13 of 100 open", "a counts b's file and its own");
  assert.equal(b.open(81), false, "the ceiling is the store's sum: 20 counted, 81 more is past 100");
  assert.equal(b.open(80), true);
});

test("a file of no kept day is removed; yesterday's is kept and named; a hostile file counts nothing", () => {
  const dir = store();
  const { c, now } = clock();
  const a = keyReads(now);
  a.attach(dir, "aaaaaaaa-0001", 1_000);
  a.add("seat", 5);
  a.flush();
  const d = join(dir, KEY_READS_DIR);
  const today = Math.floor(T0 / DAY);
  writeFileSync(join(d, "cccccccc-0000.json"), JSON.stringify({ days: { [today - 3]: { helper: 9, seat: 9 } } }));
  writeFileSync(join(d, "dddddddd-0000.json"), JSON.stringify({ days: { [today]: { helper: -1, seat: 4 } } }));
  writeFileSync(join(d, "eeeeeeee-0000.json"), "{not json");
  writeFileSync(join(d, "ffffffff-0000.json"), JSON.stringify({ days: { [today]: { helper: 1, seat: 1 }, pad: "x".repeat(5_000) } }));
  writeFileSync(join(d, "not-a-helper.json"), JSON.stringify({ days: { [today]: { helper: 50, seat: 50 } } }));
  writeFileSync(join(d, "99999999-0000.json"), JSON.stringify({ days: { [today - 1]: { helper: 3, seat: 0 } } }));
  const b = keyReads(now);
  b.attach(dir, "bbbbbbbb-0001", 1_000);
  assert.equal(b.header(), "2026-11-26 helper=0 seat=5 of 1000 open, 2026-11-25 helper=3 seat=0 of 1000 open");
  const left = readdirSync(d).sort();
  assert.ok(!left.includes("cccccccc-0000.json"), `three days old, removed: ${left.join(" ")}`);
  assert.ok(left.includes("99999999-0000.json"), "yesterday's kept");
  // the next day: yesterday's file now holds no kept day... still yesterday's day before: kept until it is two days old
  c.t += 2 * DAY;
  b.header();
  assert.ok(!readdirSync(d).includes("99999999-0000.json"), "removed once its day is past yesterday");
});

test("NEAR_KEY_DAY: unset or empty is 300,000; a whole number above 0 is taken; anything else stops the start, naming the variable, never the value", () => {
  assert.equal(NEAR_KEY_DAY_DEFAULT, 300_000);
  assert.equal(nearKeyDayOf({}), 300_000);
  assert.equal(nearKeyDayOf({ NEAR_KEY_DAY: "" }), 300_000);
  assert.equal(nearKeyDayOf({ NEAR_KEY_DAY: "120000" }), 120_000);
  for (const v of ["0", "-5", "1.5", "1e5", "abc", " 5"]) assert.throws(() => nearKeyDayOf({ NEAR_KEY_DAY: v }), (e: Error) => e.message === "NEAR_KEY_DAY must be a whole number above 0", v);
});

test("the counts are written and re-read as often as the keyed day files (limits.ts DAY_SYNC_MS)", () => {
  assert.equal(SYNC_MS, DAY_SYNC_MS);
});
