#!/usr/bin/env node
// Live check of card app-hop-refused: a tap that opens a SIGN_HOST page never ends in nothing. Headless Chromium loads
// APP_HOST at 390 x 844 (phone) and 1440 x 900 (desktop), waits for the signing page to be READY, taps Sign in and then
// Use passkey, and waits the kit's window for an open kind (5,000 ms) plus 1,500 ms of slack. The tap passes when the
// tab moved to SIGN_HOST (the hop opened) or the line in place of the tap shows under the control
// ([data-hop-failed="signin-passkey"], with why it did not open and Retry where a retry can work); it fails when
// neither happens, or on a pop-up. It signs nothing, makes no passkey and moves no money. A screenshot of each run is
// kept.
//   node scripts/live-checks/app-hop-refused.mjs [--url <origin>] [--shots <dir>] [--record <file>]
//   node scripts/live-checks/app-hop-refused.mjs --harness ...   the same probe on the app's browser harness
//     (apps/terminal/test/harness) with the real names mapped to it: APP_HOST serves the terminal's build
//     (apps/terminal/dist, build it first) and SIGN_HOST its real page under its own _headers
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read to <file>, so the check's test can replay it through judge().
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-hop-refused";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_HOST = "https://confidential.unrealized.trade";
export const SIGN_ORIGIN = "https://sign.confidential.unrealized.trade";
export const CONTROL = "signin-passkey";
export const OPEN_WINDOW_MS = 5_000; // SIGNPAGE_TIMEOUT_MS["signin.open"] (packages/kit/src/signpage/client.ts)
export const SLACK_MS = 1_500;
export const READY_MS = 8_000;
export const WHYS = ["refused", "error", "silent"];
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const w of WIDTHS) {
    const r = (rec.runs ?? []).find((x) => x.width === w.name);
    if (!r) {
      say(false, `${w.name}: no run`);
      continue;
    }
    if (!r.shot) say(false, `${w.name}: no screenshot`);
    if (!r.ready) {
      say(false, `${w.name}: the signing page never READY (${r.signpage ?? "no state"}), Use passkey never on`);
      continue;
    }
    const limit = OPEN_WINDOW_MS + SLACK_MS;
    const inTime = typeof r.ms === "number" && r.ms <= limit;
    if (r.outcome === "opened") say(inTime, `${w.name}: the tap opened SIGN_HOST ${Math.round(r.ms)} ms after it, limit ${limit} ms`);
    else if (r.outcome === "line") {
      const retryOk = r.line?.why === "refused" ? r.line.retry === false : r.line?.retry === true;
      say(inTime && WHYS.includes(r.line?.why) && retryOk && r.line?.inPlace === true && r.line?.text?.trim().length > 0, `${w.name}: the tap shows "${r.line?.text ?? ""}" (${r.line?.why ?? "no why"}, Retry ${r.line?.retry ? "shown" : "not shown"}${r.line?.inPlace ? ", in the sheet" : ", NOT in the sheet"}) ${typeof r.ms === "number" ? Math.round(r.ms) : "?"} ms after it, limit ${limit} ms`);
    } else say(false, `${w.name}: the tap shows nothing and opens nothing within ${limit} ms (still on ${r.url ?? "?"}, control ${r.control ?? "?"})`);
    say((r.dialogs ?? []).length === 0, `${w.name}: ${(r.dialogs ?? []).length ? `pop-ups ${r.dialogs.join(", ")}` : "no pop-up"}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const READ_LINE = (control) => {
  const el = [...document.querySelectorAll(`[data-hop-failed="${control}"]`)].find((e) => e.getClientRects().length > 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const b = document.querySelector(".sgn-box")?.getBoundingClientRect();
  return {
    why: el.dataset.hopWhy ?? null,
    text: el.querySelector(".warn")?.textContent ?? el.textContent,
    retry: el.querySelector("[data-hop-retry]") !== null,
    inPlace: !!b && r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.width > 0,
  };
};

export async function collect({ browser, url = APP_HOST, shots, source }) {
  const origin = new URL(url).origin;
  mkdirSync(shots, { recursive: true });
  const rec = { url: origin, source, at: new Date().toISOString(), browser: browser.version(), runs: [] };
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
    const page = await ctx.newPage();
    const dialogs = [];
    page.on("dialog", (d) => {
      dialogs.push(d.type());
      d.dismiss().catch(() => {});
    });
    const run = { width: w.name, ready: false, signpage: null, outcome: "none", ms: null, line: null, url: null, control: null, dialogs };
    const shot = path.join(shots, `${w.name}.png`);
    try {
      await page.goto(origin + "/", { waitUntil: "load" });
      run.ready = await page
        .waitForFunction(() => document.documentElement.dataset.signpage === "ready", null, { timeout: READY_MS, polling: 50 })
        .then(() => true)
        .catch(() => false);
      run.signpage = await page.evaluate(() => document.documentElement.dataset.signpage ?? null);
      if (run.ready) {
        await page.click(w.isMobile ? ".phh [data-header='S1.1']" : ".btn-signin");
        const ctl = `[data-control="${CONTROL}"]:visible`;
        await page.waitForSelector(ctl, { timeout: 3_000 });
        await page.waitForFunction((s) => [...document.querySelectorAll(s)].some((e) => !e.disabled), ctl.replace(":visible", ""), { timeout: 3_000 }).catch(() => {});
        const t0 = Date.now();
        await page.click(ctl);
        const limit = OPEN_WINDOW_MS + SLACK_MS;
        const left = page.waitForURL((u) => u.origin === SIGN_ORIGIN, { timeout: limit }).then(() => "opened");
        const line = page.waitForSelector(`[data-hop-failed="${CONTROL}"]:visible`, { timeout: limit }).then(() => "line");
        run.outcome = await Promise.any([left, line]).catch(() => "none");
        run.ms = run.outcome === "none" ? null : Date.now() - t0;
        if (run.outcome === "opened") await page.waitForLoadState("load").catch(() => {});
        if (run.outcome === "line") run.line = await page.evaluate(READ_LINE, CONTROL);
        run.url = page.url();
        if (run.outcome === "none") run.control = await page.evaluate((c) => [...document.querySelectorAll(`[data-control="${c}"]`)].map((e) => (e.disabled ? "off" : "on")).join(",") || "gone", CONTROL);
      }
      await page.screenshot({ path: shot });
      run.shot = shot;
    } finally {
      rec.runs.push(run);
      await ctx.close();
    }
  }
  return rec;
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const shots = opt("--shots") ?? path.join(tmpdir(), `${KEY}-${Date.now()}`);
  const record = opt("--record");
  let rec;
  if (args.includes("--harness")) {
    const { startHarness } = await import("../../apps/terminal/test/harness/harness.mjs");
    const h = await startHarness({ realNames: true });
    try {
      rec = await collect({ browser: h.browser, shots, source: "harness, SIGN_HOST's real page" });
    } finally {
      await h.close();
    }
  } else {
    const { chromium } = createRequire(path.join(REPO, "apps/terminal/package.json"))("playwright");
    const browser = await chromium.launch();
    try {
      rec = await collect({ browser, url: opt("--url") ?? APP_HOST, shots, source: "live" });
    } finally {
      await browser.close();
    }
  }
  if (record) writeFileSync(record, `${JSON.stringify(rec, null, 2)}\n`);
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, Chromium ${rec.browser}, shots ${shots})`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
