// node packages/signpage/scripts/frame.e2e.mjs: in headless Chromium, the signing page under its recorded headers
// (scripts/live-checks/signpage-skeleton.answers.json, good) loads in a frame on APP_HOST and is blocked in a frame on
// https://example.com; under the same headers with frame-ancestors taken out it loads on example.com too, so the
// probe can fail. No network: Playwright answers every request from the recorded headers and packages/signpage.
// Run it through scripts/heavy.sh (Playwright is a heavy job). exit 0 all as expected, 1 otherwise.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(dirname(PKG));
const GOOD = JSON.parse(readFileSync(join(REPO, "scripts/live-checks/signpage-skeleton.answers.json"), "utf8")).good;
const PAGE = readFileSync(join(PKG, "index.html"), "utf8");
const SIGN = "https://sign.confidential.unrealized.trade/";
const APP = "https://confidential.unrealized.trade/";
const STRANGER = "https://example.com/";
const DROP = new Set(["content-encoding", "transfer-encoding", "content-length", "date", "etag"]);
const recorded = Object.fromEntries(Object.entries(GOOD.headers).filter(([k]) => !DROP.has(k)));
const noAncestors = { ...recorded, "content-security-policy": recorded["content-security-policy"].replace(/ ?frame-ancestors [^;]*;/, "") };

async function framed(browser, parent, signHeaders) {
  const ctx = await browser.newContext();
  const refused = [];
  await ctx.route(SIGN, (r) => r.fulfill({ status: 200, headers: signHeaders, body: PAGE }));
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

const browser = await chromium.launch();
const version = browser.version();
const cases = [
  ["recorded headers, framed from APP_HOST", APP, recorded, true],
  ["recorded headers, framed from https://example.com", STRANGER, recorded, false],
  ["frame-ancestors taken out, framed from https://example.com", STRANGER, noAncestors, true],
];
let ok = true;
for (const [name, parent, headers, wantLoaded] of cases) {
  const r = await framed(browser, parent, headers);
  // the same headers load on APP_HOST, so a frame left on Chromium's error page here was blocked by frame-ancestors
  const pass = r.loaded === wantLoaded;
  ok &&= pass;
  console.log(`${pass ? "ok " : "BAD"} ${name}: ${r.loaded ? "loaded" : "blocked"} (frame ${r.frameUrl})`);
  for (const m of r.refused) console.log(`    Chromium: ${m}`);
}
await browser.close();
console.log(`frame.e2e: ${ok ? "PASS" : "FAIL"} (Chromium ${version})`);
process.exit(ok ? 0 : 1);
