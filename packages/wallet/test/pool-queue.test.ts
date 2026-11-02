// node --test packages/wallet/test/pool-queue.test.ts: the proof queue and the NEAR vault as its first pool (card
// wallet-pool-ladder, src/pool/queue.ts and src/pool/near.ts). The notes are withdraw-fixture.ts's: the all-zero test
// seed's deposit notes on a fixture vault, test values only, never money. The prover answers the signals Withdraw(32)
// gives without proving (signalsProver); the kit's real proof of a pool's context is prove-e2e.test.ts's.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VAULT_FIELD_P, vaultContextInput, vaultContextOf, type VaultProver, type VaultWithdrawal } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { USDC_LADDER, nearVaultPool } from "../src/pool/near.ts";
import type { Pool, PoolBindArgs } from "../src/pool/pool.ts";
import { openProofQueue, proofPoolSize, type ProofQueue } from "../src/pool/queue.ts";
import {
  BLOCK_MS, BLOCK_NS, closeVaults, FEE_MAX, FEE_RECIPIENT, feeReplay, REGISTER_DEPOSIT, SCOPE, SEED, signalsProver, TOKEN, VAULT, vaultWith, type Vault,
} from "./withdraw-fixture.ts";

after(closeVaults);
const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
const MARGIN = 120_000n;
const FEE = 100_000n;

type Fake = Pool<{ n: number }> & { binds: PoolBindArgs[]; t: { now: bigint } };
/** A pool on the fixture vault whose context hashes W, the chunk, the fee cap, the deadline and the attempt's number. */
function fakePool(v: Vault): Fake {
  const t = { now: BigInt(BLOCK_MS) };
  const binds: PoolBindArgs[] = [];
  const tries = new Map<string, number>();
  return {
    id: "test:pool",
    chain: "sol",
    scope: SCOPE,
    ladder: USDC_LADDER,
    remakeMarginMs: MARGIN,
    binds,
    t,
    now: async () => t.now,
    trees: async () => ({ stateTree: v.stateTree, labelTree: v.labelTree, stateRoot: v.stateTree.root!, labelRoot: v.labelTree.root! }),
    async bind(b) {
      binds.push(b);
      const n = (tries.get(b.wallet.address) ?? 0) + 1;
      tries.set(b.wallet.address, n);
      const deadlineMs = t.now + 600_000n;
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|${FEE}|${deadlineMs}|${n}`);
      const context = BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P;
      return { context, deadlineMs, feeCap: FEE, request: { n } };
    },
  };
}

const open: ProofQueue<unknown>[] = [];
function queue<R>(v: Vault, pool: Pool<R>, provers: VaultProver[] = [signalsProver()], hardwareConcurrency = 4): ProofQueue<R> {
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool, provers, hardwareConcurrency });
  open.push(q as ProofQueue<unknown>);
  return q;
}
after(() => open.forEach((q) => q.close()));
const proves = (p: VaultProver & { log: string[] }): number => p.log.filter((x) => x === "prove withdraw").length;
const W = (c: d.Chain, ref: NoteRef, label: bigint): string => {
  const j = ref.kind === "change" ? ref.j + 1 : 0;
  const w = d.freshWallet(SEED, c, label, j);
  w.secretKey.fill(0);
  return w.address;
};

test("pool size: min(hardwareConcurrency - 1, 3), at least 1", () => {
  assert.deepEqual([undefined, 0, 1, 2, 3, 4, 8, 16, 2.5].map((h) => proofPoolSize(h)), [1, 1, 1, 1, 2, 3, 3, 3, 1]);
});

test("one ready proof per UNSPENT note that covers a rung: its rung, its own W, its pool's context; the note HELD", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(1.5)]);
  const pool = fakePool(v);
  const prover = signalsProver();
  const q = queue(v, pool, [prover]);
  const pass = await q.refresh();
  assert.deepEqual(pass.failed, []);
  assert.equal(pass.made.length, 3);
  const ready = q.ready();
  assert.deepEqual(ready.map((r) => r.chunk), [usd(2), usd(5), usd(10)]);
  for (const r of ready) {
    const n = (await v.ns.get(r.noteId))!;
    assert.equal(n.state, "HELD");
    assert.equal(n.attempt, r.attempt);
    assert.equal(n.contexts!.at(-1)!.context, r.binding.context.toString()); // stored before its proof
    assert.equal(r.publicSignals[2], r.chunk.toString());
    assert.equal(r.publicSignals[7], r.binding.context.toString());
    assert.equal(r.publicSignals[1], noteSecrets(SEED, n.ref).nullifierHash.toString());
    assert.equal(r.wallet.address, W("sol", n.ref, n.leaf!.label));
    assert.equal(r.wallet.path, d.walletPath(SEED, "sol", n.leaf!.label, 0).path);
  }
  assert.equal(new Set(ready.map((r) => r.wallet.address)).size, 3, "no W serves two notes");
  // the $1.50 note covers no rung: no proof, still UNSPENT
  const small = (await v.ns.list()).find((n) => n.leaf!.value === usd(1.5))!;
  assert.equal(small.state, "UNSPENT");
  // the pool was handed W's public key and address, and the refund note's precommitment, never a secret key
  for (const b of pool.binds) {
    assert.deepEqual(Object.keys(b).sort(), ["chunk", "refundPrecommitment", "wallet"]);
    assert.deepEqual(Object.keys(b.wallet).sort(), ["address", "publicKey"]);
  }
});

test("a proof is not made again before its deadline nears: a second pass proves nothing", async () => {
  const v = await vaultWith([usd(2), usd(5)]);
  const pool = fakePool(v);
  const prover = signalsProver();
  const q = queue(v, pool, [prover]);
  await q.refresh();
  pool.t.now += 600_000n - MARGIN - 1n; // one ms before the remake time
  const again = await q.refresh();
  assert.deepEqual(again, { made: [], remade: [], failed: [] });
  assert.equal(proves(prover), 2);
});

test("made again when its deadline nears: the same note and W, a new context, the note still HELD", async () => {
  const v = await vaultWith([usd(5)]);
  const pool = fakePool(v);
  const prover = signalsProver();
  const q = queue(v, pool, [prover]);
  await q.refresh();
  const [first] = q.ready();
  pool.t.now += 600_000n - MARGIN; // deadline less the margin
  const pass = await q.refresh();
  assert.deepEqual(pass.remade, [first!.noteId]);
  const [second] = q.ready();
  assert.equal(second!.noteId, first!.noteId);
  assert.equal(second!.wallet.address, first!.wallet.address);
  assert.notEqual(second!.binding.context, first!.binding.context);
  const n = (await v.ns.get(first!.noteId))!;
  assert.equal(n.state, "HELD");
  assert.equal(n.attempt, second!.attempt);
  assert.equal(n.contexts!.length, 2);
  assert.equal(proves(prover), 2);
});

test("never two proofs for one note: two queues on one store prove each note once", async () => {
  const v = await vaultWith([usd(2), usd(5), usd(10)]);
  const [p1, p2] = [signalsProver(), signalsProver()];
  const q1 = queue(v, fakePool(v), [p1]);
  const q2 = queue(v, fakePool(v), [p2]);
  await Promise.all([q1.refresh(), q2.refresh()]);
  const all = [...q1.ready(), ...q2.ready()];
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map((r) => r.noteId)).size, 3);
  assert.equal(proves(p1) + proves(p2), 3);
});

test("HELD until sent or dropped: take writes RESERVED before handing out; drop frees; a failed proof frees", async () => {
  const v = await vaultWith([usd(2), usd(5), usd(10)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  await q.refresh();
  const [a, b, c] = q.ready();
  const sent = await q.take(a!.noteId);
  assert.equal(sent.noteId, a!.noteId);
  assert.equal((await v.ns.get(a!.noteId))!.state, "RESERVED");
  await assert.rejects(q.take(a!.noteId), /no ready proof/);
  await q.drop(b!.noteId);
  assert.equal((await v.ns.get(b!.noteId))!.state, "UNSPENT");
  assert.equal((await v.ns.get(c!.noteId))!.state, "HELD");
  assert.deepEqual(q.ready().map((r) => r.noteId), [c!.noteId]);
  // a take whose RESERVED write fails hands nothing out and frees the note
  v.failPut.on = (rec) => (rec as { state?: string }).state === "RESERVED";
  await assert.rejects(q.take(c!.noteId), /refused the write/);
  v.failPut.on = undefined;
  assert.equal((await v.ns.get(c!.noteId))!.state, "UNSPENT");
  // a prover that fails: the note goes back to UNSPENT, and the next pass proves it
  const v2 = await vaultWith([usd(2)]);
  const broken: VaultProver = { load: async () => {}, prove: async () => Promise.reject(new Error("worker died")) };
  const q2 = queue(v2, fakePool(v2), [broken]);
  const pass = await q2.refresh();
  assert.match(pass.failed[0]!.error, /worker died/);
  assert.equal((await v2.ns.list())[0]!.state, "UNSPENT");
  assert.deepEqual(q2.ready(), []);
});

test("a proof dropped while it is made is not kept, and its note is freed", async () => {
  const v = await vaultWith([usd(2)]);
  let release = (): void => {};
  const inner = signalsProver();
  const slow: VaultProver = { load: inner.load, prove: async (c, i) => (await new Promise<void>((r) => (release = r)), inner.prove(c, i)) };
  const q = queue(v, fakePool(v), [slow]);
  const running = q.refresh();
  while ((await v.ns.list())[0]!.state !== "HELD") await new Promise((r) => setTimeout(r, 1));
  await q.drop(v.notes[0]!.id);
  release();
  const pass = await running;
  assert.match(pass.failed[0]!.error, /dropped/);
  assert.deepEqual(q.ready(), []);
  assert.equal((await v.ns.list())[0]!.state, "UNSPENT");
});

test("after a spend the change note gets its own proof and its own W (j + 1); a proof fixes its chunk, so taps in a row draw on several notes", async () => {
  const v = await vaultWith([usd(10.43)]);
  const pool = fakePool(v);
  const q = queue(v, pool);
  await q.refresh();
  const [first] = q.ready();
  assert.equal(first!.chunk, usd(10));
  await q.take(first!.noteId);
  // the spend lands: the change note (l, 0) holds what is left, born UNSPENT on its leaf, the parent SPENT
  const parent = (await v.ns.get(first!.noteId))!;
  const label = parent.leaf!.label;
  const change: NoteRef = { kind: "change", l: label, j: 0 };
  const pre = noteSecrets(SEED, change).precommitment;
  const value = parent.leaf!.value - first!.chunk;
  const commitment = noteCommitment(value, label, pre);
  v.stateTree.append([commitment]);
  await v.ns.add({ ref: change, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value, label, commitment, leafIndex: BigInt(v.stateTree.size - 1) } });
  assert.equal((await v.ns.get(first!.noteId))!.state, "SPENT");
  // $0.43 covers no rung: nothing; a larger change note is proved
  assert.deepEqual((await q.refresh()).made, []);
  const v2 = await vaultWith([usd(25)]);
  const pool2 = fakePool(v2);
  const q2 = queue(v2, pool2);
  await q2.refresh();
  const [top] = q2.ready();
  assert.equal(top!.chunk, usd(20));
  await q2.take(top!.noteId);
  const p2 = (await v2.ns.get(top!.noteId))!;
  const ch: NoteRef = { kind: "change", l: p2.leaf!.label, j: 0 };
  const pre2 = noteSecrets(SEED, ch).precommitment;
  const c2 = noteCommitment(usd(5), p2.leaf!.label, pre2);
  v2.stateTree.append([c2]);
  const born = await v2.ns.add({ ref: ch, scope: SCOPE, precommitment: pre2, state: "UNSPENT", leaf: { value: usd(5), label: p2.leaf!.label, commitment: c2, leafIndex: BigInt(v2.stateTree.size - 1) } });
  const pass = await q2.refresh();
  assert.deepEqual(pass.made, [born.id]);
  const [next] = q2.ready();
  assert.equal(next!.chunk, usd(5));
  assert.equal(next!.wallet.j, 1);
  assert.equal(next!.wallet.address, W("sol", ch, p2.leaf!.label));
  assert.notEqual(next!.wallet.address, top!.wallet.address, "the change note's W is not its parent's");
  assert.equal(next!.publicSignals[1], noteSecrets(SEED, ch).nullifierHash.toString());
});

test("side by side: at most min(hardwareConcurrency - 1, 3) proofs at once; a pool of one and of three make the same proofs", async () => {
  const values = [usd(2), usd(5), usd(10), usd(20), usd(50), usd(100)];
  const run = async (hwc: number) => {
    const v = await vaultWith(values);
    let active = 0, peak = 0;
    const provers = [0, 1, 2, 3].map(() => {
      const inner = signalsProver();
      const p: VaultProver = {
        load: inner.load,
        async prove(c, i) {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 60)); // longer than a store write, so the lanes overlap
          active--;
          return inner.prove(c, i);
        },
      };
      return p;
    });
    const q = queue(v, fakePool(v), provers, hwc);
    const pass = await q.refresh();
    assert.equal(pass.made.length, 6);
    const notes = await v.ns.list();
    const shape = q.ready().map((r) => {
      const n = notes.find((x) => x.id === r.noteId)!;
      // the deposit index starts at the store's random lane, so the nullifier hash and the state root are each run's own
      assert.equal(r.publicSignals[1], noteSecrets(SEED, n.ref).nullifierHash.toString());
      assert.equal(r.publicSignals[3], v.stateTree.root!.toString());
      return { leaf: n.leaf!.leafIndex, chunk: r.chunk, w: r.wallet.address, context: r.binding.context, deadline: r.binding.deadlineMs, signals: r.publicSignals.filter((_, k) => k !== 1 && k !== 3) };
    });
    return { peak, shape };
  };
  const one = await run(2), three = await run(8), two = await run(3);
  assert.equal(one.peak, 1);
  assert.equal(two.peak, 2);
  assert.equal(three.peak, 3);
  assert.deepEqual(three.shape, one.shape);
  assert.deepEqual(two.shape, one.shape);
});

test("a binding the queue cannot hold a note under is refused before the note is HELD", async () => {
  const cases: [string, (b: Awaited<ReturnType<Fake["bind"]>>) => object, RegExp][] = [
    ["context at p", (b) => ({ ...b, context: VAULT_FIELD_P }), /context is not a field element/],
    ["deadline inside the margin", (b) => ({ ...b, deadlineMs: BigInt(BLOCK_MS) + MARGIN }), /within the remake margin/],
    ["fee cap at the chunk", (b) => ({ ...b, feeCap: usd(2) }), /fee cap/],
  ];
  for (const [what, edit, err] of cases) {
    const v = await vaultWith([usd(2)]);
    const pool = fakePool(v);
    const bind = pool.bind.bind(pool);
    pool.bind = async (a) => edit(await bind(a)) as Awaited<ReturnType<Fake["bind"]>>;
    const q = queue(v, pool);
    const pass = await q.refresh();
    assert.match(pass.failed[0]?.error ?? "", err, what);
    assert.equal((await v.ns.list())[0]!.state, "UNSPENT", what);
  }
});

test("another pool's notes are not this pool's: the queue proves only notes of its scope", async () => {
  const v = await vaultWith([usd(2), usd(5)]);
  const pool = { ...fakePool(v), scope: SCOPE + 1n };
  const q = queue(v, pool);
  assert.deepEqual((await q.refresh()).made, []);
});

// ---------- the NEAR vault as the first pool ----------
function nearPool(v: Vault, relayFee = 300_000n) {
  return nearVaultPool({
    vaultId: VAULT,
    token: TOKEN,
    network: "mainnet",
    rpcs: feeReplay("mainnet"),
    priceRpcs: feeReplay("mainnet"),
    feeRecipient: FEE_RECIPIENT,
    relayFee: async () => relayFee,
    registerDepositOf: async () => REGISTER_DEPOSIT,
    blockTimestampNanosec: async () => BLOCK_NS,
    trees: async () => ({ stateTree: v.stateTree, labelTree: v.labelTree, stateRoot: v.stateTree.root!, labelRoot: v.labelTree.root! }),
  });
}

test("NEAR vault: each proof's context is the one the vault recomputes from the request, paying W_{near, l, j}", async () => {
  const v = await vaultWith([usd(2), usd(5), usd(10)]);
  const pool = nearPool(v);
  assert.equal(pool.scope, SCOPE);
  const q = queue(v, pool);
  const pass = await q.refresh();
  assert.deepEqual(pass.failed, []);
  for (const r of q.ready()) {
    const w: VaultWithdrawal = r.binding.request;
    // the vault's own recompute: vaultContextOf over vaultContextInput, the vault as processor, its scope
    assert.equal(vaultContextOf(keccak_256, vaultContextInput(VAULT, w), SCOPE), r.binding.context);
    assert.equal(r.publicSignals[7], r.binding.context.toString());
    const n = (await v.ns.get(r.noteId))!;
    assert.equal(w.recipient, W("near", n.ref, n.leaf!.label));
    assert.equal(w.relay_fee, "300000");
    assert.equal(r.binding.feeCap, 300_000n);
    assert.equal(w.fee_recipient, FEE_RECIPIENT);
    assert.equal(w.refund_precommitment, noteSecrets(SEED, { kind: "refund", l: n.leaf!.label, j: 0 }).precommitment.toString());
    assert.ok(w.deadline_ms > BLOCK_MS + 534_464 && w.deadline_ms <= BLOCK_MS + 600_000);
    assert.equal(BigInt(w.deadline_ms), r.binding.deadlineMs);
  }
});

test("NEAR vault: a fee above the device's fee_max or at the chunk, and a W not its key's id, are refused before any proof", async () => {
  const v = await vaultWith([usd(2)]);
  const prover = signalsProver();
  const pass = await queue(v, nearPool(v, FEE_MAX + 1n), [prover]).refresh();
  assert.match(pass.failed[0]!.error, /above the device's fee_max/);
  const v2 = await vaultWith([usd(2)]);
  const pass2 = await queue(v2, nearPool(v2, usd(2)), [prover]).refresh();
  assert.match(pass2.failed[0]!.error, /at or above the chunk/);
  assert.equal(proves(prover), 0);
  const w = d.freshWallet(SEED, "near", 5n, 0);
  w.secretKey.fill(0);
  await assert.rejects(nearPool(v).bind({ chunk: usd(2), wallet: { address: d.freshWallet(SEED, "near", 5n, 1).address, publicKey: w.publicKey }, refundPrecommitment: 1n }), /64-hex id of its ed25519 public key/);
});
