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
//   - READY within 5,000 ms of the terminal's start (BAR-09);
//   - no CSP violation and no console error in the terminal's frame; a screenshot of each run is kept.
// On the harness two more runs per engine and width, each with its own stand-in shell:
//   - late: the shell holds its ready for 7 s; within 5,000 ms plus 1,500 ms of slack the terminal is down with its
//     toast on screen, and once the ready comes it is READY again with no reload (AE-08);
//   - tap: the shell sends a signed-out state and refuses every open (not_allowed); Sign in, then Use passkey, shows the
//     line in place of the tap (refused, no Retry, in the sheet) within the kit's 5,000 ms for an open plus 1,500 ms,
//     the top window stays on SIGN_HOST, and no pop-up opens (card app-hop-refused's rule: a tap never ends in nothing).
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
/** BAR-09: READY within this long of the terminal's start; the late run's down limit adds SLACK_MS. */
export const HANDSHAKE_MS = 5_000;
export const SLACK_MS = 1_500;
/** The kit's window for an open kind (SIGNPAGE_TIMEOUT_MS["signin.open"]). */
export const OPEN_WINDOW_MS = 5_000;
/** How long the late run's shell holds its ready after the frame's load. */
export const LATE_READY_MS = 7_000;
/** The run kinds: live runs read `signed` only (the real shell cannot be told to hold its ready or refuse). */
export const KINDS = ["signed", "late", "tap"];
export const CONTROL = "signin-passkey";
/** After READY, how long the check keeps watching for a further top-level navigation (a hop). */
const SETTLE_MS = 1_500;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const want = HEADER[rec.expect];
  if (!want) say(false, `expect ${rec.expect}: not in or out`);
  const kinds = rec.source === "live" ? ["signed"] : KINDS;
  for (const engine of ENGINES) {
    for (const w of WIDTHS) {
      for (const kind of kinds.slice(1)) judgeMore(say, `${engine} ${w.name} ${kind}`, (rec.runs ?? []).find((x) => x.engine === engine && x.width === w.name && x.kind === kind), kind);
      const n = `${engine} ${w.name}`;
      const r = (rec.runs ?? []).find((x) => x.engine === engine && x.width === w.name && (x.kind ?? "signed") === "signed");
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
      const tReady = firstAt(r.app.timeline, "ready");
      say(tReady !== null && tReady <= HANDSHAKE_MS, `${n}: READY ${tReady === null ? "never" : `at ${Math.round(tReady)} ms`} of the terminal's start, limit ${HANDSHAKE_MS} ms`);
      const errs = [...(r.app.violations ?? []).map((v) => `CSP ${v.directive} ${v.blocked}`), ...(r.app.errors ?? [])];
      say(errs.length === 0, `${n}: ${errs.length ? errs.join("; ") : "no CSP violation, no console error in the terminal's frame"}`);
      if (!r.shot) say(false, `${n}: no screenshot`);
    }
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

const firstAt = (timeline, st) => (timeline ?? []).find((e) => e.s === st)?.t ?? null;

/** The late and tap runs' lines. */
function judgeMore(say, n, r, kind) {
  if (!r) return say(false, `${n}: no run`);
  if (r.error) return say(false, `${n}: ${r.error}`);
  if (!r.app) return say(false, `${n}: no APP_HOST frame in the top window (top at ${r.top})`);
  if (!r.shot) say(false, `${n}: no screenshot`);
  if (kind === "late") {
    const td = firstAt(r.app.timeline, "down");
    const tr = (r.app.timeline ?? []).find((e) => e.s === "ready" && td !== null && e.t > td)?.t ?? null;
    const early = (r.app.timeline ?? []).some((e) => e.s === "ready" && (td === null || e.t < td));
    say(td !== null && td <= HANDSHAKE_MS + SLACK_MS && !early, `${n}: down ${td === null ? "never" : `at ${Math.round(td)} ms`}${early ? ", but READY before it" : ""}, limit ${HANDSHAKE_MS + SLACK_MS} ms`);
    say(r.toast?.visible === true, `${n}: the down toast ${r.toast?.visible ? `shows ("${r.toast.text}")` : "does not show"}`);
    say(tr !== null && r.reloaded === false, `${n}: READY again ${tr === null ? "never" : `at ${Math.round(tr)} ms`}, once the shell's late ready came${r.reloaded ? ", after a reload" : ", no reload"}`);
    return;
  }
  const limit = OPEN_WINDOW_MS + SLACK_MS;
  const l = r.line;
  const ok = r.outcome === "line" && typeof r.ms === "number" && r.ms <= limit && l?.why === "refused" && l.retry === false && l.inPlace === true && (l.text ?? "").trim().length > 0;
  say(ok, `${n}: ${r.outcome === "line" ? `the tap shows "${l?.text ?? ""}" (${l?.why ?? "no why"}, Retry ${l?.retry ? "shown" : "not shown"}${l?.inPlace ? ", in the sheet" : ", NOT in the sheet"}) ${Math.round(r.ms)} ms after it` : `the tap shows nothing (control ${r.control ?? "?"})`}, limit ${limit} ms`);
  say(r.topAfter === SIGN_HOST + PATH && (r.topNavigations ?? []).length === 2, `${n}: the top window ${r.topAfter === SIGN_HOST + PATH ? "stayed on SIGN_HOST" : `moved to ${r.topAfter}`}, ${(r.topNavigations ?? []).length} top navigation(s)`);
  say((r.dialogs ?? []).length === 0 && (r.popups ?? 0) === 0, `${n}: ${(r.dialogs ?? []).length || r.popups ? `pop-ups ${[...(r.dialogs ?? []), ...(r.popups ? [`${r.popups} window(s)`] : [])].join(", ")}` : "no pop-up"}`);
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
  window.__ctTimeline = [];
  window.__ctDoc = Math.random();
  document.addEventListener("securitypolicyviolation", (e) => window.__ctViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
  new MutationObserver(() => {
    const st = document.documentElement.dataset.signpage ?? null;
    const tl = window.__ctTimeline;
    if (tl.at(-1)?.s !== st) tl.push({ s: st, t: performance.now() });
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-signpage"] });
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
    timeline: window.__ctTimeline ?? [],
    doc: window.__ctDoc ?? null,
  };
};

const READ_TOAST = () => {
  const t = document.querySelector(".spdown");
  if (!t) return { visible: false, text: null };
  const r = t.getBoundingClientRect();
  return { visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight, text: t.textContent };
};

// card app-hop-refused's read of the line in place of a tap
const READ_LINE = (control) => {
  const el = [...document.querySelectorAll(`[data-hop-failed="${control}"]`)].find((e) => e.getClientRects().length > 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const b = document.querySelector(".sgn-box")?.getBoundingClientRect();
  return {
    why: el.dataset.hopWhy ?? null,
    text: el.querySelector(".warn")?.textContent ?? el.textContent,
    retry: el.querySelector("[data-hop-retry]") !== null,
    inPlace: !!b && r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.width > 0,
  };
};

const waitState = async (page, f, want, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const st = await f.evaluate(() => document.documentElement.dataset.signpage ?? null).catch(() => null);
    if (want.includes(st)) return st;
    await page.waitForTimeout(50);
  }
  return null;
};

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

async function runOne({ browser, engine, w, shots, route, kind = "signed" }) {
  const ctx = await browser.newContext({
    viewport: w.viewport,
    deviceScaleFactor: w.deviceScaleFactor,
    ...(engine === "firefox" ? {} : { isMobile: w.isMobile }),
    hasTouch: w.hasTouch,
  });
  const run = { engine, width: w.name, kind, drewAtTop: false, topNavigations: [], dialogs: [], popups: 0 };
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
    page.on("dialog", (d) => {
      run.dialogs.push(d.type());
      d.dismiss().catch(() => {});
    });
    ctx.on("page", () => run.popups++);
    await page.goto(APP_HOST + PATH, { waitUntil: "commit" });
    await page.waitForURL((u) => u.origin === SIGN_HOST, { timeout: READY_MS }).catch(() => {});
    await page.waitForLoadState("load").catch(() => {});
    const appFrame = async () => page.frames().find((f) => f !== page.mainFrame() && originOf(f.url()) === APP_HOST) ?? null;
    let f = null;
    const until = Date.now() + READY_MS;
    while (!f && Date.now() < until) {
      f = await appFrame();
      if (!f) await page.waitForTimeout(100);
    }
    if (f && kind === "signed") await waitState(page, f, ["ready", "down", "update"], READY_MS);
    if (f && kind === "late") {
      await waitState(page, f, ["down"], HANDSHAKE_MS + SLACK_MS + 1_000);
      run.toast = await f.evaluate(READ_TOAST);
      run.docAtDown = await f.evaluate(() => window.__ctDoc ?? null);
      await page.screenshot({ path: path.join(shots, `${engine}-${w.name}-late-down.png`) });
      await waitState(page, f, ["ready"], LATE_READY_MS + HANDSHAKE_MS);
    }
    if (f && kind === "tap") {
      await waitState(page, f, ["ready"], READY_MS);
      await f.click(w.isMobile ? ".phh [data-header='S1.1']" : ".btn-signin");
      const ctl = `[data-control="${CONTROL}"]:visible`;
      await f.waitForSelector(ctl, { timeout: 3_000 });
      await f.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => !e.disabled), ctl.replace(":visible", ""), { timeout: 3_000 }).catch(() => {});
      const t0 = Date.now();
      await f.click(ctl);
      run.outcome = await f.waitForSelector(`[data-hop-failed="${CONTROL}"]:visible`, { timeout: OPEN_WINDOW_MS + SLACK_MS }).then(() => "line").catch(() => "none");
      run.ms = run.outcome === "line" ? Date.now() - t0 : null;
      run.line = run.outcome === "line" ? await f.evaluate(READ_LINE, CONTROL) : null;
      if (run.outcome === "none") run.control = await f.evaluate((c) => [...document.querySelectorAll(`[data-control="${c}"]`)].map((e) => (e.disabled ? "off" : "on")).join(",") || "gone", CONTROL);
    }
    await page.waitForTimeout(SETTLE_MS);
    run.topAfter = page.url();
    run.top = page.url();
    f = await appFrame();
    if (f) {
      run.app = await f.evaluate(READ_APP);
      if (kind === "late") run.reloaded = run.app.doc === null || run.app.doc !== run.docAtDown;
      run.app.errors = errors.filter((e) => originOf(e.url) !== SIGN_HOST).map((e) => e.text);
    } else if (originOf(page.url()) === APP_HOST) {
      // today's layout: the terminal top-level; read it the same way, so the record shows what it drew
      run.app = null;
      run.topApp = await page.evaluate(READ_APP);
    }
    run.shot = path.join(shots, `${engine}-${w.name}${kind === "signed" ? "" : `-${kind}`}.png`);
    await page.screenshot({ path: run.shot });
  } catch (e) {
    run.error = String(e?.message ?? e).split("\n")[0];
  } finally {
    await ctx.close();
  }
  return run;
}

/** `routes`: a route per run kind (the harness), or null (the live hosts: the signed run only). */
export async function collect({ launchers, shots, source, expect, routes }) {
  mkdirSync(shots, { recursive: true });
  const rec = { source, expect, path: PATH, at: new Date().toISOString(), browsers: {}, runs: [] };
  for (const [engine, launch] of launchers) {
    const browser = await launch();
    rec.browsers[engine] = browser.version();
    try {
      for (const w of WIDTHS) {
        for (const kind of routes ? KINDS : ["signed"]) rec.runs.push(await runOne({ browser, engine, w, shots, route: routes?.[kind] ?? null, kind }));
      }
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
const SIGNED_IN = { release: "harness-shell", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "1250.00", wallets: [], positions: [], orders: [], held: [], ops: [] };
const SIGNED_OUT = { release: "harness-shell", api: 1, signed_in: false, code_saved: false, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
const shellJs = (kind) => `const APP = ${JSON.stringify(APP_HOST)};
const STATE = ${JSON.stringify(kind === "tap" ? SIGNED_OUT : SIGNED_IN)};
const HOLD = ${kind === "late" ? LATE_READY_MS : 0};
const f = document.createElement("iframe");
f.src = APP + location.pathname + location.search;
f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
f.setAttribute("allow", "clipboard-write");
f.addEventListener("load", () => setTimeout(() => f.contentWindow.postMessage({ v: 1, type: "ready", release: "harness-shell", api: 1 }, APP), HOLD));
addEventListener("message", (e) => {
  if (e.origin !== APP || e.source !== f.contentWindow || !e.data || typeof e.data.id !== "string") return;
  const answer = e.data.type === "state" ? { v: 1, id: e.data.id, ok: true, result: STATE } : { v: 1, id: e.data.id, ok: false, error: { code: "not_allowed" } };
  f.contentWindow.postMessage(answer, APP);
});
document.body.appendChild(f);
`;
const SHELL_CSS = "html,body{margin:0;height:100%;background:#000}iframe{display:block;border:0;width:100%;height:100%}\n";
const sri = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const shellHtml = (js) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Shell</title><link rel="stylesheet" href="/shell.css" integrity="${sri(SHELL_CSS)}" crossorigin="anonymous"></head>
<body><script src="/shell.js" integrity="${sri(js)}" crossorigin="anonymous"></script></body></html>
`;

/** SIGN_HOST's shipped headers with section 4's frame rules. */
export function shellHeaders(signHeadersFile) {
  return signHeadersFile.replace(`frame-ancestors ${APP_HOST};`, `frame-src ${APP_HOST}; frame-ancestors 'none';`);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

export async function harnessRoute(appBuild, kind = "signed") {
  const { parseHeadersFile } = await import("../../apps/terminal/scripts/check-deploy.ts");
  const { headersFor } = await import("../../apps/terminal/test/harness/server.mjs");
  const rulesOf = (text) => {
    const p = parseHeadersFile(text);
    if (p.problems.length) throw new Error(`${KEY}: _headers: ${p.problems.join("; ")}`);
    return p.rules;
  };
  const appRules = rulesOf(readFileSync(path.join(appBuild, "_headers"), "utf8"));
  const signRules = rulesOf(shellHeaders(readFileSync(path.join(REPO, "packages/signpage/public/_headers"), "utf8")));
  const js = shellJs(kind);
  const shellFiles = { "/shell.js": js, "/shell.css": SHELL_CSS };
  const headers = (rules, p, type) => ({ ...Object.fromEntries(headersFor(rules, p)), "content-type": type });
  return async (route) => {
    const u = new URL(route.request().url());
    if (u.origin === SIGN_HOST) {
      const body = shellFiles[u.pathname] ?? shellHtml(js);
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
  const routes = harness ? Object.fromEntries(await Promise.all(KINDS.map(async (k) => [k, await harnessRoute(build, k)]))) : null;
  const expect = opt("--expect") ?? (harness ? "in" : "out");
  const source = harness ? `harness, terminal build ${path.relative(REPO, build) || build}, the stand-in shell` : "live";
  const rec = await collect({ launchers, shots, source, expect, routes });
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
