// A Cash withdrawal one note can pay takes the smallest note that covers it (card
// cash-withdraw-takes-the-smallest-covering-note; wallet.md §2.5 step 1's rule W:640 and WU-09 W:1057 at research
// 28b2f3c): the larger notes stay whole, as withdrawRequest's own pick and planCashSpend's `one` keep them. Then the
// planner's properties over random note sets, and the amounts a plan sends, the same as the search alone sends.
//   node --test test/cash-withdraw-smallest-note.test.ts   (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { planPoolWithdraw, WITHDRAW_PLAN_NOTES, type WithdrawSource } from "../src/pool-withdraw.ts";
import { withdrawNoteFloor } from "../src/rules/pool.ts";
import { cashCosts, cashNotes, cashSendable, checkAmount, planCashWithdraw } from "../src/withdraw/checks.ts";

const FEE = 120_000n; // WU-09's fixture relay fee, 0.12 USDC
const usdc = (x: string): bigint => {
  const [a, b = ""] = x.split(".");
  return BigInt(a!) * 1_000_000n + BigInt(b.padEnd(6, "0"));
};
const SCOPE = 1n;
type Rec = Pick<NoteRecord, "id" | "state" | "scope"> & { leaf: { value: bigint } };
const rec = (id: string, value: bigint, state: NoteRecord["state"] = "UNSPENT"): Rec => ({ id, state, scope: SCOPE, leaf: { value } });
const sources = (rs: readonly Rec[]): WithdrawSource[] => cashNotes(rs as unknown as NoteRecord[], SCOPE);

// WU-09's notes: 50, 30, 15, 4, 0.24 and 0, and a note HELD by another proof in progress.
const WU09 = [
  rec("n50", usdc("50")), rec("n30", usdc("30")), rec("n15", usdc("15")), rec("n4", usdc("4")),
  rec("n024", usdc("0.24")), rec("n0", 0n), rec("h100", usdc("100"), "HELD"),
];

test("WU-09: $10 takes the $15 note alone, the smallest that covers it, never the $50", () => {
  assert.deepEqual(planCashWithdraw(sources(WU09), usdc("10"), FEE), [{ noteId: "n15", part: usdc("10"), chunk: usdc("10.12") }]);
});

test("WU-09: one note that pays with no change is taken whole; one whose change could never move is passed over", () => {
  // $14.88 empties the $15 note exactly
  assert.deepEqual(planCashWithdraw(sources(WU09), usdc("14.88"), FEE), [{ noteId: "n15", part: usdc("14.88"), chunk: usdc("15") }]);
  // $14.80 would leave the $15 note 0.08, under the floor: the next note up, the $30, pays it alone
  assert.deepEqual(planCashWithdraw(sources(WU09), usdc("14.80"), FEE), [{ noteId: "n30", part: usdc("14.80"), chunk: usdc("14.92") }]);
  // the floor is the move's: a higher least part raises it, so the $15 note's 0.5 change is passed over at a least of 0.5
  const floor = withdrawNoteFloor(cashCosts(FEE, usdc("0.5")));
  assert.ok(usdc("0.5") < floor);
  assert.equal(planCashWithdraw(sources(WU09), usdc("14.38"), FEE, usdc("0.5"))?.[0]?.noteId, "n30");
});

test("WU-09: the max and what no note can make, as before", () => {
  const src = sources(WU09);
  assert.equal(cashSendable(src, FEE), usdc("98.52"));
  assert.deepEqual(planCashWithdraw(src, usdc("98.52"), FEE)?.map((p) => p.noteId), ["n50", "n30", "n15", "n4"]);
  assert.equal(planCashWithdraw(src, usdc("98.53"), FEE), null);
  // above every single note: the search, unchanged (49.88 + 15.04 + 14.88)
  assert.deepEqual(planCashWithdraw(src, usdc("79.80"), FEE), [
    { noteId: "n50", part: usdc("49.88"), chunk: usdc("50") },
    { noteId: "n30", part: usdc("15.04"), chunk: usdc("15.16") },
    { noteId: "n15", part: usdc("14.88"), chunk: usdc("15") },
  ]);
});

/** A small seeded generator, so a failing set is the same set on every run. */
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * n);
  };
}

/** planCashWithdraw as it was before this card (a6c1109c7), the oracle of which amounts a plan sends. */
function planBefore(notes: readonly WithdrawSource[], amount: bigint, fee: bigint, minPart: bigint): unknown[] | null {
  if (amount < minPart) return null;
  const all = notes.filter((n) => n.value - fee >= minPart).sort((x, y) => (x.value !== y.value ? (x.value > y.value ? -1 : 1) : x.id < y.id ? -1 : 1));
  const whole = (n: WithdrawSource) => ({ noteId: n.id, part: n.value - fee, chunk: n.value });
  if (amount === cashSendable(all, fee, minPart)) return all.map(whole);
  if (all.length <= WITHDRAW_PLAN_NOTES) return planPoolWithdraw(all, amount, cashCosts(fee, minPart));
  const [first, ...rest] = all as [WithdrawSource, ...WithdrawSource[]];
  const tail = amount > first.value - fee ? planBefore(rest, amount - (first.value - fee), fee, minPart) : null;
  return tail !== null ? [whole(first), ...tail] : planPoolWithdraw(all, amount, cashCosts(fee, minPart));
}
const searchAlone = (src: readonly WithdrawSource[], amount: bigint, fee: bigint, minPart: bigint): boolean => planBefore(src, amount, fee, minPart) !== null;

test("past the search's 16 notes: a smaller note it never reads pays nothing alone, so the form's nearest amounts stay what runs", () => {
  // 16 notes of 0.42 and one of 0.32 (review of f340ddbd1): 0.20 fits only the 0.32 note, outside the 16 the search reads
  const src = [...Array.from({ length: WITHDRAW_PLAN_NOTES }, (_, i) => ({ id: `b${String(i).padStart(2, "0")}`, value: 420_000n })), { id: "s", value: 320_000n }];
  assert.equal(planCashWithdraw(src, 200_000n, FEE), null);
  assert.equal(searchAlone(src, 200_000n, FEE, FEE + 1n), false);
  const c = checkAmount("0.2", { notes: src, fee: FEE });
  assert.equal(c.ok, false);
  // within the 16: 0.30 is one 0.42 note whole, as before
  assert.deepEqual(planCashWithdraw(src, 300_000n, FEE), [{ noteId: "b00", part: 300_000n, chunk: 420_000n }]);
});

test("random note sets: every plan sends the amount exactly from unheld notes above 0, each part a withdrawal the vault takes, and the same amounts are plannable as by the search alone", () => {
  const r = rng(0x5eed);
  let plans = 0;
  let singles = 0;
  for (let t = 0; t < 1500; t++) {
    const fee = BigInt(r(300_000));
    const minPart = fee + 1n + (r(3) === 0 ? BigInt(r(2_000_000)) : 0n);
    const floor = withdrawNoteFloor(cashCosts(fee, minPart));
    const rs = Array.from({ length: 1 + r(WITHDRAW_PLAN_NOTES + 8) }, (_, i) =>
      rec(`x${i}`, r(5) === 0 ? 0n : BigInt(r(4) === 0 ? r(3_000_000) : r(80_000_000)), r(5) === 0 ? "HELD" : "UNSPENT"));
    const src = sources(rs);
    const max = cashSendable(src, fee, minPart);
    // amounts: random, every note whole less its fee, and around each note's floor edge
    const amounts = new Set<bigint>([max, max + 1n, minPart, minPart - 1n]);
    for (let k = 0; k < 12 && max > 0n; k++) amounts.add(1n + BigInt(r(Number(max))));
    for (const n of src) for (const d of [0n, floor - 1n, floor, floor + 1n]) if (n.value - fee - d > 0n) amounts.add(n.value - fee - d);
    for (const amount of amounts) {
      const p = planCashWithdraw(src, amount, fee, minPart);
      const why = `fee ${fee} minPart ${minPart} amount ${amount} notes ${rs.map((x) => `${x.id}:${x.leaf.value}:${x.state}`).join(",")}`;
      assert.equal(p !== null, searchAlone(src, amount, fee, minPart), `plannable as by the search alone: ${why}`);
      if (p === null) continue;
      plans++;
      if (p.length === 1) singles++;
      assert.equal(p.reduce((s, x) => s + x.part, 0n), amount, `sum: ${why}`);
      assert.equal(new Set(p.map((x) => x.noteId)).size, p.length, `no note twice: ${why}`);
      for (const x of p) {
        const n = rs.find((y) => y.id === x.noteId)!;
        assert.ok(n, `a note of the set: ${why}`);
        assert.equal(n.state, "UNSPENT", `never a HELD note: ${why}`);
        assert.ok(n.leaf.value > 0n, `never a 0 note: ${why}`);
        assert.equal(x.chunk, x.part + fee, `the fee on top of the part: ${why}`);
        assert.ok(x.part > fee && x.part >= minPart, `above its fee and the least part: ${why}`);
        assert.ok(x.chunk <= n.leaf.value, `part and fee within the note: ${why}`);
        const change = n.leaf.value - x.chunk;
        assert.ok(change === 0n || change >= floor, `change 0 or at the floor: ${why}`);
        assert.ok(fee * 10_000n <= x.chunk * 5_000n, `the vault's MAX_RELAY_FEE_BPS backstop: ${why}`);
      }
      // one note covering the amount with a change that moves: the plan is that note alone, the smallest such
      // (among the notes the search reads: the WITHDRAW_PLAN_NOTES largest)
      const read = [...src].filter((n) => n.value - fee >= minPart).sort((x, y) => (x.value !== y.value ? (x.value > y.value ? -1 : 1) : x.id < y.id ? -1 : 1)).slice(0, WITHDRAW_PLAN_NOTES);
      const covers = read.filter((n) => n.value - fee >= amount && (n.value - fee === amount || n.value - fee - amount >= floor));
      if (covers.length > 0) {
        const least = covers.reduce((a, b) => (b.value < a.value || (b.value === a.value && b.id < a.id) ? b : a));
        assert.deepEqual(p, [{ noteId: least.id, part: amount, chunk: amount + fee }], `the smallest covering note: ${why}`);
      }
    }
  }
  assert.ok(plans > 2_000 && singles > 500, `the sets reach both paths: ${plans} plans, ${singles} single`);
});
