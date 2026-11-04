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
// - Base and Robinhood (the pools hold native ETH, 18 decimals): ETH/USD from the chain's own Chainlink feed, decimals()
//   and latestRoundData() by eth_call on both RPCs at one block number, the lower of their two eth_blockNumber heads
//   (each has it; never "latest" on each). Every word must be the same on both. Robinhood has its own Chainlink ETH/USD
//   feed (read below), so it is read there, not on Base.
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
import { solanaSameProvider, type SolanaRpc } from "../trade/solana/send.ts";

/** A price at most this far ahead of the device's clock is used: further, the clock is wrong and no age can be told. */
export const POOL_USD_MAX_AHEAD_S = 60;
/** Reads of the Pyth account on both RPCs before two answers that still differ are refused. */
export const POOL_USD_READ_ROUNDS = 3;
/** One RPC call's bound. */
export const POOL_USD_CALL_TIMEOUT_MS = 5_000;

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
};

const fail = (why: string): never => {
  throw new Error(why);
};

function within<T>(p: Promise<T>, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what}: no answer in ${POOL_USD_CALL_TIMEOUT_MS} ms`)), POOL_USD_CALL_TIMEOUT_MS)))]).finally(() => clearTimeout(t));
}
const call = (rpc: SolanaRpc, method: string, params: readonly unknown[], what: string): Promise<unknown> =>
  within(Promise.resolve().then(() => rpc(method, params)), what);

function checkArgs(a: PoolUsdArgs): { feed: PoolUsdPythFeed | PoolUsdChainlinkFeed; chain: PoolUsdChain; rpcs: readonly [SolanaRpc, SolanaRpc]; nowS: number } {
  const chain = a?.chain as unknown;
  if (typeof chain !== "string" || !Object.hasOwn(POOL_USD_FEEDS, chain)) fail(`no USD price for chain ${String(chain)}`);
  const rpcs = a?.rpcs as unknown;
  if (!Array.isArray(rpcs) || rpcs.length !== 2 || typeof rpcs[0] !== "function" || typeof rpcs[1] !== "function") fail("two RPCs are needed");
  if (solanaSameProvider((rpcs as SolanaRpc[])[0]!, (rpcs as SolanaRpc[])[1]!)) fail("the two RPCs are one provider twice: a price must never rest on one provider's word");
  const nowMs = a?.nowMs === undefined ? Date.now() : a.nowMs;
  if (typeof nowMs !== "number" || !Number.isSafeInteger(nowMs) || nowMs < 0) fail("nowMs: not a time in unix ms");
  return { feed: POOL_USD_FEEDS[chain as PoolUsdChain], chain: chain as PoolUsdChain, rpcs: rpcs as [SolanaRpc, SolanaRpc], nowS: nowMs / 1000 };
}

/** The price's age against the device's clock: older than maxAgeS, or ahead by more than POOL_USD_MAX_AHEAD_S, refused. */
function checkAge(publishedS: number, maxAgeS: number, nowS: number): void {
  if (nowS - publishedS > maxAgeS) fail(`the price is older than ${maxAgeS} s: published ${publishedS}, now ${Math.floor(nowS)}`);
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

async function readPythOnce(rpc: SolanaRpc, k: number, account: string, minContextSlot: number | null): Promise<SolanaRead> {
  const config = { encoding: "base64", commitment: "confirmed", ...(minContextSlot === null ? {} : { minContextSlot }) };
  const r = solanaParseAccountsAnswer(await call(rpc, "getMultipleAccounts", [[account], config], `rpc ${k} getMultipleAccounts`), 1);
  if (r === null) return fail(`rpc ${k}: not a getMultipleAccounts answer`);
  return { slot: r.slot, account: r.accounts[0] ?? null };
}

const sameAccount = (a: SolanaRead["account"], b: SolanaRead["account"]): boolean =>
  a === null || b === null ? a === b : a.owner === b.owner && a.data.length === b.data.length && a.data.every((x, i) => x === b.data[i]);

async function pythPrice(feed: PoolUsdPythFeed, rpcs: readonly [SolanaRpc, SolanaRpc], nowS: number): Promise<PoolUsdPrice> {
  let reads: [SolanaRead, SolanaRead] | null = null;
  let min: number | null = null;
  for (let round = 0; round < POOL_USD_READ_ROUNDS; round++) {
    const r = await Promise.all([readPythOnce(rpcs[0], 0, feed.account, min), readPythOnce(rpcs[1], 1, feed.account, min)]);
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
  checkAge(publishedS, feed.maxAgeS, nowS);
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

async function chainlinkPrice(chain: "base" | "robinhood", feed: PoolUsdChainlinkFeed, rpcs: readonly [SolanaRpc, SolanaRpc], nowS: number): Promise<PoolUsdPrice> {
  const ids = await Promise.all(rpcs.map((rpc, k) => call(rpc, "eth_chainId", [], `rpc ${k} eth_chainId`)));
  ids.forEach((id, k) => {
    if (rpcHex(id) !== feed.chainId) fail(`rpc ${k}: chain id ${String(id)} is not ${chain}'s ${feed.chainId}`);
  });
  const heads = await Promise.all(rpcs.map(async (rpc, k) => quantity(await call(rpc, "eth_blockNumber", [], `rpc ${k} eth_blockNumber`), `rpc ${k} eth_blockNumber`)));
  const block = heads[0]! < heads[1]! ? heads[0]! : heads[1]!;
  const at = `0x${block.toString(16)}`;
  const reads: RoundRead[] = await Promise.all(
    rpcs.map(async (rpc, k) => {
      const [dec, round] = await Promise.all([
        call(rpc, "eth_call", [{ to: feed.proxy, data: DECIMALS }, at], `rpc ${k} decimals`),
        call(rpc, "eth_call", [{ to: feed.proxy, data: LATEST_ROUND_DATA }, at], `rpc ${k} latestRoundData`),
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
  checkAge(publishedS, feed.maxAgeS, nowS);
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
  const { feed, chain, rpcs, nowS } = checkArgs(args);
  return feed.kind === "pyth" ? pythPrice(feed, rpcs, nowS) : chainlinkPrice(chain as "base" | "robinhood", feed, rpcs, nowS);
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
