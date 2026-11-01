// node --test scripts/live-checks/vault-skeleton.test.mjs: the live check replays recorded runs on NEAR testnet's two
// RPCs. The good answer (vault-skeleton.answers.json, the deployed skeleton) must PASS. The bad answers must FAIL:
//   - vault-skeleton.bad-key.answers.json: an ordinary testnet account with one full-access key and no code (the
//     deploy's own parent, bf-vs-20261101t005509.testnet);
//   - vault-skeleton.bad-import.answers.json: a deployed wasm that imports promise_batch_action_add_key_with_full_access
//     (the account `testnet`, NEAR testnet's account registrar, 151,460 B; read 2026-11-01 00:56Z).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, wasmProblems, DEPLOYMENT } from "./vault-skeleton.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));

// each request gets its recorded answer; a request the run never made is an error
function replay(answers) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} ${params.request_type} on ${url}`);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
  };
}
const accountOf = (answers) => answers[0].params.account_id;

test("recorded good answer: the deployed skeleton, keys [] on two RPCs, its code and config(): PASS", async () => {
  const answers = load("vault-skeleton.answers.json");
  assert.equal(accountOf(answers), deployment.account_id);
  assert.equal(new Set(answers.map((a) => a.url)).size, 2);
  const r = await check({ deployment, fetchFn: replay(answers) });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 12);
  assert.equal(r.lines.filter((l) => /key list is \[\] on .*: 0 key\(s\)/.test(l) && l.startsWith("ok ")).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  code sha256 ${deployment.wasm_sha256} equals`)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  config() answers on `) && l.includes(`asset ${deployment.asset}`)).length, 2);
});

test("recorded bad answer: an ordinary account with one full-access key: FAIL on its key list", async () => {
  const answers = load("vault-skeleton.bad-key.answers.json");
  const r = await check({ deployment, account: accountOf(answers), fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.equal(r.lines.filter((l) => /^BAD \S+ key list is \[\] on .*: 1 key\(s\) \(FullAccess\)/.test(l)).length, 2, r.lines.join("\n"));
});

test("recorded bad answer: a wasm importing promise_batch_action_add_key_with_full_access: FAIL on its imports", async () => {
  const answers = load("vault-skeleton.bad-import.answers.json");
  const r = await check({ deployment, account: accountOf(answers), fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  const bad = r.lines.filter((l) => l.startsWith("BAD no banned import on ") && l.includes("promise_batch_action_add_key_with_full_access"));
  assert.equal(bad.length, 2, r.lines.join("\n"));
});

test("the same answers with a third of the RPCs gone: FAIL (two RPCs are required)", async () => {
  const answers = load("vault-skeleton.answers.json");
  const one = [...new Set(answers.map((a) => a.url))].slice(0, 1);
  const r = await check({ deployment, fetchFn: replay(answers), rpcs: one });
  assert.equal(r.ok, false);
});

// a minimal wasm: one import env.<imp> of function type 0, one function export <exp>
function tinyWasm(imp, exp) {
  const name = (s) => [s.length, ...Buffer.from(s)];
  const section = (id, body) => [id, body.length, ...body];
  const type = section(1, [1, 0x60, 0, 0]);
  const imports = section(2, [1, ...name("env"), ...name(imp), 0, 0]);
  const funcs = section(3, [1, 0]);
  const exports = section(7, [1, ...name(exp), 0, 1]);
  const code = section(10, [1, 2, 0, 0x0b]);
  return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...imports, ...funcs, ...exports, ...code]);
}

test("the wasm rules: banned imports, promise imports outside the seven, exports outside 2.5.7", () => {
  assert.deepEqual(wasmProblems(tinyWasm("promise_batch_action_add_key_with_full_access", "config")).banned, ["promise_batch_action_add_key_with_full_access"]);
  assert.deepEqual(wasmProblems(tinyWasm("promise_batch_action_deploy_global_contract_by_account_id", "config")).banned, ["promise_batch_action_deploy_global_contract_by_account_id"]);
  assert.deepEqual(wasmProblems(tinyWasm("promise_create", "config")).promises, ["promise_create"]);
  assert.deepEqual(wasmProblems(tinyWasm("promise_batch_then", "new")).exports, ["new"]);
  const clean = wasmProblems(tinyWasm("promise_result", "totals"));
  assert.deepEqual([clean.banned, clean.promises, clean.exports], [[], [], []]);
  assert.throws(() => wasmProblems(Buffer.from("not wasm")), /not a wasm module/);
});
