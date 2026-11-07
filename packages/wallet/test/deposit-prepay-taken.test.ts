// Audit V-01 with bind.ts and follow.ts themselves (card wallet-near-prepay-taken): the relayer's storage_prepay(P) puts P
// on chain, a stranger's deposit naming P lands first, U's call is refunded in full. The device reads the stranger's
// note under P on both RPCs, tells it from this deposit by value (the vault takes the depositor from the message, so the
// stranger may name U), and with no tap binds U's refunded USDC on U's next second-arrival note P', which the relayer
// prepays and carries. Both notes are the user's: the stranger's on our P is spendable with our secrets.
//   node --test test/deposit-prepay-taken.test.ts   (from packages/wallet)
// The world is test/prepay-taken-world.ts; the note store and the ops store are the real ones on fake-indexeddb. Test
// secrets come from the first published BIP-39 vector (all-zero entropy).
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { depositAccount } from "../src/deposit/account.ts";
import { POLL_MS, resetBindSession } from "../src/deposit/bind.ts";
import { type DepositOp, type FollowDeps, followDeposit, usdOf } from "../src/deposit/follow.ts";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";
import { ADDR, CREDIT, DEADLINE, MIN_OUT, ONE_USDC, ORIGIN, type Stranger, V01World } from "./prepay-taken-world.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const RELAYER = "bind.blindfill-test.testnet";
const NOW = 1_762_400_000_000;
const pc = (ref: NoteRef): bigint => noteSecrets(SEED, ref).precommitment;
const turn = () => new Promise<void>((ok) => setImmediate(ok));

const opened: WalletStore[] = [];
const stores: NoteStore[] = [];
after(() => (opened.forEach((s) => s.close()), stores.forEach((n) => n.close())));
beforeEach(() => resetBindSession());

async function run(stranger: (u: string) => Stranger, over: (world: V01World) => Partial<FollowDeps> = () => ({})) {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  opened.push(w);
  const store = await openNoteStore(w);
  stores.push(store);
  const note = await store.planDeposit(1n, pc);
  const i = (note.ref as { i: number }).i;
  const u = depositAccount(SEED, 1n, i).account;
  const world = new V01World(u, stranger(u));
  world.balance = CREDIT; // 1Click delivered to U
  const sleeps: number[] = [];
  const startNonce = world.nonce;
  const out = await followDeposit(
    { opId: "dq-1", network: "testnet", s: 1n, i, u, address: ADDR, deadline_ms: DEADLINE, origin: ORIGIN, min_out: MIN_OUT },
    {
      ops: w,
      store,
      rpcs: world.rpcs(),
      seed64: async () => Uint8Array.from(SEED),
      fetchFn: world.fetchFn,
      sleep: async (ms) => (sleeps.push(ms), world.tick(), await turn()),
      signal: AbortSignal.timeout(20_000),
      relayerAccount: RELAYER,
      now: () => NOW,
      ...over(world),
    },
  );
  const op = (await w.get("ops", "dq-1")) as DepositOp;
  return { w, store, note, i, u, world, out, op, sleeps, startNonce };
}

const second0 = (i: number): NoteRef => ({ kind: "second", id: { id: "U", s: 1n, i }, n: 0 });

/** The end state of V-01 recovered: P refunded, P' prepaid and landed, both notes the user's, nothing left in U. */
async function recovered(t: Awaited<ReturnType<typeof run>>, taken: bigint) {
  const P = t.note.precommitment;
  const P2 = pc(second0(t.i));
  assert.notEqual(P2, P);
  assert.equal(t.out.kind, "done");
  assert.deepEqual((t.out as { note: { ref: unknown } }).note.ref, second0(t.i), "done lands on U's next second-arrival note, never on the stranger's");
  assert.deepEqual(
    t.world.carried.map((c) => [c.fate, c.p, c.nonce - t.startNonce, c.amount]),
    [["refunded", P, 1n, CREDIT], ["landed", P2, 2n, CREDIT]],
    "U's call on P refunded in full, then one call on P' at the next nonce, at the whole refund",
  );
  assert.deepEqual(t.world.prepays, [P, P2], "the relayer prepaid P, then P'");
  assert.equal(t.world.balance, 0n, "nothing waits in U");
  assert.equal(t.op.amount_usd, usdOf(CREDIT), "the deposit's own USDC, never the stranger's");
  const s2 = (await t.store.list()).find((n) => n.precommitment === P2)!;
  assert.deepEqual(t.op.follow.notes, [s2.id], "the op counts only the note U's call landed");
  // the stranger's note on our P is the user's: UNSPENT with the vault's leaf, its commitment from our P
  const mine = (await t.store.get(t.note.id))!;
  assert.equal(mine.state, "UNSPENT");
  assert.equal(mine.leaf!.value, taken);
  assert.equal(mine.leaf!.commitment, noteCommitment(taken, mine.leaf!.label, pc(mine.ref)));
  assert.equal(s2.state, "UNSPENT");
  assert.equal(s2.leaf!.value, CREDIT);
  assert.ok(t.sleeps.every((ms) => ms === POLL_MS), `no wait past the poll: ${t.sleeps.join()}`);
}

test("V-01: a stranger takes P after the relayer's prepay; U's refund lands on P' with no tap, both notes the user's", async () => {
  const t = await run(() => ({ depositor: "e".repeat(64), value: ONE_USDC }));
  await recovered(t, ONE_USDC);
});

test("V-01, the stranger names U at 1 USDC: a note under P whose value is not the call's is the stranger's, never counted", async () => {
  const t = await run((u) => ({ depositor: u, value: ONE_USDC }));
  await recovered(t, ONE_USDC);
});

test("V-01, the stranger names U at the quote's min: never this deposit done while U's refund waits in U", async () => {
  const t = await run((u) => ({ depositor: u, value: BigInt(MIN_OUT) }));
  await recovered(t, BigInt(MIN_OUT));
});

test("V-01, the stranger names U at the call's own amount: one value, so it counts, and U's refund still lands on P' (untilFinal)", async () => {
  // the block time moves 10 min a round, so the quote's deadline passes and the follow ends once U holds nothing
  const t = await run((u) => ({ depositor: u, value: CREDIT }), (world) => ({ untilFinal: true, sleep: async () => (world.tick(), (world.timeMs += 600_000), await turn()) }));
  assert.equal(t.out.kind, "done");
  assert.equal(t.world.balance, 0n, "nothing waits in U");
  assert.deepEqual(t.world.carried.map((c) => [c.fate, c.p]), [["refunded", t.note.precommitment], ["landed", pc(second0(t.i))]]);
  assert.equal(t.op.follow.final, true);
});
