#!/usr/bin/env node
// Live check of card evm-index-kept-at-the-head: a coin's first EVM quote reads its pools from an index kept at the head.
// On Base and Robinhood it reads the release's index snapshot where the page reads it (SIGN_HOST's
// /evm-index/<chain>.json) and syncs on from it on the venue's two index readers (evmPoolIndexRefresh, through the kit's
// public entry, as the page does), then keeps it at the head as the page's keep does: EVM_INDEX_KEEP_MS after each sync
// ends (at once after one that took longer), a gap sync from the index the last one kept. It waits IDLE_MS (an index
// synced once is then past the quote's maxLag, 10 s on both chains), then taps each listed coin once, cold, by the tap's own quote (evmPoolBuyQuoteTap), recording
// each tap's time, posts and 429s per host and every eth_getLogs it sent (its blocks, whether it names a currency,
// before or after the answer), and each gap sync's time, posts, 429s and getLogs per reader. It passes when, per chain:
//   - the sync from the snapshot ended whole and was served, from the snapshot's first block (never a cold build);
//   - every gap sync read only past the snapshot (never the index again from its first block);
//   - no tap asked a block at or below the N served when it started;
//   - no tap scanned by currency before its answer: no getLogs naming a currency, sent before the answer, reaches more
//     than the chain's maxLag below the newest block the tap asked (its pools came from the index; a quote reads the
//     blocks past N, at most maxLag, once it ends, beside the tap's next kit quote where its first route was refused,
//     checks/evm/quote.ts scanPools `later`, so those are counted and reported, never a scan the answer waited on);
//   - every tap ended in a quote or a true named refusal (a provider's fault fails it).
// Runs: pending evm-index-kept-at-the-head, its place in a host's list is set at the merge: it runs this tree's kit on
// real mainnet providers, not a deployed build (the page's keep itself is held by packages/signpage/test/
// pool-testnet-evm-queue.test.ts, "a served index is kept at the head", and the quote's half by packages/kit/test/
// evm-quote-attacks.test.ts F10k)
//   node scripts/live-checks/evm-index-kept-at-the-head.mjs [--record <file>] [--no-index | --no-keep]
//   node scripts/live-checks/evm-index-kept-at-the-head.mjs --answer <file>     judge a recorded run
// --no-index quotes with no index served (the bad answer: the quote's bounded scan alone); --no-keep syncs the index once
// and keeps it no more (main before this card). PASS exit 0, FAIL 1, error 2. Reads only: no key, no transaction, no
// money moves.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT } from "./provider-answer.mjs";
import { SIGN } from "./base-buy-box-answers-a-fresh-account.mjs";
import { mainnetVenues } from "./mainnet-venues.mjs";
import { COINS } from "./base-quotes-inside-provider-limits.mjs";
import { NAMED, QUOTE_AMOUNT } from "./evm-buy-and-sell-on-mainnet.mjs";
import { EVM_INDEX_KEEP_MS, evmPoolBuyQuote, evmPoolBuyQuoteTap, evmPoolIndexFromSnapshot, evmPoolIndexRefresh } from "../../packages/kit/src/index.ts";

export const KEY = "evm-index-kept-at-the-head";
export const CHAINS = Object.freeze(["base", "robinhood"]);
/** The wait between the first sync and the first tap: past each chain's maxLag (about 10 s) three times. */
export const IDLE_MS = 30_000;
/** The time left after a tap for its gap reads sent once it answered, before the next tap starts. */
export const SETTLE_MS = 2_000;
/** Each chain's maxLag (packages/kit/src/trade/evm/buy-unpinned.ts): Base's 50 blocks, Robinhood's 100. */
export const MAX_LAG = Object.freeze({ base: 50, robinhood: 100 });

const TOPIC_SET = (t) => t !== null && t !== undefined;
const sum = (hosts, k) => Object.values(hosts ?? {}).reduce((n, h) => n + (h[k] ?? 0), 0);

/** The verdict on one run { chains }: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const chain of CHAINS) {
    const c = run?.chains?.[chain];
    const ix = c?.index;
    say(ix?.served === true && Number.isSafeInteger(ix.covers) && ix.from === ix.snapshotFrom, `[${chain}] the index synced on from the release's snapshot, whole and served: ${ix ? `${ix.pools} pools from ${ix.from} (the snapshot's ${ix.snapshotFrom}, to ${ix.snapshotThrough}) to ${ix.covers} in ${ix.ms} ms` : "not read"}`);
    const ticks = Array.isArray(c?.keep) ? c.keep : [];
    const deepTicks = ticks.filter((k) => (k.logs ?? []).some((l) => !(l.from > ix?.snapshotThrough)));
    say(ticks.length > 0 && deepTicks.length === 0, `[${chain}] every gap sync read only past the snapshot: ${ticks.length} syncs, ${ticks.filter((k) => k.whole).length} whole, ${deepTicks.length} read the index again`);
    for (const k of [["requests", "posts"], ["s429", "answers of 429"]]) lines.push(`    [${chain}] the keep's ${k[1]} per reader: ${Object.entries(ticks.reduce((m, t) => (Object.entries(t.hosts ?? {}).forEach(([h, v]) => (m[h] = (m[h] ?? 0) + (v[k[0]] ?? 0))), m), {})).map(([h, n]) => `${h} ${n}`).join(", ") || "none"}`);
    const ms = ticks.map((t) => t.ms).sort((a, b) => a - b);
    if (ms.length > 0) lines.push(`    [${chain}] the keep's syncs p50/max ${ms[Math.floor(ms.length / 2)]}/${ms[ms.length - 1]} ms; ms since the last whole sync at each tap: ${(c?.rows ?? []).map((r) => r.sinceMs).join(", ")}`);
    const rows = Array.isArray(c?.rows) ? c.rows : [];
    for (const coin of Object.keys(COINS[chain])) say(rows.some((r) => String(r.coin).toLowerCase() === coin), `[${chain}] ${COINS[chain][coin]} ${coin} is tapped`);
    for (const r of rows) {
      const n = Number.isSafeInteger(r.n) ? r.n : null;
      const logs = Array.isArray(r.logs) ? r.logs : [];
      const before = logs.filter((l) => !l.after);
      const deep = logs.filter((l) => n === null || !(l.from > n));
      say(r.ok === true || NAMED.includes(r.code), `[${chain}] ${r.symbol} ends in a quote or a true named refusal: ${r.ok ? "ok" : r.code}`);
      say(deep.length === 0, `[${chain}] ${r.symbol}: no getLogs at or below the N served at its tap ${n ?? "(none)"}: ${deep.length} of ${logs.length}${deep.length > 0 ? `, the lowest from ${Math.min(...deep.map((l) => l.from))}` : ""}`);
      const top = Math.max(n ?? 0, ...logs.map((l) => l.to));
      const scanned = before.filter((l) => l.currency && l.from <= top - MAX_LAG[chain]);
      const near = before.filter((l) => l.currency && l.from > top - MAX_LAG[chain]);
      say(scanned.length === 0, `[${chain}] ${r.symbol}: no scan by currency before its answer (getLogs naming a currency from more than ${MAX_LAG[chain]} blocks below the tap's newest block ${top}): ${scanned.length}${scanned.length > 0 ? `, the widest ${Math.max(...scanned.map((l) => l.to - l.from + 1))} blocks` : ""}`);
      lines.push(`    [${chain}] ${r.symbol} ${r.ms} ms, ${sum(r.hosts, "requests")} posts, ${sum(r.hosts, "s429")} answers of 429; getLogs before its answer ${before.length} (${before.filter((l) => l.currency).length} by currency, ${near.length} of them the blocks past N within maxLag, at most ${Math.max(0, ...near.map((l) => l.to - l.from + 1))} blocks), after ${logs.length - before.length} (${logs.filter((l) => l.after && l.currency).length} by currency)`);
    }
  }
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** A fetch that counts each host's posts, calls and 429s and each eth_getLogs, into `into()`'s record. */
const counter = (fetchFn, into, after) => async (url, init) => {
  const rec = into();
  const host = new URL(typeof url === "string" ? url : url.url).host;
  const h = (rec.hosts[host] ??= { requests: 0, calls: 0, s429: 0 });
  h.requests++;
  try {
    const b = JSON.parse(typeof init?.body === "string" ? init.body : "null");
    const calls = Array.isArray(b) ? b : b === null ? [] : [b];
    h.calls += calls.length;
    for (const x of calls) {
      if (x?.method !== "eth_getLogs") continue;
      const f = x.params?.[0] ?? {};
      rec.logs.push({ host, from: Number(f.fromBlock), to: Number(f.toBlock), currency: Array.isArray(f.topics) && f.topics.slice(1).some(TOPIC_SET), after: after() });
    }
  } catch {
    h.calls++;
  }
  const r = await fetchFn(url, init);
  if (r.status === 429) h.s429++;
  return r;
};
const fresh = () => ({ hosts: {}, logs: [] });
const nap = (ms) => new Promise((go) => setTimeout(go, ms));

/** Both chains' runs on real mainnet providers; `mode` "keep" (the page's), "once" (synced once) or "none" (no index). */
export async function read(fetchFn = fetch, { mode = "keep" } = {}) {
  const real = globalThis.fetch;
  let tap = fresh();
  let answered = false;
  globalThis.fetch = counter(fetchFn, () => tap, () => answered);
  try {
    const chains = {};
    for (const chain of CHAINS) {
      const v = mainnetVenues()[chain];
      const r = await fetchFn(`${SIGN}/evm-index/${chain}.json`, { signal: AbortSignal.timeout(30_000) });
      const snap = r.status === 200 ? evmPoolIndexFromSnapshot(await r.json(), { chainId: v.chainId, poolManager: v.poolManager, cap: v.index.cap }) : null;
      if (snap === null) throw new Error(`${SIGN}/evm-index/${chain}.json answered ${r.status} or no index`);
      let sink = fresh();
      const keepFetch = counter(fetchFn, () => sink, () => false);
      let kept = snap;
      let served = null;
      let servedAt = null;
      // one sync from the kept index, as the page's: its index kept, a whole one served
      const once = async () => {
        sink = fresh();
        const t = performance.now();
        const { sync, served: ok } = await evmPoolIndexRefresh(chain, kept, keepFetch).catch((e) => ({ sync: { error: { code: e?.code ?? "thrown" } }, served: false }));
        if (sync?.index) kept = sync.index;
        if (ok) (served = sync.coversThrough), (servedAt = performance.now());
        return { ms: Math.round(performance.now() - t), whole: ok, covers: sync?.coversThrough ?? null, head: sync?.index?.head?.number ?? null, error: sync?.error?.code ?? null, ...sink };
      };
      let index = null;
      const keep = [];
      let stop = false;
      let loop = Promise.resolve();
      if (mode !== "none") {
        const first = await once();
        index = { ms: first.ms, served: first.whole, covers: first.covers, from: kept?.from ?? null, pools: null, snapshotFrom: snap?.from ?? null, snapshotThrough: snap?.through ?? null, error: first.error, hosts: first.hosts };
        if (mode === "keep")
          loop = (async () => {
            // the page's keep: EVM_INDEX_KEEP_MS after each sync, at once after one that took longer
            let took = first.ms;
            while (!stop) {
              await nap(took > EVM_INDEX_KEEP_MS ? 0 : EVM_INDEX_KEEP_MS);
              if (stop) break;
              const k = await once();
              keep.push(k);
              took = k.ms;
            }
          })();
      }
      await nap(IDLE_MS);
      const rows = [];
      for (const [coin, symbol] of Object.entries(COINS[chain])) {
        tap = fresh();
        answered = false;
        const n = served;
        const sinceMs = servedAt === null ? null : Math.round(performance.now() - servedAt);
        const t0 = performance.now();
        let end;
        try {
          const q = await evmPoolBuyQuoteTap({ chain, token: coin, amountIn: QUOTE_AMOUNT, slippageBps: 300 }, { quote: (req) => evmPoolBuyQuote(req) });
          end = { ok: true, route: q.route };
        } catch (e) {
          end = { ok: false, code: e?.code ?? "thrown", message: String(e?.message ?? e).slice(0, 200) };
        }
        const ms = Math.round(performance.now() - t0);
        answered = true;
        await nap(SETTLE_MS);
        rows.push({ coin, symbol, n, sinceMs, ms, ...end, ...tap });
      }
      stop = true;
      await loop;
      if (index !== null) index.pools = kept?.pools?.length ?? null;
      chains[chain] = { index, keep, rows };
    }
    return { readAt: new Date().toISOString(), mode, chains };
  } finally {
    globalThis.fetch = real;
  }
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = a.includes("--answer") ? JSON.parse(readFileSync(a[a.indexOf("--answer") + 1], "utf8")) : await read(fetch, { mode: a.includes("--no-index") ? "none" : a.includes("--no-keep") ? "once" : "keep" });
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
