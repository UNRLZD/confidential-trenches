// The device's own quote of an EVM pool buy (card evm-pool-buy-quote; merge notes M357 (1), M360, M366 (4)). W signs a
// buy only at a minOut from this quote: for a hooked v4 hop minOut is the only bound (M360), so it comes from the
// device's own reads, never from a number the helper sends.
//
// Every read is an eth_call at one block hash (EIP-1898, requireCanonical) on two RPC providers, the same calls on
// both, and any answer they do not both give is refused (rpc_disagree): an RPC that lies about a quote, or hides a pool
// by faking a revert, is caught by the other. The reads, all in one JSON-RPC batch per provider:
// - the route's quote Q for the amount in (QuoterV2.quoteExactInput for v3, V4Quoter.quoteExactInput for v4, the
//   chain's pinned quoters), and the same route for twice the amount: a route whose output does not grow with its input
//   has run out of a pool's liquidity, which both quoters report as if the fill were complete (partial_fill; read
//   2026-11-03 on Base: V4Quoter quoted 1e27 wei of ETH into the ETH/USDC 0.05% pool as 284,167 USDC);
// - the standard pools for the pair, the device's own choice: v3 WETH to the token at each standard fee tier and v4
//   native to the token at each standard fee and tick spacing with no hook. The best one that fills completely is the
//   reference R, and a route quoted below it is refused (below_reference, M366 (4)): a helper cannot steer a buy into a
//   pool it seeded or a hook that keeps the difference;
// - for a route with a hooked v4 hop, the same route with each hook's code replaced by a hook that does nothing
//   (eth_call's state override): the hookless output H. The hook's take H - Q is shown as a fee before the buy,
//   information only, never a pop-up (M360). The route's own Q, which the hook ran in, sets minOut;
// - on a chain whose WETH is behind an upgradeable proxy (nativeFirst, Robinhood's aeWETH), the native v4 pools of the
//   route's first hop: a route that starts from WETH is refused when one exists (native_first), and R is then read
//   from native routes only.
//
// minOut = floor(Q x (10000 - slippageBps) / 10000), with Q >= R whenever a standard pool answers.
import {
  copyRoute,
  evmPoolRouteData,
  evmPoolVenues,
  type EvmPoolChain,
  type EvmRoute,
  type EvmV3Route,
  type EvmV4Route,
} from "../../trade/evm/buy-unpinned.ts";

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
};

/** The hook's take on a route with a hooked v4 hop: the hookless output H and H - Q (null when the hookless read
 *  reverts on both providers, as when the hook is the pool's only liquidity). */
export type EvmHookTake = { readonly hookless: bigint | null; readonly take: bigint | null; readonly takeBps: number | null };

export type EvmPoolBuyQuote = {
  readonly chain: EvmPoolChain;
  readonly token: string;
  readonly amountIn: bigint;
  readonly route: EvmRoute;
  /** The block both providers answered at. */
  readonly block: { readonly number: bigint; readonly hash: string };
  /** Q: the route's output, the same on both providers. */
  readonly amountOut: bigint;
  /** What W signs: floor(Q x (10000 - slippageBps) / 10000). */
  readonly minOut: bigint;
  /** R: the best standard pool for the pair, or null when none answers. */
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
  | "native_first"; // the route starts from WETH where a native v4 pool exists
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
  return { weth: v.weth, v3: own("v3"), v4: own("v4"), nativeFirst: Object.hasOwn(v, "nativeFirst") && v.nativeFirst === true };
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

type Read = { to: string; data: string; override?: Record<string, { code: string }> | undefined };
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
  if (raw) return refuse("rpc_error", `${who} answered the multicall with an error`);
  if (Object.hasOwn(o, "error") && typeof o.error === "object" && o.error !== null) {
    const { code, message } = o.error as { code?: unknown; message?: unknown };
    if (code === 3 || (typeof message === "string" && /revert/i.test(message))) return { kind: "revert", partial: false };
    return refuse("rpc_error", `${who} answered error ${String(code).slice(0, 12)}: ${String(message).slice(0, 120)}`);
  }
  return refuse("rpc_error", `${who} answered no result and no error`);
}

// Multicall3 (github.com/mds1/multicall3), the same address on every chain; eth_getCode on all four providers
// (mainnet.base.org, base-rpc.publicnode.com, rpc.mainnet.chain.robinhood.com, robinhood.drpc.org, 2026-11-03 18:00Z):
// 3,808 bytes, keccak 0xd5c15df6…e770891 on each. Every read but the hookless one goes in one aggregate3 call, so a
// provider is asked one batch of at most two calls (robinhood.drpc.org's free plan takes 3, mainnet.base.org 25 a
// second).
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
    const v = BigInt("0x" + r.slice(2 + 2 * o, 66 + 2 * o));
    return v > BigInt(len) ? refuse("rpc_error", `${who} answered a multicall offset outside it`) : Number(v);
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

/** Both providers' answers to `reads` at `hash`, which must be the same: the reads without a state override in one
 *  aggregate3 call, a read with one in its own call. */
async function readBoth(rpcs: readonly [EvmRpc, EvmRpc], hash: string, reads: readonly Read[]): Promise<Answer[]> {
  const at = { blockHash: hash, requireCanonical: true };
  const plain = reads.flatMap((r, i) => (r.override === undefined ? [i] : []));
  const lone = reads.flatMap((r, i) => (r.override === undefined ? [] : [i]));
  const calls: EvmRpcCall[] = [
    { method: "eth_call", params: [{ to: MULTICALL3, data: aggregate(plain.map((i) => reads[i]!)) }, at] },
    ...lone.map((i) => ({ method: "eth_call", params: [{ to: reads[i]!.to, data: reads[i]!.data }, at, reads[i]!.override] })),
  ];
  const both = await Promise.all(rpcs.map((rpc) => ask(rpc, calls)));
  const answers = both.map((b, p) => {
    const who = `provider ${p + 1}`;
    const all: Answer[] = new Array(reads.length);
    unaggregate(b[0], plain.length, who).forEach((x, k) => (all[plain[k]!] = x));
    lone.forEach((i, k) => (all[i] = answerOf(b[1 + k], who) as Answer));
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

/** The block both providers read at: the lower of their latest blocks, by its hash, which the other must hold. */
async function agreedBlock(rpcs: readonly [EvmRpc, EvmRpc]): Promise<{ number: bigint; hash: string }> {
  const call: EvmRpcCall = { method: "eth_getBlockByNumber", params: ["latest", false] };
  const heads = await Promise.all(rpcs.map((rpc) => ask(rpc, [call])));
  const [a, b] = heads.map((h, i) => {
    const r = (h[0] as { result?: unknown } | null)?.result as { number?: unknown; hash?: unknown } | null | undefined;
    const ok = typeof r === "object" && r !== null && typeof r.number === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(r.number) && typeof r.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(r.hash);
    if (!ok) return refuse("rpc_error", `provider ${i + 1} answered no latest block`);
    return { number: BigInt(r!.number as string), hash: lower(r!.hash as string) };
  });
  return a!.number <= b!.number ? a! : b!;
}

const v3Direct = (weth: string, token: string, fee: number): EvmV3Route => ({ venue: "uniswap-v3", tokens: [weth, token], fees: [fee] });
const v4Direct = (from: string, to: string, [fee, tickSpacing]: readonly [number, number]): EvmV4Route => ({
  venue: "uniswap-v4",
  currencyIn: from,
  hops: [{ currency: to, fee, tickSpacing, hooks: NATIVE, hookData: "0x" }],
});
const startsNative = (r: EvmRoute) => r.venue === "uniswap-v4" && lower(r.currencyIn) === NATIVE;

/** The device's quote of `req.route` on the two providers `rpcs`, with every check above; throws EvmQuoteError (or the
 *  builder's EvmPoolBuyError for a route it refuses). */
export async function evmPoolBuyQuote(req: EvmPoolBuyQuoteRequest, rpcs: readonly [EvmRpc, EvmRpc]): Promise<EvmPoolBuyQuote> {
  if (typeof req !== "object" || req === null) return refuse("bad_request", "the request is an object");
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
  const hookless = hooks.length > 0 ? at(route, amountIn, Object.fromEntries(hooks.map((h) => [h, { code: EVM_NOOP_HOOK_CODE }]))) : -1;
  const candidates: { route: EvmRoute; at: number; twice: number }[] = [];
  const candidate = (r: EvmRoute) => candidates.push({ route: r, at: at(r, amountIn), twice: at(r, 2n * amountIn) });
  if (v.v3 !== undefined) for (const fee of V3_FEES) candidate(v3Direct(v.weth, token, fee));
  if (v.v4 !== undefined) for (const key of V4_KEYS) candidate(v4Direct(NATIVE, token, key));
  const wethStart = !startsNative(route);
  const firstOut = route.venue === "uniswap-v3" ? route.tokens[1]! : route.hops[0]!.currency;
  const firstHop: { at: number; twice: number }[] = [];
  if (v.nativeFirst && wethStart && v.v4 !== undefined && lower(firstOut) !== lower(token)) {
    for (const key of V4_KEYS) {
      const r = v4Direct(NATIVE, firstOut, key);
      firstHop.push({ at: at(r, amountIn), twice: at(r, 2n * amountIn) });
    }
  }

  const block = await agreedBlock(rpcs);
  const ans = await readBoth(rpcs, block.hash, reads);
  const out = (i: number) => (ans[i]!.kind === "out" ? (ans[i] as { amountOut: bigint }).amountOut : null);

  // The route: a quote, and one that grows with its input
  const q = out(main);
  const m = ans[main]!;
  if (m.kind === "revert" && m.partial) return refuse("partial_fill", "a hookless hop runs out of liquidity (NotEnoughLiquidity)");
  if (q === null || q === 0n) return refuse("no_quote", "the route reverts or quotes nothing");
  const q2 = out(twice);
  if (q2 !== null && q2 <= q) return refuse("partial_fill", `twice the amount quotes ${q2}, not more than ${q}: a pool runs out`);

  // The standard pools: each that quotes and fills completely; native ones only where a native pool must start
  const fills = (c: { at: number; twice: number }) => {
    const a = out(c.at);
    const b = out(c.twice);
    return a !== null && a > 0n && (b === null || b > a);
  };
  const filled = candidates.flatMap((c) => (fills(c) ? [{ route: c.route, amountOut: out(c.at)! }] : []));
  const nativeExists = v.nativeFirst && (filled.some((c) => startsNative(c.route)) || firstHop.some(fills));
  const pool = nativeExists ? filled.filter((c) => startsNative(c.route)) : filled;
  const best = pool.reduce<{ route: EvmRoute; amountOut: bigint } | null>((m, c) => (m === null || c.amountOut > m.amountOut ? c : m), null);
  const reference = best === null ? null : Object.freeze({ amountOut: best.amountOut, route: copyRoute(best.route) });
  if (nativeExists && wethStart) return refuse("native_first", `${chain}'s WETH is behind an upgradeable proxy and a native v4 pool exists`, reference);
  if (reference !== null && q < reference.amountOut) {
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
