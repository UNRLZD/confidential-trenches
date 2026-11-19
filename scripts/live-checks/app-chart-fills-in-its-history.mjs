#!/usr/bin/env node
// Live check of card app-chart-fills-in-its-history: a coin's chart whose older bars the helper is still reading back
// (its candle answer has bars and `filling: true`) fills in on the open page, without a reload. The page reads the
// chart in full again (limit 500) AWAY_MS (45 s, candles.ts) after the first answer, every AWAY_MS while a full answer
// says filling, never sooner, and draws the whole chart once a full answer no longer says it. Before the card the first
// full read came RESYNC_MS (60 s) on.
//   1. Candidates: the listed tokens of Base, Robinhood and Solana (GET /v1/market/lists, columns new, trending_5m,
//      trending_1h, trending), taken in turn across the chains. Node reads no candles of a candidate first: a read would
//      open the helper's book of it, and the chart would no longer be cold.
//   2. Watch: headless Chromium opens APP_HOST/token/<chain>/<token> at 1440 x 900 and 390 x 844 (dpr 2, touch) at once,
//      finds the terminal's frame inside SIGN_HOST's shell, and keeps every candle read the page sends and every answer
//      (limit, status, bars, filling, own_from_s). A load whose first full answer is not bars and filling is no verdict
//      (a warm coin) and closes; one that is is watched until a full answer says no longer filling (and 3 s more, for the
//      drawing), or WATCH_MAX_MS.
//   3. Verdict per watched load (judge):
//      - after each full answer that says filling, the next full read is sent within AWAY_MS + SLACK_MS of the follow's
//        clock (the first answer's arrival, then each full read's send), and no sooner than AWAY_MS less a second,
//        unless a failed read came between (a failed read is followed by a full one at once, card app-chart-live);
//      - the chart is ready with a last bar drawn, one time origin (no reload), no console error and no page error in
//        the terminal's frame, a screenshot;
//      - a full answer that no longer said filling: filled (the bars it held are the chart drawn, foldBars, the one
//        fold rule, test/chart-live.test.ts).
//   PASS: no BAD line and a load filled. INCONCLUSIVE: no BAD line, and no candidate in TRIES picks gave a filling
//   first answer, or none stopped filling within the watch. FAIL: any BAD line.
//   The whole walk ends by RUN_MS from its start: no pick starts with less than PICK_MIN_MS left, and a load's waits stop
//   at it, so the run ends inside the bound the merge queue gives it (card app-chart-check-inside-its-bound).
// A screenshot of every load is kept.
// After: app
// Bundle: out a browser and the helper's cold coins
//   node scripts/live-checks/app-chart-fills-in-its-history.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (with --build, a FAIL while the helper missed an answer too: helper-misses.mjs)
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute), the
// helper still answered live; --record writes what the run read (trim: the count of candidates, and per pick its chain,
// the token as <token>, and per load the full reads and every failed read), so the check's test can replay it through
// judge().
// Record: what the run read; a live run that fails keeps it beside its log
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { launchHarnessBrowser } from "../harness-sockets.mjs";
import { consoleError, pageError } from "./console-errors.mjs";
import { downNote, footerEvidence, outages } from "./rpc-outage.mjs";
import { named } from "./record-names.mjs";
import { liveHelper, verdictOf as helperVerdict, EXIT as HELPER_EXIT } from "./helper-misses.mjs";

const KEY = "app-chart-fills-in-its-history";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
export const CHAINS = ["base", "robinhood", "solana"];
const CANDLES = `${HELPER_HOST}/v1/market/candles?`;
export const LOADS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
/** The page's wait between full reads while the helper names its chart filling (candles.ts AWAY_MS). */
export const AWAY_MS = 45_000;
/** The page's full read when nothing is filling (candles.ts RESYNC_MS): the wait before the card. */
export const RESYNC_MS = 60_000;
/** Room past AWAY_MS for the page's 1 s live tick and the live read out when the full one comes due. */
export const SLACK_MS = 7_000;
/** The longest a load waits for the page's first full answer (a 429's waits included, candles.ts THROTTLE_SPAN_S). */
export const FIRST_MS = 80_000;
export const WATCH_MAX_MS = 150_000;
export const TRIES = 6;
/** The whole walk's deadline from its start: candidates, every pick's loads and their waits (card
 *  app-chart-check-inside-its-bound: merge group 44571987928, test-browser (1) job 135729331112, 19 Nov 17:01-17:05Z, ran
 *  past its bound of 238 s, two times its listed 58 s or 180 s more, scripts/ci/test-shards.mjs boundOf, while the
 *  helper said filling: TRIES picks of FIRST_MS and WATCH_MAX_MS each had no deadline). It leaves 38 s of that bound for
 *  the browser's launch, the build's serving, the last screenshots and the close. */
export const RUN_MS = 200_000;
/** The least a pick needs to give a verdict: its first answer, the page's full read AWAY_MS on with SLACK_MS, and the 3 s
 *  the drawing is given. With less left no pick starts. */
export const PICK_MIN_MS = AWAY_MS + SLACK_MS + 10_000;
/** Whether a pick may start at `now` within a walk that ends at `deadline`. */
export const pickFits = (now, deadline) => deadline - now >= PICK_MIN_MS;
export const FULL = "500";

// ------------------------------------------------------------------------------------------------ the verdict
const ok200 = (a) => a.status === 200;

/** One load's verdict: { kind: "warm" | "filled" | "filling" , bad: [], said } from its sends and answers. */
export function loadVerdict(l) {
  const answers = (l.answers ?? []).filter((a) => a.limit === FULL);
  const sends = (l.sends ?? []).filter((s) => s.limit === FULL).map((s) => s.at_ms);
  // the first full answer with bars is the one drawn (a 429 or a filling answer of no bars before it is read again by
  // loadCandles, the chart loading meanwhile)
  const k = answers.findIndex((a) => ok200(a) && a.bars > 0);
  const first = answers[k];
  if (!first || first.filling !== true) {
    const what = first ? `${first.bars} bars` : `none of ${answers.length}`;
    return { kind: "warm", bad: [], said: `the first full answer with bars (${what}) is not still filling` };
  }
  const bad = [];
  const gaps = [];
  let base = first.at_ms;
  let kind = "filling";
  let bars = first.bars;
  for (let i = k; i < answers.length; i++) {
    const a = answers[i];
    if (i > k) base = sends[i] ?? base;
    if (!ok200(a)) continue;
    if (a.filling !== true) {
      kind = "filled";
      bars = a.bars;
      break;
    }
    const nextSend = sends[i + 1];
    const due = base + AWAY_MS + SLACK_MS;
    if (nextSend === undefined) {
      if ((l.endedAt ?? 0) > due) bad.push(`after a full answer that said filling the page sent no full read in ${Math.round(((l.endedAt ?? 0) - base) / 1000)} s (due within ${(AWAY_MS + SLACK_MS) / 1000} s)`);
      break;
    }
    const gap = nextSend - base;
    gaps.push(gap);
    const failedBetween = (l.answers ?? []).some((x) => !ok200(x) && x.at_ms >= base && x.at_ms <= nextSend);
    if (gap > AWAY_MS + SLACK_MS) bad.push(`after a full answer that said filling the next full read came ${(gap / 1000).toFixed(1)} s on, past AWAY_MS + ${SLACK_MS / 1000} s`);
    else if (gap < AWAY_MS - 1_000 && !failedBetween) bad.push(`a full read ${(gap / 1000).toFixed(1)} s after the last, sooner than AWAY_MS, with no failed read between`);
  }
  if (l.chart !== "ready") bad.push(`the chart is ${l.chart ?? "not there"}`);
  if (l.last === null || l.last === undefined) bad.push("no last bar drawn");
  if (!(l.origin > 0) || l.originEnd !== l.origin) bad.push(`the frame was loaded again (time origin ${l.origin} -> ${l.originEnd})`);
  const { kept, down } = outages(l.errors ?? [], null, "mainnet", l.footer);
  if (kept.length) bad.push(`errors: ${kept.join(" | ")}`);
  if (!l.shot) bad.push("no screenshot");
  const g = gaps.map((x) => `${(x / 1000).toFixed(1)} s`).join(", ") || "none";
  const said = kind === "filled" ? `first drawn with ${first.bars} bars, filling; full reads ${g} apart; filled with ${bars} bars, no reload${downNote(down)}` : `first drawn with ${first.bars} bars, filling; full reads ${g} apart; the helper still said filling after ${Math.round(((l.endedAt ?? 0) - first.at_ms) / 1000)} s${downNote(down)}`;
  return { kind, bad, said };
}

/** A verdict's exit code: PASS 0, FAIL 1, INCONCLUSIVE 3 (an error exits 2). */
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });

/** The check on one recorded run: { verdict: PASS | FAIL | INCONCLUSIVE, ok, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (good, text) => lines.push(`${good ? "ok " : "BAD"} ${text}`);
  const picks = rec.picks ?? [];
  const cands = typeof rec.candidates === "number" ? rec.candidates : (rec.candidates ?? []).length;
  say(cands > 0 && picks.length > 0, `${cands} listed candidates on ${CHAINS.join(", ")}; ${picks.length} picks`);
  let filled = 0;
  for (const [n, p] of picks.entries()) {
    for (const [i, l] of (p.loads ?? []).entries()) {
      const tag = `pick ${n + 1} ${p.chain}/<token> ${LOADS[i]?.name ?? l.width}`;
      if (p.token && l.opened !== `${APP_HOST}/token/${p.chain}/${p.token}`) say(false, `${tag}: opened ${l.opened}`);
      const v = loadVerdict(l);
      if (v.kind === "warm") {
        say(true, `${tag}: ${v.said}: no verdict`);
        continue;
      }
      if (v.kind === "filled" && v.bad.length === 0) filled++;
      say(v.bad.length === 0, `${tag}: ${v.bad.length ? v.bad.join("; ") : v.said}`);
    }
  }
  const bad = lines.some((x) => x.startsWith("BAD"));
  if (!bad && filled === 0) lines.push(`INCONCLUSIVE no load in ${picks.length} picks was first drawn filling and then filled within the watch`);
  const verdict = bad ? "FAIL" : filled > 0 ? "PASS" : "INCONCLUSIVE";
  return { verdict, ok: verdict === "PASS", lines };
}

/** A run as its record keeps it: what judge() reads and nothing more. The candidates are a count and a pick has no
 *  symbol (a coin's name is any text its launcher chose), each picked token is <token> (a 40-hex address reads as a key
 *  to the secret scan, as in app-chart-live's records), and a load keeps its full reads and its failed reads of any
 *  size, not the live reads that answered. */
export function trim(rec) {
  const keep = (l) => ({
    ...l,
    sends: (l.sends ?? []).filter((x) => x.limit === FULL),
    answers: (l.answers ?? []).filter((x) => x.limit === FULL || x.status !== 200),
  });
  const out = {
    source: rec.source,
    at: rec.at,
    browser: rec.browser,
    candidates: typeof rec.candidates === "number" ? rec.candidates : (rec.candidates ?? []).length,
    picks: (rec.picks ?? []).map((p) => ({ chain: p.chain, token: "<token>", loads: (p.loads ?? []).map(keep) })),
  };
  let text = JSON.stringify(out);
  for (const p of rec.picks ?? []) if (p.token && p.token !== "<token>") text = text.replaceAll(p.token, "<token>");
  return JSON.parse(text);
}

// ------------------------------------------------------------------------------------------------ the live read
const headers = { origin: APP_HOST, "cache-control": "no-cache" };

/** The listed tokens of every chain, taken in turn across the chains. */
export async function candidates() {
  const per = [];
  for (const chain of CHAINS) {
    const out = [];
    try {
      const r = await fetch(`${HELPER_HOST}/v1/market/lists?chain=${chain}`, { headers, signal: AbortSignal.timeout(15_000) });
      const body = await r.json();
      const seen = new Set();
      for (const column of ["new", "trending_5m", "trending_1h", "trending"]) {
        for (const x of body?.lists?.[column] ?? []) {
          if (typeof x?.token !== "string" || seen.has(x.token)) continue;
          seen.add(x.token);
          out.push({ chain, token: x.token, symbol: x.symbol ?? null });
        }
      }
    } catch {}
    per.push(out);
  }
  const all = [];
  for (let i = 0; per.some((l) => i < l.length); i++) for (const l of per) if (i < l.length) all.push(l[i]);
  return all;
}

const MEASURE = () => {
  const root = document.querySelector('main[data-route="token"]');
  const c = [...(root?.querySelectorAll("[data-chart]") ?? [])].find((e) => e.getClientRects().length);
  return { route: root?.dataset.route ?? null, chart: c?.getAttribute("data-chart") ?? null, last: c?.querySelector("[data-testid=chart-canvas]")?.getAttribute("data-last") || null };
};

async function watchLoad(browser, w, i, pick, harness, shots, n, deadline) {
  const opened = `${APP_HOST}/token/${pick.chain}/${pick.token}`;
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
  if (harness) await liveHelper(ctx, harness);
  const page = await ctx.newPage();
  const errors = [];
  const sends = [];
  const answers = [];
  page.on("request", (r) => {
    if (r.url().startsWith(CANDLES)) sends.push({ at_ms: Date.now(), limit: new URL(r.url()).searchParams.get("limit") });
  });
  page.on("response", (r) => {
    if (!r.url().startsWith(CANDLES)) return;
    const a = { at_ms: Date.now(), limit: new URL(r.url()).searchParams.get("limit"), status: r.status() };
    answers.push(a);
    if (r.status() !== 200) return;
    void r.json().then(
      (b) => {
        a.bars = Array.isArray(b?.candles) ? b.candles.length : null;
        a.filling = b?.filling === true;
        a.own = Number.isSafeInteger(b?.own_from_s);
      },
      () => undefined,
    );
  });
  // a read that got no answer (its timeout, a dropped connection) is a failed one, so every send has its answer
  page.on("requestfailed", (r) => {
    if (r.url().startsWith(CANDLES)) answers.push({ at_ms: Date.now(), limit: new URL(r.url()).searchParams.get("limit"), status: 0 });
  });
  page.on("console", (m) => m.type() === "error" && errors.push(consoleError(m)));
  page.on("pageerror", (e) => errors.push(pageError(e)));
  const t0 = Date.now();
  await page.goto(opened, { waitUntil: "load" });
  const fullAnswers = () => answers.filter((a) => a.limit === FULL && (a.status !== 200 || a.filling !== undefined));
  while (Date.now() - t0 < FIRST_MS && Date.now() < deadline && !fullAnswers().some((a) => a.status === 200 && a.bars > 0)) await page.waitForTimeout(250);
  const first = fullAnswers().find((a) => a.status === 200 && a.bars > 0);
  if (first?.filling) {
    let doneAt = null;
    for (const s = Date.now(); Date.now() - s < WATCH_MAX_MS && Date.now() < deadline; await page.waitForTimeout(250)) {
      if (doneAt === null && fullAnswers().some((a) => a.status === 200 && a.filling === false && a.at_ms > first.at_ms)) doneAt = Date.now();
      if (doneAt !== null && Date.now() - doneAt > 3_000) break;
    }
  } else await page.waitForTimeout(3_000);
  let app = null;
  let m = null;
  for (const f of page.frames()) {
    const x = await f.evaluate(MEASURE).catch(() => null);
    if (x?.route) {
      app = f;
      m = x;
      break;
    }
  }
  const origin = app ? await app.evaluate(() => performance.timeOrigin).catch(() => null) : null;
  const endedAt = Date.now();
  // the record keeps the file's name only: the folder is the recorder's own, printed once at the end
  const shot = `${n}-${i}-${w.name}.png`;
  await page.screenshot({ path: path.join(shots, shot) });
  const originEnd = app ? await app.evaluate(() => performance.timeOrigin).catch(() => null) : null;
  // the footer's clock for outages()'s read cap is read last, as the error list closes
  const footer = app ? await footerEvidence(app).catch(() => null) : null;
  await ctx.close();
  return { width: w.name, opened, chart: m?.chart ?? null, last: m?.last ?? null, origin, originEnd, startedAt: t0, endedAt, sends, answers, errors, footer, shot };
}

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  const deadline = Date.now() + RUN_MS;
  const cands = await candidates();
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", at: new Date().toISOString(), candidates: cands.map((c) => ({ chain: c.chain, symbol: c.symbol })), picks: [], shots };
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "signed");
  }
  const browser = await (build ? launchHarnessBrowser : launchBrowser)("chromium");
  rec.browser = browser.version();
  try {
    for (let n = 0; n < TRIES && n < cands.length && pickFits(Date.now(), deadline); n++) {
      const pick = cands[n];
      const loads = await Promise.all(LOADS.map((w, i) => watchLoad(browser, w, i, pick, harness, shots, n, deadline)));
      rec.picks.push({ ...pick, loads });
      if (loads.some((l) => loadVerdict(l).kind === "filled")) break;
    }
  } finally {
    await browser.close();
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ build: opt("--build", null), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots (trim)
    if (file) writeFileSync(file, `${JSON.stringify(trim(rec), null, 1)}\n`);
    const { verdict: judged, lines } = judge(rec);
    for (const x of lines) console.log(x);
    // a FAIL in a run where the helper missed an answer the page asked for is INCONCLUSIVE (helper-misses.mjs)
    const miss = helperVerdict(judged);
    for (const x of miss.lines) console.log(x);
    const verdict = miss.verdict;
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${verdict}`);
    process.exit(HELPER_EXIT[verdict]);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
