// node --test packages/wallet/test/pool-queue-pieces.test.ts: the proof queue for a pool whose buy pays one W from
// several notes (card buy-spends-several-pieces, src/pool/queue.ts "Pieces"): tier 1, each ready note's proof on its own
// W as on a pool of one piece; tier 2, made only once tier 1 has nothing left to make, a second proof of the largest
// other notes bound to the primary's W (the ready note with the largest chunk). A buy that takes one note leaves every
// other tier 1 proof ready; tier 2 is made again for the next primary. The notes are withdraw-fixture.ts's (the
// all-zero test seed, a fixture vault); the prover answers the signals without proving.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VAULT_FIELD_P, VaultTree, type VaultProver } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import type { NoteRef } from "../src/notes/secrets.ts";
import type { NoteRecord } from "../src/notes/store.ts";
import { USDC_LADDER } from "../src/pool/near.ts";
import type { Pool, PoolBindArgs, PoolTrees, ReadyProof } from "../src/pool/pool.ts";
import { openProofQueue, type ProofQueue } from "../src/pool/queue.ts";
import { poolBalances, type BalancePool, type TapSpendOf } from "../src/pool/balances.ts";
import { buyWalletsOf } from "../src/pool/buy-wallets.ts";
import { BLOCK_MS, closeVaults, SCOPE, SEED, signalsProver, vaultWith, type Vault } from "./withdraw-fixture.ts";

after(closeVaults);
const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
const E = 60_000n;
const START = BigInt(BLOCK_MS) - (BigInt(BLOCK_MS) % E);

/** A pool on the fixture vault, every leaf landed an hour before START, with piecesMax pieces a buy; `t.now` its time. */
function piecesPool(v: Vault, piecesMax = 4): Pool<{ n: number }> & { binds: PoolBindArgs[]; t: { now: bigint } } {
  const binds: PoolBindArgs[] = [];
  const t = { now: START + 1_000n };
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
    t,
    now: async () => t.now,
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
function queue<R>(v: Vault, pool: Pool<R>): ProofQueue<R> {
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool, provers: [signalsProver() as VaultProver], hardwareConcurrency: 16 });
  open.push(q as ProofQueue<unknown>);
  return q;
}
const jOf = (ref: NoteRef): number => (ref.kind === "change" ? ref.j + 1 : 0);
const W = (n: NoteRecord): string => {
  const w = d.freshWallet(SEED, "sol", n.leaf!.label, jOf(n.ref));
  w.secretKey.fill(0);
  return w.address;
};
/** A planted Max rule: each piece adds its chunk less its fee cap, the set pays 1,000 once. */
const sumLess: TapSpendOf = (ps) => ps.reduce((a, p) => a + p.chunk - p.feeCap, 0n) - 1_000n;
const BAL: BalancePool = { id: "test:pieces", chain: "solana", scope: SCOPE, asset: "SOL", spendOf: sumLess };
const VALUES = [usd(2), usd(5.5), usd(10), usd(20)];
/** The note of leaf value `x`. */
const noteOf = async (v: Vault, x: bigint): Promise<NoteRecord> => (await v.ns.list()).find((n) => n.leaf?.value === x)!;
/** The note's tier 1 proof (its own W) and its tier 2 proof (another note's W), as ready() lists them. */
const tiers = (q: ProofQueue<unknown>, id: string): { own?: ReadyProof<unknown>; piece?: ReadyProof<unknown> } => {
  const rs = q.ready().filter((r) => r.noteId === id);
  return { own: rs.find((r) => r.own === true), piece: rs.find((r) => r.own !== true) };
};
const bal = async (v: Vault, q: ProofQueue<unknown>) => poolBalances(await v.ns.list(), [BAL], q.ready())[0]!;

test("tiers: each ready note's proof pays its own W (tier 1); in the same pass the largest other notes get a second proof to the primary's W (tier 2), and the restore finds that W", async () => {
  const v = await vaultWith(VALUES);
  const pool = piecesPool(v);
  const q = queue(v, pool as Pool<unknown>);
  const first = await q.refresh();
  const P = await noteOf(v, usd(20));
  // one pass makes both tiers: the primary (the 20 note) and its three pieces, then the other own proofs
  assert.deepEqual(first.remade, []);
  assert.equal(first.made.length, 6);
  assert.equal(first.made.filter((id) => id === P.id).length, 1, "the primary needs no second proof: its own is the set's own");
  // tier 1 as a pool of one piece: readySetSize(16) = 3, the largest chunks (20, 10 and the 5.5 note's 5), each its own W
  const one = q.ready().filter((r) => r.own === true);
  assert.deepEqual(one.map((r) => r.chunk).sort((a, b) => (a < b ? -1 : 1)), [usd(5), usd(10), usd(20)]);
  for (const r of one) {
    const n = (await v.ns.get(r.noteId))!;
    assert.equal(r.wallet.address, W(n), `the ${r.chunk} proof pays its own note's W`);
  }
  // tier 2: up to piecesMax - 1 = 3 others, the largest: 10, 5.5 and 2
  const pieces = q.ready().filter((r) => r.own !== true);
  assert.equal(pieces.length, 3);
  for (const r of pieces) assert.equal(r.wallet.address, W(P), "a tier 2 proof pays the primary's W");
  for (const x of [usd(10), usd(5.5)]) {
    const n = await noteOf(v, x);
    const t = tiers(q as ProofQueue<unknown>, n.id);
    assert.equal(n.state, "HELD");
    // its tier 2 proof, made first, holds it; its tier 1 proof is its second attempt (the store takes either alike)
    assert.equal(n.attempt, t.piece!.attempt, "its tier 2 proof holds it");
    assert.equal(n.second?.attempt, t.own!.attempt, "and its tier 1 proof is its second attempt");
  }
  const two = await noteOf(v, usd(2));
  assert.equal(two.attempt, tiers(q as ProofQueue<unknown>, two.id).piece!.attempt, "a note out of tier 1 is held by its tier 2 proof alone");
  // every W a buy can pay is a spent note's own: a tier 2 set always spends the primary
  const restored = buyWalletsOf(SEED, [{ id: pool.id, chain: "sol", spent: [P, two].map((n) => ({ ref: n.ref, label: n.leaf!.label })) }]);
  assert.deepEqual(restored.failed, []);
  assert.ok(restored.wallets.some((x) => x.address === W(P)));
  // Max: the primary and its three pieces, 37 less four fees and the 1,000 once, over the 20 alone; each note ready once
  const b = await bal(v, q as ProofQueue<unknown>);
  assert.equal(b.ready, "0.037");
  assert.equal(b.tap_max, "0.036599");
  // nothing more to make
  assert.deepEqual(await q.refresh(), { made: [], remade: [], failed: [] });
});

test("tiers: after a buy takes one note's tier 1 proof, every other tier 1 proof is still ready and takeable with no remake; tier 2 is made again for the next primary", async () => {
  const v = await vaultWith(VALUES);
  const pool = piecesPool(v);
  const q = queue(v, pool as Pool<unknown>);
  await q.refresh();
  const [P, X, Y, Z] = await Promise.all([usd(20), usd(10), usd(5.5), usd(2)].map((x) => noteOf(v, x)));
  const before = new Map(q.ready().filter((r) => r.own === true).map((r) => [r.noteId, r.attempt]));
  // a buy the primary's note pays alone: one piece
  const taken = await q.take(P!.id, before.get(P!.id));
  assert.equal(taken.own, true);
  assert.equal((await v.ns.get(P!.id))!.state, "RESERVED");
  // no pass between: the others' tier 1 proofs are the same attempts, still ready
  for (const n of [X!, Y!]) assert.equal(tiers(q as ProofQueue<unknown>, n.id).own?.attempt, before.get(n.id), "no remake");
  // the balances right after the buy: the 10 and the 5.5 notes' own proofs; the 2 note's only proof pays a W whose note
  // is taken, so it is not ready, and nothing says "ready" with Max 0
  const b = await bal(v, q as ProofQueue<unknown>);
  assert.equal(b.ready, "0.015");
  assert.equal(b.tap_max, "0.009899");
  // and takeable at once, with no pass: the 5.5 note's
  assert.equal((await q.take(Y!.id, before.get(Y!.id))).noteId, Y!.id);
  // the next pass makes tier 2 for the new primary, the 10 note, first (its own old piece goes, the 2 note's piece is
  // made again for the 10's W), then fills tier 1 (the 2 note joins, beside its tier 2 proof)
  const fill = await q.refresh();
  assert.deepEqual(fill.remade, [Z!.id]);
  assert.deepEqual(fill.made, [Z!.id]);
  assert.deepEqual(await q.refresh(), { made: [], remade: [], failed: [] });
  assert.equal(tiers(q as ProofQueue<unknown>, X!.id).piece, undefined, "the primary keeps its own proof only");
  assert.equal((await v.ns.get(X!.id))!.second, undefined);
  assert.equal((await v.ns.get(X!.id))!.attempt, before.get(X!.id), "and that proof was never made again");
  assert.equal(tiers(q as ProofQueue<unknown>, Z!.id).piece!.wallet.address, W(X!));
  const after = await bal(v, q as ProofQueue<unknown>);
  assert.equal(after.ready, "0.012");
  assert.equal(after.tap_max, "0.011799", "the 10 and the 2 to the 10's W: 12 less two fees and the 1,000");
});

test("tiers: tier 2 holds at most piecesMax - 1 notes, and a pool of one piece makes none", async () => {
  const v = await vaultWith([usd(2), usd(5), usd(10), usd(20), usd(50), usd(100)]);
  const q = queue(v, piecesPool(v, 4) as Pool<unknown>);
  await q.refresh();
  const P = await noteOf(v, usd(100));
  const pieces = q.ready().filter((r) => r.own !== true);
  assert.deepEqual(pieces.map((r) => r.chunk).sort((a, b) => (a < b ? -1 : 1)), [usd(10), usd(20), usd(50)]);
  for (const r of pieces) assert.equal(r.wallet.address, W(P));
  // the notes past the room hold their own proof alone (card balance-shows-fast: every note spendable in one tap's legs)
  for (const x of [usd(2), usd(5)]) {
    const n = await noteOf(v, x);
    assert.equal(n.state, "HELD");
    assert.deepEqual(q.ready().filter((r) => r.noteId === n.id).map((r) => r.own), [true]);
  }
  const v1 = await vaultWith(VALUES);
  const q1 = queue(v1, piecesPool(v1, 1) as Pool<unknown>);
  await q1.refresh();
  assert.deepEqual(await q1.refresh(), { made: [], remade: [], failed: [] });
  assert.ok(q1.ready().every((r) => r.own === true));
});

test("tiers: a note with both proofs is sent once: taking either leaves the other untakeable, in the queue and in the store", async () => {
  for (const by of ["own", "piece"] as const) {
    const v = await vaultWith(VALUES);
    const q = queue(v, piecesPool(v) as Pool<unknown>);
    await q.refresh();
    await q.refresh();
    const [P, X] = await Promise.all([usd(20), usd(10)].map((x) => noteOf(v, x)));
    const t = tiers(q as ProofQueue<unknown>, X!.id);
    const p = tiers(q as ProofQueue<unknown>, P!.id).own!;
    const [won, lost] = by === "own" ? [t.own!, t.piece!] : [t.piece!, t.own!];
    if (by === "own") await q.take(X!.id, won.attempt, undefined, 50n);
    else await q.takeSet([{ noteId: X!.id, attempt: won.attempt }, { noteId: P!.id, attempt: p.attempt }], undefined, 50n);
    const n = (await v.ns.get(X!.id))!;
    assert.equal(n.state, "RESERVED");
    assert.equal(n.attempt, won.attempt, `${by}: RESERVED by the proof taken`);
    assert.equal(n.contexts!.at(-1)!.context, won.binding.context.toString(), `${by}: its context last`);
    assert.ok(!n.contexts!.some((c) => c.context === lost.binding.context.toString()), `${by}: the other's unsent context gone`);
    assert.equal(q.ready().some((r) => r.noteId === X!.id), false, `${by}: no proof of the note left in the queue`);
    await assert.rejects(q.take(X!.id, lost.attempt), /no ready proof|another attempt/);
    await assert.rejects(q.takeSet([{ noteId: X!.id, attempt: lost.attempt }]), /no ready proof|another attempt/);
    await assert.rejects(v.ns.move(X!.id, "HELD", "RESERVED", { attempt: lost.attempt }), /RESERVED, not HELD/);
  }
});

test("takeSet, two at once on one note (its tier 1 and its tier 2 proof): one wins, the other is refused, nothing RESERVED twice", async () => {
  const v = await vaultWith(VALUES);
  const q = queue(v, piecesPool(v) as Pool<unknown>);
  await q.refresh();
  await q.refresh();
  const [P, X] = await Promise.all([usd(20), usd(10)].map((x) => noteOf(v, x)));
  const t = tiers(q as ProofQueue<unknown>, X!.id);
  const p = tiers(q as ProofQueue<unknown>, P!.id).own!;
  const got = await Promise.allSettled([q.takeSet([{ noteId: X!.id, attempt: t.piece!.attempt }, { noteId: P!.id, attempt: p.attempt }], undefined, 60n), q.takeSet([{ noteId: X!.id, attempt: t.own!.attempt }], undefined, 61n)]);
  assert.equal(got.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(String((got.find((x) => x.status === "rejected") as PromiseRejectedResult).reason), /no ready proof|another attempt/);
  const n = (await v.ns.get(X!.id))!;
  assert.equal(n.state, "RESERVED");
  const marks = await v.ns.marks();
  if (got[0]!.status === "fulfilled") {
    assert.equal(n.attempt, t.piece!.attempt);
    assert.equal((await v.ns.get(P!.id))!.state, "RESERVED");
    assert.equal(marks.get(X!.id)?.lastHeight, 60n);
  } else {
    assert.equal(n.attempt, t.own!.attempt);
    assert.equal((await v.ns.get(P!.id))!.state, "HELD", "the losing set's other note is not RESERVED");
    assert.equal(tiers(q as ProofQueue<unknown>, P!.id).own, p, "and its proof is still ready");
    assert.equal(marks.get(X!.id)?.lastHeight, 61n);
  }
});

test("takeSet's late proof: its attempt let go and made again, the set's others HELD with their proofs ready, nothing RESERVED; the note keeps its tier 1 proof", async () => {
  const v = await vaultWith(VALUES);
  const pool = piecesPool(v);
  // the prover refuses the remake of the 10 note's tier 2 proof (planted below), so that proof stays from before the
  // previous epoch while the rest is made again
  const inner = signalsProver();
  const refuse = new Set<string>();
  const prover: VaultProver = { load: inner.load, prove: async (c, i) => {
    if (refuse.has(String((i as { context?: unknown }).context))) throw new Error("planted: this proof fails");
    return inner.prove(c, i);
  } };
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool: pool as Pool<unknown>, provers: [prover], hardwareConcurrency: 16 });
  open.push(q as ProofQueue<unknown>);
  await q.refresh();
  const [P, X] = await Promise.all([usd(20), usd(10)].map((x) => noteOf(v, x)));
  const old = tiers(q as ProofQueue<unknown>, X!.id).piece!;
  // two epochs on: every proof is made again but the 10 note's tier 2 one, which is from before the previous epoch
  pool.t.now = START + 2n * E + 1_000n;
  const bind = pool.bind.bind(pool);
  pool.bind = async (b, sg) => {
    const r = await bind(b, sg);
    if (b.wallet.address === W(P!) && b.chunk === usd(10)) refuse.add(r.context.toString());
    return r;
  };
  const turn = await q.refresh();
  assert.equal(turn.remade.length, 5);
  assert.deepEqual(turn.failed.map((f) => f.noteId), [X!.id]);
  const p = tiers(q as ProofQueue<unknown>, P!.id).own!;
  const own = tiers(q as ProofQueue<unknown>, X!.id).own!;
  assert.equal(p.epochStartMs, START + 2n * E);
  await assert.rejects(q.takeSet([{ noteId: X!.id, attempt: old.attempt }, { noteId: P!.id, attempt: p.attempt }], undefined, 70n), /before the previous epoch: it is made again first/);
  const n = (await v.ns.get(X!.id))!;
  assert.equal(n.state, "HELD");
  assert.equal(n.attempt, own.attempt, "held by its tier 1 proof");
  assert.equal(n.second, undefined, "the late attempt let go");
  assert.equal(tiers(q as ProofQueue<unknown>, X!.id).own, own, "its tier 1 proof still ready");
  assert.equal((await v.ns.get(P!.id))!.state, "HELD");
  assert.equal(tiers(q as ProofQueue<unknown>, P!.id).own, p);
  for (const m of await v.ns.list()) assert.notEqual(m.state, "RESERVED");
  // the next pass, the prover no longer refusing, makes tier 2 again on this epoch
  pool.bind = bind;
  const next = await q.refresh();
  assert.ok(next.made.includes(X!.id), JSON.stringify(next));
  assert.equal(tiers(q as ProofQueue<unknown>, X!.id).piece!.epochStartMs, START + 2n * E);
});

test("takeSet, a write failing part way: the ones before it RESERVED with the last height, the failing one's attempt let go (its note HELD by its other proof), the rest HELD", async () => {
  const v = await vaultWith(VALUES);
  const q = queue(v, piecesPool(v) as Pool<unknown>);
  await q.refresh();
  await q.refresh();
  const [P, X, Y] = await Promise.all([usd(20), usd(10), usd(5.5)].map((x) => noteOf(v, x)));
  const x = tiers(q as ProofQueue<unknown>, X!.id), y = tiers(q as ProofQueue<unknown>, Y!.id);
  const p = tiers(q as ProofQueue<unknown>, P!.id).own!;
  v.failPut.on = (rec) => (rec as { id?: string; state?: string }).id === Y!.id && (rec as { state?: string }).state === "RESERVED";
  await assert.rejects(q.takeSet([{ noteId: X!.id, attempt: x.piece!.attempt }, { noteId: Y!.id, attempt: y.piece!.attempt }, { noteId: P!.id, attempt: p.attempt }], undefined, 77n), /refused the write/);
  v.failPut.on = undefined;
  const nx = (await v.ns.get(X!.id))!, ny = (await v.ns.get(Y!.id))!, np = (await v.ns.get(P!.id))!;
  assert.equal(nx.state, "RESERVED");
  assert.equal(nx.attempt, x.piece!.attempt);
  assert.equal((await v.ns.marks()).get(X!.id)?.lastHeight, 77n);
  assert.equal(ny.state, "HELD");
  assert.equal(ny.attempt, y.own!.attempt, "the failing one's attempt let go, its tier 1 proof holds it");
  assert.equal(ny.second, undefined);
  assert.equal(tiers(q as ProofQueue<unknown>, Y!.id).own, y.own, "and is still ready");
  assert.equal(np.state, "HELD");
  assert.equal(np.attempt, p.attempt);
  assert.equal(tiers(q as ProofQueue<unknown>, P!.id).own, p);
});

test("takeSet: one attempt that is not the ready one is refused before any write; a note twice is refused; the set is RESERVED whole, in the order given", async () => {
  const v = await vaultWith(VALUES);
  const q = queue(v, piecesPool(v) as Pool<unknown>);
  await q.refresh();
  await q.refresh();
  const P = await noteOf(v, usd(20));
  const set = q.ready().filter((r) => r.wallet.address === W(P));
  assert.equal(set.length, 4);
  assert.equal(set.filter((r) => r.own === true).length, 1, "one own proof in the primary's set: the primary's");
  const items = [...set.filter((r) => r.own !== true), set.find((r) => r.own === true)!].map((r) => ({ noteId: r.noteId, attempt: r.attempt }));
  const state = async (id: string) => (await v.ns.get(id))!.state;
  await assert.rejects(q.takeSet([...items.slice(0, -1), { ...items.at(-1)!, attempt: "another" }], undefined, 99n), /another attempt/);
  for (const r of set) assert.equal(await state(r.noteId), "HELD");
  assert.equal(q.ready().length, 6);
  await assert.rejects(q.takeSet([items[0]!, items[0]!]), /each once/);
  const got = await q.takeSet(items, undefined, 99n);
  assert.deepEqual(got.map((r) => r.noteId), items.map((x) => x.noteId));
  for (const r of set) assert.equal(await state(r.noteId), "RESERVED");
  assert.equal(q.ready().length, 0, "the tier 1 proofs of the notes taken go with them");
});

// an empty pool's first leaves, landed this epoch: the pool's trees refuse the epoch cut (PoolNoLeafError, as wallet
// pool/evm.ts and solana.ts do). Tier 2's own epoch read (src/pool/queue.ts, on a pass whose tier 1 read none) takes it as
// trees of no leaf too, so the pieces are made on the newest root in their first minute, never a failed pass; both tiers
// run in one pass (card max-ready-seconds-after-a-load), so one epoch read serves them
test("tiers on an empty pool's first leaves: the epoch cut refused as no leaf, tier 1 and then tier 2 are made on the newest root (before: tier 2's pass threw)", async () => {
  const { PoolNoLeafError } = await import("../src/pool/pool.ts");
  const v = await vaultWith(VALUES);
  const pool = piecesPool(v);
  const all = pool.trees;
  const cuts: boolean[] = [];
  pool.trees = async (before, signal, opts) => {
    cuts.push(opts?.newest === true);
    if (opts?.newest !== true) throw new PoolNoLeafError(`no leaf before ${before}`);
    return all(before, signal, opts);
  };
  const q = queue(v, pool as Pool<unknown>);
  const first = await q.refresh();
  assert.deepEqual(first.failed, []);
  assert.equal(first.made.length, 6, "tier 1 and tier 2 in the one pass, on the newest root");
  const second = await q.refresh();
  assert.deepEqual(second.failed, [], "the next pass: no failure");
  assert.equal(second.made.length, 0, "nothing left to make");
  assert.ok(q.ready().every((r) => r.root === "newest"), "every proof on the newest root");
  assert.equal(cuts.filter((x) => !x).length, 1, "the pass read the epoch cut once, for both tiers");
});

// tier 2's own epoch read: a pass whose tier 1 has nothing to make (its ready set full) reads the epoch cut for tier 2
// alone, and an empty pool's cut refused as no leaf is trees of no leaf there too
test("tiers on an empty pool's first leaves: a pass with tier 1 full reads the cut for tier 2 alone, no leaf read as trees of no leaf", async () => {
  const { PoolNoLeafError } = await import("../src/pool/pool.ts");
  const v = await vaultWith(VALUES);
  const pool = piecesPool(v);
  const all = pool.trees;
  const bind = pool.bind.bind(pool);
  // the first pass refuses every bind to the primary's W but its own proof's: tier 1 made whole, tier 2 none
  const wP = W(await noteOf(v, usd(20)));
  let refuse = true;
  let toP = 0;
  pool.bind = async (b) => {
    if (refuse && b.wallet.address === wP && toP++ > 0) throw new Error("planted: no fee answer");
    return bind(b);
  };
  const cuts: boolean[] = [];
  pool.trees = async (before, signal, opts) => {
    cuts.push(opts?.newest === true);
    if (opts?.newest !== true) throw new PoolNoLeafError(`no leaf before ${before}`);
    return all(before, signal, opts);
  };
  const q = queue(v, pool as Pool<unknown>);
  const first = await q.refresh();
  assert.equal(first.made.length, 3, "tier 1 made, each tier 2 bind refused");
  assert.equal(first.failed.length, 3);
  refuse = false;
  const n = cuts.filter((x) => !x).length;
  const second = await q.refresh();
  assert.deepEqual(second.failed, [], "tier 2's pass with tier 1 full: no failure");
  assert.equal(second.made.length, 3, "tier 2's pieces made");
  assert.equal(cuts.filter((x) => !x).length, n + 1, "the pass read the epoch cut once, for tier 2");
  assert.ok(q.ready().every((r) => r.root === "newest"), "every proof on the newest root");
});

test("cutOrEmpty: a cut that holds no leaf reads as trees of no leaf; every other refusal is thrown as it came", async () => {
  const { cutOrEmpty, PoolNoLeafError, PoolReadError } = await import("../src/pool/pool.ts");
  const empty = await cutOrEmpty(Promise.reject(new PoolNoLeafError("no leaf before 1")));
  assert.equal(empty.stateTree.size, 0);
  assert.equal(empty.labelTree.size, 0);
  assert.equal(empty.stateRoot, 0n);
  assert.equal(empty.labelRoot, 0n);
  for (const e of [new PoolReadError("rpc_disagree", "the two RPCs apart"), new Error("no leaf before 1"), new TypeError("fetch failed")]) {
    await assert.rejects(cutOrEmpty(Promise.reject(e)), (x: unknown) => x === e, `${e.name}: ${e.message} is thrown as it came`);
  }
  const t = { stateTree: new VaultTree([1n]), labelTree: new VaultTree([2n]), stateRoot: 1n, labelRoot: 2n };
  assert.equal(await cutOrEmpty(Promise.resolve(t)), t, "an answer is passed through");
});
