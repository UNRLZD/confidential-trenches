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
//   pool is one the device found; with no R it is refused (no_reference). Every found pool's state is read first (up
//   to EVM_QUOTE_MAX_KEYS, past which the quote refuses), and only pools that hold liquidity are quoted. No pool that
//   could beat the route is left unquoted: one is dropped only where all of the amount at its spot price, after its fee,
//   gives less than the route's Q ("The prune" in routeSet); every other is quoted, and past EVM_QUOTE_MAX_QUOTED such
//   routes or EVM_QUOTE_MAX_OTHER currencies the quote refuses (too_many_pools), never cuts. The residual risk is a
//   refusal: anyone can seed a token with more pools that could beat its route than a quote reads, and its buy is then
//   refused, never bought through a seeded pool. A
//   held pool that no route from the native asset reaches adds nothing. What is left: a pool of the token created
//   before the scan's depth (Base's 1M blocks: about 23 days of its 2 s blocks, 2.3 days of the 200 ms blocks it makes
//   since block 53556127, 2026-11-05 18:00:01Z, once they fill the depth on 2026-11-08 01:33Z; Robinhood's 10M blocks,
//   about 12 days), of a shape the device has not pinned, that
//   the helper leaves off its list while it routes the buy into a standard pool it seeded;
// - for a route with a hooked v4 hop, the same route with each hook's code replaced by a hook that does nothing
//   (eth_call's state override): the hookless output H. The hook's take H - Q is shown as a fee before the buy,
//   information only, never a pop-up (M360). The route's own Q, which the hook ran in, sets minOut; through a hook the
//   venue does not list, the route counts at the lowest of Q and its quotes with each set of such hooks replaced, and is
//   taken only where no route through listed pools is within the slippage of it; where its real buy fails, the caller
//   bans the pools the device's own evidence blames (`hooked`, evmBuyRevertedPools, then `banned`), and a route through
//   listed pools within the slippage of a reference through such a hook is taken at its own minOut (card
//   evm-buy-hook-converge, the sale's take-and-ban);
// - on a chain whose WETH is behind an upgradeable proxy (nativeFirst, Robinhood's aeWETH), the native v4 pools of the
//   route's first hop: a route that starts from WETH is refused when one exists (native_first), naming the best
//   native route, unless it quotes strictly more than every native route (native when at least as good); R stays
//   the best of every pool, so a seeded native pool is held to the token's WETH pools too.
//
// minOut = floor(V x (10000 - slippageBps) / 10000), V what the route counts for, with V >= R or R through such a
// hook. Only a quote made here builds a buy, within 30 s of
// its block (trade/evm/buy.ts), and W signs only a buy built from one.
import {
  copyRoute,
  evmPoolProvidersOf,
  evmPoolRouteDataQuoted,
  evmPoolVenues,
  pathKeysAbi,
  type EvmPoolChain,
  type EvmPoolVenue,
  type EvmPoolVenueList,
  type EvmRoute,
  type EvmV3Route,
  type EvmV4Hop,
  type EvmV4Route,
} from "../../trade/evm/buy-unpinned.ts";
import { EVM_POOL_MIN_DEPOSIT, EVM_POOL_TX_BYTES, evmPoolChainFee, evmPoolChainFeeReads } from "../../trade/evm/pool-fee.ts";
import { EVM_7702_AUTH_GAS, EVM_POOL_SELL_GAS, EVM_SELL_SIM, evmHookListed, evmPoolBuildSimSellUnpinned, evmPoolSellFeeMax, evmPoolSellTip, evmSellCallData, evmSellRouteCheck, evmSellRouteOf as evmSignedSellRouteOf, type EvmSellRoute, type EvmSellSim, type EvmV4SellRoute } from "../../trade/evm/sell-unpinned.ts";
import { evmSellReleasesAt, evmSellSentOf, type EvmReleaseLog, type EvmSellReleases, type EvmSellSent } from "../../trade/evm/sell-releases.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** One JSON-RPC call. */
export type EvmRpcCall = { readonly method: string; readonly params: readonly unknown[] };
/** One RPC provider: answers a batch with one JSON-RPC answer object ({ result } or { error }) per call, in order;
 *  throws when it cannot be reached. evmJsonRpc makes one from a URL. `signal`, when given, ends the request early
 *  (the scan's bound). */
export type EvmRpc = (calls: readonly EvmRpcCall[], signal?: AbortSignal) => Promise<readonly unknown[]>;

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
  /** (optional) The v4 pools this device banned for this token on this chain, shared with the sale (card
   *  evm-buy-hook-converge; wallet pool/evm-sell-bans.ts): each a PoolId, 0x and 64 hex digits, that
   *  evmBuyRevertedPools or evmSellRevertedPools proved at fault for a reverted trade. A route through any of them is no
   *  route: the quote's own refuses below_reference, and no other is a reference. */
  banned?: readonly string[];
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
  /** Q: the route's output, the same on both providers; through a hook the venue does not list, the lowest of Q and
   *  the route's quotes with each set of such hooks replaced, every one of which must answer above 0 or the quote is
   *  refused no_quote (card evm-buy-hook-converge; review of 72e28658, M1; review of a2d82dc6, F2). */
  readonly amountOut: bigint;
  /** What W signs: floor(amountOut x (10000 - slippageBps) / 10000), always off the route's own amountOut, never off a
   *  reference (review of 72e28658, M2). */
  readonly minOut: bigint;
  /** R: the best of every pool the device found for the token (see the header), or null when none answers. */
  readonly reference: { readonly amountOut: bigint; readonly route: EvmRoute } | null;
  /** null when the route has no hooked hop. */
  readonly hook: EvmHookTake | null;
  /** The PoolId (0x and 64 hex digits) of each pool of the route behind a hook the venue does not list, in hop order;
   *  empty for a route with none (card evm-buy-hook-converge). Where the real buy reverts, the caller asks
   *  evmBuyRevertedPools which of these the revert proves at fault, bans those (`banned` on the next quote), and the
   *  buy goes on through the rest. */
  readonly hooked: readonly string[];
};

export type EvmQuoteErrorCode =
  | "bad_request" // the amount, the slippage, the token or the providers
  | "token_mismatch" // the route buys another token than the user picked
  | "no_quoter" // the chain has no pinned quoter for the route's venue
  | "rpc_error" // a provider did not answer, or answered something that is not an answer
  | "rpc_disagree" // the two providers gave different answers at the same block
  | "no_quote" // the route reverts, or quotes nothing
  | "partial_fill" // the route runs out of a pool's liquidity
  | "below_reference" // the route is quoted below the device's own standard pool, goes through a pool the device banned, or goes through a hook the venue does not list where a route through listed pools is within the slippage of it
  | "native_first" // the route starts from WETH where a native route quotes at least as much
  | "no_reference" // no standard or pinned launchpad pool answers: nothing the device chose holds the route
  | "stale_quote" // the block is more than 30 s behind the device's clock
  | "too_many_pools" // the token has more pools than a quote reads: past the bound its real one may be unread
  | "fee_on_transfer" // a sell's token does not deliver the whole amount from W to the pool, or its transfer reverts
  | "not_landed" // a provider's head is still below the block a sell's buy landed in, past EVM_MIN_BLOCK_WAIT_MS
  | "below_minimum" // a sell's minOut less the fee rule's cap is under the pool's MIN_DEPOSIT: its deposit back would revert
  | "no_exit" // a buy's route goes through a pool its sell could not leave through
  | "out_of_gas" // a route of more than one v3 hop that may beat the quote runs out of a read's gas alone at twice the amount (card evm-quote-read-gas-starve)
  | "over_gas_floor"; // a buy's route needs more gas than the pool guarantees its swap, with the margin (card evm-buy-gas-floor); `reference` names the best route that fits, or none fits
export class EvmQuoteError extends Error {
  readonly code: EvmQuoteErrorCode;
  /** On below_reference, native_first and over_gas_floor: the device's own best route, which the caller may quote
   *  instead (null on over_gas_floor where no route fits). */
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
/** The evidence's hook that does nothing (step 4 of evmSellRevertedPools, its second pass; review of 1ee73a00, 1):
 *  EVM_NOOP_HOOK_CODE but its beforeSwap's third word is 0x400000, v4-core's OVERRIDE_FEE_FLAG with fee 0, so a
 *  dynamic-fee pool behind a hook with the beforeSwap permission swaps at LP fee 0 and never at the stored fee, which
 *  only the hook itself can set (PoolManager.updateDynamicLPFee; Pool.swap takes the override where its flag is set, else
 *  the stored fee; Hooks.beforeSwap calls a hook only where its address carries BEFORE_SWAP_FLAG, and reads the word
 *  only on a pool whose fee is dynamic; v4-core bea7f6d1). A hook without that permission is never called for it, so
 *  its pool keeps the stored fee. The quote path keeps EVM_NOOP_HOOK_CODE: keep-min's hookless read must price the
 *  stored fee the pool really charges. Not in the kit's index.
 *    ... as EVM_NOOP_HOOK_CODE up to JUMPDEST
 *    JUMPDEST PUSH3 0x400000 PUSH1 0x40 MSTORE PUSH1 0x60 PUSH1 0 RETURN    96 bytes, the fee word the flag */
export const EVM_EVIDENCE_NOOP_HOOK_CODE = "0x6004600060003760003560e01c63575e24b414601b5760406000f35b6240000060405260606000f3";

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
  const pin = (k: "poolManager" | "pool" | "sellDelegate" | "sellSender") => (Object.hasOwn(v, k) ? v[k] : undefined);
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
    // the venue's reads per call and request bytes; a venue with none sends 6 a call in requests of 24,000 bytes at most
    reads: readLimits(Object.hasOwn(v, "reads") ? v.reads : undefined),
    traceProviders: Object.hasOwn(v, "traceProviders") ? v.traceProviders : undefined,
    maxLag: Object.hasOwn(v, "maxLag") && Number.isSafeInteger(v.maxLag) ? BigInt(v.maxLag!) : 0n,
    hookedPools: Object.hasOwn(v, "hookedPools") ? v.hookedPools! : [],
    poolManager: Object.hasOwn(v, "poolManager") && isAddress(v.poolManager) ? lower(v.poolManager) : undefined,
    sellDelegate: isAddress(pin("sellDelegate")) ? lower(pin("sellDelegate") as string) : undefined,
    sellSender: isAddress(pin("sellSender")) ? lower(pin("sellSender") as string) : undefined,
    // the pool every buy goes to and its v4 adapter: a buy's evidence for a ban reads its sale as one to them (card
    // evm-buy-hook-converge)
    pool: isAddress(pin("pool")) ? lower(pin("pool") as string) : undefined,
    adapterV4: isAddress(adapters[1]) ? lower(adapters[1]) : undefined,
    // and its v3 adapter: a buy's swap is run through the route's own adapter to read its gas (card evm-buy-gas-floor)
    adapterV3: isAddress(adapters[0]) ? lower(adapters[0]) : undefined,
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

// The buy's swap gas (audit I-4, card evm-buy-gas-floor). PrivacyPoolSimple.buy gives its swap, one call to its own
// buySwap, at least BUY_SWAP_GAS and no more is promised (PrivacyPoolSimple.sol, buy; BUY_SWAP_GAS() reads 500000 on the
// Base and Robinhood pools at 06:56Z): a route whose swap needs more fails the buy, the fee kept. So the quote runs that
// exact call, the pool's own buySwap sent from the pool with the route's adapter data, minOut 1 and the amount, to a
// fresh recipient (its first token balance is the dearest write), with the pool's balance set to the amount, and its
// execution capped at EVM_BUY_SWAP_FIT: BUY_SWAP_GAS / 1.05. The margin is for what moves between the quote's block and
// the buy's: a tick or two more crossed (a v4 crossing writes two fee-growth slots and reads the tick, under 20,000).
// Not the helper's 1.2 (pool-fee.ts), which covers a whole transaction's estimate: run at 07:07Z on the recorded cases,
// the standard routes' swaps took 115,591 to 318,445 and the pinned Clanker launchpad's 457,080, which 1.2 (416,666)
// would refuse every Clanker buy for. A capped call is a yes or no both providers must agree on at the agreed block, where an estimate differs by node; it
// counts the adapter, the token's own transfer logic and the write to W that a quoter's gas figure leaves out. A route
// whose call reverts or runs out of gas does not fit
const SEL_BUY_SWAP = "25faf2a3"; // buySwap((address,bytes,uint256,address),address,uint256)
export const EVM_BUY_SWAP_GAS = 500_000n;
// BUY_SWAP_GAS / 1.05, rounded down (GF5 holds the sum); literals, so a bundle that never quotes a buy drops them
export const EVM_BUY_SWAP_FIT = 476_190n;
const FIT_TEXT = "476190 gas (the pool guarantees 500000, less a 5% margin)";
// The read's recipient: keccak256("blindfill.buy.gas.v1" || the agreed block's hash)[12:], an address no one holds a key
// to and no one can send a token before that block, so its first balance write is the fresh W's (a recipient fixed in
// advance takes dust, which makes that write 2,900 gas, not 20,000; review of 498eae83, L2), the same on both providers
// (the tag made in the call, not at the module's load, so a bundle that never quotes a buy drops it)
const fitTo = (blockHash: string) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash)) return refuse("bad_request", "the block hash is 32 bytes of hex");
  const tag = new TextEncoder().encode("blindfill.buy.gas.v1");
  const b = new Uint8Array(tag.length + 32);
  b.set(tag);
  for (let k = 0; k < 32; k++) b[tag.length + k] = parseInt(blockHash.slice(2 + 2 * k, 4 + 2 * k), 16);
  return hex(keccak_256(b)).slice(24);
};

/** The pool's own buySwap of `route` at `amount` at the block `blockHash`, capped at EVM_BUY_SWAP_FIT, or null where the
 *  venue pins no adapter for the route's venue (no buy goes through it). */
function fitRead(chain: EvmPoolChain, v: { pool: string | undefined; adapterV3: string | undefined; adapterV4: string | undefined }, route: EvmRoute, amount: bigint, blockHash: string, exec = EVM_BUY_SWAP_FIT): Read | null {
  if (v.pool === undefined) return refuse("bad_request", `${chain} pins no pool`);
  const adapter = route.venue === "uniswap-v3" ? v.adapterV3 : v.adapterV4;
  if (adapter === undefined) return null;
  const { data, token } = evmPoolRouteDataQuoted(chain, route);
  const padded = hex(data).padEnd(Math.ceil(data.length / 32) * 64, "0");
  const call = "0x" + SEL_BUY_SWAP + word(0x60n) + word(BigInt("0x" + fitTo(blockHash))) + word(amount) + word(BigInt(adapter)) + word(0x80n) + word(1n) + word(BigInt(token)) + word(BigInt(data.length)) + padded;
  // the transaction's own cost before execution: 21,000 and each calldata byte's (16 a non-zero byte, 4 a zero one)
  let intrinsic = 21_000n;
  for (let k = 2; k < call.length; k += 2) intrinsic += call.slice(k, k + 2) === "00" ? 4n : 16n;
  return { to: v.pool, data: call, override: { [v.pool]: { balance: "0x" + amount.toString(16) } }, tx: { from: v.pool, gas: "0x" + (intrinsic + exec).toString(16) }, oog: true };
}

/** The eth_call the EVM buy quote sends to learn whether `route`'s swap at `amount` fits the pool's swap gas, at the
 *  block `blockHash` (card evm-buy-gas-floor): the pool's own buySwap, from the pool, its execution capped at `exec`
 *  (EVM_BUY_SWAP_FIT unless given), and its one state override, the pool's balance at the amount; null where `chain`
 *  pins no adapter for the route's venue, and refused (bad_request) where it pins no pool. A result is a fit; a revert
 *  or out of gas is none. */
export function evmBuySwapFitCall(chain: EvmPoolChain, route: EvmRoute, amount: bigint, blockHash: string, exec: bigint = EVM_BUY_SWAP_FIT): { tx: { from: string; to: string; data: string; gas: string }; override: Record<string, { balance: string }> } | null {
  // the buy quote's own bound on the amount (checkAsk), and a cap above 0 (review 2 of c9a8df14, L2)
  if (typeof amount !== "bigint" || amount <= 0n || amount >= MAX_IN) return refuse("bad_request", "the amount in is above 0 and below 2^127");
  if (typeof exec !== "bigint" || exec <= 0n) return refuse("bad_request", "the swap's gas cap is above 0");
  const r = fitRead(chain, venue(chain), copyRoute(route), amount, blockHash, exec);
  if (r === null) return null;
  return { tx: { from: r.tx!.from, to: r.to, data: r.data, gas: r.tx!.gas }, override: r.override as Record<string, { balance: string }> };
}

// `group`: the one hook a read's override replaces; reads of the same group share that override in aggregate3 calls,
// and no read shares an override with a read of another hook
// `state`: a PoolManager.extsload read, one storage word, sent STATE_READS_PER_CALL to a call
// `tx`: the transaction fields of a read sent alone (one with an override and no group), as the sim of a sale sends them
// `oog`: an out-of-gas error answers as a revert (a read capped at a gas, card evm-buy-gas-floor), not a refusal
type Read = { to: string; data: string; override?: Record<string, Override> | undefined; env?: Record<string, string>; group?: string; state?: true; tx?: SimTx; oog?: true };
// a call's sender and gas, with the sale's fees (a sim) or none (tx.gasprice 0: a gas check)
type SimTx = { from: string; gas: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
// `overflow`: the revert is SafeCastOverflow (card rh-cold-quote, the X prune)
// `gas`: the read failed having used half its gas or more, or was not run for want of it (EVM_READ_GAS_CODE), even when
// read alone: it is no evidence of a revert, never a partial fill or an overflow, and prices nothing
type Answer = { kind: "out"; amountOut: bigint } | { kind: "revert"; partial: boolean; overflow?: true; gas?: true };
// V4Quoter's revert when a hookless hop runs out of liquidity: NotEnoughLiquidity(bytes32 poolId), wrapped in
// UnexpectedRevertBytes(bytes) (read 2026-11-03 on Base: 1e20 wei into the ETH pool of 0xf6e5…dfe5, 0.3%)
const NOT_ENOUGH_LIQUIDITY = "7a5ed734";
const UNEXPECTED_REVERT_BYTES = "6190b2b0";
const ranOut = (d: string) =>
  d.startsWith(NOT_ENOUGH_LIQUIDITY) || (d.startsWith(UNEXPECTED_REVERT_BYTES) && d.slice(8 + 128, 8 + 128 + 8) === NOT_ENOUGH_LIQUIDITY);
// v4-core's SafeCastOverflow(), wrapped as above: in an exact-output swap through a pool with no hook (or the hook that
// does nothing) it is Pool.swap's toInt128 of the input the output needs, more than 2^127 of it (v4-core
// src/libraries/Pool.sol, the swap's casts; read 2026-11-06), which no hop of a v4 route is ever given; 49 of TORCH's
// 100 pools with other currencies on Robinhood answered it for Q (2026-11-06 01:5xZ)
const SAFE_CAST_OVERFLOW = "93dafdf1";
const overflowed = (d: string) =>
  d.startsWith(SAFE_CAST_OVERFLOW) || (d.startsWith(UNEXPECTED_REVERT_BYTES) && d.slice(8 + 128, 8 + 128 + 8) === SAFE_CAST_OVERFLOW);

// The out-of-gas words of an eth_call, read 2026-11-08: reth's RpcInvalidTransactionError (paradigmxyz/reth at 46731e93,
// crates/rpc/rpc-eth-types/src/error/mod.rs): BasicOutOfGas "out of gas: gas required exceeds: {0}" (:717),
// MemoryOutOfGas "out of gas: gas exhausted during memory expansion: {0}" (:721), PrecompileOutOfGas "out of gas: gas
// exhausted during precompiled contract execution: {0}" (:728), InvalidOperandOutOfGas "out of gas: invalid operand to
// an opcode: {0}" (:732); geth's ErrOutOfGas "out of gas" (go-ethereum master, core/vm/errors.go:27)
const OUT_OF_GAS_WORDS = /^out of gas(: (gas required exceeds:?|gas exhausted during memory expansion:|gas exhausted during precompiled contract execution:|invalid operand to an opcode:) \d+)?$/i;
/** True when an eth_call's error message is one of the out-of-gas words above (geth's and reth's), which the buy quote
 *  reads as a swap that does not fit; a function, not the pattern, so the kit's frozen exports hold nothing rewritable */
export const evmIsOutOfGas = (message: string): boolean => typeof message === "string" && OUT_OF_GAS_WORDS.test(message);

/** One provider's answer to one eth_call: the quote's first word, a revert, or a refusal (`raw`: the whole result). */
function answerOf(a: unknown, who: string, raw = false, oog = false): Answer | string {
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
    // an eth_call whose own frame runs out of the gas it was given: geth's "out of gas" (-32000; Robinhood's two at
    // 07:02Z), and reth's four (-32003; Base's two answered the first at 07:02Z): OUT_OF_GAS_WORDS
    if (oog && typeof message === "string" && OUT_OF_GAS_WORDS.test(message)) return { kind: "revert", partial: false };
    return refuse("rpc_error", `${who} answered error ${String(code).slice(0, 12)}: ${String(message).slice(0, 120)}`);
  }
  return refuse("rpc_error", `${who} answered no result and no error`);
}

// Multicall3 (github.com/mds1/multicall3), the same address on every chain; eth_getCode on all four providers
// (mainnet.base.org, base-rpc.publicnode.com, rpc.mainnet.chain.robinhood.com, robinhood.drpc.org, 2026-11-03 18:00Z):
// 3,808 bytes, keccak 0xd5c15df6…e770891 on each. The reads but the hookless one go in aggregate3 calls (see
// readBoth below).
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const SEL_AGGREGATE3 = "82ad56cb"; // aggregate3((address,bool,bytes)[])
const SEL_ETH_BALANCE = "4d2301cc"; // getEthBalance(address)

// Each read's own gas (card evm-quote-read-gas-starve). Multicall3's aggregate3 gives each read all the gas the call has
// left (less 1/64), so one heavy read, which a pool built to burn gas makes, starves the reads after it: they fail as if
// they reverted, and a revert prices its route at nothing (Card 0's money review, finding 5; publicnode and Pocket,
// 50M caps, answered a starved read with data where blastapi, 550M, answered it empty, Base block 54,819,255). So
// every aggregate3 call runs this code at Multicall3's address (eth_call's state override), with the call's gas set to
// EVM_READ_CALL_GAS, under every pinned provider's cap: aggregate3's calldata and answer as Multicall3 has them, each
// read run with its own gas, L = (gas left - r x S/4 - 130,000) x 63/64 where S = (gas at the start - 100,000) / n
// and r the reads after it: all the call's gas but a quarter share kept for each read after it, so a read is given about
// S/4 at least whatever the reads before it took (1.66M at 6 a call: 1,660,745 for the last of six behind five loops,
// measured on anvil, review of baac0ecb; about 156,000 at 64), and as much as the call has where they took little
// (a hookless route's reads at 100 ETH on Base take 4.1M to 9.0M gas, more than half the even share of 6 a call,
// 6.6M, so the even share answered 20 of their 90 reads 2 and they were read again alone on every quote: the warm
// p95 went from 683 ms to 1,440 ms, live check evm-quote-warm-round, run 42521476520; 2026-11-08 21:2xZ), and its
// success word:
//   1  the read returned;
//   0  it reverted having used less than L/2;
//   2  it failed having used L/2 or more: a read that may have run out of gas (the code also answers 2, the read not
//      run, where less than T + 100 or L + L/63 + 10,000 gas is left; the reserve keeps both out of reach below about
//      740 reads a call, review of baac0ecb). An out-of-gas frame inside the read, given all but 1/64 of its caller's gas as the quoters and the PoolManager give it, leaves the
//      read d/64 of L at most at depth d, so it uses L/2 or more down to a depth of 44 (measured on the nine
//      pinned providers, review of fe9f5ec3);
// and its return data cut to 96 bytes (a quote's first word, and NotEnoughLiquidity or SafeCastOverflow inside
// UnexpectedRevertBytes, the 72 bytes ranOut and overflowed read), so no read's answer grows another's memory cost.
// After the answer it writes READ_MARKER, a word Multicall3 never answers after its last result, and the device takes
// no answer without it (unaggregate): a provider that stopped applying code overrides is refused by name, never read
// as Multicall3's shared gas (review of fe9f5ec3, finding 3). Multicall3.getEthBalance(address) answers as
// Multicall3's (BALANCE), any other selector reverts. A read answered 2 in a call of more than READ_AGAIN_PER_CALL is
// read again in calls of that many (each given 1.66M at least), and one still 2 in a call of several alone, at the same block
// (readBoth); one answered 2 alone prices nothing (`gas`). Assembled (two-pass, labels as PUSH2) from:
//   dispatch    selector 4d2301cc: mstore(0, balance(calldataload(4))), return 32; 82ad56cb: aggregate; else revert
//   aggregate   m[0] = n (1 to 1,024, else revert); revert unless gas >= 100,000 and S = (gas - 100,000) / n >= 30,000;
//               m[0xa0] = S/4; the answer at 0x100: 0x20, n, n offsets (32n + 192i), n elements of 192 bytes each
//               (success, 0x40, length, three words); m[0x80] = the read's calldata at 0x140 + 224n
//   each read   calldatacopy its data to m[0x80]; r = n - i - 1, T = r S/4 + 140,000; if gas < T + 100: success 2,
//               length 0; else m[0x20] = L = (gas - T + 10,000) x 63/64; if gas < L + L/63 + 10,000: success 2,
//               length 0; else
//               g = gas, ok = call(L, target, 0, data), used = g - gas; success = ok ? 1 : used >= L/2 ? 2 : 0;
//               length = min(returndatasize, 96), returndatacopy(element + 96, 0, length)
//   end         mstore(0x140 + 224n, READ_MARKER), return(0x100, 96 + 224n)
// Run (eth_call with code overrides, read only; scripts/live-checks/evm-quote-read-gas-starve.mjs) on every pinned
// mainnet quote provider: base-rpc.publicnode.com, base-mainnet.public.blastapi.io, mainnet.base.org,
// base.api.pocket.network, robinhood-rpc.publicnode.com, robinhood.drpc.org, rpc.mainnet.chain.robinhood.com,
// robinhood.rpc.blxrbdn.com and rpc-robinhood.globalstake.io, the same answers on all nine at 40,000,000 gas: [returns 7, loops forever, returns 7, reverts 0xaa, calls the loop with all its gas then reverts 0xee,
// returns 7] answered [1 7, 2 empty, 1 7, 0 0xaa, 2 0xee, 1 7] (through Multicall3 itself the loop and the 0xee read
// answered 0); 64 reads, the loop first, answered 2 then 63 of 1; six reads, the first a revert after 14M gas, answered
// [0 0xbb, then five of 1 7] (the even share and half a share kept answer the first 2); the loop then five reads of 1.5M
// answered [2, then five of 1 7] (a code keeping nothing for later reads answers six 2s; 2026-11-08 22:28Z, review of
// baac0ecb); each answer ending in READ_MARKER; before the
// marker (2026-11-08 16:4xZ) the loop alone answered 2, getEthBalance(0x…dEaD) as Multicall3's, selector 12345678
// reverted.
export const EVM_READ_GAS_CODE =
  "0x60003560e01c80634d2301cc1461001f576382ad56cb1461002d576101ca565b506004353160005260206000f35b602435600052600051156101ca57610400600051116101ca57620186a05a106101ca57600051620186a05a030480617530116101ca5760021c60a0526020610100526000516101205260005160e0026101400160805260006040525b60005160405110156101905760405160c00260005160051b0160405160051b610140015260405160c00260005160051b016101400160405160051b604401356044018060400135810180358082602001608051376001604051600051030360a05102620222e001806064015a10610161575a0361271001603f0260061c60205260205180603f900401612710015a10610163575a606052600060008260805160008735602051f15a606051039061014a5760205160011c111560011b61014e565b5060015b3d8060611161015b575060605b90610168565b505b600060025b8552604085602001528085604001526000856060013e50505050604051600101604052610089565b7fd5d2d81c98f7eef530d209f98d24b60e8438438a742f7e3b44efbbe020fed2a060005160e002610140015260005160e002606001610100f35b600080fd";
/** keccak256("blindfill.read.gas.v1"): the word EVM_READ_GAS_CODE writes after its answer */
const READ_MARKER = "d5d2d81c98f7eef530d209f98d24b60e8438438a742f7e3b44efbbe020fed2a0";
// a call's reads answered 2 are read again this many to a call first, then alone (review of fe9f5ec3, finding 2: at
// Robinhood's 64 a call, L about 583,000, every TORCH quote read 51 real heavy reverts again alone on each provider)
const READ_AGAIN_PER_CALL = 6;
// A plain read (no override) that answered 2 in a call and was answered at fewer a call, kept with that many, at most
// READ_SIZES_KEPT of them, oldest out first: the next quote sends it in calls of that many at once, so a warm quote does
// not pay the re-read's round trips again (review of fe9f5ec3, finding 2: rh-cold-quote's warm median went from 1.34 s to
// 2.17 s). A read whose 2 came behind an earlier read of its call that also answered 2 is not kept, unless it answers 2
// alone too (review of baac0ecb, P2-2): a pool built to burn gas leaves the reads after it in its call S/4 each, and kept
// alone they made every warm quote send them alone (16 to 33 eth_calls); the burner's reads are kept alone, so the next
// quote's call holds the others without them.
// The cost left is one more round in the cold quote for each such call. It sends a read in fewer a call, where its first
// answer can be another (a read kept at 6 may be the last of its call, at 1.66M), never its final one
const readSizes = new Map<string, number>();
const READ_SIZES_KEPT = 4_096;
const sizeKey = (r: Read) => lower(r.to) + r.data;
/** The reads a call a plain read to `to` with calldata `data` is kept at (readSizes), or undefined: for the tests that pin
 *  what the next quote sends it in (review of baac0ecb, P3-2; not in the index). */
export const evmReadSizeKept = (to: string, data: string): number | undefined => readSizes.get(lower(to) + data);
/** The gas every aggregate3 call is sent with: under the 50,000,000 cap of base-rpc.publicnode.com and the Pocket
 *  gateways (geth and reth cut a call's gas to their cap without an error, review of 2c02f7df). */
export const EVM_READ_CALL_GAS = 40_000_000n;
const READ_CALL_GAS_HEX = "0x" + EVM_READ_CALL_GAS.toString(16);

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
  // the per-read gas code's marker, its last word, after every result (Multicall3's own answer ends in its last one)
  if (len < 96 || r.slice(2 + 2 * (len - 32)).toLowerCase() !== READ_MARKER) return refuse("rpc_error", `${who} answered the multicall without the per-read gas code's marker: it did not run the code override`);
  const out: Answer[] = [];
  for (let i = 0; i < n; i++) {
    const e = 64 + at(64 + 32 * i);
    const ok = at(e);
    if ((ok !== 0 && ok !== 1 && ok !== 2) || at(e + 32) !== 0x40) return refuse("rpc_error", `${who} answered a malformed multicall result`);
    const dl = at(e + 64);
    if (e + 96 + dl > len - 32) return refuse("rpc_error", `${who} answered a multicall result outside it`);
    // a read that may have run out of its gas (EVM_READ_GAS_CODE): no revert, whatever its data
    if (ok === 2) out.push({ kind: "revert", partial: false, gas: true });
    else if (ok === 0) {
      const d = r.slice(2 + 2 * (e + 96), 2 + 2 * (e + 96 + dl)).toLowerCase();
      out.push({ kind: "revert", partial: ranOut(d), ...(overflowed(d) ? { overflow: true as const } : {}) });
    }
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

// Calls per JSON-RPC batch: robinhood.drpc.org's free plan takes a batch of 3 calls at most. The reads per aggregate3
// call and the most bytes a request may hold are each chain's (its venue's `reads`, trade/evm/buy-unpinned.ts, where
// each value's reads are): base-rpc.publicnode.com caps an eth_call at 50,000,000 gas, which one call of 90 quotes of
// 100 ETH passed (read 2026-11-03 19:00Z) but 64 of a 100 ETH buy's heavier reads did not (review of 2c02f7df).
type ReadLimits = { perCall: number; maxBytes: number };
const READS_DEFAULT: ReadLimits = { perCall: 6, maxBytes: 24_000 };
function readLimits(r: unknown): ReadLimits {
  if (r === undefined) return READS_DEFAULT;
  // own fields only, as every venue field is read (a polluted Object.prototype names no limit)
  const own = (k: "perCall" | "maxBytes") => (typeof r === "object" && r !== null && Object.hasOwn(r, k) ? (r as Record<string, unknown>)[k] : undefined);
  const perCall = own("perCall");
  const maxBytes = own("maxBytes");
  if (!Number.isSafeInteger(perCall) || (perCall as number) < 1 || !Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1_000) return refuse("bad_request", "a venue's reads are a whole perCall and maxBytes");
  return { perCall: perCall as number, maxBytes: maxBytes as number };
}
// a test's reads per call in place of every venue's (the tests whose recordings were made at 6), or undefined
let readsOverride: number | undefined;
/** Sets the reads per aggregate3 call on every chain, or with no argument gives each chain its venue's back: for the
 *  tests that count a round's batches or replay recordings made at 6 (not in the index). */
export const evmReadsPerCall = (n?: number): void => void (readsOverride = n);
const CALLS_PER_BATCH = 3;
/** A call's bytes in a request body as evmJsonRpc writes it (its id at most 2 digits and a comma), and a batch's own
 *  brackets: a batch's body is BATCH_BYTES plus its calls'. */
const bytesOf = (c: EvmRpcCall): number => JSON.stringify({ jsonrpc: "2.0", id: 99, method: c.method, params: c.params }).length + 1;
const BATCH_BYTES = 2;
// an extsload read costs one storage read (2,100 gas cold, EIP-2929): 64 of them are far inside any provider's cap
const STATE_READS_PER_CALL = 64;
// A round with more PoolManager state reads than two such calls sends them as PoolManager.extsload(bytes32[]) calls of
// 2,000 slots each, an answer inside MAX_ANSWER_HEX (v4-core Extsload; selector dbd035ff, 2,048 slots answered on
// base-rpc.publicnode.com, mainnet.base.org, robinhood.drpc.org and rpc.mainnet.chain.robinhood.com, 2026-11-03
// 22:22Z; about 4.2M gas a call):
// USDG on Robinhood has 9,942 pools in the scan's depth, and every one's state is read before any bound applies. A
// provider answers smaller calls sent at once sooner (card evm-quote-warm-round: 6,000 slots as 1 batch of 3 calls of
// 2,000, or 4 batches of 3 of 500 at once, p50 of 6 rounds on Base 2026-11-04 17:2xZ: base-mainnet.public.blastapi.io
// 1,900 and 610 ms, mainnet.base.org 848 and 523 ms, base.public.blockpi.network 1,050 and 725 ms), so 500 a call
const SEL_EXTSLOADS = "dbd035ff";
const SLOTS_FROM = 2 * STATE_READS_PER_CALL;
const SLOTS_PER_CALL = 500;

/** Both providers' answers to `reads` at `hash`, which must be the same: the reads without a state override in
 *  aggregate3 calls of the venue's perCall, the grouped reads of each hook in their own aggregate3 calls with that hook's
 *  override alone, any other read with one in its own call, sent in batches of CALLS_PER_BATCH at once; each call and
 *  each batch kept to the venue's maxBytes (a call holding one read past it is sent alone). */
async function readBoth(rpcs: readonly EvmRpc[], hash: string, reads: readonly Read[], lim: ReadLimits, again?: number): Promise<Answer[]> {
  // `again`: reads answered `gas` in a call of more, read again this many to a call (READ_AGAIN_PER_CALL, then 1)
  const perCall = again ?? readsOverride ?? lim.perCall;
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
  // every aggregate3 call runs EVM_READ_GAS_CODE with EVM_READ_CALL_GAS, beside the hook's override where it has one
  const callOf = (part: number[]): EvmRpcCall => {
    const o = reads[part[0]!]!.override;
    return { method: "eth_call", params: [{ to: MULTICALL3, data: aggregate(part.map((i) => reads[i]!)), gas: READ_CALL_GAS_HEX }, at, { ...o, [MULTICALL3]: { code: EVM_READ_GAS_CODE } }] };
  };
  // a part whose call is past maxBytes is sent as its halves, down to one read
  const parts: number[][] = [];
  const fit = (part: number[]): void => {
    if (part.length > 1 && bytesOf(callOf(part)) > lim.maxBytes) {
      const mid = Math.ceil(part.length / 2);
      fit(part.slice(0, mid));
      fit(part.slice(mid));
    } else parts.push(part);
  };
  // a plain read kept with fewer a call goes in calls of that many (readSizes), in the first pass only
  const bySize = new Map<number, number[]>();
  for (const i of plain) append(bySize, again === undefined ? Math.min(readSizes.get(sizeKey(reads[i]!)) ?? perCall, perCall) : perCall, i);
  for (const [n, g] of bySize) for (let k = 0; k < g.length; k += n) fit(g.slice(k, k + n));
  const statePer = Math.min(again ?? STATE_READS_PER_CALL, STATE_READS_PER_CALL);
  for (let k = 0; k < state.length; k += statePer) fit(state.slice(k, k + statePer));
  for (const g of groups.values()) for (let k = 0; k < g.length; k += perCall) fit(g.slice(k, k + perCall));
  const calls: EvmRpcCall[] = [
    ...parts.map(callOf),
    ...slotParts.map((part) => ({
      method: "eth_call",
      params: [{ to: reads[part[0]!]!.to, data: "0x" + SEL_EXTSLOADS + word(32n) + word(BigInt(part.length)) + part.map((i) => reads[i]!.data.slice(10)).join("") }, at],
    })),
    ...lone.map((i) => ({ method: "eth_call", params: [{ to: reads[i]!.to, data: reads[i]!.data, ...reads[i]!.tx }, at, reads[i]!.override, ...(reads[i]!.env !== undefined ? [reads[i]!.env] : [])] })),
  ];
  // each call's answer as the reads it holds, [read, answer] pairs
  const decode: ((raw: unknown, who: string) => [number, Answer][])[] = [
    ...parts.map((part) => (raw: unknown, who: string) => unaggregate(raw, part.length, who).map((x, k): [number, Answer] => [part[k]!, x])),
    ...slotParts.map((part) => (raw: unknown, who: string) => unslots(raw, part.length, who).map((x, k): [number, Answer] => [part[k]!, { kind: "out", amountOut: x }])),
    ...lone.map((i) => (raw: unknown, who: string): [number, Answer][] => [[i, answerOf(raw, who, false, reads[i]!.oog === true) as Answer]]),
  ];
  const same = (a: Answer, b: Answer) => (a.kind === "out" ? b.kind === "out" && a.amountOut === b.amountOut : b.kind === "revert" && a.partial === b.partial && a.overflow === b.overflow);
  // a read that may have run out of gas on one provider and reverted on another is not the same answer
  const agreed = (a: Answer, b: Answer) => same(a, b) && (a.kind === "out" || a.gas === (b as { gas?: true }).gas);
  // Each batch is agreed on its own (card evm-buy-quote-ends-on-node): its two answers from the first two providers,
  // and the next provider asked only for a batch whose own answer is late or failed. Agreed a round at a time, one slow
  // batch sent the whole round to the next spare: a cold Robinhood WETH-USDG quote asked each of its 4,130 reads 5.3
  // times on average over five providers and ran past 50 s (2026-11-08 11:0xZ). No batch goes twice to one provider,
  // and every answer used is one two providers gave. A late batch still queued behind a stalled provider's requests
  // moves to the next provider unsent (agreeing's `moving`), so a provider that stops answering holds no batch; one
  // queued behind a provider that answers waits its turn. Spares for answers sent and late are budgeted, as a retry
  // budget is (Finagle's RetryBudget, gRPC's retry throttling): two, plus one per five batches, so a provider slowed by
  // the quote's own load is not handed the load again; a batch whose answer failed or differs asks the next provider
  // whatever the budget.
  // batches of CALLS_PER_BATCH calls in order, each request body kept to maxBytes (a call past it alone)
  const starts: number[] = [];
  for (let c = 0, size = Infinity, k = CALLS_PER_BATCH; c < calls.length; c++) {
    const b = bytesOf(calls[c]!);
    if (k === CALLS_PER_BATCH || size + b > lim.maxBytes) {
      starts.push(c);
      size = BATCH_BYTES;
      k = 0;
    }
    size += b;
    k++;
  }
  const n = starts.length;
  let spares = 2 + Math.ceil(n / 5);
  const late = () => spares > 0 && (spares--, true);
  const all: Answer[] = new Array(reads.length);
  await Promise.all(
    starts.map(async (c0, n) => {
      const batch = calls.slice(c0, starts[n + 1] ?? calls.length);
      const answersOf = async (rpc: EvmRpc, p: number, gate: Gated): Promise<[number, Answer][]> => {
        const b = await askAt(rpc, batch, gate);
        return batch.flatMap((_, j) => decode[c0 + j]!(b[j], `provider ${p + 1}`));
      };
      const { a } = await agreeing(
        rpcs,
        answersOf,
        (x, y) => x.length === y.length && x.every(([i, v], k) => i === y[k]![0] && agreed(v, y[k]![1])),
        (x, y) => refuse("rpc_disagree", `the providers answer read ${x.find(([, v], k) => !agreed(v, y[k]![1]))?.[0] ?? -1} differently at block ${hash}`),
        true,
        undefined,
        true,
        late,
      );
      for (const [i, v] of a) all[i] = v;
    }),
  );
  // a read that may have run out of gas in a call of several (EVM_READ_GAS_CODE's 2) is read again at the same block:
  // from a call of more than READ_AGAIN_PER_CALL in calls of that many, then one still 2 in a call of several alone,
  // with all of a call's gas: no read is priced on gas another read in its call took (card evm-quote-read-gas-starve).
  // One answered 2 alone keeps `gas` and prices nothing; each pass sends fewer reads a call, so it ends
  const size = new Map(parts.flatMap((part) => part.map((i): [number, number] => [i, part.length])));
  const sent = new Map(size);
  // the reads answered 2 behind an earlier read of their call answered 2: kept at a smaller size (readSizes) only where
  // they still answer 2 alone (a burner's own reads)
  const behind = new Set(parts.flatMap((part) => part.filter((i, k) => (all[i] as { gas?: true }).gas === true && part.slice(0, k).some((j) => (all[j] as { gas?: true }).gas === true))));
  // each pass is this read's own: a pass reads its reads again in calls of `per`, never again itself
  for (const per of again === undefined ? [READ_AGAIN_PER_CALL, 1] : []) {
    const more = reads.flatMap((_, i) => ((size.get(i) ?? 1) > per && (per === 1 || (size.get(i) ?? 1) > READ_AGAIN_PER_CALL) && (all[i] as { gas?: true }).gas === true ? [i] : []));
    if (more.length === 0) continue;
    const a = await readBoth(rpcs, hash, more.map((i) => reads[i]!), lim, per);
    more.forEach((i, k) => {
      all[i] = a[k]!;
      size.set(i, per);
    });
  }
  // a plain read read again keeps the size it was last read at; one kept and not read again keeps its size, newest
  for (const i of again === undefined ? plain : []) {
    if (behind.has(i) && (all[i] as { gas?: true }).gas !== true) continue;
    const key = sizeKey(reads[i]!);
    const n = size.get(i) === sent.get(i) ? readSizes.get(key) : size.get(i);
    if (n === undefined) continue;
    readSizes.delete(key);
    readSizes.set(key, n);
    if (readSizes.size > READ_SIZES_KEPT) readSizes.delete(readSizes.keys().next().value!);
  }
  return all;
}

/** The answers of two of the providers `rpcs` that are `same`: the first two are asked at once, and one more of the
 *  rest, in order, whenever an answer is missing: one asked fails, two answered without a pair that is `same` (`vote`
 *  false: a head past maxLag), or the others are late: once one has answered, as long again as its own request took and
 *  at least EVM_HEDGE_MS, and while none has, 4 x EVM_HEDGE_MS (card evm-quote-warm-round: a provider that is slow or has
 *  dropped out is never waited on while two others agree, the industry's hedged request; a spare asked a fixed time
 *  after the start ran every provider of a cbBTC quote's round, whose heaviest batch takes 0.65 s on the fastest). With
 *  `vote`, an answer that differs from another is a vote: from then every provider is asked, and a value is used only
 *  once more than half of `rpcs` gave it, so two that agree on a lie never outvote an honest one (review of bc189de,
 *  M-1). A provider whose answer differs from the one used is held (HOLD). Every answer used is one two different
 *  providers gave. With no value to use it throws `differ` on two that differ, or where none differ, the first failure. */
export const EVM_HEDGE_MS = 400;
// a provider's hold (timed, EVM_HOLD_MS), for an answer that differs from the one a quote used (review of bc189de, M-2)
const HOLD = new WeakMap<EvmRpc, () => void>();
function agreeing<T>(
  rpcs: readonly EvmRpc[],
  one: (rpc: EvmRpc, k: number, gate: Gated) => Promise<T>,
  same: (a: T, b: T) => boolean,
  differ: (a: T, b: T) => never,
  vote = true,
  // which answers that differ from the two used are held (by default, any that is `same` as neither)
  held: (x: T, a: T, b: T) => boolean = (x, a, b) => !same(a, x) && !same(b, x),
  // Spares moved, not added (card evm-buy-quote-ends-on-node): a late request still queued in its provider's gate
  // behind others moves to the next provider, never sent to its own, where that provider is stalled (gated: requests
  // out, none answered for 4 x EVM_HEDGE_MS), and waits its turn where the provider answers; a late request already sent
  // asks a spare only where `late` gives one (the caller's budget). `one` passes `gate` to the provider's call.
  moving = false,
  late?: () => boolean,
): Promise<{ a: T; b: T; i: number; j: number }> {
  const list = [...rpcs];
  const need = Math.floor(list.length / 2) + 1;
  return new Promise((resolve, reject) => {
    const got: { k: number; v: T }[] = [];
    let started = 0;
    let settled = 0;
    let fails = 0;
    let done = false;
    let contested = false;
    let failed: { e: unknown } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lose = () => {
      done = true;
      clearTimeout(timer);
      const x = got[0];
      const y = x === undefined ? undefined : (got.find((g) => !same(x.v, g.v)) ?? got[1]);
      if (x !== undefined && y !== undefined) {
        try {
          differ(x.v, y.v);
        } catch (e) {
          reject(e);
        }
      } else reject(failed?.e);
    };
    const end = () => {
      if (done) return;
      // contested: a value no count of the providers left can bring to `need` is never used
      if (contested && Math.max(...got.map((x) => got.filter((y) => same(x.v, y.v)).length)) + list.length - got.length - fails < need) return lose();
      if (settled < started || started < list.length) return;
      lose();
    };
    const win = (g: { k: number; v: T }, h: { k: number; v: T }) => {
      done = true;
      clearTimeout(timer);
      // the quote's next rounds ask these two first: one that was slow, failed or differed is a spare from now on
      // (`rpcs` is the quote's own list, gated(); reordered only while no other round has)
      if (!Object.isFrozen(rpcs) && list.every((r, n) => rpcs[n] === r)) {
        const order = [list[g.k]!, list[h.k]!, ...list.filter((_, n) => n !== g.k && n !== h.k)];
        order.forEach((r, n) => ((rpcs as EvmRpc[])[n] = r));
      }
      for (const x of got) if (held(x.v, g.v, h.v)) HOLD.get(list[x.k]!)?.();
      resolve({ a: g.v, b: h.v, i: g.k, j: h.k });
    };
    const t0: number[] = [];
    // each request's state in `moving`: sent out of its gate (and when), moved before it was, or settled. A request is
    // late by the time since it was sent, never since it was queued (review of 2d9a7bd9, finding 4: timed from the
    // queue, healthy providers answering in 250 ms asked a spare for 63 of 99 exact-out reads queued behind their gates)
    const sentK: boolean[] = [];
    const sentAt: number[] = [];
    const movedK: boolean[] = [];
    const settledK: boolean[] = [];
    let first = -1;
    const lateAfter = () => (first < 0 ? 4 * EVM_HEDGE_MS : Math.max(EVM_HEDGE_MS, first));
    const fire = () => {
      if (done) return;
      if (!moving) return start();
      // the timer runs only while a provider is left (arm; each start re-arms it), so a moved request has a next
      const ks = Array.from({ length: started }, (_, n) => started - 1 - n).filter((n) => !sentK[n] && !movedK[n] && !settledK[n]);
      const stuck = ks.find((n) => STALLED.get(list[n]!)?.() === true);
      if (stuck !== undefined) {
        movedK[stuck] = true;
        return start();
      }
      if (ks.length > 0) return arm();
      // every request out was sent: late once the newest of them has been out lateAfter()
      const out = Array.from({ length: started }, (_, n) => n).filter((n) => sentK[n] && !settledK[n]);
      const since = performance.now() - Math.max(...out.map((n) => sentAt[n]!));
      if (out.length > 0 && since < lateAfter()) return arm(lateAfter() - since);
      if (late?.() !== false) start();
    };
    const arm = (ms = lateAfter()) => {
      clearTimeout(timer);
      if (started < list.length) {
        timer = setTimeout(fire, ms);
        (timer as { unref?: () => void }).unref?.();
      }
    };
    const start = () => {
      if (done || started >= list.length) return;
      const k = started++;
      t0[k] = performance.now();
      const gate: Gated = { sent: () => void ((sentK[k] = true), (sentAt[k] = performance.now())), moved: () => movedK[k] === true };
      one(list[k]!, k, gate).then(
        (v) => {
          settled++;
          settledK[k] = true;
          if (done) return;
          const now = { k, v };
          got.push(now);
          const peers = got.filter((x) => same(x.v, v));
          if (vote && peers.length < got.length && !contested) {
            contested = true;
            while (started < list.length) start();
          }
          if (!contested && peers.length >= 2) return win(peers[0]!, now);
          if (contested && peers.length >= need) return win(peers[0]!, peers[1]!);
          if (!contested && got.length >= 2) start();
          else if (first < 0) {
            first = performance.now() - (sentAt[k] ?? t0[k]!);
            arm();
          }
          end();
        },
        (e) => {
          settled++;
          settledK[k] = true;
          // a request moved to the next provider is no failure: the next was asked in its place
          if (movedK[k]) return done ? undefined : end();
          fails++;
          failed ??= { e };
          if (done) return;
          start();
          end();
        },
      );
      if (started >= 2) arm();
    };
    start();
    start();
  });
}

/** A request's hooks in its provider's gate (agreeing's `moving`): `sent` as it leaves the gate, and `moved`, read as it
 *  would leave: true, it is not sent (MOVED). */
type Gated = { readonly sent: () => void; readonly moved: () => boolean };
const MOVED = new Error("moved to the next provider before it was sent");
// a gated provider's call with a request's hooks, and whether the provider is stalled (gated, ask)
const GATED = new WeakMap<EvmRpc, (calls: readonly EvmRpcCall[], gate?: Gated) => Promise<readonly unknown[]>>();
const STALLED = new WeakMap<EvmRpc, () => boolean>();

/** One provider's answer to `calls`, asked up to 3 more times 0.5, 1 and 1.5 s apart while it answers 429 (Too Many
 *  Requests: rpc.mainnet.chain.robinhood.com, 2026-11-04 06:53Z, to the reads of one quote), a call's error names its
 *  rate limit ("25/second request limit reached", mainnet.base.org, 07:4xZ) or no connection is made (Unreachable: a
 *  read is asked again, as it sends nothing); any other failure, or a fourth, refuses. */
async function ask(rpc: EvmRpc, calls: readonly EvmRpcCall[], gate?: Gated): Promise<readonly unknown[]> {
  let out: unknown;
  for (let i = 0; ; i++) {
    try {
      // a gated provider says when the request leaves its gate; any other sends it now
      const g = GATED.get(rpc);
      if (g === undefined) gate?.sent();
      out = await (g === undefined ? rpc(calls) : g(calls, gate));
      if (i < 3 && Array.isArray(out) && out.some(limited)) throw new RateLimited("a call's error names the provider's rate limit");
      break;
    } catch (e) {
      // moved, or the quote's deadline passed in the gate (gated): nothing was sent
      if (e === MOVED || (e instanceof EvmQuoteError && e.code === "stale_quote")) throw e;
      if (!(e instanceof RateLimited || e instanceof Unreachable) || i === 3) {
        throw new EvmQuoteError("rpc_error", `a provider did not answer: ${(e as Error)?.message ?? e}`);
      }
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
async function askAt(rpc: EvmRpc, calls: readonly EvmRpcCall[], gate?: Gated): Promise<readonly unknown[]> {
  for (let i = 0; ; i++) {
    const out = await ask(rpc, calls, gate);
    if (!out.some(notYet) || i === 3) return out;
    await new Promise((r) => setTimeout(r, FRESH_RETRY_MS * (i + 1)));
  }
}
const FRESH_RETRY_MS = 250;
/** An answer for a block the provider does not hold yet (askAt's): no result, or an error naming the block or its
 *  state; never a revert, whose string is the called contract's own. */
const notYet = (a: unknown) => {
  const o = a as { result?: unknown; error?: { message?: unknown } } | null;
  return o?.result === null || (!reverted(a) && typeof o?.error?.message === "string" && /(block|header).*not found|unknown block|unknown state/i.test(o.error.message));
};

/** A block header from a provider's answer: number, hash, timestamp and base fee (null when it gives none), or a
 *  refusal. */
function header(a: unknown, who: string): Block {
  const r = (a as { result?: unknown } | null)?.result as { number?: unknown; hash?: unknown; timestamp?: unknown; baseFeePerGas?: unknown } | null | undefined;
  const q = (x: unknown) => typeof x === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(x);
  if (typeof r !== "object" || r === null || !q(r.number) || !q(r.timestamp) || typeof r.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.hash)) {
    return refuse("rpc_error", `${who} answered no block`);
  }
  const fee = r.baseFeePerGas;
  if (fee !== undefined && (typeof fee !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(fee))) return refuse("rpc_error", `${who} answered a block with a malformed base fee`);
  return { number: BigInt(r.number as string), hash: lower(r.hash), timestamp: BigInt(r.timestamp as string), baseFeePerGas: fee === undefined ? null : BigInt(fee) };
}

type Block = { number: bigint; hash: string; timestamp: bigint; baseFeePerGas: bigint | null };
/** The block both providers read at: the lower of their two heads, at most `maxLag` blocks apart and no more than
 *  EVM_QUOTE_MAX_AGE_MS behind the device's clock, with `confirm`, which reads that number's hash and time on the other
 *  provider and must find the same block. One provider alone cannot pick an old block, nor name a block the other does
 *  not hold (review of b17d1fc, R1, R1b). `confirm` runs beside the reads, and nothing read is used before it passes. */
// `t0`: when the wait for `minBlock` began (a retry of the same quote shares the first one's deadline); `of`: how many
// providers the quote lists, which a contested confirm needs more than half of, however many are asked here (card
// evm-quote-lag-held review, MED-2: a retry without one held provider counted it over the list left, 2 of 3 where the
// quote's 4 need 3, and two colluders confirmed their block)
async function agreedBlock(rpcs: readonly EvmRpc[], maxLag: bigint, nowMs: number, minBlock = 0n, mono: () => number = monotonic, start: number = mono(), t0: number = mono(), of: number = rpcs.length): Promise<{ block: Block; confirm: () => Promise<void>; low: EvmRpc }> {
  const call: EvmRpcCall = { method: "eth_getBlockByNumber", params: ["latest", false] };
  const near = (x: Block, y: Block) => x.number - y.number <= maxLag && y.number - x.number <= maxLag;
  // the order agreeing indexes, taken as each round starts, as agreeing takes its own (it reorders `rpcs`, the quote's
  // list, once a round has its two)
  let list = [...rpcs];
  // two heads within maxLag of each other, from the first two providers that give them (agreeing: a spare is asked for
  // one that fails, is slow or lags)
  // `minBlock`: a sell's buy's block (card evm-buy-hookdata-fee). W holds the token only from that block on, so the
  // heads are asked again, every EVM_MIN_BLOCK_EVERY_MS, until the lower reaches it, and refused not_landed past
  // EVM_MIN_BLOCK_WAIT_MS: a sell asked right after its buy is quoted at a block that holds the buy, never read as
  // fee_on_transfer at one before it. One deadline on the monotonic clock covers the sleeps and the reads, each round
  // of heads cut off at the time left, so a slow or rate-limited provider holds the quote no longer (review fold 1, M2)
  const left = () => EVM_MIN_BLOCK_WAIT_MS - (mono() - t0);
  const late = () => refuse("not_landed", `the providers' heads did not reach block ${minBlock}, the buy's, within ${EVM_MIN_BLOCK_WAIT_MS} ms`);
  let got: { a: Block; b: Block; i: number; j: number };
  for (;;) {
    list = [...rpcs];
    const round = agreeing(
      rpcs,
      async (rpc, k) => header((await ask(rpc, [call]))[0], `provider ${k + 1}`),
      near,
      (x, y) => refuse("rpc_disagree", `the providers' heads ${x.number} and ${y.number} are more than ${maxLag} blocks apart`),
      // a head past maxLag is a missing answer, not a vote
      false,
      // held: only a head more than maxLag below the lower of the two, never one above them (re-review of fd9dd16, LOW-1:
      // a liar's old head and a lagging honest one held the provider that was up to date)
      (x, a, b) => x.number + maxLag < (a.number <= b.number ? a.number : b.number),
    );
    got = minBlock === 0n ? await round : await within(round, left(), late);
    if (got.a.number >= minBlock && got.b.number >= minBlock) break;
    if (left() <= 0) return late();
    await new Promise((r) => setTimeout(r, EVM_MIN_BLOCK_EVERY_MS));
  }
  const { a, b, i, j } = got;
  const [lo, at, own] = a.number <= b.number ? [a, j, i] : [b, i, j];
  // the block's age on the device's clock now: the quote's clock at its entry (`nowMs`, at `start` on `mono`) and the
  // time since, the scan and the wait for the buy's block included (review fold 1, L2; fold 2, LOW-1)
  const atMs = nowMs + Math.max(0, mono() - start);
  if (atMs - Number(lo.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) return refuse("stale_quote", `block ${lo.number} is more than 30 s old`);
  // confirmed on the provider of the other head, or where that one fails, on the next of the rest (never the lower
  // head's own provider): a block one provider alone named is never read at. A provider that holds another block there
  // is a vote against it, as in agreeing: the next of the rest is asked, and the block is read at only once more than
  // half the providers hold it, the lower head's own provider one of them (review of bc189de, M-2)
  const others = [at, ...list.map((_, k) => k).filter((k) => k !== i && k !== j)];
  const need = Math.floor(Math.max(of, list.length) / 2) + 1;
  const confirm = async () => {
    const by = { method: "eth_getBlockByNumber", params: ["0x" + lo.number.toString(16), false] };
    let holds = 1;
    const against: number[] = [];
    let failed: { e: unknown } | null = null;
    // where the other head's provider gives no answer (a failure, or no such block), or one holds another block, the
    // block is read at only with `need`: a spare alone never confirms what the lower head's provider named (re-review
    // of fd9dd16, MEDIUM-1: two colluders confirmed their block when the honest one of the pair failed its confirm)
    let unsure = false;
    const strict = () => unsure || against.length > 0;
    const enough = () => holds >= (strict() ? need : 2);
    for (let n = 0; n < others.length && !enough(); n++) {
      // too few left to bring it to `need`
      if (strict() && holds + others.length - n < need) break;
      let back: Block;
      try {
        back = header((await askAt(list[others[n]!]!, [by]))[0], `provider ${others[n]! + 1}`);
      } catch (e) {
        failed ??= { e };
        if (n === 0) unsure = true;
        continue;
      }
      if (back.number !== lo.number || back.hash !== lo.hash || back.timestamp !== lo.timestamp || back.baseFeePerGas !== lo.baseFeePerGas) {
        against.push(others[n]!);
      } else holds++;
    }
    if (enough()) return against.forEach((k) => HOLD.get(list[k]!)?.());
    if (against.length > 0) return refuse("rpc_disagree", `the providers hold different blocks at ${lo.number}`);
    throw failed?.e;
  };
  // `low`: the lower head's own provider (card evm-quote-lag-held: held where that head lags the scan provider's)
  return { block: lo, confirm, low: list[own]! };
}
/** The oldest block a quote reads, and the oldest quote a buy is built from, behind the device's clock. */
export const EVM_QUOTE_MAX_AGE_MS = 30_000;
/** How long a sell quote waits for both providers' heads to reach its buy's block, and how often it asks: as long as a
 *  quote's block may be old, so a provider at most that far behind is waited for. */
export const EVM_MIN_BLOCK_WAIT_MS = 30_000;
const EVM_MIN_BLOCK_EVERY_MS = 500;
/** The device's monotonic clock, ms: a wall clock set back or forward moves no wait's deadline. */
const monotonic = (): number => performance.now();
/** `p`, or `onLate()` once `ms` have passed first; the timer is cleared either way. */
async function within<T>(p: Promise<T>, ms: number, onLate: () => never): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => { try { onLate(); } catch (e) { reject(e); } }, Math.max(0, ms))))]);
  } finally {
    clearTimeout(timer);
  }
}

// The held head (card evm-quote-head-watch): the last block both providers agreed on and confirmed by number (same hash
// and time), kept between quotes so a tap runs only the read round. A quote reads at it only while it was read at most
// EVM_HEAD_REUSE_MS ago on the device's clock (a block's own time trails the clock by its interval and the providers'
// lag: Base's blocks, 2 s apart then, read 1.1 to 1.4 s behind this Mac's clock, 2026-11-04 10:58Z, so an age by block time held a
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
export function evmHeadWatch(order: readonly EvmRpc[] | (() => readonly EvmRpc[]), maxLag: bigint, clock: () => number = Date.now, background = true, mono: () => number = () => performance.now()): EvmHeadWatch {
  // the providers in their order at each read: the pinned ones by their measured speed (evmPoolBuyQuote)
  const rpcsNow = () => (Array.isArray(order) ? order : (order as () => readonly EvmRpc[])());
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
        const { block, confirm } = await agreedBlock(rpcsNow(), maxLag, nowMs);
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
      const a = await agreedBlock(rpcsNow(), maxLag, t);
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
// EVM_QUOTE_MAX_KEYS: the most pools' state (two extsload words each) a quote reads, the token's scanned ones, X's
// markets and X's other pools; past it the quote refuses (too_many_pools), as past every bound here: none cuts a pool
// unread. The caller's list has its own EVM_QUOTE_MAX_HINTS beside it, so it never pushes a token past it (review of
// c71a4d0..a9f1d32, LOW 1).
export const EVM_QUOTE_MAX_KEYS = 65_536;
// The most currencies X and Y a quote prices (one getLogs request names at most SCAN_OR of them), and the most routes
// the device makes from found pools that could beat the route (each quoted at the amount and twice it); past either
// the quote refuses (too_many_pools), never cuts (review of 13a063e, HIGH).
export const EVM_QUOTE_MAX_OTHER = 1_024;
export const EVM_QUOTE_MAX_QUOTED = 1_024;
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
/** V4Quoter.quoteExactOutputSingle of `amount` of `token` out of the pool `k` (card rh-cold-quote, the X prune): it
 *  reverts NotEnoughLiquidity where the pool cannot give that much at any price. */
const SEL_V4_OUT_SINGLE = "58733073"; // quoteExactOutputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
function exactOutRead(quoter: string, k: EvmPoolKey, token: string, amount: bigint): { to: string; data: string } {
  // the struct (PoolKey, zeroForOne, exactAmount, hookData): a pool key's five words, two more, then the empty bytes'
  // offset (eight words) and length
  const key = word(BigInt(k.currency0)) + word(BigInt(k.currency1)) + word(BigInt(k.fee)) + word(BigInt.asUintN(256, BigInt(k.tickSpacing))) + word(BigInt(k.hooks));
  return { to: quoter, data: "0x" + SEL_V4_OUT_SINGLE + word(0x20n) + key + word(lower(k.currency1) === token ? 1n : 0n) + word(amount) + word(0x100n) + word(0n) };
}
/** The pool key of a one-hop v4 route. */
function keyOfRoute(r: EvmV4Route): EvmPoolKey {
  const [a, b] = [lower(r.currencyIn), lower(r.hops[0]!.currency)];
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  const h = r.hops[0]!;
  return { currency0, currency1, fee: h.fee, tickSpacing: h.tickSpacing, hooks: lower(h.hooks) };
}

// The device's own scan of the PoolManager's Initialize logs for a currency, kept per chain, currency and kind in this
// module's memory: the blocks it has read (`spans`, disjoint and in order) and the pools it found in them. A quote reads
// only the blocks of the last `depth` up to the scan provider's head that no scan read yet, so the first quote for a
// currency scans `depth` blocks back and each later one from the block the last reached. Each span read is kept once
// the scan ends, the ones that came back also when another failed (card evm-quote-warm-round: a scan of 2,313 currencies
// that lost one request of 40 kept nothing and was asked again whole by every quote), so no scan reads a block twice. A
// scan only adds pools, so one provider serves it; what it finds is read on both providers like any candidate. "all":
// every pool of the currency; "markets": its pools with the native asset or WETH.
const INITIALIZE = "dd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"; // Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)
type Spans = [number, number][];
const SCANS = new Map<string, { spans: Spans; pools: EvmPoolKey[] }>();
/** `spans` with [a, b] added, merged where they touch. */
const withSpan = (spans: Spans, a: number, b: number): Spans => {
  const out: Spans = [];
  for (const [x, y] of [...spans, [a, b] as [number, number]].sort((p, q) => p[0] - q[0])) {
    const last = out[out.length - 1];
    if (last !== undefined && x <= last[1] + 1) last[1] = Math.max(last[1], y);
    else out.push([x, y]);
  }
  return out;
};
/** The blocks from `lo` to `hi` that `spans` does not hold. */
const gapsOf = (spans: Spans, lo: number, hi: number): Spans => {
  const out: Spans = [];
  let at = lo;
  for (const [a, b] of spans) {
    if (b < at) continue;
    if (a > hi) break;
    if (a > at) out.push([at, a - 1]);
    at = Math.max(at, b + 1);
  }
  if (at <= hi) out.push([at, hi]);
  return out;
};
// The warm round (card evm-quote-warm-round): what a token's last quote read after its first round, kept per chain,
// side and token for EVM_WARM_RANGE_S of block time. The next quote of the token asks those reads in its own first
// round and starts those scans beside the token's, so where nothing changed every later round finds its reads already
// answered and the quote takes one round of reads. A kept read is only asked earlier: it counts only where the quote,
// run as it always runs at its own block, asks it again, so every check reads the new block (a pool that vanished is
// not held, one seeded since is found by the scan and read in a round of its own).
// `xs`: the currencies X the token's last quote kept past its X prune (card evm-spare-list-green)
const PLANS = new Map<string, { ts: bigint; reads: Read[]; scans: { cs: string[]; kind: ScanKind }[]; xs: string[] }>();
/** The block time a token's kept reads are asked for (card evm-quote-warm-round: 60 s). */
export const EVM_WARM_RANGE_S = 60n;
/** The most tokens whose reads are kept, the oldest dropped first. */
const PLANS_MAX = 64;
const readKey = (r: Read) => JSON.stringify([r.to, r.data, r.override ?? null, r.group ?? null, r.state ?? null, r.tx ?? null], (_, x) => (typeof x === "bigint" ? String(x) : x));
const SCAN_TOKENS = 4096;
const SCAN_MAX_LOGS = 10_000;
/** A scan request that fails or answers SCAN_MAX_LOGS logs or more is asked again as its two halves, at most
 *  SCAN_SPLITS times over (card evm-quote-head-watch): base-rpc.publicnode.com took 3.6 to 10.8 s for a 50,000-block
 *  span of USDC's Initialize logs with 20 at once, past the 10 s timeout, and 0.9 to 2.4 s for 10,000 (2026-11-04
 *  10:50Z), so a cold scan of USDC refused every quote and never kept what it read. At the smallest span the request is
 *  asked as before (askScan) and a failure refuses. */
const SCAN_SPLITS = 3;
/** Where another provider follows, the most blocks of a cold scan's request it is handed that the one before failed in
 *  transport (an HTTP 5xx, a refused connection, a timeout, its last block not held yet): a longer one is asked as its
 *  halves on the one that failed it first (review of 9c962b6d, HIGH, a repeat of M382's HIGH-1: one such failure on
 *  Robinhood's first handed its spare alone the whole 10M-block depth of a cold quote, and a spare that hid the token's
 *  real pool had a seeded route pass; review of 1277e8af, MEDIUM-B: 100,000, Robinhood's OR span, where 1M handed a
 *  cached scan's 500,000-block gap to the spare). */
const SCAN_ALONE = 100_000;
/** The most halving requests one level of a scan's halves asks, where a provider's answers are short of the logs only
 *  where a range holds SCAN_MAX_LOGS of them or more: those ranges of one level are apart, and a quote reads at most
 *  EVM_QUOTE_MAX_KEYS pools (past them it refuses too_many_pools), so at most ceil(EVM_QUOTE_MAX_KEYS / SCAN_MAX_LOGS)
 *  ranges a level split, each into 2 requests. A scan's halves run ceil(log2(span)) levels at most, from a request of
 *  its first provider's span down to one block; past SCAN_SHORT_LEVEL times that many, the provider is answering errors
 *  no honest chain explains, and the scan refuses (rpc_error) rather than hold the quote to its bound (review of
 *  1265bd94: a first that answered every range with an error held each cold quote 60 s). Robinhood: 14 x 24 = 336;
 *  Base: 14 x 14 = 196. Each request a scan starts with may also be short once for reasons of its own (a query timeout
 *  answered inside a 200, a provider's range cut below its pinned span) and is answered by its halves, so each one's
 *  first split, 2 requests, is the scan's beside these: the budget is 2 x the scan's starting requests (its jobs, the
 *  newest span's and a catch-up's among them, and those a next provider takes) + SCAN_SHORT_LEVEL x ceil(log2(span))
 *  (review of ac6db348, MEDIUM: a cold Base scan starts with about 101 requests, past the 196 alone, so one honest error
 *  on each refused every cold Base quote). */
const SCAN_SHORT_LEVEL = 2 * Math.ceil(EVM_QUOTE_MAX_KEYS / SCAN_MAX_LOGS);
/** The most currencies one getLogs request names: an OR of topics, so the currencies of a quote's scan cost the
 *  requests of one. */
const SCAN_OR = 256;
type ScanKind = "all" | "markets";
/** The scan provider's requests at once, across every scan of one quote: the token's and each X's scans queue in the
 *  order they ask (the token's first), at most the venue's `parallel` in flight. Nine scans that each sent their own
 *  `parallel` at once drew 429s on rpc.mainnet.chain.robinhood.com (2026-11-03 21:20Z: 89 of 125 requests). One gate
 *  per quote, so a request that never returns holds up that quote alone. */
type Gate = <T>(f: () => Promise<T>) => Promise<T>;
/** Exported for the tests (T8b); not in the index. */
export function gateOf(parallel: number): Gate {
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
/** The longest a quote's scan waits on its provider's rate limit, from the quote's start: past it the scan refuses
 *  (rpc_error) rather than wait on. base-rpc.publicnode.com limits each address's getLogs work to about two cold scans
 *  back to back, then answers most requests 429 for under a minute (2026-11-04 21:26-21:27Z); a cold quote on GitHub's
 *  runner, whose 4 tries a request ran out, ended rpc_error after 99 s (card evm-quote-warm-round, fold 5). */
export const EVM_SCAN_BOUND_MS = 60_000;
let scanBoundMs = EVM_SCAN_BOUND_MS;
/** For the tests: the scan's bound in ms (no argument: EVM_SCAN_BOUND_MS). Not in the index. */
export const evmScanBound = (ms = EVM_SCAN_BOUND_MS) => void (scanBoundMs = ms);
/** The scan requests asked of any provider's gate so far, every one counted once whatever its end: for the tests that
 *  count a scan's work past its bound (not in the index). */
let scanAsks = 0;
export const evmScanAsks = (): number => scanAsks;
/** The wait after a throttle that named no Retry-After: 0.5 s, doubled for each throttle since an answer, to 8 s. */
const SCAN_BACKOFF_MS = 500;
/** Where the chain pins a second scan provider (the venue's `scan.spares`, cards evm-scan-second-provider and
 *  evm-rpc-spare-list) and the scan is one the second carries whole (its blocks within one round of the second's
 *  requests: a warm scan), the share of each request of each provider with another behind it: it answers within
 *  EVM_SCAN_HOLD_MS and its throttle holds it no longer, or the request goes to the next. rpc.mainnet.chain.robinhood.com held warm Robinhood quotes 56 to 60 s on its rate limit, each ending
 *  rpc_error (live run 42059239410, evm-quote-lag-held, 2026-11-05 15:53-15:56Z); a warm getLogs of a few blocks
 *  answered in 93 to 773 ms on every pinned scan provider (2026-11-05 16:14-16:23Z). A cold scan keeps the whole
 *  bound on the first, as before: neither second carries Base's 1M or Robinhood's 10M blocks within it (the venue's
 *  notes), so a cut would end cold quotes the first alone finishes. */
export const EVM_SCAN_HOLD_MS = 2_000;
/** A scan request's tries at its smallest span: a timeout or a failure other than a throttle spends one. */
const SCAN_TRIES = 4;
const SCAN_BACKOFF_MAX_MS = 8_000;
/** The scan provider's requests of one quote: the token's and each X's scans queue in the order they ask (the token's
 *  first), at most `limit` in flight, `limit` starting at the venue's `parallel` (nine scans that each sent their own
 *  `parallel` at once drew 429s on rpc.mainnet.chain.robinhood.com, 2026-11-03 21:20Z: 89 of 125 requests).
 *  - A throttle (HTTP 429, or a call's error naming the rate limit) or a request that ran out of time halves `limit`,
 *    to 1 at least, once per event: a request sent before the last cut never cuts again (TCP NewReno).
 *  - A throttle holds every request not yet sent for the longer of its Retry-After and the backoff, 0.5 s doubled for
 *    each throttle event since an answer, to 8 s; a later, shorter wait never shortens one already set.
 *  - Each answer adds 1 back up to half the limit at the last cut, and 1 / limit past it, up to `parallel` (TCP Reno:
 *    at 1 added an answer, a provider that slows past 5 in flight was sent 11 at once again and again).
 *  - A throttled request is asked again whole and spends none of its tries. One whose connection was refused is asked
 *    again whole too, 0.5, 1 and 2 s later, and refused at its fourth refusal in a row, never asked as its halves
 *    (re-review of b282ce0, LOW-C: uncounted, a provider that refused every getLogs held the quote to the bound, 60 s).
 *  - Nothing is sent once the quote's bound has passed, and no request runs past it (re-review of 59a69e2, MEDIUM-1: a
 *    provider that timed out every request was asked one at a time, about 10.8 hours at the 10 s deadline).
 *  One gate per quote, so a request that never returns holds up that quote alone. */
type ScanGate = { ask: (rpc: EvmRpc, calls: readonly EvmRpcCall[], tries: number, fast?: boolean) => Promise<readonly unknown[]> };
/** A scan request whose connection was refused SCAN_TRIES times in a row: the scan refuses, never asks its halves,
 *  which go to the same provider. Where another provider follows (`spareNext`), a provider's gate refuses this way, at
 *  once, a request whose connection was refused, and a `fast` request (a warm scan's) that its throttle would hold, or
 *  that does not answer, past EVM_SCAN_HOLD_MS: the scan asks the next one for those blocks (scanPools). */
class ScanRefused extends EvmQuoteError {}
/** A request whose own last block the provider answered it does not hold yet (null): its halves end at the same block,
 *  so it is asked again whole, never as its halves (card evm-rpc-spare-list, re-review of 156ece1 LOW-2: a 1-block lag
 *  asked the newest block 3 times in 9 requests where 2 do; a block or two behind is a provider's normal state). */
class NotHeldYet extends EvmQuoteError {}
/** A scan's refusal that no next provider is asked about (reviews of 8fd51265 and 1277e8af):
 *  - a cold scan's provider whose rate limit holds it past the quote's bound is up, so its blocks never go to a spare
 *    alone (one 429 with a Retry-After of 120 s handed Robinhood's spare the whole cold depth);
 *  - one block whose logs its provider does not answer (too_many_pools; `short` in scanPools). */
class ScanStop extends EvmQuoteError {}
/** The scan provider answered, short of the logs: an error in the answer, an HTTP status other than 429 or 5xx, a body
 *  that is not a batch or past its size (BadAnswer). The scan asks its halves on the same provider, never the next. */
class ScanAnswered extends EvmQuoteError {}
function scanGateOf(parallel: number, untilMs: number, spareNext = false, deadline?: Deadline): ScanGate {
  let limit = parallel;
  // the limit up to which each answer adds 1, half the limit at the last congestion; past it an answer adds 1 / limit
  let sst = parallel;
  let flying = 0;
  let resumeAt = 0;
  let strikes = 0;
  // the cuts so far: a request records the count when it is sent
  let cuts = 0;
  const waiting: (() => void)[] = [];
  // a wait between tries, never past the bound (the next send then refuses)
  const nap = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, untilMs - performance.now()))));
  // past the bound the whole scan stops (ScanStop): a request refused there is never asked as its halves, each of which
  // the gate refuses at once (card evm-buy-quote-in-window: as an rpc_error, a cold Robinhood scan's refused 10M-block
  // requests were halved down to their smallest spans, about a thousand promises each, and the process ran out of its
  // 4 GB heap at a quote's bound, 2026-11-08 13:5xZ)
  const past = () => new ScanStop("rpc_error", `the scan provider did not answer within the quote's bound of ${scanBoundMs} ms`);
  const slow = () => new ScanRefused("rpc_error", `the scan provider did not answer within ${EVM_SCAN_HOLD_MS} ms`);
  // past the quote's deadline (gated) no scan request is sent either, nor one waited for that would go past it
  const stale = () => new ScanStop("stale_quote", `the quote's block is more than ${EVM_QUOTE_MAX_AGE_MS / 1000} s old: no more scans are sent`);
  const left = () => (deadline === undefined ? Infinity : deadline.until - deadline.now());
  // every request waiting looks again: one sent, an answer back, a wait ended
  const wake = () => waiting.splice(0).forEach((r) => r());
  // a slot, once the provider's wait is over
  const take = async (fast: boolean) => {
    for (;;) {
      const now = performance.now();
      if (left() < 0 || resumeAt - now > left()) throw stale();
      if (now >= untilMs) throw past();
      if (resumeAt > untilMs) {
        const m = `the scan provider limited its rate past the quote's bound of ${scanBoundMs} ms`;
        // a warm scan's goes to the next, as its hold does; a cold scan's refuses (ScanStop)
        throw fast ? new EvmQuoteError("rpc_error", m) : new ScanStop("rpc_error", m);
      }
      if (fast && resumeAt - now > EVM_SCAN_HOLD_MS) throw new ScanRefused("rpc_error", `the scan provider limited its rate for ${Math.round(resumeAt - now)} ms`);
      if (now < resumeAt) await new Promise((r) => setTimeout(r, resumeAt - now));
      else if (flying < Math.floor(limit)) {
        flying++;
        return;
      } else await new Promise<void>((r) => waiting.push(r));
    }
  };
  const done = () => {
    flying--;
    wake();
  };
  // a congestion signal halves the limit once per event, as TCP NewReno does: only a request sent after the last cut
  // cuts again, so the twenty answers of one burst take 20 to 10, not to 1
  const congest = (sent: number) => {
    if (sent !== cuts) return false;
    cuts++;
    limit = sst = Math.max(1, Math.floor(limit / 2));
    return true;
  };
  // the backoff of the event this throttle is part of: a new event is a strike more, and the other 429s of its burst
  // wait that event's backoff, not the next one's (twenty 429s at once wait 0.5 s, not 1)
  const throttle = (sent: number, afterMs: number | null) => {
    if (congest(sent)) strikes++;
    const wait = Math.max(afterMs ?? 0, Math.min(SCAN_BACKOFF_MAX_MS, SCAN_BACKOFF_MS * 2 ** Math.max(0, strikes - 1)));
    resumeAt = Math.max(resumeAt, performance.now() + wait);
  };
  // the request, ended at the quote's bound where that comes before its own deadline, and a fast one at
  // EVM_SCAN_HOLD_MS
  const send = async (rpc: EvmRpc, calls: readonly EvmRpcCall[], fast: boolean) => {
    const toBound = untilMs - performance.now();
    const left = fast ? Math.min(toBound, EVM_SCAN_HOLD_MS) : toBound;
    if (left >= EVM_RPC_TIMEOUT_MS) return rpc(calls);
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_, no) => {
      timer = setTimeout(() => {
        const e = fast && left < toBound ? slow() : past();
        stop.abort(e);
        no(e);
      }, Math.max(0, left));
    });
    try {
      return await Promise.race([rpc(calls, stop.signal), bound]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async ask(rpc, calls, tries, fast = false) {
      scanAsks++;
      fast &&= spareNext;
      let refused = 0;
      for (let i = 0; ; ) {
        await take(fast);
        const sent = cuts;
        let out: unknown;
        try {
          out = await send(rpc, calls, fast);
        } catch (e) {
          done();
          if (e instanceof RateLimited) {
            throttle(sent, e.afterMs);
            continue;
          }
          if (e instanceof ScanRefused || (e instanceof EvmQuoteError && /within the quote's bound/.test(e.message))) throw e;
          // a refused connection sent nothing: asked again whole after the backoff, never as its halves (re-review of
          // 59a69e2, LOW-2: halving on it sent 2,300 getLogs where 200 do), and refused at the fourth in a row, as the
          // providers' ask is (re-review of b282ce0, LOW-C: a provider that died mid-scan held the quote 60 s)
          // where another provider follows, one that answers HTTP 5xx is out as one with no connection is, and the
          // request goes to the next at once (card evm-rpc-spare-list: bloXroute answered every request 503 "No server
          // is available to handle this request" for 10 minutes, 2026-11-05 17:59-18:09Z; asked as its halves, each
          // 503 again); the last asks its halves, as before
          // the provider answered: its halves are asked of it (scanPools `short`), at once, never again whole
          if (e instanceof BadAnswer) throw new ScanAnswered("rpc_error", `the scan provider answered: ${e.message}`);
          if (spareNext && /^the provider answered HTTP 5\d\d$/.test(String((e as Error | null)?.message))) throw new ScanRefused("rpc_error", `the scan provider is out: ${(e as Error).message}`);
          if (e instanceof Unreachable) {
            if (spareNext) throw new ScanRefused("rpc_error", `the scan provider refused a connection: ${e.message}`);
            if (++refused >= SCAN_TRIES) throw new ScanRefused("rpc_error", `the scan provider refused ${refused} connections in a row: ${e.message}`);
            await nap(SCAN_BACKOFF_MS * 2 ** (refused - 1));
            continue;
          }
          // a timeout is a congestion signal too (GitHub's runner, 7d6ec94: 14 of 128 and 7 of 114 of a cold quote's
          // getLogs ran out of time at 20 at once, no 429); it and any other failure spend a try
          if ((e as Error | null)?.name === "TimeoutError") congest(sent);
          if (++i >= tries) throw e instanceof EvmQuoteError ? e : new EvmQuoteError("rpc_error", `a provider did not answer: ${(e as Error)?.message ?? e}`);
          await nap(500 * i);
          continue;
        }
        done();
        if (Array.isArray(out) && out.some(limited)) {
          throttle(sent, null);
          continue;
        }
        strikes = 0;
        limit = Math.min(parallel, limit < sst ? limit + 1 : limit + 1 / limit);
        if (!Array.isArray(out) || out.length !== calls.length) return refuse("rpc_error", "a provider answered another number of calls");
        return out;
      }
    },
  };
}
/** The scan provider's head, read once per quote: every scan of the quote reads up to it, so a scan that waits at the
 *  gate behind others is held to the same head as the first (a head read per scan, seconds later, was past maxLag on
 *  Robinhood, 2026-11-03 21:30Z). */
async function scanHeadOf(rpc: EvmRpc, gate: ScanGate): Promise<bigint> {
  // fast where another follows: one call, answered in about 100 ms (2026-11-05 16:13-16:21Z)
  const h = (await gate.ask(rpc, [{ method: "eth_blockNumber", params: [] }], SCAN_TRIES, true))[0] as { result?: unknown } | null;
  if (typeof h?.result !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(h.result)) return refuse("rpc_error", "the scan provider answered no block number");
  const scanHead = BigInt(h.result);
  if (scanHead > BigInt(Number.MAX_SAFE_INTEGER)) return refuse("rpc_disagree", "the scan provider's head is past any block");
  return scanHead;
}
/** A scan provider as one scan asks it: its rpc, its gate and its span a request (`orSpan` where a topic position
 *  holds more than one value), and `next`, the provider of the chain's ordered list after it, which asks again the
 *  blocks of any request this one failed (cards evm-scan-second-provider, evm-rpc-spare-list). */
type ScanOn = { rpc: EvmRpc; gate: ScanGate; span: number; parallel: number; orSpan?: number | undefined; next?: ScanOn | undefined };
/** The quote's scan providers: the head every scan reads up to and the provider asked first, the rest behind it in
 *  order (`next`). A first that answered no head still carries the requests: the head is the first of the rest that
 *  answered one. */
type ScanFrom = { head: bigint; first: ScanOn };
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
  s: { span: number; depth: number },
  agreed: () => Promise<Block>,
  maxLag: bigint,
  from: Promise<ScanFrom>,
  picked: () => Promise<Block> = agreed,
): Promise<{ pools: Map<string, EvmPoolKey[]>; commit: () => void }> {
  const { head: scanHead, first } = await from;
  const second = first.next;
  // the logs up to the scan provider's head are read beside the round before (at most depth / span requests for each
  // SCAN_OR currencies), and used only once that head is found within maxLag of the agreed block
  const head = Number(scanHead);
  const floor = Math.max(0, head - s.depth + 1);
  const each = cs.map((c) => {
    const key = `${chain}:${kind}:${c}`;
    const cached = SCANS.get(key);
    const pools = cached === undefined ? [] : [...cached.pools];
    // the blocks read before, those still within the depth
    const spans: Spans = (cached?.spans ?? []).filter(([, b]) => b >= floor).map(([a, b]) => [Math.max(a, floor), b]);
    return { c, key, spans, gaps: gapsOf(spans, floor, head), pools, ids: new Set(pools.map(poolId)) };
  });
  type Each = (typeof each)[number];
  // the currencies with the same blocks left share each request
  const groups = new Map<string, Each[]>();
  for (const e of each) append(groups, JSON.stringify(e.gaps), e);
  const w = (c: string) => "0x" + word(BigInt(c));
  // `pin`: a catch-up request also asks its provider for the agreed block by number, in the same batch, and its logs
  // count only where that answer is the agreed block's hash (review of c71a4d0..a9f1d32, MEDIUM: a head read on one
  // backend and logs answered by another that lags behind it, empty past its own head with no error)
  let pin: Block | null = null;
  type Job = { part: Each[]; a: number; b: number; on: ScanOn };
  const jobs: Job[] = [];
  // the halving requests asked for answers short of the logs, and the most an honest chain needs (SCAN_SHORT_LEVEL)
  let shorts = 0;
  // 2 x the starting requests, added as each set of them is built, + the levels' share (SCAN_SHORT_LEVEL)
  let shortMax = SCAN_SHORT_LEVEL * Math.ceil(Math.log2(first.span));
  const jobsOf = (g: Each[], from: number, to: number, on = first, into = jobs): void => {
    // where the blocks up to the head are more than the next provider's span, their newest span of it is a request of
    // its own (reviews of 9c962b6d and 1277e8af): a backend a block or two behind its head answers null for that
    // request's last block alone, and the next carries those blocks in one request; the rest stays under the
    // provider's cap (Robinhood's 10M a request)
    if (on.next !== undefined && to === head && to - from + 1 > on.next.span) {
      jobsOf(g, from, to - on.next.span, on, into);
      return jobsOf(g, to - on.next.span + 1, to, on, into);
    }
    // a provider may span fewer blocks a request when a topic position holds more than one value (orSpan): then each
    // currency is asked alone, at the provider's whole span, where that is no more requests than the OR (card
    // rh-cold-quote: Robinhood's 10M blocks are 100 OR requests of 100,000 for any number of currencies, and one
    // request a currency alone)
    const or = Math.min(on.span, on.orSpan ?? on.span);
    const n = to - from + 1;
    const step = or < on.span && g.length * Math.ceil(n / on.span) <= Math.ceil(g.length / SCAN_OR) * Math.ceil(n / or) ? 1 : SCAN_OR;
    for (let i = 0; i < g.length; i += step) {
      const part = g.slice(i, i + step);
      const span = part.length === 1 ? on.span : or;
      for (let a = from; a <= to; a += span) into.push({ part, a, b: Math.min(to, a + span - 1), on });
    }
  };
  for (const g of groups.values()) for (const [a, b] of g[0]!.gaps) jobsOf(g, a, b);
  shortMax += 2 * jobs.length;
  // a scan the second carries whole, in one round of its requests (a warm one): each provider with another behind it
  // has EVM_SCAN_HOLD_MS a request before the next takes it (scanGateOf)
  const fast = second !== undefined && jobs.reduce((n, j) => n + Math.ceil((j.b - j.a + 1) / second.span), 0) <= second.parallel;
  // each request's logs as it comes back
  const got: { part: Each[]; a: number; b: number; logs: unknown[] }[] = [];
  const one = async ({ part, a, b, on }: Job, splits = SCAN_SPLITS): Promise<void> => {
    const f = (topics: (string | string[] | null)[]) => ({ method: "eth_getLogs", params: [{ address: pm, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), topics }] });
    const t = part.length === 1 ? w(part[0]!.c) : part.map((e) => w(e.c));
    // Initialize's topics are the event, the pool id, currency0 and currency1 (a log read on base-rpc.publicnode.com,
    // block 0x32fd7c9, 2026-11-03 20:40Z): the currency as currency0, then as currency1; a market's other currency is
    // the native asset (address 0, always currency0) or WETH, one value a position
    const e0 = "0x" + INITIALIZE;
    const filters = kind === "all" ? [[e0, null, t], [e0, null, null, t]] : [[e0, null, w(NATIVE), t], [e0, null, w(weth), t], [e0, null, t, w(weth)]];
    // an answer at the cap may be one the provider cut there (review of 4830f1f, L)
    const fine = (rs: unknown[]) => rs.every((r) => Array.isArray(r) && r.length < SCAN_MAX_LOGS);
    const p = pin;
    // every request also asks for its own last block in its batch, and its logs count only where the provider holds it
    // (card evm-scan-second-provider; review of 22e29c9, B2: a check on the request up to the head alone let its halves
    // and the second's spans below it count a lagging backend's [] as read). Past its head, rpc.mainnet.chain.robinhood.com
    // answers a getLogs [] with no error, so a backend behind another's head reads as blocks with no pools; publicnode
    // and bloXroute answer -32602 and daybreak -32000 (the review's reads, 2026-11-05 17:42-17:44Z)
    const top = p === null;
    const calls = [...filters.map(f), { method: "eth_getBlockByNumber", params: ["0x" + (p === null ? b : p.number).toString(16), false] }];
    // a provider that answers it holds no such block (null: not yet) is asked again whole, as a failure: its next try
    // may reach a backend that does; one with another behind it passes the request to the next at once. Any other
    // answer without the block counts as an answer with no logs (logsOf)
    const rpc: EvmRpc = !top
      ? on.rpc
      : async (cs, signal) => {
          const out = await on.rpc(cs, signal);
          const h = (out[filters.length] as { result?: unknown } | null)?.result;
          if (Array.isArray(out) && h === null && !out.some(limited)) {
            const m = `the scan provider does not hold block ${b} yet`;
            throw on.next !== undefined ? new ScanRefused("rpc_error", m) : new NotHeldYet("rpc_error", m);
          }
          return out;
        };
    // the logs' answers, and where pinned, a refusal unless the batch's provider holds the agreed block; null where the
    // request is the newest and its provider answered no block for it: a lag, as a null is (NotHeldYet)
    const logsOf = (out: readonly unknown[]): unknown[] | null => {
      const h = (out[filters.length] as { result?: { hash?: unknown } | null } | null)?.result;
      if (p !== null) {
        if (typeof h?.hash !== "string" || lower(h.hash) !== p.hash) return refuse("rpc_disagree", `the scan provider's logs are not read at the agreed block ${p.number}`);
      } else if (top && typeof h?.hash !== "string") return null;
      return out.slice(0, filters.length).map((x) => (x as { result?: unknown } | null)?.result);
    };
    const keep = (rs: unknown[]) => got.push(...rs.map((r) => ({ part, a, b, logs: r as unknown[] })));
    const halves = (left: number) => {
      const mid = a + Math.floor((b - a) / 2);
      return settle([one({ part, a, b: mid, on }, left), one({ part, a: mid + 1, b, on }, left)]);
    };
    // The provider's own answer short of every log (an error in any words, or in its data alone; an HTTP status other
    // than 429 or 5xx; a body that is not a batch or past its size; SCAN_MAX_LOGS logs) is asked as its halves on that
    // provider, down to one block, its splits left as they were, and never goes to the next: no error's words are read,
    // and a spare never reads alone what the first answered (review of 1277e8af, MEDIUM-A and C: a flood of made-up
    // pools in words the scan did not know handed the spare the real pool's blocks). The made-up pools are then read
    // and dropped with the quote's state reads, as any pool; past EVM_QUOTE_MAX_KEYS of them the quote refuses
    // too_many_pools. One block whose logs its provider still does not answer refuses too_many_pools: no request can
    // read that block's pools. A long run of halves ends at the quote's bound (rpc_error).
    const short = () => {
      if (b > a) {
        shorts += 2;
        if (shorts > shortMax) throw new ScanStop("rpc_error", "the scan provider answered errors past an honest split");
        return halves(splits);
      }
      throw new ScanStop("too_many_pools", `the scan provider answers no logs of block ${a}: it holds more pools than a request returns`);
    };
    // a transport failure (HTTP 5xx, a refused connection, a timeout, a lag) of a cold request of more than SCAN_ALONE
    // blocks, where another provider follows, is asked as its halves on this one, its splits left as they were, before
    // the next has any of it (SCAN_ALONE)
    const alone = !fast && on.next !== undefined && b - a + 1 > SCAN_ALONE;
    // the smallest span: asked with its tries, a transport failure then goes to the next (run) or refuses
    const last = splits === 0 || b === a;
    let answered = false;
    let notYet = false;
    const rs = await on.gate.ask(rpc, calls, last ? SCAN_TRIES : 1, fast).then(logsOf, (e) => {
      if (e instanceof ScanAnswered) {
        answered = true;
        return null;
      }
      if (e instanceof ScanStop || (e instanceof ScanRefused && !alone) || last) throw e;
      notYet = e instanceof NotHeldYet;
      return null;
    });
    if (rs !== null && fine(rs)) return void keep(rs);
    // a warm scan's request one failed in any way goes to the next whole, as before: halves help a span too long for
    // its time or its logs, never a warm one (card evm-scan-second-provider: Robinhood's first answering no logs held a
    // warm quote 9.5 to 11 s, 61 halves through its 2 at once, 2026-11-05 17:3xZ); its blocks are one round of the
    // next's requests at most, the newest, which M382 lets a spare read alone
    if (fast && on.next !== undefined) throw new ScanRefused("rpc_error", "the scan provider answered no logs");
    if (answered || rs !== null) return short();
    if (alone) return halves(splits);
    // one whose last block the provider does not hold yet is asked again whole, its tries left (NotHeldYet)
    if (notYet) {
      const again = logsOf(await on.gate.ask(rpc, calls, SCAN_TRIES - 1, fast));
      if (again === null) return refuse("rpc_error", "the scan provider answered no logs");
      if (!fine(again)) return short();
      return void keep(again);
    }
    // one that ran out of time or failed otherwise: its two halves (a throttled one is asked again whole by the gate;
    // past the scan's bound each half refuses before it is sent)
    if (!last) return halves(splits - 1);
    return refuse("rpc_error", "the scan provider answered no logs");
  };
  // every request runs to its end, so each span that comes back is kept, and the first failure is thrown after
  const settle = async (ps: Promise<void>[]) => {
    const failed = (await Promise.allSettled(ps)).find((r) => r.status === "rejected");
    if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
  };
  // A request a provider failed in any way (a refused connection; in a warm scan, no answer or a throttle's hold past
  // EVM_SCAN_HOLD_MS; its tries spent; an answer with no logs, or one without its last block) is asked of the next
  // provider in the chain's list for the blocks that did not come back, in that one's own spans, and so on down the
  // list; the quote refuses only where the last fails them too (cards evm-scan-second-provider, evm-rpc-spare-list: on
  // 5 Nov Base's first and second were both down about 10 minutes). All read the same blocks of the same PoolManager:
  // a scan only adds pools, each read on both quote providers like any candidate.
  const run = (j: Job): Promise<void> =>
    one(j).catch(async (e) => {
      const next = j.on.next;
      if (next === undefined || e instanceof ScanStop) throw e;
      let done: Spans = [];
      for (const g of got) if (g.part === j.part && g.a >= j.a && g.b <= j.b) done = withSpan(done, g.a, g.b);
      const rest: Job[] = [];
      for (const [a, b] of gapsOf(done, j.a, j.b)) jobsOf(j.part, a, b, next, rest);
      shortMax += 2 * rest.length;
      await settle(rest.map(run));
    });
  const kept = new Set<object>();
  const take = () => {
    for (const g of got) {
      if (kept.has(g)) continue;
      kept.add(g);
      found(g);
    }
  };
  // the spans that came back, kept where the scan provider's head is within maxLag of the agreed block (a head named
  // past it never keeps a span, review of 5452011, S2)
  const commit = () => {
    take();
    for (const e of each) {
      for (const g of got) if (g.part.includes(e)) e.spans = withSpan(e.spans, g.a, g.b);
      if (!SCANS.has(e.key) && SCANS.size >= SCAN_TOKENS) SCANS.delete(SCANS.keys().next().value!);
      SCANS.set(e.key, { spans: e.spans, pools: e.pools });
    }
  };
  const failing = async (e: unknown, at?: Block): Promise<never> => {
    try {
      const b = at ?? (await picked());
      if (scanHead - b.number <= maxLag) commit();
    } catch {
      // no agreed block: nothing is kept
    }
    throw e;
  };
  await settle(jobs.map(run)).catch((e) => failing(e));
  const agreedAt = await agreed();
  const b = agreedAt.number;
  if (scanHead - b > maxLag) return refuse("rpc_disagree", `the scan provider's head ${scanHead} is more than ${maxLag} blocks past the agreed block ${b}`);
  if (b - scanHead > maxLag) {
    // the scan outlasted maxLag blocks: on from the block after the head up to the agreed block, which the provider
    // answering each request must hold, by hash, in that request's own batch (`pin`; review of 4830f1f, H1: a backend
    // behind it answers [] past its own head with no error, and a head named on another backend proves nothing about
    // the one answering the logs); never further than one span a request (review of 4830f1f, L: a head of 0x1 fanned
    // out into about 10^4 requests)
    if (b - scanHead > BigInt(s.span)) return refuse("rpc_disagree", `the scan provider's head ${scanHead} is more than ${s.span} blocks behind the agreed block ${b}`);
    const end = Number(b);
    pin = agreedAt;
    jobs.length = 0;
    jobsOf(each, head + 1, end);
    shortMax += 2 * jobs.length;
    await settle(jobs.map(run)).catch((e) => failing(e, agreedAt));
  }
  function found({ part, a, b, logs }: (typeof got)[number]) {
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
  take();
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
  const banned = req.banned;
  const asked: EvmPoolBuyQuoteRequest = { chain: req.chain, token: req.token, amountIn: req.amountIn, slippageBps: req.slippageBps, route: req.route, ...(pools === undefined ? {} : { pools }), ...(banned === undefined ? {} : { banned }) };
  const { chain } = asked;
  const v = venue(chain);
  const p = v.providers;
  if (p === undefined) return refuse("no_quoter", `${chain} has no pinned providers`);
  let watch = WATCHES.get(chain);
  if (watch === undefined) WATCHES.set(chain, (watch = evmHeadWatch(() => evmProviders(evmRanked(p), fetch), v.maxLag)));
  // a scan's answer is a list of logs, bounded by the scan provider's own cap per request (16 MiB read at most)
  return evmPoolBuyQuoteWith(asked, evmProviders(evmRanked(p), fetch), Date.now(), scansOf(v.scan), watch);
}

// Each pinned provider's measured speed (card evm-quote-warm-round): its time to answer a batch, an average that weighs
// the newest a quarter, and, after a failure (no answer, a 429, a call's error naming a rate limit), the time until
// which it is asked only after every other. A quote asks the providers in this order, so its two are the fastest that
// answer, and the rest are its spares (agreeing).
// A provider with a request out for longer than EVM_HEDGE_MS is ranked with the held until it answers: the next quote
// does not wait on it either.
const SPEED = new Map<string, { ms: number | null; held: number; out: number[] }>();
export const EVM_HOLD_MS = 30_000;
/** Forgets every provider's measured time and hold: for the tests, which share this module's state (not in the index). */
export const evmSpeedReset = (): void => SPEED.clear();
const speedOf = (url: string) => {
  const s = SPEED.get(url) ?? { ms: null, held: 0, out: [] };
  SPEED.set(url, s);
  return s;
};
const timed = (url: string, rpc: EvmRpc): EvmRpc => {
  const f: EvmRpc = async (calls) => {
    const t = performance.now();
    const s = speedOf(url);
    s.out.push(t);
    try {
      const out = await rpc(calls);
      // an answer that names a rate limit or a state the provider does not hold is held, never measured: such an error
      // comes back fast, and a provider past its state cut kept first by it failed every quote's reads (card
      // evm-quote-lag-held)
      if (out.some(limited) || out.some(stateless)) s.held = performance.now() + EVM_HOLD_MS;
      // an answer for a block the provider does not hold yet is no measure of its speed (re-review INFO 4)
      else if (!out.some(notYet)) s.ms = s.ms === null ? performance.now() - t : s.ms * 0.75 + (performance.now() - t) * 0.25;
      return out;
    } catch (e) {
      s.held = performance.now() + EVM_HOLD_MS;
      throw e;
    } finally {
      s.out.splice(s.out.indexOf(t), 1);
    }
  };
  HOLD.set(f, () => void (speedOf(url).held = performance.now() + EVM_HOLD_MS));
  return f;
};
/** `urls` in the order a quote asks them: those neither held nor with a request out past EVM_HEDGE_MS by their
 *  measured time (the unmeasured after them, in the venue list's order), then those with a request out, then the held,
 *  each in the same order. */
export function evmRanked(urls: readonly string[], now: number = performance.now()): string[] {
  const rank = (u: string, k: number) => {
    const s = SPEED.get(u);
    const slow = s === undefined ? 0 : s.held > now ? 2 : s.out.some((t) => now - t > EVM_HEDGE_MS) ? 1 : 0;
    return [slow, s?.ms ?? Number.MAX_VALUE, k] as const;
  };
  return urls
    .map((u, k) => ({ u, r: rank(u, k) }))
    .sort((x, y) => x.r[0] - y.r[0] || x.r[1] - y.r[1] || x.r[2] - y.r[2])
    .map((e) => e.u);
}

/** Providers from https URLs on different hosts, at least two, each timed for evmRanked. */
export function evmProviders(urls: readonly string[], fetchFn: typeof fetch): EvmRpc[] {
  if (!Array.isArray(urls) || urls.length < 2) return refuse("bad_request", "two provider URLs at least");
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
  if (new Set(hosts).size !== hosts.length) return refuse("bad_request", "two providers are on one host");
  return urls.map((u) => timed(u, evmJsonRpc(u, fetchFn)));
}

/** What every quote checks before any read, buy or sell: the device's clock, two different providers, the amount in
 *  and the slippage. */
function checkAsk(nowMs: number, rpcsIn: unknown, amountIn: unknown, slippageBps: unknown): void {
  if (!Number.isFinite(nowMs)) return refuse("bad_request", "the device's clock");
  if (!Array.isArray(rpcsIn) || rpcsIn.length < 2 || rpcsIn.some((r) => typeof r !== "function") || new Set(rpcsIn).size !== rpcsIn.length) {
    return refuse("bad_request", "two different providers");
  }
  if (typeof amountIn !== "bigint" || amountIn <= 0n || amountIn >= MAX_IN) return refuse("bad_request", "the amount in is above 0 and below 2^127");
  if (!Number.isInteger(slippageBps) || (slippageBps as number) < 0 || (slippageBps as number) >= 10000) return refuse("bad_request", "the slippage is 0 to 9,999 bps");
}

/** The two providers, every request of a quote to each (its head, its block's confirmation and its reads) at most the
 *  scan provider's limit at once: on each chain one of the two providers is the scan provider's host (Base's publicnode
 *  takes 20 at once, Robinhood's own RPC answers 429 to 4). */
function gated(rpcsIn: readonly EvmRpc[], parallel: number, deadline?: Deadline): readonly EvmRpc[] {
  // past the quote's deadline no request leaves the gate: the quote refuses stale_quote (card evm-buy-quote-ends-on-node)
  const past = () => {
    if (deadline !== undefined && deadline.now() > deadline.until) refuse("stale_quote", `the quote's block is more than ${EVM_QUOTE_MAX_AGE_MS / 1000} s old: no more reads are sent`);
  };
  const list = rpcsIn.map((rpc) => {
    const g = gateOf(parallel);
    // stalled: requests out and none answered for 4 x EVM_HEDGE_MS (agreeing moves a request queued behind them)
    let flying = 0;
    let lastAt = 0;
    const out = async (calls: readonly EvmRpcCall[]) => {
      if (flying++ === 0) lastAt = performance.now();
      try {
        return await rpc(calls);
      } finally {
        flying--;
        lastAt = performance.now();
      }
    };
    const f = (calls: readonly EvmRpcCall[]) => g(() => (past(), out(calls)));
    GATED.set(f as unknown as EvmRpc, (calls, gate) =>
      g(() => {
        if (gate?.moved() === true) return Promise.reject(MOVED);
        past();
        gate?.sent();
        return out(calls);
      }),
    );
    STALLED.set(f as unknown as EvmRpc, () => flying > 0 && performance.now() - lastAt > 4 * EVM_HEDGE_MS);
    const hold = HOLD.get(rpc);
    if (hold !== undefined) HOLD.set(f as unknown as EvmRpc, hold);
    return f;
  }) as unknown as readonly EvmRpc[];
  if (deadline !== undefined) DEADLINE.set(list, deadline);
  return list;
}
/** A quote's deadline on its gated providers: the device's clock now, and the time past which no request is sent, set
 *  once the block is agreed to that block's time plus EVM_QUOTE_MAX_AGE_MS (routeSet). Every quote past it is refused
 *  stale_quote when made (quoted.ts), so a read sent after it is load on the providers for nothing: a cold Robinhood
 *  quote went on asking its providers until it ended rpc_error 51 s in (2026-11-08 11:0xZ). */
type Deadline = { until: number; readonly now: () => number };
const DEADLINE = new WeakMap<readonly EvmRpc[], Deadline>();

/** The reads at the agreed block's hash and that block's confirmation in one round; the confirmation is judged first,
 *  so nothing read is used before it passes. */
async function readAgreed(confirm: () => Promise<void>, rpcs: readonly EvmRpc[], hash: string, reads: readonly Read[], lim: ReadLimits): Promise<Answer[]> {
  const [confirmed, read] = await Promise.allSettled([confirm(), readBoth(rpcs, hash, reads, lim)]);
  if (confirmed.status === "rejected") throw confirmed.reason;
  if (read.status === "rejected") throw read.reason;
  return read.value;
}

/** The chain's scan providers as the device asks them: the first and, where pinned, the spares in order (cards
 *  evm-scan-second-provider, evm-rpc-spare-list); a scan's answer is a list of logs, bounded by the provider's own cap
 *  per request (16 MiB read at most). */
const scansOf = (s: EvmPoolVenue["scan"]): EvmRpc[] | undefined =>
  s === undefined ? undefined : [s.url, ...(s.spares ?? []).map((x) => x.url)].map((u) => evmJsonRpc(u, fetch, 16 << 20));

/** evmPoolBuyQuote on the providers `rpcs`, with the device's clock at `nowMs`: what the kit's index exports runs this
 *  with the pinned providers and Date.now(); the tests run it on recorded and planted answers. Not in the index. */
export async function evmPoolBuyQuoteWith(req: EvmPoolBuyQuoteRequest, rpcsIn: readonly EvmRpc[], nowMs: number, scan?: EvmRpc | readonly EvmRpc[], watch?: EvmHeadWatch, mono: () => number = monotonic): Promise<EvmPoolBuyQuote> {
  const start = mono();
  if (typeof req !== "object" || req === null) return refuse("bad_request", "the request is an object");
  const { chain, token, amountIn, slippageBps } = req;
  checkAsk(nowMs, rpcsIn, amountIn, slippageBps);
  const route = copyRoute(req.route);
  // hook data is the device's own, and the device makes none, as on the sell (card evm-buy-hookdata-fee): a route that
  // carries any, as a helper's might, is refused before any read, so before any signature
  if (route.venue === "uniswap-v4" && route.hops.some((h) => h.hookData !== "0x")) return refuse("bad_request", "a buy's hook data is the device's own: empty");
  if (!isAddress(token) || lower(token) === NATIVE) return refuse("bad_request", "the token is not an address");
  const v = venue(chain);
  const rpcs = gated(rpcsIn, v.scan?.parallel ?? 2, { until: Infinity, now: () => nowMs + Math.max(0, mono() - start) });
  const { token: buys } = evmPoolRouteDataQuoted(chain, route);
  if (lower(buys) !== lower(token)) return refuse("token_mismatch", `the route buys ${buys}, not ${token}`);
  // the pools this device banned for the token, the sale's and the buy's alike (card evm-buy-hook-converge)
  const banned = bannedOf(req.banned);

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
  // evm-route-parity; review of evm-sell-device-quote, H1), a hook the venue does not list included, as the sell takes
  // one on the route its own quote picks and on the route the note was bought through (card evm-buy-hook-converge)
  if (!evmSellExits(chain, token, route, true)) return refuse("no_exit", "the sell could not leave through the pools this route buys through");
  const noopOf = (hs: readonly string[]) => Object.fromEntries(hs.map((h) => [h, { code: EVM_NOOP_HOOK_CODE }]));
  const hookless = hooks.length > 0 ? at(route, amountIn, noopOf(hooks)) : -1;
  // The route's pools behind a hook the venue does not list (card evm-buy-hook-converge): such a hook may quote the
  // quoter more than its pool pays, so the route counts at the lowest of Q and its quotes with each set of such hooks
  // replaced, every set (at most 15: a route is at most EVM_POOL_MAX_HOPS hops), so no number of hostile hooks hides its
  // extra behind another's visible fee (review of 72e28658, M1: each alone covered one liar, not two)
  const keys = route.venue === "uniswap-v4" ? hopKeys(route) : [];
  const hookedKeys = keys.filter((k) => k.hooks !== NATIVE && !evmHookListed(chain, k.hooks, k.fee, k.tickSpacing));
  const unlisted = [...new Set(hookedKeys.map((k) => k.hooks))].sort();
  const lows = subsetsOf(unlisted).map((hs) => (hs.length === hooks.length ? hookless : at(route, amountIn, noopOf(hs))));
  // The pool's swap gas (audit I-4): the route's own swap, run as the pool runs it, is read in the first round
  const fitReads = new Map<EvmRoute, Read | null>();
  let fitAt = "";
  const fitOf = (r: EvmRoute) => {
    if (!fitReads.has(r)) fitReads.set(r, fitRead(chain, v, r, amountIn, fitAt));
    return fitReads.get(r)!;
  };
  let ownFit = -1;
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
    seen: keys.map(poolId),
    banned,
    hints: req.pools,
    sell: false,
    watch,
    mono,
    start,
    // the route's own swap, at the agreed block (its recipient is the block's), in the first round
    atBlock: (b) => {
      fitAt = b.hash;
      if (fitOf(route) !== null) ownFit = reads.push(fitOf(route)!) - 1;
    },
    beforeFound: () => {
      if (v.nativeFirst && wethStart && v.v4 !== undefined && lower(firstOut) !== lower(token)) {
        for (const key of V4_KEYS) {
          const r = v4Direct(NATIVE, firstOut, key);
          firstHop.push({ at: at(r, amountIn), twice: at(r, 2n * amountIn) });
        }
      }
    },
    // the prune's floor is what the route counts for, the lowest of Q and its reads with unlisted hooks replaced: Q
    // alone is the hook's own answer, and a hook that quotes the quoter high would raise the floor past the token's
    // real market, which the prune then never quotes (review of 72e28658, H1). A read that answers nothing refuses
    // the quote below (review of a2d82dc6, F2), so it lowers nothing here
    floor: (out) => lows.reduce((m, i) => {
      const x = out(i);
      return x !== null && x > 0n && x < m ? x : m;
    }, out(main)!),
    // The route: a quote, and one that grows with its input
    firstRound: (out, answer) => {
      const q = out(main);
      const m = answer(main);
      if (m.kind === "revert" && m.partial) return refuse("partial_fill", "a hookless hop runs out of liquidity (NotEnoughLiquidity)");
      if (m.kind === "revert" && m.gas === true) return refuse("no_quote", `the route's quote runs out of its gas read alone (${EVM_READ_CALL_GAS} gas a call)`);
      if (q === null || q === 0n) return refuse("no_quote", "the route reverts or quotes nothing");
      const q2 = out(twice);
      if (q2 !== null && q2 <= q) return refuse("partial_fill", `twice the amount quotes ${q2}, not more than ${q}: a pool runs out`);
      // a v3 route has no hook: its quote at twice the amount reverts only when a pool cannot fill it. One whose read at
      // twice runs out of its gas alone (`gas`) is no revert (review of fe9f5ec3, finding 1): through one pool the 1x
      // read that answered within its gas filled whole, since a swap stopped at its price limit takes the 1x path at
      // twice and would answer within the same gas; through several, a hop's spam can hide another's partial fill
      const gas2 = (answer(twice) as { gas?: true }).gas === true;
      if (q2 === null && route.venue === "uniswap-v3" && gas2 && route.tokens.length > 2) return refuse("out_of_gas", "twice the amount runs out of a read's gas alone on a v3 route of more than one hop: its quote may be a partial fill");
      if (q2 === null && route.venue === "uniswap-v3" && !gas2) return refuse("partial_fill", "twice the amount reverts on a v3 route");
    },
  });
  const { block, out, fills, filled } = set;
  const q = out(main)!;
  // The routes of more than one v3 hop dropped because a read at twice ran out of its gas alone (`outOfGas`) may be
  // partial fills, so none prices the buy: each stands in every list a verdict is priced against, at its 1x, and a
  // verdict that one of them decides, as the best route that fits (bestFits), is refused by name (review of fe9f5ec3,
  // finding 1; delta review of 7904e159: against the raw best, a route above it that does not fit hid one that does)
  const hidden = new Set<Filled>(set.outOfGas);
  const ranOut = (c: Filled | null, what: string): void => {
    if (c !== null && [...hidden].some((h) => h.amountOut === c.amountOut && JSON.stringify(h.route) === JSON.stringify(c.route))) {
      return refuse("out_of_gas", `${what}, a route of ${c.route.venue === "uniswap-v3" ? c.route.tokens.length - 1 : 1} v3 hops quoting ${c.amountOut}, runs out of a read's gas alone at twice the amount: its quote may be a partial fill`);
    }
  };
  const priced = [...filled, ...hidden];
  // what the route counts for: Q, or through a hook the venue does not list the lowest of its reads, each with a set of
  // such hooks replaced (review of 72e28658, M1). Each must answer above 0, or the route is refused: one with every such
  // hook replaced that does not is a pool whose liquidity is in such a hook alone, priced by nothing the device can
  // bound; one with only some replaced that does not is a hook left in it reverting at an amount the hooks replaced
  // before it quoted, and a hostile hook sets its own raw output, so it can push an honest cap downstream past its
  // limit and leave out the very read that shows what the route pays (review of a2d82dc6, F2). The cost is a route
  // through an honest cap behind such a hook refused at quote time: no fee lost, nothing banned
  let value = q;
  for (const i of lows) {
    const x = out(i);
    if (x === null || x === 0n) return refuse("no_quote", "the route with a hook the venue does not list replaced reverts or quotes nothing");
    if (x < value) value = x;
  }

  // The pool's swap gas (audit I-4): the route is taken only where its swap fits EVM_BUY_SWAP_FIT, and every route
  // the quote names or prices it against (the reference, the best native route where WETH may not start, the best
  // through listed pools where the route has an unlisted hook) is the best that fits, so a route over the floor neither
  // sets a price no buy reaches nor is named to a caller who re-quotes it. The route's own swap was read in the first
  // round, so a reference that is the route itself, as a device's re-quote of its own best route is, costs no round.
  // The others are read at most two rounds more, never one route a round: each pool anyone seeds behind a hook that
  // checks the swap's sender and lets only the quoter through, priced above the route, would add a round to every quote, and some tens of them
  // would age every quote past EVM_QUOTE_MAX_AGE_MS (review of 498eae83, M2). The first asks, of each list whose best
  // is not known, every route that can change the verdict (`band`): the standard routes at or above the route's value
  // (all of them where the route does not fit), the native ones at or above it, the listed ones within the slippage of
  // it; a list still not known after it is asked whole in the second
  const fit = new Map<string, boolean>();
  if (ownFit >= 0) fit.set(reads[ownFit]!.data, out(ownFit) !== null);
  const fits = (r: EvmRoute) => {
    const x = fitOf(r);
    return x === null ? false : fit.get(x.data);
  };
  const bestFits = async (lists: readonly { l: readonly Filled[]; band: (c: Filled) => boolean }[]) => {
    for (let round = 0; ; round++) {
      const ask = new Map<string, Read>();
      for (const { l, band } of lists) {
        const b = best(l.filter((c) => fits(c.route) !== false));
        if (b === null || fits(b.route) !== undefined) continue;
        const unknown = l.filter((c) => fits(c.route) === undefined);
        const first = unknown.filter(band);
        for (const c of round === 0 && first.length > 0 ? first : unknown) ask.set(fitOf(c.route)!.data, fitOf(c.route)!);
      }
      if (ask.size === 0) return lists.map(({ l }) => bestOf(l.filter((c) => fits(c.route) === true)));
      const asked = [...ask.values()];
      const a = await readBoth(rpcs, block.hash, asked, v.reads);
      asked.forEach((r, i) => fit.set(r.data, a[i]!.kind === "out"));
    }
  };
  // the native routes count only where a WETH start must beat them (native_first below); a route that does not fit is
  // refused whatever they are
  const ownFits = fits(route) === true;
  const natives = ownFits && v.nativeFirst && wethStart ? priced.filter((c) => startsNative(c.route)) : [];
  const exits = ownFits && unlisted.length > 0 ? priced.filter((r) => evmSellExits(chain, token, r.route)) : [];
  const all = () => true;
  const fitted = await bestFits([
    { l: [{ route, amountOut: value }], band: all },
    { l: priced, band: ownFits ? (c) => c.amountOut >= value : all },
    { l: natives, band: (c) => c.amountOut >= value },
    { l: exits, band: (c) => c.amountOut * 10000n >= value * BigInt(10000 - slippageBps) },
  ]);
  const own = fitted[0] ?? null;
  const reference = fitted[1] ?? null;
  const nativeBest = fitted[2] ?? null;
  const listed = fitted[3] ?? null;
  if (own === null) {
    return refuse("over_gas_floor", `the route's swap does not run in ${FIT_TEXT}${reference === null ? ", and no route does" : ""}`, reference);
  }
  if (reference === null && filled.length > 0) return refuse("over_gas_floor", `no standard pool's route runs its swap in ${FIT_TEXT}`, null);

  const nativeExists = v.nativeFirst && (natives.some((c) => fits(c.route) === true) || firstHop.some((c) => fills(c)));
  // R is the best of every pool, whatever it starts from: a native pool someone seeded is held to the token's WETH
  // pools too (a launchpad's, on Robinhood). Where a native pool exists a route starts native unless it quotes strictly
  // more than the best native route (native when at least as good); the native_first refusal names that native route.
  // A native pool of the first hop alone, with no native route to the token quoted, still refuses: nothing shows the
  // WETH start beats starting that hop native
  if (nativeExists && wethStart && nativeBest !== null && value <= nativeBest.amountOut) ranOut(nativeBest, "the best native route");
  if (nativeExists && wethStart && (nativeBest === null || value <= nativeBest.amountOut)) {
    return refuse("native_first", `${chain}'s WETH is behind an upgradeable proxy and a native route quotes at least as much`, nativeBest);
  }
  if (reference === null) return refuse("no_reference", "no standard pool and no pinned launchpad pool answers for the token");
  // a pool this device banned is no route at all (card evm-buy-hook-converge): the caller may quote the reference
  if (keys.some((k) => banned.has("0x" + poolId(k)))) return refuse("below_reference", "the route goes through a pool this device banned", reference);
  // Through a hook the venue does not list, the reference may sit at a price no buy reaches (a hook that honours only
  // some blocks, or reverts the real buy), and the buy's own route is refused unless it beats it: a route through listed
  // pools within the slippage of such a reference is taken, at its own minOut, so such a pool freezes no buy;
  // a route through such a hook is taken only where no route through listed pools is within the slippage of it, and
  // where its real buy reverts the caller bans its pools (`hooked`, evmBuyRevertedPools) and the next quote leaves it
  // out (card evm-buy-hook-converge, the sale's take-and-ban)
  const near = (x: bigint, r: bigint) => x * 10000n >= r * BigInt(10000 - slippageBps);
  const hookedRef = hookedRoute(chain, reference.route);
  const underHooked = value < reference.amountOut && hookedRef && unlisted.length === 0 && near(value, reference.amountOut);
  if (value < reference.amountOut) ranOut(reference, "the best route that fits");
  if (value < reference.amountOut && !underHooked) {
    return refuse("below_reference", `the route quotes ${value}, below the standard pool's ${reference.amountOut}`, reference);
  }
  if (unlisted.length > 0) {
    if (listed !== null && near(listed.amountOut, value)) ranOut(listed, "the best route through listed pools within the slippage");
    if (listed !== null && near(listed.amountOut, value)) return refuse("below_reference", `a route through listed pools quotes ${listed.amountOut}, within the slippage of the route's ${value} through a hook the venue does not list`, listed);
  }

  let hook: EvmHookTake | null = null;
  if (hookless >= 0) {
    const h = out(hookless);
    const take = h === null ? null : h > q ? h - q : 0n;
    hook = Object.freeze({ hookless: h, take, takeBps: h === null || take === null || h === 0n ? null : Number((take * 10000n) / h) });
  }
  // the slippage off what the route counts for. A route below a reference is refused unless that reference is through
  // a hook the venue does not list (underHooked), and such a reference never sets minOut: its hook places its own quote,
  // so a quote at value / (1 - slippage) would set minOut to the route's whole value, a buy with no slippage left that
  // reverts on any move and leaves nothing to ban (review of 72e28658, M2)
  const minOut = (value * BigInt(10000 - slippageBps)) / 10000n;
  if (minOut === 0n) return refuse("no_quote", "the route quotes too little to set a minimum above 0");
  const hooked = Object.freeze(hookedKeys.map((k) => "0x" + poolId(k)));
  const quote: EvmPoolBuyQuote = Object.freeze({ chain, token, amountIn, route, block: Object.freeze(block), amountOut: value, minOut, reference, hook, hooked });
  QUOTED.add(quote);
  return quote;
}

/** True for a v4 route through a pool behind a hook the venue does not list. */
const hookedRoute = (chain: EvmPoolChain, r: EvmRoute) => r.venue === "uniswap-v4" && hopKeys(r).some((k) => k.hooks !== NATIVE && !evmHookListed(chain, k.hooks, k.fee, k.tickSpacing));

/** Every non-empty subset of `xs`, smallest first, each in `xs`'s order: a route's hooks (at most EVM_POOL_MAX_HOPS,
 *  so at most 15 subsets). */
function subsetsOf<T>(xs: readonly T[]): T[][] {
  const all: T[][] = [];
  for (let m = 1; m < 1 << xs.length; m++) all.push(xs.filter((_, i) => (m >> i) & 1));
  return all.sort((a, b) => a.length - b.length);
}

type Filled = { route: EvmRoute; amountOut: bigint };
const best = (xs: readonly Filled[]) => xs.reduce<Filled | null>((m, c) => (m === null || c.amountOut > m.amountOut ? c : m), null);
const bestOf = (xs: readonly Filled[]) => {
  const b = best(xs);
  return b === null ? null : Object.freeze({ amountOut: b.amountOut, route: copyRoute(b.route) });
};

/** True when W can sell `token` back through the pools `route` buys through: the same pools backwards, as the sell
 *  builder takes them (trade/evm/sell-unpinned.ts evmSellRouteCheck; `anyHook`: a v4 hop's hook any, as the builder
 *  takes it on a route the device's sell quote picked, card evm-sell-hook-converge). */
function evmSellExits(chain: EvmPoolChain, token: string, route: EvmRoute, anyHook = false): boolean {
  try {
    evmSellRouteCheck(chain, token, evmSellRouteOf(route), anyHook);
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
 *  chain pins a sell delegate and the helper's sell sender it counts at no more than an eth_call of the exact trade from
 *  W pays, sent as the sale is sent (simmedSells: from the sender, with the sale's gas and fees, so a
 *  hook cannot tell the sim from the sale by tx.gasprice, tx.origin, msg.sender or its gas; review of the exec sim,
 *  HIGH 1) ("sim"); where it pins either not (none of the four since card pool-evm-deploy-mainnet pinned the mainnets'
 *  delegates), or where the pinned sender cannot pay for the sim (simmedSells: the sim is skipped, never the route), it
 *  keeps the lower of its quote with the hook replaced and as it is ("keep-min"), which refuses rather than
 *  signs at a seeded price. The freeze a hook that lets only the quoter trade can put on a token's trades (probe PE)
 *  therefore lasts on such a chain until both are pinned. A requested buy through such a hook counts at the lowest of
 *  its quote and its quotes with such hooks replaced, and is taken only where no route through listed pools is within
 *  the slippage of it; where its real buy reverts, its pools are banned (card evm-buy-hook-converge). */
function simRule(chain: EvmPoolChain, route: EvmRoute, pins: Pick<Venue, "sellDelegate" | "sellSender">): "quoter" | "sim" | "keep-min" {
  if (route.venue !== "uniswap-v4" || hopKeys(route).every((k) => k.hooks === NATIVE || evmHookListed(chain, k.hooks, k.fee, k.tickSpacing))) return "quoter";
  return pins.sellDelegate !== undefined && pins.sellSender !== undefined ? "sim" : "keep-min";
}

const SEL_NONCE = "affed0e0"; // SellDelegate.nonce()
/** The sim pool's code: CALLVALUE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN, so sell() returns what W gained. */
const SIM_POOL_CODE = "0x3460005260206000f3";
/** W's code in a sim: the 7702 designator of the chain's pinned sell delegate, as on chain (test/evm-sim-facts.test.ts:
 *  every pinned provider runs the delegate in W's own context). */
const designator = (delegate: string) => "0xef0100" + lower(delegate).slice(2);
/** A JSON-RPC quantity: 0x and its hex digits, no leading zero. */
const qty = (v: bigint) => "0x" + v.toString(16);

/** The sell routes in `routes` as W's own sell through them pays (simRule "sim"), from an eth_call of it at the agreed
 *  block on both providers: each such route above `floor` is simmed once, with minOut one wei above the floor, and
 *  counts at the lower of its keep-min value and what W gains in the sim (SIM_POOL_CODE returns it); one whose sim
 *  reverts, W gaining no more than the floor, is dropped. So a hook that lets only the quoter trade is dropped and
 *  freezes no sell, and a hook that pays W's sale less than its quotes counts at what W gets, never dropped for any
 *  shortfall: dropping the token's real market let a seeded pool beside it set the price W signs (card
 *  evm-sell-unfunded-sim-keeps-route; review of 1c31d81a, M1). W's nonce is read at the block; each sim is its own
 *  eth_call (one call's state would carry into the next). Each call, the nonce read too, is sent as the helper sends the
 *  sale: from the pinned sell sender (tx.origin and W's msg.sender), with the sale's gas less its authorization's
 *  intrinsic cost (the gas the sale's execution is given), maxPriorityFeePerGas the sale's tip and maxFeePerGas the
 *  agreed block's base fee plus it (tx.gasprice and BASEFEE as the sale's at that base fee). The sender's balance is
 *  its own at the block, never overridden: where it is too low to pay the sim's gas, or its read does not answer, the
 *  sim is skipped and every route stays at what routeSet counts it for, the lower of its quote with the hook replaced
 *  and as it is ("keep-min"), as on a chain that pins no sender, so no route is dropped for the sender's funding
 *  (review a42f9c16, Low 1). `sim`: "ran" where the sim ran, "skipped" where a route through such a hook above the
 *  floor was priced without it (the sender too low, or no sell delegate or sender pinned), "none" where no route
 *  needed it. */
async function simmedSells(chain: EvmPoolChain, pins: Pick<Venue, "sellDelegate" | "sellSender">, rpcs: readonly EvmRpc[], block: Block, w: string, token: string, amountIn: bigint, routes: Filled[], floor: bigint, signSim: EvmPoolSellQuoteRequest["signSim"]): Promise<{ routes: Filled[]; sim: EvmSellSimRun }> {
  const hooked = routes.filter((r) => r.amountOut > floor && simRule(chain, r.route, pins) !== "quoter");
  if (hooked.length === 0) return { routes, sim: "none" };
  // a chain that pins no sell delegate or sender sims nothing: each such route counts at keep-min, unsimmed
  const toSim = hooked.filter((r) => simRule(chain, r.route, pins) === "sim");
  if (toSim.length === 0) return { routes, sim: "skipped" };
  if (typeof signSim !== "function") return refuse("bad_request", "a route through a hook the venue does not list needs a sim sell W signs (signSim)");
  if (block.baseFeePerGas === null) return refuse("rpc_error", `block ${block.number} has no base fee: the sim cannot be priced as the sale`);
  const [delegate, sender] = [pins.sellDelegate, pins.sellSender!];
  const tip = evmPoolSellTip(chain);
  const gas = EVM_POOL_SELL_GAS - EVM_7702_AUTH_GAS;
  const maxFee = block.baseFeePerGas + tip;
  const tx: SimTx = { from: sender, gas: qty(gas), maxFeePerGas: qty(maxFee), maxPriorityFeePerGas: qty(tip) };
  const asW = { [lower(w)]: { code: designator(delegate!) } };
  // the sender's own balance at the block (Multicall3.getEthBalance, both providers agreeing): an eth_call it cannot pay
  // for is a node's error, not a revert ("insufficient funds for gas * price + value"), so where the sender is too low
  // to pay the sim's gas the sim cannot run: it is skipped and every route keeps its keep-min value, never dropped, never
  // a refusal
  const lim = venue(chain).reads;
  const [bal] = await readBoth(rpcs, block.hash, [{ to: lower(MULTICALL3), data: "0x" + SEL_ETH_BALANCE + sender.slice(2).toLowerCase().padStart(64, "0") }], lim);
  if (bal!.kind !== "out" || bal!.amountOut < gas * maxFee) return { routes, sim: "skipped" };
  const [n] = await readBoth(rpcs, block.hash, [{ to: lower(w), data: "0x" + SEL_NONCE, override: asW, tx }], lim);
  if (n!.kind !== "out") return refuse("no_quote", "W's sell nonce does not read through the sell delegate");
  const reads: Read[] = toSim.map((r) => {
    const s = evmSellRouteOf(r.route) as EvmV4SellRoute;
    const sim = evmPoolBuildSimSellUnpinned(chain, { w, token, amount: amountIn, hops: s.hops, minOut: floor + 1n, nonce: n!.amountOut, deadline: block.timestamp });
    const sig = signSim(sim, block.timestamp);
    return { to: lower(w), data: evmSellCallData(sim, 0n, sig), override: { ...asW, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } }, tx };
  });
  const ans = await readBoth(rpcs, block.hash, reads, lim);
  const kept: Filled[] = [];
  for (const r of routes) {
    const i = toSim.indexOf(r);
    if (i < 0) kept.push(r);
    else {
      // what W gains in the sim, at most the route's keep-min value; a sim that reverts or gains no more than the floor
      // (the sim's own minOut refuses it) drops the route
      const a = ans[i]!;
      if (a.kind === "out" && a.amountOut > floor) kept.push(a.amountOut < r.amountOut ? { route: r.route, amountOut: a.amountOut } : r);
    }
  }
  return { routes: kept, sim: "ran" };
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
  rpcs: readonly EvmRpc[];
  /** the scan providers, the chain's ordered list: the first, then the spares the scan goes on at in turn (cards
   *  evm-scan-second-provider, evm-rpc-spare-list) */
  scan: EvmRpc | readonly EvmRpc[] | undefined;
  /** the caller's own reads of the first round, before the set's */
  reads: Read[];
  /** a sell's `bought` route (one the sell builder takes), read like a route the device made from found pools */
  bought?: EvmRoute | undefined;
  /** pool ids the set leaves out */
  seen: readonly string[];
  /** a sell's banned pools (card evm-sell-hook-converge), PoolIds 0x and 64 lower-case hex digits: never a pool of any
   *  route, a market of X or Y, nor a pool of X with Y, so no pick among X's markets or the token's pools with X falls
   *  on one and shadows the rest (review of 919742f5, F1) */
  banned?: ReadonlySet<string>;
  /** the caller's list of pools (never trusted) */
  hints: unknown;
  /** quote each route backwards, from the token */
  sell: boolean;
  /** the chain's held head (card evm-quote-head-watch) */
  watch?: EvmHeadWatch | undefined;
  /** the lowest block the set reads at (a sell's buy's block; agreedBlock waits for it); a held head (the buy's) has none */
  minBlock?: bigint;
  /** tests only: the monotonic clock agreedBlock's wait and age run on (performance.now) */
  mono?: (() => number) | undefined;
  /** `mono` at the quote's entry, where `nowMs` was read: a new agreed block's age counts every ms since */
  start: number;
  /** the caller's reads after the standard pools' (the buy's first-hop reads, in the order its recorded reads hold) */
  beforeFound?: () => void;
  /** called once the block is agreed, before the first round's reads are sent: the caller's reads of that block */
  atBlock?: (block: Block) => void;
  /** the caller's refusals on the first round's answers, before any later round */
  firstRound?: (out: (i: number) => bigint | null, answer: (i: number) => Answer) => void;
  /** what a route must give to matter, read once the first round is in (the buy's own route's Q): a pool that cannot
   *  give it is never quoted (see "The prune"); none for the sell */
  floor?: (out: (i: number) => bigint | null) => bigint;
}): Promise<{ block: Block; out: (i: number) => bigint | null; fills: (c: { at: number; twice: number; route?: EvmRoute }, v3?: boolean) => boolean; filled: Filled[]; outOfGas: Filled[] }> {
  const { chain, v, token, amountIn, rpcs, scan, reads } = a;
  // a banned pool is no pool at all to this set (review of 919742f5, F1)
  const isBanned = (k: EvmPoolKey) => a.banned !== undefined && a.banned.has("0x" + poolId(k));
  // a route's read at an amount: the buy's forwards, the sell's backwards from `from` (the token, or for part of a
  // route, the currency it starts that part from)
  const readOf = (r: EvmRoute, amount: bigint, found: boolean, from = token) =>
    a.sell ? sellRead(v, from, r, amount) : found ? v4Read(v.v4!, r as EvmV4Route, amount) : quoteCall(chain, v, r, amount);
  const at = (r: EvmRoute, amount: bigint) => reads.push(readOf(r, amount, false)) - 1;
  // a sell through v3 needs the chain's router, and through v4 its PoolManager
  const v3 = v.v3 !== undefined && (!a.sell || evmPoolVenues()[chain].routers.length > 0);
  const v4 = v.v4 !== undefined && (!a.sell || v.poolManager !== undefined);
  const candidates: { route: EvmRoute; at: number; twice: number }[] = [];
  const candidate = (r: EvmRoute) => {
    if (r.venue === "uniswap-v4" && hopKeys(r).some(isBanned)) return;
    candidates.push({ route: r, at: at(r, amountIn), twice: at(r, 2n * amountIn) });
  };
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
  // The order below (the caller's list, the native asset or WETH, a listed middle, the rest, by pool id) only makes
  // the reads the same on every run; nothing is cut (see "The prune"), and what is read is priced by its quote at the
  // user's own amount
  // the agreed block, picked once (the held head while fresh), after the token's scan has its logs; a new one is held
  // to the 30 s rule in agreedBlock, a held one in the watch's reuse bound on both clocks
  let agreed: Promise<{ block: Block; confirm: () => Promise<void> }> | undefined;
  // `picked`: the agreed block once the quote picks it, never sooner (a kept scan that fails keeps its spans then)
  let pick: (b: Promise<Block>) => void = () => {};
  const picked = new Promise<Block>((r) => (pick = r));
  picked.catch(() => {});
  const agreedOnce = () => {
    if (agreed === undefined) {
      // from the block's agreement no request is sent past its time plus EVM_QUOTE_MAX_AGE_MS (gated), the scans'
      // catch-up to it included (review of 2d9a7bd9, finding 7: set once the token's scan returned, the catch-up ran
      // without it)
      agreed = agreedAt().then((x) => {
        const deadline = DEADLINE.get(rpcs);
        if (deadline !== undefined) deadline.until = Number(x.block.timestamp) * 1000 + EVM_QUOTE_MAX_AGE_MS;
        return x;
      });
      pick(agreed.then((x) => x.block));
    }
    return agreed;
  };
  // every agreement of the quote counts its majority over the quote's whole list and waits for the buy's block to one
  // deadline, the first's (review LOW-5: a retry's own wait reached about twice EVM_MIN_BLOCK_WAIT_MS)
  let waitFrom: number | undefined;
  const fresh = (on: readonly EvmRpc[]) => agreedBlock(on, v.maxLag, a.nowMs, a.minBlock, a.mono, a.start, (waitFrom ??= (a.mono ?? monotonic)()), rpcs.length);
  // the block more than maxLag below the scan provider's head, which the scan would refuse (scanPools)
  const behind = async (b: Block) => {
    const h = scanFrom === undefined ? null : await scanFrom.then((x) => x.head).catch(() => null);
    return h !== null && h - b.number > v.maxLag;
  };
  // A lower head more than maxLag below the scan provider's head never ends the quote (card evm-quote-lag-held: a
  // provider of the pair whose head lagged near maxLag held it there, and the quote refused rpc_disagree; publicnode 100
  // blocks back refused 9 of 10 Robinhood warm quotes in about 0.5 s, as it stayed ranked first). Its provider is held
  // and the block is agreed once more without it, on two other providers that agree and a confirm by one of the rest,
  // as any block is, a contested one by more than half the quote's whole list: a hold only drops a provider from the
  // pair, never lets one decide alone, nor lowers the majority. A held head from the watch names no provider, so it is
  // agreed again on the quote's own list first. One provider at most is held a quote (review LOW-1): a lower head still
  // that far behind leaves the scan to refuse as before.
  const agreedAt = async (): Promise<{ block: Block; confirm: () => Promise<void> }> => {
    let got: { block: Block; confirm: () => Promise<void>; low?: EvmRpc } = a.watch === undefined ? await fresh(rpcs) : await a.watch.head(a.nowMs);
    if (!(await behind(got.block))) return got;
    if (got.low === undefined) {
      got = await fresh(rpcs);
      if (!(await behind(got.block))) return got;
    }
    const low = got.low!;
    HOLD.get(low)?.();
    const rest = rpcs.filter((r) => r !== low);
    if (rest.length < 2) return got;
    const again = await fresh(rest);
    // the quote's later rounds ask the new pair first and the held provider last
    if (!Object.isFrozen(rpcs)) [...rest, low].forEach((r, n) => ((rpcs as EvmRpc[])[n] = r));
    return again;
  };
  const agreedHead = () => agreedOnce().then((x) => x.block);
  // the scan providers, the chain's ordered list (the first, then its spares) as far as the caller gives it: each with
  // another behind it has its share of the bound and passes a request it fails to the next, and the last has the whole
  // bound (cards evm-scan-second-provider, evm-rpc-spare-list)
  const scanRpcs = scan === undefined ? [] : typeof scan === "function" ? [scan] : scan;
  const t0 = performance.now();
  const firstOn = (v.scan === undefined ? [] : [v.scan, ...(v.scan.spares ?? [])])
    .slice(0, scanRpcs.length)
    .reduceRight<ScanOn | undefined>((next, c, i) => ({ rpc: scanRpcs[i]!, gate: scanGateOf(c.parallel, t0 + scanBoundMs, next !== undefined, DEADLINE.get(rpcs)), span: c.span, parallel: c.parallel, orSpan: c.orSpan, next }), undefined);
  let scanFrom: Promise<ScanFrom> | undefined;
  // the head, read once per quote on the first; where it answers none, on the next in the list that does. The
  // requests stay on the first, the rest behind each (review of 22e29c9, B1: a head answered after 2 s sent a whole
  // cold scan to the second, 800 getLogs where the first carried it)
  const headFrom = (o: ScanOn): Promise<bigint> => scanHeadOf(o.rpc, o.gate).catch((e) => (o.next === undefined ? Promise.reject(e) : headFrom(o.next)));
  const scanFromOf = (f: ScanOn) => (scanFrom ??= headFrom(f).then((head) => ({ head, first: f })));
  // a scan the quote waits for that fails refuses the quote, so it may pick the agreed block to keep its spans; a kept
  // scan started early waits for the quote to pick it, whether it ends or fails (review of bc189de, L-3: one that ended
  // before the token's scan picked the block itself, before the token's logs were in)
  const scanAt = (cs: readonly string[], kind: ScanKind, early = false) => {
    if (firstOn === undefined || v.poolManager === undefined || v.scan === undefined || cs.length === 0) return null;
    const at = early ? () => picked : agreedHead;
    return scanPools(chain, cs, kind, lower(v.weth), v.poolManager, v.scan, at, v.maxLag, scanFromOf(firstOn), at);
  };
  // the warm round: the token's kept reads and scans; a scan asked again in this quote is the one started here
  const planKey = `${chain}:${a.sell ? "sell" : "buy"}:${lower(token)}`;
  const plan = PLANS.get(planKey);
  const scans = new Map<string, ReturnType<typeof scanAt>>();
  const asked: { cs: string[]; kind: ScanKind }[] = [];
  const scanOf = (cs: readonly string[], kind: ScanKind) => {
    const k = `${kind}:${cs.join(",")}`;
    if (!scans.has(k)) scans.set(k, scanAt(cs, kind));
    if (cs.length > 0 && !(kind === "all" && cs.length === 1 && cs[0] === lower(token))) asked.push({ cs: [...cs], kind });
    return scans.get(k)!;
  };
  const early = plan === undefined ? [] : plan.scans.map((p) => scanAt(p.cs, p.kind, true));
  if (plan !== undefined) plan.scans.forEach((p, i) => scans.set(`${p.kind}:${p.cs.join(",")}`, early[i]!));
  // a kept scan that fails refuses only where the quote asks it again
  for (const e of early) e?.catch(() => {});
  const scanned = await scanOf([lower(token)], "all");
  const { block, confirm } = await agreedOnce();
  a.atBlock?.(block);
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
  // `real`: the same route with its hooks as they are, read where a hook is replaced; `alone`: where two hooks or more
  // are replaced, the route at the amount with each proper set of them alone replaced (see valueOf)
  type Quote = { route: EvmRoute; at: number; twice: number; real?: { at: number; twice: number }; alone?: number[] };
  type Found = { key: EvmPoolKey; id: string; other: string; price: number; liquidity: number; quotes: Quote[] };
  // a read into `into`: the reads of this round (`reads`) or of a later one, answered after the ones before
  // a read a later round asks that the first round already asked from the kept ones: its answer there (the warm round)
  const kept = new Map<string, number>();
  const hit = new Set<number>();
  const put = (into: Read[], r: Read) => {
    if (into !== reads) {
      const i = kept.get(readKey(r));
      if (i !== undefined) {
        hit.add(i);
        return i;
      }
    }
    return (into === reads ? 0 : reads.length) + into.push(r) - 1;
  };
  // (each pool id once: USDG's 9,942 pools on Robinhood spent about a second of the device's time on repeats)
  const foundOf = (k: EvmPoolKey, of: string, into: Read[], id = poolId(k)): Found => {
    const slot = BigInt("0x" + stateSlot(id));
    const st = (x: bigint) => put(into, { to: v.poolManager!, data: "0x" + SEL_EXTSLOAD + word(x), state: true });
    return { key: k, id, other: k.currency0 === lower(of) ? k.currency1 : k.currency0, price: st(slot), liquidity: st(slot + 3n), quotes: [] };
  };
  let keysLeft = EVM_QUOTE_MAX_KEYS;
  // a route the device made from found pools, at the amount and twice it, each hook not pinned replaced, and where one
  // is, the same route with its hooks as they are. A sell's part of a route reads from `from` at `amount` (see "X's
  // markets"). Past EVM_QUOTE_MAX_QUOTED the quote refuses: a route the prune kept could beat Q, so none is cut
  let quotesLeft = EVM_QUOTE_MAX_QUOTED;
  const quoteOf = (into: Read[], r: EvmV4Route, hooks: EvmPoolKey[], from = token, amount = amountIn): Quote => {
    if (quotesLeft-- === 0) return refuse("too_many_pools", `more than the ${EVM_QUOTE_MAX_QUOTED} routes a quote reads could beat the route`);
    return quoteAt(into, r, hooks, from, amount);
  };
  const quoteAt = (into: Read[], r: EvmV4Route, hooks: EvmPoolKey[], from: string, amount: bigint): Quote => {
    const c: Quote = { route: r, at: put(into, { ...readOf(r, amount, true, from), ...noop(hooks) }), twice: put(into, { ...readOf(r, 2n * amount, true, from), ...noop(hooks) }) };
    if (hooks.some(replaced)) c.real = { at: put(into, readOf(r, amount, true, from)), twice: put(into, readOf(r, 2n * amount, true, from)) };
    // every proper set of the replaced hooks replaced alone (the whole set is `at`, none is `real`; review of
    // 72e28658, M1)
    const hs = [...new Set(hooks.filter(replaced).map((k) => k.hooks))].sort();
    if (hs.length > 1) c.alone = subsetsOf(hs).filter((s) => s.length < hs.length).map((s) => put(into, { ...readOf(r, amount, true, from), ...noop(hooks.filter((k) => s.includes(k.hooks))) }));
    return c;
  };
  // a sell's `bought` route: read in the first round under the same rule as a route the device made (each hook not
  // pinned replaced, and the lower of that and its quote as it is), never cut (review of edb4dbb, F5)
  const bought: Quote | null =
    a.bought === undefined || (a.bought.venue === "uniswap-v4" && hopKeys(a.bought).some(isBanned)) ? null
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
    const fromScan = scanned?.pools.get(lower(token)) ?? [];
    const keys = [...fromScan, ...hints].flatMap((k) => {
      const id = poolId(k);
      if (seen.has(id) || droppable(k) || isBanned(k)) return [];
      seen.add(id);
      return [{ k, id, other: k.currency0 === lower(token) ? k.currency1 : k.currency0 }];
    });
    const rank = (e: { id: string; other: string }) => (hinted.has(e.id) ? 0 : startsBuy(e.other) ? 1 : listed.has(e.other) ? 2 : 3);
    // a set the bound cuts is never quoted from (review of 4830f1f, H2): 16,384 pools only initialized, each a few
    // cents of gas, with ids ground below the real pool's, pushed it out of the reads and a seeded route at a tenth of
    // the price was bought. The bound counts the scan's pools: the caller's list (EVM_QUOTE_MAX_HINTS) is read beside it
    if (fromScan.length > keysLeft) return refuse("too_many_pools", `the token has ${fromScan.length} pools, more than the ${keysLeft} a quote reads`);
    keysLeft -= fromScan.length;
    const ordered = keys.sort((x, y) => rank(x) - rank(y) || byId(x, y));
    const early = ordered.length <= EVM_QUOTE_EARLY;
    for (const { k, id } of ordered) {
      const f = foundOf(k, token, reads, id);
      if (early && startsBuy(f.other) && !replaced(k)) f.quotes.push(quoteOf(reads, routeOfKey(k, token), [k]));
      found.push(f);
    }
  }

  // the kept reads of the token's last quote within EVM_WARM_RANGE_S of block time, after this quote's own
  const first = reads.length;
  if (plan !== undefined && block.timestamp >= plan.ts && block.timestamp - plan.ts <= EVM_WARM_RANGE_S) {
    const own = new Set(reads.map(readKey));
    // the plan holds no read with a state override (below)
    for (const r of plan.reads) {
      const k = readKey(r);
      if (own.has(k) || kept.has(k)) continue;
      kept.set(k, reads.push(r) - 1);
    }
  }
  // the lower head's confirmation and the reads at its hash in one round; the confirmation is judged first
  const ans = await readAgreed(confirm, rpcs, block.hash, reads, v.reads);
  // the block is the same on both providers: the scan keeps what it read up to it
  scanned?.commit();
  const out = (i: number) => (ans[i]!.kind === "out" ? (ans[i] as { amountOut: bigint }).amountOut : null);
  a.firstRound?.(out, (i) => ans[i]!);
  const floor = a.floor?.(out) ?? null;

  // a found pool counts only where the PoolManager holds it: a price (slot0's low 160 bits) and liquidity above 0
  const holds = (f: Found) => {
    const p = out(f.price);
    const l = out(f.liquidity);
    return p !== null && (p & ((1n << 160n) - 1n)) !== 0n && l !== null && (l & ((1n << 128n) - 1n)) !== 0n;
  };
  const held = found.filter(holds);
  // A v3 route fills where its quote at twice the amount is more; one through one pool also where that read runs out
  // of its gas alone (`gas`): the 1x read answered within its gas, and a swap stopped at its price limit takes the
  // same path at twice, so the 1x filled whole (review of fe9f5ec3, finding 1: about 2,000 initialized ticks just past
  // the 1x price in the best pool made its twice run out, and a worse route won). A route of more hops whose twice does
  // is dropped and kept in `outOfGas` with its 1x value: a hop's spam can hide another hop's partial fill
  const ranOutAlone = (i: number) => (ans[i] as { gas?: true }).gas === true;
  // by the read at the amount, so a route asked again is kept once
  const outOfGas = new Map<number, Filled>();
  const fills = (c: { at: number; twice: number; route?: EvmRoute }, isV3 = false) => {
    const x = out(c.at);
    const y = out(c.twice);
    if (x === null || x === 0n) return false;
    if (y !== null) return y > x;
    if (!isV3) return true;
    if (!ranOutAlone(c.twice)) return false;
    if (c.route?.venue === "uniswap-v3" && c.route.tokens.length === 2) return true;
    if (c.route !== undefined) outOfGas.set(c.at, { route: c.route, amountOut: x });
    return false;
  };
  // What a route the device made counts for: its quote, where it fills; through a hook that is not pinned, the lower of
  // its quote with the hook replaced and with the hook as it is, each of which must fill. The hook replaced, a hook
  // cannot raise R above what its pool's liquidity gives; as it is, a hook that reverts or takes a fee on every swap
  // (a pool only its own router may swap in, as one of USDG's WETH pools on Robinhood, 2026-11-04 06:59Z) cannot set an
  // R that no buy through it reaches. Through two such hooks or more, also the lowest of its quotes with each set of them
  // alone replaced, each of which must answer above 0 or the route counts for nothing (card evm-buy-hook-converge, N1;
  // every set, review of 72e28658, M1; review of a2d82dc6, F2): a hostile hook's extra on the quoter
  // would otherwise hide behind an honest hook's visible fee in both whole-route reads, so the route counted above
  // what it pays with the hostile hook alone replaced, and a reverted sale's evidence blamed the honest pool
  const valueOf = (c: Quote): bigint | null => {
    if (!fills(c)) return null;
    if (c.real === undefined) return out(c.at);
    if (!fills(c.real)) return null;
    let m = out(c.at)! < out(c.real.at)! ? out(c.at)! : out(c.real.at)!;
    // a proper set's read that reverts or answers 0 counts the route for nothing (see the buy's own route,
    // evmPoolBuyQuoteWith; review of a2d82dc6, F2)
    for (const i of c.alone ?? []) {
      const x = out(i);
      if (x === null || x === 0n) return null;
      if (x < m) m = x;
    }
    return m;
  };
  // one more round of reads at the same block, its answers after the ones before
  const round = async (more: Read[]) => {
    if (more.length === 0) return;
    const base = reads.length;
    reads.push(...more);
    ans.push(...(await readBoth(rpcs, block.hash, reads.slice(base), v.reads)));
  };
  const hopTo = (c: string, k: EvmPoolKey) => ({ currency: c, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, hookData: "0x" });
  const ok = v4 && v.poolManager !== undefined;

  // The prune (review of 13a063e, HIGH: a dust position next to the real pool's price made it read as shallow, and
  // any ranked cut pushed it out). A buy's pool is dropped only where it cannot beat the route's Q: all it is asked to
  // pay, after its fee, at its spot price gives less, and the price only worsens as it swaps; a route through several
  // pools is dropped only where that bound through each of them does. A pool behind a pinned hook, which runs as it
  // is, has no bound and is always quoted (LOW 1). Every pool kept is quoted; past EVM_QUOTE_MAX_QUOTED routes or
  // EVM_QUOTE_MAX_OTHER currencies the quote refuses, never cuts. The residual risk is a refusal: anyone can seed a
  // token with more pools that could beat its route than a quote reads, and its buy is then refused (too_many_pools),
  // never bought through a seeded pool. The same holds for the swap's gas (card evm-buy-gas-floor): each such pool
  // whose swap does not fit adds a fit read, sent alone, three to a request; about 290 of them on Robinhood at 624 ms a
  // request push a quote past EVM_QUOTE_MAX_AGE_MS, while on Base the reads cannot cross it inside the EVM_QUOTE_MAX_QUOTED
  // routes a quote reads (review 2 of c9a8df14): a refusal, never a wrong buy. And the fit read is sent from the pool with no
  // fees (buySwap takes only the pool's call), so its tx.origin and tx.gasprice are not the real buy's: a hook or token
  // that checks them can pass the read and fail the swap, which the pool lands as a failed swap, the chunk less the fee
  // back to W (PrivacyPoolSimple.sol:78, :97). A sell has no Q and drops nothing
  const MASK160 = (1n << 160n) - 1n;
  const cdiv = (x: bigint, y: bigint) => (x + y - 1n) / y;
  // a buy's hop pays `other` for the currency it was found for: currency0 for currency1 where `other` is currency0
  const zf = (f: Found) => f.other === f.key.currency0;
  // the most the hop gives for `x` of what it pays (null: no bound); slot0 is the price (160 bits), tick (24), protocol
  // fee (24) and LP fee (24), the fee a hook replaced by one that does nothing leaves the swap
  const ubOf = (f: Found, x: bigint | null): bigint | null => {
    if (x === null || (f.key.hooks !== NATIVE && !replaced(f.key))) return null;
    const s0 = out(f.price)!;
    const fee = (s0 >> 208n) & 0xffffffn;
    const y = cdiv(x * (1_000_000n - (fee < 1_000_000n ? fee : 1_000_000n)), 1_000_000n);
    const p = s0 & MASK160;
    return zf(f) ? cdiv(y * p * p, 1n << 192n) : cdiv(y << 192n, p * p);
  };
  // whether the hop can give at least Q for `x`
  const can = (f: Found, x: bigint | null) => {
    if (floor === null) return true;
    const u = ubOf(f, x);
    return u === null || u >= floor;
  };

  // The token's held pools of the native asset or WETH, each quoted where not already and where it can beat the route
  const xPools = new Map<string, Found[]>();
  for (const f of held) if (!startsBuy(f.other)) append(xPools, f.other, f);
  // The X prune (card rh-cold-quote): every route through another currency X ends in one of the token's pools with X,
  // so a buy's pool that cannot give the route's Q of the token from any amount a v4 hop is given
  // (V4Quoter.quoteExactOutputSingle of Q through it reverts NotEnoughLiquidity or SafeCastOverflow, its hook replaced
  // as in every read of it, the same answer on both providers) is never the last hop of a route that beats Q, and is
  // dropped; an X left with none is neither scanned nor priced. A pool behind a pinned hook, which runs as it is, has
  // no such bound and is kept, as in "The prune". A sell has no Q and drops nothing. TORCH on Robinhood has 100 pools
  // with other currencies, 99 of them seeded currencies whose only pool is that one; 89 could not give Q for 0.001 ETH
  // (rpc.mainnet.chain.robinhood.com, 2026-11-06 01:5xZ), and the scans of their markets held its cold quote to the
  // bound (58 s, rpc_error). An X the token's last quote kept past this prune is not asked again (its scans read only
  // new blocks, so the read would add a round to a warm quote for no scan it saves; keeping one only adds routes); any
  // other X is, the ones this device scanned for another reason too (card evm-spare-list-green: TORCH's first quote
  // pruned USDG and then scanned its markets one level further; the second, which asked only an X whose markets were
  // never scanned, kept USDG, scanned all its pools over the whole depth and refused too_many_pools, every TORCH quote
  // after the first, 2026-11-06 22:3xZ)
  const keptBefore = new Set(plan?.xs ?? []);
  const unsure = (x: string) => !keptBefore.has(x);
  if (ok && floor !== null && floor > 0n && floor < 1n << 127n && [...xPools.keys()].some(unsure)) {
    const asks: [Found, number][] = [];
    const pr: Read[] = [];
    for (const [x, fs] of xPools) {
      if (!unsure(x)) continue;
      for (const f of fs) if (f.key.hooks === NATIVE || replaced(f.key)) asks.push([f, put(pr, { ...exactOutRead(v.v4!, f.key, lower(token), floor), ...noop([f.key]) })]);
    }
    await round(pr);
    // NotEnoughLiquidity: it runs out before Q; SafeCastOverflow: Q needs more than 2^127 in
    const cannot = new Set(asks.filter(([, i]) => {
      const r = ans[i]!;
      return r.kind === "revert" && (r.partial || r.overflow === true);
    }).map(([f]) => f));
    for (const [x, fs] of [...xPools]) {
      const left = fs.filter((f) => !cannot.has(f));
      if (left.length === 0) xPools.delete(x);
      else xPools.set(x, left);
    }
  }
  const second: Read[] = [];
  for (const f of held) {
    if (startsBuy(f.other) && f.quotes.length === 0 && can(f, amountIn)) f.quotes.push(quoteOf(second, routeOfKey(f.key, token), [f.key]));
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
  // buy does: where X has no market that fills (review of edb4dbb, F1, F2). A buy quotes a market, a pool and a route
  // through them only where the prune's bound through them can beat Q
  const smallest = (fs: readonly Found[]) => fs.map((f) => f.id).sort()[0]!;
  const others = (m: Map<string, Found[]>) =>
    [...m.keys()]
      .map((c) => ({ c, id: smallest(m.get(c)!) }))
      .sort((x, y) => Number(!listed.has(x.c)) - Number(!listed.has(y.c)) || byId(x, y))
      .map((e) => e.c);
  const xs = others(xPools);
  const priced = (n: number) => {
    if (n > EVM_QUOTE_MAX_OTHER) return refuse("too_many_pools", `the token's held pools are paired with more than the ${EVM_QUOTE_MAX_OTHER} other currencies a quote reads`);
  };
  priced(xs.length);
  // c's markets: its standard and pinned shapes, then the scanned ones by pool id; past the state bound the quote
  // refuses (review of c71a4d0..a9f1d32, HIGH: 16,381 empty pools of the token left X's markets unread)
  const marketsOf = (c: string, scannedKeys: readonly EvmPoolKey[], into: Read[]): Found[] => {
    const ks = new Map<string, EvmPoolKey>();
    const add = (k: EvmPoolKey | null) => {
      if (k !== null && !droppable(k) && !isBanned(k) && !ks.has(poolId(k))) ks.set(poolId(k), k);
    };
    for (const [fee, tickSpacing] of V4_KEYS) add(keyOf({ currency0: NATIVE, currency1: c, fee, tickSpacing, hooks: NATIVE }, c));
    for (const h of v.hookedPools) {
      const from = h.from === "native" ? NATIVE : lower(v.weth);
      const [c0, c1] = BigInt(from) < BigInt(c) ? [from, c] : [c, from];
      add(keyOf({ currency0: c0, currency1: c1, fee: h.fee, tickSpacing: h.tickSpacing, hooks: h.hooks }, c));
    }
    for (const { k } of scannedKeys.map((k) => ({ k, id: poolId(k) })).sort(byId)) add(k);
    if (ks.size > keysLeft) return refuse("too_many_pools", `the markets of ${c} pass the ${EVM_QUOTE_MAX_KEYS} pools a quote reads`);
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
      markets.set(c, marketsOf(c, sc?.pools.get(c) ?? [], into));
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
        append(legs, x, { q: quoteOf(second, { venue: "uniswap-v4", currencyIn: x, hops: [hopTo(lower(token), p.key)] }, [p.key]), p });
      }
    }
  }
  await round(second);
  const marketQuote = new Map<Found, Quote>();
  // one level further: X's held pools with Y, by X
  const vias = new Map<string, Found[]>();
  // whether `x` of c can give Q through one of the token's pools with c, or one level further through one of c's pools
  // with another X and that X's pools with the token
  const needs = (c: string, x: bigint | null): boolean =>
    floor === null ||
    (xPools.get(c) ?? []).some((p) => can(p, x)) ||
    [...vias].some(([x2, fs]) => fs.some((via) => via.other === c && (xPools.get(x2) ?? []).some((p) => can(p, ubOf(via, x)))));
  // each held market of c not yet quoted, from the native asset or WETH at the user's amount (a buy, where it can give
  // Q), or from c at the most of c the sell's part of a route into c gives (a sell; none where no such part fills)
  const quoteMarkets = (cs: readonly string[], into: Read[]) => {
    for (const c of cs) {
      const leg = a.sell ? legOf(c) : null;
      if (a.sell && leg === null) continue;
      for (const mk of (markets.get(c) ?? []).filter(holds)) {
        if (marketQuote.has(mk) || !needs(c, ubOf(mk, amountIn))) continue;
        marketQuote.set(mk, leg === null ? quoteOf(into, routeOfKey(mk.key, c), [mk.key]) : quoteOf(into, routeOfKey(mk.key, c), [mk.key], c, leg.amount));
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
    // the X the market gives with its hook replaced, as in the route's own read: a pool of X that cannot turn it into
    // more than Q is not quoted
    const xa = out(marketQuote.get(mk)!.at)!;
    for (const p of xPools.get(x)!) {
      if (!can(p, xa)) continue;
      p.quotes.push(quoteOf(fourth, { venue: "uniswap-v4", currencyIn: mk.other, hops: [hopTo(x, mk.key), hopTo(lower(token), p.key)] }, [mk.key, p.key]));
    }
  }
  // one level further: X's pools with Y, from one scan of every such X's pools
  if (ok && further.length > 0) {
    const sc = await scanOf(further, "all");
    sc?.commit();
    for (const x of further) {
      const ks = (sc?.pools.get(x) ?? [])
        .map((k) => ({ k, id: poolId(k), other: k.currency0 === x ? k.currency1 : k.currency0 }))
        .filter((e) => !startsBuy(e.other) && e.other !== lower(token) && !droppable(e.k) && !isBanned(e.k))
        .sort(byId);
      if (ks.length > keysLeft) return refuse("too_many_pools", `the pools of ${x} pass the ${EVM_QUOTE_MAX_KEYS} pools a quote reads`);
      keysLeft -= ks.length;
      vias.set(x, ks.map((e) => foundOf(e.k, x, fourth, e.id)));
    }
  }
  await round(fourth);
  for (const [x, fs] of vias) vias.set(x, fs.filter(holds));
  const yPools = new Map<string, Found[]>();
  for (const fs of vias.values()) for (const f of fs) append(yPools, f.other, f);
  const ys = others(yPools);
  priced(xs.length + ys.filter((y) => !xs.includes(y)).length);
  const fifth: Read[] = [];
  if (ok) await readMarkets(ys, fifth);
  // a sell's part of a route into Y: the token into X through X's pool that gives the most X, then X into Y
  if (a.sell) {
    for (const [x, fs] of vias) {
      const into = legOf(x);
      if (into === null) continue;
      for (const via of fs.filter((f) => holds(f) && ys.includes(f.other) && !xs.includes(f.other))) {
        append(legs, via.other, { q: quoteOf(fifth, { venue: "uniswap-v4", currencyIn: via.other, hops: [hopTo(x, via.key), hopTo(lower(token), into.p.key)] }, [via.key, into.p.key]), p: into.p });
      }
    }
  }
  await round(fifth);
  const sixth: Read[] = [];
  // a buy's Y that is also an X: its markets the X prune left out may still give Q through X's pools with Y
  quoteMarkets(a.sell ? ys.filter((y) => !xs.includes(y)) : ys, sixth);
  await round(sixth);
  const seventh: Read[] = [];
  for (const [x, fs] of vias) {
    for (const via of fs) {
      const mk = ys.includes(via.other) ? bestMarket(via.other) : null;
      if (mk === null) continue;
      const xa = ubOf(via, out(marketQuote.get(mk)!.at)!);
      for (const p of xPools.get(x)!) {
        if (!can(p, xa)) continue;
        const r: EvmV4Route = { venue: "uniswap-v4", currencyIn: mk.other, hops: [hopTo(via.other, mk.key), hopTo(x, via.key), hopTo(lower(token), p.key)] };
        p.quotes.push(quoteOf(seventh, r, [mk.key, via.key, p.key]));
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
    const x = bought.route.venue === "uniswap-v3" ? (fills({ ...bought, route: bought.route }, true) ? out(bought.at) : null) : valueOf(bought);
    if (x !== null) filled.push({ route: bought.route, amountOut: x });
  }
  // what the next quote of the token asks in its first round: this one's later reads, and the kept ones it asked again
  PLANS.delete(planKey);
  // never a read with a state override: it is asked only once this quote's own reads find its pool held (review of
  // 5452011, S1), so a pool that vanished since never puts its hook's override into a read
  PLANS.set(planKey, { ts: block.timestamp, reads: reads.slice(first).filter((r, j) => r.override === undefined && !r.data.startsWith("0x" + SEL_V4_OUT_SINGLE) && (!kept.has(readKey(r)) || hit.has(first + j))), scans: asked, xs: [...xPools.keys()] });
  while (PLANS.size > PLANS_MAX) PLANS.delete(PLANS.keys().next().value!);
  return { block, out, fills, filled, outOfGas: [...outOfGas.values()] };
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
// never picked over the token's real market (review of evm-sell-device-quote, H1), except where the reference is a route
// through a hook the venue does not list: that route is then the pick (card evm-sell-hook-converge), the quote names
// its pools (`hooked`), where the real sale reverts the caller bans those its revert proves at fault
// (evmSellRevertedPools, below), and a banned pool (`banned`) is no route at all. Then, at the same block on both
// providers, the fee-on-transfer probe: W's code is replaced
// (eth_call's state override) by EVM_SELL_PROBE_CODE, which transfers the amount from W to the pool's own address (the
// PoolManager for v4, the v3 pool from the quoter's factory().getPool for v3) and returns what that address received,
// only where W's balance fell by the same; a probe that reverts, or answers another amount, is refused
// (fee_on_transfer). minOut = floor(Q x (10000 - slippageBps) / 10000). The agreed block is never below `boughtBlock`,
// the buy's (agreedBlock waits for both providers to reach it, at most EVM_MIN_BLOCK_WAIT_MS), and the quote's feeMax is
// the device's own cap on the sender's fee at that block's base fee and chain fee (card evm-buy-hookdata-fee; the kit's
// one fee rule, trade/evm/pool-fee.ts), with minOut less it at least the pool's MIN_DEPOSIT (below_minimum). Only a quote made here builds a sell, within 30 s
// of its block (trade/evm/sell.ts), and W signs only a sell built from one.

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
  /** (required) The block the buy that paid W the token landed in: the buy receipt's blockNumber, as the device read
   *  the receipt itself. The quote reads at this block or a later one, waiting for both providers to reach it (card
   *  evm-buy-hookdata-fee). A number, not a hash: the agreed block is confirmed by hash on both providers, and a buy a
   *  reorg drops leaves W without the token, which the fee-on-transfer probe at that block refuses, so a hash would add
   *  reads for no named risk (review fold 1, L6). */
  boughtBlock: bigint;
  /** W's signature of a sim sell at the agreed block's timestamp (the kit's evmPoolSignSimSell with W's key), needed
   *  only where a route through a hook the venue does not list would set the reference (card evm-quote-exec-sim). */
  signSim?: (sim: EvmSellSim, blockTimestamp: bigint) => Uint8Array;
  /** (optional) The v4 pools this device banned for this token on this chain (card evm-sell-hook-converge): each a
   *  PoolId, 0x and 64 hex digits, that evmSellRevertedPools proved at fault for a reverted sale (the wallet's store
   *  keeps them, for an hour at first, wallet pool/evm-sell-bans.ts). A route through any of them is neither picked nor
   *  a reference. */
  banned?: readonly string[];
  /** (required) Every release the device sent to W that its store has not seen settled (its RESERVED notes that pay W:
   *  the wallet's pool/evm-releases.ts evmSellSentOf), none for a device that sent none. It can only add waits to the
   *  quote's own read of W's releases (trade/evm/sell-releases.ts, card evm-sell-no-release-in-flight), never clear one. */
  sent: readonly EvmSellSent[];
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
  /** The most the sender may take from the sale: the device's own fee rule (trade/evm/sell-unpinned.ts
   *  evmPoolSellFeeMax) at the agreed block's base fee and chain fee, read on both providers; the kit's sell builder
   *  takes no fee cap above it, and minOut less it is at least the pool's MIN_DEPOSIT. */
  readonly feeMax: bigint;
  /** The PoolId (0x and 64 hex digits) of each pool of the route behind a hook the venue does not list, in hop order;
   *  empty for a route with none. Such a route is picked only where it sets the reference and no route through listed
   *  pools is within the slippage of it (card evm-sell-hook-converge): a hook may honour a quote and a sim and revert the
   *  real sale (one that honours only some blocks, or flips on per-block state), so where the real sale reverts the
   *  caller asks evmSellRevertedPools which of these the revert proves at fault, bans those (`banned` on the next
   *  quote), and the sale goes on through the rest. */
  readonly hooked: readonly string[];
  /** The quote's own read of W's releases at its block (card evm-sell-no-release-in-flight; trade/evm/sell-releases.ts):
   *  the sell builder refuses release_in_flight while any is pending. */
  readonly releases: EvmSellReleases;
  /** What W's sim of the sale did (card evm-sell-unfunded-sim-keeps-route): "ran" where a route through a hook the
   *  venue does not list needed it and it ran (each such route counting at no more than W's gain in it); "skipped"
   *  where such a route was priced without it, at the lower of its quote with the hook replaced and as it is
   *  (keep-min): the pinned sell sender's balance at the block could not pay its gas, or did not read, or the chain
   *  pins no sell delegate or sender; "none" where no route needed it. */
  readonly sim: EvmSellSimRun;
  /** The routes of more than one v3 hop the quote dropped because a read of twice the amount ran out of a read's gas
   *  alone (card evm-quote-read-gas-starve; review of fe9f5ec3, finding 1), each at its quote for the amount: a sale is
   *  never refused for them, so an exit is never blocked; empty where none. */
  readonly outOfGas: readonly { readonly route: EvmRoute; readonly amountOut: bigint }[];
};

/** What W's sim of a sale did in a sell quote (EvmPoolSellQuote.sim). */
export type EvmSellSimRun = "ran" | "skipped" | "none";

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

/** The most PoolIds a sell quote's `banned` takes: far past any token's pools a device could try and ban. */
export const EVM_SELL_BANNED_MAX = 4096;
/** A request's `banned` (card evm-sell-hook-converge) as a set of PoolIds, 0x and 64 lower-case hex digits; none is
 *  an empty set. Read once, into a copy; anything but a list of at most EVM_SELL_BANNED_MAX such strings is refused
 *  (bad_request). */
function bannedOf(b: unknown): ReadonlySet<string> {
  if (b === undefined) return new Set();
  if (!Array.isArray(b) || b.length > EVM_SELL_BANNED_MAX) return refuse("bad_request", `banned is a list of at most ${EVM_SELL_BANNED_MAX} pool ids`);
  const out = new Set<string>();
  for (const x of [...b]) {
    if (typeof x !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x)) return refuse("bad_request", "a banned pool id is 0x and 64 hex digits");
    out.add(x.toLowerCase());
  }
  return out;
}

/** The device's sell quote on the chain's two pinned providers (see above); throws EvmQuoteError. Like
 *  evmPoolBuyQuote, it takes no provider from its caller; tests run evmPoolSellQuoteWith. */
export async function evmPoolSellQuote(req: EvmPoolSellQuoteRequest): Promise<EvmPoolSellQuote> {
  if (typeof req !== "object" || req === null) return refuse("bad_request", "the request is an object");
  // each field read once, into a plain copy (review of c71a4d0..a9f1d32, LOW 2: a getter could name one chain for the
  // providers and another for the reads)
  const asked: EvmPoolSellQuoteRequest = { ...req };
  const p = venue(asked.chain).providers;
  if (p === undefined) return refuse("no_quoter", `${asked.chain} has no pinned providers`);
  // W's releases are read on the pool's own list, where the chain has one (Robinhood: the quote list's first two cannot
  // page the pool's logs, buy-unpinned.ts poolProviders)
  const pool = evmPoolProvidersOf(evmPoolVenues()[asked.chain]!);
  const rpcs = evmProviders(evmRanked(p), fetch);
  return evmPoolSellQuoteWith(asked, rpcs, Date.now(), scansOf(venue(asked.chain).scan), undefined, monotonic, pool === undefined || pool === p ? rpcs : evmProviders(evmRanked(pool), fetch));
}

/** evmPoolSellQuote on the providers `rpcs` with the device's clock at `nowMs`, and the scan provider `scan` (`venues`
 *  and `mono`, the monotonic clock of the wait for the buy's block: tests only), and `poolRpcs`, the pool's list W's
 *  releases are read on (by default `rpcsIn`). Not in the index. */
export async function evmPoolSellQuoteWith(req: EvmPoolSellQuoteRequest, rpcsIn: readonly EvmRpc[], nowMs: number, scan?: EvmRpc | readonly EvmRpc[], venues?: EvmPoolVenueList, mono: () => number = monotonic, poolRpcs: readonly EvmRpc[] = rpcsIn): Promise<EvmPoolSellQuote> {
  const start = mono();
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
  // from found pools (each hook not pinned replaced, the lowest of that and its quotes as it is), and one more candidate
  // and reference only where the sell builder takes it (F5), a hook it does not list included as on any route the
  // device's quote picks (card evm-buy-hook-converge: a buy may enter through such a pool, and its sale leaves through it
  // though the pool's Initialize log is past the scan's depth)
  if (req.bought === undefined) return refuse("bad_request", "a sell quote takes `bought`, the route of the buy that paid W the token");
  const bought = copyRoute(req.bought);
  if (lower(evmPoolRouteDataQuoted(chain, bought).token) !== lower(token)) return refuse("token_mismatch", "the bought route buys another token");
  const boughtBlock = req.boughtBlock;
  if (typeof boughtBlock !== "bigint" || boughtBlock < 1n) return refuse("bad_request", "a sell quote takes `boughtBlock`, the block of the buy that paid W the token");
  // the pools this device banned for the token (card evm-sell-hook-converge), read once into a set of PoolIds
  const banned = bannedOf(req.banned);
  // the device's releases on their way to W, read once into a copy (card evm-sell-no-release-in-flight)
  const sent = evmSellSentOf(req.sent) ?? refuse("bad_request", "a sell quote takes `sent`, a list of the device's releases to W, each a note, a nullifier and a deadline");
  if (v.pool === undefined) return refuse("no_quoter", `${chain} pins no pool: W's releases cannot be read`);
  const rpcs = gated(rpcsIn, v.scan?.parallel ?? 2, { until: Infinity, now: () => nowMs + Math.max(0, mono() - start) });
  const t = lower(token);

  const reads: Read[] = [];
  const factory = v.v3 !== undefined && router !== undefined ? reads.push({ to: v.v3, data: "0x" + SEL_FACTORY }) - 1 : -1;
  const exits = evmSellExits(chain, t, bought, true) ? bought : undefined;
  const { block, out, filled: found, outOfGas } = await routeSet({ chain, v, token: t, amountIn, nowMs, rpcs, scan, reads, bought: exits, seen: [], banned, hints: undefined, sell: true, minBlock: boughtBlock, mono, start });
  // W's releases at the agreed block, read beside the rest of the quote and awaited before it is made
  const releasesP = sellReleasesRead(chain, v.pool, lower(w), poolRpcs === rpcsIn ? rpcs : gated(poolRpcs, v.scan?.parallel ?? 2, DEADLINE.get(rpcs)), block, v.maxLag, sent, { token: t, block: boughtBlock }, () => nowMs + Math.max(0, mono() - start));
  releasesP.catch(() => {});
  // a route through a pool this device banned is neither simmed, picked nor a reference: routeSet leaves every banned
  // pool out before it picks X's market or the token's pool with X (review of 919742f5, F1); this holds it once more
  const filled = found.filter((r) => !(r.route.venue === "uniswap-v4" && hopKeys(r.route).some((k) => banned.has("0x" + poolId(k)))));
  // a route through a hook the venue does not list, priced above the best route the sell builder takes, counts only
  // where W's own sell through it executes at that price (card evm-quote-exec-sim; review of edb4dbb, F4)
  const takes = best(filled.filter((r) => evmSellExits(chain, t, r.route)));
  const { routes, sim } = await simmedSells(chain, v, rpcs, block, lower(w), t, amountIn, filled, takes?.amountOut ?? 0n, req.signSim);
  // The pick: the best route the sell builder takes through listed pools. The reference: the best of every route,
  // the sell builder's or not (a pool of a hook not listed, priced at the lower of its quote with the hook replaced and
  // as it is, and at no more than W's sim pays). A pick more than the slippage below the reference is refused, so a seeded pool is
  // never picked over the token's real market (review of evm-sell-device-quote, H1), unless the reference's own route
  // can be the pick (below)
  const reference = bestOf(routes);
  const under = (p: Filled | null) => p === null || (reference !== null && p.amountOut * 10000n < reference.amountOut * BigInt(10000 - slippageBps));
  let pick = best(routes.filter((r) => evmSellExits(chain, t, r.route)));
  // A route through a hook the venue does not list that sets the reference, with no route through listed pools within
  // the slippage of it, is the pick itself, at the reference's minOut (card evm-sell-hook-converge): its price held on
  // both providers (and, where the chain pins a sell delegate and sender that can pay for it, in W's own sim), yet a hook can still honour
  // only some blocks or flip on per-block state, which no read before the sale can see. Refusing would let such a pool
  // freeze the token's sales; taking it costs a reverted sale, after which the caller bans the pools its revert proves
  // at fault (evmSellRevertedPools, then `banned`) and the next quote leaves through the rest. A builder is still never paid less than a
  // route the sale can take: minOut is the reference's
  if (under(pick) && reference !== null && evmSellExits(chain, t, reference.route, true)) pick = { route: reference.route, amountOut: reference.amountOut };
  if (pick === null) return refuse("no_quote", "no pool the sell can leave through fills it", reference);
  if (reference !== null && under(pick)) {
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
    ], v.reads);
    const p = pool!.kind === "out" ? pool!.amountOut : 0n;
    if (p === 0n || p >= 1n << 160n) return refuse("no_quote", "the v3 factory names no pool for the route's first hop");
    to = "0x" + p.toString(16).padStart(40, "0");
  }
  // with the probe, the chain fee the sale pays beside its gas (pool-fee.ts evmPoolChainFeeReads), on both providers
  const [probe, ...chainFees] = await readBoth(rpcs, block.hash, [
    { to: lower(w), data: "0x" + word(BigInt(t)) + word(BigInt(to)) + word(amountIn), override: { [lower(w)]: { code: EVM_SELL_PROBE_CODE } } },
    ...evmPoolChainFeeReads(chain, EVM_POOL_SELL_GAS),
  ], v.reads);
  if (probe!.kind !== "out" || probe!.amountOut !== amountIn) {
    return refuse("fee_on_transfer", `W's transfer of ${amountIn} of the token to ${to} ${probe!.kind === "out" ? `delivers ${probe!.amountOut}` : "reverts"}`);
  }

  // the slippage off the reference, never off a pick below it: the pick may already sit up to the slippage below the
  // reference, and W signs no more than that below the device's best price (review of edb4dbb, F6). A reference through
  // a hook the venue does not list that is not the pick's own route sets no minOut: its hook places its own quote, and
  // at pick / (1 - slippage) it would leave the pick no slippage (review of 72e28658, M2, the buy's and the sale's)
  const minOut = ((hookedRoute(chain, reference!.route) && JSON.stringify(reference!.route) !== JSON.stringify(pick.route) ? pick.amountOut : reference!.amountOut) * BigInt(10000 - slippageBps)) / 10000n;
  if (minOut === 0n) return refuse("no_quote", "the pool quotes too little to set a minimum above 0");
  const target = route.venue === "uniswap-v3" ? router! : v.poolManager!;
  // the sender's fee cap, from the device's own rule at the agreed block's base fee, never a caller's (card
  // evm-buy-hookdata-fee)
  if (block.baseFeePerGas === null) return refuse("rpc_error", `block ${block.number} has no base fee: the sale's fee cannot be capped`);
  if (chainFees.some((a) => a!.kind !== "out")) return refuse("rpc_error", "the chain's fee oracle did not answer: the sale's fee cannot be capped");
  const chainFee = evmPoolChainFee(chain, EVM_POOL_TX_BYTES, chainFees.map((a) => (a as { amountOut: bigint }).amountOut));
  const feeMax = evmPoolSellFeeMax(chain, block.baseFeePerGas, chainFee);
  // the sale's proceeds less the sender's most go back into the pool as a deposit, which the pool refuses under its
  // MIN_DEPOSIT: a sale that could land only as a revert is never quoted (review fold 1, L5)
  if (minOut - feeMax < EVM_POOL_MIN_DEPOSIT) return refuse("below_minimum", `the sale's ${minOut} at least, less the fee's ${feeMax} at most, is under the pool's least deposit of ${EVM_POOL_MIN_DEPOSIT}`);
  // the pools of the pick behind a hook the venue does not list: where the real sale reverts, evmSellRevertedPools
  // names those of them the revert proves at fault
  const hooked = Object.freeze(pick.route.venue === "uniswap-v4" ? hopKeys(pick.route).filter((k) => k.hooks !== NATIVE && !evmHookListed(chain, k.hooks, k.fee, k.tickSpacing)).map((k) => "0x" + poolId(k)) : []);
  const releases = await releasesP;
  const quote: EvmPoolSellQuote = Object.freeze({ chain, token: t, w: lower(w), amountIn, route, target, block: Object.freeze(block), amountOut: pick.amountOut, minOut, feeMax, hooked, releases, sim, outOfGas: Object.freeze(outOfGas.map((c) => Object.freeze({ route: copyRoute(c.route), amountOut: c.amountOut }))) });
  QUOTED_SELLS.add(quote);
  return quote;
}

// W's releases at a sell quote (card evm-sell-no-release-in-flight; audit E-01; trade/evm/sell-releases.ts holds the
// rules). The pool's Withdrawn and Bought events to W (topic 1, the indexed _recipient: IPrivacyPool.sol; their topics
// TOPIC_WITHDRAWN and TOPIC_BOUGHT, below); each one's _spentNullifier is its fourth data word (after _feeRecipient,
// _value and _fee).
/** Blocks a getLogs request of the read spans: its last request runs to "latest", up to maxLag (100) past the quote's
 *  block, so it stays inside the pool lists' smallest range cap (robinhood.api.pocket.network, 10,001 blocks). */
export const EVM_SELL_TAIL_PAGE = 9_000n;
/** The most blocks from the finalized block to the quote's the read spans: about 10x the gap read 2026-11-07 20:10Z
 *  (Base 4,671 blocks, 935 s, on mainnet.base.org; Robinhood 8,648 blocks, 912 s, on rpc.mainnet.chain.robinhood.com). A
 *  wider one is refused (rpc_error) rather than paged without end on a provider's word. */
export const EVM_SELL_TAIL_MAX = 100_000n;
const hx = (n: bigint) => "0x" + n.toString(16);

/** One getLogs answer's log, checked: the pool's, a Withdrawn or Bought to W, in a block of the read, not removed. */
type ReleaseLog = EvmReleaseLog & { key: string; hash: string };
function releaseLogOf(l: unknown, who: string, pool: string, wTopic: string): ReleaseLog {
  const o = (typeof l === "object" && l !== null ? l : {}) as Record<string, unknown>;
  const { address, topics, data, blockNumber, blockHash, logIndex, removed } = o;
  const q = (x: unknown) => typeof x === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(x);
  if (typeof address !== "string" || lower(address) !== pool || !Array.isArray(topics) || topics.length !== 2 || typeof topics[0] !== "string" || typeof topics[1] !== "string") {
    return refuse("rpc_error", `${who} answered a log that is not the pool's release to W`);
  }
  const t0 = lower(topics[0]);
  const kind = t0 === TOPIC_WITHDRAWN ? "withdraw" : t0 === TOPIC_BOUGHT ? "buy" : null;
  if (kind === null || lower(topics[1]) !== wTopic) return refuse("rpc_error", `${who} answered a log that is not the pool's release to W`);
  const words = kind === "withdraw" ? 5 : 7;
  if (typeof data !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${64 * words}}$`).test(data) || !q(blockNumber) || !q(logIndex) || typeof blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(blockHash) || removed === true) {
    return refuse("rpc_error", `${who} answered a malformed release log`);
  }
  const block = BigInt(blockNumber as string);
  // a Bought's _token: its sixth data word, an address
  const token = kind === "buy" ? lower("0x" + data.slice(2 + 64 * 5 + 24, 2 + 64 * 6)) : null;
  return { kind, block, nullifier: BigInt("0x" + data.slice(2 + 64 * 3, 2 + 64 * 4)), token, hash: lower(blockHash), key: `${block}:${lower(blockHash)}:${BigInt(logIndex as string)}:${t0}:${lower(data)}` };
}

/** How long a log above the quote's block one provider gave waits for a second provider's head to move toward its
 *  block, and how often it asks. The wait runs as long as a head keeps moving (a credible log is at most maxLag blocks
 *  past a head: Base 50, about 10 s at 200 ms; Robinhood 100, about 10.5 s at 105 ms; base-sepolia 100, about 20 s at
 *  200 ms; read 2026-11-07 20:10Z), so an honest chain always reaches the block; it ends when no head moved for this. */
export const EVM_SELL_CONFIRM_WAIT_MS = 12_000;
const EVM_SELL_CONFIRM_EVERY_MS = 500;
/** The latest a confirmation may run, after the quote's block's time: the quote is built within EVM_QUOTE_MAX_AGE_MS of
 *  it (stale_quote), so a log not settled by then refuses the quote and holds its claimant, leaving 10 s for the rest of
 *  the quote and the build (review of 9c2a87d5, R3-2: base-sepolia's maxLag is about 20 s of blocks). */
export const EVM_SELL_CONFIRM_BY_MS = 20_000;
/** The most of W's releases above the quote's block one provider's answer may hold: more is that provider's failure.
 *  A one-time W has few releases in flight; the device's own list has the same bound (EVM_SELL_SENT_MAX; review of
 *  9c2a87d5, R3-3). */
export const EVM_SELL_ABOVE_MAX = 64;

/** Which of `at`, the logs of W's in one block above the quote's block that only the provider `claimant` of `list` gave
 *  (one number and hash), are confirmed: a second provider holds the block by number with that hash and gives the log in
 *  it (eth_getLogs by blockHash). Every other provider is asked each round, and its answer is one of:
 *  - none: an error, a header of another number, an error to the logs by hash (review of 9c2a87d5, R3-1c), or a head
 *    at or past the block that does not hold it (review of e21c5611, R4-4);
 *  - behind: its head is below the block and within maxLag of it (R3-1a: a low head is no denial);
 *  - far: its head is more than maxLag below the block (no honest provider's head is that far ahead of another's);
 *  - reached: it holds the block, and the logs it gives there (none where the hash is another).
 *  A log any provider gives is confirmed. The rest are denied only once more than half of the whole list, as agreeing's
 *  vote counts it, has reached the block without them or is far (R3-1b; review of e21c5611, R4-1: on a list of two, one
 *  answer never decides): `denied`, and the claimant is held. Otherwise they are asked again every
 *  EVM_SELL_CONFIRM_EVERY_MS while a head below the block moves; when none moved for EVM_SELL_CONFIRM_WAIT_MS, or at
 *  `byMs` on `clock` (R3-2), the quote is refused (rpc_error) and the claimant held (R4-4), never built over the log. A
 *  head at or past the block is no move, so the wait is bounded. */
async function releasesConfirmed(at: readonly ReleaseLog[], list: readonly EvmRpc[], claimant: number, pool: string, wTopic: string, maxLag: bigint, clock: () => number, byMs: number): Promise<{ confirmed: ReleaseLog[]; denied: boolean }> {
  const e = at[0]!;
  const others = list.map((_, k) => k).filter((k) => k !== claimant);
  const confirmed = new Set<string>();
  const ok = () => at.filter((x) => confirmed.has(x.key));
  const need = Math.floor(list.length / 2) + 1;
  let [best, until] = [-1n, monotonic() + EVM_SELL_CONFIRM_WAIT_MS];
  for (;;) {
    let deny = 0;
    for (const k of others) {
      const who = `provider ${k + 1}`;
      try {
        const got = await ask(list[k]!, [
          { method: "eth_getBlockByNumber", params: [hx(e.block), false] },
          { method: "eth_getLogs", params: [{ address: pool, blockHash: e.hash, topics: [[TOPIC_WITHDRAWN, TOPIC_BOUGHT], wTopic] }] },
          { method: "eth_getBlockByNumber", params: ["latest", false] },
        ]);
        if ((got[0] as { result?: unknown } | null)?.result == null) {
          const head = header(got[2], who).number;
          if (e.block > head + maxLag) deny++;
          else if (head > best && head < e.block) [best, until] = [head, monotonic() + EVM_SELL_CONFIRM_WAIT_MS];
          continue;
        }
        const h = header(got[0], who);
        if (h.number !== e.block) continue;
        const r = (got[1] as { result?: unknown } | null)?.result;
        if (h.hash !== e.hash) deny++;
        else if (Array.isArray(r)) {
          const keys = new Set(r.map((l) => releaseLogOf(l, who, pool, wTopic).key));
          for (const x of at) if (keys.has(x.key)) confirmed.add(x.key);
          if (!at.every((x) => keys.has(x.key))) deny++;
        }
      } catch {
        continue;
      }
    }
    if (confirmed.size === at.length) return { confirmed: ok(), denied: false };
    if (deny >= need) {
      HOLD.get(list[claimant]!)?.();
      return { confirmed: ok(), denied: true };
    }
    if (monotonic() >= until) {
      HOLD.get(list[claimant]!)?.();
      return refuse("rpc_error", `W's release in block ${e.block} is not yet held by a second provider, and no other provider's head moved for ${EVM_SELL_CONFIRM_WAIT_MS / 1000} s`);
    }
    if (clock() >= byMs) {
      HOLD.get(list[claimant]!)?.();
      return refuse("rpc_error", `W's release in block ${e.block} is not held by a second provider ${EVM_SELL_CONFIRM_BY_MS / 1000} s after the quote's block`);
    }
    await new Promise((r) => setTimeout(r, EVM_SELL_CONFIRM_EVERY_MS));
  }
}

/** The quote's verdict on W's releases at its agreed block `block` (trade/evm/sell-releases.ts): the finalized block, the
 *  lower of two providers' (its number and its time each the lower), then W's Withdrawn and Bought from the block after
 *  it, on two providers that hold the agreed block by its hash: those up to the agreed block must be the same on both,
 *  and one above it counts where both gave it or a second provider confirms it (releasesConfirmed). `funding`: the buy
 *  that paid W the token this sale sells (the quote's token and boughtBlock). `clock`: the device's clock, in ms. */
async function sellReleasesRead(chain: EvmPoolChain, pool: string, w: string, rpcs: readonly EvmRpc[], block: Block, maxLag: bigint, sent: readonly EvmSellSent[], funding: { token: string; block: bigint }, clock: () => number): Promise<EvmSellReleases> {
  const fins = await agreeing(
    rpcs,
    async (rpc, k) => header((await ask(rpc, [{ method: "eth_getBlockByNumber", params: ["finalized", false] }]))[0], `provider ${k + 1}`),
    () => true,
    () => refuse("rpc_error", "the providers gave no finalized block"),
    false,
  );
  const n = block.number;
  const low = (x: bigint, y: bigint) => (x < y ? x : y);
  const fin = { number: low(low(fins.a.number, fins.b.number), n), timestamp: low(low(fins.a.timestamp, fins.b.timestamp), block.timestamp) };
  if (n - fin.number > EVM_SELL_TAIL_MAX) return refuse("rpc_error", `the finalized block ${fin.number} is more than ${EVM_SELL_TAIL_MAX} blocks below the quote's ${n}`);
  // pages from the block after the finalized one (from the agreed block itself where that is final), the last to "latest"
  const pages: [bigint, bigint | null][] = [];
  for (let a = low(fin.number + 1n, n); ; a += EVM_SELL_TAIL_PAGE) {
    if (a + EVM_SELL_TAIL_PAGE - 1n >= n) {
      pages.push([a, null]);
      break;
    }
    pages.push([a, a + EVM_SELL_TAIL_PAGE - 1n]);
  }
  const wTopic = "0x" + word(BigInt(w));
  const logsOf = async (rpc: EvmRpc, k: number) => {
    const who = `provider ${k + 1}`;
    const out: ReleaseLog[] = [];
    // two pages a batch, each with the agreed block's header, which must be the quote's (CALLS_PER_BATCH)
    for (let i = 0; i < pages.length; i += CALLS_PER_BATCH - 1) {
      const part = pages.slice(i, i + CALLS_PER_BATCH - 1);
      const calls: EvmRpcCall[] = [
        ...part.map(([a, b]) => ({ method: "eth_getLogs", params: [{ address: pool, fromBlock: hx(a), toBlock: b === null ? "latest" : hx(b), topics: [[TOPIC_WITHDRAWN, TOPIC_BOUGHT], wTopic] }] })),
        { method: "eth_getBlockByNumber", params: [hx(n), false] },
      ];
      const got = await askAt(rpc, calls);
      if (header(got[part.length], who).hash !== block.hash) return refuse("rpc_disagree", `${who} does not hold the quote's block ${n}`);
      for (let p = 0; p < part.length; p++) {
        const r = (got[p] as { result?: unknown } | null)?.result;
        if (!Array.isArray(r)) return refuse("rpc_error", `${who} answered no logs of W's releases`);
        for (const l of r) out.push(releaseLogOf(l, who, pool, wTopic));
      }
    }
    const keys = new Set(out.map((e) => e.key));
    if (keys.size !== out.length) return refuse("rpc_error", `${who} answered a release log twice`);
    if (out.filter((e) => e.block > n).length > EVM_SELL_ABOVE_MAX) return refuse("rpc_error", `${who} answered more than ${EVM_SELL_ABOVE_MAX} of W's releases above the quote's block ${n}`);
    return out.filter((e) => e.block > fin.number).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  };
  const upTo = (x: readonly { block: bigint; key: string }[]) => x.filter((e) => e.block <= n).map((e) => e.key).join(";");
  // the order agreeing indexes, taken as it starts
  const list = [...rpcs];
  const { a, b, i, j } = await agreeing(
    rpcs,
    logsOf,
    (x, y) => upTo(x) === upTo(y),
    () => refuse("rpc_disagree", `the providers give W's releases up to block ${n} differently`),
  );
  // above the agreed block: a log both gave counts; one only one gave counts once a second provider confirms it, asked
  // block by block, and a claimant's first denial drops the rest it alone gave (review of 9c2a87d5, R3-3)
  const aboveOf = (x: readonly ReleaseLog[]) => new Map(x.filter((e) => e.block > n).map((e) => [e.key, e]));
  const [inA, inB] = [aboveOf(a), aboveOf(b)];
  const above = [...inA.values()].filter((e) => inB.has(e.key));
  const byMs = Number(block.timestamp) * 1000 + EVM_SELL_CONFIRM_BY_MS;
  for (const [claimant, mine, theirs] of [[i, inA, inB], [j, inB, inA]] as const) {
    const blocks = new Map<string, ReleaseLog[]>();
    for (const e of mine.values()) if (!theirs.has(e.key)) blocks.set(`${e.block}:${e.hash}`, [...(blocks.get(`${e.block}:${e.hash}`) ?? []), e]);
    for (const at of [...blocks.values()].sort((x, y) => (x[0]!.block < y[0]!.block ? -1 : x[0]!.block > y[0]!.block ? 1 : 0))) {
      const { confirmed, denied } = await releasesConfirmed(at, list, claimant, pool, wTopic, maxLag, clock, byMs);
      above.push(...confirmed);
      if (denied) break;
    }
  }
  const strip = ({ kind, block: at, nullifier, token }: ReleaseLog): EvmReleaseLog => ({ kind, block: at, nullifier, token });
  return evmSellReleasesAt({ chain, w, block: n, fin, agreed: a.filter((e) => e.block <= n).map(strip), above: above.map(strip), sent, funding });
}

// Every quote evmPoolSellQuote returned: the sell builder (trade/evm/sell.ts) builds only from one of these
const QUOTED_SELLS = new WeakSet<EvmPoolSellQuote>();
/** True when `q` is a quote evmPoolSellQuote returned, unchanged (it is frozen). */
export const evmIsDeviceSellQuote = (q: unknown): q is EvmPoolSellQuote => typeof q === "object" && q !== null && QUOTED_SELLS.has(q as EvmPoolSellQuote);

// The evidence for a ban (card evm-sell-hook-converge; review of 919742f5, F2). A quote's route through a hook the venue
// does not list (its `hooked` pools) may revert the real sale. The device bans a pool only on evidence from its own
// reads on the chain's pinned providers, each answer the same on two of them (agreeing), never on a revert alone and
// never on a server's word:
// 1. the sale: the transaction and its receipt agree; its status is 0x0, it went to the quote's W, and its call reads
//    back as the quote's own sale (SellDelegate.sell of the quote's token, amount, minOut and target, its data the
//    route the quote holds: the sell builder's bytes, sell-unpinned.ts evmSellRouteOf);
// 2. the replay: the transaction as an eth_call at its block's parent, from its sender with its fees and its own gas
//    (less its authorizations' intrinsic cost), the sender's balance its own, never overridden: a hook sees in the replay
//    the gas and the balances it saw in the trade, so one keyed on either fails both (review of a2d82dc6, F1: a replay
//    with more gas, or a balance set apart, told every hook it was being replayed). The gas is the sender's pick, bound
//    on the sender's side: a sale is evidence only at the gas the device pins and its sim ran at (EVM_POOL_SELL_GAS); a
//    buy below main's pool's floor reverts SwapGasTooLow (no evidence), and above it the helper sends a buy only after
//    its eth_call at that very gas answers true, so an honest hook is starved only by a hostile sender or by a route's
//    gas rising between that eth_call and the block the buy lands in (the helper's gas margin, card evm-buy-gas-depth),
//    a ban that expires; W's code the 7702 designator of the chain's pinned sell delegate (the sale carries its own
//    authorization); the block as the trade saw it: eth_call's block override sets the trade's block's number, time and
//    base fee, and on Base its PREVRANDAO (every pinned Base and Robinhood provider ran Multicall3's getBlockNumber,
//    getCurrentBlockTimestamp and getBasefee under one, 2026-11-07 04:44Z and 13:55Z, and Base's four its
//    getCurrentBlockDifficulty), and a state override sets the storage the block's system calls wrote before its first
//    transaction (evmSystemSlotsOf: Base's L1Block, both chains' block-hash history, Base's beacon roots), so a hook
//    keyed on any of them sees the trade's values and fails on both providers with the same answer (a sale reverts; a
//    buy returns false, its swap undone). Per chain, what still differs from the trade:
//    - both: the gas limit and coinbase are the parent header's, equal to the trade's block's but at a gas-limit change
//      (Base's coinbase is its fee vault 0x4200…0011; Nitro's a constant); and the state an earlier transaction of the
//      block changed (HC2 below);
//    - Robinhood (Nitro): the writes of ArbOS's block-start transaction, which runs before a block's first transaction
//      and keeps its results in ArbOS's own hashed storage (no override here models it: its layout is Nitro's, by ArbOS
//      version). Two are open, and a hook keyed on either escapes in the blocks where it steps:
//      - the L1 block number, which NUMBER answers from ArbOS's state, never the override (at L2 block 108,429,325 the
//        replay and the block itself both answered 0x1924523): the replay sees the parent's, which differs where the L1
//        number steps, about 1 L2 block in 120 (an L1 block every ~12 s, ~10 L2 blocks a second);
//      - the gas-pricing backlog, which any contract reads through ArbGasInfo (0x…6c, getGasPricingConstraints on
//        mainnet's ArbOS 116, getGasBacklog on the testnet): the block start decays it by the time passed, so in a block
//        whose time stepped the trade reads the decayed backlog while BASEFEE (the header's, set in the replay) is still
//        the pre-decay price, and the replay reads the parent's backlog; that held in 4 of 4 such blocks of 41 on
//        rpc.mainnet.chain.robinhood.com and 4 of 4 of 37 on robinhood.drpc.org (review of ca907a05, HIGH 1,
//        2026-11-07 ~14:35Z), about 1 block in 10.
//      Neither can enter a replay: Nitro refuses any state override of ArbOS's state account (EVM_ARBOS_STATE). On
//      Robinhood mainnet the trade's own trace closes what it can (step 2b), and its errored frames hold the as-is leg
//      for a hook keyed on either that reverts.
//      A trade with poster gas (its receipt's gasUsedForL1 above 0) is no evidence at all (below); every one is 0 today;
// 2b. the trade's true pre-state, where the chain has a trace pair (preStateOf; Robinhood mainnet: venue
//    traceProviders, dRPC and Pocket): the trade's own debug_traceTransaction, prestateTracer (disableCode) and
//    callTracer each its own request on each provider, each with its own byte cap, each equal as JSON on both apart
//    (tracedPre),
//    its root frame the transaction's own call (from, to, input, value) and its transaction's index its receipt's,
//    within the bounds the gas the trade used sets (preBounds: what any trade can touch). The prestate, every account but
//    ArbOS's state and no code, is the replay's state override over the system slots: the state the trade read at its
//    start, after every earlier transaction of its block, so a hook flipped by one (HC2) sees in the replay what it saw
//    in the trade; step 3's market reads the same state. Where the replay as the trade ran passes anyway (a hook keyed
//    on ArbOS's state, which no override carries), the as-is leg holds only on the route's unlisted hooks whose own
//    frame errored on an unbroken chain of errored frames from the trade's first frame into the PoolManager (nothing
//    caught it), called by a PoolManager frame the trade's own target (W for a sale, the pool for a buy) or the pinned
//    v4 adapter entered, the outermost route hook on it: the hook reverted in the trade itself, read from the trace
//    (never from the route alone), never a listed hook's frame nor the PoolManager's; those hooks alone are at fault
//    (step 4 asks no set). Where the replay fails and step 4 rescues nothing, the hooks the callTracer names so are at
//    fault too: a hook an earlier transaction of the block armed can make its own no-op pool fail as well (by its pool's
//    price or liquidity), and its own frame is then the only witness (review of 1ee73a00, 1). A trace whose prestate
//    differs between the two, or whose prestate or callTracer both answer past its bounds or not as the trade's own
//    call, adds nothing: the evidence runs at the parent block as it does without one. A callTracer no provider
//    answered (a hook can flood its frames past callBytes at no gas: review of fb923143, 1) or the two answered apart
//    (one provider alone can: review of 1ee73a00, 2) beside a prestate both did keeps the prestate for the replay and
//    step 3; only the as-is leg is unread. Thrown (rpc_error, its message containing EVM_TRACE_UNANSWERED) wherever a
//    trace left unanswered could still change the answer: the as-is leg unread where the replay passed, or where it
//    failed and step 4 rescued nothing; and, with the prestate unread, the [] of a market that did not hold (step 3)
//    and of a step 4 that rescued nothing, both read on the parent basis the pre-state could turn into a ban (review of
//    fb923143, 2). Every other answer is final. Still open there, each costing a failed try each time it is taken,
//    never a ban on an honest hook:
//    - a hook keyed on ArbOS's state that fails the trade without its own frame reverting: a fee through a delta, or a
//      return the PoolManager refuses (a wrong selector, or a delta larger than the swap);
//    - a hook keyed on ArbOS's state that floods the callTracer past its bytes (preBounds: a frame's input costs no gas
//      where it passes memory already paid for): the as-is leg is never read for it, so its replay, which passes,
//      throws EVM_TRACE_UNANSWERED on every ask (a hook an earlier transaction flipped that floods is still banned: the
//      prestate it cannot inflate holds its replay);
//    - a hook keyed on an earlier transaction of the block that reads code an earlier transaction of the block deployed
//      (the prestate carries no code, so the replay sees the parent's);
//    - a hook that, once an earlier transaction armed it, fails the quoter too: step 3 reads the market at the trade's
//      pre-state, so the market did not hold and nothing is banned;
//    - a hook an earlier transaction armed that reverts the trade in its own frame, gives the quoter alone an
//      unsettled delta (V4Quoter reverts inside unlock, so nothing settles it), and fails its own no-op pool by the
//      price or liquidity that earlier transaction moved, while it floods the callTracer: no set rescues the replay and
//      the as-is leg is unread, so it throws EVM_TRACE_UNANSWERED on every ask (review of 1ee73a00, 1; the same hook
//      with the callTracer read is banned on its errored frame, and where it has the beforeSwap permission a stored
//      dynamic LP fee it raised cannot fail the evidence's second-pass no-op, EVM_EVIDENCE_NOOP_HOOK_CODE, even under a
//      flood);
//    - the same with a hook without the beforeSwap permission, on a dynamic-fee pool: it raised the stored LP fee (to
//      as much as 100%), and gives the quoter alone an afterSwap return delta that offsets it, unsettled in V4Quoter;
//      no beforeSwap is ever called for it, so every no-op leaves the stored fee, and where that fee alone fails
//      minOut none rescues: banned on its errored frame with the callTracer read, and under a flood
//      EVM_TRACE_UNANSWERED on every ask (review of d6d055bf, info; with a smaller fee a no-op rescues and it is
//      banned).
//    Base and Base Sepolia have no such pair (one keyless company serves traces there): their replay stays at the parent
//    block (card evm-sell-hook-intrablock-base); so does Robinhood's testnet (none of its pinned providers serves a
//    trace);
// 3. the market held: V4Quoter, at the parent block with the replay's own state and block (the system slots and, where
//    it is read, the trade's traced pre-state; the block's number, time and base fee), prices the quote's route with its
//    hooks as they are at the quote's minOut or more, so the price did not move: the hooks treated the sale and the
//    quoter apart. A price that moved, by the market or by an attacker before the sale (in an earlier block, or earlier
//    in the trade's own: review of f0f983d2, item 4, and of de4e3ed5, 1), bans nothing, even where an honest hook's own
//    fee (one taken through a delta, which the quoter sees) is more than the miss;
// 4. the hooks at fault: for each set of the hooks behind a pool of `hooked`, smallest first (at most 15: a route is at
//    most EVM_POOL_MAX_HOPS hops), the replay with that set's code replaced by a no-op at once succeeds on both
//    providers (the trade held its minOut), and no smaller set's did, in two passes over every set, each its own
//    smallest sets: the no-op EVM_NOOP_HOOK_CODE (the pool's stored fee) and EVM_EVIDENCE_NOOP_HOOK_CODE (LP fee 0).
//    The stored-fee pass's sets count, or the fee-0 pass's where the first has none (review of d6d055bf, 1: fee 0 alone
//    would also rescue an honest pool whose stored fee is more than a hostile hook's skim beside it), and a stored-fee
//    set that holds smaller fee-0 sets gives way to them (review of 2fccaa67, 1: an honest hook whose fee every no-op
//    removes beside a stored-fee bait is otherwise banned as half of the pair the stored-fee pass rescues). Worst case,
//    once the replay failed: 30 replays per provider (15 sets a pass), beside the as-is replay. That set's code together
//    stood between the trade and its minOut (a hook's error, WrappedError; a fee taken from the trade alone through a delta, MinOutNotMet;
//    a malformed answer; gas burned; hooks that each revert the trade while any other is intact), and the override
//    replaces it for every pool behind it, so every pool of the route behind a hook of such a smallest set is banned,
//    each by its PoolId (two pools an attacker built on one hook would otherwise freeze the trade). A hook outside every
//    smallest set is never banned: an honest hook beside two that each revert the trade is left in, and the trade
//    succeeds (review of 72e28658, H3: leaving one in at a time let three hooks that cover each other escape).
//    Still open: an honest hook whose fee every no-op removes (a fee through a delta, or a dynamic pool's beforeSwap
//    override over a stored fee of 0) is itself a smallest set beside a hostile hook that skims the trade by less than
//    that fee, so both pools are banned (review of d6d055bf, info, case 7f8; its own card): the rule cannot tell an
//    honest fee removed from a skim removed. On the same card, each costing an honest pool banned and the hostile hooks
//    left for a later failed try, since step 4's reads are the same as in a case the yield exists for:
//    - M (2 hooks, the mirror of review of 2fccaa67, 1): a hostile hook whose own no-op cannot rescue (an earlier
//      transaction of the block moved its pool's price) skims the trade by less than an honest hook's stored dynamic
//      fee beside it; only the pair rescues at the stored fee and the honest hook alone at fee 0, so the pair yields to
//      the honest hook (review of 6e8d18ad, M; the same reads as the bait it exists for, there E3);
//    - Y (3 hops): two hostile hooks around an honest one each need its fee; the stored-fee sets are the two pairs that
//      hold the honest hook, the fee-0 sets the honest hook alone and the hostile pair, which lies outside every
//      stored-fee set and so is dropped: the honest hook alone is banned (review of 6e8d18ad, Y; the same reads as X);
//    - C (at every version): a hostile hook that checks another hook's code (EXTCODEHASH under the replay's state
//      override) pays the trade whole once that honest hook is replaced, and its own no-op cannot rescue (a price an
//      earlier transaction moved): the honest hook is the only smallest set (review of 6e8d18ad, info).
// The evidence rule covers any set of the route's hooks; each ban is the route the device itself picked, on providers
// that agree, after the replay as it ran failed at the trade's own gas and the market held, and every ban expires. Anything
// else bans nothing: providers that disagree, a trade that did not fail, a replay that does not fail, a failure that no
// set of the hooks explains and no hook's own errored frame names (step 2b), a chain with no pinned sell delegate. A provider that
// does not answer (rpc_error) is thrown, so the caller may ask again.
// HC2: a hook flipped by a transaction earlier in the trade's own block leaves no evidence at the parent block. Every
// block has such transactions that cost an attacker nothing: its system calls, the OP Stack's L1-attributes deposit
// among them. On Base those writes are closed here (evmSystemSlotsOf: L1Block, EIP-4788 and EIP-2935); any other
// earlier transaction's (an attacker's own, landed ahead of the trade, or anyone's) stays open on Base and Base Sepolia
// until card evm-sell-hook-intrablock-base, so such a hook is never banned there and can freeze the trade. On Robinhood
// mainnet the trade's own trace narrows it (step 2b) for buys and sales alike: the replay at the trade's pre-state bans
// a hook an earlier transaction flipped, and its errored frames ban a reverting hook keyed on ArbOS's block-start writes
// (the L1 block number, about 1 block in 120, and the gas backlog's decay, about 1 in 10); the cases step 2b names stay
// open there.

/** The PoolIds of the quote's `hooked` pools that the sale `txHash`'s revert proves at fault (see above), on the
 *  chain's pinned providers; [] where nothing is proved. The caller bans these (wallet pool/evm-sell-bans.ts).
 *  An EvmQuoteError rpc_error whose message contains EVM_TRACE_UNANSWERED (the message is "rpc_error: " + that text +
 *  ": " + the hash) is the trade's trace left unanswered where it could still change the answer (step 2b): the trace of a
 *  landed trade does not change, so asking again helps only while a provider is down; a caller should ask again a few
 *  times, then take it as nothing proved (a hook that floods the callTracer is left in, costing a failed try each time,
 *  never a ban on an honest hook). EVM_TRACE_UNANSWERED is not in the kit's index, so an app reads it from the message.
 *  Nothing asks again yet: no production code calls this function (the wallet's pool/evm-sell-bans.ts stores the bans a
 *  caller hands it), the kit's tests assert the error once per case without asking again, and no live check calls it. */
export async function evmSellRevertedPools(quote: EvmPoolSellQuote, txHash: string): Promise<readonly string[]> {
  if (!evmIsDeviceSellQuote(quote)) return refuse("bad_request", "a ban is proved only against a quote evmPoolSellQuote returned");
  const p = venue(quote.chain).providers;
  if (p === undefined) return refuse("no_quoter", `${quote.chain} has no pinned providers`);
  return evmSellRevertedPoolsWith(quote, txHash, evmProviders(evmRanked(p), fetch));
}

const SEL_SELL = "0c2cb9ca"; // a literal, never a top-level call (the kit's index reaches the signing page's bundle): SellDelegate.sell((address,uint256,address,bytes,uint256,address,uint256,uint256,address,uint256,uint256),uint256,bytes)
/** One provider's answer to a replay: its result, or a revert with its data ("" for none); anything else is a refusal. */
type Replay = { ok: true; result: string } | { ok: false; data: string };
function replayOf(a: unknown, who: string): Replay {
  const hex = (x: unknown): x is string => typeof x === "string" && x.length <= MAX_ANSWER_HEX && /^0x([0-9a-fA-F]{2})*$/.test(x);
  if (typeof a !== "object" || a === null) return refuse("rpc_error", `${who} answered no object`);
  const o = a as { result?: unknown; error?: { data?: unknown } };
  if (Object.hasOwn(o, "result")) return hex(o.result) ? { ok: true, result: o.result.toLowerCase() } : refuse("rpc_error", `${who} answered a replay with a result that is not hex`);
  if (reverted(a)) return { ok: false, data: hex(o.error?.data) ? o.error!.data.toLowerCase() : "" };
  return refuse("rpc_error", `${who} answered a replay with an error that is no revert: ${String((o.error as { message?: unknown } | undefined)?.message).slice(0, 120)}`);
}
/** A JSON-RPC answer's result as an object, or a refusal. */
function resultOf(a: unknown, who: string, what: string): Record<string, unknown> {
  const r = (a as { result?: unknown } | null)?.result;
  if (typeof r !== "object" || r === null) return refuse("rpc_error", `${who} holds no ${what}`);
  return r as Record<string, unknown>;
}
const str = (r: Record<string, unknown>, k: string, who: string): string => {
  const v = r[k];
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v) || v.length > 2 + 2 * 65536) return refuse("rpc_error", `${who}'s ${k} is not hex`);
  return v.toLowerCase();
};
/** A JSON-RPC quantity of the answer `r`: 0x and 1 to 64 hex digits, so every BigInt of it parses ("0x", which `str`
 *  takes for a byte string such as an input, is no number: review of fb923143, question 5); else a refusal. */
const num = (r: Record<string, unknown>, k: string, who: string): string => {
  const v = r[k];
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) return refuse("rpc_error", `${who}'s ${k} is not a number`);
  return v.toLowerCase();
};

/** A reverted trade's transaction and receipt, the same on two of the providers `rpcs` (steps 1 of a sale's and a buy's
 *  evidence). */
type Trade = { hash: string; from: string; to: string; input: string; gas: string; value: string; fees: Record<string, string>; auths: number; blockHash: string; blockNumber: string; index: string; status: string; rcHash: string; rcBlock: string; rcIndex: string; gasUsed: string; logs: string[]; l1Gas: string };
/** A receipt's logs, each its address and first topic ("<address>:<topic0>"), in order; at most 256 are read. */
function logsOf(rc: Record<string, unknown>, who: string): string[] {
  const ls = rc.logs;
  if (ls === undefined) return [];
  if (!Array.isArray(ls) || ls.length > 256) return refuse("rpc_error", `${who}'s receipt logs are not a list of at most 256`);
  return ls.map((l) => {
    const o = (typeof l === "object" && l !== null ? l : {}) as Record<string, unknown>;
    const topics = o.topics;
    const t0 = Array.isArray(topics) && typeof topics[0] === "string" && /^0x[0-9a-fA-F]{64}$/.test(topics[0]) ? topics[0].toLowerCase() : "";
    return `${str(o, "address", who)}:${t0}`;
  });
}
async function tradeOf(rpcs: EvmRpc[], h: string): Promise<Trade> {
  const { a: sale } = await agreeing(
    rpcs,
    async (rpc, k) => {
      const who = `provider ${k + 1}`;
      const [t, r] = await askAt(rpc, [{ method: "eth_getTransactionByHash", params: [h] }, { method: "eth_getTransactionReceipt", params: [h] }]);
      const tx = resultOf(t, who, "transaction"), rc = resultOf(r, who, "receipt");
      const auths = tx.authorizationList;
      const fees: Record<string, string> = typeof tx.maxFeePerGas === "string" ? { maxFeePerGas: num(tx, "maxFeePerGas", who), maxPriorityFeePerGas: num(tx, "maxPriorityFeePerGas", who) } : { gasPrice: num(tx, "gasPrice", who) };
      return {
        hash: str(tx, "hash", who), from: str(tx, "from", who), to: typeof tx.to === "string" ? str(tx, "to", who) : "", input: str(tx, "input", who), gas: num(tx, "gas", who), value: num(tx, "value", who), fees,
        auths: Array.isArray(auths) ? auths.length : 0, blockHash: str(tx, "blockHash", who), blockNumber: num(tx, "blockNumber", who), index: num(tx, "transactionIndex", who),
        status: num(rc, "status", who), rcHash: str(rc, "transactionHash", who), rcBlock: str(rc, "blockHash", who), rcIndex: num(rc, "transactionIndex", who), gasUsed: num(rc, "gasUsed", who), logs: logsOf(rc, who),
        // Nitro's poster gas, charged inside the trade's gas limit (none on Base: its receipts carry no gasUsedForL1)
        l1Gas: rc.gasUsedForL1 === undefined ? "0x0" : num(rc, "gasUsedForL1", who),
      };
    },
    (x, y) => JSON.stringify(x) === JSON.stringify(y),
    () => refuse("rpc_disagree", `the providers answer the sale ${h} differently`),
  );
  return sale;
}

// The storage a block's own system calls write before its first transaction, which a replay at the parent block would
// otherwise see as the parent left it (review of da11bbb6, H1: a hook keyed on L1Block's sequenceNumber told every
// replay from the trade). Each account takes writes from its system caller only, so its storage at the end of the
// trade's block is what every transaction in the block saw; read 2026-11-07 13:45-14:05Z on the pinned providers
// (eth_getCode, eth_getStorageAt and eth_call at a block and at its parent):
// - Base and Base Sepolia (OP Stack): L1Block (0x4200…0015), written by the block's L1-attributes deposit. Its
//   implementation 0x8bde8f549f56d405f07e1aa15df9e1fc69839881 answers version() 1.8.0, whose storage layout
//   (ethereum-optimism/optimism, packages/contracts-bedrock/snapshots/storageLayout/L1Block.json, unchanged from
//   3c82c3f761 to the parent of e7a1f70331, where L1Block.sol returns "1.8.0") holds slots 0 to 8 (number, timestamp,
//   basefee, hash, sequenceNumber and the fee scalars, batcherHash, l1FeeOverhead, l1FeeScalar, blobBaseFee, the
//   operator fee and daFootprintGasScalar); slots 0 to 15 are read. EIP-4788's beacon roots (the two slots get(the
//   block's time) reads: a replay at an epoch's first block reverted where the trade's block answered) and EIP-2935's
//   history (slot (N-1) % 8191: every replay answered a hash 8,191 blocks old for block N-1).
// - Robinhood and its testnet (Arbitrum Nitro): no L1Block and no EIP-4788; EIP-2935's history is ArbOS's, its ring
//   393,168 blocks (its code's 0x05ffd0), slot (N-1) % 393168, the replay's answer stale as on Base. ArbOS's own
//   block-start writes (the L1 block number, the gas-pricing backlog) are not here: step 2 of the evidence names them.
/** The system slots of block `n` at time `time` on `chain`, each account's slots as numbers (tests only). Not in the index. */
export function evmSystemSlotsOf(chain: EvmPoolChain, n: bigint, time: bigint): [string, bigint[]][] {
  if (chain === "base" || chain === "base-sepolia") return [[EVM_L1_BLOCK, Array.from({ length: 16 }, (_, i) => BigInt(i))], [EVM_BEACON_ROOTS, [time % 8191n, (time % 8191n) + 8191n]], [EVM_HISTORY, [(n - 1n) % 8191n]]];
  if (chain === "robinhood" || chain === "robinhood-testnet") return [[EVM_HISTORY, [(n - 1n) % 393168n]]];
  return [];
}
const EVM_L1_BLOCK = "0x4200000000000000000000000000000000000015";
const EVM_BEACON_ROOTS = "0x000f3df6d732807ef1319fb7b8bb8522d0beac02";
const EVM_HISTORY = "0x0000f90827f1c53a10cb7a02335b175320002935";

// The trade's true pre-state (card evm-sell-hook-intrablock): the state it saw at its start, after its block's start
// and every earlier transaction of the block, where a replay at the parent block sees the parent's (HC2: a hook flipped
// by an earlier transaction; on Robinhood, ArbOS's block-start writes). `pre` is chosen per chain in one place
// (preStateOf); a chain with none replays at the parent block with its system slots (evmSystemSlotsOf) as before.
/** A replay's state override for one account. */
type Override = { balance?: string; nonce?: string; code?: string; stateDiff?: Record<string, string> };
/** The trade's pre-state as a state override, and the callees of the trade's own frames that errored (lowercased,
 *  sorted), each read from its trace. */
type Pre = { over: Record<string, Override>; errored: string[] | undefined };
/** The text in the message of the rpc_error thrown where the trade's trace was not answered and could still change the
 *  answer (step 2b; the message is "rpc_error: " + this + ": " + the trade's hash): its own reason, apart from a provider
 *  that did not answer any other read, so a caller can bound how often it asks again. */
export const EVM_TRACE_UNANSWERED = "the trade's trace was not answered and could still change the answer";
// ArbOS's state account (Nitro): every pinned Robinhood provider refuses a state override of it, -32000 "overriding
// address 0xA4b05FffffFffFFFFfFFfffFfffFFfffFfFfFFFf not allowed" (rpc.mainnet.chain.robinhood.com, robinhood.drpc.org
// and robinhood-rpc.publicnode.com, 2026-11-07 16:22Z, on the prestate of six transactions and on a one-slot stateDiff),
// so a replay never carries the gas backlog or the L1 block number ArbOS keeps there; the replay with it left out answered
// the transaction's own output on all three for 4 of 4 that succeeded, and reverted for 3 of 3 that reverted (one more
// that succeeded reverted in the replay: a replay can differ, so no gate trusts one alone).
const EVM_ARBOS_STATE = "0xa4b05fffffffffffffffffffffffffffffffffff";
// The bounds of a trace, from the gas the trade used, its receipt's gasUsed and a quarter more, since a refund returns at
// most a fifth of the gas spent (EIP-3529) (review of f0f983d2, item 3; of de4e3ed5, 5: the sender's limit could be 32M
// and its answers 164 MB): what any trade can touch, so no hook can pass them at any size and turn the trace off. A new
// account costs at least 2,400 gas (EIP-2930's access-list price; a cold touch EIP-2929's 2,600) and a new storage slot
// 1,900 (2,100 cold), past a few the transaction touches
// for free (its sender, target, coinbase, the precompiles: 64 of each); ArbOS's own state is read uncharged at the
// transaction's start (15 slots in each trace read 2026-11-07) and by its precompiles at 800 gas a slot; a call frame
// costs at least 100 (a warm CALL). The prestate is asked with disableCode (dRPC and Pocket both take it: 21 accounts,
// 272,424 bytes with code and 21,410 without, 2026-11-07 19:04Z), so its answer is at most `preBytes`, and the
// callTracer's, `callBytes`, each provider read with each cap for its own tracer. Its inputs are not bounded by gas (a
// frame may pass memory already paid for), so a hook can flood the callTracer past `callBytes`: that is an unanswered
// callTracer, which leaves the prestate read and only the as-is leg unread (step 2b). Gas is held at 64M, past Robinhood's block limit. The override is sent again with every replay of the evidence (the trade as it ran and each
// set of hooks asked, at most 16, on two providers each); a ban is read after the trade, never on a quote's path.
/** The bounds of the trace of a trade that used `gas`, with a quarter more. */
function preBounds(gas: bigint) {
  const used = (gas * 5n) / 4n;
  const g = Number(used < 0n ? 0n : used > 64_000_000n ? 64_000_000n : used);
  const accounts = Math.floor(g / 2400) + 64;
  const slots = Math.floor(g / 1900) + 64;
  const arbosSlots = Math.floor(g / 800) + 256;
  const frames = Math.floor(g / 100) + 2;
  return { accounts, slots, arbosSlots, frames, preBytes: 8192 + 512 * accounts + 192 * (slots + arbosSlots), callBytes: 8192 + 512 * frames };
}
type Bounds = ReturnType<typeof preBounds>;

/** A prestateTracer answer (asked with disableCode) as a state override, every account but ArbOS's state, no code;
 *  null where it is not one within the bounds `b`. Keys sorted and lowercased, so two providers' answers compare as
 *  JSON. */
function preOverOf(r: unknown, b: Bounds): Record<string, Override> | null {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
  const accounts = Object.entries(r as Record<string, unknown>);
  if (accounts.filter(([a]) => lower(a) !== EVM_ARBOS_STATE).length > b.accounts) return null;
  const hex = (x: unknown, re: RegExp, max = 66): x is string => typeof x === "string" && x.length <= max && re.test(x);
  const out: Record<string, Override> = {};
  let slots = 0;
  for (const [a, v] of accounts.sort(([x], [y]) => (lower(x) < lower(y) ? -1 : 1))) {
    if (!isAddress(a) || typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const arbos = lower(a) === EVM_ARBOS_STATE;
    const o = v as { balance?: unknown; nonce?: unknown; storage?: unknown };
    const one: Override = {};
    if (o.balance !== undefined) {
      if (!hex(o.balance, /^0x[0-9a-fA-F]{1,64}$/)) return null;
      one.balance = lower(o.balance);
    }
    if (o.nonce !== undefined) {
      const n = typeof o.nonce === "number" && Number.isSafeInteger(o.nonce) && o.nonce >= 0 ? BigInt(o.nonce) : hex(o.nonce, /^0x[0-9a-fA-F]{1,16}$/) ? BigInt(o.nonce) : null;
      if (n === null) return null;
      one.nonce = qty(n);
    }
    if (o.storage !== undefined) {
      if (typeof o.storage !== "object" || o.storage === null || Array.isArray(o.storage)) return null;
      const st = Object.entries(o.storage as Record<string, unknown>);
      if (arbos ? st.length > b.arbosSlots : (slots += st.length) > b.slots) return null;
      const d: Record<string, string> = {};
      for (const [k, w] of st.sort(([x], [y]) => (lower(x) < lower(y) ? -1 : 1))) {
        if (!hex(k, /^0x[0-9a-fA-F]{64}$/) || !hex(w, /^0x[0-9a-fA-F]{64}$/)) return null;
        d[lower(k)] = lower(w);
      }
      if (st.length > 0) one.stateDiff = d;
    }
    if (!arbos) out[lower(a)] = one;
  }
  return out;
}
/** The route's hooks `hooks` whose own frame errored in a callTracer answer for `sale` (lowercased, sorted): a frame the
 *  PoolManager `pm` called into the hook, on an unbroken chain of errored frames from the trade's first frame into `pm`
 *  (so nothing caught the revert: a frame from anyone else, or one under a frame that did not error, never counts), and
 *  the outermost route hook on that chain (a hook under another never counts); null where the answer is not the trade's
 *  own call (its root frame's from, to, input and value the transaction's) or passes `frames` (reviews of 29498693 and
 *  f0f983d2). */
function erroredOf(r: unknown, sale: Trade, pm: string | undefined, adapter: string | undefined, hooks: readonly string[], frames: number): string[] | null {
  type Frame = { from?: unknown; to?: unknown; input?: unknown; value?: unknown; error?: unknown; calls?: unknown };
  const root = r as Frame | null;
  if (typeof root !== "object" || root === null) return null;
  const q = (x: unknown) => (typeof x === "string" && /^0x[0-9a-fA-F]{0,64}$/.test(x) ? BigInt(x === "0x" ? "0" : x) : null);
  if (!isAddress(root.from) || lower(root.from) !== sale.from || !isAddress(root.to) || lower(root.to) !== sale.to || typeof root.input !== "string" || lower(root.input) !== sale.input || q(root.value ?? "0x0") !== BigInt(sale.value)) return null;
  const route = new Set(hooks.map(lower));
  const out = new Set<string>();
  // each frame with what its chain from the root says: inPm, under the trade's first frame into pm; unbroken, every
  // frame from that one down errored; underHook, under a route hook's frame already counted; byOwn, its caller is a pm
  // frame the trade's own target or the pinned v4 adapter entered (a hook frame reached through a call the device's
  // swapper never made, a token's own swap inside the unlock, never counts: review of de4e3ed5, 3)
  const own = new Set([lower(sale.to), ...(adapter !== undefined ? [lower(adapter)] : [])]);
  type At = { f: Frame; inPm: boolean; unbroken: boolean; underHook: boolean; byOwn: boolean };
  const stack: At[] = [{ f: root, inPm: false, unbroken: false, underHook: false, byOwn: false }];
  for (let n = 0; stack.length > 0; n++) {
    if (n >= frames) return null;
    const { f, inPm, unbroken, underHook, byOwn } = stack.pop()!;
    if (typeof f !== "object" || f === null) return null;
    const errored = typeof f.error === "string" && f.error.length > 0;
    const enters = !inPm && isAddress(f.to) && lower(f.to) === pm;
    const chain = enters ? errored : inPm && unbroken && errored;
    const hook = (inPm || enters) && chain && !underHook && byOwn && isAddress(f.from) && lower(f.from) === pm && isAddress(f.to) && lower(f.to) !== pm && route.has(lower(f.to));
    if (hook) out.add(lower(f.to as string));
    if (f.calls !== undefined) {
      if (!Array.isArray(f.calls)) return null;
      // bounded before it is walked: a spread of a huge array throws before any cap
      if (stack.length + f.calls.length > frames) return null;
      const intoPm = isAddress(f.to) && lower(f.to) === pm;
      const ownPm = intoPm && isAddress(f.from) && own.has(lower(f.from));
      for (const c of f.calls as Frame[]) stack.push({ f: c, inPm: inPm || enters, unbroken: chain, underHook: underHook || hook, byOwn: ownPm });
    }
  }
  return [...out].sort();
}
/** The trade `sale`'s pre-state and its route hooks `hooks` that errored, from its own trace on each of the two
 *  providers `trace`: the prestate (disableCode) and the call frames, each its own request through `ask` (so a provider
 *  that limits its rate is asked again), equal on both or a refusal (rpc_disagree); null, the same on both, where the
 *  trace is no evidence (past its bounds, not the trade's own call); a provider that does not answer with a trace,
 *  rpc_error (blamed: the trace only ever adds a leg, and a trade it could not read is asked again). */
async function tracedPre(trace: readonly (readonly [EvmRpc, EvmRpc])[], sale: Trade, pm: string | undefined, adapter: string | undefined, hooks: readonly string[]): Promise<Pre | null> {
  const b = preBounds(BigInt(sale.gasUsed));
  // one tracer on the two providers (`at`: 0 the prestate's, 1 the callTracer's), read by `of`, equal as JSON on both
  const read = async <T>(at: 0 | 1, tracer: object, of: (r: unknown) => T | null): Promise<T | null> => {
    const { a } = await agreeing(
      trace.map((t) => t[at]),
      async (rpc, k) => {
        const [x] = await ask(rpc, [{ method: "debug_traceTransaction", params: [sale.hash, tracer] }]);
        const r = (x as { result?: unknown } | null)?.result;
        if (r === undefined || r === null) return refuse("rpc_error", `trace provider ${k + 1} answered no trace of the trade`);
        return of(r);
      },
      (x, y) => JSON.stringify(x) === JSON.stringify(y),
      () => refuse("rpc_disagree", `the trace providers answer the trade ${sale.hash}'s trace differently`),
    );
    return a;
  };
  const over = await read(0, { tracer: "prestateTracer", tracerConfig: { disableCode: true } }, (r) => preOverOf(r, b));
  if (over === null) return null;
  // a callTracer no provider answered (rpc_error: a hook can flood its frames' inputs past callBytes at no gas, review
  // of fb923143, 1), or one the two answer apart (rpc_disagree: one provider alone can answer it apart, review of
  // 1ee73a00, 2), leaves the prestate, which gas bounds and two companies agree on, to the replay and step 3: only the
  // as-is leg is unread. A callTracer both answer past its bounds or not the trade's own call drops it all.
  let errored: string[] | null;
  try {
    errored = await read(1, { tracer: "callTracer" }, (r) => erroredOf(r, sale, pm, adapter, hooks, b.frames));
  } catch (e) {
    if (e instanceof EvmQuoteError && (e.code === "rpc_error" || e.code === "rpc_disagree")) return { over, errored: undefined };
    throw e;
  }
  return errored === null ? null : { over, errored };
}
/** The true pre-state read of a chain's evidence, the one place it is chosen: a chain whose venue pins a trace pair
 *  (Robinhood: venue traceProviders) reads the trade's own trace there (`trace`, a test's, or the pins', each answer
 *  read up to the trade's bounds); any other has none, and its evidence replays at the parent block (card
 *  evm-sell-hook-intrablock-base adds Base's). */
function preStateOf(v: ReturnType<typeof venue>, trace: readonly EvmRpc[] | undefined): ((sale: Trade, hooks: readonly string[]) => Promise<Pre | null>) | undefined {
  if (v.traceProviders === undefined) return undefined;
  const urls = v.traceProviders;
  if (trace === undefined && evmProviders(urls, fetch).length !== 2) return undefined;
  if (trace !== undefined && trace.length !== 2) return undefined;
  return (sale, hooks) => {
    const b = preBounds(BigInt(sale.gasUsed));
    const rpcs = trace !== undefined ? trace.map((r) => [r, r] as const) : urls.map((u) => [evmJsonRpc(u, fetch, b.preBytes), evmJsonRpc(u, fetch, b.callBytes)] as const);
    return tracedPre(rpcs, sale, v.poolManager, v.adapterV4, hooks);
  };
}

/** Steps 2 to 4 of the evidence, a sale's and a buy's alike (card evm-buy-hook-converge): `sale`, the trade the quote
 *  made, already read back as the quote's own; `asW`, the state its replay runs with (a sale's W as its 7702 delegate,
 *  none for a buy); `keys`, the route's pools in the direction `held` reads it, the quoter's read of the route with its
 *  hooks as they are; `done`, whether a replay's answer is the trade done (a sale's: any result; a buy's: true), and
 *  `failed`, whether it is the trade failed as it did (a sale's: a revert; a buy's: false, its swap undone). */
async function blamed(rpcs: EvmRpc[], chain: EvmPoolChain, quote: { readonly minOut: bigint; readonly hooked: readonly string[] }, sale: Trade, asW: Record<string, { code: string }>, keys: readonly EvmPoolKey[], held0: { to: string; data: string }, done: (r: Replay) => boolean, failed: (r: Replay) => boolean, pre: ((sale: Trade, hooks: readonly string[]) => Promise<Pre | null>) | undefined): Promise<string[]> {
  // the trade's own transaction and receipt name one place in one block
  if (sale.index !== sale.rcIndex) return [];
  // 2. the sale's block: its parent, number and time, the same on two providers
  const { a: blk } = await agreeing(
    rpcs,
    async (rpc, k) => {
      const who = `provider ${k + 1}`;
      const [b] = await askAt(rpc, [{ method: "eth_getBlockByHash", params: [sale.blockHash, false] }]);
      const r = resultOf(b, who, "block of the sale");
      return { hash: str(r, "hash", who), number: num(r, "number", who), timestamp: num(r, "timestamp", who), parentHash: str(r, "parentHash", who), baseFeePerGas: num(r, "baseFeePerGas", who), mixHash: str(r, "mixHash", who) };
    },
    (x, y) => JSON.stringify(x) === JSON.stringify(y),
    () => refuse("rpc_disagree", `the providers answer the sale's block ${sale.blockHash} differently`),
  );
  if (blk.hash !== sale.blockHash || BigInt(blk.number) !== BigInt(sale.blockNumber) || !/^0x[0-9a-f]{64}$/.test(blk.parentHash)) return [];
  // the trade's own gas, less its authorizations' intrinsic cost, which an eth_call with no authorization list does not
  // charge: a hook sees in its replay the gas it saw in the trade (review of a2d82dc6, F1)
  const gas = BigInt(sale.gas) - EVM_7702_AUTH_GAS * BigInt(sale.auths);
  if (gas <= 0n) return [];
  // a trade whose poster gas Nitro charged inside its limit bans nothing: whether Nitro's eth_call charges the replay
  // the same is unread (Robinhood's L1 base fee estimate is 0, so every gasUsedForL1 read is 0: pool-fee.ts), and a
  // replay given less gas than the trade could fail an honest hook (review of da11bbb6, L1)
  if (BigInt(sale.l1Gas) !== 0n) return [];
  const parent = { blockHash: blk.parentHash, requireCanonical: true };
  // the trade's block as its transactions saw it: its header's number, time and base fee (and on the OP Stack its
  // PREVRANDAO, the L1 origin's mixHash, which steps at an epoch's first block), and the storage its own system calls
  // wrote before its first transaction (evmSystemSlotsOf), read at the block on two providers that agree word for word
  const opStack = chain === "base" || chain === "base-sepolia";
  const env = { number: qty(BigInt(blk.number)), time: qty(BigInt(blk.timestamp)), baseFeePerGas: qty(BigInt(blk.baseFeePerGas)), ...(opStack ? { prevRandao: blk.mixHash } : {}) };
  const sysSlots = evmSystemSlotsOf(chain, BigInt(blk.number), BigInt(blk.timestamp)).flatMap(([a, ss]) => ss.map((s) => [a, "0x" + word(s)] as const));
  const sys: Record<string, { stateDiff: Record<string, string> }> = {};
  if (sysSlots.length > 0) {
    const { a: words } = await agreeing(
      rpcs,
      async (rpc, k) => {
        const who = `provider ${k + 1}`;
        const got = await askAt(rpc, sysSlots.map(([a, s]) => ({ method: "eth_getStorageAt", params: [a, s, { blockHash: blk.hash, requireCanonical: true }] })));
        return got.map((g) => {
          const r = (g as { result?: unknown } | null)?.result;
          if (typeof r !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(r)) return refuse("rpc_error", `${who} answered a system slot of the sale's block with no word`);
          return "0x" + r.slice(2).toLowerCase().padStart(64, "0");
        });
      },
      (x, y) => JSON.stringify(x) === JSON.stringify(y),
      () => refuse("rpc_disagree", `the providers answer the system state of the sale's block ${blk.hash} differently`),
    );
    sysSlots.forEach(([a, s], i) => ((sys[a] ??= { stateDiff: {} }).stateDiff[s] = words[i]!));
  }
  // the trade's true pre-state where the chain has one (preStateOf): every account its trace names but ArbOS's state,
  // over the system slots (a slot both name takes the trace's word). A prestate not read (`unread`), past its bounds or
  // not the two providers' same word adds nothing: the evidence runs as on a chain with none, at the parent block with its system
  // slots, so a trace a hook makes too big to read never turns off what the replay alone proves (review of 29498693, HIGH)
  const hooks = [...new Set(keys.filter((k) => quote.hooked.includes("0x" + poolId(k))).map((k) => k.hooks))];
  let p: Pre | undefined;
  let unread = false;
  try {
    p = pre === undefined ? undefined : ((await pre(sale, hooks)) ?? undefined);
  } catch (e) {
    p = undefined;
    // a trace no provider answered (rpc_error) is read again; one the two answer apart is no evidence
    if (!(e instanceof EvmQuoteError) || e.code !== "rpc_disagree") unread = true;
  }
  const base: Record<string, Override> = { ...sys };
  for (const [a, o] of Object.entries(p?.over ?? {})) base[a] = { ...o, ...(sys[a] !== undefined || o.stateDiff !== undefined ? { stateDiff: { ...sys[a]?.stateDiff, ...o.stateDiff } } : {}) };
  // the sale's own call: its sender, value, gas and fees, to where it went; the sender's balance its own at the parent
  // block (as the device's sale sim runs), or on a chain with a trace the prestate's, so a hook that reads it sees what
  // the trade saw
  const call = { from: sale.from, to: sale.to, data: sale.input, gas: qty(gas), value: sale.value, ...sale.fees };
  const replay = async (extra: Record<string, { code: string }>): Promise<Replay> => {
    const state: Record<string, Override> = { ...base };
    for (const [a, o] of Object.entries({ ...asW, ...extra })) state[lower(a)] = { ...state[lower(a)], ...o };
    const { a } = await agreeing(
      rpcs,
      async (rpc, k) => replayOf((await askAt(rpc, [{ method: "eth_call", params: [call, parent, state, env] }]))[0], `provider ${k + 1}`),
      (x, y) => (x.ok && y.ok && x.result === y.result) || (!x.ok && !y.ok && x.data === y.data),
      () => refuse("rpc_disagree", "the providers answer the sale's replay differently"),
    );
    return a;
  };
  // the replay as the sale ran: it fails as the trade did, the same on both; or, where it passes and the trade's own
  // trace is read, the route's unlisted hooks whose frame the PoolManager called errored there (each hook reverted in the
  // trade itself, two companies' word, whatever its replay tells: a hook keyed on ArbOS's backlog or L1 block number,
  // which no replay can carry; never a listed hook's frame, nor the PoolManager's)
  const asIs = failed(await replay({}));
  const seen = p?.errored;
  // the route's hooks whose own frame errored in the trade, as the callTracer both providers answered names them
  const named = seen === undefined ? [] : hooks.filter((hk) => seen.includes(lower(hk)));
  const errored = asIs ? [] : named;
  // the as-is leg unread: no trace read, or its prestate read and its callTracer not answered
  const legUnread = unread || (p !== undefined && p.errored === undefined);
  const again = () => refuse("rpc_error", `${EVM_TRACE_UNANSWERED}: ${sale.hash}`);
  // a replay that passed with the as-is leg unread, where only the trace's errored frames could have told: asked again
  // (rpc_error, EVM_TRACE_UNANSWERED), never a final word that nothing is at fault (review of f0f983d2, item 5a; of
  // de4e3ed5, 2). Past here the replay failed; the callTracer still counts where step 4 rescues nothing (below)
  if (!asIs && errored.length === 0) return legUnread ? again() : [];
  // 3. the market held: the quoter prices the route, its hooks as they are, at minOut or more, on the replay's own basis
  // (the parent block with the system slots and the trade's traced pre-state, at the trade's block's number, time and
  // base fee), so a price an earlier transaction of the block moved, or a hook it armed, is the market the trade met
  // (review of de4e3ed5, 1)
  const [held] = await readBoth(rpcs, blk.parentHash, [{ ...held0, override: base, env }], venue(chain).reads);
  // while no trace was read, this [] and step 4's read the parent basis, which the trade's pre-state could turn into a
  // ban: asked again too (review of fb923143, 2)
  if (held!.kind !== "out" || held!.amountOut < quote.minOut) return unread ? again() : [];
  // 4. the hooks at fault: each smallest set of `hooked`'s hooks whose no-op at once rescues the trade (the stored-fee
  // no-op's sets, or the fee-0 one's where none, a stored-fee set giving way to smaller fee-0 sets inside it, so a stored
  // dynamic fee a hook with beforeSwap raised cannot fail it; a set holding a smaller one that rescued it is not asked); every pool of the route behind a hook of one is banned. Where the replay passed and the
  // trace named the hooks, those hooks alone: any set's no-op "rescues" a replay that never failed, so no set tells, and
  // a hook outside them is never banned (review of 29498693, MEDIUM). Where the replay failed and no set rescued it,
  // the hooks the callTracer names: a hook can make its own no-op pool fail too, through state an earlier transaction of
  // the block set (its pool's price or liquidity), and its own frame that errored in the trade is then the only witness
  // (review of 1ee73a00, 1); with that callTracer unread, asked again
  const rescued: string[][] = [];
  if (asIs) {
    // two passes in full, each its own smallest sets: every set's no-op at the pool's stored fee (EVM_NOOP_HOOK_CODE),
    // and every set's fee-0 no-op (EVM_EVIDENCE_NOOP_HOOK_CODE). The stored-fee sets count, or the fee-0 ones where no
    // stored-fee set rescues: fee 0 alone would also rescue an honest pool whose stored fee is more than a hostile hook's
    // skim beside it (review of d6d055bf, 1). A stored-fee set that holds smaller fee-0 sets yields to them: an honest
    // hook whose fee every no-op removes is otherwise banned with a stored-fee bait that its removed fee lets the
    // stored-fee no-op of the pair rescue (review of 2fccaa67, 1)
    const pass = async (code: string) => {
      const got: string[][] = [];
      for (const set of subsetsOf(hooks)) {
        if (got.some((r) => r.every((h) => set.includes(h)))) continue;
        if (done(await replay(Object.fromEntries(set.map((hk) => [hk, { code }]))))) got.push(set);
      }
      return got;
    };
    const atStored = await pass(EVM_NOOP_HOOK_CODE);
    const atZero = await pass(EVM_EVIDENCE_NOOP_HOOK_CODE);
    rescued.push(...evmFaultSets(atStored, atZero));
  }
  const none = asIs && rescued.length === 0;
  const fault = new Set(asIs ? (none ? named : rescued.flat()) : errored);
  const out: string[] = [];
  for (const k of keys) if (fault.has(k.hooks) && !out.includes("0x" + poolId(k))) out.push("0x" + poolId(k));
  return out.length === 0 && (unread || (none && legUnread)) ? again() : out;
}

/** Step 4's sets at fault from its two passes' smallest rescuing sets (tests only, not in the index): the stored-fee
 *  pass's (`atStored`), or the fee-0 pass's (`atZero`) where the first has none; a stored-fee set that holds smaller
 *  fee-0 sets gives way to them, each kept once (review of d6d055bf, 1; of 2fccaa67, 1). */
export function evmFaultSets(atStored: readonly (readonly string[])[], atZero: readonly (readonly string[])[]): string[][] {
  const out: string[][] = [];
  for (const s of atStored.length > 0 ? atStored : atZero) {
    const under = atZero.filter((t) => t.length < s.length && t.every((h) => s.includes(h)));
    for (const x of under.length > 0 ? under : [s]) if (!out.some((r) => r.length === x.length && r.every((h) => x.includes(h)))) out.push([...x]);
  }
  return out;
}

/** evmSellRevertedPools on the providers `rpcsIn`, the venue list `venues` and, on a chain with a trace pair, the trace
 *  providers `trace` (by default the venue's pins) (tests only). Not in the index. */
export async function evmSellRevertedPoolsWith(quote: EvmPoolSellQuote, txHash: string, rpcsIn: readonly EvmRpc[], venues?: EvmPoolVenueList, trace?: readonly EvmRpc[]): Promise<readonly string[]> {
  if (!evmIsDeviceSellQuote(quote)) return refuse("bad_request", "a ban is proved only against a quote evmPoolSellQuote returned");
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return refuse("bad_request", "a sale's hash is 0x and 64 hex digits");
  if (!Array.isArray(rpcsIn) || rpcsIn.length < 2) return refuse("bad_request", "a ban is proved on two providers or more");
  const { chain, route, w, token } = quote;
  const v = venue(chain, venues);
  if (quote.hooked.length === 0 || route.venue !== "uniswap-v4" || v.sellDelegate === undefined || v.v4 === undefined) return [];
  const h = txHash.toLowerCase();
  const rpcs = [...rpcsIn];
  try {
    // 1. the sale: its transaction and receipt, the same on two providers
    const sale = await tradeOf(rpcs, h);
    if (sale.hash !== h || sale.rcHash !== h || sale.rcBlock !== sale.blockHash || BigInt(sale.status) !== 0n || sale.to !== lower(w)) return [];
    // sent at the gas the device pins and its sim ran at: a sale sent with other gas is a sender's pick the device's fee
    // never paid for, so its failure is the sender's, never a hook's (review of a2d82dc6, F1)
    if (BigInt(sale.gas) !== EVM_POOL_SELL_GAS) return [];
    // the sale is the quote's own: SellDelegate.sell(sell, fee, signature), its Sell's token, amount, target and minOut
    // the quote's, its data the route the quote holds
    const d = sale.input.slice(2);
    if (!d.startsWith(SEL_SELL)) return [];
    const at = (i: number) => (8 + 64 * i + 64 <= d.length ? BigInt("0x" + d.slice(8 + 64 * i, 8 + 64 * i + 64)) : -1n);
    const t0 = at(0);
    if (t0 < 0n || t0 % 32n !== 0n || t0 > 0x10000n) return [];
    const t = Number(t0 / 32n);
    const [sToken, sAmount, sTarget, sData, sMinOut] = [at(t), at(t + 1), at(t + 2), at(t + 3), at(t + 4)];
    if (sData < 0n || sData % 32n !== 0n || sData > 0x10000n) return [];
    const dl = at(t + Number(sData / 32n));
    if (dl < 0n || dl > 4096n || 8 + 64 * (t + Number(sData / 32n) + 1) + Number(dl) * 2 > d.length) return [];
    const off = 8 + 64 * (t + Number(sData / 32n) + 1);
    const data = "0x" + d.slice(off, off + Number(dl) * 2);
    if (sToken !== BigInt(token) || sAmount !== quote.amountIn || sTarget !== BigInt(quote.target) || sMinOut !== quote.minOut) return [];
    let signed: EvmSellRoute;
    try {
      signed = evmSignedSellRouteOf(chain, { w, token, amount: sAmount, minOut: sMinOut, target: quote.target, data });
    } catch {
      return [];
    }
    if (JSON.stringify(signed) !== JSON.stringify(route)) return [];
    // the route as the buy that the sale undoes took it, for the quoter's read at the parent block (step 3)
    const n = route.hops.length;
    const bought: EvmRoute = { venue: "uniswap-v4", currencyIn: route.hops[n - 1]!.currency, hops: route.hops.map((_, i) => { const s = route.hops[n - 1 - i]!; return { currency: i === n - 1 ? token : route.hops[n - 2 - i]!.currency, fee: s.fee, tickSpacing: s.tickSpacing, hooks: s.hooks, hookData: "0x" }; }) };
    if (JSON.stringify(evmSellRouteOf(bought)) !== JSON.stringify(route)) return [];
    // 2 to 5, W's code the 7702 designator of the chain's pinned sell delegate (the sale carries its own authorization)
    const asW = { [lower(w)]: { code: designator(v.sellDelegate) } };
    return await blamed(rpcs, chain, quote, sale, asW, hopKeys(bought), sellRead(v, token, bought, quote.amountIn), (r) => r.ok, (r) => !r.ok, preStateOf(v, trace));
  } catch (e) {
    if (e instanceof EvmQuoteError && e.code === "rpc_disagree") return [];
    throw e;
  }
}

/** The PoolIds of the buy quote's `hooked` pools that the buy `txHash`'s failed swap proves at fault, on the chain's
 *  pinned providers; [] where nothing is proved (card evm-buy-hook-converge). The evidence is the sale's (above), the
 *  buy's own transaction in place of the sale's: PrivacyPoolSimple.buy on the chain's pinned pool, landed (status 1)
 *  with its swap undone (the pool's Withdrawn in its receipt and no Bought: the pool pays a failed swap's chunk back
 *  to W, card pool-evm-buy-pays-revert; review of 72e28658, H2), its Buy the quote's (the chain's pinned v4 adapter,
 *  the route's bytes as the device's builder encodes them, the quote's minOut and token) and its withdrawn value less
 *  its fee the quote's amount (L3); its replay at the parent block with the buy's block number and time returns false
 *  (`_bought`); V4Quoter on the replay's own basis prices the route, its hooks as they are, at the quote's amount to minOut or
 *  more; and the replay with a smallest set of `hooked`'s hooks a no-op returns true. The caller bans these (wallet
 *  pool/evm-sell-bans.ts, shared with the sale). Its trace's rpc_error is the sale's (EVM_TRACE_UNANSWERED, above). */
export async function evmBuyRevertedPools(quote: EvmPoolBuyQuote, txHash: string): Promise<readonly string[]> {
  if (!evmIsDeviceQuote(quote)) return refuse("bad_request", "a ban is proved only against a quote evmPoolBuyQuote returned");
  const p = venue(quote.chain).providers;
  if (p === undefined) return refuse("no_quoter", `${quote.chain} has no pinned providers`);
  return evmBuyRevertedPoolsWith(quote, txHash, evmProviders(evmRanked(p), fetch));
}

// the pool's events (IPrivacyPool.sol): Withdrawn(address,address,uint256,uint256,uint256,uint256) and
// Bought(address,address,uint256,uint256,uint256,uint256,address,uint256), their topics as literals (test/
// evm-quote-attacks.test.ts hashes both)
const TOPIC_WITHDRAWN = "0xfabb9e7afa4ef595f60e1ae9041b2b311b4acb27aeaed4b11b6f2abf689af10a";
const TOPIC_BOUGHT = "0xb8a1e6c10d45357f60b093ab761ca4af74bf300c039aa105fb946f7e5105727d";
/** A replay's answer read as PrivacyPoolSimple.buy's `_bought`: true, false, or null for anything else (a revert, or a
 *  result that is not one ABI bool). */
const boughtOf = (r: Replay): boolean | null => (!r.ok || r.result.length !== 66 ? null : /^0x0{64}$/.test(r.result) ? false : /^0x0{63}1$/.test(r.result) ? true : null);
const SEL_BUY = "3edadd79"; // a literal, never a top-level call: PrivacyPoolSimple.buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)
/** evmBuyRevertedPools on the providers `rpcsIn`, the venue list `venues` and the trace providers `trace`, as the
 *  sale's (tests only). Not in the index. */
export async function evmBuyRevertedPoolsWith(quote: EvmPoolBuyQuote, txHash: string, rpcsIn: readonly EvmRpc[], venues?: EvmPoolVenueList, trace?: readonly EvmRpc[]): Promise<readonly string[]> {
  if (!evmIsDeviceQuote(quote)) return refuse("bad_request", "a ban is proved only against a quote evmPoolBuyQuote returned");
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return refuse("bad_request", "a buy's hash is 0x and 64 hex digits");
  if (!Array.isArray(rpcsIn) || rpcsIn.length < 2) return refuse("bad_request", "a ban is proved on two providers or more");
  const { chain, route, token } = quote;
  const v = venue(chain, venues);
  if (quote.hooked.length === 0 || route.venue !== "uniswap-v4" || v.pool === undefined || v.adapterV4 === undefined || v.v4 === undefined) return [];
  const h = txHash.toLowerCase();
  const rpcs = [...rpcsIn];
  try {
    // 1. the buy: its transaction and receipt, the same on two providers, to the chain's pinned pool, landed with its
    // swap undone: the pool's Withdrawn, and no Bought
    const buy = await tradeOf(rpcs, h);
    if (buy.hash !== h || buy.rcHash !== h || buy.rcBlock !== buy.blockHash || BigInt(buy.status) !== 1n || buy.to !== v.pool) return [];
    if (!buy.logs.includes(`${v.pool}:${TOPIC_WITHDRAWN}`) || buy.logs.includes(`${v.pool}:${TOPIC_BOUGHT}`)) return [];
    // the buy is the quote's own: PrivacyPoolSimple.buy(withdrawal, proof, fee, buy, signature), the Buy at head word 18
    // (after the Withdrawal's offset, the proof's 16 words and the fee): its adapter, data, minOut and token; the proof's
    // withdrawn value (its third public signal, head word 11) less the fee (word 17), what the pool swaps, the quote's
    // amount (review of 72e28658, L3)
    const d = buy.input.slice(2);
    if (!d.startsWith(SEL_BUY)) return [];
    const at = (i: number) => (8 + 64 * i + 64 <= d.length ? BigInt("0x" + d.slice(8 + 64 * i, 8 + 64 * i + 64)) : -1n);
    const [withdrawn, fee] = [at(11), at(17)];
    if (withdrawn < 0n || fee < 0n || withdrawn - fee !== quote.amountIn) return [];
    const b0 = at(18);
    if (b0 < 0n || b0 % 32n !== 0n || b0 > 0x10000n) return [];
    const b = Number(b0 / 32n);
    const [bAdapter, bData, bMinOut, bToken] = [at(b), at(b + 1), at(b + 2), at(b + 3)];
    if (bData < 0n || bData % 32n !== 0n || bData > 0x10000n) return [];
    const dl = at(b + Number(bData / 32n));
    if (dl < 0n || dl > 4096n || 8 + 64 * (b + Number(bData / 32n) + 1) + Number(dl) * 2 > d.length) return [];
    const off = 8 + 64 * (b + Number(bData / 32n) + 1);
    const data = "0x" + d.slice(off, off + Number(dl) * 2);
    if (bAdapter !== BigInt(v.adapterV4) || bToken !== BigInt(token) || bMinOut !== quote.minOut) return [];
    if (data !== "0x" + hex(evmPoolRouteDataQuoted(chain, route).data)) return [];
    // 2 to 4: the buy runs in the pool's own code, so its replay replaces no account's; it is done where it returns
    // true, and failed as it did where it returns false
    return await blamed(rpcs, chain, quote, buy, {}, hopKeys(route), quoteCall(chain, v, route, quote.amountIn), (r) => boughtOf(r) === true, (r) => boughtOf(r) === false, preStateOf(v, trace));
  } catch (e) {
    if (e instanceof EvmQuoteError && e.code === "rpc_disagree") return [];
    throw e;
  }
}

/** A provider's 429: ask asks again, a little later. `afterMs`: the wait its Retry-After named, if any. */
class RateLimited extends Error {
  readonly afterMs: number | null;
  constructor(message: string, afterMs: number | null = null) {
    super(message);
    this.afterMs = afterMs;
  }
}
/** A Retry-After header's wait in ms: delay-seconds or an HTTP date (RFC 9110 10.2.3), null when absent or neither. */
function retryAfterMs(h: string | null, now = Date.now()): number | null {
  if (h === null) return null;
  const t = h.trim();
  if (/^\d{1,9}$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  return Number.isFinite(at) && /[a-z]/i.test(t) ? Math.max(0, at - now) : null;
}
/** A request that made no connection, so no answer can have started: ask asks again, a little later. mainnet.base.org
 *  failed one connection in about every quote from this Mac ("fetch failed", ETIMEDOUT about 505 ms in: Node tries each
 *  of the host's addresses for 250 ms, and this network has no IPv6 route), 2026-11-04 15:45-16:00Z; a request that ran
 *  out of time (TimeoutError) is not one: it may have been served. A browser's fetch names no cause for any failure with
 *  no response (re-review of b282ce0, LOW-B), so there every one is one: each call is a read, safe to send again. */
class Unreachable extends Error {}
/** A provider's answer that is no batch of answers to read: an HTTP status outside 2xx other than 429 and 5xx, a body
 *  past its size or not JSON, or JSON that is not a batch. It answered, so a scan asks its halves of it (ScanAnswered). */
class BadAnswer extends Error {}
/** A call's error naming state the provider no longer keeps (its state cut), read from the pinned providers:
 *  - "historical state <root> is not available": a Robinhood provider of the quote's list answering a TORCH quote's
 *    reads at its agreed block, 2026-11-05 10:00Z and 10:03Z (card evm-quote-lag-held's live runs);
 *  - "Archive requests require a personal token…": robinhood-rpc.publicnode.com, -32602, to a state read by number 100
 *    and 130 blocks back, 6 of 6, 2026-11-05 11:01Z (its HTTP status 403, which evmJsonRpc refuses before any call is
 *    read);
 *  - "Unknown state. First available state is 1": robinhood.drpc.org, 200, code 27, to a state read by hash 100, 200,
 *    1,000 and 2,000 blocks back, 6 of 6, 2026-11-05 11:53Z (askAt still asks it again, as the same string once came
 *    from a node a block behind the head, 2026-11-04 06:52Z).
 *  Never a revert (code 3, "execution reverted…"): a call may revert with any string, "header not found" among them
 *  (every pinned Base provider passed it through, 10:54Z). Never an answer for a block a provider does not hold yet
 *  ("block not found: canonical hash", "header not found"): askAt asks those again, and timed does not time them. */
const stateless = (a: unknown) => {
  const m = (a as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === "string" && !reverted(a) && /historical state \S+ is not available|archive requests require a personal token|^unknown state\b/i.test(m);
};
/** A call's error naming the provider's rate limit: "25/second request limit reached" (mainnet.base.org, 2026-11-04
 *  07:4xZ), "Your app has exceeded its compute units per second capacity…" (base.meowrpc.com, 2026-11-04 23:48Z; Base's
 *  blastapi the same, re-review 2026-11-05); never a revert. */
const limited = (a: unknown) => {
  const m = (a as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === "string" && !reverted(a) && /request limit|rate limit|too many requests|exceeded its compute units per second/i.test(m);
};
/** A call that reverted (code 3, or a message "execution reverted…"): its string is the called contract's, never the
 *  provider's state or limit (review LOW-2). */
const reverted = (a: unknown) => {
  const e = (a as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return e?.code === 3 || (typeof e?.message === "string" && /^execution reverted/i.test(e.message));
};
// the errors of a connection that was never made (Node's net and undici: a timed-out or refused connect, an
// unreachable network, a name that did not resolve)
const CONNECT_ERRORS = new Set(["ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
/** Each JSON-RPC request's time limit (the NEAR client's RPC_TIMEOUT_MS and Solana's SOLANA_CALL_TIMEOUT_MS do the same). */
export const EVM_RPC_TIMEOUT_MS = 10_000;
/** A provider from a JSON-RPC URL: one POST per batch, answers matched to calls by id, at most `maxBytes` read. */
export function evmJsonRpc(url: string, fetchFn: typeof fetch = fetch, maxBytes = 1 << 20, timeoutMs = EVM_RPC_TIMEOUT_MS): EvmRpc {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return refuse("bad_request", "a provider URL is https");
  return async (calls, until) => {
    const body = JSON.stringify(calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params })));
    // a request that never returns is a refusal once its time runs out, never a quote (and a buy button) that hangs
    let res: Response;
    try {
      const signal = until === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([AbortSignal.timeout(timeoutMs), until]);
      res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal });
    } catch (e) {
      // fetch's own TypeError with no response: Node's ("fetch failed") names its connection error as its cause, a
      // browser's names none ("Failed to fetch" in Chrome, "Load failed" in Safari, "NetworkError when attempting to
      // fetch resource." in Firefox); a timeout or an abort is a DOMException, never this
      const cause = (e as { cause?: unknown } | null)?.cause;
      const code = (cause as { code?: unknown } | null | undefined)?.code;
      if (e instanceof TypeError && (cause === undefined || (typeof code === "string" && CONNECT_ERRORS.has(code)))) throw new Unreachable(`no connection (${typeof code === "string" ? code : e.message})`);
      throw e;
    }
    if (res.status === 429) throw new RateLimited("the provider answered 429 Too Many Requests", retryAfterMs(res.headers.get("retry-after")));
    // any other status outside 2xx is a failure, never an answer to read (review MED-1: robinhood-rpc.publicnode.com
    // answers a read past its state cut 403 with a JSON-RPC error inside, which was timed as a fast answer)
    if (!res.ok) {
      // the body is never read, so it is let go, never left holding the connection (re-review INFO 3)
      await res.body?.cancel().catch(() => {});
      const m = `the provider answered HTTP ${res.status}`;
      throw res.status >= 500 ? new Error(m) : new BadAnswer(m);
    }
    const text = await res.text();
    if (text.length > maxBytes) throw new BadAnswer("the answer is too long");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new BadAnswer(`the answer is not JSON: ${(e as Error).message}`);
    }
    // a batch of one call answered as that call's answer alone, not in a batch: Pocket's way on Base and Robinhood
    // (robinhood.api.pocket.network and base.api.pocket.network, every try, 2026-11-05 19:49Z): it still counts only
    // with this call's id. Any other answer that is not a batch is refused.
    const arr: unknown = !Array.isArray(parsed) && calls.length === 1 && typeof parsed === "object" && parsed !== null ? [parsed] : parsed;
    if (!Array.isArray(arr)) throw new BadAnswer("the answer is not a batch");
    const byId = new Map<number, unknown>();
    for (const a of arr) {
      const id = (a as { id?: unknown } | null)?.id;
      if (typeof id === "number" && Number.isInteger(id) && id >= 0 && id < calls.length && !byId.has(id)) byId.set(id, a);
    }
    return calls.map((_, id) => byId.get(id) ?? null);
  };
}
