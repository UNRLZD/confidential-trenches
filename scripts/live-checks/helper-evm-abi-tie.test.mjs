// Replays helper-evm-abi-tie.answers.json through the live check (card helper-evm-abi-tie). good: the chain reads are
// real, on the pools the kit pins (card pool-evm-buy-pays-revert's set), each landed withdraw the first of the run record
// paired with the pool's current record (landedOf); the helper's answers are constructed, this branch's evmPoolSender()
// run in-process (fee() on the kit's fee providers, carry()), since the helper is not yet deployed with these pools, so
// the run passes; once it is, the host's real run replaces it. bad: the same in-process run made by this file as it was
// before card pool-evm-buy-pays-revert's review fold, whose landedOf read a withdraw on the first pool set, not the pinned
// pool: it fails. first_set: card helper-evm-abi-tie's recordings on the first pool set, judged on the pins they were
// made on; its bad, a real run against the deployed helper at f21d4be2, which carries the three-argument withdraw: it
// refuses the withdraw that landed (bad_shape) and takes the three-argument form, so it fails. Each plant changes the
// good run in one place and fails too.
//   node --test scripts/live-checks/helper-evm-abi-tie.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { evmPoolRecords, FIRST_SET } from "./helper-evm-sender.mjs";
import { bodiesOf, judge, landedOf, NETWORKS, runRecordName } from "./helper-evm-abi-tie.mjs";
import { poolFile } from "./pool-evm-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-evm-abi-tie.answers.json", import.meta.url), "utf8"));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const lower = (s) => String(s).toLowerCase();
const OLD_POOLS = ["0xb239a38af69b68e6c5c305df64985f283b5d5fe5", "0xe5e948414a89c23e73d76cd740dacdd9364c25d5"];

test("landedOf reads a withdraw that landed on the pool each network's current record names, never the first set's", () => {
  for (const n of NETWORKS) {
    const pool = lower(JSON.parse(readFileSync(poolFile(n), "utf8")).contracts.PrivacyPoolSimple.address);
    assert.equal(pool, lower(evmPoolVenues()[n].pool), `${n}: the current record is the kit's pin`);
    assert.ok(!OLD_POOLS.includes(pool), n);
    const run = JSON.parse(readFileSync(path.join(HERE, runRecordName(n)), "utf8"));
    assert.equal(lower(run.pool), pool, `${n}: ${runRecordName(n)} ran on the current pool`);
    const hash = landedOf(n);
    assert.equal(hash, run.txs.find((t) => t.kind === "withdraw").hash, n);
    const first = JSON.parse(readFileSync(path.join(HERE, `pool-evm-testnet-run.${n}.json`), "utf8"));
    assert.ok(!first.txs.some((t) => t.hash === hash), `${n}: not a first-set withdraw`);
  }
});

test("planted: landedOf refuses a current pool with no run of its own, a run on another pool, a run with no withdraw", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "abi-tie-landed-"));
  const put = (f, v) => writeFileSync(path.join(dir, f), JSON.stringify(v));
  const OLD = OLD_POOLS[1], NEW = "0x00000000000000000000000000000000000000aa", n = "robinhood-testnet";
  try {
    put(`pool-evm-deploy.${n}.json`, { chain: n, contracts: { PrivacyPoolSimple: { address: OLD } } });
    put(`pool-evm-testnet-run.${n}.json`, { chain: n, pool: OLD, txs: [{ kind: "withdraw", hash: "0x01" }] });
    assert.equal(landedOf(n, dir), "0x01", "the first set alone: its own run");
    put(`pool-evm-buy-pays-revert.${n}.json`, { chain: n, contracts: { PrivacyPoolSimple: { address: NEW } } });
    assert.throws(() => landedOf(n, dir), /no run record pool-evm-buy-pays-revert\.run\.robinhood-testnet\.json/, "never the first set's withdraw");
    put(`pool-evm-buy-pays-revert.run.${n}.json`, { chain: n, pool: OLD, txs: [{ kind: "withdraw", hash: "0x01" }] });
    assert.throws(() => landedOf(n, dir), /ran on 0xe5e9.*not the pool/);
    put(`pool-evm-buy-pays-revert.run.${n}.json`, { chain: n, pool: NEW, txs: [{ kind: "deposit", hash: "0x02" }] });
    assert.throws(() => landedOf(n, dir), /has no withdraw/);
    put(`pool-evm-buy-pays-revert.run.${n}.json`, { chain: n, pool: NEW.toUpperCase().replace("0X", "0x"), txs: [{ kind: "deposit", hash: "0x02" }, { kind: "withdraw", hash: "0x03" }] });
    assert.equal(landedOf(n, dir), "0x03");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the recordings name the kit's pins; the first set's recordings name the first set's pools", () => {
  assert.deepEqual(Object.fromEntries(A.good.pools.map((p) => [p.network, p.pool])), Object.fromEntries(NETWORKS.map((n) => [n, lower(evmPoolVenues()[n].pool)])));
  assert.deepEqual(Object.fromEntries(A.bad.pools.map((p) => [p.network, p.pool])), Object.fromEntries(A.good.pools.map((p) => [p.network, p.pool])));
  assert.deepEqual(Object.fromEntries(A.first_set.good.pools.map((p) => [p.network, p.pool])), evmPoolRecords(undefined, FIRST_SET));
  for (const p of A.good.pools) assert.equal(p.landed.hash, landedOf(p.network), `${p.network}: the good run's landed withdraw is landedOf's`);
});

test("the old-pool read fails: each landed withdraw went to the first set's pool, which the helper calls not_pool", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const lines = r.lines.filter((l) => l.startsWith("BAD"));
  for (const [i, n] of NETWORKS.entries()) {
    assert.ok(lines.some((l) => l.startsWith(`BAD [${n} landed]`)), n);
    assert.ok(A.bad.pools[i].landed.reads.every((x) => lower(x.to) === OLD_POOLS[i]), `${n}: read on the first set's pool`);
    assert.ok(lines.some((l) => l.includes(`[${n} landed_withdraw]`) && l.includes("not_pool")), n);
  }
  assert.equal(lines.length, 4, "nothing else in the old-pool run is off");
});

// The first set's recordings (card helper-evm-abi-tie, 6 Nov): judged on the pins they were made on.
const FIRST = evmPoolRecords(undefined, FIRST_SET);
const THEN = Object.fromEntries(Object.entries(evmPoolVenues()).map(([n, v]) => [n, Object.hasOwn(FIRST, n) ? { ...v, pool: FIRST[n] } : v]));
test("the first set's good run passes on its pins and fails on today's; its deployed helper's real run fails", () => {
  assert.equal(judge(A.first_set.good, { venues: THEN }).ok, true);
  assert.match(judge(A.first_set.good).lines.find((l) => l.includes("pools read")), /^BAD pools read/);
  const lines = judge(A.first_set.bad, { venues: THEN }).lines.filter((l) => l.startsWith("BAD"));
  for (const n of NETWORKS) {
    assert.ok(lines.some((l) => l.includes(`[${n} landed_withdraw]`) && l.includes("bad_shape")), n);
    assert.ok(lines.some((l) => l.includes(`[${n} three_argument]`) && l.includes("epoch_off")), n);
  }
  assert.equal(lines.length, 4, "nothing else in the deployed run is off");
});

const copy = () => structuredClone(A.good);
const bad = (run) => judge(run).lines.filter((l) => l.startsWith("BAD"));

test("the good run passes", () => {
  const r = judge(A.good);
  assert.deepEqual(bad(A.good), []);
  assert.equal(r.ok, true);
  assert.equal(A.good.constructed, true, "the good run's helper answers are marked constructed");
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

test("planted: a run whose reads name two helper commits fails, each full sha alone", () => {
  const mixed = copy();
  mixed.pools[1].reads.find((r) => r.asked === "landed_withdraw").headers["x-helper-commit"] = "f21d4be2cd160f6971170913178961f5674fd38e";
  assert.deepEqual(bad(mixed).map((l) => l.slice(0, 40)), ["BAD one X-Helper-Commit across the run: "]);
  const fee = copy();
  fee.pools[0].reads.find((r) => r.asked === "fee").headers["x-helper-commit"] = "0".repeat(40);
  assert.ok(bad(fee).some((l) => l.includes("one X-Helper-Commit")));
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
