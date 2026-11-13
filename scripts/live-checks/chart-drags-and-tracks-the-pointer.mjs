#!/usr/bin/env node
// Live check of card chart-drags-and-tracks-the-pointer: the token chart drags, zooms and tracks the pointer inside the
// framed app under the shell's design-fit zoom. It reads what APP_HOST serves: the page, then every script and
// stylesheet the page names, and checks the deployed bundle holds the fix:
//   - a script holds the chart's event rescale under the zoom (apps/terminal/src/screens/token/zoomEvents.ts): the list
//     of the mouse, wheel and touch events it maps, in its order, in any quote the minifier writes;
//   - a script holds the chart's view readout (chart.ts: the host's data-view, which the browser run reads);
//   - the stylesheet's trade mark rule (.tm) takes no pointer (pointer-events:none), so a drag, a wheel or the
//     crosshair begun on a mark reaches the chart (marks.css), and no .tm rule gives it one back.
// The behaviour itself (the crosshair and its labels under the pointer at three points, a drag's distance, a wheel's and
// a pinch's anchor, a late trade, at 1440 with DPR 1 and 2 and at 390) is the terminal's browser run,
// apps/terminal/test/chart-pointer/run.mjs.
// After: app
// Bundle: child app --root apps/terminal/dist
//   node scripts/live-checks/chart-drags-and-tracks-the-pointer.mjs [--url <url>] [--record <file>]
//   node scripts/live-checks/chart-drags-and-tracks-the-pointer.mjs --root <dir> [--record <file>]   a local build
//     (apps/terminal/dist, built first) read from disk
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the facts each file holds, not the files), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "chart-drags-and-tracks-the-pointer";
export const APP_URL = "https://ct-app.unrealized.trade/";
const EVENTS = ["mousedown", "mousemove", "mouseup", "mouseenter", "mouseleave", "click", "dblclick", "contextmenu", "wheel", "touchstart", "touchmove", "touchend", "touchcancel"];
const EVENT_LIST = new RegExp(EVENTS.map((e) => `[\`'"]${e}[\`'"]`).join(",\\s*"));

/** The page's scripts and stylesheets: the `src` of each script tag and the `href` of each stylesheet link. */
export function assetsOf(html) {
  const js = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  const css = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
  return { js, css };
}

/** The facts one script holds. */
export const jsFacts = (text) => ({ rescale: EVENT_LIST.test(text), view: /\.dataset\.view\s*=/.test(text) });
/** The facts one stylesheet holds: the pointer-events of each rule whose selector is the bare .tm. */
export function cssFacts(text) {
  const tm = [...text.matchAll(/(?:^|[}\s,])\.tm\s*\{([^}]*)\}/g)].map((m) => /pointer-events\s*:\s*([a-z-]+)/.exec(m[1])?.[1] ?? null);
  return { tm };
}

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, pageStatus, js: [{ url, status, rescale, view }], css: [{ url, status, tm }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const js = rec.js ?? [];
  const css = rec.css ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  say(css.length > 0 && css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  say(js.some((f) => f.rescale), js.some((f) => f.rescale) ? "a script rescales the chart's mouse, wheel and touch events under the zoom" : "no script rescales the chart's events under the zoom: the crosshair and a drag fall short of the pointer at 1440");
  say(js.some((f) => f.view), js.some((f) => f.view) ? "a script publishes the chart's view (data-view)" : "no script publishes the chart's view (data-view)");
  const tm = css.flatMap((f) => f.tm ?? []);
  const set = tm.filter((v) => v !== null);
  say(set.length > 0 && set.every((v) => v === "none"), set.length === 0 ? "no .tm rule sets the marks' pointer-events" : `the .tm rules set pointer-events ${set.join(", ")}${set.every((v) => v === "none") ? ": the marks take no pointer" : ": a mark takes the pointer from the chart"}`);
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
    rec.js.push({ url: ref, status: f.status, ...jsFacts(f.text) });
  }
  for (const ref of css) {
    const f = await read(ref, url);
    rec.css.push({ url: ref, status: f.status, ...cssFacts(f.text) });
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
