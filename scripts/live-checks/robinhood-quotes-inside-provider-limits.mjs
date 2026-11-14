#!/usr/bin/env node
// Live check robinhood-quotes-inside-provider-limits: a warm Robinhood buy tap is quoted within the warm bound and stays
// inside every provider's pace. Release 131's taps sent rpc.mainnet.chain.robinhood.com 12 to 252 posts each (paced at
// 1 a second, apps/helper/src/limits/limits.ts PROVIDER_PACE), one getLogs batch for each currency's scan gap, and got
// hundreds of 429s (live run 43519510822, FOBO 105, CASHCAT 128, HOOKR 54, RYFT 21; warm taps 1.4-9.6 s). It reads, after
// every sign deploy, the quotes half of evm-buy-and-sell-on-mainnet (readQuotes: the device's own Robinhood pool index
// synced cold on its two readers, then the helper's top QUOTE_ROWS Robinhood rows and FRONG, each quoted by the tap's
// own quote, evmPoolBuyQuoteTap, once cold and WARM_RUNS times warm; read only, nothing signed or sent), and passes
// when every row's taps end in a quote or a true named refusal, no tap gets a 429, every warm tap ends within
// WARM_MAX_MS, and each warm tap asks each paced provider no more than its pace takes in WARM_MAX_MS (its burst and
// WARM_MAX_MS of its rate, by the post or the call as limits.ts paces it). The kit asks the providers; this check reads
// no JSON-RPC answer itself.
// Runs: pending robinhood-quotes-inside-provider-limits, warm Robinhood taps still take 2.3-7.7 s and ask dRPC past its pace after step 2, and FRONG's taps get 4 answers of 429 from dRPC and bloXroute (none from Robinhood's own RPC in 24 taps, 2026-11-14 23:5xZ), so a list would undo the next sign deploy; it moves to "After: sign" with a "Bundle: out" line with the card's last part (the quotes are the kit's own on real mainnet providers, which a build cannot hold; the scan's count is held by packages/kit/test/evm-quote-attacks.test.ts)
//   node scripts/live-checks/robinhood-quotes-inside-provider-limits.mjs [--record <file>]
//   node scripts/live-checks/robinhood-quotes-inside-provider-limits.mjs --answer <file>     judge a recorded run
//   PASS exit 0, FAIL 1, error 2.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT } from "./provider-answer.mjs";
import { NAMED, readQuotes, WARM_MAX_MS, WARM_RUNS } from "./evm-buy-and-sell-on-mainnet.mjs";

export const KEY = "robinhood-quotes-inside-provider-limits";
/** The owner's coin (card robinhood-quotes-inside-provider-limits), quoted beside the helper's top rows. */
export const COINS = Object.freeze({ "0x6245e67affa44a23077f0ea7f981a8dc743a0c47": "FRONG" });

/** limits.ts PROVIDER_PACE, read as text (the kit's check loads no helper file): { host: { perS, burst, unit } }. */
export function paces(src = readFileSync(new URL("../../apps/helper/src/limits/limits.ts", import.meta.url), "utf8")) {
  const at = src.indexOf("export const PROVIDER_PACE");
  const body = at < 0 ? "" : src.slice(at, src.indexOf("};", at));
  const out = {};
  for (const m of body.matchAll(/"https:\/\/([^"/]+)[^"]*": \{ perS: ([\d.]+), burst: (\d+), unit: "(post|call)"/g)) out[m[1]] = { perS: Number(m[2]), burst: Number(m[3]), unit: m[4] };
  return out;
}

/** The verdict on one run { quotes: { chains: { robinhood } } }: { ok, verdict, lines }. */
export function judge(run, pace = paces()) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const c = run?.quotes?.chains?.robinhood;
  const ix = c?.index;
  say(Object.keys(pace).length > 0, `limits.ts paces ${Object.keys(pace).length} providers`);
  say(ix?.served === true, `[robinhood] the pool index synced and served: ${ix ? `${ix.pools} pools to ${ix.covers} in ${ix.ms} ms` : "not read"}`);
  const rows = Array.isArray(c?.rows) ? c.rows : [];
  say(rows.length > Object.keys(COINS).length, `[robinhood] rows read: ${rows.length}`);
  for (const coin of Object.keys(COINS)) say(rows.some((r) => String(r.coin).toLowerCase() === coin), `[robinhood] ${COINS[coin]} ${coin} is quoted`);
  for (const r of rows) {
    const runs = Array.isArray(r.runs) ? r.runs : [];
    const warm = runs.filter((u) => u.kind === "warm");
    const s429 = runs.reduce((n, u) => n + Object.values(u.hosts ?? {}).reduce((m, h) => m + (h.s429 ?? 0), 0), 0);
    say(runs.length === 1 + WARM_RUNS && runs.every((u) => u.ok === true || NAMED.includes(u.code)), `[robinhood] ${r.symbol} ${r.coin} ends in a quote or a true named refusal: ${runs.map((u) => (u.ok ? "ok" : u.code)).join(",") || "no run"}`);
    say(s429 === 0, `[robinhood] ${r.symbol} taps got ${s429} answers of 429`);
    say(warm.length === WARM_RUNS && warm.every((u) => u.ms <= WARM_MAX_MS), `[robinhood] ${r.symbol} warm taps end within ${WARM_MAX_MS} ms: ${runs.map((u) => `${u.kind} ${u.ms}`).join(", ")}`);
    // each paced provider a warm tap asked: its posts or calls against its burst and WARM_MAX_MS of its rate
    const over = [];
    const most = {};
    for (const u of warm) {
      for (const [host, h] of Object.entries(u.hosts ?? {})) {
        const p = pace[host];
        if (p === undefined) continue;
        const n = p.unit === "post" ? h.requests : h.calls;
        const bound = Math.floor(p.burst + (p.perS * WARM_MAX_MS) / 1000);
        most[host] = Math.max(most[host] ?? 0, n);
        if (!(Number.isInteger(n) && n <= bound)) over.push(`${host} ${n} ${p.unit}s of ${bound}`);
      }
    }
    say(warm.length > 0 && over.length === 0, `[robinhood] ${r.symbol} warm taps stay inside each provider's pace: ${over.length > 0 ? over.join("; ") : Object.entries(most).map(([h, n]) => `${h} ${n} at most`).join(", ") || "no paced provider asked"}`);
  }
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** The Robinhood quotes, real mainnet reads only. */
export async function read(fetchFn = fetch) {
  return { readAt: new Date().toISOString(), quotes: await readQuotes(fetchFn, { chains: ["robinhood"], coins: { robinhood: COINS } }) };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = a.includes("--answer") ? JSON.parse(readFileSync(a[a.indexOf("--answer") + 1], "utf8")) : await read(fetch);
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
