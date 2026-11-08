// The device's index of every v4 pool (src/checks/evm/pool-index.ts, card evm-pool-index): F4a-F4d, F5 and F6, each a
// test that test/evm-pool-index-mutants.mjs fails by removing its rule. Two readers answer from one model chain, each
// with its own faults.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmPoolIdOf, evmPoolIndexSync, type EvmPoolIndexConfig, type EvmPoolIndexData } from "../src/checks/evm/pool-index.ts";
import { EvmQuoteError, evmJsonRpc, type EvmPoolKey, type EvmRpc, type EvmRpcCall } from "../src/checks/evm/quote.ts";
import * as poolIndex from "../src/checks/evm/pool-index.ts";
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
const slotOf = (id: string) => "0x" + bytesToHex(keccak_256(hexToBytes(id.slice(2) + w(6n))));

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
  /** getLogs answered with a rate-limit error inside a 200, this many first */
  limitedInBody?: number;
  /** the 429s' Retry-After, in ms (default 1) */
  limitedAfterMs?: number;
  /** a batch of more than this many calls throws (a body past its size) */
  throwsOverCalls?: number;
  /** a batch with a getLogs over more than this many blocks throws (a timeout) */
  throwsOverRange?: number;
  /** a block whose hash this reader answers as another fork's, this many times */
  forkAt?: { b: number; times: number };
  /** the state reads answered with an error */
  stateError?: boolean;
  /** more logs this reader answers to every getLogs */
  extraLogs?: unknown[];
  /** the receipts answered with an error */
  receiptError?: boolean;
  /** pools this reader's receipts read, where they are not its logs' (default: `pools`) */
  receipts?: Pool[];
  calls: EvmRpcCall[][];
};
function reader(r: Reader): EvmRpc {
  let req = 0;
  return async (calls) => {
    req++;
    r.calls.push([...calls]);
    if (r.limited !== undefined && r.limited > 0) {
      r.limited--;
      throw Object.assign(new Error("the provider answered 429 Too Many Requests"), { afterMs: r.limitedAfterMs ?? 1 });
    }
    if (r.throws?.has(req)) throw new Error("the provider answered HTTP 502");
    if (r.throwsOverCalls !== undefined && calls.length > r.throwsOverCalls) throw new Error("the answer is too long");
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
        if (r.limitedInBody !== undefined && r.limitedInBody > 0) {
          r.limitedInBody--;
          return { error: { code: -32005, message: "25/second request limit reached" } };
        }
        return { result: [...r.pools.filter((p) => p.block >= a && p.block <= b && p.block <= r.head).map(logOf), ...(r.extraLogs ?? [])] };
      }
      if (c.method === "eth_getTransactionReceipt") {
        if (r.receiptError) return { error: { code: -32000, message: "header not found" } };
        const p = (r.receipts ?? r.pools).find((q) => txOf(q) === c.params[0]);
        return { result: p === undefined ? null : { blockNumber: hx(p.block), blockHash: blockHash(p.block), status: "0x1", logs: [logOf(p)] } };
      }
      if (c.method === "eth_call") {
        if (r.stateError) return { error: { code: -32000, message: "missing trie node" } };
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

test("a rate limit answered inside a batch is asked again, never as halves", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  const a: Reader = { head, pools: ps, calls: [], limitedInBody: 2 };
  const r = await evmPoolIndexSync(null, cfgOf(a, { head, pools: ps, calls: [] }));
  assert.equal(r.coversThrough, head);
  const spans = a.calls.flat().filter((c) => c.method === "eth_getLogs").map((c) => c.params[0] as { fromBlock: string; toBlock: string });
  assert.ok(spans.every((f) => Number(f.toBlock) - Number(f.fromBlock) + 1 === 10_000), "no span asked as halves");
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
});

test("Q3: a pool one reader logs inside the depth whose transaction's receipt on the other is another block refuses", async () => {
  const head = 1_000_000;
  const q = { key: key(9), block: 800_000 }; // real, below from = 900,001
  const moved = { key: q.key, block: 950_000 };
  const state = new Set([real, q].map((p) => evmPoolIdOf(p.key)));
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: [real, q], state, calls: [] }, { head, pools: [real, moved], state, calls: [] })), code("rpc_disagree", /receipt of pool/));
  // a transaction the other reader has no receipt of: refused too
  const made = { key: key(10), block: 950_000 };
  const st2 = new Set([real, made].map((p) => evmPoolIdOf(p.key)));
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: [real], receipts: [real], state: st2, calls: [] }, { head, pools: [real, made], state: st2, calls: [] })), code("rpc_disagree", /receipt of pool/));
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
