// Card move-from-cash-spends-every-note: the Move screen from Cash into a pool (pool.move and pool.move.dry, near to
// solana, base or robinhood) was held to Cash's largest note (cash-to-pool.ts cashMover's ready and bounds:
// `usdc + fee > cash`, Max the largest note less its fee), so Cash split over notes each under the move refused it. A
// withdraw proof spends one note, so the move is planned over every note (planCashExact: one withdrawal a note, each part
// at least the least a quote takes, the pool's floor and 1Click's least), its dry, Max and Fee read from that one plan,
// and every part's quote is checked before any note leaves Cash (sendParts, the buy's own path). Red at 65913ef75.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cashLamportsFor, cashMover, poolMoveKinds, type CashMoverDeps, type CashNote, type CashQuote } from "../src/cash-to-pool.ts";
import type { PoolChain } from "../../kit/src/signpage/messages.ts";

const FEE = 50_000n; // the vault withdraw's relay fee, 0.05 USDC
const SOL = { price: "8000000000", expo: -8 }; // SOL at 80 USD
const ETH = { price: "300000000000", expo: -8 }; // ETH at 3,000 USD
// the pools' quote floors (pool.address's): Solana's rung, one deposit's cost and U_X's rent; an EVM pool's least rung
// and one deposit's gas
const FLOOR: Record<PoolChain, bigint> = { solana: 12_000_000n, base: 1_020_000_000_000_000n, robinhood: 1_020_000_000_000_000n };
// 1Click's least into each pool's coin, read 15 Nov 13:0xZ (into Base's ETH: 1,042 at ten units, 13:30Z)
const LEAST: Record<PoolChain, bigint> = { solana: 75_621n, base: 1_042n, robinhood: 18_533n };
const ADDRESS = "c".repeat(64);
const ctx = { id: "req-1", sha: "00", progress: () => {} };
// Cash split over notes each under the move, every note too small for a part and a change a later move can send, so a
// plan takes notes whole; and a dust note no part can be made of
const CASH: Record<PoolChain, CashNote[]> = {
  // a part into SOL takes at least 1.8128 USDC (its least clears the 0.012 SOL floor)
  solana: [
    { id: "n1", value: 3_000_000n },
    { id: "n2", value: 2_500_000n },
    { id: "n3", value: 2_000_000n },
    { id: "dust", value: 60_000n },
  ],
  // a part into ETH takes at least 6.2418 USDC (its least clears the 0.00102 ETH floor)
  base: [
    { id: "n1", value: 8_000_000n },
    { id: "n2", value: 7_000_000n },
    { id: "n3", value: 6_500_000n },
    { id: "dust", value: 60_000n },
  ],
  robinhood: [
    { id: "n1", value: 8_000_000n },
    { id: "n2", value: 7_000_000n },
    { id: "n3", value: 6_500_000n },
    { id: "dust", value: 60_000n },
  ],
};
// per chain: [an amount two whole notes send, Max (every note whole less its fee), an amount no plan sends]
const ASK: Record<PoolChain, { two: string; max: string; none: string }> = {
  solana: { two: "5.4", max: "7.35", none: "6" },
  base: { two: "14.9", max: "21.35", none: "20" },
  robinhood: { two: "14.9", max: "21.35", none: "20" },
};
const price = (c: PoolChain) => (c === "solana" ? SOL : ETH);
const D = (c: PoolChain) => (c === "solana" ? 9 : 18);
const text = (x: bigint, d: number): string => {
  const t = x.toString().padStart(d + 1, "0");
  const f = t.slice(-d).replace(/0+$/, "");
  return f ? `${t.slice(0, -d)}.${f}` : t.slice(0, -d);
};

function page(chain: PoolChain, notes: readonly CashNote[], o: { quote?: (usdc: bigint, n: number) => CashQuote | { error: string } } = {}) {
  const quoted: { usdc: bigint; id: string }[] = [];
  const paid: { amount: bigint; note: string | undefined; at: number }[] = [];
  let n = 0;
  const d: CashMoverDeps = {
    price: (c) => price(c),
    floor: async (c) => FLOOR[c],
    least: async (c) => LEAST[c],
    rails: ["1click"],
    // a quote that brings more than the least (no margin taken)
    quote: async (_c, usdc, id) => (quoted.push({ usdc, id }), o.quote?.(usdc, ++n) ?? { address: ADDRESS, amountIn: usdc, minOut: chain === "solana" ? (usdc * 10n ** 9n) / 80_000_000n : (usdc * 10n ** 12n) / 3_000n }),
    fee: async () => FEE,
    // the largest note, what the move was held to before the card
    cash: async () => notes.reduce((m, x) => (x.value > m ? x.value : m), 0n),
    notes: async () => notes,
    handoff: async (w, _fee, note) => (paid.push({ amount: w.amount, note, at: quoted.length }), { kind: "arrived" }),
    landed: async () => false,
    now: () => 1_000,
  };
  const m = cashMover(d);
  return { m, k: poolMoveKinds(() => m), quoted, paid };
}
async function settle(a: unknown): Promise<unknown> {
  const r = a as { after?: Promise<unknown>; answer?: () => unknown };
  if (r.after === undefined) return a;
  await r.after;
  return r.answer!();
}
const usdcOf = (s: string): bigint => {
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0"));
};

for (const chain of ["solana", "base", "robinhood"] as const) {
  test(`${chain}: Cash split over notes each under the move: the dry prices the plan over every note, its Max all of Cash and its Fee a relay fee a part`, async () => {
    const notes = CASH[chain];
    const p = page(chain, notes);
    const two = usdcOf(ASK[chain].two);
    assert.ok(notes.every((x) => x.value < two + FEE), "no one note pays the move");
    const steps = [{ step: "vault_out", chain: "near" }, { step: "intents", chain }, { step: "pool_in", chain }];
    const least = (u: bigint) => cashLamportsFor(u, price(chain), chain);
    const dry = await settle(p.k["pool.move.dry"]({ from: "near", to: chain, amount: ASK[chain].two }, ctx));
    assert.deepEqual(dry, { result: { out: text(least(notes[0]!.value - FEE) + least(notes[1]!.value - FEE), D(chain)), fee: "0.1", steps, max: ASK[chain].max } }, "two whole notes, each less its fee: the dust note never counts");
    // Max moves every note whole that gives a part
    const all = (await settle(p.k["pool.move.dry"]({ from: "near", to: chain, amount: ASK[chain].max }, ctx))) as { result: { out?: string; fee?: string } };
    assert.equal(all.result.fee, "0.15", "three parts, three fees");
    assert.equal(typeof all.result.out, "string");
    // an amount between what whole notes send: the nearest amounts a plan sends, nothing priced
    assert.deepEqual(await settle(p.k["pool.move.dry"]({ from: "near", to: chain, amount: ASK[chain].none }, ctx)), { result: { max: ASK[chain].max, steps, below: ASK[chain].two, above: ASK[chain].max } });
    // over Max: Max alone
    assert.deepEqual(await settle(p.k["pool.move.dry"]({ from: "near", to: chain, amount: "100" }, ctx)), { result: { max: ASK[chain].max, steps } });
    assert.deepEqual([p.quoted, p.paid], [[], []], "a dry quotes and sends nothing");
  });

  test(`${chain}: pool.move from that Cash sends the plan: every part's quote before any note leaves Cash, one note a part, exactly the amount asked`, async () => {
    const notes = CASH[chain];
    const p = page(chain, notes);
    assert.deepEqual(await settle(p.k["pool.move"]({ from: "near", to: chain, amount: ASK[chain].two }, ctx)), { result: { stage: "leaving", txs: [] } });
    await p.m.idle();
    assert.deepEqual(p.quoted, [{ usdc: notes[0]!.value - FEE, id: "req-1/1click" }, { usdc: notes[1]!.value - FEE, id: "req-1/1/1click" }], "each part its own quote, the first under the move's op");
    assert.deepEqual(p.paid.map((x) => [x.note, x.amount]), [["n1", notes[0]!.value - FEE], ["n2", notes[1]!.value - FEE]], "largest first, each its own note, whole: no change left");
    assert.ok(p.paid.every((x) => x.at === p.quoted.length), "no note leaves Cash before the last quote is checked");
    assert.equal(p.paid.reduce((t, x) => t + x.amount, 0n), usdcOf(ASK[chain].two), "exactly the amount asked");
  });

  test(`${chain}: a part's quote refused sends nothing, and an amount no plan sends starts nothing`, async () => {
    const notes = CASH[chain];
    const bad = page(chain, notes, { quote: (usdc, n) => (n === 2 ? { address: ADDRESS, amountIn: usdc - 1n, minOut: 10n ** 18n } : { address: ADDRESS, amountIn: usdc, minOut: 10n ** 18n }) });
    assert.deepEqual(await settle(bad.k["pool.move"]({ from: "near", to: chain, amount: ASK[chain].two }, ctx)), { error: "quote_check_failed" });
    assert.deepEqual(bad.paid, [], "the first part's checked quote paid nothing either");
    const none = page(chain, notes);
    assert.deepEqual(await settle(none.k["pool.move"]({ from: "near", to: chain, amount: ASK[chain].none }, ctx)), { error: "not_allowed" });
    assert.deepEqual(await none.m.move(chain, usdcOf(ASK[chain].none), "req-2"), { error: "not_allowed" }, "the mover's own move holds to the same plan");
    assert.deepEqual([none.quoted, none.paid], [[], []]);
  });
}

test("planCashExact: one note that pays it with no change or one a later move can send pays it alone, the smallest such; under the least part, its min", async () => {
  // read here, so the tests above fail on what the move does, not on this import, where the card is not
  const { planCashExact } = await import("../src/cash-to-pool.ts");
  const least = (u: bigint) => cashLamportsFor(u, SOL, "solana");
  const notes: CashNote[] = [{ id: "big", value: 10_000_000n }, { id: "mid", value: 6_000_000n }, { id: "small", value: 2_000_000n }];
  const one = planCashExact(notes, FEE, 3_000_000n, least, FLOOR.solana, LEAST.solana)!;
  assert.deepEqual(one.parts?.map((x) => [x.note, x.usdc]), [["mid", 3_000_000n]], "mid's change, 2.95 USDC, is one a later move sends; small cannot pay it");
  assert.equal(one.max, 17_850_000n, "every note whole less its fee");
  // mid would leave 0.95 USDC, under a fee and the least part: big pays it alone
  assert.deepEqual(planCashExact(notes, FEE, 5_000_000n, least, FLOOR.solana, LEAST.solana)!.parts?.map((x) => x.note), ["big"]);
  const under = planCashExact(notes, FEE, 1_000_000n, least, FLOOR.solana, LEAST.solana)!;
  assert.equal(under.parts, null);
  assert.ok(under.min !== undefined && least(under.min) >= FLOOR.solana && least(under.min - 1n) < FLOOR.solana, "min: the least part whose least clears the floor");
  // every part's least clears the pool's floor
  for (const x of planCashExact(notes, FEE, 17_850_000n, least, FLOOR.solana, LEAST.solana)!.parts!) assert.ok(x.least >= FLOOR.solana);
});
