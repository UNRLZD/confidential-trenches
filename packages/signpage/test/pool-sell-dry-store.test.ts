// Card app-sell-shows-what-you-receive: the preview's holding is the positions as held (pool-testnet.ts positionsNow,
// positions.ts get()), never the state read's positions(), which starts the sign-in's first pass: a seed read, a store
// write and the finder's read. Probed signed in before any state read, and signed out on an empty store: no store
// write, no seed read, no request, and the sign-in's first pass still the sign-in's. The state read's call, beside it,
// is what the preview read before (review P2-2).
//   node --test test/pool-sell-dry-store.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { testnetPool } from "../src/pool-testnet.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN = { program: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" };
const WRITES = new Set(["put", "delete", "clear", "insertSeed", "add", "move", "replaceSeed", "deleteSeed"]);
const realFetch = globalThis.fetch;
after(() => void (globalThis.fetch = realFetch));

async function probe(signedIn: boolean) {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  after(() => w.close());
  if (signedIn) await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const n = { writes: [] as string[], seeds: 0, requests: 0 };
  const store = new Proxy(w, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      return typeof v === "function" ? (...a: unknown[]) => (WRITES.has(String(k)) && n.writes.push(`${String(k)} ${String(a[0])}/${String(a[1])}`), (v as (...x: unknown[]) => unknown).apply(t, a)) : v;
    },
  }) as WalletStore;
  globalThis.fetch = (async () => (n.requests++, new Response("{}", { status: 503 }))) as typeof fetch;
  const tp = testnetPool({ store: async () => store, seed64: async () => (n.seeds++, SEED64.slice()) }, { pin: PIN, positions: { setTimer: () => 0, clearTimer: () => {} } } as never);
  return { tp, n };
}
const settle = () => new Promise((r) => setTimeout(r, 200));

for (const signedIn of [true, false]) {
  test(`the preview's holding, ${signedIn ? "signed in before any state read" : "signed out on an empty store"}: no store write, no seed read, no request`, async () => {
    const { tp, n } = await probe(signedIn);
    for (let i = 0; i < 5; i++) assert.equal(tp.positionsNow(), null);
    await settle();
    assert.deepEqual(n, { writes: [], seeds: 0, requests: 0 });
    // the state read's call (what the preview called before): it starts the sign-in's first pass
    const before = await probe(signedIn);
    await before.tp.positions();
    await settle();
    assert.ok(before.n.writes.length + before.n.seeds + before.n.requests > 0, `positions() started nothing? ${JSON.stringify(before.n)}`);
  });
}
