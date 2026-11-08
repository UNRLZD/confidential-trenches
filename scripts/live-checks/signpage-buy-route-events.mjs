#!/usr/bin/env node
// Live check of card signpage-buy-route-events: a running pool.buy's route (the one-time wallet W it bound, the quote's
// venue and pool address, the amount W received read back on both RPCs) reaches the trade box's buy strip as the kit's
// route events (messages.ts BuyRoute). It reads what the two hosts serve and checks each deployed bundle carries its half:
//   - sign: SIGN_HOST's served page and the script it names (/app.js) answer 200, and the script holds the API's route
//     poster (src/api.ts: the event names each BuyRoute field itself from the route's own keys, own("wallet") ?
//     {wallet: r.wallet} ...) and hands it to the kinds' context next to `progress` (progress: ..., route: ...);
//   - app: APP_HOST's served page and every script it names answer 200, and the scripts hold the kit client's onRoute
//     (packages/kit/src/signpage/client.ts) and the trade source's live seam fed from it (source.tsx: route:
//     client ? liveRoute(client.onRoute.bind(client)) : null).
// The pool.buy run that posts the route (src/pool-buy.ts) and the strip that draws it are proven by their own tests:
// packages/signpage/test/pool-buy.test.ts (a fixture buy posts each field once, in order, under its id),
// packages/kit/test/signpage-client.test.mjs (onRoute; an earlier kit's client drops route events and keeps every stage),
// apps/terminal/test/buy-route.test.ts and test/buy-route/run.mjs (the live seam's values on the strip). SIGN_HOST's
// mainnet build answers pool.buy only once pinned pools land there, so no live buy runs here.
//   node scripts/live-checks/signpage-buy-route-events.mjs [--host sign|app] [--record <file>]
//     the deployed hosts (both unless --host names one): SIGN_HOST https://confidential.unrealized.trade/ and
//     APP_HOST https://ct-app.unrealized.trade/
//   node scripts/live-checks/signpage-buy-route-events.mjs --local [--host sign|app] [--record <file>]
//     the same read on this checkout: packages/signpage (index.html, public/app.js) and apps/terminal/dist (built first)
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (which markers each file holds, not the files), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "signpage-buy-route-events";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const HOSTS = {
  sign: { url: "https://confidential.unrealized.trade/", local: path.join(ROOT, "packages/signpage"), localJs: (ref) => path.join("public", new URL(ref, "http://x/").pathname) },
  app: { url: "https://ct-app.unrealized.trade/", local: path.join(ROOT, "apps/terminal/dist"), localJs: (ref) => new URL(ref, "http://x/").pathname },
};
const Q = "[\"'`]";
const ID = "[\\w$]+";
/** Each host's markers, by name: a regex over its scripts, robust to the minifier's names. */
export const MARKERS = {
  sign: {
    "the route poster": new RegExp(`${ID}\\(${Q}wallet${Q}\\)\\s*\\?\\s*\\{\\s*wallet:\\s*${ID}\\.wallet\\s*\\}`),
    "the kinds' route context": new RegExp(`progress:\\s*${ID},\\s*route:\\s*${ID}\\s*\\}`),
  },
  app: {
    "the kit client's onRoute": new RegExp(`onRoute\\(${ID}\\)\\s*\\{\\s*return`),
    "the trade source's live seam": new RegExp(`route:\\s*${ID}\\s*\\?\\s*${ID}\\(${ID}\\.onRoute\\.bind\\(${ID}\\)\\)`),
  },
};

/** The page's scripts: the `src` of each script tag. */
export const scriptsOf = (html) => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
const found = (host, text) => Object.entries(MARKERS[host]).filter(([, re]) => re.test(text)).map(([name]) => name);

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { hosts: { sign?: { source, pageStatus, js: [{ url, status, found }] }, app?: ... } }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const hosts = Object.keys(rec?.hosts ?? {});
  say(hosts.length > 0 && hosts.every((h) => Object.hasOwn(MARKERS, h)), `hosts read: ${hosts.join(", ") || "none"}`);
  for (const h of hosts.filter((x) => Object.hasOwn(MARKERS, x))) {
    const r = rec.hosts[h];
    say(r.pageStatus === 200, `${h}: the page answers ${r.pageStatus ?? "nothing"} (${r.source})`);
    const js = r.js ?? [];
    say(js.length > 0 && js.every((f) => f.status === 200), `${h}: ${js.length} script(s) named by the page, each answering 200`);
    const held = new Set(js.flatMap((f) => f.found ?? []));
    const miss = Object.keys(MARKERS[h]).filter((m) => !held.has(m));
    say(miss.length === 0, miss.length ? `${h}: the scripts lack ${miss.join(", ")}` : `${h}: the scripts hold ${Object.keys(MARKERS[h]).join(", ")}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await fetch(url, { redirect: "manual" });
  return { status: r.status, text: await r.text() };
}

async function readHost(host, local) {
  const h = HOSTS[host];
  const file = (rel) => {
    try {
      return { status: 200, text: readFileSync(path.join(h.local, rel), "utf8") };
    } catch {
      return { status: 404, text: "" };
    }
  };
  const page = local ? file("index.html") : await http(h.url);
  const rec = { source: local ? `this checkout, ${path.relative(ROOT, h.local)}` : h.url, pageStatus: page.status, js: [] };
  for (const ref of scriptsOf(page.text)) {
    const f = local ? file(h.localJs(ref)) : await http(new URL(ref, h.url).href);
    rec.js.push({ url: ref, status: f.status, found: found(host, f.text) });
  }
  return rec;
}

export async function collect({ hosts = ["sign", "app"], local = false } = {}) {
  const rec = { at: new Date().toISOString(), hosts: {} };
  for (const h of hosts) rec.hosts[h] = await readHost(h, local);
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const host = opt("--host", null);
    if (host !== null && !Object.hasOwn(HOSTS, host)) throw new Error("--host: sign or app");
    const rec = await collect({ hosts: host ? [host] : ["sign", "app"], local: a.includes("--local") });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${Object.values(rec.hosts).map((r) => r.source).join("; ")})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
