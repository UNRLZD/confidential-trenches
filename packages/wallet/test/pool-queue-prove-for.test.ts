// node --test packages/wallet/test/pool-queue-prove-for.test.ts: the queue's proveFor (card
// buy-spends-its-change-in-the-same-tap): a landed UNSPENT note (a release's change) proved at once to the W the caller
// names, on the newest root; no later pass lets that proof go or makes it again to the primary's W, and the tap takes
// it. The fixture is pool-queue-pieces.test.ts's (the all-zero test seed, a fixture vault, a prover that answers the
// signals without proving).
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

// five notes, piecesMax 4: tier 2 holds the three largest others than the primary (the 20 note); tier 1 the primary and
// every note outside that room (card balance-shows-fast), so the second 2 note (the later leaf), as a change that just
// landed, holds its own proof alone, and proveFor holds its tier 2 proof beside it
const FIVE = [usd(2), usd(5.5), usd(10), usd(20), usd(2)];
const lastTwo = async (v: Vault): Promise<NoteRecord> => (await v.ns.list()).filter((n) => n.leaf?.value === usd(2)).sort((a, b) => (a.leaf!.leafIndex > b.leaf!.leafIndex ? -1 : 1))[0]!;
const toOf = (n: NoteRecord): { l: bigint; j: number; address: string } => ({ l: n.leaf!.label, j: jOf(n.ref), address: W(n) });

test("proveFor: an UNSPENT note proved to the named W, on the newest root; a later pass keeps it (no let-go, no remake to the primary's W) and the tap takes it", async () => {
  const v = await vaultWith(FIVE);
  const pool = piecesPool(v);
  const q = queue(v, pool as Pool<unknown>);
  await q.refresh();
  const C = await lastTwo(v);
  assert.equal(C.state, "HELD", "the change: its own proof");
  assert.equal(tiers(q as ProofQueue<unknown>, C.id).piece, undefined, "and no piece yet");
  const X = await noteOf(v, usd(10)); // the W the change pays: not the primary's (the 20 note's)
  const r = await q.proveFor(C.id, toOf(X));
  assert.equal(r.noteId, C.id);
  assert.equal(r.wallet.address, W(X));
  assert.equal(r.own, undefined, "a tier 2 proof");
  assert.equal(r.root, "newest");
  assert.equal(r.chunk, usd(2));
  assert.equal((await v.ns.get(C.id))!.state, "HELD");
  // a pass: the carried note is out of tier 2's room (the three largest others) and its W is not the primary's
  await q.refresh();
  const kept = q.ready().find((x) => x.noteId === C.id && x.own !== true);
  assert.equal(kept?.attempt, r.attempt, "the carried proof is still ready, the same attempt");
  assert.equal(kept?.wallet.address, W(X), "still bound to the named W");
  // the tap takes it
  const [t] = await q.takeSet([{ noteId: C.id, attempt: r.attempt }]);
  assert.equal(t!.attempt, r.attempt);
  assert.equal((await v.ns.get(C.id))!.state, "RESERVED");
});

test("proveFor: refused for a note that is not UNSPENT (held by a ready proof), and for one of no listed piece; nothing changes", async () => {
  const v = await vaultWith(FIVE);
  const pool = piecesPool(v);
  const q = queue(v, pool as Pool<unknown>);
  await q.refresh();
  const P = await noteOf(v, usd(20));
  const X = await noteOf(v, usd(10));
  // X holds a piece to the primary's W already; no such note at all
  await assert.rejects(q.proveFor(X.id, toOf(P)), /not a landed note of this pool/);
  await assert.rejects(q.proveFor("no-such-note", toOf(X)), /not a landed note of this pool/);
  assert.equal(tiers(q as ProofQueue<unknown>, X.id).piece?.wallet.address, W(P), "X's piece as it was");
  // the queue still runs: the next proveFor goes through
  const r = await q.proveFor((await lastTwo(v)).id, toOf(X));
  assert.equal(r.wallet.address, W(X));
});

test("proveFor: drop frees a carried note; the next pass may use it again", async () => {
  const v = await vaultWith(FIVE);
  const pool = piecesPool(v);
  const q = queue(v, pool as Pool<unknown>);
  await q.refresh();
  const C = await lastTwo(v);
  await q.proveFor(C.id, toOf(await noteOf(v, usd(10))));
  await q.drop(C.id);
  assert.equal((await v.ns.get(C.id))!.state, "UNSPENT", "both its proofs let go");
  assert.equal(q.ready().some((x) => x.noteId === C.id), false);
});

test("proveFor: the carried mark lasts its epoch only: a pass of the next epoch makes the note's proof again to the primary's W, as any other", async () => {
  const v = await vaultWith(FIVE);
  const pool = piecesPool(v);
  const q = queue(v, pool as Pool<unknown>);
  await q.refresh();
  const C = await lastTwo(v);
  const r = await q.proveFor(C.id, toOf(await noteOf(v, usd(10))));
  pool.t.now += E; // the next epoch
  await q.refresh();
  const again = q.ready().find((x) => x.noteId === C.id && x.own !== true);
  assert.notEqual(again?.attempt, r.attempt, "no longer the carried proof");
  assert.notEqual(again?.wallet.address, W(await noteOf(v, usd(10))), "not bound to the carried W any more");
});
