// node --test scripts/live-checks/vault-testnet-t04.test.mjs: the live check replays recorded runs on NEAR testnet's
// two operators. The good answer (vault-testnet-t04.answers.json, read after the run of
// contracts/vault/deployments/testnet-t04-run.json) must PASS. The recorded bad answer must FAIL:
//   - vault-testnet-t04.bad.answers.json: the same vault read with a run record whose ragequit nullifier is the bounce's
//     (vault-testnet-t04.bad-run.json): that row's recipient is the bounce account, its context not 0.
// Four more are made here from the good answer, each changing one read so only that check can fail: the ragequit row
// with a context that is not 0; the refund note one unit off; the refund commitment written twice (settled twice);
// the bounce account registered on the token.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, RUN } from "./vault-testnet-t04.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const run = JSON.parse(readFileSync(RUN, "utf8"));

// each request gets its recorded answer; a request the run never made is an error
function replay(answers) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} ${params.method_name} on ${url}`);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
  };
}
const good = () => load("vault-testnet-t04.answers.json");
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const decode = (a) => JSON.parse(Buffer.from(a.json.result.result).toString("utf8"));
const encode = (a, v) => ({ ...a, json: { ...a.json, result: { ...a.json.result, result: [...Buffer.from(JSON.stringify(v))] } } });
// the good answer with one view's JSON result replaced
const withView = (answers, method, f) => answers.map((a) => (a.params.method_name === method ? encode(a, f(decode(a))) : a));

test("the recorded run passes", async () => {
  const r = await check({ run, fetchFn: replay(good()) });
  assert.deepEqual(bads(r), []);
  assert.equal(r.ok, true);
});

test("the recorded bad run fails: the ragequit nullifier names the bounce's row", async () => {
  const r = await check({ run: load("vault-testnet-t04.bad-run.json"), fetchFn: replay(load("vault-testnet-t04.bad.answers.json")) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).some((l) => /ragequit row: recipient and payer are the depositor/.test(l)), bads(r).join("\n"));
  assert.ok(bads(r).some((l) => /ragequit row: context 0/.test(l)), bads(r).join("\n"));
});

test("a ragequit row with a context fails", async () => {
  const answers = withView(good(), "spends", (rows) => rows.map((s) => (s.nullifier_hash === run.ragequit.nullifier_hash ? { ...s, context: "1" } : s)));
  const r = await check({ run, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).every((l) => /ragequit row: context 0/.test(l)), bads(r).join("\n"));
});

test("a refund note one unit off fails", async () => {
  const answers = withView(good(), "spends", (rows) => rows.map((s) => (s.nullifier_hash === run.bounce.nullifier_hash ? { ...s, refund_value: String(BigInt(s.refund_value) + 1n) } : s)));
  const r = await check({ run, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).some((l) => /holds exactly the returned/.test(l)), bads(r).join("\n"));
});

test("a refund note written twice fails", async () => {
  const answers = withView(good(), "leaves", (leaves) => (leaves.length ? [...leaves, run.settle.refund_commitment] : leaves));
  const r = await check({ run, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).every((l) => /settle wrote one note/.test(l)), bads(r).join("\n"));
});

test("a bounce account registered on the token fails", async () => {
  const answers = withView(good(), "storage_balance_of", () => ({ total: "1250000000000000000000", available: "0" }));
  const r = await check({ run, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).every((l) => /not registered on the token/.test(l)), bads(r).join("\n"));
});

test("two hosts of one operator are refused", async () => {
  const r = await check({ run, fetchFn: replay(good()), rpcs: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"] }); // near-rpc-operators: one operator (planted: the same-operator case this check must refuse)
  assert.equal(r.ok, false);
  assert.equal(bads(r)[0], "BAD only 1 operator(s) in https://test.rpc.fastnear.com (fastnear), https://rpc.testnet.near.org (fastnear); want two testnet operators"); // near-rpc-operators: one operator (planted: the same-operator case this check must refuse)
});
