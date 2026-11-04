#!/usr/bin/env node
// Live check of card vault-skeleton: the vault skeleton on NEAR testnet, with no keys. On two testnet RPCs it reads:
//   - view_access_key_list of the vault: keys [] (vault.md 2.8, "Read back after every deploy");
//   - view_code: its sha256 equals contracts/vault/deployments/testnet-skeleton.json's wasm_sha256;
//   - the wasm's imports: none of vault.md 2.8's banned actions, and its promise imports a subset of the seven allowed;
//   - the wasm's function exports: nothing outside vault.md 2.5.7's list (no init, no setter, no __contract_abi), and
//     never withdraw without on_payout (a build that spends a note but cannot pay it out);
//   - the wasm's bytes: not VT-S17's out-of-gas test build (TEST_BUILD_MARK: every payout callback of that build fails);
//   - config(): it answers, naming Circle's testnet USDC as its asset and a testnet version. Both are pinned here, never
//     taken from the deployment record (which the deploy script writes from config() itself);
//   - storage_balance_of(vault) on that USDC: the vault is registered on its token, so a deposit's ft_transfer_call and a
//     payout's ft_transfer can land (NEP-145; an unregistered receiver makes the token refuse the transfer).
//   node scripts/live-checks/vault-skeleton.mjs [--account <id>] [--deployment <file>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --account checks another account against the same deployment record (the recorded bad answers). --record writes every
// RPC answer the run read to <file>, so the check's test can replay it.
// Runs: once, a contract deploy's read-back (the testnet vault skeleton, keys []); the vault has no deploy path after it
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { networkOf, operatorOf } from "../ci/near-rpc-operators.mjs";

const KEY = "vault-skeleton";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENT = path.join(HERE, "../../contracts/vault/deployments/testnet-skeleton.json");
// Circle's testnet USDC on NEAR (developers.circle.com/stablecoins/usdc-contract-addresses, read 2026-11-01 00:31Z; its
// ft_metadata on NEAR testnet answers symbol USDC at block 275,674,154). Mainnet's is 17208628…33a1.
export const TESTNET_USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
// config().version ends with the build's network (contracts/vault/src/constants.rs NETWORK)
export const TESTNET_VERSION = /^blindfill-vault \S+ testnet$/;
// two independent providers, as the vault-gas proof read its testnet vaults back
export const RPCS = ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"];

// vault.md 2.8: no import that lets the code act on its own account (nearcore near-vm-runner imports.rs l.198-283)
const BANNED = [
  "promise_batch_action_create_account",
  "promise_batch_action_deploy_contract",
  "promise_batch_action_deploy_global_contract*",
  "promise_batch_action_use_global_contract*",
  "promise_batch_action_state_init*",
  "promise_batch_action_stake",
  "promise_batch_action_add_key_with_full_access",
  "promise_batch_action_add_key_with_function_call",
  "promise_batch_action_delete_key",
  "promise_batch_action_delete_account",
  "promise_batch_action_add_gas_key_*",
  "promise_batch_action_transfer_to_gas_key",
];
// vault.md 2.8: its promise imports are at most these seven
export const PROMISE_ALLOWED = new Set([
  "promise_batch_create",
  "promise_batch_then",
  "promise_and",
  "promise_batch_action_function_call_weight",
  "promise_batch_action_transfer",
  "promise_results_count",
  "promise_result",
]);
// vault.md 2.5.7: the only function exports, the methods, the views of 2.5.6 and near-sdk's contract_source_metadata
export const EXPORTS_ALLOWED = new Set([
  "storage_prepay",
  "ft_on_transfer",
  "withdraw",
  "ragequit",
  "on_payout",
  "settle",
  "config",
  "state_tree",
  "label_tree",
  "leaves",
  "labels",
  "deposits",
  "spends",
  "is_known_state_root",
  "is_known_label_root",
  "totals",
  "contract_source_metadata",
]);

// What keeps `rpcs` from being two independent reads of NEAR testnet: [] when its first two are testnet hosts of two
// different operators (scripts/ci/near-rpc-operators.mjs). Two hosts of one operator are one read
// (FastNEAR runs near.org's testnet hosts too), and a host the map does not hold is no read.
export function operatorProblems(rpcs) {
  const two = rpcs.slice(0, 2);
  const named = two.map((u) => `${u} (${networkOf(u) === "testnet" ? (operatorOf(u) ?? "unknown") : "not a testnet host"})`);
  const ops = new Set(two.filter((u) => networkOf(u) === "testnet").map(operatorOf).filter(Boolean));
  if (two.length < 2) return [`only ${two.length} RPC(s): ${named.join(", ") || "none"}; want two of two operators`];
  if (ops.size < 2) return [`only ${ops.size} operator(s) in ${named.join(", ")}; want two testnet operators`];
  return [];
}

const banned = (name) => BANNED.some((b) => (b.endsWith("*") ? name.startsWith(b.slice(0, -1)) : name === b));

// The import and export lists of a wasm module (the binary format's sections 2 and 7).
export function wasmLists(buf) {
  const b = Buffer.from(buf);
  if (b.length < 8 || b.readUInt32BE(0) !== 0x0061736d || b.readUInt32LE(4) !== 1) throw new Error("not a wasm module");
  let p = 8;
  const leb = () => {
    let r = 0n, s = 0n, x;
    do {
      if (p >= b.length) throw new Error("wasm: truncated");
      x = b[p++];
      r |= BigInt(x & 0x7f) << s;
      s += 7n;
    } while (x & 0x80);
    return Number(r);
  };
  const name = () => {
    const n = leb();
    if (p + n > b.length) throw new Error("wasm: truncated");
    return b.toString("utf8", p, (p += n));
  };
  const limits = () => {
    const f = b[p++];
    leb();
    if (f & 1) leb();
  };
  const imports = [];
  const exports = [];
  while (p < b.length) {
    const id = b[p++];
    const size = leb();
    const end = p + size;
    if (end > b.length) throw new Error("wasm: section past the end");
    if (id === 2) {
      for (let n = leb(); n > 0; n--) {
        const module = name();
        const field = name();
        const kind = b[p++];
        if (kind === 0) leb();
        else if (kind === 1) (p++, limits());
        else if (kind === 2) limits();
        else if (kind === 3) p += 2;
        else if (kind === 4) (p++, leb());
        else throw new Error(`wasm: import kind ${kind}`);
        imports.push({ module, name: field, kind });
      }
    } else if (id === 7) {
      for (let n = leb(); n > 0; n--) {
        const field = name();
        const kind = b[p++];
        leb();
        exports.push({ name: field, kind });
      }
    }
    p = end;
  }
  return { imports, exports };
}

// What makes a wasm not a testnet build, read from its bytes: the testnet build holds Circle's testnet USDC id and not
// mainnet's (constants.rs TOKEN; NETWORK switches on the same feature). No bare word is read, so a later string that
// says "mainnet" cannot refuse a correct build.
export function networkProblems(buf) {
  const b = Buffer.from(buf);
  const problems = [];
  if (!b.includes(TESTNET_USDC)) problems.push(`does not hold Circle's testnet USDC ${TESTNET_USDC}`);
  if (b.includes(MAINNET_USDC)) problems.push(`holds mainnet USDC ${MAINNET_USDC}`);
  return problems;
}

// VT-S17's test build (contracts/vault feature `test-on-payout-out-of-gas`): its on_payout logs this mark (src/payout.rs
// OUT_OF_GAS_BUILD_MARK), then runs out of gas, so the mark is in its bytes and in no other build's.
export const TEST_BUILD_MARK = "blindfill-vault test build: on_payout runs out of gas";

// What a wasm breaks of vault.md 2.8 and 2.5.7: { banned, promises, exports, withdrawWithoutPayout, testBuild } (each
// the names out of line). withdrawWithoutPayout names `withdraw` when the wasm exports it without `on_payout`: a build
// that spends a note but cannot pay it out (2.5.2 rows 13-15, 2.5.4), which must never be deployed. testBuild names
// TEST_BUILD_MARK when the bytes hold it: VT-S17's build, whose every payout callback fails, must never be deployed.
export function wasmProblems(buf) {
  const { imports, exports } = wasmLists(buf);
  const names = imports.filter((i) => i.kind === 0).map((i) => i.name);
  const fns = exports.filter((e) => e.kind === 0).map((e) => e.name);
  return {
    banned: names.filter(banned),
    promises: names.filter((n) => n.startsWith("promise_") && !PROMISE_ALLOWED.has(n)),
    exports: exports.filter((e) => e.kind === 0 && !EXPORTS_ALLOWED.has(e.name)).map((e) => e.name),
    withdrawWithoutPayout: fns.includes("withdraw") && !fns.includes("on_payout") ? ["withdraw"] : [],
    testBuild: Buffer.from(buf).includes(TEST_BUILD_MARK) ? [TEST_BUILD_MARK] : [],
    functionExports: exports.filter((e) => e.kind === 0).map((e) => e.name),
    promiseImports: names.filter((n) => n.startsWith("promise_")),
  };
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

export async function check({ deployment, account = deployment.account_id, fetchFn = fetch, rpcs = RPCS }) {
  const lines = [];
  let ok = true;
  const say = (good, text) => {
    ok &&= good;
    lines.push(`${good ? "ok " : "BAD"} ${text}`);
  };
  for (const p of operatorProblems(rpcs)) say(false, p);
  rpcs = rpcs.slice(0, 2);
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
      const c = await query(fetchFn, url, { request_type: "view_code", account_id: account, finality: "final" });
      const code = Buffer.from(c.code_base64, "base64");
      const sha = createHash("sha256").update(code).digest("hex");
      say(sha === deployment.wasm_sha256, `code sha256 ${sha} equals the deployment's ${deployment.wasm_sha256} ${at} (${code.length} B)`);
      const w = wasmProblems(code);
      say(w.banned.length === 0, `no banned import ${at}: ${w.banned.length ? w.banned.join(", ") : "none"}`);
      say(w.promises.length === 0, `promise imports are a subset of the seven ${at}: [${w.promiseImports.join(", ")}]${w.promises.length ? `, not allowed: ${w.promises.join(", ")}` : ""}`);
      say(w.exports.length === 0, `function exports are inside vault.md 2.5.7's list ${at}: [${w.functionExports.join(", ")}]${w.exports.length ? `, not allowed: ${w.exports.join(", ")}` : ""}`);
      say(w.withdrawWithoutPayout.length === 0, `withdraw is exported only with on_payout ${at}: ${w.withdrawWithoutPayout.length ? "withdraw without on_payout" : "yes"}`);
      say(w.testBuild.length === 0, `not the out-of-gas test build ${at}: ${w.testBuild.length ? `holds "${w.testBuild[0]}"` : "no test mark"}`);
    } catch (e) {
      say(false, `code ${at}: ${e.message}`);
    }
    try {
      const r = await query(fetchFn, url, { request_type: "call_function", account_id: account, method_name: "config", args_base64: "e30=", finality: "final" });
      const cfg = JSON.parse(Buffer.from(r.result).toString("utf8"));
      const good = cfg.asset === TESTNET_USDC && deployment.asset === TESTNET_USDC && /^\d+$/.test(cfg.scope) && TESTNET_VERSION.test(cfg.version);
      say(good, `config() answers ${at}: asset ${cfg.asset}, scope ${cfg.scope}, version ${cfg.version}`);
    } catch (e) {
      say(false, `config() ${at}: ${e.message}`);
    }
    try {
      const args = Buffer.from(JSON.stringify({ account_id: account })).toString("base64");
      const r = await query(fetchFn, url, { request_type: "call_function", account_id: TESTNET_USDC, method_name: "storage_balance_of", args_base64: args, finality: "final" });
      const bal = JSON.parse(Buffer.from(r.result).toString("utf8"));
      const good = bal !== null && /^\d+$/.test(bal.total ?? "") && BigInt(bal.total) > 0n;
      say(good, `${account} is registered on Circle's testnet USDC ${at}: ${bal === null ? "null" : `total ${bal.total}`} at block ${r.block_height}`);
    } catch (e) {
      say(false, `storage_balance_of(${account}) on Circle's testnet USDC ${at}: ${e.message}`);
    }
  }
  return { ok, lines };
}

// a fetch that keeps every answer it reads: { url, method, params, status, json }
export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const r = await fetchFn(url, init);
    const json = await r.json();
    answers.push({ url, method, params, status: r.status, json });
    return { ok: r.ok, status: r.status, json: async () => json };
  };
  return { answers, fetchFn: wrapped };
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
