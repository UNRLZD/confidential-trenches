// node --test test/deposit-dry-count.test.ts (from packages/signpage): the 1Click calls one deposit sheet open sends at
// worst, deposit.assets then one deposit.dry, while 1Click answers every quote 400 "Failed to get quote" (card
// helper-says-why-a-vendor-refused, review P3): 13, where 5 went while 1Click quotes (apps/helper/src/proxy/proxy.ts
// DEPOSIT_SHEET_CALLS). A change that raises it fails here, so the helper's share is sized against a held number.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPOSIT_ASSET_CHAINS, DEPOSIT_TOKENS_URL, depositAssetsKind, depositDryKind } from "../src/rules/deposit-dry.ts";
import { DEPOSIT_QUOTE_URL, NO_LIQUIDITY_PAUSES_MS } from "../../wallet/src/deposit/quote.ts";

function net(quote: () => Response) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u === DEPOSIT_TOKENS_URL ? "tokens" : u === DEPOSIT_QUOTE_URL ? "quote" : u);
    if (u === DEPOSIT_TOKENS_URL)
      return new Response(JSON.stringify(DEPOSIT_ASSET_CHAINS.map((a) => ({ assetId: a.id, symbol: "USDC", decimals: 6, blockchain: a.blockchain }))), { status: 200, headers: { "content-type": "application/json" } });
    return quote();
  }) as typeof fetch;
  return { fetchFn, calls };
}
const failed = () => new Response(JSON.stringify({ message: "Failed to get quote" }), { status: 400, headers: { "content-type": "application/json" } });

test("one sheet open during a 1Click 400 spell sends 13 vendor calls, and still shows Not available", async () => {
  const n = net(failed);
  const ctx = { fetch: n.fetchFn, sleep: async () => {} };
  const assets = await depositAssetsKind(ctx);
  const dry = await depositDryKind({ origin_asset: DEPOSIT_ASSET_CHAINS[1]!.id, amount: "25" }, ctx);
  assert.deepEqual(assets, { ok: false, code: "not_available" });
  assert.deepEqual(dry, { ok: false, code: "not_available" });
  const asks = 1 + NO_LIQUIDITY_PAUSES_MS.length;
  assert.equal(asks, 3);
  assert.equal(n.calls.filter((c) => c === "tokens").length, 1);
  assert.equal(n.calls.filter((c) => c === "quote").length, DEPOSIT_ASSET_CHAINS.length * asks + asks);
  assert.equal(n.calls.length, 13);
});
