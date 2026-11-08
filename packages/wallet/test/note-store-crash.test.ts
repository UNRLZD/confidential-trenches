// P-01's crash cases for the note store's part (card wallet-note-store; docs/plan1/wallet.md:1060 at research 7838dbe,
// the card's W:1051 at ffcba5e): deposit, arm and withdraw with the page killed after every single step, and a relayer
// that holds a withdrawal up to and past its deadline. After every reopen: no note counted twice, no note lost, no
// index repeated, at most one unfunded deposit index per scope; at the end, the same notes as a run with no kill.
//   node --test test/note-store-crash.test.ts      (from packages/wallet)
//
// What a step is: every durable write the page makes (each wallet-store put, each counter reservation) and every act of
// the world outside (the user's send reaching U, a deposit landing, a proof sent to the relayer, the relayer acting,
// block time passing). A kill after step k throws out of the page with nothing after it run, closes the wallet store and
// drops everything the page held in memory (its proofs); the page then reopens on the same database and goes on from
// what the store and the chain say. Node has no tab to crash, so the kill is this throw plus the close
// (as test/store.test.ts says of its own), and a write cut part way is test/note-store.test.ts's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, refKey, type Leaf, type NoteRecord, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const pcCache = new Map<string, bigint>();
const pc = (ref: NoteRef): bigint => {
  const k = refKey(ref);
  if (!pcCache.has(k)) pcCache.set(k, noteSecrets(SEED, ref).precommitment);
  return pcCache.get(k)!;
};
const SCOPE = 0x2a5f0e3c1d9b7a6e4c3b2a1908f7e6d5c4b3a2918f7e6d5c4b3a291807060504n;
const WINDOW = 600_000n; // deadline_ms = T + 600,000 - r (wallet.md §2.5 step 5)

class Kill extends Error {}

// The chain and the people outside the device. It outlives every kill.
// refuseFirst: the first proof sent fails. lateLand: the relayer answers "refused" and lands it at its deadline anyway;
// otherwise it holds the proof past its deadline and the vault refuses it
type Goal = { value: bigint; arm: bigint; refuseFirst: boolean; lateLand?: boolean };
class World {
  now = 1_800_000_000_000n;
  goals: Goal[];
  goalOf = new Map<bigint, number>(); // a deposit's precommitment -> its goal
  funded = new Map<bigint, bigint>(); // precommitment -> what reached U
  leaves = new Map<bigint, Leaf>(); // precommitment -> its leaf in the vault
  spent = new Set<bigint>(); // precommitments whose nullifier hash is in the spent set
  relayer = new Map<bigint, { deadline: bigint; changePc: bigint; amount: bigint }>(); // proofs the relayer holds
  refused = new Set<bigint>();
  claimed = new Set<bigint>(); // the relayer has answered "refused" for this note's proof
  dropped = new Set<bigint>(); // the user changed the amount once on this change note's withdrawal form
  paidOut = 0n;
  nextLeaf = 0n;
  attempts = 0; // each attempt's own context
  steps = 0;
  killAt = new Set<number>();
  constructor(goals: Goal[]) {
    this.goals = goals;
  }
  tick(): void {
    if (this.killAt.has(++this.steps)) throw new Kill(`killed after step ${this.steps}`);
  }
  land(precommitment: bigint, value: bigint, label: bigint): void {
    const leafIndex = this.nextLeaf++;
    this.leaves.set(precommitment, { value, label, commitment: noteCommitment(value, label, precommitment), leafIndex });
  }
}

const changeRef = (p: NoteRecord): NoteRef => ({ kind: "change", l: p.leaf!.label, j: d.changeIndex(p.ref.kind === "change" ? { kind: "change", j: p.ref.j } : { kind: "deposit" }) });

// The page: one act per call, chosen only from the store and the chain (and the proofs it holds in memory, which a kill
// drops). Returns false once every goal is met.
async function act(ns: NoteStore, world: World, proofs: Map<string, string>): Promise<boolean> {
  const all = await ns.list();
  // money in
  for (const n of all.filter((x) => x.state === "PLANNED" || x.state === "INCOMING")) {
    if (n.state === "PLANNED" && world.funded.has(n.precommitment)) return (await ns.move(n.id, "PLANNED", "INCOMING"), true);
    if (n.state === "INCOMING") {
      const leaf = world.leaves.get(n.precommitment);
      if (leaf) return (await ns.move(n.id, "INCOMING", "UNSPENT", { leaf }), true);
      world.land(n.precommitment, world.funded.get(n.precommitment)!, 1000n + BigInt(world.goalOf.get(n.precommitment)!)); // U's deposit call lands
      return (world.tick(), true);
    }
  }
  if (world.funded.size < world.goals.length) {
    // the deposit screen asks the store for its index on every quote: the open one, or a new one written first
    const n = await ns.planDeposit(SCOPE, pc);
    if (!all.some((x) => x.id === n.id)) return true;
    const g = world.funded.size; // the user's next outside send reaches U
    world.funded.set(n.precommitment, world.goals[g]!.value);
    world.goalOf.set(n.precommitment, g);
    return (world.tick(), true);
  }
  // proofs and withdrawals
  for (const n of all) {
    const goal = world.goalOf.get(n.precommitment);
    if (n.state === "UNSPENT") {
      const arm = n.ref.kind === "deposit" && goal !== undefined;
      const drop = n.ref.kind === "change" && n.leaf!.value > 0n && !world.dropped.has(n.precommitment);
      if (arm || drop) {
        const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: world.now + WINDOW, context: String(++world.attempts) });
        proofs.set(held.id, held.attempt!);
        return true;
      }
    }
    if (n.state === "HELD") {
      // a HELD note always has its proof in this page: one held by a killed page was freed at the open
      assert.ok(proofs.has(n.id), "a dead page's HELD note survived the open");
      if (n.ref.kind === "change") {
        await ns.move(n.id, "HELD", "UNSPENT", { attempt: proofs.get(n.id) }); // the user changed the amount: dropped
        proofs.delete(n.id);
        world.dropped.add(n.precommitment);
        return true;
      }
      return (await ns.move(n.id, "HELD", "RESERVED", { attempt: proofs.get(n.id) }), true); // written before the proof leaves
    }
    if (n.state === "RESERVED") {
      if (world.spent.has(n.precommitment)) {
        const ref = changeRef(n);
        const leaf = world.leaves.get(pc(ref))!;
        await ns.add({ ref, scope: n.scope, precommitment: pc(ref), state: "UNSPENT", leaf, parent: n.id });
        return true;
      }
      if (proofs.has(n.id)) {
        // sent: the relayer holds it
        world.relayer.set(n.precommitment, { deadline: n.deadlineMs!, changePc: pc(changeRef(n)), amount: world.goals[goal!]!.arm });
        proofs.delete(n.id);
        return (world.tick(), true);
      }
      const held = world.relayer.get(n.precommitment);
      if (held) {
        const refuse = world.goals[goal!]!.refuseFirst && !world.refused.has(n.precommitment);
        const late = world.goals[goal!]!.lateLand === true;
        if (refuse && late && !world.claimed.has(n.precommitment)) {
          // the relayer answers "refused" but still holds the proof: that word frees nothing (F1)
          world.claimed.add(n.precommitment);
          await assert.rejects(ns.move(n.id, "RESERVED", "UNSPENT", { blockTimeMs: world.now }), /can still land/);
          return (world.tick(), true);
        }
        world.relayer.delete(n.precommitment);
        if (refuse && late) {
          // ... and lands it at its deadline
          world.refused.add(n.precommitment);
          world.now = held.deadline;
          world.spent.add(n.precommitment);
          world.paidOut += held.amount;
          world.land(held.changePc, n.leaf!.value - held.amount, n.leaf!.label);
        } else if (refuse) {
          // the relayer holds it past its deadline: the vault refuses it then
          world.refused.add(n.precommitment);
          world.now = held.deadline + 1n;
        } else if (world.now <= held.deadline) {
          world.spent.add(n.precommitment);
          world.paidOut += held.amount;
          world.land(held.changePc, n.leaf!.value - held.amount, n.leaf!.label);
        }
        return (world.tick(), true);
      }
      if (world.now <= n.deadlineMs!) {
        await assert.rejects(ns.move(n.id, "RESERVED", "UNSPENT", { blockTimeMs: world.now }), /can still land/, "freed before its deadline");
        return ((world.now = n.deadlineMs! + 1n), world.tick(), true);
      }
      return (await ns.move(n.id, "RESERVED", "UNSPENT", { blockTimeMs: world.now }), true); // past its deadline, nothing landed
    }
  }
  return false;
}

// Every write the page makes is a step.
function counted(w: WalletStore, world: World): WalletStore {
  return {
    ...w,
    put: async (s, k, v) => {
      await w.put(s, k, v);
      world.tick();
    },
    reserveDepositIndex: async (scope) => {
      const i = await w.reserveDepositIndex(scope);
      world.tick();
      return i;
    },
  };
}

const counts = (s: string) => s === "UNSPENT" || s === "HELD"; // what the balance shows in the vault

// The checks after a reopen: P-01 for the store's part.
function check(all: NoteRecord[], world: World, lane: number, at: string): void {
  const keys = all.map((n) => refKey(n.ref));
  assert.equal(new Set(keys).size, keys.length, `${at}: an index repeats`);
  assert.equal(new Set(all.map((n) => n.precommitment)).size, all.length, `${at}: a precommitment repeats`);
  for (const n of all) if (n.ref.kind === "deposit") assert.equal(n.ref.i % 8, lane, `${at}: index out of the lane`);
  assert.ok(all.filter((n) => n.ref.kind === "deposit" && n.state === "PLANNED").length <= 1, `${at}: two unfunded deposit indices`);
  const byPc = new Map(all.map((n) => [n.precommitment, n]));
  const byId = new Map(all.map((n) => [n.id, n]));
  // no double count: a note the balance counts is in the vault and unspent, and never next to its own change
  for (const n of all.filter((x) => counts(x.state))) {
    assert.ok(world.leaves.has(n.precommitment) && !world.spent.has(n.precommitment), `${at}: ${n.state} note not in the vault`);
    for (const c of all) assert.ok(c.parent !== n.id, `${at}: a note counted next to its change`);
  }
  for (const n of all) if (n.parent !== undefined) assert.equal(byId.get(n.parent)?.state, "SPENT", `${at}: a parent not SPENT`);
  // no lost note: every own leaf not spent and every send that reached U is a record, or the change of a RESERVED one,
  // which the open's read of the spends record finds
  const changeOf = new Map(all.filter((n) => n.state === "RESERVED").map((n) => [pc(changeRef(n)), n]));
  for (const p of world.funded.keys()) assert.ok(byPc.has(p), `${at}: a deposit that reached U has no note`);
  for (const p of world.leaves.keys()) {
    if (world.spent.has(p)) continue;
    assert.ok(byPc.has(p) || (changeOf.has(p) && world.spent.has(changeOf.get(p)!.precommitment)), `${at}: a note in the vault is lost`);
  }
  // money: what the balance counts is never more than what the vault holds for the user
  const shown = all.filter((n) => counts(n.state)).reduce((a, n) => a + n.leaf!.value, 0n);
  const inVault = [...world.leaves].filter(([p]) => !world.spent.has(p)).reduce((a, [, l]) => a + l.value, 0n);
  assert.ok(shown <= inVault, `${at}: the balance shows ${shown}, the vault holds ${inVault}`);
}

// One run: kill after every step in `killAt`, reopen, check, go on until done.
async function run(goals: Goal[], killAt: number[]): Promise<{ world: World; final: NoteRecord[]; reopens: number }> {
  const idb = new IDBFactory();
  const world = new World(goals);
  world.killAt = new Set(killAt);
  let reopens = 0;
  for (let guard = 0; guard < 50; guard++) {
    const w = await openWalletStore({ indexedDB: idb });
    const proofs = new Map<string, string>(); // the page's memory (note id -> attempt): gone at a kill
    let ns: NoteStore | undefined;
    try {
      ns = await openNoteStore(counted(w, world)); // the open finishes what a killed page left
      const all = await ns.list();
      check(all, world, w.lane, `open ${reopens} at step ${world.steps}`);
      assert.ok(!all.some((n) => n.state === "HELD"), `open ${reopens}: a killed page's HELD note was not freed at once`);
      for (let n = 0; await act(ns, world, proofs); n++) assert.ok(n < 500, "the page never finishes");
      const final = await ns.list();
      check(final, world, w.lane, "end");
      ns.close?.();
      w.close();
      return { world, final, reopens };
    } catch (e) {
      ns?.close?.(); // a killed page's locks go with it
      w.close();
      if (!(e instanceof Kill)) throw e;
      reopens++;
    }
  }
  throw new Error("too many reopens");
}

// The end state any run reaches: every deposit armed once and SPENT, one change note per deposit holding the rest.
function endState(goals: Goal[], r: Awaited<ReturnType<typeof run>>): void {
  const summary = r.final.map((n) => `${n.ref.kind}:${n.state}:${n.leaf?.value}`).sort();
  const want = goals.flatMap((g) => [`deposit:SPENT:${g.value}`, `change:UNSPENT:${g.value - g.arm}`]).sort();
  assert.deepEqual(summary, want);
  assert.equal(r.world.paidOut, goals.reduce((a, g) => a + g.arm, 0n), "each arm paid out once");
  assert.equal(r.world.relayer.size, 0);
}

const GOALS: Goal[] = [
  { value: 102_070_000_000_000_000_000_000_000n, arm: 100_000_000_000_000_000_000_000_000n, refuseFirst: true },
  { value: 20_120_000n, arm: 20_120_000n, refuseFirst: true, lateLand: true }, // a change note of value 0
];

test("P-01 (store part): a kill after every single step, then reopen: no double count, no lost note, the same end", async () => {
  const ref = await run(GOALS, []);
  endState(GOALS, ref);
  const total = ref.world.steps;
  assert.ok(total > 30, `the run has ${total} steps`);
  for (let k = 1; k <= total; k++) {
    const r = await run(GOALS, [k]);
    assert.equal(r.reopens, 1, `kill after step ${k} did not happen`);
    endState(GOALS, r);
  }
});

// card fresh-run-margin: the default run takes the seeded sequence's first 30 runs; FULL_RUNS=1 (the package's
// test:mutants script, run by CI's test-mutants split) all 300
const RUNS = process.env.FULL_RUNS === "1" ? 300 : 30;
test(`P-01 (store part): kills at random steps, several per run, ${RUNS} runs`, async () => {
  let seed = 0x5eed;
  const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) % n;
  const big = (): bigint => BigInt(1 + rnd(1_000_000)) * 10n ** BigInt(rnd(25));
  for (let k = 0; k < RUNS; k++) {
    const goals: Goal[] = [];
    for (let g = 0, n = 1 + rnd(3); g < n; g++) {
      const value = big();
      goals.push({ value, arm: (value * BigInt(1 + rnd(100))) / 100n, refuseFirst: rnd(2) === 0, lateLand: rnd(2) === 0 });
    }
    const kills = Array.from({ length: rnd(4) }, () => 1 + rnd(60));
    endState(goals, await run(goals, kills));
  }
});
