// node --test scripts/live-checks/helper-mainnet-vault-env.test.mjs: the live check replays recorded runs
// (helper-mainnet-vault-env.answers.json). good: apps/helper at card/vault-mainnet-record run with node src/server.ts,
// mainnet carried for the v1 record's vault, with a throwaway implicit relayer holding its own key: PASS. bad_vault_test:
// the earlier good, made for vault-test before the v1 record: FAIL against today's record. bad_deployed: the
// deployed helper (af75100a, before the cutover) read for today's record, mainnet not carried: FAIL. bad_other_vault:
// main before this card (358d8f4, no pin) run the same way with WITHDRAW_VAULT_MAINNET naming vault-test, a real
// mainnet vault, read for today's record: the record's probe bad_proof, FAIL. Made from the good run: an
// implicit relayer without its own key, a relayer under the floor, absent, read on one operator or at two blocks, the
// two RPCs disagreeing, a fee answer that holds, a send: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { vaultWithdrawYocto } from "../../packages/kit/src/index.ts";
import { withdrawFloor, MAINNET_VAULT } from "../../apps/helper/src/withdraw/send.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { asks, decoyFor, implicitKey, judge, loadRecord, probe, recordFile, RELAYER_FLOOR_YOCTO } from "./helper-mainnet-vault-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-mainnet-vault-env.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (run, name, f) => ({ ...run, reads: run.reads.map((x) => (x.asked === name ? f(x) : x)) });
const chain = (run, f) => ({ ...run, chain: f(structuredClone(run.chain)) });
// the USDC contract's storage_balance_bounds().min (read on mainnet: min = max = 1250000000000000000000)
const USDC_MIN = 1_250_000_000_000_000_000_000n;

test("recorded good run: the record's vault past check 2 (bad_fee_recipient), another vault bad_proof, the relayer on two RPCs: PASS", () => {
  const g = judge(A.good);
  assert.equal(g.ok, true, g.lines.join("\n"));
  assert.ok(g.lines.includes("ok  the record's vault: 400 bad_fee_recipient (want 400 bad_fee_recipient)"), g.lines.join("\n"));
  assert.ok(g.lines.includes("ok  another vault: 400 bad_proof (want 400 bad_proof)"), g.lines.join("\n"));
  assert.equal(A.good.reads.length, asks(loadRecord()).length);
  // the replay judges the record the run was made with, and that is today's record
  assert.deepEqual(A.good.record, loadRecord());
});

test("recorded bad runs, judged against today's record: the deployed helper not carrying mainnet, and a helper carrying another real vault: FAIL", () => {
  const rec = loadRecord();
  for (const k of ["bad_deployed", "bad_other_vault"]) assert.deepEqual(A[k].record, rec, `${k} was read for today's record`);
  const d = judge(A.bad_deployed, rec);
  assert.equal(d.ok, false);
  assert.deepEqual(bad(d), [
    "BAD fee: 404 not_found (want 200)",
    "BAD fee: relayer undefined, fee recipient undefined (neither the vault nor intents.near)",
    "BAD the record's vault: 400 bad_shape (want 400 bad_fee_recipient)",
    "BAD another vault: 400 bad_shape (want 400 bad_proof)",
    "BAD the relayer account on two mainnet RPCs: the fee answer names no relayer account",
  ]);
  // the other vault is vault-test, a real mainnet vault and the decoy for today's record: the helper carrying it lets the
  // decoy probe past check 2 and refuses the record's at check 2
  assert.notEqual(rec.account_id, "vault-test.confidential.unrlzd.near");
  assert.equal(decoyFor(rec), "vault-test.confidential.unrlzd.near");
  const o = judge(A.bad_other_vault, rec);
  assert.equal(o.ok, false);
  assert.deepEqual(bad(o), ["BAD the record's vault: 400 bad_proof (want 400 bad_fee_recipient)", "BAD another vault: 400 bad_fee_recipient (want 400 bad_proof)"]);
});

test("recorded bad run: the good run made for vault-test before the v1 record FAILs against today's record", () => {
  assert.equal(judge(A.bad_vault_test).ok, true, "it passed for the record it was made with");
  const v = judge(A.bad_vault_test, loadRecord());
  assert.equal(v.ok, false);
  assert.deepEqual(bad(v), [`BAD the deploy record's vault: ${loadRecord().account_id} (scope ${loadRecord().scope.slice(0, 12)}...)`]);
});

test("made from the good run: each break of the relayer account or the answers FAILs", () => {
  const g = A.good;
  const at = (c, f) => {
    c.at.forEach(f);
    return c;
  };
  // under the floor, on both RPCs
  const low = (RELAYER_FLOOR_YOCTO - 1n).toString();
  assert.equal(judge(chain(g, (c) => at(c, (a) => (a.view_account.amount = low)))).ok, false);
  // absent: UNKNOWN_ACCOUNT on both
  assert.equal(judge(chain(g, (c) => at(c, (a) => (a.view_account = { error: "UNKNOWN_ACCOUNT" })))).ok, false);
  // only function-call keys
  assert.equal(judge(chain(g, (c) => at(c, (a) => a.keys.keys.forEach((k) => (k.access_key.permission = { FunctionCall: { allowance: null, receiver_id: "x.near", method_names: [] } }))))).ok, false);
  // the two RPCs disagree on the amount, or answer at two blocks
  assert.equal(judge(chain(g, (c) => ((c.at[1].view_account.amount = (BigInt(c.at[0].view_account.amount) + 1n).toString()), c))).ok, false);
  assert.equal(judge(chain(g, (c) => ((c.at[1].block.hash = "11111111111111111111111111111111"), c))).ok, false);
  // one operator twice, or an RPC off the pair
  assert.equal(judge(chain(g, (c) => ((c.at[1].rpc = c.at[0].rpc), c))).ok, false);
  assert.equal(judge(chain(g, (c) => ((c.at[1].rpc = "rpc.example.com"), c))).ok, false);
  // read for another account than the fee answer names
  assert.equal(judge(chain(g, (c) => ((c.account = "other.near"), c))).ok, false);
  // a fee answer that holds (503), a send, another origin, no commit, a missing read
  assert.equal(judge(edit(g, "fee", (x) => ({ ...x, status: 503, body: JSON.stringify({ error: { code: "upstream" } }) }))).ok, false);
  assert.equal(judge(edit(g, "the record's vault", (x) => ({ ...x, status: 200, body: JSON.stringify({ tx_hash: "4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL", state: "submitted" }) }))).ok, false);
  assert.equal(judge(edit(g, "another vault", (x) => ({ ...x, headers: { ...x.headers, "access-control-allow-origin": "*" } }))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => ({ ...x, headers: { ...x.headers, "x-helper-commit": "main" } }))).ok, false);
  assert.equal(judge({ ...g, reads: g.reads.filter((x) => x.asked !== "another vault") }).ok, false);
  // a helper carrying another vault that exists: the record-vault probe bad_proof, the other bad_fee_recipient
  const flip = (name, code) => (x) => (x.asked === name ? { ...x, body: JSON.stringify({ error: { code } }) } : x);
  const swapped = { ...g, reads: g.reads.map(flip("the record's vault", "bad_proof")).map(flip("another vault", "bad_fee_recipient")) };
  assert.equal(judge(swapped).ok, false);
  // a fee recipient that is the vault (the probe's own, so check 3 would pass it) or intents.near
  for (const f of [loadRecord().account_id, "intents.near"]) assert.equal(judge(edit(g, "fee", (x) => ({ ...x, body: JSON.stringify({ ...JSON.parse(x.body), fee_recipient: f }) }))).ok, false, f);
  // a run made for another record does not pass against today's
  assert.equal(judge(g, { ...loadRecord(), account_id: "vault-test2.confidential.unrlzd.near" }).ok, false);
});

test("an implicit relayer passes only holding the full-access key its id names", () => {
  const g = A.good;
  const id = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de"; // a public implicit account
  const own = implicitKey(id);
  const other = "ed25519:WHHJ4Rmp2dzkkWtE5UuNkeEnw6JCnXLPrnXV6fiQhhh";
  const as = (key) => {
    const run = edit(g, "fee", (x) => ({ ...x, body: JSON.stringify({ ...JSON.parse(x.body), relayer_account: id }) }));
    return chain(run, (c) => {
      c.account = id;
      c.at.forEach((a) => (a.keys.keys = [{ access_key: { nonce: 1, permission: "FullAccess" }, public_key: key }]));
      return c;
    });
  };
  const withOwn = judge(as(own));
  assert.equal(withOwn.ok, true, withOwn.lines.join("\n"));
  const withOther = judge(as(other));
  assert.equal(withOther.ok, false);
  assert.ok(bad(withOther).some((l) => l.includes("an implicit account holds the key its id names")), bad(withOther).join("\n"));
  // the key its id names, as the chain holds it: view_access_key(98793cd9..., ed25519:BGCC...m9HX) on
  // rpc.mainnet.fastnear.com answered FullAccess at block 223428593 (2026-11-07 06:28Z); leading zero bytes are 1s
  assert.equal(own, "ed25519:BGCCDDHfysuuVnaNVtEhhqeT4k9Muyem3Kpgq2U1m9HX");
  assert.equal(implicitKey(`${"00".repeat(31)}01`), `ed25519:${"1".repeat(31)}2`);
});

test("the floor is the helper's: send.ts withdrawFloor at USDC's minimum register_deposit and a fee above 0", () => {
  assert.equal(RELAYER_FLOOR_YOCTO, withdrawFloor(vaultWithdrawYocto(USDC_MIN, 1n, true)));
});

test("the probes: the record's vault is the helper's pin, and the two bodies differ only in the context", () => {
  const rec = loadRecord();
  assert.equal(rec.account_id, MAINNET_VAULT);
  assert.notEqual(decoyFor(rec), rec.account_id);
  const [, mine, other] = asks(rec).map((a) => (a.body === undefined ? null : JSON.parse(a.body)));
  assert.deepEqual(mine.withdrawal, other.withdrawal);
  assert.equal(mine.withdrawal.fee_recipient, rec.account_id, "a fee recipient the helper never carries (check 8)");
  assert.deepEqual(mine.public_signals.slice(0, 7), other.public_signals.slice(0, 7));
  assert.notEqual(mine.public_signals[7], other.public_signals[7]);
  assert.equal(JSON.stringify(probe(rec.account_id, rec.scope, undefined, rec.account_id)), JSON.stringify(mine));
  for (const a of asks(rec)) for (const [s] of a.want) assert.ok(s === 200 ? a.method === "GET" : s >= 400 && s < 500, a.name);
});

test("the record by the helper's pin rule: mainnet-v1.json's once it exists, else mainnet-test.json's", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hmve-rec-"));
  const rec = (id) => JSON.stringify({ network: "mainnet", account_id: id, scope: "7" });
  writeFileSync(path.join(dir, "mainnet-test.json"), rec("vault-test.confidential.unrlzd.near"));
  assert.equal(path.basename(recordFile(dir)), "mainnet-test.json");
  assert.equal(loadRecord(recordFile(dir)).account_id, "vault-test.confidential.unrlzd.near");
  writeFileSync(path.join(dir, "mainnet-v1.json"), rec("vault.confidential.unrlzd.near"));
  assert.equal(path.basename(recordFile(dir)), "mainnet-v1.json");
  assert.equal(loadRecord(recordFile(dir)).account_id, "vault.confidential.unrlzd.near");
});

test("the decoy is chosen at run time to differ from the record's vault, its probe's vault signal differs from the record's, and the recorded good run's other-vault line names it", () => {
  for (const id of ["vault.confidential.unrlzd.near", "vault-test.confidential.unrlzd.near", "other.near"]) {
    const record = { account_id: id, scope: "7" };
    assert.notEqual(decoyFor(record), id, id);
    const [, mine, other] = asks(record).map((a) => (a.body === undefined ? null : JSON.parse(a.body)));
    assert.notEqual(mine.public_signals[7], other.public_signals[7], id);
  }
  const g = A.good;
  const r = judge(g);
  assert.ok(r.lines.some((l) => l.startsWith("ok ") && l.includes(`another vault ${decoyFor(g.record)}: not the record's`)), r.lines.join("\n"));
});
