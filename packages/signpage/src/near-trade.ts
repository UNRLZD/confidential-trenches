// The device's NEAR private buy (card near-private-trading): the vault pays the buy's USDC to a fresh NEAR wallet W,
// the helper creates W, W registers on the token it buys, then W swaps on Rhea classic. Every part is injected (deps),
// so this module holds no key, no seed and no address of its own; the page binds them (near-buy.ts, wired by
// pool-kinds.ts).
//
// The buy's record comes first (deps.begin): W = W_{near,l,j} of the vault note the payout spends, and the record names
// that note, W, the token and the amount, written before the payout is asked. An unfinished record of the same token is
// taken instead of a new one, so a buy that stopped (a reload, a crash, a closed tab) goes on from its own W and its own
// note: the vault spends a note once, so nothing is paid out twice.
//
// The steps, in order, each logged once through deps.log with its outcome and written to the record (step, stage, code,
// cause: deps.progress):
//   1. payout: the vault pays the record's amount of USDC to W from the record's note (deps.payout: the first ask, or
//      the same note's payout followed). Anything but landed, before any helper call: the run's answer is that code
//      ("payout_<kind>"), and the money is in the vault. Unknown (it threw): answered sent with no transaction, the
//      record left for the next load to follow.
//   2. create: W read first (a W that exists, made by the helper or by anyone's transfer, is not created again); else a
//      quote (the helper's trade kind needs the trade even for the creation) and POST /v1/bind with no delegates;
//      wallet_created and wallet_exists go on to the reads (W's read requires its key list to be its own key alone).
//   3. register: W's light read (deps.held: what it holds and its registration); not registered on the token: a fresh
//      pair (below), the registration alone signed from it and sent, then W's light read again until it reads
//      registered (bounded). Registered already: skipped.
//   4. swap: a swap that left before (the record says so) and USDC no longer on W goes straight to 5. Else a fresh pair
//      with the baseline (what W holds of the token, read at the pair's block), the swap round signed from that pair
//      and sent. The floor and the baseline go to the record before the swap is sent. A swap the relayer
//      answers carry_failed (it failed on chain) is signed again in the same run while W reads its USDC back in full and
//      none of the token past the baseline: a fresh pair whose W read has W's nonce at or past the failed swap's (so no
//      signed bytes go twice), its own floor from the new quote and the user's slippage, up to NEAR_BUY_SWAP_ROUNDS
//      rounds; past that the run ends carry_failed, the USDC on W, and the sell's load pass sends it home.
//   5. receive: W read until what it received (the token held less the baseline) reaches the floor as it reaches W (the
//      exchange's minimum less the token's own buy fee). Only then "filled". A run that ends here with W holding some of
//      the token still writes what it received (fill) to the record, so W is a position whatever code it ended with.
// Once the payout has landed the answer is never an error: the app would read it as nothing moved and offer a retry.
// It is { stage: "sent", txs } with every transaction so far (the payout first), and the code and its cause go to the
// log and the record; "filled" comes only from the device's own read of what W received.
// Fresh (deps.pair, card near-quote-under-the-pace: one final height read on both providers at one moment, then W, the
// quote and the baseline all read at that block; the kit's readNearSwapPair): what is signed is from one block, and
// the signer's age check (W read at or before the quote, at most NEAR_SWAP_READ_AGE_MAX blocks) still holds it. The
// pair is asked again, bounded, when a read throws (a lag between the providers, a busy one) or the two are apart.
// A light read (deps.held) is what a step waits on: what W holds and its registration, never what is signed.
// The helper: the same body is sent again, bounded, while its answer is a "not yet" (in_flight, no_payout, upstream) or
// no answer at all; the same signed bytes can land only once (W's nonce), and the creation is the helper's once per W.
// relayer_low is not asked again. A refusal not in the trade kind's codes is not_known. No answer is ever a "not now"
// code (api.ts RETRY_CODES): the same request runs again on it.
import { HELPER_BIND_TRADE_CODES, type HelperBindTradeRequest, type HelperNearTrade } from "../../kit/src/helper/v1.ts";
import { NEAR_NETWORKS, type NearNetwork } from "../../kit/src/near/networks.ts";
import type { RheaQuote, RheaQuoteArgs } from "../../kit/src/near/rhea.ts";
import { nearFeeBuyerReceives } from "../../kit/src/near/token-fee.ts";
import { NEAR_SWAP_SLIPPAGE_MAX_BPS, nearSwapCalls, nearSwapFloor, type NearSwapCall, type NearSwapRequest } from "../../kit/src/trade/near/swap.ts";
import type { NearSwapWalletArgs, NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import type { BuyRoute, SignpageResults, TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { NEAR_SWAP_READ_AGE_MAX, type SignedNearSwapDelegate } from "../../wallet/src/near/swap-delegate.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";
import { SIGNPAGE_ROUTE_OUT } from "../../kit/src/signpage/schema.ts";
import { unitsOf } from "./pool-buy.ts";
import { legCause } from "./pool-sell.ts";

/** The most reads of W in one wait (W to read existing, its registration to read back, the swap's result), and the most
 *  tries of one fresh pair (W's read and the quote). */
export const NEAR_BUY_READ_TRIES = 10;
/** Between two of those reads: about two NEAR blocks past final. */
export const NEAR_BUY_READ_WAIT_MS = 1_000;
/** The most times one body goes to the helper (its first send included) while the answer is a "not yet" or none. */
export const NEAR_BUY_SENDS = 4;
/** Between two of those sends. */
export const NEAR_BUY_SEND_WAIT_MS = 3_000;
/** The most swap rounds one run sends: the relayer's TRADE_SWAP_FAILS_MAX (apps/helper/src/bind/trade.ts), the swaps of a
 *  side that may fail on chain with the input back on W (near-trade-relayer.test.ts holds the two equal). */
export const NEAR_BUY_SWAP_ROUNDS = 3;

export type NearBuyAsk = { token: string; amount: bigint; slippageBps: number };
export type NearBuyStep = "payout" | "quote" | "create" | "register" | "swap" | "receive";
/** The vault's payout to W as its hand-off ends: landed (with its transaction when the relayer named one), or another
 *  outcome's kind. */
export type NearPayoutEnd = { kind: "landed"; tx: string | null } | { kind: string; tx?: undefined };
/** The helper's answer to POST /v1/bind's trade kind: its transactions, also with a refusal that carried some. */
export type NearHelperAnswer = { ok: true; tx_hashes: string[] } | { ok: false; code: string; tx_hashes?: string[] };
/** The run's answer (a plain object: a HostAnswer has a `then`, so it is never what a promise resolves to). */
export type NearBuyAnswer = { result: SignpageResults["pool.buy"] } | { error: string };
type Awaitable<T> = T | Promise<T>;

/** One buy as its record holds it: the ask it runs (an unfinished record's own, not a later ask's), W and what the
 *  record says has happened already. */
export type NearBuyBegun = {
  ask: NearBuyAsk;
  w: { id: string; l: bigint; j: number };
  /** The transactions so far (the payout's first). */
  txs: TxRef[];
  /** The swap round was sent once: its floor and the baseline it is measured from. */
  swap?: { floor: bigint; before: bigint };
};
/** What the run writes to the buy's record at each step's end (merged; nothing secret: no key, no signed bytes). */
export type NearBuyProgress = {
  step: NearBuyStep;
  /** "pending" until the payout lands (no stage the app reads yet), then sent, filled or refused. */
  stage: TradeStage | "pending";
  txs: TxRef[];
  code?: string;
  /** legCause's shape (pool-sell.ts): the error's name, its code and two frames, never its text. */
  cause?: string;
  swap?: { floor: string; before: string };
  /** What W received of the token (base units) and the token's decimals, read at the buy's end. */
  fill?: { out: string; decimals: number };
};

/** What one pair read asks: the side, the token and the amount quoted, and the token whose balance of W's is the baseline. */
export type NearPairAsk = Pick<RheaQuoteArgs, "side" | "token" | "amountIn"> & { wallet: string; baseline?: string };
/** W and the quote at one block (the kit's NearSwapPair). */
export type NearPair = { state: NearSwapWalletState; quote: RheaQuote; baseline?: bigint };
/** W's light read: the fields of NearSwapWalletState the waits read. */
export type NearHeldState = Pick<NearSwapWalletState, "account" | "height" | "held" | "registered">;

export type NearBuyDeps = {
  /** The page's network (one per build). */
  network: NearNetwork;
  /** The buy's record: an unfinished one of the ask's token, or a new one written now (its note picked, W derived from
   *  it); null: no note covers the ask (refused not_allowed, nothing written). */
  begin(ask: NearBuyAsk): Promise<NearBuyBegun | null>;
  /** The record's step written (awaited: a record that cannot be written stops nothing that already left). */
  progress(p: NearBuyProgress): Promise<void>;
  /** The vault's payout of the record's amount to W from the record's note, or that payout followed when it was asked. */
  payout(): Promise<NearPayoutEnd>;
  helper(body: HelperBindTradeRequest): Promise<NearHelperAnswer>;
  /** The kit's readNearSwapWallet with the network and its pair bound. */
  readWallet(a: Pick<NearSwapWalletArgs, "wallet" | "side" | "token">): Promise<NearSwapWalletState>;
  /** The kit's rheaQuote with the network, its pair and the candidate pools bound. */
  quote(a: Pick<RheaQuoteArgs, "side" | "token" | "amountIn">): Promise<RheaQuote>;
  /** The kit's readNearSwapPair with the network, its pair and the candidate pools bound: W read and the quote at one
   *  block (`baseline`: W's balance of that token at the same block). */
  pair(a: NearPairAsk): Promise<NearPair>;
  /** W's light read (the kit's readNearHeld: what W holds of the token it sends and whether it is registered on the one
   *  it receives, at one block on both providers), for the waits that only ask "has it arrived"; absent: readWallet. */
  held?(a: Pick<NearSwapWalletArgs, "wallet" | "side" | "token">): Promise<NearHeldState>;
  /** The wallet's signNearSwapDelegates with the seed and W's indexes bound (the binding derives W from them, the same
   *  W as `w.id`). */
  sign(given: readonly NearSwapCall[], request: NearSwapRequest, quote: RheaQuote, state: NearSwapWalletState, bound: string | null): Awaitable<SignedNearSwapDelegate[]>;
  wait(ms: number): Promise<void>;
  /** One line per step: the step and its outcome, in short public words (no key, no amount, no address). */
  log(step: NearBuyStep, outcome: string): void;
  /** One fact of the buy's route for the app (ctx.route: W, the venue and its pool, the amount W received), as the
   *  Solana pool buy tells them; never one the run did not bind or read itself. */
  route?(r: BuyRoute): void;
  /** The token's decimals, read on both providers (ft_metadata), for the amount W received. */
  decimals?(token: string): Promise<number>;
};

const IMPLICIT = /^[0-9a-f]{64}$/;
/** The page's own copy of the kit's route bound (a kit RegExp is read through a copy, never tested against directly). */
const ROUTE_OUT = new RegExp(SIGNPAGE_ROUTE_OUT.source, SIGNPAGE_ROUTE_OUT.flags);
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const OUTCOME = /^[a-z][a-z_]{0,31}$/;
const TRADE_CODES: ReadonlySet<string> = new Set(HELPER_BIND_TRADE_CODES);
/** The helper's "not yet": the same body again. upstream: its provider read failed or disagreed. */
const AGAIN: ReadonlySet<string> = new Set(["in_flight", "no_payout", "upstream"]);

/** A step that failed: its code, and its cause when an error was thrown. */
class Stop extends Error {
  readonly code: string;
  readonly cause_?: string;
  constructor(code: string, cause?: string) {
    super(code);
    this.code = code;
    if (cause !== undefined) this.cause_ = cause;
  }
}

/** The pool.buy kind's run for a NEAR token: one run per call, answered at its end. */
export function nearBuyFlow(deps: NearBuyDeps): (ask: NearBuyAsk, ctx: KindContext) => Running<"pool.buy"> | HostRefusal {
  return (ask, _ctx) => {
    if (!askOk(deps.network, ask)) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.buy"> | HostRefusal | null = null;
    const after = runNearBuy(deps, ask).then(
      (a) => void (answer = a),
      () => void (answer = { error: "failed" }),
    );
    return { running: true, after, answer: () => answer ?? { error: "failed" } };
  };
}

function askOk(network: NearNetwork, ask: NearBuyAsk): boolean {
  return (
    typeof ask.token === "string" &&
    ask.token !== "" &&
    ask.token !== NEAR_NETWORKS[network].usdc &&
    typeof ask.amount === "bigint" &&
    ask.amount > 0n &&
    Number.isSafeInteger(ask.slippageBps) &&
    ask.slippageBps >= 1 &&
    ask.slippageBps <= NEAR_SWAP_SLIPPAGE_MAX_BPS
  );
}

/** One buy's run, from its record's start or where its record left it (a resume calls this with the same deps). */
export async function runNearBuy(deps: NearBuyDeps, asked: NearBuyAsk): Promise<NearBuyAnswer> {
  let begun: NearBuyBegun | null;
  try {
    begun = await deps.begin(asked);
  } catch (e) {
    deps.log("payout", "not_begun");
    console.warn(`near buy not begun: ${legCause(e)}`);
    return { error: "failed" };
  }
  if (begun === null) return { error: "not_allowed" };
  const { ask, w } = begun;
  // only an implicit id of 64 hex is W: the one guard before money moves, as the record names it
  if (typeof w.id !== "string" || !IMPLICIT.test(w.id) || !askOk(deps.network, ask)) return { error: "not_allowed" };
  const txs: TxRef[] = begun.txs.map((t) => ({ chain: t.chain, hash: t.hash }));
  const near = (hashes: readonly string[]) => {
    for (const hash of hashes) if (!txs.some((t) => t.hash === hash)) txs.push({ chain: "near", hash });
  };
  const request: NearSwapRequest = { network: deps.network, side: "buy", token: ask.token, amountIn: ask.amount, wallet: w.id, slippageBps: ask.slippageBps };
  let paid = false;
  let step: NearBuyStep = "payout";
  let swap = begun.swap;
  const progress = async (p: Omit<NearBuyProgress, "step" | "txs">): Promise<void> => {
    try {
      await deps.progress({ step, txs: txs.map((t) => ({ ...t })), ...p });
    } catch (e) {
      console.warn(`near buy record not written at ${step}: ${legCause(e)}`);
    }
  };
  // a route fact for the app: the app's display never stops a buy
  const tell = (r: BuyRoute): void => {
    try {
      deps.route?.(r);
    } catch {
      /* not told */
    }
  };
  tell({ wallet: w.id });
  // a step's end: logged, and the run's end with its code
  const fail = (code: string, e?: unknown): never => {
    deps.log(step, code);
    throw new Stop(code, e === undefined ? undefined : legCause(e));
  };

  try {
    // 1. the vault's payout to W, from the record's note
    let end: NearPayoutEnd;
    try {
      end = await deps.payout();
    } catch (e) {
      // the payout may have left: answered sent, nothing more run, the record left for the next load to follow
      deps.log("payout", "not_known");
      await progress({ stage: "sent", code: "not_known", cause: legCause(e) });
      return { result: { stage: "sent", txs } };
    }
    if (end.kind !== "landed") {
      const code = OUTCOME.test(end.kind) ? `payout_${end.kind}` : "payout_failed";
      deps.log("payout", code);
      await progress({ stage: "refused", code });
      return { error: code };
    }
    if (typeof end.tx === "string" && TX_HASH.test(end.tx)) near([end.tx]);
    paid = true;
    deps.log("payout", "payout landed");
    await progress({ stage: "sent" });

    // W's light read on both providers (what it holds and its registration: nothing signed is taken from it), asked
    // again (reads only) until `done` holds, at most NEAR_BUY_READ_TRIES times
    const light = (side: "buy" | "sell"): Promise<NearHeldState> => (deps.held ? deps.held({ wallet: w.id, side, token: ask.token }) : deps.readWallet({ wallet: w.id, side, token: ask.token }));
    const readUntil = async (side: "buy" | "sell", done: (s: NearHeldState) => boolean, missed: string): Promise<NearHeldState> => {
      let last: NearHeldState | null = null;
      let thrown: unknown;
      for (let i = 0; i < NEAR_BUY_READ_TRIES; i++) {
        if (i > 0) await deps.wait(NEAR_BUY_READ_WAIT_MS);
        let s: NearHeldState;
        try {
          s = await light(side);
        } catch (e) {
          thrown = e;
          continue;
        }
        // a read of another account is no read of W's: the run ends, never asked again
        if (s.account !== w.id) return fail("read_failed");
        last = s;
        if (done(s)) return s;
      }
      return last === null ? fail("read_failed", thrown) : fail(missed);
    };
    // W (buy side) and a quote of the request's own at ONE block (deps.pair); asked again, bounded, when it throws (a
    // provider lagging or busy) or W's read does not yet show what `want` waits for. `baseline`: the token's balance of W's
    // at the same block
    const fresh = async (want: (s: NearSwapWalletState) => boolean, baseline?: string): Promise<{ s: NearSwapWalletState; q: RheaQuote; base?: bigint }> => {
      let thrown: unknown;
      for (let i = 0; i < NEAR_BUY_READ_TRIES; i++) {
        if (i > 0) await deps.wait(NEAR_BUY_READ_WAIT_MS);
        let s: NearSwapWalletState;
        let q: RheaQuote;
        let base: bigint | undefined;
        try {
          ({ state: s, quote: q, baseline: base } = await deps.pair({ side: "buy", token: ask.token, amountIn: ask.amount, wallet: w.id, ...(baseline === undefined ? {} : { baseline }) }));
        } catch (e) {
          thrown = e;
          continue;
        }
        if (s.account !== w.id) return fail("read_failed");
        // a provider that has not caught up with the registration: both read again
        if (!want(s)) continue;
        if (q.network !== deps.network || q.side !== "buy" || q.token !== ask.token || q.amountIn !== ask.amount) return fail("quote_check_failed");
        if (baseline !== undefined && typeof base !== "bigint") return fail("read_failed");
        // one moment: the quote at or after W's state and close to it (one block from deps.pair), else both read again
        if (!(Number.isSafeInteger(q.height) && q.height >= s.height && q.height - s.height <= NEAR_SWAP_READ_AGE_MAX)) continue;
        deps.log("quote", "quote");
        return { s, q, ...(base === undefined ? {} : { base }) };
      }
      return fail("quote_check_failed", thrown);
    };
    const tradeOf = (q: RheaQuote): HelperNearTrade => ({
      network: deps.network,
      side: "buy",
      token: ask.token,
      wallet: w.id,
      amount_in: ask.amount.toString(),
      slippage_bps: ask.slippageBps,
      venue_out: q.venueOut.toString(),
      hops: q.hops.map((h) => ({ pool: h.pool, token_in: h.tokenIn, token_out: h.tokenOut })),
    });
    // one body to the helper, sent again (bounded) while its answer is a "not yet" or none; `goOn`: codes after which the
    // run reads on instead of ending. Its transactions kept, a refusal's too.
    // counts: the numbers of tx hashes a 200 may carry (the creation: 1, or none for a W the helper adopts as it is)
    const send = async (body: HelperBindTradeRequest, counts: readonly number[], goOn: ReadonlySet<string>): Promise<string | null> => {
      let last = "not_known";
      let thrown: unknown;
      for (let i = 0; i < NEAR_BUY_SENDS; i++) {
        if (i > 0) await deps.wait(NEAR_BUY_SEND_WAIT_MS);
        let a: NearHelperAnswer;
        try {
          a = await deps.helper(body);
        } catch (e) {
          thrown = e;
          last = "not_known";
          continue;
        }
        const hashes = (a as { tx_hashes?: unknown }).tx_hashes;
        const ok = Array.isArray(hashes) && hashes.every((h) => typeof h === "string" && TX_HASH.test(h));
        if (a.ok === true) {
          if (!ok || !counts.includes((hashes as string[]).length)) return fail("not_known");
          near(hashes as string[]);
          return null;
        }
        if (ok) near(hashes as string[]);
        const code = typeof a.code === "string" && (TRADE_CODES.has(a.code) || AGAIN.has(a.code)) ? a.code : "not_known";
        if (goOn.has(code)) return code;
        if (!AGAIN.has(code)) return fail(code);
        last = code;
        thrown = undefined;
      }
      if (goOn.has(last)) return last;
      return fail(last, thrown);
    };
    // W's calls signed for a fresh pair (W read, then the quote): the body the caller sends, the pair's quote and the
    // first call's nonce; null for a registration round whose fresh read finds W registered already (a provider that
    // caught up): nothing to sign. `spent`: a nonce W's key holds already (a failed swap's), read again until it does
    // `baseline`: the token read at the pair's block (the swap's first round). Never signed for a W short of the amount.
    const signedRound = async (registered: boolean, spent = -1n, baseline?: string): Promise<{ q: RheaQuote; s: NearSwapWalletState; base?: bigint; body: HelperBindTradeRequest; count: number; nonce: bigint } | null> => {
      const { s, q, base } = await fresh((x) => (!registered || x.registered) && x.nonce >= spent, baseline);
      if (!registered && s.registered) return null;
      // the payout's USDC is W's in full (the vault takes its fee from the note on top of the amount): less is not swapped
      if (registered && s.held < ask.amount) return fail("not_funded");
      let calls: NearSwapCall[];
      let signed: SignedNearSwapDelegate[];
      try {
        calls = nearSwapCalls({ quote: q, wallet: w.id, slippageBps: ask.slippageBps, registered, storageMin: s.storageMin, lostfound: s.lostfound }, request);
      } catch (e) {
        return fail("quote_check_failed", e);
      }
      try {
        // bound: the token this W's record names (one W, one token)
        signed = await deps.sign(calls, request, q, s, ask.token);
      } catch (e) {
        return fail("not_signed", e);
      }
      if (!Array.isArray(signed) || signed.length !== calls.length || typeof signed[0]?.nonce !== "bigint") fail("not_signed");
      return { q, s, ...(base === undefined ? {} : { base }), body: { trade: tradeOf(q), signed_delegates: signed.map((d) => d.signed_delegate) }, count: calls.length, nonce: signed[0]!.nonce };
    };
    // after a swap that failed on chain: W read (both sides, reads only, bounded) until its USDC is back in full (true),
    // or it holds the token past the baseline (false: the swap landed, what W received decides); unread: false
    const inputBack = async (before: bigint): Promise<boolean> => {
      for (let i = 0; i < NEAR_BUY_READ_TRIES; i++) {
        if (i > 0) await deps.wait(NEAR_BUY_READ_WAIT_MS);
        let u: NearHeldState;
        let t: NearHeldState;
        try {
          u = await light("buy");
          t = await light("sell");
        } catch {
          continue;
        }
        if (u.account !== w.id || t.account !== w.id) return fail("read_failed");
        if (t.held > before) return false;
        if (u.held >= ask.amount) return true;
      }
      return false;
    };

    // 2. W created by the helper, unless it reads existing already (a resume, or anyone's transfer to W)
    step = "create";
    let exists = true;
    try {
      await deps.readWallet({ wallet: w.id, side: "buy", token: ask.token });
    } catch {
      exists = false;
    }
    if (!exists) {
      const { q } = await quoteOnly(deps, ask, fail);
      // a W the helper finds there already answers 200 with no tx: W is there as it is, and the reads go on
      const code = await send({ trade: tradeOf(q), signed_delegates: [] }, [0, 1], new Set(["wallet_created", "wallet_exists"]));
      deps.log("create", code ?? "wallet created");
    } else deps.log("create", "wallet exists");
    await progress({ stage: "sent" });

    // 3. W's registration on the token, as its own round: W's light read decides; not registered, the round is signed
    // from its own pair (a pair that reads W registered after all signs nothing), then read back
    step = "register";
    // what W holds of USDC, from the last read of W
    let usdc: bigint;
    const first = await readUntil("buy", () => true, "read_failed");
    if (!first.registered) {
      // a second registration of one W is refused by the helper: the read decides after it
      const r = await signedRound(false);
      // a second registration (this W's carried before, or W reads registered) is already_registered: the read decides
      if (r !== null) await send(r.body, [r.count], new Set(["replayed", "trade_used", "already_registered"]));
      usdc = (await readUntil("buy", (x) => x.registered, "not_registered")).held;
      deps.log("register", "registered");
    } else {
      usdc = first.held;
      deps.log("register", "already registered");
    }
    await progress({ stage: "sent" });

    // 4. the swap on a fresh pair, unless one that left before took W's USDC already
    step = "swap";
    if (swap === undefined || usdc >= ask.amount) {
      if (usdc < ask.amount) fail("not_funded");
      // the baseline of the token W holds: read at the first round's pair block
      let before: bigint | null = null;
      // the nonce of the last swap that failed on chain (W's key holds it): the next round's read must reach it
      let spent = -1n;
      for (let round = 1; ; round++) {
        const r = await signedRound(true, spent, before === null ? ask.token : undefined);
        if (r === null) return fail("not_registered"); // a swap round is signed only once W reads registered
        if (before === null) before = r.base!;
        // the venue and the pool the device checked and signs against (its first hop)
        const hop = r.q.hops[0];
        if (hop !== undefined) tell({ venue: "Rhea", pool: String(hop.pool) });
        // the floor of the pair the round signs and the baseline, in the record before the swap leaves: a stop after the
        // send finds them, and a resume reads what W received against them
        swap = { floor: nearFeeBuyerReceives(r.q.fee, r.q.exchange, nearSwapFloor(r.q.venueOut, ask.slippageBps)), before };
        // the one write a send waits on: a swap whose floor is not on the record is never sent (a stop before the next
        // write would leave a coin no floor counts), so nothing leaves and W's USDC goes home by the load's way home
        try {
          await deps.progress({ step, txs: txs.map((t) => ({ ...t })), stage: "sent", swap: { floor: swap.floor.toString(), before: swap.before.toString() } });
        } catch (e) {
          return fail("record_not_written", e);
        }
        const sent = await send(r.body, [r.count], new Set(["replayed", "carry_failed"]));
        if (sent !== "carry_failed") {
          deps.log("swap", sent ?? "swapped");
          break;
        }
        // failed on chain: signed again only with W's USDC back in full, up to the relayer's bound; a swap that landed
        // after all (the token on W) goes to what W received
        if (!(await inputBack(before))) {
          deps.log("swap", "carry_failed, the token on W");
          break;
        }
        if (round >= NEAR_BUY_SWAP_ROUNDS) return fail("carry_failed");
        deps.log("swap", "carry_failed, signed again");
        spent = r.nonce;
      }
      await progress({ stage: "sent" });
    } else deps.log("swap", "swap sent before");

    // 5. what W received, against the floor as it reaches W: read again (reads only) while a provider has not caught up
    step = "receive";
    const got = swap;
    // what W received (base units) at the token's decimals read on both providers; unread, none
    const fillOf = async (out: bigint): Promise<{ fill?: NonNullable<NearBuyProgress["fill"]>; units?: string }> => {
      try {
        const d = deps.decimals ? await deps.decimals(ask.token) : null;
        if (d !== null && Number.isInteger(d) && d >= 0 && d <= 255) return { fill: { out: out.toString(), decimals: d }, units: unitsOf(out, d) };
      } catch {
        deps.log("receive", `decimals not read`);
      }
      return {};
    };
    // W's last read: a run that ends below the floor (or on a later read that failed) with some of the token on W writes
    // what it received, so W is a position whatever code the record ends with
    let last: NearHeldState | null = null;
    let held: bigint;
    try {
      held = (await readUntil("sell", (x) => ((last = x), x.held - got.before >= got.floor), "received_below_floor")).held;
    } catch (e) {
      const lastRead = last as NearHeldState | null;
      if (lastRead !== null && lastRead.held > got.before) {
        const { fill } = await fillOf(lastRead.held - got.before);
        if (fill) await progress({ stage: "sent", fill });
      }
      throw e;
    }
    deps.log("receive", "received");
    // the amount W received; unread decimals: the buy is still filled, untold
    const out = held - got.before;
    const { fill, units } = await fillOf(out);
    // never an amount past the kit's bound, which a client refuses
    if (units !== undefined && out > 0n && ROUTE_OUT.test(units)) tell({ out: units });
    await progress({ stage: "filled", ...(fill ? { fill } : {}) });
    return { result: { stage: "filled", txs } };
  } catch (e) {
    const stop = e instanceof Stop ? e : new Stop("not_known", legCause(e));
    if (!(e instanceof Stop)) deps.log(step, "not_known");
    if (stop.cause_ !== undefined) console.warn(`near buy ${step} ${stop.code}: ${stop.cause_}`);
    // before the payout landed nothing moved; after it, never an error: sent, with every transaction so far
    if (!paid) {
      await progress({ stage: "refused", code: stop.code, ...(stop.cause_ === undefined ? {} : { cause: stop.cause_ }) });
      return { error: stop.code };
    }
    await progress({ stage: "sent", code: stop.code, ...(stop.cause_ === undefined ? {} : { cause: stop.cause_ }) });
    return { result: { stage: "sent", txs } };
  }
}

/** A quote alone (the creation's trade), asked again while it throws, bounded; one not of the ask's own is refused. */
async function quoteOnly(deps: NearBuyDeps, ask: NearBuyAsk, fail: (code: string, e?: unknown) => never): Promise<{ q: RheaQuote }> {
  let thrown: unknown;
  for (let i = 0; i < NEAR_BUY_READ_TRIES; i++) {
    if (i > 0) await deps.wait(NEAR_BUY_READ_WAIT_MS);
    let q: RheaQuote;
    try {
      q = await deps.quote({ side: "buy", token: ask.token, amountIn: ask.amount });
    } catch (e) {
      thrown = e;
      continue;
    }
    if (q.network !== deps.network || q.side !== "buy" || q.token !== ask.token || q.amountIn !== ask.amount) return fail("quote_check_failed");
    deps.log("quote", "quote");
    return { q };
  }
  return fail("quote_check_failed", thrown);
}
