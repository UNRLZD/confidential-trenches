// A USD amount in the pool asset's base units, from the device's own price reads (card kit-pool-tap-inputs). The trade
// box shows USD; the tap spends the pool's asset. A price a server hands over could make a USD tap spend far more than
// meant, so the price is read here, on chain, on two RPCs of two providers that must agree, and refused when it is
// stale, disagreeing, malformed or unsure. Never a server's price.
//
// - Solana (the pool holds wrapped SOL, 9 decimals): SOL/USD from Pyth's sponsored price feed account, a PriceUpdateV2
//   of the Pyth Solana Receiver. Both RPCs are asked with getMultipleAccounts at commitment confirmed; their answers
//   must be the same owner and the same bytes. Two providers rarely answer at one context slot (one read on 4 Nov
//   07:40Z answered slots 465221311 and 465221313), so the agreed slot is the one the bytes carry: posted_slot, the
//   slot the update landed in, at or before each answer's own slot. Bytes that differ are read again on both at
//   minContextSlot = the newer slot, POOL_USD_READ_ROUNDS reads in all; still different is a refusal.
// - A slow or lagging provider (card signpage-price-read-retry): an answer of RPC error -32016 "Minimum context slot has
//   not been reached" (a provider behind the slot asked for, which catches up in a slot or two) or no answer in one
//   try's bound is asked again of that provider alone, with the same params (so at the same minContextSlot), after
//   POOL_USD_RETRY_BACKOFF_MS doubled per try, all inside one read's POOL_USD_READ_DEADLINE_MS, every round and both
//   feeds of a Robinhood read in that one bound. A read that ends, failed or not, asks no provider again: one provider's
//   refusal stops the other's retries. Read on 4 Nov 22:00Z and
//   22:25Z (sign live runs 41920575578, 41924297260): one try at solana-rpc.publicnode.com answered nothing in 3500 ms,
//   and one answered -32016; each failed the whole read. Only the asking is repeated: both providers must still answer,
//   and agree, before a price is used.
// - Base and Robinhood (the pools hold native ETH, 18 decimals): ETH/USD from the chain's own Chainlink feed, decimals()
//   and latestRoundData() by eth_call on both RPCs at one block number, the lower of their two eth_blockNumber heads
//   (each has it; never "latest" on each). That block must be one block on both (eth_getBlockByNumber: the same hash and
//   time) and its time within POOL_USD_BLOCK_MAX_AGE_S of the device's clock, so one RPC answering a low head cannot
//   pick an older round. Every word must be the same on both. Robinhood has its own Chainlink ETH/USD
//   feed (read below), so it is read there, not on Base. Its heartbeat is 24 h, so a halted feed would pass the age
//   check for up to a day: the same call reads Base's ETH/USD too (its 1200 s heartbeat, on Base's two RPCs) and refuses
//   a Robinhood price more than POOL_USD_CROSS_BPS from it. The two feeds' deviation thresholds are 0.5% and 0.15%.
// - Age: told as the read returns, the device's clock given at its start moved on by the time the read ran, so a price
//   inside its bound at the start and past it by the end is refused.
// - Rounding: down, to the asset's base unit. A tap never spends more than the USD asked.
//
// Read on 4 Nov 2026, 07:40-07:45Z:
// - Pyth SOL/USD: 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE by getAccountInfo on api.mainnet-beta.solana.com
//   (slot 465221311) and solana-rpc.publicnode.com (slot 465221313): the same 134 bytes on both, owner
//   rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ (the Pyth Solana Receiver), discriminator 22f123639d7ef4cd =
//   sha256("account:PriceUpdateV2")[0..8], write authority the account itself, verification Full, feed id
//   ef0d8b6f...c280b56d (SOL/USD), price 9301048308 at exponent -8 ($93.01), conf 9140354 (0.098% of the price),
//   publish_time 07:40:06Z, posted_slot 465221304. The address is the push oracle pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT's
//   program address of [shard 0 as u16 LE, feed id] (test/pool-usd.test.ts derives it).
// - Chainlink ETH/USD on Base (chain id 0x2105): 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70 on base-rpc.publicnode.com,
//   mainnet.base.org and base.drpc.org: description() "ETH / USD", decimals() 8, aggregator()
//   0x05c84a58fe042275b37db038baacd15f410c7bb0, the same words on all three. Chainlink's directory
//   (reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json) lists it as ETH / USD's proxy (ens
//   eth-usd) over that aggregator: heartbeat 1200 s, deviation 0.15%. Its last 40 rounds: at most 1230 s apart.
// - Chainlink ETH/USD on Robinhood (chain id 0x1237): 0x5058aDee53b04e374d8bEDbAD634Bc4778F50b22 on
//   robinhood-rpc.publicnode.com and robinhood.drpc.org: description() "ETH / USD", decimals() 8, aggregator()
//   0x6091e64eb7138eef066a80fd3a0d7427b91f2721, the same on both. The directory (feeds-robinhood-mainnet.json) lists it
//   as ETH / USD's proxy over that aggregator: heartbeat 86400 s, deviation 0.5%. Its last 60 rounds: at most 37181 s
//   apart.
import { base58 } from "@scure/base";
import type { Chain } from "../orders/record.ts";
import { POOL_ASSET_DECIMALS, type PoolAsset } from "../signpage/messages.ts";
import { solanaParseAccountsAnswer } from "../trade/solana/pool.ts";
import { SolanaRpcTransportError, solanaSameProvider, solanaTimedRpc, type SolanaRpc } from "../trade/solana/send.ts";

/** A price at most this far ahead of the device's clock is used: further, the clock is wrong and no age can be told. */
export const POOL_USD_MAX_AHEAD_S = 60;
/** Reads of the Pyth account on both RPCs before two answers that still differ are refused. */
export const POOL_USD_READ_ROUNDS = 3;
/** Robinhood's ETH/USD is used only within this many bps of Base's, read in the same call: the two feeds' deviation
 * thresholds (0.5% and 0.15%) with room for one round each. */
export const POOL_USD_CROSS_BPS = 100n;
/** The Chainlink reads' block (the lower of the two RPCs' heads) is used only this close to the device's clock, either
 * way: one RPC that answers a low head can pick no older block, so no older round. */
export const POOL_USD_BLOCK_MAX_AGE_S = 60;
/** One try of one RPC call's bound. */
export const POOL_USD_CALL_TIMEOUT_MS = 5_000;
/** One read's bound, every try and wait of every call in it counted: a try that answers nothing in its bound, a backoff,
 * and a second try fit in it, with room for a third. */
export const POOL_USD_READ_DEADLINE_MS = 12_000;
/** The wait before a call that a provider was slow or behind on is asked again of it, doubled per try of that call. */
export const POOL_USD_RETRY_BACKOFF_MS = 250;

export type PoolUsdPythFeed = {
  readonly kind: "pyth";
  readonly asset: PoolAsset;
  /** The PriceUpdateV2 account read. */
  readonly account: string;
  /** Its owner: the Pyth Solana Receiver. */
  readonly owner: string;
  /** The push oracle whose program address the account is (shard 0); the account's write authority is itself. */
  readonly pushOracle: string;
  /** Pyth's SOL/USD price feed id, 0x and 64 hex. */
  readonly feedId: string;
  /** Pyth's own guidance for a price read on chain: no older than 60 s (its SDK's get_price_no_older_than). */
  readonly maxAgeS: number;
  /** conf at most this share of the price, in bps: the read's 0.098% with ten times the room. Wider, Pyth's
   * publishers disagree and the price is unsure. */
  readonly maxConfBps: number;
};
export type PoolUsdChainlinkFeed = {
  readonly kind: "chainlink";
  readonly asset: PoolAsset;
  /** eth_chainId, 0x hex. */
  readonly chainId: string;
  /** The feed's proxy (EACAggregatorProxy). */
  readonly proxy: string;
  /** The feed's heartbeat (Chainlink's directory) with 300 s for a late round and the device's clock. */
  readonly maxAgeS: number;
};

/** The price read per chain whose pool has a USD price. NEAR's vault holds USDC: none. */
export const POOL_USD_FEEDS: {
  readonly solana: PoolUsdPythFeed;
  readonly base: PoolUsdChainlinkFeed;
  readonly robinhood: PoolUsdChainlinkFeed;
} = Object.freeze({
  solana: Object.freeze({
    kind: "pyth",
    asset: "SOL",
    account: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
    owner: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
    pushOracle: "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT",
    feedId: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    maxAgeS: 60,
    maxConfBps: 100,
  } as const),
  // heartbeat 1200 s; the last 40 rounds read were at most 1230 s apart
  base: Object.freeze({ kind: "chainlink", asset: "ETH", chainId: "0x2105", proxy: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", maxAgeS: 1_500 } as const),
  // heartbeat 86400 s; the last 60 rounds read were at most 37181 s apart
  robinhood: Object.freeze({ kind: "chainlink", asset: "ETH", chainId: "0x1237", proxy: "0x5058aDee53b04e374d8bEDbAD634Bc4778F50b22", maxAgeS: 86_700 } as const),
});
export type PoolUsdChain = keyof typeof POOL_USD_FEEDS;

/** A price the device read: one `asset` is price x 10^expo USD; `decimals` is the asset's (POOL_ASSET_DECIMALS). */
export type PoolUsdPrice = {
  chain: PoolUsdChain;
  asset: PoolAsset;
  decimals: number;
  price: bigint;
  expo: number;
  /** When the price was made, unix seconds (Pyth's publish_time, Chainlink's updatedAt). */
  publishedS: number;
  source: "pyth" | "chainlink";
  /** Where both RPCs agreed: Pyth's posted_slot, or the Chainlink read's block number. */
  at: bigint;
};

export type PoolUsdArgs = {
  chain: Chain;
  /** Two RPCs of two providers on that chain (solanaJsonRpc speaks any JSON-RPC); one provider twice is refused. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The device's clock, unix ms: Date.now() when not given. */
  nowMs?: number;
  /** Robinhood only, and needed there: two RPCs of two providers on Base, whose ETH/USD holds Robinhood's to it. */
  baseRpcs?: readonly [SolanaRpc, SolanaRpc];
};

const fail = (why: string): never => {
  throw new Error(why);
};

/** A try that answered nothing in its bound. */
class NoAnswer extends Error {}
/** RPC error -32016 "Minimum context slot has not been reached", as the kit's solanaJsonRpc words it: the provider is
 *  behind the slot asked for. */
const behind = (e: unknown): boolean => e instanceof Error && e.message.startsWith("RPC error -32016:");
/** No answer in a try's bound: this read's own, or the provider's client's (solanaJsonRpc with retry, as the signing page
 *  makes it, ends its call at its own deadline). */
const slow = (e: unknown): boolean => e instanceof NoAnswer || (e instanceof SolanaRpcTransportError && e.fault === "timeout");
/** One read's bound: it began at `start` and no try or wait of any call in it begins past `end` (unix ms on Date.now's
 *  clock), or once `stopped`, which is set when the read ends: a read that has failed asks no provider again. */
type Bound = { readonly start: number; readonly end: number; stopped: boolean };
/** The device's clock as a read returns: its clock at the start (`nowS`) moved on by the time the read ran. */
const nowAt = (nowS: number, bound: Bound): number => nowS + (Date.now() - bound.start) / 1000;
/** One call, asked again of the same provider with the same params while it is slow or behind (see the header), until
 *  the read's bound ends or the read is stopped. Any other answer, an error included, ends it at once. */
async function call(rpc: SolanaRpc, method: string, params: readonly unknown[], what: string, bound: Bound): Promise<unknown> {
  for (let tries = 1; ; tries++) {
    if (bound.stopped) return fail(`${what}: not asked again, the read has ended`);
    // a try's bound counts from when the call goes out in its provider's queue (a paced provider: the signing page's pair),
    // never from its wait for a turn, and is taken then, within the read's bound (card solana-release-reads-paced)
    const timed = solanaTimedRpc(rpc, () => {
      if (bound.stopped) return fail(`${what}: not asked again, the read has ended`);
      const left = bound.end - Date.now();
      // a turn that comes once the read's bound has ended sends nothing: no try begins past it
      if (left <= 0) throw new NoAnswer(`${what}: no turn inside the read's bound`);
      return Math.min(POOL_USD_CALL_TIMEOUT_MS, left);
    }, (ms) => new NoAnswer(`${what}: no answer in ${ms} ms`));
    try {
      return await Promise.resolve().then(() => timed(method, params));
    } catch (e) {
      if (!behind(e) && !slow(e)) throw e;
      const waitMs = POOL_USD_RETRY_BACKOFF_MS * 2 ** (tries - 1);
      if (bound.stopped) throw e;
      // a wait that ends past the read's bound is not begun: the call fails now, its fault named
      if (Date.now() + waitMs >= bound.end) return fail(`${e instanceof NoAnswer ? "" : `${what}: `}${(e as Error).message} (${tries} ${tries === 1 ? "try" : "tries"} in the read's ${POOL_USD_READ_DEADLINE_MS} ms)`);
      await new Promise((res) => setTimeout(res, waitMs));
    }
  }
}

function checkArgs(a: PoolUsdArgs): { feed: PoolUsdPythFeed | PoolUsdChainlinkFeed; chain: PoolUsdChain; rpcs: readonly [SolanaRpc, SolanaRpc]; nowS: number; nowMs: number } {
  const chain = a?.chain as unknown;
  if (typeof chain !== "string" || !Object.hasOwn(POOL_USD_FEEDS, chain)) fail(`no USD price for chain ${String(chain)}`);
  const rpcs = a?.rpcs as unknown;
  if (!Array.isArray(rpcs) || rpcs.length !== 2 || typeof rpcs[0] !== "function" || typeof rpcs[1] !== "function") fail("two RPCs are needed");
  if (solanaSameProvider((rpcs as SolanaRpc[])[0]!, (rpcs as SolanaRpc[])[1]!)) fail("the two RPCs are one provider twice: a price must never rest on one provider's word");
  const nowMs = a?.nowMs === undefined ? Date.now() : a.nowMs;
  if (typeof nowMs !== "number" || !Number.isSafeInteger(nowMs) || nowMs < 0) fail("nowMs: not a time in unix ms");
  return { feed: POOL_USD_FEEDS[chain as PoolUsdChain], chain: chain as PoolUsdChain, rpcs: rpcs as [SolanaRpc, SolanaRpc], nowS: nowMs / 1000, nowMs };
}

/** The last second a price is used: its bound counted from the earlier of the feed's own time and the device's read, so a
 *  device clock behind the feed never stretches the bound past maxAgeS of the device's own time. */
const goodUntil = (publishedS: number, readS: number, maxAgeS: number): number => Math.min(publishedS, readS) + maxAgeS;

/**
 * The last unix second a price of `chain` read at `readS` (the device's clock at the read) is used: its feed's bound
 * (POOL_USD_FEEDS maxAgeS) from the earlier of `publishedS` and `readS`. The one rule for every holder of a read price:
 * a device clock behind the feed would otherwise stretch the bound by as much as it lags.
 */
export function poolUsdGoodUntilS(chain: PoolUsdChain, publishedS: number, readS: number): number {
  // an own key only, as checkArgs: a chain outside the table names no bound, even when a polluted Object.prototype has one
  if (typeof chain !== "string" || !Object.hasOwn(POOL_USD_FEEDS, chain)) fail(`no USD price for chain ${typeof chain === "string" ? chain : typeof chain}`);
  return goodUntil(publishedS, readS, POOL_USD_FEEDS[chain].maxAgeS);
}

/** The price's age against the device's clock: past goodUntil, or ahead by more than POOL_USD_MAX_AHEAD_S, refused. */
function checkAge(publishedS: number, maxAgeS: number, nowS: number): void {
  if (nowS > goodUntil(publishedS, nowS, maxAgeS)) fail(`the price is older than ${maxAgeS} s: published ${publishedS}, now ${Math.floor(nowS)}`);
  if (publishedS - nowS > POOL_USD_MAX_AHEAD_S) fail(`the price's time ${publishedS} is ahead of the device's clock ${Math.floor(nowS)}`);
}

// ------------------------------------------------------------------------------------------------ Pyth on Solana
/**
 * PriceUpdateV2 (Pyth Solana Receiver SDK, price_update.rs), Borsh after Anchor's 8-byte discriminator, 134 bytes:
 * write_authority (32), verification_level (an enum: Partial { num_signatures: u8 } is tag 0 and one byte, Full is tag
 * 1 and none), price_message (feed_id 32, price i64, conf u64, exponent i32, publish_time i64, prev_publish_time i64,
 * ema_price i64, ema_conf u64), posted_slot u64. The space is sized for Partial, so a Full update leaves its last byte
 * unused. Checked against the account read (see the header).
 */
const PYTH_LEN = 134;
const PYTH_DISCRIMINATOR = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];
const FULL = 1;
const PARTIAL = 0;

type SolanaRead = { slot: number; account: { owner: string; data: Uint8Array } | null };

async function readPythOnce(rpc: SolanaRpc, k: number, account: string, minContextSlot: number | null, bound: Bound): Promise<SolanaRead> {
  const config = { encoding: "base64", commitment: "confirmed", ...(minContextSlot === null ? {} : { minContextSlot }) };
  const r = solanaParseAccountsAnswer(await call(rpc, "getMultipleAccounts", [[account], config], `rpc ${k} getMultipleAccounts`, bound), 1);
  if (r === null) return fail(`rpc ${k}: not a getMultipleAccounts answer`);
  return { slot: r.slot, account: r.accounts[0] ?? null };
}

const sameAccount = (a: SolanaRead["account"], b: SolanaRead["account"]): boolean =>
  a === null || b === null ? a === b : a.owner === b.owner && a.data.length === b.data.length && a.data.every((x, i) => x === b.data[i]);

async function pythPrice(feed: PoolUsdPythFeed, rpcs: readonly [SolanaRpc, SolanaRpc], nowS: number, bound: Bound): Promise<PoolUsdPrice> {
  let reads: [SolanaRead, SolanaRead] | null = null;
  let min: number | null = null;
  for (let round = 0; round < POOL_USD_READ_ROUNDS; round++) {
    const r = await Promise.all([readPythOnce(rpcs[0], 0, feed.account, min, bound), readPythOnce(rpcs[1], 1, feed.account, min, bound)]);
    if (sameAccount(r[0].account, r[1].account)) {
      reads = r;
      break;
    }
    min = Math.max(r[0].slot, r[1].slot);
  }
  if (reads === null) return fail(`the two RPCs disagree on the Pyth account ${feed.account} after ${POOL_USD_READ_ROUNDS} reads`);
  const acc = reads[0].account;
  if (acc === null) return fail(`no Pyth account at ${feed.account}`);
  if (acc.owner !== feed.owner) fail(`the Pyth account is owned by ${acc.owner}, not the Pyth Solana Receiver ${feed.owner}`);
  const d = acc.data;
  if (d.length !== PYTH_LEN || PYTH_DISCRIMINATOR.some((x, i) => d[i] !== x)) fail("the Pyth account is not a PriceUpdateV2");
  if (base58.encode(d.subarray(8, 40)) !== feed.account) fail("the Pyth account's write authority is not the push oracle's own address");
  if (d[40] === PARTIAL) fail(`the Pyth update's verification level is Partial (${d[41]} signatures), not Full`);
  if (d[40] !== FULL) fail(`the Pyth update's verification level tag ${d[40]} is not Full`);
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const feedId = `0x${[...d.subarray(41, 73)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  if (feedId !== feed.feedId) fail(`the Pyth update is of feed ${feedId}, not the SOL/USD feed ${feed.feedId}`);
  const price = v.getBigInt64(73, true);
  const conf = v.getBigUint64(81, true);
  const expo = v.getInt32(89, true);
  const publishedS = Number(v.getBigInt64(93, true));
  const posted = v.getBigUint64(125, true);
  if (price <= 0n) fail(`the price ${price} is not positive`);
  if (expo > 0 || expo < -18) fail(`the Pyth exponent ${expo} is outside -18..0`);
  if (conf * 10_000n > price * BigInt(feed.maxConfBps)) fail(`the Pyth confidence ${conf} is wider than ${feed.maxConfBps} bps of the price ${price}`);
  for (const r of reads) if (BigInt(r.slot) < posted) fail(`an RPC answered at slot ${r.slot}, before the update's own slot ${posted}`);
  checkAge(publishedS, feed.maxAgeS, nowAt(nowS, bound));
  return { chain: "solana", asset: feed.asset, decimals: POOL_ASSET_DECIMALS[feed.asset], price, expo, publishedS, source: "pyth", at: posted };
}

// ------------------------------------------------------------------------------------------------ Chainlink on EVM
const DECIMALS = "0x313ce567"; // decimals()
const LATEST_ROUND_DATA = "0xfeaf968c"; // latestRoundData()
const ROUND_FIELDS = ["roundId", "answer", "startedAt", "updatedAt", "answeredInRound"] as const;
const U80 = 1n << 80n;
const U64 = 1n << 64n;

// An RPC's hex as the wallet's evmRpcHex (packages/wallet/src/pool/evm.ts) reads it: "0x", then hex digits in either
// case, lower-cased. Two RPCs that differ only in case give one answer. (The kit cannot import the wallet.)
const rpcHex = (v: unknown): string | null => (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : null);
const quantity = (v: unknown, what: string): bigint => {
  const h = rpcHex(v);
  if (h === null || !/^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(h)) fail(`${what}: not a quantity`);
  return BigInt(h!);
};
/** An eth_call answer of exactly n 32-byte words. */
const wordsOf = (v: unknown, n: number, what: string): bigint[] => {
  const h = rpcHex(v);
  if (h === null || h.length !== 2 + 64 * n) fail(`${what}: not ${n} word${n === 1 ? "" : "s"}`);
  return Array.from({ length: n }, (_, i) => BigInt(`0x${h!.slice(2 + 64 * i, 66 + 64 * i)}`));
};

type RoundRead = { decimals: bigint; round: bigint[] };

async function chainlinkPrice(chain: "base" | "robinhood", feed: PoolUsdChainlinkFeed, rpcs: readonly [SolanaRpc, SolanaRpc], nowS: number, bound: Bound): Promise<PoolUsdPrice> {
  const ids = await Promise.all(rpcs.map((rpc, k) => call(rpc, "eth_chainId", [], `rpc ${k} eth_chainId`, bound)));
  ids.forEach((id, k) => {
    if (rpcHex(id) !== feed.chainId) fail(`rpc ${k}: chain id ${String(id)} is not ${chain}'s ${feed.chainId}`);
  });
  const heads = await Promise.all(rpcs.map(async (rpc, k) => quantity(await call(rpc, "eth_blockNumber", [], `rpc ${k} eth_blockNumber`, bound), `rpc ${k} eth_blockNumber`)));
  const block = heads[0]! < heads[1]! ? heads[0]! : heads[1]!;
  const at = `0x${block.toString(16)}`;
  // that block on both RPCs: one block (the same hash), its time within POOL_USD_BLOCK_MAX_AGE_S of the device's clock
  const blocks = await Promise.all(
    rpcs.map(async (rpc, k) => {
      const b = (await call(rpc, "eth_getBlockByNumber", [at, false], `rpc ${k} eth_getBlockByNumber`, bound)) as { number?: unknown; hash?: unknown; timestamp?: unknown } | null;
      const hash = rpcHex(b?.hash);
      if (hash === null || hash.length !== 66) fail(`rpc ${k}: block ${block} has no hash`);
      if (quantity(b!.number, `rpc ${k} block number`) !== block) fail(`rpc ${k}: answered another block than ${block}`);
      return { hash: hash!, timeS: quantity(b!.timestamp, `rpc ${k} block timestamp`) };
    }),
  );
  if (blocks[0]!.hash !== blocks[1]!.hash) fail(`the two RPCs disagree on block ${block}'s hash`);
  const blockS = Number(blocks[0]!.timeS);
  if (blocks[0]!.timeS !== blocks[1]!.timeS) fail(`the two RPCs disagree on block ${block}'s time`);
  const blockNowS = nowAt(nowS, bound);
  if (Math.abs(blockNowS - blockS) > POOL_USD_BLOCK_MAX_AGE_S) fail(`block ${block}'s time ${blockS} is more than ${POOL_USD_BLOCK_MAX_AGE_S} s from the device's clock ${Math.floor(blockNowS)}`);
  const reads: RoundRead[] = await Promise.all(
    rpcs.map(async (rpc, k) => {
      const [dec, round] = await Promise.all([
        call(rpc, "eth_call", [{ to: feed.proxy, data: DECIMALS }, at], `rpc ${k} decimals`, bound),
        call(rpc, "eth_call", [{ to: feed.proxy, data: LATEST_ROUND_DATA }, at], `rpc ${k} latestRoundData`, bound),
      ]);
      return { decimals: wordsOf(dec, 1, `rpc ${k} decimals`)[0]!, round: wordsOf(round, 5, `rpc ${k} latestRoundData`) };
    }),
  );
  const [a, b] = reads as [RoundRead, RoundRead];
  if (a.decimals !== b.decimals) fail(`the two RPCs disagree on decimals at block ${block}`);
  ROUND_FIELDS.forEach((f, i) => {
    if (a.round[i] !== b.round[i]) fail(`the two RPCs disagree on ${f} at block ${block}`);
  });
  if (a.decimals > 18n) fail(`the feed's decimals ${a.decimals} are outside 0..18`);
  const [roundId, word, , updatedAt, answeredInRound] = a.round as [bigint, bigint, bigint, bigint, bigint];
  const price = BigInt.asIntN(256, word);
  if (roundId >= U80 || answeredInRound >= U80) fail(`the round ${roundId} is not a uint80 round`);
  if (answeredInRound < roundId) fail(`the round ${roundId} was answered in an earlier round ${answeredInRound}`);
  if (updatedAt === 0n || updatedAt >= U64) fail(`the round ${roundId} has no update time`);
  if (price <= 0n) fail(`the price ${price} is not positive`);
  const publishedS = Number(updatedAt);
  checkAge(publishedS, feed.maxAgeS, nowAt(nowS, bound));
  return { chain, asset: feed.asset, decimals: POOL_ASSET_DECIMALS[feed.asset], price, expo: -Number(a.decimals), publishedS, source: "chainlink", at: block };
}

// ------------------------------------------------------------------------------------------------ the entry
/**
 * The pool asset's USD price on `chain` (solana, base or robinhood), read by the device on two RPCs of two providers
 * that must agree, fresh, positive and sure (see the file's header). Throws, each with its own message, on a price
 * that is stale or ahead of the clock, two RPCs that disagree, a non-positive price, a Pyth confidence wider than
 * maxConfBps, an account or answer that is not the feed's, an unknown chain or one provider twice.
 */
export async function poolUsdPrice(args: PoolUsdArgs): Promise<PoolUsdPrice> {
  const start = Date.now();
  const bound: Bound = { start, end: start + POOL_USD_READ_DEADLINE_MS, stopped: false };
  try {
    return await readPrice(args, bound);
  } finally {
    // ended, failed or not: a call still waiting on a provider asks it nothing more
    bound.stopped = true;
  }
}

async function readPrice(args: PoolUsdArgs, bound: Bound): Promise<PoolUsdPrice> {
  const { feed, chain, rpcs, nowS, nowMs } = checkArgs(args);
  if (feed.kind === "pyth") return pythPrice(feed, rpcs, nowS, bound);
  if (chain !== "robinhood") return chainlinkPrice(chain as "base", feed, rpcs, nowS, bound);
  // Robinhood: its own feed, held to Base's ETH/USD read now
  const base = checkArgs({ chain: "base", rpcs: args.baseRpcs ?? (fail("robinhood: Base's two RPCs are needed to hold its ETH/USD to Base's") as never), nowMs });
  const [p, b] = await Promise.all([chainlinkPrice("robinhood", feed, rpcs, nowS, bound), chainlinkPrice("base", base.feed as PoolUsdChainlinkFeed, base.rpcs, nowS, bound)]);
  // both at one exponent, the finer
  const e = Math.min(p.expo, b.expo);
  const x = p.price * 10n ** BigInt(p.expo - e);
  const y = b.price * 10n ** BigInt(b.expo - e);
  const lo = x < y ? x : y;
  const gap = x < y ? y - x : x - y;
  if (gap * 10_000n > POOL_USD_CROSS_BPS * lo) fail(`Robinhood's ETH/USD ${p.price} (10^${p.expo}) is more than ${POOL_USD_CROSS_BPS} bps from Base's ${b.price} (10^${b.expo})`);
  return p;
}

/** A USD amount: a positive decimal string, up to 16 whole digits and 18 after the point, no sign, exponent or space. */
const USD = /^(0|[1-9]\d{0,15})(\.\d{1,18})?$/;

/**
 * `usd` dollars in the pool asset's base units on `chain` (lamports on solana, wei on base and robinhood), from
 * poolUsdPrice's read: floor(usd x 10^decimals / price), rounded down, so a tap never spends more than the USD asked
 * (an amount worth less than one base unit is 0n). Refuses what poolUsdPrice refuses, and a `usd` that is not a
 * positive decimal string.
 */
export async function poolUsdToUnits(args: PoolUsdArgs & { usd: string }): Promise<bigint> {
  const usd = args?.usd as unknown;
  if (typeof usd !== "string" || !USD.test(usd) || /^[0.]+$/.test(usd)) fail(`the USD amount ${typeof usd === "string" ? JSON.stringify(usd) : typeof usd} is not a positive decimal string`);
  const p = await poolUsdPrice(args);
  const [whole, frac = ""] = (usd as string).split(".");
  const u = BigInt(whole! + frac);
  // usd = u / 10^frac; one asset = price x 10^expo USD; units = usd x 10^decimals / (price x 10^expo)
  const e = p.decimals - frac.length - p.expo;
  return e >= 0 ? (u * 10n ** BigInt(e)) / p.price : u / (p.price * 10n ** BigInt(-e));
}
