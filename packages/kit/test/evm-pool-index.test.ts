// The device's index of every v4 pool (src/checks/evm/pool-index.ts, card evm-pool-index): F4a-F4d, F5 and F6, each a
// test that test/evm-pool-index-mutants.mjs fails by removing its rule. Two readers answer from one model chain, each
// with its own faults.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmPoolIdOf, evmPoolIndexSync, type EvmPoolIndexConfig, type EvmPoolIndexData } from "../src/checks/evm/pool-index.ts";
import { EvmQuoteError, evmJsonRpc, type EvmPoolKey, type EvmRpc, type EvmRpcCall } from "../src/checks/evm/quote.ts";
import * as poolIndex from "../src/checks/evm/pool-index.ts";
import { evmPaceReset, evmProviderHold } from "../src/checks/evm/pace.ts";
// read off the module, so this file still loads (and each test fails on its own) on a build without it
const INDEX_LIMITED_WAIT_MS = (poolIndex as { INDEX_LIMITED_WAIT_MS?: number }).INDEX_LIMITED_WAIT_MS;
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const PM = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const w = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, "0");
const hx = (n: number) => "0x" + n.toString(16);
const blockHash = (n: number, fork = "") => "0x" + bytesToHex(keccak_256(new TextEncoder().encode(`block ${n}${fork}`)));
const key = (i: number, hooks = "0x0000000000000000000000000000000000000000"): EvmPoolKey => ({
  currency0: "0x" + (i + 1).toString(16).padStart(40, "0"),
  currency1: "0x4200000000000000000000000000000000000006",
  fee: 3000,
  tickSpacing: 60,
  hooks,
});
type Pool = { key: EvmPoolKey; block: number; id?: string };
/** A pool's Initialize transaction: one hash per pool, wherever a reader logs it. */
const txOf = (p: Pool) => "0x" + bytesToHex(keccak_256(new TextEncoder().encode(`tx ${evmPoolIdOf(p.key)}`)));
const logOf = (p: Pool) => ({
  address: PM,
  blockNumber: hx(p.block),
  blockHash: blockHash(p.block),
  transactionHash: txOf(p),
  topics: [INIT, p.id ?? evmPoolIdOf(p.key), "0x" + w(BigInt(p.key.currency0)), "0x" + w(BigInt(p.key.currency1))],
  data: "0x" + w(BigInt(p.key.fee)) + w(BigInt(p.key.tickSpacing)) + w(BigInt(p.key.hooks)) + w(79228162514264337593543950336n) + w(0n),
});
// the slot is a pure function of the id, read for every held pool on every state call: hashed once per id (card
// ci-fresh-run-ends-with-room; S1's 2,000 pools hashed 2,000 x 2,000 times)
const slots = new Map<string, string>();
const slotOf = (id: string) => {
  let s = slots.get(id);
  if (s === undefined) slots.set(id, (s = "0x" + bytesToHex(keccak_256(hexToBytes(id.slice(2) + w(6n))))));
  return s;
};

type Reader = {
  head: number;
  pools: Pool[];
  /** this reader's block hash */
  hash?: (n: number) => string;
  /** a span's last block answered null this many times, or always (Infinity) */
  noBlock?: { b: number; times: number };
  /** the batch requests that throw (counted from 1) */
  throws?: Set<number>;
  /** requests answered 429 first */
  limited?: number;
  /** pools the state holds (extsload), by id; default: every pool of `pools` up to the block */
  state?: Set<string>;
  /** a getLogs over more than this many blocks is answered with an error */
  maxRange?: number;
  /** getLogs answered -32602 "block range exceeds maximum 500" at these places (counted from 1), as one of
   *  base.api.pocket.network's backends answers about one 10,000-block span in ten (2026-11-18) */
  rangeErrorsAt?: Set<number>;
  /** getLogs answered with a rate-limit error inside a 200, this many first */
  limitedInBody?: number;
  /** the 429s' Retry-After, in ms (default 1) */
  limitedAfterMs?: number;
  /** a batch of more than this many calls throws (a body past its size) */
  throwsOverCalls?: number;
  /** a batch with a getLogs over more than this many blocks throws (a timeout) */
  throwsOverRange?: number;
  /** a batch of more than this many getLogs runs out of its time, as evmJsonRpc's AbortSignal.timeout throws */
  timeoutOverLogs?: number;
  /** a block whose hash this reader answers as another fork's, this many times */
  forkAt?: { b: number; times: number };
  /** the state reads answered with an error */
  stateError?: boolean;
  /** more logs this reader answers to every getLogs */
  extraLogs?: unknown[];
  /** every Initialize log of the range, its filter's topics ignored */
  ignoresTopics?: boolean;
  /** a getLogs with a topic position of more than one value over more than this many blocks is answered -32602, as
   *  rpc.mainnet.chain.robinhood.com answers one over 100,000 (2026-11-21) */
  orMaxRange?: number;
  /** the receipts answered with an error */
  receiptError?: boolean;
  /** pools this reader's receipts read, where they are not its logs' (default: `pools`) */
  receipts?: Pool[];
  /** the state of only the newest this many blocks: a state read by the hash of an older block is answered -32000
   *  "historical state ... is not available" (Pocket and publicnode on Robinhood, 2026-11-10) */
  keeps?: number;
  /** blocks the head moves on once, after this reader's first getLogs answer (the chain going on during a sync) */
  moves?: number;
  calls: EvmRpcCall[][];
};
function reader(r: Reader): EvmRpc {
  let req = 0;
  let logsAsked = 0;
  return async (calls) => {
    req++;
    r.calls.push([...calls]);
    if (r.limited !== undefined && r.limited > 0) {
      r.limited--;
      throw Object.assign(new Error("the provider answered 429 Too Many Requests"), { afterMs: r.limitedAfterMs ?? 1 });
    }
    if (r.throws?.has(req)) throw new Error("the provider answered HTTP 502");
    if (r.throwsOverCalls !== undefined && calls.length > r.throwsOverCalls) throw new Error("the answer is too long");
    if (r.timeoutOverLogs !== undefined && calls.filter((c) => c.method === "eth_getLogs").length > r.timeoutOverLogs) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (r.throwsOverRange !== undefined && calls.some((c) => c.method === "eth_getLogs" && Number((c.params[0] as { toBlock: string }).toBlock) - Number((c.params[0] as { fromBlock: string }).fromBlock) + 1 > r.throwsOverRange!)) throw new Error("The operation was aborted due to timeout");
    const h = r.hash ?? ((n: number) => blockHash(n));
    return calls.map((c) => {
      if (c.method === "eth_getBlockByNumber") {
        const n = c.params[0] === "latest" ? r.head : Number(c.params[0]);
        if (n > r.head) return { result: null };
        if (r.noBlock !== undefined && r.noBlock.b === n && r.noBlock.times > 0) {
          r.noBlock.times--;
          return { result: null };
        }
        if (r.forkAt !== undefined && r.forkAt.b === n && r.forkAt.times > 0) {
          r.forkAt.times--;
          return { result: { number: hx(n), hash: blockHash(n, "fork") } };
        }
        return { result: { number: hx(n), hash: h(n) } };
      }
      if (c.method === "eth_getLogs") {
        const f = c.params[0] as { fromBlock: string; toBlock: string };
        const [a, b] = [Number(f.fromBlock), Number(f.toBlock)];
        if (r.maxRange !== undefined && b - a + 1 > r.maxRange) return { error: { code: -32602, message: "nope" } };
        logsAsked++;
        if (r.rangeErrorsAt?.has(logsAsked) && b - a + 1 > 500) return { error: { code: -32602, message: "invalid argument 0: block range exceeds maximum 500" } };
        if (r.limitedInBody !== undefined && r.limitedInBody > 0) {
          r.limitedInBody--;
          return { error: { code: -32005, message: "25/second request limit reached" } };
        }
        // the filter's topics, as a node applies them: null any, a word that word, a list any of it
        const ts = (r.ignoresTopics ? [] : ((c.params[0] as { topics?: unknown[] }).topics ?? [])) as (string | string[] | null)[];
        if (r.orMaxRange !== undefined && ts.some(Array.isArray) && b - a + 1 > r.orMaxRange) return { error: { code: -32602, message: `query spans ${b - a + 1} blocks, but only ${r.orMaxRange} are allowed for this request; narrow the block range, or send one value per topic position` } };
        const fits = (l: { topics: string[] }) => ts.every((x, k) => x === null || (Array.isArray(x) ? x.includes(l.topics[k]!) : x === l.topics[k]));
        const out = { result: [...r.pools.filter((p) => p.block >= a && p.block <= b && p.block <= r.head).map(logOf).filter(fits), ...(r.extraLogs ?? [])] };
        if (r.moves !== undefined) (r.head += r.moves), delete r.moves;
        return out;
      }
      if (c.method === "eth_getTransactionReceipt") {
        if (r.receiptError) return { error: { code: -32000, message: "header not found" } };
        const p = (r.receipts ?? r.pools).find((q) => txOf(q) === c.params[0]);
        return { result: p === undefined ? null : { blockNumber: hx(p.block), blockHash: blockHash(p.block), status: "0x1", logs: [logOf(p)] } };
      }
      if (c.method === "eth_call") {
        if (r.stateError) return { error: { code: -32000, message: "missing trie node" } };
        const at = (c.params[1] as { blockHash?: string } | undefined)?.blockHash;
        if (r.keeps !== undefined && at !== undefined) {
          let n = r.head;
          while (n > r.head - 10_000 && h(n) !== at) n--;
          if (r.head - n >= r.keeps) return { error: { code: -32000, message: `historical state ${at.slice(2)} is not available` } };
        }
        const data = (c.params[0] as { data: string }).data;
        const held = r.state ?? new Set(r.pools.map((p) => evmPoolIdOf(p.key)));
        const hit = [...held].some((id) => "0x1e2eaeaf" + slotOf(id).slice(2) === data);
        return { result: "0x" + w(hit ? 79228162514264337593543950336n : 0n) };
      }
      return { error: { message: "unknown method" } };
    });
  };
}
const cfgOf = (a: Reader, b: Reader, more: Partial<EvmPoolIndexConfig> = {}): EvmPoolIndexConfig => ({
  chainId: 8453,
  poolManager: PM,
  readers: [reader(a), reader(b)],
  depth: 100_000,
  span: 10_000,
  margin: 474,
  cap: 1000,
  perBatch: 3,
  parallel: 2,
  nap: async () => {},
  ...more,
});
const pools = (n: number, head: number) => Array.from({ length: n }, (_, i) => ({ key: key(i), block: head - 600 - i * 9_000 }));
const ids = (ps: readonly { id: string }[] | null) => new Set((ps ?? []).map((p) => p.id));

test("a cold sync of two honest readers covers the depth to the head, newest span first", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  const a: Reader = { head, pools: ps, calls: [] };
  const b: Reader = { head, pools: ps, calls: [] };
  const r = await evmPoolIndexSync(null, cfgOf(a, b));
  assert.equal(r.coversThrough, head);
  assert.equal(r.error, null);
  assert.deepEqual(ids(r.pools), new Set(ps.map((p) => evmPoolIdOf(p.key))));
  assert.equal(r.index!.from, head - 100_000 + 1);
  assert.deepEqual(r.index!.spans, [[head - 100_000 + 1, head - 474]]);
  // the newest first: the first getLogs request ends at the head
  const firstLogs = a.calls.find((cs) => cs.some((c) => c.method === "eth_getLogs"))!;
  assert.equal((firstLogs[0]!.params[0] as { toBlock: string }).toBlock, hx(head));
  // plain data: JSON gives it back whole
  assert.deepEqual(JSON.parse(JSON.stringify(r.index)), r.index);
});

test("F4a: a span counts only when both readers answered it, each with its last block in the same batch", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  const spanEnd = head - 30_000; // a span's last block, not the head's
  // the second reader answers that span's last block null once: the span is asked of it again and counts
  const once = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [], noBlock: { b: spanEnd, times: 1 } }));
  assert.equal(once.coversThrough, head);
  assert.deepEqual(ids(once.pools), new Set(ps.map((p) => evmPoolIdOf(p.key))));
  // always null: the span never counts, the sync proves the rest and serves nothing
  const never = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [], noBlock: { b: spanEnd, times: Infinity } }));
  assert.equal(never.coversThrough, null);
  assert.equal(never.pools, null);
  assert.equal(never.error?.code, "rpc_error");
  assert.ok(never.index!.spans.every(([x, y]) => spanEnd < x || spanEnd > y), JSON.stringify(never.index!.spans));
  // a request that fails in transport is asked again
  const thrown = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [], throws: new Set([3]) }, { head, pools: ps, calls: [] }));
  assert.equal(thrown.coversThrough, head);
  assert.equal(thrown.stats.failed[0], 1);
});

test("F4b: the index head is the lower of the two proven heads", async () => {
  const ps = [{ key: key(1), block: 999_000 }, { key: key(2), block: 1_000_005 }];
  const r = await evmPoolIndexSync(null, cfgOf({ head: 1_000_000, pools: ps, calls: [] }, { head: 1_000_010, pools: ps, calls: [] }));
  assert.equal(r.coversThrough, 1_000_000);
  assert.equal(r.index!.head.number, 1_000_000);
  assert.equal(r.index!.head.hash, blockHash(1_000_000));
  assert.deepEqual(ids(r.pools), new Set([evmPoolIdOf(key(1))]));
});

test("F4c: the gap read ends at the agreed block, pinned by hash on both, in the first read round", async () => {
  const head = 1_000_000;
  const ps = pools(3, head);
  const a: Reader = { head, pools: ps, calls: [] };
  const b: Reader = { head, pools: ps, calls: [] };
  await evmPoolIndexSync(null, cfgOf(a, b));
  for (const r of [a, b]) {
    // round 0 the head; round 1 the span ending at N alone, with block N in the same batch
    const first = r.calls[1]!;
    assert.equal(first.length, 2);
    assert.equal((first[0]!.params[0] as { toBlock: string }).toBlock, hx(head));
    assert.deepEqual(first[1], { method: "eth_getBlockByNumber", params: [hx(head), false] });
  }
  // the readers' block N differs: the sync refuses and nothing is kept
  const fork = (n: number) => (n === head ? blockHash(n, "fork") : blockHash(n));
  const fb: Reader = { head, pools: ps, calls: [], hash: fork };
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, fb)), (e: Error & { code?: string }) => e.code === "rpc_disagree" && /block 1000000/.test(e.message));
  // refused in the first read round: the pin is never asked again
  assert.equal(fb.calls.flat().filter((c) => c.method === "eth_getLogs").length, 1);
});

test("F4d: stored only up to the reorg margin below the head, and the margin is read again with every gap", async () => {
  const head = 1_000_000;
  const inMargin = { key: key(7), block: head - 100 };
  const ps = [...pools(3, head), inMargin];
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [] }));
  assert.equal(r.index!.through, head - 474);
  assert.ok(ids(r.pools).has(evmPoolIdOf(inMargin.key)));
  assert.ok(!ids(r.index!.pools).has(evmPoolIdOf(inMargin.key)));
  // a reorg moves the margin's pool to another key: the next sync reads the margin again and has the new one only
  const moved = { key: key(8), block: head - 100 };
  const ps2 = [...pools(3, head), moved];
  const a: Reader = { head: head + 50, pools: ps2, calls: [] };
  const r2 = await evmPoolIndexSync(JSON.parse(JSON.stringify(r.index)) as EvmPoolIndexData, cfgOf(a, { head: head + 50, pools: ps2, calls: [] }));
  assert.equal(r2.coversThrough, head + 50);
  assert.ok(ids(r2.pools).has(evmPoolIdOf(moved.key)));
  assert.ok(!ids(r2.pools).has(evmPoolIdOf(inMargin.key)));
  const logs = a.calls.flat().filter((c) => c.method === "eth_getLogs").map((c) => c.params[0] as { fromBlock: string; toBlock: string });
  assert.deepEqual(logs, [{ address: PM, fromBlock: hx(head - 473), toBlock: hx(head + 50), topics: [INIT] }]);
});

test("F5: a pool only one reader reported is kept only if the PoolManager holds it at the agreed block on both", async () => {
  const head = 1_000_000;
  const real = { key: key(1), block: head - 5_000 };
  const fake = { key: key(2), block: head - 6_000 };
  const both = { key: key(3), block: head - 7_000 };
  const state = new Set([real, both].map((p) => evmPoolIdOf(p.key)));
  // a log both report whose id word is not its key's is no pool
  const wrongId = { key: key(4), block: head - 8_000, id: "0x" + "ab".repeat(32) };
  const a: Reader = { head, pools: [real, fake, both, wrongId], state, calls: [] };
  // b's logs miss `real` (a log gap), but its chain holds real's transaction
  const b: Reader = { head, pools: [both, wrongId], receipts: [real, both], state, calls: [] };
  const r = await evmPoolIndexSync(null, cfgOf(a, b));
  assert.equal(r.coversThrough, head);
  assert.deepEqual(ids(r.pools), new Set([evmPoolIdOf(real.key), evmPoolIdOf(both.key)]));
  // the state read: the recomputed id's slot, at N's hash, on both readers
  for (const x of [a, b]) {
    const call = x.calls.flat().filter((c) => c.method === "eth_call");
    assert.equal(call.length, 2);
    assert.deepEqual(call[0]!.params[1], { blockHash: blockHash(head) });
    assert.equal((call[0]!.params[0] as { data: string }).data, "0x1e2eaeaf" + slotOf(evmPoolIdOf(real.key)).slice(2));
  }
  // one reader alone saying it holds the pool is a lie at one pinned hash: the sync refuses and serves nothing (no
  // coversThrough at all)
  const halfState = await evmPoolIndexSync(null, cfgOf({ head, pools: [real], state, calls: [] }, { head, pools: [], state: new Set(), calls: [] })).catch((e: unknown) => e);
  assert.ok(halfState instanceof EvmQuoteError && halfState.code === "rpc_disagree", String(halfState));
  assert.equal((halfState as { coversThrough?: unknown }).coversThrough, undefined);
});

test("F6: past the hard pool cap the index refuses by name and never serves a partial index", async () => {
  const head = 1_000_000;
  const ps = pools(6, head);
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [] }, { cap: 5 })), (e: Error & { code?: string }) => e.code === "too_many_pools" && /more than 5 pools/.test(e.message));
  const atCap = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [] }, { cap: 6 }));
  assert.equal(atCap.pools!.length, 6);
  // pools one reader alone reported, held, that take it past the cap: the readers disagree on what counts
  const state = new Set(ps.map((p) => evmPoolIdOf(p.key)));
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: ps, state, calls: [] }, { head, pools: ps.slice(0, 4), receipts: ps, state, calls: [] }, { cap: 5 })), (e: Error & { code?: string }) => e.code === "rpc_disagree" && /past the cap 5/.test(e.message));
});

test("a span answered with an error is asked as its halves on both, and a 429 waits without spending a try", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [], maxRange: 5_000, limited: 2 }, { head, pools: ps, calls: [] }));
  assert.equal(r.coversThrough, head);
  assert.deepEqual(ids(r.pools), new Set(ps.map((p) => evmPoolIdOf(p.key))));
  assert.equal(r.stats.limited[0], 2);
  // a reader that answers every span with an error refuses rather than ask halves without end
  // a reader that answers even one block with an error: rpc_disagree at that block, never too_many_pools
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [], maxRange: 0 }, { head, pools: ps, calls: [] })), (e: Error & { code?: string }) => e.code === "rpc_disagree" && /with an error/.test(e.message));
});

test("IDXERR a span one reader's backend answers with an error is asked of it again at once, never as halves on both (card evm-first-quote-inside-the-kpi)", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  // four of the flaky reader's getLogs, the pin's (the first) among them, two of them in a row
  const a: Reader = { head, pools: ps, calls: [], rangeErrorsAt: new Set([1, 4, 7, 8]) };
  const b: Reader = { head, pools: ps, calls: [] };
  const naps: number[] = [];
  const r = await evmPoolIndexSync(null, { ...cfgOf(a, b), nap: async (ms: number) => void naps.push(ms) });
  assert.equal(r.coversThrough, head);
  assert.deepEqual(ids(r.pools), new Set(ps.map((p) => evmPoolIdOf(p.key))));
  const spans = (x: Reader) => x.calls.flat().filter((c) => c.method === "eth_getLogs").map((c) => c.params[0] as { fromBlock: string; toBlock: string });
  assert.ok([...spans(a), ...spans(b)].every((f) => Number(f.toBlock) - Number(f.fromBlock) + 1 === 10_000), "a span asked as halves");
  assert.equal(spans(b).length, 10, "the reader that answered every span was asked one again");
  assert.equal(spans(a).length, 14, "each error asked again once");
  assert.deepEqual(naps, [], "an error's span waited before it was asked again");
});

test("a rate limit answered inside a batch is asked again, never as halves", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  const a: Reader = { head, pools: ps, calls: [], limitedInBody: 2 };
  // card mutants-killed-on-main (the index sweep's mutant 31): the limited span waits the backoff before it is asked
  // again, as a limit is, never at once, as a reader's error is (above: an error's span waits nothing)
  const naps: number[] = [];
  const r = await evmPoolIndexSync(null, cfgOf(a, { head, pools: ps, calls: [] }, { nap: async (ms) => void naps.push(ms) }));
  assert.equal(r.coversThrough, head);
  const spans = a.calls.flat().filter((c) => c.method === "eth_getLogs").map((c) => c.params[0] as { fromBlock: string; toBlock: string });
  assert.ok(spans.every((f) => Number(f.toBlock) - Number(f.fromBlock) + 1 === 10_000), "no span asked as halves");
  assert.deepEqual(naps, [1_000, 2_000], "each limited answer waited the backoff before the span was asked again");
});

test("a sync whose readers lag the last sync's head keeps what that sync stored", async () => {
  const head = 1_000_000;
  const ps = pools(5, head);
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [] }));
  const lag = head - 200; // above the stored head - 474, below the head
  const r2 = await evmPoolIndexSync(r.index, cfgOf({ head: lag, pools: ps, calls: [] }, { head: lag, pools: ps, calls: [] }));
  assert.equal(r2.coversThrough, lag);
  assert.equal(r2.index!.through, r.index!.through);
  assert.ok(r2.index!.spans.every(([, y]) => y <= r2.index!.through));
});

test("one reader's made-up pools never refuse the index as too many: only pools both report or the state holds count", async () => {
  const head = 1_000_000;
  const ps = pools(5, head);
  const fakes = Array.from({ length: 18 }, (_, i) => ({ key: key(100 + i), block: head - 1_000 - i }));
  const state = new Set(ps.map((p) => evmPoolIdOf(p.key)));
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: [...ps, ...fakes], state, calls: [] }, { head, pools: ps, state, calls: [] }, { cap: 20 }));
  assert.equal(r.coversThrough, head);
  assert.deepEqual(ids(r.pools), new Set(ps.map((p) => evmPoolIdOf(p.key))));
  // past the cap of them, the readers disagree by name
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: [...ps, ...fakes], state, calls: [] }, { head, pools: ps, state, calls: [] }, { cap: 10 })), (e: Error & { code?: string }) => e.code === "rpc_disagree");
});

// The money review of 44002c66 (P1-P5 its probes; F1-F8 its rulings): one lying reader may make the index refuse, never
// hide a pool, never claim a block it did not prove.
const real = { key: key(1), block: 1_000_000 - 5_000 }; // in the head span, below the margin
const deep = { key: key(2), block: 1_000_000 - 55_000 }; // a deep span
const both2 = new Set([real, deep].map((p) => evmPoolIdOf(p.key)));
const code = (c: string, re?: RegExp) => (e: Error & { code?: string }) => e.code === c && (re === undefined || re.test(e.message));

test("P1: a reader that omits a pool and answers its state 0 makes the sync refuse, never serve it hidden", async () => {
  const head = 1_000_000;
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: [real, deep], state: both2, calls: [] }, { head, pools: [deep], state: new Set([evmPoolIdOf(deep.key)]), calls: [] })), code("rpc_disagree", /state of pool/));
});

test("P2: both readers report a pool, one at another block of the span: asked again, then refused", async () => {
  const head = 1_000_000;
  const lie = { key: real.key, block: head - 100 };
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: [lie, deep], state: both2, calls: [] }, { head, pools: [real, deep], state: both2, calls: [] })), code("rpc_disagree", /at two blocks/));
});

test("P3: a reader that moves a deep pool into the margin (omitting it from its span) makes the sync refuse", async () => {
  const head = 1_000_000;
  const lie = { key: deep.key, block: head - 100 };
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: [real, deep], state: both2, calls: [] }, { head, pools: [real, lie], state: both2, calls: [] })), code("rpc_disagree", /at blocks/));
  // the same pool already in the stored index, reported again in the margin: refused too
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: [real, deep], state: both2, calls: [] }, { head, pools: [real, deep], state: both2, calls: [] }));
  await assert.rejects(evmPoolIndexSync(r.index, cfgOf({ head: head + 50, pools: [real, deep], state: both2, calls: [] }, { head: head + 50, pools: [real, deep, { key: deep.key, block: head + 10 }], state: both2, calls: [] })), code("rpc_disagree", /at blocks/));
});

test("P4: heads more than the margin apart refuse before the index's first block is set", async () => {
  const head = 1_000_000;
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head: 300_000, pools: [], calls: [] }, { head, pools: [real, deep], state: both2, calls: [] })), code("rpc_disagree", /more than 474 blocks apart/));
  const r = await evmPoolIndexSync(null, cfgOf({ head: head - 474, pools: [real, deep], state: both2, calls: [] }, { head, pools: [real, deep], state: both2, calls: [] }));
  assert.equal(r.coversThrough, head - 474);
});

test("P5: a sync at the stored head keeps the head it stood at, and one below it refuses", async () => {
  const head = 1_000_000;
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: [real], state: both2, calls: [] }, { head, pools: [real], state: both2, calls: [] }));
  const t = r.index!.through;
  const a: Reader = { head: t, pools: [real], state: both2, calls: [] };
  const r2 = await evmPoolIndexSync(r.index, cfgOf(a, { head: t, pools: [real], state: both2, calls: [] }));
  assert.deepEqual(r2.index!.head, r.index!.head);
  assert.equal(r2.coversThrough, t);
  assert.equal(a.calls.flat().filter((c) => c.method === "eth_getLogs").length, 0);
  await assert.rejects(evmPoolIndexSync(r.index, cfgOf({ head: t - 1, pools: [real], calls: [] }, { head: t - 1, pools: [real], calls: [] })), code("rpc_error", /below the index's/));
});

test("a batch whose tries are spent on throws is asked one span a request, then as halves", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  // a batch of more than one span is past its size: each span alone answers
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [], throwsOverCalls: 2 }, { head, pools: ps, calls: [] }));
  assert.equal(r.coversThrough, head);
  assert.deepEqual(ids(r.pools), new Set(ps.map((p) => evmPoolIdOf(p.key))));
  // a span alone still times out: its halves answer
  const h = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [], throwsOverRange: 5_000 }, { head, pools: ps, calls: [] }));
  assert.equal(h.coversThrough, head);
  assert.deepEqual(ids(h.pools), new Set(ps.map((p) => evmPoolIdOf(p.key))));
});

test("a batch waits on 429s at most INDEX_LIMITED_WAIT_MS, then each 429 spends a try", async () => {
  const head = 1_000_000;
  const ps = pools(3, head);
  let slept = 0;
  const nap = async (ms: number) => void (slept += ms);
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [], limited: 6, limitedAfterMs: 25_000 }, { head, pools: ps, calls: [] }, { nap }));
  assert.equal(r.coversThrough, head);
  // 25 + 25 + 10 s waited, then the three 429s left each spend a try
  assert.equal(r.stats.failed[0], 3);
  assert.ok(INDEX_LIMITED_WAIT_MS !== undefined && INDEX_LIMITED_WAIT_MS > 0);
  assert.equal(r.stats.limitedMaxMs?.[0], INDEX_LIMITED_WAIT_MS);
  assert.ok(slept < 6 * 25_000, `slept ${slept} ms`);
});

test("a span's last block on another fork on one reader is asked again, and refused when it stays", async () => {
  const head = 1_000_000;
  const ps = pools(5, head);
  const b = head - 20_000;
  const once = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [], forkAt: { b, times: 1 } }));
  assert.equal(once.coversThrough, head);
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [], forkAt: { b, times: Infinity } })), code("rpc_disagree", new RegExp(`do not agree on block ${b}$`)));
});

test("a pool whose state is not answered leaves its span unproven, the sync partial", async () => {
  const head = 1_000_000;
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: [real, deep], state: both2, calls: [], stateError: true }, { head, pools: [deep], state: both2, calls: [] }));
  assert.equal(r.coversThrough, null);
  assert.equal(r.error?.code, "rpc_error");
  assert.ok(r.index!.spans.every(([x, y]) => real.block < x || real.block > y), JSON.stringify(r.index!.spans));
  assert.ok(r.index!.spans.some(([x, y]) => deep.block >= x && deep.block <= y));
});

test("a log of another block range, another address, removed or of another event is no pool", async () => {
  const head = 1_000_000;
  const x = { key: key(50), block: head - 30_000 };
  const lg = logOf(x);
  for (const [what, bad] of [
    ["another block range", { ...lg, blockNumber: hx(head - 200_000) }],
    ["another address", { ...lg, address: "0x" + "12".repeat(20) }],
    ["removed", { ...lg, removed: true }],
    ["another event", { ...lg, topics: ["0x" + "34".repeat(32), ...lg.topics.slice(1)] }],
    // a log naming no transaction or no block hash: its receipt cannot be asked (review 2 of 1fb6b198)
    ["no transaction hash", { ...lg, transactionHash: undefined }],
    ["no block hash", { ...lg, blockHash: null }],
  ] as const) {
    // x's state is set on both, so a log taken as x's pool would keep it
    const st = new Set([...both2, evmPoolIdOf(x.key)]);
    const r = await evmPoolIndexSync(null, cfgOf({ head, pools: [real], state: st, calls: [], extraLogs: [bad] }, { head, pools: [real], state: st, calls: [], extraLogs: [bad] }));
    assert.equal(r.coversThrough, head, what);
    assert.ok(!ids(r.pools).has(evmPoolIdOf(x.key)), what);
  }
});

test("the halves' budget spent ends the sync rpc_error, partial", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [], maxRange: 625 }, { head, pools: ps, calls: [] }));
  assert.equal(r.coversThrough, null);
  assert.equal(r.error?.code, "rpc_error");
  assert.match(r.error!.message, /more spans with an error than any chain explains/);
});

// The delta review of 1fb6b198 (Q1-Q3 its probes): a 429 with no wait, and a one-reader pool's block, which the state
// read never proves.
test("Q1: a 429 whose Retry-After is 0 or a past date waits at least the backoff, so the batch's wait bound ends it", async () => {
  const head = 1_000_000;
  const ps = pools(3, head);
  for (const retry of ["0", new Date(Date.now() - 60_000).toUTCString()]) {
    let asked = 0;
    const res429 = (async () => (asked++, new Response("", { status: 429, headers: { "retry-after": retry } }))) as unknown as typeof fetch;
    const cfg = cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [] });
    let slept = 0;
    const out = await evmPoolIndexSync(null, { ...cfg, readers: [evmJsonRpc("https://reader-a.example", res429), cfg.readers[1]], nap: async (ms) => void (slept += ms) }).catch((e: unknown) => e);
    // the head read alone: the 429s wait up to INDEX_LIMITED_WAIT_MS, then spend INDEX_TRIES tries, and the sync refuses
    assert.ok(out instanceof EvmQuoteError && out.code === "rpc_error", `${retry}: ${String(out)}`);
    assert.ok(asked < 20, `${retry}: ${asked} requests`);
    assert.ok(slept >= INDEX_LIMITED_WAIT_MS!, `${retry}: slept ${slept} ms`);
  }
  // card mutants-killed-on-main (the index sweep's mutant 37): a reader the pace holds nothing for (any EvmRpc of the
  // caller's, not evmJsonRpc's, whose 429 holds its provider) that names no wait still waits at least the backoff, each
  // 429 double the last, never asks again at once
  const naps: number[] = [];
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [], limited: 3, limitedAfterMs: 0 }, { head, pools: ps, calls: [] }, { nap: async (ms) => void naps.push(ms) }));
  assert.equal(r.coversThrough, head);
  assert.deepEqual(naps.slice(0, 3), [500, 1_000, 2_000], `naps ${naps.join(", ")}`);
});

// card evm-taps-meet-no-429: a throttle or a refused connection any reader meets holds the provider for every reader
// (pace.ts); the index, which has no other reader to ask, waits the hold out and sends it nothing meanwhile (Robinhood's
// own refused the index's getLogs at 1 to 3 posts a minute, 2026-11-15 08:13-08:48Z)
test("H1: a reader held by another reader's throttle is sent nothing until the hold ends, then the sync completes", async () => {
  const head = 1_000_000;
  const ps = pools(3, head);
  const a: Reader = { head, pools: ps, calls: [] };
  const b: Reader = { head, pools: ps, calls: [] };
  const inner = reader(a);
  const url = "https://held-reader.example";
  const viaFetch = (async (_u: string, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
    const out = await inner(sent.map((c) => ({ method: c.method, params: c.params })));
    return new Response(JSON.stringify(out.map((o, id) => ({ jsonrpc: "2.0", id, ...(o as object) }))), { status: 200 });
  }) as unknown as typeof fetch;
  evmPaceReset();
  evmProviderHold(url, 30_000);
  const naps: number[] = [];
  let sentAtFirstNap = -1;
  const r = await evmPoolIndexSync(null, cfgOf(a, b, {
    readers: [evmJsonRpc(url, viaFetch), reader(b)],
    // the hold ends while the index waits (its nap): a sync that had sent before it holds a.calls already
    nap: async (ms) => {
      if (naps.push(ms) === 1) sentAtFirstNap = a.calls.length;
      evmPaceReset();
    },
  }));
  evmPaceReset();
  assert.equal(sentAtFirstNap, 0, "nothing is sent to the held reader before its hold ends");
  assert.ok(naps[0]! > 29_000 && naps[0]! <= 30_000, `the wait is the hold's: ${naps[0]} ms`);
  assert.equal(r.error, null);
  assert.equal(r.coversThrough, head);
});

test("Q3: a pool one reader logs inside the depth whose transaction's receipt on the other is another block refuses", async () => {
  const head = 1_000_000;
  const q = { key: key(9), block: 800_000 }; // real, below from = 900,001
  const moved = { key: q.key, block: 950_000 };
  const state = new Set([real, q].map((p) => evmPoolIdOf(p.key)));
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: [real, q], state, calls: [] }, { head, pools: [real, moved], state, calls: [] })), code("rpc_disagree", /receipt of pool/));
  // a transaction the other reader has no receipt of (null on every try, review 3: an honest reader's null too): never
  // stored or served, its span unproven, the sync partial; the next sync of two honest readers goes on without it
  const made = { key: key(10), block: 950_000 };
  const st2 = new Set([real, made].map((p) => evmPoolIdOf(p.key)));
  const mk = await evmPoolIndexSync(null, cfgOf({ head, pools: [real], receipts: [real], state: st2, calls: [] }, { head, pools: [real, made], state: st2, calls: [] }));
  assert.equal(mk.coversThrough, null);
  assert.equal(mk.pools, null);
  assert.equal(mk.error?.code, "rpc_error");
  assert.ok(!mk.index!.pools.some((p) => p.id === evmPoolIdOf(made.key)));
  assert.ok(!mk.index!.spans.some(([a, b]) => a <= made.block && made.block <= b), JSON.stringify(mk.index!.spans));
  const next = await evmPoolIndexSync(mk.index, cfgOf({ head: head + 5, pools: [real], state: st2, calls: [] }, { head: head + 5, pools: [real], state: st2, calls: [] }));
  assert.equal(next.coversThrough, head + 5);
  assert.ok(!ids(next.pools).has(evmPoolIdOf(made.key)));
  // an honest log gap (the other reader's receipt agrees) is kept, at its block
  const gap = { key: key(11), block: 950_000 };
  const st3 = new Set([real, gap].map((p) => evmPoolIdOf(p.key)));
  const a: Reader = { head, pools: [real], receipts: [real, gap], state: st3, calls: [] };
  const r = await evmPoolIndexSync(null, cfgOf(a, { head, pools: [real, gap], state: st3, calls: [] }));
  assert.equal(r.coversThrough, head);
  assert.equal(r.pools!.find((p) => p.id === evmPoolIdOf(gap.key))?.block, 950_000);
  assert.deepEqual(a.calls.flat().filter((c) => c.method === "eth_getTransactionReceipt").map((c) => c.params), [[txOf(gap)]]);
  // the receipt's block hash, its log's transaction and its log's block each checked
  for (const lie of [
    (rc: Record<string, unknown>) => (rc.blockHash = blockHash(950_000, "fork")),
    (rc: Record<string, unknown>) => ((rc.logs as Record<string, unknown>[])[0]!.transactionHash = "0x" + "77".repeat(32)),
    (rc: Record<string, unknown>) => ((rc.logs as Record<string, unknown>[])[0]!.blockNumber = hx(950_001)),
    (rc: Record<string, unknown>) => ((rc.logs as Record<string, unknown>[])[0]!.blockHash = blockHash(950_000, "fork")),
    (rc: Record<string, unknown>) => (rc.blockNumber = hx(950_001)),
    (rc: Record<string, unknown>) => (rc.logs = [{ ...logOf({ key: key(12), block: 950_000 }), transactionHash: txOf(gap) }]),
    (rc: Record<string, unknown>) => (rc.logs = null),
  ]) {
    const inner = reader({ head, pools: [real], receipts: [real, gap], state: st3, calls: [] });
    const lying: EvmRpc = async (calls) => (await inner(calls)).map((x, i) => (calls[i]!.method === "eth_getTransactionReceipt" && (x as { result: unknown }).result ? (lie((x as { result: Record<string, unknown> }).result), x) : x));
    const cfg = cfgOf({ head, pools: [], calls: [] }, { head, pools: [real, gap], state: st3, calls: [] });
    await assert.rejects(evmPoolIndexSync(null, { ...cfg, readers: [lying, cfg.readers[1]] }), code("rpc_disagree", /receipt of pool/));
  }
  // a receipt not answered: the span is unproven, the sync partial
  const un = await evmPoolIndexSync(null, cfgOf({ head, pools: [real], receipts: [real, gap], receiptError: true, state: st3, calls: [] }, { head, pools: [real, gap], state: st3, calls: [] }));
  assert.equal(un.coversThrough, null);
  assert.equal(un.error?.code, "rpc_error");
  assert.ok(!un.index!.pools.some((p) => p.id === evmPoolIdOf(gap.key)));
});

test("Q2: one lying reader in a partial sync never stores a pool at its block, so later honest syncs go on", async () => {
  const head = 1_000_000;
  const p = { key: key(1), block: head - 55_000 }; // real, span [940001, 950000]
  const y = head - 25_000; // the liar's block
  const state = new Set([evmPoolIdOf(p.key)]);
  const a: Reader = { head, pools: [p], state, calls: [] };
  // b logs p at y, and never answers the real span's last block, so that span ends rpc_error
  const b: Reader = { head, pools: [{ key: p.key, block: y }], receipts: [p], state, calls: [], noBlock: { b: head - 50_000, times: Infinity } };
  const r = await evmPoolIndexSync(null, cfgOf(a, b)).catch((e: unknown) => e);
  assert.ok(r instanceof EvmQuoteError && r.code === "rpc_disagree" && /receipt of pool/.test(r.message), String(r));
  // the caller keeps what it had (none): both honest from here, every sync goes on and has p at its own block
  let index: EvmPoolIndexData | null = null;
  for (let i = 1; i <= 2; i++) {
    const s = await evmPoolIndexSync(index, cfgOf({ head: head + 10 * i, pools: [p], state, calls: [] }, { head: head + 10 * i, pools: [p], state, calls: [] }));
    assert.equal(s.coversThrough, head + 10 * i);
    assert.equal(s.pools!.find((x) => x.id === evmPoolIdOf(p.key))?.block, p.block);
    index = s.index;
  }
});

// review 3 of 7f1ad79a: base.api.pocket.network answered eth_getTransactionReceipt `result: null` for real mined
// Initialize transactions, 119 of 500 (2026-11-08 21:08:58Z) and 6, 6, 3 of 16 in three rounds, other ones each round;
// base-rpc.publicnode.com answered all. An honest pair: a logs `gap`, b's logs miss it (the log gap F5 exists for).
const wrap = (inner: EvmRpc, f: (c: EvmRpcCall, x: unknown) => unknown): EvmRpc => async (calls) => (await inner(calls)).map((x, i) => f(calls[i]!, x));
const gap = { key: key(11), block: 950_000 };
const stGap = new Set([real, gap].map((p) => evmPoolIdOf(p.key)));

test("R1: a receipt answered null is asked again after the backoff; null on every try leaves its span unproven, never refused", async () => {
  const head = 1_000_000;
  // null once, then present: asked again after a backoff, and the sync is whole with gap at its block
  let nulls = 1;
  const naps: number[] = [];
  const b1 = reader({ head, pools: [real], receipts: [real, gap], state: stGap, calls: [] });
  const pocket = wrap(b1, (c, x) => (c.method === "eth_getTransactionReceipt" && nulls-- > 0 ? { result: null } : x));
  const cfg = cfgOf({ head, pools: [real, gap], state: stGap, calls: [] }, { head, pools: [], calls: [] }, { nap: async (ms) => void naps.push(ms) });
  const r = await evmPoolIndexSync(null, { ...cfg, readers: [cfg.readers[0], pocket] });
  assert.equal(r.error, null);
  assert.equal(r.coversThrough, head);
  assert.equal(r.pools!.find((p) => p.id === evmPoolIdOf(gap.key))?.block, gap.block);
  assert.ok(naps.some((ms) => ms >= 500), JSON.stringify(naps));
  // null on every try (the reader's tx index lacks it): INDEX_TRIES asks, then the pool unread, its span not stored,
  // every other span kept, nothing served
  const b2: Reader = { head, pools: [real], receipts: [real], state: stGap, calls: [] };
  const s = await evmPoolIndexSync(null, cfgOf({ head, pools: [real, gap], state: stGap, calls: [] }, b2));
  assert.equal(s.coversThrough, null);
  assert.equal(s.pools, null);
  assert.equal(s.error?.code, "rpc_error");
  assert.match(s.error!.message, /receipt/);
  assert.equal(b2.calls.flat().filter((c) => c.method === "eth_getTransactionReceipt").length, 4);
  assert.ok(!s.index!.pools.some((p) => p.id === evmPoolIdOf(gap.key)));
  assert.ok(!s.index!.spans.some(([a, b]) => a <= gap.block && gap.block <= b), JSON.stringify(s.index!.spans));
  assert.ok(s.index!.spans.some(([a, b]) => a <= real.block && real.block <= b));
});

test("R2: one-reader pools' receipts are asked in batches small enough for evmJsonRpc's 1 MiB cap", async () => {
  // 500 Base receipts in one batch: 12,329,188 bytes on base-rpc.publicnode.com, 9,508,100 on Pocket (2026-11-08
  // 21:08:54-58Z), mean 22.5 KB, largest 75.5 KB
  const head = 1_000_000;
  const gaps = Array.from({ length: 60 }, (_, i) => ({ key: key(100 + i), block: 940_000 + i * 100 }));
  const st = new Set([real, ...gaps].map((p) => evmPoolIdOf(p.key)));
  const inner = reader({ head, pools: [real], receipts: [real, ...gaps], state: st, calls: [] });
  const pad = "0x" + "00".repeat(11_000); // 22 KB of a receipt's other fields (logsBloom, the launch's other logs)
  const fetchFn = (async (_u: string, init: { body: string }) => {
    const calls = JSON.parse(init.body) as { id: number; method: string; params: unknown[] }[];
    const out = await inner(calls.map((c) => ({ method: c.method, params: c.params })));
    const body = calls.map((c, i) => {
      const x = out[i] as { result?: Record<string, unknown> | null };
      return { jsonrpc: "2.0", id: c.id, ...(c.method === "eth_getTransactionReceipt" && x.result ? { result: { ...x.result, pad } } : x) };
    });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const cfg = cfgOf({ head, pools: [real, ...gaps], state: st, calls: [] }, { head, pools: [], calls: [] });
  const r = await evmPoolIndexSync(null, { ...cfg, readers: [cfg.readers[0], evmJsonRpc("https://pocket.example", fetchFn)] });
  assert.equal(r.error?.message ?? null, null);
  assert.equal(r.coversThrough, head);
  assert.equal(gaps.filter((g) => ids(r.pools).has(evmPoolIdOf(g.key))).length, 60);
});

/** A reader behind evmJsonRpc's fetch that answers a batch of more than `max` calls HTTP 413 with
 *  base.api.pocket.network's own body (read 2026-11-18 20:41Z: 5 calls answer 200, 6 to 1,000 answer 413); `sizes`
 *  holds each post's calls and `refused` counts the 413s. */
const capped = (inner: EvmRpc, max: number, log: { sizes: number[]; refused: number }) =>
  (async (_u: string, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
    log.sizes.push(sent.length);
    if (sent.length > max) return log.refused++, new Response("request entity too large: the batch has more items than this window allows\n", { status: 413 });
    const out = await inner(sent.map((c) => ({ method: c.method, params: c.params })));
    return new Response(JSON.stringify(out.map((o, i) => ({ jsonrpc: "2.0", id: sent[i]!.id, ...(o as object) }))), { status: 200 });
  }) as unknown as typeof fetch;

test("BF1: a reader that answers a batch past 5 calls 413 still answers every receipt, its batches halved and kept (card evm-batch-fits-each-reader)", async () => {
  // release 177's app live run 44388203690: base.api.pocket.network, Base's second index reader, answered 0 of 10
  // receipts in every span, each batch of 10 answered 413
  const head = 1_000_000;
  const gaps = Array.from({ length: 12 }, (_, i) => ({ key: key(200 + i), block: 940_000 + i * 100 }));
  const st = new Set([real, ...gaps].map((p) => evmPoolIdOf(p.key)));
  const log = { sizes: [] as number[], refused: 0 };
  const b = capped(reader({ head, pools: [real], receipts: [real, ...gaps], state: st, calls: [] }), 5, log);
  const cfg = cfgOf({ head, pools: [real, ...gaps], state: st, calls: [] }, { head, pools: [], calls: [] });
  evmPaceReset();
  // batchMax 5: the state reads fit, so only the receipts' batches of 10 meet the 413, as on mainnet
  const r = await evmPoolIndexSync(null, { ...cfg, batchMax: 5, readers: [cfg.readers[0], evmJsonRpc("https://pocket-cap.example", b)] });
  evmPaceReset();
  assert.equal(r.error?.message ?? null, null);
  assert.equal(r.coversThrough, head);
  assert.equal(gaps.filter((g) => ids(r.pools).has(evmPoolIdOf(g.key))).length, 12, "every one-reader pool's receipt is answered");
  // only the batches in flight at once (parallel 2) when the first refusal comes back meet it; every later post fits
  assert.ok(log.refused >= 1 && log.refused <= (cfg.parallel as number), `refused ${log.refused}: ${log.sizes.join(",")}`);
  const last = log.sizes.length - 1 - [...log.sizes].reverse().findIndex((n) => n > 5);
  assert.ok(log.sizes.slice(last + 1).every((n) => n <= 5) && log.sizes.length - last > 10, log.sizes.join(","));
});

test("BF2: the state reads (batchMax unset, 500 a batch) split on the same 413, and a later reader object of the same URL starts at the kept size", async () => {
  const head = 1_000_000;
  const gaps = Array.from({ length: 12 }, (_, i) => ({ key: key(300 + i), block: 940_000 + i * 100 }));
  const st = new Set([real, ...gaps].map((p) => evmPoolIdOf(p.key)));
  const log = { sizes: [] as number[], refused: 0 };
  const inner = { head, pools: [real], receipts: [real, ...gaps], state: st, calls: [] };
  const cfg = cfgOf({ head, pools: [real, ...gaps], state: st, calls: [] }, { head, pools: [], calls: [] });
  evmPaceReset();
  const r = await evmPoolIndexSync(null, { ...cfg, readers: [cfg.readers[0], evmJsonRpc("https://pocket-cap.example", capped(reader(inner), 5, log))] });
  assert.equal(r.error?.message ?? null, null);
  assert.equal(r.coversThrough, head);
  assert.equal(gaps.filter((g) => ids(r.pools).has(evmPoolIdOf(g.key))).length, 12);
  // the page's next sync makes a new provider object of the same URL: its first batch is already at most 5
  const again = { sizes: [] as number[], refused: 0 };
  const r2 = await evmPoolIndexSync(null, { ...cfg, readers: [cfg.readers[0], evmJsonRpc("https://pocket-cap.example/", capped(reader(inner), 5, again))] });
  evmPaceReset();
  assert.equal(r2.coversThrough, head);
  assert.equal(again.refused, 0, `kept for the page's life: ${again.sizes.join(",")}`);
});

test("R3: a receipt answer that is not a receipt (a number, a string, an array) is unread, never a TypeError or a refusal", async () => {
  const head = 1_000_000;
  for (const odd of [(_x: unknown) => 7, (_x: unknown) => ({ result: "0x01" }), (_x: unknown) => ({ result: [] }), (_x: unknown) => ({ result: 5 })]) {
    const inner = reader({ head, pools: [real], receipts: [real, gap], state: stGap, calls: [] });
    const b = wrap(inner, (c, x) => (c.method === "eth_getTransactionReceipt" ? odd(x) : x));
    const cfg = cfgOf({ head, pools: [real, gap], state: stGap, calls: [] }, { head, pools: [], calls: [] });
    const r = await evmPoolIndexSync(null, { ...cfg, readers: [cfg.readers[0], b] }).catch((e: unknown) => e);
    assert.ok(!(r instanceof Error), String(r));
    const s = r as Awaited<ReturnType<typeof evmPoolIndexSync>>;
    assert.equal(s.coversThrough, null);
    assert.equal(s.error?.code, "rpc_error");
    assert.ok(!s.index!.pools.some((p) => p.id === evmPoolIdOf(gap.key)));
  }
});

// review 4 of 43f8e45f
const receiptAsks = (r: Reader) => r.calls.filter((cs) => cs.some((c) => c.method === "eth_getTransactionReceipt"));
// S1 (P2): a lying reader logs N real pools (each initialized before `from`, so the state holds them on both and the
// honest reader logs none of them in the depth) at blocks inside the depth with made-up transactions: at 43f8e45f each
// was asked INDEX_TRIES rounds on the honest reader (500 cost 200 batches and 7 s of backoff), the liar never named
for (const N of [500, 2000]) test(`S1: a liar's ${N} made-up Initialize txs of real old pools cost the honest reader at most the receipt budget, the sync partial naming the liar`, async () => {
  const head = 1_000_000;
  const old = Array.from({ length: N }, (_, i) => ({ key: key(5000 + i), block: 905_000 + (i % 90) * 1_000 }));
  const st = new Set([real, ...old].map((p) => evmPoolIdOf(p.key)));
  const honest: Reader = { head, pools: [real], receipts: [real], state: st, calls: [] };
  const liar: Reader = { head, pools: [real, ...old], state: st, calls: [] };
  let slept = 0;
  const r = await evmPoolIndexSync(null, cfgOf(honest, liar, { cap: 131_072, nap: async (ms) => void (slept += ms) }));
  const asked = receiptAsks(honest).flat().filter((c) => c.method === "eth_getTransactionReceipt").length;
  // the bound is the budget's 500 receipts, tries included (its batches depend on N: 125 pools take 52)
  assert.ok(asked <= 500, `${asked} receipts asked of the honest reader`);
  assert.ok(slept <= 1_000, `${slept} ms of receipt backoff`);
  assert.equal(r.coversThrough, null);
  assert.equal(r.pools, null);
  assert.equal(r.error?.code, "rpc_disagree");
  // N=500: all asked once, none asked again; N=2000: 1,500 never asked, 500 not asked again
  assert.match(r.error!.message, new RegExp(`index reader 2's one-reader pools took index reader 1 past its receipt budget of 500 \\(${N} pool\\(s\\) left unread by it, ${N - 500} of them never asked\\)`));
  const made = new Set(old.map((p) => evmPoolIdOf(p.key)));
  assert.ok(!r.index!.pools.some((p) => made.has(p.id)));
  assert.ok(!r.index!.spans.some(([a, b]) => old.some((p) => a <= p.block && p.block <= b)), JSON.stringify(r.index!.spans));
});

// S2 (P3): a rate limit answered inside a receipt batch (the words the spans ask again: answerOf's `limited`) was
// unread at once, so the sync of two honest readers ended partial
test("S2: a receipt answered with a rate limit inside the batch once, then present, completes the sync", async () => {
  const head = 1_000_000;
  let once = 1;
  const inner = reader({ head, pools: [real], receipts: [real, gap], state: stGap, calls: [] });
  const b = wrap(inner, (c, x) => (c.method === "eth_getTransactionReceipt" && once-- > 0 ? { error: { code: -32005, message: "25/second request limit reached" } } : x));
  const cfg = cfgOf({ head, pools: [real, gap], state: stGap, calls: [] }, { head, pools: [], calls: [] });
  const r = await evmPoolIndexSync(null, { ...cfg, readers: [cfg.readers[0], b] });
  assert.equal(r.error?.message ?? null, null);
  assert.equal(r.coversThrough, head);
  assert.equal(r.pools!.find((p) => p.id === evmPoolIdOf(gap.key))?.block, gap.block);
});

// Card signpage-evm-reads-draw-no-refusal: the Robinhood venue's cold index, read through evmPoolIndexRefresh as the
// page reads it, stays inside each reader's limit. Release 130's page asked rpc.mainnet.chain.robinhood.com 1,000
// spans of 10,000 blocks, 20 calls a post, and its Cloudflare answered the 6th post 429 with access-control-allow-origin
// "*,*", which a browser refuses as CORS (Chrome CDP capture 13 Nov 18:0xZ; curl the same at the 6th 20-call post).
// Pocket caps a getLogs at 10,001 blocks, so it cannot carry larger spans; the helper's keyed route answers 1,000,000
// blocks in one call. So the readers are Robinhood's own and the helper's ?keyed=only route, in spans of
// ROBINHOOD_INDEX_SPAN, every helper batch inside its HELPER_RPC_BATCH_MAX.
test("the Robinhood venue's cold index asks its device-direct reader few calls and the helper only batches it takes", async () => {
  const { evmPoolIndexRefresh } = await import("../src/trade/evm/buy-tap.ts");
  const { evmPoolVenues } = await import("../src/trade/evm/buy-unpinned.ts");
  const { HELPER_RPC_BATCH_MAX } = await import("../src/helper/v1.ts");
  const head = 113_543_798;
  const calls = new Map<string, number>();
  const batches = new Map<string, number[]>();
  const fake = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
    calls.set(url, (calls.get(url) ?? 0) + body.length);
    batches.set(url, [...(batches.get(url) ?? []), body.length]);
    const out = body.map((c) => {
      if (c.method === "eth_getLogs") return { jsonrpc: "2.0", id: c.id, result: [] };
      if (c.method === "eth_getBlockByNumber") {
        const n = c.params[0] === "latest" ? head : Number(c.params[0]);
        return { jsonrpc: "2.0", id: c.id, result: { number: hx(n), hash: blockHash(n) } };
      }
      return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "no" } };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const ix = evmPoolVenues().robinhood!.index!;
  const own = "https://rpc.mainnet.chain.robinhood.com";
  const helper = "https://ct-api.unrealized.trade/v1/rpc/robinhood?keyed=only";
  assert.deepEqual([...ix.readers], [own, helper], "Robinhood's own, device-direct, and the helper's keyed route");
  assert.equal(ix.batchMax, HELPER_RPC_BATCH_MAX, "the index's batchMax is the helper's batch cap");
  const { sync, served } = await evmPoolIndexRefresh("robinhood", null, fake);
  assert.equal(served, true);
  assert.equal(sync!.coversThrough, head);
  // the measured budget: Robinhood's own served 5 posts of 20 calls (10 getLogs of 10,000 blocks each) and answered
  // the 6th 429; a cold index asks it at most half of that, whatever the span
  assert.ok((calls.get(own) ?? 0) <= 50, `Robinhood's own asked ${calls.get(own)} calls`);
  assert.ok((batches.get(helper) ?? []).every((n) => n <= HELPER_RPC_BATCH_MAX), `the helper asked batches of ${JSON.stringify(batches.get(helper))}`);
  // the helper's per-client share (RPC_PAGE_NEED.robinhood, 30 calls in any 10 s) holds the page's other reads too
  assert.ok((calls.get(helper) ?? 0) <= 50, `the helper asked ${calls.get(helper)} calls`);
});

// Card signpage-evm-reads-draw-no-refusal: a reader that takes at most `batchMax` calls a batch (the helper's
// HELPER_RPC_BATCH_MAX, 10: a batch past it is its 413) gets the state reads (F5) in batches of at most that many; with
// 500 a batch, 25 one-reader pools went in one batch of 25 the helper refuses, each pool unread and the sync partial.
test("F5's state read needs no old block: a reader keeping only the newest blocks' state, the pin 24 s old by then, still covers (card evm-quote-reads-need-no-old-state)", async () => {
  const head = 1_000_000;
  // Base's 2 s blocks: the chain moves 12 blocks (24 s) while the spans are read; reader a keeps 10 blocks' state and
  // answers -32000 "historical state ... is not available" past them (Pocket and publicnode on Robinhood, 2026-11-10)
  const a: Reader = { head, pools: [real, deep], state: both2, calls: [], keeps: 10, moves: 12 };
  const b: Reader = { head, pools: [deep], receipts: [real, deep], state: both2, calls: [], moves: 12 };
  const r = await evmPoolIndexSync(null, cfgOf(a, b));
  assert.equal(r.error?.message ?? null, null);
  assert.equal(r.coversThrough, head);
  assert.ok(ids(r.pools).has(evmPoolIdOf(real.key)), "the one-reader pool the state holds is served");
  // the state read went to the newest block both readers agree on, past the pin
  for (const x of [a, b]) {
    const call = x.calls.flat().filter((c) => c.method === "eth_call");
    assert.equal(call.length, 1);
    assert.deepEqual(call[0]!.params[1], { blockHash: blockHash(head + 12) });
  }
  // nothing is loosened: a pool one reader logs whose state is 0 there on both is still no pool, and one reader alone
  // holding it still refuses
  const none = new Set([evmPoolIdOf(deep.key)]);
  const zero = await evmPoolIndexSync(null, cfgOf({ head, pools: [real, deep], state: none, calls: [], keeps: 10, moves: 12 }, { head, pools: [deep], receipts: [real, deep], state: none, calls: [], moves: 12 }));
  assert.equal(zero.coversThrough, head);
  assert.ok(!ids(zero.pools).has(evmPoolIdOf(real.key)));
  const half = await evmPoolIndexSync(null, cfgOf({ head, pools: [real, deep], state: both2, calls: [], keeps: 10, moves: 12 }, { head, pools: [deep], receipts: [real, deep], state: none, calls: [], moves: 12 })).catch((e: unknown) => e);
  assert.ok(half instanceof EvmQuoteError && half.code === "rpc_disagree", String(half));
  // no newer block both agree on (their hashes past N differ): the pool is unread and the sync partial, as before
  const split = await evmPoolIndexSync(null, cfgOf({ head, pools: [real, deep], state: both2, calls: [], moves: 12 }, { head, pools: [deep], receipts: [real, deep], state: both2, calls: [], moves: 12, hash: (n) => blockHash(n, n > head ? "fork" : "") }));
  assert.equal(split.coversThrough, null);
  assert.match(split.error?.message ?? "", /agree on no block at or past N/);
});

test("F5's state reads take each reader's batchMax: no batch of more calls than it takes", async () => {
  const head = 1_000_000;
  const gaps = Array.from({ length: 25 }, (_, i) => ({ key: key(200 + i), block: 940_000 + i * 100 }));
  const st = new Set(gaps.map((p) => evmPoolIdOf(p.key)));
  const a: Reader = { head, pools: gaps, receipts: gaps, state: st, calls: [] };
  const b: Reader = { head, pools: [], receipts: gaps, state: st, throwsOverCalls: 10, calls: [] };
  const r = await evmPoolIndexSync(null, cfgOf(a, b, { perBatch: 5, batchMax: 10 }));
  assert.equal(r.error?.message ?? null, null);
  assert.equal(r.coversThrough, head);
  assert.equal(gaps.filter((g) => ids(r.pools).has(evmPoolIdOf(g.key))).length, 25);
  for (const x of [a, b]) assert.ok(x.calls.filter((c) => c[0]?.method === "eth_call").every((c) => c.length <= 10), JSON.stringify(x.calls.map((c) => c.length)));
});

// Card robinhood-quote-answers-cold: the release's index snapshot (packages/signpage/data/evm-index/<chain>.json,
// scripts/evm-index-snapshot.mjs). A fresh device's cold Robinhood quote sent 20 to 100+ deep getLogs posts to
// rpc.mainnet.chain.robinhood.com at its pace of about one a second and ended stale_quote, 6 of 8 coins (box run
// 2026-11-16 03:24Z); started from a snapshot the device's sync reads only the tail past it.
type Snap = { fromSnapshot: (x: unknown, want: { chainId: number; poolManager: string; cap: number }) => EvmPoolIndexData | null; snapshotOf: (ix: EvmPoolIndexData) => unknown };
const snap = (): Snap => {
  const m = poolIndex as unknown as { evmPoolIndexFromSnapshot?: Snap["fromSnapshot"]; evmPoolIndexSnapshotOf?: Snap["snapshotOf"] };
  assert.equal(typeof m.evmPoolIndexFromSnapshot, "function", "pool-index.ts has no evmPoolIndexFromSnapshot");
  assert.equal(typeof m.evmPoolIndexSnapshotOf, "function", "pool-index.ts has no evmPoolIndexSnapshotOf");
  return { fromSnapshot: m.evmPoolIndexFromSnapshot!, snapshotOf: m.evmPoolIndexSnapshotOf! };
};
const WANT = { chainId: 8453, poolManager: PM, cap: 1000 };

test("SNAP1 a snapshot of a synced index reads back as that index, each pool's id its key's, and a sync from it reads only the tail", async () => {
  const { fromSnapshot, snapshotOf } = snap();
  const head = 1_000_000;
  const ps = pools(10, head);
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [] }));
  const json = JSON.parse(JSON.stringify(snapshotOf(r.index!)));
  // the compact form names no id: each is the key's own keccak
  assert.ok(!JSON.stringify(json).includes(evmPoolIdOf(ps[0]!.key)), "the snapshot carries pool ids");
  const back = fromSnapshot(json, WANT);
  assert.deepEqual(back, r.index);
  // the next sync from it, 20,000 blocks on: only those blocks and the margin are asked, of each reader
  const later = head + 20_000;
  const fresh = [...ps, { key: key(50), block: head + 10_000 }];
  const a: Reader = { head: later, pools: fresh, calls: [] };
  const b: Reader = { head: later, pools: fresh, calls: [] };
  const s = await evmPoolIndexSync(back, cfgOf(a, b));
  assert.equal(s.coversThrough, later);
  assert.ok(ids(s.pools).has(evmPoolIdOf(key(50))));
  const asked = a.calls.flatMap((cs) => cs.filter((c) => c.method === "eth_getLogs").map((c) => Number((c.params[0] as { fromBlock: string }).fromBlock)));
  assert.ok(asked.length > 0 && asked.every((f) => f > head - 474 - 10_000), `the tail sync asked from ${Math.min(...asked)}`);
});

test("SNAP2 a snapshot that is not the chain's whole proven shape is refused (null), never served", async () => {
  const { fromSnapshot, snapshotOf } = snap();
  const head = 1_000_000;
  const ps = pools(10, head);
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [] }));
  const good = JSON.parse(JSON.stringify(snapshotOf(r.index!))) as { pools: unknown[][]; spans: number[][]; [k: string]: unknown };
  assert.notEqual(fromSnapshot(good, WANT), null);
  const bad: [string, (s: typeof good) => unknown][] = [
    ["not an object", () => "x"],
    ["another chain", (s) => ({ ...s, chainId: 1 })],
    ["another PoolManager", (s) => ({ ...s, poolManager: "0x" + "11".repeat(20) })],
    ["another version", (s) => ({ ...s, v: 2 })],
    ["through below from", (s) => ({ ...s, through: (s.from as number) - 1 })],
    ["a head below through", (s) => ({ ...s, head: { number: (s.through as number) - 1, hash: (s.head as { hash: string }).hash } })],
    ["a head with no hash", (s) => ({ ...s, head: { number: s.through, hash: "0x12" } })],
    ["spans that overlap", (s) => ({ ...s, spans: [[s.from, (s.from as number) + 10], [(s.from as number) + 5, s.through]] })],
    ["a span past through", (s) => ({ ...s, spans: [[s.from, (s.through as number) + 1]] })],
    ["a pool outside every span", (s) => ({ ...s, pools: [...s.pools, ["0x" + "00".repeat(19) + "aa", "0x4200000000000000000000000000000000000006", 3000, 60, "0x" + "00".repeat(20), (s.through as number) + 5]] })],
    ["currency0 not below currency1", (s) => ({ ...s, pools: [["0x4200000000000000000000000000000000000006", "0x" + "00".repeat(19) + "aa", 3000, 60, "0x" + "00".repeat(20), s.pools[0]![5]]] })],
    ["a fee past 24 bits", (s) => ({ ...s, pools: [[...s.pools[0]!.slice(0, 2), 0x1000000, ...s.pools[0]!.slice(3)]] })],
    ["a tick spacing of 0", (s) => ({ ...s, pools: [[...s.pools[0]!.slice(0, 3), 0, ...s.pools[0]!.slice(4)]] })],
    ["an address not lower hex", (s) => ({ ...s, pools: [["0xZZ" + "00".repeat(19), ...s.pools[0]!.slice(1)]] })],
    ["a pool twice", (s) => ({ ...s, pools: [...s.pools, s.pools[0]] })],
    ["a pool row of other fields", (s) => ({ ...s, pools: [[...s.pools[0]!, 1]] })],
    ["more pools than the cap", (s) => s],
  ];
  for (const [why, make] of bad) assert.equal(fromSnapshot(make(good), why === "more pools than the cap" ? { ...WANT, cap: 9 } : WANT), null, why);
});

// Card evm-sync-inside-the-kpi-at-any-age: a fresh device's Base sync from a 48 h old snapshot took 15 to 142.6 s (21 Nov
// 12:5x-13:05Z): base.rpc.blxrbdn.com answered 5-span batches one getLogs after another, past the 10 s timeout on 32 of
// 80 posts, each asked again whole up to 4 times, and every round waited for it while base-rpc.publicnode.com sat idle.
const logSpans = (x: Reader) => x.calls.flat().filter((c) => c.method === "eth_getLogs").map((c) => c.params[0] as { fromBlock: string; toBlock: string });
const blocksOf = (f: { fromBlock: string; toBlock: string }) => Number(f.toBlock) - Number(f.fromBlock) + 1;

test("SPLIT a batch that times out is split at once, never asked again at its size, and the sync ends whole", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  const b: Reader = { head, pools: ps, calls: [], timeoutOverLogs: 1 };
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, b));
  assert.equal(r.coversThrough, head);
  assert.deepEqual(ids(r.pools), new Set(ps.map((p) => evmPoolIdOf(p.key))));
  const many = b.calls.filter((cs) => cs.filter((c) => c.method === "eth_getLogs").length > 1).map((cs) => JSON.stringify(cs));
  assert.ok(many.length > 0, "the plant met no batch");
  assert.equal(new Set(many).size, many.length, `a timed-out batch asked again at its size: ${many.length} posts, ${new Set(many).size} batches`);
  assert.equal(r.stats.failed[1], many.length, "each timed-out batch failed once");
});

test("WALK a slow reader never idles the fast one: the fast reader reads every span while the slow one has its first batch out", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  const a: Reader = { head, pools: ps, calls: [] };
  const b: Reader = { head, pools: ps, calls: [] };
  let open: () => void = () => {};
  const gate = new Promise<void>((f) => {
    open = f;
  });
  const slow = reader(b);
  let logsPosts = 0;
  // the slow reader answers its head and the pin, then holds every batch until the gate opens
  const held: EvmRpc = async (calls, until) => {
    if (calls.some((c) => c.method === "eth_getLogs")) logsPosts++;
    if (logsPosts > 1) await gate;
    return slow(calls, until);
  };
  const run = evmPoolIndexSync(null, { ...cfgOf(a, b), readers: [reader(a), held] });
  let spins = 0;
  while (logSpans(a).length < 10 && spins++ < 1_000) await new Promise((f) => setImmediate(f));
  const fastRead = logSpans(a).length;
  open();
  const r = await run;
  assert.equal(fastRead, 10, `the fast reader read ${fastRead} of 10 spans while the slow one held its batch`);
  assert.equal(r.coversThrough, head);
  assert.deepEqual(ids(r.pools), new Set(ps.map((p) => evmPoolIdOf(p.key))));
});

test("PIECE a range one reader never answered refuses the sync: whole-or-refuse holds with each reader in its own pieces", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  const spanEnd = head - 30_000;
  const inner = spanEnd - 5_000; // the second reader's piece end inside that span, which the first is asked too
  const a: Reader = { head, pools: ps, calls: [] };
  const b: Reader = { head, pools: ps, calls: [], noBlock: { b: inner, times: Infinity } };
  const r = await evmPoolIndexSync(null, cfgOf(a, b, { parts: [1, 2], perBatch: [3, 1], parallel: [2, 4] }));
  assert.ok(logSpans(b).every((f) => blocksOf(f) === 5_000), "the second reader asked in its own pieces");
  assert.ok(logSpans(a).every((f) => blocksOf(f) === 10_000), "the first reader asked whole spans");
  assert.equal(r.coversThrough, null);
  assert.equal(r.pools, null);
  assert.equal(r.error?.code, "rpc_error");
  assert.ok(r.index!.spans.every(([x, y]) => inner < x || inner > y), JSON.stringify(r.index!.spans));
  // answered once it comes: whole
  const ok = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [], noBlock: { b: inner, times: 1 } }, { parts: [1, 2] }));
  assert.equal(ok.coversThrough, head);
  assert.deepEqual(ids(ok.pools), new Set(ps.map((p) => evmPoolIdOf(p.key))));
});

test("AGREE two readers that disagree on a range refuse it: a piece end on another fork, or a pool at another block", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  const inner = head - 30_000 - 5_000;
  await assert.rejects(
    evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [], forkAt: { b: inner, times: Infinity } }, { parts: [1, 2] })),
    (e: Error & { code?: string }) => e.code === "rpc_disagree" && /do not agree/.test(e.message),
  );
  // the same pool at another block of its span on the reader that reads it in pieces: asked again, then refused
  const moved = ps.map((p, i) => (i === 3 ? { ...p, block: p.block - 4_000 } : p));
  await assert.rejects(
    evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: moved, receipts: moved, calls: [] }, { parts: [1, 2] })),
    (e: Error & { code?: string }) => e.code === "rpc_disagree",
  );
});

// Card evm-first-quote-reads-its-coin-at-any-age: one coin's read (evmPoolCoinSync), the coin's pools and its Xs'
// markets over the gap from a stored index to N, on both readers, every rule of the whole sync held. Read off the module,
// so the file loads on a build without it and each test fails on its own.
type CoinSync = (prev: EvmPoolIndexData | null, coin: { token: string; weth: string }, c: EvmPoolIndexConfig) => Promise<{ token: string; xs: readonly string[] | null; from: number | null; coversThrough: number | null; pools: readonly { id: string; key: EvmPoolKey; block: number }[] | null; error: EvmQuoteError | null }>;
const coinSync: CoinSync = (...a) => {
  const f = (poolIndex as { evmPoolCoinSync?: CoinSync }).evmPoolCoinSync;
  if (f === undefined) throw new Error("no evmPoolCoinSync");
  return f(...a);
};
const WETH = "0x4200000000000000000000000000000000000006";
const NAT = "0x0000000000000000000000000000000000000000";
const T = "0x7000000000000000000000000000000000000007"; // the coin, above WETH
const X1 = "0x0000000000000000000000000000000000000100"; // an X the stored index holds, below WETH
const X2 = "0x9000000000000000000000000000000000000009"; // an X new in the gap, above the coin
const pk = (currency0: string, currency1: string, fee = 3000): EvmPoolKey => ({ currency0, currency1, fee, tickSpacing: 60, hooks: NAT });
const H0 = 1_000_000;
const H1 = 1_050_000;
/** The chain: the coin's pools and its Xs' markets, before H0 (the stored index) and in the gap to H1, with pools of no
 *  buy of the coin beside them (other coins' markets, an X with an X, the native coin with WETH). */
const coinChain = () => {
  const before = [
    { key: pk(WETH, T), block: H0 - 50_000 },
    { key: pk(X1, T), block: H0 - 40_000 },
    { key: pk(X1, WETH), block: H0 - 30_000 },
  ];
  const gap = [
    { key: pk(NAT, T), block: H0 + 5_000 },
    { key: pk(T, X2), block: H0 + 12_000 },
    { key: pk(X1, WETH, 500), block: H0 + 21_000 },
    { key: pk(WETH, X2), block: H0 + 33_000 },
    { key: pk(NAT, X2), block: H0 + 44_000 },
  ];
  const other = [
    ...pools(6, H1),
    { key: pk(X1, X2), block: H0 + 15_000 },
    { key: pk(NAT, WETH), block: H0 + 25_000 },
    { key: pk(X1, "0x8000000000000000000000000000000000000008"), block: H0 - 20_000 },
  ];
  return { before, gap, other, all: [...before, ...gap, ...other] };
};
/** The stored index at H0 of two honest readers of the chain. */
const storedAt = async (all: Pool[]): Promise<EvmPoolIndexData> => {
  const at = all.filter((p) => p.block <= H0);
  const r = await evmPoolIndexSync(null, cfgOf({ head: H0, pools: at, calls: [] }, { head: H0, pools: at, calls: [] }));
  assert.equal(r.coversThrough, H0);
  return r.index!;
};
const isWanted = (k: EvmPoolKey, xs: Set<string>) => k.currency0 === T || k.currency1 === T || (((k.currency0 === NAT || k.currency0 === WETH) && xs.has(k.currency1)) || (k.currency1 === WETH && xs.has(k.currency0)));
const logsAsked = (r: Reader) => r.calls.flat().filter((c) => c.method === "eth_getLogs").map((c) => (c.params[0] as { topics: unknown[] }).topics);

test("COIN a coin's read finds every pool of the coin and of its Xs' markets to N, the same set the whole index holds, and asks no unfiltered getLogs", async () => {
  const ch = coinChain();
  const prev = await storedAt(ch.all);
  const a: Reader = { head: H1, pools: ch.all, calls: [] };
  const b: Reader = { head: H1, pools: ch.all, calls: [] };
  const r = await coinSync(prev, { token: T, weth: WETH }, cfgOf(a, b));
  assert.equal(r.error, null);
  assert.equal(r.coversThrough, H1);
  assert.equal(r.from, prev.from);
  assert.deepEqual(r.xs, [X1, X2]);
  const want = [...ch.before, ...ch.gap].map((p) => evmPoolIdOf(p.key));
  assert.deepEqual(ids(r.pools), new Set(want));
  // the whole index of the same chain, to the same N, filtered to the coin's sets, is the very same set
  const whole = await evmPoolIndexSync(prev, cfgOf({ head: H1, pools: ch.all, calls: [] }, { head: H1, pools: ch.all, calls: [] }));
  assert.deepEqual(ids(r.pools), ids(whole.pools!.filter((p) => isWanted(p.key, new Set([X1, X2])))));
  // every getLogs names the coin or the Xs: none reads the event alone
  for (const t of [...logsAsked(a), ...logsAsked(b)]) assert.ok(t.length >= 3 && (t[2] !== null || t[3] !== null), JSON.stringify(t));
  // and every range of every filter is asked once on each reader: each answer read at its own place in its batch
  for (const rd of [a, b]) {
    const asked = rd.calls.flat().filter((c) => c.method === "eth_getLogs").map((c) => JSON.stringify(c.params[0]));
    assert.equal(new Set(asked).size, asked.length, "a range asked twice");
  }
});

test("COIN the Xs the stored index holds are asked beside the coin; an X new in the gap is asked after, at the same N, its heads not read again", async () => {
  const ch = coinChain();
  const prev = await storedAt(ch.all);
  const a: Reader = { head: H1, pools: ch.all, calls: [] };
  const b: Reader = { head: H1, pools: ch.all, calls: [] };
  await coinSync(prev, { token: T, weth: WETH }, cfgOf(a, b));
  const x = (s: string) => "0x" + s.slice(2).padStart(64, "0");
  const tWord = x(T);
  const batches = a.calls.filter((cs) => cs.some((c) => c.method === "eth_getLogs"));
  const isFirst = (cs: EvmRpcCall[]) => cs.some((c) => c.method === "eth_getLogs" && (c.params[0] as { topics: unknown[] }).topics[2] === tWord);
  // X1's markets in the very batches of the coin's
  for (const cs of batches.filter(isFirst)) assert.ok(cs.some((c) => c.method === "eth_getLogs" && JSON.stringify((c.params[0] as { topics: unknown[] }).topics).includes(x(X1))), "X1's markets beside the coin's");
  // X2's in a read after, every one of its batches past the first read's, none reading a head
  // every request after the first read's last batch
  const lastFirst = a.calls.map((cs, i) => (isFirst(cs) ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
  const second = a.calls.slice(lastFirst + 1);
  assert.ok(second.length > 0 && second.every((cs) => !isFirst(cs)), "the second read after the first");
  assert.ok(second.some((cs) => cs.some((c) => c.method === "eth_getLogs" && JSON.stringify((c.params[0] as { topics: unknown[] }).topics).includes(x(X2)))), "X2's markets asked");
  assert.ok(second.every((cs) => cs.every((c) => !(c.method === "eth_getBlockByNumber" && c.params[0] === "latest"))), "no head read again");
  // its pin is the first read's: its first batch is not the span ending at N alone
  assert.ok(second[0]!.filter((c) => c.method === "eth_getLogs").length > 1, "the second read's spans asked at once");
  assert.ok(second.every((cs) => cs.every((c) => c.method !== "eth_getLogs" || Number((c.params[0] as { toBlock: string }).toBlock) <= H1)));
});

test("COIN a block N the second read finds on another fork than the first pinned refuses the coin's read", async () => {
  const ch = coinChain();
  const prev = await storedAt(ch.all);
  const tWord = "0x" + T.slice(2).padStart(64, "0");
  // both readers move block N to another fork once the first read is in (a reorg at N between the two reads)
  const forkOnSecond = (rpc: EvmRpc): EvmRpc => async (calls) => {
    const out = await rpc(calls);
    const second = calls.some((c) => c.method === "eth_getLogs") && !calls.some((c) => c.method === "eth_getLogs" && (c.params[0] as { topics: unknown[] }).topics[2] === tWord);
    return second ? out.map((o, i) => (calls[i]!.method === "eth_getBlockByNumber" && Number(calls[i]!.params[0]) === H1 ? { result: { number: hx(H1), hash: blockHash(H1, "fork") } } : o)) : out;
  };
  const c = cfgOf({ head: H1, pools: ch.all, calls: [] }, { head: H1, pools: ch.all, calls: [] });
  await assert.rejects(coinSync(prev, { token: T, weth: WETH }, { ...c, readers: [forkOnSecond(c.readers[0]), forkOnSecond(c.readers[1])] }), (e: Error & { code?: string }) => e.code === "rpc_disagree" && /pinned/.test(e.message));
});

test("COIN a reader that leaves out one of the coin's pools never hides it: logged by the other, its state and receipt keep it; its state 0 too refuses", async () => {
  const ch = coinChain();
  const prev = await storedAt(ch.all);
  const hidden = ch.gap[1]!; // (T, X2): X2 then known only from the other reader
  const without = ch.all.filter((p) => p !== hidden);
  // logs only: the state and the receipt on the omitting reader prove it, so it is kept, and X2's markets with it
  const kept = await coinSync(prev, { token: T, weth: WETH }, cfgOf({ head: H1, pools: ch.all, calls: [] }, { head: H1, pools: without, receipts: ch.all, state: new Set(ch.all.map((p) => evmPoolIdOf(p.key))), calls: [] }));
  assert.equal(kept.coversThrough, H1);
  assert.ok(ids(kept.pools).has(evmPoolIdOf(hidden.key)));
  assert.ok(ids(kept.pools).has(evmPoolIdOf(pk(WETH, X2))));
  // its state 0 as well: the two readers' state of it is apart, which refuses
  await assert.rejects(
    coinSync(prev, { token: T, weth: WETH }, cfgOf({ head: H1, pools: ch.all, calls: [] }, { head: H1, pools: without, calls: [] })),
    (e: Error & { code?: string }) => e.code === "rpc_disagree",
  );
});

test("COIN a range one reader never answered leaves the coin's read partial: nothing served", async () => {
  const ch = coinChain();
  const prev = await storedAt(ch.all);
  const r = await coinSync(prev, { token: T, weth: WETH }, cfgOf({ head: H1, pools: ch.all, calls: [] }, { head: H1, pools: ch.all, calls: [], noBlock: { b: H1 - 30_000, times: Infinity } }));
  assert.equal(r.coversThrough, null);
  assert.equal(r.pools, null);
  assert.equal(r.xs, null);
  assert.equal(r.error?.code, "rpc_error");
});

test("COIN a reader that ignores the filter and answers every Initialize log reads the coin whole: a pool outside the coin's sets is no log of its read", async () => {
  const ch = coinChain();
  const prev = await storedAt(ch.all);
  const many = [...ch.all, ...Array.from({ length: 12 }, (_, i) => ({ key: key(100 + i), block: H0 + 1_000 + i * 3_000 }))];
  const r = await coinSync(prev, { token: T, weth: WETH }, cfgOf({ head: H1, pools: many, calls: [], ignoresTopics: true }, { head: H1, pools: many, calls: [] }, { cap: 15 }));
  assert.equal(r.error, null);
  assert.equal(r.coversThrough, H1);
  assert.deepEqual(ids(r.pools), new Set([...ch.before, ...ch.gap].map((p) => evmPoolIdOf(p.key))));
});

test("ORSPAN a reader that bounds an OR's range is asked its pieces within it, and up to two Xs are asked one value a position", async () => {
  const ch = coinChain();
  const X3 = "0x0000000000000000000000000000000000000200";
  const X4 = "0x0000000000000000000000000000000000000300";
  // three Xs the stored index holds (X1, X3, X4): one OR of them, in pieces of at most 4,000 blocks on the bounded reader
  const more = [...ch.all, { key: pk(X3, T), block: H0 - 45_000 }, { key: pk(X4, T), block: H0 - 44_000 }, { key: pk(X3, WETH), block: H0 + 7_000 }];
  const prev = await storedAt(more);
  const a: Reader = { head: H1, pools: more, calls: [] };
  const b: Reader = { head: H1, pools: more, calls: [], orMaxRange: 4_000 };
  const r = await coinSync(prev, { token: T, weth: WETH }, cfgOf(a, b, { orSpan: [undefined, 4_000] }));
  assert.equal(r.error, null);
  assert.equal(r.coversThrough, H1);
  assert.ok(ids(r.pools).has(evmPoolIdOf(pk(X3, WETH))));
  const orOver = (rd: Reader, n: number) => rd.calls.flat().filter((c) => c.method === "eth_getLogs" && (c.params[0] as { topics: unknown[] }).topics.some(Array.isArray) && Number((c.params[0] as { toBlock: string }).toBlock) - Number((c.params[0] as { fromBlock: string }).fromBlock) + 1 > n).length;
  assert.equal(orOver(b, 4_000), 0, "an OR past the bounded reader's range");
  assert.ok(orOver(a, 4_000) > 0, "the other reader keeps its own span");
  // one X (the coin chain's X1, then X2): no OR asked at all, each piece the reader's own span
  const prev1 = await storedAt(ch.all);
  const b1: Reader = { head: H1, pools: ch.all, calls: [], orMaxRange: 4_000 };
  const r1 = await coinSync(prev1, { token: T, weth: WETH }, cfgOf({ head: H1, pools: ch.all, calls: [] }, b1, { orSpan: [undefined, 4_000] }));
  assert.equal(r1.coversThrough, H1);
  assert.deepEqual(ids(r1.pools), new Set([...ch.before, ...ch.gap].map((p) => evmPoolIdOf(p.key))));
  assert.equal(b1.calls.flat().filter((c) => c.method === "eth_getLogs" && (c.params[0] as { topics: unknown[] }).topics.some(Array.isArray)).length, 0);
  assert.ok(b1.calls.flat().some((c) => c.method === "eth_getLogs" && Number((c.params[0] as { toBlock: string }).toBlock) - Number((c.params[0] as { fromBlock: string }).fromBlock) + 1 > 4_000));
});
