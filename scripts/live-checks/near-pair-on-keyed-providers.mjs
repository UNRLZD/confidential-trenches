#!/usr/bin/env node
// Live check of card near-pair-on-keyed-providers: the deployed helper's mainnet NEAR reads that must agree on two
// providers (the token watch, the withdraw fee quote, the deposit and withdrawal carries, the NEAR trade reads; all
// apps/helper/src/token-status/status.ts readUrls) run on two keyed providers of two companies, so a free endpoint's
// 429 never refuses a withdraw fee. Live 13 Nov (helper live run 43432500633): "BAD fee: 429 rate_limited (want 200)"
// while the host held FastNear's key. It moves no money: it reads. It passes only when:
//   - GET /v1/health answers 200 and its X-Helper-Near-Pair header (server.ts NEAR_PAIR_HEADER) names two providers,
//     each "<company's domain>[ key<n>]" (rpc.ts providerName), FastNear first, two different companies (dRPC's
//     lb.drpc.live and drpc.org are one), neither "keyless" (a free endpoint), no URL, path, query or key;
//   - each of the two is a keyed entry of the health's rpc.near list (rpc-keyed-lists), so the pair is the host's keys;
//   - GET /v1/withdraw/fee for mainnet USDC answers 200 on each of FEE_CALLS calls FEE_GAP_MS apart, all inside one
//     10 s window (limits.ts LIMIT_WINDOW_MS): each past the quote cache (fee.ts FEE_CACHE_MS, 1 s), so each is a fresh
//     read of both providers.
// The keys exist only on the helper box: this check reads the helper alone, never a provider.
// After: helper
//   node scripts/live-checks/near-pair-on-keyed-providers.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "near-pair-on-keyed-providers";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Mainnet USDC, the vault's one token (packages/kit/src/vault/shapes.ts VAULT_CONSTANTS.TOKEN). */
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // gitleaks:allow (a public account id)
export const HEADER = "x-helper-near-pair";
export const FEE_CALLS = 4;
export const FEE_GAP_MS = 2_000;
export const WINDOW_MS = 10_000;
const NAME = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)( key[1-9])?( keyless)?$/;
const SAME_COMPANY = { "drpc.live": "drpc.org" };

/** One run: the health (status, the pair header, rpc.near), then FEE_CALLS fee quotes, each with its time. */
export async function read(base = BASE, fetchFn = fetch, sleep = (ms) => new Promise((go) => setTimeout(go, ms)), now = Date.now) {
  const b = base.replace(/\/$/, "");
  const opts = { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } };
  const h = await fetchFn(`${b}/v1/health`, opts);
  const health = { status: h.status, pair: h.headers.get(HEADER), body: await h.text() };
  const fees = [];
  for (let i = 0; i < FEE_CALLS; i++) {
    if (i > 0) await sleep(FEE_GAP_MS);
    const at = now();
    const r = await fetchFn(`${b}/v1/withdraw/fee?token=${USDC}`, opts);
    fees.push({ at, status: r.status, retry_after: r.headers.get("retry-after"), body: (await r.text()).slice(0, 2_048) });
  }
  return { base, health, fees };
}

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The check on one recorded run. */
export function judge({ health, fees }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(health?.status === 200, `GET /v1/health answers ${health?.status}`);
  const pair = typeof health?.pair === "string" ? health.pair.split(", ") : [];
  say(pair.length === 2, `${HEADER}: ${JSON.stringify(health?.pair ?? null)} names ${pair.length === 2 ? "two" : "not two"} providers`);
  say(!/https?:|\/|\?|=|apikey|api-key/i.test(health?.pair ?? ""), `${HEADER}: no URL, path, query or key`);
  const parsed = pair.map((p) => NAME.exec(p));
  say(parsed.length === 2 && parsed.every((m) => m !== null), `${HEADER}: each is "<domain>[ key<n>]"`);
  say(parsed[0]?.[1] === "fastnear.com", `${HEADER}: FastNear first (${parsed[0]?.[1] ?? "none"})`);
  const company = (m) => (m === null || m === undefined ? undefined : (SAME_COMPANY[m[1]] ?? m[1]));
  say(parsed.length === 2 && company(parsed[0]) !== undefined && company(parsed[0]) !== company(parsed[1]), `${HEADER}: two different companies (${parsed.map(company).join(", ")})`);
  for (const [i, m] of parsed.entries()) say(m !== null && m[3] === undefined, `${HEADER}: ${pair[i]} is a keyed provider, not a free endpoint`);
  const near = json(health?.body ?? "")?.rpc?.near;
  const listed = Array.isArray(near) ? near.filter((e) => typeof e === "string").map((e) => e.replace(/ (answers|wrong chain|held|down|unread)$/, "")) : [];
  for (const p of pair) say(listed.includes(p), `rpc.near lists ${p} (${JSON.stringify(near ?? null)})`);
  const list = Array.isArray(fees) ? fees : [];
  say(list.length === FEE_CALLS, `${list.length} of ${FEE_CALLS} fee calls read`);
  for (const [i, f] of list.entries()) say(f.status === 200, `GET /v1/withdraw/fee #${i + 1}: ${f.status}${f.status === 200 ? "" : ` ${json(f.body)?.error?.code ?? "?"}${f.retry_after ? ` retry-after ${f.retry_after}` : ""}`} (want 200)`);
  const span = list.length > 1 ? list[list.length - 1].at - list[0].at : 0;
  say(Number.isFinite(span) && span < WINDOW_MS, `the fee calls span ${span} ms, inside one ${WINDOW_MS / 1000} s window`);
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
