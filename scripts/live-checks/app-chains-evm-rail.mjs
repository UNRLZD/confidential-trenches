#!/usr/bin/env node
// Live check of card app-chains-evm-rail: a Base or Robinhood token page's left rail lists tokens on the shell's chain
// filter, as Discover does. Node reads HELPER_HOST's lists of Base and Robinhood (GET /v1/market/lists?chain=<chain>,
// 200) and takes each chain's top Trending token (Discover's order, columnRows in
// apps/terminal/src/screens/discover/model.ts). Headless Chromium opens APP_HOST/token/<chain>/<id> for each at
// 1440 x 900 (the slim rail; the rail is drawn from 1180 px), finds the terminal's frame inside SIGN_HOST's shell and
// reads the rail's rows by the chain of each row's link:
//   - on All (the filter's default): rows of more than one chain;
//   - after the top bar's chain chip picks the page's chain: rows, every one of that chain, the page's own token marked
//     when it is listed.
// A screenshot of each state is kept.
// After: app
//   node scripts/live-checks/app-chains-evm-rail.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute), the
// helper still answered live; --record writes what the run read (rows counted by chain, no ids), so the check's test
// can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { columnRows } from "../../apps/terminal/src/screens/discover/model.ts";
import { launchBrowser } from "../browsers.mjs";
import { named } from "./record-names.mjs";

const KEY = "app-chains-evm-rail";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
/** The chains whose token pages are opened, each named. */
export const CHAINS = ["base", "robinhood"];
const VIEWPORT = { width: 1440, height: 900 };
const READ_MS = 20_000;

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one recorded run: { loads: [{ chain, lists, opened, state, all, picked, marked, listed, shots }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const loads = rec.loads ?? [];
  say(CHAINS.every((c) => loads.some((l) => l.chain === c)), `${loads.length} token page load(s), want one of each of ${CHAINS.join(" and ")}`);
  for (const l of loads) {
    const c = l.chain;
    const tag = `/token/${c}/<top Trending token> at 1440`;
    say(l.lists === 200 && l.opened === true, `${tag}: the helper's ${c} lists answered ${l.lists ?? "nothing"}${l.opened ? ", its top Trending token opened" : ", no token to open"}`);
    say(l.state === "ready", `${tag}: the page is ${l.state ?? "not drawn"}`);
    const all = l.all ?? {};
    const allChains = Object.keys(all).filter((k) => all[k] > 0);
    say(allChains.length > 1, `${tag}: the rail on All draws ${fmt(all)}; want rows of more than one chain`);
    const picked = l.picked ?? {};
    const own = picked[c] ?? 0;
    const other = Object.entries(picked).filter(([k, n]) => k !== c && n > 0);
    say(own > 0 && other.length === 0, `${tag}: the rail on ${c} draws ${fmt(picked)}; want ${c} rows only`);
    say(!l.listed || l.marked === true, `${tag}: the page's own token ${l.listed ? (l.marked ? "listed and marked" : "listed but not marked") : "not among the rail's rows"} on ${c}`);
  }
  return { ok: lines.every((x) => x.startsWith("ok ")), lines };
}

const fmt = (counts) => (Object.keys(counts).length ? Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") : "no rows");

// ------------------------------------------------------------------------------------------------ the live read
/** Each chain's top Trending token from the helper's lists, read as the terminal reads them (Origin APP_HOST). */
async function topOf(chain) {
  const r = await fetch(`${HELPER_HOST}/v1/market/lists?chain=${chain}`, { headers: { origin: APP_HOST }, signal: AbortSignal.timeout(20_000) });
  const b = await r.json().catch(() => null);
  const L = b?.lists ?? {};
  const rows = (k) => (Array.isArray(L[k]) ? L[k].filter((x) => x?.chain === chain && typeof x?.token === "string") : []);
  const top = r.status === 200 && b?.chain === chain ? columnRows({ chain, as_of_ms: 0, lists: { new: rows("new"), trending: rows("trending"), trending_1h: rows("trending_1h") } }, "trending")[0] : null;
  return { status: r.status, id: top?.token ?? null };
}

/** The rail's rows in a frame once drawn, counted by the chain of each row's link; the page's own token's row marked. */
const RAIL = () => {
  const rail = document.querySelector('[data-testid="token-rail"]');
  if (!rail) return null;
  const page = document.querySelector("[data-token-page]");
  const id = page?.getAttribute("data-token") ?? null;
  const counts = {};
  let listed = false;
  let marked = false;
  for (const e of rail.querySelectorAll('[role="listitem"]')) {
    const a = e.querySelector("a");
    const c = /^\/token\/([a-z]+)\//.exec(a?.getAttribute("href") ?? "")?.[1] ?? "none";
    counts[c] = (counts[c] ?? 0) + 1;
    if (e.getAttribute("data-token") === id) {
      listed = true;
      marked = a?.getAttribute("aria-current") === "page";
    }
  }
  return { rail: rail.getAttribute("data-state"), state: page?.getAttribute("data-token-page") ?? null, counts, listed, marked };
};

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "signed");
  }
  const browser = await launchBrowser("chromium");
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", at: new Date().toISOString(), browser: browser.version(), loads: [] };
  try {
    for (const chain of CHAINS) {
      const top = await topOf(chain);
      const load = { chain, lists: top.status, opened: !!top.id, state: null, all: null, picked: null, listed: false, marked: false, shots: [] };
      rec.loads.push(load);
      if (!top.id) continue;
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "dark" });
      if (harness) await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === HELPER_HOST ? r.continue() : harness(r)));
      const page = await ctx.newPage();
      await page.goto(`${APP_HOST}/token/${chain}/${top.id}`, { waitUntil: "load" });
      let app = null;
      let m = null;
      const settle = async () => {
        for (const t0 = Date.now(); Date.now() - t0 < READ_MS; await page.waitForTimeout(250)) {
          for (const f of app ? [app] : page.frames()) {
            const x = await f.evaluate(RAIL).catch(() => null);
            if (x) {
              app = f;
              m = x;
              break;
            }
          }
          if (m && m.rail !== "loading" && m.state && m.state !== "loading") break;
        }
        await page.waitForTimeout(400);
        if (app) m = (await app.evaluate(RAIL).catch(() => null)) ?? m;
      };
      await settle();
      load.state = m?.state ?? null;
      load.all = m?.rail === "ready" ? m.counts : {};
      const s1 = `${chain}-all.png`;
      await page.screenshot({ path: path.join(shots, s1) });
      load.shots.push(s1);
      if (app) {
        // the top bar's chain chip, then the page's chain in its menu
        await app.click('[data-testid="chain-chip"]', { timeout: 5_000 }).catch(() => {});
        await app.click(`[data-testid="chain-menu"] [data-chain="${chain}"]`, { timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(400);
        m = (await app.evaluate(RAIL).catch(() => null)) ?? m;
        load.picked = m?.rail === "ready" ? m.counts : {};
        load.listed = !!m?.listed;
        load.marked = !!m?.marked;
        const s2 = `${chain}-${chain}.png`;
        await page.screenshot({ path: path.join(shots, s2) });
        load.shots.push(s2);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  rec.shots = shots;
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ build: opt("--build", null), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
