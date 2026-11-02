#!/usr/bin/env node
// Live check of card vault-testnet-t04: on the testnet vault, a depositor took a note back by ragequit, and a bounced
// payout became a refund note by settle that the device then spent (vault.md 5, VT-T04 "as VT-S08, VT-S09"). It reads
// the vault's state, which never changes once settled, so it holds after every deploy and needs no tx read: on two
// testnet operators (operatorProblems), at the final block, every page of spends, deposits, leaves and labels, and the
// bounce account's registration on the token, then for the run record's three nullifier hashes
// (contracts/vault/deployments/testnet-t04-run.json, written by contracts/vault/scripts/testnet-t04.mjs):
//   - the ragequit row: recipient and payer the depositor, context 0 (restore reads a spend with context 0 as a
//     ragequit, VT-S19), fee 0, withdrawn the whole note, no change leaf (new_leaf_index 0), paid; the deposit of that
//     label names the same depositor with the same value;
//   - the bounce row: to the bounce account, fee to the depositor, settled with reserve 0, refund_value exactly
//     withdrawn - fee; the leaf at refund_leaf_index is the record's refund commitment (the run computed it as
//     Poseidon(refund_value, refund_label, refund_precommitment) from these rows) on the row's refund precommitment;
//     that commitment is in the state tree once and refund_label in the label tree
//     once, so settle wrote one note; the bounce account is still not registered on the token (why it bounced);
//   - the refund row: the whole refund note withdrawn to the depositor, fee 0, paid or settled.
//   node scripts/live-checks/vault-testnet-t04.mjs [--run <file>] [--record <file>]   PASS exit 0, FAIL 1, error 2
// --record writes every RPC answer the run read to <file>, so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RPCS, operatorProblems, recorder } from "./vault-skeleton.mjs";

const KEY = "vault-testnet-t04";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUN = path.join(HERE, "../../contracts/vault/deployments/testnet-t04-run.json");
export const VAULT = "vault.bf-vt-20261102t071444.testnet"; // contracts/vault/deployments/testnet-v1.json
export const TOKEN = "bf-usdc-20261101t022248.testnet"; // gitleaks:allow (a public account id)
const PAGE = 1000; // the vault's PAGE_MAX

async function view(fetchFn, url, account_id, method_name, args) {
  const r = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: KEY, method: "query", params: { request_type: "call_function", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), finality: "final" } }),
  });
  const json = await r.json();
  if (json.error) throw new Error(`${json.error.name ?? "error"}: ${json.error.cause?.name ?? json.error.message ?? ""}`);
  if (json.result?.error) throw new Error(String(json.result.error).split("\n")[0].slice(0, 200));
  if (!json.result) throw new Error(`HTTP ${r.status}, no result`);
  return JSON.parse(Buffer.from(json.result.result).toString("utf8"));
}

async function all(fetchFn, url, method) {
  const rows = [];
  for (;;) {
    const page = await view(fetchFn, url, VAULT, method, { from: rows.length, limit: PAGE });
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

const count = (list, x) => list.filter((y) => y === x).length;

export async function check({ run, fetchFn = fetch, rpcs = RPCS }) {
  const lines = [];
  let ok = true;
  const say = (good, text) => {
    ok &&= good;
    lines.push(`${good ? "ok " : "BAD"} ${text}`);
  };
  for (const p of operatorProblems(rpcs)) say(false, p);
  rpcs = rpcs.slice(0, 2);
  say(run.vault === VAULT && run.asset === TOKEN, `the run record names the testnet vault ${VAULT} on ${TOKEN}: ${run.vault} on ${run.asset}`);
  const D = run.accounts?.depositor;
  const B = run.accounts?.bounce;
  const amt = Object.fromEntries(Object.entries(run.amounts ?? {}).map(([k, v]) => [k, BigInt(v)]));
  say(/^[0-9a-f]{64}$/.test(D ?? "") && amt.refund === amt.note2 - amt.fee, `the record's depositor is NEAR-implicit and its refund is note 2 less the fee: ${amt.note2} - ${amt.fee} = ${amt.refund}`);
  for (const url of rpcs) {
    const at = `on ${url}`;
    try {
      const [spends, deposits, leaves, labels] = await Promise.all(["spends", "deposits", "leaves", "labels"].map((m) => all(fetchFn, url, m)));
      const row = (n) => spends.filter((s) => s.nullifier_hash === n);
      const [rq, ...rq2] = row(run.ragequit.nullifier_hash);
      say(rq && !rq2.length, `one spend row for the ragequit's nullifier ${at}: ${rq ? `#${rq.index}` : "none"}`);
      if (rq) {
        say(rq.recipient === D && rq.payer === D, `ragequit row: recipient and payer are the depositor ${at}: ${rq.recipient}, ${rq.payer}`);
        say(rq.context === "0", `ragequit row: context 0 ${at}: ${rq.context}`);
        say(rq.fee === "0" && rq.new_leaf_index === 0 && BigInt(rq.withdrawn) === amt.note1, `ragequit row: the whole note ${amt.note1}, fee 0, no change leaf ${at}: withdrawn ${rq.withdrawn}, fee ${rq.fee}, new_leaf_index ${rq.new_leaf_index}`);
        say(rq.status === "paid" || rq.status === "settled", `ragequit row: paid ${at}: ${rq.status}`);
      }
      const dep = deposits.filter((d) => d.label === run.ragequit.label);
      say(dep.length === 1 && dep[0].depositor === D && BigInt(dep[0].value) === amt.note1, `the ragequit note's deposit names the depositor with ${amt.note1} ${at}: ${dep.map((d) => `#${d.index} ${d.depositor} ${d.value}`).join(", ") || "none"}`);

      const [bo, ...bo2] = row(run.bounce.nullifier_hash);
      say(bo && !bo2.length, `one spend row for the bounce's nullifier ${at}: ${bo ? `#${bo.index}` : "none"}`);
      if (bo) {
        say(bo.recipient === B && bo.payer === D && BigInt(bo.fee) === amt.fee && BigInt(bo.withdrawn) === amt.note2, `bounce row: ${amt.note2} to the bounce account, fee ${amt.fee}, paid by the depositor ${at}: ${bo.withdrawn} to ${bo.recipient}, fee ${bo.fee}, payer ${bo.payer}`);
        say(BigInt(bo.refund_value) === amt.refund, `bounce row: the refund note holds exactly the returned ${amt.refund} ${at}: ${bo.refund_value}`);
        say(bo.status === "settled" && bo.reserve === "0", `bounce row: settled, reserve 0 ${at}: ${bo.status}, ${bo.reserve}`);
        // the run computed the commitment as Poseidon(refund_value, refund_label, refund_precommitment) from these rows
        // and checked it at this leaf; the kit's entry gives no Poseidon, so the check holds the leaf to the record's
        const want = run.settle.refund_commitment;
        const leaf = leaves[bo.refund_leaf_index];
        say(leaf === want && bo.refund_precommitment === run.settle.refund_precommitment, `the leaf at refund_leaf_index ${bo.refund_leaf_index} is the record's refund note, on the row's refund precommitment ${at}: ${leaf}`);
        say(count(leaves, want) === 1 && count(labels, bo.refund_label) === 1, `settle wrote one note: the commitment once in ${leaves.length} leaves, the label once in ${labels.length} labels ${at}: ${count(leaves, want)}, ${count(labels, bo.refund_label)}`);
        say(bo.refund_label === run.settle.refund_label && String(bo.refund_leaf_index) === run.settle.refund_leaf_index, `bounce row: refund label and leaf are the record's ${at}`);
      }
      const reg = await view(fetchFn, url, TOKEN, "storage_balance_of", { account_id: B });
      say(reg === null, `the bounce account is not registered on the token ${at}: ${JSON.stringify(reg)}`);

      const [rf, ...rf2] = row(run.refund.nullifier_hash);
      say(rf && !rf2.length, `one spend row for the refund note's nullifier ${at}: ${rf ? `#${rf.index}` : "none"}`);
      if (rf) {
        say(BigInt(rf.withdrawn) === amt.refund && rf.recipient === D && rf.fee === "0" && (rf.status === "paid" || rf.status === "settled"), `refund row: the whole refund note ${amt.refund} withdrawn to the depositor, fee 0 ${at}: ${rf.withdrawn} to ${rf.recipient}, fee ${rf.fee}, ${rf.status}`);
      }
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
    if (!run.ragequit?.nullifier_hash || !run.bounce?.nullifier_hash || !run.refund?.nullifier_hash || !run.settle?.refund_commitment) throw new Error("run: want the ragequit, bounce and refund nullifier hashes and the refund commitment");
    const rec = recorder();
    const r = await check({ run, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
