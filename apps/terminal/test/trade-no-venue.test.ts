// Card solana-buy-never-moves-cash-for-a-coin-it-cannot-buy: a Solana coin the private buy has no venue for (no pump.fun
// curve, no PumpSwap pool: the owner's NEARKAT, 14 Nov 20:33Z) draws Buy off before any tap, with the trade box's
// accepted line for a buy the pool cannot make (Unavailable, owner 10 Nov 18:12Z), as after a refused tap. The page's
// pool.buy.dry for the coin answers quote_check_failed when the coin's venue read throws (signpage src/pools.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { coinTapAgainMs, coinUnavailable } from "../src/screens/trade/model.ts";
import { WORDS as TR } from "../src/screens/trade/words.ts";

test("the trade box: a Solana coin whose pool.buy.dry says no venue draws Buy and its presets off with Unavailable, before any tap", () => {
  assert.equal(coinUnavailable("solana", "quote_check_failed"), true);
  // a page that is busy or a provider that failed asks again (coinTapAgainMs): Buy stays on; no other code, no other chain
  for (const code of ["busy", "down", "not_funded", "not_allowed", "failed"]) assert.equal(coinUnavailable("solana", code), false, code);
  for (const chain of ["base", "robinhood", "near"] as const) assert.equal(coinUnavailable(chain, "quote_check_failed"), false, chain);
  assert.equal(coinTapAgainMs("quote_check_failed"), null, "never asked again for that coin and those proofs");
  assert.equal(TR.unavailable.text, "Unavailable");
  const box = readFileSync(new URL("../src/screens/trade/TradeBox.tsx", import.meta.url), "utf8");
  // the coin's dry answer sets the box off for that coin key alone, Buy and the presets read it, a tap does nothing
  assert.match(box, /if \(coinUnavailable\(chain, o\.error\.code\)\) return void setNoVenue\(coinKey\);/);
  assert.match(box, /const coinOff = noVenue !== null && noVenue === coinKey;\n\s+const off = unavailable\(phase\) \|\| coinOff;/);
  assert.match(box, /const canBuy = ready && !running && !off && /);
  assert.match(box, /const presetOff = \(p: Cents \| null\) => [^\n]*\|\| off \|\|/);
  assert.match(box, /unavailable\(phaseRef\.current\) \|\| coinOff \|\|/);
  // one short line where Max sits, the trade box's own word
  assert.match(box, /\) : coinOff \? \(\n\s+<span className="trb-end" data-end="failed" data-testid="trade-end">\n\s+<W id="unavailable" \/>/);
});
