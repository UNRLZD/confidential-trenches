#!/usr/bin/env node
// Live check of card app-holding-follows-a-fill on APP_HOST (https://ct-app.unrealized.trade). What it holds, and only
// that: APP_HOST serves the script its index.html pins (its sha384), and that script carries the fills overlay
// (apps/terminal/src/screens/portfolio/fills.ts), read as minified:
//   - the read that stands a fill down: a buy's once the read is at its amount or more, a sell's once at its amount or
//     less (`e.side===`buy`?n.a>=n.b:n.a<=n.b`);
//   - the buy's fill noted from the route's out (`side:`buy`,amount:d.amount`) and the sell's at its Filled
//     (`side:`sell`,amount:t.amount`).
// The times themselves are held by the tests that build them (apps/terminal/test/trade-box/run.mjs and
// test/sell-positions/run.mjs in a browser, test/holding-follows-a-fill.test.ts) and by the devnet run's HELD verdict
// (test/e2e/buy/run.mjs). The recorded answers are facts() over APP_HOST's build (apps/terminal/dist).
// After: app
//   node scripts/live-checks/app-holding-follows-a-fill.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "app-holding-follows-a-fill";
export const APP = "https://ct-app.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const Q = "[`\"']";
/** The read that stands a fill down: a buy's at its amount or more, a sell's at its amount or less. */
const SHOWS = new RegExp(`${N}\\.side===${Q}buy${Q}\\?${N}\\.a>=${N}\\.b:${N}\\.a<=${N}\\.b`);
/** A fill noted from the trade's own amount, for a buy and for a sell. */
const NOTE = (side) => new RegExp(`side:${Q}${side}${Q},amount:${N}\\.amount`);

/** The script an index.html pins, and its integrity. */
const pinned = (index) => {
  const m = /<script[^>]*\bsrc="([^"]+\.js)"[^>]*\bintegrity="([^"]+)"/.exec(index ?? "") ?? /<script[^>]*\bintegrity="([^"]+)"[^>]*\bsrc="([^"]+\.js)"/.exec(index ?? "");
  if (!m) return null;
  return m[1].endsWith(".js") ? { src: m[1], integrity: m[2] } : { src: m[2], integrity: m[1] };
};

/** What the check keeps of the read: the index, its served script's sha384, and the marks read from it. */
export function facts(app) {
  return { app: { index: app.index, sha384: sha384(app.js), shows: SHOWS.test(app.js), buy: NOTE("buy").test(app.js), sell: NOTE("sell").test(app.js) } };
}

/** The verdict on an answer { app: { index, sha384, shows, buy, sell } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = pinned(a?.app?.index);
  if (!pin) bad("APP_HOST's index.html pins no script");
  else if (pin.integrity !== a.app.sha384) bad("APP_HOST's served script is not the one index.html pins");
  if (a?.app?.shows !== true) bad("the app keeps no trade's own amount: what you hold waits for the holdings read");
  if (a?.app?.buy !== true) bad("a buy's Filled does not set what you hold: the Sell side waits for the buy's Final");
  if (a?.app?.sell !== true) bad("a sell's Filled does not set what you hold: a sold holding stays shown");
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${APP}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${APP}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  const pin = pinned(index);
  return facts({ index, js: pin ? await get(pin.src.startsWith("/") ? pin.src : `/${pin.src}`) : "" });
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
