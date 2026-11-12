#!/usr/bin/env node
// Live check of card closed-positions-after-a-restore: the deployed signing page rebuilds a restored device's trades. A
// device restored from the 12 words had the notes and each fresh wallet's buy record, and no trade op, so Portfolio's
// closed positions, its calendar and How you trade read nothing. It reads what SIGN_HOST serves: the page, then every
// script the page names, and checks the bundle holds:
//   - the restore's read of each fresh wallet hands back its buy and its later transactions, to its sale in full, and
//     a wallet read part way is read on from its last transaction read (packages/wallet/src/pool/buy-wallets.ts
//     solanaBuyReader: getSignaturesForAddress `until` the cursor);
//   - each becomes the op this device would have written, keyed by its signature (src/sol-buy-records.ts
//     restoredTradeOps: `restored/<signature>`, a buy, then each sale);
//   - a wallet sold in full is marked and not read again (TRADES_READ_KEY, owed/trades-sol-read);
//   - a buy with no USD (a rebuilt one) is priced at its own block (src/trade-fill.ts);
//   - an op whose transactions were read and give no figure is marked and not read again (src/trade-fill.ts
//     fill_none).
// The behaviour (the owner's three round trips of 12 Nov, restored on the published test seed) is the package's own
// test: packages/signpage/test/restore-trades.test.ts.
// After: sign --host sign
//   node scripts/live-checks/closed-positions-after-a-restore.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the marks each file holds, its pin and its sha384, not the files), so the check's
// test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "closed-positions-after-a-restore";
export const SIGN_URL = "https://confidential.unrealized.trade/";
// a minifier may quote a string with any of the three quotes and rename any identifier
const Q = "[`\"']";
const ID = "[\\w$]+";
/** The marks, and what the bundle holds when the change is in place. */
export const MARKS = {
  sign: [
    ["a wallet's trades are read on from where the last read stopped", new RegExp(`\\{until:${ID}\\.after\\}`)],
    ["each trade becomes an op keyed by its signature", new RegExp(`key:(?:\`restored/\\$\\{${ID}\\}\`|${Q}restored/${Q}\\+${ID}),rec:\\{kind:${Q}buy${Q}`)],
    ["a wallet sold in full is read for good", new RegExp(`${Q}owed/trades-sol-read${Q}`)],
    ["a buy with no USD is priced at its block", new RegExp(`${ID}\\.kind===${Q}buy${Q}&&${ID}\\.amount_usd===void 0`)],
    ["an op with no figure is marked and not read again", /,fill_none:!0\}/],
  ],
};
export const NAMES = { sign: MARKS.sign.map(([n]) => n) };

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
/** The check on one answer: { sign: { source, pageStatus, js: [{ url, status, found }] } }; one that holds no host fails. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const hosts = ["sign"].filter((h) => rec[h] !== undefined);
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

/** What SIGN_HOST serves, read with `fetchFn` (scripts/ci/bundle-checks.mjs passes one that answers from the
 *  build). */
export async function collect({ fetchFn = fetch } = {}) {
  return { at: new Date().toISOString(), sign: await host("sign", SIGN_URL, fetchFn) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const h = opt("--host", "sign");
  try {
    if (h !== "sign") throw new Error(`--host sign, not ${h}`);
    const rec = await collect();
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.sign.source})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
