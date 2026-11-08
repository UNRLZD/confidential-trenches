// The mainnet run's record (scripts/pool-deposit-address-mainnet.mjs recordOf): a SUCCESS status of the device's own
// pool quote gives the record's lines; any other status, recipient, refund or tx shape is refused and nothing written.
// On 1Click's own recorded SUCCESS answer into Solana (apps/helper/src/bind/fixtures/oneclick-status.json success_sol),
// changed only where the pool quote differs from that test-money deposit.
//   node --test packages/signpage/scripts/pool-deposit-address-mainnet.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58, hex } from "@scure/base";
import { POOL_RPCS, readPoolTx, recordOf, originChainOf } from "./pool-deposit-address-mainnet.mjs";
import { RPCS } from "../../../scripts/ci/money-gate.mjs";

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
const U = FIX.quoteResponse.quoteRequest.recipient; // the Solana U_X the device's pool.address answered
const OWN = { u: U };

test("recorded good answer: a SUCCESS of the pool quote into Solana gives the record, three txs, money path", () => {
  assert.deepEqual(recordOf("solana", ADDR, good(), POOL_TX, OWN), [
    "CARD pool-deposit-address / live: PASS", "Money path: yes", `Tx: base ${ORIGIN_TX}`, `Tx: solana ${DELIVERY}`, `Tx: solana ${POOL_TX}`,
  ]);
});

test("recorded bad answer: 1Click's own test-money deposit as recorded (refund to the origin chain, from NEAR) is refused", () => {
  assert.throws(() => recordOf("solana", ADDR, FIX, POOL_TX, OWN), /refund is not to a 64-hex id/);
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
    assert.throws(() => recordOf("solana", ADDR, s, POOL_TX, OWN), why, String(why));
  }
  assert.throws(() => recordOf("solana", ADDR, good(), "0x" + "2b".repeat(32), OWN), /pool tx/);
  assert.throws(() => recordOf("solana", ADDR, good(), DELIVERY, OWN), /a tx twice/);
  assert.throws(() => recordOf("near", ADDR, good(), POOL_TX, OWN), /no pool on near/);
  assert.equal(originChainOf("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"), "solana");
  assert.equal(originChainOf("nep141:wrap.near"), null);
});

// ---- review F1: the record is the device's own deposit, whole, and its pool tx is U_X's deposit into the pinned pool ----
const EVM_U = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"; // an EIP-55 vector, no user's
const EVM_ID = "cd".repeat(32);
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const EVM_OWN = { u: EVM_U, refundId: EVM_ID };
function baseGood() {
  const s = structuredClone(FIX);
  const qr = s.quoteResponse.quoteRequest;
  Object.assign(qr, { originAsset: SOL_USDC, destinationAsset: "nep141:base.omft.near", recipient: EVM_U, refundType: "INTENTS", refundTo: EVM_ID });
  s.swapDetails.originChainTxHashes = [{ hash: "5".repeat(87), explorerUrl: "" }];
  s.swapDetails.destinationChainTxHashes = [{ hash: "0x" + "ab".repeat(32), explorerUrl: "" }];
  return s;
}

test("review F1: a Base record passes only for the device's own EIP-55 U_X and its U_{s,i} refund id", () => {
  assert.equal(recordOf("base", ADDR, baseGood(), "0x" + "ef".repeat(32), EVM_OWN)[0], "CARD pool-deposit-address / live: PASS");
  const bad = [
    [(s) => { s.quoteResponse.quoteRequest.recipient = "0x000000000000000000000000000000000000dEaD"; }, EVM_OWN, /not the device's U_X/], // a stranger's 0x
    [(s) => { s.quoteResponse.quoteRequest.recipient = EVM_U.toLowerCase(); }, EVM_OWN, /not the device's U_X/], // not EIP-55
    [(s) => { s.quoteResponse.quoteRequest.refundTo = "ab".repeat(32); }, EVM_OWN, /not the device's U_\{s,i\}/], // a foreign refund id
    [() => {}, { u: EVM_U.toLowerCase(), refundId: EVM_ID }, /not an EIP-55 address/],
    [() => {}, { u: EVM_U }, /--refund-id/],
    [(s) => { s.quoteResponse.quoteRequest.originAsset = "nep141:base.omft.near"; }, EVM_OWN, /the pool's own coin/],
  ];
  for (const [change, own, why] of bad) {
    const s = baseGood();
    change(s);
    assert.throws(() => recordOf("base", ADDR, s, "0x" + "ef".repeat(32), own), why, String(why));
  }
});

test("review F1: on Solana a self-refunding keypair that is not the device's U_X is refused", () => {
  const s = good();
  const other = base58.encode(new Uint8Array(32).fill(7));
  s.quoteResponse.quoteRequest.recipient = other;
  s.quoteResponse.quoteRequest.refundTo = hex.encode(base58.decode(other)); // its own key, as the device asks, but not U_X
  assert.throws(() => recordOf("solana", ADDR, s, POOL_TX, OWN), /not the device's U_X/);
  assert.throws(() => recordOf("solana", ADDR, good(), POOL_TX, { u: U, refundId: "ab".repeat(32) }), /its own key/);
});

test("review F1: a SUCCESS that refunded any part, or deposited other than the quote's amount, is refused", () => {
  const most = good();
  most.swapDetails.refundedAmount = "8000000000000000000000000";
  most.swapDetails.depositedAmount = "1";
  assert.throws(() => recordOf("solana", ADDR, most, POOL_TX, OWN), /refunded/);
  const short = good();
  short.swapDetails.depositedAmount = "1";
  assert.throws(() => recordOf("solana", ADDR, short, POOL_TX, OWN), /deposited 1/);
  const none = good();
  delete none.swapDetails.refundedAmount;
  assert.throws(() => recordOf("solana", ADDR, none, POOL_TX, OWN), /refunded/);
});

test("review F1 (P3, P6): a delivery tx of another chain's shape, or two delivery txs, is refused", () => {
  const shape = good();
  shape.swapDetails.destinationChainTxHashes = [{ hash: "0x" + "ab".repeat(32), explorerUrl: "" }];
  assert.throws(() => recordOf("solana", ADDR, shape, POOL_TX, OWN), /delivery tx/);
  const two = good();
  two.swapDetails.destinationChainTxHashes = [{ hash: DELIVERY }, { hash: "4".repeat(87) }];
  assert.throws(() => recordOf("solana", ADDR, two, POOL_TX, OWN), /one delivery tx/);
});

// The pool tx's reads: each RPC answers from `answer(url)`; the pin and the two RPCs as given.
const PIN = "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF";
const TWO = ["https://a.test", "https://b.test"];
const fetchOf = (answer) => async (url) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer(String(url)) }), { status: 200 });
const solTx = (o = {}) => ({
  slot: 7,
  meta: { err: o.err ?? null, loadedAddresses: { writable: [], readonly: [] } },
  transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [o.signer ?? U, "11111111111111111111111111111111", o.program ?? PIN],
    instructions: [{ programIdIndex: 2, accounts: [0, 1], data: base58.encode(Uint8Array.of(o.tag ?? 1, 0, 0)) }] } },
});

test("review F1: the pool tx reads on both RPCs as U_X's tag 1 deposit into the pinned Solana pool, alike", async () => {
  await readPoolTx("solana", POOL_TX, U, { fetch: fetchOf(() => solTx()), rpcs: TWO, pin: PIN });
  const bad = [
    [() => solTx({ program: "11111111111111111111111111111112" }), /no deposit \(tag 1\)/], // any other program's tx
    [() => solTx({ tag: 2 }), /no deposit \(tag 1\)/],
    [() => solTx({ signer: base58.encode(new Uint8Array(32).fill(7)) }), /not signed by U_X/],
    [() => solTx({ err: { InstructionError: [0, "Custom"] } }), /failed or is not final/],
    [(url) => (url.includes("b.test") ? null : solTx()), /no answer/],
    [(url) => ({ ...solTx(), slot: url.includes("b.test") ? 8 : 7 }), /read the pool tx apart/],
  ];
  for (const [answer, why] of bad) await assert.rejects(readPoolTx("solana", POOL_TX, U, { fetch: fetchOf(answer), rpcs: TWO, pin: PIN }), why, String(why));
});

test("review F1: on Base the pool tx is a succeeded receipt from U_X with the pinned pool's Deposited log; no pin, no record", async () => {
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const topic = `0x${hex.encode(keccak_256(new TextEncoder().encode("Deposited(address,uint256,uint256,uint256,uint256)")))}`;
  const pool = "0x" + "77".repeat(20);
  const receipt = (o = {}) => ({ status: o.status ?? "0x1", from: o.from ?? EVM_U.toLowerCase(), blockHash: "0x" + "99".repeat(32),
    logs: [{ address: o.address ?? pool, topics: [o.topic ?? topic] }] });
  const tx = "0x" + "ef".repeat(32);
  await readPoolTx("base", tx, EVM_U, { fetch: fetchOf(() => receipt()), rpcs: TWO, pin: pool });
  for (const [o, why] of [[{ status: "0x0" }, /did not succeed/], [{ from: "0x" + "12".repeat(20) }, /not sent by U_X/], [{ address: "0x" + "78".repeat(20) }, /no Deposited log/], [{ topic: "0x" + "00".repeat(32) }, /no Deposited log/]])
    await assert.rejects(readPoolTx("base", tx, EVM_U, { fetch: fetchOf(() => receipt(o)), rpcs: TWO, pin: pool }), why, String(why));
  await assert.rejects(readPoolTx("base", tx, EVM_U, { fetch: fetchOf(() => receipt()), rpcs: TWO }), /no pool pinned on base/);
});

test("the pool tx's RPCs are the money gate's, so the record's reads and the gate's are one list", () => {
  for (const c of ["solana", "base", "robinhood"]) assert.deepEqual(POOL_RPCS[c], RPCS[c], c);
});
