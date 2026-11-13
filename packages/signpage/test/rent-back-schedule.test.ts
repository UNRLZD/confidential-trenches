// Card round-trip-costs-less (a): the rent backs ran once per page load (pool-testnet.ts backsResumed), so a W left by a
// provider's fault waited for a reload. They now run on the page's own state reads while a W is left to try, at a
// doubling wait, and stop when none is left, with no timer of their own (src/pool-testnet.ts backsSchedule).
//   node --test test/rent-back-schedule.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKS_FIRST_MS, BACKS_LOAD_MAX_MS, BACKS_LOAD_MIN_MS, BACKS_MAX_MS, backsSchedule } from "../src/pool-testnet.ts";

test("the first state read runs; none while one runs; a run with a W left books the next at a doubling wait to the most", () => {
  let t = 1_000;
  const s = backsSchedule(() => t, 0);
  assert.equal(s.take(), true, "the load's first state read");
  assert.equal(s.take(), false, "one run at a time");
  s.ended(true);
  assert.equal(s.take(), false, "before the wait");
  t += BACKS_FIRST_MS;
  assert.equal(s.take(), true, "after the first wait");
  s.ended(true);
  t += BACKS_FIRST_MS;
  assert.equal(s.take(), false, "the wait doubled");
  t += BACKS_FIRST_MS;
  assert.equal(s.take(), true);
  for (let i = 0; i < 10; i++) {
    s.ended(true);
    t += BACKS_MAX_MS;
    assert.equal(s.take(), true, "never past the most");
  }
});

test("a run with nothing left stops the runs until a full sell writes a new owed record", () => {
  let t = 0;
  const s = backsSchedule(() => t, 0);
  assert.equal(s.take(), true);
  s.ended(false);
  t += 10 * BACKS_MAX_MS;
  assert.equal(s.take(), false, "nothing left: no run, however long");
  s.again();
  assert.equal(s.take(), true, "a new owed record: the next state read runs");
  s.ended(true);
  s.again();
  assert.equal(s.take(), true, "a new record also cuts a booked wait");
  s.ended(true);
  t += BACKS_FIRST_MS;
  assert.equal(s.take(), true, "and the wait starts again from the first");
});

// review P2-1 of 024e8a89d: a load's first run waits a time drawn once a load from 15 to 60 s, so no leftover W's pass
// goes at the instant the page opens; a full sell's `again` never runs it sooner
test("a load's first run waits its drawn start, 15 to 60 s, a full sell's again included; the draw is in bounds", () => {
  let t = 1_000;
  const s = backsSchedule(() => t, 20_000);
  assert.equal(s.take(), false, "the page just opened");
  s.again();
  assert.equal(s.take(), false, "a full sell does not cut the load's start");
  t += 19_999;
  assert.equal(s.take(), false);
  t += 1;
  assert.equal(s.take(), true, "at the drawn start");
  s.ended(false);
  s.again();
  assert.equal(s.take(), true, "past the start, again runs at the next state read");
  // the default draw: a first run never before 15 s nor after 60 s
  for (let i = 0; i < 200; i++) {
    let u = 0;
    const d = backsSchedule(() => u);
    u = BACKS_LOAD_MIN_MS - 1;
    assert.equal(d.take(), false, "before 15 s");
    u = BACKS_LOAD_MAX_MS;
    assert.equal(d.take(), true, "by 60 s");
  }
});
