// node --test scripts/live-checks/vault-skeleton.test.mjs: the live check replays recorded runs on NEAR testnet's two
// RPCs. The good answer (vault-skeleton.answers.json, the deployed skeleton) must PASS. The bad answers must FAIL:
//   - vault-skeleton.bad-key.answers.json: an ordinary testnet account with one full-access key and no code (the
//     deploy's own parent, bf-vs-20261101t012200.testnet);
//   - vault-skeleton.bad-import.answers.json: a deployed wasm that imports promise_batch_action_add_key_with_full_access
//     (the account `testnet`, NEAR testnet's account registrar, 151,460 B; read 2026-11-01 01:23Z);
//   - vault-skeleton.bad-asset.answers.json: a build without --features testnet as it would read once deployed, its
//     config() naming mainnet USDC and version "... mainnet". It is the good answer with only config()'s result
//     replaced by a mainnet build's, so it is made from a real read, not a real deploy: the fixed deploy script refuses
//     to send such a wasm (the test below). The check must FAIL it even when the deployment record names the same
//     mainnet id, since the asset is pinned in the check, never copied from the record.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, wasmProblems, networkProblems, DEPLOYMENT, TESTNET_USDC } from "./vault-skeleton.mjs";

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

const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

test("the pinned testnet asset is Circle's testnet USDC", () => {
  assert.equal(TESTNET_USDC, "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af");
  assert.equal(deployment.asset, TESTNET_USDC);
});

test("recorded bad answer: a mainnet build's config() (mainnet USDC), with a record that copied it: FAIL on config()", async () => {
  const answers = load("vault-skeleton.bad-asset.answers.json");
  const cfgs = answers.filter((a) => a.params.method_name === "config").map((a) => JSON.parse(Buffer.from(a.json.result.result).toString("utf8")));
  assert.equal(cfgs.length, 2);
  for (const c of cfgs) assert.equal(c.asset, MAINNET_USDC);
  const r = await check({ deployment: { ...deployment, asset: MAINNET_USDC }, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.equal(r.lines.filter((l) => l.startsWith("BAD config() answers on ") && l.includes(`asset ${MAINNET_USDC}`)).length, 2, r.lines.join("\n"));
});

// a wasm whose data holds the given strings: the tiny module below plus a custom section
function wasmWith(...strings) {
  const body = Buffer.from(strings.join("\0"));
  const name = Buffer.from([4, ...Buffer.from("data")]);
  const len = name.length + body.length;
  assert.ok(len < 16384);
  return Buffer.concat([tinyWasm("promise_result", "config"), Buffer.from([0, (len & 0x7f) | 0x80, len >> 7]), name, body]);
}

test("the network rule: a testnet build names Circle's testnet USDC and testnet, never mainnet USDC or mainnet", () => {
  assert.deepEqual(networkProblems(wasmWith(TESTNET_USDC, "testnet")), []);
  assert.equal(networkProblems(wasmWith(MAINNET_USDC, "mainnet")).length, 4);
  assert.ok(networkProblems(wasmWith(TESTNET_USDC, MAINNET_USDC, "testnet")).some((p) => p.includes(MAINNET_USDC)));
  assert.ok(networkProblems(wasmWith(TESTNET_USDC, "testnet", "mainnet")).some((p) => p.includes('"mainnet"')));
});

test("the deploy script refuses a mainnet build before it sends anything", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vault-skeleton-"));
  const f = path.join(dir, "mainnet.wasm");
  writeFileSync(f, wasmWith(MAINNET_USDC, "mainnet"));
  const r = spawnSync(process.execPath, [path.join(HERE, "../../contracts/vault/scripts/deploy-testnet.mjs"), "--wasm", f, "--out", path.join(dir, "out.json")], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused before any send: .*mainnet/);
  assert.doesNotMatch(r.stdout, /faucet|parent/);
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
