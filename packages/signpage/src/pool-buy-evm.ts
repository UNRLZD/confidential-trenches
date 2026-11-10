// pool.buy on a Base or Robinhood pool (card signpage-evm-pool-buy): one tap releases a ready proof's chunk from the
// pinned pool to its fresh wallet W and buys the user's token with it in one transaction (PrivacyPoolSimple.buy), which
// the helper's sender carries; the buy counts as filled only once two RPCs of two operators read it back.
//
// - The proof: one the chain's proof queue made ahead (../../wallet/src/pool/queue.ts over the wallet's evmPool), whose
//   chunk is the ask's amount exactly (rules/pool.ts checkEvmBuy holds the proof's value to it), and that no other tap
//   of this page holds (`claimed`). Its fee is the one its binding holds: the device's own epoch fee, read on two RPCs
//   when the queue bound it (evm.ts bind), never read again at the tap.
// - The quote: the kit's evmPoolBuyQuote, for the chunk less that fee (what the pool swaps), on the kit's pinned
//   providers; a read names the token, never W. The request names no route (the kit's request shape), so the device
//   asks the standard pool shapes in turn (v4 native, then v3 WETH, each fee tier), and a quote the kit refuses below its
//   own best (below_reference, native_first, over_gas_floor) is asked again on that best route, once.
// - Built by the kit (evmPoolBuildQuoted, through the chain's pinned adapter for the route's venue), checked by the
//   rule (checkEvmBuy: the quote's own build, the pinned pool and adapter, the ask's token and amount, the min out at
//   least the quote's, the proof's relay data W's and the pinned fee recipient's), signed by W only through signEvmBuy
//   (it signs nothing the check did not pass). W is derived from the seed right before it signs and must be the proof's
//   recipient; its key and the seed are zeroed at once. A quote or a check that fails is never signed: the note stays
//   HELD with its proof ready.
// - The take: only after the signature does the queue's take move the note HELD -> RESERVED, awaited before the bytes
//   leave the device, for this very attempt (a remake swapped in meanwhile is refused and the note stays HELD).
// - The send: evm-send.ts evmPoolSend; a busy helper is asked again after its wait while the proof has more than the
//   send margin left. A refusal is the helper's word only: answered failed, the note RESERVED, and the chain's settle
//   pass (evm-settle.ts evmSettleReserved) frees it once the proof's deadline is final, or settles it SPENT if it landed.
// - The read-back: each RPC on its own (evm-send.ts evmReadBack). The hash is named to the app ("sent") only once both
//   RPCs read this very transaction under it. Filled only once both read its receipt succeeded with the pool's Bought
//   for W, the pinned fee recipient, this proof's nullifier and the token, the same on both; on one RPC only, or one
//   read differing, the reads go on, and past them the answer is "sent". Both reading it reverted: refused (the
//   nullifier is unspent; the settle frees the note after its deadline). Both reading the pool's Withdrawn instead (the
//   swap failed in the pool's own call and W got the chunk less the fee in ETH): refused, with its transaction.
// - Settled: every run that took its note starts the chain's settle pass as it ends (`settle`), the one path that ends a
//   RESERVED note: SPENT with its change written once the release is final, UNSPENT once the deadline is final with no
//   release. A note is never left without it.
// - The holding (card signpage-positions-evm reads it): on filled, W's record in the wallet store's meta under
//   EVM_POSITION_COSTS_KEY by W's address, the Solana record's fields (positions.ts PositionCost on card
//   signpage-state-holdings: mint, received at the token's decimals, decimals) and the route the transaction took
//   (the quoted route W signed, its venue, and the transaction's hash). Written after the read-back, before the answer.
// - Who learns W: the helper (the send's calldata names W, on its keyed route), the chain (the transaction), and the two
//   pool RPCs only through the transaction they are asked to read back by its hash. The quote's reads and the token's
//   decimals name the token only.
// Nothing here logs.
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { evmPoolBuyQuote, type EvmPoolBuyQuote, type EvmPoolBuyQuoteRequest } from "../../kit/src/checks/evm/quote.ts";
import { evmPoolVenues, venuePins, type EvmPoolBuy, type EvmPoolChain, type EvmPoolVenueList, type EvmRoute } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolBuildQuoted } from "../../kit/src/trade/evm/buy.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { EVM_CHAIN_IDS, EVM_SEND_MARGIN_MS, type EvmPoolPin, type EvmPoolRequest, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import type { ProofQueue } from "../../wallet/src/pool/queue.ts";
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import { checkEvmBuy, PoolRuleRefused, poolUnits, signEvmBuy, tokenDecimalsOf, type PoolAsk } from "./rules/pool.ts";
import { EvmSendBusy, EvmSendRefused, evmBuyCalldata, evmPoolSend, evmReadBack, evmReleaseOutcome, type EvmReadBack, type EvmReleaseOutcome } from "./evm-send.ts";
import { readTokenDecimals, type PoolRpc } from "./pool-kinds.ts";
import { TRADE_HELPER } from "./trade.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

type Ready = ReadyProof<EvmPoolRequest>;
type Chain = "base" | "robinhood";

/** W's buy record by W's address, beside the Solana pool's (positions.ts POSITION_COSTS_KEY "owed/cost-sol"): an owed/
 *  key, the one meta keyspace the wallet store lets a caller write. */
export const EVM_POSITION_COSTS_KEY = "owed/cost-evm";
/** One W's buy: positions.ts PositionCost's fields (mint, received, decimals; no cost_usd, the page reads no EVM price
 *  yet, which positions.ts reads as cost unknown) and the route the transaction took. */
export type EvmHolding = {
  mint: string;
  received: string;
  decimals: number;
  chain: Chain;
  route: { venue: EvmRoute["venue"]; adapter: string; path: EvmRoute; tx: string; block: string };
};

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
  /** POST /v1/pool/evm/send: the hash the helper names (evm-send.ts evmPoolSend). */
  send(body: { pool: string; data: Uint8Array; epoch: bigint }): Promise<string>;
  /** Starts the chain's settle pass (evmSettleReserved over the page's notes); never awaited by the run. */
  settle(): void;
  /** Writes W's holding (EVM_POSITION_COSTS_KEY); a write that fails never changes the answer. */
  record?(w: string, h: EvmHolding): Promise<void>;
  /** Both RPCs read this very transaction under its hash: told once. */
  sent?(hash: string): void;
  /** The notes a run on this page has picked and not finished. */
  claimed?: Set<string>;
  now?(): bigint;
  reads?: number;
  wait?(ms: number): Promise<void>;
};

export type EvmPoolBuyAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "quote_check_failed" | "failed" };

/** Read-back reads, a second apart: a few of Base's 2 s blocks and Robinhood's 250 ms ones, with room for a slow RPC. */
export const EVM_BUY_READS = 90;
export const EVM_BUY_WAIT_MS = 1_000;
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
  const wait = h.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
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
    const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: r.wallet.address, feeCap: fee, evm: { venues: h.venues, feeRecipient: h.pin.feeRecipient } };
    checkEvmBuy(built, h.pin.pool, binding, relay, ask, ctx, q.minOut, h.testnet);
    // the token's decimals before W signs, so a read that fails leaves the note HELD
    const decimals = await h.decimals(token);
    // W, from the seed, right before it signs: the proof's recipient
    seed = await h.seed64();
    const w = freshWallet(seed, "evm", r.wallet.l, r.wallet.j);
    key = w.secretKey;
    seed.fill(0);
    if (lower(w.address) !== lower(r.wallet.address) || lower(relay.recipient) !== lower(w.address)) return no();
    const signature = signEvmBuy(key, ctx, built, h.pin.pool, binding);
    key.fill(0);
    key = null;
    const data = evmBuyCalldata(h.pin.pool, relay, r.proof, r.publicSignals, fee, built, signature);
    // the take, awaited before anything leaves: this very attempt, or refused with the note HELD
    const got = await h.take(r.noteId, r.attempt);
    taken = true;
    if (got.attempt !== r.attempt) return no();
    // the send: a busy helper waited out while the proof has more than the send margin left
    let hash: string;
    for (;;) {
      try {
        hash = await h.send({ pool: h.pin.pool, data, epoch: r.epochStartMs });
        break;
      } catch (e) {
        if (e instanceof EvmSendBusy && (h.now?.() ?? BigInt(Date.now())) + BigInt(e.retryAfterMs) < r.deadlineMs - EVM_SEND_MARGIN_MS) {
          await wait(Math.min(Math.max(e.retryAfterMs, 1_000), 5_000));
          continue;
        }
        if (e instanceof EvmSendRefused || e instanceof EvmSendBusy) return no();
        // no answer: the helper may have sent it; nothing to name, the settle decides
        return { stage: "sent", txs: [] };
      }
    }
    const sent = { hash, to: h.pin.pool, data, chainId: EVM_CHAIN_IDS[network] };
    const txs: TxRef[] = [{ chain: h.chain, hash }];
    let named = false;
    for (let i = 0; i < (h.reads ?? EVM_BUY_READS); i++) {
      if (i > 0) await wait(EVM_BUY_WAIT_MS);
      const reads: EvmReadBack[] = await Promise.all(h.rpcs.map((rpc) => evmReadBack(rpc, sent).catch((): EvmReadBack => ({ got: "none" }))));
      const [a, b] = reads as [EvmReadBack, EvmReadBack];
      // another transaction under the helper's hash on both: never this buy's
      if (a.got === "other" && b.got === "other") return { stage: "sent", txs: [] };
      const mine = (x: EvmReadBack) => x.got === "pending" || x.got === "ok" || x.got === "failed";
      if (!named && mine(a) && mine(b)) {
        named = true;
        h.sent?.(hash);
      }
      if (a.got === "failed" && b.got === "failed") return { stage: "refused", txs };
      if (a.got !== "ok" || b.got !== "ok") continue;
      const outs = [a, b].map((x) => evmReleaseOutcome(x.logs!, h.pin.pool, w.address, h.pin.feeRecipient, binding.nullifier));
      const [x, y] = outs as [EvmReleaseOutcome | null, EvmReleaseOutcome | null];
      if (x === null || y === null || JSON.stringify(x, big) !== JSON.stringify(y, big) || a.block !== b.block) continue;
      if (x.kind === "withdrawn") return { stage: "refused", txs };
      if (lower(x.token) !== lower(token) || x.out < built.minOut || x.value !== r.chunk || x.fee !== fee) continue;
      const holding: EvmHolding = { mint: lower(token), received: poolUnits(x.out, decimals), decimals, chain: h.chain, route: { venue: q.route.venue, adapter: lower(adapter), path: q.route, tx: hash, block: String(a.block) } };
      await h.record?.(w.address, holding).catch(() => {});
      return { stage: "filled", txs };
    }
    return { stage: "sent", txs: named ? txs : [] };
  } catch (e) {
    if (e instanceof Refused) return { error: e.code };
    if (e instanceof PoolRuleRefused) return { error: "quote_check_failed" };
    if ((e as { name?: unknown })?.name === "EvmQuoteError" || (e as { name?: unknown })?.name === "EvmPoolBuyError") return { error: "quote_check_failed" };
    return { error: "failed" };
  } finally {
    seed?.fill(0);
    key?.fill(0);
    if (claim !== null) h.claimed?.delete(claim);
    // a taken note is ended only by the settle: started on every exit past the take
    if (taken) {
      try {
        h.settle();
      } catch {
        /* the state reads run it again */
      }
    }
  }
}
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

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
 *  the token's decimals and the read-back, W's holding in the wallet store's meta. */
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
    claimed,
  };
}

type Locks = Pick<LockManager, "request">;

/** The pool.buy kind on an EVM chain: one run per tap under the seed's shared lock (sign out waits for it), answered
 *  "sent" once both RPCs read its transaction back as this very one, or at the run's end with the run's own answer. */
export function poolBuyEvmKind(host: () => EvmPoolBuyHost & { end?(): void }, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk, ctx: KindContext | null): HostRefusal | Running<"pool.buy"> => {
    if (ask.kind !== "pool.buy" || ask.chain === "solana" || !locks) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.buy"> | HostRefusal | null = null;
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    const run = locks
      .request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
        const h = host();
        try {
          const a = await runEvmPoolBuy(
            {
              ...h,
              sent: (hash) => {
                if (!answer) answer = { result: { stage: "sent", txs: [{ chain: h.chain, hash }] } };
                give();
              },
            },
            ask,
          );
          if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
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
