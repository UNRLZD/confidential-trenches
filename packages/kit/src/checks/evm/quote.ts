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
//   provider's head within maxLag of the agreed block, kept per token in memory once that block is confirmed); and
//   any pool the caller lists, never
//   trusted. A scanned or listed pool counts only where the PoolManager holds it at the agreed block on both
//   providers (slot0's price and liquidity above 0, through extsload), and only then is a hook replaced in its reads:
//   one whose hook is not pinned is read with that hook alone replaced by the hook that does nothing, so a hook cannot
//   raise a reference, and a pool whose hook is an address the reads call is dropped. A pool of another currency X is
//   priced as a two-hop from the native asset (or a pinned shape's start) to X through each standard and pinned pool,
//   then X to the token: a reference only, never a route W builds, the deepest in the token first and at most
//   EVM_QUOTE_MAX_OTHER of them. One that no such route prices refuses the quote (no_reference) only when it holds
//   more of the token at its current price (L x 2^96 / sqrtPrice, or L x sqrtPrice / 2^96) than the pool that sets
//   R; a shallower one, such as a pool opened with dust, does not block. The route's
//   own pools are not read with their hooks replaced as candidates: the hook's take there is shown, below. The best
//   one that fills completely is the reference R. A buy is refused unless its output is at least R (below_reference,
//   M366 (4)), so a helper cannot steer it into a pool it seeded while the token's real pool is one the device found;
//   with no R it is refused (no_reference). What is left: a pool of the token created before the scan's depth (about
//   23 days on Base, 12 days on Robinhood), of a shape the device has not pinned, that the helper leaves off its list
//   while it routes the buy into a standard pool it seeded;
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
  evmPoolRouteData,
  evmPoolVenues,
  type EvmPoolChain,
  type EvmRoute,
  type EvmV3Route,
  type EvmV4Route,
} from "../../trade/evm/buy-unpinned.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";

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
  | "stale_quote"; // the block is more than 30 s behind the device's clock
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
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The pinned quoters and rules of `chain`: own keys of the frozen venue list only. */
function venue(chain: EvmPoolChain) {
  const all = evmPoolVenues();
  if (typeof chain !== "string" || !Object.hasOwn(all, chain)) return refuse("bad_request", "no such chain");
  const v = all[chain];
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
    v3Factory: Object.hasOwn(v, "v3Factory") && isAddress(v.v3Factory) ? lower(v.v3Factory) : undefined,
    scan: Object.hasOwn(v, "scan") ? v.scan : undefined,
    called: new Set(called.filter(isAddress).map(lower)),
  };
}

/** The quoter call for `route` (checked by the builder's own route checks) and `amount`. */
function quoteCall(chain: EvmPoolChain, quoter: { v3: string | undefined; v4: string | undefined }, route: EvmRoute, amount: bigint): { to: string; data: string } {
  const { data } = evmPoolRouteData(chain, route);
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
function unaggregate(a: unknown, n: number, who: string, state: readonly boolean[] = []): Answer[] {
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
    // a state read of a v3 pool that is not deployed calls an address with no code: no word, read as a revert
    else if (dl < 32 && state[i] === true) out.push({ kind: "revert", partial: false });
    else if (dl < 32) return refuse("rpc_error", `${who} answered a quote shorter than a word`);
    else out.push({ kind: "out", amountOut: BigInt("0x" + r.slice(2 + 2 * (e + 96), 2 + 2 * (e + 128))) });
  }
  return out;
}

// Reads per aggregate3 call, and calls per JSON-RPC batch: base-rpc.publicnode.com caps an eth_call at 50,000,000 gas,
// which one call of 90 quotes of 100 ETH passed (read 2026-11-03 19:00Z), and robinhood.drpc.org's free plan takes a
// batch of 3 calls at most
const READS_PER_CALL = 6;
const CALLS_PER_BATCH = 3;
// an extsload read costs one storage read (2,100 gas cold, EIP-2929): 64 of them are far inside any provider's cap
const STATE_READS_PER_CALL = 64;

/** Both providers' answers to `reads` at `hash`, which must be the same: the reads without a state override in
 *  aggregate3 calls of READS_PER_CALL, the grouped reads of each hook in their own aggregate3 calls with that hook's
 *  override alone, any other read with one in its own call, sent in batches of CALLS_PER_BATCH at once. */
async function readBoth(rpcs: readonly [EvmRpc, EvmRpc], hash: string, reads: readonly Read[]): Promise<Answer[]> {
  const at = { blockHash: hash, requireCanonical: true };
  const plain = reads.flatMap((r, i) => (r.override === undefined && r.state !== true ? [i] : []));
  const state = reads.flatMap((r, i) => (r.override === undefined && r.state === true ? [i] : []));
  const groups = new Map<string, number[]>();
  reads.forEach((r, i) => {
    if (r.override !== undefined && r.group !== undefined) groups.set(r.group, [...(groups.get(r.group) ?? []), i]);
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
    ...lone.map((i) => ({ method: "eth_call", params: [{ to: reads[i]!.to, data: reads[i]!.data }, at, reads[i]!.override] })),
  ];
  const batches: EvmRpcCall[][] = [];
  for (let k = 0; k < calls.length; k += CALLS_PER_BATCH) batches.push(calls.slice(k, k + CALLS_PER_BATCH));
  const both = await Promise.all(rpcs.map(async (rpc) => (await Promise.all(batches.map((b) => askAt(rpc, b)))).flat()));
  const answers = both.map((b, p) => {
    const who = `provider ${p + 1}`;
    const all: Answer[] = new Array(reads.length);
    parts.forEach((part, c) => unaggregate(b[c], part.length, who, part.map((i) => reads[i]!.state === true)).forEach((x, k) => (all[part[k]!] = x)));
    lone.forEach((i, k) => (all[i] = answerOf(b[parts.length + k], who) as Answer));
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

async function ask(rpc: EvmRpc, calls: readonly EvmRpcCall[]): Promise<readonly unknown[]> {
  let out: unknown;
  try {
    out = await rpc(calls);
  } catch (e) {
    return refuse("rpc_error", `a provider did not answer: ${(e as Error)?.message ?? e}`);
  }
  if (!Array.isArray(out) || out.length !== calls.length) return refuse("rpc_error", "a provider answered another number of calls");
  return out;
}

/** ask, once more after FRESH_RETRY_MS when an answer says the provider does not hold the block yet: a provider behind
 *  a load balancer can send a call to a node one block behind the one that gave the head ("block not found: canonical
 *  hash", base-rpc.publicnode.com, 2026-11-03 19:09Z; "Unknown state. First available …", robinhood.drpc.org, 20:30Z). */
async function askAt(rpc: EvmRpc, calls: readonly EvmRpcCall[]): Promise<readonly unknown[]> {
  const out = await ask(rpc, calls);
  const behind = out.some((a) => {
    const o = a as { result?: unknown; error?: { message?: unknown } } | null;
    return o?.result === null || (typeof o?.error?.message === "string" && /(block|header).*not found|unknown block|unknown state/i.test(o.error.message));
  });
  if (!behind) return out;
  await new Promise((r) => setTimeout(r, FRESH_RETRY_MS));
  return ask(rpc, calls);
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

const v3Direct = (weth: string, token: string, fee: number): EvmV3Route => ({ venue: "uniswap-v3", tokens: [weth, token], fees: [fee] });
const v4Direct = (from: string, to: string, [fee, tickSpacing]: readonly [number, number]): EvmV4Route => ({
  venue: "uniswap-v4",
  currencyIn: from,
  hops: [{ currency: to, fee, tickSpacing, hooks: NATIVE, hookData: "0x" }],
});
const startsNative = (r: EvmRoute) => r.venue === "uniswap-v4" && lower(r.currencyIn) === NATIVE;

/** The most pools a caller may list, and the most found pools a quote reads (the scan's oldest first, then the list):
 *  bounded reads, whatever a token's pool count. */
export const EVM_QUOTE_MAX_HINTS = 16;
const EVM_QUOTE_MAX_FOUND = 64;
/** The most held pools of the token with a currency other than the native asset and WETH a quote prices, the deepest in
 *  the token first (each through 4 standard and each pinned first leg, at two amounts: about 18 reads). */
const EVM_QUOTE_MAX_OTHER = 8;
/** One pool's state reads (read indices) and whether the token is its currency0: its depth in the token. */
type PoolState = { price: number; liquidity: number; token0: boolean };
const SEL_EXTSLOAD = "1e2eaeaf"; // PoolManager.extsload(bytes32)
const POOLS_SLOT = 6n; // v4-core StateLibrary.POOLS_SLOT
const U24 = 0xffffff;
const keccak = (h: string) => hex(keccak_256(Uint8Array.from(h.match(/../g)!, (b) => parseInt(b, 16))));
/** v4's PoolId: keccak256(abi.encode(PoolKey)). */
const poolId = (k: EvmPoolKey) =>
  keccak(word(BigInt(k.currency0)) + word(BigInt(k.currency1)) + word(BigInt(k.fee)) + word(BigInt.asUintN(256, BigInt(k.tickSpacing))) + word(BigInt(k.hooks)));
/** The pool's state slot in the PoolManager (StateLibrary._getPoolStateSlot): slot0 there, liquidity 3 words on. */
const stateSlot = (k: EvmPoolKey) => keccak(poolId(k) + word(POOLS_SLOT));
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
// Uniswap v3's pool init code hash (v3-periphery PoolAddress.POOL_INIT_CODE_HASH): with it, CREATE2 gives the same pool
// address as each pinned factory's getPool (read on Base and Robinhood, 2026-11-03 20:34Z)
const V3_INIT_CODE_HASH = "e34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
const v3PoolAddress = (factory: string, a: string, b: string, fee: number) => {
  const [t0, t1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return "0x" + keccak("ff" + factory.slice(2) + keccak(word(BigInt(t0)) + word(BigInt(t1)) + word(BigInt(fee))) + V3_INIT_CODE_HASH).slice(24);
};
const SEL_V3_SLOT0 = "3850c7bd"; // slot0(): sqrtPriceX96 first
const SEL_V3_LIQUIDITY = "1a686502"; // liquidity()
const Q96 = 1n << 96n;
/** How much of the token a pool holds at its current price, from its sqrtPriceX96 and in-range liquidity (v3 and v4
 *  alike): L x 2^96 / sqrtPrice of currency0, L x sqrtPrice / 2^96 of currency1. Null when either is 0. */
function depthOf(sqrtPrice: bigint | null, liquidity: bigint | null, token0: boolean): bigint | null {
  if (sqrtPrice === null || liquidity === null) return null;
  const p = sqrtPrice & ((1n << 160n) - 1n);
  const l = liquidity & ((1n << 128n) - 1n);
  if (p === 0n || l === 0n) return null;
  return token0 ? (l * Q96) / p : (l * p) / Q96;
}
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
 *  without the builder's route checks: a reference need not be a route W can build. */
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

// The device's own scan of the PoolManager's Initialize logs for a token, kept per chain and token in this module's
// memory: the first quote for a token scans `depth` blocks back, each later one from the block the last scan reached.
// A scan only adds pools, so one provider serves it; what it finds is read on both providers like any candidate.
const INITIALIZE = "dd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"; // Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)
const SCANS = new Map<string, { to: number; pools: EvmPoolKey[] }>();
const SCAN_TOKENS = 256;
const SCAN_MAX_LOGS = 10_000;
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
/** The scan up to the scan provider's head, which must be within `maxLag` blocks of the agreed block `agreed` (review
 *  of 5452011, S2: a head of 2^40 scanned an empty future and its end was kept): a head behind it misses at most the
 *  pools of those blocks, for this quote only; one ahead of it reads pools the agreed block does not hold yet, which
 *  its extsload reads drop. `commit` keeps what it read; the quote calls it only once its block is confirmed on both
 *  providers. */
async function scanPools(
  chain: EvmPoolChain,
  token: string,
  pm: string,
  rpc: EvmRpc,
  s: { span: number; depth: number; parallel: number },
  agreed: Promise<bigint>,
  maxLag: bigint,
): Promise<{ pools: EvmPoolKey[]; commit: () => void }> {
  const key = `${chain}:${lower(token)}`;
  const h = (await ask(rpc, [{ method: "eth_blockNumber", params: [] }]))[0] as { result?: unknown } | null;
  if (typeof h?.result !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(h.result)) return refuse("rpc_error", "the scan provider answered no block number");
  const scanHead = BigInt(h.result);
  if (scanHead > BigInt(Number.MAX_SAFE_INTEGER)) return refuse("rpc_disagree", "the scan provider's head is past any block");
  // the logs up to the scan provider's head are read beside the heads' round (at most depth / span requests), and used
  // only once that head is found within maxLag of the agreed block
  const head = Number(scanHead);
  const cached = SCANS.get(key);
  const floor = Math.max(0, head - s.depth + 1);
  const from = cached === undefined || cached.to < floor ? floor : cached.to + 1;
  const pools = cached === undefined ? [] : [...cached.pools];
  const ids = new Set(pools.map(poolId));
  const t = "0x" + word(BigInt(token));
  const spans: [number, number][] = [];
  for (let a = from; a <= head; a += s.span) spans.push([a, Math.min(head, a + s.span - 1)]);
  const one = async ([a, b]: [number, number]) => {
    const f = (topics: (string | null)[]) => ({ method: "eth_getLogs", params: [{ address: pm, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), topics }] });
    // Initialize's topics are the event, the pool id, currency0 and currency1 (a log read on base-rpc.publicnode.com,
    // block 0x32fd7c9, 2026-11-03 20:40Z): the token as currency0, then as currency1
    const out = await askScan(rpc, [f(["0x" + INITIALIZE, null, t]), f(["0x" + INITIALIZE, null, null, t])]);
    return out.flatMap((x) => {
      const r = (x as { result?: unknown } | null)?.result;
      if (!Array.isArray(r) || r.length > SCAN_MAX_LOGS) return refuse("rpc_error", "the scan provider answered no logs");
      return r.map((l) => [a, b, l] as const);
    });
  };
  const reading = (async () => {
    const logs: (readonly [number, number, unknown])[][] = [];
    for (let i = 0; i < spans.length; i += s.parallel) logs.push(...(await Promise.all(spans.slice(i, i + s.parallel).map(one))));
    return logs;
  })();
  reading.catch(() => {}); // a refusal below never awaits it
  const b = await agreed;
  if (scanHead - b > maxLag || b - scanHead > maxLag) return refuse("rpc_disagree", `the scan provider's head ${scanHead} is more than ${maxLag} blocks from the agreed block ${b}`);
  const logs = await reading;
  // oldest first, so the pools a token launched with come before any later spam
  const all = logs.flat().sort((x, y) => Number((x[2] as { blockNumber?: unknown })?.blockNumber ?? 0) - Number((y[2] as { blockNumber?: unknown })?.blockNumber ?? 0));
  for (const [a, b, l] of all) {
    const o = l as { address?: unknown; topics?: unknown; data?: unknown; blockNumber?: unknown };
    const topics = o?.topics;
    if (typeof o?.address !== "string" || lower(o.address) !== pm || !Array.isArray(topics) || topics.length !== 4 || topics.some((x) => typeof x !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x))) continue;
    const n = typeof o.blockNumber === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(o.blockNumber) ? Number(o.blockNumber) : -1;
    if (lower(topics[0]) !== "0x" + INITIALIZE || n < a || n > b || typeof o.data !== "string" || !/^0x([0-9a-fA-F]{64}){5}$/.test(o.data)) continue;
    const d = o.data.slice(2);
    const addr = (w: string) => "0x" + w.slice(24);
    const tick = BigInt.asIntN(256, BigInt("0x" + d.slice(64, 128)));
    const k = keyOf({ currency0: addr(topics[2].slice(2)), currency1: addr(topics[3].slice(2)), fee: Number(BigInt("0x" + d.slice(0, 64)) & 0xffffffn), tickSpacing: Number(tick), hooks: addr(d.slice(128, 192)) }, token);
    if (k === null || ids.has(poolId(k))) continue;
    ids.add(poolId(k));
    pools.push(k);
  }
  const commit = () => {
    if (!SCANS.has(key) && SCANS.size >= SCAN_TOKENS) SCANS.delete(SCANS.keys().next().value!);
    SCANS.set(key, { to: Math.max(head, cached?.to ?? 0), pools });
  };
  return { pools, commit };
}

/** The device's quote of `req.route` on the chain's two pinned providers, with every check above; throws EvmQuoteError
 *  (or the builder's EvmPoolBuyError for a route it refuses). It takes no provider and no fetch from its caller: a quote
 *  this returns is one evmPoolBuildQuoted builds from, so its answers come only from the pinned URLs (review of 9a8265b,
 *  N2). Tests run evmPoolBuyQuoteWith, which the index does not export. */
export async function evmPoolBuyQuote(req: EvmPoolBuyQuoteRequest): Promise<EvmPoolBuyQuote> {
  if (typeof req !== "object" || req === null) return refuse("bad_request", "the request is an object");
  const p = venue(req.chain).providers;
  if (p === undefined) return refuse("no_quoter", `${req.chain} has no pinned providers`);
  const s = venue(req.chain).scan;
  // a scan's answer is a list of logs, bounded by the scan provider's own cap per request (16 MiB read at most)
  return evmPoolBuyQuoteWith(req, evmProviders(p, fetch), Date.now(), s === undefined ? undefined : evmJsonRpc(s.url, fetch, 16 << 20));
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

/** evmPoolBuyQuote on the providers `rpcs`, with the device's clock at `nowMs`: what the kit's index exports runs this
 *  with the pinned providers and Date.now(); the tests run it on recorded and planted answers. Not in the index. */
export async function evmPoolBuyQuoteWith(req: EvmPoolBuyQuoteRequest, rpcs: readonly [EvmRpc, EvmRpc], nowMs: number, scan?: EvmRpc): Promise<EvmPoolBuyQuote> {
  if (typeof req !== "object" || req === null) return refuse("bad_request", "the request is an object");
  if (!Number.isFinite(nowMs)) return refuse("bad_request", "the device's clock");
  const { chain, token, amountIn, slippageBps } = req;
  const route = copyRoute(req.route);
  if (!Array.isArray(rpcs) || rpcs.length !== 2 || typeof rpcs[0] !== "function" || typeof rpcs[1] !== "function" || rpcs[0] === rpcs[1]) {
    return refuse("bad_request", "two different providers");
  }
  if (typeof amountIn !== "bigint" || amountIn <= 0n || amountIn >= MAX_IN) return refuse("bad_request", "the amount in is above 0 and below 2^127");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000) return refuse("bad_request", "the slippage is 0 to 9,999 bps");
  if (!isAddress(token) || lower(token) === NATIVE) return refuse("bad_request", "the token is not an address");
  const v = venue(chain);
  const { token: buys } = evmPoolRouteData(chain, route);
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
  const hookless = hooks.length > 0 ? at(route, amountIn, Object.fromEntries(hooks.map((h) => [h, { code: EVM_NOOP_HOOK_CODE }]))) : -1;
  const candidates: { route: EvmRoute; at: number; twice: number; pool?: PoolState | undefined }[] = [];
  const candidate = (r: EvmRoute) => candidates.push({ route: r, at: at(r, amountIn), twice: at(r, 2n * amountIn) });
  if (v.v3 !== undefined) for (const fee of V3_FEES) candidate(v3Direct(v.weth, token, fee));
  if (v.v4 !== undefined) for (const key of V4_KEYS) candidate(v4Direct(NATIVE, token, key));
  // every route, whatever its shape and venue, is also held to each standard two-hop through each listed middle, on
  // both venues (review of b17d1fc, R2, R3), and to each pinned launchpad pool shape for the token
  for (const middle of v.middles) {
    if (lower(middle) === lower(token)) continue;
    if (v.v3 !== undefined) for (const f1 of V3_FEES) for (const f2 of V3_FEES) candidate({ venue: "uniswap-v3", tokens: [v.weth, middle, token], fees: [f1, f2] });
    if (v.v4 === undefined) continue;
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
  if (v.v4 !== undefined) {
    for (const h of v.hookedPools) {
      const from = h.from === "native" ? NATIVE : v.weth;
      candidate({ venue: "uniswap-v4", currencyIn: from, hops: [{ currency: token, fee: h.fee, tickSpacing: h.tickSpacing, hooks: h.hooks, hookData: "0x" }] });
    }
  }
  const wethStart = !startsNative(route);
  const firstOut = route.venue === "uniswap-v3" ? route.tokens[1]! : route.hops[0]!.currency;
  const firstHop: { at: number; twice: number }[] = [];
  if (v.nativeFirst && wethStart && v.v4 !== undefined && lower(firstOut) !== lower(token)) {
    for (const key of V4_KEYS) {
      const r = v4Direct(NATIVE, firstOut, key);
      firstHop.push({ at: at(r, amountIn), twice: at(r, 2n * amountIn) });
    }
  }

  // The pools the device found: its own scan of the PoolManager's Initialize logs (beside the heads' round, to a head
  // within maxLag of the agreed block) and the caller's list, of the token with any currency. Each one's state (price and liquidity, through
  // extsload) is read with everything else; a pool of the native asset or WETH whose hook is none or pinned is quoted
  // in that same round. Every other one is quoted in a second round at the same block, and only once the PoolManager
  // holds it on both providers, so a pool that does not exist never puts an override into a read (review of 5452011,
  // S1): one of the native asset or WETH with its unpinned hook replaced; one of another currency X (at most
  // EVM_QUOTE_MAX_OTHER) as a two-hop the device reads only as a reference, never builds: the native asset, or a
  // pinned launchpad shape's start, to X through each standard and pinned pool, then X to the token (S3)
  const agreed = agreedBlock(rpcs, v.maxLag, nowMs);
  const agreedNumber = agreed.then((x) => x.block.number);
  agreedNumber.catch(() => {}); // a scan that fails first never awaits it; Promise.all below reports the heads' refusal
  const [{ block, confirm }, scanned] = await Promise.all([
    agreed,
    scan !== undefined && v.poolManager !== undefined && v.scan !== undefined ? scanPools(chain, token, v.poolManager, scan, v.scan, agreedNumber, v.maxLag) : null,
  ]);
  const pinned = new Set(v.hookedPools.map((h) => lower(h.hooks)));
  const replaced = (h: string) => h !== NATIVE && !pinned.has(h);
  const found: { key: EvmPoolKey; other: string; price: number; liquidity: number; quotes: { route: EvmRoute; at: number; twice: number }[] }[] = [];
  if (v.v4 !== undefined && v.poolManager !== undefined) {
    const pm = v.poolManager;
    const seen = new Set(candidates.flatMap((c) => (c.route.venue === "uniswap-v4" && c.route.hops.length === 1 ? [poolId(keyOfRoute(c.route))] : [])));
    // the route's own pools: the hook's take in them is H - Q, shown as a fee and bounded by minOut (M360), so R is
    // held to every other pool, never to the route's own pool with its hook replaced
    for (const k of route.venue === "uniswap-v4" ? hopKeys(route) : []) seen.add(poolId(k));
    const hints = (Array.isArray(req.pools) ? req.pools.slice(0, EVM_QUOTE_MAX_HINTS) : []).flatMap((p) => {
      const k = keyOf(p, token);
      return k === null ? [] : [k];
    });
    const keys = [...(scanned?.pools ?? []), ...hints].filter((k) => {
      const id = poolId(k);
      // a hook that is an address the reads call, the token or the pool's other currency is never replaced: such a
      // pool is dropped
      if (seen.has(id) || v.called.has(k.hooks) || k.hooks === lower(token) || k.hooks === k.currency0 || k.hooks === k.currency1) return false;
      seen.add(id);
      return true;
    });
    const state = (slot: bigint) => reads.push({ to: pm, data: "0x" + SEL_EXTSLOAD + word(slot), state: true }) - 1;
    for (const k of keys.slice(0, EVM_QUOTE_MAX_FOUND)) {
      const other = k.currency0 === lower(token) ? k.currency1 : k.currency0;
      const slot = BigInt("0x" + stateSlot(k));
      const f = { key: k, other, price: state(slot), liquidity: state(slot + 3n), quotes: [] as { route: EvmRoute; at: number; twice: number }[] };
      if ((other === NATIVE || other === lower(v.weth)) && !replaced(k.hooks)) {
        const r = routeOfKey(k, token);
        f.quotes.push({ route: r, at: reads.push(v4Read(v.v4, r, amountIn)) - 1, twice: reads.push(v4Read(v.v4, r, 2n * amountIn)) - 1 });
      }
      found.push(f);
    }
  }
  // Where the token has a pool of another currency, the state of each candidate's last pool too: such a pool the
  // device does not price blocks the buy only when it holds more of the token than the pool that sets R
  if (found.some((f) => f.other !== NATIVE && f.other !== lower(v.weth))) {
    const states = new Map<string, PoolState>();
    const stateRead = (to: string, data: string) => reads.push({ to, data, state: true }) - 1;
    const lastPool = (r: EvmRoute): PoolState | undefined => {
      if (r.venue === "uniswap-v4") {
        if (v.poolManager === undefined) return undefined;
        const k = hopKeys(r).at(-1)!;
        const id = poolId(k);
        const slot = BigInt("0x" + stateSlot(k));
        if (!states.has(id)) {
          states.set(id, { price: stateRead(v.poolManager, "0x" + SEL_EXTSLOAD + word(slot)), liquidity: stateRead(v.poolManager, "0x" + SEL_EXTSLOAD + word(slot + 3n)), token0: k.currency0 === lower(token) });
        }
        return states.get(id);
      }
      if (v.v3Factory === undefined) return undefined;
      const [a, b] = [lower(r.tokens[r.tokens.length - 2]!), lower(r.tokens[r.tokens.length - 1]!)];
      const at = v3PoolAddress(v.v3Factory, a, b, r.fees[r.fees.length - 1]!);
      if (!states.has(at)) states.set(at, { price: stateRead(at, "0x" + SEL_V3_SLOT0), liquidity: stateRead(at, "0x" + SEL_V3_LIQUIDITY), token0: BigInt(b) < BigInt(a) });
      return states.get(at);
    };
    for (const c of candidates) c.pool = lastPool(c.route);
  }

  // the lower head's confirmation and the reads at its hash in one round; the confirmation is judged first
  const [confirmed, read] = await Promise.allSettled([confirm(), readBoth(rpcs, block.hash, reads)]);
  if (confirmed.status === "rejected") throw confirmed.reason;
  if (read.status === "rejected") throw read.reason;
  // the block is the same on both providers: the scan keeps what it read up to it
  scanned?.commit();
  const ans = read.value;
  const out = (i: number) => (ans[i]!.kind === "out" ? (ans[i] as { amountOut: bigint }).amountOut : null);

  // The route: a quote, and one that grows with its input
  const q = out(main);
  const m = ans[main]!;
  if (m.kind === "revert" && m.partial) return refuse("partial_fill", "a hookless hop runs out of liquidity (NotEnoughLiquidity)");
  if (q === null || q === 0n) return refuse("no_quote", "the route reverts or quotes nothing");
  const q2 = out(twice);
  if (q2 !== null && q2 <= q) return refuse("partial_fill", `twice the amount quotes ${q2}, not more than ${q}: a pool runs out`);
  // a v3 route has no hook: its quote at twice the amount reverts only when a pool cannot fill it
  if (q2 === null && route.venue === "uniswap-v3") return refuse("partial_fill", "twice the amount reverts on a v3 route");

  // a found pool counts only where the PoolManager holds it: a price (slot0's low 160 bits) and liquidity above 0
  const held = found.filter((f) => {
    const p = out(f.price);
    const l = out(f.liquidity);
    return p !== null && (p & ((1n << 160n) - 1n)) !== 0n && l !== null && (l & ((1n << 128n) - 1n)) !== 0n;
  });
  const stateOf = (f: (typeof found)[number]): PoolState => ({ price: f.price, liquidity: f.liquidity, token0: f.key.currency0 === lower(token) });
  const depth = (p: PoolState | undefined) => (p === undefined ? null : depthOf(out(p.price), out(p.liquidity), p.token0));
  // the second round: the held pools not quoted yet, those of other currencies the deepest in the token first, at most
  // EVM_QUOTE_MAX_OTHER of them; the rest are left unpriced
  const isOther = (f: (typeof found)[number]) => f.other !== NATIVE && f.other !== lower(v.weth);
  const others = held.filter((f) => f.quotes.length === 0 && isOther(f)).sort((x, y) => {
    const [a, b] = [depth(stateOf(x))!, depth(stateOf(y))!];
    return a > b ? -1 : a < b ? 1 : 0;
  });
  const later = [...held.filter((f) => f.quotes.length === 0 && !isOther(f)), ...others.slice(0, EVM_QUOTE_MAX_OTHER)];
  // the pools of other currencies no route prices (those past the bound have no quote at all), found below
  const unpriced: typeof found = [];
  if (later.length > 0) {
    const more: Read[] = [];
    const read2 = (r: EvmV4Route, amount: bigint, hook: string) =>
      reads.length + more.push({ ...v4Read(v.v4!, r, amount), ...(replaced(hook) ? { override: { [hook]: { code: EVM_NOOP_HOOK_CODE } }, group: hook } : {}) }) - 1;
    for (const f of later) {
      const last = { currency: lower(token), fee: f.key.fee, tickSpacing: f.key.tickSpacing, hooks: f.key.hooks, hookData: "0x" };
      const routes: EvmV4Route[] =
        f.other === NATIVE || f.other === lower(v.weth)
          ? [routeOfKey(f.key, token)]
          : [
              ...V4_KEYS.map(([fee, tickSpacing]): EvmV4Route => ({ venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ currency: f.other, fee, tickSpacing, hooks: NATIVE, hookData: "0x" }, last] })),
              ...v.hookedPools.map((h): EvmV4Route => ({ venue: "uniswap-v4", currencyIn: h.from === "native" ? NATIVE : lower(v.weth), hops: [{ currency: f.other, fee: h.fee, tickSpacing: h.tickSpacing, hooks: lower(h.hooks), hookData: "0x" }, last] })),
            ];
      for (const r of routes) f.quotes.push({ route: r, at: read2(r, amountIn, f.key.hooks), twice: read2(r, 2n * amountIn, f.key.hooks) });
    }
    reads.push(...more);
    ans.push(...(await readBoth(rpcs, block.hash, more)));
  }

  // The standard pools: each that quotes and fills completely; native ones only where a native pool must start
  const fills = (c: { at: number; twice: number }, v3 = false) => {
    const a = out(c.at);
    const b = out(c.twice);
    return a !== null && a > 0n && (b === null ? !v3 : b > a);
  };
  const filled: { route: EvmRoute; amountOut: bigint; pool?: PoolState | undefined }[] = candidates.flatMap((c) =>
    fills(c, c.route.venue === "uniswap-v3") ? [{ route: c.route, amountOut: out(c.at)!, pool: c.pool }] : [],
  );
  for (const f of held) {
    const priced = f.quotes.filter((c) => fills(c));
    for (const c of priced) filled.push({ route: c.route, amountOut: out(c.at)!, pool: stateOf(f) });
    // a pool of another currency that holds liquidity and that no route prices
    if (priced.length === 0 && isOther(f)) unpriced.push(f);
  }
  const nativeExists = v.nativeFirst && (filled.some((c) => startsNative(c.route)) || firstHop.some((c) => fills(c)));
  const top = (xs: typeof filled) => xs.reduce<(typeof filled)[number] | null>((m, c) => (m === null || c.amountOut > m.amountOut ? c : m), null);
  const bestOf = (xs: typeof filled) => {
    const b = top(xs);
    return b === null ? null : Object.freeze({ amountOut: b.amountOut, route: copyRoute(b.route) });
  };
  // R is the best of every pool, whatever it starts from: a native pool someone seeded is held to the token's WETH
  // pools too (a launchpad's, on Robinhood). Where a native pool exists a route starts native unless it quotes strictly
  // more than the best native route (native when at least as good); the native_first refusal names that native route.
  // A native pool of the first hop alone, with no native route to the token quoted, still refuses: nothing shows the
  // WETH start beats starting that hop native
  const reference = bestOf(filled);
  // a pool of another currency the device did not price blocks the buy when it holds more of the token than the pool
  // that sets R (its last pool), at the agreed block: the token's real market may be there. A shallower one, such as a
  // pool anyone opened with dust, does not
  if (reference !== null && unpriced.length > 0) {
    const r = depth(top(filled)!.pool);
    const deeper = unpriced.find((f) => r === null || depth(stateOf(f))! > r);
    if (deeper !== undefined) {
      return refuse("no_reference", `the token's pool with ${deeper.other} holds more of it than the pool that sets the reference, and no route from the native asset prices it`);
    }
  }
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

// Every quote evmPoolBuyQuote returned: the quoted builder (trade/evm/buy.ts) builds only from one of these
const QUOTED = new WeakSet<EvmPoolBuyQuote>();
/** True when `q` is a quote evmPoolBuyQuote returned, unchanged (it is frozen). */
export const evmIsDeviceQuote = (q: unknown): q is EvmPoolBuyQuote => typeof q === "object" && q !== null && QUOTED.has(q as EvmPoolBuyQuote);

/** A provider from a JSON-RPC URL: one POST per batch, answers matched to calls by id, at most `maxBytes` read. */
export function evmJsonRpc(url: string, fetchFn: typeof fetch = fetch, maxBytes = 1 << 20): EvmRpc {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return refuse("bad_request", "a provider URL is https");
  return async (calls) => {
    const body = JSON.stringify(calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params })));
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body });
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
