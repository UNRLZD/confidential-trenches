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
//   A good read ends the run of failures. A provider that answered 429 with Retry-After is not asked again sooner than
//   it said, up to POOL_PRICE_RETRY_AFTER_MAX_MS.
// - At the feed's write (card pool-usd-price-never-stale): Pyth's sponsored SOL/USD account is written when its price is
//   50 to 57 s old and lands 1 to 3 s later (720 reads, 10 Nov 03:56-04:26Z), and its bound is 75 s (the kit's
//   POOL_USD_FEEDS: heartbeat 60 s + 15 s). Read only every 15 s, the held price ran out before the next read saw the
//   write: no USD and Buy off 11% of the time, up to 13 s at once. So from POOL_PRICE_WRITE_LEAD_MS before a held price's
//   end (the kit's poolUsdGoodUntilS: publish + 55 s on Solana), a good read whose price is no newer is read again
//   POOL_PRICE_WRITE_POLL_MS after it ends, until a newer price is in. A feed later than its bound (both providers agreeing
//   on a price refused only for its age, the kit's PoolUsdStale, or one past its bound as the read ends; never one ahead of
//   the clock) is read again POOL_PRICE_WRITE_POLL_MS after it too, for POOL_PRICE_WRITE_LEAD_MS past that end, so the
//   box is back within a few seconds of a late write; after that, a failure as any other. A provider that fails never
//   takes this path: its read backs off as above. Only while the page is shown (`visible`): a hidden page reads every
//   POOL_PRICE_REFRESH_MS as before, and is read at once when shown again (`wake`, wakeWhenShown). Reads start only from a
//   state read, so a page with no app that asks its state reads nothing (src/api.ts). The cost, on the review's
//   simulation of the 10 Nov writes (120 min): 5.0 reads a minute on each provider (3.9 before), at most 3 in any 10 s,
//   no second without a price (8.2% before), a write held 1.7 s after it lands on average and 3.3 s at most. The same
//   two numbers serve Base's and Robinhood's Chainlink feeds: their bounds hold 300 s past the heartbeat (pool-usd.ts),
//   so a round is due 300 s before the end and the every-15-s read takes it long before the window opens; the window
//   (the end less POOL_PRICE_WRITE_LEAD_MS) only opens on a round already 280 s late, where reading each 3 s is right.
// - A read whose price is the one held (the same publish) leaves the held read as it was, its read_ms included: the
//   state is then the same and the API posts no state event to the app (src/api.ts posts one only on a change). The
//   app uses read_ms only for the bound's start, the earlier of the price's time and the read (poolUsdGoodUntilS, the
//   terminal's poolPriceEnd); the first read of a price is the earlier one, so keeping it never lengthens the bound.
// - Each timer makes its own read due (card pool-usd-price-never-stale, review P2-2): a timer that runs with the clock
//   a hair short of the due time it was set for (a coarse Date.now(), a timer run early) would otherwise find the read
//   not yet due, and with no other timer set the chain would never be read again.
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

/** A chain's price is read again at most this long after its last read: a hidden page's every read, and a Chainlink
 *  feed's (a round each 1200 s or more) away from its write; a shown page's Solana price is read at its write
 *  (POOL_PRICE_WRITE_LEAD_MS), each 55 to 60 s. */
export const POOL_PRICE_REFRESH_MS = 15_000;
/** A failed read is due again this long after it ends, doubled per failure in a row up to POOL_PRICE_REFRESH_MS: soon
 *  enough that Buy is back within a second or two of one slow answer, and a provider still failing is asked less often. */
export const POOL_PRICE_RETRY_MS = 1_000;
/** A provider's Retry-After is waited up to this: one provider's header never leaves a chain unpriced for longer. */
export const POOL_PRICE_RETRY_AFTER_MAX_MS = 60_000;
/** From this long before a held price's end (and as long after it, for a late feed) a price no newer is read again each
 *  POOL_PRICE_WRITE_POLL_MS: on Solana its bound of 75 s less this is publish + 55 s. The writes read on 10 Nov landed
 *  when the price was 52 to 58 s old; the review's simulation (P2-4) took this over publish + 50 s for its cost. */
export const POOL_PRICE_WRITE_LEAD_MS = 20_000;
/** How soon a read no newer than the held price is read again inside POOL_PRICE_WRITE_LEAD_MS of its end: a write is
 *  held within this and one read of it landing. 3 s, not 1 s: 5.0 reads a minute against 8.7, at most 3 in any 10 s
 *  against 9, which keeps several pages behind one address under the helper's per-caller 16 in 10 s (review P2-4). */
export const POOL_PRICE_WRITE_POLL_MS = 3_000;

/** The page shown again reads its prices at once (`wake`): hidden, it read only every POOL_PRICE_REFRESH_MS. */
export function wakeWhenShown(doc: Pick<Document, "addEventListener" | "visibilityState">, prices: Pick<PoolPrices, "wake">): void {
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "visible") prices.wake();
  });
}

export type PoolPriceDeps = {
  /** The chain's two RPCs of two providers, as the pool kinds read on; null: none, so no price. */
  rpcs(chain: PoolUsdChain): readonly [SolanaRpc, SolanaRpc] | null;
  /** Unix ms (Date.now otherwise). */
  now?(): number;
  /** Tests only: the read (the kit's poolUsdPrice otherwise). */
  read?(args: PoolUsdArgs): Promise<PoolUsdPrice>;
  /** Tests only: the timer the next tick waits on (setTimeout otherwise). */
  after?(ms: number, fn: () => void): void;
  /** Whether the page is shown (document.visibilityState otherwise; true with no document). */
  visible?(): boolean;
};

export type PoolPrices = {
  /** The chain's last good read while within its feed's bound on the device's clock; null otherwise. */
  get(chain: Chain): PoolStatePrice | null;
  /** Starts a read for each chain due one (see the header); never throws, never waits. */
  refresh(chains: readonly Chain[]): void;
  watch(fn: () => void): void;
  /** The page is shown again: every chain is due a read now, and the watchers hear it so a state read starts it. */
  wake(): void;
};

const priced = (c: Chain): c is PoolUsdChain => Object.hasOwn(POOL_USD_FEEDS, c);

export function poolPrices(deps: PoolPriceDeps): PoolPrices {
  const now = deps.now ?? Date.now;
  const read = deps.read ?? poolUsdPrice;
  const after = deps.after ?? ((ms: number, fn: () => void) => void setTimeout(fn, ms));
  const visible = deps.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
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
  /** When a price stops being used, unix ms: the kit's one bound. */
  const endMs = (chain: PoolUsdChain, publishedS: number, readMs: number): number => poolUsdGoodUntilS(chain, publishedS, readMs / 1000) * 1000;
  const start = (chain: PoolUsdChain): void => {
    const rpcs = deps.rpcs(chain);
    if (rpcs === null) return;
    const base = chain === "robinhood" ? deps.rpcs("base") : null;
    if (chain === "robinhood" && base === null) return;
    reading.add(chain);
    /** The provider's Retry-After of a refused read, ms. */
    let afterMs = 0;
    /** A price both providers agreed on, refused only for its age (the feed is late): its end, unix ms. */
    let lateEndMs: number | null = null;
    void Promise.resolve()
      .then(() => read({ chain, rpcs, nowMs: now(), ...(base ? { baseRpcs: base } : {}) }))
      .then((p) => {
        if (p.chain !== chain || p.price <= 0n) return false;
        const got = { price: p.price.toString(), expo: p.expo, published_s: p.publishedS, read_ms: now() };
        // unusable as the read ends: the last good one stands. Past its bound, the feed is late; ahead of the clock is no
        // late feed (the clock or the price is wrong), a failure as any other
        if (!usable(chain, got)) {
          const end = endMs(chain, got.published_s, got.read_ms);
          if (got.read_ms > end) lateEndMs = end;
          return false;
        }
        // only a newer price replaces the held one: an older one never, and the same one leaves it as it was (its first
        // read_ms, so the state is unchanged and no state event goes to the app)
        const was = held.get(chain);
        if (!was || got.published_s > was.published_s) held.set(chain, got);
        return true;
      })
      // refused (stale, disagreeing, unsure, unreachable): the last good read stands until its bound drops it
      .catch((e: unknown) => {
        // the kit's refusal for age alone, after both providers agreed on a whole, sure price (pool-usd.ts PoolUsdStale)
        if (e instanceof Error && e.name === "PoolUsdStale" && Number.isSafeInteger((e as { publishedS?: unknown }).publishedS))
          lateEndMs = endMs(chain, (e as Error & { publishedS: number }).publishedS, now());
        if (e instanceof SolanaRpcTransportError && e.afterMs !== null) afterMs = Math.min(e.afterMs, POOL_PRICE_RETRY_AFTER_MAX_MS);
        return false;
      })
      .then((ok) => {
        reading.delete(chain);
        const t = now();
        let waitMs: number;
        if (ok) {
          failed.delete(chain);
          // the next read at the feed's write: POOL_PRICE_WRITE_LEAD_MS before the held price's end, then each
          // POOL_PRICE_WRITE_POLL_MS until a newer price is in; POOL_PRICE_REFRESH_MS at most, and always while hidden
          const p = held.get(chain)!;
          const toWrite = endMs(chain, p.published_s, p.read_ms) - POOL_PRICE_WRITE_LEAD_MS - t;
          waitMs = visible() ? Math.min(Math.max(toWrite, POOL_PRICE_WRITE_POLL_MS), POOL_PRICE_REFRESH_MS) : POOL_PRICE_REFRESH_MS;
        } else if (lateEndMs !== null && visible() && t <= lateEndMs + POOL_PRICE_WRITE_LEAD_MS) {
          // a late feed, not a failing provider: read again soon, no failure counted
          waitMs = POOL_PRICE_WRITE_POLL_MS;
        } else {
          const n = (failed.get(chain) ?? 0) + 1;
          failed.set(chain, n);
          waitMs = Math.min(POOL_PRICE_RETRY_MS * 2 ** (n - 1), POOL_PRICE_REFRESH_MS);
          // a provider that said when to ask again is not asked sooner
          waitMs = Math.max(waitMs, afterMs);
        }
        const mine = t + waitMs;
        due.set(chain, mine);
        tell();
        // the timer makes its own read due: a clock a hair short of `mine` as it runs must not end the chain (review P2-2)
        after(waitMs, () => {
          if (due.get(chain) === mine) due.set(chain, Math.min(mine, now()));
          tell();
        });
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
    wake() {
      due.clear();
      tell();
    },
  };
}
