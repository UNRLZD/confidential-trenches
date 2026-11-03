// node --test apps/helper/src/data/gecko.test.ts: GeckoTerminal's one budget: at most GT_LIMIT_PER_MIN calls in any
// 60 s across every lane; the lists lane yields to the token page (PAGE_RESERVE kept free, none while a page called in
// the last YIELD_MS, except urgent reads within the lists' own LIST_FLOOR); a 429 pausing every lane.
import assert from "node:assert/strict";
import { test } from "node:test";
import { geckoBudget, GT_LIMIT_PER_MIN, LIST_FLOOR, PAGE_RESERVE, YIELD_MS } from "./gecko.ts";

test("the measured keyless limit: 5 calls a minute from one address (the published 10 met 429s)", () => assert.equal(GT_LIMIT_PER_MIN, 5));

test("pages may take the whole minute; the window slides", () => {
  let now = 0;
  const b = geckoBudget(() => now);
  for (let i = 0; i < GT_LIMIT_PER_MIN; i++) assert.equal(b.take("pages"), true);
  assert.equal(b.take("pages"), false, "the minute's total");
  now = 59_999;
  assert.equal(b.take("pages"), false);
  now = 60_000;
  assert.equal(b.take("pages"), true, "a minute after, the first calls have left the window");
});

test("lists yield: they leave PAGE_RESERVE free and take nothing while a page called in the last YIELD_MS, except urgent reads within their own LIST_FLOOR", () => {
  let now = 0;
  const b = geckoBudget(() => now);
  for (let i = 0; i < GT_LIMIT_PER_MIN - PAGE_RESERVE; i++) assert.equal(b.take("lists"), true);
  assert.equal(b.take("lists"), false, "PAGE_RESERVE stays free");
  now = 10_000;
  for (let i = 0; i < PAGE_RESERVE; i++) assert.equal(b.take("pages"), true, "and a page finds it");
  now = 60_000; // the lists' calls have left; the pages' (10 s later) are still in the window
  assert.equal(b.take("lists"), false, "a page called within YIELD_MS: lists wait");
  for (let i = 0; i < LIST_FLOOR; i++) assert.equal(b.take("lists", true), true, "an urgent list read goes, within the floor");
  assert.equal(b.take("lists", true), false, "past the floor an urgent read yields too");
  assert.equal(b.take("pages"), true, "the minute's last call is a page's");
  assert.equal(b.take("pages"), false);
  now = YIELD_MS * 2 + 1;
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
  assert.equal(b.retryAt("pages"), 1_000_000 + 60_000, "the minute's oldest call");
  b.pause(t + 120_000);
  assert.equal(b.retryAt("pages"), t + 120_000, "a pause past it");
});
