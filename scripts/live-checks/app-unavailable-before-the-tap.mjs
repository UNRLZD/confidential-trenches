#!/usr/bin/env node
// Live check of card app-unavailable-before-the-tap: on a coin the pool cannot buy yet, the deployed trade box shows
// Unavailable with Buy off as the page opens, from the pool.buy.dry it already asks at mount, never only after a tap.
// It reads what APP_HOST serves: the page, then every script the page names, and checks the bundle holds:
//   - the dry's rule: a pool.buy.dry refused with a code whose reason is Unavailable is Unavailable before any tap
//     (apps/terminal/src/screens/trade/model.ts dryUnavailable);
//   - each of the four codes mapped to Unavailable: venue_not_pinned, no_table_fits, venue_not_built and
//     below_reference (the below-market code card sol-buy-takes-the-best-venue-it-can-trade named, 19 Nov 14:43Z).
// The behaviour itself (Unavailable and Buy and the presets off at mount, a coin it can buy ready, at 390 and 1440) is the
// terminal's own tests: apps/terminal/test/unavailable-before-the-tap.test.ts and test/trade-unavailable/run.mjs.
// The signing page answers these codes from pool.buy.dry only once card sol-buy-takes-the-best-venue-it-can-trade is
// deployed: run this after both cards are deployed (the app and the sign release); before it, the app holds the rule and
// the page never answers it, so a buy is still refused only at the tap.
// After: app
// Bundle: child app --root apps/terminal/dist
//   node scripts/live-checks/app-unavailable-before-the-tap.mjs [--url <url>] [--record <file>]
//   node scripts/live-checks/app-unavailable-before-the-tap.mjs --root <dir> [--record <file>]   the same read on a
//     local build (apps/terminal/dist, built first) read from disk
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the marks each file holds, not the files), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-unavailable-before-the-tap";
export const APP_URL = "https://ct-app.unrealized.trade/";
// a minifier may quote a string with any of the three quotes and rename any identifier
const Q = "[`\"']";
const ID = "[\\w$]+";
/** Each mark: its name, and what the bundle holds when it is in its place. */
export const MARKS = [
  ["the dry's Unavailable before the tap", new RegExp(`!${ID}\\.ok&&${ID}\\(${ID}\\.error\\.code\\)===${Q}unavailable${Q}`)],
  ["venue_not_pinned is Unavailable", new RegExp(`venue_not_pinned:${Q}unavailable${Q}`)],
  ["no_table_fits is Unavailable", new RegExp(`no_table_fits:${Q}unavailable${Q}`)],
  ["venue_not_built is Unavailable", new RegExp(`venue_not_built:${Q}unavailable${Q}`)],
  ["below_reference is Unavailable", new RegExp(`below_reference:${Q}unavailable${Q}`)],
];
export const NAMES = MARKS.map(([n]) => n);

/** The page's scripts: the `src` of each script tag. */
export function scriptsOf(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
}

/** The names of the marks a script holds. */
export const marksIn = (text) => MARKS.filter(([, re]) => re.test(text)).map(([n]) => n);

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, pageStatus, js: [{ url, status, found }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const js = rec.js ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  const held = new Set(js.flatMap((f) => f.found ?? []));
  const miss = NAMES.filter((n) => !held.has(n));
  say(miss.length === 0, miss.length ? `the scripts lack: ${miss.join("; ")}` : `the scripts hold the rule and its four codes: ${NAMES.join("; ")}`);
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
  const rec = { source: root ? `a local build read from ${path.basename(root)}` : url, at: new Date().toISOString(), pageStatus: page.status, js: [] };
  for (const ref of scriptsOf(page.text)) {
    const f = await read(ref);
    rec.js.push({ url: ref, status: f.status, found: marksIn(f.text) });
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
