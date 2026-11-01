// The frame never opens the seed record (src/state.ts, card signpage-frame-state): SIGN_HOST and APP_HOST are one site,
// so the frame may share APP_HOST's renderer process, and decoded seed JSON must never sit in its heap. A spy on the
// store the frame opens fails the test on any get("meta", "seed"), signed out, signed in, through every event.
//   node --test test/state-no-seed-read.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { frameState } from "../src/state.ts";

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

test("the frame's state path never calls get on meta/seed", async () => {
  const idb = new IDBFactory();
  const name = `frame-no-seed-read-${process.pid}`;
  const reads: string[] = [];
  const changes: number[] = [];
  const fs = frameState(async (onEvent) => {
    const s = await openWalletStore({ indexedDB: idb, name, onEvent });
    closers.push(() => s.close());
    return {
      ...s,
      get: (store, key) => {
        reads.push(`${store}/${key}`);
        return s.get(store, key);
      },
    } as WalletStore;
  });
  closers.push(() => fs.close());
  fs.watch(() => changes.push(Date.now()));

  const tab = await openWalletStore({ indexedDB: idb, name });
  closers.push(() => tab.close());
  await fs.state(); // signed out
  await tab.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "random", code_saved: false, created_ms: 1 });
  await tab.put("meta", "status", { v: 1, source: "random", code_saved: false });
  await tab.put("ops", crypto.randomUUID(), { kind: "deposit", stage: "waiting", txs: [], created_ms: 2 });
  const signedIn = await fs.state();
  await tab.setCodeSaved();
  await tab.put("meta", "status", { v: 1, source: "random", code_saved: true });
  const saved = await fs.state();
  await tab.signOut();
  await new Promise((ok) => setTimeout(ok, 30));
  const out = await fs.state();

  assert.equal(signedIn.signed_in, true);
  assert.equal(saved.code_saved, true);
  assert.equal(out.signed_in, false);
  assert.ok(changes.length > 0, "the frame heard the other tab");
  assert.ok(reads.length > 0, "the spy saw the frame's reads");
  assert.deepEqual(reads.filter((r) => r === "meta/seed"), [], `reads: ${reads.join(", ")}`);
});
