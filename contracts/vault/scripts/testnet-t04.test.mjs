// SPDX-License-Identifier: Apache-2.0
// The pure parts of testnet-t04.mjs (card vault-testnet-t04): what settle's bytes cost, how a bounced payout, a refused
// settle and a reserve's return read in a tx answer, the run's accounts, and the record lines the money gate parses.
//   node --test contracts/vault/scripts/testnet-t04.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLive } from "../../../scripts/ci/money-gate.mjs";
import { BYTE, accountsOf, bounceProblems, growsAt, keyOf, recordLines, refusedProblems, settleCost, successProblems, transferredTo } from "./testnet-t04.mjs";

const TOKEN = "bf-usdc-20261101t022248.testnet"; // gitleaks:allow (a public account id)
const VAULT = "vault.bf-vt-20261102t071444.testnet";
const D = "a".repeat(64);
const ok = (executor, logs = []) => ({ outcome: { executor_id: executor, status: { SuccessValue: "" }, logs } });
const fail = (executor, text) => ({ outcome: { executor_id: executor, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: text } } } } }, logs: [] } });
const payout = (returned) => `EVENT_JSON:{"standard":"blindfill-vault","version":"1.0.0","event":"payout","data":[{"nullifier_hash":"1","delivered":"100000","returned":"${returned}"}]}`;
const bounced = (outcomes) => ({ status: { SuccessValue: "" }, final_execution_status: "FINAL", receipts_outcome: outcomes, receipts: [] });

test("a tree grows a level when a leaf lands at index 2^k", () => {
  assert.deepEqual([0n, 1n, 2n, 3n, 4n, 5n, 7n, 8n, 9n, 16n].map(growsAt), [false, true, true, false, true, false, false, true, false, true]);
  assert.equal(settleCost(9n, 7n), 389n * BYTE);
  assert.equal(settleCost(8n, 7n), (389n + 74n) * BYTE);
  assert.equal(settleCost(8n, 4n), (389n + 148n) * BYTE);
});

test("a bounce reads as exactly one failed receipt, the token's not-registered, and a payout returning the refund", () => {
  const good = bounced([ok(VAULT), ok(TOKEN), fail(TOKEN, "Smart contract panicked: The account b-1.x.testnet is not registered"), ok(VAULT, [payout(1900000)])]);
  assert.deepEqual(bounceProblems(good, { token: TOKEN, refunded: 1_900_000n }), []);
  assert.match(bounceProblems(good, { token: TOKEN, refunded: 1_900_001n }).join(), /returned 1900000, want 1900001/);
  const two = bounced([fail(TOKEN, "is not registered"), fail(TOKEN, "is not registered"), ok(VAULT, [payout(1900000)])]);
  assert.match(bounceProblems(two, { token: TOKEN, refunded: 1_900_000n }).join(), /2 failed receipts/);
  const onVault = bounced([fail(VAULT, "is not registered"), ok(VAULT, [payout(1900000)])]);
  assert.match(bounceProblems(onVault, { token: TOKEN, refunded: 1_900_000n }).join(), /not the token/);
  const other = bounced([fail(TOKEN, "The account doesn't have enough balance"), ok(VAULT, [payout(1900000)])]);
  assert.match(bounceProblems(other, { token: TOKEN, refunded: 1_900_000n }).join(), /not "not registered"/);
  const none = bounced([ok(VAULT), ok(TOKEN), ok(VAULT, [payout(0)])]);
  assert.match(bounceProblems(none, { token: TOKEN, refunded: 1_900_000n }).join(), /0 failed receipts/);
  assert.match(bounceProblems({ ...good, status: { Failure: {} } }, { token: TOKEN, refunded: 1_900_000n }).join(), /status/);
});

test("a refused settle reads as the vault's own failure with the code, nothing run elsewhere", () => {
  const S = "s-1.bf-vt-20261102t071444.testnet";
  const refused = { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: AlreadySettled" } } } } }, transaction: { signer_id: S }, receipts_outcome: [fail(VAULT, "AlreadySettled"), ok(S)] };
  assert.deepEqual(refusedProblems(refused, "AlreadySettled", VAULT), []);
  assert.match(refusedProblems(refused, "SpendInFlight", VAULT).join(), /want SpendInFlight/);
  assert.match(refusedProblems({ ...refused, status: { SuccessValue: "" } }, "AlreadySettled", VAULT).join(), /want a failure/);
  assert.match(refusedProblems({ ...refused, receipts_outcome: [...refused.receipts_outcome, ok(TOKEN)] }, "AlreadySettled", VAULT).join(), /receipts ran on/);
});

test("success means the tx and every receipt", () => {
  assert.deepEqual(successProblems({ status: { SuccessValue: "" }, final_execution_status: "FINAL", receipts_outcome: [ok(VAULT), ok(TOKEN)] }), []);
  assert.match(successProblems({ status: { SuccessValue: "" }, final_execution_status: "FINAL", receipts_outcome: [ok(VAULT), fail(TOKEN, "x")] }).join(), /failed/);
});

test("the payer's NEAR back is the vault's Transfers to it, never the system's gas refunds", () => {
  const r = {
    receipts: [
      { predecessor_id: VAULT, receiver_id: D, receipt: { Action: { actions: [{ Transfer: { deposit: "4000000000000000000000" } }] } } },
      { predecessor_id: "system", receiver_id: D, receipt: { Action: { actions: [{ Transfer: { deposit: "999" } }] } } },
      { predecessor_id: VAULT, receiver_id: "other.testnet", receipt: { Action: { actions: [{ Transfer: { deposit: "5" } }] } } },
    ],
  };
  assert.equal(transferredTo(r, D), 4_000_000_000_000_000_000_000n);
});

test("the run's accounts come from its seed: D implicit, B and S under the parent", () => {
  const seed = Buffer.alloc(32, 7);
  const a = accountsOf(seed, "bf-vt-20261102t071444.testnet");
  assert.match(a.D, /^[0-9a-f]{64}$/);
  assert.equal(a.D, keyOf(seed, "D").pub.toString("hex"));
  assert.match(a.B, /^b-[0-9a-f]{8}\.bf-vt-20261102t071444\.testnet$/);
  assert.match(a.S, /^s-[0-9a-f]{8}\.bf-vt-20261102t071444\.testnet$/);
  assert.notEqual(keyOf(seed, "D").pub.toString("hex"), keyOf(seed, "S").pub.toString("hex"));
  assert.notDeepEqual(accountsOf(Buffer.alloc(32, 8), "p.testnet"), accountsOf(seed, "p.testnet"));
});

test("the record's lines: the money gate reads every success as a Tx and no expected refusal as one", () => {
  const h = (c) => c.repeat(44);
  const record = {
    txs: [
      { step: "deposit1", hash: h("A"), signer: D, expect: "success" },
      { step: "bounce", hash: h("B"), signer: D, expect: "bounce" },
      { step: "settle", hash: h("C"), signer: "s-1.p.testnet", expect: "success" },
      { step: "settle", hash: h("E"), signer: "s-1.p.testnet", expect: "refused AlreadySettled" },
    ],
  };
  const md = ["CARD vault-testnet-t04 / live: PASS", ...recordLines(record), ""].join("\n");
  const parsed = parseLive(md, "vault-testnet-t04");
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.moneyPath, true);
  assert.deepEqual(parsed.txs.map((t) => t.hash), [h("A"), h("C")]);
});
