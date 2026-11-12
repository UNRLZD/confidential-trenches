#!/usr/bin/env node
// Live check of card buy-spends-several-pieces, the helper's part: HELPER_HOST's Solana routes (POST /v1/rpc/solana,
// the mainnet page's second provider, and /v1/rpc/solana-devnet, the testnet page's) forward getBlock as the found W's
// header read and only as that (apps/helper/src/rpc/rpc.ts blockHeaderAllowed). On each route, with Origin SIGN_HOST:
//   - getSlot at finalized answers a whole slot;
//   - getBlock [that slot, the kit's HELPER_SOLANA_BLOCK_HEADER], the very params the page sends (packages/signpage/
//     src/pool-sell.ts foundQuiet), answers 200 with a result that holds a whole blockHeight and no transactions,
//     signatures or rewards, with a full-sha X-Helper-Commit and SIGN_HOST in Access-Control-Allow-Origin. A helper
//     that refuses it leaves a found W's sweep held on the page for good (the rule reads both RPCs);
//   - getBlock with transactionDetails "full" (the rest as the header read) answers the helper's own refusal, 400
//     method_not_allowed, before any provider call: a block's transactions would spend the keyed provider's quota.
// Each read goes through provider-answer.mjs rpcAnswer: a no-answer (no HTTP answer, a 429, a 5xx, a rate limit) is
// INCONCLUSIVE (exit 3), never FAIL or PASS.
// After: helper
//   node scripts/live-checks/buy-spends-several-pieces-helper.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, so the check's test
//   can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { HELPER_SOLANA_BLOCK_HEADER } from "../../packages/kit/src/index.ts";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "buy-spends-several-pieces-helper";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const ROUTES = ["solana", "solana-devnet"];
const SHA = /^[0-9a-f]{40}$/;
/** The three reads on a route, in order: the finalized slot, the page's header read of it, the full read of it. */
export const READS = {
  slot: { method: "getSlot", params: () => [{ commitment: "finalized" }] },
  header: { method: "getBlock", params: (slot) => [slot, HELPER_SOLANA_BLOCK_HEADER] },
  full: { method: "getBlock", params: (slot) => [slot, { ...HELPER_SOLANA_BLOCK_HEADER, transactionDetails: "full" }] },
};

/** An answer as recorded: a block as its sorted keys and its blockHeight, any other result as itself; an error's code
 *  and message (cut); a no-answer's words. */
export function shrink(a) {
  if (a.noAnswer !== undefined) return { noAnswer: a.noAnswer };
  if (a.error !== undefined) return { error: { code: a.error?.code ?? null, message: String(a.error?.message ?? "").slice(0, 120) } };
  const v = a.result;
  return { result: v !== null && typeof v === "object" && !Array.isArray(v) ? { keys: Object.keys(v).sort(), blockHeight: v.blockHeight } : v };
}

/** The check on one recorded run: { reads: [{ route, read, status, acao, commit, answer }] }. */
export function judge({ reads }) {
  const lines = [];
  let bad = false;
  let quiet = false;
  const say = (ok, text) => {
    lines.push(`${ok ? "ok " : "BAD"} ${text}`);
    if (!ok) bad = true;
  };
  const no = (text) => {
    lines.push(`--  ${text}`);
    quiet = true;
  };
  for (const route of ROUTES) {
    const tag = `[${route}]`;
    const at = (k) => reads.find((x) => x.route === route && x.read === k);
    const s = at("slot");
    if (s?.answer?.noAnswer !== undefined) {
      no(`${tag} finalized slot: no answer (${s.answer.noAnswer})`);
      continue;
    }
    const slot = s?.answer?.result;
    if (!Number.isSafeInteger(slot) || slot < 0) {
      say(false, `${tag} finalized slot: ${s ? JSON.stringify(s.answer).slice(0, 160) : "no read"}`);
      continue;
    }
    say(true, `${tag} finalized slot ${slot}`);
    const h = at("header");
    if (h?.answer?.noAnswer !== undefined) no(`${tag} header read: no answer (${h.answer.noAnswer})`);
    else if (!h) say(false, `${tag} header read: no read`);
    else {
      const r = h.answer.result;
      const ok = h.status === 200 && r !== null && typeof r === "object" && Number.isSafeInteger(r.blockHeight) && Array.isArray(r.keys) && !r.keys.some((k) => k === "transactions" || k === "signatures" || k === "rewards");
      say(ok, `${tag} header read answered: ${h.status} ${JSON.stringify(h.answer).slice(0, 200)}`);
      say(SHA.test(h.commit ?? ""), `${tag} X-Helper-Commit: ${h.commit ?? "none"}`);
      say(h.acao === SIGN, `${tag} allow-origin: ${h.acao ?? "none"}`);
    }
    const f = at("full");
    if (f?.answer?.noAnswer !== undefined) no(`${tag} full read: no answer (${f.answer.noAnswer})`);
    else if (!f) say(false, `${tag} full read: no read`);
    else say(f.status === 400 && f.answer.error?.code === "method_not_allowed", `${tag} full read refused: ${f.status} ${JSON.stringify(f.answer).slice(0, 160)}`);
  }
  if (lines.length === 0) say(false, "no read");
  const verdict = verdictOf(bad, quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

export async function read(base = BASE, fetchFn = fetch) {
  const reads = [];
  for (const route of ROUTES) {
    const url = `${base.replace(/\/$/, "")}/v1/rpc/${route}`;
    let slot;
    for (const k of ["slot", "header", "full"]) {
      if (k !== "slot" && !Number.isSafeInteger(slot)) break;
      const t0 = performance.now();
      const a = await rpcAnswer(url, READS[k].method, READS[k].params(slot), { fetchFn, headers: { origin: SIGN }, redirect: "manual", keep: ["x-helper-commit"] });
      if (k === "slot") slot = a.result;
      reads.push({ route, read: k, ms: Math.round(performance.now() - t0), status: a.status ?? null, acao: a.acao ?? null, commit: a.kept?.["x-helper-commit"] ?? null, answer: shrink(a) });
    }
  }
  return { base, at: new Date().toISOString(), reads };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`times (ms): ${run.reads.map((r) => `${r.route} ${r.read} ${r.ms}`).join(", ")}`);
    console.log(`live-check ${KEY}: ${verdict} (${run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
