#!/usr/bin/env node
// Live check of card app-console-429: a crowd opening a token page never meets a 429 or a 503 from the helper. With
// Origin APP_HOST it reads Discover's Solana lists, takes the top Trending token (the token "/" draws, and the one
// app-token-chart picks), then opens that token's page CROWD times at once: GET /v1/market/token, /holders, /candles
// (15m, 500, the page's own read) and /trades for it, every request in flight together, with the lists of all three
// chains alongside. It passes only when every answer is a 200. A failing answer is named by its route, its status and
// its Retry-After, so a FAIL says which route refused (the helper's own log says which limit: "refused <route> <why>").
// From one machine the helper sees one client: CROWD x 4 + 4 stays under its 120 a client a window (server.ts
// API_RATE_MAX), so a 429 here is never this check's own window.
// After: app helper
//   node scripts/live-checks/app-console-429.mjs [--base <url>] [--crowd <n>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "app-console-429";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CROWD = 25;
export const CHAINS = ["solana", "base", "robinhood"];
export const ROUTES = (mint) => [
  `/v1/market/token?chain=solana&token=${mint}`,
  `/v1/market/holders?chain=solana&token=${mint}`,
  `/v1/market/candles?chain=solana&token=${mint}&tf=15m&limit=500`,
  `/v1/market/trades?chain=solana&token=${mint}&limit=50`,
];

async function get(base, path, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
    const body = await r.text();
    return { path, status: r.status, retryAfter: r.headers.get("retry-after"), ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    return { path, status: 0, retryAfter: null, ms: Math.round(performance.now() - t0), error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function read(base = BASE, fetchFn = fetch, crowd = CROWD) {
  const at = new Date().toISOString();
  const lists = await get(base, "/v1/market/lists?chain=solana", fetchFn);
  let mint = null;
  try {
    const l = JSON.parse(lists.body).lists;
    mint = (l.trending_1h ?? l.trending)?.[0]?.token ?? null;
  } catch {}
  const { body: _b, ...first } = lists;
  if (typeof mint !== "string") return { base, at, crowd, mint: null, lists: first, answers: [] };
  const reads = [...CHAINS.map((c) => `/v1/market/lists?chain=${c}`), ...Array.from({ length: crowd }, () => ROUTES(mint)).flat()];
  // each path kept with the token written once, in `mint`: a record holds routes, not addresses
  const answers = (await Promise.all(reads.map((p) => get(base, p, fetchFn)))).map(({ body: _x, ...a }) => ({ ...a, path: a.path.replace(mint, "<mint>") }));
  return { base, at, crowd, mint, lists: first, answers };
}

const routeOf = (path) => path.split("?")[0] + (path.startsWith("/v1/market/lists") ? `?${path.split("?")[1]}` : "");

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(run.lists?.status === 200 && typeof run.mint === "string", `GET /v1/market/lists?chain=solana answers ${run.lists?.status}, the top Trending token ${run.mint ?? "none"}`);
  if (typeof run.mint !== "string") return { ok: false, lines };
  const want = CHAINS.length + run.crowd * ROUTES(run.mint).length;
  say(run.answers.length === want, `${run.answers.length} reads of ${want} (${run.crowd} page opens at once, and the three chains' lists)`);
  const by = new Map();
  for (const a of run.answers) {
    const k = routeOf(a.path);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(a);
  }
  for (const [route, as] of by) {
    const bad = as.filter((a) => a.status !== 200);
    const ms = as.map((a) => a.ms).sort((x, y) => x - y);
    const kinds = [...new Set(bad.map((a) => `${a.status}${a.retryAfter ? ` Retry-After ${a.retryAfter}` : ""}${a.error ? ` ${a.error}` : ""}`))];
    say(bad.length === 0, `${route}: ${as.length - bad.length} of ${as.length} answered 200${bad.length ? `; ${bad.length} did not: ${kinds.join(", ")}` : ""} (p50 ${ms[Math.floor(ms.length / 2)]} ms, max ${ms.at(-1)} ms)`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE), fetch, Number(opt("--crowd", String(CROWD))));
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
