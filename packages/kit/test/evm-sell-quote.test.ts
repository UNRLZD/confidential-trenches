// The device's own sell quote (src/checks/evm/quote.ts evmPoolSellQuote; card evm-sell-device-quote) and the sell the
// kit's index builds only from it (src/trade/evm/sell.ts), on a modelled chain: a provider decodes each aggregate3 call
// and answers each quote from a price model, the factory and getPool reads, and the fee-on-transfer probe run as W's
// code. Each planted lie is a server's or an RPC's: a quote off on one RPC, a server's route, a fee-on-transfer token,
// a stale quote, an unlisted hook, a pool that runs out, a hand-made quote.
import { mock, test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import * as kit from "../src/index.ts";
import { evmPoolVenues, type EvmPoolChain } from "../src/trade/evm/buy-unpinned.ts";
import { evmPoolBuildSimSellUnpinned, evmPoolSignSellUnpinned, evmPoolSignSimSellUnpinned, evmSellCallData, pinnedBuildSell, pinnedSignSimSell } from "../src/trade/evm/sell-unpinned.ts";
import { AMOUNT, BOUGHT, NATIVE, TOKEN, V3_POOL, WALLET, flat, provider, req, sell, sellQuoteWith, verdict, type Pool, type Seen } from "./evm-sell-quote-fx.ts";

const keccak = (t: string) => keccak_256(new TextEncoder().encode(t));

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
  const fields = { precommitment: 0x5e11n, feeCap: 10n ** 13n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n };
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
  const fields = { precommitment: 0x5e11n, feeCap: 10n ** 13n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n };
  const later = Number(q.block.timestamp) * 1000 + 30_001;
  enableTimers(mock.timers, { apis: ["Date"], now: later });
  try {
    assert.throws(() => kit.evmPoolBuildSell(q, fields), (e: unknown) => (e as { code?: string }).code === "stale_quote");
  } finally {
    resetTimers(mock.timers);
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
  const req = { token: TOKEN, w: WALLET, amountIn: AMOUNT, slippageBps: 100, bought: BOUGHT, boughtBlock: 1n } as Record<string, unknown>;
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

// card evm-quote-exec-sim: W signs a sim sell only into EVM_SELL_SIM, with a deadline at most the agreed block's time,
// itself at most the device's clock. Such a signature can never land for one reason: the deposit into the codeless
// sim pool reverts when its empty answer is decoded. The deadline does not stop it: later blocks can share the agreed
// block's timestamp (Robinhood blocks 105948851-105948858 share one), and SellDelegate.sol:140 refuses only after it
test("planted: the sim signer refuses a live deadline, the real pool, a block past the device's clock, and a real sell", () => {
  const key = hardhatAccount0();
  const ts = 1_793_798_391n;
  const hops = [{ currency: NATIVE, fee: 3000, tickSpacing: 60, hooks: "0x00000000000000000000000000000000000020cc", hookData: "0x" }];
  const sim = (o: Partial<{ deadline: bigint }> = {}) => evmPoolBuildSimSellUnpinned("base-sepolia", { w: WALLET, token: TOKEN, amount: AMOUNT, hops, minOut: 1n, nonce: 3n, deadline: ts, ...o });
  const now = Number(ts) * 1000 + 2000;
  // the sim pool: the low 20 bytes of keccak256("blindfill.sell.sim.v1")
  assert.equal(kit.EVM_SELL_SIM, "0x" + Buffer.from(keccak("blindfill.sell.sim.v1")).subarray(12).toString("hex"));
  const s = sim();
  assert.equal(s.pool, kit.EVM_SELL_SIM);
  const sig = evmPoolSignSimSellUnpinned(key, "base-sepolia", s, ts, now);
  assert.equal(sig.length, 65);
  // the signature is W's, over the sim as SellDelegate digests it (its EIP-712 digest written out here, as
  // SellDelegate._sellDigest makes it under W's own address and Base Sepolia's chain id), and its calldata carries the
  // sim exactly
  const w32 = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
  const a32 = (a: string) => w32(BigInt(a));
  const domain = keccak_256(Buffer.concat([keccak("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak("Blindfill"), keccak("1"), w32(84532n), a32(WALLET)]));
  const struct = keccak_256(Buffer.concat([
    keccak("Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,uint256 deadline,uint256 nonce)"),
    a32(s.token), w32(s.amount), a32(s.target), keccak_256(Buffer.from(s.data.slice(2), "hex")), w32(s.minOut), a32(s.pool), w32(s.precommitment), w32(s.feeCap), w32(s.deadline), w32(s.nonce),
  ]));
  const digest = keccak_256(Buffer.concat([Uint8Array.of(0x19, 0x01), domain, struct]));
  assert.ok(sig[64] === 27 || sig[64] === 28, "v is 27 or 28");
  const pub = secp256k1.recoverPublicKey(Uint8Array.of(sig[64]! - 27, ...sig.subarray(0, 64)), digest, { prehash: false });
  const signer = "0x" + Buffer.from(keccak_256(secp256k1.Point.fromBytes(pub).toBytes(false).subarray(1)).subarray(12)).toString("hex");
  assert.equal(signer, WALLET, "the sim's signature recovers to W");
  const data = evmSellCallData(s, 0n, sig);
  assert.equal(data.slice(2, 10), Buffer.from(keccak("sell((address,uint256,address,bytes,uint256,address,uint256,uint256,uint256,uint256),uint256,bytes)")).subarray(0, 4).toString("hex"));
  const code = (f: () => unknown) => {
    try {
      f();
      return "signed";
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  // a live deadline: one second past the block
  assert.equal(code(() => evmPoolSignSimSellUnpinned(key, "base-sepolia", sim({ deadline: ts + 1n }), ts, now)), "bad_deadline");
  // the agreed block past the device's clock
  assert.equal(code(() => evmPoolSignSimSellUnpinned(key, "base-sepolia", s, ts, Number(ts) * 1000 - 1)), "bad_deadline");
  // the real pool: a copy of the sim into it is no sim the builder made, and the builder makes none
  assert.equal(code(() => evmPoolSignSimSellUnpinned(key, "base-sepolia", { ...s, pool: evmPoolVenues()["base-sepolia"].pool! }, ts, now)), "not_built");
  // the sell signer never signs a sim, the sim signer never a real sell
  assert.equal(code(() => evmPoolSignSellUnpinned(key, "base-sepolia", s)), "not_built");
  const real = pinnedBuildSell(evmPoolVenues(), "base-sepolia", { w: WALLET, token: TOKEN, amount: AMOUNT, target: evmPoolVenues()["base-sepolia"].poolManager!, route: { venue: "uniswap-v4", hops: [{ ...hops[0]!, hooks: NATIVE }] }, minOut: 2n, precommitment: 1n, feeCap: 1n, deadline: BigInt(Math.floor(Date.now() / 1000) + 120), nonce: 3n });
  assert.equal(code(() => evmPoolSignSimSellUnpinned(key, "base-sepolia", real as never, ts, now)), "not_built");
  // a key not W's; a chain with no pinned sell delegate
  assert.equal(code(() => evmPoolSignSimSellUnpinned(new Uint8Array(32).fill(7), "base-sepolia", s, ts, now)), "bad_key");
  assert.equal(code(() => pinnedSignSimSell(evmPoolVenues(), key, "base", s, ts, now)), "not_deployed");
});

// card evm-buy-hookdata-fee: the sender's fee cap was the caller's, bounded only by minOut (review low L3)
test("planted: the sender's fee cap is the device's own rule's at the agreed block, never above it: a caller's higher cap is refused bad_fee", async () => {
  const code = (f: () => unknown) => {
    try {
      f();
      return "built";
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  };
  const f = { precommitment: 0x5e11n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n };
  // 2 x EVM_POOL_SELL_GAS (1,000,000) x (the block's base fee + the sale's tip: Base's 1,000,000 wei, Robinhood's 0),
  // rounded up to the 1e13 wei step, at least one step
  const cases: [EvmPoolChain, bigint, bigint][] = [
    ["base-sepolia", 5_000_000n, 20_000_000_000_000n],
    ["base-sepolia", 0n, 10_000_000_000_000n],
    ["robinhood-testnet", 30_000_000_000n, 60_000_000_000_000_000n],
    ["robinhood-testnet", 0n, 10_000_000_000_000n],
  ];
  for (const [chain, baseFee, want] of cases) {
    const q = await sellQuoteWith(req(chain), [provider({ price: flat, baseFee }), provider({ price: flat, baseFee })], Date.now());
    assert.equal((q as { feeMax?: bigint }).feeMax, want, `${chain} at ${baseFee}`);
    // no cap named: the rule's; the rule's own or a lower one: as named; above it: refused
    assert.equal(kit.evmPoolBuildSell(q, f).feeCap, want);
    assert.equal(kit.evmPoolBuildSell(q, { ...f, feeCap: want }).feeCap, want);
    assert.equal(kit.evmPoolBuildSell(q, { ...f, feeCap: want - 1n }).feeCap, want - 1n);
    assert.equal(code(() => kit.evmPoolBuildSell(q, { ...f, feeCap: want + 1n })), "bad_fee");
    assert.equal(code(() => kit.evmPoolBuildSell(q, { ...f, feeCap: q.minOut - 1n })), "bad_fee");
  }
  // a block that names no base fee caps nothing: no quote
  assert.deepEqual(await verdict(sell({ price: flat, baseFee: null })), { accepted: false, code: "rpc_error" });
});

test("L1 the sender's fee cap counts the chain fee read at the agreed block on both providers: Base's L1 fee bound and operator fee, Robinhood's L1 base fee", async () => {
  // Base Sepolia at a 5,000,000 wei base fee: 2 x (1,000,000 x 6,000,000 + 4e13 + 1e13) = 1.12e14, up to 1.2e14
  const op = { f1c7a58b: 4n * 10n ** 13n, "275aedd2": 10n ** 13n };
  const b = await sellQuoteWith(req("base-sepolia"), [provider({ price: flat, chainFee: op }), provider({ price: flat, chainFee: op })], Date.now());
  assert.equal(b.feeMax, 120_000_000_000_000n);
  // Robinhood testnet at 3e10: 2 x (1,000,000 x 3e10 + 16 x 2,600 x 1e9) = 6.0083200e16, up to 6.0090e16
  const arb = { f5d6ded7: 10n ** 9n };
  const r = await sellQuoteWith(req("robinhood-testnet"), [provider({ price: flat, baseFee: 30_000_000_000n, chainFee: arb }), provider({ price: flat, baseFee: 30_000_000_000n, chainFee: arb })], Date.now());
  assert.equal(r.feeMax, 60_090_000_000_000_000n);
  // an oracle that reverts caps nothing; one provider's other answer is a disagreement
  assert.deepEqual(await verdict(sell({ price: flat, chainFee: { f1c7a58b: null } }, "base-sepolia")), { accepted: false, code: "rpc_error" });
  assert.deepEqual(await verdict(sell({ price: flat }, "base-sepolia", {}, { price: flat, chainFee: { "275aedd2": 1n } })), { accepted: false, code: "rpc_disagree" });
});

test("L5 a sell whose minOut less the fee rule's cap is under the pool's MIN_DEPOSIT is refused below_minimum: its deposit back would revert", async () => {
  // every pool pays `x` for AMOUNT (in proportion), so minOut = floor(x x 9,900 / 10,000); Base Sepolia's cap is 2e13
  const at = (x: bigint) => sell({ price: (p: Pool) => (p.amount * x) / AMOUNT }, "base-sepolia");
  // minOut 1.2e14: exactly MIN_DEPOSIT 1e14 over the cap, quoted
  const ok = await at(121_212_121_212_122n);
  assert.equal(ok.minOut - ok.feeMax, 10n ** 14n);
  // a wei under it, refused
  assert.deepEqual(await verdict(at(121_212_121_212_121n)), { accepted: false, code: "below_minimum" });
  assert.deepEqual(await verdict(at(10n ** 13n)), { accepted: false, code: "below_minimum" });
});

test("planted: a sell quote takes the buy's block (boughtBlock): none, 0, a negative or a number is refused bad_request", async () => {
  for (const boughtBlock of [undefined, 0n, -1n, 256]) {
    assert.deepEqual(await verdict(sell({ price: flat }, "base", { boughtBlock })), { accepted: false, code: "bad_request" }, String(boughtBlock));
  }
  assert.equal((await verdict(sell({ price: flat }, "base", { boughtBlock: 1n }))).accepted, true);
});
