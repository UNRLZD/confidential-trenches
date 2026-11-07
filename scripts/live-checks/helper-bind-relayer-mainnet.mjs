#!/usr/bin/env node
// Live check of card helper-bind-relayer-mainnet: HELPER_HOST carries mainnet deposits (POST /v1/bind) for the vault of
// the mainnet deploy record, contracts/vault/deployments/mainnet-v1.json, with its own gas account, the one
// apps/helper/deploy/bind-relayer-key.sh made on the server. It reads GET /v1/health with Origin APP_HOST: 200, a
// full-sha X-Helper-Commit, APP_HOST echoed, a JSON body within 1 KB whose `bind.mainnet` names the record's vault and a
// gas account (a 64-hex implicit account, as the key step makes it, or a NEAR account id). Funded or not: the account is
// printed so it can be funded, and the carry answers relayer_low until it is. It sends nothing and moves no money.
// Before mainnet-v1.json exists there is no mainnet vault to carry for: scripts/ci/helper-live-checks.mjs lists the check
// not-applicable then, and run by hand it stops with exit 2.
//   node scripts/live-checks/helper-bind-relayer-mainnet.mjs [--base <url>] [--record <file>]   PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KEY = "helper-bind-relayer-mainnet";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The mainnet vault's deploy record: the bind carry never falls back to mainnet-test.json (bind-relayer-key.sh). */
export const RECORD = path.join(HERE, "../../contracts/vault/deployments/mainnet-v1.json");
const SHA = /^[0-9a-f]{40}$/;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccount = (a) => typeof a === "string" && a.length >= 2 && a.length <= 64 && ACCOUNT.test(a);

/** The record's vault, or an error when the mainnet vault is not deployed. */
export function loadRecord(file = RECORD) {
  if (!existsSync(file)) throw new Error(`no ${path.relative(path.join(HERE, "../.."), file)}: the mainnet vault is not deployed, so there is no mainnet deposit carry to check`);
  const r = JSON.parse(readFileSync(file, "utf8"));
  if (r.network !== "mainnet" || !isAccount(r.account_id)) throw new Error("the deploy record names no mainnet vault");
  return { account_id: r.account_id };
}

/** One run: the health answer's status, headers and body, kept as read. */
export async function read(base = BASE, fetchFn = fetch, record = loadRecord()) {
  const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/health`, { redirect: "manual", headers: { origin: APP }, signal: AbortSignal.timeout(15_000) });
  const headers = Object.fromEntries(["x-helper-commit", "access-control-allow-origin"].map((h) => [h, r.headers.get(h)]));
  return { base, record, readAt: new Date().toISOString(), status: r.status, headers, body: (await r.text()).slice(0, 4096) };
}

function json(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** The check on one recorded run, against the record it was read for. */
export function judge(run, record = run.record) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(isAccount(record?.account_id) && record.account_id === run.record?.account_id, `the deploy record's vault: ${record?.account_id}`);
  say(run.status === 200, `GET /v1/health: ${run.status} (want 200)`);
  say(typeof run.headers?.["x-helper-commit"] === "string" && SHA.test(run.headers["x-helper-commit"]), `X-Helper-Commit ${run.headers?.["x-helper-commit"]}`);
  say(run.headers?.["access-control-allow-origin"] === APP, `APP_HOST echoed (${run.headers?.["access-control-allow-origin"]})`);
  const body = json(run.body);
  say(body?.ok === true && Buffer.byteLength(run.body ?? "") <= 1024, `a health body within 1 KB (${Buffer.byteLength(run.body ?? "")} bytes)`);
  const bind = body?.bind;
  say(typeof bind === "object" && bind !== null && !Array.isArray(bind), `health lists the bind carries: ${bind === undefined ? "no bind field (a helper before this card)" : JSON.stringify(bind)}`);
  const m = bind?.mainnet;
  say(m !== undefined, `mainnet deposits carried: ${m === undefined ? "no (BIND_*_MAINNET not set: run apps/helper/deploy/bind-relayer-key.sh, then redeploy)" : "yes"}`);
  if (m === undefined) return { ok: false, lines };
  say(m?.vault === record?.account_id, `the mainnet carry's vault ${m?.vault} is the record's ${record?.account_id}`);
  say(isAccount(m?.account) && m.account !== record?.account_id && m.account !== "intents.near", `the mainnet gas account: ${m?.account}${/^[0-9a-f]{64}$/.test(m?.account ?? "") ? " (implicit: fund it with a NEAR transfer to create it)" : ""}`);
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
