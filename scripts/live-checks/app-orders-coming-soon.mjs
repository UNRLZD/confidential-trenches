#!/usr/bin/env node
// Live check of card app-orders-coming-soon: every orders place in the app says Coming soon and nothing there can be
// armed (owner 10 Nov, owner-decisions row "Order of the returned feature groups": "on the UI we say coming soon"). It
// reads what APP_HOST serves: the page, then every script and stylesheet the page names, and finds
//   - the words `Coming soon` and each orders place's own mark, the `orders-soon` element's data-place: the buy and the
//     sell ticket's Limit and TP/SL tabs (buy-limit, buy-tpsl, sell-limit, sell-tpsl), the buy ticket's exit plan
//     block (buy-exit), the token page's My orders tab (token-orders, with its label `My orders`), Portfolio's TP/SL
//     cell and the phone sheet's Exit plan row (portfolio-exit, portfolio-sheet-exit) and the Orders route (orders);
//   - no order control left: no exit plan switch (`trb-toggle`), no Add exit plan button (data-control `exit`, the
//     `addExit` word drawn), no order tab drawn off (`trb-tab` with aria-selected false and disabled);
//   - the empty state's rule for the ticket's tabs (`.trb-soon`) in a stylesheet.
// The behaviour (each place's words at 390 and 1440, nothing in it focusable, a fake fetch that sees no orders request)
// is the terminal's own browser run: apps/terminal/test/orders-soon/run.mjs.
// After: app
//   node scripts/live-checks/app-orders-coming-soon.mjs [--url <url>] [--record <file>]
//   node scripts/live-checks/app-orders-coming-soon.mjs --root <dir> [--record <file>]   the same read on a local build
//     (apps/terminal/dist, built first) read from disk
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (each mark's count, not the files), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-orders-coming-soon";
export const APP_URL = "https://ct-app.unrealized.trade/";
export const SOON = "Coming soon";
export const PLACES = ["buy-limit", "buy-tpsl", "buy-exit", "sell-limit", "sell-tpsl", "token-orders", "portfolio-exit", "portfolio-sheet-exit", "orders"];
const Q = "[`\"']";

/** What must be in the scripts, each a pattern on the minified or the source form. */
export const MUST = {
  words: new RegExp(`${Q}${SOON}${Q}`, "g"),
  myOrders: new RegExp(`${Q}My orders${Q}`, "g"),
  soonEl: new RegExp(`${Q}data-testid${Q}\\s*:\\s*${Q}orders-soon${Q}`, "g"),
  // `orders` alone is a route id too: the Orders route's mark is its data-place
  ...Object.fromEntries(PLACES.map((p) => [`place:${p}`, p === "orders" ? new RegExp(`${Q}data-place${Q}\\s*:\\s*${Q}orders${Q}`, "g") : new RegExp(`${Q}${p}${Q}`, "g")])),
};
/** What must not be: an order control the places drew before this card. */
export const MUST_NOT = {
  exitSwitch: /trb-toggle/g,
  addExit: new RegExp(`${Q}data-control${Q}\\s*:\\s*${Q}exit${Q}|id\\s*:\\s*${Q}addExit${Q}`, "g"),
  tabOff: new RegExp(`${Q}trb-tab${Q}\\s*,\\s*${Q}aria-selected${Q}\\s*:\\s*${Q}false${Q}\\s*,\\s*disabled\\s*:\\s*(?:!0|true)`, "g"),
};
const count = (re, text) => (text.match(re) ?? []).length;

/** The page's scripts and stylesheets: the `src` of each script, the `href` of each stylesheet link. */
export function refsOf(html) {
  return {
    js: [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]),
    css: [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]),
  };
}

/** Each mark's count in one script. */
export const marksOf = (js) => Object.fromEntries([...Object.entries(MUST), ...Object.entries(MUST_NOT)].map(([k, re]) => [k, count(re, js)]));
/** Whether a stylesheet holds the tabs' empty-state rule. */
export const soonRuleIn = (css) => /\.trb-soon\s*\{[^}]*\}/.test(css.replace(/\/\*[\s\S]*?\*\//g, ""));

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, pageStatus, js: [{ url, status, marks }], css: [{ url, status, rule }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const js = rec.js ?? [];
  const css = rec.css ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  say(css.length > 0 && css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  const sum = (k) => js.reduce((n, f) => n + (f.marks?.[k] ?? 0), 0);
  say(sum("words") > 0, `the scripts hold the words ${JSON.stringify(SOON)} (${sum("words")})`);
  say(sum("soonEl") >= 6, `the scripts draw the orders-soon element in ${sum("soonEl")} places, at least 6`);
  const missing = PLACES.filter((p) => sum(`place:${p}`) === 0);
  say(missing.length === 0, missing.length ? `no Coming soon at: ${missing.join(", ")}` : `Coming soon at each orders place: ${PLACES.join(", ")}`);
  say(sum("myOrders") > 0, `the token page's tab label ${JSON.stringify("My orders")} is in the scripts`);
  const left = Object.keys(MUST_NOT).filter((k) => sum(k) > 0);
  const name = { exitSwitch: "the exit plan switch", addExit: "the Add exit plan button", tabOff: "an order tab drawn off" };
  say(left.length === 0, left.length ? `an order control is still drawn: ${left.map((k) => `${name[k]} (${sum(k)})`).join(", ")}` : "no order control: no exit plan switch, no Add exit plan button, no order tab drawn off");
  say(css.some((f) => f.rule), "a stylesheet holds the tabs' empty state (.trb-soon)");
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await fetch(url, { redirect: "manual" });
  return { status: r.status, text: await r.text() };
}

export async function collect({ url = APP_URL, root = null } = {}) {
  const read = async (ref) => {
    if (root) {
      try {
        return { status: 200, text: readFileSync(path.join(root, new URL(ref, "http://x/").pathname), "utf8") };
      } catch {
        return { status: 404, text: "" };
      }
    }
    return http(new URL(ref, url).href);
  };
  const page = root ? { status: 200, text: readFileSync(path.join(root, "index.html"), "utf8") } : await http(url);
  const rec = { source: root ? `a local build read from ${path.basename(root)}` : url, at: new Date().toISOString(), pageStatus: page.status, js: [], css: [] };
  const refs = refsOf(page.text);
  for (const ref of refs.js) {
    const f = await read(ref);
    rec.js.push({ url: ref, status: f.status, marks: marksOf(f.text) });
  }
  for (const ref of refs.css) {
    const f = await read(ref);
    rec.css.push({ url: ref, status: f.status, rule: soonRuleIn(f.text) });
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ url: opt("--url", APP_URL), root: opt("--root", null) ? path.resolve(opt("--root", null)) : null });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
