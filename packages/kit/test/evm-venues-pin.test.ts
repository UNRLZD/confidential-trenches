// Card evm-venues-pin: the kit's venue list pins each testnet chain's deployed pool, v3 and v4 adapters and sell
// delegate, equal to pool-evm-deploy's records (scripts/live-checks/pool-evm-deploy.<chain>.json), and the pinned
// builder and signer the kit's index runs build and sign only for them: another pool or adapter is refused (not_pinned), a venue with no adapter
// (Robinhood testnet's v3, M365) is refused (not_deployed), and W's 7702 authorization names only the pinned delegate.
// scripts/live-checks/evm-venues-pin.mjs reads each pin's code on the chain's two RPCs.
import { mock, test } from "node:test";
import { enableTimers } from "./mock-timers.ts";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as kit from "../src/index.ts";
import { EvmPoolBuyError, EvmPoolSellError, evmPoolVenues, type EvmPoolChain, type EvmRoute } from "../src/index.ts";
import { pinnedBuild, pinnedSignBuy } from "../src/trade/evm/buy-unpinned.ts";
import { pinnedBuildSell, pinnedSignSell } from "../src/trade/evm/sell-unpinned.ts";

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof EvmPoolBuyError || e instanceof EvmPoolSellError) return e.code;
    throw e;
  }
  return "built";
};
// pool-evm-deploy's set, its pool and verifier the chain's newest pool set's (pool-evm-deploy.mjs poolFile: card
// pool-evm-buy-pays-revert's, whose buy pays a failed swap's chunk to W)
const record = (chain: string): Record<string, { address: string }> => {
  const first = JSON.parse(readFileSync(new URL(`../../../scripts/live-checks/pool-evm-deploy.${chain}.json`, import.meta.url), "utf8")).contracts as Record<string, { address: string }>;
  const pool = JSON.parse(readFileSync(DEPLOY.poolFile(chain), "utf8")).contracts as Record<string, { address: string }>;
  return { ...first, PrivacyPoolSimple: pool.PrivacyPoolSimple!, WithdrawalVerifier: pool.WithdrawalVerifier! };
};
// the SellDelegate at the pool-review-3 build (the 11-field Sell the kit signs, its fee to the signed feeRecipient),
// deployed again by card evm-testnet-delegate-review3 (card evm-selldelegate-exact-debit's and card evm-sell-v4's
// delegates before it, which the build file freezes: they dispatch the 10-field sell)
const sellFile = (key: string, chain: string) =>
  JSON.parse(readFileSync(new URL(`../../../scripts/live-checks/${key}.${chain}.json`, import.meta.url), "utf8")).contracts as Record<string, { address: string }>;
const sellRecord = (chain: string) => sellFile("evm-testnet-delegate-review3", chain);
// the FeeCollector card evm-fee-collector deployed on each testnet, the one recipient a Sell pays (the helper sends no
// other): the kit's feeCollector pin is held to it below
const collector = (chain: string) => sellFile("evm-fee-collector", chain).FeeCollector!.address;

// pool-evm-deploy's pinned chain table: the WETH each testnet's contracts were deployed with
type DeployChain = { weth: { address: string }; poolManager: { address: string }; router?: { address: string } };
const DEPLOY = (await import(new URL("../../../scripts/live-checks/pool-evm-deploy.mjs", import.meta.url).href)) as { CHAINS: Record<string, DeployChain>; MAINNETS: Record<string, DeployChain>; poolFile: (chain: string) => string };

const NOW = 1_800_000_000;
enableTimers(mock.timers, { apis: ["Date"], now: NOW * 1000 });
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

test("the testnet chains' pins are pool-evm-deploy's records: pool, v3 and v4 adapters, sell delegate, with its WETH and no middle", () => {
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
    assert.equal(lower(v.sellDelegate), lower(sellRecord(chain).SellDelegate!.address), chain);
    assert.notEqual(lower(v.sellDelegate), lower(r.SellDelegate!.address), chain); // the v1 delegate sells through no PoolManager
    // nor the 10-field delegates: their sell is 0xbea5695c, never the 11-field 0x0c2cb9ca W signs
    assert.notEqual(lower(v.sellDelegate), lower(sellFile("evm-selldelegate-exact-debit", chain).SellDelegate!.address), chain);
    assert.notEqual(lower(v.sellDelegate), lower(sellFile("evm-sell-v4", chain).SellDelegate!.address), chain);
    assert.equal(lower(v.poolManager), lower(DEPLOY.CHAINS[chain]!.poolManager.address), chain);
    assert.equal(Object.getPrototypeOf(v), null, chain);
    assert.equal(Object.getPrototypeOf(v.adapters), null, chain);
    assert.ok(Object.isFrozen(v) && Object.isFrozen(v.adapters) && Object.isFrozen(v.middles) && Object.isFrozen(v.routers), chain);
  }
});

// Card pool-evm-deploy-mainnet: each mainnet's pins are its deployment record, contracts/pool-evm/deployments/<chain>.json
// (the owner's paste, contracts/pool-evm/script/mainnet-deploy.sh), read here and never typed: a pin and its record that
// differ fail. The pool's verifier is held through the pool (its immutable, read on chain by evm-venues-pin.mjs and
// pool-evm-deploy-mainnet.mjs); the kit pins no verifier of its own, since nothing on the device calls it.
const MAINNET_SETS = ["base", "robinhood"] as const;
const mainRecord = (chain: string) => {
  const d = JSON.parse(readFileSync(new URL(`../../../contracts/pool-evm/deployments/${chain}.json`, import.meta.url), "utf8")) as {
    chain: string;
    dryRun: boolean;
    contracts: Record<string, { address: string; sink?: string }>;
  };
  assert.equal(d.chain, chain);
  assert.equal(d.dryRun, false, `${chain}: a dry run's record is never a pin`);
  return d.contracts;
};

test("the mainnet chains' pins are their deployment records: pool, v3 and v4 adapters, sell delegate and fee collector, the collector's sink the sell sender", () => {
  for (const chain of MAINNET_SETS) {
    const v = evmPoolVenues()[chain];
    const r = mainRecord(chain);
    assert.equal(lower(v.pool), lower(r.PrivacyPoolSimple!.address), chain);
    assert.deepEqual(Object.keys(v.adapters ?? {}).sort(), ["v3", "v4"], chain); // both venues on both mainnets (M365 2: a v3 router is read on Robinhood)
    assert.equal(lower(v.adapters?.v3), lower(r.UniswapV3Adapter!.address), chain);
    assert.equal(lower(v.adapters?.v4), lower(r.UniswapV4Adapter!.address), chain);
    assert.equal(lower(v.sellDelegate), lower(r.SellDelegate!.address), chain);
    assert.equal(lower(v.feeCollector), lower(r.FeeCollector!.address), chain);
    assert.equal(lower(v.sellSender), lower(r.FeeCollector!.sink), chain);
    assert.equal(lower(v.weth), lower(DEPLOY.MAINNETS[chain]!.weth.address), chain);
    assert.equal(lower(v.poolManager), lower(DEPLOY.MAINNETS[chain]!.poolManager.address), chain);
    assert.deepEqual(v.routers.map(lower), [lower(DEPLOY.MAINNETS[chain]!.router!.address)], chain);
    assert.equal(Object.getPrototypeOf(v.adapters), null, chain);
    assert.ok(Object.isFrozen(v) && Object.isFrozen(v.adapters), chain);
  }
});

test("on each mainnet a buy builds only through its pinned adapters into its pinned pool, a sell pays only into that pool and its collector, and W's authorization names only its delegate", () => {
  for (const chain of MAINNET_SETS) {
    const v = evmPoolVenues()[chain];
    const r = mainRecord(chain);
    const pool = r.PrivacyPoolSimple!.address;
    for (const [route, adapter, other] of [
      [v4(), r.UniswapV4Adapter!.address, r.UniswapV3Adapter!.address],
      [v3(v.weth), r.UniswapV3Adapter!.address, r.UniswapV4Adapter!.address],
    ] as const) {
      assert.equal(code(() => pinnedBuild(evmPoolVenues(), chain, OTHER, route, 1n, X)), "not_pinned", chain);
      assert.equal(code(() => pinnedBuild(evmPoolVenues(), chain, other, route, 1n, X)), "not_pinned", chain);
      const built = pinnedBuild(evmPoolVenues(), chain, adapter, route, 1n, X);
      assert.equal(code(() => pinnedSignBuy(evmPoolVenues(), W_KEY, chain, OTHER, built, PROOF)), "not_pinned", chain);
      assert.equal(pinnedSignBuy(evmPoolVenues(), W_KEY, chain, pool, built, PROOF).length, 65, chain);
      assert.equal(code(() => kit.evmPoolSignBuy(W_KEY, chain, pool, built, PROOF)), "not_built", chain);
    }
    const req = {
      w: W, token: X, amount: 10n ** 18n, target: v.routers[0]!, route: { venue: "uniswap-v3" as const, tokens: [X, v.weth], fees: [500] },
      minOut: 10n ** 15n, precommitment: 0x5e11n, feeCap: 10n ** 14n, feeRecipient: r.FeeCollector!.address, deadline: BigInt(NOW + 300), nonce: 0n,
    };
    const built = pinnedBuildSell(evmPoolVenues(), chain, { ...req, pool: OTHER } as typeof req);
    assert.equal(lower(built.pool), lower(pool), chain);
    assert.equal(pinnedSignSell(evmPoolVenues(), W_KEY, chain, built).length, 65, chain);
    assert.equal(code(() => pinnedBuildSell(evmPoolVenues(), chain, { ...req, feeRecipient: OTHER })), "not_pinned", chain);
    const v4sell = { ...req, target: v.poolManager!, route: { venue: "uniswap-v4" as const, hops: [{ currency: ZERO, fee: 10000, tickSpacing: 200, hooks: ZERO, hookData: "0x" }] } };
    assert.equal(lower(pinnedBuildSell(evmPoolVenues(), chain, v4sell).pool), lower(pool), chain);
    const a = kit.evmPoolSignSellAuthorization(W_KEY, chain, 0n);
    assert.equal(lower(a.address), lower(r.SellDelegate!.address), chain);
    assert.equal(a.chainId, evmPoolVenues()[chain].chainId, chain);
  }
});

test("a buy builds only through the chain's pinned adapter for its venue, and W signs it only into the pinned pool", () => {
  for (const { chain } of TESTNETS) {
    const c = chain as EvmPoolChain;
    const v = evmPoolVenues()[c];
    const r = record(chain);
    // v4: the pinned adapter only
    assert.equal(code(() => pinnedBuild(evmPoolVenues(), c, OTHER, v4(), 1n, X)), "not_pinned", chain);
    assert.equal(code(() => pinnedBuild(evmPoolVenues(), c, r.PrivacyPoolSimple!.address, v4(), 1n, X)), "not_pinned", chain);
    const built = pinnedBuild(evmPoolVenues(), c, r.UniswapV4Adapter!.address, v4(), 1n, X);
    // the pool: the pinned one only
    assert.equal(code(() => pinnedSignBuy(evmPoolVenues(), W_KEY, c, OTHER, built, PROOF)), "not_pinned", chain);
    assert.equal(code(() => pinnedSignBuy(evmPoolVenues(), W_KEY, c, r.UniswapV4Adapter!.address, built, PROOF)), "not_pinned", chain);
    assert.equal(pinnedSignBuy(evmPoolVenues(), W_KEY, c, r.PrivacyPoolSimple!.address.toUpperCase().replace("0X", "0x"), built, PROOF).length, 65, chain);
    // the kit's signer takes only a buy evmPoolBuildQuoted returned, from a device quote (the testnets have no quoter)
    assert.equal(code(() => kit.evmPoolSignBuy(W_KEY, c, r.PrivacyPoolSimple!.address, built, PROOF)), "not_built", chain);
    // v3: Base Sepolia's pinned adapter only; Robinhood testnet has none
    if (r.UniswapV3Adapter) {
      assert.equal(code(() => pinnedBuild(evmPoolVenues(), c, OTHER, v3(v.weth), 1n, X)), "not_pinned", chain);
      assert.equal(code(() => pinnedBuild(evmPoolVenues(), c, r.UniswapV4Adapter!.address, v3(v.weth), 1n, X)), "not_pinned", chain);
      const b3 = pinnedBuild(evmPoolVenues(), c, r.UniswapV3Adapter.address, v3(v.weth), 1n, X);
      assert.equal(pinnedSignBuy(evmPoolVenues(), W_KEY, c, r.PrivacyPoolSimple!.address, b3, PROOF).length, 65, chain);
    } else {
      assert.equal(code(() => pinnedBuild(evmPoolVenues(), c, OTHER, v3(v.weth), 1n, X)), "not_deployed", chain);
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
      minOut: 10n ** 15n, precommitment: 0x5e11n, feeCap: 10n ** 14n, feeRecipient: collector(chain), deadline: BigInt(NOW + 300), nonce: 0n,
    };
    assert.equal(lower(v.feeCollector!), lower(collector(chain)), chain);
    if (routers.length > 0) {
      // a pool the caller sneaks in is not read: the pin is the pool
      // the pinned builder under the kit's evmPoolBuildSell (sell.ts, which builds only from a device quote)
      const built = pinnedBuildSell(evmPoolVenues(), c, { ...req, pool: OTHER } as typeof req);
      assert.equal(lower(built.pool), lower(r.PrivacyPoolSimple!.address), chain);
      assert.equal(pinnedSignSell(evmPoolVenues(), W_KEY, c, built).length, 65, chain);
    } else {
      // Robinhood testnet has no v3 router (M365), so no v3 sell is built there
      assert.equal(code(() => pinnedBuildSell(evmPoolVenues(), c, req)), "bad_target", chain);
    }
    // a v4 sell goes through the pinned PoolManager on every testnet (card evm-sell-v4-kit), and through no other
    // target: not the other testnet's PoolManager, not the router (review of a22060d, item 3)
    const v4sell = { ...req, target: v.poolManager!, route: { venue: "uniswap-v4" as const, hops: [{ currency: ZERO, fee: 10000, tickSpacing: 200, hooks: ZERO, hookData: "0x" }] } };
    const built4 = pinnedBuildSell(evmPoolVenues(), c, v4sell);
    // any other recipient, the withdraw relayer's included, is not the pin: no Sell is built
    assert.equal(code(() => pinnedBuildSell(evmPoolVenues(), c, { ...v4sell, feeRecipient: "0x000000000000000000000000000000000000fee1" })), "not_pinned", chain);
    assert.equal(lower(built4.pool), lower(r.PrivacyPoolSimple!.address), chain);
    for (const other of TESTNETS.map((t) => evmPoolVenues()[t.chain as EvmPoolChain].poolManager!).filter((p) => lower(p) !== lower(v.poolManager!))) {
      assert.equal(code(() => pinnedBuildSell(evmPoolVenues(), c, { ...v4sell, target: other })), "bad_target", chain);
    }
    assert.equal(code(() => pinnedBuildSell(evmPoolVenues(), c, { ...v4sell, target: "0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4" })), "bad_target", chain);
    const a = kit.evmPoolSignSellAuthorization(W_KEY, c, 0n);
    assert.equal(lower(a.address), lower(sellRecord(chain).SellDelegate!.address), chain);
    assert.equal(a.chainId, chainId, chain);
    // the authorization takes no delegate: a fourth argument is not read
    const b = (kit.evmPoolSignSellAuthorization as (...x: unknown[]) => typeof a)(W_KEY, c, 0n, OTHER);
    assert.equal(lower(b.address), lower(sellRecord(chain).SellDelegate!.address), chain);
  }
});
