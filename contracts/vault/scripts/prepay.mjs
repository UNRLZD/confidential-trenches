#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The read-back's one write on testnet (card vault-readback; vault.md V3.8): scripts/live-checks/vault-mainnet.mjs reads
// the vault on two operators; only when every read passed, this script signs one storage_prepay(fresh precommitment)
// with the minimum the check names (config().deposit_storage_bytes bytes) and sends it, then runs the same check with
// --tx to read that write back on both RPCs. Testnet only: a mainnet write is the owner's paste, which the check prints.
// The signer's key comes from --key-file (deploy.mjs loadKey: a file outside the repo, the near CLI's
// ~/.near-credentials/testnet/<signer>.json or any {account_id, public_key, private_key}); it is never printed, written
// or sent. --record writes every RPC answer both checks and the send read, signatures replaced, for the check's test.
//   node contracts/vault/scripts/prepay.mjs --account <vault>.testnet --signer <id>.testnet --key-file <path>
//     [--deployment <file>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
import "../../../scripts/net-window.mjs";
import { createHash, sign } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { b58decode, b58encode, functionCallTx } from "./near-tx.mjs";
import { loadKey } from "./deploy.mjs";
import { NETWORKS, PREPAY_GAS, check } from "../../../scripts/live-checks/vault-mainnet.mjs";
import { recorder } from "../../../scripts/live-checks/delete-refund-readback.mjs";

async function rpc(fetchFn, url, method, params) {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "prepay", method, params }) });
  const j = await r.json();
  if (j?.error) throw new Error(`${method} on ${url}: ${JSON.stringify(j.error).slice(0, 300)}`);
  if (!j?.result) throw new Error(`${method} on ${url}: HTTP ${r.status}, no result`);
  return j.result;
}

/** Signs one storage_prepay with `key` and sends it to `url`, waiting for FINAL. Returns its hash whatever the answer. */
export async function sendPrepay({ fetchFn, url, signer, key, account, precommitment, deposit }) {
  const ak = await rpc(fetchFn, url, "query", { request_type: "view_access_key", account_id: signer, public_key: `ed25519:${b58encode(key.pub)}`, finality: "final" });
  const block = await rpc(fetchFn, url, "block", { finality: "final" });
  const tx = functionCallTx({ signer, publicKey: key.pub, nonce: BigInt(ak.nonce) + 1n, receiver: account, blockHash: b58decode(block.header.hash), method: "storage_prepay", args: JSON.stringify({ precommitment }), gas: PREPAY_GAS, deposit });
  const h = createHash("sha256").update(tx).digest();
  try {
    await rpc(fetchFn, url, "send_tx", { signed_tx_base64: Buffer.concat([tx, Buffer.from([0]), sign(null, h, key.privateKey)]).toString("base64"), wait_until: "FINAL" });
  } catch {
    // a timeout or a refusal: the check's read-back says whether it landed
  }
  return b58encode(h);
}

/** The reads, then (only when they pass) the write and its read-back. { ok, lines, tx } */
export async function prepay({ account, deployment, signer, key, fetchFn = fetch, wait = 3000 }) {
  const first = await check({ network: "testnet", account, deployment, fetchFn, write: { signer }, wait });
  if (!first.pending) return { ok: false, lines: first.lines };
  const url = NETWORKS.testnet.rpcs[0];
  const tx = await sendPrepay({ fetchFn, url, signer, key, account, ...first.prepay });
  const back = await check({ network: "testnet", account, deployment, fetchFn, write: { signer, tx }, wait });
  return { ok: back.ok, tx, lines: [...first.lines, `    sent storage_prepay tx ${tx} by ${signer} on ${url}`, ...back.lines] };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const known = new Set(["--account", "--signer", "--key-file", "--deployment", "--record"]);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    for (let i = 0; i < a.length; i += 2) if (!known.has(a[i]) || a[i + 1] === undefined || a[i + 1].startsWith("--")) throw new Error(`argument ${a[i]}: want ${[...known].join(", ")}, each with a value`);
    const { account: ACCOUNT, deployment: DEPLOYMENT } = NETWORKS.testnet;
    const account = opt("--account");
    const signer = opt("--signer");
    if (!ACCOUNT.test(account ?? "") || !ACCOUNT.test(signer ?? "")) throw new Error("--account and --signer: testnet accounts are required (testnet only: a mainnet write is the owner's paste)");
    if (!opt("--key-file")) throw new Error("--key-file <path> is required: the signer's testnet key, outside the repo");
    const key = loadKey(opt("--key-file"), signer);
    const deployment = JSON.parse(readFileSync(opt("--deployment", DEPLOYMENT), "utf8"));
    const rec = recorder();
    const r = await prepay({ account, deployment, signer, key, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    for (const l of r.lines) console.log(`prepay: ${l}`);
    console.log(`prepay: ${r.ok ? "PASS" : "FAIL"}${r.tx ? ` (tx ${r.tx}; read it back again: node scripts/live-checks/vault-mainnet.mjs --network testnet --account ${account} --signer ${signer} --tx ${r.tx})` : ""}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`prepay: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
