// Restore of the fresh wallets and the deposit ids (card wallet-restore-wallets; docs/plan1/wallet.md §2.3 "Restore"
// steps 4, 5 and 7 l.277-341, device lanes l.247-258). Fixtures of each chain tag and each kind of lane, on fake
// readers that log every request.
//   node --test test/restore-wallets.test.ts      (from packages/wallet)
// Test secrets: the all-zero BIP-39 entropy (test/vectors/a8.json), never money.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultScopeOf } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { depositAccount } from "../src/deposit/account.ts";
import type { NoteRestore, RestoredNote, RestoredSpend } from "../src/notes/restore.ts";
import { refKey } from "../src/notes/store.ts";
import type { NoteRef } from "../src/notes/secrets.ts";
import { afterRestore, ARM_TAGS, DEPOSIT_ID_MARGIN, HOP_TAGS, REREAD_MS, rereadsDue, restoreDepositIds, restoreWallets, type HistoryChain, type LaneIds } from "../src/restore/wallets.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const SCOPE = vaultScopeOf(keccak_256, "vault.bf-restore.testnet", "usdc.fakes.testnet");
const L1 = 1111n, L2 = 2222n;
const addr = (c: d.Chain, l: bigint, j: number): string => {
  const w = d.freshWallet(SEED, c, l, j);
  w.secretKey.fill(0);
  return w.address;
};
const note = (ref: NoteRef): RestoredNote => ({ ref, scope: SCOPE, precommitment: 0n, leaf: { value: 1n, label: 1n, commitment: 1n, leafIndex: 0n }, state: "UNSPENT" });
const spend = (l: bigint, j: number, ref: NoteRef): RestoredSpend => ({ l, j, note: refKey(ref), spend: {} as RestoredSpend["spend"] });
const dep = (i: number): NoteRef => ({ kind: "deposit", s: SCOPE, i });
const ch = (l: bigint, j: number): NoteRef => ({ kind: "change", l, j });
const ALL_CHAINS: Record<d.Chain, HistoryChain[]> = { sol: ["solana"], "hop-sol": ["solana"], near: ["near"], "hop-near": ["near"], evm: ["base", "robinhood"], "hop-evm": ["base", "robinhood"] };

// a reader that answers from a set of "chain address" with history, logging every request
function reader(used: Iterable<string>, fail: (chain: HistoryChain, a: string) => unknown = () => undefined) {
  const yes = new Set(used);
  const log: string[] = [];
  const read = async (chain: HistoryChain, a: string): Promise<boolean> => {
    log.push(`${chain} ${a}`);
    const f = fail(chain, a);
    if (f instanceof Error) throw f;
    if (f !== undefined) return f as boolean;
    return yes.has(`${chain} ${a}`);
  };
  return { read, log };
}

// two arms: (L1, 0) spent deposit 0; (L2, 1) spent change note 0 of L2
const TWO: Pick<NoteRestore, "notes" | "spends"> = {
  notes: [note(dep(0)), note(ch(L2, 0))],
  spends: [spend(L1, 0, dep(0)), spend(L2, 1, ch(L2, 0))],
};

test("step 4: an arm's sol, evm (Robinhood only) and hop-evm (Base) wallets are found; an arm with none reads no hop target", async () => {
  const { read, log } = reader([`solana ${addr("sol", L1, 0)}`, `robinhood ${addr("evm", L1, 0)}`, `base ${addr("hop-evm", L1, 0)}`]);
  const got = await restoreWallets(SEED, TWO, read);
  assert.deepEqual(
    got.wallets.map((w) => [w.c, w.l, w.j, w.address, w.history]),
    [["sol", L1, 0, addr("sol", L1, 0), ["solana"]], ["evm", L1, 0, addr("evm", L1, 0), ["robinhood"]], ["hop-evm", L1, 0, addr("hop-evm", L1, 0), ["base"]]],
  );
  assert.deepEqual(got.unread, []);
  assert.equal(got.wallets[0]!.note, refKey(dep(0)));
  assert.match(got.wallets[1]!.path, /^m\/44'\/60'\/\d+'\/\d+'$/);
  // one address per request: arm 1 reads 4 + its hops 4, arm 2 reads its 4 and no hop target
  const want = (l: bigint, j: number, tags: readonly d.Chain[]) => tags.flatMap((c) => ALL_CHAINS[c].map((x) => `${x} ${addr(c, l, j)}`));
  assert.deepEqual([...log].sort(), [...want(L1, 0, ARM_TAGS), ...want(L1, 0, HOP_TAGS), ...want(L2, 1, ARM_TAGS)].sort());
  assert.ok(!JSON.stringify(got, (_k, v) => (typeof v === "bigint" ? String(v) : v)).includes("secret"), "no key leaves");
});

test("step 4: two withdrawals of one label are two arms, each with its own wallets", async () => {
  const r = { notes: [note(dep(0)), note(ch(L1, 0))], spends: [spend(L1, 0, dep(0)), spend(L1, 1, ch(L1, 0))] };
  const got = await restoreWallets(SEED, r, reader([`solana ${addr("sol", L1, 0)}`, `near ${addr("near", L1, 1)}`]).read);
  assert.deepEqual(got.wallets.map((w) => [w.c, w.l, w.j, w.note]), [["sol", L1, 0, refKey(dep(0))], ["near", L1, 1, refKey(ch(L1, 0))]]);
});

test("step 4: each of the six chain tags is found on its own chain read", async () => {
  for (const c of [...ARM_TAGS, ...HOP_TAGS] as d.Chain[]) {
    for (const chain of ALL_CHAINS[c]) {
      // a hop target is read once a wallet of its arm is found: the arm's sol wallet holds history in the hop cases
      const used = [`${chain} ${addr(c, L2, 1)}`, ...(c.startsWith("hop-") ? [`solana ${addr("sol", L2, 1)}`] : [])];
      const got = await restoreWallets(SEED, TWO, reader(used).read);
      const w = got.wallets.find((x) => x.c === c);
      assert.ok(w, `${c} on ${chain}`);
      assert.deepEqual([w.l, w.j, w.address, w.history], [L2, 1, addr(c, L2, 1), [chain]], `${c} on ${chain}`);
    }
  }
});

test("step 4: a wallet whose return note the restore found counts with no history; a hop's return note reads the arm's hop targets", async () => {
  const ret = (c: d.Chain): NoteRef => ({ kind: "return", c, l: L1, j: 0 });
  const r = { notes: [...TWO.notes, note(ret("near")), note(ret("hop-sol"))], spends: TWO.spends };
  const { read, log } = reader([]);
  const got = await restoreWallets(SEED, r, read);
  assert.deepEqual(got.wallets.map((w) => [w.c, w.returnNote, w.history]), [["near", refKey(ret("near")), []], ["hop-sol", refKey(ret("hop-sol")), []]]);
  assert.ok(log.includes(`solana ${addr("hop-sol", L1, 0)}`));
  // a hop's return note alone, with no wallet of its arm in use: the hop targets are still read and that one listed
  const hopOnly = { notes: [...TWO.notes, note({ kind: "return", c: "hop-near", l: L2, j: 1 })], spends: TWO.spends };
  const h = reader([`base ${addr("hop-evm", L2, 1)}`]);
  const got2 = await restoreWallets(SEED, hopOnly, h.read);
  assert.deepEqual(got2.wallets.map((w) => [w.c, w.l, w.j, w.history]), [["hop-evm", L2, 1, ["base"]], ["hop-near", L2, 1, []]]);
});

test("step 4: a read that fails or answers anything but yes or no is listed unread, never no history, and its arm's hop targets are read", async () => {
  const bad = addr("evm", L2, 1);
  const { read, log } = reader([], (chain, a) => (a === bad ? (chain === "base" ? new Error("HTTP 429") : "true") : undefined));
  const got = await restoreWallets(SEED, TWO, read);
  assert.deepEqual(got.unread.map((u) => [u.c, u.l, u.j, u.address, u.chain, u.error]).sort(), [
    ["evm", L2, 1, bad, "base", "HTTP 429"],
    ["evm", L2, 1, bad, "robinhood", "the read answered neither yes nor no"],
  ]);
  assert.deepEqual(got.wallets, []);
  for (const c of HOP_TAGS) assert.ok(log.some((x) => x.endsWith(addr(c, L2, 1))), `hop ${c} read`);
});

test("step 4: the reads go in the order `pick` draws, never the notes' order", async () => {
  const orders = new Set<string>();
  for (let s = 0; s < 4; s++) {
    const { read, log } = reader([]);
    let k = s;
    await restoreWallets(SEED, TWO, read, { pick: (n) => (k = (k * 7 + 3) % 1000) % n });
    orders.add(log.join("|"));
  }
  assert.ok(orders.size > 1, "the order follows pick");
  await assert.rejects(restoreWallets(SEED, TWO, reader([]).read, { pick: (n) => n }), /pick is out of range/);
});

// ---------- the deposit lanes ----------
const id = (i: number) => depositAccount(SEED, SCOPE, i).account;
function idReader(money: Iterable<number>, fail: Iterable<number> = []) {
  const m = new Set([...money].map(id));
  const f = new Set([...fail].map(id));
  const log: string[] = [];
  return { log, holds: async (u: string) => (log.push(u), f.has(u) ? Promise.reject(new Error("rpc down")) : m.has(u)) };
}
// notes in lane 0 (0, 8, 16) and lane 3 (3); lane 5 empty with money at its 11th and 31st index; lane 2 with money past
// its first 21; lane 6 with money under an index that holds a note (6) and the next one skipped (14 empty, 22 money)
const LANES: Pick<NoteRestore, "notes" | "laneHighest"> = {
  notes: [note(dep(0)), note(dep(8)), note(dep(16)), note(dep(3)), note(dep(6)), note(ch(L1, 0))],
  laneHighest: [16, null, null, 3, null, null, 6, null],
};
const at = (lane: number, k: number) => lane + 8 * k;

test("step 5: every lane's deposit ids are read to 21 past its highest with a note or money (an empty lane: its first 21)", async () => {
  const { holds, log } = idReader([at(5, 10), at(5, 30), at(2, 21), at(6, 0), at(6, 2)]);
  const got = await restoreDepositIds(SEED, SCOPE, LANES, holds);
  assert.deepEqual(got.map((x) => [x.lane, x.notes, x.money, x.highest, x.readTo]), [
    [0, [0, 8, 16], [], 16, at(0, 2 + DEPOSIT_ID_MARGIN)],
    [1, [], [], null, at(1, DEPOSIT_ID_MARGIN - 1)],
    [2, [], [], null, at(2, DEPOSIT_ID_MARGIN - 1)], // money at its 22nd index lies past the margin of an empty lane
    [3, [3], [], 3, at(3, DEPOSIT_ID_MARGIN)],
    [4, [], [], null, at(4, DEPOSIT_ID_MARGIN - 1)],
    [5, [], [at(5, 10), at(5, 30)], at(5, 30), at(5, 30 + DEPOSIT_ID_MARGIN)],
    [6, [6], [6, at(6, 2)], at(6, 2), at(6, 2 + DEPOSIT_ID_MARGIN)],
    [7, [], [], null, at(7, DEPOSIT_ID_MARGIN - 1)],
  ]);
  // every index of each lane up to readTo, once each, as its U
  const want = got.flatMap((x) => Array.from({ length: (x.readTo - x.lane) / 8 + 1 }, (_, k) => id(at(x.lane, k))));
  assert.deepEqual(log, want);
});

test("step 5: an id read that fails counts as money (listed, the lane goes on past it); a lane's highest that is not its highest note is refused", async () => {
  const { holds } = idReader([], [at(1, 20)]);
  const got = await restoreDepositIds(SEED, SCOPE, LANES, holds);
  assert.deepEqual(got[1]!.unread, [{ i: at(1, 20), id: id(at(1, 20)), error: "rpc down" }]);
  assert.equal(got[1]!.highest, at(1, 20));
  assert.equal(got[1]!.readTo, at(1, 20 + DEPOSIT_ID_MARGIN));
  await assert.rejects(restoreDepositIds(SEED, SCOPE, { ...LANES, laneHighest: [8, null, null, 3, null, null, 6, null] }, holds), /lane 0: its highest 8 is not its highest note/);
  await assert.rejects(restoreDepositIds(SEED, SCOPE, { ...LANES, laneHighest: [16, null, null, 3, null, null, 6] }, holds), /one per lane/);
});

test("step 7: the new lane's counter goes past the lost store's possible index, and every open re-reads each lane to its highest plus two for 72 h", async () => {
  const { holds } = idReader([at(6, 2)]);
  const lanes: LaneIds[] = await restoreDepositIds(SEED, SCOPE, LANES, holds);
  const T = 1_762_600_000_000;
  for (const [lane, min] of [[0, at(0, 4)], [1, at(1, 1)], [6, at(6, 4)]] as const) {
    const asked: [bigint, number][] = [];
    const plan = await afterRestore(SEED, { lane, raiseDepositIndex: async (s, m) => (asked.push([s, m]), m) }, SCOPE, lanes, T);
    assert.deepEqual(asked, [[SCOPE, min]], `lane ${lane}`);
    assert.equal(plan.next, min);
    assert.equal(plan.until, T + REREAD_MS);
    // lane 0: 0, 8, 16 hold notes, so 24 and 32; an empty lane: its first two; lane 6: 6 a note, 22 money, so 14, 30, 38
    const of = (l: number) => plan.rereads.filter((x) => x.lane === l).map((x) => x.i);
    assert.deepEqual(of(0), [24, 32]);
    assert.deepEqual(of(1), [1, 9]);
    assert.deepEqual(of(3), [11, 19]);
    assert.deepEqual(of(6), [14, 30, 38]);
    assert.ok(plan.rereads.every((x) => x.id === id(x.i)));
    assert.deepEqual(rereadsDue(plan, T + REREAD_MS - 1), plan.rereads);
    assert.deepEqual(rereadsDue(plan, T + REREAD_MS), []);
  }
  await assert.rejects(afterRestore(SEED, { lane: 0, raiseDepositIndex: async () => 0 }, SCOPE, lanes.slice(1), T), /one per lane/);
});
