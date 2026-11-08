// node packages/signpage/test/withdraw-screens/run.mjs [--shots <dir>]: the withdraw form's states at 390 and 1440 wide
// in headless Chromium (card signpage-withdraw-form): empty, typing, each address refusal (not a NEAR account, the
// vault, intents.near, the token, a named account absent on both RPCs, RPCs unanswered), each amount refusal (not an
// amount, at or below the fee, above the note less the fee), and ready, then the Withdraw tap's hand-off. The page is
// test/withdraw-screens/entry.ts, bundled by Vite as the page's own build bundles src/main.ts, served with no network.
// For each state it checks the form's data-state, each line's data-refusal and words (a draft mark only on Min $, the
// words the owner kept on 8 Nov 07:55Z carry none), Withdraw's disabled flag, and
// that no refusal needed a proof (the stub has no prover). PASS exit 0, FAIL exit 1.
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

const { build } = await import("vite");
const out = mkdtempSync(join(tmpdir(), "ct-withdraw-screens-"));
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

// the testnet vault and token come from the page (entry.ts reads NEAR_NETWORKS), so the run follows the release
const states = (VAULT, TOKEN) => [
  ["empty", "", "", { state: "empty" }],
  ["typing", "alice.near", "", { state: "typing" }],
  ["not-account", "Alice.near", "", { state: "refused", to: ["not-account", "Invalid address"] }],
  ["vault", VAULT, "1", { state: "refused", to: ["vault", "Invalid address"] }],
  ["intents", "intents.near", "1", { state: "refused", to: ["intents", "Invalid address"] }],
  ["token", TOKEN, "1", { state: "refused", to: ["token", "Invalid address"] }],
  ["no-account", "nobody-here.near", "1", { state: "refused", to: ["no-account", "Invalid address"] }],
  ["unread", "down.near", "1", { state: "refused", to: ["unread", "Busy · Retry"] }],
  ["amount", "alice.near", "5,0", { state: "refused", amount: ["amount", "Invalid amount"] }],
  ["min", "alice.near", "0.12", { state: "refused", amount: ["min", "Min $0.120001"] }],
  ["insufficient", "alice.near", "9.880001", { state: "refused", amount: ["insufficient", "Insufficient"] }],
  ["ready", "alice.near", "9.88", { state: "ready" }],
];

const browser = await launchBrowser("chromium");
const lines = [];
const say = (ok, t) => lines.push(`${ok ? "ok " : "BAD"} ${t}`);
for (const [wname, width, height] of [["390", 390, 844], ["1440", 1440, 900]]) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("https://withdraw.test/**", (r) =>
    r.request().url().endsWith("/form.js")
      ? r.fulfill({ status: 200, contentType: "text/javascript", body: js })
      : r.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><body><script type="module" src="/form.js"></script></body>` }));
  await page.route(/^(?!https:\/\/withdraw\.test\/).*/, (r) => r.abort()); // no network
  await page.goto("https://withdraw.test/");
  await page.waitForSelector('[data-withdraw="form"]');
  const { vault: VAULT, token: TOKEN } = await page.evaluate(() => window.__release);
  for (const [name, to, amount, want] of states(VAULT, TOKEN)) {
    await page.fill('[data-input="to"]', to);
    await page.fill('[data-input="amount"]', amount);
    // past the form's idle time and its stub reads; typing waits on a field left blank, so it stays
    await page.waitForTimeout(450);
    const got = await page.evaluate(() => {
      const f = document.querySelector('[data-withdraw="form"]');
      const line = (k) => {
        const p = f.querySelector(`p[data-for="${k}"]`);
        return p.hidden ? null : [p.dataset.refusal, p.textContent, p.dataset.draftCopy ?? null];
      };
      const go = f.querySelector('[data-action="withdraw"]');
      return { state: f.dataset.state, to: line("to"), amount: line("amount"), disabled: go.disabled, drafts: [...f.querySelectorAll("[data-draft-copy]")].filter((e) => !e.hidden).length };
    });
    const lineOk = (k) => (want[k] ? got[k]?.[0] === want[k][0] && got[k]?.[1] === want[k][1] && (got[k]?.[2] ?? null) === (want[k][0] === "min" ? "min" : null) : got[k] === null || !want[k]);
    const ok = got.state === want.state && lineOk("to") && lineOk("amount") && got.disabled === (want.state !== "ready");
    say(ok, `${wname} ${name}: ${got.state}, to ${JSON.stringify(got.to?.slice(0, 2) ?? null)}, amount ${JSON.stringify(got.amount?.slice(0, 2) ?? null)}, Withdraw ${got.disabled ? "off" : "on"}`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `withdraw-${name}-${wname}.png`), fullPage: true });
  }
  // the tap: checked again, then handed over once, as {recipient, amount}
  await page.waitForTimeout(600); // past nothing on this mount (no activation guard here; the page's own guards Withdraw)
  await page.click('[data-action="withdraw"]');
  await page.waitForTimeout(300);
  const handed = await page.evaluate(() => window.__handed.map((c) => ({ recipient: c.recipient, amount: String(c.amount) })));
  say(handed.length === 1 && handed[0].recipient === "alice.near" && handed[0].amount === "9880000", `${wname} Withdraw hands over {recipient, amount} once: ${JSON.stringify(handed)}`);
  // no read for a refusal the form can make alone (not a NEAR account, the vault, intents.near, the token)
  const reads = await page.evaluate(() => window.__reads);
  const [vault, token] = [VAULT, TOKEN];
  const bad = reads.filter((a) => ["Alice.near", vault, "intents.near", token].includes(a));
  say(bad.length === 0, `${wname} no RPC read for the vault, intents.near, the token or a non-account (${reads.length} reads, all of named accounts)`);
  say(errors.length === 0, `${wname} no page error (${errors.length})`);
  await page.close();
}
await browser.close();
for (const l of lines) console.log(l);
const pass = lines.every((l) => l.startsWith("ok "));
console.log(`withdraw-screens: ${pass ? "PASS" : "FAIL"}${SHOTS ? ` (shots in ${SHOTS})` : ""} on ${browserLabel(browser)}`);
process.exit(pass ? 0 : 1);
