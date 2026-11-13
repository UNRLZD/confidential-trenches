// The delta review of card deposit-takes-each-pools-own-coin (b420b177b..23f2840ec):
// - P2-a: whether a U_X still holds money is read from the store, never the chain: the namer runs at every note change
//   (a buy's and a sell's too), and a read naming U_X then would tie U_X to W. The follow's end writes what it left and
//   one deposit's cost on the op (uxHeldOf reads them).
// - P2-b: settle's reads of ended U_X go one U_X at a time, after the host's drawn wait, on the host's paced reads.
// - P2-c: a plain send's base is read before its address goes out; a base read after it could swallow a send.
// - P3-b: on Solana (no chainBalances), the higher of the pair is read before a plain send shows expired.
//   node --test test/deposit-pool-delta.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { POOL_DEPOSIT_DESTINATION } from "../../wallet/src/deposit/quote.ts";
import { SOL_LADDER } from "../../wallet/src/pool/solana.ts";
import { ladderSplit } from "../../wallet/src/pool/ladder.ts";

const m = (await import("../src/pool-deposit-follow.ts")) as typeof import("../src/pool-deposit-follow.ts") & Record<string, unknown>;
const { followPoolQuote, poolFollows, poolFollowEnded } = m;
// new in this delta: read off the module, so a test of an old build fails on its behaviour, not on an import
const uxHeldOf = (...a: unknown[]): boolean => (m.uxHeldOf as (...x: unknown[]) => boolean)(...a);

// one deposit's worst-case cost a rung and the rent U_X keeps (the card test's), the floor of one deposit
const PER = 2_936_160n, KEEP = 650_240n, FLOOR = SOL_LADDER.min + PER + KEEP;
const SOL = POOL_DEPOSIT_DESTINATION.solana;
const PLAIN = (u: string) => ({ chain: "solana" as const, s: "91", i: 3, u, refund_id: "ab".repeat(32), address: u, deadline_ms: 1, origin: SOL, min_out: FLOOR.toString() });
const QUOTE = (u: string) => ({ deposit_address: u, origin_asset: SOL, min_amount_out: "0.013587", deadline: new Date(10_000).toISOString() });
const UX = (u: string) => ({ scope: 91n, index: 3, wallet: u, refundId: "ab".repeat(32) });
type Deps = Parameters<typeof followPoolQuote>[1];

function opsStore() {
  const rows = new Map<string, any>();
  return {
    rows,
    store: {
      get: async (_s: "ops", k: string) => rows.get(k),
      keys: async () => [...rows.keys()],
      update: async (_s: "ops", k: string, change: (v: unknown) => unknown) => {
        const v = change(rows.get(k));
        if (v !== undefined) rows.set(k, v);
        return rows.get(k);
      },
    },
  };
}
const reads = (over: Partial<Deps>): Omit<Deps, "stage" | "signal" | "txs"> => ({
  status: async () => {
    throw new Error("1Click asked");
  },
  balances: async () => [0n, 0n] as const,
  costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }),
  ladder: SOL_LADDER,
  deposit: async () => ({ end: "filled", txs: [] }),
  open: async () => false,
  noted: async () => false,
  past: async () => true,
  sleep: async () => {},
  ...over,
});

test("P2-a: a follow's end writes what it left at U_X and one deposit's cost; uxHeldOf decides from the newest op alone", async () => {
  const { rows, store } = opsStore();
  // U_X as a ledger: 0.023586399 SOL sent; one 0.01 rung goes in, 10,650,239 lamports stay
  let bal = 0n, rounds = 0;
  const host: ReturnType<typeof poolFollows> = poolFollows({
    store: async () => store,
    deps: () =>
      reads({
        // bounded: a follow that never ends (an old build's late base) stops after 50 rounds
        sleep: async () => void (++rounds > 50 && host.stop()),
        balances: async () => [bal, bal] as const,
        deposit: async (_f, amount) => ((bal -= amount + BigInt(ladderSplit(SOL_LADDER, amount).notes.length) * PER), { end: "filled", txs: [] }),
        noted: async () => true,
      }),
    decimals: () => 9,
    locks: () => null,
    now: () => 5,
  });
  await host.quoted("op", "solana", QUOTE("U_X"), UX("U_X"));
  bal = 23_586_399n;
  await host.idle();
  const op = rows.get("op");
  assert.ok(poolFollowEnded(op));
  assert.equal(op.follow.left, "10650239");
  assert.equal(op.follow.cost, (KEEP + PER).toString());
  assert.equal(uxHeldOf([...rows.values()], "solana", "U_X"), true);
  // the same U_X on another chain, or another U_X: no op, not held
  assert.equal(uxHeldOf([...rows.values()], "base", "U_X"), false);
  assert.equal(uxHeldOf([...rows.values()], "solana", "U_Y"), false);
  // an op still followed holds it; the newest op decides; an end that left at most one deposit's cost does not hold it
  const later = (o: object, created_ms: number) => ({ ...op, created_ms, ...o });
  assert.equal(uxHeldOf([op, later({ stage: "quote_checked", final: undefined }, 9)], "solana", "U_X"), true);
  assert.equal(uxHeldOf([op, later({ follow: { ...op.follow, left: (KEEP + PER).toString() } }, 9)], "solana", "U_X"), false);
  assert.equal(uxHeldOf([later({ follow: { ...op.follow, left: (KEEP + PER).toString() } }, 0), op], "solana", "U_X"), true);
  // an op of an earlier release (no left written) does not hold it
  assert.equal(uxHeldOf([later({ follow: PLAIN("U_X") }, 9)], "solana", "U_X"), false);
});

test("P2-a: an end with nothing at U_X writes 0 and reads no costs; an end over 0 with no costs read this follow reads them once", async () => {
  for (const [bal, costsRead, left] of [[0n, 0, "0"], [5_000_000n, 1, "5000000"]] as const) {
    const { rows, store } = opsStore();
    rows.set("op", { kind: "pool_deposit", stage: "in_pool", txs: [], created_ms: 1, follow: { ...PLAIN("U_X"), base: bal.toString() } });
    let costs = 0;
    const host = poolFollows({
      store: async () => store,
      deps: () => reads({ balances: async () => [bal, bal] as const, costs: async () => (costs++, { floor: FLOOR, perRung: PER, keep: KEEP }) }),
      decimals: () => 9,
      locks: () => null,
      now: () => 5,
    });
    await host.settle();
    await host.idle();
    assert.equal(rows.get("op").follow.left, left);
    assert.equal(costs, costsRead);
  }
});

test("P2-b: settle reads each ended U_X one at a time, after the host's wait, on the host's paced reads", async () => {
  const { rows, store } = opsStore();
  for (const [k, u] of [["a", "U_A"], ["b", "U_B"], ["c", "U_C"], ["d", "U_D"]] as const) rows.set(k, { kind: "pool_deposit", stage: "in_pool", txs: [], created_ms: 1, final: true, follow: PLAIN(u) });
  let inFlight = 0, most = 0, waited = 0, followReads = 0;
  const order: string[] = [];
  const host = poolFollows({
    store: async () => store,
    deps: () => reads({ balances: async () => (followReads++, [0n, 0n] as const) }),
    again: () => ({
      balances: async (f) => {
        assert.ok(waited >= 1, "the wait comes first");
        order.push(f.u);
        most = Math.max(most, ++inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return [0n, 0n] as const;
      },
      costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }),
      ladder: SOL_LADDER,
    }),
    againWait: async () => void waited++,
    decimals: () => 9,
    locks: () => null,
    now: () => 5,
  } as Parameters<typeof poolFollows>[0]);
  await host.settle();
  // a second landing while the run reads: no second run beside it
  await host.settle();
  await host.idle();
  assert.equal(most, 1);
  assert.deepEqual(order.slice(0, 4).sort(), ["U_A", "U_B", "U_C", "U_D"]);
  assert.equal(followReads, 0, "never the follow's own burst reads");
});

test("P2-b: at a landing, an ended op past POOL_AGAIN_FOR_MS whose end left nothing is not read again, one that left money is; at a page load, every one is", async () => {
  const FOR = m.POOL_AGAIN_FOR_MS as number;
  assert.equal(typeof FOR, "number");
  const { rows, store } = opsStore();
  rows.set("old", { kind: "pool_deposit", stage: "in_pool", txs: [], created_ms: 1, final: true, follow: { ...PLAIN("U_OLD"), left: "0", cost: (KEEP + PER).toString() } });
  rows.set("kept", { kind: "pool_deposit", stage: "in_pool", txs: [], created_ms: 1, final: true, follow: { ...PLAIN("U_KEPT"), left: "9000000", cost: (KEEP + PER).toString() } });
  const read: string[] = [];
  const host = poolFollows({
    store: async () => store,
    deps: () => reads({}),
    again: () => ({ balances: async (f) => (read.push(f.u), [0n, 0n] as const), costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }), ladder: SOL_LADDER }),
    decimals: () => 9,
    locks: () => null,
    now: () => 2 + FOR,
  } as Parameters<typeof poolFollows>[0]);
  await host.settle();
  await host.idle();
  assert.deepEqual(read, ["U_KEPT"]);
  // a page load reads every ended U_X, old ones too: a late send to an old address is found at the next load
  read.length = 0;
  await (host.settle as (o?: { load?: boolean }) => Promise<void>)({ load: true });
  await host.idle();
  assert.deepEqual(read.sort(), ["U_KEPT", "U_OLD"]);
});

test("P2-c: a plain send's base is read before its address goes out: a send that lands while the page is closed shows short", async () => {
  const { rows, store } = opsStore();
  let bal = 0n, failing = false, stopAt = 0, sleeps = 0;
  let host!: ReturnType<typeof poolFollows>;
  host = poolFollows({
    store: async () => store,
    deps: () =>
      reads({
        balances: async () => {
          if (failing) throw new Error("429");
          return [bal, bal] as const;
        },
        past: async () => false,
        sleep: async () => {
          if (++sleeps >= stopAt) host.stop();
        },
      }),
    decimals: () => 9,
    locks: () => null,
    now: () => 5,
  });
  // the base is read (0) as the address is checked; the follow's own reads then fail and the tab closes
  stopAt = 2;
  await host.quoted("op", "solana", QUOTE("U_X"), UX("U_X"));
  failing = true;
  await host.idle();
  assert.equal(rows.get("op").follow.base, "0");
  // the user's send lands while the page is closed: under one floor, it waits at U_X for a top-up
  bal = FLOOR - 1n;
  failing = false;
  stopAt = sleeps + 3;
  await host.settle();
  await host.idle();
  assert.equal(rows.get("op").follow.base, "0");
  assert.equal(rows.get("op").stage, "short");
});

test("P2-c: a base read that fails refuses the address (the op is not written, so pool.address answers down)", async () => {
  const { rows, store } = opsStore();
  // a follow that would start reads at most a few rounds (an old build writes the op and follows it)
  let rounds = 0;
  const failing = () => reads({ balances: async () => Promise.reject(new Error("429")), status: async () => null, sleep: async () => void (++rounds > 5 && (host.stop(), h2.stop())) });
  const host = poolFollows({ store: async () => store, deps: failing, decimals: () => 9, locks: () => null, now: () => 5 });
  await assert.rejects(host.quoted("op", "solana", QUOTE("U_X"), UX("U_X")));
  assert.equal(rows.has("op"), false);
  // a 1Click quote's address reads no base
  const { rows: r2, store: s2 } = opsStore();
  const h2 = poolFollows({ store: async () => s2, deps: failing, decimals: () => 9, locks: () => null, now: () => 5 });
  await h2.quoted("op", "solana", QUOTE("1Click-address"), UX("U_X"));
  h2.stop();
  await h2.idle();
  assert.equal(r2.get("op").follow.base, undefined);
});

test("P3-b: on Solana, one RPC lagging at 0 is no expired plain send: the higher balance is read first", async () => {
  // past the deadline, the pair reads [0, FLOOR - 1] (the first lags): not expired; then [FLOOR - 1, FLOOR - 1]: short
  const list: (readonly [bigint, bigint])[] = [[0n, FLOOR - 1n], [0n, FLOOR - 1n], [FLOOR - 1n, FLOOR - 1n]];
  let k = 0;
  const stages: string[] = [];
  const ac = new AbortController();
  await followPoolQuote({ ...PLAIN("U_X"), base: "0" }, {
    ...reads({
      balances: async () => list[Math.min(k, list.length - 1)]!,
      past: async () => true,
      sleep: async () => {
        if (++k > list.length) ac.abort();
      },
    }),
    stage: async (s) => void stages.push(s),
    signal: ac.signal,
  });
  assert.deepEqual(stages, ["short"]);
});

// ------------------------------------- state.deposit_wallets: what a follow left at U_X, listed until a carry takes it
test("deposit_wallets: a U_X remainder is listed; a top-up reopens its op (none listed while followed); the carry's end lists only what is left", async () => {
  const depositWalletsOf = m.depositWalletsOf as (ops: readonly unknown[], d: (c: string) => number, a: (c: string) => string) => { chain: string; address: string; asset: string; amount: string }[];
  assert.equal(typeof depositWalletsOf, "function", "the page lists no deposit wallet");
  const { withDepositWallets } = (await import("../src/pools.ts")) as Record<string, any>;
  const { signedOutState } = await import("../src/api.ts");
  const list = (rows: Map<string, unknown>) => depositWalletsOf([...rows.values()], () => 9, () => "SOL");
  const { rows, store } = opsStore();
  let bal = 0n, rounds = 0;
  const carried: bigint[] = [];
  const host: ReturnType<typeof poolFollows> = poolFollows({
    store: async () => store,
    deps: () =>
      reads({
        sleep: async () => void (++rounds > 50 && host.stop()),
        balances: async () => [bal, bal] as const,
        deposit: async (_f, amount) => ((bal -= amount + BigInt(ladderSplit(SOL_LADDER, amount).notes.length) * PER), carried.push(amount), { end: "filled", txs: [] }),
        noted: async () => true,
      }),
    again: () => ({ balances: async () => [bal, bal] as const, costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }), ladder: SOL_LADDER }),
    decimals: () => 9,
    locks: () => null,
    now: () => 5,
  } as Parameters<typeof poolFollows>[0]);
  // nothing ended yet: none listed
  await host.quoted("op", "solana", QUOTE("U_X"), UX("U_X"));
  assert.deepEqual(list(rows), []);
  bal = 23_586_399n;
  await host.idle();
  // the end left 10,650,239 lamports at U_X: listed, and the 0.01 SOL carried is the pool's, not here
  assert.deepEqual(carried, [SOL_LADDER.min]);
  assert.deepEqual(list(rows), [{ chain: "solana", address: "U_X", asset: "SOL", amount: "0.010650239" }]);
  const st = withDepositWallets({ ...signedOutState(), signed_in: true, way: "words", code_saved: true }, list(rows));
  assert.deepEqual(st.deposit_wallets, [{ chain: "solana", address: "U_X", asset: "SOL", amount: "0.010650239" }], "the state carries it (the kit's schema takes it)");
  assert.equal(withDepositWallets(signedOutState(), list(rows)).deposit_wallets, undefined, "signed out: none");
  // a top-up of one floor lands at U_X; the next landing's settle reopens the op: while it is followed, none is listed
  bal += FLOOR;
  let seenWhileFollowed: unknown[] | null = null;
  const before = store.update;
  store.update = async (s, k, change) => {
    const r = await before(s, k, change);
    const v = rows.get(k) as { final?: true };
    if (v.final !== true && seenWhileFollowed === null) seenWhileFollowed = list(rows);
    return r;
  };
  await host.settle();
  await host.idle();
  assert.deepEqual(seenWhileFollowed, [], "a U_X followed again is listed nowhere but its op");
  // its end: both carried as one 0.02 rung; what is left (under one deposit's cost over the rent, still over 0) listed
  assert.deepEqual(carried, [SOL_LADDER.min, 20_000_000n]);
  const left = 10_650_239n + FLOOR - 20_000_000n - PER;
  assert.ok(left > 0n && left <= KEEP + PER);
  assert.deepEqual(list(rows), [{ chain: "solana", address: "U_X", asset: "SOL", amount: (Number(left) / 1e9).toString() }]);
});
