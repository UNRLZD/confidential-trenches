// card evm-deposit-on-mainnet: the proof queue's pool reads its trees on the pool's pass sync, the settle's own
// (src/pool-testnet.ts openEvmQueue, `sync: e.passSync`), so the two keep one history and the queue's first pass reads only
// past the rounds the settle made. A pool built with a sync of its own would read the pool again from its hold. Run as
// the testnet build on a fake provider that answers every block read with one block (as test/evm-settle-pass-kind.test.ts).
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
const { testnetPool: makePool } = await import("../src/pool-testnet.ts");
const { EVM_LADDER, EVM_POOLS, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
const { resetHostLanes } = await import("../../wallet/src/throttle.ts");
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
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const BLOCK = { number: "0x29", hash: `0x${"29".repeat(32)}`, parentHash: `0x${"28".repeat(32)}`, timestamp: "0x6b49d201", baseFeePerGas: "0x1" };
async function onProvider(run: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    let q = { id: "0", method: "GET" };
    try {
      q = JSON.parse(String(init?.body)) as typeof q;
    } catch {}
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: q.method === "eth_getBlockByNumber" ? BLOCK : q.method === "eth_chainId" ? "0x14a34" : "0x0" }), { status: 200 });
  }) as typeof fetch;
  resetHostLanes();
  try {
    await run();
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

test("the queue's pass reads its trees on the pool's pass sync, the settle's: a state read's pass asks that sync for the epoch's trees", async () => {
  await onProvider(async () => {
    const { w } = await freshLanding();
    const asked: bigint[] = [];
    const t = testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED64.slice() }, {
      prover: { vault: signalsProver(), stop: () => {} },
      hardwareConcurrency: 2,
      evmPin: (c: string) => (c === "base" ? PIN : undefined),
      evmSync: () => ({
        events: async () => Promise.reject(new Error("no round here")),
        trees: async (beforeMs: bigint) => {
          asked.push(beforeMs);
          return Promise.reject(new Error("no trees here"));
        },
        depthAt: async () => Promise.reject(new Error("no depth here")),
      }),
    } as never);
    await t.stateRead();
    for (let i = 0; i < 40 && asked.length === 0; i++) await tick(50);
    assert.ok(asked.length > 0, "the queue's pass asked the pass sync for its trees");
    assert.equal(asked[0]! % 60_000n, 0n, "the first ask is the epoch's cut");
  });
});
