#!/usr/bin/env node
// Live check of card vault-kit-settle: on the keyless testnet vault, a withdrawal whose fee part failed became a refund
// note of exactly the returned amount through the kit's own settle, sent by the device's own account, and a second
// settle was refused. From the run record (scripts/live-checks/vault-kit-settle.testnet.json, written by
// packages/kit/test/vault-settle-testnet.mjs), on two testnet operators (operatorProblems), at the final block:
//   - the vault's key list is [] (it stays keyless);
//   - the spend row of the record's nullifier hash, alone of its nullifier: withdrawn the whole note to the device, its
//     fee to the fee recipient, settled with reserve 0, refund_value exactly the note (vault review A-01: a failed fee
//     part fails the one payout receipt, so all of it comes back), on the record's refund precommitment, with the
//     record's refund label and leaf index;
//   - the state tree's leaf at refund_leaf_index is Poseidon(refund_value, refund_label, refund_precommitment), worked
//     out here from the row (poseidon-lite, the kit's own dependency), and the record's note leaf is that one: the
//     note the kit wrote is the spend row's own leaf;
//   - the fee recipient is still not registered on the token (why the fee part failed);
//   - the settle transaction: signed by the device, one FunctionCall settle({nullifier_hash}) on the vault with the
//     kit's 150 Tgas and 148 B x 1e19, every receipt a success; the second settle failed AlreadySettled.
//   node scripts/live-checks/vault-kit-settle.mjs [--run <file>] [--record <file>]   PASS exit 0, FAIL 1, error 2
// --record writes every RPC answer the run read to <file>, so the check's test can replay it, each transaction's
// signature left out (a 64-byte ed25519 signature reads as a NEAR secret key to the secret scan; the check reads none).
// Runs: once, a recorded testnet run read back on chain; no host deploy changes it
import "../net-window.mjs";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RPCS, operatorProblems, query, recorder } from "./vault-skeleton.mjs";
import { rpc, wait } from "../ci/rpc-wait.mjs";

const KEY = "vault-kit-settle";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUN = path.join(HERE, "vault-kit-settle.testnet.json");
export const VAULT = "v4.bf-vt-20261106t125654.testnet"; // contracts/vault/deployments/testnet-v4.json
export const TOKEN = "bf-usdc-20261101t022248.testnet"; // gitleaks:allow (a public account id)
const SETTLE_GAS = "150000000000000"; // the kit's VAULT_SETTLE_GAS
const SETTLE_ATTACH = "1480000000000000000000"; // the kit's VAULT_SETTLE_REFUND_ATTACH, 148 B x 1e19
const { poseidon3 } = createRequire(path.join(HERE, "../../packages/kit/package.json"))("poseidon-lite/poseidon3");

async function view(fetchFn, url, account_id, method_name, args, sleep) {
  const r = await query(fetchFn, url, { request_type: "call_function", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), finality: "final" }, sleep);
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}

async function txStatus(fetchFn, url, hash, signer, sleep) {
  const j = await rpc(fetchFn, url, "EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" }, sleep);
  if (j.error) throw new Error(`tx ${hash}: ${j.error.cause?.name ?? j.error.name ?? "error"}`);
  return j.result;
}

const okStatus = (s) => s && typeof s === "object" && ("SuccessValue" in s || "SuccessReceiptId" in s);

export async function check({ run, fetchFn = fetch, rpcs = RPCS, sleep = wait }) {
  const lines = [];
  let ok = true;
  const say = (good, text) => {
    ok &&= good;
    lines.push(`${good ? "ok " : "BAD"} ${text}`);
  };
  for (const p of operatorProblems(rpcs)) say(false, p);
  rpcs = rpcs.slice(0, 2);
  say(run.vault === VAULT && run.asset === TOKEN, `the run record names the testnet vault ${VAULT} on ${TOKEN}: ${run.vault} on ${run.asset}`);
  const D = run.accounts?.device;
  const B = run.accounts?.fee_recipient;
  const note = BigInt(run.amounts?.note ?? -1);
  const nf = run.bounce?.nullifier_hash;
  say(/^[0-9a-f]{64}$/.test(D ?? "") && note > 0n && run.amounts?.refund === run.amounts?.note, `the record's device is NEAR-implicit and its refund is the whole note: ${run.amounts?.refund} of ${run.amounts?.note}`);
  const tx = (step) => (run.txs ?? []).find((t) => t.step === step);
  for (const url of rpcs) {
    const at = `on ${url}`;
    try {
      const keys = await query(fetchFn, url, { request_type: "view_access_key_list", account_id: VAULT, finality: "final" }, sleep);
      say(Array.isArray(keys.keys) && keys.keys.length === 0, `the vault's key list is [] ${at}: ${Array.isArray(keys.keys) ? keys.keys.length : "no list"}`);
      const spends = await view(fetchFn, url, VAULT, "spends", { from: 0, limit: 250 }, sleep);
      const rows = spends.filter((s) => s.nullifier_hash === nf);
      const s = rows[0];
      say(rows.length === 1, `one spend row for the record's nullifier ${at}: ${rows.length}`);
      if (s) {
        say(BigInt(s.withdrawn) === note && s.recipient === D && s.payer === D && s.fee === run.amounts.fee, `the withdrawal: ${note} to the device, fee ${run.amounts.fee}, paid by the device ${at}: ${s.withdrawn} to ${s.recipient}, fee ${s.fee}, payer ${s.payer}`);
        say(s.status === "settled" && s.reserve === "0", `settled, reserve 0 ${at}: ${s.status}, ${s.reserve}`);
        say(BigInt(s.refund_value) === note, `the refund note holds exactly the returned ${note} ${at}: ${s.refund_value}`);
        say(s.refund_precommitment === run.settle?.refund_precommitment && s.refund_label === run.settle?.refund_label && String(s.refund_leaf_index) === run.settle?.refund_leaf_index, `refund precommitment, label and leaf index are the record's ${at}`);
        const commitment = String(poseidon3([BigInt(s.refund_value), BigInt(s.refund_label), BigInt(s.refund_precommitment)]));
        const [leaf] = await view(fetchFn, url, VAULT, "leaves", { from: s.refund_leaf_index, limit: 1 }, sleep);
        say(leaf === commitment, `the leaf at refund_leaf_index ${s.refund_leaf_index} is Poseidon(refund_value, refund_label, refund_precommitment) ${at}: ${leaf}`);
        const w = run.note?.leaf;
        say(w?.value === s.refund_value && w?.label === s.refund_label && w?.leafIndex === String(s.refund_leaf_index) && w?.commitment === commitment && run.note?.precommitment === s.refund_precommitment && run.note?.state === "UNSPENT", `the note the kit wrote is the spend row's own leaf, UNSPENT ${at}`);
      }
      const reg = await view(fetchFn, url, TOKEN, "storage_balance_of", { account_id: B }, sleep);
      say(reg === null, `the fee recipient is not registered on the token ${at}: ${JSON.stringify(reg)}`);
      const st = tx("settle");
      const r = st ? await txStatus(fetchFn, url, st.hash, st.signer, sleep) : null;
      const a = r?.transaction?.actions ?? [];
      const fc = a[0]?.FunctionCall;
      const args = fc ? JSON.parse(Buffer.from(fc.args, "base64").toString("utf8")) : null;
      say(
        r?.transaction?.signer_id === D && r.transaction.receiver_id === VAULT && a.length === 1 && fc?.method_name === "settle" && JSON.stringify(args) === JSON.stringify({ nullifier_hash: nf }) && String(fc.gas) === SETTLE_GAS && fc.deposit === SETTLE_ATTACH,
        `the settle is the kit's call, signed by the device ${at}: ${r?.transaction?.signer_id} -> ${r?.transaction?.receiver_id} ${fc?.method_name} gas ${fc?.gas} deposit ${fc?.deposit}`,
      );
      say(okStatus(r?.status) && (r?.receipts_outcome ?? []).every((o) => okStatus(o.outcome?.status)), `the settle and every receipt succeeded ${at}`);
      const ag = tx("again");
      const r2 = ag ? await txStatus(fetchFn, url, ag.hash, ag.signer, sleep) : null;
      say(JSON.stringify(r2?.status?.Failure ?? null).includes("AlreadySettled"), `the second settle failed AlreadySettled ${at}`);
    } catch (e) {
      say(false, `reads ${at}: ${e.message}`);
    }
  }
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = JSON.parse(readFileSync(opt("--run", RUN), "utf8"));
    if (!run.bounce?.nullifier_hash || !run.settle?.refund_precommitment || !run.note?.leaf) throw new Error("run: want the bounce's nullifier hash, the settle and the note");
    const rec = recorder();
    const r = await check({ run, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    const unsigned = (k, v) => (k === "signature" && typeof v === "string" && v.startsWith("ed25519:") ? undefined : v);
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers, unsigned) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
