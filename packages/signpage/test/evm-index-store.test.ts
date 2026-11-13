// The page's pool index store (src/evm-index-store.ts): a kept index comes back as stored, and a store that hangs, fails
// or holds something else answers null within its bound, so the page syncs from memory.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { evmIndexStore } from "../src/evm-index-store.ts";
import type { EvmPoolIndexData } from "../../kit/src/checks/evm/pool-index.ts";

const IX: EvmPoolIndexData = {
  v: 1,
  chainId: 8453,
  poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
  from: 25_350_988,
  through: 56_783_312,
  head: { number: 56_783_312, hash: "0x" + "ab".repeat(32) },
  spans: [[25_350_988, 56_783_312]],
  pools: [],
};

test("a kept index comes back as stored, per chain, in a new store on the same database (a reload)", async () => {
  const idb = new IDBFactory();
  await evmIndexStore(idb).put("base", IX);
  const again = evmIndexStore(idb);
  assert.deepEqual(await again.get("base"), IX);
  assert.equal(await again.get("robinhood"), null);
});

// the bound is held by the test's own timeout: a store that waited on the hung open would never end
test("a store whose open never answers answers null and keeps nothing within its bound", { timeout: 5_000 }, async () => {
  const hung = { open: () => ({}) } as unknown as IDBFactory;
  const s = evmIndexStore(hung, 50);
  assert.equal(await s.get("base"), null);
  await s.put("base", IX);
});

test("a store that fails or is missing answers null; a record of another shape is never served", async () => {
  const failing = { open: () => { throw new Error("denied"); } } as unknown as IDBFactory;
  assert.equal(await evmIndexStore(failing, 50).get("base"), null);
  assert.equal(await evmIndexStore(undefined, 50).get("base"), null);
  const idb = new IDBFactory();
  await evmIndexStore(idb).put("base", { ...IX, v: 2 } as unknown as EvmPoolIndexData);
  assert.equal(await evmIndexStore(idb).get("base"), null);
});
