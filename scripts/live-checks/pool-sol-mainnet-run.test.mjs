// Replays pool-sol-mainnet-run.answers.json through the live check, and pool-sol-mainnet-run.record-answers.json (the
// devnet dry run of 2026-11-09 22:26-22:30Z, read on both devnet RPCs) through the record tool.
//   node --test scripts/live-checks/pool-sol-mainnet-run.test.mjs
// The live check: the mainnet pool before the owner's run passes with no --expect and fails with the run's counts (the
// run has not landed); the devnet pool after the dry run passes with them; a spent mark only one RPC lists fails.
// The record tool: from the window alone it finds the dry run's 8 signatures in order (U funded, deposit, a buy on
// pump's curve, the sell deposited back, two teardown frames, the exit's release and its payment to the fresh
// address), and the money gate's own parser reads its record with no problem; a window that ends before the exit fails.
// On the money gate's three mainnet RPCs (pool-sol-mainnet-run.answers.json good_mainnet_three_operators and
// pool-sol-mainnet-run.record-mainnet-answers.json, both recorded 2026-11-22 00:05-00:07Z): the check passes with
// PublicNode left out of the marks it serves only with a key, and fails on a third host whose pool differs; the record
// tool finds the owner's run with PublicNode, whose history does not reach it, listing none, and fails on a signature
// only one operator lists.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseLive, RPCS } from "../ci/money-gate.mjs";
import { RETRY } from "./provider-answer.mjs";
import { check } from "./pool-sol-mainnet-run.mjs";
import { CLUSTERS, facts, findRun, GATE_RPCS, NoAnswer, PUMP, PUMPSWAP, recordText } from "./pool-sol-mainnet-run.record.mjs";

RETRY.ms = 0;

const A = JSON.parse(readFileSync(new URL("./pool-sol-mainnet-run.answers.json", import.meta.url), "utf8"));
const R = JSON.parse(readFileSync(new URL("./pool-sol-mainnet-run.record-answers.json", import.meta.url), "utf8"));
const R3 = JSON.parse(readFileSync(new URL("./pool-sol-mainnet-run.record-mainnet-answers.json", import.meta.url), "utf8"));
const [MB, SVS, PN] = RPCS.solana;

/** Each recorded answer once, in the order read (a provider's 429 then its retry's answer, as recorded). */
function replay(answers) {
  const used = new Set();
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const i = answers.findIndex((x, j) => !used.has(j) && x.url === url && x.method === method && JSON.stringify(x.params) === JSON.stringify(params));
    used.add(i);
    const a = answers[i];
    if (!a) throw new Error(`no recorded answer for ${method} ${JSON.stringify(params).slice(0, 80)} on ${url}`);
    // a body as recorded (text), or the parsed one the first recordings kept (json; null: a body that did not parse)
    const text = a.text ?? (a.json === null ? "" : JSON.stringify(a.json));
    return { ok: a.status === 200, status: a.status, text: async () => text, headers: new Headers() };
  };
}
const live = (rec, answers = rec.answers) => check({ cluster: rec.cluster, expect: rec.expect, rpcs: rec.rpcs, fetchFn: replay(answers), sleep: async () => {} });

test("the mainnet pool before the run: PASS with no expectation", async () => {
  const r = await live(A.good_mainnet_pre_run);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(r.books, { deposits: 0n, releases: 0n, deposited: 0n, spent: 0n });
});

test("the mainnet pool before the run, held to the run's counts: FAIL on deposits and releases", async () => {
  const r = await live(A.bad_mainnet_run_not_landed);
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines.filter((l) => l.startsWith("FAIL")).map((l) => l.split(":")[0]), ["FAIL deposits", "FAIL releases"]);
});

test("the devnet pool after the dry run: PASS, its books whole", async () => {
  const r = await live(A.good_devnet_after_dry_run);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.books.deposited - r.books.spent, 73492430n - 11719560n);
});

test("planted on the devnet answer: a spent mark only one RPC lists: FAIL", async () => {
  const rec = A.good_devnet_after_dry_run;
  const answers = structuredClone(rec.answers);
  const scan = answers.find((a) => a.method === "getProgramAccounts" && a.params[1].filters[0].dataSize === 13 && a.url === rec.rpcs[1] && a.json?.result);
  scan.json.result.pop();
  const r = await live(rec, answers);
  assert.equal(r.ok, false);
  assert.match(r.lines.find((l) => l.startsWith("FAIL")), /^FAIL spent marks: .*the RPCs list different marks/);
});

const run = (until = R.until) => findRun({ cluster: R.cluster, since: R.since, until, fetchFn: replay(R.answers), sleep: async () => {} });

test("the record tool finds the dry run from its window alone, and the money gate parses its record", async () => {
  const r = await run();
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(r.steps.map((s) => s.step), ["U funded", "deposit", "buy on pump.fun's curve", "sell on pump.fun's curve, deposited back", "teardown", "teardown", "exit release", "exit to H1TxBoEp8hiU5fjoVgaqsJPKpmgS6bU6QdB5qTUhNdvn"]);
  const text = recordText(r, { buy1: "9.3", sell1: "9.1" });
  const p = parseLive(text, "pool-sol-mainnet-run");
  assert.deepEqual(p.problems, []);
  assert.equal(p.moneyPath, true);
  assert.deepEqual(p.txs.map((t) => t.hash), r.steps.map((s) => s.sig));
  assert.match(text, /buy on pump\.fun's curve: \S+, slot \d+, .*tap to filled 9\.3 s \(buy1, the trade box\)/);
  assert.match(text, /^Books: the run adds 2 deposits and 2 releases \(the live check's --expect deposits=2,releases=2\)\.$/m);
});

test("a window that ends before the exit: FAIL, no exit found", async () => {
  // the recorded answers hold every signature of the dry run; a window cut at 22:29Z keeps the buy and the sell only
  const r = await run(Date.parse("2026-11-09T22:29:00Z"));
  assert.equal(r.ok, false);
  assert.match(r.lines.find((l) => l.startsWith("FAIL")), /^FAIL an exit to an address: none/);
});

test("the RPCs are the money gate's own list, for both clusters: one list, imported", () => {
  assert.equal(GATE_RPCS.solana, RPCS.solana);
  assert.equal(GATE_RPCS["solana-devnet"], RPCS["solana-devnet"]);
  assert.equal(CLUSTERS.mainnet.rpcs, RPCS.solana);
  assert.equal(CLUSTERS.devnet.rpcs, RPCS["solana-devnet"]);
  // the three-operator recordings were read on the gate's list as it is
  assert.deepEqual(A.good_mainnet_three_operators.rpcs, RPCS.solana);
  assert.deepEqual(R3.rpcs, RPCS.solana);
});

test("three operators: the mainnet pool after the owner's run passes, PublicNode left out of the marks it serves only with a key", async () => {
  const r = await live(A.good_mainnet_three_operators);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(r.books, { deposits: 26n, releases: 14n, deposited: 690928900n, spent: 448381793n });
  assert.match(r.lines[0], /^PASS the pool \S+: the same bytes and lamports on api\.mainnet-beta\.solana\.com and public\.rpc\.solanavibestation\.com and solana-rpc\.publicnode\.com$/);
  const notes = r.lines.filter((l) => l.startsWith("note"));
  assert.equal(notes.length, 2);
  for (const n of notes) assert.match(n, /^note getProgramAccounts: solana-rpc\.publicnode\.com HTTP 403: served only with a key .*, left out$/);
});

test("three operators, planted: a third host whose pool differs fails; marks only one operator answers are inconclusive", async () => {
  const rec = A.good_mainnet_three_operators;
  const answers = structuredClone(rec.answers);
  // PublicNode's pool one lamport more, on both reads (the check reads the pool again once when the hosts differ: each
  // host's recorded pool answer is given a second time)
  const pools = answers.filter((x) => x.method === "getAccountInfo" && x.params[0] === CLUSTERS.mainnet.pool);
  for (const a of pools.filter((x) => x.url === PN)) {
    const j = JSON.parse(a.text);
    j.result.value.lamports += 1;
    a.text = JSON.stringify(j);
  }
  answers.push(...structuredClone(pools));
  const r = await live(rec, answers);
  assert.equal(r.ok, false);
  assert.match(r.lines.find((l) => l.startsWith("FAIL")), /^FAIL the pool \S+: the same bytes and lamports on /);
  // the vibe station's marks a 429 too: one operator answers them, never a pass
  const quiet = replay(rec.answers);
  const fetchFn = async (url, init) => (url === SVS && JSON.parse(init.body).method === "getProgramAccounts" ? { ok: false, status: 429, text: async () => "", headers: new Headers() } : quiet(url, init));
  await assert.rejects(check({ cluster: rec.cluster, rpcs: rec.rpcs, fetchFn, sleep: async () => {} }), (e) => e instanceof NoAnswer && /getProgramAccounts: fewer than two operators answered/.test(e.message));
});

const run3 = (answers = R3.answers) => findRun({ cluster: R3.cluster, since: R3.since, until: R3.until, rpcs: R3.rpcs, fetchFn: replay(answers), sleep: async () => {} });

test("three operators: the record tool finds the owner's mainnet run, PublicNode (no history that far) listing none", async () => {
  const r = await run3();
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.steps.length, 16);
  assert.match(r.lines[0], /^ok {3}the pool \S+: 10 \/ 10 \/ 0 signatures in the window on api\.mainnet-beta\.solana\.com \/ public\.rpc\.solanavibestation\.com \/ solana-rpc\.publicnode\.com$/);
  assert.equal(r.steps.filter((s) => s.step === "deposit").length, 1);
  assert.ok(r.steps.some((s) => s.step === "exit to 9udoXBjKXn9z4ENaW1pz9JqyiBmKTTwqxJLeoaH1wZJh"));
});

test("three operators, planted: a pool signature only one operator lists fails, PublicNode's empty list never standing in", async () => {
  const answers = structuredClone(R3.answers);
  const page = answers.find((x) => x.url === SVS && x.method === "getSignaturesForAddress" && x.params[0] === CLUSTERS.mainnet.pool);
  const j = JSON.parse(page.text);
  const dropped = j.result.find((x) => x.blockTime >= R3.since / 1000 && x.blockTime <= R3.until / 1000).signature;
  j.result = j.result.filter((x) => x.signature !== dropped);
  page.text = JSON.stringify(j);
  const r = await run3(answers);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], new RegExp(`^FAIL the pool \\S+: 10 / 9 / 0 signatures in the window on .*, on one only: ${dropped}$`));
});

test("a buy whose pool call invokes PumpSwap is named a buy on PumpSwap, so the record shows which venue ran", () => {
  // the dry run's recorded buy (tag 3 into pump's curve), its pump program key swapped for PumpSwap's
  const sig = "4SbhuLRoDemBchGkAQ3cLhHfvaJcAcpWK4z37cVnNdcttDatmpjcsXS8jzQD6kBaUQR1xDMBQE3QXbzgyvm9YTi3";
  const a = R.answers.find((x) => x.method === "getTransaction" && x.params[0] === sig && (x.text ?? "").includes('"result":{'));
  const tx = JSON.parse(a.text).result;
  assert.equal(facts(tx, CLUSTERS.devnet.program).venue, "pump.fun's curve");
  assert.equal(facts(tx, CLUSTERS.devnet.program).tag, 3);
  const swap = (k) => (k === PUMP ? PUMPSWAP : k);
  const moved = structuredClone(tx);
  moved.transaction.message.accountKeys = moved.transaction.message.accountKeys.map(swap);
  for (const side of ["writable", "readonly"]) if (moved.meta.loadedAddresses?.[side]) moved.meta.loadedAddresses[side] = moved.meta.loadedAddresses[side].map(swap);
  assert.equal(facts(moved, CLUSTERS.devnet.program).venue, "PumpSwap");
});
