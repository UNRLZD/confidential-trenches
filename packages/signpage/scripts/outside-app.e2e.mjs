// node packages/signpage/scripts/outside-app.e2e.mjs [<shots folder>]: card signpage-answers-outside-apps, in the
// installed Chrome (scripts/browsers.mjs), across two origins. This tree's SIGN_HOST build is served by Cloudflare's own
// Pages rules engine (wrangler pages dev, the deploy's pinned WRANGLER), so public/_headers is applied as SIGN_HOST
// applies it; Playwright puts that server at SIGN_HOST's address. An outside app on http://localhost:4792, built on the
// kit's client in popup mode, opens SIGN_HOST's /connect from a tap:
//   - the headers as served: /connect gives Cross-Origin-Opener-Policy unsafe-none and frame-ancestors 'none'; / still
//     gives same-origin and frame-ancestors 'none';
//   - before Allow the connect sheet names http://localhost:4792 (the browser's e.origin, though the app claims another
//     name in its message), and the app gets no message at all;
//   - after Allow the app is ready; it signs in with the published all-zero test seed (packages/wallet/test/vectors/a8.json)
//     typed on SIGN_HOST's own screen, then two buys in a row each open a Confirm naming the origin, each is confirmed,
//     and each answer reaches the app: the popup stayed at /connect in one document with its opener the whole time;
//   - a withdraw.open with to and an amount draws the page's own withdraw Confirm under the origin, the address whole and
//     the amount, Confirm offered only once both pass the page's checks (here never: no chain is reached), and Cancel
//     closes it; a withdraw.open with no to is refused not_allowed;
//   - the same /connect in an iframe on the app is refused (frame-ancestors 'none').
// No chain is reached: every request but SIGN_HOST's and the app's is aborted, so the buys end refused. Tapping Confirm
// happens only in this local run, never on production. exit 0 when all hold, 1 otherwise.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { browserLabel, launchBrowser } from "../../../scripts/browsers.mjs";
import { build, WRANGLER } from "./deploy.mjs";
import { entropyToWords } from "../../wallet/src/derive/index.ts";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const SIGN = "https://confidential.unrealized.trade";
const APP = "http://localhost:4792";
const PORT = 8788;
const LOCAL = `http://127.0.0.1:${PORT}`;
const SHOTS = process.argv[2] ?? mkdtempSync(join(tmpdir(), "outside-app-"));
mkdirSync(SHOTS, { recursive: true });
const BUY = { chain: "solana", token: "So11111111111111111111111111111111111111112", amount: "0.01", slippage_bps: 300 };
// a NEAR implicit account, 64 characters: drawn whole on the Confirm
const TO = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

let ok = true;
const check = (cond, what) => {
  ok &&= !!cond;
  console.log(`${cond ? "ok " : "BAD"} ${what}`);
};

// the outside app: a Connect button makes the kit's client in popup mode (window.open in the tap); once ready it signs in
// on a tap and asks a pool.buy per Buy tap; every message it gets is kept with its origin
async function buildApp() {
  const root = mkdtempSync(join(tmpdir(), "outside-app-src-"));
  const client = join(dirname(PKG), "kit", "src", "signpage", "client.ts");
  writeFileSync(join(root, "index.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Outside app</title></head><body><button id="connect">Connect</button><button id="signin">Sign in</button><button id="buy">Buy</button><button id="withdraw">Withdraw</button><button id="withdraw-bare">Withdraw bare</button><script type="module" src="./main.ts"></script></body></html>');
  writeFileSync(join(root, "embed.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Embed</title></head><body><iframe id="sign" src="${SIGN}/connect"></iframe></body></html>`);
  writeFileSync(
    join(root, "main.ts"),
    `import { createSignpageClient, type SignpageClient } from ${JSON.stringify(client)};
const w = window as unknown as { got: string[]; log: string[] };
w.got = [];
w.log = [];
const log = (l: string) => (w.log.push(l), document.body.append(Object.assign(document.createElement("pre"), { textContent: l })));
addEventListener("message", (e) => w.got.push(e.origin));
let c: SignpageClient | null = null;
document.getElementById("connect")!.addEventListener("click", () => {
  c = createSignpageClient({ url: ${JSON.stringify(`${SIGN}/`)}, mode: "popup", host: { window, document, mount: document.body, open: (u) => ((w as unknown as { pop: Window | null }).pop = window.open(u, "blindfill", "popup,width=440,height=760")) } });
  c.subscribe((s) => log("status " + s.status + (s.state ? " signed_in=" + s.state.signed_in : "")));
});
document.getElementById("signin")!.addEventListener("click", () => {
  const r = c!.request("signin.open", { way: "words", return_key: "signin" });
  void r.outcome.then((o) => log("signin " + JSON.stringify(o)));
});
let n = 0;
document.getElementById("buy")!.addEventListener("click", () => {
  const k = ++n;
  const r = c!.request("pool.buy", ${JSON.stringify(BUY)});
  log("asked buy " + k);
  void r.outcome.then((o) => log("answer buy " + k + " " + JSON.stringify(o)));
});
document.getElementById("withdraw")!.addEventListener("click", () => {
  const r = c!.request("withdraw.open", { return_key: "withdraw", to: ${JSON.stringify(TO)}, amount: "1.5" });
  void r.outcome.then((o) => log("answer withdraw " + JSON.stringify(o)));
});
document.getElementById("withdraw-bare")!.addEventListener("click", () => {
  const r = c!.request("withdraw.open", { return_key: "withdraw" });
  void r.outcome.then((o) => log("answer withdraw-bare " + JSON.stringify(o)));
});`,
  );
  const out = join(root, "dist");
  await viteBuild({ root, logLevel: "silent", build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { index: join(root, "index.html"), embed: join(root, "embed.html") } } } });
  const files = [];
  const walk = (rel) => {
    for (const n of readdirSync(join(out, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${n.name}` : n.name;
      if (n.isDirectory()) walk(p);
      else files.push(`/${p}`);
    }
  };
  walk("");
  return { root, files, read: (p) => readFileSync(join(out, p.slice(1))) };
}

// SIGN_HOST's deploy output, served by wrangler pages dev (Cloudflare's rules engine: _headers, the index for a path
// with no file)
const site = build(PKG);
// run in a folder of its own: wrangler writes its .wrangler state where it runs, never into the checkout
const wranglerHome = mkdtempSync(join(tmpdir(), "outside-app-wrangler-"));
const wrangler = spawn("npx", ["-y", WRANGLER, "pages", "dev", site, "--port", String(PORT), "--ip", "127.0.0.1", "--log-level", "error"], { cwd: wranglerHome, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
let wranglerOut = "";
wrangler.stdout.on("data", (d) => (wranglerOut += d));
wrangler.stderr.on("data", (d) => (wranglerOut += d));
const up = async () => {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${LOCAL}/`)).status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
const app = await buildApp();
let browser = null;
try {
  check(await up(), `wrangler pages dev (${WRANGLER}) serves the build at ${LOCAL}`);
  if (!ok) throw new Error(wranglerOut.slice(-2000));
  // the headers as Cloudflare's engine serves them
  const head = async (p) => (await fetch(`${LOCAL}${p}`, { redirect: "manual" })).headers;
  const root = await head("/");
  const connect = await head("/connect");
  const fa = (h) => /(^|;)\s*frame-ancestors 'none'\s*(;|$)/.test(h.get("content-security-policy") ?? "");
  check(root.get("cross-origin-opener-policy") === "same-origin" && fa(root), `/: COOP ${root.get("cross-origin-opener-policy")}, frame-ancestors 'none' ${fa(root)}`);
  check(connect.get("cross-origin-opener-policy") === "unsafe-none" && fa(connect), `/connect: COOP ${connect.get("cross-origin-opener-policy")}, frame-ancestors 'none' ${fa(connect)}`);
  check(connect.get("content-security-policy") === root.get("content-security-policy"), "/connect keeps /'s one CSP");

  browser = await launchBrowser("chromium");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route("**/*", async (r) => {
    const u = new URL(r.request().url());
    if (u.origin === SIGN) {
      const res = await r.fetch({ url: `${LOCAL}${u.pathname}${u.search}`, maxRedirects: 0 });
      return r.fulfill({ response: res });
    }
    if (u.origin === APP) {
      const p = u.pathname === "/" ? "/index.html" : u.pathname === "/embed" ? "/embed.html" : u.pathname;
      if (!app.files.includes(p)) return r.fulfill({ status: 404, body: "" });
      return r.fulfill({ status: 200, contentType: p.endsWith(".js") ? "text/javascript" : "text/html", body: app.read(p) });
    }
    return r.abort();
  });
  const page = await ctx.newPage();
  await page.goto(`${APP}/`);
  const appLog = () => page.evaluate(() => window.log);
  const opened = ctx.waitForEvent("page");
  await page.click("#connect");
  const pop = await opened;
  const sheet = () => pop.evaluate(() => (document.querySelector("#screen")?.hidden ? "" : (document.querySelector("#outside")?.textContent ?? "")));
  await pop.waitForFunction(() => document.querySelector("#outside")?.textContent?.startsWith("Connect"), null, { timeout: 30_000 }).catch(() => {});
  // the app claims another name in a message of its own: the sheet still shows the browser's e.origin
  await page.evaluate(() => window.pop?.postMessage({ v: 1, type: "hello", kit: "1.15", origin: "https://ct-app.unrealized.trade", name: "Blindfill" }, "https://confidential.unrealized.trade"));
  await pop.waitForTimeout(1_000);
  check((await sheet()) === `Connect ${APP}AllowCancel`, `the connect sheet names ${APP}: ${JSON.stringify(await sheet())}`);
  // the sheet shows the connect step alone: the page's own sign-in screen under it is not drawn
  const alone = () => pop.evaluate(() => document.querySelector("#screen #signin") === null && document.querySelector("#screen #outside") !== null);
  check(await alone(), "the connect step is the only screen on the sheet");
  check((await page.evaluate(() => window.got.length)) === 0, "before Allow the app got no message at all");
  check(!(await appLog()).some((l) => l.startsWith("status ready")), "before Allow the app's client is not ready");
  for (const width of [390, 1440]) {
    await pop.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await pop.waitForTimeout(300);
    check(await alone(), `${width}: the connect step is still the only screen after the width change`);
    await pop.screenshot({ path: join(SHOTS, `connect-${width}.png`) });
  }
  await pop.waitForTimeout(600);
  await pop.locator("#outside button", { hasText: "Allow" }).click();
  await page.waitForFunction(() => window.log.some((l) => l.startsWith("status ready")), null, { timeout: 30_000 }).catch(() => {});
  check((await appLog()).some((l) => l.startsWith("status ready")), "after Allow the app's client is ready");
  // sign in with the published all-zero test seed, typed on SIGN_HOST's own words screen
  await page.click("#signin");
  const words = pop.locator('#signin[data-signin="words"] textarea[data-input="words"]');
  await words.waitFor({ timeout: 30_000 }).catch(() => {});
  if (await words.count()) {
    await words.fill(entropyToWords(new Uint8Array(16)));
    await pop.waitForTimeout(600);
    await pop.locator('#signin[data-signin="words"] button[data-action="next"]').click();
    await page.waitForFunction(() => window.log.some((l) => l.includes("signed_in=true")), null, { timeout: 60_000 }).catch(() => {});
  }
  const signedIn = (await appLog()).some((l) => l.includes("signed_in=true"));
  check(signedIn, "signed in with the all-zero test seed");
  // the sign-in's own screens done: whatever sheet it left is closed by its own Cancel or close, if any is shown
  for (let i = 0; i < 3 && !(await pop.evaluate(() => document.querySelector("#screen")?.hidden)); i++) {
    const done = pop.locator('#screen:not([hidden]) button[data-action="cancel"], #screen:not([hidden]) button[data-action="saved"], #screen:not([hidden]) [data-sheet="close"]').first();
    if (!(await done.count())) break;
    await pop.waitForTimeout(600);
    await done.click().catch(() => {});
    await pop.waitForTimeout(800);
  }
  for (const k of [1, 2]) {
    await page.click("#buy");
    await pop.waitForFunction(() => document.querySelector("#outside")?.textContent?.startsWith("Buy"), null, { timeout: 30_000 }).catch(() => {});
    const text = await sheet();
    check(text.startsWith(`Buy${APP}`) && text.includes("Amount0.01 SOL") && text.includes(BUY.token) && text.endsWith("ConfirmCancel"), `buy ${k}: the Confirm names the origin and the buy: ${JSON.stringify(text)}`);
    check(await alone(), `buy ${k}: the Confirm is the only screen on the sheet`);
    const fits = await pop.evaluate(() => [...document.querySelectorAll("#outside *")].every((e) => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5));
    check(fits, `buy ${k}: every line of the Confirm fits the popup's width`);
    if (k === 1)
      for (const width of [390, 1440]) {
        await pop.setViewportSize({ width, height: width < 768 ? 844 : 900 });
        await pop.waitForTimeout(300);
        check(await alone(), `${width}: the Confirm is still the only screen after the width change`);
        await pop.screenshot({ path: join(SHOTS, `confirm-${width}.png`) });
      }
    await pop.waitForTimeout(600);
    await pop.locator("#outside button", { hasText: "Confirm" }).click();
    await page.waitForFunction((n) => window.log.some((l) => l.startsWith(`answer buy ${n} `)), k, { timeout: 60_000 }).catch(() => {});
    const answer = (await appLog()).find((l) => l.startsWith(`answer buy ${k} `));
    check(answer !== undefined, `buy ${k}: its answer reached the app after Confirm: ${answer}`);
    check(new URL(pop.url()).pathname === "/connect" && (await pop.evaluate(() => window.opener !== null)), `buy ${k}: the popup is still at /connect with its opener`);
  }
  // withdraw.open with no to: refused, nothing drawn
  await page.click("#withdraw-bare");
  await page.waitForFunction(() => window.log.some((l) => l.startsWith("answer withdraw-bare ")), null, { timeout: 30_000 }).catch(() => {});
  const bare = (await appLog()).find((l) => l.startsWith("answer withdraw-bare "));
  check(bare?.includes('"not_allowed"') && (await pop.evaluate(() => document.querySelector("#screen")?.hidden)), `withdraw.open with no to is refused, no sheet: ${bare}`);
  // withdraw.open with to and an amount: the page's own withdraw Confirm, under the origin
  await page.click("#withdraw");
  const form = '#screen:not([hidden]) #signin [data-withdraw="form"][data-given="app"]';
  await pop.waitForSelector(form, { timeout: 30_000 }).catch(() => {});
  await pop.waitForTimeout(1_500);
  const wtext = await pop.evaluate(() => document.querySelector("#screen #signin")?.textContent ?? "");
  const wvalues = await pop.evaluate(() => [...document.querySelectorAll('#screen #signin [data-value]')].map((e) => [e.dataset.value, e.textContent]));
  check(wtext.startsWith(APP), `withdraw: the Confirm names the origin first: ${JSON.stringify(wtext.slice(0, 60))}`);
  check(JSON.stringify(wvalues) === JSON.stringify([["to", TO], ["amount", "1.5 USDC"]]), `withdraw: the Confirm shows the address whole and the amount: ${JSON.stringify(wvalues)}`);
  const go = pop.locator('#screen #signin button[data-action="withdraw"]');
  const goState = await go.evaluate((b) => [b.textContent, b.disabled]).catch(() => null);
  check(goState?.[0] === "Confirm" && goState?.[1] === true, `withdraw: Confirm is drawn and not offered until the page's own checks pass (no chain here): ${JSON.stringify(goState)}`);
  check(new URL(pop.url()).pathname === "/connect" && (await pop.evaluate(() => window.opener !== null)), "withdraw: the popup is still at /connect with its opener");
  for (const width of [390, 1440]) {
    await pop.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await pop.waitForTimeout(300);
    const wfits = await pop.evaluate(() => [...document.querySelectorAll("#screen #signin *")].every((e) => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5));
    check(wfits, `${width}: every line of the withdraw Confirm fits the popup's width`);
    await pop.screenshot({ path: join(SHOTS, `withdraw-${width}.png`) });
  }
  await pop.waitForTimeout(600);
  await pop.locator('#screen #signin button[data-action="cancel"]').click();
  await pop.waitForFunction(() => document.querySelector("#screen")?.hidden, null, { timeout: 10_000 }).catch(() => {});
  check(await pop.evaluate(() => document.querySelector("#screen")?.hidden), "withdraw: Cancel closes the Confirm, nothing sent");
  check((await page.evaluate(() => [...new Set(window.got)])).join() === SIGN, "every message the app got came from SIGN_HOST");
  // the same /connect embedded in an iframe on the app: refused
  const refused = [];
  const embed = await ctx.newPage();
  embed.on("console", (m) => /frame-ancestors/.test(m.text()) && refused.push(m.text()));
  await embed.goto(`${APP}/embed`);
  await embed.waitForTimeout(2_000);
  const inner = embed.frames().find((f) => f.url().startsWith(SIGN));
  const drew = inner ? await inner.evaluate(() => document.body?.childElementCount ?? 0).catch(() => 0) : 0;
  check(refused.length > 0 && drew === 0, `an iframe of ${SIGN}/connect is refused: ${refused[0]?.split("\n")[0] ?? "no refusal"}`);
  console.log(`app log: ${JSON.stringify(await appLog())}`);
  await ctx.close();
} catch (e) {
  ok = false;
  console.log(`BAD ${String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ")}`);
} finally {
  const label = browser ? browserLabel(browser) : "no browser";
  await browser?.close();
  wrangler.kill("SIGTERM");
  rmSync(app.root, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
  rmSync(wranglerHome, { recursive: true, force: true });
  console.log(`shots: ${SHOTS}`);
  console.log(`outside-app.e2e: ${ok ? "PASS" : "FAIL"} (${label})`);
  process.exit(ok ? 0 : 1);
}
