#!/usr/bin/env node
// Live check of card evm-cold-multihop-quote-inside-the-kpi: a Base coin whose market is a WETH-USDC-coin v3 route
// (0x07b3d9) is quoted the way the buy box asks, its first kit quote on a guessed route refused with the real route
// named, and the tap's second quote of that route read at the first one's block. At main the second quote agreed on a
// new head (Base makes a block every 0.2 s, the head watch refreshes every 1.5 s) and read every read again there;
// now it reads at the refused quote's block, every read the first quote's two providers agreed on answered from that
// agreement and only the route's own reads sent, and a route through X's market rides the market's own round.
// Judged, on the commit's kit as the device runs it:
// - one sync from SIGN_HOST's Base snapshot (kit evmPoolIndexRefresh) ends whole, so the tap starts on the index;
// - each coin of COINS is quoted cold and again (kit evmPoolBuyQuoteTap, every read a background one): each ends with a
//   quote or a named refusal, never a provider's fault, within FIRST_MAX_MS cold and AGAIN_MAX_MS again;
// - a tap that asked the kit more than once asked every later quote at the block its refusal named (`at`), and every
//   eth_call of the tap went to one block hash;
// - no Base quote provider or index reader answers 429.
// Reads only: no key, no transaction, no money moves.
// After: sign
// Bundle: out SIGN_HOST's Base snapshot, Base's providers
//   node scripts/live-checks/evm-cold-multihop-quote-inside-the-kpi.mjs [--sign <origin>] [--site <dir>] [--record <file>].
//     --site reads the snapshot from a build folder (<dir>/evm-index/base.json) instead of SIGN_HOST: a commit's run
//     before its deploy. PASS exit 0, FAIL exit 1, error exit 2. --record writes the run for the test's replay.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evmPoolBuyQuote, evmPoolBuyQuoteTap, evmPoolIndexFromSnapshot, evmPoolIndexRefresh } from "../../packages/kit/src/index.ts";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { EXIT } from "./provider-answer.mjs";

const KEY = "evm-cold-multihop-quote-inside-the-kpi";
export const SIGN = "https://confidential.unrealized.trade";
/** The coins quoted: Base 0x07b3d9, whose only market is WETH-USDC-coin on Uniswap v3. */
export const COINS = ["0x07b3d902783c3c12b077508c3b5c00113d1291d0"];
/** A cold tap: one of the box's asks (the kit client gives pool.buy.dry 10 s), with room for the page. */
export const FIRST_MAX_MS = 8_000;
/** The same coin again, its pools and plan warm. */
export const AGAIN_MAX_MS = 6_000;
const FAULTS = new Set(["rpc_error", "rpc_disagree", "stale_quote"]);
const READ_MS = 30_000;
const HASH = /^0x[0-9a-f]{64}$/;

/** The verdict on a run { snapshot: { status, through?, pools? }, sync: { ms, served } | null, coins: [{ coin, first,
 *  again }] with each tap { ms, out?, code?, asks: [{ at }], blocks: [hash] }, s429: { host: n } }: { ok, lines }. */
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
  say(coins.length === COINS.length && coins.every((c, i) => c?.coin === COINS[i]), `[base] ${coins.length} of ${COINS.length} coins quoted`);
  const ended = (q) => q !== undefined && Number.isFinite(q.ms) && (typeof q.out === "string" || (typeof q.code === "string" && !FAULTS.has(q.code)));
  const word = (q) => (q === undefined ? "not asked" : typeof q.out === "string" ? `quoted ${q.out}` : `refused ${q.code ?? "unnamed"}`);
  const tap = (c, q, which, max) => {
    say(ended(q) && q.ms <= max, `[base] ${c.coin} ${which} ${word(q)} in ${q?.ms ?? "?"} ms (at most ${max} ms)`);
    const asks = Array.isArray(q?.asks) ? q.asks : [];
    const blocks = Array.isArray(q?.blocks) ? q.blocks.filter((b) => HASH.test(b)) : [];
    if (asks.length > 1) {
      const pinned = asks.slice(1).every((a) => typeof a?.at === "string" && HASH.test(a.at));
      // the later kit quotes asked at the first one's block (the first hash read); a pin the chain dropped, or a first
      // block the watch does not hold, is read again at one block of its own, so at most one hash per kit quote
      say(pinned && blocks.length >= 1 && blocks.length <= asks.length && asks.slice(1).every((a) => a.at === blocks[0]), `[base] ${c.coin} ${which}: ${asks.length} kit quotes, the later ones asked at ${pinned ? "the refused quote's block" : "no block"}, its reads at ${blocks.length} block hash${blocks.length === 1 ? "" : "es"} (one)`);
    } else say(asks.length === 1 && blocks.length <= 1, `[base] ${c.coin} ${which}: ${asks.length} kit quote${asks.length === 1 ? "" : "s"}, its reads at ${blocks.length} block hash${blocks.length === 1 ? "" : "es"}`);
  };
  for (const c of coins) {
    tap(c, c.first, "cold", FIRST_MAX_MS);
    tap(c, c.again, "again", AGAIN_MAX_MS);
  }
  const hot = Object.entries(run?.s429 ?? {}).filter(([, n]) => n > 0);
  say(hot.length === 0, `[base] answers of 429: ${hot.length === 0 ? "none" : hot.map(([h, n]) => `${h} ${n}`).join(", ")}`);
  return { ok, lines };
}

/** One run: the served snapshot, one sync from it, then each of COINS tapped cold and again. */
export async function read(sign = SIGN, site = null, venues = mainnetVenues()) {
  const v = venues.base;
  const run = { sign, site: site === null ? null : "a build folder at SIGN_HOST's name", at: new Date().toISOString(), snapshot: {}, sync: null, coins: [], s429: {} };
  const quoteHosts = new Set(v.providers.map((u) => new URL(u).host));
  const hosts = new Set([...v.providers, ...v.index.readers].map((u) => new URL(u).host));
  // the block hashes the running tap's eth_calls name (EIP-1898), from the request bodies the kit sends
  let blocks = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const host = new URL(typeof input === "string" ? input : input.url).host;
    if (blocks !== null && quoteHosts.has(host)) {
      try {
        const body = JSON.parse(String(init?.body ?? "null"));
        for (const c of Array.isArray(body) ? body : [body]) {
          const h = c?.method === "eth_call" ? c.params?.[1]?.blockHash : undefined;
          if (typeof h === "string") blocks.add(h.toLowerCase());
        }
      } catch {}
    }
    const r = await orig(input, init);
    if (r.status === 429 && hosts.has(host)) run.s429[host] = (run.s429[host] ?? 0) + 1;
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
    const { served } = await evmPoolIndexRefresh("base", ix).catch(() => ({ served: false }));
    run.sync = { ms: Math.round(performance.now() - t0), served };
    if (!served) return run;
    const one = async (token) => {
      const asks = [];
      blocks = new Set();
      const quote = (req) => (asks.push({ at: typeof req.at === "string" ? req.at : null }), evmPoolBuyQuote({ ...req, later: true }));
      const t = performance.now();
      try {
        const q = await evmPoolBuyQuoteTap({ chain: "base", token, amountIn: 1_500_000_000_000_000n, slippageBps: 100 }, { quote });
        return { ms: Math.round(performance.now() - t), out: q.amountOut.toString(), asks, blocks: [...blocks] };
      } catch (e) {
        return { ms: Math.round(performance.now() - t), code: typeof e?.code === "string" ? e.code : "thrown", asks, blocks: [...blocks] };
      } finally {
        blocks = null;
      }
    };
    for (const token of COINS) run.coins.push({ coin: token, first: await one(token), again: await one(token) });
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
