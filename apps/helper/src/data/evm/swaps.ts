// The EVM token page's candles and trade tape from the helper's own chain reads (card index-evm-swaps; markets paper 06b
// §6.1 `Candles` and `Trades`, 06c §4.12): GET /v1/market/candles and /v1/market/trades with chain=base. No vendor key and no
// vendor limit: the swaps are read from the chain, priced by ../candles.ts (the one pricing rule is in its header) and
// served from memory.
//
// The main pool. A listed token is priced from the pool of a supported venue that carried most of its swaps in the last
// DISCOVER_BLOCKS blocks, found on chain and kept (POOL_KEEP_MS): the token's Transfer logs over those blocks (two
// providers that agree) name the addresses that held and moved it; each is checked on chain, never taken on a vendor's
// word. A v2, v3 or Slipstream pool counts when its factory() is one of the venues below and its token0() and token1()
// are the token and USDC or WETH; a v4 pool counts when its key hashes to the pool id (keccak256 of the key, the id the
// PoolManager logs) and pairs the token with USDC, WETH or ETH: the key is the PositionManager's poolKeys() when it knows
// the pool, and for a pool it never made (Doppler) v4Key works the key out from the swap's fee and the addresses in its
// transaction, trusted only when the hash equals the id. A token with
// no such pool (Zora's creator-coin pairs, a cbBTC or VIRTUAL pair, a venue not listed here: slice 2 of the card) answers
// 404, never a guess.
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
// A provider that lags (more than LAG_MAX blocks behind the other) is passed over for the third; one that refuses (429,
// -32005, a limit message) is held for the wait it names (the helper's RPC rules, ../../rpc/rpc.ts); an answer over
// ANSWER_MAX bytes or not JSON is a failure. A tick that cannot agree changes nothing; the book keeps serving what it
// holds until STALE_MS, then the routes answer 503.
//
// Block times come from Base's fixed clock (BLOCK_CLOCK, lists.ts): checked against each tick's newest block on both
// providers, and a tick whose block disagrees with the clock reads nothing.
//
// Display only: nothing here feeds a signature. Every provider value is hostile input: a log counts only when its
// emitter, topic0, topic count and data length match the venue exactly; an amount must fit its type and its legs have
// opposite signs; counts, ranges and the books are bounded.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createBook, TFS, type Book, type Candle, type Event, type Ref, type Swap, type Tf } from "../candles.ts";
import { throttledUntil, type GeckoBudget } from "../gecko.ts";
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
/** Selectors: token0(), token1(), factory(), decimals(), and the PositionManager's poolKeys(bytes25). */
const SEL = { token0: "0x0dfe1681", token1: "0xd21220a7", factory: "0xc45a0155", decimals: "0x313ce567", poolKeys: "0x86b6be7d" } as const;
/** The ETH price: Uniswap v4's native ETH / USDC 0.05% pool (tick spacing 10, no hook), the one BuyV4Fork.t.sol buys through.
 *  Its id is keccak256(abi.encode(currency0 0x0, currency1 USDC, fee 500, tickSpacing 10, hooks 0x0)); 7 swaps in 100
 *  blocks read 2026-11-03 17:08Z, the last at 2,295.6 USD per ETH. */
export const REF_POOL_ID = "0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a";

/** Base's providers for the swap read, public and keyless, measured 2026-11-03 17:02Z: `eth_getLogs` for one pool over 1,000
 *  blocks answered by base-rpc.publicnode.com (457 ms) and base.gateway.tenderly.co (582 ms); base.drpc.org up to 10,000
 *  blocks but batches of 3; mainnet.base.org "request limit reached"; base-mainnet.public.blastapi.io at most 10 blocks;
 *  1rpc.io 50 blocks. */
export const SWAP_RPCS: Readonly<Record<EvmChain, readonly string[]>> = {
  base: ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co", "https://base.drpc.org", "https://base-pokt.nodies.app"],
  robinhood: [],
};

/** Requests per JSON-RPC batch each provider takes: the maker read's (lists.ts BATCH_MAX: drpc's free plan 3), and
 *  Tenderly's gateway 4 (a batch of 10 `eth_call` answered HTTP 429 -32005 "rate limit exceeded", 2026-11-03 17:2xZ). */
const BATCH_SIZE: Readonly<Record<string, number>> = { ...BATCH_MAX, "https://base.gateway.tenderly.co": 4 };

/** Blocks read again every tick, and so the blocks an agreed head must be ahead of a settled block. Base's sequencer can
 *  reorg a few unsafe blocks; its `safe` head trails by about 40 s (proofs/evm-safe-lag, 20 blocks), so 10 re-read blocks
 *  are enough for the reorgs seen and the live tape stays within seconds. */
export const REWIND_BLOCKS = 10;
/** The blocks a token's first read goes back: 200 on Base, 06c §4.12's cold open. */
export const COLD_BLOCKS = 600;
/** The blocks of a token's Transfer logs its main pool is found from. */
export const DISCOVER_BLOCKS = 600; // the book's first read is the discovery's own: the same window as COLD_BLOCKS
/** The addresses of a token's transfers checked as pools, busiest first, and the v4 pools checked. */
const CANDIDATES_MAX = 6;
const V4_TXS = 3;
/** A token's main pool is looked for again after this. */
export const POOL_KEEP_MS = 6 * 3_600_000;
/** The blocks the ETH price's first read goes back, so that a swap in the cold window has one before it. */
export const REF_COLD_BLOCKS = 2_000;
/** The most blocks one `eth_getLogs` asks, and the most such reads one tick makes for a token. */
export const SPAN_MAX = 1_000;
const CHUNKS_MAX = 3;
/** Providers asked for one answer at most: two, and two more when they differ. */
const PROVIDERS_MAX = 4;
/** A provider this many blocks behind the other is passed over for the third. */
export const LAG_MAX = 10;
/** A token nobody asked for this long stops being read (its book is dropped). */
export const IDLE_MS = 60_000;
/** The tick period: Base's block time. */
export const TICK_MS = 2_000;
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
export function v4Key(id: string, token: string, swapFee: number, around: readonly string[]): string | null {
  const w = (n: bigint): string => n.toString(16).padStart(64, "0");
  const a = (x: string): string => x.slice(2).padStart(64, "0");
  const hooks = [ZERO, ...around.filter((x) => x !== token && x !== BASE_VENUES.poolManager && x !== BASE_VENUES.weth && x !== BASE_VENUES.usdc).slice(0, HOOKS_MAX)];
  const fees = [...new Set([swapFee, DYNAMIC_FEE, 100, 500, 2500, 3000, 10000])];
  const spacings = [...TICK_SPACINGS, ...Array.from({ length: TICK_SPACING_MAX }, (_, i) => i + 1).filter((t) => !TICK_SPACINGS.includes(t))];
  for (const other of [ZERO, BASE_VENUES.weth, BASE_VENUES.usdc]) {
    const [c0, c1] = token < other ? [token, other] : [other, token];
    for (const ts of spacings) for (const h of hooks) for (const f of fees) {
      const k = `0x${a(c0)}${a(c1)}${w(BigInt(f))}${w(BigInt(ts))}${a(h)}`;
      if (keccakHex(k) === id) return k;
    }
  }
  return null;
}

export type Log = { block: number; index: number; tx: string; address: string; topics: string[]; data: string };
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
  return { block, index, tx, address, topics: ts, data };
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

const key = (l: Log) => `${l.block}:${l.index}:${l.tx}:${l.address}:${l.topics.join(",")}:${l.data}`;
/** Whether two providers' answers for one filter are the same logs. */
export const sameLogs = (a: Log[], b: Log[]): boolean => a.length === b.length && a.every((l, i) => key(l) === key(b[i]!));

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
  venue: "v4" | "v3" | "v2";
  /** A pool's address, or a v4 pool's id (what GeckoTerminal calls the pool). */
  id: string;
  token: string;
  tokenIs0: boolean;
  quote: { kind: "usd" | "eth"; decimals: number };
};

/** The `eth_getLogs` filter for a pool's swaps over blocks `from` to `to`. */
export function swapFilter(pool: Pick<Pool, "venue" | "id">, from: number, to: number): Record<string, unknown> {
  const range = { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
  if (pool.venue === "v4") return { address: BASE_VENUES.poolManager, topics: [TOPIC.swap4, pool.id], ...range };
  return { address: pool.id, topics: [pool.venue === "v3" ? TOPIC.swap3 : TOPIC.swap2], ...range };
}
const refFilter = (from: number, to: number) => swapFilter({ venue: "v4", id: REF_POOL_ID }, from, to);

const TWO_192 = 1n << 192n;
/** A swap log of the ETH price pool as the ETH price it leaves, or null: USD per ETH times 10^18 from the pool's price
 *  after the swap (sqrtPriceX96 squared over 2^192 is USDC units per wei; times 10^12 for USD per ETH; times 10^18). */
export function decodeRef(l: Log): Ref | null {
  if (l.address !== BASE_VENUES.poolManager || l.topics.length !== 3 || l.topics[0] !== TOPIC.swap4 || l.topics[1] !== REF_POOL_ID || l.data.length !== 2 + 64 * 6) return null;
  const sqrt = unsigned(word(l.data, 2), 160);
  if (sqrt === null || sqrt === 0n) return null;
  const ethUsd = (sqrt * sqrt * 10n ** 30n) / TWO_192;
  // 1 to 10,000,000 USD per ETH: outside is not ETH's price
  if (ethUsd < 10n ** 18n || ethUsd > 10n ** 25n) return null;
  return { kind: "ref", block: l.block, index: l.index, ethUsd };
}

/** A swap log of `pool` as a Swap (its `t` is set by the caller), or null when it is not one. The pool's deltas: v3 as
 *  logged; v4 the swapper's, negated; v2 in minus out. Side is `b` when the pool paid the token out. */
export function decodeSwap(pool: Pool, l: Log): Omit<Swap, "t"> | null {
  let d0: bigint | null;
  let d1: bigint | null;
  if (pool.venue === "v4") {
    if (l.address !== BASE_VENUES.poolManager || l.topics.length !== 3 || l.topics[0] !== TOPIC.swap4 || l.topics[1] !== pool.id || l.data.length !== 2 + 64 * 6) return null;
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

export function createSwaps(chain: EvmChain, deps: { fetch?: Fetch; now?: () => number; listed: (token: string) => Promise<boolean>; gecko?: GeckoBudget; rpcs?: readonly string[]; pools?: ReadonlyMap<string, { pool: Pool; decimals: number }>; tickMs?: number }) {
  if (chain !== "base") throw new Error("swaps: only Base is served");
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const rpcs = deps.rpcs ?? SWAP_RPCS[chain];
  const clock = BLOCK_CLOCK[chain]!;
  const held = new Map<string, number>(); // provider -> held until (ms)

  /** One JSON-RPC batch to a provider: each call's reply, or the wait a refusal names; null when it failed. */
  async function batchTo(url: string, calls: Call[]): Promise<Reply[] | null> {
    const max = BATCH_SIZE[url] ?? 10;
    const parts: Call[][] = [];
    for (let i = 0; i < calls.length; i += max) parts.push(calls.slice(i, i + max));
    const got = await Promise.all(parts.map((part) => one(url, part)));
    return got.some((g) => g === null) ? null : got.flat() as Reply[];
  }

  /** One JSON-RPC batch (at most the provider's batch size) to a provider. */
  async function one(url: string, part: Call[]): Promise<Reply[] | null> {
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
        held.set(url, now() + upstreamRetryAfterS(r.headers, now()) * 1000);
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
    if (ok.length > 2 && (first.length < 2 || Math.abs(first[0]!.n - first[1]!.n) > LAG_MAX)) await read(ok.slice(2, 3));
    const sorted = [...heads].sort((a, b) => b[1].n - a[1].n);
    if (sorted.length < 2) return null;
    const agreed = sorted[1]![1].n; // the newest block at least two providers have
    const withIt = sorted.filter(([, h]) => h.n >= agreed).map(([u]) => u);
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
        return idx.map((_, k) => (r?.[k]?.ok ? parseLogs((r[k] as { result: unknown }).result) : null));
      },
      sameLogs,
    );
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
    const V = BASE_VENUES;
    const head = await agreedHead();
    if (head === null) throw new Error("no agreed head");
    const from = head.n - DISCOVER_BLOCKS + 1;
    const [tlogs] = await agreedLogs(head.with, [{ address: token, topics: [TOPIC.transfer], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${head.n.toString(16)}` }]);
    if (tlogs == null) throw new Error("transfers not agreed");
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
      return f !== null && (f === V.aerodromeV2 || f === V.uniswapV3 || (V.slipstream as readonly string[]).includes(f));
    });
    const pairs = await callsAgreed(head.n, ofVenue.flatMap((a) => [SEL.token0, SEL.token1].map((data) => ({ to: a, data }))));
    ofVenue.forEach((a, i) => {
      const [f, t0, t1] = [wordAddr(factories[top.indexOf(a)]), wordAddr(pairs[2 * i]), wordAddr(pairs[2 * i + 1])];
      if (f === null || t0 === null || t1 === null) return;
      const isV2 = f === V.aerodromeV2;
      const tokenIs0 = t0 === token;
      if (!tokenIs0 && t1 !== token) return;
      const other = tokenIs0 ? t1 : t0;
      const quote = other === V.usdc ? ({ kind: "usd", decimals: 6 } as const) : other === V.weth ? ({ kind: "eth", decimals: 18 } as const) : null;
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
          k = v4Key(id, token, e.fee, [...e.around]) ?? undefined; // the key must hash to the id
        }
        if (k === undefined) return;
        const [c0, c1] = [wordAddr(k, 0)!, wordAddr(k, 1)!];
        const tokenIs0 = c0 === token;
        if (!tokenIs0 && c1 !== token) return;
        const other = tokenIs0 ? c1 : c0;
        const quote = other === V.usdc ? ({ kind: "usd", decimals: 6 } as const) : other === V.weth || other === ZERO ? ({ kind: "eth", decimals: 18 } as const) : null;
        if (quote !== null) cands.push({ venue: "v4", id, token, tokenIs0, quote });
      });
    }
    if (cands.length === 0) return null;
    // the pool with most swaps in the window is the main pool (ties: the lower id); its logs are the book's first read
    const [swaps, [d], refOk] = await Promise.all([
      agreedLogs(head.with, cands.map((c) => swapFilter(c, from, head.n))),
      callsAgreed(head.n, [{ to: token, data: SEL.decimals }]),
      cands.some((c) => c.quote.kind === "eth") ? readRef(head.with, head.n) : Promise.resolve(true),
    ]);
    const score = cands.map((c, i) => (swaps[i] == null ? -1 : swaps[i]!.filter((l) => decodeSwap(c, l) !== null).length));
    if (score.every((x) => x < 0)) throw new Error("swaps not agreed");
    const best = cands.map((c, i) => ({ c, i, n: score[i]! })).sort((x, y) => y.n - x.n || (x.c.id < y.c.id ? -1 : 1))[0]!;
    if (best.n <= 0) return null;
    const decimals = d !== undefined && /^0x[0-9a-f]{64}$/.test(d) ? Number(BigInt(d)) : NaN;
    if (!Number.isInteger(decimals) || decimals > 77) throw new Error("decimals not agreed");
    return { pool: best.c, decimals, seed: refOk || best.c.quote.kind !== "eth" ? { from, to: head.n, headN: head.n, logs: swaps[best.i]! } : undefined };
  }

  async function mainPool(token: string): Promise<Found | null> {
    const kept = pools.get(token);
    if (kept !== undefined && now() - kept.at < (kept.found === null ? NONE_MS : POOL_KEEP_MS)) return kept.found === null ? null : { ...kept.found };
    if (!(await deps.listed(token))) return null;
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
  const traders = new Map<string, string | null>();

  /** Reads the ETH price pool's swaps up to `to` (once per tick, shared). */
  async function readRef(urls: readonly string[], to: number): Promise<boolean> {
    const from = refTo === null ? to - REF_COLD_BLOCKS + 1 : refTo + 1 - REWIND_BLOCKS;
    if (from > to) return true;
    let events = refEvents.filter((e) => e.block < from);
    for (let lo = from; lo <= to; lo += SPAN_MAX) {
      const hi = Math.min(to, lo + SPAN_MAX - 1);
      const [logs] = await agreedLogs(urls, [refFilter(lo, hi)]);
      if (logs == null) return false;
      events = events.concat(logs.map(decodeRef).filter((r): r is Ref => r !== null));
    }
    // kept: the last REF_COLD_BLOCKS blocks, so a book's first swaps always have a price before them
    refEvents = events.filter((e) => e.block > to - REF_COLD_BLOCKS);
    refTo = to;
    return true;
  }

  /** Folds the logs of blocks `from` to `to` (read up to the agreed block `headN`) into a book; false when a log lies outside them
   *  or an ETH-quoted swap has no ETH price before it yet (the caller reads again). */
  function apply(e: Entry, from: number, to: number, headN: number, logs: Log[]): boolean {
    const events: Event[] = [];
    for (const l of logs) {
      if (l.block < from || l.block > to) return false;
      const s = decodeSwap(e.pool, l);
      if (s !== null) events.push({ ...s, t: clock.genesisS + clock.blockS * s.block });
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

  /** One book's read up to the agreed head: its pool's swaps (and the ETH price's) from where it is settled. */
  async function readBook(e: Entry, urls: readonly string[], head: { n: number; t: number }): Promise<boolean> {
    const first = e.book.settledTo < 0 && e.readAt === null;
    let from = first ? head.n - COLD_BLOCKS + 1 : e.book.settledTo + 1;
    for (let chunks = 0; from <= head.n && chunks < CHUNKS_MAX; chunks++) {
      const to = Math.min(head.n, from + SPAN_MAX - 1);
      const [logs] = await agreedLogs(urls, [swapFilter(e.pool, from, to)]);
      if (logs == null || !apply(e, from, to, head.n, logs)) return false;
      from = to + 1;
    }
    return true;
  }

  let running: Promise<void> | null = null;
  async function tick(): Promise<void> {
    for (const [t, e] of books) if (now() - e.touched > IDLE_MS) books.delete(t);
    if (books.size === 0) return;
    const head = await agreedHead();
    if (head === null) return;
    // an ETH-quoted book is read only once the ETH price is read to the same block, so no swap is priced by an older price
    const needRef = [...books.values()].some((e) => e.pool.quote.kind === "eth");
    const refOk = !needRef || (await readRef(head.with, head.n));
    // the open books, READ_PARALLEL at a time: one after another a tick over a dozen tokens outlasts several blocks
    const due = [...books.values()].filter((e) => e.pool.quote.kind !== "eth" || refOk);
    for (let i = 0; i < due.length; i += READ_PARALLEL) await Promise.all(due.slice(i, i + READ_PARALLEL).map((e) => readBook(e, head.with, head).catch(() => false)));
  }
  function start(): Promise<void> {
    if (!running) running = tick().catch(() => undefined).finally(() => (running = null));
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
      void start();
    }, deps.tickMs ?? TICK_MS);
    timer.unref();
  }

  /** The book of a listed token, read once before it is served (a first open waits for its cold read). */
  async function open(token: string): Promise<Entry | DataAnswer> {
    let e = books.get(token);
    if (e === undefined) {
      let found: Found | null = null;
      for (let attempt = 0; attempt < 2 && found === null; attempt++) {
        try {
          found = await mainPool(token);
          break;
        } catch {
          if (attempt === 1) return UPSTREAM;
        }
      }
      if (found === null) return NOT_FOUND;
      if (books.size >= OPEN_MAX) return limited(5);
      e = books.get(token);
      if (e === undefined) {
        e = { pool: found.pool, decimals: found.decimals, book: createBook({ decimals: found.decimals, quote: found.pool.quote }), touched: now(), readAt: null, headN: 0 };
        // the discovery already read the pool's last COLD_BLOCKS blocks on two providers: that is the book's first read
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
  const limited = (s: number): DataAnswer => ({ ...err(429, "rate_limited"), retryAfterS: s });

  // -------------------------------------------------------------------------------------------------------------
  // History before our first bar: GeckoTerminal's OHLCV for our pool, through the one budget
  // -------------------------------------------------------------------------------------------------------------

  const history = new Map<string, { at: number; bars: Candle[] }>();
  async function geckoBars(e: Entry, tf: Tf, before: number): Promise<Candle[]> {
    if (!Object.hasOwn(GT_TF, tf) || deps.gecko === undefined) return [];
    const k = `${e.pool.id}:${tf}:${before}`;
    const kept = history.get(k);
    if (kept !== undefined && now() - kept.at < GT_FRESH_MS) return kept.bars;
    if (!deps.gecko.take("pages")) return [];
    try {
      const g = GT_TF[tf as keyof typeof GT_TF];
      const url = `${GT_BASE}/networks/${chain}/pools/${e.pool.id}/ohlcv/${g.period}?aggregate=${g.aggregate}&limit=1000&currency=usd&token=${e.pool.token}&before_timestamp=${before}`;
      const r = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (r.status === 429) {
        await r.body?.cancel();
        throttledUntil(deps.gecko, r.headers.get("retry-after"), now());
        return [];
      }
      if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) {
        await r.body?.cancel();
        return [];
      }
      const text = await r.text();
      if (text.length > ANSWER_MAX) return [];
      const bars = toCandles(JSON.parse(text), tf as keyof typeof GT_TF, 1_000, now()) ?? [];
      if (history.size >= 500) history.delete(history.keys().next().value!);
      history.set(k, { at: now(), bars });
      return bars;
    } catch {
      return [];
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
      if (!("book" in e)) return e;
      const own = e.book.candles(tf as Tf, to, limit);
      const ownFrom = e.book.ownFrom(tf as Tf);
      let bars: Candle[] = own;
      let src = "chain";
      // a range we do not hold: bars before our first
      if (own.length < limit) {
        const before = ownFrom === null ? (to ?? Math.floor(now() / 1000)) : Math.min(ownFrom, to ?? ownFrom);
        const old = (await geckoBars(e, tf as Tf, before)).filter((c) => c[0] < before);
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
