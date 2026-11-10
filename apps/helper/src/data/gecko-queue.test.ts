// node --test apps/helper/src/data/gecko-queue.test.ts: card market-reads-hold-under-load. GeckoTerminal's one keyless
// budget (gecko.ts) gives a caller's cold page read its turn: first in, first out among the reads waiting, no background
// lane taking a freed call while one waits, and no caller holding the whole window. Fake clock, no real time: each
// test counts takes and waits. Shapes from the deployed helper's minute lines on 10 Nov 19:43-19:45Z: the window full
// of the lists' and the history seeds' calls, then "refused: pages 6" with nothing called.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GT_PAGE_WAIT_MS, geckoBudget, PAGE_PER_CLIENT, takeOrWait, WINDOW_MS } from "./gecko.ts";

const T0 = 1_800_000_000_000;

test("a page read waiting for the window's next call gets it: the lists, urgent, do not take it first", async () => {
  const clock = { t: T0 };
  const b = geckoBudget(() => clock.t, 5);
  // the window full: its oldest call leaves 2 s from now
  b.seed([T0 - WINDOW_MS + 2_000, T0 - 1_000, T0 - 1_000, T0 - 1_000], "seed");
  assert.equal(b.take("lists", true), true);
  let listsTook: boolean | undefined;
  const sleep = async (ms: number) => {
    clock.t += ms;
    // the freed call: the lists ask for it before the waiting page read wakes
    listsTook ??= b.take("lists", true);
  };
  const at = await takeOrWait(b, "pages", "base info", clock.t + GT_PAGE_WAIT_MS, () => clock.t, sleep, "caller-a");
  assert.equal(listsTook, false, "the lists wait while a page read does");
  assert.equal(at, null, "the page read took the freed call");
});

test("page reads waiting take freed calls in the order they came", () => {
  const clock = { t: T0 };
  const b = geckoBudget(() => clock.t, 5);
  b.seed([T0 - WINDOW_MS + 1_000, T0 - WINDOW_MS + 2_000, T0 - 1_000, T0 - 1_000, T0 - 1_000], "seed");
  const first = b.queue("caller-a");
  const second = b.queue("caller-b");
  assert.ok(b.retryAt("pages", second) > b.retryAt("pages", first), "the second's wait is the call after the first's");
  clock.t += 1_000;
  assert.equal(b.take("pages", false, false, "", { ticket: second, client: "caller-b" }), false, "not its turn");
  assert.equal(b.take("pages", false, false, "", { client: "caller-c" }), false, "a new read does not jump the queue");
  assert.equal(b.take("pages", false, false, "", { ticket: first, client: "caller-a" }), true);
  b.leave(first);
  clock.t += 1_000;
  assert.equal(b.take("pages", false, false, "", { ticket: second, client: "caller-b" }), true);
});

test("caller A asks five tokens nobody holds, then caller B one: A gets four at once, B is served inside its wait, A's fifth waits its turn", async () => {
  const clock = { t: T0 };
  const b = geckoBudget(() => clock.t, 5);
  let waits = 0;
  const sleep = async (ms: number) => {
    waits++;
    clock.t += ms;
  };
  const read = (client: string) => takeOrWait(b, "pages", "base info", clock.t + GT_PAGE_WAIT_MS, () => clock.t, sleep, client);
  const a = [];
  for (let i = 0; i < 4; i++) a.push(await read("caller-a"));
  assert.deepEqual(a, [null, null, null, null], "a lone caller's first four at once");
  assert.equal(waits, 0, "with no wait");
  const fifth = await read("caller-a");
  assert.equal(fifth, T0 + WINDOW_MS, "the fifth: the window's last call is kept for someone else, its wait the oldest call's leaving");
  assert.equal(waits, 0, "past its bound at once: no spin");
  assert.equal(await read("caller-b"), null, "caller B's first read is served");
  assert.equal(b.calls().length, 5);
});

test("a lone caller gets four calls with no wait, and its share is its own: two callers each get theirs", async () => {
  const clock = { t: T0 };
  const b = geckoBudget(() => clock.t, 5);
  let waits = 0;
  const sleep = async (ms: number) => void ((waits++, (clock.t += ms)));
  for (let i = 0; i < 4; i++) assert.equal(await takeOrWait(b, "pages", "sol bars", clock.t + GT_PAGE_WAIT_MS, () => clock.t, sleep, "caller-a"), null);
  assert.equal(waits, 0);
  const c = geckoBudget(() => clock.t, 5);
  for (let i = 0; i < PAGE_PER_CLIENT; i++) assert.equal(c.take("pages", false, false, "", { client: "caller-a" }), true);
  for (let i = 0; i < PAGE_PER_CLIENT; i++) assert.equal(c.take("pages", false, false, "", { client: "caller-b" }), true);
});

test("while one caller holds more than its share, no background lane takes the window's last call; a page read of another caller does", () => {
  const clock = { t: T0 };
  const b = geckoBudget(() => clock.t, 5);
  for (let i = 0; i < 4; i++) assert.equal(b.take("pages", false, false, "", { client: "caller-a" }), true);
  for (const lane of ["lists", "ahead", "refresh", "stale", "optional"]) assert.equal(b.take(lane, true, true), false, lane);
  assert.equal(b.take("pages", false, false, "", { client: "caller-a" }), false, "nor caller A itself");
  assert.equal(b.take("pages", false, false, "", { client: "caller-b" }), true);
});

test("a caller with another waiting takes nothing past its share; the waiter goes first", () => {
  const clock = { t: T0 };
  const b = geckoBudget(() => clock.t, 5);
  for (let i = 0; i < PAGE_PER_CLIENT; i++) assert.equal(b.take("pages", false, false, "", { client: "caller-a" }), true);
  b.seed([T0 - 1_000, T0 - 1_000, T0 - 1_000], "seed");
  const w = b.queue("caller-b");
  clock.t += WINDOW_MS - 999; // the seeded calls leave; caller A's two stay
  assert.equal(b.take("pages", false, false, "", { client: "caller-a" }), false, "past its share while B waits");
  assert.equal(b.take("pages", false, false, "", { ticket: w, client: "caller-b" }), true);
});

test("the caller's key is in no count line and no call list the warm file takes", () => {
  const clock = { t: T0 };
  const b = geckoBudget(() => clock.t, 5);
  b.take("pages", false, false, "base info", { client: "203.0.113.7" });
  b.take("pages", false, false, "base info", { client: "203.0.113.7" });
  const line = b.minute() ?? "";
  assert.ok(!line.includes("203.0.113.7"), line);
  assert.ok(b.calls().every((t) => typeof t === "number"));
  assert.ok(!JSON.stringify(b.calls("pages")).includes("203"));
});

test("the EVM history seed (an optional read: the chart answers our own bars without it) leaves a cold page its two calls and never makes the lists yield", async () => {
  const { SEED_LANE, COLD_RESERVE } = await import("./gecko.ts");
  const clock = { t: T0 };
  const b = geckoBudget(() => clock.t, 5);
  for (let i = 0; i < 5 - COLD_RESERVE; i++) assert.equal(b.take(SEED_LANE), true);
  assert.equal(b.take(SEED_LANE), false, "the seeds stop at three of five (they took four in the stale lane, 19:43Z)");
  assert.equal(b.take("pages", false, false, "", { client: "caller-a" }), true);
  assert.equal(b.take("pages", false, false, "", { client: "caller-b" }), true);
  const c = geckoBudget(() => clock.t, 5);
  assert.equal(c.take(SEED_LANE), true);
  assert.equal(c.take("lists", true, true), true, "a seed is a background read: the lists do not yield to it");
});
