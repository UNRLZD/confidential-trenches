// node --test apps/helper/src/data/gecko.test.ts: GeckoTerminal's one budget: at most 10 calls in any 60 s across every
// lane, each lane held to its cap, a 429 pausing every lane.
import assert from "node:assert/strict";
import { test } from "node:test";
import { geckoBudget, GT_LIMIT_PER_MIN } from "./gecko.ts";

test("the published keyless limit: 10 calls a minute", () => assert.equal(GT_LIMIT_PER_MIN, 10));

test("lanes share the minute's 10 calls and each keeps to its cap; the window slides", () => {
  let now = 0;
  const b = geckoBudget(() => now, { lists: 3, pages: 7 });
  for (let i = 0; i < 3; i++) assert.equal(b.take("lists"), true);
  assert.equal(b.take("lists"), false, "the lists lane's cap");
  for (let i = 0; i < 7; i++) assert.equal(b.take("pages"), true);
  assert.equal(b.take("pages"), false, "the pages lane's cap and the minute's total");
  now = 59_999;
  assert.equal(b.take("lists"), false);
  now = 60_000;
  assert.equal(b.take("lists"), true, "a minute after, the first calls have left the window");
});

test("with no caps a lane may take all 10; an 11th call is refused", () => {
  const b = geckoBudget(() => 0);
  for (let i = 0; i < 10; i++) assert.equal(b.take("pages"), true);
  assert.equal(b.take("lists"), false);
});

test("a 429 pauses every lane until its time", () => {
  let now = 0;
  const b = geckoBudget(() => now, { lists: 3, pages: 7 });
  b.pause(30_000);
  assert.equal(b.take("lists"), false);
  assert.equal(b.take("pages"), false);
  now = 30_000;
  assert.equal(b.take("pages"), true);
});
