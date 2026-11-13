// node --test test/buy-any-amount-legs.test.ts (from packages/signpage): card buy-any-amount-on-every-chain on Solana.
// One tap spends every ready note: past every single W's set it splits into legs (src/pool-buy.ts solanaLegsPlan), each
// a pool.buy of its own on its own W, side by side (runPoolBuyLegs). Max (../../wallet/src/pool/balances.ts tap_max) is
// what the legs spend: the same partition, each note in one leg only. Planted notes and proofs only: no seed, no key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_POOL_JITO_TIP } from "../../kit/src/checks/solana/checks.ts";
import { SOLANA_POOL_WORST_BUY_VENUE, solanaPoolFee, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import type { BuyRoute, TxRef } from "../../kit/src/signpage/messages.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { poolBalances, solanaBalancePool, solanaTapSpendOf } from "../../wallet/src/pool/balances.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { SOL_TIP_CAP } from "../../wallet/src/pool/solana.ts";
import { legsStage, runPoolBuyLegs, solanaLegsPlan, sumUnits, type PoolBuyAnswer, type PoolBuyKindHost, type PoolBuyLeg, type PoolBuyScope } from "../src/pool-buy.ts";
import { readWaits } from "../src/read-waits.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const RENT: SolanaRent = { lamportsPerByte: 5_080n, factor: 1n };
const FEE = solanaPoolFee(RENT);
const SCOPE = 11n;
const POOL = solanaBalancePool("sol:p", SCOPE);
const tipOf = (): bigint => SOLANA_POOL_JITO_TIP;
const spendOf = solanaTapSpendOf(RENT, SOLANA_POOL_WORST_BUY_VENUE, tipOf);

let i = 0;
const note = (value: bigint): NoteRecord => {
  i++;
  return { id: `n${i}`, ref: { kind: "deposit", s: SCOPE, i }, scope: SCOPE, precommitment: BigInt(i), state: "HELD", attempt: `a${i}`, deadlineMs: 1n, leaf: { value, label: BigInt(100 + i), commitment: BigInt(i), leafIndex: BigInt(i) } };
};
/** x's ready proof of `chunk` bound to by's own W: own when by is x (its label and j are W's l and j). */
const proof = (x: NoteRecord, by: NoteRecord, chunk: bigint, attempt = x.attempt!) => ({
  noteId: x.id, attempt, poolId: POOL.id, chunk,
  wallet: { l: by.leaf!.label, j: jOf(by.ref), address: `W-${by.id}` },
  binding: { feeCap: FEE, request: { tipCap: SOL_TIP_CAP } },
  ...(x === by ? { own: true as const } : {}),
});
const lamportsOf = (s: string): bigint => {
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 1_000_000_000n + BigInt(f.padEnd(9, "0"));
};

test("solanaLegsPlan: Max is what the legs spend, the same partition as the balance's tap_max: the primary's W with its tier 2 piece and its carried change, then each other note on its own W; one lamport more is no plan", () => {
  // the primary 0.05 (its own W), a 0.012 sale return bound to it as a tier 2 piece (0.005, its 0.007 change carried)
  // and by its own tier 1 proof, and a 0.02 note past the primary's set by its tier 1 proof
  const P = note(50_000_000n);
  const R = { ...note(12_000_000n), second: { attempt: "r2", deadlineMs: 2n, context: "2" } };
  const Z = note(20_000_000n);
  const notes = [P, R, Z];
  const list = [proof(P, P, 50_000_000n), proof(R, R, 5_000_000n), proof(Z, Z, 20_000_000n), proof(R, P, 5_000_000n, "r2")];
  const max = lamportsOf(poolBalances(notes, [solanaBalancePool(POOL.id, SCOPE, spendOf)], list)[0]!.tap_max!);
  const valueOf = (id: string) => notes.find((n) => n.id === id)?.leaf?.value;
  const plan = solanaLegsPlan(list, valueOf, spendOf, max);
  assert.ok(plan !== null, "Max is a plan");
  // the primary's W holds P and R (R's piece and its change), Z its own: never R in two legs
  assert.deepEqual(plan.map((l) => [l.address, [...l.ids]]), [[`W-${P.id}`, [P.id, R.id]], [`W-${Z.id}`, [Z.id]]]);
  assert.equal(plan.reduce((a, l) => a + l.amount, 0n), max, "the legs spend all of Max");
  // each leg's amount is that W set's own most: P with R's piece and change, and Z alone
  const piece = (chunk: bigint) => ({ chunk, feeCap: FEE, tipCap: SOL_TIP_CAP });
  assert.equal(plan[0]!.amount, spendOf([piece(5_000_000n), piece(7_000_000n), piece(50_000_000n)]));
  assert.equal(plan[1]!.amount, spendOf([piece(20_000_000n)]));
  assert.equal(solanaLegsPlan(list, valueOf, spendOf, max + 1n), null, "one lamport past Max: no plan");
  // an amount the largest leg pays alone is one leg; past it, the largest leg whole and the rest from the next
  const small = solanaLegsPlan(list, valueOf, spendOf, 1_000n)!;
  assert.deepEqual(small.map((l) => [l.address, l.amount]), [[`W-${P.id}`, 1_000n]]);
  const past = solanaLegsPlan(list, valueOf, spendOf, plan[0]!.amount + 1n)!;
  assert.deepEqual(past.map((l) => l.amount), [plan[0]!.amount, 1n]);
  // with one piece a tap (a host with no set take): every note its own leg, its own W
  const ones = solanaLegsPlan(list, valueOf, spendOf, 1_000n, 1)!;
  assert.deepEqual(ones.map((l) => [...l.ids]), [[P.id]]);
  // R's 0.005 piece alone funds no W's accounts on the worst venue: no leg of its own, so Max is P's and Z's
  assert.equal(spendOf([piece(5_000_000n)]), 0n);
  const all1 = solanaLegsPlan(list, valueOf, spendOf, spendOf([piece(50_000_000n)]) + spendOf([piece(20_000_000n)]), 1);
  assert.deepEqual(all1?.map((l) => [...l.ids]), [[P.id], [Z.id]]);
  assert.equal(solanaLegsPlan(list, valueOf, spendOf, 0n), null, "no amount: no plan");
});

const ASK: PoolAsk = { kind: "pool.buy", chain: "solana", token: "Mint1111111111111111111111111111111111111111", amount: 30n, slippageBps: 300, decimals: 6 };
const LEGS: PoolBuyLeg[] = [
  { address: "W-a", ids: ["a", "a2"], amount: 20n },
  { address: "W-b", ids: ["b"], amount: 10n },
];
const sigOf = (k: number) => `${"S".repeat(63)}${k}`;
type Run = NonNullable<Parameters<typeof runPoolBuyLegs>[5]>;
/** A fake leg run: each leg tells its W, its venue, its tx and its out, and answers `ends[k]`. */
const fake = (ends: readonly (PoolBuyAnswer | "throw")[], outs: readonly (string | null)[], seen: { amount: bigint; scope: PoolBuyScope }[]): Run =>
  (async (h, ask, _waits, scope) => {
    const k = LEGS.findIndex((l) => l.address === scope.leg?.address);
    seen.push({ amount: ask.amount, scope });
    const end = ends[k]!;
    if (end === "throw") throw new Error("leg threw");
    if ("stage" in end) {
      h.route?.({ wallet: `W${k}` });
      h.route?.({ venue: "pump-curve", pool: `C${k}` });
      h.route?.({ tx: sigOf(k) });
      await h.sent?.(sigOf(k));
      if (outs[k] !== null) h.route?.({ out: outs[k]! });
    }
    return end;
  }) as Run;
const hostsOf = (released: number[]): PoolBuyKindHost[] => LEGS.map((_, k) => ({ release: () => void released.push(k) }) as unknown as PoolBuyKindHost);

test("runPoolBuyLegs: each leg its own run at its own amount, in its own W's scope with every other leg's notes out of it; sent once every leg read back; the first leg's route, the out summed; filled only when every leg filled", async () => {
  const seen: { amount: bigint; scope: PoolBuyScope }[] = [];
  const sent: TxRef[][] = [];
  const route: BuyRoute[] = [];
  const released: number[] = [];
  const filled = (k: number): PoolBuyAnswer => ({ stage: "filled", txs: [{ chain: "solana", hash: sigOf(k) }] });
  const got = await runPoolBuyLegs(hostsOf(released), LEGS, ASK, readWaits(), { sent: (t) => void sent.push(t), route: (x) => void route.push(x) }, fake([filled(0), filled(1)], ["1.5", "0.25"], seen));
  assert.deepEqual(seen.map((x) => x.amount).sort(), [10n, 20n]);
  const a = seen.find((x) => x.scope.leg?.address === "W-a")!;
  const b = seen.find((x) => x.scope.leg?.address === "W-b")!;
  assert.deepEqual([...a.scope.leg!.not], ["b"]);
  assert.deepEqual([...b.scope.leg!.not], ["a", "a2"]);
  assert.equal(seen.some((x) => x.scope.split), false, "a leg never splits again");
  assert.deepEqual(sent, [[{ chain: "solana", hash: sigOf(0) }, { chain: "solana", hash: sigOf(1) }]], "sent once, every leg's, in leg order");
  assert.deepEqual(route, [{ wallet: "W0" }, { venue: "pump-curve", pool: "C0" }, { tx: sigOf(0) }, { out: "1.75" }], "the first leg's W, venue and tx; the out once, summed");
  assert.deepEqual(released.sort(), [0, 1], "each leg's hosts given back at its own read-back");
  assert.deepEqual(got.answer, { stage: "filled", txs: [{ chain: "solana", hash: sigOf(0) }, { chain: "solana", hash: sigOf(1) }] });
});

test("runPoolBuyLegs: a leg that fails never makes the tap filled: part_filled with the filled leg's txs and its out; no early sent; every leg an error is the first leg's error", async () => {
  for (const bad of [{ error: "not_funded" } as PoolBuyAnswer, "throw" as const, { stage: "not_landed", txs: [] } as PoolBuyAnswer]) {
    const sent: TxRef[][] = [];
    const route: BuyRoute[] = [];
    const filled: PoolBuyAnswer = { stage: "filled", txs: [{ chain: "solana", hash: sigOf(0) }] };
    const got = await runPoolBuyLegs(hostsOf([]), LEGS, ASK, readWaits(), { sent: (t) => void sent.push(t), route: (x) => void route.push(x) }, fake([filled, bad], ["2", null], []));
    assert.equal("stage" in got.answer && got.answer.stage, "part_filled", JSON.stringify(bad));
    assert.deepEqual("stage" in got.answer && got.answer.txs[0], { chain: "solana", hash: sigOf(0) });
    if (bad !== "throw" && "error" in bad) assert.deepEqual(sent, [], "no early sent while a leg never sent");
    assert.deepEqual(route.filter((x) => "out" in x), [{ out: "2" }], "the filled leg's out, told at the end");
  }
  const got = await runPoolBuyLegs(hostsOf([]), LEGS, ASK, readWaits(), { sent: () => assert.fail("nothing sent"), route: () => {} }, fake([{ error: "quote_check_failed" }, { error: "not_funded" }], [null, null], []));
  assert.deepEqual(got.answer, { error: "quote_check_failed" });
  // hosts and legs that do not match: nothing runs
  assert.deepEqual((await runPoolBuyLegs(hostsOf([]).slice(0, 1), LEGS, ASK, readWaits(), { sent: () => {}, route: () => {} }, () => assert.fail("no run"))).answer, { error: "failed" });
});

test("legsStage and sumUnits: the tap's stage from its legs', and outs summed exactly", () => {
  assert.equal(legsStage(["filled", "filled"]), "filled");
  assert.equal(legsStage(["filled", null]), "part_filled");
  assert.equal(legsStage(["filled", "sent"]), "sent");
  assert.equal(legsStage(["filled", "not_landed"]), "part_filled");
  assert.equal(legsStage(["refused", "refused"]), "refused");
  assert.equal(legsStage(["refused", "not_landed"]), "not_landed");
  assert.equal(legsStage(["refused", null]), "refused");
  assert.equal(legsStage([null, null]), null);
  assert.equal(sumUnits(["1.5", "0.25", "7"]), "8.75");
  assert.equal(sumUnits(["0.000001", "0.999999"]), "1");
  assert.equal(sumUnits(["1e3"]), null);
});
