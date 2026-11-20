// node --test apps/helper/src/data/evm/index-store.test.ts: card helper-evm-tapes-survive-a-restart. The chain's swap
// index on the store volume (index-store.ts): a restarted helper holds the window the old one read and reads only the
// blocks since; a copy is served only once read up to a head read after the start, one past its window behind is
// dropped; a torn or corrupt file, or one bad row, is dropped whole and started again, never served.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSwapIndex } from "./index.ts";
import { openIndexStore } from "./index-store.ts";
import type { Log } from "./swaps.ts";

const SWAP = `0x${"aa".repeat(32)}`;
const PM = `0x${"11".repeat(20)}`;
const POOL = `0x${"22".repeat(20)}`;
const ID = `0x${"33".repeat(32)}`;
const WINDOW = 100;
const chainLogs = (lo: number, hi: number): Log[] =>
  Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).flatMap((b) => [
    { block: b, index: 0, tx: `0x${b.toString(16).padStart(64, "0")}`, address: PM, topics: [SWAP, ID], data: `0x${"0".repeat(63)}1`, t: b },
    { block: b, index: 1, tx: `0x${b.toString(16).padStart(64, "0")}`, address: POOL, topics: [SWAP], data: "0x", t: null },
  ]);
const V4 = { address: PM, topics: [SWAP, ID] };

function dir(t: { after: (f: () => void) => void }): string {
  const d = mkdtempSync(join(tmpdir(), "swap-index-store-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
/** A helper's index on `file`: its reads, and the drops its store logged. */
function helper(file: string, writable?: Promise<unknown>) {
  const reads: [number, number][] = [];
  const logged: string[] = [];
  const store = openIndexStore(file, [SWAP], (l) => logged.push(l));
  const read = async (lo: number, hi: number) => (reads.push([lo, hi]), chainLogs(lo, hi));
  const index = createSwapIndex({ topics: [SWAP], read, window: WINDOW, chunk: 40, store, ...(writable === undefined ? {} : { writable }) });
  return { reads, logged, index, store };
}

test("a restarted helper serves the window the old one read, with no read of it, the same logs", async (t) => {
  const file = join(dir(t), "swap-index-robinhood.sqlite");
  const old = helper(file);
  assert.equal(await old.index.upTo(1_000), true);
  await old.index.upTo(1_030);
  const was = { range: old.index.range(), logs: old.index.logs(0, 2_000), v4: old.index.query(V4, 0, 2_000) };
  assert.deepEqual(was.range, { from: 931, to: 1_030 });

  const next = helper(file);
  assert.equal(next.index.range(), null, "a copy is not served before it is checked against a head");
  assert.equal(await next.index.upTo(1_030), true);
  assert.deepEqual(next.reads, [], "the head the copy reaches: nothing read");
  assert.deepEqual(next.index.range(), was.range);
  assert.deepEqual(next.index.logs(0, 2_000), was.logs);
  assert.deepEqual(next.index.query(V4, 0, 2_000), was.v4);
});

test("a copy behind the head is served only once the blocks since are read, and only those are read", async (t) => {
  const file = join(dir(t), "swap-index-robinhood.sqlite");
  await helper(file).index.upTo(1_000);
  const next = helper(file);
  assert.equal(next.index.range(), null);
  assert.equal(next.index.holds(950, 1_000), false, "behind the head: not served as complete");
  assert.deepEqual(next.index.query(V4, 0, 2_000), []);
  assert.equal(await next.index.upTo(1_050), true);
  assert.deepEqual(next.reads, [[1_001, 1_040], [1_041, 1_050]]);
  assert.deepEqual(next.index.range(), { from: 951, to: 1_050 });
  assert.deepEqual(next.index.logs(0, 2_000), chainLogs(951, 1_050));
  // what the catch-up read was written too: a third start holds it
  const third = helper(file);
  await third.index.upTo(1_050);
  assert.deepEqual(third.reads, []);
  assert.deepEqual(third.index.logs(0, 2_000), chainLogs(951, 1_050));
});

test("planted: a copy past its window behind the head (or ahead of it) is dropped, and the window read again", async (t) => {
  for (const head of [1_000 + WINDOW + 1, 1_000 - WINDOW - 1]) {
    const file = join(dir(t), "swap-index-robinhood.sqlite");
    await helper(file).index.upTo(1_000);
    const next = helper(file);
    assert.equal(await next.index.upTo(head), true);
    assert.deepEqual(next.index.range(), { from: head - WINDOW + 1, to: head }, `head ${head}`);
    assert.deepEqual(next.index.logs(0, 5_000), chainLogs(head - WINDOW + 1, head), `head ${head}`);
    assert.equal(next.reads[0]![0], head - WINDOW + 1, `head ${head}`);
  }
});

test("planted: a torn or corrupt file is dropped and started again, never served", async (t) => {
  const damage: [string, (file: string) => void][] = [
    ["torn in half", (f) => truncateSync(f, Math.floor(readFileSync(f).length / 2))],
    ["not a database", (f) => writeFileSync(f, "x".repeat(8_192))],
    ["a page overwritten", (f) => {
      const b = readFileSync(f);
      b.fill(0x5a, 4_096, 8_192);
      writeFileSync(f, b);
    }],
    ["the page that holds block 950's rows overwritten", (f) => {
      const b = readFileSync(f);
      const at = b.indexOf(`0x${(950).toString(16).padStart(64, "0")}`);
      assert.ok(at > 0);
      const page = at - (at % 4_096);
      b.fill(0x5a, page, page + 4_096);
      writeFileSync(f, b);
    }],
  ];
  for (const [why, hurt] of damage) {
    const file = join(dir(t), "swap-index-robinhood.sqlite");
    const old = helper(file);
    await old.index.upTo(1_000);
    // the WAL folded into the file, as at a clean stop, so the damage is to the rows themselves
    const db = new DatabaseSync(file);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    hurt(file);
    const next = helper(file);
    assert.ok(next.store !== null, why);
    assert.ok(next.logged.some((l) => /dropped|started again/.test(l)), `${why}: ${next.logged.join(" | ")}`);
    assert.equal(next.index.range(), null, why);
    assert.equal(await next.index.upTo(1_000), true, why);
    assert.deepEqual(next.reads[0], [901, 940], `${why}: the whole window read again`);
    assert.deepEqual(next.index.logs(0, 2_000), chainLogs(901, 1_000), why);
    // and written again whole
    const third = helper(file);
    await third.index.upTo(1_000);
    assert.deepEqual(third.reads, [], why);
  }
});

test("planted: one row that fails its check drops the copy whole", async (t) => {
  const bad: [string, string][] = [
    ["a topic0 the index does not hold", `UPDATE logs SET topics = '0x${"bb".repeat(32)}' WHERE block = 950 AND idx = 1`],
    ["a block outside the range held", "UPDATE logs SET block = 5000 WHERE block = 950 AND idx = 1"],
    ["a tx that is no hash", "UPDATE logs SET tx = '0x12' WHERE block = 950 AND idx = 1"],
    ["an address in capitals", `UPDATE logs SET address = '0x${"AB".repeat(20)}' WHERE block = 950 AND idx = 1`],
    ["data not in words", "UPDATE logs SET data = '0x123' WHERE block = 950 AND idx = 1"],
    ["a range with no end", "DELETE FROM meta WHERE k = 'to'"],
    ["another layout", "UPDATE meta SET v = '9' WHERE k = 'layout'"],
  ];
  for (const [why, sql] of bad) {
    const file = join(dir(t), "swap-index-robinhood.sqlite");
    await helper(file).index.upTo(1_000);
    const db = new DatabaseSync(file);
    db.exec(sql);
    db.close();
    const next = helper(file);
    assert.ok(next.logged.length > 0, why);
    await next.index.upTo(1_000);
    assert.deepEqual(next.reads[0], [901, 940], why);
    assert.deepEqual(next.index.logs(0, 2_000), chainLogs(901, 1_000), why);
  }
});

test("a deploy's new helper writes nothing until the senders are its own, then the range it holds, whole", async (t) => {
  const file = join(dir(t), "swap-index-robinhood.sqlite");
  const old = helper(file);
  await old.index.upTo(1_000);
  let handOver = () => {};
  const held = new Promise<void>((r) => (handOver = r));
  const next = helper(file, held);
  await next.index.upTo(1_010);
  assert.equal(helper(file).store!.load()!.to, 1_000, "the new one wrote nothing before the handover");
  // the old helper goes on writing while it serves
  await old.index.upTo(1_020);
  assert.equal(helper(file).store!.load()!.to, 1_020);
  handOver();
  await held;
  await new Promise((r) => setImmediate(r));
  const copy = helper(file).store!.load()!;
  assert.deepEqual([copy.from, copy.to], [911, 1_010]);
  assert.deepEqual(copy.logs, chainLogs(911, 1_010));
});

test("the other helper of a deploy mid-write: the new one reads the copy committed before it, drops nothing", async (t) => {
  const file = join(dir(t), "swap-index-robinhood.sqlite");
  await helper(file).index.upTo(1_000);
  const other = new DatabaseSync(file);
  t.after(() => other.close());
  other.exec("BEGIN IMMEDIATE; DELETE FROM logs; UPDATE meta SET v = '5' WHERE k = 'from';");
  const next = helper(file);
  assert.deepEqual(next.logged, [], "no drop");
  assert.ok(next.store !== null);
  assert.equal(await next.index.upTo(1_000), true);
  assert.deepEqual(next.reads, [], "the copy committed before the write in flight is served");
  assert.deepEqual(next.index.logs(0, 2_000), chainLogs(901, 1_000));
  other.exec("ROLLBACK");
  assert.equal(helper(file).store!.load()!.logs.length, 200);
});

test("card helper-loop-never-held-by-a-read: the store's file is WAL with synchronous NORMAL, so a write's commit syncs nothing in a turn of the loop (red at c6711e2c3: synchronous FULL)", (t) => {
  const sql: string[] = [];
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, q: string) {
    sql.push(q);
    return exec.call(this, q);
  });
  const store = openIndexStore(join(dir(t), "swaps.sqlite"), [SWAP]);
  assert.ok(store !== null);
  const pragmas = sql.join("\n");
  assert.match(pragmas, /PRAGMA journal_mode = WAL;/);
  assert.match(pragmas, /PRAGMA synchronous = NORMAL;/);
  assert.doesNotMatch(pragmas, /synchronous = (FULL|EXTRA)/);
  assert.match(pragmas, /PRAGMA wal_autocheckpoint = 0;/, "no write runs the log's checkpoint (its sync) in a turn of the loop");
});

test("card helper-loop-never-held-by-a-read: a checkpoint that fails is told to the store, which turns its own connection's checkpoint back on (red at b45f34f7b: the thread caught the error and said nothing)", async (t) => {
  const sql: string[] = [];
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, q: string) {
    sql.push(q);
    return exec.call(this, q);
  });
  const d = dir(t);
  const file = join(d, "swaps.sqlite");
  const store = openIndexStore(file, [SWAP]);
  assert.ok(store !== null);
  renameSync(file, join(d, "moved.sqlite"));
  mkdirSync(file);
  for (let k = 0; k < 1_000 && !sql.includes("PRAGMA wal_autocheckpoint = 1000"); k++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(sql.includes("PRAGMA wal_autocheckpoint = 1000"), "the store's checkpoint back on");
});
