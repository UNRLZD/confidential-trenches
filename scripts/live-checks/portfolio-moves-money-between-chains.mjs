#!/usr/bin/env node
// Live check of card portfolio-moves-money-between-chains: on APP_HOST, Portfolio's Private balance carries its total in
// dollars, each row's dollars, Move and Withdraw on every row, and the move sheet that asks the signing page's
// pool.move.dry and pool.move (kit 1.15) and draws the route's flow. It reads what APP_HOST serves: the page, then every
// script the page names, and checks the deployed bundle holds them:
//   - the block's total (data-pools-total) and a row's Move control (pool-move-);
//   - the sheet's flow (move-flow) and its one Move (move-go);
//   - the signing page's kind it asks (pool.move.dry), which is also the gate: no Move is drawn until the kit names it;
//   - every stylesheet the page names answers 200.
// The behaviour itself (the route per pair, the steps from the op's stage, Max, the one ask, a zero row's Move off) is
// the terminal's own tests: apps/terminal/test/portfolio-move.test.ts and test/portfolio/run.mjs.
// After: app
// Bundle: child app --root apps/terminal/dist
//   node scripts/live-checks/portfolio-moves-money-between-chains.mjs [--url <url>] [--record <file>]
//   node scripts/live-checks/portfolio-moves-money-between-chains.mjs --root <dir> [--record <file>]   the same read on a
//     local build (apps/terminal/dist, built first) read from disk
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the markers each file holds, not the files), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "portfolio-moves-money-between-chains";
export const APP_URL = "https://ct-app.unrealized.trade/";
/** Private balance's total and Move, the move sheet's flow and button, and the signing page's kind it asks. */
export const JS_MARKERS = ["data-pools-total", "pool-move-", "move-flow", "move-go", "pool.move.dry"];

/** The page's scripts and stylesheets: the `src` of each script tag and the `href` of each stylesheet link. */
export function assetsOf(html) {
  const js = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  const css = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
  return { js, css };
}

const holds = (text, markers) => markers.filter((m) => text.includes(m));

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, pageStatus, js: [{ url, status, found }], css: [{ url, status }] }. */
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
  say(missJs.length === 0, missJs.length ? `the scripts lack Private balance's move: ${missJs.join(", ")}` : `the scripts hold Private balance's move: ${JS_MARKERS.join(", ")}`);
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
    rec.css.push({ url: ref, status: f.status });
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
