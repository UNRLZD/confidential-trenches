// Card sell-box-says-quoting: the sell box's You receive says Quoting from its preview's ask until the answer, a refusal
// asked no more, or a new token or amount, as the buy box's does (trade/model.ts quotingShown and dryTag). The box's own
// loop with a slow preview (one the kit client ends at 10 s) is driven in test/sell-positions/run.mjs (dry=late); this is
// the rule.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as P from "../src/screens/positions/model.ts";

const MINT = "MINT";

test("the sell preview's Quoting: asked and no number, for this token and amount only", () => {
  const tag = P.sellDryTag(MINT, "0.36");
  assert.equal(tag, `${MINT}|0.36`);
  assert.equal(P.sellQuoting(false, MINT, "0.36", tag), true, "asked, no number yet");
  assert.equal(P.sellQuoting(true, MINT, "0.36", tag), false, "a number shows (its own or the last, dimmed)");
  assert.equal(P.sellQuoting(false, MINT, "0.36", null), false, "the ask ended with no number: the dash");
  assert.equal(P.sellQuoting(false, MINT, "0.18", tag), false, "another amount's ask");
  assert.equal(P.sellQuoting(false, "OTHER", "0.36", tag), false, "another token's ask");
  assert.equal(P.sellDryTag(MINT, null), null);
  assert.equal(P.sellQuoting(false, MINT, null, null), false, "no amount: nothing asked");
});
