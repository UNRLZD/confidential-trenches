// node --test scripts/live-checks/delete-refund-readback.test.mjs: the live check replays a recorded run
// (delete-refund-readback.answers.json: every answer the three mainnet NEAR RPCs gave on 2026-11-01 at 04:30Z for the
// sweep tx Dw1nb…). The good answer replays it: PASS. The bad answers are made from it: the refund receipt sent by A
// instead of system, and the beneficiary's Transfer failing; each FAILs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, SWEEP } from "./delete-refund-readback.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "delete-refund-readback.answers.json"), "utf8"));
const REFUND = "GBkJTsykxGSHckvi8iCSwLwXiQScxBgbJGTmQp9VMXsB";
const PAYOUT = "9wEBNxb1a7uLm782NfH4eUyiYqAkRC37ArpT7feKxNgL";

// each request gets its recorded answer, changed by `patch`; a request the run never made is an error
function replay(answers, patch = () => {}) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} on ${url}`);
    const json = structuredClone(a.json);
    if (method === "EXPERIMENTAL_tx_status") patch(json.result);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: new Headers(), json: async () => json };
  };
}

test("the recording holds three mainnet RPCs' EXPERIMENTAL_tx_status answers for the sweep tx, signatures dropped", () => {
  const reads = ANSWERS.filter((a) => a.method === "EXPERIMENTAL_tx_status");
  assert.equal(new Set(reads.map((a) => a.url)).size, 3);
  for (const a of reads) {
    assert.equal(a.params.tx_hash, SWEEP.hash);
    assert.equal(a.json.result.final_execution_status, "FINAL");
    assert.deepEqual(a.json.result.receipts_outcome.find((o) => o.id === REFUND).outcome.status.Failure.ActionError.kind, { AccountDoesNotExist: { account_id: SWEEP.signer } });
  }
  assert.doesNotMatch(JSON.stringify(ANSWERS), /ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}/);
});

test("recorded good answer: the sweep reads ok on three RPCs: PASS", async () => {
  const r = await check({ fetchFn: replay(ANSWERS) });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], /^ok  the self-deleting sweep tx reads ok on 3 NEAR RPC\(s\): /);
});

test("recorded bad answer: the refund receipt sent by A, not system: FAIL", async () => {
  const r = await check({ fetchFn: replay(ANSWERS, (res) => void (res.receipts.find((x) => x.receipt_id === REFUND).predecessor_id = SWEEP.signer)) });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^BAD .* reads ok on 0 NEAR RPC\(s\): .*failed \(a receipt failed\) on https:\/\/archival-rpc\.mainnet\.fastnear\.com/);
});

test("recorded bad answer: the beneficiary's Transfer failed: FAIL", async () => {
  const fail = (res) => void (res.receipts_outcome.find((o) => o.id === PAYOUT).outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "x" } } } } });
  const r = await check({ fetchFn: replay(ANSWERS, fail) });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /failed \(a receipt failed\)/);
});

test("the CLI with --tx and no --signer is an error, exit 2", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "delete-refund-readback.mjs"), "--tx", SWEEP.hash], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /live-check delete-refund-readback: ERROR: usage: /);
});
