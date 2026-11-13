#!/usr/bin/env node
// Live check of card round-trip-costs-less on SIGN_HOST (https://confidential.unrealized.trade). A round trip (a pool
// buy, then a full sell of it) lost the most to what the sell left on W: its token account's and its volume account's
// rent, a teardown frame and a second deposit to carry them into the pool. The signing page (packages/signpage/src/
// pool-sell.ts) gets them back for any browser of the account, which finishes any of its Ws. What it proves, and only
// that: the served /app.js is the one index.html pins (its sha384), and its text carries the card's rules, each found by
// a mark of the bundle's shape (the minifier renames, never restructures them):
//   - the sale's price per compute unit: the higher of both RPCs' 75th percentile of recent fees on the accounts it
//     writes (getRecentPrioritizationFees), at least 1, each read the RPC's optional read (sent once, only while its
//     host is open, its throttle reported to no lane), an empty answer none; never waited for: the budget at the lower
//     of that price, if in by the first simulation, and what the priority's cap (100,000 lamports in all) buys, the cap
//     where none was read and on the sale after one that did not land;
//   - the sale's owed record keeps W's proven buy;
//   - the rent backs: every W of the account's (derived from the pool's spent notes, nothing read) found on the
//     helper's seat alone, in batches; a W with no record the helper reads empty listed empty, a W the helper reads as
//     at its last end on W's own state read on neither seat and passed not, the load's own reads only with a W to pass;
//     the Ws passed in an order drawn from the device's random source, a second and up to a second more apart; W's buy
//     proven on the public seat alone, once, against the restore's rebuilt record or its no-buy mark; an unproven W tried
//     again on each load to its third pass, then held as its own state; the positions' passes held only while a W is
//     read; the page reads the restore's no-buy mark;
//   - the sell's rule: a sale paying over 100,000 lamports of priority refused, and a sale's fee over 105,000, full or
//     partial;
//   - a leftover W's rent back spaced: a gap of 10 to 60 minutes from each rent-back send, one sending pass a load, a W
//     waiting so listed on its way (state.wallets RETURNING) at its last read.
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
  "the sale's price per compute unit is the higher of both RPCs' 75th percentile of recent fees on the accounts it writes, at least 1, each read the RPC's optional read (once, its throttle reported to no lane, never to a host not open); a read that fails, is not a list of prices or is empty: none": tied(
    re(R`async function (?<sp>${I})\((?<r>${I}),(?<a>${I}),(?<sg>${I})=new AbortController\(\)\.signal\)\{let (?<p>${I})=async (?<q>${I})=>\{let (?<o>${I})=(?<op>${I})\(\k<q>\);if\(\k<o>===void 0\)throw Error\(` + "`no optional read`" + R`\);let (?<n>${I})=await \k<o>\(` + "`getRecentPrioritizationFees`" + R`,\[\[\.\.\.\k<a>\]\],\k<sg>\);if\(!Array\.isArray\(\k<n>\)\|\|\k<n>\.length===0\)throw Error\(` + "`not a list`" + R`\);let (?<f>${I})=\k<n>\.map\((?<e>${I})=>\{let (?<t>${I})=\k<e>\?\.prioritizationFee;if\(typeof \k<t>!=` + "`number`" + R`\|\|!Number\.isSafeInteger\(\k<t>\)\|\|\k<t><0\)throw Error\(` + "`not a price`" + R`\);return BigInt\(\k<t>\)\}\);return \k<f>\.sort\(\((?<u>${I}),(?<v>${I})\)=>\k<u><\k<v>\?-1:\+\(\k<u>>\k<v>\)\),\k<f>\[Math\.ceil\(\k<f>\.length\*3/4\)-1\]\};try\{let\[(?<x>${I}),(?<y>${I})\]=await (?<bo>${I})\(\k<r>,\k<p>\),(?<hi>${I})=\k<x>>\k<y>\?\k<x>:\k<y>;return \k<hi>>(?:1n|(?<fl>${I}))\?\k<hi>:(?<fm>${I})\}catch\{return null\}\}`),
    // the floor 1, both RPCs asked; the optional read by the RPC's url, a test's provider with none asked as itself; the
    // optional read: refused unless its host is open now, counted, asked once within the page's bound, nothing reported
    (g) => [
      R`[,; ]${esc(g.fm)}=1n[,;]`,
      ...(g.fl ? [R`[,; ]${esc(g.fl)}=1n[,;]`] : []),
      R`[,; ]${esc(g.bo)}=\((${I}),(${I})\)=>Promise\.all\(\[\2\(\1\[0\]\),\2\(\1\[1\]\)\]\)[,;]`,
      R`function ${esc(g.op)}\((${I})\)\{return \1\.url===void 0\?\((${I}),(${I})\)=>\1\(\2,\3\):(${I})\.get\(\1\.url\)\}`,
      R`(${I})=\((${I}),(${I}),(${I})\)=>\{if\(\4\.aborted\|\|!(${I})\.open\((${I})\)\)return Promise\.reject\(new (${I})\(` + "`http_429`,`an optional read is sent only while its host is open`" + R`,0,\5\.host\)\);\5\.count\(\);let (${I})=(${I})\.fetch\?\?globalThis\.fetch,(${I})=\((${I}),(${I})\)=>\8\(\11,\{\.\.\.\12,signal:\12\.signal\?AbortSignal\.any\(\[\12\.signal,\4\]\):\4\}\);return (${I})\((${I}),\{\.\.\.\9\.init\?\{init:\9\.init\}:\{\},fetch:\10,retry:\{deadlineMs:(${I})\.deadlineMs,backoffMs:\15\.deadlineMs\}\}\)\(\2,\3\)\};return \6===` + "`trade`" + R`&&!(${I})\.has\((${I})\)&&\16\.set\(\17,\1\)`,
    ],
  ),
  "the sale is priced at that only if it is answered by its first simulation, never waited for: the budget at the lower of that price and what the priority's cap buys, the cap where none was read; a W whose sale did not land pays the cap next, with no read, until one lands": tied(
    re(R`(?<bu>${I})=(?<sb>${I})\(null,(?<pr>${I})\((?<rm>${I})\)\),(?<cap>${I})=\k<bu>===null\?0n:\k<pr>\(\k<rm>\),(?<ac>${I})=new AbortController,(?<pv>${I});\k<bu>!==null&&!(?<cn>${I})\.has\((?<w>${I})\.address\)&&(?<sp>${I})\(${I},(?<wr>${I})\((?<st>${I})\),\k<ac>\.signal\)\.then\(\(?(?<v>${I})\)?=>\k<pv>=\k<v>\)[,;]`),
    (g) => [
      R`[,; ](${I})=${esc(g.pv)}\?\?void 0;${esc(g.ac)}\.abort\(\);let (${I})=${esc(g.sb)}\((${I})\.every\(\(?(${I})\)?=>Number\.isSafeInteger\(\4\)\)\?Math\.max\(\.\.\.\3\):null,${esc(g.cap)},\1\)`,
      R`function ${esc(g.sb)}\((${I}),(${I})=(${I}),(${I})\)\{[^}]*?,(${I})=(${I})<1000000n\?\6:${I},(${I})=\4!==void 0&&\4<\5\?\4:\5;return \7<=0n\?null:\{limit:(${I}),price:\7,priority:\(BigInt\(\8\)\*\7\+999999n\)/1000000n\}\}`,
      R`[,; ]${esc(g.wr)}=(${I})=>\[\.\.\.new Set\(\1\.flatMap\((${I})=>\2\.accounts\.filter\((${I})=>\3\.writable&&!\3\.signer\)\.map\((${I})=>\4\.key\)\)\)\][,;]`,
      R`async function ${esc(g.sp)}\(`,
      R`[,; ]${esc(g.cn)}=new Set[,;]`,
      "`stage`" + R`in (${I})&&\1\.stage===` + "`not_landed`" + R`\?${esc(g.cn)}\.add\((${I})\.address\):` + "`stage`" + R`in \1&&\(\1\.stage===` + "`filled`" + R`\|\|\1\.stage===` + "`refused`" + R`\)&&${esc(g.cn)}\.delete\(\2\.address\)`,
    ],
  ),
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
    re(R`for\(let (?<i>${I})=(?<m>${I})\.length-1;\k<i>>0;\k<i>--\)\{let (?<k>${I})=(?<rb>${I})\(\k<i>\+1\);\[\k<m>\[\k<i>\],\k<m>\[\k<k>\]\]=\[\k<m>\[\k<k>\],\k<m>\[\k<i>\]\]\}[^]{0,800}?for\(let\[(?<n>${I}),${I}\]of \k<m>\.entries\(\)\)(?:if\(|\{)\k<n>>0&&await ${I}\((?<gap>${I})\+\k<rb>\(\k<gap>\)\)`),
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
    // a W found holding SOL with no buy recorded (card buy-spends-several-pieces) is never an unproven one
    re(R`(?<c>${I})=(?<o>${I})===void 0&&(?<s>${I})===void 0&&(?<n>${I})\.found!==!0\?\k<n>\.passes\+1>=3\?` + "`steady`:`again`" + R`:void 0`),
    (g) => [R`\|\|(${I})\.end===` + "`owed`" + R`\|\|${esc(g.c)}===` + "`again`", R`;try\{if\(!(${I})\.buy&&\1\.bare!==!0\)return (${I})\(` + "`holds`,`no buy of W's is recorded`" + R`,\1\.unproven!==` + "`again`" + R`\);`,
      // a found W's pass on the found W's rule (bare), and no `seen` of it kept: its reads name token accounts the
      // finding read does not, so every load passes it
      R`\.\.\.${esc(g.n)}\.found===!0\?\{bare:!0\}:${esc(g.c)}\?\{unproven:${esc(g.c)}\}:\{\}`,
      R`(${I})\.steady&&(${I})\.bare!==!0\?(${I}):void 0`],
  ),
  "the positions' passes held only while a W is read": tied(
    re(R`let\{store:${I},sync:${I},rent:${I}\}=${I},(?<y>${I})=${I}===null,(?<rel>${I})=(?<h>${I})\.preempt\?\.\(\);try\{for\(`),
    (g) => [R`\}finally\{${esc(g.rel)}\?\.\(\)\}return ${esc(g.y)}\}`, R`wallets:async (${I})=>\{let (${I})=\1===(${I})\?null:(${I})\.preempt\(\),`, R`preempt:\(\)=>\{let (${I})=(${I})\.preempt\(\);return\(\)=>\1\.release\(\)\}`],
  ),
  "the page reads the restore's no-buy mark": tied(
    re(R`buyNone:async (?<a>${I})=>Object\.hasOwn\(${I}\(await\(await ${I}\.store\(\)\)\.get\(` + "`meta`" + R`,(?<k>${I})\)\),\k<a>\)`),
    (g) => [R`[,; ]${esc(g.k)}=` + "`owed/buy-sol-none`" + R`[,;]`],
  ),
  "the sell's rule refuses a sale that pays more than 100,000 lamports of priority (a price with no limit at 1,400,000 units, rounded up as the runtime charges it) and a sale's fee over 105,000, full or partial": tied(
    re(R`let (?<n>${I})=(?<hd>${I})\((?<d>${I})\.ixs\);if\((?<po>${I})\(\k<d>\.ixs,\k<n>\)>100000n\)return (?<x>${I})\(` + "`priority`" + R`\);`),
    (g) => [
      R`function ${esc(g.po)}\((${I}),(${I})\)\{let (${I})=BigInt\((${I})\),(${I})=0n;for\(let (${I}) of \1\.slice\(0,\2\)\)\6\.data\[0\]===2\?\3=BigInt\(new DataView\(\6\.data\.buffer,\6\.data\.byteOffset\+1,4\)\.getUint32\(0,!0\)\):\5=${I}\(\6\.data,1\);return\(\3\*\5\+999999n\)/1000000n\}`,
      R`if\((${I})!==void 0&&\(typeof \1\.fee!=` + "`bigint`" + R`\|\|\1\.fee<0n\|\|\1\.fee>105000n\)\)return (${I})\(` + "`reserve`" + R`\);if\(\1!==void 0&&\1\.full===!0\)`,
    ],
  ),
  "a leftover W's rent back is spaced: each rent-back send from a W is stamped before it is sent with a gap drawn from 10 to 60 minutes, in the device's own database that a sign out leaves; a leftover pass sends nothing while another W's gap runs (one past now and the largest gap is none), nor after this load's one sending pass, and takes the device's slot in one readwrite transaction so no other tab sends within it, before the teardown's sends and the sweep's note; a hold is no fault, never tried again": tied(
    re(R`(?<st>${I})=async (?<v>${I})=>\{try\{if\(!(?<h>${I})\.owed\?\.space\)return;await \k<h>\.owed\.space\(\k<v>\),(?<x>${I})\.stamped\?\.\(\k<v>\.at\)\}catch\{\}\},(?<sd>${I})=async\((?<a>${I}),(?<b>${I})\)=>\{await \k<st>\(\{at:(?<c>${I})\(\),gap:(?<gd>${I})\(\)\}\),await Promise\.allSettled\(${I}\.map\((?<r>${I})=>\k<r>\(` + "`sendTransaction`" + R`,\[${I}\.encode\(\k<a>\),\{encoding:` + "`base64`" + R`,preflightCommitment:` + "`confirmed`" + R`\}\]\)\)\),(?<ms>${I})\+\+,`),
    (g) => [
      // the gap's draw: 10 minutes and up to 50 more, from the device's random source
      R`[,; ](${I})=6e5,(${I})=36e5,[^]*?[,; ]${esc(g.gd)}=\(\)=>\1\+(${I})\(\2-\1\+1\);function \3\((${I})\)\{if\(\4<=1\)return 0;`,
      // the device's database, its gap rule (own W's exempt, one ending past now + 60 minutes none), the claim in one
      // readwrite transaction over that rule, the owed store's spacing on it by default
      R`[,; ](${I})=` + "`ct-device`" + R`,(${I})=` + "`space`" + R`,(${I})=` + "`rentback-sol`" + R`,(${I})=\((${I}),(${I}),(${I})\)=>\5!==void 0&&\5\.at!==\7&&\6<\5\.at\+\5\.gap&&\5\.at\+\5\.gap<=\6\+36e5,`,
      R`claim:\((${I}),(${I})\)=>(${I})\(` + "`readwrite`" + R`,\((${I}),(${I})\)=>\{let (${I})=\4\.get\((${I})\);\6\.onsuccess=\(\)=>\{if\((${I})\((${I})\(\6\.result\),\1\.at,\2\)\)return \5\(!1\);\4\.put\(\{at:\1\.at,gap:\1\.gap\},\7\),\5\(!0\)\}\}\)`,
      R`=\((${I}),(${I})=(${I})\(\)\)=>\{let (${I})=` + "`owed/rentback-sol`" + R`;return\{`,
      R`spacing:\(\)=>(${I})\.spacing\(\),space:(${I})=>\1\.space\(\2\),claim:\((${I}),(${I})\)=>\1\.claim\(\3,\4\)\}`,
      // the load's hold per W: another W's send this load, a store not read, a gap open that is not W's own
      R`let (${I})=(${I})=>(${I})!==null&&\3!==\2\.address\|\|!(${I})\|\|(${I})\((${I}),Number\((${I})\.now\?\.\(\)\?\?BigInt\(Date\.now\(\)\)\),\2\.spaced\);`,
      R`${esc(g.ms)}>(${I})&&\((${I})=(${I})\)\}`,
      R`quiet:(${I})\((${I})\),leftover:!0,`,
      R`(${I})=async\(\)=>\{if\((${I})\.quiet===!0\)throw (${I});if\(\2\.leftover!==!0\|\|(${I})\|\|(${I})\.owed\?\.claim===void 0\)return;let (${I})=\{at:(${I})\(\),gap:${esc(g.gd)}\(\)\};if\(!await \5\.owed\.claim\(\6,\2\.own\)\.catch\(\(\)=>!1\)\)throw \3;\2\.stamped\?\.\(\6\.at\),\4=!0\}`,
      R`(${I})\.ok\.signed\.length>0&&await (${I})\(\);for\(let (${I}) of \1\.ok\.signed\)await ${esc(g.sd)}\(`,
      R`;await (${I})\(\);let (${I})=(${I})\.planned\?\?\(await (${I})\.store\.add\(`,
      R`catch\((${I})\)\{if\(\1===(${I})\|\|\1===(${I})\)throw \1;(${I})=\1,(${I})\((${I}),` + "`fault`",
      // W's own last send kept on its record (its own gap never holds it)
      R`(${I})=(${I})\.spaced\?\?(${I});await (${I})\.owed\?\.put\(`,
    ],
  ),
  "a leftover W waiting so is listed on its way: its record keeps what its pass read on W, its buy proven, at its teardown as at its sweep, and a held pass reads and signs nothing more; once its sweep is sent W stays RETURNING with that sweep's signature until the note it wrote is counted in the same notes the balance reads, never in both totals": tied(
    re(R`\[(?<la>${I}),(?<lb>${I})\]=(?<hd>${I})\.map\((?<e>${I})=>\k<e>\[0\]\?\.lamports\?\?0n\);if\((?<x>${I})\.buy&&\k<la>===\k<lb>&&\k<x>\.read\?\.\(\k<la>\),(?<pl>${I})\.close\.length===0\)return\{keep:\k<pl>\.keep,signed:\[\],last:0,unclaimed:void 0,since:${I}\};if\(\k<x>\.quiet===!0\)throw (?<held>${I});`),
    (g) => [
      R`if\((${I})\.buy&&\1\.read\?\.\((${I})\),\2===0n\)return\{end:`,
      "`W holds nothing`" + R`\};if\((${I})\.quiet===!0\)throw ${esc(g.held)};`,
      R`(${I})\.swept\?\.\((${I})\.one\.signature\),await (${I})\(\2\.one\.signed,\2\.one\.signature\)`,
      R`(${I})=(${I})\.lamports===void 0\?(${I}):\2\.lamports\.toString\(\),(${I})=(${I})===` + "`sent`" + R`\?\2\.sweep:\2\.lamports===void 0\?(${I}):void 0,`,
      R`if\(typeof (${I})\.lamports!=` + "`string`" + R`\|\|!/\^\[1-9\]\\d\{0,19\}\$/\.test\(\1\.lamports\)\)continue;if\(\1\.sweep!==void 0\)\{if\((${I})===null\)continue;let (${I})=\2\.find\((${I})=>\4\.sends\?\.some\((${I})=>\5\.signature===\1\.sweep\)\);if\(\3!==void 0&&\3\.state!==` + "`PLANNED`" + R`&&\3\.state!==` + "`INCOMING`" + R`\)continue\}let (${I})=(${I})\(BigInt\(\1\.lamports\),(${I}),(${I})\);\6!==null&&(${I})\.push\(\{chain:` + "`solana`" + R`,address:\1\.address,role:` + "`fresh`" + R`,size:\6,state:` + "`RETURNING`" + R`\}\)`,
      // the page: the same shared notes read the balance counted
      R`(${I})=null,(${I})=\(\)=>\1\?\?=(${I})\(\),(${I})=await (${I})\(await (${I})\((${I}),\2,[^]{0,1600}?(${I})=\7\.signed_in&&(${I})\?await \9\.returning\(\)\.catch\(\(\)=>\[\]\):\[\],(${I})=\8\.some\((${I})=>\11\.sweep!==void 0\)\?await \2\(\)\.catch\(\(\)=>null\):\[\];return (${I})\((${I}),(${I})\(\8,(${I})\.get\(` + "`solana`" + R`\),\10\)\)`,
    ],
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
