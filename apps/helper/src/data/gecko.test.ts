// node --test apps/helper/src/data/gecko.test.ts: GeckoTerminal's one budget: at most GT_LIMIT_PER_MIN calls in any
// 60 s across every lane; the lists lane yields to the token page (PAGE_RESERVE kept free, none while a page called in
// the last YIELD_MS, except urgent reads within the lists' own LIST_FLOOR); a 429 pausing every lane.
import assert from "node:assert/strict";
import { test } from "node:test";
import { geckoBudget, GT_LIMIT_PER_MIN, LIST_FLOOR, PAGE_RESERVE, throttledUntil, WINDOW_MS } from "./gecko.ts";

test("the measured keyless limit: 5 calls a minute from one address (the published 10 met 429s)", () => assert.equal(GT_LIMIT_PER_MIN, 5));

test("pages may take the whole minute; the window slides", () => {
  let now = 0;
  const b = geckoBudget(() => now);
  for (let i = 0; i < GT_LIMIT_PER_MIN; i++) assert.equal(b.take("pages"), true);
  assert.equal(b.take("pages"), false, "the minute's total");
  now = WINDOW_MS - 1;
  assert.equal(b.take("pages"), false);
  now = WINDOW_MS;
  assert.equal(b.take("pages"), true, "WINDOW_MS after, the first calls have left the window");
});

test("lists yield: they leave PAGE_RESERVE free and take nothing while a page called in the last YIELD_MS, except urgent reads within their own LIST_FLOOR", () => {
  let now = 0;
  const b = geckoBudget(() => now);
  for (let i = 0; i < GT_LIMIT_PER_MIN - PAGE_RESERVE; i++) assert.equal(b.take("lists"), true);
  assert.equal(b.take("lists"), false, "PAGE_RESERVE stays free");
  now = 20_000;
  for (let i = 0; i < PAGE_RESERVE; i++) assert.equal(b.take("pages"), true, "and a page finds it");
  now = WINDOW_MS; // the lists' calls have left; the pages' (20 s later) are still in the window, and within YIELD_MS
  assert.equal(b.take("lists"), false, "a page called within YIELD_MS: lists wait");
  for (let i = 0; i < LIST_FLOOR; i++) assert.equal(b.take("lists", true), true, "an urgent list read goes, within the floor");
  assert.equal(b.take("lists", true), false, "past the floor an urgent read yields too");
  assert.equal(b.take("pages"), true, "the minute's last call is a page's");
  assert.equal(b.take("pages"), false);
  now = WINDOW_MS * 2;
  assert.equal(b.take("lists"), true, "no page in the last YIELD_MS: lists go again");
});

test("a 429 pauses every lane until its time", () => {
  let now = 0;
  const b = geckoBudget(() => now);
  b.pause(30_000);
  assert.equal(b.take("lists", true), false);
  assert.equal(b.take("pages"), false);
  now = 30_000;
  assert.equal(b.take("pages"), true);
});

test("retryAt: now when a page call can be taken; else the pause's end or when the minute's oldest call leaves the window", () => {
  let t = 1_000_000;
  const b = geckoBudget(() => t, 3);
  assert.equal(b.retryAt("pages"), t);
  b.take("pages");
  t += 10_000;
  b.take("pages");
  b.take("pages");
  assert.equal(b.retryAt("pages"), 1_000_000 + WINDOW_MS, "the window's oldest call");
  b.pause(t + 120_000);
  assert.equal(b.retryAt("pages"), t + 120_000, "a pause past it");
});

test("the log's shape: 3 calls, 2 more 58 s later, then one at 63 s is refused here, where GeckoTerminal answered 429 (15:37:11Z, 15:38:09Z, 15:38:14Z: 3 calls in the 60 s before it)", () => {
  let now = 0;
  const b = geckoBudget(() => now);
  for (let i = 0; i < 3; i++) assert.equal(b.take("lists", true) || b.take("pages"), true);
  now = 58_000;
  for (let i = 0; i < 2; i++) assert.equal(b.take("pages"), true);
  now = 63_000;
  assert.equal(b.take("pages"), false, "5 calls in the last 75 s: GeckoTerminal's 429, so not sent");
  assert.equal(b.retryAt("pages"), WINDOW_MS, "the wait named is exact: when the first call leaves the window");
  now = WINDOW_MS;
  assert.equal(b.take("pages"), true);
});

test("GeckoTerminal's 429: its Retry-After when it names one (at most 300 s), else WINDOW_MS, for every lane", () => {
  for (const [ra, ms] of [["30", 30_000], ["0", WINDOW_MS], [null, WINDOW_MS], ["soon", WINDOW_MS], ["9999", 300_000]] as const) {
    let now = 1_000;
    const b = geckoBudget(() => now);
    assert.equal(throttledUntil(b, ra, now), 1_000 + ms, String(ra));
    now = 1_000 + ms - 1;
    assert.deepEqual([b.take("pages"), b.take("lists", true)], [false, false], String(ra));
    now = 1_000 + ms;
    assert.equal(b.take("pages"), true, String(ra));
  }
});

test("card app-console-429: a refresh (a re-read of data held) takes a call only while COLD_RESERVE stay free for a cold page read", async () => {
  const { geckoBudget: budget, COLD_RESERVE: reserve, GT_LIMIT_PER_MIN: perMin } = await import("./gecko.ts");
  const t = 1_800_000_000_000;
  const b = budget(() => t);
  for (let i = 0; i < perMin - reserve - 1; i++) assert.equal(b.take("pages"), true);
  assert.equal(b.take("refresh"), true, "room past the reserve: the refresh goes");
  assert.equal(b.take("refresh"), false, "only the reserve left: the refresh yields");
  for (let i = 0; i < reserve; i++) assert.equal(b.take("pages"), true, "which a cold page read finds");
  assert.equal(b.take("pages"), false);
});

test("card helper-chart-fresh: the newest data held is a refresh until REFRESH_URGENT_MS old, then a page read; nothing held is a page read", async () => {
  const { refreshLane, REFRESH_URGENT_MS: urgent } = await import("./gecko.ts");
  const { CANDLES_FRESH_MS } = await import("./solana/token.ts");
  const t = 1_800_000_000_000;
  assert.equal(refreshLane(null, t), "pages", "nothing held: a first read");
  assert.equal(refreshLane(t, t), "refresh", "just read");
  assert.equal(refreshLane(t - urgent + 1, t), "refresh", "a millisecond short of the bound");
  assert.equal(refreshLane(t - urgent, t), "pages", "at the bound");
  assert.equal(refreshLane(t - 86_400_000, t), "pages", "handed over a day old");
  // past the bars' own 60 s, so a chart read often still refreshes in its lane; under the live check's 10 min
  assert.ok(urgent > CANDLES_FRESH_MS && urgent < 600_000, `REFRESH_URGENT_MS ${urgent}`);
});
