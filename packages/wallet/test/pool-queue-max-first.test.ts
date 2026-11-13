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
import { bindNow, perEpoch, type Pool, type PoolBindArgs, type PoolTrees } from "../src/pool/pool.ts";
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

// ---- pool.ts perEpoch: one answer per epoch (the relayer's fee, the Solana epoch fee) ----

/** An ask whose answers the test settles: each call logged with its epoch and its own stop. */
function asker() {
  const calls: { e: bigint; signal: AbortSignal | undefined; ok: (v: string) => void; fail: (x: unknown) => void }[] = [];
  const ask = (e: bigint, signal?: AbortSignal): Promise<string> =>
    new Promise((ok, fail) => {
      calls.push({ e, signal, ok, fail });
    });
  return { calls, ask };
}

test("perEpoch: a caller's stop ends its own wait only; another caller of the epoch still gets the one answer, asked once", async () => {
  const { calls, ask } = asker();
  const fees = perEpoch(ask);
  const a = new AbortController(), b = new AbortController();
  const first = fees.get(1n, a.signal);
  const second = fees.get(1n, b.signal);
  assert.equal(calls.length, 1, "one ask for the epoch");
  a.abort(new Error("first caller's stop"));
  await assert.rejects(first, /first caller's stop/);
  assert.equal(calls[0]!.signal?.aborted, false, "the ask runs on while another caller waits");
  calls[0]!.ok("fee-1");
  assert.equal(await second, "fee-1");
  assert.equal(await fees.get(1n, AbortSignal.abort(new Error("late"))), "fee-1", "an answer in hand is handed even to a stopped caller, as joinFee does");
  assert.equal(calls.length, 1);
});

test("perEpoch: when every waiting caller has stopped, the ask is stopped and the next caller asks again", async () => {
  const { calls, ask } = asker();
  const fees = perEpoch(ask);
  const a = new AbortController(), b = new AbortController();
  const both = [fees.get(1n, a.signal), fees.get(1n, b.signal)];
  a.abort(new Error("a"));
  assert.equal(calls[0]!.signal?.aborted, false);
  b.abort(new Error("b"));
  await Promise.allSettled(both);
  assert.equal(calls[0]!.signal?.aborted, true, "the last caller's stop ends the ask");
  const again = fees.get(1n);
  assert.equal(calls.length, 2, "asked again");
  calls[1]!.ok("fee-1b");
  assert.equal(await again, "fee-1b");
  calls[0]!.ok("late answer"); // the stopped ask's answer, if it comes, is no one's
  assert.equal(await fees.get(1n), "fee-1b");
});

test("perEpoch: a failed ask and an answer a bind drops are asked again; a drop of an older answer leaves the newer one", async () => {
  const { calls, ask } = asker();
  const fees = perEpoch(ask);
  const f1 = fees.get(1n);
  calls[0]!.fail(new Error("helper down"));
  await assert.rejects(f1, /helper down/);
  const f2 = fees.get(1n);
  assert.equal(calls.length, 2, "a failed ask is asked again");
  calls[1]!.ok("refused");
  assert.equal(await f2, "refused");
  fees.drop(1n, f2);
  const f3 = fees.get(1n);
  assert.equal(calls.length, 3, "a dropped answer is asked again");
  calls[2]!.ok("good");
  assert.equal(await f3, "good");
  fees.drop(1n, f2); // the older answer's drop, late
  assert.equal(await fees.get(1n), "good");
  assert.equal(calls.length, 3, "the newer answer stays");
});

test("perEpoch: the newest 4 epochs are kept; an older one is asked again", async () => {
  const { calls, ask } = asker();
  const fees = perEpoch(ask);
  for (let e = 1n; e <= 5n; e++) {
    const p = fees.get(e);
    calls.at(-1)!.ok(`fee-${e}`);
    await p;
  }
  assert.equal(calls.length, 5);
  for (let e = 2n; e <= 5n; e++) assert.equal(await fees.get(e), `fee-${e}`);
  assert.equal(calls.length, 5, "epochs 2 to 5 kept");
  const p1 = fees.get(1n);
  assert.equal(calls.length, 6, "epoch 1, the oldest, was let go");
  calls.at(-1)!.ok("fee-1");
  assert.equal(await p1, "fee-1");
});

// ---- the pass's guards (src/pool/queue.ts refresh) ----

test("a primary whose own proof fails gets no tier 2 proof to its W that pass; the other notes' own proofs are still made", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(20)]);
  const pool = piecesPool(v);
  const P = await noteOf(v, usd(20));
  const bind = pool.bind.bind(pool);
  pool.bind = async (b) => {
    if (b.wallet.address === W(P) && b.chunk === usd(20)) throw new Error("planted: the primary's bind refused");
    return bind(b);
  };
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool: pool as Pool<unknown>, provers: [signalsProver()], hardwareConcurrency: 16 });
  open.push(q);
  const out = await q.refresh();
  assert.ok(out.failed.some((f) => f.noteId === P.id), "the primary's own proof failed");
  assert.equal(pool.binds.filter((b) => b.wallet.address === W(P)).length, 0, "no bind to the primary's W but its own (refused before the push)");
  assert.equal(q.ready().filter((r) => r.wallet.address === W(P)).length, 0, "no proof to the primary's W");
  assert.ok(q.ready().some((r) => r.own === true), "the other notes' own proofs made");
});

test("at an epoch turn the remakes of Max's set come before the other notes' own remakes", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(20)]);
  const pool = piecesPool(v, 2);
  let now = START + 1_000n;
  pool.now = async () => now;
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool: pool as Pool<unknown>, provers: [signalsProver()], hardwareConcurrency: 16 });
  open.push(q);
  await q.refresh();
  const P = await noteOf(v, usd(20));
  const ten = await noteOf(v, usd(10));
  assert.ok(q.ready().some((r) => r.noteId === ten.id && r.wallet.address === W(P)), "the 10's piece pays the primary's W");
  now = START + E + 1_000n;
  pool.binds.length = 0;
  const out = await q.refresh();
  assert.ok(out.remade.length >= 4, `the turn remakes the set and the own proofs: ${out.remade.length}`);
  const order = pool.binds.map((b) => (b.wallet.address === W(P) ? `P ${b.chunk}` : `own ${b.chunk}`));
  assert.deepEqual(order.slice(0, 2), [`P ${usd(20)}`, `P ${usd(10)}`], `Max's set first: ${order.join(", ")}`);
});

test("a bind's older read of the pool's time never moves the queue's read back: the next bind is handed the newer one", async () => {
  const v = await vaultWith([usd(5.5), usd(20)]);
  const pool = piecesPool(v);
  const bind = pool.bind.bind(pool);
  const seen: (bigint | undefined)[] = [];
  pool.bind = async (b) => {
    seen.push(b.now?.ms);
    if (seen.length === 1) b.readNow?.({ ms: START, at: performance.now(), wall: Date.now() });
    return bind(b);
  };
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool: pool as Pool<unknown>, provers: [signalsProver()], hardwareConcurrency: 16 });
  open.push(q);
  await q.refresh();
  assert.ok(seen.length >= 2);
  assert.equal(seen[0], START + 1_000n, "the pass's read");
  assert.ok(seen[1] !== undefined && seen[1] >= START + 1_000n, `the second bind keeps the newer read: ${seen[1]}`);
});

test("a tier 2 proof made again to a new primary's W raises Max, so it comes before the epoch's remakes, the new primary's own among them", async () => {
  const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(20)]);
  const pool = piecesPool(v);
  let now = START + 1_000n;
  pool.now = async () => now;
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool: pool as Pool<unknown>, provers: [signalsProver()], hardwareConcurrency: 16 });
  open.push(q);
  await q.refresh();
  const P = await noteOf(v, usd(20));
  const ten = await noteOf(v, usd(10));
  const own = q.ready().find((r) => r.noteId === P.id && r.own === true)!;
  await q.takeSet([{ noteId: P.id, attempt: own.attempt }], undefined, 99n);
  // the next epoch: the 10 is the primary; the 5.5 and the 2 have pieces to the 20's W, made again to the 10's
  now = START + E + 1_000n;
  pool.binds.length = 0;
  await q.refresh();
  const order = pool.binds.map((b) => `${b.wallet.address === W(ten) ? "W10" : "other"} ${b.chunk}`);
  assert.deepEqual(order.slice(0, 2), [`W10 ${usd(5)}`, `W10 ${usd(2)}`], `the pieces to the new W first: ${order.join(", ")}`);
  assert.equal(order[2], `W10 ${usd(10)}`, "then the remakes, the primary's own first");
});
