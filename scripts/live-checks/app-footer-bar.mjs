#!/usr/bin/env node
// Live check of card app-footer-bar: the desktop footer shows the connection and NEAR's block as read, the block
// moving, and links only to pages the app has. Signed out (a fresh browser, as every first visit is), headless Chromium
// opens APP_HOST at 1440 x 900, finds the terminal's frame inside SIGN_HOST's shell (card app-in-shell) and reads the
// footer twice, READ_GAP_MS apart:
//   - each read: the connection Stable with its round trip in ms, and a block number;
//   - the block moved between the two reads, and each is within NEAR_SLACK of NEAR's final block this check reads
//     itself on a public RPC at the same moment, so the footer draws the chain's block, never a made-up or static one;
//   - the footer's links are exactly Terms, Privacy and Verify, each a route the app has;
//   - no price is drawn: signed out the signing page reads none, so a price there would be one the app did not read.
// A screenshot of the page and of the footer at each read is kept.
//   node scripts/live-checks/app-footer-bar.mjs [--shots <dir>] [--record <file>]
//     the deployed hosts: APP_HOST as it is served, signed out
//   node scripts/live-checks/app-footer-bar.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at the hosts' real names inside app-in-shell's stand-in
//     shell, signed out; NEAR's final block answered by a local chain that finalises a block every 600 ms
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { named } from "./record-names.mjs";

const KEY = "app-footer-bar";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_HOST = "https://ct-app.unrealized.trade";
export const SIGN_HOST = "https://confidential.unrealized.trade";
/** The mainnet pair the footer reads (apps/terminal/src/screens/verify/release.ts); the check's own read is on the first. */
export const NEAR_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
export const LINKS = ["/terms", "/privacy", "/verify"];
/** The routes the app has (apps/terminal/src/routes/routes.ts). */
export const ROUTES = ["/", "/discover", "/portfolio", "/orders", "/profile", "/verify", "/privacy", "/terms"];
/** The footer reads every 3 s; two reads this far apart are at least two footer reads apart. */
export const READ_GAP_MS = 7_000;
/** The footer's block may trail the check's own read by up to its read period, a slow answer and one RPC's lag: at
 *  NEAR's ~0.6 s blocks, 100 blocks is a minute. It may never be ahead by more than one RPC's lag. */
export const NEAR_SLACK = { behind: 100, ahead: 10 };
const VIEWPORT = { width: 1440, height: 900 };
const READY_MS = 15_000;
const BLOCK_MS = 15_000;

// ------------------------------------------------------------------------------------------------ the verdict
const showRead = (r) => (r ? `Block ${r.block ?? "none"}, ${r.conn ?? "no connection state"}${r.ms === null ? "" : ` ${r.ms} ms`}, NEAR's final block ${r.near ?? "not read"}` : "not read");

export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  say(rec.framed === true, rec.framed ? "inside SIGN_HOST's shell" : `not inside SIGN_HOST's shell (${rec.top ?? "no frame"})`);
  say(rec.header === "S1.1", `the header is ${rec.header === "S1.1" ? "signed out (S1.1)" : `${rec.header ?? "not drawn"}, not signed out (S1.1)`}`);
  const reads = rec.reads ?? [];
  say(reads.length === 2, `${reads.length} footer read(s) of 2`);
  reads.forEach((r, i) => {
    const n = `read ${i + 1}`;
    say(r.conn === "on" && /^Stable\b/.test(r.health ?? "") && Number.isInteger(r.ms) && r.ms > 0, `${n}: connection ${r.conn === "on" ? `"${r.health}", ${r.ms} ms` : `${r.conn ?? "not drawn"} ("${r.health ?? ""}")`}${r.conn === "on" && !(Number.isInteger(r.ms) && r.ms > 0) ? ", no round trip" : ""}`);
    const isBlock = Number.isSafeInteger(r.block) && r.block > 0;
    say(isBlock && r.blockText === `Block ${r.block.toLocaleString("en-US")}`, `${n}: ${isBlock ? `draws "${r.blockText}"` : `no block drawn ("${r.blockText ?? ""}")`}`);
    if (isBlock && Number.isSafeInteger(r.near)) {
      const d = r.block - r.near;
      say(d >= -NEAR_SLACK.behind && d <= NEAR_SLACK.ahead, `${n}: ${showRead(r)}: ${d === 0 ? "the same block" : `${Math.abs(d)} block(s) ${d < 0 ? "behind" : "ahead"}`} (within -${NEAR_SLACK.behind}..+${NEAR_SLACK.ahead})`);
    } else say(false, `${n}: ${showRead(r)}: not held to NEAR's final block`);
    say((r.ticks ?? []).length === 0, `${n}: ${(r.ticks ?? []).length ? `prices drawn signed out (${r.ticks.join(", ")}), none read` : "no price drawn signed out"}`);
  });
  if (reads.length === 2) {
    const [a, b] = reads;
    say(Number.isSafeInteger(a.block) && Number.isSafeInteger(b.block) && b.block > a.block, `the block moved: ${a.block ?? "none"} -> ${b.block ?? "none"} over ${b.at - a.at} ms`);
  }
  const links = rec.links ?? [];
  const same = links.length === LINKS.length && LINKS.every((l, i) => links[i] === l);
  say(same, `the footer's links: ${links.join(" ") || "none"}${same ? "" : ` (not ${LINKS.join(" ")})`}`);
  const gone = links.filter((l) => !ROUTES.includes(l));
  say(gone.length === 0, gone.length ? `links to pages the app does not have: ${gone.join(" ")}` : "every link is a route the app has");
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const READ_FOOTER = () => {
  const ft = document.querySelector("footer.ft");
  if (!ft) return null;
  const b = ft.querySelector("[data-block]");
  const h = ft.querySelector("[data-conn]");
  const conn = ft.querySelector(".conn")?.textContent ?? "";
  const ms = /(\d+) ms$/.exec(conn.trim());
  return {
    visible: ft.getClientRects().length > 0,
    blockText: b?.textContent?.trim() ?? null,
    block: b?.dataset.block ? Number(b.dataset.block) : null,
    conn: h?.dataset.conn ?? null,
    health: h?.textContent?.trim() ?? null,
    ms: ms ? Number(ms[1]) : null,
    ticks: [...ft.querySelectorAll("[data-tick]")].map((t) => t.textContent.trim()),
    links: [...ft.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
  };
};

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

/** NEAR's final block height on `url`, or null. */
export async function nearFinal(url = NEAR_RPCS[0]) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: KEY, method: "block", params: { finality: "final" } }), signal: AbortSignal.timeout(5_000) });
    const h = (await res.json())?.result?.header?.height;
    return Number.isSafeInteger(h) ? h : null;
  } catch {
    return null;
  }
}

/** A local chain for the harness: its final block grows one per 600 ms from a mainnet-sized height. */
export function localChain(start = 223_500_000, now = () => Date.now()) {
  const t0 = now();
  return { height: () => start + Math.floor((now() - t0) / 600) };
}

/** Every request in Chromium answered by `route` (the harness), or the deployed hosts when null. `near` reads the chain. */
export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route = null, near = nearFinal, source = "live" } = {}) {
  mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  const rec = { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, framed: false, top: null, header: null, reads: [], links: [] };
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    if (route) await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
    rec.top = page.url();
    let f = null;
    for (const until = Date.now() + READY_MS; !f && Date.now() < until; ) {
      f = page.frames().find((x) => x !== page.mainFrame() && originOf(x.url()) === APP_HOST) ?? null;
      if (!f) await page.waitForTimeout(100);
    }
    rec.framed = f !== null && originOf(rec.top) === SIGN_HOST;
    if (!f) return rec;
    await f.waitForSelector(".tb [data-header]", { timeout: READY_MS }).catch(() => {});
    rec.header = await f.$eval(".tb [data-header]", (e) => e.dataset.header).catch(() => null);
    await f.waitForSelector("footer.ft [data-block]:not([data-block=''])", { timeout: BLOCK_MS }).catch(() => {});
    for (let i = 0; i < 2; i++) {
      if (i) await page.waitForTimeout(READ_GAP_MS);
      const [r, n] = await Promise.all([f.evaluate(READ_FOOTER), near()]);
      rec.reads.push({ ...(r ?? {}), near: n, at: Date.now() });
      if (i === 0) rec.links = r?.links ?? [];
      await page.screenshot({ path: path.join(shots, `desktop-1440-read${i + 1}.png`) });
      await f.locator("footer.ft").screenshot({ path: path.join(shots, `desktop-1440-footer-read${i + 1}.png`) }).catch(() => {});
    }
    for (const r of rec.reads) delete r.links;
    return rec;
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let route = null;
    let near = nearFinal;
    let source = `live ${APP_HOST}`;
    if (a.includes("--harness")) {
      const build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      const { harnessRoute } = await import("./app-in-shell.mjs");
      // the stand-in shell's signed-out state ("tap"), as a first visit is
      const shell = await harnessRoute(build, "tap");
      const chain = localChain();
      const rpcs = new Set(NEAR_RPCS.map(originOf));
      route = async (r) => {
        const req = r.request();
        let body = null;
        try {
          body = JSON.parse(req.postData() ?? "");
        } catch {}
        if (rpcs.has(originOf(req.url())) && body?.method === "block" && body?.params?.finality === "final") {
          return r.fulfill({ status: 200, headers: { "access-control-allow-origin": APP_HOST, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { header: { height: chain.height() } } }) });
        }
        return shell(r);
      };
      near = async () => chain.height();
      source = `harness, terminal build ${named(build)}, signed out, a local chain at 600 ms blocks`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), route, near, source });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source}, Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
