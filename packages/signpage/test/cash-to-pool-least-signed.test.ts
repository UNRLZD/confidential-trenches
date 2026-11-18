// Card cash-to-pool-least-signed: a move of Cash into a pool is planned with no part under 1Click's least for the route
// (cash-to-pool.ts readOneClickLeast). The read took that least from the helper's word: the number in a 400's "try at
// least N", which no one signs, or the amount of any 200 or 201, checked against nothing (card
// deposit-min-floor-signed's hand-back, 18 Nov 22:15Z). A helper that lowered N, or answered a quote of one unit, set
// the plan's least to its lie, and the Move screen showed a plan whose parts 1Click then refuses as too low. Now a least
// is an amount whose dry quote 1Click signed and the kit's check passes (packages/kit/src/checks/oneclick.ts: the
// signature under the pinned keys, every signed field the device's own request, the floors at the device's price, as
// the Move's own quote is checked): a 400's N says only where to ask next, above the amount just asked, and an answer
// that fails the check sets nothing. A signed answer whose fees take all that so little brings (the floor) is asked
// again at twice as much: 1Click's hints into Base's and Robinhood's ETH read on mainnet 18 Nov 23:04Z (1,000 and
// 17,840) are both such answers. Red at f3d020457.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ETH_PRICE, LEAST_NOW, SOL_PRICE, dryAnswer, least1Click, otherKey, said, signAnswer, tooLow, type Answer, type Reply } from "./oneclick-least-mock.ts";
import type { CashMoverDeps, CashNote } from "../src/cash-to-pool.ts";

const { cashMover, readOneClickLeast, LEAST_READ_ASKS } = await import("../src/cash-to-pool.ts");

const FEE = 50_000n; // the vault withdraw's relay fee, 0.05 USDC
const LEAST = 77_361n; // 1Click's least into SOL (18 Nov 12:20Z), above the fee, so a plan's least part is it
const NOTES: CashNote[] = [{ id: "n1", value: 5_000_000n }];
const ADDRESS = "d".repeat(64);
const sleep = async () => {};
const sol = { price: () => SOL_PRICE, sleep };

function mover(least: CashMoverDeps["least"]) {
  const quoted: bigint[] = [];
  const paid: bigint[] = [];
  const d: CashMoverDeps = {
    price: () => SOL_PRICE,
    floor: async () => 0n,
    least,
    rails: ["1click"],
    quote: async (_c, usdc) => (quoted.push(usdc), { address: ADDRESS, amountIn: usdc, minOut: (usdc * 10n ** 9n * 10_000n) / (80_000_000n * 10_100n) }),
    fee: async () => FEE,
    cash: async () => 5_000_000n,
    notes: async () => NOTES,
    handoff: async (w) => (paid.push(w.amount), { kind: "arrived" }),
    landed: async () => false,
    now: () => LEAST_NOW,
  };
  return { m: cashMover(d), quoted, paid };
}
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
/** The Move screen's plan of 1 USDC into SOL on a least read over `f`: its least part, or the refusal. */
async function planned(fetchFn: typeof fetch) {
  const t = mover((chain) => readOneClickLeast(chain, fetchFn, LEAST_NOW, sol));
  const r = await t.m.plan("solana", 1_000_000n);
  return { r, t };
}

test("honest 1Click: the least is the amount its 400 names, once a signed quote at it passes the kit's check", async () => {
  const oc = least1Click(LEAST, SOL_PRICE);
  assert.equal(await readOneClickLeast("solana", oc.fetchFn, LEAST_NOW, sol), LEAST);
  assert.deepEqual(oc.asked, ["1", String(LEAST)], "one unit, then the named amount itself");
  const { r } = await planned(least1Click(LEAST, SOL_PRICE).fetchFn);
  assert.ok(!("error" in r), show(r));
  assert.equal(r.part, LEAST, "the plan's least part is 1Click's least, unchanged");
});

test("a helper that rewrites the 400's N lower never sets the plan's least to its N", async () => {
  const lie = LEAST / 2n; // 38,680: under the fee, so a plan held to it would show a least part of the fee and one unit
  // every 400 rewritten: the ask at its N meets 1Click's own 400 again, rewritten to the same N, at or under the amount
  // asked, so each ask is a hundredth more, until the bound: never a least
  const always = (_req: unknown, reply: Reply): Reply => (reply.status === 400 ? tooLow(lie) : reply);
  const held1 = least1Click(LEAST, SOL_PRICE, { helper: always });
  await assert.rejects(readOneClickLeast("solana", held1.fetchFn, LEAST_NOW, sol), new RegExp(`no least in ${LEAST_READ_ASKS} asks`));
  assert.ok(held1.asked.every((x) => BigInt(x) < LEAST), "1Click refused every amount the lie led to");
  const held = await planned(least1Click(LEAST, SOL_PRICE, { helper: always }).fetchFn);
  assert.deepEqual(held.r, { error: "down" }, "no least: no plan, never one held to the lie");
  assert.deepEqual(held.t.quoted, []);
  // rewritten once: the ask at the lie meets 1Click's own N, and the least is that, signed
  const once = least1Click(LEAST, SOL_PRICE, { helper: (_req, reply, n) => (n === 1 ? tooLow(lie) : reply) });
  assert.equal(await readOneClickLeast("solana", once.fetchFn, LEAST_NOW, sol), LEAST);
  assert.deepEqual(once.asked, ["1", String(lie), String(LEAST)]);
  const one = await planned(least1Click(LEAST, SOL_PRICE, { helper: (_req, reply, n) => (n === 1 ? tooLow(lie) : reply) }).fetchFn);
  assert.ok(!("error" in one.r), show(one.r));
  assert.equal(one.r.part, LEAST, "the plan's least part is 1Click's, not the lie's");
  // rewritten lower, then a quote at the lie the helper made itself: signed by a key that is not 1Click's, or by none
  for (const key of [otherKey.privateKey, null] as const) {
    const forged = least1Click(LEAST, SOL_PRICE, {
      helper: (req, reply) => (BigInt(req.amount) === lie ? { status: 201, body: dryAnswer(req, SOL_PRICE, { key }) } : reply.status === 400 ? tooLow(lie) : reply),
    });
    await assert.rejects(readOneClickLeast("solana", forged.fetchFn, LEAST_NOW, sol), /fails the device's check: quote check failed \((signature|shape)\)/);
    assert.deepEqual(forged.asked, ["1", String(lie)]);
  }
});

test("a 200 or 201 with a broken or missing signature never sets the least: no plan, nothing quoted or paid", async () => {
  const at1 = (f: (req: Parameters<typeof dryAnswer>[0]) => unknown, status = 201) =>
    least1Click(LEAST, SOL_PRICE, { helper: (req, reply) => (req.amount === "1" ? { status, body: f(req) } : reply) });
  const flipped = (req: Parameters<typeof dryAnswer>[0]): Answer => {
    const a = dryAnswer(req, SOL_PRICE);
    a.signature = a.signature.slice(0, -2) + (a.signature.endsWith("1") ? "22" : "11");
    return a;
  };
  const changed = (req: Parameters<typeof dryAnswer>[0]): Answer => {
    const a = dryAnswer(req, SOL_PRICE);
    a.quote.amountOut = "999999999999"; // after 1Click signed
    return a;
  };
  const cases: [string, (req: Parameters<typeof dryAnswer>[0]) => unknown, number][] = [
    ["no signature", (req) => dryAnswer(req, SOL_PRICE, { key: null }), 201],
    ["a key that is not 1Click's", (req) => dryAnswer(req, SOL_PRICE, { key: otherKey.privateKey }), 201],
    ["a signature changed", flipped, 201],
    ["an amount changed after signing", changed, 200],
    ["a quote of nothing", () => ({ quote: {} }), 201],
    ["no JSON", () => "ok", 200],
  ];
  for (const [why, body, status] of cases) {
    const oc = at1(body, status);
    await assert.rejects(readOneClickLeast("solana", oc.fetchFn, LEAST_NOW, sol), /fails the device's check/, why);
    assert.deepEqual(oc.asked, ["1"], `${why}: refused, never asked again`);
    const { r, t } = await planned(at1(body, status).fetchFn);
    assert.deepEqual(r, { error: "down" }, `${why}: the plan's least never moves to one unit`);
    assert.deepEqual(await t.m.move("solana", 1_000_000n, "op-1"), { error: "down" }, why);
    assert.deepEqual(t.quoted, [], why);
    assert.deepEqual(t.paid, [], why);
  }
  // 1Click's own signed answer at a least the helper names, re-signed with its key after a change: refused too
  const resigned = least1Click(LEAST, SOL_PRICE, {
    helper: (req, reply) => {
      if (reply.status !== 201) return reply;
      const a = reply.body as Answer;
      a.quote.minAmountOut = "1";
      signAnswer(a, otherKey.privateKey);
      return { status: 201, body: a };
    },
  });
  await assert.rejects(readOneClickLeast("solana", resigned.fetchFn, LEAST_NOW, sol), /quote check failed \(signature\)/);
});

test("a signed answer whose fees take all its amount brings: asked again at twice as much, the least the first that passes", async () => {
  // into Robinhood's ETH at 3,000 USD: 1Click names 17,840 (as 18 Nov 23:04Z), and at it its withdraw fee takes more
  // than the 0.01784 USDC brings (6.0e12 wei against 5.9e12), so the kit's floor refuses; at twice as much it passes
  const oc = least1Click(17_840n, ETH_PRICE, { withdrawFee: 6_000_000_000_000n });
  assert.equal(await readOneClickLeast("robinhood", oc.fetchFn, LEAST_NOW, { price: () => ETH_PRICE, sleep }), 35_680n);
  assert.deepEqual(oc.asked, ["1", "17840", "35680"]);
  // at one USDC and still refused on its floor: no least
  const never = least1Click(17_840n, ETH_PRICE, { withdrawFee: 10n ** 18n });
  await assert.rejects(readOneClickLeast("robinhood", never.fetchFn, LEAST_NOW, { price: () => ETH_PRICE, sleep }), /fails the device's check: quote check failed \(floor\)/);
  assert.equal(never.asked.at(-1), "1141760", "doubled until past one USDC, then refused");
});

test("the read checks at the device's own price: with none read, no least", async () => {
  const oc = least1Click(LEAST, SOL_PRICE);
  await assert.rejects(readOneClickLeast("solana", oc.fetchFn, LEAST_NOW, { price: () => null, sleep }), /no price/);
  // a price far from 1Click's (SOL at 40 on the device, the quote at 80): the quote brings half the floor, refused
  await assert.rejects(readOneClickLeast("solana", least1Click(LEAST, SOL_PRICE).fetchFn, LEAST_NOW, { price: () => ({ price: "4000000000", expo: -8 }), sleep }), /quote check failed \(floor\)/);
});

test("a 400's N is where to ask next only: one at or under the amount asked asks a hundredth more, and the asks are bounded", async () => {
  // 1Click refusing its own N with the same N (into SOL, 18 Nov 23:15Z): a hundredth more, then its signed quote
  const own = least1Click(LEAST, SOL_PRICE, { helper: (req, reply) => (req.amount === String(LEAST) ? tooLow(LEAST) : reply) });
  assert.equal(await readOneClickLeast("solana", own.fetchFn, LEAST_NOW, sol), LEAST + LEAST / 100n);
  assert.deepEqual(own.asked, ["1", String(LEAST), String(LEAST + LEAST / 100n)]);
  // an N of none or of the amount asked is no least either: asked one unit more each time, until the bound
  for (const n of ["0", "1"]) {
    const o = least1Click(LEAST, SOL_PRICE, { helper: () => tooLow(n) });
    await assert.rejects(readOneClickLeast("solana", o.fetchFn, LEAST_NOW, sol), new RegExp(`no least in ${LEAST_READ_ASKS} asks`), n);
    assert.deepEqual(o.asked.slice(0, 3), ["1", "2", "3"], n);
  }
  // a helper that names one unit more each time: never a least, and no more than LEAST_READ_ASKS asks
  const creep = least1Click(LEAST, SOL_PRICE, { helper: (req) => tooLow(BigInt(req.amount) + 1n) });
  await assert.rejects(readOneClickLeast("solana", creep.fetchFn, LEAST_NOW, sol), new RegExp(`no least in ${LEAST_READ_ASKS} asks`));
  assert.equal(creep.asked.length, LEAST_READ_ASKS);
});

test("the read past 'Failed to get quote' (Base's ETH, 15 Nov 13:30Z) and what it asks: a dry quote naming no account of the user's", async () => {
  const sent: Record<string, unknown>[] = [];
  const base = least1Click(1_000n, ETH_PRICE, { helper: (req, reply) => (sent.push(req), req.amount === "1" ? said("Failed to get quote") : reply) });
  assert.equal(await readOneClickLeast("base", base.fetchFn, LEAST_NOW, { price: () => ETH_PRICE, sleep }), 1_000n);
  assert.deepEqual(base.asked, ["1", "10", "1000"]);
  assert.equal(sent[0]!.dry, true);
  assert.equal(sent[0]!.destinationAsset, "nep141:base.omft.near");
  assert.equal(sent[0]!.recipient, "0x1111111111111111111111111111111111111111");
  assert.equal(sent[0]!.refundTo, "4b742e2fa54135408f95d6be00483527709b33281f3d1836ae3e83371caae5c0");
  // into SOL: the wrapped-SOL mint, as 1Click refuses Solana's system program ("recipient is not valid", 15 Nov 12:49Z)
  const s: Record<string, unknown>[] = [];
  await readOneClickLeast("solana", least1Click(LEAST, SOL_PRICE, { helper: (req, reply) => (s.push(req), reply) }).fetchFn, LEAST_NOW, sol);
  assert.equal(s[0]!.recipient, "So11111111111111111111111111111111111111112");
  assert.equal(s[0]!.amount, "1");
  // an amount 1Click quotes on the ladder, signed and checked, is the least
  const quotes = least1Click(100n, ETH_PRICE, { helper: (req, reply) => (BigInt(req.amount) < 100n ? said("Failed to get quote") : reply) });
  assert.equal(await readOneClickLeast("robinhood", quotes.fetchFn, LEAST_NOW, { price: () => ETH_PRICE, sleep }), 100n);
  assert.deepEqual(quotes.asked, ["1", "10", "100"]);
  // a refusal that names no least is never asked again
  const other = least1Click(LEAST, SOL_PRICE, { helper: () => said("recipient is not valid") });
  await assert.rejects(readOneClickLeast("base", other.fetchFn, LEAST_NOW, { price: () => ETH_PRICE, sleep }), /names no least: HTTP 400 recipient is not valid/);
  assert.deepEqual(other.asked, ["1"]);
  await assert.rejects(readOneClickLeast("solana", least1Click(LEAST, SOL_PRICE, { helper: () => ({ status: 400, body: {} }) }).fetchFn, LEAST_NOW, sol), /names no least/);
  // no answer at all: asked again, then no least (card cash-least-read-again)
  await assert.rejects(readOneClickLeast("solana", (async () => { throw new Error("down"); }) as unknown as typeof fetch, LEAST_NOW, sol), /no least in 3 tries: no answer/);
  // "Failed to get quote" up to one USDC, then asked again there (a blip, card cash-least-read-again), then no least
  const failed = least1Click(LEAST, SOL_PRICE, { helper: () => said("Failed to get quote") });
  await assert.rejects(readOneClickLeast("base", failed.fetchFn, LEAST_NOW, { price: () => ETH_PRICE, sleep }), /no least in 3 tries: HTTP 400 Failed to get quote/);
  assert.deepEqual(failed.asked, ["1", "10", "100", "1000", "10000", "100000", "1000000", "1000000", "1000000"]);
  // after a 400's N, "Failed to get quote" at N is a blip asked again at N, never a step past it
  const blip = least1Click(LEAST, SOL_PRICE, { helper: (req, reply, n) => (n === 2 ? said("Failed to get quote") : reply) });
  assert.equal(await readOneClickLeast("solana", blip.fetchFn, LEAST_NOW, sol), LEAST);
  assert.deepEqual(blip.asked, ["1", String(LEAST), String(LEAST)]);
});
