// The review's attacks on the device's EVM buy quote (src/checks/evm/quote.ts; card evm-pool-buy-quote, review of
// b17d1fc and cefe7a0), on a modelled chain: a provider decodes each aggregate3 call and answers each quote from a
// price model, so a planted chain state needs no recorded answer. R1-R4 and R1b are the review's; R5-R10 hold the
// block agreement, the first-hop native rule, the v3 doubled read, the pinned launchpad pools and a lagging node. N1 and N2 are
// the review of 9a8265b's: N1 on a modelled chain whose PoolManager holds the token's pools (chain() below). Each test states what the device must do.
import { mock, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import assert from "node:assert/strict";
import { EvmQuoteError, evmIsDeviceQuote, evmPoolBuyQuote, type EvmPoolBuyQuoteRequest, type EvmPoolSellQuoteRequest, type EvmPoolKey, type EvmRoute, type EvmV4Route } from "../src/index.ts";
import { EVM_QUOTE_MAX_KEYS, evmJsonRpc, evmPoolBuyQuoteWith, evmPoolSellQuoteWith, type EvmRpc, type EvmRpcCall } from "../src/checks/evm/quote.ts";
// as namespaces: the red run before card evm-route-parity reads them where evmSellRouteOf and evmSellRouteCheck are not
import * as quoteMod from "../src/checks/evm/quote.ts";
import * as sellMod from "../src/trade/evm/sell-unpinned.ts";
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
function encodeAggregate(outs: (bigint | null)[]): string {
  const body = outs.map((x) => (x === null ? W(0n) + W(0x40n) + W(0n) : W(1n) + W(0x40n) + W(64n) + W(x) + W(0n)));
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
  // Base allows 5 blocks: provider 1's head 0xfe is 2 behind; provider 2 holds 0xfe with another hash, or another time
  const a = provider(head("0xfe", OLD), flat);
  assert.deepEqual(await buy(v3direct, a, provider(head("0x100"), flat, { "0xfe": head("0xfe", NEW) })), { accepted: false, code: "rpc_disagree" });
  assert.deepEqual(await buy(v3direct, a, provider(head("0x100"), flat, { "0xfe": head("0xfe", OLD, "0x1") })), { accepted: false, code: "rpc_disagree" });
  // nor holds it at all
  assert.deepEqual(await buy(v3direct, a, provider(head("0x100"), flat)), { accepted: false, code: "rpc_error" });
  // and 6 blocks apart is past Base's lag
  assert.deepEqual(await buy(v3direct, provider(head("0xfa"), flat), provider(head("0x100"), flat, { "0xfa": head("0xfa") })), { accepted: false, code: "rpc_disagree" });
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
  const old = "0x" + (NOW / 1000 - 31).toString(16);
  assert.deepEqual(await buy(v3direct, provider(head("0x100", NEW, old), flat), provider(head("0x100", NEW, old), flat)), { accepted: false, code: "stale_quote" });
  const fresh = "0x" + (NOW / 1000 - 30).toString(16);
  assert.equal((await buy(v3direct, provider(head("0x100", NEW, fresh), flat), provider(head("0x100", NEW, fresh), flat))).accepted, true);
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

test("N2 a caller's fetch makes no device quote: the public entry reads only the pinned providers", async () => {
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
});

// ------------------------------------------------------------------ N1: the pools the device finds for a token
// A modelled chain: `pools` exist in its PoolManager (extsload answers their price and liquidity), each quoting
// `give(amount)` with its hook replaced by the hook that does nothing, and `lie(amount)` with its hook running.
const PM = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const RH_PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // Robinhood Chain's PoolManager (the venue list)
const CLANKER = "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc";
const UNPINNED = "0x00000000000000000000000000000000000020cc";
const kk = (h: string) => Buffer.from(keccak_256(Buffer.from(h, "hex"))).toString("hex");
// `ticks`: the pool's initialized ticks, set in its tickBitmap words
// `exec`: what the pool pays a swap that is not the quoter's (W's own sell, card evm-quote-exec-sim); by default what
// it pays the quoter with its hook as it is
// `ctx`: the context the call to W runs in, as a node runs an eth_call (see simCtx)
type SimCtx = { origin: string; sender: string; gas: bigint; gasPrice: bigint };
type ModelPool = { key: EvmPoolKey; give: (a: bigint) => bigint; lie?: ((a: bigint) => bigint | null) | undefined; exec?: (a: bigint, ctx: SimCtx) => bigint | null; only?: 0 | 1; state?: [bigint, bigint]; ticks?: number[] };
const pidOf = (k: EvmPoolKey) => kk(W(BigInt(k.currency0)) + W(BigInt(k.currency1)) + W(BigInt(k.fee)) + W(BigInt(k.tickSpacing)) + W(BigInt(k.hooks)));
const keyOf = (token: string, other: string, fee: number, tickSpacing: number, hooks: string): EvmPoolKey => {
  const [currency0, currency1] = BigInt(other) < BigInt(token) ? [other, token] : [token, other];
  return { currency0, currency1, fee, tickSpacing, hooks };
};
// the chain's head in the model: the agreed block, which the scan provider's head must be within maxLag of;
// `overrides` keeps, for each eth_call with a state override, the addresses it replaces and the hooks of each quote in it;
// `balances` is each account's ETH at the block (the pinned sell sender holds one ETH), which a state override replaces
type Overridden = { replaces: string[]; hooks: string[][] };
function chain(pools: ModelPool[], who: 0 | 1, headNo = 5_000_000, overrides?: Overridden[], balances: Record<string, bigint> = { [SENDER]: 10n ** 18n }): EvmRpc {
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
  const quote = (d: string, overridden: Set<string>): bigint | null => {
    const q = poolOf(d);
    if (q.venue !== "v4") return null;
    let [from, amount] = [q.from, q.amount];
    for (let i = 0; i < q.hops; i++) {
      const k = keyOf(q.to[i]!, from, q.fees[i]!, q.spacings[i]!, q.hooks[i]!);
      const p = byPid.get(pidOf({ ...k, currency0: k.currency0.toLowerCase(), currency1: k.currency1.toLowerCase(), hooks: k.hooks.toLowerCase() }));
      if (p === undefined) return null;
      const asIs = p.key.hooks !== NATIVE && !overridden.has(p.key.hooks);
      const next = asIs && p.lie !== undefined ? p.lie(amount) : p.give(amount);
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
  const one = (to: string, d: string, overridden: Set<string>): bigint | null =>
    // a sell's fee-on-transfer probe, run as W's code (token, to, amount): the token in the model delivers it whole
    overridden.has(to.toLowerCase()) && d.length === 192 ? BigInt("0x" + d.slice(128))
    // QuoterV2.factory(): no v3 in the model
    : d.startsWith("c45a0155") ? null
    // the chain fee oracle (pool-fee.ts evmPoolChainFeeReads): none beside the gas in the model
    : d.startsWith("f1c7a58b") || d.startsWith("275aedd2") || d.startsWith("f5d6ded7") ? 0n
    // Multicall3.getEthBalance(address): the account's ETH at the block
    : to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11" && d.startsWith("4d2301cc") ? (balances["0x" + d.slice(32, 72)] ?? 0n)
    : to.toLowerCase() === PM || to.toLowerCase() === RH_PM
      ? d.startsWith("1e2eaeaf") ? (slots.get(d.slice(8)) ?? 0n) : null
      : d.startsWith("3850c7bd") || d.startsWith("1a686502") ? null // no v3 pool in the model
        : quote(d, overridden);
  return async (calls) =>
    calls.map((c, id) => {
      if (c.method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id, result: head("0x" + headNo.toString(16)) };
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
      if ((to.toLowerCase() === PM || to.toLowerCase() === RH_PM) && data.startsWith("0xdbd035ff")) {
        const n = Number(BigInt("0x" + data.slice(74, 138)));
        const words = Array.from({ length: n }, (_, k) => slots.get(data.slice(138 + 64 * k, 202 + 64 * k)) ?? 0n);
        return { jsonrpc: "2.0", id, result: "0x" + W(32n) + W(BigInt(n)) + words.map(W).join("") };
      }
      const asW = (c.params[2] as Record<string, { code?: string }> | undefined)?.[SELL_W]?.code;
      const isSim = to.toLowerCase() === SELL_W && asW?.startsWith("0xef0100");
      const ctx = isSim ? simCtx(c.params[0] as CallArgs, (c.params[2] ?? {}) as Record<string, { balance?: string }>, balances) : null;
      if (typeof ctx === "string") return { jsonrpc: "2.0", id, error: { code: -32000, message: ctx } };
      const o = isSim ? simSell(data.slice(2), c.params[2] as Record<string, { code: string }>, ctx!) : one(to, data.slice(2), overridden);
      return o === null ? { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } } : { jsonrpc: "2.0", id, result: "0x" + W(o) + W(0n) };
    });
  // W's own sell through SellDelegate (card evm-quote-exec-sim), W's code the delegate's 7702 designator: nonce() is 0;
  // sell(sell, fee, signature) swaps hop by hop from the token at each pool's `exec`, reverts below minOut, and returns
  // what W gained (the sim pool's code returns msg.value)
  function simSell(d: string, o: Record<string, { code: string }>, ctx: SimCtx): bigint | null {
    assert.ok(o[SELL_W]!.code.startsWith("0xef0100"), "W's code is a 7702 designator");
    if (d.startsWith("affed0e0")) return 0n;
    assert.ok(d.startsWith(SEL_SELL), d.slice(0, 8));
    const h = d.slice(8);
    const w = (i: number) => BigInt("0x" + h.slice(64 * i, 64 * i + 64));
    const t = Number(w(0)) / 32; // the tuple's first word
    const [token, amount, minOut, pool, deadline] = ["0x" + W(w(t)).slice(24), w(t + 1), w(t + 4), "0x" + W(w(t + 5)).slice(24), w(t + 8)];
    assert.equal(pool, sellMod.EVM_SELL_SIM, "a sim's pool is EVM_SELL_SIM");
    assert.ok(o[sellMod.EVM_SELL_SIM] !== undefined && deadline === BigInt(T), "into the sim pool, at the block's own time");
    const at = t + Number(w(t + 3)) / 32 + 1; // the route's bytes: abi.encode(PathKey[])
    const n = Number(w(at + 1));
    let [from, got] = [token, amount];
    for (let i = 0; i < n; i++) {
      const e = at + 2 + Number(w(at + 2 + i)) / 32;
      const [cur, fee, ts, hooks] = ["0x" + W(w(e)).slice(24), Number(w(e + 1)), Number(w(e + 2)), "0x" + W(w(e + 3)).slice(24)];
      const k = keyOf(cur, from, fee, ts, hooks);
      const p = byPid.get(pidOf({ ...k, currency0: k.currency0.toLowerCase(), currency1: k.currency1.toLowerCase(), hooks: k.hooks.toLowerCase() }));
      if (p === undefined) return null;
      const next = p.exec !== undefined ? p.exec(got, ctx) : p.key.hooks !== NATIVE && p.lie !== undefined ? p.lie(got) : p.give(got);
      if (next === null) return null;
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
const SEL_SELL = Buffer.from(keccak_256(new TextEncoder().encode("sell((address,uint256,address,bytes,uint256,address,uint256,uint256,uint256,uint256),uint256,bytes)"))).toString("hex").slice(0, 8);
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
  // the first scan reads 1M blocks back in 50k spans; the next one only from where it stopped
  assert.equal(Math.min(...asked.map((x) => x[0])), 4_000_001);
  assert.equal(asked.length, 2 * 20);
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
    if (calls[0]!.method === "eth_getLogs" && Number(f.toBlock) - Number(f.fromBlock) + 1 > 12_500) throw new Error("The operation was aborted due to timeout");
    return inner(calls);
  };
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), slow), below);
  assert.ok(asked.length > 0 && asked.every(([a, b]) => b - a + 1 <= 12_500), "every answered request is a half, a quarter or an eighth of a span");
  // a span answered with more logs than SCAN_MAX_LOGS is asked by halves too
  const token2 = "0x00000000000000000000000000000000000e72e7";
  const pools2 = [seeded(token2), real(token2)];
  const inner2 = scanner(5_000_000, [{ key: real(token2).key, at: 4_500_000 }]);
  const full: EvmRpc = async (calls) => {
    const f = calls[0]!.params[0] as { fromBlock?: string; toBlock?: string };
    const out = await inner2(calls);
    return calls[0]!.method === "eth_getLogs" && Number(f.toBlock) - Number(f.fromBlock) + 1 > 25_000 ? out.map((o) => ({ ...(o as object), result: new Array(10_001).fill(null) })) : out;
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
  assert.equal(order.filter((x) => x === "logs").length, 20);
  assert.ok(order.lastIndexOf("logs") < order.indexOf("head"), `the heads after every log read: ${order.join(" ")}`);
});

test("card evm-quote-head-watch: a scan that ends more than maxLag blocks behind the agreed block is scanned on up to it, and a pool made in those blocks still holds a seeded one", async () => {
  const token = "0x00000000000000000000000000000000000c44c4";
  const pools = [seeded(token), real(token)];
  const asked: [number, number][] = [];
  // the scan provider's head 4,999,990, ten blocks behind the agreed 5,000,000 (Base's maxLag 5); the real pool at 4,999,995
  const late = scanner(4_999_990, [{ key: real(token).key, at: 4_999_995 }], asked);
  const caught = scanner(5_000_000, [{ key: real(token).key, at: 4_999_995 }], asked);
  // the catch-up's requests, each with the agreed block by number in its batch, reach a backend that holds it
  let pinned = 0;
  const both: EvmRpc = (calls) => (calls.some((c) => c.method === "eth_getBlockByNumber") && ++pinned > 0 ? caught(calls) : late(calls));
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), both), below);
  assert.equal(pinned, 1, "the catch-up request carries the agreed block");
  assert.deepEqual(asked.slice(-2), [[4_999_991, 5_000_000], [4_999_991, 5_000_000]]);
});

test("review of 4830f1f, H1: a scan backend more than maxLag behind that answers [] past its own head refuses as main did, and never keeps a scan its provider did not name", async () => {
  const token = "0x00000000000000000000000000000000000e74e7";
  const pools = [seeded(token), real(token)];
  const full = scanner(4_999_990, [{ key: real(token).key, at: 4_999_995 }]);
  // a backend at 4,999,990: logs past it are not there yet, answered as [] with no error
  const lagging: EvmRpc = async (calls) => {
    const out = (await full(calls)) as { result?: unknown }[];
    return out.map((o, i) => (calls[i]!.method !== "eth_getLogs" ? o : { ...o, result: (o.result as { blockNumber: string }[]).filter((l) => Number(l.blockNumber) <= 4_999_990) }));
  };
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), lagging), { accepted: false, code: "rpc_disagree" });
  // the next quote, the scan backend caught up and honest: the real pool holds the seeded route
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_002, [{ key: real(token).key, at: 4_999_995 }]), undefined, "base", 5_000_002), below);
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
  // a provider that cuts an answer at the cap: the real pool's log is past the cut
  const capped: EvmRpc = async (calls) => {
    const f = calls[0]!.params[0] as { fromBlock?: string; toBlock?: string };
    const out = await inner(calls);
    return calls[0]!.method === "eth_getLogs" && Number(f.toBlock) - Number(f.fromBlock) + 1 > 25_000 ? out.map((o) => ({ ...(o as object), result: new Array(10_000).fill(null) })) : out;
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
  assert.equal(asked.length, 2 * 20);
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

test("L1 a buy through a pool behind an unpinned hook is refused: its sell could not leave through it (no_exit)", async () => {
  const token = "0x00000000000000000000000000000000000ac1ac";
  // the route's pool keeps a tenth through its hook; a standard pool gives half
  const hooked: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => a, lie: (a) => a - a / 10n };
  const half: ModelPool = { key: keyOf(token, NATIVE, 10000, 200, NATIVE), give: (a) => a / 2n };
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 3000, tickSpacing: 60, hooks: UNPINNED, hookData: "0x" }] };
  // found by the scan and listed by the caller too (card evm-route-parity: before it, this bought at 0.9 x)
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route, pools: [hooked.key] }, [chain([hooked, half], 0), chain([hooked, half], 1)], NOW, scanner(5_000_000, [{ key: hooked.key, at: 4_500_000 }])));
  assert.deepEqual(v, { accepted: false, code: "no_exit" });
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

test("G2 an X whose scan fails refuses the quote, as the token's own scan does: nothing is priced on a partial read", async () => {
  const token = "0x00000000000000000000000000000000000ff4ff";
  const x = xAt(0x430);
  const real: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  const market = marketOf(x);
  const inner = scanner(5_000_000, [{ key: real.key, at: 4_500_000 }, { key: market.key, at: 4_100_000 }]);
  const tx = "0x" + x.slice(2).padStart(64, "0");
  // the scan provider answers the token's logs and every other scan, and no logs for x's markets (x with the native
  // asset or WETH): a quote that went on without them would find x unpriced and pass the seeded route
  const pair = ["0x" + "0".repeat(64), "0x" + WETH.slice(2).padStart(64, "0")];
  const broken: EvmRpc = async (calls) => {
    const out = (await inner(calls)) as { result?: unknown }[];
    return out.map((a, i) => {
      const t = calls[i]!.method === "eth_getLogs" ? (calls[i]!.params[0] as { topics: unknown[] }).topics.flat() : [];
      return t.includes(tx) && t.some((x) => pair.includes(x as string)) ? { ...a, result: null } : a;
    });
  };
  assert.deepEqual(await quoteOn([seeded(token), real, market], token, seededRoute(token), broken), { accepted: false, code: "rpc_error" });
});

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

test("T4 a provider that never answers is a refusal (rpc_error) once the request's time runs out, never a hang", { timeout: 10_000 }, async () => {
  let signal: unknown;
  // a fetch that answers only when its request is aborted, as a hung connection does
  const hung = ((_: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  }) as typeof fetch;
  const t = Date.now();
  await assert.rejects(evmJsonRpc("https://a.example", hung, 1 << 20, 50)([{ method: "eth_blockNumber", params: [] }]));
  assert.ok(Date.now() - t < 5_000);
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

test("B1 USDG on Robinhood: its standard ETH pool quotes, though twenty currencies paired with it have no market and report deep pools", async () => {
  // USDG's shape on Robinhood (2026-11-04 05:5xZ): the hookless ETH/USDG 0.01% pool, thousands of pools of other
  // currencies, a few with a market of their own (JITC's, tiny), most with none
  const token = USDG;
  const eth: ModelPool = { key: keyOf(token, NATIVE, 100, 1, NATIVE), give: (a) => 3000n * a, state: pricedAt(3000n) };
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 100, tickSpacing: 1, hooks: NATIVE, hookData: "0x" }] };
  const lonely = Array.from({ length: 20 }, (_, i): ModelPool => ({ key: keyOf(token, xAt(0x800 + i), 0x800000, 8, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 24n] }));
  const jitc = xAt(0x8ff);
  const jitcPool: ModelPool = { key: keyOf(token, jitc, 3000, 60, NATIVE), give: (a) => a / 5n, state: [DEEP_PRICE, 10n ** 15n] };
  const jitcMarket: ModelPool = { key: keyOf(jitc, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const pools = [eth, jitcPool, jitcMarket, ...lonely];
  const logs = [...lonely.map((p, i) => ({ key: p.key, at: 45_000_000 + i })), { key: jitcPool.key, at: 46_000_000 }, { key: jitcMarket.key, at: 44_000_000 }];
  const v = await verdict(evmPoolBuyQuoteWith({ chain: "robinhood", token, amountIn: AMOUNT, slippageBps: 100, route }, [chain(pools, 0, 50_000_000), chain(pools, 1, 50_000_000)], NOW, scanner(50_000_000, logs, [], 100_000)));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  assert.equal((v as { amountOut: bigint }).amountOut, 3000n * AMOUNT);
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

test("T7 a provider that answers 429 is asked again a little later; one that keeps answering 429 is a refusal", { timeout: 20_000 }, async () => {
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
});

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

// card evm-route-parity: the buy and the sell route through one device-made set of pools (quote.ts routeSet), the sell
// held to a reference (review of evm-sell-device-quote, H1: a seeded hookless 1% pool was the sell's only candidate
// when the token's market sat where the sell could not route, and the device signed minOut = 0.99 x dust)
const SELL_W = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // Hardhat account 0, a published test key
// `bought` is required (review of edb4dbb, F3): by default the seeded pool's route, the one a server would send, so the
// sell must still find the token's market from its own set; null leaves it out
const sellOn = (pools: ModelPool[], token: string, scan?: EvmRpc, bought: EvmRoute | null = seededRoute(token), slippageBps = 100, venues?: builder.EvmPoolVenueList, signSim?: EvmPoolSellQuoteRequest["signSim"]) =>
  evmPoolSellQuoteWith({ chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps, boughtBlock: 1n, ...(bought !== null ? { bought } : {}), ...(signSim ? { signSim } : {}) } as EvmPoolSellQuoteRequest, [chain(pools, 0), chain(pools, 1)], NOW, scan, venues);
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

test("P2 the token's market behind a hook the sell cannot take, and a seeded 1% pool: the sell is refused, never signed at dust", async () => {
  const token = "0x00000000000000000000000000000000000ba2ba";
  const v = await sellVerdict(sellOn([seeded(token), real(token)], token, scanner(5_000_000, [{ key: real(token).key, at: 4_500_000 }])));
  assert.deepEqual(v, { accepted: false, code: "below_reference" });
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
  for (const o of [{ hooks: UNPINNED }, { fee: 3000 }, { tickSpacing: 60 }]) {
    assert.notEqual(exits(token, hop2(o)), "built", JSON.stringify(o));
    assert.deepEqual(await quoteOn(pools, token, hop2(o), scanner(5_000_000, logs)), { accepted: false, code: "no_exit" }, JSON.stringify(o));
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
  // the sell builder does not take it, so it is dropped whole: an honest pool behind the same hook at twice the market,
  // that no scan found, refuses no sell either (another token: the scan of this one is kept in memory)
  const t2 = "0x00000000000000000000000000000000000c0c1c";
  const honest2: ModelPool = { key: keyOf(t2, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const twice: ModelPool = { key: keyOf(t2, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a };
  const route2: EvmRoute = { ...lieRoute, hops: [{ ...lieRoute.hops[0]!, currency: t2 }] };
  const viaTwice = await sellVerdict(sellOn([honest2, twice], t2, scanner(5_000_000, [{ key: honest2.key, at: 4_500_000 }]), route2));
  assert.equal((viaTwice as { amountOut?: bigint }).amountOut, AMOUNT, show(viaTwice));
});

test("PD (F6) with the best route unsellable, minOut is the slippage off the reference, never off a pick below it", async () => {
  const token = "0x00000000000000000000000000000000000c0d0d";
  const s = 2000;
  const best: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => a };
  const near: ModelPool = { key: keyOf(token, NATIVE, 10000, 200, NATIVE), give: (a) => (a * 8001n) / 10000n };
  const q = await sellVerdict(sellOn([best, near], token, scanner(5_000_000, [{ key: best.key, at: 4_500_000 }]), undefined, s));
  assert.equal(q.accepted, true, show(q));
  assert.equal((q as { minOut: bigint }).minOut, (AMOUNT * BigInt(10000 - s)) / 10000n, show(q));
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
  const lagHead = scanner(4_999_990, [{ key: real(token).key, at: 4_999_995 }]);
  const freshHead = scanner(5_000_000, []);
  let heads = 0;
  // the first head from a lagging backend, the head asked again from a fresh one, every other request on the lagging one
  const lb: EvmRpc = async (calls) => {
    if (calls[0]!.method === "eth_blockNumber") return (heads++ > 0 ? freshHead : lagHead)(calls);
    const out = (await lagHead(calls)) as { result?: unknown }[];
    return out.map((o, i) => (calls[i]!.method !== "eth_getLogs" ? o : { ...o, result: (o.result as { blockNumber: string }[]).filter((l) => Number(l.blockNumber) <= 4_999_990) }));
  };
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), lb), { accepted: false, code: "rpc_disagree" });
  // nothing was kept past what the scan read: the next quote, on an honest provider, scans the gap and finds the pool
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_002, [{ key: real(token).key, at: 4_999_995 }]), undefined, "base", 5_000_002), below);
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
  assert.deepEqual(h, { accepted: false, code: "below_reference" });
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

test("PE (keep-min) where no sell delegate is pinned, the same pool keeps the lower of its two quotes in the reference: refused, not signed at the market", async () => {
  const token = "0x00000000000000000000000000000000000c0e4e";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  const blocker: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: () => null };
  const s = await sellVerdict(sellOn([market, blocker], token, scanner(5_000_000, [{ key: market.key, at: 4_500_000 }, { key: blocker.key, at: 4_500_001 }])));
  assert.deepEqual(s, { accepted: false, code: "below_reference" });
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
  assert.deepEqual(s, { accepted: false, code: "below_reference" });
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
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, signSim } as EvmPoolSellQuoteRequest;
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
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, signSim } as EvmPoolSellQuoteRequest;
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

test("PE8 a sender too low to pay the sale's gas drops the hooked route and freezes no sell: its balance is its own", async () => {
  const token = "0x00000000000000000000000000000000000c0ebe";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  // a hook W's own sell clears at twice the market: with the sender funded it sets the reference, so W's bought route is
  // below it
  const hooked: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, state: pricedInto1(2n), exec: (a) => 2n * a };
  const pools = [market, hooked];
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: seededRoute(token), boughtBlock: 1n, signSim } as EvmPoolSellQuoteRequest;
  const logs = scanner(5_000_000, [{ key: market.key, at: 4_500_000 }, { key: hooked.key, at: 4_500_001 }]);
  const funded = await sellVerdict(evmPoolSellQuoteWith(req, [chain(pools, 0), chain(pools, 1)], NOW, logs, DELEGATED));
  assert.deepEqual(funded, { accepted: false, code: "below_reference" });
  // the sender holding exactly the sim's gas x maxFeePerGas: the sim runs
  const cost = (SALE_GAS - 25_000n) * (BASE_FEE + 1_000_000n);
  const exact = { [SENDER]: cost };
  assert.deepEqual(await sellVerdict(evmPoolSellQuoteWith(req, [chain(pools, 0, 5_000_000, undefined, exact), chain(pools, 1, 5_000_000, undefined, exact)], NOW, logs, DELEGATED)), { accepted: false, code: "below_reference" });
  // one wei short on both providers (an eth_call it cannot pay for is the node's error, not a revert): the hooked route
  // is dropped and the sale prices at the market
  const short = { [SENDER]: cost - 1n };
  atMarket(await sellVerdict(evmPoolSellQuoteWith(req, [chain(pools, 0, 5_000_000, undefined, short), chain(pools, 1, 5_000_000, undefined, short)], NOW, logs, DELEGATED)));
  // and one with no ETH at all
  atMarket(await sellVerdict(evmPoolSellQuoteWith(req, [chain(pools, 0, 5_000_000, undefined, {}), chain(pools, 1, 5_000_000, undefined, {})], NOW, logs, DELEGATED)));
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
function landed(rpc: EvmRpc, heads: number[], asked: { heads: number } = { heads: 0 }, timestamp = T): EvmRpc {
  let k = 0;
  return async (calls) => {
    const out = await rpc(calls);
    return calls.map((c, id) => {
      if (c.method === "eth_getBlockByNumber") {
        const latest = c.params[0] === "latest";
        if (latest) asked.heads++;
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
  const req = { chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps: 100, bought: route, boughtBlock: BigInt(BUY_AT) } as EvmPoolSellQuoteRequest;
  return { pool, req };
};

test("L5 a sell at its buy's block, one provider a block behind it: the quote waits and reads at the buy's block, never fee_on_transfer", async () => {
  const { pool, req } = landedSell("0x00000000000000000000000000000000000ba5ba");
  const q = await evmPoolSellQuoteWith(req, [landed(chain([pool], 0), [BUY_AT]), landed(chain([pool], 1), [BUY_AT - 1, BUY_AT])], NOW);
  assert.equal(q.block.number, BigInt(BUY_AT));
  assert.equal(q.amountOut, AMOUNT);
  // both providers at the buy's block: no wait, the same quote
  const r = await evmPoolSellQuoteWith(req, [landed(chain([pool], 0), [BUY_AT + 1]), landed(chain([pool], 1), [BUY_AT])], NOW);
  assert.equal(r.block.number, BigInt(BUY_AT));
});

/** The sell quote's verdict and the mocked time it took, ms: the clock (Date, the wait's monotonic clock here) and
 *  every timer mocked, ticked `step` ms at a time until the quote settles (so the time read is up to two steps late). */
async function timed(run: (mono: () => number) => Promise<unknown>, ticks = 4_000, step = 500) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    let done = false;
    const p = sellVerdict(run(() => Date.now()) as ReturnType<typeof sellOn>).finally(() => (done = true));
    for (let i = 0; i < ticks && !done; i++) {
      await new Promise((r) => setImmediate(r));
      mock.timers.tick(step);
    }
    await new Promise((r) => setImmediate(r));
    // a quote still waiting after every tick is the wait's own failure, never a test that hangs
    if (!done) return { verdict: { accepted: false, code: "still waiting" }, ms: Date.now() };
    return { verdict: await p, ms: Date.now() };
  } finally {
    mock.timers.reset();
  }
}
/** `rpc`, each answer `ms` later */
const slow = (rpc: EvmRpc, ms: number): EvmRpc => async (calls) => {
  await new Promise((r) => setTimeout(r, ms));
  return rpc(calls);
};

test("L5b a buy's block no provider reaches within EVM_MIN_BLOCK_WAIT_MS is refused not_landed, never quoted at an older block", async () => {
  const { pool, req } = landedSell("0x00000000000000000000000000000000000ba6ba");
  const asked = { heads: 0 };
  const r = await timed((mono) => evmPoolSellQuoteWith({ ...req, boughtBlock: BigInt(BUY_AT + 1) }, [landed(chain([pool], 0), [BUY_AT], asked), landed(chain([pool], 1), [BUY_AT + 1], asked)], NOW, undefined, undefined, mono), 200);
  assert.deepEqual(r.verdict, { accepted: false, code: "not_landed" });
  // asked every 500 ms for 30 s (EVM_MIN_BLOCK_WAIT_MS, as long as a quote's block may be old), both providers each
  // time: 61 rounds, and refused only once that time has passed (review fold 1, L3)
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
  // after 4 s it is 29 s old, and quotes
  assert.equal(((await timed(run(9))).verdict as { accepted: boolean }).accepted, true);
});
