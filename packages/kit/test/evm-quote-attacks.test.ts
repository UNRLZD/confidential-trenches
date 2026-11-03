// The review's attacks on the device's EVM buy quote (src/checks/evm/quote.ts; card evm-pool-buy-quote, review of
// b17d1fc and cefe7a0), on a modelled chain: a provider decodes each aggregate3 call and answers each quote from a
// price model, so a planted chain state needs no recorded answer. R1-R4 and R1b are the review's; R5-R10 hold the
// block agreement, the first-hop native rule, the v3 doubled read, the pinned launchpad pools and a lagging node. N1 and N2 are
// the review of 9a8265b's: N1 on a modelled chain whose PoolManager holds the token's pools (chain() below). Each test states what the device must do.
import { mock, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import assert from "node:assert/strict";
import { EvmQuoteError, evmIsDeviceQuote, evmPoolBuyQuote, type EvmPoolBuyQuoteRequest, type EvmPoolKey, type EvmRoute } from "../src/index.ts";
import { evmJsonRpc, evmPoolBuyQuoteWith, type EvmRpc, type EvmRpcCall } from "../src/checks/evm/quote.ts";

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
type ModelPool = { key: EvmPoolKey; give: (a: bigint) => bigint; lie?: ((a: bigint) => bigint) | undefined; only?: 0 | 1; state?: [bigint, bigint] };
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
      const p = live.find((x) => pidOf(x.key) === pidOf({ ...k, currency0: k.currency0.toLowerCase(), currency1: k.currency1.toLowerCase(), hooks: k.hooks.toLowerCase() }));
      if (p === undefined) return null;
      amount = p.key.hooks !== NATIVE && !overridden.has(p.key.hooks) && p.lie !== undefined ? p.lie(amount) : p.give(amount);
      from = q.to[i]!;
    }
    return amount;
  };
  const one = (to: string, d: string, overridden: Set<string>): bigint | null =>
    to.toLowerCase() === PM || to.toLowerCase() === RH_PM
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
      const o = one(to, data.slice(2), overridden);
      return o === null ? { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } } : { jsonrpc: "2.0", id, result: "0x" + W(o) + W(0n) };
    });
}
/** The scan provider: its head, and the Initialize logs of `pools` at `at`; `asked` keeps each getLogs range. */
function scanner(headNo: number, logs: { key: EvmPoolKey; at: number }[], asked: [number, number][] = []): EvmRpc {
  return async (calls) =>
    calls.map((c, id) => {
      if (c.method === "eth_blockNumber") return { jsonrpc: "2.0", id, result: "0x" + headNo.toString(16) };
      assert.equal(c.method, "eth_getLogs");
      const f = c.params[0] as { address: string; fromBlock: string; toBlock: string; topics: (string | null)[] };
      const [a, b] = [Number(f.fromBlock), Number(f.toBlock)];
      asked.push([a, b]);
      const result = logs
        // as eth_getLogs filters: topic 1 is the pool id, 2 currency0, 3 currency1; a null or missing topic matches any
        .filter((l) => {
          const topics = [null, "0x" + pidOf(l.key), "0x" + W(BigInt(l.key.currency0)), "0x" + W(BigInt(l.key.currency1))];
          return l.at >= a && l.at <= b && f.topics.every((t, i) => i === 0 || t === null || t === undefined || t === topics[i]);
        })
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

const RH_X = "0x4a0e650000000000000000000000000000005eea"; // stand-in for the coordinator's 0x4a0e65…5eea
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

test("L1 a token whose pool has an unpinned hook that takes a fee is bought through it: R is held to every other pool", async () => {
  const token = "0x00000000000000000000000000000000000ac1ac";
  // the route's pool keeps a tenth through its hook; a standard pool gives half
  const hooked: ModelPool = { key: keyOf(token, NATIVE, 3000, 60, UNPINNED), give: (a) => a, lie: (a) => a - a / 10n };
  const half: ModelPool = { key: keyOf(token, NATIVE, 10000, 200, NATIVE), give: (a) => a / 2n };
  const route: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: token, fee: 3000, tickSpacing: 60, hooks: UNPINNED, hookData: "0x" }] };
  // found by the scan and listed by the caller too
  const q = await evmPoolBuyQuoteWith({ chain: "base", token, amountIn: AMOUNT, slippageBps: 100, route, pools: [hooked.key] }, [chain([hooked, half], 0), chain([hooked, half], 1)], NOW, scanner(5_000_000, [{ key: hooked.key, at: 4_500_000 }]));
  assert.equal(q.amountOut, AMOUNT - AMOUNT / 10n);
  assert.equal(q.reference?.amountOut, AMOUNT / 2n);
  assert.deepEqual([q.hook?.hookless, q.hook?.take, q.hook?.takeBps], [AMOUNT, AMOUNT / 10n, 1000]);
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

test("K1b the backstop: a pool no route prices that holds more of the token than R's pool refuses the buy", async () => {
  const token = "0x00000000000000000000000000000000000ad3ad";
  // the same price as R's pool, ten thousand times its liquidity
  const kimphil: ModelPool = { key: keyOf(token, xAt(3), 0x800000, 8, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 24n] };
  const v = await quoteOn([best(token), kimphil], token, bestRoute(token), scanner(5_000_000, [{ key: kimphil.key, at: 4_500_000 }]));
  assert.deepEqual(v, { accepted: false, code: "no_reference" });
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

test("X2 past sixteen currencies the one holding the least of the token is not priced: shallower than R's pool, it cannot raise R or block", async () => {
  const token = "0x00000000000000000000000000000000000ff2ff";
  const deeper = Array.from({ length: 16 }, (_, i): ModelPool => ({ key: keyOf(token, xAt(0x200 + i), 3000, 60, NATIVE), give: (a) => a }));
  const x17 = xAt(0x210);
  // the oldest, and a hundredth of the others' liquidity: last by depth
  const shallow: ModelPool = { key: keyOf(token, x17, 3000, 60, NATIVE), give: (a) => a, state: [DEEP_PRICE, 10n ** 18n] };
  const market: ModelPool = { key: keyOf(x17, NATIVE, 2500, 50, NATIVE), give: (a) => 100n * a };
  const logs = [{ key: shallow.key, at: 4_050_000 }, ...deeper.map((o, i) => ({ key: o.key, at: 4_100_000 + i })), { key: market.key, at: 4_060_000 }];
  const v = await quoteOn([best(token), ...deeper, shallow, market], token, bestRoute(token), scanner(5_000_000, logs));
  assert.equal(v.accepted, true, String((v as { code?: string }).code));
});

test("X3 an X with more pools than a quote reads prices nothing: its pools of the token are held to the backstop", async () => {
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

test("T1b a token with more pools than a quote reads refuses: one past them could be its market", async () => {
  const token = "0x00000000000000000000000000000000000fe5fe";
  // one more than EVM_QUOTE_MAX_KEYS (16,384)
  const junk = Array.from({ length: 16_385 }, (_, i) => keyOf(token, NATIVE, 1000 + i, 1, NATIVE));
  // spread over the scan's depth, a thousand to a span (a span's answer holds at most 10,000 logs)
  const v = await quoteOn([best(token)], token, bestRoute(token), scanner(5_000_000, junk.map((k, i) => ({ key: k, at: 4_100_000 + 50 * i }))));
  assert.deepEqual(v, { accepted: false, code: "no_reference" });
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
  const x = xAt(0x400);
  const real: ModelPool = { key: keyOf(token, x, 3000, 60, NATIVE), give: (a) => a };
  const market = marketOf(x);
  const inner = scanner(5_000_000, [{ key: real.key, at: 4_500_000 }, { key: market.key, at: 4_100_000 }]);
  const tx = "0x" + x.slice(2).padStart(64, "0");
  // the scan provider answers the token's logs, and no logs for x's
  const broken: EvmRpc = async (calls) => {
    const out = (await inner(calls)) as { result?: unknown }[];
    return out.map((a, i) => (calls[i]!.method === "eth_getLogs" && (calls[i]!.params[0] as { topics: unknown[] }).topics.includes(tx) ? { ...a, result: null } : a));
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
