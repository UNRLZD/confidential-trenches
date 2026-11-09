// The helper's Jupiter budget is idle (card helper-live-jup-serial): read from the helper's own answer, never a fixed sleep.
//
// The helper counts every send to Jupiter in one window for all its callers and holds its own reads back for the devices'
// (apps/helper/src/proxy/proxy.ts), so a live check that reads a Jupiter row through the helper, started while another
// spends the window, reads the helper's fallback (a page named on chain, X-Helper-Source "chain") and fails for nothing
// the code did (run 42332950254 attempt 1). The helper exposes no count of the window, and a number added to its health
// answer would be a deploy of its own, so the signal is what the budget does to one read of the kind that needs it: a
// cold Solana token page, a token nobody opened (drawn from Jupiter's verified list, less the helper's Discover lists, as
// helper-token-page-cold draws them). The budget is idle when that page, asked now,
//   - answers 200, and its Jupiter row (risk.holders src "jupiter") was read at or after the request was sent, less
//     SKEW_MS (helper-token-page-cold's own `cold`), so its search went out for this read; and
//   - names no wait in its Server-Timing for a search that did not land (search-room, search-gap, search-held, search-429,
//     search-upstream, or jup;desc="late"), and read;dur, the helper's whole time for it, is at most LIMIT_MS (the
//     cold-page check's own bound on a page).
// The page's search is the helper's strictest lane (proxy.ts freeAt: it goes at once with fewer than 6 of the window's 10
// sends spent, or with no page in it), so a page that got its row at once says a device's build, which needs fewer than 9,
// would go at once too. What the read cannot say is who is spending the budget while it is idle (a build in flight with
// room left reads idle: solana-jupiter-build running, probe 1 read idle in 47 ms, 7 Nov): the group has one check
// at a time, so the budget it reads is the budget the previous member left.
// The probe's search is itself one of the window's sends: a probe that went at once as the 6th of the own reads' 6 left
// none for the check's first page (live run 42662889061, 17:20:26.89Z: the check's page 0.3 s after the probe waited 702
// ms for a turn and was named on chain; card helper-live-red). So once a probe reads idle, the gate waits DRAIN_MS, the
// helper's window (proxy.ts BURST_MS), for the probe's own send to leave it before the check runs: the check reads the
// budget the previous member left, never the one the gate spent.
// Until then the next probe goes when the helper says: a 429 or 503's Retry-After (whole seconds, 1 to RETRY_MAX_S), else
// POLL_MS; it never goes sooner than that, and never past IDLE_MAX_MS in all (a minute's window and the page's 16 a counted
// minute drain in a minute; past three, something other than this run is spending the budget, and a check run now would
// read that, so the gate says so and the check does not run). Each probe is one search, a page's, so a run that waits
// spends a few of the budget's 60 a minute, never a build's room (a page takes only what the devices leave it).
//   node scripts/ci/jup-idle.mjs [--base <url>]      exit 0 once idle, 1 when it never is, 2 on an error
import "../net-window.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP, BASE, LIMIT_MS, POOL_URL, cold } from "../live-checks/helper-token-page-cold.mjs";

export const POLL_MS = 5_000;
export const RETRY_MAX_S = 15;
export const IDLE_MAX_MS = 180_000;
/** How long an idle probe's own search counts in the helper's Jupiter window: proxy.ts BURST_MS (a test holds the two
 *  equal). */
export const DRAIN_MS = 10_000;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// the Server-Timing entries a page that did not get its Jupiter row names (token.ts: searchMetric, jupiterWithin)
const WAITED = /(^|,\s*)(search-[a-z0-9]+|jup;desc="late")/;

/** The helper's whole time for a page, from its Server-Timing read;dur, or null when it names none. */
export const readMs = (timing) => {
  const m = /(?:^|,\s*)read;dur=(\d{1,9})(?:\s*(?:,|;|$))/.exec(timing ?? "");
  return m ? Number(m[1]) : null;
};

/** The wait a 429 or 503 names, in ms: Retry-After in whole seconds, 1 to RETRY_MAX_S, else null. Hostile input. */
export const retryMs = (value) => (/^\d{1,3}$/.test(value ?? "") && Number(value) >= 1 ? Math.min(Number(value), RETRY_MAX_S) * 1000 : null);

/** What one page read says of the budget: { idle, why } from its recorded answer. */
export function judge(read) {
  if (read.status !== 200) return { idle: false, why: `the page answered ${read.status}${read.timing ? `, Server-Timing ${read.timing}` : ""}` };
  if (!cold(read)) return { idle: false, why: `the page's Jupiter row was not read for it (src ${read.src ?? "none"})${read.timing ? `, Server-Timing ${read.timing}` : ""}` };
  if (WAITED.test(read.timing ?? "")) return { idle: false, why: `the page named a search that did not land, Server-Timing ${read.timing}` };
  const ms = readMs(read.timing);
  if (ms === null) return { idle: false, why: `the page's Server-Timing names no read;dur (${read.timing ?? "none"})` };
  if (ms > LIMIT_MS) return { idle: false, why: `the page took ${ms} ms, over ${LIMIT_MS} ms` };
  return { idle: true, why: `a cold page read in ${ms} ms with its Jupiter row` };
}

async function page(base, mint, fetchFn) {
  const sentAt = Date.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/market/token?chain=solana&token=${mint}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
    const text = await r.text();
    let jupAt = null;
    let src = null;
    try {
      const h = JSON.parse(text).risk?.holders;
      if (Number.isSafeInteger(h?.as_of_ms)) jupAt = h.as_of_ms;
      if (typeof h?.src === "string") src = h.src;
    } catch {}
    return { status: r.status, sentAt, jupAt, src, retryAfter: r.headers.get("retry-after"), timing: r.headers.get("server-timing") };
  } catch (e) {
    return { status: 0, sentAt, jupAt: null, src: null, retryAfter: null, timing: `error ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/** The mints a probe may ask, shuffled: Jupiter's verified list less every token on the helper's Solana lists. */
async function mintsOf(base, fetchFn, rand) {
  const l = await fetchFn(`${base.replace(/\/$/, "")}/v1/market/lists?chain=solana`, { headers: { origin: APP } });
  if (l.status !== 200) throw new Error(`GET /v1/market/lists?chain=solana answered ${l.status}`);
  const listed = new Set();
  for (const list of Object.values(JSON.parse(await l.text()).lists ?? {})) if (Array.isArray(list)) for (const row of list) if (typeof row?.token === "string") listed.add(row.token);
  const p = await fetchFn(POOL_URL, { headers: { accept: "application/json" } });
  if (p.status !== 200) throw new Error(`Jupiter's verified list answered ${p.status}`);
  const pool = JSON.parse(await p.text());
  const ids = [...new Set((Array.isArray(pool) ? pool : []).map((t) => t?.id).filter((id) => typeof id === "string" && ADDRESS.test(id) && !listed.has(id)))];
  if (ids.length < 20) throw new Error(`only ${ids.length} verified tokens off the helper's lists to probe with`);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

/**
 * Probes until the budget is idle (see the top): { idle: true, probes, waitedMs, why } or { idle: false, probes, waitedMs,
 * why } with the last probe's reason once IDLE_MAX_MS is spent. `sleep` and `now` are injected, so a test never waits.
 */
export async function waitIdle({ base = BASE, fetchFn = fetch, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = () => performance.now(), rand = Math.random, log = () => {} } = {}) {
  const t0 = now();
  const mints = await mintsOf(base, fetchFn, rand);
  let probes = 0;
  for (;;) {
    const read = await page(base, mints[probes % mints.length], fetchFn);
    probes++;
    const v = judge(read);
    const waitedMs = Math.round(now() - t0);
    log(`probe ${probes} at +${(waitedMs / 1000).toFixed(1)} s: ${v.idle ? "idle" : "busy"}: ${v.why}`);
    if (v.idle) {
      await sleep(DRAIN_MS);
      return { idle: true, probes, waitedMs: Math.round(now() - t0), why: v.why };
    }
    const next = retryMs(read.retryAfter) ?? POLL_MS;
    if (now() - t0 + next > IDLE_MAX_MS) return { idle: false, probes, waitedMs: Math.round(now() - t0), why: v.why };
    await sleep(next);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  try {
    const r = await waitIdle({ base: a.includes("--base") ? a[a.indexOf("--base") + 1] : BASE, log: (l) => console.log(l) });
    console.log(r.idle ? `jup-idle: idle after ${r.probes} probes, ${r.waitedMs} ms` : `jup-idle: BAD the helper's Jupiter budget was not idle in ${r.waitedMs} ms (${r.probes} probes): ${r.why}`);
    process.exit(r.idle ? 0 : 1);
  } catch (e) {
    console.error(`jup-idle: ERROR: ${e.message}`);
    process.exit(2);
  }
}
