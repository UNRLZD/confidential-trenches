#!/usr/bin/env node
// Live check of card sol-pool-buys-mayhem-coins on APP_HOST (https://ct-app.unrealized.trade) and SIGN_HOST
// (https://confidential.unrealized.trade). What it holds, and only that: each host serves the script its index.html pins
// (its sha384), and
//   - SIGN_HOST's buy and sell answer a coin the build does not trade (the kit's SolanaPoolBuyError venue_not_built: a
//     Mayhem curve or pool, a curve not in SOL) by that code (packages/signpage/src/pool-buy.ts and pool-sell.ts, as
//     minified: `{error:"venue_not_built"}` and `{error:"venue_not_built",cause:n}`), never "failed";
//   - APP_HOST's trade box draws that code as the owner's Unavailable (apps/terminal/src/screens/trade/model.ts REASONS,
//     as minified: `venue_not_built:"unavailable"`), so Buy (and Sell) stay off with no Retry.
// The behaviour itself is the tests that run it: packages/kit/test/solana-pool-buy.test.ts (the code, only when both
// providers read it so), packages/signpage/test/pool-buy.test.ts and pool-sell.test.ts (refused before the claim or the
// build, nothing signed or sent), apps/terminal/test/three-owner-labels.test.ts (Unavailable, no Retry, Sell off). The
// recorded answers are facts() over each host's build (apps/terminal/dist; packages/signpage index.html and
// public/app.js, the build the deploy makes).
// After: app sign
// Bundle: read app
//   node scripts/live-checks/sol-pool-buys-mayhem-coins.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sol-pool-buys-mayhem-coins";
export const APP = "https://ct-app.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const Q = "[`\"']";
/** The app's reason for the code: the trade box's Unavailable. */
const REASON = new RegExp(`venue_not_built:${Q}unavailable${Q}`);
/** The page's answer by the code: the buy's (alone) and the sale's (with its cause). */
const ANSWER = new RegExp(`\\{error:${Q}venue_not_built${Q}(,cause:${N})?\\}`, "g");

/** The script an index.html pins, and its integrity. */
const pinned = (index) => {
  const m = /<script[^>]*\bsrc="([^"]+\.js)"[^>]*\bintegrity="([^"]+)"/.exec(index ?? "") ?? /<script[^>]*\bintegrity="([^"]+)"[^>]*\bsrc="([^"]+\.js)"/.exec(index ?? "");
  if (!m) return null;
  return m[1].endsWith(".js") ? { src: m[1], integrity: m[2] } : { src: m[2], integrity: m[1] };
};

/** What the check keeps of the reads: each host's index, its served script's sha384, and the marks read from it. */
export function facts(app, sign) {
  const answers = [...sign.js.matchAll(ANSWER)];
  return {
    app: { index: app.index, sha384: sha384(app.js), reason: REASON.test(app.js) },
    sign: { index: sign.index, sha384: sha384(sign.js), buy: answers.some((m) => m[1] === undefined), sell: answers.some((m) => m[1] !== undefined) },
  };
}

/** The verdict on an answer { app: { index, sha384, reason }, sign: { index, sha384, buy, sell } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  for (const [host, name] of [["app", "APP_HOST"], ["sign", "SIGN_HOST"]]) {
    const pin = pinned(a?.[host]?.index);
    if (!pin) bad(`${name}'s index.html pins no script`);
    else if (pin.integrity !== a[host].sha384) bad(`${name}'s served script is not the one index.html pins`);
  }
  if (a?.sign?.buy !== true) bad("the signing page's buy does not answer venue_not_built: a Mayhem coin's buy ends Failed with a Retry that cannot work");
  if (a?.sign?.sell !== true) bad("the signing page's sell does not answer venue_not_built: a Mayhem coin's sale ends Failed with a Retry that cannot work");
  if (a?.app?.reason !== true) bad("the app does not draw venue_not_built as Unavailable: the trade box shows Failed with Retry");
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (origin, path) => {
    const r = await fetchFn(`${origin}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${origin}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const host = async (origin) => {
    const index = await get(origin, "/");
    const pin = pinned(index);
    if (!pin) return { index, js: "" };
    return { index, js: await get(origin, pin.src.startsWith("/") ? pin.src : `/${pin.src}`) };
  };
  const [app, sign] = await Promise.all([host(APP), host(SIGN)]);
  return facts(app, sign);
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
