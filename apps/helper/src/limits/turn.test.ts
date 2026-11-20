// node --test apps/helper/src/limits/turn.test.ts: card helper-loop-never-held-by-a-write. A sliced job gives the loop back
// once its turn's slice is spent, and the jobs waiting resume one a turn, first come first served, so many at once never
// add up in one turn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TURN_MS, turnSlicer } from "./turn.ts";

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
  // a timer set now fires on the loop's next turn: after the first waiter, before the last
  setTimeout(() => order.push("timer"), 0);
  await Promise.all(jobs);
  assert.deepEqual(order.filter((k) => k !== "timer"), ["a", "b", "c"]);
  assert.ok(order.indexOf("timer") > 0 && order.indexOf("timer") < 3, order.join(","));
});
