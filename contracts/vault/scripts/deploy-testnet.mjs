#!/usr/bin/env node
// Deploys the vault on NEAR testnet with no key, by the recipe of vault.md 2.8: a parent signs one transaction to
// vault.<parent> with [CreateAccount, Transfer(code storage + 0.01 N), DeployContract(wasm), FunctionCall(config)] and
// no AddKey, so the new account starts with no access key and the parent keeps no power over it. The config() call in
// the same receipt compiles and runs the wasm: if it cannot run, the whole batch rolls back.
//
// The parent is a fresh named account the testnet faucet makes (never a 64-hex implicit account, which a lone Transfer
// creates with a full key). Its ed25519 key is made in this process and lives only here: it is never written, printed
// or sent anywhere but as signatures, so the parent can sign nothing after this run. Testnet only; no dependency.
//   node contracts/vault/scripts/deploy-testnet.mjs --wasm <file> [--parent <name>.testnet] [--out <file>]
//     [--build "<the build command>"]
// Before anything is sent it refuses a wasm that fails the live check's static rules (vault.md 2.8 imports, 2.5.7
// exports) or is not a testnet build (its bytes must name Circle's testnet USDC and "testnet", never mainnet's id or
// "mainnet"), and after the deploy it refuses a config() that names anything but those pinned values. It writes the account, the tx hash and the wasm's sha256 to --out (default
// contracts/vault/deployments/testnet-skeleton.json); then run scripts/live-checks/vault-skeleton.mjs.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RPCS, TESTNET_USDC, TESTNET_VERSION, networkProblems, wasmProblems } from "../../../scripts/live-checks/vault-skeleton.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// near-cli-rs's testnet faucet (`create-account sponsor-by-faucet-service`), as the vault-gas proof used it
const FAUCET = "https://helper.nearprotocol.com/account";
const RPC = RPCS[0];
const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const BYTE = 10n ** 19n; // storage_amount_per_byte
const CONFIG_GAS = 100n * TGAS;

// ---- base58 (Bitcoin alphabet), borsh ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of bytes) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}
export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("base58: bad character");
    n = n * 58n + BigInt(i);
  }
  const hex = n === 0n ? "" : n.toString(16);
  const body = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  const zeros = s.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

class Borsh {
  parts = [];
  u8(x) { this.parts.push(Buffer.from([x])); return this; }
  u32(x) { const b = Buffer.alloc(4); b.writeUInt32LE(x); this.parts.push(b); return this; }
  u64(x) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(x)); this.parts.push(b); return this; }
  u128(x) { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(x) & 0xffffffffffffffffn); b.writeBigUInt64LE(BigInt(x) >> 64n, 8); this.parts.push(b); return this; }
  fixed(bytes) { this.parts.push(Buffer.from(bytes)); return this; }
  bytes(bytes) { return this.u32(bytes.length).fixed(bytes); }
  string(s) { return this.bytes(Buffer.from(s, "utf8")); }
  done() { return Buffer.concat(this.parts); }
}

// nearcore's Transaction in its V0 layout (Borsh, no version tag) with the four actions of the recipe and nothing else: Action enum indexes
// CreateAccount 0, DeployContract 1, FunctionCall 2, Transfer 3; PublicKey and Signature tag ED25519 = 0.
export function recipeTx({ signer, publicKey, nonce, receiver, blockHash, wasm, transfer, configGas }) {
  const w = new Borsh().string(signer).u8(0).fixed(publicKey).u64(nonce).string(receiver).fixed(blockHash).u32(4);
  w.u8(0); // CreateAccount
  w.u8(3).u128(transfer); // Transfer
  w.u8(1).bytes(wasm); // DeployContract
  w.u8(2).string("config").bytes(Buffer.from("{}")).u64(configGas).u128(0n); // FunctionCall
  return w.done();
}

async function rpc(method, params, url = RPC) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "deploy", method, params }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 400)}`);
  // a query can answer an error inside its result (an access key not there yet)
  if (j.result?.error) throw new Error(`${method}: ${String(j.result.error).slice(0, 400)}`);
  return j.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const wasmPath = opt("--wasm");
  if (!wasmPath) throw new Error("usage: deploy-testnet.mjs --wasm <file> [--parent <name>.testnet] [--out <file>] [--build <cmd>]");
  const out = opt("--out", path.join(HERE, "../deployments/testnet-skeleton.json"));
  const wasm = readFileSync(wasmPath);
  const sha = createHash("sha256").update(wasm).digest("hex");
  const w = wasmProblems(wasm);
  if (w.banned.length || w.promises.length || w.exports.length) throw new Error(`refused before any send: the wasm breaks vault.md 2.8 or 2.5.7: ${JSON.stringify({ banned: w.banned, promises: w.promises, exports: w.exports })}`);
  const n = networkProblems(wasm);
  if (n.length) throw new Error(`refused before any send: not a testnet build: ${n.join("; ")}`);
  console.log(`wasm ${wasmPath}: ${wasm.length} B, sha256 ${sha}; exports [${w.functionExports.join(", ")}]; promise imports [${w.promiseImports.join(", ")}]`);

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "t").toLowerCase();
  const parent = opt("--parent", `bf-vs-${stamp}.testnet`);
  if (!/^[a-z0-9-]+\.testnet$/.test(parent) || /^[0-9a-f]{64}$/.test(parent)) throw new Error(`parent ${parent}: want a named <name>.testnet`);
  const vault = `vault.${parent}`;

  // the parent's key: made here, kept in this process only
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const pubText = `ed25519:${b58encode(pub)}`;

  // 1. the parent, from the faucet
  const res = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: parent, newAccountPublicKey: pubText }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`faucet: HTTP ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  const fo = body.final_execution_outcome ?? body;
  const sv = fo?.status?.SuccessValue;
  if (sv === undefined || Buffer.from(sv, "base64").toString() === "false") throw new Error(`faucet: not created: ${JSON.stringify(fo?.status).slice(0, 300)}`);
  const parentTx = fo?.transaction_outcome?.id ?? fo?.transaction?.hash ?? null;
  console.log(`parent ${parent} made by the faucet, tx ${parentTx}`);

  // 2. its key's nonce, once the key is visible
  let ak;
  for (let i = 0; i < 30 && !ak; i++) {
    try {
      ak = await rpc("query", { request_type: "view_access_key", account_id: parent, public_key: pubText, finality: "final" });
    } catch {
      await sleep(2000);
    }
  }
  if (!ak) throw new Error(`the parent's key is not visible on ${RPC}`);
  const acct = await rpc("query", { request_type: "view_account", account_id: parent, finality: "final" });

  // 3. the recipe: code storage (code + 100 B account record) + 0.01 N
  const transfer = BigInt(wasm.length + 100) * BYTE + NEAR / 100n;
  const block = await rpc("block", { finality: "final" });
  const tx = recipeTx({ signer: parent, publicKey: pub, nonce: BigInt(ak.nonce) + 1n, receiver: vault, blockHash: b58decode(block.header.hash), wasm, transfer, configGas: CONFIG_GAS });
  const hash = createHash("sha256").update(tx).digest();
  const signed = Buffer.concat([tx, Buffer.from([0]), sign(null, hash, privateKey)]);
  const txHash = b58encode(hash);
  console.log(`parent holds ${acct.amount} yocto; sending ${txHash}: [CreateAccount, Transfer(${transfer}), DeployContract(${wasm.length} B), FunctionCall(config, ${CONFIG_GAS / TGAS} Tgas, 0)] to ${vault}, no AddKey`);
  const r = await rpc("send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" });
  const failed = [r.transaction_outcome, ...r.receipts_outcome].filter((o) => o.outcome.status.Failure);
  if (!("SuccessValue" in (r.status ?? {})) || failed.length) throw new Error(`deploy failed: ${JSON.stringify(r.status).slice(0, 400)}`);
  const vaultReceipt = r.receipts_outcome.find((o) => o.outcome.executor_id === vault);
  const config = JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString("utf8"));
  if (config.asset !== TESTNET_USDC || !TESTNET_VERSION.test(config.version)) throw new Error(`deployed, but config() names asset ${config.asset}, version ${config.version}: not the testnet build; no record written`);
  console.log(`deployed: tx ${txHash}; config() answered asset ${config.asset}, scope ${config.scope}; the vault's receipt burnt ${vaultReceipt?.outcome.gas_burnt} gas`);

  const doc = {
    network: "testnet",
    account_id: vault,
    parent,
    parent_tx: parentTx,
    tx_hash: txHash,
    tx_actions: ["CreateAccount", "Transfer", "DeployContract", "FunctionCall(config)"],
    transfer_yocto: String(transfer),
    config_gas: String(CONFIG_GAS),
    vault_receipt_gas_burnt: vaultReceipt ? String(vaultReceipt.outcome.gas_burnt) : null,
    wasm_sha256: sha,
    wasm_bytes: wasm.length,
    code_hash: b58encode(Buffer.from(sha, "hex")),
    asset: TESTNET_USDC,
    scope: config.scope,
    version: config.version,
    build: opt("--build", null),
    deployed_at: new Date().toISOString(),
  };
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${out}; next: node scripts/live-checks/vault-skeleton.mjs`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(`deploy-testnet: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(1);
  });
}
