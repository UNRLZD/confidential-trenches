// node --test packages/signpage/test/pool-buy-tiers.test.ts: the buy's pick (src/pool-buy.ts pickPieces) over the proof
// queue's two tiers (card buy-spends-several-pieces, packages/wallet/src/pool/queue.ts "Pieces"): each ready note's own
// proof is a set of one; the primary's W holds the primary's own proof and the tier 2 proofs. A buy one note pays goes out
// as one piece even with tier 2 ready; a buy no note pays alone takes the primary and the fewest tier 2 pieces that pay;
// never two proofs of one note. The queue runs on the wallet's fixture vault (the all-zero test seed); the prover answers
// the signals without proving.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { VAULT_FIELD_P } from "../../kit/src/vault/shapes.ts";
import type { VaultProver } from "../../kit/src/prover/prove.ts";
import { USDC_LADDER } from "../../wallet/src/pool/near.ts";
import type { Pool, PoolTrees, ReadyProof } from "../../wallet/src/pool/pool.ts";
import { openProofQueue, type ProofQueue } from "../../wallet/src/pool/queue.ts";
import { BLOCK_MS, closeVaults, SCOPE, SEED, signalsProver, vaultWith, type Vault } from "../../wallet/test/withdraw-fixture.ts";
import { pickPieces } from "../src/pool-buy.ts";

const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
const E = 60_000n;
const START = BigInt(BLOCK_MS) - (BigInt(BLOCK_MS) % E);
const queues: ProofQueue<unknown>[] = [];
after(async () => {
  for (const q of queues) await q.close();
  closeVaults();
});

function piecesPool(v: Vault): Pool<{ n: number }> {
  let binds = 0;
  const trees = (): PoolTrees => {
    const s = new VaultTree(v.stateLeaves), l = new VaultTree(v.labelLeaves);
    return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
  };
  return {
    id: "test:tiers",
    chain: "sol",
    scope: SCOPE,
    ladder: USDC_LADDER,
    piecesMax: 4,
    epochMs: E,
    lifeMs: 270_000n,
    sendMarginMs: 120_000n,
    now: async () => START + 1_000n,
    trees: async () => trees(),
    async bind(b) {
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|${++binds}`);
      return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: 100_000n, request: { n: binds } };
    },
  };
}
/** The queue's ready list once tier 1 (pass 1) and tier 2 (pass 2) are made, and each note's id by its value. */
async function tiers(values: readonly bigint[]): Promise<{ list: ReadyProof<unknown>[]; id: (x: bigint) => string }> {
  const v = await vaultWith([...values]);
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool: piecesPool(v) as Pool<unknown>, provers: [signalsProver() as VaultProver], hardwareConcurrency: 16 });
  queues.push(q);
  await q.refresh();
  await q.refresh();
  const notes = await v.ns.list();
  return { list: q.ready(), id: (x) => notes.find((n) => n.leaf?.value === x)!.id };
}
const atLeast = (need: bigint) => (set: readonly ReadyProof<unknown>[]): boolean => set.reduce((a, p) => a + p.chunk, 0n) >= need;
const once = (set: readonly ReadyProof<unknown>[]): boolean => new Set(set.map((p) => p.noteId)).size === set.length;

test("the pick over the two tiers: one note that pays is one piece, tier 2 ready or not; past every single note, the primary and the fewest pieces that pay; never a note twice", async () => {
  const { list, id } = await tiers([usd(2), usd(5.5), usd(10), usd(20)]);
  assert.equal(list.filter((p) => p.own !== true).length, 3, "tier 2 is ready: the 10, the 5.5 and the 2 notes to the 20's W");
  // one note pays: one piece, its own proof, the least that pays (the 10 for 8, the 20 for 15)
  for (const [need, value] of [[usd(8), usd(10)], [usd(15), usd(20)], [usd(20), usd(20)]] as const) {
    const set = pickPieces(list, atLeast(need), 4)!;
    assert.deepEqual(set.map((p) => p.noteId), [id(value)], `${need}: one piece`);
    assert.equal(set[0]!.own, true);
  }
  // no note pays alone: the primary last (its own proof, the tag 3), and the fewest tier 2 pieces: 20 + 10 for 26, not
  // 20 + 5 + 2, which releases less in three pieces
  const two = pickPieces(list, atLeast(usd(26)), 4)!;
  assert.deepEqual(two.map((p) => p.noteId), [id(usd(10)), id(usd(20))]);
  assert.equal(two.at(-1)!.own, true);
  assert.equal(two[0]!.wallet.address, two[1]!.wallet.address, "one W");
  // of the same count, the least released: 20 + 5 for 24, not 20 + 10
  assert.deepEqual(pickPieces(list, atLeast(usd(24)), 4)!.map((p) => p.noteId), [id(usd(5.5)), id(usd(20))]);
  // every piece: 37
  const all = pickPieces(list, atLeast(usd(36)), 4)!;
  assert.equal(all.length, 4);
  assert.ok(once(all));
  assert.equal(pickPieces(list, atLeast(usd(38)), 4), null, "nothing pays");
  assert.equal(pickPieces(list, atLeast(usd(26)), 1), null, "one piece only: no single note pays 26");
  // never a note twice, whatever the list: a second tier 2 proof of the 10 note in the primary's set is never picked with
  // the first
  const piece10 = list.find((p) => p.noteId === id(usd(10)) && p.own !== true)!;
  const doubled = [...list, { ...piece10, attempt: "another" }];
  for (const need of [usd(26), usd(30), usd(36)]) {
    const set = pickPieces(doubled, atLeast(need), 4)!;
    assert.ok(once(set), `${need}: ${set.map((p) => p.noteId).join(",")}`);
  }
  assert.equal(pickPieces(doubled, atLeast(usd(38)), 4), null, "the 10 twice would pay 45 in four pieces: never");
});
