#!/usr/bin/env node
// Live check of card wallet-restore-id-reader: restore answers money, used or unused for every deposit id from public
// reads on the release's two NEAR providers (packages/wallet/src/restore/id-reader.ts): storage_balance_of(U) on the
// USDC token (a never-used implicit id has no storage there, a registered one has), view_account(U) (the account
// exists or UNKNOWN_ACCOUNT), money held now and the intents.near tokens. The end state on what is deployed:
//   - SIGN_HOST's served CSP lets the page reach both providers (connect-src);
//   - / names one module script, /app.js, with its integrity, /app.js's sha384 is that integrity, and /app.js holds the
//     card's rules that the page carries (string literals and patterns that minifying keeps): the walk's reach, the
//     index a walk-end error names, which a restore reads to before its gap counts (the walk's error says "restore again
//     with reach[lane] = i"): the reach checked as an index of its lane, the floor it sets, and misses counted only past it;
//     and, since card wallet-restore-id-reader-wired (the page's restore kind, src/pool-restore.ts, runs step 5 through
//     the IdReader), the IdReader's rules: an id is a 64-hex implicit account, storage on the token is null or a
//     balance, intents.near's list is a token list, the stronger of the two providers' answers taken (money over used
//     over unused), the pass's finals meet or the restore does not start, a stale pass refused, step 5's lane stopped
//     after DEPOSIT_ID_MARGIN failed reads, and the page's own wiring: the first id unread stops every read after it, and
//     a lane unread or unfinished ends the run stalled by name; since the review of 9583f571 also: a pool scope ends
//     stalled with its U_X on the pool's chain named unread (never done, until card wallet-restore-reads-ux), a step 5
//     that throws ends stalled with its error named (the catch's own words: a catch that ends it done has none), a
//     deposit note of another scope stalls by name, and the seed is opened per use, only while still stored; since card
//     wallet-id-reader-paced: a busy provider (HTTP 429 or 5xx, its JSON -429, dRPC's code 30, no answer in time) is
//     waited out at its pace and asked again within BUSY_WAIT_MAX_MS (busy_wait), and two providers that answer
//     differently at one block stop the read and step 5, naming the stronger (pair_wrong);
//   - each provider, asked with Origin SIGN_ORIGIN as the page asks (a POST with content-type application/json, so its
//     preflight first), answers with CORS for the page's origin, and answers what the IdReader decides on:
//       a registered id (REGISTERED, a NearBlocks USDC holder read 8 Nov 2026, registered on USDC) reads registered
//       (storage_balance_of a balance, view_account an account), and a fresh implicit id, 32 random bytes made for the
//       run, reads unused (storage_balance_of null, view_account UNKNOWN_ACCOUNT); intents.near's mt_tokens_for_owner
//       answers each a token list; and the provider's final block header reads (`block`, the pass's block time), all
//       with CORS for the page's origin, as step 5 reads each.
// Until card wallet-restore-id-reader-wired the IdReader's code was not in the served bundle (at f11b13ac nothing in
// packages/signpage/src imported restore/id-reader.ts, and main 610143c2's public/app.js holds none of the id_ and ids_
// markers below); its rules joined MARK once src/pool-restore.ts imported it. What this check cannot read: whether a
// restore on SIGN_HOST reads any id today, as the mainnet build pins no pool yet (src/pool-restore.ts pagePools), so its
// step 5 runs on the first pool pinned there.
// After: sign
//   node scripts/live-checks/wallet-restore-id-reader.mjs [--url <origin>] [--record <file>]
//   node scripts/live-checks/wallet-restore-id-reader.mjs --local [--root <signpage dir>] [--record <file>]
//     --local judges this tree's committed build and _headers (--root: another packages/signpage folder, as a checkout of
//     an older commit, to record what that build fails on); the providers are read live either way.
//   PASS exit 0, FAIL exit 1, error exit 2. The record holds the CSP's connect-src, the script's path, integrity, size,
//   sha384, each marker's count and each provider's answers (keyed by its place), never the bytes.
import "../net-window.mjs";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "wallet-restore-id-reader";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
const SIGNPAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/signpage");
/** The release pair (the kit's NEAR_NETWORKS.mainnet: one FastNEAR URL and the dRPC URL), asked in this order. */
export const PAIR = Object.freeze(["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]); // near-rpc-operators: two operators (the release pair)
/** The record's key for provider i (a place, not the host: a record naming both in one object would read as a pair). */
export const PLACES = PAIR.map((_, i) => `rpc_${i}`);
/** Mainnet USDC, the vault's asset (the kit's VAULT_CONSTANTS.TOKEN). */
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** A registered id: 9c484fa5… holds USDC storage on both providers (packages/wallet/test/vectors/id-reader-mainnet.json's used_storage). */
export const REGISTERED = "9c484fa5d2d069569ba063fc555c34e621ccd88fdbb0295fc79bad232621c5c1";
const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;

// Card wallet-id-reader-paced. Each of its four markers is a function of the bundle's text: exact patterns that capture
// the names the minifier gave (a class, a function, a variable), then exact patterns that use those very names, so a
// rule held by other code than the one pattern found counts 0. No pattern has a free gap: every character between the
// bound names is the build's own, so a guard, a condition, an always-true compare or another number added anywhere in
// them counts 0. Each pattern is one run of the build's text, so a same-shaped dead copy elsewhere is not the one its
// callers call (review of 31be751d, P2-3). `§` in a pattern is one minified name.
const N = String.raw`[\w$]+`;
const esc = (x) => x.replace(/[$]/g, "\\$&");
const rx = (src) => new RegExp(src.replaceAll("§", N), "g");
const all = (text, re) => [...text.matchAll(re)];
const one = (text, src) => {
  const m = all(text, rx(src));
  return m.length === 1 ? m[0].groups : null;
};
const B = "`";
/**
 * The pace (packages/wallet/src/pace.ts) as one run of the build: PACE by value (FastNEAR 0.39 a second, burst 8;
 * dRPC 3.5 a second, burst 10), paceOf (one pace per provider URL, an unknown URL unpaced), the slot, the busy hold,
 * the slot given back, pacedFetch (each request after its URL's slot on the real clock, its caller's signal ending the
 * wait and giving the slot back, its deadline RPC_TIMEOUT_MS = 10 s from the slot on), pacedRpc, deadlineOf and
 * requestSignal (a reader on a pacedFetch leaves the deadline to it: delta review 2, P1).
 */
const paceOf = (text) => {
  const m = one(text, String.raw`(?<PACE>§)=Object\.freeze\(\{fastnear:Object\.freeze\(\{perSec:\.39,burst:8\}\),drpc:Object\.freeze\(\{perSec:3\.5,burst:10\}\)\}\),(?<PACES>§)=new Map;function (?<OF>§)\((?<u>§)\)\{let (?<p>§)=\k<PACES>\.get\(\k<u>\);if\(\k<p>===void 0\)\{let (?<net>§)=Object\.values\((?<NETS>§)\)\.find\((?<n>§)=>\k<n>\.fastnear\.includes\(\k<u>\)\|\|\k<n>\.drpc===\k<u>\),(?<pc>§)=\k<net>===void 0\?null:\k<PACE>\[\k<net>\.fastnear\.includes\(\k<u>\)\?${B}fastnear${B}:${B}drpc${B}\];\k<p>=\k<pc>===null\?\{tat:0,every:0,burst:1\}:\{tat:0,every:1e3/\k<pc>\.perSec,burst:\k<pc>\.burst\},\k<PACES>\.set\(\k<u>,\k<p>\)\}return \k<p>\}function (?<SLOT>§)\((?<s>§),(?<t>§)\)\{\k<s>\.tat=Math\.max\(\k<s>\.tat,\k<t>\);let (?<at>§)=\k<s>\.tat-\(\k<s>\.burst-1\)\*\k<s>\.every;return \k<s>\.tat\+=\k<s>\.every,Math\.max\(0,\k<at>-\k<t>\)\}function (?<GIVE>§)\((?<g>§),(?<gn>§)\)\{\k<g>\.tat=Math\.max\(\k<gn>,\k<g>\.tat-\k<g>\.every\)\}function (?<HOLD>§)\((?<h>§),(?<hn>§),(?<hm>§)\)\{\k<h>\.tat=Math\.max\(\k<h>\.tat,\k<hn>\+\k<hm>\+\(\k<h>\.burst-1\)\*\k<h>\.every\)\}var (?<PF>§)=new WeakSet,(?<ISPF>§)=(?<f>§)=>typeof \k<f>==${B}function${B}&&\k<PF>\.has\(\k<f>\);function (?<FETCH>§)\((?<fu>§),(?<ff>§)=\(\.\.\.(?<fa>§)\)=>fetch\(\.\.\.\k<fa>\),(?<fto>§)=(?<TO>§)\)\{let (?<fp>§)=\k<OF>\(\k<fu>\),(?<fr>§)=async\((?<fi>§),(?<fo>§)\)=>\{let (?<fs>§)=\k<fo>\?\.signal\?\?void 0;\k<fs>\?\.throwIfAborted\(\);let (?<fw>§)=\k<SLOT>\(\k<fp>,performance\.now\(\)\);\k<fw>>0&&await new Promise\(\((?<fy>§),(?<fx>§)\)=>\{let (?<ft>§)=setTimeout\(\(\)=>\{\k<fs>\?\.removeEventListener\(${B}abort${B},(?<fq>§)\),\k<fy>\(\)\},\k<fw>\),\k<fq>=\(\)=>\{clearTimeout\(\k<ft>\),\k<GIVE>\(\k<fp>,performance\.now\(\)\),\k<fx>\(\k<fs>\.reason\)\};\k<fs>\?\.addEventListener\(${B}abort${B},\k<fq>,\{once:!0\}\)\}\);let (?<fd>§)=AbortSignal\.timeout\(\k<fto>\);return \k<ff>\(\k<fi>,\{\.\.\.\k<fo>,signal:\k<fs>\?AbortSignal\.any\(\[\k<fs>,\k<fd>\]\):\k<fd>\}\)\};return \k<PF>\.add\(\k<fr>\),\k<fr>\}var (?<PR>§)=new WeakSet;function (?<MARKR>§)\((?<rr>§),(?<rf>§)\)\{return \k<ISPF>\(\k<rf>\)&&\k<PR>\.add\(\k<rr>\),\k<rr>\}var (?<ISPR>§)=(?<rq>§)=>\k<PR>\.has\(\k<rq>\),(?<DL>§)=\((?<da>§),(?<db>§)\)=>\k<ISPF>\(\k<da>\)\?null:\k<db>;function (?<RS>§)\((?<sa>§),(?<sb>§),(?<sc>§)\)\{let (?<sm>§)=\k<DL>\(\k<sa>,\k<sb>\);return \k<sm>===null\?\k<sc>:\k<sc>\?AbortSignal\.any\(\[\k<sc>,AbortSignal\.timeout\(\k<sm>\)\]\):AbortSignal\.timeout\(\k<sm>\)\}`);
  return m !== null && all(text, rx(String.raw`(?<![\w$.])${esc(m.TO)}=1e4[,;]`)).length === 1 ? m : null;
};
/**
 * busy_wait: the pace (paceOf above); the default sleep (sleepMs: a real setTimeout of the very ms, its signal ending
 * it) followed by ProviderBusy, busyOf (a ProviderBusy, HTTP 429 or 5xx, a TimeoutError; nothing else) and busyAnswer
 * (the JSON -429 or 429, dRPC's code 30 with "timeout"); blockHeader and the one view each throwing ProviderBusy on a
 * JSON busy answer, at their very place (exactly two such checks in the build); headerRetried, askOpts (tries 4,
 * backoff 250 ms, busyMax 60 s by default, sleepMs the default sleep) and asked as one run; asked's whole loop: the
 * pace's slot (taken here unless the rpc is paced at its transport), the request, its time counted toward the bound,
 * and a busyOf answer waited out by its Retry-After or 500 ms doubling to 8 s, never less than 500 ms or the pace's gap,
 * at most 120 busy tries and BUSY_WAIT_MAX_MS of request time and waits (past either the read fails by name), the wait
 * held on the provider's pace, and asked again; and the setup's retried, whose views go through that asked. asked is
 * called by those two and nothing else. The count is 1 when all hold, else 0.
 */
export const BUSY_WAIT = (text) => {
  const pace = paceOf(text);
  if (pace === null) return 0;
  const head = one(text, String.raw`(?<SLEEP>§)=\((?<ms>§),(?<sg>§)\)=>new Promise\(\((?<ok>§),(?<no>§)\)=>\{if\(\k<sg>\?\.aborted\)return \k<no>\(\k<sg>\.reason\);let (?<tm>§)=setTimeout\(\(\)=>\{\k<sg>\?\.removeEventListener\(${B}abort${B},(?<st>§)\),\k<ok>\(\)\},\k<ms>\),\k<st>=\(\)=>\{clearTimeout\(\k<tm>\),\k<no>\(\k<sg>\.reason\)\};\k<sg>\?\.addEventListener\(${B}abort${B},\k<st>,\{once:!0\}\)\}\),(?<Y>§)=class extends Error\{retryAfterMs;constructor\((?<m>§),(?<r>§)\)\{super\(\k<m>\),this\.name=${B}ProviderBusy${B},this\.retryAfterMs=\k<r>\}\};function (?<OF>§)\((?<e>§)\)\{if\(\k<e> instanceof \k<Y>\)return\{retryAfterMs:\k<e>\.retryAfterMs\};if\(!(?<ISO>§)\(\k<e>\)\)return null;let (?<s>§)=\k<e>\.status;return typeof \k<s>==${B}number${B}&&\(\k<s>===429\|\|\k<s>>=500&&\k<s><=599\)\?\{retryAfterMs:typeof \k<e>\.retryAfterMs==${B}number${B}\?\k<e>\.retryAfterMs:void 0\}:\k<e>\.name===${B}TimeoutError${B}\?\{retryAfterMs:void 0\}:null\}var (?<BA>§)=(?<j>§)=>\k<ISO>\(\k<j>\)&&\(\k<j>\.code===-429\|\|\k<j>\.code===429\|\|\k<j>\.code===30&&/timeout/i\.test\(String\(\k<j>\.message\)\)\),`);
  if (head === null) return 0;
  const [Y, busyOf, BA, ISO, SLEEP] = [head.Y, head.OF, head.BA, head.ISO, head.SLEEP].map(esc);
  const [OF, SLOT, HOLD, ISPR] = [pace.OF, pace.SLOT, pace.HOLD, pace.ISPR].map(esc);
  // the readers on a pacedFetch hand the kit's nearRpc deadlineOf's answer (bindRpc and relayRpc), never their own 10 s
  if (all(text, rx(String.raw`=(?<nr>§)\((?<u>§),(?<fx>§),${esc(pace.DL)}\(\k<fx>,(?<tm>§)\)\)`)).length !== 2) return 0;
  const json = (v) => String.raw`if\(${BA}\(\k<${v}>\.error\)\)throw new ${Y}\(${B}\$\{\k<rpc>\.name\}: \$\{\k<what>\}: busy${B}\);`;
  if (all(text, rx(String.raw`if\(${BA}\(§\.error\)\)throw new ${Y}\(${B}\$\{§\.name\}: \$\{§\}: busy${B}\);`)).length !== 2) return 0;
  const run = one(text, String.raw`async function (?<HR>§)\((?<he>§),(?<ht>§),(?<hw>§),(?<ho>§)=\{\},(?<hs>§)=!1\)\{return (?<ASKED>§)\(\k<he>,async (?<hg>§)=>\{let (?<ha>§)=await (?<BH>§)\(\k<he>,\k<ht>,\k<hw>,\k<hg>\);if\(\k<hs>&&\k<ha>===(?<NB>§)\)throw Error\(${B}\$\{\k<he>\.name\}: \$\{\k<hw>\} \$\{${B}block_id${B}in \k<ht>\?\k<ht>\.block_id:${B}final${B}\} is not served \(UNKNOWN_BLOCK\)${B}\);return \k<ha>\},(?<AOPT>§)\(\k<ho>\)\)\}function \k<AOPT>\((?<e>§)\)\{let (?<tr>§)=\k<e>\.tries\?\?4,(?<bk>§)=\k<e>\.backoffMs\?\?250,(?<bm>§)=\k<e>\.busyMaxMs\?\?6e4;if\(!Number\.isSafeInteger\(\k<tr>\)\|\|\k<tr><1\)throw Error\(${B}tries is a count above 0${B}\);if\(!Number\.isSafeInteger\(\k<bk>\)\|\|\k<bk><0\)throw Error\(${B}backoffMs is a time in ms${B}\);if\(!Number\.isSafeInteger\(\k<bm>\)\|\|\k<bm><0\)throw Error\(${B}busyMaxMs is a time in ms${B}\);let (?<sig>§)=\k<e>\.signal,(?<sl>§)=\k<e>\.sleep,(?<sum>§)=0;return\{tries:\k<tr>,backoff:\k<bk>,sleep:\k<sl>\?async (?<ms>§)=>\{\k<sig>\?\.throwIfAborted\(\),\k<sum>\+=\k<ms>,await \k<sl>\(\k<ms>\),\k<sig>\?\.throwIfAborted\(\)\}:${SLEEP},signal:\k<sig>,now:\k<e>\.now\?\?\(\k<sl>\?\(\)=>performance\.now\(\)\+\k<sum>:\(\)=>performance\.now\(\)\),busyMax:\k<bm>\}\}async function \k<ASKED>\((?<rpc>§),(?<once>§),(?<ao>§)\)\{let (?<pc>§)=${OF}\(\k<rpc>\.name\),(?<here>§)=!${ISPR}\(\k<rpc>\),(?<fails>§)=0,(?<busy>§)=0,(?<spent>§)=0;for\(;;\)\{\k<ao>\.signal\?\.throwIfAborted\(\);let (?<w>§)=\k<here>\?${SLOT}\(\k<pc>,\k<ao>\.now\(\)\):0;\k<w>>0&&await \k<ao>\.sleep\(\k<w>,\k<ao>\.signal\);let (?<t0>§)=\k<ao>\.now\(\);try\{return await \k<once>\(\k<ao>\.signal\)\}catch\((?<er>§)\)\{if\(\k<ao>\.signal\?\.aborted\)throw \k<ao>\.signal\.reason;\k<spent>\+=\k<ao>\.now\(\)-\k<t0>;let (?<b>§)=${busyOf}\(\k<er>\);if\(\k<b>!==null\)\{let (?<wt>§)=Math\.max\(\k<b>\.retryAfterMs\?\?Math\.min\(8e3,500\*2\*\*\k<busy>\),500,\k<pc>\.every\);if\(\+\+\k<busy>>120\|\|\k<spent>\+\k<wt>>\k<ao>\.busyMax\)throw Error\(${B}\$\{\k<rpc>\.name\}: busy past \$\{\k<ao>\.busyMax\} ms of waits \(\$\{\k<er> instanceof Error\?\k<er>\.message:${B}busy${B}\}\)${B}\.slice\(0,200\)\);\k<spent>\+=\k<wt>,${HOLD}\(\k<pc>,\k<ao>\.now\(\),\k<wt>\),await \k<ao>\.sleep\(\k<wt>,\k<ao>\.signal\);continue\}if\(\+\+\k<fails>>=\k<ao>\.tries\)throw \k<er>;await \k<ao>\.sleep\(\k<ao>\.backoff\*2\*\*\(\k<fails>-1\),\k<ao>\.signal\)\}\}\}`);
  if (run === null) return 0;
  const [ASKED, AOPT, BH] = [run.ASKED, run.AOPT, run.BH].map(esc);
  const setup = one(text, String.raw`function (?<SETUP>§)\((?<n>§),(?<rp>§),(?<o>§)\)\{if\(typeof \k<n>!=${B}string${B}\|\|!Object\.hasOwn\((?<NETS>§),\k<n>\)\)throw Error\(${B}unknown network \$\{String\(\k<n>\)\}${B}\);if\((?<PN>§)\(\k<rp>\)!==\k<n>\)throw Error\((?<PR>§)\(\k<n>\)\);let (?<tk>§)=\k<NETS>\[\k<n>\]\.usdc,(?<io>§)=${AOPT}\(\k<o>\),(?<slp>§)=(?<q>§)=>\k<io>\.sleep\(\k<q>,\k<io>\.signal\),(?<first>§)=\k<o>\.first\?\?(?<RND>§),(?<rt>§)=\((?<a>§),(?<b>§),(?<c>§),(?<d>§)\)=>${ASKED}\(\k<a>,(?<sg>§)=>(?<VIEW>§)\(\k<a>,\k<b>,\k<c>,\k<d>,\k<sg>\),\k<io>\);return\{token:\k<tk>,retried:\k<rt>,first:\k<first>,sleep:\k<slp>,blockOf:`);
  if (setup === null) return 0;
  // asked is called by headerRetried and the setup's retried, nothing else (its definition is the third)
  if (all(text, new RegExp(String.raw`(?<![\w$])${ASKED}\(`, "g")).length !== 3) return 0;
  // blockHeader's and the view's JSON busy checks, each at its very place in that function
  const bh = one(text, String.raw`async function ${BH}\((?<rpc>§),(?<p>§),(?<what>§),(?<sig>§)\)\{let (?<i>§)=await \k<rpc>\.block\(\k<p>,\k<sig>\);if\(!${ISO}\(\k<i>\)\)throw Error\(${B}\$\{\k<rpc>\.name\}: \$\{\k<what>\}: not a JSON-RPC answer${B}\);if\(\k<i>\.error!==void 0\)\{${json("i")}`);
  const view = one(text, String.raw`async function ${esc(setup.VIEW)}\((?<rpc>§),(?<p>§),(?<what>§),(?<at>§),(?<sig>§)\)\{let (?<a>§)=\k<at>===${B}final${B}\?\{\.\.\.\k<p>,finality:${B}final${B}\}:\{\.\.\.\k<p>,block_id:${B}hash${B}in \k<at>\?\k<at>\.hash:\k<at>\.height\},(?<o>§)=await\(\k<sig>\?\k<rpc>\.query\(\k<a>,\k<sig>\):\k<rpc>\.query\(\k<a>\)\);if\(!${ISO}\(\k<o>\)\)throw Error\(${B}\$\{\k<rpc>\.name\}: \$\{\k<what>\}: not a JSON-RPC answer${B}\);if\(JSON\.stringify\(\k<o>\.error\?\?\(${ISO}\(\k<o>\.result\)\?\k<o>\.result\.error:void 0\)\?\?${B}${B}\)\.includes\((?<H>§)\)\)throw Error\(${B}\$\{\k<rpc>\.name\}: \$\{\k<what>\}: the token is halted \(\$\{\k<H>\}\)${B}\);${json("o")}`);
  return bh !== null && view !== null ? 1 : 0;
};
/**
 * The IdReader (nearIdReader) whole, as one run of the build with keptIdReader after it: the setup's retried, the one
 * provider's read of an id (storage, then money, then the account), RANK {unused:0,used:1,money:2} by name, the keep (a
 * new pass keeps only the lasting answers, the ids both providers answered used; an answer kept is returned, a new one
 * kept, and marked lasting only when both providers answered used), the read closure calling readId, and readId itself:
 * both providers asked at once, two answers that differ throw PairDisagrees naming the stronger, any failed read throws,
 * and the indexer may only add used (not lasting). keptIdReader reads on the kept pass, else opens one on make()'s
 * providers, and passes the keep. Its groups name each function, or it is null.
 */
const readerOf = (text, P) =>
  one(text, String.raw`function (?<OV>§)\((?<net>§),(?<rpcs>§),(?<pass>§),(?<o>§)=\{\}\)\{let\{token:(?<tok>§),retried:(?<ret>§),first:(?<first>§),blockOf:(?<bo>§)\}=(?<SETUP>§)\(\k<net>,\k<rpcs>,\k<o>\),(?<at>§)=(?<AT>§)\(\k<pass>,\k<net>,\k<rpcs>\),(?<one>§)=async\((?<r0>§),(?<u0>§)\)=>\{let (?<sb>§)=\(await \k<ret>\(\k<r0>,(?<call>§)\(\k<tok>,${B}storage_balance_of${B},\{account_id:\k<u0>\}\),${B}storage_balance_of${B},\k<at>\)\)\.v;if\(\k<sb>!==null&&!\((?<iso>§)\(\k<sb>\)&&typeof \k<sb>\.total==${B}string${B}&&(?<dig>§)\.test\(\k<sb>\.total\)\)\)throw Error\(${B}\$\{\k<r0>\.name\}: storage_balance_of: neither null nor a balance${B}\);return \k<sb>!==null&&(?<big>§)\(\(await \k<ret>\(\k<r0>,\k<call>\(\k<tok>,${B}ft_balance_of${B},\{account_id:\k<u0>\}\),${B}ft_balance_of${B},\k<at>\)\)\.v,${B}\$\{\k<r0>\.name\}: ft_balance_of${B}\)>0n\|\|await (?<INT>§)\(\k<ret>,\k<r0>,\k<u0>,\k<at>\)>0n\?${B}money${B}:\k<sb>===null&&\(await \k<ret>\(\k<r0>,\{request_type:${B}view_account${B},account_id:\k<u0>\},${B}view_account${B},\k<at>\)\)\.v===null\?${B}unused${B}:${B}used${B}\},(?<RANK>§)=\{unused:0,used:1,money:2\},(?<k>§)=\k<o>\.keep;return (?<MEET>§)\(\k<pass>,\k<rpcs>,\k<bo>\)\.then\(\(\)=>\{if\(\k<k>!==void 0&&\k<k>\.pass!==\k<pass>\)\{for\(let (?<x>§) of\[\.\.\.\k<k>\.answers\.keys\(\)\]\)\k<k>\.lasting\.has\(\k<x>\)\|\|\k<k>\.answers\.delete\(\k<x>\);\k<k>\.pass=\k<pass>,\k<k>\.rpcs=\k<rpcs>\}return async (?<u>§)=>\{if\(typeof \k<u>!=${B}string${B}\|\|!(?<hex>§)\.test\(\k<u>\)\)throw Error\(${B}an id is a 64-hex implicit account id${B}\);let (?<had>§)=\k<k>\?\.answers\.get\(\k<u>\);if\(\k<had>!==void 0\)return \k<had>;let\[(?<sx>§),(?<both>§)\]=await (?<READ>§)\(\k<u>\);return \k<k>\?\.answers\.set\(\k<u>,\k<sx>\),\k<both>&&\k<sx>===${B}used${B}&&\k<k>\?\.lasting\.add\(\k<u>\),\k<sx>\}\}\);async function \k<READ>\((?<e>§)\)\{let (?<f0>§)=\k<first>\(\)===0\?0:1,(?<ord>§)=\[\k<f0>,1-\k<f0>\],(?<got>§)=await Promise\.allSettled\(\k<ord>\.map\((?<pi>§)=>\k<one>\(\k<rpcs>\[\k<pi>\],\k<e>\)\)\);\k<o>\.signal\?\.throwIfAborted\(\);let (?<ok>§)=\k<got>\.flatMap\(\((?<r1>§),(?<i1>§)\)=>\k<r1>\.status===${B}fulfilled${B}\?\[\{p:\k<ord>\[\k<i1>\],x:\k<r1>\.value\}\]:\[\]\);if\(\k<ok>\.length===2&&\k<ok>\[0\]\.x!==\k<ok>\[1\]\.x\)\{let\[(?<wk>§),(?<sn>§)\]=\k<RANK>\[\k<ok>\[0\]\.x\]>\k<RANK>\[\k<ok>\[1\]\.x\]\?\[\k<ok>\[1\],\k<ok>\[0\]\]:\[\k<ok>\[0\],\k<ok>\[1\]\];throw new ${P}\(\k<rpcs>\[\k<sn>\.p\]\.name,${B}\$\{\k<rpcs>\[\k<sn>\.p\]\.name\} answered \$\{\k<sn>\.x\} where \$\{\k<rpcs>\[\k<wk>\.p\]\.name\} answered \$\{\k<wk>\.x\} at block \$\{\k<at>\.h\}: one of the pair is wrong at one block, so the restore stops${B}\)\}let (?<rej>§)=\k<got>\.find\((?<r2>§)=>\k<r2>\.status===${B}rejected${B}\);if\(\k<rej>\)throw \k<rej>\.reason instanceof Error\?\k<rej>\.reason:Error\(${B}the read failed${B}\);let (?<fs>§)=\k<ok>\[0\]\.x;if\(\k<fs>===${B}unused${B}&&\k<o>\.indexer\)try\{if\(await \k<o>\.indexer\(\k<e>\)===!0\)return\[${B}used${B},!1\]\}catch\{\}return\[\k<fs>,!0\]\}\}async function (?<KR>§)\((?<kn>§),(?<mk>§),(?<kk>§),(?<ko>§)=\{\}\)\{if\(\k<kk>\.rpcs!==void 0&&\k<kk>\.pass!==void 0\)try\{return\{rpcs:\k<kk>\.rpcs,pass:\k<kk>\.pass,reader:await \k<OV>\(\k<kn>,\k<kk>\.rpcs,\k<kk>\.pass,\{\.\.\.\k<ko>,keep:\k<kk>\}\)\}\}catch\((?<ke>§)\)\{if\(!\(\k<ke> instanceof (?<STALE>§)\)\)throw \k<ke>\}let (?<kr>§)=\k<mk>\(\),(?<kp>§)=await (?<OPEN>§)\(\k<kn>,\k<kr>,\k<ko>\);return\{rpcs:\k<kr>,pass:\k<kp>,reader:await \k<OV>\(\k<kn>,\k<kr>,\k<kp>,\{\.\.\.\k<ko>,keep:\k<kk>\}\)\}\}`);
// PairDisagrees's class, exactly once: its name, or null
const pairClass = (text) => {
  const m = one(text, String.raw`(?<P>§)=class extends Error\{stronger;constructor\((?<s>§),(?<m>§)\)\{super\(\k<m>\),this\.name=${B}PairDisagrees${B},this\.stronger=\k<s>\}\}`);
  return m === null ? null : esc(m.P);
};
/**
 * pair_wrong: PairDisagrees (`P=class extends Error{stronger;constructor(e,t){super(t),this.name=`PairDisagrees`,
 * this.stronger=e}}`); the IdReader whole (readerOf: readId called by the read closure, RANK by name, both answers
 * needed); and step 5's catch, whose first statement throws P on at once, naming its lane and index, before an id is
 * counted unread. The IdReader's setup is the one busy_wait binds. The count is 1 when all hold, else 0.
 */
export const PAIR_WRONG = (text) => {
  const P = pairClass(text);
  if (P === null) return 0;
  const stop = all(text, new RegExp(String.raw`\}catch\((${N})\)\{if\(\1 instanceof ${P}\)throw new ${P}\(\1\.stronger,` + "`" + String.raw`lane \$\{(${N})\}: at index \$\{(${N})\}, \$\{\1\.message\}, to be retried` + "`" + String.raw`\);if\((${N})\.push\(\{i:\3,id:(${N}),error:(${N})\(\1\)\}\),`, "g"));
  if (stop.length < 1) return 0;
  const r = readerOf(text, P);
  return r !== null && all(text, rx(String.raw`function ${esc(r.SETUP)}\(`)).length === 1 ? 1 : 0;
};
// idReadKeep and StalePass, one run of the build: idReadKeep's name, or null
const keepOf = (text) => {
  const m = one(text, String.raw`(?<IK>§)=\(\)=>\(\{answers:new Map,lasting:new Set\}\),(?<SP>§)=class extends Error\{constructor\((?<m>§)\)\{super\(\k<m>\),this\.name=${B}StalePass${B}\}\}`);
  return m === null ? null : { IK: esc(m.IK), SP: m.SP };
};
/**
 * id_keep (review P2-2): a Retry reads on from what the restore kept, never past what can change. idReadKeep makes
 * the answers and the lasting ids; the IdReader keeps only lasting answers across a new pass and marks lasting only an
 * id both providers answered used (readerOf); keptIdReader opens a new pass only on StalePass (the very class); and the
 * page's step 5 reads through keptIdReader with the restore's keep. The count is 1 when all hold, else 0.
 */
export const ID_KEEP = (text) => {
  const P = pairClass(text);
  const k = keepOf(text);
  if (P === null || k === null) return 0;
  const r = readerOf(text, P);
  if (r === null || r.STALE !== k.SP) return 0;
  return all(text, rx(String.raw`let\{reader:(?<rd>§)\}=await ${esc(r.KR)}\((?<net>§),(?<ids>§)\.rpcs,(?<kp>§),\{\.\.\.\k<ids>\.opts,signal:(?<sig>§)\}\)`)).length === 1 ? 1 : 0;
};
/**
 * id_signout: signing out drops what the restore kept. The restore's keep starts as a new idReadKeep() beside its
 * abort (`a=null,o=uV()`), and signedOut aborts the run and makes a new one (`signedOut:()=>{a?.abort(),o=uV()}`), the
 * very two names. The count is 1 when both hold, else 0.
 */
export const ID_SIGNOUT = (text) => {
  const k = keepOf(text);
  if (k === null) return 0;
  const init = all(text, rx(String.raw`(?<a>§)=null,(?<o>§)=${k.IK}\(\),`));
  if (init.length !== 1) return 0;
  const [a, o] = [init[0].groups.a, init[0].groups.o].map(esc);
  return all(text, rx(String.raw`signedOut:\(\)=>\{${a}\?\.abort\(\),${o}=${k.IK}\(\)\}`)).length === 1 ? 1 : 0;
};
/** The card's strings in the bundle, as the minifier writes them. The four functions bind the minifier's names. */
export const MARK = Object.freeze({
  reach_error: "reach: not an index of lane",
  // the walk's floor: `let o=a??-1,` (a lane's reach, or -1 when none)
  reach_floor: /let ([\w$]+)=([\w$]+)\?\?-1,/g,
  // a miss counts only past the floor: `r(l)?(s.push(a),u=0):a>o&&u++` (the index pushed is the one compared, the counter is the one reset)
  reach_misses: /\)\?\([\w$]+\.push\(([\w$]+)\),([\w$]+)=0\):\1>[\w$]+&&\2\+\+/g,
  // the IdReader (packages/wallet/src/restore/id-reader.ts nearIdReader, openRestorePass) and step 5
  // (restore/wallets.ts restoreDepositIds), as the page's restore kind imports them
  id_hex: "an id is a 64-hex implicit account id",
  id_storage: "storage_balance_of: neither null nor a balance",
  id_intents: "mt_tokens_for_owner: not a token list",
  // the stronger answer of the two providers: `{unused:0,used:1,money:2}`
  id_rank: "{unused:0,used:1,money:2}",
  id_pass_meet: "did not meet; the restore does not start",
  id_pass_stale: "blocks past it; open a fresh pass",
  ids_margin: "id reads failed with none showing history between them",
  // the page's wiring (src/pool-restore.ts readDepositIds): the first unread id stops every read after it,
  // `if(r.throwIfAborted(),o!==void 0)throw o;try{return await a(e)}catch(e){throw o??=e,e}`
  ids_stop: /\.throwIfAborted\(\),([\w$]+)!==void 0\)throw \1;try\{return await [\w$]+\(([\w$]+)\)\}catch\(([\w$]+)\)\{throw \1\?\?=\3,\3\}/g,
  // and a lane unfinished ends the run stalled by name (src/pool-restore.ts idsUndone)
  ids_undone: "past the note walk's end: restore again from there",
  // a pool scope is never done while its U_X on the pool's chain is unread (POOL_CHAIN_UNREAD)
  ids_ux_unread: "the pool's own chain is not read for a deposit's money",
  // a step 5 that throws ends stalled, its error named: the catch's words (a catch that ends it done holds none)
  ids_catch: "step 5 did not finish: ",
  // a deposit note of another scope in a pool's walk stalls by name
  ids_drift: "; its ids are not read",
  // the seed opened per use, under the seed lock, only while still stored
  seed_per_use: "signed out during the restore",
  // review of e31892ef (P3-3): the end stage is read off the very array step 5's catch pushes to (a stage line that
  // drops some reasons, as `why.some((y)=>!y.endsWith(U_X))?"stalled":"done"`, holds none),
  // `.catch(e=>void s.push(`step 5 did not finish: ${e instanceof Error?e.message:`it threw`}`)),t.throwIfAborted(),l(s.length>0?`stalled`:`done`)`
  ids_end: /\.catch\(([\w$]+)=>void ([\w$]+)\.push\(`step 5 did not finish: \$\{\1 instanceof Error\?\1\.message:`it threw`\}`\)\),[\w$]+\.throwIfAborted\(\),[\w$]+\(\2\.length>0\?`stalled`:`done`\)/g,
  // each pool scope's step 5 pushes the very constant that holds the U_X text (POOL_CHAIN_UNREAD), which the build
  // places before readDepositIds, as the statement right after its reasons' push to the same array, with nothing between
  // (delta review 2: no condition in front of it):
  // `var hV=`the pool's own chain is not read ...`; ... for(let e of gV(a))i.push(`${r.label}: ${e}`);i.push(`${r.label}: ${hV}`)}}`
  ids_ux_push: /var ([\w$]+)=`the pool's own chain is not read for a deposit's money[^`]*`;[\s\S]*?\)([\w$]+)\.push\(`\$\{([\w$]+)\.label\}: \$\{[\w$]+\}`\);\2\.push\(`\$\{\3\.label\}: \$\{\1\}`\)\}\}/g,
  // the seed per use, bound: the seed read inside one shared seed-lock request after the signed-in check, its HMAC kept
  // as the run's mark at the first use and compared byte by byte at every use after (delta review 2: the exact shape, so
  // a compare that is always true holds none), handed to that one use and zeroed when it ends; and the run's SeedUse is
  // that request per use (a run-long lock, with the run inside one request, holds none)
  // card wallet-id-reader-paced: busy waited out (BUSY_WAIT), one of the pair is wrong at one block (PAIR_WRONG)
  busy_wait: BUSY_WAIT,
  pair_wrong: PAIR_WRONG,
  // review of 31be751d (P2-2, P2-3): what a Retry keeps, and signing out drops it (ID_KEEP, ID_SIGNOUT)
  id_keep: ID_KEEP,
  id_signout: ID_SIGNOUT,
  seed_per_use_lock: /([\w$]+)=([\w$]+)=>[\w$]+\(\)\.request\([\w$]+,\{mode:`shared`,signal:[\w$]+\},async\(\)=>\{if\([\w$]+\.throwIfAborted\(\),!await [\w$]+\.signedIn\(\)\)throw Error\(`signed out during the restore`\);let ([\w$]+)=await [\w$]+\.seed64\(\);try\{let ([\w$]+)=[\w$]+\([\w$]+,[\w$]+,\3\);if\(([\w$]+)===null\)\5=\4;else\{let ([\w$]+)=\4\.length===\5\.length&&\4\.every\(\(([\w$]+),([\w$]+)\)=>\7===\5\[\8\]\);if\(\4\.fill\(0\),!\6\)throw Error\(`other words were signed in during the restore`\)\}return await \2\(\3\)\}finally\{\3\.fill\(0\)\}\}\),([\w$]+)=([\w$]+)=>\1\(async ([\w$]+)=>\10\(\11\)\)/g,
});
/** The markers' names, as the record keys their counts. */
export const MARKERS = Object.keys(MARK);
/** How many times marker `k` (a string, a pattern, or a function of the bundle's text: BUSY_WAIT, PAIR_WRONG, ID_KEEP, ID_SIGNOUT) is in `text`. */
export const countOf = (text, k) => (typeof k === "function" ? k(text) : k instanceof RegExp ? [...text.matchAll(k)].length : text.split(k).length - 1);
const cors = (v) => v === "*" || v === SIGN_ORIGIN;

/** The bundle's lines of the verdict on a record: { pass, lines } (no network, no headers: a build alone answers them). */
export function judgeBundle(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const s = rec?.index ?? {};
  say(s.scripts === 1 && s.src === "/app.js" && s.module === true && /^sha384-[A-Za-z0-9+/]{64}$/.test(s.integrity ?? ""),
    `/ names one module script, /app.js, with its integrity (${s.scripts ?? "?"} script(s), ${s.src ?? "none"})`);
  const a = rec?.app ?? {};
  say(a.status === 200 && Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.sha384 === s.integrity,
    `/app.js is the script / names: its sha384 is the integrity (HTTP ${a.status ?? "?"}, ${a.bytes ?? "?"} bytes)`);
  const m = a.markers ?? {};
  const missing = MARKERS.filter((k) => !(Number.isSafeInteger(m[k]) && m[k] >= 1));
  say(missing.length === 0, `/app.js carries the restore walk's reach and the IdReader's rules (${missing.length ? `missing ${missing.join(", ")}` : `${MARKERS.length} marks found`})`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

// what one provider's reads must answer, as the IdReader decides on them
const WANT = Object.freeze({
  registered: { storage: "registered", account: "account", intents: "list" },
  unused: { storage: "null", account: "UNKNOWN_ACCOUNT", intents: "list" },
});
const hasWord = (list, word) => (list ?? "").split(",").map((x) => x.trim().toLowerCase()).some((x) => x === "*" || x === word);

/** The verdict on a record: { pass, lines }. */
export function judge(rec) {
  const { lines } = judgeBundle(rec);
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const connect = (rec?.connect_src ?? "").split(" ");
  const lacks = PAIR.filter((h) => !connect.includes(h));
  say(lacks.length === 0, `SIGN_HOST's connect-src reaches both providers (${lacks.length ? `lacks ${lacks.join(", ")}` : "both"})`);
  const ids = rec?.ids ?? {};
  say(ids.registered === REGISTERED && HEX64.test(ids.unused ?? "") && ids.unused !== REGISTERED, `the ids read are the registered one and a fresh one (${String(ids.registered ?? "none").slice(0, 8)}, ${String(ids.unused ?? "none").slice(0, 8)})`);
  PLACES.forEach((k, i) => {
    const p = rec?.rpc?.[k] ?? {};
    const f = p.preflight ?? {};
    say([200, 204].includes(f.http) && cors(f.acao) && hasWord(f.acam, "post") && hasWord(f.acah, "content-type"),
      `provider ${i} answers the page's preflight for its origin (POST, content-type: ${f.http ?? "?"}, CORS ${f.acao ?? "none"}, methods ${f.acam ?? "none"}, headers ${f.acah ?? "none"})`);
    const b = p.block ?? {};
    say(b.http === 200 && cors(b.acao) && b.read === "header", `provider ${i} reads its final block's header for the page's origin (${b.read ?? b.error ?? "no answer"} ${b.http ?? "?"} CORS ${b.acao ?? "none"})`);
    for (const [who, want] of Object.entries(WANT)) {
      const r = p[who] ?? {};
      const s = r.storage ?? {}, a = r.account ?? {}, t = r.intents ?? {};
      say(t.http === 200 && cors(t.acao) && t.read === want.intents, `provider ${i} reads intents.near's token list of the ${who} id for the page's origin (${t.read ?? t.error ?? "no answer"} ${t.http ?? "?"} CORS ${t.acao ?? "none"})`);
      say(s.http === 200 && cors(s.acao) && s.read === want.storage && a.http === 200 && cors(a.acao) && a.read === want.account,
        `provider ${i} reads the ${who} id ${who === "registered" ? "registered" : "unused"} for the page's origin (storage ${s.read ?? s.error ?? "no answer"} ${s.http ?? "?"} CORS ${s.acao ?? "none"}; account ${a.read ?? a.error ?? "no answer"} ${a.http ?? "?"} CORS ${a.acao ?? "none"})`);
    }
  });
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

/** Answers / and /app.js from a packages/signpage folder (this tree's), with the CSP of its _headers' /* rule, as SIGN_HOST serves them. */
export const localFetchOf = (dir) => async (url) => {
  const p = new URL(url).pathname;
  const file = p === "/" ? path.join(dir, "index.html") : p === "/app.js" ? path.join(dir, "public/app.js") : null;
  if (file === null) return new Response("", { status: 404 });
  const csp = /^\/\*\n {2}Content-Security-Policy: (.*)$/m.exec(readFileSync(path.join(dir, "public/_headers"), "utf8"))?.[1] ?? "";
  return new Response(readFileSync(file), { status: 200, headers: p === "/" ? { "content-security-policy": csp } : {} });
};
export const localFetch = localFetchOf(SIGNPAGE);

/** The page as a browser reads it from `origin`: the CSP's connect-src, the script tag and /app.js's markers (never the bytes). */
export async function readBundle(fetchFn = fetch, origin = SIGN_ORIGIN) {
  const get = (p) => fetchFn(new URL(p, origin), { redirect: "error", headers: { accept: "*/*" }, signal: AbortSignal.timeout(20_000) });
  const page = await get("/");
  const html = await page.text();
  const csp = page.headers.get("content-security-policy") ?? "";
  const connect_src = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "))?.slice("connect-src ".length) ?? "";
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((t) => t[0]);
  const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
  const tag = tags[0] ?? "";
  const index = { status: page.status, scripts: tags.length, src: attr(tag, "src"), integrity: attr(tag, "integrity"), module: attr(tag, "type") === "module" };
  if (index.src !== "/app.js") return { connect_src, index, app: {} };
  const res = await get(index.src);
  const body = Buffer.from(await res.arrayBuffer());
  const text = body.toString("utf8");
  return { connect_src, index, app: { status: res.status, bytes: body.length, sha384: `sha384-${createHash("sha384").update(body).digest("base64")}`, markers: Object.fromEntries(MARKERS.map((k) => [k, countOf(text, MARK[k])])) } };
}

/** One request to provider `url` with Origin SIGN_ORIGIN as the page sends it: its status, CORS answers and JSON body. A 429 or a
 *  408 (dRPC's free plan stops a slow view that way) is asked again after its Retry-After (10 s when it names none, 30 s at
 *  most), three times at most (four asks in all): a throttle says nothing of what the page reads. */
async function ask(fetchFn, url, init, wait) {
  const out = {};
  try {
    let res;
    for (let k = 0; ; k++) {
      res = await fetchFn(url, { ...init, headers: { ...init.headers, origin: SIGN_ORIGIN }, signal: AbortSignal.timeout(20_000) });
      if ((res.status !== 429 && res.status !== 408) || k === 3) break;
      const after = Number(res.headers.get("retry-after"));
      await wait(1000 * (Number.isFinite(after) && after > 0 ? Math.min(after, 30) : 10));
    }
    out.http = res.status;
    out.acao = res.headers.get("access-control-allow-origin") ?? undefined;
    out.acam = res.headers.get("access-control-allow-methods") ?? undefined;
    out.acah = res.headers.get("access-control-allow-headers") ?? undefined;
    const j = init.method === "POST" ? await res.json().catch(() => null) : null;
    return { out, j };
  } catch (e) {
    out.error = String(e?.name ?? e);
    return { out, j: null };
  }
}
const rpcBody = (params, method = "query") => JSON.stringify({ jsonrpc: "2.0", id: KEY, method, params });
const JSON_POST = { method: "POST", headers: { "content-type": "application/json" } };
const errorName = (j) => (j?.error ? String(j.error.cause?.name ?? j.error.name ?? "error") : undefined);
const asText = (bytes) => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)));
  } catch {
    return undefined;
  }
};

/** What one provider answers for one id: storage_balance_of on USDC (registered | null | other | an error's name) and view_account (account | UNKNOWN_ACCOUNT | other | an error's name). */
async function readId(fetchFn, url, id, wait) {
  const args = Buffer.from(JSON.stringify({ account_id: id })).toString("base64");
  const [st, ac, mt] = await Promise.all([
    ask(fetchFn, url, { ...JSON_POST, body: rpcBody({ request_type: "call_function", account_id: USDC, method_name: "storage_balance_of", args_base64: args, finality: "final" }) }, wait),
    ask(fetchFn, url, { ...JSON_POST, body: rpcBody({ request_type: "view_account", account_id: id, finality: "final" }) }, wait),
    ask(fetchFn, url, { ...JSON_POST, body: rpcBody({ request_type: "call_function", account_id: "intents.near", method_name: "mt_tokens_for_owner", args_base64: args, finality: "final" }) }, wait),
  ]);
  const storage = { http: st.out.http, acao: st.out.acao, error: st.out.error };
  if (st.j) {
    const v = Array.isArray(st.j.result?.result) ? asText(st.j.result.result) : undefined;
    storage.read = errorName(st.j) ?? (v === null ? "null" : v && typeof v === "object" && typeof v.total === "string" && DIGITS.test(v.total) ? "registered" : "other");
  }
  const account = { http: ac.out.http, acao: ac.out.acao, error: ac.out.error };
  if (ac.j) account.read = errorName(ac.j) ?? (typeof ac.j.result?.amount === "string" && DIGITS.test(ac.j.result.amount) ? "account" : "other");
  const intents = { http: mt.out.http, acao: mt.out.acao, error: mt.out.error };
  if (mt.j) {
    const v = Array.isArray(mt.j.result?.result) ? asText(mt.j.result.result) : undefined;
    intents.read = errorName(mt.j) ?? (Array.isArray(v) && v.every((t) => t && typeof t.token_id === "string") ? "list" : "other");
  }
  return { storage, account, intents };
}

/** One provider's final block header (the `block` method the pass reads its block's time with): header | other | an error's name. */
async function readBlock(fetchFn, url, wait) {
  const b = await ask(fetchFn, url, { ...JSON_POST, body: rpcBody({ finality: "final" }, "block") }, wait);
  const out = { http: b.out.http, acao: b.out.acao, error: b.out.error };
  if (b.j) out.read = errorName(b.j) ?? (Number.isSafeInteger(b.j.result?.header?.height) && typeof b.j.result?.header?.hash === "string" ? "header" : "other");
  return out;
}

/** Each provider's preflight and reads of the registered id and the fresh one, keyed by PLACES. */
async function rpcRead(fetchFn, ids, wait) {
  const one = async (url) => {
    const pre = await ask(fetchFn, url, { method: "OPTIONS", headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }, wait);
    const [registered, unused, block] = await Promise.all([readId(fetchFn, url, ids.registered, wait), readId(fetchFn, url, ids.unused, wait), readBlock(fetchFn, url, wait)]);
    return { preflight: pre.out, registered, unused, block };
  };
  return Object.fromEntries(await Promise.all(PAIR.map(async (u, i) => [PLACES[i], await one(u)])));
}

/** Reads `origin` as a browser does, and both providers, and returns the record. `unused`: the fresh id (32 random bytes unless given). */
export async function probe(origin, fetchFn = fetch, rpcFetch = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), unused = randomBytes(32).toString("hex")) {
  const ids = { registered: REGISTERED, unused };
  const page = await readBundle(fetchFn, origin);
  return { key: KEY, url: origin, at: new Date().toISOString(), ...page, ids, rpc: await rpcRead(rpcFetch, ids, wait) };
}

/** SIGN_HOST's bundle record, read with `fetchFn` (scripts/ci/bundle-checks.mjs runs readBundle and judgeBundle on a pull request's build). */
export const read = (fetchFn = fetch) => readBundle(fetchFn);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const local = args.includes("--local");
    const rec = await probe(local ? SIGN_ORIGIN : (opt("--url") ?? SIGN_ORIGIN), local ? localFetchOf(opt("--root") ? path.resolve(opt("--root")) : SIGNPAGE) : fetch);
    if (local) rec.url = opt("--root") ? `local build of ${path.basename(path.resolve(opt("--root")))}` : "local build";
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.pass ? "PASS" : "FAIL"} (${rec.url})`);
    process.exit(r.pass ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
