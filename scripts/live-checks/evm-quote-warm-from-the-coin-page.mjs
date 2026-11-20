#!/usr/bin/env node
// Live check of card evm-quote-warm-from-the-coin-page: a fresh device's first quote of a Base coin is a warm one,
// never a cold one, because the coin page warmed it. The box asks pool.buy.dry with no amount as it opens on a coin,
// and the page then runs the kit's evmPoolBuyWarm (one tap quote at EVM_BUY_WARM_IN); the tap's quote of the typed
// amount then asks the reads the warm held (the token's plan, made again at the tap's amount) in its first round. At
// main nothing warmed the coin: a fresh device's first tap of Base 0x07b3d9 took 7.3 s from the Mac (2026-11-18
// 08:2xZ), 5.2 to 7.7 s in card evm-cold-multihop-quote-inside-the-kpi's runs.
// Judged, on the commit's kit as the device runs it (every read a background one, as the page's dry):
// - one sync from SIGN_HOST's Base snapshot (kit evmPoolIndexRefresh) ends whole, so the warm starts on the index;
// - each coin of COINS is warmed (kit evmPoolBuyWarm) and then tapped at TAP_IN (kit evmPoolBuyQuoteTap): the warm
//   ends within WARM_MAX_MS, the tap with a quote or a named refusal, never a provider's fault, within TAP_MAX_MS;
// - the tap asked the kit once: the warm left the coin's route as the tap's first, so no refusal is followed;
// - the tap's posts and eth_calls are recorded beside its time (a round count is not judged: a provider's hedged spare
//   still out across rounds hides a round from any count made from outside the kit);
// - no Base quote provider or index reader answers 429, in any step: each 429 is printed with the step it was met
//   in (`s429At`: the sync, a coin's warm or its tap), and every one fails the run, a sync's too (the page meets it).
// Reads only: no key, no transaction, no money moves.
// After: sign
// Bundle: out SIGN_HOST's Base snapshot, Base's providers
//   node scripts/live-checks/evm-quote-warm-from-the-coin-page.mjs [--sign <origin>] [--site <dir>] [--record <file>].
//     --site reads the snapshot from a build folder (<dir>/evm-index/base.json) instead of SIGN_HOST: a commit's run
//     before its deploy. PASS exit 0, FAIL exit 1, error exit 2. --record writes the run for the test's replay.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evmPoolBuyQuote, evmPoolBuyQuoteTap, evmPoolBuyWarm, evmPoolIndexFromSnapshot, evmPoolIndexRefresh } from "../../packages/kit/src/index.ts";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { EXIT } from "./provider-answer.mjs";

const KEY = "evm-quote-warm-from-the-coin-page";
export const SIGN = "https://confidential.unrealized.trade";
/** The coins: Base 0x07b3d9 (its market WETH-USDC-coin on Uniswap v3) and a Clanker coin on Uniswap v4. */
export const COINS = ["0x07b3d902783c3c12b077508c3b5c00113d1291d0", "0x530ac7167531304a854087204092a2bf83051b07"];
/** The tap's amount, wei (another than the warm's, as a typed one is). */
export const TAP_IN = 1_500_000_000_000_000n;
/** A warm on a fresh device: a cold tap's bound (evm-cold-multihop-quote-inside-the-kpi's FIRST_MAX_MS). */
export const WARM_MAX_MS = 8_000;
/** The tap after the warm: a warm quote's, never a cold one's (cold 5.2 to 7.7 s on 0x07b3d9). Not the quote KPI of
 *  1 s: from the Mac at a load of about 20 the Clanker coin's tap took 770 ms and 0x07b3d9's 1.2 to 3.3 s (its
 *  multi-hop routes through X still take a round or two after the first, 18 Nov 08:4xZ). */
export const TAP_MAX_MS = 3_000;
const FAULTS = new Set(["rpc_error", "rpc_disagree", "stale_quote"]);
const READ_MS = 30_000;

/** The verdict on a run { snapshot: { status, through?, pools? }, sync: { ms, served } | null, coins: [{ coin, warm:
 *  { ms }, tap: { ms, out?, code?, asks, posts, calls } }], s429: { host: n } }: { ok, lines }. */
export function check(run) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok " : "BAD"} ${text}`);
  };
  const s = run?.snapshot ?? {};
  say(s.status === 200 && Number.isSafeInteger(s.through) && s.pools > 0, `[base] snapshot HTTP ${s.status ?? "not read"}, ${s.pools ?? 0} pools, through ${s.through ?? "none"}`);
  say(run?.sync?.served === true, `[base] a fresh device's sync from it ${run?.sync ? `${run.sync.served ? "whole" : "partial"} in ${run.sync.ms} ms` : "not run"}`);
  const coins = Array.isArray(run?.coins) ? run.coins : [];
  say(coins.length === COINS.length && coins.every((c, i) => c?.coin === COINS[i]), `[base] ${coins.length} of ${COINS.length} coins warmed and tapped`);
  for (const c of coins) {
    const w = c?.warm;
    say(Number.isFinite(w?.ms) && w.ms <= WARM_MAX_MS, `[base] ${c?.coin} warm ended in ${w?.ms ?? "?"} ms (at most ${WARM_MAX_MS} ms)`);
    const q = c?.tap;
    const ended = q !== undefined && Number.isFinite(q.ms) && (typeof q.out === "string" || (typeof q.code === "string" && !FAULTS.has(q.code)));
    const word = q === undefined ? "not asked" : typeof q.out === "string" ? `quoted ${q.out}` : `refused ${q.code ?? "unnamed"}`;
    say(ended && q.ms <= TAP_MAX_MS, `[base] ${c?.coin} tap after the warm ${word} in ${q?.ms ?? "?"} ms (at most ${TAP_MAX_MS} ms)`);
    say(q?.asks === 1, `[base] ${c?.coin} tap: ${q?.asks ?? 0} kit quote${q?.asks === 1 ? "" : "s"} (one), ${q?.posts ?? "?"} posts, ${q?.calls ?? "?"} eth_calls`);
  }
  const hot = Object.entries(run?.s429 ?? {}).filter(([, n]) => n > 0);
  say(hot.length === 0, `[base] answers of 429: ${hot.length === 0 ? "none" : hot.map(([h, n]) => `${h} ${n}`).join(", ")}`);
  // each step's 429s on a line of its own (a run recorded before s429At prints none); the verdict is the line above
  for (const [at, n] of Object.entries(run?.s429At ?? {})) lines.push(`    429 in the ${at}: ${n}`);
  return { ok, lines };
}

/** One run: the served snapshot, one sync from it, then each of COINS warmed and tapped. */
export async function read(sign = SIGN, site = null, venues = mainnetVenues()) {
  const v = venues.base;
  const run = { sign, site: site === null ? null : "a build folder at SIGN_HOST's name", at: new Date().toISOString(), snapshot: {}, sync: null, coins: [], s429: {}, s429At: {} };
  // the step a post is sent in: "sync", "warm <coin>" or "tap <coin>"
  let step = "snapshot read";
  const quoteHosts = new Set(v.providers.map((u) => new URL(u).host));
  const hosts = new Set([...v.providers, ...v.index.readers].map((u) => new URL(u).host));
  // the running tap's posts to the quote providers and the eth_calls in them
  let tap = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const host = new URL(typeof input === "string" ? input : input.url).host;
    if (tap !== null && quoteHosts.has(host)) {
      tap.posts++;
      try {
        const body = JSON.parse(String(init?.body ?? "null"));
        tap.calls += (Array.isArray(body) ? body : [body]).filter((c) => c?.method === "eth_call").length;
      } catch {}
    }
    const at = step;
    const r = await orig(input, init);
    if (r.status === 429 && hosts.has(host)) {
      run.s429[host] = (run.s429[host] ?? 0) + 1;
      run.s429At[`${at}, ${host}`] = (run.s429At[`${at}, ${host}`] ?? 0) + 1;
    }
    return r;
  };
  try {
    let text;
    if (site !== null) {
      try {
        text = readFileSync(path.join(site, "evm-index", "base.json"), "utf8");
        run.snapshot.status = 200;
      } catch {
        run.snapshot.status = 404;
      }
    } else {
      const r = await orig(`${sign}/evm-index/base.json`, { signal: AbortSignal.timeout(READ_MS) }).catch((e) => ({ status: `error ${e?.name ?? e}` }));
      run.snapshot.status = r.status;
      text = typeof r.text === "function" && r.status === 200 ? await r.text() : undefined;
    }
    let ix = null;
    try {
      ix = text === undefined ? null : evmPoolIndexFromSnapshot(JSON.parse(text), { chainId: v.chainId, poolManager: v.poolManager, cap: v.index.cap });
    } catch {
      ix = null;
    }
    if (ix === null) return run;
    Object.assign(run.snapshot, { through: ix.through, pools: ix.pools.length });
    const t0 = performance.now();
    step = "sync";
    const { served } = await evmPoolIndexRefresh("base", ix).catch(() => ({ served: false }));
    run.sync = { ms: Math.round(performance.now() - t0), served };
    if (!served) return run;
    let asks = 0;
    const quote = (req) => (asks++, evmPoolBuyQuote({ ...req, later: true }));
    for (const token of COINS) {
      const tw = performance.now();
      step = `warm of ${token}`;
      await evmPoolBuyWarm({ chain: "base", token }, { quote });
      const warm = { ms: Math.round(performance.now() - tw) };
      asks = 0;
      tap = { posts: 0, calls: 0 };
      step = `tap of ${token}`;
      const t = performance.now();
      let one;
      try {
        const q = await evmPoolBuyQuoteTap({ chain: "base", token, amountIn: TAP_IN, slippageBps: 100 }, { quote });
        one = { ms: Math.round(performance.now() - t), out: q.amountOut.toString() };
      } catch (e) {
        one = { ms: Math.round(performance.now() - t), code: typeof e?.code === "string" ? e.code : "thrown" };
      }
      run.coins.push({ coin: token, warm, tap: { ...one, asks, posts: tap.posts, calls: tap.calls } });
      tap = null;
      step = "end";
    }
    return run;
  } finally {
    globalThis.fetch = orig;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const run = await read(arg("--sign") ?? SIGN, arg("--site") ?? null);
    if (arg("--record") !== undefined) writeFileSync(arg("--record"), JSON.stringify(run, null, 1) + "\n");
    const { ok, lines } = check(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.sign}${run.site ? `, ${run.site}` : ""})`);
    process.exit(ok ? EXIT.PASS : EXIT.FAIL);
  } catch (e) {
    console.error(`live-check ${KEY}: error ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
