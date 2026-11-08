#!/usr/bin/env node
// Live check of card app-harness-signin-e2e: no blank frame across the hop back from a sign-in page (app.md BAR-03).
// When SIGN_HOST's shell closes its layer it makes a new APP_HOST frame, transparent until its document paints; the card
// fills that moment from both sides, and the check reads each host as a browser does:
//   - APP_HOST's / holds the boot frame (apps/terminal/index.html #boot, hidden until its stylesheet applies), and the one
//     stylesheet it names, whose sha384 is its integrity, holds the rules that draw it and hide it once the app draws
//     into #root (apps/terminal/src/shell/shell.css);
//   - SIGN_HOST's / names one module script, /app.js, whose sha384 is its integrity, and /app.js holds the backdrop the
//     shell draws under the frame (packages/signpage/src/backdrop.ts): its id and the tab bar's ink, string literals
//     the minifier keeps.
// The hop itself is judged in a browser by apps/terminal/test/e2e/signin/run.mjs (BAR-03 at both widths).
// After: app --host app
// After: sign --host sign
//   node scripts/live-checks/app-harness-signin-e2e.mjs [--host app|sign] [--sign <origin>] [--app <origin>] [--record <file>]
//   --host reads that host alone: each host's deploy runs the check on its own host (apps/terminal/scripts/deploy.mjs,
//   packages/signpage/scripts/deploy.mjs), so a host that lags does not fail the other's deploy; with no --host, both.
//   PASS exit 0, FAIL exit 1, error exit 2. The record holds paths, integrities, sizes, sha384s and marker counts,
//   never the bytes.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-harness-signin-e2e";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
export const APP_ORIGIN = "https://ct-app.unrealized.trade";
/** The boot frame in APP_HOST's page and its rules in the page's stylesheet, as the build writes them. */
export const APP_MARKERS = { page: ['<div id="boot" aria-hidden="true" hidden>', 'class="boot-panel"'], css: ["#root:not(:empty)~#boot{display:none}", ".boot-panel{"] };
/** The backdrop in SIGN_HOST's script, as the minifier writes it. */
export const SIGN_MARKERS = ["`backdrop`", "`rgb(9,9,9)`"];

const SRI = /^sha384-[A-Za-z0-9+/]{64}$/;
const found = (counts, keys) => keys.filter((k) => !(Number.isSafeInteger(counts?.[k]) && counts[k] >= 1));

export const HOST_KEYS = Object.freeze(["app", "sign"]);

/** The verdict on a record, for the hosts it read (both when it names none): { pass, lines }. */
export function judge(rec, hosts = rec?.hosts ?? HOST_KEYS) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  if (hosts.length === 0 || hosts.some((h) => !HOST_KEYS.includes(h))) say(false, `the hosts read are app, sign or both (${hosts.join(", ") || "none"})`);
  if (hosts.includes("app")) judgeApp(rec, say);
  if (hosts.includes("sign")) judgeSign(rec, say);
  return { pass: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

function judgeApp(rec, say) {
  const ap = rec?.app?.page ?? {};
  const ac = rec?.app?.css ?? {};
  const missPage = found(ap.markers, APP_MARKERS.page);
  say(ap.status === 200 && missPage.length === 0, `APP_HOST / holds the boot frame (HTTP ${ap.status ?? "?"}${missPage.length ? `, missing ${missPage.join(", ")}` : ""})`);
  say(ap.stylesheets === 1 && SRI.test(ap.integrity ?? "") && ac.status === 200 && ac.sha384 === ap.integrity,
    `APP_HOST / names one stylesheet, its sha384 the integrity (${ap.stylesheets ?? "?"} stylesheet(s), HTTP ${ac.status ?? "?"})`);
  const missCss = found(ac.markers, APP_MARKERS.css);
  say(missCss.length === 0, `APP_HOST's stylesheet draws and hides the boot frame (${missCss.length ? `missing ${missCss.join(", ")}` : `${APP_MARKERS.css.length} rules found`})`);
}

function judgeSign(rec, say) {
  const s = rec?.sign?.index ?? {};
  const a = rec?.sign?.app ?? {};
  say(s.scripts === 1 && s.src === "/app.js" && SRI.test(s.integrity ?? "") && a.status === 200 && a.sha384 === s.integrity,
    `SIGN_HOST / names one module script, /app.js, its sha384 the integrity (${s.scripts ?? "?"} script(s), HTTP ${a.status ?? "?"})`);
  const missSign = found(a.markers, SIGN_MARKERS);
  say(missSign.length === 0, `SIGN_HOST's /app.js draws the backdrop (${missSign.length ? `missing ${missSign.join(", ")}` : `${SIGN_MARKERS.length} marks found`})`);
}

const count = (text, keys) => Object.fromEntries(keys.map((k) => [k, text.split(k).length - 1]));
const sha384 = (buf) => `sha384-${createHash("sha384").update(buf).digest("base64")}`;
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** Reads the hosts named as a browser does and returns the record. */
export async function probe(sign, app, hosts = HOST_KEYS, fetchFn = fetch) {
  const get = (origin, p) => fetchFn(new URL(p, origin), { redirect: "error", headers: { accept: "*/*" }, signal: AbortSignal.timeout(20_000) });
  const rec = { key: KEY, at: new Date().toISOString(), hosts: [...hosts] };
  if (hosts.includes("app")) rec.app = await probeApp(app, get);
  if (hosts.includes("sign")) rec.sign = await probeSign(sign, get);
  return rec;
}

async function probeApp(app, get) {
  const rec = { app: { url: app, page: {}, css: {} } };
  const page = await get(app, "/");
  const html = await page.text();
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map((t) => t[0]).filter((t) => attr(t, "rel") === "stylesheet");
  rec.app.page = { status: page.status, stylesheets: links.length, href: attr(links[0] ?? "", "href"), integrity: attr(links[0] ?? "", "integrity"), markers: count(html, APP_MARKERS.page) };
  if (rec.app.page.href) {
    const res = await get(app, rec.app.page.href);
    const body = Buffer.from(await res.arrayBuffer());
    rec.app.css = { status: res.status, bytes: body.length, sha384: sha384(body), markers: count(body.toString("utf8"), APP_MARKERS.css) };
  }
  return rec.app;
}

async function probeSign(sign, get) {
  const rec = { sign: { url: sign, index: {}, app: {} } };
  const index = await get(sign, "/");
  const shtml = await index.text();
  const tags = [...shtml.matchAll(/<script\b[^>]*>/g)].map((t) => t[0]);
  rec.sign.index = { status: index.status, scripts: tags.length, src: attr(tags[0] ?? "", "src"), integrity: attr(tags[0] ?? "", "integrity") };
  if (rec.sign.index.src === "/app.js") {
    const res = await get(sign, "/app.js");
    const body = Buffer.from(await res.arrayBuffer());
    rec.sign.app = { status: res.status, bytes: body.length, sha384: sha384(body), markers: count(body.toString("utf8"), SIGN_MARKERS) };
  }
  return rec.sign;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const host = opt("--host");
    if (host !== undefined && !HOST_KEYS.includes(host)) throw new Error(`--host is app or sign, not ${host}`);
    const rec = await probe(opt("--sign") ?? SIGN_ORIGIN, opt("--app") ?? APP_ORIGIN, host ? [host] : HOST_KEYS);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.pass ? "PASS" : "FAIL"} (${[rec.app?.url, rec.sign?.url].filter(Boolean).join(", ")})`);
    process.exit(r.pass ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
