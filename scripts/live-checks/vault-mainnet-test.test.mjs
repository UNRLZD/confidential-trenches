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
import { ACCOUNT, DEPLOYMENT, PREPAY_P, PREPAY_TX, SIGNER } from "./vault-mainnet-test.mjs";
// the reads' waits (a rate limit's, the pacing between asks) recorded as asked, never slept, so replays run at once
const NOSLEEP = async () => {};

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
const run = (answers, write = {}) => check({ sleep: NOSLEEP, network: "mainnet", account: ACCOUNT, deployment, fetchFn: replay(answers), write: { signer: SIGNER, ...write }, wait: 0 });
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
  // the bare run reads back this same write
  assert.deepEqual([PREPAY_TX, PREPAY_P], [w.tx, w.precommitment]);
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

// A public RPC may rate-limit the check (FastNEAR answered HTTP 429 "Rate limits exceeded" to this check on 5 Nov 13:37Z).
// The reads go through scripts/ci/rpc-wait.mjs, as the money gate's do: a rate limit is waited out (its Retry-After, or
// 2 s doubling), bounded, and asked again; it is never read as the vault's state, and past the bound the check FAILs on
// a line naming the rate limit and the RPC. `limited(answers, hit, times)` answers each request `hit` picks with a rate
// limit `times` times (Infinity: always), then the recorded answer; `asked` keeps every wait the reads asked for.
function limited(answers, hit, times, shape) {
  const next = replay(answers);
  const seen = new Map();
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const k = `${url} ${method} ${JSON.stringify(params)}`;
    if (hit(url, params) && (seen.get(k) ?? 0) < times) {
      seen.set(k, (seen.get(k) ?? 0) + 1);
      return shape();
    }
    return next(url, init);
  };
  const asked = [];
  return { fetchFn, asked, sleep: async (ms) => void asked.push(ms) };
}
const http429 = (after) => () => ({ ok: false, status: 429, headers: new Headers(after ? { "retry-after": after } : {}), json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -429, message: "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com" } }) });
// dRPC's free endpoint: error code 15 at HTTP 200 (scripts/ci/rpc-wait.mjs isRateLimit)
const drpc15 = () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ id: 1, jsonrpc: "2.0", error: { message: "You reached Public endpoint rate limit, please upgrade to paid plan", code: 15 } }) });
const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const runWith = (answers, l) => check({ network: "mainnet", account: ACCOUNT, deployment, fetchFn: l.fetchFn, write: { signer: SIGNER, ...goodWrite(answers) }, wait: 0, sleep: l.sleep });

test("recorded good answer, FastNEAR's code hash, code and config() each rate-limited twice (Retry-After 3) before their answer: waited out, PASS", async () => {
  const answers = load("vault-mainnet-test.answers.json");
  const l = limited(answers, (url, p) => url === FAST && ["view_account", "view_code", "call_function"].includes(p.request_type), 2, http429("3"));
  const r = await runWith(answers, l);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(l.asked.filter((ms) => ms === 3000).length, 6, `waits asked: ${l.asked}`);
});

test("recorded good answer, dRPC's tx read answering its code-15 rate limit once at HTTP 200: waited out, PASS", async () => {
  const answers = load("vault-mainnet-test.answers.json");
  const l = limited(answers, (url, p) => url === DRPC && p.tx_hash !== undefined, 1, drpc15);
  const r = await runWith(answers, l);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(l.asked.includes(2000), `waits asked: ${l.asked}`);
});

test("FastNEAR's config() rate-limited forever: FAIL on a line naming the rate limit and FastNEAR, never a config read, nothing written", async () => {
  const answers = load("vault-mainnet-test.answers.json");
  const l = limited(answers, (url, p) => url === FAST && p.method_name === "config", Infinity, http429());
  const r = await runWith(answers, l);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bads(r).includes(`BAD config() on ${FAST}: rate limited 6 times in a row`), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.startsWith("ok  config() answers on " + FAST)), r.lines.join("\n"));
  // bounded: 2 s doubling, five waits, then no answer
  assert.deepEqual(l.asked.filter((ms) => ms >= 2000), [2000, 4000, 8000, 16000, 32000]);
});

test("dRPC's key list rate-limited forever with its code-15 answer: FAIL on a line naming the rate limit and dRPC, never read as keys []", async () => {
  const answers = load("vault-mainnet-test.answers.json");
  const l = limited(answers, (url, p) => url === DRPC && p.request_type === "view_access_key_list", Infinity, drpc15);
  const r = await runWith(answers, l);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bads(r).includes(`BAD ${ACCOUNT} key list on ${DRPC}: rate limited 6 times in a row`), r.lines.join("\n"));
  assert.equal(r.lines.filter((x) => /^ok  \S+ key list is \[\] on /.test(x)).length, 1, r.lines.join("\n"));
});

test("a rate limit whose Retry-After is past the 600 s cap is no answer at once: FAIL naming it, never waited", async () => {
  const answers = load("vault-mainnet-test.answers.json");
  const l = limited(answers, (url, p) => url === FAST && p.request_type === "view_code", Infinity, http429("900"));
  const r = await runWith(answers, l);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bads(r).includes(`BAD code on ${FAST}: rate limited, Retry-After 900 s is past the 600 s cap`), r.lines.join("\n"));
  assert.deepEqual(l.asked.filter((ms) => ms > 1000), []);
});
