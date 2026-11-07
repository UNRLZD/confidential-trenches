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
import { callAmount, ownRow, POLL_MS, resetBindSession } from "../src/deposit/bind.ts";
import { encodeDelegateAction } from "../src/deposit/delegate.ts";
import { restorePages } from "../src/notes/restore.ts";
import { base64 } from "@scure/base";
import { type DepositOp, type FollowDeps, followDeposit, usdOf } from "../src/deposit/follow.ts";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";
import { ADDR, CREDIT, DEADLINE, MIN_OUT, NET, ONE_USDC, ORIGIN, type Stranger, V01World } from "./prepay-taken-world.ts";

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

test("V-01 with the first call's answer lost (a timeout, a closed tab) and the call carried 3 blocks later: nothing is signed at its nonce, U's refund lands on P'", async () => {
  const t = await run(() => ({ depositor: "e".repeat(64), value: ONE_USDC }), (world) => ((world.loseFirst = 3n), {}));
  await recovered(t, ONE_USDC);
  assert.deepEqual(t.world.answers, ["lost", "tx"], "no call refused: none signed while U's call on P was still out");
});

test("V-01 with the refund slow (10 blocks after the call): no wait past the poll, nothing signed until U holds it, final only after", async () => {
  const t = await run(() => ({ depositor: "e".repeat(64), value: ONE_USDC }), (world) => ((world.refundBlocks = 10n), {}));
  await recovered(t, ONE_USDC);
  const f = await run((u) => ({ depositor: u, value: CREDIT }), (world) => ((world.refundBlocks = 10n), { untilFinal: true, sleep: async () => (world.tick(), (world.timeMs += 600_000), await turn()) }));
  assert.equal(f.op.follow.final, true);
  assert.equal(f.world.balance, 0n, "final only once U's refund was bound");
  assert.deepEqual(f.world.carried.map((c) => c.fate), ["refunded", "landed"]);
});

test("V-01 while the two RPCs disagree on the pages (one lacks the stranger's row): the device waits, never binds", async () => {
  let during = -1;
  const t = await run(() => ({ depositor: "e".repeat(64), value: ONE_USDC }), (world) => {
    let n = 0;
    return {
      sleep: async (ms) => {
        world.tick();
        if (world.rows.length >= 1 && n < 12) (n++, (world.hideOnB = 1));
        else world.hideOnB = 0;
        if (n === 12 && during < 0) during = world.carried.length;
        void ms;
        await turn();
      },
    };
  });
  assert.equal(during, 1, "only U's call on P while the pages disagreed: nothing bound on P'");
  assert.equal(t.out.kind, "done");
  assert.equal(t.world.balance, 0n);
});

test("restore finds both notes: the stranger's on our P (UNSPENT, the vault's leaf) and U's on P'", async () => {
  const t = await run(() => ({ depositor: t0(), value: ONE_USDC }));
  const deposits = t.world.rows.map((r) => ({ index: r.index, precommitment: BigInt(r.precommitment), label: BigInt(r.label), value: BigInt(r.value), leafIndex: BigInt(r.leaf_index), depositor: r.depositor }));
  const leaves = new Array<bigint>(Number(deposits.at(-1)!.leafIndex) + 1).fill(0n);
  for (const d of deposits) leaves[Number(d.leafIndex)] = noteCommitment(d.value, d.label, d.precommitment);
  const found = restorePages(SEED, 1n, { deposits, spends: [], leaves }, { gap: 20 }).notes;
  const mine = (await t.store.list()).filter((n) => n.leaf !== undefined).map((n) => [JSON.stringify(n.ref, (_, v) => (typeof v === "bigint" ? `${v}` : v)), n.leaf!.value, n.leaf!.commitment]);
  const back = found.map((n) => [JSON.stringify(n.ref, (_, v) => (typeof v === "bigint" ? `${v}` : v)), n.leaf.value, n.leaf.commitment]);
  assert.deepEqual(back.sort(), mine.sort(), "restore gives the store's two notes");
  assert.deepEqual(found.map((n) => [n.ref.kind, n.state, n.leaf.value]).sort(), [["deposit", "UNSPENT", ONE_USDC], ["second", "UNSPENT", CREDIT]]);
});
const t0 = () => "e".repeat(64);

// ---------- ownRow on its own ----------
const callFor = (u: string, amount: bigint) => {
  const args = new TextEncoder().encode(JSON.stringify({ receiver_id: NET.vault, amount: amount.toString(), msg: "{}" }));
  const d = encodeDelegateAction({ sender_id: u, receiver_id: NET.usdc, method_name: "ft_transfer_call", args, gas: 1n, deposit: 1n, nonce: 1n, max_block_height: 1n, public_key: Uint8Array.from(Buffer.from(u, "hex")) });
  return { signed_delegate: base64.encode(Uint8Array.from([...d, 0, ...new Uint8Array(64)])) };
};
test("ownRow: U at a value one of the note's calls signed (several calls, several amounts); another value or another depositor is a stranger's", () => {
  const u = "a".repeat(64);
  const note = { calls: [callFor(u, 5_000_000n), callFor(u, 7_000_000n)] as never };
  assert.equal(callAmount(callFor(u, 7_000_000n)), 7_000_000n);
  assert.equal(ownRow({ depositor: u, value: 5_000_000n }, u, note), true);
  assert.equal(ownRow({ depositor: u, value: 7_000_000n }, u, note), true);
  assert.equal(ownRow({ depositor: u, value: 6_000_000n }, u, note), false, "no call signed that value");
  assert.equal(ownRow({ depositor: "b".repeat(64), value: 5_000_000n }, u, note), false, "another depositor");
  assert.equal(ownRow({ depositor: u, value: 6_000_000n }, u, note, 6_000_000n), false, "the calls rule over the bind's amount");
});

test("ownRow with no call written: the bind's amount when given, else U the depositor alone", () => {
  const u = "a".repeat(64);
  for (const note of [{}, { calls: [] }]) {
    assert.equal(ownRow({ depositor: u, value: 5n }, u, note, 5n), true);
    assert.equal(ownRow({ depositor: u, value: 5n }, u, note, 6n), false);
    assert.equal(ownRow({ depositor: u, value: 5n }, u, note), true, "another device's note on the seed: U the depositor");
    assert.equal(ownRow({ depositor: "b".repeat(64), value: 5n }, u, note), false);
    assert.equal(ownRow({ depositor: "b".repeat(64), value: 5n }, u, note, 5n), false);
  }
});
