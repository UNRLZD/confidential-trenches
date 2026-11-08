// The review's attacks on the device's EVM buy quote (src/checks/evm/quote.ts; card evm-pool-buy-quote, review of
// b17d1fc and cefe7a0), on a modelled chain: a provider decodes each aggregate3 call and answers each quote from a
// price model, so a planted chain state needs no recorded answer. R1-R4 and R1b are the review's; R5-R10 hold the
// block agreement, the first-hop native rule, the v3 doubled read, the pinned launchpad pools and a lagging node. N1 and N2 are
// the review of 9a8265b's: N1 on a modelled chain whose PoolManager holds the token's pools (chain() below). Each test states what the device must do.
import { mock, test } from "node:test";
import { readFileSync } from "node:fs";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import { onTestClock } from "./test-clock.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import assert from "node:assert/strict";
import { EvmQuoteError, evmIsDeviceQuote, evmPoolBuyQuote, type EvmPoolBuyQuote, type EvmPoolBuyQuoteRequest, type EvmPoolSellQuoteRequest, type EvmPoolKey, type EvmRoute, type EvmV4Route } from "../src/index.ts";
import { EVM_QUOTE_MAX_KEYS, evmBuyRevertedPoolsWith, evmJsonRpc, evmPoolBuyQuoteWith, evmPoolSellQuoteWith, evmSellRevertedPoolsWith, type EvmPoolSellQuote, type EvmRpc, type EvmRpcCall } from "../src/checks/evm/quote.ts";
// as namespaces: the red run before card evm-route-parity reads them where evmSellRouteOf and evmSellRouteCheck are not
import * as quoteMod from "../src/checks/evm/quote.ts";
import * as sellMod from "../src/trade/evm/sell-unpinned.ts";
import { evmQuotedBuy, evmQuotedSell } from "../src/trade/evm/quoted.ts";
const { evmSellRouteOf } = quoteMod as unknown as { evmSellRouteOf: (r: EvmRoute) => import("../src/trade/evm/sell-unpinned.ts").EvmSellRoute };
const { evmSellRouteCheck } = sellMod as unknown as { evmSellRouteCheck: (chain: "base", token: string, r: unknown) => void };
// the builder as a namespace: the red run before the fix reads it where evmPoolRouteDataQuoted is not there yet
import * as builder from "../src/trade/evm/buy-unpinned.ts";

const W = (v: bigint) => v.toString(16).padStart(64, "0");
const NATIVE = "0x0000000000000000000000000000000000000000";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const RH_WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TOKEN = "0x1111111111111111111111111111111111111111";
const OLD = "0x" + "aa".repeat(32);
const NEW = "0x" + "bb".repeat(32);
const NOW = 1_793_732_153_000; // the device's clock, ms
const T = "0x" + (NOW / 1000 - 2).toString(16); // a head 2 s old

type Pool = { venue: "v3" | "v4"; hops: number; from: string; to: string[]; fees: number[]; spacings: number[]; hooks: string[]; amount: bigint };
// one quoter call's shape, from its calldata
function poolOf(data: string): Pool {
  const sel = data.slice(0, 8);
  const h = data.slice(8);
  const w = (i: number) => BigInt("0x" + h.slice(64 * i, 64 * i + 64));
  const addr = (i: number) => "0x" + h.slice(64 * i + 24, 64 * i + 64);
  if (sel === "cdca1753") {
    const len = Number(w(2));
    const path = h.slice(64 * 3, 64 * 3 + 2 * len);
    const hops = (len - 20) / 23;
    const fees = Array.from({ length: hops }, (_, i) => parseInt(path.slice(40 + 46 * i, 46 + 46 * i), 16));
    const to = Array.from({ length: hops }, (_, i) => "0x" + path.slice(46 + 46 * i, 86 + 46 * i));
    return { venue: "v3", hops, from: "0x" + path.slice(0, 40), to, fees, spacings: [], hooks: [], amount: w(1) };
  }
  assert.equal(sel, "ca253dc9");
  const n = Number(w(4));
  const p: Pool = { venue: "v4", hops: n, from: addr(1), to: [], fees: [], spacings: [], hooks: [], amount: w(3) };
  for (let i = 0; i < n; i++) {
    const at = 5 + Number(w(5 + i)) / 32;
    p.to.push(addr(at));
    p.fees.push(Number(w(at + 1)));
    p.spacings.push(Number(w(at + 2)));
    p.hooks.push(addr(at + 3));
  }
  return p;
}
function decodeAggregate(data: string): string[] {
  const h = data.slice(10);
  const w = (o: number) => Number(BigInt("0x" + h.slice(2 * o, 2 * o + 64)));
  return Array.from({ length: w(32) }, (_, i) => {
    const e = 64 + w(64 + 32 * i);
    const dl = w(e + 96);
    return h.slice(2 * (e + 128), 2 * (e + 128 + dl));
  });
}
// a revert with V4Quoter's NotEnoughLiquidity(bytes32) as its data (card rh-cold-quote: an exact-output quote past what
// the pool can give)
const RAN_OUT = Symbol("NotEnoughLiquidity");
// v4-core's SafeCastOverflow(), wrapped in V4Quoter's UnexpectedRevertBytes(bytes): the output needs more than 2^127 in
const OVERFLOW = Symbol("SafeCastOverflow");
function encodeAggregate(outs: (bigint | null | typeof RAN_OUT | typeof OVERFLOW)[]): string {
  const body = outs.map((x) => (x === RAN_OUT ? W(0n) + W(0x40n) + W(36n) + "7a5ed734" + W(0n) + "0".repeat(56) : x === OVERFLOW ? W(0n) + W(0x40n) + W(100n) + "6190b2b0" + W(0x20n) + W(4n) + "93dafdf1" + "0".repeat(56) + "0".repeat(56) : x === null ? W(0n) + W(0x40n) + W(0n) : W(1n) + W(0x40n) + W(64n) + W(x) + W(0n)));
  let at = 32 * outs.length;
  const offs = body.map((b) => {
    const o = W(BigInt(at));
    at += b.length / 2;
    return o;
  });
  return "0x" + W(0x20n) + W(BigInt(outs.length)) + offs.join("") + body.join("");
}
type Head = { number: string; hash: string; timestamp: string; baseFeePerGas?: string };
/** A provider: `head` is its latest block, `byNumber` the other blocks it holds, `price` answers each quote at the
 *  block hash asked (null: the quote reverts). */
function provider(head: Head, price: (p: Pool, hash: string) => bigint | null, byNumber: Record<string, Head> = {}): EvmRpc {
  return async (calls: readonly EvmRpcCall[]) =>
    calls.map((c, id) => {
      if (c.method === "eth_getBlockByNumber") {
        const n = c.params[0] as string;
        if (n === "latest") return { jsonrpc: "2.0", id, result: { ...head } };
        const b = n === head.number ? head : byNumber[n];
        return { jsonrpc: "2.0", id, result: b === undefined ? null : { ...b } };
      }
      assert.equal(c.method, "eth_call");
      const { to, data } = c.params[0] as { to: string; data: string };
      const hash = (c.params[1] as { blockHash: string }).blockHash;
      if (to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11") {
        return { jsonrpc: "2.0", id, result: encodeAggregate(decodeAggregate(data).map((d) => price(poolOf(d), hash))) };
      }
      const out = price(poolOf(data.slice(2)), hash);
      return out === null ? { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } } : { jsonrpc: "2.0", id, result: "0x" + W(out) + W(0n) };
    });
}
const verdict = async (p: Promise<unknown>) => {
  try {
    const q = (await p) as { amountOut: bigint; minOut: bigint; block: { number: bigint } };
    return { accepted: true, amountOut: q.amountOut, minOut: q.minOut, block: q.block.number };
  } catch (e) {
    if (!(e instanceof EvmQuoteError)) throw e;
    return { accepted: false, code: e.code };
  }
};
const AMOUNT = 10n ** 18n;
const v3direct: EvmRoute = { venue: "uniswap-v3", tokens: [WETH, TOKEN], fees: [10000] };
const buy = (route: EvmRoute, a: EvmRpc, b: EvmRpc, chain: "base" | "robinhood" = "base") =>
  verdict(evmPoolBuyQuoteWith({ chain, token: TOKEN, amountIn: AMOUNT, slippageBps: 100, route }, [a, b], NOW));
// every modelled block's base fee (Base's, read 2026-11-04 14:10Z on mainnet.base.org and base-rpc.publicnode.com)
const BASE_FEE = 5_000_000n;
const head = (number: string, hash = NEW, timestamp = T): Head => ({ number, hash, timestamp, baseFeePerGas: "0x" + BASE_FEE.toString(16) });
const flat = (p: Pool) => p.amount;

test("R1 one provider alone picks a stale block: a fake low head number with an old canonical hash", async () => {
  // the pools give 1 token a wei now (NEW) and 0.5 at the old block the lying provider names (OLD)
  const price = (p: Pool, hash: string) => (hash === OLD ? p.amount / 2n : p.amount);
  const liar = provider(head("0x1", OLD), price);
  const honest = provider(head("0x2000000"), price, { "0x1": head("0x1", OLD, "0x1") });
  assert.deepEqual(await buy(v3direct, liar, honest), { accepted: false, code: "rpc_disagree" });
});

test("R1b one provider alone names the honest head's number with an old block's hash", async () => {
  const price = (p: Pool, hash: string) => (hash === OLD ? p.amount / 2n : p.amount);
  const liar = provider(head("0x2000000", OLD), price);
  const honest = provider(head("0x2000000"), price);
  assert.deepEqual(await buy(v3direct, liar, honest), { accepted: false, code: "rpc_disagree" });
});

test("R2 a direct route is held to the standard two-hop routes through the listed middle", async () => {
  // every direct pool gives 1 token a wei; every standard two-hop through USDC gives 3
  const price = (p: Pool) => (p.hops === 2 ? 3n * p.amount : p.amount);
  assert.deepEqual(await buy(v3direct, provider(head("0x100"), price), provider(head("0x100"), price)), { accepted: false, code: "below_reference" });
});

test("R3 a v4 two-hop route is held to the v3 two-hop routes through the same middle", async () => {
  const route: EvmRoute = {
    venue: "uniswap-v4",
    currencyIn: NATIVE,
    hops: [
      { currency: USDC, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" },
      { currency: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" },
    ],
  };
  // no direct pool; v4 two-hops give 1, v3 two-hops (WETH-USDC-token) give 3
  const price = (p: Pool) => (p.hops === 1 ? null : p.venue === "v3" ? 3n * p.amount : p.amount);
  assert.deepEqual(await buy(route, provider(head("0x100"), price), provider(head("0x100"), price)), { accepted: false, code: "below_reference" });
});

test("R4 no standard or pinned launchpad pool answers: a helper's hookless 50%-fee pool refuses no_reference", async () => {
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: TOKEN, fee: 500000, tickSpacing: 1, hooks: NATIVE, hookData: "0x" }] };
  const price = (p: Pool) => (p.venue === "v4" && p.hops === 1 && p.fees[0] === 500000 ? p.amount / 10n : null);
  assert.deepEqual(await buy(route, provider(head("0x100"), price), provider(head("0x100"), price)), { accepted: false, code: "no_reference" });
});

test("R5 heads within the chain's lag whose lower block the other provider holds with another hash or time refuse", async () => {
  // Base allows 50 blocks (10 s of 200 ms blocks): provider 1's head 0xfe is 2 behind; provider 2 holds 0xfe with another hash, or another time
  const a = provider(head("0xfe", OLD), flat);
  assert.deepEqual(await buy(v3direct, a, provider(head("0x100"), flat, { "0xfe": head("0xfe", NEW) })), { accepted: false, code: "rpc_disagree" });
  assert.deepEqual(await buy(v3direct, a, provider(head("0x100"), flat, { "0xfe": head("0xfe", OLD, "0x1") })), { accepted: false, code: "rpc_disagree" });
  // nor holds it at all
  assert.deepEqual(await buy(v3direct, a, provider(head("0x100"), flat)), { accepted: false, code: "rpc_error" });
  // and 51 blocks apart is past Base's lag
  assert.deepEqual(await buy(v3direct, provider(head("0xcd"), flat), provider(head("0x100"), flat, { "0xcd": head("0xcd") })), { accepted: false, code: "rpc_disagree" });
  // where it holds the same block, the quote reads at it
  const ok = await buy(v3direct, a, provider(head("0x100"), flat, { "0xfe": head("0xfe", OLD) }));
  assert.equal(ok.accepted, true, String((ok as { code?: string }).code));
  assert.equal((ok as { block: bigint }).block, 0xfen);
});

test("R11 the lower block's base fee is the other provider's too, and well formed: the sim prices from it (card evm-quote-exec-sim)", async () => {
  const a = provider(head("0xfe", OLD), flat);
  // the other provider holds 0xfe with the same hash and time but another base fee
  assert.deepEqual(await buy(v3direct, a, provider(head("0x100"), flat, { "0xfe": { ...head("0xfe", OLD), baseFeePerGas: "0x1" } })), { accepted: false, code: "rpc_disagree" });
  // a base fee that is not a quantity
  const bad = provider({ ...head("0xfe", OLD), baseFeePerGas: "0xzz" }, flat);
  assert.deepEqual(await buy(v3direct, bad, provider(head("0x100"), flat, { "0xfe": head("0xfe", OLD) })), { accepted: false, code: "rpc_error" });
  // the same on both: it reads
  assert.equal((await buy(v3direct, a, provider(head("0x100"), flat, { "0xfe": head("0xfe", OLD) }))).accepted, true);
});

test("R6 a block both providers agree on but more than 30 s behind the device's clock refuses", async () => {
  // the device's clock stands still here (mono fixed), so the block's age is exactly its distance from NOW
  const still = (route: EvmRoute, a: EvmRpc, b: EvmRpc) => verdict(evmPoolBuyQuoteWith({ chain: "base", token: TOKEN, amountIn: AMOUNT, slippageBps: 100, route }, [a, b], NOW, undefined, undefined, () => 0));
  const old = "0x" + (NOW / 1000 - 31).toString(16);
  assert.deepEqual(await still(v3direct, provider(head("0x100", NEW, old), flat), provider(head("0x100", NEW, old), flat)), { accepted: false, code: "stale_quote" });
  const fresh = "0x" + (NOW / 1000 - 30).toString(16);
  assert.equal((await still(v3direct, provider(head("0x100", NEW, fresh), flat), provider(head("0x100", NEW, fresh), flat))).accepted, true);
});

test("R7 on Robinhood a WETH route whose first hop has a native pool refuses native_first, though no native route reaches the token", async () => {
  const route: EvmRoute = { venue: "uniswap-v3", tokens: [RH_WETH, USDG, TOKEN], fees: [500, 500] };
  // the route answers; of the native pools only native/USDG does
  const price = (p: Pool) =>
    p.venue === "v3" ? p.amount : p.venue === "v4" && p.hops === 1 && p.from === NATIVE && p.to[0] === USDG && p.hooks[0] === NATIVE ? 2n * p.amount : null;
  assert.deepEqual(await buy(route, provider(head("0x100"), price), provider(head("0x100"), price), "robinhood"), { accepted: false, code: "native_first" });
  // with no native pool for the first hop the WETH route quotes
  const noNative = (p: Pool) => (p.venue === "v3" ? p.amount : null);
  assert.equal((await buy(route, provider(head("0x100"), noNative), provider(head("0x100"), noNative), "robinhood")).accepted, true);
});

test("R8 a v3 route whose quote at twice the amount reverts refuses partial_fill", async () => {
  const price = (p: Pool) => (p.venue === "v3" && p.amount > AMOUNT ? null : p.amount);
  assert.deepEqual(await buy(v3direct, provider(head("0x100"), price), provider(head("0x100"), price)), { accepted: false, code: "partial_fill" });
});

test("R9 a pinned launchpad pool is a reference: Clanker's hooked pool holds a hookless route", async () => {
  const CLANKER = "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc";
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: TOKEN, fee: 500000, tickSpacing: 1, hooks: NATIVE, hookData: "0x" }] };
  // the helper's pool gives a tenth; Clanker's WETH pool for the token gives the full amount
  const price = (p: Pool) =>
    p.venue === "v4" && p.hops === 1 && p.fees[0] === 500000 ? p.amount / 10n : p.venue === "v4" && p.hops === 1 && p.from === WETH && p.hooks[0] === CLANKER ? p.amount : null;
  assert.deepEqual(await buy(route, provider(head("0x100"), price), provider(head("0x100"), price)), { accepted: false, code: "below_reference" });
});

test("R10 a provider whose node is one block behind is asked once more, and refused when still behind", async () => {
  // provider 2 answers its first call at the head's hash and its first read of the head by number as not held yet
  const lagging = (misses: number): EvmRpc => {
    const inner = provider(head("0xfe", OLD), flat);
    let left = misses;
    return async (calls) => {
      const out = await inner(calls);
      if (left === 0 || calls[0]!.params[0] === "latest") return out;
      left--;
      return calls.map((c, id) => (c.method === "eth_call" ? { jsonrpc: "2.0", id, error: { code: -32000, message: `block not found: canonical hash ${OLD}` } } : { jsonrpc: "2.0", id, result: null }));
    };
  };
  const ok = await buy(v3direct, provider(head("0xfe", OLD), flat), lagging(1));
  assert.equal(ok.accepted, true, String((ok as { code?: string }).code));
  assert.deepEqual(await buy(v3direct, provider(head("0xfe", OLD), flat), lagging(1000)), { accepted: false, code: "rpc_error" });
});

test("N2 a caller's fetch makes no device quote: the public entry reads only the pinned providers", () => onTestClock(async () => {
  // a fetch that answers both pinned URLs itself, with a fresh head and a route the caller priced
  const rpc = provider({ number: "0x100", hash: NEW, timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16) }, (p) =>
    p.hops === 1 && p.from === NATIVE && p.fees[0] === 500 && p.hooks[0] === NATIVE ? (p.amount === AMOUNT ? 7n : 14n) : null,
  );
  let forgedCalls = 0;
  const forged = (async (_url: string, init: { body: string }) => {
    forgedCalls++;
    const calls = JSON.parse(init.body) as { id: number; method: string; params: unknown[] }[];
    const answers = await rpc(calls.map((c) => ({ method: c.method, params: c.params })));
    return { text: async () => JSON.stringify(answers.map((a, i) => ({ ...(a as object), id: calls[i]!.id }))) };
  }) as unknown as typeof fetch;
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: TOKEN, fee: 500, tickSpacing: 10, hooks: NATIVE, hookData: "0x" }] };
  // the network is off in this test: the pinned providers do not answer
  const net = mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });
  let q: unknown;
  try {
    q = await (evmPoolBuyQuote as (r: unknown, o: unknown) => Promise<unknown>)({ chain: "base", token: TOKEN, amountIn: AMOUNT, slippageBps: 100, route }, { fetch: forged });
  } catch (e) {
    q = e;
  } finally {
    net.mock.restore();
  }
  assert.equal(forgedCalls, 0, "the caller's fetch is never called");
  assert.equal(evmIsDeviceQuote(q), false, "answers the caller wrote make no device quote");
  assert.ok(q instanceof EvmQuoteError && q.code === "rpc_error", String(q));
  assert.equal(evmPoolBuyQuote.length, 1);
}));

// ------------------------------------------------------------------ N1: the pools the device finds for a token
// A modelled chain: `pools` exist in its PoolManager (extsload answers their price and liquidity), each quoting
// `give(amount)` with its hook replaced by the hook that does nothing, and `lie(amount)` with its hook running.
const PM = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const RH_PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // Robinhood Chain's PoolManager (the venue list)
const BS_PM = "0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408"; // Base Sepolia's PoolManager (the venue list)
const CLANKER = "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc";
const UNPINNED = "0x00000000000000000000000000000000000020cc";
const kk = (h: string) => Buffer.from(keccak_256(Buffer.from(h, "hex"))).toString("hex");
// `ticks`: the pool's initialized ticks, set in its tickBitmap words
// `exec`: what the pool pays a swap that is not the quoter's (W's own sell, card evm-quote-exec-sim); by default what
// it pays the quoter with its hook as it is
// `ctx`: the context the call to W runs in, as a node runs an eth_call (see simCtx); `block`: the block number the call
// runs at where it is not the agreed block (a replay's block override, or the real sale's block; card
// evm-sell-hook-converge); `sale`: the real sale itself, which alone sees what a transaction earlier in its own block did
// `neutral`: what the pool pays W's own sell with its hook replaced by the no-op hook (by default `give`)
// `lieAt`: what the quoter reads with its hook as it is where the read carries a block override (`lie` otherwise)
// `over`: the hooks the call replaces with the no-op hook; `dir`: whether the pool is swapped in a buy or a sale
// `codes`: the code the call's state override gives each address it replaces (lowercased), which a `neutral` may run
type SimCtx = { origin: string; sender: string; gas: bigint; gasPrice: bigint; block?: number; sale?: true; over?: Set<string>; dir?: "buy" | "sell"; sees?: Sees; codes?: Record<string, string> };
// What a call at a block after the quote's sees of its block, each true where it is the trade's block's own (review of
// da11bbb6, H1): L1Block's sequenceNumber, EIP-2935's hash of the block before, EIP-4788's root at the block's time,
// BASEFEE and PREVRANDAO. The real trade sees all; a replay sees each only where its overrides set it (sysSees below).
// `backlog`: on Robinhood (Nitro), ArbOS's gas-pricing backlog as the trade block's start left it, decayed by the time
// passed (review of ca907a05, HIGH 1); no replay sees it, since it lives in ArbOS's own storage, which the device does
// not override (card evm-sell-hook-intrablock replays at the trade's true pre-state); on Base there is none to tell.
// `earlier`: the state an earlier transaction of the trade's block wrote (the model's EARLIER slot; HC2), which a replay
// sees only where its override carries the trade's pre-state (card evm-sell-hook-intrablock: the trade's own trace).
type Sees = { seq: boolean; hist: boolean; beacon: boolean; baseFee: boolean; randao: boolean; backlog: boolean; earlier: boolean };
// `most`: the most of the currency it was found for the pool gives at any price, which an exact-output quote of more
// reverts NotEnoughLiquidity on (card rh-cold-quote; none: any amount); `mostOn`: on that provider only; `over`: any
// exact-output quote of it answers SafeCastOverflow (on provider `over`, or both); `plainOn`: a revert with no data there
// (or on both); `mostOf`: the most of each currency, by address, the pool gives at any price, read on the quote's
// direction (its zeroForOne: currency1 out, else currency0)
// `deltaFee`: where its `exec` fails the trade, it does so by a fee taken through a delta (the miss shows at minOut), not
// by its hook reverting, so the trade's trace shows no errored frame into the hook
type ModelPool = { deltaFee?: true; key: EvmPoolKey; give: (a: bigint) => bigint; lie?: ((a: bigint) => bigint | null) | undefined; lieAt?: (a: bigint, ctx: SimCtx) => bigint | null; exec?: (a: bigint, ctx: SimCtx) => bigint | null; neutral?: (a: bigint, ctx: SimCtx) => bigint | null; only?: 0 | 1; state?: [bigint, bigint]; ticks?: number[]; most?: bigint; mostOn?: 0 | 1; mostOf?: Record<string, bigint>; over?: 0 | 1 | "both"; plainOn?: 0 | 1 | "both" };
const pidOf = (k: EvmPoolKey) => kk(W(BigInt(k.currency0)) + W(BigInt(k.currency1)) + W(BigInt(k.fee)) + W(BigInt(k.tickSpacing)) + W(BigInt(k.hooks)));
const keyOf = (token: string, other: string, fee: number, tickSpacing: number, hooks: string): EvmPoolKey => {
  const [currency0, currency1] = BigInt(other) < BigInt(token) ? [other, token] : [token, other];
  return { currency0, currency1, fee, tickSpacing, hooks };
};
// the chain's head in the model: the agreed block, which the scan provider's head must be within maxLag of;
// `overrides` keeps, for each eth_call with a state override, the addresses it replaces and the hooks of each quote in it;
// `balances` is each account's ETH at the block (the pinned sell sender holds one ETH), which a state override replaces;
// `nitro`: the chain is Robinhood's (Arbitrum Nitro), whose system state a replay sees as sysWord and sysSees hold it
type Overridden = { replaces: string[]; hooks: string[][] };
function chain(pools: ModelPool[], who: 0 | 1, headNo = 5_000_000, overrides?: Overridden[], balances: Record<string, bigint> = { [SENDER]: 10n ** 18n }, nitro = false): EvmRpc {
  const live = pools.filter((p) => p.only === undefined || p.only === who);
  const byPid = new Map(live.map((p) => [pidOf(p.key), p]));
  const slots = new Map<string, bigint>();
  for (const p of live) {
    const s = BigInt("0x" + kk(pidOf(p.key) + W(6n)));
    // slot0: a price in the low 160 bits, a tick above; liquidity 3 words on
    slots.set(W(s), p.state?.[0] ?? 1n << 96n); // a price of 1 at tick 0, so a quote of the amount (the model's default) is within the spot price either way
    slots.set(W(s + 3n), p.state?.[1] ?? 10n ** 20n);
    for (const t of p.ticks ?? []) {
      const c = Math.floor(t / p.key.tickSpacing);
      const at = W(BigInt("0x" + kk(W(BigInt.asUintN(256, BigInt(c >> 8))) + W(s + 5n))));
      slots.set(at, (slots.get(at) ?? 0n) | (1n << BigInt(c & 255)));
    }
  }
  // a v4 quote through each hop's pool in turn; a hop with no pool reverts
  const quote = (d: string, overridden: Set<string>, at?: SimCtx): bigint | null => {
    const q = poolOf(d);
    if (q.venue !== "v4") return null;
    let [from, amount] = [q.from, q.amount];
    for (let i = 0; i < q.hops; i++) {
      const k = keyOf(q.to[i]!, from, q.fees[i]!, q.spacings[i]!, q.hooks[i]!);
      const p = byPid.get(pidOf({ ...k, currency0: k.currency0.toLowerCase(), currency1: k.currency1.toLowerCase(), hooks: k.hooks.toLowerCase() }));
      if (p === undefined) return null;
      const asIs = p.key.hooks !== NATIVE && !overridden.has(p.key.hooks);
      const next = asIs && p.lieAt !== undefined && at !== undefined ? p.lieAt(amount, at) : asIs && p.lie !== undefined ? p.lie(amount) : p.give(amount);
      if (next === null) return null;
      // a hookless hop, or one whose hook is replaced, swaps on its curve: never more than the amount at its spot
      // price after its fee, the bound the device prunes by; a model pool that gives more is a broken test, not a chain
      if (!asIs) {
        const s0 = slots.get(W(BigInt("0x" + kk(pidOf(p.key) + W(6n)))))!;
        const [sq, fee] = [s0 & ((1n << 160n) - 1n), (s0 >> 208n) & 0xffffffn];
        const y = (amount * (1_000_000n - fee) + 999_999n) / 1_000_000n;
        const zf = BigInt(from) < BigInt(q.to[i]!);
        const most = zf ? (y * sq * sq + (1n << 192n) - 1n) >> 192n : ((y << 192n) + sq * sq - 1n) / (sq * sq);
        if (next > most) throw new Error(`model pool ${pidOf(p.key).slice(0, 8)} gives ${next} for ${amount}, past its spot price's ${most}`);
      }
      amount = next;
      from = q.to[i]!;
    }
    return amount;
  };
  // V4Quoter.quoteExactOutputSingle (card rh-cold-quote): the pool's key, zeroForOne and the amount out; past the pool's
  // `most` it runs out, otherwise it answers an amount in
  const exactOut = (d: string): bigint | null | typeof RAN_OUT | typeof OVERFLOW => {
    const w = (i: number) => BigInt("0x" + d.slice(8 + 64 * i, 72 + 64 * i));
    const a = (i: number) => "0x" + d.slice(8 + 64 * i + 24, 72 + 64 * i);
    const p = byPid.get(pidOf({ currency0: a(1), currency1: a(2), fee: Number(w(3)), tickSpacing: Number(BigInt.asIntN(256, w(4))), hooks: a(5) }));
    if (p === undefined) return null;
    if (p.over === "both" || p.over === who) return OVERFLOW;
    if (p.plainOn === "both" || p.plainOn === who) return null;
    const out = p.mostOf?.[(w(6) === 1n ? a(2) : a(1)).toLowerCase()];
    if (out !== undefined && w(7) > out) return RAN_OUT;
    const most = p.mostOn === undefined || p.mostOn === who ? p.most : undefined;
    return most !== undefined && w(7) > most ? RAN_OUT : w(7);
  };
  const one = (to: string, d: string, overridden: Set<string>, at?: SimCtx): bigint | null | typeof RAN_OUT | typeof OVERFLOW =>
    // a sell's fee-on-transfer probe, run as W's code (token, to, amount): the token in the model delivers it whole
    overridden.has(to.toLowerCase()) && d.length === 192 ? BigInt("0x" + d.slice(128))
    // QuoterV2.factory(): no v3 in the model
    : d.startsWith("c45a0155") ? null
    // the chain fee oracle (pool-fee.ts evmPoolChainFeeReads): none beside the gas in the model
    : d.startsWith("f1c7a58b") || d.startsWith("275aedd2") || d.startsWith("f5d6ded7") ? 0n
    // Multicall3.getEthBalance(address): the account's ETH at the block
    : to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11" && d.startsWith("4d2301cc") ? (balances["0x" + d.slice(32, 72)] ?? 0n)
    : to.toLowerCase() === PM || to.toLowerCase() === RH_PM || to.toLowerCase() === BS_PM
      ? d.startsWith("1e2eaeaf") ? (slots.get(d.slice(8)) ?? 0n) : null
      : d.startsWith("3850c7bd") || d.startsWith("1a686502") ? null // no v3 pool in the model
        : d.startsWith("58733073") ? exactOut(d)
        : quote(d, overridden, at);
  return async (calls) =>
    calls.map((c, id) => {
      if (c.method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id, result: head("0x" + headNo.toString(16)) };
      // W's releases at a sale (card evm-sell-no-release-in-flight): none in the model, its finalized block its head
      if (c.method === "eth_getLogs") return { jsonrpc: "2.0", id, result: [] };
      // a sale the model landed (card evm-sell-hook-converge, SALES below): its transaction, receipt and block
      if (c.method === "eth_getTransactionByHash" || c.method === "eth_getTransactionReceipt" || c.method === "eth_getBlockByHash") {
        const s = c.method === "eth_getBlockByHash" ? [...SALES.values()].find((x) => x.blockHash === c.params[0]) : SALES.get(String(c.params[0]));
        if (s === undefined) return { jsonrpc: "2.0", id, result: null };
        const block = { hash: s.blockHash, number: "0x" + s.block.toString(16), timestamp: SALE_TIME, parentHash: SALE_PARENT, baseFeePerGas: "0x" + SALE_BASE_FEE.toString(16), mixHash: SALE_MIX };
        if (c.method === "eth_getBlockByHash") return { jsonrpc: "2.0", id, result: block };
        if (c.method === "eth_getTransactionReceipt") return { jsonrpc: "2.0", id, result: { transactionHash: s.hash, blockHash: s.blockHash, blockNumber: block.number, transactionIndex: s.rcIndex ?? "0x3", gasUsed: "0x" + (((s.gas ?? (s.bought !== undefined ? BUY_GAS : SALE_GAS)) * 4n) / 5n).toString(16), status: who === 1 && s.status1 !== undefined ? s.status1 : s.status, logs: s.logs ?? [], ...(s.l1Gas !== undefined ? { gasUsedForL1: "0x" + s.l1Gas.toString(16) } : {}) } };
        // a buy is the helper's type 2 transaction with no authorizations (signEvmTx), a sale W's type 4 with one
        const fees = { value: "0x0", maxFeePerGas: "0x" + (BASE_FEE + 1_000_000n).toString(16), maxPriorityFeePerGas: "0xf4240" };
        if (s.bought !== undefined) return { jsonrpc: "2.0", id, result: { hash: s.hash, type: "0x2", from: SENDER, to: s.to ?? SALE_POOL, input: s.input, gas: "0x" + (s.gas ?? BUY_GAS).toString(16), ...fees, blockHash: s.blockHash, blockNumber: block.number, transactionIndex: "0x3" } };
        return { jsonrpc: "2.0", id, result: { hash: s.hash, type: "0x4", from: SENDER, to: s.to ?? SELL_W, input: s.input, gas: "0x" + (s.gas ?? SALE_GAS).toString(16), ...fees, authorizationList: [{ chainId: "0x2105", address: DELEGATED.base!.sellDelegate, nonce: "0x0", yParity: "0x0", r: "0x1", s: "0x1" }], blockHash: s.blockHash, blockNumber: block.number, transactionIndex: "0x3" } };
      }
      // the trade's own trace (card evm-sell-hook-intrablock), as dRPC and Pocket answer on Robinhood; none elsewhere
      if (c.method === "debug_traceTransaction") {
        const s = SALES.get(String(c.params[0]));
        if (!nitro || s === undefined) return { jsonrpc: "2.0", id, error: { code: -32601, message: "the method debug_traceTransaction does not exist/is not available" } };
        const cfg = c.params[1] as { tracer: string; tracerConfig?: { disableCode?: boolean } };
        return { jsonrpc: "2.0", id, result: traceOf(s, cfg.tracer, who, balances, cfg.tracerConfig?.disableCode === true) };
      }
      // the system slots the device reads at the sale's block (review of da11bbb6, H1), as sysWord holds them
      if (c.method === "eth_getStorageAt") {
        const at = (c.params[2] as { blockHash?: string } | undefined)?.blockHash;
        const s = [...SALES.values()].find((x) => x.blockHash === at);
        return { jsonrpc: "2.0", id, result: sysWord(String(c.params[0]), BigInt(String(c.params[1])), s?.block ?? HEAD_NO, nitro) };
      }
      // a state override's stateDiff: each key and value 0x and 64 hex digits, as geth reads them (common.Hash), or the
      // call is refused, as base-rpc.publicnode.com and mainnet.base.org (-32602 "Invalid params … odd number of
      // digits") and rpc.mainnet.chain.robinhood.com (-32602 "cannot unmarshal hex string of odd length into Go struct
      // field OverrideAccount") refused the key "0x1" (review of ca907a05, LOW 1, 2026-11-07)
      const diffs = Object.values((c.method === "eth_call" ? c.params[2] : undefined) ?? {}).map((o) => (o as { stateDiff?: Record<string, unknown> }).stateDiff ?? {});
      if (diffs.some((d) => Object.entries(d).some(([k, v]) => !/^0x[0-9a-fA-F]{64}$/.test(k) || typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)))) return { jsonrpc: "2.0", id, error: { code: -32602, message: "invalid argument 2: hex string has length != 64" } };
      // Nitro refuses any override of ArbOS's state account (every pinned Robinhood provider, 2026-11-07 16:22Z)
      if (nitro && c.method === "eth_call" && Object.keys((c.params[2] ?? {}) as object).some((k) => k.toLowerCase() === ARBOS)) return { jsonrpc: "2.0", id, error: { code: -32000, message: "overriding address 0xA4b05FffffFffFFFFfFFfffFfffFFfffFfFfFFFf  not allowed" } };
      const { to, data } = c.params[0] as { to: string; data: string };
      const overridden = new Set(Object.keys((c.params[2] as Record<string, unknown> | undefined) ?? {}).map((x) => x.toLowerCase()));
      if (overridden.size > 0 && overrides !== undefined) {
        const ds = to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11" ? decodeAggregate(data) : [data.slice(2)];
        overrides.push({ replaces: [...overridden], hooks: ds.filter((d) => d.startsWith("ca253dc9")).map((d) => poolOf(d).hooks.map((h) => h.toLowerCase())) });
      }
      if (to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11") {
        const tos = (() => {
          const h = data.slice(10);
          const w = (o: number) => Number(BigInt("0x" + h.slice(2 * o, 2 * o + 64)));
          return Array.from({ length: w(32) }, (_, i) => "0x" + h.slice(2 * (64 + w(64 + 32 * i)) + 24, 2 * (64 + w(64 + 32 * i)) + 64));
        })();
        return { jsonrpc: "2.0", id, result: encodeAggregate(decodeAggregate(data).map((d, i) => one(tos[i]!, d, overridden))) };
      }
      // PoolManager.extsload(bytes32[]): each slot's word
      if ((to.toLowerCase() === PM || to.toLowerCase() === RH_PM || to.toLowerCase() === BS_PM) && data.startsWith("0xdbd035ff")) {
        const n = Number(BigInt("0x" + data.slice(74, 138)));
        const words = Array.from({ length: n }, (_, k) => slots.get(data.slice(138 + 64 * k, 202 + 64 * k)) ?? 0n);
        return { jsonrpc: "2.0", id, result: "0x" + W(32n) + W(BigInt(n)) + words.map(W).join("") };
      }
      const asW = (c.params[2] as Record<string, { code?: string }> | undefined)?.[SELL_W]?.code;
      const isSim = to.toLowerCase() === SELL_W && asW?.startsWith("0xef0100");
      // the pool's buy (card evm-buy-hook-converge): the real buy, and its replays at the buy's block
      const isBuy = to.toLowerCase() === SALE_POOL && data.startsWith("0x" + SEL_BUY_T);
      const base = isSim || isBuy ? simCtx(c.params[0] as CallArgs, (c.params[2] ?? {}) as Record<string, { balance?: string }>, balances) : null;
      if (typeof base === "string") return { jsonrpc: "2.0", id, error: { code: -32000, message: base } };
      // a block override (a replay of a sale) runs the call at that block; the model's own marker runs the real sale
      const env = c.params[3] as { number?: string; baseFeePerGas?: string; prevRandao?: string } | undefined;
      const codes = Object.fromEntries(Object.entries((c.params[2] ?? {}) as Record<string, { code?: string }>).flatMap(([a, o]) => (o.code !== undefined ? [[a.toLowerCase(), o.code]] : [])));
      const ctx = base === null ? null : { ...base, codes, ...(env?.number !== undefined ? { block: Number(BigInt(env.number)), sees: c.params[4] === SALE_RUN ? SEES_ALL : sysSees(Number(BigInt(env.number)), (c.params[2] ?? {}) as Record<string, { stateDiff?: Record<string, string> }>, env, nitro) } : {}), ...(c.params[4] === SALE_RUN ? { sale: true as const } : {}) };
      // a quoter read with a block override (step 3 on the replay's own basis) runs at that block with what it overrides
      const at = base === null && env?.number !== undefined ? { origin: SENDER, sender: SENDER, gas: 0n, gasPrice: 0n, block: Number(BigInt(env.number)), sees: sysSees(Number(BigInt(env.number)), (c.params[2] ?? {}) as Record<string, { stateDiff?: Record<string, string> }>, env, nitro) } : undefined;
      const o = isSim ? simSell(data.slice(2), c.params[2] as Record<string, { code: string }>, ctx!, overridden) : isBuy ? buyRun(data.slice(2), ctx!, overridden) : one(to, data.slice(2), overridden, at);
      // SellDelegate's and the pool's MinOutNotMet() (0x81efc143) as the revert's data of W's sell or the pool's buy, so a
      // replay's two answers can be held equal
      // the pool's buy lands a failed swap (status 1, the chunk back to W) and returns `_bought` (card pool-evm-buy-pays-revert)
      if (isBuy) return o === SWAP_GAS_TOO_LOW ? { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: SEL_SWAP_GAS_TOO_LOW } } : { jsonrpc: "2.0", id, result: "0x" + W(o === null ? 0n : 1n) };
      return o === null || o === RAN_OUT || o === OVERFLOW || o === SWAP_GAS_TOO_LOW ? { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", ...(isSim ? { data: "0x81efc143" } : {}) } } : { jsonrpc: "2.0", id, result: "0x" + W(o) + W(0n) };
    });
  // PrivacyPoolSimple.buy (card evm-buy-hook-converge): the Buy at head word 18 through the pinned v4 adapter, its data
  // abi.encode(currencyIn, PathKey[]), swapped hop by hop from the proof's withdrawn value (head word 11) less the fee
  // (word 17) at each pool's `exec`, the token checked; null where the swap fails (below minOut), which the pool lands
  // as a withdraw and answers `_bought` false (card pool-evm-buy-pays-revert). The gas as main's pool spends it
  // (PrivacyPoolSimple.buy; review of a2d82dc6, L5): past the model's release (BUY_RELEASE_GAS), below BUY_SWAP_GAS +
  // BUY_FAIL_GAS + 1,000 the buy reverts SwapGasTooLow; the swap's call is given all the gas but BUY_FAIL_GAS, at most
  // all but one 64th (EIP-150), and each hook sees that gas, never the transaction's
  function buyRun(d: string, ctx0: SimCtx, overridden: Set<string>): bigint | null | typeof SWAP_GAS_TOO_LOW {
    const left = ctx0.gas - BUY_RELEASE_GAS;
    if (left < BUY_SWAP_GAS + BUY_FAIL_GAS + 1000n) return SWAP_GAS_TOO_LOW;
    const ctx = { ...ctx0, gas: left - BUY_FAIL_GAS < left - left / 64n ? left - BUY_FAIL_GAS : left - left / 64n };
    const w = (i: number) => BigInt("0x" + d.slice(8 + 64 * i, 72 + 64 * i));
    const b = Number(w(18)) / 32;
    const [adapter, minOut, token] = ["0x" + W(w(b)).slice(24), w(b + 2), "0x" + W(w(b + 3)).slice(24)];
    void adapter; // the model's pool swaps through any adapter: only the evidence's own check refuses another
    const at = b + Number(w(b + 1)) / 32 + 1; // the data's first word
    const arr = at + Number(w(at + 1)) / 32;
    const n = Number(w(arr));
    let [from, got] = ["0x" + W(w(at)).slice(24), w(11) - w(17)];
    for (let i = 0; i < n; i++) {
      const e = arr + 1 + Number(w(arr + 1 + i)) / 32;
      const [cur, fee, ts, hooks] = ["0x" + W(w(e)).slice(24), Number(w(e + 1)), Number(w(e + 2)), "0x" + W(w(e + 3)).slice(24)];
      const k = keyOf(cur, from, fee, ts, hooks);
      const p = byPid.get(pidOf({ ...k, currency0: k.currency0.toLowerCase(), currency1: k.currency1.toLowerCase(), hooks: k.hooks.toLowerCase() }));
      if (p === undefined) return null;
      const next = p.key.hooks !== NATIVE && overridden.has(p.key.hooks) ? (p.neutral !== undefined ? p.neutral(got, ctx) : p.give(got)) : p.exec !== undefined ? p.exec(got, { ...ctx, over: overridden, dir: "buy" }) : p.key.hooks !== NATIVE && p.lie !== undefined ? p.lie(got) : p.give(got);
      if (next === null) return erred(p, ctx, overridden);
      [from, got] = [cur, next];
    }
    assert.equal(from, token.toLowerCase(), "the route buys the Buy's token");
    return got < minOut ? null : got;
  }
  // W's own sell through SellDelegate (card evm-quote-exec-sim), W's code the delegate's 7702 designator: nonce() is 0;
  // sell(sell, fee, signature) swaps hop by hop from the token at each pool's `exec`, reverts below minOut, and returns
  // what W gained (the sim pool's code returns msg.value)
  function simSell(d: string, o: Record<string, { code: string }>, ctx: SimCtx, overridden: Set<string>): bigint | null {
    assert.ok(o[SELL_W]!.code.startsWith("0xef0100"), "W's code is a 7702 designator");
    if (d.startsWith("affed0e0")) return 0n;
    assert.ok(d.startsWith(SEL_SELL), d.slice(0, 8));
    const h = d.slice(8);
    const w = (i: number) => BigInt("0x" + h.slice(64 * i, 64 * i + 64));
    const t = Number(w(0)) / 32; // the tuple's first word
    // the 11-field Sell (card pool-review-3): feeRecipient at 8, deadline at 9
    const [token, amount, minOut, pool, feeRecipient, deadline] = ["0x" + W(w(t)).slice(24), w(t + 1), w(t + 4), "0x" + W(w(t + 5)).slice(24), "0x" + W(w(t + 8)).slice(24), w(t + 9)];
    if (ctx.block === undefined) {
      assert.equal(pool, sellMod.EVM_SELL_SIM, "a sim's pool is EVM_SELL_SIM");
      assert.equal(feeRecipient, sellMod.EVM_SELL_SIM, "a sim's fee recipient is EVM_SELL_SIM");
      assert.ok(o[sellMod.EVM_SELL_SIM] !== undefined && deadline === BigInt(T), "into the sim pool, at the block's own time");
    } else {
      // a replay of the real sale (card evm-sell-hook-converge): into the chain's pool, its fee to the FeeCollector
      assert.deepEqual([pool, feeRecipient], [SALE_POOL, SALE_COLLECTOR], "a replay is the real sale's own call");
    }
    const at = t + Number(w(t + 3)) / 32 + 1; // the route's bytes: abi.encode(PathKey[])
    const n = Number(w(at + 1));
    let [from, got] = [token, amount];
    for (let i = 0; i < n; i++) {
      const e = at + 2 + Number(w(at + 2 + i)) / 32;
      const [cur, fee, ts, hooks] = ["0x" + W(w(e)).slice(24), Number(w(e + 1)), Number(w(e + 2)), "0x" + W(w(e + 3)).slice(24)];
      const k = keyOf(cur, from, fee, ts, hooks);
      const p = byPid.get(pidOf({ ...k, currency0: k.currency0.toLowerCase(), currency1: k.currency1.toLowerCase(), hooks: k.hooks.toLowerCase() }));
      if (p === undefined) return null;
      // a pool whose hook the call replaces with the no-op hook pays as it does with no hook (`neutral`, else `give`)
      const next = p.key.hooks !== NATIVE && overridden.has(p.key.hooks) ? (p.neutral !== undefined ? p.neutral(got, ctx) : p.give(got)) : p.exec !== undefined ? p.exec(got, { ...ctx, over: overridden, dir: "sell" }) : p.key.hooks !== NATIVE && p.lie !== undefined ? p.lie(got) : p.give(got);
      if (next === null) return erred(p, ctx, overridden);
      [from, got] = [cur, next];
    }
    return got < minOut ? null : got;
  }
}
// An eth_call's context as geth runs one (internal/ethapi TransactionArgs, core/state_transition.go): no `from` is the
// zero address as tx.origin and msg.sender; no `gas` is the provider's cap (publicnode's 50,000,000); no fee fields are
// tx.gasprice 0; with fees, maxFeePerGas under the block's base fee is refused, tx.gasprice is min(maxFee, base fee +
// tip), and the sender's balance (its own at the block, or a state override's) must cover gas x maxFeePerGas. A string
// is the node's refusal.
type CallArgs = { from?: string; gas?: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
const GAS_CAP = 50_000_000n;
function simCtx(a: CallArgs, o: Record<string, { balance?: string }>, balances: Record<string, bigint>): SimCtx | string {
  const from = (a.from ?? NATIVE).toLowerCase();
  const gas = a.gas !== undefined ? BigInt(a.gas) : GAS_CAP;
  const maxFee = a.maxFeePerGas !== undefined ? BigInt(a.maxFeePerGas) : a.gasPrice !== undefined ? BigInt(a.gasPrice) : 0n;
  const tip = a.maxPriorityFeePerGas !== undefined ? BigInt(a.maxPriorityFeePerGas) : maxFee;
  if (maxFee === 0n && tip === 0n) return { origin: from, sender: from, gas, gasPrice: 0n };
  if (maxFee < BASE_FEE) return "max fee per gas less than block base fee";
  const gasPrice = maxFee < BASE_FEE + tip ? maxFee : BASE_FEE + tip;
  const set = Object.entries(o).find(([k]) => k.toLowerCase() === from)?.[1]?.balance;
  if ((set !== undefined ? BigInt(set) : (balances[from] ?? 0n)) < gas * maxFee) return "insufficient funds for gas * price + value";
  return { origin: from, sender: from, gas, gasPrice };
}
const SEL_SELL = Buffer.from(keccak_256(new TextEncoder().encode("sell((address,uint256,address,bytes,uint256,address,uint256,uint256,address,uint256,uint256),uint256,bytes)"))).toString("hex").slice(0, 8);
/** The scan provider: its head, and the Initialize logs of `pools` at `at`; `asked` keeps each getLogs range. */
/** `orSpan`: the most blocks a request with more than one value in a topic position may span, as Robinhood's RPC
 *  answers (-32602 "only 100000 are allowed for this request"). */
function scanner(headNo: number, logs: { key: EvmPoolKey; at: number }[], asked: [number, number][] = [], orSpan = Infinity): EvmRpc {
  const all = logs.map((l) => ({ ...l, topics: [null, "0x" + pidOf(l.key), "0x" + W(BigInt(l.key.currency0)), "0x" + W(BigInt(l.key.currency1))] }));
  return async (calls) =>
    calls.map((c, id) => {
      if (c.method === "eth_blockNumber") return { jsonrpc: "2.0", id, result: "0x" + headNo.toString(16) };
      // a block by number, as the chain's (the model's every block has the hash NEW), up to the scan provider's head
      if (c.method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id, result: Number(c.params[0]) <= headNo ? head(c.params[0] as string) : null };
      assert.equal(c.method, "eth_getLogs");
      const f = c.params[0] as { address: string; fromBlock: string; toBlock: string; topics: (string | string[] | null)[] };
      const [a, b] = [Number(f.fromBlock), Number(f.toBlock)];
      asked.push([a, b]);
      if (f.topics.some(Array.isArray) && b - a + 1 > orSpan) return { jsonrpc: "2.0", id, error: { code: -32602, message: `query spans ${b - a + 1} blocks, but only ${orSpan} are allowed for this request` } };
      const result = all
        // as eth_getLogs filters: topic 1 is the pool id, 2 currency0, 3 currency1; a null or missing topic matches any,
        // a list matches any of its topics
        .filter((l) => l.at >= a && l.at <= b && f.topics.every((t, i) => i === 0 || t === null || t === undefined || (Array.isArray(t) ? t.includes(l.topics[i]!) : t === l.topics[i])))
        .map((l) => ({
          address: f.address, // the PoolManager the filter names, as a node filters by address
          blockNumber: "0x" + l.at.toString(16),
          topics: ["0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438", "0x" + pidOf(l.key), "0x" + W(BigInt(l.key.currency0)), "0x" + W(BigInt(l.key.currency1))],
          data: "0x" + W(BigInt(l.key.fee)) + W(BigInt(l.key.tickSpacing)) + W(BigInt(l.key.hooks)) + W(1n << 96n) + W(0n),
        }));
      return { jsonrpc: "2.0", id, result };
    });
}
// the route the helper sends: the standard 1% pool someone seeded at a tenth of the price
const seededRoute = (token: string): EvmRoute => ({ venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 10000, tickSpacing: 200, hooks: NATIVE, hookData: "0x" }] });
const seeded = (token: string): ModelPool => ({ key: keyOf(token, NATIVE, 10000, 200, NATIVE), give: (a) => a / 10n });
// the token's real pool, behind a hook the device has not pinned: the full price with its hook replaced
const real = (token: string, lie?: (a: bigint) => bigint): ModelPool => ({ key: keyOf(token, NATIVE, 0, 60, UNPINNED), give: (a) => a, lie });
const quoteOn = (pools: ModelPool[], token: string, route: EvmRoute, scan?: EvmRpc, hints?: EvmPoolKey[], chainName: "base" | "robinhood" = "base", headNo = 5_000_000) =>
  verdict(
    evmPoolBuyQuoteWith({ chain: chainName, token, amountIn: AMOUNT, slippageBps: 100, route, ...(hints ? { pools: hints } : {}) } as EvmPoolBuyQuoteRequest, [chain(pools, 0, headNo), chain(pools, 1, headNo)], NOW, scan),
  );
const below = { accepted: false, code: "below_reference" };

test("N1a a seeded standard pool is held to the token's real pool the device's own scan found", async () => {
  const token = "0x00000000000000000000000000000000000a11a1";
  const pools = [seeded(token), real(token)];
  // without the scan nothing the device reads holds the seeded pool: it is its own reference
  assert.equal((await quoteOn(pools, token, seededRoute(token))).accepted, true);
  const asked: [number, number][] = [];
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, [{ key: real(token).key, at: 4_500_000 }], asked)), below);
  // the first scan reads 1M blocks back in Base's 10k spans; the next one only from where it stopped
  assert.equal(Math.min(...asked.map((x) => x[0])), 4_000_001);
  assert.equal(asked.length, 2 * 100);
  asked.length = 0;
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_010, [], asked), undefined, "base", 5_000_010), below);
  assert.deepEqual(asked, [[5_000_001, 5_000_010], [5_000_001, 5_000_010]]);
  // a scan provider that answers no logs refuses the quote: a source that fails is not skipped
  const broken: EvmRpc = async (calls) => calls.map((c, id) => (c.method === "eth_blockNumber" ? { jsonrpc: "2.0", id, result: "0x4c4b40" } : { jsonrpc: "2.0", id, error: { code: -32701, message: "exceed maximum block range: 50000" } }));
  assert.deepEqual(await quoteOn(pools, "0x00000000000000000000000000000000000a22a2", seededRoute("0x00000000000000000000000000000000000a22a2"), broken), { accepted: false, code: "rpc_error" });
});

test("card evm-quote-head-watch: a scan provider that fails a full span (a timeout, too many logs) is asked by halves, and the real pool it finds still holds a seeded one", async () => {
  const token = "0x00000000000000000000000000000000000e71e7";
  const pools = [seeded(token), real(token)];
  const asked: [number, number][] = [];
  const inner = scanner(5_000_000, [{ key: real(token).key, at: 4_500_000 }], asked);
  // base-rpc.publicnode.com, 2026-11-04 10:50Z: a 50,000-block span of USDC's logs took up to 10.8 s, past the timeout
  const slow: EvmRpc = async (calls) => {
    const f = calls[0]!.params[0] as { fromBlock?: string; toBlock?: string };
    if (calls[0]!.method === "eth_getLogs" && Number(f.toBlock) - Number(f.fromBlock) + 1 > 2_500) throw new Error("The operation was aborted due to timeout");
    return inner(calls);
  };
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), slow), below);
  assert.ok(asked.length > 0 && asked.every(([a, b]) => b - a + 1 <= 2_500), "every answered request is a quarter or an eighth of a span");
  // a span answered with more logs than SCAN_MAX_LOGS is asked by halves too (its getLogs answers only: the block each
  // request asks for beside them is answered as it is, so the cap alone sends the request to its halves). The span
  // holding the real pool's block: a provider full for every span would hold more pools than a quote reads, and its
  // halves end past an honest split (SCAN_SHORT_LEVEL)
  const token2 = "0x00000000000000000000000000000000000e72e7";
  const pools2 = [seeded(token2), real(token2)];
  const inner2 = scanner(5_000_000, [{ key: real(token2).key, at: 4_500_000 }]);
  const full: EvmRpc = async (calls) => {
    const f = calls[0]!.params[0] as { fromBlock?: string; toBlock?: string };
    const out = await inner2(calls);
    return calls[0]!.method === "eth_getLogs" && Number(f.fromBlock) <= 4_500_000 && Number(f.toBlock) >= 4_500_000 && Number(f.toBlock) - Number(f.fromBlock) + 1 > 5_000 ? out.map((o, i) => (calls[i]!.method === "eth_getLogs" ? { ...(o as object), result: new Array(10_001).fill(null) } : o)) : out;
  };
  assert.deepEqual(await quoteOn(pools2, token2, seededRoute(token2), full), below);
});

test("card evm-quote-head-watch: the agreed block is picked once the token's scan has its logs, so the reads land at a block no older than the scan", async () => {
  const token = "0x00000000000000000000000000000000000e73e7";
  const pools = [seeded(token), real(token)];
  const order: string[] = [];
  const inner = scanner(5_000_000, [{ key: real(token).key, at: 4_500_000 }]);
  const scan: EvmRpc = async (calls) => {
    const out = await inner(calls);
    if (calls[0]!.method === "eth_getLogs") order.push("logs");
    return out;
  };
  const watched = (rpc: EvmRpc): EvmRpc => async (calls) => {
    if (calls.some((c) => c.method === "eth_getBlockByNumber" && c.params[0] === "latest")) order.push("head");
    return rpc(calls);
  };
  const v = await verdict(
    evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) } as EvmPoolBuyQuoteRequest, [watched(chain(pools, 0)), watched(chain(pools, 1))], NOW, scan),
  );
  assert.deepEqual(v, below);
  assert.equal(order.filter((x) => x === "logs").length, 100);
  assert.ok(order.lastIndexOf("logs") < order.indexOf("head"), `the heads after every log read: ${order.join(" ")}`);
});

test("card evm-quote-head-watch: a scan that ends more than maxLag blocks behind the agreed block is scanned on up to it, and a pool made in those blocks still holds a seeded one", async () => {
  const token = "0x00000000000000000000000000000000000c44c4";
  const pools = [seeded(token), real(token)];
  const asked: [number, number][] = [];
  // the scan provider's head 4,999,900, 100 blocks behind the agreed 5,000,000 (Base's maxLag 50); the real pool at 4,999,950
  const late = scanner(4_999_900, [{ key: real(token).key, at: 4_999_950 }], asked);
  const caught = scanner(5_000_000, [{ key: real(token).key, at: 4_999_950 }], asked);
  // the catch-up's requests, each with the agreed block by number in its batch, reach a backend that holds it (the
  // scan's newest request asks its own head, 4,999,900, in its batch: card evm-scan-second-provider)
  let pinned = 0;
  const both: EvmRpc = (calls) => (calls.some((c) => c.method === "eth_getBlockByNumber" && Number(c.params[0]) === 5_000_000) && ++pinned > 0 ? caught(calls) : late(calls));
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), both), below);
  assert.equal(pinned, 1, "the catch-up request carries the agreed block");
  assert.deepEqual(asked.slice(-2), [[4_999_901, 5_000_000], [4_999_901, 5_000_000]]);
});

test("review of 4830f1f, H1: a scan backend more than maxLag behind that answers [] past its own head refuses as main did, and never keeps a scan its provider did not name", async () => {
  const token = "0x00000000000000000000000000000000000e74e7";
  const pools = [seeded(token), real(token)];
  const full = scanner(4_999_900, [{ key: real(token).key, at: 4_999_950 }]);
  // a backend at 4,999,900: logs past it are not there yet, answered as [] with no error
  const lagging: EvmRpc = async (calls) => {
    const out = (await full(calls)) as { result?: unknown }[];
    return out.map((o, i) => (calls[i]!.method !== "eth_getLogs" ? o : { ...o, result: (o.result as { blockNumber: string }[]).filter((l) => Number(l.blockNumber) <= 4_999_900) }));
  };
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), lagging), { accepted: false, code: "rpc_disagree" });
  // the next quote, the scan backend caught up and honest: the real pool holds the seeded route
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_002, [{ key: real(token).key, at: 4_999_950 }]), undefined, "base", 5_000_002), below);
});

test("review of 4830f1f, H2: 16,384 pools only initialized, with ids ground below the real pool's, are read and hold nothing, so the real pool holds a seeded route (card evm-quote-one-round: the empty pools no longer refuse)", async () => {
  const token = "0x00000000000000000000000000000000000e75e7";
  const pools = [seeded(token), real(token)];
  const realId = pidOf(real(token).key);
  const logs: { key: EvmPoolKey; at: number }[] = [{ key: real(token).key, at: 4_500_000 }];
  for (let fee = 1, n = 0; n < 16_384; fee++) {
    if (fee === 100 || fee === 500 || fee === 3000 || fee === 10000) continue;
    const k = keyOf(token, NATIVE, fee, 7, NATIVE);
    if (pidOf(k) < realId) logs.push({ key: k, at: 4_100_000 + 40 * n++ });
  }
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs)), below);
});

test("review of 4830f1f, L: a scan head more than a span behind the agreed block refuses before any catch-up request; a span answered at exactly SCAN_MAX_LOGS is asked by halves", async () => {
  const token = "0x00000000000000000000000000000000000e76e7";
  const pools = [seeded(token), real(token)];
  const asked: [number, number][] = [];
  // a scan provider that names block 1, then the agreed block when asked again
  const stale = scanner(1, [], asked);
  const fresh = scanner(5_000_000, [], asked);
  let heads = 0;
  const jump: EvmRpc = (calls) => (calls[0]!.method === "eth_blockNumber" && heads++ > 0 ? fresh(calls) : stale(calls));
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), jump), { accepted: false, code: "rpc_disagree" });
  assert.ok(asked.length <= 2, `${asked.length} requests`);
  const token2 = "0x00000000000000000000000000000000000e77e7";
  const pools2 = [seeded(token2), real(token2)];
  const inner = scanner(5_000_000, [{ key: real(token2).key, at: 4_500_000 }]);
  // a provider that cuts an answer at the cap: the real pool's log is past the cut (the span holding its block, as above)
  const capped: EvmRpc = async (calls) => {
    const f = calls[0]!.params[0] as { fromBlock?: string; toBlock?: string };
    const out = await inner(calls);
    return calls[0]!.method === "eth_getLogs" && Number(f.fromBlock) <= 4_500_000 && Number(f.toBlock) >= 4_500_000 && Number(f.toBlock) - Number(f.fromBlock) + 1 > 5_000 ? out.map((o, i) => (calls[i]!.method === "eth_getLogs" ? { ...(o as object), result: new Array(10_000).fill(null) } : o)) : out;
  };
  assert.deepEqual(await quoteOn(pools2, token2, seededRoute(token2), capped), below);
});

test("N1b a seeded standard pool is held to the token's real pool the caller lists", async () => {
  const token = "0x00000000000000000000000000000000000b11b1";
  assert.deepEqual(await quoteOn([seeded(token), real(token)], token, seededRoute(token), undefined, [real(token).key]), below);
});

test("N1c a seeded standard pool is held to the token's real pool of a pinned shape", async () => {
  const token = "0x00000000000000000000000000000000000c11c1";
  const clanker: ModelPool = { key: keyOf(token, WETH, 0x800000, 200, CLANKER), give: (a) => a };
  assert.deepEqual(await quoteOn([seeded(token), clanker], token, seededRoute(token)), below);
});

test("N1d a listed pool the PoolManager does not hold is dropped, and one only one provider holds is refused", async () => {
  const token = "0x00000000000000000000000000000000000d11d1";
  // listed, quoted by the quoter as the full price, but not in the PoolManager: no candidate
  const ghost: ModelPool = { ...real(token), key: real(token).key };
  const pools = [seeded(token)];
  const q = await quoteOn(pools, token, seededRoute(token), undefined, [ghost.key]);
  assert.equal(q.accepted, true, String((q as { code?: string }).code));
  // malformed or of another token: dropped
  const other = keyOf("0x00000000000000000000000000000000000e11e1", NATIVE, 0, 60, UNPINNED);
  assert.equal((await quoteOn(pools, token, seededRoute(token), undefined, [other, { ...real(token).key, tickSpacing: 0 }, null as unknown as EvmPoolKey])).accepted, true);
  // held with no price, or with no liquidity: dropped
  assert.equal((await quoteOn([seeded(token), { ...real(token), state: [5n << 160n, 10n ** 20n] }], token, seededRoute(token), undefined, [real(token).key])).accepted, true);
  assert.equal((await quoteOn([seeded(token), { ...real(token), state: [1n << 100n, 1n << 128n] }], token, seededRoute(token), undefined, [real(token).key])).accepted, true);
  // a pool behind a pinned hook, which the prune never drops, held with no price: dropped all the same
  const pinned: ModelPool = { key: keyOf(token, NATIVE, 0x800000, 200, CLANKER), give: (a) => a, state: [5n << 160n, 10n ** 20n] };
  assert.equal((await quoteOn([seeded(token), pinned], token, seededRoute(token), undefined, [pinned.key])).accepted, true);
  assert.deepEqual(await quoteOn([seeded(token), real(token)], token, seededRoute(token), undefined, [real(token).key]), below);
  // held by one provider only: the two disagree, and nothing is trusted
  assert.deepEqual(await quoteOn([seeded(token), { ...real(token), only: 0 }], token, seededRoute(token), undefined, [real(token).key]), { accepted: false, code: "rpc_disagree" });
});

test("N1e a found pool's unpinned hook cannot raise the reference: it is read with the hook replaced", async () => {
  const token = "0x00000000000000000000000000000000000f11f1";
  // the honest route: a standard pool at the full price; a found pool whose hook would quote a thousand times more
  const honest: ModelPool = { key: keyOf(token, NATIVE, 10000, 200, NATIVE), give: (a) => a };
  const liar = { ...real(token, (a: bigint) => 1000n * a), give: (a: bigint) => a / 2n };
  const q = await quoteOn([honest, liar], token, seededRoute(token), undefined, [liar.key]);
  assert.equal(q.accepted, true, String((q as { code?: string }).code));
});

test("N1f on Robinhood a seeded native pool is held to the token's WETH launchpad pool (Doppler's second shape)", async () => {
  const token = "0x00000000000000000000000000000000000f22f2";
  const doppler: ModelPool = { key: keyOf(token, RH_WETH, 0x800000, 200, "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544"), give: (a) => a };
  const r = await verdict(evmPoolBuyQuoteWith({ chain: "robinhood", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain([seeded(token), doppler], 0), chain([seeded(token), doppler], 1)], NOW));
  assert.deepEqual(r, below);
});

const DOPPLER = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";
const dopplerRoute = (token: string): EvmRoute => ({ venue: "uniswap-v4", currencyIn: RH_WETH, hops: [{ currency: token, fee: 0x800000, tickSpacing: 200, hooks: DOPPLER, hookData: "0x" }] });
const onRobinhood = (pools: ModelPool[], token: string, route: EvmRoute) =>
  evmPoolBuyQuoteWith({ chain: "robinhood", token, amountIn: AMOUNT, slippageBps: 100, route }, [chain(pools, 0), chain(pools, 1)], NOW);

test("N3a on Robinhood a token whose WETH pool beats every native pool is bought through WETH", async () => {
  const token = "0x00000000000000000000000000000000000f33f3";
  // the native pool quotes a tenth of the WETH launchpad pool
  const doppler: ModelPool = { key: keyOf(token, RH_WETH, 0x800000, 200, DOPPLER), give: (a) => a };
  const q = await onRobinhood([seeded(token), doppler], token, dopplerRoute(token));
  assert.ok(q.route.venue === "uniswap-v4" && q.route.currencyIn === RH_WETH, JSON.stringify(q.route));
  assert.equal(q.amountOut, AMOUNT);
  assert.equal(q.reference?.amountOut, AMOUNT, "R is the WETH route itself");
});

test("N3b on Robinhood a WETH route not strictly better than the best native route refuses native_first", async () => {
  const token = "0x00000000000000000000000000000000000f44f4";
  const native: ModelPool = { key: keyOf(token, NATIVE, 10000, 200, NATIVE), give: (a) => a };
  for (const give of [(a: bigint) => a, (a: bigint) => a - a / 1000n]) {
    // equal to the native route, then a tenth of a percent below it
    const doppler: ModelPool = { key: keyOf(token, RH_WETH, 0x800000, 200, DOPPLER), give };
    await assert.rejects(onRobinhood([native, doppler], token, dopplerRoute(token)), (e: unknown) => {
      assert.ok(e instanceof EvmQuoteError && e.code === "native_first", String(e));
      assert.ok(e.reference?.route.venue === "uniswap-v4" && e.reference.route.currencyIn === NATIVE);
      assert.equal(e.reference.amountOut, AMOUNT);
      return true;
    });
  }
});

const QUOTER_V4 = "0x0d5e0f971ed27fbff6c2837bf31316121532048d"; // Base's pinned V4Quoter
/** chain(), plus what eth_call does when a call's state override replaces the V4Quoter's code with the no-op hook:
 *  every quote in that aggregate3 call runs the no-op, which returns 64 bytes, the called selector then a zero word. */
function chainWithOverrides(pools: ModelPool[], who: 0 | 1): EvmRpc {
  const inner = chain(pools, who);
  return async (calls) => {
    const out = (await inner(calls)) as { result?: string }[];
    return out.map((a, i) => {
      const c = calls[i]!;
      const o = (c.params[2] as Record<string, unknown> | undefined) ?? {};
      if (c.method !== "eth_call" || !Object.keys(o).some((k) => k.toLowerCase() === QUOTER_V4)) return a;
      const n = decodeAggregate((c.params[0] as { data: string }).data).length;
      return { ...a, result: encodeAggregate(Array.from({ length: n }, () => 0xca253dc9n << 224n)) };
    });
  };
}

test("S1 a listed pool whose hook is the V4Quoter knocks out every scanned unpinned-hook pool: the seeded pool is its own reference", async () => {
  const token = "0x00000000000000000000000000000000000a33a3";
  const pools = [seeded(token), real(token)];
  // the helper's hint: a pool that does not exist, of the token with the native asset, whose 'hook' is the quoter
  const bogus = keyOf(token, NATIVE, 0, 60, QUOTER_V4);
  const q = (hints?: EvmPoolKey[]) =>
    verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token), ...(hints ? { pools: hints } : {}) } as EvmPoolBuyQuoteRequest, [chainWithOverrides(pools, 0), chainWithOverrides(pools, 1)], NOW, scanner(5_000_000, [{ key: real(token).key, at: 4_500_000 }])));
  assert.deepEqual(await q(), below, "control: the scan holds the seeded pool to the real one");
  const v = await q([bogus]);
  assert.deepEqual(v, below, "one bogus hint removes the real pool from R");
});

test("S2 one scan-provider head ahead of the chain hides the scanned real pool, for that quote and every later one", async () => {
  const token = "0x00000000000000000000000000000000000a44a4";
  const pools = [seeded(token), real(token)];
  const logs = [{ key: real(token).key, at: 4_500_000 }];
  const first = await quoteOn(pools, token, seededRoute(token), scanner(2 ** 40, logs));
  const later = await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs));
  // a scan provider whose head is more than maxLag from the agreed block is refused, and nothing it read is kept
  assert.deepEqual(first, { accepted: false, code: "rpc_disagree" }, "the quote whose scan head is 2^40");
  assert.deepEqual(later, below, "a later quote with an honest scan provider");
});

// the model's slot0 (a sqrtPrice of 2^100) with the liquidity a test sets
const DEEP_PRICE = (1n << 100n) | (5n << 160n);
const ZORA = "0x1111111111166b7fe7bd91427724b487980afc69"; // stand-in for ZORA on Base (the model does not depend on it)
const ZORA_HOOK = "0x0469a4bd3724dc86c9542f4694c976da13c450c0"; // pinned Zora hook
// X's market with the native asset: a pool of a shape no standard route reads, found only by X's own scan
const marketOf = (x: string): ModelPool => ({ key: keyOf(x, NATIVE, 2500, 50, NATIVE), give: (a) => a });
/** The seeded route's verdict for `token`, whose real pool pairs with `x` through `hook` and tick spacing `ts`, with
 *  and without x's market. */
async function xCase(token: string, x: string, hook: string, ts: number, chainName: "base" | "robinhood") {
  const real: ModelPool = { key: keyOf(token, x, 0x800000, ts, hook), give: (a) => a };
  const market = marketOf(x);
  const logs = [{ key: real.key, at: 4_500_000 }, { key: market.key, at: 4_100_000 }];
  const req = { chain: chainName, token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) };
  const pools = [seeded(token), real, market];
  return evmPoolBuyQuoteWith(req, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs));
}
const heldTo = (x: string) => (e: unknown) => {
  assert.ok(e instanceof EvmQuoteError && e.code === "below_reference", String(e));
  const r = e.reference?.route;
  assert.ok(r?.venue === "uniswap-v4" && r.currencyIn === NATIVE && r.hops.length === 2 && r.hops[0]!.currency === x.toLowerCase(), JSON.stringify(r));
  assert.equal(e.reference!.amountOut, AMOUNT);
  return true;
};
test("S3 a Zora coin whose real pool pairs with ZORA is held to it through ZORA's own market; with no market it adds nothing", async () => {
  await assert.rejects(xCase("0x00000000000000000000000000000000000a55a5", ZORA, ZORA_HOOK, 200, "base"), heldTo(ZORA));
  // another coin and currency: the real pool, and no market of its currency
  const token = "0x00000000000000000000000000000000000a56a5";
  const lone = "0x2222222222266b7fe7bd91427724b487980afc69";
  const real: ModelPool = { key: keyOf(token, lone, 0x800000, 200, ZORA_HOOK), give: (a) => a };
  assert.equal((await quoteOn([seeded(token), real], token, seededRoute(token), scanner(5_000_000, [{ key: real.key, at: 4_500_000 }]))).accepted, true);
});

const RH_X = "0x4a0e650000000000000000000000000000005eea"; // stand-in for Robinhood's 0x4a0e65…5eea
test("S3b on Robinhood a Doppler /8 token paired with another currency is held to it through that currency's market; with none it adds nothing", async () => {
  await assert.rejects(xCase("0x00000000000000000000000000000000000a66a6", RH_X, "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544", 8, "robinhood"), heldTo(RH_X));
  const token = "0x00000000000000000000000000000000000a67a6";
  const lone = "0x4a0e660000000000000000000000000000005eea";
  const real: ModelPool = { key: keyOf(token, lone, 0x800000, 8, "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544"), give: (a) => a };
  assert.equal((await quoteOn([seeded(token), real], token, seededRoute(token), scanner(5_000_000, [{ key: real.key, at: 4_500_000 }]), undefined, "robinhood")).accepted, true);
});

test("S1c each override replaces one hook, only in reads of that hook's pools, and only for a pool the PoolManager holds", async () => {
  const token = "0x00000000000000000000000000000000000a77a7";
  const H2 = "0x00000000000000000000000000000000000030cc";
  const GHOST = "0x00000000000000000000000000000000000040cc";
  const second: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, H2), give: (a) => a / 2n };
  const pools = [seeded(token), real(token), second];
  const seen: Overridden[] = [];
  const ghost = keyOf(token, NATIVE, 500, 10, GHOST);
  const v = await verdict(
    evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token), pools: [second.key, ghost] } as EvmPoolBuyQuoteRequest, [chain(pools, 0, 5_000_000, seen), chain(pools, 1, 5_000_000, seen)], NOW, scanner(5_000_000, [{ key: real(token).key, at: 4_500_000 }])),
  );
  assert.deepEqual(v, below);
  assert.deepEqual([...new Set(seen.flatMap((o) => o.replaces))].sort(), [UNPINNED, H2].sort(), "the held pools' hooks only: never the pool that does not exist");
  // every address an override replaces is a hook of each read under it
  for (const o of seen) for (const hs of o.hooks) for (const r of o.replaces) assert.ok(hs.includes(r), `a read of hooks ${hs} under an override of ${r}`);
});

test("S1d a route whose hook is an address the quote calls is refused before any read", async () => {
  const token = "0x00000000000000000000000000000000000a88a8";
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 0, tickSpacing: 60, hooks: QUOTER_V4, hookData: "0x" }] };
  assert.deepEqual(await quoteOn([seeded(token)], token, route), { accepted: false, code: "bad_request" });
});

test("S2b a scan is kept only once the quote's block is confirmed on both providers", async () => {
  const token = "0x00000000000000000000000000000000000a99a9";
  const pools = [seeded(token), real(token)];
  const asked: [number, number][] = [];
  // provider 2 holds another block at the agreed number: the quote is refused, and the scan is not kept
  const other = chain(pools, 1);
  const forked: EvmRpc = async (calls) => {
    const out = (await other(calls)) as { result?: unknown }[];
    return out.map((a, i) => (calls[i]!.method === "eth_getBlockByNumber" && calls[i]!.params[0] !== "latest" ? { ...a, result: head("0x" + (5_000_000).toString(16), "0x" + "cc".repeat(32)) } : a));
  };
  const req = { chain: "base" as const, token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) };
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(req, [chain(pools, 0), forked], NOW, scanner(5_000_000, [{ key: real(token).key, at: 4_500_000 }], asked))), { accepted: false, code: "rpc_disagree" });
  asked.length = 0;
  // the next quote scans the whole depth again
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, [{ key: real(token).key, at: 4_500_000 }], asked)), below);
  assert.equal(Math.min(...asked.map((x) => x[0])), 4_000_001);
  assert.equal(asked.length, 2 * 100);
});

test("S3c a market whose hook is not pinned is quoted only once it exists, with its hook and the pool's replaced in one read", async () => {
  const token = "0x00000000000000000000000000000000000ab1ab";
  const x = "0x0000000000000000000000000000000000003333";
  const [MH, H2, GH] = ["0x00000000000000000000000000000000000050cc", "0x00000000000000000000000000000000000060cc", "0x00000000000000000000000000000000000070cc"];
  const market: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, MH), give: (a) => a };
  const real: ModelPool = { key: keyOf(token, x, 3000, 60, H2), give: (a) => a };
  // a market in x's scan that the PoolManager does not hold
  const ghost = keyOf(x, WETH, 500, 10, GH);
  const logs = [{ key: real.key, at: 4_500_000 }, { key: market.key, at: 4_100_000 }, { key: ghost, at: 4_000_500 }];
  const pools = [seeded(token), real, market];
  const seen: Overridden[] = [];
  await assert.rejects(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain(pools, 0, 5_000_000, seen), chain(pools, 1, 5_000_000, seen)], NOW, scanner(5_000_000, logs)), heldTo(x));
  assert.ok(seen.some((o) => o.replaces.length === 2 && o.replaces.includes(MH) && o.replaces.includes(H2)), JSON.stringify(seen));
  assert.ok(!seen.some((o) => o.replaces.includes(GH)), "no override for the market the PoolManager does not hold");
  for (const o of seen) for (const hs of o.hooks) for (const r of o.replaces) assert.ok(hs.includes(r), `a read of hooks ${hs} under an override of ${r}`);
});

test("L1 a buy through a pool behind an unpinned hook that keeps a tenth is bought at the nine tenths it pays, never at its hookless price (card evm-buy-hook-converge: before it, refused no_exit)", async () => {
  const token = "0x00000000000000000000000000000000000ac1ac";
  // the route's pool keeps a tenth through its hook; a standard pool gives half
  const hooked: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => a, lie: (a) => a - a / 10n };
  const half: ModelPool = { key: keyOf(token, NATIVE, 10000, 200, NATIVE), give: (a) => a / 2n };
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 3000, tickSpacing: 60, hooks: UNPINNED, hookData: "0x" }] };
  // found by the scan and listed by the caller too (card evm-route-parity: before it, this bought at 0.9 x)
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route, pools: [hooked.key] }, [chain([hooked, half], 0), chain([hooked, half], 1)], NOW, scanner(5_000_000, [{ key: hooked.key, at: 4_500_000 }])));
  assert.deepEqual(v, { accepted: true, amountOut: AMOUNT - AMOUNT / 10n, minOut: ((AMOUNT - AMOUNT / 10n) * 9900n) / 10000n, block: 5_000_000n });
});

test("L1b a buy whose route passes the native asset in its middle is refused before any read: its sell could not leave through it (no_exit)", async () => {
  const token = "0x00000000000000000000000000000000000ac1ad";
  const x = xAt(0x1b1);
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: x, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" }, { currency: NATIVE, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" }, { currency: token, fee: 3000, tickSpacing: 60, hooks: UNPINNED, hookData: "0x" }] };
  assert.deepEqual(await quoteOn([seeded(token)], token, route), { accepted: false, code: "no_exit" });
});

// a buy from the token's standard 1% native pool, the best route, against pools of other currencies
const bestRoute = (token: string): EvmRoute => ({ venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 10000, tickSpacing: 200, hooks: NATIVE, hookData: "0x" }] });
// a state whose spot price lets a pool that currency0 pays into give `r` times the amount (the model's bound: chain())
const isqrt = (n: bigint) => {
  let [x, y] = [n, (n + 1n) / 2n];
  while (y < x) [x, y] = [y, (y + n / y) / 2n];
  return x;
};
const pricedAt = (r: bigint, liquidity = 10n ** 20n): [bigint, bigint] => [isqrt(r << 192n) + 1n, liquidity];
// and one that a pool's currency1 pays into, `r` times the amount
const pricedInto1 = (r: bigint, liquidity = 10n ** 20n): [bigint, bigint] => [isqrt((1n << 192n) / r), liquidity];
const best = (token: string): ModelPool => ({ key: keyOf(token, NATIVE, 10000, 200, NATIVE), give: (a) => 10n * a, state: pricedAt(10n) });
const xAt = (i: number) => "0x" + (0xe000 + i).toString(16).padStart(40, "0");

test("K1 a coin paired only with the token (KIMPHIL with USDG) that holds less of it than R's pool adds nothing: the buy goes through", async () => {
  const token = "0x00000000000000000000000000000000000ad1ad";
  const kimphil: ModelPool = { key: keyOf(token, xAt(0), 0x800000, 8, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 18n] };
  const v = await quoteOn([best(token), kimphil], token, bestRoute(token), scanner(5_000_000, [{ key: kimphil.key, at: 4_500_000 }]));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
});

test("K1b a pool no route from the native asset prices adds nothing, however much it reports holding: the buy goes through", async () => {
  const token = "0x00000000000000000000000000000000000ad3ad";
  // the same price as R's pool, ten thousand times its liquidity (a narrow range makes that a dust position), and no
  // market for its currency
  const kimphil: ModelPool = { key: keyOf(token, xAt(3), 0x800000, 8, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 24n] };
  const v = await quoteOn([best(token), kimphil], token, bestRoute(token), scanner(5_000_000, [{ key: kimphil.key, at: 4_500_000 }]));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
});
test("K2 a pool of X with a currency other than the native asset or WETH is not a market: it cannot raise R", async () => {
  const token = "0x00000000000000000000000000000000000ad2ad";
  const x = xAt(1);
  const y = xAt(2);
  const pair: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  // X's only other pool is with Y, at a hundred X for one Y: priced as if Y were the native asset it would raise R
  const xy: ModelPool = { key: keyOf(x, y, 3000, 60, NATIVE), give: (a) => 100n * a };
  const logs = [{ key: pair.key, at: 4_500_000 }, { key: xy.key, at: 4_400_000 }];
  const v = await quoteOn([best(token), pair, xy], token, bestRoute(token), scanner(5_000_000, logs));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
});

test("X1 nine currencies: the real one, oldest, is priced, and eight newer ones cannot push it out", async () => {
  const token = "0x00000000000000000000000000000000000ff1ff";
  const x0 = xAt(0x100);
  const real: ModelPool = { key: keyOf(token, x0, 3000, 60, NATIVE), give: (a) => a };
  const market = marketOf(x0);
  const junk = Array.from({ length: 8 }, (_, i): ModelPool => ({ key: keyOf(token, xAt(0x101 + i), 3000, 60, NATIVE), give: (a) => a / 100n }));
  const logs = [{ key: real.key, at: 4_000_100 }, { key: market.key, at: 4_050_000 }, ...junk.map((j, i) => ({ key: j.key, at: 4_500_000 + i }))];
  const pools = [seeded(token), real, market, ...junk];
  await assert.rejects(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)), heldTo(x0));
});

test("X2 seventeen currencies, the shallowest by liquidity included: each is priced through its market, and the one that gives most sets R", async () => {
  const token = "0x00000000000000000000000000000000000ff2ff";
  const deeper = Array.from({ length: 16 }, (_, i): ModelPool => ({ key: keyOf(token, xAt(0x200 + i), 3000, 60, NATIVE), give: (a) => a }));
  const x17 = xAt(0x210);
  // a hundredth of the others' liquidity, and its market a hundred times the price
  const shallow: ModelPool = { key: keyOf(token, x17, 3000, 60, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 18n] };
  const market: ModelPool = { key: keyOf(x17, NATIVE, 2500, 50, NATIVE), give: (a) => 100n * a, state: pricedAt(100n) };
  const logs = [{ key: shallow.key, at: 4_050_000 }, ...deeper.map((o, i) => ({ key: o.key, at: 4_100_000 + i })), { key: market.key, at: 4_060_000 }];
  await assert.rejects(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: bestRoute(token) }, [chain([best(token), ...deeper, shallow, market], 0), chain([best(token), ...deeper, shallow, market], 1)], NOW, scanner(5_000_000, logs)), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "below_reference", String(e));
    const r = e.reference!.route as EvmV4Route;
    assert.deepEqual(r.hops.map((h) => h.currency), [x17, token]);
    assert.equal(e.reference!.amountOut, 100n * AMOUNT);
    return true;
  });
});
test("X4 one scan request of several currencies finds the market of each, not only the first one's: the real currency, scanned last, is priced through its market", async () => {
  const token = "0x00000000000000000000000000000000000f5f4f";
  const x = xAt(0x5000);
  const real: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  // two currencies with no market, whose pools with the token have ids below the real one's, so they are scanned first
  const others: ModelPool[] = [];
  for (let i = 0; others.length < 2; i++) {
    const k = keyOf(token, xAt(0x5010 + i), 3000, 60, NATIVE);
    if (pidOf(k) < pidOf(real.key)) others.push({ key: k, give: (a) => a });
  }
  // its market of a shape only the scan finds, a hundred times the price
  const market: ModelPool = { key: keyOf(x, NATIVE, 2500, 50, NATIVE), give: (a) => 100n * a, state: pricedAt(100n) };
  const pools = [best(token), ...others, real, market];
  const logs = [...others, real, market].map((p, i) => ({ key: p.key, at: 4_100_000 + i }));
  await assert.rejects(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: bestRoute(token) }, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "below_reference", String(e));
    assert.equal(e.reference!.amountOut, 100n * AMOUNT);
    return true;
  });
});
test("X3 an X with 16,384 empty markets beside its real one is priced through the real one (card evm-quote-one-round: a bound never leaves X's markets unread)", async () => {
  const token = "0x00000000000000000000000000000000000ff7ff";
  const x = xAt(0x900);
  const pool: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 18n] };
  // as many empty markets of X as the old EVM_QUOTE_MAX_KEYS (16,384) beside its real one, at a hundred times
  const market: ModelPool = { key: keyOf(x, NATIVE, 2500, 50, NATIVE), give: (a) => 100n * a, state: pricedAt(100n) };
  const empty = Array.from({ length: 16_384 }, (_, i) => keyOf(x, NATIVE, 1000 + i, 1, NATIVE));
  const logs = [{ key: pool.key, at: 4_500_000 }, { key: market.key, at: 4_100_000 }, ...empty.map((k, i) => ({ key: k, at: 4_100_000 + 50 * i }))];
  const v = await quoteOn([best(token), pool, market], token, bestRoute(token), scanner(5_000_000, logs));
  assert.deepEqual(v, below);
});

test("T1b a crowd of 16,000 junk pools of the token still quotes its standard route and holds a seeded one to it; 20,000 empty ones too (card evm-quote-one-round)", async () => {
  const token = "0x00000000000000000000000000000000000fe5fe";
  // 16,000 pools of the token with the native asset, under EVM_QUOTE_MAX_KEYS (65,536): 15,400 empty and 600 that hold
  // a dust position, each quoted (under EVM_QUOTE_MAX_QUOTED, 1,024)
  const junk = Array.from({ length: 16_000 }, (_, i) => keyOf(token, NATIVE, 1000 + i, 1, NATIVE));
  const dust = junk.slice(0, 600).map((key): ModelPool => ({ key, give: (a) => a / 1000n }));
  // spread over the scan's depth (a span's answer holds at most 10,000 logs)
  const logs = junk.map((k, i) => ({ key: k, at: 4_000_001 + 49 * i }));
  const t = Date.now();
  const v = await quoteOn([best(token), ...dust], token, bestRoute(token), scanner(5_000_000, logs));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.ok(Date.now() - t < 30_000, `${Date.now() - t} ms`);
  // the scan is cached: a seeded route is held to the standard one
  const seeded1: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, NATIVE), give: (a) => a / 10n };
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" }] };
  assert.deepEqual(await quoteOn([best(token), seeded1, ...dust], token, route, scanner(5_000_000, logs)), below);
  // 20,000 found pools that hold nothing: each one's state is read, none is quoted, and the real route quotes
  const many = "0x00000000000000000000000000000000000e78e7";
  const crowd = Array.from({ length: 20_000 }, (_, i) => ({ key: keyOf(many, NATIVE, 1000 + i, 1, NATIVE), at: 4_000_001 + 49 * i }));
  const v2 = await quoteOn([best(many)], many, bestRoute(many), scanner(5_000_000, crowd));
  assert.equal(v2.accepted, true, String((v2 as { code?: string }).code));
  // and a seeded route among them is held to the real pool
  const seeded2: ModelPool = { key: keyOf(many, NATIVE, 3000, 60, NATIVE), give: (a) => a / 10n };
  const route2: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: many, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" }] };
  assert.deepEqual(await quoteOn([best(many), seeded2], many, route2, scanner(5_000_000, crowd)), below);
});
test("G1 every scan of one quote, the token's and each X's, shares the chain's limit of requests at once", async () => {
  const token = "0x00000000000000000000000000000000000ff3ff";
  const xs = Array.from({ length: 8 }, (_, i): ModelPool => ({ key: keyOf(token, xAt(0x700 + i), 3000, 60, NATIVE), give: (a) => a }));
  // Base's scan provider takes 20 at once in 20 spans, Robinhood's 2 in 10 (evmPoolVenues()[chain].scan)
  for (const [chainName, parallel, headNo] of [["base", 20, 5_000_000], ["robinhood", 2, 50_000_000]] as const) {
    const inner = scanner(headNo, xs.map((x, i) => ({ key: x.key, at: headNo - 900_000 + i })));
    let [now, most] = [0, 0];
    // a provider that answers after a tick, so requests sent together are in flight together
    const slow: EvmRpc = async (calls) => {
      most = Math.max(most, ++now);
      await new Promise((r) => setTimeout(r, 1));
      now--;
      return inner(calls);
    };
    const v = await quoteOn([best(token), ...xs], token, bestRoute(token), slow, undefined, chainName, headNo);
    assert.equal(v.accepted, true, `${chainName}: ${String((v as { code?: string }).code)}`);
    assert.ok(most <= parallel, `${chainName}: ${most} requests at once`);
  }
});

test("G2 an X whose scan fails refuses the quote, as the token's own scan does: nothing is priced on a partial read", () => onTestClock(async () => {
  const token = "0x00000000000000000000000000000000000ff4ff";
  const x = xAt(0x430);
  const real: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  const market = marketOf(x);
  const inner = scanner(5_000_000, [{ key: real.key, at: 4_500_000 }, { key: market.key, at: 4_100_000 }]);
  const tx = "0x" + x.slice(2).padStart(64, "0");
  // the scan provider answers the token's logs and every other scan, and fails each request for x's markets (x with the
  // native asset or WETH; HTTP 503, its only provider): a quote that went on without them would find x unpriced and
  // pass the seeded route
  const pair = ["0x" + "0".repeat(64), "0x" + WETH.slice(2).padStart(64, "0")];
  const broken: EvmRpc = async (calls) => {
    const t = calls.flatMap((c) => (c.method === "eth_getLogs" ? (c.params[0] as { topics: unknown[] }).topics.flat() : []));
    if (t.includes(tx) && t.some((x) => pair.includes(x as string))) throw new Error("the provider answered HTTP 503");
    return inner(calls);
  };
  assert.deepEqual(await quoteOn([seeded(token), real, market], token, seededRoute(token), broken), { accepted: false, code: "rpc_error" });
}));

test("G3 the scan provider's head is read once per quote: an X scan that waits behind others reads to the same head", async () => {
  const token = "0x00000000000000000000000000000000000ff5ff";
  const x = xAt(0x500);
  const real: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  const market = marketOf(x);
  const inner = scanner(5_000_000, [{ key: real.key, at: 4_500_000 }, { key: market.key, at: 4_100_000 }]);
  let heads = 0;
  // each later head a thousand blocks on, past any chain's maxLag, as a chain moves while scans wait their turn
  const moving: EvmRpc = async (calls) => {
    const out = (await inner(calls)) as { result?: unknown }[];
    return out.map((a, i) => (calls[i]!.method === "eth_blockNumber" ? { ...a, result: "0x" + (5_000_000 + 1000 * heads++).toString(16) } : a));
  };
  await assert.rejects(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain([seeded(token), real, market], 0), chain([seeded(token), real, market], 1)], NOW, moving), heldTo(x));
  assert.equal(heads, 1);
});

test("G4 an X scanned for a pool the PoolManager does not hold is kept too: the next quote reads only new blocks", async () => {
  const token = "0x00000000000000000000000000000000000ff6ff";
  // a pool of the token with x in its logs that the PoolManager does not hold (an empty pool): x is scanned before
  // the reads show it, and is not priced
  const gone = keyOf(token, xAt(0x600), 3000, 60, NATIVE);
  const asked: [number, number][] = [];
  const scan = scanner(5_000_000, [{ key: gone, at: 4_500_000 }], asked);
  assert.equal((await quoteOn([best(token)], token, bestRoute(token), scan)).accepted, true);
  await new Promise((r) => setTimeout(r, 20));
  asked.length = 0;
  assert.equal((await quoteOn([best(token)], token, bestRoute(token), scan)).accepted, true);
  assert.deepEqual(asked, [], "both scans are kept: the head has not moved, so nothing is read again");
});

test("S1e a pool the PoolManager holds whose hook is the V4Quoter is dropped: its override would replace the quoter", async () => {
  const token = "0x00000000000000000000000000000000000ae1ae";
  const best: ModelPool = { key: keyOf(token, NATIVE, 10000, 200, NATIVE), give: (a) => a };
  const trap: ModelPool = { key: keyOf(token, NATIVE, 0, 60, QUOTER_V4), give: (a) => a / 2n };
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 10000, tickSpacing: 200, hooks: NATIVE, hookData: "0x" }] };
  const seen: Overridden[] = [];
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route, pools: [trap.key] } as EvmPoolBuyQuoteRequest, [chain([best, trap], 0, 5_000_000, seen), chain([best, trap], 1, 5_000_000, seen)], NOW));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  // the quoter's override returns one word whatever the amount, so the pool would only fail to fill: the device never
  // sends it at all
  assert.deepEqual(seen, []);
});

test("H1 a seeded pool is held to the token's real hookless native pool of a shape no standard route reads, found by the scan", async () => {
  const token = "0x00000000000000000000000000000000000ab2ab";
  // hook 0 equals the native asset's address: such a pool has no hook to replace and is never dropped
  const real: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  assert.deepEqual(await quoteOn([seeded(token), real], token, seededRoute(token), scanner(5_000_000, [{ key: real.key, at: 4_500_000 }])), below);
});

// review of f44fbdb (fold 6): T1-T3 as the reviewer wrote them, T4 the fetch timeout
test("T1 64 empty pools initialized after the token's launch push its newer real pool past EVM_QUOTE_MAX_FOUND", async () => {
  // the real pool: hookless native, of a shape no standard route reads (as H1), created after the launch (a graduation);
  // before it, 64 Initialize events of the token with the native asset (fees 1..64, no liquidity: a few cents of gas)
  const token = "0x00000000000000000000000000000000000fe1fe";
  const realPool: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const junk = Array.from({ length: 64 }, (_, i) => keyOf(token, NATIVE, i + 1, 1, NATIVE));
  const logs = [...junk.map((k, i) => ({ key: k, at: 4_100_000 + i })), { key: realPool.key, at: 4_600_000 }];
  const control = await quoteOn([seeded(token), realPool], token, seededRoute(token), scanner(5_000_000, [{ key: realPool.key, at: 4_600_000 }]));
  assert.deepEqual(control, below, "control: without the junk the scan holds the seeded pool to the real one");
  // a second token, so the control's scan is not in the cache
  const t2 = "0x00000000000000000000000000000000000fe1ff";
  const real2: ModelPool = { key: keyOf(t2, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const junk2 = Array.from({ length: 64 }, (_, i) => keyOf(t2, NATIVE, i + 1, 1, NATIVE));
  const logs2 = [...junk2.map((k, i) => ({ key: k, at: 4_100_000 + i })), { key: real2.key, at: 4_600_000 }];
  void logs;
  const v = await quoteOn([seeded(t2), real2], t2, seededRoute(t2), scanner(5_000_000, logs2));
  assert.deepEqual(v, below, "a tenth of the price passes once 64 empty pools precede the real one");
});

test("T2 eight held junk currencies older than the token's real X pool never push it out", async () => {
  // as X1, but the real token/X pool is newer than the junk (a graduation): each junk pool holds a little liquidity
  const token = "0x00000000000000000000000000000000000fe2fe";
  const x9 = xAt(0x300);
  const realX: ModelPool = { key: keyOf(token, x9, 3000, 60, NATIVE), give: (a) => a };
  const market = marketOf(x9);
  const junk = Array.from({ length: 8 }, (_, i): ModelPool => ({ key: keyOf(token, xAt(0x301 + i), 3000, 60, NATIVE), give: (a) => a / 100n }));
  const logs = [...junk.map((j, i) => ({ key: j.key, at: 4_100_000 + i })), { key: market.key, at: 4_050_000 }, { key: realX.key, at: 4_600_000 }];
  const pools = [seeded(token), realX, market, ...junk];
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)));
  assert.deepEqual(v, below, "a tenth of the price passes once eight junk currencies precede the real one");
});

test("T3 a coin two currencies from the native asset (a Zora content coin: coin/creator coin, creator coin/ZORA, ZORA/ETH) is priced by nothing", async () => {
  const token = "0x00000000000000000000000000000000000fe3fe";
  const creator = xAt(0x400);
  const coinPool: ModelPool = { key: keyOf(token, creator, 0x800000, 200, ZORA_HOOK), give: (a) => a };
  const creatorPool: ModelPool = { key: keyOf(creator, ZORA, 0x800000, 200, ZORA_HOOK), give: (a) => a };
  const zoraMarket = marketOf(ZORA);
  const logs = [{ key: coinPool.key, at: 4_500_000 }, { key: creatorPool.key, at: 4_400_000 }, { key: zoraMarket.key, at: 4_050_000 }];
  const pools = [seeded(token), coinPool, creatorPool, zoraMarket];
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)));
  assert.equal(v.accepted, false, "a tenth of the price passes: the real price is three pools from the native asset");
});

test("T4 a provider that never answers is a refusal (rpc_error) once the request's time runs out, never a hang", { timeout: 3_000 }, async () => {
  let signal: unknown;
  // a fetch that answers only when its request is aborted, as a hung connection does
  const hung = ((_: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  }) as typeof fetch;
  const t = Date.now();
  await assert.rejects(evmJsonRpc("https://a.example", hung, 1 << 20, 50)([{ method: "eth_blockNumber", params: [] }]));
  // the request's limit is 50 ms: a request with none would hang to the test's 3 s
  assert.ok(Date.now() - t < 2_000);
  // and by default each request carries a signal (EVM_RPC_TIMEOUT_MS)
  signal = undefined;
  void evmJsonRpc("https://a.example", hung)([{ method: "eth_blockNumber", params: [] }]).catch(() => {});
  assert.ok(signal instanceof AbortSignal, "the default request has a time limit");
  const req = { chain: "base" as const, token: "0x00000000000000000000000000000000000fe4fe", amountIn: AMOUNT, slippageBps: 100, route: seededRoute("0x00000000000000000000000000000000000fe4fe") };
  const v = await verdict(evmPoolBuyQuoteWith(req, [chain([], 0), evmJsonRpc("https://b.example", hung, 1 << 20, 50)], NOW));
  assert.deepEqual(v, { accepted: false, code: "rpc_error" });
});

test("T5 the reference through other currencies names the full route from the native asset, every pool on it (review of f44fbdb, Low)", async () => {
  const token = "0x00000000000000000000000000000000000fe6fe";
  const creator = xAt(0x410);
  const coinPool: ModelPool = { key: keyOf(token, creator, 0x800000, 200, ZORA_HOOK), give: (a) => a };
  const creatorPool: ModelPool = { key: keyOf(creator, ZORA, 0x800000, 200, ZORA_HOOK), give: (a) => a };
  const zoraMarket = marketOf(ZORA);
  const logs = [{ key: coinPool.key, at: 4_500_000 }, { key: creatorPool.key, at: 4_400_000 }, { key: zoraMarket.key, at: 4_050_000 }];
  const pools = [seeded(token), coinPool, creatorPool, zoraMarket];
  let ref: EvmRoute | undefined;
  await assert.rejects(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)), (e: unknown) => {
    ref = (e as EvmQuoteError).reference?.route;
    return e instanceof EvmQuoteError && e.code === "below_reference";
  });
  assert.ok(ref?.venue === "uniswap-v4" && ref.currencyIn === NATIVE, JSON.stringify(ref));
  const hop = (k: EvmPoolKey, c: string) => ({ currency: c.toLowerCase(), fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, hookData: "0x" });
  assert.deepEqual(ref.hops, [hop(zoraMarket.key, ZORA), hop(creatorPool.key, creator), hop(coinPool.key, token)]);
});

test("T6 a provider that answers a batch state read with one slot short is refused (rpc_error)", async () => {
  const token = "0x00000000000000000000000000000000000fe7fe";
  const real: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  // enough pools that their state goes out as PoolManager.extsload(bytes32[])
  const junk = Array.from({ length: 70 }, (_, i) => keyOf(token, NATIVE, 1000 + i, 1, NATIVE));
  const logs = [...junk.map((k, i) => ({ key: k, at: 4_100_000 + i })), { key: real.key, at: 4_600_000 }];
  const inner = chain([seeded(token), real], 1);
  let short = 0;
  const lying: EvmRpc = async (calls) => {
    const out = (await inner(calls)) as { result?: string }[];
    return out.map((a, i) => {
      const d = (calls[i]!.params[0] as { data?: string } | undefined)?.data ?? "";
      if (!d.startsWith("0xdbd035ff") || typeof a.result !== "string") return a;
      short++;
      // the count it names, one word fewer
      return { ...a, result: a.result.slice(0, -64) };
    });
  };
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain([seeded(token), real], 0), lying], NOW, scanner(5_000_000, logs)));
  assert.ok(short > 0);
  assert.deepEqual(v, { accepted: false, code: "rpc_error" });
});

// review of 2afa8b6 (fold 7): no number an attacker can inflate cheaply decides what is quoted or refused; no bound
// refuses a token whose standard route fills; a reference through unlisted v4 middles is a route the device builds
test("A1 64 narrow-range pools that outranked the real pool by liquidity no longer change R: every held pool is quoted at the user's amount", async () => {
  const token = "0x00000000000000000000000000000000000fa1fa";
  // the real pool, hookless native of a shape no standard route reads, with a hundredth of the default liquidity; 64
  // dust pools of the token whose liquidity reads 10^30 at their price (a range one tick wide), each giving a thousandth
  const realPool: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a, state: [atTick(128), 10n ** 18n] };
  const narrow = Array.from({ length: 64 }, (_, i): ModelPool => ({ key: keyOf(token, NATIVE, i + 1, 1, NATIVE), give: (a) => a / 1000n, state: [atTick(128), 10n ** 30n], ticks: [128, 129] }));
  const logs = [{ key: realPool.key, at: 4_100_000 }, ...narrow.map((p, i) => ({ key: p.key, at: 4_200_000 + i }))];
  await assert.rejects(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain([seeded(token), realPool, ...narrow], 0), chain([seeded(token), realPool, ...narrow], 1)], NOW, scanner(5_000_000, logs)), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "below_reference", String(e));
    assert.equal(e.reference!.amountOut, AMOUNT);
    assert.deepEqual((e.reference!.route as EvmV4Route).hops.map((h) => [h.fee, h.tickSpacing]), [[2500, 50]]);
    return true;
  });
});

test("B1 USDG on Robinhood: its standard ETH pool quotes, though 120 currencies paired with it have no market and report deep pools", async () => {
  // USDG's shape on Robinhood (2026-11-04 05:5xZ): the hookless ETH/USDG 0.01% pool, thousands of pools of other
  // currencies, a few with a market of their own (JITC's, tiny), most with none. More than 100 currencies: their scan is
  // asked as ORs at the provider's OR span, fewer requests than one a currency (card rh-cold-quote)
  const token = USDG;
  const eth: ModelPool = { key: keyOf(token, NATIVE, 100, 1, NATIVE), give: (a) => 3000n * a, state: pricedAt(3000n) };
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 100, tickSpacing: 1, hooks: NATIVE, hookData: "0x" }] };
  const lonely = Array.from({ length: 120 }, (_, i): ModelPool => ({ key: keyOf(token, xAt(0x800 + i), 0x800000, 8, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 24n] }));
  const jitc = xAt(0x8ff);
  const jitcPool: ModelPool = { key: keyOf(token, jitc, 3000, 60, NATIVE), give: (a) => a / 5n, state: [DEEP_PRICE, 10n ** 15n] };
  const jitcMarket: ModelPool = { key: keyOf(jitc, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const pools = [eth, jitcPool, jitcMarket, ...lonely];
  const logs = [...lonely.map((p, i) => ({ key: p.key, at: 45_000_000 + i })), { key: jitcPool.key, at: 46_000_000 }, { key: jitcMarket.key, at: 44_000_000 }];
  const asked: [number, number][] = [];
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "robinhood", token, amountIn: AMOUNT, slippageBps: 100, route }, [chain(pools, 0, 50_000_000), chain(pools, 1, 50_000_000)], NOW, scanner(50_000_000, logs, asked, 100_000)));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.equal((v as { amountOut: bigint }).amountOut, 3000n * AMOUNT);
  // past USDG's own two requests of the whole depth, every request at the OR span: none the provider refuses
  assert.equal(asked.filter(([a, b]) => b - a + 1 > 100_000).length, 2, `${asked.length} getLogs`);
});

// Card rh-cold-quote: TORCH on Robinhood (2026-11-06 01:3xZ): its quote route, the hookless native 0.3% pool, and 100
// pools with other currencies, 99 of them seeded currencies whose only pool is that one; 89 of those could not give the
// route's Q at any price. Robinhood's first scan provider spans 10M blocks a request with one value a topic position
// and 100,000 with more (`orSpan`), and answers about 1.2 such 10M requests a second under its rate limit (a cold
// quote's trace from this Mac, 01:57Z), so the quote's getLogs calls are its time.
const RC_HEAD = 50_000_000;
const rcCoin = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1111";
const rcRoute: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: rcCoin, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" }] };
const rcEth: ModelPool = { key: keyOf(rcCoin, NATIVE, 3000, 60, NATIVE), give: (a) => 3000n * a, state: pricedAt(3000n) };
// seeded currency i's pool with the token: deep at its spot, but holding `most` of the token at any price
// the card's own currencies, apart from every other case's (a scan is kept per currency for the module's life)
const rcAt = (i: number) => "0x" + (0x7c0000 + i).toString(16).padStart(40, "0");
const rcSeeded = (i: number, most?: bigint, token = rcCoin): ModelPool => ({ key: keyOf(token, rcAt(0x100 + i), 3000, 60, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 24n], ...(most === undefined ? {} : { most }) });
const rcLogs = (pools: ModelPool[]) => pools.map((p, i) => ({ key: p.key, at: RC_HEAD - 9_000_000 + 1_000 * i }));
const rcQuote = (pools: ModelPool[], logs: { key: EvmPoolKey; at: number }[], asked: [number, number][], route = rcRoute) =>
  verdict(evmPoolBuyQuoteWith({ chain: "robinhood", token: rcCoin, amountIn: AMOUNT, slippageBps: 100, route }, [chain(pools, 0, RC_HEAD), chain(pools, 1, RC_HEAD)], NOW, scanner(RC_HEAD, logs, asked, 100_000)));

test("card rh-cold-quote: a cold Robinhood quote of a token with 99 seeded currencies asks the deep provider one request a currency and kind, only for those whose pool can give Q", async () => {
  // 89 seeded pools hold less of the token than Q (3000 x AMOUNT) at any price, 10 hold more; none of the 99 has a market
  const seeded = Array.from({ length: 99 }, (_, i) => rcSeeded(i, i < 89 ? 1000n * AMOUNT : undefined));
  const pools = [rcEth, ...seeded];
  const asked: [number, number][] = [];
  const v = await rcQuote(pools, rcLogs(seeded), asked);
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.equal((v as { amountOut: bigint }).amountOut, 3000n * AMOUNT);
  // the token's two topic positions, then for each of the 10: its markets (3 filters) and, with none, its pools (2):
  // 52 calls of 10M blocks, about 22 s of Robinhood's rate limit at most where main sent 2 + 100 x 3 + 100 x 2 = 502
  // OR calls of 100,000 blocks and the quote ended rpc_error at its 60 s bound
  assert.ok(asked.length <= 2 + 10 * 5, `${asked.length} getLogs calls, 52 at most`);
  assert.ok(asked.every(([a, b]) => b - a + 1 === 10_000_000), "each request spans the whole depth");
});

// the helper's route through the token's standard 1% native pool, seeded at a tenth of the price (Q = AMOUNT / 10), and
// the real price through another currency X: its pool with the token at the price of 1 and X's only market, of a shape
// only the scan finds (marketOf), so the seeded route is held to the route through X (heldTo). Each case its own token:
// a scan is kept per currency for the module's life
const rcX = (token: string, pool: Partial<ModelPool> = {}, junk = 0, x = rcAt(0)) => {
  const xPool: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a, ...pool };
  const market = marketOf(x);
  const seededJunk = Array.from({ length: junk }, (_, i) => rcSeeded(i, AMOUNT / 100n, token));
  const pools = [seeded(token), xPool, market, ...seededJunk];
  const req = { chain: "robinhood" as const, token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) };
  return { x, run: () => evmPoolBuyQuoteWith(req, [chain(pools, 0, RC_HEAD), chain(pools, 1, RC_HEAD)], NOW, scanner(RC_HEAD, rcLogs([xPool, market, ...seededJunk]), [], 100_000)) };
};

test("card rh-cold-quote: the X prune keeps a currency whose pool with the token can give Q: its scanned market still holds a seeded route, beside 60 seeded currencies that cannot", async () => {
  const c = rcX("0x000050e18ffa3f8f7ad170eb9cef160eb3ed11a1", {}, 60);
  await assert.rejects(c.run(), heldTo(c.x));
});

test("card rh-cold-quote: one provider that answers a currency's pool cannot give Q, to hide its market, is refused (rpc_disagree), never a seeded route", async () => {
  // on provider 0 the pool reports it holds less of the token than Q at any price; provider 1 answers what the chain holds
  const c = rcX("0x000050e18ffa3f8f7ad170eb9cef160eb3ed11a2", { most: AMOUNT / 100n, mostOn: 0 }, 0, rcAt(1));
  assert.deepEqual(await verdict(c.run()), { accepted: false, code: "rpc_disagree" });
});

test("card rh-cold-quote: a currency's pool behind a pinned hook is never pruned: it runs as it is, so its market is scanned", async () => {
  // Doppler's /8 shape with X, reporting it holds less than Q: no exact-output read prunes it
  const t = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed11a3";
  const c = rcX(t, { key: keyOf(t, rcAt(2), 0x800000, 8, "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544"), most: AMOUNT / 100n }, 0, rcAt(2));
  await assert.rejects(c.run(), heldTo(c.x));
});

test("card rh-cold-quote: seeded pools whose output of Q needs more than 2^127 in (SafeCastOverflow on both providers) are pruned: only the token's own scan is asked", async () => {
  const coin = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed11a4";
  const eth: ModelPool = { ...rcEth, key: keyOf(coin, NATIVE, 3000, 60, NATIVE) };
  const seeded = Array.from({ length: 20 }, (_, i): ModelPool => ({ ...rcSeeded(0x40 + i, undefined, coin), over: "both" }));
  const asked: [number, number][] = [];
  const route: EvmRoute = { ...rcRoute, hops: [{ ...rcRoute.hops[0]!, currency: coin }] };
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "robinhood", token: coin, amountIn: AMOUNT, slippageBps: 100, route }, [chain([eth, ...seeded], 0, RC_HEAD), chain([eth, ...seeded], 1, RC_HEAD)], NOW, scanner(RC_HEAD, rcLogs(seeded), asked, 100_000)));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.equal(asked.length, 2, "the token's two topic positions alone");
});

test("card rh-cold-quote: one provider that answers SafeCastOverflow for a currency's pool, to hide its market, is refused (rpc_disagree), against a revert or an answer", async () => {
  const c = rcX("0x000050e18ffa3f8f7ad170eb9cef160eb3ed11a5", { over: 0 }, 0, rcAt(3));
  assert.deepEqual(await verdict(c.run()), { accepted: false, code: "rpc_disagree" });
  // the other a revert with no data: both revert, only one names the overflow
  const d = rcX("0x000050e18ffa3f8f7ad170eb9cef160eb3ed11a6", { over: 0, plainOn: 1 }, 0, rcAt(4));
  assert.deepEqual(await verdict(d.run()), { accepted: false, code: "rpc_disagree" });
  assert.deepEqual(await verdict(c.run()), { accepted: false, code: "rpc_disagree" });
});

test("card rh-cold-quote: the prune reads the token out of a currency's pool: one deep in the token and shallow in its other currency is kept, the token as currency1 or as currency0", async () => {
  // each pool holds less than Q of X, so a read that named X as the output would prune it and let the seeded route pass
  const x1 = rcAt(0x200);
  const c1 = rcX("0x000050e18ffa3f8f7ad170eb9cef160eb3ed11b1", { mostOf: { [x1]: AMOUNT / 100n } }, 0, x1);
  assert.ok(BigInt(x1) < BigInt("0x000050e18ffa3f8f7ad170eb9cef160eb3ed11b1"), "the token is currency1");
  await assert.rejects(c1.run(), heldTo(c1.x));
  const x0 = "0x7fffffffffffffffffffffffffffffffff0000b2";
  const c0 = rcX("0x000050e18ffa3f8f7ad170eb9cef160eb3ed11b2", { mostOf: { [x0]: AMOUNT / 100n } }, 0, x0);
  await assert.rejects(c0.run(), heldTo(c0.x));
});

test("card rh-cold-quote: a currency's pool whose exact-output read reverts with no data on both providers is kept: its market still holds a seeded route", async () => {
  const c = rcX("0x000050e18ffa3f8f7ad170eb9cef160eb3ed11b3", { plainOn: "both" }, 0, rcAt(5));
  await assert.rejects(c.run(), heldTo(c.x));
});

// Card evm-spare-list-green: TORCH's second quote on Robinhood (2026-11-06 22:3xZ from this Mac, every provider up): the
// first quote prunes USDG (its pool with TORCH cannot give Q) and scans USDG's markets as a currency one level further,
// so the second found USDG scanned, skipped its prune, scanned all of USDG's pools over the whole depth (one cold request
// on the first, about 5,000 on a spare of 2,000 blocks) and refused too_many_pools (USDG's pools pass the 1,024 other
// currencies). Here X1's pool with the token can give Q and X1 has no market, so the quote scans X1's pools and finds U
// there; the token's own pool with U cannot give Q, and U has 1,100 pools of its own.
test("card evm-spare-list-green: a quote prunes a currency the quote before scanned as it pruned it then: the token's second quote scans nothing new and lands as the first", { timeout: 60_000 }, async () => {
  const coin = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed11d1";
  const [x1, u] = [rcAt(0x500), rcAt(0x501)];
  const eth: ModelPool = { ...rcEth, key: keyOf(coin, NATIVE, 3000, 60, NATIVE) };
  const xPool: ModelPool = { key: keyOf(coin, x1, 3000, 60, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 24n] };
  const uPool: ModelPool = { key: keyOf(coin, u, 3000, 60, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 24n], most: 1000n * AMOUNT };
  const via: ModelPool = { key: keyOf(x1, u, 3000, 60, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 24n] };
  const uOwn = Array.from({ length: 1_100 }, (_, i): ModelPool => ({ key: keyOf(u, rcAt(0x1000 + i), 3000, 60, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 24n] }));
  const pools = [eth, xPool, uPool, via, ...uOwn];
  const logs = rcLogs([xPool, uPool, via, ...uOwn]);
  const route: EvmRoute = { ...rcRoute, hops: [{ ...rcRoute.hops[0]!, currency: coin }] };
  const quote = (asked: [number, number][]) => verdict(evmPoolBuyQuoteWith({ chain: "robinhood", token: coin, amountIn: AMOUNT, slippageBps: 100, route }, [chain(pools, 0, RC_HEAD), chain(pools, 1, RC_HEAD)], NOW, scanner(RC_HEAD, logs, asked, 100_000)));
  const first = await quote([]);
  assert.equal(first.accepted, true, String((first as { code?: string }).code));
  assert.equal((first as { amountOut: bigint }).amountOut, 3000n * AMOUNT);
  // the same head: every scan the first kept is whole, so the second asks the scan provider nothing
  const asked: [number, number][] = [];
  assert.deepEqual(await quote(asked), first);
  assert.deepEqual(asked, [], `${asked.length} getLogs, the first ${asked[0]?.join("-")}`);
});

// a cold Robinhood quote whose first scan provider fails once at once and whose spare hides the token's real pool (a
// native pool of a shape only the scan finds, initialized 5M blocks back): the first still reads every block but the
// newest few, so the seeded route is refused (review of 9c962b6d, HIGH: the spare had the whole 10M depth alone)
// `fail`: the first's request that answers HTTP 503, once
const rcLag = async (token: string, fail: (calls: readonly EvmRpcCall[]) => boolean) => {
  const real: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const pools = [seeded(token), real];
  const inner = scanner(RC_HEAD, [{ key: real.key, at: RC_HEAD - 5_000_000 }]);
  let failed = 0;
  const first: EvmRpc = async (calls, s) => {
    if (failed === 0 && fail(calls) && ++failed) throw new Error("the provider answered HTTP 503");
    return inner(calls, s);
  };
  const spareAsked: [number, number][] = [];
  const spare = scanner(RC_HEAD, [], spareAsked);
  const req = { chain: "robinhood" as const, token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) };
  // the blocks the spare read, each range once (a request's filters each ask it)
  const spared = () => [...new Set(spareAsked.map(String))].map((r) => r.split(",").map(Number)).reduce((n, [a, b]) => n + b! - a! + 1, 0);
  return { spareAsked, spared, failed: () => failed, run: (rpc = first) => evmPoolBuyQuoteWith(req, [chain(pools, 0, RC_HEAD), chain(pools, 1, RC_HEAD)], NOW, [rpc, spare]) };
};
const toBlock = (c: EvmRpcCall) => Number((c.params[0] as { toBlock: string }).toBlock);

test("card rh-cold-quote: a first whose backend is a block behind its head hands the spare the newest 2,000 blocks alone, never the cold depth: the seeded route is refused", async () => {
  const coin = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed11c1";
  const c = await rcLag(coin, () => false);
  const inner = scanner(RC_HEAD, [{ key: keyOf(coin, NATIVE, 2500, 50, NATIVE), at: RC_HEAD - 5_000_000 }]);
  let lagged = 0;
  const first: EvmRpc = async (calls, s) => {
    const out = await inner(calls, s);
    return out.map((o, i) => (calls[i]!.method === "eth_getBlockByNumber" && Number(calls[i]!.params[0]) === RC_HEAD && ++lagged ? { ...(o as object), result: null } : o));
  };
  await assert.rejects(c.run(first), (e: unknown) => e instanceof EvmQuoteError && e.code === "below_reference");
  assert.ok(lagged > 0);
  assert.equal(c.spared(), 2_000, JSON.stringify(c.spareAsked));
});

test("card rh-cold-quote: one HTTP 503 from the first on a cold getLogs is asked again as its halves on the first: the seeded route is refused", async () => {
  const c = await rcLag("0x000050e18ffa3f8f7ad170eb9cef160eb3ed11c2", (calls) => calls.some((x) => x.method === "eth_getLogs") && toBlock(calls[0]!) - Number((calls[0]!.params[0] as { fromBlock: string }).fromBlock) + 1 > 1_000_000);
  await assert.rejects(c.run(), (e: unknown) => e instanceof EvmQuoteError && e.code === "below_reference");
  assert.equal(c.failed(), 1);
  assert.ok(c.spareAsked.every(([a, b]) => b - a + 1 <= 1_000_000), JSON.stringify(c.spareAsked));
});

test("card rh-cold-quote: a first that answers HTTP 503 to every request over 100,000 blocks holding the real pool's block is asked its halves down to 100,000: the spare reads none", async () => {
  const at = RC_HEAD - 500_000;
  const c = rcFirst("0x000050e18ffa3f8f7ad170eb9cef160eb3ed1f14", (inner) => async (calls, s) => {
    const f = calls.find((x) => x.method === "eth_getLogs")?.params[0] as { fromBlock: string; toBlock: string } | undefined;
    if (f !== undefined && Number(f.fromBlock) <= at && Number(f.toBlock) >= at && Number(f.toBlock) - Number(f.fromBlock) + 1 > 100_000) throw new Error("the provider answered HTTP 503");
    return inner(calls, s);
  });
  assert.deepEqual(await c.run(), { accepted: false, code: "below_reference" });
  assert.equal(c.spared(), 0);
});

test("card rh-cold-quote: a first that answers HTTP 503 to the newest blocks hands the spare those blocks alone: the seeded route is refused", async () => {
  const c = await rcLag("0x000050e18ffa3f8f7ad170eb9cef160eb3ed11c3", (calls) => calls.some((x) => x.method === "eth_getLogs") && toBlock(calls[0]!) === RC_HEAD);
  await assert.rejects(c.run(), (e: unknown) => e instanceof EvmQuoteError && e.code === "below_reference");
  assert.equal(c.failed(), 1);
  assert.equal(c.spared(), 2_000, JSON.stringify(c.spareAsked));
});
// review of 8fd51265: the token's real pool 500,000 blocks back on the first, which answers `first(inner)`; the spare
// hides it. A cold scan's failures of the first never hand the spare its depth
const rcFirst = (coin: string, first: (inner: EvmRpc) => EvmRpc) => {
  const real: ModelPool = { key: keyOf(coin, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const pools = [seeded(coin), real];
  const inner = scanner(RC_HEAD, [{ key: real.key, at: RC_HEAD - 500_000 }]);
  const spareAsked: [number, number][] = [];
  const spare = scanner(RC_HEAD, [], spareAsked);
  const req = { chain: "robinhood" as const, token: coin, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(coin) };
  const spared = () => [...new Set(spareAsked.map(String))].map((r) => r.split(",").map(Number)).reduce((n, [a, b]) => n + b! - a! + 1, 0);
  return { spared, run: () => verdict(evmPoolBuyQuoteWith(req, [chain(pools, 0, RC_HEAD), chain(pools, 1, RC_HEAD)], NOW, [first(inner), spare])) };
};
// a fetch that answers `inner` as JSON-RPC, or `instead`'s response where it names one
const rcFetch = (inner: EvmRpc, instead: (calls: EvmRpcCall[]) => Response | null): typeof fetch =>
  (async (_u: unknown, init: { body: string }) => {
    const calls = (JSON.parse(init.body) as { method: string; params: unknown[] }[]).map((c) => ({ method: c.method, params: c.params }));
    const o = instead(calls);
    if (o !== null) return o;
    const out = await inner(calls);
    return new Response(JSON.stringify(out.map((x, id) => ({ ...(x as object), id }))), { status: 200 });
  }) as unknown as typeof fetch;
// the first's getLogs answers: an error for any range that holds block `at` and spans more than `over` blocks
const rcErr = (at: number, over: number, message: string) => (inner: EvmRpc): EvmRpc => async (calls, s) => {
  const out = await inner(calls, s);
  return out.map((o, i) => {
    if (calls[i]!.method !== "eth_getLogs") return o;
    const f = calls[i]!.params[0] as { fromBlock: string; toBlock: string };
    const [a, b] = [Number(f.fromBlock), Number(f.toBlock)];
    return a <= at && b >= at && b - a + 1 > over ? { jsonrpc: "2.0", id: i, error: { code: -32005, message } } : o;
  });
};
// the token's pools made up beside its real one: `n` native pools behind hooks no chain holds, `per` to a block from
// block `at` on, which the state reads find uninitialized
const rcJunk = (coin: string, n: number, per: number, at: number) =>
  Array.from({ length: n }, (_, i) => ({ key: keyOf(coin, NATIVE, 3000, 60, "0x" + (0xa000000 + i).toString(16).padStart(40, "0")), at: at + Math.floor(i / per) }));
// a first that answers `error` for any getLogs whose logs pass the cap of 10,000 (as Robinhood's, publicnode's and
// Tenderly's do, each in its own words); `asked` keeps each range it was asked
const rcCapped = (error: object, asked: [number, number][]) => (inner: EvmRpc): EvmRpc => async (calls, s) => {
  const out = await inner(calls, s);
  return out.map((o, i) => {
    if (calls[i]!.method !== "eth_getLogs") return o;
    const f = calls[i]!.params[0] as { fromBlock: string; toBlock: string };
    asked.push([Number(f.fromBlock), Number(f.toBlock)]);
    return ((o as { result?: unknown[] }).result ?? []).length > 10_000 ? { jsonrpc: "2.0", id: i, error } : o;
  });
};
const rcFlood = (coin: string, junk: { key: EvmPoolKey; at: number }[], error: object) => {
  const real: ModelPool = { key: keyOf(coin, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const pools = [seeded(coin), real];
  const firstAsked: [number, number][] = [];
  const spareAsked: [number, number][] = [];
  const inner = scanner(RC_HEAD, [{ key: real.key, at: RC_HEAD - 500_000 }, ...junk]);
  const req = { chain: "robinhood" as const, token: coin, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(coin) };
  const spared = () => [...new Set(spareAsked.map(String))].map((r) => r.split(",").map(Number)).reduce((n, [a, b]) => n + b! - a! + 1, 0);
  return { firstAsked, spared, run: () => evmPoolBuyQuoteWith(req, [chain(pools, 0, RC_HEAD), chain(pools, 1, RC_HEAD)], NOW, [rcCapped(error, firstAsked)(inner), scanner(RC_HEAD, [], spareAsked)]) };
};
const atReal = (e: unknown) => e instanceof EvmQuoteError && e.code === "below_reference" && e.reference!.amountOut === AMOUNT;

// the three providers' words for a request past their cap on logs, read 2026-11-06: each answer is asked as its halves
// of the first, and the spare reads none of its blocks (review of 1277e8af, MEDIUM-A)
for (const [name, error, coin] of [
  ["rpc.mainnet.chain.robinhood.com", { code: -32000, message: "logs matched by query exceeds limit of 10000" }, "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1f10"],
  ["publicnode", { code: -32602, message: "query exceeds max results 20000, retry with the range 49501000-49501001" }, "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1f11"],
  ["Tenderly (its cause in data alone)", { code: -32602, message: "invalid params", data: "query returned more than 10000 results" }, "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1f12"],
] as const) {
  test(`card rh-cold-quote: 12,000 made-up pools past the first's cap, answered in ${name}'s words, are asked as halves of the first: the real price holds, the spare reads none`, { timeout: 60_000 }, async () => {
    const c = rcFlood(coin, rcJunk(coin, 12_000, 4_000, RC_HEAD - 500_000 + 1_000), error);
    await assert.rejects(c.run(), atReal);
    assert.equal(c.spared(), 0);
    // halved on the first down to spans of a few blocks, where its 4,000 pools a block are under its cap
    const least = Math.min(...c.firstAsked.map(([a, b]) => b - a + 1));
    assert.ok(least <= 16, `the first's least span ${least}`);
  });
}

test("card rh-cold-quote: 20,000 made-up pools packed 9,999 to a block from the block after the real pool's quote at the real price, within the bound (review of 1277e8af, MEDIUM-C)", { timeout: 60_000 }, async () => {
  const coin = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1f20";
  const c = rcFlood(coin, rcJunk(coin, 20_000, 9_999, RC_HEAD - 500_000 + 1), { code: -32000, message: "logs matched by query exceeds limit of 10000" });
  const t = performance.now();
  await assert.rejects(c.run(), atReal);
  const ms = Math.round(performance.now() - t);
  console.log(`20,000 made-up pools: ${c.firstAsked.length} getLogs on the first, ${ms} ms`);
  assert.ok(ms < 60_000);
  assert.equal(c.spared(), 0);
});

test("card rh-cold-quote: a first that answers HTTP 413 to a request holding the real pool's block is asked its halves, never the spare: the seeded route is refused", { timeout: 60_000 }, async () => {
  const at = RC_HEAD - 500_000;
  const c = rcFirst("0x000050e18ffa3f8f7ad170eb9cef160eb3ed1f13", (inner) =>
    evmJsonRpc("https://first.example", rcFetch(inner, (calls) => {
      const f = calls.find((x) => x.method === "eth_getLogs")?.params[0] as { fromBlock: string; toBlock: string } | undefined;
      return f !== undefined && Number(f.fromBlock) <= at && Number(f.toBlock) >= at && Number(f.toBlock) - Number(f.fromBlock) + 1 > 10 ? new Response("", { status: 413 }) : null;
    }), 16 << 20));
  assert.deepEqual(await c.run(), { accepted: false, code: "below_reference" });
  assert.equal(c.spared(), 0);
});

test("card rh-cold-quote: a first that answers -32602 to every getLogs refuses rpc_error within an honest split's requests, under 5 s, never the spare's word (review of 1265bd94)", { timeout: 30_000 }, async () => {
  // 2 x the scan's 2 starting requests (the depth and its newest 2,000 blocks) + 2 x ceil(65,536 / 10,000) x
  // ceil(log2(10M)) = 340 halving requests at most, past those 2; the bound at 10 s, so a scan that ran to it shows here
  const coin = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1f15";
  let batches = 0;
  const c = rcFirst(coin, (inner) => async (calls, s) => {
    const out = await inner(calls, s);
    if (!calls.some((x) => x.method === "eth_getLogs")) return out;
    batches++;
    return out.map((o, i) => (calls[i]!.method === "eth_getLogs" ? { jsonrpc: "2.0", id: i, error: { code: -32602, message: "invalid params" } } : o));
  });
  evmScanBound?.(10_000);
  const t = performance.now();
  try {
    assert.deepEqual(await c.run(), { accepted: false, code: "rpc_error" });
  } finally {
    evmScanBound?.();
  }
  const ms = Math.round(performance.now() - t);
  console.log(`a first answering errors: ${batches} getLogs batches, ${ms} ms`);
  assert.ok(batches <= 2 + 2 * 2 + 2 * Math.ceil(65_536 / 10_000) * Math.ceil(Math.log2(10_000_000)), String(batches));
  assert.ok(ms < 5_000, `${ms} ms`);
  assert.equal(c.spared(), 0);
});

test("card rh-cold-quote: a cold Base scan whose first answers each of its starting requests once with an error, then answers its halves, lands: each request's first split is the scan's own (review of ac6db348)", { timeout: 30_000 }, async () => {
  const token = "0x00000000000000000000000000000000000ba5f1";
  const pools = [seeded(token), real(token)];
  const seen = new Set<string>();
  let errs = 0;
  const inner = scanner(5_000_000, [{ key: real(token).key, at: 4_500_000 }]);
  // a query timeout inside a 200, once for each request of the scan's span (10,000 blocks), never for its halves
  const first: EvmRpc = async (calls, s) => {
    const out = await inner(calls, s);
    const l = calls.find((c) => c.method === "eth_getLogs");
    if (l === undefined) return out;
    const f = l.params[0] as { fromBlock: string; toBlock: string };
    const k = `${f.fromBlock}-${f.toBlock}`;
    if (Number(f.toBlock) - Number(f.fromBlock) + 1 < 9_000 || seen.has(k)) return out;
    seen.add(k);
    errs++;
    return out.map((o, i) => (calls[i]!.method === "eth_getLogs" ? { jsonrpc: "2.0", id: i, error: { code: -32000, message: "query timeout exceeded" } } : o));
  };
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain(pools, 0), chain(pools, 1)], NOW, first));
  assert.deepEqual(v, below);
  // their first splits alone pass the levels' share on Base, 2 x ceil(65,536 / 10,000) x ceil(log2(10,000)) = 196
  assert.ok(2 * errs > 196, `${errs} requests answered an error once`);
});

test("card rh-cold-quote: one block holding more pools than the first answers refuses too_many_pools, never the spare's word", { timeout: 60_000 }, async () => {
  const coin = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1f21";
  // in Tenderly's words, its cause in data alone
  const c = rcFlood(coin, rcJunk(coin, 10_001, 10_001, RC_HEAD - 500_000 + 7), { code: -32602, message: "invalid params", data: "query returned more than 10000 results" });
  await assert.rejects(c.run(), (e: unknown) => e instanceof EvmQuoteError && e.code === "too_many_pools");
  assert.equal(c.spared(), 0);
});

// a cached scan 500,000 blocks old (the real pool made since), then the first fails once in transport: the spare reads
// at most its own span of the newest blocks (review of 1277e8af, MEDIUM-B)
const rcGap = async (coin: string, first: (inner: EvmRpc) => EvmRpc) => {
  const H1 = RC_HEAD - 500_000;
  const real: ModelPool = { key: keyOf(coin, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const pools = [seeded(coin), real];
  const req = { chain: "robinhood" as const, token: coin, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(coin) };
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(req, [chain(pools, 0, H1), chain(pools, 1, H1)], NOW, [scanner(H1, []), scanner(H1, [])])), { accepted: true, amountOut: AMOUNT / 10n, minOut: (AMOUNT / 10n) * 99n / 100n, block: BigInt(H1) });
  const spareAsked: [number, number][] = [];
  const v = await verdict(evmPoolBuyQuoteWith(req, [chain(pools, 0, RC_HEAD), chain(pools, 1, RC_HEAD)], NOW, [first(scanner(RC_HEAD, [{ key: real.key, at: H1 + 100_000 }])), scanner(RC_HEAD, [], spareAsked)]));
  return { v, spared: [...new Set(spareAsked.map(String))].map((r) => r.split(",").map(Number)).reduce((k, [a, b]) => k + b! - a! + 1, 0) };
};

test("card rh-cold-quote: a cached scan's 500,000-block gap with one 503 on the first: its halves stay on the first, the real pool is read", async () => {
  let n = 0;
  const g = await rcGap("0x000050e18ffa3f8f7ad170eb9cef160eb3ed1f22", (inner) => async (calls, s) => {
    if (calls.some((x) => x.method === "eth_getLogs") && n++ === 0) throw new Error("the provider answered HTTP 503");
    return inner(calls, s);
  });
  assert.equal((g.v as { code?: string }).code, "below_reference");
  assert.ok(g.spared <= 2_000, String(g.spared));
});

test("card rh-cold-quote: a cached scan's 500,000-block gap on a first a block behind its head: the spare reads its 2,000 newest blocks alone, the real pool is read", async () => {
  const g = await rcGap("0x000050e18ffa3f8f7ad170eb9cef160eb3ed1f23", (inner) => async (calls, s) => {
    const out = await inner(calls, s);
    return out.map((o, i) => (calls[i]!.method === "eth_getBlockByNumber" && Number(calls[i]!.params[0]) === RC_HEAD ? { ...(o as object), result: null } : o));
  });
  assert.equal((g.v as { code?: string }).code, "below_reference");
  assert.ok(g.spared <= 2_000, String(g.spared));
});

test("card rh-cold-quote: a cold scan's first throttled past the quote's bound (one 429, Retry-After 120 s) refuses rpc_error, never hands the spare its depth", async () => {
  let n = 0;
  const c = rcFirst("0x000050e18ffa3f8f7ad170eb9cef160eb3ed1e01", (inner) =>
    evmJsonRpc("https://first.example", rcFetch(inner, (calls) => (calls.some((x) => x.method === "eth_getLogs") && n++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "120" } }) : null)), 16 << 20));
  assert.deepEqual(await c.run(), { accepted: false, code: "rpc_error" });
  assert.equal(c.spared(), 0);
});

test("card rh-cold-quote: a first that answers an error for any request over 1M blocks holding the real pool is asked its halves down to 1M: the seeded route is refused", async () => {
  const c = rcFirst("0x000050e18ffa3f8f7ad170eb9cef160eb3ed1e04", rcErr(RC_HEAD - 500_000, 1_000_000, "query timeout exceeded"));
  assert.deepEqual(await c.run(), { accepted: false, code: "below_reference" });
  assert.equal(c.spared(), 0);
});

test("card rh-cold-quote: a token flooded with made-up pools, past the first's cap on logs at every span, is too_many_pools, never priced on the spare's word", async () => {
  const c = rcFirst("0x000050e18ffa3f8f7ad170eb9cef160eb3ed1e02", rcErr(RC_HEAD - 500_000 + 1_000, 0, "logs matched by query exceeds limit of 10000"));
  assert.deepEqual(await c.run(), { accepted: false, code: "too_many_pools" });
  assert.equal(c.spared(), 0);
});


test("D1 the reference through unlisted v4 middles is a route the device quotes and builds; the same route unquoted, or on v3, is refused", async () => {
  const token = "0x00000000000000000000000000000000000fd1fd";
  const creator = xAt(0x420);
  const coinPool: ModelPool = { key: keyOf(token, creator, 0x800000, 200, ZORA_HOOK), give: (a) => a };
  const creatorPool: ModelPool = { key: keyOf(creator, ZORA, 0x800000, 200, ZORA_HOOK), give: (a) => a };
  const zoraMarket = marketOf(ZORA);
  const logs = [{ key: coinPool.key, at: 4_500_000 }, { key: creatorPool.key, at: 4_400_000 }, { key: zoraMarket.key, at: 4_050_000 }];
  const pools = [seeded(token), coinPool, creatorPool, zoraMarket];
  const rpcs = [chain(pools, 0), chain(pools, 1)] as const;
  let ref: EvmRoute | undefined;
  await assert.rejects(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, rpcs, NOW, scanner(5_000_000, logs)), (e: unknown) => {
    ref = (e as EvmQuoteError).reference?.route;
    return e instanceof EvmQuoteError && e.code === "below_reference";
  });
  // the caller quotes the reference: ZORA and the creator coin are not listed middles on Base
  const q = await evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: ref! }, rpcs, NOW, scanner(5_000_000, logs));
  assert.equal(q.amountOut, AMOUNT);
  const ADAPTER = "0x000000000000000000000000000000000000ada4";
  const built = builder.evmPoolBuildUnpinned("base", ADAPTER, q.route, q.minOut, token, true);
  assert.equal(built.data, "0x" + Buffer.from(builder.evmPoolRouteDataQuoted("base", q.route).data).toString("hex"));
  assert.equal(built.minOut, q.minOut);
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return "built";
  };
  // the same route through the public route encoder, or built as if no quote held it, is refused
  assert.equal(code(() => builder.evmPoolRouteData("base", q.route)), "middle_not_listed");
  assert.equal(code(() => builder.evmPoolBuildUnpinned("base", ADAPTER, q.route, q.minOut, token)), "middle_not_listed");
  // a v3 route's middles stay listed-only, quoted or not
  assert.equal(code(() => builder.evmPoolBuildUnpinned("base", ADAPTER, { venue: "uniswap-v3", tokens: [WETH, ZORA, token], fees: [3000, 3000] }, 1n, token, true)), "middle_not_listed");
});

test("H2 a found pool whose hook reverts every swap cannot set R; one whose hook takes half counts for that half", async () => {
  const token = "0x00000000000000000000000000000000000ab3ab";
  const HOOK = "0x00000000000000000000000000000000000050cc";
  // ten times the standard pool's price with the hook replaced; as it is, the hook lets no swap through (a pool only
  // its own router may swap in, as one of USDG's WETH pools on Robinhood)
  const closed: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, HOOK), give: (a) => 100n * a, lie: () => null, state: pricedAt(100n) };
  const logs = [{ key: closed.key, at: 4_500_000 }];
  const v = await quoteOn([best(token), closed], token, bestRoute(token), scanner(5_000_000, logs));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  const t2 = "0x00000000000000000000000000000000000ab4ab";
  const half: ModelPool = { key: keyOf(t2, NATIVE, 3000, 60, HOOK), give: (a) => 100n * a, lie: (a) => 50n * a, state: pricedAt(100n) };
  await assert.rejects(evmPoolBuyQuoteWith({ chain: "base", token: t2, amountIn: AMOUNT, slippageBps: 100, route: bestRoute(t2) }, [chain([best(t2), half], 0), chain([best(t2), half], 1)], NOW, scanner(5_000_000, [{ key: half.key, at: 4_500_000 }])), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "below_reference", String(e));
    assert.equal(e.reference!.amountOut, 50n * AMOUNT);
    return true;
  });
});

test("T7 a provider that answers 429 is asked again a little later; one that keeps answering 429 is a refusal", { timeout: 20_000 }, () => onTestClock(async () => {
  const token = "0x00000000000000000000000000000000000fe8fe";
  const inner = chain([best(token)], 1);
  // a fetch for provider 2 that answers 429 to its first `n` requests, then as the chain does
  const limited = (n: number) => {
    let left = n;
    return evmJsonRpc("https://b.example", (async (_u: string, init: { body: string }) => {
      if (left-- > 0) return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: 429, message: "Too Many Requests" } }), { status: 429 });
      const calls = JSON.parse(init.body) as { id: number; method: string; params: unknown[] }[];
      const answers = await inner(calls.map((c) => ({ method: c.method, params: c.params })));
      return new Response(JSON.stringify(answers.map((a, i) => ({ ...(a as object), id: calls[i]!.id }))));
    }) as unknown as typeof fetch);
  };
  const req = { chain: "base" as const, token, amountIn: AMOUNT, slippageBps: 100, route: bestRoute(token) };
  const v = await verdict(evmPoolBuyQuoteWith(req, [chain([best(token)], 0), limited(2)], NOW));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(req, [chain([best(token)], 0), limited(1000)], NOW)), { accepted: false, code: "rpc_error" });
  // mainnet.base.org's limit: HTTP 200, each call of the batch an error naming it (2026-11-04 07:4xZ)
  let left = 2;
  const inBatch: EvmRpc = async (calls) => (left-- > 0 ? calls.map((_, id) => ({ jsonrpc: "2.0", id, error: { code: -32016, message: "25/second request limit reached" } })) : inner(calls));
  const w = await verdict(evmPoolBuyQuoteWith(req, [chain([best(token)], 0), inBatch], NOW));
  assert.equal(w.accepted, true, String((w as { code?: string }).code));
}));

test("T7b a request that made no connection (fetch failed, a connect error as its cause) is asked again; one that timed out is not, nor a connection that keeps failing (card evm-quote-warm-round)", { timeout: 20_000 }, () => onTestClock(async () => {
  const token = "0x00000000000000000000000000000000000fe8ff";
  const inner = chain([best(token)], 1);
  // provider 2's fetch: its first `n` requests fail as `fail` makes them, then it answers as the chain does
  const failing = (n: number, fail: () => Error) => {
    let left = n;
    const asked = { n: 0 };
    const rpc = evmJsonRpc("https://b.example", (async (_u: string, init: { body: string }) => {
      asked.n++;
      if (left-- > 0) throw fail();
      const calls = JSON.parse(init.body) as { id: number; method: string; params: unknown[] }[];
      const answers = await inner(calls.map((c) => ({ method: c.method, params: c.params })));
      return new Response(JSON.stringify(answers.map((a, i) => ({ ...(a as object), id: calls[i]!.id }))));
    }) as unknown as typeof fetch);
    return { rpc, asked };
  };
  // undici's form: TypeError("fetch failed") with the socket's error as its cause (mainnet.base.org, 2026-11-04 15:45Z)
  const unconnected = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }) });
  const req = { chain: "base" as const, token, amountIn: AMOUNT, slippageBps: 100, route: bestRoute(token) };
  const once = failing(1, unconnected);
  const v = await verdict(evmPoolBuyQuoteWith(req, [chain([best(token)], 0), once.rpc], NOW));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  // a browser's form names no cause (Chrome's "Failed to fetch", Safari's "Load failed"): asked again too (re-review of
  // b282ce0, LOW-B)
  for (const m of ["Failed to fetch", "Load failed"]) {
    const b = await verdict(evmPoolBuyQuoteWith(req, [chain([best(token)], 0), failing(1, () => new TypeError(m)).rpc], NOW));
    assert.equal(b.accepted, true, `${m}: ${String((b as { code?: string }).code)}`);
  }
  // every request fails to connect: a refusal after the fourth
  const never = failing(1000, unconnected);
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(req, [chain([best(token)], 0), never.rpc], NOW)), { accepted: false, code: "rpc_error" });
  assert.equal(never.asked.n, 4);
  // a request that ran out of time may have been served: never asked again
  const timedOut = failing(1, () => new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(req, [chain([best(token)], 0), timedOut.rpc], NOW)), { accepted: false, code: "rpc_error" });
  assert.equal(timedOut.asked.n, 1);
  // a fetch failure with no connect error (a TLS or protocol failure after the connection): never asked again
  const other = failing(1, () => new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(req, [chain([best(token)], 0), other.rpc], NOW)), { accepted: false, code: "rpc_error" });
}));

test("T8 a quote's reads go to each provider at most the chain's limit at once (Robinhood's own RPC answers 429 to four)", async () => {
  const token = "0x00000000000000000000000000000000000fe9fe";
  const inner = chain([best(token)], 1, 50_000_000);
  let [now, most] = [0, 0];
  const slow: EvmRpc = async (calls) => {
    most = Math.max(most, ++now);
    await new Promise((r) => setTimeout(r, 2));
    now--;
    return inner(calls);
  };
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "robinhood", token, amountIn: AMOUNT, slippageBps: 100, route: bestRoute(token) }, [chain([best(token)], 0, 50_000_000), slow], NOW));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.ok(most >= 1 && most <= 2, `${most} requests at once`);
});

test("T8b the reads' gate never has more than its limit in flight, however many wait and in whatever order they end", async () => {
  // the gate a quote puts before each of its providers (gated): a quote's rounds come one after another, so a slot a
  // release handed on twice shows only in the round after one that queued
  const gate = (quoteMod as unknown as { gateOf: (n: number) => <T>(f: () => Promise<T>) => Promise<T> }).gateOf(2);
  let [now, most] = [0, 0];
  const job = (ms: number) => gate(async () => {
    most = Math.max(most, ++now);
    await pause(ms);
    now--;
  });
  // a round of five, then a round of five more
  await Promise.all([5, 1, 3, 2, 4].map(job));
  await Promise.all([1, 2, 3, 4, 5].map(job));
  assert.equal(most, 2);
});

// card evm-route-parity: the buy and the sell route through one device-made set of pools (quote.ts routeSet), the sell
// held to a reference (review of evm-sell-device-quote, H1: a seeded hookless 1% pool was the sell's only candidate
// when the token's market sat where the sell could not route, and the device signed minOut = 0.99 x dust)
const SELL_W = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // Hardhat account 0, a published test key
// `bought` is required (review of edb4dbb, F3): by default the seeded pool's route, the one a server would send, so the
// sell must still find the token's market from its own set; null leaves it out
// The venues a sell reads unless a test names its own: Base with no sell delegate pinned, so a route through an unlisted
// hook keeps the lower of its two quotes ("keep-min", simRule), the rule these probes were written for; the kit pins
// Base's delegate since card pool-evm-deploy-mainnet, and DELEGATED below runs the sim
const { sellDelegate: _keepMin, ...BASE_NO_DELEGATE } = builder.evmPoolVenues().base;
const KEEP_MIN: builder.EvmPoolVenueList = Object.freeze({ ...builder.evmPoolVenues(), base: Object.freeze(BASE_NO_DELEGATE) });
const sellOn = (pools: ModelPool[], token: string, scan?: EvmRpc, bought: EvmRoute | null = seededRoute(token), slippageBps = 100, venues: builder.EvmPoolVenueList = KEEP_MIN, signSim?: EvmPoolSellQuoteRequest["signSim"]) =>
  evmPoolSellQuoteWith({ chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps, boughtBlock: 1n, sent: [], ...(bought !== null ? { bought } : {}), ...(signSim ? { signSim } : {}) } as EvmPoolSellQuoteRequest, [chain(pools, 0), chain(pools, 1)], NOW, scan, venues);
const sellVerdict = async (p: ReturnType<typeof sellOn>) => {
  try {
    const q = await p;
    return { accepted: true, amountOut: q.amountOut, minOut: q.minOut, route: q.route };
  } catch (e) {
    if (!(e instanceof EvmQuoteError)) throw e;
    return { accepted: false, code: e.code };
  }
};
const exits = (token: string, r: EvmRoute) => {
  try {
    evmSellRouteCheck("base", token, evmSellRouteOf(r));
    return "built";
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

test("P1 a seeded 1% pool with dust beside a deep pool the scan found: the sell leaves through the deep one", async () => {
  const token = "0x00000000000000000000000000000000000ba1ba";
  const deep: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const v = await sellVerdict(sellOn([seeded(token), deep], token, scanner(5_000_000, [{ key: deep.key, at: 4_500_000 }])));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.equal((v as { amountOut: bigint }).amountOut, AMOUNT);
  assert.deepEqual((v as { route: unknown }).route, { venue: "uniswap-v4", hops: [{ currency: NATIVE, fee: 2500, tickSpacing: 50, hooks: NATIVE, hookData: "0x" }] });
  // and the buy holds the same seeded pool to the same deep pool
  assert.deepEqual(await quoteOn([seeded(token), deep], token, seededRoute(token), scanner(5_000_000, [{ key: deep.key, at: 4_500_000 }])), below);
});

// card evm-sell-hook-converge: a sale through a pool behind a hook the venue does not list, picked where it sets the
// reference, at the reference's own output and minOut
const viaHook = (v: unknown, k: EvmPoolKey, out: bigint) =>
  assert.deepEqual(v, { accepted: true, amountOut: out, minOut: (out * 9900n) / 10000n, route: { venue: "uniswap-v4", hops: [{ currency: NATIVE, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, hookData: "0x" }] } }, show(v));

test("P2 the token's market behind a hook the venue does not list, and a seeded 1% pool: the sell leaves through the market at its minOut (card evm-sell-hook-converge), never signed at dust", async () => {
  const token = "0x00000000000000000000000000000000000ba2ba";
  const v = await sellVerdict(sellOn([seeded(token), real(token)], token, scanner(5_000_000, [{ key: real(token).key, at: 4_500_000 }])));
  viaHook(v, real(token).key, AMOUNT);
  // a found pool within the slippage of the pick does not refuse it
  const near: ModelPool = { key: keyOf(token, NATIVE, 0, 60, UNPINNED), give: (a) => a / 10n + a / 1000n };
  const w = await sellVerdict(sellOn([seeded(token), near], token, scanner(5_000_000, [{ key: near.key, at: 4_500_000 }])));
  assert.equal(w.accepted, true, String((w as { code?: string }).code));
});

test("P3 the pool the note was bought in is a candidate and a reference: a sell with no scan leaves through it", async () => {
  const token = "0x00000000000000000000000000000000000ba3ba";
  const bought: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 2500, tickSpacing: 50, hooks: NATIVE, hookData: "0x" }] };
  const v = await sellVerdict(sellOn([seeded(token), bought], token, undefined, route));
  assert.equal((v as { amountOut: bigint }).amountOut, AMOUNT, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)));
  // a bought route of another token is refused
  assert.deepEqual(await sellVerdict(sellOn([seeded(token), bought], token, undefined, seededRoute("0x00000000000000000000000000000000000ba4ba"))), { accepted: false, code: "token_mismatch" });
});

test("P4 a Zora coin's three-hop buy and its sell both build; an unlisted hook, or Zora's hook in another shape, on hop 2 is refused on both", async () => {
  const token = "0x00000000000000000000000000000000000fd2fd";
  const creator = xAt(0x421);
  const coinPool: ModelPool = { key: keyOf(token, creator, 0x800000, 200, ZORA_HOOK), give: (a) => a };
  const creatorPool: ModelPool = { key: keyOf(creator, ZORA, 0x800000, 200, ZORA_HOOK), give: (a) => a };
  const zoraMarket = marketOf(ZORA);
  const logs = [{ key: coinPool.key, at: 4_500_000 }, { key: creatorPool.key, at: 4_400_000 }, { key: zoraMarket.key, at: 4_050_000 }];
  const pools = [seeded(token), coinPool, creatorPool, zoraMarket];
  let ref: EvmRoute | undefined;
  await assert.rejects(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)), (e: unknown) => {
    ref = (e as EvmQuoteError).reference?.route;
    return e instanceof EvmQuoteError && e.code === "below_reference";
  });
  assert.ok(ref?.venue === "uniswap-v4" && ref.hops.length === 3, JSON.stringify(ref));
  const q = await evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: ref! }, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs));
  assert.equal(q.amountOut, AMOUNT);
  assert.equal(exits(token, q.route), "built");
  // the sell, from its own scan, leaves through the same three pools backwards
  const s = await sellOn(pools, token, scanner(5_000_000, logs));
  assert.equal(s.amountOut, AMOUNT);
  assert.deepEqual(s.route, evmSellRouteOf(q.route));
  // hop 2 (the creator coin's pool) with an unlisted hook, or with Zora's hook at another fee or tick spacing
  const hop2 = (o: Partial<{ hooks: string; fee: number; tickSpacing: number }>): EvmRoute => {
    const r = ref as EvmV4Route;
    return { ...r, hops: r.hops.map((h, i) => (i === 1 ? { ...h, ...o } : h)) };
  };
  // (the sell builder refuses it on any route its quote did not pick; the buy quote reads it as a route through a hook
  // the venue does not list, card evm-buy-hook-converge, and no such pool holds it)
  for (const o of [{ hooks: UNPINNED }, { fee: 3000 }, { tickSpacing: 60 }]) {
    assert.notEqual(exits(token, hop2(o)), "built", JSON.stringify(o));
    assert.deepEqual(await quoteOn(pools, token, hop2(o), scanner(5_000_000, logs)), { accepted: false, code: "no_quote" }, JSON.stringify(o));
  }
});

test("P5 a found pool of a pinned hook in a shape the venue does not list is priced with its hook replaced, as the sell builder does not take it", async () => {
  const token = "0x00000000000000000000000000000000000ba5ba";
  // Zora's hook on a 0.3% native pool: not Zora's listed shape; as it is, it pays ten times
  const odd: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, ZORA_HOOK), give: (a) => a / 20n, lie: (a) => 10n * a };
  const seen: { replaces: string[]; hooks: string[][] }[] = [];
  const v = await verdict(
    evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain([seeded(token), odd], 0, 5_000_000, seen), chain([seeded(token), odd], 1)], NOW, scanner(5_000_000, [{ key: odd.key, at: 4_500_000 }])),
  );
  // R is the lower of its two quotes, a twentieth: below the seeded tenth, so the seeded route goes through
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.ok(seen.some((o) => o.replaces.includes(ZORA_HOOK)), JSON.stringify(seen));
});

// The review of edb4dbb (probes PA-PG, re-run 12:17Z): F1 the sell goes one level further exactly where the
// buy does, where X has no market that fills; F2 the sell quotes the token into X once per pool and prices X's markets
// at that amount; F3 `bought` is required; F5 `bought` is read under the found pools' rule and kept only where the sell
// builder takes it; F6 minOut is the slippage off the reference. (PE, a hook that admits only the quoter, and F7 are
// card evm-quote-exec-sim's.)
const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x));
const zoraRoute = (creator: string, token: string): EvmRoute => ({
  venue: "uniswap-v4",
  currencyIn: NATIVE,
  hops: [
    { currency: ZORA.toLowerCase(), fee: 2500, tickSpacing: 50, hooks: NATIVE, hookData: "0x" },
    { currency: creator, fee: 0x800000, tickSpacing: 200, hooks: ZORA_HOOK, hookData: "0x" },
    { currency: token, fee: 0x800000, tickSpacing: 200, hooks: ZORA_HOOK, hookData: "0x" },
  ],
});
const zoraPools = (token: string, creator: string) => {
  const coinPool: ModelPool = { key: keyOf(token, creator, 0x800000, 200, ZORA_HOOK), give: (a) => a };
  const creatorPool: ModelPool = { key: keyOf(creator, ZORA, 0x800000, 200, ZORA_HOOK), give: (a) => a };
  return { coinPool, creatorPool, zoraMarket: marketOf(ZORA) };
};

test("PA (F1) a dust market of the creator coin does not hide a Zora coin's real market from the sell: it goes further, as the buy does", async () => {
  const token = "0x00000000000000000000000000000000000c0a0a";
  const creator = xAt(0x4a1);
  const { coinPool, creatorPool, zoraMarket } = zoraPools(token, creator);
  // the attacker's dust market of the creator coin: held, quotes 1 wei at any amount (it never fills)
  const dust: ModelPool = { key: keyOf(creator, NATIVE, 3000, 60, NATIVE), give: () => 1n };
  const logs = [{ key: coinPool.key, at: 4_500_000 }, { key: creatorPool.key, at: 4_400_000 }, { key: zoraMarket.key, at: 4_050_000 }, { key: dust.key, at: 4_060_000 }];
  const pools = [seeded(token), coinPool, creatorPool, zoraMarket, dust];
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs)), below, "buy");
  // bought: the seeded route a server would send; the sell still finds coin -> creator -> ZORA -> ETH
  const s = await sellVerdict(sellOn(pools, token, scanner(5_000_000, logs)));
  assert.equal((s as { amountOut?: bigint }).amountOut, AMOUNT, show(s));
  assert.deepEqual((s as { route?: unknown }).route, evmSellRouteOf(zoraRoute(creator, token)));
});

test("PB (F2) a junk currency with 8 dust markets and 8 dust pools does not use up the sell's quotes before the real market", async () => {
  const token = "0x00000000000000000000000000000000000c0b0b";
  const realX = xAt(0x5b0);
  const realPool: ModelPool = { key: keyOf(token, realX, 3000, 60, NATIVE), give: (a) => a };
  const realMarket = marketOf(realX);
  const realId = pidOf(realPool.key);
  // a junk currency whose smallest pool id with the token sorts before the real one (ground by fee)
  let junkX = "";
  let first: ModelPool | undefined;
  for (let i = 1; first === undefined; i++) {
    const x = xAt(0x600 + i);
    for (let f = 1; f < 400 && first === undefined; f++) {
      const k = keyOf(token, x, f, 1, NATIVE);
      if (pidOf(k) < realId) [junkX, first] = [x, { key: k, give: (a) => a / 1000n }];
    }
  }
  const junkPools: ModelPool[] = [first!, ...Array.from({ length: 7 }, (_, i): ModelPool => ({ key: keyOf(token, junkX, 1000 + i, 1, NATIVE), give: (a) => a / 1000n }))];
  const junkMarkets: ModelPool[] = Array.from({ length: 8 }, (_, i): ModelPool => ({ key: keyOf(junkX, NATIVE, 2000 + i, 1, NATIVE), give: (a) => a / 1000n }));
  const logs = [
    ...junkPools.map((p, i) => ({ key: p.key, at: 4_200_000 + i })),
    ...junkMarkets.map((p, i) => ({ key: p.key, at: 4_100_000 + i })),
    { key: realPool.key, at: 4_500_000 },
    { key: realMarket.key, at: 4_050_000 },
  ];
  const pools = [seeded(token), realPool, realMarket, ...junkPools, ...junkMarkets];
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs)), below, "buy");
  const s = await sellVerdict(sellOn(pools, token, scanner(5_000_000, logs)));
  assert.equal((s as { amountOut?: bigint }).amountOut, AMOUNT, show(s));
});

test("PC (F5) a `bought` route through an unlisted hook that lies to the quoter sets no reference: the sell leaves through the honest pool", async () => {
  const token = "0x00000000000000000000000000000000000c0c0c";
  const honest: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const liar: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => a / 2n, lie: (a) => 1000n * a };
  const logs = [{ key: honest.key, at: 4_500_000 }, { key: liar.key, at: 4_500_001 }];
  const viaScan = await sellVerdict(sellOn([honest, liar], token, scanner(5_000_000, logs)));
  assert.equal((viaScan as { amountOut?: bigint }).amountOut, AMOUNT, show(viaScan));
  const lieRoute: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 3000, tickSpacing: 60, hooks: UNPINNED, hookData: "0x" }] };
  const viaBought = await sellVerdict(sellOn([honest, liar], token, scanner(5_000_000, logs), lieRoute));
  assert.equal((viaBought as { amountOut?: bigint }).amountOut, AMOUNT, show(viaBought));
  // an honest pool behind the same hook at twice the market, that no scan found, is the sale's route through `bought`
  // (card evm-buy-hook-converge: a buy may enter through such a pool, so its sale leaves through it, by the sale's take
  // rule; another token: the scan of this one is kept in memory)
  const t2 = "0x00000000000000000000000000000000000c0c1c";
  const honest2: ModelPool = { key: keyOf(t2, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const twice: ModelPool = { key: keyOf(t2, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n) };
  const route2: EvmRoute = { ...lieRoute, hops: [{ ...lieRoute.hops[0]!, currency: t2 }] };
  const viaTwice = await sellVerdict(sellOn([honest2, twice], t2, scanner(5_000_000, [{ key: honest2.key, at: 4_500_000 }]), route2));
  viaHook(viaTwice, twice.key, 2n * AMOUNT);
});

test("PD (F6) with the best route unsellable, minOut is the slippage off the pick, never off a reference through a hook the venue does not list (review of 72e28658, M2: that hook places its own quote, so it would choose the pick's slippage)", async () => {
  const token = "0x00000000000000000000000000000000000c0d0d";
  const s = 2000;
  const best: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => a };
  const near: ModelPool = { key: keyOf(token, NATIVE, 10000, 200, NATIVE), give: (a) => (a * 8001n) / 10000n };
  const q = await sellVerdict(sellOn([best, near], token, scanner(5_000_000, [{ key: best.key, at: 4_500_000 }]), undefined, s));
  assert.equal(q.accepted, true, show(q));
  assert.equal((q as { minOut: bigint }).minOut, (((AMOUNT * 8001n) / 10000n) * BigInt(10000 - s)) / 10000n, show(q));
});

test("PF (F3) a seeded creator-coin market that fills at a tenth: with `bought` the sell leaves at the market; without it, no sell quote", async () => {
  const token = "0x00000000000000000000000000000000000c0f0f";
  const creator = xAt(0x4f1);
  const { coinPool, creatorPool, zoraMarket } = zoraPools(token, creator);
  const cheap: ModelPool = { key: keyOf(creator, NATIVE, 3000, 60, NATIVE), give: (a) => a / 10n };
  const logs = [{ key: coinPool.key, at: 4_500_000 }, { key: creatorPool.key, at: 4_400_000 }, { key: zoraMarket.key, at: 4_050_000 }, { key: cheap.key, at: 4_060_000 }];
  const pools = [coinPool, creatorPool, zoraMarket, cheap];
  const s = await sellVerdict(sellOn(pools, token, scanner(5_000_000, logs), zoraRoute(creator, token)));
  assert.equal((s as { amountOut?: bigint }).amountOut, AMOUNT, show(s));
  assert.deepEqual(await sellVerdict(sellOn(pools, token, scanner(5_000_000, logs), null)), { accepted: false, code: "bad_request" });
});

test("PG (F3) a Zora coin held past the scan depth: with `bought` the sell leaves at the market; without it, no sell quote", async () => {
  const token = "0x00000000000000000000000000000000000c1a1a";
  const creator = xAt(0x4c1);
  const { coinPool, creatorPool, zoraMarket } = zoraPools(token, creator);
  // every log before the depth's floor (head 5,000,000 - 1,000,000 + 1)
  const logs = [{ key: coinPool.key, at: 3_900_000 }, { key: creatorPool.key, at: 3_800_000 }, { key: zoraMarket.key, at: 3_700_000 }];
  const pools = [seeded(token), coinPool, creatorPool, zoraMarket];
  const withBought = await sellVerdict(sellOn(pools, token, scanner(5_000_000, logs), zoraRoute(creator, token)));
  assert.equal((withBought as { amountOut?: bigint }).amountOut, AMOUNT, show(withBought));
  assert.deepEqual(await sellVerdict(sellOn(pools, token, scanner(5_000_000, logs), null)), { accepted: false, code: "bad_request" });
});

test("PB2 (F2) the sell prices X's markets at the X its pool gives, not at the user's amount of the token", async () => {
  const token = "0x00000000000000000000000000000000000c0b1b";
  const x = xAt(0x5c0);
  // the token's pool with X gives a thousandth; X's thin market pays twice the deep one's for up to a hundredth of the
  // amount and runs out above it
  const pool: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a / 1000n };
  const thin: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, NATIVE), give: (a) => (a <= AMOUNT / 100n ? 2n * a : AMOUNT / 50n), state: pricedInto1(2n) };
  const deep = marketOf(x);
  const s = await sellVerdict(sellOn([pool, thin, deep], token, scanner(5_000_000, [{ key: pool.key, at: 4_500_000 }])));
  assert.equal((s as { amountOut?: bigint }).amountOut, (2n * AMOUNT) / 1000n, show(s));
});

// ------------------------------------------------------------------ the review of c71a4d0..a9f1d32 (card evm-quote-one-round)
// No bound may move the pool that sets the reference out of the reads: each bound refuses, never cuts.
test("review of a9f1d32, HIGH: 64 dust pools with ids below the real pool's are quoted beside it, and a seeded route is held to it", async () => {
  const token = "0x00000000000000000000000000000000000d66d6";
  const realId = pidOf(real(token).key);
  const dust: ModelPool[] = [];
  for (let fee = 1; dust.length < 64; fee++) {
    if (fee === 100 || fee === 500 || fee === 3000 || fee === 10000) continue;
    const k = keyOf(token, NATIVE, fee, 7, NATIVE);
    if (pidOf(k) < realId) dust.push({ key: k, give: (a) => a / 1000n, state: [atTick(128), 10n ** 6n] });
  }
  const deep: ModelPool = { ...real(token), state: [atTick(128), 10n ** 20n] };
  const logs = [{ key: deep.key, at: 4_500_000 }, ...dust.map((d, i) => ({ key: d.key, at: 4_100_000 + i }))];
  assert.deepEqual(await quoteOn([seeded(token), deep, ...dust], token, seededRoute(token), scanner(5_000_000, logs)), below);
});

test("review of a9f1d32, HIGH: 16,000 and 16,381 empty pools of the token leave the real X's markets read, and a seeded route is held to the X route", async () => {
  for (const n of [16_000, 16_381]) {
    const token = n === 16_000 ? "0x00000000000000000000000000000000000d55d5" : "0x00000000000000000000000000000000000d44d4";
    const x0 = xAt(n === 16_000 ? 0x1700 : 0x1701); // X addresses no other test scans (the scan cache is shared in the file)
    const realX: ModelPool = { key: keyOf(token, x0, 3000, 60, NATIVE), give: (a) => a };
    const market = marketOf(x0);
    const junk = Array.from({ length: n }, (_, i) => ({ key: keyOf(token, NATIVE, 1000 + i, 1, NATIVE), at: 4_000_001 + 49 * i }));
    const logs = [{ key: realX.key, at: 4_000_100 }, { key: market.key, at: 4_050_000 }, ...junk];
    const pools = [seeded(token), realX, market];
    assert.deepEqual(await verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) }, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs))), below, `${n} empty pools`);
  }
});

test("review of a9f1d32, HIGH (route-parity probe): one junk X with 64 held dust markets, sorted before the real X, leaves the real X's market quoted", async () => {
  const token = "0x0000000000000000000000000000000000c7c7c7";
  const realX = xAt(0x8b0);
  const realPool: ModelPool = { key: keyOf(token, realX, 3000, 60, NATIVE), give: (a) => a };
  const realMarket = marketOf(realX);
  const realId = pidOf(realPool.key);
  let junkX = "";
  let first: ModelPool | undefined;
  for (let i = 1; first === undefined; i++) {
    const x = xAt(0x900 + i);
    for (let f = 1; f < 400 && first === undefined; f++) {
      const k = keyOf(token, x, f, 1, NATIVE);
      if (pidOf(k) < realId) [junkX, first] = [x, { key: k, give: (a) => a / 1000n }];
    }
  }
  const junkMarkets = Array.from({ length: 64 }, (_, i): ModelPool => ({ key: keyOf(junkX, NATIVE, 2000 + i, 1, NATIVE), give: (a) => a / 1000n }));
  const logs = [{ key: first!.key, at: 4_200_000 }, ...junkMarkets.map((p, i) => ({ key: p.key, at: 4_100_000 + i })), { key: realPool.key, at: 4_500_000 }, { key: realMarket.key, at: 4_050_000 }];
  assert.deepEqual(await quoteOn([seeded(token), realPool, realMarket, first!, ...junkMarkets], token, seededRoute(token), scanner(5_000_000, logs)), below);
});

test("review of a9f1d32, LOW 1: the caller's 16 pools never push a token past the bound: 16,370 found pools and 16 made-up ones still quote", async () => {
  const token = "0x00000000000000000000000000000000000d33d3";
  const junk = Array.from({ length: 16_370 }, (_, i) => ({ key: keyOf(token, NATIVE, 1000 + i, 1, NATIVE), at: 4_000_001 + 49 * i }));
  const hints = Array.from({ length: 16 }, (_, i) => keyOf(token, NATIVE, 900_000 + i, 3, NATIVE));
  const v = await quoteOn([best(token)], token, bestRoute(token), scanner(5_000_000, junk), hints);
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
});

test("review of a9f1d32, MEDIUM: a catch-up whose logs come from a backend that lags the head its provider named refuses, and the next quote still finds the pool", async () => {
  // (the probe's provider: a head read on a fresh backend proves nothing about the lagging one answering the logs)
  const token = "0x00000000000000000000000000000000000d77d7";
  const pools = [seeded(token), real(token)];
  const lagHead = scanner(4_999_900, [{ key: real(token).key, at: 4_999_950 }]);
  const freshHead = scanner(5_000_000, []);
  let heads = 0;
  // the first head from a lagging backend, the head asked again from a fresh one, every other request on the lagging one
  const lb: EvmRpc = async (calls) => {
    if (calls[0]!.method === "eth_blockNumber") return (heads++ > 0 ? freshHead : lagHead)(calls);
    const out = (await lagHead(calls)) as { result?: unknown }[];
    return out.map((o, i) => (calls[i]!.method !== "eth_getLogs" ? o : { ...o, result: (o.result as { blockNumber: string }[]).filter((l) => Number(l.blockNumber) <= 4_999_900) }));
  };
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), lb), { accepted: false, code: "rpc_disagree" });
  // nothing was kept past what the scan read: the next quote, on an honest provider, scans the gap and finds the pool
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_002, [{ key: real(token).key, at: 4_999_950 }]), undefined, "base", 5_000_002), below);
});

test("card evm-quote-one-round: pools that cannot beat the route are never quoted and never count; past EVM_QUOTE_MAX_QUOTED routes that could, or EVM_QUOTE_MAX_OTHER currencies, the quote refuses (too_many_pools), never cuts", async () => {
  // one past each bound of 1,024 (EVM_QUOTE_MAX_QUOTED, EVM_QUOTE_MAX_OTHER), named here so a looser bound fails
  const n = 1_025;
  // the route at ten times the price; 1,025 pools at the price of 1 cannot beat it
  const token = "0x00000000000000000000000000000000000d88d8";
  const dust = Array.from({ length: n }, (_, i): ModelPool => ({ key: keyOf(token, NATIVE, 1000 + i, 1, NATIVE), give: (a) => a / 1000n }));
  const v1 = await quoteOn([best(token), ...dust], token, bestRoute(token), scanner(5_000_000, dust.map((d, i) => ({ key: d.key, at: 4_000_001 + 49 * i }))));
  assert.equal(v1.accepted, true, String((v1 as { code?: string }).code));
  // 1,025 at the route's own price could beat it: none is cut, so the quote refuses
  const t2 = "0x00000000000000000000000000000000000d88d9";
  const could = Array.from({ length: n }, (_, i): ModelPool => ({ key: keyOf(t2, NATIVE, 1000 + i, 1, NATIVE), give: (a) => a / 1000n, state: pricedAt(10n) }));
  assert.deepEqual(await quoteOn([best(t2), ...could], t2, bestRoute(t2), scanner(5_000_000, could.map((d, i) => ({ key: d.key, at: 4_000_001 + 49 * i })))), { accepted: false, code: "too_many_pools" });
  // 1,025 currencies paired with the token: past EVM_QUOTE_MAX_OTHER
  const t3 = "0x00000000000000000000000000000000000daad0";
  const xs = Array.from({ length: n }, (_, i): ModelPool => ({ key: keyOf(t3, xAt(0x1000 + i), 3000, 60, NATIVE), give: (a) => a / 1000n }));
  assert.deepEqual(await quoteOn([best(t3), ...xs], t3, bestRoute(t3), scanner(5_000_000, xs.map((x, i) => ({ key: x.key, at: 4_000_001 + 49 * i })))), { accepted: false, code: "too_many_pools" });
  // one currency with no market and pools with 1,025 others, one level further: past EVM_QUOTE_MAX_OTHER with them
  const t4 = "0x00000000000000000000000000000000000daad1";
  const x4 = xAt(0x2c00);
  const ys = Array.from({ length: n }, (_, i): ModelPool => ({ key: keyOf(x4, xAt(0x3000 + i), 7000, 1, NATIVE), give: (a) => a / 1000n }));
  const four = [best(t4), { key: keyOf(t4, x4, 3000, 60, NATIVE), give: (a: bigint) => a / 1000n }, ...ys];
  assert.deepEqual(await quoteOn(four, t4, bestRoute(t4), scanner(5_000_000, four.slice(1).map((x, i) => ({ key: x.key, at: 4_000_001 + 49 * i })))), { accepted: false, code: "too_many_pools" });
});


// EVM_QUOTE_MAX_KEYS counts the scan's pools and refuses past them: the token's, X's markets and X's other pools alike
const empties = (token: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: keyOf(token, NATIVE, 1000 + i, 1, NATIVE), at: 4_000_001 + 15 * i }));
test("KB1 the caller's 16 pools never push a token past EVM_QUOTE_MAX_KEYS (review of a9f1d32, LOW 1): 6 under it and 16 made-up pools still quote", { timeout: 60_000 }, async () => {
  const t1 = "0x00000000000000000000000000000000000dbbd0";
  const hints = Array.from({ length: 16 }, (_, i) => keyOf(t1, NATIVE, 900_000 + i, 3, NATIVE));
  const v1 = await quoteOn([best(t1)], t1, bestRoute(t1), scanner(5_000_000, empties(t1, EVM_QUOTE_MAX_KEYS - 6)), hints);
  assert.equal(v1.accepted, true, String((v1 as { code?: string }).code));
});
test("KB2 one found pool past EVM_QUOTE_MAX_KEYS refuses (too_many_pools)", { timeout: 60_000 }, async () => {
  const t2 = "0x00000000000000000000000000000000000dccd0";
  assert.deepEqual(await quoteOn([best(t2)], t2, bestRoute(t2), scanner(5_000_000, empties(t2, EVM_QUOTE_MAX_KEYS + 1))), { accepted: false, code: "too_many_pools" });
});
test("KB3 a held X pool whose markets pass what EVM_QUOTE_MAX_KEYS leaves refuses (too_many_pools), never prices the token without them", { timeout: 60_000 }, async () => {
  // two left for X's markets: its standard and pinned shapes are more than two
  const t3 = "0x00000000000000000000000000000000000ddd00";
  const x3 = xAt(0x1800);
  // at the best route's price, so the prune keeps X's markets
  const p3: ModelPool = { key: keyOf(t3, x3, 3000, 60, NATIVE), give: (a) => 10n * a, state: pricedAt(10n) };
  const logs3 = [{ key: p3.key, at: 4_999_000 }, { key: marketOf(x3).key, at: 4_999_001 }, ...empties(t3, EVM_QUOTE_MAX_KEYS - 3)];
  assert.deepEqual(await quoteOn([best(t3), p3, marketOf(x3)], t3, bestRoute(t3), scanner(5_000_000, logs3)), { accepted: false, code: "too_many_pools" });
});
test("KB4 an X with no market that holds, whose other pools pass what EVM_QUOTE_MAX_KEYS leaves, refuses (too_many_pools)", { timeout: 60_000 }, async () => {
  // room for X's markets, none of which holds, but not for X's 64 pools with other currencies, read one level further
  const t4 = "0x00000000000000000000000000000000000dee00";
  const x4 = xAt(0x1801);
  const p4: ModelPool = { key: keyOf(t4, x4, 3000, 60, NATIVE), give: (a) => a };
  const vias = Array.from({ length: 64 }, (_, i) => ({ key: keyOf(x4, xAt(0x1900 + i), 3000, 60, NATIVE), at: 4_999_100 + i }));
  const logs4 = [{ key: p4.key, at: 4_999_000 }, ...vias, ...empties(t4, EVM_QUOTE_MAX_KEYS - 40)];
  assert.deepEqual(await quoteOn([best(t4), p4], t4, bestRoute(t4), scanner(5_000_000, logs4)), { accepted: false, code: "too_many_pools" });
});

// ------------------------------------------------------------------ the prune (card evm-quote-one-round, review of 13a063e)
// v4-core TickMath.getSqrtPriceAtTick, bit for bit (each factor is 2^128 / sqrt(1.0001)^(2^i)), for the model's states
const MIN_TICK = -887272;
const MAX_TICK = 887272;
// v4-core TickMath.getSqrtPriceAtTick, bit for bit (each factor is 2^128 / sqrt(1.0001)^(2^i))
const TICK_FACTORS = [
  0xfffcb933bd6fad37aa2d162d1a594001n, 0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n, 0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n, 0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n,
];
function evmSqrtPriceAtTick(tick: number): bigint {
  const t = Math.min(MAX_TICK, Math.max(MIN_TICK, tick));
  const abs = Math.abs(t);
  let ratio = abs & 1 ? TICK_FACTORS[0]! : 1n << 128n;
  for (let i = 1; i < 20; i++) if (abs & (1 << i)) ratio = (ratio * TICK_FACTORS[i]!) >> 128n;
  if (t > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
// the sizes the depth-ranked cut of 13a063e kept (64 direct pools, 16 currencies), each now an attack on the prune
const EVM_QUOTE_TOP_DIRECT = 64;
const EVM_QUOTE_TOP_X = 16;
// slot0 at `tick`: its sqrt price and the tick, as v4 keeps them
const atTick = (tick: number) => evmSqrtPriceAtTick(tick) | (BigInt.asUintN(24, BigInt(tick)) << 160n);
// `n` pools of the token with the native asset whose ids sort below `below`'s, each as `make` sets it
const groundBelow = (token: string, belowId: string, n: number, spacing: number, make: (key: EvmPoolKey) => ModelPool): ModelPool[] => {
  const out: ModelPool[] = [];
  for (let fee = 1; out.length < n; fee++) {
    if (fee === 100 || fee === 500 || fee === 3000 || fee === 10000) continue;
    const k = keyOf(token, NATIVE, fee, spacing, NATIVE);
    if (pidOf(k) < belowId) out.push(make(k));
  }
  return out;
};
test("RK1 dust pools, narrow positions with the price inside them that read more liquidity than the real pool, and empty pools, every id below the real pool's, never push it out: each that could beat the route is quoted", async () => {
  const token = "0x00000000000000000000000000000000000d1d10";
  const realPool: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a, state: [atTick(128), 10n ** 19n] };
  const id = pidOf(realPool.key);
  const dust = groundBelow(token, id, EVM_QUOTE_TOP_DIRECT, 7, (key) => ({ key, give: (a) => a / 1000n, state: [atTick(128), 10n ** 6n] }));
  const narrow = groundBelow(token, id, EVM_QUOTE_TOP_DIRECT + 64, 1, (key) => ({ key, give: (a) => a / 1000n, state: [atTick(128), 5n * 10n ** 20n], ticks: [127, 129] })).slice(64);
  const empty = groundBelow(token, id, EVM_QUOTE_TOP_DIRECT, 3, (key) => ({ key, give: (a) => a / 1000n, state: [atTick(128), 0n] }));
  const pools = [seeded(token), realPool, ...dust, ...narrow, ...empty];
  const logs = pools.slice(1).map((p, i) => ({ key: p.key, at: 4_100_000 + i }));
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs)), below);
});
test("RK2 64 pools that each hold more of the token in range than the real pool, ids below it, never push it out (the cut of 13a063e let them)", async () => {
  const token = "0x00000000000000000000000000000000000d2d20";
  const realPool: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a, state: [atTick(128), 10n ** 19n] };
  const deeper = groundBelow(token, pidOf(realPool.key), EVM_QUOTE_TOP_DIRECT, 7, (key) => ({ key, give: (a) => a / 1000n, state: [atTick(128), 10n ** 21n] }));
  const pools = [seeded(token), realPool, ...deeper];
  const logs = pools.slice(1).map((p, i) => ({ key: p.key, at: 4_100_000 + i }));
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs)), below);
});
test("RK3 pools that cannot beat the route (all of the amount at their spot price after their fee is less than Q) are dropped and never count: 1,025 of them beside the real pool still quote", async () => {
  const token = "0x00000000000000000000000000000000000d3d30";
  const realPool: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a, state: [atTick(128), 10n ** 22n] };
  // at a twentieth of the price (at most 0.05 of the amount), under the seeded route's tenth
  const cheap = Array.from({ length: 1_025 }, (_, i): ModelPool => ({ key: keyOf(token, NATIVE, 20_000 + i, 7, NATIVE), give: (a) => a / 1000n, state: [atTick(-30_000), 10n ** 24n] }));
  const pools = [seeded(token), realPool, ...cheap];
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, pools.slice(1).map((p, i) => ({ key: p.key, at: 4_100_000 + i })))), below);
  // the fee counts: a pool at exactly the route's price with a 0.3% fee cannot beat it, one with none can
  const t2 = "0x00000000000000000000000000000000000d3d31";
  const atRoute = (fee: bigint) => (i: number): ModelPool => ({ key: keyOf(t2, NATIVE, 30_000 + i, 7, NATIVE), give: (a) => a / 1000n, state: [pricedAt(10n)[0] / 10n | (fee << 208n), 10n ** 20n] });
  const seeded10: ModelPool = { ...seeded(t2), state: pricedAt(1n) };
  const feed = Array.from({ length: 1_025 }, (_, i) => atRoute(3000n)(i));
  const v = await quoteOn([seeded10, ...feed], t2, seededRoute(t2), scanner(5_000_000, feed.map((p, i) => ({ key: p.key, at: 4_100_000 + i }))));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  const free = Array.from({ length: 1_025 }, (_, i) => atRoute(0n)(i));
  const t3 = "0x00000000000000000000000000000000000d3d32";
  const free3 = free.map((p) => ({ ...p, key: keyOf(t3, NATIVE, p.key.fee, 7, NATIVE) }));
  assert.deepEqual(await quoteOn([{ ...seeded(t3), state: pricedAt(1n) }, ...free3], t3, seededRoute(t3), scanner(5_000_000, free3.map((p, i) => ({ key: p.key, at: 4_100_000 + i })))), { accepted: false, code: "too_many_pools" });
});
test("RK4 sixteen junk currencies whose pools with the token read more liquidity in one tick, or dust, ids below, and the real currency's own one-tick pools never push the real pool out", async () => {
  // the token below every X, so each pool of the token is bought toward a higher price (currency0 out)
  const token = "0x000000000000000000000000000000000000d4d4";
  const x = xAt(0x2000);
  const realPool: ModelPool = { key: keyOf(token, x, 2500, 50, NATIVE), give: (a) => a, state: [atTick(-300), 10n ** 20n] };
  const id = pidOf(realPool.key);
  const oneTick = (key: EvmPoolKey): ModelPool => ({ key, give: (a) => a / 1000n, state: [atTick(-300), 10n ** 21n], ticks: [-300, -299] });
  const siblings: ModelPool[] = [];
  for (let fee = 1; siblings.length < 4; fee++) {
    const k = keyOf(token, x, fee, 1, NATIVE);
    if (pidOf(k) < id) siblings.push(oneTick(k));
  }
  const low = siblings.reduce((m, p) => (pidOf(p.key) < m ? pidOf(p.key) : m), id);
  const junk: ModelPool[] = [];
  for (let i = 0; junk.length < EVM_QUOTE_TOP_X; i++) {
    const k = keyOf(token, xAt(0x4000 + i), 1, 1, NATIVE);
    if (pidOf(k) < low) junk.push(junk.length % 2 === 0 ? oneTick(k) : { key: k, give: (a) => a / 1000n, state: [atTick(-300), 10n ** 6n] });
  }
  const pools = [seeded(token), marketOf(x), ...junk, ...siblings, realPool];
  const logs = pools.slice(1).map((p, i) => ({ key: p.key, at: 4_100_000 + i }));
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs)), below);
});
test("RK5 narrow markets of a currency with the price inside them, ids below, never push its real market out", async () => {
  const token = "0x00000000000000000000000000000000000d5d50";
  const x = xAt(0x2100);
  const realPool: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  const market: ModelPool = { key: keyOf(x, NATIVE, 2500, 50, NATIVE), give: (a) => a, state: [atTick(128), 10n ** 20n] };
  const narrow: ModelPool[] = [];
  for (let fee = 1; narrow.length < 8; fee++) {
    const k = keyOf(x, NATIVE, fee, 1, NATIVE);
    if (pidOf(k) < pidOf(market.key)) narrow.push({ key: k, give: (a) => a / 1000n, state: [atTick(128), 10n ** 30n], ticks: [127, 129] });
  }
  const pools = [seeded(token), realPool, market, ...narrow];
  const logs = pools.slice(1).map((p, i) => ({ key: p.key, at: 4_100_000 + i }));
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs)), below);
});
test("RK6 a sell drops nothing: among 64 junk pools of the token with ids below, it leaves through the real one", async () => {
  const token = "0x00000000000000000000000000000000000d6d60";
  // the token is currency1: a sell pays it for the native asset, so a price below 1 lets a pool give the amount
  const realPool: ModelPool = { key: keyOf(token, NATIVE, 2500, 1, NATIVE), give: (a) => a, state: [atTick(-128), 10n ** 20n] };
  const junk = Array.from({ length: EVM_QUOTE_TOP_DIRECT }, (_, i): ModelPool => ({ key: keyOf(token, NATIVE, 3000 + i, 1, NATIVE), give: (a) => a / 1000n, state: [atTick(-128), 10n ** 21n] }));
  const pools = [seeded(token), realPool, ...junk];
  const v = await sellVerdict(sellOn(pools, token, scanner(5_000_000, pools.slice(1).map((p, i) => ({ key: p.key, at: 4_100_000 + i })))));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.equal((v as { amountOut: bigint }).amountOut, AMOUNT);
});
test("RK7 one level further, every via that could beat the route is quoted: four junk pools of X with other currencies, ids below, never push out X's real pool with Y (review of 13a063e, LOW 2)", async () => {
  const token = "0x00000000000000000000000000000000000d7d70";
  const x = xAt(0x2900);
  const y = xAt(0x2a00);
  // X has no market: the token's pool with X is priced through X's pool with Y and Y's market
  const coinPool: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  const via: ModelPool = { key: keyOf(x, y, 2500, 50, NATIVE), give: (a) => a };
  const viaId = pidOf(via.key);
  const junk: ModelPool[] = [];
  for (let i = 0; junk.length < 4; i++) {
    const k = keyOf(x, xAt(0x2b00 + i), 7000, 1, NATIVE);
    if (pidOf(k) < viaId) junk.push({ key: k, give: (a) => a / 1000n });
  }
  const pools = [seeded(token), coinPool, via, marketOf(y), ...junk, ...junk.map((j) => marketOf(j.key.currency0 === x ? j.key.currency1 : j.key.currency0))];
  const logs = pools.slice(1).map((p, i) => ({ key: p.key, at: 4_100_000 + i }));
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs)), below);
});

test("RK8 the bound is the amount at the spot price after the fee, no less: a pool it puts one ten-millionth above the route is quoted and holds the route to it, bought into currency1 or into currency0", async () => {
  // into currency1, a shape no standard route reads: 0.3% fee, price 1,000,001 / 9,970,000, so at most 0.10000001 of
  // the amount; it gives that
  const token = "0x00000000000000000000000000000000000d8d80";
  const sq1 = isqrt((1_000_001n << 192n) / 9_970_000n) + 1n;
  const direct: ModelPool = { key: keyOf(token, NATIVE, 3001, 7, NATIVE), give: (a) => (a * 10_000_001n) / 100_000_000n, state: [sq1 | (3000n << 208n), 10n ** 20n] };
  // 64 pools at a twentieth of the price beside it, so that it is read after the first round, where the prune is
  const cheap = Array.from({ length: 64 }, (_, i): ModelPool => ({ key: keyOf(token, NATIVE, 20_000 + i, 7, NATIVE), give: (a) => a / 1000n, state: [atTick(-30_000), 10n ** 24n] }));
  const pools = [seeded(token), direct, ...cheap];
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, pools.slice(1).map((p, i) => ({ key: p.key, at: 4_100_000 + i })))), below);
  // into currency0, through X's market at a price of 1: the token below X, price 9,970,000 / 1,000,001 X per token
  const t2 = "0x0000000000000000000000000000000000000d81";
  const x = xAt(0x2d00);
  const sq0 = isqrt((9_970_000n << 192n) / 1_000_001n);
  const viaX: ModelPool = { key: keyOf(t2, x, 3001, 7, NATIVE), give: (a) => (a * 10_000_001n) / 100_000_000n, state: [sq0 | (3000n << 208n), 10n ** 20n] };
  const p2 = [seeded(t2), marketOf(x), viaX];
  assert.deepEqual(await quoteOn(p2, t2, seededRoute(t2), scanner(5_000_000, p2.slice(1).map((p, i) => ({ key: p.key, at: 4_100_000 + i })))), below);
});

// The review of 13a063e, HIGH: a dust position just past the real pool's price initialized a tick next to it, the
// depth-ranked cut read the real pool as under one tick spacing deep and pushed it out, and a seeded route at a tenth
// was bought. Each probe runs without the dust position and with it; both are held to the real pool now. A pool
// bought toward a higher price at tick 20 gives 0.99 of the amount: at most 0.9955 after its 0.25% fee
const probe = async (name: string, make: (dust: boolean) => { token: string; pools: ModelPool[] }) => {
  for (const dust of [false, true]) {
    const { token, pools } = make(dust);
    const logs = pools.slice(1).map((p, i) => ({ key: p.key, at: 4_100_000 + i }));
    assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs)), below, `${name} ${dust ? "with" : "without"} the dust tick`);
  }
};
test("PROBE A (review of 13a063e, HIGH): four pools of the token with X priced so nobody buys, and a dust tick next to the real pool's price, never push it out", () =>
  probe("A", (dust) => {
    const token = dust ? "0x000000000000000000000000000000000000a1a2" : "0x000000000000000000000000000000000000a1a1";
    const x = xAt(dust ? 0x2301 : 0x2300);
    const realPool: ModelPool = { key: keyOf(token, x, 2500, 50, NATIVE), give: (a) => (a * 99n) / 100n, state: [atTick(20), 10n ** 20n], ticks: dust ? [50, 100] : [] };
    const attackers = Array.from({ length: 4 }, (_, i): ModelPool => ({ key: keyOf(token, x, 7000 + i, 1, NATIVE), give: (a) => a / 1000n, state: [atTick(60_000), 5n * 10n ** 20n], ticks: [60_000, 60_160] }));
    return { token, pools: [seeded(token), marketOf(x), realPool, ...attackers] };
  }));
test("PROBE A2 (review of 13a063e, HIGH): four markets of X priced so nobody buys, and a dust tick next to X's real market's price, never push it out", () =>
  probe("A2", (dust) => {
    const token = dust ? "0x00000000000000000000000000000000000fa2a2" : "0x00000000000000000000000000000000000fa2a1";
    const x = xAt(dust ? 0x2311 : 0x2310);
    const realX: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
    const market: ModelPool = { key: keyOf(x, NATIVE, 2500, 50, NATIVE), give: (a) => a, state: [atTick(12_020), 10n ** 20n], ticks: dust ? [11_950, 12_000] : [] };
    const fake = Array.from({ length: 4 }, (_, i): ModelPool => ({ key: keyOf(x, NATIVE, 8000 + i, 1, NATIVE), give: (a) => a / 1000n, state: [atTick(-59_950), 10n ** 21n], ticks: [-60_160] }));
    return { token, pools: [seeded(token), realX, market, ...fake] };
  }));
test("PROBE B (review of 13a063e, HIGH): sixteen junk currencies, each one pool with the token priced so nobody buys, and a dust tick next to the real pool's price, never push the real currency out", () =>
  probe("B", (dust) => {
    const token = dust ? "0x000000000000000000000000000000000000a4a2" : "0x000000000000000000000000000000000000a4a1";
    const x = xAt(dust ? 0x2331 : 0x2330);
    const realPool: ModelPool = { key: keyOf(token, x, 2500, 50, NATIVE), give: (a) => (a * 99n) / 100n, state: [atTick(20), 10n ** 20n], ticks: dust ? [50, 100] : [] };
    const junk = Array.from({ length: EVM_QUOTE_TOP_X }, (_, i): ModelPool => ({ key: keyOf(token, xAt((dust ? 0x2500 : 0x2600) + i), 7000, 1, NATIVE), give: (a) => a / 1000n, state: [atTick(60_000), 5n * 10n ** 20n], ticks: [60_000, 60_160] }));
    return { token, pools: [seeded(token), marketOf(x), realPool, ...junk] };
  }));
test("PROBE D (review of 13a063e, HIGH): 64 pools of the token priced at the seeded route's level, and a dust tick next to the real pool's price, never push it out", () =>
  probe("D", (dust) => {
    const token = dust ? "0x000000000000000000000000000000000000a5a2" : "0x000000000000000000000000000000000000a5a1";
    const realPool: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a, state: [atTick(12_020), 10n ** 19n], ticks: dust ? [11_950, 12_000] : [] };
    const fake = Array.from({ length: EVM_QUOTE_TOP_DIRECT }, (_, i): ModelPool => ({ key: keyOf(token, NATIVE, 20_000 + i, 7, NATIVE), give: (a) => a / 1000n, state: [atTick(-19_000), 2n * 10n ** 18n], ticks: [-19_712] }));
    return { token, pools: [seeded(token), realPool, ...fake] };
  }));
test("PROBE E (review of 13a063e, HIGH): four pools of X with junk currencies, and a dust tick next to the price of X's real pool with Y, never push it out", () =>
  probe("E", (dust) => {
    const token = dust ? "0x000000000000000000000000000000000000a6a2" : "0x000000000000000000000000000000000000a6a1";
    const x = xAt(dust ? 0x2341 : 0x2340);
    const y = xAt(dust ? 0x2351 : 0x2350);
    const coinPool: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
    const via: ModelPool = { key: keyOf(x, y, 2500, 50, NATIVE), give: (a) => (a * 99n) / 100n, state: [atTick(20), 10n ** 20n], ticks: dust ? [50, 100] : [] };
    const junk = Array.from({ length: 4 }, (_, i): ModelPool => ({ key: keyOf(x, xAt((dust ? 0x2700 : 0x2800) + i), 7000, 1, NATIVE), give: (a) => a / 1000n, state: [atTick(60_000), 5n * 10n ** 20n], ticks: [60_000, 60_160] }));
    return { token, pools: [seeded(token), coinPool, via, marketOf(y), ...junk] };
  }));
test("PROBE C (review of 13a063e, LOW 1): a pool behind a pinned hook, which runs as it is, has no bound: one that fills past its read curve is quoted and holds a seeded route to it", async () => {
  const token = "0x000000000000000000000000000000000000a3a3";
  const x = xAt(0x2320);
  // the read state prices the token at 1/403 of X; the hook fills the amount
  const hooked: ModelPool = { key: keyOf(token, x, 0x800000, 200, CLANKER), give: (a) => a, state: [atTick(60_000), 10n ** 20n] };
  const pools = [seeded(token), marketOf(x), hooked];
  const logs = pools.slice(1).map((p, i) => ({ key: p.key, at: 4_100_000 + i }));
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs)), below);
});

// card evm-quote-exec-sim: a route through a hook the venue does not list sets the sell's reference only where W's own
// sell through it executes at that price (an eth_call of SellDelegate.sell from W at the agreed block); Base's venue
// here with a sell delegate pinned, as pool-evm-deploy pins it
// and the helper's EVM pool sender pinned as its sell sender (Hardhat account 1, a published test key's address)
const SENDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const DELEGATED: builder.EvmPoolVenueList = Object.freeze({ ...builder.evmPoolVenues(), base: Object.freeze({ ...builder.evmPoolVenues().base, sellDelegate: "0x00000000000000000000000000000000de1e9a7e", sellSender: SENDER }) });
const signed: { deadline: bigint; ts: bigint }[] = [];
const signSim: EvmPoolSellQuoteRequest["signSim"] = (sim, ts) => (signed.push({ deadline: sim.deadline, ts }), new Uint8Array(65));

test("PE a pool behind a hook that lets only the quoter trade, priced above the market, freezes no sell where the sell delegate is pinned", async () => {
  const token = "0x00000000000000000000000000000000000c0e0e";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  // twice the market to the quoter, hook replaced or as it is; W's own swap is refused
  const blocker: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: () => null };
  const logs = [{ key: market.key, at: 4_500_000 }, { key: blocker.key, at: 4_500_001 }];
  signed.length = 0;
  const s = await sellVerdict(sellOn([market, blocker], token, scanner(5_000_000, logs), undefined, 100, DELEGATED, signSim));
  assert.equal((s as { amountOut?: bigint }).amountOut, AMOUNT, show(s));
  // W signed one sim, its deadline the agreed block's own time
  assert.deepEqual(signed, [{ deadline: BigInt(T), ts: BigInt(T) }]);
  // the same pool, honest to W too, still sets the reference: the seeded route is refused
  const t2 = "0x00000000000000000000000000000000000c0e1e";
  const honest: ModelPool = { key: keyOf(t2, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n) };
  const h = await sellVerdict(sellOn([seeded(t2), honest], t2, scanner(5_000_000, [{ key: honest.key, at: 4_500_001 }]), undefined, 100, DELEGATED, signSim));
  // and the sale goes through it at that price (card evm-sell-hook-converge), never refused below_reference
  viaHook(h, honest.key, 2n * AMOUNT);
  // a W's sell through it short of the quoter's price is no reference either
  const t3 = "0x00000000000000000000000000000000000c0e2e";
  const short: ModelPool = { key: keyOf(t3, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a) => a / 20n };
  const m3: ModelPool = { key: keyOf(t3, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const v3 = await sellVerdict(sellOn([m3, short], t3, scanner(5_000_000, [{ key: m3.key, at: 4_500_000 }, { key: short.key, at: 4_500_001 }]), undefined, 100, DELEGATED, signSim));
  assert.equal((v3 as { amountOut?: bigint }).amountOut, AMOUNT, show(v3));
  // without a signer the sim cannot run: refused, never signed unsimmed
  const t4 = "0x00000000000000000000000000000000000c0e3e";
  const b4: ModelPool = { ...blocker, key: keyOf(t4, NATIVE, 3000, 60, UNPINNED) };
  const m4: ModelPool = { key: keyOf(t4, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  assert.deepEqual(await sellVerdict(sellOn([m4, b4], t4, scanner(5_000_000, [{ key: m4.key, at: 4_500_000 }, { key: b4.key, at: 4_500_001 }]), undefined, 100, DELEGATED)), { accepted: false, code: "bad_request" });
});

test("PE (keep-min) where no sell delegate is pinned, the same pool keeps the lower of its two quotes in the reference and is the sale's route at it, not signed at the market; banned, the market (card evm-sell-hook-converge)", async () => {
  const token = "0x00000000000000000000000000000000000c0e4e";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const blocker: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: () => null };
  const logs = [{ key: market.key, at: 4_500_000 }, { key: blocker.key, at: 4_500_001 }];
  viaHook(await sellVerdict(sellOn([market, blocker], token, scanner(5_000_000, logs))), blocker.key, 2n * AMOUNT);
  // its real sale reverts: the device bans the pool, and the next quote leaves through the market
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, sent: [], banned: [hcPid(blocker.key)] } as EvmPoolSellQuoteRequest;
  atMarket(await sellVerdict(evmPoolSellQuoteWith(req, [chain([market, blocker], 0), chain([market, blocker], 1)], NOW, scanner(5_000_000, logs))));
});

// The review of the exec sim, HIGH 1 (probe PROBE): the sim must run as the sale runs, so a hook cannot tell them apart.
// The sale is the helper's EVM pool sender's EIP-7702 transaction to W calling SellDelegate.sell: tx.origin and
// msg.sender that sender, tx.gasprice the block's base fee plus its tip, and the sale's gas limit. Each hook below swaps
// at twice the market only where the call is not such a sale, and reverts otherwise; each must set no reference, so the
// sell goes at the market.
const SALE_GAS = 1_000_000n; // the sale's gas limit (contracts/pool-evm/script/testnet-run.mjs GAS.sell)
const gatedSell = async (token: string, exec: (a: bigint, ctx: SimCtx) => bigint | null) => {
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const gated: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec };
  return sellVerdict(sellOn([market, gated], token, scanner(5_000_000, [{ key: market.key, at: 4_500_000 }, { key: gated.key, at: 4_500_001 }]), undefined, 100, DELEGATED, signSim));
};
const atMarket = (s: unknown) => assert.deepEqual({ ...(s as object), route: undefined }, { accepted: true, amountOut: AMOUNT, minOut: (AMOUNT * 9900n) / 10000n, route: undefined }, show(s));

test("PE1 a hook that executes only at tx.gasprice 0 sets no reference: the sell goes at the market", async () => {
  atMarket(await gatedSell("0x00000000000000000000000000000000000c0e5e", (a, ctx) => (ctx.gasPrice === 0n ? 2n * a : null)));
});

test("PE2 a hook that executes only where tx.origin is the zero address sets no reference: the sell goes at the market", async () => {
  atMarket(await gatedSell("0x00000000000000000000000000000000000c0e6e", (a, ctx) => (ctx.origin === NATIVE ? 2n * a : null)));
});

test("PE3 a hook that executes only with more gas than the sale's limit (the provider's cap) sets no reference: the sell goes at the market", async () => {
  atMarket(await gatedSell("0x00000000000000000000000000000000000c0e7e", (a, ctx) => (ctx.gas > SALE_GAS ? 2n * a : null)));
});

test("PE4 a hook that executes only where W's caller is not the pinned sender sets no reference: the sell goes at the market", async () => {
  atMarket(await gatedSell("0x00000000000000000000000000000000000c0e8e", (a, ctx) => (ctx.sender !== SENDER ? 2n * a : null)));
});

test("PE5 a chain that pins a sell delegate but no sell sender sims nothing: the hooked pool keeps the lower of its quotes (keep-min)", async () => {
  const token = "0x00000000000000000000000000000000000c0e9e";
  const base = (DELEGATED.base ?? {}) as Record<string, unknown>;
  const noSender = Object.freeze({ ...DELEGATED, base: Object.freeze(Object.fromEntries(Object.entries(base).filter(([k]) => k !== "sellSender"))) }) as builder.EvmPoolVenueList;
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const blocker: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: () => null };
  signed.length = 0;
  const s = await sellVerdict(sellOn([market, blocker], token, scanner(5_000_000, [{ key: market.key, at: 4_500_000 }, { key: blocker.key, at: 4_500_001 }]), undefined, 100, noSender, signSim));
  // the sale's route at that price (card evm-sell-hook-converge): its revert would ban it
  viaHook(s, blocker.key, 2n * AMOUNT);
  assert.deepEqual(signed, [], "no sim is signed");
});

test("PE7 a sim on a block with no base fee is refused: it cannot be priced as the sale", async () => {
  const token = "0x00000000000000000000000000000000000c0ebe";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const hooked: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n) };
  const noFee = (rpc: EvmRpc): EvmRpc => async (calls) =>
    (await rpc(calls)).map((r, i) => {
      if (calls[i]!.method !== "eth_getBlockByNumber") return r;
      const { baseFeePerGas: _, ...h } = (r as { result: Head }).result;
      return { ...(r as object), result: h };
    });
  const pools = [market, hooked];
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, sent: [], signSim } as EvmPoolSellQuoteRequest;
  const v = await sellVerdict(evmPoolSellQuoteWith(req, [noFee(chain(pools, 0)), noFee(chain(pools, 1))], NOW, scanner(5_000_000, [{ key: market.key, at: 4_500_000 }, { key: hooked.key, at: 4_500_001 }]), DELEGATED));
  assert.deepEqual(v, { accepted: false, code: "rpc_error" });
});

test("PE6 the sim's eth_call and its nonce read go from the pinned sender, with the sale's gas and the agreed block's base fee plus the sale's tip", async () => {
  const token = "0x00000000000000000000000000000000000c0eae";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const hooked: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: () => null };
  const seen: { args: Record<string, unknown>; state: Record<string, { balance?: string }> }[] = [];
  const wrap = (rpc: EvmRpc): EvmRpc => async (calls) => {
    for (const c of calls) {
      const p = c.params[0] as { to?: string };
      // W's calls through its designator (the fee-on-transfer probe is W's code too, and no sale)
      const code = (c.params[2] as Record<string, { code?: string }> | undefined)?.[SELL_W]?.code;
      if (c.method === "eth_call" && p.to?.toLowerCase() === SELL_W && code?.startsWith("0xef0100")) seen.push({ args: c.params[0] as Record<string, unknown>, state: c.params[2] as Record<string, { balance?: string }> });
    }
    return rpc(calls);
  };
  const pools = [market, hooked];
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, sent: [], signSim } as EvmPoolSellQuoteRequest;
  atMarket(await sellVerdict(evmPoolSellQuoteWith(req, [wrap(chain(pools, 0)), wrap(chain(pools, 1))], NOW, scanner(5_000_000, [{ key: market.key, at: 4_500_000 }, { key: hooked.key, at: 4_500_001 }]), DELEGATED)));
  const k = sellMod as unknown as { EVM_POOL_SELL_GAS?: bigint; evmPoolSellTip?: (c: string) => bigint };
  assert.equal(k.EVM_POOL_SELL_GAS, SALE_GAS);
  const tip = k.evmPoolSellTip?.("base");
  assert.equal(tip, 1_000_000n, "Base's tip (eth_maxPriorityFeePerGas on mainnet.base.org and base-rpc.publicnode.com, 2026-11-04 14:10Z)");
  // the nonce read, then the sim: two calls on each provider, each the sale's context
  const sel = (a: Record<string, unknown>) => String(a.data).slice(2, 10);
  assert.deepEqual(seen.map((x) => sel(x.args)).sort(), ["affed0e0", "affed0e0", SEL_SELL, SEL_SELL].sort());
  for (const { args, state } of seen) {
    assert.equal(String(args.from).toLowerCase(), SENDER);
    // the sale's gas less its authorization's intrinsic cost (EIP-7702 PER_EMPTY_ACCOUNT_COST), which an eth_call with no
    // authorization list does not charge: the hook is given what the sale's execution is given
    assert.equal(BigInt(String(args.gas)), SALE_GAS - 25_000n);
    assert.equal(BigInt(String(args.maxPriorityFeePerGas)), tip);
    assert.equal(BigInt(String(args.maxFeePerGas)), BASE_FEE + tip!);
    assert.equal(args.gasPrice, undefined, "EIP-1559 fields only");
    // the sender's balance is its own at the block: the override names W and the sim pool, never the sender
    assert.deepEqual(Object.keys(state).filter((a) => a.toLowerCase() === SENDER), [], "no override of the sender");
  }
});

// a sell quote's own verdict with what it says of the sim (card evm-sell-unfunded-sim-keeps-route): "ran" where W's sim
// held the route, "skipped" where the sender could not pay for it, "none" where no route needed it
const simVerdict = async (p: Promise<EvmPoolSellQuote>) => {
  let sim: unknown;
  const verdict = await sellVerdict(p.then((q) => ((sim = (q as { sim?: unknown }).sim), q)));
  return { verdict, sim };
};

test("PE8 a sender too low to pay the sale's gas skips the sim and keeps the hooked route at its keep-min quote, freezing no sell: its balance is its own", async () => {
  const token = "0x00000000000000000000000000000000000c0ebe";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  // a hook W's own sell clears at twice the market: with the sender funded it sets the reference, so W's bought route is
  // below it
  const hooked: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a) => 2n * a };
  const pools = [market, hooked];
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, sent: [], signSim } as EvmPoolSellQuoteRequest;
  const logs = scanner(5_000_000, [{ key: market.key, at: 4_500_000 }, { key: hooked.key, at: 4_500_001 }]);
  const on = (bal?: Record<string, bigint>) => evmPoolSellQuoteWith(req, [chain(pools, 0, 5_000_000, undefined, bal), chain(pools, 1, 5_000_000, undefined, bal)], NOW, logs, DELEGATED);
  signed.length = 0;
  const funded = await simVerdict(on());
  // the sale goes through it at that price (card evm-sell-hook-converge), held by W's sim
  viaHook(funded.verdict, hooked.key, 2n * AMOUNT);
  assert.equal(funded.sim, "ran");
  assert.equal(signed.length, 1, "W signed the sim");
  // the sender holding exactly the sim's gas x maxFeePerGas: the sim runs
  const cost = (SALE_GAS - 25_000n) * (BASE_FEE + 1_000_000n);
  const exact = await simVerdict(on({ [SENDER]: cost }));
  viaHook(exact.verdict, hooked.key, 2n * AMOUNT);
  assert.equal(exact.sim, "ran");
  // one wei short on both providers (an eth_call it cannot pay for is the node's error, not a revert): the sim is
  // skipped, and the hooked route stays in the pick at the lower of its quotes, as on a chain that pins no sender (PE5)
  signed.length = 0;
  const short = await simVerdict(on({ [SENDER]: cost - 1n }));
  viaHook(short.verdict, hooked.key, 2n * AMOUNT);
  assert.equal(short.sim, "skipped");
  // and one with no ETH at all, as both mainnet sell senders held on 7 Nov (review a42f9c16, Low 1)
  const none = await simVerdict(on({}));
  viaHook(none.verdict, hooked.key, 2n * AMOUNT);
  assert.equal(none.sim, "skipped");
  assert.deepEqual(signed, [], "no sim is signed where it cannot run");
  // where no route needs the sim, the quote says none ran
  const plain = await simVerdict(evmPoolSellQuoteWith(req, [chain([market], 0, 5_000_000, undefined, {}), chain([market], 1, 5_000_000, undefined, {})], NOW, scanner(5_000_000, [{ key: market.key, at: 4_500_000 }]), DELEGATED));
  atMarket(plain.verdict);
  assert.equal(plain.sim, "none");
});

test("PE9 an unfunded sell sender never drops the token's real market behind a hook the venue does not list: a seeded pool beside it sets no price (card evm-sell-unfunded-sim-keeps-route)", async () => {
  const token = "0x00000000000000000000000000000000000c0ece";
  // the token's real market behind a hook the venue does not list, whose quote with its hook as it is reads half again
  // above its quote with the hook replaced; its keep-min quote is the lower, the amount itself. The seeded 1% pool
  // beside it, which the sell builder takes, gives a tenth of that
  const market = real(token, (a) => a + a / 2n);
  const pools = [seeded(token), market];
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, sent: [], signSim } as EvmPoolSellQuoteRequest;
  const logs = scanner(5_000_000, [{ key: market.key, at: 4_500_000 }]);
  const on = (bal?: Record<string, bigint>) => evmPoolSellQuoteWith(req, [chain(pools, 0, 5_000_000, undefined, bal), chain(pools, 1, 5_000_000, undefined, bal)], NOW, logs, DELEGATED);
  // both providers' sender holding nothing, and one wei short of the sim's gas: the hooked route stays in the pick at
  // its keep-min quote, never the seeded pool's tenth
  const cost = (SALE_GAS - 25_000n) * (BASE_FEE + 1_000_000n);
  for (const bal of [{}, { [SENDER]: cost - 1n }]) {
    signed.length = 0;
    const v = await simVerdict(on(bal));
    viaHook(v.verdict, market.key, AMOUNT);
    assert.equal(v.sim, "skipped", show(bal));
    assert.deepEqual(signed, [], "no sim is signed where it cannot run");
  }
  // funded, W's sim holds the same route at the same quote
  const funded = await simVerdict(on());
  viaHook(funded.verdict, market.key, AMOUNT);
  assert.equal(funded.sim, "ran");
});

test("PE10 a funded sim that pays W's sale under the market's quotes counts the market at what W gets, never drops it: a seeded pool beside it sets no price (review of 1c31d81a, M1)", async () => {
  // the token's real market behind a hook the venue does not list, whose hook pays W's own sale (and so W's sim) under
  // what it pays the V4Quoter, by 1 bps and by 5%; a seeded 1% pool beside it, a tenth of the market
  const cases: [string, (a: bigint) => bigint][] = [["0x00000000000000000000000000000000000c0ede", (a) => a - a / 10_000n], ["0x00000000000000000000000000000000000c0eee", (a) => (a * 95n) / 100n]];
  for (const [token, exec] of cases) {
    const market: ModelPool = { ...real(token), exec };
    const pools = [seeded(token), market];
    const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, sent: [], signSim } as EvmPoolSellQuoteRequest;
    signed.length = 0;
    const v = await simVerdict(evmPoolSellQuoteWith(req, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, [{ key: market.key, at: 4_500_000 }]), DELEGATED));
    // the sale goes through the market at what W's sim gained, its minOut the slippage off that, never the seeded tenth
    viaHook(v.verdict, market.key, exec(AMOUNT));
    assert.equal(v.sim, "ran");
    assert.equal(signed.length, 1, "W signed the sim");
  }
});

// the getEthBalance read of the sell sender answered as a revert of that one read (aggregate3 with allowFailure)
const balanceReverts = (rpc: EvmRpc): EvmRpc => async (calls) =>
  (await rpc(calls)).map((r, i) => {
    const p = calls[i]!.params[0] as { to?: string; data?: string };
    if (calls[i]!.method !== "eth_call" || p.to?.toLowerCase() !== "0xca11bde05977b3631167028862be2a173976ca11" || !p.data?.includes(SEL_ETH_BALANCE)) return r;
    const w = (x: bigint) => x.toString(16).padStart(64, "0");
    return { ...(r as object), result: "0x" + w(0x20n) + w(1n) + w(0x20n) + w(0n) + w(0x40n) + w(0n) };
  });
const SEL_ETH_BALANCE = "4d2301cc"; // Multicall3.getEthBalance(address)

test("PE11 a sell sender's balance read that reverts on both providers skips the sim at keep-min, nothing signed; on one alone, refused (review of 1c31d81a, L1)", async () => {
  const token = "0x00000000000000000000000000000000000c0efe";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const hooked: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a) => 2n * a };
  const pools = [market, hooked];
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, sent: [], signSim } as EvmPoolSellQuoteRequest;
  const logs = scanner(5_000_000, [{ key: market.key, at: 4_500_000 }, { key: hooked.key, at: 4_500_001 }]);
  signed.length = 0;
  const both = await simVerdict(evmPoolSellQuoteWith(req, [balanceReverts(chain(pools, 0)), balanceReverts(chain(pools, 1))], NOW, logs, DELEGATED));
  viaHook(both.verdict, hooked.key, 2n * AMOUNT);
  assert.equal(both.sim, "skipped");
  assert.deepEqual(signed, [], "no sim is signed where it cannot run");
  const one = await simVerdict(evmPoolSellQuoteWith(req, [balanceReverts(chain(pools, 0)), chain(pools, 1)], NOW, logs, DELEGATED));
  assert.deepEqual(one.verdict, { accepted: false, code: "rpc_disagree" });
});

test("PE12 a chain that pins no sell delegate or no sell sender prices a hooked route at keep-min and says the sim was skipped; with no hooked route above the pick, none (review of 1c31d81a, L3)", async () => {
  const token = "0x00000000000000000000000000000000000c0f0e";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const hooked: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: () => null };
  const base = (DELEGATED.base ?? {}) as Record<string, unknown>;
  const noSender = Object.freeze({ ...DELEGATED, base: Object.freeze(Object.fromEntries(Object.entries(base).filter(([k]) => k !== "sellSender"))) }) as builder.EvmPoolVenueList;
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, sent: [], signSim } as EvmPoolSellQuoteRequest;
  const on = (pools: ModelPool[], venues: builder.EvmPoolVenueList) => simVerdict(evmPoolSellQuoteWith(req, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, pools.map((p, i) => ({ key: p.key, at: 4_500_000 + i }))), venues));
  signed.length = 0;
  for (const venues of [noSender, KEEP_MIN]) {
    const v = await on([market, hooked], venues);
    viaHook(v.verdict, hooked.key, 2n * AMOUNT);
    assert.equal(v.sim, "skipped");
    const plain = await on([market], venues);
    atMarket(plain.verdict);
    assert.equal(plain.sim, "none");
  }
  assert.deepEqual(signed, [], "no sim is signed");
});

// ------------------------------------------------------------------ the warm round (card evm-quote-warm-round)
// A token's next quote within EVM_WARM_RANGE_S of block time asks its last quote's later reads in its first round:
// where nothing changed it takes one round of reads; whatever changed, it decides as a quote with nothing kept.
// a provider that counts its rounds of reads: the eth_call requests sent while none of its others is in flight (a
// round's batches go out at once), with every block's time moved by `late` seconds
const counted = (rpc: EvmRpc, late = 0) => {
  const n = { calls: 0 };
  let flying = 0;
  const at = (r: unknown) => {
    const b = (r as { result?: { timestamp?: string } } | null)?.result;
    return b && typeof b.timestamp === "string" ? { ...(r as object), result: { ...b, timestamp: "0x" + (Number(b.timestamp) + late).toString(16) } } : r;
  };
  const wrapped: EvmRpc = async (calls) => {
    if (!calls.some((c) => c.method === "eth_call")) return (await rpc(calls)).map(at);
    if (flying++ === 0) n.calls++;
    try {
      return (await rpc(calls)).map(at);
    } finally {
      flying--;
    }
  };
  return { rpc: wrapped, n };
};
// the token, its pool with X (bought through X's market) and a pool of it behind a hook the venue does not list: a
// cold quote takes a round for the pools' state, one for X's markets and the hooked pool, and one for the route via X
const warmCase = (token: string, x: string) => {
  // each at the best pool's price, so the prune keeps it
  const viaX: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => 10n * a, state: pricedAt(10n) };
  const hooked: ModelPool = { key: keyOf(token, NATIVE, 7000, 7, UNPINNED), give: (a) => 10n * a, state: pricedAt(10n) };
  return { pools: [best(token), viaX, marketOf(x), hooked], logs: [{ key: viaX.key, at: 4_100_000 }, { key: marketOf(x).key, at: 4_100_001 }, { key: hooked.key, at: 4_100_002 }] };
};
const warmReq = (token: string) => ({ chain: "base" as const, token, amountIn: AMOUNT, slippageBps: 100, route: bestRoute(token) });

test("W1 a token's second quote within the range takes one round of reads, and decides as the first; a pool behind an unlisted hook adds the one round its override waits for", async () => {
  const run = async (token: string, x: string, hooked: boolean) => {
    const c = warmCase(token, x);
    const pools = hooked ? c.pools : c.pools.filter((p) => p.key.hooks !== UNPINNED);
    const first = counted(chain(pools, 0));
    const v1 = await verdict(evmPoolBuyQuoteWith(warmReq(token), [first.rpc, chain(pools, 1)], NOW, scanner(5_000_000, c.logs)));
    assert.equal(v1.accepted, true, String((v1 as { code?: string }).code));
    assert.ok(first.n.calls >= 3, `the first quote's rounds: ${first.n.calls}`);
    const second = counted(chain(pools, 0));
    const v2 = await verdict(evmPoolBuyQuoteWith(warmReq(token), [second.rpc, chain(pools, 1)], NOW, scanner(5_000_000, c.logs)));
    assert.deepEqual(v2, v1);
    return second.n.calls;
  };
  assert.equal(await run("0x00000000000000000000000000000000000ee0e1", xAt(0x3a00), false), 1, "one round of reads");
  assert.equal(await run("0x00000000000000000000000000000000000ee0e9", xAt(0x3a80), true), 2, "the hooked pool's override waits for its state");
});

test("W2 a pool seeded inside the range is found by the scan and read: it sets the reference the second quote is held to", async () => {
  const token = "0x00000000000000000000000000000000000ee0e2";
  const x = xAt(0x3a10);
  // the token's pools at a twentieth of the price, and the user's route at a tenth; a pool at the full price appears
  // only after the first quote
  const viaX: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a / 20n };
  const hooked: ModelPool = { key: keyOf(token, NATIVE, 7000, 7, UNPINNED), give: (a) => a / 20n };
  const pools = [seeded(token), viaX, marketOf(x), hooked];
  const logs = [{ key: viaX.key, at: 4_100_000 }, { key: marketOf(x).key, at: 4_100_001 }, { key: hooked.key, at: 4_100_002 }];
  const v1 = await verdict(evmPoolBuyQuoteWith({ ...warmReq(token), route: seededRoute(token) }, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)));
  assert.equal(v1.accepted, true, String((v1 as { code?: string }).code));
  const better: ModelPool = { key: keyOf(token, NATIVE, 9000, 9, NATIVE), give: (a) => a };
  const now = [...pools, better];
  const v2 = await verdict(evmPoolBuyQuoteWith({ ...warmReq(token), route: seededRoute(token) }, [chain(now, 0, 5_000_010), chain(now, 1, 5_000_010)], NOW, scanner(5_000_010, [...logs, { key: better.key, at: 5_000_005 }])));
  assert.deepEqual(v2, below);
});

test("W3 a kept route whose pool vanished inside the range counts for nothing: the second quote decides without it", async () => {
  const token = "0x00000000000000000000000000000000000ee0e3";
  const x = xAt(0x3a20);
  // the real route goes through X; the user's at a tenth of it
  const viaX: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  const pools = [seeded(token), viaX, marketOf(x)];
  const logs = [{ key: viaX.key, at: 4_100_000 }, { key: marketOf(x).key, at: 4_100_001 }];
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith({ ...warmReq(token), route: seededRoute(token) }, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs))), below);
  // X's market is gone (no state at the new block): the route through X is not held, so the seeded route is the best
  const gone = [seeded(token), viaX];
  const v2 = await verdict(evmPoolBuyQuoteWith({ ...warmReq(token), route: seededRoute(token) }, [chain(gone, 0), chain(gone, 1)], NOW, scanner(5_000_000, logs)));
  assert.equal(v2.accepted, true, String((v2 as { code?: string }).code));
});

test("W4 past EVM_WARM_RANGE_S of block time nothing kept is asked: the quote takes its rounds again", async () => {
  const token = "0x00000000000000000000000000000000000ee0e4";
  const { pools, logs } = warmCase(token, xAt(0x3a30));
  await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)));
  // 61 s of block time later, on both providers and the device's clock
  const late = counted(chain(pools, 0), 61);
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [late.rpc, counted(chain(pools, 1), 61).rpc], NOW + 61_000, scanner(5_000_000, logs)));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.ok(late.n.calls >= 3, `rounds: ${late.n.calls}`);
});

test("W1b a warm quote asks its kept scans beside the token's: X's markets are scanned before its first round of reads is answered", async () => {
  const token = "0x00000000000000000000000000000000000ee0e5";
  const x = xAt(0x3a40);
  const { pools, logs } = warmCase(token, x);
  const events: string[] = [];
  const watched = (rpc: EvmRpc): EvmRpc => async (calls) => {
    if (!calls.some((c) => c.method === "eth_call")) return rpc(calls);
    await new Promise((r) => setTimeout(r, 20));
    const out = await rpc(calls);
    events.push("round");
    return out;
  };
  const scanWatched = (rpc: EvmRpc): EvmRpc => async (calls) => {
    for (const c of calls) if (c.method === "eth_getLogs" && JSON.stringify(c.params).includes(W(BigInt(x)))) events.push("scan X");
    return rpc(calls);
  };
  await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)));
  events.length = 0;
  // ten blocks on: each scan asks the blocks since its last
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [watched(chain(pools, 0, 5_000_010)), watched(chain(pools, 1, 5_000_010))], NOW, scanWatched(scanner(5_000_010, logs))));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.ok(events.indexOf("scan X") >= 0 && events.indexOf("scan X") < events.indexOf("round"), events.join(", "));
});

test("W5 a kept read the quote did not ask again is not kept for the next: a change of amount leaves the old amount's quotes behind", async () => {
  // a provider that adds up the calldata of its eth_calls
  const sized = (rpc: EvmRpc) => {
    const n = { bytes: 0 };
    const wrapped: EvmRpc = async (calls) => {
      for (const c of calls) if (c.method === "eth_call") n.bytes += JSON.stringify(c.params).length;
      return rpc(calls);
    };
    return { rpc: wrapped, n };
  };
  const quoter = (token: string, x: string) => {
    const { pools, logs } = warmCase(token, x);
    return async (amountIn: bigint) => {
      const s = sized(chain(pools, 0));
      const v = await verdict(evmPoolBuyQuoteWith({ ...warmReq(token), amountIn }, [s.rpc, chain(pools, 1)], NOW, scanner(5_000_000, logs)));
      assert.equal(v.accepted, true, String((v as { code?: string }).code));
      return s.n.bytes;
    };
  };
  // the same pools under another token and X (addresses of the same length): its warm quote at half the amount is
  // what a quote that kept only that amount's reads asks
  const plain = quoter("0x00000000000000000000000000000000000ee0e7", xAt(0x3a60));
  await plain(AMOUNT / 2n);
  const warmHalf = await plain(AMOUNT / 2n);
  const q = quoter("0x00000000000000000000000000000000000ee0e6", xAt(0x3a50));
  await q(AMOUNT);
  await q(AMOUNT / 2n);
  assert.equal(await q(AMOUNT / 2n), warmHalf);
});

test("W6 a warm quote puts no hook's override into a read before its own reads find the pool held: a hooked pool that vanished inside the range is never overridden (review of 5452011, S1)", async () => {
  const token = "0x00000000000000000000000000000000000ee0e8";
  const { pools, logs } = warmCase(token, xAt(0x3a70));
  await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)));
  // the hooked pool is gone at the new block
  const gone = pools.filter((p) => p.key.hooks !== UNPINNED);
  const seen: Overridden[] = [];
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(gone, 0, 5_000_000, seen), chain(gone, 1, 5_000_000, seen)], NOW, scanner(5_000_000, logs)));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.deepEqual(seen.flatMap((o) => o.replaces), [], "no override for a pool the PoolManager does not hold");
});

// ------------------------------------------------------------------ the providers (card evm-quote-warm-round)
// A chain lists more providers than two: a quote asks the first two and one more whenever one fails, is slow or answers
// differently, so every answer it uses is one two different providers gave, and no provider that dropped out or lags
// is waited on while two others agree. Read through the namespace: the red run before the card has none of it.
const { evmRanked, EVM_HOLD_MS, EVM_HEDGE_MS } = quoteMod as unknown as { evmRanked?: (urls: readonly string[], now?: number) => string[]; EVM_HOLD_MS?: number; EVM_HEDGE_MS?: number };
const hung: EvmRpc = () => new Promise(() => {});
const down: EvmRpc = async () => {
  throw new TypeError("fetch failed");
};

test("V1 a provider that never answers, or fails, is passed over for the next: the quote decides on the two that agree, as two honest providers would", { timeout: 15_000 }, async () => {
  const token = "0x00000000000000000000000000000000000ee0f1";
  const pools = [best(token)];
  const honest = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW));
  assert.equal(honest.accepted, true, String((honest as { code?: string }).code));
  for (const [name, bad] of [["hung", hung], ["down", down]] as const) {
    const t = performance.now();
    const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [bad, chain(pools, 0), chain(pools, 1)], NOW));
    assert.deepEqual(v, honest, `a ${name} first provider`);
    // a hung one costs the quote one wait of EVM_HEDGE_MS, never its 10 s time limit nor a wait per round (the quote's
    // later rounds ask the two that agreed first); one that fails, none
    const ms = performance.now() - t;
    assert.ok(name === "hung" ? ms < 2 * EVM_HEDGE_MS! : ms < EVM_HEDGE_MS!, `a ${name} first provider: ${Math.round(ms)} ms`);
  }
  // with no provider left to ask, a failure still refuses
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(warmReq(token), [down, chain(pools, 0)], NOW)), { accepted: false, code: "rpc_error" });
});

test("V2 a provider that answers differently is outvoted, never used: two others that agree decide, and with no third the quote refuses", async () => {
  const token = "0x00000000000000000000000000000000000ee0f2";
  // a pool at ten times the price that only provider 0 claims the PoolManager holds
  const lie: ModelPool = { key: keyOf(token, NATIVE, 9000, 9, NATIVE), give: (a) => 100n * a, state: pricedAt(100n), only: 0 };
  const pools = [best(token), lie];
  const logs = [{ key: lie.key, at: 4_100_000 }];
  const honest = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 1), chain(pools, 1)], NOW, scanner(5_000_000, logs)));
  assert.equal(honest.accepted, true, String((honest as { code?: string }).code));
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs))), { accepted: false, code: "rpc_disagree" });
  const t = performance.now();
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1), chain(pools, 1)], NOW, scanner(5_000_000, logs))), honest);
  // the third is asked as soon as the two differ, not after EVM_HEDGE_MS
  assert.ok(performance.now() - t < EVM_HEDGE_MS!, `${Math.round(performance.now() - t)} ms`);
  // two liars that agree with each other are two providers' word: the venue lists providers of different operators
});

test("V3 a provider whose head lags past maxLag is passed over for the next: the block is the two near heads' lower one", async () => {
  const token = "0x00000000000000000000000000000000000ee0f3";
  const pools = [best(token)];
  const t = performance.now();
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0, 4_999_000), chain(pools, 0), chain(pools, 1)], NOW));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.equal((v as { block: bigint }).block, 5_000_000n);
  // the spare is asked as soon as the lagging head is in, never on the hedge's timer
  assert.ok(performance.now() - t < 300, `${Math.round(performance.now() - t)} ms`);
  // the provider of the higher head fails to confirm the block: the next one confirms it
  const noConfirm = (rpc: EvmRpc): EvmRpc => async (calls) => {
    if (calls.some((c) => c.method === "eth_getBlockByNumber" && c.params[0] !== "latest")) throw new TypeError("fetch failed");
    return rpc(calls);
  };
  const w = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), noConfirm(chain(pools, 1, 5_000_001)), chain(pools, 1)], NOW));
  assert.equal(w.accepted, true, String((w as { code?: string }).code));
});

test("V4 the providers are asked fastest first by measured time; one with a request out past EVM_HEDGE_MS goes after them, and one held (it failed) last until EVM_HOLD_MS pass", async () => {
  assert.equal(typeof evmRanked, "function", "the kit ranks its providers");
  const urls = ["https://slow.p4.test", "https://fast.p4.test", "https://limited.p4.test", "https://new.p4.test", "https://stuck.p4.test", "https://capped.p4.test"];
  // capped: an answer whose call's error names the rate limit (mainnet.base.org's "request limit reached")
  const answer = (body: string, capped: boolean) =>
    JSON.stringify((JSON.parse(body) as { id: number }[]).map((c) => (capped ? { jsonrpc: "2.0", id: c.id, error: { code: -32016, message: "25/second request limit reached" } } : { jsonrpc: "2.0", id: c.id, result: "0x1" })));
  const f = (async (u: string, init: RequestInit) => {
    const h = new URL(u).hostname;
    if (h.startsWith("stuck")) return new Promise(() => {});
    await new Promise((r) => setTimeout(r, h.startsWith("slow") ? 60 : 5));
    return new Response(h.startsWith("limited") ? "" : answer(init.body as string, h.startsWith("capped")), { status: h.startsWith("limited") ? 429 : 200 });
  }) as unknown as typeof fetch;
  const rpcs = quoteMod.evmProviders(urls, f);
  const call = [{ method: "eth_blockNumber", params: [] }];
  await Promise.allSettled([rpcs[0]!(call), rpcs[1]!(call), rpcs[2]!(call), rpcs[5]!(call)]);
  void rpcs[4]!(call);
  const [slow, fast, limited, fresh, stuck, capped] = urls as [string, string, string, string, string, string];
  // measured first, fastest first, then the unmeasured in the list's order; the two that named their limit last
  assert.deepEqual(evmRanked!(urls), [fast, slow, fresh, stuck, limited, capped]);
  // the one with a request out past EVM_HEDGE_MS goes after the rest, before the held
  const t = performance.now();
  assert.deepEqual(evmRanked!(urls, t + EVM_HEDGE_MS! + 1), [fast, slow, fresh, stuck, limited, capped]);
  // past the hold the limits are forgiven; the request still out is not
  assert.deepEqual(evmRanked!(urls, t + EVM_HOLD_MS! + 1), [fast, slow, limited, fresh, capped, stuck]);
});

// ------------------------------------------------------------------ the scan's spans (card evm-quote-warm-round)
// Each span of a scan that came back is kept, also when another failed, so the next quote reads only the blocks no scan
// read; a span the provider throttles is asked again whole, never as halves that only send it more.
const getLogsOf = (calls: readonly EvmRpcCall[]) => calls.filter((c) => c.method === "eth_getLogs").map((c) => c.params[0] as { fromBlock: string; toBlock: string; topics: unknown[] });
// a request of the token's own scan: its topics name the token alone
const ofToken = (f: { topics: unknown[] }, token: string) => f.topics.some((t) => t === "0x" + W(BigInt(token)));

test("J1 a scan that lost one span keeps every other: the next quote reads only the blocks of the span that failed, and decides as a quote that lost none", async () => {
  const token = "0x00000000000000000000000000000000000ee0f4";
  const x = xAt(0x3b00);
  const { pools, logs } = warmCase(token, x);
  // the scan provider answers an error to every request over block 4,500,000 in the first quote
  const inner = scanner(5_000_000, logs);
  let failing = true;
  const asked: [number, number][] = [];
  const scan: EvmRpc = async (calls) => {
    const ls = getLogsOf(calls);
    for (const f of ls) if (ofToken(f, token)) asked.push([Number(f.fromBlock), Number(f.toBlock)]);
    if (failing && ls.some((f) => Number(f.fromBlock) <= 4_500_000 && Number(f.toBlock) >= 4_500_000)) return calls.map((_, id) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "internal error" } }));
    return inner(calls);
  };
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scan)), { accepted: false, code: "rpc_error" });
  failing = false;
  asked.length = 0;
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scan));
  // the token's blocks read again: the smallest part of the failed span (10,000 blocks halved three times), not 1,000,000
  const ranges = [...new Set(asked.map((r) => r.join("-")))];
  assert.deepEqual(ranges, ["4498751-4500000"], "the token's scan reads only the part that failed");
  // and it decides as a quote on a scan that never failed
  const t2 = "0x00000000000000000000000000000000000ee0f5";
  const c2 = warmCase(t2, xAt(0x3b10));
  const fresh = await verdict(evmPoolBuyQuoteWith(warmReq(t2), [chain(c2.pools, 0), chain(c2.pools, 1)], NOW, scanner(5_000_000, c2.logs)));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.deepEqual(v, fresh);
});

test("J2 a span the scan provider throttles past ask's retries is asked again whole, never split into more requests: a limit named in the answer, or HTTP 429", { timeout: 40_000 }, () => onTestClock(async () => {
  for (const [i, http] of [[0, false], [1, true]] as const) {
    const token = `0x00000000000000000000000000000000000ee0f${6 + i}`;
    const { pools, logs } = warmCase(token, xAt(0x3b20 + 16 * i));
    const inner = scanner(5_000_000, logs);
    const asked: [number, number][] = [];
    // the span 4,490,001 to 4,500,000 is throttled for its first five requests
    let left = 5;
    const throttled = (calls: readonly EvmRpcCall[]) => getLogsOf(calls).some((f) => Number(f.fromBlock) === 4_490_001 && Number(f.toBlock) === 4_500_000) && left-- > 0;
    const record = (calls: readonly EvmRpcCall[]) => getLogsOf(calls).forEach((f) => asked.push([Number(f.fromBlock), Number(f.toBlock)]));
    const scan: EvmRpc = http
      ? evmJsonRpc("https://scan.j2.test", (async (_u: string, init: RequestInit) => {
          const calls = (JSON.parse(init.body as string) as { id: number; method: string; params: unknown[] }[]).map((c) => ({ method: c.method, params: c.params }));
          record(calls);
          if (throttled(calls)) return new Response("", { status: 429 });
          return new Response(JSON.stringify(await inner(calls)), { status: 200 });
        }) as unknown as typeof fetch)
      : async (calls) => {
          record(calls);
          if (throttled(calls)) return calls.map((_, id) => ({ jsonrpc: "2.0", id, error: { code: -32016, message: "25/second request limit reached" } }));
          return inner(calls);
        };
    const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scan));
    assert.equal(v.accepted, true, String((v as { code?: string }).code));
    const narrow = asked.filter(([a, b]) => a >= 4_490_001 && b <= 4_500_000 && b - a + 1 < 10_000);
    assert.deepEqual(narrow, [], `${http ? "HTTP 429" : "a named limit"}: no half of the throttled span is asked`);
  }
}));

test("J3 a failed scan whose provider named a head past maxLag of the agreed block keeps nothing: the next quote reads every block again", async () => {
  const token = "0x00000000000000000000000000000000000ee0f8";
  const { pools, logs } = warmCase(token, xAt(0x3b40));
  const asked: [number, number][] = [];
  let ahead = true;
  const scan: EvmRpc = async (calls) => {
    const inner = scanner(ahead ? 5_001_000 : 5_000_000, logs);
    const ls = getLogsOf(calls);
    for (const f of ls) if (ofToken(f, token)) asked.push([Number(f.fromBlock), Number(f.toBlock)]);
    if (ahead && ls.some((f) => Number(f.fromBlock) <= 4_500_000 && Number(f.toBlock) >= 4_500_000)) return calls.map((_, id) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "internal error" } }));
    return inner(calls);
  };
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scan)), { accepted: false, code: "rpc_error" });
  ahead = false;
  asked.length = 0;
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scan));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  const blocks = [...new Set(asked.map((r) => r.join("-")))].reduce((n, r) => n + Number(r.split("-")[1]) - Number(r.split("-")[0]) + 1, 0);
  assert.equal(blocks, 1_000_000, "the token's whole depth is read again");
});

test("V5 a spare is asked only once the second provider is late: as long again as the first took, at least EVM_HEDGE_MS, never on a timer from the start", { timeout: 30_000 }, () => onTestClock(async () => {
  const token = "0x00000000000000000000000000000000000ee0f9";
  const pools = [best(token)];
  const late = (rpc: EvmRpc, ms: number): EvmRpc => async (calls) => {
    await new Promise((r) => setTimeout(r, ms));
    return rpc(calls);
  };
  let spare = 0;
  const counted: EvmRpc = async (calls) => {
    spare++;
    return chain(pools, 1)(calls);
  };
  // every request: the first in 600 ms, the second in 1,100 ms (inside 600 + 600)
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [late(chain(pools, 0), 600), late(chain(pools, 1), 1_100), counted], NOW));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.equal(spare, 0, "the spare is never asked");
}));

// ------------------------------------------------------------------ the review of bc189de (card evm-quote-warm-round)
// A value any provider asked contradicts is used only where more than half the listed providers gave it (M-1); a block
// the other provider holds otherwise is a vote the same way, and a provider that differs from what the quote used is
// held (M-2); the spare's timer counts from its own request (L-2); a kept scan waits for the quote's pick (L-3).
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let reviewToken = 0x0ab000;
const freshToken = () => "0x" + (reviewToken++).toString(16).padStart(40, "0");
const big = (x: unknown) => JSON.stringify(x, (_, y) => (typeof y === "bigint" ? String(y) : y));
// the honest chain holds a standard pool (fee 3000, spacing 60) at five times the seeded route's price; a liar (chain
// `who` 1) hides it, so a quote that takes the liar's word accepts the seeded route
const liarCase = (token: string) => {
  const better: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, NATIVE), give: (a) => a / 2n, only: 0 };
  return { pools: [seeded(token), better], req: { ...warmReq(token), route: seededRoute(token) } };
};
// providers from model chains behind a fake fetch, each host answering after its own delay, through the kit's own
// evmProviders (timed: measured, held)
const hosted = (models: Record<string, { rpc: EvmRpc; ms: number }>) => {
  let flying = 0;
  const f = (async (u: string, init: RequestInit) => {
    flying++;
    try {
      const h = new URL(u).hostname;
      const calls = JSON.parse(init.body as string) as { id: number; method: string; params: unknown[] }[];
      await pause(models[h]!.ms);
      const out = await models[h]!.rpc(calls.map((c) => ({ method: c.method, params: c.params })));
      return new Response(JSON.stringify(out.map((a, i) => ({ ...(a as object), id: calls[i]!.id }))));
    } finally {
      flying--;
    }
  }) as unknown as typeof fetch;
  // once every request a quote left out has been answered and timed (the timing lands a few ticks after the answer)
  const idle = async () => {
    while (flying > 0) await pause(5);
    await pause(20);
  };
  return { f, urls: Object.keys(models).map((h) => "https://" + h), idle };
};
const hostOf = (u: string) => new URL(u).hostname;

test("V6 two providers that agree on a lie never outvote an honest one they contradict: a contested value needs more than half the listed providers", async () => {
  const r = async (mk: (pools: ModelPool[]) => EvmRpc[]) => {
    const { pools, req } = liarCase(freshToken());
    return verdict(evmPoolBuyQuoteWith(req, mk(pools), NOW));
  };
  const H = (p: ModelPool[]) => chain(p, 0);
  const L = (p: ModelPool[]) => chain(p, 1);
  // the honest read finds the better pool: the seeded route is refused
  assert.equal(big(await r((p) => [H(p), H(p)])), big({ accepted: false, code: "below_reference" }));
  // liar first, honest second: the three honest of five decide
  assert.equal(big(await r((p) => [L(p), H(p), L(p), H(p), H(p)])), big({ accepted: false, code: "below_reference" }));
  // two honest first agree: no vote
  assert.equal(big(await r((p) => [H(p), H(p), L(p), L(p), L(p)])), big({ accepted: false, code: "below_reference" }));
  // two of two that differ: no majority
  assert.equal(big(await r((p) => [H(p), L(p)])), big({ accepted: false, code: "rpc_disagree" }));
  // two of four against two: no majority either
  assert.equal(big(await r((p) => [L(p), H(p), L(p), H(p)])), big({ accepted: false, code: "rpc_disagree" }));
});

test("V7 a fast provider that names its head a block ahead and answers that block by number falsely is outvoted on the confirm, held, and asked last by the next quote", async () => {
  const token = freshToken();
  const pools = [best(token)];
  const { f, urls } = hosted({
    // chain() answers every block by number with its own head: asked for 5,000,000 it names 5,000,001
    "l1.v7.test": { rpc: chain(pools, 0, 5_000_001), ms: 2 },
    "h1.v7.test": { rpc: chain(pools, 0), ms: 30 },
    "h2.v7.test": { rpc: chain(pools, 1), ms: 30 },
    "h3.v7.test": { rpc: chain(pools, 1), ms: 30 },
  });
  const ps = quoteMod.evmProviders(urls, f);
  for (let i = 0; i < 3; i++) await Promise.all(ps.map((p) => p([{ method: "eth_getBlockByNumber", params: ["latest", false] }])));
  assert.equal(hostOf(quoteMod.evmRanked(urls)[0]!), "l1.v7.test", "the liar is the fastest");
  const v1 = await verdict(evmPoolBuyQuoteWith(warmReq(token), quoteMod.evmProviders(quoteMod.evmRanked(urls), f), NOW));
  assert.equal((v1 as { accepted: boolean }).accepted, true, big(v1));
  const order = quoteMod.evmRanked(urls);
  assert.equal(hostOf(order.at(-1)!), "l1.v7.test", "the provider that held another block is ranked last");
  const v2 = await verdict(evmPoolBuyQuoteWith(warmReq(token), quoteMod.evmProviders(order, f), NOW));
  assert.equal((v2 as { accepted: boolean }).accepted, true, big(v2));
});

test("V8 the first two providers both stuck (failing after 6 s): the spares are asked at 4 x EVM_HEDGE_MS and then EVM_HEDGE_MS after the first spare's own answer", { timeout: 30_000 }, () => onTestClock(async () => {
  const token = freshToken();
  const pools = [best(token)];
  const stuck = (): EvmRpc => async () => {
    await pause(6000);
    throw new TypeError("fetch failed");
  };
  const t = performance.now();
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [stuck(), stuck(), chain(pools, 0), chain(pools, 1)], NOW));
  const ms = performance.now() - t;
  assert.equal((v as { accepted: boolean }).accepted, true, big(v));
  // 1,600 ms to the first spare, 400 ms to the second: about 2.0 s (a timer counted from the round's start: 3.2 s)
  assert.ok(ms < 2_600, `${Math.round(ms)} ms`);
}));

test("V9 the pinned quote asks the kit's providers in their measured order: the venue's first, failing its reads, is asked last by the next quote", async () => {
  const p = builder.evmPoolVenues().base.providers!;
  const TS = "0x" + (Math.floor(Date.now() / 1000) - 2).toString(16);
  // the tests before this one held some of these providers (the offline quote above)
  quoteMod.evmSpeedReset();
  const token = freshToken();
  const x = xAt(0x3e00);
  const { pools, logs } = warmCase(token, x);
  const model = chain(pools, 0);
  const scan = scanner(5_000_000, logs);
  let reads = 0;
  const net = mock.method(globalThis, "fetch", async (u: string, init: RequestInit) => {
    const calls = JSON.parse(init.body as string) as { id: number; method: string; params: unknown[] }[];
    if (calls.some((c) => c.method === "eth_call") && hostOf(u) === hostOf(p[0]!)) {
      reads++;
      throw new TypeError("fetch failed");
    }
    const asked = calls.map((c) => ({ method: c.method, params: c.params }));
    const out = calls.some((c) => c.method === "eth_getLogs" || c.method === "eth_blockNumber") ? await scan(asked) : await model(asked);
    // the pinned quote reads the device's own clock (and the chain's head watch keeps the clock it was made with): the
    // model's blocks are dated 2 s before this test began
    const dated = out.map((a) => {
      const r = (a as { result?: { timestamp?: string } }).result;
      return r !== null && typeof r === "object" && typeof r.timestamp === "string" ? { ...(a as object), result: { ...r, timestamp: TS } } : a;
    });
    return new Response(JSON.stringify(dated.map((a, i) => ({ ...(a as object), id: calls[i]!.id }))));
  });
  try {
    const v1 = await verdict(evmPoolBuyQuote(warmReq(token)));
    assert.equal(hostOf(quoteMod.evmRanked(p).at(-1)!), hostOf(p[0]!), `the provider that failed is ranked last (${big(v1)})`);
    reads = 0;
    const v = await verdict(evmPoolBuyQuote(warmReq(token)));
    assert.equal((v as { accepted: boolean }).accepted, true, big(v));
    assert.equal(reads, 0, "the held provider is not asked while the others agree");
  } finally {
    net.mock.restore();
  }
});

test("J4 a kept scan started early that ends before the token's scan waits for the quote to pick the block: the heads are asked after the token's logs", async () => {
  const token = freshToken();
  const x = xAt(0x3c10);
  const { pools, logs } = warmCase(token, x);
  await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)));
  const events: string[] = [];
  const inner = scanner(5_000_010, logs);
  const scan: EvmRpc = async (calls) => {
    const ls = getLogsOf(calls);
    const mine = ls.some((f) => ofToken(f, token));
    if (mine) await pause(300); // the token's own scan is slow
    const out = await inner(calls);
    if (ls.length > 0) events.push(mine ? "token" : "X");
    return out;
  };
  const heads = (rpc: EvmRpc): EvmRpc => async (calls) => {
    if (calls.some((c) => c.method === "eth_getBlockByNumber" && c.params[0] === "latest")) events.push("heads");
    return rpc(calls);
  };
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [heads(chain(pools, 0, 5_000_010)), heads(chain(pools, 1, 5_000_010))], NOW, scan));
  assert.equal((v as { accepted: boolean }).accepted, true, big(v));
  assert.ok(events.indexOf("heads") > events.lastIndexOf("token"), events.join(" -> "));
});

test("J5 a kept scan started early that fails before the token's scan ends waits for the quote to pick the block too", async () => {
  const token = freshToken();
  const x = xAt(0x3c20);
  const { pools, logs } = warmCase(token, x);
  await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs)));
  const events: string[] = [];
  const inner = scanner(5_000_010, logs);
  const scan: EvmRpc = async (calls) => {
    const ls = getLogsOf(calls);
    const mine = ls.some((f) => ofToken(f, token));
    if (ls.length > 0 && !mine) {
      events.push("X failed");
      return calls.map((_, id) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "internal error" } }));
    }
    if (mine) await pause(300);
    const out = await inner(calls);
    if (mine) events.push("token");
    return out;
  };
  const heads = (rpc: EvmRpc): EvmRpc => async (calls) => {
    if (calls.some((c) => c.method === "eth_getBlockByNumber" && c.params[0] === "latest")) events.push("heads");
    return rpc(calls);
  };
  await verdict(evmPoolBuyQuoteWith(warmReq(token), [heads(chain(pools, 0, 5_000_010)), heads(chain(pools, 1, 5_000_010))], NOW, scan));
  assert.ok(events.includes("X failed") && events.includes("token"), events.join(" -> "));
  assert.ok(events.indexOf("heads") > events.lastIndexOf("token"), events.join(" -> "));
});

test("J6 a scan of two currencies with different blocks left keeps each span only for the currency whose request came back: the next quote asks X2's failed part and finds its market", async () => {
  const [A, B] = [freshToken(), freshToken()];
  const [x1, x2] = [xAt(0x3d00), xAt(0x3d10)];
  // A's quote scans X1's markets up to 5,000,000
  const a = warmCase(A, x1);
  await verdict(evmPoolBuyQuoteWith(warmReq(A), [chain(a.pools, 0), chain(a.pools, 1)], NOW, scanner(5_000_000, a.logs)));
  // B: its route at a tenth; through X1 a twentieth; through X2, whose market was made at 5,080,000, the full price
  const viaX1: ModelPool = { key: keyOf(B, x1, 3000, 60, NATIVE), give: (y) => y / 20n, state: pricedAt(10n) };
  const viaX2: ModelPool = { key: keyOf(B, x2, 3000, 60, NATIVE), give: (y) => y, state: pricedAt(10n) };
  const pools = [seeded(B), viaX1, marketOf(x1), viaX2, marketOf(x2)];
  const logs = [{ key: viaX1.key, at: 4_600_000 }, { key: marketOf(x1).key, at: 4_100_001 }, { key: viaX2.key, at: 4_600_002 }, { key: marketOf(x2).key, at: 5_080_000 }];
  const inner = scanner(5_100_000, logs);
  let failing = true;
  const asked: string[] = [];
  const scan: EvmRpc = async (calls) => {
    const ls = getLogsOf(calls);
    for (const f of ls) if (ofToken(f, x2)) asked.push(`${Number(f.fromBlock)}-${Number(f.toBlock)}`);
    if (failing && ls.some((f) => ofToken(f, x2) && Number(f.fromBlock) <= 5_080_000 && Number(f.toBlock) >= 5_080_000)) return calls.map((_, id) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "internal error" } }));
    return inner(calls);
  };
  const q = () => verdict(evmPoolBuyQuoteWith({ ...warmReq(B), route: seededRoute(B) }, [chain(pools, 0, 5_100_000), chain(pools, 1, 5_100_000)], NOW, scan));
  assert.equal(big(await q()), big({ accepted: false, code: "rpc_error" }));
  failing = false;
  asked.length = 0;
  // X2's market through which B pays ten times the seeded route: found, so the seeded route is refused
  assert.equal(big(await q()), big({ accepted: false, code: "below_reference" }));
  assert.deepEqual([...new Set(asked)], ["5078751-5080000"]);
});

test("V10 a block two colluders name, which the other three providers hold otherwise, is never read at: a contested block needs more than half the listed providers", async () => {
  // at the old block every route gives 1x, at the chain's (NEW) the two-hop routes 3x, the direct route below them
  const price = (p: Pool, hash: string) => (hash === OLD ? p.amount : p.hops === 2 ? 3n * p.amount : p.amount);
  const liar = () => provider(head("0x2000000", OLD), price);
  const honest = () => provider(head("0x2000000"), price);
  const higher = provider(head("0x2000001"), price, { "0x2000000": head("0x2000000") });
  // the liar's head and the higher one agree; the higher's provider holds another block there, the second liar the
  // liar's, the last two the higher's: two of five hold the liar's block
  assert.equal(big(await buyN(v3direct, [liar(), higher, liar(), honest(), honest()])), big({ accepted: false, code: "rpc_disagree" }));
  // three of five hold it: read at (the model's own price at the old block)
  assert.equal((await buyN(v3direct, [liar(), higher, liar(), liar(), honest()])).accepted, true);
});
const buyN = (route: EvmRoute, rpcs: EvmRpc[]) => verdict(evmPoolBuyQuoteWith({ chain: "base", token: TOKEN, amountIn: AMOUNT, slippageBps: 100, route }, rpcs, NOW));

test("V11 a fast provider whose reads the others outvote is held: the next quote asks it last", async () => {
  const { pools, req } = liarCase(freshToken());
  const { f, urls } = hosted({
    "l1.v11.test": { rpc: chain(pools, 1), ms: 2 },
    "h1.v11.test": { rpc: chain(pools, 0), ms: 30 },
    "h2.v11.test": { rpc: chain(pools, 0), ms: 30 },
    "h3.v11.test": { rpc: chain(pools, 0), ms: 30 },
  });
  const ps = quoteMod.evmProviders(urls, f);
  for (let i = 0; i < 3; i++) await Promise.all(ps.map((p) => p([{ method: "eth_getBlockByNumber", params: ["latest", false] }])));
  assert.equal(hostOf(quoteMod.evmRanked(urls)[0]!), "l1.v11.test", "the liar is the fastest");
  assert.equal(big(await verdict(evmPoolBuyQuoteWith(req, quoteMod.evmProviders(quoteMod.evmRanked(urls), f), NOW))), big({ accepted: false, code: "below_reference" }));
  assert.equal(hostOf(quoteMod.evmRanked(urls).at(-1)!), "l1.v11.test", "the provider the others outvoted is ranked last");
});

// ------------------------------------------------------------------ the re-review of fd9dd16 (card evm-quote-warm-round)
const priceAtOld = (p: Pool, hash: string) => (hash === OLD ? p.amount : p.hops === 2 ? 3n * p.amount : p.amount);
// an honest node: it holds no block with the hash OLD ("header not found" to a read there); `confirm` "throws" fails
// every block by number, "null" answers it as not held yet (a load balancer's lagging backend)
const honestNode = (confirm: "ok" | "throws" | "null" = "ok"): EvmRpc => {
  const inner = provider(head("0x2000000"), priceAtOld);
  return async (calls) => {
    if (calls.some((c) => c.method === "eth_getBlockByNumber" && c.params[0] !== "latest")) {
      if (confirm === "throws") throw new TypeError("fetch failed");
      if (confirm === "null") return calls.map((_, id) => ({ jsonrpc: "2.0", id, result: null }));
    }
    const out = await inner(calls);
    return out.map((a, i) => ((calls[i]!.params[1] as { blockHash?: string } | undefined)?.blockHash === OLD ? { jsonrpc: "2.0", id: i, error: { code: -32000, message: "header not found" } } : a));
  };
};
// a colluder: the honest head's number with the hash OLD, and that block by number
const oldNode = () => provider(head("0x2000000", OLD), priceAtOld, { "0x2000000": head("0x2000000", OLD) });

test("V12 the pair's honest provider gives no confirm (it fails, or holds no such block): a colluding spare alone never confirms the liar's block", async () => {
  for (const c of ["throws", "null"] as const) {
    assert.equal(big(await buyN(v3direct, [oldNode(), honestNode(c), oldNode(), honestNode(), honestNode()])), big({ accepted: false, code: "rpc_disagree" }), c);
  }
  // all honest, the other head's provider failing its confirm: three of five hold the block
  const v = await buyN(v3direct, [honestNode(), honestNode("throws"), honestNode(), honestNode(), honestNode()]);
  assert.equal(big(v), big({ accepted: false, code: "below_reference" }), "read at the block, priced, refused on its own merits");
});

test("V13 a head is held only when more than maxLag below the lower of the two used: a liar's old head and a lagging honest one never hold the up-to-date provider", async () => {
  // held or not, read off the hold itself, never off the measured speed (re-review of 59a69e2, LOW-4: "not ranked
  // last" rode on it and failed 2 of 30 beside CPU burners; "moves up once the hold ends" rode on it too, and failed in
  // CI when b's 1 ms answers measured slower than c's 5 ms ones): a provider the ranking has never measured goes after
  // every measured one that is not held and before every held one, so it splits the two whatever the speeds
  // (after every request still out has landed, `idle`: one out past EVM_HEDGE_MS also goes after it)
  const unheld = (urls: readonly string[], host: string) => {
    const ranked = quoteMod.evmRanked([...urls, "https://unmeasured.v13.test/"]).map(hostOf);
    return ranked.indexOf(host) < ranked.indexOf("unmeasured.v13.test");
  };
  quoteMod.evmSpeedReset();
  const token = freshToken();
  const pools = [best(token)];
  // Base's maxLag is 50: l1 names 4,999,900, h2 lags at 4,999,920, h1, h3 and h4 are at 5,000,000; each block by number
  // answered as that number's block (every model block carries the hash NEW)
  const byNum = (rpc: EvmRpc): EvmRpc => async (calls) =>
    calls.some((c) => c.method === "eth_getBlockByNumber" && c.params[0] !== "latest") ? calls.map((c, id) => ({ jsonrpc: "2.0", id, result: head(c.params[0] as string) })) : rpc(calls);
  const { f, urls, idle } = hosted({
    "l1.v13.test": { rpc: byNum(chain(pools, 0, 4_999_900)), ms: 1 },
    "h1.v13.test": { rpc: byNum(chain(pools, 0, 5_000_000)), ms: 5 },
    "h2.v13.test": { rpc: byNum(chain(pools, 1, 4_999_920)), ms: 5 },
    "h3.v13.test": { rpc: byNum(chain(pools, 1, 5_000_000)), ms: 50 },
    "h4.v13.test": { rpc: byNum(chain(pools, 1, 5_000_000)), ms: 50 },
  });
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), quoteMod.evmProviders(urls, f), NOW));
  // the heads are no vote: the first two near ones (l1, h2) pick the block, the lower
  assert.equal((v as { block?: bigint }).block, 4_999_900n, big(v));
  await idle();
  assert.ok(unheld(urls, "h1.v13.test"), `h1 is not held: ${quoteMod.evmRanked(urls).map(hostOf).join(",")}`);
  // a head more than maxLag below is held, by its head alone: b holds the agreed block by number like the others, so no
  // confirm's vote against it holds it instead
  quoteMod.evmSpeedReset();
  const low = hosted({
    "a.v13.test": { rpc: byNum(chain(pools, 0, 5_000_000)), ms: 1 },
    "b.v13.test": { rpc: byNum(chain(pools, 0, 4_999_000)), ms: 1 },
    "c.v13.test": { rpc: byNum(chain(pools, 1, 5_000_000)), ms: 5 },
  });
  assert.equal((await verdict(evmPoolBuyQuoteWith(warmReq(token), quoteMod.evmProviders(low.urls, low.f), NOW))).accepted, true);
  assert.equal(hostOf(quoteMod.evmRanked(low.urls).at(-1)!), "b.v13.test");
  await low.idle();
  assert.ok(!unheld(low.urls, "b.v13.test"), "b is held: it moves up once the hold ends");
  // the edges (re-review of 47109a7, LOW-1): the first head, then one 51 or 100 blocks below it (not near), then the spare
  // the two pair on; the head between is exactly maxLag below the lower of the pair, or one below a pair that spans
  // maxLag: neither is held
  for (const [hi, mid, lo] of [
    [5_000_050, 4_999_950, 5_000_000],
    [5_000_050, 4_999_999, 5_000_000],
  ] as const) {
    quoteMod.evmSpeedReset();
    const edge = hosted({
      "a.e.v13.test": { rpc: byNum(chain(pools, 0, hi)), ms: 1 },
      "x.e.v13.test": { rpc: byNum(chain(pools, 0, mid)), ms: 3 },
      "b.e.v13.test": { rpc: byNum(chain(pools, 1, lo)), ms: 10 },
    });
    const w = await verdict(evmPoolBuyQuoteWith(warmReq(token), quoteMod.evmProviders(edge.urls, edge.f), NOW));
    assert.equal((w as { block?: bigint }).block, BigInt(lo), big(w));
    await edge.idle();
    assert.ok(unheld(edge.urls, "x.e.v13.test"), `${mid} under ${hi}/${lo} is not held: ${quoteMod.evmRanked(edge.urls).map(hostOf).join(",")}`);
  }
});

test("V14 a contested read whose majority no provider left can reach refuses at once, never waiting on a provider that hangs", { timeout: 20_000 }, async () => {
  const { pools, req } = liarCase(freshToken());
  const failing: EvmRpc = async (calls) => {
    if (calls.some((c) => c.method === "eth_call")) throw new TypeError("fetch failed");
    return chain(pools, 0)(calls);
  };
  const hung: EvmRpc = async (calls) => {
    if (calls.some((c) => c.method === "eth_call")) {
      await pause(4000);
      throw new TypeError("fetch failed");
    }
    return chain(pools, 0)(calls);
  };
  const t = performance.now();
  // need 3 of 4: one honest, one liar, one failed, one out: at most 2
  assert.equal(big(await verdict(evmPoolBuyQuoteWith(req, [chain(pools, 0), chain(pools, 1), failing, hung], NOW))), big({ accepted: false, code: "rpc_disagree" }));
  assert.ok(performance.now() - t < 2_000, `${Math.round(performance.now() - t)} ms`);
});

test("V15 a confirm that can no longer reach a majority stops asking", async () => {
  let asked = 0;
  const counted = (rpc: EvmRpc): EvmRpc => async (calls) => {
    if (calls.some((c) => c.method === "eth_getBlockByNumber" && c.params[0] !== "latest")) asked++;
    return rpc(calls);
  };
  const higher = provider(head("0x2000001"), priceAtOld, { "0x2000000": head("0x2000000") });
  // the lower head's block (OLD) against the higher's, then two more against: one vote of five, one provider left
  assert.equal(big(await buyN(v3direct, [oldNode(), higher, honestNode(), honestNode(), counted(honestNode())])), big({ accepted: false, code: "rpc_disagree" }));
  assert.equal(asked, 0, "the fifth is never asked to confirm");
  // the paired provider and the next two fail their confirm, none holding another block: one hold of five, one left
  asked = 0;
  assert.equal(big(await buyN(v3direct, [honestNode(), honestNode("throws"), honestNode("throws"), honestNode("throws"), counted(honestNode())])), big({ accepted: false, code: "rpc_error" }));
  assert.equal(asked, 0, "the fifth is never asked to confirm when no answer can bring the block to three");
});

// ------------------------------------------------------------------ the scan provider's rate limit (card evm-quote-warm-round, fold 5)
// base-rpc.publicnode.com answers most getLogs 429 for under a minute once an address has sent about two cold scans
// (2026-11-04 21:26Z); a cold quote on GitHub's runner whose every try was throttled ended rpc_error after 99 s. A 429
// halves the quote's scan parallelism and holds its next requests for the Retry-After (or a backoff); a throttled
// request spends no try; past the scan's bound the quote refuses, never hangs.
const { evmScanBound } = quoteMod as unknown as { evmScanBound?: (ms?: number) => void };
/** The scan provider over HTTP (evmJsonRpc on a fake fetch), answering 429 while `throttled()` says so, with
 *  `retryAfter` as its Retry-After header (none when null), each 429 after `burstMs`; `seen` gets each request's
 *  in-flight count on arrival and each answer as it is sent: "cut" for a 429 that is a new congestion event (its
 *  request arrived after the last cut was answered), "429" for one of a burst already cut, "200". */
function throttlingScan(logs: { key: EvmPoolKey; at: number }[], throttled: (getLogs: boolean) => boolean, retryAfter: string | null, seen: (string | number)[] = [], at: number[] = [], burstMs = 0, narrow: number[] = []): EvmRpc {
  const inner = scanner(5_000_000, logs);
  let [flying, arrived, boundary] = [0, 0, 0];
  return evmJsonRpc("https://scan.throttle.test", (async (_u: string, init: RequestInit) => {
    flying++;
    seen.push(flying);
    const me = arrived++;
    try {
      // a getLogs narrower than Base's 10,000-block span below the head: a half of a span the scan split
      let getLogs = false;
      for (const c of JSON.parse(init.body as string) as { method: string; params: { fromBlock: string; toBlock: string }[] }[]) {
        if (c.method !== "eth_getLogs") continue;
        getLogs = true;
        const [a, b] = [Number(c.params[0]!.fromBlock), Number(c.params[0]!.toBlock)];
        if (b - a + 1 < 10_000 && b < 5_000_000) narrow.push(b - a + 1);
      }
      if (throttled(getLogs)) {
        if (burstMs > 0) await pause(burstMs);
        if (me >= boundary) {
          seen.push("cut");
          boundary = arrived;
        } else seen.push("429");
        at.push(performance.now());
        return new Response("", { status: 429, headers: retryAfter === null ? {} : { "retry-after": retryAfter } });
      }
      const calls = (JSON.parse(init.body as string) as { method: string; params: unknown[] }[]).map((c) => ({ method: c.method, params: c.params }));
      const out = await inner(calls);
      await pause(2);
      seen.push("200");
      return new Response(JSON.stringify(out), { status: 200 });
    } finally {
      flying--;
    }
  }) as unknown as typeof fetch);
}

for (const [name, header] of [["TH1 ", "1"], ["TH2 ", null]] as const) {
  test(`${name}a cold quote whose scan provider answers 429${header === null ? " with no Retry-After" : ", Retry-After: 1,"} for its first 4 s ends as it would unthrottled, never rpc_error`, { timeout: 30_000 }, () => onTestClock(async () => {
    const token = freshToken();
    const { pools, logs } = warmCase(token, xAt(0x3e00 + (header === null ? 16 : 0)));
    // the scan's getLogs are throttled for 4 s from the first
    let t0: number | undefined;
    const at: number[] = [];
    const narrow: number[] = [];
    const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, throttlingScan(logs, (g) => g && performance.now() - (t0 ??= performance.now()) < 4_000, header, [], at, 0, narrow)));
    // a throttled request is asked again whole: it spends no try, so no span is split
    assert.ok(at.length > 20, `${at.length} throttled`);
    assert.equal(narrow.length, 0, `${narrow.length} split getLogs`);
    // the waits between throttle events (each the requests in flight together): the longer of the Retry-After's 1 s
    // and the backoff's 0.5, 1 and 2 s
    const events = at.filter((t, i) => i === 0 || t - at[i - 1]! > 100);
    const gaps = events.slice(1).map((t, i) => t - events[i]!);
    const want = header === null ? [500, 1_000, 2_000] : [1_000, 1_000];
    assert.ok(gaps.length >= want.length && want.every((w, i) => gaps[i]! >= w - 50), `waits ${gaps.map(Math.round).join(", ")} ms, at least ${want.join(", ")}`);
    const t2 = freshToken();
    const c2 = warmCase(t2, xAt(0x3e20 + (header === null ? 16 : 0)));
    const fresh = await verdict(evmPoolBuyQuoteWith(warmReq(t2), [chain(c2.pools, 0), chain(c2.pools, 1)], NOW, scanner(5_000_000, c2.logs)));
    assert.equal(v.accepted, true, String((v as { code?: string }).code));
    assert.equal(fresh.accepted, true);
    assert.equal(big((v as { amountOut?: bigint }).amountOut), big((fresh as { amountOut?: bigint }).amountOut));
  }));
}

test("TH3 after a 429 the scan never has more requests in flight than its halved limit, which answers raise again", async () => {
  const token = freshToken();
  const { pools, logs } = warmCase(token, xAt(0x3e40));
  // the first 20 getLogs are throttled (in flight together, answered after 20 ms), the rest answered
  let n = 0;
  const seen: (string | number)[] = [];
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, throttlingScan(logs, () => ++n > 1 && n <= 21, "0", seen, [], 20)));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  // the provider's own count of the limit: 20, halved at each cut to 1 at least, one more at each answer, up to 20
  let lim = 20;
  let worst = 0;
  for (const s of seen) {
    if (s === "cut") lim = Math.max(1, Math.floor(lim / 2));
    else if (s === "429") continue;
    else if (s === "200") lim = Math.min(20, lim + 1);
    else worst = Math.max(worst, (s as number) - lim);
  }
  assert.ok(seen.includes("cut"), "the provider throttled");
  // and the limit grows back past the halved 10: the later requests go out more than ten at once
  assert.ok(Math.max(...(seen.slice(Math.max(seen.lastIndexOf("429"), seen.lastIndexOf("cut"))).filter((x) => typeof x === "number") as number[])) >= 12, `in flight after the 429s: ${seen.join(" ")}`);
  assert.ok(worst <= 0, `a request arrived with ${worst} more in flight than the halved limit: ${seen.join(" ")}`);
});

test("TH6 twenty requests in flight that all answer 429 at once are one congestion event: the limit goes from 20 to 10, not to 1", async () => {
  const token = freshToken();
  const { pools, logs } = warmCase(token, xAt(0x3e50));
  // the scan's first 20 getLogs (after its head read), all in flight together, answered 429 after 20 ms
  let n = 0;
  const seen: (string | number)[] = [];
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, throttlingScan(logs, () => ++n > 1 && n <= 21, "0", seen, [], 20)));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.equal(seen.filter((x) => x === "cut").length + seen.filter((x) => x === "429").length, 20);
  // the next ten requests go out together, at the halved limit of 10 and no more
  const after = seen.slice(seen.lastIndexOf("429") + 1).filter((x) => typeof x === "number").slice(0, 10) as number[];
  assert.equal(Math.max(...after), 10, `in flight as the ten after the burst arrive: ${after.join(" ")}`);
});

test("TH4 a scan provider that throttles past the scan's bound refuses at the bound, rpc_error naming it, never a hang", { timeout: 30_000 }, async () => {
  // a Retry-After past the bound refuses at once
  const token = freshToken();
  const { pools, logs } = warmCase(token, xAt(0x3e60));
  let t = performance.now();
  const r1 = evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, throttlingScan(logs, () => true, "120"));
  await assert.rejects(r1, (e: unknown) => e instanceof EvmQuoteError && e.code === "rpc_error" && /past the quote's bound/.test(e.message));
  assert.ok(performance.now() - t < 2_000, "refused at once, not after waiting");
  // a provider that answers 429 with Retry-After: 1 for ever refuses once the next wait passes the bound
  evmScanBound?.(1_500);
  try {
    const t2 = freshToken();
    const c2 = warmCase(t2, xAt(0x3e70));
    t = performance.now();
    const r2 = evmPoolBuyQuoteWith(warmReq(t2), [chain(c2.pools, 0), chain(c2.pools, 1)], NOW, throttlingScan(c2.logs, () => true, "1"));
    await assert.rejects(r2, (e: unknown) => e instanceof EvmQuoteError && e.code === "rpc_error" && /past the quote's bound of 1500 ms/.test(e.message));
    assert.ok(performance.now() - t < 4_000, `refused within the bound and one wait: ${Math.round(performance.now() - t)} ms`);
  } finally {
    evmScanBound?.();
  }
});

test("TH5 a scan provider that slows past the deadline with more than 5 requests in flight: a timeout halves the scan's parallelism, so its median in flight settles at 5 or below and the quote ends ok", { timeout: 60_000 }, () => onTestClock(async () => {
  const token = freshToken();
  const { pools, logs } = warmCase(token, xAt(0x3e80));
  const inner = scanner(5_000_000, logs);
  const K = 5;
  let flying = 0;
  let timedOut = 0;
  let firstTimeout = -1;
  const arrivals: number[] = [];
  // each request's deadline 300 ms (evmJsonRpc's timeoutMs); over K in flight an answer takes 1 s
  const scan = evmJsonRpc("https://scan.slow.test", (async (_u: string, init: RequestInit) => {
    flying++;
    arrivals.push(flying);
    try {
      const calls = (JSON.parse(init.body as string) as { method: string; params: unknown[] }[]).map((c) => ({ method: c.method, params: c.params }));
      // the deadline's signal still fires after an answer: only one that lands first is a timeout
      await new Promise<void>((ok, no) => {
        let over = false;
        const t = setTimeout(() => ((over = true), ok()), flying > K ? 1_000 : 10);
        init.signal?.addEventListener("abort", () => {
          if (over) return;
          clearTimeout(t);
          if (timedOut++ === 0) firstTimeout = arrivals.length;
          no(init.signal!.reason);
        });
      });
      return new Response(JSON.stringify(await inner(calls)), { status: 200 });
    } finally {
      flying--;
    }
  }) as unknown as typeof fetch, 1 << 20, 300);
  const t0 = performance.now();
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scan));
  const ms = performance.now() - t0;
  console.log(`TH5: ${String((v as { code?: string }).code ?? "ok")}, ${timedOut} of ${arrivals.length} requests timed out, ${Math.round(ms)} ms`);
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  // a cut per congestion event halves 20 to 10 to 5 in two waves after the first timeout; past those the scan probes
  // past K by two at most (the sawtooth of additive increase, which grows for the deadline's 300 ms before a timeout is
  // seen), never the 20 at once whose every wave sent 15 past K
  const late = arrivals.slice(firstTimeout + 30);
  const sorted = [...late].sort((a, b) => a - b);
  assert.ok(Math.max(...late) <= K + 2 && sorted[sorted.length >> 1]! <= K, `in flight on arrival past the first two waves after the first timeout: most ${Math.max(...late)}, median ${sorted[sorted.length >> 1]}, of ${late.length}`);
  // at 7d6ec94's fixed 20: rpc_error after 18.4 s, 790 of 1,541 requests timed out; with the gate, halving at every
  // timeout (f9bd53c): ok in 5.1 s, 93 of 387; halving once per event: ok in 6.9 s, 126 of 447
  assert.ok(timedOut <= 160 && ms < 10_000, `${timedOut} requests ran out of time in ${Math.round(ms)} ms`);
}));

// ------------------------------------------------------------------ the scan gate's bound, waits and refused connections (re-review of 59a69e2)
/** The scan provider over HTTP whose getLogs requests `fault(from, to, nth)` judges (nth: how often that range was
 *  asked before; "ok" answers it from the model scanner); every other call is answered by the model. `st` counts the
 *  getLogs requests, the ones narrower than Base's 10,000-block span (halves) and each one's send time. */
type Fault = "ok" | "timeout" | "error" | "unreach" | "chrome" | "safari" | `429:${string}`;
function faultScan(logs: { key: EvmPoolKey; at: number }[], fault: (a: number, b: number, nth: number) => Fault, timeoutMs = 10_000) {
  const inner = scanner(5_000_000, logs);
  const st = { logs: 0, halves: 0, sent: [] as number[], throttled: [] as number[] };
  const nth = new Map<string, number>();
  const rpc = evmJsonRpc("https://scan.fault.test", (async (_u: string, init: RequestInit) => {
    const calls = (JSON.parse(init.body as string) as { method: string; params: unknown[] }[]).map((c) => ({ method: c.method, params: c.params }));
    const g = calls.find((c) => c.method === "eth_getLogs");
    if (g !== undefined) {
      st.logs++;
      st.sent.push(performance.now());
      const f = g.params[0] as { fromBlock: string; toBlock: string };
      const [a, b] = [Number(f.fromBlock), Number(f.toBlock)];
      if (b - a + 1 < 10_000 && b < 5_000_000) st.halves++;
      const n = nth.get(`${a}-${b}`) ?? 0;
      nth.set(`${a}-${b}`, n + 1);
      const x = fault(a, b, n);
      if (x === "timeout") return await new Promise<Response>((_, no) => init.signal?.addEventListener("abort", () => no(init.signal!.reason)));
      if (x === "error") throw new Error("socket hang up");
      if (x === "unreach") throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      // a browser's fetch with no response: a TypeError that names no cause
      if (x === "chrome") throw new TypeError("Failed to fetch");
      if (x === "safari") throw new TypeError("Load failed");
      if (x.startsWith("429:")) {
        st.throttled.push(performance.now());
        const ra = x.slice(4);
        return new Response("", { status: 429, headers: ra === "none" ? {} : { "retry-after": ra } });
      }
    }
    return new Response(JSON.stringify(await inner(calls)), { status: 200 });
  }) as unknown as typeof fetch, 1 << 20, timeoutMs);
  return { rpc, st };
}
/** The longest pause in the scan's getLogs sends from `t` on: the gate's wait after a throttle at `t`. */
const gapAfter = (sent: number[], t: number) => {
  const xs = [t, ...sent.filter((x) => x >= t)];
  return Math.max(...xs.slice(1).map((x, i) => x - xs[i]!));
};
const coldQuote = async (scan: EvmRpc, x = 0x3f00) => {
  const token = freshToken();
  const { pools } = warmCase(token, xAt(x));
  const t = performance.now();
  try {
    await evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW, scan);
    return { code: "ok", message: "", ms: performance.now() - t };
  } catch (e) {
    if (!(e instanceof EvmQuoteError)) throw e;
    return { code: e.code as string, message: e.message, ms: performance.now() - t };
  }
};

test("TH7 a scan provider that times out or fails every getLogs refuses rpc_error within the quote's bound and one deadline, never asking on for hours", { timeout: 30_000 }, async () => {
  evmScanBound?.(1_000);
  try {
    for (const how of ["timeout", "error"] as const) {
      const { rpc, st } = faultScan([], () => how, 100);
      const r = await coldQuote(rpc, how === "timeout" ? 0x3f00 : 0x3f10);
      assert.equal(r.code, "rpc_error", `${how}: ${r.message}`);
      assert.ok(r.ms < 1_000 + 100 + 400, `${how}: refused after ${Math.round(r.ms)} ms and ${st.logs} getLogs`);
      // nothing is sent past the bound
      assert.ok(st.sent.every((t) => t - st.sent[0]! < 1_000 + 50), `${how}: a getLogs sent ${Math.round(Math.max(...st.sent) - st.sent[0]!)} ms in`);
    }
  } finally {
    evmScanBound?.();
  }
});

test("TH8 a 429 with Retry-After: 0 still waits the backoff: the provider gets at most a few times the limit in 1.5 s", { timeout: 30_000 }, async () => {
  const t0 = performance.now();
  const { rpc, st } = faultScan(warmCase(freshToken(), xAt(0x3f20)).logs, () => (performance.now() - t0 < 1_500 ? "429:0" : "ok"));
  const r = await coldQuote(rpc, 0x3f20);
  assert.ok(r.code === "ok" || r.code === "no_reference" || r.code === "below_reference", r.message);
  const inWindow = st.sent.filter((t) => t - t0 < 1_500).length;
  assert.ok(inWindow <= 3 * 20, `${inWindow} getLogs in the first 1.5 s`);
});

test("TH9 a refused connection in a span that would split is asked again whole after the backoff: two getLogs a span, no halves", { timeout: 30_000 }, async () => {
  const { rpc, st } = faultScan([], (_a, _b, nth) => (nth === 0 ? "unreach" : "ok"));
  const r = await coldQuote(rpc, 0x3f30);
  assert.notEqual(r.code, "rpc_error", r.message);
  assert.equal(st.halves, 0, `${st.halves} halves`);
  assert.equal(st.logs, 2 * 100, `${st.logs} getLogs`);
});

test("TH10 a later, shorter wait never shortens one already set: a Retry-After: 2 holds the scan even when the burst's other 429s name none", { timeout: 30_000 }, async () => {
  // the first getLogs answers Retry-After: 2, the rest of the first burst (the scan's first 20, its parallel) 429 with
  // no header, after it: counted, never timed, so a loaded machine that sends the burst slowly still sends it all
  let n = 0;
  const { rpc, st } = faultScan([], () => {
    n++;
    if (n > 20) return "ok";
    return n === 1 ? "429:2" : "429:none";
  });
  const r = await coldQuote(rpc, 0x3f40);
  assert.notEqual(r.code, "rpc_error", r.message);
  assert.ok(st.throttled.length > 1, `${st.throttled.length} throttled`);
  const gap = gapAfter(st.sent, st.throttled[0]!);
  assert.ok(gap >= 1_950, `the scan paused ${Math.round(gap)} ms after the Retry-After: 2`);
});

test("TH11 after an answer the backoff starts again at 0.5 s: a throttle event late in a scan waits 0.5 s, not its predecessors' doubled wait", { timeout: 30_000 }, async () => {
  // two throttle events with answers between: the first range asked and the 40th each answer 429 once, no header.
  // Counted by the ranges' first asks, never by the call: the first range's ask again goes out wherever the gate's
  // wake order puts it (call 21 on most runs, 64 on one of 12; at call 60 a plant by call number never fired: PR #337
  // job 127748029764, PR #356 job 127908836623, "1 !== 2")
  let first = 0;
  const { rpc, st } = faultScan([], (_a, _b, nth) => {
    if (nth !== 0) return "ok";
    first++;
    return first === 1 || first === 40 ? "429:none" : "ok";
  });
  const r = await coldQuote(rpc, 0x3f50);
  assert.notEqual(r.code, "rpc_error", r.message);
  assert.equal(st.throttled.length, 2);
  // the 40th range is asked after the first event's wait, so it is an event of its own, not a 429 of the first burst
  assert.ok(st.throttled[1]! - st.throttled[0]! >= 450, `the second 429 came ${Math.round(st.throttled[1]! - st.throttled[0]!)} ms after the first`);
  const wait = gapAfter(st.sent, st.throttled[1]!);
  assert.ok(wait >= 450 && wait < 900, `the second event waited ${Math.round(wait)} ms`);
});

test("TH12 a Retry-After given as an HTTP date is honoured", { timeout: 30_000 }, async () => {
  const when = new Date(Date.now() + 3_000).toUTCString();
  let first = true;
  const { rpc, st } = faultScan([], () => (first ? ((first = false), `429:${when}` as Fault) : "ok"));
  const r = await coldQuote(rpc, 0x3f60);
  assert.notEqual(r.code, "rpc_error", r.message);
  const gap = gapAfter(st.sent, st.throttled[0]!);
  assert.ok(gap >= 1_500, `the scan paused ${Math.round(gap)} ms after a Retry-After of ${when}`);
});

// card evm-buy-hookdata-fee: hook data is the device's own, and the device makes none, on the buy as on the sell (the
// vault lead's note at evm-sell-device-quote's hand-back: the buy took a helper route's hook data for a listed hook)
test("HD1 a helper route carrying hook data on any hop is refused bad_request before any read, so before any signature", async () => {
  let asked = 0;
  // two providers (one function twice is refused as one), neither of which may be asked anything
  const none = (): EvmRpc => async () => {
    asked++;
    throw new Error("no read may be made");
  };
  const clanker = "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"; // Base's pinned Clanker hook, in its own shape
  const routes: EvmRoute[] = [
    { venue: "uniswap-v4", currencyIn: WETH, hops: [{ currency: TOKEN, fee: 0x800000, tickSpacing: 200, hooks: clanker, hookData: "0xdeadbeef" }] },
    { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x00" }] },
    { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: USDC, fee: 500, tickSpacing: 10, hooks: NATIVE, hookData: "0x" }, { currency: TOKEN, fee: 0x800000, tickSpacing: 200, hooks: clanker, hookData: "0x" + "ab".repeat(32) }] },
    // on the first hop only (review fold 1, L3)
    { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: USDC, fee: 500, tickSpacing: 10, hooks: NATIVE, hookData: "0x01" }, { currency: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" }] },
  ];
  for (const route of routes) assert.deepEqual(await verdict(evmPoolBuyQuoteWith({ chain: "base", token: TOKEN, amountIn: AMOUNT, slippageBps: 100, route }, [none(), none()], NOW)), { accepted: false, code: "bad_request" });
  assert.equal(asked, 0);
  // the same providers do answer a route with no hook data: they are asked (and fail), so the refusal above is the
  // hook data's
  const plain: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" }] };
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith({ chain: "base", token: TOKEN, amountIn: AMOUNT, slippageBps: 100, route: plain }, [none(), none()], NOW)), { accepted: false, code: "rpc_error" });
  assert.ok(asked > 0);
});

// card evm-buy-hookdata-fee (review low L5): a sell asked right after its buy, while one provider's head is still a
// block behind the buy's, read W's balance at the block before the buy and was refused fee_on_transfer
const BUY_AT = 5_000_000;
const blockHash = (n: number) => "0x" + W(0xb10c000000000000n + BigInt(n));
/** `rpc` with its heads `heads` ("latest" answers each in turn, then the last), every block named by its number, and W
 *  holding the token only from BUY_AT on: the fee-on-transfer probe at an earlier block reverts. */
/** The most heads one `landed` provider answers: far past any wait's rounds (61 in 30 s). */
const LANDED_MAX_HEADS = 10_000;
function landed(rpc: EvmRpc, heads: number[], asked: { heads: number } = { heads: 0 }, timestamp = T): EvmRpc {
  let k = 0;
  return async (calls) => {
    const out = await rpc(calls);
    return calls.map((c, id) => {
      // W's releases at the sale (card evm-sell-no-release-in-flight): the chain's answer, its finalized block the first
      // head (never counted as a head asked)
      if (c.method === "eth_getLogs") return out[id];
      if (c.method === "eth_getBlockByNumber" && c.params[0] === "finalized") return { jsonrpc: "2.0", id, result: head("0x" + heads[0]!.toString(16), blockHash(heads[0]!), timestamp) };
      if (c.method === "eth_getBlockByNumber") {
        const latest = c.params[0] === "latest";
        // a wait that asks again with no sleep spins without end: refused here, at once, never a test that hangs
        if (latest && ++asked.heads > LANDED_MAX_HEADS) throw new Error(`asked for the head more than ${LANDED_MAX_HEADS} times`);
        const n = latest ? heads[Math.min(k++, heads.length - 1)]! : Number(BigInt(c.params[0] as string));
        return { jsonrpc: "2.0", id, result: head("0x" + n.toString(16), blockHash(n), timestamp) };
      }
      const at = Number(BigInt((c.params[1] as { blockHash: string }).blockHash) - 0xb10c000000000000n);
      const probe = (c.params[2] as Record<string, { code?: string }> | undefined)?.[SELL_W]?.code === quoteMod.EVM_SELL_PROBE_CODE;
      return probe && at < BUY_AT ? { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } } : out[id];
    });
  };
}
const landedSell = (token: string) => {
  const pool: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 2500, tickSpacing: 50, hooks: NATIVE, hookData: "0x" }] };
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: route, boughtBlock: BigInt(BUY_AT), sent: [] } as EvmPoolSellQuoteRequest;
  return { pool, req };
};

test("L5 a sell at its buy's block, one provider a block behind it: the quote waits and reads at the buy's block, never fee_on_transfer", async () => {
  const { pool, req } = landedSell("0x00000000000000000000000000000000000ba5ba");
  // on the mocked clock, so a wait that never ends is refused in mocked time (review fold 2: the sweep's time)
  const q = await timed((mono) => evmPoolSellQuoteWith(req, [landed(chain([pool], 0), [BUY_AT]), landed(chain([pool], 1), [BUY_AT - 1, BUY_AT])], NOW, undefined, undefined, mono), 400, 100);
  assert.equal(q.quote?.block.number, BigInt(BUY_AT), JSON.stringify(q.verdict, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  assert.equal(q.quote?.amountOut, AMOUNT);
  // both providers at the buy's block: no wait, the same quote
  const r = await timed((mono) => evmPoolSellQuoteWith(req, [landed(chain([pool], 0), [BUY_AT + 1]), landed(chain([pool], 1), [BUY_AT])], NOW, undefined, undefined, mono), 400, 100);
  assert.equal(r.quote?.block.number, BigInt(BUY_AT));
  assert.ok(r.ms <= 100, `no wait: ${r.ms} ms`);
});

/** `p` driven on the mocked clock (Date and setTimeout), `step` ms a tick, until it settles or `ticks` run out. A quote
 *  still waiting after every tick is the wait's own failure, never a test that hangs: it throws, naming where the quote
 *  is parked (re-review of b282ce0's CI, L5b and L2: 400 ticks ran in 42 ms with the quote not settled). Each timer the
 *  quote sets is recorded with the line of the kit that set it, so the message names the last stage reached (the last
 *  timer set and fired) and every timer still pending, or says no timer is pending: then the quote waits on a promise
 *  the mocked clock does not drive. */
async function drive<T>(start: () => Promise<T>, ticks: number, step: number): Promise<{ value: T; ms: number }> {
  enableTimers(mock.timers, { apis: ["setTimeout", "Date"], now: 0 });
  const mocked = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  type Timer = { site: string; ms: number; at: number; fired: boolean; cleared: boolean };
  const timers = new Map<unknown, Timer>();
  const t0 = performance.now();
  let lastFired: Timer | undefined;
  const siteOf = (stack = "") => stack.split("\n").find((l) => l.includes("/src/"))?.trim().replace(/^at /, "").replace(/\(?file:\/\/[^)]*\/src\//, "src/").replace(/\)$/, "") ?? "outside the kit";
  globalThis.setTimeout = ((f: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
    const t: Timer = { site: siteOf(new Error().stack), ms: ms ?? 0, at: Date.now(), fired: false, cleared: false };
    const h = mocked.set((...b: unknown[]) => {
      t.fired = true;
      lastFired = t;
      f(...b);
    }, ms, ...a);
    timers.set(h, t);
    return h;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((h: unknown) => {
    const t = timers.get(h);
    if (t !== undefined) t.cleared = true;
    mocked.clear(h as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  try {
    let done = false;
    const p = start().finally(() => (done = true));
    let i = 0;
    for (; i < ticks && !done; i++) {
      await new Promise((r) => setImmediate(r));
      mock.timers.tick(step);
    }
    await new Promise((r) => setImmediate(r));
    if (!done) {
      const now = Date.now();
      const pending = [...timers.values()].filter((t) => !t.fired && !t.cleared);
      const at = (t: Timer) => `${t.site} (${t.ms} ms, set at ${t.at} ms)`;
      assert.fail(
        `still waiting after ${i} ticks of ${step} ms (${now} ms mocked, ${Math.round(performance.now() - t0)} ms real), ${timers.size} timers set; ` +
          `last fired: ${lastFired === undefined ? "none" : at(lastFired)}; ` +
          (pending.length === 0 ? "no timer pending: parked on a promise the mocked clock does not drive" : `pending: ${pending.slice(-4).map(at).join("; ")}`),
      );
    }
    return { value: await p, ms: Date.now() };
  } finally {
    globalThis.setTimeout = mocked.set;
    globalThis.clearTimeout = mocked.clear;
    // every timer still set is cleared before the reset (test/mock-timers.ts), so work that outlives this drive never
    // takes a later drive's timer with it
    resetTimers(mock.timers);
  }
}
test("drive: a timer an earlier drive left set, cleared during a later one by the work that set it, never takes the later one's timer with it", async () => {
  // work that outlives its test (a quote's spare read, a hung provider's pause) sets a timer on one drive's mocked clock
  // and clears it on a later one's; the mocked clock drops what is left set when it is reset, and a timer dropped so
  // kept its place in the clock's queue, so clearing it took out whatever timer held that place then (in CI: L5b's and
  // L2's 500 ms wait for the buy's block and LOW-1's 10 s scan answer, which never fired, and the quote stayed parked
  // to the last tick)
  let left: ReturnType<typeof setTimeout> | undefined;
  await drive(async () => void (left = setTimeout(() => undefined, 60_000)), 1, 100);
  const { ms } = await drive(async () => {
    const wait = new Promise((r) => setTimeout(r, 500));
    clearTimeout(left);
    await wait;
  }, 20, 100);
  assert.ok(ms >= 500, `the wait ended after ${ms} ms`);
});
/** The sell quote's verdict and the mocked time it took, ms: the clock (Date, the wait's monotonic clock here) and
 *  every timer mocked, ticked `step` ms at a time until the quote settles (so the time read is up to two steps late). */
async function timed(run: (mono: () => number) => Promise<unknown>, ticks = 4_000, step = 500) {
  let raw: ReturnType<typeof sellOn> | undefined;
  const { value, ms } = await drive(() => sellVerdict((raw = run(() => Date.now()) as ReturnType<typeof sellOn>)), ticks, step);
  return { verdict: value, ms, quote: await raw!.catch(() => undefined) };
}
/** A buy quote on the mocked clock (Date and setTimeout), 100 ms a tick: its verdict. */
async function timedBuy(run: (mono: () => number) => Promise<unknown>) {
  return (await drive(() => verdict(run(() => Date.now()) as Promise<EvmPoolBuyQuote>), 8_000, 100)).value;
}
/** `rpc`, its head (eth_blockNumber) answered `ms` later and the rest at once */
const slowHead = (rpc: EvmRpc, ms: number): EvmRpc => async (calls) => {
  if (calls.some((c) => c.method === "eth_blockNumber")) await new Promise((r) => setTimeout(r, ms));
  return rpc(calls);
};
/** `rpc`, each answer `ms` later */
const slow = (rpc: EvmRpc, ms: number): EvmRpc => async (calls) => {
  await new Promise((r) => setTimeout(r, ms));
  return rpc(calls);
};

test("L5b a buy's block no provider reaches within EVM_MIN_BLOCK_WAIT_MS is refused not_landed, never quoted at an older block", async () => {
  const { pool, req } = landedSell("0x00000000000000000000000000000000000ba6ba");
  const asked = { heads: 0 };
  const r = await timed((mono) => evmPoolSellQuoteWith({ ...req, boughtBlock: BigInt(BUY_AT + 1) }, [landed(chain([pool], 0), [BUY_AT], asked), landed(chain([pool], 1), [BUY_AT + 1], asked)], NOW, undefined, undefined, mono), 400, 100);
  assert.deepEqual(r.verdict, { accepted: false, code: "not_landed" });
  // asked every 500 ms for 30 s (EVM_MIN_BLOCK_WAIT_MS, as long as a quote's block may be old), both providers each
  // time: 61 rounds, and refused only once that time has passed (review fold 1, L3); the clock moves 100 ms a tick, so
  // a shorter sleep asks more often and fails the count
  assert.equal(quoteMod.EVM_MIN_BLOCK_WAIT_MS, quoteMod.EVM_QUOTE_MAX_AGE_MS);
  assert.equal(asked.heads, 2 * 61);
  assert.ok(r.ms >= quoteMod.EVM_MIN_BLOCK_WAIT_MS, `refused after ${r.ms} ms`);
});

test("M2 the wait for a buy's block ends at EVM_MIN_BLOCK_WAIT_MS whatever a provider's latency: 400 ms and 10 s an answer", async () => {
  const { pool, req } = landedSell("0x00000000000000000000000000000000000ba7ba");
  for (const latency of [400, 10_000]) {
    // provider 1 at the buy's block at once, provider 2 a block below it and `latency` ms an answer
    // (within a second of 30 s: the last sleep, 500 ms, may pass the deadline, and the ticks are 100 ms)
    const r = await timed((mono) => evmPoolSellQuoteWith({ ...req, boughtBlock: BigInt(BUY_AT + 1) }, [landed(chain([pool], 0), [BUY_AT + 1]), slow(landed(chain([pool], 1), [BUY_AT]), latency)], NOW, undefined, undefined, mono), 8_000, 100);
    assert.deepEqual(r.verdict, { accepted: false, code: "not_landed" }, `at ${latency} ms an answer`);
    assert.ok(r.ms >= quoteMod.EVM_MIN_BLOCK_WAIT_MS && r.ms <= quoteMod.EVM_MIN_BLOCK_WAIT_MS + 1_000, `at ${latency} ms an answer, not_landed after ${r.ms} ms, not about 30 s`);
  }
});

test("L2 a block old enough to be stale once the wait for the buy's block is over is refused stale_quote, judged at the clock then", async () => {
  const { pool, req } = landedSell("0x00000000000000000000000000000000000ba8ba");
  // the block is 25 s old when the quote starts (the mocked clock starts at 0, so its time is NOW's)
  const ts = "0x" + ((NOW - 25_000) / 1000).toString(16);
  const lagging = (rounds: number) => [...Array(rounds).fill(BUY_AT - 1), BUY_AT];
  const run = (rounds: number) => (mono: () => number) =>
    evmPoolSellQuoteWith(req, [landed(chain([pool], 0), [BUY_AT], { heads: 0 }, ts), landed(chain([pool], 1), lagging(rounds), { heads: 0 }, ts)], NOW, undefined, undefined, () => mono());
  // provider 2 reaches the buy's block after 10 s: the block is 35 s old then
  assert.deepEqual((await timed(run(21))).verdict, { accepted: false, code: "stale_quote" });
  // after 4.5 s it is 29.5 s old, and quotes
  assert.equal(((await timed(run(9))).verdict as { accepted: boolean }).accepted, true);
  // the edge, to the half second (review fold 2, LOW-2): 30.5 s old after 5.5 s is refused, 30 s after 5 s quotes
  assert.deepEqual((await timed(run(11))).verdict, { accepted: false, code: "stale_quote" });
  assert.equal(((await timed(run(10))).verdict as { accepted: boolean }).accepted, true);
});

test("LOW-1 a block's age counts the time since the quote began: a scan that takes 10 s makes a 25 s-old block stale, on a sell and a buy", async () => {
  // the block is 25 s old when the quote starts; the scan provider answers each request `wait` ms later, and a new
  // token's scan asks twice (its head, then the logs), so 5 s an answer is a 10 s scan (a token of its own each run: the
  // kit keeps a token's scan between quotes). The sell's scan reads Base's whole depth below block 5,000,000 in spans
  // (card evm-quote-warm-round), so there its head alone takes the scan's time, twice `wait`, and its spans answer at once
  const ts = "0x" + ((NOW - 25_000) / 1000).toString(16);
  const sell = (wait: number, token: string) => (mono: () => number) => {
    const { pool, req } = landedSell(token);
    return evmPoolSellQuoteWith(req, [landed(chain([pool], 0), [BUY_AT], { heads: 0 }, ts), landed(chain([pool], 1), [BUY_AT], { heads: 0 }, ts)], NOW, slowHead(scanner(BUY_AT, []), 2 * wait), undefined, () => mono());
  };
  const s10 = await timed(sell(5_000, "0x00000000000000000000000000000000000bb1ba"), 8_000, 100);
  assert.deepEqual(s10.verdict, { accepted: false, code: "stale_quote" }, `after ${s10.ms} ms`);
  // a scan of 4 s: 29 s old, and quotes
  const s4 = await timed(sell(2_000, "0x00000000000000000000000000000000000bb2ba"), 8_000, 100);
  assert.equal((s4.verdict as { accepted: boolean }).accepted, true, `after ${s4.ms} ms`);
  const buyAt = (wait: number, token: string) => (mono: () => number) =>
    evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: { ...v3direct, tokens: [v3direct.tokens[0]!, token] } }, [provider(head("0x100", NEW, ts), flat), provider(head("0x100", NEW, ts), flat)], NOW, slow(scanner(0x100, []), wait), undefined, () => mono());
  assert.deepEqual(await timedBuy(buyAt(5_000, "0x00000000000000000000000000000000000bb3ba")), { accepted: false, code: "stale_quote" });
  const b4 = await timedBuy(buyAt(2_000, "0x00000000000000000000000000000000000bb4ba"));
  assert.equal((b4 as { accepted: boolean }).accepted, true, (b4 as { code?: string }).code);
});

// card evm-quote-warm-round fold 8: the quote reads the latest block on three providers at least (a pair that colludes
// is outvoted, agreedBlock and agreeing), and every read at a past block goes to the venue's fee pair, which keeps state
// a proof's life back (on Robinhood only two providers do, 2026-11-05 01:15Z)
test("V20 Base's and Robinhood's quote lists three providers at least on distinct hosts; every venue with providers names a fee pair of two distinct hosts", () => {
  const all = builder.evmPoolVenues();
  for (const c of ["base", "robinhood"] as const) {
    const p = all[c].providers!;
    assert.ok(p.length >= 3, `${c}: ${p.length} providers`);
    assert.equal(new Set(p.map(hostOf)).size, p.length, c);
  }
  for (const [c, v] of Object.entries(all)) {
    if (!Object.hasOwn(v, "providers")) continue;
    const f = v.feeProviders;
    assert.ok(Array.isArray(f) && f.length === 2 && hostOf(f[0]!) !== hostOf(f[1]!) && f.every((u) => u.startsWith("https://")), `${c}: ${JSON.stringify(f)}`);
  }
});

// ------------------------------------------------------------------ refused connections, counted (re-review of b282ce0: LOW-A, LOW-B, LOW-C)
test("B1r a scan provider that refuses every getLogs connection after its head: rpc_error at a request's fourth refusal in a row, about 3.5 s in, never at the bound", { timeout: 30_000 }, () => onTestClock(async () => {
  const { rpc, st } = faultScan([], () => "unreach");
  const r = await coldQuote(rpc, 0x3f70);
  assert.equal(r.code, "rpc_error", r.message);
  assert.match(r.message, /refused 4 connections in a row/);
  // each span asked at 0, 0.5, 1.5 and 3.5 s, refused at the fourth (59a69e2: 3,062 ms; b282ce0: 60,023 ms, 1,100
  // getLogs, the backoff doubling to 8 s with no count)
  assert.ok(r.ms >= 3_400 && r.ms < 5_000, `refused after ${Math.round(r.ms)} ms and ${st.logs} getLogs`);
  assert.equal(st.halves, 0, `${st.halves} halves`);
  assert.ok(st.logs <= 4 * 100, `${st.logs} getLogs`);
}));

/** A seeded draw in [0, 1) (mulberry32): the same faults on every run. */
const draws = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};

test("B5 30% of the scan's connections refused: each of four cold quotes has its verdict within 5 s, quoted or rpc_error at a fourth refusal in a row, never halved", { timeout: 60_000 }, () => onTestClock(async () => {
  const rows: string[] = [];
  for (let q = 0; q < 4; q++) {
    const draw = draws(0xb5 + q);
    const { rpc, st } = faultScan([], () => (draw() < 0.3 ? "unreach" : "ok"));
    const r = await coldQuote(rpc, 0x3f80 + q);
    // b282ce0: p50 31.5 s, each request's backoff doubling to 8 s with no count
    assert.ok(r.code !== "rpc_error" || /refused 4 connections in a row/.test(r.message), `quote ${q}: ${r.message}`);
    assert.ok(r.ms < 5_000, `quote ${q}: ${r.code} after ${Math.round(r.ms)} ms and ${st.logs} getLogs`);
    assert.equal(st.halves, 0, `quote ${q}: ${st.halves} halves`);
    rows.push(`${r.code} ${Math.round(r.ms)} ms ${st.logs} getLogs`);
  }
  console.log(`B5: ${rows.join("; ")}`);
}));

test("B8 a refused connection is asked again whole in every runtime: Node's (cause ECONNREFUSED), Chrome's (Failed to fetch) and Safari's (Load failed) each cost two getLogs a span, no halves", { timeout: 30_000 }, async () => {
  for (const [how, x] of [["unreach", 0x3f90], ["chrome", 0x3f91], ["safari", 0x3f92]] as const) {
    const { rpc, st } = faultScan([], (_a, _b, nth) => (nth === 0 ? how : "ok"));
    const r = await coldQuote(rpc, x);
    assert.notEqual(r.code, "rpc_error", `${how}: ${r.message}`);
    // b282ce0 in a browser: 2,300 getLogs and 2,200 halves, the TypeError with no cause read as a failure to halve on
    assert.equal(st.halves, 0, `${how}: ${st.halves} halves`);
    assert.equal(st.logs, 2 * 100, `${how}: ${st.logs} getLogs`);
  }
});

test("B2a every getLogs hangs until aborted (bound 3 s): the verdict comes at the bound and every request is aborted there", { timeout: 60_000 }, () => onTestClock(async () => {
  evmScanBound?.(3_000);
  try {
    const token = freshToken();
    const better: ModelPool = { key: keyOf(token, NATIVE, 9000, 9, NATIVE), give: (a) => a };
    const inner = scanner(5_000_000, [{ key: better.key, at: 4_500_000 }]);
    const st = { sent: 0, aborted: 0 };
    const rpc = evmJsonRpc("https://scan.hang.test", (async (_u: string, init: RequestInit) => {
      const calls = (JSON.parse(init.body as string) as { method: string; params: unknown[] }[]).map((c) => ({ method: c.method, params: c.params }));
      if (calls.some((c) => c.method === "eth_getLogs")) {
        st.sent++;
        await new Promise<void>((r) => init.signal?.addEventListener("abort", () => r()));
        st.aborted++;
        throw init.signal!.reason;
      }
      const out = await inner(calls);
      return new Response(JSON.stringify(out.map((a, id) => ({ ...(a as object), id }))), { status: 200 });
    }) as unknown as typeof fetch, 16 << 20);
    const t = performance.now();
    const v = await verdict(evmPoolBuyQuoteWith({ ...warmReq(token), route: seededRoute(token) }, [chain([seeded(token), better], 0), chain([seeded(token), better], 1)], NOW, rpc));
    const ms = performance.now() - t;
    assert.equal((v as { code?: string }).code, "rpc_error");
    assert.ok(ms < 3_000 + 300, `verdict at ${Math.round(ms)} ms`);
    await pause(50);
    assert.equal(st.aborted, st.sent, `${st.aborted} of ${st.sent} aborted`);
  } finally {
    evmScanBound?.();
  }
}));

test("B1a a scan provider that refuses every getLogs connection (bound 2 s): rpc_error at the bound, the refusals backed off", { timeout: 60_000 }, () => onTestClock(async () => {
  evmScanBound?.(2_000);
  try {
    const token = freshToken();
    const inner = scanner(5_000_000, []);
    // each request's send times, on the test's own clock, by its body (a span and its currencies)
    const asks = new Map<string, number[]>();
    const rpc = evmJsonRpc("https://scan.refuse.test", (async (_u: string, init: RequestInit) => {
      const calls = (JSON.parse(init.body as string) as { method: string; params: unknown[] }[]).map((c) => ({ method: c.method, params: c.params }));
      if (calls.some((c) => c.method === "eth_getLogs")) {
        const k = JSON.stringify(calls);
        asks.set(k, [...(asks.get(k) ?? []), performance.now()]);
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }
      const out = await inner(calls);
      return new Response(JSON.stringify(out.map((a, id) => ({ ...(a as object), id }))), { status: 200 });
    }) as unknown as typeof fetch, 16 << 20);
    const t = performance.now();
    const v = await verdict(evmPoolBuyQuoteWith({ ...warmReq(token), route: seededRoute(token) }, [chain([seeded(token)], 0), chain([seeded(token)], 1)], NOW, rpc));
    const ms = performance.now() - t;
    assert.equal((v as { code?: string }).code, "rpc_error");
    assert.ok(ms < 2_000 + 300, `verdict at ${Math.round(ms)} ms`);
    // each request asked again 0.5 s, then 1 s after a refusal, so three times at most before the bound (the fourth would
    // be 3.5 s after its first): gaps read per request, never a total, which a slower machine changes (CI at f4d842f:
    // 308 getLogs where a total of 300 was asserted)
    // a wait that reaches the bound is cut there and may end a millisecond early, so an ask at the bound is no gap
    assert.ok(asks.size > 0, "no getLogs asked");
    for (const [k, all] of asks) {
      const ts = all.filter((x) => x < t + 2_000 - 50);
      const gaps = ts.slice(1).map((x, i) => x - ts[i]!);
      assert.ok(ts.length <= 3, `${ts.length} asks of one request: ${k.slice(0, 80)}`);
      assert.ok(gaps.every((g, i) => g >= [500, 1_000][i]! - 5), `gaps ${gaps.map(Math.round).join(", ")} ms: ${k.slice(0, 80)}`);
    }
  } finally {
    evmScanBound?.();
  }
}));

test("B6 a sell's wait for its buy's block, the list reordered by round 1: round 2's block is confirmed by the other provider, never the lower head's own", { timeout: 30_000 }, async () => {
  const { pool, req } = landedSell("0x00000000000000000000000000000000000ba5b6");
  const byNum: string[] = [];
  const tag = (name: string, rpc: EvmRpc, delayMs: number): EvmRpc => async (calls) => {
    const latest = calls.some((c) => c.method === "eth_getBlockByNumber" && c.params[0] === "latest");
    // the confirm's reads; W's releases (card evm-sell-no-release-in-flight: the finalized block, and the logs each with the
    // agreed block's header) are read on both providers, and are not a confirm
    if (!calls.some((c) => c.method === "eth_getLogs") && calls.some((c) => c.method === "eth_getBlockByNumber" && c.params[0] !== "latest" && c.params[0] !== "finalized")) byNum.push(name);
    if (latest && delayMs > 0) await pause(delayMs);
    return rpc(calls);
  };
  // p0 a block behind the buy's, then at it, each head 60 ms late; p1 at the buy's block at once: round 1 reorders the
  // list to p1, p0, and round 2's first answer is p1's, so its block is p1's and the confirm goes to p0
  const p0 = tag("p0", landed(chain([pool], 0), [BUY_AT - 1, BUY_AT]), 60);
  const p1 = tag("p1", landed(chain([pool], 1), [BUY_AT]), 0);
  const v = await verdict(evmPoolSellQuoteWith(req, [p0, p1], NOW));
  assert.equal((v as { accepted?: boolean }).accepted, true, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)));
  assert.ok(byNum.length > 0 && byNum.every((n) => n === "p0"), `by-number reads asked of ${byNum.join(",")}`);
});

// ------------------------------------------------------------------ a lagging provider of the pair (card evm-quote-lag-held)
// Review of b282ce0, MEDIUM-A: publicnode answering its latest block 100 back refused 9 of 10 Robinhood warm quotes in
// about 0.5 s, and Base's blastapi 5 back 2 of 5. Its head paired with an up-to-date one (within maxLag), so the agreed
// block was its own, more than maxLag below the scan provider's head, a block ahead of the pair's (Robinhood's own RPC
// leads the others); the scan refused rpc_disagree, and nothing held the lagger, which stayed ranked first.
test("LH1 the provider ranked first answers its head maxLag back: ten warm quotes on a chain's watch all end ok, the lagger held from the first", { timeout: 30_000 }, async () => {
  // its own state, whatever ran before it in this process and however loaded the machine: providers on hosts no other
  // test names (the ranking and the holds are kept per URL), its own fetch, its own watch on the device's clock NOW
  // with no background reads, its own scan provider; the lagger is first by the venue list's order (nothing measured),
  // never by a race of speeds
  const lag = BigInt(builder.evmPoolVenues().base.maxLag!);
  const H = 5_000_000;
  const token = freshToken();
  const pools = [best(token)];
  const model = chain(pools, 0, H);
  const st = { heads: 0, reads: 0 };
  // a provider whose latest block is `top`, holding every block up to it by number (each model block has the hash NEW)
  const at = (top: number, lagger = false): EvmRpc => async (calls) => {
    if (lagger && calls.some((c) => c.method === "eth_call")) st.reads++;
    if (!calls.some((c) => c.method === "eth_getBlockByNumber")) return model(calls);
    return calls.map((c, id) => {
      if (lagger && c.params[0] === "latest") st.heads++;
      const n = c.params[0] === "latest" ? top : Number(c.params[0]);
      return { jsonrpc: "2.0", id, result: n <= top ? head("0x" + n.toString(16)) : null };
    });
  };
  const { f, urls } = hosted({
    "lag.lh1.test": { rpc: at(H - Number(lag), true), ms: 1 },
    "a.lh1.test": { rpc: at(H), ms: 1 },
    "b.lh1.test": { rpc: at(H), ms: 1 },
    "c.lh1.test": { rpc: at(H), ms: 1 },
    "d.lh1.test": { rpc: at(H), ms: 1 },
  });
  const lagger = "lag.lh1.test";
  const ranked = () => quoteMod.evmProviders(quoteMod.evmRanked(urls), f);
  const watch = quoteMod.evmHeadWatch(ranked, lag, () => NOW, false);
  // the scan provider's head a block past the pair's (Robinhood's own RPC leads the others)
  const scan = scanner(H + 1, []);
  assert.equal(hostOf(quoteMod.evmRanked(urls)[0]!), lagger, "the lagger is ranked first");
  // held, read off the hold itself (as V13 reads it): ranked after a provider never measured, which goes after every
  // measured one not held
  const held = () => {
    const r = quoteMod.evmRanked([...urls, "https://unmeasured.lh1.test/"]).map(hostOf);
    return r.indexOf(lagger) > r.indexOf("unmeasured.lh1.test");
  };
  const rows: string[] = [];
  for (let q = 0; q < 10; q++) {
    const before = st.heads;
    const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), ranked(), NOW, scan, watch));
    rows.push(`${q + 1}: ${(v as { accepted: boolean }).accepted ? `ok at ${(v as { block: bigint }).block}` : (v as { code: string }).code} (lagger heads ${st.heads - before})`);
    assert.equal((v as { accepted: boolean }).accepted, true, rows.join("; "));
    // read at the up-to-date pair's block, never the lagger's
    assert.equal((v as { block: bigint }).block, BigInt(H), rows.join("; "));
    assert.ok(held(), `after quote ${q + 1} the lagger is held: ${rows.join("; ")}`);
  }
  // the reads go to the pair that agreed, the lagger last: a live lagger holds no block past its head, so a read asked
  // of it first waits out askAt's retries
  assert.equal(st.reads, 0, "the lagger is asked no read");
});

test("LH2 a provider that answers fast with a 200 carrying a state error ranks behind the others, held, never first by its speed", async () => {
  quoteMod.evmSpeedReset();
  const token = freshToken();
  const pools = [best(token)];
  // past its state cut: its heads answer, every read at a block names state it no longer holds
  const pruned = (rpc: EvmRpc): EvmRpc => async (calls) =>
    calls.some((c) => c.method === "eth_call") ? calls.map((_, id) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "historical state 0x5f2c… is not available" } })) : rpc(calls);
  const { f, urls, idle } = hosted({
    "cut.lh2.test": { rpc: pruned(chain(pools, 0)), ms: 1 },
    "a.lh2.test": { rpc: chain(pools, 0), ms: 80 },
    "b.lh2.test": { rpc: chain(pools, 0), ms: 80 },
  });
  for (let i = 0; i < 3; i++) await Promise.all(quoteMod.evmProviders(urls, f).map((r) => r([{ method: "eth_getBlockByNumber", params: ["latest", false] }])));
  assert.equal(hostOf(quoteMod.evmRanked(urls)[0]!), "cut.lh2.test", "it is the fastest");
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), quoteMod.evmProviders(quoteMod.evmRanked(urls), f), NOW));
  assert.equal((v as { accepted: boolean }).accepted, true, big(v));
  await idle();
  assert.equal(hostOf(quoteMod.evmRanked(urls).at(-1)!), "cut.lh2.test", `ranked ${quoteMod.evmRanked(urls).map(hostOf).join(",")}`);
  // and one answer of the kind alone holds it, whatever its speed
  quoteMod.evmSpeedReset();
  const [cut] = quoteMod.evmProviders(urls, f);
  await cut!([{ method: "eth_call", params: [{ to: NATIVE, data: "0x" }, "latest"] }]);
  assert.equal(hostOf(quoteMod.evmRanked(urls).at(-1)!), "cut.lh2.test");
});

// the review of the lag hold (card evm-quote-lag-held): MED-1 a non-2xx answer, MED-2 the retry's majority, LOW-1 one
// hold a quote, LOW-2 a revert, LOW-3 the no-longer answers alone, LOW-4 the two-provider list, LOW-5 one wait
/** A provider at `top` holding every block up to it by number (each model block has the hash NEW), or, with `fake`,
 *  naming every block it is asked for as `top` under that hash. */
const atTop = (pools: ModelPool[], top: number, fake?: string): EvmRpc => {
  const model = chain(pools, 0, top);
  return async (calls) => {
    if (!calls.some((c) => c.method === "eth_getBlockByNumber")) return model(calls);
    return calls.map((c, id) => {
      if (fake !== undefined) return { jsonrpc: "2.0", id, result: head("0x" + top.toString(16), fake) };
      const n = c.params[0] === "latest" ? top : Number(c.params[0]);
      return { jsonrpc: "2.0", id, result: n <= top ? head("0x" + n.toString(16)) : null };
    });
  };
};
const BASE_LAG = Number(builder.evmPoolVenues().base.maxLag!);

test("LM2 the retry without a held provider still needs more than half the quote's whole list to confirm a contested block: colluders never decide (4 providers, 2 colluding; 6, 3)", async () => {
  const H = 7_000_000;
  const FAKE = "0x" + "cc".repeat(32);
  for (const [n, liars] of [[4, 2], [6, 3]] as const) {
    const token = freshToken();
    const pools = [best(token)];
    // asked in this order: an honest provider maxLag back, an honest one at the head, the colluders (a block a block
    // below the head under a hash no honest provider holds), the rest honest
    const rpcs = [atTop(pools, H - BASE_LAG), atTop(pools, H), ...Array.from({ length: liars }, () => atTop(pools, H - 1, FAKE)), ...Array.from({ length: n - 2 - liars }, () => atTop(pools, H))];
    let v: string;
    try {
      const q = await evmPoolBuyQuoteWith(warmReq(token), rpcs, NOW, scanner(H + 1, []));
      v = `accepted at ${q.block.number}${q.block.hash === FAKE ? " under the colluders' hash" : ""}`;
    } catch (e) {
      if (!(e instanceof EvmQuoteError)) throw e;
      v = `refused ${e.code}`;
    }
    assert.equal(v, "refused rpc_disagree", `${n} providers, ${liars} colluding`);
  }
});

test("LL4 a two-provider list whose lower head lags past the scan provider's: nothing to agree again on, the quote refuses rpc_disagree, never throws a non-quote error", async () => {
  const H = 9_000_000;
  const token = freshToken();
  const pools = [best(token)];
  let v: string;
  try {
    const q = await evmPoolBuyQuoteWith(warmReq(token), [atTop(pools, H - BASE_LAG), atTop(pools, H)], NOW, scanner(H + 1, []));
    v = `accepted at ${q.block.number}`;
  } catch (e) {
    v = e instanceof EvmQuoteError ? `refused ${e.code}` : `threw ${String(e)}`;
  }
  assert.equal(v, "refused rpc_disagree");
});

test("LL1 one scan head past five up-to-date providers' holds one of them in a quote, never two", async () => {
  const H = 8_000_000;
  const token = freshToken();
  const pools = [best(token)];
  const { f, urls, idle } = hosted(Object.fromEntries(["a", "b", "c", "d", "e"].map((h) => [`${h}.ll1.test`, { rpc: atTop(pools, H), ms: 1 }])));
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), quoteMod.evmProviders(urls, f), NOW, scanner(H + BASE_LAG + 1, [])));
  assert.deepEqual(v, { accepted: false, code: "rpc_disagree" });
  await idle();
  const r = quoteMod.evmRanked([...urls, "https://unmeasured.ll1.test/"]).map(hostOf);
  assert.equal(r.slice(r.indexOf("unmeasured.ll1.test") + 1).length, 1, `held: ${r.join(",")}`);
});

/** `rpc` on `host` answering every eth_call batch with `status` and `body` (the rest as `rpc` does). */
const answering = (host: string, status: number, body: string, models: Record<string, EvmRpc>) =>
  (async (u: string, init: RequestInit) => {
    const h = new URL(u).hostname;
    const calls = JSON.parse(init.body as string) as { id: number; method: string; params: unknown[] }[];
    if (h === host && calls.some((c) => c.method === "eth_call")) return new Response(body, { status });
    await pause(h === host ? 1 : 80);
    const out = await models[h]!(calls.map((c) => ({ method: c.method, params: c.params })));
    return new Response(JSON.stringify(out.map((a, i) => ({ ...(a as object), id: calls[i]!.id }))));
  }) as unknown as typeof fetch;
// held or not, read off the hold itself: after a provider never measured, which goes after every measured one not held
const isHeld = (urls: readonly string[], host: string) => {
  const r = quoteMod.evmRanked([...urls, "https://unmeasured.lh.test/"]).map(hostOf);
  return r.indexOf(host) > r.indexOf("unmeasured.lh.test");
};
// each eth_call of a batch answered with this JSON-RPC error
const errs = (n: number, code: number, message: string) => JSON.stringify(Array.from({ length: n }, (_, id) => ({ jsonrpc: "2.0", id, error: { code, message } })));

test("LH3 robinhood-rpc.publicnode.com's own answer past its state cut (HTTP 403, -32602 \"Archive requests require a personal token\") holds it: never a fast answer", async () => {
  const token = freshToken();
  const pools = [best(token)];
  const models = { "cut.lh3.test": chain(pools, 0), "a.lh3.test": chain(pools, 0), "b.lh3.test": chain(pools, 0) };
  const urls = Object.keys(models).map((h) => "https://" + h);
  // read 2026-11-05 11:01Z, a state read 100 and 130 blocks back, 6 of 6
  const body = '[{"jsonrpc":"2.0","error":{"code":-32602,"message":"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"},"id":0}]';
  const f = answering("cut.lh3.test", 403, body, models);
  const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), quoteMod.evmProviders(urls, f), NOW));
  assert.equal((v as { accepted: boolean }).accepted, true, big(v));
  assert.ok(isHeld(urls, "cut.lh3.test"), quoteMod.evmRanked(urls).map(hostOf).join(","));
  // the same answer under a 200 holds it too, and so does any other status outside 2xx, a well-formed answer inside it
  // included
  for (const [status, b] of [[200, errs(1, -32602, "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode")], [500, "{}"], [403, ""], [403, '[{"jsonrpc":"2.0","id":0,"result":"0x01"}]']] as const) {
    const urls2 = [`https://s${status}${b.length}.lh3.test`];
    const g = answering(new URL(urls2[0]!).hostname, status, b, {});
    await quoteMod.evmProviders([...urls2, "https://x.lh3.test"], g)[0]!([{ method: "eth_call", params: [{ to: NATIVE, data: "0x" }, "latest"] }]).catch(() => {});
    assert.ok(isHeld(urls2, new URL(urls2[0]!).hostname), `${status} ${b.slice(0, 40)}`);
  }
});

test("LH2b a revert never holds a provider, whatever its string, nor an answer for a block it does not hold yet: only the no-longer answers do", async () => {
  const cases: [string, number, string, boolean][] = [
    // a call that reverts with "header not found" or a historical-state string: every pinned Base provider passes the
    // string through (2026-11-05 10:54Z)
    ["r1", 3, "execution reverted: header not found", false],
    ["r2", 3, "execution reverted: historical state 0x5f2c is not available", false],
    ["r3", -32000, "execution reverted: historical state 0x5f2c is not available", false],
    // code 3 is the execution error's own code, whatever its message says
    ["r4", 3, "historical state 0x5f2c is not available", false],
    // not yet, which askAt asks again: Base's (-32001, base-rpc.publicnode.com 2026-11-03 19:09Z) and a lagging backend's
    ["n1", -32001, "block not found: canonical hash 0x1111111111111111111111111111111111111111111111111111111111111111", false],
    ["n2", -32000, "header not found", false],
    // no longer
    // robinhood.drpc.org, 200, code 27, to a state read by hash 100 to 2,000 blocks back, 6 of 6 (2026-11-05 11:53Z)
    ["n3", 27, "Unknown state. First available state is 1", true],
    ["h1", -32000, "historical state 6643e0bcdc929518b5f64f26a3c7a6482b7ac94e3edb3f36e616cbbbf086f42a is not available", true],
    ["h2", -32602, "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode", true],
  ];
  for (const [name, code, message, hold] of cases) {
    const url = `https://${name}.lh2b.test`;
    const g = answering(`${name}.lh2b.test`, 200, errs(1, code, message), {});
    await quoteMod.evmProviders([url, "https://x.lh2b.test"], g)[0]!([{ method: "eth_call", params: [{ to: NATIVE, data: "0x" }, "latest"] }]);
    assert.equal(isHeld([url], `${name}.lh2b.test`), hold, `${code} ${message}`);
  }
});

test("LW a sell's retry without a held provider waits for the buy's block to the first wait's deadline, never one of its own", async () => {
  const { pool, req } = landedSell("0x00000000000000000000000000000000000ba7b7");
  // blocks dated ahead of the device's clock, so no wait here makes one stale
  const ts = "0x" + ((NOW + 40_000) / 1000).toString(16);
  const min = BUY_AT + 1;
  // the first two reach the buy's block 29 s in (58 rounds 0.5 s apart), the lower a lag behind the other; the scan
  // provider's head is past the lower one by more than maxLag, so it is held and the block agreed again on the other
  // and two that never reach the buy's block
  const lagging = landed(chain([pool], 0), [...Array(58).fill(BUY_AT), min], { heads: 0 }, ts);
  const ahead = landed(chain([pool], 1), [...Array(58).fill(BUY_AT + BASE_LAG), min + BASE_LAG], { heads: 0 }, ts);
  const behind1 = landed(chain([pool], 1), [BUY_AT], { heads: 0 }, ts);
  const behind2 = landed(chain([pool], 1), [BUY_AT], { heads: 0 }, ts);
  const r = await timed((mono) => evmPoolSellQuoteWith({ ...req, boughtBlock: BigInt(min) }, [lagging, ahead, behind1, behind2], NOW, scanner(min + BASE_LAG + 1, []), undefined, mono), 1_400, 100);
  assert.deepEqual(r.verdict, { accepted: false, code: "not_landed" }, `after ${r.ms} ms: ${big(r.verdict)}`);
  // the first agreement waited 29 s, so not about 59 s
  assert.ok(r.ms >= 29_000 && r.ms <= quoteMod.EVM_MIN_BLOCK_WAIT_MS + 1_000, `not_landed after ${r.ms} ms, the first wait's deadline at ${quoteMod.EVM_MIN_BLOCK_WAIT_MS} ms`);
});

// the re-review of the fold (card evm-quote-lag-held): RQ1 drpc past its state cut, RQ2-RQ4 a revert is never provider
// state, LQ3 a refused answer's body, LQ4 a not-yet answer, LQ5 a compute-units limit
test("RQ1 robinhood.drpc.org's answer past its state cut (200, code 27 \"Unknown state. First available state is 1\") ranks it behind the others, never first by its speed", () => onTestClock(async () => {
  quoteMod.evmSpeedReset();
  const token = freshToken();
  const pools = [best(token)];
  // read 2026-11-05 11:53Z on robinhood.drpc.org: a state read by hash 100, 200, 1,000 and 2,000 blocks behind its head
  const pruned = (rpc: EvmRpc): EvmRpc => async (calls) =>
    calls.some((c) => c.method === "eth_call") ? calls.map((_, id) => ({ jsonrpc: "2.0", id, error: { code: 27, message: "Unknown state. First available state is 1" } })) : rpc(calls);
  const { f, urls, idle } = hosted({
    "cut.rq1.test": { rpc: pruned(chain(pools, 0)), ms: 1 },
    "a.rq1.test": { rpc: chain(pools, 0), ms: 80 },
    "b.rq1.test": { rpc: chain(pools, 0), ms: 80 },
  });
  for (let i = 0; i < 3; i++) await Promise.all(quoteMod.evmProviders(urls, f).map((r) => r([{ method: "eth_getBlockByNumber", params: ["latest", false] }])));
  assert.equal(hostOf(quoteMod.evmRanked(urls)[0]!), "cut.rq1.test", "it is the fastest");
  const ms: number[] = [];
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    const v = await verdict(evmPoolBuyQuoteWith(warmReq(token), quoteMod.evmProviders(quoteMod.evmRanked(urls), f), NOW));
    ms.push(Math.round(performance.now() - t));
    assert.equal((v as { accepted: boolean }).accepted, true, big(v));
    await idle();
    await pause(1700);
  }
  console.log(`RQ1 quotes took ${ms.join(", ")} ms; ranked ${quoteMod.evmRanked(urls).map(hostOf).join(",")}`);
  assert.equal(hostOf(quoteMod.evmRanked(urls).at(-1)!), "cut.rq1.test", `ranked ${quoteMod.evmRanked(urls).map(hostOf).join(",")}; quotes took ${ms.join(", ")} ms`);
}));

test("RQ2 a revert whose string reads like a block not held yet (code 3 \"execution reverted: header not found\") is asked once, never again as a block not held yet", async () => {
  const { pool, req } = landedSell("0x00000000000000000000000000000000000ba7c1");
  let probes = 0;
  const reverting = (rpc: EvmRpc): EvmRpc => async (calls) => {
    const out = await rpc(calls);
    return calls.map((c, id) => {
      const probe = (c.params[2] as Record<string, { code?: string }> | undefined)?.[SELL_W]?.code === quoteMod.EVM_SELL_PROBE_CODE;
      if (!probe) return out[id];
      probes++;
      return { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted: header not found" } };
    });
  };
  const r = await timed((mono) => evmPoolSellQuoteWith(req, [landed(reverting(chain([pool], 0)), [BUY_AT]), landed(reverting(chain([pool], 1)), [BUY_AT])], NOW, undefined, undefined, mono), 400, 100);
  console.log(`RQ2 probes asked ${probes} times; ${big(r.verdict)} after ${r.ms} ms (mocked clock)`);
  assert.equal(probes, 2, `asked ${probes} times; ${big(r.verdict)} after ${r.ms} ms`);
});

test("RQ3 a revert carrying a rate-limit string (code 3) never holds a provider", async () => {
  for (const [name, message] of [["q1", "execution reverted: rate limit"], ["q2", "execution reverted: Too Many Requests"]] as const) {
    const url = `https://${name}.rq3.test`;
    const g = answering(`${name}.rq3.test`, 200, errs(1, 3, message), {});
    await quoteMod.evmProviders([url, "https://x.rq3.test"], g)[0]!([{ method: "eth_call", params: [{ to: NATIVE, data: "0x" }, "latest"] }]);
    assert.equal(isHeld([url], `${name}.rq3.test`), false, message);
  }
});

test("RQ4 a sell whose token's transfer reverts with a rate-limit string is asked once per provider, never again as a rate limit", async () => {
  const { pool, req } = landedSell("0x00000000000000000000000000000000000ba7c2");
  let probes = 0;
  const reverting = (rpc: EvmRpc): EvmRpc => async (calls) => {
    const out = await rpc(calls);
    return calls.map((c, id) => {
      const probe = (c.params[2] as Record<string, { code?: string }> | undefined)?.[SELL_W]?.code === quoteMod.EVM_SELL_PROBE_CODE;
      if (!probe) return out[id];
      probes++;
      return { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted: rate limit" } };
    });
  };
  const r = await timed((mono) => evmPoolSellQuoteWith(req, [landed(reverting(chain([pool], 0)), [BUY_AT]), landed(reverting(chain([pool], 1)), [BUY_AT])], NOW, undefined, undefined, mono), 400, 100);
  console.log(`RQ4 probes asked ${probes} times; ${big(r.verdict)} after ${r.ms} ms (mocked clock)`);
  assert.equal(probes, 2, `asked ${probes} times; ${big(r.verdict)} after ${r.ms} ms`);
});

test("LQ3 an answer outside 2xx is refused without its body read, and its body is cancelled, never left open", async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull: (c) => c.enqueue(new TextEncoder().encode("[")), cancel: () => void (cancelled = true) });
  const f = (async () => new Response(body, { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(evmJsonRpc("https://lq3.test", f)([{ method: "eth_blockNumber", params: [] }]), /HTTP 403/);
  assert.equal(cancelled, true);
});

test("LQ4 an answer for a block a provider does not hold yet is neither held nor timed: a fast not-yet answer never ranks a provider first", async () => {
  const slow = "https://slow.lq4.test", fast = "https://fast.lq4.test", none = "https://unmeasured.lq4.test";
  const f = (async (u: string, init: RequestInit) => {
    const calls = JSON.parse(init.body as string) as { id: number }[];
    if (new URL(u).hostname === "slow.lq4.test") {
      await pause(80);
      return new Response(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: "0x01" }))));
    }
    // base-rpc.publicnode.com's not-yet answer (-32001, 2026-11-03 19:09Z), and a header asked before the provider has it
    return new Response(JSON.stringify(calls.map((c, i) => (i === 0 ? { jsonrpc: "2.0", id: c.id, error: { code: -32001, message: "block not found: canonical hash 0x" + "11".repeat(32) } } : { jsonrpc: "2.0", id: c.id, result: null }))));
  }) as unknown as typeof fetch;
  const [s, q] = quoteMod.evmProviders([slow, fast, none], f);
  await s!([{ method: "eth_call", params: [{ to: NATIVE, data: "0x" }, "latest"] }]);
  await q!([{ method: "eth_call", params: [{ to: NATIVE, data: "0x" }, "latest"] }, { method: "eth_getBlockByNumber", params: ["0x10", false] }]);
  assert.deepEqual(quoteMod.evmRanked([slow, fast, none]).map(hostOf), ["slow.lq4.test", "fast.lq4.test", "unmeasured.lq4.test"]);
});

test("LQ5 a call's error naming the provider's compute units per second holds it, as any rate limit does", async () => {
  const url = "https://cu.lq5.test";
  // base.meowrpc.com, a JSON-RPC error inside the answer, 2026-11-04 23:48Z (the pinned providers' read); blastapi the same
  const g = answering("cu.lq5.test", 200, errs(1, 429, "Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message."), {});
  await quoteMod.evmProviders([url, "https://x.lq5.test"], g)[0]!([{ method: "eth_call", params: [{ to: NATIVE, data: "0x" }, "latest"] }]);
  assert.ok(isHeld([url], "cu.lq5.test"));
});

// ------------------------------------------------------------------ the second scan provider (card evm-scan-second-provider)
// App live runs 42053555246 and 42059239410 (2026-11-05 15:18Z, 15:51Z): Base cold quotes ended rpc_error at 60.3 s ("the
// scan provider did not answer within the quote's bound"), a warm one in 193 ms ("the scan provider answered no logs"),
// and Robinhood warm quotes at 56-60 s on its scan provider's rate limit. Each case below holds the first scan provider
// and the second (the venue's scan.spare) finds the token's real pool, which holds the seeded route: below_reference.
const pairQuote = async (token: string, first: EvmRpc, second: EvmRpc, chainName: "base" | "robinhood" = "base", headNo = 5_000_000) => {
  const pools = [seeded(token), real(token)];
  const t = performance.now();
  const v = await verdict(evmPoolBuyQuoteWith({ chain: chainName, token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) } as EvmPoolBuyQuoteRequest, [chain(pools, 0, headNo), chain(pools, 1, headNo)], NOW, [first, second]));
  return { v, ms: performance.now() - t };
};
const realAt = (token: string, at: number) => [{ key: real(token).key, at }];

test("SP1 a first scan provider that refuses connections: the scan goes on at the second at once, on Base and Robinhood", { timeout: 30_000 }, () => onTestClock(async () => {
  for (const [c, token] of [["base", "0x00000000000000000000000000000000005c4501"], ["robinhood", "0x00000000000000000000000000000000005c4502"]] as const) {
    // the most times any one range was asked of the first before this ask (0: asked once)
    let again = 0;
    const { rpc, st } = faultScan([], (_a, _b, nth) => {
      again = Math.max(again, nth);
      return "unreach";
    });
    const asked: [number, number][] = [];
    const { v } = await pairQuote(token, rpc, scanner(5_000_000, realAt(token, 4_500_000), asked), c);
    assert.deepEqual(v, below, c);
    // each refused request goes to the second at its first refusal: no range is asked of the first again (the gate
    // without a second asks it again after 0.5, 1 and 2 s, refusing at the fourth)
    assert.equal(again, 0, `${c}: a range asked of the first ${again + 1} times`);
    assert.ok(st.logs > 0 && asked.length > 0, `${c}: ${st.logs} getLogs on the first, ${asked.length} on the second`);
    // the second reads in its own span: Base 1,000 blocks (Tenderly), Robinhood 2,000 (daybreak)
    const span = c === "base" ? 1_000 : 2_000;
    assert.ok(asked.every(([a, b]) => b - a + 1 <= span), `${c}: a request on the second spans more than ${span}`);
  }
  // a first that refuses its head too: the head is the second's, and each request it refuses goes to the second
  const token = "0x00000000000000000000000000000000005c4503";
  const down = evmJsonRpc("https://down.s1.test", (async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  }) as unknown as typeof fetch);
  assert.deepEqual((await pairQuote(token, down, scanner(5_000_000, realAt(token, 4_500_000)))).v, below);
}));

/** A warm quote: the token's scan read up to 5,000,000 by a quote before, the chain's head now 5,000,010, the real pool
 *  made at 5,000,005, so only the second's answer for those ten blocks finds it. */
const warmPair = async (token: string, first: EvmRpc, chainName: "base" | "robinhood" = "base") => {
  await pairQuote(token, scanner(5_000_000, []), scanner(5_000_000, []), chainName);
  const asked: [number, number][] = [];
  const r = await pairQuote(token, first, scanner(5_000_010, realAt(token, 5_000_005), asked), chainName, 5_000_010);
  return { ...r, asked };
};

test("SP2 a first scan provider that does not answer a warm scan: the second has its blocks after 2 s, a cold scan keeps the whole bound on the first", { timeout: 30_000 }, () => onTestClock(async () => {
  const token = "0x00000000000000000000000000000000005c4504";
  const head = scanner(5_000_010, []);
  // the first answers its head and never a getLogs, until aborted; each abort's reason is kept
  const why: string[] = [];
  const hangs: EvmRpc = (calls, signal) =>
    calls.some((c) => c.method === "eth_getLogs")
      ? new Promise((_, no) =>
          signal?.addEventListener("abort", () => {
            why.push(String((signal.reason as Error | undefined)?.message ?? signal.reason));
            no(signal.reason);
          }),
        )
      : head(calls);
  const { v, asked } = await warmPair(token, hangs);
  assert.deepEqual(v, below);
  // the first's one getLogs was ended at the 2 s hold, never at its own 10 s timeout or the quote's 60 s bound, and
  // never asked again
  assert.deepEqual(why, ["rpc_error: the scan provider did not answer within 2000 ms"]);
  assert.deepEqual(asked, [[5_000_001, 5_000_010], [5_000_001, 5_000_010]]);
  // a cold scan the second cannot carry in one round stays on the first while it answers: its newest request, answered
  // after 2.5 s, is waited for, never passed over at 2 s
  const token2 = "0x00000000000000000000000000000000005c4508";
  const inner = scanner(5_000_000, realAt(token2, 4_999_000));
  const late: EvmRpc = async (calls) => {
    if (calls.some((c) => c.method === "eth_getLogs" && Number((c.params[0] as { toBlock: string }).toBlock) === 5_000_000)) await pause(2_500);
    return inner(calls);
  };
  const second: [number, number][] = [];
  const cold = await pairQuote(token2, late, scanner(5_000_000, [], second));
  assert.deepEqual(cold.v, below);
  assert.equal(second.length, 0, "the second read a cold scan's blocks");
}));

test("SP3 a first scan provider that answers no logs from behind the head: the second's answer counts; one that answers an error for blocks it holds: never the second's", { timeout: 30_000 }, async () => {
  // base-rpc.publicnode.com's answer to a range past the backend's head (-32602 on blastapi's and bloXroute's: "block
  // range extends beyond current head block", 2026-11-05 16:13Z), the warm quote's "answered no logs" in 193 ms, with
  // no block at the head in the same batch: a lag
  const token = "0x00000000000000000000000000000000005c4505";
  const refusing = scanner(5_000_000, realAt(token, 4_999_999));
  const pastHead = { code: -32602, message: "block range extends beyond current head block" };
  const noLogs: EvmRpc = async (calls) => {
    const out = await refusing(calls);
    return out.map((o, i) => {
      const c = calls[i]!;
      if (c.method === "eth_getLogs" && Number((c.params[0] as { toBlock: string }).toBlock) >= 4_999_990) return { jsonrpc: "2.0", id: i, error: pastHead };
      if (c.method === "eth_getBlockByNumber" && Number(c.params[0]) >= 4_999_990) return { jsonrpc: "2.0", id: i, error: pastHead };
      return o;
    });
  };
  assert.deepEqual((await pairQuote(token, noLogs, scanner(5_000_000, realAt(token, 4_999_999)))).v, below);
  // the same error where the first holds the request's last block is its answer: its halves are asked of it, never of
  // the second (review of 1277e8af), so a first that answers every range so ends at the quote's bound, rpc_error
  const token1 = "0x00000000000000000000000000000000005c45a5";
  const holding = scanner(5_000_000, realAt(token1, 4_999_999));
  const errs: EvmRpc = async (calls) => (await holding(calls)).map((o, i) => (calls[i]!.method === "eth_getLogs" ? { jsonrpc: "2.0", id: i, error: pastHead } : o));
  const secondAsked: [number, number][] = [];
  evmScanBound?.(1_500);
  try {
    assert.deepEqual((await pairQuote(token1, errs, scanner(5_000_000, realAt(token1, 4_999_999), secondAsked))).v, { accepted: false, code: "rpc_error" });
  } finally {
    evmScanBound?.();
  }
  assert.deepEqual(secondAsked, []);
  // a backend behind the head: its getLogs answer no logs and no error, and it holds no block at the head
  // (rpc.mainnet.chain.robinhood.com's answer past its head; publicnode and bloXroute answer -32602, daybreak -32000:
  // the reads of the review of 22e29c9, 2026-11-05 17:42-17:44Z)
  const token2 = "0x00000000000000000000000000000000005c4506";
  const lagging = scanner(5_000_000, realAt(token2, 4_999_999));
  const behind: EvmRpc = async (calls) => {
    const out = await lagging(calls);
    return out.map((o, i) => {
      const c = calls[i]!;
      if (c.method === "eth_getLogs") {
        const f = c.params[0] as { toBlock: string };
        return Number(f.toBlock) >= 4_999_990 ? { jsonrpc: "2.0", id: i, result: [] } : o;
      }
      if (c.method === "eth_getBlockByNumber" && Number(c.params[0]) >= 4_999_990) return { jsonrpc: "2.0", id: i, result: null };
      return o;
    });
  };
  const tops: number[] = [];
  const counted: EvmRpc = (calls, signal) => {
    if (calls.some((c) => c.method === "eth_getLogs" && Number((c.params[0] as { toBlock: string }).toBlock) === 5_000_000)) tops.push(1);
    return behind(calls, signal);
  };
  const { v } = await pairQuote(token2, counted, scanner(5_000_000, realAt(token2, 4_999_999)));
  assert.deepEqual(v, below);
  // the first's request up to the head, answered from behind it, goes to the second at once: never asked of the first
  // again, after the waits between tries (0.5, 1 and 1.5 s) or as its halves
  assert.equal(tops.length, 1, `the first was asked up to the head ${tops.length} times`);
});

test("SP4 a first scan provider whose rate limit would hold a warm scan's request past 2 s: the request goes to the second, never waits to the bound", { timeout: 30_000 }, async () => {
  // rpc.mainnet.chain.robinhood.com held warm Robinhood quotes 56-60 s on its rate limit (run 42059239410, evm-quote-lag-held)
  const token = "0x00000000000000000000000000000000005c4507";
  const inner = scanner(5_000_010, []);
  let throttled = 0;
  // a Retry-After of 5 s: inside the quote's bound, past the 2 s hold
  const first = evmJsonRpc("https://throttles.sp4.test", (async (_u: string, init: RequestInit) => {
    const calls = (JSON.parse(init.body as string) as { method: string; params: unknown[] }[]).map((c) => ({ method: c.method, params: c.params }));
    if (calls.some((c) => c.method === "eth_getLogs")) {
      throttled++;
      return new Response("", { status: 429, headers: { "retry-after": "5" } });
    }
    return new Response(JSON.stringify(await inner(calls)), { status: 200 });
  }) as unknown as typeof fetch);
  const { v, asked } = await warmPair(token, first, "robinhood");
  assert.deepEqual(v, below);
  // the one throttled request goes to the second at once, never asked of the first again once the 5 s are up
  assert.ok(throttled === 1 && asked.length > 0, `${throttled} throttled, ${asked.length} on the second`);
});

test("SP5 a first scan provider that answers a warm scan with no logs: the request goes to the second whole, never asked of the first as halves", { timeout: 30_000 }, async () => {
  // Robinhood's first answering no logs held a warm quote 9.5 to 11 s: 61 halves through its 2 at once (live check
  // evm-scan-second-provider, 2026-11-05 17:3xZ)
  const token = "0x00000000000000000000000000000000005c4509";
  const inner = scanner(5_000_010, []);
  const ranges: [number, number][] = [];
  const noLogs: EvmRpc = async (calls) => {
    for (const f of getLogsOf(calls)) ranges.push([Number(f.fromBlock), Number(f.toBlock)]);
    const out = await inner(calls);
    return out.map((o, i) => (calls[i]!.method === "eth_getLogs" ? { jsonrpc: "2.0", id: i, error: { code: -32602, message: "block range extends beyond current head block" } } : o));
  };
  const { v, asked } = await warmPair(token, noLogs, "robinhood");
  assert.deepEqual(v, below);
  assert.ok(ranges.every(([a, b]) => a === 5_000_001 && b === 5_000_010), `the first was asked ${JSON.stringify(ranges)}`);
  assert.deepEqual(asked, [[5_000_001, 5_000_010], [5_000_001, 5_000_010]]);
});

test("SP6 a first scan provider whose head read takes 2.5 s: the head is the second's, a cold scan's requests stay on the first", { timeout: 60_000 }, async () => {
  // review of 22e29c9, B1: the head read is the one ask a quote holds to 2 s, and a first that answered it late handed
  // the second the whole cold scan (800 getLogs on the second, none on the first)
  const token = "0x00000000000000000000000000000000005c450a";
  const inner = scanner(5_000_000, realAt(token, 4_999_000));
  const firstLogs: [number, number][] = [];
  const slowHead: EvmRpc = async (calls) => {
    if (calls.some((c) => c.method === "eth_blockNumber")) await pause(2_500);
    for (const f of getLogsOf(calls)) firstLogs.push([Number(f.fromBlock), Number(f.toBlock)]);
    return inner(calls);
  };
  const second: [number, number][] = [];
  const { v } = await pairQuote(token, slowHead, scanner(5_000_000, realAt(token, 4_999_000), second));
  assert.deepEqual(v, below);
  assert.ok(firstLogs.length > 0, "the first was asked no getLogs");
  assert.equal(second.length, 0, `the second read ${second.length} of a cold scan's requests`);
});

test("SP7 a second whose backend lags the first's head and answers [] past its own head: its blocks past that head are never kept as read", { timeout: 60_000 }, async () => {
  // review of 22e29c9, B2: the block check sat on the request up to the head alone, so the second's lower spans and any
  // request's halves kept a lagging backend's [] as blocks read, and the next quote never asked them again
  const token = "0x00000000000000000000000000000000005c450b";
  await pairQuote(token, scanner(5_000_000, []), scanner(5_000_000, []), "robinhood");
  const inner = scanner(5_000_600, []);
  const noLogs: EvmRpc = async (calls) => (await inner(calls)).map((o, i) => (calls[i]!.method === "eth_getLogs" ? { jsonrpc: "2.0", id: i, error: { code: -32602, message: "block range extends beyond current head block" } } : o));
  // the second: a backend at 5,000,200, [] past it with no error, and no block past it
  await pairQuote(token, noLogs, scanner(5_000_200, []), "robinhood", 5_000_600);
  // then two that answer; the token's real pool was made at 5,000,250, a block the lagging second never held
  const asked: [number, number][] = [];
  const { v } = await pairQuote(token, scanner(5_000_610, realAt(token, 5_000_250), asked), scanner(5_000_610, realAt(token, 5_000_250)), "robinhood", 5_000_610);
  assert.deepEqual(v, below);
  assert.ok(asked.some(([a, b]) => a <= 5_000_250 && b >= 5_000_250), `block 5,000,250 was not asked again: ${JSON.stringify(asked)}`);
});

test("SP8 a lone scan provider whose head read takes 2.5 s: the quote waits for it, the 2 s hold is only where a second follows", { timeout: 60_000 }, () => onTestClock(async () => {
  const token = "0x00000000000000000000000000000000005c450c";
  const inner = scanner(5_000_000, realAt(token, 4_999_000));
  const slowHead: EvmRpc = async (calls) => {
    if (calls.some((c) => c.method === "eth_blockNumber")) await pause(2_500);
    return inner(calls);
  };
  const pools = [seeded(token), real(token)];
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) } as EvmPoolBuyQuoteRequest, [chain(pools, 0), chain(pools, 1)], NOW, slowHead));
  assert.deepEqual(v, below);
}));

test("SP9 a lone scan provider whose logs backend lags its own head and answers [] past it: those blocks are never kept as read", { timeout: 60_000 }, async () => {
  // review of 22e29c9, B2, on the first's own path (older than the second: the halves of the request up to the head,
  // and every request below it, kept a lagging backend's [] as read)
  const token = "0x00000000000000000000000000000000005c450d";
  const pools = [seeded(token), real(token)];
  const lone = (scan: EvmRpc, headNo: number) => verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) } as EvmPoolBuyQuoteRequest, [chain(pools, 0, headNo), chain(pools, 1, headNo)], NOW, scan));
  await lone(scanner(5_000_000, []), 5_000_000);
  // its head read answers 5,000,600; its getLogs and blocks are a backend at 5,000,200
  const front = scanner(5_000_600, []);
  const back = scanner(5_000_200, []);
  await lone((calls, signal) => (calls.some((c) => c.method === "eth_blockNumber") ? front(calls, signal) : back(calls, signal)), 5_000_600);
  // then one that answers: the token's real pool was made at 5,000,250
  const asked: [number, number][] = [];
  assert.deepEqual(await lone(scanner(5_000_610, realAt(token, 5_000_250), asked), 5_000_610), below);
  assert.ok(asked.some(([a, b]) => a <= 5_000_250 && b >= 5_000_250), `block 5,000,250 was not asked again: ${JSON.stringify(asked)}`);
});

// ------------------------------------------------------------------ the ordered spare list (card evm-rpc-spare-list)
// 5 Nov 17:59-18:09Z: Base's first and second scan providers were both down about 10 minutes (bloXroute 503, and
// mainnet.base.org -32011 "request limit reached" on every eth_getLogs) and quotes stopped. Each case holds the first two
// down and the third, the venue's scan.spares[1], finds the token's real pool, which holds the seeded route.
const refusing = (host: string) =>
  evmJsonRpc(`https://${host}`, (async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  }) as unknown as typeof fetch);
const answering503 = (host: string) => evmJsonRpc(`https://${host}`, (async () => new Response("No server is available to handle this request", { status: 503 })) as unknown as typeof fetch);
const triQuote = async (token: string, scans: EvmRpc[], chainName: "base" | "robinhood" = "base", headNo = 5_000_000) => {
  const pools = [seeded(token), real(token)];
  return verdict(evmPoolBuyQuoteWith({ chain: chainName, token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) } as EvmPoolBuyQuoteRequest, [chain(pools, 0, headNo), chain(pools, 1, headNo)], NOW, scans));
};

test("SL1 the first two scan providers down (no connection, or HTTP 503, head reads too): the third carries the scan, on Base and Robinhood", { timeout: 60_000 }, () => onTestClock(async () => {
  let k = 0;
  for (const c of ["base", "robinhood"] as const) {
    for (const down of [refusing, answering503]) {
      const t = performance.now();
      const token = "0x00000000000000000000000000000000005c46" + (++k).toString(16).padStart(2, "0");
      const asked: [number, number][] = [];
      const v = await triQuote(token, [down("one.sl1.test"), down("two.sl1.test"), scanner(5_000_000, realAt(token, 4_999_000), asked)], c);
      assert.deepEqual(v, below, `${c} ${down.name}`);
      // the third reads in its own spans: Pocket's 500 blocks on Base, 2,000 on Robinhood
      const span = c === "base" ? 500 : 2_000;
      assert.ok(asked.length > 0 && asked.every(([a, b]) => b - a + 1 <= span), `${c} ${down.name}: ${asked.length} getLogs on the third, a span over ${span}`);
      console.log(`SL1 ${c} ${down.name}: ${asked.length} getLogs on the third, ${Math.round(performance.now() - t)} ms`);
    }
  }
}));

test("SL2 a warm scan with the first two down: the third has its blocks at once, never at the bound", { timeout: 60_000 }, async () => {
  const token = "0x00000000000000000000000000000000005c4610";
  await triQuote(token, [scanner(5_000_000, []), scanner(5_000_000, []), scanner(5_000_000, [])]);
  const asked: [number, number][] = [];
  const t = performance.now();
  const v = await triQuote(token, [refusing("one.sl2.test"), refusing("two.sl2.test"), scanner(5_000_010, realAt(token, 5_000_005), asked)], "base", 5_000_010);
  assert.deepEqual(v, below);
  assert.ok(performance.now() - t < 5_000, `the warm quote took ${Math.round(performance.now() - t)} ms`);
  assert.ok(asked.some(([a, b]) => a <= 5_000_005 && b >= 5_000_005), `block 5,000,005 not asked of the third: ${JSON.stringify(asked)}`);
});

test("SL3 a lone scan provider one block behind its own head: the newest request is asked again whole, never as halves (re-review of 156ece1 LOW-2)", { timeout: 60_000 }, async () => {
  const token = "0x00000000000000000000000000000000005c4611";
  const pools = [seeded(token), real(token)];
  const lone = (scan: EvmRpc, headNo: number) => verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) } as EvmPoolBuyQuoteRequest, [chain(pools, 0, headNo), chain(pools, 1, headNo)], NOW, scan));
  await lone(scanner(5_000_000, []), 5_000_000);
  // its head read names 5,000,010; the first batch's backend holds 5,000,009, the next the head
  const asked: [number, number][] = [];
  const front = scanner(5_000_010, realAt(token, 5_000_005), asked);
  const behind = scanner(5_000_009, realAt(token, 5_000_005));
  let batches = 0;
  const lag: EvmRpc = (calls, signal) => (calls.some((c) => c.method === "eth_getLogs") && batches++ === 0 ? behind(calls, signal) : front(calls, signal));
  // the same quote with no lag, for the scan batches it sends
  const token2 = "0x00000000000000000000000000000000005c4612";
  const pools2 = [seeded(token2), real(token2)];
  const lone2 = (scan: EvmRpc, headNo: number) => verdict(evmPoolBuyQuoteWith({ chain: "base", token: token2, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token2) } as EvmPoolBuyQuoteRequest, [chain(pools2, 0, headNo), chain(pools2, 1, headNo)], NOW, scan));
  await lone2(scanner(5_000_000, []), 5_000_000);
  let plain = 0;
  const inner = scanner(5_000_010, realAt(token2, 5_000_005));
  assert.deepEqual(await lone2((calls, signal) => (calls.some((c) => c.method === "eth_getLogs") && plain++, inner(calls, signal)), 5_000_010), below);
  assert.deepEqual(await lone(lag, 5_000_010), below);
  assert.equal(batches, plain + 1, `${batches} scan batches where ${plain + 1} do`);
  assert.ok(asked.every(([a, b]) => a === 5_000_001 && b === 5_000_010), `a request was halved: ${JSON.stringify(asked)}`);
});

test("SL4 a one-call batch answered as a bare object (Pocket's way) is that call's answer, with its id; any other answer that is not a batch is refused", async () => {
  const bare = (body: unknown) => evmJsonRpc("https://bare.sl4.test", (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch);
  const one = [{ method: "eth_blockNumber", params: [] }];
  assert.deepEqual(await bare({ jsonrpc: "2.0", id: 0, result: "0x660a02b" })(one), [{ jsonrpc: "2.0", id: 0, result: "0x660a02b" }]);
  // another id is no answer to it
  assert.deepEqual(await bare({ jsonrpc: "2.0", id: 7, result: "0x1" })(one), [null]);
  // a bare object to a batch of two, and a bare string, are refused
  await assert.rejects(bare({ jsonrpc: "2.0", id: 0, result: "0x1" })([...one, ...one]), /not a batch/);
  await assert.rejects(bare("0x1")(one), /not a batch/);
});

test("SL5 a lone scan provider whose logs backend lags its head by more than a span: no request below the head keeps its [] as read", { timeout: 60_000 }, async () => {
  // SP9 at two requests: with a lag under one span the newest request alone ends past the backend, and is asked again
  // whole (SL3); here the lower request ends past it too, so its own block check is what keeps its [] out
  const token = "0x00000000000000000000000000000000005c4613";
  const pools = [seeded(token), real(token)];
  const lone = (scan: EvmRpc, headNo: number) => verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: seededRoute(token) } as EvmPoolBuyQuoteRequest, [chain(pools, 0, headNo), chain(pools, 1, headNo)], NOW, scan));
  await lone(scanner(5_000_000, []), 5_000_000);
  // its head read answers 5,020,000; its getLogs and blocks are a backend at 5,005,000
  const front = scanner(5_020_000, []);
  const back = scanner(5_005_000, []);
  await lone((calls, signal) => (calls.some((c) => c.method === "eth_blockNumber") ? front(calls, signal) : back(calls, signal)), 5_020_000);
  // then one that answers: the token's real pool was made at 5,007,000, in the lower request's blocks
  const asked: [number, number][] = [];
  assert.deepEqual(await lone(scanner(5_020_010, realAt(token, 5_007_000), asked), 5_020_010), below);
  assert.ok(asked.some(([a, b]) => a <= 5_007_000 && b >= 5_007_000), `block 5,007,000 was not asked again: ${JSON.stringify(asked)}`);
});

test("SL6 card base-rpc-list-fix: a warm Base scan with its first two down and its third answering no logs: the fourth carries it", { timeout: 60_000 }, async () => {
  // live run 42135737951 (2026-11-06 00:18:43Z, GitHub's runner): with the first two held (HTTP 503), the third,
  // base.api.pocket.network, answered a held quote's request with no logs in 570 ms, and the quote ended rpc_error: it
  // was the last of Base's list
  let k = 0;
  for (const down of [refusing, answering503]) {
    const token = "0x00000000000000000000000000000000005c462" + (++k).toString(16);
    await triQuote(token, [scanner(5_000_000, []), scanner(5_000_000, []), scanner(5_000_000, []), scanner(5_000_000, [])]);
    const inner = scanner(5_000_010, realAt(token, 5_000_005));
    const noLogs: EvmRpc = async (calls) => (await inner(calls)).map((o, i) => (calls[i]!.method === "eth_getLogs" ? { jsonrpc: "2.0", id: i, error: { code: -32000, message: "no logs" } } : o));
    const asked: [number, number][] = [];
    const t = performance.now();
    const v = await triQuote(token, [down("one.sl6.test"), down("two.sl6.test"), noLogs, scanner(5_000_010, realAt(token, 5_000_005), asked)], "base", 5_000_010);
    assert.deepEqual(v, below, down.name);
    assert.ok(performance.now() - t < 5_000, `${down.name}: the warm quote took ${Math.round(performance.now() - t)} ms`);
    assert.ok(asked.some(([a, b]) => a <= 5_000_005 && b >= 5_000_005), `${down.name}: block 5,000,005 not asked of the fourth: ${JSON.stringify(asked)}`);
  }
});

// card evm-rpc-spare-list, 6 Nov: a provider that does not keep the blocks a read asks (-32002 "keyless requests are
// served for the most recent 5000 blocks only", rpc-robinhood.blockmachine.io, read 2026-11-05 19:48Z; live run
// 42206377652) is passed over like one that is down: the quote's reads go on at the next two of the list, and two
// providers must still answer alike.
// a new function each time: the quote refuses one provider passed twice (checkAsk)
const capped = (): EvmRpc => async (calls) => calls.map((_, id) => ({ jsonrpc: "2.0", id, error: { code: -32002, message: "keyless requests are served for the most recent 5000 blocks only" } }));
test("SL7 the first two quote providers down and history-capped (-32002 on every call, head reads too): the third and fourth decide, as two honest providers would; with one left, the quote refuses", { timeout: 15_000 }, async () => {
  const token = "0x00000000000000000000000000000000000ee0f7";
  const pools = [best(token)];
  const honest = await verdict(evmPoolBuyQuoteWith(warmReq(token), [chain(pools, 0), chain(pools, 1)], NOW));
  assert.equal(honest.accepted, true, String((honest as { code?: string }).code));
  for (const firstTwo of [[down, capped()], [capped(), capped()]]) {
    assert.deepEqual(await verdict(evmPoolBuyQuoteWith(warmReq(token), [...firstTwo, chain(pools, 0), chain(pools, 1)], NOW)), honest);
  }
  // one provider answering is one provider's word: refused, never used alone
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(warmReq(token), [down, capped(), chain(pools, 0)], NOW)), { accepted: false, code: "rpc_error" });
  assert.deepEqual(await verdict(evmPoolBuyQuoteWith(warmReq(token), [capped(), capped(), capped(), chain(pools, 1)], NOW)), { accepted: false, code: "rpc_error" });
});

// card evm-sell-hook-converge: a sim, however faithful, cannot catch a hook that flips by block property or per-block
// state (review of the exec sim, a4fd5aa, HIGH 1). A route through an unlisted hook that sets the reference, with no
// route through listed pools within the slippage of it, is now the sale's own route at the reference's minOut, never a
// below_reference refusal; where its real sale reverts, the caller bans its pools (the quote's `hooked`, then `banned`)
// and the next quote leaves through the rest. So such a pool freezes no sale, costs at most one failed try, and no
// builder is paid less than a route the sale can take.
type HookedQuote = { route: unknown; amountOut: bigint; minOut: bigint; hooked: readonly string[] };
// The chain a sale runs on in the model (card evm-sell-hook-intrablock): Base unless a test names Robinhood, whose venue
// then pins the model's sell delegate, sender, pool and FeeCollector as Base's
type SaleNet = { chain: "base" | "robinhood"; venues: builder.EvmPoolVenueList; nitro: boolean };
const hcQuote = async (pools: ModelPool[], token: string, logs: { key: EvmPoolKey; at: number }[], banned?: readonly string[], sn?: SaleNet) => {
  const req = { chain: sn?.chain ?? "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, sent: [], signSim, ...(banned ? { banned } : {}) } as EvmPoolSellQuoteRequest;
  try {
    return (await evmPoolSellQuoteWith(req, [chain(pools, 0, undefined, undefined, undefined, sn?.nitro), chain(pools, 1, undefined, undefined, undefined, sn?.nitro)], NOW, scanner(5_000_000, logs), sn?.venues ?? DELEGATED)) as unknown as HookedQuote;
  } catch (e) {
    if (!(e instanceof EvmQuoteError)) throw e;
    return { code: e.code };
  }
};
const hcPid = (k: EvmPoolKey) => "0x" + pidOf({ ...k, currency0: k.currency0.toLowerCase(), currency1: k.currency1.toLowerCase(), hooks: k.hooks.toLowerCase() });
// The real sale on the modelled chain: SellDelegate.sell from the pinned sender with the sale's gas and fees, built from
// the quote as the device builds it (evmQuotedSell, into Base's pool with its FeeCollector, as pool-evm-deploy pins
// them), landed at `block` (by default the block after the quote's), marked as the real sale (SALE_RUN). Every sale the
// model lands is kept in SALES by its hash, so each provider answers its transaction, receipt and block.
const HEAD_NO = 5_000_000;
/** True for a call at a block after the quote's: the real sale, and its replay at the sale's block. */
const later = (ctx: SimCtx) => (ctx.block ?? HEAD_NO) > HEAD_NO;
const SALE_RUN = "the model's real sale";
// The sale's block in the model: its time, parent, base fee and mixHash, and its system slots (sysWord): L1Block's
// sequenceNumber counts from the epoch's first block EPOCH0, EIP-2935 holds the parent's hash at (N-1) % 8191, and
// EIP-4788 the block's time and root at its time % 8191 and that plus 8191; at any other block (the parent) each is
// the quote block's (HEAD_NO's), as a replay at the parent sees it unless overridden
const [SALE_TIME, SALE_PARENT, SALE_BASE_FEE, SALE_MIX, SALE_ROOT] = ["0x" + (BigInt(T) + 2n).toString(16), "0x" + "9a".repeat(32), BASE_FEE + 7n, "0x" + "3c".repeat(32), "0x" + "7b".repeat(32)];
const EPOCH0 = HEAD_NO - 3;
const [L1B, HIST, BEACON] = ["0x4200000000000000000000000000000000000015", "0x0000f90827f1c53a10cb7a02335b175320002935", "0x000f3df6d732807ef1319fb7b8bb8522d0beac02"];
const SYS = [L1B, HIST, BEACON];
/** The accounts a replay's state override names beside the system accounts every replay on Base carries. */
const ownOver = (o: unknown) => Object.keys(o as object).filter((k) => !SYS.includes(k.toLowerCase())).length;
const SEES_ALL: Sees = { seq: true, hist: true, beacon: true, baseFee: true, randao: true, backlog: true, earlier: true };
// On Robinhood (`nitro`): EIP-2935's history alone, its ring 393,168 (ArbOS's code 0x05ffd0); ArbOS's L1 block number and
// gas backlog live in ArbOS's own storage, which the device never reads or overrides
function sysWord(addr: string, slot: bigint, block: number, nitro = false): string {
  const a = addr.toLowerCase();
  const sale = block > HEAD_NO;
  const ts = BigInt(SALE_TIME);
  // ArbOS's backlog and the model's EARLIER word as the parent left them (the trade's are in its trace alone)
  if (a === ARBOS && slot === ARBOS_BACKLOG) return "0x" + W(RH_PARENT_BACKLOG);
  if (a === EARLIER) return "0x" + W(0n);
  if (nitro) return a === HIST && slot === BigInt(block - 1) % 393168n ? (sale ? SALE_PARENT : "0x" + "e1".repeat(32)) : "0x" + W(0n);
  if (a === L1B && slot === 3n) return "0x" + W(BigInt(block - EPOCH0));
  if (a === L1B && slot < 9n) return "0x" + W(0x1b00n + slot); // the other fields, the same in both blocks
  if (a === HIST && slot === BigInt(block - 1) % 8191n) return sale ? SALE_PARENT : "0x" + "e1".repeat(32);
  if (a === BEACON && slot === ts % 8191n) return "0x" + W(sale ? ts : ts - 16382n);
  if (a === BEACON && slot === (ts % 8191n) + 8191n) return sale ? SALE_ROOT : "0x" + "e2".repeat(32);
  return "0x" + W(0n);
}
/** What a replay at block `n` sees of it: each system value from the state override where it sets the slot, else the
 *  parent's (the quote block's), and BASEFEE and PREVRANDAO from the block override, else the parent header's. */
function sysSees(n: number, o: Record<string, { stateDiff?: Record<string, string> }>, env: { baseFeePerGas?: string; prevRandao?: string }, nitro = false): Sees {
  const word = (a: string, slot: bigint) => {
    const d = Object.entries(o).find(([k]) => k.toLowerCase() === a)?.[1]?.stateDiff ?? {};
    const v = Object.entries(d).find(([k]) => BigInt(k) === slot)?.[1];
    return v !== undefined ? v.toLowerCase() : sysWord(a, slot, HEAD_NO, nitro);
  };
  const ts = BigInt(SALE_TIME);
  const baseFee = env.baseFeePerGas !== undefined && BigInt(env.baseFeePerGas) === SALE_BASE_FEE;
  // the trade's pre-state, from the override alone: the EARLIER word an earlier transaction wrote, and ArbOS's backlog
  // as the block start left it (which Nitro never takes in an override: chain refuses it, as the providers do)
  const earlier = word(EARLIER, 0n) === SALE_EARLIER;
  const startBacklog = word(ARBOS, ARBOS_BACKLOG) === "0x" + W(RH_START_BACKLOG);
  // Robinhood: no L1Block and no EIP-4788; PREVRANDAO answers 1 in every block (Multicall3's getCurrentBlockDifficulty
  // on rpc.mainnet.chain.robinhood.com and robinhood.drpc.org, 2026-11-07 15:32Z; the header's mixHash is ArbOS's send
  // count and L1 block number), so a replay that sets it from the header tells; the backlog is always the parent's
  if (nitro) {
    const h = BigInt(n - 1) % 393168n;
    return { seq: true, beacon: true, hist: word(HIST, h) === sysWord(HIST, h, n, true), baseFee, randao: env.prevRandao === undefined, backlog: startBacklog, earlier };
  }
  return {
    backlog: true,
    earlier,
    seq: word(L1B, 3n) === sysWord(L1B, 3n, n),
    hist: word(HIST, BigInt(n - 1) % 8191n) === sysWord(HIST, BigInt(n - 1) % 8191n, n),
    beacon: word(BEACON, ts % 8191n) === sysWord(BEACON, ts % 8191n, n) && word(BEACON, (ts % 8191n) + 8191n) === SALE_ROOT,
    baseFee,
    randao: env.prevRandao === SALE_MIX,
  };
}
const [SALE_POOL, SALE_COLLECTOR] = ["0x00000000000000000000000000000000000b0011", "0x00000000000000000000000000000000000fee11"];
// card evm-sell-hook-intrablock: ArbOS's state account and the slot the model keeps its backlog in; EARLIER, the account
// whose slot 0 an earlier transaction of the trade's block set to SALE_EARLIER (0 at the parent)
const [ARBOS, EARLIER] = ["0xa4b05fffffffffffffffffffffffffffffffffff", "0x00000000000000000000000000000000000ea911"];
const ARBOS_BACKLOG = 0x5bn;
const SALE_EARLIER = "0x" + "ea".repeat(32);
/** The hooks whose frames errored in the real run now landing (land and landBuy reset and keep them). */
const REAL_ERRORED: string[] = [];
/** A pool's swap that failed: in the real run, its hook's frame errored unless it failed by a fee through a delta. */
function erred(p: ModelPool, ctx: SimCtx, overridden: Set<string>): null {
  if (ctx.sale === true && p.key.hooks !== NATIVE && !overridden.has(p.key.hooks) && p.deltaFee !== true && !REAL_ERRORED.includes(p.key.hooks)) REAL_ERRORED.push(p.key.hooks);
  return null;
}
/** The trade `s`'s trace as dRPC and Pocket answer it on Robinhood: prestateTracer, the state it read at its start
 *  (the sender, ArbOS's state with the backlog the block start left, EARLIER's word), and callTracer, its call from the
 *  sender with a frame into the PoolManager and, inside it, one errored frame into each hook in `errored`; `trace` edits
 *  it. */
function traceOf(s: ModelSale, tracer: string, who: 0 | 1, balances: Record<string, bigint>, noCode = false): unknown {
  const e = s.trace ?? {};
  const failed = s.status === "0x0" || s.bought === false;
  if (tracer === "prestateTracer") {
    const out: Record<string, unknown> = {
      [SENDER]: { balance: "0x" + (balances[SENDER] ?? 0n).toString(16), nonce: 7 },
      ...(e.withArbos === false ? {} : { [ARBOS]: { balance: "0x0", nonce: 1, storage: { ["0x" + W(ARBOS_BACKLOG)]: "0x" + W(RH_START_BACKLOG) } } }),
      [EARLIER]: { balance: "0x0", ...(e.code !== undefined && !noCode ? { code: "0x" + "fe".repeat(e.code) } : {}), storage: { ["0x" + W(0n)]: e.apartOn === who ? "0x" + "eb".repeat(32) : SALE_EARLIER, ...Object.fromEntries(Array.from({ length: e.slots ?? 0 }, (_, i) => ["0x" + W(BigInt(i) + 1n), "0x" + W(0n)])) } },
    };
    // the PoolManager's pool word the trade read: the parent's (0), or another where an earlier transaction of the block
    // moved it (`pmMoved`)
    out[RH_PM] = { balance: "0x0", storage: { ["0x" + W(0x5011n)]: "0x" + W(e.pmMoved === true ? 1n : 0n) } };
    for (let i = 0; i < (e.accounts ?? 0); i++) out["0x" + (0xacc00000 + i).toString(16).padStart(40, "0")] = { balance: "0x1" };
    if (e.arbosSlots !== undefined) Object.assign((out[ARBOS] as { storage: Record<string, string> }).storage, Object.fromEntries(Array.from({ length: e.arbosSlots }, (_, i) => ["0x" + W(BigInt(i) + 0x1000n), "0x" + W(1n)])));
    return out;
  }
  assert.equal(tracer, "callTracer");
  const err = (x: object, bad: boolean) => (bad ? { ...x, error: "execution reverted" } : x);
  const inner: object[] = [...(s.errored ?? []), ...(e.erroredToo ?? [])].map((h) => ({ type: "CALL", from: e.erroredFrom ?? RH_PM, to: h, input: "0x", value: "0x0", error: "execution reverted" }));
  for (let i = 0; i < (e.frames ?? 0); i++) inner.push({ type: "STATICCALL", from: RH_PM, to: EARLIER, input: "0x", value: "0x0" });
  // a frame the PoolManager made into a hook `by` that did not error, inside it a call back into the PoolManager that
  // errored, and in that one errored frame into each hook of `into` (`by` called the PoolManager and caught its revert)
  // (`errored`: `by`'s own frame errored too, the revert not caught; `via`: `by` reached the PoolManager through that
  // contract, the pinned v4 adapter say, whose frame errored too)
  if (e.caught !== undefined) {
    const c = e.caught;
    const intoPm = { type: "CALL", from: c.via ?? c.by, to: RH_PM, input: "0x", value: "0x0", error: "execution reverted", calls: c.into.map((h) => ({ type: "CALL", from: RH_PM, to: h, input: "0x", value: "0x0", error: "execution reverted" })) };
    inner.push({ type: "CALL", from: RH_PM, to: c.by, input: "0x", value: "0x0", ...(c.errored === true ? { error: "execution reverted" } : {}), calls: [c.via === undefined ? intoPm : { type: "CALL", from: c.by, to: c.via, input: "0x", value: "0x0", error: "execution reverted", calls: [intoPm] }] });
  }
  return err({ type: "CALL", from: SENDER, to: s.to ?? SELL_W, input: s.input, value: "0x0", ...e.root, calls: [err({ type: "CALL", from: e.pmFrom ?? s.to ?? SELL_W, to: RH_PM, input: "0x", value: "0x0", calls: inner }, failed)] }, s.status === "0x0");
}
const SALE_VENUES = Object.freeze({ ...DELEGATED, base: Object.freeze({ ...DELEGATED.base, pool: SALE_POOL, feeCollector: SALE_COLLECTOR }) }) as builder.EvmPoolVenueList;
// a buy's `bought`: what the pool's call returned (its swap done), with its log, Bought or Withdrawn, in `logs`
// `gas`: its gas limit, where it is not the model's (SALE_GAS for a sale, BUY_GAS for a buy)
// `rcIndex`: its receipt's transactionIndex where it is not its transaction's ("0x3"); `errored`: the hooks whose frames
// errored in the real run (the trace's callTracer names them); `trace`: edits to its trace (a provider's answer apart,
// another call's root frame, extra accounts, errored frames, the caller of the errored frames, more frames, the caller
// of the frame into the PoolManager)
type ModelSale = { hash: string; input: string; block: number; blockHash: string; status: string; status1?: string; to?: string; bought?: boolean; gas?: bigint; logs?: { address: string; topics: string[] }[]; l1Gas?: bigint; rcIndex?: string; errored?: string[]; trace?: TraceEdit };
type TraceEdit = { apartOn?: 0 | 1; root?: Record<string, string>; accounts?: number; slots?: number; arbosSlots?: number; code?: number; erroredToo?: string[]; erroredFrom?: string; frames?: number; caught?: { by: string; into: string[]; errored?: true; via?: string }; pmMoved?: true; withArbos?: false; pmFrom?: string };
const SALES = new Map<string, ModelSale>();
let saleNo = 0;
/** The sale of quote `q` as the device builds and W signs it (the signature is the model's: the modelled delegate takes any). */
const saleInput = (q: HookedQuote, venues = SALE_VENUES): string => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const built = evmQuotedSell(venues, q as unknown as EvmPoolSellQuote, { precommitment: 0x5e11n, feeRecipient: SALE_COLLECTOR, deadline: BigInt(Math.floor(NOW / 1000) + 300), nonce: 0n }, NOW);
    return sellMod.evmSellCallData(built, 0n, new Uint8Array(65));
  } finally {
    Date.now = realNow;
  }
};
/** Lands quote `q`'s sale on the modelled chain of `pools` at `block`: its status is what SellDelegate does there (0x0
 *  where it reverts), unless `status` says; returns its hash. */
const land = async (pools: ModelPool[], q: HookedQuote, block = HEAD_NO + 1, extra: Partial<ModelSale> = {}, edit: (input: string) => string = (x) => x, sn?: SaleNet): Promise<string> => {
  const input = edit(saleInput(q, sn?.venues));
  REAL_ERRORED.length = 0;
  const run = (await chain(pools, 0)([{ method: "eth_call", params: [{ from: SENDER, to: SELL_W, data: input, gas: "0x" + ((extra.gas ?? SALE_GAS) - 25_000n).toString(16), maxFeePerGas: "0x" + (BASE_FEE + 1_000_000n).toString(16), maxPriorityFeePerGas: "0xf4240" }, "latest", { [SELL_W]: { code: "0xef0100" + DELEGATED.base!.sellDelegate!.slice(2) } }, { number: "0x" + block.toString(16) }, SALE_RUN] }]))[0] as { result?: string };
  const hash = "0x" + (0x5a1e0000 + ++saleNo).toString(16).padStart(64, "0");
  SALES.set(hash, { hash, input, block, blockHash: "0x" + (0xb10c0000 + saleNo).toString(16).padStart(64, "0"), status: run.result !== undefined ? "0x1" : "0x0", errored: [...REAL_ERRORED], ...extra });
  return hash;
};
/** The device's evidence for a ban (the kit's evmSellRevertedPools) on two modelled providers. */
const proved = (pools: ModelPool[], q: HookedQuote, hash: string, rpcs?: EvmRpc[], sn?: SaleNet) => {
  const on = (who: 0 | 1) => chain(pools, who, undefined, undefined, undefined, sn?.nitro);
  return evmSellRevertedPoolsWith(q as unknown as EvmPoolSellQuote, hash, rpcs ?? [on(0), on(1)], sn?.venues ?? DELEGATED, sn?.nitro === true ? [on(0), on(1)] : undefined);
};
// The device's loop: quote, sell, and where the sale reverts, ban the pools the device's own evidence blames
// (evmSellRevertedPools) and quote again; the failed tries it took and the sale it ended in
const hcConverge = async (pools: ModelPool[], token: string, logs: { key: EvmPoolKey; at: number }[], max = 8, block = HEAD_NO + 1, sn?: SaleNet) => {
  const banned: string[] = [];
  let failed = 0;
  for (let i = 0; i < max; i++) {
    const q = await hcQuote(pools, token, logs, banned, sn);
    if ("code" in q) return { failed, code: q.code, banned };
    const hash = await land(pools, q, block, {}, (x) => x, sn);
    const sale = SALES.get(hash)!;
    if (sale.status === "0x1") return { failed, got: q.amountOut, minOut: q.minOut, hooked: q.hooked, banned };
    failed++;
    assert.ok(q.hooked.length > 0, "only a route through an unlisted hook can revert in the model");
    banned.push(...(await proved(pools, q, hash, undefined, sn)));
  }
  return { failed, code: "no_convergence", banned };
};

test("HC1 a hook that honours only even blocks (quote and sim at an even block, the sale lands at an odd one) freezes no sale: one failed try, then the market", async () => {
  const token = "0x00000000000000000000000000000000000c1c01";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  // the quote and its sim run at the agreed block, 5,000,000 (even); the sale lands at 5,000,001, and its replay runs
  // at that block's number (eth_call's block override), so the hook flips there too
  const even: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => ((ctx.block ?? HEAD_NO) % 2 === 0 ? 2n * a : null) };
  const logs = [{ key: market.key, at: 4_500_000 }, { key: even.key, at: 4_500_001 }];
  // the quote takes the hooked route at the reference's minOut, and names its pool: never below_reference
  const q = await hcQuote([market, even], token, logs);
  assert.ok(!("code" in q), show(q));
  assert.equal(q.amountOut, 2n * AMOUNT);
  assert.equal(q.minOut, (2n * AMOUNT * 9900n) / 10000n, "minOut is the reference's: no builder is paid less than the route the sale takes");
  assert.deepEqual(q.hooked, [hcPid(even.key)]);
  // the sale lands at an odd block and reverts; the device's evidence blames the pool, and the next quote leaves through
  // the market
  const r = await hcConverge([market, even], token, logs);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT, banned: [hcPid(even.key)] }, show(r));
  // while banned, the pool never sets the reference on this device
  const again = await hcQuote([market, even], token, logs, r.banned);
  assert.ok(!("code" in again) && again.amountOut === AMOUNT && again.hooked.length === 0, show(again));
});

test("HC2 a hook flipped by a transaction earlier in the sale's own block leaves no evidence at the parent block: nothing is banned (review of 919742f5, F2: a ban needs the device's own evidence), and each try costs the sender its gas", async () => {
  const token = "0x00000000000000000000000000000000000c1c02";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const state = { flipped: false };
  const flip: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (ctx.sale === true && (state.flipped = true) ? null : 2n * a) };
  const r = await hcConverge([market, flip], token, [{ key: market.key, at: 4_500_000 }, { key: flip.key, at: 4_500_001 }], 2);
  assert.equal(state.flipped, true);
  assert.deepEqual({ failed: r.failed, code: r.code, banned: r.banned }, { failed: 2, code: "no_convergence", banned: [] }, show(r));
});

test("HC3 hooks that revert every real sale cost at most one failed try per pool: two such pools, two tries, then the market", async () => {
  const token = "0x00000000000000000000000000000000000c1c03";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const never = (fee: number, k: bigint): ModelPool => ({ key: keyOf(token, NATIVE, fee, 60, UNPINNED), give: (a) => k * a, lie: (a) => k * a, state: pricedInto1(k), exec: (a, ctx) => (later(ctx) ? null : k * a) });
  const [a, b] = [never(3000, 3n), never(3001, 2n)];
  const r = await hcConverge([market, a, b], token, [{ key: market.key, at: 4_500_000 }, { key: a.key, at: 4_500_001 }, { key: b.key, at: 4_500_002 }]);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 2, got: AMOUNT, banned: [hcPid(a.key), hcPid(b.key)] }, show(r));
});

test("HC4 an honest pool behind an unlisted hook, the token's best, is sold through at its own price with no try lost; a listed route within the slippage of it is still preferred", async () => {
  const token = "0x00000000000000000000000000000000000c1c04";
  const honest: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n) };
  const r = await hcConverge([seeded(token), honest], token, [{ key: honest.key, at: 4_500_001 }]);
  assert.deepEqual({ failed: r.failed, got: r.got, hooked: r.hooked }, { failed: 0, got: 2n * AMOUNT, hooked: [hcPid(honest.key)] }, show(r));
  // another token (a token's scan is kept in memory): a hookless pool half a percent under the honest one
  const t2 = "0x00000000000000000000000000000000000c1c14";
  const near: ModelPool = { key: keyOf(t2, NATIVE, 2500, 50, NATIVE), give: (a) => 2n * a - (2n * a) / 200n, state: pricedInto1(2n) };
  const h2: ModelPool = { ...honest, key: keyOf(t2, NATIVE, 3000, 60, UNPINNED) };
  const q = await hcQuote([near, h2], t2, [{ key: near.key, at: 4_500_000 }, { key: h2.key, at: 4_500_001 }]);
  assert.ok(!("code" in q) && q.hooked.length === 0 && q.amountOut === 2n * AMOUNT - (2n * AMOUNT) / 200n, show(q));
  assert.equal(q.minOut, ((2n * AMOUNT - (2n * AMOUNT) / 200n) * 9900n) / 10000n, "minOut from the pick: a reference through an unlisted hook sets none (review of 72e28658, M2)");
});

test("HC5 a sell quote's banned is a list of at most 4096 pool ids, each 0x and 64 hex digits: anything else is bad_request", async () => {
  const token = "0x00000000000000000000000000000000000c1c05";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const logs = [{ key: market.key, at: 4_500_000 }];
  for (const bad of ["0x" + "ab".repeat(32), ["0x" + "ab".repeat(31)], ["ab".repeat(32)], [1n], Array.from({ length: 4097 }, () => "0x" + "ab".repeat(32))]) {
    assert.deepEqual(await hcQuote([market], token, logs, bad as readonly string[]), { code: "bad_request" }, show(bad).slice(0, 80));
  }
  const ok = await hcQuote([market], token, logs, ["0x" + "AB".repeat(32), ...Array.from({ length: 4095 }, () => "0x" + "ab".repeat(32))]);
  assert.ok(!("code" in ok) && ok.amountOut === AMOUNT, show(ok));
  // a banned listed or hookless pool is dropped too: with the market banned, nothing is left; an id in capitals bans it too
  assert.deepEqual(await hcQuote([market], token, logs, [hcPid(market.key)]), { code: "no_quote" });
  assert.deepEqual(await hcQuote([market], token, logs, ["0x" + hcPid(market.key).slice(2).toUpperCase()]), { code: "no_quote" });
});

test("HC6 the device's quote of a sale through an unlisted hook builds, and the sender's read-back takes it; the builder takes such a hook on no other route", async () => {
  const token = "0x00000000000000000000000000000000000c1c06";
  const honest: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n) };
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, sent: [], signSim } as EvmPoolSellQuoteRequest;
  const q = await evmPoolSellQuoteWith(req, [chain([seeded(token), honest], 0), chain([seeded(token), honest], 1)], NOW, scanner(5_000_000, [{ key: honest.key, at: 4_500_001 }]), DELEGATED);
  assert.deepEqual(q.hooked, [hcPid(honest.key)]);
  // Base's venue with a pool and a FeeCollector pinned, as pool-evm-deploy pins them
  const [POOL, COLLECTOR] = ["0x00000000000000000000000000000000000b0011", "0x00000000000000000000000000000000000fee11"];
  const venues = Object.freeze({ ...DELEGATED, base: Object.freeze({ ...DELEGATED.base, pool: POOL, feeCollector: COLLECTOR }) }) as builder.EvmPoolVenueList;
  const f = { precommitment: 0x5e11n, feeRecipient: COLLECTOR, deadline: BigInt(Math.floor(NOW / 1000) + 300), nonce: 0n };
  const realNow = Date.now;
  Date.now = () => NOW; // the unpinned builder reads the device's clock for the deadline
  try {
    const built = evmQuotedSell(venues, q, f, NOW);
    assert.equal(built.minOut, (2n * AMOUNT * 9900n) / 10000n);
    // the helper's sell sender reads the signed call back as this route (the kit's evmSellRouteOf, the one definition)
    assert.deepEqual(sellMod.evmSellRouteOf("base", { w: SELL_W, token, amount: AMOUNT, minOut: built.minOut, target: built.target, data: built.data }), { venue: "uniswap-v4", hops: [{ currency: NATIVE, fee: 3000, tickSpacing: 60, hooks: UNPINNED, hookData: "0x" }] });
    // the same route handed to the builder by anything but the device's quote is refused
    const code = (fn: () => unknown) => {
      try {
        fn();
        return "built";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    assert.equal(code(() => sellMod.pinnedBuildSell(venues, "base", { w: SELL_W, token, amount: AMOUNT, target: q.target, route: q.route, minOut: q.minOut, feeCap: q.feeMax, ...f })), "bad_route");
    assert.equal(code(() => sellMod.evmSellRouteCheck("base", token, q.route)), "bad_route");
  } finally {
    Date.now = realNow;
  }
});

// ------------------------------------------------------------------ independent review of evm-sell-hook-converge (RV)
// The ban filter runs on routeSet's finished routes, but routeSet keeps ONE market per other currency X (bestMarket) and
// builds every route through X from it. A hostile unlisted-hook market of X that outbids X's honest market shadows it;
// once the hostile market is banned, every route through X is dropped and the honest market is never read again.
const rvSell = (sell: unknown) => (sell as { route?: { hops?: { hooks: string; currency: string }[] } }).route;
test("RV1 a banned hostile market of X shadows X's honest market: after the one failed try the sale is not routed through the honest market", async () => {
  const token = "0x00000000000000000000000000000000000c1d01";
  const x = xAt(0x7d1);
  // the token's real liquidity: its hookless pool with X, and X's honest market with the native asset (found by X's scan)
  const pool: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  const honest = marketOf(x);
  // the attacker's market of X behind an unlisted hook: twice the honest price on the quoter and in W's sim, reverts the sale
  const hostile: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (later(ctx) ? null : 2n * a) };
  const logs = [{ key: pool.key, at: 4_500_000 }, { key: honest.key, at: 4_100_000 }, { key: hostile.key, at: 4_100_001 }];
  const pools = [seeded(token), pool, honest, hostile];
  // without the hostile market the sale leaves through X's honest market at the full amount
  // (another token and another X: the scan of X's markets is kept in memory per X)
  const t0 = "0x00000000000000000000000000000000000c1d00";
  const x0 = xAt(0x7d0);
  const p0: ModelPool = { key: keyOf(t0, x0, 3000, 60, NATIVE), give: (a) => a };
  const honest0 = marketOf(x0);
  const clean = await hcQuote([seeded(t0), p0, honest0], t0, [{ key: p0.key, at: 4_500_000 }, { key: honest0.key, at: 4_100_000 }]);
  assert.ok(!("code" in clean) && clean.amountOut === AMOUNT, show(clean));
  // the first quote takes the hostile route (the reference), names the hostile pool; its real sale reverts
  const q1 = await hcQuote(pools, token, logs);
  assert.ok(!("code" in q1), show(q1));
  assert.equal(q1.amountOut, 2n * AMOUNT);
  assert.deepEqual(q1.hooked, [hcPid(hostile.key)]);
  // the device's evidence blames the hostile pool alone
  const ban = await proved(pools, q1, await land(pools, q1));
  assert.deepEqual(ban, [hcPid(hostile.key)]);
  // the card's goal: the next quote, with the hostile pool banned, leaves through the rest: X's honest market, at AMOUNT
  const q2 = await hcQuote(pools, token, logs, [...ban]);
  assert.deepEqual("code" in q2 ? q2 : { amountOut: q2.amountOut, minOut: q2.minOut, hops: rvSell(q2)?.hops?.length }, { amountOut: AMOUNT, minOut: (AMOUNT * 9900n) / 10000n, hops: 2 }, show(q2));
});

test("RV2 the same shadow with no seeded pool: after the one failed try the token cannot be sold at all", async () => {
  const token = "0x00000000000000000000000000000000000c1d02";
  const x = xAt(0x7d2);
  const pool: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  const honest = marketOf(x);
  const hostile: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (later(ctx) ? null : 2n * a) };
  const logs = [{ key: pool.key, at: 4_500_000 }, { key: honest.key, at: 4_100_000 }, { key: hostile.key, at: 4_100_001 }];
  const pools = [pool, honest, hostile];
  const q1 = await hcQuote(pools, token, logs);
  assert.ok(!("code" in q1) && q1.hooked.length === 1, show(q1));
  const q2 = await hcQuote(pools, token, logs, [...(await proved(pools, q1, await land(pools, q1)))]);
  assert.ok(!("code" in q2) && q2.amountOut === AMOUNT, `expected the honest market at ${AMOUNT}, got ${show(q2)}`);
});

test("RV3 (control) with `bought` the honest route through X's market, the banned hostile market costs one try and the sale leaves through the honest market", async () => {
  const token = "0x00000000000000000000000000000000000c1d03";
  const x = xAt(0x7d3);
  const pool: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  const honest = marketOf(x);
  const hostile: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (later(ctx) ? null : 2n * a) };
  const logs = [{ key: pool.key, at: 4_500_000 }, { key: honest.key, at: 4_100_000 }, { key: hostile.key, at: 4_100_001 }];
  const pools = [seeded(token), pool, honest, hostile];
  const bought: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: x, fee: 2500, tickSpacing: 50, hooks: NATIVE, hookData: "0x" }, { currency: token, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" }] };
  const q = (banned?: string[]) => evmPoolSellQuoteWith({ chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought, boughtBlock: 1n, sent: [], signSim, ...(banned ? { banned } : {}) } as EvmPoolSellQuoteRequest, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, logs), DELEGATED);
  const q1 = await q();
  assert.deepEqual(q1.hooked, [hcPid(hostile.key)]);
  const h1 = q1 as unknown as HookedQuote;
  const q2 = await q([...(await proved(pools, h1, await land(pools, h1)))]);
  assert.equal(q2.amountOut, AMOUNT, show(q2));
});

test("RV4 an honest pool behind an unlisted hook that shares the reverted route with the attacker's market: the evidence blames the attacker's alone (its hook a no-op, the replay succeeds; the honest one's a no-op, it still reverts), and the next quote leaves through the honest pool", async () => {
  const token = "0x00000000000000000000000000000000000c1d04";
  const x = xAt(0x7d4);
  const HONEST_HOOK = "0x00000000000000000000000000000000000030cc";
  // the token's only real pool: with X, behind an honest hook no venue lists (a launchpad not on the list)
  const pool: ModelPool = { key: keyOf(token, x, 3000, 60, HONEST_HOOK), give: (a) => a, lie: (a) => a };
  const honest = marketOf(x);
  const hostile: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (later(ctx) ? null : 2n * a) };
  const logs = [{ key: pool.key, at: 4_500_000 }, { key: honest.key, at: 4_100_000 }, { key: hostile.key, at: 4_100_001 }];
  const pools = [seeded(token), pool, honest, hostile];
  const q1 = await hcQuote(pools, token, logs);
  assert.ok(!("code" in q1), show(q1));
  // both pools of the reverted route are named, the honest one with the attacker's
  assert.deepEqual([...q1.hooked].sort(), [hcPid(hostile.key), hcPid(pool.key)].sort());
  const ban = await proved(pools, q1, await land(pools, q1));
  assert.deepEqual(ban, [hcPid(hostile.key)], "only the attacker's pool is banned");
  const q2 = await hcQuote(pools, token, logs, [...ban]);
  // the card's goal: the sale through the honest pool and X's honest market, at AMOUNT
  assert.ok(!("code" in q2) && q2.amountOut === AMOUNT, `expected ${AMOUNT} through the honest pool, got ${show("code" in q2 ? q2 : { amountOut: q2.amountOut, minOut: q2.minOut, hooked: q2.hooked })}`);
});

test("RV5 no attacker: the token's only real pool, behind an honest unlisted hook, misses minOut once as its price moves 2% before the sale lands; the replay and the quoter both see the moved price, so nothing is banned and the next quote sells through it", async () => {
  const token = "0x00000000000000000000000000000000000c1d05";
  // the price falls 2% between the quote's block and the sale's (the slippage is 1%), and is back by the next quote
  let moved = false;
  const at = (a: bigint) => (moved ? (2n * a * 98n) / 100n : 2n * a);
  const honest: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: at, lie: at, state: pricedInto1(2n), exec: at };
  const logs = [{ key: honest.key, at: 4_500_001 }];
  const pools = [seeded(token), honest];
  const q1 = await hcQuote(pools, token, logs);
  assert.ok(!("code" in q1) && q1.amountOut === 2n * AMOUNT && q1.hooked.length === 1, show(q1));
  moved = true;
  const hash = await land(pools, q1);
  assert.equal(SALES.get(hash)!.status, "0x0", "the sale misses minOut and reverts");
  assert.deepEqual(await proved(pools, q1, hash), [], "a moved price bans nothing");
  moved = false;
  const q2 = await hcQuote(pools, token, logs);
  assert.ok(!("code" in q2) && q2.amountOut === 2n * AMOUNT, `expected the honest pool at ${2n * AMOUNT} once its price is back, got ${show("code" in q2 ? q2 : { amountOut: q2.amountOut, minOut: q2.minOut, hooked: q2.hooked })}`);
});

test("RV6 a hook that takes a fee through a delta from the real sale alone (the quoter and the sim see none): the evidence blames it, one failed try, then the market", async () => {
  const token = "0x00000000000000000000000000000000000c1d06";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const taker: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (later(ctx) ? (2n * a * 90n) / 100n : 2n * a) };
  const r = await hcConverge([seeded(token), market, taker], token, [{ key: market.key, at: 4_500_000 }, { key: taker.key, at: 4_500_001 }]);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT, banned: [hcPid(taker.key)] }, show(r));
});

test("RV7 a sale that reverts with the pool's hook a no-op too (the revert is not the hook's): nothing is banned", async () => {
  const token = "0x00000000000000000000000000000000000c1d07";
  const dead = (a: bigint, ctx: SimCtx) => (later(ctx) ? null : 2n * a);
  const pool: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: dead, neutral: dead };
  const pools = [seeded(token), pool];
  const q1 = await hcQuote(pools, token, [{ key: pool.key, at: 4_500_001 }]);
  assert.ok(!("code" in q1) && q1.hooked.length === 1, show(q1));
  const hash = await land(pools, q1);
  assert.equal(SALES.get(hash)!.status, "0x0");
  assert.deepEqual(await proved(pools, q1, hash), []);
});

test("RV8 providers that disagree on the sale or on a replay ban nothing; a sale that landed, or one to another W, bans nothing; the same sale on two honest providers bans the hostile pool", async () => {
  const token = "0x00000000000000000000000000000000000c1d08";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (later(ctx) ? null : 2n * a) };
  const pools = [market, hostile];
  const q1 = await hcQuote(pools, token, [{ key: market.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }]);
  assert.ok(!("code" in q1) && q1.hooked.length === 1, show(q1));
  // the receipt's status differs on the second provider
  assert.deepEqual(await proved(pools, q1, await land(pools, q1, HEAD_NO + 1, { status1: "0x1" })), []);
  // the second provider answers the replay as the sale ran with another revert, or the no-op replay with a revert
  const replays = (inner: EvmRpc, answer: (c: EvmRpcCall) => unknown): EvmRpc => async (calls) => (await inner(calls)).map((a, i) => (calls[i]!.params[3] !== undefined ? answer(calls[i]!) ?? a : a));
  const hash = await land(pools, q1);
  // (each replay overrides W's code, then the hooks it replaces, never the sender's balance: review of a2d82dc6, F1)
  assert.deepEqual(await proved(pools, q1, hash, [chain(pools, 0), replays(chain(pools, 1), (c) => (ownOver(c.params[2]) === 1 ? { jsonrpc: "2.0", id: 0, error: { code: 3, message: "execution reverted", data: "0xdeadbeef" } } : undefined))]), []);
  assert.deepEqual(await proved(pools, q1, hash, [chain(pools, 0), replays(chain(pools, 1), (c) => (ownOver(c.params[2]) > 1 ? { jsonrpc: "2.0", id: 0, error: { code: 3, message: "execution reverted", data: "0x81efc143" } } : undefined))]), []);
  // a sale that landed, or one sent to another account than the quote's W
  assert.deepEqual(await proved(pools, q1, await land(pools, q1, HEAD_NO + 1, { status: "0x1" })), []);
  assert.deepEqual(await proved(pools, q1, await land(pools, q1, HEAD_NO + 1, { to: "0x000000000000000000000000000000000000beef" })), []);
  // a hash no provider holds is no answer (rpc_error), never a ban
  await assert.rejects(proved(pools, q1, "0x" + "77".repeat(32)), (e: unknown) => e instanceof EvmQuoteError && e.code === "rpc_error");
  // control: the same sale on two honest providers
  assert.deepEqual(await proved(pools, q1, hash), [hcPid(hostile.key)]);
});

test("RV9 an honest hook that takes its fee through a delta the quoter sees, when the price moves past the slippage: the no-op replay would pass, but the quoter at the parent block sees the moved price, so nothing is banned", async () => {
  const token = "0x00000000000000000000000000000000000c1d09";
  let moved = false;
  const m = (x: bigint) => (moved ? (x * 98n) / 100n : x);
  // 5% to the hook through a delta, seen by the quoter, the sim and the sale alike; 2a with the hook a no-op
  const fee: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => m(2n * a), lie: (a) => m((2n * a * 95n) / 100n), state: pricedInto1(2n), exec: (a) => m((2n * a * 95n) / 100n) };
  const pools = [seeded(token), fee];
  const q1 = await hcQuote(pools, token, [{ key: fee.key, at: 4_500_001 }]);
  assert.ok(!("code" in q1) && q1.amountOut === (2n * AMOUNT * 95n) / 100n && q1.hooked.length === 1, show(q1));
  moved = true;
  const hash = await land(pools, q1);
  assert.equal(SALES.get(hash)!.status, "0x0", "the sale misses minOut and reverts");
  assert.deepEqual(await proved(pools, q1, hash), [], "the honest hook is not banned for a moved price");
});

test("RV10 one unlisted hook behind two pools of the route: the no-op replay replaces it in both and rescues the sale, so both pools are banned (two pools on one hook never freeze the sale)", async () => {
  const token = "0x00000000000000000000000000000000000c1d0a";
  const x = xAt(0x7da);
  const SHARED = "0x00000000000000000000000000000000000040cc";
  const pool: ModelPool = { key: keyOf(token, x, 3000, 60, SHARED), give: (a) => a, lie: (a) => a };
  const honest = marketOf(x);
  const hostile: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, SHARED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (later(ctx) ? null : 2n * a) };
  const logs = [{ key: pool.key, at: 4_500_000 }, { key: honest.key, at: 4_100_000 }, { key: hostile.key, at: 4_100_001 }];
  const pools = [seeded(token), pool, honest, hostile];
  const q1 = await hcQuote(pools, token, logs);
  assert.ok(!("code" in q1) && q1.hooked.length === 2, show(q1));
  const hash = await land(pools, q1);
  assert.equal(SALES.get(hash)!.status, "0x0");
  assert.deepEqual([...(await proved(pools, q1, hash))].sort(), [hcPid(pool.key), hcPid(hostile.key)].sort());
  // banned, the next quote leaves through the seeded pool, the only route left (X's honest market is reached only
  // through the token's pool on that hook)
  const q2 = await hcQuote(pools, token, logs, [hcPid(pool.key), hcPid(hostile.key)]);
  assert.ok(!("code" in q2) && q2.hooked.length === 0, show(q2));
});

test("RV11 a reverted sale that is not the quote's own (its token, amount, minOut, target or route one off) is no evidence: nothing is banned; the quote's own sale bans", async () => {
  const token = "0x00000000000000000000000000000000000c1d0b";
  const other = "0x00000000000000000000000000000000000c1d0c"; // the token one off, with a pool of its own on the same hook
  const H = "0x00000000000000000000000000000000000050cc";
  const hostileOf = (t: string, fee: number, k: bigint): ModelPool => ({ key: keyOf(t, NATIVE, fee, 60, H), give: (a) => k * a, lie: (a) => k * a, state: pricedInto1(k), exec: (a, ctx) => (later(ctx) ? null : k * a) });
  // the quote's pool (3000), a lower one on the same hook (3001: the route one off), and the other token's
  const [a, c, o] = [hostileOf(token, 3000, 2n), hostileOf(token, 3001, 2n), hostileOf(other, 3000, 2n)];
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (x) => x };
  // the one-off route's pool quotes 1.5x as it is (so the quote picks the 3000 pool) and 2x with its hook a no-op
  const pools = [market, a, { ...c, lie: (x: bigint) => (3n * x) / 2n }, o];
  const q1 = await hcQuote(pools, token, [{ key: market.key, at: 4_500_000 }, { key: a.key, at: 4_500_001 }, { key: c.key, at: 4_500_002 }]);
  assert.ok(!("code" in q1) && q1.hooked.length === 1 && q1.hooked[0] === hcPid(a.key), show(q1));
  // the Sell's words: the tuple at word 0; token, amount and target its first three words, minOut its fifth, and its
  // route's first hop's fee inside the data (abi.encode(PathKey[]))
  const bump = (word: (w: (i: number) => bigint, t: number) => number, by = 1n) => (input: string) => {
    const d = input.slice(10);
    const w = (i: number) => BigInt("0x" + d.slice(64 * i, 64 * i + 64));
    const i = word(w, Number(w(0) / 32n));
    return input.slice(0, 10) + d.slice(0, 64 * i) + W(w(i) + by) + d.slice(64 * i + 64);
  };
  const fieldOf = (k: number) => bump((_w, t) => t + k);
  const routeFee = bump((w, t) => {
    const at = t + Number(w(t + 3) / 32n); // the data's length word
    const arr = at + 1 + Number(w(at + 1) / 32n); // the PathKey[] length word
    return arr + 1 + Number(w(arr + 1) / 32n) + 1; // the first hop's fee
  });
  const offs: [string, (x: string) => string][] = [
    ["token", (x) => bump((_w, t) => t, BigInt(other) - BigInt(token))(x)],
    ["amount", fieldOf(1)],
    ["target", fieldOf(2)],
    ["minOut", fieldOf(4)],
    ["route", routeFee],
  ];
  for (const [what, edit] of offs) {
    const hash = await land(pools, q1, HEAD_NO + 1, {}, edit);
    assert.equal(SALES.get(hash)!.status, "0x0", what);
    assert.deepEqual(await proved(pools, q1, hash), [], `a sale with its ${what} off is not the quote's`);
  }
  assert.deepEqual(await proved(pools, q1, await land(pools, q1)), [hcPid(a.key)]);
});

test("RVX two distinct unlisted hooks on one picked route, each reverting the real sale (review of c1f486ae, M1): no one hook's no-op rescues it, the replay with both a no-op does, so both pools are banned and the sale converges; providers that disagree on that replay, or a revert both no-ops leave, ban nothing", async () => {
  const token = "0x00000000000000000000000000000000000c1e01";
  const x = xAt(0x7e1);
  const H1 = "0x00000000000000000000000000000000000061cc";
  const H2 = "0x00000000000000000000000000000000000062cc";
  // X's market behind H1 and the token's pool behind H2: each lies 2x to the quoter and the sim and reverts the real
  // sale; with its hook a no-op each pays as it does with no hook
  const market: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, H1), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (later(ctx) ? null : 2n * a) };
  const pool: ModelPool = { key: keyOf(token, x, 3000, 60, H2), give: (a) => a, lie: (a) => a, exec: (a, ctx) => (later(ctx) ? null : a) };
  const logs = [{ key: pool.key, at: 4_500_000 }, { key: market.key, at: 4_100_001 }];
  const pools = [seeded(token), pool, market];
  const q1 = await hcQuote(pools, token, logs);
  assert.ok(!("code" in q1) && q1.hooked.length === 2, show(q1));
  const hash = await land(pools, q1);
  assert.equal(SALES.get(hash)!.status, "0x0");
  // the second provider answers the replay with both hooks a no-op (asW and two hooks: three overrides) with a revert
  const replays = (inner: EvmRpc, answer: (c: EvmRpcCall) => unknown): EvmRpc => async (calls) => (await inner(calls)).map((a, i) => (calls[i]!.params[3] !== undefined ? answer(calls[i]!) ?? a : a));
  assert.deepEqual(await proved(pools, q1, hash, [chain(pools, 0), replays(chain(pools, 1), (c) => (ownOver(c.params[2]) === 3 ? { jsonrpc: "2.0", id: 0, error: { code: 3, message: "execution reverted", data: "0x81efc143" } } : undefined))]), [], "providers that disagree ban nothing");
  // the device's loop: one failed try, both pools banned, then the seeded pool
  const r = await hcConverge(pools, token, logs, 4);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: [...r.banned].sort() }, { failed: 1, got: AMOUNT / 10n, banned: [hcPid(market.key), hcPid(pool.key)].sort() }, show(r));
  // control: pools that revert the sale with their hooks a no-op too (the revert is not the hooks'): nothing is banned
  const dead = (k: bigint) => (a: bigint, ctx: SimCtx) => (later(ctx) ? null : k * a);
  const deadPools = [seeded(token), { ...pool, neutral: dead(1n) }, { ...market, neutral: dead(2n) }];
  const q2 = await hcQuote(deadPools, token, logs);
  assert.ok(!("code" in q2) && q2.hooked.length === 2, show(q2));
  assert.deepEqual(await proved(deadPools, q2, await land(deadPools, q2)), []);
});

// ------------------------------------------------------------------------------------- card evm-buy-hook-converge
// The buy takes the sale's take-and-ban design. A pool behind a hook the venue does not list that quotes the quoter
// high used to set the buy's reference R (at the lower of its quote with the hook replaced and as it is) and refuse every
// buy below_reference, while a buy through it was refused no_exit: the token could not be bought. Now a route through
// such a hook is bought where no route through listed pools is within the slippage of it, at the lowest of its quotes;
// where its real buy reverts, the device's own evidence (evmBuyRevertedPools) names the pools at fault, the caller bans
// them (the sale's bans), and the next quote leaves them out. A route through listed pools within the slippage of such a
// reference is bought at the reference's minOut.
const SEL_BUY_T = Buffer.from(keccak_256(new TextEncoder().encode("buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)"))).toString("hex").slice(0, 8);
const BUY_ADAPTER = "0x00000000000000000000000000000000000ad4a4";
// the relayer's fee the model's buys pay out of the withdrawn value (the pool swaps the rest)
const BUY_FEE = 3n * 10n ** 15n;
// main's pool's gas (contracts/pool-evm/src/PrivacyPoolSimple.sol BUY_SWAP_GAS, BUY_FAIL_GAS and SwapGasTooLow); the
// model's intrinsic cost and release before the swap's call (the measured Privacy Pools withdrawal is 611,391, M349);
// the model's buy gas limit: a limit under the helper's EVM_GAS_MAX of 1,500,000 (apps/helper/src/pool/evm.ts), not the
// helper's own sizing (its estimate x 1.2 would be at least 1.2 x 1,251,000 = 1,501,200 with this model's release, past
// that cap; M388 measured 1,082,371 least landing gas at depth 2, about 1.30M after x 1.2). The evidence rule needs only
// one limit the buy and its replay both run at; the helper's sizing is card evm-buy-gas-depth's
const [BUY_SWAP_GAS, BUY_FAIL_GAS, BUY_RELEASE_GAS, BUY_GAS] = [500_000n, 150_000n, 600_000n, 1_400_000n];
const SWAP_GAS_TOO_LOW = Symbol("SwapGasTooLow");
const SEL_SWAP_GAS_TOO_LOW = "0x" + Buffer.from(keccak_256(new TextEncoder().encode("SwapGasTooLow()"))).toString("hex").slice(0, 8);
// the pool's events (IPrivacyPool.sol), hashed here: the kit holds them as literals
const topicOf = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex");
const TOPIC_WITHDRAWN_T = topicOf("Withdrawn(address,address,uint256,uint256,uint256,uint256)");
const TOPIC_BOUGHT_T = topicOf("Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)");
// Base's venue with its pool and v4 adapter pinned, as pool-evm-deploy pins them
const BUY_VENUES = Object.freeze({ ...DELEGATED, base: Object.freeze({ ...DELEGATED.base, pool: SALE_POOL, adapters: Object.freeze({ v4: BUY_ADAPTER }) }) }) as builder.EvmPoolVenueList;
// The chain a buy runs on in the model: its name, its venue list (its pool and v4 adapter pinned the same way) and
// whether it is Nitro (Robinhood: chain's `nitro`); Base unless a test names another (review of ca907a05, LOW 2)
type Net = { chain: "base" | "base-sepolia" | "robinhood"; venues: builder.EvmPoolVenueList; nitro: boolean };
const pinnedOn = (c: "base-sepolia" | "robinhood") => Object.freeze({ ...DELEGATED, [c]: Object.freeze({ ...DELEGATED[c], pool: SALE_POOL, adapters: Object.freeze({ v4: BUY_ADAPTER }) }) }) as builder.EvmPoolVenueList;
const BASE_NET: Net = { chain: "base", venues: BUY_VENUES, nitro: false };
const RH_NET: Net = { chain: "robinhood", venues: pinnedOn("robinhood"), nitro: true };
const BS_NET: Net = { chain: "base-sepolia", venues: pinnedOn("base-sepolia"), nitro: false };
type BuyVerdict = EvmPoolBuyQuote | { code: string; reference: { amountOut: bigint; route: EvmRoute } | null };
const hbQuote = async (pools: ModelPool[], token: string, logs: { key: EvmPoolKey; at: number }[], route: EvmRoute, banned?: readonly string[], net: Net = BASE_NET): Promise<BuyVerdict> => {
  try {
    return await evmPoolBuyQuoteWith({ chain: net.chain, token, amountIn: AMOUNT, slippageBps: 100, route, ...(banned ? { banned } : {}) } as EvmPoolBuyQuoteRequest, [chain(pools, 0, undefined, undefined, undefined, net.nitro), chain(pools, 1, undefined, undefined, undefined, net.nitro)], NOW, scanner(5_000_000, logs));
  } catch (e) {
    if (!(e instanceof EvmQuoteError)) throw e;
    return { code: e.code, reference: e.reference };
  }
};
/** The pool's buy of quote `q` as the helper sends it: PrivacyPoolSimple.buy(withdrawal, proof, fee, Buy, signature),
 *  the Buy the device's build of the quote (evmQuotedBuy through Base's pinned adapter); the model's withdrawn value is
 *  the proof's last word (head word 16), the quote's amount. */
// `fee` sets the proof's withdrawn value to the amount and that fee, the fee word left BUY_FEE; `feeWord` sets the fee
// word, the withdrawn value left the amount and BUY_FEE (a sender that takes more, so the pool swaps less)
const buyInput = (q: EvmPoolBuyQuote, edit: Partial<{ adapter: string; data: string; minOut: bigint; token: string; fee: bigint; feeWord: bigint }> = {}, venues = BUY_VENUES): string => {
  const { fee: _fee, feeWord: _feeWord, ...fields } = edit;
  void _fee;
  void _feeWord;
  const built = { ...evmQuotedBuy(venues, BUY_ADAPTER, q, NOW), ...fields };
  const data = built.data.slice(2);
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
  const withdrawal = W(0x40n) + W(0n) + W(0n); // (processooor, bytes data) with no data, the model reads none of it
  const buyTail = W(BigInt(built.adapter)) + W(0x80n) + W(built.minOut) + W(BigInt(built.token)) + W(BigInt(data.length / 2)) + padded;
  const head = 20 * 32;
  // the proof's third public signal (head word 11) is its withdrawn value: the quote's amount and the relayer's fee
  const proof = Array.from({ length: 16 }, (_, i) => W(i === 10 ? q.amountIn + (edit.fee ?? BUY_FEE) : 0n)).join("");
  return "0x" + SEL_BUY_T + W(BigInt(head)) + proof + W(edit.feeWord ?? BUY_FEE) + W(BigInt(head + withdrawal.length / 2)) + W(BigInt(head + withdrawal.length / 2 + buyTail.length / 2)) + withdrawal + buyTail + W(65n) + "00".repeat(96);
};
/** Lands quote `q`'s buy on the modelled chain of `pools` at `block`, from the pinned sender to the pool, as main's pool
 *  lands it (card pool-evm-buy-pays-revert): status 1, its swap done (`bought`, the pool's Bought) or undone (the
 *  pool's Withdrawn, the chunk paid back to W); returns its hash. */
const landBuy = async (pools: ModelPool[], q: EvmPoolBuyQuote, block = HEAD_NO + 1, extra: Partial<ModelSale> = {}, edit: Parameters<typeof buyInput>[1] = {}, net: Net = BASE_NET): Promise<string> => {
  const input = buyInput(q, edit, net.venues);
  REAL_ERRORED.length = 0;
  const run = (await chain(pools, 0, undefined, undefined, undefined, net.nitro)([{ method: "eth_call", params: [{ from: SENDER, to: SALE_POOL, data: input, gas: "0x" + (extra.gas ?? BUY_GAS).toString(16), maxFeePerGas: "0x" + (BASE_FEE + 1_000_000n).toString(16), maxPriorityFeePerGas: "0xf4240" }, "latest", {}, { number: "0x" + block.toString(16) }, SALE_RUN] }]))[0] as { result?: string };
  const hash = "0x" + (0x5a1e0000 + ++saleNo).toString(16).padStart(64, "0");
  const bought = run.result !== undefined && BigInt(run.result) === 1n;
  const logs = [{ address: SALE_POOL, topics: [bought ? TOPIC_BOUGHT_T : TOPIC_WITHDRAWN_T, "0x" + "00".repeat(32)] }];
  SALES.set(hash, { hash, input, block, blockHash: "0x" + (0xb10c0000 + saleNo).toString(16).padStart(64, "0"), status: run.result !== undefined ? "0x1" : "0x0", to: SALE_POOL, bought, logs, errored: [...REAL_ERRORED], ...extra });
  return hash;
};
const buyProved = (pools: ModelPool[], q: EvmPoolBuyQuote, hash: string, rpcs?: EvmRpc[], net: Net = BASE_NET) =>
  evmBuyRevertedPoolsWith(q, hash, rpcs ?? [chain(pools, 0, undefined, undefined, undefined, net.nitro), chain(pools, 1, undefined, undefined, undefined, net.nitro)], net.venues, net.nitro ? [chain(pools, 0, undefined, undefined, undefined, true), chain(pools, 1, undefined, undefined, undefined, true)] : undefined);
// The device's buy loop: quote the route (a refusal below_reference names the device's own route, quoted next), buy,
// and where the buy reverts, ban the pools the device's own evidence blames and quote again
const hbConverge = async (pools: ModelPool[], token: string, logs: { key: EvmPoolKey; at: number }[], route0: EvmRoute, max = 8, block = HEAD_NO + 1, net: Net = BASE_NET) => {
  const banned: string[] = [];
  let [failed, route] = [0, route0];
  for (let i = 0; i < max; i++) {
    const q = await hbQuote(pools, token, logs, route, banned, net);
    if ("code" in q) {
      if (q.code === "below_reference" && q.reference !== null) {
        route = q.reference.route;
        continue;
      }
      return { failed, code: q.code, banned };
    }
    const hash = await landBuy(pools, q, block, {}, {}, net);
    if (SALES.get(hash)!.bought === true) return { failed, got: q.amountOut, minOut: q.minOut, hooked: q.hooked, banned };
    failed++;
    assert.ok(q.hooked.length > 0, "only a route through an unlisted hook can revert in the model");
    banned.push(...(await buyProved(pools, q, hash, undefined, net)));
  }
  return { failed, code: "no_convergence", banned };
};
const v4Route = (keys: { currency: string; fee: number; tickSpacing: number; hooks: string }[]): EvmRoute => ({ venue: "uniswap-v4", currencyIn: NATIVE, hops: keys.map((k) => ({ ...k, hookData: "0x" })) });
// the token's market: a standard hookless pool, so a reference whatever route is quoted (a found pool of the route's own
// is never its reference)
const marketRoute = (token: string): EvmRoute => v4Route([{ currency: token, fee: 500, tickSpacing: 10, hooks: NATIVE }]);

test("HB1 a hook that quotes the quoter high and reverts every real buy freezes no buy: one failed try, its pool banned, then the market", async () => {
  const token = "0x00000000000000000000000000000000000b1b01";
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec: (a, ctx) => (later(ctx) ? null : 2n * a) };
  const logs = [{ key: market.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }];
  const pools = [market, hostile];
  // the market's buy is refused below the hostile pool's reference; the hostile route is bought at its price, its pool named
  const m = await hbQuote(pools, token, logs, marketRoute(token));
  assert.ok("code" in m && m.code === "below_reference" && m.reference?.amountOut === 2n * AMOUNT, show(m));
  const q = await hbQuote(pools, token, logs, m.reference!.route);
  assert.ok(!("code" in q), show(q));
  assert.deepEqual({ out: q.amountOut, min: q.minOut, hooked: q.hooked }, { out: 2n * AMOUNT, min: (2n * AMOUNT * 9900n) / 10000n, hooked: [hcPid(hostile.key)] });
  const r = await hbConverge(pools, token, logs, marketRoute(token));
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT, banned: [hcPid(hostile.key)] }, show(r));
  // while banned, the pool sets no reference, and a buy through it is refused with the device's own route
  const again = await hbQuote(pools, token, logs, m.reference!.route, r.banned);
  assert.ok("code" in again && again.code === "below_reference" && again.reference?.amountOut === AMOUNT, show(again));
});

test("HB2 a hook that honours only even blocks (the quote at an even block, the buy lands at an odd one) freezes no buy: one failed try, then the market", async () => {
  const token = "0x00000000000000000000000000000000000b1b02";
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const even: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec: (a, ctx) => ((ctx.block ?? HEAD_NO) % 2 === 0 ? 2n * a : null) };
  const logs = [{ key: market.key, at: 4_500_000 }, { key: even.key, at: 4_500_001 }];
  const r = await hbConverge([market, even], token, logs, marketRoute(token));
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT, banned: [hcPid(even.key)] }, show(r));
  // landed at an even block, the same buy goes through
  const t2 = "0x00000000000000000000000000000000000b1b12";
  const [m2, e2] = [{ ...market, key: keyOf(t2, NATIVE, 500, 10, NATIVE) }, { ...even, key: keyOf(t2, NATIVE, 3000, 60, UNPINNED) }];
  const r2 = await hbConverge([m2, e2], t2, [{ key: m2.key, at: 4_500_000 }, { key: e2.key, at: 4_500_001 }], marketRoute(t2), 8, HEAD_NO + 2);
  assert.deepEqual({ failed: r2.failed, got: r2.got, hooked: r2.hooked }, { failed: 0, got: 2n * AMOUNT, hooked: [hcPid(e2.key)] }, show(r2));
});

test("HB3 hooks that revert every real buy cost at most one failed try per pool: two such pools, two tries, then the market", async () => {
  const token = "0x00000000000000000000000000000000000b1b03";
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const never = (fee: number, k: bigint): ModelPool => ({ key: keyOf(token, NATIVE, fee, 60, UNPINNED), give: (a) => k * a, lie: (a) => k * a, state: pricedAt(k), exec: (a, ctx) => (later(ctx) ? null : k * a) });
  const [a, b] = [never(3000, 3n), never(3001, 2n)];
  const r = await hbConverge([market, a, b], token, [{ key: market.key, at: 4_500_000 }, { key: a.key, at: 4_500_001 }, { key: b.key, at: 4_500_002 }], marketRoute(token));
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 2, got: AMOUNT, banned: [hcPid(a.key), hcPid(b.key)] }, show(r));
});

test("HB4 an honest pool behind an unlisted hook, the token's best, is bought at its own price with no try lost; a listed route within the slippage of it is bought instead, at its own minOut", async () => {
  const token = "0x00000000000000000000000000000000000b1b04";
  const honest: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n) };
  const r = await hbConverge([seeded(token), honest], token, [{ key: honest.key, at: 4_500_001 }], seededRoute(token));
  assert.deepEqual({ failed: r.failed, got: r.got, hooked: r.hooked }, { failed: 0, got: 2n * AMOUNT, hooked: [hcPid(honest.key)] }, show(r));
  // another token: a hookless pool half a percent under the honest one
  const t2 = "0x00000000000000000000000000000000000b1b14";
  const near: ModelPool = { key: keyOf(t2, NATIVE, 500, 10, NATIVE), give: (a) => 2n * a - (2n * a) / 200n, state: pricedAt(2n) };
  const h2: ModelPool = { ...honest, key: keyOf(t2, NATIVE, 3000, 60, UNPINNED) };
  const logs = [{ key: near.key, at: 4_500_000 }, { key: h2.key, at: 4_500_001 }];
  const hooked = await hbQuote([near, h2], t2, logs, v4Route([{ currency: t2, fee: 3000, tickSpacing: 60, hooks: UNPINNED }]));
  assert.ok("code" in hooked && hooked.code === "below_reference" && hooked.reference?.amountOut === 2n * AMOUNT - (2n * AMOUNT) / 200n, show(hooked));
  const q = await hbQuote([near, h2], t2, logs, marketRoute(t2));
  assert.ok(!("code" in q) && q.hooked.length === 0 && q.amountOut === 2n * AMOUNT - (2n * AMOUNT) / 200n, show(q));
  assert.equal(q.minOut, ((2n * AMOUNT - (2n * AMOUNT) / 200n) * 9900n) / 10000n, "minOut from the route itself: a reference through an unlisted hook sets none (review of 72e28658, M2)");
  // more than the slippage under it, the listed route is still refused below the reference
  const t3 = "0x00000000000000000000000000000000000b1b24";
  const far: ModelPool = { ...near, key: keyOf(t3, NATIVE, 500, 10, NATIVE), give: (a) => 2n * a - (2n * a) / 50n };
  const h3: ModelPool = { ...honest, key: keyOf(t3, NATIVE, 3000, 60, UNPINNED) };
  const f = await hbQuote([far, h3], t3, [{ key: far.key, at: 4_500_000 }, { key: h3.key, at: 4_500_001 }], marketRoute(t3));
  assert.ok("code" in f && f.code === "below_reference" && f.reference?.amountOut === 2n * AMOUNT, show(f));
});

test("HB5 a buy quote's banned is a list of at most 4096 pool ids, each 0x and 64 hex digits: anything else is bad_request; a banned pool of the route refuses it with the device's own route", async () => {
  const token = "0x00000000000000000000000000000000000b1b05";
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const logs = [{ key: market.key, at: 4_500_000 }];
  for (const bad of ["0x" + "ab".repeat(32), ["0x" + "ab".repeat(31)], [1n], Array.from({ length: 4097 }, () => "0x" + "ab".repeat(32))]) {
    const v = await hbQuote([market, seeded(token)], token, logs, marketRoute(token), bad as readonly string[]);
    assert.ok("code" in v && v.code === "bad_request", show(bad).slice(0, 80));
  }
  const ok = await hbQuote([market, seeded(token)], token, logs, marketRoute(token), ["0x" + "ab".repeat(32)]);
  assert.ok(!("code" in ok) && ok.amountOut === AMOUNT && ok.hooked.length === 0, show(ok));
  // the route's own pool banned (an id in capitals bans it too): refused, naming the seeded pool
  const v = await hbQuote([market, seeded(token)], token, logs, marketRoute(token), ["0x" + hcPid(market.key).slice(2).toUpperCase()]);
  assert.ok("code" in v && v.code === "below_reference" && v.reference?.amountOut === AMOUNT / 10n, show(v));
});

test("HB6 the device's quote of a buy through an unlisted hook builds through the pinned adapter at its minOut; the evidence bans nothing for a buy that is not the quote's own, a buy that landed or went elsewhere, or a moved price", async () => {
  const token = "0x00000000000000000000000000000000000b1b06";
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  let moved = false;
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => (moved ? a : 2n * a), state: pricedAt(2n), exec: (a, ctx) => (later(ctx) ? null : 2n * a) };
  const pools = [market, hostile];
  const logs = [{ key: market.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }];
  const route = v4Route([{ currency: token, fee: 3000, tickSpacing: 60, hooks: UNPINNED }]);
  const q = await hbQuote(pools, token, logs, route);
  assert.ok(!("code" in q), show(q));
  const built = evmQuotedBuy(BUY_VENUES, BUY_ADAPTER, q, NOW);
  assert.deepEqual({ adapter: built.adapter, minOut: built.minOut, data: built.data }, { adapter: BUY_ADAPTER, minOut: q.minOut, data: "0x" + Buffer.from(builder.evmPoolRouteDataQuoted("base", route).data).toString("hex") });
  // the quote's own buy, reverted: the hostile pool is banned
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q)), [hcPid(hostile.key)]);
  // one field off: no evidence
  const other = "0x00000000000000000000000000000000000b1b66";
  // (a withdrawn value less the fee other than the quote's amount too: review of 72e28658, L3)
  for (const edit of [{ minOut: q.minOut - 1n }, { token: other }, { adapter: other }, { data: built.data + "00" }, { fee: 2n * BUY_FEE }]) {
    assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, {}, edit)), [], show(edit));
  }
  // a buy whose swap was done (the pool's Bought), one with no Withdrawn, one the pool reverted whole (on main's pool
  // no swap reverts it: card pool-evm-buy-pays-revert), or one sent to another address, is no evidence
  const log = (topic: string, address = SALE_POOL) => [{ address, topics: [topic, "0x" + "00".repeat(32)] }];
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { logs: [...log(TOPIC_WITHDRAWN_T), ...log(TOPIC_BOUGHT_T)] })), []);
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { logs: log(TOPIC_WITHDRAWN_T, other) })), []);
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { status: "0x0" })), []);
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { to: other })), []);
  // providers that disagree on the buy ban nothing
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { status1: "0x0" })), []);
  // the quoter at the parent block sees the price moved past minOut: nothing is banned
  const hash = await landBuy(pools, q);
  moved = true;
  assert.deepEqual(await buyProved(pools, q, hash), []);
});

// N1 (review of evm-sell-hook-converge, older than that card): a two-hop route through two unlisted hooks, H1 honest
// (a visible 5% fee the quoter sees; its no-op pays 2a) and H2 hostile (it shows the quoter, and the sim, 2% more than
// its pool pays). Read only whole (every hook as it is: 1.9 x 1.02 = 1.938a; every hook a no-op: 2a), the route counted
// at 1.938a, above the 1.9a it pays with H2 alone a no-op: case B (H2 reverts the real trade) banned both pools, case C
// (H2 pays its no-op price in the real trade) banned only the honest one. Read with each hook alone a no-op too, it
// counts at 1.9a: minOut 1.881a; case B bans H2 alone, case C lands.
const N1_H1 = "0x00000000000000000000000000000000000071cc";
const N1_H2 = "0x00000000000000000000000000000000000072cc";
const n1Hostile = (paysInSale: boolean) => (a: bigint, ctx: SimCtx) => (later(ctx) ? (paysInSale ? a : null) : (a * 102n) / 100n);

test("N1B (sell, case B) a hostile hook's extra hides behind an honest hook's fee no more: the route counts at 1.9, and the reverted sale bans the hostile pool alone", async () => {
  const token = "0x00000000000000000000000000000000000c1f01";
  const x = xAt(0x7f1);
  const h1: ModelPool = { key: keyOf(token, x, 3000, 60, N1_H1), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, state: pricedInto1(2n) };
  const h2: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, N1_H2), give: (a) => a, lie: (a) => (a * 102n) / 100n, exec: n1Hostile(false) };
  const logs = [{ key: h1.key, at: 4_500_000 }, { key: h2.key, at: 4_100_001 }];
  const pools = [seeded(token), h1, h2];
  const q = await hcQuote(pools, token, logs);
  assert.ok(!("code" in q), show(q));
  assert.deepEqual({ out: q.amountOut, min: q.minOut }, { out: (19n * AMOUNT) / 10n, min: (19n * AMOUNT * 9900n) / 100000n }, show(q));
  assert.deepEqual(await proved(pools, q, await land(pools, q)), [hcPid(h2.key)], "the hostile pool alone");
});

test("N1C (sell, case C) the hostile hook pays its no-op price in the real sale: the sale lands at 1.9, the honest pool never banned", async () => {
  const token = "0x00000000000000000000000000000000000c1f02";
  const x = xAt(0x7f2);
  const h1: ModelPool = { key: keyOf(token, x, 3000, 60, N1_H1), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, state: pricedInto1(2n) };
  const h2: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, N1_H2), give: (a) => a, lie: (a) => (a * 102n) / 100n, exec: n1Hostile(true) };
  const logs = [{ key: h1.key, at: 4_500_000 }, { key: h2.key, at: 4_100_001 }];
  const r = await hcConverge([seeded(token), h1, h2], token, logs);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 0, got: (19n * AMOUNT) / 10n, banned: [] }, show(r));
});

const n1BuyPools = (token: string, x: string, paysInBuy: boolean): ModelPool[] => [
  seeded(token),
  { key: keyOf(x, NATIVE, 3000, 60, N1_H1), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, state: pricedAt(2n) },
  { key: keyOf(token, x, 3000, 60, N1_H2), give: (a) => a, lie: (a) => (a * 102n) / 100n, exec: n1Hostile(paysInBuy) },
];
const n1BuyRoute = (token: string, x: string) => v4Route([{ currency: x, fee: 3000, tickSpacing: 60, hooks: N1_H1 }, { currency: token, fee: 3000, tickSpacing: 60, hooks: N1_H2 }]);

test("N1B (buy, case B) the same two hooks on a buy: the route counts at 1.9, minOut 1.881, and the reverted buy bans the hostile pool alone", async () => {
  const [token, x] = ["0x00000000000000000000000000000000000c1f11", xAt(0x7f3)];
  const pools = n1BuyPools(token, x, false);
  const logs = [{ key: pools[2]!.key, at: 4_500_000 }, { key: pools[1]!.key, at: 4_100_001 }];
  const q = await hbQuote(pools, token, logs, n1BuyRoute(token, x));
  assert.ok(!("code" in q), show(q));
  assert.deepEqual({ out: q.amountOut, min: q.minOut, hooked: q.hooked }, { out: (19n * AMOUNT) / 10n, min: (19n * AMOUNT * 9900n) / 100000n, hooked: [hcPid(pools[1]!.key), hcPid(pools[2]!.key)] }, show(q));
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q)), [hcPid(pools[2]!.key)], "the hostile pool alone");
});

test("N1C (buy, case C) the hostile hook pays its no-op price in the real buy: the buy lands at 1.9, nothing banned", async () => {
  const [token, x] = ["0x00000000000000000000000000000000000c1f12", xAt(0x7f4)];
  const pools = n1BuyPools(token, x, true);
  const logs = [{ key: pools[2]!.key, at: 4_500_000 }, { key: pools[1]!.key, at: 4_100_001 }];
  const r = await hbConverge(pools, token, logs, n1BuyRoute(token, x));
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 0, got: (19n * AMOUNT) / 10n, banned: [] }, show(r));
});

test("N1D a three-hop route through two hooks that each revert the real trade and an honest hook with a visible fee: the two hostile hooks' no-op together is the smallest set that rescues it, so it bans the two hostile pools, never the honest one", async () => {
  const [token, y, x] = ["0x00000000000000000000000000000000000c1f13", xAt(0x7f5), xAt(0x7f6)];
  const N1_H3 = "0x00000000000000000000000000000000000073cc";
  const reverts = (a: bigint, ctx: SimCtx) => (later(ctx) ? null : a);
  const honest: ModelPool = { key: keyOf(y, NATIVE, 3000, 60, N1_H3), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, state: pricedAt(2n) };
  const h1: ModelPool = { key: keyOf(x, y, 3000, 60, N1_H1), give: (a) => a, lie: (a) => a, exec: reverts };
  const h2: ModelPool = { key: keyOf(token, x, 3000, 60, N1_H2), give: (a) => a, lie: (a) => a, exec: reverts };
  const pools = [seeded(token), honest, h1, h2];
  const route = v4Route([{ currency: y, fee: 3000, tickSpacing: 60, hooks: N1_H3 }, { currency: x, fee: 3000, tickSpacing: 60, hooks: N1_H1 }, { currency: token, fee: 3000, tickSpacing: 60, hooks: N1_H2 }]);
  const q = await hbQuote(pools, token, [], route);
  assert.ok(!("code" in q), show(q));
  assert.deepEqual({ out: q.amountOut, min: q.minOut }, { out: (19n * AMOUNT) / 10n, min: (19n * AMOUNT * 9900n) / 100000n });
  const hash = await landBuy(pools, q);
  assert.equal(SALES.get(hash)!.bought, false);
  assert.deepEqual([...(await buyProved(pools, q, hash))].sort(), [hcPid(h1.key), hcPid(h2.key)].sort(), "the two hostile pools, never the honest one");
});

// ------------------------------------------------------------------------------ review of 72e28658 (card evm-buy-hook-converge)
// The review's probes, each the red run before its fold: H1 the prune's floor, H2 main's pool (a failed swap lands
// status 1 with the pool's Withdrawn), H3 hooks that cover each other, M1 two liars, M2 a hooked reference that sets the
// slippage, M3 the replay's gas, L2 the two mutants put back, L3 the buy's withdrawn value. Each hook below is unlisted.
const RH = (n: number) => "0x" + (0x9b00 + n).toString(16).padStart(40, "0");

test("review of 72e28658, H1 an unlisted hook that quotes the quoter 3x no longer raises the prune's floor: the token's real hookless market (a found pool, past the early reads) is quoted, and the hooked route is refused below it", async () => {
  const token = "0x00000000000000000000000000000000000d1d02";
  const real: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  // raw liquidity a/2 (what the no-op read and the real buy see); 3x to the quoter as it is
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, RH(1)), give: (a) => a / 2n, lie: (a) => 3n * a, exec: (a) => a / 2n };
  const empties = Array.from({ length: 65 }, (_, i) => ({ key: keyOf(token, NATIVE, 2000 + i, 40, NATIVE), at: 4_400_000 + i }));
  const logs = [{ key: real.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }, ...empties];
  const q = await hbQuote([seeded(token), real, hostile], token, logs, v4Route([{ currency: token, fee: 3000, tickSpacing: 60, hooks: RH(1) }]));
  assert.ok("code" in q && q.code === "below_reference" && q.reference?.amountOut === AMOUNT, show(q));
});

test("review of 72e28658, H1b the same through X: the token's real market is its pool with X (X's standard market beside it), and the 3x quote no longer prunes it", async () => {
  const token = "0x00000000000000000000000000000000000d1d0c";
  const x = xAt(0x9bb);
  const xm: ModelPool = { key: keyOf(x, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const tp: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, RH(2)), give: (a) => a / 2n, lie: (a) => 3n * a, exec: (a) => a / 2n };
  const logs = [{ key: tp.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }];
  const q = await hbQuote([seeded(token), xm, tp, hostile], token, logs, v4Route([{ currency: token, fee: 3000, tickSpacing: 60, hooks: RH(2) }]));
  assert.ok("code" in q && q.code === "below_reference" && q.reference?.amountOut === AMOUNT, show(q));
});

test("review of 72e28658, H2 on main's pool a failed swap lands status 1 with the pool's Withdrawn and no Bought: the evidence reads it as the failed buy, so HB1's hostile hook costs one failed try, its pool banned, then the market", async () => {
  const token = "0x00000000000000000000000000000000000d1d03";
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, RH(3)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec: (a, ctx) => (later(ctx) ? null : 2n * a) };
  const pools = [market, hostile];
  const logs = [{ key: market.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }];
  const q = await hbQuote(pools, token, logs, marketRoute(token));
  assert.ok("code" in q && q.code === "below_reference", show(q));
  const hq = await hbQuote(pools, token, logs, q.reference!.route);
  assert.ok(!("code" in hq), show(hq));
  const hash = await landBuy(pools, hq);
  assert.deepEqual({ status: SALES.get(hash)!.status, bought: SALES.get(hash)!.bought }, { status: "0x1", bought: false }, "main's pool lands the failed swap");
  const r = await hbConverge(pools, token, logs, marketRoute(token), 6);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT, banned: [hcPid(hostile.key)] }, show(r));
});

test("review of 72e28658, M1 (buy) an honest hook with a visible 5% fee and two hooks that each show the quoter 2% more than they pay: the route counts at 1.9 (both liars replaced together), and the buy lands with nothing banned", async () => {
  const [token, y, x] = ["0x00000000000000000000000000000000000d1d04", xAt(0x9b4), xAt(0x9b5)];
  const pays = (a: bigint, ctx: SimCtx) => (later(ctx) ? a : (a * 102n) / 100n);
  const honest: ModelPool = { key: keyOf(y, NATIVE, 3000, 60, RH(4)), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, state: pricedAt(2n) };
  const l2: ModelPool = { key: keyOf(x, y, 3000, 60, RH(5)), give: (a) => a, lie: (a) => (a * 102n) / 100n, exec: pays };
  const l3: ModelPool = { key: keyOf(token, x, 3000, 60, RH(6)), give: (a) => a, lie: (a) => (a * 102n) / 100n, exec: pays };
  const pools = [seeded(token), honest, l2, l3];
  const route = v4Route([{ currency: y, fee: 3000, tickSpacing: 60, hooks: RH(4) }, { currency: x, fee: 3000, tickSpacing: 60, hooks: RH(5) }, { currency: token, fee: 3000, tickSpacing: 60, hooks: RH(6) }]);
  const q = await hbQuote(pools, token, [], route);
  assert.ok(!("code" in q), show(q));
  assert.deepEqual({ out: q.amountOut, min: q.minOut }, { out: (19n * AMOUNT) / 10n, min: (19n * AMOUNT * 9900n) / 100000n }, show(q));
  const hash = await landBuy(pools, q);
  assert.equal(SALES.get(hash)!.bought, true, "the buy lands at 1.9");
});

test("review of 72e28658, M1 (full set) a route whose read with every unlisted hook replaced answers 0 (its liquidity in a hook alone) is refused no_quote, though a read with only some replaced answers", async () => {
  const [token, x] = ["0x00000000000000000000000000000000000d1d24", xAt(0x9d4)];
  const h1: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, RH(22)), give: (a) => a, lie: (a) => a };
  const h2: ModelPool = { key: keyOf(token, x, 3000, 60, RH(23)), give: () => 0n, lie: (a) => a };
  const route = v4Route([{ currency: x, fee: 3000, tickSpacing: 60, hooks: RH(22) }, { currency: token, fee: 3000, tickSpacing: 60, hooks: RH(23) }]);
  const q = await hbQuote([seeded(token), h1, h2], token, [], route);
  assert.ok("code" in q && q.code === "no_quote", show(q));
});

test("review of 72e28658, M1 (sell) the same three hooks on a three-hop sale: the route counts at 1.9, and the sale lands", async () => {
  const token = "0x00000000000000000000000000000000000d1d14";
  const [x, y] = [xAt(0x9c4), xAt(0x9c5)];
  const pays = (a: bigint, ctx: SimCtx) => (later(ctx) ? a : (a * 102n) / 100n);
  // the sale: token -> X (a liar) -> Y (a liar) -> native (an honest 5% fee), 1:1 raw, 2x on the last hop
  const l3: ModelPool = { key: keyOf(token, x, 3000, 60, RH(14)), give: (a) => a, lie: (a) => (a * 102n) / 100n, exec: pays };
  const l2: ModelPool = { key: keyOf(x, y, 3000, 60, RH(15)), give: (a) => a, lie: (a) => (a * 102n) / 100n, exec: pays };
  const honest: ModelPool = { key: keyOf(y, NATIVE, 3000, 60, RH(16)), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, state: pricedInto1(2n) };
  const pools = [seeded(token), honest, l2, l3];
  const logs = [{ key: l3.key, at: 4_500_000 }, { key: l2.key, at: 4_100_001 }, { key: honest.key, at: 4_100_002 }];
  const q = await hcQuote(pools, token, logs);
  assert.ok(!("code" in q) && q.hooked.length === 3, show(q));
  assert.deepEqual({ out: q.amountOut, min: q.minOut }, { out: (19n * AMOUNT) / 10n, min: (19n * AMOUNT * 9900n) / 100000n }, show(q));
  assert.equal(SALES.get(await land(pools, q))!.status, "0x1", "the sale lands at 1.9");
});

// three hooks that each fail the real trade while any other of them is intact
const covering = (hs: string[], me: string, k: bigint) => (a: bigint, ctx: SimCtx) => (later(ctx) && hs.some((h) => h !== me && !(ctx.over ?? new Set()).has(h)) ? null : k * a);

test("review of 72e28658, H3 (buy) three hooks that cover each other: no single no-op rescues the buy, each pair does, so all three pools are banned and the buy converges on the market in one failed try", async () => {
  const [token, y, x] = ["0x00000000000000000000000000000000000d1d05", xAt(0x9b6), xAt(0x9b7)];
  const hs = [RH(7), RH(8), RH(9)];
  const p1: ModelPool = { key: keyOf(y, NATIVE, 3000, 60, hs[0]!), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec: covering(hs, hs[0]!, 2n) };
  const p2: ModelPool = { key: keyOf(x, y, 3000, 60, hs[1]!), give: (a) => a, lie: (a) => a, exec: covering(hs, hs[1]!, 1n) };
  const p3: ModelPool = { key: keyOf(token, x, 3000, 60, hs[2]!), give: (a) => a, lie: (a) => a, exec: covering(hs, hs[2]!, 1n) };
  const pools = [seeded(token), p1, p2, p3];
  const route = v4Route([{ currency: y, fee: 3000, tickSpacing: 60, hooks: hs[0]! }, { currency: x, fee: 3000, tickSpacing: 60, hooks: hs[1]! }, { currency: token, fee: 3000, tickSpacing: 60, hooks: hs[2]! }]);
  const r = await hbConverge(pools, token, [], route, 4);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: [...r.banned].sort() }, { failed: 1, got: AMOUNT / 10n, banned: [hcPid(p1.key), hcPid(p2.key), hcPid(p3.key)].sort() }, show(r));
});

test("review of 72e28658, H3 (sell) the same three hooks on a three-hop sale: the evidence bans all three (on c460d167 it did, through every hook together; leave-one-in banned none)", async () => {
  const token = "0x00000000000000000000000000000000000d1d0d";
  const [x, y] = [xAt(0x9bc), xAt(0x9bd)];
  const hs = [RH(40), RH(41), RH(42)];
  const p3: ModelPool = { key: keyOf(token, x, 3000, 60, hs[2]!), give: (a) => a, lie: (a) => a, exec: covering(hs, hs[2]!, 1n) };
  const p2: ModelPool = { key: keyOf(x, y, 3000, 60, hs[1]!), give: (a) => a, lie: (a) => a, exec: covering(hs, hs[1]!, 1n) };
  const p1: ModelPool = { key: keyOf(y, NATIVE, 3000, 60, hs[0]!), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: covering(hs, hs[0]!, 2n) };
  const pools = [seeded(token), p1, p2, p3];
  const logs = [{ key: p3.key, at: 4_500_000 }, { key: p2.key, at: 4_100_001 }, { key: p1.key, at: 4_100_002 }];
  const q = await hcQuote(pools, token, logs);
  assert.ok(!("code" in q) && q.hooked.length === 3, show(q));
  const hash = await land(pools, q);
  assert.equal(SALES.get(hash)!.status, "0x0");
  assert.deepEqual([...(await proved(pools, q, hash))].sort(), [hcPid(p1.key), hcPid(p2.key), hcPid(p3.key)].sort());
});

test("review of 72e28658, M2 (buy) a hooked reference its hook places at value / (1 - slippage) no longer sets the listed buy's minOut: minOut is the slippage off the listed route, and a 1 bp move still lands", async () => {
  const token = "0x00000000000000000000000000000000000d1d06";
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const hz: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, RH(10)), give: (a) => (a * 102n) / 100n, lie: (a) => (a * 10000n) / 9900n, state: pricedAt(2n), exec: () => null };
  const logs = [{ key: market.key, at: 4_500_000 }, { key: hz.key, at: 4_500_001 }];
  const q = await hbQuote([market, hz], token, logs, marketRoute(token));
  assert.ok(!("code" in q), show(q));
  assert.deepEqual({ out: q.amountOut, min: q.minOut, hooked: q.hooked }, { out: AMOUNT, min: (AMOUNT * 9900n) / 10000n, hooked: [] }, show(q));
  const moved = [{ ...market, exec: (a: bigint) => a - a / 10000n }, hz];
  assert.equal(SALES.get(await landBuy(moved, q))!.bought, true);
});

test("review of 72e28658, M2 (sell) the same on a sale: a hooked reference at the pick / (1 - slippage), which W's sim honours, no longer sets the listed pick's minOut", async () => {
  const token = "0x00000000000000000000000000000000000d1d16";
  const near: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => 2n * a - (2n * a) / 200n, state: pricedInto1(2n) };
  const placed = (a: bigint) => ((2n * a - (2n * a) / 200n) * 10000n) / 9900n;
  const hz: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, RH(17)), give: (a) => (21n * a) / 10n, lie: placed, state: pricedInto1(3n), exec: (a, ctx) => (later(ctx) ? null : placed(a)) };
  const q = await hcQuote([near, hz], token, [{ key: near.key, at: 4_500_000 }, { key: hz.key, at: 4_500_001 }]);
  assert.ok(!("code" in q) && q.hooked.length === 0, show(q));
  assert.equal(q.minOut, ((2n * AMOUNT - (2n * AMOUNT) / 200n) * 9900n) / 10000n, show(q));
});

test("review of 72e28658, M3 (buy) a buy runs at its own gas, which only main's pool bounds: below its floor it reverts SwapGasTooLow and bans nothing; above it, an honest hook a hostile sender gave too little swap gas is banned, a ban that expires (the helper sends a buy only after its eth_call at that gas answers true; review of a2d82dc6, F1)", async () => {
  const token = "0x00000000000000000000000000000000000d1d0b";
  // an honest hook whose work needs 600,000 of the swap's gas: the model's buy (BUY_GAS) gives the swap 650,000
  const honest: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, RH(11)), give: (a) => a, lie: (a) => (a * 95n) / 100n, exec: (a, ctx) => (ctx.gas < 600_000n ? null : (a * 95n) / 100n) };
  const pools = [seeded(token), honest];
  const q = await hbQuote(pools, token, [{ key: honest.key, at: 4_500_001 }], v4Route([{ currency: token, fee: 3000, tickSpacing: 60, hooks: RH(11) }]));
  assert.ok(!("code" in q), show(q));
  assert.equal(SALES.get(await landBuy(pools, q))!.bought, true, "at the helper's gas the buy lands");
  // below the pool's floor (the release and BUY_SWAP_GAS + BUY_FAIL_GAS + 1,000) the buy reverts: no evidence
  const low = await landBuy(pools, q, HEAD_NO + 1, { gas: BUY_RELEASE_GAS + BUY_SWAP_GAS + BUY_FAIL_GAS });
  assert.equal(SALES.get(low)!.status, "0x0", "SwapGasTooLow");
  assert.deepEqual(await buyProved(pools, q, low), []);
  // above the floor with too little for the hook: the swap fails, its replay at the same gas fails, the no-op's succeeds
  const thin = await landBuy(pools, q, HEAD_NO + 1, { gas: 1_300_000n });
  assert.deepEqual({ status: SALES.get(thin)!.status, bought: SALES.get(thin)!.bought }, { status: "0x1", bought: false });
  assert.deepEqual(await buyProved(pools, q, thin), [hcPid(honest.key)]);
});

test("review of 72e28658, M3 (sell) a sale is evidence only at the gas the device pins and its sim ran at (EVM_POOL_SELL_GAS): one sent with less, whose honest hook ran out, bans nothing (review of a2d82dc6, F1)", async () => {
  const token = "0x00000000000000000000000000000000000d1d1b";
  // an honest hook whose work needs 900,000: the device's sim at EVM_POOL_SELL_GAS less the authorization passes it
  const honest: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, RH(18)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (ctx.gas < 900_000n ? null : 2n * a) };
  const pools = [seeded(token), honest];
  const q = await hcQuote(pools, token, [{ key: honest.key, at: 4_500_001 }]);
  assert.ok(!("code" in q) && q.hooked.length === 1, show(q));
  assert.equal(SALES.get(await land(pools, q))!.status, "0x1", "at the pinned gas the sale lands");
  const short = await land(pools, q, HEAD_NO + 1, { gas: 800_000n });
  assert.equal(SALES.get(short)!.status, "0x0");
  assert.deepEqual(await proved(pools, q, short), []);
  // more gas than the pin is no sale the device's fee rule sends either
  const hostile: ModelPool = { ...honest, exec: (a, ctx) => (later(ctx) ? null : 2n * a) };
  const hp = [seeded(token), hostile];
  const hq = await hcQuote(hp, token, [{ key: hostile.key, at: 4_500_001 }]);
  assert.ok(!("code" in hq), show(hq));
  assert.deepEqual(await proved(hp, hq, await land(hp, hq, HEAD_NO + 1, { gas: 1_200_000n })), []);
  assert.deepEqual(await proved(hp, hq, await land(hp, hq)), [hcPid(hostile.key)], "control: at the pinned gas");
});

test("review of 72e28658, L2 (RV4) one hostile hook, one with a visible 5% fee and an honest anti-whale hook on the last hop: the hostile hook alone rescues the buy, so a set holding it is never asked and the capped hook is never banned", async () => {
  const [t2, y, x] = ["0x00000000000000000000000000000000000d1d09", xAt(0x9b8), xAt(0x9b9)];
  const CAP = (AMOUNT * 97n) / 100n;
  const capped = (a: bigint) => (a <= CAP ? a : null);
  const h1: ModelPool = { key: keyOf(y, NATIVE, 3000, 60, RH(12)), give: (a) => a, lie: (a) => (a * 90n) / 100n, exec: (a, ctx) => (later(ctx) ? null : (a * 90n) / 100n) };
  // the 5% pool takes its fee with its hook replaced too, so no read of the route trips the honest cap (a read that
  // does refuses the route: review of a2d82dc6, F2)
  const fee: ModelPool = { key: keyOf(x, y, 3000, 60, RH(13)), give: (a) => (a * 95n) / 100n, lie: (a) => (a * 95n) / 100n };
  const hc: ModelPool = { key: keyOf(t2, x, 3000, 60, RH(19)), give: (a) => a, lie: capped, exec: (a) => capped(a) };
  const pools = [seeded(t2), h1, fee, hc];
  const route = v4Route([{ currency: y, fee: 3000, tickSpacing: 60, hooks: RH(12) }, { currency: x, fee: 3000, tickSpacing: 60, hooks: RH(13) }, { currency: t2, fee: 3000, tickSpacing: 60, hooks: RH(19) }]);
  const q = await hbQuote(pools, t2, [], route);
  assert.ok(!("code" in q), show(q));
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q)), [hcPid(h1.key)]);
});

test("review of 72e28658, L2 (PC) a sale whose `bought` route passes the native asset in its middle, which the sell builder takes under no hook rule, is not read: the sale leaves through the seeded pool", async () => {
  const token = "0x00000000000000000000000000000000000d1d0a";
  const x = xAt(0x9ba);
  const a: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, NATIVE), give: (v) => v };
  const t: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, RH(20)), give: (v) => v, lie: (v) => v };
  const pools = [seeded(token), a, t];
  const bought = v4Route([{ currency: x, fee: 3000, tickSpacing: 60, hooks: NATIVE }, { currency: NATIVE, fee: 3000, tickSpacing: 60, hooks: NATIVE }, { currency: token, fee: 3000, tickSpacing: 60, hooks: RH(20) }]);
  const sale = await evmPoolSellQuoteWith({ chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought, boughtBlock: 1n, sent: [], signSim } as EvmPoolSellQuoteRequest, [chain(pools, 0), chain(pools, 1)], NOW, scanner(5_000_000, []), DELEGATED).then((q) => ({ out: q.amountOut }), (e) => ({ code: (e as EvmQuoteError).code }));
  assert.deepEqual(sale, { out: AMOUNT / 10n });
});

test("review of 72e28658, the pool's event topics the kit holds as literals are Withdrawn's and Bought's", () => {
  const src = readFileSync(new URL("../src/checks/evm/quote.ts", import.meta.url), "utf8");
  assert.ok(src.includes(`const TOPIC_WITHDRAWN = "${TOPIC_WITHDRAWN_T}";`) && src.includes(`const TOPIC_BOUGHT = "${TOPIC_BOUGHT_T}";`));
});

// ------------------------------------------------------------------------------------- review of a2d82dc6
// F1 the replay runs at the trade's own gas with no balance override, so a hook keyed on its gas or the sender's balance
// sees the real trade's; F2 a read with only some unlisted hooks replaced that reverts or answers 0 refuses the route;
// L3 a sender that takes a bigger fee, so the pool swaps less than the quote's amount, bans nothing.
const PH = (n: number) => "0x" + (0x7a1e00 + n).toString(16).padStart(40, "0");
/** Each eth_call `rpc` is asked that carries a block override and the trade's gas (a replay; the quoter's read on the
 *  replay's basis carries no gas), as its gas and its overridden accounts. */
const replaysOf = (rpc: EvmRpc, seen: { gas: bigint; over: string[] }[]): EvmRpc => async (calls) => {
  for (const c of calls) if (c.method === "eth_call" && c.params[3] !== undefined && c.params[4] === undefined && (c.params[0] as { gas?: string }).gas !== undefined) seen.push({ gas: BigInt((c.params[0] as { gas: string }).gas), over: Object.keys((c.params[2] ?? {}) as object).map((k) => k.toLowerCase()) });
  return rpc(calls);
};

test("review of a2d82dc6, F1 (buy) a hook that fails the real buy at a later block only below 1,000,000 of the swap's gas: the replay runs at the buy's own gas, never the sender's balance overridden, so one failed try bans its pool, then the market", async () => {
  const token = "0x00000000000000000000000000000000000e1e01";
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(1)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec: (a, ctx) => (later(ctx) && ctx.gas < 1_000_000n ? null : 2n * a) };
  const pools = [market, hostile];
  const logs = [{ key: market.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }];
  const r = await hbConverge(pools, token, logs, marketRoute(token), 6);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT, banned: [hcPid(hostile.key)] }, show(r));
  // each replay: the buy's own gas (no authorizations), and no account overridden but a no-op's hooks
  const q = await hbQuote(pools, token, logs, marketRoute(token));
  const q2 = "code" in q && q.reference !== null ? await hbQuote(pools, token, logs, q.reference.route) : q;
  assert.ok(!("code" in q2) && q2.hooked.length === 1, show(q2));
  const seen: { gas: bigint; over: string[] }[] = [];
  const hash = await landBuy(pools, q2);
  assert.deepEqual(await buyProved(pools, q2, hash, [replaysOf(chain(pools, 0), seen), replaysOf(chain(pools, 1), seen)]), [hcPid(hostile.key)]);
  assert.ok(seen.length >= 4, show(seen));
  for (const x of seen) {
    assert.equal(x.gas, BUY_GAS, "the buy's own gas");
    assert.ok(!x.over.includes(SENDER) && x.over.every((k) => k === PH(1) || SYS.includes(k)), show(x));
  }
  // a sender that holds only its own gas at its fees: the replay runs as the buy did
  const thin = { [SENDER]: BUY_GAS * (BASE_FEE + 1_000_000n) };
  assert.deepEqual(await buyProved(pools, q2, hash, [chain(pools, 0, undefined, undefined, thin), chain(pools, 1, undefined, undefined, thin)]), [hcPid(hostile.key)]);
});

test("review of a2d82dc6, F1 (sell) the same hook on a sale, below 2,000,000 of its gas: the replay runs at the sale's own gas less its authorization, only W's code overridden, so one failed try bans its pool", async () => {
  const token = "0x00000000000000000000000000000000000e1e02";
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(2)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (later(ctx) && ctx.gas < 2_000_000n ? null : 2n * a) };
  const pools = [seeded(token), hostile];
  const r = await hcConverge(pools, token, [{ key: hostile.key, at: 4_500_001 }], 6);
  assert.deepEqual({ failed: r.failed, banned: r.banned }, { failed: 1, banned: [hcPid(hostile.key)] }, show(r));
  const q = await hcQuote(pools, token, [{ key: hostile.key, at: 4_500_001 }]);
  assert.ok(!("code" in q) && q.hooked.length === 1, show(q));
  const seen: { gas: bigint; over: string[] }[] = [];
  assert.deepEqual(await proved(pools, q, await land(pools, q), [replaysOf(chain(pools, 0), seen), replaysOf(chain(pools, 1), seen)]), [hcPid(hostile.key)]);
  assert.ok(seen.length >= 4, show(seen));
  for (const x of seen) {
    assert.equal(x.gas, SALE_GAS - 25_000n, "the sale's own gas less its authorization");
    assert.ok(!x.over.includes(SENDER) && x.over.every((k) => k === SELL_W || k === PH(2) || SYS.includes(k)), show(x));
  }
});

test("review of a2d82dc6, F3 the fold's own M3 (sell) hook (it fails a sale at a later block below 990,000 gas) is a hostile hook keyed on the block: the device's sale loop converges after one failed try, its pool banned", async () => {
  const token = "0x00000000000000000000000000000000000e1e04";
  const h: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(5)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a, ctx) => (later(ctx) && ctx.gas < 990_000n ? null : 2n * a) };
  const r = await hcConverge([seeded(token), h], token, [{ key: h.key, at: 4_500_001 }], 6);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT / 10n, banned: [hcPid(h.key)] }, show(r));
});

test("review of a2d82dc6, F2 a hostile hook (quotes 95%, pays 90% at a later block) upstream of an honest hook capped at 97%: the read with the hostile hook alone replaced trips the cap, so the route is refused no_quote, never bought, and the honest capped pool is never banned", async () => {
  const [token, y] = ["0x00000000000000000000000000000000000e1e03", xAt(0xe13)];
  const CAP = (AMOUNT * 97n) / 100n;
  const capped = (a: bigint) => (a <= CAP ? a : null);
  const B: ModelPool = { key: keyOf(y, NATIVE, 3000, 60, PH(3)), give: (a) => a, lie: (a) => (a * 95n) / 100n, exec: (a, ctx) => (later(ctx) ? (a * 90n) / 100n : (a * 95n) / 100n) };
  const A: ModelPool = { key: keyOf(token, y, 3000, 60, PH(4)), give: (a) => a, lie: capped, exec: (a) => capped(a) };
  const pools = [seeded(token), B, A];
  const route = v4Route([{ currency: y, fee: 3000, tickSpacing: 60, hooks: PH(3) }, { currency: token, fee: 3000, tickSpacing: 60, hooks: PH(4) }]);
  const q = await hbQuote(pools, token, [], route);
  assert.equal("code" in q ? q.code : show(q), "no_quote");
  // the device's loop never buys through it: it stops at that first no_quote, nothing bought, no failed try and nothing banned
  const r = await hbConverge(pools, token, [], route, 4);
  assert.deepEqual({ failed: r.failed, code: r.code, banned: r.banned }, { failed: 0, code: "no_quote", banned: [] }, show(r));
});

test("review of a2d82dc6, F2 (sell) the same two hooks on a sale the scan finds (the hostile hook on the token's pool, the honest cap on X's market): the route counts for nothing, so the sale leaves through the seeded pool with no failed try and nothing banned", async () => {
  const [token, x] = ["0x00000000000000000000000000000000000e1e06", xAt(0xe16)];
  const CAP = (AMOUNT * 97n) / 100n;
  const capped = (a: bigint) => (a <= CAP ? a : null);
  const B: ModelPool = { key: keyOf(token, x, 3000, 60, PH(7)), give: (a) => a, lie: (a) => (a * 95n) / 100n, exec: (a, ctx) => (later(ctx) ? (a * 90n) / 100n : (a * 95n) / 100n) };
  const A: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, PH(8)), give: (a) => a, lie: capped, exec: (a) => capped(a) };
  const logs = [{ key: B.key, at: 4_500_000 }, { key: A.key, at: 4_100_001 }];
  const r = await hcConverge([seeded(token), B, A], token, logs, 4);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 0, got: AMOUNT / 10n, banned: [] }, show(r));
});

test("review of a2d82dc6, L3 a sender that takes a bigger fee than the proof's withdrawn value leaves, so the pool swaps less than the quote's amount and the buy misses minOut, bans nothing (an honest 5% fee hook whose no-op would make up the gap)", async () => {
  const token = "0x00000000000000000000000000000000000e1e05";
  const fee: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(6)), give: (a) => a, lie: (a) => (a * 95n) / 100n };
  const pools = [seeded(token), fee];
  const q = await hbQuote(pools, token, [{ key: fee.key, at: 4_500_001 }], v4Route([{ currency: token, fee: 3000, tickSpacing: 60, hooks: PH(6) }]));
  assert.ok(!("code" in q) && q.hooked.length === 1, show(q));
  const hash = await landBuy(pools, q, HEAD_NO + 1, {}, { feeWord: BUY_FEE + (AMOUNT * 2n) / 100n });
  assert.equal(SALES.get(hash)!.bought, false, "the pool swaps 98% of the amount: 93.1% out, under minOut");
  assert.deepEqual(await buyProved(pools, q, hash), []);
  // control: the quote's own fee lands
  assert.equal(SALES.get(await landBuy(pools, q))!.bought, true);
});

// ------------------------------------------------------------------------------------- review of da11bbb6
// H1 every replay sees the trade's block as the trade saw it: the storage its system calls wrote before its first
// transaction (L1Block, EIP-2935's history, EIP-4788's roots) read at the block on two providers that agree, passed as
// stateDiff, and its header's base fee and PREVRANDAO in the block override; a hook keyed on any of them is banned.
const TELLS = [
  ["block.number - L1Block.sequenceNumber() marks a real block (the epoch's first)", "seq"],
  ["EIP-2935's hash of the block before equals blockhash(block.number - 1)", "hist"],
  ["EIP-4788 answers a root at block.timestamp", "beacon"],
  ["BASEFEE is the trade block's", "baseFee"],
  ["PREVRANDAO is the trade block's", "randao"],
] as const;
/** A hostile hook that fails the trade only at a later, odd block where it sees `k` as the trade's block's: the helper's
 *  pending sim and the quote's reads pass, and the buy sent from an even block's sim lands on the odd one and fails. */
const tellHook = (k: keyof Sees) => (a: bigint, ctx: SimCtx) => (later(ctx) && ctx.sees?.[k] === true && ctx.block! % 2 === 1 ? null : 2n * a);
TELLS.forEach(([tell, k], i) => {
  test(`review of da11bbb6, H1 (buy) a hook that fails the real buy only where ${tell} and the block is odd: the replay sees the trade's block, so one failed try bans its pool, then the market`, async () => {
    const token = "0x" + (0xda11b00 + i).toString(16).padStart(40, "0");
    const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
    const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0x40 + i)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec: tellHook(k) };
    const r = await hbConverge([market, hostile], token, [{ key: market.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }], marketRoute(token), 6);
    assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT, banned: [hcPid(hostile.key)] }, show(r));
  });
  test(`review of da11bbb6, H1 (sell) the same hook on a sale, where ${tell}: one failed try bans its pool`, async () => {
    const token = "0x" + (0xda11c00 + i).toString(16).padStart(40, "0");
    const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0x50 + i)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: tellHook(k) };
    const r = await hcConverge([seeded(token), hostile], token, [{ key: hostile.key, at: 4_500_001 }], 6);
    assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT / 10n, banned: [hcPid(hostile.key)] }, show(r));
  });
});

test("review of da11bbb6, H1 the system slots are read at the trade's block on two providers that must agree word for word: one provider's L1Block word apart bans nothing", async () => {
  const token = "0x000000000000000000000000000000000da11d01";
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0x60)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec: tellHook("seq") };
  const pools = [market, hostile];
  const logs = [{ key: market.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }];
  const q = await hbQuote(pools, token, logs, marketRoute(token));
  const q2 = "code" in q && q.reference !== null ? await hbQuote(pools, token, logs, q.reference.route) : q;
  assert.ok(!("code" in q2) && q2.hooked.length === 1, show(q2));
  const hash = await landBuy(pools, q2);
  // the reads: each at the sale's own block hash, the same slots on both providers
  const asked: string[] = [];
  const watch = (rpc: EvmRpc): EvmRpc => async (calls) => {
    for (const c of calls) if (c.method === "eth_getStorageAt") asked.push(`${String(c.params[0]).toLowerCase()}:${BigInt(String(c.params[1]))}@${(c.params[2] as { blockHash: string }).blockHash}`);
    return rpc(calls);
  };
  assert.deepEqual(await buyProved(pools, q2, hash, [watch(chain(pools, 0)), watch(chain(pools, 1))]), [hcPid(hostile.key)]);
  const at = SALES.get(hash)!.blockHash;
  const ts = BigInt(SALE_TIME);
  const want = [...Array.from({ length: 16 }, (_, s) => `${L1B}:${s}@${at}`), `${BEACON}:${ts % 8191n}@${at}`, `${BEACON}:${(ts % 8191n) + 8191n}@${at}`, `${HIST}:${BigInt(HEAD_NO) % 8191n}@${at}`];
  assert.deepEqual(asked, [...want, ...want]);
  // provider 2 answers L1Block's sequenceNumber one apart: the providers disagree, nothing is banned
  const apart = (rpc: EvmRpc): EvmRpc => async (calls) => (await rpc(calls)).map((a, i) => (calls[i]!.method === "eth_getStorageAt" && String(calls[i]!.params[0]).toLowerCase() === L1B && BigInt(String(calls[i]!.params[1])) === 3n ? { ...(a as object), result: "0x" + W(BigInt(SALE_TIME)) } : a));
  assert.deepEqual(await buyProved(pools, q2, hash, [chain(pools, 0), apart(chain(pools, 1))]), []);
});

test("review of da11bbb6, H1 evmSystemSlotsOf: Base's L1Block slots 0-15, EIP-4788's two slots at the block's time and EIP-2935's at N-1 in a ring of 8191; Robinhood's EIP-2935 alone, its ring 393,168", () => {
  const sixteen = Array.from({ length: 16 }, (_, i) => BigInt(i));
  const base = [[L1B, sixteen], [BEACON, [1_000_000n % 8191n, (1_000_000n % 8191n) + 8191n]], [HIST, [(54_336_922n - 1n) % 8191n]]];
  assert.deepEqual(quoteMod.evmSystemSlotsOf("base", 54_336_922n, 1_000_000n), base);
  assert.deepEqual(quoteMod.evmSystemSlotsOf("base-sepolia", 54_336_922n, 1_000_000n), base);
  for (const c of ["robinhood", "robinhood-testnet"] as const) assert.deepEqual(quoteMod.evmSystemSlotsOf(c, 108_449_728n, 1_000_000n), [[HIST, [(108_449_728n - 1n) % 393168n]]]);
});

test("review of da11bbb6, L2 (sell) a proper set's read that answers 0 rather than reverting counts the route for nothing: with no other route the sale is refused no_quote as no route fills, no reference named, never a route valued 0 carried on to its minimum", async () => {
  const [token, x] = ["0x000000000000000000000000000000000da11e01", xAt(0xda1)];
  // the honest hook answers 0 (no revert) for the whole amount and twice it, which reach it only where the hostile hook
  // upstream (it quotes 95%, pays 90% at a later block) is replaced alone; as it is, the route fills at 95%
  const capped = (a: bigint) => (a === AMOUNT || a === 2n * AMOUNT ? 0n : a);
  const B: ModelPool = { key: keyOf(token, x, 3000, 60, PH(0x70)), give: (a) => a, lie: (a) => (a * 95n) / 100n, exec: (a, ctx) => (later(ctx) ? (a * 90n) / 100n : (a * 95n) / 100n) };
  const A: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, PH(0x71)), give: (a) => a, lie: capped, exec: (a) => capped(a) };
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, sent: [], signSim } as EvmPoolSellQuoteRequest;
  const got = await evmPoolSellQuoteWith(req, [chain([B, A], 0), chain([B, A], 1)], NOW, scanner(5_000_000, [{ key: B.key, at: 4_500_000 }, { key: A.key, at: 4_100_001 }]), DELEGATED).then(
    (q) => ({ out: q.amountOut }),
    (e) => ({ code: (e as EvmQuoteError).code, message: (e as EvmQuoteError).message, reference: (e as { reference?: unknown }).reference ?? null }),
  );
  assert.deepEqual(got, { code: "no_quote", message: "no_quote: no pool the sell can leave through fills it", reference: null });
});

test("review of da11bbb6, L1 a trade whose receipt names poster gas (Nitro's gasUsedForL1 above 0) bans nothing, buy or sale: whether the replay is charged the same is unread; at 0, as every Robinhood receipt reads today, the same hook is banned", async () => {
  const token = "0x000000000000000000000000000000000da11f01";
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0x80)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec: tellHook("seq") };
  const pools = [market, hostile];
  const logs = [{ key: market.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }];
  const q = await hbQuote(pools, token, logs, marketRoute(token));
  const q2 = "code" in q && q.reference !== null ? await hbQuote(pools, token, logs, q.reference.route) : q;
  assert.ok(!("code" in q2) && q2.hooked.length === 1, show(q2));
  assert.deepEqual(await buyProved(pools, q2, await landBuy(pools, q2, HEAD_NO + 1, { l1Gas: 0n })), [hcPid(hostile.key)]);
  assert.deepEqual(await buyProved(pools, q2, await landBuy(pools, q2, HEAD_NO + 1, { l1Gas: 1n })), []);
  const sToken = "0x000000000000000000000000000000000da11f02";
  const sh: ModelPool = { key: keyOf(sToken, NATIVE, 3000, 60, PH(0x81)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: tellHook("seq") };
  const sq = await hcQuote([seeded(sToken), sh], sToken, [{ key: sh.key, at: 4_500_001 }]);
  assert.ok(!("code" in sq) && sq.hooked.length === 1, show(sq));
  assert.deepEqual(await proved([seeded(sToken), sh], sq, await land([seeded(sToken), sh], sq, HEAD_NO + 1, { l1Gas: 0n })), [hcPid(sh.key)]);
  assert.deepEqual(await proved([seeded(sToken), sh], sq, await land([seeded(sToken), sh], sq, HEAD_NO + 1, { l1Gas: 70_000n })), []);
});

// ------------------------------------------------------------------------------------- review of ca907a05
// HIGH 1 on Robinhood the replay misses ArbOS's block-start writes: the gas-pricing backlog's decay (about 1 block in 10)
// and the L1 block number (about 1 in 120), pinned open here until card evm-sell-hook-intrablock replays at the trade's
// true pre-state; LOW 1 the model refuses a stateDiff key or value that is not 0x and 64 hex digits, as the live
// providers do; LOW 2 the replay's tells on a Robinhood venue and on base-sepolia.
// Read at block 108,479,667 on rpc.mainnet.chain.robinhood.com (review of ca907a05, probe-rh-backlog.log): the parent
// left the backlog at 8,420,860, the block's start decayed it to 28,223 over its time step, and the block's base fee was
// 20,184,000, the pre-decay price (the floor 20,000,000).
const [RH_PARENT_BACKLOG, RH_START_BACKLOG] = [8_420_860n, 28_223n];
/** The backlog a call reads through ArbGasInfo: the block start's where it sees it, else the parent's. */
const backlogOf = (ctx: SimCtx) => (ctx.sees?.backlog === true ? RH_START_BACKLOG : RH_PARENT_BACKLOG);
/** A hostile hook that fails the trade only where BASEFEE is the trade block's (its header's 20,184,000, at or above
 *  20,080,000) and the backlog is below 3,000,000: the price says the backlog was high, the backlog says it decayed. */
const backlogHook = (a: bigint, ctx: SimCtx) => (later(ctx) && ctx.sees?.baseFee === true && backlogOf(ctx) < 3_000_000n ? null : 2n * a);

test("review of ca907a05, HIGH 1 (buy, Robinhood) a hook that fails the real buy only where BASEFEE is the trade block's pre-decay price and ArbOS's gas backlog is below 3,000,000, as the block start's decay left it: no replay carries ArbOS's state (Nitro refuses its override), but the hook's frame errored in the buy's own trace on dRPC and Pocket, so one failed try bans its pool, then the market (card evm-sell-hook-intrablock)", async () => {
  const token = "0x000000000000000000000000000000000ca90a01";
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0x90)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec: backlogHook };
  const logs = [{ key: market.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }];
  const r = await hbConverge([market, hostile], token, logs, marketRoute(token), 6, HEAD_NO + 1, RH_NET);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT, banned: [hcPid(hostile.key)] }, show(r));
});

test("review of ca907a05, LOW 2 (buy, Robinhood) a hook that fails the real buy only at an odd block where it sees EIP-2935's hash of the block before (the ring of 393,168), BASEFEE or PREVRANDAO as the trade's block's: the replay sees each as the trade did (PREVRANDAO left as Nitro's constant), so one failed try bans its pool, then the market", async () => {
  for (const [i, k] of (["hist", "baseFee", "randao"] as const).entries()) {
    const token = "0x" + (0xca90b00 + i).toString(16).padStart(40, "0");
    const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
    // it fails the buy by a fee through a delta: no frame of the trade errors, so the trace's as-is leg holds nothing and
    // the replay alone tells (card evm-sell-hook-intrablock)
    const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0xa0 + i)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec: tellHook(k), deltaFee: true };
    const r = await hbConverge([market, hostile], token, [{ key: market.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }], marketRoute(token), 6, HEAD_NO + 1, RH_NET);
    assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT, banned: [hcPid(hostile.key)] }, `${k}: ${show(r)}`);
  }
});

test("review of ca907a05, LOW 2 (buy, base-sepolia) a hook that fails the real buy only at an odd block where it sees PREVRANDAO or L1Block's sequenceNumber as the trade's block's: the replay sets both on Base Sepolia as on Base, so one failed try bans its pool, then the market", async () => {
  for (const [i, k] of (["randao", "seq"] as const).entries()) {
    const token = "0x" + (0xca90c00 + i).toString(16).padStart(40, "0");
    const hooks = PH(0xb0 + i);
    const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
    const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, hooks), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec: tellHook(k) };
    // Base Sepolia's venue has no scan: the buy is asked the hostile route, and the market, a standard pool, is its reference
    const r = await hbConverge([market, hostile], token, [], v4Route([{ currency: token, fee: 3000, tickSpacing: 60, hooks }]), 6, HEAD_NO + 1, BS_NET);
    assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT, banned: [hcPid(hostile.key)] }, `${k}: ${show(r)}`);
  }
});

test("review of ca907a05, LOW 1 the model refuses an eth_call whose stateDiff key or value is not 0x and 64 hex digits (-32602), as base-rpc.publicnode.com, mainnet.base.org and rpc.mainnet.chain.robinhood.com refuse the key 0x1; a padded key and value are taken", async () => {
  const at = (diff: Record<string, string>) => chain([], 0)([{ method: "eth_call", params: [{ to: NATIVE, data: "0xf1c7a58b" }, "latest", { [HIST]: { stateDiff: diff } }] }]).then((a) => (a[0] as { error?: { code: number } }).error?.code ?? "taken");
  const padded = "0x" + W(1n);
  assert.equal(await at({ [padded]: padded }), "taken");
  for (const bad of [{ "0x1": padded }, { [padded]: "0x1" }, { [padded.slice(2)]: padded }, { [padded]: padded + "00" }]) assert.equal(await at(bad), -32602, show(bad));
});

// ------------------------------------------------------------------------------------- card evm-sell-hook-intrablock
// On Robinhood the evidence reads the reverted trade's own trace on dRPC and Pocket (venue traceProviders): its
// prestate, every account but ArbOS's state, is the replay's state override, so a hook flipped by an earlier transaction
// of the block (HC2) fails the replay as it failed the trade; and a frame of the trade into an unlisted hook of the
// route that errored there holds the as-is leg where no replay can tell (ArbOS's backlog and L1 block number). Any
// disagreement or failed trace bans nothing.
const ihBuy = async (exec: NonNullable<ModelPool["exec"]>, n: number, extra: Partial<ModelPool> = {}) => {
  const token = "0x" + (0x1ae0000 + n).toString(16).padStart(40, "0");
  const market: ModelPool = { key: keyOf(token, NATIVE, 500, 10, NATIVE), give: (a) => a };
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0xc0 + n)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedAt(2n), exec, ...extra };
  const pools = [market, hostile];
  const logs = [{ key: market.key, at: 4_500_000 }, { key: hostile.key, at: 4_500_001 }];
  const q = await hbQuote(pools, token, logs, marketRoute(token), undefined, RH_NET);
  const q2 = "code" in q && q.reference !== null ? await hbQuote(pools, token, logs, q.reference.route, undefined, RH_NET) : q;
  assert.ok(!("code" in q2) && q2.hooked.length === 1, show(q2));
  return { pools, token, logs, hostile, q: q2 };
};
const rhTrace = (pools: ModelPool[]) => [chain(pools, 0, undefined, undefined, undefined, true), chain(pools, 1, undefined, undefined, undefined, true)];
/** A hostile hook flipped by an earlier transaction of the trade's own block: it fails a real trade where it sees the
 *  state that transaction wrote (EARLIER), and nothing else. Its pools here fail the trade by a fee through a delta
 *  (EARLY), so no frame of the trade errors: the replay at the traced pre-state alone can ban them, which the parent
 *  replay never does (review of 29498693's sweep: with an errored frame the as-is leg banned them however the override
 *  was built). */
const earlierHook = (a: bigint, ctx: SimCtx) => (later(ctx) && ctx.sees?.earlier === true ? null : 2n * a);
const EARLY = { deltaFee: true } as const;

test("card evm-sell-hook-intrablock, HC2 (buy, Robinhood) a hook flipped by a transaction earlier in the buy's own block: the replay at the buy's traced pre-state sees that transaction's write and fails as the buy did, so one failed try bans its pool, then the market", async () => {
  const { pools, token, logs, hostile } = await ihBuy(earlierHook, 1, EARLY);
  const r = await hbConverge(pools, token, logs, marketRoute(token), 6, HEAD_NO + 1, RH_NET);
  assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT, banned: [hcPid(hostile.key)] }, show(r));
});

test("card evm-sell-hook-intrablock, HC2 (buy, Robinhood) the replay's override is the trace's prestate with ArbOS's state left out (Nitro refuses it), the sender's balance its own; on Base, with no trace pair, nothing is traced", async () => {
  const { pools, q, hostile } = await ihBuy(earlierHook, 2, EARLY);
  const hash = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  const seen: string[][] = [];
  const traced: string[] = [];
  const watch = (rpc: EvmRpc): EvmRpc => async (calls) => {
    for (const c of calls) {
      if (c.method === "eth_call" && c.params[3] !== undefined) seen.push(Object.keys((c.params[2] ?? {}) as object).map((k) => k.toLowerCase()));
      if (c.method === "debug_traceTransaction") traced.push((c.params[1] as { tracer: string }).tracer);
    }
    return rpc(calls);
  };
  assert.deepEqual(await buyProved(pools, q, hash, [watch(chain(pools, 0, undefined, undefined, undefined, true)), watch(chain(pools, 1, undefined, undefined, undefined, true))], RH_NET), [hcPid(hostile.key)]);
  assert.ok(seen.length >= 4 && seen.every((o) => o.includes(EARLIER) && o.includes(SENDER) && !o.includes(ARBOS)), show(seen));
  // the trace is read on the trace pair alone, each tracer once on each, each its own request, the prestate with no code
  const once: string[] = [];
  const count = (rpc: EvmRpc): EvmRpc => async (calls) => {
    if (calls.some((c) => c.method === "debug_traceTransaction")) once.push(calls.map((c) => JSON.stringify(c.params[1])).join("+"));
    return rpc(calls);
  };
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, hash, [watch(chain(pools, 0, undefined, undefined, undefined, true)), watch(chain(pools, 1, undefined, undefined, undefined, true))], RH_NET.venues, rhTrace(pools).map(count)), [hcPid(hostile.key)]);
  assert.deepEqual(once.sort(), [...Array(2).fill('{"tracer":"callTracer"}'), ...Array(2).fill('{"tracer":"prestateTracer","tracerConfig":{"disableCode":true}}')]);
  assert.deepEqual(traced, [], "the quote providers are never asked for a trace");
});

test("card evm-sell-hook-intrablock, the as-is leg: an errored frame into the route's own unlisted hook, read from the trace, holds it where the replay passes; a hook that fails the trade by a fee through a delta (no errored frame), keyed on ArbOS's backlog, stays open: nothing is banned; an errored frame into an address off the route counts for nothing", async () => {
  // the open case: an ArbOS-keyed hook that takes a fee through a delta in place of reverting
  const open = await ihBuy(backlogHook, 3, { deltaFee: true });
  const r = await hbConverge(open.pools, open.token, open.logs, marketRoute(open.token), 3, HEAD_NO + 1, RH_NET);
  assert.deepEqual({ failed: r.failed, code: r.code, banned: r.banned }, { failed: 2, code: "no_convergence", banned: [] }, show(r));
  // the same buy, its trace naming an errored frame into another hook (off the route) or into the route's own
  const h = await landBuy(open.pools, open.q, HEAD_NO + 1, { trace: { erroredToo: [PH(0xee)] } }, {}, RH_NET);
  assert.deepEqual(await buyProved(open.pools, open.q, h, undefined, RH_NET), []);
  const own = await landBuy(open.pools, open.q, HEAD_NO + 1, { trace: { erroredToo: [open.hostile.key.hooks] } }, {}, RH_NET);
  assert.deepEqual(await buyProved(open.pools, open.q, own, undefined, RH_NET), [hcPid(open.hostile.key)]);
});

test("card evm-sell-hook-intrablock, a trace that is not two companies' word for the trade adds nothing, so the evidence runs at the parent block (a hook flipped by an earlier transaction goes unbanned): one provider's prestate apart, its root frame another call (from, to, input or value), or past the bounds the trade's gas sets (accounts, slots, ArbOS's slots, frames); the receipt's index not the transaction's bans nothing", async () => {
  const { pools, q, hostile } = await ihBuy(earlierHook, 4, EARLY);
  const at = (t: Partial<ModelSale>) => landBuy(pools, q, HEAD_NO + 1, t, {}, RH_NET);
  // the buy's gas, 1,400,000, bounds its trace at 647 accounts and 800 slots besides ArbOS's state (the sender, EARLIER
  // and the PoolManager, with one slot each of the last two, are the model's own), 2,006 of ArbOS's slots (one the
  // model's) and 14,002 call frames (the root, the PoolManager's and 14,000 more); an account's code is never read
  // (disableCode)
  assert.deepEqual(await buyProved(pools, q, await at({ trace: { accounts: 644, slots: 798, arbosSlots: 2005, frames: 14_000, code: 24577 } }), undefined, RH_NET), [hcPid(hostile.key)], "at the bounds");
  for (const t of [{ apartOn: 1 as const }, { accounts: 645 }, { slots: 799 }, { arbosSlots: 2006 }, { frames: 14_001 }, { root: { input: "0x1234" } }, { root: { from: PH(0xef) } }, { root: { to: PH(0xef) } }, { root: { value: "0x1" } }]) assert.deepEqual(await buyProved(pools, q, await at({ trace: t }), undefined, RH_NET), [], show(t));
  assert.deepEqual(await buyProved(pools, q, await at({ rcIndex: "0x4" }), undefined, RH_NET), []);
});

// ------------------------------------------------------------------------------------- review of 29498693
// HIGH a trace that adds nothing (past its caps, a provider down) turned off the parent replay's evidence; MEDIUM the
// as-is leg on an errored frame banned every unlisted hook of the route, and counted a frame from any caller.
test("review of 29498693, HIGH (buy and sell, Robinhood) a hook that fails the real trade only where BASEFEE is the trade block's, which the replay at the parent block sees: its pool is banned with the trade's trace past its bounds, and with one trace provider down, as on a chain with no trace", async () => {
  const { pools, q, hostile } = await ihBuy(tellHook("baseFee"), 5);
  const big = await landBuy(pools, q, HEAD_NO + 1, { trace: { accounts: 646 } }, {}, RH_NET);
  assert.deepEqual(await buyProved(pools, q, big, undefined, RH_NET), [hcPid(hostile.key)], "past the cap");
  const down: EvmRpc = async () => { throw new Error("down"); };
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [rhTrace(pools)[0]!, down]), [hcPid(hostile.key)], "a trace provider down");
  const token = "0x000000000000000000000000000000000ae29901";
  const sh: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0xd8)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: tellHook("baseFee") };
  const sq = await hcQuote([seeded(token), sh], token, [{ key: sh.key, at: 4_500_001 }], undefined, RH_SALE);
  assert.ok(!("code" in sq) && sq.hooked.length === 1, show(sq));
  // a sale's gas, 1,000,000, bounds its trace at 480 accounts besides ArbOS's state
  assert.deepEqual(await proved([seeded(token), sh], sq, await land([seeded(token), sh], sq, HEAD_NO + 1, { trace: { accounts: 479 } }, (x) => x, RH_SALE), undefined, RH_SALE), [hcPid(sh.key)], "a sale past the cap");
});

test("review of 29498693, MEDIUM (buy, Robinhood) a route through an honest hook and one keyed on ArbOS's backlog: the replay passes, the trace names the hostile hook's frame errored, so its pool alone is banned, never the honest one; a frame into it the PoolManager did not call counts for nothing", async () => {
  const [token, x] = ["0x000000000000000000000000000000000ae29902", xAt(0x7f9)];
  const pools: ModelPool[] = [
    seeded(token),
    { key: keyOf(x, NATIVE, 3000, 60, N1_H1), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, state: pricedAt(2n) },
    { key: keyOf(token, x, 3000, 60, N1_H2), give: (a) => a, lie: (a) => a, exec: (a, ctx) => (later(ctx) && ctx.sees?.baseFee === true && backlogOf(ctx) < 3_000_000n ? null : a) },
  ];
  const logs = [{ key: pools[2]!.key, at: 4_500_000 }, { key: pools[1]!.key, at: 4_100_001 }];
  const q = await hbQuote(pools, token, logs, n1BuyRoute(token, x), undefined, RH_NET);
  assert.ok(!("code" in q) && q.hooked.length === 2, show(q));
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET), undefined, RH_NET), [hcPid(pools[2]!.key)], "the hostile pool alone");
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { trace: { erroredFrom: PH(0xef) } }, {}, RH_NET), undefined, RH_NET), [], "a frame another caller made");
});

// ------------------------------------------------------------------------------------- review of f0f983d2
// item 2 a caught frame never counts; item 3 the trace's bounds come from the trade's gas; item 4 a price an earlier
// transaction of the block moved is the market's; item 5a a trace no provider answered is asked again.
test("review of f0f983d2, item 2 (buy, Robinhood) a delta-fee hook keyed on ArbOS's backlog that calls the PoolManager into the route's honest unlisted hook and catches its revert: the honest hook's errored frame is under one that did not error, so nothing is banned; the route's hostile hook whose own frame errors on the unbroken chain still is", async () => {
  const [token, x] = ["0x000000000000000000000000000000000ae29a02", xAt(0x7fa)];
  const pools: ModelPool[] = [
    seeded(token),
    { key: keyOf(x, NATIVE, 3000, 60, N1_H1), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, state: pricedAt(2n) },
    { key: keyOf(token, x, 3000, 60, N1_H2), give: (a) => a, lie: (a) => a, deltaFee: true, exec: (a, ctx) => (later(ctx) && ctx.sees?.baseFee === true && backlogOf(ctx) < 3_000_000n ? null : a) },
  ];
  const logs = [{ key: pools[2]!.key, at: 4_500_000 }, { key: pools[1]!.key, at: 4_100_001 }];
  const q = await hbQuote(pools, token, logs, n1BuyRoute(token, x), undefined, RH_NET);
  assert.ok(!("code" in q) && q.hooked.length === 2, show(q));
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET), undefined, RH_NET), [], "no errored frame: the open delta-fee case");
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { trace: { caught: { by: N1_H2, into: [N1_H1] } } }, {}, RH_NET), undefined, RH_NET), [], "a revert the hostile hook caught");
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { trace: { erroredToo: [N1_H2] } }, {}, RH_NET), undefined, RH_NET), [hcPid(pools[2]!.key)], "the hostile hook's own frame errored");
  // the hostile hook's frame errored with the honest hook's under it: the outermost route hook alone is at fault
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { trace: { caught: { by: N1_H2, into: [N1_H1], errored: true } } }, {}, RH_NET), undefined, RH_NET), [hcPid(pools[2]!.key)], "the outermost hook");
  // the same two through the pinned v4 adapter, whose PoolManager frame is one the device's own swapper may make
  // (review of de4e3ed5, 3): the caught chain and the outermost hook still decide
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { trace: { caught: { by: N1_H2, into: [N1_H1], via: BUY_ADAPTER } } }, {}, RH_NET), undefined, RH_NET), [], "a revert the hostile hook caught, through the adapter");
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { trace: { caught: { by: N1_H2, into: [N1_H1], errored: true, via: BUY_ADAPTER } } }, {}, RH_NET), undefined, RH_NET), [hcPid(pools[2]!.key)], "the outermost hook, through the adapter");
});

test("review of f0f983d2, item 3 (buy, Robinhood) a hook that floods the trace with more accounts, slots and frames than the old fixed caps (256, 4,096, 4,096) but within what the buy's gas lets it touch: the trace is still evidence, and a hook flipped by an earlier transaction of the block is banned", async () => {
  const { pools, q, hostile } = await ihBuy(earlierHook, 6, EARLY);
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { trace: { accounts: 600, frames: 5000 } }, {}, RH_NET), undefined, RH_NET), [hcPid(hostile.key)]);
});

test("review of f0f983d2, item 4 (sell, Robinhood) an honest fee hook, the pool's price moved 2% by an earlier transaction of the sale's own block: the replay at the traced pre-state misses minOut, and so does the quoter read on that same basis (review of de4e3ed5, 1), so nothing is banned", async () => {
  for (const [i, trace] of [{ pmMoved: true as const }, { pmMoved: true as const, accounts: 479 }].entries()) {
    const token = "0x" + (0xae29b01 + i).toString(16).padStart(40, "0");
    const mv = (ctx: SimCtx | null | undefined, v: bigint) => (ctx && later(ctx) && ctx.sees?.earlier === true ? (v * 98n) / 100n : v);
    const fee: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0xd9 + i)), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, lieAt: (a, ctx) => mv(ctx, (2n * a * 95n) / 100n), state: pricedInto1(2n), exec: (a, ctx) => mv(ctx, (2n * a * 95n) / 100n), neutral: (a, ctx) => mv(ctx, 2n * a), deltaFee: true };
    const pools = [seeded(token), fee];
    const q = await hcQuote(pools, token, [{ key: fee.key, at: 4_500_001 }], undefined, RH_SALE);
    assert.ok(!("code" in q) && q.hooked.length === 1, show(q));
    const hash = await land(pools, q, HEAD_NO + 1, { trace }, (x) => x, RH_SALE);
    assert.equal(SALES.get(hash)!.status, "0x0", "the sale misses minOut and reverts");
    assert.deepEqual(await proved(pools, q, hash, undefined, RH_SALE), [], show(trace));
  }
});

test("review of f0f983d2, item 5a (buy, Robinhood) one trace provider that does not answer, where the replay at the parent block bans nothing: rpc_error, so the caller asks again, never an empty ban list", async () => {
  const { pools, q } = await ihBuy(earlierHook, 7, EARLY);
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  const down: EvmRpc = async () => { throw new Error("down"); };
  await assert.rejects(quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [rhTrace(pools)[0]!, down]), (e: unknown) => e instanceof EvmQuoteError && e.code === "rpc_error");
});

// ------------------------------------------------------------------------------------- review of de4e3ed5
// 1 the market is read on the replay's own basis; 2 the trace's rpc_error only where it alone could tell; 3 a hook frame
// counts only under a PoolManager frame the trade's own target or the pinned v4 adapter entered.
test("review of de4e3ed5, 1 (sell, Robinhood) an honest fee hook whose fee an earlier transaction of the sale's block moved through state outside the PoolManager (an oracle it reads; the PoolManager's words unmoved): the quoter read on the replay's own basis sees it, so nothing is banned", async () => {
  const token = "0x" + (0xae29c01).toString(16).padStart(40, "0");
  const mv = (ctx: SimCtx | null | undefined, v: bigint) => (ctx && later(ctx) && ctx.sees?.earlier === true ? (v * 98n) / 100n : v);
  const fee: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0xdb)), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, lieAt: (a, ctx) => mv(ctx, (2n * a * 95n) / 100n), state: pricedInto1(2n), exec: (a, ctx) => mv(ctx, (2n * a * 95n) / 100n), neutral: (a, ctx) => mv(ctx, 2n * a), deltaFee: true };
  const pools = [seeded(token), fee];
  const q = await hcQuote(pools, token, [{ key: fee.key, at: 4_500_001 }], undefined, RH_SALE);
  assert.ok(!("code" in q) && q.hooked.length === 1, show(q));
  const hash = await land(pools, q, HEAD_NO + 1, { trace: {} }, (x) => x, RH_SALE);
  assert.equal(SALES.get(hash)!.status, "0x0", "the sale misses minOut and reverts");
  assert.deepEqual(await proved(pools, q, hash, undefined, RH_SALE), [], "an honest hook banned");
});

test("review of de4e3ed5, 2 (buy, Robinhood) the market that did not hold is final with the trace read; with one trace provider down it is read on the parent basis, so it is asked again (review of fb923143, 2), and where only the trace could tell, its rpc_error names EVM_TRACE_UNANSWERED", async () => {
  const { pools, q } = await ihBuy(tellHook("baseFee"), 8);
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  const down: EvmRpc = async () => { throw new Error("down"); };
  // the market no longer holds: the hostile pool's quote below minOut
  const shut = pools.map((p) => (p.lie !== undefined && p.exec !== undefined ? { ...p, lie: () => 1n } : p));
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(shut), RH_NET.venues, rhTrace(shut)), [], "both trace providers up: the market at the pre-state did not hold, final");
  // one down: the market was read on the parent basis, which the pre-state could turn into a ban, so it is asked again
  // (review of fb923143, 2)
  await assert.rejects(quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(shut), RH_NET.venues, [rhTrace(shut)[0]!, down]), (e: unknown) => e instanceof EvmQuoteError && e.code === "rpc_error" && e.message.includes(quoteMod.EVM_TRACE_UNANSWERED));
  const e2 = await ihBuy(earlierHook, 9, EARLY);
  const h2 = await landBuy(e2.pools, e2.q, HEAD_NO + 1, {}, {}, RH_NET);
  await assert.rejects(quoteMod.evmBuyRevertedPoolsWith(e2.q, h2, rhTrace(e2.pools), RH_NET.venues, [rhTrace(e2.pools)[0]!, down]), (e: unknown) => e instanceof EvmQuoteError && e.code === "rpc_error" && e.message.includes(quoteMod.EVM_TRACE_UNANSWERED));
});

test("review of de4e3ed5, 3 (buy, Robinhood) the bought token, called by the PoolManager inside the unlock, swaps into the route's honest hook and lets its revert through (nothing caught): a frame chain the device's own swapper never made counts for nothing, so the honest hook is not banned; under a PoolManager frame the pinned v4 adapter entered, the hostile hook's errored frame still counts", async () => {
  const [token, x] = ["0x000000000000000000000000000000000ae29a03", xAt(0x7fb)];
  const pools: ModelPool[] = [
    seeded(token),
    { key: keyOf(x, NATIVE, 3000, 60, N1_H1), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, state: pricedAt(2n) },
    { key: keyOf(token, x, 3000, 60, N1_H2), give: (a) => a, lie: (a) => a, deltaFee: true, exec: (a, ctx) => (later(ctx) && ctx.sees?.baseFee === true && backlogOf(ctx) < 3_000_000n ? null : a) },
  ];
  const logs = [{ key: pools[2]!.key, at: 4_500_000 }, { key: pools[1]!.key, at: 4_100_001 }];
  const q = await hbQuote(pools, token, logs, n1BuyRoute(token, x), undefined, RH_NET);
  assert.ok(!("code" in q) && q.hooked.length === 2, show(q));
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { trace: { caught: { by: token, into: [N1_H1], errored: true } } }, {}, RH_NET), undefined, RH_NET), [], "the honest hook banned through the token's own call");
  // the trade's own target (the pool, in the model) entered the PoolManager; and the pinned v4 adapter (RH_NET's
  // venues: BUY_ADAPTER), as a real buy's swap does
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { trace: { erroredToo: [N1_H2] } }, {}, RH_NET), undefined, RH_NET), [hcPid(pools[2]!.key)], "the trade's own PoolManager frame");
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { trace: { erroredToo: [N1_H2], pmFrom: BUY_ADAPTER } }, {}, RH_NET), undefined, RH_NET), [hcPid(pools[2]!.key)], "the adapter's PoolManager frame");
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q, HEAD_NO + 1, { trace: { erroredToo: [N1_H2], pmFrom: PH(0xef) } }, {}, RH_NET), undefined, RH_NET), [], "another caller's PoolManager frame");
});

test("card evm-sell-hook-intrablock, the trace pair is Robinhood mainnet's alone: dRPC and Pocket; the testnet and Base have none (the parent replay)", () => {
  const v = builder.evmPoolVenues();
  assert.deepEqual(v.robinhood.traceProviders, ["https://robinhood.drpc.org", "https://robinhood.api.pocket.network"]);
  for (const c of ["base", "base-sepolia", "robinhood-testnet"] as const) assert.equal(Object.hasOwn(v[c], "traceProviders"), false, c);
});

const RH_SALE: SaleNet = { chain: "robinhood", nitro: true, venues: Object.freeze({ ...DELEGATED, robinhood: Object.freeze({ ...DELEGATED.robinhood, sellDelegate: DELEGATED.base!.sellDelegate, sellSender: SENDER, pool: SALE_POOL, feeCollector: SALE_COLLECTOR }) }) as builder.EvmPoolVenueList };
test("card evm-sell-hook-intrablock, HC2 and HIGH 1 (sell, Robinhood) a hook flipped by an earlier transaction of the sale's block, and one keyed on ArbOS's backlog: each costs one failed try, its pool banned on the sale's own trace", async () => {
  for (const [i, exec] of [earlierHook, backlogHook].entries()) {
    const token = "0x" + (0x1ae1000 + i).toString(16).padStart(40, "0");
    const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0xd0 + i)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec, ...(exec === earlierHook ? EARLY : {}) };
    const r = await hcConverge([seeded(token), hostile], token, [{ key: hostile.key, at: 4_500_001 }], 6, HEAD_NO + 1, RH_SALE);
    assert.deepEqual({ failed: r.failed, got: r.got, banned: r.banned }, { failed: 1, got: AMOUNT / 10n, banned: [hcPid(hostile.key)] }, `${i}: ${show(r)}`);
  }
});

// ------------------------------------------------------------------------------------- review of fb923143
// 1: each tracer is two companies' word apart, so a callTracer no provider answered (a hook flooding its frames' inputs
// past callBytes at no gas) keeps the prestate both answered, and the replay at it still bans a hook an earlier
// transaction flipped; 2: with the prestate unread, every later [] (a market that did not hold, a step 4 that rescued
// nothing) is asked again; question 5: a numeric field of the trade's evidence that is not a number refuses.
/** A trace provider whose callTracer answer is refused (evmJsonRpc's "the answer is too long", BadAnswer), its prestate answered. */
const callFlooded = (rpc: EvmRpc): EvmRpc => async (calls) => {
  if (calls.some((c) => c.method === "debug_traceTransaction" && (c.params[1] as { tracer: string }).tracer === "callTracer")) throw new Error("the answer is too long");
  return rpc(calls);
};
// the same through evmJsonRpc's own byte cap: a fetch that serves the model and adds `pad` frames to the callTracer's
// answer, each passing the same 128 KiB of memory (a warm CALL is 100 gas; the memory, 45,056 gas, is paid once)
const R3_FLOOD_A = "0x" + "f100d".padStart(40, "0");
const R3_FLOOD_B = "0x" + "f100e".padStart(40, "0");
const r3Fetch = (rpc: EvmRpc, pad: number): typeof fetch =>
  (async (_url: unknown, init?: { body?: unknown }) => {
    const reqs = JSON.parse(String(init!.body)) as { id: number; method: string; params: unknown[] }[];
    const out = (await rpc(reqs.map((r) => ({ method: r.method, params: r.params })))) as { result?: unknown }[];
    const frame = { type: "CALL", from: R3_FLOOD_A, to: R3_FLOOD_B, input: "0x" + "00".repeat(131072), value: "0x0" };
    const ans = out.map((a, i) => {
      const r = reqs[i]!;
      if (pad > 0 && r.method === "debug_traceTransaction" && (r.params[1] as { tracer: string }).tracer === "callTracer") {
        const res = a.result as { calls?: unknown[] };
        return { ...a, id: r.id, result: { ...res, calls: [...(res.calls ?? []), ...Array(pad).fill(frame)] } };
      }
      return { ...a, id: r.id };
    });
    return new Response(JSON.stringify(ans), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
/** The model behind evmJsonRpc capped at the callTracer's bytes for a trade that used `gasUsed` (preBounds' callBytes). */
const r3Capped = (rpc: EvmRpc, pad: number, gasUsed: bigint) => evmJsonRpc("https://robinhood.drpc.org", r3Fetch(rpc, pad), 8192 + 512 * (Number((gasUsed * 5n) / 4n / 100n) + 2));
const r3Unanswered = (e: unknown) => e instanceof EvmQuoteError && e.code === "rpc_error" && e.message.includes(quoteMod.EVM_TRACE_UNANSWERED);

test("review of fb923143, 1a (buy, Robinhood) a hook an earlier transaction of the buy's block flipped, that floods the callTracer past its byte cap: the prestate both answered still holds the replay, so its pool is banned", async () => {
  const { pools, q, hostile } = await ihBuy(earlierHook, 31, EARLY);
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  const gasUsed = (BUY_GAS * 4n) / 5n;
  const t = rhTrace(pools);
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [r3Capped(t[0]!, 0, gasUsed), r3Capped(t[1]!, 0, gasUsed)]), [hcPid(hostile.key)], "control: through evmJsonRpc, no flood");
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [r3Capped(t[0]!, 40, gasUsed), r3Capped(t[1]!, 40, gasUsed)]), [hcPid(hostile.key)], "40 frames of 128 KiB through evmJsonRpc's cap");
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools).map(callFlooded)), [hcPid(hostile.key)], "the callTracer refused on both");
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [rhTrace(pools)[0]!, callFlooded(rhTrace(pools)[1]!)]), [hcPid(hostile.key)], "the callTracer refused on one");
});

test("review of fb923143, 1b (sell, Robinhood) the same flipped hook on a sale, its callTracer flooded past its byte cap: the prestate holds the replay, so its pool is banned", async () => {
  const token = "0x" + (0x1ae3b01).toString(16).padStart(40, "0");
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0xe3)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: earlierHook, ...EARLY };
  const pools = [seeded(token), hostile];
  const q = await hcQuote(pools, token, [{ key: hostile.key, at: 4_500_001 }], undefined, RH_SALE);
  assert.ok(!("code" in q) && q.hooked.length === 1, show(q));
  const hash = await land(pools, q, HEAD_NO + 1, {}, (x) => x, RH_SALE);
  assert.equal(SALES.get(hash)!.status, "0x0");
  const on = (who: 0 | 1) => chain(pools, who, undefined, undefined, undefined, true);
  const sq = q as unknown as EvmPoolSellQuote;
  const gasUsed = (SALE_GAS * 4n) / 5n;
  assert.deepEqual(await evmSellRevertedPoolsWith(sq, hash, [on(0), on(1)], RH_SALE.venues, [r3Capped(on(0), 0, gasUsed), r3Capped(on(1), 0, gasUsed)]), [hcPid(hostile.key)], "control: through evmJsonRpc, no flood");
  assert.deepEqual(await evmSellRevertedPoolsWith(sq, hash, [on(0), on(1)], RH_SALE.venues, [r3Capped(on(0), 40, gasUsed), r3Capped(on(1), 40, gasUsed)]), [hcPid(hostile.key)], "40 frames of 128 KiB through evmJsonRpc's cap");
  assert.deepEqual(await evmSellRevertedPoolsWith(sq, hash, [on(0), on(1)], RH_SALE.venues, [on(0), on(1)].map(callFlooded)), [hcPid(hostile.key)], "the callTracer refused on both");
});

test("review of fb923143, 1c (buy, Robinhood) a callTracer flooded where only it could tell (a hook keyed on ArbOS's backlog that reverts in its own frame): the replay at the prestate passes, so the as-is leg is unread and asked again, never a final []", async () => {
  const { pools, q, hostile } = await ihBuy(backlogHook, 32);
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools)), [hcPid(hostile.key)], "control: the trace whole");
  await assert.rejects(quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools).map(callFlooded)), r3Unanswered);
});

test("review of fb923143, 1d (buy, Robinhood) the callTracer kept to its bounds and its root: one both answer not as the trade's own call drops the prestate with it, so the flipped hook is not banned on it; one the two answer apart keeps the prestate (review of 1ee73a00, 2)", async () => {
  const { pools, q, hostile } = await ihBuy(earlierHook, 33, EARLY);
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  const callEdit = (f: (r: Record<string, unknown>) => Record<string, unknown>) => (rpc: EvmRpc): EvmRpc => async (calls) => {
    const out = (await rpc(calls)) as { result?: Record<string, unknown> }[];
    return out.map((a, i) => (calls[i]!.method === "debug_traceTransaction" && (calls[i]!.params[1] as { tracer: string }).tracer === "callTracer" && a?.result ? { ...a, result: f(a.result) } : a));
  };
  const t = rhTrace(pools);
  const notOwn = callEdit((r) => ({ ...r, input: "0x00" }));
  // review of 1ee73a00, 2: one provider alone can answer its callTracer apart, so that keeps the prestate both agree on
  // (this asserted [] before)
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [t[0]!, notOwn(t[1]!)]), [hcPid(hostile.key)], "the callTracer answered apart (one the trade's call, one not): the prestate kept");
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools).map(notOwn)), [], "a root frame that is not the trade's own call");
});

test("review of fb923143, 1e (buy, Robinhood) a prestate past its bounds drops the callTracer with it: a hook keyed on ArbOS's backlog whose own frame errored is not banned on the callTracer alone, and the replay at the parent block passing is final", async () => {
  const { pools, q, hostile } = await ihBuy(backlogHook, 37);
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools)), [hcPid(hostile.key)], "control: the trace whole");
  const listPre = (rpc: EvmRpc): EvmRpc => async (calls) => {
    const out = (await rpc(calls)) as { result?: unknown }[];
    return out.map((a, i) => (calls[i]!.method === "debug_traceTransaction" && (calls[i]!.params[1] as { tracer: string }).tracer === "prestateTracer" && a?.result ? { ...a, result: [a.result] } : a));
  };
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools).map(listPre)), [], "a prestate that is no state");
});

test("review of fb923143, 2 (buy, Robinhood) a reverting hook keyed on ArbOS's backlog, the price an earlier transaction of the buy's block moved back into minOut: with the trace its pool is banned; with one trace provider down the market at the parent basis does not hold, which the trace could flip, so it is asked again (EVM_TRACE_UNANSWERED)", async () => {
  const moved = (a: bigint, ctx: SimCtx) => (ctx.sees?.earlier === true ? 2n * a : (2n * a * 90n) / 100n);
  const exec = (a: bigint, ctx: SimCtx) => (!later(ctx) ? 2n * a : ctx.sees?.baseFee === true && backlogOf(ctx) < 3_000_000n ? null : moved(a, ctx));
  const { pools, q, hostile } = await ihBuy(exec, 34, { lieAt: (a, ctx) => (later(ctx) ? moved(a, ctx) : 2n * a) });
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual(SALES.get(h)!.errored, [hostile.key.hooks], "the hook's own frame errored in the buy");
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools)), [hcPid(hostile.key)], "control: the trace read");
  const down: EvmRpc = async () => {
    throw new Error("down");
  };
  await assert.rejects(quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [rhTrace(pools)[0]!, down]), r3Unanswered);
});

test("review of fb923143, 2 step 4 (buy, Robinhood) a buy that failed where no set of its hooks' no-op rescues it and no hook's own frame errored: final [] with the trace read; with one trace provider down, read on the parent basis, asked again", async () => {
  const dry = (a: bigint, ctx: SimCtx) => (later(ctx) ? null : 2n * a);
  // deltaFee: the trade fails with no errored hook frame (review of 1ee73a00, 1: where the hook's own frame errored,
  // the callTracer bans it, review of 1ee73a00, 1a)
  const { pools, q } = await ihBuy(dry, 35, { neutral: dry, deltaFee: true });
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools)), [], "the trace read: no set rescues it, final");
  const down: EvmRpc = async () => {
    throw new Error("down");
  };
  await assert.rejects(quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [rhTrace(pools)[0]!, down]), r3Unanswered);
});

// question 5: each numeric field of the trade's transaction, receipt and block, "0x" on both providers, refuses with
// EvmQuoteError (rpc_error, "is not a number"), never a SyntaxError from BigInt
const R3_FIELDS = [
  ["eth_getTransactionByHash", "gas"],
  ["eth_getTransactionByHash", "value"],
  ["eth_getTransactionByHash", "blockNumber"],
  ["eth_getTransactionByHash", "transactionIndex"],
  ["eth_getTransactionByHash", "maxFeePerGas"],
  ["eth_getTransactionByHash", "maxPriorityFeePerGas"],
  ["eth_getTransactionReceipt", "status"],
  ["eth_getTransactionReceipt", "gasUsed"],
  ["eth_getTransactionReceipt", "transactionIndex"],
  ["eth_getTransactionReceipt", "gasUsedForL1"],
  ["eth_getBlockByHash", "number"],
  ["eth_getBlockByHash", "timestamp"],
  ["eth_getBlockByHash", "baseFeePerGas"],
] as const;
const r3Field = (m: string, k: string, v: unknown) => (rpc: EvmRpc): EvmRpc => async (calls) => {
  const out = (await rpc(calls)) as { result?: Record<string, unknown> }[];
  return out.map((a, i) => (calls[i]!.method === m && a?.result ? { ...a, result: { ...a.result, [k]: v } } : a));
};
for (const [m, k] of R3_FIELDS) {
  test(`review of fb923143, question 5 (buy, Robinhood) ${m}'s ${k} "0x" on both providers refuses with EvmQuoteError, never a SyntaxError`, async () => {
    const { pools, q } = await ihBuy(earlierHook, 36, EARLY);
    const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
    await assert.rejects(quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools).map(r3Field(m, k, "0x")), RH_NET.venues, rhTrace(pools)), (e: unknown) => e instanceof EvmQuoteError && e.code === "rpc_error" && e.message.includes(`${k} is not a number`), `${m} ${k}`);
  });
}
test("review of fb923143, question 5 (sell, Robinhood) a sale's receipt status \"0x\" on both providers refuses with EvmQuoteError, never a SyntaxError", async () => {
  const token = "0x" + (0x1ae3b05).toString(16).padStart(40, "0");
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0xe5)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: earlierHook, ...EARLY };
  const pools = [seeded(token), hostile];
  const q = await hcQuote(pools, token, [{ key: hostile.key, at: 4_500_001 }], undefined, RH_SALE);
  assert.ok(!("code" in q) && q.hooked.length === 1, show(q));
  const hash = await land(pools, q, HEAD_NO + 1, {}, (x) => x, RH_SALE);
  const on = (who: 0 | 1) => chain(pools, who, undefined, undefined, undefined, true);
  await assert.rejects(evmSellRevertedPoolsWith(q as unknown as EvmPoolSellQuote, hash, [on(0), on(1)].map(r3Field("eth_getTransactionReceipt", "status", "0x")), RH_SALE.venues, [on(0), on(1)]), (e: unknown) => e instanceof EvmQuoteError && e.code === "rpc_error" && e.message.includes("status is not a number"));
});

// ------------------------------------------------------------------------------------- review of 1ee73a00
// 1: where the replay failed and no set's no-op rescues it, the hooks the agreed callTracer names errored are at fault
// (a hook an earlier transaction armed can fail its own no-op pool too), asked again while that callTracer is unread;
// and the evidence's no-op takes LP fee 0 (EVM_EVIDENCE_NOOP_HOOK_CODE), so a stored dynamic fee the hook raised cannot
// fail it even under a flood; 2: a callTracer one provider answers apart keeps the agreed prestate; 3: the callTracer is
// read on its own byte cap through the pinned pair; info: EVM_TRACE_UNANSWERED's text is true where it is thrown.
// Repros Q2a to Q4 are review 4's (the ehi4 block), Q2c flipped to the fix.
/** The few opcodes a no-op hook runs (PUSH1-PUSH32, CALLDATACOPY, CALLDATALOAD, SHR, EQ, JUMPI to a JUMPDEST, MSTORE,
 *  RETURN), run as the EVM does on `data`: the bytes it returns, or null on any other opcode or a jump to no JUMPDEST. */
function hookReturn(code: string, data: string): string | null {
  const c = Buffer.from(code.slice(2), "hex");
  const cd = Buffer.from(data.slice(2), "hex");
  const mem = Buffer.alloc(4096);
  const st: bigint[] = [];
  const pop = () => {
    const v = st.pop();
    if (v === undefined) throw new Error("stack underflow");
    return v;
  };
  for (let pc = 0, n = 0; n < 1000; n++) {
    if (pc >= c.length) return "0x";
    const op = c[pc]!;
    if (op >= 0x60 && op <= 0x7f) {
      const k = op - 0x5f;
      st.push(BigInt("0x" + c.subarray(pc + 1, pc + 1 + k).toString("hex").padEnd(2 * k, "0")));
      pc += 1 + k;
      continue;
    }
    if (op === 0x37) {
      const [m, o, l] = [pop(), pop(), pop()];
      for (let i = 0n; i < l; i++) mem[Number(m + i)] = cd[Number(o + i)] ?? 0;
    } else if (op === 0x35) {
      const o = Number(pop());
      st.push(BigInt("0x" + Buffer.from(Array.from({ length: 32 }, (_, i) => cd[o + i] ?? 0)).toString("hex")));
    } else if (op === 0x1c) {
      const [sh, v] = [pop(), pop()];
      st.push(sh >= 256n ? 0n : v >> sh);
    } else if (op === 0x14) st.push(pop() === pop() ? 1n : 0n);
    else if (op === 0x57) {
      const [d, cond] = [pop(), pop()];
      if (cond !== 0n) {
        if (c[Number(d)] !== 0x5b) return null;
        pc = Number(d);
        continue;
      }
    } else if (op === 0x52) {
      const [m, v] = [pop(), pop()];
      mem.write(v.toString(16).padStart(64, "0"), Number(m), "hex");
    } else if (op === 0xf3) {
      const [m, l] = [pop(), pop()];
      return "0x" + mem.subarray(Number(m), Number(m + l)).toString("hex");
    } else if (op !== 0x5b) return null;
    pc++;
  }
  return null;
}
const SEL_BEFORE_SWAP = "575e24b4";
const SEL_AFTER_SWAP = "b47b2fb1";
/** Whether the code the call gives `hook` answers beforeSwap with v4-core's OVERRIDE_FEE_FLAG (0x400000) set in its fee
 *  word (Pool.swap then takes the fee it carries, not the pool's stored LP fee). */
const feeOverridden = (ctx: SimCtx, hook: string) => {
  const code = ctx.codes?.[hook.toLowerCase()];
  const r = code === undefined ? null : hookReturn(code, "0x" + SEL_BEFORE_SWAP + "00".repeat(32 * 12));
  return r !== null && r.length === 2 + 192 && (BigInt("0x" + r.slice(130, 194)) & 0x400000n) !== 0n;
};
test("review of 1ee73a00, 1 (no-op code) the evidence's no-op answers beforeSwap with fee 0 and the override flag, the quote's with fee 0 and no flag; both echo the selector, delta 0, and answer afterSwap in 64 bytes", () => {
  const sel = (s: string) => s.padEnd(64, "0");
  const before = "0x" + SEL_BEFORE_SWAP + "11".repeat(32 * 12);
  const after = "0x" + SEL_AFTER_SWAP + "22".repeat(32 * 14);
  assert.equal(hookReturn(quoteMod.EVM_EVIDENCE_NOOP_HOOK_CODE, before), "0x" + sel(SEL_BEFORE_SWAP) + W(0n) + W(0x400000n));
  assert.equal(hookReturn(quoteMod.EVM_EVIDENCE_NOOP_HOOK_CODE, after), "0x" + sel(SEL_AFTER_SWAP) + W(0n));
  assert.equal(hookReturn(quoteMod.EVM_NOOP_HOOK_CODE, before), "0x" + sel(SEL_BEFORE_SWAP) + W(0n) + W(0n), "the quote path's no-op reads the stored fee");
  assert.equal(hookReturn(quoteMod.EVM_NOOP_HOOK_CODE, after), "0x" + sel(SEL_AFTER_SWAP) + W(0n));
});

// 2: one trace provider's callTracer refused or answered apart, the other's a value: the prestate is kept, only the
// as-is leg unread
test("review of 1ee73a00, 2a (sell, Robinhood) callTracer refused on one trace provider, answered on the other: the flipped hook is banned (ehi4 Q2a)", async () => {
  const token = "0x" + (0x1ae4b01).toString(16).padStart(40, "0");
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0xf1)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: earlierHook, ...EARLY };
  const pools = [seeded(token), hostile];
  const q = await hcQuote(pools, token, [{ key: hostile.key, at: 4_500_001 }], undefined, RH_SALE);
  assert.ok(!("code" in q) && q.hooked.length === 1, show(q));
  const hash = await land(pools, q, HEAD_NO + 1, {}, (x) => x, RH_SALE);
  const on = (who: 0 | 1) => chain(pools, who, undefined, undefined, undefined, true);
  const sq = q as unknown as EvmPoolSellQuote;
  assert.deepEqual(await evmSellRevertedPoolsWith(sq, hash, [on(0), on(1)], RH_SALE.venues, [on(0), callFlooded(on(1))]), [hcPid(hostile.key)]);
  assert.deepEqual(await evmSellRevertedPoolsWith(sq, hash, [on(0), on(1)], RH_SALE.venues, [callFlooded(on(0)), on(1)]), [hcPid(hostile.key)]);
});
test("review of 1ee73a00, 2b (buy, Robinhood) callTracer refused on one, answered on the other, where only it could tell (backlog hook): asked again, never a final [] (ehi4 Q2b)", async () => {
  const { pools, q } = await ihBuy(backlogHook, 41);
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  const t = rhTrace(pools);
  await assert.rejects(quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [t[0]!, callFlooded(t[1]!)]), r3Unanswered);
  await assert.rejects(quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [callFlooded(t[0]!), t[1]!]), r3Unanswered);
});
/** A trace provider whose callTracer's root input is not the trade's (erroredOf null), the rest answered true. */
const r4NotOwn = (rpc: EvmRpc): EvmRpc => async (calls) => {
  const out = (await rpc(calls)) as { result?: Record<string, unknown> }[];
  return out.map((a, i) => (calls[i]!.method === "debug_traceTransaction" && (calls[i]!.params[1] as { tracer: string }).tracer === "callTracer" && a?.result ? { ...a, result: { ...a.result, input: "0x00" } } : a));
};
test("review of 1ee73a00, 2c (buy, Robinhood) one trace provider answering its callTracer apart (not failing it) keeps the agreed prestate: the flipped hook is banned, either order (ehi4 Q2c, flipped)", async () => {
  const { pools, q, hostile } = await ihBuy(earlierHook, 42, EARLY);
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  const t = rhTrace(pools);
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [t[0]!, callFlooded(t[1]!)]), [hcPid(hostile.key)], "one fails its callTracer: banned");
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [t[0]!, r4NotOwn(t[1]!)]), [hcPid(hostile.key)], "one answers apart: the prestate kept, banned");
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, [r4NotOwn(t[0]!), t[1]!]), [hcPid(hostile.key)], "the other way round");
});
test("review of 1ee73a00, 2d (sell, Robinhood) one trace provider answering a sale's callTracer apart keeps the agreed prestate: the flipped hook is banned, either order", async () => {
  const token = "0x" + (0x1ae4b05).toString(16).padStart(40, "0");
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0xf5)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: earlierHook, ...EARLY };
  const pools = [seeded(token), hostile];
  const q = await hcQuote(pools, token, [{ key: hostile.key, at: 4_500_001 }], undefined, RH_SALE);
  assert.ok(!("code" in q) && q.hooked.length === 1, show(q));
  const hash = await land(pools, q, HEAD_NO + 1, {}, (x) => x, RH_SALE);
  const on = (who: 0 | 1) => chain(pools, who, undefined, undefined, undefined, true);
  const sq = q as unknown as EvmPoolSellQuote;
  assert.deepEqual(await evmSellRevertedPoolsWith(sq, hash, [on(0), on(1)], RH_SALE.venues, [on(0), r4NotOwn(on(1))]), [hcPid(hostile.key)]);
  assert.deepEqual(await evmSellRevertedPoolsWith(sq, hash, [on(0), on(1)], RH_SALE.venues, [r4NotOwn(on(0)), on(1)]), [hcPid(hostile.key)]);
});

// 1: the replay failed, the prestate read, the market held and no no-op rescues: the callTracer's errored frame
test("review of 1ee73a00, 1a (buy, Robinhood) with the replay failed, a flooded callTracer gives the same ban as a whole one where a no-op rescues (earlierHook); where none rescues, the whole one bans the dry hook's own errored frame and the flooded one is asked again (ehi4 Q3a, re-pointed)", async () => {
  const a = await ihBuy(earlierHook, 43, EARLY);
  const ha = await landBuy(a.pools, a.q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(a.q, ha, rhTrace(a.pools), RH_NET.venues, rhTrace(a.pools).map(callFlooded)), [hcPid(a.hostile.key)]);
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(a.q, ha, rhTrace(a.pools), RH_NET.venues, rhTrace(a.pools)), [hcPid(a.hostile.key)]);
  // re-pointed: ehi4 asserted [] for both; this hook's own frame errored in the buy and its no-op pool fails too, so
  // the callTracer is its only witness: read, a ban; flooded, asked again
  const dry = (x: bigint, ctx: SimCtx) => (later(ctx) ? null : 2n * x);
  const b = await ihBuy(dry, 44, { neutral: dry });
  const hb = await landBuy(b.pools, b.q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual(SALES.get(hb)!.errored, [b.hostile.key.hooks], "the dry hook's own frame errored in the buy");
  await assert.rejects(quoteMod.evmBuyRevertedPoolsWith(b.q, hb, rhTrace(b.pools), RH_NET.venues, rhTrace(b.pools).map(callFlooded)), r3Unanswered);
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(b.q, hb, rhTrace(b.pools), RH_NET.venues, rhTrace(b.pools)), [hcPid(b.hostile.key)]);
});
// A hook an earlier transaction of the block armed, that reverts the real trade in its own frame, leaves the quoter its
// normal price (its beforeSwap sees the quoter as sender), and whose pool pays nothing with its code a no-op (the arming
// transaction moved its pool's price or liquidity)
const bait = (a: bigint, ctx: SimCtx) => (later(ctx) && ctx.sees?.earlier === true ? null : 2n * a);
test("review of 1ee73a00, 1b (buy, Robinhood) the bait: the replay fails, the prestate read, the market held, no no-op rescues: the hook the callTracer names errored is banned (ehi4 Q3b)", async () => {
  const c = await ihBuy(bait, 45);
  const hc = await landBuy(c.pools, c.q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(c.q, hc, rhTrace(c.pools), RH_NET.venues, rhTrace(c.pools)), [hcPid(c.hostile.key)], "control: the no-op pool pays, step 4 bans it");
  const { pools, q, hostile } = await ihBuy(bait, 46, { neutral: bait });
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual(SALES.get(h)!.errored, [hostile.key.hooks], "the hook's own frame errored in the buy");
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools)), [hcPid(hostile.key)], "the bait hook banned");
  await assert.rejects(quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools).map(callFlooded)), r3Unanswered, "its callTracer flooded: asked again, never a final []");
});
test("review of 1ee73a00, 1c (sell, Robinhood) the bait on a sale: the hook the callTracer names errored is banned; its callTracer flooded, asked again (ehi4 Q3c)", async () => {
  const token = "0x" + (0x1ae4b03).toString(16).padStart(40, "0");
  const hostile: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, PH(0xf3)), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: bait, neutral: bait };
  const pools = [seeded(token), hostile];
  const q = await hcQuote(pools, token, [{ key: hostile.key, at: 4_500_001 }], undefined, RH_SALE);
  assert.ok(!("code" in q) && q.hooked.length === 1, show(q));
  const hash = await land(pools, q, HEAD_NO + 1, {}, (x) => x, RH_SALE);
  assert.equal(SALES.get(hash)!.status, "0x0");
  assert.deepEqual(SALES.get(hash)!.errored, [hostile.key.hooks], "the hook's own frame errored in the sale");
  const on = (who: 0 | 1) => chain(pools, who, undefined, undefined, undefined, true);
  const sq = q as unknown as EvmPoolSellQuote;
  assert.deepEqual(await evmSellRevertedPoolsWith(sq, hash, [on(0), on(1)], RH_SALE.venues, [on(0), on(1)]), [hcPid(hostile.key)], "the bait hook banned");
  await assert.rejects(evmSellRevertedPoolsWith(sq, hash, [on(0), on(1)], RH_SALE.venues, [on(0), on(1)].map(callFlooded)), r3Unanswered, "its callTracer flooded: asked again");
});
// The bait on a dynamic-fee pool (fee 0x800000): the arming transaction raised its stored LP fee (updateDynamicLPFee),
// which the hook's own beforeSwap override hides from the quoter and from the trade; with its code a no-op, the pool
// pays nothing where it sees that write unless the no-op's fee word carries the override flag (feeOverridden runs the
// code the replay gives the hook)
const storedFee = (hook: string) => (a: bigint, ctx: SimCtx) => (later(ctx) && ctx.sees?.earlier === true && !feeOverridden(ctx, hook) ? null : 2n * a);
const DYN = 0x800000;
test("review of 1ee73a00, 1d (buy, Robinhood) the stored-fee bait on a dynamic-fee pool, its callTracer flooded: the evidence's no-op takes fee 0, so it rescues the replay and the pool is banned", async () => {
  const n = 48;
  const token = "0x" + (0x1ae0000 + n).toString(16).padStart(40, "0");
  const hook = PH(0xc0 + n);
  const { pools, q, hostile } = await ihBuy(bait, n, { key: keyOf(token, NATIVE, DYN, 60, hook), neutral: storedFee(hook) });
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual(SALES.get(h)!.errored, [hostile.key.hooks], "the hook's own frame errored in the buy");
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools).map(callFlooded)), [hcPid(hostile.key)], "flooded: the no-op rescues");
  assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues, rhTrace(pools)), [hcPid(hostile.key)], "whole");
});
test("review of 1ee73a00, 1e (sell, Robinhood) the stored-fee bait on a sale's dynamic-fee pool, its callTracer flooded: the evidence's no-op takes fee 0, so the pool is banned", async () => {
  const token = "0x" + (0x1ae4b06).toString(16).padStart(40, "0");
  const hook = PH(0xf6);
  const hostile: ModelPool = { key: keyOf(token, NATIVE, DYN, 60, hook), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: bait, neutral: storedFee(hook) };
  const pools = [seeded(token), hostile];
  const q = await hcQuote(pools, token, [{ key: hostile.key, at: 4_500_001 }], undefined, RH_SALE);
  assert.ok(!("code" in q) && q.hooked.length === 1, show(q));
  const hash = await land(pools, q, HEAD_NO + 1, {}, (x) => x, RH_SALE);
  assert.deepEqual(SALES.get(hash)!.errored, [hostile.key.hooks], "the hook's own frame errored in the sale");
  const on = (who: 0 | 1) => chain(pools, who, undefined, undefined, undefined, true);
  const sq = q as unknown as EvmPoolSellQuote;
  assert.deepEqual(await evmSellRevertedPoolsWith(sq, hash, [on(0), on(1)], RH_SALE.venues, [on(0), on(1)].map(callFlooded)), [hcPid(hostile.key)], "flooded: the no-op rescues");
  assert.deepEqual(await evmSellRevertedPoolsWith(sq, hash, [on(0), on(1)], RH_SALE.venues, [on(0), on(1)]), [hcPid(hostile.key)], "whole");
});

// 3: the callTracer read through the pinned pair with each tracer's own cap (t[at]), not the prestate's (t[0])
test("review of 1ee73a00, 3 (buy, Robinhood, pinned trace pair) an honest-size callTracer between preBytes and callBytes is read on the callTracer's own cap: the backlog hook is banned (ehi4 Q4)", async () => {
  const { pools, q, hostile } = await ihBuy(backlogHook, 47);
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  const by = [chain(pools, 0, undefined, undefined, undefined, true), chain(pools, 1, undefined, undefined, undefined, true)];
  const urls = RH_NET.venues!.robinhood!.traceProviders as readonly string[];
  assert.equal(urls.length, 2);
  const real = globalThis.fetch;
  // 8 frames of 128 KiB: about 2.1 MB, past preBytes (~0.88 MB at the model buy's gas) and within callBytes (~7.2 MB)
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => r3Fetch(by[String(url).startsWith(urls[0]!) ? 0 : 1]!, 8)(url as string, init as RequestInit)) as typeof fetch;
  try {
    assert.deepEqual(await quoteMod.evmBuyRevertedPoolsWith(q, h, rhTrace(pools), RH_NET.venues), [hcPid(hostile.key)]);
  } finally {
    globalThis.fetch = real;
  }
});

// info: every EVM_TRACE_UNANSWERED is thrown where the trace could still change the answer, the replay passed or not
test("review of 1ee73a00, info EVM_TRACE_UNANSWERED's text names no replay outcome: it is thrown where the replay passed and where it failed", () => {
  assert.equal(quoteMod.EVM_TRACE_UNANSWERED, "the trade's trace was not answered and could still change the answer");
});

// ------------------------------------------------------------------------------------- review of d6d055bf
// 1: step 4 asks every set's no-op at the pool's stored fee first, and the fee-0 no-op only where none of those
// rescues: an honest hook h1 whose 5% fee is its dynamic pool's stored LP fee (the quoter and the trade pay it alike),
// beside a hostile h2 that shows the quoter 2% more and skims 3% from the real buy alone (the shortfall, 1.843 against
// minOut 1.881, is less than h1's fee). With fee 0 asked first, h1's no-op rescues too and both pools are banned; the
// stored-fee pass bans h2 alone. (Case 7f8, h1's fee one every no-op removes, stays open: its own card.)
const r5Skim = (a: bigint, ctx: SimCtx) => (later(ctx) ? (a * 97n) / 100n : (a * 102n) / 100n);
test("review of d6d055bf, 1 (buy, Base) an honest dynamic pool's stored fee beside a hostile skimmer: the stored-fee no-op pass bans the skimmer's pool alone (case 7f9)", async () => {
  const n = 0x7f9;
  const [token, x] = ["0x" + (0xc1f00 + n).toString(16).padStart(40, "0"), xAt(n)];
  const pools: ModelPool[] = [
    seeded(token),
    // h1's stored fee goes only where the no-op it is given carries the override flag (feeOverridden)
    { key: keyOf(x, NATIVE, 3000, 60, N1_H1), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, state: pricedAt(2n), neutral: (a, ctx) => (feeOverridden(ctx, N1_H1) ? 2n * a : (2n * a * 95n) / 100n) },
    { key: keyOf(token, x, 3000, 60, N1_H2), give: (a) => a, lie: (a) => (a * 102n) / 100n, exec: r5Skim },
  ];
  const logs = [{ key: pools[2]!.key, at: 4_500_000 }, { key: pools[1]!.key, at: 4_100_001 }];
  const q = await hbQuote(pools, token, logs, n1BuyRoute(token, x));
  assert.ok(!("code" in q), show(q));
  assert.deepEqual(await buyProved(pools, q, await landBuy(pools, q)), [hcPid(pools[2]!.key)], "the hostile pool alone");
});

// ------------------------------------------------------------------------------------- review of 2fccaa67
// 1: both no-op passes in full, and a stored-fee set that holds a smaller fee-0 set yields to it. h1 honest (its 5% fee
// one every no-op removes: a delta fee, or an override over a stored 0); h2 the stored-fee bait on a dynamic pool, armed
// by an earlier transaction of the block: it reverts the real buy in its own frame, gives the quoter the normal price,
// and its arming transaction raised its stored fee to only 4% (more than the slippage, less than h1's fee plus it).
// At the stored fee only {h1, h2} rescues (2.0 x 0.96 = 1.92 against minOut 1.881); at fee 0 {h2} alone does.
test("review of 2fccaa67, 1 (buy, Robinhood) an honest hook beside a 4% stored-fee bait: the stored-fee pair yields to the bait alone, which rescues at fee 0 (ehi6 Q2)", async () => {
  const n = 0x7fa;
  const [token, x] = ["0x" + (0xc1f00 + n).toString(16).padStart(40, "0"), xAt(n)];
  const armed = (ctx: SimCtx) => later(ctx) && ctx.sees?.earlier === true;
  const pools: ModelPool[] = [
    seeded(token),
    { key: keyOf(x, NATIVE, 3000, 60, N1_H1), give: (a) => 2n * a, lie: (a) => (2n * a * 95n) / 100n, state: pricedAt(2n) },
    { key: keyOf(token, x, 3000, 60, N1_H2), give: (a) => a, lie: (a) => a, exec: (a, ctx) => (armed(ctx) ? null : a), neutral: (a, ctx) => (feeOverridden(ctx, N1_H2) || !armed(ctx) ? a : (a * 96n) / 100n) },
  ];
  const logs = [{ key: pools[2]!.key, at: 4_500_000 }, { key: pools[1]!.key, at: 4_100_001 }];
  const q = await hbQuote(pools, token, logs, n1BuyRoute(token, x), undefined, RH_NET);
  assert.ok(!("code" in q), show(q));
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual(await buyProved(pools, q, h, undefined, RH_NET), [hcPid(pools[2]!.key)], "the bait's pool alone");
});
test("review of 2fccaa67, 1 rule: the stored-fee pass's sets, or the fee-0 pass's where none; a stored-fee set yields to every smaller fee-0 set inside it, never to one outside it; each set once", () => {
  const f = quoteMod.evmFaultSets;
  assert.deepEqual(f([["a"]], [["a"], ["b"]]), [["a"]], "the stored-fee pass's singleton holds; the fee-0 one beside it is not taken");
  assert.deepEqual(f([], [["a"], ["b"]]), [["a"], ["b"]], "none at the stored fee: the fee-0 pass's");
  assert.deepEqual(f([["a", "b"]], [["b"]]), [["b"]], "the pair yields to the bait inside it (ehi6)");
  assert.deepEqual(f([["a", "b"]], [["c"]]), [["a", "b"]], "a fee-0 set outside it is no reason to yield");
  assert.deepEqual(f([["a", "b"]], [["a", "b"]]), [["a", "b"]], "the same set at both is no smaller one");
  assert.deepEqual(f([["a", "b", "c"]], [["a"], ["b"]]), [["a"], ["b"]], "every smaller fee-0 set inside it");
  assert.deepEqual(f([["a", "b"], ["b", "c"]], [["b"]]), [["b"]], "each set once");
  assert.deepEqual(f([], []), []);
});

// ------------------------------------------------------------------------------------- review of 6e8d18ad
// nit (case E2): a stored-fee set yields to every smaller fee-0 set inside it, not the first one found. h1 honest (a 3%
// stored dynamic fee, quoted); h2 hostile, second in route order: an earlier transaction of the block raised its stored
// fee to 3%, and it skims 2% of the real buy through a delta (the quoter sees the normal price). At the stored fee only
// {h1, h2} rescues; at fee 0 {h1} and {h2} each. "First" would yield to {h1} alone, banning the honest pool and leaving
// the hostile one in; "every" keeps the hostile pool banned (beside h1, as d6d055bf and 2fccaa67 did: case E1/E2, the
// reads cannot tell which of the two is honest).
test("review of 6e8d18ad, nit (buy, Robinhood) a stored-fee pair yields to every fee-0 set inside it, so the hostile hook second in route order stays banned (case E2)", async () => {
  const n = 0x7c4;
  const [token, x] = ["0x" + (0xc1f00 + n).toString(16).padStart(40, "0"), xAt(n)];
  const armed = (ctx: SimCtx) => later(ctx) && ctx.sees?.earlier === true;
  const pools: ModelPool[] = [
    seeded(token),
    { key: keyOf(x, NATIVE, 3000, 60, N1_H1), give: (a) => 2n * a, lie: (a) => (2n * a * 9409n) / 10000n, state: pricedAt(2n), neutral: (a, ctx) => (feeOverridden(ctx, N1_H1) ? 2n * a : (2n * a * 97n) / 100n) },
    { key: keyOf(token, x, 3000, 60, N1_H2), give: (a) => a, lie: (a) => a, deltaFee: true, exec: (a, ctx) => (armed(ctx) ? (a * 9506n) / 10000n : a), neutral: (a, ctx) => (armed(ctx) && !feeOverridden(ctx, N1_H2) ? (a * 97n) / 100n : a) },
  ];
  const logs = [{ key: pools[2]!.key, at: 4_500_000 }, { key: pools[1]!.key, at: 4_100_001 }];
  const q = await hbQuote(pools, token, logs, n1BuyRoute(token, x), undefined, RH_NET);
  assert.ok(!("code" in q), show(q));
  const h = await landBuy(pools, q, HEAD_NO + 1, {}, {}, RH_NET);
  assert.deepEqual([...(await buyProved(pools, q, h, undefined, RH_NET))].sort(), [hcPid(pools[1]!.key), hcPid(pools[2]!.key)].sort(), "the hostile pool banned, beside the honest one the reads cannot tell apart");
});
