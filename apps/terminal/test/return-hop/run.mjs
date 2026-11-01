#!/usr/bin/env node
// The return-hop browser run (card app-return-hop; A1.3, app.md:1441; AX-07 app.md:1392; dead-end rows 3, 4 and 8,
// app.md:1192-1197). On the app's harness (test/harness) with the real names mapped to it, so both hosts serve under
// their own shipped _headers (COOP same-origin on both, the CSPs, Integrity-Policy):
//   - APP_HOST serves the probe build (probe.tsx): the app's own start, shell, signing page client and hop, with a probe
//     screen in every route;
//   - SIGN_HOST serves its release page with a stand-in script in place of the release's own: in the iframe it speaks
//     the frozen ready, state and open kinds (answering an open kind after 300 ms, as a slow page would) and writes a
//     one-use flow record in its own store; top-level it reads that record and returns the tab to APP_HOST's return
//     path for the record's key. The release's script is taken out (signSite): it answers every open kind not_allowed
//     until the signing page's open kinds land, and its answer would come before the stand-in's.
// For each of the five open kinds, at phone and desktop widths, three runs from a different route each:
//   return: open the sheet, type in its field, scroll, tap the kind's control (and tap it again), SIGN_HOST top-level,
//           done, back at the route left with the sheet, the field, the scroll and the control locked until the
//           signing page answers;
//   reload: the same with a reload of SIGN_HOST's top-level page in the middle of the hop;
//   back:   the browser's Back on SIGN_HOST instead of done.
// Then the bad returns: no record, a stale one, one for another kind, a garbled one, a hand-edited return URL and a
// record whose route is another host. Each lands on Discover with nothing restored.
// Then the failures (card app-hop-refused): for every caller of the hop (the sign-in sheet, the account menu's Backup,
// Withdraw and Sign out, and Export through the probe) at both widths, SIGN_HOST refuses the kind (not_allowed), fails
// it (another code) or never answers it. Each shows one line in place, unlocks the control, offers Retry only where a
// retry can work, and stays on the screen with no pop-up.
//   node apps/terminal/test/return-hop/run.mjs [--shots <dir>] [--plant wrong-key] [--only hop|fail|bad]
//     PASS exit 0, FAIL exit 1, error exit 2
// --plant wrong-key makes the stand-in send every flow back to the withdraw return path, so the run must FAIL.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTS, REAL, startHarness, TERMINAL } from "../harness/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = `https://${REAL.app}`;
const SIGN = `https://${REAL.sign}`;
const TTL_MS = 5 * 60_000;
const KINDS = [
  { kind: "signin.open", key: "signin", control: "hop-signin", from: "/", route: "token" },
  { kind: "backup.open", key: "backup", control: "hop-backup", from: "/profile", route: "profile" },
  { kind: "export.open", key: "export", control: "hop-export", from: "/portfolio", route: "portfolio" },
  { kind: "signout", key: "signout", control: "hop-signout", from: "/orders", route: "orders" },
  { kind: "withdraw.open", key: "withdraw", control: "hop-withdraw", from: "/verify", route: "verify" },
];
const MODES = ["return", "reload", "back"];
// The failure runs (card app-hop-refused): SIGN_HOST refuses the open kind (not_allowed: no retry can change the
// page's rule), fails it with another code (a store error: a retry can work), or never answers it (the kit's 5 s
// open-kind window, then client_timeout: a retry can work once the signing page is READY again).
const FAIL_MODES = [
  { mode: "refused", code: "not_allowed", retry: false },
  { mode: "error", code: "store_unavailable", retry: true },
  { mode: "silent", code: null, retry: true },
];
const OPEN_WINDOW_MS = 5_000; // SIGNPAGE_TIMEOUT_MS of every open kind (packages/kit/src/signpage/client.ts)
const SLACK_MS = 1_500;
// Every caller of the hop, as a user reaches it: the sign-in sheet's ways (Sign in, then Use passkey), the account
// menu's Backup, Withdraw and Sign out (desktop: the account chip; phone: the Account tab's rows), and Export, which no
// screen draws yet, through the probe's control as its screen will.
const TARGETS = [
  { name: "signin", kind: "signin.open", control: "signin-passkey", from: "/", signedIn: false, place: "sheet" },
  { name: "backup", kind: "backup.open", control: "acct-backup", from: "/profile", signedIn: true, place: "menu" },
  { name: "withdraw", kind: "withdraw.open", control: "acct-withdraw", from: "/profile", signedIn: true, place: "menu" },
  { name: "signout", kind: "signout", control: "acct-signout", from: "/profile", signedIn: true, place: "menu" },
  { name: "export", kind: "export.open", control: "hop-export", from: "/portfolio", signedIn: true, place: "probe" },
];
const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

// ------------------------------------------------------------------------------------------------ the builds
/** The probe build, with the app's own vite config and public/ (so _headers is the shipped one). */
async function buildProbe() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-return-hop-app-"));
  await build({
    configFile: path.join(TERMINAL, "vite.config.ts"),
    root: HERE,
    publicDir: path.join(TERMINAL, "public"),
    logLevel: "warn",
    build: { outDir: out, emptyOutDir: true },
  });
  return out;
}

const standIn = (plant) => `const APP = ${JSON.stringify(APP)};
const RETURN = ${JSON.stringify(Object.fromEntries(KINDS.map((k) => [k.key, plant === "wrong-key" ? "/return/withdraw" : `/return/${k.key}`])))};
const OPEN = ${JSON.stringify(KINDS.map((k) => k.kind))};
// a failure run sets self.__standIn = { mode, signedIn } in SIGN_HOST's frames before this script (run.mjs failRun)
const MODE = (self.__standIn && self.__standIn.mode) || "ok";
const SIGNED = !!(self.__standIn && self.__standIn.signedIn);
const STATE = SIGNED
  ? { release: "harness-frame", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] }
  : { release: "harness-frame", api: 1, signed_in: false, code_saved: false, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
const CODES = ${JSON.stringify(Object.fromEntries(FAIL_MODES.filter((m) => m.code).map((m) => [m.mode, m.code])))};
const d = document.documentElement;
if (window.top !== window) {
  addEventListener("message", (e) => {
    if (e.origin !== APP || e.source !== parent || !e.data) return;
    const m = e.data;
    if (m.type === "state") return parent.postMessage({ v: 1, id: m.id, ok: true, result: STATE }, APP);
    if (OPEN.includes(m.type) && Object.hasOwn(RETURN, m.return_key)) {
      localStorage.setItem("opens", String(Number(localStorage.getItem("opens") || 0) + 1));
      if (MODE === "silent") return;
      if (Object.hasOwn(CODES, MODE)) return parent.postMessage({ v: 1, id: m.id, ok: false, error: { code: CODES[MODE] } }, APP);
      localStorage.setItem("flow", JSON.stringify({ kind: m.type, return_key: m.return_key, at: Date.now() }));
      setTimeout(() => parent.postMessage({ v: 1, id: m.id, ok: true, result: { pending: true } }, APP), 300);
    }
  });
  parent.postMessage({ v: 1, type: "ready", release: "harness-frame", api: 1 }, APP);
} else {
  let flow = null;
  try { flow = JSON.parse(localStorage.getItem("flow")); } catch {}
  if (flow && Date.now() - flow.at > ${TTL_MS}) flow = null;
  d.dataset.flow = flow ? flow.kind : "none";
  d.dataset.opens = localStorage.getItem("opens") || "0";
  const loads = Number(sessionStorage.getItem("loads") || 0) + 1;
  sessionStorage.setItem("loads", String(loads));
  d.dataset.loads = String(loads);
  const b = document.createElement("button");
  b.id = "done";
  b.textContent = flow ? flow.kind : "none";
  b.addEventListener("click", () => {
    localStorage.removeItem("flow");
    location.replace(APP + (flow ? RETURN[flow.return_key] : "/"));
  });
  document.body.append(b);
}
`;

/**
 * SIGN_HOST's release page with the stand-in script in place of the release's own scripts, its sha384 on the tag
 * (SIGN_HOST's Integrity-Policy). The served page must load exactly one script, the stand-in; any other shape is an
 * error (exit 2), never a run against two scripts.
 */
function signSite(signRoot, plant) {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-return-hop-sign-"));
  cpSync(signRoot, dir, { recursive: true });
  const js = standIn(plant);
  writeFileSync(path.join(dir, "stand-in.js"), js);
  const integrity = `sha384-${createHash("sha384").update(js).digest("base64")}`;
  const html = readFileSync(path.join(dir, "index.html"), "utf8").replace(/[ \t]*<script\b[^>]*>\s*<\/script>[ \t]*\n?/gi, "");
  if (!html.includes("<body></body>") || /<script\b/i.test(html)) throw new Error("SIGN_HOST's index.html has changed; the stand-in cannot be placed");
  const page = html.replace("<body></body>", `<body><script src="/stand-in.js" integrity="${integrity}" crossorigin="anonymous"></script></body>`);
  writeFileSync(path.join(dir, "index.html"), page);
  return dir;
}

// ------------------------------------------------------------------------------------------------ the page reads
// APP_HOST only: every change of the probe's locked control with the signing page's state at that moment, and errors
const INIT = () => {
  if (window.top !== window || location.hostname !== "confidential.unrealized.trade") return;
  const tl = [];
  const errs = [];
  const clicks = [];
  Object.defineProperty(window, "__hop", { value: { tl, errs, clicks, persisted: false } });
  document.addEventListener("click", () => clicks.push({ t: performance.now(), y: Math.round(scrollY) }), true);
  addEventListener("pageshow", (e) => (window.__hop.persisted = e.persisted));
  document.addEventListener("securitypolicyviolation", (e) => errs.push(`CSP ${e.violatedDirective} ${e.blockedURI}`));
  new MutationObserver(() => {
    const m = document.querySelector("main[data-route]");
    const v = m ? m.dataset.locked : null;
    const sp = document.documentElement.dataset.signpage ?? null;
    if (tl.at(-1)?.v !== v || tl.at(-1)?.sp !== sp) tl.push({ v, sp, route: m?.dataset.route ?? null, t: performance.now() });
  }).observe(document, { attributes: true, subtree: true, childList: true, attributeFilter: ["data-locked", "data-signpage", "data-route"] });
};

const READ_APP = () => {
  const m = document.querySelector("main[data-route]");
  return {
    url: location.pathname + location.search + location.hash,
    route: m?.dataset.route ?? null,
    sheet: m?.dataset.sheet ?? null,
    note: m?.dataset.note ?? null,
    restored: m?.dataset.restored ?? null,
    locked: m?.dataset.locked ?? null,
    error: m?.dataset.error ?? null,
    scroll: Math.round(scrollY),
    record: sessionStorage.getItem("ct.return-hop"),
    signpage: document.documentElement.dataset.signpage ?? null,
    nav: performance.getEntriesByType("navigation")[0]?.type ?? null,
    hop: window.__hop ? { tl: window.__hop.tl, errs: window.__hop.errs, persisted: window.__hop.persisted } : null,
  };
};

const READ_SIGN = () => ({ origin: location.origin, url: location.href, flow: document.documentElement.dataset.flow ?? null, opens: document.documentElement.dataset.opens ?? null, loads: document.documentElement.dataset.loads ?? null });

const onApp = (u) => u.origin === APP;
const onSign = (u) => u.origin === SIGN;

async function ready(page) {
  await page.waitForFunction(() => document.documentElement.dataset.signpage === "ready", null, { timeout: 8_000, polling: 50 });
}

// ------------------------------------------------------------------------------------------------ the runs
async function hopRun(h, w, k, mode, shots, lines) {
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${w.name} ${k.kind} ${mode}: ${text}`);
  const { context, rec } = await h.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && pageErrors.push(m.text()));
  try {
    await page.goto(APP + k.from, { waitUntil: "load" });
    await ready(page);
    await page.click("[data-open-sheet]");
    const note = `n-${k.key}-${mode}-${w.name}`;
    await page.fill("[data-note-input]", note);
    const sel = `[data-control="${k.control}"]`;
    await page.click(sel);
    // the tapped control is locked at once (timed in the page, from the tap to the change), and a second tap does nothing
    const lock = await page.evaluate(
      ([s, c]) => {
        const at = window.__hop.clicks.at(-1);
        const ch = window.__hop.tl.find((e) => e.v === c && e.t >= at.t);
        return { disabled: document.querySelector(s)?.disabled ?? null, locked: document.querySelector("main")?.dataset.locked ?? null, ms: ch ? ch.t - at.t : null, y: at.y };
      },
      [sel, k.control],
    );
    const lockMs = lock.ms === null ? Infinity : Math.round(lock.ms);
    const scrollLeft = lock.y;
    await page.evaluate((s) => document.querySelector(s)?.click(), sel).catch(() => {});
    say(lock.disabled === true && lock.locked === k.control && lockMs <= 100, `control locked ${lock.disabled ? `${lockMs} ms after the tap` : "NOT"} (data-locked ${lock.locked})`);
    await page.waitForURL(onSign, { timeout: 8_000 });
    await page.waitForFunction(() => document.getElementById("done") !== null, null, { timeout: 5_000 });
    let sign = await page.evaluate(READ_SIGN);
    say(sign.url === `${SIGN}/`, `the tab is on SIGN_HOST with nothing in the URL (${sign.url})`);
    say(sign.flow === k.kind && sign.opens === "1", `SIGN_HOST reads the flow ${sign.flow}, ${sign.opens} open request(s) for two taps`);
    if (mode === "return") await page.screenshot({ path: path.join(shots, `${w.name}-${k.key}-1-sign.png`) });
    if (mode === "reload") {
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => document.getElementById("done") !== null, null, { timeout: 5_000 });
      sign = await page.evaluate(READ_SIGN);
      say(sign.loads === "2" && sign.flow === k.kind, `reload in the middle of the hop: SIGN_HOST load ${sign.loads}, flow ${sign.flow}`);
    }
    if (mode === "back") await page.goBack({ waitUntil: "load" });
    else await page.click("#done");
    await page.waitForURL((u) => onApp(u) && u.pathname === k.from, { timeout: 8_000 });
    await page.waitForFunction((r) => document.querySelector("main")?.dataset.route === r, k.route, { timeout: 5_000 });
    const first = await page.evaluate(READ_APP);
    await ready(page).catch(() => {});
    await page.waitForFunction(() => document.querySelector("main")?.dataset.locked === "", null, { timeout: 3_000 }).catch(() => {});
    const app = await page.evaluate(READ_APP);
    const how = mode === "back" ? `Back (${app.nav}${app.hop?.persisted ? ", from the back-forward cache" : ""})` : `return path /return/${k.key}`;
    say(app.url === k.from && app.route === k.route, `${how} lands on ${app.url} (${app.route}), the route left`);
    say(first.sheet === "probe-sheet" && first.note === note && first.restored === k.control, `sheet ${first.sheet}, field "${first.note}", control ${first.restored} restored`);
    say(scrollLeft >= 200 && Math.abs(first.scroll - scrollLeft) <= 2, `scroll ${first.scroll}, left at ${scrollLeft} at the tap`);
    // locked from the first frame of the return until the signing page answered, then free
    const tl = app.hop?.tl ?? [];
    const firstSeen = tl.find((e) => e.route === k.route);
    const freed = tl.find((e) => e.route === k.route && e.v === "");
    const lockedOk = app.hop?.persisted
      ? app.locked === ""
      : firstSeen?.v === k.control && freed !== undefined && freed.sp !== "connecting" && tl.filter((e) => e.t < freed.t && e.route === k.route).every((e) => e.v === k.control);
    say(lockedOk && app.locked === "", app.hop?.persisted ? `control free after the cached page came back` : `control locked on return until the signing page was ${freed?.sp ?? "never"}, then free`);
    say(app.record === null, `the record is gone after the return (${app.record === null ? "deleted on read" : "STILL THERE"})`);
    say(rec.pages.length === 1, `one tab from first to last (${rec.pages.length})`);
    const errs = [...pageErrors, ...(app.hop?.errs ?? [])];
    say(errs.length === 0, errs.length ? `errors: ${errs.join("; ")}` : "no page error, no CSP violation");
    if (mode === "return") await page.screenshot({ path: path.join(shots, `${w.name}-${k.key}-2-back.png`) });
  } catch (e) {
    say(false, `run stopped: ${String(e).split("\n")[0]}`);
  } finally {
    await context.close();
  }
}

/**
 * A tap that SIGN_HOST refuses, fails or never answers (card app-hop-refused): the tab stays on the screen, the sheet
 * or menu stays open, the control is unlocked, and one line shows in place of the outcome, with Retry when a retry can
 * work; a Retry sends the kind again. Never a pop-up, never a silent no-op.
 */
async function failRun(h, w, t, f, shots, lines) {
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${w.name} ${t.name} ${f.mode}: ${text}`);
  const { context, rec } = await h.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
  await context.addInitScript(INIT);
  await context.addInitScript(
    ([sign, cfg]) => {
      if (location.origin === sign) Object.defineProperty(self, "__standIn", { value: cfg });
    },
    [SIGN, { mode: f.mode, signedIn: t.signedIn }],
  );
  const page = await context.newPage();
  const pageErrors = [];
  const dialogs = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && pageErrors.push(m.text()));
  page.on("dialog", (d) => {
    dialogs.push(d.type());
    d.dismiss().catch(() => {});
  });
  const opens = () => page.frames().find((fr) => fr.url().startsWith(SIGN))?.evaluate(() => localStorage.getItem("opens") ?? "0").catch(() => null) ?? null;
  const sel = `[data-control="${t.control}"]:visible`;
  const line = `[data-hop-failed="${t.control}"]:visible`;
  try {
    await page.goto(APP + t.from, { waitUntil: "load" });
    await ready(page);
    // reach the control as a user does
    if (t.place === "sheet") {
      await page.click(w.isMobile ? ".phh [data-header='S1.1']" : ".btn-signin");
      await page.waitForSelector("[data-sheet='signin']", { timeout: 3_000 });
    } else if (t.place === "menu" && !w.isMobile) {
      await page.click(".tbr .acct");
      await page.waitForSelector(".amenu[data-state='S1.16']:visible", { timeout: 3_000 });
    }
    const t0 = await page.evaluate(() => performance.now());
    await page.click(sel);
    const limit = (f.mode === "silent" ? OPEN_WINDOW_MS : 0) + SLACK_MS;
    const seen = await page
      .waitForSelector(line, { timeout: limit + 500 })
      .then(() => page.evaluate((t) => performance.now() - t, t0))
      .catch(() => null);
    const shot = path.join(shots, `${w.name}-${t.name}-${f.mode}.png`);
    await page.screenshot({ path: shot });
    say(seen !== null && seen <= limit, `the line shows ${seen === null ? "NEVER" : `${Math.round(seen)} ms after the tap`}, limit ${limit} ms`);
    if (seen === null) return;
    const read = await page.evaluate(
      ([l, place]) => {
        const el = [...document.querySelectorAll(`[data-hop-failed="${l}"]`)].find((e) => e.getClientRects().length > 0);
        const r = el.getBoundingClientRect();
        const box = place === "sheet" ? document.querySelector(".sgn-box") : place === "menu" ? [...document.querySelectorAll(".amenu")].find((e) => e.getClientRects().length > 0) : document.querySelector("main");
        const b = box?.getBoundingClientRect();
        const retry = el.querySelector("[data-hop-retry]");
        return {
          why: el.dataset.hopWhy ?? null,
          text: el.textContent,
          draft: el.querySelector("[data-draft-copy]") !== null,
          inView: r.top >= 0 && r.bottom <= innerHeight && r.width > 0,
          inPlace: !!b && r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
          retry: retry ? { disabled: retry.disabled } : null,
          locked: document.querySelector("main")?.dataset.locked ?? null,
          url: location.pathname,
          record: sessionStorage.getItem("ct.return-hop"),
        };
      },
      [t.control, t.place],
    );
    say(read.why === f.mode, `the line says why: data-hop-why ${read.why}, "${read.text}"${read.draft ? " (draft copy)" : ""}`);
    say(read.inView && read.inPlace, `the line is in place (${t.place}) and on screen`);
    say((read.retry !== null) === f.retry, `Retry ${read.retry ? "shown" : "not shown"}${f.retry ? "" : " (a retry cannot change the page's refusal)"}`);
    say(read.url === t.from && rec.pages.length === 1 && read.record === null, `the tab stays on ${read.url}, one tab, the return record ${read.record === null ? "removed" : "LEFT"}`);
    // unlocked, and on again once the signing page is READY (a silent hop takes the client down for its retry)
    const free = await page
      .waitForFunction((s) => document.querySelector("main")?.dataset.locked === "" && document.documentElement.dataset.signpage === "ready" && document.querySelector(s.replace(":visible", "")) && [...document.querySelectorAll(s.replace(":visible", ""))].some((e) => e.getClientRects().length > 0 && !e.disabled), sel, { timeout: 15_000, polling: 50 })
      .then(() => true)
      .catch(() => false);
    say(free, `the control is unlocked and on again${f.mode === "silent" ? " once the signing page is READY" : ""}`);
    const before = await opens();
    if (f.retry && free) {
      await page.click(`${line} [data-hop-retry]`);
      const again = await page
        .waitForFunction((c) => document.querySelector("main")?.dataset.locked === c, t.control, { timeout: 1_000, polling: 20 })
        .then(() => true)
        .catch(() => false);
      await page.waitForTimeout(200);
      const after = await opens();
      say(again && Number(after) === Number(before) + 1, `Retry sends the kind again (control locked ${again ? "yes" : "NO"}, open requests ${before} then ${after})`);
    } else {
      say(before === "1", `${before} open request for one tap`);
    }
    say(dialogs.length === 0, dialogs.length ? `pop-ups: ${dialogs.join(", ")}` : "no pop-up");
    const errs = [...pageErrors, ...((await page.evaluate(() => window.__hop?.errs ?? [])) ?? [])];
    say(errs.length === 0, errs.length ? `errors: ${errs.join("; ")}` : "no page error, no CSP violation");
  } catch (e) {
    say(false, `run stopped: ${String(e).split("\n")[0]}`);
  } finally {
    await context.close();
  }
}

const rec = (kind, key, over = {}) => ({ v: 1, kind, return_key: key, route: "portfolio", sheet: "probe-sheet", control: "hop-signin", fields: { note: "bad" }, scroll: 0, at: Date.now(), ...over });

async function badRun(h, w, name, record, landAt, shots, lines) {
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${w.name} bad return ${name}: ${text}`);
  const { context } = await h.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  try {
    await page.goto(`${APP}/terms`, { waitUntil: "load" });
    if (record !== undefined) await page.evaluate((r) => sessionStorage.setItem("ct.return-hop", r), typeof record === "string" ? record : JSON.stringify(record));
    await page.goto(APP + landAt, { waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("main[data-route]") !== null, null, { timeout: 5_000 });
    const app = await page.evaluate(READ_APP);
    say(app.url === "/discover" && app.route === "discover", `${landAt} lands on ${app.url} (${app.route})`);
    say(app.sheet === "" && app.note === "" && app.restored === "" && app.locked === "", `nothing restored, no control locked (sheet "${app.sheet}", field "${app.note}", locked "${app.locked}")`);
    say(app.record === null && pageErrors.length === 0, `record ${app.record === null ? "gone" : "LEFT"}, ${pageErrors.length ? pageErrors.join("; ") : "no page error"}`);
    if (name === "none") await page.screenshot({ path: path.join(shots, `${w.name}-bad-${name}.png`) });
  } catch (e) {
    say(false, `run stopped: ${String(e).split("\n")[0]}`);
  } finally {
    await context.close();
  }
}

/** Not a pass line: what a no-cors fetch of SIGN_HOST's index.html from APP_HOST gives (the precheck app.md §2.1 item 5 step 3 asks for). */
async function precheckRead(h) {
  const { context } = await h.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${APP}/terms`, { waitUntil: "load" });
    return await page.evaluate((u) => fetch(u, { mode: "no-cors", cache: "no-store" }).then((r) => `resolved (${r.type})`, (e) => `rejected (${e})`), `${SIGN}/index.html`);
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const plant = opt("--plant");
  const only = opt("--only");
  if (only && !["hop", "fail", "bad"].includes(only)) throw new Error(`no such part ${only}`);
  const part = (name) => !only || only === name;
  if (plant && plant !== "wrong-key") throw new Error(`no such plant ${plant}`);
  const shots = opt("--shots") ?? path.join(tmpdir(), `app-return-hop-${Date.now()}`);
  mkdirSync(shots, { recursive: true });
  const appDir = await buildProbe();
  let signDir = null;
  const h = await startHarness({
    realNames: true,
    edit: (sites) => {
      signDir = signSite(sites[HOSTS.sign].root, plant);
      sites[HOSTS.app] = { root: appDir, spa: true };
      sites[HOSTS.sign] = { root: signDir };
    },
  });
  const lines = [];
  let pre;
  const version = h.browser.version();
  try {
    if (part("hop")) for (const w of WIDTHS) for (const k of KINDS) for (const mode of MODES) await hopRun(h, w, k, mode, shots, lines);
    if (part("fail")) for (const w of WIDTHS) for (const t of TARGETS) for (const f of FAIL_MODES) await failRun(h, w, t, f, shots, lines);
    if (part("bad")) for (const w of WIDTHS) {
      await badRun(h, w, "none", undefined, "/return/signin", shots, lines);
      await badRun(h, w, "stale", rec("signin.open", "signin", { at: Date.now() - TTL_MS - 1_000 }), "/return/signin", shots, lines);
      await badRun(h, w, "another kind", rec("signin.open", "signin"), "/return/backup", shots, lines);
      await badRun(h, w, "garbled", "{\"v\":1,", "/return/signin", shots, lines);
      await badRun(h, w, "hand-edited query", rec("signin.open", "signin"), "/return/signin?next=//evil.ct.test", shots, lines);
      await badRun(h, w, "hand-edited path", rec("signin.open", "signin"), "/return/signin/x", shots, lines);
      await badRun(h, w, "another host", rec("signin.open", "signin", { route: "//evil.ct.test" }), "/return/signin", shots, lines);
    }
    pre = await precheckRead(h);
  } finally {
    await h.close();
    rmSync(appDir, { recursive: true, force: true });
    if (signDir) rmSync(signDir, { recursive: true, force: true });
  }
  for (const l of lines) console.log(l);
  console.log(`info: a no-cors fetch of ${SIGN}/index.html from APP_HOST ${pre}`);
  const ok = lines.length > 0 && lines.every((l) => l.startsWith("ok "));
  console.log(`app-return-hop: ${ok ? "PASS" : "FAIL"} (${lines.filter((l) => l.startsWith("ok ")).length}/${lines.length} ok${plant ? `, plant ${plant}` : ""}${only ? `, only ${only}` : ""}, Chromium ${version}, shots ${shots})`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`app-return-hop: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
