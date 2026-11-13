// The EVM pools' proof queues and RESERVED settle on the signing page (card signpage-evm-proof-queue; src/pool-testnet.ts):
// with a chain's EVM pin (planted here: the wallet's EVM_POOLS is filled by card evm-pool-pins), a state read opens the
// chain's proof queue once its notes are landed, its ready proofs reach readyWith beside the Solana pool's, its RESERVED
// notes are settled on the chain's sync, and sign out closes it. Without the pin nothing opens and nothing is read.
//   node --test test/pool-testnet-evm-queue.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { WALLET_SEED_LOCK, openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { VAULT_FIELD_P, vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { evmPoolVenues, evmReadProvidersOf } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolFee, evmPoolGas } from "../../kit/src/trade/evm/pool-fee.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, readReservedMarks, refKey, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import type { EvmPoolBuyHost } from "../src/pool-buy-evm.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { testnetPool, TESTNET_EVM_FEE_RPCS, MAINNET_EVM_FEE_RPCS, TESTNET_RPCS, evmEpochFee, evmPoolRelayFee } = await import("../src/pool-testnet.ts");
const { EVM_CHAIN_IDS, EVM_EPOCH_MS, EVM_LADDER, EVM_LIFE_MS, EVM_POOL_EVENTS, EVM_POOLS, EVM_SEND_MARGIN_MS, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
const { EVM_BUY_SIGNATURE } = await import("../src/evm-send.ts");
// loaded after the network is set (a static import would load the wallet's network module first, as mainnet)
const { EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
const { SOL_EPOCH_MS, SOL_LADDER, SOL_LIFE_MS, SOL_POOLS, SOL_SEND_MARGIN_MS, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
type EvmPoolPin = import("../../wallet/src/pool/evm.ts").EvmPoolPin;
type EvmPoolEvent = import("../../wallet/src/pool/evm.ts").EvmPoolEvent;
type EvmRpc = import("../../wallet/src/pool/evm.ts").EvmRpc;

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN: EvmPoolPin = Object.freeze({ network: "base-sepolia", pool: "0x00000000000000000000000000000000000F0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
const SCOPE = evmPoolScopeOf(PIN.pool, 84532n);
const RUNG = EVM_LADDER.min;
const NOW = 1_800_000_000_000n + 1_000n; // an epoch's start + 1 s, in the pool's time
const D0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const L0 = vaultLabelOf(keccak_256, SCOPE, 1n);
const C0: NoteRef = { kind: "change", l: L0, j: 0 };
const P = (ref: NoteRef) => noteSecrets(SEED64, ref).precommitment;

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
/** Deposit 0 of the EVM pool, landed at leaf 0 (UNSPENT), as the EVM deposit writes it. */
const landed = (ns: NoteStore) => ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: RUNG, label: L0, commitment: noteCommitment(RUNG, L0, P(D0)), leafIndex: 0n } });

/** A fake Base Sepolia pool whose trees hold deposit 0's leaf; its context hashes W and the deadline. */
function fakeEvmPool(): Pool<{ w: string }> {
  const state = [noteCommitment(RUNG, L0, P(D0))], labels = [L0];
  return {
    id: `evm:base-sepolia:${PIN.pool.toLowerCase()}`,
    chain: "evm",
    scope: SCOPE,
    ladder: EVM_LADDER,
    epochMs: EVM_EPOCH_MS,
    lifeMs: EVM_LIFE_MS,
    sendMarginMs: EVM_SEND_MARGIN_MS,
    now: async () => NOW,
    trees: async () => {
      const s = new VaultTree(state), l = new VaultTree(labels);
      return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
    },
    bind: async (b) => {
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|${b.deadlineMs}`);
      return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: 10n ** 12n, request: { w: b.wallet.address } };
    },
  };
}
/** Two RPCs of two providers that are never read (the queue's pool and the sync are planted). */
const unread = (): readonly EvmRpc[] => ["https://a.example", "https://b.example"].map((url) => Object.assign(async () => assert.fail("no RPC read"), { url }));
/** A pool event as the sync gives it. */
const ev = (block: bigint, e: Partial<EvmPoolEvent> & Pick<EvmPoolEvent, "kind" | "state" | "value">): EvmPoolEvent => ({ block, blockHash: `0x${"11".repeat(32)}`, logIndex: 0n, bytes: "", label: null, precommitment: null, nullifier: null, recipient: null, token: null, ...e });
const page = (w: WalletStore, signedIn = () => true) => ({ store: async () => w, seed64: async () => (signedIn() ? SEED64.slice() : Promise.reject(new Error("no seed is stored"))) });

test("each EVM chain's fee list is the kit's read list (evmReadProvidersOf), and the epoch fee rule is the kit's evmPoolFee", () => {
  const v = evmPoolVenues();
  assert.deepEqual(TESTNET_EVM_FEE_RPCS.base, evmReadProvidersOf(v["base-sepolia"]));
  assert.deepEqual(TESTNET_EVM_FEE_RPCS.robinhood, evmReadProvidersOf(v["robinhood-testnet"]));
  assert.deepEqual(MAINNET_EVM_FEE_RPCS.base, evmReadProvidersOf(v.base));
  assert.deepEqual(MAINNET_EVM_FEE_RPCS.robinhood, evmReadProvidersOf(v.robinhood));
  const at = { block: 9n, baseFeePerGas: 1_000_000n, depth: 5, chainFee: 7n * 10n ** 9n };
  assert.equal(evmEpochFee(at), evmPoolFee({ gas: evmPoolGas(5), gasPrice: 1_000_000n, chainFee: 7n * 10n ** 9n }));
});

test("the EVM relay fee asks the helper's GET /v1/pool/fee for the pool's lowercase address and the epoch", async () => {
  const asked: string[] = [];
  const answer = { chain: "evm", network: "base-sepolia", pool: PIN.pool.toLowerCase(), fee_recipient: PIN.feeRecipient, epoch_ms: 60_000, epoch_start_ms: 1_800_000_000_000, block: "0x9", fee: "1000000000000", step: "1000000000" };
  const f = (async (url: string) => (asked.push(url), new Response(JSON.stringify(answer), { status: 200 }))) as unknown as typeof fetch;
  assert.deepEqual(await evmPoolRelayFee(PIN.pool, 1_800_000_000_000n, undefined, f), answer);
  assert.deepEqual(asked, [`https://ct-api.unrealized.trade/v1/pool/fee?pool=${PIN.pool.toLowerCase()}&epoch=1800000000000`]);
});

test("with the chain's EVM pin, a state read opens its proof queue once a note is landed: its proof reaches readyWith under the EVM pool's id, and sign out frees it", async () => {
  const { w, ns } = await wallet();
  const prover = signalsProver();
  let signedIn = true;
  let syncs = 0;
  const t = testnetPool(page(w, () => signedIn), {
    prover: { vault: prover, stop: () => {} },
    hardwareConcurrency: 4,
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => (syncs++, assert.fail("no sync read with nothing RESERVED")) }),
    evmQueuePool: (c) => (assert.equal(c, "base"), fakeEvmPool()),
  });
  let heard = 0;
  t.watch(() => heard++);
  const proves = () => prover.log.filter((x) => x.startsWith("prove")).length;
  // no note of the pool: no queue, no ready list
  await t.stateRead();
  assert.equal((await t.readyWith(async () => null)).ready, undefined);
  assert.equal(proves(), 0);
  // a landed note: the state read opens the chain's queue, which proves it
  const n = await landed(ns);
  await t.stateRead();
  for (let i = 0; i < 50 && proves() === 0; i++) await new Promise((r) => setTimeout(r, 10));
  await t.stateRead(); // its pass waits for the one before
  const { ready, value, open } = await t.readyWith(async () => "notes");
  assert.equal(value, "notes");
  assert.deepEqual([...open], [`evm:base-sepolia:${PIN.pool.toLowerCase()}`], "only the Base queue is open: Solana's entry reads no ready");
  assert.equal(proves(), 1);
  assert.equal(ready?.length, 1);
  assert.equal(ready![0]!.poolId, `evm:base-sepolia:${PIN.pool.toLowerCase()}`);
  assert.equal(ready![0]!.wallet.chain, "evm");
  assert.equal(ready![0]!.chunk, RUNG);
  assert.equal((await ns.get(n.id))!.state, "HELD");
  assert.ok(heard >= 1, "the pass that made the proof is heard");
  assert.equal(syncs, 0);
  // sign out: the EVM queue closes, its note freed, and no queue is left
  signedIn = false;
  await t.signedOut();
  assert.equal((await ns.get(n.id))!.state, "UNSPENT");
  assert.equal((await t.readyWith(async () => null)).ready, undefined);
});

test("without the chain's EVM pin, a landed note of that pool opens no queue and reads nothing", async () => {
  const { w, ns } = await wallet();
  const prover = signalsProver();
  // no pin on either chain, whatever the wallet's EVM_POOLS holds
  const t = testnetPool(page(w), { prover: { vault: prover, stop: () => {} }, evmPin: () => undefined, evmRpcs: unread, evmQueuePool: () => assert.fail("no EVM queue without a pin") });
  await landed(ns);
  await t.stateRead();
  assert.equal((await t.readyWith(async () => null)).ready, undefined);
  assert.equal(prover.log.length, 0);
});

test("a state read settles the EVM pool's RESERVED notes on the chain's sync: held while its release can land, spent with its change once final, freed past the deadline", async () => {
  const deadlineMs = 1_800_000_210_000n;
  const reserve = async (ns: NoteStore) => {
    const n = await landed(ns);
    const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs, context: "5" });
    await ns.move(n.id, "HELD", "RESERVED", { attempt: held.attempt! });
    return n.id;
  };
  const deposit = ev(10n, { kind: "deposit", state: noteCommitment(RUNG, L0, P(D0)), label: L0, value: RUNG, precommitment: P(D0) });
  const release = ev(20n, { kind: "buy", state: noteCommitment(RUNG - 4n * 10n ** 14n, L0, P(C0)), value: 4n * 10n ** 14n, nullifier: noteSecrets(SEED64, D0).nullifierHash });
  const run = async (round: { fin: { number: bigint; timestamp: bigint }; events: EvmPoolEvent[] }) => {
    const { w, ns } = await wallet();
    const id = await reserve(ns);
    let reads = 0;
    const t = testnetPool(page(w), {
      prover: { vault: signalsProver(), stop: () => {} },
      evmPin: (c) => (c === "base" ? PIN : undefined),
      evmRpcs: unread,
      evmSync: () => ({ events: async () => (reads++, { ...round, anchor: { number: 40n, hash: "", timestamp: 0n, baseFeePerGas: null }, fin: { ...round.fin, hash: "", baseFeePerGas: null } }) }),
      evmQueuePool: () => fakeEvmPool(),
    });
    await t.stateRead();
    return { ns, id, reads, list: await ns.list() };
  };
  // the release in a block above the finalized anchor: held
  const tail = await run({ fin: { number: 15n, timestamp: 1_800_000_100n }, events: [deposit, release] });
  assert.equal(tail.reads, 1);
  assert.equal((await tail.ns.get(tail.id))!.state, "RESERVED");
  // final: SPENT, with its change note at the release's leaf
  const spent = await run({ fin: { number: 30n, timestamp: 1_800_000_300n }, events: [deposit, release] });
  assert.equal((await spent.ns.get(spent.id))!.state, "SPENT");
  const change = spent.list.find((n) => refKey(n.ref) === refKey(C0));
  assert.equal(change?.parent, spent.id);
  assert.equal(change?.leaf?.leafIndex, 1n);
  // no release, the final block's time past the deadline: freed
  const freed = await run({ fin: { number: 30n, timestamp: 1_800_000_211n }, events: [deposit] });
  assert.ok(["UNSPENT", "HELD"].includes((await freed.ns.get(freed.id))!.state), "freed, and proved again by a queue that is open");
  // no release, the final block's time at the deadline: held
  const at = await run({ fin: { number: 30n, timestamp: 1_800_000_210n }, events: [deposit] });
  assert.equal((await at.ns.get(at.id))!.state, "RESERVED");
});

// ---- review P2-1, P2-2, P2-3, P3-3: one settle per chain at a time, stopped at sign out, beside the Solana part ----

const DEADLINE_MS = 1_800_000_210_000n;
/** Deposit 0 landed and its proof taken: RESERVED with DEADLINE_MS. */
async function reserved(ns: NoteStore): Promise<string> {
  const n = await landed(ns);
  const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: held.attempt! });
  return n.id;
}
const DEPOSIT = ev(10n, { kind: "deposit", state: noteCommitment(RUNG, L0, P(D0)), label: L0, value: RUNG, precommitment: P(D0) });
/** A round past the deadline with no release: the note it settles is freed. */
const FREEING = { fin: { number: 30n, timestamp: 1_800_000_300n, hash: "", baseFeePerGas: null }, anchor: { number: 40n, hash: "", timestamp: 0n, baseFeePerGas: null }, events: [DEPOSIT] };
/** A sync whose rounds wait until `go()` (or their signal's abort): `started` counts the rounds begun. */
function slowSync() {
  let started = 0;
  const waiting: (() => void)[] = [];
  const events = (signal?: AbortSignal) => {
    started++;
    return new Promise<typeof FREEING>((resolve, reject) => {
      waiting.push(() => resolve(FREEING));
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  return { sync: { events }, started: () => started, go: () => waiting.splice(0).forEach((f) => f()) };
}
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(f(), "reached");
};

test("state reads during one slow settle round join it: one round per chain, however many reads, with or without a Solana pin", async () => {
  for (const pin of [null, undefined]) await joins(pin);
});
async function joins(pin: null | undefined): Promise<void> {
  const { w, ns } = await wallet();
  const id = await reserved(ns);
  const slow = slowSync();
  const t = testnetPool(page(w), { pin, prover: { vault: signalsProver(), stop: () => {} }, evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: unread, evmSync: () => slow.sync, evmQueuePool: () => fakeEvmPool() });
  const reads = [t.stateRead()];
  await until(() => slow.started() === 1);
  for (let i = 0; i < 5; i++) reads.push(t.stateRead());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(slow.started(), 1, "the reads join the round in flight");
  slow.go();
  await Promise.all(reads);
  assert.equal(slow.started(), 1);
  assert.ok(["UNSPENT", "HELD"].includes((await ns.get(id))!.state), "the one round freed it");
  // the round done, the next read starts the next one only if a note is still RESERVED: none is
  await t.stateRead();
  assert.equal(slow.started(), 1);
}

test("sign out stops a settle round in flight: the state read returns without waiting for it, and nothing is written after", async () => {
  const { w, ns } = await wallet();
  const id = await reserved(ns);
  const slow = slowSync();
  const t = testnetPool(page(w), { prover: { vault: signalsProver(), stop: () => {} }, evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: unread, evmSync: () => slow.sync, evmQueuePool: () => fakeEvmPool() });
  const read = t.stateRead();
  await until(() => slow.started() === 1);
  t.signingOut();
  // the round never answers (go() is not called): the read ends on the stop alone
  const ended = await Promise.race([read.then(() => "ended"), new Promise((r) => setTimeout(() => r("waiting"), 500))]);
  assert.equal(ended, "ended");
  // the round answers late: its pass is stopped, so nothing is written
  slow.go();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await ns.get(id))!.state, "RESERVED");
  assert.equal((await ns.list()).length, 1);
  // a pass waiting for the seed lock the sign out holds stops too, without waiting for the lock
  let release!: () => void;
  let held!: () => void;
  const signout = new Promise<void>((r) => (held = r));
  void navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => (held(), new Promise<void>((r) => (release = r))));
  await signout;
  const waiting = t.stateRead();
  await new Promise((r) => setTimeout(r, 30));
  t.signingOut();
  assert.equal(await Promise.race([waiting.then(() => "ended"), new Promise((r) => setTimeout(() => r("waiting"), 500))]), "ended");
  release();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(slow.started(), 1, "the stopped pass never read a round");
  // the next pass (signed in again) runs on a fresh stop
  const again = t.stateRead();
  await until(() => slow.started() === 2);
  slow.go();
  await again;
  assert.ok(["UNSPENT", "HELD"].includes((await ns.get(id))!.state));
});

/** A fake devnet Solana pool (the page's pinned program's scope) whose tree holds one landed note at leaf 0. */
function fakeSolPool(ns: NoteStore) {
  const scope = solanaPoolOf(SOL_POOLS.devnet!.program).scope;
  const ref: NoteRef = { kind: "deposit", s: scope, i: 0 };
  const label = vaultLabelOf(keccak_256, scope, 1n);
  const commitment = noteCommitment(10_000_000n, label, P(ref));
  const pool: Pool<{ w: string }> = {
    id: "test:devnet",
    chain: "sol",
    scope,
    ladder: SOL_LADDER,
    epochMs: SOL_EPOCH_MS,
    lifeMs: SOL_LIFE_MS,
    sendMarginMs: SOL_SEND_MARGIN_MS,
    now: async () => NOW,
    trees: async () => {
      const s = new VaultTree([commitment]), l = new VaultTree([label]);
      return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
    },
    bind: async (b) => {
      const bytes = new TextEncoder().encode(`${b.wallet.address}|${b.chunk}|${b.deadlineMs}`);
      return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: 1_000n, request: { w: b.wallet.address } };
    },
  };
  const land = () => ns.add({ ref, scope, precommitment: P(ref), state: "UNSPENT", leaf: { value: 10_000_000n, label, commitment, leafIndex: 0n } });
  return { pool, land };
}

test("the EVM part of a state read runs beside the Solana part: a Solana proof is made while an EVM settle round hangs, and readyWith's open names only the open queues", async () => {
  const { w, ns } = await wallet();
  await reserved(ns);
  const sol = fakeSolPool(ns);
  await sol.land();
  const slow = slowSync();
  const prover = signalsProver();
  const t = testnetPool(page(w), { pool: sol.pool, prover: { vault: prover, stop: () => {} }, hardwareConcurrency: 4, evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: unread, evmSync: () => slow.sync, evmQueuePool: () => fakeEvmPool() });
  void t.stateRead();
  await until(() => slow.started() === 1);
  // the EVM round hangs; the Solana queue opens and proves its note all the same
  await until(() => prover.log.some((x) => x.startsWith("prove")));
  for (let i = 0; i < 100 && (await t.readyWith(async () => null)).ready?.length !== 1; i++) await new Promise((r) => setTimeout(r, 10));
  const r = await t.readyWith(async () => null);
  assert.equal(r.ready?.length, 1);
  assert.equal(r.ready![0]!.poolId, "test:devnet");
  // only the Solana queue is open (the EVM chain's note is RESERVED, so its queue never opened): Base reads no ready
  assert.deepEqual([...r.open], ["test:devnet"]);
  assert.equal(slow.started(), 1);
  t.signingOut();
  await t.signedOut();
});

// Circle's testnet USDC on Base Sepolia, a public address (contracts/pool-evm/script/testnet-run.mjs)
const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

test("pool.buy on a chain with its EVM pin goes to the EVM buy on that chain's queue; a chain with none is refused not_allowed (card signpage-evm-pool-buy); its take and landed release mark the note in the store, read by another tab (card pool-buy-record-never-stays-sent)", async () => {
  const { w, ns } = await wallet();
  const prover = signalsProver();
  const hosts: { chain: string; network: string; ready: number }[] = [];
  const marked: { got?: { id: string; attempt: string; noteOf: unknown; none: unknown } } = {};
  const t = testnetPool(page(w), {
    prover: { vault: prover, stop: () => {} },
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    evmQueuePool: () => fakeEvmPool() as Pool<unknown>,
    tradeKinds: {
      evmBuy: (host) => (ask) => {
        const after = (async () => {
          const h = host();
          try {
            const ready = await h.ready();
            hosts.push({ chain: h.chain, network: h.pin.network, ready: ready.length });
            // card pool-buy-record-never-stays-sent: the take marks the proof's nullifier, the landed release its
            // withdrawn value and block, in the store; the note is found from the nullifier
            const r = ready[0]!;
            await h.take(r.noteId, r.attempt, 9n);
            h.landed!(r.noteId, r.attempt, 5n, 12n);
            marked.got = { id: r.noteId, attempt: r.attempt, noteOf: await h.noteOf!(9n), none: await h.noteOf!(8n) };
          } finally {
            // ended at the run's end, as poolBuyEvmKind ends its host (a host holds the list's hosts until then)
            h.end?.();
          }
        })();
        return { running: true, after, answer: () => ({ result: { stage: "sent", txs: [] } }) };
      },
    },
  });
  await landed(ns);
  await t.stateRead();
  // the state read starts the chain's queue pass without waiting for it: its proof made
  for (let i = 0; i < 200 && ((await t.readyWith(async () => null)).ready?.length ?? 0) === 0; i++) await new Promise((r) => setTimeout(r, 10));
  const ask = { kind: "pool.buy", chain: "base", token: SEPOLIA_USDC, amount: RUNG, slippageBps: 100, decimals: 18 } as const;
  const got = t.flow(ask, null as never);
  assert.ok("after" in got, "the base buy runs");
  await got.after;
  assert.deepEqual(hosts, [{ chain: "base", network: "base-sepolia", ready: 1 }], "on the chain's own queue: its landed note's proof");
  const { id, attempt, noteOf, none } = marked.got!;
  let mark = (await readReservedMarks(w)).get(id);
  for (let i = 0; i < 200 && mark?.withdrawn === undefined; i++) {
    await new Promise((r) => setTimeout(r, 10));
    mark = (await readReservedMarks(w)).get(id);
  }
  assert.deepEqual(mark, { attempt, nullifier: 9n, withdrawn: 5n, block: 12n }, "on the note's mark in the store");
  assert.deepEqual([noteOf, none], [{ noteId: id, attempt }, null], "the note found from its nullifier");
  // another tab on the same store counts the landed release too
  const t2 = testnetPool(page(w), { prover: { vault: signalsProver(), stop: () => {} }, evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: unread, evmSync: () => ({ events: async () => assert.fail("no sync read") }), evmQueuePool: () => fakeEvmPool() as Pool<unknown> });
  assert.deepEqual([...((await t2.readyWith(async () => null)).landed ?? [])], [[id, { attempt, withdrawn: 5n }]], "another tab's state view");
  await t2.signedOut();
  assert.deepEqual(t.flow({ ...ask, chain: "robinhood" }, null as never), { error: "not_allowed" });
  await t.signedOut();
});

test("pool.sell on a chain with its EVM pin goes to the EVM sell on that chain's pool, by the testnet rule; a chain with none is refused not_allowed (card signpage-evm-pool-sell)", async () => {
  const { w } = await wallet();
  const hosts: { chain: string; network: string; testnet: boolean }[] = [];
  const t = testnetPool(page(w), {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    evmQueuePool: () => fakeEvmPool() as Pool<unknown>,
    tradeKinds: {
      evmSell: (host) => () => {
        const h = host();
        hosts.push({ chain: h.chain, network: h.pin.network, testnet: h.testnet });
        h.end?.();
        return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [] } }) };
      },
    },
  });
  const ask = { kind: "pool.sell", chain: "base", token: SEPOLIA_USDC, amount: 10n ** 6n, slippageBps: 100, decimals: 6 } as const;
  const got = t.flow(ask, null as never);
  assert.ok("after" in got, "the base sell runs");
  assert.deepEqual(hosts, [{ chain: "base", network: "base-sepolia", testnet: true }]);
  assert.deepEqual(t.flow({ ...ask, chain: "robinhood" }, null as never), { error: "not_allowed" });
  await t.signedOut();
});

test("the EVM sell's host keeps the note store open past the tap while a part it handed on runs, and closes it once that ends (card signpage-evm-pool-sell review P2-1)", async () => {
  const { w } = await wallet();
  let release!: () => void;
  const steps: string[] = [];
  let done!: Promise<void>;
  const state = async (h: { notes(): Promise<{ list(): Promise<unknown> }> }) => (await h.notes()).list().then(() => "open", () => "closed");
  const t = testnetPool(page(w), {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    evmQueuePool: () => fakeEvmPool() as Pool<unknown>,
    tradeKinds: {
      evmSell: (host) => () => {
        const h = host();
        assert.equal(typeof h.keep, "function", "the page takes the parts a tap hands on");
        h.keep!(new Promise<void>((r) => (release = r)));
        h.end?.();
        done = (async () => {
          await new Promise((r) => setTimeout(r, 20));
          steps.push(`after the tap: ${await state(h)}`);
          release();
          await new Promise((r) => setTimeout(r, 20));
          steps.push(`after its part: ${await state(h)}`);
        })();
        return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [] } }) };
      },
    },
  });
  const got = t.flow({ kind: "pool.sell", chain: "base", token: SEPOLIA_USDC, amount: 10n ** 6n, slippageBps: 100, decimals: 6 } as const, null as never);
  assert.ok("after" in got);
  await done;
  assert.deepEqual(steps, ["after the tap: open", "after its part: closed"]);
  await t.signedOut();
});

test("the EVM buy's host on the testnet page: the testnet rule, one claim set for every tap, its settle the chain's RESERVED pass, and a queue that could not open is opened again on the next tap (review P3-8, t02-t04)", async () => {
  const { w, ns } = await wallet();
  let signedIn = false;
  let reads = 0;
  const made: EvmPoolBuyHost[] = [];
  const t = testnetPool(page(w, () => signedIn), {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => (reads++, FREEING) }),
    evmQueuePool: () => fakeEvmPool() as Pool<unknown>,
    tradeKinds: {
      evmBuy: (host) => () => {
        // the run ends at once: its host ended, as poolBuyEvmKind ends it (a host holds the list's hosts until then)
        const h = host();
        h.end?.();
        made.push(h);
        return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [] } }) };
      },
    },
  });
  const ask = { kind: "pool.buy", chain: "base", token: SEPOLIA_USDC, amount: RUNG, slippageBps: 100, decimals: 18 } as const;
  t.flow(ask, null as never);
  t.flow(ask, null as never);
  assert.equal(made.length, 2);
  const [a, b] = made as [EvmPoolBuyHost, EvmPoolBuyHost];
  assert.equal(a.testnet, true, "the testnet build checks the buy by the testnet rule");
  assert.ok(a.claimed instanceof Set && a.claimed === b.claimed, "two taps share one claim set");
  // signed out: the queue cannot open; the tap fails, and the next tap, signed in, opens it
  await assert.rejects(a.ready());
  signedIn = true;
  assert.deepEqual(await b.ready(), [], "opened again once the seed is there");
  // the settle runs the chain's RESERVED pass: a note past its deadline with no release is freed
  const id = await reserved(ns);
  a.settle();
  await until(() => reads > 0);
  for (let i = 0; i < 200 && (await ns.get(id))!.state === "RESERVED"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.notEqual((await ns.get(id))!.state, "RESERVED");
  await t.signedOut();
});

test("the EVM buy's host on the testnet page: a sign out reaches its run (the follows' signal at signedOut, the sign-out count at signingOut), and its writes never open the store (review P2-2, P3-5, t02)", async () => {
  const { w } = await wallet();
  let opens = 0;
  const made: EvmPoolBuyHost[] = [];
  const t = testnetPool({ ...page(w), store: async () => (opens++, w) }, {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => FREEING }),
    evmQueuePool: () => fakeEvmPool() as Pool<unknown>,
    tradeKinds: {
      evmBuy: (host) => () => {
        // the run ends at once: its host ended, as poolBuyEvmKind ends it (a host holds the list's hosts until then)
        const h = host();
        h.end?.();
        made.push(h);
        return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent", txs: [] } }) };
      },
    },
  });
  const ask = { kind: "pool.buy", chain: "base", token: SEPOLIA_USDC, amount: RUNG, slippageBps: 100, decimals: 18 } as const;
  t.flow(ask, null as never);
  const a = made[0]!;
  assert.deepEqual([a.signal?.aborted, a.stopped?.()], [false, false]);
  const before = opens;
  await assert.rejects(a.record("0x" + "11".repeat(20), { mint: SEPOLIA_USDC, decimals: 6, chain: "base", state: "pending", route: { venue: "uniswap-v3", adapter: "0x" + "22".repeat(20), path: { venue: "uniswap-v3", tokens: [], fees: [] } } } as never));
  assert.equal(opens, before, "a page with no open store: the write fails, the store is never opened for it");
  t.signingOut();
  assert.equal(a.stopped?.(), true, "this tab's sign out started: the run's busy wait ends");
  t.flow(ask, null as never);
  assert.equal(made[1]!.stopped?.(), false, "a tap after it counts from there");
  await t.signedOut();
  assert.equal(a.signal?.aborted, true, "signed out: the run's reads end");
});

test("a state read follows a buy whose tab ended before its end, from its pending record: past its deadline with no release on either RPC's safe block, removed (the pending end's dead-tab rule)", { timeout: 60_000 }, async () => {
  const { w } = await wallet();
  const W = "0x" + "4b".repeat(20);
  const deadlineMs = BigInt(Date.now()) - 60_000n;
  const buy = { nullifier: "123", from: "16", deadlineMs: deadlineMs.toString(), minOut: "1", value: RUNG.toString(), feeCap: "1", feeRecipient: PIN.feeRecipient.toLowerCase() };
  const pending = { mint: SEPOLIA_USDC, decimals: 6, chain: "base", state: "pending", route: { venue: "uniswap-v3", adapter: "0x" + "22".repeat(20), path: { venue: "uniswap-v3", tokens: [], fees: [] } }, buy };
  await w.update("meta", EVM_POSITION_COSTS_KEY, () => ({ [W]: pending }));
  const asked: string[] = [];
  // two pool RPCs whose newest and safe blocks are past the deadline, with no release of the nullifier
  const rpcs = (): readonly EvmRpc[] =>
    ["https://a.example", "https://b.example"].map((url) =>
      Object.assign(
        async (method: string, params: readonly unknown[]) => {
          asked.push(`${method} ${String(params[0] && typeof params[0] === "string" ? params[0] : "")}`);
          if (method === "eth_getBlockByNumber") return { number: "0x40", timestamp: "0x" + (BigInt(Date.now()) / 1000n).toString(16) };
          if (method === "eth_getLogs") return [];
          if (method === "eth_blockNumber") return "0x40";
          throw new Error(`no ${method}`);
        },
        { url },
      ),
    );
  const t = testnetPool({ ...page(w), held: async () => w }, {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: (c) => (c === "base" ? rpcs() : null),
    evmSync: () => ({ events: async () => FREEING }),
    evmQueuePool: () => fakeEvmPool() as Pool<unknown>,
  });
  await t.stateRead();
  for (let i = 0; i < 400 && ((await w.get("meta", EVM_POSITION_COSTS_KEY)) as Record<string, unknown>)[W] !== undefined; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await w.get("meta", EVM_POSITION_COSTS_KEY), {}, "never landed: removed, so the note can buy again");
  assert.ok(asked.includes("eth_getBlockByNumber safe"), "judged on the safe block");
  await t.signedOut();
});

test("the EVM buy's live check reads what the testnet page reads: its pairs, chain ids, pins, Bought topic and buy selector (scripts/live-checks/signpage-evm-pool-buy.mjs)", async () => {
  const lc = (await import(new URL("../../../scripts/live-checks/signpage-evm-pool-buy.mjs", import.meta.url).href)) as {
    RPCS: Record<string, readonly string[]>;
    CHAIN_IDS: Record<string, bigint>;
    PINS_OF: Record<string, string>;
    BOUGHT: string;
    BUY_SELECTOR: string;
  };
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  assert.deepEqual(lc.RPCS, { "base-sepolia": TESTNET_RPCS.base, "robinhood-testnet": TESTNET_RPCS.robinhood });
  assert.deepEqual(lc.CHAIN_IDS, { "base-sepolia": EVM_CHAIN_IDS["base-sepolia"], "robinhood-testnet": EVM_CHAIN_IDS["robinhood-testnet"] });
  assert.deepEqual(lc.PINS_OF, { "base-sepolia": EVM_POOLS["base-sepolia"]?.pool, "robinhood-testnet": EVM_POOLS["robinhood-testnet"]?.pool });
  assert.equal(lc.BOUGHT, "0x" + hex(keccak_256(new TextEncoder().encode(EVM_POOL_EVENTS.Bought))));
  assert.equal(lc.BUY_SELECTOR, "0x" + hex(keccak_256(new TextEncoder().encode(EVM_BUY_SIGNATURE)).subarray(0, 4)));
});

// ---- the turn pass (card evm-device-reads-need-no-old-state) ----
// A keyless operator keeps a block's state seconds to minutes, so the page reads each chain's period fee a few seconds
// past the turn, while the period's first block is fresh, and runs the queue's pass then, only for a chain with its
// queue open or its notes landed.
const { EVM_TURN_PASS_MS, EVM_TURN_SPREAD_MS } = await import("../src/pool-testnet.ts");
const { evmPool: walletEvmPool } = await import("../../wallet/src/pool/evm.ts");
const { freshWallet } = await import("../../wallet/src/derive/keys.ts");
/** The page's turn timers, by hand: each set timer's wait and its callback (which returns the pass). */
function turnTimers(o: { now: number; random?: () => number; hidden?: () => boolean }) {
  // `at`: the device's time the timer fires at
  const set: { ms: number; at: number; f: () => unknown; cleared: boolean }[] = [];
  let onShow: (() => unknown) | null = null;
  return {
    set,
    show: () => onShow?.(),
    evmTurn: {
      now: () => o.now,
      random: o.random ?? (() => 0),
      setTimeout: (f: () => unknown, ms: number) => (set.push({ ms, at: o.now + ms, f, cleared: false }), set.length - 1),
      clearTimeout: (t: unknown) => void (set[t as number]!.cleared = true),
      visibility: { hidden: o.hidden ?? (() => false), onShow: (f: () => unknown) => void (onShow = f) },
    },
  };
}
/** A Base Sepolia pool with an EVM_POOLS-shaped pin and an empty pool on a fake chain of 2 s blocks, block 100 the
 *  period's first, the head 101: every request it is asked, by method and params, in `asked`. */
function emptyChain(asked: string[]) {
  const T = 1_800_000_000 - 200; // block n's time T + 2n: block 100 at the period's start
  const head = 101;
  const h = (n: number) => `0x${(n + 1).toString(16).padStart(64, "0")}`;
  const blk = (n: number) => (n > head ? null : { number: `0x${n.toString(16)}`, hash: h(n), parentHash: h(n - 1), timestamp: `0x${(T + 2 * n).toString(16)}`, baseFeePerGas: "0x3b9aca00" });
  const mk = (url: string): EvmRpc =>
    Object.assign(async (method: string, params: readonly unknown[]) => {
      asked.push(`${url} ${method} ${JSON.stringify(params)}`);
      if (method === "eth_chainId") return "0x14a34";
      if (method === "eth_getBlockByNumber") return blk(params[0] === "latest" ? head : params[0] === "finalized" ? head - 10 : Number(BigInt(params[0] as string)));
      if (method === "eth_getBlockByHash") return blk(Number(BigInt(params[0] as string)) - 1);
      if (method === "eth_getLogs") return [];
      if (method === "eth_call") {
        const [{ to, data }] = params as [{ to: string; data: string }];
        if (to === "0x420000000000000000000000000000000000000f") return `0x${(data.startsWith("0xf1c7a58b") ? 7917 : 0).toString(16).padStart(64, "0")}`;
        if (data === "0x" + Buffer.from(keccak_256(new TextEncoder().encode("SCOPE()")).subarray(0, 4)).toString("hex")) return `0x${SCOPE.toString(16).padStart(64, "0")}`;
        return `0x${"0".repeat(64)}`;
      }
      throw new Error(`unexpected ${method}`);
    }, { url });
  return { pair: [mk("https://a.example"), mk("https://b.example")] as const, fees: [mk("https://c.example"), mk("https://d.example")] };
}

test("the turn pass: armed at a state read for turn + 3 s + this page's spread (0 to 2 s, drawn once), once a period, and only for a chain with its queue open or its notes landed", async () => {
  const { w, ns } = await wallet();
  const START = 1_800_000_000_000; // a period's start
  const o = { now: START + 20_000, random: () => 0.25 };
  const tt = turnTimers(o);
  let pools = 0;
  const holds: bigint[] = [];
  let binds = 0;
  const pool = () => {
    pools++;
    const p = fakeEvmPool();
    return Object.assign(p, { now: async () => BigInt(o.now), holdFee: async (e: bigint) => void holds.push(e), bind: async (b: Parameters<typeof p.bind>[0]) => (binds++, fakeEvmPool().bind(b)) }) as Pool<unknown>;
  };
  const t = testnetPool(page(w), { prover: { vault: signalsProver(), stop: () => {} }, evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: unread, evmSync: () => ({ events: async () => assert.fail("no sync read") }), evmQueuePool: pool, evmTurn: tt.evmTurn } as Parameters<typeof testnetPool>[1]);
  assert.equal(EVM_TURN_PASS_MS, 3_000);
  assert.equal(EVM_TURN_SPREAD_MS, 2_000);
  await t.stateRead();
  await t.stateRead();
  assert.equal(tt.set.length, 1, "one timer however many state reads");
  assert.equal(tt.set[0]!.ms, 60_000 - 20_000 + 3_000 + 500, "the next turn + 3 s + 0.25 x 2 s");
  // nothing on the chain: the turn reads nothing and opens no queue, and the next turn is armed
  o.now = START + 63_500;
  await tt.set[0]!.f();
  assert.deepEqual([pools, holds.length], [0, 0]);
  assert.equal(tt.set.length, 2);
  // a landed note: the fee held first, then the queue's pass, which binds
  await landed(ns);
  o.now = START + 123_500;
  await tt.set[1]!.f();
  for (let i = 0; i < 50 && binds === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(pools, 1);
  assert.deepEqual(holds, [BigInt(START + 120_000)]);
  assert.ok(binds >= 1, "the queue's pass ran");
  // the spread is drawn once a page load: the next turn waits the same 500 ms past turn + 3 s
  assert.equal(tt.set[2]!.ms, 60_000);
  // once a period: the same timer again, or one 1 ms early, runs nothing; the next period's runs
  await tt.set[1]!.f();
  o.now = START + 179_999;
  await tt.set[2]!.f();
  assert.equal(holds.length, 1, "one pass a period");
  o.now = START + 183_500;
  await tt.set.at(-1)!.f();
  assert.deepEqual(holds, [BigInt(START + 120_000), BigInt(START + 180_000)]);
  // sign out (this tab's): the armed turn is cleared and none is armed after it
  const armed = tt.set.length;
  t.signingOut();
  assert.ok(tt.set[armed - 1]!.cleared, "cleared at signingOut");
  await t.signedOut();
  assert.equal(tt.set.length, armed);
});

test("the turn pass: a device clock minutes off holds the pool's period and arms the next turn on the pool's time", async () => {
  const { w, ns } = await wallet();
  const CHAIN = 1_800_000_020_000; // the pool's time: 20 s into a period
  const o = { now: CHAIN - 205_000 }; // the device 3 min 25 s behind: 55 s into its own period
  const tt = turnTimers(o);
  const holds: bigint[] = [];
  const t = testnetPool(page(w), { prover: { vault: signalsProver(), stop: () => {} }, evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: unread, evmSync: () => ({ events: async () => assert.fail("no sync read") }), evmQueuePool: () => Object.assign(fakeEvmPool(), { now: async () => BigInt(o.now + 205_000), holdFee: async (e: bigint) => void holds.push(e) }) as Pool<unknown>, evmTurn: tt.evmTurn } as Parameters<typeof testnetPool>[1]);
  await landed(ns);
  await t.stateRead();
  await tt.set[0]!.f();
  assert.deepEqual(holds, [1_800_000_000_000n], "the pool's period, whatever the device's clock");
  // armed again on the pool's time: 3 s past the pool's next turn
  assert.equal(o.now + 205_000 + tt.set.at(-1)!.ms, 1_800_000_060_000 + 3_000);
  assert.ok(tt.set[0]!.cleared === false && tt.set.length >= 2);
  await t.signedOut();
});

// delta review of 3e13d4e2, P3-2 and P3-3: a device clock ahead of the pool's: the pool's time read at the hold sets
// the timer's offset even when the fee read fails, and the period the pass ran for is the pool's, so the pool's next
// turn still runs (ahead 5 s and 20 s; loaded 30 s into the pool's period)
test("the turn pass with a device clock ahead: the pool's time read at the hold, even a failed one, sets the next turn and the period it ran for", async () => {
  const S = 1_800_000_000_000; // the pool's period start
  for (const ahead of [5_000, 20_000]) {
    for (const fails of [true, false]) {
      const { w, ns } = await wallet();
      const o = { now: S + 30_000 + ahead };
      const tt = turnTimers(o);
      const holds: bigint[] = [], binds: bigint[] = [];
      const t = testnetPool(page(w), {
        prover: { vault: signalsProver(), stop: () => {} },
        evmPin: (c) => (c === "base" ? PIN : undefined),
        evmRpcs: unread,
        evmSync: () => ({ events: async () => assert.fail("no sync read") }),
        evmQueuePool: () => {
          const p = fakeEvmPool();
          const own = p.bind.bind(p);
          return Object.assign(p, {
            now: async () => BigInt(o.now - ahead),
            holdFee: async (e: bigint) => {
              holds.push(e);
              if (fails) throw new Error("the chain fee at block 100: one operator alone never passes");
            },
            bind: async (b: Parameters<typeof p.bind>[0]) => (binds.push(b.epochStartMs), own(b)),
          }) as Pool<unknown>;
        },
        evmTurn: tt.evmTurn,
      } as Parameters<typeof testnetPool>[1]);
      await landed(ns);
      await t.stateRead();
      // the first timer, armed on the device's clock: it fires before the pool's next turn
      o.now = tt.set.at(-1)!.at;
      await tt.set.at(-1)!.f();
      const next = tt.set.filter((x) => !x.cleared).at(-1)!;
      assert.equal(next.at - ahead, S + 60_000 + 3_000, `ahead ${ahead}${fails ? ", the hold failing" : ""}: the next timer at the pool's turn + 3 s`);
      // the pool's turn: its pass holds the pool's period and binds it
      holds.length = 0;
      binds.length = 0;
      o.now = next.at;
      await next.f();
      for (let i = 0; i < 50 && !binds.includes(BigInt(S + 60_000)); i++) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(holds, [BigInt(S + 60_000)], `ahead ${ahead}${fails ? ", the hold failing" : ""}: the pool's turn held`);
      assert.ok(binds.includes(BigInt(S + 60_000)), `ahead ${ahead}: the pool's turn bound its period`);
      await t.signedOut();
    }
  }
});

test("the turn pass waits for a pass already running, and runs nothing after a sign out", async () => {
  const { w, ns } = await wallet();
  const o = { now: 1_800_000_010_000 };
  const tt = turnTimers(o);
  let trees = 0;
  let free: () => void = () => {};
  let gate = new Promise<void>((r) => (free = r));
  let holdGate: Promise<void> = Promise.resolve();
  const t = testnetPool(page(w), {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    evmQueuePool: () => {
      const p = fakeEvmPool();
      const own = p.trees.bind(p);
      return Object.assign(p, { now: async () => BigInt(o.now), holdFee: async () => holdGate, trees: async (...x: Parameters<typeof p.trees>) => (trees++, await gate, own(...x)) }) as Pool<unknown>;
    },
    evmTurn: tt.evmTurn,
  } as Parameters<typeof testnetPool>[1]);
  await landed(ns);
  void t.stateRead(); // its pass hangs in trees
  for (let i = 0; i < 50 && trees === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(trees, 1);
  o.now = 1_800_000_063_500;
  const turn = tt.set[0]!.f() as Promise<void>;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(trees, 1, "never beside the running pass");
  free();
  await turn;
  assert.equal(trees, 2, "its own pass once the running one ended");
  // a sign out while the turn's hold runs: no pass after it
  let release: () => void = () => {};
  holdGate = new Promise<void>((r) => (release = r));
  gate = Promise.resolve();
  o.now = 1_800_000_123_500;
  const late = tt.set.at(-1)!.f() as Promise<void>;
  await new Promise((r) => setTimeout(r, 20));
  t.signingOut();
  release();
  await late;
  assert.equal(trees, 2, "nothing run after the stop");
  await t.signedOut();
});

test("a sign out right after a turn fires or a state read begins stops it, and one while the turn waits on a running pass too", async () => {
  const { w, ns } = await wallet();
  const o = { now: 1_800_000_010_000 };
  const tt = turnTimers(o);
  let trees = 0, holds = 0;
  let free: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  const t = testnetPool(page(w), {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    evmQueuePool: () => {
      const p = fakeEvmPool();
      const own = p.trees.bind(p);
      return Object.assign(p, { now: async () => BigInt(o.now), holdFee: async () => void holds++, trees: async (...x: Parameters<typeof p.trees>) => (trees++, await gate, own(...x)) }) as Pool<unknown>;
    },
    evmTurn: tt.evmTurn,
  } as Parameters<typeof testnetPool>[1]);
  await t.stateRead(); // arms the turn; no note yet
  await landed(ns);
  // a state read, then this tab's sign out before its first read is in: its EVM pass never starts (review P3-a)
  const read = t.stateRead();
  t.signingOut();
  await read;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(trees, 0, "the state read's pass stopped");
  // the turn fires, then the sign out before its first read is in: no hold, no pass
  o.now = 1_800_000_063_500;
  await t.stateRead();
  await new Promise((r) => setTimeout(r, 30));
  const before = [holds, trees];
  o.now = 1_800_000_123_500;
  const turn = tt.set.at(-1)!.f() as Promise<void>;
  t.signingOut();
  await turn;
  assert.deepEqual([holds, trees], before, "the turn stopped before its reads");
  // a pass running (begun before the turn), the turn waiting on it, a sign out meanwhile: no pass after it ends
  await t.stateRead();
  gate = new Promise<void>((r) => (free = r));
  o.now = 1_800_000_183_500;
  const running = t.stateRead();
  for (let i = 0; i < 50 && trees === before[1]; i++) await new Promise((r) => setTimeout(r, 10));
  const busy = trees;
  const turn2 = tt.set.at(-1)!.f() as Promise<void>;
  await new Promise((r) => setTimeout(r, 30));
  t.signingOut();
  free();
  await Promise.all([turn2, running]);
  assert.equal(trees, busy, "nothing run after the stop");
  await t.signedOut();
});

test("the turn pass: a hidden tab reads nothing at the turn and runs it once when shown again", async () => {
  const { w, ns } = await wallet();
  let hidden = true;
  const tt = turnTimers({ now: 1_800_000_010_000, hidden: () => hidden });
  let holds = 0;
  const t = testnetPool(page(w), { prover: { vault: signalsProver(), stop: () => {} }, evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: unread, evmSync: () => ({ events: async () => assert.fail("no sync read") }), evmQueuePool: () => Object.assign(fakeEvmPool(), { holdFee: async () => void holds++ }) as Pool<unknown>, evmTurn: tt.evmTurn } as Parameters<typeof testnetPool>[1]);
  await landed(ns);
  await t.stateRead();
  const before = holds; // the state read's own pass holds nothing
  await tt.set[0]!.f();
  assert.equal(holds, before, "hidden: no read at the turn");
  hidden = false;
  await tt.show();
  assert.equal(holds, before + 1, "shown: once, at once");
  await tt.show();
  assert.equal(holds, before + 1, "shown again with no turn missed: nothing");
  await t.signedOut();
});

test("the turn pass's reads name nothing of the user: block headers, the pool's logs and public views at a block hash, on a real EVM pool", async () => {
  const { w, ns } = await wallet();
  const asked: string[] = [];
  const fetched: string[] = [];
  const c = emptyChain(asked);
  const tt = turnTimers({ now: 1_800_000_002_000 });
  const t = testnetPool(page(w), {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (x) => (x === "base" ? PIN : undefined),
    evmRpcs: () => [...c.pair],
    evmSync: () => ({ events: async () => assert.fail("no RESERVED note") }),
    evmQueuePool: () => walletEvmPool({ pin: PIN, rpcs: c.pair, feeRpcs: c.fees, relayFee: async () => assert.fail("no bind: the pool holds no leaf"), epochFee: evmEpochFee, sleep: async () => {} }) as Pool<unknown>,
    fetch: (async (u: string) => (fetched.push(String(u)), new Response("{}", { status: 404 }))) as unknown as typeof fetch,
    evmTurn: tt.evmTurn,
  } as Parameters<typeof testnetPool>[1]);
  const n = await landed(ns);
  await t.stateRead();
  asked.length = 0;
  await tt.set[0]!.f();
  const fee = asked.filter((x) => x.includes("0x420000000000000000000000000000000000000f"));
  assert.ok(fee.length >= 2 && fee.every((x) => x.includes(`0x${(101).toString(16).padStart(64, "0")}`)), "the chain fee at the period's first block (100), by its hash");
  const W = freshWallet(SEED64, "evm", L0, 0).address.toLowerCase().slice(2);
  const mine = [W, w64(n.leaf!.commitment), w64(P(D0)), w64(L0), w64(noteSecrets(SEED64, D0).nullifierHash)];
  for (const x of [...asked, ...fetched]) for (const m of mine) assert.ok(!x.toLowerCase().includes(m), `no user value in ${x.slice(0, 120)}`);
  assert.ok(asked.every((x) => / eth_(chainId|getBlockByNumber|getBlockByHash|getLogs|call) /.test(x)), "headers, logs and views only");
  await t.signedOut();
});
const w64 = (v: bigint) => v.toString(16).padStart(64, "0");

/** The pool on emptyChain's fake chain with deposit leaves: Deposited logs at their blocks, and the pool's views (its
 *  trees after every leaf, each root's block time) at any block, the chain's head 101, and a base fee of 0.1 gwei. */
function leafChain(asked: string[], deps: { block: number; leaf: bigint; label: bigint; pre: bigint }[]) {
  const c = emptyChain(asked);
  const T = 1_800_000_000 - 200;
  const h = (n: number) => `0x${(n + 1).toString(16).padStart(64, "0")}`;
  const sel = (s: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(s)).subarray(0, 4)).toString("hex");
  const topic = "0x" + Buffer.from(keccak_256(new TextEncoder().encode(EVM_POOL_EVENTS.Deposited))).toString("hex");
  const st = new VaultTree(), lt = new VaultTree();
  const times = new Map<bigint, number>(), ltimes = new Map<bigint, number>();
  for (const d of deps) (st.append([d.leaf]), lt.append([d.label]), times.set(st.root!, T + 2 * d.block), ltimes.set(lt.root!, T + 2 * d.block));
  const word = (v: bigint | number) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
  const views: Record<string, bigint> = { [sel("currentRoot()")]: st.root!, [sel("currentTreeSize()")]: BigInt(st.size), [sel("currentLabelRoot()")]: lt.root!, [sel("currentLabelTreeSize()")]: BigInt(lt.size) };
  const wrap = (r: EvmRpc): EvmRpc =>
    Object.assign(async (method: string, params: readonly unknown[]) => {
      if (method === "eth_getLogs") {
        asked.push(`${(r as { url?: string }).url} ${method} ${JSON.stringify(params)}`);
        const [{ fromBlock, toBlock }] = params as [{ fromBlock: string; toBlock: string }];
        return deps.flatMap((d, i) =>
          d.block < Number(BigInt(fromBlock)) || d.block > Number(BigInt(toBlock)) ? [] : [{ address: PIN.pool.toLowerCase(), topics: [topic, `0x${"d0d0".padStart(64, "0")}`], data: `0x${w64(d.leaf)}${w64(d.label)}${w64(RUNG)}${w64(d.pre)}`, blockNumber: `0x${d.block.toString(16)}`, blockHash: h(d.block), logIndex: "0x0", transactionHash: `0x${(0xabc0 + i).toString(16).padStart(64, "0")}`, transactionIndex: "0x0", removed: false }],
        );
      }
      if (method === "eth_call") {
        const [{ to, data }] = params as [{ to: string; data: string }];
        if (to.toLowerCase() === PIN.pool.toLowerCase()) {
          asked.push(`${(r as { url?: string }).url} ${method} ${JSON.stringify(params)}`);
          const s = data.slice(0, 10);
          if (views[s] !== undefined) return word(views[s]!);
          if (s === sel("stateRootTimes(uint256)")) return word(times.get(BigInt("0x" + data.slice(10))) ?? 0);
          if (s === sel("labelRootTimes(uint256)")) return word(ltimes.get(BigInt("0x" + data.slice(10))) ?? 0);
        }
      }
      const v = await r(method, params);
      // a base fee of 0.1 gwei: the period's fee under the pool's backstop for the ladder's least chunk
      return method.startsWith("eth_getBlockBy") && v !== null ? { ...(v as object), baseFeePerGas: "0x5f5e100" } : v;
    }, { url: (r as { url?: string }).url });
  return { pair: c.pair.map(wrap) as unknown as readonly [EvmRpc, EvmRpc], fees: c.fees.map(wrap) };
}

// review of 7fbf2af3, P3-e: on a pool with leaves, the turn's pass also binds, proves and asks the helper for the fee;
// every request still names nothing of the user, and the helper's carries only the pool and the period
test("the turn pass on a pool with leaves binds, proves and asks the helper, and its requests name nothing of the user", async () => {
  const { w, ns } = await wallet();
  const asked: string[] = [];
  const fetched: string[] = [];
  const mineLeaf = noteCommitment(RUNG, L0, P(D0));
  // two other deposits before this user's (leaf 2): no root the pass reads is this user's leaf alone
  const c = leafChain(asked, [
    { block: 90, leaf: 0x1111n, label: 0x2221n, pre: 0x3331n },
    { block: 92, leaf: 0x1112n, label: 0x2222n, pre: 0x3332n },
    { block: 95, leaf: mineLeaf, label: L0, pre: P(D0) },
  ]);
  const START = 1_800_000_000_000;
  const tt = turnTimers({ now: START + 2_000 });
  const helperAsked: string[] = [];
  const helper = (u: string) => {
    const q = new URL(u);
    const e = Number(q.searchParams.get("epoch"));
    const fee = evmPoolFee({ gas: evmPoolGas(2), gasPrice: 100_000_000n, chainFee: 7917n });
    return { chain: "evm", network: "base-sepolia", pool: PIN.pool.toLowerCase(), fee_recipient: PIN.feeRecipient, epoch_ms: 60_000, epoch_start_ms: e, block: "0x64", fee: fee.toString(), step: "0" };
  };
  // the page's one fetch: the helper's fee answer for /v1/pool/fee, nothing else answered
  const pageFetch = (async (u: string) => {
    if (new URL(String(u)).pathname === "/v1/pool/fee") return (helperAsked.push(String(u)), new Response(JSON.stringify(helper(String(u))), { status: 200 }));
    return (fetched.push(String(u)), new Response("{}", { status: 404 }));
  }) as unknown as typeof fetch;
  const t = testnetPool(page(w), {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (x) => (x === "base" ? PIN : undefined),
    evmRpcs: () => [...c.pair],
    evmSync: () => ({ events: async () => assert.fail("no RESERVED note") }),
    evmQueuePool: () => walletEvmPool({ pin: PIN, rpcs: c.pair, feeRpcs: c.fees, relayFee: (ep: bigint, s?: AbortSignal) => evmPoolRelayFee(PIN.pool, ep, s, pageFetch), epochFee: evmEpochFee, sleep: async () => {} }) as Pool<unknown>,
    fetch: pageFetch,
    evmTurn: tt.evmTurn,
  } as Parameters<typeof testnetPool>[1]);
  await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: RUNG, label: L0, commitment: mineLeaf, leafIndex: 2n } });
  await t.stateRead();
  await tt.set[0]!.f();
  for (let i = 0; i < 100 && !(await ns.list()).some((n) => n.state === "HELD"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok((await ns.list()).some((n) => n.state === "HELD"), "the pass bound and proved: the note is held for its proof");
  assert.ok(helperAsked.length >= 1, "the helper was asked for the period's fee");
  for (const u of helperAsked) {
    const q = new URL(u);
    assert.deepEqual([...q.searchParams.keys()].sort(), ["epoch", "pool"], `only the pool and the period: ${u}`);
    assert.equal(q.searchParams.get("pool"), PIN.pool.toLowerCase());
    assert.equal(Number(q.searchParams.get("epoch")) % 60_000, 0);
  }
  const W = freshWallet(SEED64, "evm", L0, 0).address.toLowerCase().slice(2);
  const mine = [W, w64(mineLeaf), w64(P(D0)), w64(L0), w64(noteSecrets(SEED64, D0).nullifierHash)];
  for (const x of [...asked, ...fetched, ...helperAsked]) for (const m of mine) assert.ok(!x.toLowerCase().includes(m.toLowerCase()), `no user value in ${x.slice(0, 160)}`);
  assert.ok(asked.every((x) => / eth_(chainId|getBlockByNumber|getBlockByHash|getLogs|call) /.test(x)), "headers, logs and views only");
  await t.signedOut();
});

// the ruling on review P3-d: a fresh load mid-period whose period's first block no two operators still hold (Robinhood
// at +55 s, 1 of 3 periods read 2026-11-10 23:20-23:29Z) has no proof until the next turn, and no error in between;
// the proof comes at the turn's pass, never later. (A page open in the period before keeps that period's proof
// takeable meanwhile, the queue's own rule, packages/wallet/src/pool/queue.ts:10-13: the next test.)
test("a fresh load has no proof until the turn: no error in between, then the turn's proof", async () => {
  const { EvmLagError } = await import("../../wallet/src/pool/evm.ts");
  const { w, ns } = await wallet();
  const START = 1_800_000_000_000;
  const o = { now: START + 30_000 }; // loaded 30 s into the period
  const tt = turnTimers(o);
  const binds: bigint[] = [];
  const t = testnetPool(page(w), {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    evmQueuePool: () => {
      const p = fakeEvmPool();
      const own = p.bind.bind(p);
      return Object.assign(p, {
        now: async () => BigInt(o.now),
        holdFee: async () => undefined,
        bind: async (b: Parameters<typeof p.bind>[0]) => {
          binds.push(b.epochStartMs);
          // the load's period: every operator but one dropped its first block's state
          if (b.epochStartMs === BigInt(START)) throw new EvmLagError(`the chain fee at block 100: one operator alone never passes`);
          return own(b);
        },
      }) as Pool<unknown>;
    },
    evmTurn: tt.evmTurn,
  } as Parameters<typeof testnetPool>[1]);
  await landed(ns);
  await t.stateRead(); // the load
  for (let i = 0; i < 50 && binds.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(binds, [BigInt(START)], "the load's pass tried its own period");
  // in between: the page answers with no proof and never an error
  const between = await t.readyWith(async () => "between");
  assert.equal(between.value, "between");
  assert.equal((between.ready ?? []).length, 0);
  await t.stateRead(); // a state read in between: still no proof, no throw
  assert.equal(tt.set.length, 1, "one turn armed");
  assert.equal(o.now + tt.set[0]!.ms, START + 60_000 + 3_000, "the next turn + 3 s, never later");
  // the turn: its pass binds the new period and the proof is ready
  o.now = START + 63_000;
  await tt.set[0]!.f();
  for (let i = 0; i < 50 && !binds.includes(BigInt(START + 60_000)); i++) await new Promise((r) => setTimeout(r, 10));
  const after = await t.readyWith(async () => null);
  assert.equal(after.ready?.length, 1, "the turn's proof");
  assert.equal(after.ready![0]!.epochStartMs, BigInt(START + 60_000));
  await t.signedOut();
});

// delta review of 3e13d4e2, P3-5: the state read's stop reaches its RESERVED notes' settle: a sign out right after the
// read begins starts no settle round
test("a sign out right after a state read begins starts no settle of its RESERVED notes", async () => {
  const { w, ns } = await wallet();
  await reserved(ns);
  const slow = slowSync();
  const t = testnetPool(page(w), { prover: { vault: signalsProver(), stop: () => {} }, evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: unread, evmSync: () => slow.sync, evmQueuePool: () => fakeEvmPool() });
  const read = t.stateRead();
  t.signingOut();
  await new Promise((r) => setTimeout(r, 50));
  const started = slow.started();
  slow.go();
  await read;
  assert.equal(started, 0, "no settle round after the sign out");
  await t.signedOut();
});

// delta review of 3e13d4e2, P3-4: the queue's own rule shown, not hidden: a page open in the period before made that
// period's proof; 30 s into the next, with no two operators keeping the new period's first block, that proof stays
// takeable (its note's remake waits), and the turn's pass replaces it with the new period's
test("a page open across the turn keeps the period before's proof takeable while the new period's fee is not read, then the turn replaces it", async () => {
  const { EvmLagError } = await import("../../wallet/src/pool/evm.ts");
  const { w, ns } = await wallet();
  const START = 1_800_000_000_000;
  const o = { now: START + 10_000 };
  const tt = turnTimers(o);
  const binds: bigint[] = [];
  const t = testnetPool(page(w), {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    evmQueuePool: () => {
      const p = fakeEvmPool();
      const own = p.bind.bind(p);
      return Object.assign(p, {
        now: async () => BigInt(o.now),
        holdFee: async () => undefined,
        bind: async (b: Parameters<typeof p.bind>[0]) => {
          binds.push(b.epochStartMs);
          if (b.epochStartMs === BigInt(START + 60_000)) throw new EvmLagError("the chain fee at block 130: one operator alone never passes");
          return own(b);
        },
      }) as Pool<unknown>;
    },
    evmTurn: tt.evmTurn,
  } as Parameters<typeof testnetPool>[1]);
  await landed(ns);
  await t.stateRead();
  await until(() => binds.includes(BigInt(START)));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await t.readyWith(async () => null)).ready?.[0]?.epochStartMs, BigInt(START), "the period's proof");
  // 30 s into the next period: the remake fails (no two operators keep block 130); the old proof stays takeable
  o.now = START + 90_000;
  await t.stateRead();
  await until(() => binds.includes(BigInt(START + 60_000)));
  await new Promise((r) => setTimeout(r, 30));
  const between = await t.readyWith(async () => null);
  assert.equal(between.ready?.length, 1);
  assert.equal(between.ready![0]!.epochStartMs, BigInt(START), "the period before's proof, by the queue's rule");
  // the turn: the new period's proof replaces it
  o.now = START + 123_000;
  await tt.set.filter((x) => !x.cleared).at(-1)!.f();
  await until(() => binds.includes(BigInt(START + 120_000)));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await t.readyWith(async () => null)).ready?.[0]?.epochStartMs, BigInt(START + 120_000));
  await t.signedOut();
});


// card sign-out-stops-the-pages-reads: another tab's sign out reaches this page as signedOut alone (main.ts, the store's
// "signout" event: no signingOut, which only this tab's Sign out calls). It stops the EVM reads this tab's sign out stops:
// the turn pass's hold, its reads on a real EVM pool over counting RPCs, holds one read open at the sign out; once that
// read answers, no call to the pool's or the fee list's RPCs starts.
test("card sign-out-stops-the-pages-reads: another tab's sign out (signedOut alone) stops the turn pass's hold in flight: no EVM RPC call starts after it", { timeout: 20_000 }, async () => {
  const { w, ns } = await wallet();
  const asked: string[] = [];
  const c = emptyChain(asked);
  // every call counted as it starts; the first newest-block read after `gated` is set waits for `free`
  const calls: string[] = [];
  let gated = false;
  let hit = false;
  let free!: () => void;
  const gate = new Promise<void>((r) => (free = r));
  const counted = (r: EvmRpc): EvmRpc =>
    Object.assign(async (method: string, params: readonly unknown[]) => {
      calls.push(`${r.url} ${method}`);
      if (gated && !hit && method === "eth_getBlockByNumber" && params[0] === "latest") {
        hit = true;
        await gate;
      }
      return r(method, params);
    }, { url: r.url });
  const pair = [counted(c.pair[0]), counted(c.pair[1])] as const;
  const fees = c.fees.map(counted);
  let signedIn = true;
  const o = { now: 1_800_000_010_000 };
  const tt = turnTimers(o);
  const t = testnetPool(page(w, () => signedIn), {
    prover: { vault: signalsProver(), stop: () => {} },
    evmPin: (x) => (x === "base" ? PIN : undefined),
    evmRpcs: () => [...pair],
    evmSync: () => ({ events: async () => assert.fail("no RESERVED note") }),
    evmQueuePool: () => walletEvmPool({ pin: PIN, rpcs: pair, feeRpcs: fees, relayFee: async () => assert.fail("no bind: the pool holds no leaf"), epochFee: evmEpochFee, sleep: async () => {} }) as Pool<unknown>,
    evmTurn: tt.evmTurn,
  } as Parameters<typeof testnetPool>[1]);
  // the turn armed with no note (no pass); a note lands; the turn's pass opens the queue and holds the period's fee
  await t.stateRead();
  await landed(ns);
  gated = true;
  o.now = 1_800_000_063_500;
  const turn = tt.set.at(-1)!.f() as Promise<void>;
  while (!hit) await new Promise((r) => setTimeout(r, 1));
  // another tab signed out: the seed is gone, and main.ts calls signedOut alone
  signedIn = false;
  await t.signedOut();
  const atSignOut = calls.length;
  free();
  await turn;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls.slice(atSignOut), [], "no EVM RPC call after another tab's sign out");
});
