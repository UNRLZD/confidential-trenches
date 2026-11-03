// Card evm-venues-pin: the kit's venue list pins each testnet chain's deployed pool, v3 and v4 adapters and sell
// delegate, equal to pool-evm-deploy's records (scripts/live-checks/pool-evm-deploy.<chain>.json), and the kit's index
// builds and signs only for them: another pool or adapter is refused (not_pinned), a venue with no adapter
// (Robinhood testnet's v3, M365) is refused (not_deployed), and W's 7702 authorization names only the pinned delegate.
// scripts/live-checks/evm-venues-pin.mjs reads each pin's code on the chain's two RPCs.
import { mock, test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as kit from "../src/index.ts";
import { EvmPoolBuyError, EvmPoolSellError, evmPoolVenues, type EvmPoolChain, type EvmRoute } from "../src/index.ts";

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof EvmPoolBuyError || e instanceof EvmPoolSellError) return e.code;
    throw e;
  }
  return "built";
};
const record = (chain: string) =>
  JSON.parse(readFileSync(new URL(`../../../scripts/live-checks/pool-evm-deploy.${chain}.json`, import.meta.url), "utf8")).contracts as Record<string, { address: string }>;

// pool-evm-deploy's pinned chain table: the WETH each testnet's contracts were deployed with
const DEPLOY = (await import(new URL("../../../scripts/live-checks/pool-evm-deploy.mjs", import.meta.url).href)) as { CHAINS: Record<string, { weth: { address: string } }> };

const NOW = 1_800_000_000;
mock.timers.enable({ apis: ["Date"], now: NOW * 1000 });
const W_KEY = new Uint8Array(32).fill(7);
const W = "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(W_KEY, false).subarray(1)).subarray(12)).toString("hex");
const X = "0xF111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const OTHER = "0x000000000000000000000000000000000000bad0";
const PROOF = { nullifier: 1n, context: 2n, value: 3n };
const v4 = (): EvmRoute => ({ venue: "uniswap-v4", currencyIn: ZERO, hops: [{ currency: X, fee: 500, tickSpacing: 10, hooks: ZERO, hookData: "0x" }] });
const v3 = (weth: string): EvmRoute => ({ venue: "uniswap-v3", tokens: [weth, X], fees: [500] });
const lower = (a: string | undefined) => a?.toLowerCase();

// The routers a sell may call: Base Sepolia's Uniswap v3 SwapRouter02, the router its v3 adapter was deployed with
// (scripts/live-checks/pool-evm-deploy.mjs CHAINS), and none on Robinhood testnet, which has no Uniswap v3 (M365).
const TESTNETS = [
  { chain: "base-sepolia", chainId: 84532, routers: ["0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4"] },
  { chain: "robinhood-testnet", chainId: 46630, routers: [] },
] as const;

test("the testnet chains' pins are pool-evm-deploy's records: pool, v3 and v4 adapters, sell delegate, with its WETH and no middle; the mainnets have none", () => {
  for (const { chain, chainId, routers } of TESTNETS) {
    const v = evmPoolVenues()[chain as EvmPoolChain];
    const r = record(chain);
    assert.equal(v.chainId, chainId, chain);
    assert.deepEqual(v.routers.map(lower), routers, chain);
    assert.equal(lower(v.weth), lower(DEPLOY.CHAINS[chain]!.weth.address), chain);
    assert.deepEqual(v.middles, [], chain); // no middle: a route is WETH and the token only
    assert.equal(lower(v.pool), lower(r.PrivacyPoolSimple!.address), chain);
    assert.equal(lower(v.adapters?.v4), lower(r.UniswapV4Adapter!.address), chain);
    assert.equal(lower(v.adapters?.v3), lower(r.UniswapV3Adapter?.address), chain); // none on Robinhood testnet (M365)
    assert.equal(lower(v.sellDelegate), lower(r.SellDelegate!.address), chain);
    assert.equal(Object.getPrototypeOf(v), null, chain);
    assert.equal(Object.getPrototypeOf(v.adapters), null, chain);
    assert.ok(Object.isFrozen(v) && Object.isFrozen(v.adapters) && Object.isFrozen(v.middles) && Object.isFrozen(v.routers), chain);
  }
  for (const chain of ["base", "robinhood"] as EvmPoolChain[]) {
    const v = evmPoolVenues()[chain];
    assert.deepEqual([v.pool, v.adapters, v.sellDelegate], [undefined, undefined, undefined], chain);
  }
});

test("a buy builds only through the chain's pinned adapter for its venue, and W signs it only into the pinned pool", () => {
  for (const { chain } of TESTNETS) {
    const c = chain as EvmPoolChain;
    const v = evmPoolVenues()[c];
    const r = record(chain);
    // v4: the pinned adapter only
    assert.equal(code(() => kit.evmPoolBuild(c, OTHER, v4(), 1n, X)), "not_pinned", chain);
    assert.equal(code(() => kit.evmPoolBuild(c, r.PrivacyPoolSimple!.address, v4(), 1n, X)), "not_pinned", chain);
    const built = kit.evmPoolBuild(c, r.UniswapV4Adapter!.address, v4(), 1n, X);
    // the pool: the pinned one only
    assert.equal(code(() => kit.evmPoolSignBuy(W_KEY, c, OTHER, built, PROOF)), "not_pinned", chain);
    assert.equal(code(() => kit.evmPoolSignBuy(W_KEY, c, r.UniswapV4Adapter!.address, built, PROOF)), "not_pinned", chain);
    assert.equal(kit.evmPoolSignBuy(W_KEY, c, r.PrivacyPoolSimple!.address.toUpperCase().replace("0X", "0x"), built, PROOF).length, 65, chain);
    // v3: Base Sepolia's pinned adapter only; Robinhood testnet has none
    if (r.UniswapV3Adapter) {
      assert.equal(code(() => kit.evmPoolBuild(c, OTHER, v3(v.weth), 1n, X)), "not_pinned", chain);
      assert.equal(code(() => kit.evmPoolBuild(c, r.UniswapV4Adapter!.address, v3(v.weth), 1n, X)), "not_pinned", chain);
      const b3 = kit.evmPoolBuild(c, r.UniswapV3Adapter.address, v3(v.weth), 1n, X);
      assert.equal(kit.evmPoolSignBuy(W_KEY, c, r.PrivacyPoolSimple!.address, b3, PROOF).length, 65, chain);
    } else {
      assert.equal(code(() => kit.evmPoolBuild(c, OTHER, v3(v.weth), 1n, X)), "not_deployed", chain);
    }
  }
});

test("a sell pays only into the chain's pinned pool, and W's authorization names only its pinned sell delegate", () => {
  for (const { chain, chainId, routers } of TESTNETS) {
    const c = chain as EvmPoolChain;
    const v = evmPoolVenues()[c];
    const r = record(chain);
    const req = {
      w: W, token: X, amount: 10n ** 18n, target: routers[0] ?? "0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4", route: { venue: "uniswap-v3" as const, tokens: [X, v.weth], fees: [500] },
      minOut: 10n ** 15n, precommitment: 0x5e11n, feeCap: 10n ** 14n, deadline: BigInt(NOW + 300), nonce: 0n,
    };
    if (routers.length > 0) {
      // a pool the caller sneaks in is not read: the pin is the pool
      const built = kit.evmPoolBuildSell(c, { ...req, pool: OTHER } as typeof req);
      assert.equal(lower(built.pool), lower(r.PrivacyPoolSimple!.address), chain);
      assert.equal(kit.evmPoolSignSell(W_KEY, c, built).length, 65, chain);
    } else {
      // Robinhood testnet has no v3 router (M365), so no sell is built there
      assert.equal(code(() => kit.evmPoolBuildSell(c, req)), "bad_target", chain);
    }
    const a = kit.evmPoolSignSellAuthorization(W_KEY, c, 0n);
    assert.equal(lower(a.address), lower(r.SellDelegate!.address), chain);
    assert.equal(a.chainId, chainId, chain);
    // the authorization takes no delegate: a fourth argument is not read
    const b = (kit.evmPoolSignSellAuthorization as (...x: unknown[]) => typeof a)(W_KEY, c, 0n, OTHER);
    assert.equal(lower(b.address), lower(r.SellDelegate!.address), chain);
  }
});
