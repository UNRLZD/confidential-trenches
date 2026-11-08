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
import { RESTORE_GAP, RESTORE_LANES, type NoteRestore, type RestoredNote, type RestoredSpend } from "../src/notes/restore.ts";
import { refKey } from "../src/notes/store.ts";
import type { NoteRef } from "../src/notes/secrets.ts";
import { afterRestore, ARM_TAGS, DEPOSIT_ID_MARGIN, HOP_TAGS, REREAD_MS, rereadsDue, restoreDepositIds, restoreWallets, type HistoryChain, type IdState, type LaneIds } from "../src/restore/wallets.ts";

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
// an id reader: "money" for the indices in `money`, "used" for those in `used`, a failure for those in `fail`
function idReader(money: Iterable<number>, fail: Iterable<number> = [], used: Iterable<number> = []) {
  const m = new Set([...money].map(id));
  const f = new Set([...fail].map(id));
  const u = new Set([...used].map(id));
  const log: string[] = [];
  return { log, holds: async (x: string): Promise<IdState> => (log.push(x), f.has(x) ? Promise.reject(new Error("rpc down")) : m.has(x) ? "money" : u.has(x) ? "used" : "unused") };
}
// notes in lane 0 (0, 8, 16) and lane 3 (3); lane 5 empty with money at its 11th and 31st index; lane 2 with money past
// its first 21; lane 6 with money under an index that holds a note (6) and the next one skipped (14 empty, 22 money)
// each lane's walk end as the note walk returns it (restorePages laneWalked): gap past its last note or its reach
const walkedTo = (laneHighest: readonly (number | null)[], gap = RESTORE_GAP, reach: readonly (number | null)[] = []) =>
  laneHighest.map((h, l) => Math.max(h ?? l - RESTORE_LANES, reach[l] ?? -Infinity) + RESTORE_LANES * gap);
const HIGH = [16, null, null, 3, null, null, 6, null];
const LANES: Pick<NoteRestore, "notes" | "laneHighest" | "laneWalked"> = {
  notes: [note(dep(0)), note(dep(8)), note(dep(16)), note(dep(3)), note(dep(6)), note(ch(L1, 0))],
  laneHighest: HIGH,
  laneWalked: walkedTo(HIGH),
};
const ONE = [0, null, null, null, null, null, null, null];
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
  // an answer that is not money, used or unused is a failed read, never "unused" (R12)
  for (const bad of [undefined, null, 0, "yes", true, false]) {
    const got2 = await restoreDepositIds(SEED, SCOPE, LANES, async (u) => (u === id(at(7, 3)) ? (bad as unknown as IdState) : "unused"));
    assert.deepEqual(got2[7]!.unread, [{ i: at(7, 3), id: id(at(7, 3)), error: "the read answered neither money, used nor unused" }], String(bad));
    assert.equal(got2[7]!.highest, at(7, 3), String(bad));
  }
});

// the review's case: 21 or more ids of a lane used (refunded to U, then withdrawn out) and now empty, then one still
// holding a refund. A gap limit counts ids never used, not ids at zero (BIP-44), so the money past them is read.
test("step 5: ids that were used and are now empty reset the margin as money does; only ids never used count toward it", async () => {
  const used = Array.from({ length: 21 }, (_, k) => at(0, k + 1)); // 8 .. 168
  const { holds } = idReader([at(0, 22)], [], used); // money at 176
  const got = await restoreDepositIds(SEED, SCOPE, { notes: [note(dep(0))], laneHighest: ONE, laneWalked: walkedTo(ONE) }, holds);
  assert.deepEqual([got[0]!.notes, got[0]!.money, got[0]!.used, got[0]!.highest, got[0]!.readTo], [[0], [at(0, 22)], used, at(0, 22), at(0, 22 + DEPOSIT_ID_MARGIN)]);
  // in an empty lane too: a used id at its 21st index carries the read to the money at its 30th
  const e = await restoreDepositIds(SEED, SCOPE, LANES, idReader([at(4, 30)], [], [at(4, 20)]).holds);
  assert.deepEqual([e[4]!.money, e[4]!.used, e[4]!.highest], [[at(4, 30)], [at(4, 20)], at(4, 30)]);
  // ids with history past the note walk's end may hold notes it never matched: that lane stops there and names it as
  // its reach, the other lanes read on (review F5). The walk's end is the one the restore returned (laneWalked, F4):
  // lane 4 walked to 12 with gap 2, and the default gap's end would read on past 20
  const short = { ...LANES, laneWalked: walkedTo(HIGH, 2) };
  const past = await restoreDepositIds(SEED, SCOPE, short, idReader([], [], [at(4, 0), at(4, 1), at(4, 2)]).holds);
  assert.deepEqual([past[4]!.used, past[4]!.highest, past[4]!.readTo, past[4]!.reach], [[at(4, 0), at(4, 1), at(4, 2)], at(4, 2), at(4, 2), at(4, 2)]);
  assert.deepEqual(past.map((x) => x.reach), [null, null, null, null, at(4, 2), null, null, null]);
  assert.equal(past[0]!.readTo, at(0, 2 + DEPOSIT_ID_MARGIN), "lane 0 reads on to its margin");
  // history exactly at the walk's last index is inside it: no stop
  const edge = await restoreDepositIds(SEED, SCOPE, short, idReader([], [], [at(4, 1)]).holds);
  assert.deepEqual([edge[4]!.used, edge[4]!.highest, edge[4]!.reach], [[at(4, 1)], at(4, 1), null]);
  // a walk end per lane, each an index of its lane at or past its highest note, or the restore is refused
  await assert.rejects(restoreDepositIds(SEED, SCOPE, { ...LANES, laneWalked: walkedTo(HIGH).slice(1) }, holds), /laneWalked: one per lane/);
  await assert.rejects(restoreDepositIds(SEED, SCOPE, { ...LANES, laneWalked: [9, ...walkedTo(HIGH).slice(1)] }, holds), /lane 0: its walk end 9 is not an index of the lane at or past its highest note/);
  await assert.rejects(restoreDepositIds(SEED, SCOPE, { ...LANES, laneWalked: [8, ...walkedTo(HIGH).slice(1)] }, holds), /lane 0: its walk end 8 is not an index of the lane at or past its highest note/);
});

// review 2: has_public_key is true for every implicit id (D15), so a reader may answer "used" for every id: the lane's
// highest moves with each read and its margin never comes, so the walk's end is held as the highest moves. Review F5:
// each lane stops at its first id past its walk's end and names it, and the restore finishes with what it found. A run
// still going after 3 s fails the test and every later read hangs.
test("step 5 (F5): a reader that answers used for every id finishes in bounded reads, each lane stopped past its walk's end", { timeout: 5_000 }, async () => {
  let halted = false;
  let reads = 0;
  const t = setTimeout(() => (halted = true), 3_000);
  const r = { ...LANES, laneWalked: walkedTo(HIGH, 50) };
  const p = restoreDepositIds(SEED, SCOPE, r, () => (reads++, halted ? new Promise<IdState>(() => {}) : new Promise<IdState>((res) => setImmediate(() => res("used")))));
  const got = await Promise.race([p, new Promise<string>((res) => setTimeout(() => res("step 5 never ended"), 3_100))]);
  clearTimeout(t);
  assert.notEqual(got, "step 5 never ended");
  const lanes = got as LaneIds[];
  // lane 0's last note is 16: the walk ends at 16 + 8 * 50 = 416, and the first used id past it, 424, ends the lane
  assert.deepEqual([lanes[0]!.reach, lanes[0]!.readTo, lanes[0]!.highest], [424, 424, 424]);
  for (const x of lanes) assert.equal(x.reach, r.laneWalked[x.lane]! + RESTORE_LANES, `lane ${x.lane} stops one past its walk's end`);
  // every lane's ids from its first to one past its walk's end, read once each, and no more
  assert.equal(reads, r.laneWalked.reduce((n, w, l) => n + (w - l) / RESTORE_LANES + 2, 0));
  assert.equal(reads, 413);
});

// the review's case: an RPC that keeps failing (or answering 429) moved the margin with every failure, so a lane read
// on toward 2^32. Each read fails a macrotask later, and a run still going after 3 s fails the test and every later
// read hangs, so a run that never stops ends as a failure, its process with it.
test("step 5: margin id reads failed with no read showing history between them end the restore with an error", { timeout: 5_000 }, async () => {
  let halted = false;
  const ends = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((res, rej) => {
      const t = setTimeout(() => ((halted = true), rej(new Error("step 5 never ended"))), 3_000);
      p.then((v) => (clearTimeout(t), res(v)), (e) => (clearTimeout(t), rej(e)));
    });
  const later = (f: () => IdState | Error) =>
    halted ? new Promise<IdState>(() => {}) : new Promise<IdState>((res, rej) => setImmediate(() => { const x = f(); x instanceof Error ? rej(x) : res(x); }));
  let reads = 0;
  await assert.rejects(
    ends(restoreDepositIds(SEED, SCOPE, LANES, () => (reads++, later(() => new Error("HTTP 429"))))),
    new RegExp(`lane 0: ${DEPOSIT_ID_MARGIN} id reads failed with none showing history between them \\(the last at index ${at(0, DEPOSIT_ID_MARGIN - 1)}: HTTP 429\\); the restore stops, to be retried`),
  );
  assert.equal(reads, DEPOSIT_ID_MARGIN, "lane 0 stops at its margin-th failed read, its ids read from index 0");
  // a read that shows history between failures starts the count again: margin 3, failures, money, failures
  const fails = new Set([at(1, 0), at(1, 1), at(1, 3), at(1, 4)].map(id));
  const got = await ends(restoreDepositIds(SEED, SCOPE, LANES, (u) => later(() => (fails.has(u) ? new Error("rpc down") : u === id(at(1, 2)) ? "money" : "unused")), { margin: 3 }));
  assert.deepEqual([got[1]!.unread.map((x) => x.i), got[1]!.money, got[1]!.highest, got[1]!.readTo], [[at(1, 0), at(1, 1), at(1, 3), at(1, 4)], [at(1, 2)], at(1, 4), at(1, 7)]);
  // review 2's R27: a read of a never-used id between failures does not restart the count, so a reader that fails every
  // other read ends at its margin-th failure (41 reads), never toward 2^32
  let alt = 0;
  await assert.rejects(
    ends(restoreDepositIds(SEED, SCOPE, LANES, () => later(() => (alt++ % 2 === 0 ? new Error("HTTP 429") : "unused")))),
    new RegExp(`lane 0: ${DEPOSIT_ID_MARGIN} id reads failed with none showing history between them \\(the last at index ${at(0, 2 * (DEPOSIT_ID_MARGIN - 1))}: HTTP 429\\)`),
  );
  assert.equal(alt, 2 * DEPOSIT_ID_MARGIN - 1, "lane 0 stops at its 21st failed read, the 41st read");
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
    assert.equal(plan.until, T + 72 * 3_600_000, "72 h of NEAR block time (a deposit address's life, D44)");
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
  // the lanes in another order: refused, never read as another lane's (R13)
  await assert.rejects(afterRestore(SEED, { lane: 0, raiseDepositIndex: async () => 0 }, SCOPE, [...lanes].reverse(), T), /one per lane, in order/);
});

test("step 7: an id whose read failed and a used id now empty are re-read on each open; the counter goes past them", async () => {
  // lane 1 (empty): index 25 (its 4th) failed, index 33 (its 5th) used and empty; lane 2: index 2 (its 1st) failed
  const lanes = await restoreDepositIds(SEED, SCOPE, LANES, idReader([], [at(1, 3), at(2, 0)], [at(1, 4)]).holds);
  const T = 1_762_600_000_000;
  const asked: number[] = [];
  const plan = await afterRestore(SEED, { lane: 1, raiseDepositIndex: async (_s, m) => (asked.push(m), m) }, SCOPE, lanes, T);
  assert.deepEqual(asked, [at(1, 6)]);
  const of = (l: number) => plan.rereads.filter((x) => x.lane === l).map((x) => x.i);
  assert.deepEqual(of(1), [0, 1, 2, 3, 4, 5, 6].map((k) => at(1, k)));
  assert.deepEqual(of(2), [at(2, 0), at(2, 1), at(2, 2)]);
});

// ---------- card wallet-restore-id-reader ----------
// review 2's R29: a failed read past the note walk's end stops the lane there, as history does (plant R29 drops the
// stop on the failed-read branch, and this read is the one that catches it). Gap 3 and a note at 0: lane 0's walk
// ends at 24, so history at 24 is inside it, 32 is never used, and the read of 40 fails.
test("step 5 (R29): a failed id read past the note walk's end stops the lane at its index and names it as the reach", async () => {
  const { holds, log } = idReader([], [at(0, 5)], [at(0, 3)]);
  const got = await restoreDepositIds(SEED, SCOPE, { notes: [note(dep(0))], laneHighest: ONE, laneWalked: walkedTo(ONE, 3) }, holds);
  assert.deepEqual([got[0]!.used, got[0]!.unread.map((x) => x.i), got[0]!.highest, got[0]!.readTo, got[0]!.reach], [[at(0, 3)], [40], 40, 40, 40]);
  assert.equal(log.filter((u) => u === id(at(0, 6))).length, 0, "nothing past 40 is read in lane 0");
});

// review 2's gap 3: a lane that stops names its reach, and a restore given it walks the notes to it (restoreNotes
// `reach`, whose walk end comes back as laneWalked) and reads the ids on from there, so a user past the walk's end can
// finish. The restore never runs again on its own (F5).
test("step 5: a restore given the reach a lane named walks the lane to it and finishes", async () => {
  const { holds } = idReader([], [], [at(0, 3), at(0, 5)]);
  const first = await restoreDepositIds(SEED, SCOPE, { notes: [note(dep(0))], laneHighest: ONE, laneWalked: walkedTo(ONE, 3) }, holds);
  assert.equal(first[0]!.reach, 40);
  const reach = first.map((x) => x.reach);
  const got = await restoreDepositIds(SEED, SCOPE, { notes: [note(dep(0))], laneHighest: ONE, laneWalked: walkedTo(ONE, 3, reach) }, holds);
  assert.deepEqual([got[0]!.used, got[0]!.highest, got[0]!.readTo, got[0]!.reach], [[at(0, 3), at(0, 5)], at(0, 5), at(0, 5 + DEPOSIT_ID_MARGIN), null]);
});
