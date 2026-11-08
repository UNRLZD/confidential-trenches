// The device's index of every v4 pool (src/checks/evm/pool-index.ts, card evm-pool-index): F4a-F4d, F5 and F6, each a
// test that test/evm-pool-index-mutants.mjs fails by removing its rule. Two readers answer from one model chain, each
// with its own faults.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmPoolIdOf, evmPoolIndexSync, type EvmPoolIndexConfig, type EvmPoolIndexData } from "../src/checks/evm/pool-index.ts";
import type { EvmPoolKey, EvmRpc, EvmRpcCall } from "../src/checks/evm/quote.ts";
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
const logOf = (p: Pool) => ({
  address: PM,
  blockNumber: hx(p.block),
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
  calls: EvmRpcCall[][];
};
function reader(r: Reader): EvmRpc {
  let req = 0;
  return async (calls) => {
    req++;
    r.calls.push([...calls]);
    if (r.limited !== undefined && r.limited > 0) {
      r.limited--;
      throw Object.assign(new Error("the provider answered 429 Too Many Requests"), { afterMs: 1 });
    }
    if (r.throws?.has(req)) throw new Error("the provider answered HTTP 502");
    const h = r.hash ?? ((n: number) => blockHash(n));
    return calls.map((c) => {
      if (c.method === "eth_getBlockByNumber") {
        const n = c.params[0] === "latest" ? r.head : Number(c.params[0]);
        if (n > r.head) return { result: null };
        if (r.noBlock !== undefined && r.noBlock.b === n && r.noBlock.times > 0) {
          r.noBlock.times--;
          return { result: null };
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
        return { result: r.pools.filter((p) => p.block >= a && p.block <= b && p.block <= r.head).map(logOf) };
      }
      if (c.method === "eth_call") {
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
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [], hash: fork })), (e: Error & { code?: string }) => e.code === "rpc_disagree" && /block 1000000/.test(e.message));
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
  const b: Reader = { head, pools: [both, wrongId], state, calls: [] };
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
  // one reader alone saying it holds the pool is not enough
  const halfState = await evmPoolIndexSync(null, cfgOf({ head, pools: [real], state, calls: [] }, { head, pools: [], state: new Set(), calls: [] }));
  assert.deepEqual(ids(halfState.pools), new Set());
});

test("F6: past the hard pool cap the index refuses by name and never serves a partial index", async () => {
  const head = 1_000_000;
  const ps = pools(6, head);
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [] }, { cap: 5 })), (e: Error & { code?: string }) => e.code === "too_many_pools" && /more than 5 pools/.test(e.message));
  const atCap = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [] }, { head, pools: ps, calls: [] }, { cap: 6 }));
  assert.equal(atCap.pools!.length, 6);
});

test("a span answered with an error is asked as its halves on both, and a 429 waits without spending a try", async () => {
  const head = 1_000_000;
  const ps = pools(10, head);
  const r = await evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [], maxRange: 5_000, limited: 2 }, { head, pools: ps, calls: [] }));
  assert.equal(r.coversThrough, head);
  assert.deepEqual(ids(r.pools), new Set(ps.map((p) => evmPoolIdOf(p.key))));
  assert.equal(r.stats.limited[0], 2);
  // a reader that answers every span with an error refuses rather than ask halves without end
  await assert.rejects(evmPoolIndexSync(null, cfgOf({ head, pools: ps, calls: [], maxRange: 0 }, { head, pools: ps, calls: [] })), (e: Error & { code?: string }) => e.code === "too_many_pools" || e.code === "rpc_error");
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
