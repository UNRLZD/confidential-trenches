// node --test packages/signpage/test/pool-w-tail.test.ts: a W's leftover under the pool's least standard size is the
// user's money kept on W (card pool-amounts-are-standard-sizes; the CO's pick (c), 13 Nov 20:4xZ), recorded where
// wallet's pool-to-Cash reads it: meta w-tail/sol/<address> = { chain: "sol", address, l, j, amount }. The rent back's
// floor end writes it, an empty read or a sent sweep deletes it; the wallet store takes the key, the write moves no seed
// and the frame's reader never lists it. IndexedDB here is fake-indexeddb; no key, no seed.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, openWalletStoreReader, WALLET_W_TAIL_PREFIX, walletSeedMoved, type WalletEvent, type WalletStore } from "@blindfill/wallet/store";
import { owedAfter, owedRentBacks, restAdds, wTailKey, type OwedRentBack, type PoolSellHost } from "../src/pool-sell.ts";
import { solanaSellNoteFloor } from "../src/rules/pool.ts";

const opened: WalletStore[] = [];
after(() => opened.forEach((s) => s.close()));
const W = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const O: OwedRentBack = { address: W, l: "3", j: 1, mints: [], passes: 0 };

test("the rent back's floor end writes W's tail with what W adds once moved; an empty read and a sent sweep delete it", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  opened.push(s);
  const owed = owedRentBacks(async () => s);
  const h = { owed } as unknown as PoolSellHost;
  await owed.put(O);
  assert.equal(wTailKey(W), `${WALLET_W_TAIL_PREFIX}sol/${W}`);
  await owedAfter(h, O, "floor", undefined, { lamports: 2_345_678n });
  assert.deepEqual(await s.get("meta", wTailKey(W)), { chain: "sol", address: W, l: "3", j: 1, amount: "2345678" });
  await owedAfter(h, O, "sent", undefined, { sweep: "sig" });
  assert.equal(await s.get("meta", wTailKey(W)), undefined, "a sent sweep: gone");
  await owedAfter(h, O, "floor", undefined, { lamports: 4_999_999n });
  await owedAfter(h, O, "holds", undefined, {});
  assert.equal(((await s.get("meta", wTailKey(W))) as { amount: string }).amount, "4999999", "a pass that holds keeps it");
  await owedAfter(h, O, "floor", undefined, { unlisted: true });
  assert.equal(await s.get("meta", wTailKey(W)), undefined, "a rest that adds nothing once moved: none");
  await owedAfter(h, O, "floor", undefined, { lamports: 1n });
  await owedAfter(h, O, "nothing");
  assert.equal(await s.get("meta", wTailKey(W)), undefined, "W read empty: gone");
});

test("the wallet store takes w-tail/<chain>/<address> only; its write moves no seed and the frame's reader never lists it", async () => {
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb });
  opened.push(s);
  const seen: WalletEvent[] = [];
  opened.push(await openWalletStore({ indexedDB: idb, onEvent: (e) => seen.push(e) }));
  await owedRentBacks(async () => s).tail!({ chain: "sol", address: W, l: "3", j: 1, amount: "7" });
  await new Promise((ok) => setTimeout(ok, 20));
  const changed = seen.filter((e) => e.kind === "changed");
  assert.equal(changed.length, 1);
  assert.equal(walletSeedMoved(changed[0]), false);
  for (const k of ["w-tail/", "w-tail/sol", `w-tail/sol/${W}/x`, "w-tailx", `w-tail/SOL/${W}`]) await assert.rejects(s.put("meta", k, {}), /is the store's own/, k);
  const reader = (await openWalletStoreReader({ indexedDB: idb }))!;
  assert.ok(!(await reader.keys("meta")).some((k) => k.startsWith(WALLET_W_TAIL_PREFIX)), "the reader lists no tail");
  reader.close();
});

// The worker's review of this card, its source bugs 2 and 1. A rest whose own rung would leave W under what it must keep
// (rent(0), 650,240 at mainnet rent) ends at the floor, so it is listed, and its tail carried, at the whole rest, not at
// the rung no sweep takes. The sale's note floor is a rung, so the rule's raw min out less the reserve and the device's
// rung note of it fall on the same side of it.
test("a rest no sweep takes is listed whole; the sell's note floor is a rung at any rent", () => {
  assert.equal(restAdds(5_216_729n, 5_000_000n, 650_240n), 5_216_729n, "5M would leave 216,729, under rent(0)");
  assert.equal(restAdds(5_700_000n, 5_000_000n, 650_240n), 5_000_000n, "5M leaves 700,000: the sweep takes it");
  for (const lamportsPerByte of [5_080n, 6_960n, 20_000n, 60_000n, 200_000n]) {
    const f = solanaSellNoteFloor({ lamportsPerByte, factor: 1n });
    let q = f / 1_000_000n;
    while (q % 10n === 0n) q /= 10n;
    assert.ok(f >= 5_000_000n && f % 1_000_000n === 0n && (q === 1n || q === 2n || q === 5n), `${lamportsPerByte}: ${f}`);
  }
});
