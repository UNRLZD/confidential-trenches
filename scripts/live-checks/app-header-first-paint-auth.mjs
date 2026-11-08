#!/usr/bin/env node
// Live check of card app-header-first-paint-auth: the header draws its account side at the shape it will land in, from
// a sign-in hint on APP_HOST (apps/terminal/src/screens/signin/hint.ts) read before the first paint, and reserves the
// account box (264 px desktop, 148 px phone) only for the signed-in shape, so signed out keeps R5's room before Sign in.
// It reads what APP_HOST serves: the page, then every script and stylesheet it names. The scripts must hold the hint's
// key (ct-signin-hint), the signed-out skeleton (loading-out) and the box's shape attribute (data-shape); the
// stylesheets the box's two reserved widths, each only under data-shape=in, and no rule that reserves a width on the box
// whatever its shape (the 51688cd9 rule, which left a 192.5 layout px gap before Sign in).
// The behaviour (each width signed in and out with its stored hint, R5's room before Sign in, CLS 0, two wrong hints
// landing right with the hint corrected and their next load at CLS 0) is the terminal's own browser run,
// apps/terminal/test/header-search/run.mjs, and the hint's rules apps/terminal/test/signin-hint.test.ts.
// After: app
//   node scripts/live-checks/app-header-first-paint-auth.mjs [--url <url>] [--record <file>]
//   node scripts/live-checks/app-header-first-paint-auth.mjs --root <dir> [...]   the page read from a local build
//     (apps/terminal/dist, built first) on disk; nothing is read over the network
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the markers each file holds and the box rules found, not the files), so the
// check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-header-first-paint-auth";
export const APP_URL = "https://ct-app.unrealized.trade/";
export const JS_MARKERS = ["ct-signin-hint", "loading-out", "data-shape"];
export const CSS_MARKERS = [".tb-acct[data-shape=in]{min-width:264px}", ".phh-acct[data-shape=in]{min-width:148px}"];

/** The page's scripts and stylesheets: the `src` of each script tag and the `href` of each stylesheet link. */
export function assetsOf(html) {
  const js = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  const css = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
  return { js, css };
}

const holds = (text, markers) => markers.filter((m) => text.includes(m));

/** The rules that reserve a width on the account box whatever its shape: a rule whose selector list names .tb-acct or
 *  .phh-acct bare (no attribute after it) and whose body sets a min-width. */
export function alwaysReserved(css) {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(",").map((s) => s.trim());
    if (/(^|;)\s*min-width\s*:/.test(m[2]) && sels.some((s) => /(^|\s|>)\.(tb-acct|phh-acct)$/.test(s))) out.push(`${m[1].trim()}{${m[2].trim()}}`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, pageStatus, js: [{ url, status, found }], css: [{ url, status, found, always }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const js = rec.js ?? [];
  const css = rec.css ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  say(css.length > 0 && css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  const jsHeld = new Set(js.flatMap((f) => f.found ?? []));
  const missJs = JS_MARKERS.filter((m) => !jsHeld.has(m));
  say(missJs.length === 0, missJs.length ? `the scripts lack the sign-in hint: ${missJs.join(", ")}` : `the scripts hold the sign-in hint: ${JS_MARKERS.join(", ")}`);
  const cssHeld = new Set(css.flatMap((f) => f.found ?? []));
  const missCss = CSS_MARKERS.filter((m) => !cssHeld.has(m));
  say(missCss.length === 0, missCss.length ? `the stylesheets lack the box reserved only for in: ${missCss.join(", ")}` : `the stylesheets reserve the box only for in: ${CSS_MARKERS.join(", ")}`);
  const always = css.flatMap((f) => f.always ?? []);
  say(always.length === 0, always.length ? `the stylesheets reserve the box whatever the shape: ${always.join(" ")}` : "no rule reserves the box whatever the shape");
  return { ok: lines.every((x) => x.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
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
  const { js, css } = assetsOf(page.text);
  const rec = { source: root ? `a local build read from ${path.basename(root)}` : url, at: new Date().toISOString(), pageStatus: page.status, js: [], css: [] };
  for (const ref of js) {
    const f = await read(ref);
    rec.js.push({ url: ref, status: f.status, found: holds(f.text, JS_MARKERS) });
  }
  for (const ref of css) {
    const f = await read(ref);
    rec.css.push({ url: ref, status: f.status, found: holds(f.text, CSS_MARKERS), always: alwaysReserved(f.text) });
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
