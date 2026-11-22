// node --test scripts/live-checks/helper-v4-busy-tape-empty.test.mjs: the live check of card helper-v4-busy-tape-empty
// judges recorded runs (helper-v4-busy-tape-empty.answers.json). good: the deployed helper, every busy v4 tape held
// exactly its pool's swaps on two RPCs alike: PASS. bad: one tape answered 200 with no trades while its pool swapped, as
// WORM's was on 5 Nov: FAIL. Planted from the good one: a swap missing inside the tape, a swap left out past its newest
// row, a tape still filling, a 503: FAIL; two RPCs not alike, a chain with no tape judged: INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { BASE_VENUES, ROBINHOOD_VENUES, TOPIC } from "../../apps/helper/src/data/evm/swaps.ts";
import { CHAINS, judge, LAG_S, SWAP } from "./helper-v4-busy-tape-empty.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-v4-busy-tape-empty.answers.json", import.meta.url), "utf8"));
const copy = (x) => JSON.parse(JSON.stringify(x));
/** MOW, its listed pool a hooked v4 pool. */
const MOW = "0x0b7c6c138dc75622f4200d157b13fb93e6bd94fa";
const mow = (run) => run.chains.robinhood.coins.find((c) => c.coin === MOW);
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the pinned PoolManagers and Swap topic are the helper's", () => {
  assert.equal(CHAINS.base.poolManager, BASE_VENUES.poolManager);
  assert.equal(CHAINS.robinhood.poolManager, ROBINHOOD_VENUES.poolManager);
  assert.equal(SWAP, TOPIC.swap4);
});

test("good: the deployed helper, every busy v4 tape exactly its pool's swaps on two RPCs: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(r.lines.filter((l) => l.startsWith("ok")).length >= 2, r.lines.join("\n"));
  assert.ok(mow(A.good).answers.at(-1).txs.length === 50);
});

test("bad: a tape answered 200 with no trades while its pool swapped (5 Nov's WORM): FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.match(bad(r).join("\n"), /200 with no trades while the pool swapped 50 times/);
});

test("planted: a swap inside the tape's blocks not on it: FAIL", () => {
  const run = copy(A.good);
  const a = mow(run).answers.at(-1);
  a.txs = a.txs.filter((_, i) => i !== 10);
  const r = judge(run);
  assert.equal(r.verdict, "FAIL");
  assert.match(bad(r).join("\n"), /1 missing/);
});

test("planted: the newest swap left off a tape whose own time is past it by LAG_S: FAIL; within LAG_S: PASS", () => {
  const run = copy(A.good);
  const c = mow(run);
  const logs = c.reads[0].logs;
  const newest = logs.reduce((x, l) => (l.b > x.b ? l : x));
  const a = c.answers.at(-1);
  a.txs = a.txs.filter((t) => t !== newest.tx);
  a.as_of_ms = (newest.ts + LAG_S) * 1000;
  assert.equal(judge(run).verdict, "FAIL");
  a.as_of_ms = (newest.ts + LAG_S - 1) * 1000;
  assert.equal(judge(run).verdict, "PASS", judge(run).lines.join("\n"));
});

test("planted: a tape still filling at the bound, or a 503: FAIL", () => {
  const filling = copy(A.good);
  mow(filling).answers.at(-1).filling = true;
  assert.equal(judge(filling).verdict, "FAIL");
  const down = copy(A.good);
  mow(down).answers.at(-1).status = 503;
  assert.equal(judge(down).verdict, "FAIL");
});

test("planted: the two RPCs not alike, or a chain with no tape judged: INCONCLUSIVE", () => {
  const apart = copy(A.good);
  for (const c of apart.chains.base.coins) c.reads[1].logs.pop();
  assert.equal(judge(apart).verdict, "INCONCLUSIVE");
  const none = copy(A.good);
  none.chains.base.coins = [];
  assert.equal(judge(none).verdict, "INCONCLUSIVE");
});

test("a tape of another pool (the coin's busiest of a quote of ours) is shown, not judged", () => {
  const run = copy(A.good);
  const c = mow(run);
  c.answers.at(-1).txs = [...c.answers.at(-1).txs.slice(1), `0x${"ab".repeat(32)}`];
  const r = judge(run);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /another pool's/.test(l)));
});

test("planted: a swap the pool's hook sent itself (fees it sold) inside the tape's blocks is no trade: PASS; a key that does not hash to the id proves no hook: FAIL", () => {
  // live run 44989861313: Robinhood 0x94641b97's pool 0x338fce55, its hook 0xe5e70264's own sale of its fee coins in tx
  // 0xc25ae71f was counted as a swap missing from the tape
  const { keccak_256 } = createRequire(new URL("../../apps/helper/package.json", import.meta.url))("@noble/hashes/sha3.js");
  const HOOK = "0xe5e702641e000000000000000000000000000000";
  const key = { currency0: "0x0000000000000000000000000000000000000000", currency1: MOW, fee: 0, tickSpacing: 200, hooks: HOOK };
  const w = (a) => a.slice(2).padStart(64, "0");
  const n = (x) => x.toString(16).padStart(64, "0");
  const id = `0x${Buffer.from(keccak_256(Buffer.from(w(key.currency0) + w(key.currency1) + n(key.fee) + n(key.tickSpacing) + w(key.hooks), "hex"))).toString("hex")}`;
  const run = copy(A.good);
  const c = mow(run);
  c.pool = id;
  c.key = key;
  const at = c.reads[0].logs[3];
  for (const r of c.reads) r.logs.push({ tx: `0x${"cd".repeat(32)}`, b: at.b, ts: at.ts, s: HOOK });
  const r = judge(run);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /1 swaps its hook sent itself left out/.test(l)), r.lines.join("\n"));
  c.key = { ...key, tickSpacing: 60 };
  const off = judge(run);
  assert.equal(off.verdict, "FAIL");
  assert.match(bad(off).join("\n"), /1 missing/);
});
