// A private buy on Base or Robinhood Chain from the EVM pool (contracts/pool-evm, PrivacyPoolSimple.buy; merge notes
// M354, M357, M358 (3), M360; card evm-pool-buy-tx). Device side: the device builds the adapter's route from the user's
// own request and W signs the pool's EIP-712 Buy over it, so the relayer that sends it can change nothing W signed.
//
// The adapters (contracts/pool-evm/src/adapters) and the `data` each reads:
// - Uniswap v3 (UniswapV3Adapter): SwapRouter02's packed path, token (20) then fee (u24, 3 bytes) and token per hop,
//   starting at the chain's WETH (the router wraps the native value).
// - Uniswap v4 (UniswapV4Adapter): abi.encode(address currencyIn, PathKey[] path), currencyIn the native asset
//   (address 0) or WETH, each PathKey (intermediateCurrency, fee u24, tickSpacing i24, hooks, hookData) in
//   v4-periphery's field order. A hook is part of the price (M360): for a hooked hop minOut is the bound.
// The routes the fork tests run are recorded in contracts/pool-evm/test/fixtures/kit-routes.json, which the forge
// tests check against their own routes and test/evm-pool-buy.test.ts against these builders, byte for byte.
//
// Refusals (M358 (3), from the pool-evm-buy review): WETH anywhere after a route's first token (INFO-1) and a middle
// token that is not on the chain's venue list (INFO-2), each with its own code; and a route that buys another token
// than the user picked (token_mismatch, M366 (1)).
//
// W signs Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)
// under the domain {name "Blindfill", version "1", chainId, verifyingContract: the pool} (contracts/pool-evm
// PrivacyPool.sol _typedDigest, PrivacyPoolSimple.sol _buyDigest), with the proof's nullifier, context and
// withdrawnValue (M354, M357 (2)): 65 bytes r ‖ s ‖ v, s in the lower half (EIP-2), v 27 or 28. The key is W's, from
// the wallet's own derivation (packages/wallet freshWallet "evm"), and stays on the device; the pool checks it is the
// request's recipient. W signs no digest a caller hands in (M366 (2)): only a buy evmPoolBuildUnpinned returned, for its chain,
// with the digest made here.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export type EvmPoolChain = "base" | "robinhood" | "base-sepolia" | "robinhood-testnet";

/** One chain's venue: chain id, WETH (a route's only wrapped start), the middle tokens a route may pass through, and
 *  the routers a sell may call (sell.ts). */
export type EvmPoolVenue = {
  readonly chainId: number;
  readonly weth: string;
  readonly middles: readonly string[];
  readonly routers: readonly string[];
  /** The pins (M370): the pool every buy and sell of the chain goes through, the buy adapters per venue, and the
   *  delegate W's EIP-7702 authorization names; a chain with none refuses not_deployed. Set from pool-evm-deploy's
   *  records (card evm-venues-pin): the testnets have theirs, the mainnets none until their deploy. */
  readonly pool?: string;
  readonly adapters?: Readonly<{ v3?: string; v4?: string }>;
  readonly sellDelegate?: string;
  /** The helper's EVM pool sender (apps/helper pool/evm.ts), which sends each sale to W: the sim of a sale runs from it
   *  (checks/evm/quote.ts simRule, card evm-quote-exec-sim), so a hook sees the sim as it sees the sale. A kit pin, never
   *  read from the helper; the helper refuses to start a sender whose key is not the pin (evmPoolSendersFromEnv). A
   *  chain with none sims no sale ("keep-min"): the testnets pin theirs, the mainnets none until their sell keys. */
  readonly sellSender?: string;
  /** The quoters the device's own quote reads (checks/evm/quote.ts, card evm-pool-buy-quote): Uniswap's QuoterV2 for
   *  v3 and V4Quoter for v4; a chain with none refuses no_quoter. */
  readonly quoters?: Readonly<{ v3?: string; v4?: string }>;
  /** A route starts from the native asset whenever a native v4 pool exists and its route quotes at least as much as the
   *  WETH route (the chain's WETH is behind an upgradeable proxy). */
  readonly nativeFirst?: boolean;
  /** The two RPC providers the device's quote reads (different hosts), and how many blocks their heads may differ. */
  readonly providers?: readonly [string, string];
  readonly maxLag?: number;
  /** The launchpads' hooked v4 pool shapes the device reads as reference pools (a route through any other hook has only
   *  the standard pools to be held to): the asset the pool pairs the token with, fee, tick spacing and hook. */
  readonly hookedPools?: readonly EvmHookedPool[];
  /** Uniswap v4's PoolManager (the V4Quoter's poolManager()), whose state the device reads for each pool it found, and
   *  the provider it scans for the PoolManager's Initialize logs: `span` blocks a request, `depth` blocks back, at most
   *  `parallel` requests at once. */
  readonly poolManager?: string;
  readonly scan?: Readonly<{ url: string; span: number; depth: number; parallel: number; orSpan?: number }>;
};
export type EvmHookedPool = { readonly pad: string; readonly from: "native" | "weth"; readonly fee: number; readonly tickSpacing: number; readonly hooks: string };

/** The chains the EVM pool runs on and their venues (the venue list). The builder's checks and the signer's chain id
 *  read only this list. Frozen all the way down, so no code can swap a chain id, WETH or a middle (nor, once
 *  pool-evm-deploy pins them here, an adapter or a pool, M366 (4)); made on first use, never at load: the kit's index
 *  reaches the signing page's bundle, which keeps any top-level call (build-app.mjs --check). Every object level has
 *  no prototype, so no read of the list reaches Object.prototype, which a polluted page could fill with a pool, an
 *  adapter or a delegate (the review of 8d8675d); the adapters pool-evm-deploy adds get the same `bare`. */
const bare = <T extends object>(o: T): Readonly<T> => Object.freeze(Object.assign(Object.create(null) as T, o));
/** A venue list the pinned functions read (evmPoolVenues(), or a test's): a chain it does not have is refused. */
export type EvmPoolVenueList = Readonly<Partial<Record<EvmPoolChain, EvmPoolVenue>>>;
let venues: Readonly<Record<EvmPoolChain, EvmPoolVenue>> | undefined;
export const evmPoolVenues = (): Readonly<Record<EvmPoolChain, EvmPoolVenue>> =>
  (venues ??= bare({
    base: bare({
      chainId: 8453,
      weth: "0x4200000000000000000000000000000000000006",
      middles: Object.freeze(["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]), // USDC
      // Uniswap v3 SwapRouter02 (test/SellFork.t.sol, BuyFork.t.sol); eth_getCode on mainnet.base.org and
      // base-rpc.publicnode.com: the same 24,498 bytes, codehash 0x38bd640f…124e4 (2026-11-03)
      routers: Object.freeze(["0x2626664c2603336E57B271c5C0b26F421741e481"]),
      // Uniswap's QuoterV2 and V4Quoter (contracts/pool-evm/test/BuyFork.t.sol, BuyV4Fork.t.sol); eth_getCode on
      // mainnet.base.org and base-rpc.publicnode.com, the same code on both (2026-11-03 17:56Z): 8,273 bytes, keccak
      // 0xceb5b8bc…ee51e, and 5,820 bytes, keccak 0x9a5c0cdd…38bb3
      quoters: bare({ v3: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", v4: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D" }),
      providers: Object.freeze(["https://mainnet.base.org", "https://base-rpc.publicnode.com"] as const),
      maxLag: 5, // 2 s blocks: 10 s
      // Each launchpad factory's recent creations (apps/helper/src/data/evm/lists.ts) and the PoolManager Initialize log in
      // the same transaction, read 2026-11-03 18:49Z on base-rpc.publicnode.com; each hook's code the same on both
      // providers (bytes, keccak prefix): Clanker v4 16,405 b0676099; Zora 24,148 90685df9; Doppler 4,884 317314fa;
      // Flaunch 23,479 295e84c7
      hookedPools: Object.freeze([
        bare({ pad: "clanker", from: "weth" as const, fee: 0x800000, tickSpacing: 200, hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc" }),
        bare({ pad: "zora", from: "weth" as const, fee: 0x800000, tickSpacing: 200, hooks: "0x0469a4bd3724dc86c9542f4694c976da13c450c0" }),
        bare({ pad: "doppler", from: "weth" as const, fee: 0x800000, tickSpacing: 10, hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0" }),
        bare({ pad: "flaunch", from: "native" as const, fee: 0, tickSpacing: 60, hooks: "0x588c683ecc450f8b2aadb13d7f63792b840425dc" }),
      ]),
      // V4Quoter.poolManager() on both providers (2026-11-03 19:36Z). base-rpc.publicnode.com serves eth_getLogs over
      // 50,000 blocks a request and about 1M blocks back (3M back: "Archive requests require a personal token");
      // mainnet.base.org only about 100 (read 19:37Z). publicnode answered every request with HTTP 200 and no error at
      // 4, 8, 12, 16, 20 and 30 requests at once, twice each, and at 40 (two cold scans at once), three times
      // (2026-11-03 20:11-20:24Z): 20, one cold scan's every span at once, takes no 429
      poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
      scan: bare({ url: "https://base-rpc.publicnode.com", span: 50_000, depth: 1_000_000, parallel: 20 }),
    }),
    robinhood: bare({
      chainId: 4663,
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // aeWETH, an upgradeable proxy (contracts/pool-evm/NOTICE)
      middles: Object.freeze(["0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"]), // USDG
      // Uniswap v3 SwapRouter02 (test/SellFork.t.sol, BuyFork.t.sol); eth_getCode on rpc.mainnet.chain.robinhood.com
      // and robinhood.drpc.org: the same 24,498 bytes, codehash 0x6f36c378…b25dc (2026-11-03)
      routers: Object.freeze(["0xCaf681a66D020601342297493863E78C959E5cb2"]),
      // Uniswap's QuoterV2 and V4Quoter (BuyFork.t.sol, BuyV4Fork.t.sol); eth_getCode on rpc.mainnet.chain.robinhood.com
      // and robinhood.drpc.org, the same code on both (2026-11-03 17:56Z): 8,273 bytes, keccak 0x3db0868d…96a28, and
      // 6,118 bytes, keccak 0xd707b1da…868f6
      quoters: bare({ v3: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7", v4: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94" }),
      nativeFirst: true,
      providers: Object.freeze(["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org"] as const),
      // blocks 104,343,212 and 105,310,444 are 99,125 s apart on rpc.mainnet.chain.robinhood.com (read 2026-11-03
      // 19:38Z): 0.102 s a block, so 100 blocks are about 10 s
      maxLag: 100,
      // as Base's (read 2026-11-03 18:49Z on rpc.mainnet.chain.robinhood.com; code the same on both providers): Clanker v4
      // 16,405 0883056c; Doppler 25,533 c41a9110
      hookedPools: Object.freeze([
        bare({ pad: "clanker", from: "weth" as const, fee: 0x800000, tickSpacing: 200, hooks: "0x48b8f6ad3a1b4aa477314c9a23035b8f84dde8cc" }),
        bare({ pad: "doppler", from: "weth" as const, fee: 0x800000, tickSpacing: 8, hooks: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544" }),
        // Doppler's second shape: 65 Initialize events in blocks 104,310,445-105,310,444, paired with WETH in 33 (e.g.
        // tx 0xb30325e2…363df7)
        bare({ pad: "doppler", from: "weth" as const, fee: 0x800000, tickSpacing: 200, hooks: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544" }),
      ]),
      // V4Quoter.poolManager() on both providers (2026-11-03 19:36Z). rpc.mainnet.chain.robinhood.com serves eth_getLogs
      // over 10,000,000 blocks a request but at most 10,000 logs ("logs matched by query exceeds limit of 10000" over
      // 10M blocks; robinhood.drpc.org: 10,000 blocks on its free plan), so 1M-block spans
      poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      // (it answers 429 to 4 at once, 2026-11-03 20:27Z); a request with more than one value in a topic position spans
      // at most 100,000 blocks ("query spans 1000000 blocks …, but only 100000 are allowed for this request; narrow the
      // block range, or send one value per position", 2026-11-04 06:55Z): `orSpan`
      scan: bare({ url: "https://rpc.mainnet.chain.robinhood.com", span: 1_000_000, depth: 10_000_000, parallel: 2, orSpan: 100_000 }),
    }),
    // The testnets: each pin is pool-evm-deploy's record (scripts/live-checks/pool-evm-deploy.<chain>.json, deployed
    // 2026-11-03), whose code scripts/live-checks/evm-venues-pin.mjs reads on the chain's two RPCs against the build
    // (pool-evm-deploy.build.json). No middle is listed, so a route is WETH and the token only.
    "base-sepolia": bare({
      chainId: 84532,
      weth: "0x4200000000000000000000000000000000000006",
      middles: Object.freeze([]),
      // Uniswap v3 SwapRouter02, the v3 adapter's router (scripts/live-checks/pool-evm-deploy.mjs CHAINS: its code hash
      // read on sepolia.base.org and base-sepolia-rpc.publicnode.com)
      routers: Object.freeze(["0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4"]),
      pool: "0xb239a38af69b68e6c5c305df64985f283b5d5fe5",
      adapters: bare({ v3: "0xee89916bc4bdeee46dbcaf8fad2b7604724b5645", v4: "0x706b3f75e80be70494d1414b85788462bfeb7eb1" }),
      // the delegate that sells through the v4 PoolManager and reverts unless W's balance of the token fell by exactly
      // the signed amount (card evm-selldelegate-exact-debit: scripts/live-checks/evm-selldelegate-exact-debit.
      // base-sepolia.json, deploy tx 0xa889469f4b7386072b3343b295002c09a4aff89638d29b304ac940c0c6168121; its code the
      // build's, read by that card's live check on sepolia.base.org and base-sepolia-rpc.publicnode.com, 4 Nov)
      sellDelegate: "0xe39f1b9934810792c090d8ab8f555b9955527260",
      // the helper's sell sender (POOL_EVM_SELL_KEY_BASE_SEPOLIA, made on the helper box by
      // scripts/deploy/evm-sender-key.mjs, which printed only this address; 0.001 ETH read on sepolia.base.org and
      // base-sepolia-rpc.publicnode.com, 4 Nov 17:33Z); the helper does not start with any other sell key
      sellSender: "0xd378cda68babba6a9dc1d52335bb76ca9e6a7553",
      // Uniswap v4's PoolManager (pool-evm-deploy.mjs CHAINS, its code hash pinned there), the target of a v4 sell
      poolManager: "0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408",
      // Uniswap's QuoterV2 and V4Quoter (developers.uniswap.org's Base Sepolia deployments); eth_getCode on
      // sepolia.base.org and base-sepolia-rpc.publicnode.com, the same on both (2026-11-04 09:55Z): 8,273 bytes, keccak
      // 0x156c129c…, factory() 0x4752ba5d…ad24; and 5,820 bytes, keccak 0x2dddcef8…, poolManager() the PoolManager above
      quoters: bare({ v3: "0xc5290058841028f1614f3a6f0f5816cad0df5e27", v4: "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba" }),
      providers: Object.freeze(["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"] as const),
      // 2 s blocks; the two heads were 5 blocks apart in one read (2026-11-04 09:53Z), so 10 blocks, 20 s
      maxLag: 10,
    }),
    "robinhood-testnet": bare({
      chainId: 46630,
      weth: "0x7943e237c7f95da44e0301572d358911207852fa", // behind an upgradeable proxy (pool-evm-deploy.mjs CHAINS, M365)
      middles: Object.freeze([]),
      // no Uniswap v3 on Robinhood testnet (M365): no v3 adapter and no router; a sell goes through the PoolManager
      routers: Object.freeze([]),
      pool: "0xe5e948414a89c23e73d76cd740dacdd9364c25d5",
      adapters: bare({ v4: "0x6c43a39fcb2ea65f47625ef5ce5fea98fc669797" }),
      // the delegate that sells through the v4 PoolManager alone here and reverts unless W's balance of the token fell
      // by exactly the signed amount (card evm-selldelegate-exact-debit: scripts/live-checks/
      // evm-selldelegate-exact-debit.robinhood-testnet.json, deploy tx
      // 0x62c517784feda75d5597229118cb9c4eb2a370fc34114694c1d009ce84158459; its code the build's, read by that card's
      // live check on rpc.testnet.chain.robinhood.com and robinhood-sepolia-rpc.publicnode.com, 4 Nov)
      sellDelegate: "0x9909a660c8a55829335dd4d894c8375bfcfcd65b",
      // the helper's sell sender (POOL_EVM_SELL_KEY_ROBINHOOD_TESTNET, made as on Base Sepolia; 0.001 ETH read on
      // rpc.testnet.chain.robinhood.com and robinhood-sepolia-rpc.publicnode.com, 4 Nov 17:33Z)
      sellSender: "0xd12d83097671d731df2db731e973ad9a07673607",
      poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      // Uniswap's V4Quoter at mainnet's address with mainnet's code (testnet-run.mjs NETS); eth_getCode on
      // rpc.testnet.chain.robinhood.com and robinhood-sepolia-rpc.publicnode.com, the same on both (2026-11-04 09:55Z):
      // 6,118 bytes, keccak 0xd707b1da…, poolManager() the PoolManager above. No v3 here (M365)
      quoters: bare({ v4: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" }),
      nativeFirst: true,
      providers: Object.freeze(["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"] as const),
      // the two heads were 18 blocks apart in one read (2026-11-04 09:53Z); mainnet's 100, about 10 s
      maxLag: 100,
    }),
  }));

/** Most hops a route takes; a fee fits u24; v4's tick spacing is 1 to 32,767 (v4-core TickMath); hook data is bounded. */
export const EVM_POOL_MAX_HOPS = 4;
export const EVM_POOL_MAX_HOOK_DATA = 1024;
const U24 = 0xffffff;
const MAX_TICK_SPACING = 32767;
const NATIVE = "0x0000000000000000000000000000000000000000";

export type EvmV3Route = { venue: "uniswap-v3"; tokens: readonly string[]; fees: readonly number[] };
export type EvmV4Hop = { currency: string; fee: number; tickSpacing: number; hooks: string; hookData: string };
export type EvmV4Route = { venue: "uniswap-v4"; currencyIn: string; hops: readonly EvmV4Hop[] };
export type EvmRoute = EvmV3Route | EvmV4Route;

export type EvmPoolBuyErrorCode =
  | "weth_after_first" // INFO-1: WETH anywhere after the route's first token
  | "middle_not_listed" // INFO-2: a middle token that is not on the venue list
  | "token_mismatch" // the route buys another token than the user picked
  | "not_built" // W signs only a buy evmPoolBuildUnpinned returned, for the chain it was built for
  | "bad_route" // the route's shape: hops, fees, tick spacing, addresses, hook data, start or end; the chain or pool
  | "bad_amount" // minOut, nullifier, context or value out of range
  | "bad_key" // W's key is not a key
  | "not_deployed" // the chain has no pinned pool or adapter yet (pool-evm-deploy)
  | "not_pinned"; // an adapter or pool other than the chain's pinned one
export class EvmPoolBuyError extends Error {
  readonly code: EvmPoolBuyErrorCode;
  constructor(code: EvmPoolBuyErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "EvmPoolBuyError";
  }
}
const refuse = (code: EvmPoolBuyErrorCode, m: string): never => {
  throw new EvmPoolBuyError(code, m);
};

const isAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const lower = (a: string) => a.toLowerCase();
const hexBytes = (h: string): Uint8Array => {
  if (typeof h !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(h)) return refuse("bad_route", "hook data is not 0x hex");
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
};
const toHex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const concat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) out.set(x, o), (o += x.length);
  return out;
};
const word = (v: bigint): Uint8Array => {
  if (v < 0n || v >= 1n << 256n) throw new Error("not a uint256");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) (out[i] = Number(v & 0xffn)), (v >>= 8n);
  return out;
};
const addressWord = (a: string) => word(BigInt(a));
const addressBytes = (a: string) => word(BigInt(a)).slice(12);

/** The venue of `chain`, or a refusal: only the list's own keys, never one an object inherits ("constructor"). */
function venueOf(chain: EvmPoolChain) {
  const all = evmPoolVenues();
  if (typeof chain !== "string" || !Object.hasOwn(all, chain)) return refuse("bad_route", "no such chain");
  return all[chain];
}

// A copy holds at most this many items per list, before the shape checks bound the route exactly
const COPY_MAX = 64;
const copyList = (a: unknown): unknown[] => {
  if (!Array.isArray(a)) return refuse("bad_route", "a route's tokens, fees and hops are lists");
  const n = a.length;
  if (!Number.isSafeInteger(n) || n > COPY_MAX) return refuse("bad_route", "a route's list is too long");
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(a[i]);
  return out;
};

/** One frozen copy of `route`, each field read once (merge note M366 (3)): the checks and the encoder read only this,
 *  so a getter or a later change to the caller's object cannot show them two different routes. */
export function copyRoute(route: unknown): EvmRoute {
  if (typeof route !== "object" || route === null) return refuse("bad_route", "a route is an object");
  const venue = (route as { venue?: unknown }).venue;
  if (venue === "uniswap-v3") {
    const { tokens, fees } = route as Record<string, unknown>;
    return Object.freeze({ venue, tokens: Object.freeze(copyList(tokens)), fees: Object.freeze(copyList(fees)) }) as EvmV3Route;
  }
  if (venue === "uniswap-v4") {
    const { currencyIn, hops } = route as Record<string, unknown>;
    const copied = copyList(hops).map((h) => {
      if (typeof h !== "object" || h === null) return refuse("bad_route", "a hop is an object");
      const { currency, fee, tickSpacing, hooks, hookData } = h as Record<string, unknown>;
      return Object.freeze({ currency, fee, tickSpacing, hooks, hookData });
    });
    return Object.freeze({ venue, currencyIn, hops: Object.freeze(copied) }) as EvmV4Route;
  }
  return refuse("bad_route", "no such venue");
}

/** The route's tokens in order (v3: its tokens; v4: currencyIn then each hop's currency), with the chain's checks:
 *  shape, WETH only first (INFO-1), every middle on the venue list (INFO-2). Returns the token bought. `route` is
 *  copyRoute's copy. `quoted`: a v4 route the device quotes itself (checks/evm/quote.ts) or builds from its own
 *  quote (buy.ts evmPoolBuildQuoted) may pass through a middle that is not listed. A v4 middle never moves a token:
 *  the adapter swaps hop by hop inside one PoolManager unlock and takes only the last currency (UniswapV4Adapter
 *  unlockCallback), so a middle's deltas net to zero there, and its only effect on the buy is through the route's
 *  hooks, which ran in the device's quote on both providers and which minOut, set from that quote, bounds. A v3
 *  middle is a real ERC-20 transfer between pools, so a v3 route's middles stay listed-only. */
function checkRoute(chain: EvmPoolChain, route: EvmRoute, quoted = false): string {
  const venue = venueOf(chain);
  let tokens: string[];
  if (route.venue === "uniswap-v3") {
    const { tokens: t, fees } = route;
    if (fees.length < 1 || fees.length > EVM_POOL_MAX_HOPS || t.length !== fees.length + 1) {
      return refuse("bad_route", `a v3 route is 1 to ${EVM_POOL_MAX_HOPS} hops, one more token than fees`);
    }
    for (const f of fees) if (!Number.isInteger(f) || f < 0 || f > U24) refuse("bad_route", "a v3 fee is a u24");
    tokens = [...t];
    if (!tokens.every(isAddress)) return refuse("bad_route", "a token is not an address");
    if (lower(tokens[0]!) !== lower(venue.weth)) return refuse("bad_route", "a v3 route starts at the chain's WETH");
  } else {
    const { currencyIn, hops } = route;
    if (hops.length < 1 || hops.length > EVM_POOL_MAX_HOPS) {
      return refuse("bad_route", `a v4 route is 1 to ${EVM_POOL_MAX_HOPS} hops`);
    }
    if (!isAddress(currencyIn) || (lower(currencyIn) !== NATIVE && lower(currencyIn) !== lower(venue.weth))) {
      return refuse("bad_route", "a v4 route starts from the native asset or the chain's WETH");
    }
    for (const h of hops) {
      if (!isAddress(h.currency) || !isAddress(h.hooks)) refuse("bad_route", "a hop's currency or hooks is not an address");
      if (!Number.isInteger(h.fee) || h.fee < 0 || h.fee > U24) refuse("bad_route", "a v4 fee is a u24");
      if (!Number.isInteger(h.tickSpacing) || h.tickSpacing < 1 || h.tickSpacing > MAX_TICK_SPACING) {
        refuse("bad_route", `a v4 tick spacing is 1 to ${MAX_TICK_SPACING}`);
      }
      if (hexBytes(h.hookData).length > EVM_POOL_MAX_HOOK_DATA) refuse("bad_route", `hook data is at most ${EVM_POOL_MAX_HOOK_DATA} bytes`);
    }
    tokens = [currencyIn, ...hops.map((h) => h.currency)];
  }
  const weth = lower(venue.weth);
  if (tokens.slice(1).some((t) => lower(t) === weth)) return refuse("weth_after_first", "WETH may only start a route");
  const listed = new Set(venue.middles.map(lower));
  if (!(quoted && route.venue === "uniswap-v4")) {
    for (const t of tokens.slice(1, -1)) if (!listed.has(lower(t))) refuse("middle_not_listed", `${t} is not on the venue list`);
  }
  const out = tokens[tokens.length - 1]!;
  if (lower(out) === NATIVE || lower(out) === lower(tokens[tokens.length - 2]!)) return refuse("bad_route", "the route buys no token");
  return out;
}

/** The adapter's `data` for `route` on `chain`, after every check; and the token it buys. Checks and encodes one
 *  frozen copy of `route`. */
export function evmPoolRouteData(chain: EvmPoolChain, route: EvmRoute): { data: Uint8Array; token: string } {
  return routeData(chain, route, false);
}
/** evmPoolRouteData for a route the device quotes itself: a v4 route's middles need not be listed (see checkRoute).
 *  checks/evm/quote.ts reads only through this; the kit's index does not export it. */
export function evmPoolRouteDataQuoted(chain: EvmPoolChain, route: EvmRoute): { data: Uint8Array; token: string } {
  return routeData(chain, route, true);
}
function routeData(chain: EvmPoolChain, route: EvmRoute, quoted: boolean): { data: Uint8Array; token: string } {
  const r = copyRoute(route);
  const token = checkRoute(chain, r, quoted);
  if (r.venue === "uniswap-v3") {
    const parts = [addressBytes(r.tokens[0]!)];
    r.fees.forEach((f, i) => parts.push(Uint8Array.of(f >> 16, (f >> 8) & 0xff, f & 0xff), addressBytes(r.tokens[i + 1]!)));
    return { data: concat(...parts), token };
  }
  // abi.encode(address, (address,uint24,int24,address,bytes)[]): the head (currencyIn, offset 0x40), then the array
  return { data: concat(addressWord(r.currencyIn), word(0x40n), pathKeysAbi(r.hops)), token };
}

/** The ABI tail of a PathKey[] (v4-periphery's (address,uint24,int24,address,bytes)[]): the array's length, one offset
 *  per element (from the first offset's word), then each element: five head words (the bytes' offset 0xa0) and its
 *  bytes, length then right-padded to 32. For hops already checked; the buy's adapter data and the sell's
 *  SellDelegate data (sell-unpinned.ts) both encode through this. */
export function pathKeysAbi(hops: readonly EvmV4Hop[]): Uint8Array {
  const elems = hops.map((h) => {
    const d = hexBytes(h.hookData);
    const padded = new Uint8Array(Math.ceil(d.length / 32) * 32);
    padded.set(d);
    return concat(addressWord(h.currency), word(BigInt(h.fee)), word(BigInt(h.tickSpacing)), addressWord(h.hooks), word(0xa0n), word(BigInt(d.length)), padded);
  });
  const offsets: Uint8Array[] = [];
  let at = 32 * elems.length;
  for (const e of elems) offsets.push(word(BigInt(at))), (at += e.length);
  return concat(word(BigInt(elems.length)), ...offsets, ...elems);
}

/** The pool's Buy: what PrivacyPoolSimple.buy takes beside the request and the proof, what W signs, and the chain it
 *  was checked for. Only evmPoolBuildUnpinned makes one, frozen; evmPoolSignBuyUnpinned signs no other. */
export type EvmPoolBuy = { readonly chain: EvmPoolChain; readonly adapter: string; readonly data: string; readonly minOut: bigint; readonly token: string };

// Every buy evmPoolBuildUnpinned returned (merge note M366 (2)): a copy, a spread or a hand-made object is not in it
const BUILT = new WeakSet<EvmPoolBuy>();

/** The buy of `token`, the token the user picked, for `route` through `adapter` with at least `minOut` of it for W
 *  (minOut comes from the device's own reads; never 0, as the pool refuses it). A route that buys any other token is
 *  refused (token_mismatch): the pool checks only the named token's balance (M366 (1)). */
export function evmPoolBuildUnpinned(chain: EvmPoolChain, adapter: string, route: EvmRoute, minOut: bigint, token: string, quoted = false): EvmPoolBuy {
  if (!isAddress(adapter) || lower(adapter) === NATIVE) return refuse("bad_route", "the adapter is not an address");
  if (!isAddress(token) || lower(token) === NATIVE) return refuse("bad_route", "the token is not an address");
  if (typeof minOut !== "bigint" || minOut <= 0n || minOut >= 1n << 256n) return refuse("bad_amount", "minOut is a uint256 above 0");
  const { data, token: buys } = routeData(chain, route, quoted);
  if (lower(buys) !== lower(token)) return refuse("token_mismatch", `the route buys ${buys}, not ${token}`);
  const built: EvmPoolBuy = Object.freeze({ chain, adapter, data: toHex(data), minOut, token });
  BUILT.add(built);
  return built;
}

// Made on use, never at load: the kit's index reaches the signing page's bundle, which keeps any top-level call
const DOMAIN_TYPEHASH = () => keccak_256(new TextEncoder().encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const BUY_TYPEHASH = () => keccak_256(
  new TextEncoder().encode("Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)"),
);
const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** The proof's public values W's signature binds: existingNullifierHash, context and withdrawnValue. */
export type EvmPoolProofBinding = { nullifier: bigint; context: bigint; value: bigint };

/** The EIP-712 digest of `buy` for `proof` on `pool`, with the chain id of the chain `buy` was built for, as
 *  PrivacyPoolSimple._buyDigest makes it. Module-private: only evmPoolSignBuyUnpinned calls it, with a buy from BUILT. */
function buyDigest(pool: string, buy: EvmPoolBuy, proof: EvmPoolProofBinding): Uint8Array {
  const chainId = venueOf(buy.chain).chainId;
  if (!isAddress(pool) || lower(pool) === NATIVE) return refuse("bad_route", "the pool is not an address");
  if (typeof proof !== "object" || proof === null) return refuse("bad_amount", "the proof's values are an object");
  const p = { nullifier: proof.nullifier, context: proof.context, value: proof.value };
  for (const [n, v] of Object.entries(p)) {
    if (typeof v !== "bigint" || v < 0n || v >= FIELD_P) refuse("bad_amount", `${n} is a field element`);
  }
  if (p.value === 0n) return refuse("bad_amount", "value is above 0");
  const domain = keccak_256(concat(DOMAIN_TYPEHASH(), keccak_256(new TextEncoder().encode("Blindfill")), keccak_256(new TextEncoder().encode("1")), word(BigInt(chainId)), addressWord(pool)));
  const struct = keccak_256(
    concat(BUY_TYPEHASH(), addressWord(buy.adapter), keccak_256(hexBytes(buy.data)), word(buy.minOut), addressWord(buy.token), word(p.nullifier), word(p.context), word(p.value)),
  );
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), domain, struct));
}

/** W's signature of the pool's Buy for `built` and `proof` on `pool`: 65 bytes r ‖ s ‖ v, s low, v 27 or 28.
 *  `secretKey` is W's 32-byte key (the wallet's freshWallet for "evm"). `built` must be a buy evmPoolBuildUnpinned returned for
 *  `chain` (not_built otherwise), and the digest is made here, so no input reaches W's key but a checked Buy. */
export function evmPoolSignBuyUnpinned(secretKey: Uint8Array, chain: EvmPoolChain, pool: string, built: EvmPoolBuy, proof: EvmPoolProofBinding): Uint8Array {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32 || !secp256k1.utils.isValidSecretKey(secretKey)) {
    return refuse("bad_key", "W's key is a 32-byte secp256k1 key");
  }
  if (!BUILT.has(built) || built.chain !== chain) return refuse("not_built", "W signs only a buy evmPoolBuildUnpinned returned for this chain");
  const digest = buyDigest(pool, built, proof);
  const rec = secp256k1.sign(digest, secretKey, { prehash: false, lowS: true, format: "recovered" });
  // noble's recovered form is the recovery bit, then r and s
  const out = new Uint8Array(65);
  out.set(rec.slice(1, 65), 0);
  out[64] = 27 + rec[0]!;
  return out;
}

// The pinned buy (M370): what the kit's evmPoolBuildQuoted and evmPoolSignBuy run (buy.ts), here with the venue list
// as an input so the tests can pin a list of their own; the index's functions pass evmPoolVenues().

/** A pin: `o`'s own `k` when it is a string, never one inherited from a prototype a polluted page filled. */
function ownPin(o: unknown, k: string): string | undefined {
  if (typeof o !== "object" || o === null || !Object.hasOwn(o, k)) return undefined;
  const x = (o as Record<string, unknown>)[k];
  return typeof x === "string" ? x : undefined;
}

/** The pins of `chain` in `venues` (also sell-unpinned.ts's): only the list's own keys, each read once. */
export function venuePins(venues: EvmPoolVenueList, chain: EvmPoolChain): { pool: string | undefined; v3: string | undefined; v4: string | undefined; sellDelegate: string | undefined } {
  if (typeof chain !== "string" || !Object.hasOwn(venues, chain)) return refuse("bad_route", "no such chain");
  const v = venues[chain];
  const adapters = typeof v === "object" && v !== null && Object.hasOwn(v, "adapters") ? v.adapters : undefined;
  return { pool: ownPin(v, "pool"), v3: ownPin(adapters, "v3"), v4: ownPin(adapters, "v4"), sellDelegate: ownPin(v, "sellDelegate") };
}
const samePin = (a: unknown, pin: string) => typeof a === "string" && lower(a) === lower(pin);

/** evmPoolBuildUnpinned through the chain's pinned adapter for the route's venue only (`quoted`: see checkRoute). */
export function pinnedBuild(venues: EvmPoolVenueList, chain: EvmPoolChain, adapter: string, route: EvmRoute, minOut: bigint, token: string, quoted = false): EvmPoolBuy {
  const v = venuePins(venues, chain);
  const r = copyRoute(route);
  const pin = r.venue === "uniswap-v3" ? v.v3 : v.v4;
  if (pin === undefined) return refuse("not_deployed", `${chain} has no pinned ${r.venue} adapter yet`);
  if (!samePin(adapter, pin)) return refuse("not_pinned", `the adapter is not ${chain}'s pinned ${r.venue} adapter`);
  return evmPoolBuildUnpinned(chain, adapter, r, minOut, token, quoted);
}

/** pinnedBuild of a route the device quoted itself (buy.ts evmPoolBuildQuoted, which takes only a device quote): a v4
 *  route may pass through a middle that is not listed (see checkRoute). */
export function pinnedBuildQuoted(venues: EvmPoolVenueList, chain: EvmPoolChain, adapter: string, route: EvmRoute, minOut: bigint, token: string): EvmPoolBuy {
  return pinnedBuild(venues, chain, adapter, route, minOut, token, true);
}

/** evmPoolSignBuyUnpinned into the chain's pinned pool only, of a buy through a pinned adapter. */
export function pinnedSignBuy(venues: EvmPoolVenueList, secretKey: Uint8Array, chain: EvmPoolChain, pool: string, built: EvmPoolBuy, proof: EvmPoolProofBinding): Uint8Array {
  const v = venuePins(venues, chain);
  if (v.pool === undefined) return refuse("not_deployed", `${chain} has no pinned pool yet`);
  if (!samePin(pool, v.pool)) return refuse("not_pinned", `the pool is not ${chain}'s pinned pool`);
  // a buy the builder did not return is left to the unpinned signer, which refuses it (not_built)
  if (BUILT.has(built) && !((v.v3 !== undefined && samePin(built.adapter, v.v3)) || (v.v4 !== undefined && samePin(built.adapter, v.v4)))) {
    return refuse("not_pinned", `the buy's adapter is not one of ${chain}'s pinned adapters`);
  }
  return evmPoolSignBuyUnpinned(secretKey, chain, pool, built, proof);
}
