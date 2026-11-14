// node --test packages/wallet/test/pool-queue-ranked.test.ts: every pool's Max set first on one shared prover (card
// balance-shows-fast, src/pool/prover-gate.ts and the queue's `ranked`). The signing page's Solana and EVM queues share
// one prover worker, which takes calls in the order they come; at each 60 s epoch every queue remakes its ready set, so
// one pool's other-note proofs could run before another pool's Max set, and a phone that cannot make them all in an
// epoch let Max go late. Counted order only: the shared prover's calls, one at a time, as the worker runs them. The
// notes are withdraw-fixture.ts's test notes, never money.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VAULT_FIELD_P, VaultTree, type VaultProver } from "@blindfill/kit";
import { USDC_LADDER } from "../src/pool/near.ts";
import type { Pool, PoolTrees, ReadyProof } from "../src/pool/pool.ts";
import { proverGate } from "../src/pool/prover-gate.ts";
import { openProofQueue, type ProofQueue } from "../src/pool/queue.ts";
import { BLOCK_MS, closeVaults, SCOPE, SEED, signalsProver, vaultWith, type Vault } from "./withdraw-fixture.ts";

after(closeVaults);
const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));
const E = 60_000n;
const START = BigInt(BLOCK_MS) - (BigInt(BLOCK_MS) % E);

type Fake = Pool<{ n: number }> & { t: { now: bigint } };
function fakePool(v: Vault, id: string, piecesMax?: number): Fake {
  const t = { now: START + 1_000n };
  let binds = 0;
  const trees = (): PoolTrees => {
    const s = new VaultTree(v.stateLeaves), l = new VaultTree(v.labelLeaves);
    return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
  };
  return {
    id, chain: "sol", scope: SCOPE, ladder: USDC_LADDER, ...(piecesMax === undefined ? {} : { piecesMax }), epochMs: E, lifeMs: 270_000n, sendMarginMs: 120_000n, t,
    now: async () => t.now,
    trees: async () => trees(),
    async bind(b) {
      const bytes = new TextEncoder().encode(`${id}|${b.wallet.address}|${b.chunk}|${b.deadlineMs}|${++binds}`);
      return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: 100_000n, request: { n: binds } };
    },
  };
}

/** The page's one prover worker: one proof at a time, in the order the calls come; each run's context logged. */
function worker(): VaultProver & { ran: string[] } {
  const inner = signalsProver();
  const ran: string[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  return {
    ran,
    load: (c) => inner.load(c),
    prove(c, input) {
      const run = tail.then(async () => {
        ran.push((input as { context: string }).context);
        await new Promise((r) => setImmediate(r));
        return inner.prove(c, input);
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

const open: ProofQueue<unknown>[] = [];
after(async () => {
  for (const q of open) await q.close();
});
/** Max's set of a queue's ready list: its primary's own proof (the largest chunk) and every proof to the primary's W. */
const maxSet = (ready: ReadyProof<unknown>[]): Set<string> => {
  const own = ready.filter((r) => r.own === true).sort((x, y) => (x.chunk > y.chunk ? -1 : x.chunk < y.chunk ? 1 : 0))[0]!;
  return new Set(ready.filter((r) => r.wallet.address === own.wallet.address).map((r) => r.binding.context.toString()));
};

test("three pools on one prover: at an epoch's remake every pool's Max set is made before any other note's proof", async () => {
  const p = worker();
  const gate = proverGate(p);
  const pools: { v: Vault; pool: Fake; q: ProofQueue<{ n: number }> }[] = [];
  for (const [id, pieces] of [["test:sol", 4], ["test:base", undefined], ["test:robinhood", undefined]] as const) {
    const v = await vaultWith([usd(2), usd(5.5), usd(10), usd(1.5), usd(20)]);
    const pool = fakePool(v, id, pieces);
    const q = openProofQueue({ seed64: SEED, notes: v.ns, pool, provers: [p], hardwareConcurrency: 4, ranked: gate });
    open.push(q as ProofQueue<unknown>);
    pools.push({ v, pool, q });
  }
  await Promise.all(pools.map((x) => x.q.refresh()));
  for (const x of pools) x.pool.t.now += E; // the next epoch: every queue remakes its ready set
  p.ran.length = 0;
  const passes = await Promise.all(pools.map((x) => x.q.refresh()));
  for (const pass of passes) assert.deepEqual(pass.failed, []);
  const ready = pools.map((x) => x.q.ready());
  const max = new Set(ready.flatMap((r) => [...maxSet(r)]));
  const all = new Set(ready.flatMap((r) => r.map((x) => x.binding.context.toString())));
  assert.equal(p.ran.length, all.size, "one remake per ready proof, none more");
  assert.equal(max.size, 4 + 1 + 1, "Solana's Max: its own proof and 3 pieces; each EVM pool's: its own proof");
  const lastMax = Math.max(...[...max].map((c) => p.ran.indexOf(c)));
  const firstRest = Math.min(...p.ran.map((c, i) => (max.has(c) ? Infinity : i)));
  assert.ok(lastMax < firstRest, `every Max proof (last at ${lastMax}) before any other (first at ${firstRest}): ${p.ran.map((c) => (max.has(c) ? "M" : "r")).join("")}`);
});

test("the gate: one proof at a time, a waiting max before a waiting rest, both in their own order", async () => {
  const order: string[] = [];
  const held: (() => void)[] = [];
  const inner: VaultProver = {
    load: async () => {},
    prove: (_c, input) =>
      new Promise((done) => {
        order.push((input as { tag: string }).tag);
        held.push(() => done({} as never));
      }),
  };
  const g = proverGate(inner);
  const call = (rank: "max" | "rest", tag: string) => g.prover(rank).prove("withdraw", { tag } as never);
  const runs = [call("rest", "r1"), call("rest", "r2"), call("max", "m1"), call("rest", "r3"), call("max", "m2")];
  const step = async (): Promise<void> => {
    await new Promise((r) => setImmediate(r));
    held.shift()!();
    await new Promise((r) => setImmediate(r));
  };
  for (let k = 0; k < 5; k++) {
    await new Promise((r) => setImmediate(r));
    assert.equal(held.length, 1, "one proof at a time");
    await step();
  }
  await Promise.all(runs);
  assert.deepEqual(order, ["r1", "m1", "m2", "r2", "r3"]);
});

test("the gate: a hold keeps every rest proof back, never a max one; its release lets the rest go", async () => {
  const order: string[] = [];
  const inner: VaultProver = { load: async () => {}, prove: async (_c, input) => (order.push((input as { tag: string }).tag), {} as never) };
  const g = proverGate(inner);
  const release = g.hold();
  const rest = g.prover("rest").prove("withdraw", { tag: "r" } as never);
  await g.prover("max").prove("withdraw", { tag: "m" } as never);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["m"], "the rest proof waits while the pass holds the gate");
  release();
  release(); // idempotent
  await rest;
  assert.deepEqual(order, ["m", "r"]);
});
