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
import type { PoolStatePrice, SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import type { SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { evmBalancePool, evmTapSpendOf, poolBalances, solanaBalancePool, solanaTapSpendOf, type BalancePool, type BalanceProof } from "../../wallet/src/pool/balances.ts";
import { EVM_CHAIN_IDS, EVM_POOLS, evmPoolScopeOf, type EvmNetwork } from "../../wallet/src/pool/evm.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";
import { SOL_POOLS, solanaPoolOf } from "../../wallet/src/pool/solana.ts";
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
 * build (the Solana pool SOL_POOLS.mainnet pins, card sol-pools-mainnet-pin), devnet's in the testnet build. EVM_POOLS
 * pins no EVM pool yet, mainnet or testnet, so neither table has an EVM entry.
 */
export const PAGE_POOLS: readonly BalancePool[] = pagePoolsOf(POOL_TESTNET ? "testnet" : "mainnet");

/** `pools` with each Solana entry's tap spend at `rent` (the kit's Rent sysvar, read on two RPCs): its tap_max. */
export function withSolanaRent(pools: readonly BalancePool[], rent: SolanaRent): readonly BalancePool[] {
  return Object.freeze(pools.map((p) => (p.chain === "solana" ? solanaBalancePool(p.id, p.scope, solanaTapSpendOf(rent)) : p)));
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
 * (src/pool-price.ts, card signpage-pool-price); an entry gets `price` only when it gives one.
 */
export async function withPools(
  state: SignpageState,
  readNotes: () => Promise<readonly NoteRecord[]>,
  pools: readonly BalancePool[],
  ready?: readonly BalanceProof[],
  price?: (chain: Chain) => PoolStatePrice | null,
): Promise<SignpageState> {
  if (!state.signed_in) return state;
  try {
    const notes = pools.length === 0 ? [] : await readNotes();
    const sums = poolBalances(notes, pools, ready).map((e) => {
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
