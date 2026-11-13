// Card buy-spends-several-pieces: each step a proof pass can fail at names its code (PassFail, the pass's failed[]
// reason, or its small count), the codes the signing page's console line prints (pool-testnet.ts passLine). One test per
// step: the fee binding (the helper's answer, the device's check of it, a read of the bind's that got no answer), the
// note's hold (fresh and at a remake), the pool's time, its epoch trees (tier 1 and tier 2), its newest trees, the
// prover, a note under the least rung, and an abort, which passes through untagged.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultLabelOf, type VaultProver } from "@blindfill/kit";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { PassFail } from "../src/pool/pool.ts";
import { openProofQueue } from "../src/pool/queue.ts";
import { closeVaults, SCOPE, SEED, signalsProver, vaultWith } from "./withdraw-fixture.ts";
import { E, fakePool } from "./queue-late-fixture.ts";

after(closeVaults);

const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));

async function open(o: { values?: bigint[]; piecesMax?: number; prover?: VaultProver } = {}) {
  const v = await vaultWith(o.values ?? [usd(100)]);
  const pool = fakePool(v, o.piecesMax);
  pool.t.now += 10_000n;
  const q = openProofQueue({ seed64: SEED, notes: v.ns, pool, provers: [o.prover ?? signalsProver()], hardwareConcurrency: 4 });
  return { v, pool, q };
}
const reasons = (p: { failed: { reason?: string }[] }) => p.failed.map((f) => f.reason);
const thrownAs = async (run: Promise<unknown>, reason: string) => {
  const e = await run.then(() => assert.fail("the pass did not throw"), (x: unknown) => x);
  assert.ok(e instanceof PassFail, `not a PassFail: ${String(e)}`);
  assert.equal(e.reason, reason);
};

test("a bind that fails: fee_refused", async () => {
  const { pool, q } = await open();
  try {
    pool.bind = async () => {
      throw new Error("relayFee: the helper's fee is not the epoch's fee");
    };
    assert.deepEqual(reasons(await q.refresh()), ["fee_refused"]);
  } finally {
    await q.close();
  }
});

test("a binding the device's check refuses (a fee cap not below the chunk): fee_refused", async () => {
  const { pool, q } = await open();
  try {
    const bind = pool.bind.bind(pool);
    pool.bind = async (b, s) => ({ ...(await bind(b, s)), feeCap: b.chunk });
    assert.deepEqual(reasons(await q.refresh()), ["fee_refused"]);
  } finally {
    await q.close();
  }
});

test("a bind whose own read got no answer (tagged by the pool): network, never fee_refused", async () => {
  const { pool, q } = await open();
  try {
    pool.bind = async () => {
      throw new PassFail("network", new Error("pool fee: HTTP 429"));
    };
    assert.deepEqual(reasons(await q.refresh()), ["network"]);
  } finally {
    await q.close();
  }
});

test("a fresh hold the store refuses (another tab holds the note): held_elsewhere", async () => {
  const { v, q } = await open();
  try {
    v.failPut.on = (r) => (r as { state?: string }).state === "HELD";
    assert.deepEqual(reasons(await q.refresh()), ["held_elsewhere"]);
  } finally {
    await q.close();
  }
});

test("a remake's hold write the store refuses: held_elsewhere", async () => {
  const { v, pool, q } = await open();
  try {
    assert.equal((await q.refresh()).made.length, 1);
    pool.t.now += E; // the next epoch: the ready proof is made again
    v.failPut.on = (r) => (r as { state?: string }).state === "HELD";
    assert.deepEqual(reasons(await q.refresh()), ["held_elsewhere"]);
  } finally {
    await q.close();
  }
});

test("the pool's time read fails, or answers no bigint: the pass throws network", async () => {
  const { pool, q } = await open();
  try {
    pool.now = async () => {
      throw new Error("rpc: HTTP 429");
    };
    await thrownAs(q.refresh(), "network");
    pool.now = async () => 5 as unknown as bigint;
    await thrownAs(q.refresh(), "network");
  } finally {
    await q.close();
  }
});

test("the epoch trees read fails: the pass throws network", async () => {
  const { pool, q } = await open();
  try {
    pool.trees = async () => {
      throw new Error("rpc: no answer in time");
    };
    await thrownAs(q.refresh(), "network");
  } finally {
    await q.close();
  }
});

test("tier 2's epoch trees read fails (tier 1 has nothing to make): the pass throws network", async () => {
  const { pool, q } = await open({ values: [usd(100), usd(50)], piecesMax: 4 });
  try {
    const p = await q.refresh();
    assert.equal(p.made.length, 2, "tier 1 made");
    pool.trees = async () => {
      throw new Error("rpc: no answer in time");
    };
    await thrownAs(q.refresh(), "network");
  } finally {
    await q.close();
  }
});

test("the newest trees read fails for a note that landed this epoch: that note failed, network", async () => {
  const { v, pool, q } = await open();
  try {
    assert.equal((await q.refresh()).made.length, 1);
    const ref: NoteRef = { kind: "return", c: "sol", l: 7n, j: 1 };
    const pre = noteSecrets(SEED, ref).precommitment;
    let n = await v.ns.add({ ref, scope: SCOPE, precommitment: pre, state: "PLANNED" });
    n = await v.ns.move(n.id, "PLANNED", "INCOMING");
    const label = vaultLabelOf(keccak_256, SCOPE, 2000n);
    const commitment = noteCommitment(usd(20), label, pre);
    pool.land(commitment, label);
    n = await v.ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value: usd(20), label, commitment, leafIndex: BigInt(v.stateLeaves.length - 1) } });
    const trees = pool.trees.bind(pool);
    pool.trees = async (before, s, opts) => {
      if (opts?.newest) throw new Error("rpc: no answer in time");
      return trees(before, s, opts);
    };
    const p = await q.refresh();
    assert.deepEqual(p.failed.map((f) => [f.noteId, f.reason]), [[n.id, "network"]]);
  } finally {
    await q.close();
  }
});

test("the prover fails: prover_failed", async () => {
  const sp = signalsProver();
  const prover: VaultProver = { load: sp.load, prove: async () => Promise.reject(new Error("prover: out of memory")) };
  const { q } = await open({ prover });
  try {
    assert.deepEqual(reasons(await q.refresh()), ["prover_failed"]);
  } finally {
    await q.close();
  }
});

test("a note under the pool's least rung: never proved, counted as small", async () => {
  const { q } = await open({ values: [usd(100), usd(1)] });
  try {
    const p = await q.refresh();
    assert.equal(p.small, 1);
    assert.equal(p.made.length, 1);
  } finally {
    await q.close();
  }
});

test("an abort (a sign out) is no step's failure: it passes through untagged", async () => {
  const { pool, q } = await open();
  try {
    pool.now = async () => {
      throw new DOMException("signed out", "AbortError");
    };
    const e = await q.refresh().then(() => assert.fail("the pass did not throw"), (x: unknown) => x);
    assert.ok(!(e instanceof PassFail), "an abort tagged");
    assert.equal((e as Error).name, "AbortError");
  } finally {
    await q.close();
  }
});
