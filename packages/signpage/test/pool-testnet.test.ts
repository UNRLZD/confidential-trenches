// The testnet build's pool pins and providers (card signpage-pool-flow): with __SIGN_NETWORK__ "testnet", as
// scripts/build-app.mjs sets it for that build, SOL_POOLS pins the devnet pool of contracts/pool-solana's deployment
// record and the helper's devnet fee payer, the page asks two devnet RPCs for Solana and the testnet pins' two RPCs for
// Base Sepolia and Robinhood testnet, and a pool buy on the pinned devnet pool reaches the flow. Another chain (no EVM
// pool pinned), a page with no flow, or the mainnet tables are refused. Its own file: the network is read once, at
// import, so this process runs as the testnet build does (test/pool-network.test.ts runs the mainnet one).
import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { base58 } from "@scure/base";
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
const { TESTNET_RPCS, testnetPoolDeps, testnetPool, devnetRelayFee, helperPoolSend, POOL_SEND_TIMEOUT_MS } = await import("../src/pool-testnet.ts");
const { SIGNPAGE_TIMEOUT_MS } = await import("../../kit/src/signpage/client.ts");
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
  assert.deepEqual(urls("solana"), ["https://api.devnet.solana.com/", "https://solana-devnet.api.onfinality.io/public"]);
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
  assert.deepEqual(k["pool.buy"](buy("solana"), ctx), { error: "not_allowed" }, "no lookup table is pinned for the devnet pool: no read, refused");
  assert.deepEqual(k["pool.deposit"]({ chain: "base", amount: "0.01" }, ctx), { error: "not_allowed" });
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

test("the devnet pool's relay fee: GET /v1/pool/fee on the helper for the pool and the epoch; another status or an oversized answer is refused", async () => {
  // GET https://api.confidential.unrealized.trade/v1/pool/fee?cluster=devnet&pool=D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef, 3 Nov 21:07Z, its
  // shape (apps/helper/src/pool/fee.ts PoolFeeAnswer), here for the pinned pool
  const pool = solanaPoolOf(SOL_POOLS.devnet!.program).pool;
  const answer = { chain: "solana", cluster: "devnet", program: SOL_POOLS.devnet!.program, pool, fee_payer: FEE_PAYER, epoch_ms: 60000, epoch_start_ms: 1800000000000, fee: "1300000", step: "100000" };
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const fetchOf = (status: number, body: string) => (async (url: string | URL | Request, init?: RequestInit) => (asked.push({ url: String(url), init }), new Response(body, { status }))) as typeof fetch;
  assert.deepEqual(await devnetRelayFee(pool, 1_800_000_000_000n, undefined, fetchOf(200, JSON.stringify(answer))), answer);
  assert.equal(asked[0]!.url, `https://api.confidential.unrealized.trade/v1/pool/fee?cluster=devnet&pool=${pool}&epoch=1800000000000`);
  assert.equal(asked[0]!.init?.credentials, "omit");
  assert.equal(asked[0]!.init?.redirect, "error");
  await assert.rejects(devnetRelayFee(pool, 1_800_000_000_000n, undefined, fetchOf(404, `{"error":{"code":"not_found"}}`)), /HTTP 404/);
  await assert.rejects(devnetRelayFee(pool, 1_800_000_000_000n, undefined, fetchOf(200, JSON.stringify({ ...answer, pad: "x".repeat(1024) }))), /over 1024 B/);
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
  mock.timers.enable({ apis: ["setTimeout"] });
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
    mock.timers.reset();
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
