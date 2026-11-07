// node --test scripts/live-checks/pool-evm-testnet-run.test.mjs: card pool-evm-testnet-run's live check, replayed.
// pool-evm-testnet-run.answers.json holds, per run (Base Sepolia, Robinhood testnet), the check's reads of the real run
// on the chain's two RPCs (good) and the same reads with every nullifierHashes answer false on both (bad: a spend the
// pool never marked). Good passes every line; bad fails on the first nullifier; each record it reads is the one
// committed beside it, and the run record names every tx of every run. Every chain's run sells (card evm-sell-v4-kit):
// Robinhood testnet through the v4 PoolManager, Base Sepolia through it and through the v3 router. A run that stopped
// part way (Robinhood testnet's first, 4 Nov 08:45Z) is read back too and its Tx lines are in the run record.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { replayer } from "./notes-per-pool-evm.mjs";
import { CHAINS, SELL_SELECTOR, SELL_SELECTOR_10, TOPICS, VIEWS, check, poolRecordAt, recordFileOf, recordFiles, runRecord, sellSelectorOf, sellTarget, spoil } from "./pool-evm-testnet-run.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-evm-testnet-run.answers.json", import.meta.url), "utf8"));
const RECS = recordFiles().map((f) => JSON.parse(readFileSync(f, "utf8")));

test("the answers were read from the committed run records, and the run record names every one of their txs", () => {
  assert.deepEqual(A.runs.map((r) => r.record), RECS);
  const md = readFileSync(new URL("./pool-evm-testnet-run.md", import.meta.url), "utf8");
  assert.equal(md, runRecord(RECS));
  assert.match(md, /^Money path: yes$/m);
  assert.deepEqual([...md.matchAll(/^Tx: (\S+) (0x[0-9a-f]{64})$/gm)].map((m) => `${m[1]} ${m[2]}`), RECS.flatMap((rec) => rec.txs.map((t) => `${rec.chain} ${t.hash}`)));
  assert.deepEqual(RECS.filter((r) => !r.stopped).map((r) => r.chain), CHAINS);
  for (const c of CHAINS) assert.deepEqual(JSON.parse(readFileSync(recordFileOf(c), "utf8")), RECS.find((r) => r.chain === c && !r.stopped));
  for (const rec of RECS.filter((r) => r.stopped)) assert.ok(md.includes(rec.stopped), `${rec.chain}: why the run stopped`);
  for (const rec of RECS.filter((r) => !r.stopped)) {
    assert.equal(rec.dryRun, false);
    for (const k of ["deposit", "buy", "withdraw", "sweep", "sell"]) assert.ok(rec.txs.some((t) => t.kind === k), `${rec.chain} ${k}`);
    assert.ok(rec.txs.some((t) => t.kind === "sell" && t.venue === "v4"), `${rec.chain}: a sell through the v4 PoolManager`);
  }
});

for (const run of A.runs) {
  const chain = run.record.chain + (run.record.stopped ? " (stopped run)" : "");
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
  if (run.record.stopped) {
    test(`${chain}: a stopped run that does not say why, or has no deposit, fails`, async () => {
      for (const stopped of ["", 1]) {
        const r = await check({ ...run.record, stopped }, replayer(run.good), run.urls);
        assert.equal(r.ok, false);
        assert.match(r.lines.at(-1), /names why it stopped/);
      }
      const r = await check({ ...run.record, txs: run.record.txs.filter((t) => t.kind !== "deposit") }, replayer(run.good), run.urls);
      assert.equal(r.ok, false);
      assert.match(r.lines.at(-1), /the record has no deposit/);
    });
    continue;
  }

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

  // the review of a22060d, item 1: the target is read from the chain's answer, the transaction's input W signed
  test(`${chain}: a sell whose input on the chain names another target than the pinned one fails, the record unchanged`, async () => {
    for (const sell of run.record.txs.filter((t) => t.kind === "sell")) {
      const log = structuredClone(run.good);
      let set = 0;
      for (const e of log)
        if (e.method === "eth_getTransactionByHash" && e.params[0] === sell.hash && e.result) {
          const at = 10 + 2 * Number(BigInt(`0x${e.result.input.slice(10, 74)}`)) + 2 * 64;
          e.result.input = e.result.input.slice(0, at) + "000000000000000000000000" + "14cc0aac535ccdb3c01d6787d6413c739ae12bc4" + e.result.input.slice(at + 64);
          set++;
        }
      assert.equal(set, 2, "the sell read on both RPCs");
      assert.equal(sellTarget(log.find((e) => e.method === "eth_getTransactionByHash" && e.params[0] === sell.hash).result.input), "0x14cc0aac535ccdb3c01d6787d6413c739ae12bc4");
      const r = await check(run.record, replayer(log), run.urls);
      assert.equal(r.ok, false, sell.step);
      assert.match(r.lines.at(-1), /W signed the target 0x14cc\w+, the record says 0x/);
    }
  });

  test(`${chain}: a record and a chain that both name another target than the pinned one fail`, async () => {
    const sell = run.record.txs.find((t) => t.kind === "sell");
    const rec = structuredClone(run.record);
    const log = structuredClone(run.good);
    const other = "0x14cc0aac535ccdb3c01d6787d6413c739ae12bc4";
    rec.txs.find((t) => t.hash === sell.hash).target = other;
    for (const e of log)
      if (e.method === "eth_getTransactionByHash" && e.params[0] === sell.hash && e.result) {
        const at = 10 + 2 * Number(BigInt(`0x${e.result.input.slice(10, 74)}`)) + 2 * 64;
        e.result.input = e.result.input.slice(0, at) + "000000000000000000000000" + other.slice(2) + e.result.input.slice(at + 64);
      }
    const r = await check(rec, replayer(log), run.urls);
    assert.equal(r.ok, false);
    assert.match(r.lines.at(-1), /a v[34] sell through 0x14cc\w+, not this chain's pinned/);
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

// the sell each recorded delegate dispatches comes from the build its code must be (pool-evm-deploy.build.json): the
// current build's 11-field sell at card evm-testnet-delegate-review3's redeploys, the 10-field one at every address the
// build file froze (card evm-sell-v4's and card evm-selldelegate-exact-debit's), never from a record's name
test("each recorded SellDelegate's sell selector is its build's: 11 fields at the current build, 10 at a frozen one", () => {
  const at = (key, chain) => JSON.parse(readFileSync(new URL(`./${key}.${chain}.json`, import.meta.url), "utf8")).contracts.SellDelegate.address;
  for (const chain of ["base-sepolia", "robinhood-testnet"]) {
    assert.equal(sellSelectorOf(chain, at("evm-testnet-delegate-review3", chain)), SELL_SELECTOR, chain);
    for (const key of ["evm-sell-v4", "evm-selldelegate-exact-debit"]) assert.equal(sellSelectorOf(chain, at(key, chain)), SELL_SELECTOR_10, `${key} ${chain}`);
    // a frozen address on the other chain is not frozen here: the current build
    const other = chain === "base-sepolia" ? "robinhood-testnet" : "base-sepolia";
    assert.equal(sellSelectorOf(chain, at("evm-selldelegate-exact-debit", other)), SELL_SELECTOR, chain);
  }
  assert.notEqual(SELL_SELECTOR, SELL_SELECTOR_10);
});

// the review of 14196e5c: once the pool-review-3 build is frozen (a later build current), its delegates still dispatch
// the 11-field sell, which their own build entry names; a build that names no sell is refused, never given a guess
test("a frozen 11-field SellDelegate build keeps its own sell selector; a build naming none is refused", () => {
  const at = (key, chain) => JSON.parse(readFileSync(new URL(`./${key}.${chain}.json`, import.meta.url), "utf8")).contracts.SellDelegate.address;
  const B = JSON.parse(readFileSync(new URL("./pool-evm-deploy.build.json", import.meta.url), "utf8"));
  assert.equal(B.contracts.SellDelegate.sell, SELL_SELECTOR);
  const review3 = { ...B.contracts.SellDelegate, contract: "SellDelegate", note: "a test's freeze", at: Object.fromEntries(["base-sepolia", "robinhood-testnet"].map((c) => [c, at("evm-testnet-delegate-review3", c)])) };
  const later = { ...B, contracts: { ...B.contracts, SellDelegate: { ...B.contracts.SellDelegate, masked: "0x" + "12".repeat(32), sell: "0x12345678" } }, frozen: { ...B.frozen, "SellDelegate.review3": review3 } };
  for (const chain of ["base-sepolia", "robinhood-testnet"]) {
    assert.equal(sellSelectorOf(chain, at("evm-testnet-delegate-review3", chain), later), SELL_SELECTOR, chain);
    assert.equal(sellSelectorOf(chain, at("evm-selldelegate-exact-debit", chain), later), SELL_SELECTOR_10, chain);
    assert.equal(sellSelectorOf(chain, "0x" + "ab".repeat(20), later), "0x12345678", chain);
    const none = { ...later, frozen: { ...later.frozen, "SellDelegate.review3": { ...review3, sell: undefined } } };
    assert.throws(() => sellSelectorOf(chain, at("evm-testnet-delegate-review3", chain), none), /names no sell selector/, chain);
  }
});

test("each run is read against the pool set of its time: the first set's runs its pool, card pool-evm-buy-pays-revert's runs its redeployed pool", () => {
  const rec = (f) => JSON.parse(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"));
  for (const c of CHAINS) {
    const first = rec(`pool-evm-deploy.${c}.json`).contracts.PrivacyPoolSimple.address;
    const redeploy = rec(`pool-evm-buy-pays-revert.${c}.json`);
    assert.equal(poolRecordAt(c, rec(`pool-evm-testnet-run.${c}.json`).at).contracts.PrivacyPoolSimple.address, first, `${c}: the first set's run`);
    const run = rec(`pool-evm-buy-pays-revert.run.${c}.json`);
    assert.equal(run.pool.toLowerCase(), redeploy.contracts.PrivacyPoolSimple.address.toLowerCase(), c);
    assert.equal(poolRecordAt(c, run.at).contracts.PrivacyPoolSimple.address, redeploy.contracts.PrivacyPoolSimple.address, `${c}: the redeployed set's run`);
    assert.equal(poolRecordAt(c, new Date(Date.parse(redeploy.at) - 1).toISOString()).contracts.PrivacyPoolSimple.address, first, `${c}: a run just before the redeploy`);
    assert.throws(() => poolRecordAt(c, "2026-11-01T00:00:00.000Z"), /no pool deployed on/);
  }
});
