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
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { evmPoolBuyQuote, evmPoolIndexPools, EVM_QUOTE_MAX_AGE_MS, type EvmPoolBuyQuote, type EvmPoolBuyQuoteRequest, type EvmPoolKey } from "../../kit/src/checks/evm/quote.ts";
import { evmHookListed } from "../../kit/src/trade/evm/sell-unpinned.ts";
import { evmPoolVenues, venuePins, type EvmPoolBuy, type EvmPoolChain, type EvmPoolVenueList, type EvmRoute } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolBuildQuoted } from "../../kit/src/trade/evm/buy.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import type { ReservedMark } from "../../wallet/src/notes/store.ts";
import { EVM_LAG_TRIES, EVM_LAG_WAIT_MS, EVM_SEND_MARGIN_MS, type EvmPoolPin, type EvmPoolRequest, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import type { ProofQueue } from "../../wallet/src/pool/queue.ts";
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import { checkEvmBuy, PoolRuleRefused, poolUnits, signEvmBuy, TOKEN_DECIMALS_MAX, type PoolAsk } from "./rules/pool.ts";
import { EvmSendBusy, EvmSendRefused, evmBuyCalldata, evmBuyVerdict, evmHeadNumber, evmPoolSend, evmReleaseRead, type EvmBuyVerdict, type EvmBuyWant, type EvmReleaseRead } from "./evm-send.ts";
import { keptTokenDecimals, type PoolRpc } from "./pool-kinds.ts";
import { TRADE_HELPER } from "./trade.ts";
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

export type EvmPoolBuyAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "quote_check_failed" | "failed" };

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
/** The standard v4 (fee, tick spacing) pairs and v3 fee tiers the first quote asks in turn (the kit's own standard set,
 *  checks/evm/quote.ts V4_KEYS and V3_FEES). */
const V4_FIRST: readonly (readonly [number, number])[] = [[3000, 60], [10000, 200], [500, 10], [100, 1]];
const V3_FIRST: readonly number[] = [3000, 500, 10000, 100];
const ZERO = "0x0000000000000000000000000000000000000000";
const REQUOTE = new Set(["below_reference", "native_first", "over_gas_floor", "no_quote"]);

type Code = Exclude<EvmPoolBuyAnswer, { stage: TradeStage }>["error"];
class Refused extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(code);
    this.code = code;
  }
}
const no = (code: Code = "failed"): never => {
  throw new Refused(code);
};
const lower = (s: string): string => s.toLowerCase();

/** The route that last quoted per chain and token, this page's session: a tap asks it first (one quote a tap). */
const LAST_ROUTE = new Map<string, EvmRoute>();
/** For the tests: forgets every token's last route. */
export const evmLastRouteReset = (): void => LAST_ROUTE.clear();

/** The device's quote of the ask, one quote where it can (card evm-buy-and-sell-on-mainnet: 8 standard shapes asked in
 *  turn were 8 quotes a tap, and a token whose pools are a launchpad's answered no_quote on all 8):
 *  - first, the route that last quoted for the token this session;
 *  - else, with the chain's pool index served, the first of the token's own v4 pools in it that a buy may take: paired
 *    with the native asset or WETH, and hookless or a launchpad hook the venue lists with that launchpad's fee and tick
 *    spacing (the kit's one rule, sell-unpinned.ts evmHookListed, the sell builder's: a coin bought through another hook
 *    could have no route out). With no index: the first standard hookless shape;
 *  - then the first standard v3 fee tier (the index holds v4 pools only).
 *  A refusal that names the kit's own best route (REQUOTE) asks that route once where the same hook rule takes it: the
 *  kit's best route holds every other shape, so three quotes a tap at most. No route the rules take at all (the
 *  index holds pools of the token, none a buy may take, and no v3 pool quotes): not_allowed, the page does not trade
 *  the coin; any other refusal of every route: quote_check_failed. */
async function quoteOf(h: EvmPoolBuyHost, network: EvmPoolChain, token: string, amountIn: bigint, slippageBps: number): Promise<EvmPoolBuyQuote> {
  const v = h.venues[network];
  if (v === undefined) return no("not_allowed");
  const t = lower(token);
  const weth = lower(v.weth);
  const known = `${network}:${t}`;
  const v4Of = (k: EvmPoolKey): EvmRoute | null => {
    const other = k.currency0 === t ? k.currency1 : k.currency1 === t ? k.currency0 : null;
    if (other === null || (other !== ZERO && other !== weth)) return null;
    if (k.hooks !== ZERO && !evmHookListed(network, k.hooks, k.fee, k.tickSpacing)) return null;
    return { venue: "uniswap-v4", currencyIn: other, hops: [{ currency: t, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, hookData: "0x" }] };
  };
  const indexed = h.indexPools?.(network, t) ?? null;
  const v4: EvmRoute[] =
    indexed !== null ? indexed.flatMap((k) => v4Of(k) ?? [])
    : [
        ...V4_FIRST.map(([fee, tickSpacing]): EvmRoute => ({ venue: "uniswap-v4", currencyIn: ZERO, hops: [{ currency: t, fee, tickSpacing, hooks: ZERO, hookData: "0x" }] })),
        ...(v.hookedPools ?? []).map((p): EvmRoute => ({ venue: "uniswap-v4", currencyIn: p.from === "native" ? ZERO : weth, hops: [{ currency: t, fee: p.fee, tickSpacing: p.tickSpacing, hooks: lower(p.hooks), hookData: "0x" }] })),
      ];
  const v3 = V3_FIRST.map((fee): EvmRoute => ({ venue: "uniswap-v3", tokens: [v.weth, t], fees: [fee] }));
  const last = LAST_ROUTE.get(known);
  const seen = new Set<string>();
  const shapes = [...(last === undefined ? [] : [last]), ...v4, ...v3].filter((r) => {
    const k = JSON.stringify(r);
    return !seen.has(k) && (seen.add(k), true);
  });
  const ask = async (route: EvmRoute) => {
    const q = await h.quote({ chain: network, token, amountIn, slippageBps, route });
    LAST_ROUTE.set(known, q.route);
    return q;
  };
  // three kit quotes a tap at most, however many pools the index holds (anyone can make pools: CASHCAT's 160 hookless
  // spam-fee pools on Robinhood took 62 quotes and 144 s, 2026-11-13): the first shape, then the first v3 tier, and
  // after a refusal that names the kit's own best route, that route once where the page's hook rule takes it (v4Of's:
  // from the native asset or WETH, every hop hookless or a listed launchpad's)
  const takes = (r: EvmRoute) =>
    r.venue === "uniswap-v3" || ((r.currencyIn === ZERO || lower(r.currencyIn) === weth) && r.hops.every((p) => p.hooks === ZERO || evmHookListed(network, p.hooks, p.fee, p.tickSpacing)));
  const tries = [shapes[0]!, ...shapes.slice(1).filter((r) => r.venue === "uniswap-v3").slice(0, 1)];
  let refused = false;
  for (const route of tries) {
    try {
      return await ask(route);
    } catch (e) {
      const err = e as { code?: unknown; reference?: { route: EvmRoute } | null };
      if (typeof err?.code === "string" && REQUOTE.has(err.code) && err.reference && takes(err.reference.route)) return ask(err.reference.route);
      if (err?.code === "rpc_error" || err?.code === "rpc_disagree" || err?.code === "stale_quote") throw e;
      if (err?.code !== "no_quote") refused = true;
    }
  }
  // a kept route that quotes no more is asked last no more
  LAST_ROUTE.delete(known);
  // pools of the token, none a buy may take, and nothing else quotes: a coin the page does not trade
  return no(!refused && indexed !== null && indexed.length > 0 && v4.length === 0 ? "not_allowed" : "quote_check_failed");
}
/** The tap's own quote (quoteOf) with only what it reads: the venue list, the kit's quote and the index's pools; for
 *  the read-only live check (scripts/live-checks/evm-buy-and-sell-on-mainnet.mjs), which signs nothing. */
export const evmBuyQuoteOf = (h: Pick<EvmPoolBuyHost, "venues" | "quote" | "indexPools">, network: EvmPoolChain, token: string, amountIn: bigint, slippageBps: number): Promise<EvmPoolBuyQuote> =>
  quoteOf(h as EvmPoolBuyHost, network, token, amountIn, slippageBps);

/** One pool.buy on an EVM chain: the ask is the user's own (rules/pool.ts checkPoolRequest passed it). */
export async function runEvmPoolBuy(h: EvmPoolBuyHost, ask: PoolAsk): Promise<EvmPoolBuyAnswer> {
  let seed: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  let claim: string | null = null;
  let taken = false;
  let posted = false;
  // the W this run follows until its reads end (h.following)
  let followed: string | null = null;
  // this run's pending record, once written: removed if the run ends before anything left the device (review P2-B)
  type Written = { w: string; nullifier: bigint; deadlineMs: bigint };
  let written: Written | null = null;
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
    type Out = { answer: EvmPoolBuyAnswer } | { watch: Watch } | { refused: Watch };
    const out = await hold(async (): Promise<Out> => {
      if (ask.kind !== "pool.buy" || ask.chain !== h.chain || ask.token === null) return no("not_allowed");
      const token = ask.token;
      const network: EvmPoolChain = h.testnet ? (h.chain === "base" ? "base-sepolia" : "robinhood-testnet") : h.chain;
      if (h.pin.network !== network) return no("not_allowed");
      const pins = venuePins(h.venues, network);
      if (pins.pool === undefined || lower(pins.pool) !== lower(h.pin.pool)) return no("not_allowed");
      // the proof: its chunk the ask's amount, its W an EVM one, no other tap's; claimed at once
      // a proof on the epoch root first; one on the newest root (a note that landed this epoch) only when none is the
      // amount (card fresh-money-spendable-at-once)
      const r = (await h.ready()).filter((p) => p.wallet.chain === "evm" && p.chunk === ask.amount && !h.claimed?.has(p.noteId)).sort((x, y) => (x.root === y.root ? 0 : x.root === "epoch" ? -1 : 1))[0];
      if (r === undefined) return no("not_funded");
      claim = r.noteId;
      h.claimed?.add(claim);
      const relay = r.binding.request.relay;
      const fee = r.binding.feeCap;
      if (fee >= r.chunk) return no("not_funded");
      // the proof's own signals: its nullifier, value and context, the context the binding's
      const signals = r.publicSignals.map((s) => BigInt(s));
      const binding = { nullifier: signals[1]!, context: signals[7]!, value: signals[2]! };
      if (binding.context !== r.binding.context || binding.value !== r.chunk) return no();
      // the quote and the build: the device's own, for what the pool swaps (the chunk less the fee)
      const quoted = async () => {
        const q = await quoteOf(h, network, token, r.chunk - fee, ask.slippageBps);
        const adapter = q.route.venue === "uniswap-v4" ? pins.v4 : pins.v3;
        if (adapter === undefined) return no("quote_check_failed");
        const built = h.build(adapter, q);
        const ctx = { nowMs: clock(), wallet: r.wallet.address, feeCap: fee, evm: { venues: h.venues, feeRecipient: h.pin.feeRecipient } };
        checkEvmBuy(built, h.pin.pool, binding, relay, ask, ctx, { token: q.token, amountIn: q.amountIn, amountOut: q.amountOut }, h.testnet);
        return { q, adapter, built, ctx };
      };
      let { q, adapter, built, ctx } = await quoted();
      // before W signs, so a read that fails leaves the note HELD: the token's decimals, and where the read-back starts
      const decimals = await h.decimals(token);
      const heads = await Promise.all(h.rpcs.map((rpc) => evmHeadNumber(rpc)));
      const [lo, hi] = heads[0]! < heads[1]! ? [heads[0]!, heads[1]!] : [heads[1]!, heads[0]!];
      if (hi - lo > EVM_BUY_HEAD_SPREAD) return no();
      const from = lo > EVM_BUY_LAG_BLOCKS ? lo - EVM_BUY_LAG_BLOCKS : 0n;
      // W, from the seed, right before it signs: the proof's W and the relay data's recipient
      seed = await h.seed64();
      const w = freshWallet(seed, "evm", r.wallet.l, r.wallet.j);
      key = w.secretKey;
      seed.fill(0);
      if (lower(w.address) !== lower(r.wallet.address) || lower(relay.recipient) !== lower(w.address)) return no();
      // the reads and the seed since the quote: its block past EVM_QUOTE_MAX_AGE_MS on the device's clock is never
      // signed; the quote is read again, and the new one built, checked and signed (a failure signs nothing)
      if (clock() - q.block.timestamp * 1000n > BigInt(EVM_QUOTE_MAX_AGE_MS)) ({ q, adapter, built, ctx } = await quoted());
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
        followed = lower(w.address);
      }
      await h.record(w.address, holding);
      written = { w: w.address, nullifier: want.nullifier, deadlineMs: want.deadlineMs };
      // the take, awaited before anything leaves: this very attempt, or refused with the note HELD
      const got = await h.take(r.noteId, r.attempt, want.nullifier);
      taken = true;
      if (got.attempt !== r.attempt) return no();
      const mine = { noteId: r.noteId, attempt: r.attempt, chunk: r.chunk };
      // the send: a busy helper waited out while the proof has more than the send margin left and no sign out started
      posted = true;
      let busied = false;
      for (;;) {
        try {
          await h.send({ pool: h.pin.pool, data, epoch: r.epochStartMs });
          break;
        } catch (e) {
          // a coded refusal is one only on the first POST: after a busy answer an earlier POST's bytes may be on their way
          // (the helper answers 429 when one of its sends took them, then 422 on the spent nullifier), so the chain
          // decides (review P2-3)
          if (e instanceof EvmSendRefused && !busied) {
            // a refusal is the helper's word, and the device never drops what it may own on a server's word: the run
            // answers refused, its pending record stays, and the chain ends it (the follow below: a Bought fills W's
            // holding, no release by the two-round final-block rule removes it, as the note's settle frees the note)
            return { refused: { want, from, holding, w: w.address, stops: [null, null], none: null, mine } };
          }
          if (e instanceof EvmSendBusy && !stopped() && clock() + BigInt(e.retryAfterMs) < r.deadlineMs - EVM_SEND_MARGIN_MS) {
            busied = true;
            // the helper's own Retry-After (evmPoolSend caps it at EVM_SEND_RETRY_MAX_S), at least 1 s, in slices a sign
            // out ends
            for (let left = Math.max(e.retryAfterMs, 1_000); left > 0 && !stopped(); left -= STOP_POLL_MS) await wait(Math.min(STOP_POLL_MS, left));
            if (!stopped()) continue;
          }
          // no answer, or a sign out started: the bytes may be on their way
          break;
        }
      }
      h.sent?.();
      // a sign out started during the busy wait: the run ends "sent", and the settle pass decides at the next sign in
      if (stopped()) return { answer: { stage: "sent", txs: [] } };
      return { watch: { want, from, holding, w: w.address, stops: [null, null], none: null, mine } };
    });
    if ("answer" in out) return out.answer;
    // on past the answer with no answer owed: W's reads until the chain ends the pending record
    const follow = (x: Watch, refused: boolean): void => {
      const slowAt = x.want.deadlineMs + BigInt(EVM_BUY_FOLLOW_MS);
      const mine = followed;
      followed = null;
      void watch(h, x, live, (ms) => wait(clock() > slowAt ? EVM_BUY_SLOW_WAIT_MS : ms), clock, live)
        .finally(() => void (mine !== null && h.following?.delete(mine)))
        .then((a) => {
          // null: a sign out ended the reads, so nothing is settled after it (review P2-2)
          if (a === null || !live()) return;
          settle();
          // after a refusal the app was told refused: only a release the helper's word denied is news
          if (!refused || a.stage !== "not_landed") h.late?.(a);
        })
        .catch(() => {});
    };
    if ("refused" in out) {
      if (live()) follow(out.refused, true);
      return { stage: "refused", txs: [] };
    }
    // the read-back, outside the lock: the tap's part, then on past it with no answer owed
    const sentAt = clock();
    const tap = await watch(h, out.watch, () => live() && clock() - sentAt < BigInt(EVM_BUY_SETTLE_MS), wait, clock, live);
    if (tap !== null) return tap;
    // a sign out ended the tap's reads: no follow
    if (!live()) return { stage: "sent", txs: [] };
    follow(out.watch, false);
    return { stage: "sent", txs: [] };
  } catch (e) {
    // past the post, only a true stage: the bytes may be on their way
    if (posted) return { stage: "sent", txs: [] };
    // nothing left the device (the take refused, or gave another attempt): the device's own knowledge, so this run's
    // pending record is removed (a removal that fails leaves it to the load's follow)
    const mine = written as Written | null;
    if (mine !== null) await h.unrecord(mine.w, mine.nullifier, mine.deadlineMs).catch(() => {});
    if (e instanceof Refused) return { error: e.code };
    if (e instanceof PoolRuleRefused) return { error: "quote_check_failed" };
    if ((e as { name?: unknown })?.name === "EvmQuoteError" || (e as { name?: unknown })?.name === "EvmPoolBuyError") return { error: "quote_check_failed" };
    return { error: "failed" };
  } finally {
    (seed as Uint8Array | null)?.fill(0);
    (key as Uint8Array | null)?.fill(0);
    if (claim !== null) h.claimed?.delete(claim);
    // no follow of this run's own goes on: a pending it left is the load's follow's (followPendingEvmBuys)
    if (followed !== null) h.following?.delete(followed);
    // a taken note is ended only by the settle: started on every exit past the take, but never once a sign out has
    // started (its pass would wait on the seed's lock the sign out takes): the next sign in's settles it
    if (taken && live() && !stopped()) settle();
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
    const run = (async () => {
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
        if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
        if ("stage" in a) ctx?.progress(a.stage);
      } finally {
        h.end?.();
      }
    })()
      .catch(() => {
        if (!answer) answer = { error: "failed" };
      })
      .finally(give);
    void run;
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
