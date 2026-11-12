#!/usr/bin/env node
// The sign-in screens' shots and checks (card app-signin-screens; AS-01/AS-02, app.md:1370-1375): the fixture page
// (fixtures.tsx) built with vite and served on 127.0.0.1, every state at 390 x 844 (dpr 2, touch) and 1440 x 900
// (dpr 1), in the dark and light colour schemes (the terminal is dark only; the light run proves it stays so). Per shot:
// the state's marker is on screen, no horizontal scroll, and the draft words drawn are listed. Behaviour checks: each way
// in posts signin.open with its way, signed out offers no menu, a restore seen running ends on S19.3, and closing it
// leaves S1.4.
//   node apps/terminal/test/signin-screens/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";
import { launchHarnessBrowser } from "../../../../scripts/harness-sockets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const SCHEMES = ["dark", "light"];
const hdr = (w) => (w === "390" ? ".phh [data-header]" : ".tb [data-header]");

// id, fixture, path, steps before the shot, the marker that must show
const SHOTS_LIST = [
  { id: "S1.1-signed-out", f: "out", expect: (w) => `${hdr(w)}[data-header="S1.1"]` },
  { id: "S2.1-sheet", f: "out", act: "signin", expect: () => '.sgn[data-state="S2.1"]' },
  { id: "S2.1-no-prf", f: "out-noprf", act: "signin", expect: () => '.sgn[data-state="S2.1"]' },
  { id: "S2.1-signpage-down", f: "out-down", act: "signin", expect: () => ".sgn-opt:disabled" },
  { id: "S1.2-loading", f: "loading", expect: (w) => `${hdr(w)}[data-header="S1.2"]` },
  { id: "S1.3-new-account-backup-dot", f: "new-unsaved", expect: (w) => (w === "390" ? '.phh [data-header="S1.3"]' : ".acct [data-backup-dot]") },
  { id: "S1.3-new-account-after-backup", f: "new-saved", expect: (w) => `${hdr(w)}[data-header="S1.3"]` },
  { id: "S1.4-balance", f: "balance", expect: (w) => `${hdr(w)}[data-header="S1.4"]` },
  { id: "S1.16-menu", f: "new-unsaved", act: "menu", expect: () => '.amenu [data-control="acct-backup"]' },
  { id: "S1.16-menu-wallet", f: "wallet-new", act: "menu", expect: () => ".amenu [data-wallet-label]" },
  // S19 (card restore-notice-redraw, direction A): each state's dot mark, its amount and its one word (none when done)
  { id: "S19.1-scanning", f: "scanning", expect: () => '.sgn[data-state="S19.1"]', s19: { mark: "run", bal: "$0.00", word: "Restoring" } },
  { id: "S19.2-growing", f: "growing", expect: () => '.sgn[data-state="S19.1"] [data-balance="$41.06"]', s19: { mark: "run", bal: "$41.06", word: "Restoring" } },
  { id: "S19.3-done", f: "growing", to: ["done"], expect: () => '.sgn[data-state="S19.3"]', s19: { mark: "done", bal: "$73.18", word: null } },
  { id: "S19.4-nothing-found", f: "scanning", to: ["nothing"], expect: () => '.sgn[data-state="S19.4"]', s19: { mark: "nothing", bal: "$0.00", word: "Nothing found" } },
  { id: "S19.5-offline", f: "offline", expect: () => '.sgn[data-state="S19.5"]', s19: { mark: "off", bal: "$12.50", word: null, retry: "on" } },
  { id: "S19.5-offline-money-off", f: "offline-off", expect: () => '.sgn[data-state="S19.5"]', s19: { mark: "off", bal: "$12.50", word: null, retry: "off" } },
  { id: "wallet-restored-S19.3", f: "scanning", to: ["wallet-restored"], expect: () => '.sgn[data-state="S19.3"]', s19: { mark: "done", bal: "$73.18", word: null } },
  { id: "wallet-restored-S1.4", f: "scanning", to: ["wallet-restored"], act: "close", expect: (w) => `${hdr(w)}[data-header="S1.4"]` },
];

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-signin-screens-"));
  await build({ root: HERE, logLevel: "error", plugins: [react()], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 } });
  return out;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
function serve(dir) {
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const file = path.join(dir, p === "/" ? "index.html" : p);
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const fails = [];
const drafts = new Map();
const check = (ok, what) => {
  if (!ok) fails.push(what);
};

async function openAt(browser, w, scheme, f, p) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const external = [];
  page.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && external.push(r.url()));
  await page.goto(`${BASE}/?f=${f}&path=${encodeURIComponent(p)}`);
  await page.waitForSelector(".shell");
  return { ctx, page, external };
}

// S19's faults on one shot: the mark and the amount drawn and in view, the word (or none: done has no title word and
// no sentence), the sheet's own words only, and Retry on or drawn off (text-3) with money off
const TEXT_3 = "rgb(110, 110, 110)";
async function s19Faults(page, want) {
  const got = await page.evaluate(() => {
    const box = document.querySelector(".sgn-box");
    const r = box?.querySelector(".sgn-restore");
    const mark = r?.querySelector(".rn-mark");
    const mr = mark?.getBoundingClientRect();
    const retry = r?.querySelector(".retry");
    return {
      mark: mark?.getAttribute("data-mark") ?? null,
      markW: mr ? Math.round(mr.width) : 0,
      inView: !!mr && mr.top >= 0 && mr.bottom <= innerHeight,
      tick: r?.querySelectorAll(".rn-tick circle").length ?? 0,
      bal: r?.querySelector("[data-balance]")?.getAttribute("data-balance") ?? null,
      named: document.getElementById("sgn-title")?.textContent ?? null,
      word: r?.querySelector(".rword")?.textContent ?? null,
      h2: box?.querySelectorAll("h2").length ?? -1,
      text: box?.textContent ?? "",
      retry: retry ? { disabled: retry.disabled, color: getComputedStyle(retry).color } : null,
    };
  });
  const f = [];
  if (got.mark !== want.mark) f.push(`mark ${got.mark}, want ${want.mark}`);
  if (got.markW < 90) f.push(`mark ${got.markW} px wide, under 90`);
  if (!got.inView) f.push("mark not in view");
  if ((want.mark === "done") !== got.tick > 0) f.push(`${got.tick} tick dots in mark ${got.mark}`);
  if (got.bal !== want.bal || got.named !== want.bal) f.push(`amount ${got.bal} (names the dialog: ${got.named}), want ${want.bal}`);
  if (got.word !== want.word) f.push(`word ${JSON.stringify(got.word)}, want ${JSON.stringify(want.word)}`);
  if (got.h2 !== 0) f.push(`${got.h2} title(s) over the notice`);
  const extra = got.text.replace(want.bal, "").replace(want.word ?? "", "").replace(want.retry ? "Offline" : "", "").replace(want.retry ? "Retry" : "", "").trim();
  if (extra) f.push(`other words on the notice: ${JSON.stringify(extra)}`);
  if (!want.retry && got.retry) f.push("a Retry with no stall");
  if (want.retry === "on" && (!got.retry || got.retry.disabled || got.retry.color === TEXT_3)) f.push(`Retry not on: ${JSON.stringify(got.retry)}`);
  if (want.retry === "off" && (!got.retry || !got.retry.disabled || got.retry.color !== TEXT_3)) f.push(`Retry not drawn off with money off: ${JSON.stringify(got.retry)}`);
  return f;
}

let BASE = "";
const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchHarnessBrowser("chromium");
try {
  for (const w of WIDTHS) {
    for (const scheme of SCHEMES) {
      for (const s of SHOTS_LIST) {
        const p = s.act === "menu" && w.name === "390" ? "/profile" : "/discover";
        const { ctx, page, external } = await openAt(browser, w, scheme, s.f, p);
        const tag = `${s.id} @${w.name} ${scheme}`;
        for (const t of s.to ?? []) {
          await page.evaluate((n) => window.__fixture(n), t);
          await page.waitForFunction((n) => document.documentElement.dataset.fixture === n, t);
        }
        if (s.act === "signin") await page.locator(`${w.name === "390" ? ".phh" : ".tb"} [data-header="S1.1"]`).first().click();
        if (s.act === "menu" && w.name === "1440") await page.locator(".tb .acct").click();
        if (s.act === "close") await page.locator(".sgn-x").click();
        const shown = await page.locator(s.expect(w.name)).first().isVisible().catch(() => false);
        check(shown, `${tag}: ${s.expect(w.name)} not visible`);
        if (s.s19) for (const f of await s19Faults(page, s.s19)) check(false, `${tag}: ${f}`);
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        check(scroll <= 0, `${tag}: horizontal scroll ${scroll}px`);
        check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
        for (const d of await page.$$eval("[data-draft-copy]", (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
          if (!drafts.has(d)) drafts.set(d, new Set());
          drafts.get(d).add(s.id);
        }
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${s.id}-${w.name}-${scheme}.png`) });
        await ctx.close();
      }
    }

    // behaviour: each way in posts signin.open with its way and the sheet's return view
    for (const way of ["passkey", "wallet", "words"]) {
      const { ctx, page } = await openAt(browser, w, "dark", "out", "/discover");
      await page.locator(`${w.name === "390" ? ".phh" : ".tb"} [data-header="S1.1"]`).first().click();
      await page.locator(`.sgn-opt[data-way="${way}"]`).click();
      const calls = await page.evaluate(() => window.__calls);
      const c = calls[0];
      check(calls.length === 1 && c.kind === "signin.open" && c.params.way === way && c.view.sheet === "signin" && c.view.control === `signin-${way}`, `@${w.name}: ${way} posted ${JSON.stringify(calls)}`);
      await ctx.close();
    }
    // passkey first
    {
      const { ctx, page } = await openAt(browser, w, "dark", "out", "/discover");
      await page.locator(`${w.name === "390" ? ".phh" : ".tb"} [data-header="S1.1"]`).first().click();
      const ways = await page.$$eval(".sgn-opt", (els) => els.map((e) => e.getAttribute("data-way")));
      check(ways.join() === "passkey,wallet,words", `@${w.name}: ways ${ways}`);
      await ctx.close();
    }
    // a signed-in account has no way in: the sheet never shows S2.1 (W:921)
    {
      const { ctx, page } = await openAt(browser, w, "dark", "balance", "/discover");
      check((await page.locator(".sgn").count()) === 0 && (await page.locator('[data-header="S1.1"]:visible').count()) === 0, `@${w.name}: signed in shows a way in`);
      await ctx.close();
    }
    // S19's motion (card restore-notice-redraw): the arc sweeps with motion on and rests with reduced motion; the tick
    // draws in the same frame the done state arrives, with no animation or transition on it (no wait)
    for (const motion of ["no-preference", "reduce"]) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: motion });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/?f=growing&path=%2Fdiscover`);
      await page.waitForSelector(".rn-arc circle");
      const sweep = await page.evaluate(() => [...document.querySelectorAll(".rn-arc circle")].map((c) => c.getAnimations().length));
      const moving = sweep.filter((n) => n > 0).length;
      check(motion === "reduce" ? moving === 0 : moving === sweep.length, `@${w.name} ${motion}: ${moving} of ${sweep.length} arc dots animate`);
      const lit = await page.evaluate(() => [...document.querySelectorAll(".rn-arc circle")].filter((c) => Number(getComputedStyle(c).opacity) > 0.5).length);
      check(lit > 10, `@${w.name} ${motion}: ${lit} arc dots lit`);
      const end = await page.evaluate(
        () =>
          new Promise((done) => {
            const t0 = performance.now();
            new MutationObserver((_, o) => {
              const tick = document.querySelector(".rn-tick");
              if (!tick) return;
              o.disconnect();
              const mark = document.querySelector(".rn-mark");
              done({ ms: performance.now() - t0, anims: mark.getAnimations({ subtree: true }).length, arc: !!document.querySelector(".rn-arc"), state: document.querySelector(".sgn")?.getAttribute("data-state") });
            }).observe(document.body, { subtree: true, childList: true, attributes: true });
            window.__fixture("done");
          }),
      );
      check(end.state === "S19.3" && end.anims === 0 && !end.arc && end.ms < 100, `@${w.name} ${motion}: done drew ${JSON.stringify(end)}`);
      await ctx.close();
    }
    // Sync starts restore; Retry on S19.5 starts restore
    {
      const { ctx, page } = await openAt(browser, w, "dark", "offline", "/discover");
      await page.locator(".sgn .retry").click();
      const calls = await page.evaluate(() => window.__calls);
      check(calls.length === 1 && calls[0].kind === "restore", `@${w.name}: Retry posted ${JSON.stringify(calls)}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

for (const [d, ids] of [...drafts].sort()) console.log(`draft copy on screen: ${d} (${[...ids].join(", ")})`);
const n = SHOTS_LIST.length * WIDTHS.length * SCHEMES.length;
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} of ${n} shots and the behaviour checks`);
  process.exit(1);
}
console.log(`PASS ${n} shots (${SHOTS_LIST.length} states x 390/1440 x dark/light) and the behaviour checks${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
