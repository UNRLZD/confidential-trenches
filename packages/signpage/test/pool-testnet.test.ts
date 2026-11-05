// The testnet build's pool pins and providers (card signpage-pool-flow): with __SIGN_NETWORK__ "testnet", as
// scripts/build-app.mjs sets it for that build, SOL_POOLS pins the devnet pool of contracts/pool-solana's deployment
// record and the helper's devnet fee payer, the page asks two devnet RPCs for Solana and the testnet pins' two RPCs for
// Base Sepolia and Robinhood testnet, and a pool buy on the pinned devnet pool reaches the flow. Another chain (no EVM
// pool pinned), a page with no flow, or the mainnet tables are refused. Its own file: the network is read once, at
// import, so this process runs as the testnet build does (test/pool-network.test.ts runs the mainnet one).
import { after, mock, test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { VAULT_FIELD_P, vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { SOL_POOLS, solanaPoolOf, SOL_LADDER, SOL_EPOCH_MS, SOL_LIFE_MS, SOL_SEND_MARGIN_MS } = await import("../../wallet/src/pool/solana.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPoolDeps, testnetPool, poolRelayFee, helperPoolSend, POOL_SEND_TIMEOUT_MS, DEVNET_TABLE, settleFreedOps, oweSend, dropSend, keepRelease, mergeWithdrawOp } = await import("../src/pool-testnet.ts");
const { SIGNPAGE_TIMEOUT_MS } = await import("../../kit/src/signpage/client.ts");
// the withdraw tests' world, loaded once here so its stores close after the whole file (its after() is file-level)
const WORLD = await import("./pool-withdraw-world.ts");
type Ask = import("../src/rules/pool.ts").PoolAsk;

const RECORD = JSON.parse(readFileSync(new URL("../../../scripts/live-checks/pool-sol-deploy.devnet.json", import.meta.url), "utf8")) as { cluster: string; program_id: string; pool: string };
// GET https://api.confidential.unrealized.trade/v1/pool/fee?cluster=devnet&pool=D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef,
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
  assert.deepEqual(urls("solana"), ["https://api.devnet.solana.com/", "https://api.confidential.unrealized.trade/v1/rpc/solana-devnet"]);
  assert.deepEqual(urls("base"), ["https://sepolia.base.org/", "https://base-sepolia-rpc.publicnode.com/"]);
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
  // no EVM pool is pinned in the testnet build (EVM_POOLS is empty): Base Sepolia and Robinhood testnet are refused
  for (const chain of ["base", "robinhood"]) assert.deepEqual(k["pool.buy"](buy(chain), ctx), { error: "not_allowed" }, chain);
  assert.equal(asks.length, 1);
  // a testnet page with no flow
  assert.deepEqual(poolKinds(testnetPoolDeps())["pool.buy"](buy("solana"), ctx), { error: "not_allowed" });
  // the mainnet table: nothing pinned
  assert.deepEqual(poolKinds({ ...testnetPoolDeps(flow), pinned: (c) => c === "solana" && SOL_POOLS.mainnet !== undefined })["pool.buy"](buy("solana"), ctx), { error: "not_allowed" });
  assert.equal(asks.length, 1);
});

test("the testnet flow (card signpage-pool-notes): a Solana pool.deposit runs the deposit kind; every other op is refused", async () => {
  let opened = 0;
  // a store that fails to open: the run ends at once, with no RPC read
  const flow = testnetPool({ store: async () => (opened++, Promise.reject(new Error("no store"))), seed64: async () => new Uint8Array(64) }).flow;
  const k = poolKinds(testnetPoolDeps(flow));
  const d = k["pool.deposit"]({ chain: "solana", amount: "0.01" }, ctx) as { running?: true; after: Promise<unknown>; answer: () => unknown };
  assert.equal(d.running, true);
  await d.after;
  assert.deepEqual(d.answer(), { error: "failed" });
  assert.equal(opened, 1);
  assert.deepEqual(k["pool.deposit"]({ chain: "base", amount: "0.01" }, ctx), { error: "not_allowed" });
});

test("the testnet build pins the devnet pool's lookup table, so its pool.buy runs (card signpage-pool-flow-run)", async () => {
  // created by devnet tx 4K48NMp5…, read back the same on both devnet RPCs at finalized 4 Nov 09:30Z
  assert.equal(DEVNET_TABLE, "4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy");
  let opened = 0;
  const flow = testnetPool({ store: async () => (opened++, Promise.reject(new Error("no store"))), seed64: async () => new Uint8Array(64) }).flow;
  const r = poolKinds(testnetPoolDeps(flow))["pool.buy"](buy("solana"), ctx) as { running?: true; after: Promise<unknown>; answer: () => unknown };
  assert.equal(r.running, true, "the pinned table: the buy runs");
  await r.after;
  assert.deepEqual(r.answer(), { error: "failed" }, "a queue that cannot open: failed, nothing sent");
  assert.equal(opened, 1);
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

test("the devnet pool's relay fee: GET /v1/pool/fee on the helper for the pool and the epoch; another status or an oversized answer is refused", async () => {
  // GET https://api.confidential.unrealized.trade/v1/pool/fee?cluster=devnet&pool=D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef, 3 Nov 21:07Z, its
  // shape (apps/helper/src/pool/fee.ts PoolFeeAnswer), here for the pinned pool
  const pool = solanaPoolOf(SOL_POOLS.devnet!.program).pool;
  const answer = { chain: "solana", cluster: "devnet", program: SOL_POOLS.devnet!.program, pool, fee_payer: FEE_PAYER, epoch_ms: 60000, epoch_start_ms: 1800000000000, fee: "1300000", step: "100000" };
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const fetchOf = (status: number, body: string) => (async (url: string | URL | Request, init?: RequestInit) => (asked.push({ url: String(url), init }), new Response(body, { status }))) as typeof fetch;
  assert.deepEqual(await poolRelayFee(pool, 1_800_000_000_000n, undefined, fetchOf(200, JSON.stringify(answer))), answer);
  assert.equal(asked[0]!.url, `https://api.confidential.unrealized.trade/v1/pool/fee?cluster=devnet&pool=${pool}&epoch=1800000000000`);
  assert.equal(asked[0]!.init?.credentials, "omit");
  assert.equal(asked[0]!.init?.redirect, "error");
  await assert.rejects(poolRelayFee(pool, 1_800_000_000_000n, undefined, fetchOf(404, `{"error":{"code":"not_found"}}`)), /HTTP 404/);
  await assert.rejects(poolRelayFee(pool, 1_800_000_000_000n, undefined, fetchOf(200, JSON.stringify({ ...answer, pad: "x".repeat(1024) }))), /over 1024 B/);
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
  // a later read tries again
  await t.stateRead();
  assert.equal(calls.length, 4);
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
  const k = poolKinds(testnetPoolDeps(testnetPool(page, { table: base58.encode(new Uint8Array(32).fill(9)), rpcs: [offline("a"), offline("b")] }).flow));
  const r = k["pool.buy"](buy("solana"), ctx) as { running?: true; after: Promise<unknown>; answer: () => unknown };
  assert.equal(r.running, true, "the buy runs");
  await r.after;
  assert.deepEqual(r.answer(), { error: "failed" }, "a queue that cannot open: failed, nothing sent");
  assert.equal(opened, 1);
  assert.deepEqual(reads, [], "no proof ready: no read");
  const none = poolKinds(testnetPoolDeps(testnetPool(page, { table: null }).flow));
  assert.deepEqual(none["pool.buy"](buy("solana"), ctx), { error: "not_allowed" });
  assert.equal(opened, 1, "no table: no store opened, no read");
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
  const refused = (async () => new Response("{}", { status: 422 })) as unknown as typeof fetch;
  await assert.rejects(helperPoolSend("P", Uint8Array.of(1), refused), /HTTP 422/);
  const big = (async () => new Response(JSON.stringify({ signature: "x".repeat(5000) }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(helperPoolSend("P", Uint8Array.of(1), big), /over 4096 B/);
});

// ---- card signpage-pool-sell: pool.sell on the devnet pool ----

test("pool.sell on the devnet pool runs the sell kind: a page whose buys left no W holding the token answers not_funded with no read", async () => {
  const { w } = await wallet();
  const reads: string[] = [];
  const offline = (n: string) => Object.assign(async (m: string) => (reads.push(m), Promise.reject(new Error("offline"))), { url: `https://${n}.invalid` });
  const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { rpcs: [offline("a"), offline("b")] });
  const ask: Ask = { kind: "pool.sell", chain: "solana", token: SOL_TOKEN, amount: 1n, slippageBps: 100, decimals: 9 };
  const r = t.flow(ask, ctx as never) as { running?: true; after: Promise<unknown>; answer: () => unknown };
  assert.equal(r.running, true, "the sell runs");
  await r.after;
  assert.deepEqual(r.answer(), { error: "not_funded" });
  assert.deepEqual(reads, [], "no W: no read");
  assert.deepEqual(t.flow({ ...ask, chain: "base" }, ctx as never), { error: "not_allowed" });
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

test("pool.withdraw (card signpage-pool-withdraw-form): a checked Solana request opens the page's own screen with its id; no screen, or an EVM chain, is refused", async () => {
  const { w } = await wallet();
  const opened: [string, string][] = [];
  const answer = { result: { pending: true as const } };
  const with_ = testnetPool({ store: async () => w, seed64: async () => SEED64.slice(), openWithdraw: (chain, c) => (opened.push([chain, c.id]), answer) }, { prover: { vault: signalsProver(), stop: () => {} }, locks: null });
  const ask: Ask = { kind: "pool.withdraw", chain: "solana", token: null, amount: 0n, slippageBps: 0, decimals: 9 };
  assert.equal(with_.flow(ask, ctx), answer);
  assert.deepEqual(opened, [["solana", "r1"]]);
  assert.deepEqual(with_.flow({ ...ask, chain: "base", decimals: 18 }, ctx), { error: "not_allowed" });
  const refused = testnetPool({ store: async () => w, seed64: async () => SEED64.slice(), openWithdraw: () => null }, { prover: { vault: signalsProver(), stop: () => {} }, locks: null });
  assert.deepEqual(refused.flow(ask, ctx), { error: "not_allowed" });
  const none = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { prover: { vault: signalsProver(), stop: () => {} }, locks: null });
  assert.deepEqual(none.flow(ask, ctx), { error: "not_allowed" });
  // the screen's keys are the pin's own: none of them is a destination
  const keys = with_.withdrawDeps("solana", "r1").keys;
  assert.equal(keys.pool, solanaPoolOf(SOL_POOLS.devnet!.program).pool);
  assert.equal(keys.program, SOL_POOLS.devnet!.program);
  assert.equal(keys.feePayer, SOL_POOLS.devnet!.feePayer);
  assert.equal(with_.withdrawDeps("base", "r1").handoff, undefined, "no EVM flow on this page yet");
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
  const rpc = async () => {
    reads++;
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
  const t1 = testnetPool(page, over);
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
  await run;
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
