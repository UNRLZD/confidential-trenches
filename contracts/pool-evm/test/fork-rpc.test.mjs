// SPDX-License-Identifier: Apache-2.0
// The fork RPC's keys (fork-rpc.mjs keyOf): a block named by its hash takes the number its own chain's book recorded
// for that hash, on every request, while the book grows under it. No network: the upstream is this file's fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
// an upstream try's bound, short here (read once, at the import)
process.env.FORK_RPC_UPSTREAM_MS = "50";
const { answer, keyOf } = await import("./fork-rpc.mjs");

const H = (c) => `0x${c.repeat(64)}`;
const ADDR = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const block = (number, hash) => ({ result: { number, hash } });
const byHash = (hash, id = 1) => ({ jsonrpc: "2.0", id, method: "eth_getStorageAt", params: [ADDR, "0x0", { blockHash: hash }] });
const slotAt = (number) => `eth_getStorageAt ${JSON.stringify([ADDR, "0x0", number])}`;

test("one hash recorded on two chains names each chain's own block, asked in any order", () => {
  const book = {
    base: { 'eth_getBlockByNumber ["0x10",false]': block("0x10", H("a")) },
    robinhood: { 'eth_getBlockByNumber ["0x20",false]': block("0x20", H("a")) },
  };
  for (let i = 0; i < 2; i++) {
    assert.equal(keyOf(book, "base", byHash(H("a"))), slotAt("0x10"));
    assert.equal(keyOf(book, "robinhood", byHash(H("a"))), slotAt("0x20"));
  }
  // a chain with no book keeps the hash as asked
  assert.equal(keyOf(book, "other", byHash(H("a"))), `eth_getStorageAt ${JSON.stringify([ADDR, "0x0", { blockHash: H("a") }])}`);
});

test("a second hash for one block number, recorded after the first request, is known on the next request", async (t) => {
  const book = { base: { 'eth_getBlockByNumber ["0x10",false]': block("0x10", H("a")) } };
  // the first request reads the hashes the book holds
  assert.equal(keyOf(book, "base", byHash(H("a"))), slotAt("0x10"));
  assert.equal(keyOf(book, "base", byHash(H("b"))), `eth_getStorageAt ${JSON.stringify([ADDR, "0x0", { blockHash: H("b") }])}`);
  // the fork's chain reorganised: the same number read again (another key of it) answers another hash
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: "0x10", hash: H("b") } }));
  const got = await answer(book, "base", { jsonrpc: "2.0", id: 7, method: "eth_getBlockByNumber", params: ["0x10", true] }, true);
  assert.equal(got.result.hash, H("b"));
  // both hashes name block 0x10 now, the old one as before
  assert.equal(keyOf(book, "base", byHash(H("b"))), slotAt("0x10"));
  assert.equal(keyOf(book, "base", byHash(H("a"))), slotAt("0x10"));
  // and the other chain learned nothing from it
  book.robinhood = { 'eth_getBlockByNumber ["0x30",false]': block("0x30", H("c")) };
  assert.equal(keyOf(book, "robinhood", byHash(H("b"))), `eth_getStorageAt ${JSON.stringify([ADDR, "0x0", { blockHash: H("b") }])}`);
  assert.equal(keyOf(book, "robinhood", byHash(H("c"))), slotAt("0x30"));
});

test("a recorded answer is served from the book with the hash resolved, and an unrecorded one is refused by name", async () => {
  const book = { base: { 'eth_getBlockByNumber ["0x10",false]': block("0x10", H("a")), [slotAt("0x10")]: { result: H("0") } } };
  assert.deepEqual(await answer(book, "base", byHash(H("a"), 3), false), { jsonrpc: "2.0", id: 3, result: H("0") });
  const miss = await answer(book, "base", byHash(H("d"), 4), false);
  assert.match(miss.error.message, /not recorded for base/);
});

test("an upstream that never answers is tried twice, each try bounded, then the read is named as failed", async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  let calls = 0;
  globalThis.fetch = (_url, init) => {
    calls++;
    assert.ok(init?.signal instanceof AbortSignal, "each try carries its own bound");
    return new Promise((_ok, no) => init.signal.addEventListener("abort", () => no(init.signal.reason)));
  };
  const at = Date.now();
  await assert.rejects(answer({ base: {} }, "base", byHash(H("e"), 9), true), /did not answer eth_getStorageAt .* in 2 tries of 0\.05 s/);
  assert.equal(calls, 2);
  assert.ok(Date.now() - at < 5_000, "bounded, not held");
});
