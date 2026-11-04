// A sell from W, the fresh EVM wallet a pool buy paid its token to, on Base or Robinhood Chain (contracts/pool-evm
// SellDelegate.sol; merge notes M363, M366; card evm-pool-sell-tx). W holds no ETH and sends nothing: the helper sends
// one type-4 transaction carrying W's EIP-7702 authorization of the delegate and SellDelegate.sell with W's signed Sell.
// The delegate itself checks only that the router took the whole approval and the ETH gained meets minOut, so a signed
// Sell could make any call (test/HostileSell.t.sol test_R_aSignedArbitraryCallIsStoppedOnlyByMinOut): the device's
// checks here are what keep it to the sell the user asked for (M363 (3)).
//
// The builder takes the sell's fields and a route, and checks, before anything is signed:
// - the target: a v3 route's is on the chain's router list (evmPoolVenues().routers), a v4 route's is the chain's
//   pinned PoolManager (evmPoolVenues().poolManager, card evm-sell-v4-kit), and nothing else;
// - the swap data is made here from the route, never taken from a caller:
//   - v3: SwapRouter02's exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) with
//     recipient W, amountIn the amount, amountOutMinimum minOut, and a path from the token to the chain's WETH (a
//     listed middle allowed, as in the buy; WETH only at the end);
//   - v4: abi.encode(PathKey[]), the path SellDelegate.unlockCallback swaps hop by hop, exact input, inside one
//     PoolManager unlock (contracts/pool-evm/src/SellDelegate.sol): from the token, each hop's currency the next, the
//     last the native asset or the chain's WETH and neither one before it, a middle any other currency (as on the
//     quoted buy); each hop's fee a u24, tick spacing 1 to 32,767, and hooks either none or the hook of a launchpad the
//     venue lists (evmPoolVenues().hookedPools) with that launchpad's own fee and tick spacing, on any hop, as the buy
//     takes a pinned hook (card evm-route-parity); every hop's hook data empty (the device's own, never a route's). A hook is part of
//     the price, so an unlisted hook, or a listed one with another fee or tick spacing, is refused rather than bounded
//     by minOut alone; the kit's index builds a sell only from the device's own quote (checks/evm/quote.ts
//     evmPoolSellQuote, card evm-sell-device-quote). A key that names no initialized pool reverts the whole sell in the
//     PoolManager (PoolNotInitialized), so W keeps its token;
// - the deadline is unix seconds, at least EVM_POOL_SELL_DEADLINE_MIN_S and at most EVM_POOL_SELL_DEADLINE_MAX_S past
//   now;
// - the fee cap is above 0 and under minOut, so the deposit always holds something (and, in the kit's index, at most
//   the device's own fee rule, evmPoolSellFeeMax: trade/evm/sell.ts);
// and returns the sell frozen, held in a module-private set.
//
// W signs Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,
// uint256 feeCap,uint256 deadline,uint256 nonce) (SellDelegate.sol:65) under {name "Blindfill", version "1", chainId,
// verifyingContract: W}: 65 bytes r ‖ s ‖ v, s low, v 27 or 28. W's EIP-7702 authorization is keccak256(0x05 ‖
// rlp([chainId, delegate, nonce])) with the chain's own id from the venue list, never 0 (M363 (4)). No export here takes
// a digest. A stuck sell is replaced by building and signing again with the same nonce and a new deadline; a burned
// precommitment by signing again with a fresh one.
import { EVM_POOL_FEE_STEP, evmPoolFee } from "./pool-fee.ts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  EVM_POOL_MAX_HOPS,
  evmPoolVenues,
  pathKeysAbi,
  venuePins,
  type EvmPoolChain,
  type EvmPoolVenueList,
  type EvmV3Route,
  type EvmV4Hop,
} from "./buy-unpinned.ts";

/** A v4 sell's route: from the token sold, one PathKey per hop (its `currency` the hop's output), ending at the native
 *  asset or the chain's WETH. */
export type EvmV4SellRoute = { venue: "uniswap-v4"; hops: readonly EvmV4Hop[] };
export type EvmSellRoute = EvmV3Route | EvmV4SellRoute;

/** A sell's deadline, seconds past now: at least the helper's send margin (apps/helper pool/evm.ts
 *  EVM_POOL_SEND_MARGIN_MS, 60 s, card helper-pool-senders: a send needs time to be mined before the deadline), at
 *  most the device's cap on a pool request's life (packages/wallet withdraw/request.ts WITHDRAW_DEADLINE_MAX_MS, 600 s,
 *  which the helper's EVM sender takes as POOL_LIFE_MAX_MS). */
export const EVM_POOL_SELL_DEADLINE_MIN_S = 60;
export const EVM_POOL_SELL_DEADLINE_MAX_S = 600;

export type EvmPoolSellErrorCode =
  | "bad_target" // a v3 sell's target is not on the router list, or a v4 sell's is not the pinned PoolManager
  | "token_mismatch" // the route does not start at the token sold
  | "middle_not_listed" // a middle token that is not on the venue list
  | "bad_route" // the route's shape, its end, a hook not on a listed pool; or the chain, W or the pool
  | "bad_amount" // amount, minOut, precommitment or nonce out of range
  | "bad_fee" // the fee cap is 0, or not under minOut
  | "bad_deadline" // the deadline is not seconds within the window past now
  | "not_built" // W signs only a sell evmPoolBuildSellUnpinned returned, for the chain it was built for
  | "bad_key" // W's key is not a key, or not W's
  | "not_deployed" // the chain has no pinned pool or sell delegate yet (pool-evm-deploy)
  | "not_pinned"; // a pool other than the chain's pinned one
export class EvmPoolSellError extends Error {
  readonly code: EvmPoolSellErrorCode;
  constructor(code: EvmPoolSellErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "EvmPoolSellError";
  }
}
const refuse = (code: EvmPoolSellErrorCode, m: string): never => {
  throw new EvmPoolSellError(code, m);
};

const NATIVE = "0x0000000000000000000000000000000000000000";
const U24 = 0xffffff;
const MAX_TICK_SPACING = 32767;
// literals, not expressions: the kit's index reaches the signing page's bundle, which keeps a top-level computation
const U256 = 0x10000000000000000000000000000000000000000000000000000000000000000n;
const U64 = 0x10000000000000000n;
const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const isAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isWallet = (a: unknown): a is string => isAddress(a) && a.toLowerCase() !== NATIVE;
const isUint = (v: unknown, below: bigint): v is bigint => typeof v === "bigint" && v >= 0n && v < below;
const lower = (a: string) => a.toLowerCase();
const toHex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
};
const concat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) out.set(x, o), (o += x.length);
  return out;
};
const word = (v: bigint): Uint8Array => {
  if (v < 0n || v >= U256) throw new Error("not a uint256");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) (out[i] = Number(v & 0xffn)), (v >>= 8n);
  return out;
};
const addressWord = (a: string) => word(BigInt(a));
const addressBytes = (a: string) => word(BigInt(a)).slice(12);
const utf8 = (s: string) => new TextEncoder().encode(s);

function venueOf(chain: EvmPoolChain) {
  const all = evmPoolVenues();
  if (typeof chain !== "string" || !Object.hasOwn(all, chain)) return refuse("bad_route", "no such chain");
  return all[chain];
}

/** What W asks: sell `amount` of `token` through `target` along `route` for at least `minOut` wei, into the chain's
 *  pinned pool with `precommitment`, the sender's fee at most `feeCap`, by `deadline` (unix seconds, checked against
 *  the device's clock), with W's sell nonce `nonce`. */
export type EvmPoolSellRequest = {
  w: string;
  token: string;
  amount: bigint;
  target: string;
  route: EvmSellRoute;
  minOut: bigint;
  precommitment: bigint;
  feeCap: bigint;
  deadline: bigint;
  nonce: bigint;
};
/** The unpinned builder's request: the pool named, not the chain's pin (the tests and the fork fixture's maker). */
export type EvmPoolSellUnpinnedRequest = EvmPoolSellRequest & { pool: string };

/** The Sell W signs (SellDelegate.Sell, data made here), with W and the chain it was checked for. Only
 *  evmPoolBuildSellUnpinned makes one, frozen; evmPoolSignSellUnpinned signs no other. */
export type EvmPoolSell = {
  readonly chain: EvmPoolChain;
  readonly w: string;
  readonly token: string;
  readonly amount: bigint;
  readonly target: string;
  readonly data: string;
  readonly minOut: bigint;
  readonly pool: string;
  readonly precommitment: bigint;
  readonly feeCap: bigint;
  readonly deadline: bigint;
  readonly nonce: bigint;
};

// Every sell evmPoolBuildSellUnpinned returned: a copy, a spread or a hand-made object is not in it
const BUILT = new WeakSet<EvmPoolSell>();

// A copy holds at most this many tokens or fees, before the shape check bounds the route exactly
const COPY_MAX = 64;
const copyList = (a: unknown): unknown[] => {
  if (!Array.isArray(a)) return refuse("bad_route", "a route's tokens and fees are lists");
  const n = a.length;
  if (!Number.isSafeInteger(n) || n > COPY_MAX) return refuse("bad_route", "a route's list is too long");
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(a[i]);
  return out;
};

/** The target's call data for a checked route: SwapRouter02's exactInput (v3) or SellDelegate's PathKey[] (v4). The
 *  route is read once, into a copy; the target must be the venue's for the route's kind. */
function swapData(chain: EvmPoolChain, token: string, route: unknown, target: string, w: string, amount: bigint, minOut: bigint): string {
  const venue = venueOf(chain);
  if (typeof route !== "object" || route === null) return refuse("bad_route", "a route is an object");
  const kind = (route as Record<string, unknown>).venue;
  const pm = Object.hasOwn(venue, "poolManager") && isAddress(venue.poolManager) ? lower(venue.poolManager) : undefined;
  if (kind === "uniswap-v4") {
    if (pm === undefined || lower(target) !== pm) return refuse("bad_target", `a v4 sell goes only to ${chain}'s pinned PoolManager, not ${target}`);
    return v4Data(chain, token, (route as Record<string, unknown>).hops);
  }
  if (kind !== "uniswap-v3") return refuse("bad_route", "a sell runs on Uniswap v3's SwapRouter02 or v4's PoolManager");
  if (!venue.routers.some((r) => lower(r) === lower(target))) return refuse("bad_target", `a v3 sell goes only to a listed router, not ${target}`);
  return v3Data(chain, token, route, w, amount, minOut);
}

/** SellDelegate's v4 data: abi.encode(PathKey[]) of a checked copy of `hopsIn` (see the header). */
function v4Data(chain: EvmPoolChain, token: string, hopsIn: unknown, anyHook = false): string {
  const venue = venueOf(chain);
  const hops = copyList(hopsIn).map((h) => {
    if (typeof h !== "object" || h === null) return refuse("bad_route", "a hop is an object");
    const { currency, fee, tickSpacing, hooks, hookData } = h as Record<string, unknown>;
    return Object.freeze({ currency, fee, tickSpacing, hooks, hookData });
  });
  if (hops.length < 1 || hops.length > EVM_POOL_MAX_HOPS) return refuse("bad_route", `a v4 sell is 1 to ${EVM_POOL_MAX_HOPS} hops`);
  const weth = lower(venue.weth);
  let from = lower(token);
  hops.forEach((h, i) => {
    const { currency, fee, tickSpacing, hooks, hookData } = h;
    if (!isAddress(currency) || !isAddress(hooks)) refuse("bad_route", "a hop's currency or hooks is not an address");
    if (!Number.isInteger(fee) || (fee as number) < 0 || (fee as number) > U24) refuse("bad_route", "a v4 fee is a u24");
    if (!Number.isInteger(tickSpacing) || (tickSpacing as number) < 1 || (tickSpacing as number) > MAX_TICK_SPACING) {
      refuse("bad_route", `a v4 tick spacing is 1 to ${MAX_TICK_SPACING}`);
    }
    const to = lower(currency as string);
    const last = i === hops.length - 1;
    if (to === from) refuse("bad_route", "a hop buys what it spends");
    if (last ? to !== NATIVE && to !== weth : to === NATIVE || to === weth) refuse("bad_route", "a v4 sell ends at the native asset or the chain's WETH, and only there");
    // a v4 middle need not be listed, as on the quoted buy (buy-unpinned.ts checkRoute): SellDelegate.unlockCallback
    // swaps hop by hop inside one unlock and each hop must spend all the hop before gave (PartialFill), so a middle's
    // deltas net to zero there and no middle token moves (card evm-route-parity: the sell leaves through every pool the
    // buy enters through)
    // hook data is the device's, and the device makes none: a listed hook that reads a trade referrer from it would
    // let whoever wrote it name itself (review of a22060d, item 5)
    if (hookData !== "0x") refuse("bad_route", "a sell's hook data is the device's own: empty");
    if (!anyHook && lower(hooks as string) !== NATIVE) {
      // a hook only of a launchpad the venue lists, with that launchpad's own fee and tick spacing, on any hop: the buy
      // takes a pinned hook on any pool the device finds (checks/evm/quote.ts `pinned`), and the sell leaves through
      // every pool the buy enters through (card evm-route-parity; a Zora coin pairs its creator coin, which pairs ZORA,
      // each through Zora's hook). An unlisted hook, or a listed one with another fee or tick spacing, is refused
      if (!evmHookListed(chain, hooks as string, fee as number, tickSpacing as number)) refuse("bad_route", `the hook ${hooks} with fee ${fee} and tick spacing ${tickSpacing} is not a launchpad pool the venue lists`);
    }
    from = to;
  });
  return toHex(concat(word(0x20n), pathKeysAbi(hops as EvmV4Hop[])));
}

/** SwapRouter02's exactInput call for a checked path (one frozen copy, each field read once). */
function v3Data(chain: EvmPoolChain, token: string, route: object, w: string, amount: bigint, minOut: bigint): string {
  const venue = venueOf(chain);
  const { tokens: t, fees: f } = route as Record<string, unknown>;
  const tokens = copyList(t);
  const fees = copyList(f);
  if (fees.length < 1 || fees.length > EVM_POOL_MAX_HOPS || tokens.length !== fees.length + 1) {
    return refuse("bad_route", `a route is 1 to ${EVM_POOL_MAX_HOPS} hops, one more token than fees`);
  }
  for (const x of fees) if (!Number.isInteger(x) || (x as number) < 0 || (x as number) > U24) refuse("bad_route", "a fee is a u24");
  if (!tokens.every(isAddress)) return refuse("bad_route", "a token is not an address");
  const path = tokens as string[];
  if (lower(path[0]!) !== lower(token)) return refuse("token_mismatch", `the route sells ${path[0]}, not ${token}`);
  const weth = lower(venue.weth);
  if (lower(path[path.length - 1]!) !== weth) return refuse("bad_route", "a sell ends at the chain's WETH");
  if (path.slice(0, -1).some((x) => lower(x) === weth)) return refuse("bad_route", "WETH may only end a sell");
  const listed = new Set(venue.middles.map(lower));
  for (const x of path.slice(1, -1)) if (!listed.has(lower(x))) refuse("middle_not_listed", `${x} is not on the venue list`);
  for (let i = 1; i < path.length; i++) if (lower(path[i]!) === lower(path[i - 1]!)) refuse("bad_route", "a hop buys what it spends");
  const packed = [addressBytes(path[0]!)];
  (fees as number[]).forEach((x, i) => packed.push(Uint8Array.of(x >> 16, (x >> 8) & 0xff, x & 0xff), addressBytes(path[i + 1]!)));
  const p = concat(...packed);
  const padded = new Uint8Array(Math.ceil(p.length / 32) * 32);
  padded.set(p);
  // abi.encode of one dynamic tuple: its offset, then (path's offset 0x80, recipient, amountIn, amountOutMinimum),
  // then path, length and right-padded bytes
  const selector = keccak_256(utf8("exactInput((bytes,address,uint256,uint256))")).slice(0, 4);
  return toHex(concat(selector, word(0x20n), word(0x80n), addressWord(w), word(amount), word(minOut), word(BigInt(p.length)), padded));
}

/** True when `hooks` is the hook of a launchpad the venue lists for `chain`, with that launchpad's own fee and tick
 *  spacing: the one rule for a hooked pool, which the sell builder takes on any hop and the device's buy and sell
 *  quotes trust as it is (checks/evm/quote.ts routeSet; card evm-route-parity). */
export function evmHookListed(chain: EvmPoolChain, hooks: string, fee: number, tickSpacing: number): boolean {
  const venue = venueOf(chain);
  const shapes = Object.hasOwn(venue, "hookedPools") ? venue.hookedPools! : [];
  return isAddress(hooks) && shapes.some((p) => lower(p.hooks) === lower(hooks) && p.fee === fee && p.tickSpacing === tickSpacing);
}

/** Refuses (throws EvmPoolSellError) a sell route the builder would not take for `token` on `chain`, checked as the
 *  builder checks it; the device's quote (checks/evm/quote.ts) picks only among the routes this takes. */
export function evmSellRouteCheck(chain: EvmPoolChain, token: string, route: EvmSellRoute): void {
  if (typeof route !== "object" || route === null) return refuse("bad_route", "a sell route is an object");
  if (route.venue === "uniswap-v4") v4Data(chain, token, route.hops);
  else if (route.venue === "uniswap-v3") v3Data(chain, token, route, token, 1n, 1n);
  else refuse("bad_route", "a sell runs on Uniswap v3's SwapRouter02 or v4's PoolManager");
}

/** The sell W asked for on `chain`, after every check (see the header); refused with its own code otherwise. */
export function evmPoolBuildSellUnpinned(chain: EvmPoolChain, req: EvmPoolSellUnpinnedRequest): EvmPoolSell {
  if (typeof req !== "object" || req === null) return refuse("bad_route", "a sell request is an object");
  const { w, token, amount, target, route, minOut, pool, precommitment, feeCap, deadline, nonce } = req;
  const venue = venueOf(chain);
  if (!isWallet(w)) return refuse("bad_route", "W is not an address");
  if (!isWallet(token) || lower(token) === lower(venue.weth)) return refuse("bad_route", "the token is not an address, or is WETH");
  if (!isWallet(pool)) return refuse("bad_route", "the pool is not an address");
  if (!isAddress(target)) return refuse("bad_target", `${target} is not an address`);
  if (!isUint(amount, U256) || amount === 0n) return refuse("bad_amount", "amount is a uint256 above 0");
  if (!isUint(minOut, U256) || minOut === 0n) return refuse("bad_amount", "minOut is a uint256 above 0");
  if (!isUint(precommitment, FIELD_P)) return refuse("bad_amount", "the precommitment is a field element");
  if (!isUint(nonce, U256)) return refuse("bad_amount", "the nonce is a uint256");
  if (!isUint(feeCap, U256) || feeCap === 0n || feeCap >= minOut) return refuse("bad_fee", "the fee cap is above 0 and under minOut");
  // the device's own clock, never a caller's now (M370 (3)): a now in milliseconds would make a sell that never expires
  const t = Math.floor(Date.now() / 1000);
  if (typeof deadline !== "bigint" || deadline < BigInt(t + EVM_POOL_SELL_DEADLINE_MIN_S) || deadline > BigInt(t + EVM_POOL_SELL_DEADLINE_MAX_S)) {
    return refuse("bad_deadline", `the deadline is ${EVM_POOL_SELL_DEADLINE_MIN_S} to ${EVM_POOL_SELL_DEADLINE_MAX_S} seconds past now (${t})`);
  }
  const data = swapData(chain, token, route, target, w, amount, minOut);
  const built: EvmPoolSell = Object.freeze({ chain, w, token, amount, target, data, minOut, pool, precommitment, feeCap, deadline, nonce });
  BUILT.add(built);
  return built;
}

/** The 0x address of a secp256k1 key, lower case. */
const addressOf = (secretKey: Uint8Array) => toHex(keccak_256(secp256k1.getPublicKey(secretKey, false).slice(1)).slice(12));

const checkKey = (secretKey: Uint8Array) => {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32 || !secp256k1.utils.isValidSecretKey(secretKey)) {
    refuse("bad_key", "W's key is a 32-byte secp256k1 key");
  }
};

/** W's signature of `built`: the EIP-712 digest of SellDelegate._sellDigest, made here under W's own address and the
 *  chain id of the chain `built` was built for. 65 bytes r ‖ s ‖ v, s low, v 27 or 28. `built` must be a sell
 *  evmPoolBuildSellUnpinned returned for `chain` (not_built), and `secretKey` must be W's (bad_key). */
export function evmPoolSignSellUnpinned(secretKey: Uint8Array, chain: EvmPoolChain, built: EvmPoolSell): Uint8Array {
  checkKey(secretKey);
  if (!BUILT.has(built) || built.chain !== chain) return refuse("not_built", "W signs only a sell evmPoolBuildSellUnpinned returned for this chain");
  if (addressOf(secretKey) !== lower(built.w)) return refuse("bad_key", "the key is not W's");
  return signDigest(secretKey, sellDigest(built));
}

/** SellDelegate._sellDigest of `s` under W's own address, on the chain it was built for. */
function sellDigest(s: Omit<EvmPoolSell, "data"> & { data: string }): Uint8Array {
  const built = s;
  const chainId = venueOf(built.chain).chainId;
  const domain = keccak_256(
    concat(
      keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
      keccak_256(utf8("Blindfill")),
      keccak_256(utf8("1")),
      word(BigInt(chainId)),
      addressWord(built.w),
    ),
  );
  const type = keccak_256(
    utf8("Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,uint256 deadline,uint256 nonce)"),
  );
  const struct = keccak_256(
    concat(
      type,
      addressWord(built.token),
      word(built.amount),
      addressWord(built.target),
      keccak_256(fromHex(built.data)),
      word(built.minOut),
      addressWord(built.pool),
      word(built.precommitment),
      word(built.feeCap),
      word(built.deadline),
      word(built.nonce),
    ),
  );
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), domain, struct));
}

/** 65 bytes r ‖ s ‖ v of `digest` by `secretKey`, s low, v 27 or 28. */
function signDigest(secretKey: Uint8Array, digest: Uint8Array): Uint8Array {
  const rec = secp256k1.sign(digest, secretKey, { prehash: false, lowS: true, format: "recovered" });
  // noble's recovered form is the recovery bit, then r and s
  const out = new Uint8Array(65);
  out.set(rec.slice(1, 65), 0);
  out[64] = 27 + rec[0]!;
  return out;
}

/** RLP of a non-negative integer: the empty string for 0, else its big-endian bytes with no leading zero. */
function rlpUint(v: bigint): Uint8Array {
  if (v === 0n) return Uint8Array.of(0x80);
  const b: number[] = [];
  for (let x = v; x > 0n; x >>= 8n) b.unshift(Number(x & 0xffn));
  return b.length === 1 && b[0]! < 0x80 ? Uint8Array.of(b[0]!) : Uint8Array.of(0x80 + b.length, ...b);
}

/** W's EIP-7702 authorization, as a type-4 transaction's authorization list carries it. */
export type EvmPoolSellAuthorization = { readonly chainId: number; readonly address: string; readonly nonce: bigint; readonly yParity: 0 | 1; readonly r: string; readonly s: string };

/** W's EIP-7702 authorization of `delegate` on `chain` at W's account nonce `nonce`: keccak256(0x05 ‖ rlp([chainId,
 *  delegate, nonce])) made here, with the chain's own id from the venue list, never 0 (M363 (4)); s low. The caller
 *  picks the delegate until pool-evm-deploy pins it in the venue list. */
export function evmPoolSignSellAuthorizationUnpinned(secretKey: Uint8Array, chain: EvmPoolChain, delegate: string, nonce: bigint): EvmPoolSellAuthorization {
  checkKey(secretKey);
  const chainId = venueOf(chain).chainId;
  if (!isWallet(delegate)) return refuse("bad_route", "the delegate is not an address");
  if (!isUint(nonce, U64 - 1n)) return refuse("bad_amount", "the nonce is under 2^64 - 1 (EIP-7702)");
  const items = concat(rlpUint(BigInt(chainId)), Uint8Array.of(0x94, ...addressBytes(delegate)), rlpUint(nonce));
  const digest = keccak_256(concat(Uint8Array.of(0x05, 0xc0 + items.length), items));
  const rec = secp256k1.sign(digest, secretKey, { prehash: false, lowS: true, format: "recovered" });
  return Object.freeze({ chainId, address: delegate, nonce, yParity: rec[0] as 0 | 1, r: toHex(rec.slice(1, 33)), s: toHex(rec.slice(33, 65)) });
}

// The sim sell (card evm-quote-exec-sim): the device prices a route only where W's own sell through it executes, shown
// by an eth_call of SellDelegate.sell from W at the quote's agreed block on both providers (checks/evm/quote.ts). That
// call needs W's signature, so W signs a sim Sell, which can never land on chain for one reason: its pool is
// EVM_SELL_SIM, which has no code, so SellDelegate's deposit call to it reverts when its empty answer is decoded as a
// uint256 (the eth_call puts code there that returns msg.value). Its deadline is the agreed block's own timestamp (an
// eth_call at a block hash runs at that block's timestamp: test/evm-sim-facts.test.ts), but that does not stop it
// landing: SellDelegate.sell reverts only once block.timestamp > deadline (SellDelegate.sol:140), and later blocks can
// share the agreed block's timestamp (Robinhood blocks 105948851-105948858 share 1793800266, read on
// rpc.mainnet.chain.robinhood.com 2026-11-04 14:2xZ, so a deadline at 105948851's time holds for the 7 blocks after it).
// The signer takes only a sim whose pool is EVM_SELL_SIM and whose deadline is at most the agreed block's timestamp,
// itself at most the device's clock. A sim may carry any route (one the sell builder refuses can still be the
// reference: the sim is what drops the fake ones); its nonce is W's real one, read at the block (a hook can read
// nonce(), so no other nonce is ever shown to it).

/** The sim sell's pool: the low 20 bytes of keccak256("blindfill.sell.sim.v1"). No key and no init code is known
 *  for it, so no code and no 7702 delegation can ever be put there. */
export const EVM_SELL_SIM = toHex(keccak_256(utf8("blindfill.sell.sim.v1")).slice(12));

/** The sale as the helper's EVM pool sender sends it, which the sim's eth_call copies (checks/evm/quote.ts): its gas
 *  limit, and its tip per chain (maxPriorityFeePerGas; maxFeePerGas is at least the base fee plus it, so tx.gasprice is
 *  the base fee plus it). Pins, never reads: the helper's sell sender signs with exactly these. The gas is the bound
 *  above every measured sell (contracts/pool-evm/script/testnet-run.mjs GAS.sell); each tip is what
 *  eth_maxPriorityFeePerGas answered on the chain's providers (mainnet.base.org, base-rpc.publicnode.com,
 *  sepolia.base.org, rpc.mainnet.chain.robinhood.com, rpc.testnet.chain.robinhood.com, 2026-11-04 14:10Z): Base's
 *  1,000,000 wei, Robinhood's 0 (an Arbitrum chain, whose gas price is the base fee). */
export const EVM_POOL_SELL_GAS = 1_000_000n;
// a function, not a table: no top-level call (the kit's index reaches the signing page's bundle)
export const evmPoolSellTip = (chain: EvmPoolChain): bigint => (chain === "base" || chain === "base-sepolia" ? 1_000_000n : 0n);
/** The intrinsic gas of the sale's one EIP-7702 authorization (PER_EMPTY_ACCOUNT_COST), which an eth_call with no
 *  authorization list does not charge: the sim's gas is EVM_POOL_SELL_GAS less it, so its execution is given what the
 *  sale's is. */
export const EVM_7702_AUTH_GAS = 25_000n;

/** The device's own cap on what the sender takes from a sale (card evm-buy-hookdata-fee): the kit's relay fee rule
 *  (pool-fee.ts evmPoolFee) with the sale's gas limit EVM_POOL_SELL_GAS at the base fee of the sell quote's agreed block
 *  plus the sale's tip, the chain fee read at that block on both providers (evmPoolChainFeeReads), and a floor of one
 *  step. Never a caller's figure: the kit's sell builder refuses a fee cap above it (quoted.ts). */
export function evmPoolSellFeeMax(chain: EvmPoolChain, baseFeePerGas: bigint, chainFee: bigint): bigint {
  return evmPoolFee({ floor: EVM_POOL_FEE_STEP, gas: EVM_POOL_SELL_GAS, gasPrice: baseFeePerGas + evmPoolSellTip(chain), chainFee });
}

/** A sim sell: as EvmPoolSell, into EVM_SELL_SIM, with no fee and no precommitment. */
export type EvmSellSim = EvmPoolSell & { readonly sim: true };
const SIMS = new WeakSet<EvmSellSim>();

/** The sim of W selling `amount` of `token` through the v4 route `hops` (any hook) for at least `minOut`, at W's
 *  sell nonce `nonce`, with the deadline `deadline` (the agreed block's timestamp). */
export function evmPoolBuildSimSellUnpinned(chain: EvmPoolChain, req: { w: string; token: string; amount: bigint; hops: unknown; minOut: bigint; nonce: bigint; deadline: bigint }): EvmSellSim {
  if (typeof req !== "object" || req === null) return refuse("bad_route", "a sim is an object");
  const { w, token, amount, hops, minOut, nonce, deadline } = req;
  const venue = venueOf(chain);
  if (!isWallet(w) || !isWallet(token)) return refuse("bad_route", "W or the token is not an address");
  if (!isUint(amount, U256) || amount === 0n || !isUint(minOut, U256) || minOut === 0n || !isUint(nonce, U256)) return refuse("bad_amount", "amount, minOut or the nonce");
  if (!isUint(deadline, U64)) return refuse("bad_deadline", "the deadline is a block's timestamp");
  const pm = Object.hasOwn(venue, "poolManager") && isAddress(venue.poolManager) ? lower(venue.poolManager) : undefined;
  if (pm === undefined) return refuse("not_deployed", `${chain} has no pinned PoolManager`);
  const data = v4Data(chain, token, hops, true);
  const sim: EvmSellSim = Object.freeze({ chain, w: lower(w), token: lower(token), amount, target: pm, data, minOut, pool: EVM_SELL_SIM, precommitment: 0n, feeCap: 0n, deadline, nonce, sim: true as const });
  SIMS.add(sim);
  return sim;
}

/** W's signature of a sim evmPoolBuildSimSellUnpinned returned, only where its pool is EVM_SELL_SIM and its deadline
 *  <= `blockTimestamp` (the agreed block's, unix seconds) <= the device's clock `nowMs`. */
export function evmPoolSignSimSellUnpinned(secretKey: Uint8Array, chain: EvmPoolChain, sim: EvmSellSim, blockTimestamp: bigint, nowMs: number): Uint8Array {
  checkKey(secretKey);
  if (!SIMS.has(sim) || sim.chain !== chain) return refuse("not_built", "W signs only a sim evmPoolBuildSimSellUnpinned returned for this chain");
  if (lower(sim.pool) !== EVM_SELL_SIM) return refuse("not_pinned", "a sim's pool is EVM_SELL_SIM");
  if (typeof blockTimestamp !== "bigint" || typeof sim.deadline !== "bigint" || sim.deadline > blockTimestamp) return refuse("bad_deadline", "a sim's deadline is at most the agreed block's timestamp");
  if (!Number.isFinite(nowMs) || blockTimestamp * 1000n > BigInt(Math.floor(nowMs))) return refuse("bad_deadline", "the agreed block's timestamp is past the device's clock");
  if (addressOf(secretKey) !== lower(sim.w)) return refuse("bad_key", "the key is not W's");
  return signDigest(secretKey, sellDigest(sim));
}

/** The calldata of SellDelegate.sell(sell, fee, signature). */
export function evmSellCallData(s: EvmPoolSell, fee: bigint, signature: Uint8Array): string {
  const data = fromHex(s.data);
  const pad = (b: Uint8Array) => {
    const out = new Uint8Array(Math.ceil(b.length / 32) * 32);
    out.set(b);
    return out;
  };
  // the tuple (10 words of head, `data` its one dynamic field at 0x140), then fee, then the signature
  const tuple = concat(
    addressWord(s.token), word(s.amount), addressWord(s.target), word(0x140n), word(s.minOut), addressWord(s.pool),
    word(s.precommitment), word(s.feeCap), word(s.deadline), word(s.nonce), word(BigInt(data.length)), pad(data),
  );
  const selector = keccak_256(utf8("sell((address,uint256,address,bytes,uint256,address,uint256,uint256,uint256,uint256),uint256,bytes)")).slice(0, 4);
  return toHex(concat(selector, word(0x60n), word(fee), word(BigInt(0x60 + tuple.length)), tuple, word(BigInt(signature.length)), pad(signature)));
}

// The pinned sell (M370): what the kit's index exports as evmPoolBuildSell, evmPoolSignSell and
// evmPoolSignSellAuthorization (sell.ts), here with the venue list as an input so the tests can pin a list of their own;
// the index's functions pass evmPoolVenues(). W's proceeds go only to the chain's pinned pool, and W delegates only to
// the chain's pinned sell delegate: a helper that names its own would take them (the review of 8fd535f).

/** The pins of `chain` in `venues` (buy-unpinned.ts's venuePins: own keys only), refused as a sell's error. */
function pinsOf(venues: EvmPoolVenueList, chain: EvmPoolChain): ReturnType<typeof venuePins> {
  if (typeof chain !== "string" || !Object.hasOwn(venues, chain)) return refuse("bad_route", "no such chain");
  return venuePins(venues, chain);
}

/** evmPoolBuildSellUnpinned into the chain's pinned pool. */
export function pinnedBuildSell(venues: EvmPoolVenueList, chain: EvmPoolChain, req: EvmPoolSellRequest): EvmPoolSell {
  const pool = pinsOf(venues, chain).pool;
  if (pool === undefined) return refuse("not_deployed", `${chain} has no pinned pool yet`);
  // a request that is not an object copies to { pool } alone, which the unpinned builder refuses (bad_route)
  return evmPoolBuildSellUnpinned(chain, { ...req, pool });
}

/** evmPoolSignSellUnpinned of a sell into the chain's pinned pool only. */
export function pinnedSignSell(venues: EvmPoolVenueList, secretKey: Uint8Array, chain: EvmPoolChain, built: EvmPoolSell): Uint8Array {
  const pool = pinsOf(venues, chain).pool;
  if (pool === undefined) return refuse("not_deployed", `${chain} has no pinned pool to sign a sell into yet`);
  // a sell the builder did not return is left to the unpinned signer, which refuses it (not_built)
  if (BUILT.has(built) && lower(built.pool) !== lower(pool)) return refuse("not_pinned", `the sell's pool is not ${chain}'s pinned pool`);
  return evmPoolSignSellUnpinned(secretKey, chain, built);
}

/** evmPoolSignSimSellUnpinned on a chain that pins a sell delegate (only there does the device sim a sell). */
export function pinnedSignSimSell(venues: EvmPoolVenueList, secretKey: Uint8Array, chain: EvmPoolChain, sim: EvmSellSim, blockTimestamp: bigint, nowMs: number): Uint8Array {
  if (pinsOf(venues, chain).sellDelegate === undefined) return refuse("not_deployed", `${chain} has no pinned sell delegate yet`);
  return evmPoolSignSimSellUnpinned(secretKey, chain, sim, blockTimestamp, nowMs);
}

/** evmPoolSignSellAuthorizationUnpinned of the chain's pinned sell delegate only. */
export function pinnedSignSellAuthorization(venues: EvmPoolVenueList, secretKey: Uint8Array, chain: EvmPoolChain, nonce: bigint): EvmPoolSellAuthorization {
  const delegate = pinsOf(venues, chain).sellDelegate;
  if (delegate === undefined) return refuse("not_deployed", `${chain} has no pinned sell delegate yet`);
  return evmPoolSignSellAuthorizationUnpinned(secretKey, chain, delegate, nonce);
}
