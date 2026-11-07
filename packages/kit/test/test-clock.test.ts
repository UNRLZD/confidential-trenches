// The test clock's own checks (card fresh-run-margin): test/test-clock.ts skips idle time only, runs a test's work out
// before the next test, and fails a test whose timers never stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { onTestClock } from "./test-clock.ts";

test("a wait is skipped, never shortened: 10 s of timers end at once, both clocks read 10 s on, in order of time", async () => {
  const real = process.hrtime.bigint();
  const date = Date.now();
  const order: number[] = [];
  const read = await onTestClock(async () => {
    const t = performance.now();
    await Promise.all([3_000, 10_000, 1_000].map((ms) => new Promise((r) => setTimeout(() => r(order.push(ms)), ms))));
    return performance.now() - t;
  });
  assert.ok(read >= 10_000, `${read} ms on the clock`);
  assert.ok(Date.now() - date >= 10_000, `${Date.now() - date} ms on Date.now`);
  const ms = Number(process.hrtime.bigint() - real) / 1e6;
  assert.ok(ms < 2_000, `${ms} ms in real time`);
  assert.deepEqual(order, [1_000, 3_000, 10_000]);
});

test("AbortSignal.timeout is on the clock: a request's deadline aborts it at its time", async () => {
  const ms = await onTestClock(async () => {
    const t = performance.now();
    const s = AbortSignal.timeout(5_000);
    await new Promise((r) => s.addEventListener("abort", r));
    assert.equal((s.reason as DOMException).name, "TimeoutError");
    return performance.now() - t;
  });
  assert.ok(ms >= 5_000, `${ms} ms`);
});

test("a test's work left running is run out before the next test: a timer it never awaited still fires inside the clock", async () => {
  let fired = false;
  await onTestClock(async () => void setTimeout(() => (fired = true), 30_000));
  assert.equal(fired, true);
});

test("a test whose timers never stop fails, naming where they were set", async () => {
  const again = () => void setTimeout(again, 1_000);
  await assert.rejects(onTestClock(async () => again()), /left 1 timer\(s\) that never stop: .*test-clock\.test\.ts/);
});

test("a clear of a timer set outside the clock reaches it; a clear of a cleared timer of an earlier run takes out none of a later one", async () => {
  let outside = false;
  const h = setTimeout(() => (outside = true), 20);
  let early: unknown;
  await onTestClock(async () => {
    clearTimeout(h);
    early = setTimeout(() => {}, 5);
    clearTimeout(early as ReturnType<typeof setTimeout>);
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(outside, false);
  let later = false;
  await onTestClock(async () => {
    setTimeout(() => (later = true), 5);
    clearTimeout(early as ReturnType<typeof setTimeout>);
  });
  assert.equal(later, true);
});
