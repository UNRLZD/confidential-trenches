// node --test packages/wallet/test/pool-evm.test.ts: the EVM pool as a pool of the proof queue (card notes-per-pool-evm,
// src/pool/evm.ts). The context and scope are checked byte for byte against the pool's forge fixtures
// (contracts/pool-evm/test/fixtures/pool-proofs.json and buy-proofs.json: real proofs the pool's Foundry tests land,
// each request's context preimage and context recorded by make-pool-proofs.mjs), and the roots the device builds from
// the pool's events against the roots those proofs proved against. The RPCs are a mock chain: blocks, the pool's
// Deposited, Withdrawn and Bought logs as the pool emits them, and its views at each block computed from those logs.
// Test notes only, never money; no key (W is evmAddress of a public key made from a fixed test scalar).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VaultTree } from "@blindfill/kit";
import { evmAddress } from "../src/derive/index.ts";
import { checkPool } from "../src/pool/pool.ts";
import { SOL_LADDER } from "../src/pool/solana.ts";
import {
  EvmLagError, EVM_LADDER, EVM_LAG_TRIES, EVM_LIFE_MS, EVM_POOL_EVENTS, evmContextPreimage, evmEpochBlock, evmNow, evmPool, evmPoolContextOf, evmPoolScopeOf, evmTreeSync,
  type EvmFeeAnswer, type EvmPoolPin, type EvmPoolRequest, type EvmRpc,
} from "../src/pool/evm.ts";

type Spend = { name: string; request: { recipient: string; feeRecipient: string; feeCap: string; deadlineMs: string; refundPrecommitment: string; salt: string; trailing?: string }; contextPreimage: string; context: string; proof: { pubSignals: string[] } };
type Set3 = { pool: string; chainId: string; scope: string; labels: string[]; commitments: string[] };
const fx = (f: string) => JSON.parse(readFileSync(new URL(`../../../contracts/pool-evm/test/fixtures/${f}`, import.meta.url), "utf8"));
const PP = fx("pool-proofs.json") as Set3 & Record<"relayed" | "old_root" | "big_cap" | "zero_withdrawal", Spend>;
const BP = fx("buy-proofs.json") as { local: Set3 & Record<"buy" | "buy2" | "trailing" | "swap" | "big", Spend>; base: Set3 & { buy: Spend }; robinhood: Set3 & { buy: Spend } };

const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const w64 = (x: bigint): string => x.toString(16).padStart(64, "0");
const q = (n: number | bigint): string => `0x${BigInt(n).toString(16)}`;
const h32 = (s: string): string => `0x${hex(keccak_256(enc.encode(s)))}`;
const reqOf = (pool: string, s: Spend): EvmPoolRequest => ({
  processooor: pool,
  relay: { recipient: s.request.recipient, feeRecipient: s.request.feeRecipient, feeCap: BigInt(s.request.feeCap), deadlineMs: BigInt(s.request.deadlineMs), refundPrecommitment: BigInt(s.request.refundPrecommitment), salt: s.request.salt },
});

// the topics, from Foundry's `cast sig-event` of each signature (an encoder that is not this file's), 3 Nov
const TOPIC = {
  dep: "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549",
  wd: "0xfabb9e7afa4ef595f60e1ae9041b2b311b4acb27aeaed4b11b6f2abf689af10a",
  buy: "0xb8a1e6c10d45357f60b093ab761ca4af74bf300c039aa105fb946f7e5105727d",
};
const sel = (s: string): string => hex(keccak_256(enc.encode(s)).subarray(0, 4));

// ---- a mock chain: blocks every 2 s, the pool's logs, and its views at each block ----
const T0 = 1_800_000_000n;
const POOL = BP.base.pool; // 0x...b1f1f001
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const W_KEY = 0x1234567n; // a test scalar, never money
const W_PUB = secp256k1.getPublicKey(Uint8Array.from(Buffer.from(w64(W_KEY), "hex")), true);
const W = evmAddress(W_PUB);

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
    const who = e.kind === "dep" ? "d0d0" : W.slice(2).toLowerCase();
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
  url?: string; chainId?: bigint; scope?: bigint;
  /** the RPC's finalized block, by call */
  finalized?: (call: number) => number;
  /** the RPC's latest block, by call (the chain's head unless given) */
  latest?: (call: number) => number;
  /** a block number it answers null for, by call */
  unknown?: (n: number, call: number) => boolean;
  cap?: number;
  logs?: (l: Record<string, unknown>[], p?: { from: number; to: number }) => Record<string, unknown>[];
  /** before an eth_getLogs page is answered: may throw (a provider's error), may wait (ms, a slow page) */
  getLogs?: (p: { from: number; to: number }) => void | number;
  /** before an eth_call is answered, by its data: may throw */
  call?: (data: string) => void;
  /** the RPC's own `latest` answer, in place of the chain's */
  latestBlock?: () => Record<string, unknown> | null;
  baseFee?: (n: number) => bigint | null;
  /** the number a block is answered with (by number and by hash), in place of its own */
  numberOf?: (n: number) => number;
  /** logs added to a page's answer, after the range filter */
  extra?: (p: { from: number; to: number }) => Record<string, unknown>[];
  view?: (name: string, v: bigint) => bigint;
  hashOf?: (n: number) => string;
  ts?: (n: number) => bigint;
  log?: string[];
};
function rpc(c: Chain, o: Over = {}): EvmRpc {
  let fin = 0, lat = 0, byNum = 0;
  // read on every call: a test may move the chain (a reorg) between two reads
  const hashOf = (n: number) => (o.hashOf ?? c.hashOf)(n), ts = (n: number) => (o.ts ?? c.ts)(n);
  const fee = (n: number) => (o.baseFee ? o.baseFee(n) : 1_000_000n + BigInt(n));
  const block = (n: number) => (n > c.head ? null : { number: q(o.numberOf ? o.numberOf(n) : n), hash: hashOf(n), timestamp: q(ts(n)), baseFeePerGas: fee(n) === null ? undefined : q(fee(n)!), parentHash: hashOf(n - 1) });
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    o.log?.push(`${method} ${JSON.stringify(params, (_, v) => (typeof v === "bigint" ? String(v) : v))}`);
    switch (method) {
      case "eth_chainId": return q(o.chainId ?? 8453n);
      case "eth_getBlockByNumber": {
        const at = params[0] as string;
        if (at === "finalized") return block(o.finalized ? o.finalized(fin++) : c.finalized);
        if (at === "latest") return o.latestBlock ? o.latestBlock() : block(o.latest ? o.latest(lat++) : c.head);
        const n = Number(BigInt(at));
        if (o.unknown?.(n, byNum++)) return null;
        return block(n);
      }
      case "eth_getBlockByHash": {
        for (let n = 0; n <= c.head; n++) if (hashOf(n) === params[0]) return block(n);
        return null;
      }
      case "eth_getLogs": {
        const p = params[0] as { address: string; topics: string[][]; fromBlock: string; toBlock: string };
        assert.equal(p.address, POOL.toLowerCase());
        assert.deepEqual(p.topics, [[TOPIC.dep, TOPIC.wd, TOPIC.buy]]);
        const from = Number(BigInt(p.fromBlock)), to = Number(BigInt(p.toBlock));
        if (o.cap !== undefined && to - from + 1 > o.cap) throw new Error(`RPC error -32614: eth_getLogs is limited to a ${o.cap} range`);
        const slow = o.getLogs?.({ from, to });
        if (typeof slow === "number") await new Promise((r) => setTimeout(r, slow));
        const all = (o.logs ?? ((x) => x))(rawLogs(c), { from, to });
        return [...all.filter((l) => Number(BigInt(l.blockNumber as string)) >= from && Number(BigInt(l.blockNumber as string)) <= to), ...(o.extra?.({ from, to }) ?? [])];
      }
      case "eth_call": {
        const [{ to, data }, { blockHash }] = params as [{ to: string; data: string }, { blockHash: string }];
        assert.equal(to, POOL.toLowerCase());
        o.call?.(data);
        let n = -1;
        for (let k = 0; k <= c.head; k++) if (hashOf(k) === blockHash) n = k;
        if (n < 0) throw new Error("RPC error -32000: header not found");
        const v = viewsAt(c, n);
        const s = data.slice(2, 10), arg = data.length > 10 ? BigInt(`0x${data.slice(10)}`) : 0n;
        const out: [string, bigint] =
          s === sel("SCOPE()") ? ["SCOPE", o.scope ?? evmPoolScopeOf(POOL, o.chainId ?? 8453n)]
          : s === sel("currentRoot()") ? ["currentRoot", v.root]
          : s === sel("currentTreeSize()") ? ["currentTreeSize", v.size]
          : s === sel("currentLabelRoot()") ? ["currentLabelRoot", v.labelRoot]
          : s === sel("currentLabelTreeSize()") ? ["currentLabelTreeSize", v.labelSize]
          : s === sel("stateRootTimes(uint256)") ? ["stateRootTimes", v.stateTimes.get(arg) ?? 0n]
          : s === sel("labelRootTimes(uint256)") ? ["labelRootTimes", v.labelTimes.get(arg) ?? 0n]
          : assert.fail(`unexpected view ${data}`);
        return `0x${w64(o.view ? o.view(out[0], out[1]) : out[1])}`;
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return Object.assign(f, { url: o.url ?? "https://a.example" });
}
const pair = (a: Chain, b: Chain, oa: Over = {}, ob: Over = {}): [EvmRpc, EvmRpc] => [rpc(a, { url: "https://a.example", ...oa }), rpc(b, { url: "https://b.example", ...ob })];
const PIN: EvmPoolPin = { network: "base", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n };
const noWait = { sleep: async () => {} };
const sync = (rpcs: [EvmRpc, EvmRpc], sleep: () => Promise<void> = async () => {}) => evmTreeSync({ rpcs, pin: PIN, sleep });
/** ms just past block n's time: the cut that keeps every leaf up to block n */
const after = (n: number): bigint => (T0 + 2n * BigInt(n)) * 1000n + 1n;

// ---- the pool's own computations, against its forge fixtures ----

test("the topics are keccak256 of the pool's event signatures (cast sig-event)", () => {
  assert.equal(h32(EVM_POOL_EVENTS.Deposited), TOPIC.dep);
  assert.equal(h32(EVM_POOL_EVENTS.Withdrawn), TOPIC.wd);
  assert.equal(h32(EVM_POOL_EVENTS.Bought), TOPIC.buy);
});

test("the scope is the pool's on each chain (State.sol:105)", () => {
  for (const s of [PP, BP.local, BP.base, BP.robinhood]) assert.equal(evmPoolScopeOf(s.pool, BigInt(s.chainId)).toString(), s.scope, s.chainId);
});

test("the context of every forge request equals the pool's, byte for byte, and is its proof's 8th signal", () => {
  const all: [Set3, Spend][] = [
    ...(["relayed", "old_root", "big_cap", "zero_withdrawal"] as const).map((k) => [PP, PP[k]] as [Set3, Spend]),
    ...(["buy", "buy2", "swap", "big"] as const).map((k) => [BP.local, BP.local[k]] as [Set3, Spend]),
    [BP.base, BP.base.buy], [BP.robinhood, BP.robinhood.buy],
  ];
  for (const [s, sp] of all) {
    const scope = BigInt(s.scope);
    assert.equal(`0x${hex(evmContextPreimage(reqOf(s.pool, sp), scope))}`, sp.contextPreimage, `${sp.name} preimage`);
    assert.equal(evmPoolContextOf(reqOf(s.pool, sp), scope).toString(), sp.context, `${sp.name} context`);
    assert.equal(sp.context, sp.proof.pubSignals[7], `${sp.name} signal`);
  }
  // a request with a word after RelayData is one the device never makes: its context is not the 192-byte one
  assert.notEqual(evmPoolContextOf(reqOf(BP.local.pool, BP.local.trailing), BigInt(BP.local.scope)).toString(), BP.local.trailing.context);
});

test("trees: the device's roots from the pool's logs are the roots the forge proofs proved against", async () => {
  for (const s of [BP.base, BP.robinhood]) {
    const c = chain(deps(s, [10, 12, 15]));
    const t = await evmTreeSync({ rpcs: pair(c, c, { chainId: BigInt(s.chainId) }, { chainId: BigInt(s.chainId) }), pin: { ...PIN, network: s === BP.base ? "base" : "robinhood" }, ...noWait }).trees(after(20));
    assert.equal(t.stateRoot.toString(), s.buy.proof.pubSignals[3], `${s.chainId} state root`);
    assert.equal(t.labelRoot.toString(), s.buy.proof.pubSignals[5], `${s.chainId} label root`);
  }
  // pool-proofs' leaves (chain 31337's): the cut after two deposits is old_root's root, after three relayed's
  const c = chain([...deps(PP, [10, 12, 15]), { block: 30, kind: "wd", leaf: 999n }, { block: 30, kind: "buy", leaf: 998n }]);
  const s = sync(pair(c, c));
  const two = await s.trees(after(12));
  assert.equal(two.stateRoot.toString(), PP.old_root.proof.pubSignals[3]);
  assert.equal(two.labelRoot.toString(), PP.old_root.proof.pubSignals[5]);
  const three = await s.trees(after(15));
  assert.equal(three.stateRoot.toString(), PP.relayed.proof.pubSignals[3]);
  assert.equal(three.labelRoot.toString(), PP.relayed.proof.pubSignals[5]);
  // the cut is by block time: a leaf at exactly beforeMs is out
  assert.equal((await s.trees((T0 + 2n * 15n) * 1000n)).stateRoot.toString(), PP.old_root.proof.pubSignals[3]);
  // Withdrawn and Bought each add a state leaf, never a label
  const all = await s.trees(after(31));
  assert.equal(all.stateTree.size, 5);
  assert.equal(all.labelRoot.toString(), PP.relayed.proof.pubSignals[5]);
  await assert.rejects(s.trees(after(9)), /no leaf before/);
});

// ---- the two-RPC sync's refusals ----

const C3 = () => chain([...deps(PP, [10, 12, 15]), { block: 20, kind: "wd", leaf: 999n }]);

test("a dropped log or a changed leaf on one RPC is refused", async () => {
  const c = C3();
  await assert.rejects(sync(pair(c, c, {}, { logs: (l) => l.filter((_, i) => i !== 1) })).trees(after(25)), /the two RPCs differ at log 1/);
  const flip = (l: Record<string, unknown>[]) => l.map((x, i) => (i === 2 ? { ...x, data: `${(x.data as string).slice(0, 65)}${(x.data as string)[65] === "1" ? "2" : "1"}${(x.data as string).slice(66)}` } : x));
  await assert.rejects(sync(pair(c, c, {}, { logs: flip })).trees(after(25)), /the two RPCs differ at log 2/);
  // the same lie on both RPCs: the pool's own views refuse the trees built from it, at once (the newest block did not
  // move, so it is no reorg)
  const waits: number[] = [];
  await assert.rejects(sync(pair(c, c, { logs: flip }, { logs: flip }), async () => void waits.push(1)).trees(after(25)), /the state tree from the logs .* is not the pool's/);
  assert.deepEqual(waits, []);
  const drop = (l: Record<string, unknown>[]) => l.filter((_, i) => i !== 3);
  await assert.rejects(sync(pair(c, c, { logs: drop }, { logs: drop })).trees(after(25)), /the state tree from the logs \(3 leaves\) is not the pool's/);
});

test("another root on one RPC, or a root the pool never recorded at the cut's time, is refused", async () => {
  const c = C3();
  const off = (name: string) => ({ view: (n: string, v: bigint) => (n === name ? v + 1n : v) });
  await assert.rejects(sync(pair(c, c, {}, off("currentRoot"))).trees(after(25)), /the two RPCs differ on currentRoot\(\)/);
  await assert.rejects(sync(pair(c, c, off("currentLabelRoot"), {})).trees(after(25)), /differ on currentLabelRoot\(\)/);
  await assert.rejects(sync(pair(c, c, off("currentTreeSize"), off("currentTreeSize"))).trees(after(25)), /state tree from the logs/);
  await assert.rejects(sync(pair(c, c, off("currentLabelRoot"), off("currentLabelRoot"))).trees(after(25)), /label tree from the logs/);
  await assert.rejects(sync(pair(c, c, off("stateRootTimes"), off("stateRootTimes"))).trees(after(25)), /the state root built from the cut is not the pool's root of block 20/);
  await assert.rejects(sync(pair(c, c, off("labelRootTimes"), off("labelRootTimes"))).trees(after(25)), /the label root built from the cut is not the pool's root of block 15/);
  // one RPC's time of a leaf's block differs
  await assert.rejects(sync(pair(c, c, {}, { ts: (n) => T0 + 2n * BigInt(n) + (n === 15 ? 1n : 0n) })).trees(after(25)), /differ on its time|hold different blocks/);
});

test("a lagging RPC is a retry, then the answer; one that stays behind is refused", async () => {
  const c = C3();
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  // RPC b's newest block is before the cut for two reads, then past it
  const behind = { latest: (k: number) => (k < 2 ? 22 : 100), finalized: (k: number) => (k < 2 ? 12 : 90) };
  const t = await evmTreeSync({ rpcs: pair(c, c, {}, behind), pin: PIN, sleep }).trees(after(25));
  assert.equal(t.stateTree.size, 4);
  assert.deepEqual(waits, [2000, 2000]);
  // RPC b does not know the anchor block for its first read
  waits.length = 0;
  const t2 = await evmTreeSync({ rpcs: pair(c, c, {}, { unknown: (n, k) => n === 90 && k === 0 }), pin: PIN, sleep }).trees(after(25));
  assert.equal(t2.stateRoot, t.stateRoot);
  assert.deepEqual(waits, [2000]);
  // never catches up: refused after EVM_LAG_TRIES reads, with no answer
  waits.length = 0;
  await assert.rejects(evmTreeSync({ rpcs: pair(c, c, {}, { latest: () => 22, finalized: () => 12 }), pin: PIN, sleep }).trees(after(25)), /has not reached/);
  assert.equal(waits.length, EVM_LAG_TRIES - 1);
});

test("two RPCs whose latest blocks differ: the read binds to the lower one, one hash on both; two finalized blocks at one height are refused", async () => {
  const c = C3();
  const la: string[] = [], lb: string[] = [];
  const t = await sync(pair(c, c, { latest: () => 100, log: la }, { latest: () => 95, log: lb })).trees(after(25));
  for (const l of [la, lb]) {
    assert.ok(l.some((x) => x.startsWith('eth_getLogs [{"address"') && x.endsWith('"toBlock":"0x5f"}]')), "both read up to block 95");
    assert.ok(l.some((x) => x.startsWith("eth_call") && x.includes(c.hashOf(95))), "the views are read at block 95's hash");
    assert.ok(!l.some((x) => x.startsWith("eth_call") && x.includes(c.hashOf(100))), "never at RPC a's own latest");
  }
  assert.equal(t.stateTree.size, 4);
  // the two RPCs' latest blocks at one height are two blocks: a retry, then the agreed one
  const waits: number[] = [];
  let calls = 0;
  const fork = { hashOf: (n: number) => (n === 100 && calls++ < 2 ? h32("other 100") : c.hashOf(n)) };
  assert.equal((await evmTreeSync({ rpcs: pair(c, c, {}, fork), pin: PIN, sleep: async (ms) => void waits.push(ms) }).trees(after(25))).stateTree.size, 4);
  assert.deepEqual(waits, [2000]);
  await assert.rejects(sync(pair(c, c, {}, { hashOf: (n) => (n === 90 ? h32("other 90") : c.hashOf(n)) })).trees(after(25)), /hold different blocks at 90/);
});

test("a range-cap error halves that RPC's page, and the sync still reads every block", async () => {
  const c = chain([...deps(PP, [10, 1200, 4800]), { block: 4900, kind: "buy", leaf: 997n }], 5000, 4000);
  const la: string[] = [];
  const t = await sync(pair(c, c, { cap: 200, log: la }, {})).trees(after(4950));
  assert.equal(t.stateTree.size, 4);
  const ranges = la.filter((x) => x.startsWith("eth_getLogs")).map((x) => x.match(/"fromBlock":"(0x[0-9a-f]+)","toBlock":"(0x[0-9a-f]+)"/)!.slice(1).map((h) => Number(BigInt(h))));
  // the first pages are refused and halved down to 156 blocks; the pages then tile 1..5000 with no gap
  assert.ok(ranges.length > 25);
  const ok = ranges.filter(([f, t]) => t! - f! + 1 <= 200);
  assert.equal(ok[0]![0], 1);
  for (let i = 1; i < ok.length; i++) assert.equal(ok[i]![0], ok[i - 1]![1]! + 1);
  assert.equal(ok[ok.length - 1]![1], 5000);
  // a provider that refuses even one block is an error, never a smaller tree
  await assert.rejects(sync(pair(c, c, { cap: 0 }, {})).trees(after(4950)), /limited to a 0 range/);
});

test("a log that is not the pool's leaf event, out of order, or not of the anchor's block is refused", async () => {
  const c = C3();
  const edit = (f: (x: Record<string, unknown>, i: number) => Record<string, unknown>) => ({ logs: (l: Record<string, unknown>[]) => l.map(f) });
  const at1 = (f: (x: Record<string, unknown>) => Record<string, unknown>) => edit((x, i) => (i === 1 ? f(x) : x));
  const cases: [Over, RegExp][] = [
    [at1((x) => ({ ...x, address: "0x00000000000000000000000000000000b1f1f002" })), /not the pool's log/],
    [at1((x) => ({ ...x, removed: true })), /a removed log/],
    [at1((x) => ({ ...x, topics: [h32("Other(uint256)"), (x.topics as string[])[1]] })), /not Deposited, Withdrawn or Bought/],
    [at1((x) => ({ ...x, data: `${x.data}00` })), /not 4 data words/],
    [at1((x) => ({ ...x, topics: [(x.topics as string[])[0], `0x${"ff".repeat(32)}`] })), /not an address/],
    [{ logs: (l) => [l[1]!, l[0]!, ...l.slice(2)] }, /not in order/],
    [at1((x) => ({ ...x, data: `0x${w64(0n)}${(x.data as string).slice(66)}` })), /not a field element above 0/],
  ];
  for (const [o, re] of cases) await assert.rejects(sync(pair(c, c, o, o)).trees(after(25)), re);
  // a log in the anchor's block that names another hash
  const at90 = chain([...deps(PP, [10, 12, 90])]);
  const o = edit((x, i) => (i === 2 ? { ...x, blockHash: h32("other 90") } : x));
  await assert.rejects(sync(pair(at90, at90, o, o)).trees(after(80)), /a log of block 90 is not of the anchor/);
  // and one in the newest agreed block's (100, past the finalized 90)
  const at100 = chain([...deps(PP, [10, 12, 100])]);
  const o100 = edit((x, i) => (i === 2 ? { ...x, blockHash: h32("other 100") } : x));
  await assert.rejects(sync(pair(at100, at100, o100, o100)).trees(after(80)), /a log of block 100 is not of the anchor/);
});

test("a pool on another chain, or another pool's SCOPE, is refused", async () => {
  const c = C3();
  await assert.rejects(sync(pair(c, c, {}, { chainId: 84532n })).trees(after(25)), /not base's 8453/);
  await assert.rejects(sync(pair(c, c, { scope: 5n }, { scope: 5n })).trees(after(25)), /SCOPE\(\): not the scope/);
  assert.throws(() => sync([rpc(c, { url: "https://same.example" }), rpc(c, { url: "https://same.example" })]), /one provider twice/);
});

test("the cache never advances past finalized: each read starts past the finalized block, the tail is read again", async () => {
  const c = C3();
  const la: string[] = [];
  let fin = 50;
  const s = sync(pair(c, c, { log: la, finalized: () => fin }, { finalized: () => fin }));
  await s.trees(after(25));
  fin = 90;
  la.length = 0;
  await s.trees(after(25));
  assert.deepEqual(la.filter((x) => x.startsWith("eth_getLogs")).map((x) => x.match(/"fromBlock":"(0x[0-9a-f]+)"/)![1]), ["0x33"]);
  // a leaf past the finalized 90 is in every read (the newest agreed block is 100), and never cached: the next read
  // starts at 91 again, in an epoch read and a deposit's own note's read alike
  c.events.push({ block: 95, kind: "dep", leaf: 1234n, label: 4321n });
  for (const opts of [{ newest: true }, undefined]) {
    la.length = 0;
    assert.equal((await s.trees(after(96), undefined, opts)).stateTree.size, 5);
    assert.deepEqual(la.filter((x) => x.startsWith("eth_getLogs")).map((x) => x.match(/"fromBlock":"(0x[0-9a-f]+)","toBlock":"(0x[0-9a-f]+)"/)!.slice(1)), [["0x5b", "0x64"]]);
  }
});

test("now is the lower of the two RPCs' latest block times, never a finalized one", async () => {
  const c = C3();
  assert.equal(await evmNow(pair(c, c, { latest: () => 100 }, { latest: () => 99 })), (T0 + 198n) * 1000n);
  assert.equal(await evmNow(pair(c, c, { latest: () => 70, finalized: () => 50 }, { latest: () => 99 })), (T0 + 140n) * 1000n);
});

test("the epoch's first block is the first at or after its start, the same on both RPCs", async () => {
  const c = C3();
  const start = (T0 + 2n * 41n) * 1000n - 1000n; // between block 40 and 41
  const b = await evmEpochBlock(pair(c, c), start);
  assert.equal(b.number, 41n);
  assert.equal(b.hash, c.hashOf(41));
  assert.equal((await evmEpochBlock(pair(c, c), (T0 + 2n * 41n) * 1000n)).number, 41n);
  await assert.rejects(evmEpochBlock(pair(c, c, {}, { hashOf: (n) => (n === 41 ? h32("other 41") : c.hashOf(n)) }), start), /hold different blocks at 41/);
  await assert.rejects(evmEpochBlock(pair(c, c, {}, { hashOf: (n) => (n === 40 ? h32("other 40") : c.hashOf(n)) }), start), /hold different blocks at 40/);
});

// ---- bind ----

const EPOCH = 1_800_000_060_000n; // block 30's time is T0 + 60 s: the epoch's first block
const feeRule = (seen: unknown[]) => (at: { block: bigint; baseFeePerGas: bigint; depth: number }) => (seen.push(at), 10n ** 13n * BigInt(at.depth + 1));
const answer = (over: Partial<EvmFeeAnswer> = {}): EvmFeeAnswer => ({ chain: "evm", network: "base", pool: POOL, fee_recipient: FEE_TO, epoch_ms: 60_000, epoch_start_ms: Number(EPOCH), block: "0x1e", fee: "30000000000000", step: "10000000000000", ...over });
// the epoch's first block is 30, above the finalized 20 (a finalized block lags past a life): with its own leaf the tree there holds 3 leaves (depth 2); without it 2 (depth 1);
// with the five later leaves 8 (depth 3)
const CB = () => chain([...deps(PP, [10, 12, 30]), { block: 31, kind: "wd", leaf: 999n }, { block: 32, kind: "wd", leaf: 998n }, { block: 33, kind: "wd", leaf: 997n }, { block: 34, kind: "wd", leaf: 996n }, { block: 35, kind: "wd", leaf: 995n }], 40, 20);
const poolOf = (c: Chain, ans: (e: bigint) => EvmFeeAnswer = () => answer(), seen: unknown[] = []) =>
  evmPool({ pin: PIN, rpcs: pair(c, c), relayFee: async (e) => ans(e), epochFee: feeRule(seen), salt: () => Uint8Array.from(Buffer.from(PP.relayed.request.salt.slice(2), "hex")), ...noWait });
const bindArgs = (over: Record<string, unknown> = {}) => ({ chunk: 4n * 10n ** 17n, wallet: { address: W, publicKey: W_PUB }, refundPrecommitment: 5n, epochStartMs: EPOCH, deadlineMs: EPOCH + EVM_LIFE_MS, ...over });

test("bind: the pool's context of W's request, its fee the device's own from the epoch's first block and depth", async () => {
  const seen: unknown[] = [];
  const p = poolOf(CB(), undefined, seen);
  checkPool(p);
  assert.equal(p.scope, evmPoolScopeOf(POOL, 8453n));
  const b = await p.bind(bindArgs());
  assert.deepEqual(seen, [{ block: 30n, baseFeePerGas: 1_000_030n, depth: 2 }]);
  assert.equal(b.feeCap, 3n * 10n ** 13n);
  assert.deepEqual(b.request, { processooor: POOL, relay: { recipient: W, feeRecipient: FEE_TO, feeCap: 3n * 10n ** 13n, deadlineMs: EPOCH + EVM_LIFE_MS, refundPrecommitment: 5n, salt: PP.relayed.request.salt } });
  assert.equal(b.context, evmPoolContextOf(b.request, p.scope));
});

test("bind refuses the helper's fee unless it is the device's, for this pool and epoch, and a W, chunk or deadline the pool would not take", async () => {
  const c = CB();
  const cases: [Partial<EvmFeeAnswer>, RegExp][] = [
    [{ fee: "40000000000000" }, /is not the epoch's fee/],
    [{ pool: "0x00000000000000000000000000000000b1f1f002" }, /not this pool's/],
    [{ fee_recipient: "0x000000000000000000000000000000000000fee2" }, /not this pool's/],
    [{ network: "robinhood" }, /not this pool's/],
    [{ block: "0x1f" }, /not its first block/],
    [{ epoch_start_ms: Number(EPOCH) + 60_000 }, /not this epoch's/],
  ];
  for (const [o, re] of cases) await assert.rejects(poolOf(c, () => answer(o)).bind(bindArgs()), re);
  const p = poolOf(c);
  await assert.rejects(p.bind(bindArgs({ wallet: { address: W.toLowerCase(), publicKey: W_PUB } })), /EIP-55 of its secp256k1 public key/);
  await assert.rejects(p.bind(bindArgs({ wallet: { address: evmAddress(secp256k1.getPublicKey(Uint8Array.from(Buffer.from(w64(7n), "hex")), true)), publicKey: W_PUB } })), /EIP-55/);
  await assert.rejects(p.bind(bindArgs({ deadlineMs: EPOCH + EVM_LIFE_MS + 1n })), /deadlineMs/);
  await assert.rejects(p.bind(bindArgs({ epochStartMs: EPOCH + 1n, deadlineMs: EPOCH + 1n + EVM_LIFE_MS })), /epochStartMs/);
  await assert.rejects(p.bind(bindArgs({ chunk: 6n * 10n ** 13n - 1n })), /backstop/);
  await assert.rejects(p.bind(bindArgs({ refundPrecommitment: 1n << 254n })), /refundPrecommitment/);
  // a deadline already within the send margin of the pool's time
  const late = chain(CB().events, 400, 350);
  await assert.rejects(poolOf(late).bind(bindArgs()), /too close to send/);
});

// ---- the tail past finalized (M371 (1)) ----

test("a tail reorged between two reads: the second read sees the new leaves, and the cache never held the old ones", async () => {
  const c = C3(); // head 100, finalized 90
  const A = 1234n, B = 5678n;
  c.events.push({ block: 95, kind: "dep", leaf: A, label: 4321n });
  const la: string[] = [];
  const s = sync(pair(c, c, { log: la }, {}));
  const one = await s.trees(after(96));
  assert.equal(one.stateRoot, new VaultTree([...c.events.map((e) => e.leaf)]).root);
  // a reorg from block 93: A is gone, B lands at 96
  const old = c.hashOf;
  c.hashOf = (n) => (n >= 93 ? h32(`fork ${n}`) : old(n));
  c.events.splice(c.events.findIndex((e) => e.leaf === A), 1, { block: 96, kind: "dep", leaf: B, label: 8765n });
  la.length = 0;
  const two = await s.trees(after(97));
  const want = new VaultTree([...c.events.map((e) => e.leaf)]);
  assert.equal(two.stateRoot, want.root);
  assert.equal(two.stateTree.size, 5);
  assert.deepEqual(la.filter((x) => x.startsWith("eth_getLogs")).map((x) => x.match(/"fromBlock":"(0x[0-9a-f]+)"/)![1]), ["0x5b"], "the tail is read again from 91");
  // the reorged blocks become final: the cache takes B, never A
  c.finalized = 100;
  la.length = 0;
  assert.equal((await s.trees(after(97))).stateRoot, want.root);
  c.head = 110;
  c.events.push({ block: 105, kind: "wd", leaf: 4242n });
  la.length = 0;
  assert.equal((await s.trees(after(106))).stateRoot, new VaultTree([...c.events.map((e) => e.leaf)]).root);
  assert.deepEqual(la.filter((x) => x.startsWith("eth_getLogs")).map((x) => x.match(/"fromBlock":"(0x[0-9a-f]+)"/)![1]), ["0x65"], "the cache holds up to the finalized 100");
});

test("a reorg under one read is a retry, then the new chain's answer", async () => {
  const c = C3();
  c.events.push({ block: 95, kind: "dep", leaf: 1234n, label: 4321n });
  const old = c.hashOf;
  let moved = false;
  // the views are read at the old block 100; then the chain reorgs from 93 before the logs are read
  const reorg = (l: Record<string, unknown>[]) => {
    if (moved) return l;
    moved = true;
    c.hashOf = (n) => (n >= 93 ? h32(`fork ${n}`) : old(n));
    c.events.splice(c.events.length - 1, 1, { block: 96, kind: "dep", leaf: 5678n, label: 8765n });
    return rawLogs(c);
  };
  const waits: number[] = [];
  const t = await evmTreeSync({ rpcs: pair(c, c, { logs: reorg }, { logs: reorg }), pin: PIN, sleep: async (ms) => void waits.push(ms) }).trees(after(97));
  assert.deepEqual(waits, [2000]);
  assert.equal(t.stateRoot, new VaultTree([...c.events.map((e) => e.leaf)]).root);
});

test("a newest agreed block below the finalized one is a retry, never a cache past what was read", async () => {
  const c = C3();
  c.events.push({ block: 88, kind: "dep", leaf: 1234n, label: 4321n });
  const waits: number[] = [];
  const s = evmTreeSync({ rpcs: pair(c, c, {}, { latest: (k) => (k === 0 ? 85 : 100) }), pin: PIN, sleep: async (ms) => void waits.push(ms) });
  assert.equal((await s.trees(after(25))).stateTree.size, 4);
  assert.deepEqual(waits, [2000]);
  assert.equal((await s.trees(after(89))).stateTree.size, 5);
});

test("a reorg one RPC sees first is a retry too; the same differing logs with no reorg are refused at once", async () => {
  const mk = () => { const c = C3(); c.events.push({ block: 95, kind: "dep", leaf: 1234n, label: 4321n }); return c; };
  const ca = mk(), cb = mk();
  const reorg = (c: Chain) => {
    const old = c.hashOf;
    c.hashOf = (n) => (n >= 93 ? h32(`fork ${n}`) : old(n));
    c.events.splice(c.events.length - 1, 1, { block: 96, kind: "dep", leaf: 5678n, label: 8765n });
  };
  let moved = false;
  // RPC b reorgs between the views and the logs; RPC a follows before the retry
  const hook = (l: Record<string, unknown>[]) => (moved ? l : ((moved = true), reorg(cb), rawLogs(cb)));
  const waits: number[] = [];
  const t = await evmTreeSync({ rpcs: pair(ca, cb, {}, { logs: hook }), pin: PIN, sleep: async (ms) => void (waits.push(ms), waits.length === 1 && reorg(ca)) }).trees(after(97));
  assert.deepEqual(waits, [2000]);
  assert.equal(t.stateRoot, new VaultTree([...cb.events.map((e) => e.leaf)]).root);
  // RPC b's logs differ but its block 100 never moved: a lie, refused with no retry
  const c = mk(), w2: number[] = [];
  await assert.rejects(sync(pair(c, c, {}, { logs: (l) => l.map((x, i) => (i === 4 ? { ...x, data: `0x${w64(4242n)}${(x.data as string).slice(66)}` } : x)) }), async () => void w2.push(1)).trees(after(97)), /the two RPCs differ at log 4/);
  assert.deepEqual(w2, []);
});

// ---- the cache's floor: the deploy block and what is already final ----

test("a pool deployed above the finalized block reads at once, with no wait", async () => {
  const c = chain([...deps(PP, [96, 97])]); // head 100, finalized 90
  const waits: number[] = [];
  const t = await evmTreeSync({ rpcs: pair(c, c), pin: { ...PIN, fromBlock: 95n }, sleep: async (ms) => void waits.push(ms) }).trees(after(98));
  assert.equal(t.stateTree.size, 2);
  assert.deepEqual(waits, []);
});

test("a newest agreed block below the deploy block retries, then reads once it passes it", async () => {
  const c = chain([...deps(PP, [96, 97])]);
  const waits: number[] = [];
  const t = await evmTreeSync({ rpcs: pair(c, c, {}, { latest: (k) => (k === 0 ? 92 : 100) }), pin: { ...PIN, fromBlock: 95n }, sleep: async (ms) => void waits.push(ms) }).trees(after(98));
  assert.equal(t.stateTree.size, 2);
  assert.deepEqual(waits, [2000]);
});

test("one RPC behind what is already cached (its finalized and latest below it) retries, never a lie", async () => {
  const c = C3();
  c.events.push({ block: 88, kind: "dep", leaf: 1234n, label: 4321n });
  let finB = 90, latB = (_: number) => 100;
  const waits: number[] = [];
  const s = evmTreeSync({ rpcs: pair(c, c, {}, { finalized: () => finB, latest: (k) => latB(k) }), pin: PIN, sleep: async (ms) => void waits.push(ms) });
  assert.equal((await s.trees(after(89))).stateTree.size, 5); // the cache is at 90, the leaf at 88 in it
  // RPC b's finalized stays at 80; its latest is 85 for one read
  finB = 80;
  latB = (k) => (k === 1 ? 85 : 100);
  assert.equal((await s.trees(after(89))).stateTree.size, 5);
  assert.deepEqual(waits, [2000]);
});

test("the cache never goes down: a finalized block below it leaves it where it is", async () => {
  const c = C3();
  c.events.push({ block: 85, kind: "dep", leaf: 1234n, label: 4321n });
  let finB = 90;
  const la: string[] = [];
  const s = sync(pair(c, c, { log: la }, { finalized: () => finB }));
  await s.trees(after(86));
  finB = 80;
  for (let i = 0; i < 2; i++) {
    la.length = 0;
    assert.equal((await s.trees(after(86))).stateTree.size, 5);
    assert.deepEqual(la.filter((x) => x.startsWith("eth_getLogs")).map((x) => x.match(/"fromBlock":"(0x[0-9a-f]+)"/)![1]), ["0x5b"], `read ${i}: from 91`);
  }
});

// ---- fold 2 (M373): the review's cases ----

const reorgAt = (c: Chain, from: number, change?: () => void) => {
  const old = c.hashOf;
  let moved = false;
  return (l: Record<string, unknown>[]) => {
    if (moved) return l;
    moved = true;
    c.hashOf = (n) => (n >= from ? h32(`fork ${n}`) : old(n));
    change?.();
    return rawLogs(c);
  };
};

test("F1 a reorg on both RPCs that re-mines the newest agreed block holding a pool log is a retry", async () => {
  const c = C3();
  c.events.push({ block: 100, kind: "dep", leaf: 1234n, label: 4321n });
  const r = reorgAt(c, 99);
  const waits: number[] = [];
  // the cut is before block 100 (the anchor is past every cut), but the round reads block 100's log
  const t = await evmTreeSync({ rpcs: pair(c, c, { logs: r }, { logs: r }), pin: PIN, sleep: async (ms) => void waits.push(ms) }).trees(after(99));
  assert.deepEqual(waits, [2000]);
  assert.equal(t.stateTree.size, 4);
});

test("F1b a reorg on both RPCs that replaces the newest block's pool log is a retry, then the new chain", async () => {
  const c = C3();
  c.events.push({ block: 100, kind: "dep", leaf: 1234n, label: 4321n });
  const r = reorgAt(c, 99, () => c.events.splice(c.events.length - 1, 1, { block: 100, kind: "dep", leaf: 5678n, label: 8765n }));
  const waits: number[] = [];
  // the depth after block 100 is the new chain's: 5 leaves (depth 3)
  const d = await evmTreeSync({ rpcs: pair(c, c, { logs: r }, { logs: r }), pin: PIN, sleep: async (ms) => void waits.push(ms) }).depthAt(100n);
  assert.deepEqual(waits, [2000]);
  assert.equal(d, 3);
  assert.equal(c.events.at(-1)!.leaf, 5678n);
});

// one RPC answers `latest` with a block no RPC holds: another hash, an old time
const fakeLatest = (number: number, ts: bigint) => () => ({ number: q(number), hash: h32("a block nobody holds"), timestamp: q(ts), baseFeePerGas: q(1n) });

test("F2a now is the newest block both RPCs agree on, never a time one RPC alone gives", async () => {
  const c = C3(); // block 100's time is T0 + 200 s
  assert.equal(await evmNow(pair(c, c, {}, { latestBlock: fakeLatest(100, T0) })), (T0 + 200n) * 1000n);
});

test("F2b bind refuses a deadline the chain has passed, whatever one RPC says the time is", async () => {
  const late = chain([...deps(PP, [10, 12, 30]), { block: 31, kind: "wd", leaf: 999n }], 400, 350);
  const p = evmPool({ pin: PIN, rpcs: pair(late, late, {}, { latestBlock: fakeLatest(400, T0 + 61n) }), relayFee: async () => answer(), epochFee: () => 3n * 10n ** 13n, salt: () => new Uint8Array(16), ...noWait });
  await assert.rejects(p.bind(bindArgs()), /too close to send/);
});

const HEAD_LAG_TEXT = "RPC error -32602: block range extends beyond current head block: requested 53811322, head 53811277"; // sepolia.base.org, 3 Nov 05:35Z

test("F3a a log index behind its own head (sepolia.base.org's and publicnode's words) is a retry, never a smaller page", async () => {
  for (const text of [HEAD_LAG_TEXT, "RPC error -32000: invalid block range params"]) {
    const c = C3();
    let behind = true;
    const la: string[] = [];
    const lagging = { log: la, getLogs: ({ to }: { to: number }) => { if (behind && to > 98) throw new Error(text); } };
    const waits: number[] = [];
    const t = await evmTreeSync({ rpcs: pair(c, c, lagging, {}), pin: PIN, sleep: async (ms) => void (waits.push(ms), (behind = false)) }).trees(after(25));
    assert.equal(t.stateTree.size, 4);
    assert.deepEqual(waits, [2000], text);
    assert.equal(la.filter((x) => x.startsWith("eth_getLogs")).length, 2, `${text}: one page a round, never halved`);
  }
});

test("F3b only a provider's cap shrinks the page (its real words, thousands separators too), and the page grows back", async () => {
  // publicnode's cap (3 Nov 05:35Z) on one RPC, a docs' "limited to a 2,000 range" on the other
  const c = chain([...deps(PP, [10, 1200, 4800]), { block: 9000, kind: "buy", leaf: 997n }], 20000, 19000);
  const la: string[] = [], lb: string[] = [];
  const capA = { log: la, getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 5000) throw new Error("RPC error -32701: exceed maximum block range: 5000"); } };
  const capB = { log: lb, getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 2000) throw new Error("RPC error -32614: eth_getLogs is limited to a 2,000 range"); } };
  const s = sync(pair(c, c, capA, capB));
  assert.equal((await s.trees(after(9500))).stateTree.size, 4);
  const sizes = (l: string[]) => l.filter((x) => x.startsWith("eth_getLogs")).map((x) => x.match(/"fromBlock":"(0x[0-9a-f]+)","toBlock":"(0x[0-9a-f]+)"/)!.slice(1).map((h) => Number(BigInt(h)))).map(([f, t]) => t! - f! + 1);
  assert.ok(sizes(la).every((n) => n <= 10000) && sizes(la).includes(5000) && !sizes(la).some((n) => n < 2500), `a: ${sizes(la)}`);
  assert.ok(sizes(lb).includes(1250) && !sizes(lb).some((n) => n < 1250), `b: ${sizes(lb)}`);
  // a refused size is not asked again in that read: 10,000, 5,000 and 2,500 refused once each
  assert.equal(sizes(lb).filter((n) => n > 2000).length, 3, `b: ${sizes(lb)}`);
  // a page shrunk by a cap since lifted grows back: after a full page reads, the next is twice as large
  const c2 = chain([...deps(PP, [10, 12, 15])], 3000, 2990);
  let capped = true;
  const l2: string[] = [];
  const s2 = sync(pair(c2, c2, { log: l2, getLogs: ({ from, to }) => { if (capped && to - from + 1 > 100) throw new Error("RPC error -32614: eth_getLogs is limited to a 100 range"); } }, {}));
  await s2.trees(after(20));
  c2.head = 6000; c2.finalized = 5990;
  capped = false;
  l2.length = 0;
  await s2.trees(after(20));
  const grown = sizes(l2);
  assert.ok(grown.length < 12 && grown[1]! === 2 * grown[0]!, `pages after the cap is lifted: ${grown}`);
});

test("F4 one RPC's logs past the finalized block a moment behind the other's is a retry; a finalized log missing is refused", async () => {
  const c = chain([...C3().events, { block: 100, kind: "dep", leaf: 1234n, label: 4321n }], 101, 90);
  let first = true;
  const slowIndex = { logs: (l: Record<string, unknown>[]) => (first ? ((first = false), l.filter((x) => x.blockNumber !== q(100))) : l) };
  const waits: number[] = [];
  const t = await evmTreeSync({ rpcs: pair(c, c, slowIndex, {}), pin: PIN, sleep: async (ms) => void waits.push(ms) }).trees(after(100));
  assert.equal(t.stateTree.size, 5);
  assert.deepEqual(waits, [2000]);
  // one that stays behind never answers: refused after the retries
  const w2: number[] = [];
  await assert.rejects(evmTreeSync({ rpcs: pair(c, c, {}, { logs: (l) => l.filter((x) => x.blockNumber !== q(100)) }), pin: PIN, sleep: async (ms) => void w2.push(ms) }).trees(after(100)), /logs past block 90 are behind/);
  assert.equal(w2.length, EVM_LAG_TRIES - 1);
  // a prefix that lacks a finalized log (block 20, under the finalized 90) is refused at once
  const w3: number[] = [];
  const c3 = C3();
  await assert.rejects(evmTreeSync({ rpcs: pair(c3, c3, {}, { logs: (l) => l.slice(0, -1) }), pin: PIN, sleep: async (ms) => void w3.push(ms) }).trees(after(25)), /the two RPCs differ at log 3/);
  assert.deepEqual(w3, []);
});

test("F5 a pruned state at a view (the Robinhood RPCs' own words) is a retry at a newer anchor", async () => {
  for (const text of ["RPC error -32000: historical state 17babde33c1cae4d846be258743d8cbdc4fcdb030fed59adf0440d388fc8e9e9 is not available", "missing trie node 0xabc (path ) state 0xdef is not available"]) {
    const c = C3();
    let pruned = 1;
    const pruning = { call: (data: string) => { if (data.length > 10 && pruned-- > 0) throw new Error(text); } };
    const waits: number[] = [];
    const t = await evmTreeSync({ rpcs: pair(c, c, pruning, {}), pin: PIN, sleep: async (ms) => void waits.push(ms) }).trees(after(25));
    assert.equal(t.stateTree.size, 4);
    assert.deepEqual(waits, [2000], text);
  }
});

test("F6 a read that fails on one RPC stops the other RPC's paging: nothing runs after trees() rejects", async () => {
  const c = chain([...deps(PP, [10, 12, 15])], 2000, 1990);
  let callsB = 0, inflight = 0;
  const failA = { getLogs: () => { throw new Error("RPC error 429: too many requests"); } };
  // RPC b's pages are slow: the read fails only once its page in flight has settled
  const countB = { cap: 50, getLogs: () => (callsB++, inflight++, 20), logs: (l: Record<string, unknown>[]) => (inflight--, l) };
  await assert.rejects(evmTreeSync({ rpcs: pair(c, c, failA, countB), pin: PIN, sleep: async () => {} }).trees(after(25)), /429/);
  assert.equal(inflight, 0, "a page of RPC b was still in flight when trees() rejected");
  const atReject = callsB;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(callsB, atReject, `RPC b made ${callsB - atReject} more eth_getLogs calls after trees() had failed`);
  assert.ok(atReject <= 2, `RPC b paged on (${atReject} calls) while RPC a had failed`);
});

test("F7 a reorg of the epoch's first block under the search is a retry; the search runs below the agreed newest block", async () => {
  const c = C3();
  const old = c.hashOf;
  let seen = 0;
  c.hashOf = (n) => (n === 41 && seen++ > 0 ? h32("fork 41") : old(n));
  const start = (T0 + 2n * 41n) * 1000n - 1000n;
  await assert.rejects(evmEpochBlock(pair(c, c), start), (e) => e instanceof EvmLagError && /moved under the search/.test(e.message));
  // RPC 0's own latest is a block nobody else holds: the search still runs at the agreed block 100
  const c2 = C3();
  const la: string[] = [];
  assert.equal((await evmEpochBlock(pair(c2, c2, { log: la, latestBlock: fakeLatest(5000, T0 + 10000n) }, {}), start)).number, 41n);
  assert.ok(!la.some((x) => /"0x13(8[0-9a-f]|[0-9a-f]{2})",false/.test(x) && x.includes("0x1388")), "never searched from RPC 0's own block 5000");
});

test("depthAt on the epoch block's own chain: a block no longer at its height is a retry for the caller", async () => {
  const c = CB();
  const s = sync(pair(c, c));
  assert.equal(await s.depthAt(30n, undefined, c.hashOf(30)), 2);
  await assert.rejects(s.depthAt(30n, undefined, h32("fork 30")), (e) => e instanceof EvmLagError && /no longer/.test(e.message));
  // bind re-reads the epoch block on that retry: a reorg at block 30 between the search and the depth read
  const c2 = CB();
  const old = c2.hashOf;
  let reads = 0;
  const flip = { logs: (l: Record<string, unknown>[]) => (reads++ === 0 ? ((c2.hashOf = (n) => (n >= 30 ? h32(`fork ${n}`) : old(n))), rawLogs(c2)) : l) };
  const waits: number[] = [];
  const p = evmPool({ pin: PIN, rpcs: pair(c2, c2, flip, flip), relayFee: async () => answer(), epochFee: feeRule([]), salt: () => new Uint8Array(16), sleep: async (ms) => void waits.push(ms) });
  assert.equal((await p.bind(bindArgs())).feeCap, 3n * 10n ** 13n);
  assert.ok(waits.length >= 1);
});

// ---- the review's surviving mutants (X2-X22): each has its test ----

test("X2 a block that is gone at the anchor's height when a mismatch is checked is a retry, bounded", async () => {
  const c = C3();
  const off = { view: (n: string, v: bigint) => (n === "currentTreeSize" ? v + 1n : v) };
  const waits: number[] = [];
  // RPC b's third read by number (refuse()'s re-read of block 100) answers null
  await assert.rejects(evmTreeSync({ rpcs: pair(c, c, off, { ...off, unknown: (n, k) => n === 100 && k === 2 }), pin: PIN, sleep: async (ms) => void waits.push(ms) }).trees(after(25)), /the state tree from the logs/);
  assert.deepEqual(waits, [2000]);
});

test("X3-X5 an anchor or a leaf's block answered with another time or another number is refused", async () => {
  const c = C3();
  await assert.rejects(sync(pair(c, c, {}, { ts: (n) => T0 + 2n * BigInt(n) + (n === 90 ? 1n : 0n) })).trees(after(25)), /hold different blocks at 90/);
  await assert.rejects(sync(pair(c, c, {}, { numberOf: (n) => (n === 90 ? 91 : n) })).trees(after(25)), /hold different blocks at 90/);
  await assert.rejects(sync(pair(c, c, { numberOf: (n) => (n === 15 ? 16 : n) }, { numberOf: (n) => (n === 15 ? 16 : n) })).trees(after(25)), /not block 15/);
});

test("X6, X7, X14, X22 a log outside its page, two hashes in one block, three topics, a leaf at p: refused", async () => {
  const c = C3();
  const stray = { extra: ({ from }: { from: number }) => (from === 1 ? [{ ...rawLogs(c)[0]!, blockNumber: q(150) }] : []) };
  await assert.rejects(sync(pair(c, c, stray, stray)).trees(after(25)), /outside/);
  const c2 = chain(deps(PP, [10, 12, 12]));
  const twoHashes = { logs: (l: Record<string, unknown>[]) => l.map((x, i) => (i === 2 ? { ...x, blockHash: h32("other 12") } : x)) };
  await assert.rejects(sync(pair(c2, c2, twoHashes, twoHashes)).trees(after(25)), /not in order/);
  const three = { logs: (l: Record<string, unknown>[]) => l.map((x, i) => (i === 1 ? { ...x, topics: [...(x.topics as string[]), h32("x")] } : x)) };
  await assert.rejects(sync(pair(c, c, three, three)).trees(after(25)), /not two topics/);
  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const atP = { logs: (l: Record<string, unknown>[]) => l.map((x, i) => (i === 1 ? { ...x, data: `0x${w64(P)}${(x.data as string).slice(66)}` } : x)) };
  await assert.rejects(sync(pair(c, c, atP, atP)).trees(after(25)), /not a field element above 0/);
});

test("X8 a view at a hash one RPC does not know yet is a retry", async () => {
  const c = C3();
  let once = 1;
  const waits: number[] = [];
  const t = await evmTreeSync({ rpcs: pair(c, c, {}, { call: () => { if (once-- > 0) throw new Error("RPC error -32000: header not found"); } }), pin: PIN, sleep: async (ms) => void waits.push(ms) }).trees(after(25));
  assert.equal(t.stateTree.size, 4);
  assert.deepEqual(waits, [2000]);
});

test("X9 EVM_LADDER: one is the pool's MIN_DEPOSIT, the smallest chunk 10 x one, as SOL_LADDER's", () => {
  assert.equal(EVM_LADDER.one, 10n ** 14n);
  assert.equal(EVM_LADDER.min, 10n ** 15n);
  assert.equal(EVM_LADDER.min / EVM_LADDER.one, SOL_LADDER.min / SOL_LADDER.one);
});

test("X10, X18, X19 the epoch's first block: no base fee, or another time or base fee on RPC 1, is refused", async () => {
  const c = C3();
  const start = (T0 + 2n * 41n) * 1000n - 1000n;
  const noFee = { baseFee: (n: number) => (n === 41 ? null : 1_000_000n + BigInt(n)) };
  await assert.rejects(evmEpochBlock(pair(c, c, noFee, noFee), start), /no base fee/);
  await assert.rejects(evmEpochBlock(pair(c, c, {}, { ts: (n) => T0 + 2n * BigInt(n) + (n === 41 ? 1n : 0n) }), start), /differ on block 41/);
  await assert.rejects(evmEpochBlock(pair(c, c, {}, { baseFee: (n) => 1_000_000n + BigInt(n) + (n === 41 ? 1n : 0n) }), start), /differ on block 41/);
});

test("X11 depthAt past the newest agreed block is a lag, then refused", async () => {
  const c = C3();
  await assert.rejects(sync(pair(c, c)).depthAt(150n), (e) => e instanceof EvmLagError && /below block 150/.test(e.message));
});

test("X12 two reads at once run one after the other: neither sees the other's half-made cache", async () => {
  const c = C3();
  let fin = 50;
  let slow = true;
  // the first read's first page is slow: without one round at a time, the second read caches first and the first then
  // adds its own leaves to the second's
  const o = { finalized: () => fin, getLogs: () => (slow ? ((slow = false), 30) : undefined) };
  const s = sync(pair(c, c, o, { finalized: () => fin }));
  await s.trees(after(25));
  fin = 90;
  slow = true;
  const [x, y] = await Promise.all([s.trees(after(25)), s.trees(after(25))]);
  assert.equal(x.stateTree.size, 4);
  assert.equal(y.stateTree.size, 4);
});

test("X13 a cut with a state leaf but no label is refused (no leaf before)", async () => {
  const c = chain([{ block: 10, kind: "wd", leaf: 999n }, ...deps(PP, [20])]);
  await assert.rejects(sync(pair(c, c)).trees(after(15)), /no leaf before/);
});

test("X15, X20, X21 bind refuses W as the fee recipient, a chunk of 2^128, a salt not of 16 bytes", async () => {
  const c = CB();
  const mk = (pin: EvmPoolPin, salt = () => new Uint8Array(16)) => evmPool({ pin, rpcs: pair(c, c), relayFee: async () => answer({ fee_recipient: pin.feeRecipient }), epochFee: feeRule([]), salt, ...noWait });
  await assert.rejects(mk({ ...PIN, feeRecipient: W }).bind(bindArgs()), /fee recipient/);
  await assert.rejects(mk(PIN).bind(bindArgs({ chunk: 1n << 128n })), /chunk/);
  await assert.rejects(mk(PIN, () => new Uint8Array(15)).bind(bindArgs()), /salt/);
});

test("X16 the wait between retries ends at once when the read is aborted (the real wait)", async () => {
  const c = C3();
  const ac = new AbortController();
  const t0 = Date.now();
  const p = evmTreeSync({ rpcs: pair(c, c, {}, { latest: () => 22, finalized: () => 12 }), pin: PIN }).trees(after(25), ac.signal);
  setTimeout(() => ac.abort(new Error("stopped")), 50);
  await assert.rejects(p, /stopped/);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});
