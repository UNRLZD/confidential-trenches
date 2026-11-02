// node --test scripts/live-checks/vault-testnet-t02.test.mjs: the live check replays recorded runs on NEAR testnet's
// two operators. The good answer (vault-testnet-t02.answers.json, read after the run of
// contracts/vault/deployments/testnet-t02-run.json) must PASS. The two recorded bad answers must FAIL, each for its
// own reason:
//   - vault-testnet-t02.bad-fee.answers.json, the vault read with a record whose relay fee is one unit high
//     (vault-testnet-t02.bad-fee-run.json): the spend row's fee differs and F holds less than that fee;
//   - vault-testnet-t02.bad-swap.answers.json, the vault read with a record whose W and F are swapped
//     (vault-testnet-t02.bad-swap-run.json): the spend row's recipient differs and W holds less than its amount.
// More are made here from the good answer, each changing one read so only that check can fail: a key on the vault;
// the change leaf written twice; W holding one unit less; a spend row not yet settled. And one that must still pass:
// W holding one unit more (anyone may send W test USDC; nobody can take it out).
// A provider's rate limit is never a verdict: one limit then the answer passes (waited out 2 s); four in a row exit 2,
// not 1 (FAIL would undo a deploy); every request is asked once per provider when no limit comes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, main, RUN } from "./vault-testnet-t02.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(HERE, f), "utf8"));
const run = JSON.parse(readFileSync(RUN, "utf8"));

// each request gets its recorded answer; a request the run never made is an error
function replay(answers) {
  const byKey = new Map(answers.map((a) => [`${a.url} ${a.method} ${JSON.stringify(a.params)}`, a]));
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const a = byKey.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!a) throw new Error(`no recorded answer for ${method} ${params.method_name ?? params.request_type} on ${url}`);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
  };
}
const good = () => load("vault-testnet-t02.answers.json");
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const decode = (a) => JSON.parse(Buffer.from(a.json.result.result).toString("utf8"));
const encode = (a, v) => ({ ...a, json: { ...a.json, result: { ...a.json.result, result: [...Buffer.from(JSON.stringify(v))] } } });
// the good answer with one view's JSON result replaced (only the views whose args `match` holds)
const withView = (answers, method, f, match = () => true) =>
  answers.map((a) => (a.params.method_name === method && match(JSON.parse(Buffer.from(a.params.args_base64, "base64").toString())) ? encode(a, f(decode(a))) : a));

test("the recorded run passes", async () => {
  const r = await check({ run, fetchFn: replay(good()) });
  assert.deepEqual(bads(r), []);
  assert.equal(r.ok, true);
});

test("the recorded bad run with the fee one unit high fails on the fee only", async () => {
  const r = await check({ run: load("vault-testnet-t02.bad-fee-run.json"), fetchFn: replay(load("vault-testnet-t02.bad-fee.answers.json")) });
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 4, bads(r).join("\n"));
  assert.ok(bads(r).every((l) => /spend row: 1500000 to W, fee 204634|F holds at least the fee 204634/.test(l)), bads(r).join("\n"));
});

test("the recorded bad run with W and F swapped fails on the recipient only", async () => {
  const run2 = load("vault-testnet-t02.bad-swap-run.json");
  const r = await check({ run: run2, fetchFn: replay(load("vault-testnet-t02.bad-swap.answers.json")) });
  assert.equal(r.ok, false);
  assert.equal(bads(r).length, 4, bads(r).join("\n"));
  assert.ok(bads(r).every((l) => /spend row: 1500000 to W, fee 204633, .*: 1500000 to w-|W holds at least/.test(l)), bads(r).join("\n"));
});

test("a key on the vault fails", async () => {
  const answers = good().map((a) => (a.params.request_type === "view_access_key_list" ? { ...a, json: { ...a.json, result: { ...a.json.result, keys: [{ public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 0, permission: "FullAccess" } }] } } } : a));
  const r = await check({ run, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).length === 2 && bads(r).every((l) => /key list is \[\]/.test(l)), bads(r).join("\n"));
});

test("the change leaf written twice fails", async () => {
  const answers = withView(good(), "leaves", (leaves) => (leaves.length ? [...leaves, run.withdraw.change_commitment] : leaves));
  const r = await check({ run, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).every((l) => /change leaf at .* once/.test(l)), bads(r).join("\n"));
});

test("W holding one unit less fails", async () => {
  const answers = withView(good(), "ft_balance_of", (v) => String(BigInt(v) - 1n), (args) => args.account_id === run.accounts.W);
  const r = await check({ run, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).every((l) => /W holds at least/.test(l)), bads(r).join("\n"));
});

test("W holding one unit more still passes", async () => {
  const answers = withView(good(), "ft_balance_of", (v) => String(BigInt(v) + 1n), (args) => args.account_id === run.accounts.W);
  const r = await check({ run, fetchFn: replay(answers) });
  assert.deepEqual(bads(r), []);
  assert.equal(r.ok, true);
});

test("a spend row not yet settled fails", async () => {
  const answers = withView(good(), "spends", (rows) => rows.map((s) => (s.nullifier_hash === run.withdraw.nullifier_hash ? { ...s, status: "paid" } : s)));
  const r = await check({ run, fetchFn: replay(answers) });
  assert.equal(r.ok, false);
  assert.ok(bads(r).every((l) => /spend row: settled/.test(l)), bads(r).join("\n"));
});

test("two hosts of one operator are refused", async () => {
  const r = await check({ run, fetchFn: replay(good()), rpcs: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"] }); // near-rpc-operators: one operator (planted: the same-operator case this check must refuse)
  assert.equal(r.ok, false);
  assert.match(bads(r)[0], /only 1 operator/);
});

// dRPC's free endpoint's rate limit, in the shape it answers (a real dRPC answer, HTTP 429, error code 15)
const DRPC_LIMIT = { id: 187, jsonrpc: "2.0", error: { message: "You reached Public endpoint rate limit, please upgrade to paid plan", code: 15 } };
const LIMITS = [
  ["dRPC's code 15, HTTP 429", () => ({ ok: false, status: 429, json: async () => DRPC_LIMIT })],
  ["dRPC's code 15, HTTP 200", () => ({ ok: true, status: 200, json: async () => DRPC_LIMIT })],
  ["a bare HTTP 429", () => ({ ok: false, status: 429, json: async () => { throw new Error("not JSON"); } })],
  ["a JSON-RPC code -429", () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "x", error: { code: -429, message: "Too Many Requests" } }) })],
];
// the replay, with the first `n` asks of one request (dRPC's leaves page) answered by `limit`
function limited(n, limit) {
  const inner = replay(good());
  let left = n;
  return async (url, init) => {
    const { params } = JSON.parse(init.body);
    if (url === "https://near-testnet.drpc.org" && params.method_name === "leaves" && left > 0) {
      left--;
      return limit();
    }
    return inner(url, init);
  };
}

for (const [name, limit] of LIMITS) {
  test(`one rate limit (${name}) then the answer passes, waited out 2 s`, async () => {
    const waits = [];
    const r = await check({ run, fetchFn: limited(1, limit), sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual(bads(r), []);
    assert.equal(r.ok, true);
    assert.deepEqual(waits, [2000]);
  });
}

test("three rate limits then the answer passes, waited out 2, 4, 8 s", async () => {
  const waits = [];
  const r = await check({ run, fetchFn: limited(3, LIMITS[0][1]), sleep: async (ms) => void waits.push(ms) });
  assert.equal(r.ok, true);
  assert.deepEqual(waits, [2000, 4000, 8000]);
});

test("four rate limits in a row exit 2, not 1, with no FAIL line", async () => {
  const waits = [];
  const out = [];
  const code = await main([], { fetchFn: limited(4, LIMITS[0][1]), sleep: async (ms) => void waits.push(ms), log: (l) => out.push(l), err: (l) => out.push(l) });
  assert.equal(code, 2);
  assert.deepEqual(waits, [2000, 4000, 8000]);
  assert.ok(out.some((l) => /ERROR: .*rate limited 4 times in a row/.test(l)), out.join("\n"));
  assert.ok(!out.some((l) => /FAIL|BAD/.test(l)), out.join("\n"));
});

test("with no limit, every request (each page included) is asked once per provider", async () => {
  const asked = new Map();
  const inner = replay(good());
  const r = await check({ run, fetchFn: async (url, init) => {
    const k = `${url} ${init.body}`;
    asked.set(k, (asked.get(k) ?? 0) + 1);
    return inner(url, init);
  } });
  assert.equal(r.ok, true);
  assert.ok([...asked.values()].every((n) => n === 1), JSON.stringify([...asked.entries()].filter(([, n]) => n > 1)));
  assert.ok([...asked.keys()].filter((k) => k.includes('"method_name":"leaves"')).length === 2);
});
