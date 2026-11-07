// The EVM sale pools a device banned (src/pool/evm-sell-bans.ts, card evm-sell-hook-converge): a reverted sale's quote's
// `hooked` pools, kept per (chain, token) in the wallet store's meta evm-bans/<chain>/<token>, read back as the next
// sell quote's `banned`. IndexedDB here is fake-indexeddb (one in-memory IDBFactory per test).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, openWalletStoreReader, WALLET_BAN_PREFIX, walletSeedMoved, type WalletEvent, type WalletStore } from "../src/store/index.ts";
import { EVM_SELL_BAN_FIRST_MS, EVM_SELL_BAN_MAX_MS, EVM_SELL_BANS_MAX, evmSellBan, evmSellBanKey, evmSellBanned } from "../src/pool/evm-sell-bans.ts";

const opened: WalletStore[] = [];
after(() => opened.forEach((s) => s.close()));
const open = async (idb: IDBFactory, onEvent?: (e: WalletEvent) => void) => {
  const s = await openWalletStore({ indexedDB: idb, ...(onEvent ? { onEvent } : {}) });
  opened.push(s);
  return s;
};
const TOKEN = "0xabcdef1111111111111111111111111111111111";
const UP = (h: string) => "0x" + h.slice(2).toUpperCase();
const P = (n: number) => "0x" + (0xabc0 + n).toString(16).padStart(64, "0");

test("a ban is kept per chain and token, read back oldest first, each pool once; another token or chain reads none", async () => {
  const s = await open(new IDBFactory());
  assert.deepEqual(await evmSellBanned(s, "base", TOKEN), []);
  assert.deepEqual(await evmSellBan(s, "base", TOKEN, [P(1)]), [P(1)]);
  // a token or a pool id in capitals is the same token and pool
  assert.deepEqual(await evmSellBan(s, "base", UP(TOKEN), [UP(P(2)), P(1)]), [P(1), P(2)]);
  assert.deepEqual(await evmSellBanned(s, "base", UP(TOKEN)), [P(1), P(2)]);
  assert.deepEqual(await evmSellBanned(s, "base", TOKEN), [P(1), P(2)]);
  assert.deepEqual(await evmSellBanned(s, "robinhood", TOKEN), []);
  assert.deepEqual(await evmSellBanned(s, "base", "0x2222222222222222222222222222222222222222"), []);
  assert.equal(evmSellBanKey("base", TOKEN), `${WALLET_BAN_PREFIX}base/${TOKEN}`);
  // a record not in its shape holds no pool (the permanent v1 bans of 919742f5 among them), and is replaced by the next ban
  const later = Date.now() + 3_600_000;
  await s.put("meta", evmSellBanKey("base", TOKEN), { v: 1, pools: [P(9), { id: P(9), until: later, n: 1 }] });
  assert.deepEqual(await evmSellBanned(s, "base", TOKEN), []);
  await s.put("meta", evmSellBanKey("base", TOKEN), { v: 2, pools: [P(9), { id: P(9), until: String(later), n: 1 }, { id: P(9), until: later, n: 0 }] });
  assert.deepEqual(await evmSellBanned(s, "base", TOKEN), []);
  assert.deepEqual(await evmSellBan(s, "base", TOKEN, [P(3)]), [P(3)]);
});

test("a ban refuses a pool, a token or a chain not in its shape, before any write", async () => {
  const s = await open(new IDBFactory());
  for (const bad of [["0x" + "ab".repeat(31)], ["ab".repeat(32)], [7], "0x" + "ab".repeat(32)]) {
    await assert.rejects(evmSellBan(s, "base", TOKEN, bad as string[]), /PoolId|a list/, JSON.stringify(bad));
  }
  await assert.rejects(evmSellBan(s, "base", "0x1234", [P(1)]), /a ban names/);
  await assert.rejects(evmSellBan(s, "Base/x", TOKEN, [P(1)]), /a ban names/);
  assert.deepEqual(await s.keys("meta").then((k) => k.filter((x) => x.startsWith(WALLET_BAN_PREFIX))), []);
});

test("two tabs banning at once keep both pools (one compare-and-set each)", async () => {
  const idb = new IDBFactory();
  const [a, b] = [await open(idb), await open(idb)];
  await Promise.all([evmSellBan(a, "base", TOKEN, [P(1)]), evmSellBan(b, "base", TOKEN, [P(2)])]);
  assert.deepEqual((await evmSellBanned(a, "base", TOKEN)).sort(), [P(1), P(2)]);
});

test(`at most ${EVM_SELL_BANS_MAX} pools are kept a token, the oldest dropped first: an old ban costs one more try, never a frozen sale`, async () => {
  const s = await open(new IDBFactory());
  const all = Array.from({ length: EVM_SELL_BANS_MAX + 2 }, (_, i) => P(i + 1));
  const kept = await evmSellBan(s, "base", TOKEN, all);
  assert.equal(kept.length, EVM_SELL_BANS_MAX);
  assert.deepEqual(kept, all.slice(2));
});

test("a ban's write is no seed move, and the frame's reader neither reads nor lists it", async () => {
  const idb = new IDBFactory();
  const seen: WalletEvent[] = [];
  const s = await open(idb);
  await open(idb, (e) => seen.push(e));
  await evmSellBan(s, "base", TOKEN, [P(1)]);
  await new Promise((ok) => setTimeout(ok, 20));
  const changed = seen.filter((e) => e.kind === "changed");
  assert.equal(changed.length, 1);
  assert.equal(walletSeedMoved(changed[0]), false);
  for (const k of ["evm-bans/", "evm-bans/base", "evm-bans/a/b/c", "evm-bansx"]) await assert.rejects(s.put("meta", k, {}), /is the store's own/, k);
  const reader = (await openWalletStoreReader({ indexedDB: idb }))!;
  await assert.rejects(reader.get("meta", evmSellBanKey("base", TOKEN)), /reader opens meta\/status/);
  assert.ok(!(await reader.keys("meta")).some((k) => k.startsWith(WALLET_BAN_PREFIX)), "the reader lists no ban");
  reader.close();
});

test("a ban lasts an hour, then the pool is quoted again; each repeat after it expired lasts twice the one before, at most seven days (review of 919742f5, F2)", async () => {
  const s = await open(new IDBFactory());
  const t0 = 1_793_732_153_000;
  const H = EVM_SELL_BAN_FIRST_MS;
  assert.equal(H, 3_600_000);
  assert.deepEqual(await evmSellBan(s, "base", TOKEN, [P(1)], t0), [P(1)]);
  assert.deepEqual(await evmSellBanned(s, "base", TOKEN, t0 + H - 1), [P(1)]);
  // expired: the next quote's banned leaves it out, so the quote reads the pool again
  assert.deepEqual(await evmSellBanned(s, "base", TOKEN, t0 + H), []);
  // banned again while still banned: as it was, never longer
  await evmSellBan(s, "base", TOKEN, [P(1)], t0 + H - 1);
  assert.deepEqual(await evmSellBanned(s, "base", TOKEN, t0 + H), []);
  // each repeat after expiry doubles: 2 h, 4 h, ... up to 7 days, never past it
  let at = t0 + H;
  for (const ms of [2 * H, 4 * H, 8 * H, 16 * H, 32 * H, 64 * H, 128 * H, EVM_SELL_BAN_MAX_MS, EVM_SELL_BAN_MAX_MS]) {
    assert.deepEqual(await evmSellBan(s, "base", TOKEN, [P(1)], at), [P(1)]);
    assert.deepEqual(await evmSellBanned(s, "base", TOKEN, at + ms - 1), [P(1)], String(ms));
    assert.deepEqual(await evmSellBanned(s, "base", TOKEN, at + ms), [], String(ms));
    at += ms;
  }
  assert.equal(EVM_SELL_BAN_MAX_MS, 7 * 24 * H);
  // another pool's first ban is an hour, beside it
  assert.deepEqual(await evmSellBan(s, "base", TOKEN, [P(2)], at), [P(2)]);
  assert.deepEqual(await evmSellBanned(s, "base", TOKEN, at + H), []);
});
