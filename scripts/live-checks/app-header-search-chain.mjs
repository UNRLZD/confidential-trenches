#!/usr/bin/env node
// Live check of card app-header-search-chain: the terminal's top bar finds any token by name, symbol or address and
// filters by chain, as design-lock-r5 draws it (app.js P.topbar, P.chainChip, P.phHeader; proto.css .searchwrap,
// .chainchip, .tb-searchBtn, .phh .sfi). Three reads:
//   - what the search searches: HELPER_HOST's GET /v1/market/lists?chain=solana, Discover's own read. It must answer 200
//     with a Solana snapshot holding at least one row with a token id and a symbol (the chain filter's chains with data);
//   - what a pasted address reads: HELPER_HOST's GET /v1/market/token for the first listed mint, which must answer 200
//     with that mint's row (source.ts loadToken's rule);
//   - what APP_HOST serves: the page, then every script and stylesheet it names, which must hold the search (search-input,
//     chain-chip, chain-menu, search-button-phone, search-sheet) and its rules (.srch-pop, .srch-sheet, .chainchip and the
//     narrow top bar's button under 1024 px: 1023.98px).
// The behaviour (type a symbol and open its page, paste a listed, an unlisted and an unknown address, switch the chain
// filter, the phone's search, CLS 0, no horizontal scroll, signed in and out) is the terminal's own browser run,
// apps/terminal/test/header-search/run.mjs, and the model apps/terminal/test/header-search.test.ts.
// After: app
//   node scripts/live-checks/app-header-search-chain.mjs [--url <url>] [--helper <url>] [--record <file>]
//   node scripts/live-checks/app-header-search-chain.mjs --root <dir> [...]   the page read from a local build
//     (apps/terminal/dist, built first) on disk; the helper is still read live
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the answers' facts and the markers each file holds, not the files), so the
// check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-header-search-chain";
export const APP_URL = "https://ct-app.unrealized.trade/";
export const HELPER_URL = "https://ct-api.unrealized.trade";
// each a test id only the search draws
export const JS_MARKERS = ["search-input", "chain-chip", "chain-menu", "search-button-phone", "search-sheet"];
// the search's rules and the narrow top bar's button (search.css)
export const CSS_MARKERS = [".srch-pop", ".srch-sheet", ".chainchip", "1023.98px"];

/** The page's scripts and stylesheets: the `src` of each script tag and the `href` of each stylesheet link. */
export function assetsOf(html) {
  const js = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  const css = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
  return { js, css };
}

const holds = (text, markers) => markers.filter((m) => text.includes(m));
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isRow = (r) => isObject(r) && typeof r.token === "string" && r.token !== "" && typeof r.symbol === "string" && r.symbol !== "";

/** The facts of one lists answer: the searchable rows (one per chain and token), their chains, and the first mint. */
export function listsFacts(status, body) {
  const b = isObject(body) ? body : {};
  const L = isObject(b.lists) ? b.lists : {};
  const rows = new Map();
  for (const list of Object.values(L)) if (Array.isArray(list)) for (const r of list) if (isRow(r)) rows.set(`${r.chain}/${r.token}`, r);
  const all = [...rows.values()];
  return { status, chain: b.chain ?? null, rows: all.length, chains: [...new Set(all.map((r) => r.chain))].sort(), first: all.find((r) => r.chain === "solana")?.token ?? null };
}

/** The facts of one token read: its status and whether its row is the asked mint's. */
export function tokenFacts(asked, status, body) {
  const row = isObject(body) && isObject(body.row) ? body.row : null;
  return { asked, status, row: row !== null && row.chain === "solana" && row.token === asked && typeof row.symbol === "string" && row.symbol !== "" };
}

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, lists: { status, chain, rows, chains, first }, token: { asked, status, row },
 *  pageStatus, js, css }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const l = rec.lists ?? {};
  say(l.status === 200 && l.chain === "solana", `the helper's lists read answers ${l.status ?? "nothing"} for ${l.chain ?? "no chain"}`);
  say(Number.isSafeInteger(l.rows) && l.rows > 0 && Array.isArray(l.chains) && l.chains.includes("solana"), `the search has ${l.rows ?? "no"} row(s) on ${(l.chains ?? []).join(", ") || "no chain"}`);
  const t = rec.token ?? {};
  say(typeof t.asked === "string" && t.asked === l.first && t.status === 200 && t.row === true, `the token read for a pasted mint (${t.asked ?? "none"}) answers ${t.status ?? "nothing"}${t.row ? " with its row" : " without its row"}`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const js = rec.js ?? [];
  const css = rec.css ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  say(css.length > 0 && css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  const jsHeld = new Set(js.flatMap((f) => f.found ?? []));
  const missJs = JS_MARKERS.filter((m) => !jsHeld.has(m));
  say(missJs.length === 0, missJs.length ? `the scripts lack the search: ${missJs.join(", ")}` : `the scripts hold the search: ${JS_MARKERS.join(", ")}`);
  const cssHeld = new Set(css.flatMap((f) => f.found ?? []));
  const missCss = CSS_MARKERS.filter((m) => !cssHeld.has(m));
  say(missCss.length === 0, missCss.length ? `the stylesheets lack the search's rules: ${missCss.join(", ")}` : `the stylesheets hold the search's rules: ${CSS_MARKERS.join(", ")}`);
  return { ok: lines.every((x) => x.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { origin: new URL(APP_URL).origin } });
  return { status: r.status, text: await r.text() };
}
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export async function collect({ url = APP_URL, helper = HELPER_URL, root = null } = {}) {
  const lr = await http(`${helper}/v1/market/lists?chain=solana`);
  const lists = listsFacts(lr.status, parse(lr.text));
  let token = { asked: null, status: null, row: false };
  if (lists.first) {
    const tr = await http(`${helper}/v1/market/token?chain=solana&token=${encodeURIComponent(lists.first)}`);
    token = tokenFacts(lists.first, tr.status, parse(tr.text));
  }
  const read = async (ref, base) => {
    if (root) {
      const file = path.join(root, new URL(ref, "http://x/").pathname);
      try {
        return { status: 200, text: readFileSync(file, "utf8") };
      } catch {
        return { status: 404, text: "" };
      }
    }
    return http(new URL(ref, base).href);
  };
  const page = root ? { status: 200, text: readFileSync(path.join(root, "index.html"), "utf8") } : await http(url);
  const { js, css } = assetsOf(page.text);
  const rec = { source: `${root ? `a local build read from ${path.basename(root)}` : url}; ${helper}`, at: new Date().toISOString(), lists, token, pageStatus: page.status, js: [], css: [] };
  for (const ref of js) {
    const f = await read(ref, url);
    rec.js.push({ url: ref, status: f.status, found: holds(f.text, JS_MARKERS) });
  }
  for (const ref of css) {
    const f = await read(ref, url);
    rec.css.push({ url: ref, status: f.status, found: holds(f.text, CSS_MARKERS) });
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ url: opt("--url", APP_URL), helper: opt("--helper", HELPER_URL), root: opt("--root", null) ? path.resolve(opt("--root", null)) : null });
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
