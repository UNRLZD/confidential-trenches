// After a Base pool buy, Portfolio shows the position and the trade box's Sell side sells it into Base's pool (card
// signpage-positions-evm), from the state SIGN_HOST sends: sell-positions/live-state-evm.json is the signing page's own
// answer, recorded and held equal to it by packages/signpage/test/positions-evm.test.ts (the page's Base positions pass
// over two fake RPCs, the page's own testnet pools). Red before that card: the page sent no EVM position, so no row and
// no Sell on Base.
//   node --test test/sell-live-evm.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { heldOf, NO_DATA, portfolio } from "../src/screens/portfolio/model.ts";
import { sellAmount } from "../src/screens/positions/model.ts";
import { poolSellAsk } from "../src/screens/trade/model.ts";

const STATE = JSON.parse(readFileSync(new URL("./sell-positions/live-state-evm.json", import.meta.url), "utf8")) as SignpageState;
const snap = (state: SignpageState): SignpageClientSnapshot => ({ status: "ready", release: "signpage-v1", state, stale: false });
// the token page may name the token in its checksum case; the page's position names it in lower case
const CHECKSUM = "0x" + "0C".repeat(20);

test("the page's state after a Base pool buy: Portfolio draws the position, the Sell side has it, and Sell asks pool.sell on Base", () => {
  const [p] = STATE.positions;
  assert.ok(p, "the page sends the position");
  assert.equal(p.chain, "base");
  const rows = portfolio(snap(STATE), NO_DATA, Date.now()).rows;
  const row = heldOf(rows, "base", CHECKSUM);
  assert.ok(row, "Sell turns on");
  assert.equal(heldOf(rows, "robinhood", CHECKSUM), null, "never another chain's row of the same address");
  assert.equal(row.units, p.amount);
  assert.equal(row.decimals, p.decimals);
  assert.equal(row.cost, 0n, "no cost recorded for an EVM buy: unknown");
  assert.equal(sellAmount(row.units, 10_000, row.decimals), p.amount, "100% sells what W holds");
  assert.equal(sellAmount(row.units, 5_000, row.decimals), "6.172839", "50% at the token's own decimals");
  // the tap's request (positions/source.tsx useSell): pool.sell on the row's chain, a share of the whole holding
  assert.deepEqual(poolSellAsk(STATE.pools, row.chain, row.token, { share_bps: 10_000 }, 100), { kind: "pool.sell", params: { chain: "base", token: p.token, share_bps: 10_000, slippage_bps: 100 } });
});

test("the page's state before the card, no EVM position after the same buy: no row and no Sell side", () => {
  const before = { ...STATE, positions: [] };
  assert.equal(heldOf(portfolio(snap(before), NO_DATA, Date.now()).rows, "base", CHECKSUM), null);
});
