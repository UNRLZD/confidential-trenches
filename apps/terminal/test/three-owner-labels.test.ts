// The owner's three labels (owner 10 Nov 18:12Z, owner-decisions "Mainnet run tonight and three labels"): a failed
// trade's Activity row carries the tag Transaction failed with the trade box's reason on hover, never a kit code; a
// Solana pool buy the pool cannot make yet (venue_not_pinned, no_table_fits) ends as Unavailable with Buy off and no
// Retry; a position whose price reads zero has no value (the dash), never $0.00.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Operation, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { activity, NO_DATA, portfolio } from "../src/screens/portfolio/model.ts";
import type { PortfolioData, TokenMarket } from "../src/screens/portfolio/model.ts";
import { WORDS as PF } from "../src/screens/portfolio/words.ts";
import { endView, outcome, reasonOf, showsRetry, tap, unavailable, READY } from "../src/screens/trade/model.ts";
import type { Phase } from "../src/screens/trade/model.ts";
import { WORDS as TR } from "../src/screens/trade/words.ts";

const NOW = Date.parse("2026-11-10T19:00:00Z");
const H = 3_600_000;

test("the words are the owner's, exactly, and approved: Transaction failed, Unavailable", () => {
  assert.equal(PF.txFailed.text, "Transaction failed");
  assert.equal(PF.txFailed.draft, false);
  assert.match(PF.txFailed.source, /^owner 10 Nov 18:12Z/);
  assert.equal(TR.unavailable.text, "Unavailable");
  assert.equal(TR.unavailable.draft, false);
  assert.match(TR.unavailable.source, /^owner 10 Nov 18:12Z/);
});

test("Activity: a refused or not-landed buy or sell is failed, with the trade box's reason for its code or none; any other row is not", () => {
  const op = (id: string, kind: "buy" | "sell", stage: string, code?: string): Operation =>
    ({ id, kind, stage, txs: [], created_ms: NOW - H, chain: "solana", token: "WTH", amount_usd: "25", ...(code ? { code } : {}) }) as Operation;
  const rows = activity(
    [
      op("a", "buy", "refused", "quote_check_failed"),
      op("b", "buy", "refused", "venue_not_pinned"),
      op("c", "buy", "refused", "no_table_fits"),
      op("k", "buy", "refused", "venue_not_built"),
      op("l", "sell", "refused", "venue_not_built"),
      op("d", "sell", "refused", "something_new"),
      op("e", "buy", "refused"),
      op("f", "sell", "not_landed"),
      op("g", "buy", "filled"),
      op("h", "buy", "part_filled"),
      op("i", "sell", "sent"),
      { id: "j", kind: "deposit", stage: "refunded", txs: [], created_ms: NOW - H },
    ],
    NO_DATA,
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r.failed]));
  assert.deepEqual(by, {
    a: { reason: "priceCheck" },
    b: { reason: "unavailable" },
    c: { reason: "unavailable" },
    k: { reason: "unavailable" },
    l: { reason: "unavailable" },
    d: { reason: null },
    e: { reason: null },
    f: { reason: "notLanded" },
    g: null,
    h: null,
    i: null,
    j: null,
  });
  // every reason a row can carry is a word of the trade box, never the kit's code
  for (const f of Object.values(by)) if (f?.reason) assert.ok(TR[f.reason].text && !/_/.test(TR[f.reason].text), f.reason);
});

test("a code named after Object.prototype is no reason", () => {
  for (const c of ["toString", "constructor", "__proto__", "hasOwnProperty"]) assert.equal(reasonOf(c), null, c);
  assert.equal(reasonOf(undefined), null);
});

test("the trade box: venue_not_pinned, no_table_fits and venue_not_built end the trade as Unavailable, with no Retry; other refusals keep Retry", () => {
  for (const code of ["venue_not_pinned", "no_table_fits", "venue_not_built"]) {
    const p = outcome(tap(READY, "b1", NOW), "b1", { ok: false, error: { code } }, NOW + 300);
    assert.deepEqual(endView(p), { k: "failed", reason: "unavailable" }, code);
    assert.equal(unavailable(p), true, code);
    assert.equal(showsRetry(p), false, `${code}: the same buy would be refused again`);
  }
  for (const code of ["quote_check_failed", "signpage_down", "not_allowed", "failed"]) {
    const p = outcome(tap(READY, "b1", NOW), "b1", { ok: false, error: { code } }, NOW + 300);
    assert.equal(unavailable(p), false, code);
    assert.equal(showsRetry(p), true, code);
  }
  const notLanded: Phase = { k: "ended", id: "b1", at: NOW, stage: "not_landed", code: "venue_not_pinned" };
  assert.equal(unavailable(notLanded), false, "only a refusal is Unavailable");
  for (const p of [READY, tap(READY, "b1", NOW), { k: "filled", id: "b1", at: NOW, ms: 900 } as Phase]) assert.equal(unavailable(p), false);
});

const STATE: SignpageState = {
  release: "signpage-v1",
  api: 1,
  signed_in: true,
  code_saved: true,
  vault_balance: "10",
  wallets: [],
  positions: [
    { chain: "solana", token: "ZERO", amount: "1000", cost: "5", wallets: ["w1"] },
    { chain: "solana", token: "ZEROS", amount: "1000", cost: "5", wallets: ["w2"] },
    { chain: "solana", token: "REAL", amount: "1000", cost: "5", wallets: ["w3"] },
    { chain: "solana", token: "DUST", amount: "0.001", cost: "5", wallets: ["w4"] },
  ],
  orders: [],
  held: [],
  ops: [],
} as SignpageState;
const snap = (state: SignpageState): SignpageClientSnapshot => ({ status: "ready", release: "signpage-v1", state, stale: false }) as SignpageClientSnapshot;
const MARKET: Record<string, TokenMarket> = {
  ZERO: { symbol: "ZERO", name: "", price: "0", route: null },
  ZEROS: { symbol: "ZEROS", name: "", price: "0.000000", route: null },
  REAL: { symbol: "REAL", name: "", price: "0.01", route: null },
  DUST: { symbol: "DUST", name: "", price: "0.01", route: null },
};
const data: PortfolioData = { ...NO_DATA, market: (_c, t) => MARKET[t] ?? null };

test("a position whose price reads zero has no value: the dash, never $0.00; a real price's dust value stays a number", () => {
  const rows = Object.fromEntries(portfolio(snap(STATE), data, NOW).rows.map((r) => [r.token, r]));
  for (const t of ["ZERO", "ZEROS"]) {
    assert.equal(rows[t]!.value, null, t);
    assert.equal(rows[t]!.pnl, null, t);
  }
  assert.equal(rows.REAL!.value, 1000n);
  // a real price on a sliver: worth under a cent, which is a read value
  assert.equal(rows.DUST!.value, 0n);
  // the unread rows count at cost in the totals, and mark them partial (S10.4), as a priceless row does
  const t = portfolio(snap(STATE), data, NOW).totals!;
  assert.equal(t.partial, true);
  // before any market read (the first seconds after load) every value is the dash
  for (const r of portfolio(snap(STATE), NO_DATA, NOW).rows) assert.equal(r.value, null, r.token);
});

// Card sol-pool-buys-mayhem-coins: a sale the pool cannot make on this token (venue_not_built: a curve quoted in another mint) is the buy
// side's Unavailable on the sell side too: its EndLine draws the trade box's word, no Retry, and the box's Sell and its
// presets stay off, since the same sale would be refused again
test("the sell box keeps Sell and its presets off after an Unavailable sale", async () => {
  const { readFileSync } = await import("node:fs");
  const box = readFileSync(new URL("../src/screens/positions/SellBox.tsx", import.meta.url), "utf8");
  assert.match(box, /const off = unavailable\(s\.phase\);/);
  assert.match(box, /const canSell = s\.ready && !running && !off && !noRoute && amount !== null && bps !== null && s\.takes\(bps\);/);
  assert.match(box, /const canSellAt = \(b: number\) => s\.ready && !running && !off && !noRoute && s\.takes\(b\) && sellAmount\(row\.units, b, decimals\) !== null;/);
  const p = outcome(tap(READY, "s1", NOW), "s1", { ok: false, error: { code: "venue_not_built" } }, NOW + 300);
  assert.equal(unavailable(p), true);
  assert.equal(showsRetry(p), false);
});
