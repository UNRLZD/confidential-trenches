#!/usr/bin/env node
// Live check of card signin-e2e-step-timing-same-every-run: when SIGN_HOST's shell closes a sealed screen and makes a new
// APP_HOST frame, the page's own ground covers that frame, under the sheet's dim, until the frame has painted, then fades
// out with the dim. Before the card the ground sat under the frame, so the frame's first paint (a phone's sparse boot
// frame, its logo not yet loaded) showed under the full dim as one colour: 117 ms in merge queue run 44975766389.
// SIGN_HOST's / is opened in Chrome at 390 x 844 (phone, dpr 2) and 1440 x 900, and the top document's stacking is read
// as computed: the ground (#ground) on the dim's level (data-sheet veil) and before it in the body, so under it; both
// over the APP_HOST frame (#app); the ground's transition the dim's, an opacity fade.
// After: sign
// Bundle: out a browser
//   node scripts/live-checks/signin-e2e-step-timing-same-every-run.mjs [--url <origin>] [--record <file>]
//   node scripts/live-checks/signin-e2e-step-timing-same-every-run.mjs --harness [--record <file>]   this tree's SIGN_HOST
//     build and the terminal's (apps/terminal/dist) on their real names in the app's browser harness
//   PASS exit 0, FAIL exit 1, error exit 2. Records hold stack levels, body positions and transitions only.
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";

const KEY = "signin-e2e-step-timing-same-every-run";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
export const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const READY_MS = 20_000;

/** The verdict on a record: { ok, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const runs = rec?.runs ?? [];
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `read at ${WIDTHS.map((w) => w.name).join(" and ")} (${runs.map((r) => r.width).join(", ") || "none"})`);
  for (const r of runs) {
    const { ground: g, veil: v, frame: f } = r;
    if (!g || !v || !f) {
      say(false, `@${r.width} the ground, the dim and the APP_HOST frame are in the page (${["ground", "veil", "frame"].filter((k) => !r[k]).join(", ")} missing)`);
      continue;
    }
    const z = (x) => (Number.isInteger(x.z) ? x.z : 0);
    say(z(g) > z(f), `@${r.width} the ground stacks over the APP_HOST frame (z ${g.z} over ${f.z})`);
    say(z(g) === z(v) && g.index < v.index, `@${r.width} the dim stacks over the ground (z ${g.z} and ${v.z}, body positions ${g.index} and ${v.index})`);
    say(/opacity/.test(g.transition ?? "") && g.transition === v.transition, `@${r.width} the ground fades as the dim does (${g.transition} / ${v.transition})`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

/** The top document's stacking, read in the page once the shell has made its frame. */
function read() {
  const at = (el) => (el ? [...document.body.children].indexOf(el) : -1);
  const one = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return { z: s.zIndex === "auto" ? s.zIndex : Number(s.zIndex), transition: s.transition, index: at(el) };
  };
  return { ground: one(document.getElementById("ground")), veil: one(document.querySelector('[data-sheet="veil"]')), frame: one(document.getElementById("app")) };
}

/** Opens `url` at each width in `browser` and returns the record. */
export async function collect(browser, url) {
  const rec = { key: KEY, at: new Date().toISOString(), url, runs: [] };
  for (const w of WIDTHS) {
    const { name, ...opts } = w;
    const context = await browser.newContext(opts);
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "load", timeout: READY_MS });
      await page.waitForSelector("#app", { state: "attached", timeout: READY_MS });
      rec.runs.push({ width: name, ...(await page.evaluate(read)) });
    } finally {
      await context.close();
    }
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  let h = null;
  let browser = null;
  try {
    let url = `${(opt("--url") ?? SIGN_ORIGIN).replace(/\/$/, "")}/`;
    if (args.includes("--harness")) {
      const { REAL, startHarness } = await import("../../apps/terminal/test/harness/harness.mjs");
      h = await startHarness({ realNames: true });
      browser = h.browser;
      url = `https://${REAL.sign}/`;
    } else browser = await launchBrowser("chromium");
    const rec = await collect(browser, url);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${url}${h ? ", harness" : ""})`);
    process.exitCode = r.ok ? 0 : 1;
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exitCode = 2;
  } finally {
    if (h) await h.close();
    else await browser?.close();
  }
}
