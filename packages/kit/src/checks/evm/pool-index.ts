// The device's index of every Uniswap v4 pool of a chain (card evm-pool-index): the PoolManager's Initialize logs, read
// in spans of the venue's `index.span` blocks on the venue's two index readers, each of another operator, and never on
// the helper (the money rule's attacker is a broken-in helper). A quote that reads its pools from the index asks no
// getLogs of its own; until the index covers the quote's agreed block, the quote keeps its bounded scan
// (checks/evm/quote.ts scanPools, card evm-buy-quote-in-window), so no quote waits on a cold build.
//
// One sync (evmPoolIndexSync):
// - F4b: both readers are asked their head; the sync's block N is the lower of the two, and heads more than the margin
//   apart refuse rpc_disagree (one reader far behind would set the index's first block for good);
// - F4c: the newest span ends at N and is asked first, its batch with block N on both readers: the two hashes must be
//   equal (the pin), in the first read round, or the sync refuses rpc_disagree and nothing it read is kept;
// - F4a: every span is asked of both readers, each batch holding the span's logs and its last block; a span counts only
//   when both readers answered it, each with that block (the same hash on both) in the same batch as its logs; a span
//   either failed is asked again of that reader, at most INDEX_TRIES times, and a span with INDEX_SPAN_LOGS logs or more
//   on either is asked again as its two halves on both; a batch whose tries are spent on throws (a body past its
//   size, a 4xx, a timeout) is asked one span a request, then as halves, under one budget of halves;
// - F2: a pool both readers report is at the same block on both (else the span is asked again, then refused), and one
//   pool id at two blocks, in two spans or in a span and the stored index is refused rpc_disagree: a pool initializes
//   once;
// - F5: a pool that only one reader reported counts only where the PoolManager's state of it at N (extsload of its
//   state slot, by N's hash) is the same non-zero word on both readers: 0 on both is no pool, any other pair refuses
//   rpc_disagree; its id is recomputed from its key, and any log whose pool id is not the key's is no log;
// - F6: past the venue's `index.cap` pools both readers report, the sync refuses too_many_pools by name and serves
//   nothing; one reader's pools that take it past (held or not) refuse rpc_disagree;
// - F4d: what it stores ends `index.margin` blocks below N (a reorg's reach), so the next sync's gap starts there and
//   reads the margin again; what the sync answers (`pools`) holds the margin's pools too.
//
// The index (EvmPoolIndexData) is plain data: JSON.stringify and JSON.parse give it back whole, with the head it was
// proven at, for a later card to keep on the device. A sync that fails part way returns the index with what it did
// prove (newest spans first), `coversThrough` null and no pools, so the next sync reads only what is left.
import type { EvmPoolKey, EvmRpc } from "./quote.ts";
import { EvmQuoteError } from "./quote.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** One pool of the index: its id (keccak of its key, never the log's word), its key and its Initialize block. */
export type EvmIndexedPool = { readonly id: string; readonly key: EvmPoolKey; readonly block: number };
/** The index as it is stored: the blocks both readers proved (`spans`, disjoint, in order, none above `through`) and the
 *  pools in them, from `from` (the oldest block it reads) to `through` (its sync's head less the margin). */
export type EvmPoolIndexData = {
  readonly v: 1;
  readonly chainId: number;
  readonly poolManager: string;
  readonly from: number;
  readonly through: number;
  readonly head: { readonly number: number; readonly hash: string };
  readonly spans: readonly (readonly [number, number])[];
  readonly pools: readonly EvmIndexedPool[];
};
export type EvmPoolIndexConfig = {
  readonly chainId: number;
  readonly poolManager: string;
  /** The two readers, each of another operator. */
  readonly readers: readonly [EvmRpc, EvmRpc];
  /** How far back a new index reads, in blocks from N. */
  readonly depth: number;
  readonly span: number;
  readonly margin: number;
  readonly cap: number;
  /** Spans in one JSON-RPC batch, and batches in flight on each reader at once. */
  readonly perBatch: number;
  readonly parallel: number;
  /** For the tests: the wait between tries (default: setTimeout). */
  readonly nap?: (ms: number) => Promise<void>;
};
/** Per reader: batches asked, getLogs asked, 429s, the longest 429 wait of one batch (ms), batches failed. */
export type EvmPoolIndexStats = { requests: [number, number]; getLogs: [number, number]; limited: [number, number]; limitedMaxMs: [number, number]; failed: [number, number]; ms: number };
export type EvmPoolIndexSync = {
  readonly index: EvmPoolIndexData | null;
  /** N where every block from the index's `from` to N is proven, else null (a partial index, never served). */
  readonly coversThrough: number | null;
  /** Every pool to N (the stored ones and the margin's), only where coversThrough is N. */
  readonly pools: readonly EvmIndexedPool[] | null;
  /** Why a sync that returned a partial index stopped. */
  readonly error: EvmQuoteError | null;
  readonly stats: EvmPoolIndexStats;
};

const INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"; // Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)
/** A span answered with this many logs or more may be one its provider cut, so it is asked again as its halves. */
export const INDEX_SPAN_LOGS = 10_000;
/** The tries of one batch on one reader (a 429 waits and does not spend one, up to INDEX_LIMITED_WAIT_MS a batch). */
export const INDEX_TRIES = 4;
/** The longest one batch waits on a reader's 429s, its Retry-After or a doubling backoff, before each 429 spends a try:
 *  twice the longest measured, 31.5 s, of a 3M-block Robinhood build at 2 at once of 10 spans, whose
 *  rpc.mainnet.chain.robinhood.com answered 31 of 63 batches 429 (2026-11-08 19:30Z; the 10M build's 144 of 246). */
export const INDEX_LIMITED_WAIT_MS = 60_000;
/** Halves a sync may ask past each starting span's first split. */
export const INDEX_HALVES = 64;
/** The PoolManager state reads (F5) in one batch. */
const INDEX_STATE_BATCH = 500;
const BACKOFF_MS = 500;
const SEL_EXTSLOAD = "1e2eaeaf"; // PoolManager.extsload(bytes32)
const POOLS_SLOT = 6n; // v4-core StateLibrary.POOLS_SLOT
const U24 = 0xffffff;

/** A call's error naming the reader's rate limit (checks/evm/quote.ts `limited`'s words): asked again later, never as
 *  halves, which would spend the halves on a reader that is only busy. */
const limited = (e: unknown) => /request limit|rate limit|too many requests|exceeded its compute units per second/i.test(String((e as { message?: unknown } | null)?.message ?? ""));
const hex = (b: Uint8Array) => "0x" + bytesToHex(b);
const word = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, "0");
const keccak = (h: string) => hex(keccak_256(hexToBytes(h)));
/** v4's PoolId: keccak256(abi.encode(PoolKey)). */
export const evmPoolIdOf = (k: EvmPoolKey): string =>
  keccak(word(BigInt(k.currency0)) + word(BigInt(k.currency1)) + word(BigInt(k.fee)) + word(BigInt.asUintN(256, BigInt(k.tickSpacing))) + word(BigInt(k.hooks)));
const stateSlot = (id: string) => keccak(id.slice(2) + word(POOLS_SLOT));
const hx = (n: number) => "0x" + n.toString(16);
const isHash = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
const isQty = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(x);
const refuse = (code: EvmQuoteError["code"], m: string): never => {
  throw new EvmQuoteError(code, m);
};

type Spans = [number, number][];
const withSpan = (spans: readonly (readonly [number, number])[], a: number, b: number): Spans => {
  const out: Spans = [];
  for (const [x, y] of [...spans, [a, b] as const].map(([p, q]) => [p, q] as [number, number]).sort((p, q) => p[0] - q[0])) {
    const last = out[out.length - 1];
    if (last !== undefined && x <= last[1] + 1) last[1] = Math.max(last[1], y);
    else out.push([x, y]);
  }
  return out;
};
const gapsOf = (spans: readonly (readonly [number, number])[], lo: number, hi: number): Spans => {
  const out: Spans = [];
  let at = lo;
  for (const [a, b] of spans) {
    if (b < at) continue;
    if (a > hi) break;
    if (a > at) out.push([at, a - 1]);
    at = Math.max(at, b + 1);
  }
  if (at <= hi) out.push([at, hi]);
  return out;
};

/** A log's pool, or null where the log is not the PoolManager's Initialize in [a, b] or its id word is not its key's. */
function poolOfLog(l: unknown, pm: string, a: number, b: number): EvmIndexedPool | null {
  const o = l as { address?: unknown; topics?: unknown; data?: unknown; blockNumber?: unknown; removed?: unknown } | null;
  if (typeof o !== "object" || o === null || o.removed === true) return null;
  const t = o.topics;
  if (typeof o.address !== "string" || o.address.toLowerCase() !== pm || !Array.isArray(t) || t.length !== 4 || !t.every(isHash)) return null;
  if (t[0]!.toLowerCase() !== INITIALIZE || !isQty(o.blockNumber) || typeof o.data !== "string" || !/^0x([0-9a-fA-F]{64}){5}$/.test(o.data)) return null;
  const n = Number(o.blockNumber);
  if (n < a || n > b) return null;
  const d = o.data.slice(2);
  const addr = (x: string) => "0x" + x.slice(24).toLowerCase();
  if (/[^0]/.test(t[2]!.slice(2, 26) + t[3]!.slice(2, 26) + d.slice(128, 152))) return null;
  const fee = BigInt("0x" + d.slice(0, 64));
  const tick = BigInt.asIntN(256, BigInt("0x" + d.slice(64, 128)));
  if (fee > BigInt(U24) || tick < 1n || tick > 32767n) return null;
  const key: EvmPoolKey = Object.freeze({ currency0: addr(t[2]!.slice(2)), currency1: addr(t[3]!.slice(2)), fee: Number(fee), tickSpacing: Number(tick), hooks: addr(d.slice(128, 192)) });
  if (BigInt(key.currency0) >= BigInt(key.currency1)) return null;
  const id = evmPoolIdOf(key);
  if (id !== t[1]!.toLowerCase()) return null;
  return Object.freeze({ id, key, block: n });
}

/** A reader's answer to a span: its last block's hash and its pools; `cut` where its logs were an error or no answer
 *  ("error") or at the cap ("full"), which is asked again as halves. */
type Answer = { hash: string; pools: Map<string, EvmIndexedPool>; cut: "error" | "full" | null };
/** `alone`: the reader's batches holding the span spent their tries on throws, so it is asked one span a request. */
type Job = { a: number; b: number; ans: [Answer | null, Answer | null]; tries: [number, number]; alone: [boolean, boolean]; disagree: number };
const jobOf = (a: number, b: number): Job => ({ a, b, ans: [null, null], tries: [0, 0], alone: [false, false], disagree: 0 });
const NO_ANSWER: Answer = Object.freeze({ hash: "", pools: new Map(), cut: "error" as const });

/** One sync of `prev` (or a new index) to the readers' agreed head; see the file's head. Refuses (throws) where nothing
 *  can be proven (the heads, the pin), where the readers disagree, and past the cap; a reader that does not answer
 *  returns what the sync proved. One lying reader may make it refuse, never hide a pool or claim a block it did not
 *  prove. */
export async function evmPoolIndexSync(prev: EvmPoolIndexData | null, c: EvmPoolIndexConfig): Promise<EvmPoolIndexSync> {
  const t0 = performance.now();
  const pm = c.poolManager.toLowerCase();
  const nap = c.nap ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stats: EvmPoolIndexStats = { requests: [0, 0], getLogs: [0, 0], limited: [0, 0], limitedMaxMs: [0, 0], failed: [0, 0], ms: 0 };
  const done = (r: Omit<EvmPoolIndexSync, "stats">): EvmPoolIndexSync => ((stats.ms = Math.round(performance.now() - t0)), { ...r, stats });
  const old = prev !== null && prev.v === 1 && prev.chainId === c.chainId && prev.poolManager === pm ? prev : null;

  // one batch on reader r, asked again until answered or its tries are spent (null); a 429 waits and spends no try,
  // up to INDEX_LIMITED_WAIT_MS of waiting a batch, past which each 429 spends one
  async function ask(r: 0 | 1, calls: { method: string; params: unknown[] }[]): Promise<readonly unknown[] | null> {
    let waited = 0;
    let waits = 0;
    for (let tries = 0; tries < INDEX_TRIES; ) {
      stats.requests[r]++;
      stats.getLogs[r] += calls.filter((x) => x.method === "eth_getLogs").length;
      try {
        return await c.readers[r](calls);
      } catch (e) {
        const after = (e as { afterMs?: unknown } | null)?.afterMs;
        if (/429|rate limit/i.test(String((e as Error)?.message)) && waited < INDEX_LIMITED_WAIT_MS) {
          stats.limited[r]++;
          const ms = Math.min(typeof after === "number" && after >= 0 ? after : BACKOFF_MS * 2 ** waits++, INDEX_LIMITED_WAIT_MS - waited);
          waited += ms;
          stats.limitedMaxMs[r] = Math.max(stats.limitedMaxMs[r], waited);
          await nap(ms);
          continue;
        }
        stats.failed[r]++;
        tries++;
        if (tries < INDEX_TRIES) await nap(BACKOFF_MS * 2 ** tries);
      }
    }
    return null;
  }

  // F4b: the lower of the two proven heads, never more than the margin apart (a reader far behind would set `from`
  // for good)
  const heads = await Promise.all(([0, 1] as const).map(async (r) => {
    const a = (await ask(r, [{ method: "eth_getBlockByNumber", params: ["latest", false] }]))?.[0] as { result?: { number?: unknown; hash?: unknown } | null } | null | undefined;
    const h = a?.result;
    return h && isQty(h.number) && isHash(h.hash) ? Number(h.number) : refuse("rpc_error", `index reader ${r + 1} answered no head`);
  }));
  const n = Math.min(heads[0]!, heads[1]!);
  if (Math.max(heads[0]!, heads[1]!) - n > c.margin) return refuse("rpc_disagree", `the index readers' heads ${heads[0]} and ${heads[1]} are more than ${c.margin} blocks apart`);
  // F6 (the review's): at the stored head the index stands as it was; below it the readers lag what it proved
  if (old !== null && n < old.through) return refuse("rpc_error", `the readers' head ${n} is below the index's ${old.through}`);
  const from = old?.from ?? Math.max(0, n - c.depth + 1);
  // never below what an earlier sync stored at its own, higher head (a reader that lags it is still at or above it)
  const stored = Math.max(old?.through ?? from - 1, n - c.margin);

  // the jobs: every gap of the stored spans to N, in spans of c.span blocks, newest first (the one ending at N first)
  const jobs: Job[] = [];
  for (const [a, b] of gapsOf(old?.spans ?? [], from, n).reverse()) for (let hi = b; hi >= a; hi -= c.span) jobs.push(jobOf(Math.max(a, hi - c.span + 1), hi));
  let proved: { a: number; b: number; pools: EvmIndexedPool[]; one: EvmIndexedPool[] }[] = [];
  let pin: string | null = null;
  // F6: the pools both readers report (one reader's alone count once F5 holds them, so one operator's made-up logs
  // never refuse the index as too many)
  let count = old?.pools.length ?? 0;
  let error: EvmQuoteError | null = null;
  // halves asked for spans answered with an error or at the log cap: each starting span's first split, and at most
  // INDEX_HALVES more, so a reader that answers every span with an error refuses rather than ask 2^14 halves a span
  let halves = 2 * jobs.length + INDEX_HALVES;

  const callsOf = (js: readonly Job[]) =>
    js.flatMap((j) => [
      { method: "eth_getLogs", params: [{ address: pm, fromBlock: hx(j.a), toBlock: hx(j.b), topics: [INITIALIZE] }] },
      { method: "eth_getBlockByNumber", params: [hx(j.b), false] },
    ]);
  // one reader's answer to a job: its logs and the job's last block, both from the same batch (F4a); `cut` where the
  // logs were answered with an error or at the cap, which no reader's words explain (M383); null where it gave neither
  const answerOf = (out: readonly unknown[], i: number, j: Job): Answer | null => {
    const l = out[2 * i] as { result?: unknown; error?: unknown } | null | undefined;
    if (l?.error !== undefined && l.result === undefined) return limited(l.error) ? null : NO_ANSWER;
    const logs = l?.result;
    const blk = (out[2 * i + 1] as { result?: { number?: unknown; hash?: unknown } | null } | null | undefined)?.result;
    if (!Array.isArray(logs) || !blk || !isHash(blk.hash) || !isQty(blk.number) || Number(blk.number) !== j.b) return null;
    const pools = new Map<string, EvmIndexedPool>();
    for (const x of logs) {
      const p = poolOfLog(x, pm, j.a, j.b);
      if (p === null) continue;
      // F2: one pool at two blocks in one answer is no answer an honest reader gives
      if (pools.has(p.id) && pools.get(p.id)!.block !== p.block) return refuse("rpc_disagree", `index reader answered pool ${p.id} at two blocks`);
      pools.set(p.id, p);
    }
    return { hash: blk.hash.toLowerCase(), pools, cut: logs.length >= INDEX_SPAN_LOGS ? "full" : null };
  };

  // a job both readers answered: asked again as its halves where either was cut; the same last block and every pool
  // both report at the same block on both (the pin at N), or asked again and then refused; else proven
  const settle = (j: Job): Job[] => {
    const [x, y] = j.ans as [Answer, Answer];
    if (x.cut !== null || y.cut !== null) {
      // a single block: both at the log cap is too many pools; an error there is a reader's, which no chain explains
      if (j.a === j.b) return x.cut === "full" && y.cut === "full" ? refuse("too_many_pools", `block ${j.b} holds ${INDEX_SPAN_LOGS} or more Initialize logs`) : refuse("rpc_disagree", `an index reader answered block ${j.b} with an error`);
      if ((halves -= 2) < 0) return refuse("rpc_error", "the index readers answered more spans with an error than any chain explains");
      const mid = j.a + Math.floor((j.b - j.a) / 2);
      return [jobOf(mid + 1, j.b), jobOf(j.a, mid)];
    }
    if (j.b === n && x.hash !== y.hash) return refuse("rpc_disagree", `the index readers do not agree on block ${n}`);
    const sameBlocks = [...x.pools].every(([id, p]) => !y.pools.has(id) || y.pools.get(id)!.block === p.block);
    if (x.hash !== y.hash || !sameBlocks) {
      j.ans = [null, null];
      if (++j.disagree >= INDEX_TRIES) return refuse("rpc_disagree", x.hash !== y.hash ? `the index readers do not agree on block ${j.b}` : `the index readers report a pool of blocks ${j.a}-${j.b} at two blocks`);
      return [j];
    }
    if (j.b === n) pin = x.hash;
    const both: EvmIndexedPool[] = [];
    const one: EvmIndexedPool[] = [];
    for (const [id, p] of x.pools) (y.pools.has(id) ? both : one).push(p);
    for (const [id, p] of y.pools) if (!x.pools.has(id)) one.push(p);
    count += both.length;
    if (count > c.cap) return refuse("too_many_pools", `chain ${c.chainId} has more than ${c.cap} pools, the index's cap`);
    proved.push({ a: j.a, b: j.b, pools: both, one });
    return [];
  };
  // one round of `js` on both readers (each asked only what it has not answered: its alone spans one a request, the
  // rest in one batch); the jobs to ask again
  const round = async (js: Job[]): Promise<Job[]> => {
    await Promise.all(([0, 1] as const).map(async (r) => {
      const want = js.filter((j) => j.ans[r] === null);
      const rest = want.filter((j) => !j.alone[r]);
      const groups = [...want.filter((j) => j.alone[r]).map((j) => [j]), ...(rest.length > 0 ? [rest] : [])];
      let missed = 0;
      await Promise.all(groups.map(async (g) => {
        const out = await ask(r, callsOf(g));
        // F5 (the review's): tries spent on throws (a body past its size, a 4xx, a timeout): each span alone, then a
        // span alone that still fails as its halves, under the halves' budget
        if (out === null) {
          for (const j of g) if (j.alone[r]) j.ans[r] = NO_ANSWER;
            else j.alone[r] = true;
          return;
        }
        g.forEach((j, i) => {
          const a = answerOf(out, i, j);
          if (a !== null) j.ans[r] = a;
          else if (++j.tries[r] >= INDEX_TRIES) throw new EvmQuoteError("rpc_error", `index reader ${r + 1} did not answer blocks ${j.a}-${j.b}`);
          else missed = Math.max(missed, j.tries[r]);
        });
      }));
      if (missed > 0) await nap(BACKOFF_MS * 2 ** missed);
    }));
    return js.flatMap((j) => (j.ans[0] !== null && j.ans[1] !== null ? settle(j) : [j]));
  };

  // F4c: the first round is the job ending at N alone, asked until it settles: nothing counts without its pin
  const queue = [...jobs];
  let at = queue.shift();
  while (at !== undefined && pin === null) {
    const again = await round([at]);
    at = again.find((j) => j.b === n);
    queue.unshift(...again.filter((j) => j !== at));
  }
  if (jobs.length > 0 && pin === null) return refuse("rpc_error", `the index readers' block ${n} was not pinned`);

  // every other job, perBatch a batch and `parallel` batches at once on each reader; the first failure stops them all
  let fatal: unknown = null;
  const worker = async () => {
    while (queue.length > 0 && error === null && fatal === null) {
      const js = queue.splice(0, c.perBatch);
      try {
        queue.unshift(...(await round(js)));
      } catch (e) {
        if (e instanceof EvmQuoteError && e.code === "rpc_error") error ??= e;
        else fatal ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: c.parallel }, worker));
  if (fatal !== null) throw fatal;

  // F2: a pool initializes once, so one id at two blocks or in two spans (or in a span and the stored index) is a lie
  const where = new Map<string, number>((old?.pools ?? []).map((p) => [p.id, p.block]));
  for (const p of proved.flatMap((q) => [...q.pools, ...q.one])) {
    if (where.has(p.id)) return refuse("rpc_disagree", `the index readers report pool ${p.id} at blocks ${where.get(p.id)} and ${p.block}`);
    where.set(p.id, p.block);
  }

  // F5: a pool one reader reported counts only where the PoolManager's state of it at N is the same non-zero word on
  // both readers; 0 on both is no pool; any other pair is a lie at one pinned hash. Where that is not answered, the
  // spans that hold such a pool are not proven
  const ones = proved.flatMap((p) => p.one);
  // more pools one reader alone reported than the cap: the readers disagree past any honest lag, and none is read
  if (ones.length > c.cap) return refuse("rpc_disagree", `the index readers disagree on ${ones.length} pools, more than the cap ${c.cap}`);
  const held = new Set<string>();
  if (ones.length > 0) {
    const calls = ones.map((p) => ({ method: "eth_call", params: [{ to: pm, data: "0x" + SEL_EXTSLOAD + stateSlot(p.id).slice(2) }, { blockHash: pin }] }));
    // INDEX_STATE_BATCH reads a batch, one batch at a time on each reader
    const outs = await Promise.all(([0, 1] as const).map(async (r) => {
      const all: unknown[] = [];
      for (let i = 0; i < calls.length; i += INDEX_STATE_BATCH) {
        const part = calls.slice(i, i + INDEX_STATE_BATCH);
        all.push(...((await ask(r, part)) ?? part.map(() => null)));
      }
      return all;
    }));
    const res = (o: readonly unknown[], i: number) => (o[i] as { result?: unknown } | null | undefined)?.result;
    const ok = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
    const unread = new Set<string>();
    ones.forEach((p, i) => {
      const [u, v] = [res(outs[0]!, i), res(outs[1]!, i)];
      if (!ok(u) || !ok(v)) unread.add(p.id);
      else if (BigInt(u) !== BigInt(v)) refuse("rpc_disagree", `the index readers answer the PoolManager's state of pool ${p.id} at block ${n} apart`);
      // slot0's low 160 bits are the price, never 0 once the pool is initialized
      else if (BigInt.asUintN(160, BigInt(u)) !== 0n) held.add(p.id);
    });
    if (unread.size > 0) {
      error ??= new EvmQuoteError("rpc_error", `the index readers did not answer the PoolManager's state of ${unread.size} pool(s)`);
      proved = proved.filter((p) => !p.one.some((o) => unread.has(o.id)));
    }
    // F4 (the review's): one reader's pools, held, past the cap with the rest: the readers disagree on what counts
    const kept = new Set(proved.flatMap((p) => p.one.map((o) => o.id)));
    if (count + [...held].filter((id) => kept.has(id)).length > c.cap) return refuse("rpc_disagree", `the pools one index reader alone reported take chain ${c.chainId} past the cap ${c.cap}`);
  }
  const fresh = proved.flatMap((q) => [...q.pools, ...q.one.filter((o) => held.has(o.id))]);
  // F4d: stored only to N less the margin: each proven span to that block, and every pool read in it with it
  let spans: Spans = (old?.spans ?? []).map(([a, b]) => [a, b] as [number, number]);
  for (const p of proved) if (p.a <= stored) spans = withSpan(spans, p.a, Math.min(p.b, stored));
  const index: EvmPoolIndexData = {
    v: 1,
    chainId: c.chainId,
    poolManager: pm,
    from,
    through: stored,
    // F6 (the review's): a sync that read nothing (N at the stored head) keeps the head it stood at
    head: pin !== null ? { number: n, hash: pin } : old!.head,
    spans,
    pools: [...(old?.pools ?? []), ...fresh.filter((p) => p.block <= stored)],
  };
  let read: Spans = spans;
  for (const p of proved) read = withSpan(read, p.a, p.b);
  const whole = error === null && gapsOf(read, from, n).length === 0;
  return done({ index, coversThrough: whole ? n : null, pools: whole ? [...(old?.pools ?? []), ...fresh] : null, error });
}
