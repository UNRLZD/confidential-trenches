// Hostile and edge tests for src/trade/evm/buy.ts, from the evm-pool-buy-tx review (merge note M366). P1: the
// hand-written abi.encode against cast abi-encode at edge sizes (evm-pool-buy-hostile.cast.json), and the bounds. F1-F5:
// the review's findings, each refused. R: the checks the review's mutants removed, one test each.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as kit from "../src/index.ts";
import { EVM_POOL_VENUES, EvmPoolBuyError, evmPoolBuild, evmPoolRouteData, evmPoolSignBuy, type EvmPoolChain, type EvmRoute, type EvmV4Hop } from "../src/index.ts";

const CAST = JSON.parse(readFileSync(new URL("./evm-pool-buy-hostile.cast.json", import.meta.url), "utf8"));
const PROOFS = JSON.parse(readFileSync(new URL("../../../contracts/pool-evm/test/fixtures/buy-proofs.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof EvmPoolBuyError ? e.code : `not-EvmPoolBuyError: ${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
  return "built";
};

const ZERO = "0x0000000000000000000000000000000000000000";
const B = EVM_POOL_VENUES.base;
const R = EVM_POOL_VENUES.robinhood;
const USDC = B.middles[0]!;
const USDG = R.middles[0]!;
const X = "0xF111111111111111111111111111111111111111";
const Z = "0x2222222222222222222222222222222222222222"; // the helper's token, not the user's
const EVIL = "0x3333333333333333333333333333333333333333";
const H = "0xF00d000000000000000000000000000000000044";
const ADAPTER = "0x000000000000000000000000000000000000ada1";
const POOL = PROOFS.local.pool as string;
const hop = (currency: string, o: Partial<EvmV4Hop> = {}): EvmV4Hop => ({ currency, fee: 500, tickSpacing: 10, hooks: ZERO, hookData: "0x", ...o });
const v4 = (currencyIn: string, ...hops: EvmV4Hop[]): EvmRoute => ({ venue: "uniswap-v4", currencyIn, hops });
const v3 = (tokens: string[], fees: number[] = tokens.slice(1).map(() => 500)): EvmRoute => ({ venue: "uniswap-v3", tokens, fees });
const D = CAST.hookDataHex;

// W: the Hardhat mnemonic's account 0 (published test vector), derived as evm-pool-buy.test.ts does
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
    k = (BigInt(hex(I.slice(0, 32))) + k) % N;
    c = I.slice(32);
  }
  return Buffer.from(k.toString(16).padStart(64, "0"), "hex");
}
const W_KEY = hardhatAccount0();
const m = PROOFS.local.signed.message;
const PROOF = { nullifier: BigInt(m.nullifier), context: BigInt(m.context), value: BigInt(m.value) };

// ------------------------------------------------------------------ P1: encoding against cast, and the bounds

test("P1 four hops, hook data 0, 1, 32 and 33 bytes, fee 0 and 0xffffff, tick spacing 1 and 32767: equals cast abi-encode", () => {
  const { data } = evmPoolRouteData(
    "base",
    v4(ZERO, hop(USDC, { hooks: H }), hop(USDC, { fee: 0xffffff, tickSpacing: 32767, hooks: H, hookData: D.d1 }), hop(USDC, { fee: 0, tickSpacing: 1, hooks: H, hookData: D.d32 }), hop(X, { fee: 3000, tickSpacing: 60, hooks: H, hookData: D.d33 })),
  );
  assert.equal(hex(data), CAST.fourHops_0_1_32_33);
});

test("P1 one hop from WETH with 1,024 bytes of hook data: equals cast", () => {
  const { data } = evmPoolRouteData("base", v4(B.weth, hop(X, { fee: 100, tickSpacing: 1, hooks: H, hookData: D.d1024 })));
  assert.equal(hex(data), CAST.oneHop_1024);
});

test("P1 31 and 64 bytes, the dynamic-fee flag and a 100% fee: equals cast", () => {
  const { data } = evmPoolRouteData("base", v4(ZERO, hop(USDC, { fee: 0x800000, tickSpacing: 200, hooks: H, hookData: D.d31 }), hop(X, { fee: 1_000_000, tickSpacing: 32767, hookData: D.d64 })));
  assert.equal(hex(data), CAST.twoHop_31_64);
});

test("P1 four hops of 1,024 bytes each (the largest route the builder takes): equals cast", () => {
  const { data } = evmPoolRouteData("base", v4(ZERO, hop(USDC, { hooks: H, hookData: D.d1024 }), hop(USDC, { hooks: H, hookData: D.d1024 }), hop(USDC, { hooks: H, hookData: D.d1024 }), hop(X, { hooks: H, hookData: D.d1024 })));
  assert.equal(hex(data), CAST.fourHops_1024_each);
});

test("P1 a v3 path of four hops with fees 0xffffff, 0, 500, 10000: equals cast concat-hex", () => {
  const { data } = evmPoolRouteData("base", v3([B.weth, USDC, USDC, USDC, X], [0xffffff, 0, 500, 10000]));
  assert.equal(hex(data), CAST.v3_fourHops_maxfee.toLowerCase());
});

test("P1 bounds: fee, tick spacing, hook data, hops; non-integers and negatives refused", () => {
  const c = (r: EvmRoute) => code(() => evmPoolRouteData("base", r));
  assert.equal(c(v4(ZERO, hop(X, { fee: -1 }))), "bad_route");
  assert.equal(c(v4(ZERO, hop(X, { fee: 1.5 }))), "bad_route");
  assert.equal(c(v4(ZERO, hop(X, { fee: "500" as unknown as number }))), "bad_route");
  assert.equal(c(v4(ZERO, hop(X, { tickSpacing: 1.5 }))), "bad_route");
  assert.equal(c(v4(ZERO, hop(X, { tickSpacing: 32768 }))), "bad_route");
  assert.equal(c(v4(ZERO, hop(X, { hookData: "0x" + "00".repeat(1025) }))), "bad_route");
  assert.equal(c(v4(ZERO, hop(X, { hookData: "deadbeef" }))), "bad_route");
  assert.equal(c(v4(ZERO, hop(X, { hookData: 7 as unknown as string }))), "bad_route");
  assert.equal(c(v4(ZERO, hop(X, { hookData: "0xzz" }))), "bad_route");
  assert.equal(c(v3([B.weth, X], [-1])), "bad_route");
  assert.equal(c(v3([B.weth, X], [1.5])), "bad_route");
  assert.equal(c(v3([B.weth, USDC, USDC, USDC, USDC, X], [500, 500, 500, 500, 500])), "bad_route");
  assert.equal(c(v4(ZERO, hop(USDC), hop(USDC), hop(USDC), hop(USDC), hop(X))), "bad_route");
  assert.equal(c({ venue: "uniswap-v3", tokens: "0x42" as unknown as string[], fees: [500] }), "bad_route");
  assert.equal(c({ venue: "uniswap-v4", currencyIn: ZERO, hops: {} as unknown as EvmV4Hop[] }), "bad_route");
});

// ------------------------------------------------------------------ F: the review's findings, refused

test("F1 a helper's route that buys another token than the user picked is refused before W signs", () => {
  const want = X; // the token the user picked on the screen
  const route = v4(ZERO, hop(USDC), hop(Z)); // the helper's route: ends at Z, the helper's own token and pool
  assert.equal(code(() => evmPoolBuild("base", ADAPTER, route, 1n, want)), "token_mismatch");
  assert.equal(code(() => evmPoolBuild("base", ADAPTER, v3([B.weth, USDC, Z]), 1n, want)), "token_mismatch");
  assert.equal(code(() => evmPoolBuild("base", ADAPTER, v4(ZERO, hop(USDC), hop(X)), 1n, want)), "built");
});

test("F2 no input of W's signer takes a digest: an EIP-7702 delegation of W to the helper's code is refused in every slot", () => {
  // EIP-7702 authorization digest: keccak256(0x05 || rlp([chainId 8453, delegate, nonce 0])); on ee348ad the old
  // signer signed it, byte for byte cast wallet sign-auth's signature for W
  const auth = keccak_256(Buffer.from("05" + "d9" + "822105" + "94" + "000000000000000000000000000000000000bad1" + "80", "hex"));
  const built = evmPoolBuild("base", ADAPTER, v4(ZERO, hop(X)), 1n, X);
  const any = auth as unknown as never;
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, any, PROOF)), "not_built");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, any, POOL, built, PROOF)), "not_built");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", any, built, PROOF)), "bad_route");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, built, any)), "bad_amount");
  // the kit's public entry exports no digest maker and no signer but the one
  assert.equal("evmPoolBuyDigest" in kit, false);
  assert.deepEqual(Object.keys(kit).filter((k) => /^evmPool/.test(k)).sort(), ["evmPoolBuild", "evmPoolRouteData", "evmPoolSignBuy"]);
});

test("F2b W signs only the buy object the builder returned: a copy, an edit or a hand-made buy is refused", () => {
  const built = evmPoolBuild("base", ADAPTER, v4(ZERO, hop(USDC), hop(X)), 1n, X);
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, { ...built, token: Z }, PROOF)), "not_built");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, { ...built, data: "0x726f757465" }, PROOF)), "not_built");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, { ...built }, PROOF)), "not_built");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, { chain: "base", adapter: ADAPTER, data: built.data, minOut: 1n, token: X }, PROOF)), "not_built");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, Object.create(built), PROOF)), "not_built");
  assert.throws(() => ((built as { token: string }).token = Z), TypeError);
  assert.equal(built.token, X);
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, built, PROOF)), "built");
});

test("F3 a buy checked for one chain is not signed for another (Robinhood's route, Base's chain)", () => {
  assert.equal(code(() => evmPoolBuild("base", ADAPTER, v4(ZERO, hop(USDG), hop(X)), 1n, X)), "middle_not_listed");
  const built = evmPoolBuild("robinhood", ADAPTER, v4(ZERO, hop(USDG), hop(X)), 1n, X);
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, built, PROOF)), "not_built");
  assert.equal(code(() => evmPoolSignBuy(W_KEY, "robinhood", POOL, built, PROOF)), "built");
});

test("F4 the route is read once: a getter cannot show the checks one middle token and the encoder another", () => {
  let reads = 0;
  const route = {
    venue: "uniswap-v3",
    fees: [500, 500],
    get tokens() {
      return reads++ === 0 ? [B.weth, USDC, X] : [B.weth, EVIL, X];
    },
  } as unknown as EvmRoute;
  const { data } = evmPoolRouteData("base", route);
  assert.equal(reads, 1);
  assert.equal(hex(data.slice(23, 43)), USDC.toLowerCase());
  // a hop's fields too: each read once
  let hopReads = 0;
  const h = { fee: 500, tickSpacing: 10, hooks: ZERO, hookData: "0x", get currency() { return hopReads++ === 0 ? USDC : EVIL; } };
  const built = evmPoolBuild("base", ADAPTER, v4(ZERO, h as EvmV4Hop, hop(X)), 1n, X);
  assert.equal(hopReads, 1);
  assert.equal(built.data, evmPoolBuild("base", ADAPTER, v4(ZERO, hop(USDC), hop(X)), 1n, X).data);
});

test("F4b the proof's values are read once: a getter cannot show the checks one value and the digest another", () => {
  const built = evmPoolBuild("base", ADAPTER, v4(ZERO, hop(X)), 1n, X);
  let reads = 0;
  const proof = { nullifier: PROOF.nullifier, context: PROOF.context, get value() { return reads++ === 0 ? 1n : 2n; } };
  const sig = evmPoolSignBuy(W_KEY, "base", POOL, built, proof);
  assert.equal(reads, 1);
  assert.equal(hex(sig), hex(evmPoolSignBuy(W_KEY, "base", POOL, built, { ...PROOF, value: 1n })));
});

test("F5 a null or non-object hop or route is refused with the builder's own error, never a TypeError", () => {
  const c = (r: unknown) => code(() => evmPoolRouteData("base", r as EvmRoute));
  assert.equal(c({ venue: "uniswap-v4", currencyIn: ZERO, hops: [null] }), "bad_route");
  assert.equal(c({ venue: "uniswap-v4", currencyIn: ZERO, hops: [7] }), "bad_route");
  assert.equal(c({ venue: "uniswap-v4", currencyIn: ZERO, hops: [hop(USDC), undefined] }), "bad_route");
  assert.equal(c(null), "bad_route");
  assert.equal(c("uniswap-v4"), "bad_route");
  assert.equal(c(undefined), "bad_route");
});

// ------------------------------------------------------------------ R: one test per check the review's mutants removed

test("R1 a v3 token that is not an address is refused", () => {
  assert.equal(code(() => evmPoolRouteData("base", v3([B.weth, USDC, "0xnot an address"]))), "bad_route");
  assert.equal(code(() => evmPoolRouteData("base", v3([B.weth, USDC, 7 as unknown as string]))), "bad_route");
});

test("R2 an adapter that is not an address is refused", () => {
  const r = v4(ZERO, hop(X));
  assert.equal(code(() => evmPoolBuild("base", "0xada1", r, 1n, X)), "bad_route");
  assert.equal(code(() => evmPoolBuild("base", ADAPTER + "00", r, 1n, X)), "bad_route");
  assert.equal(code(() => evmPoolBuild("base", 7 as unknown as string, r, 1n, X)), "bad_route");
});

test("R3 a pool that is not an address is refused", () => {
  const built = evmPoolBuild("base", ADAPTER, v4(ZERO, hop(X)), 1n, X);
  for (const p of ["0xb1f1f001", POOL + "00", "pool", ZERO]) assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", p, built, PROOF)), "bad_route", p);
});

test("R4 a proof value at or over the field's prime is refused", () => {
  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const built = evmPoolBuild("base", ADAPTER, v4(ZERO, hop(X)), 1n, X);
  for (const k of ["nullifier", "context", "value"] as const) {
    assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, built, { ...PROOF, [k]: P })), "bad_amount", k);
    assert.equal(code(() => evmPoolSignBuy(W_KEY, "base", POOL, built, { ...PROOF, [k]: P - 1n })), "built", k);
  }
});

test("R5 an address with trailing characters is not an address", () => {
  assert.equal(code(() => evmPoolRouteData("base", v4(ZERO, hop(X + "00")))), "bad_route");
  assert.equal(code(() => evmPoolRouteData("base", v4(ZERO, hop(X, { hooks: H + "ff" })))), "bad_route");
  assert.equal(code(() => evmPoolBuild("base", ADAPTER, v4(ZERO, hop(X)), 1n, X + "\n")), "bad_route");
});

test("R7 a chain not on the venue list is refused, inherited names included", () => {
  for (const ch of ["ethereum", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(code(() => evmPoolRouteData(ch as EvmPoolChain, v4(ZERO, hop(X)))), "bad_route", ch);
    assert.equal(code(() => evmPoolBuild(ch as EvmPoolChain, ADAPTER, v4(ZERO, hop(X)), 1n, X)), "bad_route", ch);
  }
});

test("R8 a list is an array, bounded before it is copied", () => {
  const like = { length: 1, 0: hop(X) } as unknown as EvmV4Hop[];
  assert.equal(code(() => evmPoolRouteData("base", { venue: "uniswap-v4", currencyIn: ZERO, hops: like })), "bad_route");
  let reads = 0;
  const huge = new Proxy(new Array(1_000_000), {
    get(t, k, r) {
      if (typeof k === "string" && /^\d+$/.test(k)) reads++;
      return Reflect.get(t, k, r);
    },
  });
  assert.equal(code(() => evmPoolRouteData("base", { venue: "uniswap-v4", currencyIn: ZERO, hops: huge })), "bad_route");
  assert.equal(reads, 0, "no item of an over-long list is read");
});
