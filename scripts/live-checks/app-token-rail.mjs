#!/usr/bin/env node
// Live check of card app-token-rail: the token page's left rail lists Trending and New, as design-lock-r5 draws it
// (trenches-1440.html rail, proto.css .rail and .rr, token.css's width modes). Two reads:
//   - the rail's data on Solana: HELPER_HOST's GET /v1/market/lists?chain=solana, one of the chains of Discover's own
//     read that the rail draws (every chain's since card app-chains-evm-rail, whose check reads Base and Robinhood). It
//     must answer 200 with a Solana snapshot whose Trending column (the 1h list, rows traded in the hour) and New column
//     each hold at least one row with a token id and a symbol;
//   - what APP_HOST serves: the page, then every script and stylesheet it names, which must hold the rail (token-rail,
//     rail-expand, tkr-row, tkr-chip) and its rules (.tkr-row, .tkr-exp) with both width modes (the slim rail under
//     1500 px: 1499.98px; no rail under 1180: 1179.98px).
// The behaviour (each mode's width at 1600, 1440, 1280, 1180 and 1179, the strip whole in each, a rail click opening its
// token, New, the slim rail's expand, CLS 0, signed in and out) is the terminal's own browser run,
// apps/terminal/test/token-rail/run.mjs, and the data store apps/terminal/test/token-rail.test.ts.
// After: app
//   node scripts/live-checks/app-token-rail.mjs [--url <url>] [--helper <url>] [--record <file>]
//   node scripts/live-checks/app-token-rail.mjs --root <dir> [...]   the page read from a local build
//     (apps/terminal/dist, built first) on disk; the helper is still read live
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the lists answer's counts and the markers each file holds, not the files), so the
// check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-token-rail";
export const APP_URL = "https://ct-app.unrealized.trade/";
export const HELPER_URL = "https://ct-api.unrealized.trade";
// each a test id or class only the rail draws
export const JS_MARKERS = ["token-rail", "rail-expand", "tkr-row", "tkr-chip"];
// the rail's rules and its two width modes (rail.css, token.css .tkp-desk)
export const CSS_MARKERS = [".tkr-row", ".tkr-exp", "1499.98px", "1179.98px"];

/** The page's scripts and stylesheets: the `src` of each script tag and the `href` of each stylesheet link. */
export function assetsOf(html) {
  const js = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  const css = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
  return { js, css };
}

const holds = (text, markers) => markers.filter((m) => text.includes(m));
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isRow = (r) => isObject(r) && typeof r.token === "string" && r.token !== "" && typeof r.symbol === "string" && r.symbol !== "";
const vol = (v) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : 0);

/** The facts of one lists answer the verdict reads: the rows each rail list would draw, counted, not kept. Trending as
 *  Discover's column takes it (the 1h list, else `trending`, rows with an hour's volume); New, every row. */
export function listsFacts(status, body) {
  const b = isObject(body) ? body : {};
  const L = isObject(b.lists) ? b.lists : {};
  const trendingList = Array.isArray(L.trending_1h) ? L.trending_1h : Array.isArray(L.trending) ? L.trending : null;
  return {
    status,
    chain: b.chain ?? null,
    trending: trendingList === null ? null : trendingList.filter((r) => isRow(r) && vol(r.vol_1h_usd) > 0).length,
    new: Array.isArray(L.new) ? L.new.filter(isRow).length : null,
  };
}

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, lists: { status, chain, trending, new }, pageStatus, js, css }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const l = rec.lists ?? {};
  say(l.status === 200 && l.chain === "solana", `the helper's lists read answers ${l.status ?? "nothing"} for ${l.chain ?? "no chain"}`);
  say(Number.isSafeInteger(l.trending) && l.trending > 0, `the rail's Trending list holds ${l.trending ?? "no"} row(s) traded in the hour`);
  say(Number.isSafeInteger(l.new) && l.new > 0, `the rail's New list holds ${l.new ?? "no"} row(s)`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const js = rec.js ?? [];
  const css = rec.css ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  say(css.length > 0 && css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  const jsHeld = new Set(js.flatMap((f) => f.found ?? []));
  const missJs = JS_MARKERS.filter((m) => !jsHeld.has(m));
  say(missJs.length === 0, missJs.length ? `the scripts lack the rail: ${missJs.join(", ")}` : `the scripts hold the rail: ${JS_MARKERS.join(", ")}`);
  const cssHeld = new Set(css.flatMap((f) => f.found ?? []));
  const missCss = CSS_MARKERS.filter((m) => !cssHeld.has(m));
  say(missCss.length === 0, missCss.length ? `the stylesheets lack the rail's rules: ${missCss.join(", ")}` : `the stylesheets hold the rail's rules and width modes: ${CSS_MARKERS.join(", ")}`);
  return { ok: lines.every((x) => x.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  return { status: r.status, text: await r.text() };
}

export async function collect({ url = APP_URL, helper = HELPER_URL, root = null } = {}) {
  const lr = await http(`${helper}/v1/market/lists?chain=solana`);
  let body = null;
  try {
    body = JSON.parse(lr.text);
  } catch {}
  const read = async (ref, base) => {
    if (root) {
      const file = path.join(root, new URL(ref, "http://x/").pathname);
      try {
        return { status: 200, text: readFileSync(file, "utf8") };
      } catch {
        return { status: 404, text: "" };
      }
    }
    return http(new URL(ref, base).href);
  };
  const page = root ? { status: 200, text: readFileSync(path.join(root, "index.html"), "utf8") } : await http(url);
  const { js, css } = assetsOf(page.text);
  const rec = { source: `${root ? `a local build read from ${path.basename(root)}` : url}; ${helper}`, at: new Date().toISOString(), lists: listsFacts(lr.status, body), pageStatus: page.status, js: [], css: [] };
  for (const ref of js) {
    const f = await read(ref, url);
    rec.js.push({ url: ref, status: f.status, found: holds(f.text, JS_MARKERS) });
  }
  for (const ref of css) {
    const f = await read(ref, url);
    rec.css.push({ url: ref, status: f.status, found: holds(f.text, CSS_MARKERS) });
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ url: opt("--url", APP_URL), helper: opt("--helper", HELPER_URL), root: opt("--root", null) ? path.resolve(opt("--root", null)) : null });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
