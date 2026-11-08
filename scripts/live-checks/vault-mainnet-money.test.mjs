// node --test scripts/live-checks/vault-mainnet-money.test.mjs: the live check replays recorded reads of the mainnet
// vault on its two operators.
//   - vault-mainnet-money.bad-pre-run.answers.json: the vault read on 7 Nov 20:56Z, before any deposit (0 deposits,
//     0 spends), with a planted record of the run's shape (vault-mainnet-money.bad-pre-run.json): it must FAIL, on the
//     deposit row and the spend row only, on both operators.
//   - vault-mainnet-money.answers.json, read after the run of vault-mainnet-money.run.json: it must PASS. Both files
//     are written by the run (contracts/vault/scripts/mainnet-money.ts record, then this check with --record); until
//     then the good replay is skipped, never planted.
// More are made here from the recorded bad answer, each changing one read: a key on the vault, other code on it, two
// hosts of one operator, and a rate limit four times in a row (exit 2, never FAIL).
// The money record vault-mainnet-money.md, once committed, is the card's real-money proof: the money gate reads any
// record's testnet txs as "not real-money proof" and passes it, so this card's own rule is held here: that record
// parses under the card's key and every Tx in it is on NEAR mainnet (a testnet rehearsal's record has its own key,
// vault-mainnet-money-testnet).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseLive } from "../ci/money-gate.mjs";
import { check, main, RUN } from "./vault-mainnet-money.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const GOOD = path.join(HERE, "vault-mainnet-money.answers.json");

function replay(answers) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} ${params.method_name ?? params.request_type} on ${url}`);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
  };
}
const bad = () => load("vault-mainnet-money.bad-pre-run.answers.json");
const planted = load("vault-mainnet-money.bad-pre-run.json");
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const MD = path.join(HERE, "vault-mainnet-money.md");
/** Why `text` is not this card's real-money record: the money gate's parse under the card's key, then every Tx on near (mainnet). */
function mainnetRecordProblems(text) {
  const live = parseLive(text, "vault-mainnet-money");
  if (live === null) return ["no live record"];
  const p = [...live.problems];
  if (live.moneyPath !== true) p.push("not a money-path record");
  if (live.txs.length === 0) p.push("no Tx");
  for (const t of live.txs) if (t.chain !== "near") p.push(`Tx ${t.hash} is on ${t.chain}, not near (mainnet)`);
  return p;
}

test("the money record vault-mainnet-money.md, once written, lists NEAR mainnet txs only", () => {
  if (existsSync(MD)) assert.deepEqual(mainnetRecordProblems(readFileSync(MD, "utf8")), []);
  // the 05:18Z testnet rehearsal's record as the run first wrote it (line 1 the card's own key): refused, though the
  // money gate's parse takes it
  const original = readFileSync(path.join(HERE, "vault-mainnet-money-testnet.md"), "utf8").replace(/^CARD vault-mainnet-money-testnet \/ live: PASS\n/, "CARD vault-mainnet-money / live: PASS\n");
  assert.deepEqual(parseLive(original, "vault-mainnet-money").problems, [], "the gate's parse takes the old header");
  const p = mainnetRecordProblems(original);
  assert.equal(p.length, 6, p.join("\n"));
  assert.ok(p.every((x) => / is on near-testnet, not near \(mainnet\)$/.test(x)), p.join("\n"));
  // one testnet Tx among mainnet ones is refused; mainnet only passes
  const mainnet = original.replace(/^Tx: near-testnet /gm, "Tx: near ");
  assert.deepEqual(mainnetRecordProblems(mainnet), []);
  assert.equal(mainnetRecordProblems(mainnet.replace(/^Tx: near /m, "Tx: near-testnet ")).length, 1);
});

test("the recorded run passes", { skip: existsSync(RUN) && existsSync(GOOD) ? false : "the run has not landed: vault-mainnet-money.run.json and its answers are written by the run" }, async () => {
  const r = await check({ run: JSON.parse(readFileSync(RUN, "utf8")), fetchFn: replay(JSON.parse(readFileSync(GOOD, "utf8"))) });
  assert.deepEqual(bads(r), []);
  assert.equal(r.ok, true);
});

test("the vault read before any deposit fails, on the deposit and the spend row only, on both operators", async () => {
  const r = await check({ run: planted, fetchFn: replay(bad()) });
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 4, bads(r).join("\n"));
  assert.equal(bads(r).filter((l) => /one deposit row for the run's precommitment .*: none of 0/.test(l)).length, 2, bads(r).join("\n"));
  assert.equal(bads(r).filter((l) => /one spend row for the note's nullifier .*: none of 0/.test(l)).length, 2, bads(r).join("\n"));
  assert.ok(r.lines.some((l) => /^ok  .* key list is \[\] on https:\/\/near\.drpc\.org/.test(l)), r.lines.join("\n"));
});

test("a key on the vault fails", async () => {
  const answers = bad().map((a) => (a.params.request_type === "view_access_key_list" ? { ...a, json: { ...a.json, result: { ...a.json.result, keys: [{ public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 0, permission: "FullAccess" } }] } } } : a));
  const r = await check({ run: planted, fetchFn: replay(answers) });
  assert.equal(bads(r).filter((l) => /key list is \[\]/.test(l)).length, 2, bads(r).join("\n"));
});

test("other code on the vault fails", async () => {
  const answers = bad().map((a) => (a.params.request_type === "view_account" ? { ...a, json: { ...a.json, result: { ...a.json.result, code_hash: "11111111111111111111111111111111" } } } : a));
  const r = await check({ run: planted, fetchFn: replay(answers) });
  assert.equal(bads(r).filter((l) => /code hash is the record's/.test(l)).length, 2, bads(r).join("\n"));
});

test("a run record on another vault fails", async () => {
  const r = await check({ run: { ...planted, vault: "vault-test.confidential.unrlzd.near" }, fetchFn: replay(bad()) });
  assert.ok(bads(r).some((l) => /the run record names the mainnet vault/.test(l)), bads(r).join("\n"));
});

test("two hosts of one operator are refused", async () => {
  const r = await check({ run: planted, fetchFn: replay(bad()), rpcs: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"] }); // near-rpc-operators: one operator (planted: the same-operator case this check must refuse)
  assert.equal(r.ok, false);
  assert.match(bads(r)[0], /only 1 operator/);
});

test("four rate limits in a row exit 2, not 1, with no FAIL line", async () => {
  const waits = [];
  const out = [];
  const limit = { id: 1, jsonrpc: "2.0", error: { message: "You reached Public endpoint rate limit, please upgrade to paid plan", code: 15 } };
  const inner = replay(bad());
  const fetchFn = async (url, init) => (url === "https://near.drpc.org" ? { ok: false, status: 429, json: async () => limit } : inner(url, init));
  const code = await main(["--run", path.join(HERE, "vault-mainnet-money.bad-pre-run.json")], { fetchFn, sleep: async (ms) => void waits.push(ms), log: (l) => out.push(l), err: (l) => out.push(l) });
  assert.equal(code, 2);
  assert.deepEqual(waits, [2000, 4000, 8000]);
  assert.ok(!out.some((l) => /FAIL|BAD/.test(l)), out.join("\n"));
});

// The recorded pre-run reads with the run's rows added (derived, as the cases above: never an answers file): the
// deposits, spends and leaves pages answer the planted run's deposit row, spend row and both leaves.
function withRun(run, spend = {}) {
  const rows = {
    deposits: [{ index: 0, precommitment: run.deposit.precommitment, depositor: run.accounts.U, value: run.deposit.value, label: run.deposit.label, leaf_index: Number(run.deposit.leaf_index) }],
    spends: [{ index: 0, nullifier_hash: run.withdraw.nullifier_hash, recipient: run.accounts.to, withdrawn: run.withdraw.withdrawn, fee: run.withdraw.relay_fee, payer: run.accounts.R, status: "paid", refund_value: "0", new_leaf_index: Number(run.withdraw.change_leaf_index), ...spend }],
    leaves: [run.deposit.commitment, run.withdraw.change_commitment],
  };
  return bad().map((a) => (a.params.request_type === "call_function" && rows[a.params.method_name] ? { ...a, json: { ...a.json, result: { ...a.json.result, result: [...Buffer.from(JSON.stringify(rows[a.params.method_name]))] } } } : a));
}
const NO_CHANGE = { ...planted, deposit: { ...planted.deposit, commitment: "11" }, withdraw: { ...planted.withdraw, change_commitment: "22" } };

test("a no-change run passes: withdrawn is the whole note, the named account got withdrawn - fee (payout.rs row 13)", async () => {
  assert.equal(planted.withdraw.withdrawn, planted.deposit.value);
  const r = await check({ run: NO_CHANGE, fetchFn: replay(withRun(NO_CHANGE)) });
  assert.deepEqual(bads(r), []);
  assert.equal(r.ok, true);
  for (const status of ["settled"]) assert.equal((await check({ run: NO_CHANGE, fetchFn: replay(withRun(NO_CHANGE, { status })) })).ok, true);
  for (const spend of [{ status: "refund_pending" }, { status: "settled", refund_value: "1" }, { recipient: "other.near" }]) assert.equal((await check({ run: NO_CHANGE, fetchFn: replay(withRun(NO_CHANGE, spend)) })).ok, false, JSON.stringify(spend));
});

test("a run that leaves change (change = fee), a fee above the vault's backstop, or a note under the minimum fails on the record line", async () => {
  const cases = [
    { ...NO_CHANGE, withdraw: { ...NO_CHANGE.withdraw, withdrawn: "4700000" } }, // change = fee: the old rule passed it
    { ...NO_CHANGE, withdraw: { ...NO_CHANGE.withdraw, withdrawn: "4000000" } },
    { ...NO_CHANGE, withdraw: { ...NO_CHANGE.withdraw, relay_fee: "2500001" } }, // fee * 10,000 > withdrawn * MAX_RELAY_FEE_BPS
    { ...NO_CHANGE, deposit: { ...NO_CHANGE.deposit, value: "900000" }, withdraw: { ...NO_CHANGE.withdraw, withdrawn: "900000" } },
  ];
  for (const run of cases) {
    const r = await check({ run, fetchFn: replay(withRun(run)) });
    assert.ok(bads(r).some((l) => /the record: U NEAR-implicit, the named account/.test(l)), `${JSON.stringify(run.withdraw)}: ${bads(r).join("\n")}`);
  }
  // the fee at the backstop passes
  const edge = { ...NO_CHANGE, withdraw: { ...NO_CHANGE.withdraw, relay_fee: "2500000" } };
  assert.equal((await check({ run: edge, fetchFn: replay(withRun(edge)) })).ok, true);
});

test("a run record that pays the vault, the token, intents.near, U, the fee recipient or the relayer fails on the record line", async () => {
  const { U, F, R } = planted.accounts;
  for (const to of [planted.vault, planted.asset, "intents.near", U, F, R, undefined]) {
    const run = { ...NO_CHANGE, accounts: { ...NO_CHANGE.accounts, to } };
    const r = await check({ run, fetchFn: replay(withRun(run)) });
    assert.ok(bads(r).some((l) => /the record: U NEAR-implicit, the named account/.test(l)), `${to}: ${bads(r).join("\n")}`);
  }
  const arming = { ...NO_CHANGE, accounts: { ...NO_CHANGE.accounts, to: undefined, A: "0".repeat(63) + "1" } };
  assert.equal((await check({ run: arming, fetchFn: replay(withRun(arming)) })).ok, false);
});
