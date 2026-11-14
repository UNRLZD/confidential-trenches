// The device's one proving tab (card robinhood-note-spendable; src/proof-front.ts, src/pool-testnet.ts): a note one tab
// proved is never stuck HELD out of the tab in use. The owner's case of 13 Nov 21:26Z: a Robinhood return note of
// 0.001880137434291065 ETH (leaf 2 of pool 0x9306…66db, sale tx 0x6de337ed…) read in the balance as $3.63 with Max $0,
// since another tab of the page had proved it and kept it HELD. And a tap is never refused by the front: a buy tapped in
// a tab without it takes it and waits for its queue's pass; a buy under way keeps its tab's queues to its take.
//   node --test test/proof-front.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
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
import { PROOF_FRONT_LOCK, PROOF_QUEUES_LOCK, proofFront } from "../src/proof-front.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { testnetPool } = await import("../src/pool-testnet.ts");
const { EVM_EPOCH_MS, EVM_LADDER, EVM_LIFE_MS, EVM_SEND_MARGIN_MS, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
type EvmPoolPin = import("../../wallet/src/pool/evm.ts").EvmPoolPin;
type EvmRpc = import("../../wallet/src/pool/evm.ts").EvmRpc;

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const NOW = 1_800_000_000_000n + 1_000n;
const P = (ref: NoteRef) => noteSecrets(SEED64, ref).precommitment;

// ------------------------------------------------------------------ Web Locks and a document, as two tabs see them

/** One origin's Web Locks: a holder per name and the asks waiting for it, in order. `steal` takes it at once (the
 *  holder's request rejects with an AbortError), `ifAvailable` gets null while it is held, a plain ask waits its turn
 *  (its `signal` ends the wait with an AbortError). */
function originLocks() {
  type Ask = { grant: () => void; drop: (e: unknown) => void };
  const held = new Map<string, { stolen: (e: unknown) => void }>();
  const waiting = new Map<string, Ask[]>();
  const next = (name: string) => {
    const w = waiting.get(name)?.shift();
    if (w) w.grant();
  };
  const locks = {
    request(name: string, opts: LockOptions, cb: (lock: Lock | null) => unknown): Promise<unknown> {
      if (held.has(name) && opts.ifAvailable) return Promise.resolve().then(() => cb(null));
      return new Promise((resolve, reject) => {
        const grant = () => {
          const me = { stolen: reject };
          held.set(name, me);
          Promise.resolve()
            .then(() => cb({ name, mode: "exclusive" } as Lock))
            .then(
              (v) => (held.get(name) === me && (held.delete(name), next(name)), resolve(v)),
              (e) => (held.get(name) === me && (held.delete(name), next(name)), reject(e)),
            );
        };
        if (opts.steal) {
          held.get(name)?.stolen(new DOMException("stolen", "AbortError"));
          return grant();
        }
        if (!held.has(name) && (waiting.get(name) ?? []).length === 0) return grant();
        const ask: Ask = { grant, drop: reject };
        waiting.set(name, [...(waiting.get(name) ?? []), ask]);
        opts.signal?.addEventListener("abort", () => {
          const list = waiting.get(name) ?? [];
          if (!list.includes(ask)) return;
          waiting.set(name, list.filter((x) => x !== ask));
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    },
  } as unknown as Pick<LockManager, "request">;
  return { locks, holder: () => held.has(PROOF_FRONT_LOCK) || held.has(PROOF_QUEUES_LOCK) };
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
  A.onChange((h) => void seen.push(`A ${h}`));
  B.onChange((h) => void seen.push(`B ${h}`));
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
  // each change heard once, in order (A's at its load once both locks are granted, after the watchers were added); at a
  // steal the old tab closes its queues before the new one holds them
  assert.deepEqual(seen, ["A true", "A false", "B true", "B false", "A true", "A false", "A true", "A false"]);
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

test("a tap takes the front whatever the focus; a loss while a tap runs (hidden, or stolen) closes nothing until its end", async () => {
  const { locks } = originLocks();
  const a = tabDoc(true, true), b = tabDoc(true, false);
  const A = proofFront(locks, a, a, () => {}), B = proofFront(locks, b, b, () => {});
  const seen: string[] = [];
  A.onChange((h) => void seen.push(`A ${h}`));
  B.onChange((h) => void seen.push(`B ${h}`));
  await tick();
  assert.deepEqual([A.held(), B.held()], [true, false]);
  // a tap in B, a window without focus: B takes it, once A closed its queues
  const endB = await B.tap();
  assert.deepEqual([A.held(), B.held()], [false, true]);
  assert.deepEqual(seen, ["A true", "A false", "B true"]);
  // B hidden while its tap runs: its queues stay open until the tap ends, then given back
  b.hide();
  await tick();
  assert.deepEqual(seen.slice(3), [], "no close while B's tap runs");
  endB();
  await tick();
  assert.deepEqual(seen.slice(3), ["B false"]);
  // a tap in A while A holds it: at once; A's focus moved to B (shown again): B steals the front, and waits for A's tap
  a.focus = true;
  A.want();
  await tick();
  const endA = await A.tap();
  a.focus = false;
  b.show(true);
  await tick();
  assert.deepEqual([A.held(), B.held()], [false, false], "B took the front lock; A's queues stay open for its tap");
  assert.ok(!seen.slice(5).includes("A false"), "A closed nothing yet");
  endA();
  await tick();
  assert.deepEqual([A.held(), B.held()], [false, true]);
  assert.deepEqual(seen.slice(-2), ["A false", "B true"]);
});

test("a tab that keeps the queues past QUEUES_WAIT_MS (frozen before its close ended) loses them to the tab that took the front", async () => {
  const { locks } = originLocks();
  const a = tabDoc(true, true), b = tabDoc(true, false);
  const timers: (() => void)[] = [];
  const A = proofFront(locks, a, a, () => {}, () => {});
  const B = proofFront(locks, b, b, () => {}, (f) => void timers.push(f));
  const seen: string[] = [];
  A.onChange((h) => void seen.push(`A ${h}`));
  await tick();
  await A.tap(); // never ended
  b.focus = true;
  a.focus = false;
  B.want();
  await tick();
  assert.deepEqual([A.held(), B.held()], [false, false], "B waits for the queues");
  timers.forEach((f) => f());
  await tick();
  assert.deepEqual([A.held(), B.held()], [false, true], "taken after the wait");
  assert.deepEqual(seen, ["A true", "A false"], "A closes at once once its queues are taken");
});

// card move-sends-or-says-why: a tap waited for the front with no bound (a queues lock never given back, a close that
// never ends), so a withdraw run, a Move's source release among them, never started and never ended. Past TAP_WAIT_MS
// (twice QUEUES_WAIT_MS) the tap rejects, its tap ended.
test("(card move-sends-or-says-why) a tap that gets no front within 60 s rejects, its tap ended", async () => {
  const { locks: real } = originLocks();
  // the queues lock is never granted, not even to a steal (the tab before it frozen in its close)
  const locks = { request: (name: string, opts: LockOptions, cb: (l: Lock | null) => unknown) => (name === PROOF_QUEUES_LOCK ? new Promise(() => {}) : real.request(name, opts, cb as never)) } as unknown as Pick<LockManager, "request">;
  const b = tabDoc(true, false);
  const timers: { f: () => void; ms: number }[] = [];
  const B = proofFront(locks, b, b, () => {}, (f, ms) => void timers.push({ f, ms }));
  const seen: boolean[] = [];
  B.onChange((h) => void seen.push(h));
  const out = B.tap().then(() => "held", (e: unknown) => String((e as Error).message));
  await tick();
  assert.equal(await Promise.race([out, Promise.resolve("pending")]), "pending", "waiting for the front");
  for (const t of timers.filter((x) => x.ms === 60_000)) t.f();
  await tick();
  assert.match(await Promise.race([out, Promise.resolve("pending")]), /not held in 60000 ms/);
  assert.equal(B.held(), false);
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

type EvmChain = "robinhood" | "base";
type BuyHost = { ready(): Promise<readonly { noteId: string; attempt: string; chunk: bigint }[]>; take(id: string, attempt: string): Promise<unknown>; end?(): void };
/** The owner's shape on one EVM pool, on one wallet store two tabs of the page share: the deposit SPENT by a whole-note
 *  buy, its change of 0 at leaf 1, the sale's return note of 0.00188 ETH at leaf 2. Each tab's buy host is caught as the
 *  page makes it at a pool.buy (the page's own ready, take and end around the kind's run). */
async function rig(chain: EvmChain, network: "robinhood-testnet" | "base-sepolia", chainId: bigint) {
  const PIN: EvmPoolPin = Object.freeze({ network, pool: "0x00000000000000000000000000000000000F0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
  const SCOPE = evmPoolScopeOf(PIN.pool, chainId);
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
    let made: (() => BuyHost) | null = null;
    const evmBuy = ((h: () => BuyHost) => ((made = h), () => ({ error: "not_allowed" }))) as never;
    const t = testnetPool(
      { store: async () => w, seed64: async () => SEED64.slice() },
      { prover: { vault: signalsProver(), stop: () => {} }, hardwareConcurrency: 4, evmPin: (c) => (c === chain ? PIN : undefined), evmRpcs: unread, evmSync: () => ({ events: async () => assert.fail("no sync read with nothing RESERVED") }), evmQueuePool: () => pool(), front: proofFront(locks, doc, doc), withdrawBuilt: { [chain]: true }, tradeKinds: { evmBuy } },
    );
    closers.push(() => void t.signedOut().catch(() => {}));
    /** A buy tapped in this tab: the host the page makes for its run. */
    const buy = (): BuyHost => {
      made = null;
      t.flow({ kind: "pool.buy", chain, token: "0x0000000000000000000000000000000000000001", amount: EVM_LADDER.min, slippageBps: 100, decimals: 18 } as never, { progress: () => {} } as never);
      assert.ok(made, "the page made the buy's host");
      return (made as () => BuyHost)();
    };
    return Object.assign(t, { buy });
  };
  const chunks = async (t: ReturnType<typeof tab>) => {
    for (let i = 0; i < 6; i++) {
      await t.stateRead();
      await tick();
    }
    return ((await t.readyWith(async () => null)).ready ?? []).filter((x) => x.noteId === r.id).map((x) => x.chunk);
  };
  return { ns, r, tab, chunks };
}

for (const [chain, network, chainId] of [["robinhood", "robinhood-testnet", 46630n], ["base", "base-sepolia", 84532n]] as const) {
  test(`${chain}: a note one tab proved is spent from the tab in use: the other tab gives it back when hidden or when the tab in use takes the front, and that tab proves it`, async () => {
    const { ns, r, tab, chunks } = await rig(chain, network, chainId);
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

  test(`${chain}: a buy tapped in a tab that does not hold the front takes it at the tap, waits for its queue to open and prove, and buys`, async () => {
    const { ns, r, tab, chunks } = await rig(chain, network, chainId);
    const a = tabDoc(true, true);
    const A = tab(a);
    assert.deepEqual(await chunks(A), [EVM_LADDER.min], "tab A proved the return note: HELD by A");
    // tab B shown beside it with no focus (a window side by side): its reads never take the front from A
    const b = tabDoc(true, false);
    const B = tab(b);
    await B.stateRead();
    await tick();
    assert.equal((await B.readyWith(async () => null)).ready, undefined, "B holds no queue before its tap");
    // the buy tapped in B: its first read of the ready proofs waits for the front, A's queues closed, B's opened and proved
    const h = B.buy();
    const ready = (await h.ready()).filter((x) => x.noteId === r.id);
    assert.deepEqual(ready.map((x) => x.chunk), [EVM_LADDER.min], "the tap reads the note's proof, never not_funded");
    await h.take(ready[0]!.noteId, ready[0]!.attempt);
    h.end?.();
    assert.equal((await ns.get(r.id))!.state, "RESERVED", "the buy took the note");
    assert.equal((await A.readyWith(async () => null)).ready, undefined, "the tab without the tap closed its queues");
  });

  test(`${chain}: a buy under way keeps its tab's queue: a window switch mid pick-to-take waits for the take, then the other tab proves`, async () => {
    const { ns, r, tab, chunks } = await rig(chain, network, chainId);
    const a = tabDoc(true, true);
    const A = tab(a);
    assert.deepEqual(await chunks(A), [EVM_LADDER.min]);
    // the buy tapped in A picks its proof
    const h = A.buy();
    const ready = (await h.ready()).filter((x) => x.noteId === r.id);
    assert.equal(ready.length, 1);
    // focus moves to tab B before A's take (the user switches windows while the buy signs)
    a.focus = false;
    const b = tabDoc(true, true);
    const B = tab(b);
    await B.stateRead();
    await tick();
    assert.equal((await B.readyWith(async () => null)).ready, undefined, "B waits: A's buy is under way");
    // A's take is not refused by the switch
    await h.take(ready[0]!.noteId, ready[0]!.attempt);
    assert.equal((await ns.get(r.id))!.state, "RESERVED", "A's take went through");
    h.end?.();
    // then A closes its queues and B holds them
    for (let i = 0; i < 4; i++) await tick();
    assert.equal((await A.readyWith(async () => null)).ready, undefined, "A gave the queues up after its take");
    assert.notEqual((await B.readyWith(async () => null)).ready, undefined, "B opened its queues");
  });
}

test("solana: a buy tapped in a tab that does not hold the front takes it at the tap and opens its queue there", async () => {
  const { w } = await wallet();
  const { locks } = originLocks();
  const a = tabDoc(true, true), b = tabDoc(true, false);
  let seedsB = 0;
  // a pool with no network: its pass fails at its first read of the pool's time, after the queue opened
  const offline = { id: "solana:offline", chain: "sol", scope: 1n, ladder: EVM_LADDER, epochMs: EVM_EPOCH_MS, lifeMs: EVM_LIFE_MS, sendMarginMs: EVM_SEND_MARGIN_MS, now: async () => assert.fail("offline"), trees: async () => assert.fail("offline"), bind: async () => assert.fail("offline") } as never;
  let made: (() => { ready(): Promise<readonly unknown[]>; end(): void }) | null = null;
  const buy = ((h: never) => ((made = h), () => ({ error: "not_allowed" }))) as never;
  const A = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { prover: { vault: signalsProver(), stop: () => {} }, evmPin: () => undefined, pool: offline, front: proofFront(locks, a, a, () => {}) });
  const B = testnetPool({ store: async () => w, seed64: async () => (seedsB++, SEED64.slice()) }, { prover: { vault: signalsProver(), stop: () => {} }, evmPin: () => undefined, pool: offline, front: proofFront(locks, b, b, () => {}), tradeKinds: { buy } });
  await tick();
  await B.proofs();
  assert.equal(seedsB, 0, "B opens no queue before its tap");
  const h = made!();
  await h.ready();
  assert.ok(seedsB > 0, "the tap opened B's queue");
  h.end();
  await A.signedOut().catch(() => {});
  await B.signedOut().catch(() => {});
});

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

// card move-sends-or-says-why: the page's state reads every open queue's ready list in one turn of each queue's view.
// A read that never answers held the views; every read after it waited for good, and with it the page's push queue.
// A queue whose open or view's turn does not come within the kit's state timeout (5 s) is left out of that read, the
// read answered; the stuck read lets the views go at 30 s (queue.ts READY_WITH_MS).
test("(card move-sends-or-says-why) robinhood: a state read after one that never answers leaves the held queue out at 5 s and answers; the views are let go at 30 s", async () => {
  const { r, tab, chunks } = await rig("robinhood", "robinhood-testnet", 46630n);
  const a = tabDoc(true, true);
  const A = tab(a);
  assert.deepEqual(await chunks(A), [EVM_LADDER.min]);
  const flushed = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await new Promise((res) => setImmediate(res));
  };
  enableTimers(mock.timers, { apis: ["setTimeout"] });
  try {
    const stuck = A.readyWith(() => new Promise<never>(() => {})).then(() => "answered", (e: unknown) => String((e as Error).message));
    const next = A.readyWith(async () => "v");
    await flushed();
    assert.equal(await Promise.race([next.then(() => "answered"), Promise.resolve("pending")]), "pending", "waits for the view first");
    // each open queue (Robinhood's, and Solana's when it opened) left out at 5 s of its own
    for (let i = 0; i < 2; i++) {
      mock.timers.tick(5_000);
      await flushed();
    }
    const got = await Promise.race([next, Promise.resolve(null)]);
    assert.ok(got !== null, "the read after it answers");
    assert.equal(got.value, "v");
    assert.equal(got.open.size, 0, "the held queues left out of it");
    mock.timers.tick(20_000);
    await flushed();
    assert.match(await Promise.race([stuck, Promise.resolve("pending")]), /no answer in 30000 ms/, "the stuck read let the views go at 30 s");
  } finally {
    resetTimers(mock.timers);
  }
  const ready = ((await A.readyWith(async () => null)).ready ?? []).filter((x) => x.noteId === r.id);
  assert.deepEqual(ready.map((x) => x.chunk), [EVM_LADDER.min], "the next read answers with the proof");
});
