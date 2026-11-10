#!/usr/bin/env node
// Live check of card sol-pools-mainnet-pin, the helper's half: the mainnet mark list, which the signing page asks of the
// helper's solana-marks route (packages/signpage/src/pool-testnet.ts pageSolanaLister) and then reads mark by mark on its
// pair, provider A directly (packages/wallet/src/pool/solana-restore.ts solanaMarksListed). Both routes of HELPER_HOST
// that answer that list, each one company's provider, are read with the wallet lister's exact request (the addresses
// alone, dataSlice { offset: 0, length: 0 }).
// No keyless mainnet provider answers that scan (publicnode 403 "Indexed requests require a personal token",
// api.mainnet-beta 403, read 9 Nov 17:23Z), so both are the helper's (apps/helper/src/rpc/rpc.ts marksRoutes):
//   A: POST /v1/rpc/solana, getProgramAccounts sent to SOLANA_RPC_URL alone;
//   B: POST /v1/rpc/solana-marks, that scan alone, from Solana's keyed spares off A's company, no public fallback.
// For bucket 0 of each mark size (13, a spent mark; 17, a pre-mark), in the exact shape rpc.ts scanAllowed admits, on
// the program contracts/pool-solana/deployments/mainnet.json names, it reads both routes with Origin SIGN_HOST and
// passes only when:
//   - each answers 200 with a list and its finalized slot, a full-sha X-Helper-Commit and SIGN_HOST in
//     Access-Control-Allow-Origin;
//   - the provider each names in its Server-Timing rpc entry (the environment NAME, never a URL) is SOLANA_RPC_URL for A
//     and one of route B's names, never SOLANA_RPC_URL, for B (the start check, apps/helper/src/env-check.ts
//     checkMarksRoute, refuses a B on A's company before the helper starts);
//   - the two routes' lists are the same accounts, byte for byte (sha256 of the value; a pair that differs is read
//     again once, since a mark that lands between the two reads differs for a moment);
//   - route B refuses any other method: getSlot answers 400.
// A route with no usable answer (read again once: a 429, an empty body, a rate limit) is named on a `---` line and not
// judged, and the run is INCONCLUSIVE (exit 3) unless another line is BAD.
// The signing page's half (the pin itself on SIGN_HOST) is signpage-pool-pins and signpage-pool-mainnet, after sign.
// After: helper
//   node scripts/live-checks/sol-pools-mainnet-pin.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, for the test's replay.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "sol-pools-mainnet-pin";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
/** apps/helper/src/rpc/rpc.ts MARKS_A_ENV and RPC_UPSTREAMS["solana-marks"].keyed, held equal by this check's test. */
export const A_NAME = "SOLANA_RPC_URL";
export const B_NAMES = ["SOLANA_RPC_URL_QUICKNODE", "SOLANA_RPC_URL_DRPC_1", "SOLANA_RPC_URL_DRPC_2", "SOLANA_RPC_URL_DRPC_3"];
const SHA = /^[0-9a-f]{40}$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RECORD = "contracts/pool-solana/deployments/mainnet.json";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Bucket 0 of a mark size: base58 of size - 9 bytes, the counter's bytes past its low byte (0) then the tag 1. */
export const bucket0 = (size) => "1".repeat(size - 10) + B58[1];
export const SIZES = [13, 17];
export const scanParams = (program, size) => [program, { commitment: "finalized", encoding: "base64", withContext: true, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: size }, { memcmp: { offset: 9, bytes: bucket0(size) } }] }];

/** The provider's environment name in a Server-Timing header's rpc entry (rpc.ts timingOf), or null. */
export const providerOf = (timing) => /(?:^|,\s*)rpc;[^,]*desc="([A-Z0-9_]+)"/.exec(timing ?? "")?.[1] ?? null;
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** The check on one recorded run: { program, reads: [{ route, size, status, headers, answer }], refusal: { status } }. */
export function judge(run) {
  const lines = [];
  const quiet = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  say(typeof run.program === "string" && run.program.length >= 32, `the mainnet pool program from ${RECORD}: ${run.program ?? "none"}`);
  const of = (route, size) => (run.reads ?? []).filter((r) => r.route === route && r.size === size).at(-1);
  for (const size of SIZES) {
    const got = {};
    for (const route of ["A", "B"]) {
      const r = of(route, size);
      const tag = `[${route} size ${size}]`;
      if (r === undefined) {
        say(false, `${tag} no read`);
        continue;
      }
      if (r.answer?.noAnswer !== undefined) {
        quiet.push(`${tag} ${r.answer.noAnswer}`);
        continue;
      }
      const v = r.answer?.result?.value;
      const slot = r.answer?.result?.context?.slot;
      const listed = r.status === 200 && Array.isArray(v) && Number.isSafeInteger(slot);
      say(listed, `${tag} a list with its slot: ${listed ? `${v.length} account(s) at slot ${slot}` : `HTTP ${r.status} ${JSON.stringify(r.answer).slice(0, 160)}`}`);
      const h = r.headers ?? {};
      say(SHA.test(h["x-helper-commit"] ?? ""), `${tag} X-Helper-Commit: ${h["x-helper-commit"] ?? "none"}`);
      say(h["access-control-allow-origin"] === SIGN, `${tag} allow-origin: ${h["access-control-allow-origin"] ?? "none"}`);
      const name = providerOf(h["server-timing"]);
      const right = route === "A" ? name === A_NAME : name !== null && B_NAMES.includes(name);
      say(right, `${tag} answered by ${name ?? "no named provider"}${right ? "" : route === "A" ? `, not ${A_NAME}` : `, not one of ${B_NAMES.join(", ")}`}`);
      if (listed) got[route] = sha(v);
    }
    if (got.A !== undefined && got.B !== undefined) say(got.A === got.B, `[size ${size}] the two routes' lists are the same: ${got.A === got.B ? got.A.slice(0, 16) : `A ${got.A.slice(0, 16)}, B ${got.B.slice(0, 16)}`}`);
  }
  const f = run.refusal ?? {};
  say(f.status === 400, `[B] getSlot refused: HTTP ${f.status ?? "none"}`);
  for (const q of quiet) lines.push(`--- ${q}`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet.length > 0);
  return { ok: verdict === "PASS", verdict, lines };
}

/** The program the mainnet deploy record names. */
export function mainnetProgram(root = ROOT) {
  const r = JSON.parse(readFileSync(path.join(root, RECORD), "utf8"));
  if (r?.cluster !== "mainnet" || typeof r.program_id !== "string") throw new Error(`${RECORD} names no mainnet program_id`);
  return r.program_id;
}

/** One read through rpcAnswer, with Origin SIGN_HOST, its status and headers kept. */
async function routeRead(url, method, params, fetchFn) {
  const seen = {};
  const withOrigin = async (u, init) => {
    const r = await fetchFn(u, { ...init, redirect: "manual", headers: { ...init.headers, origin: SIGN } });
    seen.status = r.status;
    seen.headers = {};
    for (const k of ["x-helper-commit", "access-control-allow-origin", "server-timing"]) if (r.headers.get(k) !== null) seen.headers[k] = r.headers.get(k);
    return r;
  };
  const answer = await rpcAnswer(url, method, params, { fetchFn: withOrigin, timeoutMs: 20_000 });
  return { status: seen.status ?? 0, headers: seen.headers ?? {}, answer };
}

export async function read(base = BASE, fetchFn = fetch, program = mainnetProgram()) {
  const b = base.replace(/\/$/, "");
  const url = { A: `${b}/v1/rpc/solana`, B: `${b}/v1/rpc/solana-marks` };
  const reads = [];
  for (const size of SIZES) {
    const pair = async () => {
      for (const route of ["A", "B"]) reads.push({ route, size, ...(await routeRead(url[route], "getProgramAccounts", scanParams(program, size), fetchFn)) });
    };
    await pair();
    const [a, bb] = ["A", "B"].map((route) => reads.filter((r) => r.route === route && r.size === size).at(-1));
    const va = a?.answer?.result?.value;
    const vb = bb?.answer?.result?.value;
    if (Array.isArray(va) && Array.isArray(vb) && sha(va) !== sha(vb)) await pair();
  }
  const refusal = await routeRead(url.B, "getSlot", [{ commitment: "finalized" }], fetchFn);
  return { check: KEY, base, at: new Date().toISOString(), program, reads, refusal: { status: refusal.status } };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${verdict} (${run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
