#!/usr/bin/env node
// Live check of card signing-views-open-over-the-app: SIGN_HOST serves the build whose screens (sign-in, the 12 words,
// sign-out, the withdraw forms) open as one sheet over the app, not as a page of their own (packages/signpage/src/sheet.ts
// and src/shell.ts). It reads SIGN_HOST's served page and the script it names, and checks the script holds the sheet's
// markers, each a literal that survives the build's minifier:
//   - the sheet's parts: data-sheet "scrim", "box", "close", "body", a dialog with aria-modal;
//   - the close control: the app's x icon path and its accessible name "Close";
//   - the user's own Esc ("Escape");
//   - the screens the frame must not sit under, as one set ("words", "invalid-code", "withdraw", "pool-withdraw", "held",
//     "backup"): the frame leaves the document before them (src/frame-cover.ts SEALED);
// and SIGN_HOST's Permissions-Policy denies picture-in-picture and fullscreen (packages/signpage/public/_headers).
// The script's text holds what the build is; what it does is proven in browsers, not here: the frame kept in the page
// under the sheet, its messages dropped, close to the same app document, and a typed screen with the frame out, by
// packages/signpage/test/shell.test.ts and the two-host run apps/terminal/test/e2e/signing-sheet/run.mjs (both withdraw
// forms under an app that takes the focus: it reads nothing); that no key and no paste reaches an app under a typed
// screen on Chromium, Firefox and WebKit, by packages/signpage/scripts/focus-steal.e2e.mjs.
// After: sign
// Bundle: child sign --local
//   node scripts/live-checks/signing-views-open-over-the-app.mjs [--record <file>]           the deployed SIGN_HOST
//   node scripts/live-checks/signing-views-open-over-the-app.mjs --local [--record <file>]   this checkout's build
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (which markers the script holds, not the script), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

const KEY = "signing-views-open-over-the-app";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN_URL = "https://confidential.unrealized.trade/";

const Q = "[\"'`]";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lit = (s) => new RegExp(`${Q}${esc(s)}${Q}`);
export const TYPED = ["words", "invalid-code", "withdraw", "pool-withdraw", "held", "backup"];
/** Each marker by name, and its test on the script's text. */
export const MARKS = {
  "sheet scrim": (js) => /sheet=["'`]scrim["'`]/.test(js),
  "sheet box": (js) => /sheet=["'`]box["'`]/.test(js),
  "sheet close": (js) => /sheet=["'`]close["'`]/.test(js),
  "sheet body": (js) => /sheet=["'`]body["'`]/.test(js),
  "aria-modal dialog": (js) => lit("aria-modal").test(js) && lit("dialog").test(js),
  "x icon": (js) => lit("M2 2l8 8M10 2L2 10").test(js),
  "Close name": (js) => lit("Close").test(js),
  Escape: (js) => lit("Escape").test(js),
  "typed screens set": (js) => {
    for (const m of js.matchAll(/new Set\(\[([^\]]*)\]\)/g)) {
      const got = [...m[1].matchAll(/["'`]([^"'`]*)["'`]/g)].map((x) => x[1]);
      if (got.length === TYPED.length && TYPED.every((k) => got.includes(k))) return true;
    }
    return false;
  },
};
export const MARKERS = Object.keys(MARKS);
export const found = (js) => MARKERS.filter((k) => MARKS[k](js));
export const scriptsOf = (html) => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);

/** The check on one answer: { source, pageStatus, js: [{ url, status, found }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec?.pageStatus === 200, `sign: the page answers ${rec?.pageStatus ?? "nothing"} (${rec?.source ?? "no source"})`);
  const js = rec?.js ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `sign: ${js.length} script(s) named by the page, each answering 200`);
  const held = new Set(js.flatMap((f) => f.found ?? []));
  const pp = String(rec?.permissions ?? "");
  const denied = ["picture-in-picture=()", "fullscreen=()"].filter((x) => pp.split(/,\s*/).includes(x));
  say(denied.length === 2, `sign: Permissions-Policy denies picture-in-picture and fullscreen (${denied.join(", ") || "neither"})`);
  const miss = MARKERS.filter((m) => !held.has(m));
  say(miss.length === 0, miss.length ? `sign: the script lacks ${miss.length} of ${MARKERS.length}: ${miss.join(", ")}` : `sign: the script holds all ${MARKERS.length} of the sheet's markers`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

async function http(url) {
  const r = await fetch(url, { redirect: "manual" });
  return { status: r.status, permissions: r.headers.get("permissions-policy"), text: await r.text() };
}

export async function collect({ local = false } = {}) {
  const dir = local ? signBuilt() : null;
  const file = (rel) => {
    try {
      return { status: 200, text: readFileSync(path.join(dir, rel), "utf8") };
    } catch {
      return { status: 404, text: "" };
    }
  };
  const page = local ? file("index.html") : await http(SIGN_URL);
  // the policy as served: live, the response's header; local, the /* rule in the build's _headers
  const permissions = local ? (/^\/\*$[\s\S]*?^\s+Permissions-Policy:\s*(.+)$/m.exec(file(path.join("public", "_headers")).text)?.[1] ?? null) : page.permissions;
  const rec = { at: new Date().toISOString(), source: local ? `this checkout, ${path.relative(ROOT, dir)}` : SIGN_URL, pageStatus: page.status, permissions, js: [] };
  for (const ref of scriptsOf(page.text)) {
    const f = local ? file(path.join("public", new URL(ref, "http://x/").pathname)) : await http(new URL(ref, SIGN_URL).href);
    rec.js.push({ url: ref, status: f.status, found: found(f.text) });
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ local: a.includes("--local") });
    const out = opt("--record", null);
    if (out) writeFileSync(out, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
