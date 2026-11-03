// SPDX-License-Identifier: Apache-2.0
// The pure parts of the EVM pool's testnet run (testnet-run.mjs): the ABI encoding of the pool's, the sell delegate's
// and the quoters' calls, the EIP-7702 (type 4) transaction, the run's Withdraw signature and the custom errors' names.
// No network, no key kept: test/testnet-run.test.mjs checks each encoding against `cast calldata`'s, recorded.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { intBytes, rlp } from "./deploy.mjs";
import { bytes, hex, keccak, selector } from "../../../scripts/live-checks/pool-evm-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(HERE, "../../../packages/kit/package.json"));
const { secp256k1 } = await import(pathToFileURL(req.resolve("@noble/curves/secp256k1.js")).href);

// ---- ABI: a type is "w" (one word: uint, int >= 0, address, bool), "b" (bytes), ["t", ...types] (a tuple) or
// ["a", n, type] (a fixed array) ----
const W = 32;
const dynamic = (t) => t === "b" || (Array.isArray(t) && (t[0] === "t" ? t.slice(1).some(dynamic) : dynamic(t[2])));
const headSize = (t) => (dynamic(t) ? W : t === "w" ? W : t[0] === "t" ? t.slice(1).reduce((s, x) => s + headSize(x), 0) : t[1] * headSize(t[2]));
const wordOf = (v) => {
  const n = typeof v === "string" ? BigInt(v) : typeof v === "boolean" ? BigInt(v) : v;
  if (typeof n !== "bigint" || n < 0n || n >= 1n << 256n) throw new Error(`abi: ${String(v)} is not a word`);
  return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
};
function encodeOne(t, v) {
  if (t === "w") return wordOf(v);
  if (t === "b") {
    const b = Buffer.from(typeof v === "string" ? bytes(v) : v);
    return Buffer.concat([wordOf(BigInt(b.length)), b, Buffer.alloc((W - (b.length % W)) % W)]);
  }
  if (t[0] === "t") return encodeList(t.slice(1), v);
  if (!Array.isArray(v) || v.length !== t[1]) throw new Error(`abi: a fixed array of ${t[1]}`);
  return encodeList(Array(t[1]).fill(t[2]), v);
}
/** abi.encode of `values` as `types` (a tuple's head and tail) */
export function encodeList(types, values) {
  if (!Array.isArray(values) || values.length !== types.length) throw new Error(`abi: ${types.length} values`);
  let tailAt = types.reduce((s, t) => s + headSize(t), 0);
  const heads = [], tails = [];
  types.forEach((t, i) => {
    const e = encodeOne(t, values[i]);
    if (dynamic(t)) {
      heads.push(wordOf(BigInt(tailAt)));
      tails.push(e);
      tailAt += e.length;
    } else heads.push(e);
  });
  return Buffer.concat([...heads, ...tails]);
}
/** A call's data: the selector of `signature`, then its arguments */
export const calldata = (signature, types, values) => selector(signature) + encodeList(types, values).toString("hex");

const WITHDRAWAL = ["t", "w", "b"];
const PROOF = ["t", ["a", 2, "w"], ["a", 2, ["a", 2, "w"]], ["a", 2, "w"], ["a", 8, "w"]];
const BUY = ["t", "w", "b", "w", "w"];
const SELL = ["t", "w", "w", "w", "b", "w", "w", "w", "w", "w", "w"];
export const SIGS = Object.freeze({
  deposit: "deposit(uint256,uint256)",
  withdraw: "withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)",
  buy: "buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)",
  sell: "sell((address,uint256,address,bytes,uint256,address,uint256,uint256,uint256,uint256),uint256,bytes)",
  v4Quote: "quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))",
  v3Quote: "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
});

/** The pool's WithdrawProof from snarkjs JSON: pB is pi_b with each pair swapped (the Solidity verifier's order) */
export const proofArg = (proof, publicSignals) => [
  [proof.pi_a[0], proof.pi_a[1]].map(BigInt),
  [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]].map((p) => p.map(BigInt)),
  [proof.pi_c[0], proof.pi_c[1]].map(BigInt),
  publicSignals.map(BigInt),
];
const sigHex = (s) => (typeof s === "string" ? s : hex(s));

export const depositData = (value, precommitment) => calldata(SIGS.deposit, ["w", "w"], [value, precommitment]);
/** PrivacyPool.withdraw(Withdrawal{processooor, data}, proof, fee, W's signature) */
export const withdrawData = (processooor, relayBytes, proof, fee, signature) =>
  calldata(SIGS.withdraw, [WITHDRAWAL, PROOF, "w", "b"], [[processooor, relayBytes], proof, fee, sigHex(signature)]);
/** PrivacyPoolSimple.buy(Withdrawal, proof, fee, Buy{adapter, data, minOut, token}, W's signature) */
export const buyData = (processooor, relayBytes, proof, fee, built, signature) =>
  calldata(SIGS.buy, [WITHDRAWAL, PROOF, "w", BUY, "b"], [[processooor, relayBytes], proof, fee, [built.adapter, built.data, built.minOut, built.token], sigHex(signature)]);
/** SellDelegate.sell(Sell, fee, W's signature), the kit's built sell */
export const sellData = (s, fee, signature) =>
  calldata(SIGS.sell, [SELL, "w", "b"], [[s.token, s.amount, s.target, s.data, s.minOut, s.pool, s.precommitment, s.feeCap, s.deadline, s.nonce], fee, sigHex(signature)]);
/** V4Quoter.quoteExactInputSingle({poolKey, zeroForOne, exactAmount, hookData}) */
export const v4QuoteData = (key, zeroForOne, amount) =>
  calldata(SIGS.v4Quote, [["t", ["t", "w", "w", "w", "w", "w"], "w", "w", "b"]], [[[key.currency0, key.currency1, BigInt(key.fee), BigInt(key.tickSpacing), key.hooks], zeroForOne, amount, "0x"]]);
/** QuoterV2.quoteExactInputSingle({tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0}) */
export const v3QuoteData = (tokenIn, tokenOut, amount, fee) => calldata(SIGS.v3Quote, [["t", "w", "w", "w", "w", "w"]], [[tokenIn, tokenOut, amount, BigInt(fee), 0n]]);
export const balanceOfData = (who) => calldata("balanceOf(address)", ["w"], [who]);

// ---- The Withdraw W signs (PrivacyPool.sol WITHDRAW_TYPEHASH, _typedDigest): the kit has no EVM withdraw signer yet,
// so the run makes this one digest itself, as test/Signing.sol does ----
const utf8 = (s) => new TextEncoder().encode(s);
const w32 = (v) => wordOf(BigInt(v));
/** The EIP-712 digest of Withdraw(nullifier, context, value) under {Blindfill, 1, chainId, pool} */
export function withdrawDigest(chainId, pool, nullifier, context, value) {
  const domain = bytes(keccak(Buffer.concat([bytes(keccak(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))), bytes(keccak(utf8("Blindfill"))), bytes(keccak(utf8("1"))), w32(chainId), w32(pool)])));
  const struct = bytes(keccak(Buffer.concat([bytes(keccak(utf8("Withdraw(uint256 nullifier,uint256 context,uint256 value)"))), w32(nullifier), w32(context), w32(value)])));
  return bytes(keccak(Buffer.concat([Buffer.from([0x19, 0x01]), domain, struct])));
}
/** W's 65-byte r ‖ s ‖ v signature of a digest, s low, v 27 or 28 */
export function sign65(digest, sk) {
  const rec = secp256k1.sign(digest, sk, { prehash: false, lowS: true, format: "recovered" });
  return hex(Uint8Array.of(...rec.subarray(1, 65), 27 + rec[0]));
}

// ---- EIP-7702: the type 4 transaction, its authorization list as the kit signs it ----
/** The signed raw type 4 transaction and its hash: rlp([chainId, nonce, tip, maxFee, gas, to, value, data, [],
 *  [[chainId, address, nonce, yParity, r, s]], yParity, r, s]) */
export function signTx7702(sk, t) {
  const auths = t.authorizations.map((a) => [intBytes(a.chainId), bytes(a.address), intBytes(a.nonce), intBytes(a.yParity), intBytes(BigInt(a.r)), intBytes(BigInt(a.s))]);
  const unsigned = [...[t.chainId, t.nonce, t.maxPriorityFeePerGas, t.maxFeePerGas, t.gas].map(intBytes), bytes(t.to), intBytes(t.value ?? 0n), bytes(t.data ?? "0x"), [], auths];
  const digest = bytes(keccak(Uint8Array.of(4, ...rlp(unsigned))));
  const sig = secp256k1.sign(digest, sk, { prehash: false, format: "recovered" });
  const raw = Uint8Array.of(4, ...rlp([...unsigned, intBytes(sig[0]), intBytes(BigInt(hex(sig.subarray(1, 33)))), intBytes(BigInt(hex(sig.subarray(33, 65))))]));
  return { raw: hex(raw), hash: keccak(raw) };
}
/** An authorization as eth_estimateGas takes it */
export const authJson = (a) => ({ chainId: `0x${BigInt(a.chainId).toString(16)}`, address: a.address, nonce: `0x${BigInt(a.nonce).toString(16)}`, yParity: `0x${a.yParity.toString(16)}`, r: a.r, s: a.s });

// ---- A revert's name: the custom errors the pool, the adapters and the delegate may throw ----
const ERRORS = [
  "MinimumDepositAmount()", "InvalidDepositValue()", "InvalidPrecommitment()", "PrecommitmentAlreadyUsed()", "InvalidRelayData()",
  "InvalidRecipient()", "FeeOverCap()", "InvalidSignature()", "RelayFeeGreaterThanMax()", "InvalidProcessooor()", "ContextMismatch()",
  "DeadlineExpired()", "InvalidTreeDepth()", "UnknownStateRoot()", "UnknownLabelRoot()", "InvalidWithdrawalAmount()", "InvalidProof()",
  "NullifierAlreadySpent()", "LeafAlreadyExists()", "InvalidMinOut()", "MinOutNotMet()", "InsufficientValue()", "FailedToSendNativeAsset()",
  "PartialFill()", "TooLittleReceived()", "InvalidRoute()", "NotPoolManager()", "InvalidNonce()", "LeftoverApproval()", "ApproveFailed()", "Reentrancy()",
  "MaxTreeDepthReached()", "ZeroAddress()",
];
const ERROR_OF = new Map(ERRORS.map((e) => [selector(e), e]));
/** The name of a revert's custom error from an RPC error's data, or the data itself */
export function revertName(data) {
  if (typeof data !== "string" || data.length < 10) return String(data ?? "no revert data");
  return ERROR_OF.get(data.slice(0, 10)) ?? data.slice(0, 138);
}
