// node --test packages/wallet/test/pool-queue-pieces.test.ts: the proof queue for a pool whose buy pays one W from
// several notes (card buy-spends-several-pieces, src/pool/queue.ts "Pieces"): every ready proof bound to the W of the
// ready note with the smallest chunk (its owner), made again for the next owner once a buy takes it, the ready set
// sized by the prover's measured time, and the balances' Max over the set bound to one W. The notes are
// withdraw-fixture.ts's (the all-zero test seed, a fixture vault); the prover answers the signals without proving.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VAULT_FIELD_P, VaultTree, type VaultProver } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import type { NoteRef } from "../src/notes/secrets.ts";
import { USDC_LADDER } from "../src/pool/near.ts";
import type { Pool, PoolBindArgs, PoolTrees } from "../src/pool/pool.ts";
import { openProofQueue, piecesReadySize, type ProofQueue } from "../src/pool/queue.ts";
import { poolBalances, type BalancePool, type TapSpendOf } from "../src/pool/balances.ts";
import { buyWalletsOf } from "../src/pool/buy-wallets.ts";
import { BLOCK_MS, closeVaults, SCOPE, SEED, signalsProver, vaultWith, type Vault } from "./withdraw-fixture.ts";

after(closeVaults);
const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
const E = 60_000n;
const START = BigInt(BLOCK_MS) - (BigInt(BLOCK_MS) % E);

/** A pool on the fixture vault, every leaf landed an hour before START, with piecesMax pieces a buy. */
function piecesPool(v: Vault, piecesMax = 5): Pool<{ n: number }> & { binds: PoolBindArgs[] } {
  const binds: PoolBindArgs[] = [];
  const trees = (): PoolTrees => {
    const s = new VaultTree(v.stateLeaves), l = new VaultTree(v.labelLeaves);
    return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
  };
  return {
    id: "test:pieces",
    chain: "sol",
    scope: SCOPE,
    ladder: USDC_LADDER,
    piecesMax,
    epochMs: E,
    lifeMs: 270_000n,
    sendMarginMs: 120_000n,
    binds,
    now: async () => START + 1_000n,
    trees: async () => trees(),
    async bind(b) {
      binds.push(b);
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|${binds.length}`);
      return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: 100_000n, request: { n: binds.length } };
    },
  };
}
const open: ProofQueue<unknown>[] = [];
after(async () => {
  for (const q of open) await q.close();
});
function queue<R>(v: Vault, pool: Pool<R>, monoNow?: () => number): ProofQueue<R> {
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool, provers: [signalsProver() as VaultProver], hardwareConcurrency: 16, ...(monoNow ? { monoNow } : {}) });
  open.push(q as ProofQueue<unknown>);
  return q;
}
const jOf = (ref: NoteRef): number => (ref.kind === "change" ? ref.j + 1 : 0);
const W = (label: bigint, ref: NoteRef): string => {
  const w = d.freshWallet(SEED, "sol", label, jOf(ref));
  w.secretKey.fill(0);
  return w.address;
};
/** A planted Max rule: each piece adds its chunk less its fee cap, the set pays 1,000 once. */
const sumLess: TapSpendOf = (ps) => ps.reduce((a, p) => a + p.chunk - p.feeCap, 0n) - 1_000n;
const BAL: BalancePool = { id: "test:pieces", chain: "solana", scope: SCOPE, asset: "SOL", spendOf: sumLess };

test("pieces: every ready proof binds the W of the ready note with the smallest chunk, and the restore finds that W from the notes a buy spends", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(20)]);
  const pool = piecesPool(v);
  const q = queue(v, pool);
  await q.refresh();
  const ready = q.ready();
  // no proof timed yet: readySetSize(16) = 3, the largest chunks: 20, 10 and 5 (the 5.5 note's)
  assert.deepEqual(ready.map((r) => r.chunk).sort((a, b) => (a < b ? -1 : 1)), [usd(5), usd(10), usd(20)]);
  const notes = await Promise.all(ready.map(async (r) => (await v.ns.get(r.noteId))!));
  const owner = notes.find((n) => n.leaf!.value === usd(5.5))!;
  const w = W(owner.leaf!.label, owner.ref);
  for (const r of ready) assert.equal(r.wallet.address, w, `the ${r.chunk} proof pays the smallest piece's W`);
  for (const r of ready) assert.deepEqual([r.wallet.l, r.wallet.j], [owner.leaf!.label, jOf(owner.ref)]);
  for (const b of pool.binds) assert.equal(b.wallet.address, w);
  // a buy that spends all three: the restore lists each spent note's own W, the shared one among them, so it is found
  const restored = buyWalletsOf(SEED, [{ id: pool.id, chain: "sol", spent: notes.map((n) => ({ ref: n.ref, label: n.leaf!.label })) }]);
  assert.deepEqual(restored.failed, []);
  assert.ok(restored.wallets.some((x) => x.address === w), "the W every piece paid is a spent note's own");
  // the balances' Max: the three pieces as one set, the 1,000 once
  assert.equal(poolBalances(await v.ns.list(), [BAL], ready)[0]!.tap_max, "0.034699");
});

test("pieces: once a buy takes the owner's note, the proofs left are made again for the next smallest; until then Max counts none of them", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(20)]);
  const pool = piecesPool(v);
  const q = queue(v, pool);
  await q.refresh();
  const first = q.ready();
  const ownerId = first.find((r) => r.chunk === usd(5))!.noteId;
  const oldW = first[0]!.wallet.address;
  await q.take(ownerId);
  // left bound to a W whose note a buy took: no set holds its owner, so Max is 0
  assert.equal(poolBalances(await v.ns.list(), [BAL], q.ready())[0]!.tap_max, "0");
  await q.refresh();
  const next = q.ready();
  // the 2 note joins (the set's room), the smallest, and every proof is made again for its W
  assert.deepEqual(next.map((r) => r.chunk).sort((a, b) => (a < b ? -1 : 1)), [usd(2), usd(10), usd(20)]);
  const two = (await v.ns.list()).find((n) => n.leaf?.value === usd(2))!;
  for (const r of next) assert.equal(r.wallet.address, W(two.leaf!.label, two.ref));
  assert.notEqual(next[0]!.wallet.address, oldW);
  assert.equal(poolBalances(await v.ns.list(), [BAL], next)[0]!.tap_max, "0.031699");
});

test("pieces: the ready set is what the prover makes in half an epoch at its measured time, at least 1, at most piecesMax; a slow prover keeps fewer and Max says so", async () => {
  // the rule
  assert.equal(piecesReadySize(E, [], 5, 16), 3, "no proof timed yet: readySetSize");
  assert.equal(piecesReadySize(E, [], 5, 2), 1);
  assert.equal(piecesReadySize(E, [1_500, 1_400, 1_600], 5, 16), 5, "a desktop: 30 s / 1.5 s is 20, at most 5");
  assert.equal(piecesReadySize(E, [8_300], 5, 16), 3, "a phone on one thread: 30 s / 8.3 s");
  assert.equal(piecesReadySize(E, [12_000, 14_000], 5, 16), 2);
  assert.equal(piecesReadySize(E, [40_000], 5, 16), 1, "slower than half an epoch: still 1");
  // a slow prover: 20 s a proof, so one fits in half an epoch
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(20)]);
  const pool = piecesPool(v);
  let clock = 0;
  const q = queue(v, pool, () => (clock += 20_000)); // each proof reads the clock before and after: 20 s
  await q.refresh();
  assert.equal(q.ready().length, 3, "the first pass, before any proof is timed");
  await q.refresh();
  const kept = q.ready();
  assert.deepEqual(kept.map((r) => r.chunk), [usd(20)], "the piece that adds the most");
  const twenty = (await v.ns.list()).find((n) => n.leaf?.value === usd(20))!;
  assert.equal(kept[0]!.wallet.address, W(twenty.leaf!.label, twenty.ref), "its own W: it is the owner now");
  assert.equal(poolBalances(await v.ns.list(), [BAL], kept)[0]!.tap_max, "0.019899");
  // the notes let go are UNSPENT again, never held by a proof no one keeps
  for (const n of await v.ns.list()) if (n.leaf && n.leaf.value !== usd(20)) assert.equal(n.state, "UNSPENT", String(n.leaf.value));
  // a fast prover: as many as piecesMax
  const v2 = await vaultWith([usd(2), usd(5), usd(10), usd(20), usd(50), usd(100)]);
  let c2 = 0;
  const q2 = queue(v2, piecesPool(v2), () => (c2 += 500));
  await q2.refresh();
  await q2.refresh();
  assert.equal(q2.ready().length, 5);
  assert.deepEqual(q2.ready().map((r) => r.chunk).sort((a, b) => (a < b ? -1 : 1)), [usd(5), usd(10), usd(20), usd(50), usd(100)]);
});
