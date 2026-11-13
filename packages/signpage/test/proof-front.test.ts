// The device's one proving tab (card robinhood-note-spendable; src/proof-front.ts, src/pool-testnet.ts): a note one tab
// proved is never stuck HELD out of the tab in use. The owner's case of 13 Nov 21:26Z: a Robinhood return note of
// 0.001880137434291065 ETH (leaf 2 of pool 0x9306…66db, sale tx 0x6de337ed…) read in the balance as $3.63 with Max $0,
// since another tab of the page had proved it and kept it HELD.
//   node --test test/proof-front.test.ts      (from packages/signpage)
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
import { PROOF_FRONT_LOCK, proofFront } from "../src/proof-front.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { testnetPool } = await import("../src/pool-testnet.ts");
const { EVM_EPOCH_MS, EVM_LADDER, EVM_LIFE_MS, EVM_SEND_MARGIN_MS, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
type EvmPoolPin = import("../../wallet/src/pool/evm.ts").EvmPoolPin;
type EvmRpc = import("../../wallet/src/pool/evm.ts").EvmRpc;

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const NOW = 1_800_000_000_000n + 1_000n;
const P = (ref: NoteRef) => noteSecrets(SEED64, ref).precommitment;

// ------------------------------------------------------------------ Web Locks and a document, as two tabs see them

/** One origin's Web Locks: a holder per name; `steal` takes it (the holder's request rejects with an AbortError),
 *  `ifAvailable` gets null while it is held. The only two ways the front asks. */
function originLocks() {
  const held = new Map<string, { stolen: (e: unknown) => void }>();
  const locks = {
    async request(name: string, opts: LockOptions, cb: (lock: Lock | null) => unknown): Promise<unknown> {
      if (held.has(name) && opts.ifAvailable) return cb(null);
      assert.ok(opts.steal || opts.ifAvailable, "the front asks with steal or ifAvailable only");
      return new Promise((resolve, reject) => {
        held.get(name)?.stolen(new DOMException("stolen", "AbortError"));
        const me = { stolen: reject };
        held.set(name, me);
        Promise.resolve(cb({ name, mode: "exclusive" } as Lock)).then(
          (v) => (held.get(name) === me && held.delete(name), resolve(v)),
          (e) => (held.get(name) === me && held.delete(name), reject(e)),
        );
      });
    },
  } as unknown as Pick<LockManager, "request">;
  return { locks, holder: () => held.has(PROOF_FRONT_LOCK) };
}
/** A tab's document and window: shown or hidden, with or without focus, its events fired by hand. */
function tabDoc(shown = true, focus = true) {
  const on = new Map<string, (() => void)[]>();
  const add = (type: string, f: () => void) => on.set(type, [...(on.get(type) ?? []), f]);
  const d = {
    visibilityState: shown ? "visible" : "hidden",
    focus,
    hasFocus: () => d.focus,
    addEventListener: add,
    fire(type: string) {
      for (const f of on.get(type) ?? []) f();
    },
    hide() {
      d.visibilityState = "hidden";
      d.focus = false;
      d.fire("visibilitychange");
    },
    show(focus = true) {
      d.visibilityState = "visible";
      d.focus = focus;
      d.fire("visibilitychange");
    },
  };
  return d;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("the front: a shown tab with focus takes it from any other; a shown tab without focus only when it is free; a hidden tab gives it back", async () => {
  const { locks, holder } = originLocks();
  const a = tabDoc(true, true), b = tabDoc(true, false);
  const A = proofFront(locks, a, a), B = proofFront(locks, b, b);
  const seen: string[] = [];
  A.onChange((h) => seen.push(`A ${h}`));
  B.onChange((h) => seen.push(`B ${h}`));
  await tick();
  assert.deepEqual([A.held(), B.held()], [true, false], "A shown with focus holds it; B shown without focus does not take it");
  B.want();
  await tick();
  assert.deepEqual([A.held(), B.held()], [true, false], "a read in B without focus never takes it from A");
  // the user moves to B: B takes it at its next read, A loses it
  a.focus = false;
  b.focus = true;
  B.want();
  await tick();
  assert.deepEqual([A.held(), B.held()], [false, true]);
  // B hidden: given back; A shown without focus takes it at its next read, now that it is free
  b.hide();
  await tick();
  assert.equal(B.held(), false);
  assert.equal(holder(), false, "a hidden tab holds no lock");
  A.want();
  await tick();
  assert.equal(A.held(), true);
  // A hidden then shown: given back at once, taken again on show
  a.hide();
  await tick();
  assert.equal(A.held(), false);
  a.show();
  await tick();
  assert.equal(A.held(), true);
  // left (pagehide): given back
  a.fire("pagehide");
  await tick();
  assert.equal(A.held(), false);
  // each change heard once, in order (the first, A's at its load, came before the watchers were added); a steal grants
  // the new tab before the old one's request ends
  assert.deepEqual(seen, ["B true", "A false", "B false", "A true", "A false", "A true", "A false"]);
});

test("the front: a shown tab that gains focus with no event on its window (focus moved into its frame) takes it at its next check", async () => {
  const { locks } = originLocks();
  const a = tabDoc(true, true), b = tabDoc(true, false);
  const checks: (() => void)[] = [];
  const A = proofFront(locks, a, a, () => {});
  const B = proofFront(locks, b, b, (f) => void checks.push(f));
  await tick();
  assert.deepEqual([A.held(), B.held()], [true, false]);
  checks.forEach((f) => f());
  await tick();
  assert.deepEqual([A.held(), B.held()], [true, false], "no focus: the check takes nothing");
  a.focus = false;
  b.focus = true;
  checks.forEach((f) => f());
  await tick();
  assert.deepEqual([A.held(), B.held()], [false, true]);
});

test("the front with no Web Locks or no document: the tab always holds it, as one tab did before", () => {
  assert.equal(proofFront(null, tabDoc()).held(), true);
  assert.equal(proofFront(originLocks().locks, null).held(), true);
});

// ------------------------------------------------------------------ the page: two tabs on one wallet store

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
const unread = (): readonly EvmRpc[] => ["https://a.example", "https://b.example"].map((url) => Object.assign(async () => assert.fail("no RPC read"), { url }));

for (const [chain, network, chainId] of [["robinhood", "robinhood-testnet", 46630n], ["base", "base-sepolia", 84532n]] as const) {
  test(`${chain}: a note one tab proved is spent from the tab in use: the other tab gives it back when hidden or when the tab in use takes the front, and that tab proves it`, async () => {
    const PIN: EvmPoolPin = Object.freeze({ network, pool: "0x00000000000000000000000000000000000F0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
    const SCOPE = evmPoolScopeOf(PIN.pool, chainId);
    // the owner's shape: a whole-note buy's change of 0 at leaf 1, the sale's return note of 0.00188 ETH at leaf 2
    const D0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
    const L0 = vaultLabelOf(keccak_256, SCOPE, 1n), L1 = vaultLabelOf(keccak_256, SCOPE, 2n);
    const C0: NoteRef = { kind: "change", l: L0, j: 0 };
    const R0: NoteRef = { kind: "return", c: "evm", l: L0, j: 0 };
    const V = 1_880_137_434_291_065n, TWO = 2n * EVM_LADDER.min;
    const { w, ns } = await wallet();
    const d = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: TWO, label: L0, commitment: noteCommitment(TWO, L0, P(D0)), leafIndex: 0n } });
    await ns.add({ ref: C0, scope: SCOPE, precommitment: P(C0), state: "UNSPENT", parent: d.id, leaf: { value: 0n, label: L0, commitment: noteCommitment(0n, L0, P(C0)), leafIndex: 1n } });
    const r = await ns.add({ ref: R0, scope: SCOPE, precommitment: P(R0), state: "UNSPENT", leaf: { value: V, label: L1, commitment: noteCommitment(V, L1, P(R0)), leafIndex: 2n } });
    const state = [noteCommitment(TWO, L0, P(D0)), noteCommitment(0n, L0, P(C0)), noteCommitment(V, L1, P(R0))], labels = [L0, L1];
    const pool = (): Pool<unknown> => ({
      id: `evm:${network}:${PIN.pool.toLowerCase()}`,
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
        return { context: BigInt("0x" + Buffer.from(keccak_256(bytes)).toString("hex")) % VAULT_FIELD_P, feeCap: 6n * 10n ** 13n, request: { w: b.wallet.address } };
      },
    });
    const { locks } = originLocks();
    const tab = (doc: ReturnType<typeof tabDoc>) => {
      const t = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { prover: { vault: signalsProver(), stop: () => {} }, hardwareConcurrency: 4, evmPin: (c) => (c === chain ? PIN : undefined), evmRpcs: unread, evmSync: () => ({ events: async () => assert.fail("no sync read with nothing RESERVED") }), evmQueuePool: () => pool(), front: proofFront(locks, doc, doc) });
      closers.push(() => void t.signedOut().catch(() => {}));
      return t;
    };
    const chunks = async (t: ReturnType<typeof tab>) => {
      for (let i = 0; i < 6; i++) {
        await t.stateRead();
        await tick();
      }
      return ((await t.readyWith(async () => null)).ready ?? []).filter((x) => x.noteId === r.id).map((x) => x.chunk);
    };
    // tab A, where the sale ran: shown with focus, it proves the return note's chunk, 0.001 ETH
    const a = tabDoc(true, true);
    const A = tab(a);
    assert.deepEqual(await chunks(A), [EVM_LADDER.min]);
    assert.equal((await ns.get(r.id))!.state, "HELD");
    // the owner opens the coin in tab B: shown, focus moves there from A (both shown, as two windows side by side)
    a.focus = false;
    const b = tabDoc(true, true);
    const B = tab(b);
    assert.deepEqual(await chunks(B), [EVM_LADDER.min], "the tab in use reads the note ready: its Max is the chunk");
    assert.deepEqual(await A.readyWith(async () => null).then((x) => (x.ready ?? []).length), 0, "the other tab lists no proof of it");
    // B hidden (the owner back in A): B gives the note back and A proves it again
    b.hide();
    a.focus = true;
    assert.deepEqual(await chunks(A), [EVM_LADDER.min]);
    assert.equal((await B.readyWith(async () => null)).ready, undefined, "a hidden tab runs no queue");
  });
}

test("solana: the queue opens only in the tab holding the front (it reads the seed only there)", async () => {
  const { w } = await wallet();
  const { locks } = originLocks();
  const a = tabDoc(true, true), b = tabDoc(true, false);
  let seedsA = 0, seedsB = 0;
  const page = (n: () => void) => ({ store: async () => w, seed64: async () => (n(), SEED64.slice()) });
  const A = testnetPool(page(() => seedsA++), { prover: { vault: signalsProver(), stop: () => {} }, evmPin: () => undefined, front: proofFront(locks, a, a) });
  const B = testnetPool(page(() => seedsB++), { prover: { vault: signalsProver(), stop: () => {} }, evmPin: () => undefined, front: proofFront(locks, b, b) });
  await tick();
  await A.proofs();
  await B.proofs();
  assert.ok(seedsA > 0, "the front's tab opens its Solana queue");
  assert.equal(seedsB, 0, "the other tab opens none");
  await A.signedOut().catch(() => {});
  await B.signedOut().catch(() => {});
});
