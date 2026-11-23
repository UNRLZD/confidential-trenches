// Card virtual-clock-skips-idle: onVirtualTime moves its clock to the next timer's ms when the run has nothing else to
// do, and 1 ms at a time otherwise, so every timer fires at the ms, and in the order, it fired at 1 ms at a time. Turns
// are counted, never the machine's clock (scripts/ci/no-wall-clock-asserts.test.mjs).
import assert from "node:assert/strict";
import timers from "node:timers";
import { test } from "node:test";
import { onVirtualTime } from "./evm-swaps/virtual-time.ts";

const START = 9_000_000;
const sleep = (ms: number) => new Promise<void>((go) => setTimeout(go, ms));

test("a run that only waits moves to each timer's ms in one tick: a 60 s wait is a few turns, not 480,000", async () => {
  let turns = 0;
  const { ms } = await onVirtualTime(START, () => sleep(60_000), () => turns++);
  assert.equal(ms, 60_000);
  assert.ok(turns < 100, `${turns} turns for one 60 s wait`);
});

test("timers fire at their own ms and in their order, ties by the order they were set", async () => {
  const { value } = await onVirtualTime(START, async () => {
    const fired: string[] = [];
    const at = (name: string, ms: number) => new Promise<void>((go) => setTimeout(() => (fired.push(`${name}@${Date.now() - START}`), go()), ms));
    await Promise.all([at("a", 300), at("b", 5), at("c", 5), at("d", 17), at("e", 1.5), at("f", 0)]);
    await sleep(40);
    await at("g", 2_000);
    return fired;
  });
  assert.deepEqual(value, ["f@1", "e@2", "b@5", "c@5", "d@17", "a@300", "g@2340"]);
});

test("while an immediate the run set is waiting the clock moves 1 ms at a time: a 20-hop chain ends at 2 ms, a timer at 1,000 still pending", async () => {
  const { value } = await onVirtualTime(START, async () => {
    const late = sleep(1_000);
    let hops = 0;
    await new Promise<void>((go) => {
      const hop = () => (++hops === 20 ? go() : setImmediate(hop));
      setImmediate(hop);
    });
    const end = Date.now() - START;
    await late;
    return { end, after: Date.now() - START };
  });
  assert.deepEqual(value, { end: 2, after: 1_000 });
});

test("a timer set past the wrapper (node:timers' own setTimeout) keeps the run at 1 ms steps: it fires at its ms, never at the next known timer's", async () => {
  let turns = 0;
  const { value } = await onVirtualTime(
    START,
    async () => {
      const fired: number[] = [];
      const known = sleep(1_000).then(() => fired.push(Date.now() - START));
      await new Promise<void>((go) => timers.setTimeout(() => (fired.push(Date.now() - START), go()), 50));
      await known;
      return fired;
    },
    () => turns++,
  );
  assert.deepEqual(value, [50, 1_000]);
  assert.ok(turns >= 8 * 1_000, `${turns} turns: the run jumped past a timer it did not know`);
});
