// A sell from W, the fresh EVM wallet a pool buy paid its token to, on Base or Robinhood Chain (contracts/pool-evm
// SellDelegate.sol; merge notes M363, M366; card evm-pool-sell-tx). W holds no ETH and sends nothing: the helper sends
// one type-4 transaction carrying W's EIP-7702 authorization of the delegate and SellDelegate.sell with W's signed Sell.
// The delegate itself checks only that the router took the whole approval and the ETH gained meets minOut, so a signed
// Sell could make any call (test/HostileSell.t.sol test_R_aSignedArbitraryCallIsStoppedOnlyByMinOut): the device's
// checks here are what keep it to the sell the user asked for (M363 (3)).
//
// The builder takes the sell's fields and a route, and checks, before anything is signed:
// - the target is on the chain's router list (evmPoolVenues().routers);
// - the swap data is made here from the route, never taken from a caller: SwapRouter02's
//   exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) with recipient W, amountIn
//   the amount, amountOutMinimum minOut, and a path from the token to the chain's WETH (a listed middle allowed, as in
//   the buy; WETH only at the end);
// - the deadline is unix seconds, at least EVM_POOL_SELL_DEADLINE_MIN_S and at most EVM_POOL_SELL_DEADLINE_MAX_S past
//   now;
// - the fee cap is above 0 and under minOut, so the deposit always holds something;
// and returns the sell frozen, held in a module-private set.
//
// W signs Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,
// uint256 feeCap,uint256 deadline,uint256 nonce) (SellDelegate.sol:65) under {name "Blindfill", version "1", chainId,
// verifyingContract: W}: 65 bytes r ‖ s ‖ v, s low, v 27 or 28. W's EIP-7702 authorization is keccak256(0x05 ‖
// rlp([chainId, delegate, nonce])) with the chain's own id from the venue list, never 0 (M363 (4)). No export here takes
// a digest. A stuck sell is replaced by building and signing again with the same nonce and a new deadline; a burned
// precommitment by signing again with a fresh one.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_POOL_MAX_HOPS, evmPoolVenues, type EvmPoolChain, type EvmV3Route } from "./buy.ts";

/** A sell's deadline, seconds past now: at least the helper's send margin (apps/helper pool/evm.ts
 *  EVM_POOL_SEND_MARGIN_MS, 60 s, card helper-pool-senders: a send needs time to be mined before the deadline), at
 *  most the device's cap on a pool request's life (packages/wallet withdraw/request.ts WITHDRAW_DEADLINE_MAX_MS, 600 s,
 *  which the helper's EVM sender takes as POOL_LIFE_MAX_MS). */
export const EVM_POOL_SELL_DEADLINE_MIN_S = 60;
export const EVM_POOL_SELL_DEADLINE_MAX_S = 600;

export type EvmPoolSellErrorCode =
  | "bad_target" // the target is not on the chain's router list
  | "token_mismatch" // the route does not start at the token sold
  | "middle_not_listed" // a middle token that is not on the venue list
  | "bad_route" // the route's shape, or it does not end at the chain's WETH; or the chain, W or the pool
  | "bad_amount" // amount, minOut, precommitment or nonce out of range
  | "bad_fee" // the fee cap is 0, or not under minOut
  | "bad_deadline" // the deadline is not seconds within the window past now
  | "not_built" // W signs only a sell evmPoolBuildSell returned, for the chain it was built for
  | "bad_key"; // W's key is not a key, or not W's
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

/** What W asks: sell `amount` of `token` through `target` along `route` for at least `minOut` wei, into `pool` with
 *  `precommitment`, the sender's fee at most `feeCap`, by `deadline` (unix seconds), with W's sell nonce `nonce`.
 *  `now` is unix seconds (the device's clock when left out). */
export type EvmPoolSellRequest = {
  w: string;
  token: string;
  amount: bigint;
  target: string;
  route: EvmV3Route;
  minOut: bigint;
  pool: string;
  precommitment: bigint;
  feeCap: bigint;
  deadline: bigint;
  nonce: bigint;
  now?: number;
};

/** The Sell W signs (SellDelegate.Sell, data made here), with W and the chain it was checked for. Only
 *  evmPoolBuildSell makes one, frozen; evmPoolSignSell signs no other. */
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

// Every sell evmPoolBuildSell returned: a copy, a spread or a hand-made object is not in it
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

/** SwapRouter02's exactInput call for a checked path (one frozen copy, each field read once). */
function swapData(chain: EvmPoolChain, token: string, route: unknown, w: string, amount: bigint, minOut: bigint): string {
  const venue = venueOf(chain);
  if (typeof route !== "object" || route === null) return refuse("bad_route", "a route is an object");
  const { venue: kind, tokens: t, fees: f } = route as Record<string, unknown>;
  if (kind !== "uniswap-v3") return refuse("bad_route", "a sell runs on Uniswap v3's SwapRouter02");
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

/** The sell W asked for on `chain`, after every check (see the header); refused with its own code otherwise. */
export function evmPoolBuildSell(chain: EvmPoolChain, req: EvmPoolSellRequest): EvmPoolSell {
  if (typeof req !== "object" || req === null) return refuse("bad_route", "a sell request is an object");
  const { w, token, amount, target, route, minOut, pool, precommitment, feeCap, deadline, nonce, now } = req;
  const venue = venueOf(chain);
  if (!isWallet(w)) return refuse("bad_route", "W is not an address");
  if (!isWallet(token) || lower(token) === lower(venue.weth)) return refuse("bad_route", "the token is not an address, or is WETH");
  if (!isWallet(pool)) return refuse("bad_route", "the pool is not an address");
  if (!isAddress(target) || !venue.routers.some((r) => lower(r) === lower(target))) return refuse("bad_target", `${target} is not on the router list`);
  if (!isUint(amount, U256) || amount === 0n) return refuse("bad_amount", "amount is a uint256 above 0");
  if (!isUint(minOut, U256) || minOut === 0n) return refuse("bad_amount", "minOut is a uint256 above 0");
  if (!isUint(precommitment, FIELD_P)) return refuse("bad_amount", "the precommitment is a field element");
  if (!isUint(nonce, U256)) return refuse("bad_amount", "the nonce is a uint256");
  if (!isUint(feeCap, U256) || feeCap === 0n || feeCap >= minOut) return refuse("bad_fee", "the fee cap is above 0 and under minOut");
  const t = now === undefined ? Math.floor(Date.now() / 1000) : now;
  if (!Number.isSafeInteger(t) || t < 0) return refuse("bad_deadline", "now is unix seconds");
  if (typeof deadline !== "bigint" || deadline < BigInt(t + EVM_POOL_SELL_DEADLINE_MIN_S) || deadline > BigInt(t + EVM_POOL_SELL_DEADLINE_MAX_S)) {
    return refuse("bad_deadline", `the deadline is ${EVM_POOL_SELL_DEADLINE_MIN_S} to ${EVM_POOL_SELL_DEADLINE_MAX_S} seconds past now (${t})`);
  }
  const data = swapData(chain, token, route, w, amount, minOut);
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
 *  evmPoolBuildSell returned for `chain` (not_built), and `secretKey` must be W's (bad_key). */
export function evmPoolSignSell(secretKey: Uint8Array, chain: EvmPoolChain, built: EvmPoolSell): Uint8Array {
  checkKey(secretKey);
  if (!BUILT.has(built) || built.chain !== chain) return refuse("not_built", "W signs only a sell evmPoolBuildSell returned for this chain");
  if (addressOf(secretKey) !== lower(built.w)) return refuse("bad_key", "the key is not W's");
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
  const rec = secp256k1.sign(keccak_256(concat(Uint8Array.of(0x19, 0x01), domain, struct)), secretKey, { prehash: false, lowS: true, format: "recovered" });
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
export function evmPoolSignSellAuthorization(secretKey: Uint8Array, chain: EvmPoolChain, delegate: string, nonce: bigint): EvmPoolSellAuthorization {
  checkKey(secretKey);
  const chainId = venueOf(chain).chainId;
  if (!isWallet(delegate)) return refuse("bad_route", "the delegate is not an address");
  if (!isUint(nonce, U64 - 1n)) return refuse("bad_amount", "the nonce is under 2^64 - 1 (EIP-7702)");
  const items = concat(rlpUint(BigInt(chainId)), Uint8Array.of(0x94, ...addressBytes(delegate)), rlpUint(nonce));
  const digest = keccak_256(concat(Uint8Array.of(0x05, 0xc0 + items.length), items));
  const rec = secp256k1.sign(digest, secretKey, { prehash: false, lowS: true, format: "recovered" });
  return Object.freeze({ chainId, address: delegate, nonce, yParity: rec[0] as 0 | 1, r: toHex(rec.slice(1, 33)), s: toHex(rec.slice(33, 65)) });
}
