#!/usr/bin/env node
// Live check of card sell-box-says-quoting on APP_HOST (https://ct-app.unrealized.trade): the sell box's You receive
// says Quoting while its preview (the signing page's pool.sell.dry) is asked, as the buy box's does. A live read needs
// a holding to sell, and a fresh account holds none, so this reads what APP_HOST serves. Reads only: nothing is signed
// or sent. What it holds, and only that: APP_HOST serves the script its index.html pins (its sha384), and, each found by
// a mark of the minified bundle's shape (apps/terminal/src/screens/positions/model.ts sellDryTag and sellQuoting,
// SellBox.tsx):
//   - rule: Quoting is drawn only with no number and this token's and amount's preview asked and not ended
//     (sellQuoting over sellDryTag);
//   - wired: the sell box reads that rule with whether a number shows;
//   - drawn: You receive (`sell-receive`) draws the number, else the Quoting word while the rule holds, else the dash.
// The asking state's end (an answer, a refusal asked no more, a new token or amount, DRY_TRIES client timeouts) is
// driven in apps/terminal/test/sell-positions/run.mjs (dry=late, busyfor, downfor, refuse). The recorded answers are
// facts() over apps/terminal/dist as the deploy builds it.
// After: app
// Bundle: read app
//   node scripts/live-checks/sell-box-says-quoting.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sell-box-says-quoting";
export const APP = "https://ct-app.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (v) => v.replace(/\$/g, "\\$");

/** sellDryTag: `t_=(e,t)=>t===null?null:`${e}|${t}`` (group 1: its name). */
const TAG = new RegExp(`(?:^|[^\\w$.])(${N})=\\((${N}),(${N})\\)=>\\3===null\\?null:\`\\$\\{\\2\\}\\|\\$\\{\\3\\}\``);

/** The marks read from APP_HOST's script. */
export function marks(js) {
  const tag = TAG.exec(js);
  // sellQuoting: `function f(e,t,n,r){return!e&&r!==null&&r===t_(t,n)}`
  const rule = tag ? new RegExp(`function (${N})\\((${N}),(${N}),(${N}),(${N})\\)\\{return!\\2&&\\5!==null&&\\5===${esc(tag[1])}\\(\\3,\\4\\)\\}`).exec(js) : null;
  // the box: `j=f(ee!==null,...)`, the number's cents tested against null
  const wiredM = rule ? new RegExp(`(?:^|[^\\w$.])(${N})=${esc(rule[1])}\\((${N})!==null,`).exec(js) : null;
  // the cell: `"data-testid":`sell-receive`,children:ee===null?j?(0,U.jsx)(W,{id:`quoting`}):`—`:`≈ ${usd(ee)}``
  const drawn = wiredM !== null && new RegExp(`"data-testid":\`sell-receive\`,children:${esc(wiredM[2])}===null\\?${esc(wiredM[1])}\\?\\(0,${N}\\.jsx\\)\\(${N},\\{id:\`quoting\`\\}\\):\`—\`:\`≈ \\$\\{${N}\\(${esc(wiredM[2])}\\)\\}\``).test(js);
  return { rule: rule !== null, wired: wiredM !== null, drawn };
}

/** The script an index.html pins, and its integrity. */
const pinned = (index) => {
  const m = /<script[^>]*\bsrc="([^"]+\.js)"[^>]*\bintegrity="([^"]+)"/.exec(index ?? "") ?? /<script[^>]*\bintegrity="([^"]+)"[^>]*\bsrc="([^"]+\.js)"/.exec(index ?? "");
  if (!m) return null;
  return m[1].endsWith(".js") ? { src: m[1], integrity: m[2] } : { src: m[2], integrity: m[1] };
};

/** What the check keeps of the reads: the index, the served script's sha384, and the marks read from it. */
export function facts(index, js) {
  return { index, sha384: sha384(js), ...marks(js) };
}

export const SAYS = Object.freeze({
  rule: "the sell box has no Quoting rule (no number, and this token's and amount's preview asked and not ended)",
  wired: "the sell box does not read the Quoting rule with whether a number shows",
  drawn: "the sell box's You receive does not draw Quoting while its preview is asked (the number, else Quoting, else the dash)",
});

/** The verdict on an answer { index, sha384, rule, wired, drawn }. */
export function judge(a) {
  const lines = [];
  const pin = pinned(a?.index);
  if (!pin) lines.push("BAD APP_HOST's index.html pins no script");
  else if (pin.integrity !== a.sha384) lines.push("BAD APP_HOST's served script is not the one index.html pins");
  for (const [k, say] of Object.entries(SAYS)) if (a?.[k] !== true) lines.push(`BAD ${say}`);
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${APP}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  const pin = pinned(index);
  if (!pin) return facts(index, "");
  return facts(index, await get(pin.src.startsWith("/") ? pin.src : `/${pin.src}`));
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
