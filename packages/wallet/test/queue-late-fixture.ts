// A proof queue with one rested note and one that lands this epoch (its proof on the newest root), its prover gated
// and the device's monotonic clock in the test's hands (card buy-spends-several-pieces: what the queue offers past a
// newest-root proof's grace). Used by test/pool-queue-takeable.test.ts and the signing page's EVM buy host test.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VAULT_FIELD_P, VaultTree, vaultLabelOf, type VaultProver } from "@blindfill/kit";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { USDC_LADDER } from "../src/pool/near.ts";
import type { Pool, PoolBindArgs, PoolTrees } from "../src/pool/pool.ts";
import { openProofQueue } from "../src/pool/queue.ts";
import { BLOCK_MS, SCOPE, SEED, signalsProver, vaultWith, type Vault } from "./withdraw-fixture.ts";

const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
export const E = 60_000n;
export const L = 270_000n;
export const START = BigInt(BLOCK_MS) - (BigInt(BLOCK_MS) % E);
const T0 = START - 3_600_000n;

export function fakePool(v: Vault, piecesMax?: number, chain: "sol" | "evm" = "sol") {
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
    id: "test:pool", chain, scope: SCOPE, ladder: USDC_LADDER, epochMs: E, lifeMs: L, sendMarginMs: 120_000n, t,
    ...(piecesMax === undefined ? {} : { piecesMax }),
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

/** A queue with one rested note and one that lands this epoch (its proof on the newest root), every prove after the
 *  gate is shut waiting on it (the device's one prover, slow), and the device's monotonic clock in the test's hands. */
export async function lateSetup(piecesMax?: number, chain: "sol" | "evm" = "sol") {
  const v = await vaultWith([usd(100)]);
  const pool = fakePool(v, piecesMax, chain);
  let shut = false;
  let open_ = (): void => {};
  const gate = new Promise<void>((ok) => (open_ = ok));
  const provers = [signalsProver()].map((sp): VaultProver => ({ load: sp.load, prove: async (c, i) => (shut && (await gate), sp.prove(c, i)) }));
  const clock = { ms: 0 };
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool, provers, hardwareConcurrency: 4, monotonic: () => clock.ms });
  pool.t.now += 10_000n;
  const ref: NoteRef = { kind: "return", c: chain, l: 7n, j: 1 };
  const pre = noteSecrets(SEED, ref).precommitment;
  let fresh = await v.ns.add({ ref, scope: SCOPE, precommitment: pre, state: "PLANNED" });
  fresh = await v.ns.move(fresh.id, "PLANNED", "INCOMING");
  const label = vaultLabelOf(keccak_256, SCOPE, 2000n);
  const commitment = noteCommitment(usd(20), label, pre);
  pool.land(commitment, label);
  fresh = await v.ns.move(fresh.id, "INCOMING", "UNSPENT", { leaf: { value: usd(20), label, commitment, leafIndex: BigInt(v.stateLeaves.length - 1) } });
  for (let i = 0; i < 4; i++) await q.refresh(); // tier 1, then tier 2 when the pool takes pieces
  return { v, pool, q, fresh, clock, shut: () => void (shut = true), open: () => open_() };
}

