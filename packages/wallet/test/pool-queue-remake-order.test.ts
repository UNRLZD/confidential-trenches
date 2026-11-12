// Card fresh-money-spendable-at-once: a newest-root proof is takeable only until the boundary + NEWEST_GRACE_MS, while
// an epoch-root proof stays takeable all of the next epoch, so at a boundary the queue remakes the newest-root proofs
// first, then by chunk and leaf: on a slow prover a tap that needs the fresh note is never refused while rested
// remakes run.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VAULT_FIELD_P, VaultTree, vaultLabelOf, type VaultProver } from "@blindfill/kit";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { USDC_LADDER } from "../src/pool/near.ts";
import type { Pool, PoolBindArgs, PoolTrees } from "../src/pool/pool.ts";
import { openProofQueue } from "../src/pool/queue.ts";
import { BLOCK_MS, closeVaults, SCOPE, SEED, signalsProver, vaultWith, type Vault } from "./withdraw-fixture.ts";

after(closeVaults);
const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
const E = 60_000n;
const L = 270_000n;
const START = BigInt(BLOCK_MS) - (BigInt(BLOCK_MS) % E);
const T0 = START - 3_600_000n;

function fakePool(v: Vault) {
  const t = { now: START + 1_000n };
  const state = v.stateLeaves.map((leaf) => ({ leaf, t: T0 }));
  const labels = v.labelLeaves.map((leaf) => ({ leaf, t: T0 }));
  const cut = (ls: { leaf: bigint; t: bigint }[], before: bigint) => new VaultTree(ls.filter((x) => x.t < before).map((x) => x.leaf));
  const trees = (before: bigint): PoolTrees => {
    const s = cut(state, before), l = cut(labels, before);
    return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
  };
  let n = 0;
  const pool: Pool<{ n: number }> & { t: typeof t; land: (c: bigint, l: bigint) => void } = {
    id: "test:pool", chain: "sol", scope: SCOPE, ladder: USDC_LADDER, epochMs: E, lifeMs: L, sendMarginMs: 120_000n, t,
    now: async () => t.now,
    trees: async (before) => trees(before),
    land(c, l) {
      state.push({ leaf: c, t: t.now });
      v.stateLeaves.push(c);
      v.stateTree.append([c]);
      labels.push({ leaf: l, t: t.now });
      v.labelLeaves.push(l);
      v.labelTree.append([l]);
    },
    async bind(b: PoolBindArgs) {
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|${b.deadlineMs}|${++n}`);
      return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: 100_000n, request: { n } };
    },
  };
  return pool;
}

test("a fresh note's newest-root proof is remade before the rested ones at a boundary, so a tap 16 s in still gets it", async () => {
  const v = await vaultWith([usd(100), usd(100)]); // two rested notes, the larger chunks
  const pool = fakePool(v);
  // every prove after the first of a pass waits on the gate: the device's one prover, slow (a phone)
  let gated = false;
  let first = true;
  let open_ = (): void => {};
  const gate = new Promise<void>((ok) => (open_ = ok));
  const provers = [signalsProver()].map((sp): VaultProver => ({
    load: sp.load,
    prove: async (c, i) => {
      if (gated && !first) await gate;
      if (gated) first = false;
      return sp.prove(c, i);
    },
  }));
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool, provers, hardwareConcurrency: 4 });
  pool.t.now += 10_000n;
  // a sell's money back lands this epoch: a smaller chunk than the rested notes
  const ref: NoteRef = { kind: "return", c: "sol", l: 7n, j: 1 };
  const pre = noteSecrets(SEED, ref).precommitment;
  let back = await v.ns.add({ ref, scope: SCOPE, precommitment: pre, state: "PLANNED" });
  back = await v.ns.move(back.id, "PLANNED", "INCOMING");
  const label = vaultLabelOf(keccak_256, SCOPE, 2000n);
  const commitment = noteCommitment(usd(20), label, pre);
  pool.land(commitment, label);
  back = await v.ns.move(back.id, "INCOMING", "UNSPENT", { leaf: { value: usd(20), label, commitment, leafIndex: BigInt(v.stateLeaves.length - 1) } });
  await q.refresh();
  assert.equal(q.ready().length, 3);
  assert.equal(q.ready().find((r) => r.noteId === back.id)!.root, "newest");
  // the boundary: the pass remakes; its first remake finishes, the rest wait on the slow prover
  gated = true;
  pool.t.now = START + E + 1_000n;
  const pass = q.refresh();
  for (let k = 0; k < 2_000 && !q.ready().some((r) => r.epochStartMs === START + E); k++) await new Promise((ok) => setTimeout(ok, 1));
  // 16 s into the epoch a tap needs the money back (the rested proofs stay takeable all epoch, the newest one 15 s)
  pool.t.now = START + E + 16_000n;
  const remadeFirst = q.ready().find((r) => r.epochStartMs === START + E)?.noteId;
  try {
    const t = await q.take(back.id).catch((e: Error) => e);
    assert.ok(!(t instanceof Error), `the tap is refused: ${(t as Error).message}`);
    assert.equal(remadeFirst, back.id, "the proof with the shortest life left is remade first");
  } finally {
    open_();
    await pass.catch(() => {});
    await q.close();
  }
});
