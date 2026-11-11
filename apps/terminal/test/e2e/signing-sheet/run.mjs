#!/usr/bin/env node
// SIGN_HOST's screens open as one sheet over the app (card signing-views-open-over-the-app), end to end in H-app on the
// shipped names: APP_HOST's build framed in SIGN_HOST's shell as live. Each view is opened from the app the way a user
// opens it, at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), each width a fresh device with a passkey with no PRF
// (the first run's no-PRF branch draws the 12 words):
//   signin   the app's sign-in sheet, the passkey way: SIGN_HOST's sign-in screen
//   words    Recovery code on it: the typed 12 words
//   backup   Create passkey: the 12 words (masked in the shot), then Saved
//   backup2  the account's Backup: the 12 words again, left by Esc
//   signout  the account's Sign out: the sign-out screen
//   withdraw the account's Withdraw: the withdraw form
// Per view it records: the sheet's box on screen, the frame #app still in the page and visible (its box the window's)
// or out of it, the top window's path (never a bare page: the app's own route), the app's own document (a mark set in
// it before the first view) and its open sheet after the close. The verdict: every view draws in the sheet, the top
// path stays the app's, and a close (Esc, the x, the scrim) comes back to the same app document with its state; a view
// with a field typed into (words, withdraw) has the frame out of the page while it shows (src/shell.ts seal), every
// other view keeps it in the page, visible under the scrim.
//   node apps/terminal/test/e2e/signing-sheet/run.mjs [--shots <dir>] [--record <file>]   PASS exit 0, FAIL exit 1, error 2
// Needs the terminal's build (pnpm --filter terminal build). Records hold states and boxes only: never the 12 words.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addAuthenticator, HOSTS, REAL, startHarness } from "../../harness/harness.mjs";

export const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
/** The views with a field typed into: the frame is out of the page while they show. */
export const TYPED = new Set(["words", "withdraw"]);
export const VIEWS = ["signin", "words", "backup", "backup2", "signout", "withdraw"];
const ROUTE = "/discover";
const GUARD_MS = 600; // past SIGN_HOST's 500 ms activation guard (packages/signpage/src/guard.ts)
const WAIT_MS = 15_000;

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
      } else if (v.frame !== "visible") bad.push(`frame ${v.frame}, not visible under the sheet`);
      if (v.closed) {
        if (!v.closed.hidden) bad.push("the sheet did not close");
        if (!TYPED.has(name) && !v.closed.sameDoc) bad.push("a new app document after close: state lost");
        if (!TYPED.has(name) && v.closed.appSheet !== v.appSheet) bad.push(`the app's sheet ${v.appSheet} became ${v.closed.appSheet}`);
        if (v.closed.topPath !== v.topPath) bad.push(`after close the top path is ${v.closed.topPath}`);
      }
      lines.push(`${bad.length ? "FAIL" : "ok  "} ${tag}: frame ${v.frame}, top ${v.topPath}${v.closed ? `, closed by ${v.closed.by}${v.closed.sameDoc ? " to the same app document" : " to a new app document"}` : ""}${bad.length ? ` (${bad.join("; ")})` : ""}`);
    }
  }
  return { ok: lines.every((l) => !l.startsWith("FAIL")), lines };
}

async function oneWidth(h, w, shotDir) {
  const out = { width: w.name, views: {} };
  const { context } = await h.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
  const page = await context.newPage();
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
    await page.waitForTimeout(250); // past FRAME_LEAVE_MS
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
      };
    });
    const d = v.frame === "out" ? null : await appDoc();
    out.views[name] = { ...v, appPath: d?.path ?? v.topPath, appSheet: d?.sheet ?? null, mark: m };
    await shot(`${name}-open`, mask);
    return out.views[name];
  };
  const closed = async (name, by) => {
    const v = out.views[name];
    if (by === "esc") await page.keyboard.press("Escape");
    else if (by === "x") await tap(top('#screen [data-sheet="close"]')).catch(() => {});
    else await page.mouse.click(4, Math.round(w.viewport.height / 2));
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
    await shot(`${name}-closed`);
  };
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
    await page.waitForTimeout(GUARD_MS);
    await tap(top('#signin[data-signin="backup"] button[data-action="saved"]'));
    await top("#screen").waitFor({ state: "hidden", timeout: WAIT_MS });
    await vis('[data-header="S1.3"], [data-header="S1.4"]').waitFor({ timeout: WAIT_MS });
    await page.waitForTimeout(400);
    const d = await appDoc();
    out.views.backup.closed = { by: "saved", hidden: true, sameDoc: d?.mark === m, appSheet: d?.sheet ?? null, topPath: new URL(page.url()).pathname };
    // the app's sign-in sheet closes on its own once signed in: the same document, its own sheet's end
    out.views.backup.appSheet = out.views.backup.closed.appSheet;
    await shot("backup-closed");

    // backup2: the account's Backup, the scrim back (a desktop width) or Esc
    await account("acct-backup");
    m = await newMark();
    const list2 = top('#screen:not([hidden]) #signin[data-signin="backup"] [data-words="12"]');
    await list2.waitFor({ timeout: WAIT_MS });
    await look("backup2", m, [list2]);
    await closed("backup2", w.name === "1440" ? "scrim" : "esc");

    // signout: the account's Sign out, the x back
    await account("acct-signout");
    m = await newMark();
    await top('#screen:not([hidden]) #signin[data-signin="signout"]').waitFor({ timeout: WAIT_MS });
    await look("signout", m);
    await closed("signout", "x");

    // withdraw: the account's Withdraw, Esc back
    await account("acct-withdraw");
    m = await newMark();
    await top('#screen:not([hidden]) #signin[data-signin="withdraw"]').waitFor({ timeout: WAIT_MS });
    await look("withdraw", m);
    await closed("withdraw", "esc");
  } catch (e) {
    out.error = String(e.message ?? e).split("\n")[0];
    await shot("error").catch(() => {});
  } finally {
    await auth.remove().catch(() => {});
    await context.close();
  }
  return out;
}

export async function run({ shots }) {
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const h = await startHarness({ realNames: true, edit: (sites) => (sites[HOSTS.sign].spa = true) });
  const rec = { browser: h.browser.version(), widths: [] };
  try {
    for (const w of WIDTHS) rec.widths.push(await oneWidth(h, w, shots));
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
    rec = await run({ shots });
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
