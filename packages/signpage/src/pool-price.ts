// The pool asset's USD price per chain, read by SIGN_HOST's top-level page itself (card signpage-pool-price), for the
// state's pools (the kit's SignpageState.pools[].price). The trade box shows a pool tap in USD and spends the pool's
// asset; APP_HOST's connect-src reaches no Solana, Base or Robinhood RPC (apps/terminal/public/_headers), so the price
// is read here and the app takes it from the state, never from a server.
//
// - The read is the kit's poolUsdPrice (../../kit/src/price/pool-usd.ts): two RPCs of two providers that agree, fresh,
//   positive and sure. The RPCs are the chain's pair the page's pool kinds read on (main.ts: mainnet Solana's provider A
//   and the helper's keyed route; the testnet build's two testnet RPCs), so no host is added to the page's CSP. A chain
//   with no pair, or one the kit refuses (Base Sepolia and Robinhood testnet: their chain ids are not the feeds'), has
//   no price. Robinhood's read holds its ETH/USD to Base's, on Base's pair.
// - Fresh: a chain in the state is read again once its last try is POOL_PRICE_REFRESH_MS old, one read per chain at a
//   time. A read that fails keeps the last good one, which is dropped once past the kit's poolUsdGoodUntilS (the feed's
//   maxAgeS from the earlier of its own time and the read's), so a price past it never reaches the state.
// - The app hears each new price: a read that ends calls the watchers (the API posts a state event when the state read
//   then differs), and POOL_PRICE_REFRESH_MS after it calls them again, so a state read starts the next read while a
//   pool shows. Signed out, or with no pool, no state names a chain and no read is made.
// - The price only labels USD: pool.buy carries only its amount, in the pool asset's units, and the page spends it only
//   from a ready proof that funds it (src/pool-buy.ts), so an amount an app priced with a planted price is refused when
//   it is over one proof's funds; the page does not hold it to the USD the app showed.
import { POOL_USD_FEEDS, POOL_USD_MAX_AHEAD_S, poolUsdGoodUntilS, poolUsdPrice, type PoolUsdArgs, type PoolUsdChain, type PoolUsdPrice } from "../../kit/src/price/pool-usd.ts";
import type { Chain } from "../../kit/src/orders/record.ts";
import type { PoolStatePrice } from "../../kit/src/signpage/messages.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";

/** A chain's price is read again once its last try is this old: Pyth's SOL/USD (maxAgeS 60) is read at least three
 *  times inside its bound. Its sponsored feed published every 3 to 16 s in four reads on 4 Nov 14:44Z. */
export const POOL_PRICE_REFRESH_MS = 15_000;

export type PoolPriceDeps = {
  /** The chain's two RPCs of two providers, as the pool kinds read on; null: none, so no price. */
  rpcs(chain: PoolUsdChain): readonly [SolanaRpc, SolanaRpc] | null;
  /** Unix ms (Date.now otherwise). */
  now?(): number;
  /** Tests only: the read (the kit's poolUsdPrice otherwise). */
  read?(args: PoolUsdArgs): Promise<PoolUsdPrice>;
  /** Tests only: the timer the next tick waits on (setTimeout otherwise). */
  after?(ms: number, fn: () => void): void;
};

export type PoolPrices = {
  /** The chain's last good read while within its feed's bound on the device's clock; null otherwise. */
  get(chain: Chain): PoolStatePrice | null;
  /** Starts a read for each chain due one (see the header); never throws, never waits. */
  refresh(chains: readonly Chain[]): void;
  watch(fn: () => void): void;
};

const priced = (c: Chain): c is PoolUsdChain => Object.hasOwn(POOL_USD_FEEDS, c);

export function poolPrices(deps: PoolPriceDeps): PoolPrices {
  const now = deps.now ?? Date.now;
  const read = deps.read ?? poolUsdPrice;
  const after = deps.after ?? ((ms: number, fn: () => void) => void setTimeout(fn, ms));
  const held = new Map<PoolUsdChain, PoolStatePrice>();
  const tried = new Map<PoolUsdChain, number>();
  const reading = new Set<PoolUsdChain>();
  const watchers = new Set<() => void>();
  const tell = (): void => {
    for (const f of watchers) f();
  };
  const fresh = (chain: PoolUsdChain): PoolStatePrice | null => {
    const p = held.get(chain);
    if (!p) return null;
    const nowS = now() / 1000;
    return nowS > poolUsdGoodUntilS(chain, p.published_s, p.read_ms / 1000) || p.published_s - nowS > POOL_USD_MAX_AHEAD_S ? null : p;
  };
  const start = (chain: PoolUsdChain): void => {
    const rpcs = deps.rpcs(chain);
    if (rpcs === null) return;
    const base = chain === "robinhood" ? deps.rpcs("base") : null;
    if (chain === "robinhood" && base === null) return;
    reading.add(chain);
    void Promise.resolve()
      .then(() => read({ chain, rpcs, nowMs: now(), ...(base ? { baseRpcs: base } : {}) }))
      .then((p) => {
        if (p.chain !== chain || p.price <= 0n) return;
        held.set(chain, { price: p.price.toString(), expo: p.expo, published_s: p.publishedS, read_ms: now() });
      })
      // refused (stale, disagreeing, unsure, unreachable): the last good read stands until its bound drops it
      .catch(() => {})
      .finally(() => {
        reading.delete(chain);
        tell();
        after(POOL_PRICE_REFRESH_MS, tell);
      });
  };
  return {
    get: (chain) => (priced(chain) ? fresh(chain) : null),
    refresh(chains) {
      for (const chain of new Set(chains)) {
        if (!priced(chain) || reading.has(chain)) continue;
        const last = tried.get(chain);
        if (last !== undefined && now() - last < POOL_PRICE_REFRESH_MS) continue;
        tried.set(chain, now());
        start(chain);
      }
    },
    watch(fn) {
      watchers.add(fn);
    },
  };
}
