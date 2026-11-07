// The phone trade sheet (card app-phone-trade-sheet; A2.5, app.md:1450; 09-design-brief §6.5 and F14): its open and close,
// and its wiring to the box. A closed sheet keeps its box mounted, so a buy that still runs is drawn where it is on the
// next open (a fresh Ready box beside a running buy is a dead end, and a second tap there a second buy). The browser run
// (test/trade-sheet/run.mjs) draws every state in the sheet at 360, 390 and 430.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { escapeCloses, locksPage, SHEET_START, sheetStep } from "../src/screens/trade/sheet.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("open mounts the box and shows it; close hides it and keeps it mounted; a reopen shows the same box", () => {
  assert.deepEqual(SHEET_START, { mounted: false, open: false });
  const opened = sheetStep(SHEET_START, "open");
  assert.deepEqual(opened, { mounted: true, open: true });
  const closed = sheetStep(opened, "close");
  assert.deepEqual(closed, { mounted: true, open: false });
  assert.deepEqual(sheetStep(closed, "open"), { mounted: true, open: true });
  // a close before any open draws nothing; repeated events change nothing
  assert.deepEqual(sheetStep(SHEET_START, "close"), SHEET_START);
  assert.equal(sheetStep(opened, "open"), opened);
  assert.equal(sheetStep(closed, "close"), closed);
});

test("Escape closes only an open sheet with nothing over it; the page behind is locked only while open", () => {
  assert.equal(escapeCloses(true, false), true);
  assert.equal(escapeCloses(true, true), false);
  assert.equal(escapeCloses(false, false), false);
  assert.equal(locksPage({ mounted: true, open: true }), true);
  assert.equal(locksPage({ mounted: true, open: false }), false);
  assert.equal(locksPage(SHEET_START), false);
});

test("the sheet draws the box only through the step: mounted once, hidden (not removed) when closed, no dialog or confirm", () => {
  const s = src("screens/trade/TradeSheet.tsx");
  assert.match(s, /sheetStep\(/);
  assert.match(s, /if \(!state\.mounted\) return null/);
  assert.match(s, /data-open=\{state\.open\}/);
  assert.match(s, /escapeCloses\(/);
  assert.match(s, /locksPage\(state\)/);
  // a window grown past the phone closes it, so the desktop page is never left locked under a sheet it does not draw
  assert.match(s, /window\.matchMedia\(PHONE\)/);
  assert.match(s, /!phone\.matches && onClose\(\)/);
  assert.doesNotMatch(s, /window\.confirm|confirm\(|alert\(/);
});

test("the token page opens the one sheet with the box and the safety grid in it, from Buy, Sell and each quick buy", () => {
  const s = src("screens/token/TokenPage.tsx");
  assert.match(s, /import \{ TradeSheet, useTradeSheet \} from "\.\.\/trade\/TradeSheet\.tsx"/);
  assert.match(s, /<TradeSheet [^>]*state=\{sheet\.state\}/);
  // the box inside the sheet is the desktop's Ticket: TradeBox with the safety grid as its footer
  assert.match(s, /<TradeSheet[\s\S]*?<Ticket r=\{r\} t=\{t\} \/>[\s\S]*?<\/TradeSheet>/);
  const bar = s.slice(s.indexOf('className="tkp-bottom"'));
  assert.equal((bar.match(/onClick=\{sheet\.open\}/g) ?? []).length, 3, "the quick buys, Sell and Buy open the sheet");
  // the old sheet that unmounted on close is gone
  assert.doesNotMatch(s, /\{sheet && v && r && <TradeSheet/);
});

test("a pushed token page draws no tab bar; the home route keeps it", () => {
  const s = src("shell/TabBar.tsx");
  assert.match(s, /useMatch\(TOKEN_ROUTE\)/);
  assert.match(s, /if \(pushed\) return null/);
});

test("the token page holds one trade state and both widths draw it: a buy started in the sheet is the buy the desktop column draws, and back", () => {
  const page = src("screens/token/TokenPage.tsx");
  // one useTrade for the page, above both layouts; no box with a state of its own
  assert.equal((page.match(/useTrade\(/g) ?? []).length, 1);
  assert.doesNotMatch(page, /<TradeBox\b/);
  assert.match(page, /<Desktop [^>]*t=\{trade\}/);
  assert.match(page, /<Phone [^>]*t=\{trade\}/);
  assert.match(page, /<TradeView t=\{t\}/);
  assert.equal((page.match(/<Ticket r=\{r\} t=\{t\} \/>/g) ?? []).length, 2, "the desktop column and the sheet draw the same state");
  // the box is its state (useTrade, one quote and one follow of the kit per state) and its view (TradeView)
  const box = src("screens/trade/TradeBox.tsx");
  assert.match(box, /export function useTrade\(at: TradeAt \| null/);
  assert.match(box, /export function TradeView\(\{ t, symbol, footer \}/);
  assert.match(box, /const t = useTrade\(\{ chain, token, slippageBps \}, initialAmount\);\s*return <TradeView t=\{t\}/);
  // the view subscribes to nothing: every kit call and timer is the state's, so two views never quote or follow twice
  const view = box.slice(box.indexOf("export function TradeView("));
  assert.doesNotMatch(view, /useEffect|kit\.setPreview\(|kit\.onProgress\(|kit\.route\(/);
});
