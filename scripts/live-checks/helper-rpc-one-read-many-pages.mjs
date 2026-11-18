#!/usr/bin/env node
// Live check of card helper-rpc-one-read-many-pages: HELPER_HOST's keyed Solana route sends one upstream read for the
// pages that ask the SOL price in the same slot (apps/helper/src/rpc/rpc.ts sharedRead: a read of the named public
// accounts, SHARED_ACCOUNTS, joins the same read in flight or is answered from it for SHARED_HOLD_MS), and never shares
// a read naming any other account. With the signing page's Origin it sends, at once:
//   - PAGES reads of Pyth's SOL/USD account (the kit's POOL_USD_FEEDS.solana) as the page sends them (getMultipleAccounts,
//     base64, confirmed), each its own id: each must answer 200 with its own id and the one account, all the same
//     result (one read's), and all but one marked a shared answer (Server-Timing rpc-cache;desc="hit");
//   - two reads of an account off the list (the pool's funder, a plain system account like a user's): neither marked.
// Before the card (the deployed 27c4d830a, 18 Nov 07:00Z) no answer was marked: 4 reads at once, 2 different results. A read the shared
// module calls a no-answer (a 429, a 5xx, no answer) is the moment's: INCONCLUSIVE (exit 3).
// After: helper
//   node scripts/live-checks/helper-rpc-one-read-many-pages.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, so the check's test
//   can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { classify, EXIT } from "./provider-answer.mjs";

const KEY = "helper-rpc-one-read-many-pages";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
/** Pyth's SOL/USD account (packages/kit/src/price/pool-usd.ts POOL_USD_FEEDS.solana.account). */
export const PYTH = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
/** An account off the shared list: the mainnet pool's funder (contracts/pool-solana/deployments/mainnet.json), a plain
 *  system account, as a user's one-time account is. */
export const OTHER = "7Y7omJGVsxTm797X6ytUuskfeQ2kjVs4UK4Hip2hKkvB";
export const PAGES = 4;
const HIT = /rpc-cache;desc="hit"/;
const config = { encoding: "base64", commitment: "confirmed" };

async function post(base, id, account, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/rpc/solana`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: SIGN, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "getMultipleAccounts", params: [[account], config] }),
      signal: AbortSignal.timeout(20_000),
    });
    return { id, account, status: r.status, timing: r.headers.get("server-timing") ?? "", ms: Math.round(performance.now() - t0), body: (await r.text()).slice(0, 4_000) };
  } catch (e) {
    return { id, account, status: 0, timing: "", ms: Math.round(performance.now() - t0), body: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function read(base = BASE, fetchFn = fetch) {
  const at = new Date().toISOString();
  const asks = [...Array.from({ length: PAGES }, (_, i) => [`price-${i}`, PYTH]), ["other-0", OTHER], ["other-1", OTHER]];
  const reads = await Promise.all(asks.map(([id, a]) => post(base, id, a, fetchFn)));
  return { base, at, reads };
}

/** An answer's result as text and its one account, or what is wrong. */
function resultOf(r) {
  try {
    const j = JSON.parse(r.body);
    if (j.id !== r.id) return { bad: `id ${JSON.stringify(j.id)}, not ${r.id}` };
    if (!Array.isArray(j.result?.value) || j.result.value.length !== 1) return { bad: "not one account's answer" };
    return { text: JSON.stringify(j.result) };
  } catch {
    return { bad: "not JSON" };
  }
}

/** The check on one recorded run. */
export function judge({ reads }) {
  const lines = [];
  let bad = false, quiet = false;
  const say = (ok, text) => ((bad ||= !ok), lines.push(`${ok ? "ok " : "BAD"} ${text}`));
  const host = new URL(BASE).host;
  const answered = [];
  for (const r of reads ?? []) {
    const a = classify(host, r.status, r.body, { page: true });
    if (a.noAnswer !== undefined) {
      quiet = true;
      lines.push(`--  ${r.id}: ${a.noAnswer}`);
      continue;
    }
    const res = r.status === 200 ? resultOf(r) : { bad: `${r.status} ${String(r.body).slice(0, 120)}` };
    if (res.bad !== undefined) {
      say(false, `${r.id}: ${res.bad}`);
      continue;
    }
    answered.push({ ...r, text: res.text, hit: HIT.test(r.timing) });
  }
  const price = answered.filter((r) => r.account === PYTH);
  const other = answered.filter((r) => r.account === OTHER);
  if (price.length === PAGES) {
    say(new Set(price.map((r) => r.text)).size === 1, `${PAGES} price reads at once: ${new Set(price.map((r) => r.text)).size} result(s), each with its own id`);
    const hits = price.filter((r) => r.hit).length;
    say(hits >= PAGES - 1, `${hits} of ${PAGES} price reads served from one shared read (Server-Timing rpc-cache hit; at least ${PAGES - 1})`);
  } else if (!bad) quiet = true;
  for (const r of other) say(!r.hit, `${r.id} (an account off the list): ${r.hit ? "served a shared answer" : "its own read"} (${r.timing})`);
  if (other.length < 2 && !bad) quiet = true;
  const verdict = bad ? "FAIL" : quiet ? "INCONCLUSIVE" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE), fetch);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
