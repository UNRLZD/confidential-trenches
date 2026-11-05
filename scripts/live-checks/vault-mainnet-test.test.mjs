// node --test scripts/live-checks/vault-mainnet-test.test.mjs: card vault-mainnet-test's live check replays its recorded
// runs on mainnet's two operators (FastNEAR, dRPC) with the entry's fixed account, record and signer:
//   - vault-mainnet-test.bad-absent.answers.json: vault-test.confidential.unrlzd.near read before its deploy (5 Nov
//     11:19Z, blocks 223158625-223158627): no account, so no code hash, code or config() on either RPC. It must FAIL,
//     and nothing may be written. Its key list reads [] (an account that does not exist has no key), so keys [] alone
//     never passes a vault: the code hash and config() reads must fail it.
//   - vault-mainnet-test.answers.json: the deployed vault read back after paste 4 (5 Nov 13:32Z): keys [], the pinned
//     code hash, the code's imports and exports, config() with mainnet USDC and the record's scope on both RPCs, and
//     its storage_prepay tx 9sZPrcGpNau1fN25R9Xqdu9iKGMkRQvCSiHwFn4ZrNRt final on both. It must PASS; the same answer
//     with one key added to its key list must FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check } from "./vault-mainnet.mjs";
import { ACCOUNT, DEPLOYMENT, SIGNER } from "./vault-mainnet-test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));

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
const run = (answers, write = {}) => check({ network: "mainnet", account: ACCOUNT, deployment, fetchFn: replay(answers), write: { signer: SIGNER, ...write }, wait: 0 });
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the entry fixes the mainnet test vault, its record and its signer", () => {
  assert.equal(ACCOUNT, "vault-test.confidential.unrlzd.near");
  assert.equal(SIGNER, "confidential.unrlzd.near");
  assert.equal(deployment.account_id, ACCOUNT);
  assert.equal(deployment.parent, SIGNER);
  assert.equal(deployment.wasm_sha256, "57535ae7486f840d9c9d29934e265712c44ada1992abc14344e431c2f2caca6a");
});

test("recorded bad answer: the vault account before its deploy FAILs on its code, code hash and config(), and nothing is written", async () => {
  const answers = load("vault-mainnet-test.bad-absent.answers.json");
  assert.deepEqual([...new Set(answers.map((a) => a.url))], ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]);
  const r = await run(answers);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.equal(r.pending, undefined, "a write was offered for a vault that failed its reads");
  for (const what of [`${ACCOUNT} code hash on `, "code on ", "config() on "]) assert.equal(bads(r).filter((l) => l.startsWith(`BAD ${what}`) && l.endsWith("UNKNOWN_ACCOUNT")).length, 2, `${what}\n${r.lines.join("\n")}`);
  assert.ok(bads(r).includes("BAD no storage_prepay: a read above failed, so nothing is written to this vault"));
  // the key list of an account that does not exist reads []: the check passes that line and fails the vault anyway
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\] on /.test(l)).length, 2);
});

// the recorded storage_prepay: its hash and the precommitment it carries, read from the recorded tx itself
function goodWrite(answers) {
  const t = answers.find((a) => a.method === "tx").json.result.transaction;
  return { tx: t.hash, precommitment: JSON.parse(Buffer.from(t.actions[0].FunctionCall.args, "base64").toString()).precommitment };
}

test("recorded good answer: the deployed vault PASSes on both RPCs, keyless, the pin, its config and its storage_prepay", async () => {
  const answers = load("vault-mainnet-test.answers.json");
  assert.deepEqual([...new Set(answers.map((a) => a.url))], ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]);
  const w = goodWrite(answers);
  assert.equal(w.tx, "9sZPrcGpNau1fN25R9Xqdu9iKGMkRQvCSiHwFn4ZrNRt");
  const r = await run(answers, w);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(bads(r), []);
  assert.equal(r.lines.filter((l) => /^ok  \S+ key list is \[\] on /.test(l)).length, 2, r.lines.join("\n"));
  assert.equal(r.tx, w.tx);
  const config = JSON.parse(Buffer.from(answers.find((a) => a.params.method_name === "config").json.result.result).toString());
  assert.equal(config.scope, deployment.scope);
  assert.equal(config.asset, deployment.asset);
});

test("recorded good answer with a key added to the vault's key list FAILs", async () => {
  const answers = load("vault-mainnet-test.answers.json");
  const a = answers.find((x) => x.url === "https://near.drpc.org" && x.params.request_type === "view_access_key_list");
  a.json.result.keys = [{ public_key: "ed25519:WHHJ4Rmp2dzkkWtE5UuNkeEnw6JCnXLPrnXV6fiQhhh", access_key: { nonce: 0, permission: "FullAccess" } }];
  const r = await run(answers, goodWrite(answers));
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bads(r).some((l) => l.includes("key") && l.includes("near.drpc.org")), r.lines.join("\n"));
});
