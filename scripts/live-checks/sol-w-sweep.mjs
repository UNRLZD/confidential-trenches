#!/usr/bin/env node
// Live check of card sol-w-sweep on SIGN_HOST (https://confidential.unrealized.trade). The signing page's pool sell
// (packages/signpage/src/pool-sell.ts, checked by rules/pool.ts) empties a fresh Solana wallet W into the user's pool
// balance, so what SIGN_HOST serves is what a device signs. What it proves, and only that: the served /app.js is the one
// index.html pins (its sha384), and its text carries the card's rules, each found by a mark of the bundle's shape (the
// minifier renames, never restructures them):
//   - a full sell deposits W's surplus with its proceeds (a reserve under 0), a partial sell leaves it on W;
//   - a full sell keeps on W only what lifts the rent back's sweep to the floor once W's token account is closed (the
//     floor, the sweep's fee, mark and a page's opening on each tree, one frame's fee, less rent(165)), and the cost of
//     each claim owed by W's volume accounts as the sell reads them, or the venue's own on a cashback coin; rent(0) only
//     when that is refused or would leave the sell's note under the floor; the reserve cap leaves out what the sweep
//     carries on;
//   - the sell's rule: a full sell priced exactly from the device's reads and the min out the sell's bytes sign, its
//     keep or rent(0) only where the device falls back (the rule's own floor), at a rent rate the cap bounds, the cap
//     SOLANA_POOL_SELL_RESERVE_MAX's own value; a reserve under 0 only on a full sell; a deposit back under the kit's
//     release floor at the rent read (card sol-sell-deposit-back-floor) refused by name, so every note is at least the
//     floor and a kept sell is the venue's steps alone;
//   - a sweep that leaves W exactly what each owed cashback claim costs later (rent(0), a frame's fee, the claim
//     account's rent), at most two, checked by the sweep's rule;
//   - the sweep goes on when every account kept is a volume account owed cashback only (the kit's plan marks them),
//     W ending "owed" (its record kept) when the rest is under the floor;
//   - an owed W's record dropped only when both RPCs read W empty (the plan closing nothing, W's lamports alike and 0),
//     every other end (a fault, a load whose reads fail, one reader's word that W holds a token) keeping it, written
//     from the record as it is then; a load that reads W as at its last end (both RPCs' alike bytes of W and its
//     accounts, the rent, the rules' version) running no pass; a plan refusal ending the pass only
//     on reads both RPCs answered alike;
//   - each owed W under its own lock, with the sell lock let go for every sleep and taken again only if free, so a
//     sell tapped meanwhile waits for one try at most (every sleep of the pass, its tries' and its read-backs', through
//     the one wrapper that lets it go); each record written going to the end of the list, so the least recently tried
//     W goes first;
//   - review 6 of 13898c19: the kit's plan reading a System account with no data at W's addresses as no account on both
//     RPCs' reads; a claim that opens W's WSOL or USDC account carrying the lamports both RPCs read there, the check's
//     gain and rent taking them; a refused end steady; a floor end steady only under the floor at the cheapest deposit
//     and only as the sweep found it; a full sell's record keeping the mints W's record names; the sweep's plan refusal
//     ending the pass refused.
// It does not prove those lines run: that is the signing page's tests at the released commit (test/pool-sell.test.ts,
// rules-pool.test.ts), and that the served files are that commit's build is signpage-release's.
// After: sign
//   node scripts/live-checks/sol-w-sweep.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sol-w-sweep";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const esc = (n) => n.replace(/\$/g, "\\$");
/** A mark whose named group `cap` must be SOLANA_POOL_SELL_RESERVE_MAX as the bundle defines it: the transaction fee's
 *  most (SOLANA_POOL_TX_FEE_MAX: 5,000 a signature and 1,400,000 compute units at 1,000,000 micro-lamports), 145 bytes'
 *  rent and two pages' 216 at SOLANA_RENT_PER_BYTE_MAX, that rate 6,960 (rules/pool.ts). */
const capOf = (re) => ({
  test(js) {
    const cap = re.exec(js)?.groups?.cap;
    const terms = cap && new RegExp(`[,;]${esc(cap)}=(${I})\\+145n\\*(${I})\\+2n\\*216n\\*\\2[,;]`).exec(js);
    if (!terms) return false;
    const fee = new RegExp(`[,;]${esc(terms[1])}=(${I})\\+BigInt\\(14e5\\)\\*(${I})/1000000n[,;]`).exec(js);
    const is = (name, v) => new RegExp(`[,; ]${esc(name)}=${v}[,;]`).test(js);
    return Boolean(fee) && is(terms[2], "6960n") && is(fee[1], "5000n") && is(fee[2], "1000000n");
  },
});
/** A mark whose named groups name other code the bundle must hold too: `more(groups)` gives each further pattern. */
const tied = (re, more) => ({
  test(js) {
    const g = re.exec(js)?.groups;
    return Boolean(g) && more(g).every((p) => new RegExp(p).test(js));
  },
});
/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "a full sell deposits W's surplus": new RegExp(`(${I})=(${I})\\.fee\\+\\2\\.made\\+\\2\\.rents\\+\\2\\.after-\\2\\.lamports,${I}=\\1>0n\\|\\|!\\2\\.keeps\\?\\1:0n`),
  "a full sell keeps what lifts the sweep to the floor, a page's opening on each tree and each owed claim's cost": new RegExp(`function ${I}\\((${I}),(${I})=0\\)\\{let (${I})=${I}\\(\\1\\)>1000000n\\?${I}\\(\\1\\):${I},(${I})=(${I})\\(\\1,88\\),${I}=\\3\\+\\((${I})\\+\\5\\(\\1,${I}\\)\\+2n\\*\\4\\)\\+\\6-\\5\\(\\1,165\\)\\+${I}\\(\\1,\\2\\)`),
  "the full sell's keep counts W's volume accounts owed a claim, on either RPC's read": new RegExp(`\\.map\\(async (${I})=>(${I})\\.cashback&&\\1===${I}\\?!0:\\(await ${I}\\(${I},${I}=>${I}\\(${I},${I}\\(${I}\\.address,\\1\\),\`confirmed\`\\)\\)\\)\\.some\\((${I})=>!\\(\`none\`in \\3\\)&&\\3\\.owner===\\1&&${I}\\(\\1,\\3\\.data\\)>0n\\)\\)\\)\\.then\\((${I})=>\\4\\.filter\\(Boolean\\)\\.length\\)\\]\\),${I}=${I}\\?${I}\\(${I},${I}\\):${I}\\(${I},${I}\\)`),
  "rent(0) only when a full sell's keep is refused or leaves its note under the floor": new RegExp(`function (${I})\\((${I})\\)\\{if\\(!\\2\\.keeps&&\\2\\.base!==void 0\\)\\{let (${I})=\\1\\(\\{\\.\\.\\.\\2,base:void 0\\}\\);return\`refused\`in \\3\\|\\|\\3\\.value<\\(\\2\\.floor\\?\\?0n\\)\\?\\1\\(\\{\\.\\.\\.\\2,after:\\2\\.base,swept:0n,base:void 0\\}\\):\\3\\}`),
  "the sell prices a full sell with that fallback, at the sweep's floor": new RegExp(`(?<f>${I})=(?<he>${I})\\((?<rent>${I})\\)>1000000n\\?\\k<he>\\(\\k<rent>\\):${I},[\\s\\S]{0,3000}?let (?<r0>${I})=${I}\\(\\k<rent>,0\\),${I}=${I}\\(\\{[^{}]*?\\.\\.\\.${I}\\?\\{\\}:\\{swept:${I}-\\k<r0>,base:\\k<r0>,floor:\\k<f>\\}`),
  "the reserve cap leaves out what the sweep carries on": new RegExp(`(${I})-\\((${I})\\.swept\\?\\?0n\\)>${I}\\|\\|\\1>=\\2\\.minOut`),
  "the sell's rule prices a full sell exactly from the signed min out, rent(0) only where the device falls back, every note at least the pool's least deposit, at a rent and a cap of their own constants": capOf(new RegExp(`let (?<mo>${I})=${I}\\(${I}\\.data,16\\);if\\(\\k<mo><${I}\\)return (?<x>${I})\\(\`min_out\`\\);[\\s\\S]{0,800}?if\\(typeof (?<s>${I})!=\`bigint\`\\|\\|\\k<s>>=\\k<mo>\\)return \\k<x>\\(\`reserve\`\\);let (?<y>${I})=0n,(?<b>${I})=${I};if\\(\\k<b>!==void 0&&\\k<b>\\.full===!0\\)\\{if\\([^{}]*?\\|\\|\\k<b>\\.rent\\.lamportsPerByte\\*\\k<b>\\.rent\\.factor>6960n\\|\\|[^{}]*?\\|\\|\\k<b>\\.owed>2\\)return \\k<x>\\(\`reserve\`\\);let (?<e>${I})=\\k<b>\\.fee\\+\\k<b>\\.made\\+${I}\\(\\k<b>\\.rent,${I},\\k<b>\\.held,\\k<b>\\.next\\)-\\k<b>\\.lamports,(?<t>${I})=${I}\\(\\k<b>\\.rent,\\k<b>\\.owed\\),(?<n>${I})=${I}\\(\\k<b>\\.rent,0\\),(?<r>${I})=(?<he>${I})\\(\\k<b>\\.rent\\)>1000000n\\?\\k<he>\\(\\k<b>\\.rent\\):${I},(?<i>${I})=\\k<e>\\+\\k<t>,(?<a>${I})=\\k<i>-\\(\\k<t>-\\k<n>\\)<=(?<cap>${I})&&\\k<i><\\k<mo>&&\\k<mo>-\\k<i>>=\\k<r>;if\\(\\k<s>!==\\(\\k<a>\\?\\k<i>:\\k<e>\\+\\k<n>\\)\\)return \\k<x>\\(\`reserve\`\\);\\k<a>&&\\(\\k<y>=\\k<t>-\\k<n>\\)\\}else if\\(\\k<s><0n\\)return \\k<x>\\(\`reserve\`\\);if\\(\\k<s>-\\k<y>>\\k<cap>\\)return \\k<x>\\(\`reserve\`\\);let (?<rt>${I})=\\k<b>\\?\\.rent;[\\s\\S]{0,300}?let (?<k>${I})=\\k<mo>-\\k<s><${I}\\(\\k<rt>\\),(?<l>${I})=${I}\\.at\\(-1\\);if\\(\\k<k>&&\\k<l>\\.program===${I}\\.program\\)return \\k<x>\\(\`deposit_floor\`\\);[\\s\\S]{0,1200}?let (?<d>${I})=${I}\\(\\k<l>,[^()]*\\);return \\k<d>===\\k<mo>-\\k<s>\\?`)),
  "an owed claim's cost: rent(0), a frame's fee and the claim account's rent": new RegExp(`(${I})=\\((${I}),(${I})\\)=>\\3===0\\?0n:${I}\\(\\2,0\\)\\+BigInt\\(\\3\\)\\*\\(${I}\\+${I}\\(\\2,165\\)\\)`),
  "the sweep's rule leaves exactly that, for at most two": new RegExp(`\\|\\|(${I})<0\\|\\|\\1>2\\?${I}\\(\`sweep_reads\`\\):${I}\\+5000n\\+${I}\\(${I},${I},${I}\\)\\+${I}\\(${I},\\1\\)===`),
  "the sweep goes on when only owed-cashback accounts are kept": new RegExp(`function ${I}\\((${I})\\)\\{return \\1\\.length>2\\|\\|\\1\\.some\\((${I})=>\\2\\.cashback!==!0\\)\\?null:\\1\\.length\\}`),
  "W owed, not dropped, when the rest is under the floor": new RegExp(`\\{end:(${I})>0\\?\`owed\`:\`floor\`,`),
  "a load that reads W as it read at its last end runs no pass: what W read as is both RPCs' alike bytes of W and its accounts, the rent and the rules' version": tied(new RegExp(`async function (?<hs>${I})\\((?<x>${I})\\)\\{let (?<ad>${I})=\\[\\k<x>\\.w\\.address,\\.\\.\\.${I}\\(\\k<x>\\.w\\.address,\\k<x>\\.mints\\)\\],\\[(?<a>${I}),(?<b>${I})\\]=\\(await ${I}\\(\\k<x>\\.rpcs,(?<r>${I})=>${I}\\(\\k<r>,\\k<ad>\\)\\)\\)\\.map\\((?<q>${I})=>\\k<q>\\.map\\((?<t>${I})=>\\k<t>===null\\?\`-\`:\`\\$\\{\\k<t>\\.owner\\}:\\$\\{\\k<t>\\.lamports\\}:\\$\\{${I}\\.encode\\(\\k<t>\\.data\\)\\}\`\\)\\.join\\(\`\\|\`\\)\\);if\\(\\k<a>===\\k<b>\\)return ${I}\\.encode\\(${I}\\(new TextEncoder\\(\\)\\.encode\\(\`\\$\\{\\k<a>\\}#\\$\\{\\k<x>\\.rent\\.lamportsPerByte\\}:\\$\\{\\k<x>\\.rent\\.factor\\}#[1-9]\\d*\`\\)\\)\\)\\}async function (?<xr>${I})\\((?<h>${I}),(?<gv>${I}),(?<o>${I}),(?<hd>${I})\\)\\{let (?<by>${I})=await Promise\\.resolve\\(\\k<h>\\.bought\\?\\.get\\(\\k<gv>\\.w\\.address\\)\\)\\.catch\\(\\(\\)=>void 0\\),(?<x2>${I})=\\k<by>\\?\\{\\.\\.\\.\\k<gv>,mints:${I}\\(\\k<gv>\\.mints,\\[\\k<by>\\]\\),buy:\\k<by>\\}:\\{\\.\\.\\.\\k<gv>,buy:null\\},(?<s>${I})=await \\k<hs>\\(\\k<x2>\\)\\.catch\\(\\(\\)=>void 0\\);if\\(\\k<s>!==void 0&&\\k<s>===\\k<o>\\.seen\\)return;let (?<e>${I})=await (?<rb>${I})\\(\\k<h>,\\k<x2>,\\k<hd>\\);await (?<zr>${I})\\(\\k<h>,\\k<o>,\\k<e>\\.end,\\k<e>\\.steady\\?\\k<s>:void 0\\)\\}`), (g) => [`async function ${esc(g.rb)}\\(${I},${I},${I}\\)\\{`]),
  "an owed W's record is dropped only when both RPCs read W empty, kept on every other end from the record as it is then, with what W read as only on W's own state": new RegExp(`async function (?<zr>${I})\\((?<h>${I}),(?<o>${I}),(?<e>${I}),(?<s>${I})\\)\\{try\\{if\\(\\k<e>===\`nothing\`\\)return await \\k<h>\\.owed\\?\\.drop\\(\\k<o>\\.address\\);let (?<n>${I})=\\(await \\k<h>\\.owed\\?\\.list\\(\\)\\)\\?\\.find\\((?<r>${I})=>\\k<r>\\.address===\\k<o>\\.address\\)\\?\\?\\k<o>,\\{seen:${I},\\.\\.\\.(?<rest>${I})\\}=\\k<n>;await \\k<h>\\.owed\\?\\.put\\(\\{\\.\\.\\.\\k<rest>,mints:${I}\\(\\k<n>\\.mints,\\k<o>\\.mints\\),passes:\\k<n>\\.passes\\+1,\\.\\.\\.\\k<s>!==void 0&&\\(\\k<e>===\`floor\`\\|\\|\\k<e>===\`holds\`\\|\\|\\k<e>===\`kept\`\\|\\|\\k<e>===\`refused\`\\)\\?\\{seen:\\k<s>\\}:\\{\\}\\}\\)\\}catch\\{\\}\\}`),
  "the only empty end: the plan closes nothing, both RPCs read W's lamports alike, and they are 0, owed while a claim is owed": new RegExp(`if\\((?<n>${I})\\.plan\\.close\\.length>0\\)return\\{end:\`gave_up\`,detail:\`still open after the teardown: \\$\\{\\k<n>\\.plan\\.close\\.map\\((?<c>${I})=>\\k<c>\\.address\\)\\.join\\(\`, \`\\)\\}\`\\};let\\[(?<a>${I}),(?<b>${I})\\]=\\k<n>\\.held\\.map\\((?<q>${I})=>\\k<q>\\[0\\]\\?\\.lamports\\?\\?0n\\);if\\(\\k<a>!==\\k<b>\\)throw Error\\(\`W's lamports differ on the two RPCs\`\\);let (?<l>${I})=\\k<a>;if\\(\\k<l>===0n\\)return\\{end:(?<ow>${I})>0\\?\`owed\`:\`nothing\`,`),
  "a load whose own reads fail keeps every record, each W least recently tried first, its record read again inside the locks, the list stopping where a sell holds the sell lock": new RegExp(`catch\\((?<err>${I})\\)\\{for\\(let\\{address:(?<a0>${I})\\}of (?<list>${I})\\)if\\(!await (?<wh>${I})\\((?<lk>${I}),\\k<a0>,!0,(?<w>${I}),async\\(\\)=>\\{let (?<o0>${I})=\\(await (?<h>${I})\\.owed\\.list\\(\\)\\)\\.find\\((?<q0>${I})=>\\k<q0>\\.address===\\k<a0>\\);\\k<o0>&&\\(\\k<h>\\.told\\?\\.\\(\\{address:\\k<a0>,step:\`rent_back\`,state:\`gave_up\`,detail:\`this load's reads: \\$\\{${I}\\(\\k<err>\\)\\}\`\\}\\),await (?<zr>${I})\\(\\k<h>,\\k<o0>,\`gave_up\`\\)\\)\\}\\)\\)return;return\\}let\\{store:(?<st>${I}),sync:(?<sy>${I}),rent:(?<rn>${I}),wallets:(?<ws>${I})\\}=${I};for\\(let\\{address:(?<a>${I})\\}of \\k<list>\\)if\\(!await \\k<wh>\\(\\k<lk>,\\k<a>,!0,\\k<w>,async (?<hd>${I})=>\\{let (?<o>${I})=\\(await \\k<h>\\.owed\\.list\\(\\)\\)\\.find\\((?<q>${I})=>\\k<q>\\.address===\\k<a>\\),(?<ww>${I})=\\k<o>&&\\k<ws>\\.find\\((?<p>${I})=>\\k<p>\\.chain===\`sol\`&&\\k<p>\\.address===\\k<o>\\.address&&\\k<p>\\.l\\.toString\\(\\)===\\k<o>\\.l&&\\k<p>\\.j===\\k<o>\\.j\\);\\k<o>&&\\k<ww>&&await (?<xr>${I})\\(\\k<h>,\\{rpcs:${I},program:${I},pool:${I},scope:${I},rent:\\k<rn>,store:\\k<st>,sync:\\k<sy>,w:\\k<ww>,mints:\\k<o>\\.mints,wait:\\k<w>,\\.\\.\\.\\k<o>\\.sell\\?\\{sell:\\k<o>\\.sell\\}:\\{\\}\\},\\k<o>,\\k<hd>\\)\\}\\)\\)return\\}`),
  "a rent back holds W's own lock for its pass and the sell lock only between its sleeps, each sleep letting it go and taking it again only if free": tied(new RegExp(`function (?<tk>${I})\\((?<l>${I}),(?<n>${I}),(?<f>${I})\\)\\{return new Promise\\(\\((?<r>${I}),(?<j>${I})\\)=>\\{\\k<l>\\.request\\(\\k<n>,\\k<f>\\?\\{mode:\`exclusive\`,ifAvailable:!0\\}:\\{mode:\`exclusive\`\\},(?<k>${I})=>\\k<k>\\?new Promise\\((?<d>${I})=>\\k<r>\\(\\k<d>\\)\\):void \\k<r>\\(null\\)\\)\\.catch\\(\\k<j>\\)\\}\\)\\}async function (?<wh>${I})\\((?<L>${I}),(?<A>${I}),(?<F>${I}),(?<W>${I}),(?<G>${I})\\)\\{if\\(!\\k<L>\\)return await \\k<G>\\(\\),!0;let (?<own>${I})=await \\k<tk>\\(\\k<L>,(?<bl>${I})\\(\\k<A>\\),\\k<F>\\);if\\(!\\k<own>\\)return!0;try\\{let (?<s>${I})=await \\k<tk>\\(\\k<L>,(?<sl>${I}),\\k<F>\\);if\\(!\\k<s>\\)return!1;let (?<hd>${I})=\\{release:\\(\\)=>\\{\\k<s>\\?\\.\\(\\),\\k<s>=null\\},nap:async (?<ms>${I})=>\\(\\k<hd>\\.release\\(\\),await \\k<W>\\(\\k<ms>\\),\\k<s>=await \\k<tk>\\(\\k<L>,\\k<sl>,!0\\),\\k<s>!==null\\)\\};try\\{await \\k<G>\\(\\k<hd>\\)\\}finally\\{\\k<hd>\\.release\\(\\)\\}return!0\\}finally\\{\\k<own>\\(\\)\\}\\}`), (g) => [`[,;]${esc(g.sl)}=\`ct-pool/sell\`[,;]`, `[,;]${esc(g.bl)}=(${I})=>\`ct-pool/back/\\$\\{\\1\\}\`[,;]`, `(${I})=async (${I})=>\\{if\\(!(${I})\\)return ${I}\\.wait\\(\\2\\);if\\(!await \\3\\.nap\\(\\2\\)\\)throw (${I})\\}`]),
  "a plan refusal ends the pass only on reads both RPCs answered alike": tied(new RegExp(`\\{k:\`plan\`,held:(?<n>${I}),accounts:${I},burn:(?<bu>${I}),plan:${I}\\(${I}\\.address,${I},${I},\\k<bu>\\)\\}\\}catch\\((?<e>${I})\\)\\{if\\(\\k<n>\\[0\\]\\.every\\(\\((?<a>${I}),(?<i>${I})\\)=>(?<same>${I})\\(\\k<a>,\\k<n>\\[1\\]\\[\\k<i>\\]\\?\\?null\\)\\)\\)return\\{k:\`refused\`,why:${I}\\(\\k<e>\\)\\};throw \\k<e>\\}`), (g) => [`function ${esc(g.same)}\\((${I}),(${I})\\)\\{return \\1===null\\|\\|\\2===null\\?\\1===\\2:\\1\\.owner===\\2\\.owner&&\\1\\.lamports===\\2\\.lamports&&\\1\\.data\\.length===\\2\\.data\\.length&&\\1\\.data\\.every\\(\\((${I}),(${I})\\)=>\\3===\\2\\.data\\[\\4\\]\\)\\}`]),
  "a record written goes to the end of the list, so a load tries the least recently tried W first": new RegExp(`\`owed/rentback-sol\`;return\\{list:async\\(\\)=>Object\\.values\\(await\\(await (?<s>${I})\\(\\)\\)\\.get\\(\`meta\`,(?<k>${I})\\)\\?\\?\\{\\}\\),put:async (?<r>${I})=>void await\\(await \\k<s>\\(\\)\\)\\.update\\(\`meta\`,\\k<k>,(?<v>${I})=>\\{let (?<a>${I})=\\{\\.\\.\\.\\k<v>\\?\\?\\{\\}\\};return delete \\k<a>\\[\\k<r>\\.address\\],\\k<a>\\[\\k<r>\\.address\\]=\\k<r>,\\k<a>\\}\\)`),
  "the plan marks a volume account owed only cashback": new RegExp(`\\.\\.\\.(${I})\\.other\\.length===0&&\\1\\.amount>0n\\?\\{cashback:!0\\}:\\{\\}`),
  "the kit's plan reads a System account with no data at one of W's addresses as no account, on both RPCs' reads": new RegExp(`let (?<r>${I})=(?<e>${I})=>\\k<e>!==null&&\\k<e>\\.owner===\`11111111111111111111111111111111\`&&\\k<e>\\.data\\.length===0\\?null:\\k<e>,${I}=Object\\.fromEntries\\(Object\\.entries\\(${I}\\)\\.map\\(\\(\\[(?<k>${I}),\\[(?<a>${I}),(?<b>${I})\\]\\]\\)=>\\[\\k<k>,\\[\\k<r>\\(\\k<a>\\),\\k<r>\\(\\k<b>\\)\\]\\]\\)\\)`),
  "a claim that opens W's account carries the lamports both RPCs read there, and the check's gain and rent take them": tied(new RegExp(`let\\[(?<a>${I}),(?<b>${I})\\]=${I}\\[(?<c>${I})\\.to\\]\\.map\\((?<e>${I})=>\\k<e>\\?\\.lamports\\?\\?0n\\);if\\(\\k<a>!==\\k<b>\\)throw Error\\(\`the providers disagree on \\$\\{\\k<c>\\.to\\}: \\$\\{\\k<a>\\}/\\$\\{\\k<b>\\} lamports\`\\);(?<p>${I})=\\k<a>\\}${I}\\.claim\\.push\\(\\{[^{}]*,open:(?<d>${I})===null,[^{}]*,prefund:\\k<p>\\}\\)`), () => [
    `\\.claims\\.reduce\\(\\((${I}),(${I})\\)=>\\1\\+\\(\\2\\.unwrap\\?\\2\\.amount\\+\\2\\.prefund:0n\\),0n\\)`,
    `(${I})\\.open&&\\(typeof (${I})!=\`bigint\`\\|\\|\\2<\\1\\.prefund\\|\\|\\2-\\1\\.prefund>${I}\\?[^;]*?:(${I})\\+=\\2-\\1\\.prefund\\)`,
  ]),
  "a pass's refused end is steady, as its holds and kept ends are": new RegExp(`(${I})=\\((${I}),(${I}),(${I})=\\2===\`holds\`\\|\\|\\2===\`kept\`\\|\\|\\2===\`refused\`\\)=>\\((${I})\\(\`rent_back\`,\\2,\\3\\),\\{end:\\2,steady:\\4\\}\\)`),
  "a floor end is steady only under the floor at the cheapest deposit, and only as the sweep found it": tied(new RegExp(`(?<T>${I})=(?<p>${I})-(?<my>${I})-(?<ue>${I})\\((?<l>${I}),(?<h>${I}),(?<w>${I})\\)-(?<we>${I})\\(\\k<l>,(?<a>${I})\\),(?<E>${I})=\\k<p>-\\k<my>-\\k<ue>\\(\\k<l>,\\k<h>,\\{\\.\\.\\.\\k<w>,state:\\[(?<z>${I}),\\k<z>\\],label:\\[\\k<z>,\\k<z>\\]\\}\\)-\\k<we>\\(\\k<l>,\\k<a>\\);if\\(\\k<T><(?<b>${I})\\)return\\{end:\\k<a>>0\\?\`owed\`:\`floor\`,steady:\\k<E><\\k<b>,`), () => [
    `if\\((${I})\\.end!==\`sent\`\\)return\`steady\`in \\1(?:&&\\1\\.steady!==void 0)?\\?(${I})\\(\\1\\.end,\\1\\.detail,(?:\\1\\.end===\`floor\`|\\(\\1\\.end===\`floor\`\\|\\|\\1\\.end===\`kept\`\\))&&\\1\\.steady\\):\\2\\(\\1\\.end,\\1\\.detail\\)`,
  ]),
  "a full sell's record keeps the mints W's record already names": new RegExp(`(?:(${I})\\|\\|\\((${I})\\.mints=(${I})\\(\\(await Promise\\.resolve\\((${I})\\.owed\\?\\.list\\(\\)\\)\\.then\\((${I})=>\\5\\?\\.find\\(\\5=>\\5\\.address===(${I})\\.address\\),\\(\\)=>void 0\\)\\)\\?\\.mints,\\2\\.mints\\),await \\4\\.owed\\?\\.put\\(\\2\\)|if\\(!${I}\\)\\{let (${I})=await Promise\\.resolve\\((${I})\\.owed\\?\\.list\\(\\)\\)\\.then\\((${I})=>\\9\\?\\.find\\(\\9=>\\9\\.address===${I}\\.address\\),\\(\\)=>void 0\\);(${I})\\.mints=${I}\\(\\7\\?\\.mints,\\10\\.mints\\),\\10\\.sell=\\{\\.\\.\\.\\7\\?\\.sell,[^;]*?await \\8\\.owed\\?\\.put\\(\\10\\))`),
  "the sweep's plan refusal ends the pass refused, not given up": new RegExp(`if\\((${I})\\.k===\`refused\`\\)return\\{end:\`refused\`,detail:\\1\\.why\\};let (${I})=(${I})\\(\\1\\.plan\\.keep\\)`),
  "every sleep of the pass, its tries' and its read-backs', lets the sell lock go": tied(new RegExp(`(?<u>${I})=async (?<e>${I})=>\\{if\\(!(?<n>${I})\\)return (?<t>${I})\\.wait\\(\\k<e>\\);if\\(!await \\k<n>\\.nap\\(\\k<e>\\)\\)throw ${I}\\}`), (g) => [
    `for\\(let (${I})=0;\\1<30&&\\(\\1===0\\|\\|${I}\\(\\)<${I}\\);\\1\\+\\+\\)\\{\\1>0&&await ${esc(g.u)}\\(${I}\\);try\\{return\\{ok:await`,
    `\\+\\+\\)\\{(${I})>0&&await ${esc(g.u)}\\(${I}\\);for\\(let (${I}) of\\[\\.\\.\\.(${I})\\]\\)\\{let (${I})=await ${I}\\(${I},(${I})=>${I}\\(\\5,\\2\\.signature,\\2\\.wire\\)\\)`,
  ]),
  "W's own coin holds the pass: the buy writes its mint before its send, the rent back reads it into the mints it holds on, and with no buy record it holds; the page's buy and sell hosts write and read that record in its store": tied(new RegExp(`;try\\{if\\(!(?<x>${I})\\.buy\\)return (?<g>${I})\\(\`holds\`,\`no buy of W's is recorded\`\\);`), () => [
    `return await (${I})\\.bought\\?\\.put\\((${I})\\.address,\\{mint:(${I})\\.mint,program:\\3\\.tokenProgram\\}\\),await ${I}\\(\\1,`,
    `(?<bm>${I})=(?<s>${I})=>\\{let (?<k>${I})=\`owed/buy-sol\`;return\\{get:async (?<a>${I})=>\\{let (?<v>${I})=await\\(await \\k<s>\\(\\)\\)\\.get\\(\`meta\`,\\k<k>\\)\\?\\?\\{\\};return Object\\.hasOwn\\(\\k<v>,\\k<a>\\)\\?\\k<v>\\[\\k<a>\\]:void 0\\},put:async\\((?<pa>${I}),(?<pm>${I})\\)=>void await\\(await \\k<s>\\(\\)\\)\\.update\\(\`meta\`,\\k<k>,(?<u>${I})=>\\(\\{\\.\\.\\.\\k<u>\\?\\?\\{\\},\\[\\k<pa>\\]:\\{mint:\\k<pm>\\.mint,program:\\k<pm>\\.program\\}\\}\\)\\)\\}\\}[^]*?seed64:${I}\\.seed64,bought:\\k<bm>\\(${I}\\.store\\),send:[^]*?owed:${I}\\(${I}\\.store\\),bought:\\k<bm>\\(${I}\\.store\\),told:`,
  ]),
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
