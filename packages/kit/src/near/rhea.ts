// A quote on Rhea classic (Ref Finance's v2 exchange), made on the device from the pools' own views. No vendor quote and
// no third party's router: the device reads the pools itself, on two NEAR providers of different operators, at one
// pinned block, and runs the contract's own math on what both gave.
//
// The contract (ref-exchange 1.9.18, read at the public mirror github.com/DevOfCredit/ref-contracts @b444323f, as the
// NEAR trading terminal's router research cites it; Ref's own repo now answers 404):
// - a simple pool pays out floor(a·(10⁴ − f)·R_out / (10⁴·R_in + a·(10⁴ − f))) in U256, refusing (E76) a zero
//   reserve or a zero amount in (simple_pool.rs:246-264); the whole fee stays in the reserves, and the admin and referral
//   shares are minted as LP shares, so they never change the output (simple_pool.rs:357-380);
// - `get_return(pool_id, token_in, amount_in, token_out)` is that same swap run as a view (views.rs:572-582), and
//   `get_pool_by_ids` answers each pool's kind, tokens, reserves and fee, failing (E85) on an id with no pool
//   (views.rs:403-412, PoolInfo views.rs:84-98);
// - a swap needs the contract Running (E51, lib.rs:648-653) and no frozen token on its actions (E52, lib.rs:655-661,
//   727); actions run in order, an action with no amount_in spending the one before it's output (lib.rs:716-812).
// Only simple pools are quoted here: their math is exact. The stable, rated and degen kinds are left out of every route.
//
// The two providers: each one's final height is read first, and every view after it names the lower of the two by
// block_id. Both answers must carry that height and one block hash, and their bytes must be equal, else the quote is
// refused: one provider lagging, lying or failing never makes a number. The same rule as the vault's pages
// (vault/sync.ts).
import { NEAR_NETWORKS, nearPairNetwork, nearPairRule, type NearNetwork, type NearRpc } from "./networks.ts";
import { nearFeeBuyerReceives, nearFeeVenueReceives, nearPlainTokenFee, nearTokenFee, nearTokenFeeView, NEAR_TOKEN_FEE_VIEW_MAX_BYTES, type NearTokenFee } from "./token-fee.ts";
import { deepFreeze } from "../freeze.ts";

/** Rhea classic's exchange and the wrapped NEAR token on each network (the UNRLZD trading terminal's facts/networks). */
export const NEAR_RHEA = deepFreeze({
  mainnet: { exchange: "v2.ref-finance.near", wrap: "wrap.near" },
  testnet: { exchange: "ref-finance-101.testnet", wrap: "wrap.testnet" },
} as const);

/** Rhea's fee divisor: a pool's total_fee is in parts of 10,000 (FEE_DIVISOR). */
export const RHEA_FEE_DIVISOR = 10_000n;
/** The most candidate pools one quote reads (one get_pool_by_ids view). */
export const RHEA_QUOTE_POOLS_MAX = 32;
/**
 * The most the two providers' final heights may differ, in blocks (about 2 s). Two honest providers differ by a block
 * or two; the quote is read at the lower one, so a provider could otherwise pick a staler state, and a looser floor,
 * anywhere within this bound.
 */
export const RHEA_QUOTE_LAG_MAX = 3;
/** The longest view answer read, in bytes (32 pools are about 10 KB). */
export const RHEA_VIEW_MAX_BYTES = 65_536;

const U128_MAX = (1n << 128n) - 1n;

export type RheaRefusalCode = "input" | "rpc" | "disagree" | "lag" | "paused" | "frozen" | "no-pool" | "pool" | "liquidity";
export class RheaQuoteRefused extends Error {
  readonly code: RheaRefusalCode;
  constructor(code: RheaRefusalCode, detail: string) {
    super(`Rhea quote refused (${code}): ${detail}`);
    this.name = "RheaQuoteRefused";
    this.code = code;
  }
}

/** A simple pool as get_pool_by_ids writes it. */
export type RheaPool = { id: number; tokens: readonly [string, string]; amounts: readonly [bigint, bigint]; feeBps: number };

/**
 * What a simple pool pays for `amountIn` of `tokenIn`: the contract's internal_get_return, or null where the contract
 * refuses the swap (not a token of the pool, the same token, a zero reserve or amount, or a reserve past u128 after it).
 */
export function rheaSimpleOut(pool: RheaPool, tokenIn: string, amountIn: bigint, tokenOut: string): bigint | null {
  const i = pool.tokens.indexOf(tokenIn);
  const j = pool.tokens.indexOf(tokenOut);
  if (i < 0 || j < 0 || i === j || amountIn <= 0n) return null;
  const rin = pool.amounts[i] as bigint;
  const rout = pool.amounts[j] as bigint;
  if (rin <= 0n || rout <= 0n || rin + amountIn > U128_MAX) return null;
  const withFee = amountIn * (RHEA_FEE_DIVISOR - BigInt(pool.feeBps));
  return (withFee * rout) / (RHEA_FEE_DIVISOR * rin + withFee);
}

/** One swap of a route: the pool, its tokens and amounts. */
export type RheaHop = { pool: number; tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint; feeBps: number };

export type RheaQuoteArgs = {
  network: NearNetwork;
  /** Two providers of different operators: the network's pair (nearPairNetwork). */
  rpcs: readonly [NearRpc, NearRpc];
  /** buy: USDC into the token; sell: the token into USDC. */
  side: "buy" | "sell";
  token: string;
  /** USDC units on a buy, the token's units on a sell: what leaves the wallet. */
  amountIn: bigint;
  /** Candidate pool ids, from any list: each is read here and used only as the chain shows it. */
  pools: readonly number[];
  /** The two providers' final height already read (nearFinal, on these providers): the quote reads at it and asks no
   *  height of its own, so a read of W at the same final is of the same block (../trade/near/wallet.ts readNearSwapPair). */
  final?: NearFinal;
  signal?: AbortSignal;
};

export type RheaQuote = {
  network: NearNetwork;
  exchange: string;
  height: number;
  blockHash: string;
  side: "buy" | "sell";
  token: string;
  tokenIn: string;
  tokenOut: string;
  /** what leaves the wallet */
  amountIn: bigint;
  /** what the exchange receives: amountIn less a receiver-pays sell fee */
  venueIn: bigint;
  /** one hop, or two through wrapped NEAR */
  hops: readonly RheaHop[];
  /** what the last hop pays: the amount the exchange checks its minimum out against */
  venueOut: bigint;
  /** what arrives in the wallet: venueOut less a buy fee */
  amountOut: bigint;
  /** the token's own transfer fee as read at this block */
  fee: NearTokenFee;
};

const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccount = (x: unknown): x is string => typeof x === "string" && ACCOUNT.test(x);
const U128_TEXT = /^(0|[1-9]\d{0,38})$/;
const isU128 = (x: unknown): x is string => typeof x === "string" && U128_TEXT.test(x) && BigInt(x) <= U128_MAX;
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** Quotes `amountIn` on Rhea classic from both providers' views at one block, or throws RheaQuoteRefused. */
export async function rheaQuote(args: RheaQuoteArgs): Promise<RheaQuote> {
  const { network, rpcs, side, token, amountIn, signal } = args;
  if (!(network in NEAR_RHEA)) throw new RheaQuoteRefused("input", `unknown network ${String(network)}`);
  if (nearPairNetwork(rpcs) !== network) throw new RheaQuoteRefused("input", nearPairRule(network));
  const { exchange, wrap } = NEAR_RHEA[network];
  const usdc = NEAR_NETWORKS[network].usdc;
  if (side !== "buy" && side !== "sell") throw new RheaQuoteRefused("input", "side is buy or sell");
  if (!isAccount(token) || token === usdc) throw new RheaQuoteRefused("input", "the token is a NEAR account id other than USDC");
  if (typeof amountIn !== "bigint" || amountIn <= 0n || amountIn > U128_MAX) throw new RheaQuoteRefused("input", "the amount is a u128 above 0");
  const ids = args.pools;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > RHEA_QUOTE_POOLS_MAX || new Set(ids).size !== ids.length || !ids.every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new RheaQuoteRefused("input", `pools: 1 to ${RHEA_QUOTE_POOLS_MAX} distinct pool ids`);

  // The two final heights; every read after this one names the lower.
  const { height } = await finalOf(network, rpcs, args.final, signal);
  let blockHash = "";
  const same = (what: string, x: Answer, y: Answer): void => {
    if (x.height !== height || y.height !== height) throw new RheaQuoteRefused("rpc", `${what}: an answer not at block ${height}`);
    if (x.hash !== y.hash || (blockHash !== "" && x.hash !== blockHash)) throw new RheaQuoteRefused("disagree", `${what}: two blocks at height ${height}`);
    blockHash = x.hash;
  };
  const both = async (what: string, params: Obj): Promise<Answer> => {
    const [x, y] = (await Promise.all(rpcs.map((r) => answer(r, params, signal)))) as [Answer, Answer];
    same(what, x, y);
    if (x.failed !== y.failed || !equalBytes(x.bytes, y.bytes)) throw new RheaQuoteRefused("disagree", `${what}: the providers' answers differ`);
    return x;
  };
  const at = { block_id: height };

  // the token fee table names mainnet launchpads only
  const feeView = network === "mainnet" ? nearTokenFeeView(token) : null;
  const [meta, frozen, pools, account, feeAnswer] = await Promise.all([
    both("metadata", view(exchange, "metadata", {}, at)),
    both("get_frozenlist_tokens", view(exchange, "get_frozenlist_tokens", {}, at)),
    both("get_pool_by_ids", view(exchange, "get_pool_by_ids", { pool_ids: ids }, at)),
    accountCode(rpcs, token, height, signal, same),
    feeView ? both(`${token} ${feeView.method}`, view(token, feeView.method, {}, at)) : Promise.resolve(null),
  ]);

  const state = isObj(json(meta, "metadata")) ? (json(meta, "metadata") as Obj).state : undefined;
  if (state !== "Running") throw new RheaQuoteRefused("paused", `${exchange} is not Running (state ${JSON.stringify(state)})`);
  const frozenList = json(frozen, "get_frozenlist_tokens");
  if (!Array.isArray(frozenList) || !frozenList.every(isAccount)) throw new RheaQuoteRefused("rpc", "get_frozenlist_tokens: not a list of accounts");
  if (pools.failed) throw new RheaQuoteRefused("no-pool", `get_pool_by_ids(${JSON.stringify(ids)}) failed on chain: ${pools.error}`);
  const rows = json(pools, "get_pool_by_ids");
  if (!Array.isArray(rows) || rows.length !== ids.length) throw new RheaQuoteRefused("rpc", "get_pool_by_ids: not one row per pool id");
  const simple: RheaPool[] = [];
  rows.forEach((row, k) => {
    const p = poolRow(row, ids[k] as number);
    if (p) simple.push(p);
  });

  // a token under no listed launchpad: 0% only for a pinned plain code, else marked unknown
  let fee: NearTokenFee = nearPlainTokenFee(account);
  if (feeView && feeAnswer) {
    let v: { value: unknown } | { failed: true };
    if (feeAnswer.failed) v = { failed: true };
    else if (feeAnswer.bytes.length > NEAR_TOKEN_FEE_VIEW_MAX_BYTES) v = { value: undefined };
    else {
      try {
        v = { value: JSON.parse(utf8(feeAnswer.bytes)) };
      } catch {
        v = { value: undefined };
      }
    }
    fee = nearTokenFee(feeView.pad, account, v);
  }

  const [tokenIn, tokenOut] = side === "buy" ? [usdc, token] : [token, usdc];
  for (const t of new Set([tokenIn, tokenOut])) if (frozenList.includes(t)) throw new RheaQuoteRefused("frozen", `${t} is frozen on ${exchange}`);
  const venueIn = side === "sell" ? nearFeeVenueReceives(fee, exchange, amountIn) : amountIn;
  if (venueIn <= 0n) throw new RheaQuoteRefused("input", "the token's fee leaves nothing to swap");

  // Every route the candidate pools make: one pool holding both tokens, or two through wrapped NEAR.
  const has = (p: RheaPool, a: string, b: string) => p.tokens.includes(a) && p.tokens.includes(b) && a !== b;
  const routes: RheaPool[][] = [];
  for (const p of simple) if (has(p, tokenIn, tokenOut)) routes.push([p]);
  if (token !== wrap && !frozenList.includes(wrap))
    for (const p of simple) if (has(p, tokenIn, wrap)) for (const q of simple) if (q !== p && has(q, wrap, tokenOut)) routes.push([p, q]);
  if (routes.length === 0) throw new RheaQuoteRefused("no-pool", `no simple pool among ${JSON.stringify(ids)} joins ${tokenIn} to ${tokenOut}, directly or through ${wrap}`);

  let best: RheaHop[] | null = null;
  for (const route of routes) {
    const hops: RheaHop[] = [];
    let x = venueIn;
    let t = tokenIn;
    for (const p of route) {
      const next = route.length === 1 || t !== tokenIn ? tokenOut : wrap;
      const out = rheaSimpleOut(p, t, x, next);
      if (out === null || out <= 0n) break;
      hops.push({ pool: p.id, tokenIn: t, tokenOut: next, amountIn: x, amountOut: out, feeBps: p.feeBps });
      x = out;
      t = next;
    }
    if (hops.length === route.length && (best === null || x > (best.at(-1) as RheaHop).amountOut)) best = hops;
  }
  if (best === null) throw new RheaQuoteRefused("liquidity", `no route among ${JSON.stringify(ids)} pays anything for ${venueIn} ${tokenIn}`);
  const venueOut = (best.at(-1) as RheaHop).amountOut;
  const amountOut = side === "buy" ? nearFeeBuyerReceives(fee, exchange, venueOut) : venueOut;
  return deepFreeze({ network, exchange, height, blockHash, side, token, tokenIn, tokenOut, amountIn, venueIn, hops: best, venueOut, amountOut, fee });
}

/** A get_pool_by_ids row as a simple pool, or null for any other kind (left out of every route); a malformed row refuses. */
function poolRow(row: unknown, id: number): RheaPool | null {
  if (!isObj(row) || typeof row.pool_kind !== "string") throw new RheaQuoteRefused("pool", `pool ${id}: not a pool row`);
  if (row.pool_kind !== "SIMPLE_POOL") return null;
  const t = row.token_account_ids;
  const a = row.amounts;
  const f = row.total_fee;
  if (!Array.isArray(t) || t.length !== 2 || !t.every(isAccount) || t[0] === t[1]) throw new RheaQuoteRefused("pool", `pool ${id}: not two tokens`);
  if (!Array.isArray(a) || a.length !== 2 || !a.every(isU128)) throw new RheaQuoteRefused("pool", `pool ${id}: not two u128 reserves`);
  if (typeof f !== "number" || !Number.isSafeInteger(f) || f < 0 || f >= 10_000) throw new RheaQuoteRefused("pool", `pool ${id}: a fee outside 0 to 9999`);
  const [t0, t1] = t as [string, string];
  const [a0, a1] = a as [string, string];
  return { id, tokens: [t0, t1], amounts: [BigInt(a0), BigInt(a1)], feeBps: f };
}

// ---------- the two final heights ----------
/** The two providers' final heights of one moment, at most RHEA_QUOTE_LAG_MAX apart, and the lower of them: the block
 *  every read after it names. Made only by nearFinal, which keeps the pair it read it on, so no caller hands a height
 *  of its own to a quote or a read of W. */
export type NearFinal = { readonly network: NearNetwork; readonly height: number };
const FINALS = new WeakMap<object, readonly [NearRpc, NearRpc]>();

/**
 * Each provider's final height, both asked at one moment: a paced provider's turn (NearRpc.reserve) is taken on both
 * first, then both heights are asked at once, so a wait for one provider's turn is never read as that
 * provider being ahead of the other (card near-quote-under-the-pace: FastNEAR's turn 2.5 s off made it 4 to 5 blocks "ahead" and
 * refused half the quotes). Over RHEA_QUOTE_LAG_MAX apart, the lower one's final is asked once more at once and the two
 * compared again: an answer that came late (a provider's busy retry, or the page's FastNEAR seat falling to its spare
 * seconds after the other answered) reads ahead by the time it took, never behind, and the re-ask closes that gap; a
 * provider truly behind the chain is behind again, and the pair is refused "lag" (review P2-1 of e6c66cce3).
 */
export async function nearFinal(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], signal?: AbortSignal): Promise<NearFinal> {
  if (!(network in NEAR_RHEA)) throw new RheaQuoteRefused("input", `unknown network ${String(network)}`);
  if (nearPairNetwork(rpcs) !== network) throw new RheaQuoteRefused("input", nearPairRule(network));
  signal?.throwIfAborted();
  const go = await Promise.all(rpcs.map((r) => (typeof r.reserve === "function" ? r.reserve(signal) : r)));
  const ask = (r: NearRpc) => answer(r, view(NEAR_RHEA[network].exchange, "metadata", {}, { finality: "final" }), signal);
  let [fa, fb] = (await Promise.all(go.map(ask))) as [Answer, Answer];
  if (Math.abs(fa.height - fb.height) > RHEA_QUOTE_LAG_MAX) {
    if (fa.height < fb.height) fa = await ask(go[0]!);
    else fb = await ask(go[1]!);
  }
  if (Math.abs(fa.height - fb.height) > RHEA_QUOTE_LAG_MAX) throw new RheaQuoteRefused("lag", `the providers' final heights ${fa.height} and ${fb.height} are over ${RHEA_QUOTE_LAG_MAX} blocks apart`);
  const f: NearFinal = Object.freeze({ network, height: Math.min(fa.height, fb.height) });
  FINALS.set(f, [rpcs[0], rpcs[1]]);
  return f;
}

/** `final` when nearFinal read it on these two providers for this network, else a new one read now. */
export async function finalOf(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], final: NearFinal | undefined, signal?: AbortSignal): Promise<NearFinal> {
  if (final === undefined) return nearFinal(network, rpcs, signal);
  const on = typeof final === "object" && final !== null ? FINALS.get(final) : undefined;
  if (on === undefined || on[0] !== rpcs[0] || on[1] !== rpcs[1] || final.network !== network) throw new RheaQuoteRefused("input", "the final height is not one nearFinal read on these providers");
  return final;
}

// ---------- reads ----------
/** One provider's answer to a view at the block it names (shared with ../trade/near/wallet.ts). */
export type Answer = { height: number; hash: string; bytes: Uint8Array; failed: boolean; error: string };

export function view(contract: string, method: string, a: unknown, at: { finality: "final" } | { block_id: number }): Obj {
  return { request_type: "call_function", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(a)), ...at };
}

const utf8 = (b: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    throw new RheaQuoteRefused("rpc", "a view answer that is not UTF-8");
  }
};

export function json(a: Answer, what: string): unknown {
  if (a.failed) throw new RheaQuoteRefused("rpc", `${what} failed on chain: ${a.error}`);
  try {
    return JSON.parse(utf8(a.bytes));
  } catch (e) {
    if (e instanceof RheaQuoteRefused) throw e;
    throw new RheaQuoteRefused("rpc", `${what}: not JSON`);
  }
}

export const equalBytes = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((b, i) => b === y[i]);

/**
 * One provider's answer to a view: its bytes, or `failed` with the chain's error when the view ran and failed (no such
 * method, a panic, no such account), both at the block it names. A provider that does not answer, or answers anything
 * else, refuses the quote ("rpc").
 */
export async function answer(rpc: NearRpc, params: Obj, signal?: AbortSignal): Promise<Answer> {
  let a: unknown;
  try {
    a = await rpc.query(params, signal);
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    throw new RheaQuoteRefused("rpc", `${rpc.name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const what = `${rpc.name}: ${String(params.method_name)}`;
  if (isObj(a) && isObj(a.error)) throw new RheaQuoteRefused("rpc", `${what}: ${String(a.error.message ?? a.error.name).slice(0, 200)}`);
  const r = isObj(a) && a.error === undefined ? a.result : undefined;
  if (!isObj(r) || !Number.isSafeInteger(r.block_height) || (r.block_height as number) <= 0 || typeof r.block_hash !== "string")
    throw new RheaQuoteRefused("rpc", `${what}: not a view result`);
  if (typeof r.error === "string") return { height: r.block_height as number, hash: r.block_hash, bytes: new Uint8Array(), failed: true, error: r.error.slice(0, 300) };
  const bytes = r.result;
  if (!Array.isArray(bytes) || bytes.length > RHEA_VIEW_MAX_BYTES || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
    throw new RheaQuoteRefused("rpc", `${what}: not a view result`);
  return { height: r.block_height as number, hash: r.block_hash, bytes: Uint8Array.from(bytes as number[]), failed: false, error: "" };
}

/** The token's code hash at the block on both providers (its global contract's hash when it runs one). */
async function accountCode(rpcs: readonly [NearRpc, NearRpc], token: string, height: number, signal: AbortSignal | undefined, same: (what: string, x: Answer, y: Answer) => void): Promise<string> {
  const read = async (rpc: NearRpc): Promise<{ at: Answer; code: string }> => {
    let a: unknown;
    try {
      a = await rpc.query({ request_type: "view_account", account_id: token, block_id: height }, signal);
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      throw new RheaQuoteRefused("rpc", `${rpc.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const r = isObj(a) && a.error === undefined ? a.result : undefined;
    if (!isObj(r) || !Number.isSafeInteger(r.block_height) || typeof r.block_hash !== "string") throw new RheaQuoteRefused("rpc", `${rpc.name}: view_account ${token}: not an account`);
    const g = r.global_contract_hash;
    const code = typeof g === "string" && g !== "" ? g : r.code_hash;
    if (typeof code !== "string" || code === "") throw new RheaQuoteRefused("rpc", `${rpc.name}: view_account ${token}: no code hash`);
    return { at: { height: r.block_height as number, hash: r.block_hash, bytes: new Uint8Array(), failed: false, error: "" }, code };
  };
  const [x, y] = (await Promise.all(rpcs.map(read))) as [{ at: Answer; code: string }, { at: Answer; code: string }];
  same(`view_account ${token}`, x.at, y.at);
  if (x.code !== y.code) throw new RheaQuoteRefused("disagree", `view_account ${token}: the providers' code hashes differ`);
  return x.code;
}
