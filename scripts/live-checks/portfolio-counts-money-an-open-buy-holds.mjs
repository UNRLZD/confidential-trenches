#!/usr/bin/env node
// Live check of card portfolio-counts-money-an-open-buy-holds on SIGN_HOST (https://confidential.unrealized.trade) and
// APP_HOST (https://ct-app.unrealized.trade). Reads only: nothing is signed or sent, no one is signed in.
// The fault (owner, 12 Nov): Portfolio's Positions and Total counted a buy's tokens and left out the SOL its one-time
// wallet holds beside them (its own coin and the rent of the accounts a full sell closes back to it), so Total read
// below what the user had; a row's Bought and Value were floored to the cent ($0.0999999 read $0.09), and the value
// chart's axis labels could read alike. What this proves, and only that: each served script is the one its page pins
// (its sha384), and it carries, each found by a mark of the bundle's shape:
//   - SIGN_HOST (packages/signpage/src/positions.ts solanaAssetHeld, positionsOf): one batched getMultipleAccounts at
//     finalized with a zero-length dataSlice, every W's accounts flattened into it, reads the SOL each W holds, and a
//     position carries it as asset_held in whole SOL (9 decimals);
//   - APP_HOST (apps/terminal/src/screens/portfolio/model.ts): Portfolio's Positions and Total sum each position's
//     asset_held (openBuysHold: none for a position whose wallet an arm record already counts), a row's Bought and
//     Value read to the nearest cent (centsNear, nearCents), and the chart's axis labels add decimals until no two
//     read alike (axisLabels).
// It does not prove a figure: the rule is packages/signpage/test/positions-asset-held.test.ts and
// apps/terminal/test/portfolio's own tests at the released commit. Each host's deploy runs its own half, so a host that
// lags does not fail the other's deploy; the check runs on a pull request's own builds too (scripts/ci/bundle-checks.mjs).
// After: app --host app
// After: sign --host sign
//   node scripts/live-checks/portfolio-counts-money-an-open-buy-holds.mjs [--host app|sign] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2 (no --host: both)
// --record writes what the run read (each host's page, its scripts' pins and sha384, the marks each holds; not the
// files), so the check's test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "portfolio-counts-money-an-open-buy-holds";
export const APP_URL = "https://ct-app.unrealized.trade/";
export const SIGN_URL = "https://confidential.unrealized.trade/";
// a minifier may quote a string with any of the three quotes and rename any identifier
const Q = "[`\"']";
const ID = "[\\w$]+";
const q = (w) => `${Q}${w}${Q}`;
/** Each host's marks: its name, and what the bundle holds when the change is in place. */
export const MARKS = {
  sign: [
    ["a W's SOL is read in one getMultipleAccounts at finalized with a zero dataSlice", new RegExp(`${ID}\\.flatMap\\(${ID}=>${ID}\\.keys\\.map\\(\\(\\[${ID}\\]\\)=>${ID}\\)\\),${ID}=\\(await ${ID}\\(${q("getMultipleAccounts")},\\[${ID},\\{encoding:${q("base64")},commitment:${q("finalized")},dataSlice:\\{offset:0,length:0\\}\\}\\]\\)\\)`)],
    ["a position carries asset_held in whole SOL, absent when a W was not read", new RegExp(`wallets:${ID}\\.wallets,decimals:${ID},\\.\\.\\.${ID}===null\\?\\{\\}:\\{asset_held:${ID}\\(${ID},${ID}\\)\\}`)],
  ],
  app: [
    ["Portfolio's positions sum each position's asset_held, none for a wallet already counted", new RegExp(`${ID}\\.asset_held===void 0\\|\\|${ID}\\.wallets\\.some\\(`)],
    ["a row's Bought reads to the nearest cent, half up", new RegExp(`\\+\\(Number\\(${ID}\\[2\\]\\?\\?${q("0")}\\)>=5\\?1n:0n\\)`)],
    ["a row's Value reads to the nearest cent, half up", new RegExp(`\\(${ID}\\*200n\\+${ID}\\)\\/\\(2n\\*${ID}\\)`)],
    ["the chart's axis labels add decimals until none read alike", new RegExp(`\\.size<${ID}&&${ID}<=8;${ID}\\+\\+\\)`)],
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
