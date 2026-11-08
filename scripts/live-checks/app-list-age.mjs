#!/usr/bin/env node
// Live check of card app-list-age: Discover draws how old the helper's lists are once their read is older than 60 s,
// and nothing on a fresh read. APP_HOST's terminal is framed by a stand-in for SIGN_HOST's shell (app-in-shell.mjs).
// Headless Chromium opens /discover at 1440 x 900 and 390 x 844 (dpr 2, touch), twice each:
//   - served: the helper's lists as it serves them now; the age Discover draws must be the one the served read's
//     as_of_ms gives (listAge, apps/terminal/src/screens/discover/model.ts), so none while the read is fresh;
//   - dated: the lists answer replaced by the recorded 1 Nov 16:15Z read (app-in-shell.mjs's recorded lists), days old,
//     as the helper serves its last good read since app-console-429; Discover must draw that age ("Updated 2d ago" on 4 Nov).
// The page re-reads every 12 s, so a drawn age is taken as right when it is listAge of the last lists answer the page
// read at the time of the reading, or 12 s before it.
// Node reads the served / first and records the build's entry script, so a run names the build it judged.
// After: app
//   node scripts/live-checks/app-list-age.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/app-list-age.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, every helper read recorded
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";
import { listAge } from "../../apps/terminal/src/screens/discover/model.ts";
import { ageLine } from "../../apps/terminal/src/screens/discover/words.ts";

const KEY = "app-list-age";
export const APP_HOST = "https://ct-app.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://ct-api.unrealized.trade";
const LISTS_PATH = "/v1/market/lists";
export const KINDS = ["served", "dated"];
export const WIDTHS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const REFRESH_MS = 12_000;
const READY_MS = 20_000;

/** The age lines Discover may draw for a read dated `asOfMs`, read at `atMs`: none or the line (listAge, ageLine). */
export function expectedAges(asOfMs, atMs) {
  return [...new Set([atMs, atMs - REFRESH_MS].map((t) => listAge(asOfMs, t)).map((a) => (a ? ageLine(a) : null)))];
}

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  say(typeof rec.entry === "string" && /^\/assets\/[\w.-]+\.js$/.test(rec.entry), `the served / names its entry script ${rec.entry ?? "none"}`);
  const runs = rec.runs ?? [];
  const want = WIDTHS.flatMap((w) => KINDS.map((k) => `${w.name} ${k}`));
  const have = new Set(runs.map((r) => `${r.width} ${r.kind}`));
  say(want.every((k) => have.has(k)), `${runs.length} run(s) of ${want.length} (desktop and phone, served and dated)`);
  for (const r of runs) {
    const n = `${r.width} ${r.kind}`;
    const bad = [];
    if (r.framed !== true) bad.push("not inside SIGN_HOST's shell");
    if (r.state !== "ready") bad.push(`Discover is ${r.state ?? "not drawn"}, not ready`);
    const asOf = r.lists?.asOfMs;
    let ok = [];
    if (!(typeof asOf === "number")) bad.push("the page read no dated lists answer");
    else {
      if (r.lists.status !== 200) bad.push(`the lists answered ${r.lists.status}`);
      ok = expectedAges(asOf, r.readAtMs);
      if (!ok.includes(r.age ?? null)) bad.push(`draws ${JSON.stringify(r.age ?? null)} for a read ${Math.round((r.readAtMs - asOf) / 1000)} s old, want ${ok.map((x) => JSON.stringify(x)).join(" or ")}`);
      if (r.kind === "dated" && !(r.readAtMs - asOf > 24 * 3_600_000)) bad.push("the dated read is not days old");
    }
    if (!r.shot) bad.push("no screenshot");
    say(bad.length === 0, `${n}: ${bad.length ? bad.join("; ") : `a read ${Math.round((r.readAtMs - asOf) / 1000)} s old draws ${JSON.stringify(r.age ?? null)}`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

async function terminal(page) {
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    const f = page.frames().find((x) => x !== page.mainFrame() && originOf(x.url()) === APP_HOST);
    if (f) return f;
    await page.waitForTimeout(100);
  }
  return null;
}

async function runOne(browser, w, kind, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, kind, framed: false, state: null, age: null, lists: null, readAtMs: null, shot: null };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    // the last lists answer the page read, with its read time
    let last = null;
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.origin === HELPER_HOST && u.pathname === LISTS_PATH) last = r;
    });
    await page.goto(`${APP_HOST}/discover`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector('main[data-route="discover"] .dsc:not([data-discover="loading"])', { timeout: READY_MS }).catch(() => {});
    await page.waitForTimeout(600);
    Object.assign(
      run,
      await f.evaluate(() => {
        const vis = (e) => e.getClientRects().length > 0;
        const a = [...document.querySelectorAll('[data-testid="list-age"]')].filter(vis)[0];
        return { state: document.querySelector('main[data-route="discover"] .dsc')?.dataset.discover ?? null, age: a ? a.textContent.trim() : null };
      }),
    );
    run.readAtMs = Date.now();
    if (last) {
      const body = await last.json().catch(() => null);
      run.lists = { status: last.status(), asOfMs: typeof body?.as_of_ms === "number" ? body.as_of_ms : null };
    }
    run.shot = `${w.name}-${kind}.png`;
    await page.screenshot({ path: path.join(shots, run.shot) });
    return run;
  } finally {
    await ctx.close();
  }
}

/** The served / and its entry script: from `build` on the harness, else APP_HOST as served. */
async function entryOf(build) {
  const html = build ? readFileSync(path.join(build, "index.html"), "utf8") : await (await fetch(`${APP_HOST}/`, { signal: AbortSignal.timeout(15_000) })).text();
  return html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? null;
}

export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), build = null, source }) {
  mkdirSync(shots, { recursive: true });
  const entry = await entryOf(build);
  const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed");
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const kind of KINDS) {
      // served: APP_HOST and the helper as served (the harness: all recorded); dated: the lists answer is the recorded
      // 1 Nov read, every other read as in served
      const route = (r) => {
        const u = new URL(r.request().url());
        if (kind === "dated" && u.origin === HELPER_HOST && u.pathname === LISTS_PATH) return shell(r);
        if (build) return shell(r);
        return u.origin === APP_HOST || u.origin === HELPER_HOST ? r.continue() : shell(r);
      };
      for (const w of WIDTHS) runs.push(await runOne(browser, w, kind, shots, route));
    }
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), entry, shots, runs };
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let build = null;
    let source = `live ${APP_HOST}, the stand-in shell, the helper live (dated: the recorded 1 Nov lists)`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      const rel = path.relative(REPO, build);
      source = `harness, terminal build ${rel && !rel.startsWith("..") ? rel : "<build>"}, the stand-in shell, every helper read recorded`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), build, source });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source}, Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
