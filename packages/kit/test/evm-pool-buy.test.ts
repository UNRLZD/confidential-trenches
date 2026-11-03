// The device's EVM pool buy (src/trade/evm/buy.ts, card evm-pool-buy-tx) against the pool's own fixtures:
// contracts/pool-evm/test/fixtures/kit-routes.json (the fork tests' routes, which BuyFork.t.sol and BuyV4Fork.t.sol
// check against their own) and buy-proofs.json (W's EIP-712 Buy signed by cast, which Buy.t.sol checks the pool takes).
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  EVM_POOL_MAX_HOOK_DATA,
  EVM_POOL_MAX_HOPS,
  EVM_POOL_VENUES,
  EvmPoolBuyError,
  evmPoolBuild,
  evmPoolBuyDigest,
  evmPoolRouteData,
  evmPoolSignBuy,
  type EvmPoolChain,
  type EvmRoute,
  type EvmV4Hop,
} from "../src/index.ts";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../../contracts/pool-evm/test/fixtures/${f}`, import.meta.url), "utf8"));
const ROUTES = fixture("kit-routes.json");
const PROOFS = fixture("buy-proofs.json");
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof EvmPoolBuyError, String(e));
    return e.code;
  }
  return "built";
};

const ZERO = "0x0000000000000000000000000000000000000000";
const B = EVM_POOL_VENUES.base;
const USDC = B.middles[0]!;
const USDG = EVM_POOL_VENUES.robinhood.middles[0]!;
const X = "0xF111111111111111111111111111111111111111";
const Y = "0x2222222222222222222222222222222222222222";
const hop = (currency: string, o: Partial<EvmV4Hop> = {}): EvmV4Hop => ({ currency, fee: 500, tickSpacing: 10, hooks: ZERO, hookData: "0x", ...o });
const v4 = (currencyIn: string, ...hops: EvmV4Hop[]): EvmRoute => ({ venue: "uniswap-v4", currencyIn, hops });
const v3 = (tokens: string[], fees: number[] = tokens.slice(1).map(() => 500)): EvmRoute => ({ venue: "uniswap-v3", tokens, fees });

test("each fork test's route builds to the bytes the adapter reads, byte for byte", () => {
  let n = 0;
  for (const chain of ["base", "robinhood"] as EvmPoolChain[]) {
    for (const [name, r] of Object.entries(ROUTES[chain]) as [string, any][]) {
      const route: EvmRoute = r.venue === "uniswap-v3" ? v3(r.tokens, r.fees) : v4(r.currencyIn, ...r.hops);
      if (chain === "robinhood" && name === "v4TwoHop") {
        // ETH to USDG to WETH: WETH after the first token, refused (INFO-1)
        assert.equal(code(() => evmPoolRouteData(chain, route)), "weth_after_first");
        continue;
      }
      const { data, token } = evmPoolRouteData(chain, route);
      assert.equal(hex(data), r.data.toLowerCase(), `${chain}.${name}`);
      assert.equal(token, r.buys);
      n++;
    }
  }
  assert.equal(n, 7);
});

test("a hooked hop with hook data encodes as cast abi-encode does", () => {
  // cast abi-encode "f(address,(address,uint24,int24,address,bytes)[])" 0x0 "[(USDC,500,10,0xf00d…0044,0xdeadbeef)]"
  const want =
    "0x" +
    "0".repeat(64) +
    "40".padStart(64, "0") +
    "1".padStart(64, "0") +
    "20".padStart(64, "0") +
    "833589fcd6edb6e08f4c7c32d4f71b54bda02913".padStart(64, "0") +
    "1f4".padStart(64, "0") +
    "a".padStart(64, "0") +
    "f00d000000000000000000000000000000000044".padStart(64, "0") +
    "a0".padStart(64, "0") +
    "4".padStart(64, "0") +
    "deadbeef".padEnd(64, "0");
  const { data } = evmPoolRouteData("base", v4(ZERO, hop(USDC, { hooks: "0xf00d000000000000000000000000000000000044", hookData: "0xdeadbeef" })));
  assert.equal(hex(data), want);
});

test("INFO-1: WETH anywhere after the route's first token is refused", () => {
  const W = B.weth;
  assert.equal(code(() => evmPoolRouteData("base", v3([W, USDC, W]))), "weth_after_first");
  assert.equal(code(() => evmPoolRouteData("base", v4(ZERO, hop(W)))), "weth_after_first");
  assert.equal(code(() => evmPoolRouteData("base", v4(ZERO, hop(USDC), hop(W), hop(X)))), "weth_after_first");
  assert.equal(code(() => evmPoolRouteData("base", v4(W, hop(USDC), hop(W.toLowerCase())))), "weth_after_first");
  // WETH first is the one place it goes
  assert.equal(code(() => evmPoolRouteData("base", v4(W, hop(USDC), hop(X)))), "built");
});

test("INFO-2: a middle token not on the chain's venue list is refused", () => {
  assert.equal(code(() => evmPoolRouteData("base", v3([B.weth, X, Y]))), "middle_not_listed");
  assert.equal(code(() => evmPoolRouteData("base", v4(ZERO, hop(X), hop(Y)))), "middle_not_listed");
  // the native asset in the middle of a v4 route is not on the list either
  assert.equal(code(() => evmPoolRouteData("base", v4(B.weth, hop(USDC), hop(ZERO), hop(X)))), "middle_not_listed");
  // another chain's listed token is not listed here
  assert.equal(code(() => evmPoolRouteData("base", v4(ZERO, hop(USDG), hop(X)))), "middle_not_listed");
  assert.equal(code(() => evmPoolRouteData("robinhood", v4(ZERO, hop(USDG), hop(X)))), "built");
  // any token may be the one bought, listed or not
  assert.equal(code(() => evmPoolRouteData("base", v4(ZERO, hop(X)))), "built");
});

test("a route of the wrong shape is refused", () => {
  const bad = (chain: EvmPoolChain, r: EvmRoute) => assert.equal(code(() => evmPoolRouteData(chain, r)), "bad_route", JSON.stringify(r));
  bad("base", v4(ZERO));
  bad("base", v4(ZERO, ...Array.from({ length: EVM_POOL_MAX_HOPS + 1 }, () => hop(USDC)).slice(0, -1), hop(X)));
  assert.equal(code(() => evmPoolRouteData("base", v4(ZERO, ...Array.from({ length: EVM_POOL_MAX_HOPS - 1 }, () => hop(USDC)), hop(X)))), "built");
  bad("base", v3([USDC, X])); // a v3 route starts at WETH
  bad("base", v3([B.weth]));
  bad("base", v3([B.weth, X], [500, 500]));
  bad("base", v3([B.weth, X], [0x1000000]));
  bad("base", v4(USDC, hop(X))); // a v4 route starts at the native asset or WETH
  bad("base", v4(ZERO, hop(X, { fee: 0x1000000 })));
  bad("base", v4(ZERO, hop(X, { tickSpacing: 0 })));
  bad("base", v4(ZERO, hop(X, { tickSpacing: 32768 })));
  bad("base", v4(ZERO, hop(X, { tickSpacing: -10 })));
  bad("base", v4(ZERO, hop(X, { hookData: "0x" + "00".repeat(EVM_POOL_MAX_HOOK_DATA + 1) })));
  assert.equal(code(() => evmPoolRouteData("base", v4(ZERO, hop(X, { hookData: "0x" + "00".repeat(EVM_POOL_MAX_HOOK_DATA) })))), "built");
  bad("base", v4(ZERO, hop(X, { hookData: "0xabc" })));
  bad("base", v4(ZERO, hop("0x1234")));
  bad("base", v4(ZERO, hop(X, { hooks: "not an address" })));
  bad("base", v4(B.weth, hop(USDC), hop(ZERO))); // buys the native asset: no token
  bad("base", v4(ZERO, hop(USDC), hop(USDC))); // the last hop buys what it spends
  bad("ethereum" as EvmPoolChain, v4(ZERO, hop(X)));
  bad("base", { venue: "sushiswap" } as unknown as EvmRoute);
});

test("the buy takes minOut above 0 and an adapter address", () => {
  const r = v4(ZERO, hop(USDC));
  assert.equal(code(() => evmPoolBuild("base", "0x000000000000000000000000000000000000ada1", r, 0n)), "bad_amount");
  assert.equal(code(() => evmPoolBuild("base", "0x000000000000000000000000000000000000ada1", r, 1n << 256n)), "bad_amount");
  assert.equal(code(() => evmPoolBuild("base", ZERO, r, 1n)), "bad_route");
  const b = evmPoolBuild("base", "0x000000000000000000000000000000000000ada1", r, 5n);
  assert.deepEqual(b, { adapter: "0x000000000000000000000000000000000000ada1", data: ROUTES.base.v4OneHop.data.toLowerCase(), minOut: 5n, token: USDC });
});

// W: the Hardhat mnemonic's account 0 (m/44'/60'/0'/0/0), a published test key, as buy-proofs.json signs with it;
// BIP-39 seed and BIP-32 steps written out here, so no key sits in the tree
const N = secp256k1.Point.CURVE().n;
function hardhatAccount0(): Uint8Array {
  const seed = pbkdf2(sha512, new TextEncoder().encode("test test test test test test test test test test test junk"), new TextEncoder().encode("mnemonic"), { c: 2048, dkLen: 64 });
  let I = hmac(sha512, new TextEncoder().encode("Bitcoin seed"), seed);
  let k = BigInt(hex(I.slice(0, 32)));
  let c = I.slice(32);
  for (const [i, hard] of [[44, true], [60, true], [0, true], [0, false], [0, false]] as [number, boolean][]) {
    const kb = Buffer.from(k.toString(16).padStart(64, "0"), "hex");
    const head = hard ? Uint8Array.of(0, ...kb) : secp256k1.getPublicKey(kb, true);
    const idx = Buffer.alloc(4);
    idx.writeUInt32BE(hard ? i + 0x80000000 : i);
    I = hmac(sha512, c, Uint8Array.of(...head, ...idx));
    k = (BigInt(hex(I.slice(0, 32)))) + k;
    k %= N;
    c = I.slice(32);
  }
  return Buffer.from(k.toString(16).padStart(64, "0"), "hex");
}
const W_KEY = hardhatAccount0();
const W = PROOFS.local.buy.request.recipient as string;
const CHAIN = Number(PROOFS.local.chainId);
const ACCOUNT_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // the Hardhat mnemonic's account 1, not W

test("W's Buy signature equals the pool's own vector byte for byte, and binds what the pool checks", () => {
  const m = PROOFS.local.signed.message;
  const buy = { adapter: m.adapter, data: m.data, minOut: BigInt(m.minOut), token: m.token };
  const proof = { nullifier: BigInt(m.nullifier), context: BigInt(m.context), value: BigInt(m.value) };
  const digest = evmPoolBuyDigest(CHAIN, PROOFS.local.pool, buy, proof);
  const sig = evmPoolSignBuy(W_KEY, W, digest);
  assert.equal(sig.length, 65);
  assert.equal(hex(sig), PROOFS.local.signed.signature);
  // the vector's message is the buy proof's own nullifier, context and value (Buy.t.sol checks the same)
  assert.equal(m.context, PROOFS.local.buy.context);
  // each signed field moves the digest: chain, pool, adapter, data, minOut, token, nullifier, context, value
  const other = [
    evmPoolBuyDigest(8453, PROOFS.local.pool, buy, proof),
    evmPoolBuyDigest(CHAIN, "0x00000000000000000000000000000000b1f1f002", buy, proof),
    evmPoolBuyDigest(CHAIN, PROOFS.local.pool, { ...buy, adapter: "0x000000000000000000000000000000000000ada2" }, proof),
    evmPoolBuyDigest(CHAIN, PROOFS.local.pool, { ...buy, data: "0x726f757466" }, proof),
    evmPoolBuyDigest(CHAIN, PROOFS.local.pool, { ...buy, minOut: buy.minOut + 1n }, proof),
    evmPoolBuyDigest(CHAIN, PROOFS.local.pool, { ...buy, token: "0x0000000000000000000000000000000000070c1f" }, proof),
    evmPoolBuyDigest(CHAIN, PROOFS.local.pool, buy, { ...proof, nullifier: proof.nullifier + 1n }),
    evmPoolBuyDigest(CHAIN, PROOFS.local.pool, buy, { ...proof, context: proof.context + 1n }),
    evmPoolBuyDigest(CHAIN, PROOFS.local.pool, buy, { ...proof, value: proof.value + 1n }),
  ].map(hex);
  assert.equal(new Set([hex(digest), ...other]).size, 10);
});

test("W's signatures are 65 bytes, s low, v 27 or 28, and recover to W", () => {
  const half = N >> 1n;
  const vs = new Set<number>();
  for (let i = 0; i < 16; i++) {
    const d = keccak_256(Uint8Array.of(i));
    const sig = evmPoolSignBuy(W_KEY, W, d);
    const v = sig[64]!;
    assert.ok(v === 27 || v === 28);
    vs.add(v);
    assert.ok(BigInt(hex(sig.slice(32, 64))) <= half, "s in the lower half");
    const pub = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(v - 27).recoverPublicKey(d).toBytes(false);
    assert.equal(hex(keccak_256(pub.slice(1)).slice(12)), W.toLowerCase());
  }
  assert.deepEqual([...vs].sort(), [27, 28], "both v values seen");
});

test("only W's own key signs, and only for W", () => {
  const d = keccak_256(Uint8Array.of(1));
  assert.equal(code(() => evmPoolSignBuy(W_KEY, ACCOUNT_1, d)), "bad_key");
  assert.equal(code(() => evmPoolSignBuy(new Uint8Array(32), W, d)), "bad_key");
  assert.equal(code(() => evmPoolSignBuy(W_KEY.slice(0, 31), W, d)), "bad_key");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, W, d.slice(0, 31))), "bad_amount");
  const m = PROOFS.local.signed.message;
  const buy = { adapter: m.adapter, data: m.data, minOut: BigInt(m.minOut), token: m.token };
  const proof = { nullifier: BigInt(m.nullifier), context: BigInt(m.context), value: BigInt(m.value) };
  assert.equal(code(() => evmPoolBuyDigest(CHAIN, PROOFS.local.pool, buy, { ...proof, value: 0n })), "bad_amount");
  assert.equal(code(() => evmPoolBuyDigest(CHAIN, PROOFS.local.pool, { ...buy, minOut: 0n }, proof)), "bad_amount");
  assert.equal(code(() => evmPoolBuyDigest(CHAIN, PROOFS.local.pool, { ...buy, data: "0x7" }, proof)), "bad_route");
});
