// The testnet build's pool pins and providers (card signpage-pool-flow): with __SIGN_NETWORK__ "testnet", as
// scripts/build-app.mjs sets it for that build, SOL_POOLS pins the devnet pool of contracts/pool-solana's deployment
// record and the helper's devnet fee payer, the page asks two devnet RPCs for Solana and the testnet pins' two RPCs for
// Base Sepolia and Robinhood testnet, and a pool buy on the pinned devnet pool reaches the flow. Another chain (no EVM
// pool pinned), a page with no flow, or the mainnet tables are refused. Its own file: the network is read once, at
// import, so this process runs as the testnet build does (test/pool-network.test.ts runs the mainnet one).
import { after, afterEach, mock, test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { VAULT_FIELD_P, vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import type { SolanaPoolCache } from "../../wallet/src/pool/solana-restore.ts";
import { SOLANA_PROVIDER_A, SOLANA_PUBLIC_SEAT } from "../src/trade.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { SOL_POOLS, SOL_POOL_TABLES, solanaPoolOf, SOL_LADDER, SOL_EPOCH_MS, SOL_LIFE_MS, SOL_SEND_MARGIN_MS } = await import("../../wallet/src/pool/solana.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { EVM_POOLS } = await import("../../wallet/src/pool/evm.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { PoolSendRefused } = await import("../src/pool-buy.ts");
const { PAGE_CLUSTER, TESTNET_RPCS, PAGE_SOL_MARK_BATCHES, testnetPoolDeps, testnetPool: makePool, poolRelayFee, helperPoolSend, POOL_SEND_TIMEOUT_MS, PAGE_TABLES, settleFreedOps, oweSend, dropSend, keepRelease, keepEvmSend, mergeWithdrawOp, writeEvmStage, writeEvmFinish, helperPoolSendPieces, piecesOwedOf } = await import("../src/pool-testnet.ts");
// Every page a test makes signs out at the test's end, as main.ts's sign out does (signingOut: its turn timer cleared).
// A state read arms the page's EVM turn (src/pool-testnet.ts armTurn) on whichever clock is in place; a page left signed
// in on the real clock can fire its turn inside a later test's test clock, which re-arms it there for good ("the test
// left 1 timer(s) that never stop", test/passes-yield.test.ts in CI, 11 Nov).
const pages: { signingOut(): void }[] = [];
afterEach(() => pages.splice(0).forEach((p) => p.signingOut()));
const testnetPool = ((...a: Parameters<typeof makePool>) => {
  const t = makePool(...a);
  pages.push(t);
  return t;
}) as typeof makePool;
// Whether `p` settles inside `ms` of real time: a hang bound on the real clock, taken before any test clock or mocked
// timer goes in, for a test on the test clock that waits for work the clock cannot see (fake IndexedDB, a Web Lock)
const [REAL_SET, REAL_CLEAR] = [globalThis.setTimeout, globalThis.clearTimeout];
const realWithin = (p: Promise<unknown>, ms: number): Promise<boolean> =>
  new Promise((ok) => {
    const t = REAL_SET(() => ok(false), ms);
    const end = (): void => (REAL_CLEAR(t), ok(true));
    p.then(end, end);
  });
const { SIGNPAGE_TIMEOUT_MS } = await import("../../kit/src/signpage/client.ts");
// the withdraw tests' world, loaded once here so its stores close after the whole file (its after() is file-level)
const WORLD = await import("./pool-withdraw-world.ts");
type Ask = import("../src/rules/pool.ts").PoolAsk;
type QueuePassT = import("../../wallet/src/pool/queue.ts").QueuePass;

const RECORD = JSON.parse(readFileSync(new URL("../../../scripts/live-checks/pool-sol-deploy.devnet.json", import.meta.url), "utf8")) as { cluster: string; program_id: string; pool: string };
// GET https://ct-api.unrealized.trade/v1/pool/fee?cluster=devnet&pool=D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef,
// read 3 Nov 21:07Z: fee_payer 9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb (the helper's devnet key, which the new pool keeps)
const FEE_PAYER = "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb";
const SOL_TOKEN = "So11111111111111111111111111111111111111112";
const EVM_TOKEN = "0xF111111111111111111111111111111111111111";
const ctx = { id: "r1", sha: "00", progress: () => {} };
const buy = (chain: string) => ({ chain, token: chain === "solana" ? SOL_TOKEN : EVM_TOKEN, amount: "0.01", slippage_bps: 100 });

test("the testnet build pins the devnet pool of the deployment record and the helper's devnet fee payer; no mainnet pool", () => {
  assert.equal(POOL_TESTNET, true);
  assert.equal(RECORD.cluster, "devnet");
  assert.deepEqual({ ...SOL_POOLS.devnet }, { program: RECORD.program_id, feePayer: FEE_PAYER });
  assert.equal(solanaPoolOf(SOL_POOLS.devnet!.program).pool, RECORD.pool, "the record's pool is the program's pool account");
  assert.equal(SOL_POOLS.mainnet, undefined);
  assert.ok(Object.isFrozen(SOL_POOLS) && Object.isFrozen(SOL_POOLS.devnet));
});

test("the testnet build's providers: two devnet RPCs, and each EVM testnet's two from its pins", () => {
  const deps = testnetPoolDeps();
  const urls = (c: "solana" | "base" | "robinhood") => deps.rpcs(c)!.map((r) => (r as unknown as { url: string }).url);
  // card pool-buy-send-fast: the second is the helper's devnet route, as mainnet's second is its /v1/rpc/solana
  assert.deepEqual(urls("solana"), ["https://api.devnet.solana.com/", "https://ct-api.unrealized.trade/v1/rpc/solana-devnet"]);
  // card notes-per-pool-evm-base-hang: the kit's pool pair, never sepolia.base.org's 200-block log pages
  assert.deepEqual(urls("base"), ["https://base-sepolia-rpc.publicnode.com/", "https://base-testnet.api.pocket.network/"]);
  assert.deepEqual(TESTNET_RPCS.base, evmPoolVenues()["base-sepolia"].providers);
  assert.deepEqual(TESTNET_RPCS.robinhood, evmPoolVenues()["robinhood-testnet"].providers);
  assert.deepEqual(urls("robinhood"), ["https://rpc.testnet.chain.robinhood.com/", "https://robinhood-sepolia-rpc.publicnode.com/"]);
  for (const c of ["solana", "base", "robinhood"] as const) assert.notEqual(new URL(TESTNET_RPCS[c][0]).host, new URL(TESTNET_RPCS[c][1]).host, `${c}: two operators`);
});

test("a pool buy on the pinned devnet pool reaches the flow; another chain, no flow, or the mainnet pins are refused", async () => {
  const asks: Ask[] = [];
  const flow = (ask: Ask) => (asks.push(ask), { error: "busy" as const });
  const k = poolKinds(testnetPoolDeps(flow));
  assert.deepEqual(k["pool.buy"](buy("solana"), ctx), { error: "busy" }, "the flow's answer");
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0], { kind: "pool.buy", chain: "solana", token: SOL_TOKEN, amount: 10_000_000n, slippageBps: 100, decimals: 9 });
  // the testnet build pins Base Sepolia's and Robinhood testnet's pools (EVM_POOLS, card evm-pool-pins): their buys
  // reach the flow, which alone decides; a chain with no pin is refused
  for (const chain of ["base", "robinhood"]) assert.deepEqual(k["pool.buy"](buy(chain), ctx), { error: "busy" }, chain);
  assert.deepEqual(asks.slice(1).map((a) => a.chain), ["base", "robinhood"]);
  // the testnet flow runs a pinned chain's EVM buy (card signpage-evm-pool-buy: test/pool-testnet-evm-queue.test.ts) and
  // refuses one on a chain it pins no pool for, before any store or seed read
  const real = testnetPool({ store: async () => assert.fail("no store read"), seed64: async () => assert.fail("no seed read") }, { evmPin: () => undefined }).flow;
  for (const chain of ["base", "robinhood"]) assert.deepEqual(poolKinds(testnetPoolDeps(real))["pool.buy"](buy(chain), ctx), { error: "not_allowed" }, `${chain}: the flow refuses it`);
  const unpinned = poolKinds({ ...testnetPoolDeps(flow), pinned: (c) => c === "solana" });
  for (const chain of ["base", "robinhood"]) assert.deepEqual(unpinned["pool.buy"](buy(chain), ctx), { error: "not_allowed" }, `${chain} unpinned`);
  assert.equal(asks.length, 3);
  // a testnet page with no flow
  assert.deepEqual(poolKinds(testnetPoolDeps())["pool.buy"](buy("solana"), ctx), { error: "not_allowed" });
  // the mainnet table: nothing pinned
  assert.deepEqual(poolKinds({ ...testnetPoolDeps(flow), pinned: (c) => c === "solana" && SOL_POOLS.mainnet !== undefined })["pool.buy"](buy("solana"), ctx), { error: "not_allowed" });
  assert.equal(asks.length, 3);
});

test("the testnet flow (card signpage-pool-notes): a Solana pool.deposit runs the deposit kind; every other op is refused", async () => {
  let opened = 0;
  // a store that fails to open: the run ends at once, with no RPC read. No EVM pin here: the build's own pins run a
  // Base or Robinhood deposit (test/pool-testnet-evm-deposit.test.ts), and without one it is refused
  const flow = testnetPool({ store: async () => (opened++, Promise.reject(new Error("no store"))), seed64: async () => new Uint8Array(64) }, { evmPin: () => undefined }).flow;
  const k = poolKinds(testnetPoolDeps(flow));
  const d = k["pool.deposit"]({ chain: "solana", amount: "0.01" }, ctx) as { running?: true; after: Promise<unknown>; answer: () => unknown };
  assert.equal(d.running, true);
  await d.after;
  assert.deepEqual(d.answer(), { error: "failed" });
  assert.equal(opened, 1);
  assert.deepEqual(k["pool.deposit"]({ chain: "base", amount: "0.01" }, ctx), { error: "not_allowed" });
});

test("the testnet build pins the devnet pool's lookup tables by venue, so its pool.buy runs (cards signpage-pool-flow-run, sol-pool-venue-tables)", async () => {
  // the wallet's SOL_POOL_TABLES.devnet: each venue's generations, as deployments/devnet.json records them
  assert.equal(PAGE_TABLES, SOL_POOL_TABLES.devnet);
  assert.ok(PAGE_TABLES["pump-curve"] !== undefined);
  let opened = 0;
  const flow = testnetPool({ store: async () => (opened++, Promise.reject(new Error("no store"))), seed64: async () => new Uint8Array(64) }).flow;
  const r = poolKinds(testnetPoolDeps(flow))["pool.buy"](buy("solana"), ctx) as { running?: true; after: Promise<unknown>; answer: () => unknown };
  assert.equal(r.running, true, "the pinned table: the buy runs");
  await r.after;
  assert.deepEqual(r.answer(), { error: "failed" }, "a queue that cannot open: failed, nothing sent");
  // the run's open; its end then writes its ops record and reads the positions again (card signpage-state-holdings),
  // each opening the store, which cannot open here: nothing written, nothing read
  assert.ok(opened >= 1);
});

// ---- card signpage-pool-notes-2: the next buy's proof after each deposit, and settling on the page's state reads ----

const SCOPE = solanaPoolOf(SOL_POOLS.devnet!.program).scope;
const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const RUNG = 10_000_000n; // SOL_LADDER.min
const NOW = 1_800_000_000_000n + 1_000n; // an epoch's start + 1 s, in the pool's time
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

async function wallet(): Promise<{ w: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  return { w, ns };
}
const sig = (k: number) => base58.encode(new Uint8Array(64).fill(k));
/** A note of the devnet pool's scope, INCOMING with its send: as pool-deposit.ts writes it before the tx leaves. */
async function incoming(ns: NoteStore, ref: NoteRef | null, k: number): Promise<NoteRecord> {
  const planned = ref === null ? await ns.planDeposit(SCOPE, (r) => noteSecrets(SEED64, r).precommitment) : await ns.add({ ref, scope: SCOPE, precommitment: noteSecrets(SEED64, ref).precommitment, state: "PLANNED" });
  return ns.move(planned.id, "PLANNED", "INCOMING", { send: { signature: sig(k), value: RUNG, last_valid_block_height: 1_000n } });
}
/** A fake devnet pool whose trees hold the leaves landed so far; its context hashes W and the deadline. */
function fakePool() {
  const state: bigint[] = [];
  const labels: bigint[] = [];
  const pool: Pool<{ w: string }> = {
    id: "test:devnet",
    chain: "sol",
    scope: SCOPE,
    ladder: SOL_LADDER,
    epochMs: SOL_EPOCH_MS,
    lifeMs: SOL_LIFE_MS,
    sendMarginMs: SOL_SEND_MARGIN_MS,
    now: async () => NOW,
    trees: async () => {
      const s = new VaultTree(state), l = new VaultTree(labels);
      return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
    },
    bind: async (b) => {
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|${b.deadlineMs}`);
      return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: 1_000n, request: { w: b.wallet.address } };
    },
  };
  /** The note's deposit lands: its leaves on both trees, the note UNSPENT, as pool-deposit.ts's finish() writes it. */
  const land = async (ns: NoteStore, n: NoteRecord): Promise<NoteRecord> => {
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(labels.length + 1));
    const commitment = noteCommitment(RUNG, label, n.precommitment);
    state.push(commitment);
    labels.push(label);
    return ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value: RUNG, label, commitment, leafIndex: BigInt(state.length - 1) } });
  };
  return { pool, land };
}
const states = async (ns: NoteStore) => (await ns.list()).filter((n) => n.scope === SCOPE).map((n) => n.state);

test("the next buy's proof: a landed deposit starts one proof, a second deposit refreshes it, none for a note still INCOMING, and sign out stops it", async () => {
  const { w, ns } = await wallet();
  const { pool, land } = fakePool();
  const prover = signalsProver();
  let stops = 0;
  let signedIn = true;
  const t = testnetPool(
    { store: async () => w, seed64: async () => (signedIn ? SEED64.slice() : Promise.reject(new Error("no seed is stored"))) },
    { pool, prover: { vault: prover, stop: () => void stops++ }, hardwareConcurrency: 4 },
  );
  const proves = () => prover.log.filter((x) => x.startsWith("prove")).length;
  // the deposit note lands: the run's landed hook runs the queue's pass, which proves it
  const first = await land(ns, await incoming(ns, null, 1));
  t.host().landed!(first);
  await t.proofs(); // passes run one after another: this one waits for the hook's
  assert.equal(proves(), 1, "one proof for the landed note");
  assert.deepEqual(await states(ns), ["HELD"]);
  // a second arrival of the same U, still INCOMING: no proof for it
  const second = await incoming(ns, { kind: "second", id: { id: "U", s: SCOPE, i: (first.ref as { i: number }).i }, n: 0 }, 2);
  assert.equal((await t.proofs())?.made.length, 0);
  assert.equal(proves(), 1, "no proof starts for a note still INCOMING");
  // it lands: the hook refreshes the queue, which proves it too
  t.host().landed!(await land(ns, second));
  await t.proofs();
  assert.equal(proves(), 2);
  assert.deepEqual((await states(ns)).sort(), ["HELD", "HELD"]);
  // sign out: the queue closes (its notes freed), the worker ends; a landing after it opens no queue
  signedIn = false;
  await t.signedOut();
  assert.equal(stops, 1);
  assert.deepEqual((await states(ns)).sort(), ["UNSPENT", "UNSPENT"], "the queue's notes freed");
  t.host().landed!(first);
  assert.equal(await t.proofs(), null, "no queue without a seed");
  assert.equal(proves(), 2);
  assert.deepEqual((await states(ns)).sort(), ["UNSPENT", "UNSPENT"]);
});

test("card signpage-pool-pins: a page that loads with the pool's notes landed opens the queue on a state read; its proofs reach ready() and the watchers hear the pass", async () => {
  const { w, ns } = await wallet();
  const { pool, land } = fakePool();
  const prover = signalsProver();
  const offline = async () => {
    throw new Error("offline");
  };
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pool, prover: { vault: prover, stop: () => {} }, hardwareConcurrency: 4, rpcs: [offline, async () => offline()] });
  let heard = 0;
  t.watch(() => heard++);
  const proves = () => prover.log.filter((x) => x.startsWith("prove")).length;
  // no note of the pool: a state read opens no queue
  await t.stateRead();
  assert.equal((await t.readyWith(async () => null)).ready, undefined, "no queue open: no ready list, so state.pools has no ready");
  assert.equal(proves(), 0);
  // a note landed before this page loaded (UNSPENT, no landing hook here): the state read opens the queue and proves it
  await land(ns, await incoming(ns, null, 9));
  await t.stateRead();
  await t.proofs(); // passes run one after another: this one waits for the state read's
  assert.equal(proves(), 1);
  const { ready } = await t.readyWith(async () => null);
  assert.equal(ready?.length, 1);
  assert.equal(ready![0]!.poolId, pool.id);
  assert.equal(heard, 1, "the pass that made the proof is heard; the empty pass after it is not");
  // what state.pools then carries for it (src/pools.ts): the chunk ready
  const { withPools } = await import("../src/pools.ts");
  const { solanaBalancePool } = await import("../../wallet/src/pool/balances.ts");
  const { stateOf } = await import("../src/state.ts");
  const out = await withPools(stateOf(true, { source: "code", code_saved: true }, []), async () => ns.list(), [solanaBalancePool(pool.id, SCOPE)], ready);
  assert.deepEqual(out.pools, [{ chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01" }]);
  // a state read while the queue is open runs a pass (the epoch's proofs made again when due), one at a time
  const a = t.stateRead();
  await a;
  await t.proofs();
  assert.equal(proves(), 1, "nothing new to prove in the same epoch");
  await t.signedOut();
  assert.equal((await t.readyWith(async () => null)).ready, undefined, "signed out: no queue, no ready list");
});

test("a state read proves the landed notes whatever its settle steps do: a deposit settle that throws or never ends, an owed pieces' read that throws, a kept sell's read that throws", async () => {
  const offline = async () => {
    throw new Error("offline");
  };
  const never = new Promise<never>(() => {});
  // the wallet store with one meta record that reads `ok` times (the state read's checks) and then throws, or with
  // `hang` never answers (the settle's own read)
  const flaky = (w: WalletStore, key: string, rec: unknown, ok: number, hang = false): WalletStore => {
    let reads = 0;
    return new Proxy(w, {
      get(target, prop) {
        if (prop === "get")
          return async (s: string, k: string) => {
            if (s === "meta" && k === key) {
              if (reads++ < ok) return rec;
              if (hang) return never;
              throw new Error(`planted: the store read of ${key} fails`);
            }
            return (target.get as (s: string, k: string) => Promise<unknown>)(s, k);
          };
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  // Web Locks whose request fails (the sell settle's seed lock): the sell settle throws
  const locks = { request: async () => assert.fail("planted: the lock request fails"), query: async () => ({ held: [], pending: [] }) } as unknown as Pick<LockManager, "request" | "query">;
  const cases: { name: string; incoming: boolean; store?: (w: WalletStore) => WalletStore; over: Record<string, unknown> }[] = [
    { name: "the deposit settle throws", incoming: true, over: { depositKinds: { solana: () => () => assert.fail("planted: the deposit settle throws") } } },
    { name: "the deposit settle never ends", incoming: true, over: { depositKinds: { solana: () => () => ({ running: true, after: never, answer: () => null }) } } },
    // resumeOwedPieces catches what resumePieces throws (src/pool-testnet.ts resumeOwedPieces); its list read that never
    // answers (the third: the state read's check, its own, resumePieces') holds the read
    { name: "the owed pieces' settle never ends", incoming: false, store: (w) => flaky(w, "owed/pieces-sol", { W1: { address: "W1", primary: "p", pieces: ["q"] } }, 2, true), over: {} },
    { name: "the sell settle's lock throws", incoming: false, store: (w) => flaky(w, "owed/kept-sell-sol", { s1: { signature: "s1", tx: "", last: 0 } }, 99), over: { locks } },
  ];
  const got: string[] = [];
  for (const c of cases) {
    const { w, ns } = await wallet();
    const { pool, land } = fakePool();
    const prover = signalsProver();
    await land(ns, await incoming(ns, null, 1));
    if (c.incoming) await incoming(ns, null, 2);
    const store = c.store ? c.store(w) : w;
    const t = testnetPool({ store: async () => store, seed64: async () => SEED64.slice() }, { pool, prover: { vault: prover, stop: () => {} }, hardwareConcurrency: 4, rpcs: [offline, async () => offline()], locks: null, ...c.over });
    const proves = () => prover.log.filter((x) => x.startsWith("prove")).length;
    void t.stateRead(); // it may wait on its settle for good: the pass is not behind it
    for (let i = 0; i < 100 && proves() === 0; i++) await new Promise((r) => setTimeout(r, 20));
    got.push(`${c.name}: ${proves()} proved, ${(await t.readyWith(async () => null)).ready?.length ?? "no"} ready`);
    await t.signedOut();
  }
  assert.deepEqual(got, cases.map((c) => `${c.name}: 1 proved, 1 ready`));
});

// review P3-3 of 92ae9ded1 (the line 71556b56b added): a state read's settle step that lands an INCOMING note (here a
// sell's return note, landed by the sell's verdict under the seed lock) runs one more proof pass, so that note is proved
// in the same read; the read's first pass, started before the settle, listed the notes before it landed
test("a state read whose sell settle lands the sell's return note proves that note in the same read", async () => {
  const { WALLET_SEED_LOCK } = await import("@blindfill/wallet/store");
  const offline = async () => {
    throw new Error("offline");
  };
  const { w, ns } = await wallet();
  const { pool, land } = fakePool();
  const prover = signalsProver();
  const proves = () => prover.log.filter((x) => x.startsWith("prove")).length;
  await land(ns, await incoming(ns, null, 1));
  const back = await incoming(ns, { kind: "return", c: "sol", l: 7n, j: 1 }, 2);
  let landed = false;
  // the sell's verdict, under the seed lock settleSells takes: the return note lands once the read's first pass is
  // proving (it listed the notes before); every other lock runs as asked
  const locks = {
    request: async (name: string, opts: unknown, cb?: (l: unknown) => Promise<unknown>) => {
      const run = typeof opts === "function" ? (opts as (l: unknown) => Promise<unknown>) : cb!;
      if (name === WALLET_SEED_LOCK && !landed) {
        for (let k = 0; k < 2_000 && proves() === 0; k++) await new Promise((ok) => setImmediate(ok));
        landed = true;
        await land(ns, back);
        return;
      }
      return run({ name, mode: "shared" });
    },
    query: async () => ({ held: [], pending: [] }),
  } as unknown as Pick<LockManager, "request" | "query">;
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pool, prover: { vault: prover, stop: () => {} }, hardwareConcurrency: 4, rpcs: [offline, async () => offline()], locks, depositKinds: { solana: () => () => ({ error: "not_allowed" }) } } as never);
  try {
    await t.stateRead();
    assert.ok(landed, "the sell settle landed the return note");
    for (let i = 0; i < 100 && proves() < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(proves(), 2, "the return note the settle landed was not proved in that read");
    assert.ok((await t.readyWith(async () => null)).ready?.some((r) => r.noteId === back.id), "the return note is ready");
  } finally {
    await t.signedOut();
  }
});

test("a proof pass's console line: each code with its count, in its order; none for a pass with nothing failed", async () => {
  const { passLine, PASS_CODES } = await import("../src/pool-testnet.ts");
  const { PassFail } = await import("../../wallet/src/pool/queue.ts");
  const f = (reason?: string) => ({ noteId: "n", error: "x", ...(reason ? { reason } : {}) }) as QueuePassT["failed"][number];
  const pass = (failed: QueuePassT["failed"], small?: number): QueuePassT => ({ made: [], remade: [], failed, ...(small ? { small } : {}) });
  assert.deepEqual([...PASS_CODES], ["network", "fee_refused", "prover_failed", "too_small", "held_elsewhere"]);
  assert.equal(passLine("solana", pass([f("held_elsewhere"), f("prover_failed"), f("network"), f("fee_refused"), f("prover_failed")], 3)), "pool pass: solana failed network=1 fee_refused=1 prover_failed=2 too_small=3 held_elsewhere=1");
  for (const code of ["network", "fee_refused", "prover_failed", "held_elsewhere"]) assert.equal(passLine("base", pass([f(code)])), `pool pass: base failed ${code}=1`);
  assert.equal(passLine("solana", pass([], 2)), "pool pass: solana failed too_small=2");
  assert.equal(passLine("solana", undefined, new PassFail("network", new Error("429"))), "pool pass: solana failed network=1", "a pass that failed whole at a pool read");
  assert.equal(passLine("solana", pass([f()])), null, "a failure the queue names no step for prints nothing");
  assert.equal(passLine("solana", pass([])), null);
  assert.equal(passLine("solana", undefined, new Error("no seed is stored")), null, "a queue that could not open is no pass's failure");
});

test("a proof pass that fails prints one 'pool pass:' line per change, the codes alone: never the error's text, an address or a note", async () => {
  const { w, ns } = await wallet();
  const { pool, land } = fakePool();
  const ADDRESS = "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb";
  const ok = signalsProver();
  let fail = true;
  const prover = { ...ok, prove: async (c: string, i: unknown) => (fail ? Promise.reject(new Error(`provider 403 for ${ADDRESS}: limit`)) : ok.prove(c as never, i as never)) } as typeof ok;
  const lines: string[] = [];
  const log = mock.method(console, "log", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  try {
    const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pool, prover: { vault: prover, stop: () => {} }, hardwareConcurrency: 4, locks: null });
    const note = await land(ns, await incoming(ns, null, 1));
    await t.proofs();
    await t.proofs(); // the same failure again: no second line
    assert.deepEqual(lines.filter((l) => l.startsWith("pool pass:")), ["pool pass: solana failed prover_failed=1"]);
    const all = lines.join("\n");
    for (const secret of [ADDRESS, "403", "limit", note.id]) assert.ok(!all.includes(secret), `no ${secret} in the console`);
    // the prover works again: the proof is made, nothing printed; a later failure prints again
    fail = false;
    await t.proofs();
    assert.equal((await t.readyWith(async () => null)).ready?.length, 1);
    assert.equal(lines.filter((l) => l.startsWith("pool pass:")).length, 1);
    await t.signedOut();
  } finally {
    log.mock.restore();
  }
});

test("the testnet build's pool RPCs, every chain and both providers, read through a 429 once", async () => {
  const real = globalThis.fetch;
  const seen = new Map<string, number>();
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    if (n === 1) return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "0" } });
    const id = (JSON.parse(String(init?.body)) as { id: string }).id;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 42 }), { status: 200 });
  }) as typeof fetch;
  try {
    const deps = testnetPoolDeps();
    for (const chain of ["solana", "base", "robinhood"] as const) {
      for (const r of deps.rpcs(chain)!) assert.equal(await (r as unknown as (m: string, p: unknown[]) => Promise<unknown>)("getSlot", []), 42);
      for (const u of TESTNET_RPCS[chain]) assert.equal(seen.get(u), 2, u);
    }
  } finally {
    globalThis.fetch = real;
  }
});

test("card pool-buy-send-fast: the testnet build's second Solana provider is the helper's /v1/rpc/solana-devnet, as mainnet's is its /v1/rpc/solana, read with the kit's HELPER_FETCH_INIT; no 1-request-a-second public provider", async () => {
  // onfinality's public devnet endpoint (x-ratelimit-limit-sec 1, limit-day 1000, read 5 Nov 15:03Z) held the 5 Nov
  // 13:50:55Z buy 11.2 s in the page's reads: 26 of its answers were 429
  const HELPER = "https://ct-api.unrealized.trade";
  assert.deepEqual([...TESTNET_RPCS.solana], ["https://api.devnet.solana.com", `${HELPER}/v1/rpc/solana-devnet`]);
  const real = globalThis.fetch;
  const inits = new Map<string, RequestInit | undefined>();
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    inits.set(String(u), init);
    const id = (JSON.parse(String(init?.body)) as { id: string }).id;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 7 }), { status: 200 });
  }) as typeof fetch;
  try {
    const [a, b] = testnetPoolDeps().rpcs("solana")! as unknown as ((m: string, p: unknown[]) => Promise<unknown>)[];
    assert.equal(await a!("getSlot", []), 7);
    assert.equal(await b!("getSlot", []), 7);
  } finally {
    globalThis.fetch = real;
  }
  const helper = inits.get(`${HELPER}/v1/rpc/solana-devnet`);
  assert.ok(helper, "the second read went to the helper's devnet route");
  assert.equal(helper!.credentials, "omit");
  assert.equal(helper!.referrerPolicy, "no-referrer");
  assert.equal(inits.get("https://api.devnet.solana.com")?.credentials, undefined, "the public provider read plainly");
});

test("the devnet pool's relay fee: GET /v1/pool/fee on the helper for the pool and the epoch; another status or an oversized answer is refused", async () => {
  // GET https://ct-api.unrealized.trade/v1/pool/fee?cluster=devnet&pool=D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef, 3 Nov 21:07Z, its
  // shape (apps/helper/src/pool/fee.ts PoolFeeAnswer), here for the pinned pool
  const pool = solanaPoolOf(SOL_POOLS.devnet!.program).pool;
  const answer = { chain: "solana", cluster: "devnet", program: SOL_POOLS.devnet!.program, pool, fee_payer: FEE_PAYER, epoch_ms: 60000, epoch_start_ms: 1800000000000, fee: "1300000", step: "100000" };
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const fetchOf = (status: number, body: string) => (async (url: string | URL | Request, init?: RequestInit) => (asked.push({ url: String(url), init }), new Response(body, { status }))) as typeof fetch;
  assert.deepEqual(await poolRelayFee(pool, 1_800_000_000_000n, undefined, fetchOf(200, JSON.stringify(answer))), answer);
  assert.equal(asked[0]!.url, `https://ct-api.unrealized.trade/v1/pool/fee?cluster=devnet&pool=${pool}&epoch=1800000000000`);
  assert.equal(asked[0]!.init?.credentials, "omit");
  assert.equal(asked[0]!.init?.redirect, "error");
  await assert.rejects(poolRelayFee(pool, 1_800_000_000_000n, undefined, fetchOf(404, `{"error":{"code":"not_found"}}`)), /HTTP 404/);
  await assert.rejects(poolRelayFee(pool, 1_800_000_000_000n, undefined, fetchOf(200, JSON.stringify({ ...answer, pad: "x".repeat(1024) }))), /over 1024 B/);
});

// card buy-spends-several-pieces: the pass's console line names a fee read that got no answer "network", never the
// fee_refused a refusal reads as, so a walk tells a throttle from a refusal
test("the pool fee read: no connection, no answer in time, or still busy (429, 5xx) is network; another status untagged", async () => {
  const { PassFail } = await import("../../wallet/src/pool/pool.ts");
  const pool = solanaPoolOf(SOL_POOLS.devnet!.program).pool;
  const fetchOf = (status: number) => (async () => new Response(status === 429 ? `{"error":{"code":"rate_limited"}}` : "{}", { status })) as typeof fetch;
  const reasonOf = async (f: typeof fetch) => {
    const e = await poolRelayFee(pool, 1_800_000_000_000n, undefined, f, async () => {}).then(() => assert.fail("answered"), (x: unknown) => x);
    return e instanceof PassFail ? e.reason : `untagged: ${String(e)}`;
  };
  assert.equal(await reasonOf(fetchOf(429)), "network");
  assert.equal(await reasonOf(fetchOf(502)), "network");
  assert.equal(await reasonOf((async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch), "network");
  assert.equal(await reasonOf((async () => Promise.reject(new DOMException("no answer", "TimeoutError"))) as typeof fetch), "network");
  assert.match(await reasonOf(fetchOf(404)), /^untagged: .*HTTP 404/);
  // what a withdraw records of that failure (pool-sell.ts legCause): the cause's class and code, never the tag's frames
  // and never a message (review P3-2 of b8df326b6: "Error at <the wrap>" where it read "TypeError")
  const { legCause } = await import("../src/pool-sell.ts");
  const causeOf = async (f: typeof fetch) => legCause(await poolRelayFee(pool, 1_800_000_000_000n, undefined, f, async () => {}).catch((x: unknown) => x));
  const typeErr = await causeOf((async () => Promise.reject(new TypeError("fetch failed for 9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb"))) as typeof fetch);
  assert.match(typeErr, /^TypeError( at [\w$.]+( < [\w$.]+)?)?$/, typeErr);
  const timeout = await causeOf((async () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))) as typeof fetch);
  assert.match(timeout, /^TimeoutError 23( at .*)?$/, timeout);
  for (const c of [typeErr, timeout]) assert.ok(!/fetch failed|9T3R|timed out/.test(c), `a message reached the cause: ${c}`);
  // the caller's own abort is no step's failure
  const stop = new AbortController();
  stop.abort();
  const e = await poolRelayFee(pool, 1_800_000_000_000n, stop.signal, (async (_u: unknown, init?: RequestInit) => Promise.reject(init?.signal?.reason)) as typeof fetch).catch((x: unknown) => x);
  assert.ok(!(e instanceof PassFail), "an abort tagged");
});

test("the pool fee, busy (card withdraw-fee-busy-waits): 429 rate_limited or 503 upstream waits its Retry-After, capped, and asks again, BUSY_ASKS asks at most; any other status refuses at once", async () => {
  const { BUSY_ASKS, BUSY_WAIT_FIRST_MS, BUSY_WAIT_MAX_MS } = await import("../../wallet/src/busy.ts");
  const pool = solanaPoolOf(SOL_POOLS.devnet!.program).pool;
  const answer = { chain: "solana", cluster: "devnet", program: SOL_POOLS.devnet!.program, pool, fee_payer: FEE_PAYER, epoch_ms: 60000, epoch_start_ms: 1800000000000, fee: "1300000", step: "100000" };
  type A = { status: number; body: unknown; retryAfter?: string };
  const run = async (answers: A[]) => {
    let asks = 0;
    const slept: number[] = [];
    const fetchFn = (async () => {
      const a = answers[Math.min(asks++, answers.length - 1)]!;
      return new Response(JSON.stringify(a.body), { status: a.status, headers: a.retryAfter === undefined ? {} : { "retry-after": a.retryAfter } });
    }) as typeof fetch;
    const out = poolRelayFee(pool, 1_800_000_000_000n, undefined, fetchFn, async (ms: number) => void slept.push(ms));
    return { out, slept, asks: () => asks };
  };
  const busy = { status: 429, body: { error: { code: "rate_limited" } }, retryAfter: "1" };
  const good = { status: 200, body: answer };
  // a 429 with Retry-After 1, then a 200: the fee
  let r = await run([busy, good]);
  assert.deepEqual(await r.out, answer);
  assert.deepEqual(r.slept, [1_000]);
  // a 503 upstream naming no wait: BUSY_WAIT_FIRST_MS
  r = await run([{ status: 503, body: { error: { code: "upstream" } } }, good]);
  assert.deepEqual(await r.out, answer);
  assert.deepEqual(r.slept, [BUSY_WAIT_FIRST_MS]);
  // a 429 that never clears: refused after BUSY_ASKS asks, the waits within the bound
  r = await run([{ ...busy, retryAfter: "75" }]);
  await assert.rejects(r.out, /HTTP 429/);
  assert.equal(r.asks(), BUSY_ASKS);
  assert.ok(r.slept.length === BUSY_ASKS - 1 && r.slept.every((ms) => ms <= BUSY_WAIT_MAX_MS));
  // a 400 refuses at once
  r = await run([{ status: 400, body: { error: { code: "bad_shape" } }, retryAfter: "1" }, good]);
  await assert.rejects(r.out, /HTTP 400/);
  assert.equal(r.asks(), 1);
  assert.deepEqual(r.slept, []);
  // the kit's other 503 codes are no busy answer (review of 407ba3bc, P3): each refuses at once
  for (const code of ["relayer_low", "token_halted", "index_behind"]) {
    r = await run([{ status: 503, body: { error: { code } }, retryAfter: "1" }, good]);
    await assert.rejects(r.out, /HTTP 503/, code);
    assert.equal(r.asks(), 1, code);
    assert.deepEqual(r.slept, [], code);
  }
  // a Retry-After over the cap waits only the cap
  r = await run([{ ...busy, retryAfter: "3600" }, good]);
  assert.deepEqual(await r.out, answer);
  assert.deepEqual(r.slept, [BUSY_WAIT_MAX_MS]);
});

test("a state read settles a pool note still INCOMING, one pass at a time; with none open it reads nothing on chain", async () => {
  const { w, ns } = await wallet();
  const calls: string[] = [];
  // the devnet RPCs are not reached here: each read fails, so a settle pass ends at its first read
  const rpc = async (m: string) => {
    calls.push(m);
    throw new Error("offline");
  };
  // a store open the test holds: made to wait while `armed`, at the moment it is asked for
  let armed = false;
  let open!: () => void;
  const gate = new Promise<void>((ok) => (open = ok));
  const store = async () => {
    if (armed) await gate;
    return w;
  };
  const t = testnetPool({ store, seed64: async () => SEED64.slice() }, { rpcs: [rpc, async (m: string) => rpc(m)], prover: { vault: signalsProver(), stop: () => {} } });
  await t.stateRead();
  assert.deepEqual(calls, [], "no note open: no pass, no read");
  await incoming(ns, null, 3);
  // two state reads at once, the second's note read held until the first's pass has ended (the CI race on a loaded
  // runner, made certain): one pass, whose first read is the pool account on both RPCs
  const first = t.stateRead();
  armed = true;
  const second = t.stateRead();
  armed = false;
  await first;
  open();
  await second;
  assert.deepEqual(calls, ["getAccountInfo", "getAccountInfo"]);
  // a later read, the note still INCOMING: settled again
  await t.stateRead();
  assert.equal(calls.length, 4);
  assert.deepEqual(await states(ns), ["INCOMING"]);
});

test("a state read runs the RESERVED pass (card signpage-pool-buy fold 1): a note a buy left RESERVED is read on both RPCs, held while they fail", async () => {
  const { w, ns } = await wallet();
  const calls: string[] = [];
  const rpc = async (m: string) => {
    calls.push(m);
    throw new Error("offline");
  };
  const seeds: Uint8Array[] = [];
  const t = testnetPool({ store: async () => w, seed64: async () => (seeds.push(SEED64.slice()), seeds.at(-1)!) }, { rpcs: [rpc, async (m: string) => rpc(m)], prover: { vault: signalsProver(), stop: () => {} } });
  // a landed note, taken by a buy (HELD -> RESERVED), whose send never answered
  const { land } = fakePool();
  let n = await land(ns, await incoming(ns, null, 5));
  n = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: NOW + 60_000n, context: "1" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt! });
  await t.stateRead();
  // the pass's first read: each RPC's finalized slot; offline, so the note is held, never freed blind
  assert.deepEqual(calls, ["getSlot", "getSlot"]);
  assert.deepEqual(await states(ns), ["RESERVED"]);
  assert.equal(seeds.length, 1);
  assert.ok(seeds[0]!.every((b) => b === 0), "the pass's seed copy is zeroed");
  // a later read tries again (the load's rent backs, card round-trip-costs-less, read on their own: the Rent sysvar for
  // the W this note paid, in the background)
  await t.stateRead();
  assert.equal(calls.filter((m) => m === "getSlot").length, 4);
  assert.deepEqual(await states(ns), ["RESERVED"]);
});

test("fold 2 (2): the RESERVED pass runs under the seed's shared lock: a sign out during it waits for it; after it, none starts", async () => {
  const { w, ns } = await wallet();
  // the pass's first read held open until the test lets it go
  let release!: () => void;
  const held = new Promise<void>((ok) => (release = ok));
  let reads = 0;
  const rpc = async (m: string) => {
    reads++;
    if (m === "getSlot") await held;
    throw new Error("offline");
  };
  let signedIn = true;
  const seed64 = async () => {
    if (!signedIn) throw new Error("no seed: signed out");
    return SEED64.slice();
  };
  const t = testnetPool({ store: async () => w, seed64 }, { rpcs: [rpc, async (m: string) => rpc(m)], prover: { vault: signalsProver(), stop: () => {} } });
  const { land } = fakePool();
  let n = await land(ns, await incoming(ns, null, 6));
  n = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: NOW + 60_000n, context: "1" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt! });
  const pass = t.stateRead();
  while (reads === 0) await new Promise((r) => setTimeout(r, 1));
  // the store's sign out takes the seed lock exclusive: it waits while the pass holds it shared
  let out = false;
  const signOut = navigator.locks.request("ct-wallet/seed", { mode: "exclusive" }, async () => {
    signedIn = false;
    out = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out, false, "the sign out waits for the pass");
  release();
  await pass;
  await signOut;
  assert.equal(out, true);
  assert.deepEqual(await states(ns), ["RESERVED"]);
  // signed out: the next state read's pass ends at its seed read, with no chain read
  const before = reads;
  await t.stateRead();
  assert.equal(reads, before);
  // no Web Locks: no pass at all
  const bare = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { rpcs: [rpc, async (m: string) => rpc(m)], prover: { vault: signalsProver(), stop: () => {} }, locks: null });
  await bare.stateRead();
  assert.equal(reads, before);
});

test("review P2-1 of a34c1626: a sign out stops the Solana RESERVED pass's settle at its next read: no read after it, the note held; the pass runs on the page's cache", async () => {
  const { w, ns } = await wallet();
  // the lister's first answer held until the test lets it go; the pair answers the time and nothing else
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const calls: string[] = [];
  const rpc = async (m: string) => {
    calls.push(m);
    if (m === "getSlot") return 700;
    if (m === "getBlockTime") return Number(NOW / 1_000n);
    throw new Error(`unexpected ${m}`);
  };
  const lister = async (m: string) => {
    calls.push(`lister ${m}`);
    await gate;
    return { context: { slot: 700 }, value: [{ pubkey: base58.encode(new Uint8Array(32).fill(3)) }] };
  };
  const cache: SolanaPoolCache = {};
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { rpcs: [rpc, async (m: string) => rpc(m)], lister, cache, prover: { vault: signalsProver(), stop: () => {} } });
  const { land } = fakePool();
  let n = await land(ns, await incoming(ns, null, 7));
  n = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: NOW + 60_000n, context: "1" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt! });
  const pass = t.stateRead();
  while (!calls.includes("lister getProgramAccounts")) await new Promise((r) => setTimeout(r, 1));
  assert.ok(cache.pages !== undefined, "the pass's settle runs on the page's cache");
  const before = calls.length;
  t.signingOut();
  release();
  await pass;
  // the listed address is never read: the settle stopped at its next read
  assert.deepEqual(calls.slice(before), []);
  assert.deepEqual(await states(ns), ["RESERVED"]);
});

test("review P2-1 and P2-2 of a34c1626, P2-1 and P3-3 of e3489b3b: every Solana settle on the page reads on the settle pair with the page's batches, and passes the sign-out stop's signal taken before its first wait and the page's cache, in every path (buy, reserved pass, owed finish, withdraw)", () => {
  const src = readFileSync(new URL("../src/pool-testnet.ts", import.meta.url), "utf8");
  // the buy's set settle (card buy-spends-several-pieces: every piece's note on one read of the marks) one more site
  const calls = [...src.matchAll(/solanaSettle(?:SpentSet|Spent|Reserved)\(\{[^}]*\}\)/g)].map((m) => m[0]);
  assert.equal(calls.length, 5);
  // the reserved pass's on the pair's pass reads (card signpage-passes-yield-to-a-trade), the rest on its trade reads, and
  // the buy's on its own kind: a trade's to its release, a pass's after it (card sell-right-after-a-buy), its one call so
  for (const c of calls) assert.match(c, /, rpcs: settleRpcs\((?:"pass"|kind)?\), lister: lister\((?:"pass"|kind)?\), signal, cache, markBatches: PAGE_SOL_MARK_BATCHES \}\)$/, c);
  assert.deepEqual(calls.filter((c) => c.includes("(kind)")), calls.filter((c) => c.includes("minSlots, rpcs: settleRpcs(kind), lister: lister(kind),")), "a kind only where the pair and the lister both take it");
  assert.equal(calls.filter((c) => c.includes("settleRpcs(kind)")).length, 2, "the buy's alone: its settle and its set settle");
  // each site's signal is the stop's when the call began: four takes, and the stop read elsewhere only where a trade's
  // reads wait before a signature (card start-reads-wait-out-a-throttle): the buy's and the sell's host, each taken when
  // the host is made, and a pool kind's request (outSignal), each ending its waits at the next sign out. The sell host's
  // one take also stops its sale's finder list (card wallets-found-in-one-read, review P3 of 8da6b97f): the host's
  // signal and the list's reads are the same stop, taken once when the host is made
  assert.equal([...src.matchAll(/const signal = solanaStop\.signal;/g)].length, 6, "the five settles' and the sell host's");
  const sellHost = src.slice(src.indexOf("const sellHost = "), src.indexOf("const sell = (over.tradeKinds?.sell"));
  assert.equal([...sellHost.matchAll(/const signal = solanaStop\.signal;/g)].length, 1, "the sell host's take, when the host is made");
  assert.ok(sellHost.indexOf("const signal = solanaStop.signal;") < sellHost.indexOf("return {"), "taken before the host's first wait");
  assert.match(sellHost, /await poolBuyWallets\(await store\(\), r, ask, signal\)/, "the sale's finder list on that stop");
  assert.match(sellHost, /\n {6}signal,\n/, "the host's own signal the same stop");
  assert.equal([...src.matchAll(/ signal: solanaStop\.signal,/g)].length, 1, "the buy host's");
  assert.equal([...src.matchAll(/outSignal: \(\) => solanaStop\.signal,/g)].length, 1);
  // the Solana deposit host's stop: its waits between attempts end at a sign out's tap (review of f0e7bd38, P2-1)
  assert.equal([...src.matchAll(/ stop: solanaStop\.signal,/g)].length, 1);
  // the state read's pass: its one more pass after it never runs past a sign out
  assert.equal([...src.matchAll(/const stop = solanaStop\.signal;\n {4}passing = proofs\(\)/g)].length, 1);
  // every read of the stop: the six takes, the buy host's, outSignal, the deposit host's stop and the state pass's
  assert.equal([...src.matchAll(/solanaStop\.signal/g)].length, 10);
  // the settle pair: the page's two seats, the helper's with the window-long retry
  assert.match(src, /solanaPacedRpc\(pageHelperRpc\(TRADE_HELPER, SOLANA_RPC_WINDOW_RETRY, kind\)\)\]/);
  assert.match(src, /solanaPacedRpc\(testnetRpc\(TESTNET_RPCS\.solana\[1\], SOLANA_RPC_WINDOW_RETRY, kind\)\)\]/);
  assert.deepEqual(PAGE_SOL_MARK_BATCHES, [10, 100]);
});

test("review P3-3 of e3489b3b: a sign out that comes while the RESERVED pass reads its seed stops the pass before any read", async () => {
  const { w, ns } = await wallet();
  let letSeed!: () => void;
  const seedGate = new Promise<void>((ok) => (letSeed = ok));
  let seedAsked = 0;
  const calls: string[] = [];
  const rpc = async (m: string) => {
    calls.push(m);
    if (m === "getSlot") return 700;
    if (m === "getBlockTime") return Number(NOW / 1_000n);
    throw new Error(`unexpected ${m}`);
  };
  const lister = async (m: string) => {
    calls.push(`lister ${m}`);
    return { context: { slot: 700 }, value: [{ pubkey: base58.encode(new Uint8Array(32).fill(3)) }] };
  };
  const t = testnetPool({ store: async () => w, seed64: async () => (seedAsked++, await seedGate, SEED64.slice()) }, { rpcs: [rpc, async (m: string) => rpc(m)], lister, cache: {}, prover: { vault: signalsProver(), stop: () => {} } });
  const { land } = fakePool();
  let n = await land(ns, await incoming(ns, null, 7));
  n = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: NOW + 60_000n, context: "1" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt! });
  const pass = t.stateRead();
  while (seedAsked === 0) await new Promise((r) => setTimeout(r, 1));
  const before = calls.length;
  t.signingOut();
  letSeed();
  await pass;
  assert.deepEqual(calls.slice(before), []);
  assert.deepEqual(await states(ns), ["RESERVED"]);
});

/** A page with one RESERVED Solana note whose pass's settle waits at its lister's first answer until `release`. */
async function heldPass() {
  const { w, ns } = await wallet();
  const gates: (() => void)[] = [];
  const calls: string[] = [];
  const rpc = async (m: string) => {
    calls.push(m);
    if (m === "getSlot") return 700;
    if (m === "getBlockTime") return Number(NOW / 1_000n);
    throw new Error(`unexpected ${m}`);
  };
  const lister = async (m: string) => {
    calls.push(`lister ${m}`);
    await new Promise<void>((ok) => gates.push(ok));
    return { context: { slot: 700 }, value: [{ pubkey: base58.encode(new Uint8Array(32).fill(3)) }] };
  };
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { rpcs: [rpc, async (m: string) => rpc(m)], lister, cache: {}, prover: { vault: signalsProver(), stop: () => {} } });
  const { land } = fakePool();
  let n = await land(ns, await incoming(ns, null, 7));
  n = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: NOW + 60_000n, context: "1" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt! });
  const listed = async (k: number) => {
    while (calls.filter((c) => c === "lister getProgramAccounts").length < k) await new Promise((r) => setTimeout(r, 1));
  };
  return { t, ns, calls, listed, release: () => gates.splice(0).forEach((g) => g()) };
}

test("another tab's sign out (signedOut) stops the Solana RESERVED pass's settle at its next read, as this tab's signingOut does", async () => {
  const { t, ns, calls, listed, release } = await heldPass();
  const pass = t.stateRead();
  await listed(1);
  const before = calls.length;
  const out = t.signedOut();
  release();
  await pass;
  await out;
  assert.deepEqual(calls.slice(before), []);
  assert.deepEqual(await states(ns), ["RESERVED"]);
});

test("a sign out stops only the settles running then: the next pass after it reads again (the stop's controller is a new one)", async () => {
  const { t, calls, listed, release } = await heldPass();
  const first = t.stateRead();
  await listed(1);
  t.signingOut();
  release();
  await first;
  const second = t.stateRead();
  // the next pass reaches its lister: a stop that kept the aborted controller would stop it before any read
  await Promise.race([listed(2), new Promise((_, no) => setTimeout(() => no(new Error(`the pass after the sign out read nothing: ${calls.join(",")}`)), 2_000))]);
  release();
  await second;
});

test("main.ts's sign out stops the pool settles (testnet?.signingOut()) before the store signs out, and closes the pools (signedOut) after", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const body = /async function signOut\(\): Promise<void> \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
  const at = (x: string) => body.indexOf(x);
  assert.ok(at("testnet?.signingOut();") > 0, "signingOut is called");
  assert.ok(at("testnet?.signingOut();") < at("await s.signOut("), "before the store's sign out");
  assert.ok(at("await s.signOut(") < at("await testnet?.signedOut();"), "signedOut after it");
});

test("the page's queue runs on solanaPool with the devnet pin and the page's two devnet RPCs: a landing reads the pool's time on both", async () => {
  const { w, ns } = await wallet();
  const calls: string[][] = [[], []];
  const rpcOf = (k: 0 | 1) => async (m: string) => {
    calls[k]!.push(m);
    throw new Error("offline");
  };
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { rpcs: [rpcOf(0), rpcOf(1)], prover: { vault: signalsProver(), stop: () => {} }, hardwareConcurrency: 4 });
  const { land } = fakePool();
  t.host().landed!(await land(ns, await incoming(ns, null, 4)));
  await t.proofs();
  assert.ok(calls[0]!.length > 0 && calls[1]!.length > 0, "both RPCs read");
  assert.ok(calls.every((c) => c.every((m) => ["getSlot", "getBlockTime", "getBlockHeight", "getMultipleAccounts", "getAccountInfo"].includes(m))), calls.flat().join(","));
  assert.deepEqual(await states(ns), ["UNSPENT"], "a pass that cannot read the pool holds no note");
  await t.signedOut();
});

// ---- card signpage-pool-buy: pool.buy on the devnet pool once its lookup table is pinned ----

test("pool.buy runs on the pinned devnet pool once a lookup table is pinned; with none it is refused with no read", async () => {
  let opened = 0;
  const page = { store: async () => (opened++, Promise.reject(new Error("no store"))), seed64: async () => new Uint8Array(64) };
  const reads: string[] = [];
  const offline = (n: string) => Object.assign(async (m: string) => (reads.push(m), Promise.reject(new Error("offline"))), { url: `https://${n}.invalid` });
  const k = poolKinds(testnetPoolDeps(testnetPool(page, { tables: { "pump-curve": [base58.encode(new Uint8Array(32).fill(9))] }, rpcs: [offline("a"), offline("b")] }).flow));
  const r = k["pool.buy"](buy("solana"), ctx) as { running?: true; after: Promise<unknown>; answer: () => unknown };
  assert.equal(r.running, true, "the buy runs");
  await r.after;
  assert.deepEqual(r.answer(), { error: "failed" }, "a queue that cannot open: failed, nothing sent");
  // the run's open; its end's records and positions pass open it too (card signpage-state-holdings): nothing read
  assert.ok(opened >= 1);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(reads, [], "no proof ready: no read");
  const before = opened;
  const none = poolKinds(testnetPoolDeps(testnetPool(page, { tables: {} }).flow));
  assert.deepEqual(none["pool.buy"](buy("solana"), ctx), { error: "not_allowed" });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(opened, before, "no table: no store opened, no read");
});

test("a pool send still pending at the kind's 10 s, and at 90 s, is not aborted: its own window is over 90 s", async () => {
  assert.equal(SIGNPAGE_TIMEOUT_MS["pool.buy"], 10_000);
  assert.ok(POOL_SEND_TIMEOUT_MS > 90_000);
  enableTimers(mock.timers, { apis: ["setTimeout"] });
  try {
    let signal!: AbortSignal;
    let answer!: (r: Response) => void;
    const slow = ((_url: string, init: RequestInit) => {
      signal = init.signal!;
      return new Promise<Response>((ok, no) => {
        answer = ok;
        signal.addEventListener("abort", () => no(signal.reason));
      });
    }) as unknown as typeof fetch;
    // still pending at the kind's 10 s and at 90 s: then answered, and taken
    const p = helperPoolSend("P", Uint8Array.of(1), slow);
    mock.timers.tick(SIGNPAGE_TIMEOUT_MS["pool.buy"]);
    assert.equal(signal.aborted, false, "not aborted at 10 s");
    mock.timers.tick(90_000 - SIGNPAGE_TIMEOUT_MS["pool.buy"]);
    assert.equal(signal.aborted, false, "not aborted at 90 s");
    answer(new Response(JSON.stringify({ signature: "x" }), { status: 200 }));
    assert.deepEqual(await p, { signature: "x" });
    // one with no answer at all ends at its own window
    const q = helperPoolSend("P", Uint8Array.of(1), slow);
    mock.timers.tick(POOL_SEND_TIMEOUT_MS - 1);
    assert.equal(signal.aborted, false);
    mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    await assert.rejects(q, /no answer in 120000 ms/);
  } finally {
    resetTimers(mock.timers);
  }
});

test("helperPoolSend posts {pool, tx} to the helper and takes only a 200 within the v1 table's limit", async () => {
  const seen: { url: string; body: unknown }[] = [];
  const ok = (async (url: string, init: RequestInit) => (seen.push({ url, body: JSON.parse(String(init.body)) }), new Response(JSON.stringify({ signature: "x" }), { status: 200 }))) as unknown as typeof fetch;
  assert.deepEqual(await helperPoolSend("P", Uint8Array.of(1, 2, 3), ok), { signature: "x" });
  assert.match(seen[0]!.url, /\/v1\/pool\/solana\/send$/);
  assert.deepEqual(seen[0]!.body, { pool: "P", tx: "AQID" });
  // a 4xx but 429 is the helper's refusal before it sent anything: PoolSendRefused with its code (card
  // buy-spends-several-pieces: the run ends at once); a 404 (an older helper with no such route) the same; a 5xx stays
  // an error that says nothing of the chain
  const refused = (async () => new Response(JSON.stringify({ error: { code: "simulation_failed" } }), { status: 422 })) as unknown as typeof fetch;
  await assert.rejects(helperPoolSend("P", Uint8Array.of(1), refused), (e: unknown) => e instanceof PoolSendRefused && e.status === 422 && e.code === "simulation_failed");
  const gone = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(helperPoolSend("P", Uint8Array.of(1), gone), (e: unknown) => e instanceof PoolSendRefused && e.status === 404 && e.code === "refused");
  const down = (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(helperPoolSend("P", Uint8Array.of(1), down), (e: unknown) => !(e instanceof PoolSendRefused) && /HTTP 502/.test(String(e)));
  const big = (async () => new Response(JSON.stringify({ signature: "x".repeat(5000) }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(helperPoolSend("P", Uint8Array.of(1), big), /over 4096 B/);
});

test("card buy-spends-several-pieces: helperPoolSendPieces posts {pool, txs} in order to the pieces route and takes only a 200 within its limit; the page's buy host sends a buy's pieces through it", async () => {
  const seen: { url: string; body: unknown }[] = [];
  const ok = (async (url: string, init: RequestInit) => (seen.push({ url, body: JSON.parse(String(init.body)) }), new Response(JSON.stringify({ signatures: ["a", "b"] }), { status: 200 }))) as unknown as typeof fetch;
  assert.deepEqual(await helperPoolSendPieces("P", [Uint8Array.of(1, 2, 3), Uint8Array.of(4)], ok), { signatures: ["a", "b"] });
  assert.match(seen[0]!.url, /\/v1\/pool\/solana\/pieces$/);
  assert.deepEqual(seen[0]!.body, { pool: "P", txs: ["AQID", "BA=="] });
  const refused = (async () => new Response(JSON.stringify({ error: { code: "wallets_differ" } }), { status: 422 })) as unknown as typeof fetch;
  await assert.rejects(helperPoolSendPieces("P", [Uint8Array.of(1)], refused), (e: unknown) => e instanceof PoolSendRefused && e.code === "wallets_differ");
  const big = (async () => new Response(JSON.stringify({ signatures: ["x".repeat(9000)] }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(helperPoolSendPieces("P", [Uint8Array.of(1)], big), /over 8192 B/);
  // the buy host offers the pieces send beside takeSet, so a buy may spend several pieces (pool-buy.ts: both or one piece)
  const src = readFileSync(new URL("../src/pool-testnet.ts", import.meta.url), "utf8");
  assert.match(src, /sendPieces: \(pool, txs\) => helperPoolSendPieces\(pool, txs, over\.fetch\)/);
  assert.match(src, /takeSet: async \(items, early, lastHeight\)/);
  assert.match(src, /piecesOwed: piecesOwedOf\(page\.store\)/, "the buy host writes a buy of several pieces' owed record");
  // a buy of several pieces settles every note left on one read of the marks a round (the wallet's set settle)
  assert.match(src, /settleSet: async \(noteIds, minSlots\) => \{[\s\S]{0,400}?solanaSettleSpentSet\(\{ seed64, notes, noteIds,/);
  // the owed record's end is decided on each state read and from followBuys (the pass a buy that ended "sent" starts)
  assert.match(src, /await followBuys\(notes\);\s*await resumeOwedPieces\(/);
  assert.match(src, /now = new Map\(\(await readNotes\(await page\.store\(\)\)\)[^\n]*\n\s*await resumeOwedPieces\(/);
  // whose spend the buy's own note is: spendOwner on the record's own spend (review P3-4 of c7b85ba3a), on the settle pair
  assert.match(src, /owner: async \(r\) => \{\s*const rs = settleRpcs\("pass"\);[\s\S]{0,400}?spendOwner\(rs, \{ program: r\.spend\.program, feePayer: r\.spend\.feePayer \}, r\.address, BigInt\(r\.spend\.nullifier\), r\.spend\.context, /);
  // a restore's scan: the batch on the helper's seat on mainnet, never a public provider; the testnet build one W a request
  assert.match(src, /const batch = POOL_TESTNET \? null : over\.rpcs \? over\.rpcs\[1\] : solanaPacedRpc\(pageHelperRpc\(TRADE_HELPER,/);
  assert.match(src, /if \(scan\) await findHeldWs\(mine\)\.catch\(\(\) => \{\}\);\s*return await resumeRentBacks\(h, locks\);/);
});

test("card buy-spends-several-pieces: piecesOwedOf keeps one record a W in the store's meta/owed/pieces-sol, put over and dropped by W", async () => {
  // the real wallet store: the key is one its caller check allows, and a drop of no record writes nothing
  const { w } = await wallet();
  const o = piecesOwedOf(async () => w);
  const rec = { address: "W1", l: "3", j: 0, primary: "n1", pieces: ["n2"], lastHeight: "151", mint: "M", program: "T", spend: { program: "P", feePayer: "F", context: "7", nullifier: "9" } };
  await o.put(rec);
  await o.put({ ...rec, address: "W2" });
  await o.put({ ...rec, pieces: ["n2", "n3"] });
  assert.deepEqual(await o.list(), [{ ...rec, pieces: ["n2", "n3"] }, { ...rec, address: "W2" }]);
  assert.equal(Object.keys((await w.get("meta", "owed/pieces-sol")) as object).length, 2);
  await o.drop("W1");
  await o.drop("nobody");
  assert.deepEqual((await o.list()).map((r) => r.address), ["W2"]);
});

// ---- card signpage-pool-sell: pool.sell on the devnet pool ----

test("pool.sell on the devnet pool runs the sell kind: a page whose buys left no W holding the token answers not_funded with no read", async () => {
  const { w } = await wallet();
  const reads: string[] = [];
  const offline = (n: string) => Object.assign(async (m: string) => (reads.push(m), Promise.reject(new Error("offline"))), { url: `https://${n}.invalid` });
  const evmSells: string[] = [];
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { rpcs: [offline("a"), offline("b")], tradeKinds: { evmSell: () => (a) => (evmSells.push(a.chain), { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [] } }) }) } });
  const ask: Ask = { kind: "pool.sell", chain: "solana", token: SOL_TOKEN, amount: 1n, slippageBps: 100, decimals: 9 };
  const r = t.flow(ask, ctx as never) as { running?: true; after: Promise<unknown>; answer: () => unknown };
  assert.equal(r.running, true, "the sell runs");
  await r.after;
  assert.deepEqual(r.answer(), { error: "not_funded" });
  assert.deepEqual(reads, [], "no W: no read");
  // a sale on an EVM chain is the EVM sell's, never the Solana sell's (card signpage-evm-pool-sell: before it, refused)
  assert.equal("running" in t.flow({ ...ask, chain: "base" }, ctx as never), true);
  assert.deepEqual(evmSells, ["base"]);
  assert.deepEqual(reads, [], "and the Solana pair read nothing for it");
});

test("a state read settles a sell a closed page left INCOMING (the review of signpage-pool-sell 4b6223a, high): its mark read on both RPCs, the note kept while they fail", async () => {
  const { w, ns } = await wallet();
  const calls: string[] = [];
  const rpc = async (m: string, p: readonly unknown[]) => {
    calls.push(`${m} ${typeof p?.[0] === "string" ? p[0] : ""}`.trim());
    throw new Error("offline");
  };
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { rpcs: [rpc, async (m: string, p: readonly unknown[]) => rpc(m, p)], prover: { vault: signalsProver(), stop: () => {} } });
  const ref: NoteRef = { kind: "return", c: "sol", l: 7n, j: 0 };
  const precommitment = noteSecrets(SEED64, ref).precommitment;
  const n = await ns.add({ ref, scope: SCOPE, precommitment, state: "PLANNED" });
  await ns.move(n.id, "PLANNED", "INCOMING", { send: { signature: "1".repeat(64), value: 5_000_000n, last_valid_block_height: 151n } });
  await t.stateRead();
  const { solanaProgramAddress } = await import("../../kit/src/checks/solana/message.ts");
  const be = Uint8Array.from({ length: 32 }, (_, i) => Number((precommitment >> BigInt(8 * (31 - i))) & 255n));
  const mark = solanaProgramAddress([new TextEncoder().encode("pre"), be], SOL_POOLS.devnet!.program);
  // the sell's settle read the note's mark on both RPCs (the deposit's settle never reads a sell note); offline: kept
  assert.equal(calls.filter((c) => c === `getAccountInfo ${mark}`).length, 2, calls.join(" | "));
  assert.deepEqual(await states(ns), ["INCOMING"]);
});

// The second re-review of signpage-pool-sell (low): a dead "pending" sell record is settled once per page load, not by
// reading every ops record on every state read.
test("a state read refuses a dead pending sell record once per page load, never reading the ops records again on the next state reads", async () => {
  const { w } = await wallet();
  let opsKeys = 0;
  const counted = new Proxy(w, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (k === "keys") return (st: string) => (st === "ops" && opsKeys++, v.call(t, st));
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const rpc = async () => {
    throw new Error("offline");
  };
  const t = testnetPool({ store: async () => counted, seed64: async () => SEED64.slice() }, { rpcs: [rpc, rpc], prover: { vault: signalsProver(), stop: () => {} } });
  await w.put("ops", "z1", { kind: "sell", pool: "sol", sha: "cc", stage: "pending", txs: [], created_ms: 1 });
  await t.stateRead();
  assert.deepEqual(await w.get("ops", "z1"), { kind: "sell", pool: "sol", sha: "cc", stage: "refused", code: "failed", txs: [], created_ms: 1 });
  const once = opsKeys;
  // once for the dead sells, once for a withdraw's onward send still owed (card signpage-pool-withdraw-form)
  assert.equal(once, 2);
  await t.stateRead();
  await t.stateRead();
  assert.equal(opsKeys, once, "read once per page load");
});

// The card signpage-pool-flow-run, run 6: the helper's busy answer to a send is told apart from a failure, with its wait.
test("helperPoolSend gives the helper's 429 as busy, with its code and its Retry-After; a 429 that is not the helper's body is still busy", async () => {
  const { helperPoolSend } = await import("../src/pool-testnet.ts");
  const { PoolSendBusy } = await import("../src/pool-buy.ts");
  const answer = (status: number, body: string, headers: Record<string, string> = {}) => (async () => new Response(body, { status, headers })) as unknown as typeof fetch;
  const busy = async (f: typeof fetch) => {
    try {
      await helperPoolSend("p", new Uint8Array(3), f);
    } catch (e) {
      return e instanceof PoolSendBusy ? { code: e.code, ms: e.retryAfterMs } : String(e);
    }
    return "answered";
  };
  assert.deepEqual(await busy(answer(429, '{"error":{"code":"rate_limited"}}', { "retry-after": "1" })), { code: "rate_limited", ms: 1_000 });
  assert.deepEqual(await busy(answer(429, '{"error":{"code":"in_flight"}}', { "retry-after": "2" })), { code: "in_flight", ms: 2_000 });
  assert.deepEqual(await busy(answer(429, "slow down")), { code: "throttled", ms: 1_000 });
  assert.match(String(await busy(answer(503, '{"error":{"code":"upstream"}}'))), /HTTP 503/);
});

test("pool.withdraw (card signpage-pool-withdraw-form): a checked request opens the page's own screen with its id, on Solana and on an EVM chain its pin names; no screen, or an EVM chain with no pin, is refused", async () => {
  const { w } = await wallet();
  const opened: [string, string][] = [];
  const answer = { result: { pending: true as const } };
  const with_ = testnetPool({ store: async () => w, seed64: async () => SEED64.slice(), openWithdraw: (chain, c) => (opened.push([chain, c.id]), answer) }, { prover: { vault: signalsProver(), stop: () => {} }, locks: null });
  const ask: Ask = { kind: "pool.withdraw", chain: "solana", token: null, amount: 0n, slippageBps: 0, decimals: 9 };
  assert.equal(with_.flow(ask, ctx), answer);
  assert.deepEqual(opened, [["solana", "r1"]]);
  // Base and Robinhood: the chain's pin alone decides
  assert.equal(with_.flow({ ...ask, chain: "base", decimals: 18 }, ctx), answer);
  assert.equal(with_.flow({ ...ask, chain: "robinhood", decimals: 18 }, ctx), answer);
  assert.deepEqual(opened, [["solana", "r1"], ["base", "r1"], ["robinhood", "r1"]]);
  const unpinned = testnetPool({ store: async () => w, seed64: async () => SEED64.slice(), openWithdraw: (chain, c) => (opened.push([chain, c.id]), answer) }, { prover: { vault: signalsProver(), stop: () => {} }, locks: null, evmPin: () => undefined });
  assert.deepEqual(unpinned.flow({ ...ask, chain: "base", decimals: 18 }, ctx), { error: "not_allowed" });
  assert.deepEqual(unpinned.flow({ ...ask, chain: "robinhood", decimals: 18 }, ctx), { error: "not_allowed" });
  assert.equal(opened.length, 3);
  assert.equal(unpinned.withdrawDeps("base", "r1").handoff, undefined, "no pin: no withdraw");
  await assert.rejects(unpinned.withdrawDeps("base", "r1").funds(), /no flow/);
  const refused = testnetPool({ store: async () => w, seed64: async () => SEED64.slice(), openWithdraw: () => null }, { prover: { vault: signalsProver(), stop: () => {} }, locks: null });
  assert.deepEqual(refused.flow(ask, ctx), { error: "not_allowed" });
  const none = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { prover: { vault: signalsProver(), stop: () => {} }, locks: null });
  assert.deepEqual(none.flow(ask, ctx), { error: "not_allowed" });
  // the screen's keys are the pin's own: none of them is a destination
  const keys = with_.withdrawDeps("solana", "r1").keys;
  assert.equal(keys.pool, solanaPoolOf(SOL_POOLS.devnet!.program).pool);
  assert.equal(keys.program, SOL_POOLS.devnet!.program);
  assert.equal(keys.feePayer, SOL_POOLS.devnet!.feePayer);
  // the EVM screen's keys: the pinned pool; no Web Locks, no run
  assert.equal(with_.withdrawDeps("base", "r1").keys.pool, EVM_POOLS["base-sepolia"]!.pool);
  assert.equal(with_.withdrawDeps("base", "r1").handoff, undefined, "no Web Locks: no run");
});

// Review #232b LOW 2: the finish of an owed onward send takes the seed lock per use (a derive, a signature), never
// across an RPC read, so a sign out never waits on a slow one; a failed finish is tried again only after a wait.
test("an owed onward send's finish: a sign out never waits on its slow RPC read, and a failed read waits before the next try", async () => {
  const { w, ns } = await wallet();
  const { land } = fakePool();
  let n = await land(ns, await incoming(ns, null, 7));
  // the owed attempt's note, spent by it: RESERVED with its context, then SPENT
  n = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: NOW + 60_000n, context: "7" });
  const attempt = n.attempt!;
  n = await ns.move(n.id, "HELD", "RESERVED", { attempt });
  n = await ns.move(n.id, "RESERVED", "SPENT", {});
  await w.put("ops", "w1", { kind: "withdraw", stage: "in_transit", txs: [], created_ms: 1, pending: { noteId: n.id, attempt, context: "7", to: "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx", last: true, feeCap: "5000" } });
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  // the finish's reads (its first: each RPC's finalized slot); the load's rent backs read on their own, in the
  // background (card round-trip-costs-less: the helper's finding read of the W this note paid)
  const rpc = async (method: string) => {
    if (method === "getSlot") reads++;
    await gate;
    throw new Error("offline");
  };
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { rpcs: [rpc, rpc], prover: { vault: signalsProver(), stop: () => {} } });
  const pass = t.stateRead();
  for (let i = 0; reads === 0 && i < 2_000; i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(reads > 0, "the finish reads the chain");
  const signOut = navigator.locks.request("ct-wallet/seed", { mode: "exclusive" }, async () => "out");
  assert.equal(await Promise.race([signOut, new Promise((r) => setTimeout(() => r("waited"), 200))]), "out", "the sign out goes while the finish waits on its RPC");
  release();
  await pass;
  assert.equal(((await w.get("ops", "w1")) as { stage: string }).stage, "in_transit", "still owed");
  const before = reads;
  await t.stateRead();
  assert.equal(reads, before, "not tried again at once");
});

// card signpage-withdraw-own-spend (4): the testnet page's own owed-note rules
const owedPending = (noteId: string, to: string) => ({ noteId, attempt: "ab".repeat(16), context: "1", to, last: true, feeCap: "5000" });

test("a note the reserved pass freed settles the op owing its send as stopped, the send dropped; another note's op stays owed", async () => {
  const { w } = await wallet();
  const to = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
  await w.put("ops", "op1", { kind: "withdraw", stage: "in_transit", txs: [], created_ms: 1, owed: "n1" });
  await oweSend(w, "op1", owedPending("n1", to));
  await w.put("ops", "op2", { kind: "withdraw", stage: "in_transit", txs: [], created_ms: 2, owed: "n2" });
  await oweSend(w, "op2", owedPending("n2", to));
  // a record from before the owed store: its pending in the op
  await w.put("ops", "op3", { kind: "withdraw", stage: "proving", txs: [], created_ms: 3, pending: owedPending("n3", to) });
  await settleFreedOps(w, ["n1", "n3"]);
  const op1 = (await w.get("ops", "op1")) as Record<string, unknown>;
  assert.equal(op1.stage, "stopped");
  assert.equal(op1.owed, undefined);
  assert.deepEqual(await w.get("meta", "owed/op1"), {});
  const op2 = (await w.get("ops", "op2")) as Record<string, unknown>;
  assert.equal(op2.stage, "in_transit");
  assert.equal(op2.owed, "n2");
  assert.deepEqual(Object.keys((await w.get("meta", "owed/op2")) as object), ["n2"]);
  const op3 = (await w.get("ops", "op3")) as Record<string, unknown>;
  assert.equal(op3.stage, "stopped");
  assert.equal(op3.pending, undefined);
});

test("the withdraw screen's funds leave out a note an op still owes a send for, and a run never plans it, until the op is settled", async () => {
  const { world, TO, COST } = WORLD;
  const wd = await world([30_000_000n, 30_000_000n]);
  const [n0, n1] = wd.ids as [string, string];
  await wd.w.put("ops", "op1", { kind: "withdraw", stage: "in_transit", txs: [], created_ms: 1, owed: n0 });
  await oweSend(wd.w, "op1", owedPending(n0, TO));
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { pool, tx } = JSON.parse(init.body) as { pool: string; tx: string };
    return new Response(JSON.stringify(await wd.host.send(pool, base64.decode(tx))), { status: 200 });
  }) as unknown as typeof fetch;
  const t = testnetPool({ store: async () => wd.w, seed64: async () => SEED64.slice() }, { pin: wd.host.pin, rpcs: wd.host.rpcs, pool: wd.host.pool as never, prover: { vault: signalsProver(), stop: () => {} }, fetch: fetchFn });
  const f = await t.withdrawDeps("solana", "op2").funds();
  assert.deepEqual(f.notes.map((n) => n.id), [n1], "the owed note is out of the screen's funds");
  // an amount only both notes can send: the run's plan has no owed note, so it stops with no release
  await t.withdraw({ chain: "solana", to: TO, amount: 40_000_000n, maxFee: 2n * COST }, "op2");
  assert.equal(((await wd.w.get("ops", "op2")) as { stage: string }).stage, "stopped");
  assert.equal(wd.releases.length, 0);
  // op 1 settled: the note is back in the funds
  await wd.w.update("ops", "op1", (v) => mergeWithdrawOp(v, { stage: "stopped", clear: n0 }));
  assert.equal((await t.withdrawDeps("solana", "op3").funds()).notes.length, 2);
});

test("a send owed whose fee rose past the Max fee: the screen reads the fee it needs, and drawing it again at that fee sends it on", async () => {
  const { world, TO, COST, W_FEE } = WORLD;
  let rose = false;
  const wd = await world([30_000_000n], { feeFor: () => (rose ? 2n * W_FEE : W_FEE), afterRelease: () => void (rose = true) });
  // the part's run (the world's own settle), its op written as the page's run writes it: the send owed in meta/owed/<op id>
  const { runPoolWithdraw } = await import("../src/pool-withdraw.ts");
  const ran = await runPoolWithdraw(wd.host, { kind: "pool.withdraw", chain: "solana", token: null, amount: 0n, slippageBps: 0, decimals: 9 }, TO, 5_000_000n, COST);
  assert.equal(ran.stage, "in_transit");
  await wd.w.put("ops", "op-f", { kind: "withdraw", stage: "in_transit", txs: ran.txs, created_ms: 1, owed: ran.pending!.noteId, fee_needed: ran.feeNeeded });
  await oweSend(wd.w, "op-f", ran.pending!);
  const t = testnetPool({ store: async () => wd.w, seed64: async () => SEED64.slice() }, { pin: wd.host.pin, rpcs: wd.host.rpcs, pool: wd.host.pool as never, prover: { vault: signalsProver(), stop: () => {} } });
  const deps = t.withdrawDeps("solana", "op-g");
  assert.deepEqual(await deps.owedFees!(), [{ opId: "op-f", need: 2n * W_FEE }]);
  // a fee other than the one owed (the screen's read gone stale) raises nothing
  await assert.rejects(deps.redraw!("op-f", 3n * W_FEE));
  assert.equal(wd.onwards().length, 0);
  await deps.redraw!("op-f", 2n * W_FEE);
  const op = (await wd.w.get("ops", "op-f")) as { stage: string; fee_needed?: unknown; owed?: unknown };
  assert.equal(op.stage, "sent");
  assert.equal(op.fee_needed, undefined);
  assert.equal(op.owed, undefined);
  assert.equal(wd.balance.get(TO), 5_000_000n - W_FEE, "To never less than the amount less the Max fee drawn again");
  assert.deepEqual(await deps.owedFees!(), []);
});

// Review #232b fold 3, HIGH 1: the page's own withdraw run, its tab closed while the release's read-back is out (the
// run never answers): the op owes the send from before the release leaves, in_transit, and the reopened page's state
// read sends it on, W at 0 and To given the amount.
/** A clock for the page's withdraw run whose waits pass at once: each moves it on by the time waited. */
const quickClock = () => {
  let skew = 0n;
  return { now: () => BigInt(Date.now()) + skew, wait: async (ms: number) => void (skew += BigInt(ms)) };
};

test("a withdraw whose tab closed during the release's read-back: the reopened page sends the part on, W at 0, To the amount", async () => {
  const { world, TO, COST } = WORLD;
  const wd = await world([30_000_000n], { hangReadBack: true });
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { pool, tx } = JSON.parse(init.body) as { pool: string; tx: string };
    const answer = await wd.host.send(pool, base64.decode(tx));
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
  const over = { pin: wd.host.pin, rpcs: wd.host.rpcs, pool: wd.host.pool as never, prover: { vault: signalsProver(), stop: () => {} }, fetch: fetchFn, ...quickClock() };
  const page = { store: async () => wd.w, seed64: async () => SEED64.slice() };
  const amount = 5_000_000n;
  // the closed tab: its run makes no step past its first wait after the release (card pool-buy-filled-2s: the
  // read-back's settle backs off, so a run left going no longer stays busy for 120 settles while the page opened again
  // reads; a tab that is closed runs nothing), let go at the end
  const closed: (() => void)[] = [];
  const t1 = testnetPool(page, { ...over, wait: () => new Promise<void>((r) => closed.push(r)) });
  const run = t1.withdraw({ chain: "solana", to: TO, amount, maxFee: COST }, "op-w");
  for (let i = 0; wd.releases.length === 0 && i < 1_000; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(wd.releases.length, 1, "the release went out");
  await new Promise((r) => setTimeout(r, 20));
  const W = wd.binds[0]!.recipient;
  const rec = (await wd.w.get("ops", "op-w")) as { stage: string; owed?: unknown };
  assert.equal(rec.stage, "in_transit", "never proving while a release is out");
  // card signpage-withdraw-own-spend (2): the op (which the frame reads) names only the note; the send owed, with its
  // attempt and context, is in meta under owed/<op id>, which the frame never reads
  const held = (await wd.ns.get(wd.ids[0]!))!;
  assert.equal(rec.owed, wd.ids[0], "the send owed, by its note's id");
  const owedRec = (await wd.w.get("meta", "owed/op-w")) as Record<string, { attempt: string; context: string }>;
  assert.deepEqual(Object.keys(owedRec), [wd.ids[0]]);
  assert.equal(owedRec[wd.ids[0]!]!.context, held.contexts!.at(-1)!.context);
  const text = JSON.stringify(rec);
  assert.ok(!text.includes(held.contexts!.at(-1)!.context) && !text.includes(held.attempt!) && !text.includes(TO), "no context, attempt or To in the op record");
  assert.equal(wd.balance.get(W), amount + 5_000n, "the part on W");
  // the tab is gone (its run never answers); the page opened again reads its state
  const t2 = testnetPool(page, { ...over, fetch: undefined });
  await t2.stateRead();
  assert.equal(wd.balance.get(W), 0n);
  assert.equal(wd.balance.get(TO), amount);
  const after = (await wd.w.get("ops", "op-w")) as { stage: string; owed?: unknown; txs: { hash: string }[] };
  assert.equal(after.stage, "sent");
  assert.equal(after.owed, undefined);
  assert.deepEqual(await wd.w.get("meta", "owed/op-w"), {}, "the send owed dropped once sent");
  assert.equal(after.txs.length, 1, "the onward send's tx");
  // the closed tab's run let go, so nothing of it outlives the test (fold 5: it held node ~120 s)
  wd.unhang();
  const drain = setInterval(() => closed.splice(0).forEach((r) => r()), 0);
  await run;
  clearInterval(drain);
});

test("a withdraw whose first run is still live beside the page opened again: one release and one onward send, W at 0, To the amount", async () => {
  const { world, TO, COST } = WORLD;
  const wd = await world([30_000_000n], { hangReadBack: true });
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { pool, tx } = JSON.parse(init.body) as { pool: string; tx: string };
    const answer = await wd.host.send(pool, base64.decode(tx));
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
  const over = { pin: wd.host.pin, rpcs: wd.host.rpcs, pool: wd.host.pool as never, prover: { vault: signalsProver(), stop: () => {} }, fetch: fetchFn, ...quickClock() };
  const page = { store: async () => wd.w, seed64: async () => SEED64.slice() };
  const amount = 5_000_000n;
  // the first tab's run stays live: once its read-back answers it reads, settles and sends on as the other page does
  const t1 = testnetPool(page, over);
  const run = t1.withdraw({ chain: "solana", to: TO, amount, maxFee: COST }, "op-w");
  for (let i = 0; wd.releases.length === 0 && i < 1_000; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(wd.releases.length, 1, "the release went out");
  await new Promise((r) => setTimeout(r, 20));
  const W = wd.binds[0]!.recipient;
  const t2 = testnetPool(page, { ...over, fetch: undefined });
  await t2.stateRead();
  wd.unhang();
  await run;
  await t2.stateRead();
  assert.equal(wd.releases.length, 1, "one release");
  assert.equal(wd.onwards().length, 1, "one onward send, whichever page made it");
  assert.equal(wd.balance.get(W), 0n);
  assert.equal(wd.balance.get(TO), amount);
});

test("keepEvmSend keeps every W send signed for the part (a reload's, another tab's) beside the newest, and refuses, so nothing leaves unkept, once the send is no longer this attempt's", async () => {
  const { w } = await wallet();
  const p = { ...owedPending("n1", "0x1111111111111111111111111111111111111111"), chain: "base", part: "1", nullifier: "2", from: "3", deadlineMs: "4", chunk: "5", fee: "6" } as const;
  await oweSend(w, "op1", p);
  await keepEvmSend(w, "op1", { ...p, onward: "0xh1" });
  // a second tab's send, from its own copy that never saw the first
  await keepEvmSend(w, "op1", { ...p, onward: "0xh2" });
  // the run's release-only keep after them keeps both
  await keepEvmSend(w, "op1", { ...p, feeCap: "7000" });
  assert.deepEqual(await w.get("meta", "owed/op1"), { n1: { ...p, feeCap: "7000", onward: "0xh2", onwards: ["0xh1", "0xh2"] } });
  await assert.rejects(keepEvmSend(w, "op1", { ...p, attempt: "cd".repeat(16), onward: "0xh3" }), /not this attempt's/);
  await dropSend(w, "op1", "n1");
  await assert.rejects(keepEvmSend(w, "op1", { ...p, onward: "0xh4" }), /not this attempt's/);
  assert.deepEqual(await w.get("meta", "owed/op1"), {});
});

// fold 4 (review LOW): the release's own signature is added to the send still stored, never a whole owe again
test("keepRelease adds the release's signature to the owed send still stored only: a dropped send stays dropped, the stored one keeps its own fee ceiling", async () => {
  const { w } = await wallet();
  const p = owedPending("n1", "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx");
  await oweSend(w, "op1", { ...p, feeCap: "9000" });
  await keepRelease(w, "op1", "n1", p.attempt, "sig1");
  assert.deepEqual(await w.get("meta", "owed/op1"), { n1: { ...p, feeCap: "9000", release: "sig1" } });
  // another attempt's signature never lands on this attempt's send
  await keepRelease(w, "op1", "n1", "cd".repeat(16), "sig2");
  assert.equal(((await w.get("meta", "owed/op1")) as Record<string, { release: string }>).n1!.release, "sig1");
  await dropSend(w, "op1", "n1");
  await keepRelease(w, "op1", "n1", p.attempt, "sig3");
  assert.deepEqual(await w.get("meta", "owed/op1"), {});
  await keepRelease(w, "op2", "n1", p.attempt, "sig4");
  assert.equal(await w.get("meta", "owed/op2"), undefined);
});

/** The tab-closed withdraw: its release out, its read-back not answering until `end`. */
async function hungWithdraw() {
  const { world, TO, COST } = WORLD;
  const wd = await world([30_000_000n], { hangReadBack: true });
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { pool, tx } = JSON.parse(init.body) as { pool: string; tx: string };
    const answer = await wd.host.send(pool, base64.decode(tx));
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
  const over = { pin: wd.host.pin, rpcs: wd.host.rpcs, pool: wd.host.pool as never, prover: { vault: signalsProver(), stop: () => {} }, fetch: fetchFn, ...quickClock() };
  const page = { store: async () => wd.w, seed64: async () => SEED64.slice() };
  const t1 = testnetPool(page, over);
  const run = t1.withdraw({ chain: "solana", to: TO, amount: 5_000_000n, maxFee: COST }, "op-w");
  for (let i = 0; wd.releases.length === 0 && i < 1_000; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(wd.releases.length, 1, "the release went out");
  await new Promise((r) => setTimeout(r, 20));
  // the closed tab's run let go at the test's end, so nothing of it outlives the test
  const end = async () => {
    wd.unhang();
    await run;
  };
  return { wd, over, page, TO, end };
}

test("another tab settled the op while the release was out, the run ending in_transit: at the run's end the op owes nothing and its dropped send stays dropped (fold 4; fold 5, review LOW)", async () => {
  const { world, TO, COST } = WORLD;
  // the release lands, its spend not read in time: the run ends in_transit
  const wd = await world([30_000_000n], { settleUnspent: true });
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { pool, tx } = JSON.parse(init.body) as { pool: string; tx: string };
    const answer = await wd.host.send(pool, base64.decode(tx));
    // another tab's finish, before the helper answers: the op settled stopped and its send dropped (settleFreedOps)
    const id = wd.ids[0]!;
    await wd.w.update("ops", "op-w", (v) => mergeWithdrawOp(v, { stage: "stopped", clear: id }));
    await dropSend(wd.w, "op-w", id);
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
  const over = { pin: wd.host.pin, rpcs: wd.host.rpcs, pool: wd.host.pool as never, prover: { vault: signalsProver(), stop: () => {} }, fetch: fetchFn, ...quickClock() };
  await testnetPool({ store: async () => wd.w, seed64: async () => SEED64.slice() }, over).withdraw({ chain: "solana", to: TO, amount: 5_000_000n, maxFee: COST }, "op-w");
  assert.equal(wd.releases.length, 1, "the release went out");
  assert.deepEqual(await wd.w.get("meta", "owed/op-w"), {}, "the dropped send stays dropped");
  assert.equal(((await wd.w.get("ops", "op-w")) as { owed?: unknown }).owed, undefined, "the op still owes nothing");
});

// Card sol-settle-failed-is-not-unspent: the page's own withdraw, the helper answering 502 after it sent the release,
// the release landed on W, and every settle on the page failing (its lister down) while both RPCs read the blockhash
// past. The run stopped and the op dropped its owed send, the part left on W with nothing owed. A settle that throws is
// not known yet: the op stays in_transit, its send kept, and the settle is asked at the past read's slots.
test("a withdraw on the page, the helper's 502 after the release landed, every settle failing: the op stays in_transit, its owed send kept; the settle asked at the past read's slots", async () => {
  const { world, TO, COST, FINAL_SLOT } = WORLD;
  const wd = await world([30_000_000n]);
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { pool, tx } = JSON.parse(init.body) as { pool: string; tx: string };
    await wd.host.send(pool, base64.decode(tx));
    return new Response("{}", { status: 502 });
  }) as unknown as typeof fetch;
  const asked: unknown[] = [];
  const lister = (async (_m: string, p: readonly unknown[]) => {
    asked.push((p[1] as { minContextSlot?: unknown }).minContextSlot);
    throw new Error("HTTP 503");
  }) as never;
  const over = { pin: wd.host.pin, rpcs: wd.host.rpcs, lister, pool: wd.host.pool as never, prover: { vault: signalsProver(), stop: () => {} }, fetch: fetchFn, ...quickClock() };
  await testnetPool({ store: async () => wd.w, seed64: async () => SEED64.slice() }, over).withdraw({ chain: "solana", to: TO, amount: 5_000_000n, maxFee: COST }, "op-w");
  const id = wd.ids[0]!;
  assert.equal(wd.releases.length, 1, "the release went out");
  assert.equal(wd.balance.get(wd.binds[0]!.recipient), 5_000_000n + WORLD.W_FEE, "the part on W");
  const op = (await wd.w.get("ops", "op-w")) as { stage: string; owed?: unknown };
  assert.equal(op.stage, "in_transit");
  assert.equal(op.owed, id, "the op still owes the part's send");

  assert.ok(Object.keys(((await wd.w.get("meta", "owed/op-w")) as Record<string, unknown> | undefined) ?? {}).includes(id), "its send kept");
  assert.equal((await wd.ns.get(id))!.state, "RESERVED");
  assert.ok(asked.length > 0 && asked.every((s) => s === undefined || s === FINAL_SLOT) && asked.includes(FINAL_SLOT), `asked at ${asked.join(",")}`);
});

// card pool-tree-read-waits-for-its-second: a run that ends on a throw writes why on the op's record, in public words
// only (the error's name and code, never its text), and the op that later ends sent no longer names it
test("a withdraw on the page whose tree read throws ends stopped, its cause on the op in public words only", async () => {
  const { world, TO, COST } = WORLD;
  const wd = await world([30_000_000n], { trees: () => async () => { throw new Error("HTTP 503 from https://rpc.example/?api-key=K1"); } });
  const fetchFn = (async () => { throw new Error("no send"); }) as unknown as typeof fetch;
  const over = { pin: wd.host.pin, rpcs: wd.host.rpcs, pool: wd.host.pool as never, prover: { vault: signalsProver(), stop: () => {} }, fetch: fetchFn, ...quickClock() };
  await testnetPool({ store: async () => wd.w, seed64: async () => SEED64.slice() }, over).withdraw({ chain: "solana", to: TO, amount: 5_000_000n, maxFee: COST }, "op-w");
  assert.equal(wd.releases.length, 0);
  const op = (await wd.w.get("ops", "op-w")) as { stage: string; cause?: string };
  assert.equal(op.stage, "stopped");
  assert.match(op.cause ?? "", /^Error\b/, "the cause is written, the error's name first");
  assert.ok(!/rpc\.example|api-key|K1|HTTP/.test(op.cause!), `never the error's text: ${op.cause}`);
});

// card pool-buy-record-never-stays-sent: a withdraw's release read landed writes its withdrawn value on the note's mark
// and pings the page's watchers, so the app's read right after counts only the note's change, with no other write
test("a withdraw on the page whose release lands, its spend not read in time: the watchers are told once its withdrawn value is on the note's mark", async () => {
  const { world, TO, COST } = WORLD;
  const wd = await world([30_000_000n], { settleUnspent: true });
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { pool, tx } = JSON.parse(init.body) as { pool: string; tx: string };
    return new Response(JSON.stringify(await wd.host.send(pool, base64.decode(tx))), { status: 200 });
  }) as unknown as typeof fetch;
  const over = { pin: wd.host.pin, rpcs: wd.host.rpcs, pool: wd.host.pool as never, prover: { vault: signalsProver(), stop: () => {} }, fetch: fetchFn, ...quickClock() };
  const t = testnetPool({ store: async () => wd.w, seed64: async () => SEED64.slice() }, over);
  // what each ping of the watchers reads, as the app reads the state again on it
  const reads: Promise<unknown>[] = [];
  t.watch(() => void reads.push(t.readyWith(async () => null).then((v) => [...(v.landed ?? [])])));
  await t.withdraw({ chain: "solana", to: TO, amount: 5_000_000n, maxFee: COST }, "op-w");
  const id = wd.ids[0]!;
  assert.equal((await wd.ns.get(id))!.state, "RESERVED", "its spend not read yet");
  const mark = (await wd.ns.marks()).get(id);
  assert.ok(mark?.withdrawn !== undefined && mark.withdrawn > 0n, "the release's withdrawn value on the note's mark");
  for (let i = 0; i < 200 && reads.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  const want = [[id, { attempt: mark.attempt, withdrawn: mark.withdrawn }]];
  const seen = await Promise.all(reads);
  assert.ok(seen.some((l) => { try { assert.deepEqual(l, want); return true; } catch { return false; } }), `a ping reads the landed release (${seen.length} pings)`);
  await t.signedOut();
});

test("an owed send with no release signature under 2,500 newer entries of W's history, the page's RPC functions new on every pass: the next finish reads on from the last one's place and sends it (fold 4, review HIGH)", async () => {
  const { wd, over, page, TO, end } = await hungWithdraw();
  const id = wd.ids[0]!;
  // a record from before fold 3, or a tab closed before the signature was written: no release kept
  await wd.w.update("meta", "owed/op-w", (v) => {
    const r = v as Record<string, Record<string, unknown>>;
    const { release: _r, ...rest } = r[id]!;
    return { ...r, [id]: rest };
  });
  const pad = Array.from({ length: 2_500 }, (_, i) => base58.encode(Uint8Array.from({ length: 64 }, (_, k) => (k < 4 ? (i >> (8 * k)) & 255 : 9))));
  wd.plant.history = (s) => [...pad, ...s];
  const [r0, r1] = wd.host.rpcs;
  const fresh = (rpc: typeof r0): typeof r0 => (async (m: string, p: readonly unknown[]) => rpc(m, p)) as typeof r0;
  const o2 = { ...over, fetch: undefined };
  Object.defineProperty(o2, "rpcs", { get: () => [fresh(r0), fresh(r1)], enumerable: true });
  const t2 = testnetPool(page, o2);
  const W = wd.binds[0]!.recipient;
  await t2.stateRead();
  assert.equal(wd.balance.get(TO), undefined, "one pass (2,000 entries) read in the first finish: not yet found");
  // the failed finish waits 2 s before the next try
  await new Promise((r) => setTimeout(r, 2_100));
  await t2.stateRead();
  assert.equal(wd.balance.get(W), 0n);
  assert.equal(wd.balance.get(TO), 5_000_000n);
  assert.equal(((await wd.w.get("ops", "op-w")) as { stage: string }).stage, "sent");
  await end();
});

// Card sol-settle-failed-is-not-unspent (C3): the buy's settle that decides not_landed is held to the slots of the read
// that saw the blockhash past; the page's buy host hands them to solanaSettleSpent, so its lister and seats are asked at
// or past them
test("the page's buy host asks its settle at the slots the buy hands it: the lister at or past the higher", async () => {
  const { w, ns } = await wallet();
  const { poolBuyKind } = await import("../src/pool-buy.ts");
  let buyHost: Parameters<typeof poolBuyKind>[0] | undefined;
  const asked: unknown[] = [];
  const lister = (async (_m: string, p: readonly unknown[]) => {
    asked.push((p[1] as { minContextSlot?: unknown }).minContextSlot);
    throw new Error("HTTP 503");
  }) as never;
  const rpc = async (m: string) => {
    throw new Error(`offline ${m}`);
  };
  testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { rpcs: [rpc, async (m: string) => rpc(m)], lister, cache: {}, prover: { vault: signalsProver(), stop: () => {} }, tradeKinds: { buy: (mk) => ((buyHost = mk), poolBuyKind(mk)) } });
  const { land } = fakePool();
  const n = await land(ns, await incoming(ns, null, 7));
  const b = buyHost!();
  try {
    await assert.rejects(b.settle(n.id, [700, 710]));
    assert.deepEqual(asked, [710]);
    asked.length = 0;
    await assert.rejects(b.settle(n.id));
    assert.deepEqual(asked, [undefined], "none handed: none asked");
  } finally {
    (b as { end?: () => void }).end?.();
  }
});

// Delta review 8 of 5697d7a1, F3: W's buy record goes through the page's wallet store, written by the buy host the page
// wires into pool.buy and read by the sell host it wires into pool.sell (the rent back holds with none)
test("the page's buy host writes W's buy record in the wallet store's meta/owed/buy-sol, and its sell host reads it back", async () => {
  const { w } = await wallet();
  const { poolBuyKind } = await import("../src/pool-buy.ts");
  const { poolSellKind } = await import("../src/pool-sell.ts");
  let buyHost: Parameters<typeof poolBuyKind>[0] | undefined;
  let sellHost: Parameters<typeof poolSellKind>[0] | undefined;
  testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { tradeKinds: { buy: (mk) => ((buyHost = mk), poolBuyKind(mk)), sell: (mk) => ((sellHost = mk), poolSellKind(mk)) } });
  const A = "CTsw1111111111111111111111111111111111111111";
  const rec = { mint: "So11111111111111111111111111111111111111112", program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" };
  const b = buyHost!();
  const s = sellHost!();
  try {
    assert.equal(await s.bought?.get(A), undefined, "no record yet");
    await b.bought!.put(A, rec);
    assert.deepEqual(await w.get("meta", "owed/buy-sol"), { [A]: rec });
    assert.deepEqual(await s.bought!.get(A), rec);
    // card sol-pool-buy-lands-on-mainnet: both hosts carry the page's cluster (the buy's tip, the sell's priority fee)
    assert.equal(s.cluster, PAGE_CLUSTER);
    assert.equal((b as { cluster?: string }).cluster, PAGE_CLUSTER);
  } finally {
    (b as { end?: () => void }).end?.();
    (s as { end?: () => void }).end?.();
  }
});

// Review of fcd67b72, P1: a sell with no deposit back makes no note, so a state read that settles sells only on an
// INCOMING return or R note never read its record: a page closed after its send (or a sell that ended "sent" past its
// read budget) left the op "sent" for good. The state read settles sells when a kept record is there too.
for (const withNote of [false, true]) {
  test(`a load whose store holds a sell kept on W left sent${withNote ? ", beside another sell's INCOMING note" : ", and no INCOMING note"}: the state read settles it not_landed and drops its record`, async () => {
    const seed64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
    const w = await openWalletStore({ indexedDB: new IDBFactory() });
    await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
    const ns = await openNoteStore(w);
    try {
      const sig = base58.encode(new Uint8Array(64).fill(9));
      const wire = new Uint8Array(1 + 64 + 8);
      wire[0] = 1;
      wire.set(new Uint8Array(64).fill(9), 1);
      // what the sell leaves when its page closes after the send: its kept record and the op "sent"
      await w.update("meta", "owed/kept-sell-sol", () => ({ [sig]: { signature: sig, tx: base64.encode(wire), last: 151 } }));
      await w.put("ops", "op1", { kind: "sell", pool: "sol", sha: "00", stage: "sent", txs: [{ chain: "solana", hash: sig }], created_ms: 1 });
      if (withNote) {
        const ref = { kind: "return", c: "sol", l: 8n, j: 0 } as const;
        const n = await ns.add({ ref, scope: solanaPoolOf(SOL_POOLS.devnet!.program).scope, precommitment: noteSecrets(seed64, ref).precommitment, state: "PLANNED" });
        await ns.move(n.id, "PLANNED", "INCOMING", { send: { signature: base58.encode(new Uint8Array(64).fill(3)), value: 5_000_000n, last_valid_block_height: 1_000_000n } });
      }
      // both RPCs: no such transaction, past its blockhash, and no status of it at a slot past that
      const rpc = () => async (m: string) => {
        if (m === "getTransaction") return null;
        if (m === "getEpochInfo") return { blockHeight: 1_000, absoluteSlot: 500, epoch: 1, slotIndex: 0, slotsInEpoch: 432_000 };
        if (m === "getSignatureStatuses") return { context: { slot: 600 }, value: [null] };
        throw new Error("offline");
      };
      const t = testnetPool({ store: async () => w, seed64: async () => seed64.slice() }, { rpcs: [rpc(), rpc()] as never, prover: { vault: signalsProver(), stop: () => {} } });
      await t.stateRead();
      assert.equal(((await w.get("ops", "op1")) as { stage: string }).stage, "not_landed");
      assert.deepEqual(Object.keys(((await w.get("meta", "owed/kept-sell-sol")) as Record<string, unknown> | undefined) ?? {}), []);
    } finally {
      ns.close();
      w.close();
    }
  });
}

// Review of 5de2165e, P3-1 and P3-2: the state read's settle of a kept sell, under a failed ops write and a kept list
// read that always fails. A store left with a kept sell's record and its op "sent", both RPCs reading it gone.
async function keptWorld() {
  const seed64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  (await openNoteStore(w)).close();
  const sig = base58.encode(new Uint8Array(64).fill(9));
  const wire = new Uint8Array(1 + 64 + 8);
  wire[0] = 1;
  wire.set(new Uint8Array(64).fill(9), 1);
  await w.update("meta", "owed/kept-sell-sol", () => ({ [sig]: { signature: sig, tx: base64.encode(wire), last: 151 } }));
  await w.put("ops", "op1", { kind: "sell", pool: "sol", sha: "00", stage: "sent", txs: [{ chain: "solana", hash: sig }], created_ms: 1 });
  const gone = () => async (m: string) => {
    if (m === "getTransaction") return null;
    if (m === "getEpochInfo") return { blockHeight: 1_000, absoluteSlot: 500, epoch: 1, slotIndex: 0, slotsInEpoch: 432_000 };
    if (m === "getSignatureStatuses") return { context: { slot: 600 }, value: [null] };
    throw new Error("offline");
  };
  const pool = (store: WalletStore) => testnetPool({ store: async () => store, seed64: async () => seed64.slice() }, { rpcs: [gone(), gone()] as never, prover: { vault: signalsProver(), stop: () => {} } });
  const stage = async (k = "op1") => ((await w.get("ops", k)) as { stage: string }).stage;
  const kept = async () => Object.keys(((await w.get("meta", "owed/kept-sell-sol")) as Record<string, unknown> | undefined) ?? {});
  return { w, sig, pool, stage, kept };
}
/** The wallet store, one method of it changed. */
const storeWith = (w: WalletStore, key: "get" | "update", f: (orig: (...a: unknown[]) => Promise<unknown>, ...a: unknown[]) => Promise<unknown>): WalletStore =>
  new Proxy(w, {
    get(target, k, recv) {
      const v = Reflect.get(target, k, recv);
      if (k === key) return (...a: unknown[]) => f((...b: unknown[]) => (v as (...c: unknown[]) => Promise<unknown>).apply(target, b), ...a);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as WalletStore;

// P3-1: the kept record was dropped before the op's stage was written, and that write's failure swallowed, so one
// failed write left the op "sent" for good (at 5de2165e: {"stage":"sent","kept":[]}). The record is dropped only once
// the op's stage is written; the next read settles it.
test("a kept sell settled while the ops write fails once: the record stays, and the next state read settles its op", async () => {
  const k = await keptWorld();
  let fail = true;
  const flaky = storeWith(k.w, "update", (orig, store, ...rest) => {
    if (store === "ops" && fail) {
      fail = false;
      return Promise.reject(new Error("ops write failed"));
    }
    return orig(store, ...rest);
  });
  try {
    const t = k.pool(flaky);
    await t.stateRead();
    assert.deepEqual({ stage: await k.stage(), kept: await k.kept() }, { stage: "sent", kept: [k.sig] }, "the write failed: the record kept");
    await t.stateRead();
    assert.deepEqual({ stage: await k.stage(), kept: await k.kept() }, { stage: "not_landed", kept: [] });
  } finally {
    k.w.close();
  }
});

// P3-2: the state read's kept list read is guarded (a failed read counts as none): one that always fails never ends the
// read early, so the dead sell request's settle after it (and the proofs, the onward sends, the rent backs) still run.
test("a kept list read that always fails: the same state read still settles a dead pending sell request", async () => {
  const k = await keptWorld();
  await k.w.put("ops", "op2", { kind: "sell", pool: "sol", sha: "00", stage: "pending", txs: [], created_ms: 1 });
  const flaky = storeWith(k.w, "get", (orig, store, key, ...rest) => (store === "meta" && key === "owed/kept-sell-sol" ? Promise.reject(new Error("meta read failed")) : orig(store, key, ...rest)));
  try {
    await k.pool(flaky).stateRead();
    assert.equal(await k.stage("op2"), "refused");
  } finally {
    k.w.close();
  }
});

test("card wallet-restore-reads-ux review P3: the testnet build's restore reads no deposit id nor any U_X, so a walked pool ends it stalled by name, never done", async () => {
  const { poolRestore, POOL_UX_UNREAD_TESTNET, pageIdReads, restoreUxSolanaRpcs } = await import("../src/pool-restore.ts");
  assert.equal(pageIdReads(), null);
  assert.equal(restoreUxSolanaRpcs(), null);
  const ends: { stage: string; why: readonly string[] }[] = [];
  const store = await openWalletStore({ name: "restore-testnet", indexedDB: new IDBFactory() });
  const r = poolRestore({
    store: async () => store,
    seed64: async () => new Uint8Array(64).fill(7),
    signedIn: async () => true,
    pools: () => [{ chain: "solana", program: SOL_POOLS.devnet!.program, scope: 1n, rpcs: () => [null as never, null as never] }],
    solana: (async () => ({ notes: [], spends: [] })) as never,
    ended: (stage, why) => void ends.push({ stage, why }),
  });
  try {
    assert.equal(await r.auto(), "stalled");
    assert.deepEqual(ends, [{ stage: "stalled", why: [`solana: ${POOL_UX_UNREAD_TESTNET}`] }]);
  } finally {
    store.close();
  }
});

// Review P2-2 and P3-5 of 77055f4e (card pool-sell-share-across-wallets): the page's sell host writes a sale settled
// outside a request's run (the load's rent back) to the record that names it, and stops its sales at a sign out
test("the page's sell host settles a sale's record by its signature, and a sign out asked after it stops its sales; a host made after the sign out is not stopped", async () => {
  const { w } = await wallet();
  const { poolSellKind } = await import("../src/pool-sell.ts");
  let sellHost: Parameters<typeof poolSellKind>[0] | undefined;
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { tradeKinds: { sell: (mk) => ((sellHost = mk), poolSellKind(mk)) } });
  const s = sellHost!();
  try {
    await w.put("ops", "op-s", { kind: "sell", pool: "sol", sha: "00", stage: "sent", txs: [{ chain: "solana", hash: "sigS" }], created_ms: 1 });
    await s.settled!("sigS", "filled");
    assert.equal(((await w.get("ops", "op-s")) as { stage: string }).stage, "filled");
    assert.equal(s.stopped!(), false);
    t.signingOut();
    assert.equal(s.stopped!(), true);
    const after = sellHost!();
    assert.equal(after.stopped!(), false);
    (after as { end?: () => void }).end?.();
  } finally {
    (s as { end?: () => void }).end?.();
  }
});

// review P3-6 of a34c1626: the helper's start check (apps/helper/src/env-check.ts checkSolanaPairOperators) refuses a
// keyed Solana URL of this page's direct seat's operator; it names that seat in its own constant (the helper imports no
// page code), read here as text and held equal to the page's, so a new direct seat moves both
test("the helper's start check names every member of this page's public Solana seat (SOLANA_PUBLIC_SEAT), in its order", () => {
  const helper = readFileSync(new URL("../../../apps/helper/src/env-check.ts", import.meta.url), "utf8");
  const line = /export const PAGE_SOLANA_PUBLIC_SEAT: readonly string\[\] = Object\.freeze\(\[([^\]]*)\]\);/.exec(helper)?.[1];
  assert.ok(line !== undefined, "env-check.ts PAGE_SOLANA_PUBLIC_SEAT");
  assert.deepEqual([...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]), [...SOLANA_PUBLIC_SEAT]);
  assert.equal(SOLANA_PUBLIC_SEAT[0], SOLANA_PROVIDER_A);
});

// The review of 8522bdf8, F6: the testnet build's finder (pool-testnet.ts finderOf, no holdings given) reads the Ws on
// the pair's first devnet RPC with one try a call and the route's gate: a 429 is not asked again by a retry, and the
// next round waits the gate (1 s), where the pair's own client asked again within its 3.5 s retry. Read by the
// positions pass, which takes the same finder as a sell.
test("the testnet finder reads the Ws on the first devnet RPC, one try a call: a 429 waits the route's gate, never a retry", async () => {
  const { onTestClock } = await import("../../kit/test/test-clock.ts");
  const { freshWallet } = await import("../../wallet/src/derive/keys.ts");
  const { jOf } = await import("../../wallet/src/pool/queue.ts");
  const { POSITION_COSTS_KEY } = await import("../src/positions.ts");
  await onTestClock(async () => {
    const { w, ns } = await wallet();
    const ref = { kind: "deposit" as const, s: SCOPE, i: 0 };
    const pre = noteSecrets(SEED64, ref).precommitment;
    const label = 991n;
    const r = await ns.add({ ref, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value: 10_000_000n, label, commitment: noteCommitment(10_000_000n, label, pre), leafIndex: 0n } });
    await ns.move(r.id, "UNSPENT", "SPENT");
    const fw = freshWallet(SEED64, "sol", label, jOf(ref));
    fw.secretKey.fill(0);
    await w.put("meta", POSITION_COSTS_KEY, { [fw.address]: { mint: SOL_TOKEN, received: "5", decimals: 9 } });
    const host = new URL(TESTNET_RPCS.solana[0]).host;
    // the gate's first pause on the test clock, from the first 429: a call before its timer fires came before the gate opened
    const seen: { host: string; method: string; open: boolean }[] = [];
    let hot = 2, open = false, timed = false;
    // the fourth getTokenAccountsByOwner, waited for as it comes: before its first read the pass reads fake IndexedDB
    // and takes the seed's Web Lock, work in real time the test clock cannot see, so a loop of clock ticks ran its
    // whole bound out first (CI, 11 Nov: no request seen)
    let fourth = (): void => {};
    const four = new Promise<void>((ok) => (fourth = ok));
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
      if (b.params?.[0] !== fw.address) return new Response("offline", { status: 503 });
      seen.push({ host: new URL(String(u)).host, method: b.method, open });
      if (seen.filter((x) => x.method === "getTokenAccountsByOwner").length >= 4) fourth();
      if (b.method === "getTokenAccountsByOwner" && hot > 0) {
        if (!timed) (timed = true), setTimeout(() => (open = true), 999);
        return hot--, new Response("slow down", { status: 429 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: b.method === "getBalance" ? 0 : [] } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { positions: { setTimer: () => 0, clearTimer: () => {} } } as never);
      await t.positions();
      await realWithin(four, 8_000);
    } finally {
      globalThis.fetch = real;
    }
    assert.ok(seen.length > 0 && seen.every((x) => x.host === host), seen.map((x) => x.host).join(" "));
    const tao = seen.filter((x) => x.method === "getTokenAccountsByOwner");
    assert.equal(tao.length, 4, "two calls a round, two rounds: no retry of a 429");
    assert.deepEqual(tao.map((x) => x.open), [false, false, true, true], "the second round after the gate's 1 s pause");
  });
});

// Card sol-buy-reads-side-by-side: the page's buy host reads the pool's time for the take on the page's pool (its two
// RPCs, the wallet's solanaNow: the lower finalized block time), and its take hands that read to the queue (review of
// 6b3bd660, P3-D)
test("card sol-buy-reads-side-by-side: the page's buy host reads the pool's time on both of the page's RPCs, the lower block time", async () => {
  const { w } = await wallet();
  const { poolBuyKind } = await import("../src/pool-buy.ts");
  let buyHost: Parameters<typeof poolBuyKind>[0] | undefined;
  const asked: [string[], string[]] = [[], []];
  const rpcOf = (i: 0 | 1, slot: number, sec: number) => async (m: string) => {
    asked[i].push(m);
    if (m === "getSlot") return slot;
    if (m === "getBlockTime") return sec;
    throw new Error(`offline ${m}`);
  };
  testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { rpcs: [rpcOf(0, 100, 1_800_000_010), rpcOf(1, 99, 1_800_000_000)], tradeKinds: { buy: (mk) => ((buyHost = mk), poolBuyKind(mk)) } });
  const b = buyHost!();
  try {
    const before = performance.now();
    const n = await b.chainNow!();
    assert.equal(n.ms, 1_800_000_000_000n, "the lower of the two RPCs' block times");
    assert.ok(n.at >= before && n.at <= performance.now());
    assert.equal(typeof n.wall, "number");
    assert.deepEqual(asked, [["getSlot", "getBlockTime"], ["getSlot", "getBlockTime"]], "each RPC asked once");
  } finally {
    (b as { end?: () => void }).end?.();
  }
});

test("card sol-buy-reads-side-by-side: the page's buy host hands the early read to the queue's take, which then reads no time of its own", async () => {
  const { w, ns } = await wallet();
  const { pool, land } = fakePool();
  let nows = 0;
  const counted = { ...pool, now: async () => (nows++, NOW) };
  const { poolBuyKind } = await import("../src/pool-buy.ts");
  let buyHost: Parameters<typeof poolBuyKind>[0] | undefined;
  const offline = async () => {
    throw new Error("offline");
  };
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pool: counted, prover: { vault: signalsProver(), stop: () => {} }, hardwareConcurrency: 4, rpcs: [offline, async () => offline()], tradeKinds: { buy: (mk) => ((buyHost = mk), poolBuyKind(mk)) } });
  await land(ns, await incoming(ns, null, 9));
  await t.stateRead();
  await t.proofs();
  const b = buyHost!();
  try {
    const [r] = await b.ready();
    assert.ok(r, "a ready proof");
    const early = b.chainNow!();
    await early;
    const before = nows;
    assert.equal((await b.take(r.noteId, r.attempt, early)).noteId, r.noteId);
    assert.equal(nows, before, "the take used the early read");
  } finally {
    (b as { end?: () => void }).end?.();
  }
});

// review P3-3 of b57f4eb28: the page's buy host lists on the take's own clock when the pick hands it the early read
// (queue.readyAt), and on the last-seen time without one (queue.ready): one the early read finds late is never offered
test("card buy-spends-several-pieces: the page's buy host lists the ready proofs on the early read it is given", async () => {
  const { w, ns } = await wallet();
  const { pool, land } = fakePool();
  const { poolBuyKind } = await import("../src/pool-buy.ts");
  let buyHost: Parameters<typeof poolBuyKind>[0] | undefined;
  const offline = async () => {
    throw new Error("offline");
  };
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pool, prover: { vault: signalsProver(), stop: () => {} }, hardwareConcurrency: 4, rpcs: [offline, async () => offline()], tradeKinds: { buy: (mk) => ((buyHost = mk), poolBuyKind(mk)) } });
  await land(ns, await incoming(ns, null, 9));
  await t.stateRead();
  await t.proofs();
  const b = buyHost!();
  try {
    const [r] = await b.ready();
    assert.ok(r, "a ready proof on the last-seen time");
    // two epochs on, on the early read's own clock: the proof is from before the previous epoch, so not takeable
    const later = Promise.resolve({ ms: r.epochStartMs + 2n * SOL_EPOCH_MS, at: performance.now(), wall: Date.now() });
    assert.deepEqual(await b.ready(later), [], "the host offered a proof the early read finds late");
    assert.ok((await b.ready()).some((p) => p.noteId === r.noteId), "still listed on the last-seen time");
  } finally {
    (b as { end?: () => void }).end?.();
  }
});

// card pool-buy-record-never-stays-sent, on the page: the buy host's take writes the last height, its landed reaches the
// state's view (readyWith's landed, which state.pools counts) and the watchers, and a run that ended "sent" is followed by
// the page's state reads: its end posted once, to that run, once its note is out of RESERVED
test("card pool-buy-record-never-stays-sent: the page's buy host writes the take's last height, tells the state a landed release (read by another tab too), and posts a followed buy's end once", async () => {
  const { w, ns } = await wallet();
  const { pool, land } = fakePool();
  const offline = async () => {
    throw new Error("offline");
  };
  type Host = ReturnType<Parameters<typeof import("../src/pool-buy.ts").poolBuyKind>[0]>;
  let hostOf: (() => Host) | null = null;
  const buy = ((h: () => Host) => ((hostOf = h), () => ({ error: "not_allowed" }))) as unknown as typeof import("../src/pool-buy.ts").poolBuyKind;
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pool, prover: { vault: signalsProver(), stop: () => {} }, hardwareConcurrency: 4, rpcs: [offline, async () => offline()], tradeKinds: { buy } });
  let heard = 0;
  t.watch(() => heard++);
  await land(ns, await incoming(ns, null, 9));
  await t.stateRead();
  await t.proofs();
  const r = (await t.readyWith(async () => null)).ready![0]!;
  const h = hostOf!() as Host & { follow(post: (s: "filled" | "not_landed") => void): void };
  await h.take(r.noteId, r.attempt, undefined, 151n);
  const taken = await ns.get(r.noteId);
  assert.equal(taken?.state, "RESERVED");
  assert.equal((taken as Record<string, unknown> | undefined)?.lastHeight, undefined, "never in the note");
  assert.equal((await ns.marks()).get(r.noteId)?.lastHeight, 151n, "the take writes the signed transaction's last height on the note's mark");
  const before = heard;
  h.landed!(r.noteId, r.attempt, 4n);
  const want = [[r.noteId, { attempt: r.attempt, withdrawn: 4n }]];
  const landedOf = async (p: typeof t) => [...((await p.readyWith(async () => null)).landed ?? [])];
  for (let i = 0; i < 200 && heard === before; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await landedOf(t), want, "the state's view carries the landed release");
  assert.ok(heard > before, "the watchers hear it, so the app reads the state again");
  // another tab on the same store (and this one after a reload) counts it too: the landed value is on the note's mark
  const t2 = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pool, prover: { vault: signalsProver(), stop: () => {} }, hardwareConcurrency: 4, rpcs: [offline, async () => offline()] });
  assert.deepEqual(await landedOf(t2), want, "another tab's state view");
  await t2.signedOut();
  const posts: string[] = [];
  h.follow((s) => void posts.push(s));
  // still RESERVED (the pass's reads offline): its end is not known, nothing posted
  await t.stateRead();
  assert.deepEqual(posts, []);
  // the pass frees it (both RPCs' finalized height past 151, no spent mark): not_landed, once
  await ns.move(r.noteId, "RESERVED", "UNSPENT", { finalHeight: 152n });
  await t.stateRead();
  assert.deepEqual(posts, ["not_landed"]);
  await t.stateRead();
  assert.deepEqual(posts, ["not_landed"], "posted once");
  await t.signedOut();
});

// review P2-2: a part W's reverted send left on W is kept in the op's record, by note, with W, its index and the amount
test("mergeWithdrawOp keeps a part held on W by note (W, its index, the amount), beside the stage and the cleared owed send", () => {
  const a = { chain: "base", noteId: "n1", w: "0x1111111111111111111111111111111111111111", l: "5", j: 0, amount: "100" } as const;
  const b = { ...a, noteId: "n2", j: 1, amount: "7" } as const;
  const r = mergeWithdrawOp({ kind: "withdraw", stage: "in_transit", txs: [], owed: "n1" }, { stage: "stopped", txs: [{ chain: "base", hash: "0xr" }], clear: "n1", held: a });
  assert.equal(r.stage, "stopped");
  assert.equal(r.owed, undefined);
  assert.deepEqual(r.held, { n1: a });
  assert.deepEqual(mergeWithdrawOp(r, { held: b }).held, { n1: a, n2: b });
  assert.equal(mergeWithdrawOp({ kind: "withdraw" }, { stage: "stopped" }).held, undefined, "nothing held: no field");
});

// review 2 of e1f9e87a (P2-A, P3-1; the review's X10, X11): a part held on W is written in the stage's own write, and
// the owed send stays until the op ends
const HELD = { chain: "base", noteId: "n1", w: "0x1111111111111111111111111111111111111111", l: "5", j: 0, amount: "100" } as const;
const evmOwed = (to: string) => ({ ...owedPending("n1", to), chain: "base", part: "1", nullifier: "2", from: "3", deadlineMs: "4", chunk: "5", fee: "6" }) as const;
test("(X11) the EVM run's stage write: in_transit with `held` in one write, the owed send kept; an end with no owed send clears and drops it", async () => {
  const { w } = await wallet();
  const p = evmOwed("0x2222222222222222222222222222222222222222");
  await w.put("ops", "op1", { kind: "withdraw", stage: "submitted", txs: [], owed: "n1" });
  await oweSend(w, "op1", p);
  const writes: unknown[] = [];
  const update = w.update.bind(w);
  (w as { update: unknown }).update = async (store: string, key: string, f: (v: unknown) => unknown) => update(store as never, key as never, (v: unknown) => {
    const r = f(v);
    if (store === "ops") writes.push(r);
    return r as never;
  });
  await writeEvmStage(w, "op1", { stage: "in_transit", txs: [{ chain: "base", hash: "0xr" }, { chain: "base", hash: "0xw" }], arrived: {}, held: HELD }, null);
  assert.equal(writes.length, 1, "one write");
  const r = (await w.get("ops", "op1")) as Record<string, unknown>;
  assert.deepEqual([r.stage, r.owed, r.held], ["in_transit", "n1", { n1: HELD }], "the stage and `held` together, still owed");
  assert.deepEqual(Object.keys((await w.get("meta", "owed/op1")) as object), ["n1"], "the owed send kept");
  await writeEvmStage(w, "op1", { stage: "stopped", txs: [], arrived: {} }, "n1");
  assert.equal(((await w.get("ops", "op1")) as Record<string, unknown>).owed, undefined);
  assert.deepEqual(await w.get("meta", "owed/op1"), {});
});

test("(X10) the EVM finish's write: in_transit (a part held on W, or the fee it needs) keeps the owed send with `held` or fee_needed in the same write; an end clears and drops it", async () => {
  const { w } = await wallet();
  const p = evmOwed("0x2222222222222222222222222222222222222222");
  await w.put("ops", "op1", { kind: "withdraw", stage: "in_transit", txs: [], owed: "n1" });
  await oweSend(w, "op1", p);
  assert.equal(await writeEvmFinish(w, "op1", "n1", { stage: "in_transit", txs: [{ chain: "base", hash: "0xw" }], arrived: {}, held: HELD }), true);
  let r = (await w.get("ops", "op1")) as Record<string, unknown>;
  assert.deepEqual([r.stage, r.owed, r.held, r.txs], ["in_transit", "n1", { n1: HELD }, [{ chain: "base", hash: "0xw" }]]);
  assert.deepEqual(Object.keys((await w.get("meta", "owed/op1")) as object), ["n1"], "the owed send kept");
  assert.equal(await writeEvmFinish(w, "op1", "n1", { stage: "in_transit", txs: [], arrived: {}, feeNeeded: "9" }), true);
  assert.equal(((await w.get("ops", "op1")) as Record<string, unknown>).fee_needed, "9");
  assert.equal(await writeEvmFinish(w, "op1", "n1", { stage: "sent", txs: [{ chain: "base", hash: "0xs" }], arrived: { "0xs": "1" } }), false);
  r = (await w.get("ops", "op1")) as Record<string, unknown>;
  assert.deepEqual([r.stage, r.owed, r.fee_needed], ["sent", undefined, undefined]);
  assert.deepEqual(r.held, { n1: HELD }, "what W held stays on the record");
  assert.deepEqual(await w.get("meta", "owed/op1"), {});
});

test("keepEvmSend keeps every resend signed after a revert (a reload's, another tab's), each with its nonce, never one dropped", async () => {
  const { w } = await wallet();
  const p = evmOwed("0x2222222222222222222222222222222222222222");
  await oweSend(w, "op1", p);
  await keepEvmSend(w, "op1", { ...p, resends: [{ nonce: "1", hash: "0xa" }] });
  await keepEvmSend(w, "op1", { ...p, resends: [{ nonce: "1", hash: "0xb" }] });
  await keepEvmSend(w, "op1", { ...p, feeCap: "7" });
  assert.deepEqual(((await w.get("meta", "owed/op1")) as Record<string, { resends?: unknown }>).n1!.resends, [{ nonce: "1", hash: "0xa" }, { nonce: "1", hash: "0xb" }]);
});

// review 3 of 972be65f (X10b): the state reads' owed pass hands the op's `held` to the EVM finish, so a part left on W
// by a send that reverted gets its one resend at W's next nonce; without it the finish reads only the reverted send and
// the op stays in_transit for good
test("(X10b) the owed pass hands the op's `held` to the EVM finish: W's resend at nonce 1 is signed, kept before it leaves, and the op ends sent", async () => {
  const { w, ns } = await wallet();
  const { freshWallet } = await import("../../wallet/src/derive/keys.ts");
  const { evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
  const pin = EVM_POOLS["base-sepolia"]!;
  const scope = evmPoolScopeOf(pin.pool, 84532n);
  const ref: NoteRef = { kind: "deposit", s: scope, i: 0 };
  const label = vaultLabelOf(keccak_256, scope, 1n);
  const value = 10n ** 15n;
  const pre = noteSecrets(SEED64, ref).precommitment;
  let n = await ns.add({ ref, scope, precommitment: pre, state: "UNSPENT", leaf: { value, label, commitment: noteCommitment(value, label, pre), leafIndex: 0n } });
  n = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 1_800_000_210_000n, context: "18" });
  const attempt = n.attempt!;
  n = await ns.move(n.id, "HELD", "RESERVED", { attempt });
  const W = freshWallet(SEED64, "evm", label, 0).address;
  const TO = "0x1111111111111111111111111111111111111111";
  const H1 = "0x" + "c1".repeat(32);
  const REL = "0x" + "ab".repeat(32);
  const [part, fee, wFee] = [10n ** 14n, 2n * 10n ** 13n, 210_000_000_000n];
  const chunk = part + fee + wFee;
  const nullifier = noteSecrets(SEED64, ref).nullifierHash;
  const held = { chain: "base", noteId: n.id, w: W, l: label.toString(), j: 0, amount: (part + wFee / 2n).toString() } as const;
  await w.put("ops", "op1", { kind: "withdraw", stage: "in_transit", txs: [{ chain: "base", hash: REL }, { chain: "base", hash: H1 }], created_ms: 1, owed: n.id, held: { [n.id]: held } });
  await oweSend(w, "op1", { noteId: n.id, attempt, context: "18", to: TO, last: true, feeCap: (10n ** 15n).toString(), chain: "base", part: part.toString(), nullifier: nullifier.toString(), from: "1", deadlineMs: "1800000210000", chunk: chunk.toString(), fee: fee.toString(), onward: H1, release: REL } as never);
  // the chain: the pinned pool's Withdrawn of the nullifier paying W the chunk; W's nonce-0 send H1 reverted (status 0
  // on both, at the safe block); W holds `held`; a send of W's lands once made
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const q = (v: bigint) => "0x" + v.toString(16);
  const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  const hashOf = (raw: string) => "0x" + hex(keccak_256(Uint8Array.from(Buffer.from(raw.slice(2), "hex"))));
  const topic = "0x" + hex(keccak_256(new TextEncoder().encode("Withdrawn(address,address,uint256,uint256,uint256,uint256)")));
  const log = { address: pin.pool, topics: [topic, word(BigInt(W))], data: "0x" + [BigInt(pin.feeRecipient), chunk, fee, nullifier, 1n].map((v) => v.toString(16).padStart(64, "0")).join(""), blockNumber: "0xf0", logIndex: "0x0", transactionHash: REL, blockHash: "0x" + "bb".repeat(32) };
  const sent: string[] = [];
  const rpc = (k: string) => Object.assign(async (method: string, params: readonly unknown[] = []): Promise<unknown> => {
    if (method === "eth_blockNumber") return "0x100";
    if (method === "eth_getBlockByNumber") return { number: "0x100", hash: "0x" + "be".repeat(32), timestamp: q((1_800_000_000_000n + 600_000n) / 1000n), baseFeePerGas: q(10_000_000n) };
    if (method === "eth_getLogs") return [log];
    if (method === "eth_getTransactionCount") return q(sent.length > 0 ? 2n : 1n);
    if (method === "eth_getBalance") return q(BigInt(held.amount));
    if (method === "eth_getCode") return "0x";
    if (method === "eth_estimateGas") return q(21_000n);
    if (method === "eth_call") return (params[0] as { to: string }).to.toLowerCase() === "0x420000000000000000000000000000000000000f" ? word(900n) : "0x";
    if (method === "eth_sendRawTransaction") return (sent.push(String(params[0])), hashOf(String(params[0])));
    if (method === "eth_getTransactionReceipt") {
      const h = String(params[0]);
      const mine = sent.some((r) => hashOf(r) === h);
      return h === H1 || mine ? { status: mine ? "0x1" : "0x0", from: W, to: TO, blockHash: "0x" + "ee".repeat(32), blockNumber: "0xf0" } : null;
    }
    if (method === "eth_getTransactionByHash") return { value: q(part) };
    throw new Error(`${k}: no ${method}`);
  }, { url: `https://${k}.invalid` });
  const offline = Object.assign(async () => Promise.reject(new Error("offline")), { url: "https://sol.invalid" });
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, {
    rpcs: [offline, offline], prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => (c === "base" ? pin : undefined), evmRpcs: (c) => (c === "base" ? [rpc("a"), rpc("b")] : null),
    evmSync: () => ({ events: async () => Promise.reject(new Error("offline")) }),
    evmQueuePool: () => ({ ...({} as Pool<unknown>), id: "evm:x", scope, now: async () => Promise.reject(new Error("offline")), trees: async () => Promise.reject(new Error("offline")) }) as unknown as Pool<unknown>,
    wait: async () => {},
  });
  for (let i = 0; i < 5 && sent.length === 0; i++) await t.stateRead();
  assert.ok(sent.length > 0, "W's resend signed and sent");
  const tx = sent.map(hashOf);
  const owed = (await w.get("meta", "owed/op1")) as Record<string, { resends?: { nonce: string; hash: string }[] }> | undefined;
  const r = (await w.get("ops", "op1")) as { stage: string; arrived?: Record<string, string> };
  assert.equal(r.stage, "sent", "the resend landed: the op ends sent");
  assert.deepEqual(Object.keys(r.arrived ?? {}), [tx[0]]);
  assert.deepEqual(owed ?? {}, {}, "the owed send dropped once sent");
  await t.signedOut();
});

// card pool-tree-read-waits-for-its-second, round 3: the app's hidden frame and the top-level withdraw sheet, two pages
// on one wallet store, each with its own proof queue. The frame's pass runs on its state reads, which every store
// write wakes (the change event, below); here each wait of the sheet's run stands for one.
const twoDocs = async (values: bigint[], refs: (NoteRef | undefined)[], times: bigint[]) => {
  const { world, NOW } = WORLD;
  const E = SOL_EPOCH_MS as bigint;
  const B = NOW - (NOW % E) + E;
  let slept = 0n;
  let onWait: (() => Promise<unknown>) | null = null;
  const wd = await world(values, {
    trees: (state, labels) => async (beforeMs) => {
      const n = times.filter((t) => t < beforeMs).length;
      const s = new VaultTree(state.slice(0, n)), l = new VaultTree(labels.slice(0, n));
      return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
    },
    refs,
    now: () => (slept >= B - NOW ? B : NOW),
    wait: async (ms) => {
      slept += BigInt(ms);
      await onWait?.();
    },
  });
  // hold.on(): the frame's pass waits at its time read (past its skip read) until hold.off()
  let gate: Promise<void> | null = null;
  let open = (): void => {};
  const hold = {
    on: () => void (gate = new Promise<void>((r) => (open = r))),
    off: () => {
      gate = null;
      open();
    },
  };
  const qPool = {
    ...wd.host.pool,
    now: async (...a: Parameters<typeof wd.host.pool.now>) => {
      if (gate !== null) await gate;
      return wd.host.pool.now(...a);
    },
    bind: (b: Parameters<typeof wd.host.pool.bind>[0], s?: AbortSignal) => wd.host.pool.bind({ ...b, tipCap: b.tipCap ?? 1n }, s),
  };
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { pool, tx } = JSON.parse(init.body) as { pool: string; tx: string };
    return new Response(JSON.stringify(await wd.host.send(pool, base64.decode(tx))), { status: 200 });
  }) as unknown as typeof fetch;
  const mk = (pool: unknown) => testnetPool({ store: async () => wd.w, seed64: async () => SEED64.slice() }, { pin: wd.host.pin, rpcs: wd.host.rpcs, pool: pool as never, prover: { vault: signalsProver(), stop: () => {} }, fetch: fetchFn, hardwareConcurrency: 4, now: () => NOW + slept, wait: wd.host.wait } as never);
  return { wd, B, hold, frame: mk(qPool), top: mk(wd.host.pool), onWait: (f: () => Promise<unknown>) => void (onWait = f) };
};
const RET: NoteRef = { kind: "return", c: "sol", l: 7n, j: 0 };

test("two pages, TOPO 1: the frame holds the user's note ready; the sheet's funds count it and its withdraw sends once the frame's pass lets it go", async () => {
  const { wd, frame, top, onWait } = await twoDocs([30_000_000n], [undefined], [WORLD.NOW - 30_000n]);
  await frame.proofs();
  assert.equal((await wd.ns.get(wd.ids[0]!))?.state, "HELD", "the frame's ready proof");
  const funds = await top.withdrawDeps("solana", "op-w").funds();
  assert.equal(funds.notes.length, 1, "a HELD note not owed is the sheet's to spend");
  onWait(() => frame.proofs());
  await top.withdraw({ chain: "solana", to: WORLD.TO, amount: 5_000_000n, maxFee: WORLD.COST }, "op-w");
  assert.equal(wd.releases.length, 1, JSON.stringify(await wd.w.get("ops", "op-w")));
});

test("(review 4 P2) two pages, TOPO 1 with the frame's pass running when the keep-out is written: the one state read that write wakes asks one more pass after it, which lets the note go, and the run sends", async () => {
  const { wd, hold, frame, top, onWait } = await twoDocs([30_000_000n], [undefined], [WORLD.NOW - 30_000n]);
  await frame.proofs();
  assert.equal((await wd.ns.get(wd.ids[0]!))?.state, "HELD", "the frame's ready proof");
  // the frame's state read's pass, past its skip read, held at its time read
  hold.on();
  void frame.stateRead();
  await new Promise((r) => setTimeout(r, 50));
  let waits = 0;
  onWait(async () => {
    waits++;
    // the keep-out write's one state read (its store change), while the pass still runs
    if (waits === 1) await Promise.race([frame.stateRead(), new Promise((r) => setTimeout(r, 50))]);
    // the running pass ends a few waits on, its own work done; no state read with it
    if (waits === 3) {
      hold.off();
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  try {
    await top.withdraw({ chain: "solana", to: WORLD.TO, amount: 5_000_000n, maxFee: WORLD.COST }, "op-w");
    assert.equal(wd.releases.length, 1, JSON.stringify(await wd.w.get("ops", "op-w")));
  } finally {
    hold.off();
  }
});

test("two pages, TOPO 2: a sell's return note, the frame's pass at the boundary: the record keeps the return note out and the sheet's run sends", async () => {
  const { wd, frame, top, onWait } = await twoDocs([30_000_000n, 30_000_000n], [undefined, RET], [WORLD.NOW - 30_000n, WORLD.NOW - 1n]);
  await frame.proofs();
  onWait(() => frame.proofs());
  await top.withdraw({ chain: "solana", to: WORLD.TO, amount: 2_000_000n + WORLD.MIN, maxFee: WORLD.COST }, "op-w");
  assert.equal(wd.releases.length, 1, JSON.stringify(await wd.w.get("ops", "op-w")));
});

test("two pages, TOPO 2 with the device's clock a day ahead of the pool's: the record stands on the device's clock, so the frame still lets the return note go and the run sends", async () => {
  const realNow = Date.now;
  const t0 = realNow();
  Date.now = () => Number(WORLD.NOW) + 86_400_000 + (realNow() - t0);
  try {
    const { wd, frame, top, onWait } = await twoDocs([30_000_000n, 30_000_000n], [undefined, RET], [WORLD.NOW - 30_000n, WORLD.NOW - 1n]);
    await frame.proofs();
    onWait(() => frame.proofs());
    await top.withdraw({ chain: "solana", to: WORLD.TO, amount: 2_000_000n + WORLD.MIN, maxFee: WORLD.COST }, "op-w");
    assert.equal(wd.releases.length, 1, JSON.stringify(await wd.w.get("ops", "op-w")));
  } finally {
    Date.now = realNow;
  }
});

test("two pages, TOPO 3: the frame's pass after the boundary holds the return note before the tap: the sheet's funds still count it and the run sends", async () => {
  const { wd, B, frame, top, onWait } = await twoDocs([30_000_000n, 30_000_000n], [undefined, RET], [WORLD.NOW - 30_000n, WORLD.NOW - 1n]);
  await frame.proofs();
  await wd.host.wait!(Number(B - WORLD.NOW));
  await frame.proofs();
  assert.deepEqual([(await wd.ns.get(wd.ids[0]!))?.state, (await wd.ns.get(wd.ids[1]!))?.state], ["HELD", "HELD"], "the frame holds both");
  assert.equal((await top.withdrawDeps("solana", "op-w").funds()).notes.length, 2);
  onWait(() => frame.proofs());
  await top.withdraw({ chain: "solana", to: WORLD.TO, amount: 2_000_000n + WORLD.MIN, maxFee: WORLD.COST }, "op-w");
  assert.equal(wd.releases.length, 1, JSON.stringify(await wd.w.get("ops", "op-w")));
});

test("the kept-out record's write reaches another page as a store change (its state read, and so its queue's pass), never as a seed move", async () => {
  const { WALLET_CHANNEL, walletSeedMoved } = await import("@blindfill/wallet/store");
  const { keepOutNotes, WITHDRAW_PLANNED_KEY } = await import("../src/pool-testnet.ts");
  const { frameState } = await import("../src/state.ts");
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  // the other page's listen and frame state, as main.ts makes them (src/main.ts: the channel, frameState(..., listen))
  const channel = new BroadcastChannel(WALLET_CHANNEL);
  const seen: unknown[] = [];
  let woke = 0;
  const fs = frameState(async () => null, (fn) => channel.addEventListener("message", (m) => (seen.push((m as MessageEvent).data), fn((m as MessageEvent).data))));
  fs.watch(() => void woke++);
  try {
    await keepOutNotes(w, "op-w", ["n1"], BigInt(Date.now()), 1_000n);
    for (let i = 0; i < 200 && woke === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const e = seen.find((x) => (x as { key?: string }).key === WITHDRAW_PLANNED_KEY) as { kind: string; stores: string[] } | undefined;
    assert.deepEqual(e && { kind: e.kind, stores: e.stores }, { kind: "changed", stores: ["meta"] });
    assert.ok(woke >= 1, "the page's watchers (its state read, which runs the queue's pass) are told");
    assert.equal(walletSeedMoved(e as never), false, "never a seed move");
  } finally {
    channel.close();
    w.close();
  }
});

// Card round-trip-costs-less (review of 20ba2481b, P16 and P17): the load's rent backs run on the state reads, never on
// a timer of their own: the first read runs them; a run that leaves a W to try again books the next past BACKS_FIRST_MS
// (the wait doubling); one that leaves none books none, however long; a full sell's new owed record (one with no pass
// yet, written through the sell host's owed list) runs them at the next read.
test("the rent backs run on the state reads: again after the wait while a W is left, never once none is, again at a full sell's new record", async () => {
  const { BACKS_FIRST_MS, BACKS_LOAD_MAX_MS, BACKS_MAX_MS } = await import("../src/pool-testnet.ts");
  const { SOLANA_RENT_SYSVAR } = await import("../../kit/src/trade/solana/pool-buy.ts");
  const { poolSellKind } = await import("../src/pool-sell.ts");
  const { w } = await wallet();
  // the providers down: the helper's finding read (the Rent sysvar first) counted, every read refused
  const finds: string[] = [];
  const down = async (): Promise<never> => {
    throw new Error("offline");
  };
  const helper = async (m: string, p: readonly unknown[]): Promise<never> => {
    const keys = p[0];
    if (m === "getMultipleAccounts" && Array.isArray(keys) && keys[0] === SOLANA_RENT_SYSVAR) finds.push(String(keys[1]));
    throw new Error("offline");
  };
  // each run: a request of the seed's lock, shared (nothing else here takes it: no note)
  const runs: Promise<unknown>[] = [];
  const locks = {
    request: ((name: string, opts: LockOptions, cb: LockGrantedCallback<unknown>) => {
      const r = navigator.locks.request(name, opts, cb);
      if (name === "ct-wallet/seed" && opts?.mode === "shared") runs.push(r);
      return r;
    }) as LockManager["request"],
    query: () => navigator.locks.query(),
  };
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    let mk: (() => Parameters<typeof poolSellKind>[0] extends () => infer H ? H : never) | undefined;
    const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { rpcs: [down, helper], prover: { vault: signalsProver(), stop: () => {} }, locks, tradeKinds: { sell: (f) => ((mk = f as typeof mk), poolSellKind(f)) } });
    const put = async (address: string, passes: number): Promise<void> => {
      const h = mk!() as { owed?: { put(r: unknown): Promise<void> }; end?: () => void };
      try {
        await h.owed!.put({ address, l: "1", j: 0, mints: [], passes });
      } finally {
        h.end?.();
      }
    };
    const read = async (): Promise<void> => {
      await t.stateRead();
      await Promise.all(runs);
    };
    const X = base58.encode(new Uint8Array(32).fill(7));
    await put(X, 1);
    await read();
    assert.deepEqual([runs.length, finds], [0, []], "the page just opened: no run before the load's drawn start (review P2-1)");
    now += BACKS_LOAD_MAX_MS;
    await read();
    assert.deepEqual([runs.length, finds], [1, [X]], "the first read past the load's start runs them; the providers down, W is left to try");
    await read();
    assert.equal(runs.length, 1, "before the wait: no run");
    now += BACKS_FIRST_MS;
    await read();
    assert.deepEqual([runs.length, finds.length], [2, 2], "past the wait: run again (P17)");
    // W's record gone: the next run leaves none
    await w.put("meta", "owed/rentback-sol", {});
    now += 2 * BACKS_FIRST_MS;
    await read();
    assert.equal(runs.length, 3);
    now += 10 * BACKS_MAX_MS;
    await read();
    assert.equal(runs.length, 3, "none left: no run, however long (P17)");
    // a full sell's new record: the next read runs them (P16)
    await put(X, 0);
    await read();
    assert.deepEqual([runs.length, finds.length], [4, 3], "a new owed record: run at the next read (P16)");
  } finally {
    Date.now = realNow;
  }
});

// review 3 of 972be65f (P2-C, RR7) through the page's own host: the sheet's EVM withdraw of a change note that landed
// this epoch, whose leaf the newest cut both RPCs agree on lags (card fresh-money-spendable-at-once: then the part waits
// on the pool's time, here across the next boundary, whose root holds it); the app's hidden frame (a second page on the same store) runs its Base proof
// queue's pass at that boundary. The run's keep-out record (meta owed/withdraw-sol, written through evmWithdrawRun's
// keepOut) keeps the frame's queue off the note, so the part binds; the record is gone once the run ends.
const evmTwoPages = async (heldFirst: boolean, midPass = false) => {
  // midPass: the frame's pass is running when the run writes its keep-out (held at its time read, past its skip read),
  // and the frame gets only the one state read that write wakes, at the run's first wait; the pass ends a few waits on
  let hang = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { w, ns } = await wallet();
  const { evmPoolScopeOf, EVM_EPOCH_MS, EVM_LIFE_MS, EVM_SEND_MARGIN_MS, EVM_LADDER } = await import("../../wallet/src/pool/evm.ts");
  const { WITHDRAW_PLANNED_KEY } = await import("../src/pool-testnet.ts");
  const pin = EVM_POOLS["base-sepolia"]!;
  const scope = evmPoolScopeOf(pin.pool, 84532n);
  const label = vaultLabelOf(keccak_256, scope, 1n);
  const ref: NoteRef = { kind: "change", l: label, j: 0 };
  const value = 10n ** 15n;
  const pre = noteSecrets(SEED64, ref).precommitment;
  const leaf = noteCommitment(value, label, pre);
  const n = await ns.add({ ref, scope, precommitment: pre, state: "UNSPENT", leaf: { value, label, commitment: leaf, leafIndex: 0n } });
  // the pool's time: an epoch's start and 1 s; the leaf landed this epoch and the newest cut lags it, so only the next
  // boundary's root holds it
  const E0 = 1_800_000_000_000n;
  let slept = 0n;
  let onWait: (() => Promise<unknown>) | null = null;
  const binds: { page: string; chunk: bigint }[] = [];
  const FEE = 10n ** 12n;
  const PROBE = (1n << 127n) - 1n;
  const poolOf = (page: string) => ({
    id: `evm:base-sepolia:${pin.pool.toLowerCase()}`, chain: "evm", scope, ladder: EVM_LADDER, epochMs: EVM_EPOCH_MS, lifeMs: EVM_LIFE_MS, sendMarginMs: EVM_SEND_MARGIN_MS,
    now: async () => {
      if (page === "frame" && hang) await gate;
      return E0 + 1_000n + slept;
    },
    trees: async (beforeMs: bigint, _s?: unknown, o?: { newest?: boolean }) => {
      const has = o?.newest !== true && beforeMs > E0 + 500n;
      const s = new VaultTree(has ? [leaf] : []), l = new VaultTree(has ? [label] : []);
      return { stateTree: s, labelTree: l, stateRoot: s.root ?? 0n, labelRoot: l.root ?? 0n };
    },
    bind: async (b: { chunk: bigint; wallet: { address: string }; deadlineMs: bigint }) => {
      if (b.chunk !== PROBE) binds.push({ page, chunk: b.chunk });
      // the sheet's part stops at its bind: nothing is signed or sent here
      if (page === "sheet" && b.chunk !== PROBE) throw new Error("the part reached its bind");
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|${b.deadlineMs}`);
      return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: FEE, request: { w: b.wallet.address } };
    },
  }) as unknown as Pool<unknown>;
  const q = (v: bigint) => "0x" + v.toString(16);
  const rpc = (k: string) => Object.assign(async (method: string, params: readonly unknown[] = []): Promise<unknown> => {
    if (method === "eth_blockNumber") return "0x100";
    if (method === "eth_getBlockByNumber") return { number: "0x100", hash: "0x" + "be".repeat(32), timestamp: q((E0 + 1_000n + slept) / 1000n), baseFeePerGas: q(10_000_000n) };
    if (method === "eth_getCode") return "0x";
    if (method === "eth_estimateGas") return q(21_000n);
    if (method === "eth_call") return (params[0] as { to: string }).to.toLowerCase() === "0x420000000000000000000000000000000000000f" ? "0x" + (900n).toString(16).padStart(64, "0") : "0x";
    if (method === "eth_getLogs") return [];
    throw new Error(`${k}: no ${method}`);
  }, { url: `https://${k}.invalid` });
  const offline = Object.assign(async () => Promise.reject(new Error("offline")), { url: "https://sol.invalid" });
  const mk = (page: string) => testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, {
    rpcs: [offline, offline], prover: { vault: signalsProver(), stop: () => {} }, hardwareConcurrency: 4,
    evmPin: (c) => (c === "base" ? pin : undefined), evmRpcs: (c) => (c === "base" ? [rpc(`${page}-a`), rpc(`${page}-b`)] : null),
    evmSync: () => ({ events: async () => Promise.reject(new Error("offline")) }),
    evmQueuePool: () => poolOf(page),
    now: () => E0 + 1_000n + slept,
    wait: async (ms: number) => {
      slept += BigInt(ms);
      await onWait?.();
    },
  });
  const frame = mk("frame");
  const sheet = mk("sheet");
  // the frame's pass before the boundary: the epoch's root lacks the leaf, so nothing is proved
  await frame.stateRead();
  assert.equal((await ns.get(n.id))?.state, "UNSPENT");
  if (heldFirst) {
    // past the boundary before the tap: the frame's pass proves the note and holds it (HELD) for its next buy
    slept += 60_000n;
    await frame.stateRead();
    for (let i = 0; i < 100 && (await ns.get(n.id))?.state !== "HELD"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await ns.get(n.id))?.state, "HELD", "the frame holds the note");
    binds.length = 0;
  }
  let atBoundary = 0;
  if (midPass) {
    hang = true;
    void frame.stateRead();
    await new Promise((r) => setTimeout(r, 50));
    let waits = 0;
    onWait = async () => {
      waits++;
      // the keep-out write's one state read (its store change), while the pass still runs
      if (waits === 1) await Promise.race([frame.stateRead(), new Promise((r) => setTimeout(r, 50))]);
      // the running pass ends 1.5 s in, its own work done; no state read with it
      if (waits === 3) {
        hang = false;
        release();
        await new Promise((r) => setTimeout(r, 50));
      }
    };
  } else
    // every wait of the sheet's run stands for one of the frame's state reads (which every store write wakes)
    onWait = async () => {
      if (slept >= 59_000n) atBoundary++;
      await frame.stateRead();
      // at the boundary: the frame's pass given 100 ms before the sheet goes on. It decides only which assertion catches
      // a missing keep-out (with it the frame's bind lands before the sheet's; without it the sheet may bind first and
      // the frame take the note after), never whether one does
      if (slept >= 59_000n) await new Promise((r) => setTimeout(r, 100));
    };
  await sheet.withdraw({ chain: "base", to: "0x1111111111111111111111111111111111111111", amount: 5n * 10n ** 14n, maxFee: 10n ** 15n }, "op-w");
  const planned = (await w.get("meta", WITHDRAW_PLANNED_KEY)) as Record<string, unknown> | undefined;
  const state = (await ns.get(n.id))?.state;
  const op = (await w.get("ops", "op-w")) as { stage?: string; cause?: string } | undefined;
  hang = false;
  release();
  await frame.signedOut();
  await sheet.signedOut();
  return { atBoundary, binds, planned, state, op };
};
test("(RR7, the page's host) an EVM withdraw keeps its change note out of another page's proof queue while it waits for the boundary; the part binds and the keep-out is cleared at the run's end", async () => {
  const { atBoundary, binds, planned, state } = await evmTwoPages(false);
  assert.ok(atBoundary > 0, "the frame's pass ran at the boundary");
  // the sheet's bind ends its run (a part that threw there): the keep-out is cleared then, and the frame's queue may take
  // the free note after it, as it should; never before
  const sheetAt = binds.findIndex((b) => b.page === "sheet");
  assert.ok(sheetAt >= 0, "the part got its note back and reached its bind");
  assert.deepEqual(binds.slice(0, sheetAt).filter((b) => b.page === "frame"), [], "the frame's queue never took the note while the run kept it out");
  assert.equal(binds.filter((b) => b.page === "sheet").length, 1, "one bind of the sheet's");
  assert.equal(planned?.["op-w"], undefined, "the keep-out cleared at the run's end (a part that threw)");
  assert.ok(state === "UNSPENT" || (state === "HELD" && binds.at(-1)?.page === "frame"), `nothing the run moved: ${state}`);
});
test("(the page's host) an EVM withdraw of a note another page's queue already holds: the sheet counts it, the frame lets it go at its next pass once the keep-out is written, and the part binds", async () => {
  const { binds, planned, state } = await evmTwoPages(true);
  assert.equal(binds.filter((b) => b.page === "sheet").length, 1, "the part waited for the frame to let go and reached its bind");
  assert.equal(planned?.["op-w"], undefined, "the keep-out cleared at the run's end");
  assert.equal(state, "UNSPENT");
});
test("(review 4 P2, the page's host) an EVM withdraw of a note another page's queue holds, that page's pass running when the keep-out is written: the state read it wakes asks one more pass after it, which lets the note go, and the part binds", async () => {
  const { binds, planned, state, op } = await evmTwoPages(true, true);
  assert.equal(binds.filter((b) => b.page === "sheet").length, 1, `the part got its note and reached its bind: ${JSON.stringify(op)}`);
  assert.equal(planned?.["op-w"], undefined, "the keep-out cleared at the run's end");
  assert.equal(state, "UNSPENT");
  assert.match(op?.cause ?? "", /^Error\b/, "the part's stop at its bind on the op's record");
});

test("a proof queue's opening loads the prover's withdraw circuit before the pass reads the pool's trees (card max-ready-seconds-after-a-load)", async () => {
  const { w, ns } = await wallet();
  const { pool, land } = fakePool();
  const order: string[] = [];
  const inner = signalsProver();
  const prover = { ...inner, load: async (c: string) => void order.push(`load ${c}`), prove: async (c: string, i: unknown) => (order.push("prove"), inner.prove(c as never, i as never)) } as typeof inner;
  const trees = pool.trees.bind(pool);
  const planted = { ...pool, trees: async (...a: Parameters<typeof pool.trees>) => (order.push("trees"), trees(...a)) };
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pool: planted, prover: { vault: prover, stop: () => {} }, hardwareConcurrency: 4, locks: null });
  await land(ns, await incoming(ns, null, 1));
  await t.proofs();
  assert.deepEqual(order.slice(0, 2), ["load withdraw", "trees"], order.join(", "));
  assert.ok(order.includes("prove"));
  await t.signedOut();
});
