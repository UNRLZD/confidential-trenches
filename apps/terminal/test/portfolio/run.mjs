#!/usr/bin/env node
// Portfolio's and Activity's shots and checks (card app-portfolio; A3.1, app.md:1459; 09-design-brief S10 and S14): the
// fixture page (fixtures.tsx) built with vite and served on 127.0.0.1, one shot per brief state at 390 x 844 (dpr 2,
// touch) and 1440 x 900 (dpr 1). Per shot: the state id on the screen's data-states, app-shell's BAR-10 rules
// (MEASURE: no text under 11 px, no phone tap box under 44 px, no horizontal scroll, no CSP violation) and no external
// request (a tx link opens only when tapped). Then the brief's bars: desktop rows 72 layout px with at least 9 visible
// (S10) and 9 Activity rows' worth of height; phone rows 68 with at least 6 under the sticky segments; and the taps:
// Closed, search and hide small, the Activity tab, a type chip, a row opened to its receipt, the phone action sheet and
// its sell, each tx link on its explorer with target _blank.
// The pool rows (card balances-per-chain): each pool view's data-pools, one Balance column (13 Nov 07:53Z: Ready and
// Pending removed, the app names no proof) whose numbers end under its header, and the block inside its panel with no
// clipped text; the four pool rows also at 1280 x 720 (card
// app-faults-seen-on-126). --scheme light|dark emulates the viewer's scheme.
//   node apps/terminal/test/portfolio/run.mjs [--shots <dir>] [--scheme light|dark]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";
import { launchHarnessBrowser } from "../../../../scripts/harness-sockets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const schemeAt = args.indexOf("--scheme");
const SCHEME = schemeAt >= 0 ? args[schemeAt + 1] : "dark";
if (SCHEME !== "light" && SCHEME !== "dark") throw new Error("--scheme light|dark");

const NOW = Date.parse("2026-11-02T03:00:00Z");
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  // card app-faults-seen-on-126: Private balance's four rows at the desktop's shortest common screen (the pools fixture only)
  { name: "1280", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
// fixture, the brief state it must show, the widths it is drawn at (S10.10 and S10.11 are desktop's toolbar; S10.13 is
// the phone's sheet: R5 draws them only there), and whether the phone shot scrolls to the segments
const STATES = [
  ["loading", "S10.1", ["390", "1440"], false],
  ["empty", "S10.2", ["390", "1440"], false],
  ["rows", "S10.3", ["390", "1440"], false],
  ["partial", "S10.4", ["390", "1440"], true],
  ["offline", "S10.5", ["390", "1440"], false],
  ["noroute", "S10.6", ["390", "1440"], true],
  ["reverted", "S10.7", ["390", "1440"], true],
  ["held", "S10.8", ["390", "1440"], true],
  ["rows", "S10.9", ["390", "1440"], false],
  ["closed", "S10.10", ["390", "1440"], true],
  ["search", "S10.11", ["1440"], false],
  ["selling", "S10.12", ["390", "1440"], true],
  ["sheet", "S10.13", ["390"], false],
  ["notrades", "S10.14", ["390", "1440"], false],
  ["activity-empty", "S14.1", ["390", "1440"], true],
  ["activity", "S14.2", ["390", "1440"], true],
  ["failed", "S14.2", ["390", "1440"], true],
  ["zeroprice", "S10.4", ["390", "1440"], true],
  ["restored", "S14.3", ["390", "1440"], true],
  ["exported", "S14.4", ["390", "1440"], true],
  ["filtered", "S14.5", ["390", "1440"], true],
  ["receipt", "S14.6", ["390", "1440"], true],
  ["pools", "S10.3", ["390", "1440", "1280"], false],
  ["pools-noready", "S10.3", ["390", "1440"], false],
  ["pools-empty", "S10.3", ["390", "1440"], false],
  ["cash-vault", "S10.3", ["390", "1440"], false],
  ["cash-one", "S10.3", ["390", "1440"], false],
  ["cash-four", "S10.3", ["390", "1440"], false],
  ["cash-moving", "S10.3", ["390", "1440"], false],
  // card pool-balance-counts-the-remainder: each pool's balance and Cash count the money still at its U_X
  ["pools-remainder", "S10.3", ["390", "1440"], false],
  // card portfolio-shows-pool-trades: the owner's two round trips from the device's own records
  ["pooltrades", "S10.10", ["1440"], false],
  ["pooltrades-stats", "S10.9", ["390"], true],
  ["pooltrades-activity", "S14.2", ["390", "1440"], true],
  ["pooltrades-open", "S10.9", ["390", "1440"], false],
  ["pooltrades-mixed", "S10.10", ["1440"], false],
  ["pooltrades-unknown", "S10.9", ["390", "1440"], false],
  // card app-faults-seen-on-126: the closed coin named and pictured by the screen's own held read
  ["closed-reads", "S10.10", ["390", "1440"], true],
  // card portfolio-counts-money-an-open-buy-holds: the open buy's wallet counted, the axis's ticks distinct
  ["openbuy", "S10.3", ["390", "1440"], false],
  ["openbuy-noheld", "S10.3", ["390", "1440"], false],
  ["axis", "S10.3", ["1440"], false],
  // card portfolio-moves-money-between-chains: Private balance with Move and Withdraw on every row (the owner's own zero
  // rows, all four funded, none held, and the live app before the kit has pool.move), then the move sheet: ready, pool
  // to pool, over the balance, a pair the page does not move yet, running at the NEAR vault, and landed
  ["move-zero", "S10.2", ["390", "1440"], false],
  ["move-rows", "S10.3", ["390", "1440"], false],
  ["move-empty", "S10.2", ["390", "1440"], false],
  ["move-off", "S10.3", ["390", "1440"], false],
  ["move-sheet", "S10.3", ["390", "1440"], false],
  ["move-sheet-xy", "S10.3", ["390", "1440"], false],
  ["move-over", "S10.3", ["390", "1440"], false],
  ["move-refused", "S10.3", ["390", "1440"], false],
  ["move-running", "S10.3", ["390", "1440"], false],
  ["move-done", "S10.3", ["390", "1440"], false],
  // card move-sends-what-it-shows: Max the page's, under the Base floor (Min), an amount its plan cannot send (Try)
  ["move-max", "S10.3", ["390", "1440"], false],
  ["move-min", "S10.3", ["390", "1440"], false],
  ["move-try", "S10.3", ["390", "1440"], false],
];
// the move sheet's fixtures: what each draws once pool.move.dry answers [data-move-state, the flow's steps, each step's state]
const MOVE_SHEETS = {
  "move-sheet": ["idle", "pool:solana intents:near vault:near", ["idle", "idle", "idle"]],
  "move-sheet-xy": ["idle", "pool:solana intents:near vault:near intents:base pool:base", ["idle", "idle", "idle", "idle", "idle"]],
  "move-over": ["idle", "pool:solana intents:near vault:near intents:base pool:base", ["idle", "idle", "idle", "idle", "idle"]],
  "move-refused": ["idle", "pool:base intents:near vault:near intents:robinhood pool:robinhood", ["idle", "idle", "idle", "idle", "idle"]],
  "move-running": ["in_vault", "pool:solana intents:near vault:near intents:base pool:base", ["done", "done", "active", "idle", "idle"]],
  "move-max": ["idle", "pool:solana intents:near vault:near", ["idle", "idle", "idle"]],
  "move-min": ["idle", "pool:solana intents:near vault:near intents:base pool:base", ["idle", "idle", "idle", "idle", "idle"]],
  "move-try": ["idle", "pool:solana intents:near vault:near", ["idle", "idle", "idle"]],
  "move-done": ["done", "pool:solana intents:near vault:near intents:base pool:base", ["done", "done", "done", "done", "done"]],
};
// one balance (card portfolio-one-balance): each fixture's Cash tile in cents and its parts as drawn on hover (desktop) or
// a tap (phone): [chain, the drawn row's text, data-cents, moving]. Vault $73.18; SOL at $150, ETH at $3,000.
const CASH = {
  "cash-vault": ["$73.18", [["near", "NEAR$73.18", "7318", false]]],
  "cash-one": ["$448.18", [["near", "NEAR$73.18", "7318", false], ["solana", "Solana$375.00", "37500", false]]],
  "cash-four": ["$1,498.18", [["near", "NEAR$73.18", "7318", false], ["solana", "Solana$375.00", "37500", false], ["base", "Base$750.00", "75000", false], ["robinhood", "Robinhood$300.00", "30000", false]]],
  // 2.5125 SOL at $150 = $376.87; 0.252 ETH and 0.1003 ETH at $3,000 = $756.00 and $300.90
  "pools-remainder": ["$1,506.95", [["near", "NEAR$73.18", "7318", false], ["solana", "Solana$376.87", "37687", false], ["base", "Base$756.00", "75600", false], ["robinhood", "Robinhood$300.90", "30090", false]]],
  "cash-moving": ["$1,198.18", [["near", "NEAR$73.18", "7318", false], ["solana", "Solana$375.00", "37500", false], ["base", "Base$750.00", "75000", false], ["robinhood", "RobinhoodProcessing$0.00", "0", true]]],
};
// item 7 (card app-faults-seen-on-122): each fixture's Positions tile and its parts as drawn, [tile, Coins, Reserve];
// null: nothing held, no parts
const HELD = { openbuy: ["$0.70", "$0.01", "$0.69"], "openbuy-noheld": null };
// each fixture's pool view, its total, and per row [chain, Balance, Value, the actions] as drawn (card
// portfolio-moves-money-between-chains: a Value a row, a dash where the page sent no fresh price)
const POOLS = {
  loading: ["loading"],
  offline: ["offline"],
  rows: ["unread"],
  // card app-faults-seen-on-122: NEAR's vault USDC first; one balance a chain, whatever is ready
  pools: ["rows", [["NEAR", "73.18 USDC", "$73.18", ""], ["Solana", "1.25M SOL", "—", ""], ["Base", "0.25 ETH", "—", ""], ["Robinhood", "0 ETH", "$0.00", ""]], "$73.18"],
  "pools-noready": ["rows", [["NEAR", "73.18 USDC", "$73.18", ""], ["Solana", "12.5 SOL", "—", ""], ["Base", "0.001 ETH", "—", ""]], "$73.18"],
  "pools-empty": ["empty", null, "$0.00"],
  // card pool-balance-counts-the-remainder: the notes and the money at U_X, one balance a chain
  "pools-remainder": ["rows", [["NEAR", "73.18 USDC", "$73.18", ""], ["Solana", "2.5125 SOL", "$376.87", ""], ["Base", "0.252 ETH", "$756.00", ""], ["Robinhood", "0.1003 ETH", "$300.90", ""]], "$1,506.95"],
  // the owner's own rows (13 Nov 19:39Z): 0.021049 SOL at $150 is $3.15
  "move-zero": ["rows", [["NEAR", "0 USDC", "$0.00", ""], ["Solana", "0.021049 SOL", "$3.15", ""], ["Base", "0 ETH", "$0.00", ""], ["Robinhood", "0 ETH", "$0.00", ""]], "$3.15"],
  "move-rows": ["rows", [["NEAR", "73.18 USDC", "$73.18", ""], ["Solana", "2.5 SOL", "$375.00", ""], ["Base", "0.25 ETH", "$750.00", ""], ["Robinhood", "0.1 ETH", "$300.00", ""]], "$1,498.18"],
  "move-empty": ["empty", null, "$0.00"],
  "move-off": ["rows", [["NEAR", "73.18 USDC", "$73.18", ""], ["Solana", "2.5 SOL", "$375.00", ""], ["Base", "0.25 ETH", "$750.00", ""], ["Robinhood", "0.1 ETH", "$300.00", ""]], "$1,498.18"],
};

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-portfolio-"));
  await build({ root: HERE, logLevel: "error", plugins: [react()], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 } });
  return out;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
function serve(dir) {
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const file = path.join(dir, p === "/" ? "index.html" : p);
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      const body = readFileSync(file); // read before the headers go: a missing file is a 404, never a second write
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const fails = [];
const drafts = new Map();
const check = (ok, what) => ok || fails.push(what);
const states = (page) => page.locator(".pf").getAttribute("data-states").then((s) => (s ?? "").split(" "));

let BASE = "";
const HELPER = "https://ct-api.unrealized.trade";
const LOGO = `${HELPER}/v1/logo/`;
const ICM = "78GaXFTJzkCWpdxkNHMSP3TXEKbhQTpb3EqMt7Uupump";
/** A 1 x 1 orange PNG: the helper's logo for ICM, a picture over the initials in the shots. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4NEsPAAQ8Abv9b7JQAAAAAElFTkSuQmCC", "base64");
/** The stand-in helper's market read: what it knows of each token (its live answer for ICM, 13 Nov 06:15Z). */
const HELD_READ = { [`solana:${ICM}`]: { symbol: "Icm", name: "Internet cat money", price_usd: "0.00000233298725715" } };
/** The tokens each page's held read asked for (fixture Fx.reads), by page. */
const asked = new WeakMap();
async function open(browser, w, f) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce", timezoneId: "UTC", colorScheme: SCHEME });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  await page.clock.install({ time: NOW - 1000 });
  await page.clock.pauseAt(NOW);
  // each token avatar asks the helper for its logo (Avatar.tsx logoUrl, GET /v1/logo/{chain}/{token}; the signed-in walk of release 124, 12 Nov:
  // Closed drew "78GaXF" with no picture): ICM's answered with a picture, as the helper answers it, every other one as
  // the helper answers a token it has no logo for, a 404, so it keeps its initials. Our own host, so not an external
  // request; anything else leaving the page still is.
  await page.route((u) => u.href.startsWith(LOGO), (r) => (r.request().url() === `${LOGO}solana/${ICM}` ? r.fulfill({ status: 200, headers: { "content-type": "image/png", "access-control-allow-origin": "*" }, body: PNG }) : r.fulfill({ status: 404, body: "" })));
  // the screen's own held reads (fixture Fx.reads, source.tsx useHeldReads through the kit): GET /v1/market/held answers
  // one entry per asked token, in the asked order, named only when HELD_READ knows it (the helper's shape,
  // apps/helper/src/data/held.ts); GET /v1/market/candles no bars
  const mine = [];
  asked.set(page, mine);
  await page.route((u) => u.href.startsWith(`${HELPER}/v1/market/held?`) || u.href.startsWith(`${HELPER}/v1/market/candles?`), (r) => {
    const u = new URL(r.request().url());
    const json = (body) => r.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (u.pathname === "/v1/market/candles") return json({ tf: u.searchParams.get("tf"), candles: [], as_of_ms: NOW });
    const chain = u.searchParams.get("chain");
    const tokens = u.searchParams.getAll("token");
    mine.push(...tokens.map((t) => `${chain}:${t}`));
    return json({ tokens: tokens.map((token) => ({ token, ...(HELD_READ[`${chain}:${token}`] ?? { symbol: null, name: null, price_usd: null }) })), as_of_ms: NOW });
  });
  const external = [];
  const ours = (u) => u.startsWith(LOGO) || u.startsWith(`${HELPER}/v1/market/held?`) || u.startsWith(`${HELPER}/v1/market/candles?`);
  page.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && !ours(r.url()) && external.push(r.url()));
  await page.goto(`${BASE}/?f=${f}`);
  await page.waitForSelector(".pf");
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, external };
}
const toSegments = (page) => page.evaluate(() => { const s = document.querySelector(".pfm .sticky"); window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY - 56); });

const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchHarnessBrowser("chromium");
let n = 0;
try {
  for (const w of WIDTHS) {
    const phone = w.isMobile;
    for (const [f, want, at, scroll] of STATES) {
      if (!at.includes(w.name)) continue;
      const tag = `${f} ${want} @${w.name}`;
      const { ctx, page, external } = await open(browser, w, f);
      if (phone && scroll) await toSegments(page);
      const got = await states(page);
      check(got.includes(want), `${tag}: data-states ${got.join(" ")}`);
      const m = await page.evaluate(MEASURE, { phone, vw: w.viewport.width });
      check(!m.hscroll, `${tag}: horizontal scroll`);
      check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
      check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
      check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
      check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
      // every tx link: a known explorer, a new tab, no referrer
      for (const a of await page.$$eval(".pf a[data-tx]", (as) => as.filter((x) => x.getClientRects().length).map((x) => ({ href: x.href, target: x.target, rel: x.rel })))) check(/^https:\/\/(solscan\.io|basescan\.org|robinhoodchain\.blockscout\.com|nearblocks\.io)\//.test(a.href) && a.target === "_blank" && a.rel.includes("noreferrer"), `${tag}: tx link ${JSON.stringify(a)}`);
      for (const d of await page.$$eval("[data-draft-copy]", (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
        if (!drafts.has(d)) drafts.set(d, new Set());
        drafts.get(d).add(want);
      }
      // the owner's labels (owner 10 Nov 18:12Z): each failed trade's row its red Transaction failed tag, the reason on
      // hover as the trade box words it (none for a code it has no words for), never a kit code; no tag on another row
      if (f === "failed") {
        const tags = await page.$$eval(".pf [data-row]", (rs) => rs.filter((r) => r.getClientRects().length).map((r) => { const t = r.querySelector("[data-failed]"); return `${r.getAttribute("data-row")}:${t ? `${t.textContent}|${t.getAttribute("title") ?? ""}|${t.className}` : "-"}`; }));
        const want = ["f1:Transaction failed|Price check failed|tag sell", "f2:Transaction failed|Unavailable|tag sell", "f3:Transaction failed||tag sell", "f4:Transaction failed|Not landed|tag sell"];
        check(JSON.stringify(tags.slice(0, 4)) === JSON.stringify(want), `${tag}: failed rows ${tags.slice(0, 4).join(" ")}`);
        check(tags.slice(4).length > 0 && tags.slice(4).every((t) => t.endsWith(":-")), `${tag}: a tag on a row that did not fail ${tags.slice(4).join(" ")}`);
        check(!/_/.test(await page.locator(".pf [data-row]").allInnerTexts().then((a) => a.join(" "))), `${tag}: a kit code drawn`);
      }
      // the owner's two round trips (card portfolio-shows-pool-trades): each on Closed, newest first, with its bought,
      // sold and realized in USD and SOL from the device's records; the open row between them with its holding and cost
      if (f === "pooltrades") {
        const rows = await page.$$eval(".pf [data-closed]", (rs) => rs.filter((r) => r.getClientRects().length).map((r) => [...r.querySelectorAll("td")].map((c) => c.innerText.replace(/\s+/g, " ").trim()).join("|")));
        const want = ["Ic Icm Internet cat money|$0.10|$0.10|0|—|—|$0.00 −2.5% −0.0000298 SOL|—|1m|", "Ic Icm Internet cat money|$0.10|$0.05|0|—|—|−$0.05 −52.3% −0.000631 SOL|—|1m|"];
        check(JSON.stringify(rows) === JSON.stringify(want), `${tag}: closed rows ${JSON.stringify(rows)}`);
        // each realized cell and its percent take the exact figure's tone: the $0.0025 loss drawn "$0.00" is a loss
        const tones = await page.$$eval(".pf [data-closed]", (rs) => rs.filter((r) => r.getClientRects().length).map((r) => { const c = r.querySelectorAll("td")[6]; return `${c?.className}|${c?.querySelector(".s2")?.className}`; }));
        check(JSON.stringify(tones) === JSON.stringify(["loss|s2 loss", "loss|s2 loss"]), `${tag}: closed rows' tones ${JSON.stringify(tones)}`);
      }
      // card app-faults-seen-on-126 (the signed-in walk of release 126: Closed drew "78GaXF", with no logo, nothing open):
      // the screen's own held read asks for the closed coin, and each closed row draws its symbol and its logo
      if (f === "closed-reads") {
        const rows = async () => page.$$eval(".pf [data-closed]", (rs) => rs.filter((r) => r.getClientRects().length).map((r) => `${r.querySelector(".sy")?.textContent}|${r.querySelector("img.tok-logo")?.getAttribute("data-loaded") === "true" ? "logo" : "no logo"}`));
        let got = await rows();
        for (let i = 0; i < 30 && !(got.length === 2 && got.every((x) => x === "Icm|logo")); i++) {
          await new Promise((r) => setTimeout(r, 100));
          got = await rows();
        }
        check(JSON.stringify(got) === JSON.stringify(["Icm|logo", "Icm|logo"]), `${tag}: closed rows ${JSON.stringify(got)}, want Icm with its logo on both (the held read asked ${JSON.stringify(asked.get(page))})`);
        check(asked.get(page).includes(`solana:${ICM}`), `${tag}: the held read never asked for the closed coin (asked ${JSON.stringify(asked.get(page))})`);
      }
      if (f === "pooltrades-open" && !phone) {
        const row = await page.$$eval(".pf [data-pos]", (rs) => rs.filter((r) => r.getClientRects().length).map((r) => r.getAttribute("data-pos")));
        check(JSON.stringify(row) === JSON.stringify(["solana:78GaXFTJzkCWpdxkNHMSP3TXEKbhQTpb3EqMt7Uupump"]), `${tag}: open rows ${JSON.stringify(row)}`);
      }
      // an open row of unknown cost (review P2-4): bought and PnL the dash, its value drawn, and no unrealized from it
      if (f === "pooltrades-unknown" && !phone) {
        const row = await page.$$eval(".pf [data-pos]", (rs) => rs.filter((r) => r.getClientRects().length).map((r) => [...r.querySelectorAll("td")].slice(1, 6).map((c) => c.innerText.replace(/\s+/g, " ").trim()).join("|")));
        check(JSON.stringify(row) === JSON.stringify(["—|—|34.1K Icm|$0.08|—"]), `${tag}: open row ${JSON.stringify(row)}`);
      }
      // card portfolio-counts-money-an-open-buy-holds: the pool's $2.50, the open buy's wallet's $0.69 and the coin's
      // $0.01 (4,286.1 x $0.00000233314) in the Total ($3.20), the row's Bought $0.01 (never $0.00)
      if (f === "openbuy") {
        const tot = await page.$$eval(".pf .tot", (ts) => ts.filter((t) => t.getClientRects().length).map((t) => t.textContent.trim()));
        check(JSON.stringify(tot) === JSON.stringify(["$3.20"]), `${tag}: total ${JSON.stringify(tot)}`);
        if (!phone) {
          const row = await page.$$eval(".pf [data-pos]", (rs) => rs.filter((r) => r.getClientRects().length).map((r) => [...r.querySelectorAll("td")].slice(1, 2).map((c) => c.innerText.trim()).join("|")));
          check(JSON.stringify(row) === JSON.stringify(["$0.01"]), `${tag}: Bought ${JSON.stringify(row)}`);
        }
      }
      if (f === "axis") {
        const ticks = await page.$$eval(".pf [data-tick]", (ts) => ts.filter((t) => t.getClientRects().length).map((t) => t.getAttribute("data-tick")));
        check(ticks.length === 4 && new Set(ticks).size === 4, `${tag}: axis ticks ${JSON.stringify(ticks)}`);
      }
      // a price that reads zero: KINU's value is the dash, on the desktop table and the phone card, never $0.00
      if (f === "zeroprice") {
        const v = await page.$$eval('.pf [data-value]', (cs) => cs.filter((c) => c.getClientRects().length && c.closest("[data-pos]")?.getAttribute("data-pos")?.endsWith(":KINU")).map((c) => `${c.textContent.trim()}|${c.getAttribute("data-unread")}`));
        check(v.length === 1 && v[0] === "—|true", `${tag}: KINU's value ${JSON.stringify(v)}, want the dash, marked unread`);
      }
      if (POOLS[f] && (f !== "rows" || want === "S10.3")) {
        // the pool block of the form on screen: its view, its rows as drawn, inside its panel, no clipped text
        const r = await page.evaluate((sel) => {
          const b = document.querySelector(sel);
          if (!b) return null;
          const panel = b.closest(".panel, .mwhere").getBoundingClientRect();
          const box = b.getBoundingClientRect();
          const clipped = [...b.querySelectorAll("span")].filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 0.5 && getComputedStyle(e).display !== "inline").map((e) => e.textContent);
          const rows = [...b.querySelectorAll("[data-pool]")].filter((x) => x.getAttribute("data-pool") !== "unread").map((x) => [...x.children].map((c) => c.textContent));
          // every row drawn without a scroll: its cells end above the bottom of the box that shows them (desktop's
          // Where it is scrolls, so a row past it is hidden though the block sits in the panel; the signed-in walk of release 124, 12 Nov, 1440 x 900:
          // Robinhood, the 4th row, cut off the bottom of Private balance)
          const sc = b.closest(".eqbrk");
          const edge = Math.min(panel.bottom, sc ? sc.getBoundingClientRect().bottom : panel.bottom);
          // the row's words and numbers (not Withdraw's tap box or its HopLine, padded past the line on purpose)
          const cells = (x) => [...x.children].filter((c) => !c.matches(".pla, .plw, .hopline"));
          const hidden = [...b.querySelectorAll("[data-pool]")].filter((x) => cells(x).some((c) => c.getBoundingClientRect().bottom > edge + 0.5)).map((x) => x.getAttribute("data-pool"));
          // one column header, Balance, and every row's balance ending where it ends: no empty column, no shifted number
          const heads = [...b.querySelectorAll(".plc")].filter((h) => h.getClientRects().length).map((h) => h.textContent);
          const headRight = b.querySelector(".plc")?.getBoundingClientRect().right ?? null;
          const shifted = [...b.querySelectorAll("[data-pool]")].filter((x) => x.getAttribute("data-pool") !== "unread").map((x) => x.children[1]?.getBoundingClientRect().right).filter((rt) => headRight === null || rt === undefined || Math.abs(rt - headRight) > 0.5);
          const named = /proo?f|\bready\b|pending/i.test(b.innerText);
          const total = b.querySelector("[data-pools-total]")?.textContent ?? null;
          const totRight = b.querySelector(".pltot")?.getBoundingClientRect().right ?? null;
          const offTotal = [...b.querySelectorAll("[data-pool] .plv")].map((v) => v.getBoundingClientRect().right).filter((rt) => totRight === null || Math.abs(rt - totRight) > 0.5);
          return { total, offTotal, heads, shifted, named, view: b.getAttribute("data-pools"), rows, inside: box.bottom <= panel.bottom + 0.5 && box.right <= panel.right + 0.5, clipped, hidden, scroll: sc ? [sc.scrollHeight, sc.clientHeight] : null };
        }, phone ? ".pfm .pools" : ".pfd .pools");
        const [view, rows, total] = POOLS[f];
        check(r?.view === view, `${tag}: pools view ${r?.view}, want ${view}`);
        if (rows) check(JSON.stringify(r.rows) === JSON.stringify(rows), `${tag}: pool rows ${JSON.stringify(r?.rows)}`);
        if (total) check(r?.total === total, `${tag}: Private balance's total ${r?.total}, want ${total}`);
        // card portfolio-moves-money-between-chains: no column heads (each amount carries its unit and $); the total ends
        // where the rows' dollars end, on the desktop's grid
        if (view === "rows" || view === "unread" || view === "loading") check(JSON.stringify(r?.heads) === "[]" && (phone || r.offTotal.length === 0), `${tag}: pool heads ${JSON.stringify(r?.heads)}, values off the total's column ${JSON.stringify(r?.offTotal)}`);
        check(r?.named === false, `${tag}: the pool block names a proof, Ready or Pending`);
        check(r?.inside && r.clipped.length === 0, `${tag}: pool block outside its panel or clipped ${JSON.stringify(r)}`);
        check(r?.hidden.length === 0, `${tag}: pool rows past the bottom of what shows them ${JSON.stringify(r?.hidden)} (scroll ${JSON.stringify(r?.scroll)})`);
      }
      // the S10 row bars need a full list: the open buy's fixture holds one row
      if (want === "S10.3" && w.name === "1440" && !f.startsWith("openbuy")) {
        // the brief's S10 bar at 1440: rows 72 layout px (54 CSS px), at least 9 visible, at least 9 fields a row
        const r = await page.evaluate(() => {
          const box = document.querySelector(".ptw").getBoundingClientRect();
          const rows = [...document.querySelectorAll(".pt tbody tr")].map((x) => x.getBoundingClientRect());
          return { h: rows[0]?.height ?? 0, visible: rows.filter((x) => x.bottom <= box.bottom + 0.5).length, fields: document.querySelectorAll(".pt thead th").length - 1 };
        });
        check(Math.abs(r.h - 54) < 1 && r.visible >= 9 && r.fields >= 9, `${tag}: S10 bar rows ${r.h}px, ${r.visible} visible, ${r.fields} fields`);
        console.log(`@1440 positions: row ${r.h.toFixed(1)} css px, ${r.visible} visible, ${r.fields} fields`);
      }
      if (want === "S10.3" && phone && !f.startsWith("openbuy")) {
        await toSegments(page);
        const r = await page.evaluate(() => {
          const tb = document.querySelector(".tabbar").getBoundingClientRect().top;
          const sg = document.querySelector(".pfm .sticky").getBoundingClientRect().bottom;
          const rs = [...document.querySelectorAll(".pfm .mpr")].map((x) => x.getBoundingClientRect());
          return { h: rs[0]?.height ?? 0, under: rs.filter((x) => x.top >= sg - 0.5 && x.bottom <= tb + 0.5).length };
        });
        check(Math.abs(r.h - 68) < 0.5 && r.under >= 6, `${tag}: phone rows ${r.h}px, ${r.under} under the segments`);
        console.log(`@390 positions: row ${r.h.toFixed(1)} px, ${r.under} under the sticky segments`);
      }
      if (want === "S14.2" && !phone) {
        const r = await page.evaluate(() => { const rs = [...document.querySelectorAll(".pfd .ai")].map((x) => x.getBoundingClientRect()); const box = document.querySelector(".pfd .alist").getBoundingClientRect(); return { h: rs[0]?.height ?? 0, visible: rs.filter((x) => x.bottom <= box.bottom + 0.5).length }; });
        check(Math.abs(r.h - 54) < 1, `${tag}: Activity rows ${r.h}px`);
        console.log(`@1440 activity: row ${r.h.toFixed(1)} css px, ${r.visible} visible (brief: 9)`);
      }
      if (CASH[f]) {
        // the Cash tile: one total; its parts hidden until a hover (desktop) or a tap (phone), then each chain's row,
        // inside the viewport and drawn over the panel, never clipped by it
        const form = phone ? ".pfm" : ".pfd";
        const tile = page.locator(`${form} [data-tile="cash"]`);
        if (phone) await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "center" }), `${form} [data-tile="cash"]`);
        const [cash, parts] = CASH[f];
        check((await tile.locator(".pvv").textContent()) === cash, `${tag}: Cash ${await tile.locator(".pvv").textContent()}, want ${cash}`);
        check(!(await tile.locator(".pvparts").isVisible()), `${tag}: Cash parts shown before a hover or tap`);
        if (phone) await tile.tap();
        else await tile.hover();
        const got = await page.evaluate((sel) => {
          const box = document.querySelector(`${sel} [data-tile="cash"] .pvparts`);
          const r = box.getBoundingClientRect();
          const rows = [...box.querySelectorAll("[data-part]")].map((x) => [x.getAttribute("data-part"), x.textContent, x.getAttribute("data-cents"), x.hasAttribute("data-moving")]);
          // the element drawn at each row's centre is the row's own: nothing covers it, no ancestor clips it
          const seen = [...box.querySelectorAll("[data-part]")].every((x) => { const q = x.getBoundingClientRect(); const e = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return !!e && x.contains(e); });
          return { rows, inside: r.left >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5, seen };
        }, form);
        check(JSON.stringify(got.rows) === JSON.stringify(parts), `${tag}: Cash parts ${JSON.stringify(got.rows)}`);
        check(got.inside && got.seen, `${tag}: Cash parts outside the viewport or covered ${JSON.stringify(got)}`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `cash-parts-${f}-${w.name}${SCHEME === "dark" ? "" : `-${SCHEME}`}.png`) });
        if (phone) {
          await tile.tap();
          check(!(await tile.locator(".pvparts").isVisible()), `${tag}: a second tap closes the Cash parts`);
        } else await page.mouse.move(1, 1);
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      // item 7 of card app-faults-seen-on-122 (owner 12 Nov 16:17:50Z, option B): the Positions tile opens to Coins and
      // Reserve, which add up to it, as the Cash tile opens; with nothing held it has no parts and does not open; on
      // desktop, Allocation draws a Reserve tile at the held value
      if (HELD[f] !== undefined) {
        const form = phone ? ".pfm" : ".pfd";
        const tile = page.locator(`${form} [data-tile="positions"]`);
        const want7 = HELD[f];
        const parts = await tile.locator("[data-part]").evaluateAll((xs) => xs.map((x) => [x.getAttribute("data-part"), x.textContent, x.getAttribute("data-cents")]));
        const alloc = phone ? null : await page.$$eval('.pfd [data-alloc="reserve"]', (xs) => xs.map((x) => [x.textContent, x.getAttribute("data-cents")]));
        if (want7 === null) {
          check(parts.length === 0 && (await tile.getAttribute("role")) === null, `${tag}: nothing held, yet the Positions tile has parts ${JSON.stringify(parts)}`);
          if (!phone) check(alloc.length === 0, `${tag}: nothing held, yet a Reserve tile ${JSON.stringify(alloc)}`);
        } else {
          const [tot, coins, reserve] = want7;
          check((await tile.locator(".pvv").textContent()) === tot, `${tag}: Positions ${await tile.locator(".pvv").textContent()}, want ${tot}`);
          check(!(await tile.locator(".pvparts").isVisible()), `${tag}: Positions parts shown before a hover or tap`);
          if (phone) {
            await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "start" }), `${form} .pvtiles`);
            await tile.tap();
          } else await tile.hover();
          const got = await page.evaluate((sel) => {
            const box = document.querySelector(`${sel} [data-tile="positions"] .pvparts`);
            const r = box.getBoundingClientRect();
            const panel = box.closest(".panel, .mwhere").getBoundingClientRect();
            const seen = [...box.querySelectorAll("[data-part]")].every((x) => { const q = x.getBoundingClientRect(); const e = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return !!e && x.contains(e); });
            return { inside: r.left >= panel.left - 0.5 && r.right <= Math.min(panel.right, innerWidth) + 0.5 && r.bottom <= innerHeight + 0.5, seen };
          }, form);
          const drawn = parts.map((x) => x.slice(0, 2));
          check(JSON.stringify(drawn) === JSON.stringify([["coins", `Coins${coins}`], ["reserve", `Reserve${reserve}`]]) && BigInt(parts[0][2]) + BigInt(parts[1][2]) === BigInt(tot.replace(/[$,.]/g, "")), `${tag}: Positions parts ${JSON.stringify(parts)}, want Coins ${coins} and Reserve ${reserve} adding up to ${tot}`);
          check(got.inside && got.seen, `${tag}: Positions parts outside the panel or covered ${JSON.stringify(got)}`);
          if (!phone) check(alloc.length === 1 && alloc[0][0] === `Reserve${reserve}` && alloc[0][1] === parts[1][2], `${tag}: Allocation's Reserve tile ${JSON.stringify(alloc)}, want Reserve ${reserve}`);
          if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `positions-parts-${f}-${w.name}${SCHEME === "dark" ? "" : `-${SCHEME}`}.png`) });
          if (phone) {
            await tile.tap();
            check(!(await tile.locator(".pvparts").isVisible()), `${tag}: a second tap closes the Positions parts`);
          } else await page.mouse.move(1, 1);
          await page.evaluate(() => window.scrollTo(0, 0));
        }
      }
      // a pool fixture's phone shot shows the pool rows (the S10.3 bar above scrolled to the segments)
      if (MOVE_SHEETS[f]) {
        // the sheet once pool.move.dry answered (300 ms after the last change): its state, the route's steps and each step's state
        await page.clock.runFor(500);
        const m = await page.evaluate(() => {
          const sh = document.querySelector('[data-sheet="move"]');
          if (!sh) return null;
          const fl = sh.querySelector("[data-testid=move-flow]");
          const box = sh.querySelector(".dep-box").getBoundingClientRect();
          return { state: sh.getAttribute("data-move-state"), steps: fl?.getAttribute("data-steps"), states: [...sh.querySelectorAll("[data-testid^=move-step-]")].map((n) => n.getAttribute("data-state")), inView: box.left >= -0.5 && box.right <= innerWidth + 0.5, flowFits: fl ? fl.scrollWidth <= fl.clientWidth + 0.5 : false, go: sh.querySelector('[data-control="move-go"]')?.disabled ?? null };
        });
        const [st, steps, states] = MOVE_SHEETS[f];
        check(m?.state === st && m.steps === steps && JSON.stringify(m.states) === JSON.stringify(states), `${tag}: move sheet ${JSON.stringify(m)}, want ${st} ${steps} ${JSON.stringify(states)}`);
        check(m?.inView && m.flowFits, `${tag}: move sheet off screen or its flow overflows ${JSON.stringify(m)}`);
        if (f === "move-sheet" || f === "move-sheet-xy") check(m?.go === false, `${tag}: Move off with a priced amount under the balance`);
        if (f === "move-over" || f === "move-refused" || f === "move-running") check(m?.go === true, `${tag}: Move on while ${f}`);
        // card move-sends-what-it-shows: Max is what the page says the move sends, never the balance it cannot; an amount
        // the move cannot send names what it can, each a tap that types it, and Move stays off until it is typed
        const lim = await page.evaluate(() => {
          const sh = document.querySelector('[data-sheet="move"]');
          const mx = sh?.querySelector('[data-control="move-max"]');
          const hint = sh?.querySelector("[data-move-dry]");
          return { max: mx?.getAttribute("data-max") ?? null, maxOff: mx?.disabled ?? null, hint: hint?.getAttribute("data-move-dry") ?? null, min: hint?.getAttribute("data-move-min") ?? null, text: hint?.textContent ?? null, taps: [...(sh?.querySelectorAll('[data-control="move-try"]') ?? [])].map((b) => b.getAttribute("data-amount")) };
        });
        if (f === "move-max") {
          check(lim.max === "2.4979" && lim.maxOff === false && lim.hint === null, `${tag}: Max ${JSON.stringify(lim)}, want the page's 2.4979 SOL, on`);
          await page.locator('[data-control="move-max"]').click();
          await page.clock.runFor(500);
          check((await page.locator('[data-field="move-amount"]').inputValue()) === "2.4979" && !(await page.locator('[data-control="move-go"]').isDisabled()), `${tag}: Max types 2.4979 and Move is on`);
        }
        if (f === "move-min") check(lim.hint === "min" && lim.min === "0.0545" && lim.text === "Min0.0545 SOL" && JSON.stringify(lim.taps) === '["0.0545"]' && m?.go === true, `${tag}: under the Base floor ${JSON.stringify(lim)}, go ${m?.go}`);
        if (f === "move-try") {
          check(lim.hint === "try" && lim.text === "Try0.25 SOLor0.35 SOL" && JSON.stringify(lim.taps) === '["0.25","0.35"]' && m?.go === true, `${tag}: an amount its plan cannot send ${JSON.stringify(lim)}, go ${m?.go}`);
        }
      }
      if (phone && (f.startsWith("pools") || ["move-zero", "move-rows", "move-empty", "move-off"].includes(f))) await page.evaluate(() => document.querySelector(".pfm .pools").scrollIntoView({ block: "center" }));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${want}-${f}-${w.name}${SCHEME === "dark" ? "" : `-${SCHEME}`}.png`) });
      n++;
      await ctx.close();
    }

    // the taps (at 390 and 1440; 1280 draws the pools fixture alone)
    if (w.name === "1280") continue;
    if (!phone) {
      const { ctx, page } = await open(browser, w, "rows");
      await page.locator('.pfd [data-control="closed"]').click();
      check((await states(page)).includes("S10.10") && (await page.locator(".pfd tr[data-closed]").count()) === 4, `@${w.name}: Closed`);
      await page.locator('.pfd [data-control="open"]').click();
      await page.locator('.pfd [data-field="search"]').fill("hoo");
      const syms = await page.$$eval(".pfd tr[data-pos]", (rs) => rs.map((r) => r.getAttribute("data-pos")));
      check((await states(page)).includes("S10.11") && syms.join() === "near:WTH,near:HOODL,near:HOOT", `@${w.name}: search ${syms}`);
      await page.locator('.pfd [data-field="search"]').fill("");
      await page.locator('.pfd [data-control="hide-small"]').click();
      check((await page.locator(".pfd tr[data-pos]").count()) === 10, `@${w.name}: hide small hid a row worth over $1`);
      await page.locator('.pfd tr[data-pos="near:WTH"]').hover();
      await page.locator('.pfd tr[data-pos="near:WTH"] [data-control="export"]').click();
      await page.locator('.pfd tr[data-pos="near:WTH"]').hover();
      await page.locator('.pfd tr[data-pos="near:WTH"] [data-control="sell-50"]').click();
      const calls = await page.evaluate(() => window.__calls);
      check(JSON.stringify(calls) === JSON.stringify([{ kind: "export", chain: "near", address: "WTH-w1" }, { kind: "sell", chain: "near", token: "WTH", part: "50" }]), `@${w.name}: row taps ${JSON.stringify(calls)}`);
      await page.locator('.pfd [data-control="pane-activity"]').click();
      check((await states(page)).includes("S14.2"), `@${w.name}: Activity tab`);
      await page.locator('.pfd [data-chip="sell"]').click();
      const kinds = await page.$$eval(".pfd [data-row]", (rs) => [...new Set(rs.map((r) => r.getAttribute("data-kind")))]);
      check((await states(page)).includes("S14.5") && kinds.join() === "sell", `@${w.name}: Sell chip ${kinds}`);
      await page.locator(".pfd [data-row] .ai").first().click();
      check((await states(page)).includes("S14.6") && (await page.locator(".pfd [data-receipt]").count()) === 1, `@${w.name}: receipt`);
      await ctx.close();
    } else {
      const { ctx, page } = await open(browser, w, "rows");
      await toSegments(page);
      // card app-faults-seen-on-122 (walk of release 122, row 8): the phone's Open / Closed, as the desktop's
      const closedTap = page.locator('.pfm [data-control="closed"]');
      check((await closedTap.count()) === 1 && (await closedTap.isVisible()), `@${w.name}: no Closed control on the phone page`);
      if (await closedTap.count()) {
        await closedTap.tap();
        const closedRows = await page.$$eval(".pfm [data-closed]", (rs) => rs.filter((r) => r.getClientRects().length).map((r) => r.getAttribute("data-closed")));
        check((await states(page)).includes("S10.10") && closedRows.length === 4 && (await page.locator(".pfm .mpr[data-pos]").count()) === 0, `@${w.name}: Closed lists ${closedRows.length} closed rows, want 4 and no open row`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `S10.10-closed-tap-${w.name}.png`) });
        await page.locator('.pfm [data-control="open"]').tap();
        check((await page.locator(".pfm .mpr[data-pos]").count()) > 0 && (await page.locator(".pfm [data-closed]").count()) === 0, `@${w.name}: Open lists the open rows again`);
      }
      await page.locator('.pfm .mpr[data-pos="near:WTH"]').click();
      check((await states(page)).includes("S10.13") && (await page.locator('.pfm [data-sheet="position"]').count()) === 1, `@${w.name}: row opens the sheet`);
      await page.locator('.pfm [data-control="sheet-sell-50"]').click();
      const calls = await page.evaluate(() => window.__calls);
      check(JSON.stringify(calls) === JSON.stringify([{ kind: "sell", chain: "near", token: "WTH", part: "50" }]) && (await page.locator('.pfm [data-sheet="position"]').count()) === 0, `@${w.name}: sheet 50% ${JSON.stringify(calls)}`);
      await page.locator('.pfm [data-control="seg-activity"]').click();
      check((await states(page)).includes("S14.2"), `@${w.name}: Activity segment`);
      await page.locator('.pfm [data-control="seg-stats"]').click();
      check((await page.locator('.pfm [data-pane="stats"]').count()) === 1, `@${w.name}: Stats segment`);
      await page.locator('.pfm [data-control="deposit"]').click();
      check((await page.evaluate(() => window.__calls)).at(-1)?.kind === "deposit", `@${w.name}: Deposit`);
      await ctx.close();
    }
    // a pool row's Withdraw (card app-pool-withdraw): on for a chain with a balance, off for one with none, and the tap
    // hands the mount the chain only: no address, no amount
    {
      const { ctx, page } = await open(browser, w, "pools");
      const form = phone ? ".pfm" : ".pfd";
      const btn = (c) => page.locator(`${form} [data-control="pool-withdraw-${c}"]`);
      const off = await Promise.all(["solana", "base", "robinhood"].map((c) => btn(c).isDisabled()));
      check(JSON.stringify(off) === "[false,false,true]", `@${w.name}: pool Withdraw on/off ${JSON.stringify(off)}, want Solana and Base on, Robinhood (0) off`);
      check((await btn("base").getAttribute("aria-label")) === "Withdraw", `@${w.name}: pool Withdraw's name`);
      if (phone) await page.evaluate(() => document.querySelector(".pfm .pools").scrollIntoView({ block: "center" }));
      await btn("base").click();
      const calls = await page.evaluate(() => window.__calls);
      check(JSON.stringify(calls) === JSON.stringify([{ kind: "pool-withdraw", chain: "base" }]), `@${w.name}: pool Withdraw hands ${JSON.stringify(calls)}, want the chain only`);
      await ctx.close();
    }
    // card portfolio-moves-money-between-chains: no Move while the kit has no pool.move; with it, Move and Withdraw on
    // every row, a zero row's off; NEAR's Withdraw is the vault's; Move opens the sheet from the row, Max fills the exact
    // balance, a To swaps the route, and Move asks the page once with exactly From, To and the amount
    {
      const form = phone ? ".pfm" : ".pfd";
      let { ctx, page } = await open(browser, w, "move-off");
      check((await page.locator('[data-control^="pool-move-"]').count()) === 0, `@${w.name}: a Move drawn before the kit has pool.move`);
      await ctx.close();
      ({ ctx, page } = await open(browser, w, "move-zero"));
      const mv = (c) => page.locator(`${form} [data-control="pool-move-${c}"]`);
      const off = await Promise.all(["near", "solana", "base", "robinhood"].map((c) => mv(c).isDisabled()));
      check(JSON.stringify(off) === "[true,false,true,true]", `@${w.name}: Move on/off ${JSON.stringify(off)}, want Solana on, the zero rows off and drawn`);
      check((await page.locator(`${form} [data-control="pool-withdraw-near"]`).count()) === 1, `@${w.name}: NEAR's row has no Withdraw`);
      if (phone) await page.evaluate(() => document.querySelector(".pfm .pools").scrollIntoView({ block: "center" }));
      await mv("solana").click();
      const sheet = page.locator('[data-sheet="move"]');
      check((await sheet.getAttribute("data-from")) === "solana" && (await sheet.getAttribute("data-to")) === "near", `@${w.name}: Move opens the sheet from its row`);
      await page.locator('[data-control="move-max"]').click();
      check((await page.locator('[data-field="move-amount"]').inputValue()) === "0.021049", `@${w.name}: Max fills the exact balance`);
      await page.locator('[data-side="to"] [data-chain="base"]').click();
      await page.clock.runFor(500);
      check((await page.locator("[data-testid=move-flow]").getAttribute("data-steps")) === "pool:solana intents:near vault:near intents:base pool:base", `@${w.name}: To Base routes through the NEAR vault`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `move-tapped-${w.name}.png`) });
      await page.locator('[data-control="move-go"]').click();
      const calls = (await page.evaluate(() => window.__calls)).filter((c) => c.kind === "move");
      check(JSON.stringify(calls) === JSON.stringify([{ kind: "move", from: "solana", to: "base", amount: "0.021049" }]), `@${w.name}: Move asks ${JSON.stringify(calls)}`);
      check((await page.locator('[data-control="move-go"]').isDisabled()) && (await sheet.getAttribute("data-move-state")) === "starting", `@${w.name}: Move runs once`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

for (const [d, ids] of [...drafts].sort()) console.log(`draft copy on screen: ${d} (${[...ids].join(", ")})`);
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} checks over ${n} shots, the bars and the taps`);
  process.exit(1);
}
console.log(`PASS ${n} shots (${STATES.length} states over 390/1440, the pools also at 1280), BAR-10 per shot, the S10 and S14 row bars and the taps${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
