// The frame never opens the seed record (src/state.ts, card signpage-frame-state): SIGN_HOST and APP_HOST are one site,
// so the frame may share APP_HOST's renderer process, and decoded seed JSON must never sit in its heap. A spy on the
// store the frame opens fails the test on any get("meta", "seed"), signed out, signed in, through every event.
//   node --test test/state-no-seed-read.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import * as walletStore from "@blindfill/wallet/store";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { frameState } from "../src/state.ts";

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

test("the frame's state path and deposit.quote's read never call get on meta/seed", async () => {
  const idb = new IDBFactory();
  const name = `frame-no-seed-read-${process.pid}`;
  const reads: string[] = [];
  const changes: number[] = [];
  // the read-only open where the store has one (main.ts), the full store before it
  const reader = (walletStore as Record<string, unknown>).openWalletStoreReader as typeof openWalletStore | undefined;
  const ch = new BroadcastChannel(`ct-wallet/${name}`);
  closers.push(() => ch.close());
  const fs = (frameState as (...a: unknown[]) => ReturnType<typeof frameState>)(
    async (onEvent: (e: walletStore.WalletEvent) => void) => {
      const s = await (reader ?? openWalletStore)({ indexedDB: idb, name, onEvent });
      if (!s) return s;
      closers.push(() => s.close());
      return {
        ...s,
        get: (store: walletStore.WalletStoreName, key: string) => {
          reads.push(`${store}/${key}`);
          return s.get(store, key);
        },
      } as WalletStore;
    },
    (fn: (e: unknown) => void) => (ch.onmessage = (m) => fn(m.data)),
  );
  closers.push(() => fs.close());
  fs.watch(() => changes.push(Date.now()));

  const tab = await openWalletStore({ indexedDB: idb, name });
  closers.push(() => tab.close());
  await fs.state(); // signed out
  await tab.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "random", code_saved: false, created_ms: 1 });
  await tab.put("ops", crypto.randomUUID(), { kind: "deposit", stage: "waiting", txs: [], created_ms: 2 });
  const signedIn = await fs.state();
  // deposit.quote's read (src/deposit-wire.ts): U's public record, which the top-level page names; never the seed
  assert.equal((await fs.depositRead(7n))?.deposit, undefined);
  const named = await tab.nameDeposit({ entropy: new Uint8Array(16).fill(0x7f) }, { scope: 7n, index: tab.lane, id: "5d".repeat(32) });
  await tab.setCodeSaved({ entropy: new Uint8Array(16).fill(0x7f) });
  const saved = await fs.state();
  assert.deepEqual(await fs.depositRead(7n), { status: { source: "random", code_saved: true }, deposit: named });
  await tab.signOut();
  await new Promise((ok) => setTimeout(ok, 30));
  const out = await fs.state();
  assert.equal(await fs.depositRead(7n), null);

  assert.equal(signedIn.signed_in, true);
  assert.equal(saved.code_saved, true);
  assert.equal(out.signed_in, false);
  assert.ok(changes.length > 0, "the frame heard the other tab");
  assert.ok(reads.length > 0, "the spy saw the frame's reads");
  assert.deepEqual(reads.filter((r) => r === "meta/seed"), [], `reads: ${reads.join(", ")}`);
});
