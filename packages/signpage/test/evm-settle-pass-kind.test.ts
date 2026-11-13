// card evm-deposit-on-mainnet: the EVM settle's rounds are background reads (pass kind, on their hosts' budget), never a
// trade's. A Base mainnet-copy run of 13 Nov (04:04Z, lane logs): with a fresh deposit landed and not yet final, every
// state read ran a settle round whose reads took the trade kind, 18 of every 30 requests per 10 s on each pool host, and
// the proof queue's first pass (pass kind) waited for room: its last read came 84.8 s after the deposit. No trade waits
// on the settle (reserveEvm's callers do not await it, and the seed lock it takes is shared), so its reads wait their
// turn like the queue's. A state read during a running round joins it: two state reads in one round are one round's
// reads. Run as the testnet build on a fake provider that counts every request per host (as test/passes-yield.test.ts).
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { TESTNET_RPCS, testnetPool: makePool } = await import("../src/pool-testnet.ts");
const { EVM_LADDER, EVM_POOLS, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
const { hostLane, resetHostLanes, PASS_BUDGET } = await import("../../wallet/src/throttle.ts");
type EvmRpc = import("../../wallet/src/pool/evm.ts").EvmRpc;

const pages: { signingOut(): void }[] = [];
afterEach(() => pages.splice(0).forEach((p) => p.signingOut()));
const testnetPool = ((...a: Parameters<typeof makePool>) => {
  const t = makePool(...a);
  pages.push(t);
  return t;
}) as typeof makePool;
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN = EVM_POOLS["base-sepolia"]!;
const SCOPE = evmPoolScopeOf(PIN.pool, 84532n);
const RUNG = EVM_LADDER.min;
const D0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const L0 = vaultLabelOf(keccak_256, SCOPE, 1n);
const P0 = noteSecrets(SEED64, D0).precommitment;
const BASE = new Set(TESTNET_RPCS.base.map((u) => new URL(u).host));
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Every request to a Base pool host counted, answered 7 at once. */
async function onProvider(run: (sent: { host: string; method: string }[]) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const sent: { host: string; method: string }[] = [];
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const host = new URL(u instanceof Request ? u.url : String(u)).host;
    let q = { id: "0", method: "GET" };
    try {
      q = JSON.parse(String(init?.body)) as typeof q;
    } catch {}
    if (BASE.has(host)) sent.push({ host, method: q.method });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: 7 }), { status: 200 });
  }) as typeof fetch;
  resetHostLanes();
  try {
    await run(sent);
  } finally {
    globalThis.fetch = real;
    resetHostLanes();
  }
}

/** A wallet whose Base deposit 0 landed at leaf 0 in block 10, the finalized block at 5: a fresh landing, not yet final. */
async function freshLanding(): Promise<{ w: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  await ns.add({ ref: D0, scope: SCOPE, precommitment: P0, state: "UNSPENT", leaf: { value: RUNG, label: L0, commitment: noteCommitment(RUNG, L0, P0), leafIndex: 0n }, landed: { block: 10n, fin: 5n } });
  return { w, ns };
}
/** The chain as the round reads it: head 41, finalized 5, block 10 holding deposit 0's own leaf. */
const ROUND = {
  fin: { number: 5n, hash: "", timestamp: 1_800_000_000n, baseFeePerGas: null },
  anchor: { number: 41n, hash: "", timestamp: 1_800_000_001n, baseFeePerGas: null },
  events: [{ block: 10n, blockHash: `0x${"11".repeat(32)}`, logIndex: 0n, bytes: "", kind: "deposit" as const, state: noteCommitment(RUNG, L0, P0), label: L0, value: RUNG, precommitment: P0, nullifier: null, recipient: null, token: null }],
};
/** The page on `w`: each settle round reads `reads` times on each of its sync's two RPCs, after `gate`, then answers ROUND;
 *  the queue's pool reads nothing (its trees refused). */
function page(w: WalletStore, o: { reads: number; gate?: Promise<void>; rounds: { n: number } }) {
  return testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED64.slice() }, {
    prover: { vault: signalsProver(), stop: () => {} },
    hardwareConcurrency: 2,
    evmPin: (c: string) => (c === "base" ? PIN : undefined),
    evmSync: (_p: unknown, rpcs: readonly [EvmRpc, EvmRpc]) => ({
      events: async () => {
        await o.gate;
        o.rounds.n++;
        for (let i = 0; i < o.reads; i++) await Promise.all(rpcs.map((r) => r("eth_blockNumber", [])));
        return ROUND;
      },
    }),
    evmQueuePool: () => ({ trees: async () => Promise.reject(new Error("no trees here")) }) as never,
  } as never);
}

test("a fresh landing's settle round reads on the pass kind: with each Base pool host's window one short of the pass budget, the round sends one read per host and waits for room; a trade's reads would all have gone", async () => {
  await onProvider(async (sent) => {
    const { w } = await freshLanding();
    const rounds = { n: 0 };
    const t = page(w, { reads: 3, rounds });
    for (const u of TESTNET_RPCS.base) for (let i = 0; i < PASS_BUDGET - 1; i++) hostLane(u).sent("trade");
    const read = t.stateRead();
    await tick(400);
    const per = [...BASE].map((h) => sent.filter((x) => x.host === h && x.method === "eth_blockNumber").length);
    assert.equal(rounds.n, 1, "the round began");
    assert.ok(per.every((n) => n <= 1), `at most one settle read per host while its window is full: ${per.join(", ")}`);
    // room again: the round's reads go and the state read ends
    resetHostLanes();
    await read;
    for (let i = 0; i < 40 && sent.filter((x) => x.method === "eth_blockNumber").length < 6; i++) await tick(50);
    assert.equal(sent.filter((x) => x.method === "eth_blockNumber").length, 6, "the round's six reads all went once there was room");
  });
});

test("two state reads during one settle round are one round's reads: the second joins the running round", async () => {
  await onProvider(async (sent) => {
    const { w } = await freshLanding();
    const rounds = { n: 0 };
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const t = page(w, { reads: 1, gate, rounds });
    const a = t.stateRead();
    await tick(100);
    const b = t.stateRead();
    await tick(100);
    open();
    await Promise.all([a, b]);
    await tick(100);
    assert.equal(rounds.n, 1, "one round");
    assert.equal(sent.filter((x) => x.method === "eth_blockNumber").length, 2, "one read on each of the round's two RPCs");
  });
});
