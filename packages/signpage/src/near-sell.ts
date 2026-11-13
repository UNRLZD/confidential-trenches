// The device's NEAR private sell (card near-private-trading): the fresh NEAR wallet W that bought a token sells all of
// it back to USDC on Rhea classic, then moves that USDC from W into the vault as the user's notes (W's return note, then
// its R second arrivals on NEAR), so Cash holds the proceeds. Every part is injected (deps), as in near-trade.ts
// nearBuyFlow: this module holds no key, no seed and no address of its own; the page binds them.
//
// The steps, strictly in order, each logged once through deps.log with its outcome:
//   1. read: W (the wallet the token's buy is bound to, A11) read light on both providers (deps.held, side sell): the
//      token W holds and its USDC registration.
//   2. quote: the device's own two-provider quote token -> USDC for what W holds, with W read at the quote's block
//      (deps.pair, the kit's readNearSwapPair; card near-quote-under-the-pace), a fee the seller pays on top left out
//      of the amount (the kit's nearSellAmount) and that amount quoted again. A pair that throws (a lag between the
//      providers, a busy one) is asked again, bounded (NEAR_BUY_READ_TRIES), then quote_check_failed with nothing
//      signed. The quote must be the request's own, and its floor at least the vault's least deposit, else
//      amount_too_low before anything is signed.
//   3. register: W not registered on USDC: the registration round signed alone from the quote's pair, sent, and read
//      back light (bounded).
//   4. swap: a fresh pair (W, the quote and the USDC baseline at one block) and the swap round signed from it, by W
//      only after the kit's nearSwapCheck passed in the wallet's
//      signer (min out from this quote and the user's slippage, never the helper's word; the bound token is the buy
//      record's, deps.wallet's, never the request's). A swap that failed on chain with its token back in W
//      (carry_failed) goes back to 2 for what W holds, at most NEAR_SELL_SWAPS_MAX swaps.
//   5. receive: the USDC W holds read again (reads only) until what it received reaches the floor:
//      floor(venue out x (10^4 - slippage) / 10^4); below it after the reads: received_below_floor. Then W read until
//      its key nonce reached the last delegate this run signed (a lost-found claim after the swap), or that delegate's
//      window passed, so no deposit is signed at a nonce a trade delegate still holds.
//   6. note: the sale's next note (k = 0 W's return note return/near/l/j; k > 0 its R second arrival k - 1 on NEAR, each
//      precommitment from the 12 words) written PLANNED in the note store, or the one already there, BEFORE its move
//      is asked: a reload or a restore finds it. A note is planned only once the one before it has landed.
//   7. move: W's USDC into the vault on that note through the helper's deposit carry (deps.move: the wallet's
//      bindDeposit with W as the mover), confirmed only from the vault's deposits pages. The amount is what W holds up
//      to the deposit's cap (noteAmount), or the amount of a call already written for the note (a run that stopped
//      after sending it). A note whose P another deposit took (front_run) is done: W's USDC goes on the next note. A
//      note with no call while W holds too little is looked up in the vault's pages (another device, a restore).
//      6 and 7 again, each W read at or past the last landing's block, until W holds under the least deposit.
//   8. done: W read once more, at or past the last landing: "filled" only when it holds no token and USDC under the
//      least deposit; otherwise "sent" (the page goes on from the chain on its next run).
// A run resumes where the chain says it stopped: W holding no token skips 2-5; each note with a call written settles
// that call, in order, and the notes after it go on from what W still holds.
// Nothing that could move money twice is retried by this module: a helper call that threw is "not_known" and never
// sent again; only reads are asked again. The one new signature after a refusal: a swap the helper answers carry_failed
// (its tx failed on chain), once W reads its token back past that swap's nonce, is signed afresh on a new quote, at
// most NEAR_SELL_SWAPS_MAX swaps in all. A helper refusal passes through verbatim when it is one of the trade kind's
// codes (HELPER_BIND_TRADE_CODES), a refused move with its deposit code (HELPER_BIND_DEPOSIT_CODES); anything else is
// "not_known". No answer is ever a "not now" code (api.ts RETRY_CODES).
// Once the token is sold (the swap sent by this run, a send that threw or a refusal that carried txs included, or W
// found with no token and its USDC or a note's call on the way home), a stop is never an error: the answer is
// { stage: "sent", txs } with every tx so far, and the stop's code and its cause go to deps.stop (the page's record).
import { HELPER_BIND_DEPOSIT_CAP, HELPER_BIND_DEPOSIT_CODES, HELPER_BIND_TRADE_CODES, type HelperBindTradeRequest, type HelperNearTrade } from "../../kit/src/helper/v1.ts";
import { NEAR_NETWORKS, type NearNetwork } from "../../kit/src/near/networks.ts";
import type { RheaQuote } from "../../kit/src/near/rhea.ts";
import { nearSellAmount } from "../../kit/src/near/token-fee.ts";
import { NEAR_SWAP_SLIPPAGE_MAX_BPS, nearSwapCalls, nearSwapFloor, type NearSwapCall, type NearSwapRequest } from "../../kit/src/trade/near/swap.ts";
import type { NearSwapWalletArgs, NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import type { SignpageResults, TxRef } from "../../kit/src/signpage/messages.ts";
import { VAULT_CONSTANTS } from "../../kit/src/vault/shapes.ts";
import type { signNearSwapDelegates, SignedNearSwapDelegate } from "../../wallet/src/near/swap-delegate.ts";
import { bindDeposit, type BindOutcome, type BindRpc, callAmount, DepositsWatch, ownRow } from "../../wallet/src/deposit/bind.ts";
import { moverAccount } from "../../wallet/src/deposit/delegate.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { refKey, type NoteStore } from "../../wallet/src/notes/store.ts";
import { landNote } from "../../wallet/src/notes/restore.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";
import { NEAR_BUY_READ_TRIES, NEAR_BUY_READ_WAIT_MS, type NearHeldState, type NearHelperAnswer, type NearPair, type NearPairAsk } from "./near-trade.ts";
import { legCause } from "./pool-sell.ts";

export type NearSellAsk = { token: string; slippageBps: number };
export type NearSellStep = "read" | "quote" | "register" | "swap" | "receive" | "note" | "move" | "done";
/** One of the sale's notes as the store holds it: its id, its state, and the amount of the last call written for it (null: none). */
export type NearReturnNote = { id: string; state: string; amount: bigint | null };
/**
 * The move's end: the note landed for W (its transactions as heard), or landed on another's deposit that took its P
 * (front_run: W's USDC stays, for the next note), each with the block the vault's pages held it at; absent (a look
 * with amount 0 found no row); or what stopped it.
 */
export type NearMoveEnd =
  | { kind: "deposited"; txs: string[]; height: number }
  | { kind: "front_run"; height: number }
  | { kind: "absent" }
  | { kind: "struck" }
  | { kind: "refused"; code: string };
export type NearSellAnswer = { result: SignpageResults["pool.sell"] } | { error: string };
type Awaitable<T> = T | Promise<T>;
type DropSeed<T> = T extends (seed64: Uint8Array, ...rest: infer R) => infer O ? (...rest: R) => O : never;
/** W_{near,l,j} and the token its buy record binds it to (A11): the bound the signer holds a sell to. */
type W = { id: string; l: bigint; j: number; token: string };

export type NearSellDeps = {
  network: NearNetwork;
  /** The W whose buy is bound to the token (the device's buy record, A11) with that record's token, or null: none. */
  wallet(token: string): Awaitable<W | null>;
  helper(body: HelperBindTradeRequest): Promise<NearHelperAnswer>;
  /** The kit's readNearSwapWallet with the network and its pair bound. */
  readWallet(a: Pick<NearSwapWalletArgs, "wallet" | "side" | "token">): Promise<NearSwapWalletState>;
  /** The kit's readNearSwapPair with the network, its pair and the candidate pools bound: W and the quote at one block
   *  (`baseline`: W's balance of that token at the same block). */
  pair(a: NearPairAsk): Promise<NearPair>;
  /** W's light read (the kit's readNearHeld), for the waits that only ask "has it arrived"; absent: readWallet. */
  held?(a: Pick<NearSwapWalletArgs, "wallet" | "side" | "token">): Promise<NearHeldState>;
  /** The wallet's signNearSwapDelegates with the seed bound (the page opens the seed under its lock: may be async). */
  sign: (...a: Parameters<DropSeed<typeof signNearSwapDelegates>>) => Awaitable<SignedNearSwapDelegate[]>;
  /** The sale's k-th note (0: W's return note; k > 0: its R second arrival k - 1 on NEAR), written PLANNED when absent
   *  and `create`, else null when absent (near-sell.ts nearSellNote). */
  note(w: W, k: number, create: boolean): Promise<NearReturnNote | null>;
  /** W's USDC into the vault on the note (near-sell.ts nearReturnMove: the wallet's bindDeposit, W the mover); amount
   *  0: only look the note up in the vault's pages. */
  move(w: W, noteId: string, amount: bigint): Promise<NearMoveEnd>;
  wait(ms: number): Promise<void>;
  /** One line per step: the step and its outcome, in short public words (no key, no amount, no address). */
  log(step: NearSellStep, outcome: string): void;
  /** The run's stop, once, before its answer: the step, the code, and a throw's cause (legCause's shape, never its text). */
  stop?(step: NearSellStep, code: string, cause?: string): void;
  /** The last trade delegate any run of this sell signed (its nonce and max_block_height, kept on the sell's record), or null. */
  lastTrade(): Awaitable<NearTradeSigned | null>;
  /** Keeps the last trade delegate signed on the sell's record, before it is sent: a later run gates W's moves on it. */
  traded(t: NearTradeSigned): Awaitable<void>;
};
/** A trade delegate W signed: its nonce and max_block_height. */
export type NearTradeSigned = { nonce: bigint; mbh: bigint };

/** Swaps per side per W: a swap that failed on chain with its input back in W frees its side, up to this many (the
 *  helper's trade kind holds the same cap and answers trade_used past it). */
export const NEAR_SELL_SWAPS_MAX = 3;
/** Notes of the sale another deposit took (front_run) in one run before the run stops as sent. */
export const NEAR_SELL_TAKEN_MAX = 3;
const IMPLICIT = /^[0-9a-f]{64}$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TRADE_CODES: ReadonlySet<string> = new Set(HELPER_BIND_TRADE_CODES);
const DEPOSIT_CODES: ReadonlySet<string> = new Set(HELPER_BIND_DEPOSIT_CODES);
const MIN = VAULT_CONSTANTS.MIN_DEPOSIT;

/**
 * One note's amount of what W holds (at least the vault's least deposit): all of it up to the deposit's cap; past the
 * cap, the cap, unless what would be left is under the least deposit, then all but that least, so every note the sale
 * writes is one the helper carries and none of the proceeds is left in W.
 */
export function noteAmount(held: bigint): bigint {
  if (held <= HELPER_BIND_DEPOSIT_CAP) return held;
  return held - HELPER_BIND_DEPOSIT_CAP < MIN ? held - MIN : HELPER_BIND_DEPOSIT_CAP;
}

class Stop extends Error {
  readonly code: string;
  readonly step: NearSellStep;
  constructor(step: NearSellStep, code: string) {
    super(code);
    this.code = code;
    this.step = step;
  }
}

/** The pool.sell kind's run for a NEAR token: one run per call, answered at its end. */
export function nearSellFlow(deps: NearSellDeps): (ask: NearSellAsk, ctx: KindContext) => Running<"pool.sell"> | HostRefusal {
  return (ask, _ctx) => {
    if (typeof ask.token !== "string" || ask.token === "" || !Number.isSafeInteger(ask.slippageBps) || ask.slippageBps < 1 || ask.slippageBps > NEAR_SWAP_SLIPPAGE_MAX_BPS) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.sell"> | HostRefusal | null = null;
    const after = runSell(deps, { token: ask.token, slippageBps: ask.slippageBps }).then(
      (a) => void (answer = a),
      () => void (answer = { error: "failed" }),
    );
    return { running: true, after, answer: () => answer ?? { error: "failed" } };
  };
}

async function runSell(deps: NearSellDeps, ask: NearSellAsk): Promise<NearSellAnswer> {
  const txs: TxRef[] = [];
  const near = (hashes: readonly string[]) => txs.push(...hashes.map((hash): TxRef => ({ chain: "near", hash })));
  // the token sold (see the header): from then on a stop answers "sent"
  let sold = false;
  // the step last logged: a throw that is no stop is put at it
  let at: NearSellStep = "read";
  const say = (step: NearSellStep, outcome: string): void => {
    at = step;
    deps.log(step, outcome);
  };
  const fail = (step: NearSellStep, code: string): never => {
    say(step, code);
    throw new Stop(step, code);
  };
  try {
    let w: W | null;
    try {
      w = await deps.wallet(ask.token);
    } catch {
      return { error: "not_allowed" };
    }
    if (w === null || typeof w !== "object" || !IMPLICIT.test(w.id) || typeof w.l !== "bigint" || !Number.isSafeInteger(w.j) || typeof w.token !== "string" || w.token === "") return { error: "not_allowed" };
    const wallet: W = { id: w.id, l: w.l, j: w.j, token: w.token };

    // W read on both providers, asked again (reads only) until `done` holds, at most NEAR_BUY_READ_TRIES times
    const readUntil = async (step: NearSellStep, side: "buy" | "sell", done: (s: NearSwapWalletState) => boolean, missed: string): Promise<NearSwapWalletState> => {
      let last: NearSwapWalletState | null = null;
      for (let i = 0; i < NEAR_BUY_READ_TRIES; i++) {
        if (i > 0) await deps.wait(NEAR_BUY_READ_WAIT_MS);
        let s: NearSwapWalletState;
        try {
          s = await deps.readWallet({ wallet: wallet.id, side, token: ask.token });
        } catch {
          last = null;
          continue;
        }
        if (s.account !== wallet.id) return fail(step, "read_failed");
        last = s;
        if (done(s)) return s;
      }
      return fail(step, last === null ? "read_failed" : missed);
    };

    // W's light read, asked again (reads only) until `done` holds: the waits that only ask "has it arrived"
    const lightUntil = async (step: NearSellStep, side: "buy" | "sell", done: (s: NearHeldState) => boolean, missed: string): Promise<NearHeldState> => {
      if (!deps.held) return readUntil(step, side, done, missed);
      let last: NearHeldState | null = null;
      for (let i = 0; i < NEAR_BUY_READ_TRIES; i++) {
        if (i > 0) await deps.wait(NEAR_BUY_READ_WAIT_MS);
        let s: NearHeldState;
        try {
          s = await deps.held({ wallet: wallet.id, side, token: ask.token });
        } catch {
          last = null;
          continue;
        }
        if (s.account !== wallet.id) return fail(step, "read_failed");
        last = s;
        if (done(s)) return s;
      }
      return fail(step, last === null ? "read_failed" : missed);
    };

    // 1. what W holds of the token (side sell: the token sent, USDC received)
    const first = await lightUntil("read", "sell", () => true, "read_failed");
    say("read", first.held > 0n ? "token held" : "no token");

    // the last trade delegate signed for this sell, by this run or one before it (the sell's record): no deposit is
    // signed before W's nonce reached it or its window passed, so a move never takes the nonce of a claim still held
    let signedLast: NearTradeSigned | null;
    try {
      signedLast = await deps.lastTrade();
    } catch {
      return fail("read", "read_failed");
    }
    if (signedLast !== null && (typeof signedLast !== "object" || typeof signedLast.nonce !== "bigint" || typeof signedLast.mbh !== "bigint")) fail("read", "read_failed");
    // 2-5, again on a fresh quote after a swap that failed on chain with its input back in W (the helper's carry_failed:
    // the swap's side is freed for W, at most NEAR_SELL_SWAPS_MAX swaps per side per W), never more often than that
    let s: NearHeldState = first;
    for (let swaps = 1; s.held > 0n; swaps++) {
      const held = s.held;
      // 2. the quote of the amount W sells (all it holds, less a fee the seller pays on top), with W read at the same block
      // (deps.pair): what a round signs from is never older than what it signs against. Asked again, bounded, as the
      // buy's fresh pair is, when a read throws (a provider lagging or busy); `want`: W read again until it holds
      const fresh = async (step: NearSellStep, amountIn: bigint, want: (x: NearSwapWalletState) => boolean = () => true, baseline?: string): Promise<{ s: NearSwapWalletState; q: RheaQuote; base?: bigint }> => {
        for (let i = 0; i < NEAR_BUY_READ_TRIES; i++) {
          if (i > 0) await deps.wait(NEAR_BUY_READ_WAIT_MS);
          let r: NearPair;
          try {
            r = await deps.pair({ side: "sell", token: ask.token, amountIn, wallet: wallet.id, ...(baseline === undefined ? {} : { baseline }) });
          } catch {
            continue;
          }
          const { state: x, quote: q } = r;
          if (x.account !== wallet.id) return fail(step, "read_failed");
          if (q.network !== deps.network || q.side !== "sell" || q.token !== ask.token || q.amountIn !== amountIn) return fail("quote", "quote_check_failed");
          if (baseline !== undefined && typeof r.baseline !== "bigint") return fail(step, "read_failed");
          // proceeds the vault would refuse are never sold for: nothing is signed (the token stays in W)
          if (nearSwapFloor(q.venueOut, ask.slippageBps) < MIN) return fail("quote", "amount_too_low");
          if (!want(x)) continue;
          say("quote", "quote");
          return { s: x, q, ...(r.baseline === undefined ? {} : { base: r.baseline }) };
        }
        return fail("quote", "quote_check_failed");
      };
      let { s: seen, q } = await fresh("quote", held);
      let amount: bigint;
      try {
        amount = nearSellAmount(q.fee, q.exchange, held);
      } catch {
        return fail("quote", "quote_check_failed");
      }
      if (amount <= 0n) fail("quote", "quote_check_failed");
      if (amount !== held) ({ s: seen, q } = await fresh("quote", amount));
      const request: NearSwapRequest = { network: deps.network, side: "sell", token: ask.token, amountIn: amount, wallet: wallet.id, slippageBps: ask.slippageBps };
      const tradeOf = (x: RheaQuote): HelperNearTrade => ({
        network: deps.network,
        side: "sell",
        token: ask.token,
        wallet: wallet.id,
        amount_in: amount.toString(),
        slippage_bps: ask.slippageBps,
        venue_out: x.venueOut.toString(),
        hops: x.hops.map((h) => ({ pool: h.pool, token_in: h.tokenIn, token_out: h.tokenOut })),
      });
      const send = async (step: NearSellStep, body: HelperBindTradeRequest, count: number): Promise<void> => {
        let a: NearHelperAnswer;
        try {
          a = await deps.helper(body);
        } catch {
          // the swap may have gone out
          if (step === "swap") sold = true;
          return fail(step, "not_known");
        }
        if (a.ok !== true) {
          const carried = (a as { tx_hashes?: unknown }).tx_hashes;
          if (Array.isArray(carried) && carried.length > 0 && carried.every((h) => typeof h === "string" && TX_HASH.test(h))) {
            near(carried as string[]);
            if (step === "swap") sold = true;
          }
          // in_flight: the helper holds a signed swap of W's whose outcome it has not read; it may have sold
          if (step === "swap" && a.code === "in_flight") sold = true;
          // a second registration of W (W reads registered on the helper's side, or this one's bytes were carried
          // before): nothing to do, and the read after it decides, as the buy's does
          if (step === "register" && (a.code === "already_registered" || a.code === "replayed")) return;
          fail(step, typeof a.code === "string" && TRADE_CODES.has(a.code) ? a.code : "not_known");
        }
        if (step === "swap") sold = true;
        const hashes = (a as { tx_hashes: unknown }).tx_hashes;
        if (!Array.isArray(hashes) || hashes.length !== count || !hashes.every((h) => typeof h === "string" && TX_HASH.test(h))) fail(step, "not_known");
        near(hashes as string[]);
      };
      const round = async (step: NearSellStep, x: RheaQuote, st: NearSwapWalletState, registered: boolean): Promise<void> => {
        let calls: NearSwapCall[];
        let signed: SignedNearSwapDelegate[];
        try {
          calls = nearSwapCalls({ quote: x, wallet: wallet.id, slippageBps: ask.slippageBps, registered, storageMin: st.storageMin, lostfound: st.lostfound }, request);
        } catch {
          return fail(step, "quote_check_failed");
        }
        try {
          // bound: the token W's buy record names (deps.wallet, A11), never the request's: the signer refuses a sell
          // whose request names another token than that record's
          signed = await deps.sign(wallet.l, wallet.j, calls, request, x, st, wallet.token);
        } catch {
          return fail(step, "not_signed");
        }
        if (!Array.isArray(signed) || signed.length !== calls.length) fail(step, "not_signed");
        const last = signed.at(-1)!;
        signedLast = { nonce: last.nonce, mbh: last.max_block_height };
        try {
          await deps.traded(signedLast);
        } catch {
          // not kept: nothing goes out, so no later run can sign over a delegate it does not know of
          return fail(step, "not_known");
        }
        await send(step, { trade: tradeOf(x), signed_delegates: signed.map((d) => d.signed_delegate) }, calls.length);
      };

      // 3. W's registration on USDC, its own round, signed from the pair's read
      if (!seen.registered) {
        await round("register", q, seen, false);
        await lightUntil("register", "sell", (x) => x.registered, "not_registered");
        say("register", "registered");
      } else say("register", "already registered");

      // 4. the swap on a fresh pair, W read at the quote's block, its nonce past the registration (read again until it
      // reads registered); the USDC W holds at that block is the baseline of what the swap pays
      const swapPair = await fresh("swap", amount, (x) => x.registered, NEAR_NETWORKS[deps.network].usdc);
      if (swapPair.s.held < amount) fail("swap", "not_funded");
      const before = swapPair.base!;
      s = swapPair.s;
      try {
        await round("swap", swapPair.q, swapPair.s, true);
      } catch (e) {
        if (!(e instanceof Stop) || e.code !== "carry_failed" || swaps >= NEAR_SELL_SWAPS_MAX) throw e;
        // the swap failed on chain: W asked again once its token is back (its nonce past the failed swap's)
        const spent = swapPair.s.nonce;
        s = await readUntil("swap", "sell", (x) => x.held > 0n && x.nonce > spent, "carry_failed");
        say("swap", "asked again");
        continue;
      }
      say("swap", "swapped");

      // 5. what W received in USDC against the floor (USDC carries no fee of its own)
      const floor = nearSwapFloor(swapPair.q.venueOut, ask.slippageBps);
      await lightUntil("receive", "buy", (x) => x.held - before >= floor, "received_below_floor");
      say("receive", "received");
      break;
    }

    // 6-7. the notes and their moves, one note at a time: W's return note, then its R second arrivals on NEAR, each at
    // most the deposit's cap, each in the store before its move is asked and moved alone, until W holds under the
    // least deposit. A note is planned only once the one before it has landed (the store's rule; the helper's R2 holds
    // one open P per sender). The first read waits for W's nonce to reach the last trade delegate signed (or its
    // window to pass); after a landing, W is read only at or past the block the vault's pages held it, so a lagging
    // read never names USDC that has already left.
    const trade = signedLast as NearTradeSigned | null;
    let height = 0;
    let landed = false;
    // notes another deposit took in this run (a note already landed when this run reached it is read, never counted
    // again): past NEAR_SELL_TAKEN_MAX the run stops (sent), the next run goes on
    let taken = 0;
    const settled = (x: NearSwapWalletState) => x.height >= height && (trade === null || x.nonce >= trade.nonce || BigInt(x.height) > trade.mbh);
    for (let k = 0; ; k++) {
      const usdc = await readUntil("note", "buy", settled, "read_failed");
      let note: NearReturnNote | null;
      try {
        note = await deps.note(wallet, k, usdc.held >= MIN);
      } catch {
        return fail("note", "not_known");
      }
      if (note === null) break; // W holds under the least deposit and no note is written past the last
      let amount: bigint;
      if (note.amount !== null) amount = note.amount;
      else if (note.state === "UNSPENT") {
        // landed with no call of this device's (a restore wrote it): its money is in; the next note
        landed = true;
        say("move", "in the vault already");
        continue;
      } else if (usdc.held >= MIN) amount = noteAmount(usdc.held);
      else amount = 0n; // no call and W too short: only the vault's pages can say it landed (another device, a restore)
      if (amount > 0n) sold = true; // W's USDC (or a written call) on the way home: the token was sold
      say("note", "noted");
      let end: NearMoveEnd;
      try {
        end = await deps.move(wallet, note.id, amount);
      } catch {
        return fail("move", "not_known");
      }
      if (amount === 0n && end.kind === "absent") break;
      if (end.kind === "struck") fail("move", "sender_struck");
      if (end.kind === "refused") fail("move", typeof end.code === "string" && DEPOSIT_CODES.has(end.code) ? end.code : "not_known");
      if (end.kind === "front_run" && Number.isSafeInteger(end.height)) {
        // another deposit took the note's P: the note is done, W's USDC goes on the next one (each such deposit pays
        // into the user's own note; past a few in one run, the run stops and the next run goes on)
        height = end.height;
        if (note.state !== "UNSPENT" && ++taken >= NEAR_SELL_TAKEN_MAX) fail("move", "p_used");
        say("move", "p_used");
        continue;
      }
      const e = end as { kind: string; txs?: unknown; height?: unknown };
      if (e.kind !== "deposited" || !Array.isArray(e.txs) || !e.txs.every((h) => typeof h === "string" && TX_HASH.test(h)) || !Number.isSafeInteger(e.height)) fail("move", "not_known");
      near(e.txs as string[]);
      height = e.height as number;
      landed = true;
      say("move", "in the vault");
    }

    // 8. the end state, from the device's own read at or past the last landing: filled only when W holds no token and
    // USDC under the least deposit
    // a read that fails, or W not empty (USDC still on its way, a token sent in): "sent", and the next run goes on
    const t = await readUntil("done", "sell", (x) => x.height >= height, "read_failed");
    const u = await readUntil("done", "buy", (x) => x.height >= height, "read_failed");
    if (t.held > 0n || u.held >= MIN) return fail("done", "not_empty");
    say("done", "wallet empty");
    // nothing sold and nothing in the vault: W held nothing to sell
    if (!sold && !landed) return fail("done", "not_funded");
    // the sale's notes in the vault: filled; the token sold for USDC under the least deposit, left in W: part filled
    return { result: { stage: landed ? "filled" : "part_filled", txs } };
  } catch (e) {
    const code = e instanceof Stop ? e.code : "not_known";
    const step = e instanceof Stop ? e.step : at;
    try {
      deps.stop?.(step, code, e instanceof Stop ? undefined : legCause(e));
    } catch {
      // the record's write is the page's; the answer stands
    }
    if (sold) return { result: { stage: "sent", txs } };
    if (e instanceof Stop) return { error: code };
    throw e;
  }
}

// ---- The notes and the moves, bound by the page (deps.note, deps.move) ----

/**
 * The sale's k-th note: k = 0 W's return note (return/near/l/j), k > 0 its R second arrival k - 1 on NEAR; its
 * precommitment from the 12 words. Written PLANNED when the store has none and `create` (the store refuses an R note
 * until the one before it has landed), else null; the one there is taken in any state. The one there must be this
 * ref's precommitment and scope, else it throws and nothing moves. The amount is the last call written for it (null:
 * none written yet).
 */
export async function nearSellNote(store: NoteStore, seed64: Uint8Array, scope: bigint, w: { l: bigint; j: number }, k: number, create: boolean): Promise<NearReturnNote | null> {
  if (!Number.isSafeInteger(k) || k < 0) throw new Error("k is a note's place in the sale, from 0");
  const ref: NoteRef = k === 0 ? { kind: "return", c: "near", l: w.l, j: w.j } : { kind: "second", id: { id: "R", c: "near", l: w.l, j: w.j }, n: k - 1 };
  const precommitment = noteSecrets(seed64, ref).precommitment;
  const key = refKey(ref);
  let n = (await store.list()).find((x) => refKey(x.ref) === key);
  if (n === undefined && !create) return null;
  n ??= await store.add({ ref, scope, precommitment, state: "PLANNED" });
  if (n.precommitment !== precommitment || n.scope !== scope) throw new Error("the sale's note is not its ref's");
  const last = n.calls?.at(-1);
  return { id: n.id, state: n.state, amount: last === undefined ? null : callAmount(last) };
}

/**
 * W's USDC into the vault on one of the sale's notes: the wallet's bindDeposit with W the mover (its rules in full: the
 * call written with the note before it leaves, the pages alone confirm, a lapse signed again at its nonce). Its end:
 * the note landed for W (the last call's transactions as heard), or on another's deposit that took its P (front_run),
 * each with the height of the store's vault cursor, which the read that held the note moved to at least its block; or
 * what stopped it. Amount 0 only looks: the note's P read in the vault's pages on both providers, the note landed
 * when they hold it (another device's move, or one before a restore), else absent.
 */
export async function nearReturnMove(
  seed64: Uint8Array,
  w: { l: bigint; j: number },
  noteId: string,
  amount: bigint,
  o: { network: NearNetwork; store: NoteStore; rpcs: readonly [BindRpc, BindRpc]; signal?: AbortSignal; bind?: typeof bindDeposit },
): Promise<NearMoveEnd> {
  const vault = NEAR_NETWORKS[o.network].vault;
  if (vault === null) throw new Error(`the release names no vault on ${o.network}`);
  const cursor = async () => (await o.store.syncCursor(vault)).height;
  if (amount === 0n) {
    const note = await o.store.get(noteId);
    if (note === undefined) throw new Error("the note is not in the store");
    const watch = new DepositsWatch(vault, note.precommitment, o.rpcs, { ...(await o.store.syncCursor(vault)), deposits: 0 }, (c) => o.store.saveSyncCursor(c));
    const r = await watch.read(o.signal);
    if (r.state !== "held") return { kind: "absent" };
    const row = r.row;
    const leaf = { value: row.value, label: row.label, commitment: noteCommitment(row.value, row.label, note.precommitment), leafIndex: row.leafIndex };
    const done = note.state === "PLANNED" || note.state === "INCOMING" ? await landNote(o.store, note, leaf) : note;
    return ownRow(row, moverAccount(seed64, { kind: "W", l: w.l, j: w.j }), done) ? { kind: "deposited", txs: [], height: r.height } : { kind: "front_run", height: r.height };
  }
  const out: BindOutcome = await (o.bind ?? bindDeposit)(seed64, { network: o.network, w: { l: w.l, j: w.j }, noteId, amount }, { store: o.store, rpcs: o.rpcs, ...(o.signal ? { signal: o.signal } : {}) });
  if (out.kind === "deposited") return { kind: "deposited", txs: [...(out.note.calls?.at(-1)?.tx_hashes ?? [])], height: await cursor() };
  if (out.kind === "front_run") return { kind: "front_run", height: await cursor() };
  if (out.kind === "refused") return { kind: "refused", code: out.code };
  return { kind: "struck" };
}
