// untilAborted ends at once on a signal aborted before it began, and on one aborted later (card
// aborted-signal-waits-end-at-once). Each test has its own short bound, so a wait that never ends fails, never hangs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { untilAborted } from "../src/index.ts";

const B = { timeout: 2_000 };

test("a signal aborted before the wait began ends it at once, with its reason", B, async () => {
  const c = new AbortController();
  const why = new Error("gone");
  c.abort(why);
  await assert.rejects(untilAborted(c.signal), (e) => e === why);
});

test("AbortSignal.abort() too (its event fired at its birth)", B, async () => {
  await assert.rejects(untilAborted(AbortSignal.abort("x")), (e) => e === "x");
});

test("a signal aborted while the wait listens ends it with its reason", B, async () => {
  const c = new AbortController();
  const p = untilAborted(c.signal);
  queueMicrotask(() => c.abort("later"));
  await assert.rejects(p, (e) => e === "later");
});

test("no signal: the wait never settles", B, async () => {
  const p = untilAborted(undefined);
  const r = await Promise.race([p.then(() => "settled", () => "settled"), new Promise((ok) => setTimeout(ok, 20, "open"))]);
  assert.equal(r, "open");
});
