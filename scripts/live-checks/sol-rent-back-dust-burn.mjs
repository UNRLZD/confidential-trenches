#!/usr/bin/env node
// Live check of card sol-rent-back-dust-burn on SIGN_HOST (https://confidential.unrealized.trade). After a full sell,
// a balance W's token account holds that the sell did not leave (a stranger's unit sent to it) no longer strands W's
// rent: the rent back burns it, closes the account and sweeps W. The signing page's pool sell
// (packages/signpage/src/pool-sell.ts) decides what is a stranger's; the kit's teardown plan and check
// (packages/kit/src/checks/solana/checks.ts) allow the burn and nothing else. What it proves, and only that: the served
// /app.js is the one index.html pins (its sha384), and its text carries the card's rules, each found by a mark of the
// bundle's shape (the minifier renames, never restructures them):
//   - the owed record keeps each full sell's own signed bytes and its blockhash's last height, by mint, before the send;
//   - a balance is a stranger's only when that very transaction reads ok on both RPCs and its meta's post token
//     balances say, alike on both, that W's account of that mint held 0 after it; no record, a sell that failed or
//     never landed (past its blockhash on both, and each RPC's status of its own signature none at a slot that RPC is
//     past at: card sol-sell-deposit-back-floor, review F3 of b38cd8c2), or one that left a balance, makes it W's own
//     (the pass ends holds); a
//     sell not read yet with its blockhash still running holds with nothing stored; anything else is a fault;
//   - only those accounts go to the plan's burn list, and the teardown's check is handed the same list;
//   - the plan burns a named account's whole balance only when it would close but for it, it is not native, it is no
//     claim's destination, and its only extension, if any, is ImmutableOwner (7);
//   - the check passes a Burn only of exactly the plan's amount, of the account's own mint, under its own token
//     program, the wallet signing, right before that account's close, and requires each planned burn exactly once.
// It does not prove those lines run: that is the signing page's tests at the released commit (test/pool-sell.test.ts)
// and the kit's (packages/kit/test/solana-teardown-rules.test.ts); that the served files are that commit's build is
// signpage-release's.
// After: sign
//   node scripts/live-checks/sol-rent-back-dust-burn.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sol-rent-back-dust-burn";
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
/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "the owed record keeps the full sell's signed bytes and last height by mint, before the send": re(String.raw`(?<o>${I})\.sell=\{\.\.\.(?<p>${I})\?\.sell,\[(?<m>${I})\]:\{tx:${I}\.encode\((?<s>${I})\),last:(?<b>${I})\.lastHeight\}\},await (?<h>${I})\.owed\?\.put\(\k<o>\)\.catch\(\(\)=>\{\}\)\}await \k<h>\.signed\?\.\(`),
  "a balance is a stranger's only when the sell itself, read ok and final on both RPCs before W's accounts, says plainly what W's account held after it; W's own otherwise, unsure while it may land; burned only then, the plan and the check handed the same list": tied(
    re(String.raw`(?<so>${I})=async (?<m>${I})=>\{let (?<by>${I})=(?<x>${I})\.sell\?\.\[\k<m>\];if\(\k<by>===void 0\)return\`no\`;let (?<sg>${I})=${I}\.decode\(\k<by>\.tx\);if\(\k<sg>\.length<65\|\|\k<sg>\[0\]!==1\)throw Error\(\`[^\`]*\`\);let (?<g>${I})=await (?<bo>${I})\((?<rp>${I}),(?<q>${I})=>(?<rb>${I})\(\k<q>,${I}\.encode\(\k<sg>\.subarray\(1,65\)\),\k<sg>,\`finalized\`\)\);if\(\k<g>\.every\((?<z1>${I})=>\k<z1>\.got===\`failed\`\)\)return\`no\`;if\(\k<g>\.every\((?<z2>${I})=>\k<z2>\.got===\`none\`\)\)return await (?<go>${I})\(\k<rp>,${I}\.encode\(\k<sg>\.subarray\(1,65\)\),\k<by>\.last\)\?\`no\`:\`unsure\`;if\(!\k<g>\.every\((?<z3>${I})=>\k<z3>\.got===\`ok\`\)\)throw Error\(\`[^;]*?\`\);let\[(?<a>${I}),(?<b>${I})\]=\k<g>\.map\((?<z4>${I})=>(?<la>${I})\(\k<z4>\.meta,${I}\.address,\k<m>\)\);if\(\k<a>===null\|\|\k<b>===null\|\|\k<a>!==\k<b>\)throw Error\(\`[^\`]*\`\);return\`yes\`\},${I}=async ${I}=>\{let (?<ss>${I})=new Map;for\(let (?<mm>${I}) of \k<x>\.mints\)\k<x>\.sell\?\.\[\k<mm>\.mint\]!==void 0&&\k<ss>\.set\(\k<mm>\.mint,await \k<so>\(\k<mm>\.mint\)\.catch\((?<fe>${I})=>\(\{fault:\k<fe>\}\)\)\);let ${I}=await \k<bo>\(\k<rp>,(?<q2>${I})=>${I}\(\k<q2>,\[${I}\.address,\.\.\.${I}\]\)\)`),
    (g) => [
      // never landed (review F3 of b38cd8c2): past on both, then each RPC's status of the sell's own signature over its
      // whole history, none, at a context slot at or past the finalized slot that RPC was past the blockhash at
      String.raw`async function ${esc(g.go)}\((${I}),(${I}),(${I})\)\{let (${I})=await (${I})\(\1,\3\);if\(\4===null\)return!1;try\{let (${I})=await Promise\.all\(\1\.map\(async\((${I}),(${I})\)=>\{let (${I})=await \7\(\`getSignatureStatuses\`,\[\[\2\],\{searchTransactionHistory:!0\}\]\);return ${I}\(\9\?\.context\?\.slot\)>=\4\[\8\]&&Array\.isArray\(\9\?\.value\)&&\9\.value\.length===1&&\9\.value\[0\]===null\}\)\);return \6\[0\]===!0&&\6\[1\]===!0\}catch\{return!1\}\}`,
      // that slot is each RPC's own finalized block's, read with its height: null until both are past the last height
      String.raw`async function (${I})\((${I}),(${I})\)\{try\{let (${I})=await Promise\.all\(\2\.map\(async (${I})=>\{let (${I})=await \5\(\`getEpochInfo\`,\[\{commitment:\`finalized\`\}\]\);return (${I})\(\6\?\.blockHeight\)>\3\?\7\(\6\?\.absoluteSlot\):null\}\)\);return \4\[0\]!==null&&\4\[1\]!==null\?\[\4\[0\],\4\[1\]\]:null\}catch\{return null\}\}[\s\S]{0,20000}?async function ${esc(g.go)}\(${I},${I},${I}\)\{let ${I}=await \1\(`,
      String.raw`async function ${esc(g.rb)}\((${I}),(${I}),(${I}),(${I})=\`confirmed\`\)\{let (${I})=await \1\(\`getTransaction\`,\[\2,\{encoding:\`base64\`,commitment:\4,`,
      String.raw`function ${esc(g.la)}\((${I}),(${I}),(${I})\)\{let (${I})=\1\?\.postTokenBalances;if\(!Array\.isArray\(\4\)\)return null;let (${I})=null;for\(let ${I} of \4\)\{let (${I})=${I};if\(typeof \6!=\`object\`\|\|!\6\)return null;if\(\6\.mint!==\3\|\|\6\.owner!==\2\)continue;let (${I})=\6\.uiTokenAmount\?\.amount;if\(typeof \7!=\`string\`\|\|!/\^\(0\|\[1-9\]\[0-9\]\{0,77\}\)\$/\.test\(\7\)\)return null;\5=\(\5\?\?0n\)\+BigInt\(\7\)\}return \5\}`,
      String.raw`return (${I})>0n\?\[\{ata:(${I}),mint:(${I})\.mint\}\]:\[\]\}\),(${I})=\`yes\`;for\(let (${I}) of (${I})\)\{let (${I})=${esc(g.ss)}\.get\(\5\.mint\)\?\?\`no\`;if\(typeof \7==\`object\`\)throw \7\.fault;\7===\`no\`\?\4=\`no\`:\7===\`unsure\`&&\4===\`yes\`&&\(\4=\`unsure\`\)\}if\(\4!==\`yes\`\)return\{k:\`holds\`,steady:\4===\`no\`\};let (${I})=\6\.map\((${I})=>\9\.ata\);try\{return\{k:\`plan\`,held:${I},accounts:${I},burn:\8,plan:${I}\(${I}\.address,${I},${I},\8\)\}\}`,
      String.raw`async (${I})=>\{let (${I})=\[\];for\(let (${I}) of \1\)\2\.push\(await ${esc(g.bo)}\(${esc(g.rp)},(${I})=>${I}\(\4,\3\.wire,${I}\.address,${I}\)\)\);return \2\},(${I})\.burn\);`,
    ],
  ),
  "the plan burns a named balance only on an account it would close but for it: not native, no claim's destination, no extension but ImmutableOwner": tied(
    re(String.raw`let (?<x>${I})=(?<ex>${I})\.find\((?<e>${I})=>\k<e>!==(?<im>${I})\),(?<s>${I})=!(?<g>${I})&&(?<m>${I})>0n&&(?<r>${I})\.includes\((?<t>${I})\)&&\k<x>===void 0&&!\[\.\.\.(?<c>${I})\.values\(\)\]\.some\((?<q>${I})=>\k<q>\.to===\k<t>\);(?<h>${I})===1\?!\k<g>&&\k<m>>0n&&!\k<s>\?(?<o>${I})\.keep\.push\(`),
    (g) => [String.raw`[,;]${esc(g.im)}=7[,;]`, String.raw`,lamports:${I}\.lamports,\.\.\.${esc(g.s)}\?\{burn:${esc(g.m)}\}:\{\}\}\)`, String.raw`[,;(]${I}=${I}\(${I},(${I})\.accounts,\1\.unclaimed,\1\.burn\)`],
  ),
  "the check passes a Burn only of exactly the plan's amount, of the account's own mint and program, the wallet signing, right before its close": re(String.raw`&&(?<b>${I})\.length===9&&\k<b>\[0\]===8&&(?<y>${I})\.length===3\)\{let (?<n>${I})=${I}\.get\(\k<y>\[0\]\?\.key\),(?<i>${I})=${I}\[${I}\+1\],(?<o>${I})=\k<i>\?\.program===(?<r>${I})\.program&&\k<i>\.data\.length===1&&\k<i>\.data\[0\]===9&&\k<i>\.accounts\[0\]\?\.key===\k<n>\?\.address;if\(!\k<n>\|\|\k<n>\.kind!==\`token\`\|\|\k<n>\.burn===void 0\|\|\k<n>\.program!==\k<r>\.program\|\|${I}\(\k<b>,1\)!==\k<n>\.burn\|\|\k<y>\[1\]\?\.key!==\k<n>\.mint\|\|\k<y>\[2\]\?\.key!==(?<t>${I})\|\|!\k<y>\[2\]\?\.signer\|\|!\k<y>\[0\]\?\.writable\|\|!\k<y>\[1\]\?\.writable\|\|!\k<o>\)\{`),
  "each planned burn exactly once before its close, and none unplanned": re(String.raw`(?<e>${I})\.kind===\`token\`&&\((?<f>${I})\.get\(\k<e>\.address\)\?\?0\)!==\(\k<e>\.burn===void 0\?0:1\)&&${I}\.push\(`),
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
