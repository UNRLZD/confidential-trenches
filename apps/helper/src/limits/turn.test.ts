// node --test apps/helper/src/limits/turn.test.ts: card helper-loop-never-held-by-a-write. A sliced job gives the loop back
// once its turn's slice is spent, and the jobs waiting resume one a turn, first come first served, so many at once never
// add up in one turn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { onVirtualTime } from "../../test/evm-swaps/virtual-time.ts";
import { pass, TURN_MS, turnSlicer } from "./turn.ts";

test("pass() is null while the slice has room, a promise once it is spent; the slice starts again when it resumes", async () => {
  let t = 0;
  const s = turnSlicer(() => t);
  assert.equal(s.pass(), null);
  t = TURN_MS - 1;
  assert.equal(s.pass(), null);
  t = TURN_MS;
  const w = s.pass();
  assert.ok(w instanceof Promise);
  await w;
  assert.equal(s.pass(), null, "a fresh slice once resumed");
});

test("waiters resume one a turn of the loop, in the order they asked: a timer due meanwhile fires between them", async () => {
  let t = 0;
  const s = turnSlicer(() => t);
  t = TURN_MS;
  const order: string[] = [];
  // each job, once resumed, works 3 ms of the real clock (so the timer below is due by the second turn)
  const work = () => {
    const until = performance.now() + 3;
    while (performance.now() < until);
  };
  const jobs = ["a", "b", "c"].map((k) => s.pass()!.then(() => (order.push(k), work(), (t += TURN_MS))));
  // a timer set now is due within a turn of the first: it fires before the last waiter resumes, never after all of them
  // (whether before or after the first depends on the phase the loop is in, which the test does not set)
  setTimeout(() => order.push("timer"), 0);
  await Promise.all(jobs);
  assert.deepEqual(order.filter((k) => k !== "timer"), ["a", "b", "c"]);
  assert.ok(order.indexOf("timer") < order.indexOf("c"), order.join(","));
});

test("a run on virtual time slices the shared slicer on its own clock, and the machine's clock takes it back after: where a run's slices fall never moves with how late the machine's clock read when it started (README run 45337579406: swaps-back-resume's 12 Robinhood coins filled at other times than on a quick machine, one past 45 s; the shared slice's start was the machine's time at load, set against the run's clock from 0)", async () => {
  const spin = (ms: number) => {
    const until = performance.now() + ms;
    while (performance.now() < until);
  };
  // the shared slice started on the machine's clock well into the process, as a busy runner's slow load leaves it
  spin(Math.max(0, 300 - performance.now()));
  spin(TURN_MS + 1);
  await pass();
  const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));
  const { value } = await onVirtualTime(9_000_000, async () => {
    const atStart = pass();
    await sleep(TURN_MS + 5);
    const spent = pass();
    await spent;
    // a minute on, a slice spent and resumed: the run leaves its slice at 60 s of its own clock
    await sleep(60_000);
    await pass();
    return { atStart: atStart === null, spent: spent instanceof Promise };
  });
  assert.deepEqual(value, { atStart: true, spent: true }, "a slice spent TURN_MS + 5 ms into the run");
  // back on the machine's clock: a slice starts at the run's end, and is spent once TURN_MS of it has passed
  assert.equal(pass(), null);
  spin(TURN_MS + 1);
  const after = pass();
  assert.ok(after instanceof Promise, "a slice spent on the machine's clock after the run");
  await after;
});
