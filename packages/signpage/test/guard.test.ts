// Sign out's activation guard (src/guard.ts): Chromium's DefaultInputProtectionPolicy rules, on the page's clock (ms).
// Round 4's review (P2): the guard had only the 500 ms after drawn or shown; Chromium also refuses a press within 500 ms
// of the input before it and a repeated key. Each case drives the guard as the page does: input() for every trusted
// pointerdown or keydown in the window, allows() for Sign out's click.
//   node --test test/guard.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { activationGuard, PROTECT_MS } from "../src/guard.ts";

// a mouse click: pointerdown at `at`, its click 80 ms later
const click = (g: ReturnType<typeof activationGuard>, at: number): boolean => g.allows(g.input(at, false), at + 80);

test("a press within 500 ms of the input before it does nothing: the second click of a burst at ~550 ms", () => {
  // a page opens SIGN_HOST under the pointer; Sign out drawn at 0; a burst of clicks lands at 300 and 550
  const g = activationGuard(0);
  assert.equal(click(g, 300), false, "the first click, inside the drawn window");
  assert.equal(click(g, 550), false, "the second click, 250 ms after the first, past the drawn window");
  assert.equal(click(g, 1100), true, "a click after a 550 ms pause signs out");
});

test("every input counts, refused or not: a steady burst stays refused until a 500 ms pause", () => {
  const g = activationGuard(0);
  assert.equal(click(g, 1_000), true);
  for (const at of [1_400, 1_800, 2_200, 2_600]) assert.equal(click(g, at), false, `click at ${at}`);
  assert.equal(click(g, 2_600 + PROTECT_MS), true);
});

test("a key anywhere in the window counts: Tab then Enter within 500 ms does nothing", () => {
  const g = activationGuard(0);
  g.input(2_000, false); // Tab, to focus Sign out
  assert.equal(g.allows(g.input(2_200, false), 2_200), false, "Enter 200 ms after Tab");
  g.input(3_000, false);
  assert.equal(g.allows(g.input(3_600, false), 3_600), true, "Enter 600 ms after Tab");
});

test("a repeated key does nothing: holding Enter on a focused Sign out", () => {
  const g = activationGuard(0);
  // the repeat comes long after Sign out was drawn and after any other input: only the repeat rule refuses it
  assert.equal(g.allows(g.input(5_000, true), 5_000), false, "a repeated Enter");
  assert.equal(g.allows(g.input(6_000, false), 6_000), true, "a fresh Enter after a pause");
});

test("drawn, shown or focused: a press or its click within 500 ms of it does nothing (round 4's rule, kept)", () => {
  const g = activationGuard(0);
  assert.equal(click(g, 400), false, "a press 400 ms after drawn");
  g.shown(2_000); // pageshow, visibilitychange or focus
  assert.equal(click(g, 2_300), false, "a press 300 ms after shown");
  assert.equal(g.allows({ at: 2_950, refused: false }, 3_000), true);
  g.shown(4_000);
  assert.equal(g.allows({ at: 3_900, refused: false }, 4_100), false, "a press before shown whose click lands inside");
});

test("a click with no press seen is its own press: refused within 500 ms of the last input or of drawn", () => {
  const g = activationGuard(0);
  assert.equal(g.allows(null, 300), false, "inside the drawn window");
  g.input(1_000, false);
  assert.equal(g.allows(null, 1_200), false, "200 ms after an input");
  assert.equal(g.allows(null, 1_600), true);
});
