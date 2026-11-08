#!/usr/bin/env node
// Live check of card app-token-lower-panel: under the token chart, who holds and who trades, as design-lock-r5 draws it
// (token.js U.lowerTabs, U.tradesTab, U.holdersTab, U.about). Two reads:
//   - the holders total for a mint: HELPER_HOST's GET /v1/market/holders for the top of its Solana Trending column (or
//     --mint), the read the Holders tab draws. It must answer 200 with the token's holder count (a whole number above
//     zero), a top-10 share in basis points, `src` "chain" (the holders key's rows, at most 20, each an address, a
//     base-unit amount and a share) or "jupiter" (no rows: Jupiter's count and share until the holders key);
//   - what APP_HOST serves: the page, then every script and stylesheet it names, which must hold the lower panel and its
//     tabs, rows and empty state (lower-tabs, lower-rows-trades, lower-rows-holders, holders-top, lower-empty), the
//     holders read (/v1/market/holders) and About (ticket-about, about-windows, about-flow), and their rules (.tkl-tabs,
//     .tkl-flowbar).
// The behaviour (each tab drawn from its read, the empty states, About's tiles and flow bar at 390 and 1440, signed in
// and out) is the terminal's own browser run, apps/terminal/test/token-page/run.mjs (states lower-*), and the reads and
// formats apps/terminal/test/token-lower-panel.test.ts.
// After: app
//   node scripts/live-checks/app-token-lower-panel.mjs [--url <url>] [--helper <url>] [--mint <id>] [--record <file>]
//   node scripts/live-checks/app-token-lower-panel.mjs --root <dir> [...]   the page read from a local build
//     (apps/terminal/dist, built first) on disk; the helper is still read live
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the holders answer's facts and the markers each file holds, not the files), so the
// check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-token-lower-panel";
export const APP_URL = "https://ct-app.unrealized.trade/";
export const HELPER_URL = "https://ct-api.unrealized.trade";
// each a test id or path only the panel draws (`lower-tab-trades` and `lower-panel` are not: a word's source names the
// first, and this card's key holds the second)
export const JS_MARKERS = ["lower-tabs", "lower-rows-trades", "lower-rows-holders", "holders-top", "lower-empty", "/v1/market/holders", "ticket-about", "about-windows", "about-flow"];
export const CSS_MARKERS = [".tkl-tabs", ".tkl-flowbar"];
const ROWS_MAX = 20;

/** The page's scripts and stylesheets: the `src` of each script tag and the `href` of each stylesheet link. */
export function assetsOf(html) {
  const js = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  const css = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
  return { js, css };
}

const holds = (text, markers) => markers.filter((m) => text.includes(m));
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The facts of one holders answer the verdict reads (the rows counted and checked, not kept). */
export function holdersFacts(status, body) {
  const b = isObject(body) ? body : {};
  const rows = Array.isArray(b.holders) ? b.holders : null;
  const rowOk = (r) => isObject(r) && typeof r.addr === "string" && r.addr.length > 0 && typeof r.amt === "string" && /^\d{1,40}$/.test(r.amt) && (r.bps === null || (Number.isInteger(r.bps) && r.bps >= 0 && r.bps <= 10_000));
  return { status, total: b.total ?? null, top_bps: b.top_bps ?? null, src: b.src ?? null, rows: rows === null ? null : rows.length, rowsOk: rows !== null && rows.every(rowOk) };
}

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, holders: { mint, status, total, top_bps, src, rows, rowsOk }, pageStatus, js, css }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const h = rec.holders ?? {};
  say(h.status === 200, `the helper's holders read for ${h.mint ?? "no mint"} answers ${h.status ?? "nothing"}`);
  say(Number.isSafeInteger(h.total) && h.total > 0, `the holders total for ${h.mint ?? "no mint"} is ${h.total ?? "none"}`);
  say(h.top_bps === null || (Number.isInteger(h.top_bps) && h.top_bps >= 0 && h.top_bps <= 10_000), `the top-10 share is ${h.top_bps ?? "none"} bps`);
  const rowsFit = h.src === "chain" ? h.rows > 0 && h.rows <= ROWS_MAX && h.rowsOk : h.src === "jupiter" ? h.rows === 0 : false;
  say(rowsFit, `the source is ${h.src ?? "none"} with ${h.rows ?? "no"} row(s)${h.rowsOk === false ? " not of the shape" : ""} (chain: 1 to ${ROWS_MAX} rows; jupiter: none)`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const js = rec.js ?? [];
  const css = rec.css ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  say(css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  const jsHeld = new Set(js.flatMap((f) => f.found ?? []));
  const missJs = JS_MARKERS.filter((m) => !jsHeld.has(m));
  say(missJs.length === 0, missJs.length ? `the scripts lack the lower panel: ${missJs.join(", ")}` : `the scripts hold the lower panel, its holders read and About: ${JS_MARKERS.join(", ")}`);
  const cssHeld = new Set(css.flatMap((f) => f.found ?? []));
  const missCss = CSS_MARKERS.filter((m) => !cssHeld.has(m));
  say(missCss.length === 0, missCss.length ? `the stylesheets lack the lower panel's rules: ${missCss.join(", ")}` : `the stylesheets hold the lower panel's rules: ${CSS_MARKERS.join(", ")}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  return { status: r.status, text: await r.text() };
}

/** The mint read: --mint, else the top of the helper's Solana Trending column (the token page's own / pick). */
async function topMint(helper) {
  const r = await http(`${helper}/v1/market/lists?chain=solana`);
  if (r.status !== 200) throw new Error(`the lists answered ${r.status}`);
  const t = JSON.parse(r.text)?.lists?.trending?.[0]?.token;
  if (typeof t !== "string" || t === "") throw new Error("the Trending column is empty");
  return t;
}

export async function collect({ url = APP_URL, helper = HELPER_URL, mint = null, root = null } = {}) {
  const id = mint ?? (await topMint(helper));
  const hr = await http(`${helper}/v1/market/holders?chain=solana&token=${encodeURIComponent(id)}`);
  let body = null;
  try {
    body = JSON.parse(hr.text);
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
  const rec = { source: `${root ? `a local build read from ${path.basename(root)}` : url}; ${helper}`, at: new Date().toISOString(), holders: { mint: id, ...holdersFacts(hr.status, body) }, pageStatus: page.status, js: [], css: [] };
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
    const rec = await collect({ url: opt("--url", APP_URL), helper: opt("--helper", HELPER_URL), mint: opt("--mint", null), root: opt("--root", null) ? path.resolve(opt("--root", null)) : null });
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
