// node --test scripts/live-checks/vault-mainnet.test.mjs: the live check replays recorded runs. The good answer
// (vault-mainnet.answers.json) is the testnet vault of testnet-v1.json and the write the check printed, run through
// near-cli 4.0.13 as printed (tx DCrm53kfRcZiMRBQPevDcftUTPSVT9L1kLtSsRpFzyc2), read back with --tx and
// --precommitment on FastNEAR and dRPC: it must PASS. The recorded bad answers must FAIL:
//   - vault-mainnet.bad-key.answers.json: the vault's parent bf-vt-20261102t071444.testnet, one full-access key, no code;
//   - vault-mainnet.bad-code.answers.json: another keyless vault, the 1 Nov skeleton, whose code hash is another build's;
//   - vault-mainnet.bad-import.answers.json: the account `testnet`, whose code imports the add-key, deploy and
//     create-account actions;
//   - vault-mainnet.bad-write.answers.json: the good vault, then a storage_prepay with 1 yocto attached that the vault
//     refused (InsufficientStorageDeposit), tx bbHFD9BhLGhwchkCAjAXeB217QCwxh8g6v167gkvkck: a write that never landed;
//   - vault-mainnet.bad-mainnet.answers.json: the mainnet reads, on mainnet's two operators, of mainnet USDC's account
//     (a key, other code), so the mainnet path is read for real and fails on what it reads.
// The rest are planted here from the good answer, each changing one thing so that only its guard can fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, pasteLine, freshPrecommitment, isPrecommitment, NETWORKS, NEAR_CLI } from "./vault-mainnet.mjs";
import { DEPLOYMENT, MAINNET_USDC } from "./vault-testnet-t01.mjs";
// the reads' waits (a rate limit's, the pacing between asks) recorded as asked, never slept, so replays run at once
const NOSLEEP = async () => {};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
const VAULT = deployment.account_id;
const SIGNER = "bf-rb-20261104t183046.testnet";
const GOOD_TX = "DCrm53kfRcZiMRBQPevDcftUTPSVT9L1kLtSsRpFzyc2";
const GOOD_P = "170939303965139770475647005542589386951066595781384355983336340405127965496";
const BAD_TX = "bbHFD9BhLGhwchkCAjAXeB217QCwxh8g6v167gkvkck";
const BAD_P = "356256644042298854250834637283244124066599756060357939171523605883869495921";
const MIN = 756n * 10n ** 19n;
const ONE_NEAR = "1000000000000000000000000";
const FASTNEAR = "https://test.rpc.fastnear.com";
const DRPC = "https://near-testnet.drpc.org";

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
const run = (answers, o = {}) => check({ sleep: NOSLEEP, network: "testnet", account: VAULT, deployment, fetchFn: replay(answers), write: { signer: SIGNER, tx: GOOD_TX, precommitment: GOOD_P }, wait: 0, ...o });
// the good answer with every tx read (or only `only`'s) changed by f on a copy
const withTx = (answers, f, only) => answers.map((a) => (a.method === "tx" && (!only || a.url === only) ? { ...a, json: f(structuredClone(a.json)) } : a));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
// every BAD line starts with one of `starts`, and each of them is there `times` times
function onlyBad(r, starts, times = 2) {
  assert.equal(r.ok, false);
  for (const l of bads(r)) assert.ok(starts.some((s) => l.startsWith(s)), `unexpected: ${l}\n${r.lines.join("\n")}`);
  for (const s of starts) assert.equal(bads(r).filter((l) => l.startsWith(s)).length, times, `${s}\n${r.lines.join("\n")}`);
}
const IDENTITY = `BAD the tx is ${GOOD_TX} from ${SIGNER} to ${VAULT} on `;
const CALL = `BAD the tx is one storage_prepay of precommitment ${GOOD_P} with exactly ${MIN} yocto on `;
const RAN = "BAD the tx and every receipt succeeded on ";
const EVENT = `BAD ${VAULT} logged one storage_prepaid `;

test("recorded good answer: keys [], the build's code hash and imports, config() and the printed write landed, on two RPCs: PASS", async () => {
  const answers = good();
  assert.deepEqual([...new Set(answers.map((a) => a.url))], [FASTNEAR, DRPC]);
  const r = await run(answers);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 5 + 2 * 10 + 2 + 2 * 5);
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\] on .*: 0 key\(s\) at block/.test(l)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  ${VAULT} code hash ${deployment.code_hash} equals`)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith("ok  no banned import on ") && l.endsWith(": none")).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  storage_prepay tx ${GOOD_TX} by ${SIGNER} is final on `) && l.endsWith(": FINAL")).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  the tx is one storage_prepay of precommitment ${GOOD_P} with exactly ${MIN} yocto`)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  ${VAULT} logged one storage_prepaid {"precommitment":"${GOOD_P}","payer":"${SIGNER}","amount":"${MIN}"}`)).length, 2);
});

test("recorded bad answer: an ordinary account with one full-access key: FAIL on its key list, and nothing is written", async () => {
  const answers = load("vault-mainnet.bad-key.answers.json");
  const f = replay(answers);
  const r = await check({ sleep: NOSLEEP, network: "testnet", account: answers[0].params.account_id, deployment, fetchFn: f, write: { signer: SIGNER, tx: GOOD_TX, precommitment: GOOD_P }, wait: 0 });
  assert.equal(r.ok, false);
  assert.equal(bads(r).filter((l) => /^BAD \S+ key list is \[\] on .*: 1 key\(s\) \(FullAccess\)/.test(l)).length, 2, r.lines.join("\n"));
  assert.equal(r.lines.at(-1), "BAD no storage_prepay: a read above failed, so nothing is written to this vault");
  assert.ok(!f.asked.includes("tx") && !f.asked.includes("send_tx"));
});

test("recorded bad answer: another keyless vault with another code hash: FAIL on the code hash, the keys pass", async () => {
  const answers = load("vault-mainnet.bad-code.answers.json");
  const r = await check({ sleep: NOSLEEP, network: "testnet", account: "vault.bf-vs-20261101t012200.testnet", deployment, fetchFn: replay(answers), write: { signer: SIGNER, tx: GOOD_TX, precommitment: GOOD_P }, wait: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\]/.test(l)).length, 2);
  assert.equal(bads(r).filter((l) => / code hash GGfTdwuLbonERu3vKnpLF828eyWZ4DxS24kpLp67PmSn equals the record's /.test(l)).length, 2, r.lines.join("\n"));
  assert.equal(bads(r).filter((l) => l.startsWith("BAD code sha256 e2e28086")).length, 2);
});

test("recorded bad answer: code that imports the add-key and deploy actions: FAIL on the import list", async () => {
  const answers = load("vault-mainnet.bad-import.answers.json");
  const r = await check({ sleep: NOSLEEP, network: "testnet", account: "testnet", deployment, fetchFn: replay(answers), write: { signer: SIGNER, tx: GOOD_TX, precommitment: GOOD_P }, wait: 0 });
  assert.equal(r.ok, false);
  const banned = bads(r).filter((l) => l.startsWith("BAD no banned import on "));
  assert.equal(banned.length, 2, r.lines.join("\n"));
  for (const l of banned) for (const i of ["promise_batch_action_add_key_with_full_access", "promise_batch_action_deploy_contract"]) assert.ok(l.includes(i), l);
});

test("recorded bad answer: a storage_prepay the vault refused (1 yocto, InsufficientStorageDeposit): FAIL on the write only", async () => {
  const r = await run(load("vault-mainnet.bad-write.answers.json"), { write: { signer: SIGNER, tx: BAD_TX, precommitment: BAD_P } });
  onlyBad(r, [`BAD the tx is one storage_prepay of precommitment ${BAD_P} with exactly ${MIN} yocto on `, RAN, EVENT]);
  assert.equal(bads(r).filter((l) => l.startsWith(RAN) && l.includes("InsufficientStorageDeposit")).length, 2);
});

// MEDIUM-1: the read-back is of the write printed, exactly
test("planted: the tx's precommitment is not the printed one: FAIL on the call and the event", async () => {
  const r = await run(good(), { write: { signer: SIGNER, tx: GOOD_TX, precommitment: "12345" } });
  onlyBad(r, ["BAD the tx is one storage_prepay of precommitment 12345 with exactly ", `BAD ${VAULT} logged one storage_prepaid {"precommitment":"12345"`]);
});

test("planted: the tx attaches 1 NEAR, not the printed minimum (its event says the same): FAIL on the call and the event", async () => {
  const r = await run(withTx(good(), (j) => {
    j.result.transaction.actions[0].FunctionCall.deposit = ONE_NEAR;
    for (const o of j.result.receipts_outcome) o.outcome.logs = o.outcome.logs.map((l) => l.replace(`"amount":"${MIN}"`, `"amount":"${ONE_NEAR}"`));
    return j;
  }));
  onlyBad(r, [CALL, EVENT]);
});

test("planted: --tx without the printed precommitment, or with one that is no canonical decimal below p: FAIL, nothing read", async () => {
  for (const precommitment of [undefined, "0x12", "012", "21888242871839275222246405745257275088548364400416034343698204186575808495617"]) {
    const f = replay(good());
    const r = await check({ sleep: NOSLEEP, network: "testnet", account: VAULT, deployment, fetchFn: f, write: { signer: SIGNER, tx: GOOD_TX, precommitment }, wait: 0 });
    assert.equal(r.ok, false);
    assert.match(bads(r).at(-1), /^BAD the write's precommitment .* is not one canonical decimal below p: --tx needs the --precommitment printed/);
    assert.ok(!f.asked.includes("tx"), String(precommitment));
  }
  assert.equal(isPrecommitment("21888242871839275222246405745257275088548364400416034343698204186575808495616"), true);
});

// MEDIUM-3: each guard of the read-back, planted from the good answer
test("planted: config() differs between the two RPCs: FAIL on that line only, and nothing is written", async () => {
  const answers = good().map((a) => {
    if (a.url !== DRPC || a.params.method_name !== "config") return a;
    const cfg = JSON.parse(Buffer.from(a.json.result.result).toString("utf8"));
    return { ...a, json: { ...a.json, result: { ...a.json.result, result: [...Buffer.from(JSON.stringify({ ...cfg, page_max: 999 }))] } } };
  });
  const r = await run(answers);
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r), ["BAD config() is the same on both RPCs: no", "BAD no storage_prepay: a read above failed, so nothing is written to this vault"]);
});

test("planted: config() names another deposit_storage_bytes on both RPCs: FAIL on that line, nothing is written", async () => {
  const answers = good().map((a) => {
    if (a.params.method_name !== "config") return a;
    const cfg = JSON.parse(Buffer.from(a.json.result.result).toString("utf8"));
    return { ...a, json: { ...a.json, result: { ...a.json.result, result: [...Buffer.from(JSON.stringify({ ...cfg, deposit_storage_bytes: 700 }))] } } };
  });
  const r = await run(answers);
  assert.deepEqual(bads(r), ["BAD config() names deposit_storage_bytes 756: 700", "BAD no storage_prepay: a read above failed, so nothing is written to this vault"]);
});

for (const [name, f] of [
  ["another signer", (j) => ((j.result.transaction.signer_id = "someone.testnet"), j)],
  ["another receiver", (j) => ((j.result.transaction.receiver_id = "other.testnet"), j)],
  ["another tx's hash", (j) => ((j.result.transaction.hash = BAD_TX), j)],
]) {
  test(`planted: the tx answer names ${name}: FAIL on the tx's identity only`, async () => onlyBad(await run(withTx(good(), f)), [IDENTITY]));
}

for (const [name, f] of [
  ["another method", (j) => ((j.result.transaction.actions[0].FunctionCall.method_name = "storage_deposit"), j)],
  ["two actions", (j) => (j.result.transaction.actions.push(j.result.transaction.actions[0]), j)],
  ["a precommitment that is no decimal", (j) => ((j.result.transaction.actions[0].FunctionCall.args = b64({ precommitment: `0x${BigInt(GOOD_P).toString(16)}` })), j)],
]) {
  test(`planted: the tx holds ${name}: FAIL on the call only`, async () => onlyBad(await run(withTx(good(), f)), [CALL]));
}

test("planted: the tx is EXECUTED, not FINAL, on dRPC: FAIL on that line only", async () => {
  onlyBad(await run(withTx(good(), (j) => ((j.result.final_execution_status = "EXECUTED"), j), DRPC)), [`BAD storage_prepay tx ${GOOD_TX} by ${SIGNER} is final on ${DRPC}`], 1);
});

test("planted: one receipt failed under a SuccessValue tx status, on FastNEAR only: FAIL there only", async () => {
  onlyBad(await run(withTx(good(), (j) => ((j.result.receipts_outcome[1].outcome.status = { Failure: { ActionError: { index: 0 } } }), j), FASTNEAR)), [`${RAN}${FASTNEAR}`], 1);
});

test("planted: one receipt not run yet (status Unknown) under a SuccessValue tx status: FAIL", async () => {
  onlyBad(await run(withTx(good(), (j) => ((j.result.receipts_outcome[1].outcome.status = "Unknown"), j))), [RAN]);
});

test("planted: the tx status is a Failure while every receipt says success: FAIL", async () => {
  onlyBad(await run(withTx(good(), (j) => ((j.result.status = { Failure: { ActionError: { index: 0 } } }), j))), [RAN]);
});

test("planted: the event is logged by the signer's receipt, not the vault's: FAIL on the event only", async () => {
  onlyBad(await run(withTx(good(), (j) => {
    const v = j.result.receipts_outcome.find((o) => o.outcome.executor_id === VAULT);
    const s = j.result.receipts_outcome.find((o) => o.outcome.executor_id === SIGNER);
    s.outcome.logs = v.outcome.logs;
    v.outcome.logs = [];
    return j;
  })), [EVENT]);
});

test("planted: the vault's event holds two entries, or the vault logs it twice: FAIL on the event only", async () => {
  const doubled = (j) => {
    const v = j.result.receipts_outcome.find((o) => o.outcome.executor_id === VAULT);
    v.outcome.logs = v.outcome.logs.map((l) => {
      const e = JSON.parse(l.slice("EVENT_JSON:".length));
      return `EVENT_JSON:${JSON.stringify({ ...e, data: [e.data[0], e.data[0]] })}`;
    });
    return j;
  };
  onlyBad(await run(withTx(good(), doubled)), [EVENT]);
  onlyBad(await run(withTx(good(), (j) => {
    const v = j.result.receipts_outcome.find((o) => o.outcome.executor_id === VAULT);
    v.outcome.logs = [...v.outcome.logs, ...v.outcome.logs];
    return j;
  })), [EVENT]);
});

test("planted: the vault's storage_prepaid event is under another standard: FAIL on the event only", async () => {
  onlyBad(await run(withTx(good(), (j) => {
    for (const o of j.result.receipts_outcome) o.outcome.logs = o.outcome.logs.map((l) => l.replace('"standard":"blindfill-vault"', '"standard":"nep141"'));
    return j;
  })), [EVENT]);
});

test("planted: the tx's args hold the precommitment and one more field: FAIL on the call only (the args bytes are the printed ones)", async () => {
  onlyBad(await run(withTx(good(), (j) => ((j.result.transaction.actions[0].FunctionCall.args = b64({ precommitment: GOOD_P, extra: 1 })), j))), [CALL]);
  onlyBad(await run(withTx(good(), (j) => ((j.result.transaction.actions[0].FunctionCall.args = Buffer.from(`{ "precommitment": "${GOOD_P}" }`).toString("base64")), j))), [CALL]);
});

test("planted: the vault's event names another payer: FAIL on the event only", async () => {
  onlyBad(await run(withTx(good(), (j) => {
    for (const o of j.result.receipts_outcome) o.outcome.logs = o.outcome.logs.map((l) => l.replace(`"payer":"${SIGNER}"`, '"payer":"someone.testnet"'));
    return j;
  })), [EVENT]);
});

test("planted: the write's tx is unknown on both RPCs (it never landed): FAIL on the read-back only", async () => {
  const unknown = { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, message: "Server error" } };
  const r = await run(good().map((a) => (a.method === "tx" ? { ...a, json: unknown } : a)));
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r).map((l) => l.replace(/ on https:\/\/[^\s:]+/, "")), [`BAD storage_prepay tx ${GOOD_TX} by ${SIGNER}: HANDLER_ERROR: UNKNOWN_TRANSACTION`, `BAD storage_prepay tx ${GOOD_TX} by ${SIGNER}: HANDLER_ERROR: UNKNOWN_TRANSACTION`]);
});

test("planted: the tx read answers an error other than not-yet-known: FAIL at once, read once per RPC; not-yet-known is read again", async () => {
  const refused = { jsonrpc: "2.0", id: "x", error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR" }, message: "Parse error" } };
  const f = replay(good().map((a) => (a.method === "tx" ? { ...a, json: refused } : a)));
  const r = await check({ sleep: NOSLEEP, network: "testnet", account: VAULT, deployment, fetchFn: f, write: { signer: SIGNER, tx: GOOD_TX, precommitment: GOOD_P }, wait: 0 });
  onlyBad(r, [`BAD storage_prepay tx ${GOOD_TX} by ${SIGNER} on `]);
  assert.equal(f.asked.filter((m) => m === "tx").length, 2);
  const unknown = { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, message: "Server error" } };
  const u = replay(good().map((a) => (a.method === "tx" ? { ...a, json: unknown } : a)));
  await check({ sleep: NOSLEEP, network: "testnet", account: VAULT, deployment, fetchFn: u, write: { signer: SIGNER, tx: GOOD_TX, precommitment: GOOD_P }, wait: 0 });
  assert.equal(u.asked.filter((m) => m === "tx").length, 2 * 10, "ten reads per RPC before a tx counts as never landed");
});

test("planted: a full-access key in the vault's key list: FAIL on the key list, and no write is offered or read", async () => {
  const key = { public_key: "ed25519:EhjW27bK6ojYS7oWrNQjTjgKgdv8QwfqVQVzSD2YxR51", access_key: { nonce: 1, permission: "FullAccess" } };
  const answers = good().map((a) => (a.params.request_type === "view_access_key_list" ? { ...a, json: { ...a.json, result: { ...a.json.result, keys: [key] } } } : a));
  const f = replay(answers);
  const r = await check({ sleep: NOSLEEP, network: "testnet", account: VAULT, deployment, fetchFn: f, write: { signer: SIGNER }, wait: 0 });
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 3, r.lines.join("\n"));
  assert.ok(!f.asked.includes("send_tx") && !f.asked.includes("tx"));
  assert.equal(r.pending, undefined, "a vault that fails a read gets no write line");
});

// LOW-1: the record is this vault's, on this network's token
test("planted record: another account, another asset, another network, builds that disagree, a code_hash not its sha256's: FAIL on each", async () => {
  const cases = [
    [{ account_id: "other.testnet" }, `BAD the record is ${VAULT}'s: other.testnet`],
    [{ asset: "someone-else.testnet" }, "BAD the record's asset is the testnet token "],
    [{ network: "mainnet" }, "BAD the record is a testnet record: mainnet"],
    [{ wasm_builds_sha256: [deployment.wasm_sha256, "00".repeat(32)] }, "BAD the record's builds agree "],
    [{ code_hash: "GGfTdwuLbonERu3vKnpLF828eyWZ4DxS24kpLp67PmSn" }, "BAD the record's code_hash "],
  ];
  for (const [change, line] of cases) {
    const r = await run(good(), { deployment: { ...deployment, ...change } });
    assert.equal(r.ok, false);
    assert.ok(bads(r).some((l) => l.startsWith(line)), `${JSON.stringify(change)}\n${r.lines.join("\n")}`);
  }
});

test("the same answers on one RPC, or on two hosts of one operator: FAIL on the operators", async () => {
  const one = await run(good(), { rpcs: [FASTNEAR] });
  assert.equal(one.ok, false);
  assert.match(one.lines[0], /^BAD only 1 RPC\(s\)/);
  const NEAR_ORG = "https://rpc.testnet.near.org";
  const answers = good().map((a) => (a.url === DRPC ? { ...a, url: NEAR_ORG } : a));
  const r = await run(answers, { rpcs: [FASTNEAR, NEAR_ORG] }); // near-rpc-operators: one operator (planted: the same-operator case this check must refuse)
  assert.equal(r.ok, false);
  assert.match(bads(r)[0], /^BAD only 1 operator\(s\) in .*want two testnet operators$/);
});

test("recorded mainnet reads: mainnet USDC's account on mainnet's two operators: FAIL on what it read, never on the operators", async () => {
  const answers = load("vault-mainnet.bad-mainnet.answers.json");
  assert.deepEqual([...new Set(answers.map((a) => a.url))], NETWORKS.mainnet.rpcs);
  const r = await check({ sleep: NOSLEEP, network: "mainnet", account: MAINNET_USDC, deployment: { ...deployment, network: "mainnet" }, fetchFn: replay(answers), write: { signer: "owner.near" }, wait: 0 });
  assert.equal(r.ok, false);
  assert.ok(!r.lines.some((l) => / operator\(s\)/.test(l)), r.lines.join("\n"));
  assert.equal(bads(r).filter((l) => / key list is \[\] on .*1 key\(s\) \(FullAccess\)/.test(l)).length, 2);
  assert.equal(bads(r).filter((l) => l.startsWith("BAD the code names mainnet USDC and no other on ")).length, 2);
  const t = await check({ sleep: NOSLEEP, network: "mainnet", account: MAINNET_USDC, deployment, fetchFn: async () => { throw new Error("no read"); }, rpcs: NETWORKS.testnet.rpcs, write: {}, wait: 0 });
  assert.match(t.lines[0], /^BAD only 0 operator\(s\) in .*not a mainnet host.*want two mainnet operators$/);
});

test("signers: every NEAR account id of the network passes, the other network's are refused", () => {
  for (const s of ["owner.near", "sweat", "owner.tg", "a.b.near", "0x1234567890abcdef1234567890abcdef12345678", "ab".repeat(32)]) assert.equal(NETWORKS.mainnet.account.test(s), true, s);
  for (const s of ["x.testnet", "testnet", "Owner.near", "a", "a..near", "-a.near", undefined]) assert.equal(NETWORKS.mainnet.account.test(s), false, String(s));
  for (const s of ["x.testnet", "testnet", "ab".repeat(32)]) assert.equal(NETWORKS.testnet.account.test(s), true, s);
  for (const s of ["owner.near", "sweat", undefined]) assert.equal(NETWORKS.testnet.account.test(s), false, String(s));
});

// MEDIUM-2: the line is near-cli 4.0.13's, read as a shell reads it
const NEAR_CALL_FLAGS = ["--useAccount", "--depositYocto", "--gas", "--networkId", "--signWithLedger"]; // `near call --help`, near-cli 4.0.13
const argvOf = (line) => {
  const r = spawnSync("sh", ["-c", `near() { printf '%s\\0' "$@"; }; ${line}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\0").slice(0, -1);
};

test(`the check never signs: without --tx, a vault whose reads pass ends in the write as ${NEAR_CLI} lines, which a shell reads as the call`, async () => {
  const r = await run(good(), { write: { signer: SIGNER, precommitment: "12345" } });
  assert.equal(r.pending, true);
  assert.equal(r.ok, false);
  assert.deepEqual(r.prepay, { precommitment: "12345", deposit: MIN });
  assert.deepEqual(argvOf(r.line), ["call", VAULT, "storage_prepay", '{"precommitment":"12345"}', "--useAccount", SIGNER, "--depositYocto", String(MIN), "--gas", "30000000000000", "--networkId", "testnet"]);
  assert.deepEqual(argvOf(r.ledgerLine), [...argvOf(r.line), "--signWithLedger"]);
  const m = pasteLine({ network: "mainnet", account: "vault.blindfill.near", signer: "owner.near", precommitment: GOOD_P, deposit: MIN });
  const argv = argvOf(m.line);
  assert.deepEqual(argv.slice(0, 3), ["call", "vault.blindfill.near", "storage_prepay"]);
  assert.deepEqual(JSON.parse(argv[3]), { precommitment: GOOD_P });
  assert.deepEqual(Object.fromEntries(argv.slice(4).reduce((p, x, i, a) => (i % 2 ? p : [...p, [x, a[i + 1]]]), [])), { "--useAccount": "owner.near", "--depositYocto": String(MIN), "--gas": "30000000000000", "--networkId": "mainnet" });
  for (const f of argvOf(m.ledgerLine).filter((x) => x.startsWith("--"))) assert.ok(NEAR_CALL_FLAGS.includes(f), f);
  assert.match(freshPrecommitment(), /^[1-9]\d{40,75}$/);
  assert.ok(isPrecommitment(freshPrecommitment()));
  const o = await run(good(), { write: { signer: "owner.near" } });
  assert.equal(o.pending, undefined);
  assert.equal(bads(o).at(-1), "BAD the write's signer owner.near is not a testnet account");
  const src = readFileSync(path.join(HERE, "vault-mainnet.mjs"), "utf8");
  assert.doesNotMatch(src, /\bsign\(|loadKey|key-file|privateKey/);
});

test("the CLI: the then-line carries the precommitment; --tx wants it; mainnet wants its record; vault-readback.mjs is the same check", () => {
  const cli = (f, args) => spawnSync(process.execPath, [path.join(HERE, f), ...args], { encoding: "utf8" });
  const t = cli("vault-mainnet.mjs", ["--network", "testnet", "--account", VAULT, "--signer", SIGNER, "--tx", GOOD_TX]);
  assert.equal(t.status, 2);
  assert.match(t.stderr, /--tx needs --precommitment <P>: the one the write line printed/);
  const bad = cli("vault-mainnet.mjs", ["--network", "testnet", "--account", VAULT, "--signer", SIGNER, "--tx", GOOD_TX, "--precommitment", "0x1"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--precommitment: want one canonical decimal below p/);
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

// The owner pastes these lines on mainnet: the CLI's own output, on the replayed good answer (a fetch stub loaded with
// --import, as contracts/vault/scripts/deploy.test.mjs runs deploy.mjs), must be exactly these, the record's path quoted.
test("the CLI prints the write, its Ledger variant and the read-back exactly, the --deployment path shell-quoted", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vault mainnet "));
  try {
    const record = path.join(dir, "it's a record.json");
    copyFileSync(DEPLOYMENT, record);
    const answers = path.join(dir, "answers.json");
    writeFileSync(answers, JSON.stringify(good()));
    const stub = path.join(dir, "stub.mjs");
    writeFileSync(stub, `import { readFileSync } from "node:fs";
const answers = JSON.parse(readFileSync(${JSON.stringify(answers)}, "utf8"));
const byKey = new Map(answers.map((a) => [\`\${a.url} \${a.method} \${JSON.stringify(a.params)}\`, a]));
globalThis.fetch = async (url, init) => {
  const { method, params } = JSON.parse(init.body);
  const a = byKey.get(\`\${url} \${method} \${JSON.stringify(params)}\`);
  if (!a) throw new Error("no recorded answer for " + method);
  return { ok: true, status: a.status, json: async () => a.json };
};
`);
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, path.join(HERE, "vault-mainnet.mjs"), "--network", "testnet", "--account", VAULT, "--signer", SIGNER, "--deployment", record, "--precommitment", "12345"], { encoding: "utf8" });
    assert.equal(r.status, 3, r.stderr);
    const q = `'${record.replaceAll("'", "'\\''")}'`;
    const call = `near call ${VAULT} storage_prepay '{"precommitment":"12345"}' --useAccount ${SIGNER} --depositYocto ${MIN} --gas 30000000000000 --networkId testnet`;
    assert.deepEqual(r.stdout.trim().split("\n").slice(-5), [
      `live-check vault-mainnet: the reads PASS; the write, signed by ${SIGNER} through ${NEAR_CLI} (this check signs nothing; on testnet contracts/vault/scripts/prepay.mjs can send it):`,
      call,
      "live-check vault-mainnet: or with a Ledger:",
      `${call} --signWithLedger`,
      `live-check vault-mainnet: then: node scripts/live-checks/vault-mainnet.mjs --network testnet --account ${VAULT} --signer ${SIGNER} --deployment ${q} --precommitment 12345 --tx <its Transaction Id>`,
    ]);
    // the read-back line, as a shell reads it, gives the record's path back whole
    const then = r.stdout.trim().split("\n").at(-1).replace("live-check vault-mainnet: then: ", "").replace("<its Transaction Id>", GOOD_TX);
    const argv = spawnSync("sh", ["-c", `node() { printf '%s\\0' "$@"; }; ${then}`], { encoding: "utf8" }).stdout.split("\0").slice(0, -1);
    assert.deepEqual(argv, ["scripts/live-checks/vault-mainnet.mjs", "--network", "testnet", "--account", VAULT, "--signer", SIGNER, "--deployment", record, "--precommitment", "12345", "--tx", GOOD_TX]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
