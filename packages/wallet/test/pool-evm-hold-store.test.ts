// An EVM pool's verified hold in the wallet store (src/pool/evm-hold-store.ts, card evm-pool-sync-holds): meta
// evm-hold/<network>/<pool>, read back on a new page whole (bigints and each source's kept logs), never lowered, no seed
// move, never read or listed by the frame's reader, deleted by a sign out. IndexedDB here is fake-indexeddb.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, openWalletStoreReader, WALLET_EVM_HOLD_PREFIX, walletSeedMoved, type WalletEvent, type WalletStore } from "../src/store/index.ts";
import { evmHoldKey, evmStoredHold } from "../src/pool/evm-hold-store.ts";
import type { EvmPoolEvent, EvmSyncHeld } from "../src/pool/evm.ts";

const opened: WalletStore[] = [];
after(() => opened.forEach((s) => s.close()));
const open = async (idb: IDBFactory, onEvent?: (e: WalletEvent) => void) => {
  const s = await openWalletStore({ indexedDB: idb, ...(onEvent ? { onEvent } : {}) });
  opened.push(s);
  return s;
};
const POOL = "0xaa080e74ec99cf5c684548c77ca145edfcf899cf";
const PIN = { network: "base" as const, pool: POOL };
const ev = (block: bigint, i: bigint): EvmPoolEvent =>
  ({ block, logIndex: i, blockHash: `0x${"ab".repeat(32)}`, kind: "deposit", state: 7n + i, value: 10n ** 18n, label: 3n, precommitment: 5n, nullifier: null, recipient: null, token: null, bytes: `0x${"cd".repeat(8)}` }) as unknown as EvmPoolEvent;
const at = (to: bigint, kept: EvmSyncHeld["kept"] = []): EvmSyncHeld => ({ network: "base", pool: POOL, fromBlock: 54_325_671n, to, events: [ev(54_325_700n, 0n), ev(54_325_700n, 1n)], kept });

test("a hold is read back whole on a new page: its leaves, its block and each source's kept logs, bigints exact", async () => {
  const idb = new IDBFactory();
  const s = await open(idb);
  const h = evmStoredHold(async () => s, PIN);
  assert.equal(await h.read(), undefined, "none before a sync");
  const v = at(55_000_000n, [{ op: "helper", from: 55_000_001n, to: 55_100_000n, logs: [ev(55_050_000n, 4n)] }]);
  await h.write(v);
  // a new page: another store opened on the same database
  const s2 = await open(idb);
  assert.deepEqual(await evmStoredHold(async () => s2, { ...PIN, pool: POOL.toUpperCase().replace("0X", "0x") }).read(), v);
});

test("a hold never moves back; the same block again carries its sources' kept logs", async () => {
  const s = await open(new IDBFactory());
  const h = evmStoredHold(async () => s, PIN);
  await h.write(at(100n));
  await h.write(at(40n));
  assert.equal(((await h.read()) as EvmSyncHeld).to, 100n);
  const k = [{ op: "drpc.org", from: 101n, to: 200n, logs: [] }];
  await h.write(at(100n, k));
  assert.deepEqual(((await h.read()) as EvmSyncHeld).kept, k);
  await h.write(at(120n));
  assert.equal(((await h.read()) as EvmSyncHeld).to, 120n);
});

test("one record per pool and network; a key not in its shape is refused", async () => {
  assert.equal(evmHoldKey(PIN), `${WALLET_EVM_HOLD_PREFIX}base/${POOL}`);
  assert.throws(() => evmHoldKey({ network: "base", pool: "0x12" }), /a hold names/);
  assert.throws(() => evmHoldKey({ network: "Base/x" as never, pool: POOL }), /a hold names/);
  const s = await open(new IDBFactory());
  await evmStoredHold(async () => s, PIN).write(at(100n));
  assert.equal(await evmStoredHold(async () => s, { network: "robinhood", pool: POOL }).read(), undefined);
  for (const k of ["evm-hold/", "evm-hold/base", `evm-hold/base/${POOL}/x`, "evm-holdx", `evm-hold/base/${POOL.toUpperCase()}`]) await assert.rejects(s.put("meta", k, {}), /is the store's own/, k);
});

test("a hold's write moves no seed, the frame's reader never reads or lists it, and a sign out deletes it", async () => {
  const idb = new IDBFactory();
  const s = await open(idb);
  const seen: WalletEvent[] = [];
  await open(idb, (e) => seen.push(e));
  await evmStoredHold(async () => s, PIN).write(at(100n));
  await new Promise((ok) => setTimeout(ok, 20));
  const changed = seen.filter((e) => e.kind === "changed");
  assert.equal(changed.length, 1);
  assert.equal(walletSeedMoved(changed[0]), false);
  const reader = (await openWalletStoreReader({ indexedDB: idb }))!;
  await assert.rejects(reader.get("meta", evmHoldKey(PIN)), /reader opens meta\/status/);
  assert.ok(!(await reader.keys("meta")).some((k) => k.startsWith(WALLET_EVM_HOLD_PREFIX)), "the reader lists no hold");
  reader.close();
  await s.signOut();
  const s2 = await open(idb);
  assert.equal(await evmStoredHold(async () => s2, PIN).read(), undefined, "gone with the sign out");
});
