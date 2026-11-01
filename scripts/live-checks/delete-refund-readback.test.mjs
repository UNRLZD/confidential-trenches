// node --test scripts/live-checks/delete-refund-readback.test.mjs: the live check replays a recorded run
// (delete-refund-readback.answers.json: every answer the three NEAR testnet RPCs gave on 2026-11-01 at about 15:00Z for
// the standard sweep, Transfer EamCGz2G… and its account 69a11523…, first as read, then with dRPC's tx reads answered
// UNKNOWN_TRANSACTION so FastNEAR's light-client proof answers are kept too). The good answers replay it: PASS, as read
// and on the proof alone. The bad answers are made from it: the account still present on dRPC, a receipt of the
// Transfer failed; each FAILs. The old style (one DeleteAccount tx) is refused in scripts/ci/money-gate.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, SWEEP } from "./delete-refund-readback.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "delete-refund-readback.answers.json"), "utf8"));
const DRPC = "https://near-testnet.drpc.org";
const MISSING = { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, code: -32000 } };
const sleep = async () => {};

// each request gets its recorded answer, changed by `patch(url, method, json)` (which may return a whole new answer); a
// request the run never made is an error
function replay(answers, patch = () => {}) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} on ${url}`);
    const json = patch(url, method, structuredClone(a.json)) ?? structuredClone(a.json);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: new Headers(), json: async () => json };
  };
}
const dropDrpc = (url, method) => (url === DRPC && method === "EXPERIMENTAL_tx_status" ? MISSING : undefined);

test("the recording holds the sweep Transfer on three testnet RPCs with every receipt a success, the account UNKNOWN_ACCOUNT on each, signatures dropped", () => {
  const reads = ANSWERS.filter((a) => a.method === "EXPERIMENTAL_tx_status");
  assert.equal(new Set(reads.map((a) => a.url)).size, 3);
  for (const a of reads) {
    assert.equal(a.params.tx_hash, SWEEP.hash);
    assert.deepEqual(a.json.result.transaction.actions.map((x) => Object.keys(x)), [["Transfer"]]);
    for (const o of a.json.result.receipts_outcome) assert.ok("SuccessValue" in o.outcome.status, o.id);
  }
  const views = ANSWERS.filter((a) => a.method === "query");
  assert.equal(new Set(views.map((a) => a.url)).size, 3);
  for (const a of views) assert.equal(a.json.error.cause.name, "UNKNOWN_ACCOUNT");
  assert.ok(ANSWERS.some((a) => a.method === "EXPERIMENTAL_light_client_proof"));
  assert.doesNotMatch(JSON.stringify(ANSWERS), /ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}/);
});

test("recorded good answer: the Transfer reads ok on three RPCs and the account is gone: PASS", async () => {
  const r = await check({ fetchFn: replay(ANSWERS), sleep });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], /^ok  the sweep Transfer reads ok on 3 RPC\(s\), proven 0, the account gone 1: /);
});

test("recorded good answer, dRPC past its window: the Transfer passes on its light-client proof alone: PASS", async () => {
  const r = await check({ fetchFn: replay(ANSWERS, dropDrpc), sleep });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], /proven 1, the account gone 1: .*PROVEN ON near-testnet\.drpc\.org: near-testnet EamCGz2G/);
});

test("recorded bad answer: the account still present on dRPC: FAIL", async () => {
  const present = (url, method, json) => (url === DRPC && method === "query" ? { jsonrpc: "2.0", id: 1, result: { amount: "2000000000000000000000", locked: "0", storage_usage: 182 } } : json);
  for (const patch of [present, (u, m, j) => dropDrpc(u, m) ?? present(u, m, j)]) {
    const r = await check({ fetchFn: replay(ANSWERS, patch), sleep });
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /^BAD .*is not gone: .*present \(holds 2000000000000000000000 yocto\) on https:\/\/near-testnet\.drpc\.org/);
  }
});

test("recorded bad answer: a receipt of the Transfer failed: FAIL", async () => {
  const fail = (url, method, json) => {
    if (method === "EXPERIMENTAL_tx_status") json.result.receipts_outcome.at(-1).outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: SWEEP.account } } } } };
    return json;
  };
  const r = await check({ fetchFn: replay(ANSWERS, fail), sleep });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /failed \(a receipt failed\)/);
});

test("the CLI with --tx and no --chain or --account is an error, exit 2", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "delete-refund-readback.mjs"), "--tx", SWEEP.hash], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /live-check delete-refund-readback: ERROR: usage: /);
});
