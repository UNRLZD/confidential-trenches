// The review's attacks on the device's EVM buy quote (src/checks/evm/quote.ts; card evm-pool-buy-quote, review of
// b17d1fc and cefe7a0), on a modelled chain: a provider decodes each aggregate3 call and answers each quote from a
// price model, so a planted chain state needs no recorded answer. R1-R4 and R1b are the review's; R5-R10 hold the
// block agreement, the first-hop native rule, the v3 doubled read, the pinned launchpad pools and a lagging node. N1 and N2 are
// the review of 9a8265b's: N1 on a modelled chain whose PoolManager holds the token's pools (chain() below). Each test states what the device must do.
import { mock, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import assert from "node:assert/strict";
import { EvmQuoteError, evmIsDeviceQuote, evmPoolBuyQuote, type EvmPoolBuyQuoteRequest, type EvmPoolSellQuoteRequest, type EvmPoolKey, type EvmRoute, type EvmV4Route } from "../src/index.ts";
import { evmJsonRpc, evmPoolBuyQuoteWith, evmPoolSellQuoteWith, type EvmRpc, type EvmRpcCall } from "../src/checks/evm/quote.ts";
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
type Head = { number: string; hash: string; timestamp: string };
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
const head = (number: string, hash = NEW, timestamp = T): Head => ({ number, hash, timestamp });
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
// `exec`: what the pool pays a swap that is not the quoter's (W's own sell, card evm-quote-exec-sim); by default what
// it pays the quoter with its hook as it is
type ModelPool = { key: EvmPoolKey; give: (a: bigint) => bigint; lie?: ((a: bigint) => bigint | null) | undefined; exec?: (a: bigint) => bigint | null; only?: 0 | 1; state?: [bigint, bigint] };
const pidOf = (k: EvmPoolKey) => kk(W(BigInt(k.currency0)) + W(BigInt(k.currency1)) + W(BigInt(k.fee)) + W(BigInt(k.tickSpacing)) + W(BigInt(k.hooks)));
const keyOf = (token: string, other: string, fee: number, tickSpacing: number, hooks: string): EvmPoolKey => {
  const [currency0, currency1] = BigInt(other) < BigInt(token) ? [other, token] : [token, other];
  return { currency0, currency1, fee, tickSpacing, hooks };
};
// the chain's head in the model: the agreed block, which the scan provider's head must be within maxLag of;
// `overrides` keeps, for each eth_call with a state override, the addresses it replaces and the hooks of each quote in it
type Overridden = { replaces: string[]; hooks: string[][] };
function chain(pools: ModelPool[], who: 0 | 1, headNo = 5_000_000, overrides?: Overridden[]): EvmRpc {
  const live = pools.filter((p) => p.only === undefined || p.only === who);
  const byPid = new Map(live.map((p) => [pidOf(p.key), p]));
  const slots = new Map<string, bigint>();
  for (const p of live) {
    const s = BigInt("0x" + kk(pidOf(p.key) + W(6n)));
    // slot0: a price in the low 160 bits, a tick above; liquidity 3 words on
    slots.set(W(s), p.state?.[0] ?? (1n << 100n) | (5n << 160n));
    slots.set(W(s + 3n), p.state?.[1] ?? 10n ** 20n);
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
      const next = p.key.hooks !== NATIVE && !overridden.has(p.key.hooks) && p.lie !== undefined ? p.lie(amount) : p.give(amount);
      if (next === null) return null;
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
      const o = to.toLowerCase() === SELL_W && asW?.startsWith("0xef0100") ? simSell(data.slice(2), c.params[2] as Record<string, { code: string }>) : one(to, data.slice(2), overridden);
      return o === null ? { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } } : { jsonrpc: "2.0", id, result: "0x" + W(o) + W(0n) };
    });
  // W's own sell through SellDelegate (card evm-quote-exec-sim), W's code the delegate's 7702 designator: nonce() is 0;
  // sell(sell, fee, signature) swaps hop by hop from the token at each pool's `exec`, reverts below minOut, and returns
  // what W gained (the sim pool's code returns msg.value)
  function simSell(d: string, o: Record<string, { code: string }>): bigint | null {
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
      const next = p.exec !== undefined ? p.exec(got) : p.key.hooks !== NATIVE && p.lie !== undefined ? p.lie(got) : p.give(got);
      if (next === null) return null;
      [from, got] = [cur, next];
    }
    return got < minOut ? null : got;
  }
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
  // asked again after its logs are in, the scan provider names 5,000,000 (review of 4830f1f, H1)
  let heads = 0;
  const both: EvmRpc = (calls) => (calls[0]!.method === "eth_blockNumber" && heads++ > 0 ? caught(calls) : late(calls));
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), both), below);
  assert.equal(heads, 2);
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

test("review of 4830f1f, H2: 16,384 pools only initialized, with ids ground below the real pool's, refuse the quote (too_many_pools); never a seeded route bought from a cut set", async () => {
  const token = "0x00000000000000000000000000000000000e75e7";
  const pools = [seeded(token), real(token)];
  const realId = pidOf(real(token).key);
  const logs: { key: EvmPoolKey; at: number }[] = [{ key: real(token).key, at: 4_500_000 }];
  for (let fee = 1, n = 0; n < 16_384; fee++) {
    if (fee === 100 || fee === 500 || fee === 3000 || fee === 10000) continue;
    const k = keyOf(token, NATIVE, fee, 7, NATIVE);
    if (pidOf(k) < realId) logs.push({ key: k, at: 4_100_000 + 40 * n++ });
  }
  assert.deepEqual(await quoteOn(pools, token, seededRoute(token), scanner(5_000_000, logs)), { accepted: false, code: "too_many_pools" });
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
const best = (token: string): ModelPool => ({ key: keyOf(token, NATIVE, 10000, 200, NATIVE), give: (a) => 10n * a });
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
  const market: ModelPool = { key: keyOf(x17, NATIVE, 2500, 50, NATIVE), give: (a) => 100n * a };
  const logs = [{ key: shallow.key, at: 4_050_000 }, ...deeper.map((o, i) => ({ key: o.key, at: 4_100_000 + i })), { key: market.key, at: 4_060_000 }];
  await assert.rejects(evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route: bestRoute(token) }, [chain([best(token), ...deeper, shallow, market], 0), chain([best(token), ...deeper, shallow, market], 1)], NOW, scanner(5_000_000, logs)), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "below_reference", String(e));
    const r = e.reference!.route as EvmV4Route;
    assert.deepEqual(r.hops.map((h) => h.currency), [x17, token]);
    assert.equal(e.reference!.amountOut, 100n * AMOUNT);
    return true;
  });
});
test("X3 an X with more markets than a quote reads prices nothing, and refuses nothing", async () => {
  const token = "0x00000000000000000000000000000000000ff7ff";
  const x = xAt(0x900);
  const pool: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 18n] };
  // more markets of X than a quote reads (EVM_QUOTE_MAX_KEYS, 16,384): its real one, at a hundred times, and empty ones
  const market: ModelPool = { key: keyOf(x, NATIVE, 2500, 50, NATIVE), give: (a) => 100n * a };
  const empty = Array.from({ length: 16_384 }, (_, i) => keyOf(x, NATIVE, 1000 + i, 1, NATIVE));
  const logs = [{ key: pool.key, at: 4_500_000 }, { key: market.key, at: 4_100_000 }, ...empty.map((k, i) => ({ key: k, at: 4_100_000 + 50 * i }))];
  const v = await quoteOn([best(token), pool, market], token, bestRoute(token), scanner(5_000_000, logs));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
});

test("T1b a crowd of 16,000 junk pools of the token still quotes its standard route and holds a seeded one to it; past EVM_QUOTE_MAX_KEYS the quote refuses (too_many_pools)", async () => {
  const token = "0x00000000000000000000000000000000000fe5fe";
  // 16,000 pools of the token with the native asset, under EVM_QUOTE_MAX_KEYS (16,384): 15,400 empty and 600 that hold
  // a dust position (past EVM_QUOTE_MAX_QUOTED, 64)
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
  // 20,000 found pools: a set the bound cuts is never quoted from (review of 4830f1f, H2)
  const many = "0x00000000000000000000000000000000000e78e7";
  const crowd = Array.from({ length: 20_000 }, (_, i) => ({ key: keyOf(many, NATIVE, 1000 + i, 1, NATIVE), at: 4_000_001 + 49 * i }));
  assert.deepEqual(await quoteOn([best(many)], many, bestRoute(many), scanner(5_000_000, crowd)), { accepted: false, code: "too_many_pools" });
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

test("T2 eight held junk currencies older than the token's real X pool push it past EVM_QUOTE_MAX_OTHER", async () => {
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
  const realPool: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 18n] };
  const narrow = Array.from({ length: 64 }, (_, i): ModelPool => ({ key: keyOf(token, NATIVE, i + 1, 1, NATIVE), give: (a) => a / 1000n, state: [DEEP_PRICE, 10n ** 30n] }));
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
  const eth: ModelPool = { key: keyOf(token, NATIVE, 100, 1, NATIVE), give: (a) => 3000n * a };
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
  const closed: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, HOOK), give: (a) => 100n * a, lie: () => null };
  const logs = [{ key: closed.key, at: 4_500_000 }];
  const v = await quoteOn([best(token), closed], token, bestRoute(token), scanner(5_000_000, logs));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
  const t2 = "0x00000000000000000000000000000000000ab4ab";
  const half: ModelPool = { key: keyOf(t2, NATIVE, 3000, 60, HOOK), give: (a) => 100n * a, lie: (a) => 50n * a };
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
  evmPoolSellQuoteWith({ chain: "base", token, w: SELL_W, amountIn: AMOUNT, slippageBps, ...(bought !== null ? { bought } : {}), ...(signSim ? { signSim } : {}) } as EvmPoolSellQuoteRequest, [chain(pools, 0), chain(pools, 1)], NOW, scan, venues);
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
  const thin: ModelPool = { key: keyOf(x, NATIVE, 3000, 60, NATIVE), give: (a) => (a <= AMOUNT / 100n ? 2n * a : AMOUNT / 50n) };
  const deep = marketOf(x);
  const s = await sellVerdict(sellOn([pool, thin, deep], token, scanner(5_000_000, [{ key: pool.key, at: 4_500_000 }])));
  assert.equal((s as { amountOut?: bigint }).amountOut, (2n * AMOUNT) / 1000n, show(s));
});

// card evm-quote-exec-sim: a route through a hook the venue does not list sets the sell's reference only where W's own
// sell through it executes at that price (an eth_call of SellDelegate.sell from W at the agreed block); Base's venue
// here with a sell delegate pinned, as pool-evm-deploy pins it
const DELEGATED: builder.EvmPoolVenueList = Object.freeze({ ...builder.evmPoolVenues(), base: Object.freeze({ ...builder.evmPoolVenues().base, sellDelegate: "0x00000000000000000000000000000000de1e9a7e" }) });
const signed: { deadline: bigint; ts: bigint }[] = [];
const signSim: EvmPoolSellQuoteRequest["signSim"] = (sim, ts) => (signed.push({ deadline: sim.deadline, ts }), new Uint8Array(65));

test("PE a pool behind a hook that lets only the quoter trade, priced above the market, freezes no sell where the sell delegate is pinned", async () => {
  const token = "0x00000000000000000000000000000000000c0e0e";
  const market: ModelPool = { key: keyOf(token, NATIVE, 2500, 50, NATIVE), give: (a) => a };
  // twice the market to the quoter, hook replaced or as it is; W's own swap is refused
  const blocker: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, exec: () => null };
  const logs = [{ key: market.key, at: 4_500_000 }, { key: blocker.key, at: 4_500_001 }];
  signed.length = 0;
  const s = await sellVerdict(sellOn([market, blocker], token, scanner(5_000_000, logs), undefined, 100, DELEGATED, signSim));
  assert.equal((s as { amountOut?: bigint }).amountOut, AMOUNT, show(s));
  // W signed one sim, its deadline the agreed block's own time
  assert.deepEqual(signed, [{ deadline: BigInt(T), ts: BigInt(T) }]);
  // the same pool, honest to W too, still sets the reference: the seeded route is refused
  const t2 = "0x00000000000000000000000000000000000c0e1e";
  const honest: ModelPool = { key: keyOf(t2, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a };
  const h = await sellVerdict(sellOn([seeded(t2), honest], t2, scanner(5_000_000, [{ key: honest.key, at: 4_500_001 }]), undefined, 100, DELEGATED, signSim));
  assert.deepEqual(h, { accepted: false, code: "below_reference" });
  // a W's sell through it short of the quoter's price is no reference either
  const t3 = "0x00000000000000000000000000000000000c0e2e";
  const short: ModelPool = { key: keyOf(t3, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, exec: (a) => a / 20n };
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
  const blocker: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => 2n * a, lie: (a) => 2n * a, exec: () => null };
  const s = await sellVerdict(sellOn([market, blocker], token, scanner(5_000_000, [{ key: market.key, at: 4_500_000 }, { key: blocker.key, at: 4_500_001 }])));
  assert.deepEqual(s, { accepted: false, code: "below_reference" });
});
