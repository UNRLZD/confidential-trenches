// The private balance per chain's pool on SIGN_HOST's top-level page (card balances-per-chain; the kit's
// SignpageState.pools). The top-level page reads its own notes, read only (../../wallet/src/notes/store.ts readNotes:
// no lock, no write), and adds, per chain of the page's pool table, the balance its notes hold in the pool's asset and
// how much of it has a proof ready (../../wallet/src/pool/balances.ts). Never from a server: the asset too comes from
// the page's own table, its decimals from the kit's POOL_ASSET_DECIMALS.
//
// - Top-level only: the frame keeps no note data and never opens the note store (src/state.ts); main.ts wraps only the
//   shell's state with this.
// - Never throws, as the API's state() must not (src/api.ts ApiHost.state): a notes read that fails, or notes or a pool
//   table the sum refuses, gives the state without `pools`, and the next read tries again. A note change reaches the
//   watchers on the shell's channel (src/state.ts), so the app hears the new balances.
// - What crosses to APP_HOST: per chain, the pool's total and its ready part, never a note. The app reads the state
//   each time the store changes, so two totals in a row can differ by a single note's value.
// - Signed out: the state as it is, the notes never read. An empty pool table: `pools: []`, the notes never read.
// - The answer cap: `pools` takes room the ops may already fill; the oldest ops give way, so the answer never grows past
//   what the client reads. That is the rule the state already follows without pools: src/state.ts's header (:24-27,
//   "the oldest dropped until the answer's UTF-8 JSON fits SIGNPAGE_MAX_ANSWER_BYTES with ANSWER_ROOM to spare") and
//   pickOps (:86-106), which drops the oldest ops until the rest of the state holding them fits. withPools re-runs
//   pickOps with `pools` in that rest, so pools take the room as any other field of the state does. When no ops are left
//   to give and the rest of the state still leaves pools no room, the state goes without pools, as it was.
import type { Chain } from "../../kit/src/orders/record.ts";
import type { ErrorCode, PoolBuyDry, PoolStatePrice, SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { readSolanaPoolBuyVenue, readSolanaRent, readSolanaVenueAt, solanaPoolBuyFunds, solanaPoolBuyTip, solanaPoolFee, type SolanaPoolBuyVenue, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import { pickPieces, solanaLegsPlan, unitsOf, type LegPiece } from "./pool-buy.ts";
import { carriesOf, carryOk } from "./pool-carry.ts";
import { pageReference, pinnedBuyVenues, POOL_FINDER_VENUES, solanaBuyVenue, type PoolFinderKind, type PoolFinders } from "./page-rpc.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { heldBy, type NoteRecord } from "../../wallet/src/notes/store.ts";
import { evmBalancePool, evmTapSpendOf, poolBalances, solanaBalancePool, solanaTapSpendOf, type BalancePool, type BalanceProof, type LandedRelease } from "../../wallet/src/pool/balances.ts";
import { EVM_CHAIN_IDS, EVM_POOLS, evmPoolScopeOf, type EvmNetwork } from "../../wallet/src/pool/evm.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";
import { SOL_LADDER, SOL_POOL_TABLES, SOL_POOLS, SOL_TIP_CAP, solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { ladderSplit } from "../../wallet/src/pool/ladder.ts";
import type { Running } from "./api.ts";
import { ANSWER_ROOM, pickOps } from "./state.ts";

/** Each app chain's EVM network on the page's network. */
const EVM_NETWORKS: Readonly<Record<"mainnet" | "testnet", Readonly<Record<"base" | "robinhood", EvmNetwork>>>> = Object.freeze({
  mainnet: Object.freeze({ base: "base", robinhood: "robinhood" } as const),
  testnet: Object.freeze({ base: "base-sepolia", robinhood: "robinhood-testnet" } as const),
});

/**
 * The pool table of a network's pins (card signpage-pool-pins): the Solana pool SOL_POOLS pins on its cluster (mainnet,
 * or devnet for the testnet build) and each EVM pool EVM_POOLS pins on Base's and Robinhood's network, never typed in.
 * Each goes through solanaBalancePool or evmBalancePool (../../wallet/src/pool/balances.ts), so its asset follows its
 * kind, under the id and scope its pool kind gives it (../../wallet/src/pool/solana.ts solanaPool `sol:<program>` and
 * solanaPoolOf's scope; ../../wallet/src/pool/evm.ts evmPool `evm:<network>:<pool>` and evmPoolScopeOf's), so a ready
 * proof's poolId names its entry. An EVM entry spends a whole chunk at the tap (evmTapSpendOf); the Solana entry has no
 * spendOf, so no tap_max, until withSolanaRent gives it the Rent sysvar read on two RPCs. `solPins` and `evmPins`: the
 * wallet's tables, other ones in tests only.
 */
export function pagePoolsOf(network: "mainnet" | "testnet", solPins = SOL_POOLS, evmPins = EVM_POOLS): readonly BalancePool[] {
  const out: BalancePool[] = [];
  const sol = network === "testnet" ? solPins.devnet : solPins.mainnet;
  if (sol !== undefined) out.push(solanaBalancePool(`sol:${sol.program}`, solanaPoolOf(sol.program).scope));
  for (const chain of ["base", "robinhood"] as const) {
    const net = EVM_NETWORKS[network][chain];
    const pin = evmPins[net];
    if (pin === undefined) continue;
    const pool = pin.pool.toLowerCase();
    out.push(evmBalancePool(`evm:${net}:${pool}`, chain, evmPoolScopeOf(pool, EVM_CHAIN_IDS[net]), evmTapSpendOf));
  }
  return Object.freeze(out);
}

/**
 * The page's pool table on its network (../../wallet/src/pool/network.ts POOL_TESTNET): mainnet's pins in SIGN_HOST's
 * build (the Solana pool SOL_POOLS.mainnet pins, card sol-pools-mainnet-pin, and Base's and Robinhood's EVM_POOLS pins,
 * card evm-pools-on-mainnet), devnet's and the two EVM testnets' in the testnet build.
 */
export const PAGE_POOLS: readonly BalancePool[] = pagePoolsOf(POOL_TESTNET ? "testnet" : "mainnet");

/** The tip a pool.buy on this page pays for a set of k pieces (src/pool-buy.ts tipOf, the kit's solanaPoolBuyTip):
 *  SOLANA_POOL_JITO_TIP on mainnet for any count of pieces, none on devnet. */
export const pageBuyTip = (k: number): bigint => solanaPoolBuyTip(POOL_TESTNET ? "devnet" : "mainnet", k);

/** `pools` with each Solana entry's tap spend at `rent` (the kit's Rent sysvar, read on two RPCs): its tap_max, on
 *  `venue` (a coin's own, pool.buy.dry) or, with none, on the costliest venue of any coin (state.pools), at the tip the
 *  buy pays (`tipOf`, pageBuyTip; card max-is-what-you-hold-after-a-trade), so Max is all the buy's pick funds. */
export function withSolanaRent(pools: readonly BalancePool[], rent: SolanaRent, venue?: CoinVenue, tipOf: (k: number) => bigint = pageBuyTip): readonly BalancePool[] {
  return Object.freeze(pools.map((p) => (p.chain === "solana" ? solanaBalancePool(p.id, p.scope, solanaTapSpendOf(rent, venue, tipOf)) : p)));
}

/** What a coin's tap spend reads of its venue (the kit's solanaPoolBuyMaxSpend): pump's curve or PumpSwap, its token
 *  account's size (Token or Token-2022 with its extensions) and whether it is a cashback coin; and the mint's decimals,
 *  which pool.buy.dry's out is written in. */
export type CoinVenue = Pick<SolanaPoolBuyVenue, "kind" | "tokenAccountSize" | "cashback" | "decimals">;

/**
 * The coin's venue as the buy reads it (the kit's readSolanaPoolBuyVenue: both providers' accounts the same): pump's
 * curve while it is open, else the coin's canonical PumpSwap pool (a complete curve, or no curve, is no buy venue), else,
 * with `finders` (the page's finders, given only for the venues the page pins a table for: card
 * solana-buy-reaches-raydium-and-meteora), the first of the coin's Meteora DLMM pairs, Raydium CPMM pools or Raydium
 * AMM v4 pools, in that order, the kit's readSolanaVenueAt reads (no cashback; the coin's token account and decimals are
 * its mint's, the same on every pool). A pump venue first: its spend is never above a DLMM or Raydium buy's (no volume
 * account; the sell need of each is W's wrapped-SOL account alone), so a Max priced on it funds a buy the reference
 * sends to any of them. A coin with none, or a read the two providers do not agree on, throws. A curve coin read before
 * it graduates prices no higher than its PumpSwap pool does (the curve's buy keeps PumpSwap's sell need with both
 * cashback accounts the sell makes), so a venue kept from an earlier read (at most COIN_VENUE_KEEP_MS) never prices a
 * Max the buy cannot pay on a graduation.
 */
export async function readCoinVenue(rpcs: readonly [SolanaRpc, SolanaRpc], token: string, finders: PoolFinders | null = null): Promise<CoinVenue> {
  const of = (v: SolanaPoolBuyVenue): CoinVenue => ({ kind: v.kind, tokenAccountSize: v.tokenAccountSize, cashback: v.cashback, ...(v.decimals === undefined ? {} : { decimals: v.decimals }) });
  try {
    return of(await readSolanaPoolBuyVenue(rpcs, "pump-curve", token));
  } catch {
    try {
      return of(await readSolanaPoolBuyVenue(rpcs, "pumpswap", token));
    } catch (swap) {
      if (finders === null || swap instanceof SolanaRpcTransportError) throw swap;
      let last: unknown = swap;
      for (const k of Object.keys(POOL_FINDER_VENUES) as PoolFinderKind[]) {
        const find = finders[k];
        if (!find) continue;
        for (const pool of await find(token)) {
          try {
            return of(await readSolanaVenueAt(rpcs, POOL_FINDER_VENUES[k], token, pool, "buy"));
          } catch (e) {
            last = e;
          }
        }
      }
      throw last;
    }
  }
}

/** Each kind's early finder (page-rpc.ts PoolsOf.early) in its place, a kind with none as it is. */
const earlyFinders = (f: PoolFinders | null): PoolFinders | null =>
  f === null ? null : Object.freeze(Object.fromEntries(Object.entries(f).map(([k, find]) => [k, find?.early ?? find])) as PoolFinders);

/** How many coins' venues pool.buy.dry keeps, and for how long: an ask of a venue COIN_VENUE_KEEP_MS old reads it
 *  again, so a flag the coin's accounts change (its cashback) reaches the next ask after a minute, never only a reload. */
export const COIN_VENUES_KEPT = 256;
export const COIN_VENUE_KEEP_MS = 60_000;

export type PoolBuyDryDeps = {
  /** The page's pool table (PAGE_POOLS). */
  pools: readonly BalancePool[];
  /** The page's paced Solana pair as background reads (pool-testnet.ts pageSolanaRpcs("pass")); null with none. */
  rpcs(): readonly [SolanaRpc, SolanaRpc] | null;
  /** The Rent sysvar state.pools' tap_max already read (rentOnce); null: read here on both. */
  rent(): SolanaRent | null;
  /** The notes and the ready proofs in one turn of the queue (pool-testnet.ts readyWith), as state.pools reads them;
   *  null when signed out. */
  ready(): Promise<{ notes: readonly NoteRecord[]; ready?: readonly (BalanceProof & Partial<Pick<ReadyProof, "own" | "root">>)[]; open?: ReadonlySet<string>; landed?: ReadonlyMap<string, LandedRelease> } | null>;
  /** True while a trade runs on the page or holds a host of the pair: the preview waits for no trade. */
  trading(): boolean;
  /** Tests only: one tip for every set; else the tip a pool.buy on this page pays for a set of k pieces (src/pool-buy.ts,
   *  the kit's solanaPoolBuyTip: SOLANA_POOL_JITO_TIP on mainnet for any count of pieces, none on devnet). */
  tip?: bigint;
  /** The page's clock, ms (performance.now): a kept venue's age. */
  now?(): number;
  /** The page's finders (src/page-rpc.ts keptPoolFinders) of the venues the page pins a table for (pinnedPoolFinders);
   *  none: a coin with no pump venue has no venue at the tap (quote_check_failed, no Cash moved). */
  finders?: PoolFinders | null;
  /** What moving `short` lamports from Cash into the pool costs for good, in lamports, rounded up (main.ts: the move's
   *  fee and margin at the device's price, src/cash-to-pool.ts moveCostOf), the move a tap above tap_max starts
   *  (cashFirst, sized by solanaMoveShort); null when Cash cannot move it. None: an amount above tap_max answers tap_max
   *  alone. */
  moved?(short: bigint): Promise<bigint | null>;
  /** A preview (card solana-quote-reads-found-pools-once): the coin's venue and quote read on each kind's pools as soon
   *  as one provider's scan names them (page-rpc.ts PoolsOf.early), never waiting for the slower provider's half; the
   *  tap's own read (main.ts tapDry, src/pool-buy.ts) waits for both. */
  early?: boolean;
  /** The pin's lookup tables per venue (PAGE_TABLES, the tap's own): the venues a buy may take (pinnedBuyVenues), so
   *  an ask with an amount answers the tap's own venue decision (page-rpc.ts solanaBuyVenue). None: the network's pins
   *  (the wallet's SOL_POOL_TABLES, which PAGE_TABLES is). */
  tables?: Readonly<Partial<Record<string, readonly string[]>>>;
};

/**
 * pool.buy.dry (card max-is-priced-for-the-coin): state.pools' Solana tap_max priced on the coin's own venue, the same
 * sum (poolBalances, the same proofs, notes and rent) with solanaTapSpendOf on the venue readCoinVenue reads in place of
 * the costliest one. The buy pays that spend: its pick (src/pool-buy.ts pickPieces) takes the pieces of one W, its own
 * note's among them, that the kit's solanaPoolBuyFunds passes on the venue it reads, at a tip no higher than the
 * proofs' cap. Display only: nothing is
 * signed, written or sent. Solana only; a token whose venue is not read answers quote_check_failed (down for a provider
 * that failed), and the app keeps state.pools' tap_max.
 * With the ask's `amount` (kit 1.12, card buy-spends-several-pieces), at most that tap_max: `pieces`, the count of the
 * set src/pool-buy.ts's pick (pickPieces) spends for it from the same ready proofs (each still HELD by its attempt, as
 * poolBalances counts them) on the same venue and rent, and `cost`, that set's relay fees and the page's tip: what the
 * buy costs for good (W's accounts' rent comes back with the sale). With them, `out` (kit 1.14, card
 * solana-buy-preview-complete): what that buy gets, in whole units of the token, from the same quote src/pool-buy.ts
 * takes (pageReference on the pair, both providers' reads the same; the venue that gives the most of pump's curve and
 * PumpSwap), at the expected out before slippage; read beside the venue and the proofs, so it adds no wait after them,
 * and left out when that read fails (the Fee still shows). An amount that is not a SOL decimal: not_allowed.
 * Above tap_max (card you-receive-on-every-chain), a buy cashFirst runs after moving a shortfall from Cash: with
 * `moved`, `out` from the same quote and `cost` the same sum over the ready pieces and the notes the move brings
 * (solanaMoveShort: the least move whose notes, each its own W, pay the rest), plus what `moved` says the move costs;
 * no `cost` when the move is not priced, so the Fee never reads under, and `out` still. With no queue open (card
 * buy-quote-before-any-note: no pool note yet), tap_max "0" over no proof: the whole ask is that moved buy.
 */
/** A SOL decimal (at most 9 fraction digits, 30 digits whole) in lamports; undefined when it is not one. */
const lamportsOf = (x: unknown): bigint | undefined => {
  const m = typeof x === "string" ? /^(0|[1-9][0-9]{0,29})(?:\.([0-9]{1,9}))?$/.exec(x) : null;
  return m ? BigInt(m[1]!) * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0")) : undefined;
};
/** Lamports as whole SOL, a decimal with no trailing zeros. */
const solOf = (l: bigint): string => {
  const f = (l % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return f === "" ? (l / 1_000_000_000n).toString() : `${l / 1_000_000_000n}.${f}`;
};
/** Not a HostAnswer, whose `then` would make an async function's answer a thenable. */
type BuyDryAnswer = { result: PoolBuyDry } | { error: ErrorCode };

/** What a pick weighs: a ready proof, or a note a move brings (solanaMovedPieces). */
type DryPiece = LegPiece & { readonly root?: string };

/**
 * What a Solana pool.buy of `amount` lamports costs for good over `list` (the ready proofs a tap may release, each still
 * HELD by its attempt), on `venue` at `rent` and the page's tip: as the buy picks it, one W's set (src/pool-buy.ts
 * pickPieces, `pieces` its count) or, past every single W's set, its legs (solanaLegsPlan, card
 * buy-any-amount-on-every-chain), each leg's pick at its own amount; `cost` every picked piece's relay fee and each
 * set's tip. Null when no plan pays it.
 */
export function solanaBuyCost(list: readonly DryPiece[], valueOf: (noteId: string) => bigint | undefined, venue: CoinVenue, rent: SolanaRent, tipOf: (k: number) => bigint, amount: bigint): { cost: bigint; pieces?: number } | null {
  // with the changes a tap carries (card buy-spends-its-change-in-the-same-tap), as the buy's own pick weighs them
  const weighed = carriesOf(list, valueOf);
  const paysAt = (spend: bigint) => (set: readonly (typeof weighed)[number][]): boolean =>
    carryOk(set) &&
    solanaPoolBuyFunds(set.map((p) => ({ withdrawnValue: p.chunk, relayFee: p.binding.feeCap })), venue, { spend, tip: tipOf(set.length) }, rent).problem === null;
  const set = pickPieces(weighed, paysAt(amount));
  if (set !== null) return { cost: set.reduce((a, p) => a + p.binding.feeCap, tipOf(set.length)), pieces: set.length };
  const legs = solanaLegsPlan(list, valueOf, solanaTapSpendOf(rent, venue, tipOf), amount);
  const picks = legs?.map((l) => {
    // the leg's own W and notes, a carried change by its parent's id
    const ids = new Set(l.ids);
    return pickPieces(weighed.filter((p) => p.wallet.address === l.address && ids.has(p.noteId.replace(/#change$/, ""))), paysAt(l.amount));
  });
  if (picks === undefined || picks.some((x) => x === null)) return null;
  // no `pieces`: the kit's count is one leg's (at most SOLANA_POOL_BUY_PIECES_MAX); the cost is every leg's
  return { cost: (picks as (typeof weighed)[number][][]).reduce((a, s) => a + s.reduce((b, p) => b + p.binding.feeCap, tipOf(s.length)), 0n) };
}

/** The notes a move of Cash for `short` lamports brings into the pool (src/cash-to-pool.ts: cashUsdcFor sizes it at
 *  the shortfall and the ladder's least rung, the follow deposits it in SOL_LADDER's rungs), each a note of its own with
 *  its own W, proved at the pool's relay fee and the buy's tip cap (../../wallet/src/pool/solana.ts bind). */
export function solanaMovedPieces(short: bigint, rent: SolanaRent): DryPiece[] {
  const feeCap = solanaPoolFee(rent);
  return ladderSplit(SOL_LADDER, short + SOL_LADDER.min).notes.map((chunk, i) => ({ noteId: `move#${i}`, own: true as const, chunk, wallet: { address: `move#${i}` }, binding: { feeCap, request: { tipCap: SOL_TIP_CAP } } }));
}

/** The least shortfall a move from Cash must bring so one tap pays `amount` (card you-receive-on-every-chain): at least
 *  `amount - tap`, more by each new W's own costs (its relay fee, the tip, its accounts' rent), as solanaBuyCost over
 *  `live` and solanaMovedPieces says; with that buy's cost. Null when no move up to 2^64 lamports pays it. */
export function solanaMoveShort(live: readonly DryPiece[], valueOf: (noteId: string) => bigint | undefined, venue: CoinVenue, rent: SolanaRent, tipOf: (k: number) => bigint, amount: bigint, tap: bigint): { short: bigint; cost: bigint } | null {
  const base = amount > tap ? amount - tap : 1n;
  const at = (short: bigint) => solanaBuyCost([...live, ...solanaMovedPieces(short, rent)], valueOf, venue, rent, tipOf, amount);
  if (at(base) !== null) return { short: base, cost: at(base)!.cost };
  // the least extra over `base` that pays, by doubling then halving (a valid shortfall either way: `at` is read on it)
  let hi = 1n;
  while (at(base + hi) === null) {
    if (hi >= 1n << 64n) return null;
    hi *= 2n;
  }
  let lo = 0n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (at(base + mid) !== null) hi = mid;
    else lo = mid;
  }
  return { short: base + hi, cost: at(base + hi)!.cost };
}

/** pool.buy.dry's kind, and `short`: the shortfall cashFirst moves from Cash for a tap of `amount` lamports of `token`
 *  (solanaMoveShort on the same reads), null when one tap pays it now or no move does, or the reads fail. */
export type PoolBuyDryKind = ((params: Record<string, unknown>) => Running<"pool.buy.dry">) & { short(token: string, amount: bigint): Promise<bigint | null> };
export function poolBuyDryKind(d: PoolBuyDryDeps): PoolBuyDryKind {
  const now = d.now ?? (() => performance.now());
  const tipOf = (k: number): bigint => d.tip ?? pageBuyTip(k);
  const venues = new Map<string, { v: CoinVenue; at: number }>();
  const venueOf = async (rpcs: readonly [SolanaRpc, SolanaRpc], token: string): Promise<CoinVenue> => {
    const kept = venues.get(token);
    if (kept !== undefined && now() - kept.at < COIN_VENUE_KEEP_MS) return kept.v;
    const v = await readCoinVenue(rpcs, token, d.early ? earlyFinders(d.finders ?? null) : (d.finders ?? null));
    venues.delete(token);
    if (venues.size >= COIN_VENUES_KEPT) venues.clear();
    venues.set(token, { v, at: now() });
    return v;
  };
  // the reads a dry and a tap's shortfall both price on: the notes and ready proofs, the coin's venue and the rent
  type Read = { error: ErrorCode } | { tap: string; tapL: bigint; venue: CoinVenue; rent: SolanaRent; live: DryPiece[]; valueOf: (id: string) => bigint | undefined };
  const read = async (pair: readonly [SolanaRpc, SolanaRpc], token: string, sol: readonly BalancePool[]): Promise<Read> => {
    const got = await d.ready();
    if (got === null) return { error: "not_funded" };
    let venue: CoinVenue;
    let rent: SolanaRent;
    try {
      [venue, rent] = await Promise.all([venueOf(pair, token), d.rent() ?? readSolanaRent(pair)]);
    } catch (e) {
      return { error: e instanceof SolanaRpcTransportError ? "down" : "quote_check_failed" };
    }
    // no queue open (card buy-quote-before-any-note: a fresh account, or one whose money is all Cash, has no pool note,
    // and a queue opens only at a pool note's landing): poolBalances gives no tap_max, and one tap spends nothing of the
    // pool now, so "0" over no proof, and the buy is priced as cashFirst runs it, every lamport moved from Cash
    const counted = poolBalances(got.notes, withSolanaRent(sol, rent, venue, tipOf), got.ready, got.open, got.landed)[0]?.tap_max;
    const tap = counted ?? "0";
    const ids = new Set(sol.map((p) => p.id));
    const byId = new Map(got.notes.map((n) => [n.id, n]));
    const live: DryPiece[] = counted === undefined ? [] : (got.ready ?? []).filter((r) => {
      const n = byId.get(r.noteId);
      return ids.has(r.poolId) && n !== undefined && heldBy(n, r.attempt);
    });
    return { tap, tapL: lamportsOf(tap)!, venue, rent, live, valueOf: (id) => byId.get(id)?.leaf?.value };
  };
  const run = async (params: Record<string, unknown>): Promise<BuyDryAnswer> => {
    const sol = d.pools.filter((p) => p.chain === "solana");
    if (params.chain !== "solana" || sol.length === 0 || typeof params.token !== "string") return { error: "not_allowed" };
    const amount = params.amount === undefined ? null : lamportsOf(params.amount);
    if (amount === undefined) return { error: "not_allowed" };
    // the ask's slippage, the tap's own: with none, judged at 0 bps, so the dry never says a buy fills that a
    // tap at any slippage refuses
    const slip = params.slippage_bps === undefined ? 0 : params.slippage_bps;
    if (typeof slip !== "number" || !Number.isInteger(slip) || slip < 0 || slip > 10_000) return { error: "not_allowed" };
    const pair = d.rpcs();
    if (pair === null) return { error: "not_allowed" };
    if (d.trading()) return { error: "busy" };
    // the quote for `out`, beside the proofs and the venue (never awaited before them); a failed read is no out
    const token = params.token;
    // a read that failed is no answer of the venue (no out, as before); a reference read is the tap's venue decision
    const quote = amount !== null && amount > 0n ? pageReference(pair, { side: "buy", token, amount }, undefined, { early: d.early === true }).then((ref) => ({ ref }), () => null) : null;
    const r = await read(pair, token, sol);
    if ("error" in r && r.error === "not_funded") return r;
    // the tap's own venue decision (card sol-buy-takes-the-best-venue-it-can-trade: page-rpc.ts solanaBuyVenue, on the
    // same reference and the same pins), before the coin's venue read's own refusal, as the tap decides it before its
    // venue's read: a coin whose only pools are on a venue the page pins no table for is venue_not_pinned here as there
    const q = quote === null ? null : await quote;
    const pick = q === null ? null : solanaBuyVenue(q.ref, pinnedBuyVenues(d.tables ?? SOL_POOL_TABLES[POOL_TESTNET ? "devnet" : "mainnet"] ?? {}), slip);
    if (pick !== null && "error" in pick) return pick;
    if ("error" in r) return r;
    const { tap, tapL, venue, rent, live, valueOf } = r;
    if (amount === null || amount === 0n) return { result: { tap_max: tap } };
    const outOf = async (): Promise<string | undefined> => {
      const best = pick?.pool;
      return best !== undefined && venue.decimals !== undefined && best.expectedOut > 0n ? unitsOf(best.expectedOut, venue.decimals) : undefined;
    };
    if (amount <= tapL) {
      const c = solanaBuyCost(live, valueOf, venue, rent, tipOf, amount);
      if (c === null) return { result: { tap_max: tap } };
      const out = await outOf();
      return { result: { tap_max: tap, ...(c.pieces === undefined ? {} : { pieces: c.pieces }), cost: solOf(c.cost), ...(out === undefined ? {} : { out }) } };
    }
    // above one tap's spend (card you-receive-on-every-chain): the buy cashFirst runs after moving the shortfall from
    // Cash, sized as cashFirst sizes it (solanaMoveShort) and priced by `moved`; no pieces count (it is no one tap's).
    // `out` is that buy's swap of the whole ask (the move's notes pay their own costs), so it is given whether or not
    // Cash holds the move now (card buy-quote-before-any-note: $0 Cash still sees what the amount buys); `cost` only
    // when `moved` prices the move, so the Fee never reads under. A page with no `moved` (no Cash path): tap_max alone
    if (!d.moved) return { result: { tap_max: tap } };
    const m = solanaMoveShort(live, valueOf, venue, rent, tipOf, amount, tapL);
    if (m === null) return { result: { tap_max: tap } };
    const moveCost = await d.moved(m.short).catch(() => null);
    const out = await outOf();
    return { result: { tap_max: tap, ...(moveCost === null || moveCost < 0n ? {} : { cost: solOf(m.cost + moveCost) }), ...(out === undefined ? {} : { out }) } };
  };
  const short = async (token: string, amount: bigint): Promise<bigint | null> => {
    const sol = d.pools.filter((p) => p.chain === "solana");
    const pair = d.rpcs();
    if (sol.length === 0 || pair === null || amount <= 0n) return null;
    const r = await read(pair, token, sol);
    if ("error" in r || amount <= r.tapL) return null;
    return solanaMoveShort(r.live, r.valueOf, r.venue, r.rent, tipOf, amount, r.tapL)?.short ?? null;
  };
  const kind = (params: Record<string, unknown>): Running<"pool.buy.dry"> => {
    let out: BuyDryAnswer = { error: "down" };
    const after = run(params).then(
      (a) => void (out = a),
      () => void (out = { error: "down" }),
    );
    // a read that runs (Running), as pool.sell.dry: the page's message queue never waits for a coin's venue read
    return { after, answer: () => out, running: true };
  };
  return Object.assign(kind, { short });
}

/**
 * The Rent sysvar for the pool table's Solana tap spend, read once per page on two RPCs (`read`, the kit's
 * readSolanaRent on the pool kinds' pair): get() answers null until a read lands, and starts one when none runs; a
 * failed read is tried again at the next get(). `landed` runs once, when the first read lands, so the state is read again.
 */
export function rentOnce(read: () => Promise<SolanaRent>, landed: () => void): { get(): SolanaRent | null } {
  let rent: SolanaRent | null = null;
  let reading = false;
  return {
    get() {
      if (rent === null && !reading) {
        reading = true;
        Promise.resolve()
          .then(read)
          .then(
            (r) => {
              rent = r;
              landed();
            },
            () => {},
          )
          .finally(() => (reading = false));
      }
      return rent;
    },
  };
}

const utf8 = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/**
 * `state` with `pools` from the notes `readNotes` gives, when signed in. `ready`: the proof queue's ready proofs;
 * undefined while no queue runs, and then no entry has `ready`. `price`: the page's own USD price read per chain
 * (src/pool-price.ts, card signpage-pool-price); an entry gets `price` only when it gives one. `open`: the pool ids
 * whose queue runs (src/pool-testnet.ts readyWith); a chain with none of them has no `ready` (poolBalances). `landed`:
 * the RESERVED notes whose release this page read landed (src/pool-testnet.ts readyWith), each counted as its change.
 * `making`: the notes whose first proof the queue makes now (src/pool-testnet.ts readyWith), each entry's making.
 * `kept`: the proofs kept on the device (../../wallet/src/pool/kept-proofs.ts, every pool's), each entry's spendable
 * (card taps-wait-inside-the-page: from the first answer after a load, before any queue opens).
 */
export async function withPools(
  state: SignpageState,
  readNotes: () => Promise<readonly NoteRecord[]>,
  pools: readonly BalancePool[],
  ready?: readonly BalanceProof[],
  price?: (chain: Chain) => PoolStatePrice | null,
  open?: ReadonlySet<string>,
  landed?: ReadonlyMap<string, LandedRelease>,
  making?: ReadonlySet<string>,
  kept?: readonly BalanceProof[],
): Promise<SignpageState> {
  if (!state.signed_in) return state;
  try {
    const notes = pools.length === 0 ? [] : await readNotes();
    const sums = poolBalances(notes, pools, ready, open, landed, making, kept).map((e) => {
      const p = price?.(e.chain) ?? null;
      return p === null ? e : { ...e, price: p };
    });
    let out: SignpageState = { ...state, pools: sums };
    if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) out = { ...out, ops: pickOps({ ...out, ops: [] }, state.ops.map((op, t) => ({ op, t }))) };
    // the ops gave all they hold and the rest of the state still leaves pools no room: the state as it was, which fits
    if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) return state;
    return SIGNPAGE_RESULT_SCHEMAS.state(out) ? out : state;
  } catch {
    return state;
  }
}

/**
 * `state` with `deposit_wallets` (card deposit-takes-each-pools-own-coin: src/pool-deposit-follow.ts depositWalletsOf,
 * each U_X a follow left money at), when signed in and any is listed. The ops it is made from are read after the notes
 * the pools were summed from (main.ts), so money is never in both. As the pools: the oldest ops give way for the room,
 * and a state that still does not fit, or that the schema refuses, goes as it was.
 */
export function withDepositWallets(state: SignpageState, wallets: NonNullable<SignpageState["deposit_wallets"]>): SignpageState {
  if (!state.signed_in || wallets.length === 0) return state;
  let out: SignpageState = { ...state, deposit_wallets: wallets };
  if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) out = { ...out, ops: pickOps({ ...out, ops: [] }, state.ops.map((op, t) => ({ op, t }))) };
  if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) return state;
  return SIGNPAGE_RESULT_SCHEMAS.state(out) ? out : state;
}
