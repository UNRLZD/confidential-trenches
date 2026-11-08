#!/usr/bin/env node
// Live check of card helper-rpc-sell-methods: HELPER_HOST's mainnet Solana route (POST /v1/rpc/solana, the signing
// page's second provider for a pool buy, sell, deposit and withdraw and for the trade path: packages/signpage/src/
// trade.ts TRADE_HELPER) forwards every method on the kit's HELPER_RPC_METHODS.solana, read from the kit at the
// checked-out commit, so a method added to the list is sent here with no edit. For each method it sends one request
// with Origin SIGN_HOST and passes only when:
//   - the answer is 200 with a JSON-RPC 2.0 answer for its own id: a result, or the provider's own JSON-RPC error (a
//     numeric code: the junk transaction sendTransaction sends fails the provider's signature check, so it never lands);
//     never the helper's refusal (400 method_not_allowed) and never a 429 left after the Retry-After it names;
//   - it carries a full-sha X-Helper-Commit and echoes SIGN_HOST in Access-Control-Allow-Origin.
// getProgramAccounts is forwarded only in the note restore's shape on the helper's pinned mainnet pool program
// (apps/helper/src/rpc/rpc.ts scanAllowed); it is sent in that shape on the program the mainnet pool's deploy record
// names (scripts/live-checks/pool-sol-deploy.mainnet.json), and while no record exists there is no pool to restore
// from: that line reads n/a with the reason.
// A caller draws 16 requests per 10 s on the route (rpc.ts RPC_CLIENT_MAX) and the list is longer, so a 429 is waited
// out once for its Retry-After (at most 10 s) and the request sent again.
//   node scripts/live-checks/helper-rpc-sell-methods.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HELPER_RPC_METHODS } from "../../packages/kit/src/index.ts";

const KEY = "helper-rpc-sell-methods";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
const SHA = /^[0-9a-f]{40}$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MAINNET_POOL_RECORD = "scripts/live-checks/pool-sol-deploy.mainnet.json";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Fixed inputs: public sysvars and a legacy message from a payer of 32 0x01 bytes, no instruction, a zero blockhash
// (getFeeForMessage answers value null for it), signed by 64 zero bytes (no provider accepts it as sent).
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const RENT = "SysvarRent111111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ZERO_SIG = "1".repeat(64);
const MESSAGE = Buffer.concat([Buffer.from([1, 0, 1, 2]), Buffer.alloc(32, 1), Buffer.alloc(32, 0), Buffer.alloc(32, 0), Buffer.from([0])]);
const TX = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 0), MESSAGE]).toString("base64");

/** Each method's params; `scan` is the restore's getProgramAccounts on `program`: the spent marks' first bucket. */
export const PARAMS = {
  getAccountInfo: [CLOCK, { encoding: "base64" }],
  getMultipleAccounts: [[CLOCK, RENT], { encoding: "base64" }],
  getBalance: [CLOCK],
  getTokenAccountsByOwner: [CLOCK, { programId: TOKEN }, { encoding: "base64" }],
  getTokenLargestAccounts: [CLOCK], // not a mint: the provider answers its invalid-param error at once (USDC's holders scan drew a public provider's 429)
  getLatestBlockhash: [{ commitment: "confirmed" }],
  simulateTransaction: [TX, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }],
  sendTransaction: [TX, { encoding: "base64" }],
  getSignatureStatuses: [[ZERO_SIG]],
  getTransaction: [ZERO_SIG, { encoding: "base64", maxSupportedTransactionVersion: 0 }],
  getBlockHeight: [{ commitment: "finalized" }],
  getMinimumBalanceForRentExemption: [165],
  isBlockhashValid: ["11111111111111111111111111111111", { commitment: "processed" }],
  getSlot: [{ commitment: "finalized" }],
  getSignaturesForAddress: [CLOCK, { limit: 1 }],
  getFeeForMessage: [MESSAGE.toString("base64"), { commitment: "processed" }],
  getBlockTime: [1],
  getEpochInfo: [{ commitment: "confirmed" }],
  getProgramAccounts: (program) => [program, { commitment: "finalized", encoding: "base64", withContext: true, filters: [{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1112" } }] }],
};

/** The program the mainnet pool's deploy record names under `root`, or null where there is no record. */
export function mainnetPoolProgram(root = ROOT) {
  const file = path.join(root, MAINNET_POOL_RECORD);
  if (!existsSync(file)) return null;
  const rec = JSON.parse(readFileSync(file, "utf8"));
  if (rec?.cluster !== "mainnet" || typeof rec.program_id !== "string" || !B58.test(rec.program_id)) throw new Error(`${MAINNET_POOL_RECORD} names no mainnet program_id`);
  return rec.program_id;
}

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};
/** A body as recorded: a JSON-RPC answer cut to its id and its result (an object or array as "object" or "array": its
 *  account data and signatures are not kept) or its error's code and message; anything else its first 300 characters.
 *  A cut body cuts to itself, so a replayed run reads as the recorded one. */
function cut(text) {
  const b = json(text);
  if (b?.jsonrpc !== "2.0") return text.slice(0, 300);
  const out = { jsonrpc: "2.0", id: b.id };
  const v = b.result;
  if (v !== undefined) out.result = v === null ? null : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v === "string" ? v.slice(0, 64) : v;
  if (b.error !== undefined) out.error = { code: b.error?.code, message: String(b.error?.message ?? "").slice(0, 120) };
  return JSON.stringify(out);
}

/** The check on one recorded run: { methods, program, reads: [{ method, id, status, headers, body }] }. */
export function judge({ methods, program, reads }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(Array.isArray(methods) && methods.length > 0 && methods.includes("getFeeForMessage"), `the kit's Solana list read: ${methods?.length ?? 0} methods`);
  for (const method of methods ?? []) {
    const tag = `[${method}]`;
    if (method === "getProgramAccounts" && program === null) {
      say(true, `${tag} n/a: no ${MAINNET_POOL_RECORD}, no mainnet pool to restore from`);
      continue;
    }
    const r = reads.find((x) => x.method === method);
    if (!r) {
      say(false, `${tag} no read`);
      continue;
    }
    const b = json(r.body);
    const answered = r.status === 200 && b?.jsonrpc === "2.0" && b.id === r.id && (Object.hasOwn(b, "result") || Number.isInteger(b.error?.code));
    say(answered, `${tag} answered: ${r.status} ${r.body.slice(0, 160)}`);
    const h = r.headers;
    say(SHA.test(h["x-helper-commit"] ?? ""), `${tag} X-Helper-Commit: ${h["x-helper-commit"] ?? "none"}`);
    say(h["access-control-allow-origin"] === SIGN, `${tag} allow-origin: ${h["access-control-allow-origin"] ?? "none"}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function read(base = BASE, fetchFn = fetch, { methods = HELPER_RPC_METHODS.solana, program = mainnetPoolProgram(), wait = sleep } = {}) {
  const reads = [];
  let id = 1;
  for (const method of methods) {
    if (method === "getProgramAccounts" && program === null) continue;
    const p = PARAMS[method];
    if (p === undefined) throw new Error(`no params for ${method}: add it to PARAMS`);
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: typeof p === "function" ? p(program) : p });
    let r;
    let t0;
    for (let tries = 0; ; tries++) {
      t0 = performance.now();
      r = await fetchFn(`${base.replace(/\/$/, "")}/v1/rpc/solana`, { method: "POST", redirect: "manual", headers: { origin: SIGN, "content-type": "application/json" }, body });
      const s = Number(r.headers.get("retry-after"));
      if (r.status !== 429 || tries > 0 || !(s >= 0 && s <= 10)) break;
      await r.text();
      await wait(s * 1000 + 100);
    }
    const text = await r.text();
    const headers = {};
    for (const k of ["x-helper-commit", "access-control-allow-origin", "retry-after"]) if (r.headers.get(k) !== null) headers[k] = r.headers.get(k);
    reads.push({ method, id, ms: Math.round(performance.now() - t0), status: r.status, headers, body: cut(text) });
    id++;
  }
  return { base, at: new Date().toISOString(), methods: [...methods], program, reads };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`times (ms): ${run.reads.map((r) => `${r.method} ${r.ms}`).join(", ")}`);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
