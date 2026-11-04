// node --test contracts/vault/scripts/prepay.test.mjs: the read-back's testnet write (card vault-readback). The reads
// replay scripts/live-checks/vault-mainnet.answers.json; `status`, the key's nonce, the block and the send are a stub
// that keeps the signed bytes, and every tx read answers the recorded landed write made to match what was signed, so the
// test reads what would be signed with a key made here. No network.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { b58encode } from "./near-tx.mjs";
import { prepay } from "./prepay.mjs";
import { PREPAY_GAS } from "../../../scripts/live-checks/vault-mainnet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE = path.resolve(HERE, "../../../scripts/live-checks");
const load = (f) => JSON.parse(readFileSync(path.join(LIVE, f), "utf8"));
const deployment = JSON.parse(readFileSync(path.resolve(HERE, "../deployments/testnet-v1.json"), "utf8"));
const VAULT = deployment.account_id;
const SIGNER = "bf-rb-20261104t183046.testnet";
const MIN = 756n * 10n ** 19n;
const RECORDED_P = "170939303965139770475647005542589386951066595781384355983336340405127965496";

function chain(answers, { chainId = "testnet", sendError = null } = {}) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  const recordedTx = answers.find((a) => a.method === "tx")?.json;
  const seen = { sent: [], methods: [] };
  const reply = (json) => ({ ok: true, status: 200, json: async () => json });
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    seen.methods.push(method);
    if (method === "status") return reply({ result: { chain_id: chainId } });
    if (method === "query" && params.request_type === "view_access_key") return reply({ result: { nonce: 41 } });
    if (method === "block") return reply({ result: { header: { hash: "11111111111111111111111111111111" } } });
    if (method === "send_tx") {
      seen.sent.push(Buffer.from(params.signed_tx_base64, "base64"));
      return reply(sendError ? { error: sendError } : { result: {} });
    }
    if (method === "tx") {
      // the recorded write, as the signed one: its hash and precommitment
      const p = seen.sent.length ? /\{"precommitment":"(\d+)"\}/.exec(seen.sent[0].toString("latin1"))[1] : RECORDED_P;
      const j = JSON.parse(JSON.stringify(recordedTx).replaceAll(RECORDED_P, p));
      j.result.transaction.hash = params.tx_hash;
      j.result.transaction.actions[0].FunctionCall.args = Buffer.from(JSON.stringify({ precommitment: p })).toString("base64");
      return reply(j);
    }
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} on ${url}`);
    return reply(a.json);
  };
  return { fetchFn, seen };
}

const freshKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, pub: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url") };
};

test("a vault whose reads pass, on an RPC that says testnet: the printed storage_prepay, signed by the key, then read back: PASS", async () => {
  const key = freshKey();
  const { fetchFn, seen } = chain(load("vault-mainnet.answers.json"));
  const r = await prepay({ account: VAULT, deployment, signer: SIGNER, key, fetchFn, wait: 0 });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(seen.sent.length, 1);
  assert.ok(seen.methods.indexOf("status") < seen.methods.indexOf("send_tx"));
  const signed = seen.sent[0];
  const tx = signed.subarray(0, -65);
  const h = createHash("sha256").update(tx).digest();
  assert.ok(verify(null, h, key.publicKey, signed.subarray(-64)));
  assert.equal(r.tx, b58encode(h));
  const s = tx.toString("latin1");
  assert.ok(s.includes(SIGNER) && s.includes(VAULT) && s.includes("storage_prepay") && s.includes(`{"precommitment":"${r.precommitment}"}`));
  const tail = tx.subarray(-24);
  assert.equal(tail.readBigUInt64LE(0), PREPAY_GAS);
  assert.equal(tail.readBigUInt64LE(8) + (tail.readBigUInt64LE(16) << 64n), MIN);
  assert.ok(r.lines.includes(`    sent storage_prepay tx ${r.tx} by ${SIGNER} on https://test.rpc.fastnear.com`));
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  the tx is one storage_prepay of precommitment ${r.precommitment} with exactly ${MIN} yocto`)).length, 2);
});

test("an RPC that answers chain_id mainnet: nothing is signed or sent", async () => {
  const { fetchFn, seen } = chain(load("vault-mainnet.answers.json"), { chainId: "mainnet" });
  await assert.rejects(prepay({ account: VAULT, deployment, signer: SIGNER, key: freshKey(), fetchFn, wait: 0 }), /answers chain_id mainnet, not testnet: nothing signed/);
  assert.equal(seen.sent.length, 0);
  assert.ok(!seen.methods.includes("block") && !seen.methods.includes("send_tx"));
});

test("a send_tx refusal is said by its name, and the read-back still decides", async () => {
  const { fetchFn } = chain(load("vault-mainnet.answers.json"), { sendError: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION" } } });
  const r = await prepay({ account: VAULT, deployment, signer: SIGNER, key: freshKey(), fetchFn, wait: 0 });
  assert.ok(r.lines.some((l) => l.startsWith(`    sent storage_prepay tx ${r.tx} by ${SIGNER} on `) && l.endsWith(": send_tx answered send_tx on https://test.rpc.fastnear.com: HANDLER_ERROR: INVALID_TRANSACTION")), r.lines.join("\n"));
});

test("a vault that fails a read (a full-access key, no code): nothing is signed or sent: FAIL", async () => {
  const { fetchFn, seen } = chain(load("vault-mainnet.bad-key.answers.json"));
  const r = await prepay({ account: "bf-vt-20261102t071444.testnet", deployment, signer: SIGNER, key: freshKey(), fetchFn, wait: 0 });
  assert.equal(r.ok, false);
  assert.equal(seen.sent.length, 0);
  assert.ok(!seen.methods.includes("status") && !seen.methods.includes("send_tx"));
  assert.equal(r.lines.at(-1), "BAD no storage_prepay: a read above failed, so nothing is written to this vault");
});

test("the CLI: testnet accounts only, a named .testnet signer (never 64-hex) and a key file outside the repo, refused before any read", () => {
  const cli = (args) => spawnSync(process.execPath, [path.join(HERE, "prepay.mjs"), ...args], { encoding: "utf8" });
  for (const signer of ["owner.near", "ab".repeat(32)]) {
    const m = cli(["--account", VAULT, "--signer", signer, "--key-file", "/nonexistent"]);
    assert.equal(m.status, 2, signer);
    assert.match(m.stderr, /the signer a named \.testnet one \(testnet only: a mainnet write is the owner's paste, and a 64-hex account is the same account on mainnet\)/);
  }
  const k = cli(["--account", VAULT, "--signer", SIGNER]);
  assert.equal(k.status, 2);
  assert.match(k.stderr, /--key-file <path> is required/);
  const inRepo = cli(["--account", VAULT, "--signer", SIGNER, "--key-file", path.join(HERE, "prepay.mjs")]);
  assert.equal(inRepo.status, 2);
  assert.match(inRepo.stderr, /--key-file is inside the repository/);
});
