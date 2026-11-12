#!/usr/bin/env node
// Live check of card round-trip-costs-less on SIGN_HOST (https://confidential.unrealized.trade). A round trip (a pool
// buy, then a full sell of it) lost the most to what the sell left on W: its token account's and its volume account's
// rent, a teardown frame and a second deposit to carry them into the pool. The signing page (packages/signpage/src/
// pool-sell.ts) gets them back for any browser of the account, which finishes any of its Ws. What it proves, and only
// that: the served /app.js is the one index.html pins (its sha384), and its text carries the card's rules, each found by
// a mark of the bundle's shape (the minifier renames, never restructures them):
//   - the sale's owed record keeps W's proven buy;
//   - the rent backs: every W of the account's (derived from the pool's spent notes, nothing read) found on the
//     helper's seat alone, in batches; a W with no record the helper reads empty listed empty, a W the helper reads as
//     at its last end on W's own state read on neither seat and passed not, the load's own reads only with a W to pass;
//     the Ws passed in an order drawn from the device's random source, a second and up to a second more apart; W's buy
//     proven on the public seat alone, once, against the restore's rebuilt record or its no-buy mark; an unproven W tried
//     again on each load to its third pass, then held as its own state; the positions' passes held only while a W is
//     read; the page reads the restore's no-buy mark.
// It does not prove those lines run: that is the signing page's tests at the released commit (test/pool-sell.test.ts,
// test/pool-testnet.test.ts, test/rules-pool.test.ts), and that the served files are that commit's build is
// signpage-release's. The money it saves is the card's run record (round-trip-costs-less.md), written with the real run.
// After: sign
//   node scripts/live-checks/round-trip-costs-less.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "round-trip-costs-less";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const esc = (n) => n.replace(/\$/g, "\\$");
const re = (s) => new RegExp(s);
/** A mark whose named groups name other code the bundle must hold too: `more(groups)` gives each further pattern. */
const tied = (main, more) => ({
  main,
  more,
  test(js) {
    const g = main.exec(js)?.groups;
    return Boolean(g) && more(g).every((p) => new RegExp(p).test(js));
  },
});
const R = String.raw;

/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "the sale's owed record keeps W's proven buy": re(R`(?<p>${I})\?\.buy!==void 0&&\((?<o>${I})\.buy=\k<p>\.buy\),await ${I}\.owed\?\.put\(\k<o>\)`),
  "every W of the account's found on the helper's seat alone, in batches; one with no record the helper reads empty listed empty; a W read as at its last end on its own state read on neither seat; the load's own reads only with a W to pass": tied(
    re(R`let (?<rd>${I})=await (?<fo>${I})\((?<rp>${I})\[1\],(?<ls>${I})\)\.catch\(\(\)=>null\),(?<td>${I})=\[\];for\(let\{address:(?<a>${I})\}of \k<ls>\)\{let (?<o>${I})=${I}\.find\((?<q>${I})=>\k<q>\.address===\k<a>\),(?<r>${I})=\k<rd>\?\.get\(\k<a>\);\k<o>\?\(\k<r>===void 0\?\k<o>\.seen===void 0:\k<o>\.seen!==\k<r>\.seen\)&&\k<td>\.push\(\k<a>\):\k<r>!==void 0&&\(\k<r>\.any\?\k<td>\.push\(\k<a>\):await Promise\.resolve\(${I}\.owed\.markEmpty\?\.\(\k<a>\)\)\.catch\(\(\)=>\{\}\)\)\}if\(\k<td>\.length===0\)return ${I}!==null\|\|\k<rd>===null;`),
    (g) => [
      // the finding read: W and its accounts for every W, the Rent sysvar first, at most 100 addresses a request
      R`[,; ](${I})=100,(?:${I}=[^,;{}]+[,;])*?async function ${esc(g.fo)}\((${I}),(${I})\)\{let (${I})=\3\.map\([^]{0,200}?,(${I})=\[(${I}),\.\.\.\4\.flat\(\)\],(${I})=\[\];for\(let (${I})=0;\8<\5\.length;\8\+=\1\)\7\.push\(\.\.\.await ${I}\(\2,\5\.slice\(\8,\8\+\1\)\)\)`,
      // the account's Ws, derived with nothing read
      R`(${I})=await (${I})\.wallets\((${I})\)\}catch\((${I})\)\{(${I})=\4\}`,
    ],
  ),
  "the Ws passed in an order drawn from the device's random source, a second and up to a second more apart": tied(
    // the list's own order drawn, then each W after the first a gap and a draw of up to as much again apart
    re(R`for\(let (?<i>${I})=(?<m>${I})\.length-1;\k<i>>0;\k<i>--\)\{let (?<k>${I})=(?<rb>${I})\(\k<i>\+1\);\[\k<m>\[\k<i>\],\k<m>\[\k<k>\]\]=\[\k<m>\[\k<k>\],\k<m>\[\k<i>\]\]\}[^]{0,800}?for\(let\[(?<n>${I}),${I}\]of \k<m>\.entries\(\)\)if\(\k<n>>0&&await ${I}\((?<gap>${I})\+\k<rb>\(\k<gap>\)\)`),
    (g) => [
      R`function ${esc(g.rb)}\((${I})\)\{if\(\1<=1\)return 0;let (${I})=Math\.floor\(4294967296/\1\)\*\1,(${I})=new Uint32Array\(1\);for\(;;\)if\(globalThis\.crypto\.getRandomValues\(\3\),\3\[0\]<\2\)return \3\[0\]%\1\}`,
      R`[,; ]${esc(g.gap)}=1e3[,;]`,
    ],
  ),
  "W's buy proven on the public seat alone, once, against the restore's rebuilt record or its no-buy mark": tied(
    re(R`async function (?<pb>${I})\((?<rp>${I}),(?<pr>${I}),(?<ad>${I}),(?<cl>${I})\)\{try\{let (?<a>${I})=await ${I}\(\k<rp>,\k<pr>\)\.read\(\k<ad>\);if\(\k<cl>===null\)return \k<a>===` + "`none`" + R`\?null:void 0;if\(\k<a>!==null&&\k<a>!==` + "`none`" + R`&&\k<a>\.mint===\k<cl>\.mint&&\k<a>\.program===\k<cl>\.program\)return\{mint:\k<a>\.mint,program:\k<a>\.program\}\}catch\{\}\}`),
    (g) => [R`(${I})=(${I})\.buy;(${I})===void 0&&\1===void 0&&\((${I})\.rec!==void 0\|\|\4\.none\)&&\(\1=await ${esc(g.pb)}\((${I})\.rpcs\[0\],`],
  ),
  "an unproven W tried again on each load to its third pass, then held as its own state": tied(
    re(R`(?<c>${I})=(?<o>${I})===void 0&&(?<s>${I})===void 0\?(?<n>${I})\.passes\+1>=3\?` + "`steady`:`again`" + R`:void 0`),
    (g) => [R`\|\|(${I})\.end===` + "`owed`" + R`\|\|${esc(g.c)}===` + "`again`", R`;try\{if\(!(${I})\.buy\)return (${I})\(` + "`holds`,`no buy of W's is recorded`" + R`,\1\.unproven!==` + "`again`" + R`\);`],
  ),
  "the positions' passes held only while a W is read": tied(
    re(R`let\{store:${I},sync:${I},rent:${I}\}=${I},(?<y>${I})=${I}===null,(?<rel>${I})=(?<h>${I})\.preempt\?\.\(\);try\{for\(`),
    (g) => [R`\}finally\{${esc(g.rel)}\?\.\(\)\}return ${esc(g.y)}\}`, R`wallets:async (${I})=>\{let (${I})=\1===(${I})\?null:(${I})\.preempt\(\),`, R`preempt:\(\)=>\{let (${I})=(${I})\.preempt\(\);return\(\)=>\1\.release\(\)\}`],
  ),
  "the page reads the restore's no-buy mark": tied(
    re(R`buyNone:async (?<a>${I})=>Object\.hasOwn\(${I}\(await\(await ${I}\.store\(\)\)\.get\(` + "`meta`" + R`,(?<k>${I})\)\),\k<a>\)`),
    (g) => [R`[,; ]${esc(g.k)}=` + "`owed/buy-sol-none`" + R`[,;]`],
  ),
});

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle carries. */
export function facts(index, js) {
  return { index, sha384: sha384(js), carries: Object.fromEntries(Object.entries(MARKS).map(([k, w]) => [k, w.test(js)])) };
}

/** The verdict on an answer { index, sha384, carries }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(MARKS)) if (a?.carries?.[k] !== true) bad(`the served bundle has no ${k}`);
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
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
