// node --test scripts/live-checks/vault-mainnet.test.mjs: the live check replays recorded runs. The good answer
// (vault-mainnet.answers.json: the testnet vault of testnet-v1.json and one storage_prepay that landed, tx
// 9i99Dt4siBXHfpntHpN81R4wmBiTeRmBPMF4czjFhD7V, read on FastNEAR and dRPC) must PASS. The recorded bad answers must FAIL:
//   - vault-mainnet.bad-key.answers.json: the vault's parent bf-vt-20261102t071444.testnet, one full-access key, no code;
//   - vault-mainnet.bad-code.answers.json: another keyless vault, the 1 Nov skeleton, whose code hash is another build's;
//   - vault-mainnet.bad-import.answers.json: the account `testnet`, whose code imports the add-key, deploy and
//     create-account actions;
//   - vault-mainnet.bad-write.answers.json: the good vault, then a storage_prepay with 1 yocto attached that the vault
//     refused (InsufficientStorageDeposit), tx bbHFD9BhLGhwchkCAjAXeB217QCwxh8g6v167gkvkck: a write that never landed;
//   - vault-mainnet.bad-mainnet.answers.json: the mainnet reads, on mainnet's two operators, of mainnet USDC's account
//     (a key, other code), so the mainnet path is read for real and fails on what it reads.
// More are made here from the good answer, each changing one read: a key in the vault's key list; the write's tx
// unknown on both RPCs; its event naming another payer; one RPC, or two of one operator.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, pasteLine, freshPrecommitment, NETWORKS } from "./vault-mainnet.mjs";
import { DEPLOYMENT, MAINNET_USDC, b58 } from "./vault-testnet-t01.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
const VAULT = deployment.account_id;
const SIGNER = "bf-rb-20261104t183046.testnet";
const GOOD_TX = "9i99Dt4siBXHfpntHpN81R4wmBiTeRmBPMF4czjFhD7V";
const BAD_TX = "bbHFD9BhLGhwchkCAjAXeB217QCwxh8g6v167gkvkck";
const MIN = 756n * 10n ** 19n;

// each request gets its recorded answer; a request the run never made is an error
function replay(answers) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  const asked = [];
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    asked.push(method);
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} ${params.request_type ?? ""} on ${url}`);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
  };
  return Object.assign(fetchFn, { asked });
}
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const good = () => load("vault-mainnet.answers.json");
const run = (answers, o = {}) => check({ network: "testnet", account: VAULT, deployment, fetchFn: replay(answers), write: { signer: SIGNER, tx: GOOD_TX }, wait: 0, ...o });
const withTx = (answers, f) => answers.map((a) => (a.method === "tx" ? f(a) : a));

test("recorded good answer: keys [], the build's code hash and imports, config() and one storage_prepay landed, on two RPCs: PASS", async () => {
  const answers = good();
  assert.equal(new Set(answers.map((a) => a.url)).size, 2);
  const r = await run(answers);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 3 + 2 * 10 + 1 + 2 * 4);
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\] on .*: 0 key\(s\) at block/.test(l)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  ${VAULT} code hash ${deployment.code_hash} equals`)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith("ok  no banned import on ") && l.endsWith(": none")).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith("ok  config() answers on ")).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  storage_prepay tx ${GOOD_TX} by ${SIGNER} is final on `) && l.endsWith(": FINAL")).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  the tx is one storage_prepay call from ${SIGNER} to ${VAULT} with at least ${MIN} yocto`)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  ${VAULT} logged storage_prepaid {"precommitment":"`) && l.includes(`"payer":"${SIGNER}","amount":"${MIN}"`)).length, 2);
  // the run that recorded it (contracts/vault/scripts/prepay.mjs) sent the write: its send_tx is in the record
  const sent = answers.find((a) => a.method === "send_tx");
  assert.equal(b58(createHash("sha256").update(Buffer.from(sent.params.signed_tx_base64, "base64").subarray(0, -65)).digest()), GOOD_TX);
  assert.equal(sent.json.result.transaction.hash, GOOD_TX);
});

test("recorded bad answer: an ordinary account with one full-access key: FAIL on its key list, and nothing is written", async () => {
  const answers = load("vault-mainnet.bad-key.answers.json");
  const f = replay(answers);
  const r = await check({ network: "testnet", account: answers[0].params.account_id, deployment, fetchFn: f, write: { signer: SIGNER, tx: GOOD_TX }, wait: 0 });
  assert.equal(r.ok, false);
  assert.equal(bads(r).filter((l) => /^BAD \S+ key list is \[\] on .*: 1 key\(s\) \(FullAccess\)/.test(l)).length, 2, r.lines.join("\n"));
  assert.equal(r.lines.at(-1), "BAD no storage_prepay: a read above failed, so nothing is written to this vault");
  assert.ok(!f.asked.includes("tx") && !f.asked.includes("send_tx"));
});

test("recorded bad answer: another keyless vault with another code hash: FAIL on the code hash, the keys pass", async () => {
  const answers = load("vault-mainnet.bad-code.answers.json");
  const r = await check({ network: "testnet", account: "vault.bf-vs-20261101t012200.testnet", deployment, fetchFn: replay(answers), write: { signer: SIGNER, tx: GOOD_TX }, wait: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\]/.test(l)).length, 2);
  assert.equal(bads(r).filter((l) => / code hash GGfTdwuLbonERu3vKnpLF828eyWZ4DxS24kpLp67PmSn equals the record's /.test(l)).length, 2, r.lines.join("\n"));
  assert.equal(bads(r).filter((l) => l.startsWith("BAD code sha256 e2e28086")).length, 2);
});

test("recorded bad answer: code that imports the add-key and deploy actions: FAIL on the import list", async () => {
  const answers = load("vault-mainnet.bad-import.answers.json");
  const r = await check({ network: "testnet", account: "testnet", deployment, fetchFn: replay(answers), write: { signer: SIGNER, tx: GOOD_TX }, wait: 0 });
  assert.equal(r.ok, false);
  const banned = bads(r).filter((l) => l.startsWith("BAD no banned import on "));
  assert.equal(banned.length, 2, r.lines.join("\n"));
  for (const l of banned) for (const i of ["promise_batch_action_add_key_with_full_access", "promise_batch_action_deploy_contract"]) assert.ok(l.includes(i), l);
});

test("recorded bad answer: a storage_prepay the vault refused (1 yocto, InsufficientStorageDeposit): FAIL on the write only", async () => {
  const answers = load("vault-mainnet.bad-write.answers.json");
  const r = await run(answers, { write: { signer: SIGNER, tx: BAD_TX } });
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 6, r.lines.join("\n"));
  assert.equal(bads(r).filter((l) => l.startsWith("BAD the tx and every receipt succeeded on ") && l.includes("InsufficientStorageDeposit")).length, 2);
  assert.equal(bads(r).filter((l) => l.startsWith("BAD the tx is one storage_prepay call ") && l.includes("deposit 1,")).length, 2);
  assert.equal(bads(r).filter((l) => l.startsWith(`BAD ${VAULT} logged storage_prepaid `) && l.endsWith(": no storage_prepaid event")).length, 2);
});

test("bad answer: the write's tx is unknown on both RPCs (it never landed): FAIL on the read-back only", async () => {
  const unknown = { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, message: "Server error" } };
  const r = await run(withTx(good(), (a) => ({ ...a, json: unknown })));
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r).map((l) => l.replace(/ on https:\/\/[^\s:]+/, "")), [`BAD storage_prepay tx ${GOOD_TX} by ${SIGNER}: HANDLER_ERROR: UNKNOWN_TRANSACTION`, `BAD storage_prepay tx ${GOOD_TX} by ${SIGNER}: HANDLER_ERROR: UNKNOWN_TRANSACTION`]);
});

test("bad answer: the vault's event names another payer: FAIL on the event only", async () => {
  const answers = withTx(good(), (a) => {
    const j = structuredClone(a.json);
    for (const o of j.result.receipts_outcome) o.outcome.logs = o.outcome.logs.map((l) => l.replace(`"payer":"${SIGNER}"`, '"payer":"someone.testnet"'));
    return { ...a, json: j };
  });
  const r = await run(answers);
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 2, r.lines.join("\n"));
  for (const l of bads(r)) assert.ok(l.startsWith(`BAD ${VAULT} logged storage_prepaid `) && l.includes("someone.testnet"), l);
});

test("bad answer: a full-access key in the vault's key list: FAIL on the key list, and no write is offered or read", async () => {
  const key = { public_key: "ed25519:EhjW27bK6ojYS7oWrNQjTjgKgdv8QwfqVQVzSD2YxR51", access_key: { nonce: 1, permission: "FullAccess" } };
  const answers = good().map((a) => (a.params.request_type === "view_access_key_list" ? { ...a, json: { ...a.json, result: { ...a.json.result, keys: [key] } } } : a));
  const f = replay(answers);
  const r = await check({ network: "testnet", account: VAULT, deployment, fetchFn: f, write: { signer: SIGNER }, wait: 0 });
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 3, r.lines.join("\n"));
  assert.ok(!f.asked.includes("send_tx") && !f.asked.includes("tx"));
  assert.equal(r.pending, undefined, "a vault that fails a read gets no write line");
});

test("bad record: another network, builds that disagree, a code_hash that is not its sha256's: FAIL", async () => {
  const r = await run(good(), { deployment: { ...deployment, network: "mainnet", wasm_builds_sha256: [deployment.wasm_sha256, "00".repeat(32)], code_hash: "GGfTdwuLbonERu3vKnpLF828eyWZ4DxS24kpLp67PmSn" } });
  assert.equal(r.ok, false);
  assert.ok(bads(r).some((l) => l === "BAD the record is a testnet record: mainnet"));
  assert.ok(bads(r).some((l) => l.startsWith("BAD the record's builds agree ")));
  assert.ok(bads(r).some((l) => l.startsWith("BAD the record's code_hash ")));
});

test("the same answers on one RPC, or on two hosts of one operator: FAIL on the operators", async () => {
  const one = await run(good(), { rpcs: ["https://test.rpc.fastnear.com"] });
  assert.equal(one.ok, false);
  assert.match(one.lines[0], /^BAD only 1 RPC\(s\)/);
  const NEAR_ORG = "https://rpc.testnet.near.org";
  const answers = good().map((a) => (a.url === "https://near-testnet.drpc.org" ? { ...a, url: NEAR_ORG } : a));
  const r = await run(answers, { rpcs: ["https://test.rpc.fastnear.com", NEAR_ORG] }); // near-rpc-operators: one operator (planted: the same-operator case this check must refuse)
  assert.equal(r.ok, false);
  assert.match(bads(r)[0], /^BAD only 1 operator\(s\) in .*want two testnet operators$/);
});

test("recorded mainnet reads: mainnet USDC's account on mainnet's two operators: FAIL on what it read, never on the operators", async () => {
  const answers = load("vault-mainnet.bad-mainnet.answers.json");
  assert.deepEqual([...new Set(answers.map((a) => a.url))], NETWORKS.mainnet.rpcs);
  const r = await check({ network: "mainnet", account: MAINNET_USDC, deployment: { ...deployment, network: "mainnet" }, fetchFn: replay(answers), write: { signer: "owner.near" }, wait: 0 });
  assert.equal(r.ok, false);
  assert.ok(!r.lines.some((l) => / operator\(s\)/.test(l)), r.lines.join("\n"));
  assert.equal(bads(r).filter((l) => / key list is \[\] on .*1 key\(s\) \(FullAccess\)/.test(l)).length, 2);
  assert.equal(bads(r).filter((l) => l.startsWith("BAD the code names mainnet USDC and no other on ")).length, 2);
  // and testnet hosts are no mainnet read
  const t = await check({ network: "mainnet", account: MAINNET_USDC, deployment, fetchFn: async () => { throw new Error("no read"); }, rpcs: NETWORKS.testnet.rpcs, write: {}, wait: 0 });
  assert.match(t.lines[0], /^BAD only 0 operator\(s\) in .*not a mainnet host.*want two mainnet operators$/);
});

test("the check never signs: without --tx, a vault whose reads pass ends in the write's one near CLI line, on either network", async () => {
  const r = await run(good(), { write: { signer: SIGNER, precommitment: "12345" } });
  assert.equal(r.pending, true);
  assert.equal(r.ok, false);
  assert.deepEqual(r.prepay, { precommitment: "12345", deposit: MIN });
  assert.equal(r.line, `near contract call-function as-transaction ${VAULT} storage_prepay json-args '{"precommitment":"12345"}' prepaid-gas '30 Tgas' attached-deposit '0.00756 NEAR' sign-as ${SIGNER} network-config testnet sign-with-keychain send`);
  assert.equal(pasteLine({ network: "mainnet", account: "vault.blindfill.near", signer: "owner.near", precommitment: "7", deposit: MIN }), `near contract call-function as-transaction vault.blindfill.near storage_prepay json-args '{"precommitment":"7"}' prepaid-gas '30 Tgas' attached-deposit '0.00756 NEAR' sign-as owner.near network-config mainnet sign-with-keychain send`);
  assert.equal(pasteLine({ network: "mainnet", account: "a.near", signer: "b.near", precommitment: "7", deposit: 10n ** 24n + 1n }).match(/'([^']+) NEAR'/)[1], "1.000000000000000000000001");
  assert.match(freshPrecommitment(), /^[1-9]\d{40,75}$/);
  // a signer of the other network is refused, and no line is printed
  const m = await run(good(), { write: { signer: "owner.near" } });
  assert.equal(m.ok, false);
  assert.equal(m.pending, undefined);
  assert.equal(bads(m).at(-1), "BAD the write's signer owner.near is not a testnet account");
  // the check imports no signing code and no key loader
  const src = readFileSync(path.join(HERE, "vault-mainnet.mjs"), "utf8");
  assert.doesNotMatch(src, /\bsign\(|loadKey|key-file|privateKey/);
});

test("the CLI: --key-file is no argument of the check; mainnet wants its record; vault-readback.mjs is the same check", () => {
  const cli = (f, args) => spawnSync(process.execPath, [path.join(HERE, f), ...args], { encoding: "utf8" });
  const k = cli("vault-mainnet.mjs", ["--network", "testnet", "--account", VAULT, "--signer", SIGNER, "--key-file", "/nonexistent"]);
  assert.equal(k.status, 2);
  assert.match(k.stderr, /argument --key-file: want /);
  const d = cli("vault-mainnet.mjs", ["--network", "mainnet", "--account", "vault.x.near", "--signer", "o.near"]);
  assert.equal(d.status, 2);
  assert.match(d.stderr, /--deployment <file> is required on mainnet/);
  const w = cli("vault-readback.mjs", ["--network", "mainnet", "--account", "vault.x.near", "--signer", "o.near"]);
  assert.equal(w.status, 2);
  assert.equal(w.stderr, d.stderr);
});
