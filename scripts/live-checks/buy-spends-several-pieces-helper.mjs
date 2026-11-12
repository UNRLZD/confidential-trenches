#!/usr/bin/env node
// Live check of card buy-spends-several-pieces, the helper's part: HELPER_HOST's Solana routes (POST /v1/rpc/solana,
// the mainnet page's second provider, and /v1/rpc/solana-devnet, the testnet page's) forward getBlock as the found W's
// header read and only as that (apps/helper/src/rpc/rpc.ts blockHeaderAllowed). On each route, with Origin SIGN_HOST:
//   - getSlot at finalized answers a whole slot;
//   - getBlock [that slot, the kit's HELPER_SOLANA_BLOCK_HEADER], the very params the page sends (packages/signpage/
//     src/pool-sell.ts foundQuiet), answers 200 with a JSON-RPC result for its own id that holds a whole blockHeight and
//     no transactions, signatures or rewards, with a full-sha X-Helper-Commit and SIGN_HOST in Access-Control-Allow-Origin.
//     A helper that refuses it leaves a found W's sweep held on the page for good (the rule reads both RPCs);
//   - getBlock with transactionDetails "full" (the rest as the header read) answers the helper's own refusal, 400
//     method_not_allowed, before any provider call: a block's transactions would spend the keyed provider's quota.
// After: helper
//   node scripts/live-checks/buy-spends-several-pieces-helper.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { HELPER_SOLANA_BLOCK_HEADER } from "../../packages/kit/src/index.ts";

const KEY = "buy-spends-several-pieces-helper";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const ROUTES = ["solana", "solana-devnet"];
const SHA = /^[0-9a-f]{40}$/;
/** The three reads on a route, in order: the finalized slot, the page's header read of it, the full read of it. */
export const paramsOf = {
  slot: () => [{ commitment: "finalized" }],
  header: (slot) => [slot, HELPER_SOLANA_BLOCK_HEADER],
  full: (slot) => [slot, { ...HELPER_SOLANA_BLOCK_HEADER, transactionDetails: "full" }],
};

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};
/** A body as recorded: a JSON-RPC answer cut to its id and its result (a block as its sorted keys and its blockHeight,
 *  a number as itself) or its error's code and message; anything else its first 300 characters. A cut body cuts to
 *  itself, so a replayed run reads as the recorded one. */
export function cut(text) {
  const b = json(text);
  if (b?.jsonrpc !== "2.0") return text.slice(0, 300);
  const out = { jsonrpc: "2.0", id: b.id };
  const v = b.result;
  if (v !== undefined) out.result = v !== null && typeof v === "object" && !Array.isArray(v) ? (Array.isArray(v.keys) && Object.keys(v).length <= 2 ? v : { keys: Object.keys(v).sort(), blockHeight: v.blockHeight }) : v;
  if (b.error !== undefined) out.error = { code: b.error?.code, message: String(b.error?.message ?? "").slice(0, 120) };
  return JSON.stringify(out);
}

/** The check on one recorded run: { reads: [{ route, read: "slot" | "header" | "full", id, status, headers, body }] }. */
export function judge({ reads }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const route of ROUTES) {
    const tag = `[${route}]`;
    const at = (k) => reads.find((x) => x.route === route && x.read === k);
    const s = at("slot");
    const slot = s && s.status === 200 ? json(s.body)?.result : undefined;
    if (!Number.isSafeInteger(slot) || slot < 0) {
      say(false, `${tag} finalized slot: ${s ? `${s.status} ${s.body.slice(0, 160)}` : "no read"}`);
      continue;
    }
    say(true, `${tag} finalized slot ${slot}`);
    const h = at("header");
    if (!h) say(false, `${tag} header read: no read`);
    else {
      const b = json(h.body);
      const r = b?.result;
      const ok = h.status === 200 && b?.jsonrpc === "2.0" && b.id === h.id && r !== null && typeof r === "object" && Number.isSafeInteger(r.blockHeight) && Array.isArray(r.keys) && !r.keys.some((k) => k === "transactions" || k === "signatures" || k === "rewards");
      say(ok, `${tag} header read answered: ${h.status} ${h.body.slice(0, 200)}`);
      say(SHA.test(h.headers["x-helper-commit"] ?? ""), `${tag} X-Helper-Commit: ${h.headers["x-helper-commit"] ?? "none"}`);
      say(h.headers["access-control-allow-origin"] === SIGN, `${tag} allow-origin: ${h.headers["access-control-allow-origin"] ?? "none"}`);
    }
    const f = at("full");
    if (!f) say(false, `${tag} full read: no read`);
    else say(f.status === 400 && json(f.body)?.error?.code === "method_not_allowed", `${tag} full read refused: ${f.status} ${f.body.slice(0, 160)}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

export async function read(base = BASE, fetchFn = fetch) {
  const reads = [];
  let id = 1;
  for (const route of ROUTES) {
    let slot;
    for (const k of ["slot", "header", "full"]) {
      if (k !== "slot" && !Number.isSafeInteger(slot)) break;
      const method = k === "slot" ? "getSlot" : "getBlock";
      const t0 = performance.now();
      const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/rpc/${route}`, { method: "POST", redirect: "manual", headers: { origin: SIGN, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params: paramsOf[k](slot) }) });
      const text = await r.text();
      const headers = {};
      for (const h of ["x-helper-commit", "access-control-allow-origin", "retry-after"]) if (r.headers.get(h) !== null) headers[h] = r.headers.get(h);
      const body = cut(text);
      if (k === "slot") slot = r.status === 200 ? json(body)?.result : undefined;
      reads.push({ route, read: k, id, ms: Math.round(performance.now() - t0), status: r.status, headers, body });
      id++;
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
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`times (ms): ${run.reads.map((r) => `${r.route} ${r.read} ${r.ms}`).join(", ")}`);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
