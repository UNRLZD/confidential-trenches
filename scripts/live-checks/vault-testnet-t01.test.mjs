// node --test scripts/live-checks/vault-testnet-t01.test.mjs: the live check replays recorded runs on NEAR testnet's
// two RPCs. The good answer (vault-testnet-t01.answers.json, the deployed vault of testnet-v1.json) must PASS. The
// recorded bad answers must FAIL:
//   - vault-testnet-t01.bad-key.answers.json: an ordinary testnet account with one full-access key and no code (the
//     deploy's own parent, bf-vt-20261102t071444.testnet);
//   - vault-testnet-t01.bad-code.answers.json: another keyless vault, the 1 Nov skeleton vault.bf-vs-20261101t012200,
//     whose code is another build (code hash GGfTdwuL…) naming Circle's testnet USDC, not registered on this token.
// Three more are made here from the good answer, each changing one read so only that check can fail: a full-access key
// in the key list; config() naming Circle's testnet USDC; storage_balance_of(vault) answering null, as it read before
// the registration tx.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, networkProblems, DEPLOYMENT, TESTNET_TOKEN, MAINNET_USDC, CIRCLE_TESTNET_USDC } from "./vault-testnet-t01.mjs";

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
const good = () => load("vault-testnet-t01.answers.json");
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));
// the good answer with one view's JSON result replaced
const withView = (answers, method, f) =>
  answers.map((a) => {
    if (a.params.method_name !== method) return a;
    const v = f(JSON.parse(Buffer.from(a.json.result.result).toString("utf8")));
    return { ...a, json: { ...a.json, result: { ...a.json.result, result: [...Buffer.from(JSON.stringify(v))] } } };
  });

test("the record: the testnet token, the base58 of the build's sha256 as code hash, the deploy and registration txs", () => {
  assert.equal(deployment.network, "testnet");
  assert.equal(deployment.asset, TESTNET_TOKEN);
  assert.equal(deployment.account_id, `vault.${deployment.parent}`);
  assert.deepEqual(deployment.wasm_builds_sha256, [deployment.wasm_sha256, deployment.wasm_sha256]);
  for (const t of [deployment.parent_tx, deployment.tx_hash, deployment.registration_tx]) assert.match(t, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
});

test("recorded good answer: the deployed vault, keys [] on two RPCs, its code, config() and its registration: PASS", async () => {
  const answers = good();
  assert.equal(accountOf(answers), deployment.account_id);
  assert.equal(new Set(answers.map((a) => a.url)).size, 2);
  const r = await check({ deployment, fetchFn: replay(answers) });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 22);
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\] on .*: 0 key\(s\) at block/.test(l)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  ${deployment.account_id} code hash ${deployment.code_hash} equals`)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  code sha256 ${deployment.wasm_sha256} equals`)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith("ok  config() answers on ") && l.includes(`asset ${TESTNET_TOKEN}`)).length, 2);
  const reg = answers.filter((a) => a.params.method_name === "storage_balance_of");
  assert.deepEqual(reg.map((a) => a.params.account_id), [TESTNET_TOKEN, TESTNET_TOKEN]);
  for (const a of reg) assert.deepEqual(JSON.parse(Buffer.from(a.params.args_base64, "base64")), { account_id: deployment.account_id });
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  ${deployment.account_id} is registered on the testnet token on `)).length, 2);
});

test("recorded bad answer: an ordinary account with one full-access key: FAIL on its key list", async () => {
  const answers = load("vault-testnet-t01.bad-key.answers.json");
  const r = await check({ deployment, account: accountOf(answers), fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.equal(bads(r).filter((l) => /^BAD \S+ key list is \[\] on .*: 1 key\(s\) \(FullAccess\)/.test(l)).length, 2, r.lines.join("\n"));
});

test("recorded bad answer: another keyless vault with another code hash: FAIL on its code hash", async () => {
  const answers = load("vault-testnet-t01.bad-code.answers.json");
  assert.equal(accountOf(answers), "vault.bf-vs-20261101t012200.testnet");
  const r = await check({ deployment, account: accountOf(answers), fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\]/.test(l)).length, 2, "keyless, so only the code and what follows from it fail");
  assert.equal(bads(r).filter((l) => / code hash GGfTdwuLbonERu3vKnpLF828eyWZ4DxS24kpLp67PmSn equals the record's /.test(l)).length, 2, r.lines.join("\n"));
  assert.equal(bads(r).filter((l) => l.startsWith("BAD config() answers on ") && l.includes(`asset ${CIRCLE_TESTNET_USDC}`)).length, 2);
  assert.equal(bads(r).filter((l) => / is registered on the testnet token on .*: null at block/.test(l)).length, 2);
});

test("bad answer: a full-access key in the vault's key list, all else the good answer: FAIL on the key list only", async () => {
  const key = { public_key: "ed25519:EhjW27bK6ojYS7oWrNQjTjgKgdv8QwfqVQVzSD2YxR51", access_key: { nonce: 1, permission: "FullAccess" } };
  const answers = good().map((a) => (a.params.request_type === "view_access_key_list" ? { ...a, json: { ...a.json, result: { ...a.json.result, keys: [key] } } } : a));
  const r = await check({ deployment, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 2, r.lines.join("\n"));
  for (const l of bads(r)) assert.match(l, /key list is \[\] on .*: 1 key\(s\) \(FullAccess\)/);
});

test("bad answer: config() names another asset (Circle's testnet USDC), all else the good answer: FAIL on config() only", async () => {
  const answers = withView(good(), "config", (c) => ({ ...c, asset: CIRCLE_TESTNET_USDC }));
  const r = await check({ deployment, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 2, r.lines.join("\n"));
  for (const l of bads(r)) assert.ok(l.startsWith("BAD config() answers on ") && l.includes(`asset ${CIRCLE_TESTNET_USDC}`), l);
  // and a record that copied that asset fails too: the asset is pinned in the check
  const r2 = await check({ deployment: { ...deployment, asset: CIRCLE_TESTNET_USDC }, fetchFn: replay(answers) });
  assert.ok(bads(r2).some((l) => l.startsWith("BAD the record's asset ")));
});

test("bad answer: storage_balance_of(vault) answers null (no registration), all else the good answer: FAIL on the registration only", async () => {
  const answers = withView(good(), "storage_balance_of", () => null);
  const r = await check({ deployment, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 2, r.lines.join("\n"));
  for (const l of bads(r)) assert.match(l, /is registered on the testnet token on .*: null at block/);
});

test("bad record: another code hash or sha256 in the record: FAIL", async () => {
  const other = "e2e280869bdff90ad54f7be2bc1181dcef6e229eaa8f17b99f2e8bc33a422037";
  const r = await check({ deployment: { ...deployment, wasm_sha256: other }, fetchFn: replay(good()) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).some((l) => l.startsWith("BAD the record's code_hash ")));
  assert.equal(bads(r).filter((l) => l.startsWith("BAD code sha256 ")).length, 2);
  const r2 = await check({ deployment: { ...deployment, code_hash: "GGfTdwuLbonERu3vKnpLF828eyWZ4DxS24kpLp67PmSn" }, fetchFn: replay(good()) });
  assert.equal(r2.ok, false);
  assert.equal(bads(r2).filter((l) => / code hash CXer\S+ equals the record's GGfTdwuL/.test(l)).length, 2, r2.lines.join("\n"));
});

test("the same answers with one RPC: FAIL (two RPCs are required)", async () => {
  const answers = good();
  const one = [...new Set(answers.map((a) => a.url))].slice(0, 1);
  const r = await check({ deployment, fetchFn: replay(answers), rpcs: one });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^BAD only 1 RPC\(s\): https:\/\/test\.rpc\.fastnear\.com \(fastnear\); want two of two operators$/);
  assert.equal(bads(r).length, 1, r.lines.join("\n"));
});

// planted: dRPC's answers relabelled as rpc.testnet.near.org, a second door to FastNEAR; every read still answers ok
test("the same answers from two hosts of one operator (FastNEAR twice): FAIL on the operators only", async () => {
  const NEAR_ORG = "https://rpc.testnet.near.org";
  const answers = good().map((a) => (a.url === "https://near-testnet.drpc.org" ? { ...a, url: NEAR_ORG } : a));
  const r = await check({ deployment, fetchFn: replay(answers), rpcs: ["https://test.rpc.fastnear.com", NEAR_ORG] });
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r), ["BAD only 1 operator(s) in https://test.rpc.fastnear.com (fastnear), https://rpc.testnet.near.org (fastnear); want two testnet operators"], r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => l.startsWith("ok ")).length, 22);
});

test("the network rule reads the token ids only: the deployed wasm passes; the skeleton's and mainnet's ids are refused", () => {
  const code = Buffer.from(good().find((a) => a.params.request_type === "view_code").json.result.code_base64, "base64");
  assert.equal(code.length, deployment.wasm_bytes);
  assert.equal(createHash("sha256").update(code).digest("hex"), deployment.wasm_sha256);
  assert.deepEqual(networkProblems(code), []);
  assert.equal(networkProblems(Buffer.from(CIRCLE_TESTNET_USDC)).length, 2);
  assert.equal(networkProblems(Buffer.from(MAINNET_USDC)).length, 2);
  assert.equal(networkProblems(Buffer.from(`${TESTNET_TOKEN}\0${MAINNET_USDC}`)).length, 1);
  assert.deepEqual(networkProblems(Buffer.from(`${TESTNET_TOKEN}\0mainnet`)), []);
});
