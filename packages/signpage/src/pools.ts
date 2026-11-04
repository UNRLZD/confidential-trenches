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
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { poolBalances, type BalancePool, type BalanceProof } from "../../wallet/src/pool/balances.ts";
import { ANSWER_ROOM, pickOps } from "./state.ts";

/**
 * The page's pool table on its network (mainnet, main.ts PAGE_NETWORK). Empty: no pool is pinned on mainnet. The pin
 * tables, SOL_POOLS in ../../wallet/src/pool/solana.ts and EVM_POOLS in ../../wallet/src/pool/evm.ts, are both empty.
 * A pool goes here only from its pin, never typed in, and only through solanaBalancePool or evmBalancePool
 * (../../wallet/src/pool/balances.ts), so its asset follows its kind; test/pools.test.ts fails once a mainnet Solana
 * pin or a Base or Robinhood EVM pin lands while this is empty.
 */
export const PAGE_POOLS: readonly BalancePool[] = Object.freeze([]);

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
    const out: SignpageState = { ...state, pools: sums };
    if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) out.ops = pickOps({ ...out, ops: [] }, state.ops.map((op, t) => ({ op, t })));
    // the ops gave all they hold and the rest of the state still leaves pools no room: the state as it was, which fits
    if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) return state;
    return SIGNPAGE_RESULT_SCHEMAS.state(out) ? out : state;
  } catch {
    return state;
  }
}
