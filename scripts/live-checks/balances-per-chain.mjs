#!/usr/bin/env node
// Live check of card balances-per-chain: Portfolio draws each chain's pool from the signing page's state, as the page
// sends it. It covers the deployed screen, not the signing page's sum of the device's notes (that sum is the wallet
// package's pool balances and its tests; a read of a real device note joins the money-path run on pool deploy day).
// Headless Chromium opens APP_HOST/portfolio at 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1) inside a
// stand-in SIGN_HOST shell (Playwright's route answers SIGN_HOST's name; the shell frames APP_HOST, posts `ready` and
// answers `state` with ANSWER below: three pools in SOL and ETH, one with a ready, one with none sent, one with nothing in
// it) and reads, in the form on screen:
//   - the pool block's view is "rows", with one row per pool in the answer's order, its chain and asset, and its
//     balance, ready and pending in the asset's base units (pending = balance - ready), the answer's decimals read at the
//     kit's table (POOL_ASSET_DECIMALS), rounded down;
//   - each pool is drawn in its own asset: the balance names it ("12.5 SOL") and no amount in a pool row is a dollar
//     figure (a SOL or ETH pool has none until a price read exists);
//   - a pool the answer sends with no ready draws Ready and Pending as a dash, never 0; one with a ready draws a number;
//   - no CSP violation, no console error and no page error in the terminal's frame (one with no address counts).
// It passes on the deployed host once Portfolio is mounted on /portfolio (card app-portfolio-mount) and this card is
// deployed. A screenshot of each width is kept.
// After: app
//   node scripts/live-checks/balances-per-chain.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST as it is served (only SIGN_HOST's name is answered by the stand-in shell)
//   node scripts/live-checks/balances-per-chain.mjs --harness [--build <dir>] ...
//     APP_HOST answered from a local build (apps/terminal/dist, or --build <dir>) under its own _headers
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POOL_ASSET_DECIMALS } from "../../packages/kit/src/index.ts";
import { APP_HOST, harnessRoute, shellHeaders, SIGN_HOST } from "./app-in-shell.mjs";
import { launchBrowser } from "../browsers.mjs";
import { watchErrors } from "./console-errors.mjs";
import { downNote, footerEvidence, outages } from "./rpc-outage.mjs";
import { named } from "./record-names.mjs";

const KEY = "balances-per-chain";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PATH = "/portfolio";
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const READY_MS = 20_000;

/** The pools the stand-in shell sends: a ready, no ready (no proof queue running), and an empty pool. */
export const POOLS = [
  { chain: "solana", asset: "SOL", balance: "12.5", ready: "10" },
  { chain: "base", asset: "ETH", balance: "0.25" },
  { chain: "robinhood", asset: "ETH", balance: "0", ready: "0" },
];
export const ANSWER = { release: "check-shell", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [], pools: POOLS };

/** A decimal string in whole units of `asset` to base units at the kit's decimals, rounded down; null when it is not one. */
export function base(s, asset) {
  const d = POOL_ASSET_DECIMALS[asset];
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(s));
  return m && d !== undefined ? BigInt(m[1] + ((m[2] ?? "") + "0".repeat(d)).slice(0, d)).toString() : null;
}

// ------------------------------------------------------------------------------------------------ the verdict
/** The check's error hooks on its page: every console error and page error of the terminal's frame (an APP_HOST
 *  address), and every one with no address, kept through the shared collector (console-errors.mjs) as its text and its
 *  address's origin and path (card live-pageerror-hooks). */
export function watch(page, errors) {
  watchErrors(page, errors, (url) => url.startsWith(APP_HOST));
}

export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const pools = rec.answer?.pools ?? [];
  const runs = rec.runs ?? [];
  say(pools.length > 0 && pools.some((p) => p.ready === undefined) && pools.some((p) => p.ready !== undefined), `the answer sends ${pools.length} pool(s), with and without a ready`);
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `${runs.length} run(s) of ${WIDTHS.length} (every width)`);
  for (const r of runs) {
    const n = `${r.width} ${PATH}`;
    say(r.view === "rows", `${n}: the pool block ${r.view ? `is ${r.view}` : "is not drawn"}, want rows`);
    const rows = r.rows ?? [];
    say(rows.length === pools.length && rows.every((x, i) => x.chain === pools[i].chain), `${n}: rows ${rows.map((x) => x.chain).join(", ") || "none"}, want ${pools.map((p) => p.chain).join(", ")}`);
    for (const p of pools) {
      const x = rows.find((y) => y.chain === p.chain);
      if (!x) {
        say(false, `${n}: no row for ${p.chain}`);
        continue;
      }
      const bal = base(p.balance, p.asset);
      say(x.asset === p.asset && x.balance === bal, `${n}: ${p.chain} balance ${x.balance} base units of ${x.asset}, want ${bal} of ${p.asset}`);
      say(new RegExp(`^<?[0-9][0-9.,]*[KMB]? ${p.asset}$`).test(x.text[1] ?? "") && !x.text.some((t) => t.includes("$")), `${n}: ${p.chain} drawn ${JSON.stringify(x.text.slice(1))}: the balance in ${p.asset}, no dollar figure`);
      if (p.ready === undefined) {
        say(x.ready === "none" && x.pending === "none" && x.text[2] === "—" && x.text[3] === "—", `${n}: ${p.chain} sends no ready: Ready ${JSON.stringify(x.text[2])} and Pending ${JSON.stringify(x.text[3])} (${x.ready}, ${x.pending}), want dashes, never 0`);
      } else {
        const rd = base(p.ready, p.asset);
        const pd = (BigInt(bal) - BigInt(rd)).toString();
        say(x.ready === rd && x.pending === pd && /^<?[0-9]/.test(x.text[2] ?? "") && /^<?[0-9]/.test(x.text[3] ?? ""), `${n}: ${p.chain} ready ${x.ready} and pending ${x.pending} drawn ${JSON.stringify(x.text[2])} and ${JSON.stringify(x.text[3])}, want ${rd} and ${pd} as numbers`);
      }
    }
    // a footer read of a release NEAR RPC that failed (its preflight line is the page's own), the footer showing the pair
    // answered, is no error; any other failed load of a release RPC needs a Verify panel, and /portfolio draws none
    const { kept, down } = outages(r.errors ?? [], null, "mainnet", r.footer);
    const errs = [...(r.violations ?? []).map((v) => `CSP ${v.directive} ${v.blocked}`), ...kept.map((e) => `console ${e}`)];
    say(errs.length === 0, `${n}: ${errs.length ? errs.join("; ") : `no CSP violation, no console error${downNote(down)}`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok")), lines };
}

// ------------------------------------------------------------------------------------------------ the stand-in shell
// As app-in-shell.mjs's: frames APP_HOST at its own path, posts `ready` on each load, answers `state` from that frame
// only with ANSWER, keeps nav in the address, refuses every other kind (not_allowed). Its headers are SIGN_HOST's.
const shellJs = () => `const APP = ${JSON.stringify(APP_HOST)};
const STATE = ${JSON.stringify(ANSWER)};
const f = document.createElement("iframe");
f.src = APP + location.pathname + location.search;
f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
f.addEventListener("load", () => f.contentWindow.postMessage({ v: 1, type: "ready", release: "check-shell", api: 1 }, APP));
addEventListener("message", (e) => {
  if (e.origin !== APP || e.source !== f.contentWindow || !e.data || typeof e.data.id !== "string") return;
  const p = e.data.path;
  const nav = e.data.type === "nav" && typeof p === "string" && p.startsWith("/") && p[1] !== "/" && p[1] !== "\\\\";
  if (nav) history.replaceState(null, "", location.origin + new URL(APP + p).pathname + new URL(APP + p).search);
  const answer = e.data.type === "state" ? { v: 1, id: e.data.id, ok: true, result: STATE } : nav ? { v: 1, id: e.data.id, ok: true, result: {} } : { v: 1, id: e.data.id, ok: false, error: { code: "not_allowed" } };
  f.contentWindow.postMessage(answer, APP);
});
document.body.appendChild(f);
`;
const SHELL_CSS = "html,body{margin:0;height:100%;background:#000}iframe{display:block;border:0;width:100%;height:100%}\n";
const sri = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const shellHtml = (js) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Shell</title><link rel="stylesheet" href="/shell.css" integrity="${sri(SHELL_CSS)}" crossorigin="anonymous"></head>
<body><script src="/shell.js" integrity="${sri(js)}" crossorigin="anonymous"></script></body></html>
`;

async function route(build) {
  const { parseHeadersFile } = await import("../../apps/terminal/scripts/check-deploy.ts");
  const { headersFor } = await import("../../apps/terminal/test/harness/server.mjs");
  const p = parseHeadersFile(shellHeaders(readFileSync(path.join(REPO, "packages/signpage/public/_headers"), "utf8")));
  if (p.problems.length) throw new Error(`${KEY}: SIGN_HOST _headers: ${p.problems.join("; ")}`);
  const js = shellJs();
  const files = { "/shell.js": [js, "text/javascript; charset=utf-8"], "/shell.css": [SHELL_CSS, "text/css; charset=utf-8"] };
  const app = build ? await harnessRoute(build) : null;
  return async (r) => {
    const u = new URL(r.request().url());
    if (u.origin === SIGN_HOST) {
      const [body, type] = files[u.pathname] ?? [shellHtml(js), "text/html; charset=utf-8"];
      return r.fulfill({ status: 200, headers: { ...Object.fromEntries(headersFor(p.rules, u.pathname)), "content-type": type }, body });
    }
    return app ? app(r) : r.continue();
  };
}

// ------------------------------------------------------------------------------------------------ the read
const INIT = ({ app }) => {
  if (location.origin !== app || window.top === window) return;
  window.__ctViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__ctViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
};

const READ = (phone) => {
  const b = document.querySelector(phone ? ".pfm .pools" : ".pfd .pools");
  if (!b) return { view: null, rows: [] };
  const rows = [...b.querySelectorAll("[data-pool]")].filter((x) => x.dataset.pool !== "unread").map((x) => ({ chain: x.dataset.pool, asset: x.dataset.asset, balance: x.dataset.balance, ready: x.dataset.ready, pending: x.dataset.pending, text: [...x.children].map((c) => c.textContent) }));
  return { view: b.dataset.pools ?? null, rows };
};

async function runOne(browser, w, shots, handler) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
  const run = { width: w.name, frame: null, view: null, rows: [], violations: [], errors: [] };
  try {
    await ctx.route("**/*", handler);
    await ctx.addInitScript(INIT, { app: APP_HOST });
    const page = await ctx.newPage();
    watch(page, run.errors);
    await page.goto(SIGN_HOST + PATH, { waitUntil: "commit" });
    const until = Date.now() + READY_MS;
    let f = null;
    while (!f && Date.now() < until) {
      f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(APP_HOST)) ?? null;
      if (!f) await page.waitForTimeout(100);
    }
    if (!f) return run;
    run.frame = f.url();
    const sel = w.isMobile ? ".pfm .pools" : ".pfd .pools";
    await f.waitForSelector(`${sel}:not([data-pools='loading'])`, { timeout: READY_MS }).catch(() => {});
    Object.assign(run, await f.evaluate(READ, w.isMobile));
    run.violations = await f.evaluate(() => window.__ctViolations ?? []);
    run.footer = await footerEvidence(f);
    await page.screenshot({ path: path.join(shots, `${KEY}-${w.name}.png`) });
  } finally {
    await ctx.close();
  }
  return run;
}

export async function collect({ build, shots }) {
  mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  const handler = await route(build);
  const rec = { at: new Date().toISOString(), browser: browser.version(), source: build ? `harness, terminal build ${named(build)}` : `live ${APP_HOST}`, answer: ANSWER, runs: [] };
  try {
    for (const w of WIDTHS) rec.runs.push(await runOne(browser, w, shots, handler));
  } finally {
    await browser.close();
  }
  return rec;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const shots = opt("--shots") ?? path.join(tmpdir(), `${KEY}-${Date.now()}`);
  const build = args.includes("--harness") ? path.resolve(opt("--build") ?? path.join(REPO, "apps/terminal/dist")) : null;
  const rec = await collect({ build, shots });
  const record = opt("--record");
  if (record) writeFileSync(record, `${JSON.stringify(rec, null, 2)}\n`);
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, Chrome ${rec.browser}, shots ${shots})`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: error: ${e?.stack ?? e}`);
    process.exit(2);
  });
}
