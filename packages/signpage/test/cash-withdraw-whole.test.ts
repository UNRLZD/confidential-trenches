// Cash goes out whole (card cash-withdraws-everything-to-any-chain): the withdraw form's amount is planned over every
// UNSPENT note of the vault's scope, one withdrawal per note, each paying the relay fee on top of its part. Max is the
// whole of Cash less a fee per note, at any count of notes; no plan leaves a change no later withdrawal could send.
//   node --test test/cash-withdraw-whole.test.ts   (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { cashNotes, cashSendable, checkAmount, planCashWithdraw } from "../src/withdraw/checks.ts";
import { refusalWords } from "../src/withdraw/form.ts";

const FEE = 120_000n; // 0.12 USDC
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const notes = (...v: number[]) => v.map((x, i) => ({ id: `n${i}`, value: usdc(x) }));
/** Every part pays its fee within its note, is above the fee, and leaves 0 or a change a later withdrawal can send. */
function sound(src: readonly { id: string; value: bigint }[], parts: readonly { noteId: string; part: bigint; chunk: bigint }[], fee: bigint): void {
  assert.equal(new Set(parts.map((p) => p.noteId)).size, parts.length, "one withdrawal per note");
  for (const p of parts) {
    const n = src.find((x) => x.id === p.noteId)!;
    assert.ok(n, p.noteId);
    assert.equal(p.chunk, p.part + fee);
    assert.ok(p.part > fee, "above its fee");
    const change = n.value - p.chunk;
    assert.ok(change === 0n || change - fee > fee, `change ${change} of ${p.noteId} can be sent later`);
  }
}

test("Max is every note whole, each less its fee: three notes of 10, 5 and 2 USDC send 16.64", () => {
  const src = notes(5, 10, 2);
  assert.equal(cashSendable(src, FEE), usdc(9.88 + 4.88 + 1.88));
  const r = checkAmount("16.64", { notes: src, fee: FEE });
  assert.ok(r.ok, JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  // largest first, each note whole
  assert.deepEqual(r.parts, [
    { noteId: "n1", part: usdc(9.88), chunk: usdc(10) },
    { noteId: "n0", part: usdc(4.88), chunk: usdc(5) },
    { noteId: "n2", part: usdc(1.88), chunk: usdc(2) },
  ]);
  // one unit more than Max: what can be sent is named
  assert.deepEqual(checkAmount("16.640001", { notes: src, fee: FEE }), { ok: false, code: "insufficient", below: usdc(16.64) });
});

test("an amount above the largest note is sent from two notes, the fewest that can", () => {
  const src = notes(10, 5, 2);
  const r = checkAmount("12", { notes: src, fee: FEE });
  assert.ok(r.ok);
  assert.equal(r.parts.length, 2);
  assert.equal(r.parts.reduce((t, p) => t + p.part, 0n), usdc(12));
  sound(src, r.parts, FEE);
});

test("an amount whose change could never be sent is refused with the nearest amounts that can be", () => {
  // 9.8 of a 10 USDC note leaves 0.08: under two fees, no withdrawal could ever send it
  const r = checkAmount("9.8", { notes: notes(10), fee: FEE });
  assert.deepEqual(r, { ok: false, code: "unplannable", below: usdc(10) - FEE - (FEE + FEE + 1n), above: usdc(9.88) });
  assert.equal(refusalWords("unplannable", undefined, usdc(9.639999), usdc(9.88)), "Try 9.639999 or 9.88 USDC");
});

test("Max at any count of notes: 40 notes of 1 USDC send 35.2 in 40 withdrawals, and 30 of them whole past the planner's 16", () => {
  const src = notes(...Array.from({ length: 40 }, () => 1));
  assert.equal(cashSendable(src, FEE), usdc(35.2));
  const all = planCashWithdraw(src, usdc(35.2), FEE);
  assert.equal(all?.length, 40);
  sound(src, all!, FEE);
  const thirty = planCashWithdraw(src, usdc(0.88 * 30), FEE);
  assert.equal(thirty?.length, 30);
  sound(src, thirty!, FEE);
  // and one not on a whole note's edge past 16 notes: 20.5 USDC
  const odd = planCashWithdraw(src, usdc(20.5), FEE);
  assert.ok(odd);
  assert.equal(odd.reduce((t, p) => t + p.part, 0n), usdc(20.5));
  sound(src, odd, FEE);
});

test("a note that cannot give more than its fee is left out of Max, never planned", () => {
  const src = notes(10, 0.2);
  assert.equal(cashSendable(src, FEE), usdc(9.88));
  assert.deepEqual(planCashWithdraw(src, usdc(9.88), FEE), [{ noteId: "n0", part: usdc(9.88), chunk: usdc(10) }]);
  assert.equal(planCashWithdraw(src, FEE, FEE), null, "at the fee: nothing");
});

test("cashNotes: the vault scope's UNSPENT notes with a leaf, each id and value", () => {
  const n = (state: string, value: bigint | null, scope = 7n) =>
    ({ id: `${state}${value}`, state, scope, ...(value === null ? {} : { leaf: { value, label: 1n, commitment: 1n, leafIndex: 0n } }) }) as never;
  assert.deepEqual(cashNotes([n("UNSPENT", 5n), n("UNSPENT", 9n), n("HELD", 50n), n("RESERVED", 50n), n("SPENT", 50n), n("UNSPENT", 3n, 8n), n("UNSPENT", null)], 7n), [
    { id: "UNSPENT5", value: 5n },
    { id: "UNSPENT9", value: 9n },
  ]);
});
