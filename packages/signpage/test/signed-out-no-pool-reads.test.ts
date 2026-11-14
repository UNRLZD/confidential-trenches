// Signed out, the page reads no pool (card one-balance-buys-on-every-chain, release 132's queue run 43529683941): the
// device's proof front (src/proof-front.ts) is taken at the page's load, at focus and at show, signed in or not, and
// its take ran a state read (src/pool-testnet.ts stateRead), whose EVM part read the Base and Robinhood pools' RPCs and
// armed the turn pass with no seed, no notes and nothing to prove: 48 reads signed out in signpage-shell and
// sign-out-stops-the-pages-reads, and base-rpc.publicnode.com opened in deposit-quote-no-liquidity's harness. Every
// path that starts a state read (the front's take, a focus, a show, a tap's take, a direct call) reads nothing while
// the page says signed out; signed in, the same page reads its pools.
//   node --test test/signed-out-no-pool-reads.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";
import { proofFront } from "../src/proof-front.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { testnetPool } = await import("../src/pool-testnet.ts");
type EvmPoolPin = import("../../wallet/src/pool/evm.ts").EvmPoolPin;
type EvmRpc = import("../../wallet/src/pool/evm.ts").EvmRpc;

const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of closers.splice(0)) await f();
});

const PINS: Record<"base" | "robinhood", EvmPoolPin> = {
  base: Object.freeze({ network: "base-sepolia", pool: "0x00000000000000000000000000000000000B0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n }),
  robinhood: Object.freeze({ network: "robinhood-testnet", pool: "0x00000000000000000000000000000000000F0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n }),
};

/** One origin's Web Locks with no other tab: every ask granted at once, held until given back. */
function soloLocks(): Pick<LockManager, "request"> {
  return {
    request(name: string, opts: LockOptions, cb: (lock: Lock | null) => unknown): Promise<unknown> {
      return Promise.resolve().then(() => cb({ name, mode: "exclusive" } as Lock));
    },
  } as unknown as Pick<LockManager, "request">;
}
/** A tab's document and window, shown with focus, its events fired by hand. */
function tabDoc() {
  const on = new Map<string, (() => void)[]>();
  return {
    visibilityState: "visible",
    hasFocus: () => true,
    addEventListener: (type: string, f: () => void) => void on.set(type, [...(on.get(type) ?? []), f]),
    fire(type: string) {
      for (const f of on.get(type) ?? []) f();
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

/** The page as main.ts builds it, on a store that holds a seed (signed in) or none (signed out), with every way out to
 *  a pool's host counted: each EVM RPC, the helper, the pool index, the sync, the round, the turn pass's timer, a fetch,
 *  the store and the seed. */
async function page(signedIn: boolean, said: () => Promise<boolean> = async () => signedIn) {
  const w: WalletStore = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  if (signedIn) await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const reads: string[] = [];
  const rpc = (url: string): EvmRpc => Object.assign(async () => (reads.push(url), Promise.reject(new Error("offline"))), { url }) as unknown as EvmRpc;
  const doc = tabDoc();
  const t = testnetPool(
    {
      store: async () => (reads.push("store"), w),
      seed64: async () => (reads.push("seed"), Promise.reject(new Error("signed out"))),
      signedIn: said,
    },
    {
      prover: { vault: signalsProver(), stop: () => {} },
      pin: null,
      fetch: (async (u: unknown) => (reads.push(`fetch ${String(u)}`), Promise.reject(new Error("offline")))) as typeof fetch,
      evmPin: (c) => PINS[c],
      evmRpcs: (c) => [rpc(`https://${c}-a.example`), rpc(`https://${c}-b.example`)],
      evmHelper: (c) => rpc(`https://${c}-helper.example`),
      evmIndexSync: async (c) => (reads.push(`index ${c}`), Promise.reject(new Error("offline"))),
      evmIndexStore: null,
      evmSync: () => ({ events: async () => (reads.push("sync"), Promise.reject(new Error("offline"))) }),
      evmRound: () => async () => (reads.push("round"), Promise.reject(new Error("offline"))),
      evmTurn: { setTimeout: () => (reads.push("turn armed"), 0), clearTimeout: () => {}, visibility: null },
      front: proofFront(soloLocks(), doc, doc, () => {}, () => {}),
      withdrawBuilt: { base: true, robinhood: true },
    },
  );
  closers.push(() => t.signedOut().catch(() => {}));
  return { t, doc, reads };
}

test("signed out: the front's take at load, a focus, a show and a state read read no pool, open no store and no seed", async () => {
  const realFetch = globalThis.fetch;
  const leaked: string[] = [];
  globalThis.fetch = (async (u: unknown) => (leaked.push(String(u)), Promise.reject(new Error("offline")))) as typeof fetch;
  try {
    const { t, doc, reads } = await page(false);
    for (let i = 0; i < 5; i++) await tick(); // the front taken at load: its take's state read
    doc.fire("focus");
    doc.fire("pageshow");
    doc.fire("visibilitychange");
    await t.stateRead();
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(reads, [], "signed out, nothing is read");
    assert.deepEqual(leaked, [], "signed out, no fetch leaves the page");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("signed in: the same page's state read reads its pools (the counters above are wired)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Promise.reject(new Error("offline"))) as typeof fetch;
  try {
    const { t, reads } = await page(true);
    for (let i = 0; i < 5; i++) await tick();
    await t.stateRead();
    for (let i = 0; i < 5; i++) await tick();
    assert.ok(reads.includes("store"), `signed in, the state read opens the store (${reads.join(", ")})`);
    assert.ok(reads.some((r) => r === "turn armed" || r.startsWith("https://")), `signed in, the state read reaches the pools (${reads.join(", ")})`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a sign out while the state read asks whether a seed is held: the read ends there, nothing armed or read", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Promise.reject(new Error("offline"))) as typeof fetch;
  try {
    // signed in at load (its reads happen), then a state read whose sign-in answer comes only after a sign out
    let answer: ((v: boolean) => void) | null = null;
    let late = false;
    const { t, reads } = await page(true, () => (late ? new Promise<boolean>((r) => (answer = r)) : Promise.resolve(true)));
    for (let i = 0; i < 5; i++) await tick();
    late = true;
    const read = t.stateRead();
    await tick();
    t.signingOut();
    reads.splice(0);
    answer!(true);
    await read;
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(reads, [], "the read a sign out overtook reads nothing");
  } finally {
    globalThis.fetch = realFetch;
  }
});
