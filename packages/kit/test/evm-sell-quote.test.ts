// The device's own sell quote (src/checks/evm/quote.ts evmPoolSellQuote; card evm-sell-device-quote) and the sell the
// kit's index builds only from it (src/trade/evm/sell.ts), on a modelled chain: a provider decodes each aggregate3 call
// and answers each quote from a price model, the factory and getPool reads, and the fee-on-transfer probe run as W's
// code. Each planted lie is a server's or an RPC's: a quote off on one RPC, a server's route, a fee-on-transfer token,
// a stale quote, an unlisted hook, a pool that runs out, a hand-made quote.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import * as kit from "../src/index.ts";
// the quote module as a namespace: the red run before the card reads it where evmPoolSellQuoteWith is not there yet
import * as quoteMod from "../src/checks/evm/quote.ts";
import type { EvmRpc, EvmRpcCall } from "../src/checks/evm/quote.ts";
import { evmPoolVenues, type EvmPoolChain } from "../src/trade/evm/buy-unpinned.ts";
import { pinnedBuildSell } from "../src/trade/evm/sell-unpinned.ts";

const W = (v: bigint) => v.toString(16).padStart(64, "0");
const NATIVE = "0x0000000000000000000000000000000000000000";
const TOKEN = "0x1111111111111111111111111111111111111111";
const WALLET = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // Hardhat account 0, a published test key
const FACTORY = "0x00000000000000000000000000000000000fac70";
const V3_POOL = "0x0000000000000000000000000000000000000b01";
const HASH = "0x" + "bb".repeat(32);
const AMOUNT = 10n ** 18n;
const sellQuoteWith = (quoteMod as unknown as { evmPoolSellQuoteWith: (...a: unknown[]) => Promise<kit.EvmPoolSellQuote> }).evmPoolSellQuoteWith;

type Pool = { venue: "v3" | "v4"; hops: number; from: string; to: string[]; fees: number[]; spacings: number[]; hooks: string[]; amount: bigint };
// one quoter call's shape, from its calldata (as test/evm-quote-attacks.test.ts reads a buy's)
function poolOf(h: string): Pool {
  const sel = h.slice(0, 8);
  const d = h.slice(8);
  const w = (i: number) => BigInt("0x" + d.slice(64 * i, 64 * i + 64));
  const addr = (i: number) => "0x" + d.slice(64 * i + 24, 64 * i + 64);
  if (sel === "cdca1753") {
    const len = Number(w(2));
    const path = d.slice(64 * 3, 64 * 3 + 2 * len);
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
    assert.equal(w(at + 4), 0xa0n);
    assert.equal(w(at + 5), 0n, "every hop's hook data is empty"); // the device's own, never a route's
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

type Model = {
  price: (p: Pool) => bigint | null;
  /** what the probe answers for (token, to, amount); null: it reverts */
  probe?: (token: string, to: string, amount: bigint) => bigint | null;
  headSec?: number;
};
type Seen = { pools: Pool[]; probes: { w: string; token: string; to: string; amount: bigint; code: string }[] };
/** A provider on the modelled chain; every quote it is asked lands in `seen`. */
function provider(m: Model, seen: Seen = { pools: [], probes: [] }): EvmRpc {
  const head = { number: "0x100", hash: HASH, timestamp: "0x" + (m.headSec ?? Math.floor(Date.now() / 1000) - 2).toString(16) };
  const one = (data: string): bigint | null => {
    const sel = data.slice(0, 8);
    if (sel === "c45a0155") return BigInt(FACTORY);
    if (sel === "1698ee82") return BigInt(V3_POOL);
    const p = poolOf(data);
    seen.pools.push(p);
    return m.price(p);
  };
  return async (calls: readonly EvmRpcCall[]) =>
    calls.map((c, id) => {
      if (c.method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id, result: { ...head } };
      assert.equal(c.method, "eth_call");
      const { to, data } = c.params[0] as { to: string; data: string };
      assert.equal((c.params[1] as { blockHash: string }).blockHash, HASH);
      const override = c.params[2] as Record<string, { code: string }> | undefined;
      let out: bigint | null;
      if (to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11") {
        assert.equal(override, undefined);
        return { jsonrpc: "2.0", id, result: encodeAggregate(decodeAggregate(data).map(one)) };
      }
      if (override !== undefined) {
        const d = data.slice(2);
        const probe = { w: to.toLowerCase(), token: "0x" + d.slice(24, 64), to: "0x" + d.slice(88, 128), amount: BigInt("0x" + d.slice(128, 192)), code: override[to]?.code ?? "" };
        seen.probes.push(probe);
        out = (m.probe ?? ((_t, _to, a) => a))(probe.token, probe.to, probe.amount);
      } else out = one(data.slice(2));
      return out === null ? { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } } : { jsonrpc: "2.0", id, result: "0x" + W(out) };
    });
}
const verdict = async (p: Promise<kit.EvmPoolSellQuote>) => {
  try {
    const q = await p;
    return { accepted: true, venue: q.route.venue, amountOut: q.amountOut, minOut: q.minOut };
  } catch (e) {
    if (!(e instanceof kit.EvmQuoteError)) throw e;
    return { accepted: false, code: e.code };
  }
};
// the route the buy that paid W took (required, review of edb4dbb F3): the standard 0.3% native pool
const BOUGHT = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" }] };
const req = (chain: EvmPoolChain = "base", o: Record<string, unknown> = {}) => ({ chain, token: TOKEN, w: WALLET, amountIn: AMOUNT, slippageBps: 100, bought: BOUGHT, ...o });
const sell = (m: Model, chain: EvmPoolChain = "base", o: Record<string, unknown> = {}, m2: Model = m) =>
  sellQuoteWith(req(chain, o), [provider(m), provider(m2)], Date.now());
/** v4 to the native asset, fee 3000: 2 ETH a token; every other pool 1 */
const flat = (p: Pool) => (p.venue === "v4" && p.hops === 1 && p.to[0] === NATIVE && p.fees[0] === 3000 ? 2n * p.amount : p.amount);

test("the device picks the pool: the best of its own candidates, minOut from it, on both providers", async () => {
  const seen: Seen = { pools: [], probes: [] };
  const q = await sellQuoteWith(req(), [provider({ price: flat }, seen), provider({ price: flat })], Date.now());
  assert.equal(q.route.venue, "uniswap-v4");
  assert.deepEqual(q.route.venue === "uniswap-v4" && q.route.hops.map((h) => [h.currency, h.fee, h.tickSpacing, h.hooks, h.hookData]), [[NATIVE, 3000, 60, NATIVE, "0x"]]);
  assert.equal(q.amountOut, 2n * AMOUNT);
  assert.equal(q.minOut, (2n * AMOUNT * 9900n) / 10000n);
  assert.equal(q.target, evmPoolVenues().base.poolManager!.toLowerCase());
  assert.ok(Object.isFrozen(q) && Object.isFrozen(q.route) && kit.evmIsDeviceSellQuote(q));
  // every read sells the token, and each candidate is read at the amount and at twice it
  assert.ok(seen.pools.every((p) => p.from === TOKEN));
  assert.equal(seen.pools.filter((p) => p.amount === AMOUNT).length, seen.pools.filter((p) => p.amount === 2n * AMOUNT).length);
  // the probe: W's code replaced by the probe, the amount from W to the PoolManager
  assert.deepEqual(seen.probes, [{ w: WALLET, token: TOKEN, to: evmPoolVenues().base.poolManager!.toLowerCase(), amount: AMOUNT, code: kit.EVM_SELL_PROBE_CODE }]);
});

test("a v3 pool is picked when it pays more, through the chain's router, the probe to the v3 pool getPool names", async () => {
  const seen: Seen = { pools: [], probes: [] };
  const price = (p: Pool) => (p.venue === "v3" && p.hops === 1 && p.fees[0] === 500 ? 3n * p.amount : p.amount);
  const q = await sellQuoteWith(req(), [provider({ price }, seen), provider({ price })], Date.now());
  assert.deepEqual(q.route, { venue: "uniswap-v3", tokens: [TOKEN, evmPoolVenues().base.weth.toLowerCase()], fees: [500] });
  assert.equal(q.target, evmPoolVenues().base.routers[0]!.toLowerCase());
  assert.equal(seen.probes[0]!.to, V3_POOL);
});

test("planted: a quote off on one RPC is refused (rpc_disagree)", async () => {
  const off = (p: Pool) => (p.venue === "v4" && p.to[0] === NATIVE && p.fees[0] === 3000 && p.amount === AMOUNT ? 3n * p.amount : flat(p));
  assert.deepEqual(await verdict(sell({ price: flat }, "base", {}, { price: off })), { accepted: false, code: "rpc_disagree" });
  // and a probe answer off on one RPC
  assert.deepEqual(await verdict(sell({ price: flat }, "base", {}, { price: flat, probe: (_t, _to, a) => a - 1n })), { accepted: false, code: "rpc_disagree" });
});

test("planted: a server's route is never taken: a request with a route is refused, and the builder takes only the device's quote", async () => {
  const route = { venue: "uniswap-v4", hops: [{ currency: NATIVE, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" }] };
  assert.deepEqual(await verdict(sell({ price: flat }, "base", { route })), { accepted: false, code: "bad_request" });
  assert.deepEqual(await verdict(sell({ price: flat }, "base", { route: undefined })), { accepted: false, code: "bad_request" });
  const fields = { precommitment: 0x5e11n, feeCap: 10n ** 14n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n };
  const code = (f: () => unknown) => {
    try {
      f();
      return "built";
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  };
  const build = kit.evmPoolBuildSell as (...a: unknown[]) => kit.EvmPoolSell;
  // the route-taking request of the old builder, a copy of a device quote, a quote with the server's route spliced in
  const old = { w: WALLET, token: TOKEN, amount: AMOUNT, target: evmPoolVenues()["base-sepolia"].poolManager, route, minOut: 1n, ...fields };
  assert.equal(code(() => build("base-sepolia", old)), "bad_request");
  const q = await sellQuoteWith(req("base-sepolia"), [provider({ price: flat }), provider({ price: flat })], Date.now());
  assert.equal(code(() => build({ ...q }, fields)), "bad_request");
  assert.equal(code(() => build({ ...q, route: { venue: "uniswap-v3", tokens: [TOKEN, evmPoolVenues()["base-sepolia"].weth], fees: [100] } }, fields)), "bad_request");
  // the signer signs only a sell the quoted builder returned: the pinned builder's sell of a server's route is refused
  const W_KEY = hardhatAccount0();
  const serverSell = pinnedBuildSell(evmPoolVenues(), "base-sepolia", { w: WALLET, token: TOKEN, amount: AMOUNT, target: evmPoolVenues()["base-sepolia"].poolManager!, route: route as kit.EvmSellRoute, minOut: 10n ** 15n, ...fields });
  assert.equal(code(() => kit.evmPoolSignSell(W_KEY, "base-sepolia", serverSell)), "not_built");
  // the device's own quote builds and signs, into the chain's pinned pool, at the quote's minOut
  const built = build(q, fields);
  assert.equal(built.minOut, q.minOut);
  assert.equal(built.target, evmPoolVenues()["base-sepolia"].poolManager);
  assert.equal(built.pool, evmPoolVenues()["base-sepolia"].pool);
  assert.equal(kit.evmPoolSignSell(W_KEY, "base-sepolia", built).length, 65);
});

test("planted: a fee-on-transfer token is refused (fee_on_transfer): a short delivery, a revert, a delivery above the amount", async () => {
  assert.deepEqual(await verdict(sell({ price: flat, probe: (_t, _to, a) => (a * 99n) / 100n })), { accepted: false, code: "fee_on_transfer" });
  assert.deepEqual(await verdict(sell({ price: flat, probe: () => null })), { accepted: false, code: "fee_on_transfer" });
  assert.deepEqual(await verdict(sell({ price: flat, probe: (_t, _to, a) => a + 1n })), { accepted: false, code: "fee_on_transfer" });
  assert.deepEqual(await verdict(sell({ price: flat })), { accepted: true, venue: "uniswap-v4", amountOut: 2n * AMOUNT, minOut: (2n * AMOUNT * 9900n) / 10000n });
});

test("planted: a stale quote is refused, when quoted (a head 31 s old) and when built (31 s after its block)", async () => {
  const old = Math.floor(Date.now() / 1000) - 31;
  assert.deepEqual(await verdict(sell({ price: flat, headSec: old })), { accepted: false, code: "stale_quote" });
  const q = await sellQuoteWith(req("base-sepolia"), [provider({ price: flat }), provider({ price: flat })], Date.now());
  const fields = { precommitment: 0x5e11n, feeCap: 10n ** 14n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n };
  const later = Number(q.block.timestamp) * 1000 + 30_001;
  mock.timers.enable({ apis: ["Date"], now: later });
  try {
    assert.throws(() => kit.evmPoolBuildSell(q, fields), (e: unknown) => (e as { code?: string }).code === "stale_quote");
  } finally {
    mock.timers.reset();
  }
  assert.equal(kit.evmPoolBuildSell(q, fields).minOut, q.minOut);
});

test("planted: an unlisted hook is never quoted; a listed one is, with its own key and empty hook data", async () => {
  const B = evmPoolVenues().base;
  const listed = new Set([NATIVE, ...B.hookedPools!.map((h) => h.hooks.toLowerCase())]);
  const seen: Seen = { pools: [], probes: [] };
  // any hooked pool pays 10x: a server that seeded one behind its own hook cannot get it read
  const price = (p: Pool) => (p.hooks.some((h) => h !== NATIVE) ? 10n * p.amount : flat(p));
  await sellQuoteWith(req(), [provider({ price }, seen), provider({ price })], Date.now());
  assert.ok(seen.pools.every((p) => p.hooks.every((h) => listed.has(h))));
  // every listed launchpad pool is read with its own fee, tick spacing and paired asset
  for (const h of B.hookedPools!) {
    const to = h.from === "native" ? NATIVE : B.weth.toLowerCase();
    assert.ok(seen.pools.some((p) => p.hooks[0] === h.hooks.toLowerCase() && p.fees[0] === h.fee && p.spacings[0] === h.tickSpacing && p.to[0] === to), h.pad);
  }
  const clanker = B.hookedPools!.find((h) => h.pad === "clanker")!;
  const only = (p: Pool) => (p.hooks[0] === clanker.hooks.toLowerCase() ? 5n * p.amount : p.amount);
  const q = await sellQuoteWith(req(), [provider({ price: only }), provider({ price: only })], Date.now());
  assert.deepEqual(q.route.venue === "uniswap-v4" && q.route.hops, [{ currency: B.weth.toLowerCase(), fee: clanker.fee, tickSpacing: clanker.tickSpacing, hooks: clanker.hooks.toLowerCase(), hookData: "0x" }]);
  // a token that is a listed hook's own address: that hook is not read for it (its pool would swap through itself)
  const self: Seen = { pools: [], probes: [] };
  await sellQuoteWith(req("base", { token: clanker.hooks, bought: { ...BOUGHT, hops: [{ ...BOUGHT.hops[0]!, currency: clanker.hooks }] } }), [provider({ price: flat }, self), provider({ price: flat })], Date.now());
  assert.ok(self.pools.length > 0 && self.pools.every((p) => p.hooks.every((h) => h !== clanker.hooks.toLowerCase())));
});

test("planted: a pool that runs out is not picked (its output does not grow), and none filling is no_quote", async () => {
  // the best pool at the amount quotes the same at twice it: it ran out
  const capped = (p: Pool) => (p.venue === "v4" && p.to[0] === NATIVE && p.fees[0] === 3000 ? 5n * AMOUNT : p.amount);
  assert.deepEqual(await verdict(sell({ price: capped })), { accepted: true, venue: "uniswap-v3", amountOut: AMOUNT, minOut: (AMOUNT * 9900n) / 10000n });
  // a v3 pool whose twice reverts does not fill
  const v3only = (p: Pool) => (p.venue === "v3" ? (p.hops === 1 && p.fees[0] === 500 && p.amount === AMOUNT ? 3n * AMOUNT : null) : p.amount);
  assert.equal((await verdict(sell({ price: v3only }))).venue, "uniswap-v4");
  assert.deepEqual(await verdict(sell({ price: () => null })), { accepted: false, code: "no_quote" });
  assert.deepEqual(await verdict(sell({ price: () => 0n })), { accepted: false, code: "no_quote" });
  // a quote whose minimum rounds to 0 builds nothing
  assert.deepEqual(await verdict(sell({ price: (p) => p.amount / AMOUNT }, "base")), { accepted: false, code: "no_quote" });
});

test("a chain with no v3 router sells through v4 only; the request's fields are checked", async () => {
  const seen: Seen = { pools: [], probes: [] };
  const q = await sellQuoteWith(req("robinhood-testnet"), [provider({ price: (p) => p.amount }, seen), provider({ price: (p) => p.amount })], Date.now());
  assert.ok(seen.pools.every((p) => p.venue === "v4"));
  // its own v4 set, not only the bought route (0.3%): every standard native pool is quoted
  for (const fee of [100, 500, 3000, 10000]) assert.ok(seen.pools.some((p) => p.hops === 1 && p.to[0] === NATIVE && p.fees[0] === fee), `fee ${fee}`);
  assert.equal(q.target, evmPoolVenues()["robinhood-testnet"].poolManager);
  const v = (o: Record<string, unknown>) => verdict(sell({ price: flat }, "base", o));
  assert.equal((await v({ token: evmPoolVenues().base.weth })).code, "bad_request");
  assert.equal((await v({ token: NATIVE })).code, "bad_request");
  assert.equal((await v({ w: TOKEN })).code, "bad_request");
  assert.equal((await v({ w: evmPoolVenues().base.poolManager })).code, "bad_request"); // the probe never replaces an address the reads call
  assert.equal((await v({ amountIn: 0n })).code, "bad_request");
  assert.equal((await v({ amountIn: 1n << 127n })).code, "bad_request");
  assert.equal((await v({ slippageBps: 10000 })).code, "bad_request");
  assert.equal((await v({ slippageBps: 1.5 })).code, "bad_request");
  const one = provider({ price: flat });
  assert.equal((await verdict(sellQuoteWith(req(), [one, one], Date.now()))).code, "bad_request");
  // the kit's index quotes only on the chain's pinned providers: no provider is taken from a caller
  assert.equal(kit.evmPoolSellQuote.length, 1);
});

/** Hardhat account 0 (m/44'/60'/0'/0/0 of the published test mnemonic), BIP-39 and BIP-32 written out. */
function hardhatAccount0(): Uint8Array {
  const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
  const N = secp256k1.Point.CURVE().n;
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

test("the sell quote reads each field of its request once (review of c71a4d0..a9f1d32, LOW 2): a getter cannot name one chain for the providers and another for the reads", async () => {
  let reads = 0;
  const req = { token: TOKEN, w: WALLET, amountIn: AMOUNT, slippageBps: 100, bought: BOUGHT } as Record<string, unknown>;
  Object.defineProperty(req, "chain", { enumerable: true, get: () => (reads++ === 0 ? "base" : "robinhood") });
  // no network: every provider request fails at once
  const f = mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });
  try {
    await assert.rejects(kit.evmPoolSellQuote(req as unknown as kit.EvmPoolSellQuoteRequest), (e: unknown) => (e as { code?: string }).code === "rpc_error");
  } finally {
    f.mock.restore();
  }
  assert.equal(reads, 1);
});
