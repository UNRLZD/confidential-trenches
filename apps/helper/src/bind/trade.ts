// POST /v1/bind's trade kind (card relayer-near-trade): a fresh NEAR wallet W buys or sells a token on Rhea classic,
// and the helper's gas account pays every NEAR it needs. W is a 64-hex implicit id whose key exists only on the device;
// the helper never builds or alters a call: it creates W with one plain Transfer, then carries W's signed bytes, or
// refuses. The rule (card near-private-trading, 11 Nov), in order:
//
//   1. Creation: a body with no delegates names W. Once a vault payout to W reads as landed (the vault's spends list,
//      both providers at one final block: a row whose recipient is W, paid, or settled with refund_value 0, as
//      withdraw/send.ts reads a delivered payout), an absent W is created with ONE plain Transfer of
//      HELPER_BIND_TRADE_CREATE_YOCTO (W's account and its one key, create.ts CREATE_YOCTO) and nothing more: the deposits
//      W's calls attach (the registration's storage, each call's yocto) are paid by the relayer that carries them, never
//      by W (nearcore core/primitives/src/fees.rs total_deposit, the Delegate branch: "here Relayer pays the deposit";
//      read on mainnet tx 84x8XDXGUoLR3kgdYDiShekLqfzxetfQydQfigKEsA5R, the gas account's balance down by the tokens
//      burnt plus the inner call's 1 yocto, on two providers). W's record is claimed by an atomic create-if-absent
//      before anything is signed, so W is created once, ever; a Transfer that never applied (dropped) may go again. A
//      paid W that someone else's Transfer created is taken as it is: its record is made, nothing is sent.
//   2. Carrying: a body with 1 to 3 delegates is W's calls in the kit's order (nearSwapCalls: the registration alone, or
//      the swap and the lost-found claim). Every delegate is checked before any is sent: canonical base64, one borsh
//      SignedDelegateAction (checks.ts decodeSignedDelegate), its NEP-366 signature, signer W with W's own id key (full
//      access, read on two providers), nonces rising from above the key's nonce and under the final height x 10^6, a
//      max_block_height ahead of the final height by at least K and at most 600 blocks, one FunctionCall whose args are
//      the JSON the device wrote. W's registrations on both of the trade's tokens are read at one block on two
//      providers: a registration is carried only while W reads unregistered, a swap only once W reads registered on
//      the output token (and on a sell the input token). Every hop is a Rhea pool holding its two tokens, read at one
//      block on two providers. Then the calls go through the kit's own nearSwapCheck against the trade's request and
//      quote with the storage minimum and the registration the helper read itself; a refusal answers swap_<its code>.
//      Then: a vault payout to W landed, W holds amount_in of the input token, the token watch is open, and the gas
//      account holds the calls' deposits above its floor. Each delegate goes out in its own transaction (a Delegate
//      action, receiver W), each only after the one before it read final with every receipt ok on both providers, and
//      only one of W's at a time.
//   3. Bounds, per W: W is bound to the token its first carried call names; at most one registration, and per side
//      (buy, sell) one swap and one claim. A side is taken when its swap's transaction is signed for sending; a swap
//      that failed on chain with the input back on W frees its side, up to TRADE_SWAP_FAILS_MAX swaps a side in all.
//   4. The gas account's worst cost per payout is TRADE_COST_MAX (0.09 N), whatever the token's contract does: W's
//      running total counts the creation (0.00182 N to W plus the 0.00712 N its receipts burnt on mainnet, 11 Nov) and
//      every call carried and not dropped: while its outcome is not final, at its worst (its prepaid gas plus 1 Tgas
//      for its own transaction at TRADE_GAS_PRICE, plus its deposit: a registration at most 0.0136 N, a swap
//      0.0151 N, a claim 0.0101 N); once final on both providers, at what it cost (the tokens its transaction and
//      receipts burnt, as both read them, plus its deposit). A request that would pass the bound answers trade_used.
//      A token whose calls burn all their gas is counted in full; an honest swap burns about 0.00164 N on mainnet, a
//      claim about 0.0003 N, a registration about 0.00031 N plus its deposit. The most an honest W carries under the
//      side rules (a registration at the cap, three swaps and a claim a side): 0.00894 + 0.01281 + 2 x (3 x 0.00164 +
//      0.0003) = 0.03219 N, and at most 0.05545 N counted while its last swap and claim are in flight at their worst.
//      A W the vault never paid gets nothing. The same signed bytes are never sent twice (only
//      a transaction of ours that never applied goes again): a request whose delegates were carried answers their
//      transactions again, with nothing sent.
//
// What W's sell leaves goes back to the vault as a deposit delegate (send.ts carryDeposit), and W's clean-up is
// HelperBindCleanup.

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import {
  HELPER_BIND_TRADE_CODES,
  HELPER_BIND_TRADE_CREATE_YOCTO,
  HELPER_BIND_TRADE_DELEGATES_MAX,
  HELPER_BIND_TRADE_STORAGE_MAX,
  HELPER_CODE_STATUS,
  NEAR_RHEA,
  NEAR_SWAP_STORAGE_MAX,
  nearSwapCheck,
  NearSwapRefused,
  type HelperNearTrade,
  type NearSwapCall,
  type NearSwapRequest,
  type RheaQuote,
} from "@blindfill/kit";
import { base58, BIND_MAX_BYTES, decodeSignedDelegate, EXPIRY_MAX_BLOCKS, isAccountId, NONCE_RANGE_MULTIPLIER, signatureOk, type KeyRead } from "./checks.ts";
import { accountSlots, createSendReads, RELAYER_FLOOR_YOCTO, type Relayer, type Rpc, type TxOutcome, type TxRef } from "./send.ts";
import { pagesAt } from "../near/pages.ts";
import { openDurableDir, type StoreFs } from "../store/durable.ts";
import { agreedBlock, viewAt, type Block } from "../withdraw/fee.ts";
import { accountAt } from "../withdraw/send.ts";
import { WATCHED } from "../token-status/status.ts";


export type TradeCode = (typeof HELPER_BIND_TRADE_CODES)[number];
export type TradeAnswer = { status: number; body: { tx_hashes: string[] } | { error: { code: TradeCode }; tx_hashes?: string[] } };

/** The kit's NEAR_SWAP_STORAGE_MAX and the wire's cap are one number (held by trade.test.ts). */
export const TRADE_STORAGE_MAX = HELPER_BIND_TRADE_STORAGE_MAX;
/** A side's swaps that failed on chain with the input back on W: past this many, the side is used up. */
export const TRADE_SWAP_FAILS_MAX = 3;
/** The gas account's bound on one payout: the creation and every call carried for W, at their worst (header, 4). */
export const TRADE_COST_MAX = 90_000_000_000_000_000_000_000n;
/** The price a unit of gas is counted at: NEAR's minimum gas price, 10^8 yocto (no token's contract moves it). */
export const TRADE_GAS_PRICE = 100_000_000n;
/** A delegate's own transaction above its call's prepaid gas. */
const TRADE_OUTER_GAS = 1_000_000_000_000n;
/** W's creation as the gas account pays it: W's amount and what its receipts burnt on mainnet (0.00712 N). */
const TRADE_CREATION_COST = HELPER_BIND_TRADE_CREATE_YOCTO + 7_120_000_000_000_000_000_000n;
const callCost = (gas: bigint, deposit: bigint) => (gas + TRADE_OUTER_GAS) * TRADE_GAS_PRICE + deposit;

// ---- Inputs ----

export type TradeConfig = {
  network: "mainnet" | "testnet";
  /** R4's margin K in blocks (checks.ts BindConfig.marginK). */
  marginK: bigint;
};

/** An account at final on both providers: absent (no account, no key), or present. */
export type AccountState = { kind: "absent" } | { kind: "account" };

/** The chain reads, each at final on two providers that agree; a read that fails or disagrees throws (nothing spent). */
export type TradeReads = {
  /** The lower of the two providers' finals. */
  finalHeight(): Promise<bigint>;
  /** The higher of the two (R4's margin, read right before signing). */
  newestFinalHeight(): Promise<bigint>;
  account(id: string): Promise<AccountState>;
  accessKey(account: string, publicKey: string): Promise<KeyRead>;
  ftBalance(token: string, account: string): Promise<bigint>;
  /** token.storage_balance_bounds().min. */
  storageMin(token: string): Promise<bigint>;
  /** token.storage_balance_of(account) is not null, for each token, every read at one block on both providers. */
  registered(tokens: readonly string[], account: string): Promise<boolean[]>;
  /** A vault payout to `wallet` reads as landed: a spends row whose recipient it is, paid or settled with refund_value 0. */
  payoutLanded(wallet: string): Promise<boolean>;
  /** Every hop is a pool of the network's Rhea exchange holding its two tokens, read at one block on both providers. */
  hopsReal(hops: readonly { pool: number; tokenIn: string; tokenOut: string }[]): Promise<boolean>;
};

/** POST /v1/bind/record's read (bind/record.ts): payoutLanded for each wallet, with the spends list read once. */
export type RecordReads = {
  payoutsLanded(wallets: readonly string[]): Promise<boolean[]>;
};

export type CarriedEntry = TxRef & {
  sha256: string;
  trade: string;
  side: "buy" | "sell";
  method: string;
  /** What the call costs the gas account, in yocto: at its worst (callCost) until final, then what it burnt and its deposit. */
  cost: string;
  /** The call's deposit, in yocto (the relayer pays it). */
  deposit: string;
  /** What the call moves out of W (a swap's input token and amount), read again when it fails. */
  token_in: string;
  amount_in: string;
  state: "pending" | "landed" | "failed" | "dropped";
  /** A failed swap whose input read back on W in full: its side is free again. */
  refunded?: boolean;
};
export type CreationEntry = TxRef & { amount: string; state: "pending" | "landed" | "failed" | "dropped" };
/**
 * W's record: its creation (null once claimed, before the Transfer is signed), whether W was made by someone else's
 * Transfer and taken as it is, the token its first carried call named (null before), and every delegate carried for it.
 */
export type TradeRecord = { w: string; creation: CreationEntry | null; adopted: boolean; token: string | null; carried: CarriedEntry[] };

export type TradeStore = {
  get(w: string): TradeRecord | null;
  /** Create-if-absent on W, durable before it returns; the existing record when one is there. */
  create(rec: TradeRecord): { created: boolean; rec: TradeRecord };
  put(rec: TradeRecord): void;
  close(): void;
};

export type TradeDeps = {
  cfg: TradeConfig;
  reads: TradeReads;
  store: TradeStore;
  relayer: Relayer;
  /** The token watch on the network's USDC: true holds every carry (send.ts tokenHeld). */
  held(): Promise<boolean>;
};

// ---- The body ----

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const U128 = /^(0|[1-9][0-9]{0,38})$/;
const u128 = (x: unknown): bigint | null => (typeof x === "string" && U128.test(x) && BigInt(x) < 1n << 128n ? BigInt(x) : null);
const IMPLICIT = /^[0-9a-f]{64}$/;

/** A body of the trade kind: it has `trade` (env.ts routes it here). */
export const isTradeBody = (body: unknown): boolean => isObj(body) && Object.hasOwn(body, "trade");

type Parsed = { trade: HelperNearTrade; amountIn: bigint; venueOut: bigint; raws: Uint8Array[]; tradeId: string };

function parseBody(body: unknown): Parsed | null {
  if (!isObj(body) || !sameKeys(body, ["trade", "signed_delegates"])) return null;
  const t = body.trade;
  const list = body.signed_delegates;
  if (!isObj(t) || !sameKeys(t, ["network", "side", "token", "wallet", "amount_in", "slippage_bps", "venue_out", "hops"])) return null;
  if (t.network !== "mainnet" && t.network !== "testnet") return null;
  if (t.side !== "buy" && t.side !== "sell") return null;
  if (!isAccountId(t.token) || typeof t.wallet !== "string" || !IMPLICIT.test(t.wallet)) return null;
  const amountIn = u128(t.amount_in);
  const venueOut = u128(t.venue_out);
  if (amountIn === null || amountIn === 0n || venueOut === null || venueOut === 0n) return null;
  if (typeof t.slippage_bps !== "number" || !Number.isSafeInteger(t.slippage_bps)) return null;
  const hops = t.hops;
  if (!Array.isArray(hops) || hops.length < 1 || hops.length > 2) return null;
  for (const h of hops) if (!isObj(h) || !sameKeys(h, ["pool", "token_in", "token_out"]) || !Number.isSafeInteger(h.pool) || (h.pool as number) < 0 || !isAccountId(h.token_in) || !isAccountId(h.token_out)) return null;
  if (!Array.isArray(list) || list.length > HELPER_BIND_TRADE_DELEGATES_MAX) return null;
  const raws: Uint8Array[] = [];
  for (const b64 of list) {
    if (typeof b64 !== "string" || b64.length > Math.ceil(BIND_MAX_BYTES / 3) * 4 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    if (Buffer.from(bytes).toString("base64") !== b64 || bytes.length > BIND_MAX_BYTES) return null;
    raws.push(bytes);
  }
  const trade = t as unknown as HelperNearTrade;
  // the trade's identity: its fields as sent, so a delegate carried for one trade is never counted for another
  const tradeId = createHash("sha256").update(JSON.stringify([trade.network, trade.side, trade.token, trade.wallet, trade.amount_in, trade.slippage_bps, trade.venue_out, trade.hops.map((h) => [h.pool, h.token_in, h.token_out])])).digest("hex");
  return { trade, amountIn, venueOut, raws, tradeId };
}

const STATUS: Record<string, number> = HELPER_CODE_STATUS;
const no = (code: TradeCode, tx_hashes?: string[]): TradeAnswer => ({ status: STATUS[code] ?? 400, body: { error: { code }, ...(tx_hashes !== undefined && tx_hashes.length > 0 && { tx_hashes }) } });
const ok = (tx_hashes: string[]): TradeAnswer => ({ status: 200, body: { tx_hashes } });
const sha256hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** W's own id key: the ed25519 key whose 32 bytes are W. */
const idKey = (w: string) => `ed25519:${base58(Buffer.from(w, "hex"))}`;
/** Every receipt ran: the call did what it was signed to do. */
const allOk = (out: Extract<TxOutcome, { kind: "final" }>) => out.receipts.length > 0 && out.receipts.every((r) => r.ok);

/** The tokens of the trade: what leaves W and what it gets. */
function tokensOf(t: HelperNearTrade): { tokenIn: string; tokenOut: string } {
  // the network's USDC, the vault's asset, as the helper's token watch names it (the carry's start holds the vault's
  // config() to it, bind/env.ts)
  const usdc = WATCHED[t.network].token;
  return t.side === "buy" ? { tokenIn: usdc, tokenOut: t.token } : { tokenIn: t.token, tokenOut: usdc };
}

/** The request and the quote nearSwapCheck holds the calls to: the device's own, as sent. */
function swapInputs(p: Parsed): { request: NearSwapRequest; quote: RheaQuote } {
  const t = p.trade;
  const { tokenIn, tokenOut } = tokensOf(t);
  const request: NearSwapRequest = { network: t.network, side: t.side, token: t.token, amountIn: p.amountIn, wallet: t.wallet, slippageBps: t.slippage_bps };
  // only the fields nearSwapCheck reads come from the device; the rest are never read by it
  const quote = {
    network: t.network,
    exchange: NEAR_RHEA[t.network].exchange,
    side: t.side,
    token: t.token,
    tokenIn,
    tokenOut,
    amountIn: p.amountIn,
    venueOut: p.venueOut,
    hops: t.hops.map((h) => ({ pool: h.pool, tokenIn: h.token_in, tokenOut: h.token_out, amountIn: 0n, amountOut: 0n, feeBps: 0 })),
  } as unknown as RheaQuote;
  return { request, quote };
}

/** W's in-flight slot in this process, shared with the deposit carry (send.ts accountSlots). */
const busy = accountSlots;

export async function carryTrade(body: unknown, deps: TradeDeps): Promise<TradeAnswer> {
  const p = parseBody(body);
  if (p === null) return no("bad_shape");
  if (p.trade.network !== deps.cfg.network) return no("bad_shape");
  const w = p.trade.wallet;
  if (busy.has(w)) return no("in_flight");
  busy.add(w);
  try {
    return p.raws.length === 0 ? await createW(p, deps) : await carryCalls(p, deps);
  } catch (e) {
    // a provider that failed or disagreed, or a store write: nothing was decided on it, and the device asks again
    console.error(`trade: ${w}: ${e instanceof Error ? e.message : String(e)}`);
    return no("upstream");
  } finally {
    busy.delete(w);
  }
}

// ---- 1. The creation ----

const fresh = (w: string): TradeRecord => ({ w, creation: null, adopted: false, token: null, carried: [] });

async function createW(p: Parsed, deps: TradeDeps): Promise<TradeAnswer> {
  const { reads, store, relayer } = deps;
  const w = p.trade.wallet;
  // a Transfer of ours whose outcome is not known yet is read again by its hash first (its bytes sent again only while
  // W reads absent; one signed nonce lands at most once), never a new one while it may still land
  const before = store.get(w);
  if (before !== null && before.creation !== null && before.creation.state === "pending") {
    const out = await relayer.resolve(before.creation, { resend: (await reads.account(w)).kind === "absent" });
    if (out.kind === "unknown") return no("in_flight", [before.creation.tx_hash]);
    store.put({ ...before, creation: { ...before.creation, state: out.kind === "dropped" ? "dropped" : allOk(out) ? "landed" : "failed" } });
  }
  if (p.trade.side !== "buy") return no("no_account"); // a sell's W holds the token: it exists
  if (!(await reads.payoutLanded(w))) return no("no_payout");
  const made = (r: TradeRecord | null) => r !== null && (r.adopted || (r.creation !== null && r.creation.state !== "dropped"));
  const createdAnswer = (r: TradeRecord) => no("wallet_created", r.creation !== null && r.creation.state !== "dropped" ? [r.creation.tx_hash] : undefined);
  if ((await reads.account(w)).kind !== "absent") {
    // made by someone else's Transfer (W's id is public once its payout lands): taken as it is, nothing sent
    const r = store.get(w);
    if (made(r)) return createdAnswer(r!);
    const c = store.create({ ...fresh(w), adopted: true });
    if (!c.created) store.put({ ...c.rec, adopted: true });
    return ok([]);
  }
  const amount = HELPER_BIND_TRADE_CREATE_YOCTO;
  if ((await relayer.balance()) < RELAYER_FLOOR_YOCTO + amount) return no("relayer_low");
  if (await deps.held()) return no("token_halted");

  // One creation per W, ever: W's record, by a create-if-absent before anything is signed. A record that names a
  // Transfer (landed, failed or pending), or a W taken as it was, refuses; one whose Transfer never applied (dropped),
  // or that a carry made, is taken over. Written last, after every read-only check, so a W that is refused leaves no
  // record.
  const claimed = store.create(fresh(w));
  const rec = claimed.rec;
  if (!claimed.created && made(rec)) return createdAnswer(rec);
  let cur = rec;
  const out = await relayer.send<TradeCode>(
    { kind: "transfer", receiver: w, amount },
    async () => {
      // again in the queue, right before the signing: W absent, the gas account above its floor
      if ((await reads.account(w)).kind !== "absent") return "wallet_exists";
      if ((await relayer.balance()) < RELAYER_FLOOR_YOCTO + amount) return "relayer_low";
      return null;
    },
    (tx) => {
      cur = { ...cur, creation: { ...tx, amount: amount.toString(), state: "pending" } };
      store.put(cur);
    },
  );
  if (out.kind === "guarded") return no(out.code);
  if (out.kind === "unknown") return ok([out.tx_hash]); // the device waits for W to read existing
  const state = out.kind === "dropped" ? "dropped" : allOk(out) ? "landed" : "failed";
  store.put({ ...cur, creation: { ...cur.creation!, state } });
  if (state === "landed") return ok([out.tx_hash]);
  return no(state === "failed" ? "carry_failed" : "in_flight", [out.tx_hash]);
}

// ---- 2. The carry ----

type Checked = { raw: Uint8Array; sha: string; maxBlockHeight: bigint };

/**
 * The delegate checks and the kit's nearSwapCheck on every delegate, before any is sent. The first `carried` were sent
 * by this helper already for this trade: they still take every check but the key's nonce and the height window (spent
 * and possibly passed), and the balance is read only for a trade none of whose calls went yet.
 */
async function checkCalls(p: Parsed, deps: TradeDeps, carried = 0): Promise<{ ok: true; calls: Checked[] } | { ok: false; code: TradeCode }> {
  const { reads, cfg } = deps;
  const w = p.trade.wallet;
  const bad = (code: TradeCode) => ({ ok: false as const, code });
  const decoded: (ReturnType<typeof decodeSignedDelegate> & { raw: Uint8Array })[] = [];
  for (const raw of p.raws) {
    try {
      decoded.push({ ...decodeSignedDelegate(raw), raw });
    } catch {
      return bad("bad_shape");
    }
  }
  for (const d of decoded) if (!signatureOk(d)) return bad("bad_signature");
  for (const d of decoded) if (d.sender_id !== w) return bad("bad_sender");
  // W's own id key, the one key a fresh implicit account has
  const pk = idKey(w);
  for (const d of decoded) if (`ed25519:${base58(d.public_key)}` !== pk) return bad("bad_key");
  const key = await reads.accessKey(w, pk);
  if (key.kind === "no_account") return bad("no_account");
  if (key.kind !== "key" || key.permission !== "FullAccess") return bad("bad_key");
  const final = await reads.finalHeight();
  // rising nonces; the first one not carried above the key's nonce, every one under the final height x 10^6
  let last = -1n;
  for (const [i, d] of decoded.entries()) {
    if (d.nonce <= last || (i >= carried && d.nonce <= key.nonce)) return bad("bad_nonce");
    if (d.nonce >= final * NONCE_RANGE_MULTIPLIER) return bad("bad_nonce");
    last = d.nonce;
  }
  for (const d of decoded.slice(carried)) {
    if (d.max_block_height <= final || d.max_block_height - final > EXPIRY_MAX_BLOCKS) return bad("expired");
    if (d.max_block_height - final < cfg.marginK) return bad("resign_needed");
  }
  // the calls as the kit writes them: one FunctionCall each, its args one JSON object
  const calls: NearSwapCall[] = [];
  for (const d of decoded) {
    const a = d.actions[0];
    if (d.actions.length !== 1 || a === undefined || a.kind !== "FunctionCall") return bad("not_one_action");
    let args: unknown;
    try {
      args = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(a.args));
    } catch {
      return bad("bad_shape");
    }
    if (!isObj(args) || a.gas > BigInt(Number.MAX_SAFE_INTEGER)) return bad("bad_shape");
    // args written back as the device's JSON.stringify wrote them, byte for byte: what is checked is what is carried
    if (JSON.stringify(args) !== new TextDecoder().decode(a.args)) return bad("bad_shape");
    calls.push({ sender_id: d.sender_id, receiver_id: d.receiver_id, actions: [{ FunctionCall: { method_name: a.method_name as NearSwapCall["actions"][0]["FunctionCall"]["method_name"], args, gas: Number(a.gas), deposit: a.deposit.toString() } }] });
  }
  const { tokenIn, tokenOut } = tokensOf(p.trade);
  const methods = calls.map((c) => c.actions[0].FunctionCall.method_name);
  const registers = methods.includes("storage_deposit");
  // The landing order is never the helper's to choose. A swap that lands before
  // W's registration on the output token pays into the exchange's account or a lost-found, so a set holding both is
  // refused; W's registrations are the helper's own read, on both providers at one block: a registration is carried
  // only while W reads unregistered (each one's deposit is the gas account's), a swap only once W reads registered on
  // the output token, and on a sell on the input token too.
  if (registers && methods.includes("ft_transfer_call")) return bad("bad_order");
  // a W the vault never paid makes the helper read no token's contract
  if (!(await reads.payoutLanded(w))) return bad("no_payout");
  const [outReg, inReg] = await reads.registered([tokenOut, tokenIn], w);
  if (registers && outReg) return bad("already_registered");
  if (methods.includes("ft_transfer_call") && (!outReg || (p.trade.side === "sell" && !inReg))) return bad("not_registered");
  // the token is one the exchange trades: every hop a Rhea pool holding its two tokens
  if (!(await reads.hopsReal(p.trade.hops.map((h) => ({ pool: h.pool, tokenIn: h.token_in, tokenOut: h.token_out }))))) return bad("token_untrusted");
  const storageMin = registers ? await reads.storageMin(tokenOut) : 0n;
  if (storageMin > TRADE_STORAGE_MAX) return bad("storage_above_cap");
  const { request, quote } = swapInputs(p);
  try {
    // W's registration on the output token as the helper read it, never inferred from the calls
    nearSwapCheck(calls, request, { quote, storageMin, registered: outReg === true });
  } catch (e) {
    if (e instanceof NearSwapRefused) return bad(`swap_${e.code.toLowerCase()}` as TradeCode);
    throw e;
  }
  if (carried === 0 && (await reads.ftBalance(tokenIn, w)) < p.amountIn) return bad("amount_above_balance");
  return { ok: true, calls: decoded.map((d) => ({ raw: d.raw, sha: sha256hex(d.raw), maxBlockHeight: d.max_block_height })) };
}

async function carryCalls(p: Parsed, deps: TradeDeps): Promise<TradeAnswer> {
  const { store, relayer, reads } = deps;
  const w = p.trade.wallet;
  const shas = p.raws.map(sha256hex);
  let rec = store.get(w) ?? fresh(w);
  const live = (x: CarriedEntry) => x.state !== "dropped";

  // 0. Bytes carried before: their transactions answered again, nothing sent; carried for another trade, refused.
  const known = shas.map((s) => rec.carried.find((x) => x.sha256 === s && live(x)));
  if (known.some((x) => x !== undefined && x.trade !== p.tradeId)) return no("replayed");
  if (known.every((x) => x !== undefined && x.state === "landed")) return ok(known.map((x) => x!.tx_hash));

  let decoded: ReturnType<typeof decodeSignedDelegate>[];
  try {
    decoded = p.raws.map((r) => decodeSignedDelegate(r));
  } catch {
    return no("bad_shape");
  }
  const methods = decoded.map((d) => (d.actions[0]?.kind === "FunctionCall" ? d.actions[0].method_name : ""));
  const deposits = decoded.map((d) => (d.actions[0]?.kind === "FunctionCall" ? d.actions[0].deposit : 0n));
  const gases = decoded.map((d) => (d.actions[0]?.kind === "FunctionCall" ? d.actions[0].gas : 0n));

  // One carried delegate at a time per W: one of ours whose outcome is not final on both providers is read again
  // first (a crash between a transaction's signing and its send leaves it pending: read again here, its signed bytes
  // sent again or read dropped), and while it is not known nothing else of W's is accepted.
  for (const x of rec.carried.filter((e) => e.state === "pending" && !shas.includes(e.sha256))) {
    const out = await relayer.resolve(x, { resend: true });
    if (out.kind === "unknown") return no("in_flight", [x.tx_hash]);
    rec = await settled(rec, x.tx_hash, out, deps);
  }

  // The bounds per W: one token, one registration, and per side one swap and one claim, each a call not carried yet.
  if (rec.token !== null && rec.token !== p.trade.token) return no("token_mismatch");
  for (const [i, m] of methods.entries()) {
    if (known[i] !== undefined) continue;
    const same = rec.carried.filter((x) => live(x) && x.method === m && (m === "storage_deposit" || x.side === p.trade.side));
    if (m === "storage_deposit" && same.length > 0) return no("already_registered");
    if (m === "claim_lostfound" && same.length > 0) return no("trade_used");
    if (m === "ft_transfer_call") {
      // a side is used while one swap is on its way, landed, or failed with W's input not back
      if (same.some((x) => !(x.state === "failed" && x.refunded === true))) return no("trade_used");
      if (same.length >= TRADE_SWAP_FAILS_MAX) return no("trade_used");
    }
  }

  // W's running total: what the gas account has paid or may still pay for this payout, never past TRADE_COST_MAX
  const spent = (rec.creation !== null && rec.creation.state !== "dropped" ? TRADE_CREATION_COST : 0n) + rec.carried.filter(live).reduce((a, x) => a + BigInt(x.cost), 0n);
  const adding = methods.reduce((a, _m, i) => (known[i] === undefined ? a + callCost(gases[i]!, deposits[i]!) : a), 0n);
  if (spent + adding > TRADE_COST_MAX) return no("trade_used");

  const need = deposits.reduce((a, d) => a + d, 0n);
  if ((await relayer.balance()) < RELAYER_FLOOR_YOCTO + need) return no("relayer_low");
  if (await deps.held()) return no("token_halted");

  // Every delegate checked before any goes out. A request that finishes a trade (an earlier answer was in_flight)
  // starts with the delegates carried already, which are not checked against the key again: their nonces are spent.
  const first = known.findIndex((x) => x === undefined);
  const carried = first < 0 ? known.length : first;
  if (known.slice(carried).some((x) => x !== undefined)) return no("bad_shape");
  if (carried < known.length) {
    const v = await checkCalls(p, deps, carried);
    if (!v.ok) return no(v.code);
  }

  // W's record, bound to the token its first carried call names (its calls are signed by W: nobody else can bind it)
  rec = store.create(rec).rec;
  if (rec.token === null) {
    rec = { ...rec, token: p.trade.token };
    store.put(rec);
  } else if (rec.token !== p.trade.token) return no("token_mismatch");
  const { tokenIn } = tokensOf(p.trade);
  const hashes: string[] = [];
  for (let i = 0; i < p.raws.length; i++) {
    const raw = p.raws[i]!;
    const sha = shas[i]!;
    const was = rec.carried.find((x) => x.sha256 === sha && live(x));
    if (was !== undefined) {
      if (was.state === "landed") {
        hashes.push(was.tx_hash);
        continue;
      }
      if (was.state === "failed") return no("carry_failed", [...hashes, was.tx_hash]);
      // pending: read again by its hash, its bytes sent again (one signed nonce lands at most once)
      const out = await relayer.resolve(was, { resend: true });
      if (out.kind === "unknown") return no("in_flight", [...hashes, was.tx_hash]);
      rec = await settled(rec, was.tx_hash, out, deps);
      const state = rec.carried.find((x) => x.tx_hash === was.tx_hash)!.state;
      if (state === "landed") {
        hashes.push(was.tx_hash);
        continue;
      }
      if (state === "failed") return no("carry_failed", [...hashes, was.tx_hash]);
      // dropped: never applied, so it goes again below, signed afresh
    }
    const mbh = decoded[i]!.max_block_height;
    const deposit = deposits[i]!;
    const out = await relayer.send<TradeCode>(
      { kind: "delegate", signed: raw, receiver: w },
      async () => {
        // again in the queue, right before the signing: the gas account above its floor with the call's deposit (the
        // relayer pays it), the token watch open, and the delegate's window still K blocks ahead of the newest final
        if ((await relayer.balance()) < RELAYER_FLOOR_YOCTO + deposit) return "relayer_low";
        if (await deps.held()) return "token_halted";
        if (mbh - (await reads.newestFinalHeight()) < deps.cfg.marginK) return "resign_needed";
        return null;
      },
      (tx) => {
        // the call is W's from here: its side is taken once its transaction is signed for sending, never before
        rec = { ...rec, carried: [...rec.carried, { ...tx, sha256: sha, trade: p.tradeId, side: p.trade.side, method: methods[i]!, cost: callCost(gases[i]!, deposit).toString(), deposit: deposit.toString(), token_in: tokenIn, amount_in: p.amountIn.toString(), state: "pending" }] };
        store.put(rec);
      },
    );
    if (out.kind === "guarded") return no(out.code, hashes);
    if (out.kind === "unknown") return no("in_flight", [...hashes, out.tx_hash]);
    rec = await settled(rec, out.tx_hash, out, deps);
    const state = rec.carried.find((x) => x.tx_hash === out.tx_hash)!.state;
    if (state === "landed") {
      hashes.push(out.tx_hash);
      continue;
    }
    return no(state === "failed" ? "carry_failed" : "in_flight", [...hashes, out.tx_hash]);
  }
  return ok(hashes);
}

/**
 * The record with one carried transaction's final outcome written: landed, failed or dropped. A swap that failed is
 * read for its input on W (both providers at one block): back in full, its side is free again.
 */
async function settled(rec: TradeRecord, txHash: string, out: Exclude<TxOutcome, { kind: "unknown" }>, deps: TradeDeps): Promise<TradeRecord> {
  const state: CarriedEntry["state"] = out.kind === "dropped" ? "dropped" : allOk(out) ? "landed" : "failed";
  const x = rec.carried.find((e) => e.tx_hash === txHash)!;
  const refunded = state === "failed" && x.method === "ft_transfer_call" ? (await deps.reads.ftBalance(x.token_in, rec.w)) >= BigInt(x.amount_in) : undefined;
  // final on both providers: its cost is what it really cost the gas account, the tokens its transaction and receipts
  // burnt (both providers reading the same) and its deposit (a failed call's deposit goes back to W, never to us);
  // without that read it stays at its worst
  const cost = out.kind === "final" && out.burnt !== undefined ? (out.burnt + BigInt(x.deposit)).toString() : x.cost;
  const next = { ...rec, carried: rec.carried.map((e) => (e.tx_hash === txHash ? { ...e, state, cost, ...(refunded !== undefined && { refunded }) } : e)) };
  deps.store.put(next);
  return next;
}

// ---- The store ----

/** W's records: one directory of small JSON files owned by one process (store/durable.ts). */
export function createTradeStore(dir: string, fs: StoreFs = nodeFs): TradeStore {
  return openDurableDir(dir, fs, (d) => {
    const name = (w: string) => {
      if (!IMPLICIT.test(w)) throw new Error("store: W is not a 64-hex id");
      return `t-${w}.json`;
    };
    const read = (w: string): TradeRecord | null => {
      const t = d.text(name(w));
      return t === null ? null : (JSON.parse(t) as TradeRecord);
    };
    return {
      get: read,
      create(rec) {
        d.held();
        if (d.createOnce(name(rec.w), JSON.stringify(rec))) return { created: true, rec };
        return { created: false, rec: read(rec.w)! };
      },
      put(rec) {
        d.held();
        d.replace(name(rec.w), JSON.stringify(rec));
      },
      close: d.close,
    };
  });
}

// The kit's two caps are one number: the wire's and N3's.
if (TRADE_STORAGE_MAX !== NEAR_SWAP_STORAGE_MAX) throw new Error("HELPER_BIND_TRADE_STORAGE_MAX is not the kit's NEAR_SWAP_STORAGE_MAX");

// ---- The reads, on two providers ----

const SPENDS_PAGE = 100;

/**
 * The trade's reads on the network's two providers, each at one agreed final block, equal on both (withdraw/fee.ts
 * agreedBlock and viewAt; the key and the finals as the deposit carry reads them, send.ts createSendReads). The vault
 * payout to W: the vault's spends list, paged whole on both providers (near/pages.ts pagesAt) and indexed by
 * recipient as read; a row counts once it reads paid, or settled with refund_value 0 (withdraw/send.ts: a bounced
 * payout is refund_pending, then settled with its amount as refund_value), which never changes after.
 */
export function createTradeReads(rpcs: readonly [Rpc, Rpc], vault: string, usdc: string, now: () => number = Date.now, exchange: string = NEAR_RHEA.mainnet.exchange): TradeReads & RecordReads {
  const send = createSendReads(rpcs, { vault, token: usdc });
  const at = () => agreedBlock(rpcs, now);
  const byRecipient = new Map<string, number[]>();
  const delivered = new Set<number>();
  let next = 0;
  let indexing: Promise<unknown> = Promise.resolve();
  /** The rows read at `b` past the cursor, by index (read once there, so not read again at `b`). */
  const catchUp = async (b: Block, rows: Map<number, Record<string, unknown>>) => {
    for (;;) {
      const from = next;
      const page = await pagesAt(rpcs, vault, "spends", b.height, from, SPENDS_PAGE);
      page.forEach((row, i) => {
        if (typeof row.recipient !== "string") throw new Error("spends: a row with no recipient");
        byRecipient.set(row.recipient, [...(byRecipient.get(row.recipient) ?? []), from + i]);
        rows.set(from + i, row);
      });
      next = from + page.length;
      if (page.length < SPENDS_PAGE) return;
    }
  };
  const landed = (row: Record<string, unknown>) => row.status === "paid" || (row.status === "settled" && row.refund_value === "0");
  return {
    finalHeight: send.finalHeight,
    newestFinalHeight: send.newestFinalHeight,
    accessKey: send.accessKey,
    async account(id) {
      return (await accountAt(rpcs, await at(), id)).kind === "absent" ? { kind: "absent" } : { kind: "account" };
    },
    async ftBalance(token, account) {
      const v = u128(await viewAt(rpcs, await at(), token, "ft_balance_of", { account_id: account }));
      if (v === null) throw new Error("ft_balance_of: not a u128 decimal");
      return v;
    },
    async storageMin(token) {
      const b = await viewAt(rpcs, await at(), token, "storage_balance_bounds", {});
      const min = isObj(b) ? u128(b.min) : null;
      if (min === null) throw new Error("storage_balance_bounds: no u128 min");
      return min;
    },
    async registered(tokens, account) {
      const b = await at();
      return Promise.all(
        tokens.map(async (token) => {
          const s = await viewAt(rpcs, b, token, "storage_balance_of", { account_id: account });
          if (s !== null && !isObj(s)) throw new Error("storage_balance_of: neither null nor a balance");
          return s !== null;
        }),
      );
    },
    async hopsReal(hops) {
      const b = await at();
      // a pool id past the exchange's count is none (get_pool panics there, which is no answer)
      const count = await viewAt(rpcs, b, exchange, "get_number_of_pools", {});
      if (typeof count !== "number" || !Number.isSafeInteger(count)) throw new Error("get_number_of_pools: not a count");
      for (const h of hops) {
        if (h.pool >= count) return false;
        const pool = await viewAt(rpcs, b, exchange, "get_pool", { pool_id: h.pool });
        const ids = isObj(pool) && Array.isArray(pool.token_account_ids) ? pool.token_account_ids : null;
        if (ids === null || !ids.includes(h.tokenIn) || !ids.includes(h.tokenOut) || h.tokenIn === h.tokenOut) return false;
      }
      return true;
    },
    async payoutLanded(wallet) {
      const b = await at();
      const fresh = new Map<number, Record<string, unknown>>();
      // one index read at a time (send.ts createSendReads: two at once would skip rows)
      const run = indexing.then(() => catchUp(b, fresh));
      indexing = run.catch(() => undefined);
      await run;
      for (const i of byRecipient.get(wallet) ?? []) {
        if (delivered.has(i)) return true;
        // a row read before this block is read again at it: its status may have moved since
        const row = fresh.get(i) ?? (await pagesAt(rpcs, vault, "spends", b.height, i, 1))[0];
        if (row === undefined || row.recipient !== wallet) throw new Error("spends: the row is not this recipient's");
        if (landed(row)) {
          delivered.add(i);
          return true;
        }
      }
      return false;
    },
    async payoutsLanded(wallets) {
      const b = await at();
      const fresh = new Map<number, Record<string, unknown>>();
      const run = indexing.then(() => catchUp(b, fresh));
      indexing = run.catch(() => undefined);
      await run;
      // a row indexed at an earlier block and not landed then is read again at b with its whole page of SPENDS_PAGE
      // rows, each page once: a page names no one row, so no read singles out a wallet's row
      const pages = new Set<number>();
      for (const w of wallets) for (const i of byRecipient.get(w) ?? []) if (!delivered.has(i) && !fresh.has(i)) pages.add(i - (i % SPENDS_PAGE));
      for (const from of pages) (await pagesAt(rpcs, vault, "spends", b.height, from, SPENDS_PAGE)).forEach((row, k) => fresh.set(from + k, row));
      return wallets.map((w) =>
        (byRecipient.get(w) ?? []).some((i) => {
          if (delivered.has(i)) return true;
          const row = fresh.get(i);
          if (row === undefined || row.recipient !== w) throw new Error("spends: the row is not this recipient's");
          if (!landed(row)) return false;
          delivered.add(i);
          return true;
        }),
      );
    },
  };
}
