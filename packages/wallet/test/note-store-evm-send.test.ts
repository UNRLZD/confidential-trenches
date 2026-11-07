// The EVM pool deposit's send record (card pool-deposits, slice 3): { hash, nonce, value } in a note's evmSends,
// beside the Solana shape in its sends. Additive: a record of the old shape reads back as it was written. One note's
// sends are one shape; the "same value" and "written twice" checks hold for both.
//   node --test test/note-store-evm-send.test.ts      (from packages/wallet)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import * as d from "../src/derive/index.ts";
import { noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const pc = (ref: NoteRef): bigint => noteSecrets(SEED, ref).precommitment;
const opened: WalletStore[] = [];
const notes: NoteStore[] = [];
after(() => (opened.forEach((s) => s.close()), notes.forEach((n) => n.close())));
async function tab(idb = new IDBFactory()): Promise<{ w: WalletStore; ns: NoteStore; idb: IDBFactory }> {
  const w = await openWalletStore({ indexedDB: idb });
  opened.push(w);
  const ns = await openNoteStore(w);
  notes.push(ns);
  return { w, ns, idb };
}
const H = (k: number): string => "0x" + k.toString(16).padStart(64, "0");
const E = (k: number, value = 1_000_000_000_000_000n, nonce = BigInt(k - 1)) => ({ hash: H(k), nonce, value });
const S = (k: number, value = 10_000_000n) => ({ signature: "1".repeat(63) + String(k), value, last_valid_block_height: 100n + BigInt(k) });

test("an old-shape Solana record reads back unchanged, field for field, after a reopen", async () => {
  const t = await tab();
  const a = await t.ns.planDeposit(961n, pc);
  const inc = await t.ns.move(a.id, "PLANNED", "INCOMING", { send: S(1) });
  await t.ns.addSend(a.id, S(2), 1);
  t.ns.close();
  const t2 = await tab(t.idb);
  const back = await t2.ns.get(a.id);
  assert.deepEqual(back, { ...inc, sends: [S(1), S(2)] });
  assert.equal("evmSends" in back!, false, "no new field on an old record");
});

test("EVM sends: the first with PLANNED -> INCOMING, more by addEvmSend at the same value, compare-and-set; each hash once, nonces never back", async () => {
  const t = await tab();
  const a = await t.ns.planDeposit(962n, pc);
  await assert.rejects(t.ns.addEvmSend(a.id, E(1), 1), /only for an INCOMING note/);
  const inc = await t.ns.move(a.id, "PLANNED", "INCOMING", { evmSend: E(1) });
  assert.deepEqual(inc.evmSends, [E(1)]);
  assert.equal(inc.sends, undefined);
  assert.deepEqual((await t.ns.get(a.id))!.evmSends, [E(1)]);
  assert.deepEqual((await t.ns.addEvmSend(a.id, E(2), 0)).evmSends, [E(1)], "a stale count writes nothing");
  await assert.rejects(t.ns.addEvmSend(a.id, E(3, 2n), 1), /another value/);
  assert.equal(inc.evmSends![0]!.nonce, 0n, "U's first tx is at nonce 0");
  await assert.rejects(t.ns.addEvmSend(a.id, E(2), 1).then(() => t.ns.addEvmSend(a.id, { ...E(4), nonce: 0n }, 2)), /nonce goes back/);
  assert.deepEqual((await t.ns.get(a.id))!.evmSends, [E(1), E(2)]);
  await assert.rejects(t.ns.addEvmSend(a.id, E(2), 2), /written twice/);
  await assert.rejects(t.ns.addEvmSend(a.id, { ...E(5), key: 1 } as never, 2), /may not hold key/);
  // one note's sends are one shape
  await assert.rejects(t.ns.addSend(a.id, S(1), 0), /one shape/);
  const b = await t.ns.planDeposit(963n, pc);
  const sInc = await t.ns.move(b.id, "PLANNED", "INCOMING", { send: S(1) });
  await assert.rejects(t.ns.addEvmSend(sInc.id, E(1), 0), /one shape/);
  await assert.rejects(t.ns.move((await t.ns.planDeposit(964n, pc)).id, "PLANNED", "INCOMING", { send: S(1), evmSend: E(1) }), /one shape/);
  // an EVM send rides only on PLANNED -> INCOMING
  const c = await t.ns.planDeposit(965n, pc);
  await assert.rejects(t.ns.move(c.id, "PLANNED", "TAKEN", { evmSend: E(6) }), /PLANNED -> INCOMING only/);
  // lands with its sends kept
  const taken = await t.ns.move(a.id, "INCOMING", "TAKEN");
  assert.deepEqual(taken.evmSends, [E(1), E(2)]);
});

test("an EVM send's fields: a 0x 32-byte lowercase hash, a u64 nonce, a value above 0 below 2^128", async () => {
  const t = await tab();
  const bad: [unknown, RegExp][] = [
    [{ ...E(1), hash: "0x" + "ab".repeat(31) }, /hash is a 0x 32-byte/],
    [{ ...E(1), hash: "ab".repeat(32) }, /hash is a 0x 32-byte/],
    [{ ...E(1), hash: "0x" + "AB".repeat(32) }, /hash is a 0x 32-byte/],
    [{ ...E(1), nonce: 1n << 64n }, /nonce/],
    [{ ...E(1), nonce: 1 }, /nonce/],
    [{ ...E(1), nonce: -1n }, /nonce/],
    [{ ...E(1), value: 0n }, /value is above 0/],
    [{ ...E(1), value: 1n << 128n }, /value/],
    [{ hash: H(1), value: 1n }, /nonce/],
  ];
  let scope = 970n;
  for (const [send, re] of bad) {
    const n = await t.ns.planDeposit(scope++, pc);
    await assert.rejects(t.ns.move(n.id, "PLANNED", "INCOMING", { evmSend: send as never }), re, JSON.stringify(send, (_, v) => (typeof v === "bigint" ? String(v) : v)));
    assert.equal((await t.ns.get(n.id))!.state, "PLANNED", "a refused send writes nothing");
  }
});

test("an EVM send may carry sentMs (the device's clock when it was written, a u64 above 0); two sends at one nonce are kept, each hash once", async () => {
  const t = await tab();
  const a = await t.ns.planDeposit(990n, pc);
  const inc = await t.ns.move(a.id, "PLANNED", "INCOMING", { evmSend: { ...E(1), sentMs: 1_000n } });
  assert.deepEqual(inc.evmSends, [{ ...E(1), sentMs: 1_000n }]);
  // the same nonce again (a send that reached neither RPC, built again): kept beside the first
  const two = await t.ns.addEvmSend(a.id, { ...E(2), nonce: E(1).nonce, sentMs: 2_000n }, 1);
  assert.deepEqual(two.evmSends!.map((x) => [x.hash, x.nonce, x.sentMs]), [[H(1), 0n, 1_000n], [H(2), 0n, 2_000n]]);
  t.ns.close();
  const back = await (await tab(t.idb)).ns.get(a.id);
  assert.deepEqual(back!.evmSends, two.evmSends, "read back as written");
  const t2 = await tab();
  let scope = 991n;
  for (const bad of [0n, -1n, 1, 1n << 64n]) {
    const n = await t2.ns.planDeposit(scope++, pc);
    await assert.rejects(t2.ns.move(n.id, "PLANNED", "INCOMING", { evmSend: { ...E(1), sentMs: bad as bigint } }), /sentMs/);
  }
});
