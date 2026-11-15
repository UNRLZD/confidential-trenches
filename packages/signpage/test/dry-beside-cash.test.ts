// pool.buy.dry for a user with no pool note (card buy-quote-before-any-note, round 2): the dry's reads and Cash's reads run
// side by side, so the answer waits for the slowest read, never their sum, and with no Cash note no plan read is made or
// waited on (src/cash-to-pool.ts cashPlanReads, dryBesideCash; main.ts wires both for Solana, Base and Robinhood).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Running } from "../src/api.ts";
import { cashFeeRead, cashPlanReads, dryBesideCash, evmDryCashReads, NO_CASH_EVM_PLAN } from "../src/cash-to-pool.ts";

const SLOW_MS = 300;
const later = <T>(ms: number, v: T): Promise<T> => new Promise((ok) => setTimeout(() => ok(v), ms));
const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** A Solana dry (pools.ts poolBuyDryKind) that answers after `ms`, priced as the buy from Cash. */
function slowDry(ms: number): Running<"pool.buy.dry"> {
  let a: ReturnType<Running<"pool.buy.dry">["answer"]> = { error: "down" };
  const after = later(ms, null).then(() => void (a = { result: { tap_max: "0", out: "211.011995" } }));
  return { running: true, after, answer: () => a };
}

/** Lets every promise the timers settled run on (setImmediate is not mocked). */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
};

test("a no-note Solana dry with slow reads answers at the slowest read, not their sum", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Cash's reads as main.ts makes them, each SLOW_MS on the test's clock: the notes, then (with a note) the fee, floor
  // and least
  const cash = cashPlanReads(
    () => later(SLOW_MS, []),
    () => [cashFeeRead(never()), never(), never()] as const,
  ).then((x) => (tap: string) => (x.notes.length === 0 ? tap : null));
  const r = dryBesideCash(slowDry(SLOW_MS), cash);
  let done = false;
  void r.after.then(() => void (done = true));
  t.mock.timers.tick(SLOW_MS - 1);
  await flush();
  assert.equal(done, false);
  // one SLOW_MS in: both reads are in, so the answer is (after them, in turn, it would take two)
  t.mock.timers.tick(1);
  await flush();
  assert.equal(done, true, `no answer at ${SLOW_MS} ms, the slowest read`);
  assert.deepEqual(r.answer(), { result: { tap_max: "0", out: "211.011995", with_cash: "0" } });
});

test("with no Cash note, the fee, floor and least are neither read nor waited on", async () => {
  let asked = 0;
  const r = await cashPlanReads(
    async () => [],
    () => (asked++, [cashFeeRead(never()), never(), never()] as const),
  );
  assert.equal(asked, 0);
  assert.deepEqual(r, { notes: [], fee: 0n, floor: null, leastIn: null });
  // and the EVM plan over no note moves nothing
  assert.equal(NO_CASH_EVM_PLAN.top, 0n);
  assert.equal(NO_CASH_EVM_PLAN.parts(1n), null);
  assert.equal(NO_CASH_EVM_PLAN.cost(1n), null);
});

test("with a Cash note, the fee, floor and least are read side by side and the plan waits for them", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const plan = cashPlanReads(
    async () => [{ id: "n", value: 5_000_000n }],
    () => [cashFeeRead(later(SLOW_MS, 7n)), later(SLOW_MS, 12n), later(SLOW_MS, 3n)] as const,
  );
  let got: Awaited<typeof plan> | undefined;
  void plan.then((x) => void (got = x));
  await flush();
  t.mock.timers.tick(SLOW_MS - 1);
  await flush();
  assert.equal(got, undefined);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(got, { notes: [{ id: "n", value: 5_000_000n }], fee: 7n, floor: 12n, leastIn: 3n });
  t.mock.timers.reset();
  // a failed fee read with a note is thrown, as cashPlanFee
  await assert.rejects(
    cashPlanReads(
      async () => [{ id: "n", value: 5_000_000n }],
      () => [cashFeeRead(Promise.reject(new Error("amount"))), Promise.resolve(12n), Promise.resolve(3n)] as const,
    ),
    /amount/,
  );
});

test("a dry that is refused, or Cash's reads that fail, give no with_cash", async () => {
  const refused: Running<"pool.buy.dry"> = { running: true, after: Promise.resolve(), answer: () => ({ error: "quote_check_failed" }) };
  const a = dryBesideCash(refused, Promise.resolve((tap: string) => tap));
  await a.after;
  assert.deepEqual(a.answer(), { error: "quote_check_failed" });
  const b = dryBesideCash(slowDry(1), Promise.resolve(null));
  await b.after;
  assert.deepEqual(b.answer(), { result: { tap_max: "0", out: "211.011995" } });
});

test("a Base or Robinhood dry with Cash reads the epoch fee beside the plan's slow floor: the slower of the two, never their sum", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let notesRead = 0;
  let feesRead = 0;
  const cash = evmDryCashReads(
    async () => (notesRead++, [{ id: "n", value: 5_000_000n }]),
    // the plan over the notes waits on the pool's floor read (Robinhood's took 27-30 s), SLOW_MS here
    (notes) => later(SLOW_MS, { top: notes.length }),
    () => (feesRead++, later(SLOW_MS, 9n)),
  );
  let got: unknown;
  // as the dry asks them: with_cash starts the fee then waits the plan, the move's sizing asks both again
  void Promise.all([cash.fee(), cash.plan(), cash.plan(), cash.fee()]).then((x) => void (got = x));
  await flush();
  t.mock.timers.tick(SLOW_MS - 1);
  await flush();
  assert.equal(got, undefined);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(got, [9n, { top: 1 }, { top: 1 }, 9n], `no answer at ${SLOW_MS} ms, the slower of the floor and the fee`);
  // one read of the notes, one fee read, however many deps ask
  assert.equal(notesRead, 1);
  assert.equal(feesRead, 1);
});

test("a Base or Robinhood dry with no Cash note reads no epoch fee", async () => {
  let feesRead = 0;
  const cash = evmDryCashReads(async () => [], async (notes) => notes.length, () => (feesRead++, never<bigint | null>()));
  assert.equal(await cash.fee(), null);
  assert.equal(await cash.plan(), 0);
  assert.equal(feesRead, 0);
});
