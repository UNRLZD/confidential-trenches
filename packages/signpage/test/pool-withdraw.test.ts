// Card signpage-pool-withdraw-form: a pool withdraw sends exactly the typed amount to the typed address, each part two
// transactions (the release alone to W, then W's own transfer of all it holds less its fee to To), proved on demand
// from a note of the pool, checked and signed on this page, RESERVED before the release leaves, and sent only once
// every part's onward send read back on both RPCs (src/pool-withdraw.ts).
// The seed is the published all-zero entropy vector (packages/wallet/test/vectors/a8.json); the Rent sysvar is the
// kit's recorded answer of both providers (packages/kit/test/fixtures/solana-pool-buy.json).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore } from "@blindfill/wallet/store";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { VAULT_FIELD_P, vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { solanaDecodePoolRelease, solanaEncodePoolTag3, solanaPoolFee, solanaPoolPage, solanaRentMin } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { solanaDecodeMessage } from "../../kit/src/checks/solana/message.ts";
import { keepOutNotes, keptOutNotes, mergeWithdrawOp } from "../src/pool-testnet.ts";
import { openProofQueue } from "../../wallet/src/pool/queue.ts";
import { SOLANA_SYSTEM_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { SOL_EPOCH_MS, SOL_LADDER, SOL_LAG_WAIT_MS, SOL_LIFE_MS, SOL_REACH_WAITS, SOL_SEND_MARGIN_MS, solanaContextOf, solanaPageOf, solanaPoolOf, solanaTreeSync, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";
import { BLOCKHASH, FEE_PAYER, POOL, PROGRAM, fx, rent } from "../../kit/test/solana-pool-buy-fx.ts";
import { buildSolanaPoolBuy, type SolanaPoolRelease } from "../../kit/src/trade/solana/pool-buy.ts";
import { cfg as BUY_CFG, release as BUY_RELEASE, setup as buySetup, W as BUY_W } from "../../kit/test/solana-pool-buy-fx.ts";
import { keysOf } from "../src/pool-spend.ts";
import { finishPoolOnward, HISTORY_PAGE, spendOwner, HISTORY_PASS, type HistoryPlaces, nearestPlannable, type PendingOnward, planPoolWithdraw, poolWithdrawable, runPoolWithdraw, WITHDRAW_BOUNDARY_LAG_MS, solanaWithdrawMinPart, withdrawNoteFloor, type PoolWithdrawHost, type WithdrawCosts } from "../src/pool-withdraw.ts";
import type { PoolAsk } from "../src/rules/pool.ts";
import { POOL_BUY_READS, POOL_BUY_SETTLE_MS } from "../src/pool-buy.ts";
import { ASK, C, COST, FEE, FINAL_SLOT, FLOOR, MIN, NOW, SCOPE, SEED64, SIG, TO, W_FEE, closers, lamportsOf, read, world } from "./pool-withdraw-world.ts";


test("the min part: rent(0), and the relay fee less W's fee where that is more (the 2 x fee backstop); no tip cap", () => {
  const r0 = solanaRentMin(rent, 0);
  assert.equal(MIN, FEE - W_FEE > r0 ? FEE - W_FEE : r0);
  assert.equal(solanaWithdrawMinPart(rent, 0n, 0n), r0);
  assert.equal(solanaWithdrawMinPart(rent, r0 + 10n * W_FEE, W_FEE), r0 + 9n * W_FEE);
});

test("the plan: the typed amount exactly, the fewest parts, each part at least the minimum, each chunk part + fee + W's fee", () => {
  const notes = [{ id: "a", value: 10_000_000n }, { id: "b", value: 30_000_000n }, { id: "c", value: COST + MIN - 1n }];
  // one note pays it: the largest
  assert.deepEqual(planPoolWithdraw(notes, 5_000_000n, C), [{ noteId: "b", part: 5_000_000n, chunk: 5_000_000n + COST }]);
  // two notes: one gives all it can, the other the rest, the sum exact
  const two = planPoolWithdraw(notes, 30_000_000n, C)!;
  assert.deepEqual(two.map((p) => p.noteId).sort(), ["a", "b"]);
  assert.equal(two.reduce((t, p) => t + p.part, 0n), 30_000_000n);
  two.forEach((p) => assert.equal(p.chunk, p.part + COST));
  // the most: every note that gives the minimum, less its two fees; above it, or under the minimum, no plan
  const most = poolWithdrawable(notes, C);
  assert.equal(most, 40_000_000n - 2n * COST);
  assert.notEqual(planPoolWithdraw(notes, most, C), null);
  assert.equal(planPoolWithdraw(notes, most + 1n, C), null);
  assert.equal(planPoolWithdraw(notes, MIN - 1n, C), null);
  assert.equal(planPoolWithdraw([], MIN, C), null);
});

// review #232 HIGH 2: a part that leaves 0 < change < the note floor strands that change in the pool for good
test("the plan never leaves a change between 0 and the note floor: across every amount near a note's top", () => {
  const value = 10_000_000n;
  const cap = value - COST;
  const notes = [{ id: "a", value }];
  for (let amount = cap - FLOOR - 3n; amount <= cap; amount += 1n) {
    const plan = planPoolWithdraw(notes, amount, C);
    const ok = amount === cap || amount <= cap - FLOOR;
    assert.equal(plan !== null, ok, String(amount));
    for (const p of plan ?? []) {
      const change = value - p.chunk;
      assert.ok(change === 0n || change >= FLOOR, `change ${change}`);
    }
  }
  // the one the review found: one lamport under the note's whole withdrawable; refused, the nearest named
  assert.equal(planPoolWithdraw(notes, cap - 1n, C), null);
  assert.deepEqual(nearestPlannable(notes, cap - 1n, C), { below: cap - FLOOR, above: cap });
});

// review #232 LOW: an exact plan where one exists, never the largest-first walk's dead end
test("the plan finds an exact plan the largest-first walk misses, and names the nearest when none exists", () => {
  const u = MIN;
  assert.ok(u < FLOOR, "a unit under the note floor: a change of one unit is dust");
  // [4u, 3u, 3u]: largest first takes 4u, then 2u of a 3u note leaves u of dust; 3u + 3u is exact
  const notes = [{ id: "a", value: 4n * u + COST }, { id: "b", value: 3n * u + COST }, { id: "c", value: 3n * u + COST }];
  const plan = planPoolWithdraw(notes, 6n * u, C)!;
  assert.deepEqual(plan.map((p) => [p.noteId, p.part]), [["b", 3n * u], ["c", 3n * u]]);
  // the review's [5u, u, u] at 6.5u: 4.5u of the 5u note leaves 0.5u, dust under the floor; u notes go whole or not
  // at all; so no plan sends 6.5u without dust, and the nearest each side are named, each one plannable
  const five = [{ id: "a", value: 5n * u + COST }, { id: "b", value: u + COST }, { id: "c", value: u + COST }];
  const amount = (13n * u) / 2n;
  assert.equal(planPoolWithdraw(five, amount, C), null);
  const near = nearestPlannable(five, amount, C);
  assert.ok(near.below! < amount && near.above! > amount);
  for (const x of [near.below!, near.above!]) {
    const p = planPoolWithdraw(five, x, C)!;
    assert.equal(p.reduce((t, q) => t + q.part, 0n), x);
  }
  assert.deepEqual(near, { below: 6n * u, above: 7n * u }, "the 5u note whole with one u note, or with both");
});

// ---------- the run ----------

// card pool-tree-read-waits-for-its-second: the wallet's real tree sync on two providers whose confirmed block is the
// finalized one (mainnet, 11 Nov 19:00Z): leaf 0 landed before the epoch, leaf 1 (the note withdrawn) in now's own
// block-second, so the epoch cut lacks it and the newest read at now + 1 must wait for the chain's next second
function syncedTrees(advance: () => boolean, waits: number[]) {
  return (state: readonly bigint[], labels: readonly bigint[]) => {
    const nowS = NOW / 1000n;
    const times = state.map((_, i) => (i === 0 ? nowS - 30n : nowS));
    const pageOf = (tree: number, leaves: readonly bigint[]): Uint8Array => {
      const d = new Uint8Array(16 + 72 * leaves.length);
      d.set(new TextEncoder().encode("bfpage01"));
      d[8] = tree;
      leaves.forEach((leaf, i) => {
        const b = (x: bigint) => Buffer.from(x.toString(16).padStart(64, "0"), "hex");
        d.set(b(leaf), 16 + 72 * i);
        d.set(b(new VaultTree(leaves.slice(0, i + 1)).root!), 16 + 72 * i + 32);
        new DataView(d.buffer).setBigInt64(16 + 72 * i + 64, times[i]!, true);
      });
      return d;
    };
    const pages = new Map([[solanaPageOf(PROGRAM, 0, 0), pageOf(0, state)], [solanaPageOf(PROGRAM, 1, 0), pageOf(1, labels)]]);
    const at = (url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]): Promise<unknown> => {
      if (m === "getBlockTime") return Number(nowS + (advance() ? 1n : 0n));
      if (m !== "getMultipleAccounts") throw new Error(`no ${m}`);
      return { context: { slot: 500 }, value: (p[0] as string[]).map((k) => (pages.has(k) ? { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: [base64.encode(pages.get(k)!), "base64"] } : null)) };
    }, { url });
    const sync = solanaTreeSync([at("https://a.example"), at("https://b.example")], PROGRAM, async (ms) => void waits.push(ms));
    return sync.trees;
  };
}

test("a withdraw of a note that landed in now's block-second waits for the chain's next second and proves it in the tree", async () => {
  const waits: number[] = [];
  const wd = await world([1_000n, 30_000_000n], { trees: syncedTrees(() => waits.length > 0, waits) });
  const amount = 2_000_000n + MIN;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST);
  assert.equal(a.stage, "sent");
  assert.equal(a.cause, undefined);
  assert.equal(wd.balance.get(TO), amount);
  assert.ok(waits.length >= 1 && waits.length <= 2 && waits.every((ms) => ms === SOL_LAG_WAIT_MS), `a slot's wait a provider at most: ${waits}`);
  // the proof's state root: the tree of both leaves, the note's own leaf 1 in it
  assert.equal(solanaDecodePoolRelease(read(wd.releases[0]!).ixs.at(-1)!.data).stateRootIndex, 1, "the proof's root holds leaf 1");
});

test("a withdraw whose providers never reach now + 1 ends stopped after the cap, its cause kept", async () => {
  const waits: number[] = [];
  const wd = await world([1_000n, 30_000_000n], { trees: syncedTrees(() => false, waits) });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 2_000_000n + MIN, COST);
  assert.equal(a.stage, "stopped");
  assert.equal(wd.releases.length, 0, "nothing sent");
  assert.ok(waits.length >= SOL_REACH_WAITS, `${waits.length} waits`);
  assert.match(a.cause ?? "", /^SolanaNotReachedError not_reached\b/);
  // the note is back to UNSPENT, for the next try
  assert.equal((await wd.ns.get(wd.ids[1]!))?.state, "UNSPENT");
  // the op's record keeps it
  assert.equal(mergeWithdrawOp({ stage: "proving" }, { stage: "stopped", cause: a.cause! }).cause, a.cause);
  // public words only: the error's name and code, never its text (its RPC's slot and times)
  assert.ok(!/rpc [01]|has not reached|slot|\d{6,}/.test(a.cause!), a.cause);
  // an op that later ends sent (its owed send finished) no longer names a cause
  assert.equal("cause" in mergeWithdrawOp({ stage: "stopped", cause: a.cause! }, { stage: "sent" }), false);
});

// M351: the newest root right after a note's own leaf is a deposit's own note's only. Leaf 0 landed before the epoch,
// leaf 1 (the note withdrawn) 1 s into it, leaf 2 (another note) 30 s into it; trees(cut) keeps the leaves whose time
// is below the cut, as the wallet's tree sync does.
const BOUNDARY = NOW - (NOW % SOL_EPOCH_MS) + SOL_EPOCH_MS;
function cutTrees(state: readonly bigint[], labels: readonly bigint[]): Pool<SolanaReleaseRequest>["trees"] {
  const times = [NOW - 30_000n, NOW - 1n, NOW + 29_000n];
  return async (beforeMs) => {
    const n = times.filter((t) => t < beforeMs).length;
    const s = new VaultTree(state.slice(0, n)), l = new VaultTree(labels.slice(0, n));
    return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
  };
}
/** The pool's time: NOW until the run has waited `toBoundary` ms or more in all, then the boundary (pool time, never the device's). */
function poolClock(toBoundary: bigint) {
  const waits: number[] = [];
  const slept = () => waits.reduce((a, b) => a + BigInt(b), 0n);
  return { waits, now: () => (slept() >= toBoundary ? BOUNDARY : NOW), wait: async (ms: number) => void waits.push(ms) };
}
const RETURN: NoteRef = { kind: "return", c: "sol", l: 7n, j: 0 };

test("a return note that landed this epoch waits for the next boundary, on pool time, and proves on that epoch's root, never the root of its own leaf", async () => {
  const clock = poolClock(BOUNDARY - NOW);
  const wd = await world([1_000n, 30_000_000n, 1_000n], { trees: cutTrees, refs: [undefined, RETURN], now: clock.now, wait: clock.wait });
  const amount = 2_000_000n + MIN;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST);
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(wd.balance.get(TO), amount);
  assert.ok(clock.waits.length >= 1, "it waited");
  const r = solanaDecodePoolRelease(read(wd.releases[0]!).ixs.at(-1)!.data);
  assert.equal(r.stateRootIndex, 2, "the next epoch's root (leaves 0..2), not the root right after leaf 1");
  // the epoch, the deadline and the binding are the next epoch's
  assert.equal(wd.binds[0]!.deadlineMs, BOUNDARY + SOL_LIFE_MS);
});

test("a deposit's own note that landed this epoch proves on the newest root at once, with no wait", async () => {
  const clock = poolClock(BOUNDARY - NOW);
  const wd = await world([1_000n, 30_000_000n, 1_000n], { trees: cutTrees, now: clock.now, wait: clock.wait });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 2_000_000n + MIN, COST);
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(solanaDecodePoolRelease(read(wd.releases[0]!).ixs.at(-1)!.data).stateRootIndex, 1, "the newest root, its own leaf 1 last");
  assert.equal(wd.binds[0]!.deadlineMs, BOUNDARY - SOL_EPOCH_MS + SOL_LIFE_MS);
  assert.ok(clock.waits.every((ms) => ms < 1_000), `no boundary wait: ${clock.waits}`);
});

test("a return note's wait is bounded: pool time that never reaches the boundary ends stopped, nothing sent, the note UNSPENT", async () => {
  const clock = poolClock(1n << 62n);
  const wd = await world([1_000n, 30_000_000n, 1_000n], { trees: cutTrees, refs: [undefined, RETURN], now: clock.now, wait: clock.wait });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 2_000_000n + MIN, COST);
  assert.equal(a.stage, "stopped");
  assert.equal(wd.releases.length, 0, "nothing sent");
  assert.equal(wd.binds.length, 0, "nothing bound");
  const slept = clock.waits.reduce((x, y) => x + BigInt(y), 0n);
  assert.ok(slept >= BOUNDARY - NOW && slept <= SOL_EPOCH_MS + WITHDRAW_BOUNDARY_LAG_MS + 1_000n, `slept ${slept} ms`);
  assert.equal((await wd.ns.get(wd.ids[1]!))?.state, "UNSPENT");
});

// round 2 of the boundary wait: trees cut by chain time, every read's signal kept
function cutAt(times: readonly bigint[], signals: (AbortSignal | undefined)[] = []) {
  return (state: readonly bigint[], labels: readonly bigint[]): Pool<SolanaReleaseRequest>["trees"] =>
    async (beforeMs, signal) => {
      signals.push(signal);
      const n = times.filter((t) => t < beforeMs).length;
      const s = new VaultTree(state.slice(0, n)), l = new VaultTree(labels.slice(0, n));
      return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
    };
}
const rootIndexOf = (wd: { releases: Uint8Array[] }) => solanaDecodePoolRelease(read(wd.releases[0]!).ixs.at(-1)!.data).stateRootIndex;
const E = SOL_EPOCH_MS;

test("after the wait the proof is on the new epoch's root, never the newest: a leaf landed after the boundary is not in it; every tree read is bounded", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  let slept = 0n;
  // leaf 3 lands 2 s after the boundary; the wait ends 5 s past it
  const wd = await world([1_000n, 30_000_000n, 1_000n, 1_000n], { trees: cutAt([NOW - 30_000n, NOW - 1n, NOW + 29_000n, BOUNDARY + 2_000n], signals), refs: [undefined, RETURN], now: () => (slept > 0n ? BOUNDARY + 5_000n : NOW), wait: async (ms) => void (slept += BigInt(ms)) });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 2_000_000n + MIN, COST);
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(rootIndexOf(wd), 2, "the root of the boundary's cut (leaves 0..2), not the newest (0..3)");
  assert.ok(signals.length >= 2 && signals.every((x) => x instanceof AbortSignal), "every tree read carries its wall-clock bound");
});

test("pool time read behind the note's own leaf: the part waits on to the next boundary in the same budget and proves there", async () => {
  // a return finalized 1 s past boundary B; the first time read 2 s before B, the next 0.5 s past it, then past B + E
  const times = [BOUNDARY - 40_000n, BOUNDARY + 1_000n, BOUNDARY + 2_000n];
  let slept = 0n;
  const wd = await world([1_000n, 30_000_000n, 1_000n], { trees: cutAt(times), refs: [undefined, RETURN], now: () => (slept >= 2_000n + E - 500n ? BOUNDARY + E : slept > 0n ? BOUNDARY + 500n : BOUNDARY - 2_000n), wait: async (ms) => void (slept += BigInt(ms)) });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 2_000_000n + MIN, COST);
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(rootIndexOf(wd), 2);
  assert.equal(wd.binds[0]!.deadlineMs, BOUNDARY + E + SOL_LIFE_MS);
  assert.ok(slept <= E + WITHDRAW_BOUNDARY_LAG_MS, `one budget: ${slept} ms`);
});

test("pool time trailing the device by 20 s past the boundary still sends (the lag allowance), and a time stalled 1 ms short reads at most once a second", async () => {
  const lagging = poolClock(BOUNDARY - NOW + 20_000n);
  const wd = await world([1_000n, 30_000_000n, 1_000n], { trees: cutTrees, refs: [undefined, RETURN], now: lagging.now, wait: lagging.wait });
  assert.equal((await runPoolWithdraw(wd.host, ASK, TO, 2_000_000n + MIN, COST)).stage, "sent");
  let reads = 0;
  const waits: number[] = [];
  const wd2 = await world([1_000n, 30_000_000n, 1_000n], { trees: cutTrees, refs: [undefined, RETURN], now: () => (reads++, waits.length === 0 ? NOW : BOUNDARY - 1n), wait: async (ms) => void waits.push(ms) });
  const a = await runPoolWithdraw(wd2.host, ASK, TO, 2_000_000n + MIN, COST);
  assert.equal(a.stage, "stopped");
  assert.equal(waits.reduce((x, y) => x + y, 0), 90_000, "one epoch and 30 s of waits");
  assert.ok(reads <= 90 + 3, `${reads} time reads`);
});

test("the first time read is the pool's, never the page's clock: pool time an epoch past the page's binds that epoch", async () => {
  const wd = await world([1_000n, 30_000_000n], { trees: cutAt([NOW - 30_000n, NOW - 1n]), now: () => BOUNDARY + 1_000n });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 2_000_000n + MIN, COST);
  assert.equal(a.stage, "sent", a.cause);
  assert.equal(wd.binds[0]!.deadlineMs, BOUNDARY + SOL_LIFE_MS);
});

test("a note held by an old page's queue at the boundary (no planned record read) is dropped again before the part holds it", async () => {
  let slept = 0n;
  let held: string | undefined;
  const wd = await world([1_000n, 30_000_000n, 1_000n], {
    trees: cutTrees, refs: [undefined, RETURN], now: () => (slept >= BOUNDARY - NOW ? BOUNDARY : NOW),
    wait: async (ms) => {
      slept += BigInt(ms);
      if (slept >= BOUNDARY - NOW && held === undefined) held = (await wd.ns.move(wd.ids[1]!, "UNSPENT", "HELD", { deadlineMs: BOUNDARY + SOL_LIFE_MS, context: "1" })).attempt!;
    },
  });
  const drop = async (id: string) => void (held !== undefined && (await wd.ns.move(id, "HELD", "UNSPENT", { attempt: held })));
  const a = await runPoolWithdraw({ ...wd.host, drop }, ASK, TO, 2_000_000n + MIN, COST);
  assert.equal(a.stage, "sent", a.cause);
});

/** The planned notes' record on the world's store, as the page writes it, and a queue in another context reading it. */
function otherContext(wd: Awaited<ReturnType<typeof world>>, prover = wd.host.prover) {
  const pool = { ...wd.host.pool, bind: (b: Parameters<typeof wd.host.pool.bind>[0], s?: AbortSignal) => wd.host.pool.bind({ ...b, tipCap: b.tipCap ?? 1n }, s) };
  return openProofQueue({ seed64: SEED64, notes: wd.ns, pool, provers: [prover], hardwareConcurrency: 4, skip: () => keptOutNotes(wd.w, NOW) });
}
const keepOut = (wd: Awaited<ReturnType<typeof world>>) => async (ids: readonly string[], untilMs: bigint) => void (await keepOutNotes(wd.w, "op-w", ids, untilMs));

for (const at of ["the boundary", "the bind"] as const) {
  test(`another context's queue passing at ${at} leaves the withdraw's planned note alone: the withdraw ends sent, and a buy still gets its proof from the other notes`, async () => {
    let slept = 0n;
    let q: ReturnType<typeof openProofQueue> | undefined;
    const passes: Promise<unknown>[] = [];
    // leaf 0: another note, in the epoch root (the buy's); leaf 1: the return the withdraw plans
    const wd = await world([10_000_000n, 30_000_000n, 1_000n], {
      trees: cutTrees, refs: [undefined, RETURN], now: () => (slept >= BOUNDARY - NOW ? BOUNDARY : NOW),
      wait: async (ms) => {
        slept += BigInt(ms);
        if (at === "the boundary" && slept >= BOUNDARY - NOW) await q!.refresh();
      },
    });
    q = otherContext(wd);
    if (at === "the bind") {
      const bind = wd.host.pool.bind;
      // the pass starts while the withdraw binds, between its last free() and its own hold
      wd.host.pool = { ...wd.host.pool, bind: async (b, s) => (b.tipCap === 0n && passes.length === 0 && passes.push(q!.refresh()), await new Promise((r) => setTimeout(r, 50)), bind(b, s)) };
    }
    const a = await runPoolWithdraw({ ...wd.host, keepOut: keepOut(wd) }, ASK, TO, 2_000_000n + MIN, COST);
    assert.equal(a.stage, "sent", a.cause);
    await Promise.all(passes);
    assert.deepEqual(q.ready().map((r) => r.noteId), [wd.ids[0]], "the buy's proof: the other note's");
    assert.deepEqual(await keptOutNotes(wd.w, NOW), new Set(), "cleared at the run's end");
    await q.close();
  });
}

test("the planned record of a run that crashed stops counting at its own deadline; another run's entry is kept", async () => {
  const wd = await world([30_000_000n]);
  await keepOutNotes(wd.w, "op-a", ["n1", "n2"], NOW + 100n);
  await keepOutNotes(wd.w, "op-b", ["n3"], NOW + 500n);
  assert.deepEqual(await keptOutNotes(wd.w, NOW), new Set(["n1", "n2", "n3"]));
  assert.deepEqual(await keptOutNotes(wd.w, NOW + 100n), new Set(["n3"]), "op-a's deadline passed");
  await keepOutNotes(wd.w, "op-b", [], 0n);
  assert.deepEqual(await keptOutNotes(wd.w, NOW), new Set(["n1", "n2"]));
});

test("a note this page's queue is still proving when the run starts comes back once that proof ends: the run waits for it and sends", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const base = (await world([1_000n])).host.prover;
  const prover = { ...base, prove: async (c: string, i: unknown) => (await gate, (base.prove as (c: string, i: unknown) => Promise<unknown>)(c, i)) } as typeof base;
  let waited = 0;
  const wd = await world([30_000_000n], { wait: async () => { if (waited++ === 0) open(); await new Promise((r) => setTimeout(r, 5)); } });
  const q = otherContext(wd, prover);
  const pass = q.refresh();
  for (let i = 0; i < 2000 && (await wd.ns.get(wd.ids[0]!))?.state !== "HELD"; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal((await wd.ns.get(wd.ids[0]!))?.state, "HELD", "the queue holds it, proving");
  // planned as this page's (its pass began before the run's record was written)
  const a = await runPoolWithdraw({ ...wd.host, drop: (id) => q.drop(id) }, ASK, TO, 2_000_000n + MIN, COST, new Set([wd.ids[0]!]));
  assert.equal(a.stage, "sent", a.cause);
  assert.ok(waited >= 1, "it waited for the proof to end");
  await pass;
  await q.close();
});

test("a withdraw sends exactly the typed amount to To from one note: the release alone to W, then W's own send of all it holds, W at 0", async () => {
  const wd = await world([30_000_000n]);
  const amount = 2_000_000n + MIN;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST);
  assert.equal(a.stage, "sent");
  assert.equal(a.pending, null);
  assert.equal(wd.releases.length, 1);
  assert.equal(wd.onwards().length, 1);
  const W = wd.binds[0]!.recipient;
  // review #232 HIGH 1: the fee payer's transaction is the release alone (after its compute limit), tip cap 0
  const rel = read(wd.releases[0]!);
  assert.deepEqual(rel.signers, [FEE_PAYER, W]);
  assert.deepEqual(rel.ixs.map((x) => x.program), ["ComputeBudget111111111111111111111111111111", PROGRAM]);
  assert.equal(wd.binds[0]!.tipCap, 0n);
  assert.equal(wd.binds[0]!.chunk, amount + COST);
  // W's own send: W the only signer and fee payer, one transfer of all it holds less its fee, to To
  const on = read(wd.onwards()[0]!);
  assert.deepEqual(on.signers, [W]);
  assert.equal(on.ixs.length, 1);
  assert.equal(on.ixs[0]!.program, SOLANA_SYSTEM_PROGRAM);
  assert.deepEqual(on.ixs[0]!.accounts, [W, TO]);
  assert.equal(lamportsOf(on.ixs[0]!.data), amount, "exactly the typed amount arrives");
  assert.equal(wd.balance.get(TO), amount);
  assert.equal(wd.balance.get(W), 0n, "W ends at 0");
  assert.deepEqual(a.txs, [{ chain: "solana", hash: [...wd.landed.keys()][0]! }, { chain: "solana", hash: base58.encode(wd.onwards()[0]!.subarray(1, 65)) }]);
  // the release's own signature, once the sender names it, added to the owed send still stored, the op left alone
  // (fold 3; fold 4: never a whole owe again)
  assert.deepEqual(wd.order, ["owe:RESERVED", "send:1", "release:RESERVED", `settle:${wd.ids[0]}`], "RESERVED, then the onward owed, before the release leaves");
  assert.equal((wd.owed.at(-1) as { release?: string }).release, [...wd.landed.keys()][0]);
  assert.deepEqual([wd.stages[0], wd.stages.includes("in_transit"), wd.stages.at(-1)], ["proving", true, "sent"]);
  // W signed the release's slot 1; the fee payer's slot 0 is the helper's
  assert.ok(wd.releases[0]!.subarray(65, 129).some((b) => b !== 0));
  assert.ok(wd.releases[0]!.subarray(1, 65).every((b) => b === 0));
});

test("the seed is shut before the pool fee is asked (card withdraw-fee-busy-waits): a busy helper's wait never runs with it open", async () => {
  const wd = await world([30_000_000n]);
  const handed: Uint8Array[] = [];
  const seed64 = wd.host.seed64.bind(wd.host);
  wd.host.seed64 = async () => {
    const s = await seed64();
    handed.push(s);
    return s;
  };
  const bind = wd.host.pool.bind.bind(wd.host.pool);
  const atBind: { read: number; open: number }[] = [];
  wd.host.pool.bind = async (b) => {
    atBind.push({ read: handed.length, open: handed.filter((s) => s.some((x) => x !== 0)).length });
    return await bind(b);
  };
  const a = await runPoolWithdraw(wd.host, ASK, TO, 2_000_000n + MIN, COST);
  // one bind, after the seed was read for W, with every copy of it zeroed
  assert.equal(atBind.length, 1);
  assert.ok(atBind[0]!.read > 0);
  assert.equal(atBind[0]!.open, 0);
  assert.equal(a.stage, "sent");
});

test("a withdraw over two notes: two releases and two onward sends, each note its own W, the parts summing to the amount", async () => {
  const wd = await world([10_000_000n, 30_000_000n]);
  const amount = 33_000_000n;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, 2n * COST);
  assert.equal(a.stage, "sent");
  assert.equal(wd.releases.length, 2);
  const ons = wd.onwards().map(read);
  assert.equal(ons.length, 2);
  assert.equal(ons.reduce((t, o) => t + lamportsOf(o.ixs[0]!.data), 0n), amount);
  assert.notEqual(ons[0]!.signers[0], ons[1]!.signers[0], "each note's own W");
  assert.equal(wd.balance.get(TO), amount);
  for (const o of ons) assert.equal(wd.balance.get(o.signers[0]!), 0n);
  assert.equal(a.txs.length, 4);
});

// review #232 MEDIUM 1: the Max fee the screen drew is a bound the run keeps
test("a plan that costs more than the Max fee drawn stops before its first part: nothing bound, nothing sent", async () => {
  const wd = await world([10_000_000n, 30_000_000n]);
  assert.equal(planPoolWithdraw([{ id: "a", value: 10_000_000n }, { id: "b", value: 30_000_000n }], 33_000_000n, C)!.length, 2);
  const a = await runPoolWithdraw(wd.host, ASK, TO, 33_000_000n, 2n * COST - 1n);
  assert.equal(a.stage, "stopped");
  assert.equal(wd.binds.length, 0);
  assert.equal(wd.releases.length, 0);
  assert.deepEqual((await wd.ns.list()).map((n) => n.state), ["UNSPENT", "UNSPENT"]);
});

test("refused before anything is sent: a helper fee not the device's, an amount over the notes or one no plan sends without dust", async () => {
  for (const [values, amount, plant] of [
    [[30_000_000n], 5_000_000n, { helperFee: FEE + 100_000n }],
    [[30_000_000n], 30_000_000n, {}],
    [[30_000_000n], 30_000_000n - COST - 1n, {}],
  ] as const) {
    const wd = await world(values, plant);
    const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST);
    assert.equal(a.stage, "stopped");
    assert.equal(wd.releases.length, 0);
    assert.deepEqual((await wd.ns.list()).map((n) => n.state), ["UNSPENT"]);
  }
  // another kind or chain is never run
  const wd = await world([30_000_000n]);
  assert.equal((await runPoolWithdraw(wd.host, { ...ASK, kind: "pool.buy" }, TO, 5_000_000n, COST)).stage, "stopped");
  assert.equal(wd.releases.length, 0);
});

// review #232 LOW: To is never the pool's own account nor executable, checked before any note moves
test("To that is the fee payer, the pool, its program, System, an executable account or one the pool program owns: stopped before the bind", async () => {
  for (const [to, toAccount] of [
    [FEE_PAYER, undefined],
    [POOL, undefined],
    [PROGRAM, undefined],
    [SOLANA_SYSTEM_PROGRAM, undefined],
    [TO, { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true }],
    [TO, { owner: PROGRAM, executable: false }],
  ] as const) {
    const wd = await world([30_000_000n], toAccount ? { toAccount } : {});
    assert.equal((await runPoolWithdraw(wd.host, ASK, to, 5_000_000n, COST)).stage, "stopped", to);
    assert.equal(wd.binds.length, 0, to);
    assert.deepEqual((await wd.ns.list()).map((n) => n.state), ["UNSPENT"]);
  }
  // an account with lamports the System program owns (a wallet) is a To
  const wd = await world([30_000_000n], { toAccount: { owner: SOLANA_SYSTEM_PROGRAM, executable: false } });
  assert.equal((await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST)).stage, "sent");
});

test("a release that does not read back is never sent; the note stays RESERVED for the state reads, nothing sent on", async () => {
  const wd = await world([30_000_000n], { readBack: "none" });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  assert.notEqual(a.stage, "sent");
  assert.notEqual(a.stage, "in_transit");
  assert.deepEqual((await wd.ns.list()).map((n) => n.state), ["RESERVED"]);
  assert.equal(wd.onwards().length, 0);
});

test("an onward send that never lands leaves the part on W, in_transit and owed; the state reads' finish sends it, once", async () => {
  const wd = await world([30_000_000n], { onward: "drop" });
  const amount = 5_000_000n;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST);
  assert.equal(a.stage, "in_transit");
  const W = wd.binds[0]!.recipient;
  assert.equal(wd.balance.get(W), amount + W_FEE, "the part and W's fee on W");
  assert.ok(a.pending && a.pending.to === TO && a.pending.last === true);
  assert.deepEqual(wd.pendings.at(-1), a.pending, "the op record carries what is owed");
  // a page reload: the state reads' pass finds it and sends it on
  wd.plant.onward = "ok";
  const done = await finishPoolOnward(wd.host, a.pending!);
  assert.equal(done?.stage, "sent");
  assert.equal(done?.txs.length, 1);
  assert.equal(wd.balance.get(W), 0n);
  assert.equal(wd.balance.get(TO), amount);
  // again (two tabs, or a second read): W holds 0, nothing sent, the op sent
  assert.deepEqual(await finishPoolOnward(wd.host, a.pending!), { stage: "sent", txs: [], arrived: {} });
  assert.equal(wd.onwards().length, 1);
});

// ---------- fold 2: the re-review of e694200 (review #232b) ----------

// HIGH 1: a release that read back but whose spend is not read at finalized in time is "sent" to sendAndSettle; the
// part is on W all the same, so the op owes its onward send, written before the release left
test("a release whose spend is not read in time keeps the part owed: in_transit, the pending written before the release left; the finish sends it on", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const amount = 5_000_000n;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST);
  const W = wd.binds[0]!.recipient;
  assert.equal(a.stage, "in_transit");
  const held = (await wd.ns.get(wd.ids[0]!))!;
  assert.deepEqual(a.pending, { noteId: wd.ids[0], attempt: held.attempt, context: held.contexts!.at(-1)!.context, to: TO, last: true, feeCap: W_FEE.toString(), release: [...wd.landed.keys()][0]! });
  assert.deepEqual(wd.pendings.at(-1), a.pending, "the op's last write still owes it");
  assert.deepEqual(wd.order.slice(0, 2), ["owe:RESERVED", "send:1"], "owed before the release left");
  assert.equal(wd.balance.get(W), amount + W_FEE);
  // card pool-buy-record-never-stays-sent: the release read landed, so the note's mark holds what it took out, and the
  // balance in every tab counts only its change until the settle writes it
  const mark = (await wd.ns.marks()).get(wd.ids[0]!);
  assert.equal(mark?.attempt, held.attempt);
  assert.equal(typeof mark?.withdrawn === "bigint" && mark.withdrawn > 0n, true, "the landed release's withdrawn value on the note's mark");
  // the state reads' pass: W holds the part, so it goes on to To
  const done = await finishPoolOnward(wd.host, a.pending!);
  assert.equal(done?.stage, "sent");
  assert.equal(wd.balance.get(W), 0n);
  assert.equal(wd.balance.get(TO), amount);
  assert.deepEqual(Object.values(done!.arrived), [amount.toString()]);
});

test("the finish settles W at 0 by its note: spent is sent (stopped when parts were left), RESERVED waits, freed is stopped", async () => {
  // W at 0, the note spent: the send went already
  {
    const wd = await world([30_000_000n]);
    assert.equal((await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST)).stage, "sent");
    const p = wd.owed[0] as PendingOnward;
    assert.deepEqual(await finishPoolOnward(wd.host, p), { stage: "sent", txs: [], arrived: {} });
    assert.deepEqual(await finishPoolOnward(wd.host, { ...p, last: false }), { stage: "stopped", txs: [], arrived: {} });
  }
  // W at 0, the note still RESERVED with no spend read: read again later; once the reserved pass frees it (its
  // deadline past on both RPCs' block time, no spend), stopped
  {
    const wd = await world([30_000_000n], { readBack: "none", landed: false });
    await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
    const n = (await wd.ns.list())[0]!;
    assert.equal(n.state, "RESERVED");
    const p = wd.owed[0] as PendingOnward;
    assert.equal(await finishPoolOnward(wd.host, p), null);
    await wd.ns.move(n.id, "RESERVED", "UNSPENT", { blockTimeMs: n.deadlineMs! + 1n });
    assert.deepEqual(await finishPoolOnward(wd.host, p), { stage: "stopped", txs: [], arrived: {} });
    assert.equal(wd.onwards().length, 0);
  }
});

test("a release that can never land (refused, or not landed on both RPCs) ends stopped with nothing owed", async () => {
  const wd = await world([30_000_000n], { readBack: "none", landed: false });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "stopped");
  assert.equal(a.pending, null);
});

// Card sol-settle-failed-is-not-unspent: the helper sends the release and answers 502, the release lands on W, and the
// settle throws (a lister that refuses, a 429 past the retry, a stop) while both RPCs read the blockhash past. A settle
// that throws says nothing of the chain: the part stays owed until a read proves the release did not land, so the op is
// never stopped with the part left on its one-use W and nothing owed.
test("the helper's 502 after the release left, the release landed, the settle throwing once: the send stays owed, never stopped; the next pass carries it to To", async () => {
  const amount = 5_000_000n;
  const planted = async (reads: number) => {
    const wd = await world([30_000_000n]);
    const send = wd.host.send;
    wd.host.send = async (pool, tx) => {
      await send(pool, tx);
      throw new Error("pool send: HTTP 502");
    };
    const settle = wd.host.settle;
    let settles = 0;
    wd.host.settle = async (id, minSlots) => {
      if (++settles === 1) throw new Error("restore: the lister listed 10 deposits and 2 releases, but rpc 0's pages hold 12 state and 10 label leaves");
      return settle(id, minSlots);
    };
    const a = await runPoolWithdraw({ ...wd.host, reads }, ASK, TO, amount, COST);
    return { wd, a, W: wd.binds[0]!.recipient, settles: () => settles };
  };
  // the run's one read: the settle throws, so the part is still owed after this pass
  const { wd, a, W, settles } = await planted(1);
  assert.equal(settles(), 1);
  assert.equal(a.stage, "in_transit");
  assert.ok(!wd.stages.includes("stopped"), `stages ${wd.stages.join(",")}`);
  assert.ok(a.pending && a.pending.noteId === wd.ids[0] && a.pending.to === TO && a.pending.last === true);
  assert.deepEqual(wd.pendings.at(-1), a.pending, "the op's last write still owes it");
  assert.equal(wd.balance.get(W), amount + W_FEE, "the part on W");
  assert.equal((await wd.ns.get(wd.ids[0]!))!.state, "RESERVED");
  // the next pass (the state reads' finish) carries it
  const done = await finishPoolOnward(wd.host, a.pending!);
  assert.equal(done?.stage, "sent");
  assert.equal(wd.balance.get(W), 0n);
  assert.equal(wd.balance.get(TO), amount);
  // two reads in the run: the settle works on the second, so the run itself carries it
  const two = await planted(2);
  assert.equal(two.settles(), 2);
  assert.equal(two.a.stage, "sent");
  assert.ok(!two.wd.stages.includes("stopped"));
  assert.equal(two.wd.balance.get(TO), amount);
});

// LOW 1: the fee W pays is the network's for its very message; one that rose after the plan changes what reaches To
// (kept in the op), never W's end at 0
test("a fee that rose after the plan, within the Max fee drawn: W still ends at 0, To gets the balance less the real fee, and the op says what arrived", async () => {
  let rose = false;
  const wd = await world([30_000_000n], { feeFor: () => (rose ? 2n * W_FEE : W_FEE), afterRelease: () => void (rose = true) });
  const amount = 5_000_000n;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST + W_FEE);
  const W = wd.binds[0]!.recipient;
  assert.equal(a.stage, "sent");
  assert.equal(wd.balance.get(W), 0n);
  assert.equal(wd.balance.get(TO), amount - W_FEE);
  assert.deepEqual(Object.values(a.arrived), [(amount - W_FEE).toString()]);
});

// review #232b LOW 4: the Max fee shown is a ceiling, never exceeded: over it, nothing is sent, the send stays owed and
// the op says the fee it needs, for the screen to draw again
test("a fee that rose past the Max fee drawn: nothing sent, the part owed on W with the fee it needs; the finish holds it too", async () => {
  let rose = false;
  const wd = await world([30_000_000n], { feeFor: () => (rose ? 2n * W_FEE : W_FEE), afterRelease: () => void (rose = true) });
  const amount = 5_000_000n;
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST);
  const W = wd.binds[0]!.recipient;
  assert.equal(a.stage, "in_transit");
  assert.equal(a.feeNeeded, (2n * W_FEE).toString());
  assert.equal(wd.onwards().length, 0);
  assert.equal(wd.balance.get(TO) ?? 0n, 0n);
  assert.equal(wd.balance.get(W), amount + W_FEE, "the part stays on W, owed");
  assert.deepEqual(await finishPoolOnward(wd.host, a.pending!), { stage: "in_transit", txs: [], arrived: {}, feeNeeded: (2n * W_FEE).toString() });
  assert.equal(wd.onwards().length, 0);
  // drawn again at the new fee: the send goes, To never less than the amount less the Max fee drawn
  const finish = await finishPoolOnward(wd.host, { ...a.pending!, feeCap: (2n * W_FEE).toString() });
  assert.equal(finish?.stage, "sent");
  assert.equal(wd.balance.get(W), 0n);
  assert.equal(wd.balance.get(TO), amount - W_FEE);
});

test("a fee above all W holds is no fee to draw again: nothing sent, no fee needed named, the part kept owed (fold 2, review LOW 4)", async () => {
  let rose = false;
  const wd = await world([30_000_000n], { feeFor: () => (rose ? 10n ** 12n : W_FEE), afterRelease: () => void (rose = true) });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  const W = wd.binds[0]!.recipient;
  assert.equal(a.feeNeeded, undefined);
  assert.notEqual(a.pending, null, "still owed");
  assert.equal(wd.onwards().length, 0);
  assert.equal(wd.balance.get(W), 5_000_000n + W_FEE);
  const f = await finishPoolOnward(wd.host, a.pending!);
  assert.equal(f?.feeNeeded, undefined);
  assert.equal(wd.onwards().length, 0);
});

test("the plan's fee for W is read on a message of exactly the onward's shape: one signer, one System transfer", async () => {
  const wd = await world([30_000_000n]);
  await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  const shape = (m: Uint8Array) => {
    const d = solanaDecodeMessage(m);
    return [d.requiredSignatures, d.readonlySigned, d.readonlyUnsigned, d.staticKeys.length, d.instructions.length, d.staticKeys[d.instructions[0]!.programIndex], d.instructions[0]!.data.length];
  };
  const [plan, ...onward] = wd.fees;
  assert.ok(onward.length > 0);
  for (const o of onward) assert.deepEqual(shape(plan!), shape(o));
});

// LOW 2: some To addresses can never be paid: the runtime's read-only keys, and the plan's own Ws
test("To that is a key the runtime keeps read-only, or a W of the plan, is stopped before the bind", async () => {
  for (const to of ["SysvarRent111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "Vote111111111111111111111111111111111111111"]) {
    const wd = await world([30_000_000n]);
    assert.equal((await runPoolWithdraw(wd.host, ASK, to, 5_000_000n, COST)).stage, "stopped", to);
    assert.equal(wd.binds.length, 0, to);
  }
  // the W of the plan's second part: found by a first run's bind on the same notes
  const probe = await world([10_000_000n, 30_000_000n]);
  await runPoolWithdraw(probe.host, ASK, TO, 33_000_000n, 2n * COST);
  const second = probe.binds[1]!.recipient;
  const wd = await world([10_000_000n, 30_000_000n]);
  assert.equal((await runPoolWithdraw(wd.host, ASK, second, 33_000_000n, 2n * COST)).stage, "stopped");
  assert.equal(wd.binds.length, 0, "no release for a To that is one of the plan's Ws");
});

test("the finish takes the seed through the host's one-use hook only, never holding it across the send", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  let uses = 0;
  let inUse = false;
  const host = {
    ...wd.host,
    seed64: async () => assert.fail("the finish reads the seed through withSeed only"),
    withSeed: async <T,>(f: (s: Uint8Array) => T | Promise<T>): Promise<T> => {
      uses++;
      inUse = true;
      try {
        return await f(SEED64.slice());
      } finally {
        inUse = false;
      }
    },
    rpcs: wd.host.rpcs.map((rpc) => (async (m: string, p: readonly unknown[]) => {
      if (m === "sendTransaction") assert.equal(inUse, false, "no seed held while the send goes out");
      return rpc(m, p);
    }) as typeof rpc) as unknown as typeof wd.host.rpcs,
  };
  assert.equal((await finishPoolOnward(host, a.pending!))?.stage, "sent");
  assert.ok(uses >= 2, "a derive and a signature, each its own use");
});

// LOW 3: two tabs
test("another tab sent a part on first: the run goes on to its next part, never ends on W at 0", async () => {
  let first = true;
  const wd = await world([10_000_000n, 30_000_000n], {
    afterRelease: (w) => {
      if (!first) return;
      first = false;
      // tab B's finish: W's whole balance less its fee to To, before tab A's own send onward
      const b = wd.balance.get(w)!;
      wd.add(w, -b);
      wd.add(TO, b - W_FEE);
    },
  });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 33_000_000n, 2n * COST);
  assert.equal(a.stage, "sent");
  assert.equal(wd.releases.length, 2, "the second part went too");
  assert.equal(wd.balance.get(TO), 33_000_000n);
});

test("a withdraw op's writes merge: another tab's onward tx and arrival are never dropped, a later part's pending never cleared", () => {
  const b = mergeWithdrawOp({ kind: "withdraw", stage: "in_transit", txs: [{ chain: "solana", hash: "R1" }], created_ms: 1, owed: "n1" }, { stage: "stopped", txs: [{ chain: "solana", hash: "O1" }], arrived: { O1: "5" }, clear: "n1" });
  assert.deepEqual(b.txs, [{ chain: "solana", hash: "R1" }, { chain: "solana", hash: "O1" }]);
  assert.equal(b.owed, undefined);
  // tab A's own write comes after: its txs are added to B's, B's onward and arrival stay
  const a = mergeWithdrawOp(b, { stage: "in_transit", txs: [{ chain: "solana", hash: "R1" }, { chain: "solana", hash: "R2" }], arrived: {}, owe: "n2" });
  assert.deepEqual((a.txs as { hash: string }[]).map((t) => t.hash), ["R1", "O1", "R2"]);
  assert.deepEqual(a.arrived, { O1: "5" });
  // B's late clear of part 1 leaves part 2's pending
  const late = mergeWithdrawOp(a, { stage: "stopped", txs: [], clear: "n1" });
  assert.equal(late.owed, "n2");
  assert.equal(late.created_ms, 1);
});

// LOW 4: the op record (frame-readable) names the note, never its label
test("the onward owed names its note by id, never by its label (which links the withdraw to its deposit)", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  const n = (await wd.ns.list())[0]!;
  assert.deepEqual(Object.keys(a.pending!).sort(), ["attempt", "context", "feeCap", "last", "noteId", "release", "to"]);
  const text = JSON.stringify([a.pending, wd.owed]);
  assert.ok(!text.includes(n.leaf!.label.toString()), "no label in what the op stores");
});

// ---------- fold 3: the re-review of 2b3a882 ----------

// MEDIUM 1: a note's W is the same for every spend of it. An op owing a send for an attempt whose release never landed
// must never send a later spend's money from that W (review probe-respend, both orders)
const TO2 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
for (const order of ["during op 2's send (another tab)", "after op 2"] as const) {
  test(`an owed send whose release never landed, the note freed and spent again by op 2: op 1's finish ${order} sends nothing, op 2's To keeps op 2's money`, async () => {
    const wd = await world([30_000_000n], { landed: false, readBack: "none" });
    // the read-back runs out before both RPCs read the blockhash past: "sent", the part owed
    const [r0, r1] = wd.host.rpcs;
    const young = (rpc: SolanaRpc): SolanaRpc => (async (m: string, p: readonly unknown[]) => (m === "getBlockHeight" ? 0 : m === "getEpochInfo" ? { blockHeight: 0, absoluteSlot: FINAL_SLOT } : rpc(m, p))) as SolanaRpc;
    const op1 = await runPoolWithdraw({ ...wd.host, rpcs: [young(r0), young(r1)] }, ASK, TO, 5_000_000n, COST);
    assert.equal(op1.stage, "in_transit");
    const n = (await wd.ns.list())[0]!;
    await wd.ns.move(n.id, "RESERVED", "UNSPENT", { blockTimeMs: n.deadlineMs! + 1n });
    wd.plant.landed = true;
    wd.plant.readBack = "ours";
    let finish1: unknown = "not run";
    const send = wd.host.send;
    const host2 = order === "after op 2" ? wd.host : { ...wd.host, send: async (p: string, tx: Uint8Array) => { const a = await send(p, tx); finish1 = await finishPoolOnward(wd.host, op1.pending!); return a; } };
    const op2 = await runPoolWithdraw(host2, ASK, TO2, 5_000_000n, COST);
    if (order === "after op 2") finish1 = await finishPoolOnward(wd.host, op1.pending!);
    assert.equal(op2.stage, "sent");
    assert.deepEqual(finish1, { stage: "stopped", txs: [], arrived: {} }, "op 1 is never reported sent");
    assert.equal(wd.balance.get(TO2), 5_000_000n, "op 2's To keeps op 2's money");
    assert.equal(wd.balance.get(TO) ?? 0n, 0n);
  });
}

test("a note an op still owes a send for is kept out of the plan", async () => {
  const wd = await world([30_000_000n]);
  const a = await runPoolWithdraw({ ...wd.host, owedNotes: async () => new Set([wd.ids[0]!]) }, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "stopped");
  assert.equal(wd.binds.length, 0);
});

// LOW 2: a lagging node's 0 for W is never believed: W read at or past both RPCs' finalized slot after the spend
test("both RPCs' nodes behind on W's balance: the run's send onward still finds the part, sends it, W ends at 0", async () => {
  const wd = await world([30_000_000n], { stale: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  const W = wd.binds[0]!.recipient;
  assert.equal(a.stage, "sent");
  assert.equal(wd.balance.get(W), 0n);
  assert.equal(wd.balance.get(TO), 5_000_000n);
});

test("both RPCs' nodes behind on W's balance: the finish of a spent part still sends it, never reports it sent with W full", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "in_transit");
  wd.plant.settleUnspent = false;
  wd.plant.stale = true;
  const W = wd.binds[0]!.recipient;
  const f = await finishPoolOnward(wd.host, a.pending!);
  assert.equal(f?.stage, "sent");
  assert.equal(wd.balance.get(W), 0n);
  assert.equal(wd.balance.get(TO), 5_000_000n);
});

// LOW 3: never drop an owed send: a To the checks now refuse keeps it owed, W untouched
test("a To refused at the finish keeps the send owed: null, nothing sent, the part still on W", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  const W = wd.binds[0]!.recipient;
  assert.equal(await finishPoolOnward(wd.host, { ...a.pending!, to: "SysvarRent111111111111111111111111111111111" }), null);
  wd.plant.toAccount = { owner: SOLANA_SYSTEM_PROGRAM, executable: true };
  assert.equal(await finishPoolOnward(wd.host, a.pending!), null);
  assert.equal(wd.onwards().length, 0);
  assert.equal(wd.balance.get(W), 5_005_000n);
});

// Card pool-senders-next-page, review LOW 4: a resumed send onward passed no release accounts to the rule, so a To
// naming one the To checks do not read (the mark, a page or the next page the release names, none of them made yet)
// was sent W's part. The finish reads the release's accounts with its spend, on both RPCs, and refuses each as To.
test("a resumed send onward to an account the release names is refused: the send stays owed, the part on W", async () => {
  for (const keep of [true, false]) {
    const wd = await world([30_000_000n], { settleUnspent: true });
    const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
    assert.equal(a.stage, "in_transit");
    wd.plant.settleUnspent = false;
    const W = wd.binds[0]!.recipient;
    const wire = [...wd.landed.values()][0]!;
    const m = solanaDecodeMessage(wire.subarray(1 + 64 * wire[0]!));
    const rel = m.instructions.find((ix) => m.staticKeys[ix.programIndex] === PROGRAM)!;
    const named = rel.accounts.map((i) => m.staticKeys[i]!);
    // the ones no other check refuses: not W, the pool, the fee payer or a program, and no account the RPCs serve
    const unread = named.filter((k) => ![W, POOL, FEE_PAYER, PROGRAM, SOLANA_SYSTEM_PROGRAM, solanaPoolPage(PROGRAM, 0, 0), solanaPoolPage(PROGRAM, 1, 0)].includes(k) && !k.startsWith("Sysvar"));
    assert.ok(unread.length > 0, named.join(" "));
    const p = keep ? a.pending! : noRelease(a.pending!);
    for (const to of unread) assert.equal(await finishPoolOnward(wd.host, { ...p, to }), null, `${keep} ${to}`);
    assert.equal(wd.onwards().length, 0);
    assert.equal(wd.balance.get(W), 5_000_000n + W_FEE);
    // the user's own To still goes
    assert.equal((await finishPoolOnward(wd.host, p))?.stage, "sent");
    assert.equal(wd.balance.get(TO), 5_000_000n);
  }
});

// LOW 1: an op's stage never moves back (review probe-merge: a stale finish after the run's sent)
test("a withdraw op's stage never moves back: a stale stopped never overwrites sent, a later part's proving never its in_transit", () => {
  const sent = { kind: "withdraw", stage: "sent", txs: [{ chain: "solana", hash: "rel1" }, { chain: "solana", hash: "on1" }], created_ms: 1 };
  assert.equal(mergeWithdrawOp(sent, { stage: "stopped", txs: [], arrived: {}, clear: "note1" }).stage, "sent");
  assert.equal(mergeWithdrawOp({ ...sent, stage: "in_transit" }, { stage: "proving", txs: [] }).stage, "in_transit");
  assert.equal(mergeWithdrawOp({ ...sent, stage: "in_transit" }, { stage: "sent", txs: [] }).stage, "sent");
  assert.equal(mergeWithdrawOp({ ...sent, stage: "proving" }, { stage: "stopped", txs: [] }).stage, "stopped");
});

test("an owed send that names no attempt or context is no attempt's: stopped, nothing read or sent", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  const n = (await wd.ns.get(wd.ids[0]!))!;
  // a note with no contexts list, SPENT by another device: an owed send with no context must not match it
  const { attempt: _a, context: _c, ...bare } = a.pending!;
  assert.deepEqual(await finishPoolOnward(wd.host, bare as PendingOnward), { stage: "stopped", txs: [], arrived: {} });
  assert.deepEqual(await finishPoolOnward(wd.host, { ...a.pending!, attempt: "" }), { stage: "stopped", txs: [], arrived: {} });
  assert.equal(wd.onwards().length, 0);
  assert.equal(n.state, "RESERVED");
});

// ---------- card signpage-withdraw-own-spend: the round-3 review's LOW 1 ----------

// Two devices signed in with the same 12 words derive the same note and the same W, and each keeps its own note store.
// A spent note and a full W never say whose release it was: W goes on only once both RPCs read that the release which
// spent the note carries this attempt's context.
const youngRpcs = (wd: Awaited<ReturnType<typeof world>>): PoolWithdrawHost["rpcs"] => {
  const [r0, r1] = wd.host.rpcs;
  const young = (rpc: SolanaRpc): SolanaRpc => (async (m: string, p: readonly unknown[]) => (m === "getBlockHeight" ? 0 : m === "getEpochInfo" ? { blockHeight: 0, absoluteSlot: FINAL_SLOT } : rpc(m, p))) as SolanaRpc;
  return [young(r0), young(r1)];
};

test("another device's release spent the note to the same W: the run sends nothing from W and ends stopped", async () => {
  const wd = await world([30_000_000n]);
  // the release that landed carries another attempt's context (another device's, same words, same W)
  wd.plant.afterRelease = () => wd.foreign();
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  const W = wd.binds[0]!.recipient;
  assert.equal(a.stage, "stopped");
  assert.equal(a.pending, null);
  assert.equal(wd.onwards().length, 0, "nothing sent from W");
  assert.equal(wd.balance.get(TO) ?? 0n, 0n);
  assert.equal(wd.balance.get(W), 5_000_000n + W_FEE, "the other device's part stays on W for that device");
});

test("an owed send whose note another device spent, W already sent on by it: the finish is stopped, never sent", async () => {
  const wd = await world([30_000_000n], { landed: false, readBack: "none" });
  const op1 = await runPoolWithdraw({ ...wd.host, rpcs: youngRpcs(wd) }, ASK, TO, 5_000_000n, COST);
  assert.equal(op1.stage, "in_transit");
  // device 2 spends the note (to the same W) and sends W on: W at 0, the note spent on chain
  wd.foreignLand(wd.releases[0]!, 0n);
  wd.plant.landed = true;
  wd.plant.readBack = "ours";
  assert.deepEqual(await finishPoolOnward(wd.host, op1.pending!), { stage: "stopped", txs: [], arrived: {} }, "never reported sent with nothing arrived");
  assert.equal(wd.onwards().length, 0);
});

test("an owed send whose note another device spent, its part still on W: the finish sends nothing to this device's To", async () => {
  const wd = await world([30_000_000n], { landed: false, readBack: "none" });
  const op1 = await runPoolWithdraw({ ...wd.host, rpcs: youngRpcs(wd) }, ASK, TO, 5_000_000n, COST);
  const W = wd.binds[0]!.recipient;
  wd.foreignLand(wd.releases[0]!, 7_000_000n);
  wd.plant.landed = true;
  wd.plant.readBack = "ours";
  assert.deepEqual(await finishPoolOnward(wd.host, op1.pending!), { stage: "stopped", txs: [], arrived: {} });
  assert.equal(wd.onwards().length, 0);
  assert.equal(wd.balance.get(TO) ?? 0n, 0n);
  assert.equal(wd.balance.get(W), 7_000_000n, "device 2's part stays on W");
});

test("whose release it was must be read on both RPCs (its own signature not kept): one that lists no spend, or another transaction, decides nothing", async () => {
  type Wd = Awaited<ReturnType<typeof world>>;
  const histories: ((wd: Wd) => (s: string[], p: 0 | 1) => string[])[] = [
    () => (s, p) => (p === 1 ? [] : s),
    // the second RPC names another transaction (the same bytes under another id) for the spend
    (wd) => (s, p) => (p === 1 ? s.map((x) => (wd.landed.has(x) ? wd.alias(x) : x)) : s),
  ];
  for (const historyOf of histories) {
    const wd = await world([30_000_000n], { settleUnspent: true });
    const history = historyOf(wd);
    const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
    wd.plant.settleUnspent = false;
    wd.plant.history = history;
    const W = wd.binds[0]!.recipient;
    const f = await finishPoolOnward(wd.host, noRelease(a.pending!));
    assert.equal(f, null, "read again later: the money may be this attempt's");
    assert.equal(wd.onwards().length, 0);
    assert.equal(wd.balance.get(W), 5_000_000n + W_FEE);
    // both RPCs agree: this attempt's release, so W goes on
    wd.plant.history = undefined;
    assert.equal((await finishPoolOnward(wd.host, noRelease(a.pending!)))?.stage, "sent");
    assert.equal(wd.balance.get(TO), 5_000_000n);
  }
});

// card signpage-withdraw-own-spend (3): a stage written with a clear is that note's verdict (round-3 review
// probe3-merge): it never stands over a later part's send still owed
test("a stale finish's stage for one note never stands over another note's send still owed; it does once none is owed", () => {
  const owed2 = { kind: "withdraw", stage: "in_transit", txs: [{ chain: "solana", hash: "rel1" }, { chain: "solana", hash: "on1" }, { chain: "solana", hash: "rel2" }], created_ms: 1, owed: "n2" };
  const r2 = mergeWithdrawOp(owed2, { stage: "stopped", clear: "n1" });
  assert.equal(r2.stage, "in_transit", "part 2 still owed: not stopped");
  assert.equal(r2.owed, "n2");
  const r3 = mergeWithdrawOp(r2, { stage: "sent", txs: [{ chain: "solana", hash: "on2" }], arrived: { on2: "5000000" }, clear: "n2" });
  assert.equal(r3.stage, "sent");
  assert.equal(r3.owed, undefined);
  // no send owed: the stage applies (the op's own end, or a freed note's stopped)
  assert.equal(mergeWithdrawOp({ ...owed2, owed: undefined }, { stage: "stopped", clear: "n1" }).stage, "stopped");
  assert.equal(mergeWithdrawOp({ ...owed2, owed: "n1" }, { stage: "stopped", clear: "n1" }).stage, "stopped");
  // a fee_needed goes with its own note's clear only
  const f = mergeWithdrawOp(owed2, { feeNeeded: "10000" });
  assert.equal(mergeWithdrawOp(f, { clear: "n1" }).fee_needed, "10000");
  assert.equal(mergeWithdrawOp(f, { clear: "n2" }).fee_needed, undefined);
});

test("a failed transaction of the note in W's history is no spend: another device's landed release after it decides, nothing sent", async () => {
  const wd = await world([30_000_000n], { landed: false, readBack: "none" });
  const op1 = await runPoolWithdraw({ ...wd.host, rpcs: youngRpcs(wd) }, ASK, TO, 5_000_000n, COST);
  const W = wd.binds[0]!.recipient;
  // this device's release landed and failed (the note spent first by device 2), then device 2's landed
  wd.foreignLand(wd.releases[0]!, 7_000_000n);
  wd.landOlder(wd.releases[0]!, { failed: true });
  wd.plant.landed = true;
  wd.plant.readBack = "ours";
  assert.deepEqual(await finishPoolOnward(wd.host, op1.pending!), { stage: "stopped", txs: [], arrived: {} });
  assert.equal(wd.onwards().length, 0);
  assert.equal(wd.balance.get(W), 7_000_000n);
});

test("a release of another note to W (anyone may send one there), before or after this attempt's, never decides whose spend it was", async () => {
  for (const newer of [false, true]) {
    const wd = await world([30_000_000n], { settleUnspent: true });
    const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
    const other = wd.landOlder(wd.releases[0]!, { nullifier: true });
    // W's history read newest first: the other note's release read before this attempt's when it is the newer
    if (newer) wd.plant.history = (s) => [other, ...s.filter((x) => x !== other)];
    // its own signature not kept: W's history alone decides
    const f = await finishPoolOnward(wd.host, noRelease(a.pending!));
    assert.equal(f?.stage, "sent", newer ? "newer" : "older");
    assert.equal(wd.balance.get(TO), 5_000_000n);
  }
});

test("the run: the release read back not this attempt's, and an RPC that lists no spend for the part, decides nothing: in_transit, nothing sent from W, the part owed", async () => {
  const wd = await world([30_000_000n], { history: (s, p) => (p === 1 ? [] : s) });
  wd.plant.afterRelease = () => wd.foreign();
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  const W = wd.binds[0]!.recipient;
  assert.equal(a.stage, "in_transit");
  assert.ok(a.pending);
  assert.equal(wd.onwards().length, 0);
  assert.equal(wd.balance.get(W), 5_000_000n + W_FEE);
});

// ---- fold 2 (review of ebafdf3): W's history read takes any message format, pages on the cursor, and ends ----

/** A legacy (unversioned) 1-lamport transfer to `to`: anyone can land one naming W, before or after the release. */
function legacyTransfer(payer: string, to: string): Uint8Array {
  const keys = [payer, to, SOLANA_SYSTEM_PROGRAM].map((k) => base58.decode(k));
  const ix = [2, 2, 0, 1, 12, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
  const msg = [1, 0, 1, 3, ...keys.flatMap((k) => [...k]), ...new Uint8Array(32).fill(3), 1, ...ix];
  return Uint8Array.from([1, ...new Uint8Array(64).fill(44), ...msg]);
}
const withTx = (rpc: SolanaRpc, sig: string, wire: Uint8Array, failed: boolean): SolanaRpc =>
  (async (m: string, p: readonly unknown[]) =>
    m === "getTransaction" && p[0] === sig ? { transaction: [base64.encode(wire), "base64"], meta: { err: failed ? { InstructionError: [0, "x"] } : null } } : rpc(m, p)) as SolanaRpc;

for (const failed of [false, true]) {
  test(`a ${failed ? "failed" : "landed"} legacy transaction naming W, older than this device's release, is not the spend: the finish still sends (review HIGH 1)`, async () => {
    const wd = await world([30_000_000n], { settleUnspent: true });
    const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
    wd.plant.settleUnspent = false;
    const W = wd.binds[0]!.recipient;
    const leg = legacyTransfer(FEE_PAYER, W);
    const sig = base58.encode(leg.subarray(1, 65));
    wd.plant.history = (s) => [...s, sig];
    const [r0, r1] = wd.host.rpcs;
    const f = await finishPoolOnward({ ...wd.host, rpcs: [withTx(r0, sig, leg, failed), withTx(r1, sig, leg, failed)] }, a.pending!);
    assert.equal(f?.stage, "sent");
    assert.equal(wd.balance.get(TO), 5_000_000n);
  });
}

test("this device's own release landed in a legacy message (the pool program takes either) is read as its own: sent", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  wd.plant.settleUnspent = false;
  const W = wd.binds[0]!.recipient;
  const [r0, r1] = wd.host.rpcs;
  const listed = (await r0("getSignaturesForAddress", [W, {}])) as { signature: string }[];
  assert.equal(listed.length, 1, "W's history: the release alone");
  const sig = listed[0]!.signature;
  const v0 = wd.landed.get(sig)!;
  const n = v0[0]!;
  assert.equal(v0[1 + 64 * n], 0x80);
  assert.equal(v0.at(-1), 0, "no lookups");
  // the same release, its message unversioned: no prefix, no lookup list
  const leg = Uint8Array.from([...v0.subarray(0, 1 + 64 * n), ...v0.subarray(2 + 64 * n, v0.length - 1)]);
  const f = await finishPoolOnward({ ...wd.host, rpcs: [withTx(r0, sig, leg, false), withTx(r1, sig, leg, false)] }, a.pending!);
  assert.equal(f?.stage, "sent");
});

const dust = (n: number, tag: number) => Array.from({ length: n }, (_, i) => base58.encode(Uint8Array.from({ length: 64 }, (_, k) => (k < 4 ? (i >> (8 * k)) & 255 : tag))));
/** An RPC that pages getSignaturesForAddress for real (before, limit), `cap` its own page size. */
const paged = (rpc: SolanaRpc, cap: number, calls: { n: number }): SolanaRpc =>
  (async (m: string, p: readonly unknown[]) => {
    const r = await rpc(m, p);
    if (m !== "getSignaturesForAddress") return r;
    calls.n++;
    const all = r as { signature: string }[];
    const o = p[1] as { limit: number; before?: string };
    const from = o.before === undefined ? 0 : all.findIndex((e) => e.signature === o.before) + 1;
    return all.slice(from, from + Math.min(o.limit, cap));
  }) as SolanaRpc;

/** The owed send as a record from before the release's own signature was kept: W's history alone decides. */
const noRelease = (p: PendingOnward): PendingOnward => {
  const { release: _r, ...rest } = p;
  return rest;
};
/** A new function for an RPC, as the page's pageRpc makes on every rpcs() call. */
const fresh = (rpc: SolanaRpc): SolanaRpc => (async (m: string, p: readonly unknown[]) => rpc(m, p)) as SolanaRpc;
/** finishPoolOnward until it decides, at most `max` passes: the verdict and the passes it took. As the page runs it
 *  (pool-testnet's finishOnward): new RPC functions on every pass, the op's places in W's history kept across them. */
async function passes(h: PoolWithdrawHost, p: PendingOnward, max: number) {
  const places: HistoryPlaces = new Map();
  for (let n = 1; n <= max; n++) {
    const f = await finishPoolOnward({ ...h, rpcs: [fresh(h.rpcs[0]), fresh(h.rpcs[1])], places }, p);
    if (f !== null) return { f, n };
  }
  return { f: null, n: max };
}

test("9,000 one-lamport transfers to W after this device's release: its release read back by its own signature, sent, W's history never read (review HIGH 2, G1)", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  wd.plant.settleUnspent = false;
  assert.ok(a.pending?.release, "the release's signature kept with the owed send");
  const pad = dust(9_000, 9);
  wd.plant.history = (s) => [...pad, ...s];
  const calls = { n: 0 };
  const f = await finishPoolOnward({ ...wd.host, rpcs: [paged(wd.host.rpcs[0], HISTORY_PAGE, calls), paged(wd.host.rpcs[1], HISTORY_PAGE, calls)] }, a.pending!);
  assert.equal(f?.stage, "sent");
  assert.equal(calls.n, 0, "no history read");
  assert.equal(wd.balance.get(TO), 5_000_000n);
});

test("4,500 newer entries in W's history, this device's release the oldest and its signature not kept: each pass reads its share and the next goes on from there, across finishes with new RPC functions; sent (review P1, LOW 4; fold 4)", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  wd.plant.settleUnspent = false;
  // past two passes: one finish (two passes, before and after its settle) never reaches it, the next goes on to it
  const pad = dust(4_500, 9);
  wd.plant.history = (s) => [...pad, ...s];
  const calls = { n: 0 };
  const { f, n } = await passes({ ...wd.host, rpcs: [paged(wd.host.rpcs[0], HISTORY_PAGE, calls), paged(wd.host.rpcs[1], HISTORY_PAGE, calls)] }, noRelease(a.pending!), 3);
  assert.equal(f?.stage, "sent");
  assert.equal(n, 2, `${n} finishes`);
  assert.ok(calls.n >= 10, `${calls.n} page reads`);
});

test("a provider that pages 100 at a time: the release past its first page is still found, sent (review P2)", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  wd.plant.settleUnspent = false;
  const pad = dust(150, 9);
  wd.plant.history = (s) => [...pad, ...s];
  const calls = { n: 0 };
  const { f } = await passes({ ...wd.host, rpcs: [paged(wd.host.rpcs[0], HISTORY_PAGE, calls), paged(wd.host.rpcs[1], 100, calls)] }, noRelease(a.pending!), 2);
  assert.equal(f?.stage, "sent");
});

test("9,000 transfers to W and another device's release the oldest, this device's never landed: the passes read on to it, stopped, nothing sent (fold 3)", async () => {
  const wd = await world([30_000_000n], { landed: false, readBack: "none" });
  const op1 = await runPoolWithdraw({ ...wd.host, rpcs: youngRpcs(wd) }, ASK, TO, 5_000_000n, COST);
  assert.equal(op1.stage, "in_transit");
  const W = wd.binds[0]!.recipient;
  wd.foreignLand(wd.releases[0]!, 7_000_000n);
  wd.plant.landed = true;
  wd.plant.readBack = "ours";
  const pad = dust(9_000, 9);
  wd.plant.history = (s) => [...pad, ...s];
  const { f, n } = await passes(wd.host, op1.pending!, 8);
  assert.deepEqual(f, { stage: "stopped", txs: [], arrived: {} });
  assert.ok(n >= 2, `${n} finishes, two passes of ${HISTORY_PASS} entries each`);
  assert.equal(wd.onwards().length, 0);
  assert.equal(wd.balance.get(W), 7_000_000n);
});

test(`an RPC that pages forever: each pass ends after ${HISTORY_PASS} entries, no verdict and nothing sent (review MEDIUM 2)`, async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  wd.plant.settleUnspent = false;
  let k = 0;
  let entries = 0;
  const forever = (rpc: SolanaRpc): SolanaRpc => (async (m: string, p: readonly unknown[]) => {
    if (m !== "getSignaturesForAddress") return rpc(m, p);
    k++;
    const n = Math.min(HISTORY_PAGE, (p[1] as { limit: number }).limit);
    entries += n;
    return Array.from({ length: n }, (_, i) => ({ signature: base58.encode(Uint8Array.from({ length: 64 }, (_, j) => (j < 4 ? (i >> (8 * j)) & 255 : j < 8 ? (k >> (8 * (j - 4))) & 255 : 7))), slot: 20, err: null }));
  }) as SolanaRpc;
  const r = await Promise.race([
    finishPoolOnward({ ...wd.host, rpcs: [forever(wd.host.rpcs[0]), wd.host.rpcs[1]] }, noRelease(a.pending!)).then((x) => ({ x }), (e: unknown) => ({ e })),
    new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 5_000)),
  ]);
  assert.notEqual(r, "timeout");
  // two passes in one finish (before and after its settle), each its own share
  assert.ok(entries > 0 && entries <= 2 * HISTORY_PASS, `${entries} entries in ${k} pages`);
  assert.ok(!("x" in (r as object)) || (r as { x: unknown }).x === null, `no verdict: ${JSON.stringify(r)}`);
  assert.equal(wd.onwards().length, 0);
});

test("a message of a later version (prefix 0x81) in W's history is not the spend: sent (review LOW 5)", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  wd.plant.settleUnspent = false;
  const v1 = Uint8Array.from([1, ...new Uint8Array(64).fill(45), 0x81, 1, 0, 1, 1, ...new Uint8Array(64).fill(3), 0, 0]);
  const sig = base58.encode(v1.subarray(1, 65));
  wd.plant.history = (s) => [sig, ...s];
  const [r0, r1] = wd.host.rpcs;
  const { f } = await passes({ ...wd.host, rpcs: [withTx(r0, sig, v1, false), withTx(r1, sig, v1, false)] }, noRelease(a.pending!), 2);
  assert.equal(f?.stage, "sent");
});

/** Another device's buy (tag 3) of the same note, to the same W: this device's release fields with another salt. */
function tag3Of(wd: Awaited<ReturnType<typeof world>>, compressed: boolean): Uint8Array {
  const wire = wd.releases[0]!;
  const m = solanaDecodeMessage(wire.subarray(1 + 64 * wire[0]!));
  const ix = m.instructions.at(-1)!;
  const rel = solanaDecodePoolRelease(ix.data);
  const salt = rel.salt.slice();
  salt[0] ^= 0xff;
  const r = { ...rel, salt, proof: compressed ? rel.proof.slice(0, 128) : rel.proof };
  const data = solanaEncodePoolTag3(r, compressed, 0n, [{ program: 7, accounts: [1], data: Uint8Array.of(2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0) }]);
  const keys = ix.accounts.map((i) => m.staticKeys[i]!);
  const accounts = keys.map((key, n) => ({ key, signer: n === 1 || n === 2, writable: [0, 1, 2, 3, 6].includes(n) }));
  const { message } = solanaCompileV0(keys[2]!, [{ program: m.staticKeys[ix.programIndex]!, accounts, data }], "11111111111111111111111111111111", [], [keys[2]!, keys[1]!]);
  const out = new Uint8Array(1 + 128 + message.length);
  out[0] = 2;
  out.set(message, 129);
  return out;
}
for (const compressed of [false, true]) {
  test(`another device's buy (tag 3, ${compressed ? "compressed" : "full"} proof) spent the note to W: read at its nullifier, stopped, nothing sent (review P4)`, async () => {
    const wd = await world([30_000_000n], { landed: false, readBack: "none" });
    const op1 = await runPoolWithdraw({ ...wd.host, rpcs: youngRpcs(wd) }, ASK, TO, 5_000_000n, COST);
    assert.equal(op1.stage, "in_transit");
    const W = wd.binds[0]!.recipient;
    wd.landOlder(tag3Of(wd, compressed));
    wd.add(W, 7_000_000n);
    wd.plant.landed = true;
    wd.plant.readBack = "ours";
    assert.deepEqual(await finishPoolOnward(wd.host, op1.pending!), { stage: "stopped", txs: [], arrived: {} });
    assert.equal(wd.onwards().length, 0);
  });
}

test("this device's release read back by its own signature on one RPC only decides nothing by itself: the other RPC must read it too (fold 3)", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  wd.plant.settleUnspent = false;
  const release = a.pending!.release!;
  // the second RPC neither serves the release by its signature nor lists it in W's history
  wd.plant.history = (s, p) => (p === 1 ? [] : s);
  const [r0, r1] = wd.host.rpcs;
  const blind = (async (m: string, p: readonly unknown[]) => (m === "getTransaction" && p[0] === release ? null : r1(m, p))) as SolanaRpc;
  assert.equal(await finishPoolOnward({ ...wd.host, rpcs: [r0, blind] }, a.pending!), null);
  assert.equal(wd.onwards().length, 0);
});

test("the two RPCs reach the spend in different passes: each keeps what it found, so the finish decides once both have (fold 3)", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  wd.plant.settleUnspent = false;
  // the release 3,000 entries deep on the first RPC, 4,500 on the second: found in passes two and three
  const pad0 = dust(3_000, 9);
  const pad1 = dust(4_500, 10);
  wd.plant.history = (s, p) => [...(p === 0 ? pad0 : pad1), ...s];
  // with what each found kept: decided by the third pass (the second finish); with none kept, the two RPCs' finds
  // never meet in one pass until the sixth (each find sends its RPC back to the newest)
  const { f, n } = await passes(wd.host, noRelease(a.pending!), 3);
  assert.equal(f?.stage, "sent");
  assert.ok(n <= 2, `${n} finishes`);
  assert.equal(wd.balance.get(TO), 5_000_000n);
});

// fold 4 (review LOW): the run reads its own release back by the signature its send gave, never W's history first
test("the run reads its release back by the signature its send gave: 2,500 newer entries in W's history, still sent (fold 4)", async () => {
  const wd = await world([30_000_000n]);
  const pad = dust(2_500, 9);
  wd.plant.history = (s) => [...pad, ...s];
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "sent");
  assert.equal(wd.onwards().length, 1);
  assert.equal(wd.balance.get(TO), 5_000_000n);
});

/** The page's two RPCs, whose finalized slot is behind until the release is read at finalized (it reached finalized
 *  after the first read of the slot); with plant.stale, a balance read below FINAL_SLOT answers 0. */
const lateFinal = (wd: Awaited<ReturnType<typeof world>>): PoolWithdrawHost["rpcs"] => {
  let seen = false;
  const late = (rpc: SolanaRpc): SolanaRpc =>
    (async (m: string, p: readonly unknown[]) => {
      if (m === "getTransaction" && (p[1] as { commitment?: string }).commitment === "finalized") seen = true;
      if (m === "getSlot") return seen ? FINAL_SLOT : FINAL_SLOT - 5;
      return rpc(m, p);
    }) as SolanaRpc;
  return [late(wd.host.rpcs[0]), late(wd.host.rpcs[1])];
};

for (const where of ["run", "finish"] as const) {
  test(`the ${where}: the release read back at finalized after the slot was first read, W is read at the finalized slot read after it, never at the older one (fold 4)`, async () => {
    // the release landed at the older slot (card pool-buy-filled-2s: the settle waits for its slot to be final)
    const wd = await world([30_000_000n], { settleUnspent: where === "finish", txSlot: FINAL_SLOT - 5 });
    const W = () => wd.binds[0]!.recipient;
    let stage: string | undefined;
    if (where === "run") {
      wd.plant.stale = true;
      stage = (await runPoolWithdraw({ ...wd.host, rpcs: lateFinal(wd) }, ASK, TO, 5_000_000n, COST)).stage;
    } else {
      const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
      assert.equal(a.stage, "in_transit");
      wd.plant.settleUnspent = false;
      wd.plant.stale = true;
      stage = (await finishPoolOnward({ ...wd.host, rpcs: lateFinal(wd) }, a.pending!))?.stage;
    }
    assert.equal(stage, "sent");
    assert.equal(wd.onwards().length, 1, "W sent on, never read as 0 at the older slot");
    assert.equal(wd.balance.get(W()), 0n);
    assert.equal(wd.balance.get(TO), 5_000_000n);
  });
}

test("a pass that fails part way keeps what it read: a provider that refuses after 1,600 reads in a row, the spend under 3,000 newer entries, the next finish goes on from there; sent (fold 5, review MEDIUM)", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  wd.plant.settleUnspent = false;
  const pad = dust(3_000, 9);
  wd.plant.history = (s) => [...pad, ...s];
  // each provider serves 1,600 transaction reads, then refuses one (its rate limit), then serves again
  const limited = (rpc: SolanaRpc): SolanaRpc => {
    let n = 0;
    return (async (m: string, p: readonly unknown[]) => {
      if (m === "getTransaction" && ++n > 1_600) {
        n = 0;
        throw new Error("429");
      }
      return rpc(m, p);
    }) as SolanaRpc;
  };
  const { f, n } = await passes({ ...wd.host, rpcs: [limited(wd.host.rpcs[0]), limited(wd.host.rpcs[1])] }, noRelease(a.pending!), 3);
  assert.equal(f?.stage, "sent");
  assert.equal(n, 2, `${n} finishes`);
  assert.equal(wd.balance.get(TO), 5_000_000n);
});

test("the page's two RPCs in the other order on the next pass: what one found never stands for the other; nothing decided, nothing sent (fold 5, review LOW)", async () => {
  const wd = await world([30_000_000n], { settleUnspent: true });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  wd.plant.settleUnspent = false;
  const release = a.pending!.release!;
  const [x, y0] = wd.host.rpcs;
  // Y neither lists the spend in W's history nor serves it by its signature; X does both
  wd.plant.history = (s, p) => (p === 1 ? [] : s);
  const y = (async (m: string, p: readonly unknown[]) => (m === "getTransaction" && p[0] === release ? null : y0(m, p))) as SolanaRpc;
  const places: HistoryPlaces = new Map();
  const p = noRelease(a.pending!);
  assert.equal(await finishPoolOnward({ ...wd.host, rpcs: [fresh(x), fresh(y)], places }, p), null, "X found it, Y did not");
  assert.equal(await finishPoolOnward({ ...wd.host, rpcs: [fresh(y), fresh(x)], places }, p), null, "Y never stands on X's find");
  assert.equal(wd.onwards().length, 0);
});

test("the release's signature is written with the owed send before its read-back starts: the send awaits it (fold 5, review LOW)", async () => {
  const wd = await world([30_000_000n]);
  let kept = false;
  let keptAtRead: boolean | undefined;
  const [r0, r1] = wd.host.rpcs;
  const watch = (rpc: SolanaRpc): SolanaRpc =>
    (async (m: string, p: readonly unknown[]) => {
      if (m === "getTransaction" && keptAtRead === undefined) keptAtRead = kept;
      return rpc(m, p);
    }) as SolanaRpc;
  const keepRelease = async () => {
    await new Promise((r) => setTimeout(r, 30));
    kept = true;
  };
  const a = await runPoolWithdraw({ ...wd.host, rpcs: [watch(r0), watch(r1)], keepRelease }, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "sent");
  assert.equal(keptAtRead, true, "the read-back began before the signature was written");
});

test("a failed write of the release's signature never stops the send: keepRelease rejects, the part is still sent on, W at 0 (fold 6, review LOW)", async () => {
  const wd = await world([30_000_000n]);
  let asked = 0;
  const keepRelease = async () => {
    asked++;
    throw new Error("the store refused the write");
  };
  const a = await runPoolWithdraw({ ...wd.host, keepRelease }, ASK, TO, 5_000_000n, COST);
  assert.equal(asked, 1, "the signature's write was asked for");
  assert.equal(a.stage, "sent");
  assert.equal(wd.onwards().length, 1);
  assert.equal(wd.balance.get(wd.binds[0]!.recipient), 0n);
  assert.equal(wd.balance.get(TO), 5_000_000n);
});

// Card signpage-buy-own-spend: spendOwner reads a release and buy (tag 3) too, its keys the static ones and those its
// lookups load (getTransaction's meta loadedAddresses), its context from its own fields as context.rs hashes them. On
// main 8791c3d this device's own landed tag 3 read as "other": tag 3 never decoded, and its pool account (from the
// lookup table) never resolved.
const BUY_SIG = base58.encode(new Uint8Array(64).fill(5));
const OTHER_BUY_SIG = base58.encode(new Uint8Array(64).fill(6));
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const contextOfBuy = (r: SolanaPoolRelease): string =>
  solanaContextOf({ program: PROGRAM, pool: POOL, recipient: BUY_W, feePayer: FEE_PAYER, relayFee: r.relayFee, relayFeeCap: r.relayFeeCap, tipCap: r.tipCap, deadlineMs: r.deadlineMs, salt: hexOf(r.salt) }, SCOPE).toString();
const NH = BigInt("0x" + hexOf(BUY_RELEASE.existingNullifierHash));
/** The kit's real tag 3 for the fixture release under `sig`, with the lookups' keys getTransaction's meta gives. */
async function buyTx(r: SolanaPoolRelease, sig: string, edit?: (data: Uint8Array) => void) {
  const s = await buySetup("pump");
  const tx = buildSolanaPoolBuy(BUY_CFG, r, s.venue, s.req, s.chain, { pick: () => 2 }).wire.slice();
  tx.set(base58.decode(sig), 1);
  const body = tx.subarray(129);
  const m = solanaDecodeMessage(body);
  if (edit) {
    const data = m.instructions.at(-1)!.data;
    let at = -1;
    for (let i = 0; i + data.length <= body.length && at < 0; i++) if (data.every((x, k) => body[i + k] === x)) at = i;
    edit(body.subarray(at, at + data.length));
  }
  const loaded = { writable: m.lookups.flatMap((l) => l.writable.map((i) => s.addresses[i]!)), readonly: m.lookups.flatMap((l) => l.readonly.map((i) => s.addresses[i]!)) };
  return { tx, loaded };
}
/** Two RPCs that hold `txs` at finalized (each with its meta) and list them, newest first, in W's history. */
const chainOf = (txs: Record<string, { tx: Uint8Array; meta: Record<string, unknown> }>): SolanaRpc =>
  (async (m: string, p: readonly unknown[]) => {
    if (m === "getTransaction") {
      const t = txs[p[0] as string];
      return t ? { transaction: [base64.encode(t.tx), "base64"], meta: t.meta } : null;
    }
    if (m === "getSignaturesForAddress") return (p[1] as { before?: string }).before === undefined ? Object.keys(txs).map((signature) => ({ signature, slot: 9, err: null })) : [];
    throw new Error(m);
  }) as SolanaRpc;
/** The tag 3's own accounts, its lookups' keys resolved (the kit's message.ts order): the ones spendOwner gives back
 *  with a spend that is mine, for the send onward to refuse as To (review LOW 4). */
const ixAccounts = ({ tx, loaded }: { tx: Uint8Array; loaded: { writable: string[]; readonly: string[] } }): string[] => {
  const m = solanaDecodeMessage(tx.subarray(129));
  const keys = [...m.staticKeys, ...loaded.writable, ...loaded.readonly];
  return [...new Set(m.instructions.find((ix) => keys[ix.programIndex] === PROGRAM)!.accounts.map((i) => keys[i]!))];
};
const ownerOf = (rpc: SolanaRpc, release?: string) => spendOwner([rpc, rpc], { program: PROGRAM, feePayer: FEE_PAYER }, BUY_W, NH, contextOfBuy(BUY_RELEASE), 0, release, new Map());

test("this device's own landed tag 3 is its spend: mine by its signature, and mine from W's history", async () => {
  const { tx, loaded } = await buyTx(BUY_RELEASE, BUY_SIG);
  const rpc = chainOf({ [BUY_SIG]: { tx, meta: { err: null, loadedAddresses: loaded } } });
  const accounts = ixAccounts({ tx, loaded });
  assert.ok(accounts.includes(BUY_W) && accounts.length > 3);
  assert.deepEqual(await ownerOf(rpc, BUY_SIG), { mine: BUY_SIG, accounts });
  assert.deepEqual(await ownerOf(rpc), { mine: BUY_SIG, accounts }, "the spend's own signature, from W's history");
  // a hint that is not the spend (the helper's word for another transaction): the spend found in W's history names its own
  assert.deepEqual(await ownerOf(rpc, OTHER_BUY_SIG), { mine: BUY_SIG, accounts });
});

test("a tag 3 to W under another attempt's context (another device's salt) is another's spend: other", async () => {
  const salt = BUY_RELEASE.salt.slice();
  salt[0] ^= 0xff;
  const { tx, loaded } = await buyTx({ ...BUY_RELEASE, salt }, OTHER_BUY_SIG);
  const rpc = chainOf({ [OTHER_BUY_SIG]: { tx, meta: { err: null, loadedAddresses: loaded } } });
  assert.equal(await ownerOf(rpc), "other");
  assert.equal(await ownerOf(rpc, OTHER_BUY_SIG), "other");
});

test("a tag 3 whose loaded keys are not known (none, a count off, a key that is not one) is no one's spend: never mine", async () => {
  const { tx, loaded } = await buyTx(BUY_RELEASE, BUY_SIG);
  for (const meta of [
    { err: null },
    { err: null, loadedAddresses: null },
    { err: null, loadedAddresses: { writable: loaded.writable.slice(1), readonly: loaded.readonly } },
    { err: null, loadedAddresses: { writable: loaded.writable, readonly: [...loaded.readonly, loaded.readonly[0]!] } },
    { err: null, loadedAddresses: { writable: loaded.writable.map((k, i) => (i === 0 ? "x" : k)), readonly: loaded.readonly } },
  ]) assert.equal(await ownerOf(chainOf({ [BUY_SIG]: { tx, meta } }), BUY_SIG), null, JSON.stringify(meta).slice(0, 80));
});

test("tag 3's flags as the program reads them: the next-page bit beside the compressed one is still the spend; an unknown bit never is", async () => {
  const next = await buyTx(BUY_RELEASE, BUY_SIG, (d) => void (d[1] = 3));
  assert.deepEqual(await ownerOf(chainOf({ [BUY_SIG]: { tx: next.tx, meta: { err: null, loadedAddresses: next.loaded } } }), BUY_SIG), { mine: BUY_SIG, accounts: ixAccounts(next) });
  const bad = await buyTx(BUY_RELEASE, BUY_SIG, (d) => void (d[1] = 5));
  assert.equal(await ownerOf(chainOf({ [BUY_SIG]: { tx: bad.tx, meta: { err: null, loadedAddresses: bad.loaded } } }), BUY_SIG), null);
});

test("keysOf with two lookup tables: the static keys, then every lookup's writable keys, then every lookup's readonly ones (the kit's message.ts order)", () => {
  const k = (n: number): string => base58.encode(new Uint8Array(32).fill(n));
  const message = { staticKeys: [k(1), k(2)], lookups: [{ table: k(90), writable: [0, 3], readonly: [1] }, { table: k(91), writable: [2], readonly: [0, 4] }] } as unknown as Parameters<typeof keysOf>[0];
  // getTransaction's loadedAddresses: table 1's writables, table 2's; then table 1's readonly, table 2's
  const loadedAddresses = { writable: [k(10), k(13), k(22)], readonly: [k(11), k(20), k(24)] };
  assert.deepEqual(keysOf(message, { err: null, loadedAddresses }), [k(1), k(2), k(10), k(13), k(22), k(11), k(20), k(24)]);
  assert.equal(keysOf(message, { err: null, loadedAddresses: { writable: loadedAddresses.writable.slice(0, 2), readonly: loadedAddresses.readonly } }), null, "a writable count off");
  assert.equal(keysOf(message, { err: null, loadedAddresses: { writable: loadedAddresses.writable, readonly: [...loadedAddresses.readonly, k(25)] } }), null, "a readonly count off");
  assert.equal(keysOf(message, { err: null }), null, "none");
  assert.deepEqual(keysOf({ ...message, lookups: [] }, { err: null }), [k(1), k(2)], "no lookups: the static keys only");
});

// Card signpage-sent-read-back: the helper's word for a release's signature is a name to read back, never a fact; the
// op's txs (its answer and every stage write the app reads) name a release only as both RPCs read it as that release.
test("the helper answers a well-formed signature that is not the release's, and the release lands: the op names the release's own, never the helper's", async () => {
  const fake = base58.encode(new Uint8Array(64).fill(7));
  const wd = await world([30_000_000n], { helperSig: fake });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "sent");
  const release = [...wd.landed.keys()][0]!;
  assert.deepEqual(a.txs, [{ chain: "solana", hash: release }, { chain: "solana", hash: base58.encode(wd.onwards()[0]!.subarray(1, 65)) }]);
  for (const txs of [a.txs, ...wd.stageTxs]) assert.ok(!txs.some((t) => t.hash === fake), "the helper's word is in no txs the app reads");
});

test("the helper's signature never read back: the op stops with no transaction of it", async () => {
  const wd = await world([30_000_000n], { readBack: "none", landed: false });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "stopped");
  assert.deepEqual(a.txs, []);
  for (const txs of wd.stageTxs) assert.ok(!txs.some((t) => t.hash === SIG), "the helper's word is in no stage write");
});

// Card pool-buy-filled-2s, review P3d of 1caf0b17: the withdraw's release goes through the same send and settle
// (pool-buy.ts sendAndSettle), so the finality gate, the slots the settle is held to, its back-off and the run's bound
// hold here too. The world's release lands at slot 22; each test reads its own run's settles and waits.
const settles = (wd: Awaited<ReturnType<typeof world>>, throws: (n: number) => boolean = () => false) => {
  const asked: { slots: number[] | null; at: number }[] = [];
  const settle = wd.host.settle;
  const log: string[] = [];
  const rpcs = wd.host.rpcs.map((rpc, p) => (async (m: string, q: readonly unknown[]) => (log.push(`${p}:${m}`), rpc(m, q))) as SolanaRpc) as unknown as PoolWithdrawHost["rpcs"];
  wd.host.rpcs = rpcs;
  wd.host.settle = async (id, m) => {
    asked.push({ slots: m ? [...m] : null, at: log.length });
    log.push("settle");
    if (throws(asked.length)) throw new Error("restore: the lister refused");
    return settle(id, m);
  };
  return { asked, log };
};

test("withdraw, card pool-buy-filled-2s: no settle before both RPCs' finalized slot reaches the release's slot; then one, held to those slots", async () => {
  const wd = await world([30_000_000n], { txSlot: 22, finalizedSlot: (p, i) => (p === 1 && i < 3 ? 18 : 25) });
  const s = settles(wd);
  const a = await runPoolWithdraw({ ...wd.host, reads: 10 }, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "sent");
  assert.deepEqual(s.asked[0]!.slots, [25, 25], "held to the finalized slots read");
  assert.equal(s.log.slice(0, s.asked[0]!.at).filter((x) => x === "1:getSlot").length, 4, "three reads short of the release's slot, the fourth at it");
});

test("withdraw, card pool-buy-filled-2s: a settle that throws is asked again only after a wait that doubles from the slot's time", async () => {
  const wd = await world([30_000_000n], { txSlot: 20 });
  const s = settles(wd, (n) => n <= 3);
  const waits: number[] = [];
  const a = await runPoolWithdraw({ ...wd.host, reads: 10, wait: async (ms) => void waits.push(ms) }, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "sent");
  assert.equal(s.asked.length, 4);
  assert.deepEqual(waits, [800, 1_600, 3_200]);
});

test("withdraw, card pool-buy-filled-2s: a settle that always throws ends the part at the run's bound (POOL_BUY_SETTLE_MS), in under 20 settles, the send owed", async () => {
  const wd = await world([30_000_000n], { txSlot: 20 });
  const s = settles(wd, () => true);
  let t = Number(NOW);
  const a = await runPoolWithdraw({ ...wd.host, reads: POOL_BUY_READS, now: () => BigInt(t), wait: async (ms) => void (t += ms) }, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "in_transit");
  assert.ok(t - Number(NOW) <= POOL_BUY_SETTLE_MS, `${t - Number(NOW)} ms`);
  assert.ok(s.asked.length < 20, `${s.asked.length} settles`);
});

// Review of 418af7d5 (P3-4): the buy suite's rules on the shared send and settle, held on the withdraw path too, where a
// not_landed would drop the owed send. Past the gate a settle that finds no spend decides nothing: the part stays owed
// at the run's bound, its settles at a doubling wait; a finalized-slot read that fails asks no settle that round; a
// throttle's wait is the doubling one, a Retry-After only when it is a number and at most POOL_BUY_RETRY_AFTER_MAX_MS.
const throttle = (retryAfterMs: number | null) => new SolanaRpcTransportError("http_429", "HTTP 429", 3, "rpc1", retryAfterMs);
const onRpc1 = (wd: Awaited<ReturnType<typeof world>>, f: (m: string, q: readonly unknown[], inner: SolanaRpc) => unknown) => {
  const inner = wd.host.rpcs[1];
  wd.host.rpcs = [wd.host.rpcs[0], (async (m: string, q: readonly unknown[]) => f(m, q, inner)) as SolanaRpc] as unknown as PoolWithdrawHost["rpcs"];
};

test("review of 418af7d5: withdraw, past the gate a settle that finds no spend never ends the part not landed: it stays owed at the run's bound, under 20 settles", async () => {
  const wd = await world([30_000_000n], { txSlot: 20, settleUnspent: true });
  const s = settles(wd);
  let t = Number(NOW);
  const a = await runPoolWithdraw({ ...wd.host, reads: POOL_BUY_READS, now: () => BigInt(t), wait: async (ms) => void (t += ms) }, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "in_transit", "the send owed, never dropped");
  assert.ok(!wd.stages.includes("stopped"));
  assert.ok(s.asked.length > 1 && s.asked.length < 20, `${s.asked.length} settles`);
  assert.ok(t - Number(NOW) <= POOL_BUY_SETTLE_MS, `${t - Number(NOW)} ms`);
});

test("review of 418af7d5: withdraw, a finalized-slot read that fails asks no settle that round", async () => {
  const wd = await world([30_000_000n], { txSlot: 20 });
  let fails = 0;
  onRpc1(wd, (m, q, inner) => {
    if (m === "getSlot" && fails < 2) throw (fails++, new Error("rpc1: socket hang up"));
    return inner(m, q);
  });
  const s = settles(wd);
  const a = await runPoolWithdraw({ ...wd.host, reads: 10, wait: async () => {} }, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "sent");
  assert.equal(s.asked.length, 1);
  assert.equal(s.log.slice(0, s.asked[0]!.at).filter((x) => x === "0:getSlot").length, 3, "the settle only on the third round, the first whose read went through");
});

test("review of 418af7d5: withdraw, a throttled finalized-slot read waits twice as long each time, and the slot's pace once a read goes through", async () => {
  const wd = await world([30_000_000n], { txSlot: 22, finalizedSlot: (_p, i) => (i < 2 ? 21 : 25) });
  let throttles = 0;
  onRpc1(wd, (m, q, inner) => {
    if (m === "getSlot" && throttles < 3) throw (throttles++, throttle(null));
    return inner(m, q);
  });
  const waits: number[] = [];
  const a = await runPoolWithdraw({ ...wd.host, reads: 20, wait: async (ms) => void waits.push(ms) }, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "sent");
  assert.deepEqual(waits.slice(0, 5), [800, 1_600, 3_200, 400, 400], waits.join(","));
});

for (const [name, after, want] of [["past POOL_BUY_RETRY_AFTER_MAX_MS (60 s)", 60_000, 10_000], ["no number (NaN)", Number.NaN, 800]] as const)
  test(`review of 418af7d5: withdraw, a read-back throttled with a Retry-After ${name} waits ${want} ms`, async () => {
    const wd = await world([30_000_000n], { txSlot: 20 });
    let once = false;
    onRpc1(wd, (m, q, inner) => {
      if (m === "getTransaction" && !once) throw ((once = true), throttle(after));
      return inner(m, q);
    });
    const waits: number[] = [];
    const a = await runPoolWithdraw({ ...wd.host, reads: 10, wait: async (ms) => void waits.push(ms) }, ASK, TO, 5_000_000n, COST);
    assert.equal(a.stage, "sent");
    assert.equal(waits[0], want, waits.join(","));
  });

test("review of 418af7d5: withdraw, a release slot the finalized slots never reach holds the settle at most POOL_BUY_GATE_MAX_MS, its slots read a few times, never every slot", async () => {
  const wd = await world([30_000_000n], { txSlot: 1_000, finalizedSlot: () => 25 });
  const s = settles(wd);
  let t = Number(NOW);
  const at: number[] = [];
  const settle = wd.host.settle;
  wd.host.settle = (id, m) => (at.push(t - Number(NOW)), settle(id, m));
  const a = await runPoolWithdraw({ ...wd.host, reads: POOL_BUY_READS, now: () => BigInt(t), wait: async (ms) => void (t += ms) }, ASK, TO, 5_000_000n, COST);
  assert.equal(a.stage, "sent");
  assert.ok(at[0]! >= 30_000 && at[0]! <= 30_000 + 2_000, `the first settle at ${at[0]} ms`);
  const before = s.log.slice(0, s.asked[0]!.at).filter((x) => x === "1:getSlot").length;
  assert.ok(before <= 8, `${before} getSlot on RPC 1 before it`);
});

test("review of 418af7d5: withdraw, a release with no signature to read back whose settle always throws asks it at a doubling wait: under 20 settles by the run's bound, the part not stopped", async () => {
  const wd = await world([30_000_000n], { helper502: true, landed: false, finalHeight: 50 });
  const s = settles(wd, () => true);
  let t = Number(NOW);
  const a = await runPoolWithdraw({ ...wd.host, reads: POOL_BUY_READS, now: () => BigInt(t), wait: async (ms) => void (t += ms) }, ASK, TO, 5_000_000n, COST);
  assert.notEqual(a.stage, "stopped");
  assert.ok(s.asked.length > 1 && s.asked.length < 20, `${s.asked.length} settles`);
  assert.ok(t - Number(NOW) <= POOL_BUY_SETTLE_MS + 2_000, `${t - Number(NOW)} ms`);
});
