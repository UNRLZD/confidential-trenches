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
//   providers; a read names the token, never W. The request names no route, so the device asks the standard pool
//   shapes in turn (v4 native, then v3 WETH, each fee tier), and a quote the kit refuses below its own best
//   (below_reference, native_first, over_gas_floor) is asked again on that best route, once.
// - Built by the kit (evmPoolBuildQuoted, through the chain's pinned adapter for the route's venue), checked by the
//   rule (checkEvmBuy: the quote's own build, the pinned pool and adapter, the ask's token and amount, a min out at least
//   the quote's agreed output less the ask's own slippage, which the rule derives, the proof's relay data W's and the
//   pinned fee recipient's), signed by W only through signEvmBuy. W is derived from the seed right before it signs and
//   must be the proof's W and the relay data's recipient; the seed is zeroed once W is derived and W's key once it has
//   signed, and both again on every exit. A quote or a check that fails is never signed: the note stays HELD.
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
//       the min out W signed, of the chunk less the fee; W's holding is completed with what W received, and filled
//       names that transaction;
//     refused, with the release's transaction: both show a Withdrawn (the swap failed in the pool's own call and W got
//       the chunk less the fee in ETH): that ETH is written owed back to the user (EVM_OWED_BACK_KEY) for the sell and
//       withdraw cards to return, and the holding marked withdrawn; the buy did not fill;
//     not_landed: both show another release of the nullifier (the note spent elsewhere), or both RPCs' newest block is
//       past the proof's deadline with no release of it on either (the pool refuses it from then on: PrivacyPool.sol
//       reverts a release once block.timestamp is past the relay data's deadline). Never on a revert: the pool has no
//       sender check, so the public calldata can land until the deadline.
//   The tap's run reads for EVM_BUY_SETTLE_MS from the send and then answers its last true stage ("sent"); the reads go
//   on, with no lock held, until an end (at most EVM_BUY_FOLLOW_MS past the deadline), which goes to the app as the
//   kind's progress (`late`). The proof's deadline is at most EVM_LIFE_MS (210 s) from its epoch's start and at least
//   the send margin and take slack (75 s) after the take.
// - Settled: every run that took its note starts the chain's settle pass as it ends, and again when its reads end (the
//   one path that ends a RESERVED note: SPENT with its change once the release is final, UNSPENT once both RPCs' final
//   block is past the deadline with none).
// - Who learns what: the helper, the calldata (W, the pool, the route); the chain, the transaction; the pool RPCs, the
//   token (quote, decimals), their newest block and the pool's whole release log over a block range, never W, the
//   nullifier or a transaction hash.
// Nothing here logs.
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { evmPoolBuyQuote, type EvmPoolBuyQuote, type EvmPoolBuyQuoteRequest } from "../../kit/src/checks/evm/quote.ts";
import { evmPoolVenues, venuePins, type EvmPoolBuy, type EvmPoolChain, type EvmPoolVenueList, type EvmRoute } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolBuildQuoted } from "../../kit/src/trade/evm/buy.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { EVM_SEND_MARGIN_MS, type EvmPoolPin, type EvmPoolRequest, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import type { ProofQueue } from "../../wallet/src/pool/queue.ts";
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import { checkEvmBuy, PoolRuleRefused, poolUnits, signEvmBuy, tokenDecimalsOf, type PoolAsk } from "./rules/pool.ts";
import { EvmSendBusy, EvmSendRefused, evmBuyCalldata, evmBuyVerdict, evmHeadNumber, evmPoolSend, evmReleaseRead, type EvmBuyVerdict, type EvmBuyWant, type EvmReleaseRead } from "./evm-send.ts";
import { readTokenDecimals, type PoolRpc } from "./pool-kinds.ts";
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
 *  swap failed, W holds the ETH owed back (EVM_OWED_BACK_KEY). */
export type EvmHolding = {
  mint: string;
  decimals: number;
  chain: Chain;
  state: "pending" | "filled" | "withdrawn";
  received?: string;
  route: { venue: EvmRoute["venue"]; adapter: string; path: EvmRoute; tx?: string; block?: string };
};
/** ETH a release paid W with no swap (a Withdrawn), owed back to the user, by W's address: the chunk less the fee, in
 *  wei, and the release that paid it. The pool sell and withdraw cards read it to return it. */
export const EVM_OWED_BACK_KEY = "owed/back-evm";
export type EvmOwedBack = { address: string; chain: Chain; wei: string; tx: string; block: string };

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
  take(noteId: string, attempt: string): Promise<Ready>;
  seed64(): Promise<Uint8Array>;
  /** The kit's evmPoolBuyQuote. */
  quote(req: EvmPoolBuyQuoteRequest): Promise<EvmPoolBuyQuote>;
  /** The kit's evmPoolBuildQuoted. */
  build(adapter: string, q: EvmPoolBuyQuote): EvmPoolBuy;
  /** The token's decimals, the same on both RPCs (rules/pool.ts tokenDecimalsOf); throws otherwise. */
  decimals(token: string): Promise<number>;
  /** POST /v1/pool/evm/send (evm-send.ts evmPoolSend): its hash a hint only. */
  send(body: { pool: string; data: Uint8Array; epoch: bigint }): Promise<string>;
  /** Starts the chain's settle pass (evmSettleReserved over the page's notes); never awaited by the run. */
  settle(): void;
  /** Writes W's holding (EVM_POSITION_COSTS_KEY): before the send (a failure sends nothing) and on its end. */
  record(w: string, h: EvmHolding): Promise<void>;
  /** Writes W's ETH owed back (EVM_OWED_BACK_KEY). */
  owe(o: EvmOwedBack): Promise<void>;
  /** Runs the part up to the send under the seed's lock (the kind's); the read-back runs outside it. */
  hold?<T>(f: () => Promise<T>): Promise<T>;
  /** The bytes have left the device: told once. */
  sent?(): void;
  /** An end the reads found after the tap's run answered "sent" at its bound. */
  late?(a: { stage: TradeStage; txs: TxRef[] }): void;
  /** The notes a run on this page has picked and not finished. */
  claimed?: Set<string>;
  /** W from the seed (the wallet's freshWallet; a test's spy). */
  derive?: typeof freshWallet;
  now?(): bigint;
  wait?(ms: number): Promise<void>;
};

export type EvmPoolBuyAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "quote_check_failed" | "failed" };

/** The tap's read-back from the send, on the wall clock (the Solana buy's POOL_BUY_SETTLE_MS). */
export const EVM_BUY_SETTLE_MS = 120_000;
/** How long past the proof's deadline the reads go on for an end (two RPCs whose newest block lags the deadline). */
export const EVM_BUY_FOLLOW_MS = 300_000;
/** Between two rounds of reads: each is four requests, two on each pool RPC. */
export const EVM_BUY_WAIT_MS = 2_000;
/** The standard v4 (fee, tick spacing) pairs and v3 fee tiers the first quote asks in turn (the kit's own standard set,
 *  checks/evm/quote.ts V4_KEYS and V3_FEES). */
const V4_FIRST: readonly (readonly [number, number])[] = [[3000, 60], [10000, 200], [500, 10], [100, 1]];
const V3_FIRST: readonly number[] = [3000, 500, 10000, 100];
const ZERO = "0x0000000000000000000000000000000000000000";
const REQUOTE = new Set(["below_reference", "native_first", "over_gas_floor"]);

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

/** The device's quote of the ask: the standard shapes in turn until one quotes or the kit names its own best route, which
 *  is then asked once. Any other refusal of every shape: quote_check_failed. */
async function quoteOf(h: EvmPoolBuyHost, network: EvmPoolChain, token: string, amountIn: bigint, slippageBps: number): Promise<EvmPoolBuyQuote> {
  const v = h.venues[network];
  if (v === undefined) return no("not_allowed");
  const shapes: EvmRoute[] = [
    ...V4_FIRST.map(([fee, tickSpacing]): EvmRoute => ({ venue: "uniswap-v4", currencyIn: ZERO, hops: [{ currency: token, fee, tickSpacing, hooks: ZERO, hookData: "0x" }] })),
    ...V3_FIRST.map((fee): EvmRoute => ({ venue: "uniswap-v3", tokens: [v.weth, token], fees: [fee] })),
  ];
  const ask = (route: EvmRoute) => h.quote({ chain: network, token, amountIn, slippageBps, route });
  for (const route of shapes) {
    try {
      return await ask(route);
    } catch (e) {
      const err = e as { code?: unknown; reference?: { route: EvmRoute } | null };
      if (typeof err?.code === "string" && REQUOTE.has(err.code) && err.reference) return ask(err.reference.route);
      if (err?.code === "rpc_error" || err?.code === "rpc_disagree" || err?.code === "stale_quote") throw e;
    }
  }
  return no("quote_check_failed");
}

/** One pool.buy on an EVM chain: the ask is the user's own (rules/pool.ts checkPoolRequest passed it). */
export async function runEvmPoolBuy(h: EvmPoolBuyHost, ask: PoolAsk): Promise<EvmPoolBuyAnswer> {
  let seed: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  let claim: string | null = null;
  let taken = false;
  let posted = false;
  const hold = h.hold ?? (<T>(f: () => Promise<T>) => f());
  const clock = (): bigint => h.now?.() ?? BigInt(Date.now());
  const wait = h.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const settle = (): void => {
    try {
      h.settle();
    } catch {
      /* the state reads run it again */
    }
  };
  try {
    type Out = { answer: EvmPoolBuyAnswer } | { watch: Watch };
    const out = await hold(async (): Promise<Out> => {
      if (ask.kind !== "pool.buy" || ask.chain !== h.chain || ask.token === null) return no("not_allowed");
      const token = ask.token;
      const network: EvmPoolChain = h.testnet ? (h.chain === "base" ? "base-sepolia" : "robinhood-testnet") : h.chain;
      if (h.pin.network !== network) return no("not_allowed");
      const pins = venuePins(h.venues, network);
      if (pins.pool === undefined || lower(pins.pool) !== lower(h.pin.pool)) return no("not_allowed");
      // the proof: its chunk the ask's amount, its W an EVM one, no other tap's; claimed at once
      const r = (await h.ready()).find((p) => p.wallet.chain === "evm" && p.chunk === ask.amount && !h.claimed?.has(p.noteId));
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
      const q = await quoteOf(h, network, token, r.chunk - fee, ask.slippageBps);
      const adapter = q.route.venue === "uniswap-v4" ? pins.v4 : pins.v3;
      if (adapter === undefined) return no("quote_check_failed");
      const built = h.build(adapter, q);
      const ctx = { nowMs: clock(), wallet: r.wallet.address, feeCap: fee, evm: { venues: h.venues, feeRecipient: h.pin.feeRecipient } };
      checkEvmBuy(built, h.pin.pool, binding, relay, ask, ctx, { token: q.token, amountIn: q.amountIn, amountOut: q.amountOut }, h.testnet);
      // before W signs, so a read that fails leaves the note HELD: the token's decimals, and where the read-back starts
      const decimals = await h.decimals(token);
      const heads = await Promise.all(h.rpcs.map((rpc) => evmHeadNumber(rpc)));
      const from = heads[0]! < heads[1]! ? heads[0]! : heads[1]!;
      // W, from the seed, right before it signs: the proof's W and the relay data's recipient
      seed = await h.seed64();
      const w = (h.derive ?? freshWallet)(seed, "evm", r.wallet.l, r.wallet.j);
      key = w.secretKey;
      seed.fill(0);
      if (lower(w.address) !== lower(r.wallet.address) || lower(relay.recipient) !== lower(w.address)) return no();
      const signature = signEvmBuy(key, ctx, built, h.pin.pool, binding);
      key.fill(0);
      const data = evmBuyCalldata(h.pin.pool, relay, r.proof, r.publicSignals, fee, built, signature);
      // W's holding, pending, before anything leaves: a write that fails sends nothing
      const holding: EvmHolding = { mint: lower(token), decimals, chain: h.chain, state: "pending", route: { venue: q.route.venue, adapter: lower(adapter), path: q.route } };
      await h.record(w.address, holding);
      // the take, awaited before anything leaves: this very attempt, or refused with the note HELD
      const got = await h.take(r.noteId, r.attempt);
      taken = true;
      if (got.attempt !== r.attempt) return no();
      // the send: a busy helper waited out while the proof has more than the send margin left
      posted = true;
      for (;;) {
        try {
          await h.send({ pool: h.pin.pool, data, epoch: r.epochStartMs });
          break;
        } catch (e) {
          if (e instanceof EvmSendRefused) return { answer: { stage: "refused", txs: [] } };
          if (e instanceof EvmSendBusy && clock() + BigInt(e.retryAfterMs) < r.deadlineMs - EVM_SEND_MARGIN_MS) {
            // the helper's own Retry-After (evmPoolSend caps it at EVM_SEND_RETRY_MAX_S), at least 1 s
            await wait(Math.max(e.retryAfterMs, 1_000));
            continue;
          }
          // no answer: the bytes may be on their way
          break;
        }
      }
      h.sent?.();
      const want: EvmBuyWant = { nullifier: binding.nullifier, w: w.address, feeRecipient: h.pin.feeRecipient, token, minOut: built.minOut, value: r.chunk, fee, deadlineMs: relay.deadlineMs };
      return { watch: { want, from, holding, w: w.address } };
    });
    if ("answer" in out) return out.answer;
    // the read-back, outside the lock: the tap's part, then on past it with no answer owed
    const sentAt = clock();
    const tap = await watch(h, out.watch, () => clock() - sentAt < BigInt(EVM_BUY_SETTLE_MS), wait);
    if (tap !== null) return tap;
    void watch(h, out.watch, () => clock() <= out.watch.want.deadlineMs + BigInt(EVM_BUY_FOLLOW_MS), wait)
      .then((a) => {
        settle();
        if (a !== null) h.late?.(a);
      })
      .catch(() => {});
    return { stage: "sent", txs: [] };
  } catch (e) {
    // past the post, only a true stage: the bytes may be on their way
    if (posted) return { stage: "sent", txs: [] };
    if (e instanceof Refused) return { error: e.code };
    if (e instanceof PoolRuleRefused) return { error: "quote_check_failed" };
    if ((e as { name?: unknown })?.name === "EvmQuoteError" || (e as { name?: unknown })?.name === "EvmPoolBuyError") return { error: "quote_check_failed" };
    return { error: "failed" };
  } finally {
    (seed as Uint8Array | null)?.fill(0);
    (key as Uint8Array | null)?.fill(0);
    if (claim !== null) h.claimed?.delete(claim);
    // a taken note is ended only by the settle: started on every exit past the take
    if (taken) settle();
  }
}

type Watch = { want: EvmBuyWant; from: bigint; holding: EvmHolding; w: string };

/** The read-back's rounds while `more()`: the pool's releases on both RPCs, the verdict on them, and its records: the
 *  end's answer, or null when none came in time. A read that fails is that round's no answer. */
async function watch(h: EvmPoolBuyHost, x: Watch, more: () => boolean, wait: (ms: number) => Promise<void>): Promise<{ stage: TradeStage; txs: TxRef[] } | null> {
  for (let i = 0; i === 0 || more(); i++) {
    if (i > 0) await wait(EVM_BUY_WAIT_MS);
    let v: EvmBuyVerdict;
    try {
      const reads = (await Promise.all(h.rpcs.map((rpc) => evmReleaseRead(rpc, h.pin.pool, x.from)))) as [EvmReleaseRead, EvmReleaseRead];
      v = evmBuyVerdict(reads, x.want);
    } catch {
      continue;
    }
    if (v === null) continue;
    if (v.end === "not_landed") return { stage: "not_landed", txs: [] };
    const txs: TxRef[] = [{ chain: h.chain, hash: v.release.tx }];
    const at = { ...x.holding.route, tx: v.release.tx, block: v.release.block.toString() };
    if (v.end === "filled") {
      await h.record(x.w, { ...x.holding, state: "filled", received: poolUnits(v.release.out, x.holding.decimals), route: at }).catch(() => {});
      return { stage: "filled", txs };
    }
    // withdrawn: W holds the chunk less the fee in ETH, owed back to the user; the buy did not fill
    await h.owe({ address: x.w, chain: h.chain, wei: (v.release.value - v.release.fee).toString(), tx: v.release.tx, block: v.release.block.toString() }).catch(() => {});
    await h.record(x.w, { ...x.holding, state: "withdrawn", route: at }).catch(() => {});
    return { stage: "refused", txs };
  }
  return null;
}

/** What the page gives an EVM buy (src/pool-testnet.ts): its chain's queue, the seed, the wallet store, the chain's
 *  RESERVED settle. */
export type EvmBuyPage = {
  queue(): Promise<ProofQueue<EvmPoolRequest>>;
  seed64(): Promise<Uint8Array>;
  store(): Promise<WalletStore>;
  settle(): void;
  testnet: boolean;
  fetch?: typeof fetch;
};

/** The page's host for one EVM buy run: the kit's quote, build and venue list, the helper's send, the pool's pair for
 *  the token's decimals and the read-back, W's holding and owed ETH in the wallet store's meta. */
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
    take: async (id, attempt) => (await page.queue()).take(id, attempt),
    seed64: page.seed64,
    quote: evmPoolBuyQuote,
    build: evmPoolBuildQuoted,
    decimals: async (token) => tokenDecimalsOf(chain, await readTokenDecimals(chain, token, rpcs as readonly [PoolRpc, PoolRpc])),
    send: (body) => evmPoolSend(TRADE_HELPER, body, page.fetch),
    settle: page.settle,
    record: async (w, holding) => {
      const store = await page.store();
      await store.update("meta", EVM_POSITION_COSTS_KEY, (v) => ({ ...(typeof v === "object" && v !== null ? v : {}), [w]: holding }));
    },
    owe: async (o) => {
      const store = await page.store();
      await store.update("meta", EVM_OWED_BACK_KEY, (v) => ({ ...(typeof v === "object" && v !== null ? v : {}), [o.address]: o }));
    },
    claimed,
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
