// node --test scripts/live-checks/vault-mainnet-deploy.test.mjs: the mainnet vault's live check replays recorded runs,
// every one read on mainnet's two operators (FastNEAR and dRPC) by vault-mainnet.mjs with --registered:
//   - vault-mainnet-deploy.bad-absent.answers.json: vault.confidential.unrlzd.near before its deploy (7 Nov 10:05Z):
//     keys [] (an absent account's list), no code, no config(), not registered on USDC: FAIL;
//   - vault-mainnet-deploy.bad-key.answers.json: the parent confidential.unrlzd.near, one full-access key, no code: FAIL;
//   - vault-mainnet-deploy.vault-test.answers.json: the keyless mainnet test vault, registered on USDC, its reads
//     only (its Nov 5 storage_prepay is past what both RPCs keep): read against its own record mainnet-test.json every
//     read passes and the write is offered (the check's good path on a real mainnet vault); read against the v1 pin
//     it FAILs on the code hash and the code's sha256 only (a keyless vault with another code hash);
//   - vault-mainnet-deploy.answers.json: the deployed vault, recorded by contracts/vault/scripts/mainnet-v1/
//     3-readback-write.sh after the owner's deploy, with its storage_prepay read back: PASS (skipped until recorded).
//     Planted from it: a full-access key on FastNEAR, or vault-test's code hash on dRPC: FAIL on that line, no write.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check } from "./vault-mainnet.mjs";
import { ACCOUNT, PIN_RECORD, PREPAY_P, PREPAY_TX, RECORD, SIGNER, args, deployment } from "./vault-mainnet-deploy.mjs";

const NOSLEEP = async () => {};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const pin = json(PIN_RECORD);
const testRecord = json(path.join(HERE, "../../contracts/vault/deployments/mainnet-test.json"));
const TEST_VAULT = testRecord.account_id;
const RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];

// each request gets its recorded answer; a request the run never made is an error
function replay(answers) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} ${params.request_type ?? ""} on ${url}`);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
  };
}
const run = (answers, { account = ACCOUNT, record = pin, write = {} } = {}) =>
  check({ sleep: NOSLEEP, network: "mainnet", account, deployment: record, fetchFn: replay(answers), write: { signer: SIGNER, ...write }, wait: 0, registered: true });
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const REGISTERED = (account, total) => new RegExp(`^ok  ${account.replaceAll(".", "\\.")} is registered on ${pin.asset} on \\S+: total ${total} at block`);

test("the entry fixes the mainnet vault, its record (the pin until mainnet-v1.json exists), its signer and the registration read", () => {
  assert.equal(ACCOUNT, "vault.confidential.unrlzd.near");
  assert.equal(SIGNER, "confidential.unrlzd.near");
  assert.equal(pin.account_id, ACCOUNT);
  assert.equal(pin.parent, SIGNER);
  assert.equal(pin.wasm_sha256, "a4a2af6960d93e5187271cf401ffe0e1a6f1ae5da0af1d82b1250eee313e87fc");
  assert.equal(deployment(), existsSync(RECORD) ? RECORD : PIN_RECORD);
  assert.deepEqual(args(), ["--network", "mainnet", "--account", ACCOUNT, "--signer", SIGNER, "--deployment", deployment(), "--registered"]);
  if (existsSync(RECORD)) {
    // the record deploy.mjs wrote keeps the pin's account and build
    const rec = json(RECORD);
    for (const k of ["account_id", "parent", "network", "wasm_sha256", "code_hash", "asset", "source_commit"]) assert.equal(rec[k], pin[k], k);
  }
});

test("recorded bad answer: the vault account before its deploy FAILs on its code, config() and USDC registration, and nothing is written", async () => {
  const answers = load("vault-mainnet-deploy.bad-absent.answers.json");
  assert.deepEqual([...new Set(answers.map((a) => a.url))], RPCS);
  const r = await run(answers);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.equal(r.pending, undefined, "a write was offered for a vault that failed its reads");
  for (const what of [`${ACCOUNT} code hash on `, "code on ", "config() on "]) assert.equal(bads(r).filter((l) => l.startsWith(`BAD ${what}`) && l.endsWith("UNKNOWN_ACCOUNT")).length, 2, `${what}\n${r.lines.join("\n")}`);
  assert.equal(bads(r).filter((l) => l.startsWith(`BAD ${ACCOUNT} is registered on ${pin.asset} on `) && / null at block/.test(l)).length, 2, r.lines.join("\n"));
  assert.ok(bads(r).includes("BAD no storage_prepay: a read above failed, so nothing is written to this vault"));
  // the key list of an account that does not exist reads []: the check passes that line and fails the vault anyway
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\] on /.test(l)).length, 2);
});

test("recorded bad answer: an account with a full-access key (the parent) FAILs on its key list on both RPCs", async () => {
  const answers = load("vault-mainnet-deploy.bad-key.answers.json");
  assert.deepEqual([...new Set(answers.map((a) => a.url))], RPCS);
  const r = await run(answers, { account: SIGNER, record: { ...pin, account_id: SIGNER } });
  assert.equal(r.ok, false);
  assert.equal(bads(r).filter((l) => /^BAD confidential\.unrlzd\.near key list is \[\] on .*: 1 key\(s\) \(FullAccess\)/.test(l)).length, 2, r.lines.join("\n"));
  assert.ok(bads(r).includes("BAD no storage_prepay: a read above failed, so nothing is written to this vault"));
});

test("recorded bad answer: a keyless, registered mainnet vault with another code hash (vault-test) FAILs on the code hash and sha256 only", async () => {
  const answers = load("vault-mainnet-deploy.vault-test.answers.json");
  assert.deepEqual([...new Set(answers.map((a) => a.url))], RPCS);
  const r = await run(answers, { account: TEST_VAULT, record: { ...pin, account_id: TEST_VAULT } });
  assert.equal(r.ok, false);
  const wrong = [`BAD ${TEST_VAULT} code hash ${testRecord.code_hash} equals the record's ${pin.code_hash} on `, `BAD code sha256 ${testRecord.wasm_sha256} equals the record's ${pin.wasm_sha256} on `];
  for (const w of wrong) assert.equal(bads(r).filter((l) => l.startsWith(w)).length, 2, `${w}\n${r.lines.join("\n")}`);
  const rest = bads(r).filter((l) => !wrong.some((w) => l.startsWith(w)));
  assert.deepEqual(rest, ["BAD no storage_prepay: a read above failed, so nothing is written to this vault"]);
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\] on /.test(l)).length, 2);
  assert.equal(r.lines.filter((l) => REGISTERED(TEST_VAULT, "1250000000000000000000").test(l)).length, 2);
});

test("recorded good reads: the same vault against its own record passes every read, registration included, and offers the write", async () => {
  const answers = load("vault-mainnet-deploy.vault-test.answers.json");
  const r = await run(answers, { account: TEST_VAULT, record: testRecord, write: { precommitment: "12345" } });
  assert.deepEqual(bads(r), [], r.lines.join("\n"));
  assert.equal(r.pending, true);
  assert.equal(r.line, `near call ${TEST_VAULT} storage_prepay '{"precommitment":"12345"}' --useAccount ${SIGNER} --depositYocto 7560000000000000000000 --gas 30000000000000 --networkId mainnet`);
  assert.equal(r.lines.filter((l) => REGISTERED(TEST_VAULT, "1250000000000000000000").test(l)).length, 2);
});

test("planted from the good reads: the vault not registered on USDC on one RPC FAILs on that line only; without --registered it is not read", async () => {
  const answers = load("vault-mainnet-deploy.vault-test.answers.json");
  const unregistered = answers.map((a) => (a.url === RPCS[1] && a.params?.method_name === "storage_balance_of" ? { ...a, json: { ...a.json, result: { ...a.json.result, result: [...Buffer.from("null")] } } } : a));
  const r = await run(unregistered, { account: TEST_VAULT, record: testRecord, write: { precommitment: "12345" } });
  assert.equal(r.ok, false);
  assert.equal(r.pending, undefined);
  assert.deepEqual(bads(r), [bads(r).find((l) => l.startsWith(`BAD ${TEST_VAULT} is registered on ${pin.asset} on ${RPCS[1]}: null`)), "BAD no storage_prepay: a read above failed, so nothing is written to this vault"]);
  const plain = await check({ sleep: NOSLEEP, network: "mainnet", account: TEST_VAULT, deployment: testRecord, fetchFn: replay(unregistered), write: { signer: SIGNER, precommitment: "12345" }, wait: 0 });
  assert.equal(plain.pending, true);
  assert.ok(!plain.lines.some((l) => / is registered on /.test(l)));
});

test("planted from the good reads: a full-access key in the vault's key list FAILs, and no write is offered", async () => {
  const answers = load("vault-mainnet-deploy.vault-test.answers.json");
  const keyed = answers.map((a) => (a.params?.request_type === "view_access_key_list" ? { ...a, json: { ...a.json, result: { ...a.json.result, keys: [{ public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 0, permission: "FullAccess" } }] } } } : a));
  const r = await run(keyed, { account: TEST_VAULT, record: testRecord, write: { precommitment: "12345" } });
  assert.equal(r.ok, false);
  assert.equal(r.pending, undefined);
  assert.equal(bads(r).filter((l) => / key list is \[\] on .*1 key\(s\) \(FullAccess\)/.test(l)).length, 2, r.lines.join("\n"));
});

// review L1: the CLI's --registered reaches the check. vault-mainnet.mjs runs as a process over the recorded vault-test
// answers with its USDC registration planted null on dRPC: with --registered it FAILs on that line and prints no
// write; without it the same answers end in the write (exit 3), so the flag is what decides.
test("the CLI with --registered FAILs an unregistered vault and prints no write; without the flag the write is printed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vault-mainnet-deploy-cli-"));
  try {
    const answers = load("vault-mainnet-deploy.vault-test.answers.json").map((a) => (a.url === RPCS[1] && a.params?.method_name === "storage_balance_of" ? { ...a, json: { ...a.json, result: { ...a.json.result, result: [...Buffer.from("null")] } } } : a));
    const file = path.join(dir, "answers.json");
    writeFileSync(file, JSON.stringify(answers));
    const stub = path.join(dir, "stub.mjs");
    writeFileSync(stub, `import { readFileSync } from "node:fs";
const answers = JSON.parse(readFileSync(${JSON.stringify(file)}, "utf8"));
const byKey = new Map(answers.map((a) => [\`\${a.url} \${a.method} \${JSON.stringify(a.params)}\`, a]));
globalThis.fetch = async (url, init) => {
  const { method, params } = JSON.parse(init.body);
  const a = byKey.get(\`\${url} \${method} \${JSON.stringify(params)}\`);
  if (!a) throw new Error("no recorded answer for " + method);
  return { ok: true, status: a.status, json: async () => a.json };
};
`);
    const cli = (extra) => spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, path.join(HERE, "vault-mainnet.mjs"), "--network", "mainnet", "--account", TEST_VAULT, "--signer", SIGNER, "--deployment", path.join(HERE, "../../contracts/vault/deployments/mainnet-test.json"), ...extra, "--precommitment", "12345"], { encoding: "utf8" });
    const flagged = cli(["--registered"]);
    assert.equal(flagged.status, 1, flagged.stdout + flagged.stderr);
    assert.match(flagged.stdout, new RegExp(`BAD ${TEST_VAULT.replaceAll(".", "\\.")} is registered on ${pin.asset} on ${RPCS[1].replaceAll(".", "\\.")}: null`));
    assert.doesNotMatch(flagged.stdout, /near call /);
    assert.match(flagged.stdout, /live-check vault-mainnet: FAIL\n$/);
    const plain = cli([]);
    assert.equal(plain.status, 3, plain.stdout + plain.stderr);
    assert.match(plain.stdout, /^near call vault-test\.confidential\.unrlzd\.near storage_prepay /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GOOD = path.join(HERE, "vault-mainnet-deploy.answers.json");
test("recorded good answer: the deployed vault PASSes on both RPCs, keyless, the pin, mainnet USDC, registered, and its storage_prepay", { skip: existsSync(GOOD) ? false : "recorded by 3-readback-write.sh after the owner's deploy" }, async () => {
  const answers = load("vault-mainnet-deploy.answers.json");
  assert.deepEqual([...new Set(answers.map((a) => a.url))], RPCS);
  const t = answers.find((a) => a.method === "tx").json.result.transaction;
  const w = { tx: t.hash, precommitment: JSON.parse(Buffer.from(t.actions[0].FunctionCall.args, "base64").toString()).precommitment };
  assert.deepEqual([PREPAY_TX, PREPAY_P], [w.tx, w.precommitment], "the entry's bare run reads back the recorded write");
  const r = await run(answers, { record: json(deployment()), write: w });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(bads(r), []);
  assert.equal(r.lines.filter((l) => REGISTERED(ACCOUNT, "\\d+").test(l)).length, 2);
});

// planted from the recorded good answer: one mismatch each, on one RPC only, FAILs on that line, and no write follows
test("planted from the recorded good answer: a full-access key on FastNEAR, or another code hash on dRPC, FAILs on that line only", { skip: existsSync(GOOD) ? false : "recorded by 3-readback-write.sh after the owner's deploy" }, async () => {
  const answers = load("vault-mainnet-deploy.answers.json");
  const t = answers.find((a) => a.method === "tx").json.result.transaction;
  const w = { tx: t.hash, precommitment: JSON.parse(Buffer.from(t.actions[0].FunctionCall.args, "base64").toString()).precommitment };
  const rec = json(deployment());
  const keyed = answers.map((a) => (a.url === RPCS[0] && a.params?.request_type === "view_access_key_list" ? { ...a, json: { ...a.json, result: { ...a.json.result, keys: [{ public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 0, permission: "FullAccess" } }] } } } : a));
  const k = await run(keyed, { record: rec, write: w });
  assert.equal(k.ok, false);
  assert.deepEqual(bads(k).map((l) => l.split(":")[0]), [`BAD ${ACCOUNT} key list is [] on https`, "BAD no storage_prepay"], k.lines.join("\n"));
  assert.equal(bads(k)[1], "BAD no storage_prepay: a read above failed, so nothing is written to this vault");
  assert.match(bads(k)[0], new RegExp(`on ${RPCS[0].replaceAll(".", "\\.")}: 1 key\\(s\\) \\(FullAccess\\)`));
  const other = answers.map((a) => (a.url === RPCS[1] && a.params?.request_type === "view_account" ? { ...a, json: { ...a.json, result: { ...a.json.result, code_hash: testRecord.code_hash } } } : a));
  const c = await run(other, { record: rec, write: w });
  assert.equal(c.ok, false);
  assert.deepEqual(bads(c).map((l) => l.split(" on ")[0]), [`BAD ${ACCOUNT} code hash ${testRecord.code_hash} equals the record's ${rec.code_hash}`, "BAD no storage_prepay: a read above failed, so nothing is written to this vault"], c.lines.join("\n"));
  assert.ok(bads(c)[0].includes(`on ${RPCS[1]}`));
});
