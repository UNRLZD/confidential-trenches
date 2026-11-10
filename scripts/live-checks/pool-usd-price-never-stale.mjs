#!/usr/bin/env node
// Live check of card pool-usd-price-never-stale: the trade box's Solana USD price is never gone while Pyth's sponsored
// SOL/USD account is between writes. The account is written when its price is 50 to 57 s old and lands 1 to 3 s later
// (720 reads, 10 Nov 03:56-04:26Z); the kit's bound is its 60 s heartbeat + 15 s (POOL_USD_FEEDS.solana); and the
// signing page reads again from 25 s before a held price's end each second until a newer price is in
// (packages/signpage/src/pool-price.ts). Two parts:
//   1. The feed on the page's own pair, for RUN_MS (3 minutes, three writes or more): the kit's poolUsdPrice (through its
//      public entry) on SIGN_HOST's provider A and the helper's keyed route (signpage-pool-price.mjs PAGE_PAIR), read on
//      the page's schedule (SCHEDULE, held equal to pool-price.ts by packages/signpage/test/pool-price.test.ts), the held
//      price looked at every 100 ms against the kit's one bound (poolUsdGoodUntilS). It passes only with a price held
//      from the first read to the end, never gone, and each write held within WRITE_HELD_MS of landing (the block time
//      of the update's posted_slot, read on provider A; whole seconds, so 1 s is added to the 2 s).
//   2. SIGN_HOST's served /app.js is the one its index.html pins and a released build from release-FOLDED_FROM on (a
//      packages/signpage/releases/release-<N>.json, N >= FOLDED_FROM, names its sha384), so the deployed page carries the
//      schedule. Judged by the ledger, as pool-senders-next-page.mjs is, so a merge before its sign deploy is not red.
// After: sign
//   node scripts/live-checks/pool-usd-price-never-stale.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { poolUsdGoodUntilS, poolUsdPrice, SOLANA_RPC_RETRY, solanaHelperRpc, solanaJsonRpc, solanaSameProvider } from "../../packages/kit/src/index.ts";
// SIGN_HOST's Solana pair for the pool kinds and the price: provider A and the helper's keyed route
import { PAGE_PAIR } from "./signpage-pool-price.mjs";

const KEY = "pool-usd-price-never-stale";
export const SIGN = "https://confidential.unrealized.trade";
/** The first release whose page reads at the feed's write. */
export const FOLDED_FROM = 111;
/** How long the feed is followed: three writes or more at its 50 to 57 s cadence. */
export const RUN_MS = 180_000;
/** The fewest writes a run must see to judge anything. */
export const WRITES_MIN = 3;
/** A write is held within this of landing: one POOL_PRICE_WRITE_POLL_MS and a read, with 1 s for the block time's whole
 *  seconds. */
export const WRITE_HELD_MS = 3_000;
/** The signing page's schedule (packages/signpage/src/pool-price.ts): POOL_PRICE_REFRESH_MS, POOL_PRICE_WRITE_LEAD_MS,
 *  POOL_PRICE_WRITE_POLL_MS, POOL_PRICE_RETRY_MS. */
export const SCHEDULE = Object.freeze({ refreshMs: 15_000, leadMs: 25_000, pollMs: 1_000, retryMs: 1_000 });
/** The page before this card: every 15 s, a failure read again 1 s on, doubling; no read at the write. */
export const BEFORE = Object.freeze({ refreshMs: 15_000, leadMs: null, pollMs: null, retryMs: 1_000 });
const SAMPLE_MS = 100;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/**
 * The page's schedule for one chain, on `read` (the kit's poolUsdPrice on a pair): read, hold a good price (never an
 * older one), and read again as src/pool-price.ts does: a good read POOL_PRICE_WRITE_LEAD_MS before the held price's end,
 * then each pollMs; a late feed (the kit's PoolUsdStale) each pollMs for leadMs past its end; a failure 1 s on, doubling,
 * up to refreshMs. Looks at the held price every SAMPLE_MS until `untilMs` or `stop()`, and tells `onHold` each price it
 * holds. Returns what it read and held.
 */
export async function follow({ read, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), untilMs, schedule = SCHEDULE, chain = "solana", stop = () => false, onHold = () => {} }) {
  const startMs = now();
  const reads = [];
  /** Each publish time held, with when it was first held and the posted slot it came in. */
  const held = [];
  /** Spans with no usable price, after the first one was held: [from, to] unix ms. */
  const gone = [];
  let p = null;
  let failed = 0;
  const end = (x) => poolUsdGoodUntilS(chain, x.publishedS, x.readMs / 1000) * 1000;
  const usable = (t) => p !== null && t <= end(p);
  while (now() < untilMs && !stop()) {
    const t0 = now();
    let kind;
    let lateEndMs = null;
    let error;
    try {
      const r = await read();
      const got = { publishedS: r.publishedS, readMs: now(), price: r.price.toString(), expo: r.expo, at: r.at.toString() };
      if (now() > end(got)) {
        kind = "late";
        lateEndMs = end(got);
      } else {
        kind = "good";
        if (p === null || got.publishedS >= p.publishedS) {
          if (p === null || got.publishedS > p.publishedS) held.push({ publishedS: got.publishedS, at: got.at, heldMs: now() });
          p = got;
          onHold(p);
        }
      }
    } catch (e) {
      kind = e?.name === "PoolUsdStale" && Number.isSafeInteger(e.publishedS) ? "late" : "failed";
      if (kind === "late") lateEndMs = poolUsdGoodUntilS(chain, e.publishedS, now() / 1000) * 1000;
      error = String(e?.message ?? e).slice(0, 160);
    }
    reads.push({ startMs: t0, ms: now() - t0, kind, ...(error === undefined ? {} : { error }) });
    const t = now();
    let waitMs;
    if (kind === "good") {
      failed = 0;
      waitMs = schedule.leadMs === null ? schedule.refreshMs : Math.min(Math.max(end(p) - schedule.leadMs - t, schedule.pollMs), schedule.refreshMs);
    } else if (kind === "late" && schedule.leadMs !== null && t <= lateEndMs + schedule.leadMs) {
      waitMs = schedule.pollMs;
    } else {
      failed++;
      waitMs = Math.min(schedule.retryMs * 2 ** (failed - 1), schedule.refreshMs);
    }
    // look at the held price each SAMPLE_MS until the next read
    for (const next = t + waitMs; now() < next && now() < untilMs && !stop(); ) {
      const s = now();
      if (held.length > 0 && !usable(s)) {
        const last = gone.at(-1);
        if (last && s - last[1] <= SAMPLE_MS * 2) last[1] = s;
        else gone.push([s, s]);
      }
      await sleep(Math.min(SAMPLE_MS, next - s));
    }
  }
  return { startMs, endMs: now(), reads, held, gone };
}

/** The verdict on a record { at, rpcs, run: follow's answer with each held write's landing (blockTimeS), sign: { index, sha384 } }. */
export function judge(rec, { ledger = true, folded = ledger ? foldedReleases() : null } = {}) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const rpcs = rec?.rpcs;
  if (!(Array.isArray(rpcs) && rpcs.length === 2 && rpcs.every((u, i) => u === PAGE_PAIR[i]))) bad(`not the page's Solana pair: ${JSON.stringify(rpcs ?? null)}`);
  const run = rec?.run;
  if (!run || !Array.isArray(run.held) || !Array.isArray(run.gone) || !Array.isArray(run.reads)) {
    bad("no run of the feed");
  } else {
    if (run.endMs - run.startMs < RUN_MS - 1_000) bad(`the feed was followed for ${Math.round((run.endMs - run.startMs) / 1000)} s, not ${RUN_MS / 1000} s`);
    if (run.held.length === 0) bad("no price was ever held");
    else if (run.held[0].heldMs - run.startMs > 15_000) bad(`the first price was held ${Math.round((run.held[0].heldMs - run.startMs) / 1000)} s into the run`);
    const writes = run.held.slice(1);
    if (writes.length < WRITES_MIN) bad(`${writes.length} write(s) seen, not ${WRITES_MIN} or more`);
    for (const [from, to] of run.gone) bad(`no price for ${((to - from) / 1000 + SAMPLE_MS / 1000).toFixed(1)} s, ${Math.round((from - run.startMs) / 1000)} s into the run: Buy off and no USD`);
    for (const w of writes) {
      if (!Number.isSafeInteger(w.blockTimeS)) bad(`the write published ${w.publishedS} has no landing time`);
      else if (w.heldMs - w.blockTimeS * 1000 > WRITE_HELD_MS) bad(`the write published ${w.publishedS} (landed ${w.blockTimeS}) was held ${((w.heldMs - w.blockTimeS * 1000) / 1000).toFixed(1)} s after it landed, not within ${WRITE_HELD_MS / 1000} s`);
    }
  }
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(rec?.sign?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== rec.sign.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (folded && !folded.has(rec?.sign?.sha384)) bad(`SIGN_HOST's /app.js is not a release-${FOLDED_FROM}-or-later build: ${rec?.sign?.sha384 ?? "not read"}`);
  return { ok: lines.length === 0, lines };
}

/** SIGN_HOST's /app.js sha384 in every release list from FOLDED_FROM on (packages/signpage/releases/). */
export function foldedReleases(dir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages/signpage/releases"), from = FOLDED_FROM) {
  const out = new Set();
  for (const f of readdirSync(dir)) {
    const n = /^release-(\d+)\.json$/.exec(f)?.[1];
    if (n === undefined || Number(n) < from) continue;
    const list = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    for (const x of list.hosts?.SIGN_HOST?.files ?? []) if (x.path === "/app.js") out.add(x.sha384);
  }
  return out;
}

/** Follows the feed on the page's pair for RUN_MS (on `schedule`), then reads each held write's landing time and SIGN_HOST's page. */
export async function read({ schedule = SCHEDULE, runMs = RUN_MS } = {}) {
  const a = solanaJsonRpc(PAGE_PAIR[0], { retry: SOLANA_RPC_RETRY });
  const rpcs = [a, solanaHelperRpc(new URL(PAGE_PAIR[1]).origin, { retry: SOLANA_RPC_RETRY })];
  if (solanaSameProvider(rpcs[0], rpcs[1])) throw new Error("the page's pair is one provider twice");
  const at = new Date().toISOString();
  const run = await follow({ read: () => poolUsdPrice({ chain: "solana", rpcs }), untilMs: Date.now() + runMs, schedule });
  for (const w of run.held) w.blockTimeS = await a("getBlockTime", [Number(w.at)]).catch(() => null);
  const get = async (p) => {
    const r = await fetch(`${SIGN}${p}`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  return { at, rpcs: PAGE_PAIR, run, sign: { index, sha384: sha384(await get("/app.js")) } };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    const r = answer.run;
    if (r) console.log(`${r.held.length} price(s) held, ${r.reads.length} read(s) in ${Math.round((r.endMs - r.startMs) / 1000)} s (${(r.reads.length / ((r.endMs - r.startMs) / 60_000)).toFixed(1)} a minute)`);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
