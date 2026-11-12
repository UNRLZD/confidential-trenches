// The EVM pool's settle of RESERVED notes (card signpage-evm-proof-queue; src/pool/evm-settle.ts), on the pool's real
// sync (evmTreeSync) over two fake RPCs: a release settles the note only when both RPCs show it at or below the
// finalized anchor, and a note is freed only when both RPCs' final block time is past its deadline with no release.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { VaultTree, vaultLabelOf } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, refKey, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore } from "../src/store/index.ts";
import { EVM_LAG_TRIES, EVM_POOL_EVENTS, EvmLagError, evmPoolScopeOf, evmTreeSync, type EvmPoolPin, type EvmRpc } from "../src/pool/evm.ts";
import { evmClaimTaken, evmTakenNotes } from "../src/pool/evm-restore.ts";
import { evmSettleReserved } from "../src/pool/evm-settle.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const w64 = (x: bigint): string => x.toString(16).padStart(64, "0");
const q = (n: number | bigint): string => `0x${BigInt(n).toString(16)}`;
const h32 = (s: string): string => `0x${hex(keccak_256(enc.encode(s)))}`;
const TOPIC = { deposit: h32(EVM_POOL_EVENTS.Deposited), withdraw: h32(EVM_POOL_EVENTS.Withdrawn), buy: h32(EVM_POOL_EVENTS.Bought) };
const sel = (s: string): string => hex(keccak_256(enc.encode(s)).subarray(0, 4));
const addrTopic = (a: string): string => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

const POOL = "0x00000000000000000000000000000000b1f1f001";
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const STRANGER = "0x0000000000000000000000000000000000005555";
const TA = "0x00000000000000000000000000000000000000aa";
const PIN: EvmPoolPin = { network: "base-sepolia", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n };
const SCOPE = evmPoolScopeOf(POOL, 84532n);
const T0 = 1_800_000_000n;
/** A block's time, s: two seconds a block. */
const timeOf = (n: number): bigint => T0 + 2n * BigInt(n);

type PoolEv = { block: number; kind: "deposit" | "withdraw" | "buy"; state: bigint; label?: bigint; value: bigint; pre?: bigint; nul?: bigint; to?: string };
/** fork: a block this RPC holds under another hash (two RPCs that never agree on the newest block) */
type World = { pool: PoolEv[]; head: number; finalized: number; fork?: number };

const D0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const P = (ref: NoteRef) => noteSecrets(SEED, ref).precommitment;
const VALUE = 10n ** 16n;
const WITHDRAWN = 4n * 10n ** 15n;
const L0 = vaultLabelOf(keccak_256, SCOPE, 2n);
const C0: NoteRef = { kind: "change", l: L0, j: 0 };
const W0 = (() => {
  const w = d.freshWallet(SEED, "evm", L0, 0);
  w.secretKey.fill(0);
  return w.address.toLowerCase();
})();
/** The release block: the note's deadline is this block's time, so a release lands in it (the pool's check is
 * block.timestamp * 1000 > deadlineMs, src/PrivacyPool.sol:241) and in no later block. */
const RELEASE_BLOCK = 20;
const DEADLINE_MS = timeOf(RELEASE_BLOCK) * 1000n;

/** A stranger's deposit, deposit 0 of ours (leaf 1), another stranger's; with `release`, deposit 0's buy at block 20
 *  paying W0 and writing its change note (leaf 3), then a stranger's deposit at 35. */
function chain(release: boolean | "foreign"): PoolEv[] {
  const pool: PoolEv[] = [];
  let nonce = 0n;
  const dep = (block: number, pre: bigint, value: bigint): void => {
    const label = vaultLabelOf(keccak_256, SCOPE, ++nonce);
    pool.push({ block, kind: "deposit", state: noteCommitment(value, label, pre), label, value, pre });
  };
  dep(5, 11n, VALUE);
  dep(10, P(D0), VALUE);
  dep(12, 12n, VALUE);
  if (release !== false) {
    const change = release === "foreign" ? 77n : noteCommitment(VALUE - WITHDRAWN, L0, P(C0));
    pool.push({ block: RELEASE_BLOCK, kind: "buy", state: change, value: WITHDRAWN, nul: noteSecrets(SEED, D0).nullifierHash, to: W0 });
  }
  dep(35, 13n, VALUE);
  return pool;
}

function poolLogs(w: World): Record<string, unknown>[] {
  return w.pool.map((e, i) => {
    const data =
      e.kind === "deposit" ? w64(e.state) + w64(e.label!) + w64(e.value) + w64(e.pre!)
      : w64(BigInt(FEE_TO)) + w64(e.value) + w64(10n ** 12n) + w64(e.nul!) + w64(e.state) + (e.kind === "buy" ? w64(BigInt(TA)) + w64(1000n) : "");
    return { address: POOL, topics: [TOPIC[e.kind], addrTopic(e.kind === "deposit" ? STRANGER : e.to!)], data: `0x${data}`, blockNumber: q(e.block), blockHash: h32(`block ${e.block}`), logIndex: q(0), transactionHash: h32(`pool tx ${i} ${e.block}`), transactionIndex: q(0), removed: false };
  });
}
function viewsAt(w: World, n: number) {
  const st = new VaultTree(), lt = new VaultTree();
  for (const e of w.pool.filter((e) => e.block <= n)) {
    st.append([e.state]);
    if (e.label !== undefined) lt.append([e.label]);
  }
  return { root: st.root ?? 0n, size: BigInt(st.size), labelRoot: lt.root ?? 0n, labelSize: BigInt(lt.size) };
}
/** One RPC on world `w`: blocks up to its head, its own finalized block, the pool's logs and views. `reads` counts calls. */
function rpc(w: World, url: string, reads = { n: 0 }): EvmRpc {
  const block = (n: number) => (n > w.head || n < 0 ? null : { number: q(n), hash: h32(`block ${n}${w.fork === n ? " fork" : ""}`), timestamp: q(timeOf(n)), baseFeePerGas: q(1n) });
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    reads.n++;
    switch (method) {
      case "eth_chainId": return q(84532n);
      case "eth_getBlockByNumber": {
        const at = params[0] as string;
        return block(at === "finalized" ? w.finalized : at === "latest" ? w.head : Number(BigInt(at)));
      }
      case "eth_getLogs": {
        const p = params[0] as { fromBlock: string; toBlock: string };
        const from = Number(BigInt(p.fromBlock)), to = Math.min(Number(BigInt(p.toBlock)), w.head);
        return poolLogs(w).filter((l) => Number(BigInt(l.blockNumber as string)) >= from && Number(BigInt(l.blockNumber as string)) <= to);
      }
      case "eth_call": {
        const [, { blockHash }] = params as [{ to: string; data: string }, { blockHash: string }];
        let n = -1;
        for (let k = 0; k <= w.head; k++) if (h32(`block ${k}`) === blockHash) n = k;
        if (n < 0) throw new Error("RPC error -32000: header not found");
        const v = viewsAt(w, n);
        const s = (params[0] as { data: string }).data.slice(2, 10);
        const out = s === sel("SCOPE()") ? SCOPE : s === sel("currentRoot()") ? v.root : s === sel("currentTreeSize()") ? v.size : s === sel("currentLabelRoot()") ? v.labelRoot : s === sel("currentLabelTreeSize()") ? v.labelSize : assert.fail(`unexpected view ${s}`);
        return `0x${w64(out)}`;
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return Object.assign(f, { url });
}

const stores: { close(): void }[] = [];
after(() => {
  for (const x of stores.splice(0)) x.close();
});
/** A store holding deposit 0 at leaf 1, its proof taken (RESERVED) with the deadline DEADLINE_MS. */
async function reserved(): Promise<{ ns: NoteStore; id: string }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  stores.push(ns, w);
  const label = vaultLabelOf(keccak_256, SCOPE, 2n);
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label, commitment: noteCommitment(VALUE, label, P(D0)), leafIndex: 1n } });
  const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: held.attempt! });
  return { ns, id: n.id };
}
/** One settle pass on the pool's sync over RPCs a and b. */
const pass = (ns: NoteStore, a: World, b: World, reads?: { n: number }) => {
  const sync = evmTreeSync({ rpcs: [rpc(a, "https://a.example", reads), rpc(b, "https://b.example", reads)], pin: PIN, sleep: async () => {} });
  return evmSettleReserved({ seed64: SEED, notes: ns, scope: SCOPE, round: (s) => sync.events(s) });
};
const stateOf = async (ns: NoteStore, id: string) => (await ns.get(id))!.state;

test("a release seen on one RPC only settles nothing: the note stays RESERVED, never spent and never freed", async () => {
  const { ns, id } = await reserved();
  // both heads at 40, both finalized at 30 (past the deadline): one shows the release, the other does not. The two RPCs
  // disagree on the pool's views, so the round is refused
  const seen: World = { pool: chain(true), head: 40, finalized: 30 };
  const unseen: World = { pool: chain(false), head: 40, finalized: 30 };
  for (const [a, b] of [[seen, unseen], [unseen, seen]] as const) {
    await assert.rejects(pass(ns, a, b), /the two RPCs differ on currentRoot\(\)/);
    assert.equal(await stateOf(ns, id), "RESERVED");
  }
  // the other RPC behind the release's block: the round they agree on holds no release, and its finalized anchor (the
  // lower one, block 15) is before the deadline, so the note is held: its release can still land
  const behind: World = { pool: chain(true), head: 18, finalized: 15 };
  for (const [a, b] of [[seen, behind], [behind, seen]] as const) {
    assert.deepEqual(await pass(ns, a, b), { spent: [], freed: [], held: [id], backedOut: [] });
    assert.equal(await stateOf(ns, id), "RESERVED");
  }
  assert.equal((await ns.list()).length, 1, "no change note written");
});

test("head: a release both RPCs show at the newest agreed block writes SPENT and its change leaf at once, the change marked landed while above the finalized block", async () => {
  const { ns, id } = await reserved();
  // both show it in block 20, above the finalized block (15): spent now, never held for the finalized block
  const tail: World = { pool: chain(true), head: 40, finalized: 15 };
  assert.deepEqual(await pass(ns, tail, tail), { spent: [id], freed: [], held: [], backedOut: [] });
  assert.equal(await stateOf(ns, id), "SPENT");
  const change = (await ns.list()).find((n) => refKey(n.ref) === refKey(C0))!;
  assert.equal(change.state, "UNSPENT");
  assert.equal(change.parent, id);
  assert.deepEqual(change.leaf, { value: VALUE - WITHDRAWN, label: L0, commitment: noteCommitment(VALUE - WITHDRAWN, L0, P(C0)), leafIndex: 3n });
  assert.equal((await ns.landings()).get(change.id), 20n, "its release's block, above the finalized block");
  // the next pass, the finalized block past it (30): the landing is final, its block dropped, and nothing more is read
  const final: World = { pool: chain(true), head: 40, finalized: 30 };
  assert.deepEqual(await pass(ns, final, { ...final, finalized: 32 }), { spent: [], freed: [], held: [], backedOut: [] });
  assert.equal((await ns.landings()).get(change.id), undefined);
  const reads = { n: 0 };
  assert.deepEqual(await pass(ns, final, final, reads), { spent: [], freed: [], held: [], backedOut: [] });
  assert.equal(reads.n, 0);
  assert.equal((await ns.list()).length, 2);
});

test("a change another tab wrote first is taken; a release that is not the device's (another change) is spent with no change note", async () => {
  const final: World = { pool: chain(true), head: 40, finalized: 30 };
  // another tab settled it between this pass's list and its write: the same change, at the same leaf, is taken
  const a = await reserved();
  const listed = a.ns.list.bind(a.ns);
  let first = true;
  a.ns.list = async () => {
    const out = await listed();
    if (first) {
      first = false;
      await a.ns.add({ ref: C0, scope: SCOPE, precommitment: P(C0), state: "UNSPENT", parent: a.id, leaf: { value: VALUE - WITHDRAWN, label: L0, commitment: noteCommitment(VALUE - WITHDRAWN, L0, P(C0)), leafIndex: 3n } });
    }
    return out;
  };
  assert.deepEqual(await pass(a.ns, final, final), { spent: [a.id], freed: [], held: [], backedOut: [] });
  assert.equal(await stateOf(a.ns, a.id), "SPENT");
  // the note's nullifier spent with a change that is not the note's: the chain's truth, SPENT, no change note of ours
  const b = await reserved();
  const foreign: World = { pool: chain("foreign"), head: 40, finalized: 30 };
  assert.deepEqual(await pass(b.ns, foreign, foreign), { spent: [b.id], freed: [], held: [], backedOut: [] });
  assert.equal(await stateOf(b.ns, b.id), "SPENT");
  assert.equal((await b.ns.list()).length, 1);
});

test("head: a deadline passed at the newest agreed block with no release frees the note", async () => {
  const { ns, id } = await reserved();
  // both heads exactly at the deadline's block: not past it, held (the finalized block far behind changes nothing)
  const at: World = { pool: chain(false), head: RELEASE_BLOCK, finalized: 5 };
  assert.deepEqual(await pass(ns, at, at), { spent: [], freed: [], held: [id], backedOut: [] });
  assert.equal(await stateOf(ns, id), "RESERVED");
  // both heads past it (21 and 30), both finalized blocks before it: freed, so the queue proves it again
  const past: World = { pool: chain(false), head: 30, finalized: 5 };
  assert.deepEqual(await pass(ns, { ...past, head: RELEASE_BLOCK + 1 }, past), { spent: [], freed: [id], held: [], backedOut: [] });
  assert.equal(await stateOf(ns, id), "UNSPENT");
  // and again: nothing RESERVED, nothing in the tail, nothing read
  const reads = { n: 0 };
  assert.deepEqual(await pass(ns, past, past, reads), { spent: [], freed: [], held: [], backedOut: [] });
  assert.equal(reads.n, 0);
});

test("head: a deadline passed on one RPC's head only frees nothing", async () => {
  const { ns, id } = await reserved();
  const past: World = { pool: chain(false), head: 40, finalized: 30 };
  const notYet: World = { pool: chain(false), head: RELEASE_BLOCK - 2, finalized: RELEASE_BLOCK - 4 };
  for (const [a, b] of [[past, notYet], [notYet, past]] as const) {
    assert.deepEqual(await pass(ns, a, b), { spent: [], freed: [], held: [id], backedOut: [] });
    assert.equal(await stateOf(ns, id), "RESERVED");
  }
});

test("a note of another scope is never read for, and a round that fails holds every note", async () => {
  const { ns, id } = await reserved();
  const reads = { n: 0 };
  const sync = evmTreeSync({ rpcs: [rpc({ pool: chain(false), head: 40, finalized: 30 }, "https://a.example", reads), rpc({ pool: chain(false), head: 40, finalized: 30 }, "https://b.example", reads)], pin: PIN, sleep: async () => {} });
  assert.deepEqual(await evmSettleReserved({ seed64: SEED, notes: ns, scope: SCOPE + 1n, round: (s) => sync.events(s) }), { spent: [], freed: [], held: [], backedOut: [] });
  assert.equal(reads.n, 0);
  await assert.rejects(evmSettleReserved({ seed64: SEED, notes: ns, scope: SCOPE, round: async () => { throw new Error("rpc down"); } }), /rpc down/);
  assert.equal(await stateOf(ns, id), "RESERVED");
});

// The settle's own checks on a round as the sync gives it (review P3-1): each round below is built leaf by leaf, so one
// check at a time decides the note. A RESERVED note `ref` at leaf `at`, its proof taken with the deadline DEADLINE_MS.
async function reservedAt(ref: NoteRef, at: bigint): Promise<{ ns: NoteStore; id: string; commitment: bigint }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  stores.push(ns, w);
  const commitment = noteCommitment(VALUE, L0, P(ref));
  const n = await ns.add({ ref, scope: SCOPE, precommitment: P(ref), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment, leafIndex: at } });
  const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: held.attempt! });
  return { ns, id: n.id, commitment };
}
const row = (block: number) => ({ block: BigInt(block), blockHash: `0x${w64(BigInt(block))}`, logIndex: 0n, bytes: "0x" });
const depEv = (state: bigint) => ({ ...row(5), kind: "deposit" as const, state, label: L0, value: VALUE, precommitment: 1n, nullifier: null, recipient: null, token: null });
const relEv = (ref: NoteRef, state: bigint, value = WITHDRAWN) => ({ ...row(RELEASE_BLOCK), kind: "buy" as const, state, label: null, value, precommitment: null, nullifier: noteSecrets(SEED, ref).nullifierHash, recipient: W0, token: TA });
/** One settle pass on a round whose finalized anchor is block 30 (past the deadline) and whose leaves are `events`. */
const settleOn = (ns: NoteStore, events: unknown[]) => evmSettleReserved({ seed64: SEED, notes: ns, scope: SCOPE, round: async () => ({ fin: { number: 30n, timestamp: timeOf(30) }, anchor: { number: 30n, timestamp: timeOf(30) }, events: events as never }) });
const changeOf = (ref: NoteRef, value: bigint) => noteCommitment(value, L0, P(ref));

test("a change note's own spend writes the next change, j + 1: never change j again", async () => {
  // change 0 (j = 0) at leaf 1, spent at leaf 2: its change is change 1 under the same label
  const { ns, id, commitment } = await reservedAt(C0, 1n);
  const C1: NoteRef = { kind: "change", l: L0, j: 1 };
  assert.deepEqual(await settleOn(ns, [depEv(9n), depEv(commitment), relEv(C0, changeOf(C1, VALUE - WITHDRAWN))]), { spent: [id], freed: [], held: [], backedOut: [] });
  const next = (await ns.list()).find((n) => n.parent === id)!;
  assert.deepEqual(next.ref, C1);
  assert.equal(next.precommitment, P(C1));
  assert.deepEqual(next.leaf, { value: VALUE - WITHDRAWN, label: L0, commitment: changeOf(C1, VALUE - WITHDRAWN), leafIndex: 2n });
});

test("a release before the note's own leaf, one of 0 or above its value, or a round whose leaf is not the note's settles nothing", async () => {
  // the release (with the change it would write) at leaf 1, before the note's leaf 2
  const early = await reservedAt(D0, 2n);
  assert.deepEqual(await settleOn(early.ns, [depEv(9n), relEv(D0, changeOf(C0, VALUE - WITHDRAWN)), depEv(early.commitment)]), { spent: [], freed: [], held: [early.id], backedOut: [] });
  // a release of 0 (whose change would be the whole value) and one above the note's value
  const zero = await reservedAt(D0, 1n);
  assert.deepEqual(await settleOn(zero.ns, [depEv(9n), depEv(zero.commitment), relEv(D0, changeOf(C0, VALUE), 0n)]), { spent: [], freed: [], held: [zero.id], backedOut: [] });
  const over = await reservedAt(D0, 1n);
  assert.deepEqual(await settleOn(over.ns, [depEv(9n), depEv(over.commitment), relEv(D0, changeOf(C0, 0n), VALUE + 1n)]), { spent: [], freed: [], held: [over.id], backedOut: [] });
  // the round's leaf 1 is another commitment than the note's: the store and the round differ
  const other = await reservedAt(D0, 1n);
  assert.deepEqual(await settleOn(other.ns, [depEv(9n), depEv(other.commitment + 1n), relEv(D0, changeOf(C0, VALUE - WITHDRAWN))]), { spent: [], freed: [], held: [other.id], backedOut: [] });
  for (const x of [early, zero, over, other]) {
    assert.equal(await stateOf(x.ns, x.id), "RESERVED");
    assert.equal((await x.ns.list()).length, 1, "no change note written");
  }
});

test("a round with one nullifier spent twice settles nothing, and a different change already on the ref is never taken", async () => {
  const twice = await reservedAt(D0, 1n);
  const change = changeOf(C0, VALUE - WITHDRAWN);
  await assert.rejects(settleOn(twice.ns, [depEv(9n), depEv(twice.commitment), relEv(D0, 5n), relEv(D0, change)]), /a nullifier spent twice/);
  assert.equal(await stateOf(twice.ns, twice.id), "RESERVED");
  // another tab wrote change 0 between this pass's list and its write, at another leaf than this release's: not this
  // change, so the pass settles nothing of its own (the note held), never "spent" on a ref match alone
  const taken = await reservedAt(D0, 1n);
  const listed = taken.ns.list.bind(taken.ns);
  let first = true;
  taken.ns.list = async () => {
    const out = await listed();
    if (first) {
      first = false;
      await taken.ns.add({ ref: C0, scope: SCOPE, precommitment: P(C0), state: "UNSPENT", leaf: { value: VALUE - WITHDRAWN, label: L0, commitment: change, leafIndex: 7n } });
    }
    return out;
  };
  assert.deepEqual(await settleOn(taken.ns, [depEv(9n), depEv(taken.commitment), relEv(D0, change)]), { spent: [], freed: [], held: [taken.id], backedOut: [] });
  assert.equal((await taken.ns.list()).find((n) => refKey(n.ref) === refKey(C0))!.leaf!.leafIndex, 7n, "the other tab's change is left as it is");
});

test("a pass stopped (sign out) writes nothing after the stop: not after its round, not after its note in hand", async () => {
  // stopped while the round is read: it rejects, the note stays RESERVED
  const a = await reservedAt(D0, 1n);
  const stop = new AbortController();
  const round = async () => {
    stop.abort();
    return { fin: { number: 30n, timestamp: timeOf(30) }, anchor: { number: 30n, timestamp: timeOf(30) }, events: [depEv(9n), depEv(a.commitment), relEv(D0, changeOf(C0, VALUE - WITHDRAWN))] as never };
  };
  await assert.rejects(evmSettleReserved({ seed64: SEED, notes: a.ns, scope: SCOPE, round, signal: stop.signal }), { name: "AbortError" });
  assert.equal(await stateOf(a.ns, a.id), "RESERVED");
  assert.equal((await a.ns.list()).length, 1);
  // two notes freed in one pass, stopped during the first one's write: the second is never written
  const b = await reservedAt(D0, 1n);
  const D1: NoteRef = { kind: "deposit", s: SCOPE, i: 1 };
  const L1 = vaultLabelOf(keccak_256, SCOPE, 3n);
  const c1 = noteCommitment(VALUE, L1, P(D1));
  const n1 = await b.ns.add({ ref: D1, scope: SCOPE, precommitment: P(D1), state: "UNSPENT", leaf: { value: VALUE, label: L1, commitment: c1, leafIndex: 2n } });
  const h1 = await b.ns.move(n1.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "6" });
  await b.ns.move(n1.id, "HELD", "RESERVED", { attempt: h1.attempt! });
  const later = new AbortController();
  const move = b.ns.move.bind(b.ns);
  b.ns.move = (async (...args: Parameters<NoteStore["move"]>) => {
    const out = await move(...args);
    later.abort();
    return out;
  }) as NoteStore["move"];
  await assert.rejects(evmSettleReserved({ seed64: SEED, notes: b.ns, scope: SCOPE, round: async () => ({ fin: { number: 30n, timestamp: timeOf(30) }, anchor: { number: 30n, timestamp: timeOf(30) }, events: [depEv(9n), depEv(b.commitment), depEv(c1)] as never }), signal: later.signal }), { name: "AbortError" });
  assert.deepEqual((await b.ns.list()).map((n) => n.state).sort(), ["RESERVED", "UNSPENT"]);
});

// card pool-buy-record-never-stays-sent: a release this device read landed is on the note's mark with its block; a pass
// whose newest agreed block is at or past that block with no release of the note in the round (a reorg dropped it)
// takes the landed value off, so the balance counts the whole note again; one whose newest block is below it keeps it
test("a landed value whose release a reorg dropped: taken off once the newest agreed block is past its block with no release in the round, kept before", async () => {
  const { ns, id } = await reserved();
  const n = (await ns.get(id))!;
  await ns.landed(id, n.attempt!, 40n, 15n);
  const early: World = { pool: chain(false), head: 14, finalized: 10 };
  assert.deepEqual(await pass(ns, early, early), { spent: [], freed: [], held: [id], backedOut: [] });
  assert.equal((await ns.marks()).get(id)?.withdrawn, 40n, "its block not read yet: the release may still come in");
  const later: World = { pool: chain(false), head: 15, finalized: 10 };
  assert.deepEqual(await pass(ns, later, later), { spent: [], freed: [], held: [id], backedOut: [] });
  const m = (await ns.marks()).get(id);
  assert.equal(m?.withdrawn, undefined, "the head past its block and not in the round: taken off");
  assert.equal(m?.attempt, n.attempt);
  assert.equal(await stateOf(ns, id), "RESERVED");
});

// card evm-money-shows-and-spends-at-once: the heal. A note written from a block above the finalized one keeps that
// block; a reorg that drops its leaf or its release is undone at the next pass, and only while the block is above the
// highest finalized block the store was ever told (the store's own guard, never only the caller's).
/** The pool's events as the sync gives them for world `w` (both RPCs the same). */
const eventsOf = async (w: World) => (await evmTreeSync({ rpcs: [rpc(w, "https://a.example"), rpc(w, "https://b.example")], pin: PIN, sleep: async () => {} }).events()).events;
/** The leaf value the pool holds for the user on this store, as the balance reads it. */
const balanceOf = async (ns: NoteStore) => (await ns.list()).filter((n) => n.scope === SCOPE && (n.state === "UNSPENT" || n.state === "HELD" || n.state === "RESERVED")).reduce((t, n) => t + n.leaf!.value, 0n);
async function emptyStore(): Promise<NoteStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  stores.push(ns, w);
  return ns;
}

test("head: a note landed in the tail is stored with the record keys every earlier release reads, its block beside it (owed/evm-landed)", async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  stores.push(ns, w);
  const landed: World = { pool: chain(false), head: 40, finalized: 5 };
  const [n] = await evmClaimTaken(ns, evmTakenNotes(SEED, SCOPE, await eventsOf(landed), D0, 5n).taken);
  // the keys an earlier release's reader accepts on a note (its checkRecord's list), and no other
  const EARLIER = ["id", "ref", "scope", "precommitment", "state", "parent", "leaf", "deadlineMs", "attempt", "tab", "calls", "searchFrom", "sends", "evmSends", "evmSpent", "contexts", "request"];
  const raw = (await w.get("notes", n!.id)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw).filter((k) => !EARLIER.includes(k)), [], "no key an earlier release refuses");
  assert.deepEqual(await w.get("meta", "owed/evm-landed"), { final: { [SCOPE.toString()]: 5n }, block: { [n!.id]: 10n } });
  assert.equal((await ns.landings()).get(n!.id), 10n);
});

test("head: a reorg drops a deposit's leaf: the note leaves the balance and the spendable notes in one write, back to INCOMING, and lands again at its new leaf", async () => {
  const ns = await emptyStore();
  // deposit 0 lands in block 10, the finalized block at 5: taken at once, marked with its block
  const landed: World = { pool: chain(false), head: 40, finalized: 5 };
  const got = evmTakenNotes(SEED, SCOPE, await eventsOf(landed), D0, 5n);
  assert.deepEqual(got.taken.map((t) => [refKey(t.ref), t.landed]), [[refKey(D0), { block: 10n, fin: 5n }]]);
  const [n] = await evmClaimTaken(ns, got.taken);
  assert.equal(n!.state, "UNSPENT");
  assert.equal((await ns.landings()).get(n!.id), 10n);
  assert.equal(await balanceOf(ns), VALUE);
  // a reorg drops block 10: the next pass backs the note out; its balance and its spendability go in the same write
  const dropped: World = { pool: chain(false).filter((e) => e.block !== 10), head: 41, finalized: 5 };
  assert.deepEqual(await pass(ns, dropped, dropped), { spent: [], freed: [], held: [], backedOut: [n!.id] });
  const after1 = (await ns.get(n!.id))!;
  assert.equal(after1.state, "INCOMING");
  assert.equal(after1.leaf, undefined);
  assert.equal((await ns.landings()).get(n!.id), 10n, "its old block kept: the mark of a note backed out there");
  assert.equal(await balanceOf(ns), 0n);
  // the sequencer includes it again later, at another place (block 36, after the stranger's at 35): taken at its new leaf
  const again: World = { pool: [...dropped.pool, { ...chain(false).find((e) => e.block === 10)!, block: 36 }], head: 42, finalized: 5 };
  // its label is its new nonce's: the deposit as the pool makes it there
  const label = vaultLabelOf(keccak_256, SCOPE, 4n);
  again.pool[again.pool.length - 1] = { block: 36, kind: "deposit", state: noteCommitment(VALUE, label, P(D0)), label, value: VALUE, pre: P(D0) };
  const re = evmTakenNotes(SEED, SCOPE, await eventsOf(again), D0, 5n);
  const [n2] = await evmClaimTaken(ns, re.taken);
  assert.equal(n2!.id, n!.id);
  assert.equal(n2!.state, "UNSPENT");
  assert.equal(n2!.leaf!.leafIndex, 3n);
  assert.equal((await ns.landings()).get(n!.id), 36n, "its new landing's block");
  assert.equal(await balanceOf(ns), VALUE);
});

test("head: a reorg drops a release: its change goes and the note is RESERVED again at its own deadline (the balance whole), then freed past it, or spent again when the release lands again", async () => {
  for (const back of ["freed", "spent again"] as const) {
    const { ns, id } = await reserved();
    const tail: World = { pool: chain(true), head: 18 + 2, finalized: 15 };
    assert.deepEqual(await pass(ns, tail, tail), { spent: [id], freed: [], held: [], backedOut: [] });
    const change = (await ns.list()).find((n) => n.parent === id)!;
    assert.equal(await balanceOf(ns), VALUE - WITHDRAWN);
    // a reorg drops the release: block 20 again, now without it (the head at 20, not past the deadline): the change
    // goes, the note RESERVED
    const dropped: World = { pool: chain(false), head: 20, finalized: 15 };
    assert.deepEqual(await pass(ns, dropped, dropped), { spent: [], freed: [], held: [id], backedOut: [change.id] });
    const note = (await ns.get(id))!;
    assert.equal(note.state, "RESERVED");
    assert.equal(note.deadlineMs, DEADLINE_MS, "its own attempt's deadline");
    assert.equal(await ns.get(change.id), undefined);
    assert.equal(await balanceOf(ns), VALUE, "never less than the chain holds: the whole note");
    if (back === "freed") {
      // the head past the deadline with no release: freed, so the queue proves it again
      const past: World = { pool: chain(false), head: 30, finalized: 15 };
      assert.deepEqual(await pass(ns, past, past), { spent: [], freed: [id], held: [], backedOut: [] });
      assert.equal(await stateOf(ns, id), "UNSPENT");
    } else {
      // the release lands again in block 20: spent, with its change, at once
      assert.deepEqual(await pass(ns, tail, tail), { spent: [id], freed: [], held: [], backedOut: [] });
      assert.equal(await stateOf(ns, id), "SPENT");
      assert.equal(await balanceOf(ns), VALUE - WITHDRAWN);
    }
  }
});

test("head: a note backed out under a proof in flight ends that send with a clean refusal, never a note stuck RESERVED", async () => {
  const ns = await emptyStore();
  const landed: World = { pool: chain(false), head: 40, finalized: 5 };
  const [n] = await evmClaimTaken(ns, evmTakenNotes(SEED, SCOPE, await eventsOf(landed), D0, 5n).taken);
  const held = await ns.move(n!.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5" });
  const dropped: World = { pool: chain(false).filter((e) => e.block !== 10), head: 41, finalized: 5 };
  assert.deepEqual(await pass(ns, dropped, dropped), { spent: [], freed: [], held: [], backedOut: [n!.id] });
  // the holder's next step, the write before its proof leaves, is refused: nothing of the proof is sent
  await assert.rejects(ns.move(n!.id, "HELD", "RESERVED", { attempt: held.attempt! }), /is INCOMING, not HELD/);
  assert.equal(await stateOf(ns, n!.id), "INCOMING");
  // a proof already sent (RESERVED) on a leaf a reorg dropped: the pool refuses its root; the note backs out the same way
  const ns2 = await emptyStore();
  const [m] = await evmClaimTaken(ns2, evmTakenNotes(SEED, SCOPE, await eventsOf(landed), D0, 5n).taken);
  const h2 = await ns2.move(m!.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5" });
  await ns2.move(m!.id, "HELD", "RESERVED", { attempt: h2.attempt! });
  assert.deepEqual(await pass(ns2, dropped, dropped), { spent: [], freed: [], held: [], backedOut: [m!.id] });
  assert.equal(await stateOf(ns2, m!.id), "INCOMING");
  assert.equal((await ns2.marks()).get(m!.id), undefined);
});

test("head: a finalized fact never backs out: once a round with its block final held it, whatever block a caller names", async () => {
  const ns = await emptyStore();
  const leafOf = (ref: NoteRef, i: bigint) => {
    const label = vaultLabelOf(keccak_256, SCOPE, i + 1n);
    return { value: VALUE, label, commitment: noteCommitment(VALUE, label, P(ref)), leafIndex: i };
  };
  const D1: NoteRef = { kind: "deposit", s: SCOPE, i: 1 }, D2: NoteRef = { kind: "deposit", s: SCOPE, i: 2 }, D3: NoteRef = { kind: "deposit", s: SCOPE, i: 3 };
  // landed in block 50 above the finalized 40: kept with its block
  const a = await ns.add({ ref: D1, scope: SCOPE, precommitment: P(D1), state: "UNSPENT", leaf: leafOf(D1, 0n), landed: { block: 50n, fin: 40n } });
  assert.equal((await ns.landings()).get(a.id), 50n);
  // a round with block 50 final held it (finalized names it): refused from then on, whatever finalized block is named
  await ns.finalized(SCOPE, 60n, [a.id]);
  assert.equal((await ns.landings()).get(a.id), undefined);
  await assert.rejects(ns.backOut(a.id, 60n), /it never backs out/);
  await assert.rejects(ns.backOut(a.id, 30n), /it never backs out/);
  assert.equal(await stateOf(ns, a.id), "UNSPENT");
  // a finalized block past a note's that no round held it at (finalized not told of it): its block stays, a number alone
  // makes nothing final
  const b = await ns.add({ ref: D2, scope: SCOPE, precommitment: P(D2), state: "UNSPENT", leaf: leafOf(D2, 1n), landed: { block: 55n, fin: 40n } });
  await ns.finalized(SCOPE, 80n, []);
  assert.equal((await ns.landings()).get(b.id), 55n);
  await ns.backOut(b.id, 80n);
  assert.equal(await stateOf(ns, b.id), "INCOMING");
  // backed out once: an INCOMING note never backs out again
  await assert.rejects(ns.backOut(b.id, 80n), /never backs out/);
  // one landed at or under its own round's finalized block keeps no block: final, never backs out
  const c = await ns.add({ ref: D3, scope: SCOPE, precommitment: P(D3), state: "UNSPENT", leaf: leafOf(D3, 2n), landed: { block: 70n, fin: 70n } });
  assert.equal((await ns.landings()).get(c.id), undefined);
  await assert.rejects(ns.backOut(c.id, 30n), /never backs out/);
  // finalized() drops a held note's block only at or under its own fin
  const d = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: leafOf(D0, 3n), landed: { block: 90n, fin: 80n } });
  await ns.finalized(SCOPE, 85n, [d.id]);
  assert.equal((await ns.landings()).get(d.id), 90n);
  await ns.finalized(SCOPE, 90n, [d.id]);
  assert.equal((await ns.landings()).get(d.id), undefined);
  await assert.rejects(ns.backOut(d.id, 100n), /never backs out/);
});

test("head: a finalized fact never backs out of a pass: once a pass reads the note's block final, a later round on a stale finalized block that lacks its leaf keeps the note whole", async () => {
  const ns = await emptyStore();
  // deposit 0 lands in block 10 while the finalized block is 5: marked with its block
  const landed: World = { pool: chain(false), head: 40, finalized: 5 };
  const [n] = await evmClaimTaken(ns, evmTakenNotes(SEED, SCOPE, await eventsOf(landed), D0, 5n).taken);
  assert.equal((await ns.landings()).get(n!.id), 10n);
  // a pass whose finalized block (20) is past it: the note's landing is final, its mark gone
  assert.deepEqual(await pass(ns, { ...landed, finalized: 20 }, { ...landed, finalized: 20 }), { spent: [], freed: [], held: [], backedOut: [] });
  assert.equal((await ns.landings()).get(n!.id), undefined);
  // two RPCs answer a stale finalized block (5) and a round without block 10: the note is never backed out
  const stale: World = { pool: chain(false).filter((e) => e.block !== 10), head: 41, finalized: 5 };
  assert.deepEqual(await pass(ns, stale, stale), { spent: [], freed: [], held: [], backedOut: [] });
  assert.equal(await stateOf(ns, n!.id), "UNSPENT");
  assert.equal(await balanceOf(ns), VALUE);
});

test("head: two RPCs that never agree on the newest block: the pass keeps the last agreed state and fails as behind, never takes one RPC's word", async () => {
  const { ns, id } = await reserved();
  const tail: World = { pool: chain(true), head: 20, finalized: 15 };
  assert.deepEqual(await pass(ns, tail, tail), { spent: [id], freed: [], held: [], backedOut: [] });
  const seen = async () => JSON.stringify([(await ns.list()).map((n) => [n.id, n.state]), [...(await ns.landings())]], (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const before = await seen();
  // the release dropped on one RPC only, both heads at 40 under two hashes: every read a lag, then refused
  const a: World = { pool: chain(false), head: 40, finalized: 15 };
  const b: World = { pool: chain(true), head: 40, finalized: 15, fork: 40 };
  const waits: number[] = [];
  const sync = evmTreeSync({ rpcs: [rpc(a, "https://a.example"), rpc(b, "https://b.example")], pin: PIN, sleep: async (ms) => void waits.push(ms) });
  await assert.rejects(evmSettleReserved({ seed64: SEED, notes: ns, scope: SCOPE, round: (s) => sync.events(s) }), (e: Error) => e instanceof EvmLagError && /different blocks at 40/.test(e.message));
  assert.equal(waits.length, EVM_LAG_TRIES - 1);
  assert.equal(await seen(), before, "nothing written");
});
