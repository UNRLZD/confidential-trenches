#!/usr/bin/env node
// Live check of card app-sell-shows-what-you-receive on APP_HOST (https://ct-app.unrealized.trade) and SIGN_HOST
// (https://confidential.unrealized.trade). What it holds, and only that: each host serves the script its index.html pins
// (its sha384), and
//   - APP_HOST's asks the signing page's pool.sell.dry for the sell box's preview (src/screens/positions/model.ts
//     askSellPreview, as minified: `e(`pool.sell.dry`,i.params).outcome`), so the box's You receive, Network and Fee
//     come from the page, never a dash that stays;
//   - SIGN_HOST's answers the kind (src/main.ts, as minified: `"pool.sell.dry":e=>d(e)` in the page's kinds);
//   - APP_HOST's box asks again each second on busy or not_funded (src/screens/positions/SellBox.tsx NOT_YET, as
//     minified: `new Set([`busy`,`not_funded`])`), so a preview asked while a buy runs or before the page's read has the
//     fill's holding comes as soon as the page has it (devnet runs 11 and 12, 11 Nov: the dash for good);
//   - SIGN_HOST's buy gives its hosts back at its early "sent" (packages/signpage/src/pool-buy.ts, as minified:
//     `h.release?.()`), so the preview's reads are not held to the buy's Final (33.8 s on devnet run 11).
// The numbers themselves are held by the tests that build them (packages/signpage/test/pool-sell-dry.test.ts on the
// recorded venues, apps/terminal/test/sell-positions/run.mjs in a browser). The recorded answers are facts() over each
// host's build (apps/terminal/dist; packages/signpage index.html and public/app.js, the build the deploy makes).
// After: app sign
//   node scripts/live-checks/app-sell-shows-what-you-receive.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "app-sell-shows-what-you-receive";
export const APP = "https://ct-app.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const Q = "[`\"']";
/** The app's ask: the request call for pool.sell.dry with the tap's own params, its outcome awaited. */
const ASK = new RegExp(`${N}\\(${Q}pool\\.sell\\.dry${Q},${N}\\.params\\)\\.outcome`);
/** The page's kind: pool.sell.dry in the kinds the api answers, a function of the request's params. */
const KIND = new RegExp(`${Q}pool\\.sell\\.dry${Q}:(${N})=>${N}\\(\\1\\)`);
/** The box's codes asked again each second: busy and not_funded, in that order, one set. */
const AGAIN = new RegExp(`new Set\\(\\[${Q}busy${Q},${Q}not_funded${Q}\\]\\)`);
/** The buy's host given back at its early sent: an optional call of the host's release. */
const RELEASE = new RegExp(`${N}\\.release\\?\\.\\(\\)`);

/** The script an index.html pins, and its integrity. */
const pinned = (index) => {
  const m = /<script[^>]*\bsrc="([^"]+\.js)"[^>]*\bintegrity="([^"]+)"/.exec(index ?? "") ?? /<script[^>]*\bintegrity="([^"]+)"[^>]*\bsrc="([^"]+\.js)"/.exec(index ?? "");
  if (!m) return null;
  return m[1].endsWith(".js") ? { src: m[1], integrity: m[2] } : { src: m[2], integrity: m[1] };
};

/** What the check keeps of the reads: each host's index, its served script's sha384, and the mark read from it. */
export function facts(app, sign) {
  return {
    app: { index: app.index, sha384: sha384(app.js), ask: ASK.test(app.js), again: AGAIN.test(app.js) },
    sign: { index: sign.index, sha384: sha384(sign.js), kind: KIND.test(sign.js), release: RELEASE.test(sign.js) },
  };
}

/** The verdict on an answer { app: { index, sha384, ask, again }, sign: { index, sha384, kind, release } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  for (const [host, name] of [["app", "APP_HOST"], ["sign", "SIGN_HOST"]]) {
    const pin = pinned(a?.[host]?.index);
    if (!pin) bad(`${name}'s index.html pins no script`);
    else if (pin.integrity !== a[host].sha384) bad(`${name}'s served script is not the one index.html pins`);
  }
  if (a?.app?.ask !== true) bad("the app does not ask the signing page's pool.sell.dry: the sell box shows no You receive");
  if (a?.sign?.kind !== true) bad("the signing page does not answer pool.sell.dry: the sell box's preview is refused");
  if (a?.app?.again !== true) bad("the sell box does not ask again on busy or not_funded: a preview asked during or just after a buy stays a dash");
  if (a?.sign?.release !== true) bad("the signing page's buy holds its hosts to its Final: the sell box's preview is busy until then");
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
