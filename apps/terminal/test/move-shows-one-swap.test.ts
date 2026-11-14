// Card move-shows-one-swap: the two faults the owner saw on release 137 during a Move of 0.08 SOL from Solana to Base.
// 1. The withdraw sheet opened by itself on its Withdraw tab (Processing, the amount): the signing page runs a Move's
//    pool release as the pool withdraw run under `<move id>/out` (packages/signpage/src/pool-to-cash.ts sendDirect), and
//    state.ops sends that record as a withdraw op (packages/signpage/src/state.ts readOps); the withdraw progress drew
//    every new withdraw op. A Move's legs are the Move's: never a withdrawal drawn, an Activity row or a deposit's Recent.
// 2. The running Move drew Solana, NEAR Intents, NEAR, NEAR Intents, Base: the sheet's route before (and, since the start
//    dropped the dry, during) a Move went through the NEAR vault, while the page runs one swap. The default is the
//    signing page's own steps for every pair (packages/signpage/src/cash-to-pool.ts CASH_TO_POOL_STEPS,
//    POOL_TO_CASH_STEPS, POOL_TO_POOL_STEPS).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Operation } from "@blindfill/kit";
import { recentRows } from "../src/screens/deposit/model.ts";
import { activity } from "../src/screens/portfolio/model.ts";
import type { PortfolioData } from "../src/screens/portfolio/model.ts";
import { MOVE_CHAINS, nodesOf, routeSteps } from "../src/screens/portfolio/move.ts";
import type { MoveChain } from "../src/screens/portfolio/move.ts";
import { current, EMPTY, observe } from "../src/screens/withdraw/model.ts";

const NOW = Date.parse("2026-11-14T11:44:00Z");
const MOVE = "9b2f6c1e-4d2a-4b8e-9f00-1c2d3e4f5a6b";
const move = (stage: string): Operation => ({ id: MOVE, kind: "move", from: "solana", to: "base", stage, txs: [], amount: "0.08", created_ms: NOW }) as unknown as Operation;
const out = (stage: string): Operation => ({ id: `${MOVE}/out`, kind: "withdraw", stage, txs: [], created_ms: NOW + 1, amount_usd: "43.69" }) as unknown as Operation;
const legs = (stage: string): Operation[] => [
  move(stage),
  out("in_transit"),
  { id: `${MOVE}/pool`, kind: "pool_deposit", chain: "base", stage: "in_transit", txs: [], created_ms: NOW + 1 } as unknown as Operation,
  { id: `${MOVE}/1click`, kind: "deposit", stage: "done", txs: [], created_ms: NOW + 1, amount_usd: "43.69" } as unknown as Operation,
];
const DATA = { exported: [] } as unknown as PortfolioData;

test("a Move's pool release never opens the withdraw sheet, from its first stage to its last", () => {
  // the session's first state, then the Move's tap and its legs
  let w = observe(EMPTY, [], NOW);
  for (const [i, stage] of ["leaving", "in_transit", "into_pool", "done"].entries()) {
    const ops = legs(stage);
    w = observe(w, ops, NOW + i * 1000);
    assert.equal(current(w, ops, NOW + i * 1000 + 9000), null, `the Move at ${stage}: no withdrawal drawn`);
  }
  // a reload mid-way: the running leg at the first state is the Move's too
  const ops = legs("in_transit");
  assert.equal(current(observe(EMPTY, ops, NOW), ops, NOW + 9000), null, "after a reload mid-way");
});

test("a withdrawal of its own is still drawn beside a Move, and a leg whose Move is not in the state is", () => {
  const own = { id: "5d1f0c2a-7a8b-4c3d-9e0f-112233445566", kind: "withdraw", stage: "in_transit", txs: [], created_ms: NOW } as unknown as Operation;
  const ops = [...legs("in_transit"), own];
  const w = observe(observe(EMPTY, [], NOW), ops, NOW);
  assert.equal(current(w, ops, NOW + 9000)?.op.id, own.id);
  // an id with a slash is the Move's only while that Move is in the state: nothing is hidden on its shape alone
  const orphan = [out("in_transit")];
  assert.equal(current(observe(observe(EMPTY, [], NOW), orphan, NOW), orphan, NOW)?.op.id, `${MOVE}/out`);
});

test("a Move's legs are no Activity rows and no deposit Recent rows", () => {
  const ops = legs("done");
  assert.deepEqual(activity(ops, DATA).map((r) => r.id), []);
  assert.deepEqual(recentRows(ops), []);
  // the same ops with no Move in the state are each its own row, as before
  assert.deepEqual(activity(ops.slice(1), DATA).map((r) => r.id).sort(), [`${MOVE}/1click`, `${MOVE}/out`]);
  assert.equal(recentRows(ops.slice(1)).length, 2);
});

// the signing page's steps for each pair (packages/signpage/src/cash-to-pool.ts:359-363, release 136 on; main.ts gives
// the pool-to-pool move its `direct` host, so a pool to a pool is one swap)
const PAGE = (from: MoveChain, to: MoveChain): [string, string][] =>
  from === "near" ? [["vault_out", "near"], ["intents", to], ["pool_in", to]] : to === "near" ? [["pool_out", from], ["intents", "near"], ["vault_in", "near"]] : [["pool_out", from], ["intents", to], ["pool_in", to]];

test("the route before the dry answers is the signing page's own, for every pair: a pool to a pool is one swap", () => {
  let n = 0;
  for (const from of MOVE_CHAINS)
    for (const to of MOVE_CHAINS) {
      if (from === to) continue;
      n++;
      assert.deepEqual(routeSteps(from, to)?.map((s) => [s.step, s.chain]), PAGE(from, to), `${from} to ${to}`);
    }
  assert.equal(n, 12);
  // Solana to Base draws Solana, NEAR Intents, Base: no NEAR in the middle
  assert.deepEqual(nodesOf(routeSteps("solana", "base")!).map((x) => `${x.kind}:${x.chain}`), ["pool:solana", "intents:base", "pool:base"]);
});
