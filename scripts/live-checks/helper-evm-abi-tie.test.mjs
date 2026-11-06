// Replays helper-evm-abi-tie.answers.json through the live check (card helper-evm-abi-tie). good: the chain reads are
// real; the helper's answers are constructed, this branch's evmPoolSender().carry run in-process (the fix is not
// deployed), so the run passes. bad: a real run against the deployed helper at f21d4be2, which carries the
// three-argument withdraw: it refuses the withdraw that landed (bad_shape) and takes the three-argument form, so it
// fails. Each plant changes the good run in one place and fails too.
//   node --test scripts/live-checks/helper-evm-abi-tie.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bodiesOf, judge } from "./helper-evm-abi-tie.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-evm-abi-tie.answers.json", import.meta.url), "utf8"));
const copy = () => structuredClone(A.good);
const bad = (run) => judge(run).lines.filter((l) => l.startsWith("BAD"));

test("the good run passes", () => {
  const r = judge(A.good);
  assert.deepEqual(bad(A.good), []);
  assert.equal(r.ok, true);
  assert.equal(A.good.constructed, true, "the good run's helper answers are marked constructed");
});

test("the deployed helper's real run fails: the landed withdraw refused as bad_shape, the three-argument one taken", () => {
  const lines = bad(A.bad);
  assert.equal(judge(A.bad).ok, false);
  for (const n of ["base-sepolia", "robinhood-testnet"]) {
    assert.ok(lines.some((l) => l.includes(`[${n} landed_withdraw]`) && l.includes("bad_shape")), n);
    assert.ok(lines.some((l) => l.includes(`[${n} three_argument]`) && l.includes("epoch_off")), n);
  }
  assert.equal(lines.length, 4, "nothing else in the deployed run is off");
});

test("planted: a pool that dispatches no signed withdraw, or the three-argument one, or two RPCs that differ, fails", () => {
  const strip = copy();
  for (const r of strip.pools[0].code.pool) r.code = r.code.replaceAll("6394374b2b", "6394374b2c");
  assert.ok(bad(strip).some((l) => l.includes("dispatches 0x94374b2b")));
  const old = copy();
  for (const r of old.pools[1].code.pool) r.code = r.code.replace("6394374b2b", "638a3bff22");
  assert.ok(bad(old).some((l) => l.includes("does not dispatch 0x8a3bff22")));
  const split = copy();
  split.pools[0].code.pool[1].code = `${split.pools[0].code.pool[1].code}00`;
  assert.ok(bad(split).some((l) => l.includes("the same on both")));
});

test("planted: a landed withdraw that failed or went elsewhere, a helper answer off, or one with no commit, fails", () => {
  const failed = copy();
  failed.pools[0].landed.reads[0].status = "0x0";
  assert.ok(bad(failed).some((l) => l.includes("landed]")));
  const elsewhere = copy();
  for (const r of elsewhere.pools[1].landed.reads) r.to = "0x0000000000000000000000000000000000000001";
  assert.ok(bad(elsewhere).some((l) => l.includes("landed]")));
  const sent = copy();
  sent.pools[0].reads.find((r) => r.asked === "landed_withdraw").body = JSON.stringify({ hash: `0x${"11".repeat(32)}` });
  sent.pools[0].reads.find((r) => r.asked === "landed_withdraw").status = 200;
  assert.ok(bad(sent).some((l) => l.includes("landed_withdraw]")));
  const anon = copy();
  anon.pools[1].reads[0].headers["x-helper-commit"] = null;
  assert.ok(bad(anon).some((l) => l.includes("X-Helper-Commit")));
  const one = copy();
  one.pools.pop();
  assert.ok(bad(one).some((l) => l.includes("pools read")));
});

test("the bodies: the landed calldata with the fee answer's recipient, its three-argument form, and one byte more", () => {
  const p = A.good.pools[0];
  const input = p.landed.reads[0].input;
  const to = "0x00000000000000000000000000000000000fee01";
  const b = bodiesOf(input, p.pool, to, 60_000);
  assert.equal(b.landed_withdraw.data.length, input.length);
  assert.equal(b.landed_withdraw.data.slice(2 + 8 + 64 * 23, 2 + 8 + 64 * 24), to.slice(2).padStart(64, "0"));
  assert.equal(b.landed_withdraw.data.slice(0, 2 + 8 + 64 * 23), input.toLowerCase().slice(0, 2 + 8 + 64 * 23));
  assert.equal((b.three_argument.data.length - 2) / 2, 4 + 32 * 27, "the three-argument withdraw: 868 bytes");
  assert.equal(b.three_argument.data.slice(2, 10), "8a3bff22");
  assert.equal(b.trailing_byte.data, `${b.landed_withdraw.data}00`);
});
