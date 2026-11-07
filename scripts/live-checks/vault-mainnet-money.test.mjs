// node --test scripts/live-checks/vault-mainnet-money.test.mjs: the live check replays recorded reads of the mainnet
// vault on its two operators.
//   - vault-mainnet-money.bad-pre-run.answers.json: the vault read on 7 Nov 20:56Z, before any deposit (0 deposits,
//     0 spends), with a planted record of the run's shape (vault-mainnet-money.bad-pre-run.json): it must FAIL, on the
//     deposit row and the spend row only, on both operators.
//   - vault-mainnet-money.answers.json, read after the run of vault-mainnet-money.run.json: it must PASS. Both files
//     are written by the run (contracts/vault/scripts/mainnet-money.ts record, then this check with --record); until
//     then the good replay is skipped, never planted.
// More are made here from the recorded bad answer, each changing one read: a key on the vault, other code on it, two
// hosts of one operator, and a rate limit four times in a row (exit 2, never FAIL).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, main, RUN } from "./vault-mainnet-money.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const GOOD = path.join(HERE, "vault-mainnet-money.answers.json");

function replay(answers) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} ${params.method_name ?? params.request_type} on ${url}`);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
  };
}
const bad = () => load("vault-mainnet-money.bad-pre-run.answers.json");
const planted = load("vault-mainnet-money.bad-pre-run.json");
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded run passes", { skip: existsSync(RUN) && existsSync(GOOD) ? false : "the run has not landed: vault-mainnet-money.run.json and its answers are written by the run" }, async () => {
  const r = await check({ run: JSON.parse(readFileSync(RUN, "utf8")), fetchFn: replay(JSON.parse(readFileSync(GOOD, "utf8"))) });
  assert.deepEqual(bads(r), []);
  assert.equal(r.ok, true);
});

test("the vault read before any deposit fails, on the deposit and the spend row only, on both operators", async () => {
  const r = await check({ run: planted, fetchFn: replay(bad()) });
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 4, bads(r).join("\n"));
  assert.equal(bads(r).filter((l) => /one deposit row for the run's precommitment .*: none of 0/.test(l)).length, 2, bads(r).join("\n"));
  assert.equal(bads(r).filter((l) => /one spend row for the note's nullifier .*: none of 0/.test(l)).length, 2, bads(r).join("\n"));
  assert.ok(r.lines.some((l) => /^ok  .* key list is \[\] on https:\/\/near\.drpc\.org/.test(l)), r.lines.join("\n"));
});

test("a key on the vault fails", async () => {
  const answers = bad().map((a) => (a.params.request_type === "view_access_key_list" ? { ...a, json: { ...a.json, result: { ...a.json.result, keys: [{ public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 0, permission: "FullAccess" } }] } } } : a));
  const r = await check({ run: planted, fetchFn: replay(answers) });
  assert.equal(bads(r).filter((l) => /key list is \[\]/.test(l)).length, 2, bads(r).join("\n"));
});

test("other code on the vault fails", async () => {
  const answers = bad().map((a) => (a.params.request_type === "view_account" ? { ...a, json: { ...a.json, result: { ...a.json.result, code_hash: "11111111111111111111111111111111" } } } : a));
  const r = await check({ run: planted, fetchFn: replay(answers) });
  assert.equal(bads(r).filter((l) => /code hash is the record's/.test(l)).length, 2, bads(r).join("\n"));
});

test("a run record on another vault fails", async () => {
  const r = await check({ run: { ...planted, vault: "vault-test.confidential.unrlzd.near" }, fetchFn: replay(bad()) });
  assert.ok(bads(r).some((l) => /the run record names the mainnet vault/.test(l)), bads(r).join("\n"));
});

test("two hosts of one operator are refused", async () => {
  const r = await check({ run: planted, fetchFn: replay(bad()), rpcs: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"] }); // near-rpc-operators: one operator (planted: the same-operator case this check must refuse)
  assert.equal(r.ok, false);
  assert.match(bads(r)[0], /only 1 operator/);
});

test("four rate limits in a row exit 2, not 1, with no FAIL line", async () => {
  const waits = [];
  const out = [];
  const limit = { id: 1, jsonrpc: "2.0", error: { message: "You reached Public endpoint rate limit, please upgrade to paid plan", code: 15 } };
  const inner = replay(bad());
  const fetchFn = async (url, init) => (url === "https://near.drpc.org" ? { ok: false, status: 429, json: async () => limit } : inner(url, init));
  const code = await main(["--run", path.join(HERE, "vault-mainnet-money.bad-pre-run.json")], { fetchFn, sleep: async (ms) => void waits.push(ms), log: (l) => out.push(l), err: (l) => out.push(l) });
  assert.equal(code, 2);
  assert.deepEqual(waits, [2000, 4000, 8000]);
  assert.ok(!out.some((l) => /FAIL|BAD/.test(l)), out.join("\n"));
});

test("a run record that leaves change, pays the vault or deposits under the vault's minimum fails on the record line", async () => {
  for (const run of [
    { ...planted, withdraw: { ...planted.withdraw, withdrawn: "4000000" } },
    { ...planted, accounts: { ...planted.accounts, to: planted.vault } },
    { ...planted, accounts: { ...planted.accounts, to: undefined, A: "0".repeat(63) + "1" } },
    { ...planted, deposit: { ...planted.deposit, value: "900000" }, withdraw: { ...planted.withdraw, withdrawn: "600000" } },
  ]) {
    const r = await check({ run, fetchFn: replay(bad()) });
    assert.ok(bads(r).some((l) => /the record: U NEAR-implicit, the named account/.test(l)), bads(r).join("\n"));
  }
});
