// card pool-withdraws-to-any-chain: SIGN_HOST's exit (src/pool-exit.ts) on the helper's 1Click proxy as the mock answers
// it (./oneclick-mock.ts, signed by a key this process alone trusts): the device's own request goes out, the answer is
// checked at the page's own prices, and only a deposit address of the pool's own chain comes back.
//   node --test test/pool-exit.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDRESS, COLLECTOR, NOW, h1c, type Answer } from "./oneclick-mock.ts";

const { poolExit, exitsOf } = await import("../src/pool-exit.ts");

const TYPED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const W1 = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx"; // the run's first W
const PRICES = { solana: { price: "15000000000", expo: -8 }, base: { price: "300000000000", expo: -8 }, robinhood: { price: "300000000000", expo: -8 } } as const;
// 0.1 SOL at 150 into ETH at 3,000: 0.005 ETH, 1Click's pair fee 20 on the route
const ETH_OUT = (a: Answer) => {
  Object.assign(a.quote, { amountInFormatted: "0.1", amountOut: "4990000000000000", amountOutFormatted: "0.00499", minAmountOut: "4940100000000000", withdrawFee: "0" });
  a.quoteRequest.appFees = [{ recipient: COLLECTOR, fee: 20 }];
};
const deps = (fetch: typeof globalThis.fetch, network = "mainnet") => ({ network, price: (c: keyof typeof PRICES) => PRICES[c], fetch, now: () => NOW });
const READY = { chain: "solana", dest: "base", to: TYPED, amount: 100_000_000n, maxFee: 1_305_000n } as const;

test("the pool's own chain: no exit, the run as built", () => {
  assert.equal(poolExit(deps(h1c().fetch), { chain: "solana", to: W1, amount: 1n, maxFee: 1n }), undefined);
  assert.deepEqual(exitsOf({ network: "mainnet" }, "solana"), ["base", "robinhood", "near"]);
  assert.equal(exitsOf({ network: "testnet" }, "solana"), undefined, "no other chain on the testnet build");
});

test("another chain: the device's own request (typed recipient, payout, refund to the first W on the pool's chain), the checked deposit address back", async () => {
  const m = h1c({ before: ETH_OUT });
  const got = await poolExit(deps(m.fetch), READY)!(W1);
  assert.equal(got, ADDRESS);
  assert.equal(m.sent.length, 1);
  const r = m.sent[0]!.request;
  assert.deepEqual([r.originAsset, r.destinationAsset, r.amount, r.recipient, r.recipientType, r.refundTo, r.refundType, r.dry],
    ["nep141:sol.omft.near", "nep141:base.omft.near", "100000000", TYPED, "DESTINATION_CHAIN", W1, "ORIGIN_CHAIN", false]);
});

test("refused: the testnet build, no price, a min out past the slippage, a deposit address not of the pool's chain", async () => {
  await assert.rejects(poolExit(deps(h1c({ before: ETH_OUT }).fetch, "testnet"), READY)!(W1));
  await assert.rejects(poolExit({ ...deps(h1c({ before: ETH_OUT }).fetch), price: () => null }, READY)!(W1));
  await assert.rejects(poolExit(deps(h1c({ before: (a) => (ETH_OUT(a), void (a.quote.minAmountOut = "4900000000000000")) }).fetch), READY)!(W1));
  // a Base pool to Solana: the mock's Solana-shaped deposit address is no address on Base
  const fromBase = { chain: "base", dest: "solana", to: W1, amount: 5_000_000_000_000_000n, maxFee: 1n } as const;
  const sol = (a: Answer) => {
    Object.assign(a.quote, { amountInFormatted: "0.005", amountOut: "99900000", amountOutFormatted: "0.0999", minAmountOut: "98901000", withdrawFee: "0" });
    a.quoteRequest.appFees = [{ recipient: COLLECTOR, fee: 20 }];
  };
  await assert.rejects(poolExit(deps(h1c({ before: sol }).fetch), fromBase)!("0x52908400098527886E0F7030069857D2E4169EE7"), /deposit address/);
});
