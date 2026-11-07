#!/usr/bin/env node
// Live check of card helper-mainnet-vault-env: HELPER_HOST carries mainnet withdrawals for the vault of the mainnet
// deploy record and no other (the helper's pin rule, apps/helper/src/withdraw/send.ts MAINNET_VAULT:
// contracts/vault/deployments/mainnet-v1.json once it exists, else mainnet-test.json; the kit's rule names
// mainnet-v1.json's vault or null, never mainnet-test.json's), with a relayer account that exists on
// mainnet. It sends nothing that could be carried and moves no money. With Origin APP_HOST it reads:
//   - GET /v1/withdraw/fee for mainnet USDC: 200, naming the relayer account and the fee recipient;
//   - POST /v1/withdraw, the recorded real proof's withdrawal (apps/helper/src/withdraw/fixtures/withdraw-request.json)
//     with its fee_recipient set to the record's vault (never a fee account the helper carries, check 8) and its
//     context computed for the record's vault and scope (the kit's vaultContextOf): 400 bad_fee_recipient. The helper
//     recomputes the context with its own vault and scope (check 2) before it reads the fee recipient (check 3), so only
//     a helper whose mainnet vault is the record's gets past check 2; one carrying another vault answers bad_proof, one
//     not carrying mainnet bad_shape;
//   - the same withdrawal with its context computed for another vault (decoyFor: chosen at run time to differ from the
//     record's, its scope from the kit's vaultScopeOf): 400 bad_proof, so the answer above is the vault's doing;
// then, at one final block both of two mainnet RPCs of two operators hold (the same height and hash), the relayer
// account the fee answer names: it exists on both with the same amount and key list, holds a full-access key (an
// implicit account: the key its id names) and at least RELAYER_FLOOR_YOCTO, one withdrawal's floor (send.ts
// withdrawFloor, else every send answers relayer_low). Every answer carries a full-sha X-Helper-Commit and APP_HOST
// echoed, a JSON body under 1 KB, and no tx_hash.
//   node scripts/live-checks/helper-mainnet-vault-env.mjs [--base <url>] [--record <file>]   PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VAULT_CONSTANTS, vaultContextInput, vaultContextOf, vaultScopeOf } from "../../packages/kit/src/index.ts";

export const KEY = "helper-mainnet-vault-env";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const USDC = VAULT_CONSTANTS.TOKEN;
/** Two mainnet RPCs of two operators (relayer-withdraw-fee's mainnet pair). */
export const PAIR = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
/** The decoy vault: the first of these that is not the record's (any account id works: its scope is computed). */
export const DECOYS = ["vault.confidential.unrlzd.near", "vault-test.confidential.unrlzd.near"];
export const decoyFor = (record) => DECOYS.find((v) => v !== record.account_id);
/**
 * One withdrawal's floor on the relayer account (apps/helper/src/withdraw/send.ts withdrawFloor, at USDC's
 * storage_balance_bounds().min of 0.00125 NEAR and a fee above 0): 0.4652 NEAR and 2 yocto. The test holds it to send.ts.
 */
export const RELAYER_FLOOR_YOCTO = 465_200_000_000_000_000_000_002n;
export const SPREAD = 30;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENTS = path.join(HERE, "../../contracts/vault/deployments");
/** The helper's pin rule (apps/helper/src/withdraw/send.ts MAINNET_VAULT, not the kit's, which is mainnet-v1.json or
 *  null): mainnet-v1.json once it exists, else mainnet-test.json. */
export const recordFile = (dir = DEPLOYMENTS) => (existsSync(path.join(dir, "mainnet-v1.json")) ? path.join(dir, "mainnet-v1.json") : path.join(dir, "mainnet-test.json"));
const FIXTURE = path.join(HERE, "../../apps/helper/src/withdraw/fixtures/withdraw-request.json");
const SHA = /^[0-9a-f]{40}$/;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccount = (a) => typeof a === "string" && a.length >= 2 && a.length <= 64 && ACCOUNT.test(a);

// @noble/hashes from the helper's own dependencies (apps/ is outside Blindfill), as pool-evm-deploy.mjs loads it
const req = createRequire(new URL("../../apps/helper/package.json", import.meta.url));
const { keccak_256 } = req("@noble/hashes/sha3.js");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** An implicit account's own key: ed25519:<base58 of the 32 bytes its 64-hex id spells>. */
export function implicitKey(id) {
  const bytes = Buffer.from(id, "hex");
  let n = BigInt(`0x${id}`);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return `ed25519:${s}`;
}

/** The mainnet deploy record's vault and scope. */
export function loadRecord(file = recordFile()) {
  const r = JSON.parse(readFileSync(file, "utf8"));
  if (r.network !== "mainnet" || !isAccount(r.account_id) || typeof r.scope !== "string") throw new Error("the deploy record names no mainnet vault");
  return { account_id: r.account_id, scope: r.scope };
}

/** The probe body: the fixture's withdrawal, `fee_recipient` set, its context computed for `vault` under `scope`. */
export function probe(vault, scope, fixture = JSON.parse(readFileSync(FIXTURE, "utf8")).request, feeRecipient = vault) {
  const withdrawal = { ...fixture.withdrawal, fee_recipient: feeRecipient };
  const kc = (b) => keccak_256(b);
  const context = vaultContextOf(kc, vaultContextInput(vault, withdrawal), BigInt(scope));
  const public_signals = [...fixture.public_signals];
  public_signals[7] = context.toString();
  return { ...fixture, withdrawal, public_signals, token: USDC };
}

/** The asks, each with the answers that pass. */
export function asks(record) {
  const decoy = decoyFor(record);
  const decoyScope = vaultScopeOf((b) => keccak_256(b), decoy, USDC).toString();
  return [
    { name: "fee", method: "GET", path: `/v1/withdraw/fee?token=${USDC}`, want: [[200, null]] },
    { name: "the record's vault", method: "POST", path: "/v1/withdraw", body: JSON.stringify(probe(record.account_id, record.scope, undefined, record.account_id)), want: [[400, "bad_fee_recipient"]] },
    { name: "another vault", method: "POST", path: "/v1/withdraw", body: JSON.stringify(probe(decoy, decoyScope, undefined, record.account_id)), want: [[400, "bad_proof"]] },
  ];
}

async function rpc(url, method, params, fetchFn) {
  const r = await fetchFn(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "lc", method, params }), signal: AbortSignal.timeout(10_000) });
  const a = await r.json();
  if (a.error !== undefined) return { error: a.error?.cause?.name ?? a.error?.name ?? "error" };
  if (a.result === undefined) throw new Error(`${new URL(url).host} ${method}: no result`);
  return a.result;
}

/** The account at one final block both RPCs hold: each RPC's view_account and view_access_key_list, kept as answered. */
export async function readAccount(account, fetchFn = fetch, urls = PAIR) {
  const finals = await Promise.all(urls.map((u) => rpc(u, "block", { finality: "final" }, fetchFn)));
  const height = Math.min(...finals.map((f) => f.header.height));
  const at = [];
  for (const u of urls) {
    const b = await rpc(u, "block", { block_id: height }, fetchFn);
    const view = await rpc(u, "query", { request_type: "view_account", block_id: height, account_id: account }, fetchFn);
    const keys = await rpc(u, "query", { request_type: "view_access_key_list", block_id: height, account_id: account }, fetchFn);
    at.push({ rpc: new URL(u).host, block: { height: b.header?.height, hash: b.header?.hash }, view_account: view, keys });
  }
  return { account, height, finals: finals.map((f) => f.header.height), at };
}

/** One run: every ask sent, its status, headers and body kept; then the relayer account the fee answer names. */
export async function read(base = BASE, fetchFn = fetch, record = loadRecord()) {
  const reads = [];
  for (const a of asks(record)) {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${a.path}`, {
      method: a.method,
      redirect: "manual",
      headers: { origin: APP, ...(a.body !== undefined && { "content-type": "application/json" }) },
      ...(a.body !== undefined && { body: a.body }),
    });
    const headers = Object.fromEntries(["x-helper-commit", "access-control-allow-origin"].map((h) => [h, r.headers.get(h)]));
    reads.push({ asked: a.name, readAt: new Date().toISOString(), status: r.status, headers, body: (await r.text()).slice(0, 4096) });
  }
  let chain;
  const relayer = json(reads.find((x) => x.asked === "fee")?.body)?.relayer_account;
  if (!isAccount(relayer)) chain = { error: "the fee answer names no relayer account" };
  else {
    try {
      chain = await readAccount(relayer, fetchFn);
    } catch (e) {
      chain = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { base, record, reads, chain };
}

function json(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const U128 = /^(0|[1-9][0-9]{0,38})$/;

/** The check on one recorded run. */
export function judge(run, record = run.record) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(isAccount(record?.account_id) && record.account_id === run.record?.account_id && record.scope === run.record?.scope, `the deploy record's vault: ${record?.account_id} (scope ${String(record?.scope).slice(0, 12)}...)`);
  const decoy = decoyFor(record ?? {});
  say(isAccount(decoy) && decoy !== record?.account_id, `another vault ${decoy}: not the record's`);
  for (const a of asks(record)) {
    const r = run.reads.find((x) => x.asked === a.name);
    if (!r) {
      say(false, `${a.name}: not read`);
      continue;
    }
    const body = json(r.body);
    const code = body?.error?.code ?? null;
    const passed = a.want.some(([s, c]) => r.status === s && code === c);
    say(passed, `${a.name}: ${r.status} ${code ?? r.body.slice(0, 80)} (want ${a.want.map(([s, c]) => `${s}${c ? ` ${c}` : ""}`).join(" or ")})`);
    say(typeof r.headers["x-helper-commit"] === "string" && SHA.test(r.headers["x-helper-commit"]), `${a.name}: X-Helper-Commit ${r.headers["x-helper-commit"]}`);
    say(r.headers["access-control-allow-origin"] === APP, `${a.name}: APP_HOST echoed (${r.headers["access-control-allow-origin"]})`);
    say(Buffer.byteLength(r.body) <= 1024 && !/tx_hash/.test(r.body), `${a.name}: a body under 1 KB with no tx_hash`);
    // the probe's fee recipient is the vault: it reads bad_fee_recipient only while the helper's own is another account,
    // and a fee recipient that is the vault or intents.near is refused at every POST (check 8)
    if (a.name === "fee") say(isAccount(body?.relayer_account) && isAccount(body?.fee_recipient) && ![record.account_id, "intents.near"].includes(body.fee_recipient), `fee: relayer ${body?.relayer_account}, fee recipient ${body?.fee_recipient} (neither the vault nor intents.near)`);
  }
  const relayer = json(run.reads.find((x) => x.asked === "fee")?.body)?.relayer_account;
  const c = run.chain;
  if (!c || c.error !== undefined || !Array.isArray(c.at) || c.at.length !== 2) {
    say(false, `the relayer account on two mainnet RPCs: ${c?.error ?? "not read"}`);
    return { ok: false, lines };
  }
  say(c.account === relayer, `the relayer read is the fee answer's: ${c.account}`);
  say(new Set(c.at.map((x) => x.rpc)).size === 2 && c.at.every((x) => PAIR.some((u) => new URL(u).host === x.rpc)), `read on ${c.at.map((x) => x.rpc).join(" and ")}`);
  const [x, y] = c.at;
  say(x.block?.height === c.height && y.block?.height === c.height && typeof x.block?.hash === "string" && x.block.hash === y.block?.hash && Math.max(...c.finals) - c.height <= SPREAD, `one final block on both: ${c.height} ${x.block?.hash} (finals ${c.finals?.join(", ")})`);
  const exists = c.at.every((a) => a.view_account?.error === undefined && typeof a.view_account?.amount === "string" && U128.test(a.view_account.amount) && a.view_account.block_height === c.height);
  say(exists, `${c.account} exists on both at ${c.height}: ${c.at.map((a) => a.view_account?.error ?? a.view_account?.amount).join(", ")}`);
  if (!exists) return { ok: false, lines };
  const keysOf = (a) => (Array.isArray(a.keys?.keys) ? a.keys.keys.map((k) => `${k.public_key} ${typeof k.access_key?.permission === "string" ? k.access_key.permission : "FunctionCall"}`).sort() : null);
  const kx = keysOf(x);
  say(x.view_account.amount === y.view_account.amount && kx !== null && JSON.stringify(kx) === JSON.stringify(keysOf(y)), `the two RPCs agree: amount ${x.view_account.amount}, ${kx?.length ?? 0} keys`);
  const full = (kx ?? []).filter((k) => k.endsWith(" FullAccess")).map((k) => k.split(" ")[0]);
  say(full.length >= 1, `a full-access key: ${full.join(", ") || "none"}`);
  if (/^[0-9a-f]{64}$/.test(c.account)) say(full.includes(implicitKey(c.account)), `an implicit account holds the key its id names: ${implicitKey(c.account)}`);
  const amount = BigInt(x.view_account.amount);
  say(amount >= RELAYER_FLOOR_YOCTO, `holds ${amount} yocto, at least one withdrawal's floor ${RELAYER_FLOOR_YOCTO}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const record = loadRecord();
    const run = await read(opt("--base") ?? BASE, fetch, record);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run, record);
    for (const l of r.lines) console.log(l);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
