// The page's wait for a chain's spend being prepared (card taps-wait-inside-the-page; src/pool-testnet.ts tapPrepare):
// a buy tapped right after a load, while the chain's first pass still proves its note, waits for that pass and then
// finds the proof ready; it joins the pass in flight, so the note is proved once, never a second spend beside it; with
// nothing being prepared it waits for nothing. At e1995d679 the page had no such wait (TestnetPool.prepared): the tap
// read the queue's empty ready list and was refused not_funded.
//   node --test test/tap-prepare-page.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { VAULT_FIELD_P, vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { testnetPool } = await import("../src/pool-testnet.ts");
const { EVM_EPOCH_MS, EVM_LADDER, EVM_LIFE_MS, EVM_SEND_MARGIN_MS, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
type EvmPoolPin = import("../../wallet/src/pool/evm.ts").EvmPoolPin;
type EvmRpc = import("../../wallet/src/pool/evm.ts").EvmRpc;

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN: EvmPoolPin = Object.freeze({ network: "base-sepolia", pool: "0x00000000000000000000000000000000000F0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
const SCOPE = evmPoolScopeOf(PIN.pool, 84532n);
const RUNG = EVM_LADDER.min;
const NOW = 1_800_000_000_000n + 1_000n;
const D0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const L0 = vaultLabelOf(keccak_256, SCOPE, 1n);
const P = (ref: NoteRef) => noteSecrets(SEED64, ref).precommitment;

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((f) => f()));
async function wallet(): Promise<{ w: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  return { w, ns };
}
const landed = (ns: NoteStore) => ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: RUNG, label: L0, commitment: noteCommitment(RUNG, L0, P(D0)), leafIndex: 0n } });
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
const unread = (): readonly EvmRpc[] => ["https://a.example", "https://b.example"].map((url) => Object.assign(async () => assert.fail("no RPC read"), { url }));
const page = (w: WalletStore) => ({ store: async () => w, seed64: async () => SEED64.slice() });
/** The test prover, each proof held until `open()`. */
function gatedProver() {
  const inner = signalsProver();
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return { prover: { ...inner, prove: async (c: Parameters<typeof inner.prove>[0], i: Parameters<typeof inner.prove>[1]) => (inner.log.push("asked"), await gate, inner.prove(c, i)) }, open, proves: () => inner.log.filter((x) => x === "asked").length };
}
const pool = (w: WalletStore, prover: ReturnType<typeof gatedProver>["prover"]) =>
  testnetPool(page(w), { prover: { vault: prover, stop: () => {} }, hardwareConcurrency: 4, evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: unread, evmSync: () => ({ events: async () => assert.fail("no sync read") }), evmQueuePool: () => fakeEvmPool() });
const tick = () => new Promise((r) => setTimeout(r, 10));
/** Whether `p` settles inside `turns` turns of the event loop with no timer let run past it: a wait that waits for
 * nothing ends there, and one 250 ms step (TAP_PREPARE_STEP_MS) does not. Counted in turns, never the machine's clock. */
async function settlesAtOnce(p: Promise<unknown>, turns = 500): Promise<boolean> {
  let done = false;
  void p.then(() => void (done = true));
  for (let i = 0; i < turns && !done; i++) await new Promise((r) => setImmediate(r));
  return done;
}

test("a tap right after a load waits for the first pass still proving its note, then the proof is ready; the note is proved once", async () => {
  const { w, ns } = await wallet();
  await landed(ns);
  const g = gatedProver();
  const t = pool(w, g.prover);
  // the load's state read starts the chain's first pass, whose proof is held
  void t.stateRead();
  for (let i = 0; i < 100 && g.proves() === 0; i++) await tick();
  assert.equal(g.proves(), 1);
  let done = false;
  const tap = t.prepared("base").then(() => void (done = true));
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(done, false, "the tap waits while the note's proof is made");
  assert.equal((await t.readyWith(async () => null)).ready?.length ?? 0, 0);
  g.open();
  await tap;
  const { ready } = await t.readyWith(async () => null);
  assert.equal(ready?.length, 1, "the proof the tap waited for is ready to take");
  assert.equal(g.proves(), 1, "the tap joined the pass in flight: no second proof of the note");
  // prepared now: a tap waits for nothing and asks no pass
  assert.equal(await settlesAtOnce(t.prepared("base")), true);
  assert.equal(g.proves(), 1);
  await t.signedOut();
});

test("a chain with no note to prove: the tap waits for nothing and starts no pass", async () => {
  const { w } = await wallet();
  const g = gatedProver();
  const t = pool(w, g.prover);
  assert.equal(await settlesAtOnce(t.prepared("base")), true);
  assert.equal(await settlesAtOnce(t.prepared("solana")), true);
  assert.equal(g.proves(), 0);
  await t.signedOut();
});

test("a tap before any state read opened the queue starts the chain's first pass itself and waits for it", async () => {
  const { w, ns } = await wallet();
  await landed(ns);
  const g = gatedProver();
  const t = pool(w, g.prover);
  let done = false;
  const tap = t.prepared("base").then(() => void (done = true));
  for (let i = 0; i < 100 && g.proves() === 0; i++) await tick();
  assert.equal(g.proves(), 1, "the tap's own wait started the first pass");
  assert.equal(done, false);
  g.open();
  await tap;
  assert.equal((await t.readyWith(async () => null)).ready?.length, 1);
  assert.equal(g.proves(), 1);
  await t.signedOut();
});
