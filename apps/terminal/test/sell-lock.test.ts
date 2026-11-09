// The sell lock and the vault sell's amount (card app-sell-mount, re-check 2 of 68b288e7). The lock reads the device's
// record (state.ops), never only what this mount started: a remount while a sell is open finds it there (P2). A sell's
// lock lets go when the row's units move off the units it was tapped on, so a lost end write never locks for good
// (P3-1), and a landed end does not let go while the row still shows the old units (P3-2). The vault's sell takes whole
// base units (packages/signpage/src/trade.ts UNITS), so the app sends the share scaled by the token's decimals and, with
// none read, sends nothing (P3-3).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { baseUnits, sellLocked } from "../src/screens/positions/model.ts";
import type { Phase } from "../src/screens/trade/model.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
type Snap = Parameters<typeof sellLocked>[1];
const op = (id: string, stage: string, kind = "sell") => ({ id, kind, stage, txs: [] });
const at = (ops: unknown[], stale = false) => ({ state: { ops }, stale }) as unknown as Snap;
const READY: Phase = { k: "ready" };
const none = new Map<string, string>();

test("P2: a remount finds an open sell on the device's record and locks every sell button", () => {
  // a fresh mount (READY, nothing tapped here) while the device's sell is signed or sent: locked
  for (const stage of ["signed", "sent"]) assert.equal(sellLocked(READY, at([op("s1", stage)]), "1000", none), true, stage);
  // the same while the snapshot is a reconnect's clone
  assert.equal(sellLocked(READY, structuredClone(at([op("s1", "sent")])), "1000", none), true);
  // an open buy, or a sell at its end, locks nothing on a fresh mount
  assert.equal(sellLocked(READY, at([op("b1", "sent", "buy")]), "1000", none), false);
  for (const stage of ["filled", "part_filled", "refused", "not_landed"]) assert.equal(sellLocked(READY, at([op("s1", stage)]), "1000", none), false, stage);
  assert.equal(sellLocked(READY, { state: null, stale: false } as Snap, "1000", none), false);
});

test("P2: after this mount's sell may have sold, locked until its op ends; never while stale; a refusal keeps Retry", () => {
  const tapped = new Map([["s1", "1000"], ["s4", "1000"]]);
  const filled: Phase = { k: "filled", id: "s1", at: 0, ms: 900 };
  const part: Phase = { k: "ended", id: "s1", at: 0, stage: "part_filled" };
  const notLanded: Phase = { k: "ended", id: "s1", at: 0, stage: "not_landed" };
  for (const p of [filled, part, notLanded]) {
    assert.equal(sellLocked(p, at([op("s1", "sent")]), "1000", tapped), true, `${p.k}: sent`);
    assert.equal(sellLocked(p, at([]), "1000", tapped), true, `${p.k}: no op yet`);
    assert.equal(sellLocked(p, at([op("other", "refused")]), "1000", tapped), true, `${p.k}: another id`);
    // the state that shows it refused or not landed: nothing left the row, the box takes taps again
    for (const end of ["refused", "not_landed"]) assert.equal(sellLocked(p, at([op("s1", end)]), "1000", tapped), false, `${p.k}: ${end}`);
    assert.equal(sellLocked(p, at([op("s1", "refused")], true), "1000", tapped), true, `${p.k}: stale`);
  }
  const refused: Phase = { k: "ended", id: "s4", at: 0, stage: "refused", code: "not_allowed" };
  assert.equal(sellLocked(refused, at([op("s4", "refused")], true), "1000", tapped), false);
});

test("P3-1: a sell whose end write was lost lets go once the row's units move off the units it was tapped on", () => {
  const tapped = new Map([["s1", "1000"]]);
  const filled: Phase = { k: "filled", id: "s1", at: 0, ms: 900 };
  // trade.ts swallows the end write: the op stays sent. The row moved (750 left, or the position gone): unlocked
  assert.equal(sellLocked(filled, at([op("s1", "sent")]), "750", tapped), false);
  assert.equal(sellLocked(filled, at([op("s1", "sent")]), null, tapped), false);
  // the same after a remount (READY): the units it was tapped on are the page's, not the mount's
  assert.equal(sellLocked(READY, at([op("s1", "sent")]), "750", tapped), false);
  // not moved: still open, still locked
  assert.equal(sellLocked(READY, at([op("s1", "sent")]), "1000", tapped), true);
});

test("P3-2: a landed end does not let go while the row still shows the units the sell was tapped on", () => {
  const tapped = new Map([["s1", "1000"]]);
  const filled: Phase = { k: "filled", id: "s1", at: 0, ms: 900 };
  for (const end of ["filled", "part_filled"]) {
    assert.equal(sellLocked(filled, at([op("s1", end)]), "1000", tapped), true, `${end}: old units`);
    // after a remount too
    assert.equal(sellLocked(READY, at([op("s1", end)]), "1000", tapped), true, `${end}: old units, remounted`);
    assert.equal(sellLocked(filled, at([op("s1", end)]), "750", tapped), false, `${end}: new units`);
    assert.equal(sellLocked(READY, at([op("s1", end)]), "750", tapped), false, `${end}: new units, remounted`);
  }
});

test("P3-3: the vault's sell is whole base units at the token's decimals; none read or a longer fraction is none", () => {
  assert.equal(baseUnits("617283.945617", 6), "617283945617");
  assert.equal(baseUnits("1.5", 9), "1500000000");
  assert.equal(baseUnits("250", 6), "250000000");
  assert.equal(baseUnits("1234567.891234", 6), "1234567891234");
  assert.equal(baseUnits("0.000001", 6), "1");
  // what trade.ts takes: /^[1-9]\d{0,19}$/
  for (const a of ["617283.945617", "1.5", "0.000001"]) assert.match(baseUnits(a, 6) ?? "", /^[1-9]\d{0,19}$/, a);
  assert.equal(baseUnits("308641.9728085", 6), null, "a fraction longer than the token's");
  assert.equal(baseUnits("1.5", null), null, "no decimals read");
  for (const d of [-1, 1.5, 37]) assert.equal(baseUnits("1.5", d), null, String(d));
  for (const a of ["0", "0.000000", "x", "-1", ""]) assert.equal(baseUnits(a, 6), null, a);
  assert.equal(baseUnits("99999999999999999999", 6), null, "past 20 digits");
});

test("the lock and the vault amount are useSell's: every sell button reads them; TradeBox forks neither", () => {
  const sell = src("screens/positions/source.tsx");
  assert.match(sell, /const locked = sellLocked\(phase, src\.snapshot, units, TAPPED\);/);
  assert.match(sell, /const ready = moneyOn && kit\.request !== null && !locked;/);
  assert.match(sell, /TAPPED\.set\(h\.id, units\)/, "the units a sell was tapped on are not kept past the mount");
  assert.match(sell, /const base = baseUnits\(amount, decimals\);/);
  assert.doesNotMatch(sell, /side: "sell", amount, slippage_bps/, "the vault sell still sends the decimal amount");
  const box = src("screens/trade/TradeBox.tsx");
  assert.match(box, /const sell = useSell\(chain, heldNow\?\.token \?\? token, slippageBps, heldNow\?\.units \?\? null\);/);
  assert.doesNotMatch(box, /staleAfterSell|sellLive/);
});
