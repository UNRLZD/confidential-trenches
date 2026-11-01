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
  { id: "S19.1-scanning", f: "scanning", expect: () => '.sgn[data-state="S19.1"]' },
  { id: "S19.2-growing", f: "growing", expect: () => '.sgn[data-state="S19.1"] [data-balance="$41.06"]' },
  { id: "S19.3-done", f: "growing", to: ["done"], expect: () => '.sgn[data-state="S19.3"]' },
  { id: "S19.4-nothing-found", f: "scanning", to: ["nothing"], expect: () => '.sgn[data-state="S19.4"]' },
  { id: "S19.5-offline", f: "offline", expect: () => '.sgn[data-state="S19.5"]' },
  { id: "wallet-restored-S19.3", f: "scanning", to: ["wallet-restored"], expect: () => '.sgn[data-state="S19.3"]' },
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

let BASE = "";
const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import("playwright");
const browser = await chromium.launch();
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
console.log(`PASS ${n} shots (${SHOTS_LIST.length} states x 390/1440 x dark/light) and the behaviour checks${SHOTS ? `; shots in ${SHOTS}` : ""}`);
