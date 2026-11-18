#!/usr/bin/env node
// Live check of card helper-rpc-one-read-many-pages: HELPER_HOST's keyed Solana route sends one upstream read for the
// pages that ask the SOL price in the same slot (apps/helper/src/rpc/rpc.ts sharedRead: a read of the named public
// accounts, SHARED_ACCOUNTS, joins the same read in flight or is answered from it for SHARED_HOLD_MS), and never shares
// a read naming any other account. With the signing page's Origin it sends, at once:
//   - PAGES reads of Pyth's SOL/USD account (the kit's POOL_USD_FEEDS.solana) as the page sends them (getMultipleAccounts,
//     base64, confirmed), each its own id: each must answer 200 with its own id and the one account, all the same
//     result (one read's), and all but one marked a shared answer (Server-Timing rpc-cache;desc="hit");
//   - two reads of an account off the list (the pool's funder, a plain system account like a user's): neither marked.
// Before the card (the deployed 27c4d830a, 18 Nov 07:00Z) no answer was marked: 4 reads at once, 2 different results.
// Every read goes through the shared module (provider-answer.mjs rpcAnswer, with its id, the page's Origin and the
// Server-Timing header kept): a read it calls a no-answer (a 429, a 5xx, no answer), or one answered only on its second
// try (no longer at the same moment), is the moment's: INCONCLUSIVE (exit 3).
// After: helper
//   node scripts/live-checks/helper-rpc-one-read-many-pages.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, so the check's test
//   can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

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
  const a = await rpcAnswer(`${base.replace(/\/$/, "")}/v1/rpc/solana`, "getMultipleAccounts", [[account], config], { fetchFn, timeoutMs: 20_000, headers: { origin: SIGN }, redirect: "manual", keep: ["server-timing"], id });
  return { id, account, ms: Math.round(performance.now() - t0), answer: a };
}

export async function read(base = BASE, fetchFn = fetch) {
  const at = new Date().toISOString();
  const asks = [...Array.from({ length: PAGES }, (_, i) => [`price-${i}`, PYTH]), ["other-0", OTHER], ["other-1", OTHER]];
  const reads = await Promise.all(asks.map(([id, a]) => post(base, id, a, fetchFn)));
  return { base, at, reads };
}

/** A read's result as text and its one account, or what is wrong. */
function resultOf(r) {
  const a = r.answer;
  if (a.status !== 200) return { bad: `HTTP ${a.status} ${JSON.stringify(a.error ?? a.result ?? null).slice(0, 120)}` };
  if (a.error !== undefined) return { bad: `error ${JSON.stringify(a.error).slice(0, 120)}` };
  if (a.answerId !== r.id) return { bad: `id ${JSON.stringify(a.answerId)}, not ${r.id}` };
  if (!Array.isArray(a.result?.value) || a.result.value.length !== 1) return { bad: "not one account's answer" };
  return { text: JSON.stringify(a.result) };
}

/** The check on one recorded run. */
export function judge({ reads }) {
  const lines = [];
  let bad = false, quiet = false;
  const say = (ok, text) => ((bad ||= !ok), lines.push(`${ok ? "ok " : "BAD"} ${text}`));
  const answered = [];
  for (const r of reads ?? []) {
    const a = r.answer;
    if (a.noAnswer !== undefined) {
      quiet = true;
      lines.push(`--  ${r.id}: ${a.noAnswer}`);
      continue;
    }
    if (a.tries !== 1) {
      quiet = true;
      lines.push(`--  ${r.id}: answered on its second try, not at the same moment as the others`);
      continue;
    }
    const res = resultOf(r);
    if (res.bad !== undefined) {
      say(false, `${r.id}: ${res.bad}`);
      continue;
    }
    answered.push({ ...r, text: res.text, timing: a.kept?.["server-timing"] ?? "", hit: HIT.test(a.kept?.["server-timing"] ?? "") });
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
