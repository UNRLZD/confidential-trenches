// node packages/signpage/test/sealed-backdrop/run.mjs [--shots <dir>]: the two directions for the ground behind a sealed
// screen (./directions.ts), for the owner's pick, beside today's: the pool withdraw form in the real sheet over each
// ground, at 390 x 844 and 1440 x 900, empty, filled (To and an amount typed) and with Max tapped. Headless Chrome under
// SIGN_HOST's own content security policy (public/_headers, the /* rule); the logo's files are served from the page's own
// origin, as the page's build would serve them. Per shot it checks: the ground drawn (the logo loaded where a direction
// has one), no page wider than the window, no policy violation, no page error. PASS exit 0, FAIL exit 1.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(dirname(HERE));
const BRAND = join(PKG, "../../apps/terminal/src/shell/brand");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? args[shotsAt + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const CSP = /^\/\*\n\s+Content-Security-Policy: (.+)$/m.exec(readFileSync(join(PKG, "public", "_headers"), "utf8"))?.[1];
if (!CSP) throw new Error("public/_headers has no /* Content-Security-Policy");

const { build } = await import("vite");
const out = mkdtempSync(join(tmpdir(), "ct-sealed-backdrop-"));
let js;
try {
  await build({
    configFile: false, root: PKG, logLevel: "warn", publicDir: false,
    build: { outDir: out, emptyOutDir: true, target: "es2023", minify: false, modulePreload: false, copyPublicDir: false,
      rolldownOptions: { input: join(HERE, "entry.ts"), output: { format: "es", entryFileNames: "form.js", codeSplitting: false } } },
  });
  js = readFileSync(join(out, "form.js"), "utf8");
} finally {
  rmSync(out, { recursive: true, force: true });
}

const TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
const browser = await launchBrowser("chromium");
const lines = [];
const say = (ok, t) => lines.push(`${ok ? "ok " : "BAD"} ${t}`);
for (const dir of ["now", "a", "b"]) {
  for (const [wname, width, height, scale] of [["390", 390, 844, 2], ["1440", 1440, 900, 1]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale, isMobile: wname === "390", hasTouch: wname === "390" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.clock.install();
    await page.route("https://sealed.test/**", (r) => {
      const p = new URL(r.request().url()).pathname;
      if (p === "/form.js") return r.fulfill({ status: 200, contentType: "text/javascript", body: js });
      if (p.endsWith(".svg")) return r.fulfill({ status: 200, contentType: "image/svg+xml", body: readFileSync(join(BRAND, p.slice(1))) });
      return r.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": CSP }, body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><body><script type="module" src="/form.js"></script></body>` });
    });
    await page.route(/^(?!https:\/\/sealed\.test\/).*/, (r) => r.abort());
    await page.goto(`https://sealed.test/?dir=${dir}`);
    await page.waitForSelector('[data-withdraw="pool"]');
    await page.evaluate(() => {
      window.__violations = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await page.clock.runFor(50);
    for (const [name, to, amount, max] of [["empty", "", "", false], ["filled", TO, "0.02", false], ["max", TO, "", true]]) {
      await page.fill('[data-input="to"]', to);
      await page.fill('[data-input="amount"]', amount);
      await page.clock.runFor(450);
      if (max) {
        await page.click('[data-action="sendable"]');
        await page.clock.runFor(50);
      }
      await page.waitForFunction(() => [...document.querySelectorAll("#backdrop img")].every((i) => i.complete));
      const got = await page.evaluate(() => {
        const g = document.querySelector("#backdrop");
        const imgs = [...g.querySelectorAll("img")];
        return {
          ground: g.dataset.ground ?? "now",
          logo: imgs.length ? imgs.every((i) => i.naturalWidth > 0) : null,
          wide: document.scrollingElement.scrollWidth > window.innerWidth,
          amount: document.querySelector('[data-input="amount"]').value,
        };
      });
      say(got.ground === dir && (dir === "now" ? got.logo === null : got.logo === true) && !got.wide, `${dir} ${wname} ${name}: ground ${got.ground}, logo ${got.logo === null ? "none" : got.logo ? "loaded" : "NOT LOADED"}, amount ${JSON.stringify(got.amount)}${got.wide ? ", WIDER THAN THE WINDOW" : ""}`);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `ground-${dir}-${name}-${wname}.png`) });
    }
    const violations = await page.evaluate(() => window.__violations);
    say(violations.length === 0, `${dir} ${wname} no policy violation under SIGN_HOST's CSP (${violations.join("; ") || "none"})`);
    say(errors.length === 0, `${dir} ${wname} no page error (${errors.join("; ") || "none"})`);
    await page.close();
  }
}
await browser.close();
for (const l of lines) console.log(l);
const pass = lines.every((l) => l.startsWith("ok "));
console.log(`sealed-backdrop: ${pass ? "PASS" : "FAIL"}${SHOTS ? ` (shots in ${SHOTS})` : ""} on ${browserLabel(browser)}`);
process.exit(pass ? 0 : 1);
