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
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Log } from "./swaps.ts";

// -------------------------------------------------------------------------------------------------------------
// The trader of a swap: the one rule every tape path uses (tape, tick, cold read and this index all feed the same
// book, whose rows are named by swaps.ts lookTraders through `txTraders` and `traderAt` alone)
// -------------------------------------------------------------------------------------------------------------

/**
 * The ERC-4337 EntryPoints, v0.6, v0.7, v0.8 and v0.9 (the addresses each release of eth-infinitism/account-abstraction
 * names). Read 2026-11-05 10:46-10:55Z with `eth_getCode` on base-rpc.publicnode.com, base.drpc.org,
 * rpc.mainnet.chain.robinhood.com and robinhood.drpc.org: each is deployed on Base and on Robinhood, v0.6 23,689 bytes
 * (code hash 0xc93c806e...8e70) and v0.7 16,035 bytes (0x8db5ff69...fc58) alike on all four, v0.8 21,738 and v0.9 22,425
 * bytes, and every one's code holds the UserOperationEvent and BeforeExecution topics. A transaction sent to one is a
 * bundle: its `from` is the bundler that paid the gas, never the trader. 608 Robinhood transactions logged a
 * UserOperationEvent over blocks 106,659,712-106,679,711 (rpc.mainnet.chain.robinhood.com, 10:56Z); of the first 40
 * that logged a swap, 26 went to v0.8 from bundlers 0x4337..., 13 to v0.7 and 1 to v0.6.
 */
export const ENTRY_POINTS: ReadonlySet<string> = new Set([
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
  "0x0000000071727de22e5e9d8baf0edac6f37da032",
  "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
  "0x433709009b8330fda32311df1c2afa402ed8d009",
]);
const topic = (sig: string): string => `0x${Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex")}`;
export const USER_OP_EVENT = topic("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
export const BEFORE_EXECUTION = topic("BeforeExecution()");
export const AGGREGATOR_CHANGED = topic("SignatureAggregatorChanged(address)");
const ADDR = /^0x[0-9a-f]{40}$/;
const WORD_ADDR = /^0x0{24}([0-9a-f]{40})$/;
const HASH = /^0x[0-9a-f]{64}$/;
const low = (v: unknown): string | null => (typeof v === "string" ? v.toLowerCase() : null);

/** A transaction's traders: its sender (`from`), or for a bundle sent to an EntryPoint each user operation's account
 *  (`sender`) over the log indexes its execution logged, lo and hi excluded (`ops`). */
export type Traders = { from: string } | { ops: readonly { lo: number; hi: number; sender: string }[] };

/** Whether a transaction (eth_getTransactionByHash's answer) is a bundle sent to an EntryPoint, whose traders only its
 *  receipt names: the one kind that costs a read more. */
export function toEntryPoint(tx: Record<string, unknown>): boolean {
  return ENTRY_POINTS.has(low(tx.to) ?? "");
}

/**
 * A transaction's traders, from its transaction and, for a bundle sent to an EntryPoint, its receipt; null when they
 * cannot be named (a malformed answer, or a bundle with no receipt that matches it), never a guess and never the bundler.
 *
 * In a bundle each user operation's logs sit between the EntryPoint's own marks, in the order the EntryPoint emits them:
 * `handleOps` validates every operation, emits BeforeExecution, then runs each one, and each one's run ends with its
 * UserOperationEvent (eth-infinitism/account-abstraction v0.6.0 contracts/core/EntryPoint.sol:105 BeforeExecution, :108
 * the loop of _executeUserOp, :592 UserOperationEvent at the end of _handlePostOp; v0.7.0 EntryPoint.sol:197, :200, :154
 * in emitUserOperationEvent, called last by _postExecution at :747; v0.8.0 :68, :71, :285; v0.9.0 :88, :91, :312;
 * v0.9.0 contracts/interfaces/IEntryPoint.sol:118-119 "Any event emitted before this event, is part of the validation").
 * `handleAggregatedOps` does the same per aggregator, each group's run after its SignatureAggregatorChanged (v0.6.0 :148
 * and :169, v0.7.0 :261 and :267, v0.8.0 :119 and :125, v0.9.0 :139 and :145). So
 * an operation's run is the logs after the EntryPoint's last BeforeExecution, SignatureAggregatorChanged or
 * UserOperationEvent and before its own UserOperationEvent, whose second indexed topic is its account. Only the
 * EntryPoint's own logs mark anything: any contract can log the same topics. A paymaster's postOp runs inside that range
 * too (v0.6.0 :571, before :592; v0.7.0 :705, before :747), so its logs count as the operation's.
 */
export function txTraders(tx: Record<string, unknown>, receipt: Record<string, unknown> | null): Traders | null {
  const from = low(tx.from);
  if (from === null || !ADDR.test(from)) return null;
  if (!toEntryPoint(tx)) return { from };
  const ep = low(tx.to)!;
  const hash = low(tx.hash);
  if (receipt === null || hash === null || !HASH.test(hash) || low(receipt.transactionHash) !== hash || low(receipt.to) !== ep || low(receipt.from) !== from) return null;
  if (!Array.isArray(receipt.logs)) return null;
  const marks: { index: number; t0: string; sender: string | null }[] = [];
  for (const raw of receipt.logs as unknown[]) {
    const l = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const index = typeof l.logIndex === "string" && /^0x[0-9a-f]{1,8}$/i.test(l.logIndex) ? parseInt(l.logIndex, 16) : null;
    const topics = Array.isArray(l.topics) ? l.topics.map(low) : null;
    if (index === null || topics === null) return null;
    if (low(l.address) !== ep) continue;
    const t0 = topics[0];
    if (t0 === BEFORE_EXECUTION || t0 === AGGREGATOR_CHANGED) marks.push({ index, t0, sender: null });
    else if (t0 === USER_OP_EVENT) {
      const sender = WORD_ADDR.exec(topics[2] ?? "")?.[1];
      if (topics.length !== 4 || sender === undefined) return null;
      marks.push({ index, t0, sender: `0x${sender}` });
    }
  }
  marks.sort((a, b) => a.index - b.index);
  const ops: { lo: number; hi: number; sender: string }[] = [];
  let start: number | null = null; // no run before the EntryPoint's BeforeExecution: that is validation
  for (const m of marks) {
    if (m.sender !== null && start !== null) ops.push({ lo: start, hi: m.index, sender: m.sender });
    if (m.t0 === BEFORE_EXECUTION || start !== null) start = m.index;
  }
  return { ops };
}

/** The trader of the swap logged at `index` of a transaction whose traders are `t`: its sender, or the account of the
 *  user operation whose run holds the log; null for a log in no operation's run (a bundle's validation) or none known. */
export function traderAt(t: Traders | undefined, index: number): string | null {
  if (t === undefined) return null;
  if ("from" in t) return t.from;
  return t.ops.find((o) => o.lo < index && index < o.hi)?.sender ?? null;
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
    // a gap past the window, or nothing held: the newest `window` blocks again, each chunk held as it is agreed, so a
    // chunk that fails costs that chunk and the next read goes on from it (card helper-robinhood-trades-hang: all or
    // nothing over five chunks, the first read never landed in 135 s while one provider timed out on one post in five)
    if (to < 0 || n - to > deps.window) {
      reset();
      const lo = Math.max(0, n - deps.window + 1);
      for (let a = lo; a <= n; a += deps.chunk) {
        const b = Math.min(n, a + deps.chunk - 1);
        const got = await deps.read(a, b);
        if (got === null || got.some((l) => l.block < a || l.block > b)) return;
        add(sorted(got));
        from = lo;
        to = b;
      }
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
