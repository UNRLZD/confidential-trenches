// node --test contracts/vault/scripts/mainnet-money-commands.test.mjs: the driver's sweep-u and open-u commands run whole
// (card vault-mainnet-money), offline, on testnet's release values: a preload puts a stub in place of fetch that
// answers each RPC call as a test plants it and logs every call, so what the command sends, and what it had kept before
// sending, is read from the log. The run's folder is made here from a random seed (never a real run's).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomBytes, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { b58decode, b58encode } from "./near-tx.mjs";
import { act, encodeTx } from "./testnet-usdc.mjs";

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
// EXPERIMENTAL_tx_status, each answered from the case's plan; send_tx logs the run's kept files as they are at the send.
// plan.statusFailed answers every EXPERIMENTAL_tx_status FINAL with a failed receipt;
// plan.absentOn = { [url]: [ids] } holds an account absent on that RPC only; plan.txs = { [hash]: { failed?, transaction? } }
// answers EXPERIMENTAL_tx_status per hash (a hash it does not name is UNKNOWN_TRANSACTION), as the record reads it
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
  if (b.method === "EXPERIMENTAL_tx_status") Object.assign(entry, { tx_hash: p.tx_hash, sender: p.sender_account_id });
  if (b.method === "send_tx") {
    entry.signed = Buffer.from(p.signed_tx_base64, "base64").toString("latin1");
    entry.signed_b64 = p.signed_tx_base64;
    entry.kept = Object.fromEntries(["sweep", "open-u"].map((f) => [f, existsSync(plan.state + "/" + f + ".json") ? readFileSync(plan.state + "/" + f + ".json", "utf8") : null]));
  }
  appendFileSync(process.env.VMM_LOG, JSON.stringify(entry) + "\\n");
  if (b.method === "block") return out({ result: { header: { hash: "11111111111111111111111111111111", height: 1, timestamp_nanosec: "1794009600000000000" } } });
  if (b.method === "send_tx") return plan.send === "error" ? out({ error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION" }, data: "planted" } }) : out({ result: ok });
  if (b.method === "EXPERIMENTAL_tx_status" && plan.txs !== undefined) {
    const t = plan.txs[p.tx_hash];
    if (t === undefined) return out({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } });
    const at = { ...ok, transaction: t.transaction ?? { signer_id: p.sender_account_id, hash: p.tx_hash }, transaction_outcome: { block_hash: "11111111111111111111111111111111" } };
    return out({ result: t.failed ? { ...at, status: { Failure: { ActionError: { kind: "planted" } } } } : at });
  }
  if (b.method === "EXPERIMENTAL_tx_status" && plan.statusFailed) return out({ result: { ...ok, status: { Failure: { ActionError: { kind: "planted" } } }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: "planted" } } }, executor_id: "x" } }] } });
  if (b.method === "EXPERIMENTAL_tx_status") return plan.send === "error" ? out({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } }) : out({ result: ok });
  if (b.method !== "query") return out({ error: { name: "STUB", cause: { name: "UNPLANNED " + b.method } } });
  if (p.request_type === "view_access_key_list") return out({ result: { keys: [] } });
  if (p.request_type === "view_access_key") return out({ result: { nonce: 7, permission: "FullAccess" } });
  if (p.request_type === "view_account") {
    if (p.account_id === plan.vault) return out({ result: { amount: "1", code_hash: plan.code_hash } });
    if ([...(plan.absent ?? []), ...(plan.absentOn?.[String(url)] ?? [])].includes(p.account_id)) return out({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } });
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
const ZERO_D = Buffer.alloc(32);
const ZERO_PRIV = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), ZERO_D]), format: "der", type: "pkcs8" });
const ZERO_PUB = Buffer.from(createPublicKey(ZERO_PRIV).export({ format: "jwk" }).x, "base64url");
function zeroKey(root) {
  const file = path.join(root, "payer.json");
  writeFileSync(file, JSON.stringify({ account_id: PAYER, private_key: `ed25519:${b58encode(Buffer.concat([ZERO_D, ZERO_PUB]))}` }), { mode: 0o600 });
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

test("L1 (A, review 5): a send that lands FINAL with a failed receipt stops the command: the read-back holds every receipt to a success", async () => {
  const f = await folder();
  const r = drive(f, ["sweep-u"], { balances: { [f.U]: "2000000" }, registered: [TO], statusFailed: true });
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.sends.length, 1, r.out);
  assert.doesNotMatch(r.out, /read back FINAL on both RPCs, every receipt a success/);
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

// ---- open-u's two sends, read from the signed bytes ----

/** A signed NEAR tx (nearcore's SignedTransaction, Borsh, V0): its fields and actions, refused on any trailing byte. */
function parseSigned(b64) {
  const b = Buffer.from(b64, "base64");
  let o = 0;
  const fixed = (n) => { const v = b.subarray(o, o + n); o += n; assert.equal(v.length, n, "the signed tx is cut short"); return Buffer.from(v); };
  const u32 = () => fixed(4).readUInt32LE();
  const u64 = () => fixed(8).readBigUInt64LE();
  const u128 = () => { const v = fixed(16); return v.readBigUInt64LE() + (v.readBigUInt64LE(8) << 64n); };
  const str = () => fixed(u32()).toString("utf8");
  const signer = str(), keyTag = fixed(1)[0], publicKey = fixed(32), nonce = u64(), receiver = str(), blockHash = fixed(32);
  const actions = [];
  for (let k = u32(); k > 0; k--) {
    const tag = fixed(1)[0];
    if (tag === 3) actions.push({ kind: "Transfer", amount: u128() });
    else if (tag === 2) actions.push({ kind: "FunctionCall", method: str(), args: JSON.parse(fixed(u32()).toString("utf8")), gas: u64(), deposit: u128() });
    else assert.fail(`action tag ${tag}: neither a Transfer nor a FunctionCall`);
  }
  const tx = b.subarray(0, o);
  const sigTag = fixed(1)[0], sig = fixed(64);
  assert.equal(o, b.length, "bytes after the signature");
  return { tx, hash: b58encode(createHash("sha256").update(tx).digest()), signer, keyTag, publicKey, nonce, receiver, blockHash, actions, sigTag, sig };
}
/** The send is exactly `want` (signer the payer, its key, nonce 7 + 1, the stub's block), signed by the payer's key. */
function assertSend(send, want) {
  const s = parseSigned(send.signed_b64);
  assert.deepEqual({ signer: s.signer, receiver: s.receiver, actions: s.actions }, { signer: want.signer, receiver: want.receiver, actions: want.actions });
  const tx = encodeTx({ signer: want.signer, publicKey: ZERO_PUB, nonce: 8n, receiver: want.receiver, blockHash: b58decode("11111111111111111111111111111111"), actions: want.actions });
  assert.ok(s.tx.equals(tx), "the signed bytes are not the expected tx byte for byte");
  assert.equal(s.sigTag, 0);
  assert.ok(verify(null, createHash("sha256").update(s.tx).digest(), createPublicKey(ZERO_PRIV), s.sig), "not signed by the payer's key");
  return s;
}
const TGAS = 10n ** 12n;
const STORAGE_MIN = 1250000000000000000000n; // the stub's storage_balance_bounds (min = max)

test("LB: open-u on a U absent on both RPCs and unregistered sends exactly the payer's 0.01 NEAR to U, then storage_deposit of U at the token's min", async () => {
  const f = await folder();
  const r = drive(f, ["open-u", "--payer", PAYER, "--key-file", zeroKey(f.root)], { absent: [f.U] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.sends.length, 2, r.out);
  assertSend(r.sends[0], { signer: PAYER, receiver: f.U, actions: [{ kind: "Transfer", amount: 10n ** 22n }] });
  assertSend(r.sends[1], { signer: PAYER, receiver: REC.asset, actions: [act.call("storage_deposit", { account_id: f.U, registration_only: true }, 30n * TGAS, STORAGE_MIN)] });
  assert.deepEqual(parseSigned(r.sends[1].signed_b64).actions[0].args, { account_id: f.U, registration_only: true });
  assert.equal(parseSigned(r.sends[1].signed_b64).actions[0].deposit, STORAGE_MIN);
});

test("LB: open-u keeps each tx in open-u.json, signed by the payer, before it is sent", async () => {
  const f = await folder();
  const r = drive(f, ["open-u", "--payer", PAYER, "--key-file", zeroKey(f.root)], { absent: [f.U] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.sends.length, 2, r.out);
  for (const send of r.sends) {
    const { hash } = parseSigned(send.signed_b64);
    assert.notEqual(send.kept["open-u"], null, "open-u.json not written before the send");
    const at = JSON.parse(send.kept["open-u"]).txs.find((t) => t.hash === hash);
    assert.ok(at, `${hash} not kept before its send`);
    assert.equal(at.signer, PAYER);
  }
});

test("LB: open-u refuses a U that exists on one RPC only: nothing sent", async () => {
  const urls = ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"];
  for (const url of urls) {
    const f = await folder();
    const r = drive(f, ["open-u", "--payer", PAYER, "--key-file", zeroKey(f.root)], { absentOn: { [url]: [f.U] } });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /exists on one RPC only: nothing sent/, url);
    assert.deepEqual(r.sends, [], url);
    assert.deepEqual(new Set(r.calls.filter((c) => c.request_type === "view_account" && c.account_id === f.U).map((c) => c.url)), new Set(urls), "U read on both RPCs");
  }
});

// ---- record, whole, on testnet ----

const F = "f-2b700409.bf-vt-20261102t071444.testnet";
const FUNDER = "funder.testnet";
const ROOT = path.resolve(HERE, "../../..");
const porcelain = () => spawnSync("git", ["-C", ROOT, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).stdout;
const txHash = () => {
  for (;;) {
    const h = b58encode(randomBytes(32));
    if (/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(h)) return h;
  }
};
const b64json = (x) => Buffer.from(JSON.stringify(x)).toString("base64");

/** A run's folder as paste 2 leaves it, both legs landed, every step made here, and the plan its txs read as. */
async function landed() {
  const f = await folder();
  const P = BigInt("0x" + randomBytes(31).toString("hex")).toString();
  const nf = BigInt("0x" + randomBytes(31).toString("hex")).toString();
  const value = "2000000";
  const h = { open: txHash(), fund: txHash(), dep: txHash(), wd: txHash(), sweep: txHash(), sweepBad: txHash() };
  const put = (step, v) => writeFileSync(path.join(f.state, `${step}.json`), JSON.stringify(v));
  const run = JSON.parse(readFileSync(path.join(f.state, "run.json"), "utf8"));
  put("run", { ...run, precommitment: P });
  put("deposit", { relayer: G, txs: [h.dep], leaf: { value, label: "5", leaf_index: "3", commitment: "77" } });
  put("withdraw", { done: true, to: TO, nullifier_hash: nf, fee_recipient: F, row: { index: 0, status: "paid", recipient: TO, withdrawn: "1990000", fee: "10000", payer: R, new_leaf_index: "4", refund_value: "0" }, change_commitment: "0" });
  put("heard", { bind: [h.dep], withdraw: [h.wd] });
  put("open-u", { txs: [{ hash: h.open, signer: PAYER, what: `Transfer 0.01 NEAR to U ${f.U}` }] });
  put("sweep", { txs: [{ hash: h.sweep, signer: f.U, amount: "5", to: TO }] });
  const deposit = {
    signer_id: G, receiver_id: f.U,
    actions: [{ Delegate: { delegate_action: { sender_id: f.U, receiver_id: REC.asset, actions: [{ FunctionCall: { method_name: "ft_transfer_call", args: b64json({ receiver_id: REC.account_id, amount: value, msg: JSON.stringify({ precommitment: P, depositor: f.U }) }), gas: 1, deposit: "1" } }] } } }],
  };
  const withdraw = { signer_id: R, receiver_id: REC.account_id, actions: [{ FunctionCall: { method_name: "withdraw", args: b64json({ public_signals: ["0", nf, value] }), gas: 1, deposit: "0" } }] };
  const txs = { [h.open]: {}, [h.fund]: {}, [h.dep]: { transaction: deposit }, [h.wd]: { transaction: withdraw }, [h.sweep]: {} };
  const line = (hash, signer) => `Tx: near-testnet ${hash} ${signer}`;
  const lines = [line(h.open, PAYER), line(h.fund, FUNDER), line(h.dep, G), line(h.wd, R), line(h.sweep, f.U)];
  return { f, h, txs, lines, put };
}
const txLines = (md) => md.split("\n").filter((l) => l.startsWith("Tx: "));

test("LB: record on a landed run reads every tx as the money gate does and writes its two files in --state, nothing in the repo", async () => {
  const { recordFiles } = await import(DRIVER);
  const { f, h, txs, lines } = await landed();
  const before = porcelain();
  const r = drive(f, ["record", "--fund-tx", h.fund, FUNDER], { txs }, 120_000);
  assert.equal(r.status, 0, r.out);
  const files = recordFiles(f.state, "testnet");
  assert.ok(existsSync(files.run) && existsSync(files.md), r.out);
  assert.equal(path.dirname(files.md), f.state);
  assert.equal(porcelain(), before, "record wrote under the repository");
  const md = readFileSync(files.md, "utf8");
  assert.match(md, /^Money path: yes$/m);
  assert.deepEqual(txLines(md), lines);
  for (const hash of Object.keys(txs)) assert.ok(r.calls.some((c) => c.method === "EXPERIMENTAL_tx_status" && c.tx_hash === hash), `${hash} not read`);
});

test("LB: record refuses a --fund-tx that reads failed: no file written", async () => {
  const { recordFiles } = await import(DRIVER);
  const { f, h, txs } = await landed();
  const r = drive(f, ["record", "--fund-tx", h.fund, FUNDER], { txs: { ...txs, [h.fund]: { failed: true } } }, 120_000);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`${h.fund} \\(${FUNDER.replace(".", "\\.")}\\): failed`));
  const files = recordFiles(f.state, "testnet");
  assert.ok(!existsSync(files.run) && !existsSync(files.md), "a record was written");
});

test("LB: record leaves a sweep tx that reads failed out of the Tx lines and writes the rest", async () => {
  const { recordFiles } = await import(DRIVER);
  const { f, h, txs, lines, put } = await landed();
  put("sweep", { txs: [{ hash: h.sweep, signer: f.U, amount: "5", to: TO }, { hash: h.sweepBad, signer: f.U, amount: "5", to: TO }] });
  const r = drive(f, ["record", "--fund-tx", h.fund, FUNDER], { txs: { ...txs, [h.sweepBad]: { failed: true } } }, 120_000);
  assert.equal(r.status, 0, r.out);
  const md = readFileSync(recordFiles(f.state, "testnet").md, "utf8");
  assert.deepEqual(txLines(md), lines);
  assert.match(r.out, new RegExp(`${h.sweepBad} \\(${f.U}\\) left out`));
  assert.ok(!md.includes(h.sweepBad));
});
