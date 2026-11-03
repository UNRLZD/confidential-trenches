// The device's EVM pool buy (src/trade/evm/buy.ts, card evm-pool-buy-tx) against the pool's own fixtures:
// contracts/pool-evm/test/fixtures/kit-routes.json (the fork tests' routes, which BuyFork.t.sol and BuyV4Fork.t.sol
// check against their own), buy-proofs.json (W's EIP-712 Buy signed by cast, which Buy.t.sol checks the pool takes)
// and evm-pool-buy-own-vectors.json (built buys on Base and Robinhood signed by cast, from the evm-pool-buy-tx review).
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
  evmPoolRouteData,
  evmPoolSignBuy,
  type EvmPoolChain,
  type EvmRoute,
  type EvmV4Hop,
} from "../src/index.ts";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../../contracts/pool-evm/test/fixtures/${f}`, import.meta.url), "utf8"));
const ROUTES = fixture("kit-routes.json");
const PROOFS = fixture("buy-proofs.json");
const OWN = JSON.parse(readFileSync(new URL("./evm-pool-buy-own-vectors.json", import.meta.url), "utf8"));
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
  bad("base", v3([B.weth, ...Array.from({ length: EVM_POOL_MAX_HOPS }, () => USDC), X]));
  assert.equal(code(() => evmPoolRouteData("base", v3([B.weth, ...Array.from({ length: EVM_POOL_MAX_HOPS - 1 }, () => USDC), X]))), "built");
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

const A1 = "0x000000000000000000000000000000000000ada1";

test("the buy takes minOut above 0, an adapter address and the user's token", () => {
  const r = v4(ZERO, hop(USDC));
  assert.equal(code(() => evmPoolBuild("base", A1, r, 0n, USDC)), "bad_amount");
  assert.equal(code(() => evmPoolBuild("base", A1, r, 1n << 256n, USDC)), "bad_amount");
  assert.equal(code(() => evmPoolBuild("base", ZERO, r, 1n, USDC)), "bad_route");
  assert.equal(code(() => evmPoolBuild("base", A1, r, 1n, ZERO)), "bad_route");
  assert.equal(code(() => evmPoolBuild("base", A1, r, 1n, "0x1234")), "bad_route");
  assert.equal(code(() => evmPoolBuild("base", A1, r, 1n, X)), "token_mismatch");
  const b = evmPoolBuild("base", A1, r, 5n, USDC.toLowerCase());
  assert.deepEqual({ ...b }, { chain: "base", adapter: A1, data: ROUTES.base.v4OneHop.data.toLowerCase(), minOut: 5n, token: USDC.toLowerCase() });
  assert.ok(Object.isFrozen(b));
});

// W: the Hardhat mnemonic's account 0 (m/44'/60'/0'/0/0), a published test key, as buy-proofs.json and cast sign with
// it; BIP-39 seed and BIP-32 steps written out here, so no key sits in the tree
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
const POOL = PROOFS.local.pool as string;
const m = PROOFS.local.signed.message;
const PROOF = { nullifier: BigInt(m.nullifier), context: BigInt(m.context), value: BigInt(m.value) };

// The test's own EIP-712 Buy digest, written apart from the kit: it is what the pool's vector (buy-proofs.json, which
// Buy.t.sol checks the pool takes) recovers to W over, so the kit's signatures are checked against the pool's digest
const utf8 = (s: string) => new TextEncoder().encode(s);
const w256 = (v: bigint | number | string) => Buffer.from(BigInt(v).toString(16).padStart(64, "0"), "hex");
function poolDigest(chainId: number, pool: string, adapter: string, data: string, minOut: bigint | string, token: string, n: bigint | string, c: bigint | string, v: bigint | string) {
  const domain = keccak_256(Buffer.concat([keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak_256(utf8("Blindfill")), keccak_256(utf8("1")), w256(chainId), w256(pool)]));
  const type = keccak_256(utf8("Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)"));
  const struct = keccak_256(Buffer.concat([type, w256(adapter), keccak_256(Buffer.from(data.slice(2), "hex")), w256(minOut), w256(token), w256(n), w256(c), w256(v)]));
  return keccak_256(Buffer.concat([Uint8Array.of(0x19, 0x01), domain, struct]));
}
const recovers = (sig: Uint8Array, d: Uint8Array) =>
  hex(keccak_256(secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(sig[64]! - 27).recoverPublicKey(d).toBytes(false).slice(1)).slice(12));

test("W's Buy signature equals cast's EIP-712 signature byte for byte, on Base and Robinhood", () => {
  // the pool's own vector recovers to W over the test's digest (so poolDigest is the pool's)
  const ps = Buffer.from(PROOFS.local.signed.signature.slice(2), "hex");
  assert.equal(recovers(ps, poolDigest(Number(PROOFS.local.chainId), POOL, m.adapter, m.data, m.minOut, m.token, m.nullifier, m.context, m.value)), W.toLowerCase());
  // evm-pool-buy-own-vectors.json: built buys cast signed (cast wallet sign --data, the typed data Buy under
  // {Blindfill, 1, chainId, pool} with `buys` as the token field, the Hardhat mnemonic's index 0)
  for (const [name, t] of Object.entries(OWN) as [string, any][]) {
    const r = ROUTES[t.chain][t.route];
    const route: EvmRoute = r.venue === "uniswap-v3" ? v3(r.tokens, r.fees) : v4(r.currencyIn, ...r.hops);
    const built = evmPoolBuild(t.chain, t.adapter, route, BigInt(t.minOut), t.buys);
    assert.equal(built.data, t.data.toLowerCase(), name);
    assert.equal(EVM_POOL_VENUES[t.chain as EvmPoolChain].chainId, t.chainId, name);
    const proof = { nullifier: BigInt(t.nullifier), context: BigInt(t.context), value: BigInt(t.value) };
    assert.equal(hex(evmPoolSignBuy(W_KEY, t.chain, t.pool, built, proof)), t.signature, name);
  }
});

test("W's signatures bind each field the pool checks: chain, pool, adapter, data, minOut, token, nullifier, context, value", () => {
  const sign = (chain: EvmPoolChain, pool: string, adapter: string, route: EvmRoute, minOut: bigint, token: string, proof = PROOF) =>
    hex(evmPoolSignBuy(W_KEY, chain, pool, evmPoolBuild(chain, adapter, route, minOut, token), proof));
  const r = v4(ZERO, hop(X));
  const sigs = [
    sign("base", POOL, A1, r, 5n, X),
    sign("robinhood", POOL, A1, r, 5n, X),
    sign("base", "0x00000000000000000000000000000000b1f1f002", A1, r, 5n, X),
    sign("base", POOL, "0x000000000000000000000000000000000000ada2", r, 5n, X),
    sign("base", POOL, A1, v4(ZERO, hop(X, { fee: 3000 })), 5n, X),
    sign("base", POOL, A1, r, 6n, X),
    sign("base", POOL, A1, v4(ZERO, hop(Y)), 5n, Y),
    sign("base", POOL, A1, r, 5n, X, { ...PROOF, nullifier: PROOF.nullifier + 1n }),
    sign("base", POOL, A1, r, 5n, X, { ...PROOF, context: PROOF.context + 1n }),
    sign("base", POOL, A1, r, 5n, X, { ...PROOF, value: PROOF.value + 1n }),
  ];
  assert.equal(new Set(sigs).size, 10);
});

test("W's signatures are 65 bytes, s low, v 27 or 28, and recover to W over the pool's digest", () => {
  const half = N >> 1n;
  const vs = new Set<number>();
  const built = evmPoolBuild("base", A1, v4(ZERO, hop(USDC), hop(X)), 5n, X);
  for (let i = 0; i < 64; i++) {
    const proof = { ...PROOF, nullifier: BigInt(i) };
    const sig = evmPoolSignBuy(W_KEY, "base", POOL, built, proof);
    assert.equal(sig.length, 65);
    const v = sig[64]!;
    assert.ok(v === 27 || v === 28);
    vs.add(v);
    assert.ok(BigInt(hex(sig.slice(32, 64))) <= half, "s in the lower half");
    const d = poolDigest(8453, POOL, A1, built.data, 5n, X, proof.nullifier, proof.context, proof.value);
    assert.equal(recovers(sig, d), W.toLowerCase());
  }
  assert.deepEqual([...vs].sort(), [27, 28], "both v values seen");
});

test("only a 32-byte key signs, and only proof values in the field with value above 0", () => {
  const built = evmPoolBuild("base", A1, v4(ZERO, hop(X)), 5n, X);
  assert.equal(code(() => evmPoolSignBuy(new Uint8Array(32), "base", POOL, built, PROOF)), "bad_key");
  assert.equal(code(() => evmPoolSignBuy(W_KEY.slice(0, 31), "base", POOL, built, PROOF)), "bad_key");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, built, { ...PROOF, value: 0n })), "bad_amount");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, built, { ...PROOF, nullifier: -1n })), "bad_amount");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, built, { ...PROOF, context: 5 as unknown as bigint })), "bad_amount");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, built, null as unknown as typeof PROOF)), "bad_amount");
});
