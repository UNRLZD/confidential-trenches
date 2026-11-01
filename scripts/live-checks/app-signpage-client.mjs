#!/usr/bin/env node
// Live check of card app-signpage-client: the terminal at APP_HOST talks to SIGN_HOST through one hidden iframe with a
// checked handshake (app.md §2.1 items 2-4; A1.2, app.md:1435). Headless Chromium loads APP_HOST at 390 x 844 (phone)
// and 1440 x 900 (desktop), twice each:
//   - served: SIGN_HOST as it is served. There is exactly one iframe, of SIGN_HOST's release URL with no query, with
//     the attributes of AX-06 (app.md:1386): sandbox "allow-scripts allow-same-origin", an empty allow,
//     referrerpolicy no-referrer, aria-hidden, zero size; the page reaches READY (<html data-signpage="ready">) within
//     5,000 ms of the load (BAR-09, app.md:1107); no CSP violation, no console error, layout shift at most 0.1;
//   - blocked: every request to SIGN_HOST refused (connection refused). Within 5,000 ms of the load plus 1,500 ms of
//     slack the down state shows (data-signpage="down" and the down toast on screen); then SIGN_HOST is let through
//     and the page reaches READY again with no reload (AE-08, app.md:1352), no later than the client's 10 s retry and
//     its 5 s handshake.
// A screenshot of each run is kept.
//   node scripts/live-checks/app-signpage-client.mjs [--url <origin>] [--shots <dir>] [--record <file>]
//   node scripts/live-checks/app-signpage-client.mjs --harness [--silent] ...   the same probe on the app's browser
//     harness (apps/terminal/test/harness) with the real names mapped to it: APP_HOST serves the terminal's build
//     (apps/terminal/dist, build it first) and SIGN_HOST a test frame that speaks the frozen ready and state shapes
//     under SIGN_HOST's own _headers; --silent serves SIGN_HOST's real page instead (no script, so no READY)
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read to <file>, so the check's test can replay it through judge().
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-signpage-client";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_HOST = "https://confidential.unrealized.trade";
export const SIGN_URL = "https://sign.confidential.unrealized.trade/";
export const ATTRS = {
  sandbox: "allow-scripts allow-same-origin",
  allow: "",
  referrerpolicy: "no-referrer",
  "aria-hidden": "true",
  tabindex: "-1",
  width: "0",
  height: "0",
};
export const HANDSHAKE_MS = 5_000;
export const SLACK_MS = 1_500;
export const RETRY_MS = 10_000;
export const CLS_MAX = 0.1;
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const runs = rec.runs ?? [];
  for (const w of WIDTHS) {
    for (const kind of ["served", "blocked"]) {
      const r = runs.find((x) => x.width === w.name && x.kind === kind);
      if (!r) {
        say(false, `${w.name} ${kind}: no run`);
        continue;
      }
      const frames = r.frames ?? [];
      const f = frames[0];
      const attrsBad = f ? Object.entries(ATTRS).filter(([k, v]) => f.attrs?.[k] !== v).map(([k]) => k) : [];
      const extra = f ? Object.keys(f.attrs ?? {}).filter((k) => !(k in ATTRS) && !["src", "style"].includes(k)) : [];
      say(
        frames.length === 1 && f.src === SIGN_URL && attrsBad.length === 0 && extra.length === 0,
        `${w.name} ${kind}: ${frames.length} iframe(s)${f ? `, src ${f.src}` : ""}${attrsBad.length ? `, wrong ${attrsBad.join(", ")}` : ""}${extra.length ? `, extra ${extra.join(", ")}` : ""}${frames.length === 1 && attrsBad.length + extra.length === 0 ? ", the hidden iframe's attributes" : ""}`,
      );
      if (!r.shot) say(false, `${w.name} ${kind}: no screenshot`);
      if (kind === "served") {
        const t = firstAt(r.timeline, "ready");
        say(t !== null && t <= HANDSHAKE_MS, `${w.name} served: READY ${t === null ? `never (last state ${last(r.timeline)})` : `at ${Math.round(t)} ms`}, limit ${HANDSHAKE_MS} ms`);
        const errs = [...(r.violations ?? []).map((v) => `CSP ${v.directive} ${v.blocked}`), ...(r.consoleErrors ?? [])];
        say(errs.length === 0, `${w.name} served: ${errs.length ? errs.join("; ") : "no CSP violation, no console error"}`);
        say(r.cls <= CLS_MAX, `${w.name} served: CLS ${Number(r.cls).toFixed(4)}, limit ${CLS_MAX}`);
      } else {
        const tr = firstAt(r.timeline, "ready");
        const td = firstAt(r.timeline, "down");
        say(td !== null && td <= HANDSHAKE_MS + SLACK_MS && (tr === null || tr > (r.unblockedAt ?? Infinity)), `${w.name} blocked: down ${td === null ? "never" : `at ${Math.round(td)} ms`}, limit ${HANDSHAKE_MS + SLACK_MS} ms${tr !== null && tr <= (r.unblockedAt ?? Infinity) ? ", but READY while blocked" : ""}`);
        say(r.toast?.visible === true, `${w.name} blocked: the down toast ${r.toast?.visible ? `shows ("${r.toast.text}")` : "does not show"}`);
        const back = tr !== null && r.unblockedAt != null ? tr - r.unblockedAt : null;
        say(back !== null && back <= RETRY_MS + HANDSHAKE_MS && r.reloaded === false, `${w.name} blocked: SIGN_HOST let through, READY again ${back === null ? "never" : `${Math.round(back)} ms later`}${r.reloaded ? " after a reload" : ", no reload"}, limit ${RETRY_MS + HANDSHAKE_MS} ms`);
      }
    }
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

const firstAt = (timeline, s) => (timeline ?? []).find((e) => e.s === s)?.t ?? null;
const last = (timeline) => (timeline ?? []).at(-1)?.s ?? "none";

// ------------------------------------------------------------------------------------------------ the read
// runs in the page before its own code: CSP violations, layout shifts and every change of <html data-signpage>
const INIT = () => {
  if (window.top !== window) return; // the app's page only, not the frame
  window.__sp = { violations: [], shifts: [], timeline: [], doc: Math.random() };
  document.addEventListener("securitypolicyviolation", (e) => window.__sp.violations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__sp.shifts.push(e.value);
  }).observe({ type: "layout-shift", buffered: true });
  new MutationObserver(() => {
    const s = document.documentElement.dataset.signpage ?? null;
    const tl = window.__sp.timeline;
    if (tl.at(-1)?.s !== s) tl.push({ s, t: performance.now() });
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-signpage"] });
};

const READ = () => ({
  frames: [...document.querySelectorAll("iframe")].map((f) => ({
    src: f.src,
    attrs: Object.fromEntries([...f.attributes].map((a) => [a.name, a.value])),
  })),
  timeline: window.__sp.timeline,
  violations: window.__sp.violations,
  cls: window.__sp.shifts.reduce((a, b) => a + b, 0),
  doc: window.__sp.doc,
  toast: (() => {
    const t = document.querySelector(".spdown");
    if (!t) return { visible: false, text: null };
    const r = t.getBoundingClientRect();
    return { visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight, text: t.textContent };
  })(),
});

const isSign = (u) => {
  try {
    return new URL(u).origin === new URL(SIGN_URL).origin;
  } catch {
    return false;
  }
};

async function waitFor(page, status, ms) {
  await page
    .waitForFunction((s) => document.documentElement.dataset.signpage === s, status, { timeout: ms, polling: 50 })
    .catch(() => {});
}

export async function collect({ browser, url = APP_HOST, shots, source }) {
  const origin = new URL(url).origin;
  mkdirSync(shots, { recursive: true });
  const rec = { url: origin, source, at: new Date().toISOString(), browser: browser.version(), runs: [] };
  for (const w of WIDTHS) {
    for (const kind of ["served", "blocked"]) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
      await ctx.addInitScript(INIT);
      const block = (route) => route.abort("connectionrefused");
      const signUrls = (u) => isSign(u.href);
      if (kind === "blocked") await ctx.route(signUrls, block);
      const page = await ctx.newPage();
      const consoleErrors = [];
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      page.on("pageerror", (e) => consoleErrors.push(String(e)));
      const run = { width: w.name, kind, unblockedAt: null, reloaded: null };
      await page.goto(origin + "/", { waitUntil: "load" });
      if (kind === "served") {
        await waitFor(page, "ready", HANDSHAKE_MS + SLACK_MS);
        await page.waitForTimeout(500);
      } else {
        await waitFor(page, "down", HANDSHAKE_MS + SLACK_MS);
        await page.waitForTimeout(300);
      }
      const shot = path.join(shots, `${w.name}-${kind}.png`);
      await page.screenshot({ path: shot });
      const first = await page.evaluate(READ);
      if (kind === "blocked") {
        await ctx.unroute(signUrls, block);
        run.unblockedAt = await page.evaluate(() => performance.now());
        await waitFor(page, "ready", RETRY_MS + HANDSHAKE_MS + SLACK_MS);
        const after = await page.evaluate(READ);
        run.reloaded = after.doc !== first.doc;
        Object.assign(run, { frames: first.frames, timeline: after.timeline, toast: first.toast, violations: first.violations, cls: first.cls });
        await page.screenshot({ path: path.join(shots, `${w.name}-blocked-recovered.png`) });
      } else {
        Object.assign(run, { frames: first.frames, timeline: first.timeline, toast: first.toast, violations: first.violations, cls: first.cls });
      }
      run.consoleErrors = kind === "served" ? consoleErrors : [];
      run.shot = shot;
      rec.runs.push(run);
      await ctx.close();
    }
  }
  return rec;
}

// ------------------------------------------------------------------------------------------------ the harness's frame
// A SIGN_HOST stand-in that speaks the frozen shapes (packages/kit/src/signpage/messages.ts): it posts `ready` to
// APP_HOST and answers `state` from APP_HOST's window only. Served under SIGN_HOST's own _headers, so its one script
// carries its sha384 (Integrity-Policy) and runs under script-src 'self'.
const FRAME_JS = `const APP = ${JSON.stringify(APP_HOST)};
const STATE = { release: "harness-frame", api: 1, signed_in: false, code_saved: false, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
addEventListener("message", (e) => {
  if (e.origin !== APP || e.source !== parent) return;
  if (e.data && e.data.type === "state") parent.postMessage({ v: 1, id: e.data.id, ok: true, result: STATE }, APP);
});
parent.postMessage({ v: 1, type: "ready", release: "harness-frame", api: 1 }, APP);
`;

export function frameSite(signRoot) {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-sign-frame-"));
  cpSync(signRoot, dir, { recursive: true });
  writeFileSync(path.join(dir, "frame.js"), FRAME_JS);
  const integrity = `sha384-${createHash("sha384").update(FRAME_JS).digest("base64")}`;
  const html = readFileSync(path.join(dir, "index.html"), "utf8").replace(
    "<body></body>",
    `<body><script src="/frame.js" integrity="${integrity}" crossorigin="anonymous"></script></body>`,
  );
  writeFileSync(path.join(dir, "index.html"), html);
  return dir;
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const shots = opt("--shots") ?? path.join(tmpdir(), `${KEY}-${Date.now()}`);
  const record = opt("--record");
  let rec;
  if (args.includes("--harness")) {
    const { startHarness, HOSTS } = await import("../../apps/terminal/test/harness/harness.mjs");
    let frameDir = null;
    const silent = args.includes("--silent");
    const h = await startHarness({
      realNames: true,
      edit: (sites) => {
        if (!silent) {
          frameDir = frameSite(sites[HOSTS.sign].root);
          sites[HOSTS.sign] = { root: frameDir };
        }
      },
    });
    try {
      rec = await collect({ browser: h.browser, shots, source: `harness${silent ? ", SIGN_HOST's real page" : ", the test frame"}` });
    } finally {
      await h.close();
      if (frameDir) rmSync(frameDir, { recursive: true, force: true });
    }
  } else {
    const { chromium } = createRequire(path.join(REPO, "apps/terminal/package.json"))("playwright");
    const browser = await chromium.launch();
    try {
      rec = await collect({ browser, url: opt("--url") ?? APP_HOST, shots, source: "live" });
    } finally {
      await browser.close();
    }
  }
  if (record) writeFileSync(record, `${JSON.stringify(rec, null, 2)}\n`);
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, Chromium ${rec.browser}, shots ${shots})`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
