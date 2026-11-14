#!/usr/bin/env node
// Live check base-quotes-inside-provider-limits: a Base or Robinhood buy tap gets no answer of 429 from any provider and
// a warm tap is quoted within the warm bound. Release 132's sign live run 43540749124 (2026-11-14 01:28Z, job
// evm-buy-and-sell-on-mainnet) read [base] AO D F 10 answers of 429 and SOSF 25; release 133's run 43546443270 (attempt
// 2, 02:38Z) [base] VVV 1 and SNDKc 10, [robinhood] WALLET 61 and STONKBROKER 1, with warm taps of 2.9-7.5 s. It reads,
// after every sign deploy, the quotes half of evm-buy-and-sell-on-mainnet (readQuotes: each chain's pool index synced
// cold on its two readers, then the helper's top QUOTE_ROWS rows and the coins COINS names, each quoted by the tap's own
// quote, evmPoolBuyQuoteTap, once cold and WARM_RUNS times warm; read only, nothing signed or sent), and passes when
// every row's taps end in a quote or a true named refusal, no tap (cold or warm) gets a 429, and every warm tap ends
// within WARM_MAX_MS. Each 429 line names the hosts that answered it, and each row reports the most posts and calls a
// warm tap sent each provider. The kit asks the providers; this check reads no JSON-RPC answer itself.
// Runs: pending base-quotes-inside-provider-limits, after the card's first part (a throttled request moves to the next
// provider at once) the Mac's runs still read warm taps past 2 s on both chains (Base's not_allowed coins ask two whole
// v3 quotes a tap, 2.1-2.6 s; Robinhood's taps 2.4-9.3 s on their rounds of reads) and a few answers of 429 (Robinhood's
// own RPC and dRPC 3 in 32 taps; Base's publicnode 5 in 36 under back-to-back taps), so a list would undo the next sign
// deploy; it moves to "After: sign" with a "Bundle: out" line (the quotes are the kit's own on real mainnet providers,
// which a build cannot hold; the throttle's move is held by packages/kit/test/evm-quote-attacks.test.ts T7c) once a run passes
//   node scripts/live-checks/base-quotes-inside-provider-limits.mjs [--record <file>]
//   node scripts/live-checks/base-quotes-inside-provider-limits.mjs --answer <file>     judge a recorded run
//   PASS exit 0, FAIL 1, error 2.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT } from "./provider-answer.mjs";
import { NAMED, readQuotes, WARM_MAX_MS, WARM_RUNS } from "./evm-buy-and-sell-on-mainnet.mjs";

export const KEY = "base-quotes-inside-provider-limits";
export const CHAINS = Object.freeze(["base", "robinhood"]);
/** The coins whose taps got 429s or slow warm taps in releases 132 and 133's sign live runs (and FRONG, the owner's),
 *  quoted beside each chain's top rows. */
export const COINS = Object.freeze({
  base: Object.freeze({
    "0x3776862152528a243880a7a2ade1e6a84bd97d5a": "AO D F",
    "0x20c82ab177bc31f547bf76ba163e69342bd785c5": "SOSF",
    "0xb2000000000000000000002feb517dfec7415344": "OUSD",
    "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf": "VVV",
    "0xb200000000000000000000397293cb8cda9a10c5": "SNDKc",
  }),
  robinhood: Object.freeze({
    "0x0339f5459fc690ac85f1782e15782a151b4a9e1b": "WALLET",
    "0xe934e36a439c94017b64a3fece66af12099abf50": "STONKBROKER",
    "0xada8b1e6c4bab1ce2dba0ad4a08047bcd00b1904": "NVDAx3L",
    "0x020bfc650a365f8bb26819deaabf3e21291018b4": "CASHCAT",
    "0x6245e67affa44a23077f0ea7f981a8dc743a0c47": "FRONG",
  }),
});

/** The verdict on one run { quotes: { chains } }: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const chain of CHAINS) {
    const c = run?.quotes?.chains?.[chain];
    const ix = c?.index;
    say(ix?.served === true, `[${chain}] the pool index synced and served: ${ix ? `${ix.pools} pools to ${ix.covers} in ${ix.ms} ms` : "not read"}`);
    const rows = Array.isArray(c?.rows) ? c.rows : [];
    say(rows.length > 0, `[${chain}] rows read: ${rows.length}`);
    for (const coin of Object.keys(COINS[chain])) say(rows.some((r) => String(r.coin).toLowerCase() === coin), `[${chain}] ${COINS[chain][coin]} ${coin} is quoted`);
    for (const r of rows) {
      const runs = Array.isArray(r.runs) ? r.runs : [];
      const warm = runs.filter((u) => u.kind === "warm");
      const by = {};
      const most = {};
      for (const u of runs) {
        for (const [host, h] of Object.entries(u.hosts ?? {})) {
          if ((h.s429 ?? 0) > 0) by[host] = (by[host] ?? 0) + h.s429;
          if (u.kind === "warm") most[host] = [Math.max(most[host]?.[0] ?? 0, h.requests ?? 0), Math.max(most[host]?.[1] ?? 0, h.calls ?? 0)];
        }
      }
      const s429 = Object.values(by).reduce((n, k) => n + k, 0);
      say(runs.length === 1 + WARM_RUNS && runs.every((u) => u.ok === true || NAMED.includes(u.code)), `[${chain}] ${r.symbol} ${r.coin} ends in a quote or a true named refusal: ${runs.map((u) => (u.ok ? "ok" : u.code)).join(",") || "no run"}`);
      say(runs.length > 0 && s429 === 0, `[${chain}] ${r.symbol} taps got ${s429} answers of 429${s429 > 0 ? ` (${Object.entries(by).map(([h, n]) => `${h} ${n}`).join(", ")})` : ""}`);
      say(warm.length === WARM_RUNS && warm.every((u) => u.ms <= WARM_MAX_MS), `[${chain}] ${r.symbol} warm taps end within ${WARM_MAX_MS} ms: ${runs.map((u) => `${u.kind} ${u.ms}`).join(", ")}`);
      lines.push(`    [${chain}] ${r.symbol} a warm tap's most posts/calls: ${Object.entries(most).map(([h, [p, k]]) => `${h} ${p}/${k}`).join(", ") || "none"}`);
    }
  }
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** Both chains' quotes, real mainnet reads only. */
export async function read(fetchFn = fetch) {
  return { readAt: new Date().toISOString(), quotes: await readQuotes(fetchFn, { chains: [...CHAINS], coins: COINS }) };
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
