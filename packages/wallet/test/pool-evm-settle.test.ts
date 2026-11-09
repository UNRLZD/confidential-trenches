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
import { EVM_POOL_EVENTS, evmPoolScopeOf, evmTreeSync, type EvmPoolPin, type EvmRpc } from "../src/pool/evm.ts";
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
type World = { pool: PoolEv[]; head: number; finalized: number };

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
  const block = (n: number) => (n > w.head || n < 0 ? null : { number: q(n), hash: h32(`block ${n}`), timestamp: q(timeOf(n)), baseFeePerGas: q(1n) });
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
    assert.deepEqual(await pass(ns, a, b), { spent: [], freed: [], held: [id] });
    assert.equal(await stateOf(ns, id), "RESERVED");
  }
  assert.equal((await ns.list()).length, 1, "no change note written");
});

test("a release both RPCs show at or below the finalized anchor writes SPENT and its change leaf; above it, the note is held", async () => {
  const { ns, id } = await reserved();
  // both show it, but in a block above the finalized anchor (15): held, nothing written
  const tail: World = { pool: chain(true), head: 40, finalized: 15 };
  assert.deepEqual(await pass(ns, tail, tail), { spent: [], freed: [], held: [id] });
  assert.equal(await stateOf(ns, id), "RESERVED");
  // finalized on both at 30 (one at 32): spent, with its change note at the release's own leaf (index 3)
  const final: World = { pool: chain(true), head: 40, finalized: 30 };
  assert.deepEqual(await pass(ns, final, { ...final, finalized: 32 }), { spent: [id], freed: [], held: [] });
  assert.equal(await stateOf(ns, id), "SPENT");
  const change = (await ns.list()).find((n) => refKey(n.ref) === refKey(C0))!;
  assert.equal(change.state, "UNSPENT");
  assert.equal(change.parent, id);
  assert.deepEqual(change.leaf, { value: VALUE - WITHDRAWN, label: L0, commitment: noteCommitment(VALUE - WITHDRAWN, L0, P(C0)), leafIndex: 3n });
  // idempotent: a second pass (a state read, a reload) finds nothing RESERVED and reads nothing
  const reads = { n: 0 };
  assert.deepEqual(await pass(ns, final, final, reads), { spent: [], freed: [], held: [] });
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
  assert.deepEqual(await pass(a.ns, final, final), { spent: [a.id], freed: [], held: [] });
  assert.equal(await stateOf(a.ns, a.id), "SPENT");
  // the note's nullifier spent with a change that is not the note's: the chain's truth, SPENT, no change note of ours
  const b = await reserved();
  const foreign: World = { pool: chain("foreign"), head: 40, finalized: 30 };
  assert.deepEqual(await pass(b.ns, foreign, foreign), { spent: [b.id], freed: [], held: [] });
  assert.equal(await stateOf(b.ns, b.id), "SPENT");
  assert.equal((await b.ns.list()).length, 1);
});

test("a deadline passed on both RPCs' final block with no release frees the note", async () => {
  const { ns, id } = await reserved();
  // finalized exactly at the deadline's block on both: not past it, held
  const at: World = { pool: chain(false), head: 40, finalized: RELEASE_BLOCK };
  assert.deepEqual(await pass(ns, at, at), { spent: [], freed: [], held: [id] });
  assert.equal(await stateOf(ns, id), "RESERVED");
  // both finalized past it (21 and 30): freed, so the queue proves it again
  const past: World = { pool: chain(false), head: 40, finalized: 30 };
  assert.deepEqual(await pass(ns, { ...past, finalized: RELEASE_BLOCK + 1 }, past), { spent: [], freed: [id], held: [] });
  assert.equal(await stateOf(ns, id), "UNSPENT");
  // and again: nothing RESERVED, nothing read
  const reads = { n: 0 };
  assert.deepEqual(await pass(ns, past, past, reads), { spent: [], freed: [], held: [] });
  assert.equal(reads.n, 0);
});

test("a deadline passed on one RPC's final block only frees nothing", async () => {
  const { ns, id } = await reserved();
  const past: World = { pool: chain(false), head: 40, finalized: 30 };
  const notYet: World = { pool: chain(false), head: 40, finalized: RELEASE_BLOCK - 2 };
  for (const [a, b] of [[past, notYet], [notYet, past]] as const) {
    assert.deepEqual(await pass(ns, a, b), { spent: [], freed: [], held: [id] });
    assert.equal(await stateOf(ns, id), "RESERVED");
  }
});

test("a note of another scope is never read for, and a round that fails holds every note", async () => {
  const { ns, id } = await reserved();
  const reads = { n: 0 };
  const sync = evmTreeSync({ rpcs: [rpc({ pool: chain(false), head: 40, finalized: 30 }, "https://a.example", reads), rpc({ pool: chain(false), head: 40, finalized: 30 }, "https://b.example", reads)], pin: PIN, sleep: async () => {} });
  assert.deepEqual(await evmSettleReserved({ seed64: SEED, notes: ns, scope: SCOPE + 1n, round: (s) => sync.events(s) }), { spent: [], freed: [], held: [] });
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
const settleOn = (ns: NoteStore, events: unknown[]) => evmSettleReserved({ seed64: SEED, notes: ns, scope: SCOPE, round: async () => ({ fin: { number: 30n, timestamp: timeOf(30) }, events: events as never }) });
const changeOf = (ref: NoteRef, value: bigint) => noteCommitment(value, L0, P(ref));

test("a change note's own spend writes the next change, j + 1: never change j again", async () => {
  // change 0 (j = 0) at leaf 1, spent at leaf 2: its change is change 1 under the same label
  const { ns, id, commitment } = await reservedAt(C0, 1n);
  const C1: NoteRef = { kind: "change", l: L0, j: 1 };
  assert.deepEqual(await settleOn(ns, [depEv(9n), depEv(commitment), relEv(C0, changeOf(C1, VALUE - WITHDRAWN))]), { spent: [id], freed: [], held: [] });
  const next = (await ns.list()).find((n) => n.parent === id)!;
  assert.deepEqual(next.ref, C1);
  assert.equal(next.precommitment, P(C1));
  assert.deepEqual(next.leaf, { value: VALUE - WITHDRAWN, label: L0, commitment: changeOf(C1, VALUE - WITHDRAWN), leafIndex: 2n });
});

test("a release before the note's own leaf, one of 0 or above its value, or a round whose leaf is not the note's settles nothing", async () => {
  // the release (with the change it would write) at leaf 1, before the note's leaf 2
  const early = await reservedAt(D0, 2n);
  assert.deepEqual(await settleOn(early.ns, [depEv(9n), relEv(D0, changeOf(C0, VALUE - WITHDRAWN)), depEv(early.commitment)]), { spent: [], freed: [], held: [early.id] });
  // a release of 0 (whose change would be the whole value) and one above the note's value
  const zero = await reservedAt(D0, 1n);
  assert.deepEqual(await settleOn(zero.ns, [depEv(9n), depEv(zero.commitment), relEv(D0, changeOf(C0, VALUE), 0n)]), { spent: [], freed: [], held: [zero.id] });
  const over = await reservedAt(D0, 1n);
  assert.deepEqual(await settleOn(over.ns, [depEv(9n), depEv(over.commitment), relEv(D0, changeOf(C0, 0n), VALUE + 1n)]), { spent: [], freed: [], held: [over.id] });
  // the round's leaf 1 is another commitment than the note's: the store and the round differ
  const other = await reservedAt(D0, 1n);
  assert.deepEqual(await settleOn(other.ns, [depEv(9n), depEv(other.commitment + 1n), relEv(D0, changeOf(C0, VALUE - WITHDRAWN))]), { spent: [], freed: [], held: [other.id] });
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
  assert.deepEqual(await settleOn(taken.ns, [depEv(9n), depEv(taken.commitment), relEv(D0, change)]), { spent: [], freed: [], held: [taken.id] });
  assert.equal((await taken.ns.list()).find((n) => refKey(n.ref) === refKey(C0))!.leaf!.leafIndex, 7n, "the other tab's change is left as it is");
});

test("a pass stopped (sign out) writes nothing after the stop: not after its round, not after its note in hand", async () => {
  // stopped while the round is read: it rejects, the note stays RESERVED
  const a = await reservedAt(D0, 1n);
  const stop = new AbortController();
  const round = async () => {
    stop.abort();
    return { fin: { number: 30n, timestamp: timeOf(30) }, events: [depEv(9n), depEv(a.commitment), relEv(D0, changeOf(C0, VALUE - WITHDRAWN))] as never };
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
  await assert.rejects(evmSettleReserved({ seed64: SEED, notes: b.ns, scope: SCOPE, round: async () => ({ fin: { number: 30n, timestamp: timeOf(30) }, events: [depEv(9n), depEv(b.commitment), depEv(c1)] as never }), signal: later.signal }), { name: "AbortError" });
  assert.deepEqual((await b.ns.list()).map((n) => n.state).sort(), ["RESERVED", "UNSPENT"]);
});
