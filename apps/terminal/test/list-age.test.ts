// A list the helper serves from an older read shows its age (card app-list-age). Since app-console-429 the helper answers
// its last good read, dated by as_of_ms, and never a 503 once it has one: a list can be hours old on a 200. Discover draws
// how old it is once it is older than 60 s, counted from the list's own read time. The error state is the other signal,
// the helper not answering: a failed re-read keeps the lists until 60 s pass with no 200, however old the lists are.
//   node --test apps/terminal/test/list-age.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { afterFail, STALE_MS } from "../src/screens/discover/data.ts";
import { listAge } from "../src/screens/discover/model.ts";
import { ageLine, WORDS } from "../src/screens/discover/words.ts";
import { solana } from "./discover-screens/snapshots.ts";

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

test("the age line is the kept words with the age in them, no draft mark (owner 8 Nov 07:55Z, kept)", () => {
  assert.equal(ageLine("2h"), "Updated 2h ago");
  assert.equal(ageLine("12m"), "Updated 12m ago");
  assert.equal(WORDS.updated.draft, false);
});

test("a 2 h old list survives a failed re-read, still drawing its age; the error state comes only after 60 s with no 200", () => {
  const old = { status: "ready", snapshot: { ...solana, as_of_ms: NOW - 2 * 60 * MIN } } as const;
  const age = (d: ReturnType<typeof afterFail>) => (d.status === "ready" ? listAge(d.snapshot.as_of_ms, NOW) : null);
  // the last 200 came 12 s ago, one blip: kept, and the line still says how old the lists are
  const kept = afterFail(old, NOW - 12_000, NOW);
  assert.equal(kept, old);
  assert.equal(ageLine(age(kept) ?? ""), "Updated 2h ago");
  assert.equal(afterFail(old, NOW - STALE_MS, NOW), old);
  // 60 s with no 200: the helper is not answering
  assert.deepEqual(afterFail(old, NOW - STALE_MS - 1, NOW), { status: "error" });
  // a fresh list is held to the same rule
  const fresh = { status: "ready", snapshot: { ...solana, as_of_ms: NOW - 5_000 } } as const;
  assert.deepEqual(afterFail(fresh, NOW - STALE_MS - 1, NOW), { status: "error" });
  // nothing read yet
  assert.deepEqual(afterFail({ status: "loading" }, null, NOW), { status: "error" });
});
