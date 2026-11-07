// The EVM sale pools this device banned (card evm-sell-hook-converge). The kit's sell quote (checks/evm/quote.ts
// evmPoolSellQuote) picks a route through a v4 hook the venue does not list where that route sets the token's reference
// and no route through listed pools is within the slippage of it, and names that route's unlisted-hook pools in the
// quote's `hooked`. A hook can honour the quote and the sim and still revert the real sale (one that honours only some
// blocks, or flips on per-block state, which no read before the sale can see), so where the real sale reverts the
// caller bans those pools here, and passes evmSellBanned's list as the next quote's `banned`: a banned pool never sets
// the token's reference on this device again, and the sale leaves through the rest. Each pool costs at most one failed
// try; a refusal would have frozen the token's sales.
//
// One record per (chain, token): meta evm-bans/<chain>/<token> (../store/index.ts WALLET_BAN_PREFIX), { v: 1, pools },
// the pools' PoolIds (0x and 64 lower-case hex digits) in the order they were banned, each once. A ban is a
// read-modify-write in one compare-and-set (WalletStore.update), so two tabs banning at once keep both. At most
// EVM_SELL_BANS_MAX are kept, the oldest dropped first: the kit's quote takes no longer list, and an old ban dropped
// costs at most one more failed try, never a frozen sale.
import { WALLET_BAN_PREFIX, type WalletStore } from "../store/index.ts";

/** The most pools kept banned for one token: the kit's EVM_SELL_BANNED_MAX (checks/evm/quote.ts). */
export const EVM_SELL_BANS_MAX = 4096;
const CHAIN = /^[a-z0-9-]{1,40}$/;
const TOKEN = /^0x[0-9a-f]{40}$/;
const POOL_ID = /^0x[0-9a-f]{64}$/;

/** The meta key of the bans of `token` on `chain`; refuses a chain or a token not in their shape. */
export function evmSellBanKey(chain: string, token: string): string {
  const t = typeof token === "string" ? token.toLowerCase() : "";
  if (typeof chain !== "string" || !CHAIN.test(chain) || !TOKEN.test(t)) throw new Error("a ban names a chain (a-z, 0-9, -) and a token (0x and 40 hex digits)");
  return `${WALLET_BAN_PREFIX}${chain}/${t}`;
}

/** The pools a record holds; anything not in the record's shape holds none. */
const poolsOf = (rec: unknown): string[] => {
  const pools = (rec as { v?: unknown; pools?: unknown } | undefined)?.pools;
  if ((rec as { v?: unknown } | undefined)?.v !== 1 || !Array.isArray(pools)) return [];
  return pools.filter((p): p is string => typeof p === "string" && POOL_ID.test(p));
};

/** The pools banned for `token` on `chain`, oldest first: the next sell quote's `banned`. */
export async function evmSellBanned(store: Pick<WalletStore, "get">, chain: string, token: string): Promise<string[]> {
  return poolsOf(await store.get("meta", evmSellBanKey(chain, token)));
}

/** Bans `pools` (a reverted sale's quote's `hooked`) for `token` on `chain`; resolves with every pool banned for it
 *  afterwards. A pool already banned stays where it was; a PoolId not 0x and 64 hex digits is refused before any
 *  write. */
export async function evmSellBan(store: Pick<WalletStore, "update">, chain: string, token: string, pools: readonly string[]): Promise<string[]> {
  const key = evmSellBanKey(chain, token);
  if (!Array.isArray(pools)) throw new Error("the pools to ban are a list");
  const add = [...pools].map((p) => (typeof p === "string" ? p.toLowerCase() : ""));
  if (add.some((p) => !POOL_ID.test(p))) throw new Error("a banned pool is its PoolId: 0x and 64 hex digits");
  let after: string[] = [];
  await store.update("meta", key, (rec) => {
    const was = poolsOf(rec);
    const next = [...was];
    for (const p of add) if (!next.includes(p)) next.push(p);
    after = next.slice(-EVM_SELL_BANS_MAX);
    // nothing new: no write
    return after.length === was.length && after.every((p, i) => p === was[i]) ? undefined : { v: 1, pools: after };
  });
  return after;
}
