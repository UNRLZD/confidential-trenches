// A plain send's remainder (card deposit-takes-each-pools-own-coin, review P1): only whole rungs go into a pool, so a
// send to U_X that is not a sum of rungs leaves the rest at U_X. U_X stays named while it holds that (deposit-name.ts
// `held`, pool-deposit-follow.ts uxHeld), so the next pool.address names the same U_X, the next send tops it up and its
// follow carries both. Before: the namer moved to the next index once money reached U_X, and the rest stayed for good.
// On fake-indexeddb with the wallet's real store and note store and the published all-zero entropy vector.
//   node --test test/deposit-pool-remainder.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { depositNamer } from "../src/deposit-name.ts";
import { followPoolQuote, uxHeld } from "../src/pool-deposit-follow.ts";
import { POOL_DEPOSIT_DESTINATION } from "../../wallet/src/deposit/quote.ts";
import { SOL_LADDER } from "../../wallet/src/pool/solana.ts";
import { ladderSplit } from "../../wallet/src/pool/ladder.ts";

const ENTROPY = () => new Uint8Array(16); // the published all-zero vector (packages/wallet/test/vectors/a8.json)
const SCOPE = 91n;
// one deposit's worst-case cost a rung and the rent U_X keeps (the card test's), the floor of one deposit
const PER = 2_936_160n, KEEP = 650_240n, FLOOR = SOL_LADDER.min + PER + KEEP;

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

/** U_X as a ledger: a deposit of `amount` in n rungs takes amount + n x PER from it (the worst case, the least left). */
function ledger(start: bigint) {
  let bal = start;
  const deposits: bigint[] = [];
  const reads = { balances: async () => [bal, bal] as const, costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }) };
  const follow = (deadlinePastAfter: number) => {
    let rounds = 0;
    const ac = new AbortController();
    const stages: string[] = [];
    const deps: Parameters<typeof followPoolQuote>[1] = {
      ...reads,
      status: async () => {
        throw new Error("1Click asked");
      },
      ladder: SOL_LADDER,
      deposit: async (_f, amount) => {
        bal -= amount + BigInt(ladderSplit(SOL_LADDER, amount).notes.length) * PER;
        deposits.push(amount);
        return { end: "filled", txs: [] };
      },
      open: async () => false,
      noted: async () => deposits.length > 0,
      past: async () => rounds >= deadlinePastAfter,
      stage: async (s) => void stages.push(s),
      sleep: async () => {
        if (++rounds > 50) ac.abort();
      },
      signal: ac.signal,
    };
    return { deps, stages };
  };
  return { reads, follow, send: (v: bigint) => void (bal += v), deposits, left: () => bal };
}

async function signedIn(): Promise<{ w: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: ENTROPY(), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  return { w, ns };
}
const recordOf = async (w: WalletStore) => (await w.get("meta", `deposit/${SCOPE}`)) as { index: number; id: string };
const PLAIN = (i: number, u: string) => ({ chain: "solana" as const, s: SCOPE.toString(), i, u, refund_id: "ab".repeat(32), address: u, deadline_ms: 1, origin: POOL_DEPOSIT_DESTINATION.solana, min_out: FLOOR.toString() });

test("a plain send's remainder keeps its U_X named: the next send to it tops it up and its follow carries both", async () => {
  const { w, ns } = await signedIn();
  const x = ledger(0n);
  const asked: { chain: string; index: number }[] = [];
  const namer = depositNamer({
    top: true, scope: () => null, pools: () => [{ chain: "solana", scope: SCOPE }], open: async () => w, startup: () => Promise.resolve(), resyncing: () => null,
    held: async (chain, rec) => (asked.push({ chain, index: rec.index }), uxHeld(x.reads, { chain, s: rec.scope, i: rec.index, u: "U_X", refund_id: rec.id })),
  });
  namer.name(ENTROPY());
  await namer.named();
  const first = await recordOf(w);

  // 0.023586399 SOL sent: one 0.01 rung goes in, 10,650,239 lamports stay at U_X (more than one deposit's cost and the rent)
  x.send(23_586_399n);
  const one = x.follow(3);
  assert.equal(await followPoolQuote(PLAIN(first.index, "U_X"), one.deps), "in_pool");
  assert.deepEqual(x.deposits, [10_000_000n]);
  assert.equal(x.left(), 10_650_239n);
  assert.equal(await uxHeld(x.reads, { chain: "solana", s: SCOPE.toString(), i: first.index, u: "U_X", refund_id: first.id }), true);

  // money reached the index (its note left PLANNED): the namer reads U_X still holding it and keeps it named
  const planned = (await ns.list()).find((n) => n.ref.kind === "deposit" && n.state === "PLANNED")!;
  await ns.move(planned.id, "PLANNED", "INCOMING");
  namer.name(ENTROPY());
  await namer.named();
  assert.deepEqual(await recordOf(w), first, "the next pool.address names the same U_X");
  assert.deepEqual(asked, [{ chain: "solana", index: first.index }]);

  // the next send, one floor, to that U_X: its follow carries it with the remainder, one 0.02 rung (one floor alone
  // makes a 0.01), and what is left is under one deposit's cost over the rent: no longer held
  x.send(FLOOR);
  const two = x.follow(3);
  assert.equal(await followPoolQuote(PLAIN(first.index, "U_X"), two.deps), "in_pool");
  assert.deepEqual(x.deposits, [10_000_000n, 20_000_000n]);
  assert.equal(x.left(), 10_650_239n + FLOOR - 20_000_000n - PER);
  assert.ok(x.left() <= KEEP + PER);
  assert.deepEqual(two.stages, ["in_transit", "in_pool"]);

  // so the namer moves on to the next index, never the funded one again
  namer.name(ENTROPY());
  await namer.named();
  const next = await recordOf(w);
  assert.ok(next.index > first.index && next.id !== first.id);
});

test("a held read that fails keeps the U_X named (no money left where nothing names it); a pool with no held moves on", async () => {
  for (const [held, stays] of [[async () => Promise.reject(new Error("rpc down")), true], [undefined, false]] as const) {
    const { w, ns } = await signedIn();
    const namer = depositNamer({ top: true, scope: () => null, pools: () => [{ chain: "solana", scope: SCOPE }], open: async () => w, startup: () => Promise.resolve(), resyncing: () => null, ...(held ? { held } : {}) });
    namer.name(ENTROPY());
    await namer.named();
    const first = await recordOf(w);
    const planned = (await ns.list()).find((n) => n.ref.kind === "deposit" && n.state === "PLANNED")!;
    await ns.move(planned.id, "PLANNED", "INCOMING");
    namer.name(ENTROPY());
    await namer.named();
    assert.equal((await recordOf(w)).index === first.index, stays);
  }
});

test("the vault's U is never held: a funded vault index is never named again (W:355-358)", async () => {
  const { w, ns } = await signedIn();
  let asked = 0;
  const namer = depositNamer({ top: true, scope: () => SCOPE, open: async () => w, startup: () => Promise.resolve(), resyncing: () => null, held: async () => (asked++, true) });
  namer.name(ENTROPY());
  await namer.named();
  const first = await recordOf(w);
  const planned = (await ns.list()).find((n) => n.ref.kind === "deposit" && n.state === "PLANNED")!;
  await ns.move(planned.id, "PLANNED", "INCOMING");
  namer.name(ENTROPY());
  await namer.named();
  assert.ok((await recordOf(w)).index > first.index);
  assert.equal(asked, 0);
});

// ------------------------------------------------------------------ review P2-b, P3-a, P3-b: the follow of a plain send
const { poolFollows, poolFollowEnded } = await import("../src/pool-deposit-follow.ts");
type Round = { bal: readonly [bigint, bigint]; chain?: readonly [bigint, bigint]; past?: boolean };
/** A follow whose reads go round by round (each deposit fills; the balances are the round's). */
function rounds(list: Round[]) {
  const stages: string[] = [], deposits: bigint[] = [];
  let k = 0, chainReads = 0;
  const ac = new AbortController();
  const now = () => list[Math.min(k, list.length - 1)]!;
  const deps: Parameters<typeof followPoolQuote>[1] = {
    status: async () => {
      throw new Error("1Click asked");
    },
    balances: async () => now().bal,
    ...(list.some((r) => r.chain) ? { chainBalances: async () => (chainReads++, now().chain ?? now().bal) } : {}),
    costs: async () => ({ floor: FLOOR, perRung: PER, keep: KEEP }),
    ladder: SOL_LADDER,
    deposit: async (_f, amount) => (deposits.push(amount), { end: "filled", txs: [] }),
    open: async () => false,
    noted: async () => false,
    past: async () => now().past === true,
    stage: async (s) => void stages.push(s),
    sleep: async () => {
      if (++k >= list.length + 3) ac.abort();
    },
    signal: ac.signal,
  };
  return { deps, stages, deposits, chainReads: () => chainReads };
}

test("P3-a: a plain op counts only money over U_X's balance as it began: a neighbour's money there is carried, never shown as this send", async () => {
  // U_X held one floor of another op's as this quote was asked (its base); that is carried, the op stays unpaid and
  // shows expired past its deadline; the user's own late send is then shown in_transit and in_pool
  const w = rounds([
    { bal: [FLOOR, FLOOR] },
    { bal: [KEEP, KEEP], past: true },
    { bal: [KEEP + FLOOR, KEEP + FLOOR], past: true },
    { bal: [KEEP, KEEP], past: true },
  ]);
  assert.equal(await followPoolQuote({ ...PLAIN(3, "U_X"), base: FLOOR.toString() }, w.deps), "in_pool");
  assert.deepEqual(w.deposits, [SOL_LADDER.min, SOL_LADDER.min]);
  assert.deepEqual(w.stages, ["expired", "in_transit", "in_pool"]);
});

test("P3-a: money under the floor that was there before the op began is not short", async () => {
  const w = rounds([{ bal: [5_000_000n, 5_000_000n] }, { bal: [5_000_000n, 5_000_000n], past: true }]);
  assert.equal(await followPoolQuote({ ...PLAIN(3, "U_X"), base: "5000000" }, w.deps), "expired");
  assert.deepEqual(w.stages, ["expired"]);
});

test("P3-b: past its deadline, a plain op whose pool RPCs read money at U_X (one reader read none) is not shown expired until they read none", async () => {
  const w = rounds([
    { bal: [0n, 0n], chain: [0n, FLOOR], past: true },
    { bal: [0n, 0n], chain: [0n, FLOOR], past: true },
    { bal: [0n, 0n], chain: [0n, 0n], past: true },
    { bal: [FLOOR, FLOOR], past: true },
    { bal: [0n, 0n], past: true },
  ]);
  assert.equal(await followPoolQuote(PLAIN(3, "U_X"), w.deps), "in_pool");
  assert.deepEqual(w.stages, ["expired", "in_transit", "in_pool"]);
  // read while they read money, then once more where they read none; never again after expired
  assert.equal(w.chainReads() >= 3, true);
});

function opsStore() {
  const rows = new Map<string, unknown>();
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
const ENDED = (u: string, created_ms: number) => ({ kind: "pool_deposit", stage: "in_pool", txs: [], created_ms, final: true, follow: PLAIN(3, u) });

test("P2-b: a send to an ended op's U_X that covers a floor is followed again at the next settle and carried in", async () => {
  const { rows, store } = opsStore();
  rows.set("old", ENDED("U_X", 1));
  rows.set("newer", ENDED("U_X", 2));
  rows.set("other", ENDED("U_Y", 3));
  // U_X then reads one floor (a send after its op ended); U_Y reads nothing
  const x = rounds([{ bal: [FLOOR, FLOOR], past: true }, { bal: [KEEP, KEEP], past: true }]);
  const y = rounds([{ bal: [0n, 0n], past: true }]);
  const read: string[] = [];
  const host = poolFollows({
    store: async () => store,
    deps: (f) => {
      const d = f.u === "U_X" ? x.deps : y.deps;
      return { ...d, balances: async (g) => (read.push(g.u), d.balances(g)) };
    },
    decimals: () => 9,
    locks: () => null,
    now: () => 5,
  });
  await host.settle();
  await host.idle();
  // each U_X read once; the newest op of U_X followed again, carried, and ended again; U_Y's left as it was
  assert.deepEqual(x.deposits, [SOL_LADDER.min]);
  assert.ok(poolFollowEnded(rows.get("newer") as never));
  assert.ok(poolFollowEnded(rows.get("old") as never));
  assert.deepEqual(y.deposits, []);
  assert.deepEqual(read.filter((u) => u === "U_Y"), ["U_Y"]);
});

test("P2-b: an ended op whose U_X another op still follows is not followed again (that follow carries it)", async () => {
  const { rows, store } = opsStore();
  rows.set("old", ENDED("U_X", 1));
  rows.set("live", { kind: "pool_deposit", stage: "quote_checked", txs: [], created_ms: 2, follow: PLAIN(3, "U_X") });
  const x = rounds([{ bal: [0n, 0n] }]);
  const host = poolFollows({ store: async () => store, deps: () => x.deps, decimals: () => 9, locks: () => null, now: () => 5 });
  await host.settle();
  host.stop();
  await host.idle();
  assert.ok(poolFollowEnded(rows.get("old") as never), "the ended op stays ended");
});
