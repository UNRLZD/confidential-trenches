// node packages/signpage/scripts/frame.e2e.mjs: in headless Chrome, the signing page under its recorded headers
// (scripts/live-checks/signpage-skeleton.answers.json, good) is blocked in a frame on every page: SIGN_HOST is the top
// window and frames APP_HOST, never the other way (card signpage-shell, frame-ancestors 'none'), so it is blocked on
// APP_HOST and on https://example.com alike; under the same headers with frame-ancestors taken out it loads on both, so
// the probe can fail. The recorded Content-Security-Policy is held to the one in public/_headers, so a record that has
// gone stale against the real file fails here. No network: Playwright answers every request from the recorded headers
// and packages/signpage. exit 0 all as expected, 1 otherwise.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../../../scripts/browsers.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(dirname(PKG));
const GOOD = JSON.parse(readFileSync(join(REPO, "scripts/live-checks/signpage-skeleton.answers.json"), "utf8")).good;
const PAGE = readFileSync(join(PKG, "index.html"), "utf8");
const APP_JS = readFileSync(join(PKG, "public/app.js"), "utf8");
const SIGN = "https://sign.confidential.unrealized.trade/";
const APP = "https://confidential.unrealized.trade/";
const STRANGER = "https://example.com/";
const DROP = new Set(["content-encoding", "transfer-encoding", "content-length", "date", "etag"]);
const recorded = Object.fromEntries(Object.entries(GOOD.headers).filter(([k]) => !DROP.has(k)));
const REAL_CSP = /^\/\*\n(?:  .*\n)*?  Content-Security-Policy: (.*)$/m.exec(readFileSync(join(PKG, "public/_headers"), "utf8"))?.[1];
const noAncestors = { ...recorded, "content-security-policy": recorded["content-security-policy"].replace(/ ?frame-ancestors [^;]*;/, "") };

async function framed(browser, parent, signHeaders) {
  const ctx = await browser.newContext();
  const refused = [];
  await ctx.route(SIGN, (r) => r.fulfill({ status: 200, headers: signHeaders, body: PAGE }));
  await ctx.route(`${SIGN}app.js`, (r) => r.fulfill({ status: 200, headers: { ...signHeaders, "content-type": "text/javascript" }, body: APP_JS }));
  await ctx.route(parent, (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><iframe src="${SIGN}"></iframe>` }),
  );
  const page = await ctx.newPage();
  page.on("console", (m) => /frame-ancestors/.test(m.text()) && refused.push(m.text()));
  await page.goto(parent);
  await page.waitForTimeout(500);
  const frameUrl = page.frames()[1]?.url();
  await ctx.close();
  return { loaded: frameUrl === SIGN, frameUrl, refused };
}

const browser = await launchBrowser("chromium");
const label = browserLabel(browser);
const cases = [
  ["recorded headers, framed from APP_HOST", APP, recorded, false],
  ["recorded headers, framed from https://example.com", STRANGER, recorded, false],
  ["frame-ancestors taken out, framed from APP_HOST", APP, noAncestors, true],
  ["frame-ancestors taken out, framed from https://example.com", STRANGER, noAncestors, true],
];
let ok = true;
const same = recorded["content-security-policy"] === REAL_CSP;
ok &&= same;
console.log(`${same ? "ok " : "BAD"} the recorded Content-Security-Policy is public/_headers' own`);
for (const [name, parent, headers, wantLoaded] of cases) {
  const r = await framed(browser, parent, headers);
  // the same headers load on APP_HOST, so a frame left on Chromium's error page here was blocked by frame-ancestors
  const pass = r.loaded === wantLoaded;
  ok &&= pass;
  console.log(`${pass ? "ok " : "BAD"} ${name}: ${r.loaded ? "loaded" : "blocked"} (frame ${r.frameUrl})`);
  for (const m of r.refused) console.log(`    Chromium: ${m}`);
}
await browser.close();
console.log(`frame.e2e: ${ok ? "PASS" : "FAIL"} (${label})`);
process.exit(ok ? 0 : 1);
