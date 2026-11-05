// node --test packages/wallet/test/pool-evm-restore.test.ts: the EVM pool's restore from the 12 words, and each spent
// note's W's tokens (card notes-restore-evm, src/pool/evm-restore.ts). The RPCs are a mock chain: blocks, the pool's
// Deposited, Withdrawn and Bought logs as the pool emits them (their notes made from the test seed's own secrets), its
// views at each block computed from those logs, and ERC-20 (and one ERC-721) Transfer logs. Test seed only: the
// all-zero entropy of vectors/a8.json; never money.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { solanaJsonRpc, VaultTree, vaultLabelOf } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { refKey } from "../src/notes/store.ts";
import { EVM_LAG_TRIES, EVM_POOL_EVENTS, EVM_TRANSFER_TOPIC, EvmLagError, evmHoldsAnchor, evmPoolScopeOf, type EvmPoolPin, type EvmRpc } from "../src/pool/evm.ts";
import { evmRestore, evmRestoreNotes } from "../src/pool/evm-restore.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const w64 = (x: bigint): string => x.toString(16).padStart(64, "0");
const q = (n: number | bigint): string => `0x${BigInt(n).toString(16)}`;
const h32 = (s: string): string => `0x${hex(keccak_256(enc.encode(s)))}`;
const topicOf = (s: string): string => h32(s);
const TOPIC = { deposit: topicOf(EVM_POOL_EVENTS.Deposited), withdraw: topicOf(EVM_POOL_EVENTS.Withdrawn), buy: topicOf(EVM_POOL_EVENTS.Bought) };
const sel = (s: string): string => hex(keccak_256(enc.encode(s)).subarray(0, 4));
const VIEW_SELECTORS = ["SCOPE()", "currentRoot()", "currentTreeSize()", "currentLabelRoot()", "currentLabelTreeSize()"].map(sel);
const addrTopic = (a: string): string => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

const POOL = "0x00000000000000000000000000000000b1f1f001";
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const PIN: EvmPoolPin = { network: "base", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n };
const SCOPE = evmPoolScopeOf(POOL, 8453n);
const T0 = 1_800_000_000n;
const TA = "0x00000000000000000000000000000000000000aa"; // the token the buy bought
const TX = "0x00000000000000000000000000000000000000cc"; // a token on no list, sent to W0 later
const TY = "0x00000000000000000000000000000000000000dd"; // an ERC-721, sent to W1
const TZ = "0x00000000000000000000000000000000000000ee"; // sent to W0 past the finalized block
const TB = "0x00000000000000000000000000000000000000bb"; // sent to W0 before its release: not its
const STRANGER = "0x0000000000000000000000000000000000005555";

type PoolEv = { block: number; kind: "deposit" | "withdraw" | "buy"; state: bigint; label?: bigint; value: bigint; pre?: bigint; nul?: bigint; to?: string; token?: string };
type Xfer = { block: number; token: string; from: string; to: string; nft?: boolean };
type World = { pool: PoolEv[]; xfers: Xfer[]; head: number; finalized: number; hashOf: (n: number) => string };

const P = (ref: NoteRef) => noteSecrets(SEED, ref).precommitment;
const N = (ref: NoteRef) => noteSecrets(SEED, ref).nullifierHash;
const W = (l: bigint, j: number) => {
  const w = d.freshWallet(SEED, "evm", l, j);
  w.secretKey.fill(0);
  return w.address.toLowerCase();
};

/** The seeded chain: a stranger's deposits, two of ours and a second arrival, a buy of deposit 0 paying W0, a return
 * deposit, and a withdraw of its change paying W1; Transfer logs to W0 and W1 and to a stranger. */
function seeded() {
  let nonce = 0n;
  const pool: PoolEv[] = [];
  const dep = (block: number, pre: bigint, value: bigint): bigint => {
    const label = vaultLabelOf(keccak_256, SCOPE, ++nonce);
    pool.push({ block, kind: "deposit", state: noteCommitment(value, label, pre), label, value, pre });
    return label;
  };
  const d0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 }, d1: NoteRef = { kind: "deposit", s: SCOPE, i: 1 };
  dep(5, 11n, 10n ** 16n);
  const l0 = dep(10, P(d0), 10n ** 16n);
  dep(12, P(d1), 2n * 10n ** 15n);
  dep(14, P({ kind: "second", id: { id: "U", s: SCOPE, i: 0 }, n: 0 }), 3n * 10n ** 15n);
  const c0: NoteRef = { kind: "change", l: l0, j: 0 }, c1: NoteRef = { kind: "change", l: l0, j: 1 };
  pool.push({ block: 20, kind: "buy", state: noteCommitment(6n * 10n ** 15n, l0, P(c0)), value: 4n * 10n ** 15n, nul: N(d0), to: W(l0, 0), token: TA });
  dep(30, P({ kind: "return", c: "evm", l: l0, j: 0 }), 10n ** 15n);
  dep(31, P({ kind: "move", l: l0, j: 0 }), 10n ** 15n);
  dep(32, P({ kind: "second", id: { id: "V", l: l0, j: 0 }, n: 0 }), 10n ** 15n);
  dep(33, P({ kind: "second", id: { id: "A", l: l0, j: 0 }, n: 0 }), 10n ** 15n);
  dep(34, P({ kind: "second", id: { id: "R", c: "evm", l: l0, j: 0 }, n: 0 }), 10n ** 15n);
  pool.push({ block: 40, kind: "withdraw", state: noteCommitment(0n, l0, P(c1)), value: 6n * 10n ** 15n, nul: N(c0), to: W(l0, 1) });
  dep(50, 12n, 10n ** 16n);
  dep(95, 13n, 10n ** 16n);
  const W0 = W(l0, 0), W1 = W(l0, 1);
  const xfers: Xfer[] = [
    { block: 8, token: TB, from: STRANGER, to: W0 },
    { block: 20, token: TA, from: STRANGER, to: W0 },
    { block: 25, token: TX, from: STRANGER, to: W0 },
    { block: 26, token: TA, from: W0, to: STRANGER },
    { block: 45, token: TY, from: STRANGER, to: W1, nft: true },
    { block: 70, token: TX, from: STRANGER, to: STRANGER },
    { block: 97, token: TZ, from: STRANGER, to: W0 },
  ];
  const world: World = { pool, xfers, head: 100, finalized: 90, hashOf: (n) => h32(`block ${n}`) };
  return { world, l0, W0, W1, d0, d1, c0, c1 };
}

function poolLogs(w: World): Record<string, unknown>[] {
  return w.pool.map((e, i) => {
    const data =
      e.kind === "deposit" ? w64(e.state) + w64(e.label!) + w64(e.value) + w64(e.pre!)
      : w64(BigInt(FEE_TO)) + w64(e.value) + w64(10n ** 12n) + w64(e.nul!) + w64(e.state) + (e.kind === "buy" ? w64(BigInt(e.token!)) + w64(1000n) : "");
    const who = e.kind === "deposit" ? STRANGER : e.to!;
    return { address: POOL, topics: [TOPIC[e.kind], addrTopic(who)], data: `0x${data}`, blockNumber: q(e.block), blockHash: w.hashOf(e.block), logIndex: q(0), transactionHash: h32(`pool tx ${i}`), transactionIndex: q(0), removed: false };
  });
}
function xferLogs(w: World): Record<string, unknown>[] {
  return [...w.xfers].sort((a, b) => a.block - b.block).map((x, i) => ({
    address: x.token, topics: [EVM_TRANSFER_TOPIC, addrTopic(x.from), addrTopic(x.to), ...(x.nft ? [`0x${w64(7n)}`] : [])], data: x.nft ? "0x" : `0x${w64(500n)}`,
    blockNumber: q(x.block), blockHash: w.hashOf(x.block), logIndex: q(1), transactionHash: h32(`xfer tx ${i}`), transactionIndex: q(1), removed: false,
  }));
}
function viewsAt(w: World, n: number) {
  const st = new VaultTree(), lt = new VaultTree();
  for (const e of w.pool.filter((e) => e.block <= n)) {
    st.append([e.state]);
    if (e.label !== undefined) lt.append([e.label]);
  }
  return { root: st.root ?? 0n, size: BigInt(st.size), labelRoot: lt.root ?? 0n, labelSize: BigInt(lt.size) };
}

type Over = {
  url?: string; chainId?: bigint;
  /** a provider's cap on a getLogs call's blocks, and on its results */
  cap?: number; resultCap?: number;
  pool?: (l: Record<string, unknown>[], call: number) => Record<string, unknown>[];
  /** a Transfer read's logs, those to the W asked (`to`, its topic) before the range filter */
  xfer?: (l: Record<string, unknown>[], call: number, to: string) => Record<string, unknown>[];
  log?: { method: string; params: unknown }[];
};
function rpc(w: World, o: Over = {}): EvmRpc {
  let poolCalls = 0, xferCalls = 0;
  const block = (n: number) => (n > w.head || n < 0 ? null : { number: q(n), hash: w.hashOf(n), timestamp: q(T0 + 2n * BigInt(n)), baseFeePerGas: q(1n) });
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    o.log?.push({ method, params });
    switch (method) {
      case "eth_chainId": return q(o.chainId ?? 8453n);
      case "eth_getBlockByNumber": {
        const at = params[0] as string;
        return block(at === "finalized" ? w.finalized : at === "latest" ? w.head : Number(BigInt(at)));
      }
      case "eth_getLogs": {
        const p = params[0] as { address?: string; topics: (string | string[] | null)[]; fromBlock: string; toBlock: string };
        const from = Number(BigInt(p.fromBlock)), to = Number(BigInt(p.toBlock));
        if (o.cap !== undefined && to - from + 1 > o.cap) throw new Error(`RPC error -32614: eth_getLogs is limited to a ${o.cap} range`);
        const inRange = (l: Record<string, unknown>) => Number(BigInt(l.blockNumber as string)) >= from && Number(BigInt(l.blockNumber as string)) <= to;
        let out: Record<string, unknown>[];
        if (p.address !== undefined) {
          assert.equal(p.address, POOL);
          assert.deepEqual(p.topics, [[TOPIC.deposit, TOPIC.withdraw, TOPIC.buy]]);
          out = (o.pool ?? ((x) => x))(poolLogs(w), poolCalls++).filter(inRange);
        } else {
          assert.equal(p.topics.length, 3);
          assert.equal(p.topics[0], EVM_TRANSFER_TOPIC);
          assert.equal(p.topics[1], null);
          const to = p.topics[2] as string;
          out = (o.xfer ?? ((x) => x))(xferLogs(w).filter((l) => (l.topics as string[])[2] === to), xferCalls++, to).filter(inRange);
        }
        if (o.resultCap !== undefined && out.length > o.resultCap) throw new Error(`RPC error -32005: query exceeds max results ${o.resultCap}, retry with the range ${from}-${to}`);
        return out;
      }
      case "eth_call": {
        const [{ to, data }, { blockHash }] = params as [{ to: string; data: string }, { blockHash: string }];
        assert.equal(to, POOL);
        let n = -1;
        for (let k = 0; k <= w.head; k++) if (w.hashOf(k) === blockHash) n = k;
        if (n < 0) throw new Error("RPC error -32000: header not found");
        const v = viewsAt(w, n);
        const s = data.slice(2, 10);
        const out =
          s === sel("SCOPE()") ? SCOPE
          : s === sel("currentRoot()") ? v.root
          : s === sel("currentTreeSize()") ? v.size
          : s === sel("currentLabelRoot()") ? v.labelRoot
          : s === sel("currentLabelTreeSize()") ? v.labelSize
          : assert.fail(`unexpected view ${data}`);
        return `0x${w64(out)}`;
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return Object.assign(f, { url: o.url ?? "https://a.example" });
}
const pair = (a: World, b: World, oa: Over = {}, ob: Over = {}): [EvmRpc, EvmRpc] => [rpc(a, { url: "https://a.example", ...oa }), rpc(b, { url: "https://b.example", ...ob })];
/** The Transfer RPCs: their own pair, never a provider of the pool's (card notes-restore-evm F7). */
const wpair = (a: World, b: World = a, oa: Over = {}, ob: Over = {}): [EvmRpc, EvmRpc] => [rpc(a, { url: "https://c.example", ...oa }), rpc(b, { url: "https://d.example", ...ob })];
type Extra = { sleep?: (ms: number) => Promise<void>; pick?: (n: number) => number };
const restore = (rpcs: [EvmRpc, EvmRpc], walletRpcs: [EvmRpc, EvmRpc], extra: Extra = {}) =>
  evmRestoreNotes({ seed64: SEED, pin: PIN, rpcs, walletRpcs, gap: 4, sleep: async () => {}, ...extra });
const isXfer = (c: { method: string; params: unknown }) => c.method === "eth_getLogs" && (c.params as [{ address?: string }])[0].address === undefined;
const namedIn = (log: NonNullable<Over["log"]>) => log.filter(isXfer).map((c) => (c.params as [{ topics: string[] }])[0].topics[2]!);
const byKey = (r: { notes: { ref: NoteRef; state: string }[] }) => new Map(r.notes.map((n) => [refKey(n.ref), n.state]));

test("restore of a seeded chain from the words alone: every note, each spent note's W, and every token each W holds", async () => {
  const { world, l0, W0, W1, d0, d1, c0, c1 } = seeded();
  const r = await restore(pair(world, world), wpair(world));
  const u0: NoteRef = { kind: "second", id: { id: "U", s: SCOPE, i: 0 }, n: 0 }, r0: NoteRef = { kind: "return", c: "evm", l: l0, j: 0 };
  const m0: NoteRef = { kind: "move", l: l0, j: 0 };
  const sec = (id: "V" | "A"): NoteRef => ({ kind: "second", id: { id, l: l0, j: 0 }, n: 0 });
  const rr: NoteRef = { kind: "second", id: { id: "R", c: "evm", l: l0, j: 0 }, n: 0 };
  assert.deepEqual(r.notes.map((n) => [refKey(n.ref), n.state, n.leaf.value, n.leaf.leafIndex]), [
    [refKey(d0), "SPENT", 10n ** 16n, 1n],
    [refKey(d1), "UNSPENT", 2n * 10n ** 15n, 2n],
    [refKey(u0), "UNSPENT", 3n * 10n ** 15n, 3n],
    [refKey(c0), "SPENT", 6n * 10n ** 15n, 4n],
    [refKey(m0), "UNSPENT", 10n ** 15n, 6n],
    [refKey(sec("V")), "UNSPENT", 10n ** 15n, 7n],
    [refKey(sec("A")), "UNSPENT", 10n ** 15n, 8n],
    [refKey(r0), "UNSPENT", 10n ** 15n, 5n],
    [refKey(rr), "UNSPENT", 10n ** 15n, 9n],
    [refKey(c1), "UNSPENT", 0n, 10n],
  ]);
  assert.equal(r.notes[3]!.parent, refKey(d0));
  assert.equal(r.notes[9]!.parent, refKey(c0));
  assert.deepEqual(r.spends.map((s) => [s.note, s.l, s.j, s.w, s.withdrawn, s.block, s.token]), [
    [refKey(d0), l0, 0, W0, 4n * 10n ** 15n, 20n, TA],
    [refKey(c0), l0, 1, W1, 6n * 10n ** 15n, 40n, null],
  ]);
  assert.deepEqual(r.elsewhere, []);
  // W0: the buy's token, a token on no list sent later, and one sent past the finalized block; not the one sent before
  // its release, nor the one it sent away. W1: an ERC-721 sent to it.
  assert.deepEqual(r.wallets, [{ note: refKey(d0), w: W0, tokens: [TA, TX, TZ] }, { note: refKey(c0), w: W1, tokens: [TY] }]);
  assert.equal(r.block, 100n);
});

test("a token bought outside any list is found: the read names no token, only W", async () => {
  const { world, W0 } = seeded();
  const OUT = "0x1234567890abcdef1234567890abcdef12345678";
  world.xfers.push({ block: 60, token: OUT, from: STRANGER, to: W0 });
  const log: Over["log"] = [];
  const r = await restore(pair(world, world), wpair(world, world, { log }));
  assert.ok(r.wallets[0]!.tokens!.includes(OUT));
  for (const c of log.filter(isXfer)) assert.deepEqual(Object.keys((c.params as [object])[0]).sort(), ["fromBlock", "toBlock", "topics"]);
  // a buy's token that sent W no Transfer log (a token that emits none) is still W's: the pool's Bought names it
  world.xfers = world.xfers.filter((x) => x.token !== TA);
  assert.deepEqual((await restore(pair(world, world), wpair(world))).wallets[0]!.tokens, [TA, OUT, TX, TZ].sort());
});

test("no read names a note: only the pool's whole-set logs and its five views on the pool's pair; one W per Transfer read, in a random order, on the other pair", async () => {
  const { world, W0, W1, d0, d1, c0, c1, l0 } = seeded();
  const plog: Over["log"] = [], wlog: Over["log"] = [];
  await restore(pair(world, world, { log: plog }, { log: plog }), wpair(world, world, { log: wlog }, { log: wlog }), { pick: () => 0 });
  const secrets = [d0, d1, c0, c1, { kind: "return", c: "evm", l: l0, j: 0 } as NoteRef].flatMap((ref) => [N(ref), P(ref)]).map((x) => w64(x));
  const text = JSON.stringify([plog, wlog]);
  for (const s of secrets) assert.ok(!text.includes(s), "a request carries a note's nullifier hash or precommitment");
  for (const c of plog) {
    if (c.method === "eth_call") assert.ok(VIEW_SELECTORS.includes((c.params as [{ data: string }])[0].data.slice(2, 10)), `a view that is not the pool's whole state: ${JSON.stringify(c.params)}`);
    assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_call"].includes(c.method), c.method);
    assert.ok(!isXfer(c), "a Transfer read went to a pool RPC");
  }
  for (const c of wlog) assert.ok(isXfer(c) || c.method === "eth_chainId" || c.method === "eth_getBlockByNumber", `the Transfer pair got ${c.method}`);
  // each W once on each of the two RPCs, W1 first under pick 0 (the order is the pick's, not the notes')
  assert.deepEqual(namedIn(wlog), [addrTopic(W1), addrTopic(W1), addrTopic(W0), addrTopic(W0)]);
  const wlog2: Over["log"] = [];
  await restore(pair(world, world), wpair(world, world, { log: wlog2 }), { pick: (n) => n - 1 });
  assert.deepEqual(namedIn(wlog2), [addrTopic(W0), addrTopic(W1)]);
});

test("the Transfer RPCs are their own pair: one that is a provider of the pool's pair is refused", async () => {
  const { world } = seeded();
  await assert.rejects(restore(pair(world, world), pair(world, world)), /walletRpcs: a provider of the pool's rpcs/);
  await assert.rejects(restore(pair(world, world), [rpc(world, { url: "https://c.example" }), rpc(world, { url: "https://b.example" })]), /walletRpcs: a provider of the pool's rpcs/);
  await assert.rejects(evmRestoreNotes({ seed64: SEED, pin: PIN, rpcs: pair(world, world), gap: 4 } as unknown as Parameters<typeof evmRestoreNotes>[0]), /rpcs: two/);
});

test("paging past a provider's range cap and its result cap still reads every log, under each cap", async () => {
  const { world } = seeded();
  const want = await restore(pair(world, world), wpair(world));
  const la: Over["log"] = [], lb: Over["log"] = [];
  const got = await restore(pair(world, world, { cap: 7, log: la }, { resultCap: 1, log: lb }), wpair(world, world, { cap: 7, log: la }, { resultCap: 1, log: lb }));
  assert.deepEqual(got.wallets, want.wallets);
  assert.deepEqual(got.notes.map((n) => refKey(n.ref)), want.notes.map((n) => refKey(n.ref)));
  const ranges = (l: NonNullable<Over["log"]>, x: boolean) => l.filter((c) => c.method === "eth_getLogs" && isXfer(c) === x).map((c) => { const p = (c.params as [{ fromBlock: string; toBlock: string }])[0]; return Number(BigInt(p.toBlock) - BigInt(p.fromBlock)) + 1; });
  for (const x of [false, true]) {
    assert.ok(ranges(la, x).some((n) => n > 7), "the first page is past the cap (it is refused, then halved)");
    assert.ok(ranges(lb, x).some((n) => n < 10), "a result cap halves the page");
  }
});

test("a lagging Transfer RPC: a moment behind is a retry, then the answer; behind for good, that W is unread and every note stands", async () => {
  const { world, W0 } = seeded();
  const behind = (until: number) => (l: Record<string, unknown>[], call: number) => (call < until ? l.filter((x) => x.address !== TZ) : l);
  const waits: number[] = [];
  const r = await restore(pair(world, world), wpair(world, world, {}, { xfer: behind(2) }), { sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(r.wallets[0]!.tokens, [TA, TX, TZ]);
  assert.ok(waits.length >= 1);
  const waits2: number[] = [];
  const r2 = await restore(pair(world, world), wpair(world, world, {}, { xfer: behind(1e9) }), { sleep: async (ms) => void waits2.push(ms) });
  const w0 = r2.wallets.find((w) => w.w === W0)!;
  assert.equal(w0.tokens, null);
  assert.match(w0.error!, /behind the other's/);
  assert.deepEqual(r2.wallets.find((w) => w.w !== W0)!.tokens, [TY]);
  assert.equal(r2.notes.length, 10);
  assert.equal(waits2.length, EVM_LAG_TRIES - 1, "one budget for the W's read");
});

test("a lagging pool RPC is a retry, then refused, on one budget: never one budget inside another", async () => {
  const { world } = seeded();
  const waits: number[] = [];
  await assert.rejects(restore(pair(world, world, {}, { pool: (l) => l.slice(0, -1) }), wpair(world), { sleep: async (ms) => void waits.push(ms) }), (e: Error) => e instanceof EvmLagError && /behind the other's/.test(e.message));
  assert.equal(waits.length, EVM_LAG_TRIES - 1);
  // behind 4 reads in 5: the 5th of the one budget answers
  const waits2: number[] = [];
  const r = await restore(pair(world, world, {}, { pool: (l, call) => (call % 5 < 4 ? l.slice(0, -1) : l) }), wpair(world), { sleep: async (ms) => void waits2.push(ms) });
  assert.equal(r.notes.length, 10);
  assert.equal(waits2.length, EVM_LAG_TRIES - 1);
});

test("an RPC whose head stays behind the other's by more than an epoch is a lag, then refused: never an old restore given as whole", async () => {
  const { world } = seeded();
  const waits: number[] = [];
  await assert.rejects(restore(pair(world, { ...world, head: 35, finalized: 30 }), wpair(world), { sleep: async (ms) => void waits.push(ms) }), (e: Error) => e instanceof EvmLagError && /more than an epoch behind/.test(e.message));
  assert.equal(waits.length, EVM_LAG_TRIES - 1);
  // within an epoch (60 s, 30 blocks of 2 s) of the other's latest: read at the lower block
  const r = await restore(pair(world, { ...world, head: 75, finalized: 70 }), wpair(world));
  assert.equal(r.block, 75n);
});

test("a Transfer pair on another chain, or one that never holds the restore's block, leaves every W unread with no Transfer log taken: only the pool pair refuses the restore", async () => {
  const { world, W0 } = seeded();
  const unread = (r: Awaited<ReturnType<typeof restore>>, re: RegExp) => {
    assert.equal(r.notes.length, 10, "every note returned");
    assert.equal(r.wallets.length, 2);
    for (const w of r.wallets) {
      assert.equal(w.tokens, null);
      assert.match(w.error!, re);
    }
  };
  const wlog: Over["log"] = [];
  unread(await restore(pair(world, world), wpair(world, world, { chainId: 84532n, log: wlog })), /^the Transfer RPCs: rpcs: chain 84532 and 8453, not 8453$/);
  assert.equal(namedIn(wlog).length, 0, "no W named to an RPC of another chain");
  const other: World = { ...world, hashOf: (n) => h32(`other chain ${n}`), xfers: [...world.xfers, { block: 50, token: "0x00000000000000000000000000000000000000f0", from: STRANGER, to: W0 }] };
  const waits: number[] = [];
  const wlog2: Over["log"] = [];
  unread(await restore(pair(world, world), wpair(other, other, { log: wlog2 }), { sleep: async (ms) => void waits.push(ms) }), /does not hold block 100/);
  assert.equal(waits.length, EVM_LAG_TRIES - 1, "one budget for the pair's check");
  assert.equal(namedIn(wlog2).length, 0, "no Transfer log taken from another fork");
  // an abort is never a W's error: it stops the restore
  const ac = new AbortController();
  await assert.rejects(evmRestoreNotes({ seed64: SEED, pin: PIN, rpcs: pair(world, world), walletRpcs: wpair(other), gap: 4, signal: ac.signal, sleep: async () => void ac.abort(new Error("stopped")) }), /stopped/);
});

test("an unread W's error keeps a provider's words cut to their code: a provider that echoes the request never puts W in it", async () => {
  const { world, W0 } = seeded();
  const echo: Over = { xfer: (l, _, to) => { if (to === addrTopic(W0)) throw new Error(`RPC error -32000: bad filter {"topics":[null,null,"${to}"]}`); return l; } };
  const r = await restore(pair(world, world), wpair(world, world, {}, echo));
  const w0 = r.wallets.find((w) => w.w === W0)!;
  assert.equal(w0.error, "rpc error -32000");
  assert.ok(!JSON.stringify(r.wallets.map((w) => w.error ?? "")).includes(W0.slice(2)));
});

type Body = { id: string; method: string; params: unknown[] };
const namesW = (b: Body, W0: string) => b.method === "eth_getLogs" && (b.params[0] as { address?: string }).address === undefined && (b.params[0] as { topics: string[] }).topics[2] === addrTopic(W0);
/** A provider through the kit's own JSON-RPC client (solanaJsonRpc): the mock chain's answers, except what `bad` gives. */
const viaKitClient = (url: string, mock: EvmRpc, bad: (b: Body) => Response | undefined): EvmRpc =>
  solanaJsonRpc(url, {
    fetch: async (_u, init) => {
      const b = JSON.parse(init.body as string) as Body;
      const r = bad(b);
      if (r) return r;
      try {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: await mock(b.method, b.params) }));
      } catch (e) {
        const m = /RPC error (-?\d+): (.*)/s.exec((e as Error).message);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: Number(m?.[1] ?? -32000), message: m?.[2] ?? String(e) } }));
      }
    },
  });
const json = (o: unknown) => new Response(JSON.stringify(o));
/** The restore with one Transfer provider answering every read that names W0 with `bad`. */
async function w0ErrorThroughKit(bad: (b: Body, W0: string) => Response) {
  const { world, W0 } = seeded();
  const wr: [EvmRpc, EvmRpc] = [viaKitClient("https://c.example", rpc(world), () => undefined), viaKitClient("https://d.example", rpc(world), (b) => (namesW(b, W0) ? bad(b, W0) : undefined))];
  const r = await restore(pair(world, world), wr);
  assert.equal(r.notes.length, 10, "every note returned");
  const w0 = r.wallets.find((w) => w.w === W0)!;
  assert.equal(w0.tokens, null);
  return { error: w0.error!, W0 };
}

{
  const filterOf = (b: Body) => (b.params[0] as { topics: string[] }).topics[2];
  const cases: [string, (b: Body, W0: string) => Response, string][] = [
    ["K0 an integer code (cut to it)", (b) => json({ jsonrpc: "2.0", id: b.id, error: { code: -32000, message: `bad filter ${filterOf(b)}` } }), "rpc error -32000"],
    ["K1 no code", (b) => json({ jsonrpc: "2.0", id: b.id, error: { message: `bad filter ${filterOf(b)}` } }), "the call failed"],
    ["K2 a string code", (b) => json({ jsonrpc: "2.0", id: b.id, error: { code: "SERVER_ERROR", message: `bad filter ${filterOf(b)}` } }), "the call failed"],
    ["K3 an id that echoes the request", (b) => json({ jsonrpc: "2.0", id: { echo: b.params }, result: [] }), "the call failed"],
    ["K4 a 200 body that is not JSON", (_, W0) => new Response(`x${W0.slice(2)} not found`), "the call failed"],
    ["K5 a head lag with a string code, past the lag budget", (b) => json({ jsonrpc: "2.0", id: b.id, error: { code: "x", message: `block range extends beyond current head block: ${filterOf(b)}` } }), "the call failed"],
    ["K6 an HTTP status", () => new Response(`no ${"x"}`, { status: 503 }), "http 503"],
  ];
  for (const [name, bad, want] of cases)
    test(`an unread W's error through the kit's client carries none of a provider's text: ${name}`, async () => {
      const { error, W0 } = await w0ErrorThroughKit(bad);
      assert.ok(!error.toLowerCase().includes(W0.slice(2, 10)), `the error carries W: ${error}`);
      assert.equal(error, want);
    });
}

test("a Transfer pair's failed check keeps none of a provider's text: cut to its code, or 'the call failed'", async () => {
  const { world } = seeded();
  const say = "provider-text-0123456789";
  for (const [error, want] of [[{ code: -32001, message: say }, "the Transfer RPCs: rpc error -32001"], [{ message: say }, "the Transfer RPCs: the call failed"]] as const) {
    const bad = (b: Body) => (b.method === "eth_chainId" ? json({ jsonrpc: "2.0", id: b.id, error }) : undefined);
    const r = await restore(pair(world, world), [viaKitClient("https://c.example", rpc(world), () => undefined), viaKitClient("https://d.example", rpc(world), bad)]);
    assert.equal(r.notes.length, 10, "every note returned");
    for (const w of r.wallets) {
      assert.equal(w.tokens, null);
      assert.equal(w.error, want);
    }
  }
});

test("the newest block reorgs between the pool read and the Transfer pair's check: the pool pair's lag, never the orphaned block's notes with the Transfer pair blamed", async () => {
  const { world } = seeded();
  let moved = false;
  const live: World = { ...world, hashOf: (n) => (moved && n === 100 ? h32("reorged 100") : world.hashOf(n)) };
  const [c, dd] = wpair(live);
  const trip = Object.assign((m: string, p: readonly unknown[]) => ((moved = true), c(m, p)), { url: "https://c.example" });
  await assert.rejects(restore(pair(live, live), [trip, dd]), (e) => e instanceof EvmLagError && /does not hold block 100/.test(e.message));
});

test("the newest block reorgs while a W's Transfer logs are read: the pool pair's lag, never the orphaned block's notes with that W unread", async () => {
  const { world, W0 } = seeded();
  world.xfers.push({ block: 100, token: TX, from: STRANGER, to: W0 }); // a log of the anchor block, so the read sees it move
  let moved = false;
  const live: World = { ...world, hashOf: (n) => (moved && n === 100 ? h32("reorged 100") : world.hashOf(n)) };
  const [c, dd] = wpair(live);
  const trip = Object.assign((m: string, p: readonly unknown[]) => (m === "eth_getLogs" && (moved = true), c(m, p)), { url: "https://c.example" });
  await assert.rejects(restore(pair(live, live), [trip, dd]), (e) => e instanceof EvmLagError && /does not hold block 100/.test(e.message));
});

test("a stranger's Transfer spam to a public W past every page a provider takes leaves that W unread and every note restored", async () => {
  const { world, W0 } = seeded();
  world.xfers.push({ block: 25, token: "0x00000000000000000000000000000000000000f0", from: STRANGER, to: W0 });
  const r = await restore(pair(world, world), wpair(world, world, { resultCap: 1 }, { resultCap: 1 }));
  assert.equal(r.notes.length, 10);
  const w0 = r.wallets.find((w) => w.w === W0)!;
  assert.equal(w0.tokens, null);
  assert.equal(w0.error, "rpc error -32005", "the provider's words cut to its code");
  assert.deepEqual(r.wallets.find((w) => w.w !== W0)!.tokens, [TY]);
});

test("a lying Transfer RPC: that W is unread at once (no retry), never a token taken; the notes stand", async () => {
  const { world, W0 } = seeded();
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const at25 = (f: (x: Record<string, unknown>) => Record<string, unknown>) => (l: Record<string, unknown>[]) => l.map((x) => (x.blockNumber === q(25) ? f(x) : x));
  const w0err = async (o: Over, re: RegExp) => {
    const r = await restore(pair(world, world), wpair(world, world, {}, o), { sleep });
    const w0 = r.wallets.find((w) => w.w === W0)!;
    assert.equal(w0.tokens, null);
    assert.match(w0.error!, re);
    assert.equal(r.notes.length, 10);
  };
  await w0err({ xfer: at25((x) => ({ ...x, address: TZ })) }, /the two RPCs differ at log 1/);
  await w0err({ xfer: at25((x) => ({ ...x, data: `0x${w64(1n)}` })) }, /the two RPCs differ at log 1/);
  await w0err({ xfer: at25((x) => ({ ...x, topics: [EVM_TRANSFER_TOPIC, addrTopic(STRANGER), addrTopic(STRANGER)] })) }, /not a Transfer to the W asked/);
  await w0err({ xfer: at25((x) => ({ ...x, topics: [h32("Approval(address,address,uint256)"), ...(x.topics as string[]).slice(1)] })) }, /not a Transfer$/);
  // a log one RPC lacks, at a finalized block both hold with one hash
  await w0err({ xfer: (l) => l.filter((x) => x.blockNumber !== q(25)) }, /the two RPCs differ at log 1/);
  // one more, of a token nobody's notes name, at a finalized block: refused for every device alike
  const extra = { address: STRANGER, topics: [EVM_TRANSFER_TOPIC, addrTopic(STRANGER), addrTopic(W0)], data: `0x${w64(9n)}`, blockNumber: q(25), blockHash: world.hashOf(25), logIndex: q(2), transactionHash: h32("extra"), transactionIndex: q(2), removed: false };
  await w0err({ xfer: (l, _, to) => to !== addrTopic(W0) ? l : [...l, extra].sort((a, b) => Number(BigInt(a.blockNumber as string) - BigInt(b.blockNumber as string)) || Number(BigInt(a.logIndex as string) - BigInt(b.logIndex as string))) }, /the two RPCs differ at log 2/);
  assert.equal(waits.length, 0, "a lie is never a retry");
  // the same log in the newest block, under another hash on one RPC: the block is still the anchor's on both, a lie
  const at100 = { ...extra, blockNumber: q(100), blockHash: h32("another block 100") };
  await w0err({ xfer: (l, _, to) => (to !== addrTopic(W0) ? l : [...l, at100]) }, /a log of block 100 is not of the anchor/);
});

test("a lying pool RPC is refused at once: another pool value, a token word that is not an address", async () => {
  const { world } = seeded();
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  await assert.rejects(restore(pair(world, world, {}, { pool: (l) => l.map((x, i) => (i === 1 ? { ...x, data: `${(x.data as string).slice(0, 130)}${w64(1n)}${(x.data as string).slice(194)}` } : x)) }), wpair(world), { sleep }), /the two RPCs differ at log 1/);
  await assert.rejects(restore(pair(world, world, {}, { pool: (l) => l.map((x, i) => (i === 4 ? { ...x, data: `${(x.data as string).slice(0, 322)}${w64(1n << 160n)}${(x.data as string).slice(386)}` } : x)) }), wpair(world), { sleep }), /the token is not an address/);
  assert.equal(waits.length, 0, "a lie is never a retry");
});

test("both RPCs telling one lie a correct pool cannot make is refused: a deposit's value, a withdrawal over the note or of 0", async () => {
  const { world } = seeded();
  const both = (f: (l: Record<string, unknown>[]) => Record<string, unknown>[]) => restore(pair(world, world, { pool: f }, { pool: f }), wpair(world));
  const edit = (i: number, word: number, v: bigint) => (l: Record<string, unknown>[]) => l.map((x, k) => (k === i ? { ...x, data: `0x${(x.data as string).slice(2, 2 + 64 * word)}${w64(v)}${(x.data as string).slice(2 + 64 * (word + 1))}` } : x));
  await assert.rejects(both(edit(1, 2, 2n * 10n ** 16n)), /its commitment is not Poseidon/);
  await assert.rejects(both(edit(4, 1, 10n ** 16n + 1n)), /its release withdrew/);
  await assert.rejects(both(edit(4, 1, 0n)), /its release withdrew 0/);
});

/** deposit 0 released by someone else holding its secrets: to `to`, with a new commitment that is our change or not */
function elsewhereChain(o: { to: "stranger" | "W0"; changeOurs: boolean }) {
  const { world, l0, c0 } = seeded();
  const to = o.to === "W0" ? W(l0, 0) : STRANGER;
  world.pool = world.pool.map((e) => (e.kind === "buy" ? { ...e, to, state: o.changeOurs ? e.state : 777n } : e));
  world.xfers.push({ block: 21, token: "0x00000000000000000000000000000000000000f1", from: STRANGER, to: STRANGER });
  return { world, l0, c0, to };
}

test("one note released elsewhere never hides the others: paid an address the words do not give, its change still ours and followed", async () => {
  const { world, c0 } = elsewhereChain({ to: "stranger", changeOurs: true });
  const wlog: Over["log"] = [];
  const r = await restore(pair(world, world), wpair(world, world, { log: wlog }));
  const d0 = { kind: "deposit", s: SCOPE, i: 0 } as const;
  assert.equal(r.notes.length, 10, "every note, the change and its own release's change included");
  assert.equal(byKey(r).get(refKey(d0)), "SPENT");
  assert.equal(byKey(r).get(refKey(c0)), "SPENT");
  assert.deepEqual(r.elsewhere, [{ note: refKey(d0), to: STRANGER, withdrawn: 4n * 10n ** 15n, block: 20n, changeOurs: true }]);
  assert.deepEqual(r.spends.map((s) => s.note), [refKey(c0)], "a foreign address is never one of our spends");
  assert.ok(r.wallets.every((w) => w.w !== STRANGER), "a foreign address is never listed as a W");
  assert.ok(!namedIn(wlog).includes(addrTopic(STRANGER)), "no read names a foreign address");
});

test("one note released elsewhere never hides the others: a new commitment that is not our change (to a stranger or to our own W)", async () => {
  for (const to of ["stranger", "W0"] as const) {
    const { world, c0, l0 } = elsewhereChain({ to, changeOurs: false });
    const r = await restore(pair(world, world), wpair(world));
    const d0 = { kind: "deposit", s: SCOPE, i: 0 } as const;
    assert.equal(byKey(r).get(refKey(d0)), "SPENT");
    assert.equal(byKey(r).get(refKey(c0)), undefined, "a change note that is not in the tree is not ours");
    // the notes under (l0, 0) the release's W brought back are still looked up, and deposit 1 and its own are untouched
    for (const ref of [{ kind: "deposit", s: SCOPE, i: 1 }, { kind: "move", l: l0, j: 0 }, { kind: "return", c: "evm", l: l0, j: 0 }, { kind: "second", id: { id: "U", s: SCOPE, i: 0 }, n: 0 }] as NoteRef[]) assert.equal(byKey(r).get(refKey(ref)), "UNSPENT", refKey(ref));
    assert.deepEqual(r.elsewhere.map((e) => [e.note, e.changeOurs]), [[refKey(d0), false]]);
    assert.deepEqual(r.spends.map((s) => s.note), to === "W0" ? [refKey(d0)] : [], "our own W is still ours to read");
  }
});

test("evmRestore refuses what a correct pool cannot make: a precommitment twice, a nullifier twice, a leaf twice, a label not its nonce's, a release before its note", () => {
  const { world } = seeded();
  const evs = poolLogs(world).map((x, i) => {
    const e = world.pool[i]!;
    return { block: BigInt(e.block), blockHash: x.blockHash as string, logIndex: 0n, bytes: "", kind: e.kind, state: e.state, label: e.label ?? null, value: e.value, precommitment: e.pre ?? null, nullifier: e.nul ?? null, recipient: e.to ?? null, token: e.token ?? null };
  });
  const run = (f: (e: typeof evs) => typeof evs) => evmRestore({ seed64: SEED, scope: SCOPE, events: f(evs.map((e) => ({ ...e }))), gap: 4 });
  assert.equal(run((e) => e).notes.length, 10);
  assert.throws(() => run((e) => [...e, { ...e[1]!, state: 99n }]), /a precommitment deposited twice/);
  assert.throws(() => run((e) => [...e, { ...e[4]!, state: 99n }]), /a nullifier spent twice/);
  assert.throws(() => run((e) => [...e, { ...e[0]!, precommitment: 98n }]), /state leaf 13 repeats/);
  assert.throws(() => run((e) => [e[0]!, e[2]!, e[1]!, ...e.slice(3)]), /its label is not the label of nonce/);
  assert.throws(() => run((e) => [e[0]!, e[4]!, ...e.slice(1, 4), ...e.slice(5)]), /: its release is not after its leaf/);
  // a change that is not the release's is no refusal: the release is listed elsewhere and the change not kept
  const r = run((e) => e.map((x, k) => (k === 4 ? { ...x, state: 99n } : x)));
  assert.deepEqual(r.elsewhere.map((x) => x.changeOurs), [false]);
});

// ---- card wallet-rpc-hex-case: an RPC's hex in either case ----

/** robinhood-testnet.drpc.org's case: it answers eth_chainId "0xB626" (read 3 Nov 23:07Z; the 3 Nov 22:55Z
 * pool-evm-testnet-run restore found all 3 notes but left both Ws unread on it). Every hex digit of every answer
 * upper-cased, "0x" kept. */
const upper = (v: unknown): unknown =>
  typeof v === "string" && /^0x[0-9a-f]+$/.test(v) ? `0x${v.slice(2).toUpperCase()}`
  : Array.isArray(v) ? v.map(upper)
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, upper(x)]))
  : v;
const drpc = (r: EvmRpc): EvmRpc => Object.assign(async (m: string, p: readonly unknown[]) => upper(await r(m, p)), { url: `${(r as { url?: string }).url}/drpc` });

test("hex in either case: the Transfer pair on drpc's upper case (eth_chainId \"0xB626\") holds the anchor and lists every W's tokens", async () => {
  const { world } = seeded();
  // the Transfer pair's own check on Robinhood testnet, drpc's real answer on one side
  const rh = (url: string) => rpc(world, { url, chainId: 46630n });
  const anchor = { number: 100n, hash: world.hashOf(100), timestamp: T0 + 200n, baseFeePerGas: 1n };
  assert.equal(await drpc(rh("https://c.example"))("eth_chainId", []), "0xB626");
  await evmHoldsAnchor([drpc(rh("https://c.example")), rh("https://d.example")], 46630n, anchor);
  await evmHoldsAnchor([rh("https://c.example"), drpc(rh("https://d.example"))], 46630n, anchor);
  // the whole restore, one side of each pair upper-cased: the same notes and the same tokens as lower case
  const want = await restore(pair(world, world), wpair(world));
  assert.ok(want.wallets.every((w) => w.tokens !== null && w.tokens.length > 0));
  const [a, b] = pair(world, world), [c, d] = wpair(world);
  for (const [rpcs, wallets] of [[[a, b], [drpc(c), d]], [[drpc(a), b], [c, drpc(d)]], [[a, drpc(b)], [drpc(c), drpc(d)]]] as [[EvmRpc, EvmRpc], [EvmRpc, EvmRpc]][]) {
    const r = await restore(rpcs, wallets);
    assert.deepEqual(r.wallets, want.wallets);
    assert.deepEqual(byKey(r), byKey(want));
  }
});

test("hex in either case: a Transfer pair that differs by more than case is still refused, that W unread", async () => {
  const { world, W0 } = seeded();
  const rh = (url: string, chainId: bigint) => rpc(world, { url, chainId });
  const anchor = { number: 100n, hash: world.hashOf(100), timestamp: T0 + 200n, baseFeePerGas: 1n };
  // another chain in upper case ("0xB627") is another chain
  await assert.rejects(evmHoldsAnchor([drpc(rh("https://c.example", 46631n)), rh("https://d.example", 46630n)], 46630n, anchor), /rpcs: chain 46631 and 46630, not 46630/);
  // one Transfer log's value 500 on the upper-case side, 1 on the other: W0 unread, the notes stand
  const at25 = (l: Record<string, unknown>[]) => l.map((x) => (x.blockNumber === q(25) ? { ...x, data: `0x${w64(1n)}` } : x));
  const [c, d] = wpair(world, world, {}, { xfer: at25 });
  const r = await restore(pair(world, world), [drpc(c), d]);
  const w0 = r.wallets.find((w) => w.w === W0)!;
  assert.equal(w0.tokens, null);
  assert.match(w0.error!, /the two RPCs differ at log 1/);
  assert.equal(r.notes.length, 10);
});

// ---- dRPC's range refusal, as base-sepolia.drpc.org answers it (fold of 4 Nov) ----

/** base-sepolia.drpc.org's answer to an eth_getLogs past its cap, read 4 Nov 12:41-12:43Z: HTTP 400 with this body, at
 * 6,832 (54304922..54311753), 10,001, 9,999, 501, 200 and 106 blocks; 101 and 53 blocks answered. The words name 10,000
 * blocks whatever the size refused. The kit's client (solanaJsonRpc) keeps a refusal's JSON-RPC words after its status:
 * "HTTP 400: RPC error 35: ranges over 10000 blocks are not supported on free plan", which RANGE_CAP reads as a cap. */
const drpcRefusal = (b: Body) => new Response(JSON.stringify({ id: Number(b.id), jsonrpc: "2.0", error: { message: "ranges over 10000 blocks are not supported on free plan", code: 35 } }), { status: 400 });
const span = (b: Body) => {
  const p = b.params[0] as { fromBlock: string; toBlock: string };
  return { from: Number(BigInt(p.fromBlock)), to: Number(BigInt(p.toBlock)) };
};
/** An RPC that records each eth_getLogs page it answered (the Transfer filter's W, from, to), never one it refused. */
const answered = (r: EvmRpc, out: { w: string; from: number; to: number }[], url: string): EvmRpc =>
  Object.assign(async (m: string, p: readonly unknown[]) => {
    const v = await r(m, p);
    const f = p[0] as { address?: string; topics?: string[]; fromBlock?: string; toBlock?: string };
    if (m === "eth_getLogs" && f.address === undefined) out.push({ w: f.topics![2]!, from: Number(BigInt(f.fromBlock!)), to: Number(BigInt(f.toBlock!)) });
    return v;
  }, { url });
/** The pages answered for one W, in order, tile from..to: no block left out, none read twice. */
const tiles = (pages: { w: string; from: number; to: number }[], w: string, from: number, to: number) => {
  const mine = pages.filter((x) => x.w === addrTopic(w));
  let at = from;
  for (const x of mine) {
    assert.equal(x.from, at, `a page of ${w} starts at ${x.from}, not at ${at}: ${JSON.stringify(mine)}`);
    at = x.to + 1;
  }
  assert.equal(at, to + 1, `the pages of ${w} end at ${at - 1}, not at ${to}`);
};

test("D1 dRPC's real range refusal through the kit's client (HTTP 400, code 35) is paged under: every W's tokens read, every block of each W read", async () => {
  const { world, W0, W1 } = seeded();
  const want = await restore(pair(world, world), wpair(world));
  const refused: number[] = [], pages: { w: string; from: number; to: number }[] = [];
  const capped = (b: Body) => {
    if (b.method !== "eth_getLogs") return undefined;
    const { from, to } = span(b);
    if (to - from + 1 <= 7) return undefined;
    refused.push(to - from + 1);
    return drpcRefusal(b);
  };
  const r = await restore(pair(world, world), [viaKitClient("https://c.example", rpc(world), () => undefined), viaKitClient("https://d.example", answered(rpc(world), pages, "https://m.example"), capped)]);
  assert.deepEqual(r.wallets, want.wallets);
  assert.ok(refused.length > 0, "the first page is past the cap");
  // W0 released at block 20, W1 at 40; the anchor is 100
  tiles(pages, W0, 20, 100);
  tiles(pages, W1, 40, 100);
});

test("D2 a range no page can read is never counted as read: that W is unread, never a token list without it, and every note stands", async () => {
  const { world, W0, W1 } = seeded();
  const fails: [string, (r: EvmRpc) => EvmRpc, RegExp][] = [
    // dRPC's words even for one block, at block 25 (W0's token TX)
    ["a cap at one block", (r) => Object.assign(async (m: string, p: readonly unknown[]) => {
      const f = p[0] as { address?: string; topics?: string[]; fromBlock?: string; toBlock?: string };
      if (m === "eth_getLogs" && f.address === undefined && f.topics![2] === addrTopic(W0) && Number(BigInt(f.fromBlock!)) <= 25 && Number(BigInt(f.toBlock!)) >= 25) throw new Error("ranges over 10000 blocks are not supported on free plan");
      return r(m, p);
    }, { url: "https://d.example" }), /ranges over 10000 blocks/],
    // another error on one page past the first: the pages before it read, the rest never
    ["another error on a later page", (r) => Object.assign(async (m: string, p: readonly unknown[]) => {
      const f = p[0] as { address?: string; topics?: string[]; fromBlock?: string; toBlock?: string };
      if (m === "eth_getLogs" && f.address === undefined && f.topics![2] === addrTopic(W0) && Number(BigInt(f.fromBlock!)) > 20) throw new Error("RPC error -32603: internal error");
      if (m === "eth_getLogs" && f.address === undefined && Number(BigInt(f.toBlock!)) - Number(BigInt(f.fromBlock!)) + 1 > 7) throw new Error("ranges over 10000 blocks are not supported on free plan");
      return r(m, p);
    }, { url: "https://d.example" }), /^rpc error -32603$/],
  ];
  for (const [name, bad, error] of fails) {
    const r = await restore(pair(world, world), [rpc(world, { url: "https://c.example" }), bad(rpc(world))]);
    const w0 = r.wallets.find((w) => w.w === W0)!;
    assert.equal(w0.tokens, null, `${name}: W0 listed tokens over a range it never read`);
    assert.match(w0.error!, error, name);
    assert.deepEqual(r.wallets.find((w) => w.w === W1)!.tokens, [TY], name);
    assert.equal(r.notes.length, 10, name);
  }
  // through the kit's client: dRPC's cap at every size, one block too, is that W's failure (named by its code) after its
  // pages shrink to one block, never a page of no block and never a W read
  const sizes: number[] = [];
  const always = (b: Body) => {
    if (!namesW(b, W0)) return undefined;
    const { from, to } = span(b);
    sizes.push(to - from + 1);
    return drpcRefusal(b);
  };
  const r = await restore(pair(world, world), [viaKitClient("https://c.example", rpc(world), () => undefined), viaKitClient("https://d.example", rpc(world), always)]);
  const w0 = r.wallets.find((w) => w.w === W0)!;
  assert.equal(w0.tokens, null);
  assert.equal(w0.error, "rpc error 35");
  assert.ok(sizes.every((n) => n >= 1) && sizes.includes(1), `pages: ${sizes}`);
  assert.deepEqual(r.wallets.find((w) => w.w === W1)!.tokens, [TY]);
  assert.equal(r.notes.length, 10);
});

// ---- card wallet-restore-transfer-rpcs: a provider's cap in words the pager never read ----

/** Real refusals of an eth_getLogs (Transfer, topic 2 = a W, no address) past each provider's cap, read live 5 Nov
 * 12:20-12:28Z, each as its provider answers it (HTTP status and body). None names its cap in words the pager knew
 * before this card: Tenderly puts its cap in `data`, which the kit's client never reads. */
const UNKNOWN_CAPS: [string, number, Record<string, unknown>][] = [
  ["base.gateway.tenderly.co over 1,000 blocks", 200, { code: -32602, message: "invalid params", data: "Block range too large: maximum 1000 blocks without an access key. Try [0x33104e2, 0x33108ca], or use an access key for larger ranges." }],
  ["rpc.mainnet.chain.robinhood.com over 30,000 blocks", 200, { code: -32602, message: "query spans 39984 blocks (106696878 to 106736861), but only 30000 are allowed for this request; narrow the block range, or add an address filter" }],
  ["base.api.pocket.network over 500 blocks", 200, { code: -32602, message: "invalid argument 0: block range exceeds maximum 500" }],
  ["rpc-robinhood.blockmachine.io over 10,000 blocks", 200, { code: -32602, message: "block range exceeds maximum allowed (max=10000, requested=100000)" }],
  ["1rpc.io/base over 50 blocks", 200, { code: -32602, message: "eth_getLogs is limited to 0 - 50 blocks range" }],
];

test("R1 a provider's cap in words never read before (Tenderly, Robinhood's own, Pocket, blockmachine, 1RPC; read live 5 Nov) is paged under: every W's tokens read, every block of each W read", async () => {
  const { world, W0, W1 } = seeded();
  const want = await restore(pair(world, world), wpair(world));
  for (const [name, status, error] of UNKNOWN_CAPS) {
    const refused: number[] = [], pages: { w: string; from: number; to: number }[] = [];
    const capped = (b: Body) => {
      if (b.method !== "eth_getLogs") return undefined;
      const { from, to } = span(b);
      if (to - from + 1 <= 7) return undefined;
      refused.push(to - from + 1);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error }), { status });
    };
    const r = await restore(pair(world, world), [viaKitClient("https://c.example", rpc(world), () => undefined), viaKitClient("https://d.example", answered(rpc(world), pages, "https://m.example"), capped)]);
    assert.deepEqual(r.wallets, want.wallets, name);
    assert.ok(refused.length > 0, `${name}: the first page is past the cap`);
    tiles(pages, W0, 20, 100);
    tiles(pages, W1, 40, 100);
  }
});

test("R2 a provider that refuses every page, one block too, in any words, is that W's true failure: its code kept, every other W and note read", async () => {
  const { world, W0, W1 } = seeded();
  const sizes: number[] = [];
  const always = (b: Body) => {
    if (!namesW(b, W0)) return undefined;
    const { from, to } = span(b);
    sizes.push(to - from + 1);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: UNKNOWN_CAPS[0]![2] }));
  };
  const r = await restore(pair(world, world), [viaKitClient("https://c.example", rpc(world), () => undefined), viaKitClient("https://d.example", rpc(world), always)]);
  const w0 = r.wallets.find((w) => w.w === W0)!;
  assert.equal(w0.tokens, null);
  assert.equal(w0.error, "rpc error -32602");
  assert.ok(sizes.every((n) => n >= 1) && sizes.includes(1), `pages: ${sizes}`);
  assert.deepEqual(r.wallets.find((w) => w.w === W1)!.tokens, [TY]);
  assert.equal(r.notes.length, 10);
});
