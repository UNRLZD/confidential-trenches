// pool.move and pool.move.dry (card one-balance-buys-on-every-chain): the kit's two kinds, their params and answers, the
// move op in state.ops and the buy's route event { move: "cash", op }. A good answer passes; a dry answer with a step
// outside the five, or an op with a stage outside MoveStage, is refused (the op dropped from the state, as any op the
// client cannot read).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOVE_STAGES, MOVE_STEPS, SIGNPAGE_KINDS } from "../src/signpage/messages.ts";
import { SIGNPAGE_PARAM_SCHEMAS, SIGNPAGE_RESULT_SCHEMAS, signpageProgressRouteSchema, signpageReadableOps } from "../src/signpage/schema.ts";
import { STATE } from "./signpage-fixtures.ts";

const P = SIGNPAGE_PARAM_SCHEMAS as Record<string, (v: unknown) => boolean>;
const R = SIGNPAGE_RESULT_SCHEMAS as Record<string, (v: unknown) => boolean>;

test("the two kinds are kinds, with the five steps and seven stages", () => {
  assert.ok((SIGNPAGE_KINDS as readonly string[]).includes("pool.move"));
  assert.ok((SIGNPAGE_KINDS as readonly string[]).includes("pool.move.dry"));
  assert.deepEqual([...MOVE_STEPS], ["vault_out", "pool_out", "intents", "vault_in", "pool_in"]);
  assert.deepEqual([...MOVE_STAGES], ["leaving", "in_transit", "in_vault", "into_pool", "done", "refunded", "failed"]);
});

test("pool.move's params: two trade chains that differ and an amount; nothing else", () => {
  for (const k of ["pool.move", "pool.move.dry"]) {
    assert.equal(P[k]!({ from: "near", to: "solana", amount: "12.5" }), true, k);
    assert.equal(P[k]!({ from: "solana", to: "base", amount: "0.1" }), true, k);
    assert.equal(P[k]!({ from: "near", to: "near", amount: "1" }), false, `${k}: from === to`);
    assert.equal(P[k]!({ from: "near", to: "ethereum", amount: "1" }), false, `${k}: an unknown chain`);
    assert.equal(P[k]!({ from: "near", to: "solana", amount: "-1" }), false, `${k}: not a decimal`);
    assert.equal(P[k]!({ from: "near", to: "solana", amount: "1", wallet: "x" }), false, `${k}: an extra field`);
  }
});

test("pool.move's answer: a move stage and its txs", () => {
  assert.equal(R["pool.move"]!({ stage: "leaving", txs: [] }), true);
  assert.equal(R["pool.move"]!({ stage: "in_transit", txs: [{ chain: "near", hash: "h" }] }), true);
  assert.equal(R["pool.move"]!({ stage: "filled", txs: [] }), false, "a trade's stage is not a move's");
});

test("pool.move.dry's answer: out, fee and steps of the five; a step outside them is refused", () => {
  const good = { out: "0.31", fee: "0.05", steps: [{ step: "vault_out", chain: "near" }, { step: "intents", chain: "solana" }, { step: "pool_in", chain: "solana" }] };
  assert.equal(R["pool.move.dry"]!(good), true);
  assert.equal(R["pool.move.dry"]!({ ...good, steps: [...good.steps, { step: "relay", chain: "solana" }] }), false, "relay is no step");
  assert.equal(R["pool.move.dry"]!({ ...good, steps: [{ step: "vault_out", chain: "ethereum" }] }), false, "an unknown chain");
  assert.equal(R["pool.move.dry"]!({ out: "0.31", fee: "0.05" }), false, "steps are required");
  assert.equal(R["pool.move.dry"]!({ ...good, route: "x" }), false, "an extra field");
});

const MOVE_OP = { id: "m1", kind: "move", from: "near", to: "solana", stage: "in_transit", txs: [{ chain: "near", hash: "h" }], amount: "25.5", out: "0.31", created_ms: 1 };

test("a move op in state.ops is read; one with a stage outside MoveStage, or from === to, is dropped and the rest kept", () => {
  const good = { ...STATE, ops: [MOVE_OP] };
  assert.equal(signpageReadableOps(good), good);
  assert.equal(R.state!(good), true);
  for (const bad of [{ ...MOVE_OP, stage: "teleported" }, { ...MOVE_OP, to: "near" }, { ...MOVE_OP, out: "0.0000000001" }, { ...MOVE_OP, amount: "1.0000001" }, { ...MOVE_OP, wallet: "x" }]) {
    const s = signpageReadableOps({ ...STATE, ops: [bad, MOVE_OP] }) as { ops: unknown[] };
    assert.deepEqual(s.ops, [MOVE_OP], JSON.stringify(bad));
  }
});

test("the buy's route event { move: 'cash', op } is read; an op that is not a string is refused", () => {
  assert.equal(signpageProgressRouteSchema({ v: 1, type: "progress", id: "r1", move: "cash", op: "cash/solana/1" }), true);
  assert.equal(signpageProgressRouteSchema({ v: 1, type: "progress", id: "r1", move: "cash", op: 1 }), false);
});
