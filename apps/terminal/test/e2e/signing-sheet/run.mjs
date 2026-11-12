#!/usr/bin/env node
// SIGN_HOST's screens open as one sheet over the app (card signing-views-open-over-the-app), end to end in H-app on the
// shipped names: APP_HOST's build framed in SIGN_HOST's shell as live. Each view is opened from the app the way a user
// opens it, at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), each width a fresh device with a passkey with no PRF
// (the first run's no-PRF branch draws the 12 words):
//   signin   the app's sign-in sheet, the passkey way: SIGN_HOST's sign-in screen
//   words    Recovery code on it: the typed 12 words
//   backup   Create passkey: the 12 words (masked in the shot), then Saved
//   backup2  the account's Backup: the 12 words again, left by the scrim (1440) or Esc (390)
//   signout  the account's Sign out: the sign-out screen
//   choose   the app's sign-in sheet, the wallet way: New account or I already have one
//   existing I already have one: Use passkey or Recovery code; Cancel back
//   withdraw the account's Withdraw: the withdraw form
//   poolwithdraw  pool.withdraw as the portfolio's pool row sends it (PortfolioMount.tsx), posted from the app's own
//            document: the pool withdraw form (the harness holds no pool balance to draw the row)
//   thief    both withdraw forms again, opened from an app that takes the keyboard's focus every 5 ms from before the
//            open and reads every key, paste and text input it gets; the user taps To, types and pastes. The rule: the
//            app reads nothing (0 keys, no paste), To holds it all and has the focus, the frame out of the page
//            (packages/signpage/src/frame-cover.ts SEALED; the three engines: packages/signpage/scripts/focus-steal.e2e.mjs)
// held (DepositSheet's Withdraw on a held deposit) is not driven: it opens only on a held deposit in SIGN_HOST's own
// store, which the harness has none of; it is the withdraw form's path with the held op (src/main.ts openKind).
// Per view it records: the sheet's box on screen, the frame #app still in the page and visible (its box the window's)
// or out of it, the top window's path (never a bare page: the app's own route), the app's own document (a mark set in
// it before the first view) and its open sheet after the close. The verdict: every view draws in the sheet, the top
// path stays the app's, and a close (Esc, the x, the scrim, Cancel) comes back to the same app document with its state; a
// view with a field typed into (words, withdraw) or the 12 words shown (backup) has the frame out of the page while it
// shows (src/shell.ts seal) and the page's own ground under it (the dot logo, every layer loaded under SIGN_HOST's
// policy; packages/signpage/src/backdrop.ts drawSealedGround), every other view keeps it in the page, visible under the
// scrim, with no ground. A close by a tap (the x, the
// scrim, Saved, Cancel) is a double tap: its second tap, where the first was, lands on no app control (the frame stays
// inert for 500 ms after a close; src/shell.ts close), counted by the app document's own trusted pointerdowns.
// Then, under the choose sheet (the frame kept, its opening tap's activation fresh), the frame tries what a frame that
// holds an activation could: copy to the clipboard (execCommand and the Clipboard API), Picture-in-Picture and
// fullscreen, as SIGN_HOST's Permissions-Policy allows them to it (the Clipboard API, Picture-in-Picture and fullscreen
// must be refused; execCommand copy, which no policy governs, is read and not judged: no view that keeps the frame has a
// Copy); it takes the focus, and the sheet must take it back;
// and a key's timeStamp is read against performance.now (the shell's guard compares the two).
//   node apps/terminal/test/e2e/signing-sheet/run.mjs [--shots <dir>] [--record <file>] [--cpu <rate>] [--hold-paint <ms>]
//     PASS exit 0, FAIL exit 1, error 2. --cpu 4 slows the tab's CPU 4x (CDP Emulation.setCPUThrottlingRate); --hold-paint
//     300 keeps every APP_HOST document from painting until 300 ms after its load (its root display none until then), an
//     app slow to its first paint: a close's dim must still wait for it (src/shell.ts veil, the kit's painted).
// Needs the terminal's build (pnpm --filter terminal build). Records hold states and boxes only: never the 12 words.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addAuthenticator, cdpFor, HOSTS, REAL, startHarness } from "../../harness/harness.mjs";

export const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
/** The views with a field typed into: the frame is out of the page while they show. */
// the views the frame leaves the page before (packages/signpage/src/frame-cover.ts SEALED): a field typed into, or the 12 words
export const TYPED = new Set(["words", "withdraw", "poolwithdraw", "backup", "backup2"]);
// the closing controls a tap closes by: each is tapped twice, the second tap where the first was, as a double tap
const TAPPED = new Set(["x", "scrim", "saved", "cancel"]);
export const VIEWS = ["signin", "words", "choose", "existing", "backup", "backup2", "signout", "withdraw", "poolwithdraw"];
const ROUTE = "/discover";
const GUARD_MS = 600; // past SIGN_HOST's 500 ms activation guard (packages/signpage/src/guard.ts)
const WAIT_MS = 15_000;
const KEYS = "abcdefgh";
const PASTE = "PQR";
/** The withdraw forms the thief step opens again. */
export const THIEF = ["withdraw", "poolwithdraw"];

/** The verdict on one record: { ok, lines }. */
export function judge(rec) {
  const lines = [];
  for (const w of rec.widths) {
    for (const name of VIEWS) {
      const v = w.views[name];
      const tag = `${name} @${w.width}`;
      if (!v) {
        lines.push(`FAIL ${tag}: not reached (${w.error ?? "no record"})`);
        continue;
      }
      const bad = [];
      if (!v.sheet) bad.push("no sheet box on screen");
      if (v.topPath !== v.appPath) bad.push(`top path ${v.topPath}, the app's ${v.appPath}`);
      if (TYPED.has(name)) {
        if (v.frame !== "out") bad.push(`frame ${v.frame} under a typed view`);
        if (v.ground !== "logo") bad.push(`ground ${v.ground} under a typed view`);
      } else {
        if (v.frame !== "visible") bad.push(`frame ${v.frame}, not visible under the sheet`);
        if (v.ground !== "none") bad.push(`ground ${v.ground} under a kept frame`);
      }
      if (v.closed) {
        if (!v.closed.hidden) bad.push("the sheet did not close");
        if (!TYPED.has(name) && !v.closed.sameDoc) bad.push("a new app document after close: state lost");
        // a typed view's close: the sheet's dim stays until the new app document has painted, then fades
        const p = v.closed.paint;
        if (TYPED.has(name) && v.closed.hidden && (!p?.veil || p.fadeMs == null || p.firstPaintMs == null || p.fadeMs < p.firstPaintMs)) bad.push(`the dim faded before the app painted (${JSON.stringify(p ?? null)})`);
        if (!TYPED.has(name) && v.closed.appSheet !== v.appSheet) bad.push(`the app's sheet ${v.appSheet} became ${v.closed.appSheet}`);
        if (v.closed.topPath !== v.topPath) bad.push(`after close the top path is ${v.closed.topPath}`);
        if (TAPPED.has(v.closed.by) && v.closed.appTaps !== 0) bad.push(`the double tap's second tap landed in the app (${v.closed.appTaps ?? "not counted"})`);
      }
      lines.push(`${bad.length ? "FAIL" : "ok  "} ${tag}: frame ${v.frame}, ground ${v.ground}, top ${v.topPath}${v.closed ? `, closed by ${TAPPED.has(v.closed.by) ? "a double tap on " : ""}${v.closed.by}${v.closed.sameDoc ? " to the same app document" : " to a new app document"}${TAPPED.has(v.closed.by) ? `, ${v.closed.appTaps} tap(s) in the app` : ""}` : ""}${v.closed?.paint ? `, app painted ${v.closed.paint.firstPaintMs} ms (content ${v.closed.paint.contentPaintMs} ms) after the close, dim faded at ${v.closed.paint.fadeMs} ms` : ""}${bad.length ? ` (${bad.join("; ")})` : ""}`);
    }
    for (const name of THIEF) {
      const t = w.thief?.[name];
      if (!t) {
        lines.push(`FAIL thief ${name} @${w.width}: not run (${w.error ?? "no record"})`);
        continue;
      }
      const bad = [];
      if (t.leaked.length) bad.push(`the app read ${JSON.stringify(t.leaked)}`);
      if (t.value !== KEYS + PASTE) bad.push(`To holds "${t.value}"`);
      if (t.focus !== "to") bad.push(`the focus on ${t.focus}`);
      if (t.frame !== "out") bad.push(`frame ${t.frame}`);
      lines.push(`${bad.length ? "FAIL" : "ok  "} thief ${name} @${w.width}: an app taking the focus every 5 ms; To holds "${t.value}", the app read ${t.leaked.length ? JSON.stringify(t.leaked) : "nothing"}, frame ${t.frame}, focus ${t.focus}${bad.length ? ` (${bad.join("; ")})` : ""}`);
    }
    const b = w.probes;
    if (!b) lines.push(`FAIL frame probes @${w.width}: not run (${w.error ?? "no record"})`);
    else {
      const bad = [];
      if (b.policy.clipboardWrite !== false) bad.push("clipboard-write allowed to the frame");
      if (b.policy.pip !== false) bad.push("picture-in-picture allowed to the frame");
      if (b.policy.fullscreen !== false) bad.push("fullscreen allowed to the frame");
      if (b.activation !== true) bad.push("the frame held no activation, so the tries below prove nothing");
      // execCommand copy is not under Permissions-Policy: a frame holding an activation writes the clipboard under any
      // sheet that keeps it, as it can when the user taps the app with no sheet at all. Only the 12 words offer a Copy of
      // SIGN_HOST's own, and the frame is out under them (backup in TYPED, judged above), so it is read here, not judged.
      if (b.writeText !== "refused") bad.push(`Clipboard API write ${b.writeText}`);
      if (b.pip !== "refused") bad.push(`Picture-in-Picture ${b.pip}`);
      if (b.fullscreen !== "refused") bad.push(`fullscreen ${b.fullscreen}`);
      if (b.inert !== true) bad.push("the kept frame is not inert under the sheet");
      if (b.focusAfter !== "sheet") bad.push(`the focus after the frame took it: ${b.focusAfter}`);
      if (!(Math.abs(b.clockSkewMs) < 50)) bad.push(`a key's timeStamp is ${b.clockSkewMs} ms off performance.now`);
      lines.push(`${bad.length ? "FAIL" : "ok  "} frame probes @${w.width}: under the choose sheet, the frame with its tap's activation: execCommand copy ${b.execCopy}, Clipboard API ${b.writeText}${b.writeTextError ? ` (${b.writeTextError})` : ""}, Picture-in-Picture ${b.pip}${b.pipError ? ` (${b.pipError})` : ""}, fullscreen ${b.fullscreen}${b.fullscreenError ? ` (${b.fullscreenError})` : ""}; policy to the frame: clipboard-write ${b.policy.clipboardWrite}, picture-in-picture ${b.policy.pip}, fullscreen ${b.policy.fullscreen}; frame inert ${b.inert}; focus: the frame took it (${b.focusTaken}), then ${b.focusAfter} after ${b.focusAfterMs} ms (blur ${b.blurBefore ? "before" : "after"} the frame's focus event); a key's timeStamp ${b.clockSkewMs} ms off performance.now${bad.length ? ` (${bad.join("; ")})` : ""}`);
    }
  }
  return { ok: lines.every((l) => !l.startsWith("FAIL")), lines };
}

/** In the app's frame under a kept-frame sheet, right after the tap that opened it: what the frame can still do. */
async function probes(page) {
  const frame = page.frames().find((f) => f !== page.mainFrame() && new URL(f.url()).hostname === REAL.app);
  const top = await page.evaluate(() => {
    window.__blurAt = null;
    addEventListener("blur", () => (window.__blurAt ??= performance.now()), { once: true });
    return { inert: document.querySelector("iframe#app")?.inert === true };
  });
  const inFrame = await frame.evaluate(async () => {
    const allows = (f) => (document.featurePolicy ? document.featurePolicy.allowsFeature(f) : null);
    const policy = { clipboardWrite: allows("clipboard-write"), pip: allows("picture-in-picture"), fullscreen: allows("fullscreen") };
    const activation = navigator.userActivation?.isActive ?? null;
    const t = document.createElement("textarea");
    t.value = "probe";
    document.body.append(t);
    t.select();
    let execCopy;
    try {
      execCopy = document.execCommand("copy");
    } catch (e) {
      execCopy = `threw ${e.name}`;
    }
    t.remove();
    const tryIt = async (f) => {
      try {
        await f();
        return ["done", null];
      } catch (e) {
        return ["refused", `${e.name}: ${String(e.message).slice(0, 80)}`];
      }
    };
    const [writeText, writeTextError] = await tryIt(() => navigator.clipboard.writeText("probe"));
    const c = document.createElement("canvas");
    c.getContext("2d").fillRect(0, 0, 4, 4);
    const v = document.createElement("video");
    v.muted = true;
    v.srcObject = c.captureStream();
    document.body.append(v);
    await Promise.race([new Promise((ok) => v.addEventListener("loadedmetadata", ok, { once: true })), new Promise((ok) => setTimeout(ok, 1000))]);
    const [pip, pipError] = await tryIt(() => v.requestPictureInPicture());
    v.remove();
    const [fullscreen, fullscreenError] = await tryIt(() => document.documentElement.requestFullscreen());
    // the frame takes the focus as a frame under the sheet would, to read the keys typed next
    window.__focusAt = null;
    addEventListener("focus", () => (window.__focusAt ??= performance.timeOrigin + performance.now()), { once: true });
    window.focus();
    const b = document.querySelector("button");
    b?.focus();
    return { policy, activation, execCopy, writeText, writeTextError, pip, pipError, fullscreen, fullscreenError, focusTaken: document.hasFocus() };
  });
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => {
    const a = document.activeElement;
    return {
      focusAfter: a?.matches?.('#screen [data-sheet="box"]') ? "sheet" : a?.tagName === "IFRAME" ? "frame" : (a?.tagName ?? "none"),
      blurAt: window.__blurAt === null ? null : performance.timeOrigin + window.__blurAt,
    };
  });
  const focusAt = await frame.evaluate(() => window.__focusAt).catch(() => null);
  // a key's timeStamp against performance.now in the top window, the clock the shell's open is read on
  await page.evaluate(() => {
    window.__skew = null;
    addEventListener("keydown", (e) => void (window.__skew = Math.round(performance.now() - e.timeStamp)), { once: true, capture: true });
  });
  await page.keyboard.press("Shift");
  const clockSkewMs = await page.evaluate(() => window.__skew);
  return { ...top, ...inFrame, focusAfter: after.focusAfter, focusAfterMs: 100, blurBefore: after.blurAt !== null && focusAt !== null ? after.blurAt <= focusAt : null, clockSkewMs };
}

async function oneWidth(h, w, shotDir, { cpu = 1, holdPaint = 0 } = {}) {
  const out = { width: w.name, views: {} };
  const { context } = await h.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
  // --hold-paint: each APP_HOST document paints nothing until `ms` after its load
  if (holdPaint > 0)
    await context.addInitScript(({ host, ms }) => {
      if (location.hostname !== host) return;
      // an init script can run before the document has its root: hidden as soon as it has one
      const hide = () => document.documentElement.style.setProperty("display", "none", "important");
      if (document.documentElement) hide();
      else
        new MutationObserver((_, o) => {
          if (!document.documentElement) return;
          o.disconnect();
          hide();
        }).observe(document, { childList: true });
      addEventListener("load", () => setTimeout(() => document.documentElement.style.removeProperty("display"), ms), { once: true });
    }, { host: REAL.app, ms: holdPaint });
  // what an app document reads, reported from any frame (the thief step)
  const leaked = [];
  await context.exposeBinding("__ctLeak", (_src, k) => void leaked.push(String(k)));
  const page = await context.newPage();
  if (cpu > 1) await (await cdpFor(page)).send("Emulation.setCPUThrottlingRate", { rate: cpu });
  const auth = await addAuthenticator(page, { hasPrf: false });
  const app = page.frameLocator("iframe#app");
  const vis = (sel) => app.locator(`${sel} >> visible=true`).first();
  const top = (sel) => page.locator(sel).first();
  const tap = async (loc) => (w.hasTouch ? loc.tap() : loc.click());
  const shot = (name, mask = []) => page.screenshot({ path: path.join(shotDir, `${name}-${w.name}.png`), mask });
  const appDoc = () => app.locator(":root").evaluate(() => ({ mark: window.__sheetMark ?? null, path: location.pathname, sheet: document.querySelector("[data-sheet]")?.getAttribute("data-sheet") ?? null })).catch(() => null);
  let mark = 0;
  const newMark = async () => {
    mark += 1;
    const m = mark;
    await app.locator(":root").evaluate((_, n) => void (window.__sheetMark = n), m);
    return m;
  };
  /** The view on the sheet now: the sheet's box, the frame, the top path, the app's document. */
  const look = async (name, m, mask = []) => {
    // the screen shown (a build before the sheet draws it as a page of its own: shot and judged all the same)
    await top("#screen:not([hidden])").waitFor({ timeout: WAIT_MS });
    await page.waitForTimeout(250); // the screen settled
    const v = await page.evaluate(() => {
      const box = document.querySelector("#screen [data-sheet=box]");
      const b = box?.getBoundingClientRect();
      const f = document.querySelector("iframe#app");
      const fb = f?.getBoundingClientRect();
      const fs = f ? getComputedStyle(f) : null;
      return {
        sheet: Boolean(b && b.width > 0 && b.height > 0 && !document.querySelector("#screen").hidden),
        frame: !f ? "out" : fb.width >= innerWidth && fb.height >= innerHeight && fs.visibility === "visible" && fs.display !== "none" && Number(fs.opacity) > 0 ? "visible" : "hidden",
        topPath: location.pathname,
        // the sealed screens' ground: "none" (hidden or absent), or shown with its logo's layers loaded or not
        ground: (() => {
          const g = document.querySelector("#ground");
          if (!g || g.hidden || getComputedStyle(g).display === "none") return "none";
          const imgs = [...g.querySelectorAll("img")];
          return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0) ? "logo" : "no logo";
        })(),
      };
    });
    const d = v.frame === "out" ? null : await appDoc();
    out.views[name] = { ...v, appPath: d?.path ?? v.topPath, appSheet: d?.sheet ?? null, mark: m };
    await shot(`${name}-open`, mask);
    return out.views[name];
  };
  const closed = async (name, by) => {
    const v = out.views[name];
    // past the activation guard's window from the open: a close within it is the opening tap's own (src/shell.ts dismiss)
    await page.waitForTimeout(GUARD_MS);
    // a typed view's close: when the sheet went, when its dim faded, measured against the new app document's first paint
    if (TYPED.has(name))
      await page.evaluate(() => {
        const t = () => performance.timeOrigin + performance.now();
        const at = (window.__closeAt = {});
        const screen = document.querySelector("#screen");
        const veil = document.querySelector('[data-sheet="veil"]');
        new MutationObserver(() => {
          if (screen.hidden && at.sheet === undefined) at.sheet = t();
          if (veil && !veil.hidden && veil.style.opacity === "1" && at.veil === undefined) at.veil = t();
          if (veil && veil.style.opacity === "0" && at.fade === undefined) at.fade = t();
        }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["hidden", "style"] });
      });
    if (TAPPED.has(by)) await countAppTaps();
    if (by === "esc") await page.keyboard.press("Escape");
    else {
      // a double tap: the second where the first was, 120 ms after it, as a finger's or a mouse's double tap
      const sel = { x: '#screen [data-sheet="close"]', saved: '#signin button[data-action="saved"]', cancel: '#signin button[data-action="cancel"]' }[by];
      const bb = sel ? await top(sel).boundingBox() : null;
      const at = bb ? { x: Math.round(bb.x + bb.width / 2), y: Math.round(bb.y + bb.height / 2) } : { x: 4, y: Math.round(w.viewport.height / 2) };
      const one = () => (w.hasTouch ? page.touchscreen.tap(at.x, at.y) : page.mouse.click(at.x, at.y));
      await one();
      await page.waitForTimeout(120);
      await one();
    }
    const shut = await top("#screen").waitFor({ state: "hidden", timeout: 3_000 }).then(() => true, () => false);
    if (!shut) {
      // no such close on this build: recorded as not closed, then its own Cancel, so the run goes on to the next view
      v.closed = { by, hidden: false, sameDoc: false, appSheet: null, topPath: new URL(page.url()).pathname };
      await tap(top('#signin button[data-action="cancel"]'));
      await top("#screen").waitFor({ state: "hidden", timeout: WAIT_MS });
      await app.locator(':root[data-signpage="ready"]').waitFor({ state: "attached", timeout: WAIT_MS });
      await page.waitForTimeout(400);
      await shot(`${name}-closed`);
      return;
    }
    await app.locator(':root[data-signpage="ready"]').waitFor({ state: "attached", timeout: WAIT_MS });
    await page.waitForTimeout(400);
    const d = await appDoc();
    v.closed = { by, hidden: await top("#screen").isHidden(), sameDoc: d?.mark === v.mark, appSheet: d?.sheet ?? null, topPath: new URL(page.url()).pathname };
    if (TAPPED.has(by)) v.closed.appTaps = await app.locator(":root").evaluate(() => window.__appTaps ?? null).catch(() => null);
    if (TYPED.has(name)) {
      const at = await page.evaluate(() => window.__closeAt ?? {});
      const paint = await app.locator(":root").evaluate(() => {
        const p = (n) => performance.getEntriesByName(n)[0]?.startTime;
        const fp = p("first-paint");
        const fcp = p("first-contentful-paint");
        return { fp: fp === undefined ? null : performance.timeOrigin + fp, fcp: fcp === undefined ? null : performance.timeOrigin + fcp };
      });
      const ms = (x) => (x == null || at.sheet == null ? null : Math.round(x - at.sheet));
      v.closed.paint = { veil: at.veil != null, firstPaintMs: ms(paint.fp), contentPaintMs: ms(paint.fcp), fadeMs: ms(at.fade) };
    }
    await shot(`${name}-closed`);
  };
  // the app documents' own trusted pointerdowns, from each document's start (a new one after a typed view's close too)
  await context.addInitScript((host) => {
    if (location.hostname !== host) return;
    window.__appTaps = 0;
    addEventListener("pointerdown", (e) => void (e.isTrusted && (window.__appTaps += 1)), true);
  }, REAL.app);
  const countAppTaps = () => app.locator(":root").evaluate(() => void (window.__appTaps = 0)).catch(() => {});
  const account = async (control) => {
    if (w.name === "390") {
      if (!(await vis(`.amenu [data-control="${control}"]`).isVisible().catch(() => false))) await tap(vis('a[href="/profile"]'));
    } else await tap(vis(".tb .acct"));
    await tap(vis(`[data-control="${control}"]`));
  };

  try {
    await page.goto(`https://${REAL.app}${ROUTE}`, { waitUntil: "commit" });
    await page.waitForURL((u) => u.hostname === REAL.sign, { timeout: WAIT_MS });
    await app.locator(':root[data-signpage="ready"]').waitFor({ state: "attached", timeout: WAIT_MS });
    const signIn = vis('[data-header="S1.1"] button, button[data-header="S1.1"]');
    await signIn.waitFor({ timeout: WAIT_MS });
    await page.waitForTimeout(800);
    await shot("app-discover");

    // signin: the app's own sign-in sheet, then the passkey way; Esc back to the app's sheet as it was
    let m = await newMark();
    await tap(signIn);
    await vis('.sgn[data-state="S2.1"] .sgn-box').waitFor({ timeout: WAIT_MS });
    await page.waitForTimeout(300);
    await tap(vis('.sgn-opt[data-way="passkey"]'));
    await look("signin", m);
    await closed("signin", "esc");

    // words: the passkey way again (the app's sign-in sheet again first where a close lost it), Recovery code; the x back
    m = await newMark();
    if (!(await vis('.sgn-opt[data-way="passkey"]').isVisible().catch(() => false))) await tap(signIn);
    await tap(vis('.sgn-opt[data-way="passkey"]'));
    await top('#screen:not([hidden]) #signin[data-signin="signed-out"] button[data-action="recovery"]').waitFor({ timeout: WAIT_MS });
    await tap(top('#signin button[data-action="recovery"]'));
    await top('#signin[data-signin="words"]').waitFor({ timeout: WAIT_MS });
    await look("words", m);
    await closed("words", "x");

    // choose and existing: the wallet way, then I already have one; Esc back
    m = await newMark();
    if (!(await vis('.sgn-opt[data-way="wallet"]').isVisible().catch(() => false))) await tap(signIn);
    await tap(vis('.sgn-opt[data-way="wallet"]'));
    await top('#screen:not([hidden]) #signin[data-signin="choose"]').waitFor({ timeout: WAIT_MS });
    await look("choose", m);
    out.probes = await probes(page);
    await page.waitForTimeout(GUARD_MS);
    await tap(top('#signin[data-signin="choose"] button[data-action="have-one"]'));
    await top('#screen:not([hidden]) #signin[data-signin="existing"]').waitFor({ timeout: WAIT_MS });
    await look("existing", m);
    await closed("existing", "cancel");

    // backup: the passkey way, Create passkey (no PRF): the 12 words, masked; Saved back, signed in
    m = await newMark();
    await vis('.sgn[data-state="S2.1"] .sgn-box').waitFor({ state: "attached", timeout: WAIT_MS }).catch(() => {});
    if (!(await vis('.sgn-opt[data-way="passkey"]').isVisible().catch(() => false))) await tap(signIn);
    await tap(vis('.sgn-opt[data-way="passkey"]'));
    await top('#screen:not([hidden]) #signin[data-signin="signed-out"] button[data-action="create"]').waitFor({ timeout: WAIT_MS });
    await tap(top('#signin button[data-action="create"]'));
    const list = top('#screen:not([hidden]) #signin[data-signin="backup"] [data-words="12"]');
    await list.waitFor({ timeout: WAIT_MS });
    await look("backup", m, [list]);
    await closed("backup", "saved");
    await vis('[data-header="S1.3"], [data-header="S1.4"]').waitFor({ timeout: WAIT_MS });

    // backup2: the account's Backup, the scrim back (a desktop width) or Esc
    // the mark before the tap: a sealed screen takes the frame out in the open's own task
    m = await newMark();
    await account("acct-backup");
    const list2 = top('#screen:not([hidden]) #signin[data-signin="backup"] [data-words="12"]');
    await list2.waitFor({ timeout: WAIT_MS });
    await look("backup2", m, [list2]);
    await closed("backup2", w.name === "1440" ? "scrim" : "esc");

    // signout: the account's Sign out, the x back
    // the mark before the tap: a sealed screen takes the frame out in the open's own task
    m = await newMark();
    await account("acct-signout");
    await top('#screen:not([hidden]) #signin[data-signin="signout"]').waitFor({ timeout: WAIT_MS });
    await look("signout", m);
    await closed("signout", "x");

    // withdraw: the account's Withdraw, Esc back
    // the mark before the tap: a sealed screen takes the frame out in the open's own task
    m = await newMark();
    await account("acct-withdraw");
    await top('#screen:not([hidden]) #signin[data-signin="withdraw"]').waitFor({ timeout: WAIT_MS });
    await look("withdraw", m);
    await closed("withdraw", "esc");

    // poolwithdraw: pool.withdraw from the app's own document, as the portfolio's pool row sends it; the x back
    await page.waitForTimeout(400);
    m = await newMark();
    await app.locator(":root").evaluate(() => window.parent.postMessage({ v: 1, id: crypto.randomUUID(), type: "pool.withdraw", chain: "solana", return_key: "portfolio" }, "*"));
    await top('#screen:not([hidden]) #signin[data-signin="pool-withdraw"]').waitFor({ timeout: WAIT_MS });
    await look("poolwithdraw", m);
    await closed("poolwithdraw", "x");

    // thief: each withdraw form opened again from an app that takes the focus every 5 ms from before the open
    out.thief = {};
    for (const name of THIEF) {
      await page.waitForTimeout(400);
      await app.locator(":root").evaluate(() => {
        addEventListener("keydown", (e) => void window.__ctLeak(e.key), true);
        addEventListener("paste", (e) => void window.__ctLeak(`paste:${e.clipboardData?.getData("text") ?? ""}`), true);
        addEventListener("beforeinput", (e) => void (e.data && window.__ctLeak(`input:${e.data}`)), true);
        setInterval(() => (window.focus(), document.querySelector("input, button, a")?.focus()), 5);
      });
      leaked.length = 0;
      if (name === "withdraw") await account("acct-withdraw");
      else await app.locator(":root").evaluate(() => window.parent.postMessage({ v: 1, id: crypto.randomUUID(), type: "pool.withdraw", chain: "solana", return_key: "portfolio" }, "*"));
      const state = name === "withdraw" ? "withdraw" : "pool-withdraw";
      await top(`#screen:not([hidden]) #signin[data-signin="${state}"]`).waitFor({ timeout: WAIT_MS });
      await page.waitForTimeout(GUARD_MS);
      await tap(top('#signin input[data-input="to"]'));
      await page.keyboard.type(KEYS, { delay: 30 });
      await page.keyboard.insertText(PASTE);
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => {
        const a = document.activeElement;
        return { frame: document.querySelector("iframe#app") ? "in" : "out", value: document.querySelector('#signin input[data-input="to"]')?.value ?? null, focus: a?.matches?.('input[data-input="to"]') ? "to" : a?.tagName === "IFRAME" ? "frame" : (a?.tagName ?? "none") };
      });
      out.thief[name] = { ...after, leaked: [...leaked] };
      await shot(`thief-${name}-open`);
      await page.keyboard.press("Escape");
      await top("#screen").waitFor({ state: "hidden", timeout: WAIT_MS });
      await app.locator(':root[data-signpage="ready"]').waitFor({ state: "attached", timeout: WAIT_MS });
    }
  } catch (e) {
    out.error = String(e.message ?? e).split("\n")[0];
    await shot("error").catch(() => {});
  } finally {
    await auth.remove().catch(() => {});
    await context.close();
  }
  return out;
}

export async function run({ shots, cpu = 1, holdPaint = 0 }) {
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const h = await startHarness({ realNames: true, edit: (sites) => (sites[HOSTS.sign].spa = true) });
  const rec = { browser: h.browser.version(), widths: [] };
  try {
    for (const w of WIDTHS) rec.widths.push(await oneWidth(h, w, shots, { cpu, holdPaint }));
  } finally {
    await h.close();
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (k, d) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const temp = opt("--shots", null) ? null : mkdtempSync(path.join(tmpdir(), "ct-signing-sheet-"));
  const shots = path.resolve(opt("--shots", temp));
  let rec;
  try {
    rec = await run({ shots, cpu: Number(opt("--cpu", "1")), holdPaint: Number(opt("--hold-paint", "0")) });
  } catch (e) {
    console.error(`ERROR signing-sheet: ${e.stack ?? e}`);
    process.exit(2);
  }
  const file = opt("--record", null);
  if (file) writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  if (temp) rmSync(temp, { recursive: true, force: true });
  const v = judge(rec);
  for (const l of v.lines) console.log(l);
  console.log(`${v.ok ? "PASS" : "FAIL"} signing-sheet on Chromium ${rec.browser}${temp ? "" : `; shots in ${shots}`}`);
  process.exit(v.ok ? 0 : 1);
}
