// The trade box's other states (card app-trade-box-states; A2.3, app.md:1448; 09-design-brief S8.11, S8.23, S8.24,
// S8.28, S8.32, S8.35, S8.36; CH-045, CH-050): Slow past 5 s while a trade is still Sending or Landing, and how a trade
// the kit ended is drawn: Failed with the reason for the kit's code, Not landed, part filled with the count when the
// kit gives it, each with Retry on the main button. One model for the buy and the sell side.
import assert from "node:assert/strict";
import { test } from "node:test";
import { endView, isSlow, outcome, progress, READY, showsRetry, SLOW_MS, tap } from "../src/screens/trade/model.ts";
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

// Card pool-buy-filled-2s: a pool buy is Filled once the page tells the amount W received (its route fact "out", read
// at confirmed on both RPCs as this transaction, at least the min out), and Final once the kit's stage "filled" comes
// (the settle at finalized). A later end that is no fill (a fork: not_landed) ends it as the box ends any trade.
import * as model from "../src/screens/trade/model.ts";
const outFilled = (p: Phase, id: string, now: number): Phase => (model as unknown as { filledOut: (p: Phase, id: string, now: number) => Phase }).filledOut(p, id, now);

test("card pool-buy-filled-2s: the route's amount out is Filled with its time from the tap, not Final; the stage filled makes it Final, its time kept", () => {
  const landing = progress(tap(READY, "b1", 1_000), "b1", "sent", 2_000);
  const f = outFilled(landing, "b1", 2_400);
  assert.equal(f.k, "filled");
  assert.equal((f as { ms: number }).ms, 1_400);
  assert.equal((f as { provisional?: true }).provisional, true, "not Final yet");
  assert.ok(!isSlow(f, 9_000), "never Slow once Filled");
  const fin = progress(f, "b1", "filled", 15_000);
  assert.equal(fin.k, "filled");
  assert.equal((fin as { ms: number }).ms, 1_400, "the time is the fill's, not the settle's");
  assert.equal((fin as { provisional?: true }).provisional, undefined, "Final");
  // another buy's out moves nothing; an out after Final changes nothing
  assert.equal(outFilled(landing, "b2", 2_400), landing);
  assert.equal(outFilled(fin, "b1", 16_000), fin);
});

test("card pool-buy-filled-2s: a Filled not yet Final that ends not_landed (a fork) is Not landed; one already Final never moves", () => {
  const f = outFilled(progress(tap(READY, "b1", 1_000), "b1", "sent", 2_000), "b1", 2_400);
  const nl = progress(f, "b1", "not_landed", 20_000);
  assert.equal(nl.k, "ended");
  assert.deepEqual(endView(nl), { k: "notLanded", reason: null });
  const fin = progress(f, "b1", "filled", 15_000);
  assert.equal(progress(fin, "b1", "not_landed", 20_000), fin);
  // a vault buy (no route fact) is Filled and Final at the stage, as before
  const v = progress(progress(tap(READY, "v1", 1_000), "v1", "sent", 2_000), "v1", "filled", 3_000);
  assert.equal(v.k, "filled");
  assert.equal((v as { provisional?: true }).provisional, undefined);
});

// Review of 418af7d5 (P3-2): a Filled not yet Final whose run ends with no fill goes to exactly what the box shows for
// that end with no Filled before it: the page posts a run that ends not known as the stage "sent" (Landing, then Slow,
// as for any buy whose end is not known), a failed run is Failed by its code, not_landed is Not landed; a later
// final fact still makes it Final. Only the buy's own id moves it.
test("review of 418af7d5: a Filled not yet Final that the run ends not known (progress sent) is Landing again, Slow past 5 s; a later filled is Final", () => {
  const f = outFilled(progress(tap(READY, "b1", T0), "b1", "sent", T0 + 150), "b1", T0 + 1_100);
  const back = progress(f, "b1", "sent", T0 + 60_000);
  assert.deepEqual(back, { k: "landing", id: "b1", at: T0 });
  assert.ok(isSlow(back, T0 + 60_000));
  assert.deepEqual(progress(back, "b1", "filled", T0 + 90_000), { k: "filled", id: "b1", at: T0, ms: 90_000 });
});

test("review of 418af7d5: the request's own answer never ends a Filled not yet Final, except a refusal, which ends it as the box ends any refusal", () => {
  const f = outFilled(progress(tap(READY, "b1", T0), "b1", "sent", T0 + 150), "b1", T0 + 1_100);
  // the early answer "sent" may come after the route's amount (it is posted on its own): it moves nothing
  assert.equal(outcome(f, "b1", { ok: true, result: { stage: "sent" } }, T0 + 1_200), f);
  assert.equal(outcome(f, "b1", { ok: false, error: { code: "client_timeout" } }, T0 + 10_000), f);
  assert.deepEqual(outcome(f, "b1", { ok: false, error: { code: "failed" } }, T0 + 2_000), { k: "ended", id: "b1", at: T0, stage: "refused", code: "failed" });
  const fin = outcome(f, "b1", { ok: true, result: { stage: "filled" } }, T0 + 9_000);
  assert.deepEqual(fin, { k: "filled", id: "b1", at: T0, ms: 1_100 });
});

test("review of 418af7d5: another buy's stage or answer never moves a Filled not yet Final", () => {
  const f = outFilled(progress(tap(READY, "b1", T0), "b1", "sent", T0 + 150), "b1", T0 + 1_100);
  for (const s of ["sent", "filled", "not_landed", "part_filled", "refused"] as const) assert.equal(progress(f, "b2", s, T0 + 3_000), f, s);
  assert.equal(outcome(f, "b2", { ok: false, error: { code: "failed" } }, T0 + 3_000), f);
  assert.equal(outcome(f, "b2", { ok: true, result: { stage: "filled" } }, T0 + 3_000), f);
});
