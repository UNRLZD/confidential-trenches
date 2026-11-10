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
import { evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolFee, evmPoolGas } from "../../kit/src/trade/evm/pool-fee.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, refKey, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { testnetPool, TESTNET_EVM_FEE_RPCS, MAINNET_EVM_FEE_RPCS, evmEpochFee, evmPoolRelayFee } = await import("../src/pool-testnet.ts");
const { EVM_EPOCH_MS, EVM_LADDER, EVM_LIFE_MS, EVM_SEND_MARGIN_MS, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
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

test("each EVM chain's fee pair is the kit's (evmPoolVenues feeProviders), and the epoch fee rule is the kit's evmPoolFee", () => {
  const v = evmPoolVenues();
  assert.deepEqual(TESTNET_EVM_FEE_RPCS.base, v["base-sepolia"].feeProviders);
  assert.deepEqual(TESTNET_EVM_FEE_RPCS.robinhood, v["robinhood-testnet"].feeProviders);
  assert.deepEqual(MAINNET_EVM_FEE_RPCS.base, v.base.feeProviders);
  assert.deepEqual(MAINNET_EVM_FEE_RPCS.robinhood, v.robinhood.feeProviders);
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
