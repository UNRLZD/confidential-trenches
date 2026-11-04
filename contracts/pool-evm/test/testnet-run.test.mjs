// node --test contracts/pool-evm/test/testnet-run.test.mjs: the pure parts of script/testnet-run.mjs. Each call's data
// is byte for byte what `cast calldata` (Foundry 1.7.1) gives for the same signature and values
// (fixtures/testnet-run-calldata.json, recorded 4 Nov); the Withdraw digest is cast's (cast keccak of 0x1901 ‖ the
// domain ‖ the struct, recorded below); a type 4 transaction's signature recovers to its sender and carries the
// authorization as signed; a revert's custom error is named.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { bytes, hex, keccak, selector } from "../../../scripts/live-checks/pool-evm-deploy.mjs";
import { intBytes, rlp } from "../script/deploy.mjs";
import { WITHDRAW_TRIES, buyData, depositData, revertName, sellData, signTx7702, v3QuoteData, v4QuoteData, withdrawData, withdrawDigest, withdrawLeft } from "../script/testnet-run-lib.mjs";

const V = JSON.parse(readFileSync(new URL("./fixtures/testnet-run-calldata.json", import.meta.url), "utf8"));
const { secp256k1 } = await import(createRequire(new URL("../../../packages/kit/package.json", import.meta.url)).resolve("@noble/curves/secp256k1.js"));
const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222", Z = "0x0000000000000000000000000000000000000000";
const PROOF = [[1n, 2n], [[3n, 4n], [5n, 6n]], [7n, 8n], [9n, 10n, 11n, 12n, 13n, 14n, 15n, 16n]];

test("each call's data is cast calldata's, byte for byte", () => {
  assert.equal(depositData(5n, 6n), V.deposit);
  assert.equal(withdrawData(A, "0xaabbcc", PROOF, 17n, `0x${"ab".repeat(65)}`), V.withdraw);
  assert.equal(buyData(A, "0xaabbcc", PROOF, 17n, { adapter: B, data: "0x0102", minOut: 18n, token: A }, `0x${"cd".repeat(65)}`), V.buy);
  assert.equal(sellData({ token: A, amount: 1n, target: B, data: "0x0a0b0c", minOut: 2n, pool: A, precommitment: 3n, feeCap: 4n, deadline: 5n, nonce: 6n }, 7n, `0x${"ef".repeat(65)}`), V.sell);
  assert.equal(v4QuoteData({ currency0: Z, currency1: A, fee: 100, tickSpacing: 1, hooks: Z }, true, 1000n), V.v4Quote);
  assert.equal(v3QuoteData(A, B, 1000n, 3000), V.v3Quote);
  // a changed value changes the data (the encoder reads every field)
  assert.notEqual(withdrawData(A, "0xaabbcc", PROOF, 18n, `0x${"ab".repeat(65)}`), V.withdraw);
});

test("the Withdraw digest is cast's for PrivacyPool.sol's typehash and domain", () => {
  assert.equal(hex(withdrawDigest(84532n, A, 1n, 2n, 3n)), "0xc849cd960be74eaa7edad7412b1ffdebfd3aaa01cda677dfa8905046afaeddf1");
  assert.notEqual(hex(withdrawDigest(84533n, A, 1n, 2n, 3n)), "0xc849cd960be74eaa7edad7412b1ffdebfd3aaa01cda677dfa8905046afaeddf1");
});

test("a type 4 transaction: its signature recovers to the sender, over 0x04 ‖ rlp of the fields and the authorization", () => {
  const sk = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const auth = { chainId: 84532, address: B, nonce: 0n, yParity: 1, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` };
  const t = { chainId: 84532n, nonce: 3n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 100_000n, to: A, value: 0n, data: "0xdeadbeef", authorizations: [auth] };
  const { raw, hash } = signTx7702(sk, t);
  assert.equal(raw.slice(0, 4), "0x04");
  assert.equal(hash, keccak(raw));
  const unsigned = [...[84532n, 3n, 1n, 2n, 100_000n].map(intBytes), bytes(A), intBytes(0n), bytes("0xdeadbeef"), [], [[intBytes(84532), bytes(B), intBytes(0n), intBytes(1), intBytes(BigInt(auth.r)), intBytes(BigInt(auth.s))]]];
  const body = rlp(unsigned);
  // the signed list is the unsigned one plus yParity, r, s: its payload starts with the unsigned list's payload
  const signed = bytes(raw).subarray(1);
  const payloadOf = (b) => (b[0] <= 0xf7 ? b.subarray(1) : b.subarray(1 + b[0] - 0xf7));
  assert.deepEqual(payloadOf(signed).subarray(0, payloadOf(body).length), payloadOf(body));
  const tail = payloadOf(signed).subarray(payloadOf(body).length);
  // yParity (1 byte), r and s (0xa0 + 32 bytes each, as neither starts with a zero byte here)
  const v = tail[0] === 0x80 ? 0 : tail[0];
  const r = tail.subarray(2, 34), s = tail.subarray(35, 67);
  const sig = new secp256k1.Signature(BigInt(hex(r)), BigInt(hex(s))).addRecoveryBit(v);
  const pub = sig.recoverPublicKey(bytes(keccak(Uint8Array.of(4, ...body)))).toBytes(false);
  assert.deepEqual(pub, secp256k1.getPublicKey(sk, false));
});

test("a revert names its custom error; unknown data is kept", () => {
  assert.equal(revertName(selector("PartialFill()")), "PartialFill()");
  assert.equal(revertName(`${selector("InvalidSignature()")}`), "InvalidSignature()");
  assert.equal(revertName("0x12345678"), "0x12345678");
  assert.equal(revertName(undefined), "no revert data");
});

// The stop path: the deployed pool has no ragequit (src/PrivacyPool.sol), so a note is only ever got out by a withdraw.
// A withdraw that cannot land (run 1's DeadlineExpired: an epoch read before a slow sync) is tried again, each try a
// fresh release (new trees, epoch, bind and proof), so a stopped run no longer leaves its notes in the pool.
const deadline = new Error("withdraw: the simulation reverts (DeadlineExpired()): execution reverted");
test("a withdraw that reverts DeadlineExpired is tried again with a fresh release, and lands", async () => {
  const notes = [{ ref: { kind: "deposit" }, value: 3n, spent: false }, { ref: { kind: "change" }, value: 0n, spent: false }];
  const calls = [], said = [];
  const ok = await withdrawLeft(notes, async (n) => { calls.push(n.ref.kind); if (calls.length === 1) throw deadline; n.spent = true; }, (m) => said.push(m));
  assert.equal(ok, true);
  assert.deepEqual(calls, ["deposit", "deposit"]); // the empty note is left alone
  assert.match(said[0], /withdraw of the deposit note \(3 wei\), try 1 of 3, failed: withdraw: the simulation reverts \(DeadlineExpired\(\)\)/);
});
test("a withdraw that never lands is tried WITHDRAW_TRIES times, the run is not done and the log names the note left", async () => {
  const notes = [{ ref: { kind: "change" }, value: 7n, spent: false }];
  let n = 0;
  const said = [];
  assert.equal(await withdrawLeft(notes, async () => { n++; throw deadline; }, (m) => said.push(m)), false);
  assert.equal(n, WITHDRAW_TRIES);
  assert.match(said.at(-1), /the change note \(7 wei\) stays in the pool after 3 tries/);
});
test("a note spent by a try that landed late is not tried again", async () => {
  const notes = [{ ref: { kind: "deposit" }, value: 2n, spent: false }];
  let n = 0;
  // the send throws after the withdraw landed (as a receipt read that times out would), and release marked it spent
  assert.equal(await withdrawLeft(notes, async (x) => { n++; x.spent = true; throw new Error("receipt: timed out"); }, () => {}), true);
  assert.equal(n, 1);
});
