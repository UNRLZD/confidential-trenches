// The trade box's buy side (card app-trade-box-buy; A2.3, app.md:1448; APU-07, app.md:1329; S8.3, S8.9, S8.10, S8.12 at
// 09-design-brief S8): the money math in bigint cents, the presets as ladder sums and their edges at the S8 Max, the
// check that the kit's set sums to the amount, the main button's states Sending, Landing and Filled, a double tap,
// and a kit refusal. One WORDS table.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  amountOk,
  buttonTime,
  centsToDecimal,
  fmtUsd,
  ladderSplit,
  outcome,
  parseUsd,
  PRESETS,
  presetOn,
  progress,
  READY,
  rungs,
  secs,
  setMatches,
  setSum,
  tap,
} from "../src/screens/trade/model.ts";
import type { Phase, Slice } from "../src/screens/trade/model.ts";
import { DRAFTS, WORDS } from "../src/screens/trade/words.ts";

const T0 = Date.parse("2026-11-02T06:00:00Z");

test("USD decimal strings to cents and back, exact: no float anywhere", () => {
  assert.equal(parseUsd("25"), 2_500n);
  assert.equal(parseUsd("25.5"), 2_550n);
  assert.equal(parseUsd("25.50"), 2_550n);
  assert.equal(parseUsd("0.07"), 7n);
  assert.equal(parseUsd("73.18"), 7_318n);
  assert.equal(parseUsd("0.1"), 10n);
  assert.equal(parseUsd("25."), 2_500n);
  for (const bad of ["", ".5", "1.234", "-1", "1e2", "abc", "1,000", " "]) assert.equal(parseUsd(bad), null, bad);
  // 0.1 + 0.2 in float is 0.30000000000000004; in cents it is 30
  assert.equal(parseUsd("0.1")! + parseUsd("0.2")!, 30n);
  assert.equal(centsToDecimal(7n), "0.07");
  assert.equal(centsToDecimal(10_000n), "100.00");
  assert.equal(fmtUsd(10_000n), "$100");
  assert.equal(fmtUsd(7_318n), "$73.18");
  assert.equal(fmtUsd(5n), "$0.05");
  assert.equal(fmtUsd(100_000_000n), "$1,000,000");
  let seed = 7;
  const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31);
  for (let i = 0; i < 10_000; i++) {
    const c = BigInt(rnd()) * BigInt(rnd() % 1000);
    assert.equal(parseUsd(centsToDecimal(c)), c);
  }
});

test("the ladder is 1-2-5 per power of ten from $2, with no top", () => {
  assert.deepEqual(rungs(100_000n), [100_000n, 50_000n, 20_000n, 10_000n, 5_000n, 2_000n, 1_000n, 500n, 200n]);
  assert.deepEqual(rungs(199n), []);
  assert.equal(rungs(10n ** 12n)[0], 10n ** 12n);
});

test("the presets $10, $25, $50 and $100 are sums of ladder sizes; $137 = 100 + 20 + 10 + 5 + 2", () => {
  assert.deepEqual(PRESETS, [1_000n, 2_500n, 5_000n, 10_000n]);
  const want = [[1_000n], [2_000n, 500n], [5_000n], [10_000n]];
  PRESETS.forEach((p, i) => assert.deepEqual(ladderSplit(p), { sizes: want[i], rest: 0n }, fmtUsd(p)));
  assert.deepEqual(ladderSplit(13_700n), { sizes: [10_000n, 2_000n, 1_000n, 500n, 200n], rest: 0n });
  for (const p of PRESETS) assert.equal(ladderSplit(p).sizes.reduce((a, b) => a + b, 0n), p);
});

test("the preset edges at the S8 Max: on at the max, off one cent above it, off above the balance, off while busy", () => {
  const max = 10_000n;
  assert.equal(presetOn(10_000n, max, 20_000n, false), true, "$100 at Max $100");
  assert.equal(presetOn(10_000n, 9_999n, 20_000n, false), false, "$100 over a max of $99.99");
  assert.equal(presetOn(10_000n, 5_000n, 20_000n, false), false, "$100 over Max now $50");
  assert.equal(presetOn(5_000n, 5_000n, 20_000n, false), true, "$50 at Max now $50");
  assert.equal(presetOn(10_000n, max, 7_318n, false), false, "$100 over Bal $73.18");
  assert.equal(presetOn(5_000n, max, 7_318n, false), true, "$50 under Bal $73.18");
  assert.equal(presetOn(1_000n, max, 1_000n, false), true, "$10 at Bal $10");
  assert.equal(presetOn(1_000n, max, 20_000n, true), false, "busy");
  assert.equal(presetOn(1_000n, null, 20_000n, false), false, "no max read yet");
  assert.equal(presetOn(1_000n, max, null, false), false, "no balance yet");
  assert.equal(amountOk(10_000n, max, 20_000n), true);
  assert.equal(amountOk(10_001n, max, 20_000n), false);
  assert.equal(amountOk(0n, max, 20_000n), false);
  assert.equal(amountOk(null, max, 20_000n), false);
  assert.equal(amountOk(7_319n, max, 7_318n), false);
});

test("the kit's set is drawn only when its slices sum to the amount to the cent, over 10,000 random amounts", () => {
  const slices = (xs: string[]): Slice[] => xs.map((usd, i) => ({ wallet: `w${i}`, usd }));
  assert.equal(setSum(slices(["100", "20", "10", "5", "2"])), 13_700n);
  assert.equal(setMatches(slices(["100.00", "20.00", "10.00", "5.00", "2.00"]), 13_700n), true);
  assert.equal(setMatches(slices(["20", "5"]), 2_500n), true);
  assert.equal(setMatches(slices(["20", "5"]), 2_501n), false, "one cent off");
  assert.equal(setMatches(slices(["20", "5"]), 5_000n), false, "the set of an older amount");
  assert.equal(setMatches([], 0n), false);
  assert.equal(setMatches(slices(["20", "5.001"]), 2_500n), false, "a slice past the cent");
  assert.equal(setMatches(slices(["20", "0"]), 2_000n), false, "an empty slice");
  assert.equal(setMatches(slices(["20", "5"]), null), false);
  // a kit-shaped set (the ladder, the cents in the largest slice) for random amounts from $4 to $1,000
  let seed = 42;
  const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31);
  for (let i = 0; i < 10_000; i++) {
    const amount = 400n + BigInt(rnd() % 99_600);
    const { sizes, rest } = ladderSplit(amount);
    const set = sizes.map((s, j) => (j === 0 ? s + rest : s));
    const s = slices(set.map(centsToDecimal));
    assert.equal(setSum(s), amount);
    assert.equal(setMatches(s, amount), true);
    assert.equal(setMatches(s, amount + 1n), false);
  }
});

test("the main button: Sending at the tap, Landing at the kit's sent counting from the tap, Filled with the tap-to-fill time", () => {
  let p: Phase = tap(READY, "b1", T0);
  assert.deepEqual(p, { k: "sending", id: "b1", at: T0 });
  assert.equal(buttonTime(p, T0 + 50), null);
  p = progress(p, "b1", "signed", T0 + 80);
  assert.equal(p.k, "sending", "signed is still Sending");
  p = progress(p, "b1", "sent", T0 + 150);
  assert.deepEqual(p, { k: "landing", id: "b1", at: T0 });
  assert.equal(buttonTime(p, T0 + 400), "0.4s");
  assert.equal(buttonTime(p, T0 + 999), "0.9s");
  p = progress(p, "b1", "sent", T0 + 500);
  assert.equal(p.k, "landing");
  p = progress(p, "b1", "filled", T0 + 1_100);
  assert.deepEqual(p, { k: "filled", id: "b1", at: T0, ms: 1_100 });
  assert.equal(buttonTime(p, T0 + 9_000), "1.1s", "Filled holds its time");
  // never backwards
  assert.deepEqual(progress(p, "b1", "sent", T0 + 1_200), p);
  // the answer after the fill changes nothing
  assert.deepEqual(outcome(p, "b1", { ok: true, result: { stage: "sent" } }, T0 + 1_300), p);
  assert.equal(secs(12_049), "12.0s");
  assert.equal(secs(-5), "0.0s");
});

test("a fill straight from Sending (no sent seen) is Filled; another buy's events move nothing", () => {
  const s = tap(READY, "b1", T0);
  assert.equal(progress(s, "b1", "filled", T0 + 700).k, "filled");
  assert.deepEqual(progress(s, "other", "filled", T0 + 700), s);
  assert.deepEqual(outcome(s, "other", { ok: false, error: { code: "not_allowed" } }, T0 + 700), s);
  assert.deepEqual(progress(READY, "b1", "filled", T0), READY);
});

test("a double tap is one buy: a tap while Sending or Landing keeps the running buy", () => {
  const s = tap(READY, "b1", T0);
  assert.deepEqual(tap(s, "b2", T0 + 30), s);
  const l = progress(s, "b1", "sent", T0 + 100);
  assert.deepEqual(tap(l, "b2", T0 + 200), l);
  const f = progress(l, "b1", "filled", T0 + 900);
  assert.deepEqual(tap(f, "b2", T0 + 5_000), { k: "sending", id: "b2", at: T0 + 5_000 }, "after the fill a tap is a new buy");
});

test("a kit refusal ends the buy with its code; the client's own timeout does not (the page may still run it)", () => {
  const s = tap(READY, "b1", T0);
  assert.deepEqual(outcome(s, "b1", { ok: false, error: { code: "quote_check_failed" } }, T0 + 300), { k: "ended", id: "b1", at: T0, stage: "refused", code: "quote_check_failed" });
  assert.deepEqual(outcome(s, "b1", { ok: false, error: { code: "signpage_down" } }, T0 + 300), { k: "ended", id: "b1", at: T0, stage: "refused", code: "signpage_down" });
  assert.deepEqual(outcome(s, "b1", { ok: false, error: { code: "client_timeout" } }, T0 + 10_000), s);
  const l = progress(s, "b1", "sent", T0 + 100);
  assert.deepEqual(outcome(l, "b1", { ok: false, error: { code: "client_timeout" } }, T0 + 10_000), l);
  assert.equal(progress(l, "b1", "filled", T0 + 10_500).k, "filled", "progress after a timeout still lands");
  // the kit's other ends are the next card's states, never Filled
  for (const stage of ["part_filled", "not_landed", "refused"] as const) assert.deepEqual(progress(l, "b1", stage, T0 + 2_000), { k: "ended", id: "b1", at: T0, stage });
  // after an end a tap is a new buy
  const e = progress(l, "b1", "not_landed", T0 + 2_000);
  assert.equal(tap(e, "b2", T0 + 3_000).k, "sending");
});

test("every word has a source, and the drafts are the ones marked", () => {
  for (const [k, w] of Object.entries(WORDS)) assert.ok(w.text.length > 0 && w.source.length > 0, k);
  assert.deepEqual(DRAFTS, Object.keys(WORDS).filter((k) => WORDS[k as keyof typeof WORDS].draft));
});
