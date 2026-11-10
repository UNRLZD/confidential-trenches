// A quick-buy chip buys in one tap on the phone (card app-quick-buy-one-tap; 09-design-brief F14 step 2 and §6.5: "each
// one tap = a buy at that size, no sheet"). The chip is the trade box's preset: one tap function of the page's one trade
// state (TradeBox.tsx useTrade tapPreset), so the chip's buy is the box's buy, its kit call and its checks, never a second
// buy path. Its toast over the page draws the running buy (Sending, Landing), the fill, or the end with Retry while the
// sheet is closed; the open sheet's own button draws them there. The browser run (test/quick-buy/run.mjs) taps the chips
// at 360, 390 and 430.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { toastView } from "../src/screens/trade/toast.ts";
import type { Phase } from "../src/screens/trade/model.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const SENDING: Phase = { k: "sending", id: "b1", at: 0 };
const LANDING: Phase = { k: "landing", id: "b1", at: 0 };
const FILLED: Phase = { k: "filled", id: "b1", at: 0, ms: 1100 };
const REFUSED: Phase = { k: "ended", id: "b1", at: 0, stage: "refused", code: "quote_check_failed" };
const NOT_LANDED: Phase = { k: "ended", id: "b1", at: 0, stage: "not_landed" };

test("the toast over the page: the running buy and its end while the sheet is closed; the fill at every open state", () => {
  assert.equal(toastView({ k: "ready" }, null, false), null);
  assert.equal(toastView(SENDING, null, false), "run");
  assert.equal(toastView(LANDING, null, false), "run");
  assert.equal(toastView(FILLED, null, false), "fill");
  assert.equal(toastView(REFUSED, null, false), "end");
  assert.equal(toastView(NOT_LANDED, null, false), "end");
  // the open sheet's button draws the run and the end; the fill toast shows over it as it does today
  assert.equal(toastView(SENDING, null, true), null);
  assert.equal(toastView(REFUSED, null, true), null);
  assert.equal(toastView(FILLED, null, true), "fill");
  // a toast closed by a tap, or the fill's own timeout, stays closed for that buy only
  assert.equal(toastView(FILLED, "b1", false), null);
  assert.equal(toastView(REFUSED, "b1", false), null);
  assert.equal(toastView(REFUSED, "b0", false), "end");
});

test("the chip is the box's preset: one tap function, no sheet, and the terminal has one buy request site", () => {
  const page = src("screens/token/TokenPage.tsx");
  const box = src("screens/trade/TradeBox.tsx");
  // the phone bar's chips call the trade state's tapPreset with the box's own presets row (on Base and Robinhood the
  // chunk's one button), and none opens the sheet
  const bar = /<div className="tkp-quick">([\s\S]*?)<\/div>/.exec(page)?.[1] ?? "";
  assert.match(bar, /t\.presets\.map/, "the chips are not the box's presets");
  assert.doesNotMatch(page, /\bPRESETS\b/, "the token page draws the four presets of its own");
  assert.match(bar, /t\.tapPreset\(p\)/, "a chip does not tap through the trade state's tapPreset");
  assert.doesNotMatch(bar, /sheet\.open/, "a chip still opens the sheet");
  assert.doesNotMatch(bar, /kit\.request/, "a chip calls the kit itself");
  // the box's presets tap through the same function
  assert.match(box, /onClick=\{\(\) => tapPreset\(p\)\}/, "the box's presets do not tap through tapPreset");
  // one buy request site in the box (the vault buy and the pool's checked ask), behind the running guard
  assert.equal(box.match(/kit\.request!\(/g)?.length, 2);
  assert.match(box, /if \(!ready \|\| busy\(phaseRef\.current\) \|\| !amountOk\(c, max, balance\)\) return;/);
});

test("the toast's words are the box's own: no new word", () => {
  const toast = src("screens/trade/TradeToast.tsx");
  assert.doesNotMatch(toast, />[A-Za-z][^<{]*</, "the toast draws a literal word of its own");
});
