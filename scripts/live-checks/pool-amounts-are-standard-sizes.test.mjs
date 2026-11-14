// node --test scripts/live-checks/pool-amounts-are-standard-sizes.test.mjs: the live check replays its recorded answers
// (pool-amounts-are-standard-sizes.answers.json), both real reads of the mainnet Solana pool on the two public RPCs,
// 13 Nov 20:5xZ. good: from 20:30Z, after release 130's last pool transaction: PASS. bad: from 18:00Z, release 130's
// buys and sells: FAIL on the sale's 12,000,000 deposit back. Planted on bad: that deposit as the 10,000,000 rung the
// fix makes PASSes (its three off-ladder releases are the remainders of notes made before, under the 7 deposits);
// one more off-ladder release than the deposits before, a release RPC 1 does not read, a deposit RPC 1 reads otherwise
// before --from, no --from, and another pool each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isRung, judge, POOL } from "./pool-amounts-are-standard-sizes.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-amounts-are-standard-sizes.answers.json", import.meta.url), "utf8"));
const SALE = "4vAKf5nLLXyLXddRz21kd8ihheuVdYMAYsk2YxxoHzNhMJD9THSDhwmVYY98Q6DdWNuHPhUw8koocTangSXkejPr";
const copy = (x) => JSON.parse(JSON.stringify(x));
const mapRows = (rec, f) => ({ ...rec, rows: rec.rows.map((list, k) => list.map((r) => f(r, k))) });

test("recorded good answer: from 20:30Z, nothing off the ladder: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: from 18:00Z, the sale's 12,000,000 deposit back: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [`BAD ${SALE}: a deposit of 12000000 lamports, off the ladder`]);
});

test("planted on bad: the sale's deposit as the 10,000,000 rung the fix makes: PASS, its releases the remainders of older notes", () => {
  const v = judge(mapRows(copy(ANSWERS.bad), (r) => (r.sig === SALE ? { ...r, delta: "10000000" } : r)));
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.match(v.lines[0], /7 deposits before .*, 3 remainder releases off the ladder after it/);
});

test("planted: more off-ladder releases than deposits before the fix: FAIL", () => {
  const fixed = mapRows(copy(ANSWERS.bad), (r) => (r.sig === SALE ? { ...r, delta: "10000000" } : r));
  const extra = Array.from({ length: 5 }, (_, i) => ({ sig: `planted${i}`, time: 1794600000 + i, delta: "-6000000" }));
  const v = judge({ ...fixed, rows: fixed.rows.map((l) => [...l, ...extra]) });
  assert.equal(v.ok, false);
  assert.equal(v.lines.length, 1, v.lines.join("\n"));
  assert.match(v.lines[0], /^BAD planted4: a release of 6000000 lamports, off the ladder, past the 7 remainders/);
});

test("planted: a deposit off the ladder by one lamport, and a release RPC 1 does not read, each FAIL", () => {
  const plus = mapRows(copy(ANSWERS.good), (r) => r);
  plus.rows = plus.rows.map((l) => [...l, { sig: "late", time: 1794700000, delta: "10000001" }]);
  assert.deepEqual(judge(plus).lines, ["BAD late: a deposit of 10000001 lamports, off the ladder"]);
  const one = copy(ANSWERS.good);
  one.rows[0].push({ sig: "late", time: 1794700000, delta: "-10000000" });
  assert.match(judge(one).lines[0], /^BAD the two RPCs read the pool's transactions from .* on differently/);
});

test("planted: a deposit RPC 1 reads otherwise before the fix, no --from, another pool, one RPC's reads alone: each FAIL", () => {
  const other = mapRows(copy(ANSWERS.good), (r, k) => (k === 1 && r.delta === "10000000" ? { ...r, delta: "10000001" } : r));
  assert.equal(judge(other).ok, false);
  assert.equal(judge({ ...copy(ANSWERS.good), from: undefined }).ok, false);
  assert.equal(judge({ ...copy(ANSWERS.good), pool: "11111111111111111111111111111111" }).ok, false);
  assert.equal(judge({ ...copy(ANSWERS.good), rows: [ANSWERS.good.rows[0]] }).ok, false);
  assert.equal(ANSWERS.good.pool, POOL);
});

test("the ladder: rungs from 0.005 SOL, 1-2-5 per power of ten", () => {
  for (const x of [5_000_000n, 10_000_000n, 20_000_000n, 50_000_000n, 1_000_000_000n]) assert.ok(isRung(x), String(x));
  for (const x of [1_000_000n, 2_000_000n, 6_000_000n, 12_000_000n, 9_425_404n, 5_000_001n]) assert.ok(!isRung(x), String(x));
});
