#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// VT-T04 on NEAR testnet (vault.md 5: "ragequit; a refund note written by settle and spent", as VT-S08 and VT-S09), on
// the keyless vault of contracts/vault/deployments/testnet-v1.json and the team's testnet USDC only. Card
// vault-testnet-t04. Testnet only: it refuses any other vault, token or network.
//
// Accounts:
//   P  the vault's parent (--parent, its key from --key-file, outside the repo): pays NEAR only. It funds D, registers D
//      on the token and makes B and S.
//   D  the depositor: a NEAR-implicit account (64 hex), as the kit's movers are (vaultDepositMessage refuses any other
//      depositor), whose key comes from the run's seed. It prepays, deposits, ragequits and sends both withdrawals
//      (payer and fee recipient), so its USDC ends where it started.
//   B  the bounce: b-<run>.<P>, made with no key and never registered on the token.
//   S  the stranger: s-<run>.<P>, its key from the seed, which only settles.
// The seed (32 random bytes) and every note secret derived from it live in --state, a file outside the repo (mode
// 600), so a stopped run resumes at its next step; nothing secret is printed. Test notes on test USDC only.
//
// Steps, each recorded in --state once it landed:
//   setup      P: Transfer 1 NEAR to D; storage_deposit(D) on the token; create B (CreateAccount, Transfer, no key)
//   funded     waits for D to hold FUND USDC (the token's holder sends it: `fund` below)
//   deposit1   D: storage_prepay(pc1) with vaultPrepayYocto(true); ft_transfer_call(vault, 1,000,000, deposit message)
//   deposit2   the same for 2,000,000
//   ragequit   D: ragequit of note 1, a commitment proof, register_deposit 0, vaultRagequitYocto(0)
//   bounce     D: withdraw note 2 whole to B, register_deposit 0, fee 100,000 to D, vaultWithdrawYocto(0, fee, true):
//              the token refuses B (not registered), so 1,900,000 comes back as refund_pending (VT-S08's case 2)
//   settle     P makes S; S: settle(nullifier 2) with the reserve paying the bytes; S: settle(nullifier 2) again,
//              refused AlreadySettled
//   refund     D: withdraw the refund note (1,900,000, its label from the spends row) whole to D, fee 0
// Every proof: the kit's own input builders (packages/kit/src/vault/inputs.ts vaultWithdrawInput, request.ts
// vaultWithdrawRequest) on trees read by the kit's vaultSync on two testnet operators, then snarkjs 0.7.5
// groth16.fullProve with the pinned packages/kit/zk files and groth16.verify against their .vkey (the browser legs are
// VT-T02's). Every sent tx is read back on two operators: the ones that must succeed with every receipt a success, the
// bounce with exactly one failed receipt (the token's ft_transfer to B) and the second settle failed with
// AlreadySettled. Then the record (--out) and the live check to run next.
//
//   node contracts/vault/scripts/testnet-t04.mjs --dry
//   node contracts/vault/scripts/testnet-t04.mjs --parent <P> --key-file <path> --state <path> --out <file>
//   <the holder's key text on stdin> node contracts/vault/scripts/testnet-t04.mjs fund --to <D>
import "../../../scripts/net-window.mjs";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { b58decode, b58encode } from "./near-tx.mjs";
import { act, encodeTx } from "./testnet-usdc.mjs";
import { loadKey, repoRoots } from "./deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const KIT = path.join(ROOT, "packages/kit");
export const DEPLOYMENT = path.join(ROOT, "contracts/vault/deployments/testnet-v1.json");
export const TOKEN = "bf-usdc-20261101t022248.testnet"; // gitleaks:allow (a public account id)
export const HOLDER = `holder.${TOKEN}`;
export const LIVE_CHECK = "scripts/live-checks/vault-testnet-t04.mjs";
// FastNEAR and dRPC: two operators (near-rpc-operators.mjs); sends go to FastNEAR
export const RPCS = ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"];
const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
export const BYTE = 10n ** 19n;
export const AMOUNTS = { note1: 1_000_000n, note2: 2_000_000n, fee: 100_000n };
export const FUND = AMOUNTS.note1 + AMOUNTS.note2;
export const REGISTER = 1_250_000_000_000_000_000_000n; // the token's storage_balance_bounds (testnet-usdc.json)
export const D_NEAR = NEAR;
export const B_NEAR = NEAR / 100n;
// a FunctionCall's prepaid gas is charged up front at the gas price (testnet 1e9 yocto/gas: 100 Tgas = 0.1 NEAR) and
// refunded after, so S holds well above settle's 100 Tgas (a first run's 0.1 NEAR was refused NotEnoughBalance)
export const S_NEAR = NEAR / 2n;
export const REFUND_RESERVE_BYTES = 389n; // constants.rs
export const LEVEL_BYTES = 74n; // vault.md 2.3: what a tree that grows a level adds to an insert
const GAS = { prepay: 30n * TGAS, deposit: 180n * TGAS, ragequit: 300n * TGAS, withdraw: 300n * TGAS, settle: 100n * TGAS, plain: 30n * TGAS };

// ---- pure parts (tested in testnet-t04.test.mjs) ----

/** A field element from the seed and a tag: sha256(seed ‖ tag) mod p, never 0. */
export function fieldOf(seed, tag, p) {
  const n = BigInt("0x" + createHash("sha256").update(seed).update(`vt-t04/${tag}`).digest("hex")) % p;
  if (n === 0n) throw new Error(`fieldOf(${tag}) is 0`);
  return n;
}

/** An ed25519 key from the seed and a tag: { pub (32 B), privateKey }. */
export function keyOf(seed, tag) {
  const d = createHash("sha256").update(seed).update(`vt-t04/key/${tag}`).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), d]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  return { pub, privateKey };
}

/** The run's short id, from the seed: names B and S. */
export const runId = (seed) => createHash("sha256").update(seed).update("vt-t04/run").digest("hex").slice(0, 8);

/** The accounts of a run under `parent`. */
export function accountsOf(seed, parent) {
  const id = runId(seed);
  return { P: parent, D: keyOf(seed, "D").pub.toString("hex"), B: `b-${id}.${parent}`, S: `s-${id}.${parent}` };
}

/** Whether inserting at `index` grows a LeanIMT a level: depth = ceil(log2(size)), so index 2^k (k ≥ 0, index ≥ 1). */
export const growsAt = (index) => index >= 1n && (index & (index - 1n)) === 0n;

/** What settle writes for a refund note at leaf `leafIndex` and label `labelIndex`, in yocto (vault.md 2.3). */
export function settleCost(leafIndex, labelIndex) {
  const bytes = REFUND_RESERVE_BYTES + (growsAt(leafIndex) ? LEVEL_BYTES : 0n) + (growsAt(labelIndex) ? LEVEL_BYTES : 0n);
  return bytes * BYTE;
}

// EXPERIMENTAL_tx_status / send_tx answers: the receipts that failed, with their receiver and error text.
export function failures(r) {
  return (r?.receipts_outcome ?? [])
    .filter((o) => typeof o?.outcome?.status !== "object" || o.outcome.status === null || "Failure" in o.outcome.status)
    .map((o) => ({ receiver: o.outcome.executor_id, error: JSON.stringify(o.outcome.status?.Failure ?? o.outcome.status) }));
}

/** [] when a tx and every receipt succeeded. */
export function successProblems(r) {
  const p = [];
  if (!r?.status || !("SuccessValue" in r.status || "SuccessReceiptId" in r.status)) p.push(`status ${JSON.stringify(r?.status).slice(0, 300)}`);
  if (r?.final_execution_status && r.final_execution_status !== "FINAL") p.push(`not final (${r.final_execution_status})`);
  for (const f of failures(r)) p.push(`receipt on ${f.receiver} failed: ${f.error.slice(0, 300)}`);
  return p;
}

/**
 * [] when a withdrawal's payout bounced as VT-S08's case 2: the tx succeeded, exactly one receipt failed, on the token,
 * as not registered, and the vault logged a payout of `refunded` returned to a refund note.
 */
export function bounceProblems(r, { token, refunded }) {
  const p = [];
  if (!r?.status || !("SuccessValue" in r.status)) p.push(`status ${JSON.stringify(r?.status).slice(0, 300)}`);
  if (r?.final_execution_status && r.final_execution_status !== "FINAL") p.push(`not final (${r.final_execution_status})`);
  const f = failures(r);
  if (f.length !== 1) p.push(`${f.length} failed receipts, want exactly 1`);
  else {
    if (f[0].receiver !== token) p.push(`the failed receipt ran on ${f[0].receiver}, not the token`);
    if (!/not registered/i.test(f[0].error)) p.push(`the token's refusal is not "not registered": ${f[0].error.slice(0, 200)}`);
  }
  const payout = logsOf(r).map(eventOf).find((e) => e?.event === "payout");
  const returned = payout?.data?.[0]?.returned ?? payout?.data?.returned;
  if (String(returned) !== String(refunded)) p.push(`the payout event returned ${returned}, want ${refunded}`);
  return p;
}

/** [] when a tx failed at the vault with `code` and moved nothing (no receipt but the vault's and refunds). */
export function refusedProblems(r, code, vault) {
  const p = [];
  const text = JSON.stringify(r?.status?.Failure ?? null);
  if (!r?.status?.Failure) p.push(`status ${JSON.stringify(r?.status).slice(0, 300)}, want a failure`);
  else if (!text.includes(code)) p.push(`failed with ${text.slice(0, 200)}, want ${code}`);
  const ran = (r?.receipts_outcome ?? []).filter((o) => o.outcome.executor_id !== vault && o.outcome.executor_id !== r?.transaction?.signer_id);
  if (ran.length) p.push(`receipts ran on ${ran.map((o) => o.outcome.executor_id).join(", ")}`);
  return p;
}

const logsOf = (r) => (r?.receipts_outcome ?? []).flatMap((o) => o.outcome.logs ?? []);
function eventOf(line) {
  if (!line.startsWith("EVENT_JSON:")) return null;
  try {
    return JSON.parse(line.slice(11));
  } catch {
    return null;
  }
}

/** The NEAR moved by Transfer actions to `to` in a tx's receipts. */
export function transferredTo(r, to) {
  let sum = 0n;
  for (const x of r?.receipts ?? []) {
    if (x.receiver_id !== to || x.predecessor_id === "system") continue;
    for (const a of x.receipt?.Action?.actions ?? []) if (a?.Transfer) sum += BigInt(a.Transfer.deposit);
  }
  return sum;
}

/**
 * The record's markdown section the money gate reads: one Tx line per tx that succeeded with every receipt, and the
 * two whose failures are the test (the bounce, the refused settle) on lines the live check and this script read, not
 * the gate, since the gate refuses a tx with any failed receipt.
 */
export function recordLines(record) {
  const out = ["Money path: yes"];
  for (const t of record.txs) if (t.expect === "success") out.push(`Tx: near-testnet ${t.hash} ${t.signer}`);
  for (const t of record.txs) if (t.expect !== "success") out.push(`Expected refusal (${t.step}, ${t.expect}): near-testnet ${t.hash} ${t.signer}`);
  return out;
}

// ---- the network ----

async function rpc(url, method, params, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "vt-t04", method, params }),
        signal: AbortSignal.timeout(180_000),
        redirect: "error",
      });
      if (r.status === 429 && i < tries) {
        await new Promise((ok) => setTimeout(ok, 3000 * i));
        continue;
      }
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(`${method} on ${url}: ${JSON.stringify(j.error).slice(0, 400)}`), { rpcError: j.error });
      if (j.result?.error) throw new Error(`${method} on ${url}: ${String(j.result.error).slice(0, 400)}`);
      return j.result;
    } catch (e) {
      if (e.rpcError || i >= tries) throw e;
      await new Promise((ok) => setTimeout(ok, 2000 * i));
    }
  }
}

export const view = async (url, account_id, method, args) => {
  const r = await rpc(url, "query", { request_type: "call_function", account_id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), finality: "final" });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
};

/** The same view on both operators, which must answer the same. */
async function view2(account, method, args) {
  const [a, b] = await Promise.all(RPCS.map((u) => view(u, account, method, args)));
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    await new Promise((ok) => setTimeout(ok, 3000));
    const [c, d] = await Promise.all(RPCS.map((u) => view(u, account, method, args)));
    if (JSON.stringify(c) !== JSON.stringify(d)) throw new Error(`${account}.${method} differs on the two operators`);
    return c;
  }
  return a;
}

async function nearOf(account) {
  try {
    return BigInt((await rpc(RPCS[0], "query", { request_type: "view_account", account_id: account, finality: "final" })).amount);
  } catch (e) {
    if (/UNKNOWN_ACCOUNT/.test(e.message)) return null;
    throw e;
  }
}

/** Signs and sends one tx from `signer` with `key`; waits for FINAL; returns { hash, r } whatever the outcome. */
async function send(signer, key, receiver, actions) {
  const pk = `ed25519:${b58encode(key.pub)}`;
  const ak = await rpc(RPCS[0], "query", { request_type: "view_access_key", account_id: signer, public_key: pk, finality: "final" });
  const block = await rpc(RPCS[0], "block", { finality: "final" });
  const tx = encodeTx({ signer, publicKey: key.pub, nonce: BigInt(ak.nonce) + 1n, receiver, blockHash: b58decode(block.header.hash), actions });
  const h = createHash("sha256").update(tx).digest();
  const signed = Buffer.concat([tx, Buffer.from([0]), sign(null, h, key.privateKey)]);
  const hash = b58encode(h);
  let r;
  try {
    r = await rpc(RPCS[0], "send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" }, 1);
  } catch (e) {
    // a timeout or a dropped answer: the tx may still land, so read it by hash before giving up
    r = await readBack(hash, signer, 0, 30);
    if (!r) throw new Error(`${signer} -> ${receiver}: ${e.message}`);
  }
  return { hash, r };
}

/** EXPERIMENTAL_tx_status of `hash` on RPCS[i], waiting for FINAL; null when unknown after `tries`. */
async function readBack(hash, signer, i, tries = 20) {
  for (let n = 0; n < tries; n++) {
    try {
      const r = await rpc(RPCS[i], "EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" });
      if (r?.final_execution_status === "FINAL") return r;
    } catch (e) {
      if (!/UNKNOWN_TRANSACTION|TIMEOUT|timeout/i.test(e.message)) throw e;
    }
    await new Promise((ok) => setTimeout(ok, 3000));
  }
  return null;
}

// ---- the run ----

function loadState(file, roots) {
  const real = path.resolve(file);
  for (const r of roots) if (real === r || real.startsWith(r + path.sep)) throw new Error(`--state is inside the repository (${r}): the run's seed never lives in the repo`);
  if (!existsSync(real)) {
    writeFileSync(real, JSON.stringify({ seed: randomBytes(32).toString("hex"), steps: {} }) + "\n", { mode: 0o600, flag: "wx" });
  }
  const s = JSON.parse(readFileSync(real, "utf8"));
  if (!/^[0-9a-f]{64}$/.test(s.seed ?? "")) throw new Error("--state: no seed");
  return { file: real, seed: Buffer.from(s.seed, "hex"), steps: s.steps ?? {}, save() {
    writeFileSync(real, JSON.stringify({ seed: s.seed, steps: this.steps }, null, 1) + "\n", { mode: 0o600 });
  } };
}

async function kitModules() {
  const req = createRequire(path.join(KIT, "package.json"));
  const imp = (m) => import(pathToFileURL(req.resolve(m)).href);
  const kit = (f) => import(pathToFileURL(path.join(KIT, "src/vault", f)).href);
  const [{ poseidon1 }, { poseidon2 }, { poseidon3 }, snarkjs, inputs, shapes, request, sync] = await Promise.all([
    imp("poseidon-lite/poseidon1"), imp("poseidon-lite/poseidon2"), imp("poseidon-lite/poseidon3"), imp("snarkjs"),
    kit("inputs.ts"), kit("shapes.ts"), kit("request.ts"), kit("sync.ts"),
  ]);
  return { poseidon1, poseidon2, poseidon3, snarkjs, ...inputs, ...shapes, ...request, ...sync };
}

/** A note's secrets and precommitment from the seed. */
function noteSecrets(k, seed, tag) {
  const nullifier = fieldOf(seed, `${tag}/nullifier`, k.VAULT_FIELD_P);
  const secret = fieldOf(seed, `${tag}/secret`, k.VAULT_FIELD_P);
  return { nullifier, secret, precommitment: k.poseidon2([nullifier, secret]), nullifierHash: k.poseidon1([nullifier]) };
}

async function prove(k, circuit, input) {
  const zk = (f) => path.join(KIT, "zk", f);
  const t = Date.now();
  const { proof, publicSignals } = await k.snarkjs.groth16.fullProve(input, zk(`${circuit}.wasm`), zk(`${circuit}.zkey`));
  const vkey = JSON.parse(readFileSync(zk(`${circuit}.vkey`), "utf8"));
  if (!(await k.snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error(`${circuit}: snarkjs refuses its own proof`);
  return { proof: k.vaultProof(proof), publicSignals, proveMs: Date.now() - t };
}

/** The vault read by the kit's vaultSync on both operators, at one block. */
async function synced(k, vault) {
  const rpcs = RPCS.map((u) => ({ name: u, query: (params) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "vt-t04", method: "query", params }), signal: AbortSignal.timeout(60_000), redirect: "error" }).then((r) => r.json()) }));
  for (let i = 1; ; i++) {
    try {
      return await k.vaultSync({ vault, rpcs, cursor: k.vaultSyncStart(vault) });
    } catch (e) {
      if (i >= 5) throw e;
      await new Promise((ok) => setTimeout(ok, 3000));
    }
  }
}

/** A withdraw proof spending `note` whole, by the kit's request and input builders, on the trees `s` holds. */
async function withdrawProof(k, { vault, scope, s, note, change, refund, recipient, feeRecipient, fee }) {
  const nowMs = Date.now();
  const { withdrawal, context } = k.vaultWithdrawRequest({
    vaultId: vault, token: TOKEN, recipient, registerDeposit: 0n, feeRecipient, relayFee: fee,
    refundPrecommitment: refund.precommitment, deadlineMs: nowMs + 30 * 60_000, withdrawn: note.value, nowMs,
  });
  const stateTree = new k.VaultTree(s.leaves);
  const labelTree = new k.VaultTree(s.labels);
  if (stateTree.root !== s.stateTree.root || labelTree.root !== s.labelTree.root) throw new Error("the synced trees' roots are not the vault's");
  const input = k.vaultWithdrawInput({
    stateTree, labelTree, newestStateRoot: s.stateTree.root, newestLabelRoot: s.labelTree.root,
    note, newNullifier: change.nullifier, newSecret: change.secret, withdrawn: note.value, withdrawal, vaultId: vault, scope, nowMs,
  });
  const p = await prove(k, "withdraw", input);
  if (p.publicSignals[7] !== context) throw new Error("the proof's context is not the request's");
  return { withdrawal, ...p };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  if (argv[0] === "fund") return fund(opt("--to"));
  const dry = argv.includes("--dry");
  const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  const VAULT = deployment.account_id;
  if (deployment.network !== "testnet" || deployment.asset !== TOKEN || !VAULT.endsWith(".testnet")) throw new Error("testnet-v1.json is not the testnet vault on the team's USDC");
  const k = await kitModules();
  const cfg = await view2(VAULT, "config", {});
  if (cfg.asset !== TOKEN || !/ testnet$/.test(cfg.version)) throw new Error(`the vault's config is not the testnet build on ${TOKEN}`);
  const scope = BigInt(cfg.scope);
  if (dry) return dryRun(k, VAULT, scope, deployment.parent);

  const parent = opt("--parent");
  if (parent !== deployment.parent) throw new Error(`--parent must be the vault's parent ${deployment.parent}`);
  if (!opt("--key-file") || !opt("--state") || !opt("--out")) throw new Error("--key-file, --state and --out are required");
  const roots = repoRoots();
  const P = { id: parent, key: loadKey(opt("--key-file"), parent, roots) };
  const st = loadState(opt("--state"), roots);
  const acc = accountsOf(st.seed, parent);
  const D = { id: acc.D, key: keyOf(st.seed, "D") };
  const S = { id: acc.S, key: keyOf(st.seed, "S") };
  const N1 = noteSecrets(k, st.seed, "note1");
  const N2 = noteSecrets(k, st.seed, "note2");
  const RQ = noteSecrets(k, st.seed, "ragequit/refund");
  const R2 = noteSecrets(k, st.seed, "bounce/refund");
  const C2 = noteSecrets(k, st.seed, "bounce/change");
  const R3 = noteSecrets(k, st.seed, "refund/refund");
  const C3 = noteSecrets(k, st.seed, "refund/change");
  const log = (s) => console.log(`vt-t04: ${s}`);
  log(`accounts: P ${acc.P}, D ${acc.D}, B ${acc.B}, S ${acc.S}`);

  const balances = async () => ({
    at: new Date().toISOString(),
    D_usdc: await view2(TOKEN, "ft_balance_of", { account_id: acc.D }).catch(() => null),
    vault_usdc: await view2(TOKEN, "ft_balance_of", { account_id: VAULT }),
    B_usdc: await view2(TOKEN, "ft_balance_of", { account_id: acc.B }).catch(() => null),
    B_registered: await view2(TOKEN, "storage_balance_of", { account_id: acc.B }),
    D_near: String(await nearOf(acc.D)),
    P_near: String(await nearOf(acc.P)),
    totals: await view2(VAULT, "totals", {}),
  });
  st.steps.before ??= await balances();
  st.save();

  // one tx, read back on both operators with `check` (successProblems unless named), stored under steps[step].txs
  const tx = async (step, signer, receiver, actions, { expect = "success", check = successProblems, method } = {}) => {
    const { hash, r } = await send(signer.id, signer.key, receiver, actions);
    const reads = await Promise.all(RPCS.map((_, i) => readBack(hash, signer.id, i)));
    const problems = reads.flatMap((x, i) => (x ? check(x).map((p) => `${RPCS[i]}: ${p}`) : [`${RPCS[i]}: not read`]));
    const vaultGas = (r.receipts_outcome ?? []).filter((o) => o.outcome.executor_id === VAULT).map((o) => o.outcome.gas_burnt);
    const row = { step, method, hash, signer: signer.id, expect, vault_gas_burnt: vaultGas, problems };
    (st.steps[step] ??= { txs: [] }).txs.push(row);
    st.save();
    log(`${step}: ${method} ${hash} ${problems.length ? `PROBLEMS ${problems.join("; ")}` : "read back on both operators as expected"}`);
    if (problems.length) throw new Error(`${step}: ${method} ${hash} did not read back as expected`);
    return { hash, r: reads[0] };
  };
  const done = (step) => st.steps[step]?.done === true;
  const finish = (step, extra = {}) => {
    Object.assign((st.steps[step] ??= { txs: [] }), extra, { done: true });
    st.save();
  };

  if (!done("setup")) {
    if ((await nearOf(acc.D)) === null) await tx("setup", P, acc.D, [act.transfer(D_NEAR)], { method: "Transfer (D, implicit)" });
    if ((await view2(TOKEN, "storage_balance_of", { account_id: acc.D })) === null)
      await tx("setup", P, TOKEN, [act.call("storage_deposit", { account_id: acc.D, registration_only: true }, GAS.plain, REGISTER)], { method: "storage_deposit (D)" });
    if ((await nearOf(acc.B)) === null) await tx("setup", P, acc.B, [act.create(), act.transfer(B_NEAR)], { method: "CreateAccount (B, no key)" });
    finish("setup");
  }
  if (!done("funded")) {
    const have = BigInt(await view2(TOKEN, "ft_balance_of", { account_id: acc.D }));
    if (have < FUND) {
      log(`D holds ${have} USDC units, needs ${FUND}: the holder sends it with \`fund --to ${acc.D}\`, then run again`);
      process.exit(3);
    }
    finish("funded", { usdc: String(have) });
  }
  const deposit = async (step, n, value) => {
    if (done(step)) return;
    await tx(step, D, VAULT, [act.call("storage_prepay", { precommitment: String(n.precommitment) }, GAS.prepay, k.vaultPrepayYocto(true))], { method: "storage_prepay" });
    const msg = k.vaultDepositMessage(n.precommitment, acc.D);
    await tx(step, D, TOKEN, [act.call("ft_transfer_call", { receiver_id: VAULT, amount: String(value), msg }, GAS.deposit, 1n)], { method: "ft_transfer_call (deposit)" });
    const s = await synced(k, VAULT);
    const row = s.deposits.find((d) => d.precommitment === n.precommitment);
    if (!row || row.value !== value || row.depositor !== acc.D) throw new Error(`${step}: no deposit row of ${value} by D on precommitment`);
    finish(step, { label: String(row.label), leaf_index: String(row.leafIndex) });
  };
  await deposit("deposit1", N1, AMOUNTS.note1);
  await deposit("deposit2", N2, AMOUNTS.note2);

  if (!done("ragequit")) {
    const label = BigInt(st.steps.deposit1.label);
    const p = await prove(k, "commitment", { value: AMOUNTS.note1, label, nullifier: N1.nullifier, secret: N1.secret });
    if (p.publicSignals[1] !== String(N1.nullifierHash) || p.publicSignals[2] !== String(AMOUNTS.note1)) throw new Error("ragequit: the proof's signals are not note 1's");
    await tx("ragequit", D, VAULT, [act.call("ragequit", { proof: p.proof, public_signals: p.publicSignals, register_deposit: "0", refund_precommitment: String(RQ.precommitment) }, GAS.ragequit, k.vaultRagequitYocto(0n))], { method: "ragequit" });
    finish("ragequit", { nullifier_hash: String(N1.nullifierHash), prove_ms: p.proveMs });
  }
  if (!done("bounce")) {
    const s = await synced(k, VAULT);
    const note = { value: AMOUNTS.note2, label: BigInt(st.steps.deposit2.label), nullifier: N2.nullifier, secret: N2.secret };
    const w = await withdrawProof(k, { vault: VAULT, scope, s, note, change: C2, refund: R2, recipient: acc.B, feeRecipient: acc.D, fee: AMOUNTS.fee });
    const refunded = AMOUNTS.note2 - AMOUNTS.fee;
    await tx("bounce", D, VAULT, [act.call("withdraw", { withdrawal: w.withdrawal, proof: w.proof, public_signals: w.publicSignals }, GAS.withdraw, k.vaultWithdrawYocto(0n, AMOUNTS.fee, true))], {
      method: "withdraw (to B, bounces)", expect: "bounce", check: (r) => bounceProblems(r, { token: TOKEN, refunded }),
    });
    finish("bounce", { nullifier_hash: String(N2.nullifierHash), prove_ms: w.proveMs });
  }
  if (!done("settle")) {
    const sNear = await nearOf(acc.S);
    if (sNear === null) await tx("settle", P, acc.S, [act.create(), act.transfer(S_NEAR), act.fullKey(S.key.pub)], { method: "CreateAccount (S)" });
    else if (sNear < S_NEAR) await tx("settle", P, acc.S, [act.transfer(S_NEAR - sNear)], { method: "Transfer (S, to S_NEAR)" });
    const s = await synced(k, VAULT);
    const row = s.spends.find((x) => x.nullifierHash === N2.nullifierHash);
    if (!row || row.status !== "refund_pending" || row.refundValue !== AMOUNTS.note2 - AMOUNTS.fee) throw new Error(`settle: the bounce's row is ${row?.status} ${row?.refundValue}, want refund_pending ${AMOUNTS.note2 - AMOUNTS.fee}`);
    const leafIndex = BigInt(s.stateTree.size);
    const labelIndex = BigInt(s.labelTree.size);
    const cost = settleCost(leafIndex, labelIndex);
    const attach = cost > row.reserve ? cost - row.reserve : 0n;
    const settleArgs = { nullifier_hash: String(N2.nullifierHash) };
    const first = await tx("settle", S, VAULT, [act.call("settle", settleArgs, GAS.settle, attach)], {
      method: "settle (S)",
      check: (r) => {
        const p = successProblems(r);
        const back = transferredTo(r, acc.D);
        const want = row.reserve > cost ? row.reserve - cost : 0n;
        if (back !== want) p.push(`the payer got ${back} yocto back, want reserve ${row.reserve} - bytes ${cost} = ${want}`);
        return p;
      },
    });
    const after = await synced(k, VAULT);
    const r2 = after.spends.find((x) => x.nullifierHash === N2.nullifierHash);
    const commitment = k.poseidon3([r2.refundValue, r2.refundLabel, R2.precommitment]);
    if (r2.status !== "settled" || r2.reserve !== 0n || after.leaves[Number(r2.refundLeafIndex)] !== commitment) throw new Error("settle: the refund note is not Poseidon(refund, label, R2) at its leaf");
    await tx("settle", S, VAULT, [act.call("settle", settleArgs, GAS.plain, 0n)], { method: "settle (S, again)", expect: "refused AlreadySettled", check: (r) => refusedProblems(r, "AlreadySettled", VAULT) });
    finish("settle", {
      reserve_before: String(row.reserve), settle_cost: String(cost), attached: String(attach), payer_back: String(transferredTo(first.r, acc.D)),
      refund_value: String(r2.refundValue), refund_label: String(r2.refundLabel), refund_leaf_index: String(r2.refundLeafIndex), refund_commitment: String(commitment),
      refund_precommitment: String(R2.precommitment),
    });
  }
  if (!done("refund")) {
    const s = await synced(k, VAULT);
    const r2 = st.steps.settle;
    const note = { value: BigInt(r2.refund_value), label: BigInt(r2.refund_label), nullifier: R2.nullifier, secret: R2.secret };
    const w = await withdrawProof(k, { vault: VAULT, scope, s, note, change: C3, refund: R3, recipient: acc.D, feeRecipient: acc.D, fee: 0n });
    await tx("refund", D, VAULT, [act.call("withdraw", { withdrawal: w.withdrawal, proof: w.proof, public_signals: w.publicSignals }, GAS.withdraw, k.vaultWithdrawYocto(0n, 0n, true))], { method: "withdraw (refund note to D)" });
    finish("refund", { nullifier_hash: String(R2.nullifierHash), prove_ms: w.proveMs });
  }
  st.steps.after ??= await balances();
  st.save();

  const txs = Object.values(st.steps).flatMap((x) => x?.txs ?? []);
  const record = {
    card: "vault-testnet-t04",
    network: "testnet",
    vault: VAULT,
    token: TOKEN,
    accounts: { parent: acc.P, depositor: acc.D, bounce: acc.B, settler: acc.S },
    amounts: { note1: String(AMOUNTS.note1), note2: String(AMOUNTS.note2), fee: String(AMOUNTS.fee), refund: String(AMOUNTS.note2 - AMOUNTS.fee) },
    ragequit: { nullifier_hash: st.steps.ragequit.nullifier_hash, label: st.steps.deposit1.label },
    bounce: { nullifier_hash: st.steps.bounce.nullifier_hash },
    settle: Object.fromEntries(Object.entries(st.steps.settle).filter(([k2]) => k2 !== "txs" && k2 !== "done")),
    refund: { nullifier_hash: st.steps.refund.nullifier_hash },
    prove_ms: { ragequit: st.steps.ragequit.prove_ms, bounce: st.steps.bounce.prove_ms, refund: st.steps.refund.prove_ms },
    before: st.steps.before,
    after: st.steps.after,
    txs: txs.map(({ step, method, hash, signer, expect, vault_gas_burnt }) => ({ step, method, hash, signer, expect, vault_gas_burnt })),
  };
  writeFileSync(opt("--out"), JSON.stringify(record, null, 2) + "\n");
  for (const l of recordLines(record)) console.log(l);
  log(`D's USDC ${record.before.D_usdc ?? "none"} -> ${record.after.D_usdc}; vault USDC ${record.before.vault_usdc} -> ${record.after.vault_usdc}`);
  console.log(`next: node ${LIVE_CHECK} --run ${path.relative(ROOT, path.resolve(opt("--out")))}`);
}

/** The plan with no key and no tx: the accounts, every call and attachment, and both proofs made against the trees the run would build on the vault as it is now. */
async function dryRun(k, VAULT, scope, parent) {
  const seed = randomBytes(32);
  const acc = accountsOf(seed, parent);
  const s0 = await synced(k, VAULT);
  const nonce = BigInt(s0.deposits.length);
  const N1 = noteSecrets(k, seed, "note1");
  const N2 = noteSecrets(k, seed, "note2");
  const R2 = noteSecrets(k, seed, "bounce/refund");
  const say = (s) => console.log(`dry: ${s}`);
  say(`vault ${VAULT} (scope ${scope}), now ${s0.stateTree.size} leaves, ${s0.labelTree.size} labels, ${s0.deposits.length} deposits, ${s0.spends.length} spends`);
  say(`accounts (this dry seed): P ${acc.P}, D ${acc.D}, B ${acc.B}, S ${acc.S}`);
  say(`setup: P Transfer ${D_NEAR} yocto to D; P storage_deposit(D) ${REGISTER}; P CreateAccount B + Transfer ${B_NEAR}`);
  say(`funded: D needs ${FUND} USDC units from ${HOLDER} (fund --to D)`);
  say(`deposit1: D storage_prepay ${k.vaultPrepayYocto(true)} yocto; D ft_transfer_call ${AMOUNTS.note1} msg ${k.vaultDepositMessage(N1.precommitment, acc.D).length} B`);
  say(`deposit2: the same for ${AMOUNTS.note2}`);
  say(`ragequit: D ragequit(note 1), register_deposit 0, attach ${k.vaultRagequitYocto(0n)} yocto, ${GAS.ragequit / TGAS} Tgas`);
  say(`bounce: D withdraw(note 2 whole) to B, fee ${AMOUNTS.fee} to D, attach ${k.vaultWithdrawYocto(0n, AMOUNTS.fee, true)} yocto: B gets nothing, refund_pending ${AMOUNTS.note2 - AMOUNTS.fee}`);
  say(`settle: P CreateAccount S + ${S_NEAR} + key; S settle (reserve pays ${settleCost(BigInt(s0.stateTree.size) + 3n, BigInt(s0.labelTree.size) + 2n)} yocto of bytes); S settle again: AlreadySettled`);
  say(`refund: D withdraw(refund note ${AMOUNTS.note2 - AMOUNTS.fee} whole) to D, fee 0, attach ${k.vaultWithdrawYocto(0n, 0n, true)} yocto`);
  // both proofs on the trees as the run would leave them, with the vault's labels for the next nonces
  const { keccak_256 } = await import(pathToFileURL(createRequire(path.join(KIT, "package.json")).resolve("@noble/hashes/sha3.js")).href);
  if (k.vaultScopeOf(keccak_256, VAULT, TOKEN) !== scope) throw new Error("the kit's scope of the vault is not config().scope");
  const label = (n) => k.vaultLabelOf(keccak_256, scope, n);
  const l1 = label(nonce + 1n);
  const l2 = label(nonce + 2n);
  const c1 = k.poseidon3([AMOUNTS.note1, l1, N1.precommitment]);
  const c2 = k.poseidon3([AMOUNTS.note2, l2, N2.precommitment]);
  const leaves = [...s0.leaves, c1, c2];
  const labels = [...s0.labels, l1, l2];
  const rq = await prove(k, "commitment", { value: AMOUNTS.note1, label: l1, nullifier: N1.nullifier, secret: N1.secret });
  say(`ragequit proof: commitment ${rq.publicSignals[0] === String(c1) ? "equals note 1's" : "DIFFERS"}, ${rq.proveMs} ms, snarkjs verify ok`);
  const fake = { leaves, labels, stateTree: { root: new k.VaultTree(leaves).root }, labelTree: { root: new k.VaultTree(labels).root } };
  const w = await withdrawProof(k, { vault: VAULT, scope, s: fake, note: { value: AMOUNTS.note2, label: l2, nullifier: N2.nullifier, secret: N2.secret }, change: noteSecrets(k, seed, "bounce/change"), refund: R2, recipient: acc.B, feeRecipient: acc.D, fee: AMOUNTS.fee });
  say(`bounce proof: context equals the request's, ${w.proveMs} ms, snarkjs verify ok`);
  say("nothing signed, nothing sent");
}

/** `fund`: the token's holder sends FUND to `to`; the holder's key text on stdin (ed25519:<base58 64 B> or a key file's JSON), kept in this process only. */
async function fund(to) {
  if (!/^[0-9a-f]{64}$/.test(to ?? "")) throw new Error("fund --to <D, 64 hex>");
  const text = readFileSync(0, "utf8").trim();
  let secret = text;
  if (text.startsWith("{")) secret = JSON.parse(text).private_key ?? JSON.parse(text).secret_key;
  if (typeof secret !== "string" || !secret.startsWith("ed25519:")) throw new Error("stdin holds no ed25519 key");
  const raw = b58decode(secret.slice(8));
  if (raw.length !== 64) throw new Error("the key is not 64 bytes");
  const key = { pub: raw.subarray(32), privateKey: createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: raw.subarray(0, 32).toString("base64url"), x: raw.subarray(32).toString("base64url") }, format: "jwk" }) };
  if ((await view2(TOKEN, "storage_balance_of", { account_id: to })) === null) throw new Error(`${to} is not registered on the token: run the setup step first`);
  const { hash, r } = await send(HOLDER, key, TOKEN, [act.call("ft_transfer", { receiver_id: to, amount: String(FUND) }, GAS.plain, 1n)]);
  const p = successProblems(r);
  console.log(`fund: ft_transfer ${FUND} to ${to}: ${hash} ${p.length ? `PROBLEMS ${p.join("; ")}` : "ok"}`);
  console.log(`Tx: near-testnet ${hash} ${HOLDER}`);
  if (p.length) process.exit(1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // snarkjs keeps worker threads alive after its last proof, so the run ends itself
  main().then(() => process.exit(0), (e) => {
    console.error(`testnet-t04: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(1);
  });
}
