// node --test packages/wallet/test/pool-evm-reads-once.test.ts: the EVM pool sync reads each agreed block once per proof
// pass (card evm-first-proof-inside-ten-seconds, src/pool/evm.ts). On a Base mainnet copy one pass of the proof queue
// (the pool's time, the epoch's trees, then the newest trees) asked publicnode 21 eth_getBlockByNumber for 8 heights:
// every round read the finalized and newest tags and then each block again by number on both RPCs, and every trees()
// call ran a whole round. The RPCs are a mock chain (blocks every 2 s, the pool's logs, its views at each block),
// copied from pool-evm.test.ts. Test leaves only, never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VaultTree } from "@blindfill/kit";
import { PoolNoLeafError, PoolReadError } from "../src/pool/pool.ts";
import * as evm from "../src/pool/evm.ts";
import { EVM_EPOCH_MS, EvmLagError, evmAgreedBlock, evmPool, evmPoolScopeOf, evmTreeSync, type EvmFeeAnswer, type EvmPoolPin, type EvmRpc } from "../src/pool/evm.ts";

// read off the module, so a build without it fails each case by what it reads, never at the import
const EVM_NEWEST_REUSE_MS = evm.EVM_NEWEST_REUSE_MS;

type Set3 = { pool: string; chainId: string; scope: string; labels: string[]; commitments: string[] };
const PP = JSON.parse(readFileSync(new URL("../../../contracts/pool-evm/test/fixtures/pool-proofs.json", import.meta.url), "utf8")) as Set3;
const BP = JSON.parse(readFileSync(new URL("../../../contracts/pool-evm/test/fixtures/buy-proofs.json", import.meta.url), "utf8")) as { base: Set3 };

const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const w64 = (x: bigint): string => x.toString(16).padStart(64, "0");
const q = (n: number | bigint): string => `0x${BigInt(n).toString(16)}`;
const h32 = (s: string): string => `0x${hex(keccak_256(enc.encode(s)))}`;
const sel = (s: string): string => hex(keccak_256(enc.encode(s)).subarray(0, 4));
const TOPIC = {
  dep: "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549",
  wd: "0xfabb9e7afa4ef595f60e1ae9041b2b311b4acb27aeaed4b11b6f2abf689af10a",
  buy: "0xb8a1e6c10d45357f60b093ab761ca4af74bf300c039aa105fb946f7e5105727d",
};

// ---- a mock chain: blocks every 2 s, the pool's logs, and its views at each block (pool-evm.test.ts's) ----
const T0 = 1_800_000_000n;
const POOL = BP.base.pool;
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const W_LOWER = "000000000000000000000000000000000000beef";

type Ev = { block: number; kind: "dep" | "wd" | "buy"; leaf: bigint; label?: bigint };
type Chain = { events: Ev[]; head: number; finalized: number; ts: (n: number) => bigint; hashOf: (n: number) => string };
const chain = (events: Ev[], head = 100, finalized = head - 10): Chain => ({ events, head, finalized, ts: (n) => T0 + 2n * BigInt(n), hashOf: (n) => h32(`block ${n}`) });
const deps = (s: Set3, blocks: number[]): Ev[] => blocks.map((block, i) => ({ block, kind: "dep", leaf: BigInt(s.commitments[i]!), label: BigInt(s.labels[i]!) }));

function rawLogs(c: Chain): Record<string, unknown>[] {
  const per = new Map<number, number>();
  return c.events.map((e, i) => {
    const logIndex = per.get(e.block) ?? 0;
    per.set(e.block, logIndex + 1);
    const data =
      e.kind === "dep" ? w64(e.leaf) + w64(e.label!) + w64(10n ** 18n) + w64(77n)
      : w64(BigInt(FEE_TO)) + w64(4n * 10n ** 17n) + w64(10n ** 15n) + w64(55n + BigInt(i)) + w64(e.leaf) + (e.kind === "buy" ? w64(0x70c1en) + w64(1000n) : "");
    const who = e.kind === "dep" ? "d0d0" : W_LOWER;
    return {
      address: POOL, topics: [TOPIC[e.kind], `0x${who.padStart(64, "0")}`], data: `0x${data}`, blockNumber: q(e.block), blockHash: c.hashOf(e.block),
      logIndex: q(logIndex + 3), transactionHash: h32(`tx ${i}`), transactionIndex: q(logIndex), removed: false,
    };
  });
}

/** The pool's views at block n: its trees after every event up to n, and each root's block time. */
function viewsAt(c: Chain, n: number) {
  const evs = c.events.filter((e) => e.block <= n);
  const st = new VaultTree(), lt = new VaultTree();
  const stateTimes = new Map<bigint, bigint>(), labelTimes = new Map<bigint, bigint>();
  for (const e of evs) {
    st.append([e.leaf]);
    stateTimes.set(st.root!, c.ts(e.block));
    if (e.label !== undefined) (lt.append([e.label]), labelTimes.set(lt.root!, c.ts(e.block)));
  }
  return { root: st.root ?? 0n, size: BigInt(st.size), labelRoot: lt.root ?? 0n, labelSize: BigInt(lt.size), stateTimes, labelTimes };
}

type Over = {
  url?: string;
  /** the RPC's latest block, by call (the chain's head unless given) */
  latest?: (call: number) => number;
  /** the RPC's finalized block, by call */
  finalized?: (call: number) => number;
  /** a block number it answers null for, by call */
  unknown?: (n: number, call: number) => boolean;
  hashOf?: (n: number) => string;
  /** every block it answers on eth_getBlockByNumber (by tag or number), as its number */
  blocks?: number[];
  log?: string[];
};
function rpc(c: Chain, o: Over = {}): EvmRpc {
  let fin = 0, lat = 0, byNum = 0;
  const hashOf = (n: number) => (o.hashOf ?? c.hashOf)(n);
  const block = (n: number) => {
    if (n > c.head) return null;
    o.blocks?.push(n);
    return { number: q(n), hash: hashOf(n), timestamp: q(c.ts(n)), baseFeePerGas: q(1_000_000n + BigInt(n)), parentHash: hashOf(n - 1) };
  };
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    o.log?.push(`${method} ${JSON.stringify(params)}`);
    switch (method) {
      case "eth_chainId": return q(8453n);
      case "eth_getBlockByNumber": {
        const at = params[0] as string;
        if (at === "finalized") return block(o.finalized ? o.finalized(fin++) : c.finalized);
        if (at === "latest") return block(o.latest ? o.latest(lat++) : c.head);
        const n = Number(BigInt(at));
        if (o.unknown?.(n, byNum++)) return null;
        return block(n);
      }
      case "eth_getLogs": {
        const p = params[0] as { address: string; topics: string[][]; fromBlock: string; toBlock: string };
        assert.equal(p.address, POOL.toLowerCase());
        assert.deepEqual(p.topics, [[TOPIC.dep, TOPIC.wd, TOPIC.buy]]);
        const from = Number(BigInt(p.fromBlock)), to = Number(BigInt(p.toBlock));
        return rawLogs(c).filter((l) => Number(BigInt(l.blockNumber as string)) >= from && Number(BigInt(l.blockNumber as string)) <= to);
      }
      case "eth_call": {
        const [{ to, data }, { blockHash }] = params as [{ to: string; data: string }, { blockHash: string }];
        assert.equal(to, POOL.toLowerCase());
        let n = -1;
        for (let k = 0; k <= c.head; k++) if (hashOf(k) === blockHash) n = k;
        if (n < 0) throw new Error("RPC error -32000: header not found");
        const v = viewsAt(c, n);
        const s = data.slice(2, 10), arg = data.length > 10 ? BigInt(`0x${data.slice(10)}`) : 0n;
        const out =
          s === sel("SCOPE()") ? evmPoolScopeOf(POOL, 8453n)
          : s === sel("currentRoot()") ? v.root
          : s === sel("currentTreeSize()") ? v.size
          : s === sel("currentLabelRoot()") ? v.labelRoot
          : s === sel("currentLabelTreeSize()") ? v.labelSize
          : s === sel("stateRootTimes(uint256)") ? (v.stateTimes.get(arg) ?? 0n)
          : s === sel("labelRootTimes(uint256)") ? (v.labelTimes.get(arg) ?? 0n)
          : assert.fail(`unexpected view ${data}`);
        return `0x${w64(out)}`;
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return Object.assign(f, { url: o.url ?? "https://a.example" });
}
const pair = (a: Chain, b: Chain, oa: Over = {}, ob: Over = {}): [EvmRpc, EvmRpc] => [rpc(a, { url: "https://a.example", ...oa }), rpc(b, { url: "https://b.example", ...ob })];
const PIN: EvmPoolPin = { network: "base", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n };
const noWait = async () => {};
/** ms just past block n's time: the cut that keeps every leaf up to block n */
const after = (n: number): bigint => (T0 + 2n * BigInt(n)) * 1000n + 1n;
const answer = (): EvmFeeAnswer => ({ chain: "evm", network: "base", pool: POOL, fee_recipient: FEE_TO, epoch_ms: 60_000, epoch_start_ms: 0, block: "0x0", fee: "0", step: "0" });

/** One provider's reads: each block it answered on eth_getBlockByNumber, the finalized tag, the round's views
 *  (SCOPE and the four), and the log pages. */
function reads() {
  const blocks: number[] = [];
  const log: string[] = [];
  const views = ["SCOPE()", "currentRoot()", "currentTreeSize()", "currentLabelRoot()", "currentLabelTreeSize()"];
  return {
    over: { blocks, log } as Over,
    count: () => ({
      twice: [...new Set(blocks)].filter((n) => blocks.filter((m) => m === n).length > 1),
      fin: log.filter((x) => x.startsWith("eth_getBlockByNumber") && x.includes('"finalized"')).length,
      views: views.map((v) => log.filter((x) => x.startsWith("eth_call") && x.includes(`"0x${sel(v)}"`)).length),
      logs: log.filter((x) => x.startsWith("eth_getLogs")).length,
    }),
    clear: () => ((blocks.length = 0), (log.length = 0)),
  };
}

test("(a) one proof pass on an unchanged head: the pool's time, the epoch's trees and the newest trees read each block once on each provider, and one round of fin, views and logs", async () => {
  // a deposit past the finalized block (90) in this epoch; the head (100) already past it and past the epoch's start
  const c = chain(deps(PP, [95]), 100, 90);
  const ra = reads(), rb = reads();
  const rpcs = pair(c, c, ra.over, rb.over);
  // the clock frozen: the pass is one moment (the memo's window is the card's, never this machine's speed)
  const sync = evmTreeSync({ rpcs, pin: PIN, sleep: noWait, clock: () => 0 });
  const pool = evmPool({ pin: PIN, rpcs, feeRpcs: rpcs, sync, relayFee: async () => answer(), epochFee: () => 0n, sleep: noWait });
  // queue.ts pass(): pool.now, the epoch's trees (no leaf before the epoch's start), then the newest trees
  const nowMs = await pool.now();
  assert.equal(nowMs, c.ts(100) * 1000n);
  const epochStart = nowMs - (nowMs % EVM_EPOCH_MS);
  assert.ok(epochStart <= c.ts(95) * 1000n, "the deposit is in this epoch");
  await assert.rejects(pool.trees(epochStart), PoolNoLeafError);
  const t = await pool.trees(after(95), undefined, { newest: true });
  assert.equal(t.stateTree.size, 1);
  for (const [k, r] of [["a", ra], ["b", rb]] as const) {
    const n = r.count();
    assert.deepEqual(n.twice, [], `provider ${k}: a block answered twice on eth_getBlockByNumber`);
    assert.equal(n.fin, 1, `provider ${k}: the finalized tag read ${n.fin} times`);
    assert.deepEqual(n.views, [1, 1, 1, 1, 1], `provider ${k}: the round's views (SCOPE, root, size, label root, label size) read ${n.views}`);
    assert.equal(n.logs, 1, `provider ${k}: the logs read ${n.logs} times`);
  }
});

test("(b) once the head moves, a new round reads again: the memo expired (the clock) and a new head hash; an expired memo on the same head reads the head only", async () => {
  const c = chain(deps(PP, [95]), 100, 90);
  const ra = reads(), rb = reads();
  let now = 0;
  assert.equal(EVM_NEWEST_REUSE_MS, 1_000);
  const sync = evmTreeSync({ rpcs: pair(c, c, ra.over, rb.over), pin: PIN, sleep: noWait, clock: () => now });
  assert.equal(await sync.now(), c.ts(100) * 1000n);
  assert.equal((await sync.trees(after(95))).stateTree.size, 1);
  // within the window the head is the memo's: a new block mined meanwhile is not read yet
  c.head = 102;
  c.events.push({ block: 101, kind: "dep", leaf: BigInt(PP.commitments[1]!), label: BigInt(PP.labels[1]!) });
  ra.clear(), rb.clear();
  now = EVM_NEWEST_REUSE_MS - 1;
  assert.equal(await sync.now(), c.ts(100) * 1000n, "within the window: the memo");
  assert.equal(ra.count().logs + rb.count().logs + ra.over.blocks!.length + rb.over.blocks!.length, 0, "no read within the window");
  // past it: the new head is read, its hash is not the last round's, so the round runs again, fin, views and logs
  now = EVM_NEWEST_REUSE_MS;
  assert.equal(await sync.now(), c.ts(102) * 1000n, "past the window: the head read again");
  const t = await sync.trees(after(101));
  assert.equal(t.stateTree.size, 2, "the new round's leaves");
  for (const r of [ra, rb]) {
    const n = r.count();
    assert.equal(n.fin, 1);
    assert.deepEqual(n.views, [0, 1, 1, 1, 1], "the views again (SCOPE once a sync)");
    assert.equal(n.logs, 1);
  }
  // the memo expired on the same head: the head alone is read, its hash the last round's, so no fin, view or log read
  ra.clear(), rb.clear();
  now += EVM_NEWEST_REUSE_MS;
  assert.equal((await sync.trees(after(101))).stateTree.size, 2);
  for (const r of [ra, rb]) {
    const n = r.count();
    assert.deepEqual(r.over.blocks, [102], "the head once, no by-number read");
    assert.equal(n.fin, 0);
    assert.deepEqual(n.views, [0, 0, 0, 0, 0]);
    assert.equal(n.logs, 0);
  }
  // a reorg that re-mines the head under the same height: another hash, so a whole round again
  ra.clear(), rb.clear();
  now += EVM_NEWEST_REUSE_MS;
  const hashOf = c.hashOf;
  c.hashOf = (n) => (n === 102 ? h32("re-mined 102") : hashOf(n));
  assert.equal((await sync.trees(after(101))).stateTree.size, 2);
  for (const r of [ra, rb]) assert.equal(r.count().logs, 1, "the round ran again on the new hash");
  // a finalized-tag anchor is never memoised: each round reads it
  assert.ok(ra.count().fin === 1 && rb.count().fin === 1);
});

test("(c) two RPCs whose latest differ by one block: one by-number read, on the higher one only; the agreed block is the lower", async () => {
  const c = chain([], 100, 90);
  const la: string[] = [], lb: string[] = [];
  const b = await evmAgreedBlock(pair(c, c, { latest: () => 100, log: la }, { latest: () => 99, log: lb }), "latest");
  assert.equal(b.number, 99n);
  assert.equal(b.hash, c.hashOf(99));
  assert.deepEqual(la, ['eth_getBlockByNumber ["latest",false]', 'eth_getBlockByNumber ["0x63",false]'], "the higher: its tag, then block 99");
  assert.deepEqual(lb, ['eth_getBlockByNumber ["latest",false]'], "the lower: its tag answer is block 99");
  // the same the other way round, and at the finalized tag
  la.length = 0, lb.length = 0;
  assert.equal((await evmAgreedBlock(pair(c, c, { finalized: () => 89, log: la }, { finalized: () => 90, log: lb }), "finalized")).number, 89n);
  assert.equal(la.length, 1);
  assert.deepEqual(lb, ['eth_getBlockByNumber ["finalized",false]', 'eth_getBlockByNumber ["0x59",false]']);
  // the same block on both tags: no by-number read at all
  la.length = 0, lb.length = 0;
  assert.equal((await evmAgreedBlock(pair(c, c, { log: la }, { log: lb }), "latest")).number, 100n);
  assert.equal(la.length + lb.length, 2);
  // the higher one does not know block n yet: a lag
  await assert.rejects(evmAgreedBlock(pair(c, c, { latest: () => 100, unknown: () => true }, { latest: () => 99 }), "latest"), (e) => e instanceof EvmLagError && /rpc 0 does not know block 99 yet/.test(e.message));
  // a tag answer of null: a lag
  await assert.rejects(evmAgreedBlock(pair(c, c, { latest: () => 101 }, {}), "latest"), (e) => e instanceof EvmLagError && /an RPC has no latest block/.test(e.message));
});

test("(d) a different block at one height: a lag at the newest tag, refused at the finalized tag", async () => {
  const c = chain([], 100, 90);
  const other = (at: number) => ({ hashOf: (n: number) => (n === at ? h32(`other ${n}`) : c.hashOf(n)) });
  // the two tags name one height with two hashes
  await assert.rejects(evmAgreedBlock(pair(c, c, {}, other(100)), "latest"), (e) => e instanceof EvmLagError && /hold different blocks at 100/.test(e.message));
  await assert.rejects(evmAgreedBlock(pair(c, c, {}, other(90)), "finalized"), (e) => e instanceof PoolReadError && !(e instanceof EvmLagError) && /hold different blocks at 90/.test(e.message));
  // the higher one's block at the lower one's height is another block
  await assert.rejects(evmAgreedBlock(pair(c, c, { latest: () => 100, ...other(99) }, { latest: () => 99 }), "latest"), (e) => e instanceof EvmLagError && /hold different blocks at 99/.test(e.message));
  await assert.rejects(evmAgreedBlock(pair(c, c, { finalized: () => 89 }, { finalized: () => 90, ...other(89) }), "finalized"), (e) => e instanceof PoolReadError && /hold different blocks at 89/.test(e.message));
  // one hash with two times: the same refusal
  const late = (at: number): [EvmRpc, EvmRpc] => [rpc(c), rpc({ ...c, ts: (n) => (n === at ? T0 + 1n : c.ts(n)) }, { url: "https://b.example" })];
  await assert.rejects(evmAgreedBlock(late(100), "latest"), (e) => e instanceof EvmLagError && /hold different blocks at 100/.test(e.message));
  await assert.rejects(evmAgreedBlock(late(90), "finalized"), (e) => e instanceof PoolReadError && /hold different blocks at 90/.test(e.message));
});

// review of evm-first-proof-inside-ten-seconds, item 7: evmAgreedBlock's two reads (both tags, then the higher RPC's block
// by number) are one agreed read on the pair's seats, so a provider that answered one seat's tag never sits on the other
// seat while the read by number runs. Here seat 0's provider a answers the tag, is out at the read by number and seat 0
// moves to c; a call on seat 1 meanwhile whose provider b is out must not take a (it answered seat 0 in this read).
test("evmAgreedBlock is one agreed read: a provider that answered seat 0's tag is never seat 1's while the read by number runs", async () => {
  const blk = (n: number) => ({ number: q(n), hash: h32(`block ${n}`), timestamp: q(T0 + BigInt(n) * 2n) });
  const out = () => new Error("HTTP 410");
  let cAsked: () => void = () => {};
  const asked = new Promise<void>((r) => (cAsked = r));
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let bTag = false;
  const mk = (url: string, f: (m: string, p: readonly unknown[]) => Promise<unknown>): EvmRpc => Object.assign(f, { url });
  const a = mk("https://a.example", async (m, p) => (m === "eth_getBlockByNumber" && p[0] === "latest" ? blk(101) : Promise.reject(out())));
  const b = mk("https://b.example", async (m, p) => (m === "eth_getBlockByNumber" && p[0] === "latest" && !bTag ? ((bTag = true), blk(100)) : Promise.reject(out())));
  const c = mk("https://c.example", async (m, p) => {
    assert.deepEqual([m, p[0]], ["eth_getBlockByNumber", q(100)]);
    cAsked();
    await held;
    return blk(100);
  });
  const pair = evm.evmPair([a, b, c]);
  const got = evmAgreedBlock(pair, "latest", undefined, async () => {});
  await asked;
  assert.equal(pair[0].url, "https://c.example", "seat 0 moved off a for the read by number");
  await assert.rejects(pair[1]("eth_chainId", []), /HTTP 410/);
  assert.equal(pair[1].url, "https://b.example", "seat 1 never on a, which answered seat 0's tag in this read");
  release();
  assert.equal((await got).number, 100n);
});
