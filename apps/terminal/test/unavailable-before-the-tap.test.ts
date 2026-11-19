// Card app-unavailable-before-the-tap: on a coin the pool cannot buy yet, the trade box shows Unavailable with Buy off
// as the page opens, from the pool.buy.dry it already asks at mount, never only after a refused tap. The dry answers
// the tap's own venue decision (card sol-buy-takes-the-best-venue-it-can-trade): the same codes the tap refuses with,
// read here through the one reasonOf (model.ts REASONS). The refusals are the kit's outcome shape as the client hands
// it to the box ({ ok: false, error: { code } }); the good answer is the Solana dry the page sent on sign run
// 43779499955 (test/buy-box-quotes-slow-dry.test.ts SOLANA). Red on main e1995d679: dryUnavailable, buyOff and
// BELOW_MARKET_CODE did not exist, and the box read Unavailable only from an ended tap.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as M from "../src/screens/trade/model.ts";
import { WORDS } from "../src/screens/trade/words.ts";

const NOW = Date.parse("2026-11-19T15:00:00Z");
const refused = (code: string) => ({ ok: false as const, error: { code } });
/** The page's Solana dry on sign run 43779499955, a coin it can buy. */
const GOOD = { ok: true as const, result: { tap_max: "0", with_cash: "0", out: "198.82471" } };
const COIN = JSON.stringify(["MINT", "0.01", "0.00173608"]);

for (const code of ["venue_not_pinned", "no_table_fits", "venue_not_built", M.BELOW_MARKET_CODE]) {
  test(`a dry refused ${code} is Unavailable before any tap: Buy and the presets off on this coin`, () => {
    assert.equal(M.dryUnavailable(refused(code)), true);
    assert.equal(M.reasonOf(code), "unavailable", "the same reason the tap's refusal draws");
    assert.equal(M.buyOff(M.READY, COIN, COIN), true, "off as the page opens, with no tap");
  });
}

test("the below-market code is the vault card's below_reference, and the tap's refusal of it is Unavailable too", () => {
  assert.equal(M.BELOW_MARKET_CODE, "below_reference");
  const p = M.outcome(M.tap(M.READY, "b1", NOW), "b1", refused(M.BELOW_MARKET_CODE), NOW + 300);
  assert.equal(M.unavailable(p), true);
  assert.equal(M.showsRetry(p), false);
});

test("a coin the page can buy, or a dry that says not now or nothing of the venue, is no Unavailable", () => {
  assert.equal(M.dryUnavailable(GOOD), false);
  for (const code of ["quote_check_failed", "not_funded", "not_allowed", "busy", "down", "client_timeout", "toString", "__proto__"]) assert.equal(M.dryUnavailable(refused(code)), false, code);
});

test("Unavailable from the dry holds only on its own coin: a new token page starts ready", () => {
  assert.equal(M.buyOff(M.READY, null, COIN), false);
  assert.equal(M.buyOff(M.READY, JSON.stringify(["OTHER", "0.01", "0.00173608"]), COIN), false);
  // the tap's own Unavailable still holds with no dry answer
  const ended = M.outcome(M.tap(M.READY, "b1", NOW), "b1", refused("venue_not_pinned"), NOW + 300);
  assert.equal(M.buyOff(ended, null, COIN), true);
});

test("no new word: the box draws the owner's Unavailable", () => {
  assert.equal(WORDS.unavailable.text, "Unavailable");
  assert.equal(WORDS.unavailable.draft, false);
});
