#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Live check of card vault-final-sha: the testnet vault of contracts/vault/deployments/testnet-v4.json runs the vault's
// final commit (SOURCE_COMMIT: every fix and every planned test in, VT-U01 to U06, P01, P02 and S01 to S20 green at it),
// the commit the mainnet vault is built at, with no key. The wasm's NEP-330 metadata names its own commit, so this record
// sits in the commit after SOURCE_COMMIT, which changes no vault source. It reads:
//   - the record: its source_commit is SOURCE_COMMIT, and its two clean reproducible builds (wasm_builds_sha256) are
//     one sha256, the record's wasm_sha256, so the code hash below is that commit's reproducible build (deploy.mjs
//     --verify-records rebuilds it at that commit; vault-build.yml runs it);
//   - on two testnet RPCs of two operators, at final, every read of vault-testnet-t01.mjs check(): keys [], the code
//     hash and sha256 equal to the record's, the imports and exports of vault.md 2.8 and 2.5.7, the testnet token and
//     no other, config(), and the vault's registration on the token.
//   node scripts/live-checks/vault-final-sha.mjs [--account <id>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --account checks another account against the same record (the recorded bad answers). --record writes every RPC
// answer the run read to <file>, so the check's test can replay it.
// Runs: once, the read of testnet-v4's record, keys and code on two RPCs after its deploy; no host deploy changes it
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check as readBack } from "./vault-testnet-t01.mjs";
import { recorder } from "./vault-skeleton.mjs";

const KEY = "vault-final-sha";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENT = path.join(HERE, "../../contracts/vault/deployments/testnet-v4.json");
// The vault's final commit, which testnet-v4's vault is built from (the card's sha).
export const SOURCE_COMMIT = "e0623bf3244dee5115a8b18cbdb54ca355fd3c25";

export function recordProblems(d) {
  const p = [];
  if (d.network !== "testnet") p.push(`network is ${d.network}, want testnet`);
  if (d.source_commit !== SOURCE_COMMIT) p.push(`source_commit is ${d.source_commit ?? "missing"}, want ${SOURCE_COMMIT}`);
  if ("non_reproducible" in d) p.push("the record is marked non_reproducible");
  const b = d.wasm_builds_sha256;
  if (!Array.isArray(b) || b.length !== 2 || b.some((s) => s !== d.wasm_sha256)) p.push(`the two builds ${JSON.stringify(b ?? null)} are not both wasm_sha256 ${d.wasm_sha256}`);
  return p;
}

export async function check({ deployment, account = deployment.account_id, fetchFn, sleep }) {
  const p = recordProblems(deployment);
  const head = [`${p.length ? "BAD" : "ok "} the record is ${SOURCE_COMMIT.slice(0, 12)}'s reproducible build${p.length ? `: ${p.join("; ")}` : ""}`];
  const r = await readBack({ deployment, account, ...(fetchFn ? { fetchFn } : {}), ...(sleep ? { sleep } : {}) });
  return { ok: p.length === 0 && r.ok, lines: [...head, ...r.lines] };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
    const rec = recorder();
    const r = await check({ deployment, account: opt("--account", deployment.account_id), fetchFn: opt("--record") ? rec.fetchFn : undefined });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
