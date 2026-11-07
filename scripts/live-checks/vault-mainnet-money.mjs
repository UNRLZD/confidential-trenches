#!/usr/bin/env node
// Live check of card vault-mainnet-money: on the real mainnet vault (contracts/vault/deployments/mainnet-v1.json, the
// kit's mainnet row), one deposit of at least 1 USDC by U's signed call and one withdrawal of the whole note less the
// relayer's fee to the NEAR account the owner named, both carried by the deployed helper, landed and stay as the run
// record says (scripts/live-checks/vault-mainnet-money.run.json, written by
// contracts/vault/scripts/mainnet-money.ts record). It needs no tx read (the money gate reads every Tx line of
// vault-mainnet-money.md). On two mainnet operators (operatorProblems), at the final block, it holds the run's rows,
// which never change once settled, to their exact values:
//   - the vault's key list is [] and its code hash is the record's (no key added, no other code since the deploy);
//   - the deposits pages hold the run's precommitment once: depositor U, the note's value (at least the vault's
//     MIN_DEPOSIT), the label and the leaf index; the leaf at that index is the run's note commitment;
//   - the spends pages hold the note's nullifier hash once: recipient the named account, withdrawn + fee = the note (no
//     change), payer the release's withdrawal relayer, paid or settled with nothing refunded; the leaf at
//     new_leaf_index is the run's change commitment (a zero note), once;
//   - the vault holds at least what its totals owe (deposited - spent + returned, I1: equal once nothing is in flight).
// The named account's and the fee recipient's balances are the record's (the .md, read in the run), not held here: both
// accounts have keys, so their owners may move what they hold; the spend row is the chain's lasting word on the payout.
//   node scripts/live-checks/vault-mainnet-money.mjs [--run <file>] [--record <file>]   PASS exit 0, FAIL 1, error 2
// --record writes every RPC answer the check read to <file>, so its test can replay it.
// Runs: once, a recorded mainnet vault run read back on chain; no host deploy changes it
import "../net-window.mjs";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { operatorProblems, recorder } from "./vault-skeleton.mjs";
import { RateLimited, isRateLimit } from "./vault-testnet-t02.mjs";
import { VAULT_SYNC_PAGE } from "../../packages/kit/src/index.ts";

const KEY = "vault-mainnet-money";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUN = path.join(HERE, `${KEY}.run.json`);
export const RECORD = path.join(HERE, "../../contracts/vault/deployments/mainnet-v1.json");
const record = JSON.parse(readFileSync(RECORD, "utf8"));
export const VAULT = record.account_id;
export const TOKEN = record.asset;
export const CODE_HASH = record.code_hash;
/** Mainnet's release pair: one FastNEAR URL and dRPC, two operators (the kit's NEAR_NETWORKS.mainnet; the driver's pair). */
export const RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
/** The vault's smallest deposit (contracts/vault/src/constants.rs MIN_DEPOSIT): the run deposits what lands at U, at least this. */
export const MIN_DEPOSIT = 1_000_000n;
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function rpc(fetchFn, url, params, sleep) {
  let r, json;
  for (let i = 0; ; i++) {
    r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: KEY, method: "query", params }) });
    json = r.status === 429 ? null : await r.json().catch(() => null);
    if (!isRateLimit(r.status, json)) break;
    if (i === 3) throw new RateLimited(`${url}: rate limited 4 times in a row`);
    await sleep(2000 * 2 ** i);
  }
  if (json === null) throw new Error(`HTTP ${r.status}, not JSON`);
  if (json.error) throw new Error(`${json.error.name ?? "error"}: ${json.error.cause?.name ?? json.error.message ?? ""}`);
  if (json.result?.error) throw new Error(String(json.result.error).split("\n")[0].slice(0, 200));
  if (!json.result) throw new Error(`HTTP ${r.status}, no result`);
  return json.result;
}
const view = async (fetchFn, url, account_id, method_name, args, sleep) =>
  JSON.parse(Buffer.from((await rpc(fetchFn, url, { request_type: "call_function", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), finality: "final" }, sleep)).result).toString("utf8"));

async function all(fetchFn, url, method, sleep) {
  const rows = [];
  for (;;) {
    const limit = VAULT_SYNC_PAGE[method];
    const page = await view(fetchFn, url, VAULT, method, { from: rows.length, limit }, sleep);
    rows.push(...page);
    if (page.length < limit) return rows;
  }
}
const count = (list, x) => list.filter((y) => y === x).length;

export async function check({ run, fetchFn = fetch, rpcs = RPCS, sleep = pause }) {
  const lines = [];
  let ok = true;
  const say = (good, text) => {
    ok &&= good;
    lines.push(`${good ? "ok " : "BAD"} ${text}`);
  };
  for (const p of operatorProblems(rpcs, "mainnet")) say(false, p);
  rpcs = rpcs.slice(0, 2);
  const { U, to, R } = run.accounts ?? {};
  const d = run.deposit ?? {};
  const w = run.withdraw ?? {};
  const value = BigInt(d.value ?? -1);
  const withdrawn = BigInt(w.withdrawn ?? -1);
  const fee = BigInt(w.relay_fee ?? -1);
  say(run.network === "mainnet" && run.vault === VAULT && run.asset === TOKEN, `the run record names the mainnet vault ${VAULT} on ${TOKEN}: ${run.vault} on ${run.asset}`);
  say(/^[0-9a-f]{64}$/.test(U ?? "") && ACCOUNT_ID.test(to ?? "") && ![VAULT, TOKEN, "intents.near"].includes(to) && value >= MIN_DEPOSIT && fee >= 0n && withdrawn > 0n && withdrawn + fee === value, `the record: U NEAR-implicit, the named account ${to} not the vault, the token or intents.near, the note ${value} at least ${MIN_DEPOSIT} = withdrawn ${withdrawn} + fee ${fee}`);
  for (const url of rpcs) {
    const at = `on ${url}`;
    try {
      const keys = await rpc(fetchFn, url, { request_type: "view_access_key_list", account_id: VAULT, finality: "final" }, sleep);
      say(Array.isArray(keys.keys) && keys.keys.length === 0, `${VAULT} key list is [] ${at}: ${keys.keys?.length ?? "?"} key(s)`);
      const acct = await rpc(fetchFn, url, { request_type: "view_account", account_id: VAULT, finality: "final" }, sleep);
      say(acct.code_hash === CODE_HASH, `${VAULT} code hash is the record's ${CODE_HASH} ${at}: ${acct.code_hash}`);
      const deposits = await all(fetchFn, url, "deposits", sleep);
      const spends = await all(fetchFn, url, "spends", sleep);
      const leaves = await all(fetchFn, url, "leaves", sleep);
      const dep = deposits.filter((x) => x.precommitment === d.precommitment);
      say(dep.length === 1, `one deposit row for the run's precommitment ${at}: ${dep.map((x) => `#${x.index}`).join(", ") || "none"} of ${deposits.length}`);
      if (dep.length === 1) {
        const x = dep[0];
        say(x.depositor === U && BigInt(x.value) === value && x.label === d.label && String(x.leaf_index) === d.leaf_index, `deposit row: ${value} by U, the run's label and leaf ${d.leaf_index} ${at}: ${x.value} by ${x.depositor}, leaf ${x.leaf_index}`);
        say(leaves[x.leaf_index] === d.commitment, `the leaf at ${x.leaf_index} is the run's note ${at}`);
      }
      const sp = spends.filter((x) => x.nullifier_hash === w.nullifier_hash);
      say(sp.length === 1, `one spend row for the note's nullifier ${at}: ${sp.map((x) => `#${x.index}`).join(", ") || "none"} of ${spends.length}`);
      if (sp.length === 1) {
        const x = sp[0];
        say(x.recipient === to && BigInt(x.withdrawn) === withdrawn && BigInt(x.fee) === fee && x.payer === R, `spend row: ${withdrawn} to ${to}, fee ${fee}, paid by the relayer ${R} ${at}: ${x.withdrawn} to ${x.recipient}, fee ${x.fee}, payer ${x.payer}`);
        say((x.status === "paid" || x.status === "settled") && String(x.refund_value) === "0", `spend row: paid or settled, nothing refunded ${at}: ${x.status}, refund ${x.refund_value}`);
        say(leaves[x.new_leaf_index] === w.change_commitment && count(leaves, w.change_commitment) === 1, `the change leaf at ${x.new_leaf_index} is the run's change note, once ${at}`);
      }
      const vu = await view(fetchFn, url, TOKEN, "ft_balance_of", { account_id: VAULT }, sleep);
      const totals = await view(fetchFn, url, VAULT, "totals", {}, sleep);
      const owed = BigInt(totals.deposited) - BigInt(totals.spent) + BigInt(totals.returned);
      say(BigInt(vu) >= owed, `the vault holds at least what its totals owe ${at}: ${vu} >= ${owed}`);
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      say(false, `reads ${at}: ${e.message}`);
    }
  }
  return { ok, lines };
}

/** The command: 0 PASS, 1 FAIL, 2 error (a rate limit four times in a row, or no run record, included). */
export async function main(a, { fetchFn = fetch, sleep = pause, log = console.log, err = console.error } = {}) {
  const opt = (k, dflt) => (a.includes(k) ? a[a.indexOf(k) + 1] : dflt);
  try {
    const run = JSON.parse(readFileSync(opt("--run", RUN), "utf8"));
    if (!run.deposit?.precommitment || !run.withdraw?.nullifier_hash || !run.withdraw?.change_commitment) throw new Error("run: want the deposit's precommitment, the withdrawal's nullifier hash and change commitment");
    const rec = recorder(fetchFn);
    const r = await check({ run, fetchFn: opt("--record") ? rec.fetchFn : fetchFn, sleep });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    for (const l of r.lines) log(`live-check ${KEY}: ${l}`);
    log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    return r.ok ? 0 : 1;
  } catch (e) {
    err(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
