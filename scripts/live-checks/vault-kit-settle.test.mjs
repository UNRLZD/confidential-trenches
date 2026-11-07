// node --test scripts/live-checks/vault-kit-settle.test.mjs: the live check replays recorded reads on NEAR testnet's
// two operators. The good answer (vault-kit-settle.answers.json, read after the run of vault-kit-settle.testnet.json)
// must PASS. The recorded bad answer must FAIL:
//   - vault-kit-settle.bad.answers.json, read live with vault-kit-settle.bad-run.json: a record whose note is the
//     deposit's leaf (index 0), not the spend row's own, and whose settle names the refused second settle.
// Three more are made here from the good answer, each changing one read: the refund note one unit off; the leaf at
// refund_leaf_index another commitment; the settle signed by another account.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, RUN } from "./vault-kit-settle.mjs";
const NOSLEEP = async () => {};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const run = JSON.parse(readFileSync(RUN, "utf8"));

function replay(answers) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} ${params.method_name ?? ""} on ${url}`);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: new Headers(), json: async () => a.json };
  };
}
const good = () => load("vault-kit-settle.answers.json");
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const decode = (a) => JSON.parse(Buffer.from(a.json.result.result).toString("utf8"));
const encode = (a, v) => ({ ...a, json: { ...a.json, result: { ...a.json.result, result: [...Buffer.from(JSON.stringify(v))] } } });
const withView = (answers, method, f) => answers.map((a) => (a.params.method_name === method ? encode(a, f(decode(a))) : a));

test("the recorded run passes", async () => {
  const r = await check({ sleep: NOSLEEP, run, fetchFn: replay(good()) });
  assert.deepEqual(bads(r), []);
  assert.equal(r.ok, true);
});

test("the recorded bad run fails: the note at the deposit's leaf, the settle naming the refused one", async () => {
  const r = await check({ sleep: NOSLEEP, run: load("vault-kit-settle.bad-run.json"), fetchFn: replay(load("vault-kit-settle.bad.answers.json")) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).some((l) => /the note the kit wrote is the spend row's own leaf/.test(l)), bads(r).join("\n"));
  assert.ok(bads(r).some((l) => /the settle is the kit's call/.test(l)), bads(r).join("\n"));
});

test("a refund note one unit off fails", async () => {
  const answers = withView(good(), "spends", (rows) => rows.map((s) => (s.nullifier_hash === run.bounce.nullifier_hash ? { ...s, refund_value: String(BigInt(s.refund_value) - 1n) } : s)));
  const r = await check({ sleep: NOSLEEP, run, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).some((l) => /exactly the returned/.test(l)), bads(r).join("\n"));
});

test("a leaf at refund_leaf_index that is not the note fails", async () => {
  const answers = withView(good(), "leaves", (rows) => rows.map(() => "12345"));
  const r = await check({ sleep: NOSLEEP, run, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).every((l) => /is Poseidon\(refund_value/.test(l)), bads(r).join("\n"));
});

test("a settle signed by another account fails", async () => {
  const answers = good().map((a) => (a.method === "EXPERIMENTAL_tx_status" && a.params.tx_hash === run.settle.tx ? { ...a, json: { ...a.json, result: { ...a.json.result, transaction: { ...a.json.result.transaction, signer_id: "relayer.testnet" } } } } : a));
  const r = await check({ sleep: NOSLEEP, run, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).every((l) => /the settle is the kit's call, signed by the device/.test(l)), bads(r).join("\n"));
});
