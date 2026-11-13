// node --test packages/wallet/test/pool-evm-pass-rounds.test.ts: a Base or Robinhood landing's pass, the reads between
// the landing and its proof, takes 2 s, not 16 (card evm-pass-in-two-seconds, src/pool/evm.ts). The owner's mainnet copy
// (lrb run) read ready 25.85 s = seen 5.4 s + pass 15.9 s + prove 4.5 s. Here every host (the pool pair, the fee list and
// the helper's GET /v1/pool/fee) answers in 900 ms, and the test counts the sequential rounds from the pass's start to
// the prover's call: a call's round is one past the highest round any call finished before it started. At most 3, and
// the wall time inside 3 such rounds plus slack (a lag's sleep is time with no call, so it counts there).
// The RPCs are a mock chain (blocks every 2 s, the pool's logs, its views at each block), as pool-evm-reads-once's.
// Test leaves and the all-zero test seed only, never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VaultTree, vaultLabelOf, type VaultProver } from "@blindfill/kit";
import { noteCommitment, noteSecrets } from "../src/notes/secrets.ts";
import { openNoteStore } from "../src/notes/store.ts";
import { openWalletStore } from "../src/store/index.ts";
import { openProofQueue } from "../src/pool/queue.ts";
import { EVM_EPOCH_MS, EvmLagError, evmPool, evmPoolScopeOf, evmTreeSync, type EvmFeeAnswer, type EvmPoolPin, type EvmRpc } from "../src/pool/evm.ts";
import { SEED, signalsProver } from "./withdraw-fixture.ts";

type Set3 = { pool: string; commitments: string[]; labels: string[] };
const BP = JSON.parse(readFileSync(new URL("../../../contracts/pool-evm/test/fixtures/buy-proofs.json", import.meta.url), "utf8")) as { base: Set3 };
const PP = JSON.parse(readFileSync(new URL("../../../contracts/pool-evm/test/fixtures/pool-proofs.json", import.meta.url), "utf8")) as Set3;

const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const w64 = (x: bigint): string => x.toString(16).padStart(64, "0");
const q = (n: number | bigint): string => `0x${BigInt(n).toString(16)}`;
const h32 = (s: string): string => `0x${hex(keccak_256(enc.encode(s)))}`;
const sel = (s: string): string => hex(keccak_256(enc.encode(s)).subarray(0, 4));
const TOPIC_DEP = "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";
const ORACLE = "0x420000000000000000000000000000000000000f";

const ANSWER_MS = 900;
// T0 is on the epoch grid: block n's time is T0 + 2n s, so each period is 30 blocks, and the period of block 100 starts
// at block 90
const T0 = 1_800_000_000n;
const POOL = BP.base.pool;
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const PIN: EvmPoolPin = { network: "base", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n };
const SCOPE = evmPoolScopeOf(POOL, 8453n);

type Ev = { block: number; leaf: bigint; label: bigint };
type Chain = { events: Ev[]; head: number };
const ts = (n: number): bigint => T0 + 2n * BigInt(n);
const hashOf = (n: number): string => h32(`block ${n}`);

// the mock's own views, made once per chain and block (its hashing is the host's work, never the device's time)
const viewMemo = new WeakMap<Chain, Map<number, ReturnType<typeof viewsOf>>>();
function viewsAt(c: Chain, n: number) {
  let m = viewMemo.get(c);
  if (m === undefined) viewMemo.set(c, (m = new Map()));
  let v = m.get(n);
  if (v === undefined) m.set(n, (v = viewsOf(c, n)));
  return v;
}
function viewsOf(c: Chain, n: number) {
  const st = new VaultTree(), lt = new VaultTree();
  const stateTimes = new Map<bigint, bigint>(), labelTimes = new Map<bigint, bigint>();
  for (const e of c.events.filter((x) => x.block <= n)) {
    st.append([e.leaf]);
    stateTimes.set(st.root!, ts(e.block));
    lt.append([e.label]);
    labelTimes.set(lt.root!, ts(e.block));
  }
  return { root: st.root ?? 0n, size: BigInt(st.size), labelRoot: lt.root ?? 0n, labelSize: BigInt(lt.size), stateTimes, labelTimes };
}

/** The pass's clock of rounds: a call's round is one past the highest round finished before it started. */
function rounds() {
  const r = { on: false, done: 0, calls: 0, log: [] as string[] };
  const slow = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    if (!r.on) return f();
    const mine = r.done + 1;
    r.calls++;
    r.log.push(`${mine} ${what}`);
    await new Promise((ok) => setTimeout(ok, ANSWER_MS));
    try {
      return await f();
    } finally {
      if (mine > r.done) r.done = mine;
    }
  };
  return { r, slow };
}

function rpc(c: Chain, url: string, slow: ReturnType<typeof rounds>["slow"]): EvmRpc {
  const block = (n: number) => (n > c.head ? null : { number: q(n), hash: hashOf(n), timestamp: q(ts(n)), baseFeePerGas: q(1_000_000n + BigInt(n)), parentHash: hashOf(n - 1) });
  const f = (method: string, params: readonly unknown[]): Promise<unknown> =>
    slow(`${new URL(url).host} ${method} ${method === "eth_call" ? (params[0] as { data: string }).data.slice(0, 10) : JSON.stringify(params).slice(0, 60)}`, async () => {
      switch (method) {
        case "eth_chainId": return q(8453n);
        case "eth_getBlockByNumber": {
          const at = params[0] as string;
          return block(at === "latest" ? c.head : at === "finalized" ? c.head - 10 : Number(BigInt(at)));
        }
        case "eth_getLogs": {
          const p = params[0] as { fromBlock: string; toBlock: string };
          const from = Number(BigInt(p.fromBlock)), to = Number(BigInt(p.toBlock));
          const per = new Map<number, number>();
          return c.events.flatMap((e, i) => {
            const k = per.get(e.block) ?? 0;
            per.set(e.block, k + 1);
            if (e.block < from || e.block > to || e.block > c.head) return [];
            return [{ address: POOL, topics: [TOPIC_DEP, `0x${"d0d0".padStart(64, "0")}`], data: `0x${w64(e.leaf)}${w64(e.label)}${w64(10n ** 18n)}${w64(77n)}`, blockNumber: q(e.block), blockHash: hashOf(e.block), logIndex: q(k + 3), transactionHash: h32(`tx ${i}`), transactionIndex: q(k), removed: false }];
          });
        }
        case "eth_call": {
          const [{ to, data }, { blockHash }] = params as [{ to: string; data: string }, { blockHash: string }];
          let n = -1;
          for (let k = 0; k <= c.head; k++) if (hashOf(k) === blockHash) n = k;
          if (n < 0) throw new Error("RPC error -32000: header not found");
          const s = data.slice(2, 10), arg = data.length > 10 ? BigInt(`0x${data.slice(10)}`) : 0n;
          if (to === ORACLE) return `0x${w64(s === "f1c7a58b" ? 7_917n : 0n)}`;
          const v = viewsAt(c, n);
          const out =
            s === sel("SCOPE()") ? SCOPE
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
    });
  return Object.assign(f, { url });
}

const VALUE = 10n ** 17n;
const FEE = 1_000n;

/** A pool of `others` leaves before the period (each its own block below 90) and the device's own deposit landed at
 *  block 95, this period; the period's fee held at its turn and the landing's own round read, as on the signing page. */
async function landed(others: number) {
  const ws = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(ws);
  let queue: ReturnType<typeof openProofQueue> | undefined;
  const shut = async () => {
    await queue?.close();
    ns.close();
    ws.close();
  };
  try {
    return await on(others, ns, (q) => (queue = q), shut);
  } catch (e) {
    await shut();
    throw e;
  }
}
async function on(others: number, ns: Awaited<ReturnType<typeof openNoteStore>>, opened: (q: ReturnType<typeof openProofQueue>) => void, shut: () => Promise<void>) {
  const { r, slow } = rounds();
  let n = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
  const label = vaultLabelOf(keccak_256, SCOPE, 99n);
  const commitment = noteCommitment(VALUE, label, n.precommitment);
  const fixture = [...PP.commitments.map((x, i) => ({ leaf: BigInt(x), label: BigInt(PP.labels[i]!) })), ...BP.base.commitments.map((x, i) => ({ leaf: BigInt(x), label: BigInt(BP.base.labels[i]!) }))];
  const events: Ev[] = [];
  for (let i = 0; i < others; i++) {
    const f = fixture[i % fixture.length]!;
    // fixture leaves again past their count: each a fresh leaf (a hash of it and its place), a field element
    const salt = (x: bigint) => (i < fixture.length ? x : BigInt(h32(`${x} ${i}`)) >> 8n);
    events.push({ block: 2 + Math.floor((i * 80) / Math.max(1, others)), leaf: salt(f.leaf), label: salt(f.label) });
  }
  events.push({ block: 95, leaf: commitment, label });
  const c: Chain = { events, head: 91 };
  const rpcs = [rpc(c, "https://a.example", slow), rpc(c, "https://b.example", slow)];
  const feeRpcs = [rpc(c, "https://c.example", slow), rpc(c, "https://d.example", slow)];
  // the sync's clock: real time, moved on 2 s between the setup and the pass (the landing's memo is old by then)
  let skew = 0;
  const sync = evmTreeSync({ rpcs, pin: PIN, clock: () => performance.now() + skew });
  const relayFee = (e: bigint): Promise<EvmFeeAnswer> =>
    slow("helper GET /v1/pool/fee", async () => ({ chain: "evm", network: "base", pool: POOL, fee_recipient: FEE_TO, epoch_ms: Number(EVM_EPOCH_MS), epoch_start_ms: Number(e), block: q(90), fee: FEE.toString(), step: "0" }));
  const pool = evmPool({ pin: PIN, rpcs, feeRpcs, sync, relayFee, epochFee: () => FEE });
  const start = ts(91) * 1000n - (ts(91) * 1000n % EVM_EPOCH_MS);
  assert.equal(start, ts(90) * 1000n, "block 90 is the period's first block");
  // the turn: the page's hold reads the period's first block and its fee
  await pool.holdFee(start);
  // the landing: block 95 holds the deposit, the head two blocks on; the deposit's own round reads it
  c.head = 97;
  skew += 2_000;
  const round = await sync.events();
  assert.equal(round.events.length, others + 1);
  n = await ns.move(n.id, "PLANNED", "INCOMING");
  n = await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value: VALUE, label, commitment, leafIndex: BigInt(others) } });
  // the prover's call: its round and its time
  const at: { round?: number; ms?: number } = {};
  let t0 = 0;
  const sp = signalsProver();
  const prover: VaultProver = { load: sp.load, prove: async (circuit, input) => (at.round ??= r.done, (at.ms ??= performance.now() - t0), sp.prove(circuit, input)) };
  const queue = openProofQueue({ seed64: SEED, notes: ns, pool, provers: [prover], hardwareConcurrency: 4 });
  opened(queue);
  // the pass, a block after the landing's round and past its memo
  c.head = 98;
  skew += 2_000;
  return {
    async pass() {
      r.on = true;
      t0 = performance.now();
      // the chain moves on as Base does, a block every 2 s, while the pass reads
      const tick = setInterval(() => void c.head++, 2_000);
      try {
        return await queue.refresh();
      } finally {
        clearInterval(tick);
        r.on = false;
      }
    },
    at, r, ns, noteId: n.id, c, close: shut,
  };
}

test("card evm-pass-in-two-seconds: a landing's pass reaches the prover in at most 3 rounds of 900 ms hosts", async (t) => {
  for (const others of [3, 200]) {
    const l = await landed(others);
    try {
      const out = await l.pass();
      assert.ok(l.at.round !== undefined, `${others} leaves: the prover is called: ${JSON.stringify(out.failed)}`);
      const tail = `\n${l.r.log.join("\n")}`;
      t.diagnostic(`${others} leaves: the prover is called after ${l.at.round} rounds, ${l.r.calls} calls, ${Math.round(l.at.ms!)} ms into the pass`);
      assert.ok(l.at.round <= 3, `${others} leaves: the prover is called after ${l.at.round} rounds (${l.r.calls} calls, ${Math.round(l.at.ms!)} ms):${tail}`);
      assert.ok(l.at.ms! < 3 * ANSWER_MS + 600, `${others} leaves: the prover is called ${Math.round(l.at.ms!)} ms into the pass:${tail}`);
      assert.deepEqual(out.failed, [], `${others} leaves: the pass failed: ${JSON.stringify(out.failed)}`);
      assert.deepEqual(out.made, [l.noteId], `${others} leaves: the landed note's proof is made`);
    } finally {
      await l.close();
    }
  }
});

// ---- the risk the card holds: a cut made from one round with no root time read is still the chain's ----

/** A chain of `n` leaves, several in the period's first block (90) and the blocks either side, the head at 100. */
function cutChain(): { c: Chain; rpcs: EvmRpc[]; log: string[] } {
  const fixture = [...PP.commitments.map((x, i) => ({ leaf: BigInt(x), label: BigInt(PP.labels[i]!) })), ...BP.base.commitments.map((x, i) => ({ leaf: BigInt(x), label: BigInt(BP.base.labels[i]!) }))];
  const blocks = [3, 40, 88, 89, 89, 90, 90, 91, 99];
  const events = blocks.map((block, i) => ({ block, leaf: i < fixture.length ? fixture[i]!.leaf : BigInt(h32(`leaf ${i}`)) >> 8n, label: i < fixture.length ? fixture[i]!.label : BigInt(h32(`label ${i}`)) >> 8n }));
  const c: Chain = { events, head: 100 };
  const log: string[] = [];
  const counted = (url: string): EvmRpc => {
    const f = rpc(c, url, async (what, g) => (log.push(what), g()));
    return Object.assign((m: string, p: readonly unknown[]) => f(m, p), { url });
  };
  return { c, rpcs: [counted("https://a.example"), counted("https://b.example")], log };
}
const FIRST = (c: Chain) => ({ number: 90n, hash: hashOf(90), timestamp: ts(90), baseFeePerGas: 1_000_090n });
const rootTimeReads = (log: string[]) => log.filter((x) => x.includes(sel("stateRootTimes(uint256)")) || x.includes(sel("labelRootTimes(uint256)"))).length;

test("card evm-pass-in-two-seconds: the cut below the held first block is the root-time search's cut, the pool's own roots at the period's start, with no root time read", async () => {
  const start = ts(90) * 1000n;
  const searched = cutChain();
  const want = await evmTreeSync({ rpcs: searched.rpcs, pin: PIN, sleep: async () => {} }).trees(start);
  assert.ok(rootTimeReads(searched.log) > 0, "the search reads root times");
  const held = cutChain();
  const sync = evmTreeSync({ rpcs: held.rpcs, pin: PIN, sleep: async () => {} });
  const got = await sync.trees(start, undefined, { first: FIRST(held.c) });
  assert.equal(rootTimeReads(held.log), 0, "no root time read");
  assert.equal(got.stateTree.size, 5, "the leaves of blocks 3 to 89");
  assert.equal(got.stateRoot, want.stateRoot);
  assert.equal(got.labelRoot, want.labelRoot);
  assert.equal(got.stateTree.size, want.stateTree.size);
  // the chain's own: the pool's root once its last leaf before the period landed, its time before the start and the
  // next leaf's at or after it
  const v = viewsOf(held.c, 89);
  assert.equal(got.stateRoot, v.root);
  assert.equal(got.labelRoot, v.labelRoot);
  assert.ok(v.stateTimes.get(got.stateRoot)! * 1000n < start);
  // the bind's depth at that block is the same round's, with no read
  const n = held.log.length;
  assert.equal(await sync.depthAt(90n, undefined, hashOf(90)), 3, "7 leaves up to block 90: depth 3");
  assert.equal(held.log.length, n, "no read for the depth");
});

test("card evm-pass-in-two-seconds: a held first block one RPC no longer holds at its height is a retry, never a cut", async () => {
  const { c, rpcs } = cutChain();
  // rpc 1 holds another block 90 (a reorg it saw first): the round's check of the first block is a lag
  const other: EvmRpc = Object.assign(async (m: string, p: readonly unknown[]) => {
    const got = (await rpcs[1]!(m, p)) as { number?: string; hash?: string } | null;
    return m === "eth_getBlockByNumber" && p[0] === q(90) && got !== null ? { ...got, hash: h32("block 90 again") } : got;
  }, { url: "https://b.example" });
  const sync = evmTreeSync({ rpcs: [rpcs[0]!, other], pin: PIN, sleep: async () => {} });
  await assert.rejects(sync.trees(ts(90) * 1000n, undefined, { first: FIRST(c) }), EvmLagError);
  // and the depth at it is never taken from that round
  await assert.rejects(sync.depthAt(90n, undefined, hashOf(90)), EvmLagError);
});

test("card evm-pass-in-two-seconds: a newest read right after the pool's time takes that round's trees, the pool's own roots there, with no wait", async () => {
  const { c, rpcs, log } = cutChain();
  let waits = 0;
  const sync = evmTreeSync({ rpcs, pin: PIN, sleep: async () => void waits++, clock: () => 0 });
  const now = await sync.now();
  assert.equal(now, ts(100) * 1000n);
  const t = await sync.trees(now + 1n, undefined, { newest: true });
  assert.equal(waits, 0, "no lag: the anchor's own second is the caller's now");
  const v = viewsOf(c, 100);
  assert.equal(t.stateTree.size, c.events.length);
  assert.equal(t.stateRoot, v.root);
  assert.equal(t.labelRoot, v.labelRoot);
  assert.equal(rootTimeReads(log), 0);
  // the same read again past the next block's time reads a new round
  c.head = 101;
  const n = log.filter((x) => x.includes("eth_getLogs")).length;
  await sync.trees(ts(101) * 1000n + 1n, undefined, { newest: true });
  assert.ok(log.filter((x) => x.includes("eth_getLogs")).length > n, "a caller's now past the round's anchor reads again");
});

test("card evm-pass-in-two-seconds: a held first block both RPCs replaced (a reorg) is let go: the cut is searched by the root times, never taken below the old block", async () => {
  const { c, rpcs } = cutChain();
  let moved = false;
  const on = (r: EvmRpc): EvmRpc => Object.assign(async (m: string, p: readonly unknown[]) => {
    const got = (await r(m, p)) as { hash?: string } | null;
    return moved && m === "eth_getBlockByNumber" && p[0] === q(90) && got !== null ? { ...got, hash: h32("block 90 again") } : got;
  }, { url: r.url });
  const pair = [on(rpcs[0]!), on(rpcs[1]!)];
  const sync = evmTreeSync({ rpcs: pair, pin: PIN, sleep: async () => {} });
  const pool = evmPool({ pin: PIN, rpcs: pair, feeRpcs: [rpc(c, "https://c.example", async (_w, g) => g()), rpc(c, "https://d.example", async (_w, g) => g())], sync, relayFee: async () => assert.fail("no fee asked"), epochFee: () => FEE, sleep: async () => {} });
  const start = ts(90) * 1000n;
  await pool.holdFee(start);
  const want = await evmTreeSync({ rpcs: cutChain().rpcs, pin: PIN, sleep: async () => {} }).trees(start);
  moved = true;
  const got = await pool.trees(start);
  assert.equal(got.stateRoot, want.stateRoot, "the searched cut");
  assert.equal(got.stateTree.size, want.stateTree.size);
});
