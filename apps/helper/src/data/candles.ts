// The candle and trade-tape builder both chains' own swap reads use (card index-evm-swaps; markets paper 06b §6.1
// `Candles` and `Trades`, 06c §4.12). A pure fold over swaps in block and log order: the same swaps always give the same
// candles and tape, whether they arrive one tick at a time as the chain moves, are rebuilt in one read, or are split in
// any number of reads. No clock, no float, no randomness: every amount is a bigint, every division floors.
//
// THE ONE PRICING RULE. A swap is priced only from the token's main pool, by its own amounts: the quote leg's USD value
// over the token leg. The quote is a dollar stablecoin (USDC, USDG: 1 USD per unit) or ETH (the swap's wei at the ETH
// price in force, the last `ref` event before it in block and log order). A swap of any other pool, and a swap whose
// quote is anything else, is never an input here: the caller refuses the token. A swap with a zero leg, or a price that
// floors to zero, is dropped (never a candle of 0).
//
// Input: events in (block, index) order, each a `swap` or a `ref`. Output: bars [t_s, open, high, low, close, vol_usd]
// (USD decimal strings) per timeframe, oldest first, one per bucket that held a swap, and the tape, newest first.
//
// Reads and reorgs. The newest blocks can change, so a book keeps a tail of raw events (the blocks after `settledTo`)
// that a later `ingest` replaces from any block after settledTo, and folds events into its aggregates only once they
// are settled (`ingest`'s `settledTo`). The result of a sequence of ingests depends only on the final events and
// settledTo, never on how they were split (tests: candles.test.ts).
//
// Bounded: at most BUCKETS_MAX[tf] buckets per timeframe (the oldest go), TAPE_MAX swaps on the tape, and the tail
// holds the events the caller gave it (the caller bounds a read).

/** Seconds per timeframe: 06b's list (06c §4.12; `1s` is served only where blocks are faster than a second, by the caller). */
export const TF_SECONDS = { "1s": 1, "1m": 60, "5m": 300, "15m": 900, "1h": 3_600, "4h": 14_400, "1d": 86_400 } as const;
export type Tf = keyof typeof TF_SECONDS;
export const TFS = Object.keys(TF_SECONDS) as readonly Tf[];
/** Buckets kept per timeframe: an hour of 1s, two days of 1m, then at least 20 days of every other. */
export const BUCKETS_MAX: Readonly<Record<Tf, number>> = { "1s": 3_600, "1m": 2_880, "5m": 2_000, "15m": 2_000, "1h": 2_000, "4h": 1_500, "1d": 1_500 };
/** Swaps the tape keeps (the route serves at most 50; 06b "limit <= 50"). */
export const TAPE_MAX = 100;

/** Price scale: USD per whole token times 10^PRICE_SCALE, as a bigint. */
export const PRICE_SCALE = 30;
/** Value scale: USD times 10^VALUE_SCALE, as a bigint. */
export const VALUE_SCALE = 18;

export type Swap = {
  kind: "swap";
  block: number;
  /** The log's index in its block: with the block, a swap's place in the order. */
  index: number;
  tx: string;
  /** The block's time, whole seconds. */
  t: number;
  /** `b`: the token was bought from the pool; `s`: sold to it. */
  side: "b" | "s";
  /** The token leg, in the token's smallest unit, > 0. */
  amt: bigint;
  /** The quote leg, in the quote's smallest unit, > 0. */
  quote: bigint;
};
/** ETH's price at a point: USD per ETH times 10^VALUE_SCALE, from the chain's reference pool. */
export type Ref = { kind: "ref"; block: number; index: number; ethUsd: bigint };
export type Event = Swap | Ref;

export type BookConfig = {
  /** The token's decimals, 0 to 77. */
  decimals: number;
  /** `usd`: the quote is a dollar stablecoin; `eth`: the quote is ETH or WETH. */
  quote: { kind: "usd" | "eth"; decimals: number };
};

/** One bar, in integers: prices scaled by 10^PRICE_SCALE, volume by 10^VALUE_SCALE. */
type Bar = { o: bigint; h: bigint; l: bigint; c: bigint; v: bigint };
/** A swap with its USD value and price worked out. */
export type Priced = { swap: Swap; usd: bigint; price: bigint };

export type Candle = [number, string, string, string, string, string];
export type TapeRow = { t_ms: number; side: "b" | "s"; usd: string; amt: string; trader: string | null; tx: string };

const TEN = 10n;
const pow10 = (n: number): bigint => TEN ** BigInt(n);

/** `v` / 10^scale as a decimal string with no exponent and no trailing zeros ("0" for 0). */
export function fixed(v: bigint, scale: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(scale + 1, "0");
  const whole = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac === "" ? "" : `.${frac}`}`;
}

/** The swap's USD value (times 10^VALUE_SCALE) and price, or null when it cannot be priced: an ETH quote with no
 *  ETH price yet, a zero leg, or a price that floors to zero. */
export function price(cfg: BookConfig, swap: Swap, ethUsd: bigint | null): Priced | null {
  if (swap.amt <= 0n || swap.quote <= 0n) return null;
  let usd: bigint;
  if (cfg.quote.kind === "usd") usd = swap.quote * pow10(VALUE_SCALE) / pow10(cfg.quote.decimals);
  else {
    if (ethUsd === null) return null;
    usd = swap.quote * ethUsd / pow10(cfg.quote.decimals);
  }
  const p = usd * pow10(cfg.decimals) * pow10(PRICE_SCALE - VALUE_SCALE) / swap.amt;
  return usd > 0n && p > 0n ? { swap, usd, price: p } : null;
}

const order = (a: { block: number; index: number }, b: { block: number; index: number }) => a.block - b.block || a.index - b.index;

/** Folds one priced swap into `bars` (a map of bucket start to bar) for one timeframe. */
function add(bars: Map<number, Bar>, step: number, p: Priced): void {
  const start = p.swap.t - (p.swap.t % step);
  const b = bars.get(start);
  if (b === undefined) bars.set(start, { o: p.price, h: p.price, l: p.price, c: p.price, v: p.usd });
  else {
    if (p.price > b.h) b.h = p.price;
    if (p.price < b.l) b.l = p.price;
    b.c = p.price;
    b.v += p.usd;
  }
}

const copy = (b: Bar): Bar => ({ ...b });

export function createBook(cfg: BookConfig) {
  if (!Number.isInteger(cfg.decimals) || cfg.decimals < 0 || cfg.decimals > 77) throw new Error("decimals out of range");
  if (!Number.isInteger(cfg.quote.decimals) || cfg.quote.decimals < 0 || cfg.quote.decimals > 77) throw new Error("quote decimals out of range");
  // settled: events folded in, never rewritten
  const bars = Object.fromEntries(TFS.map((tf) => [tf, new Map<number, Bar>()])) as Record<Tf, Map<number, Bar>>;
  let settledTo = -1;
  let ethUsd: bigint | null = null;
  let settledTape: Priced[] = [];
  let tail: Event[] = [];

  /** The tail's events, priced from the price in force at the settled point. */
  function tailPriced(): Priced[] {
    let eth = ethUsd;
    const out: Priced[] = [];
    for (const e of tail) {
      if (e.kind === "ref") eth = e.ethUsd;
      else {
        const p = price(cfg, e, eth);
        if (p !== null) out.push(p);
      }
    }
    return out;
  }

  return {
    /** The newest block folded into the aggregates (-1 before any). */
    get settledTo(): number {
      return settledTo;
    },
    /**
     * Replaces every event at `from` and after with `events` (sorted by block and index, none before `from`), then
     * folds into the aggregates every event at or before `settledThrough`. `from` must come after the settled point:
     * what is settled is never rewritten. Events are copied. Throws on a call that breaks those rules.
     */
    ingest(from: number, events: readonly Event[], settledThrough: number): void {
      if (!Number.isSafeInteger(from) || from <= settledTo) throw new Error(`ingest from ${from} is not after settledTo ${settledTo}`);
      if (settledThrough < settledTo) throw new Error("settledThrough goes back");
      for (let i = 0; i < events.length; i++) {
        const e = events[i]!;
        if (e.block < from || (i > 0 && order(events[i - 1]!, e) >= 0)) throw new Error("events are not in order from `from`");
      }
      tail = tail.filter((e) => e.block < from).concat(events);
      const cut = tail.findIndex((e) => e.block > settledThrough);
      const done = cut === -1 ? tail : tail.slice(0, cut);
      tail = cut === -1 ? [] : tail.slice(cut);
      for (const e of done) {
        if (e.kind === "ref") ethUsd = e.ethUsd;
        else {
          const p = price(cfg, e, ethUsd);
          if (p === null) continue;
          for (const tf of TFS) add(bars[tf], TF_SECONDS[tf], p);
          settledTape.push(p);
        }
      }
      if (settledTape.length > TAPE_MAX) settledTape = settledTape.slice(-TAPE_MAX);
      for (const tf of TFS) {
        const m = bars[tf];
        while (m.size > BUCKETS_MAX[tf]) m.delete(m.keys().next().value!); // buckets enter in time order
      }
      settledTo = Math.max(settledTo, settledThrough);
    },

    /** Bars of `tf` oldest first: those starting before `to` (unix seconds) when set, at most `limit`. */
    candles(tf: Tf, to: number | null, limit: number): Candle[] {
      const step = TF_SECONDS[tf];
      const view = new Map<number, Bar>();
      const live = tailPriced();
      const touched = new Set(live.map((p) => p.swap.t - (p.swap.t % step)));
      for (const [k, b] of bars[tf]) view.set(k, touched.has(k) ? copy(b) : b);
      for (const p of live) add(view, step, p);
      const rows = [...view].sort((a, b) => a[0] - b[0]).filter(([k]) => to === null || k < to);
      return rows.slice(-limit).map(([k, b]) => [k, fixed(b.o, PRICE_SCALE), fixed(b.h, PRICE_SCALE), fixed(b.l, PRICE_SCALE), fixed(b.c, PRICE_SCALE), fixed(b.v, VALUE_SCALE)]);
    },

    /** The first bucket start of `tf` this book holds, or null. */
    ownFrom(tf: Tf): number | null {
      const first = bars[tf].keys().next().value;
      const live = tailPriced();
      const t0 = live.length === 0 ? null : live[0]!.swap.t - (live[0]!.swap.t % TF_SECONDS[tf]);
      if (first === undefined) return t0;
      return t0 === null ? first : Math.min(first, t0);
    },

    /** The newest `limit` swaps, newest first; `trader` is filled by the caller (null here). */
    tape(limit: number): (TapeRow & { block: number; index: number })[] {
      const all = settledTape.concat(tailPriced());
      return all
        .slice(-limit)
        .reverse()
        .map((p) => ({
          t_ms: p.swap.t * 1000,
          side: p.swap.side,
          usd: fixed(p.usd, VALUE_SCALE),
          amt: fixed(p.swap.amt, cfg.decimals),
          trader: null,
          tx: p.swap.tx,
          block: p.swap.block,
          index: p.swap.index,
        }));
    },
  };
}
export type Book = ReturnType<typeof createBook>;
