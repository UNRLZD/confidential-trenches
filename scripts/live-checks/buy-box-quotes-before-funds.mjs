#!/usr/bin/env node
// Live check of card buy-box-quotes-before-funds: a fresh account with $0 opens a token's page, types an amount in the
// buy box, and the box shows a quote and says why Buy is off. On Solana, Base and Robinhood its Max line reads Max $0
// (the box's model.ts poolMax: Bal $0 is a Max of $0, as the page lists a fresh account's pools with no ready and no
// tap_max), the amount is marked over it, and Buy is off; on those and on NEAR the box asks the signing page's
// pool.buy.dry with the amount (half 2: model.ts coinTapKey and buysAskAmount ask it with no pool note) and draws the
// answer's out as You receive, with the Fee row shown (its dash when no cost comes back).
// Headless Chromium (scripts/browsers.mjs, sandbox on) opens SIGN_HOST top-level with a CDP virtual authenticator (PRF),
// signs up with a throwaway passkey (Create passkey, as wallet-passkey-prf does), then opens token pages SIGN_HOST frames
// APP_HOST on, types 5 in the amount and reads the box for up to 25 s. Each chain's coins: the helper's own lists
// (GET /v1/market/lists?chain=<chain> on HELPER_HOST, trending then graduating then new; pump.fun mints first on
// Solana), at most COINS_MAX, until one's box draws a quote; a coin the page cannot quote (its answers refused
// quote_check_failed, down or busy, or ok with no out) goes on to the next. The frames' pool.buy.dry messages are kept
// (asked by the box, answered by the page) so the verdict tells the box's fault from the page's: every coin of a chain
// unquoted by the page is INCONCLUSIVE for that chain. It never presses Buy, Sell, Withdraw or Confirm: the account is
// new and holds nothing, and the seed stays in the browser's temporary profile, deleted on close. The answer keeps the
// box's texts and the dry messages (public values) only.
//   --app-dir <dir>: APP_HOST's requests answered from a local build (pnpm --filter terminal build's dist).
//   --site <dir>: SIGN_HOST's requests answered from a signing page build (packages/signpage/scripts/build-app.mjs
//   --out <dir>). Either is how an answer is recorded before a deploy. Neither carries the host's headers.
// After: app
// Bundle: out a browser and a fresh account on the live hosts
//   node scripts/live-checks/buy-box-quotes-before-funds.mjs [--record <file>] [--answer <file>] [--app-dir <dir>] [--site <dir>]
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "./provider-answer.mjs";

const KEY = "buy-box-quotes-before-funds";
export const SIGN = "https://confidential.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
/** The chains read: every pool chain, and NEAR (its box draws no Max line). */
export const CHAINS = Object.freeze(["solana", "base", "robinhood", "near"]);
const POOL_CHAINS = new Set(["solana", "base", "robinhood"]);
/** The most coins of a chain whose box is read before the chain is INCONCLUSIVE. */
export const COINS_MAX = 5;
const WATCH_MS = 25_000;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
/** Refusals that are a coin's own read (its venue, a provider), not a page that prices nothing with no pool note. */
const AGAIN = new Set(["quote_check_failed", "down", "busy", "timeout", "no answer"]);

/** The coins of `chain` in the helper's lists (trending, then graduating, then new), each once, at most COINS_MAX; on
 *  Solana pump.fun's mints first (their names end in "pump"), whose venue the page reads. */
export function coinsOf(answer, chain) {
  const l = answer?.lists ?? {};
  const all = [];
  for (const row of [...(l.trending_1h ?? []), ...(l.trending ?? []), ...(l.graduating ?? []), ...(l.new ?? [])]) {
    if (row?.chain !== chain || typeof row.token !== "string" || all.includes(row.token)) continue;
    all.push(row.token);
  }
  const first = chain === "solana" ? [...all.filter((t) => t.endsWith("pump")), ...all.filter((t) => !t.endsWith("pump"))] : all;
  return first.slice(0, COINS_MAX);
}

/** The box's drawn quote: You receive with a number ("≈ 240K TORCH"), not the dash. */
export const quoted = (receive) => typeof receive === "string" && /^≈\s*[0-9]/.test(receive);
/** A dry answer that priced the amount: ok with an out above 0. */
const outOf = (d) => (d?.ok === true && typeof d.result?.out === "string" && DECIMAL.test(d.result.out) && /[1-9]/.test(d.result.out) ? d.result.out : null);

/** The verdict on one coin's read { coin, box: { balance, max, receive, fee, bad, ctaOff }, dry: [{ amount, ok, result | code }] }:
 *  the lines it fails on, or [] when it keeps every fact. */
function coinLines(chain, c) {
  const lines = [];
  const b = c.box ?? {};
  const tag = `${chain} ${c.coin}`;
  if (b.balance !== "$0 available") lines.push(`BAD ${tag}: Bal reads ${JSON.stringify(b.balance)}, not a fresh account's "$0 available"`);
  if (POOL_CHAINS.has(chain)) {
    if (b.max !== "Max $0") lines.push(`BAD ${tag}: the line above Buy reads ${JSON.stringify(b.max)}, want "Max $0"`);
    if (b.bad !== "true") lines.push(`BAD ${tag}: the amount 5 is not marked over Max`);
  }
  if (b.ctaOff !== true) lines.push(`BAD ${tag}: Buy is not off`);
  if (typeof b.fee !== "string" || !/^Fee/.test(b.fee)) lines.push(`BAD ${tag}: no Fee row`);
  if (!(c.dry ?? []).some((d) => d.amount !== undefined)) lines.push(`BAD ${tag}: the box asked no quote of the amount`);
  else if ((c.dry ?? []).some((d) => d.amount !== undefined && outOf(d) !== null) && !quoted(b.receive)) lines.push(`BAD ${tag}: the page answered an out, You receive reads ${JSON.stringify(b.receive)}`);
  return lines;
}

/** The verdict on an answer { chains: { <chain>: { coins: [coin read, ...] } } }: { ok, verdict, lines }. */
export function judge(a) {
  const lines = [];
  let quiet = false;
  for (const chain of CHAINS) {
    const coins = a?.chains?.[chain]?.coins ?? [];
    if (coins.length === 0) {
      lines.push(`BAD ${chain}: the box was not read`);
      continue;
    }
    // the coin judged: the first whose box drew a quote, else the first the page priced (an out), else the last read
    const priced = (c) => (c.dry ?? []).some((d) => d.amount !== undefined && outOf(d) !== null);
    const c = coins.find((x) => quoted(x.box?.receive)) ?? coins.find(priced) ?? coins.at(-1);
    const bad = coinLines(chain, c);
    if (bad.length) {
      lines.push(...bad);
      continue;
    }
    if (quoted(c.box?.receive)) {
      lines.push(`ok ${chain} ${c.coin}: Bal $0, ${POOL_CHAINS.has(chain) ? "Max $0, the amount marked, " : ""}Buy off, You receive ${c.box.receive}, ${c.box.fee}`);
      continue;
    }
    // the box asked and drew no quote because the page priced none: a refusal no coin's own read explains is the page's
    // fault (FAIL); every coin refused for its own read or answered with no out is INCONCLUSIVE
    const refused = coins.flatMap((x) => x.dry ?? []).find((d) => d.amount !== undefined && d.ok === false && !AGAIN.has(d.code));
    if (refused) {
      lines.push(`BAD ${chain}: the page answered the box's quote ${JSON.stringify(refused.code)}: no price for a buy with no pool note`);
      continue;
    }
    quiet = true;
    lines.push(`no-answer ${chain}: the page quoted none of ${coins.map((x) => x.coin).join(", ")} (${coins.flatMap((x) => (x.dry ?? []).filter((d) => d.amount !== undefined).map((d) => (d.ok ? "no out" : d.code))).join(", ")})`);
  }
  const bad = lines.some((l) => l.startsWith("BAD"));
  return { ok: !bad && !quiet, verdict: bad ? "FAIL" : quiet ? "INCONCLUSIVE" : "PASS", lines };
}

/** The box's texts as the page draws them. */
const BOX = () => {
  const t = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
  const cta = document.querySelector('[data-testid="trade-cta"]');
  return { balance: t("trade-balance"), max: t("trade-max"), receive: t("trade-receive"), fee: t("trade-cost"), bad: document.querySelector(".trb-amount")?.getAttribute("data-bad") ?? null, ctaOff: cta ? cta.disabled : null };
};

/** In every frame: SIGN_HOST's frame keeps the pool.buy.dry asks APP_HOST posts it, APP_HOST's the answers to them. */
const WATCH = ({ app, sign }) => {
  window.__dry = [];
  addEventListener(
    "message",
    (e) => {
      const d = e.data;
      if (!d || d.v !== 1 || typeof d.id !== "string") return;
      if (e.origin === app && location.origin === sign && d.type === "pool.buy.dry") window.__dry.push({ id: d.id, at: Date.now(), chain: d.chain, coin: d.token, ...(d.amount === undefined ? {} : { amount: d.amount }) });
      else if (e.origin === sign && location.origin === app && "ok" in d) window.__dry.push({ id: d.id, at: Date.now(), ok: d.ok, ...(d.ok ? { result: d.result } : { code: d.error?.code ?? null }) });
    },
    true,
  );
};

/** `host`'s requests answered from `dir` (a path with no file: its index.html, as the hosts answer it). */
async function routeDir(ctx, host, dir) {
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm", ".zkey": "application/octet-stream" };
  await ctx.route(`${host}/**`, (route) => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname);
    let file = path.join(dir, p);
    if (!file.startsWith(dir)) return route.abort();
    let body;
    try {
      body = readFileSync(file);
    } catch {
      file = path.join(dir, "index.html");
      body = readFileSync(file);
    }
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body });
  });
}

export async function read({ appDir = null, site = null, fetchFn = fetch } = {}) {
  const lists = {};
  for (const chain of CHAINS) {
    const res = await fetchFn(`${HELPER_HOST}/v1/market/lists?chain=${chain}`, { headers: { origin: APP } }).catch(() => null);
    lists[chain] = res?.ok ? coinsOf(await res.json().catch(() => null), chain) : [];
  }
  const { launchBrowser, browserLabel } = await import("../browsers.mjs");
  const browser = await launchBrowser("chromium");
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (appDir) await routeDir(ctx, APP, path.resolve(appDir));
    if (site) await routeDir(ctx, SIGN, path.resolve(site));
    await ctx.addInitScript(WATCH, { app: APP, sign: SIGN });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    const app = () => page.frames().find((f) => f.url().startsWith(APP));
    // sign up: the terminal's Sign in, then Use passkey opens SIGN_HOST's layer, whose Create passkey makes the account
    await page.goto(`${SIGN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction((a) => [...document.querySelectorAll("iframe")].some((f) => f.src.startsWith(a)), APP, { timeout: 30_000 });
    await page.waitForTimeout(4_000);
    const create = page.locator('[data-action="create"]');
    if (!(await create.isVisible().catch(() => false))) {
      const f = app();
      const skip = f?.getByRole("button", { name: /^skip$/i }).first();
      if (skip && (await skip.isVisible().catch(() => false))) await skip.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      await f.getByRole("button", { name: /^sign in$/i }).first().click({ timeout: 15_000 });
      await page.waitForTimeout(800);
      await f.getByRole("button", { name: /use passkey/i }).first().click({ timeout: 10_000 });
    }
    await create.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(800); // past the activation guard (500 ms)
    await create.click();
    await page.waitForFunction(() => document.getElementById("signin")?.dataset.signin === "signed-in", null, { timeout: 30_000 });
    const chains = {};
    for (const chain of CHAINS) {
      const coins = [];
      for (const coin of lists[chain]) {
        await page.goto(`${SIGN}/token/${chain}/${coin}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const f = await (async () => {
          for (let i = 0; i < 100 && !app(); i++) await page.waitForTimeout(200);
          return app();
        })();
        const input = f.locator("input.trb-input").first();
        if (!(await input.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false))) {
          coins.push({ coin, box: null, dry: [] });
          continue;
        }
        // the box's Bal is read (the state's first answer) before the amount goes in
        await f.waitForFunction(() => /\$/.test(document.querySelector('[data-testid="trade-balance"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
        await input.click();
        await page.keyboard.type("5");
        const at = Date.now();
        let box = await f.evaluate(BOX);
        while (Date.now() - at < WATCH_MS && !quoted(box.receive)) {
          await page.waitForTimeout(250);
          box = await f.evaluate(BOX);
        }
        // a second look a moment on, so a Max line drawn with the quote is read too
        await page.waitForTimeout(1_000);
        box = await f.evaluate(BOX);
        const asked = await page.evaluate(() => window.__dry ?? []);
        const answered = new Map((await f.evaluate(() => window.__dry ?? [])).map((d) => [d.id, d]));
        // `coin`, not `token`: a record field named token holding a mint reads to a secret scan as a key
        // ms: how long the page took to answer (the kit's client gives pool.buy.dry 10 s)
        const dry = asked.filter((d) => d.chain === chain && d.coin === coin).map(({ id, at: t0, chain: _c, coin: _t, ...ask }) => {
          const ans = answered.get(id);
          return { ...ask, ...(ans ? { ok: ans.ok, ms: ans.at - t0, ...(ans.ok ? { result: ans.result } : { code: ans.code }) } : { ok: false, code: "no answer" }) };
        });
        coins.push({ coin, box, dry });
        if (quoted(box.receive)) break;
      }
      chains[chain] = { coins };
    }
    return { at: new Date().toISOString(), browser: browserLabel(browser), app: appDir ? "local build" : "APP_HOST", sign: site ? `build ${path.basename(site)}` : "SIGN_HOST", chains };
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
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read({ appDir: arg("--app-dir") ?? null, site: arg("--site") ?? null });
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.verdict} ${KEY}`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
