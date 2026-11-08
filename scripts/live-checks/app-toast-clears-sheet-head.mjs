#!/usr/bin/env node
// Live check of card app-toast-clears-sheet-head: on the phone, with the trade sheet open, the fill toast sits at the
// window's top, clear of the sheet's head row (the token's symbol and price), instead of 68 px down over it. It reads what
// APP_HOST serves: the page, then every stylesheet the page names, and finds the rule that moves the toast while the
// sheet is open: one rule whose selectors are both the box's own toast in the open sheet (.tsh[data-open=true] .rs-toast)
// and the page's toast beside it (.tsh[data-open=true]~.rs-toast), whose `top` is at most 8 px, above the sheet's top at
// its tallest (8% of the window) and its 44 px grab handle.
// The geometry itself (the toast's box does not meet the head row's at 360, 390 and 430) is the terminal's own browser
// run: apps/terminal/test/trade-sheet/run.mjs.
//   node scripts/live-checks/app-toast-clears-sheet-head.mjs [--url <url>] [--record <file>]
//   node scripts/live-checks/app-toast-clears-sheet-head.mjs --root <dir> [--record <file>]   the same read on a local
//     build (apps/terminal/dist, built first) read from disk
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the rule each stylesheet holds, not the files), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-toast-clears-sheet-head";
export const APP_URL = "https://ct-app.unrealized.trade/";
/** The highest `top` the open sheet's toast may have, in px. */
export const MAX_TOP = 8;
const IN_SHEET = ".tsh[data-open=true] .rs-toast";
const BESIDE = ".tsh[data-open=true]~.rs-toast";

/** The page's stylesheets: the `href` of each stylesheet link. */
export function stylesOf(html) {
  return [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
}

/** A selector as compared: no quotes around attribute values, no spaces around `~` and `>`, one space elsewhere. */
const norm = (sel) => sel.replace(/["']/g, "").replace(/\s*([~>+])\s*/g, "$1").replace(/\s+/g, " ").trim();

/** The rule in a stylesheet that names both selectors, as { selectors, top } (top in px, null when none); null if none. */
export function ruleOf(css) {
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map(norm);
    if (!selectors.includes(IN_SHEET) || !selectors.includes(BESIDE)) continue;
    const top = /(?:^|;)\s*top\s*:\s*(-?\d+(?:\.\d+)?)px/.exec(m[2]);
    return { selectors, top: top ? Number(top[1]) : null };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, pageStatus, css: [{ url, status, rule }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const css = rec.css ?? [];
  say(css.length > 0 && css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  const rule = css.map((f) => f.rule).find((r) => r) ?? null;
  say(rule !== null, rule ? `a stylesheet moves the toast while the sheet is open: ${IN_SHEET}, ${BESIDE}` : `no stylesheet moves the toast while the sheet is open (${IN_SHEET}, ${BESIDE})`);
  if (rule) say(rule.top !== null && rule.top <= MAX_TOP, `the open sheet's toast is at top ${rule.top ?? "unset"} px, at most ${MAX_TOP}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await fetch(url, { redirect: "manual" });
  return { status: r.status, text: await r.text() };
}

export async function collect({ url = APP_URL, root = null } = {}) {
  const read = async (ref) => {
    if (root) {
      try {
        return { status: 200, text: readFileSync(path.join(root, new URL(ref, "http://x/").pathname), "utf8") };
      } catch {
        return { status: 404, text: "" };
      }
    }
    return http(new URL(ref, url).href);
  };
  const page = root ? { status: 200, text: readFileSync(path.join(root, "index.html"), "utf8") } : await http(url);
  const rec = { source: root ? `a local build read from ${path.basename(root)}` : url, at: new Date().toISOString(), pageStatus: page.status, css: [] };
  for (const ref of stylesOf(page.text)) {
    const f = await read(ref);
    rec.css.push({ url: ref, status: f.status, rule: ruleOf(f.text) });
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
