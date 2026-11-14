// node --test packages/wallet/test/pool-queue-kept.test.ts: a pool's ready proofs kept on the device (card
// balance-shows-fast, src/pool/kept-proofs.ts and src/pool/queue.ts "Kept on the device"). A reload or a hand-over to
// another tab opened a new queue that proved every note again (a phone: about 8.4 s a proof); with the proofs kept in
// the wallet store, the new queue adopts each one it would make itself and runs no prover for it. Counted work only: the
// prover's runs (signalsProver's log) and the pool's binds. The notes are withdraw-fixture.ts's test notes, never money.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VAULT_FIELD_P, VaultTree, type VaultProver } from "@blindfill/kit";
import { USDC_LADDER } from "../src/pool/near.ts";
import { keptProofs } from "../src/pool/kept-proofs.ts";
import type { Pool, PoolBindArgs, PoolTrees, ReadyProof } from "../src/pool/pool.ts";
import { openProofQueue, type ProofQueue } from "../src/pool/queue.ts";
import { BLOCK_MS, closeVaults, SCOPE, SEED, signalsProver, vaultWith, type Vault } from "./withdraw-fixture.ts";

after(closeVaults);
const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
const E = 60_000n;
const L = 270_000n;
const MARGIN = 120_000n;
const START = BigInt(BLOCK_MS) - (BigInt(BLOCK_MS) % E);
const T0 = START - 3_600_000n;

type Fake = Pool<{ n: number }> & { binds: PoolBindArgs[]; t: { now: bigint } };
/** pool-queue.test.ts's fake pool: the fixture's leaves landed at T0; each bind's context differs (a try count, as a
 *  real bind's random salt), so a proof is adopted only with its own binding. */
function fakePool(v: Vault, piecesMax?: number): Fake {
  const t = { now: START + 1_000n };
  const binds: PoolBindArgs[] = [];
  const tries = new Map<string, number>();
  const trees = (): PoolTrees => {
    const s = new VaultTree(v.stateLeaves), l = new VaultTree(v.labelLeaves);
    return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
  };
  return {
    id: "test:pool", chain: "sol", scope: SCOPE, ladder: USDC_LADDER, ...(piecesMax === undefined ? {} : { piecesMax }), epochMs: E, lifeMs: L, sendMarginMs: MARGIN, binds, t,
    now: async () => t.now,
    trees: async () => trees(),
    async bind(b) {
      binds.push(b);
      const n = (tries.get(b.wallet.address) ?? 0) + 1;
      tries.set(b.wallet.address, n);
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|100000|${b.deadlineMs}|${n}`);
      return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: 100_000n, request: { n } };
    },
  };
}

const open: ProofQueue<unknown>[] = [];
after(async () => {
  for (const q of open) await q.close();
});
type Counted = VaultProver & { log: string[] };
const proves = (ps: Counted[]): number => ps.reduce((a, p) => a + p.log.filter((x) => x === "prove withdraw").length, 0);
/** One tab's queue on the vault, its ready proofs kept in the vault's wallet store. */
function tab(v: Vault, pool: Fake): { q: ProofQueue<{ n: number }>; ps: Counted[] } {
  const ps = [signalsProver()];
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool, provers: ps, hardwareConcurrency: 4, kept: keptProofs(v.w, pool.id) });
  open.push(q as ProofQueue<unknown>);
  return { q, ps };
}
const KEY = "proofs/test:pool";
const same = (x: ReadyProof<unknown>[], y: ReadyProof<unknown>[]): void =>
  assert.deepEqual(x.map((r) => [r.noteId, r.proof, r.publicSignals, r.binding.context]), y.map((r) => [r.noteId, r.proof, r.publicSignals, r.binding.context]));

test("a hand-over or a reload inside a proof's epoch proves nothing again: the kept proofs are ready at the first pass", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(1.5), usd(20)]);
  const pool = fakePool(v);
  const a = tab(v, pool);
  const first = await a.q.refresh();
  assert.equal(first.made.length, 3);
  assert.equal(proves(a.ps), 3);
  const made = a.q.ready();
  await a.q.close(); // the hand-over: every note back to UNSPENT
  for (const r of made) assert.equal((await v.ns.get(r.noteId))!.state, "UNSPENT");
  const binds = pool.binds.length;
  const b = tab(v, pool);
  const pass = await b.q.refresh();
  assert.deepEqual(pass.failed, []);
  assert.equal(proves(b.ps), 0, "no proof made again");
  assert.equal(pool.binds.length, binds, "no bind either: each proof keeps its own binding");
  same(b.q.ready(), made);
  for (const r of b.q.ready()) {
    const n = (await v.ns.get(r.noteId))!;
    assert.equal(n.state, "HELD");
    assert.equal(n.attempt, r.attempt);
    assert.equal(n.contexts!.at(-1)!.context, r.binding.context.toString());
  }
  // and a take hands one out, the kept list then without it
  const t = await b.q.take(made[0]!.noteId);
  assert.equal((await v.ns.get(t.noteId))!.state, "RESERVED");
  await b.q.close();
  const kept = (await v.w.get("meta", KEY)) as ReadyProof<unknown>[];
  assert.deepEqual(kept.map((r) => r.noteId).sort(), made.slice(1).map((r) => r.noteId).sort());
});

test("a reload in the next epoch: the kept proofs are ready at once and made again at that pass, never proved twice", async () => {
  const v = await vaultWith([usd(5.5), usd(10), usd(20)]);
  const pool = fakePool(v);
  const a = tab(v, pool);
  await a.q.refresh();
  const made = a.q.ready();
  await a.q.close();
  pool.t.now += E;
  const b = tab(v, pool);
  const pass = await b.q.refresh();
  assert.deepEqual(pass.failed, []);
  assert.deepEqual(pass.made, [], "each note held by its kept proof, so none is a fresh one");
  assert.equal(pass.remade.length, 3);
  assert.equal(proves(b.ps), 3, "one remake per note, as a queue that never closed");
  assert.deepEqual(b.q.ready().map((r) => r.noteId).sort(), made.map((r) => r.noteId).sort());
});

test("a kept proof is adopted only as the queue would make it: a wrong signal, an old epoch or a note taken is proved again", async () => {
  const v = await vaultWith([usd(5.5), usd(10), usd(20)]);
  const pool = fakePool(v);
  const a = tab(v, pool);
  await a.q.refresh();
  await a.q.close();
  const kept = (await v.w.get("meta", KEY)) as ReadyProof<unknown>[];
  assert.equal(kept.length, 3);
  const [x, y, z] = kept as [ReadyProof<unknown>, ReadyProof<unknown>, ReadyProof<unknown>];
  // x spends another note's nullifier; y pays another W; z's note another tab holds
  const forged = [{ ...x, publicSignals: x.publicSignals.map((s, i) => (i === 1 ? y.publicSignals[1] : s)) }, { ...y, wallet: { ...y.wallet, address: z.wallet.address } }, z];
  await v.w.put("meta", KEY, forged);
  await v.ns.move(z.noteId, "UNSPENT", "HELD", { deadlineMs: z.deadlineMs, context: "1" });
  const b = tab(v, pool);
  const pass = await b.q.refresh();
  assert.equal(proves(b.ps), 2, "x and y proved again; z's note is held elsewhere");
  assert.deepEqual(pass.made.sort(), [x.noteId, y.noteId].sort());
  await b.q.close();
  // two epochs on, nothing kept is adopted
  const v2 = await vaultWith([usd(5.5), usd(10)]);
  const p2 = fakePool(v2);
  const c = tab(v2, p2);
  await c.q.refresh();
  await c.q.close();
  p2.t.now += 2n * E;
  const d = tab(v2, p2);
  const again = await d.q.refresh();
  assert.equal(again.made.length, 2);
  assert.equal(proves(d.ps), 2);
});

test("tier 2 too: a buy's pieces to the primary's W are adopted beside each note's own proof, none proved again", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(1.5), usd(20)]);
  const pool = fakePool(v, 4);
  const a = tab(v, pool);
  await a.q.refresh();
  const made = a.q.ready();
  assert.ok(made.some((r) => r.own !== true), "the pass made tier 2 proofs");
  assert.equal(proves(a.ps), made.length);
  await a.q.close();
  const b = tab(v, pool);
  const pass = await b.q.refresh();
  assert.deepEqual(pass.failed, []);
  assert.equal(proves(b.ps), 0);
  same(b.q.ready(), made);
  assert.deepEqual(b.q.ready().map((r) => [r.own === true, r.wallet.address]), made.map((r) => [r.own === true, r.wallet.address]));
});
