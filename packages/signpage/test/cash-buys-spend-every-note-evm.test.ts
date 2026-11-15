// Card cash-buys-spend-every-note-evm: a Base or Robinhood buy from Cash, its Fee and its Max were sized against Cash's
// largest note alone (cash-to-pool.ts cashMover.start's `usdc + fee > cash`, main.ts's moved and with_cash), so Cash
// split over notes each under the move refused every buy from it. A withdraw proof spends one note, so the move is
// planned over every note (planCashMove under evmMoveModel: whole least rungs a part, each part's quote held to the
// pool's floor and 1Click's least), every part quoted before any note leaves Cash; the tap is sized on the rungs those
// parts land (each part's one-time address deposits its own split, each note its own relay fee), and 1Click's least
// into Base's ETH is read past its "Failed to get quote" at one unit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cashMover, evmCashPlan, evmMoveCostOf, evmMoveOf, planCashMove, evmMoveModel, readOneClickLeast, type CashMoverDeps, type CashNote, type CashQuote } from "../src/cash-to-pool.ts";
import { evmMostWithCash, evmMoveShort, evmTapBuys } from "../src/pool-buy-evm.ts";
import { planEvmBuy, type PoolAsk } from "../src/rules/pool.ts";
import { EVM_MOVE_FEE_ROOM } from "../src/pool-buy-evm.ts";

const PRICE = { price: "300000000000", expo: -8 }; // ETH at 3,000 USD
const RUNG = 1_000_000_000_000_000n; // EVM_LADDER.min, 0.001 ETH
const GAS = 20_000_000_000_000n; // one deposit's gas from the one-time address
const FLOOR = RUNG + GAS; // pool.address's floor: the least rung and one deposit's gas
const FEE = 50_000n; // the vault withdraw's relay fee, 0.05 USDC
const LEAST = 18_533n; // 1Click's least into Robinhood's ETH, read 15 Nov 13:0xZ
const ADDRESS = "b".repeat(64);
// Cash split over notes each under the move: 0.003 ETH of rungs asks 9.39 USDC (evmMoveOf), more than any one note
const SPLIT: CashNote[] = [
  { id: "n1", value: 5_000_000n },
  { id: "n2", value: 4_000_000n },
  { id: "n3", value: 4_000_000n },
  { id: "n4", value: 4_000_000n },
];
const SHORT = 3n * RUNG;

function mover(notes: readonly CashNote[], o: { quote?: (usdc: bigint, n: number) => CashQuote | { error: string } } = {}) {
  const quoted: bigint[] = [];
  const paid: { amount: bigint; note: string | undefined; fee: bigint; at: number }[] = [];
  let n = 0;
  const d: CashMoverDeps = {
    price: () => PRICE,
    floor: async () => FLOOR,
    least: async () => LEAST,
    rails: ["1click"],
    // a quote that brings what the USDC buys at 3,000 USD less 1%
    quote: async (_c, usdc) => (quoted.push(usdc), o.quote?.(usdc, ++n) ?? { address: ADDRESS, amountIn: usdc, minOut: (usdc * 10n ** 18n * 100n) / (3_000_000_000n * 101n) }),
    fee: async () => FEE,
    cash: async () => notes.reduce((m, x) => (x.value > m ? x.value : m), 0n),
    notes: async () => notes,
    handoff: async (w, fee, note) => (paid.push({ amount: w.amount, note, fee, at: quoted.length }), { kind: "arrived" }),
    landed: async () => false,
    now: () => 2_000,
  };
  return { m: cashMover(d), quoted, paid };
}

test("a Base or Robinhood buy's move from Cash split over notes each under it is planned over every note: one withdrawal a note, every quote before any note leaves", async () => {
  for (const chain of ["base", "robinhood"] as const) {
    const t = mover(SPLIT);
    assert.ok(evmMoveOf(SHORT, GAS, PRICE, chain)!.usdc + FEE > 5_000_000n, "no one note pays the move");
    assert.equal(await t.m.need(chain, SHORT), `cash/${chain}/2000`, "the move's op is its first part's");
    assert.ok(t.paid.length === 3 && t.paid.every((p) => p.at === t.quoted.length), "no hand-off before the last quote");
    assert.deepEqual(t.paid.map((p) => p.note), ["n1", "n4", "n3"], "largest first, each its own note; n2 never asked");
    assert.deepEqual(t.paid.slice(0, 2).map((p) => p.amount), [4_950_000n, 3_950_000n], "a note before the last is moved whole, less its fee");
    assert.ok(t.paid.every((p) => p.fee === FEE));
    const parts = planCashMove(SPLIT, FEE, SHORT, evmMoveModel(PRICE, FLOOR, LEAST, chain))!;
    assert.equal(parts.reduce((s, p) => s + p.units, 0n), SHORT, "the parts land the whole shortfall, in rungs");
    assert.ok(parts.every((p) => p.least >= FLOOR && p.usdc >= LEAST && p.units % RUNG === 0n), "every part clears the pool's floor and 1Click's least, in whole rungs");
  }
});

test("a part's quote refused on Base: no note leaves Cash, the move is refused", async () => {
  const t = mover(SPLIT, { quote: (usdc, n) => (n === 3 ? { error: "quote_check_failed" } : { address: ADDRESS, amountIn: usdc, minOut: (usdc * 10n ** 18n) / 3_100_000_000n }) });
  assert.equal(await t.m.need("base", SHORT), null);
  assert.deepEqual(t.paid, [], "nothing withdrawn");
  // a quote under a part's least (its rungs and their gas) is refused the same way
  const s = mover(SPLIT, { quote: (usdc) => ({ address: ADDRESS, amountIn: usdc, minOut: RUNG }) });
  assert.equal(await s.m.need("base", SHORT), null);
  assert.deepEqual(s.paid, []);
});

test("one note that pays the move alone still pays it alone, priced as before (one quote, one withdrawal, evmMoveCostOf)", async () => {
  const big = { id: "big", value: 20_000_000n };
  const t = mover([...SPLIT, big]);
  await t.m.need("base", SHORT);
  assert.deepEqual(t.paid.map((p) => [p.note, p.amount]), [["big", evmMoveOf(SHORT, GAS, PRICE, "base")!.usdc]]);
  assert.equal(evmCashPlan([big], FEE, PRICE, FLOOR, LEAST, "base").cost(SHORT), evmMoveCostOf(SHORT, GAS, FEE, PRICE, "base"), "a one-part move costs what it did");
  // the parts' Fee: each part's withdraw fee and margin, and every landed note's gas
  const split = evmCashPlan(SPLIT, FEE, PRICE, FLOOR, LEAST, "base");
  assert.ok(split.cost(SHORT)! > evmMoveCostOf(SHORT, GAS, FEE, PRICE, "base")!, "three withdrawals cost more than one");
  assert.equal(split.cost(10n * RUNG), null, "Cash cannot make it: no Fee");
});

// the tap's own plan over the moved pieces, as evmMoveShort reads it: each a piece at twice the epoch's relay fee
const carries = (amount: bigint, rungs: readonly bigint[], fee: bigint): boolean => {
  const at = fee * EVM_MOVE_FEE_ROOM;
  try {
    return planEvmBuy({ kind: "pool.buy", chain: "base", token: null, amount, slippageBps: 0, decimals: 0 } as unknown as PoolAsk, rungs.filter((c) => at < c).map((chunk, i) => ({ noteId: `m${i}`, chunk, fee: at })), at).amount === amount;
  } catch {
    return false;
  }
};

test("the tap is sized on the rungs the parts land: one move's split under-sizes a move of several parts, each its own note and relay fee", () => {
  const fee = 10_000_000_000_000n; // the pool's epoch relay fee, 0.00001 ETH
  const plan = evmCashPlan(SPLIT, FEE, PRICE, FLOOR, LEAST, "base");
  const amount = 2_960_000_000_000_000n; // 0.00296 ETH asked, nothing ready in the pool
  const one = evmMoveShort([], amount, fee)!;
  assert.equal(one.short, SHORT, "one move's split: 0.002 + 0.001, two notes");
  assert.deepEqual(plan.rungs(SHORT), [RUNG, RUNG, RUNG], "Cash's parts land three notes of 0.001");
  assert.equal(carries(amount, plan.rungs(SHORT)!, fee), false, "those three, a fee each, do not carry the ask");
  const sized = evmMoveShort([], amount, fee, plan.rungs)!;
  assert.equal(sized.short, 4n * RUNG);
  assert.equal(carries(amount, plan.rungs(sized.short)!, fee), true, "sized on the parts' rungs, the tap carries the ask");
  assert.equal(evmMoveShort([], 100n * RUNG, fee, plan.rungs), null, "past what Cash can make: no move");
});

test("Max with Cash counts every note: the most one tap buys after the move, more than the largest note alone, each amount up to it carried", () => {
  const fee = 10_000_000_000_000n;
  const plan = evmCashPlan(SPLIT, FEE, PRICE, FLOOR, LEAST, "robinhood");
  const pays = (s: bigint) => plan.parts(s) !== null;
  const most = evmMostWithCash([], fee, pays, plan.top, plan.rungs);
  assert.ok(evmTapBuys([], most, fee, pays, plan.rungs), "the most is carried");
  assert.ok(!evmTapBuys([], most + 1_000_000_000_000n, fee, pays, plan.rungs), "one step more is not");
  assert.ok(most > 3n * RUNG && most < 4n * RUNG, String(most));
  const largest = evmCashPlan([SPLIT[0]!], FEE, PRICE, FLOOR, LEAST, "robinhood");
  const alone = evmMostWithCash([], fee, (s) => largest.parts(s) !== null, largest.top, largest.rungs);
  assert.ok(alone < RUNG && alone < most, `${alone} < ${most}`);
});

test("1Click's least into Base's ETH is read past its 'Failed to get quote' at one unit, never kept in the code", async () => {
  const asked: string[] = [];
  // recorded 15 Nov 13:30Z on the helper's 1Click proxy: into Base's ETH, one unit, then ten
  const base = (async (_u: unknown, init: RequestInit) => {
    const amount = String(JSON.parse(String(init.body)).amount);
    asked.push(amount);
    return amount === "1" ? new Response(JSON.stringify({ message: "Failed to get quote" }), { status: 400 }) : new Response(JSON.stringify({ message: "Amount is too low for bridge, try at least 1042" }), { status: 400 });
  }) as unknown as typeof fetch;
  assert.equal(await readOneClickLeast("base", base, 0), 1_042n);
  assert.deepEqual(asked, ["1", "10"]);
  // an amount it quotes is one it takes
  const quotes = (async (_u: unknown, init: RequestInit) => (String(JSON.parse(String(init.body)).amount) === "100" ? new Response("{\"quote\":{}}", { status: 201 }) : new Response(JSON.stringify({ message: "Failed to get quote" }), { status: 400 }))) as unknown as typeof fetch;
  assert.equal(await readOneClickLeast("robinhood", quotes, 0), 100n);
  // any other answer is no read, and is not asked again
  const other: string[] = [];
  const refuses = (async (_u: unknown, init: RequestInit) => (other.push(String(JSON.parse(String(init.body)).amount)), new Response(JSON.stringify({ message: "recipient is not valid" }), { status: 400 }))) as unknown as typeof fetch;
  assert.equal(await readOneClickLeast("base", refuses, 0), null);
  assert.deepEqual(other, ["1"]);
  // never past one USDC
  const always: string[] = [];
  const failed = (async (_u: unknown, init: RequestInit) => (always.push(String(JSON.parse(String(init.body)).amount)), new Response(JSON.stringify({ message: "Failed to get quote" }), { status: 400 }))) as unknown as typeof fetch;
  assert.equal(await readOneClickLeast("base", failed, 0), null);
  assert.deepEqual(always, ["1", "10", "100", "1000", "10000", "100000", "1000000"]);
});
