#!/usr/bin/env node
// Live check of card evm-first-quote-inside-the-kpi: a fresh device's first Base quote of a coin, as pool.buy.dry asks
// it, starts on a whole index and ends inside the box's ask. A fresh account on the live hosts (2026-11-18 00:36Z) had
// its first Base dry answer at 73.6 s: the index sync halved every 10,000-block span base.api.pocket.network answered
// with -32602 "block range exceeds maximum 500" (about one in ten, from some of its backends) on both readers and was
// still reading at 52 s; at 20 s the dry started its no-index scan beside it on base-rpc.publicnode.com, the index's
// own reader (26 answers of 429); and a cold quote's reads queued behind publicnode at 2 posts at once. This card asks
// such a span of its reader again at once (kit pool-index.ts), answers the dry down while the sync runs (signpage
// pool-buy-evm.ts EVM_DRY_SYNCING: the box asks again) and lets publicnode take a quote's posts 8 at once.
// Judged, on the commit's kit as the device runs it:
// - one sync from SIGN_HOST's Base snapshot (kit evmPoolIndexRefresh) ends whole within SYNC_MAX_MS, and its first
//   reader (publicnode, which answers every span) asks at most HALVED_MAX more getLogs than the gap's spans: a span is
//   asked as halves only once Pocket refused it four times in a row (about 1 in 140 at its 29% refused on 18 Nov), where
//   every refusal halved it before (52 s and more);
// - each of the first COINS coins of the helper's Base list (the page's own list) is quoted cold as the dry quotes it
//   (kit evmPoolBuyQuoteTap, every read a background one): it ends, with a quote or a named refusal, never a provider's
//   fault, within FIRST_MAX_MS (one ask of the box's 10 s), and the same coin again within AGAIN_MAX_MS;
// - no Base quote provider or index reader answers 429;
// - aged (card evm-first-quote-reads-its-coin-at-any-age): a device whose index is AGED_BLOCKS (48 h) behind the head,
//   as it is once the release's snapshot ages through days no release ships: each of AGED_COINS more coins of the list
//   is read (kit evmPoolCoinRefresh, the coin's own blocks, not every pool's) and quoted as the dry quotes it, served and
//   ended within AGED_MAX_MS together. bloXroute's eth_blockNumber time is printed before it; past SLOW_HEAD_MS (its slow
//   hour, about 1 s, when it times out pieces: 21 Nov) the run is measured, not judged, until the keyed Base route
//   lands (card base-reads-never-throttled). A kit before this card reads the whole index from the aged one instead.
// Reads only: no key, no transaction, no money moves.
// After: sign
// Bundle: out SIGN_HOST's Base snapshot, the helper's Base list, Base's providers
//   node scripts/live-checks/evm-first-quote-inside-the-kpi.mjs [--sign <origin>] [--helper <origin>] [--site <dir>]
//     [--record <file>]. --site reads the snapshot from a build folder (<dir>/evm-index/base.json) instead of SIGN_HOST:
//     a commit's run before its deploy. PASS exit 0, FAIL exit 1, error exit 2. --record writes the run for the test's replay.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as kit from "../../packages/kit/src/index.ts";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { EXIT } from "./provider-answer.mjs";

const KEY = "evm-first-quote-inside-the-kpi";
export const SIGN = "https://confidential.unrealized.trade";
export const HELPER = "https://ct-api.unrealized.trade";
/** The longest one sync from the served snapshot may take: half the dry's index wait (EVM_DRY_INDEX_WAIT_MS 20 s). */
export const SYNC_MAX_MS = 10_000;
/** A coin's first quote: inside one of the box's asks (the kit client gives pool.buy.dry 10 s), with room for the page. */
export const FIRST_MAX_MS = 8_000;
/** The same coin quoted again, its pools and the block's reads warm. */
export const AGAIN_MAX_MS = 3_000;
/** The getLogs past one a span the first reader may ask: three spans asked once as halves. */
export const HALVED_MAX = 6;
/** How many of the helper's Base list are quoted. */
export const COINS = 6;
/** The kit's own words for a provider's fault: never the end of a quote this check passes. */
const FAULTS = new Set(["rpc_error", "rpc_disagree", "stale_quote"]);
const { evmPoolBuyQuote, evmPoolBuyQuoteTap, evmPoolIndexFromSnapshot, evmPoolIndexRefresh } = kit;
/** The aged device's index: 48 h of Base blocks behind the head (0.2 s blocks: 59,569,785 to 60,433,785 is 48:00:00,
 *  read 2026-11-21 16:05Z). */
export const AGED_BLOCKS = 864_000;
/** How many more coins of the list the aged device reads and quotes. */
export const AGED_COINS = 2;
/** A coin's read and first quote together on the aged device: one ask of the box (the kit client's 10 s). */
export const AGED_MAX_MS = 10_000;
/** bloXroute's eth_blockNumber past this: its slow hour (about 1 s, its TLS 0.73 s, 21 Nov 16:07Z), measured only. */
export const SLOW_HEAD_MS = 600;
/** The wait before the aged case: publicnode's getLogs budget (pace.ts) refilled after the sync and the quotes. */
const AGED_PAUSE_MS = 30_000;
const READ_MS = 30_000;
const ADDR = /^0x[0-9a-f]{40}$/;

/** The verdict on a run { snapshot: { status, through?, pools? }, sync: { ms, served, coversThrough, span, getLogs } |
 *  null, coins: [{ coin, first: { ms, out?, code? }, again: { ms, out?, code? } }], s429: { host: n } }: { ok, lines }. */
export function check(run) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok " : "BAD"} ${text}`);
  };
  const s = run?.snapshot ?? {};
  say(s.status === 200 && Number.isSafeInteger(s.through) && s.pools > 0, `[base] snapshot HTTP ${s.status ?? "not read"}, ${s.pools ?? 0} pools, through ${s.through ?? "none"}`);
  const y = run?.sync;
  say(y?.served === true && Number.isFinite(y.ms) && y.ms <= SYNC_MAX_MS, `[base] a fresh device's sync from it ${y ? `${y.served ? "whole" : "partial"} in ${y.ms} ms` : "not run"} (at most ${SYNC_MAX_MS} ms)`);
  if (y?.served === true && Number.isSafeInteger(s.through)) {
    const spans = Math.ceil((y.coversThrough - s.through) / y.span) + 1;
    const g = y.getLogs?.[0];
    say(Number.isSafeInteger(g) && g <= spans + HALVED_MAX, `[base] its first reader asked ${g ?? "?"} getLogs for a gap of ${y.coversThrough - s.through} blocks, ${spans} spans (at most ${spans + HALVED_MAX})`);
  }
  const coins = Array.isArray(run?.coins) ? run.coins : [];
  say(coins.length === COINS, `[base] ${coins.length} of ${COINS} coins of the helper's list quoted`);
  const ended = (q) => q !== undefined && Number.isFinite(q.ms) && (typeof q.out === "string" || (typeof q.code === "string" && !FAULTS.has(q.code)));
  const word = (q) => (q === undefined ? "not asked" : typeof q.out === "string" ? `quoted ${q.out}` : `refused ${q.code ?? "unnamed"}`);
  for (const c of coins) {
    say(ended(c.first) && c.first.ms <= FIRST_MAX_MS, `[base] ${c.coin} first quote ${word(c.first)} in ${c.first?.ms ?? "?"} ms (at most ${FIRST_MAX_MS} ms)`);
    say(ended(c.again) && c.again.ms <= AGAIN_MAX_MS, `[base] ${c.coin} again ${word(c.again)} in ${c.again?.ms ?? "?"} ms (at most ${AGAIN_MAX_MS} ms)`);
  }
  const g = run?.aged;
  const slow = Number.isFinite(g?.headMs) && g.headMs > SLOW_HEAD_MS;
  say(g !== undefined && g !== null && g.behind >= AGED_BLOCKS && g.mode === "coin", `[base aged] an index ${g?.behind ?? "?"} blocks behind (at least ${AGED_BLOCKS}), read ${g?.mode === "coin" ? "coin by coin" : g?.mode === "whole" ? "whole (no coin read)" : "not run"}; bloXroute's head in ${g?.headMs ?? "?"} ms${slow ? ` (its slow hour, past ${SLOW_HEAD_MS} ms: measured, not judged)` : ""}`);
  const gs = Array.isArray(g?.coins) ? g.coins : [];
  say(gs.length === AGED_COINS, `[base aged] ${gs.length} of ${AGED_COINS} coins read and quoted`);
  for (const c of gs) {
    const total = (c.readMs ?? NaN) + (c.first?.ms ?? NaN);
    const fine = c.served === true && ended(c.first) && total <= AGED_MAX_MS;
    say(fine || (slow && c.served === true && ended(c.first)), `[base aged] ${c.coin} read ${c.served ? "served" : "not served"} in ${c.readMs ?? "?"} ms, first quote ${word(c.first)} in ${c.first?.ms ?? "?"} ms: ${Number.isFinite(total) ? total : "?"} ms (at most ${AGED_MAX_MS} ms${slow ? "; slow hour, measured" : ""})`);
  }
  const hot = Object.entries(run?.s429 ?? {}).filter(([, n]) => n > 0);
  say(hot.length === 0, `[base] answers of 429: ${hot.length === 0 ? "none" : hot.map(([h, n]) => `${h} ${n}`).join(", ")}`);
  return { ok, lines };
}

/** One run: the served snapshot, one sync from it, then COINS coins of the helper's Base list quoted cold and again. */
export async function read(sign = SIGN, helper = HELPER, site = null, venues = mainnetVenues()) {
  const v = venues.base;
  const run = { sign, helper, site: site === null ? null : "a build folder at SIGN_HOST's name", at: new Date().toISOString(), snapshot: {}, sync: null, coins: [], s429: {} };
  // every Base provider's 429s, counted by host (a hostile or busy provider is named, never trusted)
  const hosts = new Set([...v.providers, ...v.index.readers].map((u) => new URL(u).host));
  const orig = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const r = await orig(input, init);
    const host = new URL(typeof input === "string" ? input : input.url).host;
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
    const { sync, served } = await evmPoolIndexRefresh("base", ix).catch(() => ({ sync: null, served: false }));
    run.sync = { ms: Math.round(performance.now() - t0), served, coversThrough: sync?.coversThrough ?? null, span: v.index.span, getLogs: sync?.stats?.getLogs ?? null, requests: sync?.stats?.requests ?? null };
    if (!served) return run;
    // the helper's Base list, hostile input: only well-formed addresses, the first COINS distinct
    const list = await orig(`${helper}/v1/market/lists?chain=base`, { signal: AbortSignal.timeout(READ_MS) }).then((x) => x.text()).catch(() => "");
    const tokens = [...new Set((list.slice(0, 2_000_000).match(/0x[0-9a-fA-F]{40}/g) ?? []).map((t) => t.toLowerCase()))].filter((t) => ADDR.test(t) && t !== v.weth.toLowerCase()).slice(0, COINS);
    const quote = (req) => evmPoolBuyQuote({ ...req, later: true });
    const one = async (token) => {
      const t = performance.now();
      try {
        const q = await evmPoolBuyQuoteTap({ chain: "base", token, amountIn: 1_500_000_000_000_000n, slippageBps: 100 }, { quote });
        return { ms: Math.round(performance.now() - t), out: q.amountOut.toString() };
      } catch (e) {
        return { ms: Math.round(performance.now() - t), code: typeof e?.code === "string" ? e.code : "thrown" };
      }
    };
    for (const token of tokens) run.coins.push({ coin: token, first: await one(token), again: await one(token) });
    // the aged device: the snapshot cut to AGED_BLOCKS below the readers' head (where it holds that block), its coins read
    // and quoted after the others, each coin's read timed from its start to its end and its quote after it
    await new Promise((r) => setTimeout(r, AGED_PAUSE_MS));
    const post = (url, method) => orig(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }), signal: AbortSignal.timeout(READ_MS) }).then((x) => x.json());
    const t1 = performance.now();
    await post("https://base.rpc.blxrbdn.com", "eth_blockNumber").catch(() => null);
    const headMs = Math.round(performance.now() - t1);
    const head = Math.min(...(await Promise.all(v.index.readers.map((u) => post(u, "eth_blockNumber").then((x) => Number(x.result))))));
    const x = Math.min(ix.through, head - AGED_BLOCKS);
    const old = { ...ix, through: x, head: { number: x, hash: ix.head.hash }, spans: ix.spans.filter(([a]) => a <= x).map(([a, b]) => [a, Math.min(b, x)]), pools: ix.pools.filter((p) => p.block <= x) };
    const coinRead = kit.evmPoolCoinRefresh;
    run.aged = { behind: head - x, headMs, mode: typeof coinRead === "function" ? "coin" : "whole", coins: [] };
    const more = [...new Set((list.slice(0, 2_000_000).match(/0x[0-9a-fA-F]{40}/g) ?? []).map((t) => t.toLowerCase()))].filter((t) => ADDR.test(t) && t !== v.weth.toLowerCase() && !tokens.includes(t)).slice(0, AGED_COINS);
    for (const token of more) {
      const t = performance.now();
      const served = await (typeof coinRead === "function" ? coinRead("base", old, token) : evmPoolIndexRefresh("base", old)).then((r) => r.served, () => false);
      const readMs = Math.round(performance.now() - t);
      run.aged.coins.push({ coin: token, served, readMs, first: await one(token) });
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
    const run = await read(arg("--sign") ?? SIGN, arg("--helper") ?? HELPER, arg("--site") ?? null);
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
