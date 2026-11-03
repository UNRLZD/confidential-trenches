// node --test packages/wallet/test/pool-evm-restore.test.ts: the EVM pool's restore from the 12 words, and each spent
// note's W's tokens (card notes-restore-evm, src/pool/evm-restore.ts). The RPCs are a mock chain: blocks, the pool's
// Deposited, Withdrawn and Bought logs as the pool emits them (their notes made from the test seed's own secrets), its
// views at each block computed from those logs, and ERC-20 (and one ERC-721) Transfer logs. Test seed only: the
// all-zero entropy of vectors/a8.json; never money.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VaultTree, vaultLabelOf } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { refKey } from "../src/notes/store.ts";
import { EVM_LAG_TRIES, EVM_POOL_EVENTS, EVM_TRANSFER_TOPIC, EvmLagError, evmPoolScopeOf, type EvmPoolPin, type EvmRpc } from "../src/pool/evm.ts";
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
  url?: string;
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
      case "eth_chainId": return q(8453n);
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
const restore = (rpcs: [EvmRpc, EvmRpc], walletRpcs: [EvmRpc, EvmRpc] = rpcs, extra: { sleep?: (ms: number) => Promise<void>; pick?: (n: number) => number } = {}) =>
  evmRestoreNotes({ seed64: SEED, pin: PIN, rpcs, walletRpcs, gap: 4, sleep: async () => {}, ...extra });

test("restore of a seeded chain from the words alone: every note, each spent note's W, and every token each W holds", async () => {
  const { world, l0, W0, W1, d0, d1, c0, c1 } = seeded();
  const r = await restore(pair(world, world));
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
  const r = await restore(pair(world, world, { log }, {}));
  assert.ok(r.wallets[0]!.tokens.includes(OUT));
  // a buy's token that sent W no Transfer log (a token that emits none) is still W's: the pool's Bought names it
  world.xfers = world.xfers.filter((x) => x.token !== TA);
  assert.deepEqual((await restore(pair(world, world))).wallets[0]!.tokens, [TA, OUT, TX, TZ].sort());
  for (const c of log.filter((c) => c.method === "eth_getLogs" && (c.params as [{ address?: string }])[0].address === undefined)) assert.deepEqual(Object.keys((c.params as [object])[0]).sort(), ["fromBlock", "toBlock", "topics"]);
});

test("no read names a note: only the pool's whole-set logs, its five views, and one W per Transfer read, in a random order", async () => {
  const { world, W0, W1, d0, d1, c0, c1, l0 } = seeded();
  const log: Over["log"] = [];
  await restore(pair(world, world, { log }, {}), undefined, { pick: () => 0 });
  const secrets = [d0, d1, c0, c1, { kind: "return", c: "evm", l: l0, j: 0 } as NoteRef].flatMap((ref) => [N(ref), P(ref)]).map((x) => w64(x));
  const text = JSON.stringify(log);
  for (const s of secrets) assert.ok(!text.includes(s), "a request carries a note's nullifier hash or precommitment");
  for (const c of log) {
    if (c.method === "eth_call") assert.ok(VIEW_SELECTORS.includes((c.params as [{ data: string }])[0].data.slice(2, 10)), `a view that is not the pool's whole state: ${JSON.stringify(c.params)}`);
    assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_call"].includes(c.method), c.method);
  }
  const named = log.filter((c) => c.method === "eth_getLogs" && (c.params as [{ address?: string }])[0].address === undefined).map((c) => (c.params as [{ topics: string[] }])[0].topics[2]);
  assert.deepEqual(named, [addrTopic(W1), addrTopic(W0)], "one W a read, W1 first under pick 0 (the order is the pick's, not the notes')");
  const named2: string[] = [];
  const log2: Over["log"] = [];
  await restore(pair(world, world, { log: log2 }, {}), undefined, { pick: (n) => n - 1 });
  for (const c of log2) if (c.method === "eth_getLogs" && (c.params as [{ address?: string }])[0].address === undefined) named2.push((c.params as [{ topics: string[] }])[0].topics[2]!);
  assert.deepEqual(named2, [addrTopic(W0), addrTopic(W1)]);
});

test("paging past a provider's range cap and its result cap still reads every log, under each cap", async () => {
  const { world } = seeded();
  const want = await restore(pair(world, world));
  const la: Over["log"] = [], lb: Over["log"] = [];
  const got = await restore(pair(world, world, { cap: 7, log: la }, { resultCap: 1, log: lb }));
  assert.deepEqual(got.wallets, want.wallets);
  assert.deepEqual(got.notes.map((n) => refKey(n.ref)), want.notes.map((n) => refKey(n.ref)));
  const ranges = (l: NonNullable<Over["log"]>) => l.filter((c) => c.method === "eth_getLogs").map((c) => { const p = (c.params as [{ fromBlock: string; toBlock: string }])[0]; return Number(BigInt(p.toBlock) - BigInt(p.fromBlock)) + 1; });
  assert.ok(ranges(la).some((n) => n > 7), "the first page is past the cap (it is refused, then halved)");
  assert.ok(ranges(lb).some((n) => n < 10), "a result cap halves the page");
});

test("a lagging RPC: Transfer logs past the finalized block a moment behind are a retry, then the answer; behind for good, refused", async () => {
  const { world } = seeded();
  const behind = (until: number) => (l: Record<string, unknown>[], call: number) => (call < until ? l.filter((x) => x.address !== TZ) : l);
  const waits: number[] = [];
  const r = await restore(pair(world, world, {}, { xfer: behind(2) }), undefined, { sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(r.wallets[0]!.tokens, [TA, TX, TZ]);
  assert.ok(waits.length >= 1);
  const waits2: number[] = [];
  await assert.rejects(restore(pair(world, world, {}, { xfer: behind(1e9) }), undefined, { sleep: async (ms) => void waits2.push(ms) }), (e: Error) => e instanceof EvmLagError && /behind the other's/.test(e.message));
  assert.equal(waits2.length, EVM_LAG_TRIES - 1);
  // the pool's logs behind for good: the sync's own retries, then one refusal, not EVM_LAG_TRIES more rounds of them
  const waits3: number[] = [];
  await assert.rejects(restore(pair(world, world, {}, { pool: (l) => l.slice(0, -1) }), undefined, { sleep: async (ms) => void waits3.push(ms) }), /behind the other's/);
  assert.equal(waits3.length, EVM_LAG_TRIES - 1);
});

test("a lying RPC is refused at once: another token, another pool value, or a Transfer to another W", async () => {
  const { world } = seeded();
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const at25 = (f: (x: Record<string, unknown>) => Record<string, unknown>) => (l: Record<string, unknown>[]) => l.map((x) => (x.blockNumber === q(25) ? f(x) : x));
  await assert.rejects(restore(pair(world, world, {}, { xfer: at25((x) => ({ ...x, address: TZ })) }), undefined, { sleep }), /the two RPCs differ at log 1/);
  await assert.rejects(restore(pair(world, world, {}, { xfer: at25((x) => ({ ...x, data: `0x${w64(1n)}` })) }), undefined, { sleep }), /the two RPCs differ at log 1/);
  await assert.rejects(restore(pair(world, world, {}, { xfer: at25((x) => ({ ...x, topics: [EVM_TRANSFER_TOPIC, addrTopic(STRANGER), addrTopic(STRANGER)] })) }), undefined, { sleep }), /not a Transfer to the W asked/);
  await assert.rejects(restore(pair(world, world, {}, { xfer: at25((x) => ({ ...x, topics: [h32("Approval(address,address,uint256)"), ...(x.topics as string[]).slice(1)] })) }), undefined, { sleep }), /not a Transfer$/);
  await assert.rejects(restore(pair(world, world, {}, { pool: (l) => l.map((x, i) => (i === 1 ? { ...x, data: `${(x.data as string).slice(0, 130)}${w64(1n)}${(x.data as string).slice(194)}` } : x)) }), undefined, { sleep }), /the two RPCs differ at log 1/);
  await assert.rejects(restore(pair(world, world, {}, { pool: (l) => l.map((x, i) => (i === 4 ? { ...x, data: `${(x.data as string).slice(0, 322)}${w64(1n << 160n)}${(x.data as string).slice(386)}` } : x)) }), undefined, { sleep }), /the token is not an address/);
  assert.equal(waits.length, 0, "a lie is never a retry");
});

test("a log one RPC gives and the other lacks at the same block hash is refused, for every device alike", async () => {
  const { world, W0 } = seeded();
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  // lacking one at a finalized block both hold with one hash
  await assert.rejects(restore(pair(world, world, {}, { xfer: (l) => l.filter((x) => x.blockNumber !== q(25)) }), undefined, { sleep }), /the two RPCs differ at log 1/);
  // giving one more, of a token nobody's notes name, at a finalized block
  const extra = { address: STRANGER, topics: [EVM_TRANSFER_TOPIC, addrTopic(STRANGER), addrTopic(W0)], data: `0x${w64(9n)}`, blockNumber: q(25), blockHash: world.hashOf(25), logIndex: q(2), transactionHash: h32("extra"), transactionIndex: q(2), removed: false };
  await assert.rejects(restore(pair(world, world, {}, { xfer: (l, _, to) => to !== addrTopic(W0) ? l : [...l, extra].sort((a, b) => Number(BigInt(a.blockNumber as string) - BigInt(b.blockNumber as string)) || Number(BigInt(a.logIndex as string) - BigInt(b.logIndex as string))) }), undefined, { sleep }), /the two RPCs differ at log 2/);
  assert.equal(waits.length, 0);
  // the same log in the newest block, under the other hash on one RPC: the block is still the anchor's on both, a lie
  const at100 = { ...extra, blockNumber: q(100), blockHash: h32("another block 100") };
  await assert.rejects(restore(pair(world, world, {}, { xfer: (l, _, to) => (to !== addrTopic(W0) ? l : [...l, at100]) }), undefined, { sleep }), /a log of block 100 is not of the anchor/);
});

test("both RPCs telling one lie the views cannot see is refused: a deposit's value, a release's W, a withdrawal over the note", async () => {
  const { world, d0 } = seeded();
  const both = (f: (l: Record<string, unknown>[]) => Record<string, unknown>[]) => restore(pair(world, world, { pool: f }, { pool: f }));
  const edit = (i: number, word: number, v: bigint) => (l: Record<string, unknown>[]) => l.map((x, k) => (k === i ? { ...x, data: `0x${(x.data as string).slice(2, 2 + 64 * word)}${w64(v)}${(x.data as string).slice(2 + 64 * (word + 1))}` } : x));
  await assert.rejects(both(edit(1, 2, 2n * 10n ** 16n)), /its commitment is not Poseidon/);
  await assert.rejects(both((l) => l.map((x, k) => (k === 4 ? { ...x, topics: [(x.topics as string[])[0], addrTopic(STRANGER)] } : x))), /: its release paid an address that is not its W/);
  await assert.rejects(both(edit(4, 1, 10n ** 16n + 1n)), /its release withdrew/);
  await assert.rejects(both(edit(4, 1, 0n)), /its release withdrew 0/);
});

test("evmRestore refuses a pool that is not one: a precommitment twice, a nullifier twice, a leaf twice, a label not its nonce's, a release before its note, a change that is not the release's", () => {
  const { world, d0 } = seeded();
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
  assert.throws(() => run((e) => e.map((x, k) => (k === 4 ? { ...x, state: 99n } : x))), /its release's new commitment is not its change note/);
});
