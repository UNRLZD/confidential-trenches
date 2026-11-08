#!/usr/bin/env node
// Live check of card app-shell-rpc-outage-judge: the shared judgment of a down RPC (rpc-outage.mjs, used by app-shell,
// app-verify-mount and verify-pools) lets an outage through only when the page shows it. Chrome writes a console error
// for every failed load, so a down RPC the page reads failed the after-deploy checks, and a failing live check undoes the
// deploy. The judgment lets a failed Verify read through when its origin is one the release names (VERIFY_RELEASES: the
// NEAR pair, each pool's pair) and the same load's Verify panel shows the rows that read it amber (Unverified), and a
// failed footer block read through when the footer's DOM shows the pair answered by its other RPC. This check runs it
// over the deployed page's own /verify load, at 390 x 844 (phone) and 1440 x 900 (desktop), inside SIGN_HOST's shell:
//   - the evidence the judge reads is on the deployed page: after its reads end the panel is drawn (not loading) with a
//     status on the Code and Funds rows and on each pool's row (data-row, data-pool, data-status), and on desktop the
//     footer is drawn (data-conn, data-block), so a renamed attribute cannot silently turn every outage into a failure
//     or the judge into a pass of nothing;
//   - the release names its RPC origins (derived, none typed here), and every failed load of one of them on this load is
//     shown by the page: a Verify read's rows Unverified, a footer read's footer on with its block. A failed load the
//     page shows ok, or never drew, or a footer that shows Offline, FAILs: that is an outage the page does not show, or a
//     double outage, which fails closed.
// A load with no failed load of a release RPC passes on the first two. Other console errors are app-shell's to judge.
// After: app
//   node scripts/live-checks/app-shell-rpc-outage-judge.mjs [--url <origin>] [--shots <dir>] [--record <file>]
//   node scripts/live-checks/app-shell-rpc-outage-judge.mjs --harness [--build <dir>] [--outage footer|footer-pair|solana|base|robinhood] ...
//     the hosts' real names answered from local files (app-in-shell.mjs harnessRoute); --outage makes a real RPC outage
//     in the browser's own requests (app-shell.mjs withOutage): solana, base or robinhood, a pool's first RPC answering
//     503 (its row goes amber: PASS); footer, the first NEAR RPC answering the footer's block reads 503 while the other
//     answers (the footer shows Stable: PASS); footer-pair, both NEAR RPCs answering them 503 (the footer shows Offline
//     while Verify's reads are answered: FAIL, the test's bad answer)
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessRoute } from "./app-in-shell.mjs";
import { APP_HOST, open, watch, WIDTHS, withOutage } from "./app-shell.mjs";
import { footerEvidence, outages, rpcRows, verifyEvidence } from "./rpc-outage.mjs";
import { launchBrowser } from "../browsers.mjs";
import { named } from "./record-names.mjs";

const KEY = "app-shell-rpc-outage-judge";
const SETTLE_MS = 2000;
const STATUS = ["ok", "warn", "danger"];
const POOLS = ["solana", "base", "robinhood"];

const host = (o) => o.replace(/^https?:\/\//, "");

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const rows = rpcRows(rec.network);
  say(rows.size > 0, `the release names ${rows.size} RPC origin(s) on ${rec.network ?? "mainnet"}: ${[...rows.keys()].map(host).join(", ") || "none"}`);
  const loads = rec.loads ?? [];
  say(loads.length === WIDTHS.length, `${loads.length} load(s) of /verify of ${WIDTHS.length} (both widths)`);
  for (const l of loads) {
    const v = l.verify;
    const drawn = [["code", v?.code], ["funds", v?.funds], ...POOLS.map((c) => [c, v?.pools?.[c]])];
    const bad = [];
    if (l.framed !== true) bad.push(`not inside SIGN_HOST's shell (top window at ${l.top ?? "unknown"})`);
    const missing = drawn.filter(([, s]) => !STATUS.includes(s)).map(([r, s]) => `${r} ${s ?? "not drawn"}`);
    if (!v) bad.push("no Verify panel in the DOM");
    else if (missing.length) bad.push(`the panel's reads did not end or a row is not drawn (${missing.join(", ")})`);
    // the desktop draws the footer, whose block read is the other RPC path: its DOM is part of the evidence
    if (l.width === "desktop" && !l.footer) bad.push("no footer in the DOM");
    const { down, refused } = outages(l.consoleErrors ?? [], v, rec.network, l.footer);
    if (refused.length) bad.push(`a release RPC failed to load and the page does not show it: ${refused.join("; ")}`);
    say(bad.length === 0, `${l.width} /verify: ${bad.length ? bad.join("; ") : `panel drawn (${drawn.map(([r, s]) => `${r} ${s}`).join(", ")}), ${down.length ? `RPC down and shown: ${down.map(host).join(", ")}` : "no failed load of a release RPC"}`}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
export async function collect({ url = APP_HOST, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route = null, source = "live", network = "mainnet" } = {}) {
  const origin = new URL(url).origin;
  mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  const rec = { url: origin, network, source, at: new Date().toISOString(), browser: browser.version(), loads: [] };
  try {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
      if (route) await ctx.route("**/*", route);
      const page = await ctx.newPage();
      const seenBy = watch(page, origin);
      const { doc, framed, top } = await open(page, `${origin}/verify`, origin);
      await doc.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(SETTLE_MS);
      const verify = await verifyEvidence(doc);
      const footer = await footerEvidence(doc);
      const shot = `${w.name}-verify.png`;
      await page.screenshot({ path: path.join(shots, shot) });
      rec.loads.push({ width: w.name, path: "/verify", framed, top, consoleErrors: seenBy.consoleErrors, verify, footer, shot });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  rec.shots = shots;
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let rec;
    if (a.includes("--harness")) {
      const build = path.resolve(opt("--build", fileURLToPath(new URL("../../apps/terminal/dist", import.meta.url))));
      const outage = opt("--outage", null);
      const base = await harnessRoute(build);
      rec = await collect({ shots: opt("--shots", undefined), route: outage ? withOutage(base, outage) : base, source: `harness, ${named(build)}${outage ? `, ${outage} RPC answering 503` : ""}` });
    } else rec = await collect({ url: opt("--url", APP_HOST), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
