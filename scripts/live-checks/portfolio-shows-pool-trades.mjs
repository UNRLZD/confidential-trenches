#!/usr/bin/env node
// Live check of card portfolio-shows-pool-trades: the deployed app draws each pool round trip from the device's own
// trade records, and the deployed signing page writes the records it draws them from. It reads what APP_HOST and
// SIGN_HOST serve: each page, then every script the page names, and checks the bundles hold:
//   - SIGN_HOST: the state sends an op's pool_amount (src/state.ts's op detail keys, kit 1.10), a filled pool buy's op
//     is written with the SOL it spent (src/positions.ts recordPoolBuy: pool_amount from its spend at its decimals),
//     the fill reads each filled trade's own transaction and writes its SOL at 9 decimals, and an old sale's USD at the
//     SOL/USD feed write of its own block, marked usd_from "block" (src/trade-fill.ts);
//   - APP_HOST: Portfolio's trade book reads pool_amount from the ops (model.ts tradeBook) and a closed row draws its
//     realized in the pool's asset (data-realized-asset).
// The behaviour (the rule on the owner's four mainnet transactions of 12 Nov, the fill of release 118's records, the
// rows Portfolio draws from them) is the packages' own tests: packages/signpage/test/trade-fill.test.ts,
// apps/terminal/test/portfolio-pool-trades.test.ts and apps/terminal/test/portfolio/run.mjs.
// Each host's deploy runs its own half, so a host that lags does not fail the other's deploy.
// After: app --host app
// After: sign --host sign
// Bundle: read sign
// Bundle: read app
//   node scripts/live-checks/portfolio-shows-pool-trades.mjs [--host app|sign] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2 (no --host: both)
// --record writes what the run read (the marks each file holds, its pin and its sha384, not the files), so the check's
// test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "portfolio-shows-pool-trades";
export const APP_URL = "https://ct-app.unrealized.trade/";
export const SIGN_URL = "https://confidential.unrealized.trade/";
// a minifier may quote a string with any of the three quotes and rename any identifier
const Q = "[`\"']";
const ID = "[\\w$]+";
/** Each host's marks: its name, and what the bundle holds when the change is in place. */
export const MARKS = {
  sign: [
    ["the state sends an op's pool_amount", new RegExp(`${Q}units${Q},${Q}amount_usd${Q},${Q}pool_amount${Q}\\]`)],
    ["a filled pool buy's op names its SOL", new RegExp(`units:${ID}\\.out,pool_amount:${ID}\\(${ID}\\.spend,${ID}\\.spendDecimals\\)`)],
    ["the fill writes each trade's SOL from its transaction", new RegExp(`pool_amount:${ID}\\(${ID},9\\)`)],
    // an old sale's USD at its own block's SOL/USD feed write, marked as such
    ["an old sale's USD at its block's price, marked block", new RegExp(`\\[${ID}\\.amount_usd,${ID}\\.usd_from\\]=\\[${ID}\\(${ID},27\\),${Q}block${Q}\\]`)],
  ],
  app: [
    ["the trade book reads pool_amount", new RegExp(`${ID}\\(${ID}\\.pool_amount\\)`)],
    ["a closed row draws its realized in the pool asset", new RegExp(`${Q}data-realized-asset${Q}:`)],
  ],
};
export const NAMES = { sign: MARKS.sign.map(([n]) => n), app: MARKS.app.map(([n]) => n) };

/** The page's scripts: the `src` of each script tag, with its `integrity` when it has one. */
export const scriptsOf = (html) =>
  [...html.matchAll(/<script\b[^>]*>/gi)].flatMap((m) => {
    const src = /\bsrc="([^"]+)"/i.exec(m[0])?.[1];
    return src ? [{ src, integrity: /\bintegrity="([^"]+)"/i.exec(m[0])?.[1] ?? null }] : [];
  });
/** A script's sha384, as an integrity attribute names it. */
export const sha384 = (text) => `sha384-${createHash("sha384").update(text).digest("base64")}`;
/** The names of `host`'s marks a script holds. */
export const marksIn = (host, text) => MARKS[host].filter(([, re]) => re.test(text)).map(([n]) => n);

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { sign?: { source, pageStatus, js: [{ url, status, found }] }, app?: { ... } }, each host it
 *  holds; one that holds neither fails. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const hosts = ["sign", "app"].filter((h) => rec[h] !== undefined);
  say(hosts.length > 0, `hosts read: ${hosts.join(", ") || "none"}`);
  for (const host of hosts) {
    const h = rec[host];
    say(h.pageStatus === 200, `${host}: the page answers ${h.pageStatus ?? "nothing"}`);
    const js = h.js ?? [];
    say(js.length > 0 && js.every((f) => f.status === 200), `${host}: ${js.length} script(s) named by the page, each answering 200`);
    // each script's bytes are the ones its page pins: the browser runs no other, so marks in another file prove nothing
    const off = js.filter((f) => typeof f.integrity !== "string" || f.integrity !== f.sha384);
    say(off.length === 0, off.length ? `${host}: not the script its page pins: ${off.map((f) => f.url).join(", ")}` : `${host}: each script is the one its page pins`);
    const held = new Set(js.flatMap((f) => f.found ?? []));
    const miss = NAMES[host].filter((n) => !held.has(n));
    say(miss.length === 0, miss.length ? `${host}: the scripts lack: ${miss.join("; ")}` : `${host}: ${NAMES[host].join("; ")}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function host(name, url, fetchFn) {
  const http = async (u) => {
    const r = await fetchFn(u, { redirect: "manual" });
    return { status: r.status, text: await r.text() };
  };
  const page = await http(url);
  const rec = { source: url, pageStatus: page.status, js: [] };
  for (const { src, integrity } of scriptsOf(page.text)) {
    const f = await http(new URL(src, url).href);
    rec.js.push({ url: src, status: f.status, integrity, sha384: sha384(f.text), found: marksIn(name, f.text) });
  }
  return rec;
}

/** What each of `hosts` serves, read with `fetchFn` (scripts/ci/bundle-checks.mjs passes one that answers from the
 *  build). */
export async function collect({ hosts = ["sign", "app"], fetchFn = fetch } = {}) {
  const rec = { at: new Date().toISOString() };
  if (hosts.includes("sign")) rec.sign = await host("sign", SIGN_URL, fetchFn);
  if (hosts.includes("app")) rec.app = await host("app", APP_URL, fetchFn);
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const h = opt("--host", null);
  try {
    if (h !== null && h !== "app" && h !== "sign") throw new Error(`--host app|sign, not ${h}`);
    const rec = await collect({ hosts: h === null ? ["sign", "app"] : [h] });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${[rec.sign?.source, rec.app?.source].filter(Boolean).join(", ")})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `f` answers from the build
 *  folders as the host would; `dirs` names them (card ci-stops-costing-reruns, moved from bundle-checks.mjs). */
export async function bundle(f, { host }) {
  return judge(await collect({ hosts: [host], fetchFn: f }));
}
