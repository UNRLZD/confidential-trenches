// pool.sell on a Base or Robinhood pool (card signpage-evm-pool-sell): one tap sells a token the fresh wallets W of the
// user's EVM buys hold, and the same transaction puts what the sale gives back into the pinned pool as a note of the
// user's own (SellDelegate.sell through W's EIP-7702 delegation, which the helper's sell sender carries: W holds no ETH).
// The Solana sell (pool-sell.ts) is the shape; what differs is the chain's.
//
// - The Ws (planEvmSell): every W the note store's SPENT and RESERVED notes of this pool pay (W_{evm, l, j}, l the note's
//   label, j = jOf(its ref): the only W a proof of the note pays), whose buy record (pool-buy-evm.ts EVM_POSITION_COSTS_KEY,
//   written by the buy's read-back, or by the restore from the buy's own transaction: restoreEvmHoldings below) names the
//   token, filled, with the route the buy took and its block. A W whose record holds no route or no block is never sold:
//   the kit's sell quote takes the buy's route as a candidate the scan may no longer reach (card evm-route-parity, review
//   F3), and a quote without it could be steered to a seeded pool. When the Ws with a route do not hold the units, the
//   sell is refused not_allowed, nothing read past the plan. Each W's balance is balanceOf(W) on both pool RPCs at the
//   lower of their two newest blocks, the same on both (read again once). The units and legs are pool-sell.ts's rule:
//   one W holding them all (the smallest), else smallest first, the last W in part. The finding gates the signature
//   (a sale by share is sized on its total), so on mainnet too it reads on the pool's two RPCs, never the helper's route
//   (decision M359 (2)): what narrows the reads is which Ws are asked, never whose word is believed. Only the Ws whose
//   own buy record on this device names this token are read, one W a request, in a random order, so the pair is named
//   only Ws that bought the token sold, which each leg's own reads name anyway, and never the user's other Ws.
// - Each leg's plan and quote (evmSellQuoteLeg, which a read-only kind can call with no key: it then signs no sim):
//   the return note (the wallet's evmNextNote over the pool's round from (return, evm, l, j): a deposit already naming one
//   is the user's own, written by evmClaimTaken, and the walk goes on), W's sell nonce (SellDelegate.nonce() called on W,
//   none before its first delegation) and account nonce on both RPCs, the same on both; `sent`, the releases the device
//   sent W that have not landed final (the wallet's evmSellSent: audit E-01, card evm-sell-no-release-in-flight); the
//   pools this device banned for the token (card evm-sell-hook-converge); then the kit's evmPoolSellQuote with the buy's
//   route and block, and its sim signer (cards evm-sell-hook-intrablock, evm-sell-hooked-fork: checkEvmSellSim, then
//   signEvmSellSim, a signature that can never land). Last, the token's decimals() at the quote's block on both RPCs:
//   equal to the ask's (the number the request's typed amount was turned into units with), else refused, so a token
//   behind a proxy that changed its decimals since the number was kept never signs a wrong amount; and the kit's
//   fee-on-transfer probe at that block refuses an amount W does not hold on both.
// - Built by the kit (evmPoolBuildSell: the quote's route, target and minOut, the precommitment of the return note, the
//   chain's pinned FeeCollector as the fee recipient, a deadline EVM_SELL_DEADLINE_S on, W's sell nonce), checked by the
//   rule (checkEvmSell: the quote's own build, the pinned pool, W, the token and units, the precommitment, the fee cap
//   within the device's rule, the FeeCollector: cards helper-sell-fee-recipient and evm-fee-collector; and
//   checkEvmAuthorization: the pinned delegate at W's account nonce both RPCs read), signed by W only through signEvmSell
//   and signEvmAuthorization. W is derived from the seed for the run and must be the W planned; the seed is zeroed once W
//   is derived, W's key once the leg has signed, both again on every exit.
// - Before the bytes leave: the open sale's record (EVM_OPEN_SELLS_KEY: the note, W, the nonce, the latest deadline
//   signed, the block the read-back starts at, the least the deposit holds) and the note PLANNED -> INCOMING. A write
//   that fails sends nothing. So a sale that lands is never without its record, whatever happens to the page.
// - The send (evm-send.ts evmSellSend): a 429, or a 503 naming a Retry-After (the sender's lane held), is the same
//   bytes again after that wait while the deadline has more than the helper's send margin left; past it, the sale is
//   quoted, built, checked and signed once more on the same Sell nonce and precommitment with a new deadline (the record's
//   deadline raised first), and sent the same way. Both share W's Sell nonce, which SellDelegate.sol:152 takes once, and
//   the precommitment, so at most one lands, and the one deposit is the sale's whichever did. A 4xx naming its code on the
//   first POST is the helper's word: the run answers refused and the chain ends the record. Anything else is no answer.
// - The read-back (evm-send.ts evmDepositedRead, evmSellVerdict): the pool's Deposited logs since the block read before
//   the send, on both pool RPCs, by the pool's address and topic only. filled: the deposit naming the precommitment, from W,
//   at least min out less the fee cap; taken: another deposit took the precommitment first (the sale reverts and W keeps
//   its token; the note is the user's own all the same); not_landed: none, and both RPCs' safe block past the latest
//   deadline. A hint the helper's hash gives: its receipt failed on both RPCs, so the tap answers refused and, where the
//   quote picked a pool behind a hook the venue does not list, the kit's evmSellRevertedPools names the pools to ban; the
//   reads go on to the deadline, since a signed Sell can still be sent to W by anyone until it.
// - The ends: the note lands UNSPENT with its leaf only from the pool's round, at a final block (evmNextNote's taken,
//   written by evmClaimTaken), and the record is dropped then; not_landed puts the note back PLANNED (the next sale signs
//   on the same note, so the restore's walk has no gap) and drops the record. The tap reads for EVM_SELL_SETTLE_MS, then
//   answers its last true stage; the reads go on with no lock held (`late` tells the app the end). A load follows every
//   open record no run of this page follows (followEvmSells), so a page closed anywhere after the record settles to one
//   note.
// - Who learns what: the helper, the calldata and W's authorization; the pool RPCs, W (the quote's reads, the nonces, the
//   balance), the token and the pool's logs over a block range; the sale's own transaction when the helper names one.
//   Nothing here logs.
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { evmPoolSellQuote, evmSellRevertedPools, type EvmPoolSellQuote, type EvmPoolSellQuoteRequest } from "../../kit/src/checks/evm/quote.ts";
import { evmBuyRouteOf, evmPoolVenues, venuePins, type EvmPoolChain, type EvmPoolVenueList, type EvmRoute } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolBuildSell, type EvmPoolSell, type EvmPoolSellFields } from "../../kit/src/trade/evm/sell.ts";
import type { EvmSellSim } from "../../kit/src/trade/evm/sell-unpinned.ts";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import type { NoteRecord, NoteStore } from "../../wallet/src/notes/store.ts";
import { EvmLagError, EvmUnansweredError, EVM_SEND_MARGIN_MS, type EvmPoolEvent, type EvmPoolPin, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { evmClaimTaken, evmNextNote, EvmNotFinalError } from "../../wallet/src/pool/evm-restore.ts";
import { evmSellSent } from "../../wallet/src/pool/evm-releases.ts";
import { evmSellBan, evmSellBanned } from "../../wallet/src/pool/evm-sell-bans.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import { checkEvmAuthorization, checkEvmSell, checkEvmSellSim, PoolRuleRefused, signEvmAuthorization, signEvmSell, signEvmSellSim, tokenDecimalsOf, type PoolAsk, type PoolContext } from "./rules/pool.ts";
import { EvmSendBusy, EvmSendRefused, evmBuyCalldataRead, evmSellSelector, evmDepositedRead, evmHeadNumber, evmSellCalldata, evmSellSend, evmSellVerdict, type EvmDepositedRead, type EvmSellAuthorization, type EvmSellVerdict } from "./evm-send.ts";
import { EVM_BUY_HEAD_SPREAD, EVM_BUY_LAG_MS, EVM_POSITION_COSTS_KEY, type EvmHolding } from "./pool-buy-evm.ts";
import { ERC20_DECIMALS, keptTokenDecimals, type PoolRpc } from "./pool-kinds.ts";
import { stageOfLegs, type PoolSellAnswer, type PoolSellLeg } from "./pool-sell.ts";
import { clockOf as readClockOf, readWaits, stopOf, tapDone, tapWaits, waitsOn, waitUnless, type ReadWaits } from "./read-waits.ts";
import { TRADE_HELPER } from "./trade.ts";
import { shuffled } from "./positions-evm.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

type Chain = "base" | "robinhood";

/** The open sales by their return note's id: an owed/ key (the one meta keyspace the wallet store lets a caller write). */
export const EVM_OPEN_SELLS_KEY = "owed/sell-evm";
/** One open sale (decimal strings): written before its bytes leave, its deadline raised before a second signature
 *  leaves, dropped at its end. */
export type EvmOpenSell = { note: string; chain: Chain; w: string; token: string; amount: string; precommitment: string; nonce: string; deadline: string; from: string; least: string; tx?: string };

/** A Sell's life, s: under the kit's EVM_POOL_SELL_DEADLINE_MAX_S (600), past the helper's send margin (60 s) with room
 *  for the busy waits. */
export const EVM_SELL_DEADLINE_S = 300;
/** The tap's read-back from the send, wall clock (the buy's EVM_BUY_SETTLE_MS). */
export const EVM_SELL_SETTLE_MS = 120_000;
/** The tap waits on the send at most this long (a busy helper's Retry-After waits, the second signature); then it is
 *  answered "sent" and the send runs on, kept by the page (review P3-3). */
export const EVM_SELL_SEND_TAP_MS = 20_000;
/** Between two rounds of reads (each four requests on each pool RPC). */
export const EVM_SELL_WAIT_MS = 2_000;
/** A sale whose Sell nonce W has used, with no deposit of it read yet, is read on this long past its deadline (logs
 *  trailing their headers) before it ends not_landed. */
export const EVM_SELL_USED_GRACE_MS = 600_000;
/** Past every deadline the reads slow to this, until an end. */
export const EVM_SELL_SLOW_WAIT_MS = 30_000;
/** The read-back starts this many blocks under the lower newest block read before the send (the buy's margin). */
export const EVM_SELL_LAG_BLOCKS = 100n;
/** A busy wait's slices: it ends within one once a sign out starts. */
const STOP_POLL_MS = 250;
/** SellDelegate.nonce() (contracts/pool-evm/src/SellDelegate.sol:127), called on W. */
// made at the call, so a bundle with no sale (the mainnet build) keeps none of it
const nonceCall = (): string => `0x${Array.from(keccak_256(new TextEncoder().encode("nonce()")).subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const BALANCE_OF = "0x70a08231";
const lower = (s: string): string => s.toLowerCase();
const hexQ = (v: bigint): string => `0x${v.toString(16)}`;
const word = (v: bigint): string => v.toString(16).padStart(64, "0");

type Code = "not_allowed" | "not_funded" | "quote_check_failed" | "failed" | "down";
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

/** What a sell run needs from the page. */
export type EvmSellHost = {
  chain: Chain;
  /** The testnet build: the chain's pool is its testnet's. */
  testnet: boolean;
  pin: EvmPoolPin;
  /** The pool's scope (evmPoolScopeOf of the pin). */
  scope: bigint;
  /** The kit's venue list (evmPoolVenues()). */
  venues: EvmPoolVenueList;
  /** The pool's two RPCs, of two operators. */
  rpcs: readonly [EvmRpc, EvmRpc];
  /** The random source the plan's reads are ordered by (crypto.getRandomValues when not given). */
  random?: (out: Uint32Array<ArrayBuffer>) => void;
  /** The pool's round (the page's evmTreeSync events()): its events up to the newest agreed block and its final block. */
  round(): Promise<{ events: readonly EvmPoolEvent[]; fin: { number: bigint } }>;
  notes(): Promise<NoteStore>;
  seed64(): Promise<Uint8Array>;
  /** Every W's buy record (EVM_POSITION_COSTS_KEY). */
  holdings(): Promise<Record<string, unknown>>;
  /** The kit's evmPoolSellQuote. */
  quote(req: EvmPoolSellQuoteRequest): Promise<EvmPoolSellQuote>;
  /** A builder in the kit's evmPoolBuildSell's place, for a test that plants a bad one; the page sets none, and the
   *  kit's is called by name after the sale's evmNextNote pick (the signer guard, test/pool-kinds.test.ts). */
  build?(q: EvmPoolSellQuote, f: EvmPoolSellFields): EvmPoolSell;
  /** The pools banned for the token (evmSellBanned), and a ban (evmSellBan). */
  banned(token: string): Promise<string[]>;
  ban(token: string, pools: readonly string[]): Promise<void>;
  /** The kit's evmSellRevertedPools. */
  reverted(q: EvmPoolSellQuote, tx: string): Promise<readonly string[]>;
  /** POST /v1/pool/evm/sell (evm-send.ts evmSellSend): its hash a hint only. */
  send(body: { pool: string; w: string; data: Uint8Array; authorization: EvmSellAuthorization }): Promise<string>;
  /** The open sales (EVM_OPEN_SELLS_KEY). */
  open(): Promise<Record<string, EvmOpenSell>>;
  /** Writes one open sale (its note's id the key); a write that fails sends nothing. */
  record(o: EvmOpenSell): Promise<void>;
  /** Drops the open sale of `note`, only when its deadline is still `deadline` (a later signature raised it otherwise). */
  unrecord(note: string, deadline: string): Promise<void>;
  /** The notes whose sale a run or a load's follow of this page is following now. */
  following?: Set<string>;
  /** The notes whose sale a run of this page is sending now (its POST, its waits, its second signature): never signed
   *  again by another tap meanwhile. */
  sending?: Set<string>;
  /** Hands the page a part that runs on past the tap (a send past its bound, a read-back): the page keeps the note
   *  store open until each ends. */
  keep?(p: Promise<unknown>): void;
  /** The tap's bound on the send (EVM_SELL_SEND_TAP_MS when not given; a test's shorter one). */
  sendTapMs?: number;
  /** Runs the part up to the send under the seed's shared lock. */
  hold?<T>(f: () => Promise<T>): Promise<T>;
  sent?(): void;
  late?(a: { stage: TradeStage; txs: TxRef[] }): void;
  /** The sale's Deposited, the same on both RPCs (evmSellVerdict), and its block: the page's positions read at no lower one. */
  deposited?(o: EvmOpenSell, block: bigint): void;
  signal?: AbortSignal;
  /** The session's sign out, aborted at its tap: it ends a wait between the reads' attempts (read-waits.ts waitUnless). */
  stop?: AbortSignal;
  /** The tap's one bound on those waits (read-waits.ts tapWaits); a fresh bound when none is given. */
  waits?: ReadWaits;
  stopped?(): boolean;
  now?(): bigint;
  wait?(ms: number): Promise<void>;
};

const clockOf = (h: Pick<EvmSellHost, "now">) => (): bigint => h.now?.() ?? BigInt(Date.now());
const waitOf = (h: Pick<EvmSellHost, "wait">) => h.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
const networkOf = (h: Pick<EvmSellHost, "chain" | "testnet">): EvmPoolChain => (h.testnet ? (h.chain === "base" ? "base-sepolia" : "robinhood-testnet") : h.chain);

const unanswered = (e: unknown): boolean => e instanceof SolanaRpcTransportError || (e as { code?: unknown })?.code === "rpc_error";
/** A provider read that failed past its client's own retry (the page's one rule, card start-reads-wait-out-a-throttle):
 *  the page client's transport fault, the EVM reads' own unanswered and lag faults, or the kit quote's rpc_error (its
 *  pinned providers' clients). Any other error answers at once. */
const waitable = (e: unknown): boolean => waitsOn(e) || e instanceof EvmUnansweredError || e instanceof EvmLagError || (e as { code?: unknown })?.code === "rpc_error";

/** `f` again after a provider read that failed before W signs, on the page's one rule (read-waits.ts readWaits: from
 *  1 s, doubling, at most 10 s, inside the tap's one bound `h.waits`); then "down". A sign out ends a wait, and `f`
 *  never runs after it ("failed"). `f` reads everything it signs on from its start, so nothing after a wait is signed
 *  on a read from before it. */
async function patient<T>(h: Pick<EvmSellHost, "wait" | "stopped" | "signal" | "stop" | "waits" | "now">, f: () => Promise<T>): Promise<T> {
  const waits = h.waits ?? readWaits(readClockOf(h));
  const stop = stopOf(h);
  for (;;) {
    try {
      return await f();
    } catch (e) {
      if (!waitable(e)) throw e;
      const ms = h.stopped?.() ? null : waits.next(e);
      if (ms === null) return no("down");
      await waitUnless(h.wait, ms, stop);
      if (h.stopped?.() || stop?.aborted) return no("failed");
    }
  }
}

const quantity = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new Error(`${what}: not a quantity`);
  return BigInt(v);
};
/** eth_call's 32-byte word, or 0 for an empty answer when `empty0` (a call to an account with no code). */
const word0 = (v: unknown, what: string, empty0 = false): bigint => {
  if (empty0 && v === "0x") return 0n;
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${what}: not a word`);
  return BigInt(v);
};
/** One read on both RPCs, the two answers the same (read again once), else failed. */
async function agreed(rpcs: readonly [EvmRpc, EvmRpc], read: (rpc: EvmRpc) => Promise<bigint>): Promise<bigint> {
  for (let i = 0; ; i++) {
    const [a, b] = await Promise.all(rpcs.map(read));
    if (a === b) return a!;
    if (i >= 1) return no("failed");
  }
}

/** One W of the user's that a buy of this pool paid (the note store's SPENT and RESERVED notes), with its record. */
export type EvmSellWallet = { w: string; l: bigint; j: number; route: EvmRoute; block: bigint; held: bigint };
export type EvmSellPlan = { units: bigint; total: bigint; legs: readonly { w: EvmSellWallet; units: bigint }[] };

/** The record of `w` as the sell takes it: this chain's, filled, the token's, with the buy's route and block; else null. */
export function holdingRoute(rec: unknown, chain: Chain, token: string): { route: EvmRoute; block: bigint } | null {
  const h = rec as Partial<EvmHolding> | null;
  if (typeof h !== "object" || h === null || h.chain !== chain || h.state !== "filled" || typeof h.mint !== "string" || lower(h.mint) !== lower(token)) return null;
  const r = h.route;
  const block = typeof r?.block === "string" && /^[1-9][0-9]{0,19}$/.test(r.block) ? BigInt(r.block) : null;
  if (typeof r !== "object" || r === null || typeof r.path !== "object" || r.path === null || block === null) return null;
  return { route: r.path, block };
}

/** The sell's plan (see the header): the Ws with a route, each one's balance on both RPCs, and the legs. */
export async function planEvmSell(h: Pick<EvmSellHost, "chain" | "scope" | "rpcs" | "random" | "notes" | "seed64" | "holdings">, ask: PoolAsk): Promise<EvmSellPlan> {
  if (ask.kind !== "pool.sell" || ask.chain !== h.chain || ask.token === null) return no("not_allowed");
  const token = ask.token;
  const all = await h.holdings();
  const store = await h.notes();
  const paid = (await store.list()).filter((n) => n.scope === h.scope && (n.state === "SPENT" || n.state === "RESERVED") && n.leaf !== undefined);
  const seed = await h.seed64();
  const ws: Omit<EvmSellWallet, "held">[] = [];
  let routeless = false;
  try {
    const seen = new Set<string>();
    for (const n of paid) {
      const l = n.leaf!.label;
      const j = jOf(n.ref);
      const k = freshWallet(seed, "evm", l, j);
      k.secretKey.fill(0);
      const w = lower(k.address);
      if (seen.has(w)) continue;
      seen.add(w);
      const rec = Object.entries(all).find(([a]) => lower(a) === w)?.[1];
      if (rec === undefined || lower(String((rec as Partial<EvmHolding>).mint ?? "")) !== lower(token) || (rec as Partial<EvmHolding>).chain !== h.chain) continue;
      const r = holdingRoute(rec, h.chain, token);
      // a W whose buy of the token has no stored route (or never filled) is never sold (see the header)
      if (r === null) {
        routeless = true;
        continue;
      }
      ws.push({ w, l, j, ...r });
    }
  } finally {
    seed.fill(0);
  }
  if (ws.length === 0) return no(routeless ? "not_allowed" : "not_funded");
  // each W's balance on both RPCs at the lower newest block, one W a request, the Ws in a random order
  const heads = await Promise.all(h.rpcs.map((rpc) => evmHeadNumber(rpc)));
  const low = heads[0]! < heads[1]! ? heads[0]! : heads[1]!;
  // a provider behind a W's buy reads that W's tokens as none: the plan waits (patient's bound) until both are past the
  // newest buy block of the Ws read, so a 100 % sale never leaves a W's tokens out and reads filled
  const newest = ws.reduce((m, x) => (x.block > m ? x.block : m), 0n);
  if (low < newest) throw new EvmLagError(`the pool's RPCs read block ${low}, under the buy at block ${newest}`);
  const at = hexQ(low);
  const held = await Promise.all(shuffled(ws, h.random).map(async (x) => ({ ...x, held: await agreed(h.rpcs, async (rpc) => word0(await rpc("eth_call", [{ to: token, data: `${BALANCE_OF}${word(BigInt(x.w))}` }, at]), "balanceOf")) })));
  const order = held.filter((x) => x.held > 0n).sort((x, y) => (x.held < y.held ? -1 : x.held > y.held ? 1 : x.w < y.w ? -1 : x.w > y.w ? 1 : 0));
  const total = order.reduce((t, x) => t + x.held, 0n);
  const units = ask.shareBps === undefined ? ask.amount : ask.shareBps === 10_000 ? total : (total * BigInt(ask.shareBps)) / 10_000n;
  // short of the units: a W left out for its missing route is why (not_allowed), else not_funded
  if (units <= 0n || units > total) return no(routeless ? "not_allowed" : "not_funded");
  const one = order.find((x) => x.held >= units);
  if (one) return { units, total, legs: [{ w: one, units }] };
  const legs: { w: EvmSellWallet; units: bigint }[] = [];
  let left = units;
  for (const x of order) {
    if (left === 0n) break;
    const take = left < x.held ? left : x.held;
    legs.push({ w: x, units: take });
    left -= take;
  }
  return { units, total, legs };
}

/** One leg's plan and quote: its return note, its nonces, its `sent` and bans, the kit's quote at the ask's slippage,
 *  the decimals at the quote's block. `sim`, W's sim signer (none: a read-only caller, which then cannot price a route
 *  through a hook the venue does not list: the kit refuses that quote bad_request). */
export type EvmSellLegQuote = { q: EvmPoolSellQuote; note: { ref: NoteRef; precommitment: bigint; held: NoteRecord | undefined; resume?: EvmOpenSell; orphan?: boolean }; pending: { ref: NoteRef; precommitment: bigint }[]; nonce: bigint; authNonce: bigint; authReads: readonly [bigint, bigint] };
/** `opens`: the open sales; a note held INCOMING whose sale of this W is open, not on chain and not being sent by this
 *  page is that sale's to sign again (`resume`: its Sell nonce and precommitment, card signpage-evm-pool-sell review
 *  P2-4: a helper's refusal or no answer never locks W's sale until its deadline). `own`: this run's own note. */
/** `pick`: the signer's own evmNextNote pick over its round (signPicked's); the read-only plan picks here. */
export async function evmSellQuoteLeg(h: Omit<EvmSellHost, "send" | "record" | "unrecord" | "open">, ask: PoolAsk, w: EvmSellWallet, seed64: Uint8Array, sim?: (s: EvmSellSim, blockTimestamp: bigint) => Uint8Array, own?: string, opens?: Record<string, EvmOpenSell>, pick?: EvmSellPick): Promise<EvmSellLegQuote> {
  const token = ask.token!;
  const store = await h.notes();
  const round = pick?.round ?? (await h.round());
  // the return note: the first of (return, evm, l, j) and R's second arrivals no deposit names; a taken one before it is
  // the user's own, written so
  const walk = pick?.walk ?? evmNextNote(seed64, h.scope, round.events, returnOf(w), round.fin.number);
  if (walk.taken.length > 0) await evmClaimTaken(store, walk.taken);
  const held = (await store.list()).find((n) => n.scope === h.scope && n.precommitment === walk.next.precommitment);
  // the note to sign is the first one no deposit names: one held INCOMING is a sale signed on it that is not on chain.
  // Its open sale of this W is signed again on its own nonce and note (at most one of the two lands); one another tap of
  // this page is sending now, or one with no open sale of W, is not
  // (only one the helper refused or never answered: a sale whose hash the helper gave is on its way, review P2-A, and a
  // second tap meanwhile answers failed)
  const resume = held?.state === "INCOMING" ? Object.values(opens ?? {}).find((o) => o?.note === held.id && o.chain === h.chain && lower(String(o.w)) === lower(w.w) && BigInt(o.precommitment) === walk.next.precommitment && o.tx === undefined) : undefined;
  const mine = held !== undefined && held.id === own;
  // one held INCOMING with no open sale at all and no deposit naming it: a pending take a sale wrote that a reorg dropped
  // (below); no signature of the device's is out on it (a sale's record outlives its signatures), so it is signed on
  const orphan = held?.state === "INCOMING" && !mine && !Object.values(opens ?? {}).some((o) => o?.note === held.id);
  if (held !== undefined && held.state !== "PLANNED" && !(held.state === "INCOMING" && (mine || orphan || (resume !== undefined && h.sending?.has(held.id) !== true)))) return no("failed");
  const sent = evmSellSent(seed64, h.scope, w.l, w.j, await store.list(), round);
  const nonce = await agreed(h.rpcs, async (rpc) => word0(await rpc("eth_call", [{ to: w.w, data: nonceCall() }, "latest"]), "nonce", true));
  const authReads = (await Promise.all(h.rpcs.map(async (rpc) => quantity(await rpc("eth_getTransactionCount", [w.w, "latest"]), "nonce")))) as [bigint, bigint];
  const banned = await h.banned(token);
  const q = await h.quote({ chain: networkOf(h), token, w: w.w, amountIn: ask.amount, slippageBps: ask.slippageBps, bought: w.route, boughtBlock: w.block, sent, banned, ...(sim ? { signSim: sim } : {}) });
  // the decimals the ask's units were made with, read again at the quote's block on both RPCs
  const at = hexQ(q.block.number);
  const reads = await Promise.all(h.rpcs.map((rpc) => rpc("eth_call", [{ to: token, data: ERC20_DECIMALS }, at])));
  if (tokenDecimalsOf(ask.chain, reads as [unknown, unknown]) !== ask.decimals) return no("quote_check_failed");
  // the chain's notes a deposit names in a block not final yet (a sale of W's on chain, its note not in this store: a
  // wiped device's restore writes final ones only): written INCOMING before the next one is planned (sellLeg), so the
  // store's order rule holds and a later round lands them
  const pending = walk.pending.map((ref) => ({ ref, precommitment: noteSecrets(seed64, ref).precommitment }));
  return { q, note: { ref: walk.next.ref, precommitment: walk.next.precommitment, held, ...(resume && !mine ? { resume } : {}), ...(orphan ? { orphan } : {}) }, pending, nonce, authNonce: authReads[0], authReads };
}

/** The return note's chain for W: (return, evm, l, j), then R's second arrivals. */
const returnOf = (w: EvmSellWallet): NoteRef => ({ kind: "return", c: "evm", l: w.l, j: w.j });
type EvmSellPick = { round: Awaited<ReturnType<EvmSellHost["round"]>>; walk: ReturnType<typeof evmNextNote> };

/** A leg signed: the calldata, the authorization, what the record and the read-back need. */
type Signed = { q: EvmPoolSellQuote; built: EvmPoolSell; data: Uint8Array; authorization: EvmSellAuthorization; sig: string };

/** One leg's quote, build, checks and W's signatures, on `nonce` and `precommitment` when given (a second signature of
 *  the same sale). W's key and every seed copy are zeroed before this returns. */
async function signLeg(h: EvmSellHost, ask: PoolAsk, w: EvmSellWallet, same: { nonce: bigint; precommitment: bigint; note: string } | null): Promise<{ s: Signed; leg: EvmSellLegQuote }> {
  return patient(h, async () => {
    const seed = await h.seed64();
    const held: { key: Uint8Array | null } = { key: null };
    try {
      return await signPicked(h, ask, w, same, seed, held);
    } finally {
      seed.fill(0);
      held.key?.fill(0);
    }
  });
}

/** signLeg's part under its seed copy: W's return note picked through the wallet's evmNextNote first, then every
 *  signature on that pick (W's key in `held`, zeroed by signLeg). */
async function signPicked(h: EvmSellHost, ask: PoolAsk, w: EvmSellWallet, same: { nonce: bigint; precommitment: bigint; note: string } | null, seed: Uint8Array, held: { key: Uint8Array | null }): Promise<{ s: Signed; leg: EvmSellLegQuote }> {
  const clock = clockOf(h);
  const round = await h.round();
  const walk = evmNextNote(seed, h.scope, round.events, returnOf(w), round.fin.number);
  const k = freshWallet(seed, "evm", w.l, w.j);
  const key = k.secretKey;
  held.key = key;
  if (lower(k.address) !== lower(w.w)) return no();
  const pins = venuePins(h.venues, networkOf(h));
  if (pins.feeCollector === undefined || pins.pool === undefined || lower(pins.pool) !== lower(h.pin.pool)) return no("not_allowed");
  const sellAsk: PoolAsk = { ...ask, shareBps: undefined };
  const ctxOf = (feeCap: bigint): PoolContext => ({ nowMs: clock(), wallet: w.w, feeCap, evm: { venues: h.venues, feeRecipient: h.pin.feeRecipient } });
  const signSim = (sim: EvmSellSim, blockTimestamp: bigint): Uint8Array => {
    const ctx = ctxOf(0n);
    checkEvmSellSim(sim, blockTimestamp, sellAsk, ctx, h.testnet);
    return signEvmSellSim(key, ctx, sim);
  };
  const leg = await evmSellQuoteLeg(h, sellAsk, w, seed, signSim, same?.note, await h.open(), { round, walk });
  seed.fill(0);
  // a second signature of one sale (this run's, or an open sale's signed again): W's same Sell nonce and the same
  // precommitment, so at most one of the two lands
  const fix = same ?? (leg.note.resume ? { nonce: BigInt(leg.note.resume.nonce), precommitment: BigInt(leg.note.resume.precommitment) } : null);
  if (fix !== null && (leg.nonce !== fix.nonce || leg.note.precommitment !== fix.precommitment)) return no();
  const deadline = clock() / 1000n + BigInt(EVM_SELL_DEADLINE_S);
  const fields: EvmPoolSellFields = { precommitment: leg.note.precommitment, feeRecipient: pins.feeCollector, deadline, nonce: leg.nonce };
  const built = h.build ? h.build(leg.q, fields) : evmPoolBuildSell(leg.q, fields);
  const ctx = { ...ctxOf(leg.q.feeMax), precommitment: leg.note.precommitment };
  // the floor is the rule's own: the quote's amount out less the ask's slippage (review P3-1)
  checkEvmSell(built, sellAsk, ctx, { amountOut: leg.q.amountOut }, h.testnet);
  // an open sale signed again is that sale: its amount, and a floor no lower than its record's (review P2-A); another
  // amount, or a price under that floor, waits for the open sale's end
  const r = leg.note.resume;
  if (r !== undefined && (built.amount !== BigInt(r.amount) || built.minOut - built.feeCap < BigInt(r.least))) return no("failed");
  const auth = checkEvmAuthorization(sellAsk, ctx, leg.authNonce, leg.authReads, h.testnet);
  const signature = signEvmSell(key, ctx, built);
  const authorization = signEvmAuthorization(key, ctx, auth);
  key.fill(0);
  const data = evmSellCalldata(built, built.feeCap, signature);
  return { s: { q: leg.q, built, data, authorization, sig: Array.from(signature, (b) => b.toString(16).padStart(2, "0")).join("") }, leg };
}

/** The read-back's state: each RPC's `stop`, and the round's want. */
/** `mine`: the run's own Sell signatures (hex), each one it sent: a deposit whose transaction carries none of them is
 *  another signature's of the same nonce and note (another device's), never this run's fill. */
type Watch = { open: EvmOpenSell; stops: [bigint | null, bigint | null]; hint: string | null; q: EvmPoolSellQuote | null; none: bigint | null; mine?: string[] };

/** One leg of one sell: signed, recorded, sent, read back. The tap waits on the send at most EVM_SELL_SEND_TAP_MS (a
 *  busy helper's waits and the second signature run on past it, kept by the page) and on the read-back at most
 *  EVM_SELL_SETTLE_MS; then it answers "sent" and the rest runs on. */
async function sellLeg(h: EvmSellHost, ask: PoolAsk, w: EvmSellWallet, on: { sent(): void }): Promise<{ stage: TradeStage; txs: TxRef[] } | { error: Code }> {
  const hold = h.hold ?? (<T,>(f: () => Promise<T>) => f());
  const clock = clockOf(h);
  const wait = waitOf(h);
  const live = (): boolean => h.signal?.aborted !== true;
  const stopped = (): boolean => h.stopped?.() === true;
  const keep = (p: Promise<unknown>): void => void h.keep?.(p.catch(() => {}));
  let posted = false;
  let followed: string | null = null;
  let sendingNote: string | null = null;
  // the send handed to the page past the tap's bound: its follow then owns `followed`
  let background = false;
  type Sent = { refused: Watch } | { watch: Watch } | { answer: { stage: TradeStage; txs: TxRef[] } };
  try {
    const start = await hold(async () => {
      const { s, leg } = await signLeg(h, ask, w, null);
      if (stopped()) return no();
      // the read-back's start, read before anything leaves: two heads further apart than the buy's bound refuse the run
      // (review P2-2), so the start is never far under the chain on two honest RPCs
      const heads = await Promise.all(h.rpcs.map((rpc) => evmHeadNumber(rpc)));
      const [lo, hi] = heads[0]! < heads[1]! ? [heads[0]!, heads[1]!] : [heads[1]!, heads[0]!];
      if (hi - lo > EVM_BUY_HEAD_SPREAD) return no();
      const store = await h.notes();
      const resume = leg.note.resume;
      // two sales of one W never share a Sell nonce or a note: any other open sale of W on either is a refusal
      const others = Object.values(await h.open()).filter((o) => o?.chain === h.chain && lower(String(o.w)) === lower(w.w) && o.note !== resume?.note);
      if (others.some((o) => BigInt(o.nonce) === s.built.nonce || BigInt(o.precommitment) === s.built.precommitment)) return no();
      for (const p of leg.pending) {
        if ((await store.list()).some((n) => n.scope === h.scope && n.precommitment === p.precommitment)) continue;
        const m = await store.add({ ref: p.ref, scope: h.scope, precommitment: p.precommitment, state: "PLANNED" });
        await store.move(m.id, "PLANNED", "INCOMING");
      }
      if (leg.note.orphan) await store.move(leg.note.held!.id, "INCOMING", "PLANNED");
      const note = leg.note.held ?? (await store.add({ ref: leg.note.ref, scope: h.scope, precommitment: leg.note.precommitment, state: "PLANNED" }));
      if (h.sending?.has(note.id)) return no();
      h.sending?.add(note.id);
      sendingNote = note.id;
      const least = s.built.minOut - s.built.feeCap;
      const open: EvmOpenSell = {
        note: note.id,
        chain: h.chain,
        w: w.w,
        token: lower(ask.token!),
        amount: s.built.amount.toString(),
        precommitment: leg.note.precommitment.toString(),
        nonce: s.built.nonce.toString(),
        deadline: s.built.deadline.toString(),
        // an open sale signed again keeps its first start and floor (signPicked holds the new one no lower)
        from: resume ? resume.from : (lo > EVM_SELL_LAG_BLOCKS ? lo - EVM_SELL_LAG_BLOCKS : 0n).toString(),
        least: resume ? resume.least : least.toString(),
      };
      if (h.following !== undefined && !h.following.has(note.id)) {
        h.following.add(note.id);
        followed = note.id;
      }
      // the record, then the note INCOMING, before anything leaves: a write that fails sends nothing
      await h.record(open);
      if (resume === undefined) {
        try {
          await store.move(note.id, "PLANNED", "INCOMING");
        } catch (e) {
          await h.unrecord(open.note, open.deadline).catch(() => {});
          throw e;
        }
      }
      posted = true;
      return { s, open, note: note.id };
    });
    const { open } = start;
    let s = start.s;
    const mine = [s.sig];
    // the send: the same bytes after a busy helper's wait while the deadline leaves the helper its send margin; past it,
    // once, the sale signed again on the same nonce and note (under the seed's lock), its deadline raised in the record
    const sending = (async (): Promise<Sent> => {
      let resigned = false;
      for (;;) {
        try {
          const hint = await h.send({ pool: h.pin.pool, w: w.w, data: s.data, authorization: s.authorization });
          // the helper took it: its hash in the record, so no tap signs this sale again while it is on its way
          open.tx = hint;
          await h.record(open).catch(() => {});
          return { watch: { open, stops: [null, null], hint, q: s.q, none: null, mine } };
        } catch (e) {
          // a refusal, after busy answers too (a 503 took nothing): no signature of it was sent
          if (e instanceof EvmSendRefused) return { refused: { open, stops: [null, null], hint: null, q: s.q, none: null, mine } };
          if (!(e instanceof EvmSendBusy) || stopped()) break;
          const after = Math.max(e.retryAfterMs, 1_000);
          if (clock() + BigInt(after) < s.built.deadline * 1000n - EVM_SEND_MARGIN_MS) {
            for (let left = after; left > 0 && !stopped(); left -= STOP_POLL_MS) await wait(Math.min(STOP_POLL_MS, left));
            if (stopped()) break;
            continue;
          }
          if (resigned) break;
          resigned = true;
          for (let left = after; left > 0 && !stopped(); left -= STOP_POLL_MS) await wait(Math.min(STOP_POLL_MS, left));
          if (stopped()) break;
          const again = await hold(() => signLeg(h, ask, w, { nonce: s.built.nonce, precommitment: s.built.precommitment, note: start.note })).catch(() => null);
          if (again === null || stopped()) break;
          s = again.s;
          mine.push(s.sig);
          open.deadline = s.built.deadline.toString();
          const least = s.built.minOut - s.built.feeCap;
          if (least < BigInt(open.least)) open.least = least.toString();
          await h.record(open);
        }
      }
      // no answer, a busy helper past both deadlines, or a sign out: the bytes may be on their way
      if (stopped()) return { answer: { stage: "sent", txs: [] } };
      return { watch: { open, stops: [null, null], hint: null, q: s.q, none: null, mine } };
    })().finally(() => {
      if (sendingNote !== null) h.sending?.delete(sendingNote);
      sendingNote = null;
    });
    const follow = (x: Watch, refused: boolean): void => {
      const mine = followed;
      followed = null;
      keep(
        watch(h, x, live, (ms) => wait(clock() > BigInt(x.open.deadline) * 1000n + 60_000n ? EVM_SELL_SLOW_WAIT_MS : ms), clock, live)
          .finally(() => void (mine !== null && h.following?.delete(mine)))
          .then((a) => {
            if (a === null || "lost" in a || !live()) return;
            // a refused send never left the helper: a deposit later is another signature's, which its own tap tells
            if (!refused) h.late?.(a);
          }),
      );
    };
    const after = (out: Sent): void => {
      // a sign out (this tab's, or the page's) frees the note's follow mark at once (review F3b)
      if ("answer" in out || !live()) {
        if (followed !== null) h.following?.delete(followed);
        followed = null;
        return;
      }
      // a refusal that comes past the tap's bound is told as a late stage (review F4)
      if ("refused" in out && background) h.late?.({ stage: "refused", txs: [] });
      follow("refused" in out ? out.refused : out.watch, "refused" in out);
    };
    // the tap's bound on the send (review P3-3): past it, answered "sent", the send and its read-back run on
    let bound: ReturnType<typeof setTimeout> | undefined;
    const out = await Promise.race([sending, new Promise<null>((r) => (bound = setTimeout(() => r(null), h.sendTapMs ?? EVM_SELL_SEND_TAP_MS)))]).finally(() => clearTimeout(bound));
    on.sent();
    if (out === null) {
      background = true;
      keep(sending.then(after));
      return { stage: "sent", txs: [] };
    }
    if ("answer" in out) return out.answer;
    if ("refused" in out) {
      after(out);
      return { stage: "refused", txs: [] };
    }
    const sentAt = clock();
    const tap = await watch(h, out.watch, () => live() && clock() - sentAt < BigInt(EVM_SELL_SETTLE_MS), wait, clock, live, true);
    if (tap !== null && "lost" in tap) return { error: "failed" };
    if (tap !== null && tap.stage !== "sent") {
      // the tap's end; a refused one (the hint's receipt failed) still reads on to the deadline
      if (tap.stage === "refused" && live()) follow(out.watch, true);
      return tap;
    }
    if (!live()) return { stage: "sent", txs: [] };
    follow(out.watch, false);
    return { stage: "sent", txs: [] };
  } catch (e) {
    if (posted) return { stage: "sent", txs: [] };
    if (e instanceof EvmNotFinalError) throw e;
    if (e instanceof Refused) return { error: e.code };
    if (e instanceof PoolRuleRefused) return { error: "quote_check_failed" };
    const name = (e as { name?: unknown })?.name;
    if (name === "EvmQuoteError" || name === "EvmPoolSellError") return { error: (e as { code?: unknown }).code === "release_in_flight" ? "down" : "quote_check_failed" };
    if (unanswered(e)) return { error: "down" };
    return { error: "failed" };
  } finally {
    if (!posted && sendingNote !== null) h.sending?.delete(sendingNote);
    if (followed !== null && !background) h.following?.delete(followed);
  }
}

/** The helper's hash on both RPCs: true only when it is W's sale (a transaction to W whose input is SellDelegate.sell
 *  carrying the sale's precommitment) and its receipt failed on both (status 0); false otherwise, and the run reads on
 *  (review P3-2: a server's hash is never believed on its own). */
async function revertedOnBoth(rpcs: readonly [EvmRpc, EvmRpc], tx: string, o: EvmOpenSell): Promise<boolean> {
  const P = word(BigInt(o.precommitment));
  const one = async (rpc: EvmRpc): Promise<boolean> => {
    const [t, r] = await Promise.all([rpc("eth_getTransactionByHash", [tx]), rpc("eth_getTransactionReceipt", [tx])]);
    const x = t as { to?: unknown; input?: unknown } | null;
    if (typeof x?.to !== "string" || lower(x.to) !== lower(o.w) || typeof x.input !== "string" || !lower(x.input).startsWith(evmSellSelector()) || !lower(x.input).includes(P)) return false;
    return typeof r === "object" && r !== null && (r as { status?: unknown }).status === "0x0";
  };
  const rs = await Promise.all(rpcs.map((rpc) => one(rpc).catch(() => false)));
  return rs.every(Boolean);
}

/** The read-back's rounds while `more()` (see the header): the end's answer, or null (none in time, or a sign out),
 *  after which nothing is written. `tap`: the tap's own reads, which answer refused once the hint's receipt failed. */
async function watch(h: EvmSellHost, x: Watch, more: () => boolean, wait: (ms: number) => Promise<void>, clock: () => bigint, live: () => boolean, tap = false): Promise<{ stage: TradeStage; txs: TxRef[] } | { lost: true } | null> {
  let reverted = false;
  for (let i = 0; i === 0 || more(); i++) {
    if (i > 0) await wait(EVM_SELL_WAIT_MS);
    let v: EvmSellVerdict;
    const deadlineMs = BigInt(x.open.deadline) * 1000n;
    try {
      const reads = (await Promise.all(h.rpcs.map((rpc, k) => evmDepositedRead(rpc, h.pin.pool, BigInt(x.open.from), deadlineMs, x.stops[k]!)))) as [EvmDepositedRead, EvmDepositedRead];
      x.stops = [reads[0].stop, reads[1].stop];
      v = evmSellVerdict(reads, { precommitment: BigInt(x.open.precommitment), w: x.open.w, least: BigInt(x.open.least) });
    } catch {
      continue;
    }
    if (!live()) return null;
    if (v?.end !== "not_landed") x.none = null;
    if (v === null) {
      // the helper's hash a hint: a sale that failed on both RPCs (its pools banned where the revert proves them at fault)
      if (tap && !reverted && x.hint !== null && (await revertedOnBoth(h.rpcs, x.hint, x.open))) {
        reverted = true;
        if (x.q !== null && x.q.hooked.length > 0) {
          const bad = await h.reverted(x.q, x.hint).catch(() => [] as readonly string[]);
          if (bad.length > 0) await h.ban(x.open.token, bad).catch(() => {});
        }
        return { stage: "refused", txs: [{ chain: h.chain, hash: x.hint }] };
      }
      continue;
    }
    if (v.end === "not_landed") {
      // past the deadline on both RPCs' safe blocks with no deposit of it, on two rounds EVM_BUY_LAG_MS apart (the buy's
      // rule, review P2-3: one round of log answers trailing their headers never answers it)
      const at = clock();
      if (x.none === null) x.none = at;
      if (at - x.none < BigInt(EVM_BUY_LAG_MS)) continue;
      // and W's Sell nonce not taken on either RPC: a nonce past the sale's is a Sell that ran, its logs trailing (review
      // D1), read on until EVM_SELL_USED_GRACE_MS past the deadline
      const used = await Promise.all(h.rpcs.map(async (rpc) => word0(await rpc("eth_call", [{ to: x.open.w, data: nonceCall() }, "latest"]), "nonce", true))).catch(() => null);
      if (used === null) continue;
      if (used.some((n) => n > BigInt(x.open.nonce)) && at < deadlineMs + BigInt(EVM_SELL_USED_GRACE_MS)) continue;
      // a sale signed again since (its record's deadline raised): the newer signature's run follows it, not this one
      const now = (await h.open())[x.open.note];
      if (now !== undefined && now.deadline !== x.open.deadline) return null;
      // the note back PLANNED, the record dropped
      const store = await h.notes();
      const n = await store.get(x.open.note);
      if (n?.state === "INCOMING") await store.move(n.id, "INCOMING", "PLANNED").catch(() => {});
      await h.unrecord(x.open.note, x.open.deadline).catch(() => {});
      return { stage: "not_landed", txs: [] };
    }
    h.deposited?.(x.open, v.deposit.block);
    // the deposit is another signature's (review P2-A): this sale was signed again since (a newer record follows it), or
    // its transaction carries none of this run's signatures (another device's sale on the same nonce and note): this
    // one never ran, and it answers so, never filled; the note is the user's all the same and lands
    const now = (await h.open().catch(() => ({}) as Record<string, EvmOpenSell>))[x.open.note];
    if (now !== undefined && now.deadline !== x.open.deadline) return { lost: true };
    const txs: TxRef[] = [{ chain: h.chain, hash: v.deposit.tx }];
    // the note lands from the pool's round once its block is final (a later round's, on a load, when not yet)
    await land(h, x.open).catch(() => {});
    if (x.mine !== undefined && x.mine.length > 0) {
      const inputs = await Promise.all(h.rpcs.map((rpc) => rpc("eth_getTransactionByHash", [v.deposit.tx]).then((t) => (t as { input?: unknown } | null)?.input, () => undefined)));
      // both read and neither carries one of them; a read that fails tells nothing, and the fill stands
      if (inputs.every((i) => typeof i === "string") && !inputs.some((i) => x.mine!.some((m) => lower(i as string).includes(m)))) return { lost: true };
    }
    return { stage: v.end === "filled" ? "filled" : "refused", txs };
  }
  return null;
}

/** The open sale's note from the pool's round: written UNSPENT once a final block holds the deposit naming it (the
 *  wallet's evmNextNote taken, written by evmClaimTaken), and the record dropped then. */
async function land(h: EvmSellHost, o: EvmOpenSell): Promise<boolean> {
  const round = await h.round();
  const store = await h.notes();
  const n = await store.get(o.note);
  if (n === undefined) return false;
  // the chain the note is on: its return note, R's second arrivals after it
  const first: NoteRef | null = n.ref.kind === "return" ? n.ref : n.ref.kind === "second" && n.ref.id.id === "R" ? { kind: "return", c: n.ref.id.c, l: n.ref.id.l, j: n.ref.id.j } : null;
  if (first === null) return false;
  const seed = await h.seed64();
  try {
    const walk = evmNextNote(seed, h.scope, round.events, first, round.fin.number);
    const mine = walk.taken.find((t) => t.precommitment === n.precommitment);
    if (mine === undefined) return false;
    // with it, every final one of the chain no other open sale holds (a pending take a sale wrote INCOMING); each open
    // sale's own lands in its own run
    const others = new Set(Object.values(await h.open()).filter((x) => x?.note !== o.note).map((x) => String(x?.precommitment)));
    await evmClaimTaken(store, walk.taken.filter((t) => t === mine || !others.has(t.precommitment.toString())));
  } finally {
    seed.fill(0);
  }
  await h.unrecord(o.note, o.deadline);
  return true;
}

/**
 * The load's follow of open sales (a page closed between the record and the send, or after the send): each open record
 * of this chain no run of this page follows is read as the run reads it, from its own block, to an end (filled or taken
 * lands the note from the round, not_landed puts it back PLANNED), the record dropped at the end. A filled sale whose
 * block is not final yet keeps its record, and the next load lands it. Never awaited by a tap.
 */
export async function followEvmSells(h: EvmSellHost): Promise<void> {
  const live = (): boolean => h.signal?.aborted !== true;
  const clock = clockOf(h);
  const wait = waitOf(h);
  const runs: Promise<unknown>[] = [];
  let heads: Promise<bigint[] | null> | null = null;
  for (const o of Object.values(await h.open())) {
    if (o?.chain !== h.chain || typeof o.note !== "string" || h.following?.has(o.note) || !live()) continue;
    // a record whose start no run writes is left as it is, unread (the buy's rule, review P2-2): under the pool's
    // deploy block, or past either RPC's newest
    let from: bigint;
    try {
      from = BigInt(o.from);
      BigInt(o.deadline);
      BigInt(o.precommitment);
      BigInt(o.least);
    } catch {
      continue;
    }
    if (from < h.pin.fromBlock) continue;
    heads ??= Promise.all(h.rpcs.map((rpc) => evmHeadNumber(rpc))).catch(() => null);
    const hs = await heads;
    if (hs === null || hs.some((n) => from > n) || h.following?.has(o.note) || !live()) continue;
    h.following?.add(o.note);
    const x: Watch = { open: o, stops: [null, null], hint: null, q: null, none: null };
    runs.push(
      watch(h, x, live, (ms) => wait(clock() > BigInt(o.deadline) * 1000n + 60_000n ? EVM_SELL_SLOW_WAIT_MS : ms), clock, live)
        .catch(() => {})
        .finally(() => h.following?.delete(o.note)),
    );
  }
  await Promise.all(runs);
}

/** One pool.sell on an EVM chain: the ask is the user's own (rules/pool.ts checkPoolRequest passed it, with the token's
 *  decimals): its plan, then each leg in turn up to its send, their read-backs side by side. */
export async function runEvmPoolSell(host: EvmSellHost, ask: PoolAsk): Promise<PoolSellAnswer> {
  // one tap's waits: its plan's and every sale's share the rule's one bound (read-waits.ts READ_WAIT_TOTAL_MS)
  const h: EvmSellHost = host.waits ? host : { ...host, waits: readWaits(readClockOf(host)) };
  let plan: EvmSellPlan;
  try {
    plan = await patient(h, () => planEvmSell(h, ask));
  } catch (e) {
    if (e instanceof Refused) return { error: e.code };
    return { error: unanswered(e) ? "down" : "failed" };
  }
  const legs: PoolSellLeg[] = plan.legs.map((l) => ({ wallet: l.w.w, amount: l.units.toString(), tx: null, stage: null }));
  let told = false;
  let turn: Promise<void> = Promise.resolve();
  const runs = plan.legs.map((l, i) => {
    let open!: () => void;
    const mine = new Promise<void>((r) => (open = r));
    const prior = turn;
    turn = mine;
    return prior
      .then(() => (h.stopped?.() ? ({ error: "failed" } as const) : sellLeg(h, { ...ask, amount: l.units, shareBps: undefined }, { ...l.w, held: l.units }, { sent: () => (open(), told || ((told = true), h.sent?.())) })))
      .catch((e: unknown) => {
        if (e instanceof EvmNotFinalError) return { error: "down" as const };
        return { error: "failed" as const };
      })
      .then((a) => {
        open();
        legs[i] = "error" in a ? { ...legs[i]!, error: a.error } : { ...legs[i]!, tx: a.txs.at(-1)?.hash ?? null, stage: a.stage };
        return a;
      });
  });
  const got = await Promise.all(runs);
  if (got.length === 1 && "error" in got[0]!) return got[0]!;
  if (got.every((a) => "error" in a)) return got[0]!;
  const txs: TxRef[] = legs.flatMap((l) => (l.tx === null ? [] : [{ chain: h.chain, hash: l.tx }]));
  return { stage: stageOfLegs(legs), txs, ...(legs.length > 1 ? { legs } : {}) };
}

/** The plan and each leg's quote with no key and no write (a read-only kind's: the plan, then each leg's quote as the
 *  sell would make it, with no sim signer, so a route through a hook the venue does not list is not priced). The seed
 *  is read for the return note's walk and `sent` only, and zeroed. */
export async function evmSellPlanQuote(h: Omit<EvmSellHost, "send" | "record" | "unrecord" | "open">, ask: PoolAsk): Promise<{ plan: EvmSellPlan; legs: EvmSellLegQuote[] }> {
  return patient(h, async () => {
    const plan = await planEvmSell(h, ask);
    const legs: EvmSellLegQuote[] = [];
    for (const l of plan.legs) {
      const seed = await h.seed64();
      try {
        legs.push(await evmSellQuoteLeg(h, { ...ask, amount: l.units, shareBps: undefined }, l.w, seed));
      } finally {
        seed.fill(0);
      }
    }
    return { plan, legs };
  });
}

// ---------- the restore of the buy records (card signpage-evm-pool-sell) ----------
// A wiped browser has its notes back from the words (the wallet's evmRestoreNotes), but not W's buy record, whose route
// the sell needs. Each spend of the restore that bought a token (its Bought at a block, a log index and a block hash,
// on both pool RPCs as the restore read it) has its record written again from the buy's own transaction: the Bought log
// at that block, asked by the pool's address and topic only, gives its transaction's place in the block on both RPCs;
// the block with its transactions, read by number on both, gives that transaction, sent to the pool, the same input on
// both; its Buy (evm-send.ts evmBuyCalldataRead) must be the kit's builder's encoding of its route (evmBuyRouteOf, the
// helper's own check) and buy the token the Bought names. No read names W or a transaction hash. A record the buy wrote
// is never replaced; one that holds no route block takes this one's route.
const topicBought = (): string => `0x${Array.from(keccak_256(new TextEncoder().encode("Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)")), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** A buy spend as the restore names it: W, the token, and its Bought's place. */
export type EvmBuySpend = { w: string; token: string; block: bigint; blockHash: string; logIndex: bigint };

/** The route the buy of `s` took, from its own transaction on both RPCs (see above): its venue, adapter, path, tx and
 *  block; throws when the two RPCs differ or the transaction is not a Buy of the pool the device's builder makes. */
export async function evmBuyRouteRead(rpcs: readonly [EvmRpc, EvmRpc], network: EvmPoolChain, pool: string, s: EvmBuySpend): Promise<EvmHolding["route"]> {
  const one = async (rpc: EvmRpc) => {
    const logs = (await rpc("eth_getLogs", [{ address: lower(pool), topics: [topicBought()], fromBlock: hexQ(s.block), toBlock: hexQ(s.block) }])) as unknown;
    if (!Array.isArray(logs)) throw new Error("restore: not a log list");
    const log = (logs as Record<string, unknown>[]).find((l) => typeof l === "object" && l !== null && l.removed !== true && typeof l.logIndex === "string" && BigInt(l.logIndex) === s.logIndex && typeof l.blockHash === "string" && lower(l.blockHash) === lower(s.blockHash));
    const topics = Array.isArray(log?.topics) ? (log!.topics as unknown[]) : [];
    if (log === undefined || typeof topics[1] !== "string" || BigInt(topics[1]) !== BigInt(s.w) || typeof log.transactionIndex !== "string" || typeof log.transactionHash !== "string") throw new Error("restore: no Bought for W at its place");
    const tx = lower(log.transactionHash);
    const block = (await rpc("eth_getBlockByNumber", [hexQ(s.block), true])) as { hash?: unknown; transactions?: unknown } | null;
    if (typeof block?.hash !== "string" || lower(block.hash) !== lower(s.blockHash) || !Array.isArray(block.transactions)) throw new Error("restore: not the Bought's block");
    const t = block.transactions[Number(BigInt(log.transactionIndex))] as { hash?: unknown; to?: unknown; input?: unknown } | undefined;
    if (typeof t?.hash !== "string" || lower(t.hash) !== tx || typeof t.to !== "string" || lower(t.to) !== lower(pool) || typeof t.input !== "string") throw new Error("restore: the Bought's transaction is not a call to the pool");
    return { tx, input: lower(t.input) };
  };
  const [a, b] = await Promise.all(rpcs.map(one));
  if (a!.tx !== b!.tx || a!.input !== b!.input) throw new Error("restore: the two RPCs name another buy");
  const buy = evmBuyCalldataRead(a!.input);
  if (buy === null || lower(buy.token) !== lower(s.token)) throw new Error("restore: the transaction is not a Buy of the token");
  const path = evmBuyRouteOf(network, buy);
  return { venue: path.venue, adapter: lower(buy.adapter), path, tx: a!.tx, block: s.block.toString() };
}

/** Each restored buy's record written (see above): a W with a record keeps it, a record with no route block takes the
 *  read one. A spend whose read fails is left: its W is not sold until a later restore reads it (the sell refuses a W
 *  with no route). Returns the Ws written. */
export async function restoreEvmHoldings(a: { chain: Chain; testnet: boolean; pin: EvmPoolPin; rpcs: readonly [EvmRpc, EvmRpc]; store: Pick<WalletStore, "get" | "update">; spends: readonly EvmBuySpend[]; signal?: AbortSignal }): Promise<string[]> {
  const network = networkOf(a);
  const out: string[] = [];
  for (const s of a.spends) {
    // a sign out ends the restore: no read starts after it (card restore-first-sign-in-under-two-minutes)
    a.signal?.throwIfAborted();
    let route: EvmHolding["route"];
    let decimals: number;
    try {
      route = await evmBuyRouteRead(a.rpcs, network, a.pin.pool, s);
      decimals = await keptTokenDecimals(a.chain, s.token, a.rpcs as readonly [PoolRpc, PoolRpc], a.signal ? { signal: a.signal } : {});
    } catch {
      continue;
    }
    a.signal?.throwIfAborted();
    const w = s.w;
    let wrote = false;
    await a.store.update("meta", EVM_POSITION_COSTS_KEY, (v) => {
      const all = recordsOf(v);
      const key = Object.keys(all).find((k) => lower(k) === lower(w)) ?? w;
      const had = all[key] as Partial<EvmHolding> | undefined;
      if (had !== undefined && holdingRoute(had, a.chain, s.token) !== null) return undefined;
      // a pending buy is its own run's; a withdrawn one was sold: only a filled record with no route takes the read one
      if (had !== undefined && (had.state !== "filled" || lower(String(had.mint ?? "")) !== lower(s.token))) return undefined;
      wrote = true;
      const rec: EvmHolding = { ...(had as EvmHolding | undefined), mint: lower(s.token), decimals: had?.decimals ?? decimals, chain: a.chain, state: "filled", route };
      return { ...all, [key]: rec };
    });
    if (wrote) out.push(w);
  }
  return out;
}

/** What the page gives an EVM sell (src/pool-testnet.ts). */
export type EvmSellPage = {
  following?: Set<string>;
  sending?: Set<string>;
  keep?(p: Promise<unknown>): void;
  notes(): Promise<NoteStore>;
  seed64(): Promise<Uint8Array>;
  /** The wallet store while one is open: never opened by the sell, so a write after a sign out fails. */
  held(): Promise<WalletStore>;
  round(): Promise<{ events: readonly EvmPoolEvent[]; fin: { number: bigint } }>;
  testnet: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** The session's sign out, aborted at its tap (EvmSellHost.stop). */
  stop?: AbortSignal;
  stopped?(): boolean;
};

const recordsOf = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? { ...(v as Record<string, unknown>) } : {});

/** The page's host for one EVM sell: the kit's quote, build and revert evidence, the helper's sell sender, the pool's
 *  pair, the buy records, bans and open sales in the wallet store's meta. */
export function evmSellHost(chain: Chain, pin: EvmPoolPin, scope: bigint, rpcs: readonly [EvmRpc, EvmRpc], page: EvmSellPage): EvmSellHost {
  return {
    chain,
    testnet: page.testnet,
    pin,
    scope,
    venues: evmPoolVenues(),
    rpcs,
    round: page.round,
    notes: page.notes,
    seed64: page.seed64,
    holdings: async () => recordsOf(await (await page.held()).get("meta", EVM_POSITION_COSTS_KEY)),
    quote: evmPoolSellQuote,
    banned: async (token) => evmSellBanned(await page.held(), networkOf({ chain, testnet: page.testnet }), token),
    ban: async (token, pools) => void (await evmSellBan(await page.held(), networkOf({ chain, testnet: page.testnet }), token, pools)),
    reverted: evmSellRevertedPools,
    send: (body) => evmSellSend(TRADE_HELPER, body, page.fetch, page.signal),
    open: async () => recordsOf(await (await page.held()).get("meta", EVM_OPEN_SELLS_KEY)) as Record<string, EvmOpenSell>,
    record: async (o) => void (await (await page.held()).update("meta", EVM_OPEN_SELLS_KEY, (v) => ({ ...recordsOf(v), [o.note]: o }))),
    unrecord: async (note, deadline) =>
      void (await (await page.held()).update("meta", EVM_OPEN_SELLS_KEY, (v) => {
        const all = recordsOf(v);
        if ((all[note] as Partial<EvmOpenSell> | undefined)?.deadline === deadline) delete all[note];
        return all;
      })),
    following: page.following,
    ...(page.sending ? { sending: page.sending } : {}),
    ...(page.keep ? { keep: page.keep } : {}),
    signal: page.signal,
    ...(page.stop ? { stop: page.stop } : {}),
    stopped: page.stopped,
  };
}

type Locks = Pick<LockManager, "request">;

/** The pool.sell kind on an EVM chain: one run per tap; the part up to each send under the seed's shared lock, the
 *  read-back outside it. Answered "sent" once the first bytes have left, or with the run's own answer. */
export function poolSellEvmKind(host: () => EvmSellHost & { end?(): void }, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk, ctx: KindContext | null): HostRefusal | Running<"pool.sell"> => {
    if (ask.kind !== "pool.sell" || (ask.chain !== "base" && ask.chain !== "robinhood") || !locks) return { error: "not_allowed" };
    // the tap's one bound, from its arrival (pool-kinds started it already when the sell came through its decimals read)
    const waits = tapWaits(ctx);
    let answer: HostAnswer<"pool.sell"> | HostRefusal | null = null;
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    const run = (async () => {
      const h = host();
      try {
        const a = await runEvmPoolSell(
          {
            ...h,
            waits,
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
    // the request's run ended: its bound dropped (read-waits.ts tapDone)
    void run.then(() => tapDone(ctx, waits));
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
