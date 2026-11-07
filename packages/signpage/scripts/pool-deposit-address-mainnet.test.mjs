// The mainnet run's record (scripts/pool-deposit-address-mainnet.mjs recordOf): a SUCCESS status of the device's own
// pool quote gives the record's lines; any other status, recipient, refund or tx shape is refused and nothing written.
// On 1Click's own recorded SUCCESS answer into Solana (apps/helper/src/bind/fixtures/oneclick-status.json success_sol),
// changed only where the pool quote differs from that test-money deposit.
//   node --test packages/signpage/scripts/pool-deposit-address-mainnet.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58, hex } from "@scure/base";
import { recordOf, originChainOf } from "./pool-deposit-address-mainnet.mjs";

const FIX = JSON.parse(readFileSync(new URL("../../../apps/helper/src/bind/fixtures/oneclick-status.json", import.meta.url), "utf8")).answers.success_sol;
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const ORIGIN_TX = "0x" + "1a".repeat(32);
const POOL_TX = "3".repeat(87);
function good() {
  const s = structuredClone(FIX);
  const qr = s.quoteResponse.quoteRequest;
  qr.originAsset = BASE_USDC;
  qr.refundType = "INTENTS";
  qr.refundTo = hex.encode(base58.decode(qr.recipient)); // U_X's own key, as the device's pool quote asks
  s.swapDetails.originChainTxHashes = [{ hash: ORIGIN_TX, explorerUrl: "" }];
  return s;
}
const ADDR = FIX.quoteResponse.quote.depositAddress;
const DELIVERY = FIX.swapDetails.destinationChainTxHashes[0].hash;

test("recorded good answer: a SUCCESS of the pool quote into Solana gives the record, three txs, money path", () => {
  assert.deepEqual(recordOf("solana", ADDR, good(), POOL_TX), [
    "CARD pool-deposit-address / live: PASS", "Money path: yes", `Tx: base ${ORIGIN_TX}`, `Tx: solana ${DELIVERY}`, `Tx: solana ${POOL_TX}`,
  ]);
});

test("recorded bad answer: 1Click's own test-money deposit as recorded (refund to the origin chain, from NEAR) is refused", () => {
  assert.throws(() => recordOf("solana", ADDR, FIX, POOL_TX), /refund is not to a 64-hex id/);
});

test("refused, nothing written: another status, address, chain, recipient, refund or tx shape", () => {
  const bad = [
    [(s) => { s.status = "REFUNDED"; }, /status REFUNDED/],
    [(s) => { s.quoteResponse.quote.depositAddress = "x"; }, /another deposit address/],
    [(s) => { s.quoteResponse.quoteRequest.dry = true; }, /not a live quote/],
    [(s) => { s.quoteResponse.quoteRequest.destinationAsset = "nep141:base.omft.near"; }, /not solana's pool coin/],
    [(s) => { s.quoteResponse.quoteRequest.refundTo = "ab".repeat(32); }, /not its own key/],
    [(s) => { s.quoteResponse.quoteRequest.recipientType = "INTENTS"; }, /not on the destination chain/],
    [(s) => { s.quoteResponse.quoteRequest.originAsset = "nep141:wrap.near"; }, /not on Solana or Base/],
    [(s) => { s.swapDetails.originChainTxHashes = []; }, /one origin tx/],
    [(s) => { s.swapDetails.originChainTxHashes = [{ hash: DELIVERY }]; }, /not a base tx/],
  ];
  for (const [change, why] of bad) {
    const s = good();
    change(s);
    assert.throws(() => recordOf("solana", ADDR, s, POOL_TX), why, String(why));
  }
  assert.throws(() => recordOf("solana", ADDR, good(), "0x" + "2b".repeat(32)), /pool tx/);
  assert.throws(() => recordOf("solana", ADDR, good(), DELIVERY), /a tx twice/);
  assert.throws(() => recordOf("near", ADDR, good(), POOL_TX), /no pool on near/);
  assert.equal(originChainOf("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"), "solana");
  assert.equal(originChainOf("nep141:wrap.near"), null);
});
