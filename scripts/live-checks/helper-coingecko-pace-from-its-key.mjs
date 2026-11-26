#!/usr/bin/env node
// Live check of card helper-coingecko-pace-from-its-key: the deployed helper paces CoinGecko's keyed charts at the rate
// and month CoinGecko names for its key, read at the helper's start (GET /api/v3/key), never at a copy of that rate the
// settings hold. Before the card the pace was COINGECKO_CALLS_PER_MIN alone, set from the same read on 13 Nov: the
// deployed helper served about 88 calls a minute in the 26 Nov 01:16Z burst of listed charts while 212 caller reads were
// refused at the minute pace, and the key's /key answered 300 a minute (read from the Mac 26 Nov 03:2xZ).
// Read, with no key and no transaction: GET <helper>/v1/health with Origin APP, its X-Helper-Coingecko-Pace header
// (apps/helper/src/server.ts CG_PACE_HEADER, written by data/coingecko.ts coingeckoNamed).
// Judged: 200, and the header names a whole rate a minute and a whole day "from the key's plan <name>" (with "the
// settings say <n>" when the settings' copy differs, named, not failed). "from the settings" FAILs: the start could not
// read the key's plan, so the pace is the hand-set copy. "none" FAILs: the helper has no CoinGecko key and every chart
// is keyless. No header FAILs: a helper before the card.
// After: helper
//   node scripts/live-checks/helper-coingecko-pace-from-its-key.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-coingecko-pace-from-its-key";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** The header the helper names its CoinGecko pace in (server.ts CG_PACE_HEADER), lowercase as fetch's Headers give it. */
export const HEADER = "x-helper-coingecko-pace";
/** "<n> a minute, <d> a day, from the key's plan <name>" and an optional " (the settings say <m>)" (coingeckoNamed). */
const FROM_KEY = /^([1-9][0-9]*) a minute, ([1-9][0-9]*) a day, from the key's plan ([A-Za-z0-9 +_?-]{1,32}?)(?: \(the settings say ([1-9][0-9]*)\))?$/;
const FROM_SETTINGS = /^([1-9][0-9]*) a minute, ([0-9]+) a day, from the settings$/;

/** The check on one recorded run: { status, headers }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "GOOD" : "BAD"} ${text}`);
  say(run?.status === 200, `GET /v1/health answers ${run?.status ?? "nothing"}`);
  const v = run?.headers?.[HEADER];
  const key = typeof v === "string" ? v.match(FROM_KEY) : null;
  if (key !== null) {
    say(true, `CoinGecko paced from the key's plan ${key[3]}: ${key[1]} calls a minute, ${key[2]} a day`);
    if (key[4] !== undefined) lines.push(`NOTE the settings' copy says ${key[4]} a minute, the key's plan ${key[1]}`);
  } else if (typeof v === "string" && FROM_SETTINGS.test(v)) say(false, `CoinGecko paced from the settings, not the key's plan: "${v}"`);
  else if (v === "none") say(false, "the helper names no CoinGecko key: every chart read is keyless");
  else say(false, `no CoinGecko pace named (${HEADER}: ${v === undefined ? "none" : JSON.stringify(String(v).slice(0, 120))})`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(base = BASE, fetchFn = fetch) {
  const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/health`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(15_000) });
  await r.text();
  return { base, status: r.status, headers: { [HEADER]: r.headers.get(HEADER) ?? undefined, "x-helper-commit": r.headers.get("x-helper-commit") ?? undefined } };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base}, commit ${run.headers["x-helper-commit"] ?? "unnamed"})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
