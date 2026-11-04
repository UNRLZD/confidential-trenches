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
import { evmPoolVenues, EvmPoolBuyError, evmPoolRouteData, type EvmPoolChain, type EvmPoolVenue, type EvmRoute, type EvmV4Hop } from "../src/index.ts";
// the checks through the unpinned builder and signer; the pinned ones (M370) at the end, with a pinned list of the test's
import { evmPoolBuildUnpinned as evmPoolBuild, evmPoolSignBuyUnpinned as evmPoolSignBuy, pinnedBuild, pinnedBuildQuoted, pinnedSignBuy } from "../src/trade/evm/buy-unpinned.ts";
import * as builder from "../src/trade/evm/buy-unpinned.ts";

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
const B = evmPoolVenues().base;
const R = evmPoolVenues().robinhood;
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
  // evmPoolGas (trade/evm/pool-fee.ts) takes only a tree depth and gives the gas of one release: no key and no digest;
  // evmPoolBuyQuote (checks/evm/quote.ts) reads quotes and evmPoolBuildQuoted builds from one: no key and no digest;
  // evmPoolSellQuote reads a sell's quotes and evmPoolBuildSell builds from one (card evm-sell-device-quote): no key and
  // no digest; no builder takes its caller's minOut (the review of cefe7a0)
  assert.deepEqual(Object.keys(kit).filter((k) => /^evmPool/.test(k)).sort(), ["evmPoolBuildQuoted", "evmPoolBuildSell", "evmPoolBuyQuote", "evmPoolGas", "evmPoolRouteData", "evmPoolSellQuote", "evmPoolSignBuy", "evmPoolSignSell", "evmPoolSignSellAuthorization", "evmPoolSignSimSell", "evmPoolVenues"]);
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

test("V1 the venue list is frozen all the way down: every write throws, and the builder and the signer read what they did", () => {
  const v = evmPoolVenues() as unknown as Record<string, { chainId: number; weth: string; middles: string[] }>;
  assert.equal(v, evmPoolVenues() as unknown);
  const built = evmPoolBuild("base", ADAPTER, v4(ZERO, hop(USDC), hop(X)), 1n, X);
  const before = hex(evmPoolSignBuy(W_KEY, "base", POOL, built, PROOF));
  assert.throws(() => void (v.base = { chainId: 4663, weth: X, middles: [Z] }), TypeError);
  assert.throws(() => void (v.ethereum = v.base!), TypeError);
  assert.throws(() => void (v.base!.chainId = 4663), TypeError);
  assert.throws(() => void (v.base!.weth = X), TypeError);
  assert.throws(() => void v.base!.middles.push(Z), TypeError);
  assert.throws(() => void (v.base!.middles[0] = Z), TypeError);
  assert.throws(() => void (v.robinhood!.chainId = 8453), TypeError);
  assert.throws(() => void (v.robinhood!.weth = X), TypeError);
  assert.throws(() => void (v.robinhood!.middles[0] = Z), TypeError);
  assert.equal(code(() => evmPoolBuild("base", ADAPTER, v4(ZERO, hop(Z), hop(X)), 1n, X)), "middle_not_listed");
  assert.equal(code(() => evmPoolBuild("ethereum" as EvmPoolChain, ADAPTER, v4(ZERO, hop(X)), 1n, X)), "bad_route");
  assert.equal(hex(evmPoolSignBuy(W_KEY, "base", POOL, built, PROOF)), before);
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

// ------------------------------------------------------------------ M370: the pinned adapters and pool

const A_V3 = "0x000000000000000000000000000000000000ad03";
const A_V4 = "0x000000000000000000000000000000000000ad04";
const pin = (v: EvmPoolVenue, o: Partial<EvmPoolVenue>): EvmPoolVenue => Object.freeze({ ...v, ...o });
const PINNED = Object.freeze({
  base: pin(B, { pool: POOL, adapters: Object.freeze({ v3: A_V3, v4: A_V4 }) }),
  robinhood: pin(R, { pool: POOL, adapters: Object.freeze({ v3: A_V3 }) }),
});

test("M370 today no pool or adapter is pinned: the pinned builder and signer the kit's refuse not_deployed", () => {
  for (const chain of ["base", "robinhood"] as EvmPoolChain[]) {
    const v = evmPoolVenues()[chain];
    assert.equal(v.pool, undefined);
    assert.equal(v.adapters, undefined);
    assert.equal(code(() => pinnedBuild(evmPoolVenues(), chain, ADAPTER, v4(ZERO, hop(X)), 1n, X)), "not_deployed", chain);
    assert.equal(code(() => pinnedBuild(evmPoolVenues(), chain, ADAPTER, v3([v.weth, X]), 1n, X)), "not_deployed", chain);
    const built = evmPoolBuild(chain, ADAPTER, v4(ZERO, hop(X)), 1n, X);
    assert.equal(code(() => pinnedSignBuy(evmPoolVenues(), W_KEY, chain, POOL, built, PROOF)), "not_deployed", chain);
    // the kit's signer takes only a buy evmPoolBuildQuoted returned
    assert.equal(code(() => kit.evmPoolSignBuy(W_KEY, chain, POOL, built, PROOF)), "not_built", chain);
  }
});

test("M370 a pinned build takes only the chain's adapter for the route's venue", () => {
  assert.equal(code(() => pinnedBuild(PINNED, "base", ADAPTER, v4(ZERO, hop(X)), 1n, X)), "not_pinned");
  assert.equal(code(() => pinnedBuild(PINNED, "base", A_V3, v4(ZERO, hop(X)), 1n, X)), "not_pinned"); // v3's adapter, a v4 route
  assert.equal(code(() => pinnedBuild(PINNED, "base", A_V4, v3([B.weth, X]), 1n, X)), "not_pinned");
  assert.equal(code(() => pinnedBuild(PINNED, "robinhood", A_V4, v4(ZERO, hop(X)), 1n, X)), "not_deployed"); // no v4 pin
  assert.equal(code(() => pinnedBuild(PINNED, "ethereum" as EvmPoolChain, A_V4, v4(ZERO, hop(X)), 1n, X)), "bad_route");
  assert.equal(code(() => pinnedBuild(PINNED, "base", A_V4.toUpperCase().replace("0X", "0x"), v4(ZERO, hop(X)), 1n, X)), "built");
  assert.equal(code(() => pinnedBuild(PINNED, "base", A_V3, v3([B.weth, X]), 1n, X)), "built");
  assert.equal(code(() => pinnedBuild(PINNED, "robinhood", A_V3, v3([R.weth, X]), 1n, X)), "built");
  // the route is read once here too
  let reads = 0;
  const route = { get venue() { return reads++ === 0 ? "uniswap-v4" : "uniswap-v3"; }, currencyIn: ZERO, hops: [hop(X)] } as unknown as EvmRoute;
  assert.equal(code(() => pinnedBuild(PINNED, "base", A_V4, route, 1n, X)), "built");
  assert.equal(reads, 1);
});

test("Q1 the quoted pinned build takes a v4 route through a middle that is not listed; the plain one and any v3 route do not", () => {
  // the route evmPoolBuildQuoted builds from a device quote (checks/evm/quote.ts): its middles need not be listed
  const route = v4(ZERO, hop(Z), hop(X));
  const built = pinnedBuildQuoted(PINNED, "base", A_V4, route, 1n, X);
  assert.equal(built.data, evmPoolBuild("base", A_V4, route, 1n, X, true).data);
  assert.equal(code(() => pinnedBuild(PINNED, "base", A_V4, route, 1n, X)), "middle_not_listed");
  assert.equal(code(() => pinnedBuildQuoted(PINNED, "base", A_V3, v3([B.weth, Z, X]), 1n, X)), "middle_not_listed");
  // the pins still hold
  assert.equal(code(() => pinnedBuildQuoted(PINNED, "base", ADAPTER, route, 1n, X)), "not_pinned");
});

test("HD2 the quoted pinned build takes no hook data: a hop that carries any is refused, as a sell's (card evm-buy-hookdata-fee)", () => {
  const hooked = "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"; // Base's pinned Clanker hook, in its own shape
  for (const r of [v4(B.weth, hop(X, { fee: 0x800000, tickSpacing: 200, hooks: hooked, hookData: "0xdeadbeef" })), v4(ZERO, hop(X, { hookData: "0x00" })), v4(ZERO, hop(Z), hop(X, { hookData: "0x" + "ab".repeat(32) }))]) {
    assert.equal(code(() => pinnedBuildQuoted(PINNED, "base", A_V4, r, 1n, X)), "bad_route");
    assert.equal(code(() => builder.evmPoolRouteDataQuoted("base", r)), "bad_route");
  }
  // the same route with the device's own hook data, none, builds
  assert.equal(code(() => pinnedBuildQuoted(PINNED, "base", A_V4, v4(B.weth, hop(X, { fee: 0x800000, tickSpacing: 200, hooks: hooked })), 1n, X)), "built");
});

test("M370 a pinned signature goes only to the chain's pool, of a buy through a pinned adapter", () => {
  const built = pinnedBuild(PINNED, "base", A_V4, v4(ZERO, hop(X)), 1n, X);
  assert.equal(code(() => pinnedSignBuy(PINNED, W_KEY, "base", "0x00000000000000000000000000000000b1f1f002", built, PROOF)), "not_pinned");
  const unpinned = evmPoolBuild("base", ADAPTER, v4(ZERO, hop(X)), 1n, X);
  assert.equal(code(() => pinnedSignBuy(PINNED, W_KEY, "base", POOL, unpinned, PROOF)), "not_pinned");
  assert.equal(code(() => pinnedSignBuy(PINNED, W_KEY, "base", POOL, { ...built }, PROOF)), "not_built");
  const noPool = Object.freeze({ ...PINNED, base: pin(B, { adapters: PINNED.base.adapters! }) });
  assert.equal(code(() => pinnedSignBuy(noPool, W_KEY, "base", POOL, built, PROOF)), "not_deployed");
  const noAdapters = Object.freeze({ ...PINNED, base: pin(B, { pool: POOL }) });
  assert.equal(code(() => pinnedSignBuy(noAdapters, W_KEY, "base", POOL, built, PROOF)), "not_pinned");
  assert.equal(hex(pinnedSignBuy(PINNED, W_KEY, "base", POOL.toLowerCase(), built, PROOF)), hex(evmPoolSignBuy(W_KEY, "base", POOL, built, PROOF)));
  const v3built = pinnedBuild(PINNED, "base", A_V3, v3([B.weth, X]), 1n, X);
  assert.equal(code(() => pinnedSignBuy(PINNED, W_KEY, "base", POOL, v3built, PROOF)), "built");
});

// ------------------------------------------------------------------ the review of 8d8675d: a polluted Object.prototype

const BAD_PIN = "0xBADBADBADBADBADBADBADBADBADBADBADBADBAD2";
function polluted(f: () => void): void {
  const P = Object.prototype as Record<string, unknown>;
  const fill: Record<string, unknown> = { pool: BAD_PIN, sellDelegate: BAD_PIN, adapters: { v3: BAD_PIN, v4: BAD_PIN }, v3: BAD_PIN, v4: BAD_PIN };
  try {
    for (const k of Object.keys(fill)) P[k] = fill[k];
    f();
  } finally {
    for (const k of Object.keys(fill)) delete P[k];
  }
}

test("M370 a polluted Object.prototype names no adapter and no pool: every buy builder and signer still refuses not_deployed", () => {
  assert.equal(Object.getPrototypeOf(evmPoolVenues()), null, "the venue list has no prototype");
  for (const chain of ["base", "robinhood"] as EvmPoolChain[]) assert.equal(Object.getPrototypeOf(evmPoolVenues()[chain]), null, chain);
  const noPins = Object.freeze({ base: pin(B, {}), robinhood: pin(R, {}) }); // an ordinary list
  const noV4 = Object.freeze({ ...PINNED, robinhood: pin(R, { pool: POOL, adapters: { v3: A_V3 } }) }); // ordinary adapters
  polluted(() => {
    for (const chain of ["base", "robinhood"] as EvmPoolChain[]) {
      const v = evmPoolVenues()[chain];
      assert.equal(code(() => pinnedBuild(evmPoolVenues(), chain, BAD_PIN, v4(ZERO, hop(X)), 1n, X)), "not_deployed", chain);
      assert.equal(code(() => pinnedBuild(evmPoolVenues(), chain, BAD_PIN, v3([v.weth, X]), 1n, X)), "not_deployed", chain);
      const built = evmPoolBuild(chain, BAD_PIN, v4(ZERO, hop(X)), 1n, X);
      assert.equal(code(() => pinnedSignBuy(evmPoolVenues(), W_KEY, chain, BAD_PIN, built, PROOF)), "not_deployed", chain);
      assert.equal(code(() => pinnedBuild(noPins, chain, BAD_PIN, v4(ZERO, hop(X)), 1n, X)), "not_deployed", chain);
      assert.equal(code(() => pinnedBuild(noPins, chain, BAD_PIN, v3([v.weth, X]), 1n, X)), "not_deployed", chain);
      assert.equal(code(() => pinnedSignBuy(noPins, W_KEY, chain, BAD_PIN, built, PROOF)), "not_deployed", chain);
    }
    // filled pins: Robinhood has no v4 adapter (M365), and a polluted v4 does not give it one; nor v3 a chain without it
    assert.equal(code(() => pinnedBuild(noV4, "robinhood", BAD_PIN, v4(ZERO, hop(X)), 1n, X)), "not_deployed");
    const noV3 = Object.freeze({ ...PINNED, base: pin(B, { pool: POOL, adapters: { v4: A_V4 } }) });
    assert.equal(code(() => pinnedBuild(noV3, "base", BAD_PIN, v3([B.weth, X]), 1n, X)), "not_deployed");
    const v3built = pinnedBuild(noV4, "robinhood", A_V3, v3([R.weth, X]), 1n, X);
    assert.equal(code(() => pinnedSignBuy(noV4, W_KEY, "robinhood", POOL, v3built, PROOF)), "built");
    assert.equal(code(() => pinnedSignBuy(noV4, W_KEY, "robinhood", POOL, evmPoolBuild("robinhood", BAD_PIN, v4(ZERO, hop(X)), 1n, X), PROOF)), "not_pinned");
  });
  assert.equal(({} as Record<string, unknown>).v4, undefined, "the prototype is emptied again");
});
