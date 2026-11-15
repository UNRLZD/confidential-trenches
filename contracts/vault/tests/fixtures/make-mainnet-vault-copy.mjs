#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Writes tests/fixtures/mainnet-vault-copy.json: the mainnet vault vault.confidential.unrlzd.near as it stood at one
// final block, so tests/mainnet_copy_payouts.rs runs its exact deployed bytes and its whole state in near-sandbox,
// offline (card near-cash-pays-any-amount). Reads only: no transaction is signed or sent, and no API key is used.
//
// One final block H (the first RPC's final, which the second must hold with the same hash). At block_id H, on both
// RPCs, each read must answer byte for byte the same (JSON.stringify of the whole result, block hash and height
// included):
// - the vault's view_account, view_code, view_access_key_list and view_state (every record, prefix "");
// - the vault's own views: totals, state_tree, label_tree, and every page of leaves, labels, deposits and spends;
// - mainnet USDC's ft_balance_of(vault) and storage_balance_of(vault).
// Refused unless the code is the deployed release (deployments/mainnet-v1.json wasm_sha256, wasm_bytes, code_hash),
// base58(sha256) is both views' code hash, and the access key list is empty.
//
// Run from the repo root: node contracts/vault/tests/fixtures/make-mainnet-vault-copy.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const release = JSON.parse(readFileSync(join(here, "../../deployments/mainnet-v1.json"), "utf8"));
const RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const VAULT = release.account_id;
const USDC = release.asset;
const PAGE = 1000; // the vault's PAGE_MAX
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(url, method, params) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "copy", method, params }),
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: String(e) }) }));
    const body = await res.json().catch(() => null);
    // an RPC error, or a reply with no result object, is never an answer
    if (res.ok && body && !body.error && body.result && typeof body.result === "object" && !body.result.error) return body.result;
    if (attempt >= 5 || (res.status !== 429 && res.status < 500 && res.status !== 0)) {
      throw new Error(`${url} ${method} ${JSON.stringify(params).slice(0, 160)}: no result: ${JSON.stringify(body).slice(0, 300)}`);
    }
    await sleep(1000 * attempt);
  }
}

/** The same read at block H on both RPCs: the one answer, refused unless byte for byte equal. */
async function both(what, method, params) {
  const [a, b] = [await rpc(RPCS[0], method, params), await rpc(RPCS[1], method, params)];
  const [sa, sb] = [JSON.stringify(a), JSON.stringify(b)];
  if (sa !== sb) throw new Error(`REFUSED ${what}: the two RPCs differ (${sa.length} vs ${sb.length} B): ${sa.slice(0, 200)} | ${sb.slice(0, 200)}`);
  console.error(`${what}: both RPCs agree (${sa.length} B)`);
  return a;
}

const args64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
async function view(H, account, method, a) {
  const r = await both(`${account}.${method}(${JSON.stringify(a)})`, "query", { request_type: "call_function", block_id: H, account_id: account, method_name: method, args_base64: args64(a) });
  if (r.block_height !== H) throw new Error(`${method}: answered at ${r.block_height}, not ${H}`);
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}
async function pages(H, method) {
  const out = [];
  for (;;) {
    const p = await view(H, VAULT, method, { from: out.length, limit: PAGE });
    if (!Array.isArray(p)) throw new Error(`${method}: not a list`);
    out.push(...p);
    if (p.length < PAGE) return out;
  }
}

// the final block, held by both RPCs with one hash
const fin = await rpc(RPCS[0], "block", { finality: "final" });
const H = fin.header.height;
let hashB;
for (let i = 0; i < 20 && !hashB; i++) {
  hashB = await rpc(RPCS[1], "block", { block_id: H }).then((b) => b.header.hash).catch(() => null);
  if (!hashB) await sleep(1000);
}
if (hashB !== fin.header.hash) throw new Error(`REFUSED: block ${H} is ${fin.header.hash} on ${RPCS[0]} and ${hashB} on ${RPCS[1]}`);
console.error(`block ${H} ${fin.header.hash} on both RPCs`);

const acct = await both("view_account", "query", { request_type: "view_account", block_id: H, account_id: VAULT });
const code = await both("view_code", "query", { request_type: "view_code", block_id: H, account_id: VAULT });
const keys = await both("view_access_key_list", "query", { request_type: "view_access_key_list", block_id: H, account_id: VAULT });
const state = await both("view_state", "query", { request_type: "view_state", block_id: H, account_id: VAULT, prefix_base64: "" });
for (const r of [acct, code, keys, state]) if (r.block_height !== H || r.block_hash !== fin.header.hash) throw new Error(`a read answered at ${r.block_height} ${r.block_hash}, not H`);

const wasm = Buffer.from(code.code_base64, "base64");
const sha = sha256(wasm);
const hash = base58(Buffer.from(sha, "hex"));
const bad = [];
if (wasm.length !== release.wasm_bytes) bad.push(`${wasm.length} B, the release is ${release.wasm_bytes}`);
if (sha !== release.wasm_sha256) bad.push(`sha256 ${sha}, the release is ${release.wasm_sha256}`);
if (hash !== release.code_hash || code.hash !== hash || acct.code_hash !== hash) bad.push(`code hash ${hash} / view_code ${code.hash} / view_account ${acct.code_hash}, the release is ${release.code_hash}`);
if (keys.keys.length !== 0) bad.push(`access keys ${JSON.stringify(keys.keys)}`);
if (bad.length) throw new Error(`REFUSED ${VAULT}: ${bad.join("; ")}`);

const views = {
  totals: await view(H, VAULT, "totals", {}),
  state_tree: await view(H, VAULT, "state_tree", {}),
  label_tree: await view(H, VAULT, "label_tree", {}),
  leaves: await pages(H, "leaves"),
  labels: await pages(H, "labels"),
  deposits: await pages(H, "deposits"),
  spends: await pages(H, "spends"),
};
const usdc = {
  account: USDC,
  ft_balance_of_vault: await view(H, USDC, "ft_balance_of", { account_id: VAULT }),
  storage_balance_of_vault: await view(H, USDC, "storage_balance_of", { account_id: VAULT }),
};

const out = {
  about: [
    `The mainnet vault ${VAULT} at block ${H}: its deployed code and its whole state, for tests/mainnet_copy_payouts.rs (card near-cash-pays-any-amount), which patches both into near-sandbox at the same account id. Public chain data, read only; no transaction signed or sent.`,
    `Made by contracts/vault/tests/fixtures/make-mainnet-vault-copy.mjs: every read at block_id ${H} on both RPCs, refused unless the two answers are byte for byte equal; the code refused unless it is deployments/mainnet-v1.json's release (sha256, size, code hash) and the access key list is empty.`,
    "state: every record of view_state (prefix \"\"), each a pair [name, value], both base64 as RPC gives them (a pair, not named fields, so a secret scan reads no key-like field name beside them). views: the vault's own views at H. usdc: mainnet USDC's views of the vault at H.",
  ],
  rpcs: RPCS,
  block: { height: H, hash: fin.header.hash, timestamp_nanosec: fin.header.timestamp_nanosec },
  read_at: new Date().toISOString(),
  account_id: VAULT,
  account: { amount: acct.amount, locked: acct.locked, storage_usage: acct.storage_usage, code_hash: acct.code_hash },
  access_keys: keys.keys,
  code: { bytes: wasm.length, sha256: sha, code_hash: hash, source_commit: release.source_commit, base64: code.code_base64 },
  state: state.values.map((v) => [v.key, v.value]),
  views,
  usdc,
};
writeFileSync(join(here, "mainnet-vault-copy.json"), JSON.stringify(out, null, 1) + "\n");
console.error(`wrote mainnet-vault-copy.json: block ${H}, ${out.state.length} state records, code ${wasm.length} B sha256 ${sha}, USDC held ${usdc.ft_balance_of_vault}, totals ${JSON.stringify(views.totals)}`);
