#!/usr/bin/env node
// Live check of card deposit-list-reads-fast (the QA walk of the live app, 16 Nov, item 11: the header's Deposit opened
// cold filled its asset rows in 3,931 ms on a phone and 3,969 ms on desktop). The signing page's deposit.assets
// (packages/signpage/src/rules/deposit-dry.ts depositAssetsKind) read 1Click's token list, then sent its three probe
// quotes, then waited up to 2 s for the pools' floors. Now deposit.assets asks the list and the probes at once and lists
// the USDC rows alone, and each pool's own coin is the kit's deposit.coin, one read per chain from the pool's floor
// (depositCoinKind), which the sheet asks beside it and draws as each lands (apps/terminal/src/screens/deposit).
// On SIGN_HOST, at 390 x 844 (phone, touch) and 1440 x 900 (desktop), for a fresh account opening the header's Deposit
// cold:
//   - every probe quote (the dry quote of DEPOSIT_PROBE_AMOUNT to the public placeholder) leaves before the token list's
//     answer is back, and the page answers deposit.assets within ANSWER_SLACK_MS of the last of them: no wait on a floor;
//   - deposit.assets answers the three USDC rows, and the sheet's Asset and Chain fill within FILL_MAX_MS of the tap;
//   - the sheet asks deposit.coin for Solana, Base and Robinhood, each answers its row (SOL, ETH, ETH), and the sheet
//     draws SOL and ETH among its assets and Base and Robinhood among ETH's chains, each within COIN_MAX_MS of the tap:
//     no row lost (the build of 3eea13901 listed the USDC rows alone).
// The times are kept in the answer, with Robinhood's floor read: each RPC POST it sent (host, status, times).
// 1Click busy or down for the list (the answer's busy or down) proves nothing either way: INCONCLUSIVE, exit 3.
// Deploy order: the app before the signing page. A new app on the old page reads the pool rows from deposit.assets as
// before (deposit.coin is refused not_allowed there); the old app on the new page would list no pool row.
// Headless Chromium (scripts/browsers.mjs, sandbox on) opens SIGN_HOST top-level with a CDP virtual authenticator (PRF),
// signs up with a throwaway passkey (Create passkey, as app-money-sheets-read-right does), opens Discover and presses
// the header's Deposit. It never presses Get address: the account is new and holds nothing, and the seed stays in the
// browser's temporary profile, deleted on close. The answer keeps times, hosts, row names and counts (public values).
//   --sign-dir <dir>: SIGN_HOST's files answered from a local build (packages/signpage/scripts/build-app.mjs --out);
//   --app-dir <dir>: APP_HOST's from a local build (pnpm --filter terminal build's dist); every other request live: how
//   the good answer is recorded before a deploy.
// After: sign
// Bundle: out a browser and a fresh account on the live hosts
//   node scripts/live-checks/deposit-list-reads-fast.mjs [--record <file>] [--answer <file>] [--sign-dir <dir>] [--app-dir <dir>]
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "deposit-list-reads-fast";
export const SIGN = "https://confidential.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** The helper's 1Click token list and quote (packages/signpage/src/rules/deposit-dry.ts DEPOSIT_TOKENS_URL; the wallet's
 *  deposit/quote.ts DEPOSIT_QUOTE_URL). */
export const TOKENS_URL = "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/tokens";
export const QUOTE_URL = "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote";
/** deposit-dry.ts DEPOSIT_PROBE_AMOUNT: the probe's 10 USDC. */
export const PROBE_AMOUNT = "10000000";
/** The release's three USDC rows (deposit-dry.ts DEPOSIT_ASSET_CHAINS). */
export const USDC_ROWS = Object.freeze(["USDC near", "USDC solana", "USDC base"]);
export const WIDTHS = Object.freeze(["phone", "desktop"]);
/** Each pool's own coin row (deposit-dry.ts DEPOSIT_POOL_COINS), as deposit.coin answers it per chain. */
export const COIN_ROWS = Object.freeze({ solana: "SOL solana", base: "ETH base", robinhood: "ETH robinhood" });
/** The sheet's chain names for ETH's two pools (apps/terminal/src/screens/deposit/model.ts CHAIN_NAME). */
export const ETH_CHAINS = Object.freeze(["Base", "Robinhood"]);
const VIEW = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};
/** The longest the page may take to post its answer after the last of the list and the probes ends: a message hop
 *  and the checks' own work, well under the 2,000 ms the floors were waited for before. */
export const ANSWER_SLACK_MS = 500;
/** The longest the sheet may take to fill after Deposit's tap: the signing page's own deadline for the asset list
 *  (packages/signpage/src/deposit-wire.ts DEPOSIT_READ_DEADLINE_MS, 14 s), so a slow 1Click is the read's own answer. */
export const FILL_MAX_MS = 14_000;
/** The longest a pool coin's row may take to be drawn after the tap: the page's read deadline, as FILL_MAX_MS. */
export const COIN_MAX_MS = 14_000;
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });

/** The verdict on an answer { widths: { <width>: read } }: { verdict, lines }. */
export function judge(a) {
  const lines = [];
  let quiet = false;
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  for (const w of WIDTHS) {
    const r = a?.widths?.[w];
    if (!r) {
      say(false, `${w}: not read`);
      continue;
    }
    say(r.opened === true, `${w}: the header's Deposit ${r.opened ? "opens" : "does not open"} the deposit sheet`);
    const ans = r.answer;
    if (!ans || typeof ans.at !== "number") {
      say(false, `${w}: the page never answered deposit.assets`);
      continue;
    }
    if (ans.ok !== true && (ans.code === "busy" || ans.code === "down")) {
      quiet = true;
      lines.push(`INCONCLUSIVE ${w}: the page answered deposit.assets ${ans.code} (1Click or the helper not answering now)`);
      continue;
    }
    const rows = Array.isArray(ans.rows) ? ans.rows : [];
    say(ans.ok === true && USDC_ROWS.every((u) => rows.includes(u)), `${w}: deposit.assets answers ${ans.ok === true ? JSON.stringify(rows) : `error ${ans.code ?? "?"}`}, want the three USDC rows ${JSON.stringify(USDC_ROWS)}`);
    const t = r.tokens, probes = Array.isArray(r.probes) ? r.probes : [];
    const timed = t && typeof t.start === "number" && typeof t.end === "number";
    say(timed, `${w}: the token list ${timed ? `asked at ${t.start} ms, back at ${t.end} ms` : "not seen asked and answered"}`);
    say(probes.length === USDC_ROWS.length && probes.every((p) => typeof p.start === "number" && typeof p.end === "number"), `${w}: ${probes.length} probe quote(s) seen asked and answered, want ${USDC_ROWS.length}`);
    if (!timed || probes.length === 0) continue;
    const late = probes.filter((p) => !(p.start < t.end));
    say(late.length === 0, `${w}: the probes left at ${JSON.stringify(probes.map((p) => p.start))} ms, ${late.length === 0 ? "each before" : `${late.length} not before`} the token list was back at ${t.end} ms (the reads at once)`);
    const last = Math.max(t.end, ...probes.map((p) => (typeof p.end === "number" ? p.end : Infinity)));
    const gap = ans.at - last;
    say(Number.isFinite(gap) && gap <= ANSWER_SLACK_MS, `${w}: the answer posted ${Number.isFinite(gap) ? `${gap} ms` : "an unknown time"} after the last read ended, at most ${ANSWER_SLACK_MS} ms (no wait on a pool's floor)`);
    say(typeof r.fillMs === "number" && r.fillMs <= FILL_MAX_MS, `${w}: Asset and Chain fill ${typeof r.fillMs === "number" ? `${r.fillMs} ms` : "never"} after the tap (at most ${FILL_MAX_MS} ms)`);
    // the pool coins' rows, each its own read, none lost
    const coins = r.coins ?? {};
    for (const [chain, row] of Object.entries(COIN_ROWS)) {
      const c = coins[chain];
      const ok = c?.asked === true && c.ok === true && c.row === row;
      say(ok, `${w}: deposit.coin for ${chain} ${!c?.asked ? "never asked" : c.ok ? `answers ${JSON.stringify(c.row)} at ${c.at} ms` : `refused ${c.code ?? "?"}`}, want ${JSON.stringify(row)}`);
    }
    const drawn = r.drawn ?? {};
    for (const sym of ["SOL", "ETH"]) {
      const t = drawn[sym];
      say(typeof t === "number" && t <= COIN_MAX_MS, `${w}: the sheet draws ${sym} among its assets ${typeof t === "number" ? `${t} ms` : "never"} after the tap (at most ${COIN_MAX_MS} ms)`);
    }
    const eth = Array.isArray(r.ethChains) ? r.ethChains : [];
    say(ETH_CHAINS.every((c) => eth.includes(c)), `${w}: ETH's chains read ${JSON.stringify(eth)}, want ${JSON.stringify(ETH_CHAINS)} (no pool row lost)`);
  }
  const bad = lines.some((l) => l.startsWith("BAD"));
  return { verdict: bad ? "FAIL" : quiet ? "INCONCLUSIVE" : lines.length > 0 ? "PASS" : "FAIL", lines };
}

/** `host`'s requests answered from `dir` (a path with no file extension: its index.html), every other one live. */
async function routeDir(ctx, host, dir) {
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm", ".zkey": "application/octet-stream" };
  await ctx.route(`${host}/**`, (route) => {
    const p = new URL(route.request().url()).pathname;
    let file = path.join(dir, p);
    if (!file.startsWith(dir)) return route.abort();
    if (p.endsWith("/") || path.extname(p) === "") file = path.join(dir, "index.html");
    let body;
    try {
      body = readFileSync(file);
    } catch {
      return route.continue();
    }
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body });
  });
}

/** In every frame: SIGN_HOST's top page keeps each deposit.assets and deposit.coin APP_HOST posts it (id, kind, chain,
 *  time), APP_HOST's frame each answer SIGN_HOST posts it (id, time, rows or code). */
const WATCH = ({ app, sign }) => {
  window.__asked = [];
  window.__answers = [];
  addEventListener(
    "message",
    (e) => {
      const d = e.data;
      if (location.origin === sign && e.origin === app && d?.v === 1 && (d?.type === "deposit.assets" || d?.type === "deposit.coin")) window.__asked.push({ id: d.id, type: d.type, chain: d.chain ?? null, at: Date.now() });
      if (location.origin === app && e.origin === sign && d?.v === 1 && typeof d?.id === "string" && typeof d?.ok === "boolean") {
        const rows = Array.isArray(d.result?.assets) ? d.result.assets.map((x) => `${x.symbol} ${x.chain}`) : d.result?.asset ? [`${d.result.asset.symbol} ${d.result.asset.chain}`] : null;
        window.__answers.push({ id: d.id, at: Date.now(), ok: d.ok, rows, code: d.error?.code ?? null });
      }
    },
    true,
  );
};

async function readWidth(browser, w, signDir, appDir) {
  const ctx = await browser.newContext({ ...VIEW[w], reducedMotion: "reduce" });
  const out = { width: w };
  try {
    if (signDir) await routeDir(ctx, SIGN, signDir);
    if (appDir) await routeDir(ctx, APP, appDir);
    await ctx.addInitScript(WATCH, { app: APP, sign: SIGN });
    // the token list and the probes, by when each left and came back (this machine's clock, as the pages')
    const reads = [];
    // Robinhood's floor read: each POST to a Robinhood RPC (its host, or the helper's /v1/rpc/robinhood route)
    const hood = [];
    ctx.on("request", (q) => {
      const url = q.url();
      if (q.method() === "POST" && (/robinhood/.test(new URL(url).host) || /^\/v1\/rpc\/robinhood/.test(new URL(url).pathname))) hood.push({ q, host: new URL(url).host + (new URL(url).host.startsWith("ct-api.") ? new URL(url).pathname : ""), start: Date.now() });
      if (q.method() !== "POST" || (url !== TOKENS_URL && url !== QUOTE_URL)) return;
      let body = null;
      try {
        body = JSON.parse(q.postData() ?? "null");
      } catch {}
      if (url === QUOTE_URL && !(body?.dry === true && body?.amount === PROBE_AMOUNT)) return;
      reads.push({ q, kind: url === TOKENS_URL ? "tokens" : `probe ${body.originAsset}`, start: Date.now() });
    });
    const ended = (q) => {
      const r = reads.find((x) => x.q === q) ?? hood.find((x) => x.q === q);
      if (r && r.end === undefined) {
        r.end = Date.now();
        q.response().then((res) => void (r.status = res?.status() ?? null), () => {});
      }
    };
    ctx.on("requestfinished", ended);
    ctx.on("requestfailed", ended);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    const app = () => page.frames().find((f) => f.url().startsWith(APP));
    const press = (loc) => (VIEW[w].hasTouch ? loc.tap({ timeout: 10_000 }) : loc.click({ timeout: 10_000 }));
    // sign up: the terminal's Sign in, then Use passkey opens SIGN_HOST's layer, whose Create passkey makes the account
    await page.goto(`${SIGN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction((a) => [...document.querySelectorAll("iframe")].some((f) => f.src.startsWith(a)), APP, { timeout: 30_000 });
    await page.waitForTimeout(4_000);
    const create = page.locator('[data-action="create"]');
    if (!(await create.isVisible().catch(() => false))) {
      const f = app();
      const skip = f?.getByRole("button", { name: /^skip$/i }).first();
      if (skip && (await skip.isVisible().catch(() => false))) await press(skip).catch(() => {});
      await page.waitForTimeout(1_000);
      await press(f.getByRole("button", { name: /^sign in$/i }).filter({ visible: true }).first());
      await page.waitForTimeout(800);
      await press(f.getByRole("button", { name: /use passkey/i }).filter({ visible: true }).first());
    }
    await create.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(800); // past the activation guard (500 ms)
    await press(create);
    await page.waitForFunction(() => document.getElementById("signin")?.dataset.signin === "signed-in", null, { timeout: 30_000 });
    // Discover, loaded fresh: nothing asked the list before the header's Deposit
    await page.goto(`${SIGN}/discover`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    for (let i = 0; i < 100 && !app(); i++) await page.waitForTimeout(200);
    const f = app();
    const dep = f.locator("[data-action='deposit']:not([disabled])").filter({ visible: true }).first();
    await dep.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1_000);
    const t0 = Date.now();
    await press(dep);
    out.opened = await f.waitForSelector('[data-sheet="deposit"]', { timeout: 5_000 }).then(() => true, () => false);
    if (!out.opened) return out;
    out.fillMs = await f.waitForSelector('[data-sheet="deposit"] select[data-control="deposit-asset"]', { timeout: FILL_MAX_MS + 5_000 }).then(() => Date.now() - t0, () => null);
    // when each pool coin's symbol is first drawn among the sheet's assets, polled until both are or COIN_MAX_MS
    out.drawn = {};
    while (Date.now() - t0 <= COIN_MAX_MS + 1_000 && !(out.drawn.SOL !== undefined && out.drawn.ETH !== undefined)) {
      const syms = await f.evaluate(() => [...(document.querySelector('[data-sheet="deposit"] select[data-control="deposit-asset"]')?.options ?? [])].map((o) => o.value || o.textContent.trim())).catch(() => []);
      for (const sym of ["SOL", "ETH"]) if (out.drawn[sym] === undefined && syms.includes(sym)) out.drawn[sym] = Date.now() - t0;
      await page.waitForTimeout(100);
    }
    // every deposit.coin the sheet asked answered (each by its id), or COIN_MAX_MS from the tap; then ETH picked: its
    // chains as the sheet draws them
    while (Date.now() - t0 <= COIN_MAX_MS + 1_000) {
      const ids = (await page.evaluate(() => window.__asked ?? [])).filter((x) => x.type === "deposit.coin").map((x) => x.id);
      const got = new Set((await f.evaluate(() => window.__answers ?? [])).map((x) => x.id));
      if (ids.length >= 3 && ids.every((id) => got.has(id))) break;
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(300);
    out.ethChains = await f.locator('[data-sheet="deposit"] select[data-control="deposit-asset"]').selectOption("ETH").then(
      async () => {
        await page.waitForTimeout(300);
        return f.evaluate(() => [...(document.querySelector('[data-sheet="deposit"] select[data-control="deposit-chain"]')?.options ?? [])].map((o) => o.value || o.textContent.trim()));
      },
      () => [],
    );
    // the first deposit.assets the page was asked, its answer and the reads it sent, each relative to the ask
    const allAsked = await page.evaluate(() => window.__asked ?? []);
    const answers = await f.evaluate(() => window.__answers ?? []);
    const asked = allAsked.find((x) => x.type === "deposit.assets");
    if (!asked) return out;
    out.coins = {};
    for (const chain of Object.keys(COIN_ROWS)) {
      const q = allAsked.find((x) => x.type === "deposit.coin" && x.chain === chain);
      const a = q ? answers.find((x) => x.id === q.id) : null;
      out.coins[chain] = q ? { asked: true, askedAt: q.at - asked.at, ok: a?.ok ?? null, row: a?.rows?.[0] ?? null, code: a?.code ?? null, at: a ? a.at - asked.at : null } : { asked: false };
    }
    out.robinhoodRpcs = hood.filter((h) => h.start >= asked.at - 50).map((h) => ({ host: h.host, start: h.start - asked.at, end: typeof h.end === "number" ? h.end - asked.at : null, status: h.status ?? null }));
    const answer = answers.find((x) => x.id === asked.id);
    const rel = (v) => (typeof v === "number" ? v - asked.at : null);
    out.askedMs = asked.at - t0;
    out.answer = answer ? { at: rel(answer.at), ok: answer.ok, rows: answer.rows, code: answer.code } : null;
    const mine = reads.filter((r) => r.start >= asked.at && (answer ? r.start <= answer.at : true));
    const tok = mine.find((r) => r.kind === "tokens");
    out.tokens = tok ? { start: rel(tok.start), end: rel(tok.end) } : null;
    // each asset's first probe (a re-ask after a 1Click 400 is the same read)
    const seen = new Set();
    out.probes = mine.filter((r) => r.kind.startsWith("probe ") && !seen.has(r.kind) && seen.add(r.kind)).map((r) => ({ start: rel(r.start), end: rel(r.end) }));
    return out;
  } finally {
    await ctx.close();
  }
}

export async function read({ signDir = null, appDir = null } = {}) {
  const { launchBrowser, browserLabel } = await import("../browsers.mjs");
  const browser = await launchBrowser("chromium");
  try {
    const widths = {};
    for (const w of WIDTHS) widths[w] = await readWidth(browser, w, signDir ? path.resolve(signDir) : null, appDir ? path.resolve(appDir) : null);
    return { at: new Date().toISOString(), browser: browserLabel(browser), sign: signDir ? "local build" : "SIGN_HOST", app: appDir ? "local build" : "APP_HOST", widths };
  } finally {
    await browser.close();
  }
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read({ signDir: arg("--sign-dir") ?? null, appDir: arg("--app-dir") ?? null });
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.verdict} ${KEY} (sign ${answer.sign ?? "?"}, app ${answer.app ?? "?"})`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
