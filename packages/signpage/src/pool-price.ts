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
// - A failed read (card signpage-price-read-retry) is due again POOL_PRICE_RETRY_MS after it ends, doubled per failure
//   in a row up to POOL_PRICE_REFRESH_MS, not POOL_PRICE_REFRESH_MS after its try: one slow provider leaves Bal without
//   USD and Buy off for about a second, not 15 s (sign live runs 41920575578 and 41924297260, 4 Nov 22:00Z and 22:25Z).
//   A good read ends the run of failures. A read whose price is past its bound as it ends is a failure. A provider that
//   answered 429 with Retry-After is not asked again sooner than it said, up to POOL_PRICE_RETRY_AFTER_MAX_MS.
// - The app hears each new price: a read that ends calls the watchers (the API posts a state event when the state read
//   then differs), and once its next read is due (POOL_PRICE_REFRESH_MS after it, or the failure's wait) calls them
//   again, so a state read starts the next read while a pool shows. Signed out, or with no pool, no state names a chain
//   and no read is made.
// - The price only labels USD: pool.buy carries only its amount, in the pool asset's units, and the page spends it only
//   from a ready proof that funds it (src/pool-buy.ts), so an amount an app priced with a planted price is refused when
//   it is over one proof's funds; the page does not hold it to the USD the app showed.
import { POOL_USD_FEEDS, POOL_USD_MAX_AHEAD_S, poolUsdGoodUntilS, poolUsdPrice, type PoolUsdArgs, type PoolUsdChain, type PoolUsdPrice } from "../../kit/src/price/pool-usd.ts";
import type { Chain } from "../../kit/src/orders/record.ts";
import type { PoolStatePrice } from "../../kit/src/signpage/messages.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";

/** A chain's price is read again once its last try is this old: Pyth's SOL/USD (maxAgeS 60) is read at least three
 *  times inside its bound. Its sponsored feed published every 3 to 16 s in four reads on 4 Nov 14:44Z. */
export const POOL_PRICE_REFRESH_MS = 15_000;
/** A failed read is due again this long after it ends, doubled per failure in a row up to POOL_PRICE_REFRESH_MS: soon
 *  enough that Buy is back within a second or two of one slow answer, and a provider still failing is asked less often. */
export const POOL_PRICE_RETRY_MS = 1_000;
/** A provider's Retry-After is waited up to this: one provider's header never leaves a chain unpriced for longer. */
export const POOL_PRICE_RETRY_AFTER_MAX_MS = 60_000;

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
  /** When the chain's next read is due, unix ms on `now`. */
  const due = new Map<PoolUsdChain, number>();
  /** The chain's failed reads in a row. */
  const failed = new Map<PoolUsdChain, number>();
  const reading = new Set<PoolUsdChain>();
  const watchers = new Set<() => void>();
  const tell = (): void => {
    for (const f of watchers) f();
  };
  const usable = (chain: PoolUsdChain, p: PoolStatePrice): boolean => {
    const nowS = now() / 1000;
    return !(nowS > poolUsdGoodUntilS(chain, p.published_s, p.read_ms / 1000) || p.published_s - nowS > POOL_USD_MAX_AHEAD_S);
  };
  const fresh = (chain: PoolUsdChain): PoolStatePrice | null => {
    const p = held.get(chain);
    return p && usable(chain, p) ? p : null;
  };
  const start = (chain: PoolUsdChain): void => {
    const rpcs = deps.rpcs(chain);
    if (rpcs === null) return;
    const base = chain === "robinhood" ? deps.rpcs("base") : null;
    if (chain === "robinhood" && base === null) return;
    reading.add(chain);
    /** The provider's Retry-After of a refused read, ms. */
    let afterMs = 0;
    void Promise.resolve()
      .then(() => read({ chain, rpcs, nowMs: now(), ...(base ? { baseRpcs: base } : {}) }))
      .then((p) => {
        if (p.chain !== chain || p.price <= 0n) return false;
        const got = { price: p.price.toString(), expo: p.expo, published_s: p.publishedS, read_ms: now() };
        // a price past its bound as the read ends is a failed read: the last good one stands, and the next read is soon
        if (!usable(chain, got)) return false;
        held.set(chain, got);
        return true;
      })
      // refused (stale, disagreeing, unsure, unreachable): the last good read stands until its bound drops it
      .catch((e: unknown) => {
        if (e instanceof SolanaRpcTransportError && e.afterMs !== null) afterMs = Math.min(e.afterMs, POOL_PRICE_RETRY_AFTER_MAX_MS);
        return false;
      })
      .then((ok) => {
        reading.delete(chain);
        let waitMs = POOL_PRICE_REFRESH_MS;
        if (ok) failed.delete(chain);
        else {
          const n = (failed.get(chain) ?? 0) + 1;
          failed.set(chain, n);
          waitMs = Math.min(POOL_PRICE_RETRY_MS * 2 ** (n - 1), POOL_PRICE_REFRESH_MS);
          // a provider that said when to ask again is not asked sooner
          waitMs = Math.max(waitMs, afterMs);
          due.set(chain, now() + waitMs);
        }
        tell();
        after(waitMs, tell);
      });
  };
  return {
    get: (chain) => (priced(chain) ? fresh(chain) : null),
    refresh(chains) {
      for (const chain of new Set(chains)) {
        if (!priced(chain) || reading.has(chain)) continue;
        const at = due.get(chain);
        if (at !== undefined && now() < at) continue;
        due.set(chain, now() + POOL_PRICE_REFRESH_MS);
        start(chain);
      }
    },
    watch(fn) {
      watchers.add(fn);
    },
  };
}
