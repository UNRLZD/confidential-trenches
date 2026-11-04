#!/usr/bin/env node
// Live check of card vault-readback: one script reads back a deployed vault on either NEAR network, before the token
// registration and before the vault is listed (vault.md V3.8; VT-R01, the Nov 4 mainnet test vault; VT-R02, the Nov 7
// vault). On two RPCs of two operators (vault-skeleton.mjs operatorProblems), at the final block, it reads with
// vault-testnet-t01.mjs readVault, the reads every deployed vault gets:
//   - view_access_key_list: keys [] (vault.md 2.8, "Read back after every deploy");
//   - view_account and view_code: the code hash and the code's sha256 are the record's, the reproducible build's (the
//     record's two builds agree and its code_hash is the base58 of its wasm_sha256);
//   - the code's imports: none of 2.8's banned ones (a key, a deploy, a delete), promise imports inside the seven, and
//     its exports inside 2.5.7's list (vault-skeleton.mjs wasmProblems); it names the network's token and no other;
//   - config(): it answers, its asset the network's token and its version the network's, both pinned here.
// Then one write: storage_prepay(precommitment) with the minimum attached (config().deposit_storage_bytes bytes), and
// that write read back on both RPCs: final, one storage_prepay call to the vault, the tx and every receipt a success,
// and the vault's receipt logging storage_prepaid {precommitment, payer, amount} for exactly that call. The write is
// sent only after every read passed.
//   - testnet: signed here with --key-file (a testnet key outside the repo, read by deploy.mjs loadKey, never printed),
//     the signer a .testnet or implicit account;
//   - mainnet: never signed here. The script prints the owner's one near CLI line and exits 3; after the paste, the
//     same command with --tx <hash> reads that write back.
//   node scripts/live-checks/vault-mainnet.mjs --network testnet|mainnet --account <vault> --signer <id>
//     [--deployment <file>] [--key-file <path> | --tx <hash>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, reads PASS and the write still to paste exit 3
// --deployment is the vault's record (account_id, wasm_sha256, wasm_builds_sha256, code_hash, network); testnet's
// default is contracts/vault/deployments/testnet-v1.json, mainnet names its own. --record writes every RPC answer the
// run read to <file>, so the check's test can replay it, each NEAR signature replaced (delete-refund-readback.mjs's
// recorder: a 64-byte signature has a secret key's shape, and the check reads none).
import "../net-window.mjs";
import { createHash, sign } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RPCS as TESTNET_RPCS, operatorProblems } from "./vault-skeleton.mjs";
import { recorder } from "./delete-refund-readback.mjs";
import { DEPLOYMENT as TESTNET_DEPLOYMENT, MAINNET_USDC, TESTNET_TOKEN, b58, readVault } from "./vault-testnet-t01.mjs";
import { MAINNET_RPCS } from "../../contracts/vault/scripts/testnet-usdc.mjs";
import { b58decode, functionCallTx } from "../../contracts/vault/scripts/near-tx.mjs";
import { loadKey } from "../../contracts/vault/scripts/deploy.mjs";

const KEY = "vault-mainnet";
const BYTE = 10n ** 19n; // storage_amount_per_byte, the same on both networks
export const PREPAY_GAS = 30n * 10n ** 12n; // the vault's storage_prepay receipt burns about 1.8 Tgas (vault-testnet-t04.md)

// config().version ends with the build's network (contracts/vault/src/constants.rs NETWORK)
export const NETWORKS = {
  testnet: { rpcs: TESTNET_RPCS, token: TESTNET_TOKEN, version: /^blindfill-vault \S+ testnet$/, account: /^([a-z0-9_-]+\.)*testnet$|^[0-9a-f]{64}$/, deployment: TESTNET_DEPLOYMENT },
  mainnet: { rpcs: MAINNET_RPCS, token: MAINNET_USDC, version: /^blindfill-vault \S+ mainnet$/, account: /^([a-z0-9_-]+\.)*near$|^[0-9a-f]{64}$/, deployment: null },
};

const isDecimal = (s) => typeof s === "string" && /^(0|[1-9]\d*)$/.test(s);

async function rpc(fetchFn, url, method, params) {
  const r = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: KEY, method, params }),
  });
  const json = await r.json();
  if (json.error) throw Object.assign(new Error(`${json.error.name ?? "error"}: ${json.error.cause?.name ?? json.error.message ?? ""}`), { cause: json.error.cause?.name });
  if (!json.result) throw new Error(`HTTP ${r.status}, no result`);
  return json.result;
}

/** A fresh precommitment: 31 random bytes, below p, as one canonical decimal. */
export function freshPrecommitment(bytes = Buffer.from(crypto.getRandomValues(new Uint8Array(31)))) {
  return (BigInt(`0x${Buffer.from(bytes).toString("hex")}`) || 1n).toString();
}

/** The near CLI line (near-cli-rs) the owner pastes for the write. It signs nothing here. */
export function pasteLine({ network, account, signer, precommitment, deposit }) {
  const frac = (deposit % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  const near = `${deposit / 10n ** 24n}${frac ? `.${frac}` : ""} NEAR`;
  return `near contract call-function as-transaction ${account} storage_prepay json-args '${JSON.stringify({ precommitment })}' prepaid-gas '30 Tgas' attached-deposit '${near}' sign-as ${signer} network-config ${network} sign-with-keychain send`;
}

/** Signs one storage_prepay with `key` and sends it to `url`, waiting for FINAL. Returns its hash whatever the answer. */
export async function sendPrepay({ fetchFn, url, signer, key, account, precommitment, deposit }) {
  const pk = `ed25519:${b58(key.pub)}`;
  const ak = await rpc(fetchFn, url, "query", { request_type: "view_access_key", account_id: signer, public_key: pk, finality: "final" });
  const block = await rpc(fetchFn, url, "block", { finality: "final" });
  const tx = functionCallTx({ signer, publicKey: key.pub, nonce: BigInt(ak.nonce) + 1n, receiver: account, blockHash: b58decode(block.header.hash), method: "storage_prepay", args: JSON.stringify({ precommitment }), gas: PREPAY_GAS, deposit });
  const h = createHash("sha256").update(tx).digest();
  const signed = Buffer.concat([tx, Buffer.from([0]), sign(null, h, key.privateKey)]);
  try {
    await rpc(fetchFn, url, "send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" });
  } catch {
    // a timeout or a refusal: the read-back below says whether it landed
  }
  return b58(h);
}

/** The storage_prepay tx `hash` by `signer` read back on `url`, each fact told to `say`. */
export async function readPrepay({ fetchFn, url, hash, signer, account, minDeposit, say, tries = 10, wait = 3000 }) {
  const at = `on ${url}`;
  let r;
  for (let i = 1; ; i++) {
    try {
      r = await rpc(fetchFn, url, "tx", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" });
      break;
    } catch (e) {
      if (i >= tries || !/UNKNOWN_TRANSACTION|TIMEOUT/.test(e.message)) return say(false, `storage_prepay tx ${hash} by ${signer} ${at}: ${e.message}`);
      await new Promise((ok) => setTimeout(ok, wait));
    }
  }
  say(r.final_execution_status === "FINAL", `storage_prepay tx ${hash} by ${signer} is final ${at}: ${r.final_execution_status ?? "no status"}`);
  const t = r.transaction ?? {};
  const fc = t.actions?.length === 1 ? t.actions[0]?.FunctionCall : null;
  let pc = null;
  try {
    pc = JSON.parse(Buffer.from(fc?.args ?? "", "base64").toString("utf8")).precommitment;
  } catch {}
  const deposit = isDecimal(fc?.deposit) ? BigInt(fc.deposit) : -1n;
  const shape = t.signer_id === signer && t.receiver_id === account && fc?.method_name === "storage_prepay" && isDecimal(pc) && deposit >= minDeposit;
  say(shape, `the tx is one storage_prepay call from ${signer} to ${account} with at least ${minDeposit} yocto ${at}: ${t.signer_id} -> ${t.receiver_id}, ${t.actions?.length ?? 0} action(s), ${fc?.method_name ?? "no call"}, deposit ${fc?.deposit ?? "none"}, precommitment ${pc ?? "none"}`);
  const outcomes = [r.transaction_outcome, ...(r.receipts_outcome ?? [])].filter(Boolean);
  const failed = outcomes.filter((o) => o.outcome?.status?.Failure);
  const success = r.status && "SuccessValue" in r.status;
  say(success && failed.length === 0, `the tx and every receipt succeeded ${at}: ${success ? "SuccessValue" : JSON.stringify(r.status ?? null).slice(0, 300)}, ${failed.length} failed of ${outcomes.length}`);
  const want = { precommitment: pc, payer: signer, amount: String(deposit) };
  const events = (r.receipts_outcome ?? []).filter((o) => o.outcome?.executor_id === account).flatMap((o) => o.outcome.logs ?? []).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => {
    try {
      return JSON.parse(l.slice("EVENT_JSON:".length));
    } catch {
      return null;
    }
  });
  const ev = events.find((e) => e?.standard === "blindfill-vault" && e.event === "storage_prepaid");
  const logged = ev && ev.data?.length === 1 && JSON.stringify(ev.data[0]) === JSON.stringify(want);
  say(Boolean(logged), `${account} logged storage_prepaid ${JSON.stringify(want)} ${at}: ${ev ? JSON.stringify(ev.data) : "no storage_prepaid event"}`);
}

export async function check({ network, account, deployment, fetchFn = fetch, rpcs = NETWORKS[network]?.rpcs, write = {}, wait = 3000 }) {
  const lines = [];
  let ok = true;
  const say = (good, text) => {
    ok &&= good;
    lines.push(`${good ? "ok " : "BAD"} ${text}`);
  };
  const net = NETWORKS[network];
  if (!net) throw new Error(`--network ${network}: want testnet or mainnet`);
  if (write.key && network !== "testnet") throw new Error("a mainnet write is the owner's paste: this script signs on testnet only");
  for (const p of operatorProblems(rpcs, network)) say(false, p);
  rpcs = rpcs.slice(0, 2);
  const recordHash = /^[0-9a-f]{64}$/.test(deployment.wasm_sha256 ?? "") ? b58(Buffer.from(deployment.wasm_sha256, "hex")) : null;
  say(deployment.network === network, `the record is a ${network} record: ${deployment.network}`);
  const builds = deployment.wasm_builds_sha256;
  say(Array.isArray(builds) && builds.length >= 2 && builds.every((b) => b === deployment.wasm_sha256), `the record's builds agree on its wasm_sha256 ${deployment.wasm_sha256}: [${Array.isArray(builds) ? builds.join(", ") : "none"}]`);
  say(recordHash !== null && deployment.code_hash === recordHash, `the record's code_hash ${deployment.code_hash} is the base58 of its wasm_sha256 ${deployment.wasm_sha256}`);
  const configs = [];
  for (const url of rpcs) configs.push((await readVault({ fetchFn, url, account, deployment, token: net.token, version: net.version, say })).config);

  // the write, only on a vault whose every read passed
  const bytes = configs[0]?.deposit_storage_bytes;
  const sameConfig = configs.length === 2 && JSON.stringify(configs[0]) === JSON.stringify(configs[1]);
  say(sameConfig && Number.isInteger(bytes) && bytes > 0, `config() is the same on both RPCs and names deposit_storage_bytes: ${bytes ?? "none"}`);
  if (!ok) {
    say(false, "no storage_prepay: a read above failed, so nothing is written to this vault");
    return { ok, lines };
  }
  const minDeposit = BigInt(bytes) * BYTE;
  const { signer } = write;
  if (!signer || !net.account.test(signer)) {
    say(false, `the write's signer ${signer ?? "(none)"} is not a ${network} account`);
    return { ok, lines };
  }
  let hash = write.tx;
  if (!hash && write.key) {
    hash = await sendPrepay({ fetchFn, url: rpcs[0], signer, key: write.key, account, precommitment: write.precommitment ?? freshPrecommitment(), deposit: minDeposit });
    lines.push(`    sent storage_prepay tx ${hash} by ${signer} on ${rpcs[0]}`);
  }
  if (!hash) {
    const line = pasteLine({ network, account, signer, precommitment: write.precommitment ?? freshPrecommitment(), deposit: minDeposit });
    return { ok: false, pending: true, lines, line };
  }
  for (const url of rpcs) await readPrepay({ fetchFn, url, hash, signer, account, minDeposit, say, wait });
  return { ok, lines, tx: hash };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const known = new Set(["--network", "--account", "--signer", "--deployment", "--key-file", "--tx", "--record"]);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    for (let i = 0; i < a.length; i += 2) if (!known.has(a[i]) || a[i + 1] === undefined || a[i + 1].startsWith("--")) throw new Error(`argument ${a[i]}: want ${[...known].join(", ")}, each with a value`);
    const network = opt("--network");
    const net = NETWORKS[network];
    if (!net) throw new Error("--network testnet|mainnet is required");
    const account = opt("--account");
    if (!account || !net.account.test(account)) throw new Error(`--account <vault>: a ${network} account is required`);
    const file = opt("--deployment", net.deployment);
    if (!file) throw new Error(`--deployment <file> is required on ${network}: the vault's reproducible-build record`);
    const deployment = JSON.parse(readFileSync(file, "utf8"));
    if (!/^[0-9a-f]{64}$/.test(deployment.wasm_sha256 ?? "")) throw new Error("deployment: want wasm_sha256");
    const signer = opt("--signer");
    if (opt("--key-file") && network !== "testnet") throw new Error("--key-file is testnet only: a mainnet write is the owner's paste, never signed here");
    if (opt("--key-file") && opt("--tx")) throw new Error("--key-file sends a new write and --tx reads one back: give one");
    const key = opt("--key-file") ? loadKey(opt("--key-file"), signer) : null;
    const tx = opt("--tx");
    if (tx && !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(tx)) throw new Error("--tx: want a base58 tx hash");
    const rec = recorder();
    const r = await check({ network, account, deployment, fetchFn: opt("--record") ? rec.fetchFn : fetch, write: { signer, key, tx } });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    if (r.pending) {
      console.log(`live-check ${KEY}: the reads PASS; the write is the owner's paste (it signs nothing here):`);
      console.log(r.line);
      console.log(`live-check ${KEY}: then: node scripts/live-checks/vault-mainnet.mjs ${a.join(" ")} --tx <its hash>`);
      process.exit(3);
    }
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
