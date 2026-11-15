// Card move-parts-show-as-one: a vault withdraw proof spends one note, so the signing page sends a move from Cash bigger
// than any one note as parts, each its own withdrawal, quote and op: the first under the move's id, the rest under
// `<id>/1`, `<id>/2`, ... (packages/signpage/src/cash-to-pool.ts sendParts; a buy's move under cash/<chain>/<ms>, a Move
// under its request id). The app followed only the first part (moveOp and Activity's row), the others hidden as legs
// (withoutMoveLegs), so Done showed while a later part was still on its way. A move is one move over all its parts: its
// stage the least advanced part, failed if any part failed, done only when every part is, its amounts their sums.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Operation, SignpageState } from "@blindfill/kit";
import { activity } from "../src/screens/portfolio/model.ts";
import type { PortfolioData } from "../src/screens/portfolio/model.ts";
import { moveOp, moveRunning } from "../src/screens/portfolio/move.ts";

const NOW = Date.parse("2026-11-15T14:28:00Z");
const BUY = `cash/solana/${NOW}`;
const MOVE = "3c1f0b2e-8a4d-4e6f-9a10-2b3c4d5e6f70";
const DATA = { exported: [] } as unknown as PortfolioData;
const part = (id: string, stage: string, amount: string, more: Record<string, unknown> = {}): Operation =>
  ({ id, kind: "move", from: "near", to: "solana", stage, txs: [{ chain: "near", hash: `h-${id}` }], amount, created_ms: NOW, ...more }) as unknown as Operation;
const state = (ops: readonly Operation[]): SignpageState => ({ ops }) as unknown as SignpageState;
// the rail's follow of each part, a deposit op under the part's id: a leg, never the move's stage
const follows = (id: string): Operation[] => [{ id: `${id}/1click`, kind: "deposit", stage: "done", txs: [], created_ms: NOW, amount_usd: "1" } as unknown as Operation];

for (const [name, id] of [["a buy's move from Cash", BUY], ["a Move from Cash", MOVE]] as const) {
  test(`${name} of three parts, one still on its way, shows on its way, never done`, () => {
    const ops = [part(id, "done", "1.5", { out: "0.01" }), ...follows(id), part(`${id}/1`, "done", "2.25", { out: "0.015" }), part(`${id}/2`, "in_transit", "0.25", { out: "0.0015" }), ...follows(`${id}/2`)];
    const m = moveOp(state(ops), id);
    assert.equal(m?.stage, "in_transit", "the least advanced part's stage");
    assert.equal(moveRunning(m), true);
    const rows = activity(ops, DATA);
    assert.deepEqual(rows.map((r) => [r.id, r.stage]), [[id, "in_transit"]], "one Activity row, its parts no rows");
    assert.equal(rows[0]!.failed, null);
  });

  test(`${name} with one part failed shows failed, whatever the others`, () => {
    const ops = [part(id, "done", "1.5"), part(`${id}/1`, "failed", "2.25"), part(`${id}/2`, "in_transit", "0.25")];
    assert.equal(moveOp(state(ops), id)?.stage, "failed");
    const [row] = activity(ops, DATA);
    assert.equal(row!.stage, "failed");
    assert.deepEqual(row!.failed, { reason: null });
    // the first part failed and the others done: failed too
    assert.equal(moveOp(state([part(id, "failed", "1.5"), part(`${id}/1`, "done", "2.25"), part(`${id}/2`, "done", "0.25")]), id)?.stage, "failed");
  });

  test(`${name} shows done only once every part is done, its amount and what landed the parts' sums`, () => {
    const ops = [part(id, "done", "1.5", { out: "0.01" }), part(`${id}/1`, "done", "2.25", { out: "0.015" }), part(`${id}/2`, "done", "0.25", { out: "0.0015" })];
    const m = moveOp(state(ops), id)!;
    assert.equal(m.stage, "done");
    assert.equal(m.amount, "4", "1.5 + 2.25 + 0.25");
    assert.equal(m.out, "0.0265", "0.01 + 0.015 + 0.0015");
    assert.deepEqual(m.txs.map((t) => t.hash), [`h-${id}`, `h-${id}/1`, `h-${id}/2`], "every part's transactions");
    assert.equal(activity(ops, DATA)[0]!.move?.amount, "4");
    // a part with no amount yet: no sum is made up
    assert.equal(moveOp(state([ops[0]!, ops[1]!, part(`${id}/2`, "done", undefined as unknown as string, { out: "0.0015" })]), id)!.out, "0.0265");
    assert.equal(moveOp(state([ops[0]!, ops[1]!, part(`${id}/2`, "done", undefined as unknown as string)]), id)!.amount, undefined);
  });

  test(`${name}: the least advanced part's stage, each stage in order`, () => {
    assert.equal(moveOp(state([part(id, "into_pool", "1"), part(`${id}/1`, "leaving", "1"), part(`${id}/2`, "in_transit", "1")]), id)?.stage, "leaving");
    assert.equal(moveOp(state([part(id, "done", "1"), part(`${id}/1`, "into_pool", "1"), part(`${id}/2`, "done", "1")]), id)?.stage, "into_pool");
    // a refunded part and the rest done: refunded; one still running: on its way
    assert.equal(moveOp(state([part(id, "done", "1"), part(`${id}/1`, "refunded", "1")]), id)?.stage, "refunded");
    assert.equal(moveOp(state([part(id, "refunded", "1"), part(`${id}/1`, "in_transit", "1")]), id)?.stage, "in_transit");
  });
}

test("a move of one part reads as before, and a part the app cannot read leaves the move unread", () => {
  const one = part(BUY, "done", "1.5", { out: "0.01" });
  assert.deepEqual(moveOp(state([one, ...follows(BUY)]), BUY), one);
  assert.equal(moveOp(state([one, { id: `${BUY}/1`, kind: "move", stage: "nowhere", txs: [] } as unknown as Operation]), BUY), null);
  // another move whose id only starts the same is its own move
  const other = part(`${BUY}0`, "in_transit", "9");
  assert.equal(moveOp(state([one, other]), BUY)?.stage, "done");
  assert.deepEqual(activity([one, other], DATA).map((r) => r.id).sort(), [BUY, `${BUY}0`]);
});

test("a pool-to-pool Move through Cash is done only once every part of its onward move is", () => {
  // pool-to-cash.ts onward: the Move mirrors `<id>/on`'s stage, and that onward move is Cash's own, so in parts too
  const from = { from: "base", to: "solana" };
  const ops = [part(MOVE, "done", "0.08", from), part(`${MOVE}/on`, "done", "20"), part(`${MOVE}/on/1`, "in_transit", "5")];
  assert.equal(moveOp(state(ops), MOVE)?.stage, "in_transit");
  assert.deepEqual(activity(ops, DATA).map((r) => [r.id, r.stage]), [[MOVE, "in_transit"]]);
  // what left is the Move's own amount, never its onward move's USDC
  assert.equal(moveOp(state(ops), MOVE)?.amount, "0.08");
  // in the vault with its onward move still leaving: it shows in the vault, never back at the start
  assert.equal(moveOp(state([part(MOVE, "in_vault", "0.08", from), part(`${MOVE}/on`, "leaving", "20"), part(`${MOVE}/on/1`, "leaving", "5")]), MOVE)?.stage, "in_vault");
  assert.equal(moveOp(state([part(MOVE, "in_transit", "0.08", from), part(`${MOVE}/on`, "in_transit", "20"), part(`${MOVE}/on/1`, "failed", "5")]), MOVE)?.stage, "failed");
});
