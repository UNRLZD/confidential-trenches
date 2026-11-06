#!/usr/bin/env node
// Live check of card pool-buy-send-fast: the signing page's second Solana provider on each network is HELPER_HOST's
// RPC route (mainnet /v1/rpc/solana, the testnet build /v1/rpc/solana-devnet: packages/signpage/src/pool-testnet.ts
// TESTNET_RPCS), and it serves a pool buy's reads at the pace the buy asks them. Before this card the testnet build's
// second provider was a public devnet endpoint answering 1 request a second (the 5 Nov 13:50:55Z buy waited 11.2 s on
// its 429s, tap to sent 19.88 s, past the kit client's 10 s), and the helper's route refused five reads the pool path
// makes. With Origin SIGN_HOST it passes only when:
//   - devnet: getAccountInfo of the devnet pool's account answers 200 owned by the devnet pool program (the route reads
//     devnet, not mainnet);
//   - on both routes, each read the pool path makes beyond the original list (getSlot, getBlockTime,
//     getSignaturesForAddress, getFeeForMessage) is forwarded: 200 with a JSON-RPC answer for its own id, never 400
//     method_not_allowed (a provider's JSON-RPC error for the planted arguments still counts);
//   - on both routes, a getProgramAccounts scan with a dataSize filter alone (not the note restore's shape: no memcmp)
//     is refused 400 method_not_allowed (review L-2: the helper forwards a scan only on its own pinned pool program with
//     a dataSize and a memcmp filter, so no caller spends the keyed provider's quota on an open scan);
//   - devnet: the note restore's exact scan (RESTORE_SCAN, packages/wallet/src/pool/solana-restore.ts solanaMarks: the
//     spent marks' bucket 0 of the devnet pool program) is forwarded: 200 with { context, value: [...] } for its own id
//     (the box's POOL_SOLANA_PROGRAM_DEVNET is the devnet pool program, else the helper refuses it 400);
//   - devnet pace: PACE_READS getSlot reads one after another each answer 200 with a slot, none 429, and their median is
//     under PACE_P50_MS (the page's buy reads its two providers this way, one step after another);
//   - every answer carries a full-sha X-Helper-Commit and echoes SIGN_HOST in Access-Control-Allow-Origin.
//   node scripts/live-checks/pool-buy-send-fast.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "pool-buy-send-fast";
export const BASE = "https://api.confidential.unrealized.trade";
export const SIGN = "https://sign.confidential.unrealized.trade";
/** The devnet pool (scripts/live-checks/pool-sol-deploy.devnet.json) and its program. */
export const DEVNET_POOL = "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr";
export const DEVNET_PROGRAM = "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ";
export const PACE_READS = 6;
/** [design: 1 s: a public endpoint at 1 request a second answers every other read of a run like this 429, and a
 *  keyed provider answers a getSlot in tens of ms; the median keeps one slow read from deciding.] */
export const PACE_P50_MS = 1_000;
const SHA = /^[0-9a-f]{40}$/;
// a v0-free legacy message of one signer and no instruction, on the all-ones blockhash: getFeeForMessage answers it (a
// null value for an unknown blockhash), which shows the read was forwarded
const FEE_MESSAGE = Buffer.concat([Buffer.from([1, 0, 0, 1]), Buffer.alloc(32, 1), Buffer.alloc(32, 1), Buffer.from([0])]).toString("base64");
/** The reads the pool path makes beyond the route's first list (packages/signpage/src/pool-buy.ts getSlot, pool-spend.ts
 *  getSignaturesForAddress, pool-deposit.ts getFeeForMessage, wallet pool/solana.ts getBlockTime), each with arguments
 *  that answer small, and a getProgramAccounts scan the helper must refuse (`refused`: an open scan, dataSize alone). */
export const POOL_READS = [
  { method: "getSlot", params: [{ commitment: "finalized" }] },
  { method: "getBlockTime", params: [1] },
  { method: "getSignaturesForAddress", params: [DEVNET_POOL, { limit: 1, commitment: "finalized" }] },
  { method: "getFeeForMessage", params: [FEE_MESSAGE, { commitment: "confirmed" }] },
  { method: "getProgramAccounts", params: [DEVNET_PROGRAM, { encoding: "base64", commitment: "finalized", filters: [{ dataSize: 1 }] }], refused: true },
];
export const ROUTES = ["solana-devnet", "solana"];
/** The restore's request for the devnet pool's spent marks, bucket 0, as solanaMarks sends it (no minContextSlot on a
 *  first read). */
export const RESTORE_SCAN = [DEVNET_PROGRAM, { commitment: "finalized", encoding: "base64", withContext: true, filters: [{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1112" } }] }];

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

/** The check on one recorded run: { reads: [{ route, kind: "pool" | "owner" | "pace" | "restore", method, id, ms, status, headers, body }] }. */
export function judge({ reads }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const headersOk = (r, tag) => {
    const h = r.headers ?? {};
    say(SHA.test(h["x-helper-commit"] ?? ""), `${tag} X-Helper-Commit: ${h["x-helper-commit"] ?? "none"}`);
    say(h["access-control-allow-origin"] === SIGN, `${tag} CORS allow-origin ${h["access-control-allow-origin"] ?? "none"}`);
  };
  const owner = reads.find((x) => x.route === "solana-devnet" && x.kind === "owner");
  if (!owner) say(false, "[solana-devnet getAccountInfo] no read");
  else {
    const b = json(owner.body);
    say(owner.status === 200 && b?.id === owner.id && b?.result?.value?.owner === DEVNET_PROGRAM, `[solana-devnet getAccountInfo] the devnet pool, owned by ${DEVNET_PROGRAM}: ${owner.status} ${String(b?.result?.value?.owner ?? owner.body.slice(0, 100))}`);
    headersOk(owner, "[solana-devnet getAccountInfo]");
  }
  for (const route of ROUTES)
    for (const { method, refused } of POOL_READS) {
      const tag = `[${route} ${method}]`;
      const r = reads.find((x) => x.route === route && x.kind === "pool" && x.method === method);
      if (!r) {
        say(false, `${tag} no read`);
        continue;
      }
      const b = json(r.body);
      if (refused) say(r.status === 400 && b?.error?.code === "method_not_allowed", `${tag} an open scan refused: ${r.status} ${r.body.slice(0, 100)}`);
      else say(r.status === 200 && b?.jsonrpc === "2.0" && b.id === r.id && (Object.hasOwn(b, "result") || Object.hasOwn(b, "error")), `${tag} forwarded: ${r.status} ${r.body.slice(0, 100)}`);
      headersOk(r, tag);
    }
  const restore = reads.find((x) => x.route === "solana-devnet" && x.kind === "restore");
  if (!restore) say(false, "[solana-devnet restore scan] no read");
  else {
    const b = json(restore.body);
    say(restore.status === 200 && b?.id === restore.id && Number.isSafeInteger(b?.result?.context?.slot) && Array.isArray(b?.result?.value), `[solana-devnet restore scan] forwarded, a list of the pool's marks: ${restore.status} ${restore.body.slice(0, 100)}`);
    headersOk(restore, "[solana-devnet restore scan]");
  }
  const pace = reads.filter((x) => x.route === "solana-devnet" && x.kind === "pace");
  say(pace.length === PACE_READS, `[solana-devnet pace] ${pace.length} of ${PACE_READS} reads`);
  const slots = pace.map((r) => ({ r, b: json(r.body) }));
  say(slots.every(({ r, b }) => r.status === 200 && b?.id === r.id && Number.isSafeInteger(b?.result) && b.result > 0), `[solana-devnet pace] every read a slot: ${pace.map((r) => r.status).join(" ")}`);
  say(pace.every((r) => r.status !== 429), `[solana-devnet pace] no 429`);
  const p50 = pace.length ? median(pace.map((r) => r.ms)) : Infinity;
  say(p50 < PACE_P50_MS, `[solana-devnet pace] median ${p50} ms, under ${PACE_P50_MS} ms (${pace.map((r) => r.ms).join(", ")})`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

export async function read(base = BASE, fetchFn = fetch) {
  const reads = [];
  let id = 1;
  const one = async (route, kind, method, params) => {
    const t0 = performance.now();
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/rpc/${route}`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: SIGN, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const body = await r.text();
    // the restore's answer is read whole (a bucket holds 256 marks at most, under 100 KB); the others' first 2,000
    const keep = kind === "restore" ? 200_000 : 2_000;
    const ms = Math.round(performance.now() - t0);
    const headers = {};
    for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
    reads.push({ route, kind, method, id, readAt: new Date().toISOString(), ms, status: r.status, headers, body: body.length > keep ? body.slice(0, keep) : body });
    id++;
  };
  await one("solana-devnet", "owner", "getAccountInfo", [DEVNET_POOL, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 8 } }]);
  for (let i = 0; i < PACE_READS; i++) await one("solana-devnet", "pace", "getSlot", [{ commitment: "confirmed" }]);
  for (const route of ROUTES) for (const { method, params } of POOL_READS) await one(route, "pool", method, params);
  await one("solana-devnet", "restore", "getProgramAccounts", RESTORE_SCAN);
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
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
