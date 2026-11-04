// A list the helper serves from an older read shows its age (card app-list-age). Since app-console-429 the helper answers
// its last good read, dated by as_of_ms, and never a 503 once it has one: a list can be hours old on a 200. Discover draws
// how old it is once it is older than 60 s, counted from the list's own read time, and the 60 s rule for a failed re-read
// counts from that time too, never from the last good HTTP answer.
//   node --test apps/terminal/test/list-age.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { keepOnFail, STALE_MS } from "../src/screens/discover/data.ts";
import { listAge } from "../src/screens/discover/model.ts";
import { ageLine, WORDS } from "../src/screens/discover/words.ts";

const NOW = Date.parse("2026-11-04T13:00:00Z");
const MIN = 60_000;

test("a fresh list draws no age; one older than 60 s draws its age from its own read time", () => {
  assert.equal(listAge(NOW, NOW), null);
  assert.equal(listAge(NOW - 12_000, NOW), null);
  assert.equal(listAge(NOW - STALE_MS, NOW), null);
  assert.equal(listAge(NOW - STALE_MS - 1, NOW), "1m");
  assert.equal(listAge(NOW - 12 * MIN, NOW), "12m");
  assert.equal(listAge(NOW - 59 * MIN - 59_000, NOW), "59m");
  assert.equal(listAge(NOW - 2 * 60 * MIN, NOW), "2h");
  assert.equal(listAge(NOW - (2 * 60 + 59) * MIN, NOW), "2h");
  assert.equal(listAge(NOW - 3 * 24 * 60 * MIN, NOW), "3d");
  // a read time ahead of this device's clock is not an age
  assert.equal(listAge(NOW + 5 * MIN, NOW), null);
});

test("the age line is the draft words with the age in them, marked a draft until the owner picks", () => {
  assert.equal(ageLine("2h"), "Updated 2h ago");
  assert.equal(ageLine("12m"), "Updated 12m ago");
  assert.equal(WORDS.updated.draft, true);
});

test("a failed re-read keeps the lists only while their own read is at most 60 s old", () => {
  assert.equal(keepOnFail(NOW - 30_000, NOW), true);
  assert.equal(keepOnFail(NOW - STALE_MS, NOW), true);
  // a list the helper served 2 h old, then a failed read: the screen goes to Offline, whatever the last 200 was
  assert.equal(keepOnFail(NOW - 2 * 60 * MIN, NOW), false);
  // nothing read yet
  assert.equal(keepOnFail(null, NOW), false);
});
