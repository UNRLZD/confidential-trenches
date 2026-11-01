// node --test scripts/live-checks/vault-testnet-usdc.test.mjs: the live check replays recorded runs on NEAR testnet's
// RPCs. The good answer (vault-testnet-usdc.answers.json, the deployed token) must PASS. The bad answer must FAIL:
//   - vault-testnet-usdc.bad-code.answers.json: an account running other code (the vault skeleton,
//     vault.bf-vs-20261101t012200.testnet) checked against the same record.
// Two more bad answers are made here from the good one: a holder balance one base unit short, and the deploy tx read as
// failed. The deploy script's own tests live beside it, contracts/vault/scripts/testnet-usdc.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, liveRecord, DEPLOYMENT, USDC_CODE_HASH } from "./vault-testnet-usdc.mjs";
import { parseLive } from "../ci/money-gate.mjs";

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
    if (method === "EXPERIMENTAL_tx_status" && params.tx_hash === deploy) json.result.status = { Failure: { ActionError: { index: 1 } } };
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

// Card near-rpc-operators: near.org's testnet archive is FastNEAR's (scripts/ci/near-rpc-operators.mjs), so a tx read
// ok there and on FastNEAR's own archive, while dRPC lacks it, is one operator's read: BAD. The recorded answers of
// near.org's host for the one tx the run asked it about stand in for both FastNEAR hosts.
const ORG = "https://archival-rpc.testnet.near.org";
const HASH = "64jQRWmUEuk8753kgsLRRa1XE6wM72e6uK4ZQTFGLcmE";
// dRPC lacks HASH; earliest: what dRPC's status names as its earliest block (none: its status has no recorded answer)
function drpcLacks(earliest) {
  const answers = load("vault-testnet-usdc.answers.json");
  const good = replay(answers);
  const orgBlock = (params) => answers.some((a) => a.url === ORG && a.method === "block" && JSON.stringify(a.params) === JSON.stringify(params));
  const { height, timestamp_nanosec: time } = answers.find((a) => a.url === ORG && a.method === "block").json.result.header;
  const answer = (json) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ jsonrpc: "2.0", id: 1, ...json }) });
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const drpc = url.includes("drpc.org");
    if (drpc && method === "status" && earliest) return answer({ result: { chain_id: "testnet", sync_info: { earliest_block_height: earliest(height) } } });
    // dRPC's earliest block, an hour after the tx's block
    if (drpc && method === "block" && earliest && params.block_id === earliest(height)) return answer({ result: { header: { height: params.block_id, timestamp_nanosec: String(BigInt(time) + 3600n * 10n ** 9n) } } });
    const ours = (method === "EXPERIMENTAL_tx_status" && params.tx_hash === HASH) || (method === "block" && orgBlock(params));
    if (ours && drpc) return answer({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, code: -32000 } });
    return good(ours ? ORG : url, init);
  };
  return { fetchFn, height };
}
const ONE_OP_LINE = `tx ${HASH} .* ok on https://archival-rpc\\.testnet\\.fastnear\\.com, missing on https://near-testnet\\.drpc\\.org, ok on https://archival-rpc\\.testnet\\.near\\.org`;

test("regression: a tx read ok on FastNEAR's and near.org's hosts while dRPC lacks a tx it keeps is one operator: FAIL", async () => {
  for (const earliest of [null, (h) => h, (h) => h - 1000]) {
    const r = await check({ deployment, fetchFn: drpcLacks(earliest).fetchFn, sleep });
    assert.equal(r.ok, false);
    assert.match(r.lines.join("\n"), new RegExp(`^BAD ${ONE_OP_LINE}$`, "m"));
  }
});

test("a tx older than dRPC keeps passes on one operator, said so: PASS", async () => {
  const { fetchFn, height } = drpcLacks((h) => h + 1);
  const r = await check({ deployment, fetchFn, sleep });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines.join("\n"), new RegExp(`^ok  ${ONE_OP_LINE}; one operator \\(fastnear\\) read it ok, .*: its block ${height}, \\S+, is older than https://near-testnet\\.drpc\\.org \\(testnet\\) keeps blocks from ${height + 1}, `, "m"));
});
