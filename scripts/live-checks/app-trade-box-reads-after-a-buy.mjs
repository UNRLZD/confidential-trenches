#!/usr/bin/env node
// Live check of card app-trade-box-reads-after-a-buy: the fill toast on the token page covers none of the header's
// Price, 24h change and Tax. It reads what APP_HOST serves: the page, then every stylesheet the page names, and checks
// the deployed stylesheets hold the token page's two toast places (apps/terminal/src/screens/token/token.css):
//   - desktop: `.tkp-desk .rs-toast{top:196px}`, top centre under the token's header and the chart's control row;
//   - phone: `.tkp-phone .rs-toast{top:8px}`, the window's top over the shell's bar, the price row under it in view.
// The behaviour itself (each toast measured against the header's tiles and the chart's controls at 1440 and 390) is the
// terminal's own browser run, apps/terminal/test/trade-reads-after-buy/run.mjs.
// After: app
// Bundle: child app --root apps/terminal/dist
//   node scripts/live-checks/app-trade-box-reads-after-a-buy.mjs [--url <url>] [--record <file>]
//   node scripts/live-checks/app-trade-box-reads-after-a-buy.mjs --root <dir> [--record <file>]   the same read on a
//     local build (apps/terminal/dist, built first) read from disk
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the rules each stylesheet holds, not the files), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-trade-box-reads-after-a-buy";
export const APP_URL = "https://ct-app.unrealized.trade/";
export const RULES = [".tkp-desk .rs-toast{top:196px}", ".tkp-phone .rs-toast{top:8px}"];

/** The page's stylesheets: the `href` of each stylesheet link. */
export const stylesOf = (html) => [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);

/** The check on one answer: { source, pageStatus, css: [{ url, status, found }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const css = rec.css ?? [];
  say(css.length > 0 && css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  const held = new Set(css.flatMap((f) => f.found ?? []));
  const miss = RULES.filter((r) => !held.has(r));
  say(miss.length === 0, miss.length ? `the stylesheets lack the token page's toast places: ${miss.join(" ")}` : `the stylesheets hold the token page's toast places: ${RULES.join(" ")}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

async function http(url) {
  const r = await fetch(url, { redirect: "manual" });
  return { status: r.status, text: await r.text() };
}

export async function collect({ url = APP_URL, root = null } = {}) {
  const read = async (ref) => {
    if (!root) return http(new URL(ref, url).href);
    try {
      return { status: 200, text: readFileSync(path.join(root, new URL(ref, "http://x/").pathname), "utf8") };
    } catch {
      return { status: 404, text: "" };
    }
  };
  const page = root ? { status: 200, text: readFileSync(path.join(root, "index.html"), "utf8") } : await http(url);
  const rec = { source: root ? `a local build read from ${path.basename(root)}` : url, at: new Date().toISOString(), pageStatus: page.status, css: [] };
  for (const ref of stylesOf(page.text)) {
    const f = await read(ref);
    rec.css.push({ url: ref, status: f.status, found: RULES.filter((r) => f.text.includes(r)) });
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
