// The EVM sale pools this device banned (card evm-sell-hook-converge). The kit's sell quote (checks/evm/quote.ts
// evmPoolSellQuote) picks a route through a v4 hook the venue does not list where that route sets the token's reference
// and no route through listed pools is within the slippage of it, and names that route's unlisted-hook pools in the
// quote's `hooked`. A hook can honour the quote and the sim and still revert the real sale. Where the real sale
// reverts, the caller asks the kit's evmSellRevertedPools(quote, txHash) which pools the device's own reads blame (the
// sale's replay at its own gas reverts, the quoter still prices the route at minOut, and the replay with a smallest set
// of the route's hooks made a no-op succeeds, on both providers), bans those here, and passes evmSellBanned's list as
// the next quote's `banned`.
// A revert with no such evidence (a price that moved, providers that disagree) bans nothing.
// The buy shares these bans (card evm-buy-hook-converge): its quote (evmPoolBuyQuote) takes a route through such a hook
// on the same terms and names its pools in `hooked`; where the real buy's swap fails (the pool lands it with its
// Withdrawn, card pool-evm-buy-pays-revert), the caller asks evmBuyRevertedPools(quote,
// txHash) the same question of the buy, bans its answer here under the same (chain, token), and passes evmSellBanned's
// list as the next buy quote's `banned` too: a pool is banned for the token whichever trade proved it at fault.
//
// A ban expires (review of 919742f5, F2: a permanent ban let one bad read cost a token its honest market on this device
// for good): the first lasts EVM_SELL_BAN_FIRST_MS, each repeat after it expired lasts twice the one before, at most
// EVM_SELL_BAN_MAX_MS. So a hostile pool the kit's evidence names costs at most one failed try per ban, and a pool
// banned in error is quoted again within the hour. Where the evidence names an honest pool in a hostile one's place
// (checks/evm/quote.ts step 4's open cases M, Y and C, card evm-hook-honest-fee-skimmer), the hostile pool costs a
// failed try each time the route is taken, and the honest one is banned as above.
//
// One record per (chain, token): meta evm-bans/<chain>/<token> (../store/index.ts WALLET_BAN_PREFIX),
// { v: 2, pools: [{ id, until, n }] }: each pool's PoolId (0x and 64 lower-case hex digits), the ms its ban ends, and
// how many times it was banned, in the order last banned, each once. An expired entry is kept for its count. A ban is a
// read-modify-write in one compare-and-set (WalletStore.update), so two tabs banning at once keep both. At most
// EVM_SELL_BANS_MAX are kept, the least recently banned dropped first: the kit's quote takes no longer list, and an old
// ban dropped costs at most one more failed try, never a frozen sale. A record of any other shape (the permanent v1
// bans included) holds none.
import { WALLET_BAN_PREFIX, type WalletStore } from "../store/index.ts";

/** The most pools kept banned for one token: the kit's EVM_SELL_BANNED_MAX (checks/evm/quote.ts). */
export const EVM_SELL_BANS_MAX = 4096;
/** A pool's first ban: one hour. */
export const EVM_SELL_BAN_FIRST_MS = 60 * 60 * 1000;
/** The longest ban: seven days. */
export const EVM_SELL_BAN_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const CHAIN = /^[a-z0-9-]{1,40}$/;
const TOKEN = /^0x[0-9a-f]{40}$/;
const POOL_ID = /^0x[0-9a-f]{64}$/;

/** One pool's ban: its PoolId, the ms (device clock) it ends, and its count. */
export type EvmSellBan = { readonly id: string; readonly until: number; readonly n: number };

/** The meta key of the bans of `token` on `chain`; refuses a chain or a token not in their shape. */
export function evmSellBanKey(chain: string, token: string): string {
  const t = typeof token === "string" ? token.toLowerCase() : "";
  if (typeof chain !== "string" || !CHAIN.test(chain) || !TOKEN.test(t)) throw new Error("a ban names a chain (a-z, 0-9, -) and a token (0x and 40 hex digits)");
  return `${WALLET_BAN_PREFIX}${chain}/${t}`;
}

/** How long the `n`th ban of a pool lasts: the first EVM_SELL_BAN_FIRST_MS, each after twice the one before, at most
 *  EVM_SELL_BAN_MAX_MS. */
export const evmSellBanMs = (n: number): number => (n >= 9 ? EVM_SELL_BAN_MAX_MS : Math.min(EVM_SELL_BAN_FIRST_MS * 2 ** (n - 1), EVM_SELL_BAN_MAX_MS));

/** The bans a record holds; anything not in the record's shape holds none. */
const bansOf = (rec: unknown): EvmSellBan[] => {
  const pools = (rec as { v?: unknown; pools?: unknown } | undefined)?.pools;
  if ((rec as { v?: unknown } | undefined)?.v !== 2 || !Array.isArray(pools)) return [];
  return pools.filter((b): b is EvmSellBan => {
    const { id, until, n } = (b ?? {}) as Partial<EvmSellBan>;
    return typeof id === "string" && POOL_ID.test(id) && Number.isSafeInteger(until) && Number.isSafeInteger(n) && n! >= 1;
  });
};

const clock = (nowMs: number): number => {
  if (!Number.isFinite(nowMs)) throw new Error("the device's clock is a number of ms");
  return nowMs;
};

/** The pools banned for `token` on `chain` at `nowMs` (the device's clock), least recently banned first: the next sell
 *  quote's `banned`. An expired ban is not among them. */
export async function evmSellBanned(store: Pick<WalletStore, "get">, chain: string, token: string, nowMs: number = Date.now()): Promise<string[]> {
  const now = clock(nowMs);
  return bansOf(await store.get("meta", evmSellBanKey(chain, token))).filter((b) => b.until > now).map((b) => b.id);
}

/** Bans `pools` (evmSellRevertedPools' answer for a reverted sale) for `token` on `chain` at `nowMs`; resolves with
 *  every pool banned for it afterwards. A pool still banned keeps its ban; one whose ban expired is banned again for
 *  twice as long (at most EVM_SELL_BAN_MAX_MS); a new one for EVM_SELL_BAN_FIRST_MS. A PoolId not 0x and 64 hex digits
 *  is refused before any write. */
export async function evmSellBan(store: Pick<WalletStore, "update">, chain: string, token: string, pools: readonly string[], nowMs: number = Date.now()): Promise<string[]> {
  const key = evmSellBanKey(chain, token);
  const now = clock(nowMs);
  if (!Array.isArray(pools)) throw new Error("the pools to ban are a list");
  const add = [...pools].map((p) => (typeof p === "string" ? p.toLowerCase() : ""));
  if (add.some((p) => !POOL_ID.test(p))) throw new Error("a banned pool is its PoolId: 0x and 64 hex digits");
  let after: EvmSellBan[] = [];
  await store.update("meta", key, (rec) => {
    const was = bansOf(rec);
    const next = [...was];
    let changed = false;
    for (const id of add) {
      const i = next.findIndex((b) => b.id === id);
      const old = i >= 0 ? next[i]! : undefined;
      // still banned: as it was
      if (old !== undefined && old.until > now) continue;
      const n = old === undefined ? 1 : old.n + 1;
      if (i >= 0) next.splice(i, 1);
      next.push({ id, until: now + evmSellBanMs(n), n });
      changed = true;
    }
    after = next.slice(-EVM_SELL_BANS_MAX);
    // nothing new: no write
    return changed || after.length !== was.length ? { v: 2, pools: after } : undefined;
  });
  return after.filter((b) => b.until > now).map((b) => b.id);
}
