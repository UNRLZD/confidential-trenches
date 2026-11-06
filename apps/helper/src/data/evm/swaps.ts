// The EVM token page's candles and trade tape from the helper's own chain reads (card index-evm-swaps; markets paper 06b
// §6.1 `Candles` and `Trades`, 06c §4.12; card index-evm-swaps-2 adds Robinhood): GET /v1/market/candles and
// /v1/market/trades with chain=base or chain=robinhood. No vendor key and no
// vendor limit: the swaps are read from the chain, priced by ../candles.ts (the one pricing rule is in its header) and
// served from memory.
//
// The main pool. A listed token is priced from the pool of a supported venue that carried most of its swaps in the last
// cold window's blocks (VENUES[chain].cold), found on chain and kept (POOL_KEEP_MS): the token's Transfer logs over those blocks (two
// providers that agree) name the addresses that held and moved it; each is checked on chain, never taken on a vendor's
// word. A v2, v3 or Slipstream pool counts when its factory() is one of the venues below and its token0() and token1()
// are the token and the chain's dollar (USDC, USDG) or WETH; a Pons v2 curve counts when the Pons factory's own record of
// the token names it (Robinhood); a v4 pool counts when its key hashes to the pool id (keccak256 of the key, the id the
// PoolManager logs) and pairs the token with USDC, WETH or ETH: the key is the PositionManager's poolKeys() when it knows
// the pool, and for a pool it never made (Doppler) v4Key works the key out from the swap's fee and the addresses in its
// transaction, trusted only when the hash equals the id. A token with
// no such pool (Zora's creator-coin pairs, a cbBTC or VIRTUAL pair, a Pons curve quoted in a stock token, a venue not listed
// here) answers an empty chart and tape from our own reads (200, src "chain"), never a guess; 404 is only for a token off
// the lists or a malformed request. A read that fails is never kept as "no pool": it answers 503 and is read again.
//
// Venues on Base, each address read from the chain on 2026-11-03 17:0xZ (a pool's factory() on base-rpc.publicnode.com,
// and a PoolCreated or Initialize log of the factory decoded against the pool's token0() and token1()):
//   - Uniswap v4: the PoolManager 0x498581ff... and its PositionManager 0x7c5f5a4b... (poolKeys read for the SHIB/ETH and the
//     ETH/USDC pools, both ids recomputed from the key; the PoolManager address in contracts/pool-evm/test/BuyV4Fork.t.sol, Uniswap's
//     sdk-core); every launchpad whose pool is a v4 pool (Zora, Clanker, Flaunch, Doppler) swaps there. `Swap` amounts
//     are the swapper's (checked against the Transfer logs of three swaps of the SHIB/ETH pool: amount0 negative = the
//     swapper paid ETH, amount1 positive = received SHIB).
//   - Uniswap v3: factory 0x33128a8f... (the factory() of the ICNT/USDC pool 0x9331f571...). `Swap` amounts are the pool's.
//   - Aerodrome Slipstream: CLFactory 0x5e7bb104... (VELVET/USDC), 0x9cb22058... (SNDKc/USDC) and 0xf8f2eb49... (Paper/USDC);
//     the same `Swap` as Uniswap v3.
//   - Aerodrome v2: PoolFactory 0x420dd381... (VVV/WETH); `Swap` has amounts in and out.
// The kit pins none of Aerodrome, Slipstream or the v4 PoolManager on Base mainnet (packages/kit/src/trade/evm/
// buy-unpinned.ts holds WETH, USDC and the v3 router); these are the helper's own, for display, never a signature.
//
// The read. Every tick the helper asks two providers (SWAP_RPCS, the third only when one lags or fails) for their newest
// block, takes the newest block both have (the agreed block), and reads `eth_getLogs` for each open token's pool from
// the first block it has not settled up to the agreed block on both; a token's logs count only when the two answers are
// identical. The last REWIND_BLOCKS blocks are read again every tick and replace what the book held for them (a reorg
// or a late log changes them, ../candles.ts ingest), so a block is settled only REWIND_BLOCKS behind the agreed one.
// A provider that lags (more than VENUES[chain].lagMax blocks behind the other) is passed over for the third; one that refuses (429,
// -32005, a limit message) is held for the wait it names (the helper's RPC rules, ../../rpc/rpc.ts); an answer over
// ANSWER_MAX bytes or not JSON is a failure. A tick that cannot agree changes nothing; the book keeps serving what it
// holds, dated by its last read, and a read asked of a book STALE_MS old starts one (card helper-live-bars-no-503).
//
// Block times: a swap is timed by its log's `blockTimestamp`, part of what two providers must answer alike, never 0 and
// never before an earlier swap's, on every chain. No clock is assumed: Base's block time went from 2 s to 200 ms at block
// 53556127 (2026-11-05 18:00:01Z, lists.ts BLOCK_CLOCK), and a read that checked each head against the 2 s clock
// answered 503 for every Base token from then (card helper-ready-page-warm); Robinhood puts 10 or more blocks in one
// second. Base's providers fill `blockTimestamp` (base-rpc.publicnode.com, base.gateway.tenderly.co and base.drpc.org
// on all 124 v4 swaps of 100 blocks, read 2026-11-05 19:0xZ).
//
// Display only: nothing here feeds a signature. Every provider value is hostile input: a log counts only when its
// emitter, topic0, topic count and data length match the venue exactly; an amount must fit its type and its legs have
// opposite signs; counts, ranges and the books are bounded.
import { AsyncLocalStorage } from "node:async_hooks";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createBook, TFS, type Book, type Candle, type Event, type Ref, type Swap, type Tf } from "../candles.ts";
import { GT_SERVE_MS, refreshLane, throttledUntil, type GeckoBudget } from "../gecko.ts";
import { CALLER_ROOM, evmThrottleS, LOGS_REFUSED, providerHolds, RETRY_AFTER_MAX_S, upstreamRetryAfterS, type ProviderHolds } from "../../limits/limits.ts";
import { toCandles, TF as GT_TF, type DataAnswer } from "../solana/token.ts";
import { BATCH_MAX, evmAddress, GT_BASE, type EvmChain } from "./lists.ts";
import { createSwapIndex, toEntryPoint, traderAt, txTraders, type SwapIndex, type Traders } from "./index.ts";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------------------------------------------
// Venues
// ---------------------------------------------------------------------------------------------------------------

const topic = (sig: string): string => `0x${Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex")}`;
export const TOPIC = {
  swap4: topic("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  swap3: topic("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  swap2: topic("Swap(address,address,uint256,uint256,uint256,uint256)"),
  curveBuy: topic("CurveBuy(address,address,uint256,uint256,uint256,uint256)"),
  curveSell: topic("CurveSell(address,address,uint256,uint256,uint256,uint256)"),
  transfer: topic("Transfer(address,address,uint256)"),
  // the PoolManager's other calls on a pool, whose settling transfers are no swap's (hookTakes; card
  // helper-v4-hook-liquidity: a launch's hook paid its 1e9 tokens of liquidity in next to the first buy)
  initialize: topic("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"),
  modifyLiquidity: topic("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"),
  donate: topic("Donate(bytes32,address,uint256,uint256)"),
  // the PoolManager's ERC-6909 claims (its own Transfer: caller, indexed from, to and id, amount): a hook may take its
  // cut as claims minted to a fee recipient, not as the token (card helper-v4-hook-liquidity: hook 0x5e320ea6 on Base)
  claims: topic("Transfer(address,address,address,uint256,uint256)"),
} as const;
/** The PoolManager's events of a pool that are not a swap: a hook's transfer next to one settles it (hookTakes). */
const POOL_CALLS = [TOPIC.initialize, TOPIC.modifyLiquidity, TOPIC.donate];

export const BASE_VENUES = {
  poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
  positionManager: "0x7c5f5a4bbd8fd63184577525326123b519429bdc",
  uniswapV3: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
  slipstream: ["0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a", "0x9cb220581b91b0c83223012fe69688b92ad07a76", "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef"],
  aerodromeV2: "0x420dd381b31aef6683db6b902084cb0ffece40da",
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  weth: "0x4200000000000000000000000000000000000006",
} as const;
const ZERO = "0x0000000000000000000000000000000000000000";
/** Selectors: token0(), token1(), factory(), decimals(), the PositionManager's poolKeys(bytes25), and the Pons v2
 *  factory's getLaunchedToken(address). */
const SEL = { token0: "0x0dfe1681", token1: "0xd21220a7", factory: "0xc45a0155", decimals: "0x313ce567", poolKeys: "0x86b6be7d", launched: "0x3cf28b5a" } as const;
/** A pool's getPool parameter (Venues.getPool), and each factory kind's getPool(address,address,<it>) (keccak-256 of the
 *  signatures, checked in swaps-confirm.test.ts). */
const PARAM_SEL = { fee: "0xddca3f43", tickSpacing: "0xd0c93a7c", stable: "0x22be3de1" } as const;
const GET_POOL_SEL = { fee: "0x1698ee82", tickSpacing: "0x28af8d0b", stable: "0x79bc57d5" } as const;
/** The ETH price: Uniswap v4's native ETH / USDC 0.05% pool (tick spacing 10, no hook), the one BuyV4Fork.t.sol buys through.
 *  Its id is keccak256(abi.encode(currency0 0x0, currency1 USDC, fee 500, tickSpacing 10, hooks 0x0)); 7 swaps in 100
 *  blocks read 2026-11-03 17:08Z, the last at 2,295.6 USD per ETH. */
export const REF_POOL_ID = "0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a";

/**
 * Robinhood Chain (chain id 4663: eth_chainId 0x1237 on its three public providers, 2026-11-03 19:1xZ). Uniswap's own
 * addresses (@uniswap/sdk-core 7.20.0 dist/cjs/src/addresses.js ROBINHOOD_ADDRESSES): v3CoreFactoryAddress 0x1f7d7550...,
 * v4PoolManagerAddress 0x8366a39c... (also contracts/pool-evm/test/BuyV4Fork.t.sol), v4PositionManagerAddress
 * 0x58daec31.... WETH and USDG are the kit's (packages/kit/src/trade/evm/buy-unpinned.ts). The ETH price is v4's native
 * ETH / USDG 0.05% pool (tick spacing 10, no hook; BuyV4Fork.t.sol's Robinhood hop): 166 swaps in 9,000 blocks read
 * 2026-11-03 19:2xZ, the longest gap 386 blocks.
 *
 * The Pons v2 curve: PonsV2LaunchFactory 0x7ed598bc... (Sourcify chain 4663, exact match, contracts/src/v2/
 * PonsV2LaunchFactory.sol) makes each token's own PonsV2BondingCurve (its source is in the same Sourcify compilation,
 * contracts/src/v2/PonsV2BondingCurve.sol) and records it: getLaunchedToken(token) answers the LaunchedToken struct
 * (15 static words: token, curve, deployer, creatorFeeRecipient, pairToken, ..., exists last); pairToken zero is native
 * ETH. A curve trade logs CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut,
 * uint256 fee, uint256 tax), quoteIn the quote the buyer spent with the fees in it, or CurveSell(address indexed seller,
 * address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax), quoteOut what the seller
 * got after them; both topics are the ones the chain's curves log (75 and 69 of 175 curve logs over 5,000 blocks,
 * 2026-11-03 19:2xZ). A graduated token trades on its v4 pool, found as any v4 pool is.
 */
export const ROBINHOOD_VENUES = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  uniswapV3: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  ponsV2: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
  // a Slipstream-kind CL factory (card helper-robinhood-capacity fold 7): its bytecode holds getPool(address,address,int24)
  // 0x28af8d0b and createPool(address,address,int24,uint160) 0x232aa5ac, not Uniswap's getPool(...,uint24); read
  // 2026-11-05 04:2xZ on rpc-robinhood.blockmachine.io: getPool(0x39dbed3a..., USDG, 50) = 0xf2a0be59..., the pool
  // Discover lists for 0x39dbed3a (tickSpacing() 50, fee() 1400), which logs Uniswap v3's Swap (43 in 4,000 blocks)
  cl: "0xe0c4ceb92d08ca985bb70fe0a22feb121a9854a8",
} as const;
export const ROBINHOOD_REF_POOL_ID = "0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982";

/** A chain's venues and read sizes. `usd` is the chain's dollar stablecoin (6 decimals on both). */
export type Venues = {
  poolManager: string;
  positionManager: string;
  v3: readonly string[];
  v2: readonly string[];
  /** What each v2 and v3 factory's getPool takes beside the two tokens, read from the pool: Uniswap v3's uint24 fee(),
   *  a Slipstream-kind CL factory's int24 tickSpacing(), Aerodrome v2's bool stable(). A pool is read only once its
   *  factory names it by that call (confirmed), never by the factory() it claims alone: any contract can claim one. */
  getPool: Readonly<Record<string, "fee" | "tickSpacing" | "stable">>;
  usd: string;
  weth: string;
  refPoolId: string;
  pons: readonly string[];
  /** The most blocks one `eth_getLogs` asks (the smallest the chain's providers take). */
  span: number;
  /** The blocks a token's first read and its discovery may go back (about five minutes of the chain's blocks). */
  cold: number;
  /** The blocks one round of that walk reads, newest first: an active token's swaps are found in the first. */
  step: number;
  /** The blocks the ETH price is read before the earliest block a book reads, so its first swap has a price before it. */
  refBack: number;
  /** A provider this many blocks behind the other is passed over for the third. */
  lagMax: number;
};
export const VENUES: Readonly<Record<EvmChain, Venues>> = {
  base: {
    poolManager: BASE_VENUES.poolManager,
    positionManager: BASE_VENUES.positionManager,
    v3: [BASE_VENUES.uniswapV3, ...BASE_VENUES.slipstream],
    v2: [BASE_VENUES.aerodromeV2],
    // read 2026-11-05 04:5xZ on mainnet.base.org: getPool(token0, token1, fee() 500) of 0x33128a8f names the ICNT/USDC
    // pool 0x9331f571; getPool(.., stable() false) of 0x420dd381 names VVV/WETH 0x01784ef3; each Slipstream factory's
    // getPool(WETH, USDC, tickSpacing) names a pool whose tickSpacing() and tokens give it back (0xb2cc224c, 0x2a430beb,
    // 0x4e392fbf)
    getPool: { [BASE_VENUES.uniswapV3]: "fee", [BASE_VENUES.aerodromeV2]: "stable", ...Object.fromEntries(BASE_VENUES.slipstream.map((f) => [f, "tickSpacing" as const])) },
    usd: BASE_VENUES.usdc,
    weth: BASE_VENUES.weth,
    refPoolId: REF_POOL_ID,
    pons: [],
    span: 1_000,
    // one block every 200 ms from block 53556127 (lists.ts BLOCK_CLOCK). The window is Robinhood's five minutes, one
    // step, 1,500 blocks, two calls a filter (at 2 s it was 20 minutes, 600 blocks, one call; at 200 ms 20 minutes is
    // 6,000 blocks, and a quiet token's walk of it on the three providers left took their bursts' 429s, no
    // pair, 503, read live 2026-11-05 19:2xZ); a token quiet longer has GeckoTerminal's bars of its top pool, as on
    // Robinhood. The ETH price is read 1,000 blocks (200 s) before a book's first, its pool's longest gap 374 blocks (88 swaps in
    // 5,000 blocks read 2026-11-05 19:1xZ on base-rpc.publicnode.com); a provider 50 blocks (10 s) behind is passed
    // over (four heads read at once five times, 2026-11-05 19:1xZ, were at most 2 blocks apart)
    cold: 1_500,
    step: 1_500,
    refBack: 1_000,
    lagMax: 50,
  },
  // Robinhood makes about 10 blocks a second (10,000 blocks over 1,024 s, 2026-11-03 19:1xZ): a step of 3,000 blocks is
  // its last five minutes (600, one minute, found no pool for a v4 token with 213 swaps in the 2,000 blocks before, read
  // live 2026-11-03 19:5xZ), and a quiet token's window is that one step (below), the bars before our first coming
  // from GeckoTerminal's OHLCV as on Base; 100 blocks is the widest `eth_getLogs` its keyless providers all take
  // (api.blockvectra.com "block range exceeds 100 blocks", robinhood.drpc.org refuses 500), so a step is 30 spans,
  // batched; the ETH price pool's longest gap read was 386 blocks, so it is read 1,000 blocks before a book's first
  robinhood: {
    poolManager: ROBINHOOD_VENUES.poolManager,
    positionManager: ROBINHOOD_VENUES.positionManager,
    v3: [ROBINHOOD_VENUES.uniswapV3, ROBINHOOD_VENUES.cl],
    v2: [],
    // read 2026-11-05 04:5xZ on rpc-robinhood.blockmachine.io: getPool(token0, token1, fee() 3000) of 0x1f7d7550 names
    // 0x020bfc65's pool 0xd42a4910; the CL factory's getPool(.., tickSpacing() 50) names 0x39dbed3a's 0xf2a0be59
    getPool: { [ROBINHOOD_VENUES.uniswapV3]: "fee", [ROBINHOOD_VENUES.cl]: "tickSpacing" },
    usd: ROBINHOOD_VENUES.usdg,
    weth: ROBINHOOD_VENUES.weth,
    refPoolId: ROBINHOOD_REF_POOL_ID,
    pons: [ROBINHOOD_VENUES.ponsV2],
    span: 100,
    // one step, not 20 minutes (card helper-robinhood-swaps): 20 minutes of 102 ms blocks is 118 spans of 100 blocks a
    // filter a provider, and under it every keyless provider answered 429, -32005, code 30 or a timeout and the swaps
    // routes 503 (2026-11-04 14:36-15:16Z reads, a soak at 15:13Z still 503 after 195 s); a token quiet longer than the
    // step's five minutes has GeckoTerminal's bars of its top pool, as a token with no pool found
    cold: 3_000,
    step: 3_000,
    refBack: 1_000,
    lagMax: 50,
  },
};

/** Base's providers for the swap read, public and keyless, measured 2026-11-03 17:02Z: `eth_getLogs` for one pool over 1,000
 *  blocks answered by base-rpc.publicnode.com (457 ms) and base.gateway.tenderly.co (582 ms); base.drpc.org up to 10,000
 *  blocks but batches of 3; mainnet.base.org "request limit reached"; base-mainnet.public.blastapi.io at most 10 blocks;
 *  1rpc.io 50 blocks. */
//
// Read again 2026-11-05 19:0x-19:2xZ from the Mac (card helper-ready-page-warm), after Base went to 200 ms blocks: one
// 1,000-block `eth_getLogs` answered by base-rpc.publicnode.com (130-300 ms; 429 past about 6 a second),
// base.gateway.tenderly.co (350-600 ms, 2.5 a second sequential none refused) and base.public.blockpi.network's public
// endpoint (380-1,200 ms, 3.6 a second none refused; out from about 16:00Z 6 Nov, HTTP 521 on every chain, still at
// 18:44Z, so it left the list, card helper-evm-range-cap-walk), each log with its blockTimestamp; base.drpc.org now refuses 250
// blocks and more (code 35 "ranges over 10000 blocks are not supported on free plan") and 429s bursts; base-pokt.nodies.app
// takes 50 blocks at most (-32001) and 429s bursts; 1rpc.io, base.meowrpc.com, base.llamarpc.com, base.lava.build,
// base.api.onfinality.io, api.zan.top, endpoints.omniatech.io and base.blockpi.network (no key) refused or failed every read.
export const SWAP_RPCS: Readonly<Record<EvmChain, readonly string[]>> = {
  // base.drpc.org is left out: it answers none of the reads' ranges (250 blocks and more) and 429s about one a second.
  // mainnet.base.org, Base's own, answers the heads, calls and the traders' lookups (20 eth_getTransactionByHash a
  // second none refused, 19:3xZ) and is sent no log read (limits.ts LOGS_REFUSED): with the three above alone a cold
  // tape's 50 lookups waited on their paces and its traders answered null (index-evm-swaps on a local build, 19:30Z).
  // base.api.pocket.network took blockpi's place (card helper-evm-range-cap-walk, 6 Nov 18:48-18:50Z from the Mac): one
  // pool's 1,000-block eth_getLogs in 0.9-1.0 s, each log with its blockTimestamp; single reads at 2, 3, 4, 6 and 10 a
  // second for 6 s and batches of 3, 4, 6 and 10 a second none throttled; 4 of 150 reads and 5 of 24 batches met one of its
  // backends' -32602 "block range exceeds maximum 500", a read it does not answer (null), which the next provider takes
  base: ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co", "https://base.api.pocket.network", "https://base-pokt.nodies.app", "https://mainnet.base.org"],
  // Robinhood, 2026-11-03 19:2xZ, `eth_getLogs` of the v4 PoolManager: robinhood.daybreak-rpc.network up to 2,000 blocks
  // (batches of 10), robinhood.drpc.org up to 101 blocks (batches of 3), api.blockvectra.com up to 100 blocks (no
  // batches); each of the three fills a log's `blockTimestamp`. rpc.mainnet.chain.robinhood.com answers 5,000 blocks but
  // logs `blockTimestamp` 0x0 and refused a fourth quick read with 429; robinhood-rpc.publicnode.com refused every
  // `eth_getLogs` ("Archive requests require a personal token"); blockreq.com's public endpoint took 21 s.
  //
  // Read again 2026-11-04 14:36-14:58Z (card helper-chart-fresh), when the helper's Robinhood candles and tape answered
  // 503: robinhood.daybreak-rpc.network took 0.8-15 s for one 100-block `eth_getLogs` (5 of 8 past the 10 s a read
  // was given) and 1-15 s for eth_blockNumber; api.blockvectra.com refuses any block older than about 850 (-32011
  // "block reference is outside the public history window", reason state_window, retryable false) and 429s bursts, so
  // it serves no discovery and no first read; robinhood.drpc.org answered 100-block reads in 0.5-0.8 s (one run of
  // -32601 "method not available" at 14:36:28Z). With two providers needed alike, one slow provider left no pair:
  // 503. rpc.mainnet.chain.robinhood.com, the chain's own, answered 100-block reads 11,000 blocks back in 0.4-1.3 s
  // and a batch of 10 in 2.0 s, its logs' `blockTimestamp` still 0x0 and its block headers' `timestamp` set: it is
  // header-timed (HEADER_TIMED).
  //
  // Read again 2026-11-04 19:37-19:42Z (card helper-robinhood-capacity), every Robinhood mainnet RPC chainid.network and
  // chainlist.org list, from the helper box and from the Mac: two more keyless operators answer `eth_getLogs` 3,000
  // blocks back with each log's blockTimestamp and batches of 10: robinhood.api.pocket.network (served 11 calls a second
  // for 8 s, none refused) and rpc-robinhood.blockmachine.io (10 a second, then -32029; keyless reads only of about the
  // newest 10,000 blocks; its 429 at 20:12Z named x-ratelimit-limit 60, unit cu_per_minute, Retry-After 3). Sustained from the Mac, 4 at once for 8 s: drpc 33 calls a second none refused, daybreak 29
  // then -32005 "too many concurrent requests", the chain's own 3.8 then 429. Not added: robinhood-rpc.publicnode.com
  // (-32602 archive), blockreq.com (only the newest blocks), rpc.ordofi.network (no answer), robinhood.rpc.blxrbdn.com
  // and rpc.nodeflare.app (403), lb.routeme.sh and 4663.rpc.thirdweb.com (429 at once), the Tatum gateway (5 a minute),
  // rpc.degenprotocol.io (502s; logs blockTimestamp 0x0) and rpc-robinhood.globalstake.io (10 s timeouts). Asked in
  // order of expected answer time (ranked: each one's in-flight queue and pace, the wide providers (WIDE_SPAN) first among
  // equals), so the chain's own RPC, whose logs cost a second post for their headers and whose pace /v1/rpc/robinhood's
  // callers share, is asked whenever its bucket has room for that.
  robinhood: ["https://robinhood.daybreak-rpc.network", "https://rpc-robinhood.blockmachine.io", "https://robinhood.api.pocket.network", "https://robinhood.drpc.org", "https://api.blockvectra.com/v1/robinhood_mainnet/public", "https://rpc.mainnet.chain.robinhood.com"],
};

/** The providers that answer a chain-wide `eth_getLogs` (by topic, no address) with each log's block time, for the
 *  chain's swap index (index.ts; read 2026-11-05 01:53Z: pocket and blockvectra refuse a filter with no address, the
 *  chain's own logs carry no time). drpc's free plan takes 100 blocks a call. */
export const INDEX_RPCS: Readonly<Partial<Record<EvmChain, readonly string[]>>> = {
  robinhood: ["https://robinhood.daybreak-rpc.network", "https://rpc-robinhood.blockmachine.io", "https://robinhood.drpc.org"],
};
/** The most blocks one chain-wide `eth_getLogs` joins (logsOf): 500 of Robinhood's are about 1,500 logs, 1.4 MB, half
 *  of ANSWER_MAX with room for a busier minute (1,000 were 3,062 logs, 2.8 MB, 2026-11-05 01:53Z). */
const INDEX_JOIN_MAX = 500;
/** How often the index reads the chain's newest blocks; a tape reads the blocks after its newest itself (agreedRange). */
const INDEX_FOLLOW_MS = 5_000;
/** Blocks the index keeps past a tape's cold window and its ETH price's, so a caller whose head is behind the index's
 *  newest still finds its oldest block held (a 15-block miss at 02:36Z: the ETH price read its first blocks itself).
 *  [design: 500, 50 s of Robinhood's blocks, ten follower reads; the whole window stays under 5,000 blocks, the most
 *  rpc-robinhood.blockmachine.io serves without a key (-32002 "served for the most recent 5000 blocks only", read
 *  2026-11-05 03:3xZ)] */
const INDEX_SLACK = 500;
/** The swap events the index holds: every venue's a tape reads (swapFilter, refFilter). */
const INDEX_TOPICS = [TOPIC.swap4, TOPIC.swap3, TOPIC.swap2, TOPIC.curveBuy, TOPIC.curveSell, ...POOL_CALLS];

/** Providers whose logs carry no block time on a chain timed by them (Robinhood): their logs are timed by their own
 *  `eth_getBlockByNumber` of each log's block, and count for a swap's time only where another provider logged the same. */
export const HEADER_TIMED: ReadonlySet<string> = new Set(["https://rpc.mainnet.chain.robinhood.com"]);
/** The most blocks one `eth_getLogs` asks of a provider that takes more than its chain's VENUES span (card
 *  helper-robinhood-capacity, read 2026-11-04 19:44Z from the Mac, the v4 PoolManager's logs 500, 1,000 and 3,000 blocks
 *  back to the head): robinhood.api.pocket.network 1,532 logs over 1,000 blocks in 1.9 s and 3,000 in 7.4 s;
 *  rpc-robinhood.blockmachine.io 1,000 in 1.0 s and 3,000 in 0.6 s; robinhood.daybreak-rpc.network 1,000 in 0.9 s, 3,000
 *  refused -32602 "query exceeds max block range 2000"; rpc.mainnet.chain.robinhood.com 3,000 in 0.6 s. A 3,000-block
 *  cold window is 3 reads on them, not 30. [design: 1,000: the widest every one of them answered within 2 s, and the
 *  busiest filter's 1,000 blocks (a pool's swaps, under the whole PoolManager's 1,500 logs) fit ANSWER_MAX and LOGS_MAX.] */
const WIDE_SPAN: Readonly<Record<string, number>> = {
  "https://robinhood.api.pocket.network": 1_000,
  "https://rpc-robinhood.blockmachine.io": 1_000,
  "https://robinhood.daybreak-rpc.network": 1_000,
  "https://rpc.mainnet.chain.robinhood.com": 1_000,
};

/** Requests per JSON-RPC batch each provider takes: the maker read's (lists.ts BATCH_MAX: drpc's free plan 3), and
 *  Tenderly's gateway 4 (a batch of 10 `eth_call` answered HTTP 429 -32005 "rate limit exceeded", 2026-11-03 17:2xZ);
 *  a paced provider's at most its burst (limits.ts PROVIDER_PACE), so a batch never asks more than its bucket holds
 *  (publicnode 6, Tenderly 3; Pocket 10: batches of 10 a second answered 6 of 6, 6 Nov 18:50Z). */
const BATCH_SIZE: Readonly<Record<string, number>> = {
  ...BATCH_MAX,
  "https://base-rpc.publicnode.com": 6,
  "https://base.gateway.tenderly.co": 3,
  "https://base.api.pocket.network": 10,
  "https://api.blockvectra.com/v1/robinhood_mainnet/public": 1,
};

/** Requests out to one provider at once (swaps.ts batchTo). */
export const INFLIGHT_MAX = 4;
/** A provider's answer time before its first answer, and the weight of each new one in its moving average (waitOf).
 *  [design: 500 ms, about a wide 1,000-block read's (WIDE_SPAN: 0.6 to 1.9 s; heads and calls under 0.3 s), and 0.3, so
 *  three slow answers in a row move the rank.] */
const LATENCY_START_MS = 1_000;
/** A post slot gave back from a provider's queue (its requests unanswered there). */
const GAVE_UP = Symbol("gave up");
const LATENCY_WEIGHT = 0.3;
/** Expected waits within this of each other rank alike, and free budget orders them (ranked). [design: 100 ms, under
 *  one answer time, so the rank follows free budget until a queue or a pace wait is a real one.] */
const WAIT_GRAIN_MS = 100;
/** The longest a read waits for its provider's pace (limits.ts PROVIDER_PACE) before it is the next provider's to
 *  answer. [design: 1.5 s, ten of daybreak's posts at its pace; a provider whose bucket is that far spent is not the
 *  one to wait for while another has room.] A provider that holds is passed over at once: the pace keeps the reads
 *  under each provider's limit, so the short holds HOLD_WAIT_S waited out (cd22743) no longer start. */
export const PACE_WAIT_MAX_MS = 1_500;
/** The longest a read waits for its provider's pace when no other provider answered it (agreed's last round), so it
 *  never fails on the pace alone. [design: 5 s, a third of the 15 s a cold tape is given, within TIMEOUT_MS.] */
export const PACE_PATIENT_MS = 5_000;

/** Blocks read again every tick, and so the blocks an agreed head must be ahead of a settled block. Base's sequencer can
 *  reorg a few unsafe blocks; its `safe` head trails by about 40 s (proofs/evm-safe-lag, 20 blocks), so 10 re-read blocks
 *  are enough for the reorgs seen and the live tape stays within seconds. */
export const REWIND_BLOCKS = 10;
/** The blocks a token's first read may go back on Base (06c §4.12's cold open); each chain's own is VENUES[chain].cold. */
export const COLD_BLOCKS = VENUES.base.cold;
/** The blocks of a token's Transfer logs its main pool is found from: the chain's cold window, so the book's first read
 *  is the discovery's own. */
export const DISCOVER_BLOCKS = COLD_BLOCKS;
/** The addresses of a token's transfers checked as pools, busiest first, and the v4 pools checked. */
const CANDIDATES_MAX = 6;
const V4_TXS = 3;
/** A token's main pool is looked for again after this. */
export const POOL_KEEP_MS = 6 * 3_600_000;
/** The blocks the ETH price's first read goes back, so that a swap in the first step has one before it (Base). */
export const REF_COLD_BLOCKS = VENUES.base.step + VENUES.base.refBack;
/** The most blocks one `eth_getLogs` asks on Base, and the most such reads one tick makes for a token past its cold
 *  window (which takes cold / span reads). */
export const SPAN_MAX = VENUES.base.span;
const CHUNKS_MAX = 3;
/** Providers that answer one read at most: two, and two more when they differ (agreed: one that answers nothing, past
 *  its pace's or its queue's wait or held, does not count, and the next is asked). */
const PROVIDERS_MAX = 4;
/** A provider this many blocks behind the other is passed over for the third (Base). */
export const LAG_MAX = VENUES.base.lagMax;
/** A token nobody asked for this long stops being read (its book is dropped). */
export const IDLE_MS = 60_000;
/** The tick period. */
export const TICK_MS = 1_000;
/** An agreed head read within this is every reader's (agreedHead). [design: a tick's period, so a tick reads at most one
 *  head of its own and a dozen first reads at once read one.] */
export const HEAD_SHARE_MS = TICK_MS;
/** A book not read for this long starts a read when asked; it is served as held meanwhile, dated by its last read. */
export const STALE_MS = 60_000;
export const OPEN_MAX = 40;
/** Books read at once in a tick. */
const READ_PARALLEL = 8;
const POOLS_MAX = 5_000;
const ANSWER_MAX = 4 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
/** A provider whose post has been out this long, sent and not answered, is left to answer while the next is asked
 *  (hedged: agreed, agreedHead), so one that hangs costs a read this, never TIMEOUT_MS (card
 *  helper-robinhood-trades-hang: daybreak timed out at 8 s on about one post in five, 2026-11-05 15:2xZ, and each round
 *  of a first open waited for it; on swaps-hang.test.ts's fake a cold tape took 82 s). A read waiting in our own queue
 *  or pace (slot, one) has no post out and asks no one more (swaps-pace.test.ts fold 2: drpc stays the last resort).
 *  [design: 2 s, the slowest 1,000-block read every wide provider answered (WIDE_SPAN).] */
export const HEDGE_MS = 2_000;
/** The longest a read waits for the chain's swap index's read in flight before it reads its own blocks (agreedRange):
 *  the index is shared, never anyone's wait (the same card: its first read never landed for 135 s and every cold tape
 *  waited on it). [design: one hedge, the time a healthy index chunk is agreed in.] */
export const INDEX_WAIT_MS = HEDGE_MS;
/** A first open's answer bound: past it the tape or chart answers 503 and its read goes on, so the next ask finds it
 *  (the same card: requests held 60 s and more). [design: 12 s, under the 15 s the live checks give an answer
 *  (helper-robinhood-search-ahead ANSWER_MS) with room for the way to the page.] */
export const OPEN_BOUND_MS = 12_000;
/** `p`'s value, or LATE once `ms` have passed (`p` goes on). */
const LATE = Symbol("late");
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<typeof LATE>((go) => (timer = setTimeout(() => go(LATE), ms)))]).finally(() => clearTimeout(timer));
}
const LOGS_MAX = 20_000;
const TRADERS_MAX = 5_000;
/** Agreed eth_call results kept (callsAgreed), oldest out first. */
const CALLED_MAX = 5_000;
export const TRADES_MAX = 50;
export const CANDLES_MAX = 500;
/** History before our first bar never changes: kept this long. */
const GT_FRESH_MS = 3_600_000;
/** GeckoTerminal's newest bars as a chart of their own (a listed token with no pool of ours, noneCandles): read again
 *  after this, as the Solana token page's (../solana/token.ts CANDLES_FRESH_MS), and served from what is held only within
 *  GT_SERVE_MS (card helper-restart-fresh). */
const GT_NEWEST_FRESH_MS = 60_000;

// ---------------------------------------------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------------------------------------------

const keccakHex = (k: string): string => `0x${Buffer.from(keccak_256(Buffer.from(k.slice(2), "hex"))).toString("hex")}`;

/** Tick spacings tried first, then every one up to TICK_SPACING_MAX (v4 allows 1 to 32767; the pools read use a few). */
const TICK_SPACINGS = [1, 10, 60, 200, 30, 8, 100, 50, 20, 2, 4, 5];
const TICK_SPACING_MAX = 400;
/** The hook candidates tried: the first few addresses of the transaction (the work is bounded however many it holds). */
const HOOKS_MAX = 10;
const DYNAMIC_FEE = 0x800000;

/**
 * The PoolKey (abi-encoded: currency0, currency1, fee, tickSpacing, hooks) of a v4 pool that hashes to `id`, or null.
 * A pool the PositionManager did not make has no record there; its key is found by trying what a swap shows of it:
 * the token and one of the currencies we price (native ETH, WETH, USDC), the swap's own fee or the dynamic-fee flag or a
 * standard tier, the hooks among the addresses in the transaction (or none), and a tick spacing. A hash that equals the
 * id proves the key; nothing else is accepted.
 */
export function v4Key(id: string, token: string, swapFee: number, around: readonly string[], chain: EvmChain = "base"): string | null {
  for (const k of v4Tries(token, swapFee, around, chain)) if (keccakHex(k) === id) return k;
  return null;
}
/** The keys v4Key tries, in its order. */
function* v4Tries(token: string, swapFee: number, around: readonly string[], chain: EvmChain): Generator<string> {
  const V = VENUES[chain];
  const w = (n: bigint): string => n.toString(16).padStart(64, "0");
  const a = (x: string): string => x.slice(2).padStart(64, "0");
  const hooks = [ZERO, ...around.filter((x) => x !== token && x !== V.poolManager && x !== V.weth && x !== V.usd).slice(0, HOOKS_MAX)];
  const fees = [...new Set([swapFee, DYNAMIC_FEE, 100, 500, 2500, 3000, 10000])];
  const spacings = [...TICK_SPACINGS, ...Array.from({ length: TICK_SPACING_MAX }, (_, i) => i + 1).filter((t) => !TICK_SPACINGS.includes(t))];
  for (const other of [ZERO, V.weth, V.usd]) {
    const [c0, c1] = token < other ? [token, other] : [other, token];
    for (const ts of spacings) for (const h of hooks) for (const f of fees) yield `0x${a(c0)}${a(c1)}${w(BigInt(f))}${w(BigInt(ts))}${a(h)}`;
  }
}
/** Keys v4KeySliced hashes between two turns of the event loop. [design: 1,000, about 60 ms on the Mac (a miss of
 *  92,000 tries, ten hook candidates, took 5.4 s there, 2026-11-05 16:3xZ), so a box twice as slow stays well under the
 *  second swaps-v4key.test.ts allows.] */
const V4_KEY_SLICE = 1_000;
/** v4Key, the event loop let run every V4_KEY_SLICE tries: a search that misses takes seconds of hashing, and in one go it
 *  held every other read of the helper (card robinhood-cold-open-fast: four cold opens' posts all aborted at 14 s). */
export async function v4KeySliced(id: string, token: string, swapFee: number, around: readonly string[], chain: EvmChain = "base"): Promise<string | null> {
  let n = 0;
  for (const k of v4Tries(token, swapFee, around, chain)) {
    if (keccakHex(k) === id) return k;
    if (++n % V4_KEY_SLICE === 0) await new Promise((go) => setImmediate(go));
  }
  return null;
}

/** `t`: the block's time as the provider logged it (`blockTimestamp`), null when it gave none; 0 is no time either. */
export type Log = { block: number; index: number; tx: string; address: string; topics: string[]; data: string; t?: number | null };
const WORD = /^0x[0-9a-f]{64}$/;
const HEXDATA = /^0x([0-9a-f]{64})*$/;
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const hexInt = (v: unknown): number | null => (typeof v === "string" && /^0x[0-9a-f]{1,13}$/i.test(v) ? parseInt(v, 16) : null);

/** One `eth_getLogs` entry as a Log, or null when it is malformed; `removed` logs are skipped by the caller. */
export function parseLog(raw: unknown): Log | null {
  const l = obj(raw);
  const block = hexInt(l.blockNumber);
  const index = hexInt(l.logIndex);
  const address = evmAddress(l.address);
  const topics = l.topics;
  const tx = typeof l.transactionHash === "string" ? l.transactionHash.toLowerCase() : "";
  if (block === null || index === null || address === null || !WORD.test(tx) || !Array.isArray(topics) || topics.length < 1 || topics.length > 4) return null;
  const ts = topics.map((t) => (typeof t === "string" ? t.toLowerCase() : ""));
  const data = typeof l.data === "string" ? l.data.toLowerCase() : "";
  if (!ts.every((t) => WORD.test(t)) || data.length > 2 + 64 * 16 || !HEXDATA.test(data)) return null;
  const t = l.blockTimestamp === undefined ? null : hexInt(l.blockTimestamp);
  return { block, index, tx, address, topics: ts, data, t };
}

/** The logs of an `eth_getLogs` result, in block and log order, or null when it is not a list of valid logs. */
export function parseLogs(result: unknown): Log[] | null {
  if (!Array.isArray(result) || result.length > LOGS_MAX) return null;
  const out: Log[] = [];
  for (const raw of result) {
    if (obj(raw).removed === true) continue;
    const l = parseLog(raw);
    if (l === null) return null;
    out.push(l);
  }
  return out.sort((a, b) => a.block - b.block || a.index - b.index);
}

const key = (l: Log, withTime: boolean) => `${l.block}:${l.index}:${l.tx}:${l.address}:${l.topics.join(",")}:${l.data}${withTime ? `:${l.t ?? "-"}` : ""}`;
/** Whether two providers' answers for one filter are the same logs; `withTime`: with the same block times too (the
 *  swaps' reads, which are timed by them). */
export const sameLogs = (a: Log[], b: Log[], withTime = false): boolean => a.length === b.length && a.every((l, i) => key(l, withTime) === key(b[i]!, withTime));

const word = (data: string, i: number): string => data.slice(2 + 64 * i, 2 + 64 * (i + 1));
const addrOf = (w: string): string => `0x${w.slice(24)}`;
/** A signed 256-bit word as a bigint, or null when it does not fit `bits` (a sign-extended int128, say). */
function signed(w: string, bits: number): bigint | null {
  let v = BigInt(`0x${w}`);
  if (v >= 1n << 255n) v -= 1n << 256n;
  const lim = 1n << BigInt(bits - 1);
  return v >= -lim && v < lim ? v : null;
}
const unsigned = (w: string, bits: number): bigint | null => {
  const v = BigInt(`0x${w}`);
  return v < 1n << BigInt(bits) ? v : null;
};

// ---------------------------------------------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------------------------------------------

export type Pool = {
  venue: "v4" | "v3" | "v2" | "curve";
  /** A pool's address (a Pons curve's), or a v4 pool's id (what GeckoTerminal calls the pool). */
  id: string;
  token: string;
  tokenIs0: boolean;
  quote: { kind: "usd" | "eth"; decimals: number };
  /** A v4 pool's hook when its address carries a return-delta flag (hookOf): the hook may then take from or add to
   *  what the swapper pays or gets, after the `Swap` log is written. */
  hook?: string;
  /** A hooked v4 pool's: the token's other v4 pools the discovery found, whose swaps are read with this pool's only so
   *  hookTakes can tell a sender that swapped the token once in the transaction (card helper-v4-hook-liquidity). */
  siblings?: readonly string[];
};

/** v4-core Hooks.sol: BEFORE_SWAP_RETURNS_DELTA_FLAG (1 << 3) and AFTER_SWAP_RETURNS_DELTA_FLAG (1 << 2), read in the
 *  sources Sourcify holds for PonsV2MemeHook on chain 4663. A hook's permissions are the low bits of its address. */
const BEFORE_SWAP_DELTA = 1n << 3n;
const AFTER_SWAP_DELTA = 1n << 2n;

/**
 * The hook of a v4 PoolKey (abi-encoded, its fifth word) when it may change a swapper's amounts, else undefined. The
 * PoolManager writes `Swap` with the pool's own amounts, then calls the hook's afterSwap, whose returned delta is taken
 * from the swapper's unspecified leg (a beforeSwap delta from the specified one) and settled by the hook itself in the
 * same call: on Robinhood PonsV2MemeHook 0xe5e70264... takes 2.75% of a buy's token leg, so the buyer of tx 0x2446469c
 * got 22,193.91 of the 22,821.50 the log shows (receipt read on two providers, 2026-11-04 20:1xZ).
 */
export function hookOf(key: string): string | undefined {
  if (!/^0x[0-9a-f]{320}$/.test(key)) return undefined;
  const h = `0x${key.slice(2 + 64 * 4 + 24)}`;
  return (BigInt(h) & (BEFORE_SWAP_DELTA | AFTER_SWAP_DELTA)) !== 0n ? h : undefined;
}

/** The `eth_getLogs` filters for a pool's trades over blocks `from` to `to`: its swaps, and for a pool with a hook
 *  (Pool.hook) the token's transfers and the PoolManager's ERC-6909 claims of the token, which show what each swap's
 *  sender took or paid and the hook's cut (hookTakes). A
 *  hooked pool's swaps filter also takes the pool's other PoolManager calls (POOL_CALLS), whose own transfers are no
 *  cut: each is the PoolManager's event with the pool's id as its first indexed topic, so they are one filter, never a
 *  third read a span (card helper-robinhood-capacity fold 8: the third sent a cold dozen's reads past the wide
 *  providers' paces to drpc's 100-block spans). One address a filter, never a list: api.blockvectra.com refuses an
 *  address list (-32602, 2026-11-04 20:2xZ). */
export function poolFilters(pool: Pick<Pool, "venue" | "id" | "token" | "hook" | "siblings">, from: number, to: number, chain: EvmChain = "base"): Record<string, unknown>[] {
  const swaps = swapFilter(pool, from, to, chain);
  if (pool.venue !== "v4" || pool.hook === undefined) return [swaps];
  return [
    { ...swaps, topics: [[TOPIC.swap4, ...POOL_CALLS], pool.siblings?.length ? [pool.id, ...pool.siblings] : pool.id] },
    { address: pool.token, topics: [TOPIC.transfer], fromBlock: swaps.fromBlock, toBlock: swaps.toBlock },
    { address: VENUES[chain].poolManager, topics: [TOPIC.claims, null, null, `0x${pool.token.slice(2).padStart(64, "0")}`], fromBlock: swaps.fromBlock, toBlock: swaps.toBlock },
  ];
}

/** The `eth_getLogs` filter for a pool's swaps over blocks `from` to `to`. */
export function swapFilter(pool: Pick<Pool, "venue" | "id">, from: number, to: number, chain: EvmChain = "base"): Record<string, unknown> {
  const range = { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
  if (pool.venue === "v4") return { address: VENUES[chain].poolManager, topics: [TOPIC.swap4, pool.id], ...range };
  if (pool.venue === "curve") return { address: pool.id, topics: [[TOPIC.curveBuy, TOPIC.curveSell]], ...range };
  return { address: pool.id, topics: [pool.venue === "v3" ? TOPIC.swap3 : TOPIC.swap2], ...range };
}
const refFilter = (from: number, to: number, chain: EvmChain) => swapFilter({ venue: "v4", id: VENUES[chain].refPoolId }, from, to, chain);

const TWO_192 = 1n << 192n;
/** A swap log of the ETH price pool as the ETH price it leaves, or null: USD per ETH times 10^18 from the pool's price
 *  after the swap (sqrtPriceX96 squared over 2^192 is USDC units per wei; times 10^12 for USD per ETH; times 10^18). */
export function decodeRef(l: Log, chain: EvmChain = "base"): Ref | null {
  const V = VENUES[chain];
  if (l.address !== V.poolManager || l.topics.length !== 3 || l.topics[0] !== TOPIC.swap4 || l.topics[1] !== V.refPoolId || l.data.length !== 2 + 64 * 6) return null;
  const sqrt = unsigned(word(l.data, 2), 160);
  if (sqrt === null || sqrt === 0n) return null;
  const ethUsd = (sqrt * sqrt * 10n ** 30n) / TWO_192;
  // 1 to 10,000,000 USD per ETH: outside is not ETH's price
  if (ethUsd < 10n ** 18n || ethUsd > 10n ** 25n) return null;
  return { kind: "ref", block: l.block, index: l.index, ethUsd };
}

/** A swap log of `pool` as a Swap (its `t` is set by the caller), or null when it is not one. The pool's deltas: v3 as
 *  logged; v4 the swapper's, negated; v2 in minus out. Side is `b` when the pool paid the token out. */
export function decodeSwap(pool: Pool, l: Log, chain: EvmChain = "base"): Omit<Swap, "t"> | null {
  let d0: bigint | null;
  let d1: bigint | null;
  if (pool.venue === "curve") {
    // a Pons curve's own trade: the token and the quote it moved, as the buyer paid or the seller got them
    if (l.address !== pool.id || l.topics.length !== 3 || (l.topics[0] !== TOPIC.curveBuy && l.topics[0] !== TOPIC.curveSell) || l.data.length !== 2 + 64 * 4) return null;
    const [a, b] = [unsigned(word(l.data, 0), 256)!, unsigned(word(l.data, 1), 256)!];
    const buy = l.topics[0] === TOPIC.curveBuy;
    const [amt, quote] = buy ? [b, a] : [a, b];
    if (amt === 0n || quote === 0n) return null;
    return { kind: "swap", block: l.block, index: l.index, tx: l.tx, side: buy ? "b" : "s", amt, quote };
  }
  if (pool.venue === "v4") {
    if (l.address !== VENUES[chain].poolManager || l.topics.length !== 3 || l.topics[0] !== TOPIC.swap4 || l.topics[1] !== pool.id || l.data.length !== 2 + 64 * 6) return null;
    const [a0, a1] = [signed(word(l.data, 0), 128), signed(word(l.data, 1), 128)];
    [d0, d1] = [a0 === null ? null : -a0, a1 === null ? null : -a1];
  } else if (pool.venue === "v3") {
    if (l.address !== pool.id || l.topics.length !== 3 || l.topics[0] !== TOPIC.swap3 || l.data.length !== 2 + 64 * 5) return null;
    [d0, d1] = [signed(word(l.data, 0), 256), signed(word(l.data, 1), 256)];
  } else {
    if (l.address !== pool.id || l.topics.length !== 3 || l.topics[0] !== TOPIC.swap2 || l.data.length !== 2 + 64 * 4) return null;
    const w = [0, 1, 2, 3].map((i) => unsigned(word(l.data, i), 256));
    if (w.some((x) => x === null)) return null;
    [d0, d1] = [w[0]! - w[2]!, w[1]! - w[3]!];
  }
  if (d0 === null || d1 === null || d0 === 0n || d1 === 0n || d0 > 0n === d1 > 0n) return null; // one leg in, one out
  const [dt, dq] = pool.tokenIs0 ? [d0, d1] : [d1, d0];
  return { kind: "swap", block: l.block, index: l.index, tx: l.tx, side: dt < 0n ? "b" : "s", amt: dt < 0n ? -dt : dt, quote: dq < 0n ? -dq : dq };
}

/**
 * A hooked v4 pool's (Pool.hook) cut of the token in each of its swaps, by the swap log's `tx:index`, from the logs read
 * with the swaps (poolFilters).
 *
 * First the swap's own sender: the PoolManager credits the contract that called swap() (the Swap log's sender) with the
 * swap's delta after the hook's, and that contract takes or pays exactly it, as the token (a Transfer between it and the
 * PoolManager) or as ERC-6909 claims of the token (minted to it, burnt from it). So when the sender made only this one
 * swap of the token in the transaction (in this pool or its siblings read), what it moved with the PoolManager is the
 * trader's leg; when it moved none (a route through the token whose deltas net out inside the PoolManager), there is no
 * read and the hook's own moves below decide. A buy gets at most the
 * pool's amount, a sell pays at least it, and the cut is the difference (card helper-v4-hook-liquidity: Base tx
 * 0x72c376b7, block 53,540,767, hook 0xbdf93814 whose afterSwap calls 0x9982538f, which takes the cut and sells and adds
 * liquidity with it, so none of the cut moves between the PoolManager and the hook; the buyer's router took 11,661.28
 * of the pool's 11,785.03).
 *
 * Else the hook's own moves: the token's transfers between the PoolManager and the hook, and the claims of the token
 * the hook has the PoolManager mint (its take, to whomever it names) or burn. A hook settles its delta inside its own
 * call, so its moves sit next to the swap's log: an afterSwap hook's after it (before the transaction's next swap of the
 * pool), a beforeSwap-only hook's before it. A swap the hook sends itself is no one's trade through the hook (v4 calls
 * no hook for its own swaps): no cut. A move whose nearest PoolManager event of the pool before it is another call
 * (POOL_CALLS: its liquidity added or taken, its start, a donation) settles that call, never a swap: no cut (Base tx
 * 0x02b8198c...a2e5 at block 53,529,320: Initialize, ModifyLiquidity, the hook's 1e9 tokens in, then the first buy).
 * For a beforeSwap-only hook only its paying in there settles the call: a take there is the next swap's cut.
 */
export function hookTakes(pool: Pool, logs: readonly Log[], chain: EvmChain = "base"): Map<string, bigint> {
  const takes = new Map<string, bigint>();
  if (pool.venue !== "v4" || pool.hook === undefined) return takes;
  const pm = VENUES[chain].poolManager;
  const hook = pool.hook;
  const after = (BigInt(hook) & AFTER_SWAP_DELTA) !== 0n;
  const tokenWord = `0x${pool.token.slice(2).padStart(64, "0")}`;
  const byTx = new Map<string, { swaps: Log[]; senders: Map<string, number>; calls: number[]; callers: Set<string>; moves: { index: number; take: bigint }[]; net: Map<string, bigint> }>();
  const at = (tx: string) => byTx.get(tx) ?? byTx.set(tx, { swaps: [], senders: new Map(), calls: [], callers: new Set(), moves: [], net: new Map() }).get(tx)!;
  // the token an address got from the PoolManager in a transaction, less what it paid in
  const credit = (tx: string, a: string, v: bigint) => {
    const n = at(tx).net;
    n.set(a, (n.get(a) ?? 0n) + v);
  };
  const ids = new Set([pool.id, ...(pool.siblings ?? [])]);
  for (const l of logs) {
    if (l.address === pm && l.topics.length === 3 && l.topics[0] === TOPIC.swap4 && ids.has(l.topics[1]!)) {
      // every swap of the token's pools read counts toward its sender's; only this pool's are its trades
      const sender = addrOf(l.topics[2]!.slice(2));
      const t = at(l.tx);
      t.senders.set(sender, (t.senders.get(sender) ?? 0) + 1);
      if (l.topics[1] === pool.id && sender !== hook) t.swaps.push(l);
    } else if (l.address === pm && l.topics[1] === pool.id && POOL_CALLS.includes(l.topics[0]!)) {
      at(l.tx).calls.push(l.index);
      // a ModifyLiquidity's or Donate's sender settles that call, never a trade
      if (l.topics[0] !== TOPIC.initialize && l.topics.length === 3) at(l.tx).callers.add(addrOf(l.topics[2]!.slice(2)));
    }
    else if (l.address === pool.token && l.topics.length === 3 && l.topics[0] === TOPIC.transfer && l.data.length === 66) {
      const [from, to] = [addrOf(l.topics[1]!.slice(2)), addrOf(l.topics[2]!.slice(2))];
      const v = BigInt(l.data);
      if (from === pm && to !== pm) credit(l.tx, to, v);
      else if (to === pm && from !== pm) credit(l.tx, from, -v);
      if (from === pm && to === hook) at(l.tx).moves.push({ index: l.index, take: v });
      else if (from === hook && to === pm) at(l.tx).moves.push({ index: l.index, take: -v });
    } else if (l.address === pm && l.topics.length === 4 && l.topics[0] === TOPIC.claims && l.topics[3] === tokenWord && l.data.length === 2 + 128) {
      const [from, to] = [addrOf(l.topics[1]!.slice(2)), addrOf(l.topics[2]!.slice(2))];
      const v = BigInt(`0x${l.data.slice(66)}`);
      const mint = from === ZERO && to !== ZERO;
      const burn = to === ZERO && from !== ZERO;
      // claims the hook has minted or burnt are its own moves, never a trader's
      if (addrOf(l.data.slice(2, 66)) === hook) {
        if (mint) at(l.tx).moves.push({ index: l.index, take: v });
        else if (burn) at(l.tx).moves.push({ index: l.index, take: -v });
      } else if (mint) credit(l.tx, to, v);
      else if (burn) credit(l.tx, from, -v);
    }
  }
  for (const { swaps, senders, calls, callers, moves, net } of byTx.values()) {
    if (swaps.length === 0) continue;
    swaps.sort((a, b) => a.index - b.index);
    const alone = [...senders.values()].reduce((a, b) => a + b, 0) === 1;
    // the sender's own leg, where it settles this one swap alone; or, the transaction's only swap of the token, the one
    // address it moved with the PoolManager that is no hook, swap sender or call sender (a router's take sent straight
    // to its recipient, or a payer's settle: v4's take(currency, to, amount) names no sender)
    const known = new Set<number>();
    for (const l of swaps) {
      const sender = addrOf(l.topics[2]!.slice(2));
      const s = decodeSwap(pool, l, chain);
      if (s === null || senders.get(sender) !== 1) continue;
      let n = net.get(sender) || undefined;
      if (n === undefined && alone) {
        const to = [...net].filter(([a, v]) => v !== 0n && a !== hook && !senders.has(a) && !callers.has(a));
        if (to.length === 1) n = to[0]![1];
      }
      if (n === undefined) continue;
      const leg = s.side === "b" ? n : -n;
      if (leg <= 0n || (s.side === "b" ? leg > s.amt : leg < s.amt)) continue;
      known.add(l.index);
      if (leg !== s.amt) takes.set(`${l.tx}:${l.index}`, s.side === "b" ? s.amt - leg : leg - s.amt);
    }
    for (const m of moves) {
      const call = Math.max(-1, ...calls.filter((i) => i < m.index));
      // settles that call: any move of an afterSwap hook (its cut follows its swap), and a beforeSwap-only hook's paying
      // in (hook to PoolManager), never its take, which is the next swap's beforeSwap cut
      if (call >= 0 && !swaps.some((s) => s.index > call && s.index < m.index) && (after || m.take < 0n)) continue;
      const before = swaps.filter((s) => s.index < m.index).at(-1);
      const next = swaps.find((s) => s.index > m.index);
      const owner = after ? (before ?? next)! : (next ?? before)!;
      if (known.has(owner.index)) continue;
      const k = `${owner.tx}:${owner.index}`;
      takes.set(k, (takes.get(k) ?? 0n) + m.take);
    }
  }
  return takes;
}

/** The token leg the trader got (a buy) or paid (a sell) when a hook's cut `take` makes it differ from the pool's
 *  `amt`; undefined when it does not, or when the cut would leave nothing (no trader's leg, so the pool's stands). */
export function traderLeg(s: Pick<Swap, "side" | "amt">, take: bigint | undefined): bigint | undefined {
  if (take === undefined || take === 0n) return undefined;
  const got = s.side === "b" ? s.amt - take : s.amt + take;
  return got > 0n ? got : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// The providers
// ---------------------------------------------------------------------------------------------------------------

type Call = { method: string; params: unknown[] };
type Reply = { ok: true; result: unknown } | { ok: false; wait: number; reverted?: true };
/** An `eth_call` the provider ran and the contract reverted: geth's code 3 (a revert with data) or a message naming the
 *  revert (-32000 "execution reverted", as daybreak, blockmachine, drpc and the chain's own RPC answer one). It is the
 *  call's answer at that block, as a result is, never a failed read. */
const isRevert = (e: unknown): boolean => {
  const o = obj(e);
  return o.code === 3 || (typeof o.message === "string" && /revert/i.test(o.message));
};
/** callsAgreed's word for a call two providers say reverted at that block: agreed and kept like a result, answered as
 *  no value (undefined), as a call not agreed is. */
const REVERTED = "reverted";

export function createSwaps(chain: EvmChain, deps: { fetch?: Fetch; now?: () => number; listed: (token: string) => Promise<boolean>; hint?: (token: string) => Promise<string | null>; gecko?: GeckoBudget; rpcs?: readonly string[]; headerTimed?: ReadonlySet<string>; pools?: ReadonlyMap<string, { pool: Pool; decimals: number }>; tickMs?: number; holds?: ProviderHolds; index?: readonly string[] }) {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const rpcs = deps.rpcs ?? SWAP_RPCS[chain];
  const headerTimed = deps.headerTimed ?? HEADER_TIMED;
  const V = VENUES[chain];
  // a swap is timed by its log's own block time, which two providers must give alike (sameLogs with times)
  const timeOf = (l: Log): number | null => (typeof l.t === "number" && l.t > 0 ? l.t : null);
  /** Blocks `from` to `to` in spans of at most V.span. */
  const spans = (from: number, to: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let lo = from; lo <= to; lo += V.span) out.push([lo, Math.min(to, lo + V.span - 1)]);
    return out;
  };
  // each provider's hold, shared with every other path of the helper that reads it (limits.ts providerHolds)
  const holds = deps.holds ?? providerHolds(now);

  // Two lanes on every provider's pace and in-flight queue (card helper-deploy-reads-fast): a read a caller waits on (a
  // candles or trades read's open: its pool, its first read, its traders) is foreground; the helper's own reads (the open
  // books' ticks, the lists' pool search ahead, the index) are background. Foreground goes first in each provider's
  // in-flight queue and may draw the CALLER_ROOM background leaves free (limits.ts providerHolds take), so a user's read
  // never waits behind the helper's own: after a deploy every tape is cold, the live checks and the app open dozens at
  // once, and each open book ticks every TICK_MS (live run 42122733397 attempt 1: Base first reads 2.3 to 5.6 s, a v4
  // tape 503 at OPEN_BOUND_MS, and index-evm-swaps BAD). Work a caller joins that another started (a pool search, the
  // shared head, the ETH price read) is lifted to foreground by the join (join), the standard priority inheritance.
  // A lane also counts the ms its reads waited for a pace or a queue, for the answer's Server-Timing (laneTiming).
  type Lane = { fg: boolean; paceMs: number; slotMs: number; posts: number; joined?: Set<Lane> };
  const lanes = new AsyncLocalStorage<Lane>();
  const newLane = (fg: boolean): Lane => ({ fg, paceMs: 0, slotMs: 0, posts: 0 });
  /** The lane a read runs in now: none set is background. */
  const fgNow = (): boolean => lanes.getStore()?.fg === true;
  /** Work that callers may share, started now: a lane of its own, foreground when its starter is. */
  const sharedLane = (): Lane => newLane(fgNow());
  /** A caller joins shared work: a foreground one lifts it to foreground, and counts its waits as its own. */
  const join = (l: Lane): void => {
    const me = lanes.getStore();
    if (me === undefined || !me.fg || me === l) return;
    l.fg = true;
    (me.joined ??= new Set()).add(l);
  };
  /** The time `ms` one post of the lane now waited for a provider's pace or its in-flight queue (`slot`). */
  const waited = (ms: number, slot = false): void => {
    const l = lanes.getStore();
    if (l === undefined || ms <= 0) return;
    if (slot) l.slotMs += ms;
    else l.paceMs += ms;
    l.posts++;
  };
  /** A foreground answer's Server-Timing: the ms its reads (and the shared reads it joined) waited for a provider's pace
   *  or in-flight queue, and how many posts waited; the open's whole time beside it. */
  const laneTiming = (l: Lane, openMs: number): string => {
    let pace = 0;
    let slot = 0;
    let posts = 0;
    const seen = new Set<Lane>();
    const walk = (x: Lane): void => {
      if (seen.has(x)) return;
      seen.add(x);
      pace += x.paceMs;
      slot += x.slotMs;
      posts += x.posts;
      for (const y of x.joined ?? []) walk(y);
    };
    walk(l);
    return `evm-open;dur=${Math.round(openMs)}, evm-queue;dur=${Math.round(pace + slot)};desc="${posts} posts: pace ${Math.round(pace)} ms, in flight ${Math.round(slot)} ms"`;
  };

  /** One JSON-RPC batch to a provider: each call's reply, or the wait a refusal names; null when it failed. */
  async function batchTo(url: string, calls: Call[], patient = false): Promise<Reply[] | null> {
    const max = BATCH_SIZE[url] ?? 10;
    const parts: Call[][] = [];
    for (let i = 0; i < calls.length; i += max) parts.push(calls.slice(i, i + max));
    // a part waits for its units of the provider's pace inside its place in the in-flight queue; a background part waits
    // for them before it takes a place, so it never holds one asleep (card helper-deploy-reads-fast: background posts
    // asleep on the pace in the places held a caller's read 2.6 s in the queue behind them)
    const wait = patient ? PACE_PATIENT_MS : PACE_WAIT_MAX_MS;
    const send = (part: Call[]) => async () => ((await paceFor(url, part.length, patient)) ? one(url, part) : null);
    const got = await Promise.all(parts.map(async (part) => (fgNow() ? slot(url, part.length, wait, send(part)) : (await paceFor(url, part.length, patient)) ? slot(url, part.length, wait, () => one(url, part)) : null)));
    // a part given back from the queue (slot) is no answer for its requests alone: the parts answered are kept, and only
    // its requests are asked of the next provider
    if (got.every((g) => g === GAVE_UP)) return null;
    return got.some((g) => g === null) ? null : got.flatMap((g, k) => (g === GAVE_UP ? parts[k]!.map((): Reply => ({ ok: false, wait: 0 })) : (g as Reply[])));
  }

  // at most INFLIGHT_MAX requests out to a provider at once, the rest queued in order: a first read's walk sent 246 at
  // once to the Robinhood providers, which answered 429, -32005, drpc's code 30 and timeouts that one at a time they
  // did not (card helper-chart-fresh, 2026-11-04 14:49Z)
  // (`calls`: the calls out or queued to it, by which free counts its budget; `queue`: each queued post's calls, by
  // which waitOf counts the units it will take)
  const inflight = new Map<string, { n: number; calls: number; queue: { go: () => void; calls: number; fg: boolean }[] }>();
  // a post queued past `maxWaitMs` is another provider's, as a read past its pace's wait is (one): GAVE_UP, counted in
  // `paced` so agreed's patient round may ask it again (fold 4: at c780282 a cold dozen's reads waited 68.7 s in all in
  // daybreak's queue, and the slowest tape took 16.7 s)
  async function slot<T>(url: string, calls: number, maxWaitMs: number, run: () => Promise<T>): Promise<T | typeof GAVE_UP> {
    const q = inflight.get(url) ?? { n: 0, calls: 0, queue: [] };
    inflight.set(url, q);
    q.calls += calls;
    if (q.n >= (holds.paceOf(url)?.inflight ?? INFLIGHT_MAX)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fg = fgNow();
      const queuedAt = performance.now();
      const sent = await new Promise<boolean>((go) => {
        const entry = { go: () => go(true), calls, fg };
        // a foreground post goes ahead of every background one queued (card helper-deploy-reads-fast), behind the
        // foreground ones before it
        const at = fg ? q.queue.findIndex((x) => !x.fg) : -1;
        if (at < 0) q.queue.push(entry);
        else q.queue.splice(at, 0, entry);
        timer = setTimeout(() => {
          // handed a slot meanwhile (shifted out and resolved true): nothing to take back
          const i = q.queue.indexOf(entry);
          if (i < 0) return;
          q.queue.splice(i, 1);
          go(false);
        }, maxWaitMs);
      });
      clearTimeout(timer);
      waited(performance.now() - queuedAt, true);
      if (!sent) return (q.calls -= calls), paced.set(url, (paced.get(url) ?? 0) + 1), GAVE_UP;
    } else q.n++;
    try {
      return await run();
    } finally {
      q.calls -= calls;
      const next = q.queue.shift();
      if (next !== undefined) next.go();
      else q.n--;
    }
  }

  /** One JSON-RPC batch (at most the provider's batch size) to a provider. Its hold is read right before the fetch: a
   *  batch queued behind INFLIGHT_MAX before the provider refused sends nothing while it holds and fails as a refused
   *  read does, so the caller asks the next provider (card helper-rpc-hold-queued: 2026-11-04 18:55Z on the helper box,
   *  seven batches queued before the chain's own Robinhood RPC's 429 were sent within 190 ms of it). */
  /** Reads each provider passed at its pace's wait, by which agreed's last round knows whom to ask again. */
  const paced = new Map<string, number>();
  /** Each provider's answer time, a moving average of its posts' (waitOf), from LATENCY_START_MS; `out`: when each post
   *  now out to it was sent, so a provider whose answers are late counts as slow before the first returns. */
  const latency = new Map<string, number>();
  const out = new Map<string, Set<number>>();
  const latencyOf = (u: string): number => {
    const ewma = latency.get(u) ?? LATENCY_START_MS;
    const o = out.get(u);
    return o === undefined || o.size === 0 ? ewma : Math.max(ewma, performance.now() - Math.min(...o));
  };
  /** The provider's pace, which every path of the helper draws from (limits.ts providerHolds take): a read waits for
   *  its units, the hold read again after each wait; past PACE_WAIT_MAX_MS of waits it is another provider's, past
   *  PACE_PATIENT_MS when no other provider answered it (agreed's last round). False when it is not to be sent here. A
   *  foreground read (a caller's, card helper-deploy-reads-fast) also draws the CALLER_ROOM background leaves. */
  async function paceFor(url: string, calls: number, patient: boolean): Promise<boolean> {
    if (holds.heldFor(url) > 0) return false;
    const bg = !fgNow();
    let slept = 0;
    for (let w = holds.take(url, calls, bg); w > 0; w = holds.take(url, calls, bg)) {
      if (slept + w > (patient ? PACE_PATIENT_MS : PACE_WAIT_MAX_MS)) return (waited(slept), paced.set(url, (paced.get(url) ?? 0) + 1), false);
      await new Promise((go) => setTimeout(go, w));
      slept += w;
      if (holds.heldFor(url) > 0) return (waited(slept), false);
    }
    waited(slept);
    return true;
  }
  async function one(url: string, part: Call[]): Promise<Reply[] | null> {
    if (holds.heldFor(url) > 0) return null;
    const sent = performance.now();
    const o = out.get(url) ?? new Set<number>();
    out.set(url, o);
    o.add(sent);
    try {
      const r = await doFetch(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(part.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params }))),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      latency.set(url, (latency.get(url) ?? LATENCY_START_MS) * (1 - LATENCY_WEIGHT) + (performance.now() - sent) * LATENCY_WEIGHT);
      if (r.status === 429) {
        await r.body?.cancel();
        // a later, shorter wait never cuts a longer one (providerHolds), as the limit path below
        holds.hold(url, upstreamRetryAfterS(r.headers, now()));
        return null;
      }
      if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) {
        await r.body?.cancel();
        return null;
      }
      const text = await r.text();
      if (text.length > ANSWER_MAX) return null;
      const parsed: unknown = JSON.parse(text);
      const answers = Array.isArray(parsed) ? parsed : [parsed];
      const got: Reply[] = part.map(() => ({ ok: false, wait: 0 }));
      for (const a of answers) {
        const o = obj(a);
        if (!Number.isSafeInteger(o.id) || (o.id as number) < 0 || (o.id as number) >= part.length) continue;
        if (Object.hasOwn(o, "error")) {
          // the helper's one rule for a provider's error (limits.ts evmThrottleS): a throttle is held for the wait it names
          const wait = evmThrottleS(o.error);
          if (wait > 0) holds.hold(url, wait);
          got[o.id as number] = wait === 0 && isRevert(o.error) ? { ok: false, wait, reverted: true } : { ok: false, wait };
        } else if (Object.hasOwn(o, "result")) got[o.id as number] = { ok: true, result: o.result };
      }
      return got;
    } catch {
      return null;
    } finally {
      o.delete(sent);
    }
  }
  /** Waits for `p` until it settles or one of `urls` has a post out (sent, unanswered) HEDGE_MS or longer. */
  async function hedged(p: Promise<unknown>, urls: readonly string[]): Promise<void> {
    for (;;) {
      const at = performance.now();
      const ages = urls.flatMap((u) => [...(out.get(u) ?? [])].map((sent) => at - sent));
      if (ages.some((a) => a >= HEDGE_MS)) return;
      // the next look: when the oldest post out would reach HEDGE_MS, or HEDGE_MS on when none is out yet
      if ((await within(p, Math.max(1, HEDGE_MS - Math.max(0, ...ages)))) !== LATE) return;
    }
  }
  const usable = (urls: readonly string[]) => urls.filter((u) => holds.heldFor(u) === 0);
  /** `urls` less a provider that takes one request a post (BATCH_SIZE 1: daybreak, blockvectra) when `calls` would be
   *  more than one post to it: it takes single-post reads only (card helper-robinhood-capacity fold 5: at fa4b98d a
   *  cold dozen sent daybreak 94 eth_getLogs posts, each wide read 3 to 6 of them in its 3 slots). */
  const single = (urls: readonly string[], calls: number): string[] => urls.filter((u) => (BATCH_SIZE[u] ?? 10) > 1 || calls <= 1);
  /** A provider's free budget, in calls: what its pace lets background reads send within the next second (the free
   *  units above CALLER_ROOM and a second's refill, times the calls a post carries where it counts posts), less the calls
   *  already out or queued to it (slot), so a dozen walks starting at once see each other's reads. A provider with no
   *  pace counts what INFLIGHT_MAX posts carry. */
  const free = (u: string): number => {
    const batch = BATCH_SIZE[u] ?? 10;
    const p = holds.paceOf(u);
    const per = p === undefined || p.unit === "post" ? batch : 1;
    const room = p === undefined ? INFLIGHT_MAX : Math.max(0, holds.room(u) * p.burst - p.burst * CALLER_ROOM) + p.perS;
    return room * per - (inflight.get(u)?.calls ?? 0);
  };
  /** How long a read of `calls` calls to `u` (with `headers`, a second post each for their headers) expects to wait
   *  for its answer (card helper-robinhood-capacity fold 4): one answer time (latency) after the longer of its in-flight
   *  queue (the posts out and queued ahead of it and its own, past the provider's in-flight cap, each round one answer
   *  time long) and its pace (the units the queued posts and its own will take, past the bucket's free units above
   *  CALLER_ROOM, at the provider's refill). Free budget alone
   *  ranked daybreak first while its queue was longest: at c780282 a cold dozen's reads waited 68.7 s in all in
   *  daybreak's queue against 12.1 s of its pace, and the slowest tape took 16.7 s. */
  const waitOf = (u: string, calls: number, headers: boolean): number => {
    const batch = BATCH_SIZE[u] ?? 10;
    const posts = Math.ceil(Math.max(calls, 1) / batch) * (headers ? 2 : 1);
    const q = inflight.get(u);
    const p = holds.paceOf(u);
    const cap = p?.inflight ?? INFLIGHT_MAX;
    // a foreground read waits behind the posts out and the foreground ones queued only (slot)
    const fg = fgNow();
    const before = (q?.queue ?? []).filter((x) => !fg || x.fg);
    const ahead = (q?.n ?? 0) + before.length;
    const lat = latencyOf(u);
    const queued = Math.floor((ahead + posts - 1) / cap) * lat;
    if (p === undefined) return queued + lat;
    const units = before.reduce((a, x) => a + (p.unit === "post" ? 1 : x.calls), 0) + (p.unit === "post" ? posts : Math.max(calls, 1) * (headers ? 2 : 1));
    const short = units - Math.max(0, holds.room(u) * p.burst - p.burst * CALLER_ROOM);
    return Math.max(queued, short > 0 ? (short * 1000) / p.perS : 0) + lat;
  };
  /** Providers in the order to ask them (card helper-robinhood-capacity fold 2, fold 4): the wide ones (WIDE_SPAN) first
   *  for a read of a block range, then by expected wait (waitOf: a header-timed provider's logs cost a second post, for
   *  their headers), the shortest first, then by free budget, the most first, so the walks share the wide providers, one
   *  whose queue is longer than another's pace wait goes second, and a 100-block one (drpc) is the last resort; ties
   *  take turns, so a dozen walks starting on full buckets do not all start on the same two. A read that names no block
   *  range (an eth_call, a receipt, a sender) is ranked by expected wait and free budget alone (wideFirst false). */
  let turn = 0;
  const ranked = (urls: readonly string[], wideFirst = true, calls = 1): string[] => {
    const t = turn++;
    const n = Math.max(urls.length, 1);
    const key = (u: string, i: number): number[] => {
      // a read of a block range is `calls` reads of V.span blocks: a wide provider joins them up to its span (logsOf)
      const span = wideFirst ? Math.max(WIDE_SPAN[u] ?? V.span, V.span) : V.span;
      return [
        wideFirst && span > V.span ? 1 : 0,
        -Math.round(waitOf(u, Math.ceil(calls / Math.floor(span / V.span)), wideFirst && headerTimed.has(u)) / WAIT_GRAIN_MS),
        Math.round(free(u)),
        -((i - (t % n) + n) % n),
      ];
    };
    return urls
      .map((u, i) => ({ u, k: key(u, i) }))
      .sort((a, b) => b.k[0]! - a.k[0]! || b.k[1]! - a.k[1]! || b.k[2]! - a.k[2]! || b.k[3]! - a.k[3]!)
      .map((x) => x.u);
  };

  /** The block both providers have, and its time: the newest block of the two heads (the second highest of three when
   *  the first two differ by more than LAG_MAX), with the providers that have it. Null when it cannot be read. */
  // one agreed head per HEAD_SHARE_MS, shared by every first read and discovery of the chain that asks within it (card
  // helper-robinhood-capacity fold 3: a dozen cold tapes read a dozen heads, two or three providers each); a tick
  // (`fresh`) always reads its own, the newest, and leaves it for them
  let headShared: { at: number; p: Promise<{ n: number; t: number; with: string[] } | null>; lane: Lane } | null = null;
  function agreedHead(fresh = false): Promise<{ n: number; t: number; with: string[] } | null> {
    if (!fresh && headShared !== null && now() - headShared.at < HEAD_SHARE_MS) return join(headShared.lane), headShared.p;
    const lane = sharedLane();
    const p = lanes.run(lane, agreedHeadNow);
    const mine = { at: now(), p, lane };
    headShared = mine;
    // a head not read is not kept: the next asks again
    void p.then((h) => {
      if (h === null && headShared === mine) headShared = null;
    });
    return p;
  }
  async function agreedHeadNow(): Promise<{ n: number; t: number; with: string[] } | null> {
    const heads = new Map<string, { n: number; t: number }>();
    const read = async (urls: string[], patient = false) => {
      await Promise.all(
        urls.map(async (u) => {
          const r = await batchTo(u, [{ method: "eth_getBlockByNumber", params: ["latest", false] }], patient);
          const b = r?.[0]?.ok ? obj(r[0].result) : {};
          const [n, t] = [hexInt(b.number), hexInt(b.timestamp)];
          if (n !== null && t !== null) heads.set(u, { n, t });
        }),
      );
    };
    const ok = ranked(usable(rpcs));
    // a provider still out after HEDGE_MS is left to answer while the next is asked; before the patient round every
    // read out is waited for (each bounded by TIMEOUT_MS), so its answer still counts
    const reads: Promise<void>[] = [];
    const go = (urls: string[]) => (reads.push(read(urls)), hedged(reads.at(-1)!, urls));
    // two heads within V.lagMax of each other are in hand
    const pair = (): boolean => {
      const ns = [...heads.values()].map((h) => h.n).sort((a, b) => b - a);
      return ns.some((n, i) => i > 0 && ns[i - 1]! - n <= V.lagMax);
    };
    await go(ok.slice(0, 2));
    // the whole ranked list is walked, one more at a time, until a pair is in hand or the list is spent (card
    // evm-rpc-spare-list: with Base's first two providers down the third answered, the patient round asked the first two
    // again and the fourth never, so no head was read and every read of the chain stopped)
    for (let i = 2; i < ok.length && !pair(); i++) await go(ok.slice(i, i + 1));
    if (heads.size < 2) await Promise.all(reads);
    // no two heads within the pace's wait, the whole list asked: those that passed a read at their pace's wait read again,
    // patiently (a provider not yet asked has been, above)
    if (heads.size < 2) await read(ok.filter((u) => !heads.has(u)).slice(0, 2), true);
    const sorted = [...heads].sort((a, b) => b[1].n - a[1].n);
    if (sorted.length < 2) return null;
    const agreed = sorted[1]![1].n; // the newest block at least two providers have
    const withIt = sorted.filter(([, h]) => h.n >= agreed).map(([u]) => u);
    return { n: agreed, t: sorted[1]![1].t, with: withIt };
  }

  /** The providers to ask, in order (ranked): those of `urls` not held, then any other of ours alike (a provider held
   *  since the head was read, or lags, is made up for by the next); agreed stops at PROVIDERS_MAX that answered. None
   *  in `skip` (a log read's: LOGS_REFUSED). */
  const askOrder = (urls: readonly string[], wideFirst: boolean, calls = 1, only = false, skip?: ReadonlySet<string>): string[] => {
    const can = (u: string) => skip === undefined || !skip.has(u);
    const have = ranked(usable(urls).filter(can), wideFirst, calls);
    return only ? have : [...new Set([...have, ...ranked(usable(rpcs).filter((u) => can(u) && !have.includes(u)), wideFirst, calls)])];
  };

  /** Asks `urls` the same `n` requests, two at once and then one more at a time while some answer has no two alike.
   *  Returns each request's answer that two providers gave alike (`same` says what alike is), else null. Each next one,
   *  of the rest and the wide ones (WIDE_SPAN) of the first two (a read past its pace's or queue's wait or held answers
   *  nothing at once), is ranked when it is asked, by expected answer time with the requests still left (fold 4). */
  async function agreed<A>(urls: readonly string[], n: number, ask: (u: string, idx: number[], patient: boolean) => Promise<(A | null)[]>, same: (a: A, b: A) => boolean, wideFirst = true, only = false, skip?: ReadonlySet<string>): Promise<(A | null)[]> {
    // `only`: none but `urls` (the index's chain-wide read, which the others refuse); `skip`: never these
    const order = askOrder(urls, wideFirst, n, only, skip);
    const passedBefore = new Map(order.map((u) => [u, paced.get(u) ?? 0]));
    const got: A[][] = Array.from({ length: n }, () => []);
    const by: Set<string>[] = Array.from({ length: n }, () => new Set());
    // the providers that answered something: PROVIDERS_MAX of them at most (a read past its pace's wait or held answers
    // nothing, and the next is asked instead; fold 4: capping the asks left drpc out while daybreak's queue held tapes)
    const answered = new Set<string>();
    const run = async (u: string, idx: number[], patient = false) => {
      const r = await ask(u, idx, patient);
      idx.forEach((i, k) => {
        if (r[k] != null) got[i]!.push(r[k]!), by[i]!.add(u), answered.add(u);
      });
    };
    const pick = (i: number): A | null => {
      const g = got[i]!;
      for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) if (same(g[a]!, g[b]!)) return g[a]!;
      return null;
    };
    const all = Array.from({ length: n }, (_, i) => i);
    // the reads out: one still out after HEDGE_MS is left to answer while the next provider is asked (a provider that
    // hangs costs a read HEDGE_MS, never TIMEOUT_MS); before the patient round every read out is waited for (each
    // bounded by TIMEOUT_MS), so its answer still counts
    const reads = new Set<Promise<void>>();
    const launch = (u: string, idx: number[]): Promise<void> => {
      const p: Promise<void> = run(u, idx).finally(() => reads.delete(p));
      reads.add(p);
      return p;
    };
    await hedged(Promise.all(order.slice(0, 2).map((u) => launch(u, all))), order.slice(0, 2));
    const wide = (u: string) => (WIDE_SPAN[u] ?? 0) > V.span;
    const rest = order.slice(2);
    // the next one is ranked when it is asked, not when the read began: a dozen tapes ranked at once saw no queue yet,
    // and all asked daybreak next, 37 slow posts in its 3 slots (fold 4)
    const tier = [...rest, ...order.slice(0, 2).filter(wide)];
    while (tier.length > 0 && answered.size < PROVIDERS_MAX && !all.every((i) => pick(i) !== null)) {
      const want = all.filter((i) => pick(i) === null);
      const u = ranked(tier, wideFirst, want.length)[0]!;
      tier.splice(tier.indexOf(u), 1);
      const left = want.filter((i) => !by[i]!.has(u));
      if (left.length > 0) await hedged(launch(u, left), [u]);
    }
    if (!all.every((i) => pick(i) !== null)) await Promise.all(reads);
    // a request still without two alike answers: asked again, patiently, of each provider (not held) that passed a read
    // at its pace's wait meanwhile, so a read fails on a refusal or a disagreement, never on the pace alone (card
    // helper-robinhood-capacity fold 3: on the loaded box every bucket spent at once left 1 or 2 of 12 cold tokens no
    // pair, 503)
    for (const u of order) {
      if (all.every((i) => pick(i) !== null)) break;
      const left = all.filter((i) => pick(i) === null && !by[i]!.has(u));
      if (left.length > 0 && holds.heldFor(u) === 0 && (paced.get(u) ?? 0) > passedBefore.get(u)!) await run(u, left, true);
    }
    return all.map(pick);
  }

  /** Each filter's logs as `u` answers them, null where it did not. A provider that takes wider ranges (WIDE_SPAN) is
   *  asked fewer, wider reads: a run of the same filter over adjacent ranges is joined up to its span, and the answer
   *  split back by block, so each filter is still compared with the other provider's answer for that range alone. */
  async function logsOf(u: string, fs: Record<string, unknown>[], patient = false): Promise<(Log[] | null)[]> {
    const max = WIDE_SPAN[u] ?? V.span;
    const at = (f: Record<string, unknown>): [number, number] => [hexInt(f.fromBlock) ?? -1, hexInt(f.toBlock) ?? -1];
    const rest = (f: Record<string, unknown>) => JSON.stringify({ ...f, fromBlock: null, toBlock: null });
    const groups: { f: Record<string, unknown>; from: number; to: number; of: number[] }[] = [];
    fs.forEach((f, i) => {
      const [from, to] = at(f);
      const g = groups.at(-1);
      if (g !== undefined && from >= 0 && to >= from && rest(g.f) === rest(f) && from === g.to + 1 && to - g.from + 1 <= (f.address === undefined ? Math.min(max, INDEX_JOIN_MAX) : max)) (g.to = to), g.of.push(i);
      else groups.push({ f, from, to, of: [i] });
    });
    const r = await batchTo(u, groups.map((g) => ({ method: "eth_getLogs", params: [g.of.length === 1 ? g.f : { ...g.f, fromBlock: `0x${g.from.toString(16)}`, toBlock: `0x${g.to.toString(16)}` }] })), patient);
    const out: (Log[] | null)[] = fs.map(() => null);
    groups.forEach((g, k) => {
      const logs = r?.[k]?.ok ? parseLogs((r[k] as { result: unknown }).result) : null;
      if (logs === null) return;
      for (const i of g.of) {
        const [from, to] = at(fs[i]!);
        out[i] = logs.filter((l) => l.block >= from && l.block <= to);
      }
    });
    return out;
  }

  /** For each filter, its logs when two providers return the same ones; null where they do not agree. */
  function agreedLogs(urls: readonly string[], filters: Record<string, unknown>[], only = false): Promise<(Log[] | null)[]> {
    return agreed<Log[]>(
      urls,
      filters.length,
      async (u, idx, patient) => {
        const got = await logsOf(u, idx.map((i) => filters[i]!), patient);
        return headerTimed.has(u) ? timedByHeaders(u, got, patient) : got;
      },
      (a, b) => sameLogs(a, b, true),
      true,
      only,
      LOGS_REFUSED,
    );
  }

  /** A header-timed provider's logs (it logs no block time) timed by its own headers of their blocks; an answer with a
   *  block it gives no time for is no answer. Its times count only where another provider logged the same (agreedLogs'
   *  sameLogs with times), so a header for the wrong block or a 0 is no agreement. */
  async function timedByHeaders(u: string, got: (Log[] | null)[], patient = false): Promise<(Log[] | null)[]> {
    const blocks = [...new Set(got.flatMap((g) => (g ?? []).map((l) => l.block)))];
    if (blocks.length === 0) return got;
    const r = await batchTo(u, blocks.map((n) => ({ method: "eth_getBlockByNumber", params: [`0x${n.toString(16)}`, false] })), patient);
    const times = new Map<number, number>();
    blocks.forEach((n, i) => {
      const b = r?.[i]?.ok ? obj((r[i] as { result: unknown }).result) : {};
      const t = hexInt(b.timestamp);
      if (t !== null) times.set(n, t); // checked as any logged time is: alike with another provider's, never 0 (apply)
    });
    return got.map((g) => (g === null || g.some((l) => !times.has(l.block)) ? null : g.map((l) => ({ ...l, t: times.get(l.block)! }))));
  }

  /** One filter's logs over blocks `from` to `to`, read in spans the providers take: null when any span is not agreed.
   *  The filters of the swap events the chain's index holds (index.ts) are answered from it up to its newest block, and
   *  only the blocks after that are read for this filter alone, never waiting on the index's next read (a tape's head
   *  is newer than the index's by up to INDEX_FOLLOW_MS, and the index's catch-up under a crowd took 2 s a read,
   *  2026-11-05 02:36Z); the index's first read, when nothing is held yet, is every caller's. The other filters (a hook's
   *  transfers), and a range behind the index, are read for this filter alone (card helper-robinhood-capacity fold 6). */
  async function agreedRange(urls: readonly string[], filter: (lo: number, hi: number) => Record<string, unknown> | Record<string, unknown>[], from: number, to: number): Promise<Log[] | null> {
    if (index === null || from > to) return agreedRangeOwn(urls, filter, from, to);
    const fs = [filter(from, to)].flat();
    const held = fs.filter((f) => index.indexes(f));
    if (held.length === 0) return agreedRangeOwn(urls, filter, from, to);
    // nothing held yet: the index's read in flight (or one started now) is waited for INDEX_WAIT_MS at most, then the
    // blocks are this read's own
    if (index.range() === null) await within(index.upTo(to), INDEX_WAIT_MS);
    const r = index.range();
    if (r === null || from < r.from || r.to < from) return agreedRangeOwn(urls, filter, from, to);
    const top = Math.min(to, r.to);
    const got = held.flatMap((f) => index.query(f, from, top));
    const [ahead, rest] = await Promise.all([
      top < to ? agreedRangeOwn(urls, (lo, hi) => [filter(lo, hi)].flat().filter((f) => index.indexes(f)), top + 1, to) : [],
      held.length < fs.length ? agreedRangeOwn(urls, (lo, hi) => [filter(lo, hi)].flat().filter((f) => !index.indexes(f)), from, to) : [],
    ]);
    if (ahead === null || rest === null) return null;
    return [...got, ...ahead, ...rest].sort((a, b) => a.block - b.block || a.index - b.index);
  }
  async function agreedRangeOwn(urls: readonly string[], filter: (lo: number, hi: number) => Record<string, unknown> | Record<string, unknown>[], from: number, to: number, only = false): Promise<Log[] | null> {
    // each filter's spans one after another, so a wide provider joins them (logsOf); the logs back in block order
    const per = spans(from, to).map(([lo, hi]) => [filter(lo, hi)].flat());
    const parts = await agreedLogs(urls, per.length === 0 ? [] : per[0]!.flatMap((_, k) => per.map((fs) => fs[k]!)), only);
    return parts.some((x) => x == null) ? null : (parts as Log[][]).flat().sort((a, b) => a.block - b.block || a.index - b.index);
  }

  /** The same `eth_call`s at block `n`: each result two providers gave alike, else undefined. A call at a mined block
   *  never answers otherwise, so each agreed one is kept by (to, data, block) (`called`, at most CALLED_MAX, oldest out
   *  first) and every tape and tick asks it once (card helper-robinhood-capacity fold 5). */
  /** `missed`, when given, is set once a call is not agreed: undefined is both a revert (an answer: the contract has no
   *  such function) and a call no two providers answered alike (no answer), and a discovery must tell them apart (card
   *  helper-restart-fresh: a read that fails is never kept as "no pool"). */
  async function callsAgreed(n: number, calls: { to: string; data: string }[], missed?: { any: boolean }): Promise<(string | undefined)[]> {
    const key = (c: { to: string; data: string }) => `${c.to.toLowerCase()} ${c.data.toLowerCase()} ${n}`;
    const out: (string | undefined)[] = calls.map((c) => called.get(key(c)));
    const ask = [...new Set(calls.filter((_, i) => out[i] === undefined).map(key))].map((k) => calls.find((c) => key(c) === k)!);
    if (ask.length === 0) return out;
    const got = await agreed<string>(
      rpcs,
      ask.length,
      async (u, idx, patient) => {
        const r = await batchTo(u, idx.map((i) => ({ method: "eth_call", params: [ask[i], `0x${n.toString(16)}`] })), patient);
        // a revert is the call's answer, alike between providers, so a call that reverts is agreed by two as a result is,
        // never asked of every provider and again patiently (fold 9: a discovery's factory() of six transfer addresses,
        // routers among them, took 9.1 to 13.9 s of 12 cold tapes at once, 06:25Z)
        return idx.map((_, k) => {
          const x = r?.[k];
          if (x?.ok) return typeof x.result === "string" ? x.result.toLowerCase() : null;
          return x?.reverted === true ? REVERTED : null;
        });
      },
      (a, b) => a === b,
      false,
    );
    ask.forEach((c, i) => {
      const x = got[i];
      if (x == null) return;
      if (called.size >= CALLED_MAX) called.delete(called.keys().next().value!);
      called.set(key(c), x);
    });
    return calls.map((c) => {
      const x = called.get(key(c));
      if (x === undefined && missed !== undefined) missed.any = true;
      return x === REVERTED ? undefined : x;
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // The main pool
  // -------------------------------------------------------------------------------------------------------------

  type Found = { pool: Pool; decimals: number; seed?: { from: number; to: number; headN: number; logs: Log[] } };
  const pools = new Map<string, { found: { pool: Pool; decimals: number } | null; at: number }>(); // a token's main pool, kept
  // pools known from the start (a test's): kept as if just found
  for (const [t, f] of deps.pools ?? []) pools.set(t, { found: f, at: now() });
  const NONE_MS = 300_000; // a token with no pool read is looked for again after this
  const resolving = new Map<string, Promise<Found | null>>();
  /** Each pool search's lane, which a foreground open that joins it lifts (join). */
  const resolvingLane = new Map<string, Lane>();
  const pad32 = (a: string) => a.slice(2).padStart(64, "0");

  const wordAddr = (r: string | undefined, i = 0): string | null => (r !== undefined && /^0x([0-9a-f]{64})+$/.test(r) && r.length >= 2 + 64 * (i + 1) ? `0x${r.slice(2 + 64 * i + 24, 2 + 64 * (i + 1))}` : null);

  /** A pool's quote by the other token: USD, or ETH (WETH, or native ETH where `native`). */
  const quoteOf = (other: string, native: boolean): Pool["quote"] | null =>
    other === V.usd ? { kind: "usd", decimals: 6 } : other === V.weth || (native && other === ZERO) ? { kind: "eth", decimals: 18 } : null;
  /** A v2 or v3 pool of the token: its factory one of the chain's venues, the token one of its two, quoted in USD or WETH. */
  function pairPool(token: string, a: string, factory: string | undefined, token0: string | undefined, token1: string | undefined): Pool | null {
    const [f, t0, t1] = [wordAddr(factory), wordAddr(token0), wordAddr(token1)];
    if (f === null || t0 === null || t1 === null || !(V.v2.includes(f) || V.v3.includes(f))) return null;
    const tokenIs0 = t0 === token;
    if (!tokenIs0 && t1 !== token) return null;
    const quote = quoteOf(tokenIs0 ? t1 : t0, false);
    return quote === null ? null : { venue: V.v2.includes(f) ? "v2" : "v3", id: a, token, tokenIs0, quote };
  }
  /** A v2 or v3 candidate of the token from its factory, two tokens and Venues.getPool parameter answers, with what its
   *  factory's getPool asks. */
  function pairCand(token: string, a: string, f: string | undefined, t0: string | undefined, t1: string | undefined, param: string | undefined): { pool: Pool; factory: string; t0: string; t1: string; param: string | undefined } | null {
    const c = pairPool(token, a, f, t0, t1);
    return c === null ? null : { pool: c, factory: wordAddr(f)!, t0: wordAddr(t0)!, t1: wordAddr(t1)!, param };
  }
  /** Each v2 or v3 candidate's getPool call: the factory's getPool(token0, token1, the pool's own Venues.getPool
   *  parameter), read at the same block as the parameter; null for a factory with no getPool kind of ours or a
   *  parameter not read. */
  const confirmCall = (c: { factory: string; t0: string; t1: string; param: string | undefined } | null): { to: string; data: string } | null => {
    const kind = c === null ? undefined : V.getPool[c.factory];
    if (c === null || kind === undefined || c.param === undefined || !/^0x[0-9a-f]{64}$/.test(c.param)) return null;
    return { to: c.factory, data: `${GET_POOL_SEL[kind]}${pad32(c.t0)}${pad32(c.t1)}${c.param.slice(2)}` };
  };
  /** Each v2 or v3 candidate once its factory names it, else null: the factory's getPool(token0, token1, the pool's
   *  own Venues.getPool parameter) must answer the pool, both read at block `n` on two agreeing providers (`named`:
   *  each candidate's getPool answer, from confirmCall). A factory with no getPool kind of ours names nothing. */
  const confirmed = (cands: ({ pool: Pool } | null)[], named: readonly (string | undefined)[]): (Pool | null)[] => cands.map((c, i) => (c !== null && wordAddr(named[i]) === c.pool.id ? c.pool : null));
  /** callsAgreed of each call given, undefined where none is. */
  async function callsSome(n: number, calls: ({ to: string; data: string } | null)[], missed?: { any: boolean }): Promise<(string | undefined)[]> {
    const live = calls.flatMap((c, i) => (c === null ? [] : [i]));
    const got = await callsAgreed(n, live.map((i) => calls[i]!), missed);
    const out: (string | undefined)[] = calls.map(() => undefined);
    live.forEach((i, k) => (out[i] = got[k]));
    return out;
  }
  /** A v4 pool of the token from a pool key that hashes to its id, quoted in USD or ETH, with its hook. */
  function v4Pool(token: string, id: string, k: string | undefined): Pool | null {
    if (k === undefined || !/^0x[0-9a-f]{320}$/.test(k) || keccakHex(k) !== id) return null;
    const [c0, c1] = [wordAddr(k, 0)!, wordAddr(k, 1)!];
    const tokenIs0 = c0 === token;
    if (!tokenIs0 && c1 !== token) return null;
    const quote = quoteOf(tokenIs0 ? c1 : c0, true);
    const hook = hookOf(k);
    return quote === null ? null : { venue: "v4", id, token, tokenIs0, quote, ...(hook === undefined ? {} : { hook }) };
  }
  /** The Pons curves the factories' records of the token name (a record of another token, or not live, names none). */
  const curvePools = (token: string, recs: readonly (string | undefined)[]): Pool[] =>
    recs.flatMap((r) => {
      if (r === undefined || !/^0x[0-9a-f]{960}$/.test(r) || wordAddr(r, 0) !== token || BigInt(`0x${r.slice(2 + 64 * 14)}`) !== 1n) return [];
      const [curve, pair] = [wordAddr(r, 1)!, wordAddr(r, 4)!];
      const quote = quoteOf(pair, true);
      return curve !== ZERO && quote !== null ? [{ venue: "curve" as const, id: curve, token, tokenIs0: false, quote }] : [];
    });
  const decimalsOf = (d: string | undefined): number | null => {
    const n = d !== undefined && /^0x[0-9a-f]{64}$/.test(d) ? Number(BigInt(d)) : NaN;
    return Number.isInteger(n) && n <= 77 ? n : null;
  };

  /**
   * A listed token's pool from its list's entry (card helper-robinhood-capacity fold 3): the pool the list names, taken
   * only once the chain says it is the token's, read at the agreed head on two agreeing providers in one round (a v4
   * id: the PositionManager's key, which must hash to it; an address: its factory and two tokens, a v2 or v3 venue of
   * ours, or the Pons factories' record naming it as the token's curve), with the token's decimals. Null when the chain
   * does not say so (a pool of no venue of ours, a v4 key the PositionManager does not hold): the token is discovered
   * as one in no list is. Its first read is the book's own (readBook), not the discovery's walks over every venue.
   */
  async function fromHint(token: string, hint: string): Promise<Found | null> {
    const head = await agreedHead();
    if (head === null) throw new Error("no agreed head");
    const id = /^0x[0-9a-f]{64}$/.test(hint);
    // first the token's decimals with the v4 key or the Pons records (a curve answers no factory, a revert), then, for an
    // address no record names, its factory and two tokens, its getPool parameter, and its factory's getPool
    const first: { to: string; data: string }[] = id ? [{ to: V.positionManager, data: `${SEL.poolKeys}${hint.slice(2, 2 + 50).padEnd(64, "0")}` }] : V.pons.map((f) => ({ to: f, data: `${SEL.launched}${pad32(token)}` }));
    const got = await callsAgreed(head.n, [{ to: token, data: SEL.decimals }, ...first]);
    const decimals = decimalsOf(got[0]);
    if (decimals === null) throw new Error("decimals not agreed");
    let pool = id ? v4Pool(token, hint, got[1]) : (curvePools(token, got.slice(1)).find((c) => c.id === hint) ?? null);
    if (pool === null && !id) {
      const [f, t0, t1] = await callsAgreed(head.n, [SEL.factory, SEL.token0, SEL.token1].map((data) => ({ to: hint, data })));
      const kind = V.getPool[wordAddr(f) ?? ""];
      const [param] = pairPool(token, hint, f, t0, t1) === null || kind === undefined ? [undefined] : await callsAgreed(head.n, [{ to: hint, data: PARAM_SEL[kind] }]);
      const c = pairCand(token, hint, f, t0, t1, param);
      const call = confirmCall(c);
      pool = call === null ? null : confirmed([c], await callsAgreed(head.n, [call]))[0]!;
    }
    return pool === null ? null : { pool, decimals };
  }

  /** The v4 pool ids the PoolManager's Swap logs name in the receipts of the token's latest PoolManager transactions,
   *  each with its fee and the addresses its transaction logged (one provider's receipts: v4Key and the PositionManager
   *  check every id against its key's hash). Asked of the provider expected to answer first (ranked: its answer time,
   *  queue and pace), never by free budget alone (card robinhood-cold-open-fast: pocket, the biggest bucket, took 3.4 s
   *  and 3.7 s for three receipts while the others answered in 0.3 s). */
  async function v4Seen(pmTxs: string[], missed: { any: boolean }): Promise<Map<string, { fee: number; around: Set<string> }>> {
    const seen = new Map<string, { fee: number; around: Set<string> }>();
    const n = Math.min(pmTxs.length, V4_TXS);
    // a provider that answers any receipt with an error or none is no answer: the next is asked, and with none read the
    // discovery sets `missed` (card helper-restart-fresh: the receipts unread, a v4 token was kept as "no pool")
    let read = false;
    for (const u of single(ranked(usable(rpcs), false, n), n)) {
      const r = await batchTo(u, pmTxs.slice(-V4_TXS).map((t) => ({ method: "eth_getTransactionReceipt", params: [t] })));
      if (r === null || !r.every((x) => x.ok && Array.isArray(obj(x.result).logs))) continue;
      read = true;
      for (const x of r) {
        const logs = (Array.isArray(obj(x.ok ? x.result : null).logs) ? (obj((x as { result: unknown }).result).logs as unknown[]) : []).map(parseLog).filter((l): l is Log => l !== null);
        for (const l of logs) {
          if (l.address !== V.poolManager || l.topics.length !== 3 || l.topics[0] !== TOPIC.swap4 || l.data.length !== 2 + 64 * 6) continue;
          const e = seen.get(l.topics[1]!) ?? { fee: Number(BigInt(`0x${l.data.slice(2 + 64 * 5)}`)), around: new Set<string>() };
          for (const o of logs) e.around.add(o.address);
          seen.set(l.topics[1]!, e);
        }
      }
      break;
    }
    if (!read) missed.any = true;
    return seen;
  }

  async function findPool(token: string): Promise<Found | null> {
    const head = await agreedHead();
    if (head === null) throw new Error("no agreed head");
    // each read is asked with every other no answer it waits for names, and no read more (card
    // helper-robinhood-search-ahead: a lone cold token's discovery took 9 answer times, now 7; asking every address's
    // getPool parameters with its factory cost more calls than the round saved, and under the paces 12 at once were
    // slower): the transfers; the factories with the v4 receipts, the token's decimals and the Pons records; a venue
    // pool's two tokens with its parameter; the getPools with the v4 keys; the swaps with the ETH price.
    // The token's transfers newest first, a step at a time, until a tape's worth or the cold window [design: twice
    // TRADES_MAX transfers, since a swap through a router moves the token twice, pool to router to trader]
    const tw = await walk(head.with, (lo, hi) => ({ address: token, topics: [TOPIC.transfer], fromBlock: `0x${lo.toString(16)}`, toBlock: `0x${hi.toString(16)}` }), head.n, 2 * TRADES_MAX, (part) => part.length);
    if (tw == null) throw new Error("transfers not agreed");
    let from = tw.from;
    const tlogs = tw.logs;
    // who held and moved the token, and the PoolManager's latest transactions
    const count = new Map<string, number>();
    const pmTxs: string[] = [];
    for (const l of tlogs) {
      if (l.address !== token || l.topics.length !== 3 || l.data.length !== 66) continue;
      for (const w of [l.topics[1]!, l.topics[2]!]) {
        const a = addrOf(w.slice(2));
        if (a !== ZERO && a !== token) count.set(a, (count.get(a) ?? 0) + 1);
        if (a === V.poolManager && !pmTxs.includes(l.tx)) pmTxs.push(l.tx);
      }
    }
    const top = [...count].filter(([a]) => a !== V.poolManager).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, CANDIDATES_MAX).map(([a]) => a);
    const cands: Pool[] = [];
    // v2, v3 and Slipstream pools: the factory of each address, then the two tokens and the getPool parameter of those
    // of a listed venue, read at the agreed block. v4 pools: the pool ids the PoolManager's recent swaps in the token's
    // transactions name, from their receipts, read with the factories
    // (the token's decimals and the Pons records with them: asked with the transfers' walk, they made its providers look
    // busy, and drpc, 100 blocks a read, took 45 reads of logs to the wide providers' 100; swaps-pace.test.ts fold 2)
    // a candidate read that no two providers agreed (or no provider's receipts) leaves the search unfinished: with no
    // pool found it is no answer, never kept as "no pool" (card helper-restart-fresh: after a restart the providers are
    // busy with every listed token's search, and a token whose reads failed was served an empty chart and tape for
    // NONE_MS)
    const missed = { any: false };
    const [factories, seen, own] = await Promise.all([
      callsAgreed(head.n, top.map((a) => ({ to: a, data: SEL.factory })), missed),
      pmTxs.length > 0 ? v4Seen(pmTxs, missed) : Promise.resolve(new Map<string, { fee: number; around: Set<string> }>()),
      callsAgreed(head.n, [{ to: token, data: SEL.decimals }, ...V.pons.map((f) => ({ to: f, data: `${SEL.launched}${pad32(token)}` }))]),
    ]);
    // a record not read is no answer: never kept as "no pool" (a token with none answers the empty record)
    const recs = own.slice(1);
    if (recs.some((r) => r === undefined)) throw new Error("pons records not agreed");
    const ofVenue = top.flatMap((a, i) => {
      const f = wordAddr(factories[i]);
      return f !== null && (V.v2.includes(f) || V.v3.includes(f)) ? [{ a, f: factories[i], kind: V.getPool[f] }] : [];
    });
    const per = ofVenue.map((v) => [SEL.token0, SEL.token1, ...(v.kind === undefined ? [] : [PARAM_SEL[v.kind]])].map((data) => ({ to: v.a, data })));
    const pairs = await callsAgreed(head.n, per.flat(), missed);
    let at = 0;
    const paired = ofVenue.map((v, i) => {
      const r = pairs.slice(at, (at += per[i]!.length));
      return pairCand(token, v.a, v.f, r[0], r[1], r[2]);
    });
    // each candidate's factory must name it (confirmed); a v4 pool's key is the PositionManager's own record of it when
    // there is one, and a pool made without it (Doppler, Zora) has its key worked out from the swap's own fee and the
    // addresses in its transaction (v4Key). Either way the key must hash to the id. Both read in one round
    const list = [...seen.keys()].slice(0, CANDIDATES_MAX);
    const answers = await callsSome(head.n, [...paired.map(confirmCall), ...list.map((id) => ({ to: V.positionManager, data: `${SEL.poolKeys}${id.slice(2, 2 + 50).padEnd(64, "0")}` }))], missed);
    for (const c of confirmed(paired, answers.slice(0, paired.length))) if (c !== null) cands.push(c);
    const keys = answers.slice(paired.length);
    for (const [i, id] of list.entries()) {
      const e = seen.get(id)!;
      // the PositionManager's key when it hashes to the id: that is the pool, whatever it pairs (a route's other hop, or
      // the token against a quote of no venue of ours), and no search finds another (card robinhood-cold-open-fast: those
      // misses searched seconds each); else one worked out from the swap (it must hash to the id), the event loop let run
      const k = keys[i];
      const c = k !== undefined && /^0x[0-9a-f]{320}$/.test(k) && keccakHex(k) === id ? v4Pool(token, id, k) : v4Pool(token, id, (await v4KeySliced(id, token, e.fee, [...e.around], chain)) ?? undefined);
      if (c !== null) cands.push(c);
    }
    // a Pons curve: the factory's own record of the token names its curve and its quote (zero: native ETH)
    cands.push(...curvePools(token, recs));
    if (cands.length === 0) {
      if (missed.any) throw new Error("pools not read");
      return null;
    }
    // the pool with most swaps in the window is the main pool (ties: the lower id); its logs are the book's first read
    const d = own[0];
    const [swaps, refOk] = await Promise.all([
      Promise.all(cands.map((c) => agreedRange(head.with, (lo, hi) => poolFilters(c, lo, hi, chain), from, head.n))),
      cands.some((c) => c.quote.kind === "eth") ? readRef(head.with, head.n, from) : Promise.resolve(true),
    ]);
    const score = cands.map((c, i) => (swaps[i] == null ? -1 : swaps[i]!.filter((l) => decodeSwap(c, l, chain) !== null).length));
    if (score.every((x) => x < 0)) throw new Error("swaps not agreed");
    // a candidate whose swaps went unread may be the main pool: no "no pool" from the rest
    if (score.some((x) => x < 0)) missed.any = true;
    const best = cands.map((c, i) => ({ c, i, n: score[i]! })).sort((x, y) => y.n - x.n || (x.c.id < y.c.id ? -1 : 1))[0]!;
    // no swap in the window on the pools found: "no pool" only when no candidate went unread
    if (best.n <= 0 && from === head.n - V.cold + 1) {
      if (missed.any) throw new Error("pools not read");
      return null;
    }
    // a hooked v4 pool reads the token's other v4 pools' swaps with its own (Pool.siblings), so hookTakes counts a
    // sender's swaps of the token in all of them; their swaps already read join the first read's logs
    const siblings = best.c.venue === "v4" && best.c.hook !== undefined ? cands.filter((c) => c.venue === "v4" && c.id !== best.c.id).map((c) => c.id) : [];
    if (siblings.length > 0) best.c = { ...best.c, siblings };
    const sib = new Set(siblings);
    const fromSiblings = cands.flatMap((c, i) => (sib.has(c.id) ? (swaps[i] ?? []).filter((l) => l.topics[0] === TOPIC.swap4 && l.topics[1] === c.id) : []));
    // the main pool's swaps further back, while the tape is short of TRADES_MAX and the cold window not read
    let logs = fromSiblings.length === 0 ? swaps[best.i]! : [...swaps[best.i]!, ...fromSiblings].sort((a, b) => a.block - b.block || a.index - b.index);
    let n = best.n;
    if (n < TRADES_MAX && from > head.n - V.cold + 1) {
      const w = await walk(head.with, (lo, hi) => poolFilters(best.c, lo, hi, chain), from - 1, TRADES_MAX - n, (part) => part.filter((l) => decodeSwap(best.c, l, chain) !== null).length, head.n - V.cold + 1);
      if (w == null) throw new Error("swaps not agreed");
      logs = w.logs.concat(logs);
      n += w.logs.filter((l) => decodeSwap(best.c, l, chain) !== null).length;
      from = w.from;
    }
    if (n <= 0) {
      if (missed.any) throw new Error("pools not read");
      return null;
    }
    const ref = best.c.quote.kind === "eth" ? await readRef(head.with, head.n, from) : true;
    const decimals = decimalsOf(d);
    if (decimals === null) throw new Error("decimals not agreed");
    return { pool: best.c, decimals, seed: (refOk && ref) || best.c.quote.kind !== "eth" ? { from, to: head.n, headN: head.n, logs } : undefined };
  }

  /** A listed token's main pool, null when our reads find none (served as an empty chart), "unlisted" off the lists. */
  async function mainPool(token: string): Promise<Found | null | "unlisted"> {
    const kept = pools.get(token);
    if (kept !== undefined && kept.found !== null && now() - kept.at < POOL_KEEP_MS) return { ...kept.found };
    if (!(await deps.listed(token))) return "unlisted";
    if (kept !== undefined && kept.found === null && now() - kept.at < NONE_MS) return null;
    let p = resolving.get(token);
    if (p !== undefined) join(resolvingLane.get(token)!);
    else {
      // the list's pool, checked on chain, else the discovery a token in no list has
      const lane = sharedLane();
      p = lanes
        .run(lane, async () => {
          const hint = (await deps.hint?.(token)) ?? null;
          return (hint !== null ? await fromHint(token, hint) : null) ?? findPool(token);
        })
        .finally(() => (resolving.delete(token), resolvingLane.delete(token)));
      resolving.set(token, p);
      resolvingLane.set(token, lane);
    }
    const found = await p;
    if (pools.size >= POOLS_MAX) pools.delete(pools.keys().next().value!);
    pools.set(token, { found: found === null ? null : { pool: found.pool, decimals: found.decimals }, at: now() });
    return found;
  }

  /** The lists' tokens whose pool is not kept, looked for as the lists load (ahead), AHEAD_AT_ONCE at a time; none
   *  starts while a first open waits for its pool (`opening`), so a caller's reads find the providers' paces as free as
   *  before. Each goes through mainPool, so an open meanwhile joins its read, and what it finds is kept as an open's is
   *  (card helper-robinhood-search-ahead: at 38249ca a listed token whose listed pool the helper cannot read was looked
   *  for only at its first open, and 4 of 12 such tapes opened at once took 9 to 15.5 s). Nor does one start before two
   *  providers that batch (single) are free to agree a caller's read: not held, each with AHEAD_ROOM of its bucket or
   *  more (a provider with no pace counts as full). Without that wait, a fresh helper's search of the lists' ~58 tokens
   *  spent the buckets the opens drew on: 12 pinned tapes opened 60 s after the lists loaded answered 7 x 503 at 9.6 s,
   *  and on the next run p50 10.6 s, where opened at once with no search running they took 4.4 s at most (2026-11-05
   *  08:2xZ, the Mac). [design: 2 at once, so a first open that comes mid-search shares the providers with two searches
   *  at most; three quarters of a bucket, so the room a search starts with is the callers' quarter (CALLER_ROOM) and
   *  half a bucket more; read again every AHEAD_WAIT_MS.] */
  const AHEAD_AT_ONCE = 2;
  const AHEAD_ROOM = 0.75;
  const AHEAD_WAIT_MS = 500;
  const roomy = (): boolean => single(usable(rpcs), 2).filter((u) => !LOGS_REFUSED.has(u) && holds.room(u) >= AHEAD_ROOM).length >= 2;
  const aheadQueue = new Set<string>();
  let aheadRun: Promise<void> | null = null;
  let opening = 0;
  const idle: (() => void)[] = [];
  const known = (t: string): boolean => {
    const kept = pools.get(t);
    return kept !== undefined && now() - kept.at < (kept.found === null ? NONE_MS : POOL_KEEP_MS);
  };
  function ahead(tokens: readonly string[]): Promise<void> {
    for (const x of tokens) {
      const t = evmAddress(x);
      if (t !== null && !known(t) && !resolving.has(t) && aheadQueue.size < POOLS_MAX) aheadQueue.add(t);
    }
    if (aheadRun === null && aheadQueue.size > 0) {
      const one = async (): Promise<void> => {
        for (;;) {
          for (;;) {
            if (opening > 0) await new Promise<void>((go) => idle.push(go));
            else if (aheadQueue.size > 0 && !roomy()) await new Promise((go) => setTimeout(go, AHEAD_WAIT_MS));
            else break;
          }
          const t = aheadQueue.values().next().value;
          if (t === undefined) return;
          aheadQueue.delete(t);
          // a read that fails is no answer: the token is looked for again at its first open or the lists' next load
          if (!known(t)) await mainPool(t).catch(() => undefined);
        }
      };
      // the helper's own search: background, whatever lane asked for it (a lists answer built inside a caller's read)
      aheadRun = lanes.run(newLane(false), () => Promise.all(Array.from({ length: AHEAD_AT_ONCE }, one))).then(() => undefined).finally(() => (aheadRun = null));
    }
    return aheadRun ?? Promise.resolve();
  }

  // -------------------------------------------------------------------------------------------------------------
  // The books
  // -------------------------------------------------------------------------------------------------------------

  type Entry = { pool: Pool; decimals: number; book: Book; touched: number; readAt: number | null; headN: number; first?: Promise<void> };
  const books = new Map<string, Entry>();
  // the ETH price: its swaps over the blocks the books need
  let refEvents: Ref[] = [];
  let refTo: number | null = null;
  let refFrom: number | null = null; // the earliest block the ETH price is read from
  let refLock: Promise<unknown> = Promise.resolve();
  /** Each transaction's traders (index.ts txTraders), by hash; a swap's is traderAt its log index. */
  const traders = new Map<string, Traders>();
  /** Agreed `eth_call` results by (to, data, block) (callsAgreed): a call at a mined block never answers otherwise, so
   *  each is read once and shared by every tape and tick (fold 5). */
  const called = new Map<string, string>();
  /** The chain's swaps, read chain-wide once for every tape, tick and list (index.ts, fold 6), over the blocks a tape
   *  and its ETH price read; null on a chain with no two providers that take a filter with no address (INDEX_RPCS). */
  const index: SwapIndex | null =
    deps.index === undefined || deps.index.length < 2
      ? null
      : createSwapIndex({
          topics: INDEX_TOPICS,
          read: (lo, hi) => agreedRangeOwn(deps.index!, (a, b) => ({ topics: [INDEX_TOPICS], fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }), lo, hi, true),
          window: V.cold + V.refBack + INDEX_SLACK,
          chunk: 1_000,
        });
  /** The index read up to the agreed head: at boot the newest window (readiness does not wait on it), then every
   *  INDEX_FOLLOW_MS the blocks since, one read for every caller (upTo). */
  async function follow(): Promise<boolean> {
    if (index === null) return false;
    const head = await agreedHead(true); // the newest, left for the tapes as a tick's is
    return head !== null && (await index.upTo(head.n));
  }
  let follower: ReturnType<typeof setInterval> | null = null;
  if (index !== null && deps.tickMs !== 0) {
    void follow();
    follower = setInterval(() => void follow(), INDEX_FOLLOW_MS);
    follower.unref();
  }

  /** Reads the ETH price pool's swaps up to `to`, and back to refBack before `need` (the earliest block a book reads:
   *  a book walked back further than any before has the blocks before what is held read first). One read at a time. */
  // the ETH price read running or queued last: a foreground caller behind it lifts it (join), so its own read never
  // waits behind a tick's at the background's pace
  let refLane: Lane | null = null;
  function readRef(urls: readonly string[], to: number, need = to - V.step + 1, fresh = false): Promise<boolean> {
    if (refLane !== null) join(refLane);
    const lane = sharedLane();
    const run = refLock.then(() => lanes.run(lane, () => readRefNow(urls, to, need, fresh)));
    refLane = lane;
    refLock = run.catch(() => undefined).finally(() => {
      if (refLane === lane) refLane = null;
    });
    return run;
  }
  async function readRefNow(urls: readonly string[], to: number, need: number, fresh: boolean): Promise<boolean> {
    const want = need - V.refBack;
    // a first read or discovery at a block already read, back to `want` (a dozen first reads at one shared head):
    // nothing to read again; a tick (`fresh`) reads its new blocks and the REWIND_BLOCKS before them, as before
    if (!fresh && refTo !== null && refFrom !== null && to <= refTo && want >= refFrom) return true;
    if (refFrom !== null && want < refFrom) {
      const older = await agreedRange(urls, (lo, hi) => refFilter(lo, hi, chain), want, refFrom - 1);
      if (older == null) return false;
      refEvents = older.map((l) => decodeRef(l, chain)).filter((r): r is Ref => r !== null).concat(refEvents);
      refFrom = want;
    }
    const from = refTo === null ? want : Math.max(refTo + 1 - REWIND_BLOCKS, 0);
    if (from <= to) {
      const logs = await agreedRange(urls, (lo, hi) => refFilter(lo, hi, chain), from, to);
      if (logs == null) return false;
      refEvents = refEvents.filter((e) => e.block < from).concat(logs.map((l) => decodeRef(l, chain)).filter((r): r is Ref => r !== null));
      if (refFrom === null) refFrom = from;
      refTo = Math.max(refTo ?? to, to);
    }
    // kept: the cold window and refBack before it, so a book's first swaps always have a price before them
    const keep = (refTo ?? to) - V.cold - V.refBack;
    refEvents = refEvents.filter((e) => e.block > keep);
    if (refFrom !== null) refFrom = Math.max(refFrom, keep + 1);
    return true;
  }

  /** A filter's logs walked back from `to` one step at a time, newest first, until `want` of them count (`count`) or
   *  the chain's cold window is read: an active pool costs one step, as before, and only a quiet one the whole window. */
  async function walk(urls: readonly string[], filter: (lo: number, hi: number) => Record<string, unknown> | Record<string, unknown>[], to: number, want: number, count: (logs: Log[]) => number, start = to - V.cold + 1): Promise<{ from: number; logs: Log[] } | null> {
    let hi = to;
    let logs: Log[] = [];
    let n = 0;
    while (hi >= start) {
      const lo = Math.max(start, hi - V.step + 1);
      const part = await agreedRange(urls, filter, lo, hi);
      if (part == null) return null;
      logs = part.concat(logs);
      n += count(part);
      if (n >= want || lo === start) return { from: lo, logs };
      hi = lo - 1;
    }
    return { from: start, logs };
  }

  /** Folds the logs of blocks `from` to `to` (read up to the agreed block `headN`) into a book; false when a log lies outside them
   *  or an ETH-quoted swap has no ETH price before it yet (the caller reads again). */
  function apply(e: Entry, from: number, to: number, headN: number, logs: Log[]): boolean {
    const events: Event[] = [];
    let last = 0;
    const takes = hookTakes(e.pool, logs, chain);
    for (const l of logs) {
      if (l.block < from || l.block > to) return false;
      const s = decodeSwap(e.pool, l, chain);
      if (s === null) continue;
      // a swap is timed by its block: never 0, never before an earlier block's time
      const t = timeOf(l);
      if (t === null || t < last) return false;
      last = t;
      // the tape's leg is the trader's: the pool's less a hook's cut (hookTakes)
      const got = traderLeg(s, takes.get(`${l.tx}:${l.index}`));
      events.push({ ...s, t, ...(got === undefined ? {} : { got }) });
    }
    let merged: Event[] = events;
    if (e.pool.quote.kind === "eth") {
      // the ETH swaps in the same blocks, with the last price before them as a seed at the range's start
      const inRange = refEvents.filter((r) => r.block >= from && r.block <= to);
      const before = [...refEvents].reverse().find((r) => r.block < from);
      merged = [...(before === undefined ? [] : [{ ...before, block: from, index: -1 }]), ...inRange, ...events].sort((a, b) => a.block - b.block || a.index - b.index);
      if (before === undefined && inRange.length === 0 && events.length > 0) return false;
    }
    const lo = Math.max(from, e.book.settledTo + 1);
    e.book.ingest(lo, merged.filter((x) => x.block >= lo), Math.max(Math.min(to, headN - REWIND_BLOCKS), e.book.settledTo));
    e.readAt = now();
    e.headN = to;
    return true;
  }

  /** One book's read up to the agreed head: its pool's swaps from where it is settled, folded in once `refReady` says
   *  the ETH price is read to the same block (an ETH-quoted book; read at the same time, so a tick is one round). */
  async function readBook(e: Entry, urls: readonly string[], head: { n: number; t: number }, refReady: Promise<boolean>): Promise<boolean> {
    const first = e.book.settledTo < 0 && e.readAt === null;
    if (first) {
      // a first read with no discovery's seed: newest first, until the tape's TRADES_MAX swaps or the cold window
      const w = await walk(urls, (lo, hi) => poolFilters(e.pool, lo, hi, chain), head.n, TRADES_MAX, (part) => part.filter((l) => decodeSwap(e.pool, l, chain) !== null).length);
      if (w == null) return false;
      tradersAhead(e.pool, w.logs);
      if (e.pool.quote.kind === "eth" && !((await refReady) && (await readRef(urls, head.n, w.from)))) return false;
      return apply(e, w.from, head.n, head.n, w.logs);
    }
    const from = e.book.settledTo + 1;
    // one tick reads at most a step, or CHUNKS_MAX spans past it; the rest is read the next tick
    const to = Math.min(head.n, from + Math.max(V.step, CHUNKS_MAX * V.span) - 1);
    if (from > to) return true;
    const logs = await agreedRange(urls, (lo, hi) => poolFilters(e.pool, lo, hi, chain), from, to);
    if (logs == null || (e.pool.quote.kind === "eth" && !(await refReady))) return false;
    return apply(e, from, to, head.n, logs);
  }

  /** A new book's first read, at once (card helper-robinhood-capacity fold 3): a dozen cold tapes opened together
   *  waited for the tick in progress, which read READ_PARALLEL other books, and then for the next; each now reads its
   *  own, at the shared agreed head and ETH price (agreedHead, readRef), once however many callers ask. */
  function firstRead(e: Entry): Promise<void> {
    e.first ??= (async () => {
      const head = await agreedHead();
      if (head !== null) await readBook(e, head.with, head, Promise.resolve(true)).catch(() => false);
    })().finally(() => {
      e.first = undefined;
    });
    return e.first;
  }

  let running: Promise<void> | null = null;
  /** The timer fired while a tick ran: the next starts as soon as it ends, never a skipped period. */
  let again = false;
  async function tick(): Promise<void> {
    for (const [t, e] of books) if (now() - e.touched > IDLE_MS) books.delete(t);
    if (books.size === 0) return;
    const head = await agreedHead(true);
    if (head === null) return;
    // the chain's index read to the tick's head first, one read for every book (fold 6): a tick is no one's wait, so it
    // waits on the index rather than read each book's new blocks itself, for INDEX_WAIT_MS at most: an index read that
    // hangs leaves the books their own reads, never stale (card helper-robinhood-trades-hang)
    if (index !== null) await within(index.upTo(head.n), INDEX_WAIT_MS);
    // the ETH price and the books are read at once; an ETH-quoted book is folded in only once the ETH price is read to
    // the same block, so no swap is priced by an older price (a tick of three rounds one after another outlasted 1 s)
    const needRef = [...books.values()].some((e) => e.pool.quote.kind === "eth");
    const refReady = needRef ? readRef(head.with, head.n, undefined, true).catch(() => false) : Promise.resolve(true);
    // the open books, READ_PARALLEL at a time: one after another a tick over a dozen tokens outlasts several blocks; a
    // book whose first read is in flight (firstRead) is that read's
    const due = [...books.values()].filter((e) => e.first === undefined);
    for (let i = 0; i < due.length; i += READ_PARALLEL) await Promise.all(due.slice(i, i + READ_PARALLEL).map((e) => readBook(e, head.with, head, refReady).catch(() => false)));
    await refReady;
  }
  function start(): Promise<void> {
    // a tick is the helper's own read, background whoever starts it (an open whose first read failed, a stale book)
    if (!running)
      running = lanes.run(newLane(false), tick)
        .catch(() => undefined)
        .finally(() => {
          running = null;
          if (again) {
            again = false;
            void start();
          }
        });
    return running;
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  function ensureTimer(): void {
    if (timer !== null || deps.tickMs === 0) return; // tickMs 0: no timer, the caller ticks (tests)
    timer = setInterval(() => {
      if (books.size === 0) {
        clearInterval(timer!);
        timer = null;
        return;
      }
      if (running !== null) again = true;
      else void start();
    }, deps.tickMs ?? TICK_MS);
    timer.unref();
  }

  /** The book of a listed token, read once before it is served (a first open waits for its cold read); "none" for a
   *  listed token our reads find no pool of, served as an empty chart and tape from our own reads, never a 404. */
  async function open(token: string): Promise<Entry | DataAnswer | "none"> {
    let e = books.get(token);
    if (e === undefined) {
      let found: Found | null | "unlisted" = null;
      // a first open waiting for its pool: the lists' search (ahead) starts no other meanwhile
      opening++;
      try {
        for (let attempt = 0; attempt < 2 && found === null; attempt++) {
          try {
            found = await mainPool(token);
            break;
          } catch {
            if (attempt === 1) return UPSTREAM;
          }
        }
      } finally {
        if (--opening === 0) for (const go of idle.splice(0)) go();
      }
      if (found === "unlisted") return NOT_FOUND;
      if (found === null) return "none";
      if (books.size >= OPEN_MAX) return limited(5, `${chain} trades open`);
      e = books.get(token);
      if (e === undefined) {
        e = { pool: found.pool, decimals: found.decimals, book: createBook({ decimals: found.decimals, quote: found.pool.quote }), touched: now(), readAt: null, headN: 0 };
        // the discovery already read the pool's newest swaps on two providers (walked back to a tape's worth or the cold
        // window): that is the book's first read
        if (found.seed !== undefined) {
          tradersAhead(found.pool, found.seed.logs);
          apply(e, found.seed.from, found.seed.to, found.seed.headN, found.seed.logs);
        }
        books.set(token, e);
      }
    }
    e.touched = now();
    ensureTimer();
    if (e.readAt === null) await firstRead(e);
    for (let attempt = 0; e.readAt === null && attempt < 2; attempt++) await start();
    if (e.readAt === null) return UPSTREAM;
    // a book not read for STALE_MS starts a read and is served as held, dated by its last read (readAt, the answer's
    // as_of_ms and X-Fetched-At), never a 503: the page prints a failed load for every non-2xx answer (card
    // helper-live-bars-no-503: 6 of 100 Base live reads 503 at 12:00Z); 503 is for a token with nothing held
    if (now() - e.readAt > STALE_MS) void start();
    return e;
  }

  const err = (status: number, code: string): DataAnswer => ({ status, body: JSON.stringify({ error: { code } }) });
  /** An answer with the lane's Server-Timing entries before its own (a 429 carries none: it is the limit's answer). */
  const withTiming = (a: DataAnswer, timing: string): DataAnswer => (a.status === 429 ? a : { ...a, timing: a.timing === undefined ? timing : `${timing}, ${a.timing}` });
  const NOT_FOUND = err(404, "not_found");
  const UPSTREAM = err(503, "upstream");
  const limited = (s: number, why: string): DataAnswer => ({ ...err(429, "rate_limited"), retryAfterS: s, why });
  /** A listed token with no pool our reads find: an empty answer from our own reads, timed now. */
  const empty = (fields: Record<string, unknown>): DataAnswer => {
    const at = now();
    return { status: 200, body: JSON.stringify({ ...fields, src: "chain", as_of_ms: at }), src: "chain", asOfMs: at };
  };

  // -------------------------------------------------------------------------------------------------------------
  // History before our first bar: GeckoTerminal's OHLCV for our pool, through the one budget
  // -------------------------------------------------------------------------------------------------------------

  const history = new Map<string, { at: number; bars: Candle[] }>();
  /** A listed token our reads find no pool of: GeckoTerminal's top pool for it, kept POOL_FRESH_MS (null: it names none). */
  const gtPools = new Map<string, { id: string | null; at: number }>();
  const GT_POOL_FRESH_MS = 600_000;
  /** Its candles: GeckoTerminal's bars of its top pool, src "geckoterminal", dated by their read, as a Solana token off
   *  the lists is served (card app-console-429); an empty chart from our own reads when GeckoTerminal has none to give. */
  async function noneCandles(token: string, tf: Tf, to: number | null, limit: number): Promise<DataAnswer> {
    const none = empty({ tf, candles: [] });
    if (deps.gecko === undefined || !Object.hasOwn(GT_TF, tf)) return none;
    const gecko = deps.gecko;
    let p = gtPools.get(token);
    if (p === undefined || now() - p.at >= GT_POOL_FRESH_MS) {
      // a held pool's re-read is a refresh: refused, the pool held serves
      if (gecko.take(p === undefined ? "pages" : "refresh", false, false, `${chain} pool`)) {
        try {
          const r = await doFetch(`${GT_BASE}/networks/${chain}/tokens/${token}/pools?page=1`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
          if (r.status === 429) throttledUntil(gecko, r.headers.get("retry-after"), now());
          if (r.status === 200 && Number(r.headers.get("content-length") ?? "0") <= ANSWER_MAX) {
            const text = await r.text();
            const id = text.length > ANSWER_MAX ? undefined : (JSON.parse(text) as { data?: { attributes?: { address?: unknown } }[] })?.data?.[0]?.attributes?.address;
            p = { id: typeof id === "string" && /^0x[0-9a-f]{40}([0-9a-f]{24})?$/.test(id.toLowerCase()) ? id.toLowerCase() : null, at: now() };
            if (gtPools.size >= POOLS_MAX) gtPools.delete(gtPools.keys().next().value!);
            gtPools.set(token, p);
          } else await r.body?.cancel();
        } catch {
          // GeckoTerminal did not answer: the pool held, if any
        }
      }
    }
    if (p === undefined || p.id === null) return none;
    const got = await geckoBars({ pool: { id: p.id, token } } as Entry, tf, to, true);
    // GeckoTerminal refused or failed with nothing to serve: its 429 (with the wait) or 503, so the page retries, never
    // an empty 200 for a token it names a pool of (card helper-restart-fresh)
    if (!Array.isArray(got)) return got;
    const bars = got.filter((c) => to === null || c[0] < to).slice(-limit);
    if (bars.length === 0) return none;
    const at = history.get(`${p.id}:${tf}:${to ?? ""}`)?.at ?? kept.get(`${p.id}:${tf}`)?.at ?? now();
    const body = { tf, candles: bars, src: "geckoterminal", as_of_ms: at };
    return { status: 200, body: JSON.stringify(body), src: "geckoterminal", asOfMs: at };
  }

  /** The last good bars per pool and tf (the newest range read): served when a read is throttled or fails. */
  const kept = new Map<string, { at: number; bars: Candle[] }>();
  /** GeckoTerminal's bars before `before` (unix seconds; null: its newest range, one cache key however often asked),
   *  or, when the read is refused, throttled or fails, the last good bars of the pool and tf cut there; with none of
   *  those, the 429 (with the wait to the next call) or 503 to answer. `alone`: the bars are the chart, with no book of
   *  ours after them (noneCandles), so their read is the answer's X-Fetched-At: the newest range is read again after
   *  GT_NEWEST_FRESH_MS and served from what is held only within GT_SERVE_MS (card helper-restart-fresh); before a book
   *  of ours they are history the book's own reads follow, kept GT_FRESH_MS. */
  async function geckoBars(e: Entry, tf: Tf, before: number | null, alone = false): Promise<Candle[] | DataAnswer> {
    if (!Object.hasOwn(GT_TF, tf) || deps.gecko === undefined) return [];
    const gecko = deps.gecko;
    const k = `${e.pool.id}:${tf}:${before ?? ""}`;
    const fresh = history.get(k);
    const newest = alone && before === null;
    if (fresh !== undefined && now() - fresh.at < (newest ? GT_NEWEST_FRESH_MS : GT_FRESH_MS)) return fresh.bars;
    const servable = (at: number | undefined) => at !== undefined && (!newest || now() - at <= GT_SERVE_MS);
    const fallback = (fail: DataAnswer): Candle[] | DataAnswer => {
      if (fresh !== undefined && fresh.bars.length > 0 && servable(fresh.at)) return fresh.bars;
      const held = kept.get(`${e.pool.id}:${tf}`);
      const cut = (servable(held?.at) ? held!.bars : []).filter((c) => before === null || c[0] < before);
      return cut.length > 0 ? cut : fail;
    };
    const wait = (why = "geckoterminal budget") => limited(Math.min(Math.max(Math.ceil((gecko.retryAt("pages") - now()) / 1000), 1), RETRY_AFTER_MAX_S), why);
    // a re-read of bars held is a refresh (../gecko.ts): it leaves a cold page its calls, and refused, the bars held are
    // served (card app-console-429); the newest range is a page read once its kept bars are REFRESH_URGENT_MS old, so
    // the lists' calls never leave it served the same bars for good (refreshLane, card helper-chart-fresh); history
    // before a time stays a refresh
    // the history before a book of ours (not `alone`) is an optional seed, the answer our chain bars without it: a stale
    // read, so it never takes the call a chart with nothing to serve needs (card helper-crowd-429)
    const lane = before === null ? refreshLane(kept.get(`${e.pool.id}:${tf}`)?.at ?? fresh?.at ?? null, now()) : fresh !== undefined ? "refresh" : alone ? "pages" : "stale";
    if (!gecko.take(lane, false, false, `${chain} bars`)) return fallback(wait(lane === "pages" ? undefined : `geckoterminal ${lane}`));
    try {
      const g = GT_TF[tf as keyof typeof GT_TF];
      const url = `${GT_BASE}/networks/${chain}/pools/${e.pool.id}/ohlcv/${g.period}?aggregate=${g.aggregate}&limit=1000&currency=usd&token=${e.pool.token}${before === null ? "" : `&before_timestamp=${before}`}`;
      const r = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (r.status === 429) {
        await r.body?.cancel();
        throttledUntil(gecko, r.headers.get("retry-after"), now());
        return fallback(wait("geckoterminal 429"));
      }
      if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) {
        await r.body?.cancel();
        return fallback(UPSTREAM);
      }
      const text = await r.text();
      if (text.length > ANSWER_MAX) return fallback(UPSTREAM);
      const bars = toCandles(JSON.parse(text), tf as keyof typeof GT_TF, 1_000, now());
      if (bars === null) return fallback(UPSTREAM);
      if (history.size >= 500) history.delete(history.keys().next().value!);
      history.set(k, { at: now(), bars });
      const kk = `${e.pool.id}:${tf}`;
      const had = kept.get(kk);
      if (bars.length > 0 && (had === undefined || bars.at(-1)![0] >= had.bars.at(-1)![0])) {
        kept.delete(kk);
        if (kept.size >= 500) kept.delete(kept.keys().next().value!);
        kept.set(kk, { at: now(), bars });
      }
      return bars;
    } catch {
      return fallback(UPSTREAM);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // The served answers
  // -------------------------------------------------------------------------------------------------------------

  /** Traders of the txs (06c §4.12): the sender of each, or for a bundle sent to an EntryPoint each user operation's
   *  account, read from its receipt (index.ts txTraders, card helper-tape-4337-trader). A dozen cold tokens ask about 600 at once (card
   *  helper-robinhood-capacity fold 2), so they are split across the providers not held by expected answer time (waitOf), each share
   *  read at once, and a share whose read fails asked of the others in turn; a tx whose read fails everywhere stays null
   *  this time and is asked again the next. */
  /** The lookups out now, by transaction: a tape asks a hash in flight once (card helper-robinhood-capacity fold 8). */
  const looking = new Map<string, Promise<void>>();
  /** Each transaction's sender into `traders`, one lookup per hash however many callers ask it at once. */
  async function tradersOf(txs: string[]): Promise<void> {
    const ask = [...new Set(txs)].filter((t) => !traders.has(t));
    const waits = ask.flatMap((t) => (looking.has(t) ? [looking.get(t)!] : []));
    const need = ask.filter((t) => !looking.has(t));
    if (need.length > 0) {
      const p = lookTraders(need).finally(() => {
        for (const t of need) if (looking.get(t) === p) looking.delete(t);
      });
      for (const t of need) looking.set(t, p);
      waits.push(p);
    }
    await Promise.all(new Set(waits));
  }
  /** A book's newest swaps' traders asked as soon as its first logs are read, alongside the ETH price's read, so the
   *  tape that follows waits for no lookup it could have started (fold 8: 8.6 s of lookups after a cold read). */
  function tradersAhead(pool: Pool, logs: readonly Log[]): void {
    const txs = logs.filter((l) => decodeSwap(pool, l, chain) !== null).slice(-TRADES_MAX).map((l) => l.tx);
    if (txs.length > 0) void tradersOf(txs).catch(() => undefined);
  }
  async function lookTraders(need: string[]): Promise<void> {
    // per-swap lookups go in batches: a provider that takes one request a post is asked none of them (fold 5)
    // each hash to the provider whose share would be answered first (waitOf: its answer time, queue and pace, with the
    // hashes already its), never by free budget alone (card robinhood-cold-open-fast: pocket, the biggest bucket, took
    // 1 to 3 s a post while the others answered in 0.3 s, and the tape waited on its share)
    const order = single(usable(rpcs), 2);
    if (order.length === 0) return;
    const share = new Map<string, string[]>(order.map((u) => [u, []]));
    for (const t of need) {
      const u = order.reduce((best, v) => (waitOf(v, share.get(v)!.length + 1, false) < waitOf(best, share.get(best)!.length + 1, false) ? v : best));
      share.get(u)!.push(t);
    }
    const shares = [...share].map(([u, part]) => ({ u, part }));
    // the transactions read, by hash: one sent to an EntryPoint waits for its receipt (bundles) before it has traders
    const got = new Map<string, Record<string, unknown>>();
    const keep = (t: string, x: Traders) => {
      if (traders.size >= TRADERS_MAX) traders.delete(traders.keys().next().value!);
      traders.set(t, x);
    };
    const read = async (u: string, part: string[]): Promise<boolean> => {
      const r = await batchTo(u, part.map((t) => ({ method: "eth_getTransactionByHash", params: [t] })));
      if (r === null) return false;
      part.forEach((t, i) => {
        const x = r[i];
        const tx = x?.ok ? obj(x.result) : null;
        if (tx === null || typeof tx.hash !== "string" || tx.hash.toLowerCase() !== t) return;
        const plain = toEntryPoint(tx) ? null : txTraders(tx, null);
        if (toEntryPoint(tx) || plain !== null) got.set(t, tx);
        if (plain !== null) keep(t, plain);
      });
      return true;
    };
    /** A share's bundles' traders from their receipts, which two providers must give alike (card helper-tape-4337-trader):
     *  one read more for a transaction sent to an EntryPoint, none for any other. */
    const bundles = async (part: string[]): Promise<void> => {
      const ask = part.filter((t) => got.has(t) && toEntryPoint(got.get(t)!) && !traders.has(t));
      if (ask.length === 0) return;
      const ops = await agreed<Traders>(
        rpcs,
        ask.length,
        async (u, idx, patient) => {
          const r = await batchTo(u, idx.map((i) => ({ method: "eth_getTransactionReceipt", params: [ask[i]] })), patient);
          return idx.map((i, k) => {
            const x = r?.[k];
            return x?.ok ? txTraders(got.get(ask[i]!)!, obj(x.result)) : null;
          });
        },
        (a, b) => JSON.stringify(a) === JSON.stringify(b),
        false,
      );
      ask.forEach((t, i) => {
        const x = ops[i];
        if (x != null) keep(t, x);
      });
    };
    await Promise.all(
      shares.filter((x) => x.part.length > 0).map(async ({ u, part }) => {
        if (!(await read(u, part)))
          // a share whose read failed: only its hashes still not read, of the others in turn
          for (const v of ranked(usable(rpcs), false, part.length)) {
            const left = part.filter((t) => !got.has(t));
            if (left.length === 0) break;
            if (v !== u && single([v], 2).length > 0 && (await read(v, left))) break;
          }
        await bundles(part);
      }),
    );
  }

  return {
    tick: start,
    stop(): void {
      aheadQueue.clear();
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (follower !== null) clearInterval(follower);
      follower = null;
    },
    /** The chain's swap index (index.ts), the one Discover's lists read too (helper-lists-own-index); null on a chain
     *  with none. `follow()` reads it up to the agreed head now (the follower's step; tests call it with tickMs 0). */
    index,
    follow,
    /** The lists' tokens, looked for ahead of a first open (card helper-robinhood-search-ahead); settles when the search
     *  it joined is done. The lists call it as each new answer loads (server.ts evmSwapsFromEnv). */
    ahead,
    /** 06b Candles for a listed Base token: our own bars, and GeckoTerminal's before our first. */
    async candles(token: string, tf: string, to: number | null, limit: number): Promise<DataAnswer> {
      const t = evmAddress(token);
      if (t === null || !(TFS as readonly string[]).includes(tf) || tf === "1s" || !Number.isSafeInteger(limit) || limit < 1 || limit > CANDLES_MAX) return NOT_FOUND;
      // a first open past its bound answers 503 and its read goes on (OPEN_BOUND_MS); its reads are a caller's, in the
      // foreground lane, and the answer names their wait (Server-Timing)
      const lane = newLane(true);
      const began = performance.now();
      const e = await within(lanes.run(lane, () => open(t)), OPEN_BOUND_MS);
      const openMs = performance.now() - began;
      const timed = (a: DataAnswer): DataAnswer => withTiming(a, laneTiming(lane, openMs));
      if (e === LATE) return timed(UPSTREAM);
      if (e === "none") return timed(await noneCandles(t, tf as Tf, to, limit));
      if (!("book" in e)) return timed(e);
      const own = e.book.candles(tf as Tf, to, limit);
      const ownFrom = e.book.ownFrom(tf as Tf);
      let bars: Candle[] = own;
      let src = "chain";
      // a range we do not hold: bars before our first
      if (own.length < limit) {
        const before = ownFrom === null ? (to ?? Math.floor(now() / 1000)) : Math.min(ownFrom, to ?? ownFrom);
        // GeckoTerminal's history is an optional seed (card helper-crowd-429): refused or failed, the answer is our
        // chain bars alone, never its 429 (index-evm-swaps at 22:12Z: a Robinhood 1m chart answered 429 for the seed)
        const got = await geckoBars(e, tf as Tf, ownFrom === null ? to : before);
        const old = (Array.isArray(got) ? got : []).filter((c) => c[0] < before);
        if (old.length > 0) {
          bars = old.concat(own).slice(-limit);
          src = "chain,geckoterminal";
        }
      }
      const at = e.readAt ?? now();
      const body: Record<string, unknown> = { tf, candles: bars, src };
      if (own.length > 0) body.own_from_s = own[0]![0];
      body.as_of_ms = at;
      return timed({ status: 200, body: JSON.stringify(body), src, asOfMs: at });
    },
    /** 06b Trades: the newest `limit` swaps, newest first. */
    async trades(token: string, limit: number): Promise<DataAnswer> {
      const t = evmAddress(token);
      if (t === null || !Number.isSafeInteger(limit) || limit < 1 || limit > TRADES_MAX) return NOT_FOUND;
      // a first open past its bound answers 503 and its read goes on (OPEN_BOUND_MS); the traders are looked up within
      // what is left of it, and one not read by then is null this time, asked again the next
      const until = performance.now() + OPEN_BOUND_MS;
      // a caller's reads, in the foreground lane, their wait named in the answer (as candles)
      const lane = newLane(true);
      const began = performance.now();
      const e = await within(lanes.run(lane, () => open(t)), OPEN_BOUND_MS);
      const openMs = performance.now() - began;
      // the queue wait counts the traders' lookups below too: the answer waits on them
      const timed = (a: DataAnswer): DataAnswer => withTiming(a, laneTiming(lane, openMs));
      if (e === LATE) return timed(UPSTREAM);
      if (e === "none") return timed(empty({ trades: [] }));
      if (!("book" in e)) return timed(e);
      const rows = e.book.tape(limit);
      await within(lanes.run(lane, () => tradersOf(rows.map((r) => r.tx))), Math.max(0, until - performance.now()));
      const at = e.readAt ?? now();
      const trades = rows.map((r) => ({ t_ms: r.t_ms, side: r.side, usd: r.usd, amt: r.amt, trader: traderAt(traders.get(r.tx), r.index), tx: r.tx }));
      return timed({ status: 200, body: JSON.stringify({ trades, src: "chain", as_of_ms: at }), src: "chain", asOfMs: at });
    },
  };
}
export type EvmSwaps = ReturnType<typeof createSwaps>;
