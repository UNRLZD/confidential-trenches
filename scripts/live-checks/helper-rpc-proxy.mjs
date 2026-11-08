#!/usr/bin/env node
// Live check of card helper-rpc-proxy: HELPER_HOST forwards only the allowlisted RPC methods (markets paper H7 row
// POST /v1/rpc/{chain}, M:3335, with 7.1's LD1 reads, M:3275; the allowlist is the kit's HELPER_RPC_METHODS). On each of
// the four chains it sends, with Origin APP_HOST, one allowlisted read and one method off the list, and passes only
// when:
//   - each allowlisted read answers 200 with a JSON-RPC 2.0 answer for its own id carrying a result of the right kind
//     (Solana getBlockHeight and EVM eth_blockNumber a positive height, NEAR gas_price a positive decimal gas_price),
//     no error;
//   - each unlisted method answers 400 { error: { code: "method_not_allowed" } }: refused, never forwarded;
//   - every answer carries a full-sha X-Helper-Commit, echoes APP_HOST in Access-Control-Allow-Origin, has
//     Vary: Origin and no Access-Control-Allow-Credentials.
// After: helper
//   node scripts/live-checks/helper-rpc-proxy.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-rpc-proxy";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
const SHA = /^[0-9a-f]{40}$/;
const HEX = /^0x[0-9a-f]+$/;

/** Per chain: one allowlisted read with the check on its result, and one method off the list. */
export const CASES = [
  { chain: "solana", listed: { method: "getBlockHeight", params: [] }, ok: (r) => Number.isSafeInteger(r) && r > 0, unlisted: "requestAirdrop" },
  { chain: "base", listed: { method: "eth_blockNumber", params: [] }, ok: (r) => typeof r === "string" && HEX.test(r) && BigInt(r) > 0n, unlisted: "debug_traceTransaction" },
  { chain: "robinhood", listed: { method: "eth_blockNumber", params: [] }, ok: (r) => typeof r === "string" && HEX.test(r) && BigInt(r) > 0n, unlisted: "eth_accounts" },
  // gas_price, not block: a block answer carries chunk signatures that read as key-shaped strings in a recorded file
  { chain: "near", listed: { method: "gas_price", params: [null] }, ok: (r) => /^[1-9][0-9]*$/.test(r?.gas_price ?? ""), unlisted: "EXPERIMENTAL_changes" },
];

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The check on one recorded run: { reads: [{ chain, kind: "listed" | "unlisted", id, status, headers, body }] }. */
export function judge({ reads }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const c of CASES) {
    for (const kind of ["listed", "unlisted"]) {
      const method = kind === "listed" ? c.listed.method : c.unlisted;
      const tag = `[${c.chain} ${method}]`;
      const r = reads.find((x) => x.chain === c.chain && x.kind === kind);
      if (!r) {
        say(false, `${tag} no read`);
        continue;
      }
      const b = json(r.body);
      if (kind === "listed") {
        say(r.status === 200, `${tag} answers ${r.status}`);
        const answered = b?.jsonrpc === "2.0" && b.id === r.id && b.error === undefined && c.ok(b.result);
        say(answered, `${tag} a JSON-RPC answer for id ${r.id} with a ${c.chain} result: ${show(b?.result ?? b?.error ?? r.body.slice(0, 120))?.slice(0, 160)}`);
      } else {
        say(r.status === 400 && b?.error?.code === "method_not_allowed", `${tag} refused 400 method_not_allowed: ${r.status} ${r.body.slice(0, 120)}`);
      }
      const h = r.headers;
      say(SHA.test(h["x-helper-commit"] ?? ""), `${tag} X-Helper-Commit: ${show(h["x-helper-commit"])}`);
      say(h["access-control-allow-origin"] === APP && h["vary"] === "Origin" && h["access-control-allow-credentials"] === undefined, `${tag} CORS: allow-origin ${show(h["access-control-allow-origin"])}, vary ${show(h["vary"])}, credentials ${show(h["access-control-allow-credentials"])}`);
    }
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

export async function read(base = BASE, fetchFn = fetch) {
  const reads = [];
  let id = 1;
  for (const c of CASES) {
    for (const kind of ["listed", "unlisted"]) {
      const body = kind === "listed" ? { jsonrpc: "2.0", id, ...c.listed } : { jsonrpc: "2.0", id, method: c.unlisted, params: [] };
      const readAt = new Date().toISOString();
      const t0 = performance.now();
      const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/rpc/${c.chain}`, {
        method: "POST",
        redirect: "manual",
        headers: { origin: APP, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      const ms = Math.round(performance.now() - t0);
      const headers = {};
      for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
      reads.push({ chain: c.chain, kind, id, readAt, ms, status: r.status, headers, body: text });
      id++;
    }
  }
  return { base, reads };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`times (ms): ${run.reads.map((r) => `${r.chain} ${r.kind} ${r.ms}`).join(", ")}`);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
