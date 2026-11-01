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
import { check, liveBytes, liveRecord, DEPLOYMENT, USDC_CODE_HASH } from "./vault-testnet-usdc.mjs";
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

// Card money-gate-light-proof: a tx dRPC lacks is read on FastNEAR alone and passes only by its signed bytes and its
// light-client proof, as in the money gate. The recording (scripts/ci/money-gate.light-proof.json) holds the record's
// last tx (noBytes: this record keeps no tx bytes) and a testnet tx made with its bytes (the top level); dRPC is told it
// lacks the tx, every other request replays the good run.
const LP = JSON.parse(readFileSync(path.join(HERE, "../ci/money-gate.light-proof.json"), "utf8"));
function drpcLacks(fx, { proofs = true } = {}) {
  const good = replay(load("vault-testnet-usdc.answers.json"));
  const answer = (json) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ jsonrpc: "2.0", id: 1, ...json }) });
  const log = [];
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const drpc = url.includes("drpc.org");
    log.push(`${url} ${method} ${params?.tx_hash ?? ""}`);
    if (drpc && method === "status") return answer({ result: fx.drpcStatus });
    if (drpc && method === "block" && (params.finality === "final" || params.block_id === fx.head.hash)) return answer({ result: { header: fx.head } });
    if (method === "EXPERIMENTAL_light_client_proof") {
      const p = proofs && fx.proofs[params.transaction_hash ?? params.receipt_id];
      return answer(p ? { result: p } : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION_OR_RECEIPT" }, code: -32000 } });
    }
    if (method === "EXPERIMENTAL_tx_status" && params.tx_hash === fx.tx.hash)
      return answer(drpc ? { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, code: -32000 } } : { result: fx.known });
    if (method === "block" && params.block_id === fx.known.transaction_outcome.block_hash) return answer({ result: { header: fx.txBlock } });
    return good(url, init);
  };
  return { fetchFn, log };
}
const line = (fx) => `tx ${fx.tx.hash} .* ok on https://archival-rpc\\.testnet\\.fastnear\\.com, missing on https://near-testnet\\.drpc\\.org`;
// the record with its last tx swapped for the recording's tx made with its bytes
const withBytes = { ...deployment, txs: [...deployment.txs.slice(0, -1), { hash: LP.tx.hash, signer: LP.tx.signer, what: "a transfer", tx_bytes: LP.tx_bytes }] };

test("regression: a tx dRPC lacks, read on FastNEAR alone with no light-client proof, is refused: FAIL", async () => {
  const r = await check({ deployment: withBytes, fetchFn: drpcLacks(LP, { proofs: false }).fetchFn, sleep });
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), new RegExp(`^BAD ${line(LP)}; not proven: .*UNKNOWN_TRANSACTION_OR_RECEIPT`, "m"));
});

// money-gate-tx-rebuild: a tx with no tx-bytes file has its bytes rebuilt from FastNEAR's tx JSON; this stub serves no
// block before the tx's own, so no bytes hash to the id
test("a tx dRPC lacks whose signed bytes neither a file holds nor its tx JSON rebuilds is refused even with its real proofs: FAIL (an outcome proof binds an id, not a tx)", async () => {
  const r = await check({ deployment, fetchFn: drpcLacks(LP.noBytes).fetchFn, sleep });
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), new RegExp(`^BAD ${line(LP.noBytes)}; not proven: no block 1 back from its own`, "m"));
});

test("a tx dRPC lacks passes by its bytes and light-client proof on dRPC's final block, said so, and near.org is never asked: PASS", async () => {
  const { fetchFn, log } = drpcLacks(LP);
  const r = await check({ deployment: withBytes, fetchFn, sleep });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines.join("\n"), new RegExp(`^ok  ${line(LP)}; PROVEN ON near-testnet\\.drpc\\.org: near-testnet ${LP.tx.hash} \\(V0, ${LP.tx.signer} to ${LP.tx.signer}\\): 3 outcome\\(s\\) proven `, "m"));
  assert.equal(log.filter((l) => l === `https://archival-rpc.testnet.near.org EXPERIMENTAL_tx_status ${LP.tx.hash}`).length, 0);
});

test("the tx-bytes file the live run writes holds every tx that has bytes, by hash, and nothing else", () => {
  assert.deepEqual(liveBytes(withBytes), { [LP.tx.hash]: LP.tx_bytes });
  assert.deepEqual(liveBytes(deployment), {});
});
