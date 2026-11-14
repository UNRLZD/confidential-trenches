// Card portfolio-moves-money-between-chains: Private balance moves money between chains. The route each move draws
// (lite paper v2 §3), the step a running move is at, each row's dollars and the total, the amount against what the row
// can move, Max's exact text, the op read from state.ops, and the gate: no Move until the kit names the signing page's
// pool.move and pool.move.dry.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "@blindfill/kit";
import { pools } from "../src/screens/portfolio/model.ts";
import { checkAmount, exact, moveOp, moveRunning, moveShips, nodesOf, poolTotal, reach, readDry, readLimits, routeSteps, rowCents, stepStates } from "../src/screens/portfolio/move.ts";
import { DRAFTS, WORDS } from "../src/screens/portfolio/words.ts";

const NOW = Date.parse("2026-11-13T20:00:00Z");
const PX = (usd: number, ageS = 5) => ({ price: String(usd * 1e8), expo: -8, published_s: Math.floor(NOW / 1000) - ageS, read_ms: NOW - 1000 });
const STATE: SignpageState = {
  release: "signpage-v1",
  api: 1,
  signed_in: true,
  code_saved: true,
  vault_balance: "12.345678",
  wallets: [],
  positions: [],
  orders: [],
  held: [],
  ops: [],
  pools: [
    { chain: "solana", asset: "SOL", balance: "0.021049", price: PX(150) },
    { chain: "base", asset: "ETH", balance: "0", price: PX(3000) },
    { chain: "robinhood", asset: "ETH", balance: "0.5" },
  ],
};

// pool.move.dry's steps as the one-balance card fixed them (kit 1.15)
const X_Y = [["pool_out", "solana"], ["intents", "near"], ["vault_in", "near"], ["vault_out", "near"], ["intents", "base"], ["pool_in", "base"]];
const pairs = (s: { step: string; chain: string }[] | null) => s?.map((x) => [x.step, x.chain]);

test("the route: Cash to a pool one NEAR Intents leg; a pool to Cash ends in the vault; pool to pool stops in the NEAR vault", () => {
  assert.deepEqual(pairs(routeSteps("near", "solana")), [["vault_out", "near"], ["intents", "solana"], ["pool_in", "solana"]]);
  assert.deepEqual(pairs(routeSteps("base", "near")), [["pool_out", "base"], ["intents", "near"], ["vault_in", "near"]]);
  assert.deepEqual(pairs(routeSteps("solana", "base")), X_Y);
  assert.equal(routeSteps("base", "base"), null);
  // the flow draws the vault's in and out as one stop: pool, NEAR Intents, NEAR vault, NEAR Intents, pool
  assert.deepEqual(nodesOf(routeSteps("solana", "base")!).map((n) => `${n.kind}:${n.chain}`), ["pool:solana", "intents:near", "vault:near", "intents:base", "pool:base"]);
  assert.deepEqual(nodesOf(routeSteps("near", "robinhood")!).map((n) => `${n.kind}:${n.chain}`), ["vault:near", "intents:robinhood", "pool:robinhood"]);
});

test("the steps follow the op's stage, never back: the second in_transit is the leg after the vault", () => {
  const five = nodesOf(routeSteps("solana", "base")!);
  const three = nodesOf(routeSteps("near", "solana")!);
  let r = -1;
  const go = (n: typeof five, st: Parameters<typeof reach>[1]) => ((r = reach(n, st, r)), stepStates(n, st, r));
  assert.deepEqual(stepStates(five, null, -1), ["idle", "idle", "idle", "idle", "idle"]);
  assert.deepEqual(go(five, "leaving"), ["active", "idle", "idle", "idle", "idle"]);
  assert.deepEqual(go(five, "in_transit"), ["done", "active", "idle", "idle", "idle"]);
  assert.deepEqual(go(five, "in_vault"), ["done", "done", "active", "idle", "idle"]);
  assert.deepEqual(go(five, "leaving"), ["done", "done", "active", "idle", "idle"]);
  assert.deepEqual(go(five, "in_transit"), ["done", "done", "done", "active", "idle"]);
  assert.deepEqual(go(five, "into_pool"), ["done", "done", "done", "done", "active"]);
  assert.deepEqual(go(five, "done"), ["done", "done", "done", "done", "done"]);
  r = -1;
  go(five, "leaving");
  go(five, "in_transit");
  assert.deepEqual(go(five, "failed"), ["done", "error", "idle", "idle", "idle"]);
  r = -1;
  assert.deepEqual(go(three, "in_transit"), ["done", "active", "idle"]);
  assert.deepEqual(go(three, "into_pool"), ["done", "done", "active"]);
  // a pool to Cash arrives in_vault: its last node
  r = -1;
  assert.deepEqual(go(nodesOf(routeSteps("base", "near")!), "in_vault"), ["done", "done", "active"]);
  assert.equal(moveRunning(null), false);
});

test("pool.move.dry's answer is read in kit 1.15's shape only", () => {
  const steps = X_Y.map(([step, chain]) => ({ step, chain }));
  assert.deepEqual(readDry({ out: "0.0042", fee: "0.0003", steps }), { out: "0.0042", fee: "0.0003", steps });
  assert.equal(readDry({ out: "0.0042", fee: "0.0003", steps, time_estimate_s: 75 })?.time_estimate_s, 75);
  assert.equal(readDry({ out: "0.0042", fee_usd: "1", steps }), null);
  assert.equal(readDry({ out: "-1", fee: "0", steps }), null);
  assert.equal(readDry({ out: "1", fee: "0", steps: [{ step: "teleport", chain: "near" }, ...steps] }), null);
  assert.equal(readDry(null), null);
});

test("card move-sends-what-it-shows: the page's max on a priced dry, and the answer for an amount the move cannot send (kit 1.16)", () => {
  const steps = X_Y.map(([step, chain]) => ({ step, chain }));
  assert.deepEqual(readDry({ out: "0.0042", fee: "0.0003", steps, max: "2.4979" }), { out: "0.0042", fee: "0.0003", steps, max: "2.4979" });
  assert.equal(readDry({ out: "0.0042", fee: "0.0003", steps, max: "-1" }), null, "max is a decimal");
  assert.equal(readDry({ max: "2.4979", steps }), null, "no out: not a priced answer");
  assert.deepEqual(readLimits({ max: "2.4979", steps }), { max: "2.4979", steps });
  assert.deepEqual(readLimits({ max: "2.4979", steps, min: "0.0545" }), { max: "2.4979", steps, min: "0.0545" });
  assert.deepEqual(readLimits({ max: "2.4979", steps, below: "0.25", above: "0.35" }), { max: "2.4979", steps, below: "0.25", above: "0.35" });
  assert.equal(readLimits({ max: "2.4979", steps, out: "1" }), null, "an answer with out is priced");
  assert.equal(readLimits({ max: "2.4979", steps, min: "x" }), null);
  assert.equal(readLimits({ steps, min: "0.0545" }), null, "max is required");
  assert.equal(readLimits(null), null);
});

test("each row's dollars at the page's own fresh price; none made up; the total says when a row had none", () => {
  const p = pools(STATE);
  const c = p.rows.map((r) => rowCents(STATE, r, NOW));
  // NEAR $12.34 (rounded down), Solana 0.021049 x $150 = $3.15, Base 0 = $0, Robinhood unpriced = null
  assert.deepEqual(c, [1234n, 315n, 0n, null]);
  assert.deepEqual(poolTotal(STATE, p.rows, NOW), { cents: 1549n, partial: true });
  // a stale price is none
  const stale = { ...STATE, pools: [{ chain: "solana" as const, asset: "SOL" as const, balance: "1", price: PX(150, 3600) }] };
  assert.equal(rowCents(stale, pools(stale).rows[1]!, NOW), null);
});

test("the amount: none, bad, over what the pool's notes hold, or ok; Max is the exact balance", () => {
  const sol = pools(STATE).rows[1]!;
  assert.deepEqual(checkAmount("", sol), { kind: "none" });
  assert.deepEqual(checkAmount("abc", sol), { kind: "bad" });
  assert.deepEqual(checkAmount("0", sol), { kind: "bad" });
  assert.deepEqual(checkAmount("0.0000000001", sol), { kind: "bad" });
  assert.deepEqual(checkAmount("0.01", sol), { kind: "ok", units: 10_000_000n });
  assert.deepEqual(checkAmount("0.", sol), { kind: "bad" });
  assert.deepEqual(checkAmount("1.", sol), { kind: "over", units: 1_000_000_000n });
  assert.deepEqual(checkAmount("0.03", sol), { kind: "over", units: 30_000_000n });
  assert.equal(exact(sol.pooled, sol.decimals), "0.021049");
  assert.equal(exact(12_000_000n, 6), "12");
  assert.deepEqual(checkAmount(exact(sol.pooled, sol.decimals), sol), { kind: "ok", units: sol.pooled });
});

test("the move's op is read from state.ops by its id, only in the shape recorded", () => {
  const op = { id: "m1", kind: "move", from: "solana", to: "base", amount: "0.01", stage: "in_vault", txs: [] };
  const s = (o: unknown) => ({ ...STATE, ops: [o] }) as unknown as SignpageState;
  assert.equal(moveOp(s(op), "m1")?.stage, "in_vault");
  assert.equal(moveOp(s({ ...op, amount: undefined }), "m1")?.stage, "in_vault");
  assert.equal(moveRunning(moveOp(s(op), "m1")), true);
  assert.equal(moveOp(s(op), "m2"), null);
  assert.equal(moveOp(s({ ...op, stage: "teleporting" }), "m1"), null);
  assert.equal(moveOp(s({ ...op, to: "mars" }), "m1"), null);
  assert.equal(moveRunning(moveOp(s({ ...op, stage: "done", out: "0.0099" }), "m1")), false);
});

test("no Move until the kit names both of the signing page's kinds", () => {
  assert.equal(moveShips(() => false), false);
  assert.equal(moveShips((k) => k === "pool.move"), false);
  assert.equal(moveShips((k) => k === "pool.move" || k === "pool.move.dry"), true);
});

test("the move's words: Move is the owner's own; From is the one new label, a draft", () => {
  assert.equal(WORDS.move.text, "Move");
  assert.equal(WORDS.move.draft, false);
  assert.equal(WORDS.from.text, "From");
  assert.ok(DRAFTS.includes("from"));
});
