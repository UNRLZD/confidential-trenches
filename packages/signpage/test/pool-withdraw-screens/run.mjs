// node packages/signpage/test/pool-withdraw-screens/run.mjs [--shots <dir>]: the pool withdraw screen's states at 390 and
// 1440 wide, on Solana and on Base, in headless Chrome under SIGN_HOST's own content security policy (public/_headers,
// the /* rule), card withdraw-form-shows-what-you-can-send: empty, typing (a half address, before the idle check),
// refused To (Invalid address), refused amount (Insufficient: 0.1 SOL against a 0.05 SOL deposit), both refused, and
// ready by a tap on what can be sent, then the press. The page is test/pool-withdraw-screens/entry.ts, bundled by Vite as
// the page's own build bundles src/main.ts, served with no network; the page's clock is the test's, so each state is the
// one named. For each state it checks the form's data-state and lines, and on every state: the chain's mark loaded and
// its name, the asset's symbol at the amount, what can be sent drawn as its value (at least 44 px tall at 390), no
// page wider than the window, no policy violation, no page error. PASS exit 0, FAIL exit 1.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(dirname(HERE));
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? args[shotsAt + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
// SIGN_HOST's policy for every path, as its _headers file serves it
const CSP = /^\/\*\n\s+Content-Security-Policy: (.+)$/m.exec(readFileSync(join(PKG, "public", "_headers"), "utf8"))?.[1];
if (!CSP) throw new Error("public/_headers has no /* Content-Security-Policy");

const { build } = await import("vite");
const out = mkdtempSync(join(tmpdir(), "ct-pool-withdraw-screens-"));
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

const SOL_TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
const EVM_TO = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const CHAIN = {
  solana: { to: SOL_TO, name: "Solana", symbol: "SOL", can: "0.048695 SOL", over: "0.1", sendable: "48695000", maxFee: "1305000" },
  base: { to: EVM_TO, name: "Base", symbol: "ETH", can: "0.009979 ETH", over: "0.02", sendable: "9979000000000000", maxFee: "21000000000000" },
};
const states = (c) => [
  // name, To, Amount, tap what can be sent, what the screen must show
  ["empty", "", "", false, { state: "empty" }],
  ["typing", c.to.slice(0, 22), "", false, { state: "typing", now: true }],
  ["refused-to", c.to.slice(0, 22), "", false, { state: "refused", to: ["address", "Invalid address"] }],
  ["refused-amount", c.to, c.over, false, { state: "refused", amount: ["insufficient", "Insufficient"] }],
  ["refused-both", c.to.slice(0, 22), c.over, false, { state: "refused", to: ["address", "Invalid address"], amount: ["insufficient", "Insufficient"] }],
  ["ready", ` ${c.to}​`, "", true, { state: "ready", lines: { to: c.to } }],
];

const browser = await launchBrowser("chromium");
const lines = [];
const say = (ok, t) => lines.push(`${ok ? "ok " : "BAD"} ${t}`);
for (const chain of ["solana", "base"]) {
  const c = CHAIN[chain];
  for (const [wname, width, height] of [["390", 390, 844], ["1440", 1440, 900]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.clock.install();
    await page.route("https://withdraw.test/**", (r) =>
      r.request().url().endsWith("/form.js")
        ? r.fulfill({ status: 200, contentType: "text/javascript", body: js })
        : r.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": CSP }, body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><body><script type="module" src="/form.js"></script></body>` }));
    await page.route(/^(?!https:\/\/withdraw\.test\/).*/, (r) => r.abort()); // no network
    await page.goto(`https://withdraw.test/?chain=${chain}`);
    await page.waitForSelector('[data-withdraw="pool"]');
    await page.evaluate(() => {
      window.__violations = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await page.clock.runFor(50); // the funds read at open
    for (const [name, to, amount, tap, want] of states(c)) {
      await page.fill('[data-input="to"]', to);
      await page.fill('[data-input="amount"]', amount);
      if (!want.now) await page.clock.runFor(450); // past the idle time
      if (tap) {
        await page.click('[data-action="sendable"]');
        await page.clock.runFor(50);
      }
      const got = await page.evaluate(() => {
        const f = document.querySelector('[data-withdraw="pool"]');
        const line = (k) => {
          const p = f.querySelector(`p[data-for="${k}"]`);
          return p.hidden ? null : [p.dataset.refusal, p.textContent];
        };
        const mark = f.querySelector("[data-mark]");
        const img = mark?.querySelector("img");
        const can = f.querySelector('[data-action="sendable"]');
        const box = can.getBoundingClientRect();
        const symbol = f.querySelector('[data-input="amount"]').nextElementSibling;
        const shown = Object.fromEntries([...f.querySelectorAll('[data-lines="pool-withdraw"] dd')].map((d) => [d.dataset.line, d.textContent]));
        return {
          state: f.dataset.state, to: line("to"), amount: line("amount"), shown, amountValue: f.querySelector('[data-input="amount"]').value,
          mark: mark?.dataset.mark ?? null, loaded: !!img && img.complete && img.naturalWidth > 0, name: mark?.textContent ?? null,
          symbol: symbol?.textContent ?? null, can: can.parentElement.hidden ? null : can.textContent, canValue: can.dataset.value, canH: box.height, canW: box.width,
          wide: document.scrollingElement.scrollWidth > window.innerWidth, go: f.querySelector('[data-action="withdraw"]').disabled,
        };
      });
      const lineOk = (k) => (want[k] ? got[k]?.[0] === want[k][0] && got[k]?.[1] === want[k][1] : got[k] === null);
      const shownOk = want.lines ? got.shown.to === want.lines.to && got.amountValue === c.can.split(" ")[0] : Object.keys(got.shown).length === 0;
      const drawnOk = got.mark === chain && got.loaded && got.name === c.name && got.symbol === c.symbol && got.can === c.can && got.canValue === c.sendable
        && (width > 400 || got.canH >= 44) && got.canW >= 44 && !got.wide;
      const ok = got.state === want.state && lineOk("to") && lineOk("amount") && shownOk && drawnOk && got.go === (want.state !== "ready");
      say(ok, `${chain} ${wname} ${name}: ${got.state}, to ${JSON.stringify(got.to)}, amount ${JSON.stringify(got.amount)}, mark ${got.mark}${got.loaded ? " loaded" : " NOT LOADED"} ${got.name}, symbol ${got.symbol}, can ${JSON.stringify(got.can)} ${Math.round(got.canW)}x${Math.round(got.canH)} px, field ${JSON.stringify(got.amountValue)}${want.lines ? `, To line ${got.shown.to}` : ""}${got.wide ? ", WIDER THAN THE WINDOW" : ""}, Withdraw ${got.go ? "off" : "on"}`);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `pool-withdraw-${chain}-${name}-${wname}.png`), fullPage: true });
    }
    // the press: checked again, then handed over once, the answer drawn
    await page.click('[data-action="withdraw"]');
    await page.clock.runFor(100);
    const handed = await page.evaluate(() => window.__handed);
    const want = { chain, to: c.to, amount: c.sendable, maxFee: c.maxFee };
    say(handed.length === 1 && JSON.stringify(handed[0]) === JSON.stringify(want), `${chain} ${wname} the press hands over the drawn answer once: ${JSON.stringify(handed)}`);
    const violations = await page.evaluate(() => window.__violations);
    say(violations.length === 0, `${chain} ${wname} no policy violation under SIGN_HOST's CSP (${violations.join("; ") || "none"})`);
    say(errors.length === 0, `${chain} ${wname} no page error (${errors.join("; ") || "none"})`);
    await page.close();
  }
}
await browser.close();
for (const l of lines) console.log(l);
const pass = lines.every((l) => l.startsWith("ok "));
console.log(`pool-withdraw-screens: ${pass ? "PASS" : "FAIL"}${SHOTS ? ` (shots in ${SHOTS})` : ""} on ${browserLabel(browser)}`);
process.exit(pass ? 0 : 1);
