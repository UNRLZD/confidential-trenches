// What an op carries beside its stage (card kit-portfolio-reads, kit 1.9): created_ms, chain, token, units and
// amount_usd, additive and optional on every op kind, so an app draws Activity from the kit alone. Absent is still
// valid (a page of an earlier release, a record from before them); a value of the wrong type is refused; a deposit's
// amount_usd keeps its own rule (on "done" only), and a pool deposit's chain stays required and one of its pools'.
//   node --test test/op-detail.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Operation, SignpageState } from "@blindfill/kit";
import { SIGNPAGE_RESULT_SCHEMAS, signpageReadableOps } from "../src/signpage/schema.ts";

const BASE: SignpageState = {
  release: "sp-1",
  api: 1,
  signed_in: true,
  code_saved: true,
  vault_balance: "0",
  wallets: [],
  positions: [],
  orders: [],
  held: [],
  ops: [],
};
const ok = (op: unknown): boolean => SIGNPAGE_RESULT_SCHEMAS.state({ ...BASE, ops: [op] });
const DETAIL = { created_ms: 1_793_586_677_909, chain: "solana", token: "Mint1111", units: "1234.567891", amount_usd: "25.5" } as const;
const OPS: Operation[] = [
  { id: "d1", kind: "deposit", stage: "done", txs: [], amount_usd: "390.46" },
  { id: "p1", kind: "pool_deposit", chain: "solana", stage: "in_pool", txs: [] },
  { id: "w1", kind: "withdraw", stage: "sent", txs: [] },
  { id: "b1", kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: "Sig1" }] },
  { id: "s1", kind: "sell", stage: "sent", txs: [], code: "down" },
  { id: "h1", kind: "hop", stage: "arrived", txs: [] },
  { id: "r1", kind: "return", stage: "done", txs: [] },
  { id: "x1", kind: "restore", stage: "done", txs: [] },
];

test("every op kind with no detail is still a valid state", () => {
  for (const op of OPS) assert.equal(ok(op), true, op.kind);
});

test("every op kind carries each detail, and all of them together", () => {
  for (const op of OPS) {
    for (const [k, v] of Object.entries(DETAIL)) {
      // a pool deposit's chain is its own, a pool's; a deposit's amount_usd is its done fact
      if (op.kind === "pool_deposit" && k === "chain") continue;
      assert.equal(ok({ ...op, [k]: v }), true, `${op.kind} ${k}`);
    }
    const all: Record<string, unknown> = { ...op, ...DETAIL };
    if (op.kind === "pool_deposit") all.chain = "base";
    assert.equal(ok(all), true, `${op.kind} all`);
  }
  const typed: Operation = { id: "s2", kind: "sell", stage: "filled", txs: [], created_ms: 1, chain: "base", token: "0xabc", units: "1.5" };
  assert.equal(ok(typed), true);
});

test("a detail of the wrong type is refused, on every kind", () => {
  const bad: Record<keyof typeof DETAIL, unknown[]> = {
    created_ms: ["1793586677909", -1, 1.5, Number.NaN, Infinity, 2 ** 53, null, true],
    chain: ["ethereum", "", 1, null],
    token: ["", "x".repeat(513), 1, null, ["a"]],
    units: ["1e3", "-1", "1.", ".5", "", 1.5, null],
    amount_usd: ["$25", "-25", "1e2", "", 25, null],
  };
  for (const op of OPS)
    for (const [k, vs] of Object.entries(bad))
      for (const v of vs) assert.equal(ok({ ...op, [k]: v }), false, `${op.kind} ${k} ${JSON.stringify(v)}`);
});

test("a deposit's amount_usd stays on done only; a pool deposit's chain stays one of its pools'", () => {
  assert.equal(ok({ id: "d2", kind: "deposit", stage: "waiting", txs: [], created_ms: 5, amount_usd: "1" }), false);
  assert.equal(ok({ id: "p2", kind: "pool_deposit", chain: "near", stage: "waiting", txs: [], created_ms: 5 }), false);
  assert.equal(ok({ id: "p3", kind: "pool_deposit", stage: "waiting", txs: [], created_ms: 5 }), false);
});

test("a client drops only the op whose detail it cannot read, never the state", () => {
  const out = signpageReadableOps({ ...BASE, ops: [{ ...OPS[3], created_ms: "soon" }, { ...OPS[4], ...DETAIL }] }) as SignpageState;
  assert.deepEqual(out.ops.map((o) => o.id), ["s1"]);
});
