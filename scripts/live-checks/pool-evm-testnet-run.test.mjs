// node --test scripts/live-checks/pool-evm-testnet-run.test.mjs: card pool-evm-testnet-run's live check, replayed.
// pool-evm-testnet-run.answers.json holds, per run (Base Sepolia, Robinhood testnet), the check's reads of the real run
// on the chain's two RPCs (good) and the same reads with every nullifierHashes answer false on both (bad: a spend the
// pool never marked). Good passes every line; bad fails on the first nullifier; each record it reads is the one
// committed beside it, and the run record names every tx of every run. Every chain's run sells (card evm-sell-v4-kit):
// Robinhood testnet through the v4 PoolManager, Base Sepolia through it and through the v3 router.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { replayer } from "./notes-per-pool-evm.mjs";
import { CHAINS, TOPICS, VIEWS, check, recordFileOf, runRecord, spoil } from "./pool-evm-testnet-run.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-evm-testnet-run.answers.json", import.meta.url), "utf8"));
const RECS = CHAINS.map((c) => JSON.parse(readFileSync(recordFileOf(c), "utf8")));

test("the answers were read from the committed run records, and the run record names every one of their txs", () => {
  assert.deepEqual(A.runs.map((r) => r.record), RECS);
  const md = readFileSync(new URL("./pool-evm-testnet-run.md", import.meta.url), "utf8");
  assert.equal(md, runRecord(RECS));
  assert.match(md, /^Money path: yes$/m);
  assert.deepEqual([...md.matchAll(/^Tx: (\S+) (0x[0-9a-f]{64})$/gm)].map((m) => `${m[1]} ${m[2]}`), RECS.flatMap((rec) => rec.txs.map((t) => `${rec.chain} ${t.hash}`)));
  for (const rec of RECS) {
    assert.equal(rec.dryRun, false);
    for (const k of ["deposit", "buy", "withdraw", "sweep", "sell"]) assert.ok(rec.txs.some((t) => t.kind === k), `${rec.chain} ${k}`);
    assert.ok(rec.txs.some((t) => t.kind === "sell" && t.venue === "v4"), `${rec.chain}: a sell through the v4 PoolManager`);
  }
});

for (const run of A.runs) {
  const chain = run.record.chain;
  test(`${chain}: the recorded good run passes: every tx, the pool's views, the nullifiers, the Ws' delegation, the run key`, async () => {
    const r = await check(run.record, replayer(run.good), run.urls);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.equal(r.lines.length, run.record.txs.length + 4);
    assert.match(r.lines.at(-4), /currentRoot \d+, currentTreeSize \d+, .*stateRootTimes\(currentRoot\) set/);
    assert.match(r.lines.at(-3), /nullifiers spent and the \d+ precommitments used are marked/);
    assert.match(r.lines.at(-2), /delegated to the pinned SellDelegate/);
  });

  test(`${chain}: the recorded bad run (nullifierHashes false on both RPCs) fails, and is the good run but that`, async () => {
    assert.deepEqual(run.bad, spoil(run.good));
    const changed = run.bad.filter((e, i) => JSON.stringify(e) !== JSON.stringify(run.good[i]));
    assert.ok(changed.length >= 2 && changed.every((e) => e.params[0].data.startsWith(VIEWS.nullifierHashes)));
    const r = await check(run.record, replayer(run.bad), run.urls);
    assert.equal(r.ok, false);
    assert.match(r.lines.at(-1), /nullifierHashes\(\d+\) is not set on both/);
  });

  test(`${chain}: a record that claims another out than the chain's Bought event fails`, async () => {
    const rec = structuredClone(run.record);
    const buy = rec.txs.find((t) => t.kind === "buy");
    buy.out = String(BigInt(buy.out) + 1n);
    const r = await check(rec, replayer(run.good), run.urls);
    assert.equal(r.ok, false);
    assert.match(r.lines.at(-1), /out is \d+, the record says \d+/);
  });

  test(`${chain}: a run with no sell fails`, async () => {
    const rec = structuredClone(run.record);
    rec.txs = rec.txs.filter((t) => t.kind !== "sell");
    const r = await check(rec, replayer(run.good), run.urls);
    assert.equal(r.ok, false);
    assert.match(r.lines.at(-1), /the record has no sell/);
  });

  test(`${chain}: a v4 sell the record says went through another target than the pinned PoolManager fails`, async () => {
    const rec = structuredClone(run.record);
    const sell = rec.txs.find((t) => t.kind === "sell" && t.venue === "v4");
    sell.target = "0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4";
    const r = await check(rec, replayer(run.good), run.urls);
    assert.equal(r.ok, false);
    assert.match(r.lines.at(-1), /a v4 sell through 0x94cc\w+, not this chain's pinned PoolManager/);
  });

  test(`${chain}: a v4 sell whose receipt holds no Swap by W on the PoolManager fails`, async () => {
    const sell = run.record.txs.find((t) => t.kind === "sell" && t.venue === "v4");
    const log = structuredClone(run.good);
    let cut = 0;
    for (const e of log)
      if (e.method === "eth_getTransactionReceipt" && e.params[0] === sell.hash && e.result) {
        const n = e.result.logs.length;
        e.result.logs = e.result.logs.filter((l) => l.topics[0] !== TOPICS.Swap);
        cut += n - e.result.logs.length;
      }
    assert.ok(cut >= 2, "the Swap read on both RPCs");
    const r = await check(run.record, replayer(log), run.urls);
    assert.equal(r.ok, false);
    assert.match(r.lines.at(-1), /0 Swap events from 0x[0-9a-f]{40}, not 1/);
  });

  test(`${chain}: a sell whose authorization names another delegate than the pinned SellDelegate fails`, async () => {
    const sell = run.record.txs.find((t) => t.kind === "sell");
    const log = structuredClone(run.good);
    for (const e of log) if (e.method === "eth_getTransactionByHash" && e.params[0] === sell.hash && e.result) e.result.authorizationList[0].address = "0x23ad5aabcc139650597f8dc79e9def8bd817ef88";
    const r = await check(run.record, replayer(log), run.urls);
    assert.equal(r.ok, false);
    assert.match(r.lines.at(-1), /its authorization is not this chain's pinned SellDelegate/);
  });
}

test("a transaction the two RPCs answer apart in any field but blockTimestamp fails", async () => {
  const run = A.runs.find((r) => r.good.some((e) => e.method === "eth_getTransactionByHash" && e.result?.blockTimestamp));
  assert.ok(run, "a recorded run where one RPC adds blockTimestamp");
  const k = run.good.findIndex((e) => e.method === "eth_getTransactionByHash" && e.result?.blockTimestamp);
  const log = structuredClone(run.good);
  log[k].result.value = `0x${(BigInt(log[k].result.value) + 1n).toString(16)}`;
  const r = await check(run.record, replayer(log), run.urls);
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /the two RPCs answer/);
});
