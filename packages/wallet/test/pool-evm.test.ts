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
import { createHash } from "node:crypto";
import { evmPoolFee, evmPoolGas, evmPoolProvidersOf, evmPoolVenues, SOLANA_RPC_RETRY, SolanaRpcTransportError, solanaSameProvider, VaultTree } from "@blindfill/kit";
import { evmPoolSender } from "../../../apps/helper/src/pool/evm.ts";
import { evmAddress } from "../src/derive/index.ts";
import { checkPool, TAKE_SLACK_MS } from "../src/pool/pool.ts";
import { SOL_LADDER } from "../src/pool/solana.ts";
import { evmRestoreNotes } from "../src/pool/evm-restore.ts";
import {
  EvmLagError, EVM_CHAIN_IDS, EVM_EPOCH_MS, EVM_LADDER, EVM_TRANSFER_RPCS, EVM_LAG_TRIES, EVM_LIFE_MS, EVM_LOG_CEILING_PAGES, EVM_LOG_THROTTLE_TRIES, EVM_POOL_EVENTS, EVM_POOL_READ_BOUND_MS, EVM_POOL_READ_TRIES, EVM_POOL_READ_WAIT_MS, EVM_READ_TRY_MS, EVM_SEND_MARGIN_MS, EVM_SPARE_REST_MS,
  EvmUnansweredError, evmAgreedLogs, evmAgreedRead, evmAnswered, evmContextPreimage, evmEpochBlock, evmLatestHigh, evmNow, evmPair, evmPool, evmPoolContextOf, evmPoolLogPager, evmPoolScopeOf, evmTreeSync,
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
  /** the chain fee oracle's answer (Base's GasPriceOracle, kit pool-fee.ts) by selector, at block n: 7,917 wei of L1
   *  fee (Base Sepolia's for 2,600 bytes, 4 Nov) and no operator fee unless given */
  /** The chain fee contract's answer to selector `sel` at block `n`; `arg` is the call's word (getOperatorFee's gas). */
  chainFee?: (sel: string, n: number, arg: bigint) => bigint;
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
/** A block hash that is its number + 1 (a long chain's hashOf), as that number; -1 for any other. */
const numberIn = (h: string): number => (/^0x0{40}[0-9a-f]{24}$/.test(h) ? Number(BigInt(h) - 1n) : -1);
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
        const guess = numberIn(params[0] as string);
        if (guess >= 0 && guess <= c.head && hashOf(guess) === params[0]) return block(guess);
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
        let n = -1;
        const guess = numberIn(blockHash);
        if (guess >= 0 && guess <= c.head && hashOf(guess) === blockHash) n = guess;
        else for (let k = 0; k <= c.head; k++) if (hashOf(k) === blockHash) n = k;
        if (to === "0x420000000000000000000000000000000000000f" || to === "0x000000000000000000000000000000000000006c") {
          if (n < 0) throw new Error("RPC error -32000: header not found");
          const s = data.slice(2, 10);
          return `0x${w64(o.chainFee ? o.chainFee(s, n, data.length > 10 ? BigInt(`0x${data.slice(10)}`) : 0n) : s === "f1c7a58b" ? 7_917n : 0n)}`;
        }
        assert.equal(to, POOL.toLowerCase());
        o.call?.(data);
        if (n < 0) throw new Error("RPC error -32000: header not found");
        const v = viewsAt(c, n);
        const s = data.slice(2, 10), arg = data.length > 10 ? BigInt(`0x${data.slice(10)}`) : 0n;
        const out: [string, bigint] =
          s === sel("SCOPE()") ? ["SCOPE", o.scope ?? evmPoolScopeOf(POOL, o.chainId ?? 8453n)]
          : s === sel("currentRoot()") ? ["currentRoot", v.root]
          : s === sel("currentTreeSize()") ? ["currentTreeSize", v.size]
          : s === sel("currentTreeDepth()") ? ["currentTreeDepth", BigInt(Math.ceil(Math.log2(Math.max(1, Number(v.size)))))]
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
/** A pool's sync pair and its fee pair (evmPool takes both, card evm-buy-hookdata-fee fold 4 LOW-1): here one pair. */
const pairs = (rpcs: readonly [EvmRpc, EvmRpc]) => ({ rpcs, feeRpcs: rpcs });
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
const feeRule = (seen: unknown[]) => (at: { block: bigint; baseFeePerGas: bigint; depth: number; chainFee: bigint }) => (seen.push(at), 10n ** 13n * BigInt(at.depth + 1));
const answer = (over: Partial<EvmFeeAnswer> = {}): EvmFeeAnswer => ({ chain: "evm", network: "base", pool: POOL, fee_recipient: FEE_TO, epoch_ms: 60_000, epoch_start_ms: Number(EPOCH), block: "0x1e", fee: "30000000000000", step: "10000000000000", ...over });
// the epoch's first block is 30, above the finalized 20 (a finalized block lags past a life): with its own leaf the tree there holds 3 leaves (depth 2); without it 2 (depth 1);
// with the five later leaves 8 (depth 3)
const CB = () => chain([...deps(PP, [10, 12, 30]), { block: 31, kind: "wd", leaf: 999n }, { block: 32, kind: "wd", leaf: 998n }, { block: 33, kind: "wd", leaf: 997n }, { block: 34, kind: "wd", leaf: 996n }, { block: 35, kind: "wd", leaf: 995n }], 40, 20);
const poolOf = (c: Chain, ans: (e: bigint) => EvmFeeAnswer = () => answer(), seen: unknown[] = []) =>
  evmPool({ pin: PIN, ...pairs(pair(c, c)), relayFee: async (e) => ans(e), epochFee: feeRule(seen), salt: () => Uint8Array.from(Buffer.from(PP.relayed.request.salt.slice(2), "hex")), ...noWait });
const bindArgs = (over: Record<string, unknown> = {}) => ({ chunk: 4n * 10n ** 17n, wallet: { address: W, publicKey: W_PUB }, refundPrecommitment: 5n, epochStartMs: EPOCH, deadlineMs: EPOCH + EVM_LIFE_MS, ...over });

test("bind: the pool's context of W's request, its fee the device's own from the epoch's first block and depth", async () => {
  const seen: unknown[] = [];
  const p = poolOf(CB(), undefined, seen);
  checkPool(p);
  assert.equal(p.scope, evmPoolScopeOf(POOL, 8453n));
  const b = await p.bind(bindArgs());
  // the chain fee too: Base's L1 fee bound and operator fee at block 30, the same on both RPCs (card evm-buy-hookdata-fee)
  assert.deepEqual(seen, [{ block: 30n, baseFeePerGas: 1_000_030n, depth: 2, chainFee: 7_917n }]);
  assert.equal(b.feeCap, 3n * 10n ** 13n);
  assert.deepEqual(b.request, { processooor: POOL, relay: { recipient: W, feeRecipient: FEE_TO, feeCap: 3n * 10n ** 13n, deadlineMs: EPOCH + EVM_LIFE_MS, refundPrecommitment: 5n, salt: PP.relayed.request.salt } });
  assert.equal(b.context, evmPoolContextOf(b.request, p.scope));
});

test("L1 bind's fee takes the chain fee read at the epoch's first block's hash on both RPCs: the L1 fee bound and the operator fee of G(depth), refused when the RPCs differ", async () => {
  const c = CB();
  const log: string[] = [];
  const fees = (sel: string) => (sel === "f1c7a58b" ? 5n * 10n ** 12n : 10n ** 12n);
  const seen: unknown[] = [];
  const mk = (ob: Over) => evmPool({ pin: PIN, ...pairs(pair(c, c, { chainFee: fees, log }, ob)), relayFee: async () => answer(), epochFee: feeRule(seen), salt: () => new Uint8Array(16), ...noWait });
  await mk({ chainFee: fees }).bind(bindArgs());
  assert.equal((seen[0] as { chainFee: bigint }).chainFee, 6n * 10n ** 12n);
  const calls = log.filter((l) => l.includes("0x420000000000000000000000000000000000000f"));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((l) => l.includes(c.hashOf(30))), "at the epoch's first block's hash");
  assert.ok(calls.some((l) => l.includes("0xf1c7a58b" + w64(2_600n))), "the L1 fee bound of 2,600 bytes");
  assert.ok(calls.some((l) => l.includes("0x275aedd2" + w64(evmPoolGas(2)))), "the operator fee of G at the depth there");
  // one RPC's other answer is no fee
  await assert.rejects(mk({ chainFee: () => 1n }).bind(bindArgs()), /differ on the chain fee/);
});

// ---- the helper's answer is the device's fee (card evm-buy-hookdata-fee, review fold 2 MEDIUM-1) ----

/** The device's rule as its caller passes it (contracts/pool-evm/script/testnet-run.mjs): the kit's evmPoolFee. */
const kitRule = () => (at: { baseFeePerGas: bigint; depth: number; chainFee: bigint }) => evmPoolFee({ gas: evmPoolGas(at.depth), gasPrice: at.baseFeePerGas, chainFee: at.chainFee });
/** The helper's EVM sender (apps/helper/src/pool/evm.ts) on the same chain, its key a test key, never money. */
const helperOn = (network: string, rpcs: [EvmRpc, EvmRpc]) =>
  evmPoolSender({ network, pool: POOL, senderKey: createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest(), feeRecipient: FEE_TO }, rpcs, () => Number(EPOCH) + 20_000);
/** `n` leaves before the epoch's first block (30): one deposit at 10, the rest withdrawals at 20. */
const leaves = (n: number) => chain([...deps(PP, [10]), ...Array.from({ length: n - 1 }, (_, i): Ev => ({ block: 20, kind: "wd", leaf: 5_000n + BigInt(i) }))], 40, 20);

test("MEDIUM-1 the device binds the helper's GET /v1/pool/fee answer: the kit's evmPoolFee at the epoch's first block, its depth and chain fee, on Base and Robinhood", async () => {
  const gwei = { baseFee: () => 10n ** 9n };
  // Base: an L1 fee bound and an operator fee of the gas the call names (Isthmus getOperatorFee(gasUsed): fold 2
  // LOW-B, so a read of another gas prices another fee); Robinhood: an L1 base fee estimate (16 a byte of 2,600)
  const opFee = (gas: bigint) => gas * 10_000_000n;
  const nets = [
    { network: "base" as const, chainFee: (sel: string, _n?: number, arg = 0n) => (sel === "f1c7a58b" ? 5n * 10n ** 12n : opFee(arg)) },
    { network: "robinhood" as const, chainFee: () => 10n ** 8n },
  ];
  for (const { network, chainFee } of nets) {
    // the tree's depth at block 30, 0 to 8, from that many leaves (LeanIMT's ceil(log2(size)))
    for (const [n, depth] of [[1, 0], [2, 1], [3, 2], [5, 3], [9, 4], [17, 5], [33, 6], [65, 7], [129, 8]] as const) {
      const c = leaves(n);
      const o: Over = { chainId: EVM_CHAIN_IDS[network], chainFee, ...gwei };
      const rpcs = pair(c, c, o, o);
      const helper = helperOn(network, rpcs);
      const seen: { depth: number; chainFee: bigint; baseFeePerGas: bigint }[] = [];
      const rule = kitRule();
      const device = evmPool({ pin: { ...PIN, network }, ...pairs(rpcs), relayFee: async (e) => (await helper.fee(Number(e))) as EvmFeeAnswer, epochFee: (at) => (seen.push(at), rule(at)), salt: () => new Uint8Array(16), ...noWait });
      const b = await device.bind(bindArgs());
      assert.equal(seen[0]!.depth, depth, `${network} ${n} leaves`);
      assert.ok(seen[0]!.chainFee > 0n, `${network}: a chain fee above 0`);
      assert.equal(b.feeCap.toString(), (await helper.fee(Number(EPOCH)))!.fee, `${network} depth ${depth}`);
    }
  }
  // every depth the pool takes, 0 to 32: the helper prices the depth the pool's view names there as the device's
  // rule does at that depth (the device reads its depth from the leaves it syncs, so a tree of 2^31 leaves is the
  // view's here)
  for (const { network, chainFee } of nets) {
    const c = CB();
    for (let depth = 0; depth <= 32; depth++) {
      const o: Over = { chainId: EVM_CHAIN_IDS[network], chainFee, ...gwei, view: (name, v) => (name === "currentTreeDepth" ? BigInt(depth) : v) };
      const reads = network === "base" ? 5n * 10n ** 12n + opFee(evmPoolGas(depth)) : 16n * 2_600n * 10n ** 8n;
      const want = kitRule()({ baseFeePerGas: 10n ** 9n, depth, chainFee: reads });
      assert.equal((await helperOn(network, pair(c, c, o, o)).fee(Number(EPOCH)))!.fee, want.toString(), `${network} depth ${depth}`);
    }
  }
  // the two providers on another depth or chain fee at that block: no answer
  const c = CB();
  const one = { chainId: 8453n, ...gwei };
  await assert.rejects(helperOn("base", pair(c, c, one, { ...one, view: (n, v) => (n === "currentTreeDepth" ? v + 1n : v) })).fee(Number(EPOCH)), /differ/);
  await assert.rejects(helperOn("base", pair(c, c, one, { ...one, chainFee: () => 1n })).fee(Number(EPOCH)), /differ/);
  // a network the kit has no chain fee rule for starts no sender
  assert.throws(() => helperOn("anvil", pair(c, c)), /no chain fee rule/);
  // fold 2 LOW-A: a fee that rounds under the floor (no base fee, no chain fee) is the kit's one floor on both sides,
  // above the rounded fee (0), so neither side can price it with another floor
  const EVM_POOL_FEE_FLOOR = 10n ** 13n; // the kit's floor, one step (packages/kit/test/evm-pool-fee.test.ts holds it)
  for (const network of ["base", "robinhood"] as const) {
    const free: Over = { chainId: EVM_CHAIN_IDS[network], baseFee: () => 0n, chainFee: () => 0n };
    const rpcs = pair(c, c, free, free);
    const helper = helperOn(network, rpcs);
    const device = evmPool({ pin: { ...PIN, network }, ...pairs(rpcs), relayFee: async (e) => (await helper.fee(Number(e))) as EvmFeeAnswer, epochFee: kitRule(), salt: () => new Uint8Array(16), ...noWait });
    assert.equal((await device.bind(bindArgs())).feeCap, EVM_POOL_FEE_FLOOR, `${network}: the floor`);
    assert.equal((await helper.fee(Number(EPOCH)))!.fee, EVM_POOL_FEE_FLOOR.toString());
    assert.ok(EVM_POOL_FEE_FLOOR > 0n);
  }
});

// fold 3 (review fold 2 MEDIUM-A): the sync's pair pages logs, and on Robinhood testnet its second provider (PublicNode)
// keeps about 15 s of state; bind reads the chain fee at the epoch's first block on feeRpcs, the kit pin's pair
test("MEDIUM-A bind reads the chain fee on feeRpcs, never on the sync's pair, which may have pruned that block's state", async () => {
  const c = CB();
  const log: string[] = [];
  const pruned: Over = { chainFee: () => { throw new Error("RPC error -32000: historical state 4c6aae67e883f4eb4d80c73ed82272e6c9a8e2744ba is not available"); } };
  const seen: unknown[] = [];
  const waits: number[] = [];
  const p = evmPool({ pin: PIN, rpcs: pair(c, c, pruned, pruned), feeRpcs: pair(c, c, { log }, {}), relayFee: async () => answer(), epochFee: feeRule(seen), salt: () => new Uint8Array(16), sleep: async (ms) => void waits.push(ms) });
  await p.bind(bindArgs());
  assert.equal((seen[0] as { chainFee: bigint }).chainFee, 7_917n);
  assert.deepEqual(waits, [], "no retry: the fee pair holds the state");
  const calls = log.filter((l) => l.includes("0x420000000000000000000000000000000000000f"));
  assert.equal(calls.length, 2, "both chain fee reads on the fee pair's first RPC");
  assert.ok(calls.every((l) => l.includes(c.hashOf(30))), "at the epoch's first block's hash");
  // a fee pair that has pruned it: a retry, then the lag
  const q = evmPool({ pin: PIN, ...pairs(pair(c, c, pruned, pruned)), relayFee: async () => answer(), epochFee: feeRule([]), salt: () => new Uint8Array(16), sleep: async () => undefined });
  await assert.rejects(q.bind(bindArgs()), /no longer keeps the state/);
  // fold 4 LOW-1: no fee pair is refused at once, never the sync's pair in its place (a caller that forgets it would
  // bind on a pair that may keep 15 s of state)
  for (const feeRpcs of [undefined, [], [pair(c, c)[0]]])
    assert.throws(() => evmPool({ pin: PIN, rpcs: pair(c, c), feeRpcs, relayFee: async () => answer(), epochFee: feeRule([]) } as unknown as Parameters<typeof evmPool>[0]), /^Error: feeRpcs: two or more$/, String(feeRpcs));
  // a fee pair of one provider twice is one read
  assert.throws(() => evmPool({ pin: PIN, rpcs: pair(c, c), feeRpcs: [pair(c, c)[0], pair(c, c)[0]] as unknown as [EvmRpc, EvmRpc], relayFee: async () => answer(), epochFee: feeRule([]) }), /one provider twice/);
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
  const p = evmPool({ pin: PIN, ...pairs(pair(late, late, {}, { latestBlock: fakeLatest(400, T0 + 61n) })), relayFee: async () => answer(), epochFee: () => 3n * 10n ** 13n, salt: () => new Uint8Array(16), ...noWait });
  await assert.rejects(p.bind(bindArgs()), /too close to send/);
  // an honest RPC behind the other (its latest block 100, T0 + 200 s): the agreed time is block 100's, but the send
  // margin is checked at the higher latest time (block 400's), so the deadline the chain has passed is refused
  const p2 = evmPool({ pin: PIN, ...pairs(pair(late, late, {}, { latest: () => 100 })), relayFee: async () => answer(), epochFee: () => 3n * 10n ** 13n, salt: () => new Uint8Array(16), ...noWait });
  await assert.rejects(p2.bind(bindArgs()), /too close to send/);
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

test("F3b a provider's cap shrinks the page (its real words, thousands separators too), and the page grows back", async () => {
  // publicnode's cap (3 Nov 05:35Z) on one RPC, a docs' "limited to a 2,000 range" on the other
  const c = chain([...deps(PP, [10, 1200, 4800]), { block: 9000, kind: "buy", leaf: 997n }], 20000, 19000);
  const la: string[] = [], lb: string[] = [];
  const capA = { log: la, getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 5000) throw new Error("RPC error -32701: exceed maximum block range: 5000"); } };
  const capB = { log: lb, getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 2000) throw new Error("RPC error -32614: eth_getLogs is limited to a 2,000 range"); } };
  const s = sync(pair(c, c, capA, capB));
  assert.equal((await s.trees(after(9500))).stateTree.size, 4);
  const sizes = (l: string[]) => l.filter((x) => x.startsWith("eth_getLogs")).map((x) => x.match(/"fromBlock":"(0x[0-9a-f]+)","toBlock":"(0x[0-9a-f]+)"/)!.slice(1).map((h) => Number(BigInt(h)))).map(([f, t]) => t! - f! + 1);
  assert.ok(sizes(la).includes(5000) && !sizes(la).some((n) => n < 2500), `a: ${sizes(la)}`);
  assert.ok(sizes(lb).includes(1250) && !sizes(lb).some((n) => n < 1250), `b: ${sizes(lb)}`);
  // 10,000, 5,000 and 2,500 refused once each, then one probe past the ceiling at most every EVM_LOG_CEILING_PAGES
  // full pages under it (card notes-per-pool-evm-base-hang)
  const under = sizes(lb).filter((n) => n === 1250).length;
  assert.ok(sizes(lb).filter((n) => n > 2000).length <= 3 + Math.ceil(under / EVM_LOG_CEILING_PAGES), `b: ${sizes(lb)}`);
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

/** Each eth_getLogs page's size in blocks, in the order asked (refused ones too), from an RPC's call log. */
const pageSizes = (l: string[]): number[] => l.filter((x) => x.startsWith("eth_getLogs")).map((x) => x.match(/"fromBlock":"(0x[0-9a-f]+)","toBlock":"(0x[0-9a-f]+)"/)!.slice(1).map((h) => Number(BigInt(h)))).map(([f, t]) => t! - f! + 1);
/** A chain of `head` blocks whose hashes are their numbers + 1 (numberIn reads them back at once). */
const longChain = (events: Ev[], head: number) => ({ ...chain(events, head, head - 10), hashOf: (n: number) => `0x${w64(BigInt(n) + 1n)}` });
const TIMEOUT = () => new DOMException("The operation timed out.", "TimeoutError");

test("F3c no answer in time never halves the pool sync's page (card evm-pool-sync-wide-pages): the same page again, or one wider than its provider ever answered back to the widest it did, never below", async () => {
  // as B1 in pool-evm-restore.test.ts for a W's read, where a timeout still halves (its filter names no address)
  const c = longChain([...deps(PP, [10, 1_200_000, 1_990_000])], 2_000_000);
  const pages = async (slow: (n: number, size: number) => boolean) => {
    const lb: string[] = [];
    let n = 0;
    const late = { log: lb, getLogs: ({ from, to }: { from: number; to: number }) => { if (slow(++n, to - from + 1)) throw TIMEOUT(); } };
    const r = await sync(pair(c, c, {}, late)).events();
    assert.equal(r.events.length, 3);
    return pageSizes(lb);
  };
  const clean = await pages(() => false);
  assert.deepEqual(clean, [100_000, 200_000, 400_000, 800_000, 500_000], `clean: ${clean}`);
  // the first page with no answer in time: the same 100,000 blocks again, then the clean read's pages
  assert.deepEqual(await pages((n) => n === 1), [100_000, ...clean]);
  // a provider with no answer in time over 100,000 blocks: each wider page back to 100,000, never below it
  const wide = await pages((_, size) => size > 100_000);
  assert.ok(wide.every((s) => s >= 100_000), `wide: ${wide}`);
  assert.equal(wide.filter((s) => s === 100_000).length, 20, `wide: ${wide}`);
  assert.ok(wide.length <= 20 + 4, `${wide.length} pages: ${wide}`);
});

test("card robinhood-mainnet-rpcs: the kit's Robinhood mainnet pool list syncs the pool on two operators, each paged under its own cap in its own words (Robinhood's 100,000; Pocket's backends 50,000 and 10,001), any spare untouched", async () => {
  const list = evmPoolProvidersOf(evmPoolVenues().robinhood) ?? assert.fail("robinhood: the kit pins no pool list");
  const c = longChain([...deps(PP, [10, 1_200_000, 1_990_000])], 2_000_000);
  const logs = list.map((): string[] => []);
  let pocketCalls = 0;
  // read 2026-11-07 01:42-01:50Z on the pool's filter (the kit's comment at the list)
  const caps: Record<string, (p: { from: number; to: number }) => void> = {
    "https://rpc.mainnet.chain.robinhood.com": ({ from, to }) => {
      if (to - from + 1 > 100_000) throw new Error(`RPC error -32602: query spans ${to - from + 1} blocks (${from} to ${to}), but only 100000 are allowed for this request; narrow the block range, or send one value per position`);
    },
    "https://robinhood.api.pocket.network": ({ from, to }) => {
      const k = ++pocketCalls;
      if (to - from + 1 > 50_000 && k === 2) throw new Error("RPC error -32602: invalid argument 0: block range exceeds maximum 50000");
      if (to - from + 1 > 10_001 && k % 3 === 0) throw new Error("RPC error -32602: eth_getLogs block range too large (max 10001 blocks)");
    },
  };
  const rpcs = list.map((url, i) => rpc(c, { url, chainId: 4663n, log: logs[i], getLogs: caps[url] ?? (() => assert.fail(`${url} asked`)) }));
  const r = await evmTreeSync({ rpcs, pin: { ...PIN, network: "robinhood" }, ...noWait }).events();
  assert.equal(r.events.length, 3);
  // review M-1: no spare today (GlobalStake answers past the device's client); one the kit adds is asked only for a
  // seat out
  const [own, pocket, ...spares] = logs.map(pageSizes);
  assert.deepEqual(list.slice(0, 2), ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.api.pocket.network"]);
  assert.ok(own!.length > 0 && pocket!.length > 0, "both seats read the pool's logs");
  assert.deepEqual(spares.map((x) => x.length), spares.map(() => 0), "a spare is asked only for a seat out");
  assert.ok(own!.every((s) => s <= 800_000) && own!.filter((s) => s > 100_000).length <= 2 + Math.ceil(own!.length / EVM_LOG_CEILING_PAGES), `own: ${own}`);
  assert.ok(Math.min(...pocket!) >= 5_000, `pocket: ${pocket}`);
});

test("card evm-pool-sync-wide-pages: a 13M-block span on two providers with caps 50,000 and 100,000 takes at most ceil(span/cap)+10 pages each", async () => {
  // a month of Base's 200 ms blocks; PublicNode's cap words on one (3 Nov 05:35Z), Robinhood's own on the other (6 Nov 07:31Z)
  const span = 13_000_000;
  const c = longChain([...deps(PP, [10, 6_000_000, 12_999_000])], span);
  const la: string[] = [], lb: string[] = [];
  const capA = { log: la, getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 50_000) throw new Error("RPC error -32701: exceed maximum block range: 50000"); } };
  const capB = { log: lb, getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 100_000) throw new Error(`RPC error -32602: query spans ${to - from + 1} blocks (${from} to ${to}), but only 100000 are allowed for this request; narrow the block range, or send one value per position`); } };
  const r = await sync(pair(c, c, capA, capB)).events();
  assert.equal(r.events.length, 3);
  const a = pageSizes(la), b = pageSizes(lb);
  assert.ok(a.length <= Math.ceil(span / 50_000) + 10, `the 50,000 cap: ${a.length} pages`);
  assert.ok(b.length <= Math.ceil(span / 100_000) + 10, `the 100,000 cap: ${b.length} pages`);
});

test("card helper-evm-range-cap-walk: sepolia.base.org's HTTP 413 \"limited to a 200 range\" pages the pool sync at 200 at once, never under it: 1.5M blocks in ceil(span/200) pages and a few probes", async () => {
  // sepolia.base.org's answer to eth_getLogs over 2,000 and 10,000 blocks: HTTP 413, -32614 "eth_getLogs is limited to
  // a 200 range"; 200 blocks answered in 0.33 s (read 6 Nov 18:45Z and 18:51Z), as the kit's client throws it (the status,
  // then the body's error); publicnode's 50,000 cap on the other seat
  const span = 1_500_000;
  const c = longChain([...deps(PP, [10, 700_000, 1_499_000])], span);
  const la: string[] = [], lb: string[] = [];
  const capA = { log: la, getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 50_000) throw new Error("RPC error -32701: exceed maximum block range: 50000"); } };
  const capB = { log: lb, getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 200) throw new Error("HTTP 413: RPC error -32614: eth_getLogs is limited to a 200 range"); } };
  const r = await sync(pair(c, c, capA, capB)).events();
  assert.equal(r.events.length, 3);
  const b = pageSizes(lb);
  // the first page refused, then 200 at once (halving went 100,000 to 195 in 9 refusals and paged at 195: 7,693 pages)
  assert.deepEqual(b.slice(0, 9), [100_000, ...Array(8).fill(200)], `b: ${b.slice(0, 12)}`);
  const answered = b.filter((n) => n <= 200);
  assert.ok(answered.slice(0, -1).every((n) => n === 200), `b's pages under the cap: ${[...new Set(answered)]}`);
  assert.ok(b.length <= Math.ceil(span / 200) + 10, `the 200 cap: ${b.length} pages`);
  assert.ok(pageSizes(la).length <= Math.ceil(span / 50_000) + 10, `the 50,000 cap: ${pageSizes(la).length} pages`);
});

// ---- card helper-evm-range-cap-walk: a seat whose provider caps a page under the span asked walks to the list's next ----

/** Each provider's cap as its own words (read live: publicnode 3 Nov 05:35Z, blastapi as evm-transfer-rpc-spares
 *  recorded it, Pocket 6 Nov 07:31Z, sepolia.base.org 6 Nov 18:51Z, nodies 6 Nov 15:19Z), every eth_getLogs counted;
 *  past CALLS_GUARD in all the read answers no list, so a pager that never moves on fails its test instead of hanging. */
const CALLS_GUARD = 5_000;
const capped = (url: string, cap: number | null, words: (size: number) => string, count: { n: number }, log: string[], extra?: () => void | number): Over => ({
  url,
  log,
  getLogs: ({ from, to }) => {
    if (++count.n > CALLS_GUARD) throw new Error("RPC error -32603: the test's call guard");
    const ms = extra?.();
    if (cap !== null && to - from + 1 > cap) throw new Error(words(to - from + 1));
    return ms;
  },
});
/** An answer's delay of 0 to 3 ms from a seeded stream: which seat's answer comes first, and a call's time in whole ms
 *  (0 or more), vary from run to run, as on a busy machine (PR #369's fresh run). */
const jitter = (seed: number) => () => ((seed = (seed * 48_271) % 2_147_483_647), seed % 4);
const PUBLICNODE_WORDS = () => "HTTP 400: RPC error -32701: exceed maximum block range: 50000";
const BLAST_WORDS = () => "HTTP 400: RPC error -32600: You can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x33437f9, 0x3343802]";
const POCKET_WORDS = () => "HTTP 400: RPC error -32602: query exceeds max block range 100000";

test("card helper-evm-range-cap-walk: the kit's Base list (blastapi's 10-block cap seated second, mainnet.base.org 429 on every getLogs) syncs 1.5M blocks on publicnode and Pocket in a few dozen calls", async () => {
  const span = 1_500_000;
  const c = longChain([...deps(PP, [10, 700_000, 1_499_000])], span);
  const count = { n: 0 };
  const lp: string[] = [], lb: string[] = [], lo: string[] = [], lk: string[] = [];
  const list = [
    rpc(c, capped("https://base-rpc.publicnode.com", 50_000, PUBLICNODE_WORDS, count, lp)),
    rpc(c, capped("https://base-mainnet.public.blastapi.io", 10, BLAST_WORDS, count, lb)),
    rpc(c, capped("https://mainnet.base.org", null, () => "", count, lo, () => { throw HTTP_429(); })),
    rpc(c, capped("https://base.api.pocket.network", 100_000, POCKET_WORDS, count, lk)),
  ];
  const r = await evmTreeSync({ rpcs: list, pin: PIN, sleep: async () => {} }).events();
  assert.equal(r.events.length, 3);
  const [p, b, o, k] = [lp, lb, lo, lk].map(pageSizes);
  // blastapi asked once (its 100,000 refused), mainnet.base.org at most once (its 429), the span read on the other two
  assert.ok(b.length <= 2 && o.length <= 2, `blastapi ${b}, mainnet.base.org ${o}`);
  assert.ok(count.n <= 80, `${count.n} eth_getLogs in all: publicnode ${p.length}, Pocket ${k.length}`);
  assert.ok(k.filter((n) => n <= 100_000).reduce((a, n) => a + n, 0) >= span - 100_000, `Pocket's pages ${k}`);
});

test("card helper-evm-range-cap-walk: sepolia.base.org's 200 cap walks its seat to the list's next provider, which reads the span in wide pages", async () => {
  const span = 1_500_000;
  const c = longChain([...deps(PP, [10, 700_000, 1_499_000])], span);
  const count = { n: 0 };
  const la: string[] = [], lb: string[] = [], lc: string[] = [];
  const list = [
    rpc(c, capped("https://base-sepolia-rpc.publicnode.com", 50_000, PUBLICNODE_WORDS, count, la)),
    rpc(c, capped("https://sepolia.base.org", 200, () => "HTTP 413: RPC error -32614: eth_getLogs is limited to a 200 range", count, lb)),
    rpc(c, capped("https://base-sepolia.gateway.tenderly.co", null, () => "", count, lc)),
  ];
  const r = await evmTreeSync({ rpcs: list, pin: PIN, sleep: async () => {} }).events();
  assert.equal(r.events.length, 3);
  const [a, b, t] = [la, lb, lc].map(pageSizes);
  assert.equal(b.length, 1, `sepolia.base.org's pages ${b}`);
  assert.ok(t.length > 0 && t.length <= 10, `the next provider's pages ${t}`);
  assert.ok(count.n <= 60, `${count.n} eth_getLogs in all: ${a.length}, ${b.length}, ${t.length}`);
});

test("card helper-evm-range-cap-walk: with every provider of the list capping, the seats sit on the two largest caps and each pages at its own", async () => {
  const span = 100_000;
  const c = longChain([...deps(PP, [10, 40_000, 99_000])], span);
  const count = { n: 0 };
  const la: string[] = [], lb: string[] = [], lc: string[] = [];
  const nodies = (cap: number) => () => `RPC error -32001: Block range too large: maximum allowed is ${cap} blocks on your current plan`;
  // each answer 0 to 3 ms late: the seats' first refusals come in either order, and a refusal within the clock's
  // millisecond took 0 ms (PR #369's fresh run walked a seat by that 0: the 50 cap paged 10, the 10 cap was asked twice)
  const list = [
    rpc(c, capped("https://a.example", 10, nodies(10), count, la, jitter(1))),
    rpc(c, capped("https://b.example", 200, () => "HTTP 413: RPC error -32614: eth_getLogs is limited to a 200 range", count, lb, jitter(2))),
    rpc(c, capped("https://c.example", 50, nodies(50), count, lc, jitter(3))),
  ];
  const r = await evmTreeSync({ rpcs: list, pin: PIN, sleep: async () => {} }).events();
  assert.equal(r.events.length, 3);
  const [a, b, x] = [la, lb, lc].map(pageSizes);
  assert.equal(a.length, 1, `the 10 cap's pages ${a}`);
  const at = (pages: number[], cap: number) => pages.filter((n) => n <= cap);
  assert.ok(at(b, 200).slice(0, -1).every((n) => n === 200) && at(b, 200).reduce((s, n) => s + n, 0) >= span - 200, `the 200 cap's pages ${[...new Set(b)]}`);
  assert.ok(at(x, 50).slice(0, -1).every((n) => n === 50) && at(x, 50).reduce((s, n) => s + n, 0) >= span - 50, `the 50 cap's pages ${[...new Set(x)]}`);
});

test("card evm-pool-sync-wide-pages: a refusal halves only that provider's page; a 429 or no answer in time halves none, and a spare in a seat pages at its own size", async () => {
  const c = longChain([...deps(PP, [10, 400_000, 990_000])], 1_000_000);
  const la: string[] = [], lb: string[] = [];
  let nb = 0;
  const capA = { log: la, getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 25_000) throw new Error("RPC error -32614: eth_getLogs is limited to a 25,000 range"); } };
  const noisyB = { log: lb, getLogs: () => { nb++; if (nb === 1) throw TIMEOUT(); if (nb === 3) throw HTTP_429(); } };
  const r = await sync(pair(c, c, capA, noisyB)).events();
  assert.equal(r.events.length, 3);
  const a = pageSizes(la), b = pageSizes(lb);
  assert.ok(a.includes(25_000) && a.slice(0, 3).join() === "100000,50000,25000", `a: ${a}`);
  // b's pages: 100,000 then each one twice the last, its timeout and its 429 each asked again at its own size
  assert.deepEqual(b, [100_000, 100_000, 200_000, 200_000, 400_000, 300_000], `b: ${b}`);
  // a seat whose provider is out (HTTP 429) moves to the spare, which pages at its own size, never its seat's last one
  const l0: string[] = [], l2: string[] = [];
  let n0 = 0;
  const out = { url: "https://a.example", log: l0, getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 25_000) throw new Error("RPC error -32614: eth_getLogs is limited to a 25,000 range"); if (++n0 === 3) throw HTTP_429(); } };
  const list = [rpc(c, out), rpc(c, { url: "https://b.example" }), rpc(c, { url: "https://c.example", log: l2 })];
  const r2 = await evmTreeSync({ rpcs: list, pin: PIN, sleep: async () => {} }).events();
  assert.equal(r2.events.length, 3);
  // the call the seat moved (its 25,000 blocks), then the spare's own first page
  assert.deepEqual(pageSizes(l2).slice(0, 2), [25_000, 100_000], `the spare's pages: ${pageSizes(l2)}`);
  // a provider whose backends differ (Pocket's words, 6 Nov 07:44Z): a refusal of a size it answered is asked again at
  // once, never halved, up to EVM_LOG_REFUSED_AGAIN times in a row
  const lp: string[] = [];
  let np = 0;
  const lottery = { log: lp, getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 100_000 || (++np > 1 && np % 2 === 0)) throw new Error("RPC error -32602: query exceeds max block range 10000"); } };
  const r3 = await sync(pair(c, c, {}, lottery)).events();
  assert.equal(r3.events.length, 3);
  const p3 = pageSizes(lp);
  assert.ok(p3.every((s) => s >= 100_000), `the lottery's pages: ${p3}`);
});

test("card evm-pool-sync-wide-pages: a held sync reads only the blocks after its last one; a held part the pool's views refuse is dropped and read again from the deploy block", async () => {
  // the hold inline, as the device's store would keep it
  const hold = () => {
    let h: unknown = null;
    return { read: async () => h, write: async (v: unknown) => void (h = v), get: () => h as { to: bigint; events: unknown[] } | null, set: (v: unknown) => void (h = v) };
  };
  const c = longChain([...deps(PP, [10, 400_000]), { block: 700_000, kind: "wd", leaf: 999n }], 800_000);
  const h = hold();
  const first = await evmTreeSync({ rpcs: pair(c, c), pin: PIN, held: h, sleep: async () => {} } as Parameters<typeof evmTreeSync>[0]).events();
  assert.equal(first.events.length, 3);
  assert.equal(h.get()?.to, BigInt(c.finalized), "the held part runs to the finalized anchor");
  // the chain moves on; a later sync on the same hold reads only past it, and makes the same trees with the new leaf
  c.events.push({ block: 850_000, kind: "dep", leaf: BigInt(PP.commitments[2]!), label: BigInt(PP.labels[2]!) });
  c.head = 900_000;
  c.finalized = 899_990;
  const la: string[] = [], lb: string[] = [];
  const later = await evmTreeSync({ rpcs: pair(c, c, { log: la }, { log: lb }), pin: PIN, held: h, sleep: async () => {} } as Parameters<typeof evmTreeSync>[0]).events();
  assert.equal(later.events.length, 4);
  for (const l of [la, lb]) {
    const froms = l.filter((x) => x.startsWith("eth_getLogs")).map((x) => Number(BigInt(x.match(/"fromBlock":"(0x[0-9a-f]+)"/)![1]!)));
    assert.ok(froms.length > 0 && froms.every((f) => f > 799_990), `pages from ${froms}`);
  }
  // a held part with one leaf changed is not the pool's: dropped, and the pool read again from its deploy block
  const bad = hold();
  const held = h.get()!;
  bad.set({ ...held, events: held.events.map((e, i) => (i === 1 ? { ...(e as object), state: 5n } : e)) });
  const lc: string[] = [];
  const again = await evmTreeSync({ rpcs: pair(c, c, { log: lc }), pin: PIN, held: bad, sleep: async () => {} } as Parameters<typeof evmTreeSync>[0]).events();
  assert.equal(again.events.length, 4);
  assert.equal(again.events[1]!.state, BigInt(PP.commitments[1]!));
  assert.ok(lc.some((x) => x.includes('"fromBlock":"0x1"')), "read again from the deploy block");
  assert.equal(bad.get()!.events.length, 4);
  // a held part of another pin is never taken
  const other = hold();
  other.set({ ...h.get()!, fromBlock: 2n });
  const ld: string[] = [];
  await evmTreeSync({ rpcs: pair(c, c, { log: ld }), pin: PIN, held: other, sleep: async () => {} } as Parameters<typeof evmTreeSync>[0]).events();
  assert.ok(ld.some((x) => x.includes('"fromBlock":"0x1"')), "another pin's held part is not taken");
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
  for (const text of ["RPC error -32000: historical state 17babde33c1cae4d846be258743d8cbdc4fcdb030fed59adf0440d388fc8e9e9 is not available", "missing trie node 0xabc (path ) state 0xdef is not available", "RPC error -32000: Unknown state. First available state is 1"]) {
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
  // RPC a fails while RPC b's page is in flight: the read fails only once that page has settled
  let open = 0;
  const failLate = { getLogs: () => 5, logs: (): Record<string, unknown>[] => { throw new Error("RPC error 429: too many requests"); } };
  const slowB = { getLogs: () => (open++, 40), logs: (l: Record<string, unknown>[]) => (open--, l) };
  await assert.rejects(evmTreeSync({ rpcs: pair(c, c, failLate, slowB), pin: PIN, sleep: async () => {} }).trees(after(25)), /429/);
  assert.equal(open, 0, "RPC b's page was still in flight when trees() rejected");
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
  const p = evmPool({ pin: PIN, ...pairs(pair(c2, c2, flip, flip)), relayFee: async () => answer(), epochFee: feeRule([]), salt: () => new Uint8Array(16), sleep: async (ms) => void waits.push(ms) });
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
  c.events.push({ block: 60, kind: "dep", leaf: 1234n, label: 4321n });
  let fin = 50;
  let slow = true;
  // the first read's first page is slow: without one round at a time, the second read caches first and the first then
  // adds its own leaves to the second's
  const o = { finalized: () => fin, getLogs: () => (slow ? ((slow = false), 30) : undefined) };
  const s = sync(pair(c, c, o, { finalized: () => fin }));
  await s.trees(after(25));
  fin = 90;
  slow = true;
  const [x, y] = await Promise.all([s.trees(after(61)), s.trees(after(61))]);
  assert.equal(x.stateTree.size, 5);
  assert.equal(y.stateTree.size, 5);
});

test("X13 a cut with a state leaf but no label is refused (no leaf before)", async () => {
  const c = chain([{ block: 10, kind: "wd", leaf: 999n }, ...deps(PP, [20])]);
  await assert.rejects(sync(pair(c, c)).trees(after(15)), /no leaf before/);
});

test("X15, X20, X21 bind refuses W as the fee recipient, a chunk of 2^128, a salt not of 16 bytes", async () => {
  const c = CB();
  const mk = (pin: EvmPoolPin, salt = () => new Uint8Array(16)) => evmPool({ pin, ...pairs(pair(c, c)), relayFee: async () => answer({ fee_recipient: pin.feeRecipient }), epochFee: feeRule([]), salt, ...noWait });
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

// ---- fold 3: the re-check's cases ----

test("R1 a reorg on both RPCs of the newest agreed block (100) replacing its pool log: a retry, then the new chain's root", async () => {
  const c = C3();
  c.events.push({ block: 100, kind: "dep", leaf: 1234n, label: 4321n });
  const r = reorgAt(c, 99, () => c.events.splice(c.events.length - 1, 1, { block: 100, kind: "dep", leaf: 5678n, label: 8765n }));
  const waits: number[] = [];
  const t = await evmTreeSync({ rpcs: pair(c, c, { logs: r }, { logs: r }), pin: PIN, sleep: async (ms) => void (waits.push(ms), (c.head = 101)) }).trees(after(100));
  assert.deepEqual(waits.slice(0, 1), [2000]);
  assert.equal(t.stateRoot, new VaultTree(c.events.map((e) => e.leaf)).root);
  assert.equal(t.stateTree.size, 5);
});

// a provider's cap on the logs one call returns, in the words recorded live (the team's data run, 2 Nov)
for (const text of ["query exceeds max results 20000, retry with the range 52898562-52899295", "logs matched by query exceeds limit of 10000"]) {
  test(`F8 a cap on the logs one call returns ("${text.slice(0, 40)}...") shrinks the page`, async () => {
    const c = chain([...deps(PP, [10, 12, 15]), { block: 20, kind: "wd", leaf: 999n }, { block: 30, kind: "wd", leaf: 998n }]);
    // the provider refuses any page holding more than 2 of the pool's logs
    const dense = { getLogs: ({ from, to }: { from: number; to: number }) => { if (c.events.filter((e) => e.block >= from && e.block <= to).length > 2) throw new Error(`RPC error -32005: ${text}`); } };
    const t = await evmTreeSync({ rpcs: pair(c, c, dense, {}), pin: PIN, sleep: async () => {} }).trees(after(35));
    assert.equal(t.stateTree.size, 5);
  });
}

test("R2 the pool's now() retries a moment's fork at the newest height like every other agreed read", async () => {
  const c = C3();
  let calls = 0;
  const fork = { hashOf: (n: number) => (n === 100 && calls++ < 2 ? h32("other 100") : c.hashOf(n)) };
  const waits: number[] = [];
  const p = evmPool({ pin: PIN, ...pairs(pair(c, c, {}, fork)), relayFee: async () => answer(), epochFee: () => 0n, sleep: async (ms) => void waits.push(ms) });
  assert.equal(await p.now(), (T0 + 200n) * 1000n);
  assert.deepEqual(waits, [2000]);
});

test("F9 dRPC's cap (base.drpc.org, read live 3 Nov 07:05Z: \"ranges over 10000 blocks are not supported on free plan\") shrinks the page", async () => {
  const c = C3();
  const drpc = { getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 30) throw new Error("ranges over 10000 blocks are not supported on free plan"); } };
  const t = await evmTreeSync({ rpcs: pair(c, c, {}, drpc), pin: PIN, sleep: async () => {} }).trees(after(25));
  assert.equal(t.stateTree.size, 4);
});

// ---- card wallet-rpc-hex-case: an RPC's hex in either case ----

/** robinhood-testnet.drpc.org's case: it answers eth_chainId "0xB626" (read 3 Nov 23:07Z; rpc.testnet.chain.robinhood.com
 * and robinhood-sepolia-rpc.publicnode.com answer "0xb626"). Here every hex digit of every answer is upper-cased, "0x" kept. */
const upper = (v: unknown): unknown =>
  typeof v === "string" && /^0x[0-9a-f]+$/.test(v) ? `0x${v.slice(2).toUpperCase()}`
  : Array.isArray(v) ? v.map(upper)
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, upper(x)]))
  : v;
const drpc = (r: EvmRpc): EvmRpc => Object.assign(async (m: string, p: readonly unknown[]) => upper(await r(m, p)), { url: `${(r as { url?: string }).url}/drpc` });
const answering = (r: EvmRpc, method: string, v: unknown): EvmRpc => Object.assign(async (m: string, p: readonly unknown[]) => (m === method ? v : r(m, p)), { url: `${(r as { url?: string }).url}/x` });

test("hex in either case: drpc's real eth_chainId \"0xB626\" and every field upper-cased read as lower case, the same trees on Robinhood testnet", async () => {
  const c = C3();
  const rh = { chainId: 46630n };
  const [a, b] = pair(c, c, rh, rh);
  assert.equal(await drpc(a)("eth_chainId", []), "0xB626");
  const s = (rpcs: [EvmRpc, EvmRpc]) => evmTreeSync({ rpcs, pin: { ...PIN, network: "robinhood-testnet" }, ...noWait }).trees(after(25));
  const want = await s([a, b]);
  assert.equal(want.stateTree.size, 4);
  for (const rpcs of [[drpc(a), b], [a, drpc(b)], [drpc(a), drpc(b)]] as [EvmRpc, EvmRpc][]) {
    const t = await s(rpcs);
    assert.deepEqual([t.stateRoot, t.labelRoot, t.stateTree.size, t.labelTree.size], [want.stateRoot, want.labelRoot, want.stateTree.size, want.labelTree.size]);
  }
});

test("hex in either case: a case-only difference never fails agreement, any other difference still does", async () => {
  const c = C3();
  const rh = { chainId: 46630n };
  const s = (rpcs: [EvmRpc, EvmRpc]) => evmTreeSync({ rpcs, pin: { ...PIN, network: "robinhood-testnet" }, ...noWait }).trees(after(25));
  // another chain written in upper case is still another chain
  const [a, b] = pair(c, c, rh, rh);
  await assert.rejects(s([answering(a, "eth_chainId", "0xB627"), b]), /chain 46631 and 46630, not robinhood-testnet's 46630/);
  // not 0x hex: an upper-case prefix (viem's and ethers' rule is "0x"), a digit that is not hex, a leading zero
  for (const v of ["0XB626", "0xB62G", "0x0B626", "B626", "0x"]) await assert.rejects(s([answering(a, "eth_chainId", v), b]), /eth_chainId: not a quantity/, v);
  // one leaf's value changed on the other RPC, the first in upper case: refused as before
  const flip = (l: Record<string, unknown>[]) => l.map((x, i) => (i === 2 ? { ...x, data: `${(x.data as string).slice(0, 65)}${(x.data as string)[65] === "1" ? "2" : "1"}${(x.data as string).slice(66)}` } : x));
  const [a2, b2] = pair(c, c, rh, { ...rh, logs: flip });
  await assert.rejects(s([drpc(a2), b2]), /the two RPCs differ at log 2/);
  // a hash that differs by more than its case is another block: refused as in lower case, word for word
  const [a3, b3] = pair(c, c, rh, { ...rh, hashOf: (n) => (n === 15 ? h32("other 15") : c.hashOf(n)) });
  const lowerWhy = await s([a3, b3]).then(() => assert.fail("another block 15 read"), (e: Error) => e.message);
  await assert.rejects(s([drpc(a3), b3]), (e: Error) => e.message === lowerWhy);
});

test("hex in either case: bind on an upper-case RPC and the helper's block \"0x1E\" is the lower-case bind; \"0x1F\" is still another block", async () => {
  const c = CB();
  const [a, b] = pair(c, c);
  const salt = () => Uint8Array.from(Buffer.from(PP.relayed.request.salt.slice(2), "hex"));
  const want = await poolOf(c).bind(bindArgs());
  const p = (block: string) => evmPool({ pin: PIN, ...pairs([drpc(a), b]), relayFee: async () => answer({ block }), epochFee: feeRule([]), salt, ...noWait });
  const got = await p("0x1E").bind(bindArgs());
  assert.deepEqual([got.context, got.feeCap, got.request], [want.context, want.feeCap, want.request]);
  await assert.rejects(p("0x1F").bind(bindArgs()), /not its first block/);
  await assert.rejects(p("0X1E").bind(bindArgs()), /not its first block/);
});

// ---- card wallet-restore-transfer-rpcs: one pager for every log the device reads ----

test("the pool's sync pages under a cap in words never read before (Tenderly's 'invalid params', Robinhood's own 'only 30000 are allowed', read live 5 Nov)", async () => {
  for (const words of ["RPC error -32602: invalid params", "RPC error -32602: query spans 39984 blocks (106696878 to 106736861), but only 30000 are allowed for this request; narrow the block range, or add an address filter"]) {
    const c = C3();
    const capped = { getLogs: ({ from, to }: { from: number; to: number }) => { if (to - from + 1 > 30) throw new Error(words); } };
    const t = await evmTreeSync({ rpcs: pair(c, c, {}, capped), pin: PIN, sleep: async () => {} }).trees(after(25));
    assert.equal(t.stateTree.size, 4, words);
  }
});

test("EVM_TRANSFER_RPCS: the testnets only (a Base or Robinhood W is read on the helper's route, decision M359), each a pinned list of three keyless https providers of as many operators, thirdweb never a seat, none an operator of the kit's providers but the two named exceptions, no dRPC on Base Sepolia (card evm-transfer-rpc-spares)", () => {
  // an operator: the host's last two labels (tenderly.co, pocket.network, thirdweb.com, drpc.org, robinhood.com)
  const operator = (u: string) => new URL(u).hostname.split(".").slice(-2).join(".");
  assert.deepEqual(Object.keys(EVM_TRANSFER_RPCS).sort(), ["base-sepolia", "robinhood-testnet"]);
  for (const [net, urls] of Object.entries(EVM_TRANSFER_RPCS)) {
    assert.ok(Object.isFrozen(urls), net);
    assert.ok(urls.length >= 3, `${net}: a pair and its spare`);
    for (const u of urls) assert.match(u, /^https:\/\/[a-z0-9.-]+(\/[a-z]+)?$/, `${net}: ${u} is a keyless https URL`);
    assert.equal(new Set(urls.map(operator)).size, urls.length, `${net}: every provider another operator`);
    const rpcOf = (url: string): EvmRpc => Object.assign(async () => null, { url });
    assert.doesNotThrow(() => evmPair(urls.map(rpcOf)), `${net}: no provider twice to the kit`);
    // thirdweb's keyless quota runs out for the day on every chain at once (5 Nov 16:28Z): a spare, never a seat
    assert.ok(urls.slice(0, 2).every((u) => operator(u) !== "thirdweb.com"), `${net}: thirdweb seated`);
  }
  // the exceptions, each the doc comment's: Robinhood testnet's own (no other keyless operator answers every read there:
  // Pocket and Tenderly have no Robinhood testnet, PublicNode refuses a filter with no address), and Base Sepolia's
  // Pocket, of the pool's pair that pages its logs wide (card notes-per-pool-evm-base-hang)
  const shared: Record<string, string[]> = { "base-sepolia": ["pocket.network"], "robinhood-testnet": ["robinhood.com"] };
  for (const chain of Object.keys(EVM_TRANSFER_RPCS) as (keyof typeof EVM_TRANSFER_RPCS)[]) {
    const kit = evmPoolVenues()[chain].providers ?? assert.fail(`${chain}: the kit pins no providers`);
    const both = EVM_TRANSFER_RPCS[chain].map(operator).filter((o) => kit.some((p) => operator(p) === o));
    assert.deepEqual(both, shared[chain], `${chain}: the operators the Transfer list shares with the kit's providers`);
  }
  assert.ok(!EVM_TRANSFER_RPCS["base-sepolia"].some((u) => operator(u) === "drpc.org"), "base-sepolia.drpc.org fails a W's read");
});

// ---- card evm-pool-reads-throttle: every single read of a buy's or a withdraw's survives a throttle or a timeout ----
// The faults are the device client's own (the kit's solanaJsonRpc with SOLANA_RPC_RETRY, the signing page's pageRpc):
// a call it ends as a SolanaRpcTransportError once its 3.5 s are spent. Robinhood's own RPC answered HTTP 429 with no
// Retry-After (5 Nov 13:55Z); Pocket and daybreak each gave one eth_getBlockByNumber no answer in 3.5 s (13:58Z).

const HTTP_429 = (): Error => new SolanaRpcTransportError("http_429", "HTTP 429", 4, "b.example", null);
const TIMED_OUT = (): Error => new SolanaRpcTransportError("timeout", "no answer in 3500 ms", 1, "b.example");
type Hit = (method: string, params: readonly unknown[], n: number) => boolean;
/** r, but each call `hit` matches (n: the matching calls before it) is first answered by the next fault, while any
 *  are left; `hits` counts the matching calls. */
function flaky(r: EvmRpc, hit: Hit, faults: (() => Error)[]): EvmRpc & { hits: number } {
  let n = 0, k = 0;
  const f = Object.assign(async (method: string, params: readonly unknown[]): Promise<unknown> => {
    if (hit(method, params, n)) {
      n++;
      f.hits = n;
      if (k < faults.length) throw faults[k++]!();
    }
    return r(method, params);
  }, { url: (r as { url?: string }).url, hits: 0 });
  return f;
}
const byNumber = (at: string): Hit => (m, p) => m === "eth_getBlockByNumber" && p[0] === at;
const viewCall = (sig: string, to = POOL.toLowerCase()): Hit => (m, p) => m === "eth_call" && (p[0] as { to: string; data: string }).to === to && (p[0] as { data: string }).data.startsWith(`0x${sel(sig)}`);
type Read = { name: string; side: 0 | 1; hit: Hit; what: RegExp; run: (rpcs: [EvmRpc, EvmRpc], sleep: (ms: number) => Promise<void>) => Promise<unknown> };
const c3 = C3(), cb = CB();
const START = (T0 + 2n * 41n) * 1000n - 1000n; // between block 40 and 41 of C3
const bindOn = (rpcs: [EvmRpc, EvmRpc], feeRpcs: [EvmRpc, EvmRpc], sleep: (ms: number) => Promise<void>) =>
  evmPool({ pin: PIN, rpcs, feeRpcs, relayFee: async () => answer(), epochFee: feeRule([]), salt: () => new Uint8Array(16), sleep }).bind(bindArgs());
const syncOn = (rpcs: [EvmRpc, EvmRpc], sleep: (ms: number) => Promise<void>) => evmTreeSync({ rpcs, pin: PIN, sleep });
const READS: Read[] = [
  { name: "evmAgreedBlock's tag read (the pool's now)", side: 1, hit: byNumber("latest"), what: /^rpc 1 latest block: /, run: (r, s) => evmNow(r, undefined, s) },
  { name: "evmAgreedBlock's read by number (the pool's now)", side: 1, hit: byNumber(q(100)), what: /^rpc 1 block 100: /, run: (r, s) => evmNow(r, undefined, s) },
  { name: "evmLatestHigh (bind's send margin)", side: 1, hit: byNumber("latest"), what: /^rpc 1 latest block: /, run: (r, s) => evmLatestHigh(r, undefined, s) },
  { name: "the tree sync's eth_chainId", side: 1, hit: (m) => m === "eth_chainId", what: /^rpc 1 eth_chainId: /, run: (r, s) => syncOn(r, s).trees(after(25)) },
  { name: "the tree sync's finalized anchor", side: 1, hit: byNumber("finalized"), what: /^rpc 1 finalized block: /, run: (r, s) => syncOn(r, s).trees(after(25)) },
  { name: "the tree sync's view (currentRoot)", side: 1, hit: viewCall("currentRoot()"), what: /^rpc 1 currentRoot\(\): /, run: (r, s) => syncOn(r, s).trees(after(25)) },
  { name: "the tree sync's root time view (stateRootTimes)", side: 1, hit: viewCall("stateRootTimes(uint256)"), what: /^rpc 1 stateRootTimes\(root\): /, run: (r, s) => syncOn(r, s).trees(after(25)) },
  { name: "the tree sync's block time by hash", side: 1, hit: (m) => m === "eth_getBlockByHash", what: /^rpc 1 block 0x[0-9a-f]{64}: /, run: (r, s) => syncOn(r, s).trees(after(25)) },
  { name: "the tree sync's depthAt block on its own chain", side: 1, hit: byNumber(q(30)), what: /^rpc 1 block 30: /, run: (r, s) => syncOn(r, s).depthAt(30n, undefined, c3.hashOf(30)) },
  { name: "evmEpochBlock's search on rpc 0", side: 0, hit: byNumber(q(99)), what: /^rpc 0 block 99: /, run: (r, s) => evmEpochBlock(r, START, undefined, s) },
  { name: "evmEpochBlock's read of the first block on both", side: 1, hit: byNumber(q(41)), what: /^rpc 1 block 41: /, run: (r, s) => evmEpochBlock(r, START, undefined, s) },
  { name: "bind's evmLatestHigh", side: 1, hit: byNumber("latest"), what: /^rpc 1 latest block: /, run: (r, s) => bindOn(r, r, s) },
];
/** The fee pair's chain fee view in bind (Base's GasPriceOracle), on CB. */
const FEE_READ = { hit: viewCall("getL1FeeUpperBound(uint256)", "0x420000000000000000000000000000000000000f"), what: /^fee rpc 1 chain fee: / };
const chainOf = (rd: Read): Chain => (rd.name.startsWith("bind") ? cb : c3);

test("the pool read bound comes from the life: half of what a pass at its epoch's end has before take() refuses its proof; 4 tries and their waits fit, a fifth does not", () => {
  // take() hands a proof of epoch e out until start + 2E (then it is from before the previous epoch) and while
  // deadline - now >= M + TAKE_SLACK_MS (start + L - M - S): the earlier is start + L - M - 2S
  assert.equal(EVM_LIFE_MS - EVM_SEND_MARGIN_MS - 2n * TAKE_SLACK_MS, 2n * EVM_EPOCH_MS);
  const window = EVM_LIFE_MS - EVM_SEND_MARGIN_MS - 2n * TAKE_SLACK_MS - EVM_EPOCH_MS; // a pass begun at start + E
  assert.equal(window, 60_000n);
  assert.equal(EVM_POOL_READ_BOUND_MS, window / 2n);
  assert.equal(EVM_READ_TRY_MS, BigInt(SOLANA_RPC_RETRY.deadlineMs));
  assert.equal(EVM_POOL_READ_WAIT_MS, 30_000n - 4n * 3_500n);
  // the tries' own waits with no Retry-After (1 s doubled) fit the waits left; one more try and its wait do not
  const waits = (n: number) => BigInt([...Array(n - 1).keys()].reduce((x, i) => x + 1_000 * 2 ** i, 0));
  assert.ok(BigInt(EVM_POOL_READ_TRIES) * EVM_READ_TRY_MS + waits(EVM_POOL_READ_TRIES) <= EVM_POOL_READ_BOUND_MS);
  assert.ok(BigInt(EVM_POOL_READ_TRIES + 1) * EVM_READ_TRY_MS + waits(EVM_POOL_READ_TRIES + 1) > EVM_POOL_READ_BOUND_MS);
  assert.ok(EVM_POOL_READ_TRIES < EVM_LOG_THROTTLE_TRIES);
});

test("a pool read's Retry-After is waited when it fits the bound; one that would pass it fails by name at once, never a wait past the life", async () => {
  const after = (ms: number) => (): Error => new SolanaRpcTransportError("http_429", "HTTP 429", 4, "b.example", ms);
  // thirdweb's Retry-After of up to 9 s (the review of card wallet-restore-transfer-rpcs, 5 Nov): one is waited, then the answer
  let rpcs = pair(c3, c3);
  rpcs[1] = flaky(rpcs[1], byNumber("latest"), [after(9_000)]);
  let waits: number[] = [];
  assert.equal(await evmNow(rpcs, undefined, async (ms) => void waits.push(ms)), await evmNow(pair(c3, c3)));
  assert.deepEqual(waits, [9_000]);
  // 9 s again: 18 s of waits would pass the 16 s left, so the read ends by name after the first wait
  rpcs = pair(c3, c3);
  const f = flaky(rpcs[1], byNumber("latest"), Array(100).fill(after(9_000)));
  rpcs[1] = f;
  waits = [];
  await assert.rejects(evmNow(rpcs, undefined, async (ms) => void waits.push(ms)), /^EvmUnansweredError: rpc 1 latest block: no answer in 2 tries \(HTTP 429/);
  assert.deepEqual(waits, [9_000]);
  assert.equal(f.hits, 2);
  // a Retry-After past the whole bound (60 s): no wait at all
  rpcs = pair(c3, c3);
  rpcs[1] = flaky(rpcs[1], byNumber("latest"), Array(100).fill(after(60_000)));
  waits = [];
  await assert.rejects(evmNow(rpcs, undefined, async (ms) => void waits.push(ms)), /^EvmUnansweredError: rpc 1 latest block: no answer in 1 try \(HTTP 429/);
  assert.deepEqual(waits, []);
});

for (const rd of READS) {
  test(`${rd.name}: a 429 with no Retry-After, then an answer, passes; a timeout then an answer passes; never answered fails by name within the bound`, async () => {
    const c = chainOf(rd);
    const clean = await rd.run(pair(c, c), async () => {});
    for (const fault of [HTTP_429, TIMED_OUT]) {
      const rpcs = pair(c, c);
      const f = flaky(rpcs[rd.side], rd.hit, [fault]);
      rpcs[rd.side] = f;
      const waits: number[] = [];
      assert.deepEqual(await rd.run(rpcs, async (ms) => void waits.push(ms)), clean, fault().message);
      assert.ok(f.hits >= 2, `${f.hits} matching calls`);
      assert.deepEqual(waits, [1_000], fault().message);
    }
    const rpcs = pair(c, c);
    const f = flaky(rpcs[rd.side], rd.hit, Array(100).fill(HTTP_429));
    rpcs[rd.side] = f;
    const waits: number[] = [];
    const e = await rd.run(rpcs, async (ms) => void waits.push(ms)).then(() => assert.fail("answered"), (x: unknown) => x as Error);
    assert.ok(e instanceof EvmUnansweredError, String(e));
    assert.match(e.message, rd.what);
    assert.match(e.message, /no answer in 4 tries \(HTTP 429 \(http_429, 4 tries at b\.example\)\)$/);
    assert.equal(f.hits, EVM_POOL_READ_TRIES);
    assert.deepEqual(waits, [1_000, 2_000, 4_000]);
    assert.ok(BigInt(f.hits) * EVM_READ_TRY_MS + BigInt(waits.reduce((x, y) => x + y, 0)) <= EVM_POOL_READ_BOUND_MS);
  });
}

test("bind's chain fee view on the fee pair: a 429 then an answer passes; a timeout then an answer passes; never answered fails by name within the bound", async () => {
  const clean = await bindOn(pair(cb, cb), pair(cb, cb), async () => {});
  for (const fault of [HTTP_429, TIMED_OUT]) {
    const fee = pair(cb, cb);
    const f = flaky(fee[1], FEE_READ.hit, [fault]);
    fee[1] = f;
    const waits: number[] = [];
    assert.deepEqual(await bindOn(pair(cb, cb), fee, async (ms) => void waits.push(ms)), clean);
    assert.deepEqual(waits, [1_000]);
  }
  const fee = pair(cb, cb);
  const f = flaky(fee[1], FEE_READ.hit, Array(100).fill(TIMED_OUT));
  fee[1] = f;
  const waits: number[] = [];
  await assert.rejects(bindOn(pair(cb, cb), fee, async (ms) => void waits.push(ms)), (e: Error) => e instanceof EvmUnansweredError && FEE_READ.what.test(e.message) && /no answer in 4 tries \(no answer in 3500 ms \(timeout/.test(e.message));
  assert.equal(f.hits, EVM_POOL_READ_TRIES);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
});

test("the tree sync's reorg check (a mismatch: is the newest anchor's block still its hash?) survives a 429 and fails by name past the bound", async () => {
  // both RPCs say one more leaf than the logs make: a mismatch, refused once the anchor's block 100 reads unmoved
  const lie = { view: (name: string, v: bigint) => (name === "currentTreeSize" ? v + 1n : v) };
  // rpc 1's first read of block 100 is the agreed block's own; every later one is the check's
  for (const [faults, want, reads] of [[[HTTP_429], /^Error: the state tree from the logs \(4 leaves\) is not the pool's/, 3], [Array(100).fill(HTTP_429), /^EvmUnansweredError: rpc 1 block 100: no answer in 4 tries/, 1 + EVM_POOL_READ_TRIES]] as const) {
    const rpcs = pair(c3, c3, lie, lie);
    let seen = 0;
    rpcs[1] = flaky(rpcs[1], (m, p) => byNumber(q(100))(m, p, 0) && seen++ >= 1, [...faults]);
    await assert.rejects(syncOn(rpcs, async () => {}).trees(after(25)), want);
    assert.equal(seen, reads);
  }
});

test("a pool read that failed by name is never tried again by a read around it (the restore's evmAnswered): one bound, never one inside another", async () => {
  const rpcs = pair(c3, c3);
  const f = flaky(rpcs[1], byNumber("latest"), Array(100).fill(HTTP_429));
  rpcs[1] = f;
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  await assert.rejects(evmAnswered(() => evmNow(rpcs, undefined, sleep), undefined, sleep), /^EvmUnansweredError: rpc 1 latest block: no answer in 4 tries/);
  assert.equal(f.hits, EVM_POOL_READ_TRIES);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
});

test("an abort during a pool read's wait ends it at once, and the other RPC's read with it", async () => {
  const rpcs = pair(c3, c3);
  rpcs[1] = flaky(rpcs[1], byNumber("latest"), Array(100).fill(HTTP_429));
  const ac = new AbortController();
  const t0 = Date.now();
  const p = evmNow(rpcs, ac.signal);
  setTimeout(() => ac.abort(new Error("stopped")), 50);
  await assert.rejects(p, /stopped/);
  assert.ok(Date.now() - t0 < 900, `${Date.now() - t0} ms`);
});

// ---- card evm-transfer-rpc-spares: a pool read's pinned list keeps two operators while one is out ----

/** thirdweb's keyless daily quota as the device's client ends it: HTTP 429, Retry-After 26,741 s (5 Nov 16:28Z). */
const QUOTA_OUT = (): Error => new SolanaRpcTransportError("http_429", "HTTP 429", 1, "out.example", 26_741_000);
/** r answering every call with `fault` (counted) */
const out = (r: EvmRpc, fault: () => Error, url: string): EvmRpc & { asked: number } => {
  const f = Object.assign(async () => {
    f.asked++;
    throw fault();
  }, { url, asked: 0 });
  void r;
  return f;
};

test("P1 a pool's reads on a pinned list (now, trees, bind on the sync list and the fee list) swap a provider out for hours for the spare at once: the same answers, no wait begun, the out provider asked once per call in flight", async () => {
  const c = CB();
  const clean = evmPool({ pin: PIN, ...pairs(pair(c, c)), relayFee: async () => answer(), epochFee: feeRule([]), salt: () => new Uint8Array(16) });
  const want = [await clean.now(), (await clean.trees(after(25))).stateTree.root, (await clean.bind(bindArgs())).context];
  for (const side of [0, 1]) {
    const [a, b] = pair(c, c);
    const o = out(a, QUOTA_OUT, "https://out.example"), fo = out(a, QUOTA_OUT, "https://out.example");
    const spare = rpc(c, { url: "https://e.example" });
    const list = side === 0 ? [o, b, spare] : [a, o, spare];
    const fees = side === 0 ? [fo, b, spare] : [a, fo, spare];
    const waits: number[] = [];
    const p = evmPool({ pin: PIN, rpcs: list, feeRpcs: fees, relayFee: async () => answer(), epochFee: feeRule([]), salt: () => new Uint8Array(16), sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual([await p.now(), (await p.trees(after(25))).stateTree.root, (await p.bind(bindArgs())).context], want, `side ${side}`);
    assert.deepEqual(waits, [], `side ${side}: a wait begun: ${waits}`);
    assert.equal(o.asked, 1, `side ${side}: the out provider asked ${o.asked} times on the sync list`);
    // bind's two chain fee views run at once: each asks the out provider once, then the spare
    assert.ok(fo.asked >= 1 && fo.asked <= 2, `side ${side}: the out provider asked ${fo.asked} times on the fee list`);
  }
});

test("P2 evmPair: two seats never on one provider; a throttle with no free spare goes up to the read's own waits; a slow log page stays (its pager halves it); an HTTP error with no JSON-RPC answer swaps; a rested provider comes back", async () => {
  assert.throws(() => evmPair([rpc(c3, {})]), /^Error: rpcs: two or more$/);
  assert.throws(() => evmPair([rpc(c3, { url: "https://a.example" }), rpc(c3, { url: "https://b.example" }), rpc(c3, { url: "https://a.example/" })]), /one provider twice/);
  const urls = (p: readonly EvmRpc[]) => p.map((r) => r.url);
  // three providers: a throttles, b (the other seat's) stays, c takes a's seat; then c throttles with a resting: the
  // seat takes a (its rest ends first: no Retry-After) and the error goes up for the read's wait
  let n = { a: 0, b: 0, c: 0 };
  const mk = (k: "a" | "b" | "c", fail: (i: number) => Error | null) => Object.assign(async () => {
    const e = fail(n[k]++);
    if (e) throw e;
    return "0x1";
  }, { url: `https://${k}.example` });
  const p = evmPair([mk("a", () => HTTP_429()), mk("b", () => null), mk("c", (i) => (i === 0 ? null : HTTP_429()))]);
  assert.deepEqual(urls(p), ["https://a.example", "https://b.example"]);
  assert.equal(await p[0]("eth_chainId", []), "0x1");
  assert.deepEqual(urls(p), ["https://c.example", "https://b.example"]);
  await assert.rejects(p[0]("eth_chainId", []), /HTTP 429/);
  assert.deepEqual(urls(p), ["https://a.example", "https://b.example"], "the provider back soonest, never b");
  assert.deepEqual(n, { a: 1, b: 0, c: 2 });
  // a slow eth_getLogs page: the error goes up on the same seat (the pager halves the page); a slow block read swaps
  n = { a: 0, b: 0, c: 0 };
  const q = evmPair([mk("a", () => TIMED_OUT()), mk("b", () => null), mk("c", () => null)]);
  await assert.rejects(q[0]("eth_getLogs", [{}]), /no answer in 3500 ms/);
  assert.deepEqual(urls(q), ["https://a.example", "https://b.example"]);
  assert.equal(await q[0]("eth_getBlockByNumber", ["latest", false]), "0x1");
  assert.deepEqual(urls(q), ["https://c.example", "https://b.example"]);
  // a provider out (1rpc's HTTP 410 and its "answer id null", dRPC's -32601 for a standard method, 5 Nov 18:00-18:05Z): swapped; a provider's
  // refusal in JSON-RPC words (dRPC's HTTP 400 code 35) is the read's, never a swap
  n = { a: 0, b: 0, c: 0 };
  const g = evmPair([mk("a", (i) => new Error(i === 0 ? "HTTP 410" : "HTTP 400: RPC error 35: ranges over 10000 blocks are not supported on free plan")), mk("b", () => null), mk("c", () => null)]);
  assert.equal(await g[0]("eth_getLogs", [{}]), "0x1");
  assert.deepEqual(urls(g), ["https://c.example", "https://b.example"]);
  // and a provider that refuses a read for want of a key (robinhood-rpc.publicnode.com, the kit's first Robinhood
  // provider, at a log read 2,000 blocks back: HTTP 403 "Archive requests require a personal token", 5 Nov 18:55Z)
  for (const words of ["answer id null is not request id 6", "HTTP 400: RPC error -32601: the method eth_getBlockByNumber does not exist/is not available", "RPC error -32602: invalid argument 0: missing required field 'address' for log filter", "HTTP 403: RPC error -32602: Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode", "HTTP 401: RPC error -32001: unauthorized"]) {
    n = { a: 0, b: 0, c: 0 };
    const o = evmPair([mk("a", () => new Error(words)), mk("b", () => null), mk("c", () => null)]);
    assert.equal(await o[0]("eth_getBlockByNumber", ["latest", false]), "0x1", words);
    assert.deepEqual(urls(o), ["https://c.example", "https://b.example"], words);
  }
  const h = evmPair([mk("a", () => new Error("HTTP 400: RPC error 35: ranges over 10000 blocks are not supported on free plan")), mk("b", () => null), mk("c", () => null)]);
  await assert.rejects(h[0]("eth_getLogs", [{}]), /RPC error 35/);
  assert.deepEqual(urls(h), ["https://a.example", "https://b.example"]);
  // no spare free: the error goes up with the seated provider's own Retry-After, never the out one's hours
  n = { a: 0, b: 0, c: 0 };
  const quota = () => new SolanaRpcTransportError("http_429", "HTTP 429", 1, "c.example", 26_741_000);
  const u = evmPair([mk("a", () => HTTP_429()), mk("b", () => null), mk("c", () => quota())]);
  const up = await u[0]("eth_chainId", []).then(() => null, (e: unknown) => e as { afterMs: number | null; name: string });
  assert.deepEqual([up?.name, up?.afterMs, urls(u)[0]], ["SolanaRpcTransportError", null, "https://a.example"]);
  // a rest of EVM_SPARE_REST_MS: once it ends the provider is a spare again
  const real = Date.now;
  try {
    let t = real();
    Date.now = () => t;
    n = { a: 0, b: 0, c: 0 };
    const r = evmPair([mk("a", (i) => (i === 0 ? HTTP_429() : null)), mk("b", () => null), mk("c", () => HTTP_429())]);
    await assert.rejects(r[0]("eth_chainId", []), /HTTP 429/); // a, then c: both rest, the error goes up
    t += EVM_SPARE_REST_MS + 1;
    assert.equal(await r[0]("eth_chainId", []), "0x1");
    assert.deepEqual(n, { a: 2, b: 0, c: 1 });
  } finally {
    Date.now = real;
  }
});

// ---- card helper-evm-range-cap-walk, review of 8cdf6ee8: one provider never answers both sides of one agreed read; a
// seat call asks each provider at most once ----

/** A bare provider for evmPair: `answer(span)` returns a list or throws; every getLogs range it is asked is logged. */
const bareRpc = (url: string, asked: string[], answer: (span: number) => unknown): EvmRpc => Object.assign(async (method: string, params: readonly unknown[]) => {
  if (method !== "eth_getLogs") return "0x1";
  const f = params[0] as { fromBlock: string; toBlock: string };
  asked.push(`${f.fromBlock}..${f.toBlock}`);
  return answer(Number(BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n));
}, { url });
const logRange = (a: number, b: number) => [{ address: "0x1", fromBlock: q(a), toBlock: q(b) }];
/** A provider that slows each call by `ms` (here: refuses later than the others answer). */
const delayed = (r: EvmRpc, ms: number): EvmRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
  await new Promise((res) => setTimeout(res, ms));
  return r(m, p);
}, { url: r.url });
/** Deposit 0's value (data word 2) as 7 wei on one provider only: its leaf and label stay, so the trees match. */
const lieAt10 = (l: Record<string, unknown>[]) => l.map((x) => (x.blockNumber === q(10) ? { ...x, data: `${(x.data as string).slice(0, 2 + 128)}${w64(7n)}${(x.data as string).slice(2 + 192)}` } : x));

test("card helper-evm-range-cap-walk (review P-A): a seat's cap walk never lands on the provider that answered the other seat in the read; a provider that answered a seat holds it at its cap (re-check of 6e90f580)", async () => {
  const askedA: string[] = [];
  const A = bareRpc("https://a.example", askedA, (span) => { if (span > 1000) throw new Error("HTTP 400: RPC error -32614: eth_getLogs is limited to a 1000 range"); return ["A's answer"]; });
  const B = bareRpc("https://b.example", [], () => { throw new Error("HTTP 400: RPC error -32600: You can make eth_getLogs requests with up to a 10 block range."); });
  const C = bareRpc("https://c.example", [], () => ["C's answer"]);
  const pair = evmPair([A, B, C]);
  const [s0, s1] = pair;
  // one agreed read, as the pool sync's: seat 0 pages first, then seat 1 reads the same blocks
  let seat0Done!: () => void;
  const after0 = new Promise<void>((r) => (seat0Done = r));
  const [, y] = await evmAgreedRead(pair, async (rpc, k) => {
    if (k === 0) {
      try {
        assert.deepEqual(await rpc("eth_getLogs", logRange(0, 999)), ["A's answer"]);
        // A caps the next page at 1,000: A answered seat 0 in this read, so seat 0 stays and its refusal goes up (the
        // pager pages at 1,000), and C stays free for seat 1
        await assert.rejects(rpc("eth_getLogs", logRange(1000, 2999)), /limited to a 1000 range/);
        assert.equal(s0.url, "https://a.example");
        return null;
      } finally {
        seat0Done();
      }
    }
    await after0;
    // seat 1's blocks 0..999: B caps at 10; A answered seat 0 in this read and sits there: seat 1 walks to C
    return rpc("eth_getLogs", logRange(0, 999));
  });
  assert.deepEqual(y, ["C's answer"]);
  assert.equal(s1.url, "https://c.example");
  assert.equal(askedA.filter((x) => x === `${q(0)}..${q(999)}`).length, 1, "A answered blocks 0..999 for one seat only");
});

test("card helper-evm-range-cap-walk (review P-C): on the kit's Base list shape, a first provider's lie never stands on both seats when its cap walks seat 0 away", async () => {
  const c = longChain([...deps(PP, [10, 150_000, 390_000])], 400_000);
  const count = { n: 0 };
  const lp: string[] = [], lb: string[] = [], lo: string[] = [], lk: string[] = [];
  const hostile: Over = { url: "https://base-rpc.publicnode.com", log: lp, logs: lieAt10, getLogs: ({ from, to }) => { if (to - from + 1 > 100_000) throw new Error("HTTP 400: RPC error -32701: exceed maximum block range: 100000"); } };
  const list = [
    rpc(c, hostile),
    delayed(rpc(c, capped("https://second.example", 5_000, () => "HTTP 400: RPC error -32001: Block range too large: maximum allowed is 5000 blocks on your current plan", count, lb)), 30),
    rpc(c, capped("https://mainnet.base.org", null, () => "", count, lo, () => { throw HTTP_429(); })),
    rpc(c, capped("https://base.api.pocket.network", 100_000, POCKET_WORDS, count, lk)),
  ];
  const r = await evmTreeSync({ rpcs: list, pin: PIN, sleep: async () => {} }).events().then((x) => x.events.map((e) => String((e as { value?: bigint }).value)), (e: Error) => `refused: ${e.message}`);
  assert.ok(typeof r === "string" ? /refused/.test(r) : !r.includes("7"), `the lied value stood: ${JSON.stringify(r)}`);
});

test("card helper-evm-range-cap-walk (review P-E): the throttle walk too never seats the provider that answered the other seat in the read, after its rest", async () => {
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  try {
    const askedA: string[] = [];
    let a = 0, b = 0;
    const A = bareRpc("https://a.example", askedA, () => { if (a++ === 1) throw HTTP_429(); return ["A's answer"]; });
    const B = bareRpc("https://b.example", [], () => { if (b++ === 0) throw HTTP_429(); return ["B's answer"]; });
    const C = bareRpc("https://c.example", [], () => ["C's answer"]);
    const pair = evmPair([A, B, C]);
    const [, s1] = pair;
    let seat0Done!: () => void;
    const after0 = new Promise<void>((r) => (seat0Done = r));
    await assert.rejects(evmAgreedRead(pair, async (rpc, k) => {
      if (k === 0) {
        assert.deepEqual(await rpc("eth_getLogs", logRange(0, 999)), ["A's answer"]);
        assert.deepEqual(await rpc("eth_getLogs", logRange(1000, 1999)), ["C's answer"]); // A 429s: rests, seat 0 to C
        t += EVM_SPARE_REST_MS + 1;
        seat0Done();
        return null;
      }
      await after0;
      // B 429s: C is seat 0's and A answered seat 0 in this read, so none is free: B's own 429 goes up
      return rpc("eth_getLogs", logRange(0, 999));
    }), /HTTP 429/);
    assert.notEqual(s1.url, "https://a.example");
    assert.equal(askedA.filter((x) => x === `${q(0)}..${q(999)}`).length, 1);
  } finally {
    Date.now = real;
  }
});

test("card helper-evm-range-cap-walk (review P-H): providers that refuse every span naming one block under it end a seat call after one ask each", async () => {
  let calls = 0;
  const under = (url: string) => bareRpc(url, [], (span) => {
    if (++calls > 2_000) throw Object.assign(new Error("the test's stop"), { name: "EvmUnansweredError" });
    throw new Error(`HTTP 400: RPC error -32001: Block range too large: maximum allowed is ${span - 1} blocks on your current plan`);
  });
  const [s0] = evmPair([under("https://x.example"), bareRpc("https://y.example", [], () => []), under("https://z.example")]);
  await assert.rejects(s0("eth_getLogs", logRange(0, 999)), /maximum allowed is 999/);
  const first = calls;
  await assert.rejects(s0("eth_getLogs", logRange(0, 499)), /maximum allowed is 499/);
  assert.ok(first <= 2 && calls - first <= 2, `first call ${first} asks, second ${calls - first}`);
});

test("card helper-evm-range-cap-walk (review LOW): a refusal from the provider a walk moved the seat to sizes that provider's page, never the one it left", async () => {
  const c = longChain([...deps(PP, [10, 150_000, 390_000])], 400_000);
  const count = { n: 0 };
  const la: string[] = [], lb: string[] = [], lc: string[] = [];
  const list = [
    rpc(c, capped("https://a.example", 50_000, PUBLICNODE_WORDS, count, la)),
    rpc(c, capped("https://b.example", 10, BLAST_WORDS, count, lb)),
    rpc(c, capped("https://c.example", 25_000, () => "HTTP 400: RPC error -32614: eth_getLogs is limited to a 25000 range", count, lc)),
  ];
  const r = await evmTreeSync({ rpcs: list, pin: PIN, sleep: async () => {} }).events();
  assert.equal(r.events.length, 3);
  // c refused 100,000 for seat 1 after b's walk: c pages at its own 25,000 at once, never halved from b's page
  const x = pageSizes(lc);
  assert.deepEqual(x.slice(0, 2), [100_000, 25_000], `c's pages ${x.slice(0, 6)}`);
});

test("card helper-evm-range-cap-walk (re-check of d2b77940): a seat read alone, outside an agreed read, binds no provider: the next agreed read may seat it on the other side", async () => {
  const A = bareRpc("https://a.example", [], (span) => { if (span > 1000) throw new Error("HTTP 400: RPC error -32614: eth_getLogs is limited to a 1000 range"); return ["A's answer"]; });
  const B = bareRpc("https://b.example", [], () => { throw new Error("HTTP 400: RPC error -32600: You can make eth_getLogs requests with up to a 10 block range."); });
  const C = bareRpc("https://c.example", [], () => ["C's answer"]);
  const pair = evmPair([A, B, C]);
  const [s0, s1] = pair;
  // seat 0 alone (a W's transfer scan, a time read): A answers, then caps a wider page and seat 0 walks to C
  assert.deepEqual(await s0("eth_getLogs", logRange(0, 999)), ["A's answer"]);
  assert.deepEqual(await s0("eth_getLogs", logRange(1000, 2999)), ["C's answer"]);
  // the next agreed read: seat 1's B caps at 10 and walks to A, which answered seat 0 only outside a read
  const [x, y] = await evmAgreedRead(pair, (rpc) => rpc("eth_getLogs", logRange(0, 999)));
  assert.deepEqual([x, y], [["C's answer"], ["A's answer"]]);
  assert.equal(s1.url, "https://a.example");
});

/** P-C's list, built fresh: [publicnode lying on deposit 0's value, a 5,000 cap 30 ms slow, mainnet.base.org 429, Pocket]. */
const lyingList = () => {
  const c = longChain([...deps(PP, [10, 150_000, 390_000])], 400_000);
  const count = { n: 0 };
  const lp: string[] = [];
  const hostile: Over = { url: "https://base-rpc.publicnode.com", log: lp, logs: lieAt10, getLogs: ({ from, to }) => { if (to - from + 1 > 100_000) throw new Error("HTTP 400: RPC error -32701: exceed maximum block range: 100000"); } };
  const list = [
    rpc(c, hostile),
    delayed(rpc(c, capped("https://second.example", 5_000, () => "HTTP 400: RPC error -32001: Block range too large: maximum allowed is 5000 blocks on your current plan", count, [])), 30),
    rpc(c, capped("https://mainnet.base.org", null, () => "", count, [], () => { throw HTTP_429(); })),
    rpc(c, capped("https://base.api.pocket.network", 100_000, POCKET_WORDS, count, [])),
  ];
  const twice = () => { const p = lp.filter((x) => x.startsWith("eth_getLogs")); return p.length - new Set(p).size; };
  return { list, twice };
};

test("card helper-evm-range-cap-walk (re-check of 6e90f580, HIGH): one pair per read: the pool's trees() and the restore on P-C's list refuse the first provider's lie; evmPair hands back a pair it made as it is and refuses its seat in any other list", async () => {
  const a = lyingList();
  const pool = evmPool({ pin: PIN, rpcs: a.list, feeRpcs: a.list.slice(2), relayFee: async () => { throw new Error("unused"); }, epochFee: feeRule([]), salt: () => new Uint8Array(16), sleep: async () => {} });
  await assert.rejects(pool.trees(after(399_000)), /the two RPCs differ/);
  assert.equal(a.twice(), 0, "a publicnode page asked on both seats");
  const b = lyingList();
  await assert.rejects(evmRestoreNotes({ seed64: new Uint8Array(64), pin: PIN, rpcs: b.list, wallets: false, gap: 4, sleep: async () => {} }), /the two RPCs differ/);
  assert.equal(b.twice(), 0, "a publicnode page asked on both seats");
  const pair = evmPair(lyingList().list);
  assert.equal(evmPair(pair), pair);
  assert.equal(evmPair([pair[0], pair[1]]), pair);
  const spare = lyingList().list[3]!;
  assert.throws(() => evmPair([pair[0], pair[1], spare]), /a pair's seat in another list/);
  assert.throws(() => evmPair([pair[1], spare]), /a pair's seat in another list/);
});

test("card helper-evm-range-cap-walk (re-check of 6e90f580, MEDIUM): a call still on its way binds its provider: no seat walks onto it, across two agreed reads (P-L) or two calls on one seat in one read (the fee read's Promise.all)", async () => {
  const X = (log: string[]) => Object.assign(async (_m: string, p: readonly unknown[]) => {
    const f = p[0] as { fromBlock: string; toBlock: string };
    const span = Number(BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n);
    if (span > 50_000) throw new Error("HTTP 400: RPC error -32701: exceed maximum block range: 50000");
    if (f.fromBlock === q(0)) await new Promise((r) => setTimeout(r, 60)); // the slow page
    log.push("X");
    return ["X"];
  }, { url: "https://x.example" }) as EvmRpc;
  const Y = Object.assign(async () => { await new Promise((r) => setTimeout(r, 20)); throw new Error("HTTP 400: RPC error -32600: You can make eth_getLogs requests with up to a 10 block range."); }, { url: "https://y.example" }) as EvmRpc;
  const Z = Object.assign(async () => ["Z"], { url: "https://z.example" }) as EvmRpc;
  const settled = (p: Promise<unknown>) => p.then((v) => JSON.stringify(v), (e: Error) => `refused: ${e.message}`);
  // P-L: read 2's seat 0 waits on X's slow page; read 1's wide page caps X and walks seat 0 to Z; read 2's seat 1 caps
  // on Y and may not walk onto X while X's answer for seat 0 is still on its way
  {
    const log: string[] = [];
    const pair = evmPair([X(log), Y, Z]);
    const r2 = settled(evmAgreedRead(pair, (rpc) => rpc("eth_getLogs", logRange(0, 999))));
    await new Promise((r) => setTimeout(r, 5));
    const r1 = settled(evmAgreedRead(pair, (rpc, k) => (k === 0 ? rpc("eth_getLogs", logRange(5_000, 104_999)) : Promise.resolve(["idle"]))));
    const [a, b] = await Promise.all([r2, r1]);
    assert.notEqual(a, JSON.stringify([["X"], ["X"]]), `X stood on both sides: ${a}`);
    assert.match(a, /refused: .*10 block range/);
    assert.equal(b, JSON.stringify([["Z"], ["idle"]]));
  }
  // one read: seat 0 asks X two pages at once, the slow one and a wide one X caps (seat 0 walks to Z); seat 1 caps on Y
  {
    const log: string[] = [];
    const pair = evmPair([X(log), Y, Z]);
    const r = await settled(evmAgreedRead(pair, (rpc, k) => (k === 0 ? Promise.all([rpc("eth_getLogs", logRange(0, 999)), rpc("eth_getLogs", logRange(5_000, 104_999))]) : rpc("eth_getLogs", logRange(0, 999)))));
    assert.notEqual(r, JSON.stringify([[["X"], ["Z"]], ["X"]]), `X stood on both sides: ${r}`);
    assert.match(r, /refused: .*10 block range/);
  }
});

// the review's P-N fuzz of 6e90f580: 1, 2 and 3 agreed reads at once on one pair of 3 to 6 providers (caps, throttles,
// other refusals, a clock that jumps past rests); a provider whose answer stands on both sides of one read is counted
for (const overlap of [1, 2, 3]) test(`card helper-evm-range-cap-walk (re-check of 6e90f580, MEDIUM): ${overlap} agreed read(s) at once on one pair, 300 rounds: no provider's answer on both sides of a read`, async () => {
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  let seed = 4242 + overlap;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let reads = 0, bothSides = 0;
  try {
    for (let round = 0; round < 300; round++) {
      const n = 3 + Math.floor(rnd() * 4);
      const mode = Array.from({ length: n }, () => Math.floor(rnd() * 5));
      const list = Array.from({ length: n }, (_, i) => Object.assign(async (_m: string, params: readonly unknown[]) => {
        await new Promise((r) => setTimeout(r, Math.floor(rnd() * 4)));
        if (rnd() < 0.03) t += Math.floor(rnd() * 70_000);
        const f = params[0] as { fromBlock: string; toBlock: string };
        const span = Number(BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n);
        const m = mode[i]!, r = rnd();
        if (m === 1 && span > 50) throw new Error("RPC error -32001: maximum allowed is 50 blocks");
        if (m === 2 && r < 0.3) throw HTTP_429();
        if (m === 3 && r < 0.5) throw new Error(`RPC error -32001: maximum allowed is ${Math.max(1, Math.floor(span / 3))} blocks`);
        if (m === 4 && r < 0.2) throw new Error("RPC error -32602: some other refusal");
        return [i];
      }, { url: `https://p${i}.example` }) as EvmRpc);
      const pair = evmPair(list);
      const one = () => evmAgreedRead(pair, async (rpc) => {
        const got: number[] = [];
        for (let j = 0; j < 4; j++) {
          const from = Math.floor(rnd() * 1000), span = 1 + Math.floor(rnd() * 200);
          try { got.push(...((await rpc("eth_getLogs", logRange(from, from + span - 1))) as number[])); } catch { /* a refused page */ }
        }
        return got;
      }).then(([a, b]) => {
        reads++;
        if (a.some((x) => b.includes(x))) bothSides++;
      });
      await Promise.all(Array.from({ length: overlap }, () => one()));
    }
  } finally {
    Date.now = real;
  }
  assert.equal(reads, 300 * overlap);
  assert.equal(bothSides, 0);
});

/** A provider that answers every call HTTP 403 (robinhood-rpc.publicnode.com and robinhood.rpc.blxrbdn.com, evm.ts). */
const closedRpc = (url: string, tick: () => void): EvmRpc => Object.assign(async () => { tick(); throw new Error("HTTP 403"); }, { url }) as EvmRpc;

test("card helper-evm-range-cap-walk (re-check of 6e90f580, MEDIUM): honest reads on the kit's Base and Robinhood lists, with throttles and a far narrower spare, sync 1.5M blocks on every seed: a seat waits for its own wide provider before it pages a far narrower one", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const out: string[] = [];
  try {
    for (const net of ["base", "robinhood"] as const) for (let seed0 = 1; seed0 <= 8; seed0++) {
      let seed = seed0 * 7919;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const c = longChain([...deps(PP, [10, 700_000, 1_499_000])], 1_500_000);
      const count = { n: 0 };
      // each call 200 ms on the test's clock
      const at = (p: number, then?: () => void) => () => { clock += 200; if (rnd() < p) throw HTTP_429(); then?.(); };
      const list = net === "base"
        ? [
            rpc(c, capped("https://base-rpc.publicnode.com", 50_000, PUBLICNODE_WORDS, count, [], at(0.15))),
            rpc(c, capped("https://base-mainnet.public.blastapi.io", 10, BLAST_WORDS, count, [], at(0))),
            rpc(c, capped("https://mainnet.base.org", null, () => "", count, [], at(1))),
            rpc(c, capped("https://base.api.pocket.network", 100_000, POCKET_WORDS, count, [], at(0.02, () => { if (rnd() < 0.03) throw new Error("HTTP 400: RPC error -32602: invalid argument 0: block range exceeds maximum 500"); }))),
          ]
        : [
            closedRpc("https://robinhood-rpc.publicnode.com", () => void (clock += 200)),
            rpc(c, capped("https://robinhood.drpc.org", 10_000, () => "RPC error 35: ranges over 10000 blocks are not supported on free plan", count, [], at(0.05))),
            rpc(c, capped("https://rpc.mainnet.chain.robinhood.com", 100_000, (n) => `HTTP 400: RPC error -32602: query spans ${n} blocks (from 1 to ${n}), but only 100000 are allowed for this request; send one value per position`, count, [], at(0.15))),
            closedRpc("https://robinhood.rpc.blxrbdn.com", () => void (clock += 200)),
            rpc(c, capped("https://rpc-robinhood.globalstake.io", 5_000_000, () => "", count, [], at(0.02))),
          ];
      const r = await evmTreeSync({ rpcs: list, pin: PIN, sleep: async () => {} }).events().then((x) => x.events.map((e) => String((e as { value?: bigint }).value)).join(","), (e: Error) => `refused: ${e.message}`);
      out.push(`${net} seed ${seed0}: ${r}, ${count.n} getLogs`);
    }
  } finally {
    Date.now = realNow;
  }
  console.log(out.join("\n"));
  const one = String(10n ** 18n);
  for (const l of out) assert.match(l, new RegExp(`: ${one},${one},${one}, \\d+ getLogs$`), out.join("\n"));
});

test("card helper-evm-range-cap-walk (re-check of 6e90f580): with blastapi 30 ms slower, seat 0's cap walk from publicnode, which answered it, takes no second wide provider: seat 1 reads on Pocket, never 400,000 blocks at blastapi's 10", async () => {
  const c = longChain([...deps(PP, [10, 150_000, 390_000])], 400_000);
  const count = { n: 0 };
  const guard = () => { if (count.n > 300) throw new Error("RPC error -32603: the test's guard of 300 getLogs"); };
  const list = [
    rpc(c, capped("https://base-rpc.publicnode.com", 100_000, () => "HTTP 400: RPC error -32701: exceed maximum block range: 100000", count, [], guard)),
    delayed(rpc(c, capped("https://base-mainnet.public.blastapi.io", 10, BLAST_WORDS, count, [], guard)), 30),
    rpc(c, capped("https://mainnet.base.org", null, () => "", count, [], () => { guard(); throw HTTP_429(); })),
    rpc(c, capped("https://base.api.pocket.network", 100_000, POCKET_WORDS, count, [], guard)),
  ];
  const r = await evmTreeSync({ rpcs: list, pin: PIN, sleep: async () => {} }).events();
  assert.deepEqual(r.events.map((e) => String((e as { value?: bigint }).value)), Array(3).fill(String(10n ** 18n)));
  assert.ok(count.n < 40, `${count.n} getLogs`);
});

test("card helper-evm-range-cap-walk (review of e30c5c46, P5): a block read answered beside a log read holds no provider at its cap: blastapi's refusal still walks the seat to Pocket, free", async () => {
  const B = bareRpc("https://base-mainnet.public.blastapi.io", [], (span) => { if (span > 10) throw new Error(BLAST_WORDS()); return ["B"]; });
  const pair = evmPair([bareRpc("https://base-rpc.publicnode.com", [], () => ["A"]), B, bareRpc("https://base.api.pocket.network", [], () => ["C"])]);
  // as queue.take()'s now() beside a pass's trees(): seat 1's block read is answered by blastapi inside the read
  const [, y] = await evmAgreedRead(pair, async (rpc) => {
    await rpc("eth_getBlockByNumber", ["latest", false]);
    return rpc("eth_getLogs", logRange(0, 39_999));
  });
  assert.deepEqual(y, ["C"]);
  assert.equal(pair[1].url, "https://base.api.pocket.network");
});

test("card helper-evm-range-cap-walk (review of e30c5c46, P6): a seat moved back from a narrow provider to a wide one pages at the wide one's own size, never the narrow page doubled", async () => {
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  const pages: Record<string, number> = {};
  let once = true;
  const mk = (name: string, cap: number, throttleOnce = false) => Object.assign(async (method: string, params: readonly unknown[]) => {
    if (method === "eth_getBlockByNumber") { const b = BigInt(params[0] as string); return { number: q(b), hash: `0x${w64(b)}`, timestamp: q(b) }; }
    const f = params[0] as { fromBlock: string; toBlock: string };
    if (throttleOnce && once) { once = false; throw HTTP_429(); }
    if (BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n > BigInt(cap)) throw new Error(`HTTP 400: RPC error -32600: You can make eth_getLogs requests with up to a ${cap} block range.`);
    pages[name] = (pages[name] ?? 0) + 1;
    return [];
  }, { url: `https://${name}.example` }) as EvmRpc;
  try {
    const pair = evmPair([mk("a", 100_000), mk("b", 10), mk("d", 100_000, true)]);
    const pager = evmPoolLogPager();
    const read = (to: bigint) => {
      const anchor = { number: to, hash: `0x${w64(to)}`, timestamp: to, baseFeePerGas: null };
      return evmAgreedLogs(pair, { address: "0x1", topics: [] }, () => { throw new Error("no logs here"); }, 0n, { fin: anchor, anchor }, pager, 0, undefined, async (ms) => void (t += ms));
    };
    // read 1: seat 1 on b (10 blocks); d throttles once and rests, so seat 1 pages b
    await read(300n);
    assert.ok((pages.b ?? 0) >= 30, `b's pages ${pages.b}`);
    t += EVM_SPARE_REST_MS + 1_000;
    // read 2: d's rest is over: seat 1 moves back to d at its first call and reads 100,000 blocks in d's own pages
    const d1 = pages.d ?? 0;
    await read(99_999n);
    assert.equal(pair[1].url, "https://d.example");
    assert.ok((pages.d ?? 0) - d1 <= 2, `${(pages.d ?? 0) - d1} pages on d for 100,000 blocks it takes in one`);
  } finally {
    Date.now = real;
  }
});

test("card helper-evm-range-cap-walk (review of e30c5c46, M5): a move back that fails returns the seat to its own provider, never on to the next in the list", async () => {
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  let pocketOnce = true;
  try {
    const H = bareRpc("https://h.example", [], (span) => { if (span > 1000) throw new Error("HTTP 400: RPC error -32614: eth_getLogs is limited to a 1000 range"); return ["H"]; });
    const M = Object.assign(async () => { throw HTTP_429(); }, { url: "https://m.example" }) as EvmRpc;
    const P = bareRpc("https://p.example", [], () => { if (pocketOnce) { pocketOnce = false; throw HTTP_429(); } return ["P"]; });
    const pair = evmPair([H, bareRpc("https://s.example", [], () => ["S"]), M, P]);
    const [s0] = pair;
    // H names its 1,000 cap; M and P throttle, so seat 0 stays on H, whose own refusal goes up
    await assert.rejects(s0("eth_getLogs", logRange(0, 1999)), /limited to a 1000 range/);
    assert.equal(s0.url, "https://h.example");
    t += EVM_SPARE_REST_MS + 1_000;
    // M's rest is over: seat 0 moves back to M (no cap known), which throttles: the seat returns to H, not on to P
    assert.deepEqual(await s0("eth_getLogs", logRange(0, 999)), ["H"]);
    assert.equal(s0.url, "https://h.example");
  } finally {
    Date.now = real;
  }
});

test("card helper-evm-range-cap-walk (review of a81876ab, P7): a page the wide provider answered after a move back, asked at the narrow one's size, is never its widest: one timeout keeps its own page", async () => {
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  const pages: Record<string, number> = {};
  let once = true;
  let dSlow = false;
  const mk = (name: string, cap: number, throttleOnce = false) => Object.assign(async (method: string, params: readonly unknown[]) => {
    if (method === "eth_getBlockByNumber") { const b = BigInt(params[0] as string); return { number: q(b), hash: `0x${w64(b)}`, timestamp: q(b) }; }
    const f = params[0] as { fromBlock: string; toBlock: string };
    const span = BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n;
    if (throttleOnce && once) { once = false; throw HTTP_429(); }
    if (name === "d" && dSlow && span > 10n) { dSlow = false; throw new Error("no answer in 3500 ms"); }
    if (span > BigInt(cap)) throw new Error(`HTTP 400: RPC error -32600: You can make eth_getLogs requests with up to a ${cap} block range.`);
    pages[name] = (pages[name] ?? 0) + 1;
    return [];
  }, { url: `https://${name}.example` }) as EvmRpc;
  try {
    const pair = evmPair([mk("a", 100_000), mk("b", 10), mk("d", 100_000, true)]);
    const pager = evmPoolLogPager();
    const read = (to: bigint) => {
      const anchor = { number: to, hash: `0x${w64(to)}`, timestamp: to, baseFeePerGas: null };
      return evmAgreedLogs(pair, { address: "0x1", topics: [] }, () => { throw new Error("no logs here"); }, 0n, { fin: anchor, anchor }, pager, 0, undefined, async (ms) => void (t += ms));
    };
    // read 1: seat 1 on b (10 blocks); d throttles once and rests, so seat 1 pages b
    await read(300n);
    t += EVM_SPARE_REST_MS + 1_000;
    // read 2: seat 1 moves back to d, which answers b's 10-block page, then times out once on its own wide page: the
    // same page again, never d's page cut to the 10 it answered in b's place
    dSlow = true;
    const d1 = pages.d ?? 0;
    await read(99_999n);
    assert.equal(pair[1].url, "https://d.example");
    assert.ok((pages.d ?? 0) - d1 <= 2, `${(pages.d ?? 0) - d1} pages on d for 100,000 blocks it takes in one`);
  } finally {
    Date.now = real;
  }
});

test("card helper-evm-range-cap-walk (review of a81876ab, M7 and M11): a provider that paged one agreed read holds no seat in the next, and a read on one seat and an outside RPC binds no provider: the seat walks off its cap", async () => {
  const A = bareRpc("https://a.example", [], (span) => { if (span > 1000) throw new Error("HTTP 400: RPC error -32614: eth_getLogs is limited to a 1000 range"); return ["A"]; });
  const B = bareRpc("https://b.example", [], () => { throw new Error("HTTP 400: RPC error -32600: You can make eth_getLogs requests with up to a 10 block range."); });
  const pair = evmPair([A, B, bareRpc("https://c.example", [], () => ["C"]), bareRpc("https://d.example", [], () => ["D"])]);
  const [s0, s1] = pair;
  // read 1, agreed on the pair: A pages seat 0; seat 1 walks off B's 10 to C
  assert.deepEqual(await evmAgreedRead(pair, (rpc) => rpc("eth_getLogs", logRange(0, 999))), [["A"], ["C"]]);
  assert.equal(s1.url, "https://c.example");
  // read 2, on seat 0 and an RPC outside the pair: no read of the pair is open, so A holds nothing: A answers, then caps
  // a wider page, and seat 0 walks to D (C sits on seat 1)
  const outside = bareRpc("https://e.example", [], () => ["E"]);
  const [x] = await evmAgreedRead([s0, outside], async (rpc, k) => {
    if (k === 1) return null;
    assert.deepEqual(await rpc("eth_getLogs", logRange(1000, 1999)), ["A"]);
    return rpc("eth_getLogs", logRange(2000, 3999));
  });
  assert.deepEqual(x, ["D"]);
  assert.equal(s0.url, "https://d.example");
});
