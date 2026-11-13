// SPDX-License-Identifier: Apache-2.0
// The fork RPC's keys (fork-rpc.mjs keyOf): a block named by its hash takes the number its own chain's book recorded
// for that hash, on every request, while the book grows under it. No network: the upstream is this file's fetch.
// The pools fork's block pins and the recording's upstream cap: each such case runs fork-rpc.mjs in a child process,
// since it reads its environment when it loads; nothing there reaches a network: the upstream fetch is a stub that
// counts the calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
// an upstream try's bound, short here (read once, at the import)
process.env.FORK_RPC_UPSTREAM_MS = "50";
const { answer, keyOf } = await import("./fork-rpc.mjs");

const MODULE = new URL("./fork-rpc.mjs", import.meta.url).href;
const child = (code, env = {}) => {
  const base = { ...process.env };
  delete base.POOLS_FORK_BLOCK_BASE;
  delete base.POOLS_FORK_BLOCK_ROBINHOOD;
  try {
    return { ok: true, out: execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...base, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout}${e.stderr}` };
  }
};
const pins = (env) => child(`const { POOLS_FORK_BLOCKS } = await import(${JSON.stringify(MODULE)}); console.log(JSON.stringify(POOLS_FORK_BLOCKS));`, env);

test("the fork blocks: the pinned ones by default, the environment's block when it names one (a run recorded at a fresh head)", () => {
  assert.deepEqual(JSON.parse(pins().out), { base: 56_630_000, robinhood: 112_859_537 });
  assert.deepEqual(JSON.parse(pins({ POOLS_FORK_BLOCK_ROBINHOOD: "112939524" }).out), { base: 56_630_000, robinhood: 112_939_524 });
  assert.deepEqual(JSON.parse(pins({ POOLS_FORK_BLOCK_BASE: "56693522" }).out), { base: 56_693_522, robinhood: 112_859_537 });
});

test("planted: a fork block that is no number, not whole, or before the pool's deploy is refused, never a fork at another block", () => {
  for (const [k, v] of [["POOLS_FORK_BLOCK_BASE", "abc"], ["POOLS_FORK_BLOCK_BASE", ""], ["POOLS_FORK_BLOCK_ROBINHOOD", "112939524.5"], ["POOLS_FORK_BLOCK_ROBINHOOD", "0x6b"], ["POOLS_FORK_BLOCK_BASE", "54325670"], ["POOLS_FORK_BLOCK_ROBINHOOD", "-1"]]) {
    const r = pins({ [k]: v });
    assert.equal(r.ok, false, `${k}=${v}: ${r.out}`);
    assert.match(r.out, new RegExp(`fork-rpc: ${k} .* is no block after the pool's deploy`));
  }
});

test("planted: a recording stops at the upstream cap: the request past it is refused (502) and never reaches upstream", () => {
  const port = 41_000 + (process.pid % 2_000);
  const code = `
    const real = globalThis.fetch;
    let upstream = 0;
    globalThis.fetch = (url, init) => url.startsWith("http://127.0.0.1:") ? real(url, init) : (upstream++, Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 })));
    const { serve, UPSTREAM_CAP } = await import(${JSON.stringify(MODULE)});
    const server = await serve({}, true);
    const statuses = [];
    for (let i = 0; i <= UPSTREAM_CAP; i++) {
      const r = await real("http://127.0.0.1:${port}/base", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "eth_getBalance", params: ["0x" + i.toString(16).padStart(40, "0"), "0x1"] }) });
      statuses.push(r.status === 200 ? 200 : r.status + " " + (await r.text()));
    }
    server.close();
    console.log(JSON.stringify({ cap: UPSTREAM_CAP, upstream, ok: statuses.filter((s) => s === 200).length, last: statuses.at(-1) }));`;
  const r = child(code, { FORK_RPC_PORT: String(port) });
  assert.ok(r.ok, r.out);
  const got = JSON.parse(r.out.trim().split("\n").at(-1));
  assert.equal(got.cap, 400);
  assert.equal(got.upstream, 400, "upstream asked 400 times, the 401st never");
  assert.equal(got.ok, 400);
  assert.match(got.last, /^502 Error: fork-rpc: 400 upstream requests, stopped \(eth_getBalance/);
});


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

test("an upstream that never answers is tried 5 times, each try bounded, then the read is named as failed", async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  // the waits between tries (500 ms doubling) at once here; each try's bound is AbortSignal.timeout's own clock
  const later = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...a) => later(fn, ms >= 500 ? 0 : ms, ...a));
  let calls = 0;
  globalThis.fetch = (_url, init) => {
    calls++;
    assert.ok(init?.signal instanceof AbortSignal, "each try carries its own bound");
    return new Promise((_ok, no) => init.signal.addEventListener("abort", () => no(init.signal.reason)));
  };
  const at = Date.now();
  await assert.rejects(answer({ base: {} }, "base", byHash(H("e"), 9), true), /did not answer eth_getStorageAt .* in 5 tries of 0\.05 s/);
  assert.equal(calls, 5);
  assert.ok(Date.now() - at < 5_000, "bounded, not held");
});

test("planted: the cap is per upstream host: a host at 400 is asked nothing more while another host still answers, and a request with every host at the cap is refused (502)", () => {
  const port = 43_000 + (process.pid % 2_000);
  const code = `
    process.argv.push("--book", "pools", "--");
    const real = globalThis.fetch;
    const asked = {};
    const order = [];
    globalThis.fetch = (url, init) => {
      if (url.startsWith("http://127.0.0.1:")) return real(url, init);
      const h = new URL(url).host;
      asked[h] = (asked[h] ?? 0) + 1;
      order.push(h);
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 }));
    };
    const { serve, UPSTREAM_CAP } = await import(${JSON.stringify(MODULE)});
    // one host of Base's three spent to the cap first: the planted world of a run whose reads one host took
    const server = await serve({}, true);
    const ask = async (i) => {
      const r = await real("http://127.0.0.1:${port}/base", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "eth_getBalance", params: ["0x" + i.toString(16).padStart(40, "0"), "0x1"] }) });
      return r.status === 200 ? 200 : r.status + " " + (await r.text());
    };
    const statuses = [];
    for (let i = 0; i < 3 * UPSTREAM_CAP + 1; i++) statuses.push(await ask(i));
    server.close();
    // the first host to reach the cap, and what the hosts were asked after it
    let n = {}, full = null, after = [];
    for (const h of order) {
      if (full !== null) after.push(h);
      n[h] = (n[h] ?? 0) + 1;
      if (full === null && n[h] === UPSTREAM_CAP) full = h;
    }
    console.log(JSON.stringify({ cap: UPSTREAM_CAP, asked, full, afterToFull: after.filter((h) => h === full).length, afterToOthers: after.length, ok: statuses.filter((s) => s === 200).length, last: statuses.at(-1) }));`;
  const r = child(code, { FORK_RPC_PORT: String(port) });
  assert.ok(r.ok, r.out);
  const got = JSON.parse(r.out.trim().split("\n").at(-1));
  assert.equal(got.cap, 400);
  assert.deepEqual(Object.values(got.asked), [400, 400, 400], JSON.stringify(got.asked));
  assert.equal(got.afterToFull, 0, "the host at the cap is asked nothing more");
  assert.ok(got.afterToOthers > 0, "another host still answers once one is at the cap");
  assert.equal(got.ok, 1200);
  assert.match(got.last, /^502 Error: fork-rpc: 400 upstream requests, stopped \(eth_getBalance/);
});
