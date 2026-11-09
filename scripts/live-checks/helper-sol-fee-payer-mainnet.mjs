#!/usr/bin/env node
// Live check of card helper-sol-fee-payer-mainnet: HELPER_HOST carries the mainnet Solana pool of the pool's deploy
// record (contracts/pool-solana/deployments/mainnet.json: its program_id and that program's pool account, the kit's
// solanaPoolAccount) from a fee payer of its own that holds enough SOL to carry the worst release. With Origin APP_HOST
// it reads GET /v1/pool/fee?cluster=mainnet&pool=<the record's pool>: 200, APP_HOST echoed, a full-sha X-Helper-Commit,
// chain solana, cluster mainnet, the record's program and pool, a fee payer address, the step, and a fee exactly the
// kit's solanaPoolFee for the Rent sysvar read on two keyless mainnet RPCs of two operators (RPCS; both must agree, M362
// (2)). Then the fee payer the answer names, on the same two RPCs at confirmed: each balance at least the helper's
// solanaFeePayerLowMark at that rent (apps/helper/src/pool/solana.ts: its rent floor, one worst release fronted, the
// whole priority budget), so the next release, a page-opening one included, is carried. It sends nothing and moves no
// money.
// Red until the fee payer exists and is funded: apps/helper/deploy/sol-fee-payer-key.sh on the server, redeploy.sh, then
// the owner's SOL send to the printed address (today the helper answers this pool 404 not_found). So it is in no host's
// list yet: listed, it would turn every helper deploy red, the key step's own two redeploys included, and a red check
// undoes the deploy. It is listed `After: helper` in a later commit on this card, once the send has landed, with a good
// answer recorded on mainnet. Until then it is run by hand.
// Runs: pending helper-sol-fee-payer-mainnet, it fails on every helper until the owner's SOL send to the fee payer lands, so a list would undo each deploy; it joins the helper's runs with a mainnet good answer once the send has landed
//   node scripts/live-checks/helper-sol-fee-payer-mainnet.mjs [--base <url>] [--record <file>] [--rpcs <a>,<b>]   PASS exit 0, FAIL exit 1, error exit 2
//   (--rpcs replaces RPCS for a local recording only)
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { solanaPoolAccount, solanaPoolFee, solanaRentOf } from "../../packages/kit/src/index.ts";
import { solanaFeePayerLowMark } from "../../apps/helper/src/pool/solana.ts";

export const KEY = "helper-sol-fee-payer-mainnet";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Two keyless mainnet RPCs of two operators (helper-pool-senders RENT_RPCS.mainnet, the helper's TRADES_RPCS). */
export const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RECORD = path.join(HERE, "../../contracts/pool-solana/deployments/mainnet.json");
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
const FIELDS = ["chain", "cluster", "program", "pool", "fee_payer", "epoch_ms", "epoch_start_ms", "fee", "step"];
const SHA = /^[0-9a-f]{40}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The record's program and pool. */
export function loadRecord(file = RECORD) {
  const r = JSON.parse(readFileSync(file, "utf8"));
  if (r.cluster !== "mainnet" || !B58.test(r.program_id ?? "") || !B58.test(r.pool ?? "")) throw new Error("the deploy record names no mainnet pool program");
  return { program: r.program_id, pool: r.pool };
}

async function rpc(url, method, params, fetchFn) {
  try {
    const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
    return { url, status: r.status, body: (await r.text()).slice(0, 4096) };
  } catch (e) {
    return { url, status: 0, body: String(e instanceof Error ? e.message : e).slice(0, 300) };
  }
}

/** One run, every answer kept as read: the fee answer, the rent on both RPCs, then the named fee payer's balance on both. */
export async function read(base = BASE, fetchFn = fetch, record = loadRecord(), rpcs = RPCS) {
  const url = `${base.replace(/\/$/, "")}/v1/pool/fee?cluster=mainnet&pool=${record.pool}`;
  const r = await fetchFn(url, { redirect: "manual", headers: { origin: APP }, signal: AbortSignal.timeout(15_000) });
  const headers = Object.fromEntries(["x-helper-commit", "access-control-allow-origin"].map((h) => [h, r.headers.get(h)]));
  const fee = { status: r.status, headers, body: (await r.text()).slice(0, 4096) };
  const rent = await Promise.all(rpcs.map((u) => rpc(u, "getAccountInfo", [RENT_SYSVAR, { encoding: "base64", commitment: "confirmed" }], fetchFn)));
  const payer = json(fee.body)?.fee_payer;
  const balance = typeof payer === "string" && B58.test(payer) ? await Promise.all(rpcs.map((u) => rpc(u, "getBalance", [payer, { commitment: "confirmed" }], fetchFn))) : [];
  return { base, record, rpcs: [...rpcs], readAt: new Date().toISOString(), fee, rent, balance };
}

/** The rent one recorded getAccountInfo answer holds, or null. */
function rentOf(r) {
  const v = json(r?.body ?? "")?.result?.value;
  if (r?.status !== 200 || typeof v?.owner !== "string" || !Array.isArray(v?.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string") return null;
  try {
    return solanaRentOf({ owner: v.owner, data: new Uint8Array(Buffer.from(v.data[0], "base64")) });
  } catch {
    return null;
  }
}

/** The lamports one recorded getBalance answer holds, or null. */
function lamportsOf(r) {
  const v = json(r?.body ?? "")?.result?.value;
  return r?.status === 200 && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
}

/** The check on one recorded run, against the record it was read for. */
export function judge(run, record = run.record) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let pool = null;
  try {
    pool = solanaPoolAccount(record?.program);
  } catch {}
  say(pool !== null && pool === record?.pool && run.record?.pool === record.pool && run.record?.program === record.program, `the deploy record: program ${show(record?.program)}, pool ${show(record?.pool)} (the program's pool account: ${show(pool)})`);
  const rpcs = run.rpcs ?? [];
  const pairOk = rpcs.length === 2 && rpcs[0] !== rpcs[1];
  const sameUrls = (reads) => reads?.length === 2 && reads[0].url === rpcs[0] && reads[1].url === rpcs[1];
  const [ra, rb] = (run.rent ?? []).map(rentOf);
  const rent = pairOk && sameUrls(run.rent) && ra && rb && ra.lamportsPerByte === rb.lamportsPerByte && ra.factor === rb.factor ? ra : null;
  const kit = rent ? solanaPoolFee(rent) : null;
  const mark = rent ? solanaFeePayerLowMark(rent) : null;
  say(rent !== null, `the Rent sysvar on ${show(rpcs)}: ${rent ? `${rent.lamportsPerByte} a byte, factor ${rent.factor}; the kit's fee ${kit}, the fee payer's low mark ${mark}` : "not two agreeing reads of two different RPCs"}`);
  const f = run.fee ?? {};
  say(f.status === 200, `GET /v1/pool/fee?cluster=mainnet&pool=${record?.pool}: ${f.status}${f.status === 404 ? " (the helper carries no mainnet pool: POOL_SOLANA_*_MAINNET not set; run apps/helper/deploy/sol-fee-payer-key.sh, then redeploy)" : ""} (want 200)`);
  say(f.headers?.["access-control-allow-origin"] === APP, `APP_HOST echoed (${f.headers?.["access-control-allow-origin"]})`);
  say(SHA.test(f.headers?.["x-helper-commit"] ?? ""), `X-Helper-Commit ${f.headers?.["x-helper-commit"]}`);
  if (f.status !== 200) return { ok: false, lines };
  const b = json(f.body);
  const keys = b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b) : [];
  say(keys.length === FIELDS.length && FIELDS.every((k) => keys.includes(k)), `fields: ${show(keys)}`);
  say(b?.chain === "solana" && b?.cluster === "mainnet", `chain ${show(b?.chain)}, cluster ${show(b?.cluster)}`);
  say(b?.program === record?.program && b?.pool === record?.pool, `program ${show(b?.program)}, pool ${show(b?.pool)}: the record's`);
  say(b?.step === "100000", `step ${show(b?.step)}`);
  say(kit !== null && b?.fee === kit.toString(), `fee ${show(b?.fee)} is the kit's solanaPoolFee for the rent read, ${kit}`);
  const payer = b?.fee_payer;
  const payerOk = typeof payer === "string" && B58.test(payer) && payer !== record?.pool && payer !== record?.program;
  say(payerOk, `the fee payer ${show(payer)}`);
  if (!payerOk) return { ok: false, lines };
  const bal = run.balance ?? [];
  say(sameUrls(bal), `its balance read on both RPCs (${bal.length})`);
  for (const r of bal) {
    const l = lamportsOf(r);
    say(l !== null && mark !== null && l >= mark, `[${r.url}] ${payer} holds ${l === null ? `no balance read (${r.status})` : `${l} lamports`}, the low mark ${mark}${l !== null && mark !== null && l < mark ? ": fund it (sol-fee-payer-key.sh printed the amount)" : ""}`);
  }
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
    const rpcs = opt("--rpcs") ? opt("--rpcs").split(",") : RPCS;
    const run = await read(opt("--base") ?? BASE, fetch, record, rpcs);
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
