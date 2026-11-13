// Card round-trip-costs-less (a): the rent backs ran once per page load (pool-testnet.ts backsResumed), so a W left by a
// provider's fault waited for a reload. They now run on the page's own state reads while a W is left to try, at a
// doubling wait, and stop when none is left, with no timer of their own (src/pool-testnet.ts backsSchedule).
//   node --test test/rent-back-schedule.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKS_FIRST_MS, BACKS_LOAD_MAX_MS, BACKS_LOAD_MIN_MS, BACKS_MAX_MS, backsSchedule, rideAfter } from "../src/pool-testnet.ts";
import { owedRentBacks, POOL_RENT_BACK_SPACE_MAX_MS, POOL_RENT_BACK_SPACE_MIN_MS } from "../src/pool-sell.ts";

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

// Card every-lamport-can-move T3: a withdraw tap's end, or a deposit's note landing, books the ride (ride): a run past
// the ride's time is the tap's pass over the leftover Ws (resumeRentBacks with ride); a plain load's run never rides.
// Review P2-1 of 1d3b96d9c: the ride's time is drawn after the tap from the spacing's gap (rideAfter), never the tap's
// next state read, so no network ties a leftover W's release and sweep to the public deposit or withdraw by timing.
test("a tap's ride never runs before a gap drawn after the tap: none at the next state read, none a minute under the least gap, then the run rides", () => {
  let t = 1_000;
  const s = backsSchedule(() => t, BACKS_LOAD_MIN_MS);
  t += BACKS_LOAD_MAX_MS;
  assert.equal(s.take(), true, "the load's first run");
  assert.equal(s.takeRide(), undefined, "a plain load never rides");
  s.ended(false);
  t += 3_600_000;
  const tap = t;
  s.ride(rideAfter(tap));
  t += 1;
  assert.equal(s.take(), false, "not at the tap's next state read");
  t = tap + POOL_RENT_BACK_SPACE_MIN_MS - 60_000;
  assert.equal(s.take(), false, "not inside the least gap");
  t = tap + POOL_RENT_BACK_SPACE_MAX_MS;
  assert.equal(s.take(), true, "past the most gap: the ride's run");
  assert.ok(s.takeRide() !== undefined, "it rides");
});

test("the ride's time is drawn after the tap, within the spacing's gap, and not one time every tap", () => {
  const got = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const at = rideAfter(5_000_000);
    assert.ok(at >= 5_000_000 + POOL_RENT_BACK_SPACE_MIN_MS && at <= 5_000_000 + POOL_RENT_BACK_SPACE_MAX_MS, String(at));
    got.add(at);
  }
  assert.ok(got.size > 100, `drawn: ${got.size} distinct of 200`);
});

// Review P3 1 of 1d3b96d9c: a ride whose run was held (the spacing, a trade running) stays booked until a run rides it
// with nothing held (rode); a later tap's booking moves it later, never earlier; rode of an older time keeps a newer one
test("a held ride stays booked; rode ends it; a second tap moves it later, never earlier", () => {
  let t = 1_000;
  const s = backsSchedule(() => t, 0);
  assert.equal(s.take(), true);
  s.ended(false);
  s.ride(t + 600_000);
  t += 600_000;
  assert.equal(s.take(), true);
  const first = s.takeRide();
  assert.equal(first, 1_000 + 600_000);
  // that run's pass was held: no rode, so the next run rides again
  s.ended(true);
  t += BACKS_FIRST_MS;
  assert.equal(s.take(), true);
  assert.equal(s.takeRide(), first, "still booked");
  s.ended(false);
  // a later tap books later: the earlier time does not run it
  s.ride(t + 1_200_000);
  s.ride(t + 600_000);
  t += 600_000;
  assert.equal(s.take(), false, "the later booking holds");
  t += 600_000;
  assert.equal(s.take(), true);
  const second = s.takeRide()!;
  s.rode(first!);
  assert.equal(s.takeRide(), second, "rode of the older time keeps the newer");
  s.rode(second);
  s.ended(false);
  t += 3_600_000;
  assert.equal(s.take(), false, "ridden: nothing booked");
  assert.equal(s.takeRide(), undefined);
});

// Review P2-1 of 1d3b96d9c: the booking on the record, so a page closed before its time rides at a later load
test("the ride's booking on the record: read back, kept at the latest, ended by rode of that time alone", async () => {
  const mem = new Map<string, unknown>();
  const owed = owedRentBacks(async () => ({ get: async (_s: string, k: string) => structuredClone(mem.get(k)), update: async (_s: string, k: string, f: (v: unknown) => unknown) => void (((v) => v !== undefined && mem.set(k, structuredClone(v)))(f(structuredClone(mem.get(k))))) }) as never, {} as never);
  assert.equal(await owed.rideAt!(), undefined);
  await owed.bookRide!(2_000);
  await owed.bookRide!(1_500);
  assert.equal(await owed.rideAt!(), 2_000, "the later booking kept");
  await owed.rode!(1_500);
  assert.equal(await owed.rideAt!(), 2_000, "rode of another time keeps it");
  await owed.rode!(2_000);
  assert.equal(await owed.rideAt!(), undefined);
});
