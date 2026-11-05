// node --test scripts/live-checks/vault-mainnet-test.test.mjs: card vault-mainnet-test's live check replays its recorded
// runs on mainnet's two operators (FastNEAR, dRPC) with the entry's fixed account, record and signer:
//   - vault-mainnet-test.bad-absent.answers.json: vault-test.confidential.unrlzd.near read before its deploy (5 Nov
//     11:19Z, blocks 223158625-223158627): no account, so no code hash, code or config() on either RPC. It must FAIL,
//     and nothing may be written. Its key list reads [] (an account that does not exist has no key), so keys [] alone
//     never passes a vault: the code hash and config() reads must fail it.
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
