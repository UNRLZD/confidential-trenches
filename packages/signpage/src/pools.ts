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
import { readSolanaPoolBuyVenue, readSolanaRent, type SolanaPoolBuyVenue, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { evmBalancePool, evmTapSpendOf, poolBalances, solanaBalancePool, solanaTapSpendOf, type BalancePool, type BalanceProof, type LandedRelease } from "../../wallet/src/pool/balances.ts";
import { EVM_CHAIN_IDS, EVM_POOLS, evmPoolScopeOf, type EvmNetwork } from "../../wallet/src/pool/evm.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";
import { SOL_POOLS, solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import type { Deferred } from "./api.ts";
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

/** `pools` with each Solana entry's tap spend at `rent` (the kit's Rent sysvar, read on two RPCs): its tap_max, on
 *  `venue` (a coin's own, pool.buy.dry) or, with none, on the costliest venue of any coin (state.pools). */
export function withSolanaRent(pools: readonly BalancePool[], rent: SolanaRent, venue?: CoinVenue): readonly BalancePool[] {
  return Object.freeze(pools.map((p) => (p.chain === "solana" ? solanaBalancePool(p.id, p.scope, solanaTapSpendOf(rent, venue)) : p)));
}

/** What a coin's tap spend reads of its venue (the kit's solanaPoolBuyMaxSpend): pump's curve or PumpSwap, its token
 *  account's size (Token or Token-2022 with its extensions) and whether it is a cashback coin. */
export type CoinVenue = Pick<SolanaPoolBuyVenue, "kind" | "tokenAccountSize" | "cashback">;

/**
 * The coin's venue as the buy reads it (the kit's readSolanaPoolBuyVenue: both providers' accounts the same): pump's
 * curve while it is open, else the coin's canonical PumpSwap pool (a complete curve, or no curve, is no buy venue). A
 * coin with neither, or a read the two providers do not agree on, throws. A curve coin read before it graduates prices
 * no higher than its PumpSwap pool does (the curve's buy keeps PumpSwap's sell need with both cashback accounts the sell
 * makes), so a venue kept from an earlier read never prices a Max the buy cannot pay.
 */
export async function readCoinVenue(rpcs: readonly [SolanaRpc, SolanaRpc], token: string): Promise<CoinVenue> {
  const of = (v: SolanaPoolBuyVenue): CoinVenue => ({ kind: v.kind, tokenAccountSize: v.tokenAccountSize, cashback: v.cashback });
  try {
    return of(await readSolanaPoolBuyVenue(rpcs, "pump-curve", token));
  } catch {
    return of(await readSolanaPoolBuyVenue(rpcs, "pumpswap", token));
  }
}

/** How many coins' venues pool.buy.dry keeps for the page's life: a venue never prices higher than when it was read. */
export const COIN_VENUES_KEPT = 256;

export type PoolBuyDryDeps = {
  /** The page's pool table (PAGE_POOLS). */
  pools: readonly BalancePool[];
  /** The page's paced Solana pair as background reads (pool-testnet.ts pageSolanaRpcs("pass")); null with none. */
  rpcs(): readonly [SolanaRpc, SolanaRpc] | null;
  /** The Rent sysvar state.pools' tap_max already read (rentOnce); null: read here on both. */
  rent(): SolanaRent | null;
  /** The notes and the ready proofs in one turn of the queue (pool-testnet.ts readyWith), as state.pools reads them;
   *  null when signed out. */
  ready(): Promise<{ notes: readonly NoteRecord[]; ready?: readonly BalanceProof[]; open?: ReadonlySet<string>; landed?: ReadonlyMap<string, LandedRelease> } | null>;
  /** True while a trade runs on the page or holds a host of the pair: the preview waits for no trade. */
  trading(): boolean;
};

/**
 * pool.buy.dry (card max-is-priced-for-the-coin): state.pools' Solana tap_max priced on the coin's own venue, the same
 * sum (poolBalances, the same proofs, notes and rent) with solanaTapSpendOf on the venue readCoinVenue reads in place of
 * the costliest one. The buy pays that spend: its pick (src/pool-buy.ts) takes the smallest ready proof the kit's
 * solanaPoolBuyFunds passes on the venue it reads, at a tip no higher than the proof's cap. Display only: nothing is
 * signed, written or sent. Solana only; a token whose venue is not read answers quote_check_failed (down for a provider
 * that failed), and the app keeps state.pools' tap_max.
 */
/** Not a HostAnswer, whose `then` would make an async function's answer a thenable. */
type BuyDryAnswer = { result: PoolBuyDry } | { error: ErrorCode };
export function poolBuyDryKind(d: PoolBuyDryDeps): (params: Record<string, unknown>) => Deferred<"pool.buy.dry"> {
  const venues = new Map<string, CoinVenue>();
  const venueOf = async (rpcs: readonly [SolanaRpc, SolanaRpc], token: string): Promise<CoinVenue> => {
    const kept = venues.get(token);
    if (kept !== undefined) return kept;
    const v = await readCoinVenue(rpcs, token);
    if (venues.size >= COIN_VENUES_KEPT) venues.clear();
    venues.set(token, v);
    return v;
  };
  const run = async (params: Record<string, unknown>): Promise<BuyDryAnswer> => {
    const sol = d.pools.filter((p) => p.chain === "solana");
    if (params.chain !== "solana" || sol.length === 0 || typeof params.token !== "string") return { error: "not_allowed" };
    const pair = d.rpcs();
    if (pair === null) return { error: "not_allowed" };
    if (d.trading()) return { error: "busy" };
    const got = await d.ready();
    if (got === null) return { error: "not_funded" };
    let venue: CoinVenue;
    let rent: SolanaRent;
    try {
      [venue, rent] = await Promise.all([venueOf(pair, params.token), d.rent() ?? readSolanaRent(pair)]);
    } catch (e) {
      return { error: e instanceof SolanaRpcTransportError ? "down" : "quote_check_failed" };
    }
    const tap = poolBalances(got.notes, withSolanaRent(sol, rent, venue), got.ready, got.open, got.landed)[0]?.tap_max;
    return tap === undefined ? { error: "not_funded" } : { result: { tap_max: tap } };
  };
  return (params) => {
    let out: BuyDryAnswer = { error: "down" };
    const after = run(params).then(
      (a) => void (out = a),
      () => void (out = { error: "down" }),
    );
    return { after, answer: () => out };
  };
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
 */
export async function withPools(
  state: SignpageState,
  readNotes: () => Promise<readonly NoteRecord[]>,
  pools: readonly BalancePool[],
  ready?: readonly BalanceProof[],
  price?: (chain: Chain) => PoolStatePrice | null,
  open?: ReadonlySet<string>,
  landed?: ReadonlyMap<string, LandedRelease>,
): Promise<SignpageState> {
  if (!state.signed_in) return state;
  try {
    const notes = pools.length === 0 ? [] : await readNotes();
    const sums = poolBalances(notes, pools, ready, open, landed).map((e) => {
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
