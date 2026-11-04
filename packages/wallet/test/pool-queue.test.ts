// node --test packages/wallet/test/pool-queue.test.ts: the proof queue and the NEAR vault as its first pool (card
// wallet-pool-ladder, src/pool/queue.ts and src/pool/near.ts). The notes are withdraw-fixture.ts's: the all-zero test
// seed's deposit notes on a fixture vault, test values only, never money. The prover answers the signals Withdraw(32)
// gives without proving (signalsProver); the kit's real proof of a pool's context is prove-e2e.test.ts's.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VAULT_FIELD_P, VaultTree, vaultContextInput, vaultContextOf, vaultLabelOf, type VaultProver, type VaultWithdrawal } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import type { NoteRecord } from "../src/notes/store.ts";
import { NEAR_EPOCH_MS, NEAR_LIFE_MS, USDC_LADDER, nearVaultPool } from "../src/pool/near.ts";
import { NEWEST_GRACE_MS, TAKE_SLACK_MS, type Pool, type PoolBindArgs, type PoolTrees, type ReadyProof } from "../src/pool/pool.ts";
import { openProofQueue, proofPoolSize, readySetSize, type ProofQueue } from "../src/pool/queue.ts";
import {
  BLOCK_MS, BLOCK_NS, closeVaults, FEE_MAX, FEE_RECIPIENT, feeReplay, REGISTER_DEPOSIT, SCOPE, SEED, signalsProver, TOKEN, VAULT, vaultWith, type Vault,
} from "./withdraw-fixture.ts";

after(closeVaults);
const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
const E = 60_000n;
const L = 270_000n; // 2E + MARGIN + 30 s, as on the NEAR vault
const MARGIN = 120_000n;
const START = BigInt(BLOCK_MS) - (BigInt(BLOCK_MS) % E); // an epoch's start
const T0 = START - 3_600_000n; // when the fixture's leaves landed
const feeOf = (epochStartMs: bigint): bigint => 100_000n + ((epochStartMs / E) % 2n) * 10_000n; // the relayer's per epoch

type Timed = { leaf: bigint; t: bigint }[];
type Fake = Pool<{ n: number }> & {
  binds: PoolBindArgs[];
  t: { now: bigint };
  /** A leaf (and a label) landing now. */
  land: (commitment: bigint, label?: bigint) => void;
  rootAt: (beforeMs: bigint) => { state: bigint; label: bigint };
};
/** A pool on the fixture vault whose leaves carry their landing time; its context hashes W, chunk, fee, deadline, try. */
function fakePool(v: Vault): Fake {
  const t = { now: START + 1_000n };
  const state: Timed = v.stateLeaves.map((leaf) => ({ leaf, t: T0 }));
  const labels: Timed = v.labelLeaves.map((leaf) => ({ leaf, t: T0 }));
  const binds: PoolBindArgs[] = [];
  const tries = new Map<string, number>();
  const cut = (ls: Timed, before: bigint): VaultTree => new VaultTree(ls.filter((x) => x.t < before).map((x) => x.leaf));
  const trees = (before: bigint): PoolTrees => {
    const s = cut(state, before), l = cut(labels, before);
    return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
  };
  return {
    id: "test:pool",
    chain: "sol",
    scope: SCOPE,
    ladder: USDC_LADDER,
    epochMs: E,
    lifeMs: L,
    sendMarginMs: MARGIN,
    binds,
    t,
    now: async () => t.now,
    trees: async (before) => trees(before),
    land(commitment, label) {
      state.push({ leaf: commitment, t: t.now });
      v.stateLeaves.push(commitment);
      v.stateTree.append([commitment]);
      if (label !== undefined) {
        labels.push({ leaf: label, t: t.now });
        v.labelLeaves.push(label);
        v.labelTree.append([label]);
      }
    },
    rootAt: (before) => ({ state: trees(before).stateRoot, label: trees(before).labelRoot }),
    async bind(b) {
      binds.push(b);
      const n = (tries.get(b.wallet.address) ?? 0) + 1;
      tries.set(b.wallet.address, n);
      const fee = feeOf(b.epochStartMs);
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|${fee}|${b.deadlineMs}|${n}`);
      const context = BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P;
      return { context, feeCap: fee, request: { n } };
    },
  };
}

const open: ProofQueue<unknown>[] = [];
const provers3 = (): (VaultProver & { log: string[] })[] => [signalsProver(), signalsProver(), signalsProver()];
function queue<R>(v: Vault, pool: Pool<R>, provers: VaultProver[] = provers3(), hardwareConcurrency = 4, inFront?: () => boolean): ProofQueue<R> {
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool, provers, hardwareConcurrency, inFront });
  open.push(q as ProofQueue<unknown>);
  return q;
}
after(async () => {
  for (const q of open) await q.close();
});
const proves = (ps: (VaultProver & { log: string[] })[]): number => ps.reduce((a, p) => a + p.log.filter((x) => x === "prove withdraw").length, 0);
const jOf = (ref: NoteRef): number => (ref.kind === "change" ? ref.j + 1 : 0);
const W = (c: d.Chain, ref: NoteRef, label: bigint): string => {
  const w = d.freshWallet(SEED, c, label, jOf(ref));
  w.secretKey.fill(0);
  return w.address;
};
const state = async (v: Vault, id: string): Promise<NoteRecord> => (await v.ns.get(id))!;

/** The change note the spend of `parent` by `chunk` makes, landed now. */
async function landChange(v: Vault, pool: Fake, parent: NoteRecord, chunk: bigint): Promise<NoteRecord> {
  const label = parent.leaf!.label;
  const ref: NoteRef = { kind: "change", l: label, j: jOf(parent.ref) };
  const pre = noteSecrets(SEED, ref).precommitment;
  const value = parent.leaf!.value - chunk;
  const commitment = noteCommitment(value, label, pre);
  pool.land(commitment);
  return v.ns.add({ ref, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value, label, commitment, leafIndex: BigInt(v.stateLeaves.length - 1) } });
}
/** A new deposit note of `value`, landed now under a label of its own. */
async function landDeposit(v: Vault, pool: Fake, value: bigint, nonce: bigint): Promise<NoteRecord> {
  let n = await v.ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
  const label = vaultLabelOf(keccak_256, SCOPE, nonce);
  const commitment = noteCommitment(value, label, n.precommitment);
  n = await v.ns.move(n.id, "PLANNED", "INCOMING");
  pool.land(commitment, label);
  return v.ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment, leafIndex: BigInt(v.stateLeaves.length - 1) } });
}

test("one prover at a time; the ready set min(hardwareConcurrency - 1, 3), at least 1 (card signpage-prover-threads)", () => {
  const hs = [undefined, 0, 1, 2, 3, 4, 8, 16, 2.5];
  assert.deepEqual(hs.map((h) => proofPoolSize(h)), [1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(hs.map((h) => readySetSize(h)), [1, 1, 1, 1, 2, 3, 3, 3, 1]);
});

test("one thread budget: provers side by side x each prover's threads never exceed min(hardwareConcurrency - 1, 4)", () => {
  // the kit's prover worker (packages/kit/src/prover/worker.js): min(hardwareConcurrency - 1, 4) threads, one below 2
  const threadsOf = (h: number) => Math.max(1, Math.min(h - 1, 4));
  for (let h = 1; h <= 64; h++) assert.ok(proofPoolSize(h) * threadsOf(h) <= Math.max(1, Math.min(h - 1, 4)), `${h} cores`);
});

test("the ready set: up to the provers' count, largest chunk first, each its rung, its own W and refund note, the note HELD", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(1.5), usd(20)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  const pass = await q.refresh();
  assert.deepEqual(pass.failed, []);
  assert.equal(pass.made.length, 3);
  const ready = q.ready();
  assert.deepEqual(ready.map((r) => r.chunk), [usd(5), usd(10), usd(20)]); // leaf order; the $2 note waits its turn
  for (const r of ready) {
    const n = await state(v, r.noteId);
    assert.equal(n.state, "HELD");
    assert.equal(n.attempt, r.attempt);
    assert.equal(n.contexts!.at(-1)!.context, r.binding.context.toString()); // stored before its proof
    assert.equal(r.publicSignals[2], r.chunk.toString());
    assert.equal(r.publicSignals[7], r.binding.context.toString());
    assert.equal(r.publicSignals[1], noteSecrets(SEED, n.ref).nullifierHash.toString());
    // newCommitmentHash: the change note (l, j) of this spend, holding what is left
    const change = noteSecrets(SEED, { kind: "change", l: n.leaf!.label, j: 0 }).precommitment;
    assert.equal(r.publicSignals[0], noteCommitment(n.leaf!.value - r.chunk, n.leaf!.label, change).toString());
    assert.equal(r.wallet.address, W("sol", n.ref, n.leaf!.label));
    assert.equal(r.wallet.path, d.walletPath(SEED, "sol", n.leaf!.label, 0).path);
  }
  assert.equal(new Set(ready.map((r) => r.wallet.address)).size, 3, "no W serves two notes");
  for (const b of pool.binds) {
    assert.deepEqual(Object.keys(b).sort(), ["chunk", "deadlineMs", "epochStartMs", "refundPrecommitment", "wallet"]);
    assert.deepEqual(Object.keys(b.wallet).sort(), ["address", "publicKey"]);
  }
  // the $1.50 note covers no rung: never proved; a taken note makes room for the next largest
  const notes = await v.ns.list();
  assert.equal(notes.find((n) => n.leaf!.value === usd(1.5))!.state, "UNSPENT");
  await q.take(ready[2]!.noteId);
  assert.equal((await q.refresh()).made.length, 1);
  assert.deepEqual(q.ready().map((r) => r.chunk).sort(), [usd(10), usd(2), usd(5)].sort());
});

test("epochs: proofs made in two passes of one epoch share the epoch root, label root, deadline and fee, whatever the note", async () => {
  const v = await vaultWith([usd(2), usd(5), usd(10), usd(20)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  pool.land(999n); // another user's leaf, in this epoch
  await q.refresh();
  const first = q.ready();
  await q.take(first[2]!.noteId); // a tap; the next pass, later in the same epoch, proves the last note
  pool.t.now += 30_000n;
  pool.land(998n);
  assert.equal((await q.refresh()).made.length, 1);
  const all = [first[0]!, first[1]!, ...q.ready()];
  const epochRoot = pool.rootAt(START);
  assert.notEqual(epochRoot.state, v.stateTree.root, "the newest root moved on");
  for (const r of all) {
    assert.equal(r.root, "epoch");
    assert.equal(r.publicSignals[3], epochRoot.state.toString());
    assert.equal(r.publicSignals[5], epochRoot.label.toString());
    assert.equal(r.deadlineMs, START + L);
    assert.equal(r.binding.feeCap, feeOf(START));
    assert.equal((await state(v, r.noteId)).deadlineMs, START + L);
  }
});

test("at a new epoch the ready set is made again on the new epoch root and grid; the unsent context goes", async () => {
  const v = await vaultWith([usd(5)]);
  const pool = fakePool(v);
  const ps = provers3();
  const q = queue(v, pool, ps);
  await q.refresh();
  const [a] = q.ready();
  pool.t.now += E - 1_001n; // the epoch's last ms: nothing made again
  assert.deepEqual(await q.refresh(), { made: [], remade: [], failed: [] });
  pool.land(997n);
  pool.t.now += 1n; // the next epoch
  const pass = await q.refresh();
  assert.deepEqual(pass.remade, [a!.noteId]);
  const [b] = q.ready();
  assert.equal(b!.wallet.address, a!.wallet.address);
  assert.notEqual(b!.binding.context, a!.binding.context);
  assert.equal(b!.deadlineMs, START + E + L);
  assert.equal(b!.binding.feeCap, feeOf(START + E));
  assert.equal(b!.publicSignals[3], pool.rootAt(START + E).state.toString());
  const n = await state(v, a!.noteId);
  assert.equal(n.state, "HELD");
  assert.equal(n.attempt, b!.attempt);
  assert.equal(n.contexts!.length, 1, "the first attempt was never sent: its context was pruned");
  assert.equal(proves(ps), 2);
});

test("at a boundary the old proofs stay ready while the new ones are made: a tap 10 ms in takes the old one at once", async () => {
  const v = await vaultWith([usd(5), usd(10)]);
  const pool = fakePool(v);
  let gate: Promise<void> | undefined;
  let open_ = (): void => {};
  let entered = 0;
  const slow = provers3().map((sp): VaultProver => ({
    load: sp.load,
    prove: async (c, i) => {
      if (gate !== undefined) {
        entered++;
        await gate; // a prover slower than a tap
      }
      return sp.prove(c, i);
    },
  }));
  const q = queue(v, pool, slow);
  await q.refresh();
  const [x, y] = q.ready();
  const xBefore = await state(v, x!.noteId);
  gate = new Promise<void>((ok) => (open_ = ok));
  pool.t.now = START + E + 10n; // 10 ms after the boundary
  const pass = q.refresh();
  for (let k = 0; entered < 1 && k < 2_000; k++) await new Promise((ok) => setImmediate(ok));
  assert.equal(entered, 1, "one note is being made again: one prover at a time");
  assert.deepEqual(q.ready(), [x, y], "the ready set keeps the previous epoch's proofs during the remake");
  const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error("take waited for the prover")), 1_000).unref());
  const taken = await Promise.race([q.take(x!.noteId), timeout]);
  assert.equal(taken, x, "the previous epoch's proof, handed out while the new one is still being made");
  assert.equal(taken.epochStartMs, START);
  assert.equal((await state(v, x!.noteId)).state, "RESERVED");
  open_();
  const done = await pass;
  // the remake of the taken note finished after the take: dropped, never ready, its context never written
  assert.deepEqual(done.remade, [y!.noteId]);
  assert.deepEqual(done.failed.map((f) => f.noteId), [x!.noteId]);
  assert.match(done.failed[0]!.error, /never sent/);
  const xAfter = await state(v, x!.noteId);
  assert.equal(xAfter.attempt, x!.attempt);
  assert.deepEqual(xAfter.contexts, xBefore.contexts);
  // the other note: HELD throughout, its old attempt and context replaced in one write
  const [y2] = q.ready();
  assert.equal(y2!.noteId, y!.noteId);
  assert.equal(y2!.epochStartMs, START + E);
  const yAfter = await state(v, y!.noteId);
  assert.equal(yAfter.state, "HELD");
  assert.equal(yAfter.attempt, y2!.attempt);
  assert.notEqual(y2!.attempt, y!.attempt);
  assert.deepEqual(yAfter.contexts!.map((c) => c.context), [y2!.binding.context.toString()]);
  await assert.rejects(v.ns.move(y!.noteId, "HELD", "RESERVED", { attempt: y!.attempt }), /held by another attempt/, "the replaced proof can no longer be sent");
});

test("a deposit's own note is proved at once on the newest root, and on the epoch root at the next epoch", async () => {
  const v = await vaultWith([usd(2)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  pool.t.now += 10_000n;
  const dep = await landDeposit(v, pool, usd(50), 1000n);
  await q.refresh();
  const fresh = q.ready().find((r) => r.noteId === dep.id)!;
  assert.equal(fresh.root, "newest");
  assert.equal(fresh.publicSignals[3], v.stateTree.root!.toString());
  assert.equal(fresh.deadlineMs, START + L, "the epoch's grid all the same");
  assert.equal(q.ready().find((r) => r.noteId !== dep.id)!.root, "epoch");
  pool.t.now = START + E;
  await q.refresh();
  const again = q.ready().find((r) => r.noteId === dep.id)!;
  assert.equal(again.root, "epoch");
  assert.equal(again.publicSignals[3], pool.rootAt(START + E).state.toString());
});

test("a failed newest read fails only the deposit note waiting on it: the epoch's notes are still made, and the newest read asks newest (M355 (5))", async () => {
  const v = await vaultWith([usd(2), usd(5)]);
  const pool = fakePool(v);
  const asked: (boolean | undefined)[] = [];
  const epochTrees = pool.trees;
  pool.trees = async (before, signal, opts) => {
    asked.push(opts?.newest);
    if (opts?.newest) throw new Error("the newest read has not reached now");
    return epochTrees(before, signal);
  };
  const q = queue(v, pool);
  pool.t.now += 10_000n;
  const dep = await landDeposit(v, pool, usd(50), 1000n);
  const out = await q.refresh();
  assert.deepEqual(out.failed.map((f) => [f.noteId, f.error]), [[dep.id, "the newest read has not reached now"]]);
  assert.equal(out.made.length, 2, "the two epoch notes are made all the same");
  assert.ok(q.ready().every((r) => r.root === "epoch" && r.noteId !== dep.id));
  assert.deepEqual(asked, [undefined, true]);
  assert.equal((await state(v, dep.id)).state, "UNSPENT", "the deposit note is free for the next pass");
});

/** A note of `ref` (born PLANNED), landed now under a label of its own. */
async function landPlanned(v: Vault, pool: Fake, ref: NoteRef, value: bigint, nonce: bigint): Promise<NoteRecord> {
  const pre = noteSecrets(SEED, ref).precommitment;
  let n = await v.ns.add({ ref, scope: SCOPE, precommitment: pre, state: "PLANNED" });
  n = await v.ns.move(n.id, "PLANNED", "INCOMING");
  const label = vaultLabelOf(keccak_256, SCOPE, nonce);
  const commitment = noteCommitment(value, label, pre);
  pool.land(commitment, label);
  return v.ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment, leafIndex: BigInt(v.stateLeaves.length - 1) } });
}

test("only a deposit's own notes are proved at once: a return note and a return's second arrival wait for the boundary", async () => {
  const v = await vaultWith([usd(2)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  pool.t.now += 10_000n;
  const dep = await landDeposit(v, pool, usd(50), 1000n);
  const i = (dep.ref as Extract<NoteRef, { kind: "deposit" }>).i;
  const back = await landPlanned(v, pool, { kind: "return", c: "sol", l: 7n, j: 1 }, usd(20), 2000n); // a sell's money back
  const backSecond = await landPlanned(v, pool, { kind: "second", id: { id: "R", c: "sol", l: 7n, j: 1 }, n: 0 }, usd(10), 2001n);
  const depSecond = await landPlanned(v, pool, { kind: "second", id: { id: "U", s: SCOPE, i }, n: 0 }, usd(5), 1001n);
  await q.refresh();
  const ready = new Map(q.ready().map((r) => [r.noteId, r]));
  assert.equal(ready.get(dep.id)!.root, "newest");
  assert.equal(ready.get(depSecond.id)!.root, "newest", "a second arrival of a deposit from U is the deposit's own");
  assert.equal(ready.size, 3);
  for (const n of [back, backSecond]) {
    assert.ok(!ready.has(n.id), "a return's note never on the root right after its own leaf");
    assert.equal((await state(v, n.id)).state, "UNSPENT");
  }
  for (const n of [dep, depSecond]) await q.take(n.id);
  pool.t.now = START + E + 10n;
  const p = await q.refresh();
  assert.deepEqual(p.made.sort(), [back.id, backSecond.id].sort());
  for (const r of q.ready().filter((x) => p.made.includes(x.noteId))) {
    assert.equal(r.root, "epoch");
    assert.equal(r.publicSignals[3], pool.rootAt(START + E).state.toString());
  }
});

test("a newest-root proof is handed out in the next epoch only until its replacement, never past the boundary + 15 s", async () => {
  assert.equal(NEWEST_GRACE_MS, 15_000n);
  // its remake fails: refused 16 s into the next epoch, and its note freed
  const v = await vaultWith([usd(2)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  pool.t.now += 10_000n;
  const dep = await landDeposit(v, pool, usd(50), 1000n);
  await q.refresh();
  assert.equal(q.ready().find((r) => r.noteId === dep.id)!.root, "newest");
  const bind = pool.bind;
  pool.bind = async () => Promise.reject(new Error("fee read failed"));
  pool.t.now = START + E + 16_000n;
  const p = await q.refresh();
  pool.bind = bind;
  assert.ok(p.failed.some((f) => f.noteId === dep.id));
  await assert.rejects(q.take(dep.id), /newest root/);
  assert.equal((await state(v, dep.id)).state, "UNSPENT");
  // taken 5 s in while its remake runs: the newest-root proof, at once; the remake is dropped
  const v2 = await vaultWith([usd(2)]);
  const pool2 = fakePool(v2);
  let gate: Promise<void> | undefined;
  let open_ = (): void => {};
  let entered = 0;
  const slow = provers3().map((sp): VaultProver => ({
    load: sp.load,
    prove: async (c, i) => {
      if (gate !== undefined) {
        entered++;
        await gate;
      }
      return sp.prove(c, i);
    },
  }));
  const q2 = queue(v2, pool2, slow);
  pool2.t.now += 10_000n;
  const dep2 = await landDeposit(v2, pool2, usd(50), 1000n);
  await q2.refresh();
  gate = new Promise<void>((ok) => (open_ = ok));
  pool2.t.now = START + E + 5_000n;
  const pass = q2.refresh();
  for (let k = 0; entered < 1 && k < 2_000; k++) await new Promise((ok) => setImmediate(ok));
  assert.equal(entered, 1); // one prover at a time: the deposit's note, largest chunk, first
  const t = await q2.take(dep2.id);
  assert.equal(t.root, "newest");
  assert.equal(t.epochStartMs, START);
  open_();
  assert.deepEqual((await pass).failed.map((f) => f.noteId), [dep2.id]);
  assert.equal((await state(v2, dep2.id)).state, "RESERVED");
});

test("take refuses a proof with less than the send margin + 15 s before its deadline, at the boundary", async () => {
  assert.equal(TAKE_SLACK_MS, 15_000n);
  const v = await vaultWith([usd(5), usd(10)]);
  const tight = { ...fakePool(v), lifeMs: 2n * E + MARGIN }; // a pool with no slack of its own
  const q = queue(v, tight);
  await q.refresh();
  const [a, b] = q.ready();
  tight.t.now = START + tight.lifeMs - MARGIN - TAKE_SLACK_MS; // deadline - now = margin + 15 s
  assert.equal((await q.take(a!.noteId)).noteId, a!.noteId);
  tight.t.now += 1n;
  await assert.rejects(q.take(b!.noteId), /send margin/);
  assert.equal((await state(v, b!.noteId)).state, "UNSPENT");
  assert.deepEqual(q.ready(), [], "a refused proof is no longer listed");
});

test("close waits for a proof being made: when it resolves, that proof's note is free", async () => {
  const v = await vaultWith([usd(5)]);
  const pool = fakePool(v);
  let open_ = (): void => {};
  const gate = new Promise<void>((ok) => (open_ = ok));
  let entered = 0;
  const sp = signalsProver();
  const q = queue(v, pool, [{ load: sp.load, prove: async (c, i) => (entered++, await gate, sp.prove(c, i)) }]);
  const pass = q.refresh();
  for (let k = 0; entered < 1 && k < 2_000; k++) await new Promise((ok) => setImmediate(ok));
  assert.equal(entered, 1);
  const closing = q.close();
  open_();
  await closing;
  assert.equal((await v.ns.list())[0]!.state, "UNSPENT");
  assert.equal((await pass).failed.length, 1);
});

/** The note store, with `hook` run once right after a move (from, to) is queued on the store's lock. */
function hooked(v: Vault, from: string, to: string, hook: () => void): Vault["ns"] {
  const ns = v.ns;
  let armed = true;
  return {
    ...ns,
    move: async (...a: Parameters<typeof ns.move>) => {
      const fire = armed && a[1] === from && a[2] === to;
      if (fire) armed = false;
      const p = ns.move(...a);
      if (fire) hook();
      return p;
    },
  } as typeof ns;
}

test("a take, close or drop that arrives during the swap's HELD -> HELD write waits for it: never the old attempt", async () => {
  // take: gets the new proof; only its context stays
  {
    const v = await vaultWith([usd(5)]);
    const pool = fakePool(v);
    let q!: ProofQueue<unknown>;
    let tk: Promise<ReadyProof<unknown>> | undefined;
    q = openProofQueue({ seed64: SEED, notes: hooked(v, "HELD", "HELD", () => (tk = q.take(v.notes[0]!.id))), pool: pool as Pool<unknown>, provers: [signalsProver()], hardwareConcurrency: 2 });
    open.push(q);
    await q.refresh();
    const [a] = q.ready();
    pool.t.now = START + E + 10n;
    assert.deepEqual((await q.refresh()).remade, [a!.noteId]);
    const taken = await tk!;
    assert.equal(taken.epochStartMs, START + E);
    const n = await state(v, a!.noteId);
    assert.equal(n.state, "RESERVED");
    assert.equal(n.attempt, taken.attempt);
    assert.notEqual(n.attempt, a!.attempt);
    assert.deepEqual(n.contexts!.map((c) => c.context), [taken.binding.context.toString()]);
    assert.deepEqual(q.ready(), []);
  }
  // close: the new attempt is freed, both unsent contexts gone
  {
    const v = await vaultWith([usd(5)]);
    const pool = fakePool(v);
    let q!: ProofQueue<unknown>;
    let cl: Promise<void> | undefined;
    q = openProofQueue({ seed64: SEED, notes: hooked(v, "HELD", "HELD", () => (cl = q.close())), pool: pool as Pool<unknown>, provers: [signalsProver()], hardwareConcurrency: 2 });
    await q.refresh();
    pool.t.now = START + E + 10n;
    await q.refresh();
    await cl;
    const n = (await v.ns.list())[0]!;
    assert.equal(n.state, "UNSPENT");
    assert.equal(n.contexts, undefined);
    assert.deepEqual(q.ready(), []);
  }
  // drop: the note ends UNSPENT, nothing ready
  {
    const v = await vaultWith([usd(5)]);
    const pool = fakePool(v);
    let q!: ProofQueue<unknown>;
    let dr: Promise<void> | undefined;
    q = openProofQueue({ seed64: SEED, notes: hooked(v, "HELD", "HELD", () => (dr = q.drop(v.notes[0]!.id))), pool: pool as Pool<unknown>, provers: [signalsProver()], hardwareConcurrency: 2 });
    open.push(q);
    await q.refresh();
    pool.t.now = START + E + 10n;
    await q.refresh();
    await dr;
    assert.equal((await v.ns.list())[0]!.state, "UNSPENT");
    assert.deepEqual(q.ready(), []);
  }
});

test("a full ready set (3 of 3) is made again at the boundary, on the epoch root even when a leaf landed after it", async () => {
  const v = await vaultWith([usd(2), usd(5), usd(10)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  assert.equal((await q.refresh()).made.length, 3);
  pool.t.now = START + E + 5n;
  await landDeposit(v, pool, usd(1), 4242n); // someone's leaf, after the boundary (below the ladder: never proved)
  pool.t.now = START + E + 10n;
  const p = await q.refresh();
  assert.equal(p.remade.length, 3);
  for (const r of q.ready()) {
    assert.equal(r.epochStartMs, START + E);
    assert.equal(r.root, "epoch");
    assert.equal(r.publicSignals[3], pool.rootAt(START + E).state.toString());
    assert.notEqual(r.publicSignals[3], v.stateTree.root!.toString());
  }
});

test("store: HELD -> HELD and a free drop the last context (the unsent one), never a sent attempt's before it", async () => {
  const v = await vaultWith([usd(5)]);
  const id = v.notes[0]!.id;
  const ns = v.ns;
  let n = await ns.move(id, "UNSPENT", "HELD", { deadlineMs: 1000n, context: "11" });
  n = await ns.move(id, "HELD", "RESERVED", { attempt: n.attempt! });
  n = await ns.move(id, "RESERVED", "UNSPENT", { blockTimeMs: 1001n });
  n = await ns.move(id, "UNSPENT", "HELD", { deadlineMs: 2000n, context: "22" });
  n = await ns.move(id, "HELD", "HELD", { attempt: n.attempt!, deadlineMs: 3000n, context: "33" });
  assert.deepEqual(n.contexts!.map((c) => c.context), ["11", "33"]);
  n = await ns.move(id, "HELD", "UNSPENT", { attempt: n.attempt! });
  assert.deepEqual(n.contexts!.map((c) => c.context), ["11"]);
});

test("a drop whose write fails is tried again at the next pass", async () => {
  const v = await vaultWith([usd(5)]);
  const pool = fakePool(v);
  let fail = true;
  const ns = v.ns;
  const notes = {
    ...ns,
    move: async (...a: Parameters<typeof ns.move>) => {
      if (fail && a[1] === "HELD" && a[2] === "UNSPENT") {
        fail = false;
        throw new Error("store write failed");
      }
      return ns.move(...a);
    },
  } as typeof ns;
  const q = openProofQueue({ seed64: SEED, notes, pool: pool as Pool<unknown>, provers: [signalsProver()], hardwareConcurrency: 2 });
  open.push(q);
  await q.refresh();
  const [a] = q.ready();
  await q.drop(a!.noteId);
  assert.equal((await state(v, a!.noteId)).attempt, a!.attempt, "the failed write left it HELD");
  await q.refresh();
  const n = await state(v, a!.noteId);
  assert.ok(!(n.state === "HELD" && n.attempt === a!.attempt), "the dropped attempt was freed at the next pass");
});

test("a change note that landed in this epoch waits for the next one; then its own W (j + 1) and refund note (l, j + 1)", async () => {
  const v = await vaultWith([usd(25)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  await q.refresh();
  const [top] = q.ready();
  assert.equal(top!.chunk, usd(20));
  await q.take(top!.noteId);
  const c0 = await landChange(v, pool, await state(v, top!.noteId), top!.chunk); // change (l, 0), $5
  assert.equal((await state(v, top!.noteId)).state, "SPENT");
  assert.deepEqual((await q.refresh()).made, [], "a change note waits for the next epoch");
  pool.t.now = START + E;
  assert.deepEqual((await q.refresh()).made, [c0.id]);
  const [next] = q.ready();
  assert.equal(next!.chunk, usd(5));
  assert.equal(next!.wallet.j, 1);
  assert.equal(next!.wallet.address, W("sol", c0.ref, c0.leaf!.label));
  assert.notEqual(next!.wallet.address, top!.wallet.address, "the change note's W is not its parent's");
  const label = c0.leaf!.label;
  assert.equal(pool.binds.at(-1)!.refundPrecommitment, noteSecrets(SEED, { kind: "refund", l: label, j: 1 }).precommitment);
  assert.equal(next!.publicSignals[0], noteCommitment(0n, label, noteSecrets(SEED, { kind: "change", l: label, j: 1 }).precommitment).toString());
});

test("take refuses a proof made before the previous epoch and frees its note; the next pass makes it again", async () => {
  const v = await vaultWith([usd(5), usd(10)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  await q.refresh();
  const [a, b] = q.ready();
  pool.t.now = START + E + 59_000n; // the next epoch, before any pass: still taken
  await q.take(a!.noteId);
  assert.equal((await state(v, a!.noteId)).state, "RESERVED");
  pool.t.now = START + 2n * E; // two epochs on (the phone slept)
  await assert.rejects(q.take(b!.noteId), /before the previous epoch/);
  assert.equal((await state(v, b!.noteId)).state, "UNSPENT");
  assert.deepEqual((await q.refresh()).made, [b!.noteId]);
});

test("never two proofs for one note: two queues on one store prove each note once", async () => {
  const v = await vaultWith([usd(2), usd(5), usd(10)]);
  const [p1, p2] = [provers3(), provers3()];
  const q1 = queue(v, fakePool(v), p1);
  const q2 = queue(v, fakePool(v), p2);
  await Promise.all([q1.refresh(), q2.refresh()]);
  const all = [...q1.ready(), ...q2.ready()];
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map((r) => r.noteId)).size, 3);
  assert.equal(proves(p1) + proves(p2), 3);
  // and a second pass of either proves nothing more
  await Promise.all([q1.refresh(), q2.refresh()]);
  assert.equal(proves(p1) + proves(p2), 3);
});

test("take with the attempt a transaction was built on: refused before any write once a remake swapped it, the note HELD", async () => {
  const v = await vaultWith([usd(5), usd(10)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  await q.refresh();
  const [x] = q.ready();
  pool.t.now = START + E + 10n; // the next epoch: the ready set is made again
  await q.refresh();
  const x2 = q.ready().find((r) => r.noteId === x!.noteId)!;
  assert.notEqual(x2.attempt, x!.attempt, "a remake swapped the note's proof");
  await assert.rejects(q.take(x!.noteId, x!.attempt), /another attempt/);
  const held = await state(v, x!.noteId);
  assert.equal(held.state, "HELD", "never RESERVED for bytes no one sends");
  assert.equal(held.attempt, x2.attempt);
  assert.equal(q.ready().find((r) => r.noteId === x!.noteId), x2, "the new proof stays ready");
  assert.equal((await q.take(x!.noteId, x2.attempt)).attempt, x2.attempt);
  assert.equal((await state(v, x!.noteId)).state, "RESERVED");
});

test("HELD until sent or dropped: take writes RESERVED before handing out; drop frees; a failed proof frees", async () => {
  const v = await vaultWith([usd(2), usd(5), usd(10)]);
  const q = queue(v, fakePool(v));
  await q.refresh();
  const [a, b, c] = q.ready();
  const sent = await q.take(a!.noteId);
  assert.equal(sent.noteId, a!.noteId);
  assert.equal((await state(v, a!.noteId)).state, "RESERVED");
  await assert.rejects(q.take(a!.noteId), /no ready proof/);
  await q.drop(b!.noteId);
  assert.equal((await state(v, b!.noteId)).state, "UNSPENT");
  assert.equal((await state(v, c!.noteId)).state, "HELD");
  assert.deepEqual(q.ready().map((r) => r.noteId), [c!.noteId]);
  v.failPut.on = (rec) => (rec as { state?: string }).state === "RESERVED";
  await assert.rejects(q.take(c!.noteId), /refused the write/);
  v.failPut.on = undefined;
  assert.equal((await state(v, c!.noteId)).state, "UNSPENT");
  const v2 = await vaultWith([usd(2)]);
  const broken: VaultProver = { load: async () => {}, prove: async () => Promise.reject(new Error("worker died")) };
  const q2 = queue(v2, fakePool(v2), [broken]);
  const pass = await q2.refresh();
  assert.match(pass.failed[0]!.error, /worker died/);
  assert.equal((await v2.ns.list())[0]!.state, "UNSPENT");
  assert.deepEqual(q2.ready(), []);
});

test("a free whose write fails is tried again at the next pass; one failed free does not stop the pass", async () => {
  // a failed proof whose free fails
  const v = await vaultWith([usd(5)]);
  const pool = fakePool(v);
  let fail = true;
  const sp = signalsProver();
  const flaky: VaultProver = { load: sp.load, prove: async (c, i) => (fail ? Promise.reject(new Error("worker died")) : sp.prove(c, i)) };
  const q = queue(v, pool, [flaky]);
  v.failPut.on = (rec) => (rec as { state?: string }).state === "UNSPENT";
  assert.match((await q.refresh()).failed[0]!.error, /worker died/);
  v.failPut.on = undefined;
  fail = false;
  assert.equal((await v.ns.list())[0]!.state, "HELD");
  assert.equal((await q.refresh()).made.length, 1, "freed, then proved");
  // at a new epoch one note's swap write fails: its old proof stays ready (HELD, its attempt), the other is made
  // again, and it follows at the next pass
  const v2 = await vaultWith([usd(5), usd(10)]);
  const pool2 = fakePool(v2);
  const q2 = queue(v2, pool2);
  await q2.refresh();
  const [x, y] = q2.ready();
  pool2.t.now = START + E;
  let once = true;
  v2.failPut.on = (rec) => {
    const r = rec as { id?: string; state?: string };
    if (once && r.id === x!.noteId && r.state === "HELD") return !(once = false);
    return false;
  };
  const pass = await q2.refresh();
  v2.failPut.on = undefined;
  assert.equal(pass.failed.length, 1);
  assert.equal(pass.failed[0]!.noteId, x!.noteId);
  assert.deepEqual(pass.remade, [y!.noteId]);
  assert.equal((await state(v2, x!.noteId)).attempt, x!.attempt, "the old proof still holds its note");
  assert.equal(q2.ready().find((r) => r.noteId === x!.noteId), x, "and is still ready");
  const later = await q2.refresh();
  assert.deepEqual(later.remade, [x!.noteId]);
  assert.deepEqual(q2.ready().map((r) => r.epochStartMs), [START + E, START + E]);
});

test("a proof dropped while it is made is not kept, and its note is freed", async () => {
  const v = await vaultWith([usd(2)]);
  let release = (): void => {};
  const inner = signalsProver();
  const slow: VaultProver = { load: inner.load, prove: async (c, i) => (await new Promise<void>((r) => (release = r)), inner.prove(c, i)) };
  const q = queue(v, fakePool(v), [slow]);
  const running = q.refresh();
  for (let k = 0; (await v.ns.list())[0]!.state !== "HELD"; k++) {
    assert.ok(k < 2_000, "the note is HELD before its proof starts");
    await new Promise((r) => setTimeout(r, 1));
  }
  await q.drop(v.notes[0]!.id);
  release();
  const pass = await running;
  assert.match(pass.failed[0]!.error, /dropped/);
  assert.deepEqual(q.ready(), []);
  assert.equal((await v.ns.list())[0]!.state, "UNSPENT");
});

test("a ready proof whose note the store moved is let go: spent by another device, or freed and held by another tab", async () => {
  const v = await vaultWith([usd(2), usd(5)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  await q.refresh();
  const [a, b] = q.ready();
  await v.ns.move(a!.noteId, "HELD", "SPENT"); // the sync saw another device's spend
  // another tab frees b past its deadline less the 30 s send margin, and holds it under its own attempt
  await v.ns.move(b!.noteId, "HELD", "UNSPENT", { blockTimeMs: b!.deadlineMs - 29_999n });
  const other = await v.ns.move(b!.noteId, "UNSPENT", "HELD", { deadlineMs: b!.deadlineMs, context: "77" });
  const pass = await q.refresh();
  assert.deepEqual(pass, { made: [], remade: [], failed: [] });
  assert.deepEqual(q.ready(), []);
  await assert.rejects(q.take(a!.noteId), /no ready proof/);
  assert.equal((await state(v, b!.noteId)).attempt, other.attempt, "the other tab's hold is untouched");
});

test("close frees every ready note before it zeroes the seed; a close during a HELD write proves nothing", async () => {
  const v = await vaultWith([usd(2), usd(5)]);
  const pool = fakePool(v);
  const q1 = queue(v, pool);
  assert.equal((await q1.refresh()).made.length, 2);
  await q1.close();
  assert.deepEqual((await v.ns.list()).map((n) => n.state), ["UNSPENT", "UNSPENT"]);
  await assert.rejects(q1.refresh(), /closed/);
  const q2 = queue(v, pool);
  assert.equal((await q2.refresh()).made.length, 2, "a new queue proves them");
  await q2.close();
  // the queue closes while the store writes HELD
  const v2 = await vaultWith([usd(5)]);
  const ns = v2.ns;
  let q3: ProofQueue<unknown> | undefined;
  const notes = { ...ns, move: async (...a: Parameters<typeof ns.move>) => (a[2] === "HELD" && void q3!.close(), ns.move(...a)) } as typeof ns;
  const prover = signalsProver();
  q3 = openProofQueue({ seed64: SEED, notes, pool: fakePool(v2) as Pool<unknown>, provers: [prover], hardwareConcurrency: 2 });
  const pass = await q3.refresh();
  assert.match(pass.failed[0]!.error, /closed/);
  assert.equal(prover.log.length, 0, "nothing posted to the prover");
  assert.equal((await ns.list())[0]!.state, "UNSPENT");
});

test("in the background a pass does nothing", async () => {
  const v = await vaultWith([usd(5)]);
  const ps = provers3();
  let front = false;
  const q = queue(v, fakePool(v), ps, 4, () => front);
  assert.deepEqual(await q.refresh(), { made: [], remade: [], failed: [] });
  assert.equal(proves(ps), 0);
  front = true;
  assert.equal((await q.refresh()).made.length, 1);
});

test("one proof at a time, whatever the cores; each pass makes a ready set of min(hardwareConcurrency - 1, 3); the same proofs either way", async () => {
  const values = [usd(2), usd(5), usd(10), usd(20), usd(50), usd(100)];
  const run = async (hwc: number) => {
    const v = await vaultWith(values);
    let active = 0, peak = 0, done = 0, entered = 0;
    const want = proofPoolSize(hwc);
    const provers = [0, 1, 2, 3].map(() => {
      const inner = signalsProver();
      const p: VaultProver = {
        load: inner.load,
        async prove(c, i) {
          peak = Math.max(peak, ++active);
          entered++;
          // a barrier: wait until every lane this round runs is proving (the pool's size, or the notes left), so the
          // peak is the pool's size at any machine load, not a race against the store's writes
          const round = Math.min(want, values.length - done);
          const until = done + round; // every proof of this round has entered
          for (let k = 0; entered < until && k < 10_000; k++) await new Promise((r) => setTimeout(r, 1));
          const out = await inner.prove(c, i);
          active--;
          done++;
          return out;
        },
      };
      return p;
    });
    const pool = fakePool(v);
    const q = queue(v, pool, provers, hwc);
    const made: string[] = [];
    const rounds: number[] = [];
    // take each ready set until every note is proved, so each run makes the same six proofs
    for (let k = 0; made.length < 6 && k < 6; k++) {
      const m = (await q.refresh()).made;
      rounds.push(m.length);
      made.push(...m);
      for (const r of q.ready()) await q.take(r.noteId);
    }
    const notes = await v.ns.list();
    const shape = pool.binds
      .map((b) => ({ chunk: b.chunk, w: b.wallet.address, deadline: b.deadlineMs, label: notes.find((n) => W("sol", n.ref, n.leaf!.label) === b.wallet.address)?.leaf!.label }))
      .sort((x, y) => (x.chunk < y.chunk ? -1 : 1));
    return { peak, made: made.length, rounds, shape };
  };
  const one = await run(2), two = await run(3), three = await run(8);
  assert.deepEqual([one.peak, two.peak, three.peak], [1, 1, 1]); // one prover at a time, on its own threads
  assert.deepEqual([one.made, two.made, three.made], [6, 6, 6]);
  // each pass proves one ready set: the pool's size, never every prover handed in
  assert.deepEqual([one.rounds, two.rounds, three.rounds], [[1, 1, 1, 1, 1, 1], [2, 2, 2], [3, 3]]);
  assert.deepEqual(two.shape, one.shape);
  assert.deepEqual(three.shape, one.shape);
});

test("a binding the queue cannot hold a note under is refused before the note is HELD", async () => {
  const cases: [string, (b: Awaited<ReturnType<Fake["bind"]>>) => object, RegExp][] = [
    ["context at p", (b) => ({ ...b, context: VAULT_FIELD_P }), /context is not a field element/],
    ["fee cap at the chunk", (b) => ({ ...b, feeCap: usd(2) }), /fee cap/],
  ];
  for (const [what, edit, err] of cases) {
    const v = await vaultWith([usd(2)]);
    const pool = fakePool(v);
    const bind = pool.bind.bind(pool);
    pool.bind = async (a) => edit(await bind(a)) as Awaited<ReturnType<Fake["bind"]>>;
    const pass = await queue(v, pool).refresh();
    assert.match(pass.failed[0]?.error ?? "", err, what);
    assert.equal((await v.ns.list())[0]!.state, "UNSPENT", what);
  }
});

test("a pool whose fixed fields are not what the queue relies on is refused when the queue opens", async () => {
  const v = await vaultWith([usd(2)]);
  const good = fakePool(v);
  const cases: [string, object, RegExp][] = [
    ["no id", { id: "" }, /no id/],
    ["unknown chain", { chain: "btc" }, /unknown chain/],
    ["scope at p", { scope: VAULT_FIELD_P }, /scope is not a field element/],
    ["no epoch", { epochMs: 0n }, /epochMs is a bigint above 0/],
    ["no send margin", { sendMarginMs: 0n }, /sendMarginMs is a bigint above 0/],
    ["a life too short to send in the next epoch", { lifeMs: 2n * E + MARGIN - 1n }, /lifeMs is below 2 epochs/],
    ["an epoch no longer than the take slack", { epochMs: 15_000n }, /epochMs is at most the take slack/],
    ["no context function", { bind: undefined }, /bind is not a function/],
    ["no tree source", { trees: undefined }, /trees is not a function/],
    ["no time", { now: undefined }, /now is not a function/],
    ["ladder off the rungs", { ladder: { one: 1_000_000n, min: 3_000_000n } }, /min is not a rung/],
  ];
  for (const [what, over, err] of cases) assert.throws(() => queue(v, { ...good, ...over } as Fake), err, what);
  assert.throws(() => queue(v, good, []), /provers: at least one/);
});

test("a pool at checkPool's floor (L = 2E + margin) always lets take() hand a proof out: an epoch of 5 s is refused, 15.001 s works", async () => {
  const v = await vaultWith([usd(5)]);
  const short = { ...fakePool(v), epochMs: 5_000n, lifeMs: 2n * 5_000n + MARGIN }; // every take would be refused
  assert.throws(() => queue(v, short), /epochMs is at most the take slack/);
  const e = TAKE_SLACK_MS + 1n;
  const floor = { ...fakePool(v), epochMs: e, lifeMs: 2n * e + MARGIN };
  floor.t.now = START + 1n; // START is a multiple of 60 s, not of e: the queue's epoch is START - START % e
  const q = queue(v, floor);
  await q.refresh();
  const [r] = q.ready();
  assert.equal((await q.take(r!.noteId)).noteId, r!.noteId);
});

test("another pool's notes are not this pool's: the queue proves only notes of its scope", async () => {
  const v = await vaultWith([usd(2), usd(5)]);
  const q = queue(v, { ...fakePool(v), scope: SCOPE + 1n });
  assert.deepEqual((await q.refresh()).made, []);
});

// ---------- the NEAR vault as the first pool ----------
function nearPool(v: Vault, relayFee = 300_000n, feesAsked: bigint[] = []) {
  return nearVaultPool({
    vaultId: VAULT,
    token: TOKEN,
    network: "mainnet",
    rpcs: feeReplay("mainnet"),
    priceRpcs: feeReplay("mainnet"),
    feeRecipient: FEE_RECIPIENT,
    relayFee: async (e) => (feesAsked.push(e), relayFee),
    registerDepositOf: async () => REGISTER_DEPOSIT,
    blockTimestampNanosec: async () => BLOCK_NS,
    trees: async () => ({ stateTree: v.stateTree, labelTree: v.labelTree, stateRoot: v.stateTree.root!, labelRoot: v.labelTree.root! }),
  });
}

test("NEAR vault: epochs of 60 s and a life of 270 s (2E + the relayer's 120 s margin + 30 s of slack), inside the 10 minute cap", () => {
  assert.equal(NEAR_EPOCH_MS, 60_000n);
  assert.equal(NEAR_LIFE_MS, 270_000n);
});

test("NEAR vault: each proof's context is the one the vault recomputes, paying W_{near, l, j}, on the epoch's grid and fee", async () => {
  const v = await vaultWith([usd(2), usd(5), usd(10)]);
  const asked: bigint[] = [];
  const pool = nearPool(v, 300_000n, asked);
  assert.equal(pool.scope, SCOPE);
  const q = queue(v, pool);
  const pass = await q.refresh();
  assert.deepEqual(pass.failed, []);
  const start = BigInt(BLOCK_MS) - (BigInt(BLOCK_MS) % NEAR_EPOCH_MS);
  assert.deepEqual(asked, [start, start, start]);
  for (const r of q.ready()) {
    const w: VaultWithdrawal = r.binding.request;
    assert.equal(vaultContextOf(keccak_256, vaultContextInput(VAULT, w), SCOPE), r.binding.context);
    assert.equal(r.publicSignals[7], r.binding.context.toString());
    const n = await state(v, r.noteId);
    assert.equal(w.recipient, W("near", n.ref, n.leaf!.label));
    assert.equal(w.relay_fee, "300000");
    assert.equal(w.fee_recipient, FEE_RECIPIENT);
    assert.equal(w.refund_precommitment, noteSecrets(SEED, { kind: "refund", l: n.leaf!.label, j: jOf(n.ref) }).precommitment.toString());
    assert.equal(BigInt(w.deadline_ms), start + NEAR_LIFE_MS);
  }
});

test("NEAR vault: a change note with j >= 1 binds refund note (l, j + 1) and pays W_{near, l, j + 1}", async () => {
  const v = await vaultWith([usd(25)]);
  const pool = nearPool(v);
  const q = queue(v, pool);
  await q.refresh();
  const [top] = q.ready();
  await q.take(top!.noteId);
  const parent = await state(v, top!.noteId);
  const label = parent.leaf!.label;
  const ref: NoteRef = { kind: "change", l: label, j: 0 };
  const pre = noteSecrets(SEED, ref).precommitment;
  const commitment = noteCommitment(usd(5), label, pre);
  v.stateTree.append([commitment]);
  await v.ns.add({ ref, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value: usd(5), label, commitment, leafIndex: BigInt(v.stateTree.size - 1) } });
  await q.refresh();
  const [next] = q.ready();
  const w: VaultWithdrawal = next!.binding.request;
  assert.equal(next!.wallet.j, 1);
  assert.equal(w.recipient, W("near", ref, label));
  assert.equal(w.refund_precommitment, noteSecrets(SEED, { kind: "refund", l: label, j: 1 }).precommitment.toString());
  assert.notEqual(w.refund_precommitment, noteSecrets(SEED, { kind: "refund", l: label, j: 0 }).precommitment.toString());
});

test("NEAR vault: a fee above fee_max or at the chunk, a W not its key's id, a deadline off the grid are refused before any proof", async () => {
  const v = await vaultWith([usd(2)]);
  const prover = signalsProver();
  const pass = await queue(v, nearPool(v, FEE_MAX + 1n), [prover]).refresh();
  assert.match(pass.failed[0]!.error, /above the device's fee_max/);
  const v2 = await vaultWith([usd(2)]);
  const pass2 = await queue(v2, nearPool(v2, usd(2)), [prover]).refresh();
  assert.match(pass2.failed[0]!.error, /at or above the chunk/);
  assert.equal(prover.log.filter((x) => x === "prove withdraw").length, 0);
  const w = d.freshWallet(SEED, "near", 5n, 0);
  w.secretKey.fill(0);
  const start = BigInt(BLOCK_MS) - (BigInt(BLOCK_MS) % NEAR_EPOCH_MS);
  const good = { chunk: usd(2), wallet: { address: w.address, publicKey: w.publicKey }, refundPrecommitment: 1n, epochStartMs: start, deadlineMs: start + NEAR_LIFE_MS };
  await nearPool(v).bind(good);
  const w1 = d.freshWallet(SEED, "near", 5n, 1);
  w1.secretKey.fill(0);
  await assert.rejects(nearPool(v).bind({ ...good, wallet: { address: w1.address, publicKey: w.publicKey } }), /64-hex id of its ed25519 public key/);
  await assert.rejects(nearPool(v).bind({ ...good, deadlineMs: good.deadlineMs + 1n }), /not on the epoch grid/);
  await assert.rejects(nearPool(v).bind({ ...good, epochStartMs: start - 4n * NEAR_EPOCH_MS, deadlineMs: start }), /too close to send/);
});

// Card signpage-pool-withdraw-form, review #232b MEDIUM 1: a note a withdraw still owes an onward send for is left
// alone by the queue (its W is every spend's W), read again each pass.
test("skip: a note the page's withdraw still owes a send for is never proved nor held; once settled, it is", async () => {
  const v = await vaultWith([usd(10), usd(20)]);
  const pool = fakePool(v);
  const ids = (await v.ns.list()).map((n) => n.id);
  let owed = new Set([ids[1]!]);
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool, provers: provers3(), hardwareConcurrency: 4, skip: async () => owed });
  open.push(q as ProofQueue<unknown>);
  await q.refresh();
  assert.deepEqual(q.ready().map((r) => r.noteId), [ids[0]]);
  assert.equal((await state(v, ids[1]!)).state, "UNSPENT");
  owed = new Set();
  await q.refresh();
  assert.deepEqual(q.ready().map((r) => r.noteId).sort(), [...ids].sort());
});
