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
// holds until STALE_MS, then the routes answer 503.
//
// Block times on Base come from its fixed clock (BLOCK_CLOCK, lists.ts): checked against each tick's newest block on both
// providers, and a tick whose block disagrees with the clock reads nothing. Robinhood has no fixed clock (it put 10 or
// more blocks in one second): a swap is timed by its log's `blockTimestamp`, part of what two providers must answer
// alike, never 0 and never before an earlier swap's.
//
// Display only: nothing here feeds a signature. Every provider value is hostile input: a log counts only when its
// emitter, topic0, topic count and data length match the venue exactly; an amount must fit its type and its legs have
// opposite signs; counts, ranges and the books are bounded.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createBook, TFS, type Book, type Candle, type Event, type Ref, type Swap, type Tf } from "../candles.ts";
import { refreshLane, throttledUntil, type GeckoBudget } from "../gecko.ts";
import { EVM_LIMIT_CODE, RETRY_AFTER_MAX_S, upstreamRetryAfterS } from "../../limits/limits.ts";
import { toCandles, TF as GT_TF, type DataAnswer } from "../solana/token.ts";
import { BATCH_MAX, BLOCK_CLOCK, evmAddress, GT_BASE, type EvmChain } from "./lists.ts";

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
} as const;

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
} as const;
export const ROBINHOOD_REF_POOL_ID = "0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982";

/** A chain's venues and read sizes. `usd` is the chain's dollar stablecoin (6 decimals on both). */
export type Venues = {
  poolManager: string;
  positionManager: string;
  v3: readonly string[];
  v2: readonly string[];
  usd: string;
  weth: string;
  refPoolId: string;
  pons: readonly string[];
  /** The most blocks one `eth_getLogs` asks (the smallest the chain's providers take). */
  span: number;
  /** The blocks a token's first read and its discovery may go back: COLD_S of the chain's measured block time. */
  cold: number;
  /** The blocks one round of that walk reads, newest first: an active token's swaps are found in the first. */
  step: number;
  /** The blocks the ETH price is read before the earliest block a book reads, so its first swap has a price before it. */
  refBack: number;
  /** A provider this many blocks behind the other is passed over for the third. */
  lagMax: number;
};
/** How far back a token's discovery and first read may walk: 20 minutes on every chain, Base's window before
 *  (600 blocks of 2 s), so a token quiet for a few minutes still has its pool, tape and bars (card app-console-429: at
 *  Robinhood's 3,000 blocks, 306 s, a v4 token with $36.6k of 5-minute volume had no transfer and answered an empty
 *  chart, 2026-11-04 12:59Z). */
export const COLD_S = 1_200;
const coldOf = (blockMs: number) => Math.ceil((COLD_S * 1000) / blockMs);
export const VENUES: Readonly<Record<EvmChain, Venues>> = {
  base: {
    poolManager: BASE_VENUES.poolManager,
    positionManager: BASE_VENUES.positionManager,
    v3: [BASE_VENUES.uniswapV3, ...BASE_VENUES.slipstream],
    v2: [BASE_VENUES.aerodromeV2],
    usd: BASE_VENUES.usdc,
    weth: BASE_VENUES.weth,
    refPoolId: REF_POOL_ID,
    pons: [],
    span: 1_000,
    // Base's clock: one block every 2 s (lists.ts BLOCK_CLOCK)
    cold: coldOf(2_000),
    step: 600,
    refBack: 1_400,
    lagMax: 10,
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
    v3: [ROBINHOOD_VENUES.uniswapV3],
    v2: [],
    usd: ROBINHOOD_VENUES.usdg,
    weth: ROBINHOOD_VENUES.weth,
    refPoolId: ROBINHOOD_REF_POOL_ID,
    pons: [ROBINHOOD_VENUES.ponsV2],
    span: 100,
    // one step, not COLD_S (card helper-robinhood-swaps): 20 minutes of 102 ms blocks is 118 spans of 100 blocks a
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
export const SWAP_RPCS: Readonly<Record<EvmChain, readonly string[]>> = {
  base: ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co", "https://base.drpc.org", "https://base-pokt.nodies.app"],
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
  // header-timed (HEADER_TIMED). Ordered by those reads, the fastest first.
  robinhood: ["https://robinhood.drpc.org", "https://rpc.mainnet.chain.robinhood.com", "https://robinhood.daybreak-rpc.network", "https://api.blockvectra.com/v1/robinhood_mainnet/public"],
};

/** Providers whose logs carry no block time on a chain timed by them (Robinhood): their logs are timed by their own
 *  `eth_getBlockByNumber` of each log's block, and count for a swap's time only where another provider logged the same. */
export const HEADER_TIMED: ReadonlySet<string> = new Set(["https://rpc.mainnet.chain.robinhood.com"]);

/** Requests per JSON-RPC batch each provider takes: the maker read's (lists.ts BATCH_MAX: drpc's free plan 3), and
 *  Tenderly's gateway 4 (a batch of 10 `eth_call` answered HTTP 429 -32005 "rate limit exceeded", 2026-11-03 17:2xZ). */
const BATCH_SIZE: Readonly<Record<string, number>> = { ...BATCH_MAX, "https://base.gateway.tenderly.co": 4, "https://api.blockvectra.com/v1/robinhood_mainnet/public": 1 };

/** Requests out to one provider at once (swaps.ts batchTo). */
export const INFLIGHT_MAX = 4;

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
/** Providers asked for one answer at most: two, and two more when they differ. */
const PROVIDERS_MAX = 4;
/** A provider this many blocks behind the other is passed over for the third (Base). */
export const LAG_MAX = VENUES.base.lagMax;
/** A token nobody asked for this long stops being read (its book is dropped). */
export const IDLE_MS = 60_000;
/** The tick period. */
export const TICK_MS = 1_000;
/** A book not read for this long answers 503 rather than a stale chart. */
export const STALE_MS = 60_000;
export const OPEN_MAX = 40;
/** Books read at once in a tick. */
const READ_PARALLEL = 8;
const POOLS_MAX = 5_000;
const ANSWER_MAX = 4 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
const LOGS_MAX = 20_000;
const TRADERS_MAX = 5_000;
export const TRADES_MAX = 50;
export const CANDLES_MAX = 500;
/** History before our first bar never changes: kept this long. */
const GT_FRESH_MS = 3_600_000;

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
  const V = VENUES[chain];
  const w = (n: bigint): string => n.toString(16).padStart(64, "0");
  const a = (x: string): string => x.slice(2).padStart(64, "0");
  const hooks = [ZERO, ...around.filter((x) => x !== token && x !== V.poolManager && x !== V.weth && x !== V.usd).slice(0, HOOKS_MAX)];
  const fees = [...new Set([swapFee, DYNAMIC_FEE, 100, 500, 2500, 3000, 10000])];
  const spacings = [...TICK_SPACINGS, ...Array.from({ length: TICK_SPACING_MAX }, (_, i) => i + 1).filter((t) => !TICK_SPACINGS.includes(t))];
  for (const other of [ZERO, V.weth, V.usd]) {
    const [c0, c1] = token < other ? [token, other] : [other, token];
    for (const ts of spacings) for (const h of hooks) for (const f of fees) {
      const k = `0x${a(c0)}${a(c1)}${w(BigInt(f))}${w(BigInt(ts))}${a(h)}`;
      if (keccakHex(k) === id) return k;
    }
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
/** Whether two providers' answers for one filter are the same logs; `withTime`: with the same block times too (a chain
 *  with no fixed block clock, whose swaps are timed by them). */
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
};

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

// ---------------------------------------------------------------------------------------------------------------
// The providers
// ---------------------------------------------------------------------------------------------------------------

type Call = { method: string; params: unknown[] };
type Reply = { ok: true; result: unknown } | { ok: false; wait: number };

export function createSwaps(chain: EvmChain, deps: { fetch?: Fetch; now?: () => number; listed: (token: string) => Promise<boolean>; gecko?: GeckoBudget; rpcs?: readonly string[]; headerTimed?: ReadonlySet<string>; pools?: ReadonlyMap<string, { pool: Pool; decimals: number }>; tickMs?: number }) {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const rpcs = deps.rpcs ?? SWAP_RPCS[chain];
  const headerTimed = deps.headerTimed ?? HEADER_TIMED;
  const V = VENUES[chain];
  // Base's fixed clock times its blocks; a chain with none (Robinhood) is timed by each log's own block time, which two
  // providers must give alike
  const clock = BLOCK_CLOCK[chain];
  const timeOf = (l: Log): number | null => (clock !== null ? clock.genesisS + clock.blockS * l.block : typeof l.t === "number" && l.t > 0 ? l.t : null);
  /** Blocks `from` to `to` in spans of at most V.span. */
  const spans = (from: number, to: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let lo = from; lo <= to; lo += V.span) out.push([lo, Math.min(to, lo + V.span - 1)]);
    return out;
  };
  const held = new Map<string, number>(); // provider -> held until (ms)

  /** One JSON-RPC batch to a provider: each call's reply, or the wait a refusal names; null when it failed. */
  async function batchTo(url: string, calls: Call[]): Promise<Reply[] | null> {
    const max = BATCH_SIZE[url] ?? 10;
    const parts: Call[][] = [];
    for (let i = 0; i < calls.length; i += max) parts.push(calls.slice(i, i + max));
    const got = await Promise.all(parts.map((part) => slot(url, () => one(url, part))));
    return got.some((g) => g === null) ? null : got.flat() as Reply[];
  }

  // at most INFLIGHT_MAX requests out to a provider at once, the rest queued in order: a first read's walk sent 246 at
  // once to the Robinhood providers, which answered 429, -32005, drpc's code 30 and timeouts that one at a time they
  // did not (card helper-chart-fresh, 2026-11-04 14:49Z)
  const inflight = new Map<string, { n: number; queue: (() => void)[] }>();
  async function slot<T>(url: string, run: () => Promise<T>): Promise<T> {
    const q = inflight.get(url) ?? { n: 0, queue: [] };
    inflight.set(url, q);
    if (q.n >= INFLIGHT_MAX) await new Promise<void>((go) => q.queue.push(go));
    else q.n++;
    try {
      return await run();
    } finally {
      const next = q.queue.shift();
      if (next !== undefined) next();
      else q.n--;
    }
  }

  /** One JSON-RPC batch (at most the provider's batch size) to a provider. */
  async function one(url: string, part: Call[]): Promise<Reply[] | null> {
    if ((held.get(url) ?? 0) > now()) return null;
    try {
      const r = await doFetch(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(part.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params }))),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.status === 429) {
        await r.body?.cancel();
        held.set(url, Math.max(held.get(url) ?? 0, now() + upstreamRetryAfterS(r.headers, now()) * 1000));
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
          // the helper's RPC rules (rpc.ts): -32005 or a limit message is a throttle, held for the wait it names
          const e = obj(o.error);
          const s = Number(obj(e.data).backoff_seconds);
          const limited = e.code === EVM_LIMIT_CODE || /rate.?limit|too many requests|limit (reached|exceeded)|request limit/i.test(String(e.message ?? ""));
          const wait = limited ? (Number.isFinite(s) && s > 0 ? Math.min(Math.ceil(s), RETRY_AFTER_MAX_S) : 1) : 0;
          if (wait > 0) held.set(url, Math.max(held.get(url) ?? 0, now() + wait * 1000));
          got[o.id as number] = { ok: false, wait };
        } else if (Object.hasOwn(o, "result")) got[o.id as number] = { ok: true, result: o.result };
      }
      return got;
    } catch {
      return null;
    }
  }
  const usable = (urls: readonly string[]) => urls.filter((u) => (held.get(u) ?? 0) <= now());

  /** The block both providers have, and its time: the newest block of the two heads (the second highest of three when
   *  the first two differ by more than LAG_MAX), with the providers that have it. Null when it cannot be read. */
  async function agreedHead(): Promise<{ n: number; t: number; with: string[] } | null> {
    const heads = new Map<string, { n: number; t: number }>();
    const read = async (urls: string[]) => {
      await Promise.all(
        urls.map(async (u) => {
          const r = await batchTo(u, [{ method: "eth_getBlockByNumber", params: ["latest", false] }]);
          const b = r?.[0]?.ok ? obj(r[0].result) : {};
          const [n, t] = [hexInt(b.number), hexInt(b.timestamp)];
          if (n !== null && t !== null) heads.set(u, { n, t });
        }),
      );
    };
    const ok = usable(rpcs);
    await read(ok.slice(0, 2));
    const first = [...heads.values()];
    if (ok.length > 2 && (first.length < 2 || Math.abs(first[0]!.n - first[1]!.n) > V.lagMax)) await read(ok.slice(2, 3));
    const sorted = [...heads].sort((a, b) => b[1].n - a[1].n);
    if (sorted.length < 2) return null;
    const agreed = sorted[1]![1].n; // the newest block at least two providers have
    const withIt = sorted.filter(([, h]) => h.n >= agreed).map(([u]) => u);
    if (clock === null) return { n: agreed, t: sorted[1]![1].t, with: withIt };
    // every provider's head block must sit on the chain's clock
    for (const [, h] of sorted) if (h.t !== clock.genesisS + clock.blockS * h.n) return null;
    return { n: agreed, t: clock.genesisS + clock.blockS * agreed, with: withIt };
  }

  /** The providers to ask, in order: those of `urls` not held, then any other of ours not held (a provider that was held
   *  since the head was read, or lags, is made up for by the next), at most PROVIDERS_MAX. */
  const askOrder = (urls: readonly string[]): string[] => [...new Set([...usable(urls), ...usable(rpcs)])].slice(0, PROVIDERS_MAX);

  /** Asks `urls` the same `n` requests, two at once and then one more at a time while some answer has no two alike.
   *  Returns each request's answer that two providers gave alike (`same` says what alike is), else null. */
  async function agreed<A>(urls: readonly string[], n: number, ask: (u: string, idx: number[]) => Promise<(A | null)[]>, same: (a: A, b: A) => boolean): Promise<(A | null)[]> {
    const order = askOrder(urls);
    const got: A[][] = Array.from({ length: n }, () => []);
    const run = async (u: string, idx: number[]) => {
      const r = await ask(u, idx);
      idx.forEach((i, k) => {
        if (r[k] != null) got[i]!.push(r[k]!);
      });
    };
    const pick = (i: number): A | null => {
      const g = got[i]!;
      for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) if (same(g[a]!, g[b]!)) return g[a]!;
      return null;
    };
    const all = Array.from({ length: n }, (_, i) => i);
    await Promise.all(order.slice(0, 2).map((u) => run(u, all)));
    for (const u of order.slice(2)) {
      const left = all.filter((i) => pick(i) === null);
      if (left.length === 0) break;
      await run(u, left);
    }
    return all.map(pick);
  }

  /** For each filter, its logs when two providers return the same ones; null where they do not agree. */
  function agreedLogs(urls: readonly string[], filters: Record<string, unknown>[]): Promise<(Log[] | null)[]> {
    return agreed<Log[]>(
      urls,
      filters.length,
      async (u, idx) => {
        const r = await batchTo(u, idx.map((i) => ({ method: "eth_getLogs", params: [filters[i]] })));
        const got = idx.map((_, k) => (r?.[k]?.ok ? parseLogs((r[k] as { result: unknown }).result) : null));
        return clock === null && headerTimed.has(u) ? timedByHeaders(u, got) : got;
      },
      (a, b) => sameLogs(a, b, clock === null),
    );
  }

  /** A header-timed provider's logs (it logs no block time) timed by its own headers of their blocks; an answer with a
   *  block it gives no time for is no answer. Its times count only where another provider logged the same (agreedLogs'
   *  sameLogs with times), so a header for the wrong block or a 0 is no agreement. */
  async function timedByHeaders(u: string, got: (Log[] | null)[]): Promise<(Log[] | null)[]> {
    const blocks = [...new Set(got.flatMap((g) => (g ?? []).map((l) => l.block)))];
    if (blocks.length === 0) return got;
    const r = await batchTo(u, blocks.map((n) => ({ method: "eth_getBlockByNumber", params: [`0x${n.toString(16)}`, false] })));
    const times = new Map<number, number>();
    blocks.forEach((n, i) => {
      const b = r?.[i]?.ok ? obj((r[i] as { result: unknown }).result) : {};
      const t = hexInt(b.timestamp);
      if (t !== null) times.set(n, t); // checked as any logged time is: alike with another provider's, never 0 (apply)
    });
    return got.map((g) => (g === null || g.some((l) => !times.has(l.block)) ? null : g.map((l) => ({ ...l, t: times.get(l.block)! }))));
  }

  /** One filter's logs over blocks `from` to `to`, read in spans the providers take: null when any span is not agreed. */
  async function agreedRange(urls: readonly string[], filter: (lo: number, hi: number) => Record<string, unknown>, from: number, to: number): Promise<Log[] | null> {
    const parts = await agreedLogs(urls, spans(from, to).map(([lo, hi]) => filter(lo, hi)));
    return parts.some((x) => x == null) ? null : (parts as Log[][]).flat();
  }

  /** The same `eth_call`s at block `n`: each result two providers gave alike, else undefined. */
  async function callsAgreed(n: number, calls: { to: string; data: string }[]): Promise<(string | undefined)[]> {
    const got = await agreed<string>(
      rpcs,
      calls.length,
      async (u, idx) => {
        const r = await batchTo(u, idx.map((i) => ({ method: "eth_call", params: [calls[i], `0x${n.toString(16)}`] })));
        return idx.map((_, k) => (r?.[k]?.ok && typeof (r[k] as { result: unknown }).result === "string" ? (r[k] as { result: string }).result.toLowerCase() : null));
      },
      (a, b) => a === b,
    );
    return got.map((x) => x ?? undefined);
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
  const pad32 = (a: string) => a.slice(2).padStart(64, "0");

  const wordAddr = (r: string | undefined, i = 0): string | null => (r !== undefined && /^0x([0-9a-f]{64})+$/.test(r) && r.length >= 2 + 64 * (i + 1) ? `0x${r.slice(2 + 64 * i + 24, 2 + 64 * (i + 1))}` : null);

  async function findPool(token: string): Promise<Found | null> {
    const head = await agreedHead();
    if (head === null) throw new Error("no agreed head");
    // the token's transfers newest first, a step at a time, until a tape's worth or the cold window [design: twice
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
    // v2, v3 and Slipstream pools: the factory of each address, then the two tokens of those of a listed venue, read at
    // the agreed block
    const factories = await callsAgreed(head.n, top.map((a) => ({ to: a, data: SEL.factory })));
    const ofVenue = top.filter((_, i) => {
      const f = wordAddr(factories[i]);
      return f !== null && (V.v2.includes(f) || V.v3.includes(f));
    });
    const pairs = await callsAgreed(head.n, ofVenue.flatMap((a) => [SEL.token0, SEL.token1].map((data) => ({ to: a, data }))));
    ofVenue.forEach((a, i) => {
      const [f, t0, t1] = [wordAddr(factories[top.indexOf(a)]), wordAddr(pairs[2 * i]), wordAddr(pairs[2 * i + 1])];
      if (f === null || t0 === null || t1 === null) return;
      const isV2 = V.v2.includes(f);
      const tokenIs0 = t0 === token;
      if (!tokenIs0 && t1 !== token) return;
      const other = tokenIs0 ? t1 : t0;
      const quote = other === V.usd ? ({ kind: "usd", decimals: 6 } as const) : other === V.weth ? ({ kind: "eth", decimals: 18 } as const) : null;
      if (quote !== null) cands.push({ venue: isV2 ? "v2" : "v3", id: a, token, tokenIs0, quote });
    });
    // v4 pools: the pool ids the PoolManager's recent swaps in the token's transactions name. A key is the
    // PositionManager's own record of it when there is one; a pool made without it (Doppler, Zora) has its key worked out
    // from the swap's own fee and the addresses in its transaction (v4Key). Either way the key must hash to the id.
    if (pmTxs.length > 0) {
      const seen = new Map<string, { fee: number; around: Set<string> }>();
      for (const u of usable(rpcs)) {
        const r = await batchTo(u, pmTxs.slice(-V4_TXS).map((t) => ({ method: "eth_getTransactionReceipt", params: [t] })));
        if (r === null) continue;
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
      const list = [...seen.keys()].slice(0, CANDIDATES_MAX);
      const keys = await callsAgreed(head.n, list.map((id) => ({ to: V.positionManager, data: `${SEL.poolKeys}${id.slice(2, 2 + 50).padEnd(64, "0")}` })));
      list.forEach((id, i) => {
        let k: string | undefined = keys[i];
        if (k === undefined || !/^0x[0-9a-f]{320}$/.test(k) || keccakHex(k) !== id) {
          const e = seen.get(id)!;
          k = v4Key(id, token, e.fee, [...e.around], chain) ?? undefined; // the key must hash to the id
        }
        if (k === undefined) return;
        const [c0, c1] = [wordAddr(k, 0)!, wordAddr(k, 1)!];
        const tokenIs0 = c0 === token;
        if (!tokenIs0 && c1 !== token) return;
        const other = tokenIs0 ? c1 : c0;
        const quote = other === V.usd ? ({ kind: "usd", decimals: 6 } as const) : other === V.weth || other === ZERO ? ({ kind: "eth", decimals: 18 } as const) : null;
        if (quote !== null) cands.push({ venue: "v4", id, token, tokenIs0, quote });
      });
    }
    // a Pons curve: the factory's own record of the token names its curve and its quote (zero: native ETH)
    if (V.pons.length > 0) {
      const recs = await callsAgreed(head.n, V.pons.map((f) => ({ to: f, data: `${SEL.launched}${pad32(token)}` })));
      // a record not read is no answer: never kept as "no pool" (a token with none answers the empty record)
      if (recs.some((r) => r === undefined)) throw new Error("pons records not agreed");
      for (const r of recs) {
        if (r === undefined || !/^0x[0-9a-f]{960}$/.test(r) || wordAddr(r, 0) !== token || BigInt(`0x${r.slice(2 + 64 * 14)}`) !== 1n) continue;
        const [curve, pair] = [wordAddr(r, 1)!, wordAddr(r, 4)!];
        const quote = pair === V.usd ? ({ kind: "usd", decimals: 6 } as const) : pair === ZERO || pair === V.weth ? ({ kind: "eth", decimals: 18 } as const) : null;
        if (curve !== ZERO && quote !== null) cands.push({ venue: "curve", id: curve, token, tokenIs0: false, quote });
      }
    }
    if (cands.length === 0) return null;
    // the pool with most swaps in the window is the main pool (ties: the lower id); its logs are the book's first read
    const [swaps, [d], refOk] = await Promise.all([
      Promise.all(cands.map((c) => agreedRange(head.with, (lo, hi) => swapFilter(c, lo, hi, chain), from, head.n))),
      callsAgreed(head.n, [{ to: token, data: SEL.decimals }]),
      cands.some((c) => c.quote.kind === "eth") ? readRef(head.with, head.n, from) : Promise.resolve(true),
    ]);
    const score = cands.map((c, i) => (swaps[i] == null ? -1 : swaps[i]!.filter((l) => decodeSwap(c, l, chain) !== null).length));
    if (score.every((x) => x < 0)) throw new Error("swaps not agreed");
    const best = cands.map((c, i) => ({ c, i, n: score[i]! })).sort((x, y) => y.n - x.n || (x.c.id < y.c.id ? -1 : 1))[0]!;
    if (best.n <= 0 && from === head.n - V.cold + 1) return null;
    // the main pool's swaps further back, while the tape is short of TRADES_MAX and the cold window not read
    let logs = swaps[best.i]!;
    let n = best.n;
    if (n < TRADES_MAX && from > head.n - V.cold + 1) {
      const w = await walk(head.with, (lo, hi) => swapFilter(best.c, lo, hi, chain), from - 1, TRADES_MAX - n, (part) => part.filter((l) => decodeSwap(best.c, l, chain) !== null).length, head.n - V.cold + 1);
      if (w == null) throw new Error("swaps not agreed");
      logs = w.logs.concat(logs);
      n += w.logs.filter((l) => decodeSwap(best.c, l, chain) !== null).length;
      from = w.from;
    }
    if (n <= 0) return null;
    const ref = best.c.quote.kind === "eth" ? await readRef(head.with, head.n, from) : true;
    const decimals = d !== undefined && /^0x[0-9a-f]{64}$/.test(d) ? Number(BigInt(d)) : NaN;
    if (!Number.isInteger(decimals) || decimals > 77) throw new Error("decimals not agreed");
    return { pool: best.c, decimals, seed: (refOk && ref) || best.c.quote.kind !== "eth" ? { from, to: head.n, headN: head.n, logs } : undefined };
  }

  /** A listed token's main pool, null when our reads find none (served as an empty chart), "unlisted" off the lists. */
  async function mainPool(token: string): Promise<Found | null | "unlisted"> {
    const kept = pools.get(token);
    if (kept !== undefined && kept.found !== null && now() - kept.at < POOL_KEEP_MS) return { ...kept.found };
    if (!(await deps.listed(token))) return "unlisted";
    if (kept !== undefined && kept.found === null && now() - kept.at < NONE_MS) return null;
    let p = resolving.get(token);
    if (p === undefined) {
      p = findPool(token).finally(() => resolving.delete(token));
      resolving.set(token, p);
    }
    const found = await p;
    if (pools.size >= POOLS_MAX) pools.delete(pools.keys().next().value!);
    pools.set(token, { found: found === null ? null : { pool: found.pool, decimals: found.decimals }, at: now() });
    return found;
  }

  // -------------------------------------------------------------------------------------------------------------
  // The books
  // -------------------------------------------------------------------------------------------------------------

  type Entry = { pool: Pool; decimals: number; book: Book; touched: number; readAt: number | null; headN: number };
  const books = new Map<string, Entry>();
  // the ETH price: its swaps over the blocks the books need
  let refEvents: Ref[] = [];
  let refTo: number | null = null;
  let refFrom: number | null = null; // the earliest block the ETH price is read from
  let refLock: Promise<unknown> = Promise.resolve();
  const traders = new Map<string, string | null>();

  /** Reads the ETH price pool's swaps up to `to`, and back to refBack before `need` (the earliest block a book reads:
   *  a book walked back further than any before has the blocks before what is held read first). One read at a time. */
  function readRef(urls: readonly string[], to: number, need = to - V.step + 1): Promise<boolean> {
    const run = refLock.then(() => readRefNow(urls, to, need));
    refLock = run.catch(() => undefined);
    return run;
  }
  async function readRefNow(urls: readonly string[], to: number, need: number): Promise<boolean> {
    const want = need - V.refBack;
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
  async function walk(urls: readonly string[], filter: (lo: number, hi: number) => Record<string, unknown>, to: number, want: number, count: (logs: Log[]) => number, start = to - V.cold + 1): Promise<{ from: number; logs: Log[] } | null> {
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
    for (const l of logs) {
      if (l.block < from || l.block > to) return false;
      const s = decodeSwap(e.pool, l, chain);
      if (s === null) continue;
      // a swap is timed by its block: never 0, never before an earlier block's time
      const t = timeOf(l);
      if (t === null || t < last) return false;
      last = t;
      events.push({ ...s, t });
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
      const w = await walk(urls, (lo, hi) => swapFilter(e.pool, lo, hi, chain), head.n, TRADES_MAX, (part) => part.filter((l) => decodeSwap(e.pool, l, chain) !== null).length);
      if (w == null || (e.pool.quote.kind === "eth" && !((await refReady) && (await readRef(urls, head.n, w.from))))) return false;
      return apply(e, w.from, head.n, head.n, w.logs);
    }
    const from = e.book.settledTo + 1;
    // one tick reads at most a step, or CHUNKS_MAX spans past it; the rest is read the next tick
    const to = Math.min(head.n, from + Math.max(V.step, CHUNKS_MAX * V.span) - 1);
    if (from > to) return true;
    const logs = await agreedRange(urls, (lo, hi) => swapFilter(e.pool, lo, hi, chain), from, to);
    if (logs == null || (e.pool.quote.kind === "eth" && !(await refReady))) return false;
    return apply(e, from, to, head.n, logs);
  }

  let running: Promise<void> | null = null;
  /** The timer fired while a tick ran: the next starts as soon as it ends, never a skipped period. */
  let again = false;
  async function tick(): Promise<void> {
    for (const [t, e] of books) if (now() - e.touched > IDLE_MS) books.delete(t);
    if (books.size === 0) return;
    const head = await agreedHead();
    if (head === null) return;
    // the ETH price and the books are read at once; an ETH-quoted book is folded in only once the ETH price is read to
    // the same block, so no swap is priced by an older price (a tick of three rounds one after another outlasted 1 s)
    const needRef = [...books.values()].some((e) => e.pool.quote.kind === "eth");
    const refReady = needRef ? readRef(head.with, head.n).catch(() => false) : Promise.resolve(true);
    // the open books, READ_PARALLEL at a time: one after another a tick over a dozen tokens outlasts several blocks
    const due = [...books.values()];
    for (let i = 0; i < due.length; i += READ_PARALLEL) await Promise.all(due.slice(i, i + READ_PARALLEL).map((e) => readBook(e, head.with, head, refReady).catch(() => false)));
    await refReady;
  }
  function start(): Promise<void> {
    if (!running)
      running = tick()
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
      for (let attempt = 0; attempt < 2 && found === null; attempt++) {
        try {
          found = await mainPool(token);
          break;
        } catch {
          if (attempt === 1) return UPSTREAM;
        }
      }
      if (found === "unlisted") return NOT_FOUND;
      if (found === null) return "none";
      if (books.size >= OPEN_MAX) return limited(5, `${chain} trades open`);
      e = books.get(token);
      if (e === undefined) {
        e = { pool: found.pool, decimals: found.decimals, book: createBook({ decimals: found.decimals, quote: found.pool.quote }), touched: now(), readAt: null, headN: 0 };
        // the discovery already read the pool's newest swaps on two providers (walked back to a tape's worth or the cold
        // window): that is the book's first read
        if (found.seed !== undefined) apply(e, found.seed.from, found.seed.to, found.seed.headN, found.seed.logs);
        books.set(token, e);
      }
    }
    e.touched = now();
    ensureTimer();
    for (let attempt = 0; e.readAt === null && attempt < 2; attempt++) await start();
    if (e.readAt === null) return UPSTREAM;
    if (now() - e.readAt > STALE_MS) {
      void start();
      return UPSTREAM;
    }
    return e;
  }

  const err = (status: number, code: string): DataAnswer => ({ status, body: JSON.stringify({ error: { code } }) });
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
      if (gecko.take(p === undefined ? "pages" : "refresh")) {
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
    const got = await geckoBars({ pool: { id: p.id, token } } as Entry, tf, to);
    const bars = Array.isArray(got) ? got.filter((c) => to === null || c[0] < to).slice(-limit) : [];
    if (bars.length === 0) return none;
    const at = history.get(`${p.id}:${tf}:${to ?? ""}`)?.at ?? kept.get(`${p.id}:${tf}`)?.at ?? now();
    const body = { tf, candles: bars, src: "geckoterminal", as_of_ms: at };
    return { status: 200, body: JSON.stringify(body), src: "geckoterminal", asOfMs: at };
  }

  /** The last good bars per pool and tf (the newest range read): served when a read is throttled or fails. */
  const kept = new Map<string, { at: number; bars: Candle[] }>();
  /** GeckoTerminal's bars before `before` (unix seconds; null: its newest range, one cache key however often asked),
   *  or, when the read is refused, throttled or fails, the last good bars of the pool and tf cut there; with none of
   *  those, the 429 (with the wait to the next call) or 503 to answer. */
  async function geckoBars(e: Entry, tf: Tf, before: number | null): Promise<Candle[] | DataAnswer> {
    if (!Object.hasOwn(GT_TF, tf) || deps.gecko === undefined) return [];
    const gecko = deps.gecko;
    const k = `${e.pool.id}:${tf}:${before ?? ""}`;
    const fresh = history.get(k);
    if (fresh !== undefined && now() - fresh.at < GT_FRESH_MS) return fresh.bars;
    const fallback = (fail: DataAnswer): Candle[] | DataAnswer => {
      if (fresh !== undefined && fresh.bars.length > 0) return fresh.bars;
      const cut = (kept.get(`${e.pool.id}:${tf}`)?.bars ?? []).filter((c) => before === null || c[0] < before);
      return cut.length > 0 ? cut : fail;
    };
    const wait = (why = "geckoterminal budget") => limited(Math.min(Math.max(Math.ceil((gecko.retryAt("pages") - now()) / 1000), 1), RETRY_AFTER_MAX_S), why);
    // a re-read of bars held is a refresh (../gecko.ts): it leaves a cold page its calls, and refused, the bars held are
    // served (card app-console-429); the newest range is a page read once its kept bars are REFRESH_URGENT_MS old, so
    // the lists' calls never leave it served the same bars for good (refreshLane, card helper-chart-fresh); history
    // before a time stays a refresh
    const lane = before === null ? refreshLane(kept.get(`${e.pool.id}:${tf}`)?.at ?? fresh?.at ?? null, now()) : fresh !== undefined ? "refresh" : "pages";
    if (!gecko.take(lane)) return fallback(wait(lane === "refresh" ? "geckoterminal refresh" : undefined));
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

  /** Traders of the txs, the sender of each (06c §4.12), read in batches of 10 from the first provider that answers; a
   *  tx whose read fails stays null this time and is asked again the next. */
  async function tradersOf(txs: string[]): Promise<void> {
    const need = [...new Set(txs)].filter((t) => !traders.has(t));
    if (need.length === 0) return;
    for (const u of usable(rpcs)) {
      const r = await batchTo(u, need.map((t) => ({ method: "eth_getTransactionByHash", params: [t] })));
      if (r === null) continue;
      need.forEach((t, i) => {
        const x = r[i];
        const tx = x?.ok ? obj(x.result) : null;
        const from = tx === null ? null : evmAddress(tx.from);
        if (tx !== null && typeof tx.hash === "string" && tx.hash.toLowerCase() === t && from !== null) {
          if (traders.size >= TRADERS_MAX) traders.delete(traders.keys().next().value!);
          traders.set(t, from);
        }
      });
      return;
    }
  }

  return {
    tick: start,
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    /** 06b Candles for a listed Base token: our own bars, and GeckoTerminal's before our first. */
    async candles(token: string, tf: string, to: number | null, limit: number): Promise<DataAnswer> {
      const t = evmAddress(token);
      if (t === null || !(TFS as readonly string[]).includes(tf) || tf === "1s" || !Number.isSafeInteger(limit) || limit < 1 || limit > CANDLES_MAX) return NOT_FOUND;
      const e = await open(t);
      if (e === "none") return noneCandles(t, tf as Tf, to, limit);
      if (!("book" in e)) return e;
      const own = e.book.candles(tf as Tf, to, limit);
      const ownFrom = e.book.ownFrom(tf as Tf);
      let bars: Candle[] = own;
      let src = "chain";
      // a range we do not hold: bars before our first
      if (own.length < limit) {
        const before = ownFrom === null ? (to ?? Math.floor(now() / 1000)) : Math.min(ownFrom, to ?? ownFrom);
        const got = await geckoBars(e, tf as Tf, ownFrom === null ? to : before);
        // nothing of ours and no history to serve: GeckoTerminal's 429 or 503, so the page retries, never an empty chart
        if (!Array.isArray(got) && own.length === 0) return got;
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
      return { status: 200, body: JSON.stringify(body), src, asOfMs: at };
    },
    /** 06b Trades: the newest `limit` swaps, newest first. */
    async trades(token: string, limit: number): Promise<DataAnswer> {
      const t = evmAddress(token);
      if (t === null || !Number.isSafeInteger(limit) || limit < 1 || limit > TRADES_MAX) return NOT_FOUND;
      const e = await open(t);
      if (e === "none") return empty({ trades: [] });
      if (!("book" in e)) return e;
      const rows = e.book.tape(limit);
      await tradersOf(rows.map((r) => r.tx));
      const at = e.readAt ?? now();
      const trades = rows.map((r) => ({ t_ms: r.t_ms, side: r.side, usd: r.usd, amt: r.amt, trader: traders.get(r.tx) ?? null, tx: r.tx }));
      return { status: 200, body: JSON.stringify({ trades, src: "chain", as_of_ms: at }), src: "chain", asOfMs: at };
    },
  };
}
export type EvmSwaps = ReturnType<typeof createSwaps>;
