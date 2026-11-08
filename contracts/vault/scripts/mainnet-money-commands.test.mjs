// node --test contracts/vault/scripts/mainnet-money-commands.test.mjs: the driver's sweep-u and open-u commands run whole
// (card vault-mainnet-money), offline, on testnet's release values: a preload puts a stub in place of fetch that
// answers each RPC call as a test plants it and logs every call, so what the command sends, and what it had kept before
// sending, is read from the log. The run's folder is made here from a random seed (never a real run's).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { b58encode } from "./near-tx.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, "mainnet-money.ts");
const REC = JSON.parse(readFileSync(path.join(HERE, "..", "deployments", "testnet-v1.json"), "utf8"));
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), "vmm-commands-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
const G = "g-2b700409.bf-vt-20261102t071444.testnet";
const R = "r-2b700409.bf-vt-20261102t071444.testnet";
const PAYER = "bf-vt-20261102t071444.testnet";
const TO = "owner.testnet";
let n = 0;

// the stub: query (view_access_key_list, view_account, call_function, view_access_key), block, send_tx and
// EXPERIMENTAL_tx_status, each answered from the case's plan; send_tx logs the run's kept files as they are at the send
const STUB = path.join(TMP, "stub.mjs");
writeFileSync(STUB, `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(process.env.VMM_PLAN, "utf8"));
const out = (o) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...o }), { status: 200 });
const view = (v) => out({ result: { result: [...Buffer.from(JSON.stringify(v))], logs: [], block_height: 1 } });
const ok = { status: { SuccessValue: "" }, final_execution_status: "FINAL", receipts_outcome: [{ outcome: { status: { SuccessValue: "" }, executor_id: "x" } }], receipts: [], transaction: {} };
globalThis.fetch = async (url, init) => {
  const b = JSON.parse(init.body);
  const p = b.params ?? {};
  const entry = { url: String(url), method: b.method, request_type: p.request_type, account_id: p.account_id, method_name: p.method_name };
  if (p.args_base64) entry.args = JSON.parse(Buffer.from(p.args_base64, "base64").toString("utf8"));
  if (b.method === "send_tx") {
    entry.signed = Buffer.from(p.signed_tx_base64, "base64").toString("latin1");
    entry.kept = Object.fromEntries(["sweep", "open-u"].map((f) => [f, existsSync(plan.state + "/" + f + ".json") ? readFileSync(plan.state + "/" + f + ".json", "utf8") : null]));
  }
  appendFileSync(process.env.VMM_LOG, JSON.stringify(entry) + "\\n");
  if (b.method === "block") return out({ result: { header: { hash: "11111111111111111111111111111111", height: 1 } } });
  if (b.method === "send_tx") return plan.send === "error" ? out({ error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION" }, data: "planted" } }) : out({ result: ok });
  if (b.method === "EXPERIMENTAL_tx_status") return plan.send === "error" ? out({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } }) : out({ result: ok });
  if (b.method !== "query") return out({ error: { name: "STUB", cause: { name: "UNPLANNED " + b.method } } });
  if (p.request_type === "view_access_key_list") return out({ result: { keys: [] } });
  if (p.request_type === "view_access_key") return out({ result: { nonce: 7, permission: "FullAccess" } });
  if (p.request_type === "view_account") {
    if (p.account_id === plan.vault) return out({ result: { amount: "1", code_hash: plan.code_hash } });
    if ((plan.absent ?? []).includes(p.account_id)) return out({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } });
    return out({ result: { amount: "1000", code_hash: "11111111111111111111111111111111" } });
  }
  const a = entry.args ?? {};
  if (p.method_name === "config") return view({ asset: plan.token, scope: plan.scope, min_deposit: "1000000" });
  if (p.method_name === "ft_balance_of") return view(plan.balances?.[a.account_id] ?? "0");
  if (p.method_name === "storage_balance_of") return view((plan.registered ?? []).includes(a.account_id) ? { total: "1250000000000000000000", available: "0" } : null);
  if (p.method_name === "storage_balance_bounds") return view({ min: "1250000000000000000000", max: "1250000000000000000000" });
  return out({ error: { name: "STUB", cause: { name: "UNPLANNED " + p.method_name } } });
};
`);

// a run's folder as paste 1 leaves it: a random seed (mode 600) and the run step naming U of that seed and `to`
async function folder(to = TO) {
  const { fingerprintOf, seed64Of } = await import(DRIVER);
  const { depositAccount } = await import("../../../packages/wallet/src/deposit/account.ts");
  const root = path.join(TMP, String(n++));
  const state = path.join(root, "run");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  const seed = randomBytes(32);
  writeFileSync(path.join(state, "seed"), seed.toString("hex") + "\n", { mode: 0o600 });
  const U = depositAccount(await seed64Of(seed), BigInt(REC.scope), 0).account;
  writeFileSync(path.join(state, "run.json"), JSON.stringify({ fingerprint: fingerprintOf(seed), network: "testnet", U, i: 0, to }));
  return { root, state, U };
}
// the payer's key file, from the published all-zero ed25519 seed (never a real key), outside the repo
function zeroKey(root) {
  const d = Buffer.alloc(32);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), d]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x, "base64url");
  const file = path.join(root, "payer.json");
  writeFileSync(file, JSON.stringify({ account_id: PAYER, private_key: `ed25519:${b58encode(Buffer.concat([d, pub]))}` }), { mode: 0o600 });
  return file;
}
function drive(f, args, plan, timeout = 30_000) {
  const log = path.join(f.root, "calls.jsonl");
  const planFile = path.join(f.root, "plan.json");
  writeFileSync(planFile, JSON.stringify({ state: f.state, vault: REC.account_id, token: REC.asset, scope: REC.scope, code_hash: REC.code_hash, ...plan }));
  const r = spawnSync(process.execPath, ["--import", STUB, DRIVER, ...args, "--network", "testnet", "--bind-relayer", G, "--state", f.state], { encoding: "utf8", timeout, env: { ...process.env, VMM_PLAN: planFile, VMM_LOG: log } });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...r, out: r.stdout + r.stderr, calls, sends: calls.filter((c) => c.method === "send_tx") };
}

test("LB: sweep-u sends U's whole USDC to the run's account in one ft_transfer, its hash kept before the send", async () => {
  const f = await folder();
  const r = drive(f, ["sweep-u"], { balances: { [f.U]: "2000000" }, registered: [TO] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.sends.length, 1, r.out);
  assert.match(r.sends[0].signed, new RegExp(`ft_transfer.*"receiver_id":"${TO.replace(".", "\\.")}","amount":"2000000"`));
  const kept = JSON.parse(r.sends[0].kept.sweep);
  assert.equal(kept.txs.length, 1);
  assert.deepEqual({ ...kept.txs[0], hash: "h" }, { hash: "h", signer: f.U, amount: "2000000", to: TO });
});

test("LB: sweep-u refuses an account that is the run's own (R, F, U) or exists on neither RPC: nothing sent", async () => {
  for (const to of [R, "f-2b700409.bf-vt-20261102t071444.testnet", "absent.testnet"]) {
    const f = await folder(to);
    const r = drive(f, ["sweep-u"], { balances: { [f.U]: "2000000" }, registered: [to], absent: ["absent.testnet"] });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /refused, nothing sent: /, to);
    assert.deepEqual(r.sends, [], to);
  }
  const f = await folder();
  const own = JSON.parse(readFileSync(path.join(f.state, "run.json"), "utf8"));
  writeFileSync(path.join(f.state, "run.json"), JSON.stringify({ ...own, to: f.U }));
  const r = drive(f, ["sweep-u"], { balances: { [f.U]: "2000000" }, registered: [f.U] });
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(r.sends, []);
});

test("LB: sweep-u refuses an account not registered on the token, read on both RPCs: nothing sent", async () => {
  const f = await folder();
  const r = drive(f, ["sweep-u"], { balances: { [f.U]: "2000000" }, registered: [] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not registered on the token/);
  assert.deepEqual(r.sends, []);
  assert.ok(r.calls.filter((c) => c.method_name === "storage_balance_of" && c.args?.account_id === TO).length >= 2, "read on both RPCs");
});

test("LB: a send the RPC refuses stops the command at once, the refusal kept beside its hash", async () => {
  const f = await folder();
  const t0 = Date.now();
  const r = drive(f, ["sweep-u"], { balances: { [f.U]: "2000000" }, registered: [TO], send: "error" }, 20_000);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /refused by https:\/\/[^:]+: .*INVALID_TRANSACTION/);
  assert.ok(Date.now() - t0 < 20_000);
  const kept = JSON.parse(readFileSync(path.join(f.state, "sweep.json"), "utf8"));
  assert.equal(kept.txs.length, 1);
  assert.match(kept.txs[0].error, /INVALID_TRANSACTION/);
  assert.equal(r.calls.filter((c) => c.method === "EXPERIMENTAL_tx_status").length, 0, "no read-back of a refused send");
});

test("LB: open-u --register refuses an account already registered, or one on neither RPC, before anything is sent", async () => {
  for (const [reg, plan] of [["owner.testnet", { registered: ["owner.testnet"] }], ["absent.testnet", { absent: ["absent.testnet"] }]]) {
    const f = await folder();
    const r = drive(f, ["open-u", "--payer", PAYER, "--key-file", zeroKey(f.root), "--register", reg], { absent: [f.U], ...plan });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /refused, nothing sent: /, reg);
    assert.deepEqual(r.sends, [], reg);
  }
});
