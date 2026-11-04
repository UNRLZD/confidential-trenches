#!/usr/bin/env node
// Live check of card trade-box-pool: on a chain whose pool the signing page reports, APP_HOST's trade box is on the pool
// path, shows whether a proof is ready, and a tap never sends the vault's buy. APP_HOST's terminal is framed by a stand-in
// for SIGN_HOST's shell (app-in-shell.mjs) that sends a signed-in state holding the devnet Solana pool as the signing page
// reported it after the recorded pool deposit (signpage-pool-notes.run.json: one 0.01 SOL note; tap_max by the kit's own
// rule, solanaPoolBuyMaxSpend at the worst venue, the 0.001 SOL tip cap, rent 5,080/1: 1,736,080 lamports), once with the
// proof ready and once with it still making, since no check can sign a real account in. Headless Chromium opens / (the
// token route, a Solana token) at 1440 x 900 (desktop, the box in the right column) and 390 x 844 (phone, dpr 2, the
// bar's Buy opens the trade sheet) and reads:
//   - the box is on the pool path (data-path="pool");
//   - its proof label is the state's: ready with the proof ready, making while it is not, and it has words;
//   - one tap on its main button asks the shell for no vault buy (kind "buy"): only pool.buy, or nothing while the box
//     cannot price the pool.
// Node reads the served / first and records the build's entry script, so a run names the build it judged.
//   node scripts/live-checks/trade-box-pool.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/trade-box-pool.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";

const KEY = "trade-box-pool";
export const APP_HOST = "https://confidential.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://api.confidential.unrealized.trade";
/** The devnet Solana pool after the recorded 0.01 SOL deposit, with the proof ready ("ready") or still making ("making"). */
export const POOL = {
  ready: { chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0.00173608" },
  making: { chain: "solana", asset: "SOL", balance: "0.01", ready: "0" },
};
/** The signed-in state the stand-in shell sends: cash in the vault too, so a box on the vault's path would buy from it. */
export const account = (proof) => ({
  release: "harness-shell",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "73.18",
  pools: [POOL[proof]],
  wallets: [],
  positions: [],
  orders: [],
  held: [],
  ops: [],
});
export const PROOFS = ["ready", "making"];
export const WIDTHS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const READY_MS = 20_000;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  say(typeof rec.entry === "string" && /^\/assets\/[\w.-]+\.js$/.test(rec.entry), `the served / names its entry script ${rec.entry ?? "none"}`);
  const runs = rec.runs ?? [];
  const want = WIDTHS.flatMap((w) => PROOFS.map((p) => `${w.name} ${p}`));
  const have = new Set(runs.map((r) => `${r.width} ${r.proof}`));
  say(want.every((k) => have.has(k)), `${runs.length} run(s) of ${want.length} (desktop and phone, a proof ready and making)`);
  for (const r of runs) {
    const n = `${r.width} ${r.proof}`;
    const bad = [];
    if (r.framed !== true) bad.push("not inside SIGN_HOST's shell");
    if (r.route !== "token") bad.push(`drew ${r.route ?? "nothing"}, not the token route`);
    if (!r.box) bad.push("no trade box");
    else {
      if (r.box.path !== "pool") bad.push(`the box is on the ${r.box.path ?? "unmarked"} path, not the pool's`);
      if (r.box.proof !== r.proof) bad.push(`its proof label is ${r.box.proof ?? "none"}, the state's is ${r.proof}`);
      else if (!r.box.proofText) bad.push("its proof label has no words");
      const sent = r.sent ?? null;
      if (sent === null) bad.push("the tap was not read");
      else if (sent.includes("buy")) bad.push(`a tap asked the shell for the vault's buy (${sent.join(", ")})`);
      else if (sent.some((k) => k !== "pool.buy")) bad.push(`a tap asked the shell for ${sent.join(", ")}`);
    }
    if (!r.shot) bad.push("no screenshot");
    say(bad.length === 0, `${n}: ${bad.length ? bad.join("; ") : `the box is on the pool path, its proof label "${r.box.proofText}" (${r.proof}), a tap asked for ${r.sent.length ? r.sent.join(", ") : "nothing"}`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const READ = (sheet) => {
  const main = document.querySelector("main[data-route]");
  const scope = sheet ? document.querySelector('[data-sheet="trade"]') : main?.querySelector(".tkp-desk .tkp-trade");
  const el = scope?.querySelector('[data-testid="trade-box"]');
  const p = el?.querySelector('[data-testid="trade-proof"]');
  return {
    route: main?.dataset.route ?? null,
    box: el ? { path: el.getAttribute("data-path"), proof: p?.getAttribute("data-proof") ?? null, proofText: p?.textContent?.trim() || null, cta: el.querySelector('[data-testid="trade-cta"]')?.textContent?.trim() ?? null } : null,
  };
};

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

async function terminal(page) {
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    const f = page.frames().find((x) => x !== page.mainFrame() && originOf(x.url()) === APP_HOST);
    if (f) return f;
    await page.waitForTimeout(100);
  }
  return null;
}

const asked = async (page, from) => (await page.evaluate(() => window.__ctShellSeen ?? [])).slice(from).filter((k) => k !== "state" && k !== "nav");
const seen = (page) => page.evaluate(() => (window.__ctShellSeen ?? []).length);

async function runOne(browser, w, proof, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, proof, framed: false, route: null, box: null, sent: null, shot: null };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector('main[data-route="token"] [data-token-page="ready"]', { timeout: READY_MS }).catch(() => {});
    if (w.isMobile) {
      await f.locator(".tkp-buy").filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
      await f.locator('[data-sheet="trade"]').waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    }
    const sel = w.isMobile ? '[data-sheet="trade"] [data-testid="trade-box"]' : '.tkp-desk .tkp-trade [data-testid="trade-box"]';
    // the shell's signed-in state has landed when the box's button no longer asks to sign in
    await f.waitForFunction((s) => { const t = document.querySelector(`${s} [data-testid="trade-cta"]`)?.textContent?.trim(); return !!t && t !== "Sign in to trade"; }, sel, { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(400);
    Object.assign(run, await f.evaluate(READ, w.isMobile));
    run.shot = `${w.name}-${proof}.png`;
    await page.screenshot({ path: path.join(shots, run.shot) });
    if (!run.box) return run;
    const from = await seen(page);
    await f.locator(`${sel} [data-testid="trade-cta"]`).click({ force: true, timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(800);
    run.sent = await asked(page, from);
    await page.screenshot({ path: path.join(shots, `${w.name}-${proof}-tap.png`) });
    return run;
  } finally {
    await ctx.close();
  }
}

/** The served / and its entry script: from `build` on the harness, else APP_HOST as served. */
async function entryOf(build) {
  const html = build ? readFileSync(path.join(build, "index.html"), "utf8") : await (await fetch(`${APP_HOST}/`, { signal: AbortSignal.timeout(15_000) })).text();
  return html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? null;
}

export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), build = null, source }) {
  mkdirSync(shots, { recursive: true });
  const entry = await entryOf(build);
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const proof of PROOFS) {
      const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: account(proof) });
      // the deployed run reads only the shell from the stand-in; APP_HOST and the helper as served
      const route = build ? shell : (r) => (originOf(r.request().url()) === APP_HOST || originOf(r.request().url()) === HELPER_HOST ? r.continue() : shell(r));
      for (const w of WIDTHS) runs.push(await runOne(browser, w, proof, shots, route));
    }
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), entry, shots, runs };
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let build = null;
    let source = `live ${APP_HOST}, the stand-in shell signed in with the devnet pool`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      const rel = path.relative(REPO, build);
      source = `harness, terminal build ${rel && !rel.startsWith("..") ? rel : "<build>"}, the stand-in shell signed in with the devnet pool`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), build, source });
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
