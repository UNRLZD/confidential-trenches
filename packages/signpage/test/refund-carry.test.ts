// A failed swap's refund is recorded and carried like a leftover (card refunds-land-on-the-devices-own-wallet): the
// address a quote refunds to (ORIGIN_CHAIN, U_{s,i}'s own on the origin chain) is recorded before the quote's address
// goes out (keepRefund), read by the leftover carry from the store alone (leftoverSources), carried whole to Cash when it
// holds money, kept after a carry (another quote under the same U may refund there), and let go only once it reads
// empty past the quote's signed deadline and REFUND_WATCH_MS.
//   node --test test/refund-carry.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { REFUND_WATCH_MS, carryLeftovers, clearLeftover, keepRefund, leftoverSources, refundKeyOf, refundRecordOf, storedRefunds, type LeftoverCarryDeps } from "../src/leftover-carry.ts";
import type { CarryEnd, CarryOpen, CarrySender, CarrySource } from "../src/carry-cash.ts";

const ADDR = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const DEADLINE = 1_800_000_000_000;
const REC = { chain: "base" as const, address: ADDR, s: "40", i: 7, deadline_ms: DEADLINE };

/** A meta store as the wallet store's update reads it: undefined from the change writes nothing. */
function metaStore() {
  const m = new Map<string, unknown>();
  return {
    m,
    keys: async (_s: "meta") => [...m.keys()],
    get: async (_s: "meta", k: string) => structuredClone(m.get(k)),
    update: async (_s: "meta", k: string, f: (v: unknown) => unknown) => {
      const next = f(structuredClone(m.get(k)));
      if (next !== undefined) m.set(k, next);
      return next;
    },
    delete: async (_s: "meta", k: string) => void m.delete(k),
  };
}

test("a quote's refund address is recorded under owed/ (the frame never lists it) and read back as a carry source", async () => {
  const st = metaStore();
  await keepRefund(st, REC);
  assert.deepEqual([...st.m.keys()], [refundKeyOf("base", ADDR)]);
  assert.match(refundKeyOf("base", ADDR), /^owed\/[^/]+$/);
  const src = leftoverSources([], [], await storedRefunds(st));
  assert.deepEqual(src, [{ kind: "refund", ...REC }]);
});

test("two quotes under one U name one address: one source, the later deadline kept; a malformed record is no source", async () => {
  const st = metaStore();
  await keepRefund(st, REC);
  await keepRefund(st, { ...REC, deadline_ms: DEADLINE + 5 });
  await keepRefund(st, { ...REC, deadline_ms: DEADLINE - 5 });
  assert.equal((st.m.get(refundKeyOf("base", ADDR)) as { deadline_ms: number }).deadline_ms, DEADLINE + 5);
  const rows = [...(await storedRefunds(st)), { kind: "refund", chain: "near", address: ADDR, s: "40", i: 7, deadline_ms: 1 }, { kind: "refund", chain: "base", address: ADDR, s: "x", i: 7, deadline_ms: 1 }, null];
  assert.equal(leftoverSources([], [], rows).length, 1);
  assert.equal(refundRecordOf({ ...REC, kind: "ux" }), null);
  await assert.rejects(keepRefund(st, { ...REC, s: "-1" }));
});

function world(o: { amount: bigint; end?: CarryEnd; now: number }) {
  const st = metaStore();
  const log: string[] = [];
  const kept = new Map<string, CarryOpen>();
  const sender: CarrySender = {
    sendable: async () => o.amount,
    send: async () => (log.push("send"), o.end ?? "landed"),
  };
  const d: LeftoverCarryDeps = {
    sources: async () => leftoverSources([], [], await storedRefunds(st)),
    sender: () => sender,
    worth: (_c, a) => a / 1_000_000_000n, // 1 USDC base unit a gwei, enough for the floor at 0.001 ETH
    quote: async () => (log.push("quote"), { address: "0x1111111111111111111111111111111111111111" }),
    onChain: () => true,
    open: async (src) => kept.get(src.address),
    keep: async (src, v) => void (v === undefined ? kept.delete(src.address) : kept.set(src.address, v)),
    cleared: async (src: CarrySource) => (log.push(`cleared:${src.kind}`), clearLeftover({ keys: async () => [], get: async () => undefined, update: async () => undefined, delete: (s, k) => st.delete(s, k) }, src)),
    now: () => o.now,
    draw: () => 0,
  };
  return { st, d, log };
}

test("a refund that landed is carried whole to Cash, and its address stays recorded for a later refund under the same U", async () => {
  const w = world({ amount: 10n ** 15n, now: DEADLINE + 60_000 });
  await keepRefund(w.st, REC);
  const r = await carryLeftovers(w.d);
  assert.equal(r?.end, "landed");
  assert.deepEqual(w.log, ["quote", "send"]);
  assert.ok(w.st.m.has(refundKeyOf("base", ADDR)));
});

test("an empty refund address is read on until its watch is past, then let go", async () => {
  const early = world({ amount: 0n, now: DEADLINE + REFUND_WATCH_MS });
  await keepRefund(early.st, REC);
  assert.equal((await carryLeftovers(early.d))?.end, "under");
  assert.ok(early.st.m.has(refundKeyOf("base", ADDR)));
  const late = world({ amount: 0n, now: DEADLINE + REFUND_WATCH_MS + 1 });
  await keepRefund(late.st, REC);
  assert.equal((await carryLeftovers(late.d))?.end, "under");
  assert.deepEqual(late.log, ["cleared:refund"]);
  assert.equal(late.st.m.size, 0);
});
