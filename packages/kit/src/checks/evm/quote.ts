// The device's own quote of an EVM pool buy (card evm-pool-buy-quote; merge notes M357 (1), M360, M366 (4)). W signs a
// buy only at a minOut from this quote: for a hooked v4 hop minOut is the only bound (M360), so it comes from the
// device's own reads, never from a number the helper sends.
//
// Every read is an eth_call at one block hash (EIP-1898, requireCanonical) on the chain's two pinned RPC providers (on
// two hosts), the same calls on both, and any answer they do not both give is refused (rpc_disagree): an RPC that lies
// about a quote, or hides a pool by faking a revert, is caught by the other. The block is the lower of the two heads,
// at most the chain's maxLag blocks apart, which the other provider must hold with the same hash and time, and no more
// than 30 s behind the device's clock (stale_quote): one provider alone cannot pick it. The reads, in aggregate3 calls:
// - the route's quote Q for the amount in (QuoterV2.quoteExactInput for v3, V4Quoter.quoteExactInput for v4, the
//   chain's pinned quoters), and the same route for twice the amount: a route whose output does not grow with its input
//   has run out of a pool's liquidity, which both quoters report as if the fill were complete (partial_fill; read
//   2026-11-03 on Base: V4Quoter quoted 1e27 wei of ETH into the ETH/USDC 0.05% pool as 284,167 USDC);
// - every pool the device found for the token, whatever the route's shape, from four sources, each of which can only
//   add one: the standard routes (v3 WETH to the token at each standard fee tier, v4 native to the token at each
//   standard fee and tick spacing with no hook, every two-hop of those through each listed middle token on both
//   venues); each pinned launchpad pool shape (hook, fee, tick spacing); the v4 pools of the token with any currency
//   that the device's own scan of the PoolManager's Initialize logs found (the chain's scan depth back, to the scan
//   provider's head within maxLag of the agreed block, kept per currency in memory once that block is confirmed); and
//   any pool the caller lists, never
//   trusted. A scanned or listed pool counts only where the PoolManager holds it at the agreed block on both
//   providers (slot0's price and liquidity above 0, through extsload), and only then is a hook replaced in its reads:
//   one whose hook is not pinned is read with that hook alone replaced by the hook that does nothing, so a hook cannot
//   raise a reference, and a pool whose hook is an address the reads call is dropped. A pool of another currency X
//   counts through X's markets with the native asset or WETH (the standard and pinned shapes, and X's pools with them
//   that one scan of every X's Initialize logs found, read under the same rules), and an X with no market that fills
//   through its pools with another currency Y and Y's markets: a v4 route from the native asset or WETH of two or
//   three hops, which the device may quote and build though its middles are not listed (trade/evm/buy-unpinned.ts
//   checkRoute). The route's own pools are not read with their hooks replaced as candidates: the hook's take there is
//   shown, below. The best one that fills completely is the reference R. A buy is refused unless its output is at
//   least R (below_reference, M366 (4)), so a helper cannot steer it into a pool it seeded while the token's real
//   pool is one the device found; with no R it is refused (no_reference). Every read is within a DoS bound
//   (EVM_QUOTE_MAX_KEYS, EVM_QUOTE_MAX_OTHER, EVM_QUOTE_MAX_QUOTED), taken in a fixed order no pool's price or
//   liquidity changes. More found pools of the token than EVM_QUOTE_MAX_KEYS refuses (too_many_pools, review of
//   4830f1f, H2); past the other bounds nothing refuses: a held pool that no route from the native asset reaches, or
//   that a bound leaves unread, adds nothing. What is left: a pool of the token created before the scan's depth (about 23 days on
//   Base, 12 days on Robinhood), of a shape the device has not pinned, that the helper leaves off its list while it
//   routes the buy into a standard pool it seeded; and, past EVM_QUOTE_MAX_QUOTED held pools or the bounds on another
//   currency's pools, a real pool that pools an attacker made with smaller pool ids push past that bound;
// - for a route with a hooked v4 hop, the same route with each hook's code replaced by a hook that does nothing
//   (eth_call's state override): the hookless output H. The hook's take H - Q is shown as a fee before the buy,
//   information only, never a pop-up (M360). The route's own Q, which the hook ran in, sets minOut;
// - on a chain whose WETH is behind an upgradeable proxy (nativeFirst, Robinhood's aeWETH), the native v4 pools of the
//   route's first hop: a route that starts from WETH is refused when one exists (native_first), naming the best
//   native route, unless it quotes strictly more than every native route (native when at least as good); R stays
//   the best of every pool, so a seeded native pool is held to the token's WETH pools too.
//
// minOut = floor(Q x (10000 - slippageBps) / 10000), with Q >= R. Only a quote made here builds a buy, within 30 s of
// its block (trade/evm/buy.ts), and W signs only a buy built from one.
import {
  copyRoute,
  evmPoolRouteDataQuoted,
  evmPoolVenues,
  pathKeysAbi,
  type EvmPoolChain,
  type EvmPoolVenueList,
  type EvmRoute,
  type EvmV3Route,
  type EvmV4Hop,
  type EvmV4Route,
} from "../../trade/evm/buy-unpinned.ts";
import { EVM_SELL_SIM, evmHookListed, evmPoolBuildSimSellUnpinned, evmSellCallData, evmSellRouteCheck, type EvmSellRoute, type EvmSellSim, type EvmV4SellRoute } from "../../trade/evm/sell-unpinned.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** One JSON-RPC call. */
export type EvmRpcCall = { readonly method: string; readonly params: readonly unknown[] };
/** One RPC provider: answers a batch with one JSON-RPC answer object ({ result } or { error }) per call, in order;
 *  throws when it cannot be reached. evmJsonRpc makes one from a URL. */
export type EvmRpc = (calls: readonly EvmRpcCall[]) => Promise<readonly unknown[]>;

/** The user's own request: the token they picked, the amount of the native asset in (wei), their slippage, and the route
 *  to quote (the helper's, or one the device made). */
export type EvmPoolBuyQuoteRequest = {
  chain: EvmPoolChain;
  token: string;
  amountIn: bigint;
  slippageBps: number;
  route: EvmRoute;
  /** Pools the caller lists for the token (the helper's index): never trusted, each read on the PoolManager's state at
   *  the agreed block like a pool the device found itself, and dropped when it does not exist there or is malformed.
   *  A listed pool can only add a candidate for R; at most EVM_QUOTE_MAX_HINTS are read. */
  pools?: readonly EvmPoolKey[];
};

/** A v4 pool's key, as the PoolManager's Initialize event gives it (currency0 below currency1). */
export type EvmPoolKey = { readonly currency0: string; readonly currency1: string; readonly fee: number; readonly tickSpacing: number; readonly hooks: string };

/** The hook's take on a route with a hooked v4 hop: the hookless output H and H - Q (null when the hookless read
 *  reverts on both providers, as when the hook is the pool's only liquidity). */
export type EvmHookTake = { readonly hookless: bigint | null; readonly take: bigint | null; readonly takeBps: number | null };

export type EvmPoolBuyQuote = {
  readonly chain: EvmPoolChain;
  readonly token: string;
  readonly amountIn: bigint;
  readonly route: EvmRoute;
  /** The block both providers answered at, and its time (unix seconds) as both providers give it. */
  readonly block: { readonly number: bigint; readonly hash: string; readonly timestamp: bigint };
  /** Q: the route's output, the same on both providers. */
  readonly amountOut: bigint;
  /** What W signs: floor(Q x (10000 - slippageBps) / 10000). */
  readonly minOut: bigint;
  /** R: the best of every pool the device found for the token (see the header), or null when none answers. */
  readonly reference: { readonly amountOut: bigint; readonly route: EvmRoute } | null;
  /** null when the route has no hooked hop. */
  readonly hook: EvmHookTake | null;
};

export type EvmQuoteErrorCode =
  | "bad_request" // the amount, the slippage, the token or the providers
  | "token_mismatch" // the route buys another token than the user picked
  | "no_quoter" // the chain has no pinned quoter for the route's venue
  | "rpc_error" // a provider did not answer, or answered something that is not an answer
  | "rpc_disagree" // the two providers gave different answers at the same block
  | "no_quote" // the route reverts, or quotes nothing
  | "partial_fill" // the route runs out of a pool's liquidity
  | "below_reference" // the route is quoted below the device's own standard pool
  | "native_first" // the route starts from WETH where a native route quotes at least as much
  | "no_reference" // no standard or pinned launchpad pool answers: nothing the device chose holds the route
  | "stale_quote" // the block is more than 30 s behind the device's clock
  | "too_many_pools" // the token has more pools than a quote reads: past the bound its real one may be unread
  | "fee_on_transfer" // a sell's token does not deliver the whole amount from W to the pool, or its transfer reverts
  | "no_exit"; // a buy's route goes through a pool its sell could not leave through
export class EvmQuoteError extends Error {
  readonly code: EvmQuoteErrorCode;
  /** On below_reference and native_first: the device's own best route, which the caller may quote instead. */
  readonly reference: { readonly amountOut: bigint; readonly route: EvmRoute } | null;
  constructor(code: EvmQuoteErrorCode, message: string, reference: EvmQuoteError["reference"] = null) {
    super(`${code}: ${message}`);
    this.code = code;
    this.reference = reference;
    this.name = "EvmQuoteError";
  }
}
const refuse = (code: EvmQuoteErrorCode, m: string, reference: EvmQuoteError["reference"] = null): never => {
  throw new EvmQuoteError(code, m, reference);
};

/** The standard pools: Uniswap v3's fee tiers, and v4's fee and tick spacing pairs, with no hook. Module-private, so
 *  no code can change the set (and no top-level call: the kit's index reaches the signing page's bundle). */
const V3_FEES: readonly number[] = [100, 500, 3000, 10000];
const V4_KEYS: readonly (readonly [number, number])[] = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
/** A hook that does nothing: it returns the called selector and zeros, 96 bytes for beforeSwap (selector, delta, fee)
 *  and 64 for any other call (afterSwap: selector, delta), as v4-core's Hooks library reads them.
 *    PUSH1 4 PUSH1 0 PUSH1 0 CALLDATACOPY            copy the selector to memory 0
 *    PUSH1 0 CALLDATALOAD PUSH1 0xe0 SHR PUSH4 0x575e24b4 EQ PUSH1 0x1b JUMPI    beforeSwap?
 *    PUSH1 0x40 PUSH1 0 RETURN                       64 bytes
 *    JUMPDEST PUSH1 0x60 PUSH1 0 RETURN              96 bytes */
export const EVM_NOOP_HOOK_CODE = "0x6004600060003760003560e01c63575e24b414601b5760406000f35b60606000f3";

const NATIVE = "0x0000000000000000000000000000000000000000";
const SEL_V3 = "cdca1753"; // quoteExactInput(bytes,uint256)
const SEL_V4 = "ca253dc9"; // quoteExactInput((address,(address,uint24,int24,address,bytes)[],uint128))
const MAX_IN = 1n << 127n; // twice the amount still fits V4Quoter's uint128
const MAX_ANSWER_HEX = 2 + 2 * 65536;

const isAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const lower = (a: string) => a.toLowerCase();
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const hex = (b: Uint8Array) => bytesToHex(b);
/** Adds `v` to the list `m` keeps at `k`, in place: a copy per add made the 19,884 slot reads of USDG's pools, and
 *  T1b's 40,000, quadratic (5.2 of T1b's 11.6 s on this Mac, card evm-quote-head-watch). */
const append = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const l = m.get(k);
  if (l === undefined) m.set(k, [v]);
  else l.push(v);
};

/** The pinned quoters and rules of `chain`: own keys of the frozen venue list only. */
function venue(chain: EvmPoolChain, all: EvmPoolVenueList = evmPoolVenues()) {
  const v = typeof chain === "string" && Object.hasOwn(all, chain) ? all[chain] : undefined;
  if (v === undefined) return refuse("bad_request", "no such chain");
  const q = Object.hasOwn(v, "quoters") ? v.quoters : undefined;
  const own = (k: "v3" | "v4") => (q !== undefined && Object.hasOwn(q, k) && isAddress(q[k]) ? q[k] : undefined);
  const pin = (k: "poolManager" | "pool" | "sellDelegate") => (Object.hasOwn(v, k) ? v[k] : undefined);
  const adapters = Object.hasOwn(v, "adapters") ? [v.adapters!.v3, v.adapters!.v4] : [];
  // every address of the venue and Multicall3: the quote's reads call them, so no state override may replace one
  // (review of 5452011, S1: a listed pool whose hook was the V4Quoter turned every grouped quote into the no-op)
  const called = [MULTICALL3, v.weth, ...v.middles, ...v.routers, own("v3"), own("v4"), pin("poolManager"), pin("pool"), pin("sellDelegate"), ...adapters];
  return {
    weth: v.weth,
    middles: v.middles,
    v3: own("v3"),
    v4: own("v4"),
    nativeFirst: Object.hasOwn(v, "nativeFirst") && v.nativeFirst === true,
    providers: Object.hasOwn(v, "providers") ? v.providers : undefined,
    maxLag: Object.hasOwn(v, "maxLag") && Number.isSafeInteger(v.maxLag) ? BigInt(v.maxLag!) : 0n,
    hookedPools: Object.hasOwn(v, "hookedPools") ? v.hookedPools! : [],
    poolManager: Object.hasOwn(v, "poolManager") && isAddress(v.poolManager) ? lower(v.poolManager) : undefined,
    sellDelegate: isAddress(pin("sellDelegate")) ? lower(pin("sellDelegate") as string) : undefined,
    scan: Object.hasOwn(v, "scan") ? v.scan : undefined,
    called: new Set(called.filter(isAddress).map(lower)),
  };
}

/** The quoter call for `route` (checked by the builder's own route checks) and `amount`. */
function quoteCall(chain: EvmPoolChain, quoter: { v3: string | undefined; v4: string | undefined }, route: EvmRoute, amount: bigint): { to: string; data: string } {
  const { data } = evmPoolRouteDataQuoted(chain, route);
  if (route.venue === "uniswap-v3") {
    if (quoter.v3 === undefined) return refuse("no_quoter", `${chain} has no pinned v3 quoter`);
    const padded = hex(data).padEnd(Math.ceil(data.length / 32) * 64, "0");
    return { to: quoter.v3, data: "0x" + SEL_V3 + word(0x40n) + word(amount) + word(BigInt(data.length)) + padded };
  }
  if (quoter.v4 === undefined) return refuse("no_quoter", `${chain} has no pinned v4 quoter`);
  // data is abi.encode(currencyIn, PathKey[]): its head is currencyIn and the array's offset; the quoter takes the
  // tuple (currencyIn, PathKey[], uint128 amount), whose array follows the tuple's three head words
  const path = hex(data.slice(64));
  return { to: quoter.v4, data: "0x" + SEL_V4 + word(0x20n) + word(BigInt(route.currencyIn)) + word(0x60n) + word(amount) + path };
}

// `group`: the one hook a read's override replaces; reads of the same group share that override in aggregate3 calls,
// and no read shares an override with a read of another hook
// `state`: a PoolManager.extsload read, one storage word, sent STATE_READS_PER_CALL to a call
type Read = { to: string; data: string; override?: Record<string, { code: string }> | undefined; group?: string; state?: true };
type Answer = { kind: "out"; amountOut: bigint } | { kind: "revert"; partial: boolean };
// V4Quoter's revert when a hookless hop runs out of liquidity: NotEnoughLiquidity(bytes32 poolId), wrapped in
// UnexpectedRevertBytes(bytes) (read 2026-11-03 on Base: 1e20 wei into the ETH pool of 0xf6e5…dfe5, 0.3%)
const NOT_ENOUGH_LIQUIDITY = "7a5ed734";
const UNEXPECTED_REVERT_BYTES = "6190b2b0";
const ranOut = (d: string) =>
  d.startsWith(NOT_ENOUGH_LIQUIDITY) || (d.startsWith(UNEXPECTED_REVERT_BYTES) && d.slice(8 + 128, 8 + 128 + 8) === NOT_ENOUGH_LIQUIDITY);

/** One provider's answer to one eth_call: the quote's first word, a revert, or a refusal (`raw`: the whole result). */
function answerOf(a: unknown, who: string, raw = false): Answer | string {
  if (typeof a !== "object" || a === null) return refuse("rpc_error", `${who} answered no object`);
  const o = a as { result?: unknown; error?: unknown };
  if (Object.hasOwn(o, "result")) {
    const r = o.result;
    if (typeof r !== "string" || r.length > MAX_ANSWER_HEX || !/^0x([0-9a-fA-F]{64})+$/.test(r)) {
      return refuse("rpc_error", `${who} answered a result that is not whole 32-byte words`);
    }
    return raw ? r : { kind: "out", amountOut: BigInt(r.slice(0, 66)) };
  }
  if (raw) {
    const m = (o as { error?: { message?: unknown } }).error?.message;
    return refuse("rpc_error", `${who} answered the multicall with an error: ${String(m).slice(0, 120)}`);
  }
  if (Object.hasOwn(o, "error") && typeof o.error === "object" && o.error !== null) {
    const { code, message } = o.error as { code?: unknown; message?: unknown };
    if (code === 3 || (typeof message === "string" && /revert/i.test(message))) return { kind: "revert", partial: false };
    return refuse("rpc_error", `${who} answered error ${String(code).slice(0, 12)}: ${String(message).slice(0, 120)}`);
  }
  return refuse("rpc_error", `${who} answered no result and no error`);
}

// Multicall3 (github.com/mds1/multicall3), the same address on every chain; eth_getCode on all four providers
// (mainnet.base.org, base-rpc.publicnode.com, rpc.mainnet.chain.robinhood.com, robinhood.drpc.org, 2026-11-03 18:00Z):
// 3,808 bytes, keccak 0xd5c15df6…e770891 on each. The reads but the hookless one go in aggregate3 calls (see
// READS_PER_CALL below).
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const SEL_AGGREGATE3 = "82ad56cb"; // aggregate3((address,bool,bytes)[])

/** aggregate3's calldata: every read with allowFailure, so a reverting quote is an answer, not a failed batch. */
function aggregate(reads: readonly Read[]): string {
  const elems = reads.map((r) => {
    const d = r.data.slice(2);
    return word(BigInt(r.to)) + word(1n) + word(0x60n) + word(BigInt(d.length / 2)) + d.padEnd(Math.ceil(d.length / 64) * 64, "0");
  });
  let at = 32 * elems.length;
  const offsets = elems.map((e) => {
    const o = word(BigInt(at));
    at += e.length / 2;
    return o;
  });
  return "0x" + SEL_AGGREGATE3 + word(0x20n) + word(BigInt(elems.length)) + offsets.join("") + elems.join("");
}

/** aggregate3's answer, (bool success, bytes returnData)[], read strictly: `n` results, each offset and length inside
 *  the answer; a success is a quote's first word, a failure a revert. */
function unaggregate(a: unknown, n: number, who: string): Answer[] {
  const r = answerOf(a, who, true) as string;
  const len = (r.length - 2) / 2;
  const at = (o: number): number => {
    if (!Number.isSafeInteger(o) || o < 0 || o + 32 > len) return refuse("rpc_error", `${who} answered a short multicall`);
    // every word read is compared for equality, or is an offset or a length that the next read or the bound below
    // holds inside the answer (a word past 2^53 fails Number.isSafeInteger there)
    return Number(BigInt("0x" + r.slice(2 + 2 * o, 66 + 2 * o)));
  };
  if (at(0) !== 0x20 || at(32) !== n) return refuse("rpc_error", `${who} answered another number of reads`);
  const out: Answer[] = [];
  for (let i = 0; i < n; i++) {
    const e = 64 + at(64 + 32 * i);
    const ok = at(e);
    if ((ok !== 0 && ok !== 1) || at(e + 32) !== 0x40) return refuse("rpc_error", `${who} answered a malformed multicall result`);
    const dl = at(e + 64);
    if (e + 96 + dl > len) return refuse("rpc_error", `${who} answered a multicall result outside it`);
    if (ok === 0) out.push({ kind: "revert", partial: ranOut(r.slice(2 + 2 * (e + 96), 2 + 2 * (e + 96 + dl)).toLowerCase()) });
    else if (dl < 32) return refuse("rpc_error", `${who} answered a quote shorter than a word`);
    else out.push({ kind: "out", amountOut: BigInt("0x" + r.slice(2 + 2 * (e + 96), 2 + 2 * (e + 128))) });
  }
  return out;
}

/** The words of an extsload(bytes32[]) answer: exactly `n` of them, or a refusal. */
function unslots(a: unknown, n: number, who: string): bigint[] {
  const r = answerOf(a, who, true) as string;
  if (r.length !== 2 + 2 * (64 + 32 * n)) return refuse("rpc_error", `${who} answered ${(r.length - 2) / 2} bytes for ${n} slots`);
  const w = (k: number) => BigInt("0x" + r.slice(2 + 64 * k, 66 + 64 * k));
  if (w(0) !== 32n || w(1) !== BigInt(n)) return refuse("rpc_error", `${who} answered a malformed slot list`);
  return Array.from({ length: n }, (_, k) => w(2 + k));
}

// Reads per aggregate3 call, and calls per JSON-RPC batch: base-rpc.publicnode.com caps an eth_call at 50,000,000 gas,
// which one call of 90 quotes of 100 ETH passed (read 2026-11-03 19:00Z), and robinhood.drpc.org's free plan takes a
// batch of 3 calls at most
const READS_PER_CALL = 6;
const CALLS_PER_BATCH = 3;
// an extsload read costs one storage read (2,100 gas cold, EIP-2929): 64 of them are far inside any provider's cap
const STATE_READS_PER_CALL = 64;
// A round with more PoolManager state reads than two such calls sends them as PoolManager.extsload(bytes32[]) calls of
// 2,000 slots each, an answer inside MAX_ANSWER_HEX (v4-core Extsload; selector dbd035ff, 2,048 slots answered on
// base-rpc.publicnode.com, mainnet.base.org, robinhood.drpc.org and rpc.mainnet.chain.robinhood.com, 2026-11-03
// 22:22Z; about 4.2M gas a call):
// USDG on Robinhood has 9,942 pools in the scan's depth, and every one's state is read before any bound applies
const SEL_EXTSLOADS = "dbd035ff";
const SLOTS_FROM = 2 * STATE_READS_PER_CALL;
const SLOTS_PER_CALL = 2000;

/** Both providers' answers to `reads` at `hash`, which must be the same: the reads without a state override in
 *  aggregate3 calls of READS_PER_CALL, the grouped reads of each hook in their own aggregate3 calls with that hook's
 *  override alone, any other read with one in its own call, sent in batches of CALLS_PER_BATCH at once. */
async function readBoth(rpcs: readonly [EvmRpc, EvmRpc], hash: string, reads: readonly Read[]): Promise<Answer[]> {
  const at = { blockHash: hash, requireCanonical: true };
  const plain = reads.flatMap((r, i) => (r.override === undefined && r.state !== true ? [i] : []));
  const one = (r: Read) => r.override === undefined && r.state === true && r.data.length === 74 && r.data.startsWith("0x" + SEL_EXTSLOAD);
  const slots = reads.flatMap((r, i) => (one(r) ? [i] : []));
  const batched = slots.length > SLOTS_FROM;
  const state = reads.flatMap((r, i) => (r.override === undefined && r.state === true && !(batched && one(r)) ? [i] : []));
  const slotParts: number[][] = [];
  if (batched) {
    const byTo = new Map<string, number[]>();
    for (const i of slots) append(byTo, lower(reads[i]!.to), i);
    for (const g of byTo.values()) for (let k = 0; k < g.length; k += SLOTS_PER_CALL) slotParts.push(g.slice(k, k + SLOTS_PER_CALL));
  }
  const groups = new Map<string, number[]>();
  reads.forEach((r, i) => {
    if (r.override !== undefined && r.group !== undefined) append(groups, r.group, i);
  });
  const lone = reads.flatMap((r, i) => (r.override !== undefined && r.group === undefined ? [i] : []));
  const parts: number[][] = [];
  for (let k = 0; k < plain.length; k += READS_PER_CALL) parts.push(plain.slice(k, k + READS_PER_CALL));
  for (let k = 0; k < state.length; k += STATE_READS_PER_CALL) parts.push(state.slice(k, k + STATE_READS_PER_CALL));
  for (const g of groups.values()) for (let k = 0; k < g.length; k += READS_PER_CALL) parts.push(g.slice(k, k + READS_PER_CALL));
  const calls: EvmRpcCall[] = [
    ...parts.map((part) => {
      const o = reads[part[0]!]!.override;
      const p: unknown[] = [{ to: MULTICALL3, data: aggregate(part.map((i) => reads[i]!)) }, at];
      return { method: "eth_call", params: o === undefined ? p : [...p, o] };
    }),
    ...slotParts.map((part) => ({
      method: "eth_call",
      params: [{ to: reads[part[0]!]!.to, data: "0x" + SEL_EXTSLOADS + word(32n) + word(BigInt(part.length)) + part.map((i) => reads[i]!.data.slice(10)).join("") }, at],
    })),
    ...lone.map((i) => ({ method: "eth_call", params: [{ to: reads[i]!.to, data: reads[i]!.data }, at, reads[i]!.override] })),
  ];
  const batches: EvmRpcCall[][] = [];
  for (let k = 0; k < calls.length; k += CALLS_PER_BATCH) batches.push(calls.slice(k, k + CALLS_PER_BATCH));
  const both = await Promise.all(rpcs.map(async (rpc) => (await Promise.all(batches.map((b) => askAt(rpc, b)))).flat()));
  const answers = both.map((b, p) => {
    const who = `provider ${p + 1}`;
    const all: Answer[] = new Array(reads.length);
    parts.forEach((part, c) => unaggregate(b[c], part.length, who).forEach((x, k) => (all[part[k]!] = x)));
    slotParts.forEach((part, c) => unslots(b[parts.length + c], part.length, who).forEach((x, k) => (all[part[k]!] = { kind: "out", amountOut: x })));
    lone.forEach((i, k) => (all[i] = answerOf(b[parts.length + slotParts.length + k], who) as Answer));
    return all;
  });
  return reads.map((_, i) => {
    const a = answers[0]![i]!;
    const b = answers[1]![i]!;
    const same = a.kind === "out" ? b.kind === "out" && a.amountOut === b.amountOut : b.kind === "revert" && a.partial === b.partial;
    if (!same) {
      return refuse("rpc_disagree", `the providers answer read ${i} differently at block ${hash}`);
    }
    return a;
  });
}

/** One provider's answer to `calls`, asked up to 3 more times 0.5, 1 and 1.5 s apart while it answers 429 (Too Many
 *  Requests: rpc.mainnet.chain.robinhood.com, 2026-11-04 06:53Z, to the reads of one quote) or a call's error names its
 *  rate limit ("25/second request limit reached", mainnet.base.org, 07:4xZ); any other failure, or a fourth, refuses. */
async function ask(rpc: EvmRpc, calls: readonly EvmRpcCall[]): Promise<readonly unknown[]> {
  let out: unknown;
  for (let i = 0; ; i++) {
    try {
      out = await rpc(calls);
      if (i < 3 && Array.isArray(out) && out.some(limited)) throw new RateLimited("a call's error names the provider's rate limit");
      break;
    } catch (e) {
      if (!(e instanceof RateLimited) || i === 3) return refuse("rpc_error", `a provider did not answer: ${(e as Error)?.message ?? e}`);
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  if (!Array.isArray(out) || out.length !== calls.length) return refuse("rpc_error", "a provider answered another number of calls");
  return out;
}

/** ask, up to 3 more times FRESH_RETRY_MS, twice and three times that apart while an answer says the provider does not
 *  hold the block yet: a provider behind a load balancer can send a call to a node one block behind the one that gave
 *  the head ("block not found: canonical hash", base-rpc.publicnode.com, 2026-11-03 19:09Z; "Unknown state. First
 *  available …", robinhood.drpc.org, 20:30Z, and on 8 of one quote's batches 2026-11-04 06:52Z). */
async function askAt(rpc: EvmRpc, calls: readonly EvmRpcCall[]): Promise<readonly unknown[]> {
  for (let i = 0; ; i++) {
    const out = await ask(rpc, calls);
    const behind = out.some((a) => {
      const o = a as { result?: unknown; error?: { message?: unknown } } | null;
      return o?.result === null || (typeof o?.error?.message === "string" && /(block|header).*not found|unknown block|unknown state/i.test(o.error.message));
    });
    if (!behind || i === 3) return out;
    await new Promise((r) => setTimeout(r, FRESH_RETRY_MS * (i + 1)));
  }
}
const FRESH_RETRY_MS = 250;

/** A block header from a provider's answer: number, hash and timestamp, or a refusal. */
function header(a: unknown, who: string): Block {
  const r = (a as { result?: unknown } | null)?.result as { number?: unknown; hash?: unknown; timestamp?: unknown } | null | undefined;
  const q = (x: unknown) => typeof x === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(x);
  if (typeof r !== "object" || r === null || !q(r.number) || !q(r.timestamp) || typeof r.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.hash)) {
    return refuse("rpc_error", `${who} answered no block`);
  }
  return { number: BigInt(r.number as string), hash: lower(r.hash), timestamp: BigInt(r.timestamp as string) };
}

type Block = { number: bigint; hash: string; timestamp: bigint };
/** The block both providers read at: the lower of their two heads, at most `maxLag` blocks apart and no more than
 *  EVM_QUOTE_MAX_AGE_MS behind the device's clock, with `confirm`, which reads that number's hash and time on the other
 *  provider and must find the same block. One provider alone cannot pick an old block, nor name a block the other does
 *  not hold (review of b17d1fc, R1, R1b). `confirm` runs beside the reads, and nothing read is used before it passes. */
async function agreedBlock(rpcs: readonly [EvmRpc, EvmRpc], maxLag: bigint, nowMs: number): Promise<{ block: Block; confirm: () => Promise<void> }> {
  const call: EvmRpcCall = { method: "eth_getBlockByNumber", params: ["latest", false] };
  const heads = await Promise.all(rpcs.map((rpc) => ask(rpc, [call])));
  const [a, b] = heads.map((h, i) => header(h[0], `provider ${i + 1}`)) as [Block, Block];
  if (a.number - b.number > maxLag || b.number - a.number > maxLag) return refuse("rpc_disagree", `the providers' heads ${a.number} and ${b.number} are more than ${maxLag} blocks apart`);
  const [lo, other, who] = a.number <= b.number ? [a, rpcs[1], "provider 2"] : [b, rpcs[0], "provider 1"];
  if (nowMs - Number(lo.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) return refuse("stale_quote", `block ${lo.number} is more than 30 s old`);
  const confirm = async () => {
    const back = header((await askAt(other, [{ method: "eth_getBlockByNumber", params: ["0x" + lo.number.toString(16), false] }]))[0], who);
    if (back.number !== lo.number || back.hash !== lo.hash || back.timestamp !== lo.timestamp) {
      return refuse("rpc_disagree", `the providers hold different blocks at ${lo.number}`);
    }
  };
  return { block: lo, confirm };
}
/** The oldest block a quote reads, and the oldest quote a buy is built from, behind the device's clock. */
export const EVM_QUOTE_MAX_AGE_MS = 30_000;

// The held head (card evm-quote-head-watch): the last block both providers agreed on and confirmed by number (same hash
// and time), kept between quotes so a tap runs only the read round. A quote reads at it only while it was read at most
// EVM_HEAD_REUSE_MS ago on the device's clock (a block's own time trails the clock by its interval and the providers'
// lag: Base's 2 s blocks read 1.1 to 1.4 s behind this Mac's clock, 2026-11-04 10:58Z, so an age by block time held a
// head one refresh in three), and its block under the 30 s rule, well inside the state the pinned providers keep
// (Robinhood's about 13 s: 2 of 11 USDG quotes refused when their reads landed past it, 2026-11-04, card
// evm-pool-buy-quote fold 8); past it the quote agrees on a new block as before. While quotes are asked the head is read
// again every EVM_HEAD_EVERY_MS in the background, each new one held only once confirmed, until EVM_HEAD_IDLE_MS after
// the last quote. A held block never comes from one provider alone, and the stale_quote rule is unchanged.
export const EVM_HEAD_REUSE_MS = 5_000;
const EVM_HEAD_EVERY_MS = 1_500;
const EVM_HEAD_IDLE_MS = 60_000;
export type EvmHeadWatch = {
  /** The block a quote reads at and its confirmation, which runs beside the reads (a held block's already passed). */
  head(nowMs: number): Promise<{ block: Block; confirm: () => Promise<void> }>;
  /** Keeps the head fresh in the background until EVM_HEAD_IDLE_MS from now. */
  keep(): void;
};
/** A held head on the providers `rpcs`; `clock` is the device's (Date.now) and `mono` a clock that never steps back
 *  (performance.now), which times the hold, so a device clock stepped back cannot stretch its 5 s or 30 s (review of
 *  4830f1f, L); the tests set both. `background` false reads only when a quote asks (the tests that count reads). */
export function evmHeadWatch(rpcs: readonly [EvmRpc, EvmRpc], maxLag: bigint, clock: () => number = Date.now, background = true, mono: () => number = () => performance.now()): EvmHeadWatch {
  // `at`: `mono` when the heads were asked; `age`: the block's age on the device's clock then
  let held: { block: Block; at: number; age: number } | null = null;
  let until = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refreshing: Promise<void> | null = null;
  const hold = (b: Block, at: number, nowMs: number) => {
    if (held === null || b.number > held.block.number) held = { block: b, at, age: nowMs - Number(b.timestamp) * 1000 };
  };
  const refresh = () =>
    (refreshing ??= (async () => {
      try {
        const [at, nowMs] = [mono(), clock()];
        const { block, confirm } = await agreedBlock(rpcs, maxLag, nowMs);
        await confirm();
        hold(block, at, nowMs);
      } catch {
        // nothing held changes: the next quote past EVM_HEAD_REUSE_MS agrees on its own block
      } finally {
        refreshing = null;
      }
    })());
  const tick = () => {
    timer = null;
    if (clock() >= until) return;
    void refresh().then(() => {
      if (timer === null && clock() < until) {
        timer = setTimeout(tick, EVM_HEAD_EVERY_MS);
        (timer as { unref?: () => void }).unref?.(); // never holds a process open
      }
    });
  };
  const keep = () => {
    if (!background) return;
    until = clock() + EVM_HEAD_IDLE_MS;
    if (timer === null && refreshing === null) tick();
  };
  return {
    keep,
    async head(nowMs) {
      keep();
      // the device's clock now: a quote asks after its scan, which may have run for seconds since `nowMs`
      const t = Math.max(nowMs, clock());
      const h = held;
      // fresh on both clocks: `mono` cannot be stepped back, and the device's clock still runs while `mono` pauses in
      // a sleep, so a block past 30 s on either is read again, never reused
      const m = mono();
      const since = h === null ? -1 : m - h.at;
      if (h !== null && since >= 0 && since <= EVM_HEAD_REUSE_MS && h.age + since <= EVM_QUOTE_MAX_AGE_MS && t - Number(h.block.timestamp) * 1000 <= EVM_QUOTE_MAX_AGE_MS) {
        return { block: h.block, confirm: async () => {} };
      }
      const a = await agreedBlock(rpcs, maxLag, t);
      return {
        block: a.block,
        confirm: async () => {
          await a.confirm();
          hold(a.block, m, t);
        },
      };
    },
  };
}
// the pinned providers' held heads, one per chain, made at a chain's first quote (no top-level call: the kit's index
// reaches the signing page's bundle)
const WATCHES = new Map<EvmPoolChain, EvmHeadWatch>();

const v3Direct = (weth: string, token: string, fee: number): EvmV3Route => ({ venue: "uniswap-v3", tokens: [weth, token], fees: [fee] });
const v4Direct = (from: string, to: string, [fee, tickSpacing]: readonly [number, number]): EvmV4Route => ({
  venue: "uniswap-v4",
  currencyIn: from,
  hops: [{ currency: to, fee, tickSpacing, hooks: NATIVE, hookData: "0x" }],
});
const startsNative = (r: EvmRoute) => r.venue === "uniswap-v4" && lower(r.currencyIn) === NATIVE;

/** The most pools a caller may list. */
export const EVM_QUOTE_MAX_HINTS = 16;
// The bounds a quote reads within, whatever a token's pool count, each a DoS bound and none a refusal: past one the
// quote prices what it read, in a fixed order an attacker cannot buy into (see "The fixed order" in
// evmPoolBuyQuoteWith). EVM_QUOTE_MAX_KEYS pools' state (two extsload words each) in all, the token's, X's and Y's;
// EVM_QUOTE_MAX_OTHER currencies X and Y in all (one getLogs request names at most SCAN_OR of them); and
// EVM_QUOTE_MAX_QUOTED routes the device made from found pools, each quoted at the amount and twice it.
const EVM_QUOTE_MAX_KEYS = 16_384;
const EVM_QUOTE_MAX_OTHER = 256;
const EVM_QUOTE_MAX_QUOTED = 64;
/** With no more found pools than this, those of the native asset or WETH whose hook is none or pinned are quoted in
 *  the first round already. */
const EVM_QUOTE_EARLY = 64;
const SEL_EXTSLOAD = "1e2eaeaf"; // PoolManager.extsload(bytes32)
const POOLS_SLOT = 6n; // v4-core StateLibrary.POOLS_SLOT
const U24 = 0xffffff;
const keccak = (h: string) => hex(keccak_256(hexToBytes(h)));
/** v4's PoolId: keccak256(abi.encode(PoolKey)). */
const poolId = (k: EvmPoolKey) =>
  keccak(word(BigInt(k.currency0)) + word(BigInt(k.currency1)) + word(BigInt(k.fee)) + word(BigInt.asUintN(256, BigInt(k.tickSpacing))) + word(BigInt(k.hooks)));
/** The pool's state slot in the PoolManager (StateLibrary._getPoolStateSlot): slot0 there, liquidity 3 words on. */
const stateSlot = (id: string) => keccak(id + word(POOLS_SLOT));
/** `p` as a pool key of the token paired with any other currency, or null when it is malformed or not the token's. */
function keyOf(p: unknown, token: string): EvmPoolKey | null {
  if (typeof p !== "object" || p === null) return null;
  const { currency0, currency1, fee, tickSpacing, hooks } = p as Record<string, unknown>;
  if (!isAddress(currency0) || !isAddress(currency1) || !isAddress(hooks)) return null;
  if (!Number.isInteger(fee) || (fee as number) < 0 || (fee as number) > U24) return null;
  if (!Number.isInteger(tickSpacing) || (tickSpacing as number) < 1 || (tickSpacing as number) > 32767) return null;
  const [c0, c1, t] = [lower(currency0), lower(currency1), lower(token)];
  if (BigInt(c0) >= BigInt(c1)) return null;
  if (c0 !== t && c1 !== t) return null;
  return Object.freeze({ currency0: c0, currency1: c1, fee: fee as number, tickSpacing: tickSpacing as number, hooks: lower(hooks) });
}
/** A one-hop v4 route into `token` through the pool `k`, from its other currency. */
const routeOfKey = (k: EvmPoolKey, token: string): EvmV4Route => ({
  venue: "uniswap-v4",
  currencyIn: k.currency1 === lower(token) ? k.currency0 : k.currency1,
  hops: [{ currency: lower(token), fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, hookData: "0x" }],
});
/** The pool key of each hop of a v4 route. */
function hopKeys(r: EvmV4Route): EvmPoolKey[] {
  let from = lower(r.currencyIn);
  return r.hops.map((h) => {
    const to = lower(h.currency);
    const [currency0, currency1] = BigInt(from) < BigInt(to) ? [from, to] : [to, from];
    from = to;
    return { currency0, currency1, fee: h.fee, tickSpacing: h.tickSpacing, hooks: lower(h.hooks) };
  });
}
/** A V4Quoter read of a v4 route the device made from a found pool, encoded as evmPoolRouteData encodes a route but
 *  without the builder's route checks; each starts from the native asset or WETH, passes no WETH and is at most three
 *  hops, so a reference is a v4 route the quoted builder takes (trade/evm/buy-unpinned.ts checkRoute). */
function v4Read(quoter: string, r: EvmV4Route, amount: bigint): { to: string; data: string } {
  const elems = r.hops.map((h) => word(BigInt(h.currency)) + word(BigInt(h.fee)) + word(BigInt.asUintN(256, BigInt(h.tickSpacing))) + word(BigInt(h.hooks)) + word(0xa0n) + word(0n));
  let at = 32 * elems.length;
  const offsets = elems.map((e) => {
    const o = word(BigInt(at));
    at += e.length / 2;
    return o;
  });
  const path = word(BigInt(elems.length)) + offsets.join("") + elems.join("");
  return { to: quoter, data: "0x" + SEL_V4 + word(0x20n) + word(BigInt(r.currencyIn)) + word(0x60n) + word(amount) + path };
}
/** The pool key of a one-hop v4 route. */
function keyOfRoute(r: EvmV4Route): EvmPoolKey {
  const [a, b] = [lower(r.currencyIn), lower(r.hops[0]!.currency)];
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  const h = r.hops[0]!;
  return { currency0, currency1, fee: h.fee, tickSpacing: h.tickSpacing, hooks: lower(h.hooks) };
}

// The device's own scan of the PoolManager's Initialize logs for a currency, kept per chain, currency and kind in this
// module's memory: the first quote for a currency scans `depth` blocks back, each later one from the block the last
// scan reached. A scan only adds pools, so one provider serves it; what it finds is read on both providers like any
// candidate. "all": every pool of the currency; "markets": its pools with the native asset or WETH.
const INITIALIZE = "dd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"; // Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)
const SCANS = new Map<string, { to: number; pools: EvmPoolKey[] }>();
const SCAN_TOKENS = 4096;
const SCAN_MAX_LOGS = 10_000;
/** A scan request that fails or answers SCAN_MAX_LOGS logs or more is asked again as its two halves, at most
 *  SCAN_SPLITS times over (card evm-quote-head-watch): base-rpc.publicnode.com took 3.6 to 10.8 s for a 50,000-block
 *  span of USDC's Initialize logs with 20 at once, past the 10 s timeout, and 0.9 to 2.4 s for 10,000 (2026-11-04
 *  10:50Z), so a cold scan of USDC refused every quote and never kept what it read. At the smallest span the request is
 *  asked as before (askScan) and a failure refuses. */
const SCAN_SPLITS = 3;
/** The most currencies one getLogs request names: an OR of topics, so the currencies of a quote's scan cost the
 *  requests of one. */
const SCAN_OR = 256;
type ScanKind = "all" | "markets";
/** The scan provider's requests at once, across every scan of one quote: the token's and each X's scans queue in the
 *  order they ask (the token's first), at most the venue's `parallel` in flight. Nine scans that each sent their own
 *  `parallel` at once drew 429s on rpc.mainnet.chain.robinhood.com (2026-11-03 21:20Z: 89 of 125 requests). One gate
 *  per quote, so a request that never returns holds up that quote alone. */
type Gate = <T>(f: () => Promise<T>) => Promise<T>;
function gateOf(parallel: number): Gate {
  let free = parallel;
  const waiting: (() => void)[] = [];
  return async (f) => {
    if (free > 0) free--;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      return await f();
    } finally {
      const next = waiting.shift();
      if (next === undefined) free++;
      else next();
    }
  };
}
/** ask, up to 3 more times 0.5, 1 and 1.5 s apart: the scan provider limits its rate ("429 Too Many Requests",
 *  rpc.mainnet.chain.robinhood.com, 2026-11-03 20:27Z). A scan that still fails refuses the quote. */
async function askScan(rpc: EvmRpc, calls: readonly EvmRpcCall[]): Promise<readonly unknown[]> {
  for (let i = 0; ; i++) {
    try {
      return await ask(rpc, calls);
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}
/** The scan provider's head, read once per quote: every scan of the quote reads up to it, so a scan that waits at the
 *  gate behind others is held to the same head as the first (a head read per scan, seconds later, was past maxLag on
 *  Robinhood, 2026-11-03 21:30Z). */
async function scanHeadOf(rpc: EvmRpc, gate: Gate): Promise<bigint> {
  const h = (await gate(() => ask(rpc, [{ method: "eth_blockNumber", params: [] }])))[0] as { result?: unknown } | null;
  if (typeof h?.result !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(h.result)) return refuse("rpc_error", "the scan provider answered no block number");
  const scanHead = BigInt(h.result);
  if (scanHead > BigInt(Number.MAX_SAFE_INTEGER)) return refuse("rpc_disagree", "the scan provider's head is past any block");
  return scanHead;
}
/** The scan of the currencies `cs` up to the scan provider's head, then the agreed block `agreed()`, picked once those
 *  logs are in (card evm-quote-head-watch: a block picked before a long scan had aged past what Robinhood's providers
 *  keep of state by the reads). The head must not be more than `maxLag` blocks past the agreed block (review of
 *  5452011, S2: a head of 2^40 scanned an empty future and its end was kept): one ahead of it reads pools the agreed
 *  block does not hold yet, which its extsload reads drop. A head behind it within `maxLag` misses at most the pools of
 *  those blocks, for this quote only; one further behind (the scan outlasted maxLag blocks) is scanned on up to the
 *  agreed block. The currencies that scan from the same block share each request, as an OR of topics. `commit` keeps
 *  what it read; the quote calls it only once its block is confirmed on both providers. */
async function scanPools(
  chain: EvmPoolChain,
  cs: readonly string[],
  kind: ScanKind,
  weth: string,
  pm: string,
  rpc: EvmRpc,
  s: { span: number; depth: number; parallel: number; orSpan?: number },
  agreed: () => Promise<bigint>,
  maxLag: bigint,
  gate: Gate,
  headOfScan: Promise<bigint>,
): Promise<{ pools: Map<string, EvmPoolKey[]>; commit: () => void }> {
  const scanHead = await headOfScan;
  // the logs up to the scan provider's head are read beside the round before (at most depth / span requests for each
  // SCAN_OR currencies), and used only once that head is found within maxLag of the agreed block
  const head = Number(scanHead);
  const floor = Math.max(0, head - s.depth + 1);
  const each = cs.map((c) => {
    const key = `${chain}:${kind}:${c}`;
    const cached = SCANS.get(key);
    const pools = cached === undefined ? [] : [...cached.pools];
    return { c, key, cached, from: cached === undefined || cached.to < floor ? floor : cached.to + 1, pools, ids: new Set(pools.map(poolId)) };
  });
  type Each = (typeof each)[number];
  const groups = new Map<number, Each[]>();
  for (const e of each) append(groups, e.from, e);
  const w = (c: string) => "0x" + word(BigInt(c));
  const jobs: { part: Each[]; a: number; b: number }[] = [];
  const jobsOf = (g: Each[], from: number, to: number) => {
    for (let i = 0; i < g.length; i += SCAN_OR) {
      const part = g.slice(i, i + SCAN_OR);
      // a provider may span fewer blocks a request when a topic position holds more than one value (orSpan)
      const span = part.length === 1 ? s.span : Math.min(s.span, s.orSpan ?? s.span);
      for (let a = from; a <= to; a += span) jobs.push({ part, a, b: Math.min(to, a + span - 1) });
    }
  };
  for (const [from, g] of groups) jobsOf(g, from, head);
  const one = async ({ part, a, b }: (typeof jobs)[number], splits = SCAN_SPLITS): Promise<{ part: Each[]; a: number; b: number; logs: unknown[] }[]> => {
    const f = (topics: (string | string[] | null)[]) => ({ method: "eth_getLogs", params: [{ address: pm, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), topics }] });
    const t = part.length === 1 ? w(part[0]!.c) : part.map((e) => w(e.c));
    // Initialize's topics are the event, the pool id, currency0 and currency1 (a log read on base-rpc.publicnode.com,
    // block 0x32fd7c9, 2026-11-03 20:40Z): the currency as currency0, then as currency1; a market's other currency is
    // the native asset (address 0, always currency0) or WETH, one value a position
    const e0 = "0x" + INITIALIZE;
    const filters = kind === "all" ? [[e0, null, t], [e0, null, null, t]] : [[e0, null, w(NATIVE), t], [e0, null, w(weth), t], [e0, null, t, w(weth)]];
    const logsOf = (out: readonly unknown[]) => out.map((x) => (x as { result?: unknown } | null)?.result);
    // an answer at the cap may be one the provider cut there (review of 4830f1f, L)
    const fine = (rs: unknown[]) => rs.every((r) => Array.isArray(r) && r.length < SCAN_MAX_LOGS);
    if (splits > 0 && b > a) {
      const rs = await gate(() => ask(rpc, filters.map(f))).then(logsOf, () => null);
      if (rs !== null && fine(rs)) return rs.map((r) => ({ part, a, b, logs: r as unknown[] }));
      const mid = a + Math.floor((b - a) / 2);
      return (await Promise.all([one({ part, a, b: mid }, splits - 1), one({ part, a: mid + 1, b }, splits - 1)])).flat();
    }
    const rs = logsOf(await gate(() => askScan(rpc, filters.map(f))));
    if (!fine(rs)) return refuse("rpc_error", "the scan provider answered no logs");
    return rs.map((r) => ({ part, a, b, logs: r as unknown[] }));
  };
  const got = (await Promise.all(jobs.map((j) => one(j)))).flat();
  const b = await agreed();
  if (scanHead - b > maxLag) return refuse("rpc_disagree", `the scan provider's head ${scanHead} is more than ${maxLag} blocks past the agreed block ${b}`);
  let to = head;
  if (b - scanHead > maxLag) {
    // the scan outlasted maxLag blocks: on from the block after the head, up to the head the scan provider names again,
    // which must be within maxLag of the agreed block (review of 4830f1f, H1: a backend behind it can answer [] past its
    // own head with no error, so a scan is kept only up to a head its provider named), and never further than one span
    // a request (review of 4830f1f, L: a head of 0x1 fanned out into about 10^4 requests)
    if (b - scanHead > BigInt(s.span)) return refuse("rpc_disagree", `the scan provider's head ${scanHead} is more than ${s.span} blocks behind the agreed block ${b}`);
    const again = await scanHeadOf(rpc, gate);
    if (b - again > maxLag) return refuse("rpc_disagree", `the scan provider's head ${again} is more than ${maxLag} blocks from the agreed block ${b}`);
    const end = Number(again < b ? again : b);
    jobs.length = 0;
    jobsOf(each, head + 1, end);
    got.push(...(await Promise.all(jobs.map((j) => one(j)))).flat());
    to = end;
  }
  for (const { part, a, b, logs } of got) {
    for (const l of logs) {
      const o = l as { address?: unknown; topics?: unknown; data?: unknown; blockNumber?: unknown };
      const topics = o?.topics;
      if (typeof o?.address !== "string" || lower(o.address) !== pm || !Array.isArray(topics) || topics.length !== 4 || topics.some((x) => typeof x !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x))) continue;
      const n = typeof o.blockNumber === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(o.blockNumber) ? Number(o.blockNumber) : -1;
      if (lower(topics[0]) !== "0x" + INITIALIZE || n < a || n > b || typeof o.data !== "string" || !/^0x([0-9a-fA-F]{64}){5}$/.test(o.data)) continue;
      const d = o.data.slice(2);
      const addr = (x: string) => "0x" + x.slice(24);
      const tick = BigInt.asIntN(256, BigInt("0x" + d.slice(64, 128)));
      const raw = { currency0: addr(topics[2].slice(2)), currency1: addr(topics[3].slice(2)), fee: Number(BigInt("0x" + d.slice(0, 64)) & 0xffffffn), tickSpacing: Number(tick), hooks: addr(d.slice(128, 192)) };
      for (const e of part) {
        const k = keyOf(raw, e.c);
        if (k === null || e.ids.has(poolId(k))) continue;
        const other = k.currency0 === e.c ? k.currency1 : k.currency0;
        if (kind === "markets" && other !== NATIVE && other !== weth) continue;
        e.ids.add(poolId(k));
        e.pools.push(k);
      }
    }
  }
  const commit = () => {
    for (const e of each) {
      if (!SCANS.has(e.key) && SCANS.size >= SCAN_TOKENS) SCANS.delete(SCANS.keys().next().value!);
      SCANS.set(e.key, { to: Math.max(to, e.cached?.to ?? 0), pools: e.pools });
    }
  };
  return { pools: new Map(each.map((e) => [e.c, e.pools])), commit };
}

/** The device's quote of `req.route` on the chain's two pinned providers, with every check above; throws EvmQuoteError
 *  (or the builder's EvmPoolBuyError for a route it refuses). It takes no provider and no fetch from its caller: a quote
 *  this returns is one evmPoolBuildQuoted builds from, so its answers come only from the pinned URLs (review of 9a8265b,
 *  N2). Tests run evmPoolBuyQuoteWith, which the index does not export. */
export async function evmPoolBuyQuote(req: EvmPoolBuyQuoteRequest): Promise<EvmPoolBuyQuote> {
  if (typeof req !== "object" || req === null) return refuse("bad_request", "the request is an object");
  // each field read once (review of 4830f1f, L: a getter could name one chain for the held head and another for the reads)
  const pools = req.pools;
  const asked: EvmPoolBuyQuoteRequest = { chain: req.chain, token: req.token, amountIn: req.amountIn, slippageBps: req.slippageBps, route: req.route, ...(pools === undefined ? {} : { pools }) };
  const { chain } = asked;
  const v = venue(chain);
  const p = v.providers;
  if (p === undefined) return refuse("no_quoter", `${chain} has no pinned providers`);
  let watch = WATCHES.get(chain);
  if (watch === undefined) WATCHES.set(chain, (watch = evmHeadWatch(evmProviders(p, fetch), v.maxLag)));
  // a scan's answer is a list of logs, bounded by the scan provider's own cap per request (16 MiB read at most)
  return evmPoolBuyQuoteWith(asked, evmProviders(p, fetch), Date.now(), v.scan === undefined ? undefined : evmJsonRpc(v.scan.url, fetch, 16 << 20), watch);
}

/** Two providers from two https URLs on different hosts. */
export function evmProviders(urls: readonly string[], fetchFn: typeof fetch): [EvmRpc, EvmRpc] {
  if (!Array.isArray(urls) || urls.length !== 2) return refuse("bad_request", "two provider URLs");
  const hosts = urls.map((u) => {
    let h: string;
    try {
      // evmJsonRpc below takes only an https URL
      h = new URL(u).hostname.toLowerCase();
    } catch {
      return refuse("bad_request", "a provider URL is https");
    }
    return h;
  });
  if (hosts[0] === hosts[1]) return refuse("bad_request", "the two providers are on one host");
  return [evmJsonRpc(urls[0]!, fetchFn), evmJsonRpc(urls[1]!, fetchFn)];
}

/** What every quote checks before any read, buy or sell: the device's clock, two different providers, the amount in
 *  and the slippage. */
function checkAsk(nowMs: number, rpcsIn: unknown, amountIn: unknown, slippageBps: unknown): void {
  if (!Number.isFinite(nowMs)) return refuse("bad_request", "the device's clock");
  if (!Array.isArray(rpcsIn) || rpcsIn.length !== 2 || typeof rpcsIn[0] !== "function" || typeof rpcsIn[1] !== "function" || rpcsIn[0] === rpcsIn[1]) {
    return refuse("bad_request", "two different providers");
  }
  if (typeof amountIn !== "bigint" || amountIn <= 0n || amountIn >= MAX_IN) return refuse("bad_request", "the amount in is above 0 and below 2^127");
  if (!Number.isInteger(slippageBps) || (slippageBps as number) < 0 || (slippageBps as number) >= 10000) return refuse("bad_request", "the slippage is 0 to 9,999 bps");
}

/** The two providers, every request of a quote to each (its head, its block's confirmation and its reads) at most the
 *  scan provider's limit at once: on each chain one of the two providers is the scan provider's host (Base's publicnode
 *  takes 20 at once, Robinhood's own RPC answers 429 to 4). */
function gated(rpcsIn: readonly [EvmRpc, EvmRpc], parallel: number): readonly [EvmRpc, EvmRpc] {
  return rpcsIn.map((rpc) => {
    const g = gateOf(parallel);
    return (calls: readonly EvmRpcCall[]) => g(() => rpc(calls));
  }) as unknown as readonly [EvmRpc, EvmRpc];
}

/** The reads at the agreed block's hash and that block's confirmation in one round; the confirmation is judged first,
 *  so nothing read is used before it passes. */
async function readAgreed(confirm: () => Promise<void>, rpcs: readonly [EvmRpc, EvmRpc], hash: string, reads: readonly Read[]): Promise<Answer[]> {
  const [confirmed, read] = await Promise.allSettled([confirm(), readBoth(rpcs, hash, reads)]);
  if (confirmed.status === "rejected") throw confirmed.reason;
  if (read.status === "rejected") throw read.reason;
  return read.value;
}

/** evmPoolBuyQuote on the providers `rpcs`, with the device's clock at `nowMs`: what the kit's index exports runs this
 *  with the pinned providers and Date.now(); the tests run it on recorded and planted answers. Not in the index. */
export async function evmPoolBuyQuoteWith(req: EvmPoolBuyQuoteRequest, rpcsIn: readonly [EvmRpc, EvmRpc], nowMs: number, scan?: EvmRpc, watch?: EvmHeadWatch): Promise<EvmPoolBuyQuote> {
  if (typeof req !== "object" || req === null) return refuse("bad_request", "the request is an object");
  const { chain, token, amountIn, slippageBps } = req;
  checkAsk(nowMs, rpcsIn, amountIn, slippageBps);
  const route = copyRoute(req.route);
  if (!isAddress(token) || lower(token) === NATIVE) return refuse("bad_request", "the token is not an address");
  const v = venue(chain);
  const rpcs = gated(rpcsIn, v.scan?.parallel ?? 2);
  const { token: buys } = evmPoolRouteDataQuoted(chain, route);
  if (lower(buys) !== lower(token)) return refuse("token_mismatch", `the route buys ${buys}, not ${token}`);

  // The reads: the route at the amount and at twice it; the hookless route; each standard pool at both amounts; the
  // native pools of the first hop where WETH must not start a route
  const reads: Read[] = [];
  const at = (r: EvmRoute, amount: bigint, override?: Read["override"]) => reads.push({ ...quoteCall(chain, v, r, amount), override }) - 1;
  const main = at(route, amountIn);
  const twice = at(route, 2n * amountIn);
  const hooks = route.venue === "uniswap-v4" ? [...new Set(route.hops.map((h) => lower(h.hooks)).filter((h) => h !== NATIVE))] : [];
  // the hookless read replaces each hook's code: never an address the reads call, nor the token
  if (hooks.some((h) => v.called.has(h) || h === lower(token))) return refuse("bad_request", "a hook of the route is an address the quote calls");
  // the buy enters only where its sell can leave: the same pools backwards, as the sell builder takes them (card
  // evm-route-parity; review of evm-sell-device-quote, H1)
  if (!evmSellExits(chain, token, route)) return refuse("no_exit", "the sell could not leave through the pools this route buys through");
  const hookless = hooks.length > 0 ? at(route, amountIn, Object.fromEntries(hooks.map((h) => [h, { code: EVM_NOOP_HOOK_CODE }]))) : -1;
  const wethStart = !startsNative(route);
  const firstOut = route.venue === "uniswap-v3" ? route.tokens[1]! : route.hops[0]!.currency;
  const firstHop: { at: number; twice: number }[] = [];
  const set = await routeSet({
    chain,
    v,
    token,
    amountIn,
    nowMs,
    rpcs,
    scan,
    reads,
    // the route's own pools: the hook's take in them is H - Q, shown as a fee and bounded by minOut (M360), so R is
    // held to every other pool, never to the route's own pool with its hook replaced
    seen: route.venue === "uniswap-v4" ? hopKeys(route).map(poolId) : [],
    hints: req.pools,
    sell: false,
    watch,
    beforeFound: () => {
      if (v.nativeFirst && wethStart && v.v4 !== undefined && lower(firstOut) !== lower(token)) {
        for (const key of V4_KEYS) {
          const r = v4Direct(NATIVE, firstOut, key);
          firstHop.push({ at: at(r, amountIn), twice: at(r, 2n * amountIn) });
        }
      }
    },
    // The route: a quote, and one that grows with its input
    firstRound: (out, answer) => {
      const q = out(main);
      const m = answer(main);
      if (m.kind === "revert" && m.partial) return refuse("partial_fill", "a hookless hop runs out of liquidity (NotEnoughLiquidity)");
      if (q === null || q === 0n) return refuse("no_quote", "the route reverts or quotes nothing");
      const q2 = out(twice);
      if (q2 !== null && q2 <= q) return refuse("partial_fill", `twice the amount quotes ${q2}, not more than ${q}: a pool runs out`);
      // a v3 route has no hook: its quote at twice the amount reverts only when a pool cannot fill it
      if (q2 === null && route.venue === "uniswap-v3") return refuse("partial_fill", "twice the amount reverts on a v3 route");
    },
  });
  const { block, out, fills, filled } = set;
  const q = out(main)!;

  const nativeExists = v.nativeFirst && (filled.some((c) => startsNative(c.route)) || firstHop.some((c) => fills(c)));
  // R is the best of every pool, whatever it starts from: a native pool someone seeded is held to the token's WETH
  // pools too (a launchpad's, on Robinhood). Where a native pool exists a route starts native unless it quotes strictly
  // more than the best native route (native when at least as good); the native_first refusal names that native route.
  // A native pool of the first hop alone, with no native route to the token quoted, still refuses: nothing shows the
  // WETH start beats starting that hop native
  const reference = bestOf(filled);
  const nativeBest = bestOf(filled.filter((c) => startsNative(c.route)));
  if (nativeExists && wethStart && (nativeBest === null || q <= nativeBest.amountOut)) {
    return refuse("native_first", `${chain}'s WETH is behind an upgradeable proxy and a native route quotes at least as much`, nativeBest);
  }
  if (reference === null) return refuse("no_reference", "no standard pool and no pinned launchpad pool answers for the token");
  if (q < reference.amountOut) {
    return refuse("below_reference", `the route quotes ${q}, below the standard pool's ${reference.amountOut}`, reference);
  }

  let hook: EvmHookTake | null = null;
  if (hookless >= 0) {
    const h = out(hookless);
    const take = h === null ? null : h > q ? h - q : 0n;
    hook = Object.freeze({ hookless: h, take, takeBps: h === null || take === null || h === 0n ? null : Number((take * 10000n) / h) });
  }
  const minOut = (q * BigInt(10000 - slippageBps)) / 10000n;
  if (minOut === 0n) return refuse("no_quote", "the route quotes too little to set a minimum above 0");
  const quote: EvmPoolBuyQuote = Object.freeze({ chain, token, amountIn, route, block: Object.freeze(block), amountOut: q, minOut, reference, hook });
  QUOTED.add(quote);
  return quote;
}

type Filled = { route: EvmRoute; amountOut: bigint };
const best = (xs: readonly Filled[]) => xs.reduce<Filled | null>((m, c) => (m === null || c.amountOut > m.amountOut ? c : m), null);
const bestOf = (xs: readonly Filled[]) => {
  const b = best(xs);
  return b === null ? null : Object.freeze({ amountOut: b.amountOut, route: copyRoute(b.route) });
};

/** True when W can sell `token` back through the pools `route` buys through: the same pools backwards, as the sell
 *  builder takes them (trade/evm/sell-unpinned.ts evmSellRouteCheck). */
function evmSellExits(chain: EvmPoolChain, token: string, route: EvmRoute): boolean {
  try {
    evmSellRouteCheck(chain, token, evmSellRouteOf(route));
    return true;
  } catch {
    return false;
  }
}

/** The sell through the pools a buy route buys through, backwards: from the token to where the buy started (the native
 *  asset, or WETH), each hop's pool the same, its hook data empty. */
export function evmSellRouteOf(r: EvmRoute): EvmSellRoute {
  if (r.venue === "uniswap-v3") return Object.freeze({ venue: r.venue, tokens: Object.freeze([...r.tokens].reverse().map(lower)), fees: Object.freeze([...r.fees].reverse()) });
  const cs = [r.currencyIn, ...r.hops.map((h) => h.currency)].map(lower);
  const hops = r.hops.map((h, i): EvmV4Hop => Object.freeze({ currency: cs[i]!, fee: h.fee, tickSpacing: h.tickSpacing, hooks: lower(h.hooks), hookData: "0x" }));
  return Object.freeze({ venue: r.venue, hops: Object.freeze(hops.reverse()) });
}

/** A sell quote's read of the buy route `r` backwards (evmSellRouteOf), from `amount` of the token. */
function sellRead(v: Venue, token: string, r: EvmRoute, amount: bigint): { to: string; data: string } {
  const s = evmSellRouteOf(r);
  if (s.venue === "uniswap-v3") {
    if (v.v3 === undefined) return refuse("no_quoter", "no pinned v3 quoter");
    let path = lower(token).slice(2);
    s.fees.forEach((f, i) => (path += f.toString(16).padStart(6, "0") + s.tokens[i + 1]!.slice(2)));
    const n = path.length / 2;
    return { to: v.v3, data: "0x" + SEL_V3 + word(0x40n) + word(amount) + word(BigInt(n)) + path.padEnd(Math.ceil(n / 32) * 64, "0") };
  }
  if (v.v4 === undefined) return refuse("no_quoter", "no pinned v4 quoter");
  return { to: v.v4, data: "0x" + SEL_V4 + word(0x20n) + word(BigInt(token)) + word(0x60n) + word(amount) + hex(pathKeysAbi(s.hops)) };
}

type Venue = ReturnType<typeof venue>;

/** How a route's price counts, the one rule for the buy and the sell (card evm-quote-exec-sim): a route with no hook,
 *  or only hooks of launchpads the venue lists in their own shapes (evmHookListed), keeps the quoter's price. A route
 *  through any other hook may be priced by a hook that lets only the quoter trade (review of edb4dbb, F4), so where the
 *  chain pins a sell delegate it counts only once an eth_call of the exact trade from W executes it at that price
 *  ("sim"); where it pins none (mainnet until pool-evm-deploy) it keeps the lower of its quote with the hook replaced and
 *  as it is ("keep-min"), which refuses rather than signs at a seeded price. The freeze a hook that lets only the
 *  quoter trade can put on a token's trades (probe PE) therefore lasts on such a chain until pool-evm-deploy pins its
 *  sell delegate. A requested buy through such a hook is refused no_exit (evmSellExits) on every chain. */
function simRule(chain: EvmPoolChain, route: EvmRoute, sellDelegate: string | undefined): "quoter" | "sim" | "keep-min" {
  if (route.venue !== "uniswap-v4" || hopKeys(route).every((k) => k.hooks === NATIVE || evmHookListed(chain, k.hooks, k.fee, k.tickSpacing))) return "quoter";
  return sellDelegate !== undefined ? "sim" : "keep-min";
}

const SEL_NONCE = "affed0e0"; // SellDelegate.nonce()
/** The sim pool's code: CALLVALUE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN, so sell() returns what W gained. */
const SIM_POOL_CODE = "0x3460005260206000f3";
/** W's code in a sim: the 7702 designator of the chain's pinned sell delegate, as on chain (test/evm-sim-facts.test.ts:
 *  every pinned provider runs the delegate in W's own context). */
const designator = (delegate: string) => "0xef0100" + lower(delegate).slice(2);

/** The sell routes in `routes` whose price holds against an eth_call of W's own sell through them (simRule "sim") at
 *  the agreed block on both providers: each such route above `floor` is simmed once, with minOut its price; a route
 *  whose sim reverts is dropped. W's nonce is read at the block; each sim is its own eth_call (one call's state would
 *  carry into the next). */
async function simmedSells(chain: EvmPoolChain, delegate: string | undefined, rpcs: readonly [EvmRpc, EvmRpc], block: Block, w: string, token: string, amountIn: bigint, routes: Filled[], floor: bigint, signSim: EvmPoolSellQuoteRequest["signSim"]): Promise<Filled[]> {
  const toSim = routes.filter((r) => r.amountOut > floor && simRule(chain, r.route, delegate) === "sim");
  if (toSim.length === 0) return routes;
  if (typeof signSim !== "function") return refuse("bad_request", "a route through a hook the venue does not list needs a sim sell W signs (signSim)");
  const asW = { [lower(w)]: { code: designator(delegate!) } };
  const [n] = await readBoth(rpcs, block.hash, [{ to: lower(w), data: "0x" + SEL_NONCE, override: asW }]);
  if (n!.kind !== "out") return refuse("no_quote", "W's sell nonce does not read through the sell delegate");
  const reads: Read[] = toSim.map((r) => {
    const s = evmSellRouteOf(r.route) as EvmV4SellRoute;
    const sim = evmPoolBuildSimSellUnpinned(chain, { w, token, amount: amountIn, hops: s.hops, minOut: r.amountOut, nonce: n!.amountOut, deadline: block.timestamp });
    const sig = signSim(sim, block.timestamp);
    return { to: lower(w), data: evmSellCallData(sim, 0n, sig), override: { ...asW, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } } };
  });
  const ans = await readBoth(rpcs, block.hash, reads);
  const failed = new Set(toSim.filter((_, i) => { const a = ans[i]!; return a.kind !== "out" || a.amountOut < toSim[i]!.amountOut; }));
  return routes.filter((r) => !failed.has(r));
}

/**
 * The device's route set for `token` (card evm-route-parity): one set of pools, the buy's and the sell's alike, each a
 * route from the native asset or WETH into the token. The buy quotes each forwards at its amount of the native asset;
 * the sell quotes each backwards (evmSellRouteOf) at its amount of the token. The set:
 * - the standard pools: v3 from WETH at each fee tier, v4 from the native asset at each fee and tick spacing, with no
 *   hook; each two-hop through each listed middle, on both venues; each launchpad pool the venue lists;
 * - the pools the device found (see "The pools the device found" below): its own scan of the PoolManager's Initialize
 *   logs and the caller's list, each read on the PoolManager's state; the token's pools of the native asset or WETH,
 *   its pools of another currency X through X's markets, and one level further through Y.
 * The buy picks X's market that quotes the most X at its amount; the sell, X's market that gives the most for the most
 * X one of the token's pools with X gives at its amount, and both go one level further where X has no market that
 * fills (review of edb4dbb, F1, F2).
 * Returns the agreed block, the answers, and every route of the set that fills, with its output (through a hook that
 * is not pinned, the lower of its quote with the hook replaced and as it is).
 */
async function routeSet(a: {
  chain: EvmPoolChain;
  v: Venue;
  token: string;
  amountIn: bigint;
  nowMs: number;
  rpcs: readonly [EvmRpc, EvmRpc];
  scan: EvmRpc | undefined;
  /** the caller's own reads of the first round, before the set's */
  reads: Read[];
  /** a sell's `bought` route (one the sell builder takes), read like a route the device made from found pools */
  bought?: EvmRoute | undefined;
  /** pool ids the set leaves out */
  seen: readonly string[];
  /** the caller's list of pools (never trusted) */
  hints: unknown;
  /** quote each route backwards, from the token */
  sell: boolean;
  /** the chain's held head (card evm-quote-head-watch) */
  watch?: EvmHeadWatch | undefined;
  /** the caller's reads after the standard pools' (the buy's first-hop reads, in the order its recorded reads hold) */
  beforeFound?: () => void;
  /** the caller's refusals on the first round's answers, before any later round */
  firstRound?: (out: (i: number) => bigint | null, answer: (i: number) => Answer) => void;
}): Promise<{ block: Block; out: (i: number) => bigint | null; fills: (c: { at: number; twice: number }, v3?: boolean) => boolean; filled: Filled[] }> {
  const { chain, v, token, amountIn, rpcs, scan, reads } = a;
  // a route's read at an amount: the buy's forwards, the sell's backwards from `from` (the token, or for part of a
  // route, the currency it starts that part from)
  const readOf = (r: EvmRoute, amount: bigint, found: boolean, from = token) =>
    a.sell ? sellRead(v, from, r, amount) : found ? v4Read(v.v4!, r as EvmV4Route, amount) : quoteCall(chain, v, r, amount);
  const at = (r: EvmRoute, amount: bigint) => reads.push(readOf(r, amount, false)) - 1;
  // a sell through v3 needs the chain's router, and through v4 its PoolManager
  const v3 = v.v3 !== undefined && (!a.sell || evmPoolVenues()[chain].routers.length > 0);
  const v4 = v.v4 !== undefined && (!a.sell || v.poolManager !== undefined);
  const candidates: { route: EvmRoute; at: number; twice: number }[] = [];
  const candidate = (r: EvmRoute) => candidates.push({ route: r, at: at(r, amountIn), twice: at(r, 2n * amountIn) });
  if (v3) for (const fee of V3_FEES) candidate(v3Direct(v.weth, token, fee));
  if (v4) for (const key of V4_KEYS) candidate(v4Direct(NATIVE, token, key));
  // every route, whatever its shape and venue, is also held to each standard two-hop through each listed middle, on
  // both venues (review of b17d1fc, R2, R3), and to each pinned launchpad pool shape for the token
  for (const middle of v.middles) {
    if (lower(middle) === lower(token)) continue;
    if (v3) for (const f1 of V3_FEES) for (const f2 of V3_FEES) candidate({ venue: "uniswap-v3", tokens: [v.weth, middle, token], fees: [f1, f2] });
    if (!v4) continue;
    for (const k1 of V4_KEYS) {
      for (const k2 of V4_KEYS) {
        candidate({
          venue: "uniswap-v4",
          currencyIn: NATIVE,
          hops: [
            { currency: middle, fee: k1[0], tickSpacing: k1[1], hooks: NATIVE, hookData: "0x" },
            { currency: token, fee: k2[0], tickSpacing: k2[1], hooks: NATIVE, hookData: "0x" },
          ],
        });
      }
    }
  }
  if (v4) {
    for (const h of v.hookedPools) {
      // never a pool whose hook is the token itself or an address the reads call, as a found pool is dropped
      if (lower(h.hooks) === lower(token) || v.called.has(lower(h.hooks))) continue;
      const from = h.from === "native" ? NATIVE : v.weth;
      candidate({ venue: "uniswap-v4", currencyIn: from, hops: [{ currency: token, fee: h.fee, tickSpacing: h.tickSpacing, hooks: h.hooks, hookData: "0x" }] });
    }
  }
  a.beforeFound?.();

  // The pools the device found: its own scan of the PoolManager's Initialize logs (beside the heads' round, to a head
  // within maxLag of the agreed block) and the caller's list, of the token with any currency. Each one's state (price
  // and liquidity, through extsload) is read with everything else; a pool of the native asset or WETH whose hook is
  // none or pinned is quoted in that same round. A pool whose hook is replaced is quoted only in a later round at the
  // same block, once the PoolManager holds it on both providers, so a pool that does not exist never puts an override
  // into a read (review of 5452011, S1). A pool of another currency X counts through X's own markets with the native
  // asset or WETH (see "X's markets" below).
  // The fixed order of every bound (EVM_QUOTE_MAX_KEYS, EVM_QUOTE_MAX_OTHER, EVM_QUOTE_MAX_QUOTED): the caller's
  // list, then pools of the native asset or WETH, then of a listed middle, then the rest, each by pool id; X and Y
  // listed first, then by the smallest id of their pools. No number a pool reports at the block (its price, its
  // liquidity, which a narrow range inflates for the price of a dust position) decides what is read, quoted or
  // refused (review of 2afa8b6): a bound only leaves pools unread, and what is read is priced by its quote at the
  // user's own amount
  // the agreed block, picked once (the held head while fresh), after the token's scan has its logs; a new one is held
  // to the 30 s rule in agreedBlock, a held one in the watch's reuse bound on both clocks
  let agreed: ReturnType<typeof agreedBlock> | undefined;
  const agreedOnce = () => (agreed ??= a.watch === undefined ? agreedBlock(rpcs, v.maxLag, a.nowMs) : a.watch.head(a.nowMs));
  const agreedNumber = () => agreedOnce().then((x) => x.block.number);
  const gate = gateOf(v.scan?.parallel ?? 1);
  let headOfScan: Promise<bigint> | undefined;
  const scanOf = (cs: readonly string[], kind: ScanKind) =>
    scan !== undefined && v.poolManager !== undefined && v.scan !== undefined && cs.length > 0
      ? scanPools(chain, cs, kind, lower(v.weth), v.poolManager, scan, v.scan, agreedNumber, v.maxLag, gate, (headOfScan ??= scanHeadOf(scan, gate)))
      : null;
  const scanned = await scanOf([lower(token)], "all");
  const { block, confirm } = await agreedOnce();
  // a pool's hook is trusted as it is only where the sell builder takes it: a listed launchpad's hook with that
  // launchpad's own fee and tick spacing (evmHookListed, the one rule for both; card evm-route-parity); any other hook
  // is replaced in the reads that price the pool
  const replaced = (k: { hooks: string; fee: number; tickSpacing: number }) => k.hooks !== NATIVE && !evmHookListed(chain, k.hooks, k.fee, k.tickSpacing);
  // the override of a read through these pools: each hook not trusted, replaced by the hook that does nothing, and the
  // reads of the same hooks grouped together
  const noop = (keys: EvmPoolKey[]) => {
    const hs = [...new Set(keys.filter(replaced).map((k) => k.hooks))].sort();
    return hs.length === 0 ? {} : { override: Object.fromEntries(hs.map((h) => [h, { code: EVM_NOOP_HOOK_CODE }])), group: hs.join(",") };
  };
  // a pool whose hook is an address the reads call, the token or one of the pool's currencies is dropped: its hook is
  // never replaced (a hookless pool, hook 0, has none to replace)
  const droppable = (k: EvmPoolKey) => k.hooks !== NATIVE && (v.called.has(k.hooks) || k.hooks === lower(token) || k.hooks === k.currency0 || k.hooks === k.currency1);
  const startsBuy = (c: string) => c === NATIVE || c === lower(v.weth);
  const listed = new Set(v.middles.map(lower));
  const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  // `real`: the same route with its hooks as they are, read where a hook is replaced (see valueOf)
  type Quote = { route: EvmRoute; at: number; twice: number; real?: { at: number; twice: number } };
  type Found = { key: EvmPoolKey; id: string; other: string; price: number; liquidity: number; quotes: Quote[] };
  // a read into `into`: the reads of this round (`reads`) or of a later one, answered after the ones before
  const put = (into: Read[], r: Read) => (into === reads ? 0 : reads.length) + into.push(r) - 1;
  // (each pool id once: USDG's 9,942 pools on Robinhood spent about a second of the device's time on repeats)
  const foundOf = (k: EvmPoolKey, of: string, into: Read[], id = poolId(k)): Found => {
    const slot = BigInt("0x" + stateSlot(id));
    const st = (x: bigint) => put(into, { to: v.poolManager!, data: "0x" + SEL_EXTSLOAD + word(x), state: true });
    return { key: k, id, other: k.currency0 === lower(of) ? k.currency1 : k.currency0, price: st(slot), liquidity: st(slot + 3n), quotes: [] };
  };
  let keysLeft = EVM_QUOTE_MAX_KEYS;
  let quotesLeft = EVM_QUOTE_MAX_QUOTED;
  // a route the device made from found pools, at the amount and twice it, each hook not pinned replaced, and where one
  // is, the same route with its hooks as they are; null past the bound. A sell's part of a route reads from `from` at
  // `amount` (see "X's markets")
  const quoteAt = (into: Read[], r: EvmV4Route, hooks: EvmPoolKey[], from: string, amount: bigint): Quote => {
    const c: Quote = { route: r, at: put(into, { ...readOf(r, amount, true, from), ...noop(hooks) }), twice: put(into, { ...readOf(r, 2n * amount, true, from), ...noop(hooks) }) };
    if (hooks.some(replaced)) c.real = { at: put(into, readOf(r, amount, true, from)), twice: put(into, readOf(r, 2n * amount, true, from)) };
    return c;
  };
  const quoteOf = (into: Read[], r: EvmV4Route, hooks: EvmPoolKey[], from = token, amount = amountIn): Quote | null => {
    if (quotesLeft === 0) return null;
    quotesLeft--;
    return quoteAt(into, r, hooks, from, amount);
  };
  // a sell's `bought` route: read in the first round under the same rule as a route the device made (each hook not
  // pinned replaced, and the lower of that and its quote as it is), outside the bound (review of edb4dbb, F5)
  const bought: Quote | null =
    a.bought === undefined ? null
    : a.bought.venue === "uniswap-v4" ? quoteAt(reads, a.bought, hopKeys(a.bought), token, amountIn)
    : { route: a.bought, at: at(a.bought, amountIn), twice: at(a.bought, 2n * amountIn) };
  const found: Found[] = [];
  if (v4 && v.poolManager !== undefined) {
    const seen = new Set(candidates.flatMap((c) => (c.route.venue === "uniswap-v4" && c.route.hops.length === 1 ? [poolId(keyOfRoute(c.route))] : [])));
    for (const id of a.seen) seen.add(id);
    const hints = (Array.isArray(a.hints) ? a.hints.slice(0, EVM_QUOTE_MAX_HINTS) : []).flatMap((p) => {
      const k = keyOf(p, token);
      return k === null ? [] : [k];
    });
    const hinted = new Set(hints.map(poolId));
    const keys = [...(scanned?.pools.get(lower(token)) ?? []), ...hints].flatMap((k) => {
      const id = poolId(k);
      if (seen.has(id) || droppable(k)) return [];
      seen.add(id);
      return [{ k, id, other: k.currency0 === lower(token) ? k.currency1 : k.currency0 }];
    });
    const rank = (e: { id: string; other: string }) => (hinted.has(e.id) ? 0 : startsBuy(e.other) ? 1 : listed.has(e.other) ? 2 : 3);
    // a set the bound cuts is never quoted from (review of 4830f1f, H2): 16,384 pools only initialized, each a few
    // cents of gas, with ids ground below the real pool's, pushed it out of the reads and a seeded route at a tenth of
    // the price was bought
    if (keys.length > keysLeft) return refuse("too_many_pools", `the token has ${keys.length} pools, more than the ${keysLeft} a quote reads`);
    const ordered = keys.sort((x, y) => rank(x) - rank(y) || byId(x, y));
    keysLeft -= ordered.length;
    const early = ordered.length <= EVM_QUOTE_EARLY;
    for (const { k, id } of ordered) {
      const f = foundOf(k, token, reads, id);
      if (early && startsBuy(f.other) && !replaced(k)) {
        const c = quoteOf(reads, routeOfKey(k, token), [k]);
        if (c !== null) f.quotes.push(c);
      }
      found.push(f);
    }
  }

  // the lower head's confirmation and the reads at its hash in one round; the confirmation is judged first
  const ans = await readAgreed(confirm, rpcs, block.hash, reads);
  // the block is the same on both providers: the scan keeps what it read up to it
  scanned?.commit();
  const out = (i: number) => (ans[i]!.kind === "out" ? (ans[i] as { amountOut: bigint }).amountOut : null);
  a.firstRound?.(out, (i) => ans[i]!);

  // a found pool counts only where the PoolManager holds it: a price (slot0's low 160 bits) and liquidity above 0
  const holds = (f: Found) => {
    const p = out(f.price);
    const l = out(f.liquidity);
    return p !== null && (p & ((1n << 160n) - 1n)) !== 0n && l !== null && (l & ((1n << 128n) - 1n)) !== 0n;
  };
  const held = found.filter(holds);
  const fills = (c: { at: number; twice: number }, isV3 = false) => {
    const x = out(c.at);
    const y = out(c.twice);
    return x !== null && x > 0n && (y === null ? !isV3 : y > x);
  };
  // What a route the device made counts for: its quote, where it fills; through a hook that is not pinned, the lower of
  // its quote with the hook replaced and with the hook as it is, each of which must fill. The hook replaced, a hook
  // cannot raise R above what its pool's liquidity gives; as it is, a hook that reverts or takes a fee on every swap
  // (a pool only its own router may swap in, as one of USDG's WETH pools on Robinhood, 2026-11-04 06:59Z) cannot set an
  // R that no buy through it reaches
  const valueOf = (c: Quote): bigint | null => {
    if (!fills(c)) return null;
    if (c.real === undefined) return out(c.at);
    if (!fills(c.real)) return null;
    const [x, y] = [out(c.at)!, out(c.real.at)!];
    return x < y ? x : y;
  };
  // one more round of reads at the same block, its answers after the ones before
  const round = async (more: Read[]) => {
    if (more.length === 0) return;
    const base = reads.length;
    reads.push(...more);
    ans.push(...(await readBoth(rpcs, block.hash, reads.slice(base))));
  };
  const hopTo = (c: string, k: EvmPoolKey) => ({ currency: c, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, hookData: "0x" });
  const ok = v4 && v.poolManager !== undefined;

  // The token's held pools of the native asset or WETH, each quoted where not already
  const second: Read[] = [];
  for (const f of held) {
    if (!startsBuy(f.other) || f.quotes.length > 0) continue;
    const c = quoteOf(second, routeOfKey(f.key, token), [f.key]);
    if (c !== null) f.quotes.push(c);
  }
  // X's markets: a held pool of the token with another currency X counts through X's markets with the native asset or
  // WETH: X's standard and pinned shapes, which need no scan, and the pools of X with them that one scan for every X
  // finds (an OR of topics, cached per X, kept once the block is confirmed). Each is read like the token's pools: its
  // state first, quoted only where the PoolManager holds it, its hook replaced only then. Each X is priced by its market
  // that quotes the most X at the user's own amount (a market must fill it to count, so to rank first a pool must
  // give more, which only raises R), and each of the token's pools with X through that market: a v4 route from the
  // native asset or WETH, named whole as the reference (review of f44fbdb, Low). An X with no market that fills is
  // priced one level further (review of f44fbdb, T3): through each of its held pools with another currency Y, and Y's
  // best market, read the same way. A quote that reverts or runs out adds nothing; a held pool that no route from the
  // native asset or WETH reaches adds nothing, since a buyer cannot reach it either. A sell prices X's markets the same
  // way at an amount of X: the most X one of the token's held pools with X gives for the user's amount of the token,
  // each such pool quoted once (and Y's at the most Y one of X's pools with Y gives for that), so a sell quotes
  // |markets| + 2 x |pools| per X as the buy quotes |markets| + |pools|, and goes one level further exactly where the
  // buy does: where X has no market that fills (review of edb4dbb, F1, F2)
  const xPools = new Map<string, Found[]>();
  for (const f of held) if (!startsBuy(f.other)) append(xPools, f.other, f);
  const smallest = (fs: readonly Found[]) => fs.map((f) => f.id).sort()[0]!;
  const others = (m: Map<string, Found[]>, cap: number) =>
    [...m.keys()]
      .map((c) => ({ c, id: smallest(m.get(c)!) }))
      .sort((x, y) => Number(!listed.has(x.c)) - Number(!listed.has(y.c)) || byId(x, y))
      .slice(0, cap)
      .map((e) => e.c);
  const xs = others(xPools, EVM_QUOTE_MAX_OTHER);
  // c's markets: its standard and pinned shapes, then the scanned ones by pool id; null past the state bound
  const marketsOf = (c: string, scannedKeys: readonly EvmPoolKey[], into: Read[]): Found[] | null => {
    const ks = new Map<string, EvmPoolKey>();
    const add = (k: EvmPoolKey | null) => {
      if (k !== null && !droppable(k) && !ks.has(poolId(k))) ks.set(poolId(k), k);
    };
    for (const [fee, tickSpacing] of V4_KEYS) add(keyOf({ currency0: NATIVE, currency1: c, fee, tickSpacing, hooks: NATIVE }, c));
    for (const h of v.hookedPools) {
      const from = h.from === "native" ? NATIVE : lower(v.weth);
      const [c0, c1] = BigInt(from) < BigInt(c) ? [from, c] : [c, from];
      add(keyOf({ currency0: c0, currency1: c1, fee: h.fee, tickSpacing: h.tickSpacing, hooks: h.hooks }, c));
    }
    for (const { k } of scannedKeys.map((k) => ({ k, id: poolId(k) })).sort(byId)) add(k);
    if (ks.size > keysLeft) return null;
    keysLeft -= ks.size;
    return [...ks.values()].map((k) => foundOf(k, c, into));
  };
  const markets = new Map<string, Found[]>();
  const readMarkets = async (cs: readonly string[], into: Read[]) => {
    // a scan that fails refuses the quote, as the token's does: a market it missed could be the one that sets R
    const sc = await scanOf(cs, "markets");
    sc?.commit();
    for (const c of cs) {
      if (markets.has(c)) continue;
      const ms = marketsOf(c, sc?.pools.get(c) ?? [], into);
      if (ms !== null) markets.set(c, ms);
    }
  };
  if (ok) await readMarkets(xs, second);
  // a sell's part of a route into c: the most of c a quote of it gives for the user's amount of the token, and the
  // part that gives it (a quote that does not fill gives nothing)
  const legs = new Map<string, { q: Quote; p: Found }[]>();
  const legOf = (c: string): { amount: bigint; p: Found } | null => {
    let b: { amount: bigint; p: Found } | null = null;
    for (const { q, p } of legs.get(c) ?? []) {
      const x = valueOf(q);
      if (x !== null && (b === null || x > b.amount)) b = { amount: x, p };
    }
    return b;
  };
  if (a.sell) {
    for (const x of xs) {
      for (const p of xPools.get(x)!) {
        const q = quoteOf(second, { venue: "uniswap-v4", currencyIn: x, hops: [hopTo(lower(token), p.key)] }, [p.key]);
        if (q !== null) append(legs, x, { q, p });
      }
    }
  }
  await round(second);
  const marketQuote = new Map<Found, Quote>();
  // each held market of c, quoted from the native asset or WETH at the user's amount (a buy), or from c at the most
  // of c the sell's part of a route into c gives (a sell; none where no such part fills)
  const quoteMarkets = (cs: readonly string[], into: Read[]) => {
    for (const c of cs) {
      const leg = a.sell ? legOf(c) : null;
      if (a.sell && leg === null) continue;
      for (const mk of (markets.get(c) ?? []).filter(holds)) {
        const r = leg === null ? quoteOf(into, routeOfKey(mk.key, c), [mk.key]) : quoteOf(into, routeOfKey(mk.key, c), [mk.key], c, leg.amount);
        if (r !== null) marketQuote.set(mk, r);
      }
    }
  };
  // c's market whose quote counts for the most of c at the user's amount; the first in order on a tie
  const bestMarket = (c: string): Found | null => {
    let [b, bv]: [Found | null, bigint] = [null, 0n];
    for (const mk of markets.get(c) ?? []) {
      const r = marketQuote.get(mk);
      const x = r === undefined ? null : valueOf(r);
      if (x !== null && (b === null || x > bv)) [b, bv] = [mk, x];
    }
    return b;
  };
  const third: Read[] = [];
  quoteMarkets(xs, third);
  await round(third);
  const fourth: Read[] = [];
  const further: string[] = [];
  for (const x of xs) {
    const mk = bestMarket(x);
    if (mk === null) {
      // a sell's X that no pool of the token reaches gives no route further either
      if (markets.has(x) && (!a.sell || legOf(x) !== null)) further.push(x);
      continue;
    }
    for (const p of xPools.get(x)!) {
      const c = quoteOf(fourth, { venue: "uniswap-v4", currencyIn: mk.other, hops: [hopTo(x, mk.key), hopTo(lower(token), p.key)] }, [mk.key, p.key]);
      if (c !== null) p.quotes.push(c);
    }
  }
  // one level further: X's pools with Y, from one scan of every such X's pools
  const vias = new Map<string, Found[]>();
  if (ok && further.length > 0) {
    const sc = await scanOf(further, "all");
    sc?.commit();
    for (const x of further) {
      const ks = (sc?.pools.get(x) ?? [])
        .map((k) => ({ k, id: poolId(k), other: k.currency0 === x ? k.currency1 : k.currency0 }))
        .filter((e) => !startsBuy(e.other) && e.other !== lower(token) && !droppable(e.k))
        .sort(byId);
      if (ks.length > keysLeft) continue;
      keysLeft -= ks.length;
      vias.set(x, ks.map((e) => foundOf(e.k, x, fourth, e.id)));
    }
  }
  await round(fourth);
  const yPools = new Map<string, Found[]>();
  for (const fs of vias.values()) for (const f of fs.filter(holds)) append(yPools, f.other, f);
  const ys = others(yPools, Math.max(0, EVM_QUOTE_MAX_OTHER - xs.length));
  const fifth: Read[] = [];
  if (ok) await readMarkets(ys, fifth);
  // a sell's part of a route into Y: the token into X through X's pool that gives the most X, then X into Y
  if (a.sell) {
    for (const [x, fs] of vias) {
      const into = legOf(x);
      if (into === null) continue;
      for (const via of fs.filter((f) => holds(f) && ys.includes(f.other) && !xs.includes(f.other))) {
        const q = quoteOf(fifth, { venue: "uniswap-v4", currencyIn: via.other, hops: [hopTo(x, via.key), hopTo(lower(token), into.p.key)] }, [via.key, into.p.key]);
        if (q !== null) append(legs, via.other, { q, p: into.p });
      }
    }
  }
  await round(fifth);
  const sixth: Read[] = [];
  quoteMarkets(ys.filter((y) => !xs.includes(y)), sixth);
  await round(sixth);
  const seventh: Read[] = [];
  for (const [x, fs] of vias) {
    for (const via of fs.filter(holds)) {
      const mk = ys.includes(via.other) ? bestMarket(via.other) : null;
      if (mk !== null) {
        for (const p of xPools.get(x)!) {
          const r: EvmV4Route = { venue: "uniswap-v4", currencyIn: mk.other, hops: [hopTo(via.other, mk.key), hopTo(x, via.key), hopTo(lower(token), p.key)] };
          const c = quoteOf(seventh, r, [mk.key, via.key, p.key]);
          if (c !== null) p.quotes.push(c);
        }
      }
    }
  }
  await round(seventh);

  // The standard pools: each that quotes and fills completely; and every route the device made from a found pool that
  // fills
  const filled: Filled[] = candidates.flatMap((c) => (fills(c, c.route.venue === "uniswap-v3") ? [{ route: c.route, amountOut: out(c.at)! }] : []));
  for (const f of held) {
    for (const c of f.quotes) {
      const x = valueOf(c);
      if (x !== null) filled.push({ route: c.route, amountOut: x });
    }
  }
  if (bought !== null) {
    const x = bought.route.venue === "uniswap-v3" ? (fills(bought, true) ? out(bought.at) : null) : valueOf(bought);
    if (x !== null) filled.push({ route: bought.route, amountOut: x });
  }
  return { block, out, fills, filled };
}

// Every quote evmPoolBuyQuote returned: the quoted builder (trade/evm/buy.ts) builds only from one of these
const QUOTED = new WeakSet<EvmPoolBuyQuote>();
/** True when `q` is a quote evmPoolBuyQuote returned, unchanged (it is frozen). */
export const evmIsDeviceQuote = (q: unknown): q is EvmPoolBuyQuote => typeof q === "object" && q !== null && QUOTED.has(q as EvmPoolBuyQuote);

// The device's own quote of an EVM sell (card evm-sell-device-quote). W sells only at a minOut from this quote, through
// a pool the device picked from its own reads: no server and no caller names the route, the pool, the hook data or
// minOut. The request has no route field, and one that carries a `route` is refused (bad_request).
//
// The candidates are the buy's own route set (routeSet, card evm-route-parity), each route backwards: the same standard
// pools, listed middles and launchpad pools, the same scan of the PoolManager's Initialize logs and the same markets of
// another currency, so whatever a buy enters through, its sell can leave through; and the route the note was bought
// through, when the caller names it. A v3 route's target is the chain's first listed router, a v4 route's the pinned
// PoolManager. Every hop's hook data is empty: the device makes it, never a route (a listed hook that read a trade
// referrer from it would let a server name itself).
// Each is read at the amount and twice it, in aggregate3 calls at the agreed block (agreedBlock, confirmed) on the
// chain's two pinned providers, whose answers must be equal (rpc_disagree). The pick is the largest output among those
// that fill, by the buy's own rule (the output grows with the input; a v3 route whose twice reverts does not fill), and
// that the sell builder takes; none is no_quote. It is held to a reference, the best of every route that fills, the
// sell builder's or not: a pick more than the slippage below it is refused (below_reference), so a seeded pool is
// never picked over the token's real market (review of evm-sell-device-quote, H1). Then, at the same block on both
// providers, the fee-on-transfer probe: W's code is replaced
// (eth_call's state override) by EVM_SELL_PROBE_CODE, which transfers the amount from W to the pool's own address (the
// PoolManager for v4, the v3 pool from the quoter's factory().getPool for v3) and returns what that address received,
// only where W's balance fell by the same; a probe that reverts, or answers another amount, is refused
// (fee_on_transfer). minOut = floor(Q x (10000 - slippageBps) / 10000). Only a quote made here builds a sell, within 30
// s of its block (trade/evm/sell.ts), and W signs only a sell built from one.

/** The user's own sell: the token W holds, the amount of it to sell, W, and their slippage. No route. `bought`
 *  (required): the route of the buy that paid W the token (its EvmPoolBuyQuote's route), one more candidate and
 *  reference where the sell builder takes it, never trusted. */
export type EvmPoolSellQuoteRequest = {
  chain: EvmPoolChain;
  token: string;
  w: string;
  amountIn: bigint;
  slippageBps: number;
  bought: EvmRoute;
  /** W's signature of a sim sell at the agreed block's timestamp (the kit's evmPoolSignSimSell with W's key), needed
   *  only where a route through a hook the venue does not list would set the reference (card evm-quote-exec-sim). */
  signSim?: (sim: EvmSellSim, blockTimestamp: bigint) => Uint8Array;
};

export type EvmPoolSellQuote = {
  readonly chain: EvmPoolChain;
  readonly token: string;
  readonly w: string;
  readonly amountIn: bigint;
  /** The pool the device picked, as the sell builder takes it, its hook data empty. */
  readonly route: EvmSellRoute;
  /** The chain's pinned router (v3) or PoolManager (v4). */
  readonly target: string;
  readonly block: { readonly number: bigint; readonly hash: string; readonly timestamp: bigint };
  /** Q: the route's output in wei of ETH or WETH, the same on both providers. */
  readonly amountOut: bigint;
  /** What W signs: floor(Q x (10000 - slippageBps) / 10000). */
  readonly minOut: bigint;
};

/** The fee-on-transfer probe, run as W's code (calldata token ‖ to ‖ amount, 32 bytes each): token.balanceOf(to) and
 *  balanceOf(W), token.transfer(to, amount) (a false or a short answer reverts; no answer is the USDT form), both
 *  balances again; it returns to's gain where it equals W's loss, and reverts otherwise. Assembled from:
 *    balanceOf(to)->0x80, balanceOf(this)->0xc0      PUSH4 70a08231 PUSH1 e0 SHL PUSH1 0 MSTORE, the account at 4,
 *                                                     STATICCALL(gas, token, 0, 0x24, dst, 0x20), fail unless ok and
 *                                                     RETURNDATASIZE >= 32
 *    transfer(to, amount)                            PUSH4 a9059cbb ..., CALL(gas, token, 0, 0, 0x44, 0x100, 0x20),
 *                                                     fail unless ok and (no answer, or 32 bytes and not 0)
 *    balanceOf(to)->0xa0, balanceOf(this)->0xe0
 *    mload(0xa0)-mload(0x80) == mload(0xc0)-mload(0xe0), else fail; return that 32-byte word
 *    fail: JUMPDEST PUSH1 0 DUP1 REVERT
 *  Read 2026-11-04 09:58Z on sepolia.base.org: as the code of Base Sepolia's PoolManager (holding 283,279.557374 USDC),
 *  1,000 units of USDC to 0x…dEaD answered 1,000, the whole balance answered it, one unit more reverted. */
export const EVM_SELL_PROBE_CODE =
  "0x6370a0823160e01b60005260203560045260206080602460006000355afa15610109573d602011610109576370a0823160e01b60005230600452602060c0602460006000355afa15610109573d6020116101095763a9059cbb60e01b60005260203560045260403560245260206101006044600060006000355af115610109573d15610097573d602011610109576101005115610109575b6370a0823160e01b600052602035600452602060a0602460006000355afa15610109573d602011610109576370a0823160e01b60005230600452602060e0602460006000355afa15610109573d6020116101095760805160a051038060e05160c0510314156101095760005260206000f35b600080fd";
const SEL_FACTORY = "c45a0155"; // QuoterV2.factory()
const SEL_GET_POOL = "1698ee82"; // UniswapV3Factory.getPool(address,address,uint24)

/** The device's sell quote on the chain's two pinned providers (see above); throws EvmQuoteError. Like
 *  evmPoolBuyQuote, it takes no provider from its caller; tests run evmPoolSellQuoteWith. */
export async function evmPoolSellQuote(req: EvmPoolSellQuoteRequest): Promise<EvmPoolSellQuote> {
  if (typeof req !== "object" || req === null) return refuse("bad_request", "the request is an object");
  const p = venue(req.chain).providers;
  if (p === undefined) return refuse("no_quoter", `${req.chain} has no pinned providers`);
  const s = venue(req.chain).scan;
  return evmPoolSellQuoteWith(req, evmProviders(p, fetch), Date.now(), s === undefined ? undefined : evmJsonRpc(s.url, fetch, 16 << 20));
}

/** evmPoolSellQuote on the providers `rpcs` with the device's clock at `nowMs`, and the scan provider `scan`. Not in
 *  the index. */
export async function evmPoolSellQuoteWith(req: EvmPoolSellQuoteRequest, rpcsIn: readonly [EvmRpc, EvmRpc], nowMs: number, scan?: EvmRpc, venues?: EvmPoolVenueList): Promise<EvmPoolSellQuote> {
  if (typeof req !== "object" || req === null) return refuse("bad_request", "a request is an object");
  if (Object.hasOwn(req, "route")) return refuse("bad_request", "a sell quote takes no route: the device picks the pool");
  const { chain, token, w, amountIn, slippageBps } = req;
  checkAsk(nowMs, rpcsIn, amountIn, slippageBps);
  const v = venue(chain, venues);
  if (!isAddress(token) || lower(token) === NATIVE || lower(token) === lower(v.weth)) return refuse("bad_request", "the token is not an address, or is WETH");
  // the probe replaces W's code: never an address the reads call, the token, nor a listed hook
  if (!isAddress(w) || lower(w) === NATIVE || lower(w) === lower(token) || v.called.has(lower(w)) || v.hookedPools.some((h) => lower(h.hooks) === lower(w))) {
    return refuse("bad_request", "W is not an address, or is one the quote calls");
  }
  const all = (venues ?? evmPoolVenues())[chain]!; // venue(chain, venues) above refuses a chain the list does not hold
  const router = all.routers.length > 0 ? lower(all.routers[0]!) : undefined;
  if ((v.v3 === undefined || router === undefined) && (v.v4 === undefined || v.poolManager === undefined)) return refuse("no_quoter", `${chain} has no pinned quoter with a sell target`);
  // the pool the note was bought in: the buy quote's own route, required, since a scan finds a pool only while its
  // Initialize log is within the scan's depth (review of edb4dbb, F3). Never trusted: read like a route the device made
  // from found pools (each hook not pinned replaced, the lower of that and its quote as it is), and one more candidate
  // and reference only where the sell builder takes it (F5)
  if (req.bought === undefined) return refuse("bad_request", "a sell quote takes `bought`, the route of the buy that paid W the token");
  const bought = copyRoute(req.bought);
  if (lower(evmPoolRouteDataQuoted(chain, bought).token) !== lower(token)) return refuse("token_mismatch", "the bought route buys another token");
  const rpcs = gated(rpcsIn, v.scan?.parallel ?? 2);
  const t = lower(token);

  const reads: Read[] = [];
  const factory = v.v3 !== undefined && router !== undefined ? reads.push({ to: v.v3, data: "0x" + SEL_FACTORY }) - 1 : -1;
  const exits = evmSellExits(chain, t, bought) ? bought : undefined;
  const { block, out, filled } = await routeSet({ chain, v, token: t, amountIn, nowMs, rpcs, scan, reads, bought: exits, seen: [], hints: undefined, sell: true });
  // a route through a hook the venue does not list, priced above the best route the sell builder takes, counts only
  // where W's own sell through it executes at that price (card evm-quote-exec-sim; review of edb4dbb, F4)
  const takes = best(filled.filter((r) => evmSellExits(chain, t, r.route)));
  const routes = await simmedSells(chain, v.sellDelegate, rpcs, block, lower(w), t, amountIn, filled, takes?.amountOut ?? 0n, req.signSim);
  // The pick: the best route the sell builder takes. The reference: the best of every route, the sell builder's or
  // not (a pool of a hook not listed, priced at the lower of its quote with the hook replaced and as it is). A pick
  // more than the slippage below the reference is refused, so a seeded pool is never picked over the token's real
  // market (review of evm-sell-device-quote, H1)
  const pick = best(routes.filter((r) => evmSellExits(chain, t, r.route)));
  const reference = bestOf(routes);
  if (pick === null) return refuse("no_quote", "no pool the sell can leave through fills it", reference);
  if (reference !== null && pick.amountOut * 10000n < reference.amountOut * BigInt(10000 - slippageBps)) {
    return refuse("below_reference", `the best pool the sell can leave through quotes ${pick.amountOut}, more than the slippage below ${reference.amountOut}`, reference);
  }
  const route = evmSellRouteOf(pick.route);

  // the probe's recipient: the pool's own address, where the sell delivers the token
  let to: string;
  if (route.venue === "uniswap-v4") to = v.poolManager!;
  else {
    const f = out(factory);
    if (f === null || f === 0n || f >= 1n << 160n) return refuse("no_quote", "the v3 quoter names no factory");
    const [pool] = await readBoth(rpcs, block.hash, [
      { to: "0x" + f.toString(16).padStart(40, "0"), data: "0x" + SEL_GET_POOL + word(BigInt(t)) + word(BigInt(route.tokens[1]!)) + word(BigInt(route.fees[0]!)) },
    ]);
    const p = pool!.kind === "out" ? pool!.amountOut : 0n;
    if (p === 0n || p >= 1n << 160n) return refuse("no_quote", "the v3 factory names no pool for the route's first hop");
    to = "0x" + p.toString(16).padStart(40, "0");
  }
  const [probe] = await readBoth(rpcs, block.hash, [{ to: lower(w), data: "0x" + word(BigInt(t)) + word(BigInt(to)) + word(amountIn), override: { [lower(w)]: { code: EVM_SELL_PROBE_CODE } } }]);
  if (probe!.kind !== "out" || probe!.amountOut !== amountIn) {
    return refuse("fee_on_transfer", `W's transfer of ${amountIn} of the token to ${to} ${probe!.kind === "out" ? `delivers ${probe!.amountOut}` : "reverts"}`);
  }

  // the slippage off the reference, never off a pick below it: the pick may already sit up to the slippage below the
  // reference, and W signs no more than that below the device's best price (review of edb4dbb, F6)
  const minOut = (reference!.amountOut * BigInt(10000 - slippageBps)) / 10000n;
  if (minOut === 0n) return refuse("no_quote", "the pool quotes too little to set a minimum above 0");
  const target = route.venue === "uniswap-v3" ? router! : v.poolManager!;
  const quote: EvmPoolSellQuote = Object.freeze({ chain, token: t, w: lower(w), amountIn, route, target, block: Object.freeze(block), amountOut: pick.amountOut, minOut });
  QUOTED_SELLS.add(quote);
  return quote;
}

// Every quote evmPoolSellQuote returned: the sell builder (trade/evm/sell.ts) builds only from one of these
const QUOTED_SELLS = new WeakSet<EvmPoolSellQuote>();
/** True when `q` is a quote evmPoolSellQuote returned, unchanged (it is frozen). */
export const evmIsDeviceSellQuote = (q: unknown): q is EvmPoolSellQuote => typeof q === "object" && q !== null && QUOTED_SELLS.has(q as EvmPoolSellQuote);

/** A provider's 429: ask asks again, a little later. */
class RateLimited extends Error {}
const limited = (a: unknown) => {
  const m = (a as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === "string" && /request limit|rate limit|too many requests/i.test(m);
};
/** Each JSON-RPC request's time limit (the NEAR client's RPC_TIMEOUT_MS and Solana's SOLANA_CALL_TIMEOUT_MS do the same). */
export const EVM_RPC_TIMEOUT_MS = 10_000;
/** A provider from a JSON-RPC URL: one POST per batch, answers matched to calls by id, at most `maxBytes` read. */
export function evmJsonRpc(url: string, fetchFn: typeof fetch = fetch, maxBytes = 1 << 20, timeoutMs = EVM_RPC_TIMEOUT_MS): EvmRpc {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return refuse("bad_request", "a provider URL is https");
  return async (calls) => {
    const body = JSON.stringify(calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params })));
    // a request that never returns is a refusal once its time runs out, never a quote (and a buy button) that hangs
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) throw new RateLimited("the provider answered 429 Too Many Requests");
    const text = await res.text();
    if (text.length > maxBytes) throw new Error("the answer is too long");
    const arr: unknown = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("the answer is not a batch");
    const byId = new Map<number, unknown>();
    for (const a of arr) {
      const id = (a as { id?: unknown } | null)?.id;
      if (typeof id === "number" && Number.isInteger(id) && id >= 0 && id < calls.length && !byId.has(id)) byId.set(id, a);
    }
    return calls.map((_, id) => byId.get(id) ?? null);
  };
}
