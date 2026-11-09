#!/usr/bin/env node
// Live check of card app-token-route: every Discover row opens its token's own page, at /token/<chain>/<id>. Node reads
// the helper's lists (GET /v1/market/lists?chain=solana, 200) and takes a live mint: the third row of the Trending
// column as Discover orders it (columnRows), not the top, which "/" already draws. Headless Chromium then opens
// APP_HOST/token/solana/<mint> at 1440 x 900 (desktop) and 390 x 844 (phone, dpr 2, touch), finds the frame that draws
// the token route (APP_HOST runs inside SIGN_HOST's shell) and reads:
//   - the page: main[data-route="token"] draws the page ready, its data-token is that mint, the visible id is that mint,
//     and the visible symbol is the symbol of the row the page read;
//   - the address: the top window is at SIGN_HOST/token/solana/<mint> and the terminal's frame at APP_HOST's same path
//     (the deep link loads inside the shell, never the redirect to "/" an unknown route would give);
//   - the read: the page read GET /v1/market/token?chain=solana&token=<mint>, 200, whose row is that mint;
//   - an unknown id, APP_HOST/token/solana/<a made-up id>: the page's not-found state (data-token-page="empty", no
//     token drawn), its token read answered 404;
//   - Base and Robinhood (card app-chains-evm): the same reads of a live token of each, the third row of that chain's
//     Trending column (GET /v1/market/lists?chain=base and ?chain=robinhood), opened at APP_HOST/token/<chain>/<id> at
//     1440 x 900: the page ready with that token, its read GET /v1/market/token?chain=<chain>&token=<id>, 200.
// A screenshot of every load is kept.
// After: app
//   node scripts/live-checks/app-token-route.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute), the
// helper still answered live; --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { columnRows } from "../../apps/terminal/src/screens/discover/model.ts";
import { named } from "./record-names.mjs";

const KEY = "app-token-route";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const SIGN_HOST = "https://confidential.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
export const LISTS_URL = `${HELPER_HOST}/v1/market/lists?chain=solana`;
export const TOKEN_URL = (mint, chain = "solana") => `${HELPER_HOST}/v1/market/token?chain=${chain}&token=${encodeURIComponent(mint)}`;
/** The EVM chains whose token page the check opens beside Solana's (card app-chains-evm). */
export const EVM_CHAINS = ["base", "robinhood"];
export const listsUrl = (chain) => `${HELPER_HOST}/v1/market/lists?chain=${chain}`;
/** The id the unknown load opens: no mint of any chain. */
export const UNKNOWN = "NoSuchTokenOnAnyChain1111111111111111111111";
export const LOADS = [
  { name: "desktop", id: "mint", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", id: "mint", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", id: "unknown", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "desktop", id: "base", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "desktop", id: "robinhood", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const READ_MS = 25_000;

// ------------------------------------------------------------------------------------------------ the verdict
/** The live mint the check opens: the third row of the Trending column of the recorded rows (the list columnRows reads:
 *  trending_1h, else trending), else the last one a short column has. */
export function pickOf(rows) {
  const r = rows.map((x) => ({ ...x, token: x.mint }));
  const col = columnRows({ chain: "solana", as_of_ms: 0, lists: { new: [], trending: r, trending_1h: r } }, "trending");
  return col[Math.min(2, col.length - 1)]?.token ?? null;
}

/** The check on one recorded run. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const loads = rec.loads ?? [];
  say(loads.length === LOADS.length, `${loads.length} loads of ${LOADS.length} (a live mint at both widths, an unknown id, a live Base and Robinhood token)`);
  const lists = rec.lists ?? null;
  const mint = lists?.trending ? pickOf(lists.trending) : null;
  const lbad = [];
  if (!lists) lbad.push("no lists read");
  else {
    if (lists.url !== LISTS_URL) lbad.push(`lists read at ${lists.url}`);
    if (lists.status !== 200) lbad.push(`lists status ${lists.status}`);
    if (!mint) lbad.push("the lists' Trending column is empty");
  }
  say(lbad.length === 0, `the helper's lists: ${lbad.length ? lbad.join("; ") : `200, the live mint is ${mint} (${(lists.trending.find((x) => x.mint === mint) ?? {}).symbol})`}`);
  const ids = { mint, unknown: UNKNOWN };
  for (const c of EVM_CHAINS) {
    const e = rec.evm?.[c] ?? null;
    ids[c] = e?.trending ? pickOf(e.trending) : null;
    const ebad = [];
    if (!e) ebad.push("not read");
    else {
      if (e.url !== listsUrl(c)) ebad.push(`read at ${e.url}`);
      if (e.status !== 200) ebad.push(`status ${e.status}`);
      if (!ids[c]) ebad.push("its Trending column is empty");
    }
    say(ebad.length === 0, `the helper's ${c} lists: ${ebad.length ? ebad.join("; ") : `200, the live token is ${ids[c]} (${(e.trending.find((x) => x.mint === ids[c]) ?? {}).symbol})`}`);
  }
  for (const [i, l] of loads.entries()) {
    const want = LOADS[i];
    const unknown = want?.id === "unknown";
    const chain = EVM_CHAINS.includes(want?.id) ? want.id : "solana";
    const tag = `${l.width} /token/${chain}/${unknown ? "<unknown>" : chain === "solana" ? "<live mint>" : "<live token>"}`;
    const id = ids[want?.id] ?? null;
    const at0 = `/token/${chain}/${id}`;
    const bad = [];
    if (l.opened !== `${APP_HOST}${at0}`) bad.push(`opened ${l.opened}`);
    if (l.route !== "token") bad.push(`drew ${l.route ?? "nothing"}`);
    if (l.top !== `${SIGN_HOST}${at0}`) bad.push(`the top window's address is ${l.top ?? "none"}, not ${SIGN_HOST}${at0}`);
    if (l.frame !== `${APP_HOST}${at0}`) bad.push(`the terminal's frame is at ${l.frame ?? "none"}, not ${APP_HOST}${at0}`);
    if (unknown) {
      if (l.state !== "empty") bad.push(`state ${l.state ?? "none"}, not the not-found state (empty)`);
      if (l.shown) bad.push(`data-token ${l.shown} drawn for an unknown id`);
      if (!l.token) bad.push("the page read no token answer");
      else if (l.token.status !== 404) bad.push(`token status ${l.token.status}, not 404`);
    } else {
      if (l.state !== "ready") bad.push(`state ${l.state ?? "none"}, not ready`);
      if (l.shown !== id) bad.push(`data-token ${l.shown ?? "none"}, the mint is ${id}`);
      if (l.id !== id) bad.push(`the page's id ${l.id ?? "none"}, the mint is ${id}`);
      if (!l.token) bad.push("the page read no token answer");
      else {
        const at = `${l.token.url}?chain=${l.token.chain}&token=${encodeURIComponent(l.token.mint)}`;
        if (!id || at !== TOKEN_URL(id, chain) || l.token.params !== 2) bad.push(`token read at ${at} (${l.token.params} params), not ${id ? TOKEN_URL(id, chain) : "a live token's"}`);
        if (l.token.status !== 200) bad.push(`token status ${l.token.status}`);
        if (l.token.rowMint !== id) bad.push(`token row ${l.token.rowMint ?? "none"}`);
        if (!l.symbol || l.symbol !== l.token.symbol) bad.push(`the page's symbol ${l.symbol ?? "none"}, the row's ${l.token.symbol ?? "none"}`);
      }
    }
    if (!l.shot) bad.push("no screenshot");
    say(bad.length === 0, `${tag}: ${bad.length ? bad.join("; ") : unknown ? `not found (empty), no token drawn, its token read 404, the address ${l.top}` : `ready, data-token ${l.shown} (${l.symbol}), the address ${l.top}, its token read 200 for that mint`}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
const MEASURE = () => {
  const root = document.querySelector('main[data-route="token"]');
  const p = root?.querySelector("[data-token-page]");
  const vis = (q) => [...(root?.querySelectorAll(q) ?? [])].find((e) => e.getClientRects().length);
  return { route: root?.dataset.route ?? null, state: p?.getAttribute("data-token-page") ?? null, shown: p?.getAttribute("data-token") ?? null, symbol: vis("h1.tkp-sym")?.textContent ?? null, id: vis(".tkp-ca")?.textContent ?? null };
};

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  const lr = await fetch(LISTS_URL, { headers: { origin: APP_HOST } });
  const lb = await lr.json().catch(() => null);
  const rows = lb?.lists?.trending_1h ?? lb?.lists?.trending ?? null;
  // the rows kept to the fields the Trending column's order reads (the id as `mint`: gitleaks reads a long id beside a token key as a secret)
  const lists = { url: LISTS_URL, status: lr.status, as_of_ms: lb?.as_of_ms ?? null, trending: Array.isArray(rows) ? rows.map((r) => ({ mint: r?.token, symbol: r?.symbol, vol_1h_usd: r?.vol_1h_usd ?? null })) : null };
  const mint = lists.trending ? pickOf(lists.trending) : null;
  // Base's and Robinhood's lists, kept as Solana's are (card app-chains-evm)
  const evm = {};
  const ids = { mint, unknown: UNKNOWN };
  for (const c of EVM_CHAINS) {
    const er = await fetch(listsUrl(c), { headers: { origin: APP_HOST } });
    const eb = await er.json().catch(() => null);
    const erows = eb?.lists?.trending_1h ?? eb?.lists?.trending ?? null;
    evm[c] = { url: listsUrl(c), status: er.status, as_of_ms: eb?.as_of_ms ?? null, trending: Array.isArray(erows) ? erows.map((r) => ({ mint: r?.token, symbol: r?.symbol, vol_1h_usd: r?.vol_1h_usd ?? null })) : null };
    ids[c] = evm[c].trending ? pickOf(evm[c].trending) : null;
  }
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "signed");
  }
  const browser = await launchBrowser("chromium");
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", at: new Date().toISOString(), browser: browser.version(), lists, evm, loads: [] };
  try {
    for (const [i, w] of LOADS.entries()) {
      const id = ids[w.id];
      const opened = `${APP_HOST}/token/${EVM_CHAINS.includes(w.id) ? w.id : "solana"}/${id}`;
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
      if (harness) await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === HELPER_HOST ? r.continue() : harness(r)));
      const page = await ctx.newPage();
      let token = null;
      page.on("response", (r) => {
        if (r.url().startsWith(`${HELPER_HOST}/v1/market/token?`) && !token) token = r;
      });
      await page.goto(opened, { waitUntil: "load" });
      let app = null;
      let m = null;
      for (const t0 = Date.now(); Date.now() - t0 < READ_MS; await page.waitForTimeout(250)) {
        for (const f of page.frames()) {
          const x = await f.evaluate(MEASURE).catch(() => null);
          if (x?.route) {
            app = f;
            m = x;
            break;
          }
        }
        if (m && m.state && m.state !== "loading") break;
      }
      await page.waitForTimeout(500);
      if (app) m = await app.evaluate(MEASURE).catch(() => m);
      // the record keeps the file's name only: the folder is the recorder's own, printed once at the end
      const shot = `${i}-${w.name}-${w.id}.png`;
      await page.screenshot({ path: path.join(shots, shot) });
      const tb = token ? await token.json().catch(() => null) : null;
      rec.loads.push({
        width: w.name,
        opened,
        top: page.url(),
        frame: app ? app.url() : null,
        route: m?.route ?? null,
        state: m?.state ?? null,
        shown: m?.shown ?? null,
        symbol: m?.symbol ?? null,
        id: m?.id ?? null,
        // the read's URL kept as its path, chain and mint (gitleaks reads a long id after `token=` as a secret)
        token: token ? { url: token.url().split("?")[0], chain: new URL(token.url()).searchParams.get("chain"), mint: new URL(token.url()).searchParams.get("token"), params: [...new URL(token.url()).searchParams].length, status: token.status(), rowMint: tb?.row?.token ?? null, symbol: tb?.row?.symbol ?? null } : null,
        shot,
      });
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
    const rec = await collect({ build: opt("--build", null), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
