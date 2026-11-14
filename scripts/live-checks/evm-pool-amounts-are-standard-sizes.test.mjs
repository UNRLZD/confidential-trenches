// node --test scripts/live-checks/evm-pool-amounts-are-standard-sizes.test.mjs: the live check replays its recorded
// answers (evm-pool-amounts-are-standard-sizes.answers.json), both real reads of the mainnet Base and Robinhood pools on
// their two public RPCs each, 14 Nov 10:1xZ. good: from 13 Nov 21:10Z, after the Robinhood sale's deposit back: PASS.
// bad: from 7 Nov, before both pools: FAIL on that deposit back of 1,880,137,434,291,065 wei. Planted on bad: that
// deposit as the 1,000,000,000,000,000 rung the fix makes PASSes; an off-ladder release past the deposits before the
// fix, a deposit one wei off, an event one RPC does not read, no --from, another pool, one RPC's reads alone and a
// missing chain each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EVM_LADDER } from "../../packages/wallet/src/pool/evm.ts";
import { isRung, judge, MIN, ONE, POOLS } from "./evm-pool-amounts-are-standard-sizes.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./evm-pool-amounts-are-standard-sizes.answers.json", import.meta.url), "utf8"));
const SALE = "0x6de337eda1b3bcecc05171709977929b7585f84a458e4933cd2d3205fb867a83";
const copy = (x) => JSON.parse(JSON.stringify(x));
const mapRows = (rec, chain, f) => {
  const out = copy(rec);
  out.chains[chain].rows = out.chains[chain].rows.map((list, k) => list.map((r) => f(r, k)));
  return out;
};

test("recorded good answer: from 13 Nov 21:10Z, nothing off the ladder on either pool: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, [
    "ok base: 1 events, 0 deposits before the fix, 1 from it, 0 remainder releases off the ladder",
    "ok robinhood: 3 events, 2 deposits before the fix, 0 from it, 0 remainder releases off the ladder",
  ]);
});

test("recorded bad answer: from 7 Nov, the Robinhood sale's deposit back off the ladder: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [`BAD robinhood ${SALE}: a deposit of 1880137434291065 wei, off the ladder`]);
});

test("planted on bad: the sale's deposit back as the 0.001 ETH rung: PASS", () => {
  const v = judge(mapRows(ANSWERS.bad, "robinhood", (r) => (r.tx === SALE ? { ...r, value: "1000000000000000" } : r)));
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("planted: an off-ladder release with no deposit before the fix, and a deposit one wei off: each FAIL", () => {
  const late = { tx: "0xplanted", index: 0, block: 114100000, time: 1794700000, kind: "withdraw", value: "880137434291065" };
  const rel = copy(ANSWERS.good);
  rel.chains.base.rows = rel.chains.base.rows.map((l) => [...l, late]);
  assert.deepEqual(judge(rel).lines, ["BAD base 0xplanted: a withdraw release of 880137434291065 wei, off the ladder, past the 0 remainders of notes made before the fix"]);
  // on Robinhood two deposits came before the fix: one such release each is the last remainder of an older note
  const rh = copy(ANSWERS.good);
  rh.chains.robinhood.rows = rh.chains.robinhood.rows.map((l) => [...l, { ...late, kind: "buy" }]);
  assert.equal(judge(rh).ok, true, judge(rh).lines.join("\n"));
  const dep = mapRows(ANSWERS.good, "base", (r) => ({ ...r, value: (BigInt(r.value) + 1n).toString() }));
  assert.match(judge(dep).lines[0], /^BAD base 0x[0-9a-f]+: a deposit of 10000000000000001 wei, off the ladder/);
});

test("planted: an event one RPC does not read, no --from, another pool, one RPC's reads alone, a chain missing, other RPCs: each FAIL", () => {
  const one = copy(ANSWERS.good);
  one.chains.base.rows[0].push({ tx: "0xlate", index: 0, block: 57300000, time: 1794700000, kind: "deposit", value: "1000000000000000" });
  assert.deepEqual(judge(one).lines, ["BAD base: the two RPCs read the pool's events differently"]);
  assert.equal(judge({ ...copy(ANSWERS.good), from: undefined }).ok, false);
  const other = copy(ANSWERS.good);
  other.chains.robinhood.pool = POOLS.base.pool;
  assert.equal(judge(other).ok, false);
  const alone = copy(ANSWERS.good);
  alone.chains.base.rows = [alone.chains.base.rows[0]];
  assert.equal(judge(alone).ok, false);
  const missing = copy(ANSWERS.good);
  delete missing.chains.robinhood;
  assert.equal(judge(missing).ok, false);
  const rpcs = copy(ANSWERS.good);
  rpcs.chains.base.rpcs = [POOLS.base.rpcs[0], POOLS.base.rpcs[0]];
  assert.equal(judge(rpcs).ok, false);
});

test("the ladder: the wallet's EVM_LADDER, rungs from 0.001 ETH, 1-2-5 per power of ten", () => {
  assert.equal(ONE, EVM_LADDER.one);
  assert.equal(MIN, EVM_LADDER.min);
  for (const x of [10n ** 15n, 2n * 10n ** 15n, 5n * 10n ** 15n, 10n ** 16n, 10n ** 18n]) assert.ok(isRung(x), String(x));
  for (const x of [10n ** 14n, 5n * 10n ** 14n, 3n * 10n ** 15n, 1_880_137_434_291_065n, 10n ** 15n + 1n]) assert.ok(!isRung(x), String(x));
});
