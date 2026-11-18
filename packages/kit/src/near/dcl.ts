// A quote on Rhea DCL (dclv2.ref-labs.near, Ref's concentrated-liquidity exchange), made on the device from DCL's own
// quote view on two NEAR providers of different operators at one pinned block, and the Swap a fresh wallet W signs for
// it (card near-dcl-route). The same two-provider rule as Rhea classic (rhea.ts): one provider lagging, lying or failing
// never makes a number.
//
// DCL's code is not published (proofs/p4-speed/near/RESULT.md §9 in the research repo), so its interface here is read
// from the chain, mainnet, 2026-11-16:
// - get_metadata() → {version: "2.4.2", state: "Running", wnear_id: "wrap.near", ...} (block 224792186);
// - get_pool({pool_id}) → {pool_id, token_x, token_y, fee, state, whitelist, tax, ...}, or null for an id with no pool
//   (block 224792723, on FastNEAR and dRPC); quote on such an id panics "E403: pool not exist" (block 224792252). Each of the 6,665 pools list_pools answered has token_x < token_y, so an
//   id is "<lower>|<higher>|<fee>", the fee in millionths (10000 = 1%). One pool had a whitelist (solvers only) and two
//   a tax: neither is quoted here, since W could not swap on the first and the second's tax is not read;
// - quote({pool_ids, input_token, output_token, input_amount, tag: null}) → {amount, tag}: what one pool, or a path of
//   pools, pays; "0" for a token that is not in the pools (block 224792253);
// - get_frozenlist_tokens() → [] (block 224792253);
// - the swap is the input token's ft_transfer_call({receiver_id: "dclv2.ref-labs.near", amount, msg}) with msg
//   {"Swap":{"pool_ids":[...],"output_token":T,"min_output_amount":M,"skip_unwrap_near":true}}: mainnet tx
//   BU6Jy6p55mi22kT64noFGN2xfm269JzhfwXz92wJcpNw (its args read equal on FastNEAR and dRPC) swapped wNEAR for
//   hoodl-95275b.launchpad.justhoot.near on pool "hoodl-95275b.launchpad.justhoot.near|wrap.near|10000" with that msg
//   plus a referral_id (left out here), paying the sender, 24.8 Tgas burnt in all;
// - a payout that fails to a sender with no DCL registration is locked, DCL's owner only (RESULT.md §10, the mainnet code
//   in a sandbox), so the swap is built only once W reads registered on the output token, as on Rhea classic.
// The token's own transfer fee is counted as on classic (token-fee.ts): a hoot or rheameme token names DCL as the venue
// its fee applies to (its dcl_exchange_id).
import { NEAR_NETWORKS, nearPairNetwork, nearPairRule, type NearNetwork, type NearRpc } from "./networks.ts";
import { nearFeeBuyerReceives, nearFeeVenueReceives, nearPlainTokenFee, nearTokenFee, nearTokenFeeView, NEAR_TOKEN_FEE_VIEW_MAX_BYTES, type NearTokenFee } from "./token-fee.ts";
import { accountCode, answer, equalBytes, finalOf, json, RheaQuoteRefused, view, type Answer, type NearFinal } from "./rhea.ts";
import { NEAR_SWAP_GAS, NEAR_SWAP_STORAGE_MAX, nearSwapFloor, NearSwapRefused, type NearSwapCall, type NearSwapRequest } from "../trade/near/swap.ts";
import { deepFreeze } from "../freeze.ts";

/** Rhea DCL's exchange and the wrapped NEAR token its paths go through (mainnet only: DCL has no testnet here). */
export const NEAR_DCL = deepFreeze({ mainnet: { exchange: "dclv2.ref-labs.near", wrap: "wrap.near" } } as const);
/** The most candidate pools one DCL quote reads: a token's four fee tiers with wNEAR or USDC and USDC's four with wNEAR
 *  make at most 16 routes, each one quote view on each provider. */
export const DCL_QUOTE_POOLS_MAX = 8;

const U128_MAX = (1n << 128n) - 1n;
const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccount = (x: unknown): x is string => typeof x === "string" && ACCOUNT.test(x);
const U128_TEXT = /^(0|[1-9]\d{0,38})$/;
const u128 = (x: unknown): bigint | null => (typeof x === "string" && U128_TEXT.test(x) && BigInt(x) <= U128_MAX ? BigInt(x) : null);
const IMPLICIT = /^[0-9a-f]{64}$/;
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const sameKeys = (o: Obj, keys: readonly string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};

/** A DCL pool id read apart: its two tokens, lower first, and its fee in millionths; null when not that form. */
export function dclPoolOf(id: unknown): { x: string; y: string; fee: number } | null {
  if (typeof id !== "string" || id.length > 150) return null;
  const parts = id.split("|");
  if (parts.length !== 3) return null;
  const [x, y, f] = parts as [string, string, string];
  if (!isAccount(x) || !isAccount(y) || !(x < y) || !/^[1-9]\d{0,5}$/.test(f) || Number(f) >= 1_000_000) return null;
  return { x, y, fee: Number(f) };
}

export type DclQuoteArgs = {
  network: NearNetwork;
  /** Two providers of different operators: the network's pair (nearPairNetwork). */
  rpcs: readonly [NearRpc, NearRpc];
  /** buy: USDC into the token; sell: the token into USDC. */
  side: "buy" | "sell";
  token: string;
  /** USDC units on a buy, the token's units on a sell: what leaves the wallet. */
  amountIn: bigint;
  /** Candidate DCL pool ids, from any list: each is read here and used only as the chain shows it. */
  pools: readonly string[];
  /** The two providers' final height already read (rhea.ts nearFinal, on these providers). */
  final?: NearFinal;
  signal?: AbortSignal;
};

export type DclQuote = {
  venue: "dcl";
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
  /** the path: one pool, or two through wrapped NEAR, in swap order */
  poolIds: readonly string[];
  /** what DCL's quote view pays for venueIn on the path: the amount the Swap's minimum is taken from */
  venueOut: bigint;
  /** what arrives in the wallet: venueOut less a buy fee */
  amountOut: bigint;
  /** the token's own transfer fee as read at this block */
  fee: NearTokenFee;
};

/** Quotes `amountIn` on Rhea DCL from both providers' views at one block, or throws RheaQuoteRefused. */
export async function dclQuote(args: DclQuoteArgs): Promise<DclQuote> {
  const { network, rpcs, side, token, amountIn, signal } = args;
  if (!(network in NEAR_DCL)) throw new RheaQuoteRefused("input", `no DCL on ${String(network)}`);
  if (nearPairNetwork(rpcs) !== network) throw new RheaQuoteRefused("input", nearPairRule(network));
  const { exchange, wrap } = NEAR_DCL[network as "mainnet"];
  const usdc = NEAR_NETWORKS[network].usdc;
  if (side !== "buy" && side !== "sell") throw new RheaQuoteRefused("input", "side is buy or sell");
  if (!isAccount(token) || token === usdc) throw new RheaQuoteRefused("input", "the token is a NEAR account id other than USDC");
  if (typeof amountIn !== "bigint" || amountIn <= 0n || amountIn > U128_MAX) throw new RheaQuoteRefused("input", "the amount is a u128 above 0");
  const ids = args.pools;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > DCL_QUOTE_POOLS_MAX || new Set(ids).size !== ids.length || !ids.every((p) => dclPoolOf(p) !== null))
    throw new RheaQuoteRefused("input", `pools: 1 to ${DCL_QUOTE_POOLS_MAX} distinct DCL pool ids`);

  const final = await finalOf(network, rpcs, args.final, signal);
  const { height } = final;
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
  const [tokenIn, tokenOut] = side === "buy" ? [usdc, token] : [token, usdc];

  // every path pools make: one pool of both tokens, or two through wrapped NEAR
  type P = { id: string; tokens: readonly [string, string] };
  const has = (p: P, a: string, b: string) => p.tokens.includes(a) && p.tokens.includes(b) && a !== b;
  const pathsOf = (ps: readonly P[], viaWrap: boolean): string[][] => {
    const out: string[][] = [];
    for (const p of ps) if (has(p, tokenIn, tokenOut)) out.push([p.id]);
    if (viaWrap) for (const p of ps) if (has(p, tokenIn, wrap)) for (const q of ps) if (q !== p && has(q, wrap, tokenOut)) out.push([p.id, q.id]);
    return out;
  };
  /** DCL's quote view of `amount` on one path, `from` into `to` (the trade's own two tokens unless named), both providers
   *  at the block: its amount, 0 where the view fails on chain. */
  const quoteOf = async (path: readonly string[], amount: bigint, from = tokenIn, to = tokenOut): Promise<bigint> => {
    const what = `quote ${path.join(",")}`;
    const a = await both(what, view(exchange, "quote", { pool_ids: path, input_token: from, output_token: to, input_amount: amount.toString(), tag: null }, at));
    if (a.failed) return 0n;
    const r = json(a, what);
    const out = isObj(r) && sameKeys(r, ["amount", "tag"]) && r.tag === null ? u128(r.amount) : null;
    if (out === null) throw new RheaQuoteRefused("rpc", `${what}: not {amount, tag}`);
    return out;
  };
  // Each path's quote view goes out only once its pools read quotable (card near-dcl-route): a buy's views sent ahead
  // with the pool reads saved one round trip, but on the device's 8 candidates that is up to 16 views of paths with no
  // pool on each provider, on every quote, past the paced seat's share; a path is quoted only when it exists.

  const feeView = nearTokenFeeView(token);
  const [meta, frozen, poolAnswers, account, feeAnswer] = await Promise.all([
    both("get_metadata", view(exchange, "get_metadata", {}, at)),
    both("get_frozenlist_tokens", view(exchange, "get_frozenlist_tokens", {}, at)),
    Promise.all(ids.map((id) => both(`get_pool ${id}`, view(exchange, "get_pool", { pool_id: id }, at)))),
    accountCode(rpcs, token, final, signal, same),
    feeView ? both(`${token} ${feeView.method}`, view(token, feeView.method, {}, at)) : Promise.resolve(null),
  ]);

  const m = json(meta, "get_metadata");
  const state = isObj(m) ? m.state : undefined;
  if (state !== "Running") throw new RheaQuoteRefused("paused", `${exchange} is not Running (state ${JSON.stringify(state)})`);
  const frozenList = json(frozen, "get_frozenlist_tokens");
  if (!Array.isArray(frozenList) || !frozenList.every(isAccount)) throw new RheaQuoteRefused("rpc", "get_frozenlist_tokens: not a list of accounts");

  // the pools DCL shows Running, open to any sender and with no tax; a pool that is not there (null) is left out
  const pools: { id: string; tokens: readonly [string, string] }[] = [];
  poolAnswers.forEach((a, k) => {
    const id = ids[k] as string;
    const row = json(a, `get_pool ${id}`);
    if (row === null) return;
    const want = dclPoolOf(id)!;
    if (!isObj(row) || row.pool_id !== id || row.token_x !== want.x || row.token_y !== want.y || row.fee !== want.fee || typeof row.state !== "string")
      throw new RheaQuoteRefused("pool", `pool ${id}: not that pool's row`);
    if (row.state === "Running" && row.whitelist === null && row.tax === null) pools.push({ id, tokens: [want.x, want.y] });
  });

  let fee: NearTokenFee = nearPlainTokenFee(account);
  if (feeView && feeAnswer) {
    let v: { value: unknown } | { failed: true };
    if (feeAnswer.failed) v = { failed: true };
    else if (feeAnswer.bytes.length > NEAR_TOKEN_FEE_VIEW_MAX_BYTES) v = { value: undefined };
    else {
      try {
        v = { value: json(feeAnswer, feeView.method) };
      } catch {
        v = { value: undefined };
      }
    }
    fee = nearTokenFee(feeView.pad, account, v);
  }

  for (const t of new Set([tokenIn, tokenOut])) if (frozenList.includes(t)) throw new RheaQuoteRefused("frozen", `${t} is frozen on ${exchange}`);
  const venueIn = side === "sell" ? nearFeeVenueReceives(fee, exchange, amountIn) : amountIn;
  if (venueIn <= 0n) throw new RheaQuoteRefused("input", "the token's fee leaves nothing to swap");

  const paths = pathsOf(pools, token !== wrap && !frozenList.includes(wrap));
  if (paths.length === 0) throw new RheaQuoteRefused("no-pool", `no Running DCL pool among ${JSON.stringify(ids)} joins ${tokenIn} to ${tokenOut}, directly or through ${wrap}`);

  // The two-hop paths picked per hop (card near-quote-inside-the-kpi): the first hops' pools (tokenIn with wrapped NEAR)
  // and the second hops' (wrapped NEAR with tokenOut) are pools of different pairs, so a second hop pays more for more
  // in and its pay does not depend on which first hop fed it: the path that pays most is the first hop that pays the
  // most wrapped NEAR, then the second hop that pays most for that. So n first hops and m second hops are n + m views and
  // one of the chosen path, not n x m; where n x m is no more (one or two of each), every path is quoted as before.
  // Either way the path chosen is quoted whole on both providers at the block, and that view's amount is the quote.
  const direct = paths.filter((p) => p.length === 1);
  const firsts = [...new Set(paths.filter((p) => p.length === 2).map((p) => p[0]!))];
  const seconds = [...new Set(paths.filter((p) => p.length === 2).map((p) => p[1]!))];
  let twoHop = paths.filter((p) => p.length === 2);
  if (firsts.length * seconds.length > firsts.length + seconds.length + 1) {
    const bestOf = (outs: readonly bigint[]): number => outs.reduce((b, o, k) => (o > 0n && (b < 0 || o > outs[b]!) ? k : b), -1);
    const hop1 = await Promise.all(firsts.map((p) => quoteOf([p], venueIn, tokenIn, wrap)));
    const i = bestOf(hop1);
    if (i < 0) twoHop = [];
    else {
      const hop2 = await Promise.all(seconds.map((q) => quoteOf([q], hop1[i]!, wrap, tokenOut)));
      const j = bestOf(hop2);
      twoHop = j < 0 ? [] : [[firsts[i]!, seconds[j]!]];
    }
  }
  const quoted = [...direct, ...twoHop];
  if (quoted.length === 0) throw new RheaQuoteRefused("liquidity", `no DCL path among ${JSON.stringify(ids)} pays anything for ${venueIn} ${tokenIn}`);
  const outs = await Promise.all(quoted.map((path) => quoteOf(path, venueIn)));
  let best = -1;
  outs.forEach((o, k) => {
    if (o > 0n && (best < 0 || o > (outs[best] as bigint))) best = k;
  });
  if (best < 0) throw new RheaQuoteRefused("liquidity", `no DCL path among ${JSON.stringify(ids)} pays anything for ${venueIn} ${tokenIn}`);
  const venueOut = outs[best] as bigint;
  const amountOut = side === "buy" ? nearFeeBuyerReceives(fee, exchange, venueOut) : venueOut;
  return deepFreeze({ venue: "dcl" as const, network, exchange, height, blockHash, side, token, tokenIn, tokenOut, amountIn, venueIn, poolIds: quoted[best] as string[], venueOut, amountOut, fee });
}

// ---------- the Swap ----------
/** The Swap's msg for the quote's path and the floor (the only place one is written). */
export function dclSwapMsg(q: DclQuote, floor: bigint): string {
  return JSON.stringify({ Swap: { pool_ids: q.poolIds, output_token: q.tokenOut, min_output_amount: floor.toString(), skip_unwrap_near: true } });
}

export type DclSwapArgs = {
  quote: DclQuote;
  /** W: the fresh wallet, a 64-hex NEAR-implicit id. */
  wallet: string;
  /** The user's slippage on what DCL pays, in bps. */
  slippageBps: number;
  /** W's registration on the output token, read on two providers. */
  registered: boolean;
  /** The output token's storage_balance_bounds().min, read on two providers (used only when W is not registered). */
  storageMin: bigint;
};

/**
 * The calls W signs for a DCL quote, in the shape trade/near/swap.ts writes: while W is not registered on the output
 * token, its registration alone (a DCL payout to an unregistered W is lost to it); once registered, the one swap. No
 * claim: a DCL payout W could not take is never W's to claim. Checked by dclSwapCheck before they are returned.
 */
export function dclSwapCalls(a: DclSwapArgs, request: NearSwapRequest): NearSwapCall[] {
  const q = a.quote;
  if (!IMPLICIT.test(a.wallet)) throw new NearSwapRefused("input", "W is a 64-hex NEAR-implicit id");
  if (typeof a.registered !== "boolean" || typeof a.storageMin !== "bigint") throw new NearSwapRefused("input", "W's reads");
  const floor = nearSwapFloor(q.venueOut, a.slippageBps);
  const call = (receiver_id: string, method_name: "storage_deposit" | "ft_transfer_call", args: Record<string, unknown>, deposit: bigint): NearSwapCall => ({
    sender_id: a.wallet,
    receiver_id,
    actions: [{ FunctionCall: { method_name, args, gas: NEAR_SWAP_GAS[method_name], deposit: deposit.toString() } }],
  });
  const calls = a.registered
    ? [call(q.tokenIn, "ft_transfer_call", { receiver_id: q.exchange, amount: q.amountIn.toString(), msg: dclSwapMsg(q, floor) }, 1n)]
    : [call(q.tokenOut, "storage_deposit", { account_id: a.wallet, registration_only: true }, a.storageMin)];
  dclSwapCheck(calls, request, { quote: q, storageMin: a.storageMin, registered: a.registered });
  return deepFreeze(calls);
}

/**
 * Refuses calls that are not exactly the DCL swap the request asks for on the quote's path, with trade/near/swap.ts's
 * codes: N1 the request (token, side, amount, network, W signs), N2 the receivers (the input token, the output token,
 * DCL), N3 the methods and deposits (one registration with the token's minimum, never over 0.0125 N, alone, or one swap with 1 yocto), N4 the
 * msg read back strictly and equal byte for byte to the one built, N7 the gas.
 */
export function dclSwapCheck(calls: readonly NearSwapCall[], request: NearSwapRequest, ctx: { quote: DclQuote; storageMin: bigint; registered: boolean }): void {
  const q = ctx.quote;
  const r = request;
  if (typeof ctx.registered !== "boolean") throw new NearSwapRefused("input", "whether W is registered on the output token, as read");
  if (!(r.network in NEAR_DCL)) throw new NearSwapRefused("input", "network");
  const { exchange, wrap } = NEAR_DCL[r.network as "mainnet"];
  const usdc = NEAR_NETWORKS[r.network].usdc;
  const [tokenIn, tokenOut] = r.side === "buy" ? [usdc, r.token] : r.side === "sell" ? [r.token, usdc] : [null, null];
  if (tokenIn === null || q.venue !== "dcl" || q.network !== r.network || q.exchange !== exchange || q.side !== r.side || q.token !== r.token || q.tokenIn !== tokenIn || q.tokenOut !== tokenOut || q.amountIn !== r.amountIn)
    throw new NearSwapRefused("N1", "the quote is not the request's token, side, amount and network");
  if (!IMPLICIT.test(r.wallet)) throw new NearSwapRefused("N1", "W is a 64-hex NEAR-implicit id");
  if (!Array.isArray(calls) || calls.length !== 1) throw new NearSwapRefused("N3", "one call: the registration alone, or the swap alone");
  const c = calls[0] as unknown;
  if (!isObj(c) || !sameKeys(c, ["sender_id", "receiver_id", "actions"])) throw new NearSwapRefused("N3", "a call's fields");
  if (c.sender_id !== r.wallet) throw new NearSwapRefused("N1", "a call signed by another account than W");
  if (c.receiver_id !== tokenIn && c.receiver_id !== tokenOut && c.receiver_id !== exchange) throw new NearSwapRefused("N2", `a call to ${String(c.receiver_id)}`);
  if (!Array.isArray(c.actions) || c.actions.length !== 1) throw new NearSwapRefused("N3", "one action a call");
  const act = c.actions[0] as unknown;
  if (!isObj(act) || !sameKeys(act, ["FunctionCall"]) || !isObj(act.FunctionCall)) throw new NearSwapRefused("N3", "a FunctionCall only");
  const f = act.FunctionCall;
  if (!sameKeys(f, ["method_name", "args", "gas", "deposit"]) || !isObj(f.args)) throw new NearSwapRefused("N3", "a FunctionCall's fields");
  const method = f.method_name;
  const deposit = u128(f.deposit);
  const args = f.args;
  if (method === "storage_deposit") {
    if (ctx.registered) throw new NearSwapRefused("N3", "storage_deposit: W is registered already");
    if (f.gas !== NEAR_SWAP_GAS.storage_deposit) throw new NearSwapRefused("N7", `storage_deposit: gas ${String(f.gas)}`);
    if (c.receiver_id !== tokenOut) throw new NearSwapRefused("N3", "a registration on another token than the output");
    if (!sameKeys(args, ["account_id", "registration_only"]) || args.account_id !== r.wallet || args.registration_only !== true) throw new NearSwapRefused("N3", "storage_deposit: W's own registration only");
    if (deposit === null || deposit <= 0n || deposit !== ctx.storageMin || deposit > NEAR_SWAP_STORAGE_MAX) throw new NearSwapRefused("N3", "storage_deposit: the token's minimum only");
    return;
  }
  if (method !== "ft_transfer_call") throw new NearSwapRefused("N3", `${String(method)}: not allowed here`);
  if (!ctx.registered) throw new NearSwapRefused("N3", "a swap before W's registration reads back");
  if (f.gas !== NEAR_SWAP_GAS.ft_transfer_call) throw new NearSwapRefused("N7", `ft_transfer_call: gas ${String(f.gas)}`);
  if (c.receiver_id !== tokenIn) throw new NearSwapRefused("N3", "the swap moves another token than the input");
  if (deposit !== 1n) throw new NearSwapRefused("N3", "ft_transfer_call: 1 yocto");
  if (!sameKeys(args, ["receiver_id", "amount", "msg"]) || args.receiver_id !== exchange) throw new NearSwapRefused("N2", "ft_transfer_call: into DCL only");
  if (u128(args.amount) !== r.amountIn) throw new NearSwapRefused("N1", "ft_transfer_call: not the request's amount");
  if (typeof args.msg !== "string") throw new NearSwapRefused("N4", "msg");
  checkMsg(args.msg, q, r.slippageBps, tokenIn, tokenOut, wrap);
}

/** N4: the msg read back as DCL reads it, and equal to the one built for the quote. */
function checkMsg(msg: string, q: DclQuote, slippageBps: number, tokenIn: string, tokenOut: string, wrap: string): void {
  let m: unknown;
  try {
    m = JSON.parse(msg);
  } catch {
    throw new NearSwapRefused("N4", "msg: not JSON");
  }
  if (!isObj(m) || !sameKeys(m, ["Swap"]) || !isObj(m.Swap)) throw new NearSwapRefused("N4", "msg: a Swap only");
  const s = m.Swap;
  if (!sameKeys(s, ["pool_ids", "output_token", "min_output_amount", "skip_unwrap_near"])) throw new NearSwapRefused("N4", "msg: the Swap's keys (no referrer, no echo)");
  if (s.skip_unwrap_near !== true) throw new NearSwapRefused("N4", "msg: no unwrap");
  if (s.output_token !== tokenOut) throw new NearSwapRefused("N4", "msg: not the request's output token");
  const path = s.pool_ids;
  if (!Array.isArray(path) || path.length < 1 || path.length > 2 || path.length !== q.poolIds.length || path.some((p, i) => p !== q.poolIds[i])) throw new NearSwapRefused("N4", "msg: the quote's pools and no other");
  // the path runs from the input to the output, through wNEAR when it has two pools
  const pools = path.map(dclPoolOf);
  if (pools.some((p) => p === null)) throw new NearSwapRefused("N4", "msg: a pool id that is not a DCL pool id");
  const holds = (k: number, a: string, b: string) => [pools[k]!.x, pools[k]!.y].includes(a) && [pools[k]!.x, pools[k]!.y].includes(b);
  const runs = path.length === 1 ? holds(0, tokenIn, tokenOut) : holds(0, tokenIn, wrap) && holds(1, wrap, tokenOut);
  if (!runs) throw new NearSwapRefused("N4", "msg: the pools do not run from the input to the output");
  const floor = nearSwapFloor(q.venueOut, slippageBps);
  if (u128(s.min_output_amount) !== floor || floor <= 0n) throw new NearSwapRefused("N4", `msg: the minimum is not ${floor}`);
  if (msg !== dclSwapMsg(q, floor)) throw new NearSwapRefused("N4", "msg: not the bytes built for the quote");
}
