#!/usr/bin/env node
// Live check of card app-in-shell: the terminal runs only inside SIGN_HOST's shell (SIGN_HOST is the top window and
// frames APP_HOST), so Safari and every iPhone read the wallet's own store with no hop. On Chromium, Firefox and WebKit
// (Playwright's), at 390 x 844 (phone) and 1440 x 900 (desktop), it opens APP_HOST top-level at a path with a query and
// reads:
//   - the top window lands on SIGN_HOST at the same path and query;
//   - APP_HOST drew nothing while top-level (its #root never got a child before it moved);
//   - the shell frames APP_HOST at the same path and query;
//   - inside the shell the terminal reaches READY (<html data-signpage="ready">) and its visible header shows the state
//     the shell sent: signed in with a balance (data-header S1.4) on the harness, whose shell sends a signed-in state;
//   - no hop: the top window navigated exactly twice (APP_HOST, then SIGN_HOST), and the terminal frames nothing;
//   - no CSP violation and no console error in the terminal's frame; a screenshot of each run is kept.
//   node scripts/live-checks/app-in-shell.mjs [--engines chromium,firefox,webkit] [--shots <dir>] [--record <file>]
//     [--expect in|out]   the live hosts; a fresh browser is signed out, so live runs read --expect out (default)
//   node scripts/live-checks/app-in-shell.mjs --harness [--build <dir>] ...   the hosts' real names answered by
//     Playwright's route from local files, in all three engines: APP_HOST serves the terminal's build (apps/terminal/dist,
//     or --build <dir>) under its own _headers; SIGN_HOST serves a stand-in shell (below) that frames APP_HOST and speaks
//     the signing page's messages from the top window, signed in. --build <today's build> records the bad answer.
//     PASS exit 0, FAIL exit 1, error exit 2
// Playwright's WebKit turns WebKit's storage blocking off, so it cannot show storage splits; this check reads no
// storage. Which store the shell reads on Safari's engine is card signpage-shell's check, on the system WebKit.
// --record writes what the run read to <file>, so the check's test can replay it through judge().
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-in-shell";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_HOST = "https://confidential.unrealized.trade";
export const SIGN_HOST = "https://sign.confidential.unrealized.trade";
/** The path and query the check opens: a route of the app with a query, so both must survive the move. */
export const PATH = "/discover?ref=app-in-shell";
export const ENGINES = ["chromium", "firefox", "webkit"];
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
/** The visible header's state for each expectation (apps/terminal/src/screens/signin/Account.tsx). */
export const HEADER = { in: "S1.4", out: "S1.1" };
const READY_MS = 8_000;
/** After READY, how long the check keeps watching for a further top-level navigation (a hop). */
const SETTLE_MS = 1_500;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const want = HEADER[rec.expect];
  if (!want) say(false, `expect ${rec.expect}: not in or out`);
  for (const engine of ENGINES) {
    for (const w of WIDTHS) {
      const n = `${engine} ${w.name}`;
      const r = (rec.runs ?? []).find((x) => x.engine === engine && x.width === w.name);
      if (!r) {
        say(false, `${n}: no run`);
        continue;
      }
      if (r.error) {
        say(false, `${n}: ${r.error}`);
        continue;
      }
      say(r.top === SIGN_HOST + PATH, `${n}: APP_HOST${PATH} top-level ${r.top === SIGN_HOST + PATH ? "lands on" : "ends at"} ${r.top}`);
      say(r.drewAtTop === false, `${n}: APP_HOST top-level ${r.drewAtTop === false ? "drew nothing before it moved" : "drew the app"}`);
      const frameUrl = r.app?.url ?? null;
      say(frameUrl === APP_HOST + PATH, `${n}: ${frameUrl ? `the shell frames ${frameUrl}` : "no APP_HOST frame in the top window"}`);
      if (!r.app) continue;
      const hdr = r.app.header;
      say(r.app.signpage === "ready" && hdr === want, `${n}: inside the shell, signing page ${r.app.signpage ?? "none"}, header ${hdr ?? "none"} (want ready, ${want})`);
      const navs = r.topNavigations ?? [];
      const hop = navs.length === 2 && navs[0] === APP_HOST + PATH && navs[1] === SIGN_HOST + PATH && r.app.iframes === 0;
      say(hop, `${n}: ${hop ? "no hop: the top window navigated twice, APP_HOST then SIGN_HOST, and the terminal frames nothing" : `top navigations ${JSON.stringify(navs)}, iframes in the terminal ${r.app.iframes}`}`);
      const errs = [...(r.app.violations ?? []).map((v) => `CSP ${v.directive} ${v.blocked}`), ...(r.app.errors ?? [])];
      say(errs.length === 0, `${n}: ${errs.length ? errs.join("; ") : "no CSP violation, no console error in the terminal's frame"}`);
      if (!r.shot) say(false, `${n}: no screenshot`);
    }
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
// before any page script, in every frame: on APP_HOST top-level, tell the check when #root first gets a child; in the
// terminal's frame, keep CSP violations
const INIT = ({ app }) => {
  if (location.origin !== app) return;
  if (window.top === window) {
    const seen = () => {
      const r = document.getElementById("root");
      if (r && r.childElementCount > 0) {
        window.__ctDrew?.();
        return true;
      }
      return false;
    };
    const mo = new MutationObserver(() => seen() && mo.disconnect());
    mo.observe(document, { childList: true, subtree: true });
    return;
  }
  window.__ctViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__ctViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
};

const READ_APP = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const hdr = [...document.querySelectorAll(".phh [data-header], .tb [data-header]")].find(vis);
  return {
    url: location.href,
    signpage: document.documentElement.dataset.signpage ?? null,
    header: hdr?.getAttribute("data-header") ?? null,
    iframes: document.querySelectorAll("iframe").length,
    violations: window.__ctViolations ?? [],
  };
};

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

async function runOne({ browser, engine, w, shots, route }) {
  const ctx = await browser.newContext({
    viewport: w.viewport,
    deviceScaleFactor: w.deviceScaleFactor,
    ...(engine === "firefox" ? {} : { isMobile: w.isMobile }),
    hasTouch: w.hasTouch,
  });
  const run = { engine, width: w.name, drewAtTop: false, topNavigations: [] };
  try {
    if (route) await ctx.route("**/*", route);
    await ctx.exposeBinding("__ctDrew", ({ frame }) => {
      if (frame === frame.page().mainFrame() && originOf(frame.url()) === APP_HOST) run.drewAtTop = true;
    });
    await ctx.addInitScript(INIT, { app: APP_HOST });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push({ url: m.location()?.url ?? "", text: m.text() }));
    page.on("pageerror", (e) => errors.push({ url: "", text: String(e) }));
    page.on("framenavigated", (f) => f === page.mainFrame() && run.topNavigations.push(f.url()));
    await page.goto(APP_HOST + PATH, { waitUntil: "commit" });
    await page.waitForURL((u) => u.origin === SIGN_HOST, { timeout: READY_MS }).catch(() => {});
    await page.waitForLoadState("load").catch(() => {});
    const appFrame = async () => page.frames().find((f) => f !== page.mainFrame() && originOf(f.url()) === APP_HOST) ?? null;
    let f = await appFrame();
    const until = Date.now() + READY_MS;
    while (Date.now() < until) {
      f = await appFrame();
      const s = f ? await f.evaluate(() => document.documentElement.dataset.signpage ?? null).catch(() => null) : null;
      if (s === "ready" || s === "down" || s === "update") break;
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(SETTLE_MS);
    run.top = page.url();
    f = await appFrame();
    if (f) {
      run.app = await f.evaluate(READ_APP);
      run.app.errors = errors.filter((e) => originOf(e.url) !== SIGN_HOST).map((e) => e.text);
    } else if (originOf(page.url()) === APP_HOST) {
      // today's layout: the terminal top-level; read it the same way, so the record shows what it drew
      run.app = null;
      run.topApp = await page.evaluate(READ_APP);
    }
    run.shot = path.join(shots, `${engine}-${w.name}.png`);
    await page.screenshot({ path: run.shot });
  } catch (e) {
    run.error = String(e?.message ?? e).split("\n")[0];
  } finally {
    await ctx.close();
  }
  return run;
}

export async function collect({ launchers, shots, source, expect, route }) {
  mkdirSync(shots, { recursive: true });
  const rec = { source, expect, path: PATH, at: new Date().toISOString(), browsers: {}, runs: [] };
  for (const [engine, launch] of launchers) {
    const browser = await launch();
    rec.browsers[engine] = browser.version();
    try {
      for (const w of WIDTHS) rec.runs.push(await runOne({ browser, engine, w, shots, route }));
    } finally {
      await browser.close();
    }
  }
  return rec;
}

// ------------------------------------------------------------------------------------------------ the harness
// A SIGN_HOST stand-in shell, as card signpage-shell's end state says (webkit-frame-storage.md section 4): it frames
// APP_HOST at its own path and query, full size; posts `ready` to the frame on each of its loads; answers `state` from
// that frame's window only, with targetOrigin APP_HOST, signed in; refuses every other kind (not_allowed). Its headers
// are SIGN_HOST's _headers with section 4's frame rules: frame-ancestors 'none' and frame-src APP_HOST.
const SHELL_JS = `const APP = ${JSON.stringify(APP_HOST)};
const STATE = { release: "harness-shell", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "1250.00", wallets: [], positions: [], orders: [], held: [], ops: [] };
const f = document.createElement("iframe");
f.src = APP + location.pathname + location.search;
f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
f.setAttribute("allow", "clipboard-write");
f.addEventListener("load", () => f.contentWindow.postMessage({ v: 1, type: "ready", release: "harness-shell", api: 1 }, APP));
addEventListener("message", (e) => {
  if (e.origin !== APP || e.source !== f.contentWindow || !e.data || typeof e.data.id !== "string") return;
  const answer = e.data.type === "state" ? { v: 1, id: e.data.id, ok: true, result: STATE } : { v: 1, id: e.data.id, ok: false, error: { code: "not_allowed" } };
  f.contentWindow.postMessage(answer, APP);
});
document.body.appendChild(f);
`;
const SHELL_CSS = "html,body{margin:0;height:100%;background:#000}iframe{display:block;border:0;width:100%;height:100%}\n";
const sri = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const SHELL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Shell</title><link rel="stylesheet" href="/shell.css" integrity="${sri(SHELL_CSS)}" crossorigin="anonymous"></head>
<body><script src="/shell.js" integrity="${sri(SHELL_JS)}" crossorigin="anonymous"></script></body></html>
`;

/** SIGN_HOST's shipped headers with section 4's frame rules. */
export function shellHeaders(signHeadersFile) {
  return signHeadersFile.replace(`frame-ancestors ${APP_HOST};`, `frame-src ${APP_HOST}; frame-ancestors 'none';`);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

async function harnessRoute(appBuild) {
  const { parseHeadersFile } = await import("../../apps/terminal/scripts/check-deploy.ts");
  const { headersFor } = await import("../../apps/terminal/test/harness/server.mjs");
  const rulesOf = (text) => {
    const p = parseHeadersFile(text);
    if (p.problems.length) throw new Error(`${KEY}: _headers: ${p.problems.join("; ")}`);
    return p.rules;
  };
  const appRules = rulesOf(readFileSync(path.join(appBuild, "_headers"), "utf8"));
  const signRules = rulesOf(shellHeaders(readFileSync(path.join(REPO, "packages/signpage/public/_headers"), "utf8")));
  const shellFiles = { "/shell.js": SHELL_JS, "/shell.css": SHELL_CSS };
  const headers = (rules, p, type) => ({ ...Object.fromEntries(headersFor(rules, p)), "content-type": type });
  return async (route) => {
    const u = new URL(route.request().url());
    if (u.origin === SIGN_HOST) {
      const body = shellFiles[u.pathname] ?? SHELL_HTML;
      const type = TYPES[path.extname(shellFiles[u.pathname] ? u.pathname : "/index.html")];
      return route.fulfill({ status: 200, headers: headers(signRules, u.pathname, type), body });
    }
    if (u.origin === APP_HOST) {
      let file = path.join(appBuild, decodeURIComponent(u.pathname));
      if (!file.startsWith(appBuild + path.sep) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(appBuild, "index.html");
      return route.fulfill({ status: 200, headers: headers(appRules, u.pathname, TYPES[path.extname(file)] ?? "application/octet-stream"), body: readFileSync(file) });
    }
    return route.abort("namenotresolved");
  };
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const shots = opt("--shots") ?? path.join(tmpdir(), `${KEY}-${Date.now()}`);
  const engines = (opt("--engines") ?? ENGINES.join(",")).split(",");
  if (!engines.every((e) => ENGINES.includes(e))) throw new Error(`--engines takes ${ENGINES.join(",")}`);
  const pw = createRequire(path.join(REPO, "apps/terminal/package.json"))("playwright");
  const launchers = engines.map((e) => [e, () => pw[e].launch()]);
  const harness = args.includes("--harness");
  const build = path.resolve(opt("--build") ?? path.join(REPO, "apps/terminal/dist"));
  const route = harness ? await harnessRoute(build) : null;
  const expect = opt("--expect") ?? (harness ? "in" : "out");
  const source = harness ? `harness, terminal build ${path.relative(REPO, build) || build}, the stand-in shell` : "live";
  const rec = await collect({ launchers, shots, source, expect, route });
  const record = opt("--record");
  if (record) writeFileSync(record, `${JSON.stringify(rec, null, 2)}\n`);
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, ${Object.entries(rec.browsers).map(([k, v]) => `${k} ${v}`).join(", ")}, shots ${shots})`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
