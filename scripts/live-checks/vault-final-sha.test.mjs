// node --test scripts/live-checks/vault-final-sha.test.mjs: the live check replays recorded runs on NEAR testnet's
// two RPCs. The good answer (vault-final-sha.answers.json, the vault of testnet-v4.json) must PASS. The recorded
// bad answers must FAIL:
//   - vault-final-sha.bad-key.answers.json: the deploy's own parent, an ordinary account with one full-access key
//     and no code;
//   - vault-final-sha.bad-code.answers.json: testnet-v3's vault, keyless and registered on the same token, whose
//     code is the reproducible build of an earlier commit, 4f08f70b (code hash 4SeQUmSG…).
// One more is made here from the good answer: a record naming another commit, or two builds that differ.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, DEPLOYMENT, SOURCE_COMMIT } from "./vault-final-sha.mjs";

const NOSLEEP = async () => {};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));

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
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the record: testnet, SOURCE_COMMIT, two equal reproducible builds, the deploy and registration txs", () => {
  assert.equal(deployment.network, "testnet");
  assert.equal(deployment.source_commit, SOURCE_COMMIT);
  assert.equal(deployment.account_id, `v4.${deployment.parent}`, "testnet-v3's parent, a new label, so v3 stays as it is");
  assert.deepEqual(deployment.wasm_builds_sha256, [deployment.wasm_sha256, deployment.wasm_sha256]);
  for (const t of [deployment.tx_hash, deployment.registration_tx]) assert.match(t, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
});

test("recorded good answer: testnet-v4's vault, keys [] on two RPCs, its code, config() and its registration: PASS", async () => {
  const answers = load("vault-final-sha.answers.json");
  assert.equal(accountOf(answers), deployment.account_id);
  assert.equal(new Set(answers.map((a) => a.url)).size, 2);
  const r = await check({ sleep: NOSLEEP, deployment, fetchFn: replay(answers) });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], new RegExp(`^ok  the record is ${SOURCE_COMMIT.slice(0, 12)}.s reproducible build$`));
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\] on .*: 0 key\(s\) at block/.test(l)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  ${deployment.account_id} code hash ${deployment.code_hash} equals`)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  ${deployment.account_id} is registered on the testnet token on `)).length, 2);
});

test("recorded bad answer: the parent, an ordinary account with one full-access key: FAIL on its key list", async () => {
  const answers = load("vault-final-sha.bad-key.answers.json");
  assert.equal(accountOf(answers), deployment.parent);
  const r = await check({ sleep: NOSLEEP, deployment, account: accountOf(answers), fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.equal(bads(r).filter((l) => /^BAD \S+ key list is \[\] on .*: 1 key\(s\) \(FullAccess\)/.test(l)).length, 2, r.lines.join("\n"));
});

test("recorded bad answer: testnet-v3's keyless vault, an earlier commit's build: FAIL on its code hash", async () => {
  const answers = load("vault-final-sha.bad-code.answers.json");
  assert.equal(accountOf(answers), "vault.bf-vt-20261106t125654.testnet");
  const r = await check({ sleep: NOSLEEP, deployment, account: accountOf(answers), fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\]/.test(l)).length, 2, "keyless, so only its code fails");
  assert.equal(bads(r).filter((l) => / code hash 4SeQUmSGuTvTxYe9uAZa552mebsfTxiG9EZWzKx6Rng5 equals the record's /.test(l)).length, 2, r.lines.join("\n"));
});

test("bad record: another commit, or two builds that differ, all else the good answer: FAIL on the record only", async () => {
  const answers = load("vault-final-sha.answers.json");
  for (const d of [
    { ...deployment, source_commit: "4f08f70b048a872a7f601b9d0d80f8f6bf1eedb5" },
    { ...deployment, wasm_builds_sha256: [deployment.wasm_sha256, "0".repeat(64)] },
  ]) {
    const r = await check({ sleep: NOSLEEP, deployment: d, fetchFn: replay(answers) });
    assert.equal(r.ok, false);
    assert.equal(bads(r).length, 1, r.lines.join("\n"));
    assert.match(bads(r)[0], new RegExp(`^BAD the record is ${SOURCE_COMMIT.slice(0, 12)}.s reproducible build: `));
  }
});
