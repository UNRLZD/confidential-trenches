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
//     read; the page reads the restore's no-buy mark;
//   - the sell's rule: a sale paying over 100,000 lamports of priority refused, and a sale's fee over 105,000, full or
//     partial;
//   - a leftover W's rent back spaced: a gap of 10 to 60 minutes from each send from a W into the pool (a sale's stamp
//     started before its send and never awaited there, in before the trade lock goes; W's record keeping the time as its
//     own), every leftover pass claiming the device's slot and a sale's own rent back none, the device's store bounded
//     and its stamps newer-only, one sending pass a load, none while a pool buy or sell holds the trade lock (a lock read
//     past the bound holds it), a load's first pass at a start drawn from 15 to 60 s, a W waiting so listed on its way
//     (state.wallets RETURNING) at its last read;
//   - a W read empty listed empty only once no note of its is RESERVED.
// It does not prove those lines run: that is the signing page's tests at the released commit (test/pool-sell.test.ts,
// test/pool-testnet.test.ts, test/rules-pool.test.ts), and that the served files are that commit's build is
// signpage-release's. The money it saves is the card's run record (round-trip-costs-less.md), written with the real run.
// After: sign
// Bundle: read sign
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
    re(R`let (?<rd>${I})=await (?<fo>${I})\((?<rp>${I})\[1\],(?<ls>${I})\)\.catch\(\(\)=>null\),(?<ns>${I}),(?<sp>${I})=async (?<x>${I})=>\(\k<ns>===void 0&&\(\k<ns>=await ${I}\.notes\(\)\.then\(async (?<s1>${I})=>new Set\(\(await \k<s1>\.list\(\)\)\.filter\((?<s2>${I})=>\k<s2>\.state===` + "`RESERVED`" + R`\)\.map\((?<s3>${I})=>${I}\(\k<s3>\.ref\)\)\)\)\.catch\(\(\)=>null\)\),\k<ns>!==null&&\(${I}\?\?\[\]\)\.every\((?<s4>${I})=>\k<s4>\.address!==\k<x>\|\|!\k<ns>\.has\(\k<s4>\.note\)\)\),(?<td>${I})=\[\];for\(let\{address:(?<a>${I})\}of \k<ls>\)\{let (?<o>${I})=${I}\.find\((?<q>${I})=>\k<q>\.address===\k<a>\),(?<r>${I})=\k<rd>\?\.get\(\k<a>\);(?:if\(\k<o>\)\{let (?<fl>${I})=${I}\.ride===!0&&\k<o>\.floor===!0;\(\k<r>===void 0\?\k<o>\.seen===void 0:\k<o>\.seen!==\k<r>\.seen\|\|\k<fl>\)&&\k<td>\.push\(\k<a>\)\}else |\k<o>\?\(${I}\.ride===!0&&\k<o>\.floor===!0\|\|\(\k<r>===void 0\?\k<o>\.seen===void 0:\k<o>\.seen!==\k<r>\.seen\)\)&&\k<td>\.push\(\k<a>\):)\k<r>!==void 0&&\(\k<r>\.any\?\k<td>\.push\(\k<a>\):await \k<sp>\(\k<a>\)&&await Promise\.resolve\(${I}\.owed\.markEmpty\?\.\(\k<a>\)\)\.catch\(\(\)=>\{\}\)\)\}if\(\k<td>\.length===0\)return ${I}!==null\|\|\k<rd>===null;`),
    (g) => [
      // the finding read: W and its accounts for every W, the Rent sysvar first, at most 100 addresses a request
      R`[,; ](${I})=100,(?:${I}=[^,;{}]+[,;])*?async function ${esc(g.fo)}\((${I}),(${I})\)\{let (${I})=\3\.map\([^]{0,200}?,(${I})=\[(${I}),\.\.\.\4\.flat\(\)\],(${I})=\[\];for\(let (${I})=0;\8<\5\.length;\8\+=\1\)\7\.push\(\.\.\.await ${I}\(\2,\5\.slice\(\8,\8\+\1\)\)\)`,
      // the account's Ws, derived with nothing read
      R`(${I})=await (${I})\.wallets\((${I})\)\}catch\((${I})\)\{(${I})=\4\}`,
    ],
  ),
  "the Ws passed in an order drawn from the device's random source, a second and up to a second more apart": tied(
    // the list's own order drawn, then each W after the first a gap and a draw of up to as much again apart
    re(R`for\(let (?<i>${I})=(?<m>${I})\.length-1;\k<i>>0;\k<i>--\)\{let (?<k>${I})=(?<rb>${I})\(\k<i>\+1\);\[\k<m>\[\k<i>\],\k<m>\[\k<k>\]\]=\[\k<m>\[\k<k>\],\k<m>\[\k<i>\]\]\}[^]{0,2400}?if\((?<n>${I})\+\+>0&&await ${I}\((?<gap>${I})\+\k<rb>\(\k<gap>\)\)`),
    (g) => [
      R`function ${esc(g.rb)}\((${I})\)\{if\(\1<=1\)return 0;let (${I})=Math\.floor\(4294967296/\1\)\*\1,(${I})=new Uint32Array\(1\);for\(;;\)if\(globalThis\.crypto\.getRandomValues\(\3\),\3\[0\]<\2\)return \3\[0\]%\1\}`,
      R`[,; ]${esc(g.gap)}=1e3[,;]`,
    ],
  ),
  "W's buy proven on the public seat alone, once, against the restore's rebuilt record or its no-buy mark": tied(
    // card every-lamport-can-move, review P1: a fault or a read that cannot tell is no answer (undefined) and counts
    // nothing; only a read that plainly disagrees ("differs") counts toward the unproven passes
    re(R`async function (?<pb>${I})\((?<rp>${I}),(?<pr>${I}),(?<ad>${I}),(?<cl>${I})\)\{let (?<a>${I});try\{\k<a>=await ${I}\(\k<rp>,\k<pr>\)\.read\(\k<ad>\)\}catch\{return\}if\(\k<a>!==null\)return \k<cl>===null\?\k<a>===` + "`none`" + R`\?null:` + "`differs`" + R`:\k<a>!==` + "`none`" + R`&&\k<a>\.mint===\k<cl>\.mint&&\k<a>\.program===\k<cl>\.program\?\{mint:\k<a>\.mint,program:\k<a>\.program\}:` + "`differs`" + R`\}`),
    (g) => [R`(${I})=(${I})\.buy,(${I})=\2\.differs\?\?0;if\((${I})===void 0&&\1===void 0&&\((${I})\.rec!==void 0\|\|\5\.none\)\)\{let (${I})=await ${esc(g.pb)}\((${I})\.rpcs\[0\],[^;]{0,200}?\);\6===` + "`differs`" + R`\?\3\+\+:\1=\6\}`],
  ),
  "an unproven W tried again on each load to its third pass, then held as its own state": tied(
    // a W found holding SOL with no buy recorded (card buy-spends-several-pieces) is never an unproven one
    // card every-lamport-can-move, review P1: with buy evidence, only reads that plainly disagree count (differs)
    re(R`(?<c>${I})=(?<o>${I})===void 0&&(?<s>${I})===void 0&&(?<n>${I})\.found!==!0\?\((?<ev>${I})\.rec===void 0&&!\k<ev>\.none\?\k<n>\.passes\+1:(?<df>${I})\)>=3\?` + "`steady`:`again`" + R`:void 0`),
    (g) => [R`\|\|(${I})\.end===` + "`owed`" + R`\|\|${esc(g.c)}===` + "`again`", R`;try\{if\(!(${I})\.buy&&\1\.bare!==!0\)return (${I})\(` + "`holds`,`no buy of W's is recorded`" + R`,\1\.unproven!==` + "`again`" + R`\);`,
      // a found W's pass on the found W's rule (bare), and no `seen` of it kept: its reads name token accounts the
      // finding read does not, so every load passes it
      R`\.\.\.${esc(g.n)}\.found===!0\?\{bare:!0\}:${esc(g.c)}\?\{unproven:${esc(g.c)}\}:\{\}`,
      R`(${I})\.steady&&(${I})\.bare!==!0\?(${I}):void 0`],
  ),
  "the positions' passes held only while a W is read": tied(
    re(R`let\{store:${I},sync:${I},rent:${I}\}=${I},(?<y>${I})=${I}===null,(?<rel>${I})=(?<h>${I})\.preempt\?\.\(\);try\{let ${I}=0;for\(`),
    (g) => [R`\}finally\{${esc(g.rel)}\?\.\(\)\}return ${esc(g.y)}\}`, R`wallets:async (${I})=>\{let (${I})=\1===(${I})\?null:(${I})\.preempt\(\),`, R`preempt:\(\)=>\{let (${I})=(${I})\.preempt\(\);return\(\)=>\1\.release\(\)\}`],
  ),
  "the page reads the restore's no-buy mark": tied(
    // since card closed-positions-show-every-trade only the current read's mark (2) holds W as no buy; the old read's
    // `true` (it stopped at a buy's first piece) is read again
    re(R`buyNone:async (?<a>${I})=>(?<m>${I})\(await\(await ${I}\.store\(\)\)\.get\(` + "`meta`" + R`,(?<k>${I})\),\k<a>\)`),
    (g) => [R`[,; ]${esc(g.k)}=` + "`owed/buy-sol-none`" + R`[,;]`, R`[,; ]${esc(g.m)}=\((${I}),(${I})\)=>${I}\(\1\)\[\2\]===2[,;]`],
  ),
  "the sell's rule refuses a sale that pays more than 100,000 lamports of priority (a price with no limit at 1,400,000 units, rounded up as the runtime charges it) and a sale's fee over 105,000, full or partial": tied(
    re(R`let (?<n>${I})=(?<hd>${I})\((?<d>${I})\.ixs\);if\((?<po>${I})\(\k<d>\.ixs,\k<n>\)>100000n\)return (?<x>${I})\(` + "`priority`" + R`\);`),
    (g) => [
      R`function ${esc(g.po)}\((${I}),(${I})\)\{let (${I})=BigInt\((${I})\),(${I})=0n;for\(let (${I}) of \1\.slice\(0,\2\)\)\6\.data\[0\]===2\?\3=BigInt\(new DataView\(\6\.data\.buffer,\6\.data\.byteOffset\+1,4\)\.getUint32\(0,!0\)\):\5=${I}\(\6\.data,1\);return\(\3\*\5\+999999n\)/1000000n\}`,
      // since card every-lamport-can-move the fee's bound sits in the one check of the sale's own reads, with the full
      // flag and a full sell's reserve of 0
      R`(?:if\((${I})!==void 0&&\(typeof \1\.fee!=` + "`bigint`" + R`\|\|\1\.fee<0n\|\|\1\.fee>105000n\)\)return (${I})\(` + "`reserve`" + R`\);if\(\1!==void 0&&\1\.full===!0\)|if\((${I})===void 0\|\|typeof \3\.full!=` + "`boolean`" + R`\|\|typeof \3\.fee!=` + "`bigint`" + R`\|\|\3\.fee<0n\|\|\3\.fee>105000n\|\|${I}>\(\3\.full\?0n:${I}\)\)return ${I}\(` + "`reserve`" + R`\);)`,
    ],
  ),
  "a leftover W's rent back is spaced: each rent-back send from a W is stamped before it is sent with a gap drawn from 10 to 60 minutes, in the device's own database that a sign out leaves; a leftover pass sends nothing while another W's gap runs (one past now and the largest gap is none), nor after this load's one sending pass, and takes the device's slot in one readwrite transaction so no other tab sends within it, before the teardown's sends and the sweep's note; a hold is no fault, never tried again": tied(
    re(R`(?<st>${I})=async (?<v>${I})=>\{try\{if\(!(?<h>${I})\.owed\?\.space\)return;await \k<h>\.owed\.space\(\k<v>\),(?<x>${I})\.stamped\?\.\(\k<v>\.at\)\}catch\{\}\},(?<sd>${I})=async\((?<a>${I}),(?<b>${I})\)=>\{await \k<st>\(\{at:(?<c>${I})\(\),gap:(?<gd>${I})\(\)\}\),await Promise\.allSettled\(${I}\.map\((?<r>${I})=>\k<r>\(` + "`sendTransaction`" + R`,\[${I}\.encode\(\k<a>\),\{encoding:` + "`base64`" + R`,preflightCommitment:` + "`confirmed`" + R`\}\]\)\)\),(?<ms>${I})\+\+,`),
    (g) => [
      // the gap's draw: 10 minutes and up to 50 more, from the device's random source
      R`[,; ](${I})=6e5,(${I})=36e5,[^]*?[,; ]${esc(g.gd)}=\(\)=>\1\+(${I})\(\2-\1\+1\)(?:,${I}=${esc(g.gd)})?;function \3\((${I})\)\{if\(\4<=1\)return 0;`,
      // the device's database, its gap rule (own W's exempt; a stamp up to 60 minutes ahead of now, a clock set back,
      // holds to at + gap; one further ahead none), the claim in one readwrite transaction over that rule, a stamp
      // written only over an older or untrusted one in one readwrite transaction, each call raced against the store's
      // bound (an open that answers late closed unused), the owed store's spacing on it by default
      R`[,; ](${I})=36e5,(${I})=` + "`ct-device`" + R`,(${I})=` + "`space`" + R`,(${I})=` + "`rentback-sol`" + R`,(${I})=\((${I}),(${I})\)=>\6\.at<=\7\+\1,(${I})=\((${I}),(${I}),(${I})\)=>\9!==void 0&&\9\.at!==\11&&\5\(\9,\10\)&&\10<\9\.at\+\9\.gap,`,
      R`space:(${I})=>(${I})\(` + "`readwrite`" + R`,\((${I}),(${I})\)=>\{let (${I})=\3\.get\((${I})\);\5\.onsuccess=\(\)=>\{let (${I})=(${I})\(\5\.result\);\(\7===void 0\|\|\1\.at>\7\.at\|\|!(${I})\(\7,\1\.at\)\)&&\3\.put\(\{at:\1\.at,gap:\1\.gap\},\6\),\4\(\)\}\}\)`,
      R`\.onsuccess=\(\)=>(${I})\?(${I})\.result\.close\(\):(${I})\(\2\.result\),[^]{0,500}?\}\)\(\),(${I}),` + "`the device's spacing`" + R`\)\.catch\(`,
      R`claim:\((${I}),(${I})\)=>(${I})\(` + "`readwrite`" + R`,\((${I}),(${I})\)=>\{let (${I})=\4\.get\((${I})\);\6\.onsuccess=\(\)=>\{if\((${I})\((${I})\(\6\.result\),\1\.at,\2\)\)return \5\(!1\);\4\.put\(\{at:\1\.at,gap:\1\.gap\},\7\),\5\(!0\)\}\}\)`,
      R`=\((${I}),(${I})=(${I})\(\)\)=>\{let (${I})=` + "`owed/rentback-sol`" + R`;return\{`,
      R`spacing:\(\)=>(${I})\.spacing\(\),space:(${I})=>\1\.space\(\2\),claim:\((${I}),(${I})\)=>\1\.claim\(\3,\4\)[,}]`,
      // the load's hold per W: another W's send this load, a store not read, a gap open that is not W's own
      R`[,; ](${I})=(${I})=>(${I})!==null&&\3!==\2\.address\|\|!(${I})\|\|(${I})\((${I}),Number\((${I})\.now\?\.\(\)\?\?BigInt\(Date\.now\(\)\)\),\2\.spaced\);`,
      R`${esc(g.ms)}>(${I})&&\((${I})=(${I})\)\}`,
      // a held W: not passed, told spaced, its record kept
      R`if\((${I})&&(${I})\(\1\)\)\{if\(!await ${I}\(${I},(${I}),!0,${I},async\(\)=>\{let (${I})=await ${I}\(\);if\(!\4\)return;${I}\.told\?\.\(\{address:\3,step:` + "`rent_back`,state:`gave_up`,detail:`spaced: ",
      // every leftover pass's claim; a sale's own rent back (sale) claims none and is never held (the review of 3e288da51)
      R`(${I})=async\(\)=>\{if\((${I})\|\|(${I})\.sale===!0\|\|(${I})\.owed\?\.claim===void 0\)return;let (${I})=\{at:(${I})\(\),gap:${esc(g.gd)}\(\)\};if\(!await \4\.owed\.claim\(\5,\3\.own\)\.catch\(\(\)=>!1\)\)throw (${I});\3\.stamped\?\.\(\5\.at\),\2=!0\}`,
      R`,mints:(${I})\.mints,wait:(${I}),sale:!0,`,
      R`(${I})\.ok\.signed\.length>0&&await (${I})\(\);for\(let (${I}) of \1\.ok\.signed\)await ${esc(g.sd)}\(`,
      R`;await (${I})\(\);let (${I})=(${I})\.planned\?\?\(await (${I})\.store\.add\(`,
      R`catch\((${I})\)\{if\(\1===(${I})\|\|\1===(${I})\)throw \1;(${I})=\1,(${I})\((${I}),` + "`fault`",
      // W's own last send kept on its record (its own gap never holds it)
      R`(${I})=(${I})\.spaced\?\?(${I});await (${I})\.owed\?\.put\(`,
    ],
  ),
  "a leftover W waiting so is listed on its way: its record keeps what its pass read on W, its buy proven, at its teardown as at its sweep, and a held pass reads and signs nothing more; once its sweep is sent W stays RETURNING with that sweep's signature until the note it wrote is counted in the same notes the balance reads, never in both totals; a W whose pass ended under the floor is listed at its rest, the user's own on W (card pool-amounts-are-standard-sizes), and not at all at 0": tied(
    re(R`\[(?<la>${I}),(?<lb>${I})\]=(?<hd>${I})\.map\((?<e>${I})=>\k<e>\[0\]\?\.lamports\?\?0n\);if\(\((?<x>${I})\.buy\|\|(?<sn>${I})!==void 0\)&&\k<la>===\k<lb>&&\k<x>\.read\?\.\(\k<la>\),(?<pl>${I})\.close\.length===0\)return\{keep:\k<pl>\.keep,signed:\[\],last:0,unclaimed:void 0,since:\k<sn>\};`),
    (g) => [
      R`if\(\((${I})\.buy\|\|(${I})!==void 0\)&&\1\.read\?\.\((${I})\),\3===0n\)return\{end:`,
      // under the floor, owed or not: W is listed at its rest (restAdds, card pool-amounts-are-standard-sizes: the
      // sweep's rung, its rest kept rent-exempt on W), unlisted when that is 0, before the floor end
      R`(${I})=(${I})\(${I},${I}\(${I},${I},${I}\)\),\{value:(${I})\}=(${I})\((${I}),\1\),${I}=\4\(${I},\1\)\.value,(${I})=(${I})\(\5,(${I}),\1\);if\(\3<\8&&\6===0n&&(${I})\.unlisted\?\.\(\),\3<\8&&\6>0n&&\(\9\.buy\|\|(${I})!==void 0\)&&\9\.read\?\.\(\6\),`,
      // restAdds: the own rung (past what W must keep) at the floor or over, else the rest itself above 0, else 0
      R`function (${I})\((${I}),(${I}),(${I})=0n\)\{let (${I})=(${I})\(\2,\4\)\.value;return \5>=\3\?\5:\2>0n\?\2:0n\}`,
      // the sweep's record (signature and the note's value) written before its send
      R`await (${I})\.swept\?\.\((${I})\.one\.signature,\2\.value\),await (${I})\(\2\.one\.signed,\2\.one\.signature\)`,
      // a pass whose rest adds nothing carries no amount; a floor end only this pass's (what W adds), never the last
      R`(${I})=(${I})\.unlisted===!0\?void 0:(${I})===` + "`floor`" + R`\?\2\.lamports\?\.toString\(\):\2\.lamports===void 0\?(${I}):\2\.lamports\.toString\(\),(${I})=\3===` + "`sent`" + R`\?\2\.sweep:\2\.lamports!==void 0&&\3!==` + "`gave_up`" + R`\?void 0:(${I}),`,
      R`if\(typeof (${I})\.lamports!=` + "`string`" + R`\|\|!/\^\[1-9\]\\d\{0,19\}\$/\.test\(\1\.lamports\)\)continue;if\(\1\.sweep!==void 0\)\{if\((${I})===null\)continue;let (${I})=\2\.find\((${I})=>\4\.sends\?\.some\((${I})=>\5\.signature===\1\.sweep\)\);if\(\3!==void 0&&\3\.state!==` + "`PLANNED`" + R`&&\3\.state!==` + "`INCOMING`" + R`\)continue\}let (${I})=(${I})\(BigInt\(\1\.lamports\),(${I}),(${I})\);\6!==null&&(${I})\.push\(\{chain:` + "`solana`" + R`,address:\1\.address,role:` + "`fresh`" + R`,size:\6,state:` + "`RETURNING`" + R`\}\)`,
      // the page: the same shared notes read the balance counted
      R`(${I})=null,(${I})=\(\)=>\1\?\?=(${I})\(\),(${I})=await (${I})\(await (${I})\((${I}),\2,[^]{0,1600}?(${I})=\7\.signed_in&&(${I})\?await \9\.returning\(\)\.catch\(\(\)=>\[\]\):\[\],(${I})=\8\.some\((${I})=>\11\.sweep!==void 0\)\?await \2\(\)\.catch\(\(\)=>null\):\[\];return (${I})\((${I}),(${I})\(\8,(${I})\.get\(` + "`solana`" + R`\),\10\)\)`,
    ],
  ),
  "a sale stamps the device's spacing after its record names the signature and before it is sent, W's record keeping that time as its own last send": tied(
    re(R`(?<rc>${I})=\{address:${I}\.address,l:${I}\.l\.toString\(\),j:${I}\.j,mints:\[\{mint:${I},program:${I}\.program\}\],passes:0\},(?<at>${I})=Number\((?<h>${I})\.now\?\.\(\)\?\?BigInt\(Date\.now\(\)\)\);if\(!${I}\)\{\k<rc>\.spaced=\k<at>;`),
    (g) => [
      // the stamp's write started, not awaited, and the send at once: a spacing store that never answers holds no sale
      R`await ${esc(g.h)}\.signed\?\.\((${I})\),(${I})\.stamp=Promise\.all\(\[\2\.stamp,\(async\(\)=>${esc(g.h)}\.owed\?\.space\?\.\(\{at:${esc(g.at)},gap:(${I})\(\)\}\)\)\(\)\.catch\(\(\)=>\{\}\)\]\),(${I})=\1,await Promise\.allSettled\(${I}\.map\((${I})=>\5\(` + "`sendTransaction`",
      // each stamp awaited, bounded, before the run's rent backs and before it lets go of the trade lock
      R`(?:[,;]|var |let |const )(${I})=\((${I}),(${I})\)=>Promise\.all\(\2\.map\((${I})=>\4\.stamp&&(${I})\(\4\.stamp,\3,` + "`the device's spacing`" + R`\)\.catch\(\(\)=>\{\}\)\)\)[,;]`,
      R`\}\)\.finally\(\(\)=>(${I})\((${I}),(${I})\?\.storeMs\?\?[\w$.]+\)\);for\(let (${I}) of \2\)await \4\.back\?\.\(${I}\)\}finally\{\3\?\.end\?\.\(\)\}`,
    ],
  ),
  "no leftover W's pass starts while a pool buy or sell holds the trade lock, shared, in any tab; a lock read that throws holds it": tied(
    re(R`(?<nm>${I})=` + "`ct-pool/trade`" + R`,(?<dt>${I})=\((${I}),(${I})\)=>\3\?\3\.request\(\k<nm>,\{mode:` + "`shared`" + R`\},\4\):\4\(\),(?<tr>${I})=async\((${I}),(${I})=(${I})\)=>\{try\{let (${I})=\6\?\.query;return\(\(\9===void 0\?void 0:await (${I})\(\9\.call\(\6\),\7,` + "`the lock manager's query`" + R`\)\)\?\.held\?\?\[\]\)\.some\((${I})=>\11\.name===\k<nm>\)\}catch\{return!0\}\}`),
    (g) => [
      // read before each W's pass, after the gap between passes: the run ends with the Ws left
      R`>0&&await ${I}\(${I}\+${I}\(${I}\)\),await ${esc(g.tr)}\(${I},${I}\.storeMs\?\?[\w$.]+\)\)\{${I}=!0(?:,${I}\.held\?\.\(\))?;break\}`,
      // the Solana buy's and sell's whole runs
      R`return ${esc(g.dt)}\((${I}),\(\)=>\1\.request\(${I},\{mode:` + "`shared`" + R`\},async\(\)=>\{let ${I}=${I}=${I}\(\);try\{`,
      R`return ${esc(g.dt)}\((${I}),\(\)=>\1\.request\(${I},\{mode:` + "`shared`" + R`\},async\(\)=>\{try\{await \1\.request\(`,
    ],
  ),
  "a load's first leftover pass waits a start drawn from 15 to 60 s from the device's random source, a full sell's new record included": tied(
    re(R`(?<mn>${I})=15e3,(?<dr>${I})=\(\)=>\{let (${I})=new Uint32Array\(1\);do globalThis\.crypto\.getRandomValues\(\3\);while\(\3\[0\]>=4294940441\);return \k<mn>\+\3\[0\]%45001\};function (?<bs>${I})\((${I})=\(\)=>Date\.now\(\),(${I})=\k<dr>\(\)\)\{let (${I})=!1,(?:(?:${I}=!1|${I}),)?(${I})=\5\(\)\+\6,(${I})=\8,(${I})=${I}(?:,${I}=\(\)=>[^;{}]+)?;return\{take\(\)\{return \7\|\|\5\(\)<(?:\8\|\|\5\(\)<\9&&!${I}\(\)|\9)\?!1:\(\7=!0,!0\)\}[^]{0,120}?again\(\)\{\9=\8,`),
    (g) => [R`[,; ](${I})=${esc(g.bs)}\(\)[,;]`],
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
