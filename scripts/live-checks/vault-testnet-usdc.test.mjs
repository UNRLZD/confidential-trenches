// node --test scripts/live-checks/vault-testnet-usdc.test.mjs: the live check replays recorded runs on NEAR testnet's
// RPCs. The good answer (vault-testnet-usdc.answers.json, the deployed token) must PASS. The bad answer must FAIL:
//   - vault-testnet-usdc.bad-code.answers.json: an account running other code (the vault skeleton,
//     vault.bf-vs-20261101t012200.testnet) checked against the same record.
// Two more bad answers are made here from the good one: a holder balance one base unit short, and the deploy tx read as
// failed. The deploy script's refusal of bytes that are not the pin, and its init's six names, are tested too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, liveRecord, DEPLOYMENT, USDC_CODE_HASH } from "./vault-testnet-usdc.mjs";
import { parseLive } from "../ci/money-gate.mjs";
import { wasmProblems, initArgs, INIT_NAMES, encodeTx, act } from "../../contracts/vault/scripts/testnet-usdc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
const sleep = async () => {};

// each request gets its last recorded answer (a 429 the run waited out is followed by the answer); a request the run
// never made is an error
function replay(answers, patch = (a) => a) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} ${params.request_type ?? ""} on ${url}`);
    const json = patch(structuredClone(a.json), { method, params });
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: new Headers(), json: async () => json };
  };
}

test("recorded good answer: the deployed token, its code hash, ft_metadata, the holder's balance, 26 txs: PASS", async () => {
  const r = await check({ deployment, fetchFn: replay(load("vault-testnet-usdc.answers.json")), sleep });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => l.startsWith("ok ") && l.includes(`code hash ${USDC_CODE_HASH} is mainnet USDC's`)).length, 2);
  assert.equal(r.lines.filter((l) => /^ok  ft_metadata answers on .*symbol USDC, decimals 6/.test(l)).length, 2);
  assert.equal(r.lines.filter((l) => l.startsWith(`ok  ft_balance_of(${deployment.holder}) is ${deployment.minted}`)).length, 2);
  assert.equal(deployment.txs.length, 26);
  assert.equal(r.lines.filter((l) => /^ok  tx \S+ .* ok on .* ok on /.test(l)).length, 26);
});

test("recorded bad answer: an account running other code: FAIL on its code hash, ft_metadata and balance", async () => {
  const answers = load("vault-testnet-usdc.bad-code.answers.json");
  const account = answers.find((a) => a.params?.request_type === "view_account").params.account_id;
  assert.notEqual(account, deployment.account_id);
  const r = await check({ deployment, account, fetchFn: replay(answers), sleep });
  assert.equal(r.ok, false);
  assert.equal(r.lines.filter((l) => /^BAD \S+ code hash \S+ is mainnet USDC's/.test(l)).length, 2, r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => /^BAD ft_metadata on .*MethodNotFound/.test(l)).length, 2, r.lines.join("\n"));
});

test("bad answer made from the good one: the holder one base unit short: FAIL", async () => {
  const short = String(BigInt(deployment.minted) - 1n);
  const patch = (json, { params }) => {
    if (params.method_name === "ft_balance_of") json.result.result = [...Buffer.from(JSON.stringify(short))];
    return json;
  };
  const r = await check({ deployment, fetchFn: replay(load("vault-testnet-usdc.answers.json"), patch), sleep });
  assert.equal(r.ok, false);
  assert.equal(r.lines.filter((l) => l.startsWith(`BAD ft_balance_of(${deployment.holder}) is ${short}`)).length, 2, r.lines.join("\n"));
});

test("bad answer made from the good one: the deploy tx read as failed: FAIL", async () => {
  const deploy = deployment.txs.find((t) => /deploy the USDC wasm/.test(t.what)).hash;
  const patch = (json, { method, params }) => {
    if (method === "tx" && params.tx_hash === deploy) json.result.status = { Failure: { ActionError: { index: 1 } } };
    return json;
  };
  const r = await check({ deployment, fetchFn: replay(load("vault-testnet-usdc.answers.json"), patch), sleep });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith(`BAD tx ${deploy} `) && /failed on /.test(l)), r.lines.join("\n"));
});

test("the live record parses for the money gate: Money path yes, every tx a near-testnet Tx line, none real money", async () => {
  const live = parseLive(liveRecord(deployment, { ok: true, lines: deployment.txs.map((t) => `ok  tx ${t.hash} (${t.what}) ok on a, ok on b`) }), "vault-testnet-usdc");
  assert.deepEqual(live.problems, []);
  assert.equal(live.verdict, "PASS");
  assert.equal(live.moneyPath, true);
  assert.equal(live.txs.length, 26);
  assert.equal(live.real.length, 0);
});

test("the deploy script refuses any bytes but the pin, and its init names are the six the code reads", () => {
  const notUsdc = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(100)]);
  const p = wasmProblems(notUsdc, USDC_CODE_HASH);
  assert.ok(p.some((x) => /want 321491/.test(x)) && p.some((x) => /want b98ccd53/.test(x)) && p.some((x) => /the RPC reports/.test(x)), p.join("; "));
  assert.deepEqual(Object.keys(initArgs("t.testnet", {})), INIT_NAMES);
  assert.deepEqual(INIT_NAMES, ["admin_ids", "master_minter_ids", "owner_ids", "pauser_ids", "blocklister_id", "metadata"]);
  assert.deepEqual(Object.keys(deployment.init), INIT_NAMES);
});

test("the deploy script's AddKey is a full-access key (nearcore Action 5, AccessKey { nonce 0, FullAccess = 1 })", () => {
  const pub = Buffer.alloc(32, 7);
  const tx = encodeTx({ signer: "a", publicKey: pub, nonce: 1n, receiver: "b", blockHash: Buffer.alloc(32), actions: [act.fullKey(pub)] });
  assert.deepEqual([...tx.subarray(tx.length - 43)], [5, 0, ...pub, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test("a 429 on a state read is waited out, never read as an answer (the first bad-answer recording read it as BAD)", async () => {
  const good = replay(load("vault-testnet-usdc.answers.json"));
  const limited = new Set();
  const fetchFn = async (url, init) => {
    const { params } = JSON.parse(init.body);
    const k = `${url} ${params.request_type} ${params.method_name ?? ""}`;
    if (params.request_type && !limited.has(k)) {
      limited.add(k);
      return { ok: false, status: 429, headers: new Headers(), json: async () => null };
    }
    return good(url, init);
  };
  const r = await check({ deployment, fetchFn, sleep });
  assert.ok(limited.size >= 6);
  assert.equal(r.ok, true, r.lines.join("\n"));
});
