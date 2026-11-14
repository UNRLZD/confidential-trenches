// node --test packages/signpage/test/leftover-carry.test.ts (card leftovers-carry-to-cash): a one-time wallet's leftover is
// carried whole to Cash, one wallet a pass, recorded before any send, never sent twice, and kept (counted, tried again)
// while it is under the vault's least deposit. The owner's case: a 0.003 ETH Robinhood deposit left 0.0009941 ETH on
// U_X 0x314152946062315ad2fad8a54e28d74f15646268 (read 13 Nov 20:52Z on two RPCs). Red at main 36479a675 (no carry:
// that money stays on U_X), green after.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CARRY_UNSENT_MS, CARRY_VAULT_MIN, carryLeftovers, carryOpenKey, clearLeftover, leftoverSources, worthUsdc, type LeftoverCarryDeps } from "../src/leftover-carry.ts";
import type { CarryEnd, CarryOpen, CarrySender, CarrySource } from "../src/carry-cash.ts";
import { depositWalletsOf } from "../src/pool-deposit-follow.ts";

const U = "0x314152946062315ad2fad8a54e28d74f15646268";
const DEPOSIT = "0x1111111111111111111111111111111111111111";
const LEFT = 994_100_000_000_000n;
const BOUND = 30_000_000_000n;
const op = (stage: string, left: string | undefined, o: { final?: true; created?: number; chain?: string; u?: string } = {}) => ({
  kind: "pool_deposit", stage, txs: [], created_ms: o.created ?? 1, ...(o.final ? { final: true } : {}),
  follow: { chain: o.chain ?? "robinhood", s: "7", i: 3, u: o.u ?? U, refund_id: "ab".repeat(32), address: U, deadline_ms: 1, origin: "x", min_out: "1", ...(left === undefined ? {} : { left }) },
});

function world(o: { worth?: bigint | null; quote?: { address: string } | { error: "quote_check_failed" }; ends?: CarryEnd[]; open?: CarryOpen; keepFails?: true; ops?: unknown[]; tails?: unknown[]; now?: number } = {}) {
  const log: string[] = [];
  const kept = new Map<string, CarryOpen>();
  if (o.open) kept.set(carryOpenKey({ chain: "robinhood", address: U }), o.open);
  const cleared: CarrySource[] = [];
  const quoted: { chain: string; amount: bigint; id: string }[] = [];
  const sends: CarryOpen[] = [];
  const ends = [...(o.ends ?? ["landed"])];
  const sender: CarrySender = {
    sendable: async () => (log.push("sendable"), LEFT - BOUND),
    send: async (_src, open, keep) => {
      log.push("send");
      sends.push(structuredClone(open));
      await keep({ ...open, sends: [...open.sends, { hash: "0xaa", value: open.amount, sentMs: "5", nonce: "4" }] });
      return ends.shift() ?? "pending";
    },
  };
  const d: LeftoverCarryDeps = {
    sources: async () => leftoverSources(o.ops ?? [op("in_pool", LEFT.toString(), { final: true })], o.tails ?? []),
    sender: (c) => (c === "robinhood" || c === "base" || c === "solana" ? sender : null),
    worth: () => (o.worth === undefined ? 1_900_000n : o.worth),
    quote: async (chain, amount, id) => (log.push("quote"), quoted.push({ chain, amount, id }), o.quote ?? { address: DEPOSIT }),
    onChain: (_c, a) => /^0x[0-9a-f]{40}$/.test(a),
    open: async (src) => kept.get(carryOpenKey(src)),
    keep: async (src, v) => {
      if (o.keepFails) throw new Error("store");
      log.push(v === undefined ? "drop" : `keep:${v.sends.length}`);
      if (v === undefined) kept.delete(carryOpenKey(src));
      else kept.set(carryOpenKey(src), structuredClone(v));
    },
    cleared: async (src) => void (log.push("cleared"), cleared.push(src)),
    now: () => o.now ?? 1_000,
    draw: () => 0,
  };
  return { d, log, kept, cleared, quoted, sends };
}

test("the owner's case: Robinhood U_X's 0.0009941 ETH goes whole to Cash's deposit quote, recorded before it is sent, then cleared where the balance counted it", async () => {
  const w = world();
  const r = await carryLeftovers(w.d);
  assert.equal(r?.end, "landed");
  assert.deepEqual(r?.src, { chain: "robinhood", kind: "ux", address: U, s: "7", i: 3 });
  assert.equal(w.quoted.length, 1);
  assert.equal(w.quoted[0]!.amount, LEFT - BOUND, "the whole lower balance less the send's bound");
  assert.ok(!w.quoted[0]!.id.includes(U), "the quote's op id names no wallet");
  assert.deepEqual(w.log, ["sendable", "quote", "keep:0", "send", "keep:1", "cleared", "drop"]);
  assert.deepEqual(w.sends[0], { to: DEPOSIT, amount: (LEFT - BOUND).toString(), quote: w.quoted[0]!.id, quotedMs: "1000", sends: [] });
  assert.equal(w.kept.size, 0);
});

test("a reload with a send on its way follows it and never quotes or sends anew; a dead one is dropped and quoted again next pass", async () => {
  const open: CarryOpen = { to: DEPOSIT, amount: "5", quote: "carry/robinhood/x", quotedMs: "1", sends: [{ hash: "0xaa", value: "5", sentMs: "2", nonce: "4" }] };
  const w = world({ open, ends: ["pending"], now: 10 * CARRY_UNSENT_MS });
  assert.equal((await carryLeftovers(w.d))?.end, "pending");
  assert.equal(w.quoted.length, 0);
  assert.deepEqual(w.sends, [open], "the open carry, as it was");
  assert.equal(w.cleared.length, 0);
  const dead = world({ open, ends: ["dead"] });
  assert.equal((await carryLeftovers(dead.d))?.end, "dead");
  assert.equal(dead.kept.size, 0, "dropped");
  assert.equal(dead.cleared.length, 0, "the leftover stays counted");
  // an open carry with nothing sent, past its age: quoted again at what the wallet holds now
  const stale = world({ open: { ...open, sends: [] }, now: 1 + CARRY_UNSENT_MS });
  assert.equal((await carryLeftovers(stale.d))?.end, "landed");
  assert.equal(stale.quoted.length, 1);
});

test("under the vault's least deposit at the device's price, or with no price: nothing is asked, the leftover stays counted for the next pass", async () => {
  for (const worth of [CARRY_VAULT_MIN - 1n, null]) {
    const w = world({ worth });
    assert.equal((await carryLeftovers(w.d))?.end, "under");
    assert.deepEqual(w.log, ["sendable"]);
    assert.equal(w.cleared.length, 0);
  }
});

test("a refused quote, an address off the chain, or an open record that cannot be written: nothing is sent and nothing cleared", async () => {
  for (const o of [{ quote: { error: "quote_check_failed" as const } }, { quote: { address: "NotAnEvmAddress" } }]) {
    const w = world(o);
    assert.equal((await carryLeftovers(w.d))?.end, "refused");
    assert.ok(!w.log.includes("send"));
    assert.equal(w.kept.size, 0);
  }
  const w = world({ keepFails: true });
  assert.equal((await carryLeftovers(w.d))?.end, "fault");
  assert.ok(!w.log.includes("send"));
});

test("the sources: a U_X's newest op ended in the pool or short with money left, and each W tail; never one still followed in the pool, one with nothing left, or an older op", () => {
  const W = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const B = "0x2222222222222222222222222222222222222222";
  const S = "0x3333333333333333333333333333333333333333";
  const ops = [
    op("in_pool", "5", { final: true }),
    op("in_pool", "5", { chain: "base", u: B }), // still followed
    op("short", "7", { chain: "base", u: S }), // a short plain send on Base
    op("in_pool", "0", { final: true, chain: "solana", u: "SolU" }),
    op("in_pool", "9", { final: true, u: "0x4444444444444444444444444444444444444444", created: 1 }),
    op("in_transit", undefined, { u: "0x4444444444444444444444444444444444444444", created: 2 }), // newer: being followed
  ];
  // an EVM W's tail too (card leftovers-carry-to-cash: the EVM carry writes it when W ends empty or carried)
  const EW = "0x6666666666666666666666666666666666666666";
  const tails = [
    { chain: "sol", address: W, l: "3", j: 1, amount: "2345678" },
    { chain: "sol", address: "W0", l: "3", j: 2, amount: "0" },
    { chain: "robinhood", address: EW, l: "5", j: 0, amount: "900000000000000" },
    { chain: "evm", address: EW, l: "5", j: 1, amount: "9" }, // no pool chain: not a record
  ];
  assert.deepEqual(leftoverSources(ops, tails), [
    { chain: "robinhood", kind: "ux", address: U, s: "7", i: 3 },
    { chain: "base", kind: "ux", address: S, s: "7", i: 3 },
    { chain: "solana", kind: "w", address: W, l: "3", j: 1 },
    { chain: "robinhood", kind: "w", address: EW, l: "5", j: 0 },
  ]);
  // the open record's key: under meta owed/ (never listed to the frame), one segment
  assert.match(carryOpenKey({ chain: "solana", address: W }), /^owed\/[^/]+$/);
});

test("a short deposit's money is counted in the balance as soon as its follow writes it (Base's \"Short deposit\" leftovers)", () => {
  const list = (v: unknown) => depositWalletsOf([v], () => 18, () => "ETH");
  assert.deepEqual(list(op("short", "400000000000000", { chain: "base" })), [{ chain: "base", address: U, asset: "ETH", amount: "0.0004" }]);
  assert.deepEqual(list(op("short", undefined, { chain: "base" })), []);
});

test("a wallet whose carry is open is followed first, whatever the draw", async () => {
  const other = "0x5555555555555555555555555555555555555555";
  const open: CarryOpen = { to: DEPOSIT, amount: "5", quote: "carry/robinhood/x", quotedMs: "1", sends: [{ hash: "0xaa", value: "5", sentMs: "2", nonce: "4" }] };
  const w = world({ open, ends: ["pending"], ops: [op("in_pool", "9", { final: true, u: other, created: 1 }), op("in_pool", LEFT.toString(), { final: true, created: 2 })] });
  const d = { ...w.d, draw: (n: number) => n - 1 };
  assert.equal((await carryLeftovers({ ...d, draw: () => 0 }))?.src.address, U);
});

test("worth at the device's price: SOL at 73.8 USD, ETH at 1919 USD; none with no price", () => {
  assert.equal(worthUsdc({ price: "7380000000", expo: -8 }, 1_000_000n, 9), 73_800n);
  assert.equal(worthUsdc({ price: "191900000000", expo: -8 }, LEFT, 18), 1_907_677n);
  assert.equal(worthUsdc(null, 1n, 9), null);
});

test("cleared where counted: the U_X's newest op's left set to 0 in the wallet's own store, a W's tail record deleted", async () => {
  const { IDBFactory } = await import("fake-indexeddb");
  const { openWalletStore } = await import("@blindfill/wallet/store");
  const st = await openWalletStore({ indexedDB: new IDBFactory() });
  try {
    await st.put("ops", "a", op("in_pool", "5", { final: true, created: 1 }));
    await st.put("ops", "b", op("in_pool", LEFT.toString(), { final: true, created: 2 }));
    await clearLeftover(st, { chain: "robinhood", kind: "ux", address: U, s: "7", i: 3 });
    assert.equal(((await st.get("ops", "b")) as { follow: { left: string } }).follow.left, "0");
    assert.equal(((await st.get("ops", "a")) as { follow: { left: string } }).follow.left, "5", "an older op as it was");
    const W = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    await st.update("meta", `w-tail/sol/${W}`, () => ({ chain: "sol", address: W, l: "3", j: 1, amount: "7" }));
    await clearLeftover(st, { chain: "solana", kind: "w", address: W, l: "3", j: 1 });
    assert.equal(await st.get("meta", `w-tail/sol/${W}`), undefined);
    // an EVM W's tail under its chain's name
    const EW = "0x6666666666666666666666666666666666666666";
    await st.update("meta", `w-tail/base/${EW}`, () => ({ chain: "base", address: EW, l: "5", j: 0, amount: "7" }));
    await clearLeftover(st, { chain: "base", kind: "w", address: EW, l: "5", j: 0 });
    assert.equal(await st.get("meta", `w-tail/base/${EW}`), undefined);
    // the open carry's key is one the store takes, and its write moves no seed
    await st.put("meta", carryOpenKey({ chain: "solana", address: W }), { to: "x" });
  } finally {
    st.close();
  }
});

test("main.ts runs the carry after the moves resume, one tab's pass at a time, stopped by the sign out", async () => {
  const main = (await import("node:fs")).readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /\.then\(\(\) => resumeMoves\?\.\(\)\)\s*\.catch\(\(\) => \{\}\)\s*(?:\/\/[^\n]*\n\s*)?\.then\(\(\) => void carryLoop\?\.\(\)\.catch\(\(\) => \{\}\)\)/);
  assert.match(main, /locks\.request\("ct-carry-cash", \{ ifAvailable: true \}/);
  assert.match(main, /const signal = withdrawWait\.signal;\s*const sol = /);
  assert.match(main, /sources: async \(\) => leftoverSources\(await pageOps\(\)\.catch\(\(\) => \[\]\), await pageTails\(\)\.catch\(\(\) => \[\]\)\)/);
  // the wait between passes never holds a process open: main.ts booted in a test (held-lock.test.ts) exits (it hung at
  // 6f2c48fae)
  assert.match(main, /const t = setTimeout\(ok, ms\);\s*\(t as unknown as \{ unref\?: \(\) => void \}\)\.unref\?\.\(\);/);
});
