// W's EVM sell (src/trade/evm/sell.ts, card evm-pool-sell-tx) against cast: evm-pool-sell.cast.json holds, per case,
// `cast calldata "exactInput((bytes,address,uint256,uint256))"` for the swap, `cast wallet sign --data` of the Sell
// typed data under {Blindfill, 1, chainId, verifyingContract W} and `cast wallet sign-auth <delegate> --chain <id>
// --nonce <n>`, each with the Hardhat mnemonic's index 0 (`sells` is the Sell's token field), and sign-auth at RLP's
// nonce edges. A refusal test per check.
import { mock, test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as kit from "../src/index.ts";
import { EVM_POOL_SELL_DEADLINE_MAX_S, EVM_POOL_SELL_DEADLINE_MIN_S, EvmPoolSellError, evmPoolVenues, type EvmPoolChain, type EvmV3Route } from "../src/index.ts";
// the checks, the encoding and the digests, through the unpinned builders (no pool or delegate is pinned yet); the
// pinned functions the index exports are tested below with a pinned venue list of the test's own
import {
  evmPoolBuildSellUnpinned as evmPoolBuildSell,
  evmPoolSignSellAuthorizationUnpinned as evmPoolSignSellAuthorization,
  evmPoolSignSellUnpinned as evmPoolSignSell,
  pinnedBuildSell,
  pinnedSignSell,
  pinnedSignSellAuthorization,
  type EvmPoolSellUnpinnedRequest as EvmPoolSellRequest,
} from "../src/trade/evm/sell-unpinned.ts";
import { forkSells } from "./make-kit-sells.ts";

const CAST = JSON.parse(readFileSync(new URL("./evm-pool-sell.cast.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof EvmPoolSellError ? e.code : `not-EvmPoolSellError: ${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
  return "built";
};

// Hardhat mnemonic accounts (m/44'/60'/0'/0/i), published test keys; BIP-39 and BIP-32 written out, no key in the tree
const N = secp256k1.Point.CURVE().n;
function hardhatAccount(index: number): Uint8Array {
  const seed = pbkdf2(sha512, new TextEncoder().encode("test test test test test test test test test test test junk"), new TextEncoder().encode("mnemonic"), { c: 2048, dkLen: 64 });
  let I = hmac(sha512, new TextEncoder().encode("Bitcoin seed"), seed);
  let k = BigInt(hex(I.slice(0, 32)));
  let c = I.slice(32);
  for (const [i, hard] of [[44, true], [60, true], [0, true], [0, false], [index, false]] as [number, boolean][]) {
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
const W_KEY = hardhatAccount(0);
const OTHER_KEY = hardhatAccount(1);
const W = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCOUNT_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const B = evmPoolVenues().base;
const R = evmPoolVenues().robinhood;
const USDC = B.middles[0]!;
const USDG = R.middles[0]!;
const X = "0xF111111111111111111111111111111111111111";
const Y = "0x2222222222222222222222222222222222222222";
const NOW = 1_800_000_000;
// the device's clock, mocked (the kit reads Date.now(), never a caller's now): NOW unless a test moves it
mock.timers.enable({ apis: ["Date"], now: NOW * 1000 });
const at = <T>(sec: number, f: () => T): T => {
  mock.timers.setTime(sec * 1000);
  try {
    return f();
  } finally {
    mock.timers.setTime(NOW * 1000);
  }
};
const v3 = (tokens: string[], fees: number[] = tokens.slice(1).map(() => 500)): EvmV3Route => ({ venue: "uniswap-v3", tokens, fees });
/** A good Base sell of X through USDC, with `o` over it. */
const req = (o: Partial<EvmPoolSellRequest> = {}): EvmPoolSellRequest => ({
  w: W,
  token: X,
  amount: 10n ** 18n,
  target: B.routers[0]!,
  route: v3([X, USDC, B.weth]),
  minOut: 10n ** 15n,
  pool: "0x00000000000000000000000000000000b1f1f001",
  precommitment: 0x5e11n,
  feeCap: 5n * 10n ** 14n,
  deadline: BigInt(NOW + 300),
  nonce: 0n,
  ...o,
});
const fromCast = (t: any): [EvmPoolChain, EvmPoolSellRequest] => [
  t.chain,
  {
    w: W,
    token: t.sells,
    amount: BigInt(t.amount),
    target: t.target,
    route: v3(t.tokens, t.fees),
    minOut: BigInt(t.minOut),
    pool: t.pool,
    precommitment: BigInt(t.precommitment),
    feeCap: BigInt(t.feeCap),
    deadline: BigInt(t.deadline),
    nonce: BigInt(t.nonce),
  },
];

// RLP of cast's signed authorization: [chainId, address, nonce, yParity, r, s], each a short string
function rlpList(h: string): Uint8Array[] {
  const b = Buffer.from(h.slice(2), "hex");
  assert.ok(b[0]! >= 0xc0 && b[0]! <= 0xf7 + 8);
  let i = b[0]! <= 0xf7 ? 1 : 1 + (b[0]! - 0xf7);
  const out: Uint8Array[] = [];
  while (i < b.length) {
    const p = b[i]!;
    if (p < 0x80) (out.push(b.subarray(i, i + 1)), (i += 1));
    else (out.push(b.subarray(i + 1, i + 1 + (p - 0x80))), (i += 1 + (p - 0x80)));
  }
  return out;
}
const big = (b: Uint8Array) => (b.length === 0 ? 0n : BigInt(hex(b)));

test("the swap data equals cast calldata and W's Sell signature equals cast's EIP-712 signature, on Base and Robinhood", () => {
  for (const [name, t] of Object.entries(CAST.sells) as [string, any][]) {
    const [chain, r] = fromCast(t);
    const built = at(Number(t.deadline) - 300, () => evmPoolBuildSell(chain, r));
    assert.equal(built.data, t.data, name);
    assert.equal(evmPoolVenues()[chain].chainId, t.chainId, name);
    assert.equal(hex(evmPoolSignSell(W_KEY, chain, built)), t.sellSignature, name);
  }
});

test("W's EIP-7702 authorization equals cast wallet sign-auth, with the chain's own id", () => {
  for (const [name, t] of Object.entries(CAST.sells) as [string, any][]) {
    const a = evmPoolSignSellAuthorization(W_KEY, t.chain, t.delegate, BigInt(t.authNonce));
    const [chainId, address, nonce, yParity, r, s] = rlpList(t.signedAuthorization);
    assert.equal(Number(big(chainId!)), t.chainId, name);
    assert.equal(a.chainId, t.chainId, name);
    assert.equal(hex(address!), t.delegate.toLowerCase(), name);
    assert.equal(a.nonce, big(nonce!), name);
    assert.equal(a.yParity, Number(big(yParity!)), name);
    assert.equal(BigInt(a.r), big(r!), name);
    assert.equal(BigInt(a.s), big(s!), name);
    assert.ok(BigInt(a.s) <= N >> 1n, "s low");
    assert.ok(Object.isFrozen(a));
  }
  // nonces at RLP's edges (one byte under 0x80, 0x80, two bytes, up to 2^64 - 2) on both chains
  for (const t of CAST.authorizations as any[]) {
    const a = evmPoolSignSellAuthorization(W_KEY, t.chain, t.delegate, BigInt(t.authNonce));
    const [, , nonce, yParity, r, s] = rlpList(t.signedAuthorization);
    assert.equal(a.nonce, big(nonce!), t.authNonce);
    assert.equal(a.yParity, Number(big(yParity!)), t.authNonce);
    assert.equal(BigInt(a.r), big(r!), `${t.chain} ${t.authNonce}`);
    assert.equal(BigInt(a.s), big(s!), `${t.chain} ${t.authNonce}`);
  }
});

test("the swap data is W's swap: recipient W, amountIn the amount, the router's minimum minOut, the path the route's", () => {
  const b = evmPoolBuildSell("base", req());
  const d = Buffer.from(b.data.slice(2), "hex");
  const at = (i: number) => d.subarray(4 + 32 * i, 4 + 32 * (i + 1));
  assert.equal(hex(d.subarray(0, 4)), "0xb858183f");
  assert.equal(hex(at(2).subarray(12)), W.toLowerCase());
  assert.equal(big(at(3)), 10n ** 18n);
  assert.equal(big(at(4)), 10n ** 15n);
  assert.equal(Number(big(at(5))), 20 + 3 + 20 + 3 + 20);
  assert.equal(hex(d.subarray(4 + 32 * 6, 4 + 32 * 6 + 20)), X.toLowerCase());
});

test("the target must be on the chain's router list", () => {
  assert.equal(code(() => evmPoolBuildSell("base", req({ target: R.routers[0]! }))), "bad_target");
  assert.equal(code(() => evmPoolBuildSell("base", req({ target: Y }))), "bad_target");
  assert.equal(code(() => evmPoolBuildSell("base", req({ target: "0x2626" }))), "bad_target");
  assert.equal(code(() => evmPoolBuildSell("base", req({ target: B.routers[0]!.toLowerCase() }))), "built");
  assert.equal(code(() => evmPoolBuildSell("robinhood", req({ target: R.routers[0]!, route: v3([X, USDG, R.weth]) }))), "built");
});

test("the route sells the token for the chain's WETH, through listed middles only", () => {
  const c = (route: unknown, o: Partial<EvmPoolSellRequest> = {}) => code(() => evmPoolBuildSell("base", req({ route: route as EvmV3Route, ...o })));
  assert.equal(c(v3([Y, B.weth])), "token_mismatch");
  assert.equal(c(v3([X, USDC])), "bad_route"); // ends at USDC, not WETH
  assert.equal(c(v3([X, B.weth, USDC, B.weth])), "bad_route"); // WETH in the middle
  assert.equal(c(v3([X, Y, B.weth])), "middle_not_listed");
  assert.equal(c(v3([X, USDG, B.weth])), "middle_not_listed"); // Robinhood's middle, not Base's
  assert.equal(c(v3([X, USDC, USDC, B.weth])), "bad_route"); // a hop that buys what it spends
  assert.equal(c(v3([X, X, B.weth])), "middle_not_listed");
  assert.equal(c(v3([X, Y, X, Y, X, B.weth])), "bad_route"); // five hops: refused before its middles are read
  assert.equal(c(v3([X, USDC, Y, USDC, B.weth])), "middle_not_listed");
  assert.equal(c(v3([X, B.weth], [0x1000000])), "bad_route");
  assert.equal(c(v3([X, B.weth], [1.5])), "bad_route");
  assert.equal(c(v3([X, B.weth], [500, 500])), "bad_route");
  assert.equal(c(v3([X, "0xnot", B.weth])), "bad_route");
  assert.equal(c({ venue: "uniswap-v4", currencyIn: X, hops: [] }), "bad_route");
  assert.equal(c({ venue: "uniswap-v4", tokens: [X, B.weth], fees: [500] }), "bad_route"); // v3's shape, v4's name
  assert.equal(c(null), "bad_route");
  assert.equal(c({ venue: "uniswap-v3", tokens: { length: 2, 0: X, 1: B.weth }, fees: [500] }), "bad_route");
  assert.equal(c(v3([X, B.weth]), { token: B.weth }), "bad_route"); // selling WETH itself
  assert.equal(c(v3([X, B.weth]), { token: "0xF111" }), "bad_route");
  assert.equal(c(v3([X, B.weth])), "built");
  assert.equal(c(v3([X, B.weth.toLowerCase()]), { token: X.toLowerCase() }), "built");
});

test("the deadline is unix seconds, 60 to 600 seconds past now", () => {
  const c = (d: unknown) => code(() => evmPoolBuildSell("base", req({ deadline: d as bigint })));
  assert.equal(EVM_POOL_SELL_DEADLINE_MIN_S, 60);
  assert.equal(EVM_POOL_SELL_DEADLINE_MAX_S, 600);
  assert.equal(c(BigInt(NOW + 59)), "bad_deadline");
  assert.equal(c(BigInt(NOW + 60)), "built");
  assert.equal(c(BigInt(NOW + 600)), "built");
  assert.equal(c(BigInt(NOW + 601)), "bad_deadline");
  assert.equal(c(BigInt(NOW - 1)), "bad_deadline");
  assert.equal(c(BigInt(NOW + 300) * 1000n), "bad_deadline"); // milliseconds
  assert.equal(c(NOW + 300), "bad_deadline"); // a number, not a bigint
  // a caller's now has no way in: a request carrying one in milliseconds, with a deadline in milliseconds, is refused
  assert.equal(code(() => evmPoolBuildSell("base", { ...req(), now: NOW * 1000, deadline: BigInt(NOW * 1000 + 300) } as EvmPoolSellRequest)), "bad_deadline");
  // the clock is the device's, in seconds: the same deadline is refused once the clock passes it, taken while it is near
  assert.equal(at(NOW + 250, () => c(BigInt(NOW + 300))), "bad_deadline");
  assert.equal(at(NOW - 299, () => c(BigInt(NOW + 300))), "built");
  assert.equal(at(NOW - 301, () => c(BigInt(NOW + 300))), "bad_deadline");
});

test("the fee cap is above 0 and under minOut", () => {
  const minOut = 10n ** 15n;
  assert.equal(code(() => evmPoolBuildSell("base", req({ feeCap: 0n }))), "bad_fee");
  assert.equal(code(() => evmPoolBuildSell("base", req({ feeCap: minOut }))), "bad_fee");
  assert.equal(code(() => evmPoolBuildSell("base", req({ feeCap: minOut + 1n }))), "bad_fee");
  assert.equal(code(() => evmPoolBuildSell("base", req({ feeCap: -1n }))), "bad_fee");
  assert.equal(code(() => evmPoolBuildSell("base", req({ feeCap: 5 as unknown as bigint }))), "bad_fee");
  assert.equal(code(() => evmPoolBuildSell("base", req({ feeCap: minOut - 1n }))), "built");
});

test("amount, minOut, precommitment and nonce are in range; W, the token and the pool are addresses; the chain is listed", () => {
  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const c = (o: Partial<EvmPoolSellRequest>, chain: EvmPoolChain = "base") => code(() => evmPoolBuildSell(chain, req(o)));
  assert.equal(c({ amount: 0n }), "bad_amount");
  assert.equal(c({ amount: 1n << 256n }), "bad_amount");
  assert.equal(c({ amount: 1 as unknown as bigint }), "bad_amount");
  assert.equal(c({ minOut: 0n }), "bad_amount");
  assert.equal(c({ minOut: 1n << 256n }), "bad_amount");
  assert.equal(c({ precommitment: P }), "bad_amount");
  assert.equal(c({ precommitment: -1n }), "bad_amount");
  assert.equal(c({ precommitment: P - 1n }), "built");
  assert.equal(c({ nonce: -1n }), "bad_amount");
  assert.equal(c({ nonce: 1n << 256n }), "bad_amount");
  assert.equal(c({ w: "0x0000000000000000000000000000000000000000" }), "bad_route");
  assert.equal(c({ w: W + "00" }), "bad_route");
  assert.equal(c({ pool: "0x0000000000000000000000000000000000000000" }), "bad_route");
  assert.equal(c({ pool: "pool" }), "bad_route");
  for (const ch of ["ethereum", "constructor", "__proto__", "toString"]) assert.equal(c({}, ch as EvmPoolChain), "bad_route", ch);
  assert.equal(code(() => evmPoolBuildSell("base", null as unknown as EvmPoolSellRequest)), "bad_route");
});

test("W signs only a sell the builder returned, for its chain, with W's own key", () => {
  const built = evmPoolBuildSell("base", req());
  assert.ok(Object.isFrozen(built));
  assert.throws(() => void ((built as { target: string }).target = Y), TypeError);
  assert.equal(code(() => evmPoolSignSell(W_KEY, "base", { ...built })), "not_built");
  assert.equal(code(() => evmPoolSignSell(W_KEY, "base", { ...built, data: "0x" })), "not_built");
  assert.equal(code(() => evmPoolSignSell(W_KEY, "base", Object.create(built))), "not_built");
  assert.equal(code(() => evmPoolSignSell(W_KEY, "base", keccak_256(Uint8Array.of(1)) as unknown as typeof built)), "not_built");
  assert.equal(code(() => evmPoolSignSell(W_KEY, "robinhood", built)), "not_built");
  // the domain's verifyingContract is W: a sell built for another W is refused with W's key, and another key refused
  assert.equal(code(() => evmPoolSignSell(W_KEY, "base", evmPoolBuildSell("base", req({ w: ACCOUNT_1 })))), "bad_key");
  assert.equal(code(() => evmPoolSignSell(OTHER_KEY, "base", built)), "bad_key");
  assert.equal(code(() => evmPoolSignSell(OTHER_KEY, "base", evmPoolBuildSell("base", req({ w: ACCOUNT_1 })))), "built");
  assert.equal(code(() => evmPoolSignSell(new Uint8Array(32), "base", built)), "bad_key");
  assert.equal(code(() => evmPoolSignSell(W_KEY.slice(0, 31), "base", built)), "bad_key");
  assert.equal(code(() => evmPoolSignSell(W_KEY, "base", built)), "built");
});

test("W's Sell signatures are 65 bytes, s low, v 27 or 28", () => {
  const vs = new Set<number>();
  for (let i = 0n; i < 48n; i++) {
    const sig = evmPoolSignSell(W_KEY, "base", evmPoolBuildSell("base", req({ nonce: i })));
    assert.equal(sig.length, 65);
    assert.ok(sig[64] === 27 || sig[64] === 28);
    vs.add(sig[64]!);
    assert.ok(BigInt(hex(sig.slice(32, 64))) <= N >> 1n);
  }
  assert.deepEqual([...vs].sort(), [27, 28]);
});

test("W's authorization takes a delegate address, a nonce under 2^64 - 1 and a listed chain, and never chain id 0", () => {
  const D = "0x000000000000000000000000000000000000de1e";
  assert.equal(code(() => evmPoolSignSellAuthorization(W_KEY, "base", "0x0000000000000000000000000000000000000000", 0n)), "bad_route");
  assert.equal(code(() => evmPoolSignSellAuthorization(W_KEY, "base", "0xde1e", 0n)), "bad_route");
  assert.equal(code(() => evmPoolSignSellAuthorization(W_KEY, "base", D, (1n << 64n) - 1n)), "bad_amount");
  assert.equal(code(() => evmPoolSignSellAuthorization(W_KEY, "base", D, -1n)), "bad_amount");
  assert.equal(code(() => evmPoolSignSellAuthorization(W_KEY, "base", D, 0 as unknown as bigint)), "bad_amount");
  assert.equal(code(() => evmPoolSignSellAuthorization(W_KEY, "ethereum" as EvmPoolChain, D, 0n)), "bad_route");
  assert.equal(code(() => evmPoolSignSellAuthorization(new Uint8Array(32), "base", D, 0n)), "bad_key");
  for (const chain of ["base", "robinhood"] as EvmPoolChain[]) assert.notEqual(evmPoolSignSellAuthorization(W_KEY, chain, D, 0n).chainId, 0);
  assert.equal(evmPoolSignSellAuthorization(W_KEY, "base", D, (1n << 64n) - 2n).nonce, (1n << 64n) - 2n);
  let low = true;
  for (let n = 0n; n < 32n; n++) low &&= BigInt(evmPoolSignSellAuthorization(W_KEY, "base", D, n).s) <= N >> 1n;
  assert.ok(low, "s low");
});

test("a stuck sell is replaced by signing again with the same nonce and a new deadline; a burned precommitment with a fresh one", () => {
  const first = evmPoolBuildSell("base", req({ nonce: 3n, deadline: BigInt(NOW + 120) }));
  // the deadline passed with the sell unsent: build and sign again at the new now, same nonce, so only one can land
  const later = NOW + 200;
  assert.equal(at(later, () => code(() => evmPoolBuildSell("base", req({ nonce: 3n, deadline: BigInt(NOW + 120) })))), "bad_deadline");
  const again = at(later, () => evmPoolBuildSell("base", req({ nonce: 3n, deadline: BigInt(later + 120) })));
  assert.equal(again.nonce, first.nonce);
  assert.notEqual(hex(evmPoolSignSell(W_KEY, "base", again)), hex(evmPoolSignSell(W_KEY, "base", first)));
  // the pool refuses a precommitment a second time: a fresh one, signed again, is a different Sell
  const fresh = at(later, () => evmPoolBuildSell("base", req({ nonce: 3n, deadline: BigInt(later + 120), precommitment: 0x5e12n })));
  assert.equal(fresh.precommitment, 0x5e12n);
  assert.notEqual(hex(evmPoolSignSell(W_KEY, "base", fresh)), hex(evmPoolSignSell(W_KEY, "base", again)));
});

test("the request and its route are read once: a getter cannot show the checks one value and the Sell another", () => {
  let reads = 0;
  const route = { venue: "uniswap-v3", fees: [500], get tokens() { return reads++ === 0 ? [X, B.weth] : [Y, B.weth]; } } as unknown as EvmV3Route;
  const built = evmPoolBuildSell("base", req({ route }));
  assert.equal(reads, 1);
  assert.equal(built.data, evmPoolBuildSell("base", req({ route: v3([X, B.weth]) })).data);
  let t = 0;
  const r = req();
  const tricky = { ...r, get target() { return t++ === 0 ? B.routers[0]! : Y; } };
  assert.equal(evmPoolBuildSell("base", tricky).target, B.routers[0]);
  assert.equal(t, 1);
});

test("the router lists are frozen with the rest of the venue list, and the kit exports no digest", () => {
  const v = evmPoolVenues() as unknown as Record<string, { routers: string[] }>;
  assert.throws(() => void v.base!.routers.push(Y), TypeError);
  assert.throws(() => void (v.base!.routers[0] = Y), TypeError);
  assert.throws(() => void (v.robinhood!.routers[0] = Y), TypeError);
  assert.equal(code(() => evmPoolBuildSell("base", req({ target: Y }))), "bad_target");
  assert.deepEqual(Object.keys(kit).filter((k) => /^evmPool/.test(k)).sort(), ["evmPoolBuild", "evmPoolBuildSell", "evmPoolRouteData", "evmPoolSignBuy", "evmPoolSignSell", "evmPoolSignSellAuthorization", "evmPoolVenues"]);
});

test("the fork fixture is the kit's own output: forkSells() equals contracts/pool-evm/test/fixtures/kit-sells.json", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../contracts/pool-evm/test/fixtures/kit-sells.json", import.meta.url), "utf8"));
  assert.deepEqual(forkSells(at), fixture);
});

test("checks the review's mutants passed: a negative fee, an over-long list, a non-string chain, the zero token, the first duplicate hop", () => {
  const c = (o: Partial<EvmPoolSellRequest>, chain: unknown = "base") => code(() => evmPoolBuildSell(chain as EvmPoolChain, req(o)));
  assert.equal(c({ route: v3([X, B.weth], [-1]) }), "bad_route");
  assert.equal(c({ route: v3([X, USDC, B.weth], [500, -500]) }), "bad_route");
  let reads = 0;
  const huge = new Proxy(new Array(1_000_000), {
    get(t, k, r) {
      if (typeof k === "string" && /^\d+$/.test(k)) reads++;
      return Reflect.get(t, k, r);
    },
  });
  assert.equal(c({ route: { venue: "uniswap-v3", tokens: huge, fees: [500] } as unknown as EvmV3Route }), "bad_route");
  assert.equal(reads, 0, "no item of an over-long list is read");
  assert.equal(c({}, { toString: () => "base" }), "bad_route");
  assert.equal(c({}, ["base"]), "bad_route");
  assert.equal(c({ token: "0x0000000000000000000000000000000000000000", route: v3(["0x0000000000000000000000000000000000000000", B.weth]) }), "bad_route");
  assert.equal(c({ token: USDC, route: v3([USDC, USDC, B.weth]) }), "bad_route");
  assert.equal(c({ token: USDC, route: v3([USDC, B.weth]) }), "built");
});

// ------------------------------------------------------------------ M370: the pinned pool and sell delegate

const PIN_POOL = "0x00000000000000000000000000000000b1f1f00a";
const PIN_DELEGATE = "0x000000000000000000000000000000000000de1e";
const PINNED = Object.freeze({
  base: Object.freeze({ ...B, pool: PIN_POOL, sellDelegate: PIN_DELEGATE }),
  robinhood: Object.freeze({ ...R, pool: PIN_POOL, sellDelegate: PIN_DELEGATE }),
});
const { pool: _pool, ...pinnedReq } = req();

test("M370 today no pool or sell delegate is pinned: the kit's evmPoolBuildSell, evmPoolSignSell and evmPoolSignSellAuthorization refuse not_deployed", () => {
  for (const chain of ["base", "robinhood"] as EvmPoolChain[]) {
    const v = evmPoolVenues()[chain];
    assert.equal(v.pool, undefined);
    assert.equal(v.sellDelegate, undefined);
    const r = { ...pinnedReq, target: v.routers[0]!, route: v3([X, v.weth]) };
    assert.equal(code(() => kit.evmPoolBuildSell(chain, r)), "not_deployed", chain);
    assert.equal(code(() => kit.evmPoolSignSell(W_KEY, chain, evmPoolBuildSell(chain, { ...r, pool: PIN_POOL }))), "not_deployed", chain);
    assert.equal(code(() => kit.evmPoolSignSellAuthorization(W_KEY, chain, 0n)), "not_deployed", chain);
  }
});

test("M370 a pinned sell pays only into the chain's pinned pool", () => {
  // a pool the caller names is not read: the pin is the pool
  const built = pinnedBuildSell(PINNED, "base", { ...pinnedReq, pool: "0xBADBADBADBADBADBADBADBADBADBADBADBADBAD0" } as typeof pinnedReq);
  assert.equal(built.pool, PIN_POOL);
  assert.equal(code(() => pinnedSignSell(PINNED, W_KEY, "base", evmPoolBuildSell("base", req({ pool: "0xBADBADBADBADBADBADBADBADBADBADBADBADBAD0" })))), "not_pinned");
  assert.equal(code(() => pinnedSignSell(PINNED, W_KEY, "base", { ...built })), "not_built");
  assert.equal(hex(pinnedSignSell(PINNED, W_KEY, "base", built)), hex(evmPoolSignSell(W_KEY, "base", built)));
  const noPool = Object.freeze({ ...PINNED, base: Object.freeze({ ...B, sellDelegate: PIN_DELEGATE }) });
  assert.equal(code(() => pinnedBuildSell(noPool, "base", pinnedReq)), "not_deployed");
  assert.equal(code(() => pinnedSignSell(noPool, W_KEY, "base", built)), "not_deployed");
  assert.equal(code(() => pinnedBuildSell(PINNED, "ethereum" as EvmPoolChain, pinnedReq)), "bad_route");
  assert.equal(code(() => pinnedBuildSell(PINNED, "base", null as unknown as typeof pinnedReq)), "bad_route");
});

test("M370 W's authorization names only the chain's pinned sell delegate", () => {
  for (const chain of ["base", "robinhood"] as EvmPoolChain[]) {
    const a = pinnedSignSellAuthorization(PINNED, W_KEY, chain, 5n);
    assert.equal(a.address, PIN_DELEGATE);
    assert.deepEqual(a, evmPoolSignSellAuthorization(W_KEY, chain, PIN_DELEGATE, 5n));
  }
  const noDelegate = Object.freeze({ ...PINNED, robinhood: Object.freeze({ ...R, pool: PIN_POOL }) });
  assert.equal(code(() => pinnedSignSellAuthorization(noDelegate, W_KEY, "robinhood", 0n)), "not_deployed");
  assert.equal(code(() => pinnedSignSellAuthorization(PINNED, W_KEY, "ethereum" as EvmPoolChain, 0n)), "bad_route");
});

// ------------------------------------------------------------------ the review of 8d8675d: a polluted Object.prototype

const EVIL = "0xBADBADBADBADBADBADBADBADBADBADBADBADBAD0";
/** Runs `f` with Object.prototype filled the way a prototype-pollution bug in the same page would, then empties it. */
function polluted(f: () => void): void {
  const P = Object.prototype as Record<string, unknown>;
  const fill: Record<string, unknown> = { pool: EVIL, sellDelegate: EVIL, adapters: { v3: EVIL, v4: EVIL }, v3: EVIL, v4: EVIL };
  try {
    for (const k of Object.keys(fill)) P[k] = fill[k];
    f();
  } finally {
    for (const k of Object.keys(fill)) delete P[k];
  }
}

test("M370 a polluted Object.prototype names no pool and no delegate: every sell builder and signer still refuses not_deployed", () => {
  assert.equal(Object.getPrototypeOf(evmPoolVenues()), null, "the venue list has no prototype");
  for (const chain of ["base", "robinhood"] as EvmPoolChain[]) assert.equal(Object.getPrototypeOf(evmPoolVenues()[chain]), null, chain);
  const noPins = Object.freeze({ base: Object.freeze({ ...B }), robinhood: Object.freeze({ ...R }) }); // an ordinary list
  polluted(() => {
    for (const chain of ["base", "robinhood"] as EvmPoolChain[]) {
      const v = evmPoolVenues()[chain];
      const r = { ...pinnedReq, target: v.routers[0]!, route: v3([X, v.weth]) };
      assert.equal(code(() => kit.evmPoolBuildSell(chain, r)), "not_deployed", chain);
      assert.equal(code(() => kit.evmPoolSignSell(W_KEY, chain, evmPoolBuildSell(chain, { ...r, pool: EVIL }))), "not_deployed", chain);
      assert.equal(code(() => kit.evmPoolSignSellAuthorization(W_KEY, chain, 0n)), "not_deployed", chain);
      assert.equal(code(() => pinnedBuildSell(noPins, chain, r)), "not_deployed", chain);
      assert.equal(code(() => pinnedSignSell(noPins, W_KEY, chain, evmPoolBuildSell(chain, { ...r, pool: EVIL }))), "not_deployed", chain);
      assert.equal(code(() => pinnedSignSellAuthorization(noPins, W_KEY, chain, 0n)), "not_deployed", chain);
    }
  });
  assert.equal(({} as Record<string, unknown>).pool, undefined, "the prototype is emptied again");
});
