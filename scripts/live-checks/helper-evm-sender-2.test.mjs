// Replays card helper-evm-sender-2's live check, helper-pool-senders' EVM branch (helper-evm-sender-2.mjs runs it on each
// EVM pool), on its recorded answers (helper-evm-sender-2.answers.json, copied whole from helper-pool-senders.answers.json).
// Good: `good`, real runs against apps/helper at this card's 51fb5eb6 started locally (2026-11-07, throwaway sender keys,
// nothing sent), on both testnet pools: every plant refused with its own code. Bad: `bad`, real runs against the deployed
// helper at 63c90229, the same day: W's signature of another value reaches the simulation (simulation_failed) and the
// buy is not read (bad_shape), on both pools.
//   node --test scripts/live-checks/helper-evm-sender-2.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHECKS, poolsOf } from "./helper-evm-sender-2.mjs";
import { judge } from "./helper-pool-senders.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-evm-sender-2.answers.json", import.meta.url), "utf8"));
const P = JSON.parse(readFileSync(new URL("./helper-pool-senders.answers.json", import.meta.url), "utf8"));
// the recordings' pools: the testnets' first set (6 Nov); the entry runs on each testnet's newest pool set, card
// pool-evm-buy-pays-revert's (7 Nov), and the first set's pools no longer
const TESTNET_POOLS = ["0xb239a38af69b68e6c5c305df64985f283b5d5fe5", "0xe5e948414a89c23e73d76cd740dacdd9364c25d5"];
const CURRENT_POOLS = ["0xeb967dfc1b4ffb22942f833c76866ea85fc42266", "0xed9fac860e6bc5e932455232eedca8b71c44da4d"];

test("the entry runs helper-pool-senders on each EVM pool a deploy record names, or the one asked", () => {
  assert.deepEqual(CHECKS, ["helper-pool-senders"]);
  for (const p of CURRENT_POOLS) assert.ok(poolsOf(undefined).includes(p), `${p} from its deploy record`);
  for (const p of TESTNET_POOLS) assert.ok(!poolsOf(undefined).includes(p), `${p}: the first set's pool, redeployed`);
  assert.deepEqual(poolsOf(TESTNET_POOLS[0]), [TESTNET_POOLS[0]]);
  assert.deepEqual(poolsOf("0xB239A38AF69B68E6C5C305DF64985F283B5D5FE5"), [], "a pool not as the route takes it");
});

test("the answers are helper-pool-senders' EVM recordings, whole", () => {
  assert.deepEqual(A.good, P.evm_good);
  assert.deepEqual(A.bad, P.evm_bad);
  assert.deepEqual(A.good.map((r) => r.pool), TESTNET_POOLS);
  assert.deepEqual(A.bad.map((r) => r.pool), TESTNET_POOLS);
});

test("the good answer (this card's helper) passes on both testnet pools: every plant refused with its own code", () => {
  for (const run of A.good) {
    const r = judge(run);
    assert.equal(r.ok, true, `${run.pool}:\n${r.lines.join("\n")}`);
  }
});

test("the bad answer (the deployed helper at 63c90229) fails on both pools: W's bad signature and the buy are not refused as bad_signature", () => {
  for (const run of A.bad) {
    const r = judge(run);
    assert.equal(r.ok, false, run.pool);
    const bad = r.lines.filter((l) => l.startsWith("BAD"));
    assert.ok(bad.some((l) => l.startsWith("BAD planted evm_bad_signature") && l.includes("simulation_failed")), bad.join("\n"));
    assert.ok(bad.some((l) => l.startsWith("BAD planted evm_buy_bad_signature") && l.includes("bad_shape")), bad.join("\n"));
  }
});
