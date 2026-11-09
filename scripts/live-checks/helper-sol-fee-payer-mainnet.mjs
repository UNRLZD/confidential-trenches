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
// Every RPC read goes through provider-answer.mjs (card live-checks-provider-no-answer): an RPC that answers nothing
// usable (a failed fetch, an empty body, not JSON, a 429, a rate limit, read again once) is named on a `---` line and
// left out, never judged a wrong answer; with fewer than two RPCs answering the rent or the balance, what needs both is
// not judged and the run is INCONCLUSIVE (exit 3), a FAIL where any answer is wrong. A run keeps each RPC's last raw
// answer and the judge reads it by provider-answer.mjs's classify, so a replay judges exactly what the run read.
// Listed after the owner's SOL send to the fee payer (9 Nov 10:36Z: PASS, 10000000 lamports on both RPCs).
// Card sol-pools-mainnet-pin: the helper is also held to the signing page's pin, read from this commit's own signing
// page build (signBuilt(), packages/signpage/public/app.js; the helper's commit is this run's, X-Helper-Commit) with
// signpage-pool-pins.mjs's mainnetPin (SOL_POOLS.mainnet's own literal, matched once, its program resolved to the
// frozen {program, table}): the helper's fee_payer must be that pin's fee payer and its program the pin's program,
// since the device's bind refuses any other answer and a helper on another key refuses every mainnet release. The pin
// SIGN_HOST serves is held to the same helper answer by signpage-pool-pins (After: sign). So neither host's check reads
// the other before it is deployed (review P3-3): the helper deploys first (this check and sol-pools-mainnet-pin pass on
// it alone), then SIGN_HOST (signpage-pool-pins and pool-restore-wired read the helper already serving the pin's key
// and the mark routes). A helper redeploy on another key fails here; a sign deploy with another pin fails there.
// After: helper
//   node scripts/live-checks/helper-sol-fee-payer-mainnet.mjs [--base <url>] [--record <file>] [--rpcs <a>,<b>]
//     PASS exit 0, FAIL exit 1, error exit 2 (the build failed included), INCONCLUSIVE exit 3
//   (--rpcs replaces RPCS for a local recording only)
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { solanaPoolAccount, solanaPoolFee, solanaRentOf } from "../../packages/kit/src/index.ts";
import { solanaFeePayerLowMark } from "../../apps/helper/src/pool/solana.ts";
import { classify, EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";
import { signBuilt } from "../signpage-built.mjs";
import { mainnetPin } from "./signpage-pool-pins.mjs";

export { EXIT };

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

/** One RPC read through provider-answer.mjs's rpcAnswer (read again once on a no-answer), kept as its last raw answer:
 *  { url, status, body }, status 0 with the reason as the body where the fetch itself failed. */
async function rpc(url, method, params, fetchFn) {
  let last;
  const keep = async (u, init) => {
    try {
      const r = await fetchFn(u, init);
      const body = await r.text().catch(() => "");
      last = { url, status: r.status, body: body.slice(0, 4096) };
      return new Response(body, { status: r.status });
    } catch (e) {
      last = { url, status: 0, body: String(e?.cause?.code ?? e?.name ?? e?.message ?? e).slice(0, 300) };
      throw e;
    }
  };
  await rpcAnswer(url, method, params, { fetchFn: keep, timeoutMs: 15_000 });
  return last;
}

/** One recorded RPC answer read by provider-answer.mjs's rule: { result } | { error } | { noAnswer } (named with its host). */
export function answerOf(r) {
  let host;
  try {
    host = new URL(r?.url).host;
  } catch {
    return { noAnswer: `${show(r?.url)}: no answer (not a URL)` };
  }
  if (r?.status === 0) return { noAnswer: `${host}: no answer (${r.body})` };
  return classify(host, r?.status, r?.body);
}

/** Where the pin is read: this commit's signing page build. */
export const BUILT = "packages/signpage/public/app.js (this commit's signing page build)";

/** The signing page's mainnet pin: { url, status, pin } with pin mainnetPin's answer on `file`, by default this
 *  commit's build (signBuilt() first, so it is the build of the sources beside this check), named by `as`. */
export function readPin(file = path.join(signBuilt(), "public", "app.js"), as = BUILT) {
  return { url: as, status: 200, pin: mainnetPin(readFileSync(file, "utf8")) };
}

/** One run, every answer kept as read: the fee answer, the rent on both RPCs, then the named fee payer's balance on both,
 *  and the signing page's pin (`sign`, readPin's). */
export async function read(base = BASE, fetchFn = fetch, record = loadRecord(), rpcs = RPCS, sign = () => readPin()) {
  const url = `${base.replace(/\/$/, "")}/v1/pool/fee?cluster=mainnet&pool=${record.pool}`;
  const r = await fetchFn(url, { redirect: "manual", headers: { origin: APP }, signal: AbortSignal.timeout(15_000) });
  const headers = Object.fromEntries(["x-helper-commit", "access-control-allow-origin"].map((h) => [h, r.headers.get(h)]));
  const fee = { status: r.status, headers, body: (await r.text()).slice(0, 4096) };
  const rent = await Promise.all(rpcs.map((u) => rpc(u, "getAccountInfo", [RENT_SYSVAR, { encoding: "base64", commitment: "confirmed" }], fetchFn)));
  const payer = json(fee.body)?.fee_payer;
  const balance = typeof payer === "string" && B58.test(payer) ? await Promise.all(rpcs.map((u) => rpc(u, "getBalance", [payer, { commitment: "confirmed" }], fetchFn))) : [];
  return { base, record, rpcs: [...rpcs], readAt: new Date().toISOString(), fee, rent, balance, sign: await sign() };
}

/** The rent one getAccountInfo answer (answerOf's) holds, or null. */
function rentOf(a) {
  const v = a?.result?.value;
  if (typeof v?.owner !== "string" || !Array.isArray(v?.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string") return null;
  try {
    return solanaRentOf({ owner: v.owner, data: new Uint8Array(Buffer.from(v.data[0], "base64")) });
  } catch {
    return null;
  }
}

/** The lamports one getBalance answer (answerOf's) holds, or null. */
function lamportsOf(a) {
  const v = a?.result?.value;
  return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
}

/** The check on one recorded run, against the record it was read for. */
export function judge(run, record = run.record) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  // a no-answer is named and left out; what needs it is not judged, so the run is INCONCLUSIVE at best
  let quiet = false;
  const unsaid = (text) => {
    quiet = true;
    lines.push(`--- ${text}`);
  };
  const done = () => {
    const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
    return { verdict, ok: verdict === "PASS", lines };
  };
  let pool = null;
  try {
    pool = solanaPoolAccount(record?.program);
  } catch {}
  say(pool !== null && pool === record?.pool && run.record?.pool === record.pool && run.record?.program === record.program, `the deploy record: program ${show(record?.program)}, pool ${show(record?.pool)} (the program's pool account: ${show(pool)})`);
  const rpcs = run.rpcs ?? [];
  const pairOk = rpcs.length === 2 && rpcs[0] !== rpcs[1];
  const sameUrls = (reads) => reads?.length === 2 && reads[0].url === rpcs[0] && reads[1].url === rpcs[1];
  const rentReads = (run.rent ?? []).map(answerOf);
  const rentQuiet = pairOk && sameUrls(run.rent) ? rentReads.filter((a) => a.noAnswer !== undefined) : [];
  for (const a of rentQuiet) unsaid(`the Rent sysvar: no answer: ${a.noAnswer}`);
  const [ra, rb] = rentReads.map(rentOf);
  const rent = pairOk && sameUrls(run.rent) && ra && rb && ra.lamportsPerByte === rb.lamportsPerByte && ra.factor === rb.factor ? ra : null;
  const kit = rent ? solanaPoolFee(rent) : null;
  const mark = rent ? solanaFeePayerLowMark(rent) : null;
  // a wrong answer beside a no-answer is still wrong: an RPC that answered no rent, or an error, is BAD
  const rentWrong = rentQuiet.length > 0 && rentReads.some((a) => a.noAnswer === undefined && rentOf(a) === null);
  if (rentQuiet.length === 0 || rentWrong) say(rent !== null, `the Rent sysvar on ${show(rpcs)}: ${rent ? `${rent.lamportsPerByte} a byte, factor ${rent.factor}; the kit's fee ${kit}, the fee payer's low mark ${mark}` : "not two agreeing reads of two different RPCs"}`);
  else unsaid(`the Rent sysvar on ${show(rpcs)}: ${2 - rentQuiet.length} of 2 RPCs answered, so the kit's fee and the fee payer's low mark are not judged`);
  const f = run.fee ?? {};
  say(f.status === 200, `GET /v1/pool/fee?cluster=mainnet&pool=${record?.pool}: ${f.status}${f.status === 404 ? " (the helper carries no mainnet pool: POOL_SOLANA_*_MAINNET not set; run apps/helper/deploy/sol-fee-payer-key.sh, then redeploy)" : ""} (want 200)`);
  say(f.headers?.["access-control-allow-origin"] === APP, `APP_HOST echoed (${f.headers?.["access-control-allow-origin"]})`);
  say(SHA.test(f.headers?.["x-helper-commit"] ?? ""), `X-Helper-Commit ${f.headers?.["x-helper-commit"]}`);
  if (f.status !== 200) return done();
  const b = json(f.body);
  const keys = b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b) : [];
  say(keys.length === FIELDS.length && FIELDS.every((k) => keys.includes(k)), `fields: ${show(keys)}`);
  say(b?.chain === "solana" && b?.cluster === "mainnet", `chain ${show(b?.chain)}, cluster ${show(b?.cluster)}`);
  say(b?.program === record?.program && b?.pool === record?.pool, `program ${show(b?.program)}, pool ${show(b?.pool)}: the record's`);
  say(b?.step === "100000", `step ${show(b?.step)}`);
  if (rent === null && rentQuiet.length > 0) unsaid(`fee ${show(b?.fee)}: not judged, no two RPCs answered the rent`);
  else say(kit !== null && b?.fee === kit.toString(), `fee ${show(b?.fee)} is the kit's solanaPoolFee for the rent read, ${kit}`);
  const payer = b?.fee_payer;
  const payerOk = typeof payer === "string" && B58.test(payer) && payer !== record?.pool && payer !== record?.program;
  say(payerOk, `the fee payer ${show(payer)}`);
  // the signing page's pin: the device binds this fee payer and program, and refuses a helper answer of any other
  const s = run.sign ?? {};
  const pin = s.status === 200 && typeof s.pin?.feePayer === "string" && typeof s.pin?.program === "string" ? s.pin : null;
  say(pin !== null, `the signing page's pin (${show(s.url)}): ${pin ? `program ${pin.program}, fee payer ${pin.feePayer}` : run.sign === undefined ? "not read" : (s.pin?.error ?? `HTTP ${s.status}`)}`);
  say(pin !== null && payer === pin.feePayer, `the helper's fee payer ${show(payer)} is the pin's${pin && payer !== pin.feePayer ? `: the pin is ${pin.feePayer}` : ""}`);
  say(pin !== null && b?.program === pin.program, `the helper's program ${show(b?.program)} is the pin's${pin && b?.program !== pin.program ? `: the pin is ${pin.program}` : ""}`);
  if (!payerOk) return done();
  const bal = run.balance ?? [];
  say(sameUrls(bal), `its balance read on both RPCs (${bal.length})`);
  for (const r of bal) {
    const a = answerOf(r);
    if (a.noAnswer !== undefined) {
      unsaid(`[${r.url}] ${payer}'s balance: no answer: ${a.noAnswer}`);
      continue;
    }
    const l = lamportsOf(a);
    if (l !== null && mark === null && rentQuiet.length > 0) {
      unsaid(`[${r.url}] ${payer} holds ${l} lamports: not judged, no low mark without two RPCs' rent`);
      continue;
    }
    say(l !== null && mark !== null && l >= mark, `[${r.url}] ${payer} holds ${l === null ? `no balance read (${r.status}${a.error !== undefined ? ` ${JSON.stringify(a.error).slice(0, 80)}` : ""})` : `${l} lamports`}, the low mark ${mark}${l !== null && mark !== null && l < mark ? ": fund it (sol-fee-payer-key.sh printed the amount)" : ""}`);
  }
  return done();
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
    console.log(`live-check ${KEY}: ${r.verdict} (${run.base})`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
