#!/usr/bin/env node
// Live check of card restore-notice-redraw: the restore notice APP_HOST serves is direction A (owner pick 12 Nov
// 18:55Z): the amount under a disc of dots, the tick drawn in green dots when the restore ends, the disc amber when it
// stalls, no sliding bar. It reads what APP_HOST serves: the page, then every script and stylesheet the page names, and
// finds
//   - in a script: the mark's element (`rn-mark`), its sweep (`rn-arc`) and its tick (`rn-tick`),
//     and no old bar (`rbar`);
//   - in a stylesheet: the tick's dots in --acc, the stalled disc in --warn, the sweep's keyframes (`rn-comet`), the
//     sweep at rest under reduced motion, Retry drawn off while money is off (`.rline .retry:disabled`), and no `.rbar`.
// The behaviour (each state's mark, amount and word at 390 and 1440, done with no word, the tick in the frame the end
// arrives, Retry off with money off) is the terminal's own browser run: apps/terminal/test/signin-screens/run.mjs.
// After: app
//   node scripts/live-checks/restore-notice-redraw.mjs [--url <url>] [--record <file>]
//   node scripts/live-checks/restore-notice-redraw.mjs --root <dir> [--record <file>]   the same read on a local build
//     (apps/terminal/dist, built first) read from disk
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (each mark's count and each rule found, not the files), so the check's test can
// replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "restore-notice-redraw";
export const APP_URL = "https://ct-app.unrealized.trade/";
const Q = "[`\"']";

/** What a script must hold (minified or source form). */
export const MUST = {
  mark: new RegExp(`${Q}rn-mark[ $\`"']`, "g"),
  arc: new RegExp(`${Q}rn-arc${Q}`, "g"),
  tick: new RegExp(`${Q}rn-tick${Q}`, "g"),
};
/** What a script must not hold: the sliding bar the notice drew before this card. */
export const MUST_NOT = { bar: new RegExp(`${Q}rbar${Q}`, "g") };
const count = (re, text) => (text.match(re) ?? []).length;
export const marksOf = (js) => Object.fromEntries([...Object.entries(MUST), ...Object.entries(MUST_NOT)].map(([k, re]) => [k, count(re, js)]));

/** The stylesheet rules, each read with comments removed and whitespace optional. */
export const RULES = {
  tickGreen: /\.rn-tick\s+circle\s*\{[^}]*fill:\s*var\(--acc\)/,
  offAmber: /\.rn-mark\.off\s+\.rn-base\s+circle\s*\{[^}]*fill:\s*var\(--warn\)/,
  sweep: /@keyframes\s+rn-comet\s*\{/,
  restsReduced: /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[^{}]*\.rn-arc\s+circle[^{}]*\{[^}]*animation:\s*none/,
  retryOff: /\.rline\s+\.retry:disabled\s*\{[^}]*color:\s*var\(--text-3\)/,
};
export const RULES_NOT = { barRule: /\.rbar[\s{.,:]/ };
export function rulesOf(css) {
  const c = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return Object.fromEntries([...Object.entries(RULES), ...Object.entries(RULES_NOT)].map(([k, re]) => [k, re.test(c)]));
}

/** The page's scripts and stylesheets: the `src` of each script, the `href` of each stylesheet link. */
export function refsOf(html) {
  return {
    js: [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]),
    css: [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]),
  };
}

const NAME = {
  mark: "the dot mark's element (rn-mark)",
  arc: "the sweep (rn-arc)",
  tick: "the dotted tick (rn-tick)",
  tickGreen: "the tick's dots in --acc",
  offAmber: "the stalled disc in --warn",
  sweep: "the sweep's keyframes (rn-comet)",
  restsReduced: "the sweep at rest under reduced motion",
  retryOff: "Retry drawn off while money is off (.rline .retry:disabled, --text-3)",
};

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, pageStatus, js: [{ url, status, marks }], css: [{ url, status, rules }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const js = rec.js ?? [];
  const css = rec.css ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  say(css.length > 0 && css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  const sum = (k) => js.reduce((n, f) => n + (f.marks?.[k] ?? 0), 0);
  const missing = Object.keys(MUST).filter((k) => sum(k) === 0);
  say(missing.length === 0, missing.length ? `the scripts lack ${missing.map((k) => NAME[k]).join(", ")}` : "the scripts draw the dot mark, its sweep and its dotted tick");
  say(sum("bar") === 0, sum("bar") ? `the scripts still draw the sliding bar (rbar, ${sum("bar")})` : "no sliding bar in the scripts");
  const has = (k) => css.some((f) => f.rules?.[k]);
  const lack = Object.keys(RULES).filter((k) => !has(k));
  say(lack.length === 0, lack.length ? `no stylesheet holds ${lack.map((k) => NAME[k]).join(", ")}` : "the stylesheet holds the green tick, the amber stall, the sweep, its rest under reduced motion and Retry drawn off");
  say(!has("barRule"), has("barRule") ? "a stylesheet still styles the sliding bar (.rbar)" : "no stylesheet styles the sliding bar");
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
  const rec = { source: root ? `a local build read from ${path.basename(root)}` : url, at: new Date().toISOString(), pageStatus: page.status, js: [], css: [] };
  const refs = refsOf(page.text);
  for (const ref of refs.js) {
    const f = await read(ref);
    rec.js.push({ url: ref, status: f.status, marks: marksOf(f.text) });
  }
  for (const ref of refs.css) {
    const f = await read(ref);
    rec.css.push({ url: ref, status: f.status, rules: rulesOf(f.text) });
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
