#!/usr/bin/env node
// Live check of card evm-pool-index-route: a coin's EVM quote reads its pools from the device's pool index. On Base and
// Robinhood it syncs each chain's index cold on the venue's two index readers (evmPoolIndexRefresh, through the kit's
// public entry, as the page does), then quotes THREE coins, each by the tap's own quote (evmPoolBuyQuoteTap) once cold
// and once warm, recording each tap's time, its posts and calls to each host, its answers of 429 and every eth_getLogs
// it sent: its blocks, whether it names a currency, and whether it was sent before or after the tap answered (a scan's
// gap read once the quote has answered). It passes when, on each chain:
//   - the index synced whole and was served (its N, coversThrough);
//   - no tap asked any block to N again: every eth_getLogs of every tap, before or after its answer, starts past N (the
//     index fed the token's scan, its markets scans and the warm round; only the blocks the index does not cover are
//     the bounded scan's);
//   - every tap ended in a quote or a true named refusal (a provider's fault, rpc_error, rpc_disagree or stale_quote,
//     fails it: the quote is the kit's on real providers).
// The 429s, the currency getLogs and the times are reported per tap, never judged here (base-quotes-inside-provider-limits
// judges 429s and the warm bound).
// Runs: pending evm-pool-index-route, its place in a host's list is set at the merge: it runs this tree's kit on real
// mainnet providers, not a deployed build, a Base index read cold took 316 s with 33 answers of 429 from its second
// reader (19 Nov 09:0xZ), and a provider's fault fails a tap (the routing itself is held by
// packages/kit/test/evm-quote-attacks.test.ts F10, F10p and F10w)
//   node scripts/live-checks/evm-pool-index-route.mjs [--record <file>] [--no-index]
//   node scripts/live-checks/evm-pool-index-route.mjs --answer <file>     judge a recorded run
// --no-index quotes with no index served (the quote's bounded scan alone, the state this check refuses): the recorded
// bad answer. PASS exit 0, FAIL 1, error 2. Reads only: no key, no transaction, no money moves.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT } from "./provider-answer.mjs";
import { COINS as LISTED } from "./base-quotes-inside-provider-limits.mjs";
import { NAMED, QUOTE_AMOUNT } from "./evm-buy-and-sell-on-mainnet.mjs";
import { evmPoolBuyQuote, evmPoolBuyQuoteTap, evmPoolIndexRefresh } from "../../packages/kit/src/index.ts";

export const KEY = "evm-pool-index-route";
export const CHAINS = Object.freeze(["base", "robinhood"]);
/** Three coins a chain (F10: three tokens on one index), the first three base-quotes-inside-provider-limits names. */
export const COINS = Object.freeze(Object.fromEntries(CHAINS.map((c) => [c, Object.freeze(Object.fromEntries(Object.entries(LISTED[c]).slice(0, 3)))])));
/** The time left after a tap for its gap reads sent once it answered, before the next tap starts. */
export const SETTLE_MS = 2_000;

const TOPIC_SET = (t) => t !== null && t !== undefined;

/** The verdict on one run { chains }: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const chain of CHAINS) {
    const c = run?.chains?.[chain];
    const ix = c?.index;
    const n = ix?.served === true && Number.isSafeInteger(ix.covers) ? ix.covers : null;
    say(n !== null, `[${chain}] the pool index synced whole and served: ${ix ? `${ix.pools} pools to ${ix.covers} in ${ix.ms} ms` : "not read"}`);
    const rows = Array.isArray(c?.rows) ? c.rows : [];
    for (const coin of Object.keys(COINS[chain])) say(rows.some((r) => String(r.coin).toLowerCase() === coin), `[${chain}] ${COINS[chain][coin]} ${coin} is quoted`);
    for (const r of rows) {
      const runs = Array.isArray(r.runs) ? r.runs : [];
      say(runs.length === 2 && runs.every((u) => u.ok === true || NAMED.includes(u.code)), `[${chain}] ${r.symbol} ends in a quote or a true named refusal: ${runs.map((u) => `${u.kind} ${u.ok ? "ok" : u.code}`).join(", ") || "no run"}`);
      for (const u of runs) {
        const logs = Array.isArray(u.logs) ? u.logs : [];
        const deep = logs.filter((l) => n === null || !(l.from > n));
        say(deep.length === 0, `[${chain}] ${r.symbol} ${u.kind}: no getLogs at or below the index's N ${n ?? "(none)"}: ${deep.length} of ${logs.length}${deep.length > 0 ? `, the lowest from ${Math.min(...deep.map((l) => l.from))}` : ""}`);
        const before = logs.filter((l) => !l.after);
        const s429 = Object.values(u.hosts ?? {}).reduce((k, h) => k + (h.s429 ?? 0), 0);
        lines.push(`    [${chain}] ${r.symbol} ${u.kind} ${u.ms} ms, ${Object.values(u.hosts ?? {}).reduce((k, h) => k + h.requests, 0)} posts, ${s429} answers of 429; getLogs before its answer ${before.length} (${before.filter((l) => l.currency).length} by currency), after ${logs.length - before.length} (${logs.filter((l) => l.after && l.currency).length} by currency)`);
      }
    }
  }
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** Both chains' taps on real mainnet providers; `index` false quotes with none served. */
export async function read(fetchFn = fetch, { index: withIndex = true } = {}) {
  let hosts = {};
  let logs = [];
  let after = false;
  const real = globalThis.fetch;
  const counted = async (url, init) => {
    const host = new URL(typeof url === "string" ? url : url.url).host;
    const h = (hosts[host] ??= { requests: 0, calls: 0, s429: 0 });
    h.requests++;
    try {
      const b = JSON.parse(typeof init?.body === "string" ? init.body : "null");
      const calls = Array.isArray(b) ? b : b === null ? [] : [b];
      h.calls += calls.length;
      for (const x of calls) {
        if (x?.method !== "eth_getLogs") continue;
        const f = x.params?.[0] ?? {};
        logs.push({ host, from: Number(f.fromBlock), to: Number(f.toBlock), currency: Array.isArray(f.topics) && f.topics.slice(1).some(TOPIC_SET), after });
      }
    } catch {
      h.calls++;
    }
    const r = await fetchFn(url, init);
    if (r.status === 429) h.s429++;
    return r;
  };
  const take = () => {
    const out = { hosts, logs };
    hosts = {};
    logs = [];
    return out;
  };
  globalThis.fetch = counted;
  try {
    const chains = {};
    for (const chain of CHAINS) {
      take();
      const t = performance.now();
      const { sync, served } = withIndex ? await evmPoolIndexRefresh(chain, null, counted) : { sync: null, served: false };
      const index = { ms: Math.round(performance.now() - t), served, covers: sync?.coversThrough ?? null, pools: sync?.pools?.length ?? null, error: sync?.error?.code ?? null, hosts: take().hosts };
      const rows = [];
      for (const [coin, symbol] of Object.entries(COINS[chain])) {
        const runs = [];
        for (const kind of ["cold", "warm"]) {
          take();
          after = false;
          const t0 = performance.now();
          let end;
          try {
            const q = await evmPoolBuyQuoteTap({ chain, token: coin, amountIn: QUOTE_AMOUNT, slippageBps: 300 }, { quote: (req) => evmPoolBuyQuote(req) });
            end = { ok: true, route: q.route };
          } catch (e) {
            end = { ok: false, code: e?.code ?? "thrown", message: String(e?.message ?? e).slice(0, 200) };
          }
          const ms = Math.round(performance.now() - t0);
          after = true;
          await new Promise((go) => setTimeout(go, SETTLE_MS));
          runs.push({ kind, ms, ...end, ...take() });
        }
        rows.push({ coin, symbol, runs });
      }
      chains[chain] = { index, rows };
    }
    return { readAt: new Date().toISOString(), index: withIndex, chains };
  } finally {
    globalThis.fetch = real;
  }
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = a.includes("--answer") ? JSON.parse(readFileSync(a[a.indexOf("--answer") + 1], "utf8")) : await read(fetch, { index: !a.includes("--no-index") });
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
