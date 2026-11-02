#!/usr/bin/env node
// Live check of card vault-testnet-t01: the deposit-and-withdraw vault on NEAR testnet, with no keys, registered on the
// team's testnet USDC (vault.md 5, VT-T01; V1.6). On two testnet RPCs, at the final block, it reads:
//   - view_access_key_list of the vault: keys [] (vault.md 2.8, "Read back after every deploy");
//   - view_account: its code hash equals contracts/vault/deployments/testnet-v1.json's code_hash, which is the base58
//     of the record's wasm_sha256, the reproducible build's;
//   - view_code: its sha256 equals the record's wasm_sha256; its imports and exports pass vault-skeleton.mjs's
//     wasmProblems (none of 2.8's banned imports, promise imports inside the seven, exports inside 2.5.7's list,
//     withdraw only with on_payout); its bytes name the testnet token and no other (networkProblems);
//   - config(): asset is the team's testnet USDC and version a testnet one. Both are pinned here, never taken from the
//     record (which the deploy script writes from config() itself);
//   - storage_balance_of(vault) on that token: set, so a deposit's ft_transfer_call and a payout's ft_transfer can land
//     (NEP-145; an unregistered receiver makes the token refuse the transfer).
//   node scripts/live-checks/vault-testnet-t01.mjs [--account <id>] [--deployment <file>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --account checks another account against the same record (the recorded bad answers). --record writes every RPC
// answer the run read to <file>, so the check's test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RPCS, TESTNET_VERSION, operatorProblems, recorder, wasmProblems } from "./vault-skeleton.mjs";

const KEY = "vault-testnet-t01";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENT = path.join(HERE, "../../contracts/vault/deployments/testnet-v1.json");
// The team's testnet USDC: mainnet USDC's own wasm with test accounts in its roles (card vault-testnet-usdc,
// contracts/vault/deployments/testnet-usdc.json), the token the wallet's testnet deposit names
// (packages/wallet/src/deposit/account.ts NEAR_NETWORKS.testnet.token). The testnet build's TOKEN
// (contracts/vault/src/constants.rs).
export const TESTNET_TOKEN = "bf-usdc-20261101t022248.testnet"; // gitleaks:allow (a public account id)
// The two token ids a testnet build must not hold: mainnet USDC and Circle's testnet USDC (the 1 Nov skeleton's asset).
export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const CIRCLE_TESTNET_USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
export { RPCS, TESTNET_VERSION };

// What makes a wasm not this testnet build, read from its bytes: it holds TESTNET_TOKEN and neither other token id.
// No bare word is read, so a later string that says "mainnet" cannot refuse a correct build.
export function networkProblems(buf) {
  const b = Buffer.from(buf);
  const problems = [];
  if (!b.includes(TESTNET_TOKEN)) problems.push(`does not hold the testnet token ${TESTNET_TOKEN}`);
  if (b.includes(MAINNET_USDC)) problems.push(`holds mainnet USDC ${MAINNET_USDC}`);
  if (b.includes(CIRCLE_TESTNET_USDC)) problems.push(`holds Circle's testnet USDC ${CIRCLE_TESTNET_USDC}`);
  return problems;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(buf) {
  let n = BigInt(`0x${Buffer.from(buf).toString("hex") || "0"}`);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of buf) {
    if (x) break;
    s = `1${s}`;
  }
  return s;
}

async function query(fetchFn, url, params) {
  const r = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: KEY, method: "query", params }),
  });
  const json = await r.json();
  if (json.error) throw new Error(`${json.error.name ?? "error"}: ${json.error.cause?.name ?? json.error.message ?? ""}`);
  if (json.result?.error) throw new Error(String(json.result.error).split("\n")[0].slice(0, 200));
  if (!json.result) throw new Error(`HTTP ${r.status}, no result`);
  return json.result;
}

const view = async (fetchFn, url, account_id, method_name, args) => {
  const r = await query(fetchFn, url, { request_type: "call_function", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), finality: "final" });
  return { value: JSON.parse(Buffer.from(r.result).toString("utf8")), block: r.block_height };
};

export async function check({ deployment, account = deployment.account_id, fetchFn = fetch, rpcs = RPCS }) {
  const lines = [];
  let ok = true;
  const say = (good, text) => {
    ok &&= good;
    lines.push(`${good ? "ok " : "BAD"} ${text}`);
  };
  for (const p of operatorProblems(rpcs)) say(false, p);
  rpcs = rpcs.slice(0, 2);
  const recordHash = /^[0-9a-f]{64}$/.test(deployment.wasm_sha256 ?? "") ? b58(Buffer.from(deployment.wasm_sha256, "hex")) : null;
  say(recordHash !== null && deployment.code_hash === recordHash, `the record's code_hash ${deployment.code_hash} is the base58 of its wasm_sha256 ${deployment.wasm_sha256}`);
  say(deployment.asset === TESTNET_TOKEN, `the record's asset ${deployment.asset} is the testnet token ${TESTNET_TOKEN}`);
  for (const url of rpcs) {
    const at = `on ${url}`;
    try {
      const k = await query(fetchFn, url, { request_type: "view_access_key_list", account_id: account, finality: "final" });
      const keys = Array.isArray(k.keys) ? k.keys : null;
      say(keys !== null && keys.length === 0, `${account} key list is [] ${at}: ${keys === null ? "no list" : `${keys.length} key(s)${keys.length ? ` (${keys.map((x) => { const p = x.access_key?.permission; return typeof p === "string" ? p : Object.keys(p ?? {})[0]; }).join(", ")})` : ""}`} at block ${k.block_height}`);
    } catch (e) {
      say(false, `${account} key list ${at}: ${e.message}`);
    }
    try {
      const a = await query(fetchFn, url, { request_type: "view_account", account_id: account, finality: "final" });
      say(a.code_hash === deployment.code_hash, `${account} code hash ${a.code_hash} equals the record's ${deployment.code_hash} ${at} at block ${a.block_height}`);
    } catch (e) {
      say(false, `${account} code hash ${at}: ${e.message}`);
    }
    try {
      const c = await query(fetchFn, url, { request_type: "view_code", account_id: account, finality: "final" });
      const code = Buffer.from(c.code_base64, "base64");
      const sha = createHash("sha256").update(code).digest("hex");
      say(sha === deployment.wasm_sha256, `code sha256 ${sha} equals the record's ${deployment.wasm_sha256} ${at} (${code.length} B)`);
      const w = wasmProblems(code);
      say(w.banned.length === 0, `no banned import ${at}: ${w.banned.length ? w.banned.join(", ") : "none"}`);
      say(w.promises.length === 0, `promise imports are a subset of the seven ${at}: [${w.promiseImports.join(", ")}]${w.promises.length ? `, not allowed: ${w.promises.join(", ")}` : ""}`);
      say(w.exports.length === 0, `function exports are inside vault.md 2.5.7's list ${at}: [${w.functionExports.join(", ")}]${w.exports.length ? `, not allowed: ${w.exports.join(", ")}` : ""}`);
      say(w.withdrawWithoutPayout.length === 0, `withdraw is exported only with on_payout ${at}: ${w.withdrawWithoutPayout.length ? "withdraw without on_payout" : "yes"}`);
      const n = networkProblems(code);
      say(n.length === 0, `the code names the testnet token and no other ${at}: ${n.length ? n.join("; ") : "yes"}`);
    } catch (e) {
      say(false, `code ${at}: ${e.message}`);
    }
    try {
      const { value: cfg } = await view(fetchFn, url, account, "config", {});
      const good = cfg.asset === TESTNET_TOKEN && /^\d+$/.test(cfg.scope) && TESTNET_VERSION.test(cfg.version);
      say(good, `config() answers ${at}: asset ${cfg.asset}, scope ${cfg.scope}, version ${cfg.version}`);
    } catch (e) {
      say(false, `config() ${at}: ${e.message}`);
    }
    try {
      const { value: bal, block } = await view(fetchFn, url, TESTNET_TOKEN, "storage_balance_of", { account_id: account });
      const good = bal !== null && /^\d+$/.test(bal.total ?? "") && BigInt(bal.total) > 0n;
      say(good, `${account} is registered on the testnet token ${at}: ${bal === null ? "null" : `total ${bal.total}`} at block ${block}`);
    } catch (e) {
      say(false, `storage_balance_of(${account}) on the testnet token ${at}: ${e.message}`);
    }
  }
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const deployment = JSON.parse(readFileSync(opt("--deployment", DEPLOYMENT), "utf8"));
    if (typeof deployment.account_id !== "string" || !/^[0-9a-f]{64}$/.test(deployment.wasm_sha256 ?? "")) throw new Error("deployment: want account_id and wasm_sha256");
    const rec = recorder();
    const r = await check({ deployment, account: opt("--account", deployment.account_id), fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
