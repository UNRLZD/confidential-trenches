// The calls a fresh NEAR wallet W signs to buy or sell a token on Rhea classic, and the checks that hold them before
// anything is signed. The quote is the device's own (near/rhea.ts rheaQuote, two providers at one block); these calls
// are built from it alone, then read back and checked as if a stranger had written them.
//
// The calls, each one receiver and one FunctionCall, so each can be signed as its own NEP-366 delegate or transaction.
// Whoever carries them picks the order they land in, so the swap is never signed beside a registration it needs: a
// swap landing before W's registration on the output token would pay out where W cannot reach it from this kit (its
// exchange account, its lost-found, or the exchange owner's). Two rounds, each its own call set:
// - while W is not registered on the output token: its registration alone, TOKEN.storage_deposit({account_id: W,
//   registration_only: true}) with the token's storage minimum (NEP-145; the kit's 10 Tgas). The swap is built only
//   once W's registration reads back on both providers at one block (trade/near/wallet.ts readNearSwapWallet);
// - once it is registered:
//   the swap: the input token's ft_transfer_call({receiver_id: the exchange, amount, msg}) with 1 yocto and 150 Tgas
//   (the UNRLZD trading terminal's classic swap gas; the contract's cap is 200). The msg is the exchange's direct
//   form (ref-exchange token_receiver.rs TokenReceiverMessage::Execute): {force: 0, actions, skip_degen_price_sync:
//   true, skip_unwrap_near: true}, one action per hop of the quote, the first with no amount_in (the exchange swaps
//   what arrived, so a token's fee on the way in cannot leave input unspent), every minimum 0 but the last, which is
//   the floor from the user's slippage. No swap_out_recipient, client_echo or referral_id: the output goes back to
//   the sender, W (token_receiver.rs: `swap_out_recipient.unwrap_or(&sender_id)`);
//   and the claim of what an earlier swap left in W's lost-found on the exchange (a payout that reached W before its
//   registration, account_deposit.rs internal_handle_fail_in_withdraw_callback): exchange.claim_lostfound({token_id})
//   with 1 yocto (account_lostfound.rs claim_lostfound, assert_one_yocto).
//
// The checks (nearSwapCheck), each a refusal with its code, run on the built calls against the user's own request:
//   N1 request: every call's signer is W, the swap's token, side and amount are the request's;
//   N2 receivers: only the input token, the output token and the network's exchange;
//   N3 methods and deposits per receiver: storage_deposit with the token's minimum (never over 0.0125 N), 1 yocto on
//      the swap and the claim, nothing else, at most one of each, in that order; W not registered: the registration
//      alone; W registered: no registration and exactly one swap;
//   N4 the msg parsed back strictly: its exact keys, no recipient, no referrer, the quote's hops and no other, a last
//      minimum above 0 and every other 0, no amount_in or amount_out; and it equals what was built, byte for byte;
//   N7 the gas of each call exactly the kit's.
// N5 is the quote itself (two providers at one block); N6 (Plach's code pin) has no Rhea classic counterpart.
import { NEAR_NETWORKS, type NearNetwork } from "../../near/networks.ts";
import { NEAR_RHEA, type RheaQuote } from "../../near/rhea.ts";
import { deepFreeze } from "../../freeze.ts";

const TGAS = 1_000_000_000_000;
export const NEAR_SWAP_GAS = deepFreeze({ storage_deposit: 10 * TGAS, ft_transfer_call: 150 * TGAS, claim_lostfound: 100 * TGAS });
/** The most a token's registration may take: the UNRLZD trading terminal's MAX_STORAGE_DEPOSIT, 0.0125 NEAR. */
export const NEAR_SWAP_STORAGE_MAX = 12_500_000_000_000_000_000_000n;
/** Slippage in bps: above 0 and below 100%. */
export const NEAR_SWAP_SLIPPAGE_MAX_BPS = 9_999;

const U128_MAX = (1n << 128n) - 1n;
const IMPLICIT = /^[0-9a-f]{64}$/;

export type NearSwapCall = {
  sender_id: string;
  receiver_id: string;
  actions: [{ FunctionCall: { method_name: "storage_deposit" | "ft_transfer_call" | "claim_lostfound"; args: Record<string, unknown>; gas: number; deposit: string } }];
};

export type NearSwapArgs = {
  quote: RheaQuote;
  /** W: the fresh wallet, a 64-hex NEAR-implicit id. */
  wallet: string;
  /** The user's slippage on what the exchange pays, in bps. */
  slippageBps: number;
  /** W's registration on the output token, read on two providers: null when W has none. */
  registered: boolean;
  /** The output token's storage_balance_bounds().min, read on two providers (used only when W is not registered). */
  storageMin: bigint;
  /** W's lost-found of the output token on the exchange (get_lostfound_token), read on two providers. */
  lostfound: bigint;
};

/** The user's own request, held apart from the quote and the calls: what nearSwapCheck checks them against. */
export type NearSwapRequest = { network: NearNetwork; side: "buy" | "sell"; token: string; amountIn: bigint; wallet: string; slippageBps: number };

export type NearSwapRefusalCode = "input" | "N1" | "N2" | "N3" | "N4" | "N7";
export class NearSwapRefused extends Error {
  readonly code: NearSwapRefusalCode;
  constructor(code: NearSwapRefusalCode, detail: string) {
    super(`NEAR swap refused (${code}): ${detail}`);
    this.name = "NearSwapRefused";
    this.code = code;
  }
}

/** The exchange's floor from the user's slippage: floor(out × (10⁴ − bps) / 10⁴), never 0. */
export function nearSwapFloor(venueOut: bigint, slippageBps: number): bigint {
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 1 || slippageBps > NEAR_SWAP_SLIPPAGE_MAX_BPS) throw new NearSwapRefused("input", `slippage is 1 to ${NEAR_SWAP_SLIPPAGE_MAX_BPS} bps`);
  const floor = (venueOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (floor <= 0n) throw new NearSwapRefused("input", "the floor from this slippage is 0");
  return floor;
}

/** The swap's msg for the quote's hops and the floor (the only place one is written). */
export function nearSwapMsg(quote: RheaQuote, floor: bigint): string {
  const actions = quote.hops.map((h, i) => ({ pool_id: h.pool, token_in: h.tokenIn, token_out: h.tokenOut, min_amount_out: i === quote.hops.length - 1 ? floor.toString() : "0" }));
  return JSON.stringify({ force: 0, actions, skip_degen_price_sync: true, skip_unwrap_near: true });
}

/** The calls W signs for the quote, in order, checked by nearSwapCheck against the request before they are returned. */
export function nearSwapCalls(a: NearSwapArgs, request: NearSwapRequest): NearSwapCall[] {
  const q = a.quote;
  if (!IMPLICIT.test(a.wallet)) throw new NearSwapRefused("input", "W is a 64-hex NEAR-implicit id");
  if (typeof a.registered !== "boolean" || typeof a.storageMin !== "bigint" || typeof a.lostfound !== "bigint" || a.lostfound < 0n) throw new NearSwapRefused("input", "W's reads");
  const floor = nearSwapFloor(q.venueOut, a.slippageBps);
  const call = (receiver_id: string, method_name: NearSwapCall["actions"][0]["FunctionCall"]["method_name"], args: Record<string, unknown>, deposit: bigint): NearSwapCall => ({
    sender_id: a.wallet,
    receiver_id,
    actions: [{ FunctionCall: { method_name, args, gas: NEAR_SWAP_GAS[method_name], deposit: deposit.toString() } }],
  });
  const calls: NearSwapCall[] = [];
  if (!a.registered) calls.push(call(q.tokenOut, "storage_deposit", { account_id: a.wallet, registration_only: true }, a.storageMin));
  else {
    calls.push(call(q.tokenIn, "ft_transfer_call", { receiver_id: q.exchange, amount: q.amountIn.toString(), msg: nearSwapMsg(q, floor) }, 1n));
    if (a.lostfound > 0n) calls.push(call(q.exchange, "claim_lostfound", { token_id: q.tokenOut }, 1n));
  }
  nearSwapCheck(calls, request, { quote: q, storageMin: a.storageMin, registered: a.registered });
  return deepFreeze(calls);
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const sameKeys = (o: Obj, keys: readonly string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const U128_TEXT = /^(0|[1-9]\d{0,38})$/;
const u128 = (x: unknown): bigint | null => (typeof x === "string" && U128_TEXT.test(x) && BigInt(x) <= U128_MAX ? BigInt(x) : null);

/**
 * Refuses calls that are not exactly the swap the request asks for on the quote's hops (N1-N4, N7). `quote` is the
 * device's own; `storageMin` the token's minimum as read.
 */
export function nearSwapCheck(calls: readonly NearSwapCall[], request: NearSwapRequest, ctx: { quote: RheaQuote; storageMin: bigint; registered: boolean }): void {
  const q = ctx.quote;
  if (typeof ctx.registered !== "boolean") throw new NearSwapRefused("input", "whether W is registered on the output token, as read");
  const r = request;
  if (!(r.network in NEAR_RHEA)) throw new NearSwapRefused("input", "network");
  const exchange = NEAR_RHEA[r.network].exchange;
  const usdc = NEAR_NETWORKS[r.network].usdc;
  const [tokenIn, tokenOut] = r.side === "buy" ? [usdc, r.token] : r.side === "sell" ? [r.token, usdc] : [null, null];
  // N1: the quote and the request agree, and W signs every call
  if (tokenIn === null || q.network !== r.network || q.exchange !== exchange || q.side !== r.side || q.token !== r.token || q.tokenIn !== tokenIn || q.tokenOut !== tokenOut || q.amountIn !== r.amountIn)
    throw new NearSwapRefused("N1", "the quote is not the request's token, side, amount and network");
  if (!IMPLICIT.test(r.wallet)) throw new NearSwapRefused("N1", "W is a 64-hex NEAR-implicit id");
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 3) throw new NearSwapRefused("N3", "one to three calls");
  const order = ["storage_deposit", "ft_transfer_call", "claim_lostfound"];
  let last = -1;
  let swaps = 0;
  for (const c of calls) {
    if (!isObj(c) || !sameKeys(c, ["sender_id", "receiver_id", "actions"])) throw new NearSwapRefused("N3", "a call's fields");
    if (c.sender_id !== r.wallet) throw new NearSwapRefused("N1", "a call signed by another account than W");
    // N2: the receivers
    if (c.receiver_id !== tokenIn && c.receiver_id !== tokenOut && c.receiver_id !== exchange) throw new NearSwapRefused("N2", `a call to ${String(c.receiver_id)}`);
    if (!Array.isArray(c.actions) || c.actions.length !== 1) throw new NearSwapRefused("N3", "one action a call");
    const act = c.actions[0] as unknown;
    if (!isObj(act) || !sameKeys(act, ["FunctionCall"]) || !isObj(act.FunctionCall)) throw new NearSwapRefused("N3", "a FunctionCall only");
    const f = act.FunctionCall;
    if (!sameKeys(f, ["method_name", "args", "gas", "deposit"]) || !isObj(f.args)) throw new NearSwapRefused("N3", "a FunctionCall's fields");
    const method = f.method_name as string;
    const at = order.indexOf(method);
    if (at < 0 || at <= last) throw new NearSwapRefused("N3", `${String(method)}: not allowed here`);
    last = at;
    // N7: the gas
    if (f.gas !== NEAR_SWAP_GAS[method as keyof typeof NEAR_SWAP_GAS]) throw new NearSwapRefused("N7", `${method}: gas ${String(f.gas)}`);
    const deposit = u128(f.deposit);
    const args = f.args;
    if (method === "storage_deposit") {
      if (ctx.registered) throw new NearSwapRefused("N3", "storage_deposit: W is registered already");
      if (c.receiver_id !== tokenOut) throw new NearSwapRefused("N3", "a registration on another token than the output");
      if (!sameKeys(args, ["account_id", "registration_only"]) || args.account_id !== r.wallet || args.registration_only !== true) throw new NearSwapRefused("N3", "storage_deposit: W's own registration only");
      if (deposit === null || deposit <= 0n || deposit !== ctx.storageMin || deposit > NEAR_SWAP_STORAGE_MAX) throw new NearSwapRefused("N3", "storage_deposit: the token's minimum only");
    } else if (method === "ft_transfer_call") {
      if (!ctx.registered) throw new NearSwapRefused("N3", "a swap before W's registration reads back");
      swaps++;
      if (c.receiver_id !== tokenIn) throw new NearSwapRefused("N3", "the swap moves another token than the input");
      if (deposit !== 1n) throw new NearSwapRefused("N3", "ft_transfer_call: 1 yocto");
      if (!sameKeys(args, ["receiver_id", "amount", "msg"]) || args.receiver_id !== exchange) throw new NearSwapRefused("N2", "ft_transfer_call: into the exchange only");
      if (u128(args.amount) !== r.amountIn) throw new NearSwapRefused("N1", "ft_transfer_call: not the request's amount");
      if (typeof args.msg !== "string") throw new NearSwapRefused("N4", "msg");
      checkMsg(args.msg, q, r.slippageBps, tokenIn, tokenOut, NEAR_RHEA[r.network].wrap);
    } else {
      if (!ctx.registered) throw new NearSwapRefused("N3", "a claim before W's registration reads back");
      if (c.receiver_id !== exchange) throw new NearSwapRefused("N3", "claim_lostfound: on the exchange only");
      if (deposit !== 1n) throw new NearSwapRefused("N3", "claim_lostfound: 1 yocto");
      if (!sameKeys(args, ["token_id"]) || args.token_id !== tokenOut) throw new NearSwapRefused("N3", "claim_lostfound: the output token only");
    }
  }
  if (ctx.registered && swaps !== 1) throw new NearSwapRefused("N3", "exactly one swap");
}

/** N4: the msg read back as the exchange reads it, and equal to the one built for the quote. */
function checkMsg(msg: string, q: RheaQuote, slippageBps: number, tokenIn: string, tokenOut: string, wrap: string): void {
  let m: unknown;
  try {
    m = JSON.parse(msg);
  } catch {
    throw new NearSwapRefused("N4", "msg: not JSON");
  }
  if (!isObj(m) || !sameKeys(m, ["force", "actions", "skip_degen_price_sync", "skip_unwrap_near"])) throw new NearSwapRefused("N4", "msg: its keys (no recipient, referrer or echo)");
  if (m.force !== 0 || m.skip_degen_price_sync !== true || m.skip_unwrap_near !== true) throw new NearSwapRefused("N4", "msg: force 0, no unwrap, no price sync");
  const acts = m.actions;
  if (!Array.isArray(acts) || acts.length !== q.hops.length || acts.length < 1 || acts.length > 2) throw new NearSwapRefused("N4", "msg: the quote's hops and no other");
  const floor = nearSwapFloor(q.venueOut, slippageBps);
  acts.forEach((a: unknown, i: number) => {
    const h = q.hops[i];
    if (!isObj(a) || !sameKeys(a, ["pool_id", "token_in", "token_out", "min_amount_out"]) || h === undefined) throw new NearSwapRefused("N4", `msg: action ${i}'s keys (no amount_in, no amount_out)`);
    if (a.pool_id !== h.pool || a.token_in !== h.tokenIn || a.token_out !== h.tokenOut) throw new NearSwapRefused("N4", `msg: action ${i} is not the quote's hop`);
    for (const t of [a.token_in, a.token_out]) if (t !== tokenIn && t !== tokenOut && t !== wrap) throw new NearSwapRefused("N4", `msg: an unlisted token ${String(t)}`);
    const min = u128(a.min_amount_out);
    const want = i === acts.length - 1 ? floor : 0n;
    if (min === null || min !== want) throw new NearSwapRefused("N4", `msg: action ${i}'s minimum is not ${want}`);
  });
  if ((acts[0] as Obj).token_in !== tokenIn || (acts.at(-1) as Obj).token_out !== tokenOut) throw new NearSwapRefused("N4", "msg: the hops do not run from the input to the output");
  for (let i = 1; i < acts.length; i++) if ((acts[i] as Obj).token_in !== (acts[i - 1] as Obj).token_out) throw new NearSwapRefused("N4", "msg: a hop that does not spend the one before it");
  if (floor <= 0n) throw new NearSwapRefused("N4", "msg: a floor of 0");
  if (msg !== nearSwapMsg(q, floor)) throw new NearSwapRefused("N4", "msg: not the bytes built for the quote");
}
