#!/usr/bin/env node
// Live check of card wallet-mainnet-relayer-pins: the signing page SIGN_HOST serves names the mainnet deposit carry and
// the mainnet withdrawal relayer the release pins, and each account is, on chain and at the helper, what the pin says.
// The pins are this checkout's (live.yml checks out the deployed commit): packages/wallet/src/deposit/bind.ts
// RELEASE_RELAYER.mainnet and packages/wallet/src/withdraw/relay.ts RELEASE_WITHDRAW_RELAYER.mainnet, read as text,
// since this file reaches no package code (the import check holds it). It passes only when:
//   - the bundle: SIGN_HOST's /app.js is the one index.html pins (its sha384) and carries each pin as its frozen
//     literal, and the throwaway relayer of helper-mainnet-vault-env's Mac test run appears nowhere in it;
//   - the deposit carry: the pin is a 64-hex implicit account, the helper's GET /v1/health names it (bind.mainnet), and
//     on both of mainnet's release RPCs (rpc.mainnet.fastnear.com, near.drpc.org) it exists and holds exactly one key,
//     full access, its own implicit key (the public key apps/helper/deploy/bind-relayer-key.sh printed);
//   - the withdrawal relayer: the pin's fee recipient is fees.unrlzd.near (owner 7 Nov 09:27Z); the helper's GET
//     /v1/withdraw/fee for mainnet USDC names the pin's relayer_account and fee_recipient byte for byte; the relayer is
//     a 64-hex implicit account holding exactly its own full-access key on both RPCs, and not the deposit carry; the
//     fee recipient is registered on mainnet USDC on both RPCs;
//   - neither pin is the throwaway relayer.
// A pin the release leaves null FAILs its part. It sends nothing and moves no money. scripts/ci/bundle-checks.mjs runs
// the bundle part on a pull request's own build (readBundle and judgeBundle, which read only the build).
// After: sign
//   node scripts/live-checks/wallet-mainnet-relayer-pins.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KEY = "wallet-mainnet-relayer-pins";
export const SIGN = "https://confidential.unrealized.trade";
export const HELPER = "https://ct-api.unrealized.trade";
/** Mainnet's release pair (the kit's NEAR_NETWORKS.mainnet: one FastNEAR URL and dRPC). */
export const PAIR = Object.freeze(["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]);
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** The owner's fee recipient for mainnet withdrawals (owner 7 Nov 09:27Z, card helper-mainnet-vault-env). */
export const FEE_RECIPIENT = "fees.unrlzd.near";
/** helper-mainnet-vault-env's Mac test run's relayer (its answers.json): never a pin. */
export const THROWAWAY = "9747fa11a4de38cecc3b9086239633a2164a81c8e7b03a39bd3f1522438717d6";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const BIND_FILE = "packages/wallet/src/deposit/bind.ts";
export const RELAY_FILE = "packages/wallet/src/withdraw/relay.ts";
const IMPLICIT = /^[0-9a-f]{64}$/;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const Q = "[`'\"]";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** An implicit account's own key: ed25519 and the base58 of the 32 bytes whose hex is the account. */
export function implicitKey(id) {
  let n = BigInt(`0x${id}`);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (let i = 0; i < id.length && id.slice(i, i + 2) === "00"; i += 2) s = `1${s}`;
  return `ed25519:${s}`;
}

const COMMENT = String.raw`(?:\s*\/\/[^\n]*)?`;
const DEPOSIT_PIN = new RegExp(String.raw`export const RELEASE_RELAYER\b[^=]*=\s*Object\.freeze\(\{\s*mainnet:\s*(?:null|"([^"\n]*)")\s*,`);
const WITHDRAW_PIN = new RegExp(
  String.raw`export const RELEASE_WITHDRAW_RELAYER\b[^=]*=\s*Object\.freeze\(\{\s*mainnet:\s*(?:null|Object\.freeze\(\{\s*relayer_account:\s*"([^"\n]*)",${COMMENT}\s*fee_recipient:\s*"([^"\n]*)",?${COMMENT}\s*\}\))\s*,`,
);
/** The release's two mainnet pins as this checkout's source writes them; a source this cannot read throws. */
export function pinsOf(bindText, relayText) {
  const d = DEPOSIT_PIN.exec(bindText);
  const w = WITHDRAW_PIN.exec(relayText);
  if (!d) throw new Error(`${BIND_FILE}: RELEASE_RELAYER's mainnet pin is not null or one string`);
  if (!w) throw new Error(`${RELAY_FILE}: RELEASE_WITHDRAW_RELAYER's mainnet pin is not null or one frozen { relayer_account, fee_recipient }`);
  return { deposit: d[1] ?? null, withdraw: w[1] === undefined ? null : { relayer_account: w[1], fee_recipient: w[2] } };
}
export const loadPins = (root = ROOT) => pinsOf(readFileSync(path.join(root, BIND_FILE), "utf8"), readFileSync(path.join(root, RELAY_FILE), "utf8"));

const TESTNET_WITHDRAW_PIN = new RegExp(
  String.raw`export const RELEASE_WITHDRAW_RELAYER\b[^=]*=\s*Object\.freeze\(\{[\s\S]*?\n\s*testnet:\s*(?:null|POOL_TESTNET\s*\?\s*Object\.freeze\(\{\s*relayer_account:\s*"([^"\n]*)",${COMMENT}\s*fee_recipient:\s*"([^"\n]*)",?${COMMENT}\s*\}\)\s*:\s*null)\s*,`,
);
/**
 * The release's withdrawal relayer on each network as relay.ts writes it: mainnet's pin (pinsOf), and testnet's pair,
 * which the testnet build carries (POOL_TESTNET) and SIGN_HOST's build folds to null. A source this cannot read throws.
 */
export function withdrawPinsOf(relayText) {
  const t = TESTNET_WITHDRAW_PIN.exec(relayText);
  if (!t) throw new Error(`${RELAY_FILE}: RELEASE_WITHDRAW_RELAYER's testnet pin is not null or one POOL_TESTNET-folded { relayer_account, fee_recipient }`);
  const mainnet = WITHDRAW_PIN.exec(relayText);
  if (!mainnet) throw new Error(`${RELAY_FILE}: RELEASE_WITHDRAW_RELAYER's mainnet pin is not null or one frozen { relayer_account, fee_recipient }`);
  return {
    mainnet: mainnet[1] === undefined ? null : { relayer_account: mainnet[1], fee_recipient: mainnet[2] },
    testnet: t[1] === undefined ? null : { relayer_account: t[1], fee_recipient: t[2] },
  };
}
export const loadWithdrawPins = (root = ROOT) => withdrawPinsOf(readFileSync(path.join(root, RELAY_FILE), "utf8"));

// ---------- the bundle ----------

/** What the check keeps of the bundle: the index, the served script's sha384, how many frozen copies of each pin it holds, and whether it names the throwaway. */
export function bundleFacts(index, js, pins) {
  const count = (re) => [...js.matchAll(re)].length;
  const deposit = pins.deposit === null ? 0 : count(new RegExp(String.raw`Object\.freeze\(\{\s*mainnet:\s*${Q}${esc(pins.deposit)}${Q}\s*,\s*testnet:\s*null\s*\}\)`, "g"));
  const w = pins.withdraw;
  const withdraw =
    w === null ? 0 : count(new RegExp(String.raw`mainnet:\s*Object\.freeze\(\{\s*relayer_account:\s*${Q}${esc(w.relayer_account)}${Q}\s*,\s*fee_recipient:\s*${Q}${esc(w.fee_recipient)}${Q}\s*\}\)`, "g"));
  return { pins, index, sha384: sha384(js), deposit, withdraw, throwaway: js.includes(THROWAWAY) };
}

/** SIGN_HOST's / and /app.js through `fetchFn` (scripts/ci/bundle-checks.mjs gives one that answers from a build). */
export async function readBundle(fetchFn = fetch, pins = loadPins()) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
    return r.text();
  };
  return bundleFacts(await get("/"), await get("/app.js"), pins);
}

export function judgeBundle(b) {
  const lines = [];
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(b?.index ?? "")?.[1];
  if (!pin) lines.push("BAD bundle: SIGN_HOST's index.html pins no /app.js");
  else if (pin !== b.sha384) lines.push("BAD bundle: SIGN_HOST's served /app.js is not the one index.html pins");
  if (b?.throwaway !== false) lines.push(`BAD bundle: the bundle names the throwaway relayer ${THROWAWAY}`);
  if (b?.pins?.deposit == null) lines.push("BAD deposit: the release names no mainnet deposit carry (bind.ts RELEASE_RELAYER.mainnet is null)");
  else if (b.deposit !== 1) lines.push(`BAD deposit: the bundle holds ${b.deposit} frozen copies of the deposit pin ${b.pins.deposit}, not one`);
  if (b?.pins?.withdraw == null) lines.push("BAD withdraw: the release names no mainnet withdrawal relayer (relay.ts RELEASE_WITHDRAW_RELAYER.mainnet is null)");
  else if (b.withdraw !== 1) lines.push(`BAD withdraw: the bundle holds ${b.withdraw} frozen copies of the withdrawal pin ${b.pins.withdraw.relayer_account}, not one`);
  return { ok: lines.length === 0, lines };
}

// ---------- the chain and the helper ----------

const query = async (fetchFn, url, params) => {
  try {
    const r = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: KEY, method: "query", params: { finality: "final", ...params } }),
      signal: AbortSignal.timeout(15_000),
    });
    return { url, status: r.status, json: await r.json() };
  } catch (e) {
    return { url, status: 0, error: String(e?.message ?? e) };
  }
};
const helperGet = async (fetchFn, p) => {
  try {
    const r = await fetchFn(`${HELPER}${p}`, { redirect: "error", headers: { origin: SIGN }, signal: AbortSignal.timeout(15_000) });
    const text = (await r.text()).slice(0, 4096);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: r.status, commit: r.headers.get("x-helper-commit"), body };
  } catch (e) {
    return { status: 0, error: String(e?.message ?? e) };
  }
};
const accountReads = async (fetchFn, id) => ({
  id,
  view_account: await Promise.all(PAIR.map((u) => query(fetchFn, u, { request_type: "view_account", account_id: id }))),
  view_access_key_list: await Promise.all(PAIR.map((u) => query(fetchFn, u, { request_type: "view_access_key_list", account_id: id }))),
});
const registrationReads = async (fetchFn, id) => ({
  id,
  storage_balance_of: await Promise.all(
    PAIR.map((u) => query(fetchFn, u, { request_type: "call_function", account_id: USDC, method_name: "storage_balance_of", args_base64: Buffer.from(JSON.stringify({ account_id: id })).toString("base64") })),
  ),
});

/** The helper's two answers and, for each pinned account, its reads on both RPCs (the fee recipient's USDC registration too). */
export async function readChain(pins, fetchFn = fetch) {
  const health = await helperGet(fetchFn, "/v1/health");
  const fee = await helperGet(fetchFn, `/v1/withdraw/fee?token=${USDC}`);
  return {
    pins,
    health: { status: health.status, commit: health.commit ?? null, bind: health.body?.bind ?? null, ...(health.error ? { error: health.error } : {}) },
    fee,
    deposit: pins.deposit === null ? null : await accountReads(fetchFn, pins.deposit),
    withdraw: pins.withdraw === null ? null : await accountReads(fetchFn, pins.withdraw.relayer_account),
    feeRecipient: pins.withdraw === null ? null : await registrationReads(fetchFn, pins.withdraw.fee_recipient),
  };
}

/** Problems with `a` as the reads of relayer `id`: on both RPCs it exists and holds one key, full access, its own. */
export function relayerProblems(id, a) {
  if (typeof id !== "string" || !IMPLICIT.test(id)) return [`${String(id)} is not a 64-hex implicit account`];
  if (id === THROWAWAY) return [`${id} is the throwaway relayer of helper-mainnet-vault-env's Mac test run`];
  if (a?.id !== id) return [`${id} was not read`];
  const p = [];
  for (const k of ["view_account", "view_access_key_list"]) if (JSON.stringify((a[k] ?? []).map((r) => r.url)) !== JSON.stringify(PAIR)) p.push(`${k} of ${id} was not read on ${PAIR.join(" and ")}`);
  for (const r of a.view_account ?? []) {
    const amount = r.status === 200 ? r.json?.result?.amount : undefined;
    if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) p.push(`${id} does not exist on ${r.url}`);
  }
  for (const r of a.view_access_key_list ?? []) {
    const keys = r.status === 200 ? r.json?.result?.keys : undefined;
    if (!Array.isArray(keys) || keys.length !== 1) p.push(`${id} holds ${Array.isArray(keys) ? keys.length : "no readable"} keys on ${r.url}, not one`);
    else if (keys[0]?.public_key !== implicitKey(id) || keys[0]?.access_key?.permission !== "FullAccess") p.push(`${id}'s one key on ${r.url} is not its own full-access key ${implicitKey(id)}`);
  }
  return p;
}
function registeredProblems(id, a) {
  if (a?.id !== id || JSON.stringify((a.storage_balance_of ?? []).map((r) => r.url)) !== JSON.stringify(PAIR)) return [`${id}'s USDC registration was not read on ${PAIR.join(" and ")}`];
  const p = [];
  for (const r of a.storage_balance_of) {
    const bytes = r.status === 200 ? r.json?.result?.result : undefined;
    let bal;
    try {
      bal = Array.isArray(bytes) ? JSON.parse(Buffer.from(bytes).toString()) : undefined;
    } catch {}
    if (bal === null || typeof bal?.total !== "string") p.push(`${id} is not registered on mainnet USDC on ${r.url}`);
  }
  return p;
}

export function judgeChain(c) {
  const lines = [];
  const pins = c?.pins ?? {};
  if (pins.deposit != null) {
    const bad = (m) => lines.push(`BAD deposit: ${m}`);
    if (c.health?.status !== 200) bad(`the helper's GET /v1/health answered ${c.health?.status}`);
    else if (c.health.bind?.mainnet !== pins.deposit) bad(`the helper names ${String(c.health.bind?.mainnet)} as its mainnet carry, not the pin ${pins.deposit}`);
    for (const m of relayerProblems(pins.deposit, c.deposit)) bad(m);
  }
  if (pins.withdraw != null) {
    const w = pins.withdraw;
    const bad = (m) => lines.push(`BAD withdraw: ${m}`);
    if (w.fee_recipient !== FEE_RECIPIENT) bad(`the pin's fee recipient is ${w.fee_recipient}, not ${FEE_RECIPIENT}`);
    if (c.fee?.status !== 200) bad(`the helper's GET /v1/withdraw/fee for mainnet USDC answered ${c.fee?.status}, naming no relayer`);
    else if (c.fee.body?.relayer_account !== w.relayer_account || c.fee.body?.fee_recipient !== w.fee_recipient)
      bad(`the helper names ${String(c.fee.body?.relayer_account)} and ${String(c.fee.body?.fee_recipient)}, not the pin's ${w.relayer_account} and ${w.fee_recipient}`);
    if (w.relayer_account === pins.deposit) bad("the withdrawal relayer is the deposit carry: two senders on one account");
    for (const m of relayerProblems(w.relayer_account, c.withdraw)) bad(m);
    for (const m of registeredProblems(w.fee_recipient, c.feeRecipient)) bad(m);
  }
  return lines;
}

export async function read(fetchFn = fetch) {
  const pins = loadPins();
  return { bundle: await readBundle(fetchFn, pins), chain: await readChain(pins, fetchFn) };
}

/** The verdict on one answer { bundle, chain }: the bundle's lines, then the chain's, for the same pins. */
export function judge(a) {
  const lines = [...judgeBundle(a?.bundle).lines];
  if (JSON.stringify(a?.bundle?.pins) !== JSON.stringify(a?.chain?.pins)) lines.push("BAD bundle: the bundle and the chain were read for different pins");
  lines.push(...judgeChain(a?.chain));
  return { ok: lines.length === 0, lines };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
