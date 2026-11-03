// node --test scripts/live-checks/pool-evm-testnet-run.test.mjs: card pool-evm-testnet-run's live check, replayed.
// pool-evm-testnet-run.answers.json holds the check's reads of the real run on Base Sepolia's two RPCs (good) and the
// same reads with every nullifierHashes answer false on both (bad: a spend the pool never marked). Good passes every
// line; bad fails on the first nullifier; the record it reads is the one committed beside it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { replayer } from "./notes-per-pool-evm.mjs";
import { VIEWS, check, recordFileOf, runRecord, spoil } from "./pool-evm-testnet-run.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-evm-testnet-run.answers.json", import.meta.url), "utf8"));
const REC = JSON.parse(readFileSync(recordFileOf(A.record.chain), "utf8"));

test("the answers were read from the committed run record, and the run record names every one of its txs", () => {
  assert.deepEqual(A.record, REC);
  assert.equal(REC.dryRun, false);
  const md = readFileSync(new URL("./pool-evm-testnet-run.md", import.meta.url), "utf8");
  assert.equal(md, runRecord(REC));
  assert.match(md, /^Money path: yes$/m);
  assert.deepEqual([...md.matchAll(/^Tx: (\S+) (0x[0-9a-f]{64})$/gm)].map((m) => `${m[1]} ${m[2]}`), REC.txs.map((t) => `${REC.chain} ${t.hash}`));
  for (const k of ["deposit", "buy", "sell", "withdraw", "sweep"]) assert.ok(REC.txs.some((t) => t.kind === k), k);
});

test("the recorded good run passes: every tx, the pool's views, the nullifiers, the Ws' delegation, the run key", async () => {
  const r = await check(A.record, replayer(A.good), A.urls);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, A.record.txs.length + 4);
  assert.match(r.lines.at(-4), /currentRoot \d+, currentTreeSize \d+, .*stateRootTimes\(currentRoot\) set/);
  assert.match(r.lines.at(-3), /nullifiers spent and the \d+ precommitments used are marked/);
  assert.match(r.lines.at(-2), /delegated to the pinned SellDelegate/);
});

test("the recorded bad run (nullifierHashes false on both RPCs) fails, and is the good run but that", async () => {
  assert.deepEqual(A.bad, spoil(A.good));
  const changed = A.bad.filter((e, i) => JSON.stringify(e) !== JSON.stringify(A.good[i]));
  assert.ok(changed.length >= 2 && changed.every((e) => e.params[0].data.startsWith(VIEWS.nullifierHashes)));
  const r = await check(A.record, replayer(A.bad), A.urls);
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /nullifierHashes\(\d+\) is not set on both/);
});

test("a record that claims another out than the chain's Bought event fails", async () => {
  const rec = structuredClone(A.record);
  const buy = rec.txs.find((t) => t.kind === "buy");
  buy.out = String(BigInt(buy.out) + 1n);
  const r = await check(rec, replayer(A.good), A.urls);
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /out is \d+, the record says \d+/);
});
