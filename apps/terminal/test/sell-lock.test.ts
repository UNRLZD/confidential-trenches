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
type Tapped = Parameters<typeof sellLocked>[3] extends ReadonlyMap<string, infer T> ? T : never;
const op = (id: string, stage: string, kind = "sell") => ({ id, kind, stage, txs: [] });
const at = (ops: unknown[], stale = false) => ({ state: { ops }, stale }) as unknown as Snap;
const READY: Phase = { k: "ready" };
const none = new Map<string, Tapped>();
const MINT = "So1aNaMint1111111111111111111111111111111pump";
const here = (units: string | null, token = MINT) => ({ chain: "solana", token, units });
const tap = (units: string | null, token = MINT, seen = false): Tapped => ({ chain: "solana", token, units, ...(seen ? { seen } : {}) });

test("P2: a remount finds an open sell on the device's record and locks every sell button; no row move lets go of it", () => {
  for (const stage of ["signed", "sent"]) assert.equal(sellLocked(READY, at([op("s1", stage)]), here("1000"), none), true, stage);
  assert.equal(sellLocked(READY, structuredClone(at([op("s1", "sent")])), here("1000"), none), true);
  // the device settles every open sell (trade.ts settleTradeOps): a moved row, this holding's or another's, never ends it
  const tapped = new Map([["s1", tap("1000")]]);
  for (const u of ["750", "1000.5", null]) assert.equal(sellLocked(READY, at([op("s1", "sent")]), here(u), tapped), true, String(u));
  // an open buy, or a sell at its end, locks nothing on a fresh mount
  assert.equal(sellLocked(READY, at([op("b1", "sent", "buy")]), here("1000"), none), false);
  for (const stage of ["filled", "part_filled", "refused", "not_landed"]) assert.equal(sellLocked(READY, at([op("s1", stage)]), here("1000"), none), false, stage);
  assert.equal(sellLocked(READY, { state: null, stale: false } as Snap, here("1000"), none), false);
});

test("P3-3a: a sell tapped on this page that the record does not show yet (pending) locks its holding, whatever the row does", () => {
  const tapped = new Map([["s1", tap("1000")]]);
  assert.equal(sellLocked(READY, at([]), here("1000"), tapped), true, "a remount before signed");
  // the row moving says nothing of a sell the record has not shown: a second pool sell would queue behind it
  // (re-check of 91fb908e, P3)
  for (const u of ["750", "1000.5", null]) assert.equal(sellLocked(READY, at([]), here(u), tapped), true, `the row moved to ${u}`);
  // the reviewer's case: a row move for another reason (a deposit of the same token) keeps the pending sell's lock
  assert.equal(sellLocked(READY, at([]), here("1000.5"), new Map([["s1", tap("1000")]])), true);
  assert.equal(sellLocked(READY, at([]), here("1000", "OtherMint111111111111111111111111111111pump"), tapped), false, "another holding");
  // once the record has shown it, its stage there speaks for it (an op aged out of the list locks nothing)
  assert.equal(sellLocked(READY, at([]), here("1000"), new Map([["s1", tap("1000", MINT, true)]])), false);
});

test("P2: after this mount's sell may have sold, locked until its op ends; never while stale; a refusal keeps Retry", () => {
  const tapped = new Map([["s1", tap("1000")]]);
  const filled: Phase = { k: "filled", id: "s1", at: 0, ms: 900 };
  const part: Phase = { k: "ended", id: "s1", at: 0, stage: "part_filled" };
  const notLanded: Phase = { k: "ended", id: "s1", at: 0, stage: "not_landed" };
  for (const p of [filled, part, notLanded]) {
    assert.equal(sellLocked(p, at([op("s1", "sent")]), here("1000"), tapped), true, `${p.k}: sent`);
    assert.equal(sellLocked(p, at([]), here("1000"), tapped), true, `${p.k}: no op yet`);
    assert.equal(sellLocked(p, at([op("other", "refused")]), here("1000"), tapped), true, `${p.k}: another id`);
    for (const end of ["refused", "not_landed"]) assert.equal(sellLocked(p, at([op("s1", end)]), here("1000"), tapped), false, `${p.k}: ${end}`);
    assert.equal(sellLocked(p, at([op("s1", "refused")], true), here("1000"), tapped), true, `${p.k}: stale`);
  }
  const refused: Phase = { k: "ended", id: "s4", at: 0, stage: "refused", code: "not_allowed" };
  assert.equal(sellLocked(refused, at([op("s4", "refused")], true), here("1000"), new Map()), false);
});

test("P3-1: rows compare only within one holding: another token's units never end or start a lock here", () => {
  const OTHER = "OtherMint111111111111111111111111111111pump";
  const tapped = new Map([["s1", tap("1000", OTHER)]]);
  // a sell tapped on OTHER, landed: this holding's row (whatever its units) is not OTHER's, so it is not held here
  assert.equal(sellLocked(READY, at([op("s1", "filled")]), here("1000"), tapped), false);
  // this mount's sell (of OTHER) filled: this row's units say nothing of it, so it waits on the op
  const filled: Phase = { k: "filled", id: "s1", at: 0, ms: 900 };
  assert.equal(sellLocked(filled, at([]), here("750"), tapped), true);
});

test("P3-2: a landed end does not let go while the row still shows the units the sell was tapped on", () => {
  const tapped = new Map([["s1", tap("1000")]]);
  const filled: Phase = { k: "filled", id: "s1", at: 0, ms: 900 };
  for (const end of ["filled", "part_filled"]) {
    assert.equal(sellLocked(filled, at([op("s1", end)]), here("1000"), tapped), true, `${end}: old units`);
    assert.equal(sellLocked(READY, at([op("s1", end)]), here("1000"), tapped), true, `${end}: old units, remounted`);
    assert.equal(sellLocked(filled, at([op("s1", end)]), here("750"), tapped), false, `${end}: new units`);
    assert.equal(sellLocked(READY, at([op("s1", end)]), here(null), tapped), false, `${end}: the row gone`);
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
  // the most a token account holds is 2^64 - 1 base units (trade.ts U64_MAX)
  assert.equal(baseUnits("18446744073709.551615", 6), "18446744073709551615");
  assert.equal(baseUnits("18446744073709.551616", 6), null, "past 2^64 - 1");
});

test("the lock and the vault amount are useSell's: every sell button reads them; TradeBox forks neither", () => {
  const sell = src("screens/positions/source.tsx");
  assert.match(sell, /const locked = sellLocked\(phase, src\.snapshot, \{ chain, token, units \}, TAPPED\);/);
  assert.match(sell, /const ready = moneyOn && kit\.request !== null && !locked;/);
  assert.match(sell, /TAPPED\.set\(h\.id, \{ chain, token, units \}\)/, "the holding a sell was tapped on is not kept past the mount");
  assert.match(sell, /if \(!o\.ok && o\.error\.code !== "client_timeout"\) TAPPED\.delete\(h\.id\);/, "a refused sell still holds its holding");
  assert.match(sell, /const base = baseUnits\(amount, decimals\);/);
  assert.doesNotMatch(sell, /side: "sell", amount, slippage_bps/, "the vault sell still sends the decimal amount");
  const box = src("screens/trade/TradeBox.tsx");
  assert.match(box, /const sell = useSell\(chain, heldNow\?\.token \?\? token, slippageBps, heldNow\?\.units \?\? null\);/);
  assert.doesNotMatch(box, /staleAfterSell|sellLive/);
});

test("P2-2: a sell is sized from the signing page's decimals (the row's), never the helper's token read", () => {
  const page = src("screens/token/TokenPage.tsx");
  assert.doesNotMatch(page, /<TradeView[^>]*decimals=/, "the token page hands the helper's decimals to the sell");
  const box = src("screens/trade/TradeBox.tsx");
  assert.doesNotMatch(box, /<SellBox[^>]*decimals=/);
  for (const f of ["screens/positions/SellBox.tsx", "screens/positions/PositionPanel.tsx"]) {
    assert.match(src(f), /const decimals = row\.decimals;/, `${f} does not read the row's decimals`);
    assert.doesNotMatch(src(f), /decimals = null \}/, `${f} still takes decimals from its caller`);
  }
  assert.match(src("screens/portfolio/model.ts"), /decimals: p\.decimals \?\? null,/, "the row's decimals are not the position's");
});
