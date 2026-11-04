#!/usr/bin/env node
// Live check of card app-buy-route-strip: after a tap on Buy, APP_HOST's trade box shows the trade moving step by step
// (Private balance, the buy's one-time wallet, the pool, the token). It reads what APP_HOST serves: the page, then every
// script and stylesheet the page names, and checks the deployed bundle holds the strip:
//   - the scripts hold the strip's four steps (data-testid route-balance, route-wallet, route-pool, route-token), the
//     strip itself (route-strip) with the steps' states it draws (data-steps), the fill toast (fill-toast) and the spec's
//     words ("New one-time wallet");
//   - the stylesheets hold the strip's own rules: the wallet step that grows in (.rs-grp), the filling links (.rs-ld),
//     the active step's glow (rs-glow) and the check's pop (rs-pop).
// The behaviour itself (each step checks only on its own event, a failed step shows the error, nothing after it checks) is
// the terminal's own tests: apps/terminal/test/buy-route.test.ts and test/buy-route/run.mjs.
//   node scripts/live-checks/app-buy-route-strip.mjs [--url <url>] [--record <file>]
//   node scripts/live-checks/app-buy-route-strip.mjs --root <dir> [--record <file>]   the same read on a local build
//     (apps/terminal/dist, built first) read from disk
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the markers each file holds, not the files), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-buy-route-strip";
export const APP_URL = "https://confidential.unrealized.trade/";
export const JS_MARKERS = ["route-strip", "route-balance", "route-wallet", "route-pool", "route-token", "data-steps", "fill-toast", "New one-time wallet"];
export const CSS_MARKERS = [".rs-grp", ".rs-ld", "rs-glow", "rs-pop"];

/** The page's scripts and stylesheets: the `src` of each script tag and the `href` of each stylesheet link. */
export function assetsOf(html) {
  const js = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  const css = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
  return { js, css };
}

const holds = (text, markers) => markers.filter((m) => text.includes(m));

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, pageStatus, js: [{ url, status, found }], css: [{ url, status, found }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const js = rec.js ?? [];
  const css = rec.css ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  say(css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  const jsHeld = new Set(js.flatMap((f) => f.found ?? []));
  const missJs = JS_MARKERS.filter((m) => !jsHeld.has(m));
  say(missJs.length === 0, missJs.length ? `the scripts lack the strip: ${missJs.join(", ")}` : `the scripts hold the strip: ${JS_MARKERS.join(", ")}`);
  const cssHeld = new Set(css.flatMap((f) => f.found ?? []));
  const missCss = CSS_MARKERS.filter((m) => !cssHeld.has(m));
  say(missCss.length === 0, missCss.length ? `the stylesheets lack the strip's rules: ${missCss.join(", ")}` : `the stylesheets hold the strip's rules: ${CSS_MARKERS.join(", ")}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await fetch(url, { redirect: "manual" });
  return { status: r.status, text: await r.text() };
}

export async function collect({ url = APP_URL, root = null } = {}) {
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
  const rec = { source: root ? `a local build read from ${path.basename(root)}` : url, at: new Date().toISOString(), pageStatus: page.status, js: [], css: [] };
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
    const rec = await collect({ url: opt("--url", APP_URL), root: opt("--root", null) ? path.resolve(opt("--root", null)) : null });
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
