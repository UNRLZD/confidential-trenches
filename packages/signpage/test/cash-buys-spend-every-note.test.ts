// Card cash-buys-spend-every-note: the owner's $2 Solana buy from Cash (15 Nov 11:58Z and 11:59Z) was refused, since a
// move out of Cash was sized against Cash's largest note alone (cash-to-pool.ts cashMover.start, main.ts's dry and Max:
// withdraw/checks.ts withdrawable) and the owner's Cash was split over notes each under the move. A withdraw proof
// spends one note (contracts/vault/src/verifier.rs verify_withdraw: one existingNullifierHash), so the move is planned
// over every note: one withdrawal a note, each part its own quote into its own one-time address, every quote checked
// before any note leaves Cash; a note too small for a part (under the pool's quote floor or 1Click's least, read live)
// is never asked and stays in Cash; Max is what those parts can move, Cash less a fee a part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cashMover, cashMoveCost, cashMoveMost, cashUsdcFor, moveCostOf, planCashMove, solanaMoveModel, withCash, type CashMoverDeps, type CashNote, type CashQuote } from "../src/cash-to-pool.ts";

const PRICE = { price: "8000000000", expo: -8 }; // SOL at 80 USD
const FEE = 50_000n; // the relay fee, 0.05 USDC
const FLOOR = 12_000_000n; // the pool's quote floor on Solana: the rung (0.01 SOL), one deposit's cost and U_X's rent
const LEAST = 75_621n; // 1Click's least into SOL, read 15 Nov 13:0xZ ("try at least 75621")
const ADDRESS = "a".repeat(64);
const model = () => solanaMoveModel(PRICE, FLOOR, LEAST);
// Cash split over notes each under the move (the owner's case), and one dust note no part can be made of
const SPLIT: CashNote[] = [
  { id: "n1", value: 3_000_000n },
  { id: "n2", value: 2_500_000n },
  { id: "n3", value: 2_000_000n },
  { id: "dust", value: 60_000n },
];
const SHORT = 30_000_000n;
const lamports = (sol: string): bigint => {
  const [w, f = ""] = sol.split(".");
  return BigInt(w!) * 10n ** 9n + BigInt(f.padEnd(9, "0"));
}; // 0.03 SOL short of the tap: cashUsdcFor asks 3.296 USDC, more than any one note

function mover(notes: readonly CashNote[], o: { quote?: (usdc: bigint, n: number) => CashQuote | { error: string } } = {}) {
  const quoted: bigint[] = [];
  const paid: { amount: bigint; note: string | undefined; fee: bigint; at: number }[] = [];
  let n = 0;
  const d: CashMoverDeps = {
    price: () => PRICE,
    floor: async () => FLOOR,
    least: async () => LEAST,
    rails: ["1click"],
    quote: async (_c, usdc) => (quoted.push(usdc), o.quote?.(usdc, ++n) ?? { address: ADDRESS, amountIn: usdc, minOut: (usdc * 10n ** 9n * 10_000n) / (80_000_000n * 10_100n) }),
    fee: async () => FEE,
    cash: async () => notes.reduce((m, x) => (x.value > m ? x.value : m), 0n),
    notes: async () => notes,
    handoff: async (w, fee, note) => (paid.push({ amount: w.amount, note, fee, at: quoted.length }), { kind: "arrived" }),
    landed: async () => false,
    now: () => 1_000,
  };
  return { m: cashMover(d), quoted, paid };
}

test("a buy's move from Cash split over notes each under it is planned over every note: one withdrawal a note, each whole but the last, the dust note never asked", async () => {
  const t = mover(SPLIT);
  assert.ok(cashUsdcFor(SHORT, PRICE)! + FEE > 3_000_000n, "no one note pays the move");
  assert.equal(await t.m.need("solana", SHORT), "cash/solana/1000", "the move's op is its first part's");
  // every part's quote before any note leaves Cash
  assert.ok(t.paid.every((p) => p.at === t.quoted.length), "no hand-off before the last quote");
  // each part brings a rung over its own quote (cashUsdcFor), so two parts ask more than one move would
  assert.deepEqual(t.paid.map((p) => p.note), ["n1", "n2"], "largest first, each its own note; n3 and the dust note never asked");
  assert.equal(t.paid[0]!.amount, 2_950_000n, "a note before the last is moved whole, less its fee: no change left");
  assert.ok(2_500_000n - t.paid[1]!.amount - FEE > 2n * FEE, "the last part leaves a change a later withdrawal can still send");
  assert.ok(t.paid.every((p) => p.fee === FEE));
  // what the parts bring covers the shortfall
  const parts = planCashMove(SPLIT, FEE, SHORT, model())!;
  assert.ok(parts.reduce((s, p) => s + p.units, 0n) >= SHORT);
  assert.ok(parts.every((p) => p.usdc >= LEAST && p.units >= FLOOR - 10_000_000n), "every part clears 1Click's least and the pool's floor");
});

test("a part's quote refused: no note leaves Cash, the move is refused", async () => {
  const t = mover(SPLIT, { quote: (usdc, n) => (n === 2 ? { error: "quote_check_failed" } : { address: ADDRESS, amountIn: usdc, minOut: (usdc * 10n ** 9n) / 81_000_000n }) });
  assert.equal(await t.m.need("solana", SHORT), null);
  assert.deepEqual(t.paid, [], "nothing withdrawn");
});

test("one note that pays the move alone still pays it alone, the move as before (one quote, one withdrawal)", async () => {
  const t = mover([...SPLIT, { id: "big", value: 20_000_000n }]);
  await t.m.need("solana", SHORT);
  assert.deepEqual(t.paid.map((p) => [p.note, p.amount]), [["big", cashUsdcFor(SHORT, PRICE)!]]);
  assert.equal(cashMoveCost(planCashMove([{ id: "big", value: 20_000_000n }], FEE, SHORT, model())!, FEE, PRICE, "solana"), moveCostOf(SHORT, FEE, PRICE), "a one-part move costs what it did");
});

test("Max with Cash is every note a part can be made of, each less its fee; the planner moves exactly that much, never more", () => {
  const most = cashMoveMost(SPLIT, FEE, model());
  // 2.95 + 2.45 + 1.95 USDC at 80 USD and 3% over, less a rung a part; the dust note none
  assert.ok(most > 0n);
  assert.equal(planCashMove(SPLIT, FEE, most, model())?.length, 3, "Max moves: all three notes");
  assert.equal(planCashMove(SPLIT, FEE, most + 1n, model()), null, "past Max nothing is planned");
  // the box's Max: tap_max 0.01 SOL, nothing on its way, plus that
  const shown = withCash("0.01", 0n, SPLIT, FEE, PRICE, FLOOR, LEAST)!;
  assert.equal(lamports(shown), 10_000_000n + most, shown);
  // the largest note alone, as before this card, shows less
  const largest = withCash("0.01", 0n, [SPLIT[0]!], FEE, PRICE, FLOOR, LEAST)!;
  assert.ok(Number(largest) < Number(shown), `${largest} < ${shown}`);
});

test("a note too small for a part is never asked: under the pool's quote floor or 1Click's least, it stays in Cash and counts for nothing in Max", () => {
  const tiny: CashNote[] = [{ id: "t1", value: 700_000n }, { id: "t2", value: FEE + LEAST - 1n }];
  // t1 makes a part (0.65 USDC, over the floor and 1Click's least); t2 is under 1Click's least after its fee
  const parts = planCashMove(tiny, FEE, 1_000_000n, model());
  assert.ok(parts === null || parts.every((p) => p.note !== "t2"), "t2 is never a part");
  assert.equal(cashMoveMost([tiny[1]!], FEE, model()), 0n, "t2 alone moves nothing");
  assert.equal(cashMoveMost([{ id: "u", value: FEE }], FEE, model()), 0n, "a note of one fee moves nothing");
  // a part under the pool's quote floor: 0.15 USDC buys 0.00182 SOL, less the rung none
  assert.equal(cashMoveMost([{ id: "f", value: FEE + 150_000n }], FEE, solanaMoveModel(PRICE, FLOOR, 0n)), 0n);
});

// 1Click's least read (readOneClickLeast) is test/cash-to-pool-least-signed.test.ts's (card cash-to-pool-least-signed):
// its answers are signed there, by a key that file's process alone trusts, as the least is set only by a signed quote.
