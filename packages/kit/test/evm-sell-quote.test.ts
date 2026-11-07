// The device's own sell quote (src/checks/evm/quote.ts evmPoolSellQuote; card evm-sell-device-quote) and the sell the
// kit's index builds only from it (src/trade/evm/sell.ts), on a modelled chain: a provider decodes each aggregate3 call
// and answers each quote from a price model, the factory and getPool reads, and the fee-on-transfer probe run as W's
// code. Each planted lie is a server's or an RPC's: a quote off on one RPC, a server's route, a fee-on-transfer token,
// a stale quote, an unlisted hook, a pool that runs out, a hand-made quote.
import { beforeEach, mock, test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import { onTestClock } from "./test-clock.ts";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import * as kit from "../src/index.ts";
import { evmPoolVenues, type EvmPoolChain } from "../src/trade/evm/buy-unpinned.ts";
import { evmPoolBuildSimSellUnpinned, evmPoolSignSellUnpinned, evmPoolSignSimSellUnpinned, evmSellCallData, pinnedBuildSell, pinnedSignSimSell } from "../src/trade/evm/sell-unpinned.ts";
import { evmQuotedSell } from "../src/trade/evm/quoted.ts";
import * as quoteMod from "../src/checks/evm/quote.ts";
import type { EvmRpc, EvmRpcCall } from "../src/checks/evm/quote.ts";
import * as releasesMod from "../src/trade/evm/sell-releases.ts";
import { AMOUNT, BOUGHT, NATIVE, TOKEN, TOPIC_BOUGHT, TOPIC_WITHDRAWN, V3_POOL, WALLET, flat, provider, req, sell, sellQuoteWith, verdict, type Model, type Pool, type Release, type Seen } from "./evm-sell-quote-fx.ts";

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
  const fields = { precommitment: 0x5e11n, feeCap: 10n ** 13n, feeRecipient: evmPoolVenues()["base-sepolia"].feeCollector!, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n };
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
  const fields = { precommitment: 0x5e11n, feeCap: 10n ** 13n, feeRecipient: evmPoolVenues()["base-sepolia"].feeCollector!, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n };
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
  // a listed launchpad's hook is no pool to ban (card evm-sell-hook-converge): the quote names none
  assert.deepEqual(q.hooked, []);
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

test("the sell quote reads each field of its request once (review of c71a4d0..a9f1d32, LOW 2): a getter cannot name one chain for the providers and another for the reads", () => onTestClock(async () => {
  let reads = 0;
  const req = { token: TOKEN, w: WALLET, amountIn: AMOUNT, slippageBps: 100, bought: BOUGHT, boughtBlock: 1n, sent: [] } as Record<string, unknown>;
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
}));

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
  // its fee recipient too (card pool-review-3: SellDelegate refuses zero and W; the fee is 0)
  assert.equal(s.feeRecipient, kit.EVM_SELL_SIM);
  const sig = evmPoolSignSimSellUnpinned(key, "base-sepolia", s, ts, now);
  assert.equal(sig.length, 65);
  // the signature is W's, over the sim as SellDelegate digests it (its EIP-712 digest written out here, as
  // SellDelegate._sellDigest makes it under W's own address and Base Sepolia's chain id), and its calldata carries the
  // sim exactly
  const w32 = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
  const a32 = (a: string) => w32(BigInt(a));
  const domain = keccak_256(Buffer.concat([keccak("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak("Blindfill"), keccak("1"), w32(84532n), a32(WALLET)]));
  const struct = keccak_256(Buffer.concat([
    keccak("Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)"),
    a32(s.token), w32(s.amount), a32(s.target), keccak_256(Buffer.from(s.data.slice(2), "hex")), w32(s.minOut), a32(s.pool), w32(s.precommitment), w32(s.feeCap), a32(s.feeRecipient), w32(s.deadline), w32(s.nonce),
  ]));
  const digest = keccak_256(Buffer.concat([Uint8Array.of(0x19, 0x01), domain, struct]));
  assert.ok(sig[64] === 27 || sig[64] === 28, "v is 27 or 28");
  const pub = secp256k1.recoverPublicKey(Uint8Array.of(sig[64]! - 27, ...sig.subarray(0, 64)), digest, { prehash: false });
  const signer = "0x" + Buffer.from(keccak_256(secp256k1.Point.fromBytes(pub).toBytes(false).subarray(1)).subarray(12)).toString("hex");
  assert.equal(signer, WALLET, "the sim's signature recovers to W");
  const data = evmSellCallData(s, 0n, sig);
  assert.equal(data.slice(2, 10), Buffer.from(keccak("sell((address,uint256,address,bytes,uint256,address,uint256,uint256,address,uint256,uint256),uint256,bytes)")).subarray(0, 4).toString("hex"));
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
  const real = pinnedBuildSell(evmPoolVenues(), "base-sepolia", { w: WALLET, token: TOKEN, amount: AMOUNT, target: evmPoolVenues()["base-sepolia"].poolManager!, route: { venue: "uniswap-v4", hops: [{ ...hops[0]!, hooks: NATIVE }] }, minOut: 2n, precommitment: 1n, feeCap: 1n, feeRecipient: evmPoolVenues()["base-sepolia"].feeCollector!, deadline: BigInt(Math.floor(Date.now() / 1000) + 120), nonce: 3n });
  assert.equal(code(() => evmPoolSignSimSellUnpinned(key, "base-sepolia", real as never, ts, now)), "not_built");
  // a key not W's; a chain with no pinned sell delegate (a list without Base's: the kit pins every chain's since card
  // pool-evm-deploy-mainnet)
  assert.equal(code(() => evmPoolSignSimSellUnpinned(new Uint8Array(32).fill(7), "base-sepolia", s, ts, now)), "bad_key");
  const { sellDelegate: _d, ...baseNoDelegate } = evmPoolVenues().base;
  assert.equal(code(() => pinnedSignSimSell({ ...evmPoolVenues(), base: baseNoDelegate }, key, "base", s, ts, now)), "not_deployed");
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
  const fields = { precommitment: 0x5e11n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n };
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
    // the fee recipient is the chain's FeeCollector pin (card evm-testnet-delegate-review3)
    const f = { ...fields, feeRecipient: evmPoolVenues()[chain].feeCollector! };
    // no cap named: the rule's; the rule's own or a lower one: as named; above it: refused
    assert.equal(kit.evmPoolBuildSell(q, f).feeCap, want);
    // the fee recipient is checked by the builder (card pool-review-3, L-1): never W or zero (bad_fee)
    assert.equal(kit.evmPoolBuildSell(q, f).feeRecipient, f.feeRecipient);
    assert.equal(code(() => kit.evmPoolBuildSell(q, { ...f, feeRecipient: q.w })), "bad_fee");
    assert.equal(code(() => kit.evmPoolBuildSell(q, { ...f, feeRecipient: "0x0000000000000000000000000000000000000000" })), "bad_fee");
    assert.equal(kit.evmPoolBuildSell(q, { ...f, feeCap: want }).feeCap, want);
    assert.equal(kit.evmPoolBuildSell(q, { ...f, feeCap: want - 1n }).feeCap, want - 1n);
    assert.equal(code(() => kit.evmPoolBuildSell(q, { ...f, feeCap: want + 1n })), "bad_fee");
    assert.equal(code(() => kit.evmPoolBuildSell(q, { ...f, feeCap: q.minOut - 1n })), "bad_fee");
  }
  // a block that names no base fee caps nothing: no quote
  assert.deepEqual(await verdict(sell({ price: flat, baseFee: null })), { accepted: false, code: "rpc_error" });
});

// card evm-testnet-delegate-review3: the helper sends only a Sell paying the network's FeeCollector (its Paid log proves
// the fee), so the device's quoted sell pays the kit's collector pin and no other address
test("card evm-testnet-delegate-review3: a quoted sell pays its fee only to the chain's FeeCollector pin: another recipient is refused not_pinned, a venue list with no collector not_deployed", async () => {
  const code = (f: () => unknown) => {
    try {
      f();
      return "built";
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  };
  // the withdraw relayer's fee recipient a release pins (signpage test/pools-testnet.test.ts), and any other address
  const RELAYER = "0x49f2425b7f33f3a10912de8add6839226ce663a2";
  for (const chain of ["base-sepolia", "robinhood-testnet"] as EvmPoolChain[]) {
    const collector = evmPoolVenues()[chain].feeCollector!;
    const q = await sellQuoteWith(req(chain), [provider({ price: flat }), provider({ price: flat })], Date.now());
    const f = { precommitment: 0x5e11n, feeRecipient: collector, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n };
    assert.equal(kit.evmPoolBuildSell(q, f).feeRecipient, collector, chain);
    assert.equal(code(() => kit.evmPoolBuildSell(q, { ...f, feeRecipient: RELAYER })), "not_pinned", chain);
    assert.equal(code(() => kit.evmPoolBuildSell(q, { ...f, feeRecipient: "0x000000000000000000000000000000000000fee1" })), "not_pinned", chain);
    // the same quote through a venue list whose chain pins no collector
    const { feeCollector: _c, ...rest } = evmPoolVenues()[chain];
    const bare = Object.freeze({ ...evmPoolVenues(), [chain]: Object.freeze(rest) });
    assert.equal(code(() => evmQuotedSell(bare, q, f, Date.now())), "not_deployed", chain);
  }
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

// card evm-sell-no-release-in-flight (audit E-01, Pillow Auditors v1.0): SellDelegate's minOut counts any ETH that
// reaches W during the sale, so the kit builds no sell for a W while a release that pays W ETH is on its way. The quote
// reads W's releases itself at its block and carries the verdict; the builder takes no other (src/trade/evm/sell-releases.ts)
const E01_BASE = () => ({ precommitment: 0x5e11n, feeRecipient: evmPoolVenues()["base-sepolia"].feeCollector!, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n });
// the fixture's head is block 0x100 (256), its finalized block 0xe0 (224), 900 s before the head; the buy that paid W
// the token landed in block 256 (req's boughtBlock) and bought TOKEN
// the head's time, 2 s before each test's start (a quote refuses a block more than 30 s old, and the file runs longer)
let E01_HEAD = Math.floor(Date.now() / 1000) - 2;
let E01_FIN_MS = (BigInt(E01_HEAD) - 900n) * 1000n;
beforeEach(() => {
  E01_HEAD = Math.floor(Date.now() / 1000) - 2;
  E01_FIN_MS = (BigInt(E01_HEAD) - 900n) * 1000n;
});
const e01Quote = (m: Partial<Model> = {}, o: Record<string, unknown> = {}, m2: Partial<Model> = m) =>
  sellQuoteWith(req("base-sepolia", o), [provider({ price: flat, headSec: E01_HEAD, ...m }), provider({ price: flat, headSec: E01_HEAD, ...m2 })], Date.now());
const e01Why = async (m: Partial<Model> = {}, o: Record<string, unknown> = {}, m2: Partial<Model> = m): Promise<string> => {
  const q = await e01Quote(m, o, m2);
  try {
    kit.evmPoolBuildSell(q, E01_BASE());
    return "built";
  } catch (e) {
    // the error's message leads with its code
    const c = (e as { code?: string }).code;
    return c === "release_in_flight" ? (e as Error).message : `another code ${c}: ${(e as Error).message}`;
  }
};
const E01_OTHER = "0x" + "42".repeat(20);
const E01_NOTE = "change:5:1";

test("card evm-sell-no-release-in-flight: a release to W above the finalized block, on the quote's own read, refuses the sell naming the wait, but for the buy that funded it", () => onTestClock(async () => {
  assert.equal(await e01Why(), "built");
  // pending: a withdraw or a buy's fallback (both Withdrawn) that landed on W in the tail, above the finalized block
  assert.match(await e01Why({ releases: [{ kind: "withdraw", block: 240n, nullifier: 7n }] }), /^release_in_flight: 1 release to W not final on two RPCs: a release landed in block 240, above the finalized block: the sell waits until block 240 is final on both RPCs$/);
  assert.match(await e01Why({ releases: [{ kind: "withdraw", block: 225n, nullifier: 7n }] }), /landed in block 225, above the finalized block/);
  // review of 982a19bd, F2: the buy that funded this sale (the quote's token, in its boughtBlock) does not hold it
  assert.equal(await e01Why({ releases: [{ kind: "buy", block: 256n, nullifier: 7n }] }), "built");
  // review of 181fd050, R2-3: any other Bought to W in the tail does: replayed into its fallback it pays W ETH mid-sell
  assert.match(await e01Why({ releases: [{ kind: "buy", block: 250n, nullifier: 7n }] }), /^release_in_flight: 1 release to W not final on two RPCs: a release landed in block 250/);
  assert.match(await e01Why({ releases: [{ kind: "buy", block: 256n, nullifier: 7n, token: E01_OTHER }] }), /landed in block 256/);
  assert.match(await e01Why({ releases: [{ kind: "buy", block: 256n, nullifier: 7n }, { kind: "buy", block: 256n, nullifier: 8n }] }), /^release_in_flight: 1 release /);
  // final: at the finalized block; and a release in the tail paid to another address
  assert.equal(await e01Why({ releases: [{ kind: "withdraw", block: 224n, nullifier: 7n }] }), "built");
  assert.equal(await e01Why({ releases: [{ kind: "withdraw", block: 240n, nullifier: 7n, to: E01_OTHER }] }), "built");
  // review of 982a19bd, F3: a Withdrawn to W above the quote's block is pending, given by both providers or by one and
  // confirmed by the other (which holds its block, though its range to "latest" reached only the agreed block)
  const w300 = { releases: [{ kind: "withdraw" as const, block: 300n, nullifier: 7n }] };
  assert.match(await e01Why(w300), /landed in block 300, above the finalized block/);
  assert.match(await e01Why(w300, {}, { ...w300, seesTo: 256n, holds: () => 300n }), /landed in block 300, above the finalized block/);
  assert.match(await e01Why({ ...w300, seesTo: 256n, holds: () => 300n }, {}, w300), /landed in block 300, above the finalized block/);
}));

test("card evm-sell-no-release-in-flight: a release the device sent holds the sell until it lands or the finalized block's time passes its deadline; the list only adds waits", () => onTestClock(async () => {
  const finMs = E01_FIN_MS;
  const sent = (deadlineMs: bigint) => ({ sent: [{ note: E01_NOTE, nullifier: 7n, deadlineMs }] });
  for (const d of [finMs, finMs + 1n, 10n ** 15n]) {
    assert.match(await e01Why({}, sent(d)), new RegExp(`^release_in_flight: .*${E01_NOTE} was sent and has not landed: the sell waits until it lands in a final block or a final block's time passes its deadline ${d} ms`));
  }
  // its deadline passed by the finalized block's time: it can never land
  assert.equal(await e01Why({}, sent(finMs - 1000n)), "built");
  // landed in the tail as the funding buy: it has landed, and holds nothing
  assert.equal(await e01Why({ releases: [{ kind: "buy", block: 256n, nullifier: 7n }] }, sent(10n ** 15n)), "built");
  // one the store saw land in a block not yet final (no deadline): pending until the read finds it (review of 181fd050,
  // info: one above every provider's "latest" dropped out of both), then as the read finds it
  const seen = { sent: [{ note: E01_NOTE, nullifier: 7n }] };
  assert.match(await e01Why({}, seen), new RegExp(`^release_in_flight: 1 release to W not final on two RPCs: ${E01_NOTE} landed in a block the providers do not show yet: the sell waits until its block is final on both RPCs$`));
  assert.equal(await e01Why({ releases: [{ kind: "buy", block: 256n, nullifier: 7n }] }, seen), "built");
  assert.match(await e01Why({ releases: [{ kind: "withdraw", block: 240n, nullifier: 7n }] }, seen), new RegExp(`${E01_NOTE} landed in block 240`));
  // landed in the tail as a Withdrawn: pending, its note named
  assert.match(await e01Why({ releases: [{ kind: "withdraw", block: 240n, nullifier: 7n }] }, sent(10n ** 15n)), new RegExp(`^release_in_flight: 1 release to W not final on two RPCs: ${E01_NOTE} landed in block 240`));
  // the device's list cannot clear a Withdrawn the read found: one sent with a deadline long past still waits
  assert.match(await e01Why({ releases: [{ kind: "withdraw", block: 240n, nullifier: 7n }] }, sent(0n)), /landed in block 240/);
  // a malformed list is refused before any read
  for (const bad of [undefined, null, {}, [{ note: "", nullifier: 7n, deadlineMs: 0n }], [{ note: E01_NOTE, nullifier: -1n, deadlineMs: 0n }], [{ note: E01_NOTE, nullifier: 7n, deadlineMs: -1n }], new Array(kit.EVM_SELL_SENT_MAX + 1).fill({ note: E01_NOTE, nullifier: 7n, deadlineMs: 0n })]) {
    assert.deepEqual(await verdict(e01Quote({}, { sent: bad })), { accepted: false, code: "bad_request" }, JSON.stringify(bad, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  }
}));

test("card evm-sell-no-release-in-flight: W's releases up to the quote's block must be the same on both providers; a lie, a malformed log or the wrong block refuses the quote", () => onTestClock(async () => {
  const w = { releases: [{ kind: "withdraw" as const, block: 240n, nullifier: 7n }] };
  assert.deepEqual(await verdict(e01Quote(w, {}, {})), { accepted: false, code: "rpc_disagree" });
  assert.deepEqual(await verdict(e01Quote({}, {}, w)), { accepted: false, code: "rpc_disagree" });
  // a provider that answers a log of another event or of another recipient, or with the nullifier cut short
  const lying = (f: (l: Record<string, unknown>) => Record<string, unknown>): EvmRpc => {
    const p = provider({ price: flat, releases: [{ kind: "withdraw", block: 240n, nullifier: 7n }] });
    return async (calls) => (await p(calls)).map((o, i) => (calls[i]!.method === "eth_getLogs" ? { ...(o as object), result: ((o as { result: Record<string, unknown>[] }).result).map(f) } : o));
  };
  for (const f of [(l: Record<string, unknown>) => ({ ...l, topics: ["0x" + "ab".repeat(32), (l.topics as string[])[1]] }), (l: Record<string, unknown>) => ({ ...l, topics: [(l.topics as string[])[0], "0x" + "00".repeat(12) + "42".repeat(20)] }), (l: Record<string, unknown>) => ({ ...l, data: (l.data as string).slice(0, -64) }), (l: Record<string, unknown>) => ({ ...l, address: E01_OTHER }), (l: Record<string, unknown>) => ({ ...l, removed: true })]) {
    const v = await verdict(sellQuoteWith(req("base-sepolia"), [lying(f), lying(f)], Date.now()));
    assert.deepEqual(v, { accepted: false, code: "rpc_error" });
  }
  // W's releases are read on the pool's own list where the chain has one (Robinhood's poolProviders), never the quote's
  const quoteOnly = () => provider({ price: flat });
  const poolList = () => provider({ price: flat, releases: [{ kind: "withdraw", block: 240n, nullifier: 7n }] });
  const onPool = await sellQuoteWith(req("base-sepolia"), [quoteOnly(), quoteOnly()], Date.now(), undefined, undefined, undefined, [poolList(), poolList()]);
  assert.throws(() => kit.evmPoolBuildSell(onPool, E01_BASE()), /landed in block 240/);
  // a log twice
  const twice = (): EvmRpc => async (calls) => (await provider({ price: flat, releases: [{ kind: "buy", block: 240n, nullifier: 7n }] })(calls)).map((o, i) => (calls[i]!.method === "eth_getLogs" ? { ...(o as object), result: [...(o as { result: unknown[] }).result, ...(o as { result: unknown[] }).result] } : o));
  assert.deepEqual(await verdict(sellQuoteWith(req("base-sepolia"), [twice(), twice()], Date.now())), { accepted: false, code: "rpc_error" });
  // a provider that reads the logs at another block than the quote's
  const elsewhere = (): EvmRpc => async (calls) => {
    const out = await provider({ price: flat })(calls);
    return calls.some((c) => c.method === "eth_getLogs") ? out.map((o, i) => (calls[i]!.method === "eth_getBlockByNumber" ? { ...(o as object), result: { ...(o as { result: object }).result, hash: "0x" + "ee".repeat(32) } } : o)) : out;
  };
  assert.deepEqual(await verdict(sellQuoteWith(req("base-sepolia"), [elsewhere(), elsewhere()], Date.now())), { accepted: false, code: "rpc_disagree" });
  // the read asks the pool's Withdrawn and Bought to W, from the block after the finalized one, the last page to latest
  const asked: unknown[] = [];
  const spy = (): EvmRpc => async (calls) => {
    for (const c of calls) if (c.method === "eth_getLogs") asked.push(c.params[0]);
    return provider({ price: flat })(calls);
  };
  await sellQuoteWith(req("base-sepolia"), [spy(), spy()], Date.now());
  assert.deepEqual(asked[0], { address: evmPoolVenues()["base-sepolia"].pool!.toLowerCase(), fromBlock: "0xe1", toBlock: "latest", topics: [[TOPIC_WITHDRAWN, TOPIC_BOUGHT], "0x" + "00".repeat(12) + WALLET.slice(2)] });
  // a finalized block more than EVM_SELL_TAIL_MAX below the quote's is refused, never paged without end
  const far = (rpc: EvmRpc): EvmRpc => async (calls) => (await rpc(calls)).map((o, i) => (calls[i]!.method === "eth_getBlockByNumber" && calls[i]!.params[0] === "finalized" ? { ...(o as object), result: { ...(o as { result: object }).result, number: "0x0" } } : o));
  // every block by number answered as the head, renumbered n
  const head = (rpc: EvmRpc, n: bigint): EvmRpc => async (calls) => (await rpc(calls.map((c) => (c.method === "eth_getBlockByNumber" && c.params[0] !== "finalized" ? { ...c, params: ["latest", false] } : c)))).map((o, i) => (calls[i]!.method === "eth_getBlockByNumber" && calls[i]!.params[0] !== "finalized" ? { ...(o as object), result: { ...(o as { result: object }).result, number: "0x" + n.toString(16) } } : o));
  const at = (n: bigint) => verdict(sellQuoteWith(req("base-sepolia"), [far(head(provider({ price: flat }), n)), far(head(provider({ price: flat }), n))], Date.now()));
  assert.equal((await at(quoteMod.EVM_SELL_TAIL_MAX)).accepted, true);
  assert.deepEqual(await at(quoteMod.EVM_SELL_TAIL_MAX + 1n), { accepted: false, code: "rpc_error" });
}));

test("card evm-sell-no-release-in-flight: a log above the quote's block that one provider alone gives counts only once a second provider holds its block with it (review of 181fd050, R2-1, R2-2)", { timeout: 60_000 }, () => onTestClock(async () => {
  const at = (block: bigint, nullifier = 7n): Release[] => [{ kind: "withdraw", block, nullifier }];
  const p = (m: Partial<Model>) => provider({ price: flat, headSec: E01_HEAD, ...m });
  const why = async (list: EvmRpc[]) => {
    const q = await sellQuoteWith(req("base-sepolia"), list, Date.now());
    try {
      kit.evmPoolBuildSell(q, E01_BASE());
      return "built";
    } catch (e) {
      return (e as Error).message;
    }
  };
  // R2-2, R3-1 (review of 9c2a87d5): A holds W's Withdrawn at 300 (n = 256), and B and C reach block 300 from their
  // second ask on. A fourth provider D does not drop it: a low head (190: 300 > 190 + maxLag), a block held without the
  // log while B and C catch up, and an error to the logs by hash are each no denial
  const catchingUp = () => {
    let asks = 0;
    return p({ releases: at(300n), seesTo: 256n, holds: () => (asks++ > 0 ? 300n : 256n) });
  };
  assert.match(await why([p({ releases: at(300n) }), catchingUp(), catchingUp()]), /landed in block 300/, "control: without D the release counts");
  assert.match(await why([p({ releases: at(300n) }), catchingUp(), catchingUp(), p({ latest: () => 190n, holds: () => 190n })]), /landed in block 300/, "R3-1a: D's low head dropped it");
  assert.match(await why([p({ releases: at(300n) }), catchingUp(), catchingUp(), p({ holds: () => 300n })]), /landed in block 300/, "R3-1b: D's block without the log dropped it");
  const inner = p({ releases: at(300n), holds: () => 300n });
  const errs: EvmRpc = async (calls) => (await inner(calls)).map((o, k) => (calls[k]!.method === "eth_getLogs" && (calls[k]!.params[0] as { blockHash?: string }).blockHash !== undefined ? { jsonrpc: "2.0", id: (o as { id: unknown }).id, error: { code: -32000, message: "unknown block" } } : o));
  assert.match(await why([p({ releases: at(300n) }), catchingUp(), catchingUp(), errs]), /landed in block 300/, "R3-1c: D's error dropped it");
  // where the only other provider holds the block and errors to its logs by hash, there is no answer: the quote waits,
  // then is refused, never built
  // (each 12 s case on a head 2 s old as it starts, so the stall comes before EVM_SELL_CONFIRM_BY_MS)
  const fresh = (m: Partial<Model>) => provider({ price: flat, headSec: Math.floor(Date.now() / 1000) - 2, ...m });
  const bare = fresh({ holds: () => 300n });
  const errsOnly: EvmRpc = async (calls) => (await bare(calls)).map((o, k) => (calls[k]!.method === "eth_getLogs" && (calls[k]!.params[0] as { blockHash?: string }).blockHash !== undefined ? { jsonrpc: "2.0", id: (o as { id: unknown }).id, error: { code: -32000, message: "unknown block" } } : o));
  assert.deepEqual(await verdict(sellQuoteWith(req("base-sepolia"), [fresh({ releases: at(300n) }), errsOnly], Date.now())), { accepted: false, code: "rpc_error" });
  // R2-1: one lying provider of four with a made-up Withdrawn to W at the quote's block + 1: the others hold that block
  // without it, so it is dropped, quote after quote
  const honest = () => p({ holds: () => 257n });
  const list = [p({ releases: at(257n, 0xdeadn) }), honest(), honest(), honest()];
  for (let k = 0; k < 3; k++) assert.equal(await why(list), "built", `quote ${k}`);
  // the same where the block the others hold has another hash than the lie names
  const otherHash: EvmRpc = async (calls) => (await p({ releases: at(257n, 0xdeadn) })(calls)).map((o, i) => (calls[i]!.method === "eth_getLogs" ? { ...(o as object), result: (o as { result: Record<string, unknown>[] }).result.map((l) => ({ ...l, blockHash: "0x" + "ab".repeat(32) })) } : o));
  assert.equal(await why([otherHash, honest(), honest()]), "built");
  // a lie further above every other provider's head than maxLag (base-sepolia's 100) is no honest head's: dropped at once
  const lag = BigInt(evmPoolVenues()["base-sepolia"].maxLag!);
  assert.equal(await why([p({ releases: at(257n + lag) }), p({}), p({})]), "built");
  // one within maxLag that no other provider holds within EVM_SELL_CONFIRM_WAIT_MS refuses the quote, never builds it
  const t0 = performance.now();
  assert.deepEqual(await verdict(sellQuoteWith(req("base-sepolia"), [fresh({ releases: at(256n + lag) }), fresh({})], Date.now())), { accepted: false, code: "rpc_error" });
  assert.ok(performance.now() - t0 >= quoteMod.EVM_SELL_CONFIRM_WAIT_MS - 100);
}));

// The providers as the index makes them (evmProviders: timed, so a hold reaches their speed record), on a fetch that
// answers each URL from its model; the first answers 20 ms faster than the rest, so it ranks first unless it is held
const E01_RANKED = async (urls: string[], models: EvmRpc[]) => {
  const fetchFn = (async (url: string, init: { body: string }) => {
    const calls = JSON.parse(init.body) as { method: string; params: unknown[] }[];
    if (urls.indexOf(url) > 0) await new Promise((r) => setTimeout(r, 20));
    const out = await models[urls.indexOf(url)]!(calls.map((c) => ({ method: c.method, params: c.params })) as never);
    return new Response(JSON.stringify((out as { id?: unknown }[]).map((o, id) => ({ ...o, id }))), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return quoteMod.evmProviders(urls, fetchFn) as EvmRpc[];
};
const E01_WHY = async (list: EvmRpc[]) => {
  const q = await sellQuoteWith(req("base-sepolia"), list, Date.now());
  try {
    kit.evmPoolBuildSell(q, E01_BASE());
    return "built";
  } catch (e) {
    return (e as Error).message;
  }
};

test("card evm-sell-no-release-in-flight: a liar never confirms its own lie, and its denial holds it (review of 9c2a87d5, I-1)", () => onTestClock(async () => {
  const p = (m: Partial<Model>) => provider({ price: flat, headSec: E01_HEAD, ...m });
  const lie: Release[] = [{ kind: "withdraw", block: 257n, nullifier: 0xdeadn }];
  // the liar answers its block by number and its made-up log by blockHash, as any liar can; the others hold 257 without it
  assert.equal(await E01_WHY([p({ releases: lie, holds: () => 257n }), p({ holds: () => 257n }), p({ holds: () => 257n }), p({ holds: () => 257n })]), "built");
  // the liar is the fastest, so it ranks first unless the denial held it
  const urls = ["https://e01-liar.example", "https://e01-h1.example", "https://e01-h2.example", "https://e01-h3.example"];
  const list = await E01_RANKED(urls, [p({ releases: lie }), p({ holds: () => 257n }), p({ holds: () => 257n }), p({ holds: () => 257n })]);
  assert.equal(await E01_WHY(list), "built");
  assert.equal(quoteMod.evmRanked(urls).at(-1), urls[0], "the liar is held, so ranked last");
}));

test("card evm-sell-no-release-in-flight: a log is dropped only where more than half of the whole list hold its block without it or are far; a refusal holds the claimant (review of e21c5611, R4-1, R4-4)", { timeout: 60_000 }, () => onTestClock(async () => {
  const p = (m: Partial<Model>) => provider({ price: flat, headSec: Math.floor(Date.now() / 1000) - 2, ...m });
  const at = (block: bigint, nullifier = 7n): Release[] => [{ kind: "withdraw", block, nullifier }];
  const confirming = (calls: readonly EvmRpcCall[]) => calls.some((c) => c.method === "eth_getLogs" && (c.params[0] as { blockHash?: string }).blockHash !== undefined);
  // R4-1a: on a list of two (Robinhood's pool list, base-sepolia, robinhood-testnet) the one other provider's "the
  // block, no log" never decides: the quote is refused, never built
  assert.deepEqual(await verdict(sellQuoteWith(req("base-sepolia"), [p({ releases: at(300n), holds: () => 300n }), p({ holds: () => 300n })], Date.now())), { accepted: false, code: "rpc_error" });
  // R4-1b: on four, two others that give no answer to the confirmation leave the third alone, short of three
  let asks = 0;
  const catchingUp = () => p({ releases: at(300n), seesTo: 256n, holds: () => (asks++ > 0 ? 300n : 256n) });
  const silent = (rpc: EvmRpc): EvmRpc => async (calls) => {
    if (confirming(calls)) throw new Error("offline");
    return rpc(calls);
  };
  assert.deepEqual(await verdict(sellQuoteWith(req("base-sepolia"), [p({ releases: at(300n) }), silent(catchingUp()), silent(catchingUp()), p({ holds: () => 300n })], Date.now())), { accepted: false, code: "rpc_error" });
  // an error to the logs by hash is no answer, so it never makes a majority with one "the block, no log"
  const errs = (rpc: EvmRpc): EvmRpc => async (calls) => (await rpc(calls)).map((r, k) => (calls[k]!.method === "eth_getLogs" && (calls[k]!.params[0] as { blockHash?: string }).blockHash !== undefined ? { jsonrpc: "2.0", id: (r as { id: unknown }).id, error: { code: -32000, message: "unknown block" } } : r));
  assert.deepEqual(await verdict(sellQuoteWith(req("base-sepolia"), [p({ releases: at(300n), holds: () => 300n }), errs(p({ holds: () => 300n })), p({ holds: () => 300n })], Date.now())), { accepted: false, code: "rpc_error" });
  // a head past the block that does not hold it is no answer: it neither denies nor holds a denial back. It cannot drop
  // a sighting another provider confirms (R4-3), and on five, three others that hold the block without a lie deny it
  asks = 0;
  const past = () => p({ holds: () => 256n, latest: () => 400n });
  assert.match(await E01_WHY([p({ releases: at(300n) }), catchingUp(), past()]), /landed in block 300/);
  const honest = () => p({ holds: () => 257n });
  assert.equal(await E01_WHY([p({ releases: at(257n, 0xdeadn) }), honest(), honest(), honest(), past()]), "built");
  // R4-4: two colluders, a made-up log and a head that stands still below it: refused at the stall, the liar held
  const urls = ["https://e01-still-liar.example", "https://e01-still.example"];
  const list = await E01_RANKED(urls, [p({ releases: at(257n, 0xdeadn) }), p({ holds: () => 256n, latest: () => 256n })]);
  await assert.rejects(sellQuoteWith(req("base-sepolia"), list, Date.now()), /^EvmQuoteError: rpc_error: W's release in block 257 is not yet held by a second provider, and no other provider's head moved for 12 s$/);
  assert.equal(quoteMod.evmRanked(urls).at(-1), urls[0], "the liar is held at the stall");
}));

test("card evm-sell-no-release-in-flight: a liar's many logs above the quote's block cost one confirmation per block, none past its first denial, and an answer of more than EVM_SELL_ABOVE_MAX is its failure (review of 9c2a87d5, R3-3)", () => onTestClock(async () => {
  let confirms = 0;
  const count = (rpc: EvmRpc): EvmRpc => async (calls) => {
    if (calls.some((c) => c.method === "eth_getLogs" && (c.params[0] as { blockHash?: string }).blockHash !== undefined)) confirms++;
    return rpc(calls);
  };
  const lies = (n: number, block: (k: number) => bigint): Release[] => Array.from({ length: n }, (_, k) => ({ kind: "withdraw", block: block(k), nullifier: 0x1000n + BigInt(k) }));
  const honest = () => count(provider({ price: flat, headSec: E01_HEAD, holds: () => 0x200n }));
  const liar = (r: Release[]) => provider({ price: flat, headSec: E01_HEAD, releases: r });
  // the cap: in one block, then over 32 blocks, one round of the three others each, the rest dropped after the denial
  for (const [r, most] of [[lies(64, () => 257n), 3], [lies(64, (k) => 257n + BigInt(k % 32)), 3]] as const) {
    confirms = 0;
    assert.equal(await E01_WHY([liar(r), honest(), honest(), honest()]), "built");
    assert.ok(confirms > 0 && confirms <= most, `${confirms} confirmation batches for ${r.length} made-up logs (the liar's answer is read at the cap)`);
  }
  // past the cap the liar's answer is its failure: the others agree, with no confirmation asked
  confirms = 0;
  assert.equal(await E01_WHY([liar(lies(300, () => 257n)), honest(), honest(), honest()]), "built");
  assert.equal(confirms, 0);
  assert.deepEqual(await verdict(sellQuoteWith(req("base-sepolia"), [liar(lies(65, () => 257n)), liar(lies(65, () => 257n))], Date.now())), { accepted: false, code: "rpc_error" });
  assert.equal(quoteMod.EVM_SELL_ABOVE_MAX, 64);
}));

test("card evm-sell-no-release-in-flight: the funding buy is matched whatever the case of its token's hex in the provider's answer (review of 9c2a87d5, I-3)", () => onTestClock(async () => {
  const upper = (rpc: EvmRpc): EvmRpc => async (calls) =>
    (await rpc(calls)).map((o, k) => (calls[k]!.method === "eth_getLogs" ? { ...(o as object), result: ((o as { result: { data: string }[] }).result ?? []).map((l) => ({ ...l, data: "0x" + l.data.slice(2).toUpperCase() })) } : o));
  // a token whose hex has letters (the fixture's TOKEN is all digits)
  const token = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const r = req("base-sepolia", { token, bought: { ...BOUGHT, hops: [{ ...BOUGHT.hops[0]!, currency: token }] } });
  const funding: Release[] = [{ kind: "buy", block: 0x100n, nullifier: 7n, token }];
  const q = await sellQuoteWith(r, [upper(provider({ price: flat, headSec: E01_HEAD, releases: funding })), upper(provider({ price: flat, headSec: E01_HEAD, releases: funding }))], Date.now());
  assert.deepEqual(q.releases.pending, []);
  assert.doesNotThrow(() => kit.evmPoolBuildSell(q, E01_BASE()));
}));

test("card evm-sell-no-release-in-flight: a lie the moving heads reach only past EVM_SELL_CONFIRM_BY_MS after the quote's block refuses the quote before the builder's 30 s and holds the liar (review of 9c2a87d5, R3-2)", { timeout: 40_000 }, () => onTestClock(async () => {
  // base-sepolia: a lie at 256 + maxLag (100), the honest heads moving one block per 250 ms from the first ask for it,
  // so they would reach it after 25 s; the head's time is 2 s before the quote
  let from: number | null = null;
  const now = () => (from === null ? 0x100n : 0x100n + BigInt(Math.floor((performance.now() - from) / 250)));
  const honest = (): EvmRpc => {
    const inner = provider({ price: flat, headSec: E01_HEAD, holds: now, latest: now });
    return async (calls) => {
      if (calls.some((c) => c.method === "eth_getLogs" && (c.params[0] as { blockHash?: string }).blockHash !== undefined)) from ??= performance.now();
      return inner(calls);
    };
  };
  const lag = BigInt(evmPoolVenues()["base-sepolia"].maxLag!);
  const urls = ["https://e01-by-liar.example", "https://e01-by-h1.example", "https://e01-by-h2.example"];
  const list = await E01_RANKED(urls, [provider({ price: flat, headSec: E01_HEAD, releases: [{ kind: "withdraw", block: 0x100n + lag, nullifier: 0xdeadn }] }), honest(), honest()]);
  const t0 = Date.now();
  await assert.rejects(sellQuoteWith(req("base-sepolia"), list, Date.now()), /^EvmQuoteError: rpc_error: W's release in block 356 is not held by a second provider 20 s after the quote's block$/);
  assert.ok(Date.now() - E01_HEAD * 1000 < quoteMod.EVM_SELL_CONFIRM_BY_MS + 2_000, "refused by the deadline");
  assert.ok(Date.now() - t0 >= quoteMod.EVM_SELL_CONFIRM_BY_MS - 4_000, "the heads were still moving, so it waited for them");
  assert.equal(quoteMod.evmRanked(urls).at(-1), urls[0], "the liar is held, so the next quote reads the others");
}));

test("card evm-sell-no-release-in-flight: a lie above the quote's block waits for as long as the other providers' heads move toward it, so it is dropped even where they reach its block later than EVM_SELL_CONFIRM_WAIT_MS", { timeout: 40_000 }, () => onTestClock(async () => {
  // base-sepolia's maxLag of 100 blocks is about 20 s at 200 ms, past a fixed wait of 12 s: a lie at n + maxLag would
  // refuse every quote and never be held. Here the honest heads move one block per 1.5 s from the first ask for the
  // lie's block, so they reach 256 + 9 after 13.5 s, and hold it without the lie
  let from: number | null = null;
  const now = () => (from === null ? 0x100n : 0x100n + BigInt(Math.floor((performance.now() - from) / 1_500)));
  const honest = (): EvmRpc => {
    const inner = provider({ price: flat, headSec: E01_HEAD, holds: now, latest: now });
    return async (calls) => {
      if (calls.some((c) => c.method === "eth_getLogs" && (c.params[0] as { blockHash?: string }).blockHash !== undefined)) from ??= performance.now();
      return inner(calls);
    };
  };
  const t0 = performance.now();
  const q = await sellQuoteWith(req("base-sepolia"), [provider({ price: flat, headSec: E01_HEAD, releases: [{ kind: "withdraw", block: 0x100n + 9n, nullifier: 0xdeadn }] }), honest(), honest()], Date.now());
  assert.ok(performance.now() - t0 >= quoteMod.EVM_SELL_CONFIRM_WAIT_MS, "the heads reached the block after the stall window");
  assert.doesNotThrow(() => kit.evmPoolBuildSell(q, E01_BASE()));
  assert.deepEqual(q.releases.pending, []);
}));

test("card evm-sell-no-release-in-flight: the builder takes only the quote's own verdict, for its chain, its W and its block (review of 982a19bd, F1 and F1b)", () => onTestClock(async () => {
  // F1: the public entry has no judge an app can hand an empty read to; a caller's `releases` is not read
  assert.equal((kit as Record<string, unknown>).evmSellReleases, undefined);
  const q = await e01Quote({ releases: [{ kind: "withdraw", block: 240n, nullifier: 7n }] });
  assert.throws(() => kit.evmPoolBuildSell(q, { ...E01_BASE(), releases: { chain: q.chain, w: q.w, block: q.block.number, finalBlock: 0n, pending: [] } } as kit.EvmPoolSellFields), /^EvmPoolSellError: release_in_flight: .*landed in block 240|release_in_flight: 1 release/);
  // F1b: the verdict is bound to the quote it is checked against
  const v = (o: Partial<{ chain: EvmPoolChain; w: string; block: bigint }> = {}) => releasesMod.evmSellReleasesAt({ chain: "base-sepolia", w: WALLET, block: 256n, fin: { number: 224n, timestamp: 1_000n }, agreed: [], above: [], sent: [], funding: { token: TOKEN, block: 256n }, ...o });
  const ask = { chain: "base-sepolia" as EvmPoolChain, w: WALLET.toUpperCase().replace("0X", "0x"), block: { number: 256n } };
  assert.doesNotThrow(() => releasesMod.evmSellReleasesClear({ ...ask, releases: v() }));
  assert.throws(() => releasesMod.evmSellReleasesClear({ ...ask, releases: v({ block: 255n }) }), /^EvmPoolSellError: release_in_flight: the releases read is at block 255, not the quote's block 256$/);
  assert.throws(() => releasesMod.evmSellReleasesClear({ ...ask, releases: v({ block: 257n }) }), /the releases read is at block 257, not the quote's block 256/);
  assert.throws(() => releasesMod.evmSellReleasesClear({ ...ask, releases: v({ w: E01_OTHER }) }), /^EvmPoolSellError: release_in_flight: the releases read is another chain's or another W's$/);
  assert.throws(() => releasesMod.evmSellReleasesClear({ ...ask, releases: v({ chain: "robinhood-testnet" }) }), /the releases read is another chain's or another W's/);
  for (const r of [undefined, null, { ...v() }, Object.freeze({ chain: "base-sepolia", w: WALLET, block: 256n, finalBlock: 224n, pending: [] })]) {
    assert.throws(() => releasesMod.evmSellReleasesClear({ ...ask, releases: r }), /^EvmPoolSellError: release_in_flight: a sell is built only with W's releases the sell quote read$/);
  }
  // a verdict cannot be changed after it was made, and a nullifier released twice is no verdict
  assert.throws(() => (v().pending as unknown[]).push({ note: null, landed: 1n }));
  assert.throws(() => releasesMod.evmSellReleasesAt({ chain: "base-sepolia", w: WALLET, block: 256n, fin: { number: 224n, timestamp: 1_000n }, agreed: [{ kind: "buy", block: 230n, nullifier: 7n, token: null }, { kind: "withdraw", block: 231n, nullifier: 7n, token: null }], above: [], sent: [], funding: { token: TOKEN, block: 256n } }), /release_in_flight: .*a nullifier released twice/);
  // the quote carries the verdict it read, frozen, at its own block
  const ok = await e01Quote();
  assert.equal(ok.releases.block, ok.block.number);
  assert.equal(ok.releases.finalBlock, 224n);
  assert.ok(Object.isFrozen(ok.releases) && Object.isFrozen(ok.releases.pending));
}));
