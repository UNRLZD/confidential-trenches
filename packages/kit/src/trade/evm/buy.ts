// A private buy on Base or Robinhood Chain from the EVM pool (contracts/pool-evm, PrivacyPoolSimple.buy; merge notes
// M354, M357, M358 (3), M360; card evm-pool-buy-tx). Device side: the device builds the adapter's route from the user's
// own request and W signs the pool's EIP-712 Buy over it, so the relayer that sends it can change nothing W signed.
//
// The adapters (contracts/pool-evm/src/adapters) and the `data` each reads:
// - Uniswap v3 (UniswapV3Adapter): SwapRouter02's packed path, token (20) then fee (u24, 3 bytes) and token per hop,
//   starting at the chain's WETH (the router wraps the native value).
// - Uniswap v4 (UniswapV4Adapter): abi.encode(address currencyIn, PathKey[] path), currencyIn the native asset
//   (address 0) or WETH, each PathKey (intermediateCurrency, fee u24, tickSpacing i24, hooks, hookData) in
//   v4-periphery's field order. A hook is part of the price (M360): for a hooked hop minOut is the bound.
// The routes the fork tests run are recorded in contracts/pool-evm/test/fixtures/kit-routes.json, which the forge
// tests check against their own routes and test/evm-pool-buy.test.ts against these builders, byte for byte.
//
// Refusals (M358 (3), from the pool-evm-buy review): WETH anywhere after a route's first token (INFO-1) and a middle
// token that is not on the chain's venue list (INFO-2), each with its own code; and a route that buys another token
// than the user picked (token_mismatch, M366 (1)).
//
// W signs Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)
// under the domain {name "Blindfill", version "1", chainId, verifyingContract: the pool} (contracts/pool-evm
// PrivacyPool.sol _typedDigest, PrivacyPoolSimple.sol _buyDigest), with the proof's nullifier, context and
// withdrawnValue (M354, M357 (2)): 65 bytes r ‖ s ‖ v, s in the lower half (EIP-2), v 27 or 28. The key is W's, from
// the wallet's own derivation (packages/wallet freshWallet "evm"), and stays on the device; the pool checks it is the
// request's recipient. W signs no digest a caller hands in (M366 (2)): only a buy evmPoolBuild returned, for its chain,
// with the digest made here.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export type EvmPoolChain = "base" | "robinhood";

/** The chains the EVM pool runs on: chain id, WETH (a route's only wrapped start) and the middle tokens a route may
 *  pass through (the venue list). */
export const EVM_POOL_VENUES: Readonly<Record<EvmPoolChain, { chainId: number; weth: string; middles: readonly string[] }>> = {
  base: {
    chainId: 8453,
    weth: "0x4200000000000000000000000000000000000006",
    middles: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"], // USDC
  },
  robinhood: {
    chainId: 4663,
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // aeWETH, an upgradeable proxy (contracts/pool-evm/NOTICE)
    middles: ["0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"], // USDG
  },
};

/** Most hops a route takes; a fee fits u24; v4's tick spacing is 1 to 32,767 (v4-core TickMath); hook data is bounded. */
export const EVM_POOL_MAX_HOPS = 4;
export const EVM_POOL_MAX_HOOK_DATA = 1024;
const U24 = 0xffffff;
const MAX_TICK_SPACING = 32767;
const NATIVE = "0x0000000000000000000000000000000000000000";

export type EvmV3Route = { venue: "uniswap-v3"; tokens: readonly string[]; fees: readonly number[] };
export type EvmV4Hop = { currency: string; fee: number; tickSpacing: number; hooks: string; hookData: string };
export type EvmV4Route = { venue: "uniswap-v4"; currencyIn: string; hops: readonly EvmV4Hop[] };
export type EvmRoute = EvmV3Route | EvmV4Route;

export type EvmPoolBuyErrorCode =
  | "weth_after_first" // INFO-1: WETH anywhere after the route's first token
  | "middle_not_listed" // INFO-2: a middle token that is not on the venue list
  | "token_mismatch" // the route buys another token than the user picked
  | "not_built" // W signs only a buy evmPoolBuild returned, for the chain it was built for
  | "bad_route" // the route's shape: hops, fees, tick spacing, addresses, hook data, start or end; the chain or pool
  | "bad_amount" // minOut, nullifier, context or value out of range
  | "bad_key"; // W's key is not a key
export class EvmPoolBuyError extends Error {
  readonly code: EvmPoolBuyErrorCode;
  constructor(code: EvmPoolBuyErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "EvmPoolBuyError";
  }
}
const refuse = (code: EvmPoolBuyErrorCode, m: string): never => {
  throw new EvmPoolBuyError(code, m);
};

const isAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const lower = (a: string) => a.toLowerCase();
const hexBytes = (h: string): Uint8Array => {
  if (typeof h !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(h)) return refuse("bad_route", "hook data is not 0x hex");
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
};
const toHex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const concat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) out.set(x, o), (o += x.length);
  return out;
};
const word = (v: bigint): Uint8Array => {
  if (v < 0n || v >= 1n << 256n) throw new Error("not a uint256");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) (out[i] = Number(v & 0xffn)), (v >>= 8n);
  return out;
};
const addressWord = (a: string) => word(BigInt(a));
const addressBytes = (a: string) => word(BigInt(a)).slice(12);

/** The venue of `chain`, or a refusal: only the list's own keys, never one an object inherits ("constructor"). */
function venueOf(chain: EvmPoolChain) {
  if (typeof chain !== "string" || !Object.hasOwn(EVM_POOL_VENUES, chain)) return refuse("bad_route", "no such chain");
  return EVM_POOL_VENUES[chain];
}

// A copy holds at most this many items per list, before the shape checks bound the route exactly
const COPY_MAX = 64;
const copyList = (a: unknown): unknown[] => {
  if (!Array.isArray(a)) return refuse("bad_route", "a route's tokens, fees and hops are lists");
  const n = a.length;
  if (!Number.isSafeInteger(n) || n > COPY_MAX) return refuse("bad_route", "a route's list is too long");
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(a[i]);
  return out;
};

/** One frozen copy of `route`, each field read once (merge note M366 (3)): the checks and the encoder read only this,
 *  so a getter or a later change to the caller's object cannot show them two different routes. */
function copyRoute(route: unknown): EvmRoute {
  if (typeof route !== "object" || route === null) return refuse("bad_route", "a route is an object");
  const venue = (route as { venue?: unknown }).venue;
  if (venue === "uniswap-v3") {
    const { tokens, fees } = route as Record<string, unknown>;
    return Object.freeze({ venue, tokens: Object.freeze(copyList(tokens)), fees: Object.freeze(copyList(fees)) }) as EvmV3Route;
  }
  if (venue === "uniswap-v4") {
    const { currencyIn, hops } = route as Record<string, unknown>;
    const copied = copyList(hops).map((h) => {
      if (typeof h !== "object" || h === null) return refuse("bad_route", "a hop is an object");
      const { currency, fee, tickSpacing, hooks, hookData } = h as Record<string, unknown>;
      return Object.freeze({ currency, fee, tickSpacing, hooks, hookData });
    });
    return Object.freeze({ venue, currencyIn, hops: Object.freeze(copied) }) as EvmV4Route;
  }
  return refuse("bad_route", "no such venue");
}

/** The route's tokens in order (v3: its tokens; v4: currencyIn then each hop's currency), with the chain's checks:
 *  shape, WETH only first (INFO-1), every middle on the venue list (INFO-2). Returns the token bought. `route` is
 *  copyRoute's copy. */
function checkRoute(chain: EvmPoolChain, route: EvmRoute): string {
  const venue = venueOf(chain);
  let tokens: string[];
  if (route.venue === "uniswap-v3") {
    const { tokens: t, fees } = route;
    if (fees.length < 1 || fees.length > EVM_POOL_MAX_HOPS || t.length !== fees.length + 1) {
      return refuse("bad_route", `a v3 route is 1 to ${EVM_POOL_MAX_HOPS} hops, one more token than fees`);
    }
    for (const f of fees) if (!Number.isInteger(f) || f < 0 || f > U24) refuse("bad_route", "a v3 fee is a u24");
    tokens = [...t];
    if (!tokens.every(isAddress)) return refuse("bad_route", "a token is not an address");
    if (lower(tokens[0]!) !== lower(venue.weth)) return refuse("bad_route", "a v3 route starts at the chain's WETH");
  } else {
    const { currencyIn, hops } = route;
    if (hops.length < 1 || hops.length > EVM_POOL_MAX_HOPS) {
      return refuse("bad_route", `a v4 route is 1 to ${EVM_POOL_MAX_HOPS} hops`);
    }
    if (!isAddress(currencyIn) || (lower(currencyIn) !== NATIVE && lower(currencyIn) !== lower(venue.weth))) {
      return refuse("bad_route", "a v4 route starts from the native asset or the chain's WETH");
    }
    for (const h of hops) {
      if (!isAddress(h.currency) || !isAddress(h.hooks)) refuse("bad_route", "a hop's currency or hooks is not an address");
      if (!Number.isInteger(h.fee) || h.fee < 0 || h.fee > U24) refuse("bad_route", "a v4 fee is a u24");
      if (!Number.isInteger(h.tickSpacing) || h.tickSpacing < 1 || h.tickSpacing > MAX_TICK_SPACING) {
        refuse("bad_route", `a v4 tick spacing is 1 to ${MAX_TICK_SPACING}`);
      }
      if (hexBytes(h.hookData).length > EVM_POOL_MAX_HOOK_DATA) refuse("bad_route", `hook data is at most ${EVM_POOL_MAX_HOOK_DATA} bytes`);
    }
    tokens = [currencyIn, ...hops.map((h) => h.currency)];
  }
  const weth = lower(venue.weth);
  if (tokens.slice(1).some((t) => lower(t) === weth)) return refuse("weth_after_first", "WETH may only start a route");
  const listed = new Set(venue.middles.map(lower));
  for (const t of tokens.slice(1, -1)) if (!listed.has(lower(t))) refuse("middle_not_listed", `${t} is not on the venue list`);
  const out = tokens[tokens.length - 1]!;
  if (lower(out) === NATIVE || lower(out) === lower(tokens[tokens.length - 2]!)) return refuse("bad_route", "the route buys no token");
  return out;
}

/** The adapter's `data` for `route` on `chain`, after every check; and the token it buys. Checks and encodes one
 *  frozen copy of `route`. */
export function evmPoolRouteData(chain: EvmPoolChain, route: EvmRoute): { data: Uint8Array; token: string } {
  const r = copyRoute(route);
  const token = checkRoute(chain, r);
  if (r.venue === "uniswap-v3") {
    const parts = [addressBytes(r.tokens[0]!)];
    r.fees.forEach((f, i) => parts.push(Uint8Array.of(f >> 16, (f >> 8) & 0xff, f & 0xff), addressBytes(r.tokens[i + 1]!)));
    return { data: concat(...parts), token };
  }
  // abi.encode(address, (address,uint24,int24,address,bytes)[]): the head (currencyIn, offset 0x40), the array's
  // length, one offset per element (from the first offset's word), then each element: five head words (the bytes'
  // offset 0xa0) and its bytes, length then right-padded to 32
  const elems = r.hops.map((h) => {
    const d = hexBytes(h.hookData);
    const padded = new Uint8Array(Math.ceil(d.length / 32) * 32);
    padded.set(d);
    return concat(addressWord(h.currency), word(BigInt(h.fee)), word(BigInt(h.tickSpacing)), addressWord(h.hooks), word(0xa0n), word(BigInt(d.length)), padded);
  });
  const offsets: Uint8Array[] = [];
  let at = 32 * elems.length;
  for (const e of elems) offsets.push(word(BigInt(at))), (at += e.length);
  return { data: concat(addressWord(r.currencyIn), word(0x40n), word(BigInt(elems.length)), ...offsets, ...elems), token };
}

/** The pool's Buy: what PrivacyPoolSimple.buy takes beside the request and the proof, what W signs, and the chain it
 *  was checked for. Only evmPoolBuild makes one, frozen; evmPoolSignBuy signs no other. */
export type EvmPoolBuy = { readonly chain: EvmPoolChain; readonly adapter: string; readonly data: string; readonly minOut: bigint; readonly token: string };

// Every buy evmPoolBuild returned (merge note M366 (2)): a copy, a spread or a hand-made object is not in it
const BUILT = new WeakSet<EvmPoolBuy>();

/** The buy of `token`, the token the user picked, for `route` through `adapter` with at least `minOut` of it for W
 *  (minOut comes from the device's own reads; never 0, as the pool refuses it). A route that buys any other token is
 *  refused (token_mismatch): the pool checks only the named token's balance (M366 (1)). */
export function evmPoolBuild(chain: EvmPoolChain, adapter: string, route: EvmRoute, minOut: bigint, token: string): EvmPoolBuy {
  if (!isAddress(adapter) || lower(adapter) === NATIVE) return refuse("bad_route", "the adapter is not an address");
  if (!isAddress(token) || lower(token) === NATIVE) return refuse("bad_route", "the token is not an address");
  if (typeof minOut !== "bigint" || minOut <= 0n || minOut >= 1n << 256n) return refuse("bad_amount", "minOut is a uint256 above 0");
  const { data, token: buys } = evmPoolRouteData(chain, route);
  if (lower(buys) !== lower(token)) return refuse("token_mismatch", `the route buys ${buys}, not ${token}`);
  const built: EvmPoolBuy = Object.freeze({ chain, adapter, data: toHex(data), minOut, token });
  BUILT.add(built);
  return built;
}

// Made on use, never at load: the kit's index reaches the signing page's bundle, which keeps any top-level call
const DOMAIN_TYPEHASH = () => keccak_256(new TextEncoder().encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const BUY_TYPEHASH = () => keccak_256(
  new TextEncoder().encode("Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)"),
);
const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** The proof's public values W's signature binds: existingNullifierHash, context and withdrawnValue. */
export type EvmPoolProofBinding = { nullifier: bigint; context: bigint; value: bigint };

/** The EIP-712 digest of `buy` for `proof` on `pool`, with the chain id of the chain `buy` was built for, as
 *  PrivacyPoolSimple._buyDigest makes it. Module-private: only evmPoolSignBuy calls it, with a buy from BUILT. */
function buyDigest(pool: string, buy: EvmPoolBuy, proof: EvmPoolProofBinding): Uint8Array {
  const chainId = venueOf(buy.chain).chainId;
  if (!isAddress(pool) || lower(pool) === NATIVE) return refuse("bad_route", "the pool is not an address");
  if (typeof proof !== "object" || proof === null) return refuse("bad_amount", "the proof's values are an object");
  const p = { nullifier: proof.nullifier, context: proof.context, value: proof.value };
  for (const [n, v] of Object.entries(p)) {
    if (typeof v !== "bigint" || v < 0n || v >= FIELD_P) refuse("bad_amount", `${n} is a field element`);
  }
  if (p.value === 0n) return refuse("bad_amount", "value is above 0");
  const domain = keccak_256(concat(DOMAIN_TYPEHASH(), keccak_256(new TextEncoder().encode("Blindfill")), keccak_256(new TextEncoder().encode("1")), word(BigInt(chainId)), addressWord(pool)));
  const struct = keccak_256(
    concat(BUY_TYPEHASH(), addressWord(buy.adapter), keccak_256(hexBytes(buy.data)), word(buy.minOut), addressWord(buy.token), word(p.nullifier), word(p.context), word(p.value)),
  );
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), domain, struct));
}

/** W's signature of the pool's Buy for `built` and `proof` on `pool`: 65 bytes r ‖ s ‖ v, s low, v 27 or 28.
 *  `secretKey` is W's 32-byte key (the wallet's freshWallet for "evm"). `built` must be a buy evmPoolBuild returned for
 *  `chain` (not_built otherwise), and the digest is made here, so no input reaches W's key but a checked Buy. */
export function evmPoolSignBuy(secretKey: Uint8Array, chain: EvmPoolChain, pool: string, built: EvmPoolBuy, proof: EvmPoolProofBinding): Uint8Array {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32 || !secp256k1.utils.isValidSecretKey(secretKey)) {
    return refuse("bad_key", "W's key is a 32-byte secp256k1 key");
  }
  if (!BUILT.has(built) || built.chain !== chain) return refuse("not_built", "W signs only a buy evmPoolBuild returned for this chain");
  const digest = buyDigest(pool, built, proof);
  const rec = secp256k1.sign(digest, secretKey, { prehash: false, lowS: true, format: "recovered" });
  // noble's recovered form is the recovery bit, then r and s
  const out = new Uint8Array(65);
  out.set(rec.slice(1, 65), 0);
  out[64] = 27 + rec[0]!;
  return out;
}
