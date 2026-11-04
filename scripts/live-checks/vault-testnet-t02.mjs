#!/usr/bin/env node
// Live check of card vault-testnet-t02 (vault.md 5, VT-T02): on the testnet vault, a deposit by U's signed call
// carried by the relayer, and a withdrawal proved in a browser and carried by the relayer, both landed and stay as the
// run record says (contracts/vault/deployments/testnet-t02-run.json, written from contracts/vault/scripts/testnet-t02.ts).
// It needs no tx read. On two testnet operators (operatorProblems), at the final block, it holds the run's rows, which
// never change once settled, to their exact values, and balances only to lower bounds, which a later transfer in
// cannot break:
//   - the vault's key list is [] (no key was added by the run or since);
//   - the deposits pages hold the record's precommitment once: depositor U, the value, the label and the leaf index;
//     the leaf at that index is the record's note commitment;
//   - the spends pages hold the note's nullifier hash once: recipient W, withdrawn, fee = the relay fee, payer the
//     relayer, settled; the leaf at new_leaf_index is the record's change commitment, once in the leaves;
//   - W and F have no key, so nobody can move out what they hold, though anyone may send them more: W holds at least
//     withdrawn - fee and F at least the fee (the exact amounts are the spend row's, above);
//   - the vault holds at least what its totals owe (deposited - spent + returned, I1: equal once nothing is in flight).
//   node scripts/live-checks/vault-testnet-t02.mjs [--run <file>] [--record <file>]   PASS exit 0, FAIL 1, error 2
// --record writes every RPC answer the run read to <file>, so the check's test can replay it.
// Runs: once, a recorded testnet vault run read back on chain; no host deploy changes it
import "../net-window.mjs";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RPCS, operatorProblems, recorder } from "./vault-skeleton.mjs";

const KEY = "vault-testnet-t02";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUN = path.join(HERE, "../../contracts/vault/deployments/testnet-t02-run.json");
export const VAULT = "vault.bf-vt-20261102t071444.testnet"; // contracts/vault/deployments/testnet-v1.json
export const TOKEN = "bf-usdc-20261101t022248.testnet"; // gitleaks:allow (a public account id)
const PAGE = 1000; // the vault's PAGE_MAX

const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** A provider's rate limit, four times in a row: the check cannot read, so it errs (exit 2), never FAILs. */
export class RateLimited extends Error {}

/**
 * A rate limit, never an answer: HTTP 429; a JSON-RPC error code -429; or dRPC's free endpoint's answer, error code 15
 * with "You reached Public endpoint rate limit, please upgrade to paid plan" (its exact shape, captured from a real
 * dRPC answer, HTTP 429: {"id":187,"jsonrpc":"2.0","error":{"message":"You reached Public endpoint rate limit, please
 * upgrade to paid plan","code":15}}), with whatever HTTP status it comes.
 */
export const isRateLimit = (status, json) =>
  status === 429 || json?.error?.code === -429 || (json?.error?.code === 15 && /rate limit/i.test(String(json?.error?.message ?? "")));

// each request is asked once; a rate limit is waited out (2 s, 4 s, 8 s) and the same request asked again
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
    const page = await view(fetchFn, url, VAULT, method, { from: rows.length, limit: PAGE }, sleep);
    rows.push(...page);
    if (page.length < PAGE) return rows;
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
  for (const p of operatorProblems(rpcs)) say(false, p);
  rpcs = rpcs.slice(0, 2);
  const { U, W, F, R } = run.accounts ?? {};
  const d = run.deposit ?? {};
  const w = run.withdraw ?? {};
  const value = BigInt(d.value ?? -1);
  const withdrawn = BigInt(w.withdrawn ?? -1);
  const fee = BigInt(w.relay_fee ?? -1);
  say(run.vault === VAULT && run.asset === TOKEN, `the run record names the testnet vault ${VAULT} on ${TOKEN}: ${run.vault} on ${run.asset}`);
  say(/^[0-9a-f]{64}$/.test(U ?? "") && withdrawn > fee && fee > 0n && value > withdrawn, `the record: U NEAR-implicit, the note ${value} above withdrawn ${withdrawn} above the fee ${fee}`);
  for (const url of rpcs) {
    const at = `on ${url}`;
    try {
      // one request at a time on each provider, each page read once: a free endpoint's limit is hit less often
      const keys = await rpc(fetchFn, url, { request_type: "view_access_key_list", account_id: VAULT, finality: "final" }, sleep);
      say(Array.isArray(keys.keys) && keys.keys.length === 0, `${VAULT} key list is [] ${at}: ${keys.keys?.length ?? "?"} key(s)`);
      const deposits = await all(fetchFn, url, "deposits", sleep);
      const spends = await all(fetchFn, url, "spends", sleep);
      const leaves = await all(fetchFn, url, "leaves", sleep);
      const dep = deposits.filter((x) => x.precommitment === d.precommitment);
      say(dep.length === 1, `one deposit row for the record's precommitment ${at}: ${dep.map((x) => `#${x.index}`).join(", ") || "none"}`);
      if (dep.length === 1) {
        const x = dep[0];
        say(x.depositor === U && BigInt(x.value) === value && x.label === d.label && String(x.leaf_index) === d.leaf_index, `deposit row: ${value} by U, the record's label and leaf ${d.leaf_index} ${at}: ${x.value} by ${x.depositor}, leaf ${x.leaf_index}`);
        say(leaves[x.leaf_index] === d.commitment, `the leaf at ${x.leaf_index} is the record's note ${at}`);
      }
      const sp = spends.filter((x) => x.nullifier_hash === w.nullifier_hash);
      say(sp.length === 1, `one spend row for the note's nullifier ${at}: ${sp.map((x) => `#${x.index}`).join(", ") || "none"}`);
      if (sp.length === 1) {
        const x = sp[0];
        say(x.recipient === W && BigInt(x.withdrawn) === withdrawn && BigInt(x.fee) === fee && x.payer === R, `spend row: ${withdrawn} to W, fee ${fee}, paid by the relayer ${at}: ${x.withdrawn} to ${x.recipient}, fee ${x.fee}, payer ${x.payer}`);
        say(x.status === "settled", `spend row: settled ${at}: ${x.status}`);
        say(leaves[x.new_leaf_index] === w.change_commitment && count(leaves, w.change_commitment) === 1, `the change leaf at ${x.new_leaf_index} is the record's change note, once ${at}`);
      }
      const wu = await view(fetchFn, url, TOKEN, "ft_balance_of", { account_id: W }, sleep);
      const fu = await view(fetchFn, url, TOKEN, "ft_balance_of", { account_id: F }, sleep);
      const vu = await view(fetchFn, url, TOKEN, "ft_balance_of", { account_id: VAULT }, sleep);
      const totals = await view(fetchFn, url, VAULT, "totals", {}, sleep);
      say(BigInt(wu) >= withdrawn - fee, `W holds at least withdrawn - fee = ${withdrawn - fee} ${at}: ${wu}`);
      say(BigInt(fu) >= fee, `F holds at least the fee ${fee} ${at}: ${fu}`);
      const owed = BigInt(totals.deposited) - BigInt(totals.spent) + BigInt(totals.returned);
      say(BigInt(vu) >= owed, `the vault holds at least what its totals owe ${at}: ${vu} >= ${owed}`);
    } catch (e) {
      if (e instanceof RateLimited) throw e; // no read, no verdict: main exits 2
      say(false, `reads ${at}: ${e.message}`);
    }
  }
  return { ok, lines };
}

/** The command: 0 PASS, 1 FAIL, 2 error (a rate limit four times in a row included). */
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
