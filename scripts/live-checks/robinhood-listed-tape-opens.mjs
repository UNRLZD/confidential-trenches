#!/usr/bin/env node
// Live check of card robinhood-listed-tape-opens: a token Discover's lists served opens its trade tape after a list
// refresh drops it, since a user taps what the lists showed. Before the card the helper gated the tape on the lists'
// newest answer only (apps/helper/src/server.ts listed): helper live run 42345906841 (358d8f4f, 2026-11-07 06:12Z) read
// 12 Robinhood tokens from the lists and 3 of their tapes answered 404 not_found in ~800 ms, gone from the next answer.
// Now the lists keep every token an answer of the last 6 h held (apps/helper/src/data/solana/lists.ts servedTokens).
// With Origin APP_HOST, for Robinhood, Base and Solana at once, it reads the chain's lists at HELPER_HOST, then reads
// them again every POLL_MS until a token of the first answer is gone from the newest (at most WAIT_MS), and reads
// GET /v1/market/trades?chain=<chain>&token=<t>&limit=50 for up to DROPPED_MAX such tokens. A chain whose lists drop
// none in WAIT_MS is named and proves nothing.
// PASS when at least one chain dropped a token and every dropped token's tape answers 200 JSON { trades: [...] }; FAIL
// when one answers otherwise (a 404 is the bug) or a lists read fails; INCONCLUSIVE (exit 3) when no chain dropped one.
//   node scripts/live-checks/robinhood-listed-tape-opens.mjs [--base <url>] [--wait-ms <n>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, for the test.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "robinhood-listed-tape-opens";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CHAINS = ["robinhood", "base", "solana"];
/** The helper reads a list again once it is 60 s old (lists.ts LIST_MS), Solana's one a 4 s step: five minutes sees
 *  several refreshes on every chain (Robinhood dropped 5 of 44 tokens in 3 min on 2026-11-07 06:56-06:59Z). */
export const WAIT_MS = 300_000;
export const POLL_MS = 15_000;
export const DROPPED_MAX = 6;
const ADDRESS = { robinhood: /^0x[0-9a-f]{40}$/, base: /^0x[0-9a-f]{40}$/, solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ };

async function get(base, path, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(60_000) });
    const body = await r.text();
    return { status: r.status, ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), body: "", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Every token a lists answer holds, each once, in the lists' order; [] when the body is not a lists answer. */
export function tokensOf(chain, listsBody) {
  let l;
  try {
    l = JSON.parse(listsBody).lists;
  } catch {
    return [];
  }
  const out = [];
  for (const rows of Object.values(l && typeof l === "object" ? l : {})) for (const r of Array.isArray(rows) ? rows : []) if (typeof r?.token === "string" && ADDRESS[chain].test(r.token) && !out.includes(r.token)) out.push(r.token);
  return out;
}

const shapeOf = (body) => {
  try {
    return Array.isArray(JSON.parse(body).trades) ? "tape" : "no trades list";
  } catch {
    return "not JSON";
  }
};

/** One chain: its lists, read again until a token of the first answer is gone, then those tokens' tapes. */
async function chainRun(base, chain, fetchFn, waitMs, pollMs, sleep) {
  const first = await get(base, `/v1/market/lists?chain=${chain}`, fetchFn);
  const held = first.status === 200 ? tokensOf(chain, first.body) : [];
  const run = { lists: { status: first.status, tokens: held.length }, reads: 1, waitedMs: 0, dropped: [] };
  if (held.length === 0) return run;
  let gone = [];
  const t0 = performance.now();
  while (gone.length === 0 && performance.now() - t0 < waitMs) {
    await sleep(pollMs);
    const now = await get(base, `/v1/market/lists?chain=${chain}`, fetchFn);
    run.reads++;
    if (now.status !== 200) continue; // a failed re-read is no answer: read again
    const listed = new Set(tokensOf(chain, now.body));
    if (listed.size > 0) gone = held.filter((t) => !listed.has(t)).slice(0, DROPPED_MAX);
  }
  run.waitedMs = Math.round(performance.now() - t0);
  run.dropped = await Promise.all(
    gone.map(async (t) => {
      const a = await get(base, `/v1/market/trades?chain=${chain}&token=${t}&limit=50`, fetchFn);
      return { address: t, status: a.status, ms: a.ms, shape: a.status === 200 ? shapeOf(a.body) : null, ...(a.error ? { error: a.error } : {}), ...(a.status !== 200 ? { body: a.body.slice(0, 120) } : {}) };
    }),
  );
  return run;
}

export async function read(base = BASE, fetchFn = fetch, o = {}) {
  const at = new Date().toISOString();
  const sleep = o.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  const runs = await Promise.all(CHAINS.map((c) => chainRun(base, c, fetchFn, o.waitMs ?? WAIT_MS, o.pollMs ?? POLL_MS, sleep)));
  return { base, at, chains: Object.fromEntries(CHAINS.map((c, i) => [c, runs[i]])) };
}

/** The verdict on one recorded run: PASS, FAIL or INCONCLUSIVE, with a line per chain and per dropped token. */
export function judge(run) {
  const lines = [];
  let bad = false;
  let seen = 0;
  for (const c of CHAINS) {
    const r = run.chains?.[c];
    if (r?.lists?.status !== 200 || !(r.lists.tokens > 0)) {
      bad = true;
      lines.push(`BAD ${c}: GET /v1/market/lists?chain=${c} answers ${r?.lists?.status}, ${r?.lists?.tokens ?? 0} tokens`);
      continue;
    }
    const dropped = Array.isArray(r.dropped) ? r.dropped : [];
    if (dropped.length === 0) {
      lines.push(`--  ${c}: none of the first answer's ${r.lists.tokens} tokens left the lists in ${Math.round(r.waitedMs / 1000)} s (${r.reads} reads): proves nothing`);
      continue;
    }
    seen++;
    lines.push(`ok  ${c}: ${dropped.length} of the first answer's ${r.lists.tokens} tokens gone from the lists after ${Math.round(r.waitedMs / 1000)} s`);
    for (const d of dropped) {
      const ok = d.status === 200 && d.shape === "tape";
      if (!ok) bad = true;
      lines.push(`${ok ? "ok " : "BAD"} ${c} trades ${d.address} (dropped): ${d.status}${d.status === 200 ? ` ${d.shape}` : ` ${d.body ?? ""}`}${d.error ? ` ${d.error}` : ""} in ${d.ms} ms`);
    }
  }
  return { verdict: bad ? "FAIL" : seen === 0 ? "INCONCLUSIVE" : "PASS", lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE), fetch, { waitMs: Number(opt("--wait-ms", WAIT_MS)) });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${run.base})`);
    process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 3);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
