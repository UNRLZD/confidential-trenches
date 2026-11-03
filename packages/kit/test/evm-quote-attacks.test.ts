// The review's attacks on the device's EVM buy quote (src/checks/evm/quote.ts; card evm-pool-buy-quote, review of
// b17d1fc and cefe7a0), on a modelled chain: a provider decodes each aggregate3 call and answers each quote from a
// price model, so a planted chain state needs no recorded answer. R1-R4 and R1b are the review's; R5-R10 hold the
// block agreement, the first-hop native rule, the v3 doubled read, the pinned launchpad pools and a lagging node. N2 is
// the review of 9a8265b's. Each test states what the device must do.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { EvmQuoteError, evmIsDeviceQuote, evmPoolBuyQuote, type EvmRoute } from "../src/index.ts";
import { evmPoolBuyQuoteWith, type EvmRpc, type EvmRpcCall } from "../src/checks/evm/quote.ts";

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

type Pool = { venue: "v3" | "v4"; hops: number; from: string; to: string[]; fees: number[]; hooks: string[]; amount: bigint };
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
    return { venue: "v3", hops, from: "0x" + path.slice(0, 40), to, fees, hooks: [], amount: w(1) };
  }
  assert.equal(sel, "ca253dc9");
  const n = Number(w(4));
  const p: Pool = { venue: "v4", hops: n, from: addr(1), to: [], fees: [], hooks: [], amount: w(3) };
  for (let i = 0; i < n; i++) {
    const at = 5 + Number(w(5 + i)) / 32;
    p.to.push(addr(at));
    p.fees.push(Number(w(at + 1)));
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
