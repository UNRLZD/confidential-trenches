// node --test packages/signpage/test/restore-speed.test.ts: how long SIGN_HOST's restore takes from the words accepted to
// the Solana pool's notes in the note store, where state.pools' balance is drawn from them (src/pools.ts), for an account
// of 8 pool notes, 3 buys and 2 sells in the pinned Solana pool (card closed-positions-after-a-restore). Recorded shapes
// only, never mainnet: the pool's mark and page accounts byte for byte as the program writes them, on a fake lister and
// a fake pair that each answer every call RTT_MS later, each held to the page's pacing (solanaPacedRpc at
// SOLANA_KEYLESS_RPC_LIMIT, PAGE_SOL_MARK_BATCHES). The all-zero test seed's notes; test values, never money.
// - The reads: the Solana restore alone at a walk gap of 1, so its time is its round trips (printed: seven in a row, the
//   two sizes' lists one after the other so a lister's refusal stops before the next list, each list's mark reads on
//   both RPCs side by side, the pages on both side by side, then both sizes listed again past the pages).
// - The whole wait: the page's run (poolRestore auto, the real solanaRestoreNotes) beside the two EVM pools mainnet pins,
//   each modelled by its reads (EVM_READS round trips) and then evmRestoreNotes's own walk (8 lanes, walkLaneYielding),
//   all on this one thread as on the page; then the same with the pools' walks in Workers (card
//   restore-shows-the-balance-in-seconds: the page's walk-worker.js, here node:worker_threads running walk-worker.ts as
//   the wallet's walk-lanes test does). Each asserts the order, never seconds (scripts/ci/no-wall-clock-asserts.mjs): the
//   Solana notes are in the store before the first EVM walk ends, and with Workers every Solana lane walked in one. The
//   seconds are printed, for the record; the browser run measures them.
// RESTORE_SPEED_GAP=10000 runs the whole wait at the production walk gap (RESTORE_GAP) and prints it.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Worker } from "node:worker_threads";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore } from "@blindfill/wallet/store";
import { solanaPacedRpc, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import * as d from "../../wallet/src/derive/index.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { RESTORE_LANES, slices, walkLaneYielding, withSeed, type SeedUse } from "../../wallet/src/notes/restore.ts";
import { solanaRestoreNotes } from "../../wallet/src/pool/solana-restore.ts";
import { poolRestore, type RestorePool } from "../src/pool-restore.ts";
import type { WalkPort } from "../../wallet/src/restore/walk.ts";
import { PAGE_SOL_MARK_BATCHES } from "../src/pool-testnet.ts";
// the pool, its accounts byte for byte, and one provider's answers (shared with scripts/restore-speed-browser.mjs)
import { PROGRAM, RTT_MS, SCOPE, SEED, solanaAnswer } from "./restore-speed-pool.ts";

const EVM_READS = 30;
const GAP = Number(process.env.RESTORE_SPEED_GAP ?? 1000);
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

// one provider: the pool's accounts at slot 1,000, every answer RTT_MS after its call, in the page's pacing
let calls = 0;
function provider(url: string, rtt: number): SolanaRpc {
  const f = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    calls++;
    await sleep(rtt);
    return solanaAnswer(method, params);
  };
  return solanaPacedRpc(Object.assign(f, { url }));
}
let urls = 0;
const solanaReads = (rtt: number) => {
  const n = urls++;
  return { rpcs: [provider(`https://seat-${n}.example`, rtt), provider(`https://helper-${n}.example`, rtt)] as const, lister: provider(`https://marks-${n}.example`, rtt) };
};

const secs = (ms: number): string => (ms / 1000).toFixed(2);

test("the Solana restore's reads: the marks and pages of 8 notes, 3 buys and 2 sells, timed", async () => {
  const r = solanaReads(RTT_MS);
  const t0 = performance.now();
  const got = await solanaRestoreNotes({ seed64: SEED, program: PROGRAM, rpcs: r.rpcs, lister: r.lister, markBatches: PAGE_SOL_MARK_BATCHES, gap: 1 });
  console.log(`restore-speed reads: ${secs(performance.now() - t0)} s at ${RTT_MS} ms a round trip (${got.notes.length} notes)`);
  assert.equal(got.notes.length, 8);
  assert.equal(got.notes.filter((n) => n.state === "SPENT").length, 3);
});

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

// a Worker of the page's walk, on node:worker_threads (as packages/wallet/test/walk-lanes.test.ts)
let spawned = 0;
const nodeWalker = (): WalkPort => {
  const w = new Worker(new URL("../../wallet/test/walk-worker-node.mjs", import.meta.url));
  closers.push(() => void w.terminate());
  spawned++;
  return {
    postMessage: (m) => w.postMessage(m),
    addEventListener: (type, f) => void w.on(type, type === "message" ? (data: unknown) => f({ data }) : () => f({})),
    terminate: () => void w.terminate(),
  };
};

/** The page's run beside the two EVM pools; what happened, in order, and when (printed only). */
async function wholeWait(workers: boolean): Promise<{ order: string[]; at: Record<string, number>; t0: number }> {
  const store = await openWalletStore({ name: `restore-speed-${workers}`, indexedDB: new IDBFactory() });
  closers.push(() => store.close());
  const r = solanaReads(RTT_MS);
  const pools: RestorePool[] = [
    { chain: "solana", program: PROGRAM, scope: SCOPE, rpcs: () => r.rpcs, lister: () => r.lister, cache: {}, markBatches: PAGE_SOL_MARK_BATCHES },
    { chain: "evm", pin: { network: "base-sepolia", pool: "0x1", feeRecipient: "0x2", fromBlock: 1n }, scope: 22n, rpcs: () => [] },
    { chain: "evm", pin: { network: "robinhood-testnet", pool: "0x3", feeRecipient: "0x4", fromBlock: 1n }, scope: 33n, rpcs: () => [] },
  ];
  const order: string[] = [];
  const at: Record<string, number> = {};
  const mark = (what: string): void => {
    if (at[what] !== undefined) return;
    order.push(what);
    at[what] = performance.now();
  };
  const solanaIn = async (): Promise<void> => {
    if (at.solana !== undefined) return;
    const notes = await openNoteStore(store);
    try {
      if ((await notes.list()).filter((n) => n.scope === SCOPE).length === 8) mark("solana");
    } finally {
      notes.close();
    }
  };
  const w = poolRestore({
    store: async () => store,
    seed64: async () => SEED.slice(),
    signedIn: async () => true,
    pools: () => pools,
    ids: null,
    pausesMs: [],
    written: () => void solanaIn(),
    ...(workers ? { walkers: nodeWalker } : {}),
    solana: ((a: Parameters<typeof solanaRestoreNotes>[0]) => solanaRestoreNotes({ ...a, gap: GAP })) as never,
    // an EVM pool as evmRestoreNotes runs it with wallets false: its reads, then its walk of 8 lanes on this thread (in
    // the walk's turn when the page gives one), no note of this seed
    evm: (async (a: { seed64: SeedUse; signal?: AbortSignal; turn?: <T>(f: () => Promise<T>) => Promise<T> }) => {
      for (let k = 0; k < EVM_READS; k++) await sleep(RTT_MS);
      const walk = async (): Promise<void> => {
        const m = await withSeed(a.seed64, (s) => d.masters(s, "deposit"));
        const slice = slices(a.signal);
        for (let lane = 0; lane < RESTORE_LANES; lane++) await walkLaneYielding(m, 22n, lane, () => false, GAP, null, a.signal, slice);
        mark("evm walk");
      };
      await (a.turn ? a.turn(walk) : walk());
      return { notes: [], spends: [], elsewhere: [], wallets: [], block: 1n };
    }) as never,
  });
  const t0 = performance.now();
  const first = w.auto();
  // until the Solana notes are in and the first EVM walk has ended (or the run ends); the test's timeout bounds it
  while ((at.solana === undefined || at["evm walk"] === undefined) && order.length < 2) {
    if (await Promise.race([first.then(() => true, () => true), sleep(20).then(() => false)])) break;
  }
  w.signedOut();
  await first.catch(() => {});
  await w.idle();
  return { order, at, t0 };
}

test("the whole wait on the page's one thread: the Solana pool's notes are in the store before the first EVM walk ends", { timeout: 900_000 }, async () => {
  const { order, at, t0 } = await wholeWait(false);
  console.log(`restore-speed whole wait, one thread: Solana notes in the store at ${secs((at.solana ?? Number.NaN) - t0)} s, first EVM walk ended at ${secs((at["evm walk"] ?? Number.NaN) - t0)} s; walk gap ${GAP}, ${RTT_MS} ms a round trip`);
  assert.deepEqual(order, ["solana", "evm walk"]);
});

test("the whole wait with the walks in Workers: every Solana lane walked in a Worker, its notes in the store before the first EVM walk ends", { timeout: 900_000 }, async () => {
  spawned = 0;
  const { order, at, t0 } = await wholeWait(true);
  console.log(`restore-speed whole wait, Workers: Solana notes in the store at ${secs((at.solana ?? Number.NaN) - t0)} s, first EVM walk ended at ${secs((at["evm walk"] ?? Number.NaN) - t0)} s; ${spawned} Workers; walk gap ${GAP}, ${RTT_MS} ms a round trip`);
  assert.deepEqual(order, ["solana", "evm walk"]);
  assert.equal(spawned, RESTORE_LANES, "one Worker a Solana lane (the EVM model walks on this thread)");
});
