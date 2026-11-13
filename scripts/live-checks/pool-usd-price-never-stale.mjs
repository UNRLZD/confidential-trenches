#!/usr/bin/env node
// Live check of card pool-usd-price-never-stale: the trade box's Solana USD price is never gone while Pyth's sponsored
// SOL/USD account is between writes. The account is written when its price is 50 to 57 s old and lands 1 to 3 s later
// (720 reads, 10 Nov 03:56-04:26Z); the kit's bound is its 60 s heartbeat + 15 s (POOL_USD_FEEDS.solana); and the
// signing page reads again from 20 s before a held price's end (publish + 55 s) each 3 s until a newer price is in
// (packages/signpage/src/pool-price.ts). Two parts:
//   1. The feed on the page's own pair, for RUN_MS (3 minutes, three writes or more): the kit's poolUsdPrice (through its
//      public entry) on SIGN_HOST's provider A and the helper's keyed route (signpage-pool-price.mjs PAGE_PAIR), read on
//      the page's schedule (SCHEDULE, held equal to pool-price.ts by packages/signpage/test/pool-price.test.ts), the held
//      price looked at every 100 ms against the kit's one bound (poolUsdGoodUntilS). It passes only with a price held
//      from the first read to the end, never gone, and each write at the heartbeat (landed when the held price was
//      HEARTBEAT_FROM_S or more old) held within WRITE_HELD_MS of landing (the block time of the update's posted_slot,
//      read on provider A); a write on a move, earlier, is read at the next refresh: held within MOVE_HELD_MS. On 10 Nov
//      06:59-07:02Z the account was written each 15 s for 90 s (a moving market), each such write held 0.9 to 7.0 s
//      after it landed.
//   2. SIGN_HOST's served /app.js is the one its index.html pins, a released build (a packages/signpage/releases/
//      release-<N>.json names its sha384), and in it, as minified (review of eb2dfdc5, P2-3): the kit's Solana bound
//      (maxAgeS beside Pyth's account) is BOUND_S; the page's schedule constants (refresh, retry, Retry-After cap, ahead,
//      poll, before wakeWhenShown) are SCHEDULE's; each timer makes its own read due; and a late feed is told by the kit's
//      PoolUsdStale. So part 1's replay of the schedule in Node holds only for a page that carries it: a page of an
//      earlier release, under any release number, the 60 s bound or the 15 s schedule each fail. The release list's
//      `commit` is not held to a descendant of this card's merge: a live run checks out one commit with no history
//      (.github/workflows/live.yml, actions/checkout at depth 1), so no ancestry can be read there; the marks hold what
//      the release number held, and more.
// Deploy order: APP_HOST before SIGN_HOST. The app holds a price 75 s from this card on; a page that reads at the write
// sends a price up to about 58 s old, which an app still on 60 s would drop before its next write (review P2-5;
// signpage-pool-price.mjs's aged run proves the deployed app holds 75 s).
// After: sign
// Bundle: out three minutes of mainnet Pyth reads on the page's own pair (its test holds its bundle marks on this tree's own build, planted)
//   node scripts/live-checks/pool-usd-price-never-stale.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POOL_USD_FEEDS, poolUsdGoodUntilS, poolUsdPrice, SOLANA_RPC_RETRY, solanaHelperRpc, solanaJsonRpc, solanaSameProvider } from "../../packages/kit/src/index.ts";
// SIGN_HOST's Solana pair for the pool kinds and the price: provider A and the helper's keyed route
import { PAGE_PAIR } from "./signpage-pool-price.mjs";

const KEY = "pool-usd-price-never-stale";
export const SIGN = "https://confidential.unrealized.trade";
/** The kit's Solana bound (POOL_USD_FEEDS.solana.maxAgeS): Pyth's 60 s heartbeat and 15 s for a late write. */
export const BOUND_S = 60 + 15;
/** How long the feed is followed: three writes or more at its 50 to 57 s cadence. */
export const RUN_MS = 180_000;
/** The fewest writes a run must see to judge anything. */
export const WRITES_MIN = 3;
/** A write is held within this of landing: one POOL_PRICE_WRITE_POLL_MS (3 s), a read (p95 0.65 s on the slower
 *  provider, 10 Nov), and 1 s for the block time's whole seconds. Measured on mainnet on this schedule, 10 Nov
 *  06:55-07:05Z: writes held 1.3 to 3.0 s after the landing's block time (the answers' notes). */
export const WRITE_HELD_MS = 5_000;
/** A write that lands when the held price is this old or more is the heartbeat's (written at 50 to 57 s of age on
 *  10 Nov): the page is due at it (BOUND_S less SCHEDULE.leadMs, 55 s), from a landing a few seconds before. */
export const HEARTBEAT_FROM_S = 50;
/** A write on a move (before HEARTBEAT_FROM_S) is held by the next refresh: one SCHEDULE.refreshMs, a read, and 1 s for
 *  the block time's whole seconds. */
export const MOVE_HELD_MS = 15_000 + 2_000;
/** The signing page's schedule (packages/signpage/src/pool-price.ts): POOL_PRICE_REFRESH_MS, POOL_PRICE_WRITE_LEAD_MS,
 *  POOL_PRICE_WRITE_POLL_MS, POOL_PRICE_RETRY_MS. */
export const SCHEDULE = Object.freeze({ refreshMs: 15_000, leadMs: 20_000, pollMs: 3_000, retryMs: 1_000, retryAfterMaxMs: 60_000 });
/** The page before this card: every 15 s, a failure read again 1 s on, doubling; no read at the write. */
export const BEFORE = Object.freeze({ refreshMs: 15_000, leadMs: null, pollMs: null, retryMs: 1_000 });
const SAMPLE_MS = 100;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const N = "[\\w$]+";
const NUM = "(\\d+(?:\\.\\d+)?(?:e\\d+)?)";
// the kit's Pyth feed entry, as minified: its account, then its maxAgeS
const BOUND = /7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE[^}]{0,400}?maxAgeS:(\d+(?:e\d+)?)/;
// pool-price.ts's constants, in their order, then wakeWhenShown: refresh, retry, the Retry-After cap, ahead (of the end), poll
const CONSTS = new RegExp(`var ${N}=${NUM},${N}=${NUM},${N}=${NUM},${N}=${NUM},${N}=${NUM};function ${N}\\(${N},${N}\\)\\{${N}\\.addEventListener\\(\`visibilitychange\``);
// the timer makes its own read due: `due.get(chain) === mine && due.set(chain, Math.min(mine, now()))`
const REARM = new RegExp(`(${N})\\.get\\((${N})\\)===(${N})&&\\1\\.set\\(\\2,Math\\.min\\(\\3,${N}\\(\\)\\)\\)`);
// a late feed told by the kit's PoolUsdStale
const LATE = /\.name===[`"']PoolUsdStale[`"']/;

/** What the check keeps of SIGN_HOST's page: the index, the served bundle's sha384, and the marks the bundle holds. */
export function facts(index, js) {
  const c = CONSTS.exec(js);
  const b = BOUND.exec(js);
  return {
    index,
    sha384: sha384(js),
    boundS: b ? Number(b[1]) : null,
    schedule: c ? { refreshMs: Number(c[1]), retryMs: Number(c[2]), retryAfterMaxMs: Number(c[3]), leadMs: Number(c[4]), pollMs: Number(c[5]) } : null,
    rearm: REARM.test(js),
    late: LATE.test(js),
  };
}

/**
 * The page's schedule for one chain, on `read` (the kit's poolUsdPrice on a pair): read, hold a newer good price (never
 * an older one, and the same publish not again), and read again as src/pool-price.ts does: a good read POOL_PRICE_WRITE_LEAD_MS before the held price's end,
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
        // a newer price only: an older one never, and the same publish leaves the held read as it was (src/pool-price.ts)
        if (p === null || got.publishedS > p.publishedS) {
          held.push({ publishedS: got.publishedS, at: got.at, heldMs: now() });
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
    writes.forEach((w, i) => {
      const prev = run.held[i];
      if (!Number.isSafeInteger(w.blockTimeS)) return void bad(`the write published ${w.publishedS} has no landing time`);
      const beat = w.blockTimeS - prev.publishedS >= HEARTBEAT_FROM_S;
      const limit = beat ? WRITE_HELD_MS : MOVE_HELD_MS;
      if (w.heldMs - w.blockTimeS * 1000 > limit) bad(`the write published ${w.publishedS} (landed ${w.blockTimeS}, ${w.blockTimeS - prev.publishedS} s into the last price${beat ? ", at the heartbeat" : ", on a move"}) was held ${((w.heldMs - w.blockTimeS * 1000) / 1000).toFixed(1)} s after it landed, not within ${limit / 1000} s`);
    });
  }
  const sign = rec?.sign ?? {};
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(sign.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== sign.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (folded && !folded.has(sign.sha384)) bad(`SIGN_HOST's /app.js is in no release list: ${sign.sha384 ?? "not read"}`);
  if (POOL_USD_FEEDS.solana.maxAgeS !== BOUND_S) bad(`this checkout's kit holds Solana's price ${POOL_USD_FEEDS.solana.maxAgeS} s, not ${BOUND_S} s`);
  if (sign.boundS !== BOUND_S) bad(`SIGN_HOST's page holds Solana's price ${sign.boundS ?? "(no mark)"} s, not ${BOUND_S} s: a price between writes runs out`);
  const sc = sign.schedule;
  const want = `refresh ${SCHEDULE.refreshMs}, retry ${SCHEDULE.retryMs}, Retry-After cap ${SCHEDULE.retryAfterMaxMs}, ahead ${SCHEDULE.leadMs}, poll ${SCHEDULE.pollMs}`;
  if (!sc) bad(`SIGN_HOST's page reads on no schedule at the write (no mark): the old every-15-s reads, not ${want}`);
  else if (Object.keys(SCHEDULE).some((k) => sc[k] !== SCHEDULE[k])) bad(`SIGN_HOST's page reads on refresh ${sc.refreshMs}, retry ${sc.retryMs}, Retry-After cap ${sc.retryAfterMaxMs}, ahead ${sc.leadMs}, poll ${sc.pollMs}, not ${want}`);
  if (sign.rearm !== true) bad("SIGN_HOST's page's timer does not make its own read due: a timer a hair early ends the reads for good");
  if (sign.late !== true) bad("SIGN_HOST's page does not tell a late feed by the kit's PoolUsdStale: a late write waits out the failure backoff");
  return { ok: lines.length === 0, lines };
}

/** SIGN_HOST's /app.js sha384 in every release list (packages/signpage/releases/), from release-`from` on. */
export function foldedReleases(dir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages/signpage/releases"), from = 0) {
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
  return { at, rpcs: PAGE_PAIR, run, sign: facts(await get("/"), await get("/app.js")) };
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
