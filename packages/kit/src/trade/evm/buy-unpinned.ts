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
   *  records (card evm-venues-pin; the mainnets' since card pool-evm-deploy-mainnet). */
  readonly pool?: string;
  readonly adapters?: Readonly<{ v3?: string; v4?: string }>;
  readonly sellDelegate?: string;
  /** The helper's EVM pool sender (apps/helper pool/evm.ts), which sends each sale to W: the sim of a sale runs from it
   *  (checks/evm/quote.ts simRule, card evm-quote-exec-sim), so a hook sees the sim as it sees the sale. A kit pin, never
   *  read from the helper; the helper refuses to start a sender whose key is not the pin (evmPoolSendersFromEnv). A
   *  chain with none sims no sale ("keep-min"): every chain pins its own (the mainnets' since card evm-mainnet-senders). */
  readonly sellSender?: string;
  /** The network's FeeCollector (contracts/pool-evm/src/FeeCollector.sol, card evm-fee-collector), which every Sell pays
   *  its fee to and whose Paid log proves the fee (card helper-sender-fee-proof); its one immutable, the sink, is the
   *  chain's sellSender. A kit pin, never read from the helper; the helper refuses to start with any other collector
   *  (evmPoolSendersFromEnv). A chain with none takes no sale: every chain pins its own (the mainnets' since card
   *  pool-evm-deploy-mainnet). */
  readonly feeCollector?: string;
  /** The quoters the device's own quote reads (checks/evm/quote.ts, card evm-pool-buy-quote): Uniswap's QuoterV2 for
   *  v3 and V4Quoter for v4; a chain with none refuses no_quoter. */
  readonly quoters?: Readonly<{ v3?: string; v4?: string }>;
  /** A route starts from the native asset whenever a native v4 pool exists and its route quotes at least as much as the
   *  WETH route (the chain's WETH is behind an upgradeable proxy). */
  readonly nativeFirst?: boolean;
  /** The RPC providers the device's quote reads, two at least, on different hosts of different operators, fastest first
   *  as measured: a quote asks two and the rest when one fails, is slow or differs (quote.ts agreeing, evmRanked); and
   *  how many blocks two heads may differ. */
  readonly providers?: readonly string[];
  /** The two providers every read at a past block goes to (card evm-quote-warm-round fold 8): the chain fee and the
   *  pool's tree depth at an epoch's first block, read by the device before it binds and by the helper when it prices a
   *  proof's epoch, up to a proof's life (the helper's POOL_LIFE_MAX_MS, 600 s) back. Each keeps state that far back,
   *  which live check evm-buy-hookdata-fee reads after every deploy; `providers` need not (a quote reads the latest
   *  block). */
  readonly feeProviders?: readonly [string, string];
  /** The pool's own list, where `providers` cannot page the pool's logs (card robinhood-mainnet-rpcs): the wallet's pool
   *  sync and pool reads take it as a pair with spares (the wallet's evmPair: the first two the seats, the rest spares),
   *  each of another operator, each seat paging the pool's eth_getLogs over the sync's page (packages/wallet/src/pool/
   *  evm.ts EVM_LOG_PAGE_BLOCKS) from the deploy block to the head. A quote ranks `providers` by eth_call speed, which no
   *  log read measures. Absent: `providers` is the pool's list too. */
  readonly poolProviders?: readonly string[];
  /** The two providers, each of another company, a ban's evidence reads the reverted trade's own trace on
   *  (debug_traceTransaction, prestateTracer and callTracer; card evm-sell-hook-intrablock): the state the trade saw at
   *  its start, after every earlier transaction of its block. Absent: the evidence replays at the parent block. */
  readonly traceProviders?: readonly [string, string];
  readonly maxLag?: number;
  /** The launchpads' hooked v4 pool shapes the device reads as reference pools (a route through any other hook has only
   *  the standard pools to be held to): the asset the pool pairs the token with, fee, tick spacing and hook. */
  readonly hookedPools?: readonly EvmHookedPool[];
  /** Uniswap v4's PoolManager (the V4Quoter's poolManager()), whose state the device reads for each pool it found, and
   *  the provider it scans for the PoolManager's Initialize logs: `span` blocks a request, `depth` blocks back, at most
   *  `parallel` requests at once; and the spares (`spares`, each of another operator), in order: the scan goes on at
   *  the next where one refuses, does not answer within its share of the quote's bound, or answers no logs
   *  (checks/evm/quote.ts scanPools; cards evm-scan-second-provider, evm-rpc-spare-list), each with its own span and
   *  requests at once over the same depth. */
  readonly poolManager?: string;
  readonly scan?: Readonly<{ url: string; span: number; depth: number; parallel: number; orSpan?: number; spares?: readonly EvmScanSpare[] }>;
};
export type EvmScanSpare = Readonly<{ url: string; span: number; parallel: number; orSpan?: number }>;
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
/** The list a venue's pool is synced and read on (card robinhood-mainnet-rpcs, review M-2): its `poolProviders`, or its
 *  `providers` when it has none. Every reader of a pool list takes it from here (the wallet's pool reads check, the
 *  card's live check), so none reads the quote list where the pool has its own. Own fields only: a list on the
 *  prototype is not the venue's. */
export function evmPoolProvidersOf(venue: EvmPoolVenue): readonly string[] | undefined {
  return Object.hasOwn(venue, "poolProviders") ? venue.poolProviders : Object.hasOwn(venue, "providers") ? venue.providers : undefined;
}
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
      // the helper's sell sender (POOL_EVM_SELL_KEY_BASE, made on the helper box by the research repo's
      // scripts/deploy/evm-sender-key.mjs, which printed only this address, 6 Nov; card evm-mainnet-senders): the sink of
      // the FeeCollector the owner's paste deploys (deploy.mjs sinkOf); the helper does not start with any other sell key
      sellSender: "0x2139756ab61ad861b4e25a009f092683e7454ee9",
      // The pins (card pool-evm-deploy-mainnet): the owner's paste's record, contracts/pool-evm/deployments/base.json
      // (2026-11-07T12:46:56.950Z, deploy tx of the pool 0x2e0cba4bfa2c24ae138ade564a027c5d83943340153dec0ad2e278c8c89b23c7); live check pool-evm-deploy-mainnet read each one's code the
      // build's, no owner and no EIP-1967 slot, on base-rpc.publicnode.com and mainnet.base.org (2026-11-07). test/evm-venues-pin.test.ts reads
      // the record and fails on any pin that differs. Both venues have an adapter here
      pool: "0xaa080e74ec99cf5c684548c77ca145edfcf899cf",
      adapters: bare({ v3: "0x1e62242773f696271b0cc3029b8672c385b7ce45", v4: "0x9d040a025689a10872f0f2f8b581135dde52ca6f" }),
      sellDelegate: "0xe3223113781f527188f634615ad9a3ca0aa20a4d",
      // the FeeCollector every Sell pays, its sink 0x2139756ab61ad861b4e25a009f092683e7454ee9 the sell sender pinned here
      feeCollector: "0xad33ac6fb59b0b06ca6bbf9d56d51990dc06a047",
      // Uniswap's QuoterV2 and V4Quoter (contracts/pool-evm/test/BuyFork.t.sol, BuyV4Fork.t.sol); eth_getCode on
      // mainnet.base.org and base-rpc.publicnode.com, the same code on both (2026-11-03 17:56Z): 8,273 bytes, keccak
      // 0xceb5b8bc…ee51e, and 5,820 bytes, keccak 0x9a5c0cdd…38bb3
      quoters: bare({ v3: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", v4: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D" }),
      // Keyless, of four operators, timed on one warm quote's six eth_call batches (109 kB) at each one's newest block
      // hash, 10 rounds each, every answer equal to publicnode's (card evm-quote-warm-round, 2026-11-04 16:4xZ from this
      // Mac): publicnode (Allnodes) p50/p95 146/207 ms; Blast 315/476, served by Alchemy (its answers carry
      // x-alchemy-trace-id, 18:56Z); mainnet.base.org (Coinbase) 863/1,380, behind QuickNode's request filter (eth_nope:
      // -32611 "rejected due to request filter settings", 18:56Z); BlockPI 816/1,549. All four sit behind Cloudflare
      // (server: cloudflare and cf-ray on every answer, 18:55Z). bloXroute's base.rpc.blxrbdn.com left the list (card
      // base-rpc-list-fix): its preflight answers 204 with access-control-allow-origin *, but its POST carries none (live
      // check evm-quote-warm-round, run 42114981904, 2026-11-05 21:42-21:50Z; its POST from the app's origin answered HTTP
      // 503 with none, 2026-11-06 00:44Z), so a browser quote that reaches it fails, as base-public.nodies.app's would
      // (its preflight names no allow-origin; review of bc189de, L-5); the live check evm-quote-warm-round preflights and
      // POSTs every listed provider. Passed over:
      // base.drpc.org and Tenderly's gateway (429 on 6 batches at once, again 18:56Z), meowrpc, zan, onfinality, 1rpc,
      // thirdweb, blockmachine (429 or a usage limit), tatum (eth_call paid only), blockvectra (outside its history window), llamarpc, omniatech, lava, nodeflare, ankr (no head);
      // third-party proxies of unknown operators are not listed.
      // What the list holds against a lie: a quote decides on two that agree, and a value any provider asked contradicts
      // is used only where more than half of these four gave it (review of bc189de, M-1). Left, as the device has always
      // had it on two providers: two that collude and agree, each answering more than the hedge (EVM_HEDGE_MS, 400 ms)
      // sooner than the honest provider they are asked beside, decide before its answer lands (re-review of fd9dd16,
      // Q10).
      // BlockPI left the list (card evm-spare-list-green): base.public.blockpi.network answered Cloudflare's 521 (its
      // origin down) to every read in the helper live runs from 17:36Z to 22:14Z on 6 Nov and to three eth_chainId at
      // 22:42Z, and a held Base quote ended rpc_error on it (live run 42263101671, 17:36Z). This list is also the wallet's
      // Base pool-sync list (packages/wallet/src/pool/evm.ts), so its place takes a provider that answers eth_call,
      // pages eth_getLogs over 5,000 blocks and more, and allows the app's origin: Pocket's base.api.pocket.network,
      // read 2026-11-06 23:30-23:32Z from this Mac: preflight 204 and POST with allow-origin the app's origin,
      // content-type allowed; a batch of 3 eth_call answered; the PoolManager's Initialize logs over 5,000, 10,000 and
      // 50,000 blocks at the head and 5,000 blocks 1M back answered (389 ms to 3.4 s); asked first beside publicnode,
      // 12 of 12 base-hook quotes ended ok, every read the two agreeing, its posts p50/p95 226/1,118 ms of 95 (its
      // answers differed on 10 of 60 on 4 Nov; none of 95 here). Every other keyless Base endpoint read then failed one
      // of the three: Sentio and thirdweb cap eth_getLogs at 1,000 blocks (Sentio as HTTP 429, a throttle to the pager),
      // Tenderly at 1,000, base.drpc.org refuses any range (code 35), nodies at 50, meowrpc 429s and has no eth_getLogs,
      // llamarpc 525, omniatech 521, lava 410, therpc 403.
      providers: Object.freeze(["https://base-rpc.publicnode.com", "https://base-mainnet.public.blastapi.io", "https://mainnet.base.org", "https://base.api.pocket.network"]),
      // all five then listed kept state 600 s back (a state read at the block 600 s old answered on each, card evm-quote-warm-round
      // fold 8, 2026-11-05 01:15Z from this Mac): Base's own and publicnode, the pair evm-buy-hookdata-fee recorded at
      // 600 s (fold 3, 2026-11-04 20:12Z)
      feeProviders: Object.freeze(["https://mainnet.base.org", "https://base-rpc.publicnode.com"] as const),
      // 10 s of Base's blocks: one every 200 ms since block 53556127 (2026-11-05 18:00:01Z, 2 s before; 10,000 blocks
      // to block 53603737 took 2,000 s on base-rpc.publicnode.com and base.gateway.tenderly.co, read 2026-11-05 20:38Z),
      // so 50 blocks (5 at 2 s blocks); live check base-200ms-blocks fails when Base's block time moves again
      maxLag: 50,
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
      // A span of 10,000 blocks (card evm-quote-warm-round, fold 4): at 50,000 a request took 4.5 to 5.4 s at the median
      // with 20 at once and some reached the 10 s timeout (3 of 26 and 2 of 24 in two cold quotes, each asked again as
      // halves), so a cold quote took 19.6 s from a home line and 79 to 99 s on GitHub's runner, one ending rpc_error;
      // at 10,000 the same cold quotes' 100 requests took 0.8 s at the median and 4.9 s at most, none timed out, and
      // the quotes 8.6 s and 7.6 s (2026-11-04 21:31-21:34Z). publicnode limits each address's getLogs work: about two
      // cold scans back to back, at either span, then 429 for most requests for under a minute (21:26-21:27Z).
      poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
      // The second: Tenderly's public gateway (base.gateway.tenderly.co; card evm-scan-second-provider, 2026-11-05
      // 18:08-18:09Z from this Mac). The browser's preflight from the app's origin answers 204, allow-origin *, and its
      // POST allow-origin *; its getLogs spans up to 1,000 blocks without a key ("Block range too large" at 2,500); a
      // range past its head answers -32602 "block range extends beyond current head block", never []. 3 at once (card
      // evm-rpc-spare-list, re-review of 156ece1 LOW-1): its header says x-tdly-limit 20, and the scan's own batches of
      // 1,000 blocks at the head (3 calls for kind `all`, 4 for `markets`), five rounds 1.2 s apart, 2026-11-05
      // 19:50-19:52Z from this Mac: 2 at once 0 of 10 and 2 of 10 answered 429 -32005, 3 at once 1 of 12 and 4 of 12,
      // 4 at once 4 of 12 (8 at once, 19:07-19:19Z: 3 to 6 of 8). A 429 waits 0.5 s and is asked again whole within the
      // first's EVM_SCAN_HOLD_MS share, so 3 carries a warm scan (scanPools `fast`), one round of 3,000 blocks, with at
      // most one wait; a cold one stays on the first.
      // The third: Pocket (base.api.pocket.network; card evm-rpc-spare-list, 2026-11-05 19:47-19:48Z from this Mac). Its
      // preflight answers 204, allow-origin the app's origin, content-type allowed, and its POST the same; some of its
      // backends refuse a getLogs over 500 blocks (-32602 "block range exceeds maximum 500", 2 of 6 at 1,000), so 500;
      // the scan's own batches of 500 blocks, 4 at once, seven rounds, all 28 answered with the head block in 205-1,223
      // ms; a one-call batch is answered as a bare object, which the kit's client reads as that call's answer
      // (evmJsonRpc). It carries what the first two left. bloXroute (base.rpc.blxrbdn.com), the second at 22e29c9, answered
      // every request 503 "No server is available to handle this request" at 18:07-18:09Z, so the live check's held
      // Base quotes ended rpc_error. Passed over: Blast (10 blocks a getLogs), dRPC ("ranges over 10000 blocks are not
      // supported on free plan" on 2,500-block spans, 18:08Z; "Batch of more than 3 requests are not allowed on free
      // plan" to the scan's 4-call batch, 2026-11-05 19:47Z), nodies (base-pokt.nodies.app: "Block range too large" at
      // 100 blocks, answered as a bare object, and its preflight names no allow-origin, 19:48Z), thirdweb (429 -32005
      // at once, 19:47Z), BlockPI ("Apikey not found", 18:08Z), mainnet.base.org
      // (-32011 "request limit reached" on its first getLogs, 18:08Z), 1rpc (50 blocks), meowrpc (no eth_getLogs), ankr
      // (a key), llamarpc (525, 18:08Z), omniatech (521), lava (410). No keyless one carries a cold 1M-block scan within
      // the bound alone: it carries what the first left, and a warm scan whole.
      // The fourth: Sentio (rpc.sentio.xyz/base; card base-rpc-list-fix, 2026-11-06 00:34-00:41Z from this Mac), so a
      // third that answers no logs still leaves another (evm-rpc-spare-list on GitHub's runner, run 42135737951: Pocket
      // answered a held quote's request with no logs in 570 ms, and it was the last). Its preflight answers 200 with
      // allow-origin the app's origin and content-type allowed, and its POST the same; getLogs up to 1,000 blocks
      // (HTTP 429 code 8 "public eth_getLogs is limited to 1000 blocks" past it), 1.5M blocks back; a range past its head
      // answers -32602 "block range extends beyond current head block", a block past it null; the scan's own 4-call
      // batch answered; at 3 at once, 164 of 164 batches of 1,000 blocks answered with the block in 15.3 s (p50 249 ms,
      // p95 395 ms, 10,715 blocks/s). Passed over at the same reads: BlockPI's base.public.blockpi.network (5,000
      // blocks, then 429 and a Cloudflare block after 24 batches at 4 at once, and a quote provider above, whose reads
      // its limit would cut), thirdweb (1,000 blocks, 4 of 1,000 answered at 3 at once, the rest 429), dRPC (-32602
      // "ranges over 10000 blocks are not supported on free plan" at 1,000), tatum (100 blocks, 5 requests a minute),
      // zan and onfinality (429), base.publicnode.com (the first's operator), Envio's HyperRPC (a token).
      scan: bare({
        url: "https://base-rpc.publicnode.com",
        span: 10_000,
        depth: 1_000_000,
        parallel: 20,
        spares: Object.freeze([
          bare({ url: "https://base.gateway.tenderly.co", span: 1_000, parallel: 3 }),
          bare({ url: "https://base.api.pocket.network", span: 500, parallel: 4 }),
          bare({ url: "https://rpc.sentio.xyz/base", span: 1_000, parallel: 3 }),
        ]),
      }),
    }),
    robinhood: bare({
      chainId: 4663,
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // aeWETH, an upgradeable proxy (contracts/pool-evm/NOTICE)
      middles: Object.freeze(["0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"]), // USDG
      // Uniswap v3 SwapRouter02 (test/SellFork.t.sol, BuyFork.t.sol); eth_getCode on rpc.mainnet.chain.robinhood.com
      // and robinhood.drpc.org: the same 24,498 bytes, codehash 0x6f36c378…b25dc (2026-11-03)
      routers: Object.freeze(["0xCaf681a66D020601342297493863E78C959E5cb2"]),
      // the helper's sell sender (POOL_EVM_SELL_KEY_ROBINHOOD, made as on Base, 6 Nov; card evm-mainnet-senders): the
      // FeeCollector's sink, as on Base
      sellSender: "0x92874bbc2638f644872d911d8b72d734978e24ae",
      // The pins (card pool-evm-deploy-mainnet): the owner's paste's record, contracts/pool-evm/deployments/robinhood.json
      // (2026-11-07T13:05:40.460Z, deploy tx of the pool 0xb5b5c6c0403e94daf9cf37e5b61f8d6dc9af41d929a3ecf732898e0d9fa88176); live check pool-evm-deploy-mainnet read each one's code the
      // build's, no owner and no EIP-1967 slot, on robinhood-rpc.publicnode.com and rpc.mainnet.chain.robinhood.com (2026-11-07). test/evm-venues-pin.test.ts reads
      // the record and fails on any pin that differs. Both venues have an adapter here (M365 2: the v3 adapter's ROUTER() is the router above)
      pool: "0x9306359433127c4f3be426f6faeb00a3c41f66db",
      adapters: bare({ v3: "0xb29746cb12c8466089b8355ec88cab31bd04c089", v4: "0x2e31a90e0df8aa634604abbe87cb61ca6aa8d702" }),
      sellDelegate: "0xf79962b094991354270fe7866f0f590ef0c9b0cf",
      // the FeeCollector every Sell pays, its sink 0x92874bbc2638f644872d911d8b72d734978e24ae the sell sender pinned here
      feeCollector: "0xdc41efe2174d6ba6db3f6f96672672bafc1b88e7",
      // Uniswap's QuoterV2 and V4Quoter (BuyFork.t.sol, BuyV4Fork.t.sol); eth_getCode on rpc.mainnet.chain.robinhood.com
      // and robinhood.drpc.org, the same code on both (2026-11-03 17:56Z): 8,273 bytes, keccak 0x3db0868d…96a28, and
      // 6,118 bytes, keccak 0xd707b1da…868f6
      quoters: bare({ v3: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7", v4: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94" }),
      nativeFirst: true,
      // Keyless, of five operators (Allnodes, dRPC, Robinhood, bloXroute, Globalstake), timed on the first five eth_call
      // batches of a USDG quote (1.31 MB) at each one's newest block hash, 10 rounds each, every answer equal to
      // Robinhood's (card evm-quote-warm-round, 2026-11-04 16:5xZ from this Mac): p50/p95 511/1,014 ms, 606/845,
      // 823/1,180, 766/2,801 and 2,349/4,972 ms. Passed over: daybreak (413 on a batch this size), blockvectra (outside
      // its history window), pocket and blockmachine (8 s and more, timeouts), thirdweb (refused requests), tatum,
      // nodeflare (no head)
      providers: Object.freeze(["https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org", "https://rpc.mainnet.chain.robinhood.com", "https://robinhood.rpc.blxrbdn.com", "https://rpc-robinhood.globalstake.io"]),
      // only these two of the five keep state 600 s back: Robinhood's own answers 630 s and refuses 660 s, dRPC 600 s
      // (card evm-buy-hookdata-fee, fold 3; 30 of 30 each at 600 s, 2026-11-04 20:12Z); publicnode, bloXroute and
      // Globalstake refused a state read at the block 600 s back, "historical state ... is not available" (card
      // evm-quote-warm-round fold 8, 2026-11-05 01:15Z from this Mac). dRPC first (card robinhood-mainnet-rpcs, review
      // M-3): a read one provider answers goes to the first, and the helper's pool sender reads and sends on the first of
      // POOL_EVM_RPCS_ROBINHOOD (the same order, apps/helper/deploy/compose.yaml), so they draw on dRPC's pace (15 a
      // second) and leave Robinhood's own (1 a second) to the pool sync, whose seat it is
      feeProviders: Object.freeze(["https://robinhood.drpc.org", "https://rpc.mainnet.chain.robinhood.com"] as const),
      // The pool's list (card robinhood-mainnet-rpcs): the quote list's first two cannot page the pool's logs.
      // Every keyless Robinhood mainnet RPC the chain's docs (docs.robinhood.com/chain/connecting: its own RPC; GlobalStake
      // and dRPC named) and the chainid.network and DefiLlama chainlist entries for 4663 name, read 2026-11-07
      // 01:42-01:50Z from this Mac on the pool's filter (an address, its three topics in one position) over 100, 1,000,
      // 10,000 and 100,000 blocks to the head and 10,000 and 100,000 blocks from 13M back:
      // - rpc.mainnet.chain.robinhood.com (Robinhood; nitro v3.12.3-rc.4, logs' blockTimestamp 0x0): all six, 270 ms;
      //   30 of 30 pages of 100,000 walking back 3M blocks, p50/p95 270/356 ms.
      // - robinhood.api.pocket.network (Pocket, on its own pocket.network; nitro v3.11.2, logs' blockTimestamp set, so
      //   not Robinhood's node): all four at the head, 13M back 10,000 and "-32602: eth_getLogs block range too large
      //   (max 10001 blocks)" at 100,000; its backends differ: 23 of 30 pages of 100,000 back 3M blocks (6 "max 10001", 1
      //   "exceeds maximum 50000", which the pager asks again, then halves), 20 of 20 of 10,000, p50 208-220 ms. The
      //   PoolManager's Swap logs over 100 blocks the same as Robinhood's own, digest for digest; CORS from the signing
      //   page's origin 204 and 200, allow-origin that origin; x-ratelimit-limit 1200 a minute.
      // Not taken: rpc-robinhood.globalstake.io (GlobalStake; nitro v3.12.1, blockTimestamp set: all four at the head
      // and 10,000 13M back, but 0.5-6.6 s and no answer in 15 s at 100,000 13M back and past the head, past the
      // device's 3.5 s client even as a spare), robinhood-rpc.publicnode.com (HTTP 403 "Archive requests require a personal token" from 1,000 blocks),
      // robinhood.drpc.org (code 35 at 1,000), robinhood.daybreak-rpc.network (2,000), rpc-robinhood.blockmachine.io
      // and robinhood-mainnet-rpc.blockreq.com (the newest 5,000 and 1,024 blocks keyless), api.blockvectra.com (100
      // blocks, its history window), the Tatum gateway (100, then 429), 4663.rpc.thirdweb.com (1,000, then 429),
      // rpc.degenprotocol.io (Pocket's very words "max 10001 blocks", and a finalized block above its head),
      // robinhood.rpc.blxrbdn.com and rpc.nodeflare.app (403), lb.routeme.sh (429), rpc.ordofi.network (no answer).
      poolProviders: Object.freeze(["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.api.pocket.network"]),
      // The trace pair (card evm-sell-hook-intrablock), read 2026-11-07 16:16-16:24Z from this Mac: of the five quote
      // providers only dRPC answers debug_traceTransaction (prestateTracer, diffMode and callTracer, 3, 100 and 600 blocks
      // back); publicnode, Robinhood's own and Globalstake answer -32601, bloXroute -32601 or 403. Of the keyless others,
      // Pocket (the pool list's) answers too, and rpc-robinhood.blockmachine.io (the newest 5,000 blocks keyless) and
      // rpc.degenprotocol.io (Pocket's own errors); daybreak, blockreq and thirdweb do not. dRPC's and Pocket's prestates
      // were equal as JSON for every one of the 7 transactions read.
      traceProviders: Object.freeze(["https://robinhood.drpc.org", "https://robinhood.api.pocket.network"] as const),
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
      // 10M blocks; robinhood.drpc.org: 10,000 blocks on its free plan). One request over the whole depth (card
      // rh-cold-quote): TORCH's Initialize logs over 10M blocks, both topic positions in one batch, 100 logs in 314 ms;
      // 15 seeded currencies' in one batch of 30 calls, 737 ms (2026-11-06 01:4xZ from this Mac); a request past 10,000
      // logs or its time is asked as its halves (scanPools)
      poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      // (it answers 429 to 4 at once, 2026-11-03 20:27Z); a request with more than one value in a topic position spans
      // at most 100,000 blocks ("query spans 1000000 blocks …, but only 100000 are allowed for this request; narrow the
      // block range, or send one value per position", 2026-11-04 06:55Z): `orSpan`
      // The second: daybreak (robinhood.daybreak-rpc.network; card evm-scan-second-provider, 2026-11-05 17:18-17:4xZ from
      // this Mac). Its preflight from the app's origin answers 204, access-control-allow-origin *; its getLogs span at
      // most 2,000 blocks (-32602 "query exceeds max block range 2000"), the scan's own batch (both topic positions and
      // the head block) p50 373-396 ms at 100 to 2,000 blocks, 100,000 back too, 4 at once all answered (p50 251-450 ms,
      // three rounds), an OR of topics too; the Initialize logs of 2,000 blocks 4,000 and 300,000 back the same as
      // Robinhood's own, log for log (14 and 6). The live check's quotes with the first held (refused, no logs) all ended
      // ok. It carries a warm scan whole: one round of its requests, 4 x 2,000 blocks, about 13.6 minutes of Robinhood's
      // blocks (scanPools `fast`); a cold one stays on the first.
      // The third: Pocket (robinhood.api.pocket.network; card evm-rpc-spare-list, 2026-11-05 19:48Z from this Mac). Its
      // preflight answers 204, allow-origin the app's origin, content-type allowed, and its POST the same; the scan's own
      // batches of 2,000 blocks at the head, 4 at once, five rounds, all 20 answered with the head block in 193-2,238
      // ms (5,000 blocks in about 210 ms, 2026-11-05). A one-call batch is answered as a bare object (the head read:
      // 2 of 2 refused held quotes ended rpc_error at evm-scan-second-provider), which the kit's client now reads as
      // that call's answer (evmJsonRpc). It carries what the first two left. Passed over: Globalstake (9.4 s and 10 s
      // timeouts on 70-block requests: 3 of 4 held quotes ended at the 60 s bound, 16:57-17:03Z),
      // rpc-robinhood.blockmachine.io (429 after six batches, "limit":60 compute units, retry after 25 s; -32002
      // "keyless requests are served for the most recent 5000 blocks", 2026-11-05 19:48Z), publicnode ("Archive requests
      // require a personal token" for the newest 100 blocks), dRPC (1,000-block spans refused on its free plan; 100
      // blocks answer, but no batch of more than 3, so never the scan's 4-call one), bloXroute
      // (no eth_getLogs).
      scan: bare({
        url: "https://rpc.mainnet.chain.robinhood.com",
        span: 10_000_000,
        depth: 10_000_000,
        parallel: 2,
        orSpan: 100_000,
        spares: Object.freeze([bare({ url: "https://robinhood.daybreak-rpc.network", span: 2_000, parallel: 4 }), bare({ url: "https://robinhood.api.pocket.network", span: 2_000, parallel: 4 })]),
      }),
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
      // the pool whose buy pays a failed swap's chunk to W instead of reverting (card pool-evm-buy-pays-revert:
      // scripts/live-checks/pool-evm-buy-pays-revert.base-sepolia.json, deploy tx
      // 0x47fa9d64f391118425e42cec266d7bee4d8c0117dda24e5e33219b0cc366424d, its verifier 0xa46aee47…0be3; its code the
      // build's on sepolia.base.org and base-sepolia-rpc.publicnode.com, 7 Nov 04:5xZ). The 3 Nov pool
      // 0xb239a38af69b68e6c5c305df64985f283b5d5fe5 keeps the build before it (pool-evm-deploy.build.json frozen). That
      // run's adapters and delegate are the same builds as the pins below, which stay
      pool: "0xeb967dfc1b4ffb22942f833c76866ea85fc42266",
      adapters: bare({ v3: "0xee89916bc4bdeee46dbcaf8fad2b7604724b5645", v4: "0x706b3f75e80be70494d1414b85788462bfeb7eb1" }),
      // the delegate at the pool-review-3 build: the 11-field Sell (0x0c2cb9ca) this kit signs, its fee paid to the
      // signed feeRecipient (card evm-testnet-delegate-review3: scripts/live-checks/evm-testnet-delegate-review3.
      // base-sepolia.json, deploy tx 0x326bc8a4f4200b0cdf230a8398ed7127c9d6137ed0bc1fd6deef391e3d178b71; its code the
      // build's on sepolia.base.org and base-sepolia-rpc.publicnode.com, 6 Nov 17:05Z; the exact-debit delegate before
      // it dispatched the 10-field sell)
      sellDelegate: "0x7a034461193cc6b1a7d5d0f5fe4a36b34e7ebc12",
      // the helper's sell sender (POOL_EVM_SELL_KEY_BASE_SEPOLIA, made on the helper box by
      // scripts/deploy/evm-sender-key.mjs, which printed only this address; 0.001 ETH read on sepolia.base.org and
      // base-sepolia-rpc.publicnode.com, 4 Nov 17:33Z); the helper does not start with any other sell key
      sellSender: "0xd378cda68babba6a9dc1d52335bb76ca9e6a7553",
      // the FeeCollector every Sell pays, its sink the sell sender above (card evm-fee-collector: scripts/live-checks/
      // evm-fee-collector.base-sepolia.json, deploy tx 0xdb1410a4cdcb78051e5b2ffbce2e25ed68800147d007b904f0385746d9019fe3,
      // its code the build's with that sink, read on two RPCs by that card's check and the review, 6 Nov)
      feeCollector: "0x9cc4788af51677aaa7770d78277c41fb864b35e1",
      // Uniswap v4's PoolManager (pool-evm-deploy.mjs CHAINS, its code hash pinned there), the target of a v4 sell
      poolManager: "0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408",
      // Uniswap's QuoterV2 and V4Quoter (developers.uniswap.org's Base Sepolia deployments); eth_getCode on
      // sepolia.base.org and base-sepolia-rpc.publicnode.com, the same on both (2026-11-04 09:55Z): 8,273 bytes, keccak
      // 0x156c129c…, factory() 0x4752ba5d…ad24; and 5,820 bytes, keccak 0x2dddcef8…, poolManager() the PoolManager above
      quoters: bare({ v3: "0xc5290058841028f1614f3a6f0f5816cad0df5e27", v4: "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba" }),
      // The pool's pair, which the wallet's pool sync pages the pool's logs on from its deploy block (evmPool,
      // evmTreeSync), and the quotes' (card notes-per-pool-evm-base-hang). The chain makes a block every 200 ms: blocks
      // 53,801,443 (the pool's deploy) to 55,089,154 in 257,542 s on sepolia.base.org, base-sepolia-rpc.publicnode.com
      // and base-testnet.api.pocket.network alike (2026-11-06 04:35Z). sepolia.base.org answers the pool's eth_getLogs
      // over 200 blocks "-32614: eth_getLogs is limited to a 200 range" (1,000 to 100,000 blocks, 04:35Z): the pager's
      // 156-block pages, 744 pages in 222 s, about 8,250 pages and 41 min for the pool's life, 2,770 more a day
      // (04:27-04:31Z). PublicNode answered the same filter over 1,000 to 50,000 blocks in 116-176 ms and refused
      // 100,000 ("-32701: exceed maximum block range: 50000"); Pocket answered 1,000 to 100,000 in 188-265 ms (04:35Z).
      // Both answer the signing page's CORS preflight (POST, content-type) from https://sign.confidential.unrealized.trade
      // with 204: PublicNode allow-origin *, Pocket that origin (04:42Z). sepolia.base.org stays in the fee pair, whose
      // reads are views and blocks, never a log page.
      providers: Object.freeze(["https://base-sepolia-rpc.publicnode.com", "https://base-testnet.api.pocket.network"] as const),
      feeProviders: Object.freeze(["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"] as const),
      // 20 s of its blocks: the two heads were 5 blocks apart in one read at 2 s blocks (2026-11-04 09:53Z), so 10 then;
      // one every 200 ms now (10,000 blocks to block 54946277 took 2,000 s on sepolia.base.org and
      // base-sepolia-rpc.publicnode.com, read 2026-11-05 20:38Z), so 100
      maxLag: 100,
    }),
    "robinhood-testnet": bare({
      chainId: 46630,
      weth: "0x7943e237c7f95da44e0301572d358911207852fa", // behind an upgradeable proxy (pool-evm-deploy.mjs CHAINS, M365)
      middles: Object.freeze([]),
      // no Uniswap v3 on Robinhood testnet (M365): no v3 adapter and no router; a sell goes through the PoolManager
      routers: Object.freeze([]),
      // the pool whose buy pays a failed swap's chunk to W (card pool-evm-buy-pays-revert: scripts/live-checks/
      // pool-evm-buy-pays-revert.robinhood-testnet.json, deploy tx
      // 0x83ab94117dc9659a95f08966be9f49e02dc313afb54e8fccf1fbd25fca82567b, its verifier 0xe9a698c1…d27b; its code the
      // build's on rpc.testnet.chain.robinhood.com and robinhood-sepolia-rpc.publicnode.com, 7 Nov 04:5xZ); the 3 Nov
      // pool 0xe5e948414a89c23e73d76cd740dacdd9364c25d5 keeps the build before it
      pool: "0xed9fac860e6bc5e932455232eedca8b71c44da4d",
      adapters: bare({ v4: "0x6c43a39fcb2ea65f47625ef5ce5fea98fc669797" }),
      // the delegate at the pool-review-3 build, selling through the v4 PoolManager alone here (card
      // evm-testnet-delegate-review3: scripts/live-checks/evm-testnet-delegate-review3.robinhood-testnet.json, deploy tx
      // 0xe15dad948f744299e9d76c42a82534ce8b6a04d844bb014ebd23cd1d90003e2b; its code the build's on
      // rpc.testnet.chain.robinhood.com and robinhood-sepolia-rpc.publicnode.com, 6 Nov 17:05Z)
      sellDelegate: "0xcec6c1b18be682cfa1679568eab309db79fe3cce",
      // the helper's sell sender (POOL_EVM_SELL_KEY_ROBINHOOD_TESTNET, made as on Base Sepolia; 0.001 ETH read on
      // rpc.testnet.chain.robinhood.com and robinhood-sepolia-rpc.publicnode.com, 4 Nov 17:33Z)
      sellSender: "0xd12d83097671d731df2db731e973ad9a07673607",
      // the FeeCollector every Sell pays, its sink the sell sender above (card evm-fee-collector: scripts/live-checks/
      // evm-fee-collector.robinhood-testnet.json, deploy tx 0x810cc53624006d64c210a2a8a546e039e53990105be4e69f804509afd36f5df7,
      // its code the build's with that sink, read on two RPCs by that card's check and the review, 6 Nov)
      feeCollector: "0xb174f0e859f00a7b593baca38394327e3d6bf638",
      poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      // Uniswap's V4Quoter at mainnet's address with mainnet's code (testnet-run.mjs NETS); eth_getCode on
      // rpc.testnet.chain.robinhood.com and robinhood-sepolia-rpc.publicnode.com, the same on both (2026-11-04 09:55Z):
      // 6,118 bytes, keccak 0xd707b1da…, poolManager() the PoolManager above. No v3 here (M365)
      quoters: bare({ v4: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" }),
      nativeFirst: true,
      // dRPC, not PublicNode, beside Robinhood's own (card evm-buy-hookdata-fee, review fold 2 MEDIUM-A): the relay fee
      // reads state at the epoch's first block, up to a proof's 10-min life old (the helper's POOL_LIFE_MAX_MS), and
      // robinhood-sepolia-rpc.publicnode.com keeps about 15 s ("historical state ... is not available" at 20 s, 6 of 6;
      // at 600 s, 6 of 6), where robinhood-testnet.drpc.org answered 6 of 6 at 20, 210, 600 and 700 s and 30 of 30 at
      // 600 s, and rpc.testnet.chain.robinhood.com 30 of 30 at 600 s (read 2026-11-04 20:09-20:13Z; live check
      // evm-buy-hookdata-fee holds every pinned provider to 600 s). Since card evm-quote-warm-round every read at a past
      // block goes to feeProviders, so the pool's pair (the wallet's pool sync and the quotes, at the newest block) is
      // Robinhood's own and PublicNode, the signing page's TESTNET_RPCS.robinhood and the money gate's (card
      // notes-per-pool-evm-base-hang): robinhood-testnet.drpc.org answers the pool's eth_getLogs over 101 blocks "RPC
      // error 35: ranges over 10000 blocks are not supported on free plan" (1,000 and 10,000 blocks; 100 and 101 answered,
      // 2026-11-06 05:02Z), so the pager's 78-block pages, about 23,700 for the pool's 1,849,721 blocks at 140 ms; Robinhood's
      // own answered 1,000 to 100,000 blocks in 183-205 ms and PublicNode 1,000 to 50,000 in 100-180 ms, refusing 100,000
      // "-32701: exceed maximum block range: 50000" (05:01Z). PublicNode answers the signing page's CORS preflight 204,
      // allow-origin * (05:03Z).
      providers: Object.freeze(["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"] as const),
      feeProviders: Object.freeze(["https://rpc.testnet.chain.robinhood.com", "https://robinhood-testnet.drpc.org"] as const),
      // the two heads were 18 blocks apart in one read (2026-11-04 09:53Z); mainnet's 100, about 16 s of its blocks (10,000
      // to block 149155719 took 1,634 s on both providers, read 2026-11-05 20:38Z)
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
      // a quoted buy's hook data is the device's own, and the device makes none, as a sell's (sell-unpinned.ts v4Data;
      // card evm-buy-hookdata-fee): a listed hook that read a referrer or a price from it would let whoever wrote it
      // steer what W signs
      if (quoted && h.hookData !== "0x") refuse("bad_route", "a quoted buy's hook data is the device's own: empty");
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
export function venuePins(venues: EvmPoolVenueList, chain: EvmPoolChain): { pool: string | undefined; v3: string | undefined; v4: string | undefined; sellDelegate: string | undefined; feeCollector: string | undefined } {
  if (typeof chain !== "string" || !Object.hasOwn(venues, chain)) return refuse("bad_route", "no such chain");
  const v = venues[chain];
  const adapters = typeof v === "object" && v !== null && Object.hasOwn(v, "adapters") ? v.adapters : undefined;
  return { pool: ownPin(v, "pool"), v3: ownPin(adapters, "v3"), v4: ownPin(adapters, "v4"), sellDelegate: ownPin(v, "sellDelegate"), feeCollector: ownPin(v, "feeCollector") };
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

/** A signed Buy as a sender reads it back from PrivacyPoolSimple.buy's calldata: the adapter, its data, minOut, token. */
export type EvmSignedBuy = { adapter: string; data: string; minOut: bigint; token: string };

/** The route a signed Buy's (adapter, data) encodes, when it is one the device's builder makes for that Buy; refused
 *  (throws EvmPoolBuyError) otherwise. The adapter must be the chain's pinned v3 or v4 adapter (not_pinned; a chain with
 *  neither, not_deployed), its data is decoded loosely into a route (v3: the packed path; v4: abi.encode(address
 *  currencyIn, PathKey[])), encoded again with the builder's own encoder as the device builds every buy (routeData,
 *  quoted: evmPoolBuildQuoted, the index's only builder) and held byte-equal to the data signed, and the token it buys
 *  must be the Buy's token (token_mismatch). So a sender carries a buy only through a pinned adapter, along a route the
 *  device's builder takes (card helper-evm-sender-2: the helper's sender pays the gas of every buy W signs; the adapter
 *  runs it, and a foreign adapter could run anything). */
export function evmBuyRouteOf(chain: EvmPoolChain, buy: EvmSignedBuy): EvmRoute {
  if (typeof buy !== "object" || buy === null) return refuse("bad_route", "a signed buy is an object");
  const { adapter, data, minOut, token } = buy;
  if (!isAddress(adapter) || !isAddress(token) || lower(token) === NATIVE) return refuse("bad_route", "the adapter or the token is not an address");
  if (typeof minOut !== "bigint" || minOut <= 0n || minOut >= 1n << 256n) return refuse("bad_amount", "minOut is a uint256 above 0");
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length > 2 + 2 * 4096) return refuse("bad_route", "the data is not 0x hex, or too long");
  const pins = venuePins(evmPoolVenues(), chain);
  if (pins.v3 === undefined && pins.v4 === undefined) return refuse("not_deployed", `${chain} has no pinned adapter yet`);
  const d = hexBytes(data.toLowerCase());
  const at = (i: number): bigint => {
    if (i < 0 || i + 32 > d.length) return refuse("bad_route", "the data is too short");
    let v = 0n;
    for (let k = i; k < i + 32; k++) v = (v << 8n) | BigInt(d[k]!);
    return v;
  };
  const small = (v: bigint, below: number, what: string): number => (v < BigInt(below) ? Number(v) : refuse("bad_route", `${what} is out of range`));
  const asAddress = (v: bigint): string => (v >> 160n === 0n ? `0x${v.toString(16).padStart(40, "0")}` : refuse("bad_route", "an address word's high bytes"));
  let route: EvmRoute;
  if (pins.v3 !== undefined && samePin(adapter, pins.v3)) {
    // the packed path: token (20), then fee (3) and token (20) per hop
    if (d.length < 43 || (d.length - 20) % 23 !== 0) return refuse("bad_route", "a v3 path is a token, then a fee and a token per hop");
    const tokens = [toHex(d.slice(0, 20))];
    const fees: number[] = [];
    for (let o = 20; o < d.length; o += 23) {
      fees.push((d[o]! << 16) | (d[o + 1]! << 8) | d[o + 2]!);
      tokens.push(toHex(d.slice(o + 3, o + 23)));
    }
    route = { venue: "uniswap-v3", tokens, fees };
  } else if (pins.v4 !== undefined && samePin(adapter, pins.v4)) {
    // abi.encode(address currencyIn, PathKey[]): currencyIn, the array's offset, then its length, one offset per
    // element (from the first offset's word), and each element
    const currencyIn = asAddress(at(0));
    const base = 32 + small(at(32), 0x10000, "the path's offset");
    const n = small(at(base - 32), EVM_POOL_MAX_HOPS + 1, "the path's length");
    const hops: EvmV4Hop[] = [];
    for (let i = 0; i < n; i++) {
      const e = base + small(at(base + 32 * i), 0x10000, "a hop's offset");
      const hd = e + small(at(e + 128), 0x10000, "a hop's hook data offset");
      const len = small(at(hd), EVM_POOL_MAX_HOOK_DATA + 1, "a hop's hook data length");
      if (hd + 32 + len > d.length) return refuse("bad_route", "a hop's hook data runs past the data");
      hops.push({ currency: asAddress(at(e)), fee: small(at(e + 32), U24 + 1, "a fee"), tickSpacing: small(at(e + 64), MAX_TICK_SPACING + 1, "a tick spacing"), hooks: asAddress(at(e + 96)), hookData: toHex(d.slice(hd + 32, hd + 32 + len)) });
    }
    route = { venue: "uniswap-v4", currencyIn, hops };
  } else return refuse("not_pinned", `the adapter is not one of ${chain}'s pinned adapters`);
  // the builder's own encoding of that route, as the device builds it: any other byte (an offset, a padding, a trailing
  // byte, hook data) is refused here
  const again = routeData(chain, route, true);
  if (toHex(again.data) !== lower(data)) return refuse("bad_route", "the data is not the builder's encoding of its route");
  if (lower(again.token) !== lower(token)) return refuse("token_mismatch", `the route buys ${again.token}, not ${token}`);
  return route;
}
