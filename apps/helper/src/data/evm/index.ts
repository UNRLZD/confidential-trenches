// The chain's swaps, read once for every token (card helper-robinhood-capacity fold 6): one follower per chain reads
// the swap events chain-wide, by topic and with no address, from an agreed block forward, on two agreeing providers
// (swaps.ts supplies the read: agreed, paced and held as every read of ours is). A tape or a tick for any token, listed
// or not, is answered from what it holds; a token's own read stays only for a range it does not hold yet.
//
// Why (read 2026-11-05 01:53Z from the Mac, head 106,367,578): one chain-wide `eth_getLogs` of the swap topics (v4
// PoolManager Swap, v3 Swap, v2 Swap, Pons CurveBuy and CurveSell) over 100 blocks answered 157 logs, 145 KB, in 0.6 s
// on robinhood.daybreak-rpc.network, 0.6 s on rpc-robinhood.blockmachine.io, 0.2 s on robinhood.drpc.org and 0.4 s on
// rpc.mainnet.chain.robinhood.com; over 1,000 blocks (99 s of chain time) 3,062 logs (swap3 1,461, swap4 1,583, swap2
// 3, CurveBuy 8, CurveSell 7), 2.8 MB, in 1.7, 0.9 and 0.8 s on the three that take it (drpc's free plan refuses past
// 100 blocks: code 35). robinhood.api.pocket.network and api.blockvectra.com refuse a filter with no address (-32602
// "missing required field 'address'", "invalid_params"). The chain trades about 1,850 swaps a minute. At fa4b98d a cold
// dozen's tapes read the same blocks a dozen times over, 405 eth_getLogs (card's fold 4 table); here they are one read.
//
// Built for any chain (helper-lists-own-index puts Discover's lists and Base on it): `createSwapIndex` takes the chain's
// read and its topics, nothing of Robinhood's.
import type { Log } from "./swaps.ts";

/** A transaction's trader, the one rule for it (card helper-tape-4337-trader will change it here): its sender. */
export function traderFrom(tx: Record<string, unknown>): unknown {
  return tx.from;
}

/** What the index serves. `upTo(n)`: read up to block `n` (one read at a time, every caller waits on the same);
 *  true when it then holds `n`. `holds(lo, hi)`: whether blocks lo..hi are all held. `query(filter, lo, hi)`: the held
 *  logs that match an `eth_getLogs` filter (its address and topics), in block order. `logs(lo, hi)`: every held log in
 *  the range (Discover's lists, helper-lists-own-index). `indexes(filter)`: whether a filter's events are the ones held. */
export type SwapIndex = {
  readonly topics: ReadonlySet<string>;
  range(): { from: number; to: number } | null;
  holds(lo: number, hi: number): boolean;
  indexes(filter: Record<string, unknown>): boolean;
  upTo(n: number): Promise<boolean>;
  query(filter: Record<string, unknown>, lo: number, hi: number): Log[];
  logs(lo: number, hi: number): Log[];
};

/**
 * `read(lo, hi)`: the chain's logs of `topics` over blocks lo..hi, agreed by two providers, or null. `window`: the blocks
 * held behind the newest (the tape's cold window and the ETH price's before it); a gap past it starts the index again
 * at the newest `window` blocks. `chunk`: the most blocks one call to `read` asks, so a long catch-up is a few reads.
 */
export function createSwapIndex(deps: { topics: readonly string[]; read: (lo: number, hi: number) => Promise<Log[] | null>; window: number; chunk: number }): SwapIndex {
  const topics = new Set(deps.topics.map((t) => t.toLowerCase()));
  let from = -1;
  let to = -1;
  /** Held logs by address, and by address and first indexed topic (a v4 pool's id), each in block order. */
  const byAddr = new Map<string, Log[]>();
  const byKey = new Map<string, Log[]>();
  let reading: Promise<void> | null = null;

  const push = (m: Map<string, Log[]>, k: string, l: Log) => {
    const a = m.get(k);
    if (a === undefined) m.set(k, [l]);
    else a.push(l);
  };
  const add = (logs: Log[]) => {
    for (const l of logs) {
      push(byAddr, l.address, l);
      if (l.topics[1] !== undefined) push(byKey, `${l.address} ${l.topics[1]}`, l);
    }
  };
  const prune = (keepFrom: number) => {
    for (const m of [byAddr, byKey])
      for (const [k, a] of m) {
        const i = a.findIndex((l) => l.block >= keepFrom);
        if (i < 0) m.delete(k);
        else if (i > 0) m.set(k, a.slice(i));
      }
    from = Math.max(from, keepFrom);
  };
  const reset = () => {
    byAddr.clear();
    byKey.clear();
    from = -1;
    to = -1;
  };
  const sorted = (a: Log[]) => a.sort((x, y) => x.block - y.block || x.index - y.index);

  async function readTo(n: number): Promise<void> {
    // a gap past the window, or nothing held: the newest `window` blocks again
    if (to < 0 || n - to > deps.window) {
      reset();
      const lo = Math.max(0, n - deps.window + 1);
      const parts: Log[] = [];
      for (let a = lo; a <= n; a += deps.chunk) {
        const b = Math.min(n, a + deps.chunk - 1);
        const got = await deps.read(a, b);
        if (got === null || got.some((l) => l.block < a || l.block > b)) return;
        parts.push(...got);
      }
      add(sorted(parts));
      from = lo;
      to = n;
      return;
    }
    for (let a = to + 1; a <= n; a += deps.chunk) {
      const b = Math.min(n, a + deps.chunk - 1);
      const got = await deps.read(a, b);
      if (got === null) return;
      if (got.some((l) => l.block < a || l.block > b)) return;
      add(sorted(got));
      to = b;
    }
    if (to - from + 1 > deps.window) prune(to - deps.window + 1);
  }

  const matches = (l: Log, f: Record<string, unknown>): boolean => {
    const t = Array.isArray(f.topics) ? (f.topics as unknown[]) : [];
    return t.every((want, i) => want === null || want === undefined || (Array.isArray(want) ? want.includes(l.topics[i]) : want === l.topics[i]));
  };

  return {
    topics,
    range: () => (to < 0 ? null : { from, to }),
    holds: (lo, hi) => to >= 0 && lo >= from && hi <= to,
    indexes(f) {
      const t0 = Array.isArray(f.topics) ? (f.topics as unknown[])[0] : undefined;
      const first = Array.isArray(t0) ? t0 : [t0];
      return typeof f.address === "string" && first.length > 0 && first.every((x) => typeof x === "string" && topics.has(x));
    },
    async upTo(n) {
      while (to < n) {
        if (reading === null) {
          const target = n;
          reading = readTo(target).finally(() => {
            reading = null;
          });
          await reading;
          if (to < target) return false;
        } else await reading;
      }
      return true;
    },
    query(f, lo, hi) {
      const addr = String(f.address).toLowerCase();
      const t1 = Array.isArray(f.topics) ? (f.topics as unknown[])[1] : undefined;
      const list = typeof t1 === "string" ? (byKey.get(`${addr} ${t1}`) ?? []) : (byAddr.get(addr) ?? []);
      return list.filter((l) => l.block >= lo && l.block <= hi && matches(l, f));
    },
    logs(lo, hi) {
      return sorted([...byAddr.values()].flat().filter((l) => l.block >= lo && l.block <= hi));
    },
  };
}
