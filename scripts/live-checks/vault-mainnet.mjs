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
// Then one write: storage_prepay(P) with exactly the minimum attached (DEPOSIT_STORAGE_BYTES, which config() must
// name, x 1e19 yocto), read back on both RPCs by --tx with --precommitment P: final, the tx itself (its hash, signer
// and receiver), one storage_prepay call of exactly P and exactly that deposit, the tx and every receipt run and
// succeeded, and the vault's own receipt logging one storage_prepaid {P, signer, deposit}.
// This check holds no key and signs nothing, on either network. Without --tx, once every read passed, it prints the
// write as a near-cli 4.0.13 line (and its Ledger variant) and the command that reads it back, and exits 3:
//   - mainnet: that line is the owner's paste; then the printed command, with the paste's Transaction Id as --tx;
//   - testnet: the same line, run with the signer's testnet key in ~/.near-credentials/testnet/, or
//     contracts/vault/scripts/prepay.mjs, which signs and sends that write itself and then reads it back.
//   node scripts/live-checks/vault-mainnet.mjs --network testnet|mainnet --account <vault> --signer <id>
//     [--deployment <file>] [--precommitment <P> [--tx <hash>]] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, reads PASS and the write still to send exit 3
// --deployment is the vault's record (account_id, wasm_sha256, wasm_builds_sha256, code_hash, network); testnet's
// default is contracts/vault/deployments/testnet-v1.json, mainnet names its own. --record writes every RPC answer the
// run read to <file>, so the check's test can replay it, each NEAR signature replaced (delete-refund-readback.mjs's
// recorder: a 64-byte signature has a secret key's shape, and the check reads none).
// Runs: once, a contract deploy read back on chain: the script vault-readback runs after each vault deploy, with that vault's --account; no host deploy changes it
import "../net-window.mjs";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RPCS as TESTNET_RPCS, operatorProblems } from "./vault-skeleton.mjs";
import { recorder } from "./delete-refund-readback.mjs";
import { DEPLOYMENT as TESTNET_DEPLOYMENT, MAINNET_USDC, TESTNET_TOKEN, b58, readVault } from "./vault-testnet-t01.mjs";

const KEY = "vault-mainnet";
// FastNEAR and dRPC on mainnet: two operators (near-rpc-operators.mjs), as contracts/vault/scripts/testnet-usdc.mjs
// reads mainnet USDC's pin
export const MAINNET_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const BYTE = 10n ** 19n; // storage_amount_per_byte, the same on both networks
export const PREPAY_GAS = 30n * 10n ** 12n; // the vault's storage_prepay receipt burns about 1.8 Tgas (vault-testnet-t04.md)

// What a deposit writes, the vault's minimum storage_prepay (contracts/vault/src/constants.rs DEPOSIT_STORAGE_BYTES),
// pinned here: config() must name it, so the write's deposit is a number this check holds, not one the vault answers.
export const DEPOSIT_STORAGE_BYTES = 756;
// the field's modulus p (contracts/vault/src/field.rs P): a precommitment is one canonical decimal below it
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// A NEAR account id (nearcore's AccountId rules: 2 to 64 characters, lowercase parts joined by "." with "-" or "_"
// inside a part). A 64-hex implicit account is an account on both networks. Otherwise a testnet account is `testnet`
// or a sub-account of it, and a mainnet account is any other id, so a top-level name (sweat), another suffix (.tg) and
// an 0x id pass. On testnet an 0x (ETH-implicit) id is refused although it exists there too: that only refuses a
// read-back, never lets one through, so it is left so.
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isTestnetName = (s) => s === "testnet" || s.endsWith(".testnet");
const accountOf = (network) => ({ test: (s) => typeof s === "string" && ACCOUNT_ID.test(s) && (/^[0-9a-f]{64}$/.test(s) || (network === "testnet") === isTestnetName(s)) });

// config().version ends with the build's network (contracts/vault/src/constants.rs NETWORK). Mainnet's record is
// named with --deployment until the mainnet vault's record is committed; then it becomes the default here.
export const NETWORKS = {
  testnet: { rpcs: TESTNET_RPCS, token: TESTNET_TOKEN, version: /^blindfill-vault \S+ testnet$/, account: accountOf("testnet"), deployment: TESTNET_DEPLOYMENT },
  mainnet: { rpcs: MAINNET_RPCS, token: MAINNET_USDC, version: /^blindfill-vault \S+ mainnet$/, account: accountOf("mainnet"), deployment: null },
};

// one shell word, as sh reads it back: the owner copies the read-back line whole, a path with a space or a quote included
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);
const isDecimal = (s) => typeof s === "string" && /^(0|[1-9]\d*)$/.test(s);
/** A precommitment the vault takes: one canonical decimal below p. */
export const isPrecommitment = (s) => isDecimal(s) && BigInt(s) < P;

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

// The CLI the write line is for: near-cli 4.0.13 (npm near-cli), the `near` installed on the team's Mac. It signs with
// the signer's key in ~/.near-credentials/<network>/<signer>.json, or with a Ledger (the second line).
export const NEAR_CLI = "near-cli 4.0.13";

/** The write as near-cli lines: { line, ledgerLine }. This check signs nothing; the CLI does. */
export function pasteLine({ network, account, signer, precommitment, deposit }) {
  const line = `near call ${account} storage_prepay '${JSON.stringify({ precommitment })}' --useAccount ${signer} --depositYocto ${deposit} --gas ${PREPAY_GAS} --networkId ${network}`;
  return { line, ledgerLine: `${line} --signWithLedger` };
}

// An outcome that ran and succeeded: SuccessValue or SuccessReceiptId. Failure, Unknown (not run yet) or no status is not.
const succeeded = (status) => status !== null && typeof status === "object" && ("SuccessValue" in status || "SuccessReceiptId" in status);

/** The storage_prepay tx `hash` by `signer` read back on `url`, each fact told to `say`: it must be exactly the write
 * printed, one storage_prepay of `precommitment` with `deposit` attached, from `signer` to `account`. */
export async function readPrepay({ fetchFn, url, hash, signer, account, precommitment, deposit, say, tries = 10, wait = 3000 }) {
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
  say(t.hash === hash && t.signer_id === signer && t.receiver_id === account, `the tx is ${hash} from ${signer} to ${account} ${at}: ${t.hash} from ${t.signer_id} to ${t.receiver_id}`);
  const fc = t.actions?.length === 1 ? t.actions[0]?.FunctionCall : null;
  // the args bytes are exactly the printed line's, so no other field (or spelling) rides along
  const args = Buffer.from(typeof fc?.args === "string" ? fc.args : "", "base64").toString("utf8");
  const call = fc?.method_name === "storage_prepay" && args === JSON.stringify({ precommitment }) && fc?.deposit === String(deposit);
  say(call, `the tx is one storage_prepay of precommitment ${precommitment} with exactly ${deposit} yocto ${at}: ${t.actions?.length ?? 0} action(s), ${fc?.method_name ?? "no call"}, args ${args.slice(0, 200) || "none"}, deposit ${fc?.deposit ?? "none"}`);
  const outcomes = [r.transaction_outcome, ...(r.receipts_outcome ?? [])];
  const ran = outcomes.filter((o) => succeeded(o?.outcome?.status));
  const success = r.status !== null && typeof r.status === "object" && "SuccessValue" in r.status;
  say(success && ran.length === outcomes.length, `the tx and every receipt succeeded ${at}: ${success ? "SuccessValue" : JSON.stringify(r.status ?? null).slice(0, 300)}, ${ran.length} of ${outcomes.length} succeeded`);
  const want = { precommitment, payer: signer, amount: String(deposit) };
  const events = (r.receipts_outcome ?? []).filter((o) => o.outcome?.executor_id === account).flatMap((o) => o.outcome.logs ?? []).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => {
    try {
      return JSON.parse(l.slice("EVENT_JSON:".length));
    } catch {
      return null;
    }
  }).filter((e) => e?.standard === "blindfill-vault" && e.event === "storage_prepaid");
  const logged = events.length === 1 && events[0].data?.length === 1 && JSON.stringify(events[0].data[0]) === JSON.stringify(want);
  say(logged, `${account} logged one storage_prepaid ${JSON.stringify(want)} ${at}: ${events.length ? events.map((e) => JSON.stringify(e.data)).join(", ") : "no storage_prepaid event"}`);
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
  for (const p of operatorProblems(rpcs, network)) say(false, p);
  rpcs = rpcs.slice(0, 2);
  const recordHash = /^[0-9a-f]{64}$/.test(deployment.wasm_sha256 ?? "") ? b58(Buffer.from(deployment.wasm_sha256, "hex")) : null;
  say(deployment.network === network, `the record is a ${network} record: ${deployment.network}`);
  const builds = deployment.wasm_builds_sha256;
  say(Array.isArray(builds) && builds.length >= 2 && builds.every((b) => b === deployment.wasm_sha256), `the record's builds agree on its wasm_sha256 ${deployment.wasm_sha256}: [${Array.isArray(builds) ? builds.join(", ") : "none"}]`);
  say(recordHash !== null && deployment.code_hash === recordHash, `the record's code_hash ${deployment.code_hash} is the base58 of its wasm_sha256 ${deployment.wasm_sha256}`);
  say(deployment.account_id === account, `the record is ${account}'s: ${deployment.account_id}`);
  say(deployment.asset === net.token, `the record's asset is the ${network} token ${net.token}: ${deployment.asset}`);
  const configs = [];
  for (const url of rpcs) configs.push((await readVault({ fetchFn, url, account, deployment, token: net.token, version: net.version, say })).config);

  // the write, only on a vault whose every read passed
  const bytes = configs[0]?.deposit_storage_bytes;
  const sameConfig = configs.length === 2 && JSON.stringify(configs[0]) === JSON.stringify(configs[1]);
  say(sameConfig, `config() is the same on both RPCs: ${sameConfig ? "yes" : "no"}`);
  say(bytes === DEPOSIT_STORAGE_BYTES, `config() names deposit_storage_bytes ${DEPOSIT_STORAGE_BYTES}: ${bytes ?? "none"}`);
  if (!ok) {
    say(false, "no storage_prepay: a read above failed, so nothing is written to this vault");
    return { ok, lines };
  }
  const deposit = BigInt(DEPOSIT_STORAGE_BYTES) * BYTE;
  const { signer } = write;
  if (!net.account.test(signer)) {
    say(false, `the write's signer ${signer ?? "(none)"} is not a ${network} account`);
    return { ok, lines };
  }
  const hash = write.tx;
  if (!hash) {
    const precommitment = write.precommitment ?? freshPrecommitment();
    return { ok: false, pending: true, lines, ...pasteLine({ network, account, signer, precommitment, deposit }), prepay: { precommitment, deposit } };
  }
  // a read-back is of the one write printed: its precommitment is given with the tx
  if (!isPrecommitment(write.precommitment)) {
    say(false, `the write's precommitment ${write.precommitment ?? "(none)"} is not one canonical decimal below p: --tx needs the --precommitment printed with the write`);
    return { ok, lines };
  }
  for (const url of rpcs) await readPrepay({ fetchFn, url, hash, signer, account, precommitment: write.precommitment, deposit, say, wait });
  return { ok, lines, tx: hash };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const known = new Set(["--network", "--account", "--signer", "--deployment", "--tx", "--precommitment", "--record"]);
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
    const tx = opt("--tx");
    if (tx && !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(tx)) throw new Error("--tx: want a base58 tx hash");
    const precommitment = opt("--precommitment");
    if (tx && !precommitment) throw new Error("--tx needs --precommitment <P>: the one the write line printed");
    if (precommitment && !isPrecommitment(precommitment)) throw new Error("--precommitment: want one canonical decimal below p");
    const rec = recorder();
    const r = await check({ network, account, deployment, fetchFn: opt("--record") ? rec.fetchFn : fetch, write: { signer, tx, precommitment } });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    if (r.pending) {
      console.log(`live-check ${KEY}: the reads PASS; the write, signed by ${signer} through ${NEAR_CLI} (this check signs nothing; on testnet contracts/vault/scripts/prepay.mjs can send it):`);
      console.log(r.line);
      console.log(`live-check ${KEY}: or with a Ledger:`);
      console.log(r.ledgerLine);
      console.log(`live-check ${KEY}: then: node scripts/live-checks/vault-mainnet.mjs --network ${network} --account ${account} --signer ${signer}${opt("--deployment") ? ` --deployment ${shq(opt("--deployment"))}` : ""} --precommitment ${r.prepay.precommitment} --tx <its Transaction Id>`);
      process.exit(3);
    }
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
