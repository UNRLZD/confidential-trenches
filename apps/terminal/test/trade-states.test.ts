// The trade box's other states (card app-trade-box-states; A2.3, app.md:1448; 09-design-brief S8.11, S8.23, S8.24,
// S8.28, S8.32, S8.35, S8.36; CH-045, CH-050): Slow past 5 s while a trade is still Sending or Landing, and how a trade
// the kit ended is drawn: Failed with the reason for the kit's code, Not landed, part filled with the count when the
// kit gives it, each with Retry on the main button. One model for the buy and the sell side.
import assert from "node:assert/strict";
import { test } from "node:test";
import { endView, isSlow, progress, READY, showsRetry, SLOW_MS, tap } from "../src/screens/trade/model.ts";
import type { Phase } from "../src/screens/trade/model.ts";
import { WORDS } from "../src/screens/trade/words.ts";

const T0 = Date.parse("2026-11-02T06:00:00Z");

test("Slow: past 5 s from the tap while Sending or Landing, never before, never once the trade ended", () => {
  assert.equal(SLOW_MS, 5_000);
  const s = tap(READY, "b1", T0);
  assert.equal(isSlow(s, T0 + 4_999), false);
  assert.equal(isSlow(s, T0 + 5_000), true);
  const l = progress(s, "b1", "sent", T0 + 150);
  assert.equal(isSlow(l, T0 + 4_999), false);
  assert.equal(isSlow(l, T0 + 6_200), true);
  assert.equal(isSlow(progress(l, "b1", "filled", T0 + 7_000), T0 + 9_000), false);
  assert.equal(isSlow(progress(l, "b1", "not_landed", T0 + 7_000), T0 + 9_000), false);
  assert.equal(isSlow(READY, T0 + 9_000), false);
});

test("Slow never fails a trade: a slow trade still fills or ends only on the kit's stage", () => {
  const l = progress(tap(READY, "b1", T0), "b1", "sent", T0 + 150);
  const late = progress(l, "b1", "filled", T0 + 30_000);
  assert.deepEqual(late, { k: "filled", id: "b1", at: T0, ms: 30_000 });
});

test("an ended trade: a refusal is Failed with its code's reason, not_landed is Not landed, part_filled is partial", () => {
  const s = tap(READY, "b1", T0);
  const end = (stage: "refused" | "not_landed" | "part_filled", code?: string): Phase => ({ k: "ended", id: "b1", at: T0, stage, ...(code ? { code } : {}) });
  assert.deepEqual(endView(end("refused", "quote_check_failed")), { k: "failed", reason: "priceCheck" });
  assert.deepEqual(endView(end("refused", "signpage_down")), { k: "failed", reason: "notSent" });
  // a code the app has no words for: Failed alone, never a made-up reason
  assert.deepEqual(endView(end("refused", "something_new")), { k: "failed", reason: null });
  assert.deepEqual(endView(end("refused")), { k: "failed", reason: null });
  assert.deepEqual(endView(end("not_landed")), { k: "notLanded", reason: null });
  assert.deepEqual(endView(end("part_filled")), { k: "partial", reason: null });
  assert.equal(endView(s), null);
  assert.equal(endView(READY), null);
  assert.equal(endView({ k: "filled", id: "b1", at: T0, ms: 900 }), null);
});

test("Retry only where nothing moved: Failed and Not landed show it, a part fill never does (a retry would trade the whole amount again)", () => {
  const end = (stage: "refused" | "not_landed" | "part_filled"): Phase => ({ k: "ended", id: "b1", at: T0, stage });
  assert.equal(showsRetry(end("refused")), true);
  assert.equal(showsRetry(end("not_landed")), true);
  assert.equal(showsRetry(end("part_filled")), false);
  for (const p of [READY, tap(READY, "b1", T0), { k: "filled", id: "b1", at: T0, ms: 900 } as Phase]) assert.equal(showsRetry(p), false);
});

test("the approved words stay approved: Sending and Landing are Portfolio's own entries, never drafts again", async () => {
  const { WORDS: PF } = await import("../src/screens/portfolio/words.ts");
  assert.equal(WORDS.sending, PF.sending);
  assert.equal(WORDS.landing, PF.landing);
  assert.equal(WORDS.sending.draft, false);
  assert.equal(WORDS.landing.draft, false);
});

test("Retry is a new trade: a tap after an ended one starts Sending with a new id", () => {
  const ended: Phase = { k: "ended", id: "b1", at: T0, stage: "not_landed" };
  assert.deepEqual(tap(ended, "b2", T0 + 9_000), { k: "sending", id: "b2", at: T0 + 9_000 });
});

test("every reason has its word", () => {
  for (const r of ["priceCheck", "notSent"] as const) assert.ok(WORDS[r].text, r);
  for (const w of ["slow", "failed", "notLanded", "retry", "partFilled", "partSold", "filledOf", "soldOf"] as const) assert.ok(WORDS[w].text, w);
});
