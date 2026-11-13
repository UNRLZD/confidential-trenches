// node --test packages/wallet/test/pool-queue-max-first.test.ts: on a load, the proof queue of a pool whose buy pays one W
// from several notes makes Max's set first (src/pool/queue.ts "Pieces"): the primary's own proof, then the tier 2 proofs
// to its W, then the other notes' own proofs, so Max stands after min(usable notes, piecesMax) proofs; and one read of
// the pool's time serves every bind of a pass while it stands (pool.ts bindNow). The notes
// are withdraw-fixture.ts's (the all-zero test seed, a fixture vault); the prover answers the signals without proving.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VAULT_FIELD_P, VaultTree, type VaultProver } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import type { NoteRef } from "../src/notes/secrets.ts";
import type { NoteRecord } from "../src/notes/store.ts";
import { USDC_LADDER } from "../src/pool/near.ts";
import { bindNow, type Pool, type PoolBindArgs, type PoolTrees } from "../src/pool/pool.ts";
import { openProofQueue, type ProofQueue } from "../src/pool/queue.ts";
import { poolBalances, type BalancePool, type TapSpendOf } from "../src/pool/balances.ts";
import { BLOCK_MS, closeVaults, SCOPE, SEED, signalsProver, vaultWith, type Vault } from "./withdraw-fixture.ts";

after(closeVaults);
const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
const E = 60_000n;
const START = BigInt(BLOCK_MS) - (BigInt(BLOCK_MS) % E);

function piecesPool(v: Vault, piecesMax = 4): Pool<{ n: number }> & { binds: PoolBindArgs[]; bindEnds: number[] } {
  const binds: PoolBindArgs[] = [];
  const bindEnds: number[] = [];
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
    bindEnds,
    now: async () => START + 1_000n,
    trees: async () => trees(),
    async bind(b) {
      binds.push(b);
      const k = binds.length;
      await new Promise((r) => setTimeout(r, 5));
      bindEnds.push(k);
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|${k}`);
      return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: 100_000n, request: { n: k } };
    },
  };
}
const open: ProofQueue<unknown>[] = [];
after(async () => {
  for (const q of open) await q.close();
});
const jOf = (ref: NoteRef): number => (ref.kind === "change" ? ref.j + 1 : 0);
const W = (n: NoteRecord): string => {
  const w = d.freshWallet(SEED, "sol", n.leaf!.label, jOf(n.ref));
  w.secretKey.fill(0);
  return w.address;
};
const sumLess: TapSpendOf = (ps) => ps.reduce((a, p) => a + p.chunk - p.feeCap, 0n) - 1_000n;
const BAL: BalancePool = { id: "test:pieces", chain: "solana", scope: SCOPE, asset: "SOL", spendOf: sumLess };
const noteOf = async (v: Vault, x: bigint): Promise<NoteRecord> => (await v.ns.list()).find((n) => n.leaf?.value === x)!;

/** A prover that records each proof's start and end, and how many proofs ran at once at most. */
function timedProver(): VaultProver & { starts: number; ends: number; most: number; at: { bindsAtStart: number }[]; pool?: { binds: unknown[] } } {
  const inner = signalsProver();
  let running = 0;
  const p = {
    starts: 0,
    ends: 0,
    most: 0,
    at: [] as { bindsAtStart: number }[],
    pool: undefined as { binds: unknown[] } | undefined,
    load: inner.load,
    async prove(c: Parameters<VaultProver["prove"]>[0], i: Parameters<VaultProver["prove"]>[1]) {
      p.starts++;
      running++;
      p.most = Math.max(p.most, running);
      p.at.push({ bindsAtStart: p.pool!.binds.length });
      await new Promise((r) => setTimeout(r, 30));
      const out = await inner.prove(c, i);
      running--;
      p.ends++;
      return out;
    },
  };
  return p;
}

test("a load's first proofs are Max's set: the primary's own, then the tier 2 proofs to its W; Max stands after 4 proofs, then the other notes' own proofs follow", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(20)]);
  const pool = piecesPool(v);
  const prover = timedProver();
  prover.pool = pool;
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool: pool as Pool<unknown>, provers: [prover], hardwareConcurrency: 16 });
  open.push(q);
  const P = await noteOf(v, usd(20));
  const standing = "0.036599"; // the 20 and its three pieces (37 less four fees and the 1,000 once)
  // the bind order is the proof order: the first four all pay the primary's W, the first of them its own 20
  let maxAt: number | null = null;
  const first = q.refresh();
  for (let k = 0; k < 400 && maxAt === null; k++) {
    await new Promise((r) => setTimeout(r, 5));
    if (poolBalances(await v.ns.list(), [BAL], q.ready())[0]!.tap_max === standing) maxAt = prover.ends;
  }
  await first;
  for (let k = 0; k < 3; k++) await q.refresh();
  const firstFour = pool.binds.slice(0, 4).map((b) => ({ w: b.wallet.address, chunk: b.chunk }));
  assert.deepEqual(firstFour[0], { w: W(P), chunk: usd(20) }, "the primary's own proof first");
  assert.ok(firstFour.every((b) => b.w === W(P)), `the next three pay the primary's W: ${JSON.stringify(firstFour, (_k, x) => (typeof x === "bigint" ? String(x) : x))}`);
  assert.equal(maxAt, 4, "Max stands after four proofs");
  // then the tier 1 proofs of the 10 and the 5.5 notes: the ready set as before
  const own = q.ready().filter((r) => r.own === true).map((r) => r.chunk).sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(own, [usd(5), usd(10), usd(20)]);
  assert.equal(poolBalances(await v.ns.list(), [BAL], q.ready())[0]!.tap_max, standing);
  assert.equal(prover.starts, 6, "six proofs in all, as before: no proof made twice");
  assert.equal(prover.most, 1, "one proof at a time");
});

test("one note: one proof and Max stands (no tier 2 to make)", async () => {
  const v = await vaultWith([usd(500)]);
  const pool = piecesPool(v);
  const prover = timedProver();
  prover.pool = pool;
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool: pool as Pool<unknown>, provers: [prover], hardwareConcurrency: 16 });
  open.push(q);
  const r = await q.refresh();
  assert.equal(r.made.length, 1);
  assert.equal(poolBalances(await v.ns.list(), [BAL], q.ready())[0]!.tap_max, "0.499899");
  assert.deepEqual(await q.refresh(), { made: [], remade: [], failed: [] });
});

/** The pool above, its bind taking the queue's read of the pool's time as solanaPool's does (pool.ts bindNow): each
 *  bind that cannot take it counts one read of its own, as the real pool reads then. */
function nowPool(v: Vault, t: { now: bigint; tick?: () => void }) {
  const p = piecesPool(v);
  const reads = { now: 0, own: 0 };
  const bound: { epochStartMs: bigint; deadlineMs: bigint }[] = [];
  const bind = p.bind.bind(p);
  return Object.assign(p, {
    reads,
    bound,
    now: async () => (reads.now++, t.tick?.(), t.now),
    async bind(b: PoolBindArgs, s?: AbortSignal) {
      if (bindNow(b.now, b.epochStartMs, p.epochMs) === undefined) {
        reads.own++;
        b.readNow?.({ ms: t.now, at: performance.now(), wall: Date.now() });
      }
      bound.push({ epochStartMs: b.epochStartMs, deadlineMs: b.deadlineMs });
      return bind(b, s);
    },
  });
}

test("one read of the pool's time serves every bind of a pass: no bind reads its own while the pass's read stands", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(20)]);
  const pool = nowPool(v, { now: START + 1_000n });
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool: pool as Pool<unknown>, provers: [signalsProver() as VaultProver], hardwareConcurrency: 16 });
  open.push(q);
  const r = await q.refresh();
  assert.equal(r.made.length, 6);
  assert.equal(pool.reads.own, 0, "no bind read the pool's time itself");
  assert.equal(pool.reads.now, 1, "the pass's one read");
  // the values bound are the serial path's: the pass's epoch and its deadline
  for (const b of pool.bound) assert.deepEqual(b, { epochStartMs: START, deadlineMs: START + 270_000n });
});

test("a pass whose clock says the epoch may have turned: each bind reads the pool's time itself, the values bound the same", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(20)]);
  // the pool's time a hair before the boundary: by the bind, the pass's read plus the time since is past it
  const pool = nowPool(v, { now: START + E - 1n });
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool: pool as Pool<unknown>, provers: [signalsProver() as VaultProver], hardwareConcurrency: 16 });
  open.push(q);
  await new Promise((r) => setTimeout(r, 5));
  const r = await q.refresh();
  assert.equal(r.made.length, 6);
  assert.equal(pool.reads.own, 6, "every bind read its own");
  for (const b of pool.bound) assert.deepEqual(b, { epochStartMs: START, deadlineMs: START + 270_000n });
});

test("a pass's read gone stale (the device's clock on past NOW_REUSE_MS): the first bind reads its own and the binds after it take that read", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(20)]);
  let clock = 0;
  // the pass's read ends 6 s after it starts on the monotonic clock: too old for its binds
  const pool = nowPool(v, { now: START + 1_000n, tick: () => void (clock += 6_000) });
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool: pool as Pool<unknown>, provers: [signalsProver() as VaultProver], hardwareConcurrency: 16, monotonic: () => clock });
  open.push(q);
  const r = await q.refresh();
  assert.equal(r.made.length, 6);
  assert.equal(pool.reads.now, 1);
  assert.equal(pool.reads.own, 1, "one read of its own, then the next binds take it");
});
