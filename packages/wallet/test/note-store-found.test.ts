// card notes-plan-at-restored-index: the note store's one edge for a deposit a restore found. The words restored on a
// new device find money waiting at a deposit index's one-time account (U_X on the pool's chain, or the id) that the
// lost store planned and this one never did; planFound writes that index's deposit note PLANNED so pool.deposit's fixed
// source (and the vault's late send) can carry it. Only with two providers agreeing on a balance above 0, no note at
// the index, and an index of this store's lane under the scope's counter; planDeposit leaves it out of the scope's one
// unfunded index (it is funded).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import * as d from "../src/derive/index.ts";
import { noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const pc = (ref: NoteRef): bigint => noteSecrets(SEED, ref).precommitment;
const opened: WalletStore[] = [];
const notes: NoteStore[] = [];
after(() => (opened.forEach((s) => s.close()), notes.forEach((n) => n.close())));

async function tab(): Promise<{ w: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  opened.push(w);
  const ns = await openNoteStore(w);
  notes.push(ns);
  return { w, ns };
}
const SCOPE = 77n;
const read = (i: number, amounts: readonly bigint[] = [1_000_000n, 1_000_000n], s = SCOPE) => ({ s, i, amounts }) as never;
// an index of another lane than the store's, and the store's own lane's k-th index
const otherLane = (lane: number, k: number): number => ((lane + 3) % 8) + 8 * k;
const ownLane = (lane: number, k: number): number => lane + 8 * k;

test("notes-plan-at-restored-index: a fresh store with money read at U_X for index i on two agreeing providers writes i's deposit note PLANNED; planDeposit still names its own index", async () => {
  const { w, ns } = await tab();
  // the index the page planned at the sign-in, before step 5 read the lanes (src/deposit-name.ts)
  const mine = await ns.planDeposit(SCOPE, pc);
  // step 7: the counter past the lane's highest plus two of the lane
  await w.raiseDepositIndex(SCOPE, ownLane(w.lane, 3));
  // the lost store's quote, in another lane, far past this store's counter
  const i = otherLane(w.lane, 40);
  const n = await ns.planFound(SCOPE, i, pc, read(i));
  assert.deepEqual({ ref: n.ref, state: n.state, scope: n.scope, precommitment: n.precommitment }, { ref: { kind: "deposit", s: SCOPE, i }, state: "PLANNED", scope: SCOPE, precommitment: pc({ kind: "deposit", s: SCOPE, i }) });
  // an index of this store's own lane the counter passed (the lost store drew the same lane)
  const j = ownLane(w.lane, 1);
  const m = await ns.planFound(SCOPE, j, pc, read(j));
  assert.equal(m.state, "PLANNED");
  // the scope's one unfunded index is still the sign-in's, named again; the found notes are funded, never named
  assert.equal((await ns.planDeposit(SCOPE, pc)).id, mine.id);
  // the found note goes on as any planned deposit note does (pool.deposit's fixed source: PLANNED -> INCOMING)
  await ns.move(n.id, "PLANNED", "INCOMING");
  await ns.move(mine.id, "PLANNED", "INCOMING");
  const next = await ns.planDeposit(SCOPE, pc);
  assert.notEqual(next.id, m.id, "a found note left PLANNED is never the next quote's index");
  assert.equal((next.ref as { i: number }).i % 8, w.lane);
});

test("notes-plan-at-restored-index: a store that holds i is refused", async () => {
  const { w, ns } = await tab();
  const mine = await ns.planDeposit(SCOPE, pc);
  const i = (mine.ref as { i: number }).i;
  await w.raiseDepositIndex(SCOPE, ownLane(w.lane, 3));
  await assert.rejects(ns.planFound(SCOPE, i, pc, read(i)), /already a note/);
  const k = otherLane(w.lane, 2);
  await ns.planFound(SCOPE, k, pc, read(k));
  await assert.rejects(ns.planFound(SCOPE, k, pc, read(k)), /already a note/, "a second write of a found index");
  assert.equal((await ns.list()).length, 2);
});

test("notes-plan-at-restored-index: an index of the store's lane the scope's counter has not passed is refused", async () => {
  const { w, ns } = await tab();
  // no counter yet: nothing of the lane reserved, so its first index is one planDeposit names
  await assert.rejects(ns.planFound(SCOPE, ownLane(w.lane, 0), pc, read(ownLane(w.lane, 0))), /not under the scope's counter/);
  await w.raiseDepositIndex(SCOPE, ownLane(w.lane, 2));
  for (const k of [2, 5]) await assert.rejects(ns.planFound(SCOPE, ownLane(w.lane, k), pc, read(ownLane(w.lane, k))), /not under the scope's counter/);
  assert.deepEqual(await ns.list(), [], "nothing written");
  // under the counter: written
  assert.equal((await ns.planFound(SCOPE, ownLane(w.lane, 1), pc, read(ownLane(w.lane, 1)))).state, "PLANNED");
});

test("notes-plan-at-restored-index: a one-provider read, two providers apart or a read of no money is refused", async () => {
  const { w, ns } = await tab();
  const i = otherLane(w.lane, 1);
  for (const [amounts, why] of [
    [[1_000_000n], /two providers' balances/],
    [[1_000_000n, undefined], /two providers' balances/],
    [[1_000_000n, null], /two providers' balances/],
    [[1_000_000n, 1_000_000n, 1_000_000n], /two providers' balances/],
    [[1_000_000n, 999_999n], /no agreed balance/],
    [[0n, 0n], /no money/],
    [[-1n, -1n], /no money/],
  ] as const)
    await assert.rejects(ns.planFound(SCOPE, i, pc, read(i, amounts as readonly bigint[])), why);
  await assert.rejects(ns.planFound(SCOPE, i, pc, null as never), /an object/);
  await assert.rejects(ns.planFound(SCOPE, i, pc, read(i + 8)), /not of deposit index/);
  await assert.rejects(ns.planFound(SCOPE, i, pc, read(i, undefined, SCOPE + 1n)), /not of deposit index/);
  assert.deepEqual(await ns.list(), [], "nothing written");
});
