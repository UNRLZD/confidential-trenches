// pool.buy on a Base or Robinhood pool (card signpage-evm-pool-buy): one tap releases a ready proof's chunk from the
// pinned pool to its fresh wallet W and buys the user's token with it in one transaction (PrivacyPoolSimple.buy), which
// the helper's sender carries. Every safety step of the Solana buy (pool-buy.ts) holds here, and once the signed bytes
// have left the device the run answers only a stage that is true.
//
// - The proof: one the chain's proof queue made ahead (../../wallet/src/pool/queue.ts over the wallet's evmPool), whose
//   chunk is the ask's amount exactly, whose W is an EVM one, and that no other tap of this page holds (`claimed`). Its
//   own signals are checked against its binding: the value its chunk, the context its binding's. Its fee is the one its
//   binding holds, the device's own epoch fee read on two RPCs when the queue bound it, and the relay data's fee cap
//   (what the proof's context commits to) is held to it by the rule.
// - The quote: the kit's evmPoolBuyQuote, for the chunk less that fee (what the pool swaps), on the kit's pinned
//   providers; a read names the token, never W. The request names no route, so the device asks one shape (quoteOf),
//   then one v3 WETH tier, and a quote the kit refuses below its own best (below_reference, native_first,
//   over_gas_floor, and a no_quote that names it) is asked again on that best route, once: three quotes at most.
// - Built by the kit (evmPoolBuildQuoted, through the chain's pinned adapter for the route's venue), checked by the
//   rule (checkEvmBuy: the quote's own build, the pinned pool and adapter, the ask's token and amount, a min out at least
//   the quote's agreed output less the ask's own slippage, which the rule derives, the proof's relay data W's and the
//   pinned fee recipient's), signed by W only through signEvmBuy. W is derived from the seed right before it signs and
//   must be the proof's W and the relay data's recipient; the seed is zeroed once W is derived and W's key once it has
//   signed, and both again on every exit. A quote or a check that fails is never signed: the note stays HELD. Right
//   before W signs, a quote whose block is more than EVM_QUOTE_MAX_AGE_MS behind the device's clock (the reads and the
//   seed below take time) is read again, and the new one is built, checked and signed.
// - Before the bytes leave: the token's decimals (both RPCs), each RPC's newest block (where the read-back starts), and
//   W's holding written as pending (the token, its decimals, the route W signed): a write that fails sends nothing. So
//   a buy that lands is never without its record, whatever happens to the page after the send.
// - The take: then the queue's take moves the note HELD -> RESERVED for this very attempt, awaited before the send.
// - The send: evm-send.ts evmPoolSend. A busy helper is asked again after its wait while the proof has more than the
//   send margin left. Only the helper's own 4xx naming a code is a refusal (refused). Anything else (a 5xx, no code, a
//   timeout, busy past the margin) is no answer: the bytes may be on their way, so the run reads on, as it does after a
//   200, whose hash is never read by.
// - The read-back (evm-send.ts evmReleaseRead, evmBuyVerdict): the pool's own Bought and Withdrawn events since the
//   block read before the send, on both pool RPCs, asked by the pool's address and the events' topics only; this buy's
//   release is found on the device by the proof's nullifier. Ends:
//     filled: both RPCs show one Bought for the nullifier, the same in the same block, paying W the token, out at least
//       the min out W signed, of the chunk at a fee up to the proof's (the sender picks the fee, at most the relay
//       data's cap); W's holding is completed with what W received, and filled names that transaction;
//     refused, with the release's transaction: both show a Withdrawn (the swap failed in the pool's own call and W got
//       the chunk less the fee charged, in ETH): the holding is marked withdrawn and the page's carry pass starts
//       (src/pool-carry-evm.ts: W deposits that ETH back into the pool as a note of the user's, found from the chain
//       alone, again on every load until it lands); the buy did not fill;
//     not_landed: both show another release of the nullifier (the note spent elsewhere), or both RPCs' newest block is
//       past the proof's deadline with no release of it on either (the pool refuses it from then on: PrivacyPool.sol
//       reverts a release once block.timestamp is past the relay data's deadline). Never on a revert: the pool has no
//       sender check, so the public calldata can land until the deadline.
//   The tap's run reads for EVM_BUY_SETTLE_MS from the send and then answers its last true stage ("sent"); the reads go
//   on, with no lock held, until an end, which goes to the app as the kind's progress (`late`), so its button never
//   stays on "sent": every EVM_BUY_WAIT_MS until EVM_BUY_FOLLOW_MS past the deadline (an end comes by then unless a
//   pool RPC is down or stuck), then every EVM_BUY_SLOW_WAIT_MS while the page is signed in (`signal`, aborted at sign
//   out, ends the reads; the settle pass ends the note either way). The proof's deadline is at most EVM_LIFE_MS (210 s) from its epoch's start and at least
//   the send margin and take slack (75 s) after the take.
// - Settled: every run that took its note starts the chain's settle pass as it ends, and again when its reads end (the
//   one path that ends a RESERVED note: SPENT with its change once the release is final, UNSPENT once both RPCs' final
//   block is past the deadline with none).
// - Who learns what: the helper, the calldata (W, the pool, the route); the chain, the transaction; the pool RPCs, the
//   token (quote, decimals), their newest block and the pool's whole release log over a block range, never W, the
//   nullifier or a transaction hash.
// Nothing here logs.
import { POOL_ASSET_DECIMALS, type TradeStage, type TxRef } from "../../kit/src/signpage/messages.ts";
import { evmPoolBuyQuote, evmPoolIndexPools, EVM_QUOTE_MAX_AGE_MS, type EvmPoolBuyQuote, type EvmPoolBuyQuoteRequest, type EvmPoolKey } from "../../kit/src/checks/evm/quote.ts";
import { EvmBuyTapRefused, evmBuyTapReset, evmPoolBuyQuoteTap } from "../../kit/src/trade/evm/buy-tap.ts";
import { evmPoolVenues, venuePins, type EvmPoolBuy, type EvmPoolChain, type EvmPoolVenueList, type EvmRoute } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolBuildQuoted } from "../../kit/src/trade/evm/buy.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import type { ReservedMark } from "../../wallet/src/notes/store.ts";
import { EVM_LAG_TRIES, EVM_LAG_WAIT_MS, EVM_SEND_MARGIN_MS, type EvmPoolPin, type EvmPoolRequest, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import type { ProofQueue } from "../../wallet/src/pool/queue.ts";
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import { checkEvmBuy, planEvmBuy, PoolRuleRefused, poolUnits, signEvmBuy, TOKEN_DECIMALS_MAX, type EvmBuyPiece, type EvmBuyPlan, type PoolAsk } from "./rules/pool.ts";
import { EvmSendBusy, EvmSendRefused, evmBuyCalldata, evmBuyVerdict, evmHeadNumber, evmPoolSend, evmReleaseRead, type EvmBuyVerdict, type EvmBuyWant, type EvmReleaseRead } from "./evm-send.ts";
import { keptTokenDecimals, type PoolRpc } from "./pool-kinds.ts";
import { refusalRule } from "./refusal-rule.ts";
import { finishRest, mergeRest, prepRest, restState, EVM_WBUY_KEY, type EvmWBuyRecord, type RestLeg, type RestQuote, type RestState } from "./pool-buy-evm-rest.ts";
import { duringTrade, TRADE_HELPER } from "./trade.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

type Ready = ReadyProof<EvmPoolRequest>;
type Chain = "base" | "robinhood";

/** W's buy record by W's address, beside the Solana pool's (positions.ts POSITION_COSTS_KEY "owed/cost-sol"): an owed/
 *  key, the one meta keyspace the wallet store lets a caller write. */
export const EVM_POSITION_COSTS_KEY = "owed/cost-evm";
/** One W's buy: positions.ts PositionCost's fields (mint, received once known, decimals; no cost_usd, the page reads no
 *  EVM price yet, which positions.ts reads as cost unknown), its state, and the route W signed (with its transaction and
 *  block once read back). pending: written before the send; filled: read back with what W received; withdrawn: the
 *  swap failed, W holds the ETH, which the carry puts back into the pool (src/pool-carry-evm.ts). */
export type EvmHolding = {
  mint: string;
  decimals: number;
  chain: Chain;
  state: "pending" | "filled" | "withdrawn";
  received?: string;
  route: { venue: EvmRoute["venue"]; adapter: string; path: EvmRoute; tx?: string; block?: string };
  /** What the chain is asked to end this buy, written with the pending record (decimal strings): the proof's
   *  nullifier, the block the read-back starts at, the proof's deadline, the min out W signed, the chunk, the fee cap
   *  and the pinned fee recipient. A load whose tab did not follow this buy to its end reads the chain from it
   *  (followPendingEvmBuys); the run that wrote it removes it by its nullifier and deadline (unrecord). */
  buy?: EvmPendingBuy;
};
export type EvmPendingBuy = { nullifier: string; from: string; deadlineMs: string; minOut: string; value: string; feeCap: string; feeRecipient: string };

export type EvmPoolBuyHost = {
  chain: Chain;
  /** The testnet build: the chain's pool is its testnet's (rules/pool.ts checkEvmBuy's `testnet`). */
  testnet: boolean;
  /** The chain's pool pin (the wallet's EVM_POOLS of this page's network). */
  pin: EvmPoolPin;
  /** The kit's venue list (evmPoolVenues()): the pinned pool and adapters every check and signature reads. */
  venues: EvmPoolVenueList;
  /** The pool's two RPCs, of two operators (the page's evmPair of the chain's pool list). */
  rpcs: readonly [EvmRpc, EvmRpc];
  ready(): Promise<readonly Ready[]>;
  /** The queue's take; `nullifier` (the proof's) goes on the note's mark, so a page that did not run the buy finds its
   *  note from the chain's release (noteOf). */
  take(noteId: string, attempt: string, nullifier?: bigint): Promise<Ready>;
  /** The RESERVED note and attempt whose mark names `nullifier` (../../wallet/src/notes/store.ts ReservedMark), or null. */
  noteOf?(nullifier: bigint): Promise<{ noteId: string; attempt: string } | null>;
  seed64(): Promise<Uint8Array>;
  /** The kit's evmPoolBuyQuote. */
  quote(req: EvmPoolBuyQuoteRequest): Promise<EvmPoolBuyQuote>;
  /** The token's v4 pools in the chain's served pool index (the kit's evmPoolIndexPools), or null where none is served. */
  indexPools?(network: EvmPoolChain, token: string): readonly EvmPoolKey[] | null;
  /** The kit's evmPoolBuildQuoted. */
  build(adapter: string, q: EvmPoolBuyQuote): EvmPoolBuy;
  /** The token's decimals, the same on both RPCs (rules/pool.ts tokenDecimalsOf, via pool-kinds.ts keptTokenDecimals); throws otherwise. */
  decimals(token: string): Promise<number>;
  /** POST /v1/pool/evm/send (evm-send.ts evmPoolSend): its hash a hint only. */
  send(body: { pool: string; data: Uint8Array; epoch: bigint }): Promise<string>;
  /** Starts the chain's settle pass (evmSettleReserved over the page's notes); never awaited by the run. */
  settle(): void;
  /** Writes W's holding (EVM_POSITION_COSTS_KEY): before the send (a failure sends nothing) and on its end. */
  record(w: string, h: EvmHolding): Promise<void>;
  /** Removes W's holding only when it is this run's pending one (state pending, its buy's nullifier and deadline the
   *  ones given: a later proof of the same note has another deadline): at an end where the device or the chain said
   *  the buy did not happen. A removal that fails leaves it pending. */
  unrecord(w: string, nullifier: bigint, deadlineMs: bigint): Promise<void>;
  /** Merges into W's rest record (pool-buy-evm-rest.ts EVM_WBUY_KEY): a buy's rest is planned only on a host that has it. */
  rest?(w: string, rec: Partial<EvmWBuyRecord>): Promise<void>;
  /** Every W's holding (EVM_POSITION_COSTS_KEY), for the load's follow of pending buys. */
  holdings(): Promise<Record<string, unknown>>;
  /** The Ws whose buy this page is following now: the load's follow skips them. */
  following?: Set<string>;
  /** Starts the chain's carry pass (src/pool-carry-evm.ts carryEvmOwed): a release paid W with no swap. Never awaited;
   *  the pass reads the chain alone, so a pass that never starts here runs at the next state read. */
  carry?(): void;
  /** Runs the part up to the send under the seed's lock (the kind's); the read-back runs outside it. */
  hold?<T>(f: () => Promise<T>): Promise<T>;
  /** The bytes have left the device: told once. */
  sent?(): void;
  /** The note's release read on both RPCs (filled or withdrawn): the chunk left the pool, so the balance counts the
   *  note's change only until the settle writes it (../../wallet/src/pool/balances.ts landed). */
  landed?(noteId: string, attempt: string, withdrawn: bigint, block: bigint): void;
  /** An end the reads found after the tap's run answered "sent" at its bound. */
  late?(a: { stage: TradeStage; txs: TxRef[] }): void;
  /** The notes a run on this page has picked and not finished. */
  claimed?: Set<string>;
  /** The page's follows: aborted at sign out, which ends the reads; nothing is written or settled after it. */
  signal?: AbortSignal;
  /** True once this tab has started a sign out since the tap (the page's count of its sign outs): a busy wait ends at
   *  once, so the sign out never waits on it under the seed's lock. */
  stopped?(): boolean;
  now?(): bigint;
  wait?(ms: number): Promise<void>;
};

/** A refusal's `rule` (refusal-rule.ts): the fixed word naming the device rule or kit code that refused it, for the page's
 *  own record; never posted to the app. */
export type EvmPoolBuyAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "quote_check_failed" | "failed"; rule?: string };

/** The tap's read-back from the send, on the wall clock (the Solana buy's POOL_BUY_SETTLE_MS). */
export const EVM_BUY_SETTLE_MS = 120_000;
/** How long past the proof's deadline the reads go on at EVM_BUY_WAIT_MS; then at EVM_BUY_SLOW_WAIT_MS until an end. */
export const EVM_BUY_FOLLOW_MS = 300_000;
export const EVM_BUY_SLOW_WAIT_MS = 30_000;
/** Between two rounds of reads: each is six requests, three on each pool RPC. */
export const EVM_BUY_WAIT_MS = 2_000;
/** The wallet's own lag margin (../../wallet/src/pool/evm.ts: an RPC behind is read again EVM_LAG_TRIES times,
 *  EVM_LAG_WAIT_MS apart, before it fails): not_landed needs "no release, past the deadline" on two rounds at least
 *  this far apart, so one round of log answers trailing their block headers never answers it (review P2-1 a). */
export const EVM_BUY_LAG_MS = EVM_LAG_TRIES * EVM_LAG_WAIT_MS;
/** The fastest pool chain's blocks a second, rounded up: Robinhood mainnet 9.31 (100,000 blocks to 112,337,125 in
 *  10,746 s, rpc.mainnet.chain.robinhood.com) and 9.24 (robinhood-rpc.publicnode.com), Base mainnet 5.00 (20,000 blocks
 *  to 56,380,628 in 4,000 s, mainnet.base.org), read 2026-11-12 06:55Z; 9.38 at the review's read. Twice the fastest,
 *  so a chain that speeds up stays inside the margin. */
export const EVM_BLOCKS_PER_S_MAX = 20n;
/** The same margin in blocks, under the lower head where the read-back starts: twice EVM_BUY_LAG_MS at
 *  EVM_BLOCKS_PER_S_MAX (10 s of Robinhood mainnet's blocks is 94), in the buy, the sell (EVM_SELL_LAG_BLOCKS) and the
 *  withdraw alike. */
export const EVM_BUY_LAG_BLOCKS = 400n;
/** Two heads further apart than this, read before W signs, refuse the run (nothing signed, the note stays HELD): a low
 *  head is bounded by the other RPC's, so the read-back's range stays under EVM_BUY_LOG_SPAN (review P3-4) with the lag
 *  margin and a proof's life of EVM_BLOCKS_PER_S_MAX blocks beside it (test/pool-withdraw-evm.test.ts pins the sum).
 *  About 9 minutes of Robinhood mainnet's blocks and 17 of Base mainnet's, at the rates above. */
export const EVM_BUY_HEAD_SPREAD = 5_000n;
/** A busy wait's slices: it ends within one once this tab starts a sign out (\`stopped\`). */
const STOP_POLL_MS = 250;
type Code = Exclude<EvmPoolBuyAnswer, { stage: TradeStage }>["error"];
class Refused extends Error {
  readonly code: Code;
  readonly rule: string | undefined;
  constructor(code: Code, rule?: string) {
    super(code);
    this.code = code;
    this.rule = rule;
  }
}
const no = (code: Code = "failed", rule?: string): never => {
  throw new Refused(code, rule);
};
const lower = (s: string): string => s.toLowerCase();

/** For the tests: forgets every token's last route (the kit's evmBuyTapReset). */
export const evmLastRouteReset = (): void => evmBuyTapReset();

/** The device's quote of the ask: the kit's buy tap quote (kit trade/evm/buy-tap.ts evmPoolBuyQuoteTap, three kit
 *  quotes at most, the token's last route, its indexed pools a buy may take, the kit's own best route) on this page's
 *  host; a tap no route takes answers its name (not_allowed, quote_check_failed). */
async function quoteOf(h: EvmPoolBuyHost, network: EvmPoolChain, token: string, amountIn: bigint, slippageBps: number): Promise<EvmPoolBuyQuote> {
  try {
    return await evmPoolBuyQuoteTap({ chain: network, token, amountIn, slippageBps }, { quote: h.quote, venues: h.venues, indexPools: h.indexPools ?? (() => null) });
  } catch (e) {
    if (e instanceof EvmBuyTapRefused) return no(e.code, refusalRule(e));
    throw e;
  }
}

/** The pieces an EVM buy plans over (card buy-any-amount-on-every-chain; rules/pool.ts planEvmBuy) and the bound it keeps
 *  beside a rest, from the chain's ready proofs: those with an EVM W that no other tap holds (`claimed`), one a note (a
 *  proof on the epoch root first, one on the newest root, a note that landed this epoch, only beside none: card
 *  fresh-money-spendable-at-once), each with its relay fee under its chunk; the bound, one release's fee, the dearest
 *  piece's. One path: the tap (runEvmPoolBuy) and pool.buy.dry's buys (evmDryBuys) both plan over it. */
export function evmBuyPieces<R extends ReadyProof>(ready: readonly R[], claimed?: ReadonlySet<string>): { byNote: Map<string, R>; pieces: EvmBuyPiece[]; bound: bigint } {
  const list = ready.filter((p) => p.wallet.chain === "evm" && !claimed?.has(p.noteId)).sort((x, y) => (x.root === y.root ? 0 : x.root === "epoch" ? -1 : 1));
  const byNote = new Map<string, R>();
  for (const p of list) if (!byNote.has(p.noteId)) byNote.set(p.noteId, p);
  const pieces = [...byNote.values()].filter((p) => p.binding.feeCap < p.chunk).map((p) => ({ noteId: p.noteId, chunk: p.chunk, fee: p.binding.feeCap }));
  return { byNote, pieces, bound: pieces.reduce((m, p) => (p.fee > m ? p.fee : m), 0n) };
}

/** ETH's decimals (the kit's POOL_ASSET_DECIMALS): every amount of a Base or Robinhood pool.buy.dry. */
const ETH_DECIMALS = POOL_ASSET_DECIMALS.ETH;
/** pool.buy.dry's `amount` on Base and Robinhood (kit 1.16): a decimal of ETH (at most 18 places, 30 digits whole) in
 *  wei; null with none; undefined when it is not one (the kind answers not_allowed). */
export function evmDryAmount(x: unknown): bigint | null | undefined {
  if (x === undefined) return null;
  const m = typeof x === "string" ? new RegExp(`^(0|[1-9][0-9]{0,29})(?:\\.([0-9]{1,${ETH_DECIMALS}}))?$`).exec(x) : null;
  return m ? BigInt(m[1]!) * 10n ** BigInt(ETH_DECIMALS) + BigInt((m[2] ?? "").padEnd(ETH_DECIMALS, "0")) : undefined;
}

/** pool.buy.dry's `buys` on Base and Robinhood (kit 1.16, card buy-any-amount-on-every-chain), in whole ETH: for an ask of
 *  `amount` wei, above 0 and at most `tapMax` (state.pools' tap_max of the chain, whole ETH), what the tap spends in
 *  swaps: planEvmBuy over evmBuyPieces of the chain's `ready` proofs, as runEvmPoolBuy plans it. Null when that is the
 *  amount itself, with no amount, over tapMax (a tap that moves Cash first), or when the planner refuses. Display only:
 *  the tap plans again from its own proofs. */
export function evmDryBuys(chain: Chain, amount: bigint | null, tapMax: string, ready: readonly ReadyProof[]): string | null {
  const tap = evmDryAmount(tapMax);
  if (amount === null || amount <= 0n || typeof tap !== "bigint" || amount > tap) return null;
  const { pieces, bound } = evmBuyPieces(ready);
  let plan: EvmBuyPlan;
  try {
    plan = planEvmBuy({ kind: "pool.buy", chain, token: null, amount, slippageBps: 0, decimals: 0 }, pieces, bound);
  } catch (e) {
    if (e instanceof PoolRuleRefused) return null;
    throw e;
  }
  return plan.amount < amount ? poolUnits(plan.amount, ETH_DECIMALS) : null;
}

/** One pool.buy on an EVM chain: the ask is the user's own (rules/pool.ts checkPoolRequest passed it). The plan's legs
 *  (card buy-any-amount-on-every-chain): each whole note its own pool buy, the rest W's own (src/pool-buy-evm-rest.ts);
 *  every leg quoted, checked, signed and recorded before any is taken, every take before any send, so a leg that fails
 *  before the send sends nothing of the tap. The answer is the legs' ends together (legsEnd). */
export async function runEvmPoolBuy(h: EvmPoolBuyHost, ask: PoolAsk): Promise<EvmPoolBuyAnswer> {
  let seed: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  const claims: string[] = [];
  let taken = false;
  let posted = false;
  // the Ws this run follows until its reads end (h.following)
  const followed = new Set<string>();
  // this run's pending records, once written: removed if the run ends before anything left the device (review P2-B)
  type Written = { w: string; nullifier: bigint; deadlineMs: bigint };
  const written: Written[] = [];
  const hold = h.hold ?? (<T>(f: () => Promise<T>) => f());
  const clock = (): bigint => h.now?.() ?? BigInt(Date.now());
  const wait = h.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const live = (): boolean => h.signal?.aborted !== true;
  const stopped = (): boolean => h.stopped?.() === true;
  const settle = (): void => {
    try {
      h.settle();
    } catch {
      /* the state reads run it again */
    }
  };
  try {
    type Leg = ({ kind: "whole"; x: Watch } | { kind: "rest"; leg: RestLeg; st: RestState }) & { data: Uint8Array; r: Ready; nullifier: bigint };
    type Out = { answer: EvmPoolBuyAnswer } | { legs: (Leg & { refused: boolean })[]; plan: EvmBuyPlan; quoted: RestQuote };
    const out = await hold(async (): Promise<Out> => {
      if (ask.kind !== "pool.buy" || ask.chain !== h.chain || ask.token === null) return no("not_allowed");
      const token = ask.token;
      const network: EvmPoolChain = h.testnet ? (h.chain === "base" ? "base-sepolia" : "robinhood-testnet") : h.chain;
      if (h.pin.network !== network) return no("not_allowed");
      const pins = venuePins(h.venues, network);
      if (pins.pool === undefined || lower(pins.pool) !== lower(h.pin.pool)) return no("not_allowed");
      // the plan (card buy-any-amount-on-every-chain): the ask is the ETH that goes into swaps, made of whole notes
      // (rules/pool.ts planEvmBuy) over evmBuyPieces of the chain's ready proofs, as pool.buy.dry's buys reads it
      const { byNote, pieces, bound } = evmBuyPieces(await h.ready(), h.claimed);
      let plan: EvmBuyPlan;
      try {
        plan = planEvmBuy(ask, pieces, bound);
      } catch (e) {
        if (e instanceof PoolRuleRefused) return no("not_funded", refusalRule(e));
        throw e;
      }
      // a rest is bought by W's own call, its record in the wallet store: a page with no such store spends whole notes only
      if (plan.rest !== null && h.rest === undefined) return no("not_funded", "plan_legs");
      // every planned note claimed at once, before any read: no other tap of this page plans one of them
      const planned = [...plan.whole.map((p) => p.noteId), ...(plan.rest === null ? [] : [plan.rest.piece.noteId])];
      const proofs = planned.map((id) => byNote.get(id));
      if (proofs.some((r) => r === undefined)) return no("not_funded");
      for (const id of planned) {
        claims.push(id);
        h.claimed?.add(id);
      }
      // the device's own quote and build of `amountIn` (what a whole note's pool buy swaps, or the rest)
      const quoted = async (amountIn: bigint) => {
        const q = await quoteOf(h, network, token, amountIn, ask.slippageBps);
        const adapter = q.route.venue === "uniswap-v4" ? pins.v4 : pins.v3;
        if (adapter === undefined) return no("quote_check_failed", "adapter");
        return { q, adapter, built: h.build(adapter, q) };
      };
      // before W signs, so a read that fails leaves the notes HELD: the token's decimals, and where the read-backs start
      const decimals = await h.decimals(token);
      const heads = await Promise.all(h.rpcs.map((rpc) => evmHeadNumber(rpc)));
      const [lo, hi] = heads[0]! < heads[1]! ? [heads[0]!, heads[1]!] : [heads[1]!, heads[0]!];
      if (hi - lo > EVM_BUY_HEAD_SPREAD) return no();
      const from = lo > EVM_BUY_LAG_BLOCKS ? lo - EVM_BUY_LAG_BLOCKS : 0n;
      const legs: Leg[] = [];
      for (const r of proofs.slice(0, plan.whole.length) as Ready[]) {
        const relay = r.binding.request.relay;
        const fee = r.binding.feeCap;
        if (fee >= r.chunk) return no("not_funded");
        // the proof's own signals: its nullifier, value and context, the context the binding's
        const signals = r.publicSignals.map((s) => BigInt(s));
        const binding = { nullifier: signals[1]!, context: signals[7]!, value: signals[2]! };
        if (binding.context !== r.binding.context || binding.value !== r.chunk) return no();
        // the quote and the build: the device's own, for what the pool swaps (the chunk less the fee)
        const check = async () => {
          const { q, adapter, built } = await quoted(r.chunk - fee);
          const ctx = { nowMs: clock(), wallet: r.wallet.address, feeCap: fee, evm: { venues: h.venues, feeRecipient: h.pin.feeRecipient } };
          checkEvmBuy(built, h.pin.pool, binding, relay, ask, ctx, { token: q.token, amountIn: q.amountIn, amountOut: q.amountOut }, plan, h.testnet);
          return { q, adapter, built, ctx };
        };
        let { q, adapter, built, ctx } = await check();
        // W, from the seed, right before it signs: the proof's W and the relay data's recipient
        seed = await h.seed64();
        const w = freshWallet(seed, "evm", r.wallet.l, r.wallet.j);
        key = w.secretKey;
        seed.fill(0);
        if (lower(w.address) !== lower(r.wallet.address) || lower(relay.recipient) !== lower(w.address)) return no();
        // the reads and the seed since the quote: its block past EVM_QUOTE_MAX_AGE_MS on the device's clock is never
        // signed; the quote is read again, and the new one built, checked and signed (a failure signs nothing)
        if (clock() - q.block.timestamp * 1000n > BigInt(EVM_QUOTE_MAX_AGE_MS)) ({ q, adapter, built, ctx } = await check());
        const signature = signEvmBuy(key, ctx, built, h.pin.pool, binding);
        key.fill(0);
        const data = evmBuyCalldata(h.pin.pool, relay, r.proof, r.publicSignals, fee, built, signature);
        // W's holding, pending, before anything leaves: a write that fails sends nothing
        const want: EvmBuyWant = { nullifier: binding.nullifier, w: w.address, feeRecipient: h.pin.feeRecipient, token, minOut: built.minOut, value: r.chunk, feeCap: fee, deadlineMs: relay.deadlineMs };
        const buy: EvmPendingBuy = { nullifier: want.nullifier.toString(), from: from.toString(), deadlineMs: want.deadlineMs.toString(), minOut: want.minOut.toString(), value: want.value.toString(), feeCap: want.feeCap.toString(), feeRecipient: lower(want.feeRecipient) };
        const holding: EvmHolding = { mint: lower(token), decimals, chain: h.chain, state: "pending", route: { venue: q.route.venue, adapter: lower(adapter), path: q.route }, buy };
        // this page follows W from here: the load's follow leaves it to this run until the run's own reads end; a W
        // another follow already holds stays that follow's (this run's pending write is then refused: review P3-F)
        if (h.following !== undefined && !h.following.has(lower(w.address))) {
          h.following.add(lower(w.address));
          followed.add(lower(w.address));
        }
        await h.record(w.address, holding);
        written.push({ w: w.address, nullifier: want.nullifier, deadlineMs: want.deadlineMs });
        legs.push({ kind: "whole", x: { want, from, holding, w: w.address, stops: [null, null], none: null, mine: { noteId: r.noteId, attempt: r.attempt, chunk: r.chunk } }, data, r, nullifier: want.nullifier });
      }
      if (plan.rest !== null) {
        const r = proofs[plan.whole.length]!;
        const leg = await prepRest(h, ask, plan, r, quoted, from, clock);
        legs.push({ kind: "rest", leg, st: restState(), data: leg.data, r, nullifier: BigInt(r.publicSignals[1]!) });
      }
      // the takes, awaited before anything leaves: each this very attempt, or refused with the notes HELD
      for (const l of legs) {
        const got = await h.take(l.r.noteId, l.r.attempt, l.nullifier);
        taken = true;
        if (got.attempt !== l.r.attempt) return no();
      }
      // the sends: a busy helper waited out while the proof has more than the send margin left and no sign out started
      posted = true;
      const ends = await Promise.all(legs.map((l) => sendLeg(h, l.data, l.r, clock, wait, stopped)));
      const out = legs.map((l, i) => ({ ...l, refused: ends[i] === "refused" }));
      if (out.every((l) => l.refused)) return { legs: out, plan, quoted };
      h.sent?.();
      // a sign out started during the busy wait: the run ends "sent", and the settle pass decides at the next sign in
      if (stopped()) return { answer: { stage: "sent", txs: [] } };
      return { legs: out, plan, quoted };
    });
    if ("answer" in out) return out.answer;
    const { legs, plan, quoted } = out;
    const sentAt = clock();
    const tapMore = (): boolean => live() && clock() - sentAt < BigInt(EVM_BUY_SETTLE_MS);
    // each leg's tap end (null: none in the tap's time), and its follow past the answer with no answer owed
    type End = { stage: TradeStage; txs: TxRef[] };
    const follows = new Map<number, () => Promise<End | null>>();
    const taps = await Promise.all(
      legs.map(async (l, i): Promise<End | null> => {
        if (l.kind === "whole") {
          const x = l.x;
          const w = lower(x.w);
          const mine = followed.has(w);
          const slowAt = x.want.deadlineMs + BigInt(EVM_BUY_FOLLOW_MS);
          // W stays this run's to let go (the finally below) until its follow starts, which lets it go at its end
          const later = () => {
            followed.delete(w);
            return watch(h, x, live, (ms) => wait(clock() > slowAt ? EVM_BUY_SLOW_WAIT_MS : ms), clock, live).finally(() => void (mine && h.following?.delete(w)));
          };
          // a refusal is the helper's word, and the device never drops what it may own on a server's word: the leg
          // answers refused, its pending record stays, and the chain ends it (the follow: a Bought fills W's holding, no
          // release by the two-round final-block rule removes it, as the note's settle frees the note)
          if (l.refused) {
            follows.set(i, later);
            return { stage: "refused", txs: [] };
          }
          const tap = await watch(h, x, tapMore, wait, clock, live);
          if (tap === null) follows.set(i, later);
          return tap;
        }
        const slowAt = l.r.binding.request.relay.deadlineMs + BigInt(EVM_BUY_FOLLOW_MS);
        const later = () => finishRest(h, ask, plan, l.leg, l.st, quoted, live, (ms) => wait(clock() > slowAt ? EVM_BUY_SLOW_WAIT_MS : ms), clock, hold);
        if (l.refused) {
          follows.set(i, later);
          return { stage: "refused", txs: [] };
        }
        const tap = await finishRest(h, ask, plan, l.leg, l.st, quoted, tapMore, wait, clock, hold);
        if (tap === null) follows.set(i, later);
        return tap;
      }),
    );
    const answer = legsEnd(taps);
    if (follows.size === 0) return answer;
    // a sign out ended the tap's reads: no follow (the settle pass decides at the next sign in)
    if (!live()) return answer.stage === "refused" ? answer : { stage: "sent", txs: [] };
    const finals = taps.map((t, i) => follows.get(i)?.().catch(() => null) ?? Promise.resolve(t));
    void Promise.all(finals).then((ends) => {
      // null: a sign out ended the reads, so nothing is settled after it (review P2-2)
      if (ends.some((e) => e === null) || !live()) return;
      settle();
      const end = legsEnd(ends);
      // after a refusal the app was told refused: only a release the helper's word denied is news
      if (answer.stage !== "refused" || end.stage !== "not_landed") h.late?.(end);
    });
    return answer;
  } catch (e) {
    // past the post, only a true stage: the bytes may be on their way
    if (posted) return { stage: "sent", txs: [] };
    // nothing left the device (a take refused, or gave another attempt): the device's own knowledge, so this run's
    // pending records are removed (a removal that fails leaves it to the load's follow)
    for (const mine of written) await h.unrecord(mine.w, mine.nullifier, mine.deadlineMs).catch(() => {});
    if (e instanceof Refused) return e.rule === undefined ? { error: e.code } : { error: e.code, rule: e.rule };
    if (e instanceof PoolRuleRefused) return { error: "quote_check_failed", rule: refusalRule(e) };
    if ((e as { name?: unknown })?.name === "EvmQuoteError" || (e as { name?: unknown })?.name === "EvmPoolBuyError") return { error: "quote_check_failed", rule: refusalRule(e) };
    return { error: "failed" };
  } finally {
    (seed as Uint8Array | null)?.fill(0);
    (key as Uint8Array | null)?.fill(0);
    for (const c of claims) h.claimed?.delete(c);
    // no follow of this run's own goes on: a pending it left is the load's follow's (followPendingEvmBuys)
    for (const w of followed) h.following?.delete(w);
    // a taken note is ended only by the settle: started on every exit past the take, but never once a sign out has
    // started (its pass would wait on the seed's lock the sign out takes): the next sign in's settles it
    if (taken && live() && !stopped()) settle();
  }
}

/** The legs' ends as one: filled when every leg filled; part_filled when one filled and none is still on its way; sent
 *  while one is (or ended unread); else refused when one was, and not_landed. Every leg's transactions. */
export function legsEnd(ends: readonly ({ stage: TradeStage; txs: TxRef[] } | null)[]): { stage: TradeStage; txs: TxRef[] } {
  const txs = ends.flatMap((e) => e?.txs ?? []);
  const st = ends.map((e) => e?.stage ?? "sent");
  if (st.every((s) => s === "filled")) return { stage: "filled", txs };
  if (st.some((s) => s === "sent" || s === "signed")) return { stage: "sent", txs };
  if (st.some((s) => s === "filled" || s === "part_filled")) return { stage: "part_filled", txs };
  if (st.some((s) => s === "refused")) return { stage: "refused", txs };
  return { stage: "not_landed", txs };
}

/** One leg's send (evm-send.ts evmPoolSend): "refused" only on the helper's coded refusal of the first POST; else
 *  "sent" (a 200, or no answer: the bytes may be on their way). A busy helper is asked again after its wait while the
 *  proof has more than the send margin left and no sign out started. */
async function sendLeg(h: EvmPoolBuyHost, data: Uint8Array, r: Ready, clock: () => bigint, wait: (ms: number) => Promise<void>, stopped: () => boolean): Promise<"sent" | "refused"> {
  let busied = false;
  for (;;) {
    try {
      await h.send({ pool: h.pin.pool, data, epoch: r.epochStartMs });
      return "sent";
    } catch (e) {
      // a coded refusal is one only on the first POST: after a busy answer an earlier POST's bytes may be on their way
      // (the helper answers 429 when one of its sends took them, then 422 on the spent nullifier), so the chain
      // decides (review P2-3)
      if (e instanceof EvmSendRefused && !busied) return "refused";
      if (e instanceof EvmSendBusy && !stopped() && clock() + BigInt(e.retryAfterMs) < r.deadlineMs - EVM_SEND_MARGIN_MS) {
        busied = true;
        // the helper's own Retry-After (evmPoolSend caps it at EVM_SEND_RETRY_MAX_S), at least 1 s, in slices a sign
        // out ends
        for (let left = Math.max(e.retryAfterMs, 1_000); left > 0 && !stopped(); left -= STOP_POLL_MS) await wait(Math.min(STOP_POLL_MS, left));
        if (!stopped()) continue;
      }
      // no answer, or a sign out started: the bytes may be on their way
      return "sent";
    }
  }
}

/** The read-back's state, the tap's and the follow's: each RPC's `stop` (EvmReleaseRead), and when the first round of
 *  "no release, past the deadline" in a row was read. */
type Watch = { want: EvmBuyWant; from: bigint; holding: EvmHolding; w: string; stops: [bigint | null, bigint | null]; none: bigint | null; mine?: { noteId: string; attempt: string; chunk: bigint } };

/** The read-back's rounds while `more()`: the pool's releases on both RPCs, the verdict on them, and its records: the
 *  end's answer, or null when none came in time or a sign out (`live`) ended the reads, after which nothing is
 *  written. A read that fails is that round's no answer. Not_landed with no release needs two rounds of it at least
 *  EVM_BUY_LAG_MS apart, with no other verdict between them. */
async function watch(h: EvmPoolBuyHost, x: Watch, more: () => boolean, wait: (ms: number) => Promise<void>, clock: () => bigint, live: () => boolean): Promise<{ stage: TradeStage; txs: TxRef[] } | null> {
  for (let i = 0; i === 0 || more(); i++) {
    if (i > 0) await wait(EVM_BUY_WAIT_MS);
    let v: EvmBuyVerdict;
    try {
      const reads = (await Promise.all(h.rpcs.map((rpc, k) => evmReleaseRead(rpc, h.pin.pool, x.from, x.want.deadlineMs, x.stops[k]!)))) as [EvmReleaseRead, EvmReleaseRead];
      x.stops = [reads[0].stop, reads[1].stop];
      v = evmBuyVerdict(reads, x.want);
    } catch {
      continue;
    }
    // a sign out while the reads ran: nothing written after it (review P2-2)
    if (!live()) return null;
    if (v?.end === "not_landed" && v.release === null) {
      const at = clock();
      if (x.none === null) x.none = at;
      if (at - x.none < BigInt(EVM_BUY_LAG_MS)) continue;
      // the chain said it never landed: this run's pending record is removed with the verdict, so the note can buy
      // again (a removal that fails leaves it: the next buy is refused and the next load's follow tries again)
      await h.unrecord(x.w, x.want.nullifier, x.want.deadlineMs).catch(() => {});
      return { stage: "not_landed", txs: [] };
    }
    x.none = null;
    if (v === null) continue;
    if (v.end === "not_landed") {
      // the nullifier released to another W (the note spent elsewhere: another device on the same words): nothing of
      // it is W's, so the record ends too (review P3-D)
      await h.unrecord(x.w, x.want.nullifier, x.want.deadlineMs).catch(() => {});
      return { stage: "not_landed", txs: [] };
    }
    const txs: TxRef[] = [{ chain: h.chain, hash: v.release.tx }];
    const at = { ...x.holding.route, tx: v.release.tx, block: v.release.block.toString() };
    // this run's own release landed: its note's chunk (the device's, never the chain's word) is out of the pool
    if (x.mine !== undefined) h.landed?.(x.mine.noteId, x.mine.attempt, x.mine.chunk, v.release.block);
    if (v.end === "filled") {
      await h.record(x.w, { ...x.holding, state: "filled", received: poolUnits(v.release.out, x.holding.decimals), route: at }).catch(() => {});
      return { stage: "filled", txs };
    }
    // withdrawn: W holds the chunk less the fee in ETH; the buy did not fill. The carry puts it back into the pool, from
    // the chain's own release (no record of this run is its source: a write that fails here loses nothing)
    await h.record(x.w, { ...x.holding, state: "withdrawn", route: at }).catch(() => {});
    try {
      h.carry?.();
    } catch {
      /* the next state read runs it */
    }
    return { stage: "refused", txs };
  }
  return null;
}

const big = (v: unknown): bigint | null => (typeof v === "string" && /^[0-9]{1,78}$/.test(v) ? BigInt(v) : null);

/**
 * The load's follow of pending buys (the tab that sent one may have closed before its end): each W's holding on this
 * chain still pending with its buy written, that no run of this page follows, is read on the chain from the record's
 * own block range until an end, as the run's own follow reads it (watch): filled or withdrawn completes it, not_landed
 * by the two-round final-block rule removes it, so a pending never stays for good and the note can buy again. Runs once per W
 * at a time (h.following); a sign out (h.signal) ends it with nothing written. Started on each state read
 * (src/pool-testnet.ts); never awaited.
 */
export async function followPendingEvmBuys(h: EvmPoolBuyHost): Promise<void> {
  const all = await h.holdings();
  const live = (): boolean => h.signal?.aborted !== true;
  const clock = (): bigint => h.now?.() ?? BigInt(Date.now());
  const wait = h.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runs: Promise<unknown>[] = [];
  // both RPCs' newest blocks, read once and only when a record is to be followed
  let heads: Promise<bigint[] | null> | undefined;
  for (const [w, v] of Object.entries(all)) {
    const rec = v as Partial<EvmHolding> | null;
    const b = rec?.buy;
    // a record this device never writes is left as it is, unread (review P3-G): decimals not an integer 0 to
    // TOKEN_DECIMALS_MAX (the run writes the token's own, as the rule reads it), or a start block under the pool's
    // deploy or past both RPCs' newest (the run writes the lower newest less EVM_BUY_LAG_BLOCKS), which no read could end
    if (rec?.state !== "pending" || rec.chain !== h.chain || typeof rec.mint !== "string" || !Number.isInteger(rec.decimals) || rec.decimals! < 0 || rec.decimals! > TOKEN_DECIMALS_MAX || b === undefined) continue;
    const nullifier = big(b.nullifier), from = big(b.from), deadlineMs = big(b.deadlineMs), minOut = big(b.minOut), value = big(b.value), feeCap = big(b.feeCap);
    if (nullifier === null || from === null || deadlineMs === null || minOut === null || value === null || feeCap === null) continue;
    const key = lower(w);
    // a W this page follows already: no read at all (review P3-3)
    if (from < h.pin.fromBlock || h.following?.has(key) || !live()) continue;
    heads ??= Promise.all(h.rpcs.map((rpc) => evmHeadNumber(rpc))).catch(() => null);
    const hs = await heads;
    if (hs === null || hs.some((n) => from > n) || h.following?.has(key) || !live()) continue;
    h.following?.add(key);
    // the fee recipient is the pin's, never the record's
    const want: EvmBuyWant = { nullifier, w, feeRecipient: h.pin.feeRecipient, token: rec.mint, minOut, value, feeCap, deadlineMs };
    // the buy's note, from the mark its take wrote (a tab on an earlier release wrote none): its release read back counts
    // only the note's change, in this tab too
    const note = await (h.noteOf?.(nullifier) ?? Promise.resolve(null)).catch(() => null);
    const x: Watch = { want, from, holding: rec as EvmHolding, w, stops: [null, null], none: null, ...(note === null ? {} : { mine: { ...note, chunk: value } }) };
    const slowAt = deadlineMs + BigInt(EVM_BUY_FOLLOW_MS);
    runs.push(
      watch(h, x, live, (ms) => wait(clock() > slowAt ? EVM_BUY_SLOW_WAIT_MS : ms), clock, live)
        .then((a) => {
          if (a !== null && live()) h.settle();
        })
        .catch(() => {})
        .finally(() => h.following?.delete(key)),
    );
  }
  await Promise.all(runs);
}

/** What the page gives an EVM buy (src/pool-testnet.ts): its chain's queue, the seed, the wallet store while one is
 *  open (`held`: never opened by the buy, so a write after a sign out fails), the chain's RESERVED settle, the
 *  follows' sign-out signal and this tab's count of sign outs (`stopped`). */
export type EvmBuyPage = {
  /** The page's Ws whose buy a run or the load's follow is following now (one set for the page). */
  following?: Set<string>;
  queue(): Promise<ProofQueue<EvmPoolRequest>>;
  seed64(): Promise<Uint8Array>;
  held(): Promise<WalletStore>;
  settle(): void;
  testnet: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  stopped?(): boolean;
  /** The notes' marks as stored (../../wallet/src/notes/store.ts readReservedMarks), for noteOf. */
  marks(): Promise<ReadonlyMap<string, ReservedMark>>;
  /** EvmPoolBuyHost.landed: the page's balance counts the note's change from here. */
  landed?(noteId: string, attempt: string, withdrawn: bigint, block: bigint): void;
  /** EvmPoolBuyHost.carry: the chain's carry pass. */
  carry?(chain: Chain): void;
};

/** Whether `was`, W's holding, is an earlier buy of the note `now` buys: pending, the same nullifier, an earlier
 *  deadline. */
const endedBefore = (was: unknown, now: EvmHolding): boolean => {
  const b = (was as Partial<EvmHolding> | null)?.buy;
  const n = (x: unknown) => (typeof x === "string" && /^\d{1,20}$/.test(x) ? BigInt(x) : null);
  const [then, at] = [n(b?.deadlineMs), n(now.buy?.deadlineMs)];
  return (was as Partial<EvmHolding>)?.state === "pending" && b?.nullifier === now.buy?.nullifier && b?.nullifier !== undefined && then !== null && at !== null && then < at;
};

/** A W that already has a holding: the pending write is refused, so nothing is sent (review P3-7). */
export class EvmHoldingTaken extends Error {
  constructor() {
    super("W already has a holding");
    this.name = "EvmHoldingTaken";
  }
}

/** The page's host for one EVM buy run: the kit's quote, build and venue list, the helper's send, the pool's pair for
 *  the token's decimals and the read-back, W's holding in the wallet store's meta, the page's carry. */
export function evmBuyHost(chain: Chain, pin: EvmPoolPin, rpcs: readonly [EvmRpc, EvmRpc], claimed: Set<string>, page: EvmBuyPage): EvmPoolBuyHost {
  return {
    chain,
    testnet: page.testnet,
    pin,
    venues: evmPoolVenues(),
    rpcs,
    // none ready: a pass starts for the next tap
    ready: async () => {
      const q = await page.queue();
      const list = q.ready();
      if (list.length === 0) void q.refresh().catch(() => {});
      return list;
    },
    take: async (id, attempt, nullifier) => (await page.queue()).take(id, attempt, undefined, undefined, nullifier),
    noteOf: async (nullifier) => {
      for (const [noteId, m] of await page.marks()) if (m.nullifier === nullifier) return { noteId, attempt: m.attempt };
      return null;
    },
    seed64: page.seed64,
    quote: evmPoolBuyQuote,
    indexPools: evmPoolIndexPools,
    build: evmPoolBuildQuoted,
    // the page's kept decimals (pool-kinds.ts keptTokenDecimals: read on both RPCs and kept, so a sell after it reads none);
    // no wait here: this read falls between the buy's quote check and W's signature, and fails fast as the heads read does
    decimals: (token) => keptTokenDecimals(chain, token, rpcs as readonly [PoolRpc, PoolRpc], { waits: 0 }),
    send: (body) => evmPoolSend(TRADE_HELPER, body, page.fetch),
    settle: page.settle,
    // the pending write, before anything leaves, refuses a W that already has a holding (another tab's run of the same
    // note, whose token it would overwrite); an end's write completes this run's own. One holding is not in the way: an
    // earlier buy of this same note (its nullifier) at an earlier deadline, still pending. The note was proved again, so
    // the pool's round freed it (wallet src/pool/evm-settle.ts: both RPCs agree on a block past that deadline with no
    // release of it, PrivacyPool.sol:241 refusing it from then on): that buy can never land, and its record, which waits
    // for the final block to end (src/evm-send.ts evmReleaseRead), never holds the note's money that long
    record: async (w, holding) => {
      const store = await page.held();
      await store.update("meta", EVM_POSITION_COSTS_KEY, (v) => {
        const all = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
        if (holding.state === "pending" && all[w] !== undefined && !endedBefore(all[w], holding)) throw new EvmHoldingTaken();
        return { ...all, [w]: holding };
      });
    },
    // only this run's own pending record, by W and its buy's nullifier and deadline; never another holding on that W
    unrecord: async (w, nullifier, deadlineMs) => {
      const store = await page.held();
      await store.update("meta", EVM_POSITION_COSTS_KEY, (v) => {
        const all = typeof v === "object" && v !== null ? { ...(v as Record<string, unknown>) } : {};
        const mine = all[w] as Partial<EvmHolding> | undefined;
        if (mine?.state === "pending" && mine.buy?.nullifier === nullifier.toString() && mine.buy.deadlineMs === deadlineMs.toString()) delete all[w];
        return all;
      });
    },
    rest: async (w, rec) => {
      const store = await page.held();
      await store.update("meta", EVM_WBUY_KEY, (v) => mergeRest(v, w, rec));
    },
    holdings: async () => {
      const v = await (await page.held()).get("meta", EVM_POSITION_COSTS_KEY);
      return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    },
    following: page.following,
    ...(page.carry ? { carry: () => page.carry!(chain) } : {}),
    claimed,
    signal: page.signal,
    stopped: page.stopped,
    landed: page.landed,
  };
}

type Locks = Pick<LockManager, "request">;

/** The pool.buy kind on an EVM chain: one run per tap; the part up to the send under the seed's shared lock (sign out
 *  waits for it), the read-back outside it. Answered "sent" once the bytes have left the device, or with the run's own
 *  answer; the run's stage goes out as progress too, and an end the reads find past the tap's bound (`late`) as well. */
export function poolBuyEvmKind(host: () => EvmPoolBuyHost & { end?(): void }, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk, ctx: KindContext | null): HostRefusal | Running<"pool.buy"> => {
    if (ask.kind !== "pool.buy" || (ask.chain !== "base" && ask.chain !== "robinhood") || !locks) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.buy"> | HostRefusal | null = null;
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    const run = duringTrade(locks, async () => {
      const h = host();
      try {
        const a = await runEvmPoolBuy(
          {
            ...h,
            hold: (f) => locks.request(WALLET_SEED_LOCK, { mode: "shared" }, f),
            sent: () => {
              if (!answer) answer = { result: { stage: "sent", txs: [] } };
              give();
            },
            late: (x) => ctx?.progress(x.stage),
          },
          ask,
        );
        if (!answer) answer = "error" in a ? (a.rule === undefined ? { error: a.error } : { error: a.error, rule: a.rule }) : { result: a };
        if ("stage" in a) ctx?.progress(a.stage);
      } finally {
        h.end?.();
      }
    })
      .catch(() => {
        if (!answer) answer = { error: "failed" };
      })
      .finally(give);
    void run;
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
