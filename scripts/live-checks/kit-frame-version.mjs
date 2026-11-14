#!/usr/bin/env node
// Live check of card kit-frame-version on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and its code, as minified, sends an app on an
// older kit only what that kit reads (packages/signpage/src/kit-version.ts):
//   - it reads the kit's hello ({ v: 1, type: "hello", kit }, packages/kit/src/signpage/messages.ts HelloMessage), the
//     version an app names, and reads an app that names none as kit-v1.4 (kit-v1 to kit-v1.4 are public tags): the
//     request handler sets the page's level from the hello's version (`let c=zc(i);if(c!==null)return void(r=Bc(c))`;
//     since kit 1.13 with the closed notice's hello flag set beside it, `void(r=Bc(c),i=!0)`), the one shaper reads
//     that level for every answer's result and every state event, and the one post sends what the shaper returns
//     (`a=(t,n)=>{let r=i(t,n);r!==null&&e.parent.postMessage(r,...)`);
//   - that post is the bundle's only `parent.postMessage(`, so nothing reaches the app past the shaper, and the shaper
//     sends a progress event through the stage map at that level (stageFor: kit-v1.4 is sent a later stage as MAP has it,
//     a stage it has no reading for and a route event not at all, `if(e.type!==`progress`)return e;...`), its stage
//     function reading the same map as MAP;
//   - its deposit stage map for kit-v1.4 is exactly MAP: the eight stages kit-v1.4 has as they are, failed and short as
//     in_transit (1Click is still on them; halted would be the held screen), expired as quote_checked, refund_move as
//     refunded (never done: a refund still moving is not in the vault), every value one of kit-v1.4's eight;
//   - its kit-v1.4 state fields are exactly kit-v1.4's twelve (no pools, no deposit_wallets);
//   - (card pool-deposit-stages) it reads every kit at KIT and above in full (the version minified into its level
//     function), with kit-v1.6 and kit-v1.5 as their own levels below it (`?\`current\`:i(1,6)?\`1.6\`:i(1,5)?\`1.5\`:\`1.4\``),
//     and the state shaper the shaper calls leaves every pool_deposit op out at both (`e.filter(e=>e.kind!==\`pool_deposit\`)`):
//     kit-v1.6 and before have no kind for a pool deposit's op; the answer shaper it calls has kit-v1.6's own branch,
//     its state through that state shaper and every other result (deposit.confirm's moved_out) as it is;
//   - (card signpage-state-holdings) kit-v1.7 is a level of its own below kit 1.8, and the state shaper sends every level
//     below the current one each position with no decimals (`n=Al(t);if(e===\`1.7\`)return n;`, Al being
//     `e=>({...e,positions:e.positions.map(({decimals:e,...t})=>t)})`): kit-v1.7's schema refuses the key, whole state
//     and all. judge(answer, era) also reads a record of an earlier build at the version and levels it was cut at;
//   - (card kit-portfolio-reads) kit-v1.8 is a level of its own below kit 1.9, and the state shaper first sends every
//     level below the current one each op with no detail (`let n={...t,ops:t.ops.map(jl)};if(e===\`1.8\`)return n;`, jl
//     taking created_ms, token and units, and chain and amount_usd but on a pool deposit and a deposit, whose own they
//     are): a kit-v1.8 app drops an op that carries one, so it would lose that row; its answers go through its own level;
//   - (card portfolio-counts-money-an-open-buy-holds) kit-v1.10 is a level of its own below kit 1.11, and the state shaper
//     first takes each position's asset_held from the state (`let n=Vl(t);if(e===\`1.10\`)return n;`, Vl being
//     `e=>({...e,positions:e.positions.map(({asset_held:e,...t})=>t)})`), every lower level built on that: kit-v1.10's
//     schema refuses the key, whole state and all; its answers go through its own level;
//   - (card buy-spends-several-pieces) kit-v1.11 is a level of its own below kit 1.12: the state shaper first takes each
//     pool entry's making (`let n=i_(t);if(e===\`1.11\`)return n;`, i_ being
//     `e=>e.pools===void 0?e:{...e,pools:e.pools.map(({making:e,...t})=>t)}`), the asset_held strip and every lower level
//     built on that; the answer shaper first takes a pool.buy.dry answer's pieces and cost at every level below the
//     current one (`let r=a_(t,n);`, a_ being `(e,t)=>{if(e!==\`pool.buy.dry\`||typeof t!=\`object\`||!t)return t;
//     let{pieces:n,cost:r,...i}=t;return i}`), its kit-v1.11 branch reading that: kit-v1.11's schema refuses the whole
//     state for a making and the whole answer for pieces or cost;
//   - (card signing-layer-says-when-it-closes) kit-v1.12 is a level of its own below kit 1.13, sent the state in full
//     (`if(e===\`current\`||e===\`1.12\`)return t;`); the answer shaper first takes an open kind's closes at every level
//     below the current one (`let r=s_(t,n);if(e===\`1.12\`)return r;`, s_ being `(e,t)=>{if(!Is.includes(e)||typeof
//     t!=\`object\`||!t)return t;let{closes:n,...r}=t;return r}`, Is the bundle's one OPEN_KINDS), the dry strip and
//     every lower branch built on that: kit-v1.12's schema refuses the whole answer for closes;
//   - (card move-sends-what-it-shows) kit-v1.15 is a level of its own below kit 1.16: the answer shaper first takes a
//     pool.move.dry priced answer's max (`let r=F(t,n);if(e===\`1.15\`)return r;`, F being NO_MAX), every lower stage
//     built on that; the state shaper sends it the state in full and the route function tells it the move event: its
//     schema refuses the whole answer for max, and it reads the state and the move event as the current level does;
//   - (card buy-any-amount-on-every-chain) kit-v1.16 is a level of its own below kit 1.17: the answer shaper first takes a
//     pool.buy.dry answer's buys (`let r=B(t,n);if(e===\`1.16\`)return r;`, B being NO_BUYS), the max strip, kit-v1.15's
//     level and every lower stage built on that; the state shaper sends it the state in full and the route function tells
//     it the move event: its schema refuses the whole answer for buys, and it reads the dry move's max, the state and the
//     move event as the current level does;
//   - (card pool-deposit-op-txs) a kit-v1.7+ app's pool_deposit op carries the txs that moved its money, each shown only
//     on the device's own reads: the follow's Solana read lists U_X's finalized signatures (getSignaturesForAddress,
//     finalized, limit 1e3) and keeps a tx only when every RPC's finalized getTransaction reads it a deposit (`.every(`);
//     a refund move's NEAR tx is read wait_until FINAL, sent by the release relayer to intents.near, with SuccessValue
//     on both RPCs (`return i&&a`), and the op adds it only once tx_final is set.
// A page without them sends a kit-v1.4 app a state with a stage or field that kit refuses whole, so that app stops
// receiving states. That the page applies them to every state, answer and event it posts is
// packages/signpage/test/kit-version.test.ts's, against kit-v1.4's own schema, with its mutant sweep.
// The recorded answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg) of each tree (mainnet, as
// SIGN_HOST serves; this file reaches no package code: the import check holds it).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/kit-frame-version.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "kit-frame-version";
/** The kit version the page reads every app at in full (packages/kit/src/signpage/messages.ts SIGNPAGE_KIT_VERSION), and
 *  its levels below that, newest first, down to kit-v1.4's (packages/signpage/src/kit-version.ts KitLevel). */
export const KIT = "1.17";
export const LEVELS = ["1.16", "1.15", "1.14", "1.13", "1.12", "1.11", "1.10", "1.9", "1.8", "1.7", "1.6", "1.5"];
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** kit-v1.4's deposit stages, and what the page must send it for each stage the kit has now. */
export const V1_4 = ["quote_checked", "waiting", "in_transit", "into_vault", "done", "refunded", "held", "halted"];
export const MAP = { ...Object.fromEntries(V1_4.map((s) => [s, s])), failed: "in_transit", short: "in_transit", expired: "quote_checked", refund_move: "refunded" };
/** kit-v1.4's state fields (kit-v1.4:packages/kit/src/signpage/schema.ts state). */
export const V1_4_KEYS = ["release", "api", "signed_in", "way", "code_saved", "signin_failed", "vault_balance", "wallets", "positions", "orders", "held", "ops"];

/** Every object literal of plain `key:\`value\`` pairs in the bundle. */
const PAIRS = /\{((?:[a-z_]+:`[a-z_]+`,)+[a-z_]+:`[a-z_]+`)\}/g;
/** Every array literal of plain backtick strings in the bundle. */
const ARRAYS = /\[((?:`[^`$\\]*`,)*`[^`$\\]*`)\]/g;

const esc = (n) => n.replace(/\$/g, "\\$");
/** The hello reader: the version of an exact { v: 1, type: "hello", kit }, else null. */
const READER = /function ([\w$]+)\([\w$]+\)\{[^{}]{0,200}?\.type!==`hello`[^{}]{0,120}?\?null:[\w$]+\.kit\}/;
/** The level of a version: kit-v1.4 for a malformed one, current from the threshold on, and (card held-move-forgotten-tx)
 *  kit-v1.5 between them, which is sent everything but a deposit's moved_out fact (a build with no kit-v1.5 level sends
 *  it moved_out, and kit-v1.5 refuses the whole state for it). */
const LEVEL = /function ([\w$]+)\(([\w$]+)\)\{let ([\w$]+)=[\w$]+\.exec\(\2\);if\(!\3\)return`1\.4`;[^{}]{0,200}?([\w$]+)\(([\w$]+)\[0\],\5\[1\]\)\?`current`:((?:\4\(1,\d{1,4}\)\?`1\.\d{1,4}`:)*)`1\.4`\}/;
/** The ops filter that leaves out a pool deposit's op (card pool-deposit-stages), as minified. */
const POOL_FILTER = /(?:^|[^\w$])([\w$]+)=([\w$]+)=>\2\.filter\(([\w$]+)=>\3\.kind!==`pool_deposit`\)/;
/** The positions with no decimals (card signpage-state-holdings), as minified. */
const NO_DECIMALS = /(?:^|[^\w$])([\w$]+)=([\w$]+)=>\(\{\.\.\.\2,positions:\2\.positions\.map\(\(\{decimals:[\w$]+,\.\.\.([\w$]+)\}\)=>\3\)\}\)/;
/** An op with no detail (card kit-portfolio-reads), as minified: created_ms, token and units taken, chain kept on a
 *  pool deposit alone and amount_usd on a deposit alone. */
const NO_DETAIL = /function ([\w$]+)\(([\w$]+)\)\{let\{created_ms:[\w$]+,token:[\w$]+,units:[\w$]+,\.\.\.([\w$]+)\}=(?:[\w$]+\(\2\)|\2),([\w$]+)=\3;return \2\.kind!==`pool_deposit`&&delete \4\.chain,\2\.kind!==`deposit`&&delete \4\.amount_usd,\4\}/;

/** An op with no pool_amount (card portfolio-shows-pool-trades), as minified: the op as it is when it has none, else
 *  the op with that key taken. */
const NO_POOL_AMOUNT = /function ([\w$]+)\(([\w$]+)\)\{if\(![\w$]+\(\2,`pool_amount`\)\)return \2;let\{pool_amount:[\w$]+,\.\.\.([\w$]+)\}=\2;return \3\}/;
/** The positions with no asset_held (card portfolio-counts-money-an-open-buy-holds), as minified. */
const NO_ASSET_HELD = /(?:^|[^\w$])([\w$]+)=([\w$]+)=>\(\{\.\.\.\2,positions:\2\.positions\.map\(\(\{asset_held:[\w$]+,\.\.\.([\w$]+)\}\)=>\3\)\}\)/;

/** The pools with no making (card buy-spends-several-pieces), as minified. */
const NO_MAKING = /(?:^|[^\w$])([\w$]+)=([\w$]+)=>\2\.pools===void 0\?\2:\{\.\.\.\2,pools:\2\.pools\.map\(\(\{making:[\w$]+,\.\.\.([\w$]+)\}\)=>\3\)\}/;
/** pool.buy.dry's answer with no pieces and cost (card buy-spends-several-pieces), as minified: any other kind's result,
 *  and one that is no object, as it is. */
const NO_DRY = /(?:^|[^\w$])([\w$]+)=\(([\w$]+),([\w$]+)\)=>\{if\(\2!==`pool\.buy\.dry`\|\|typeof \3!=`object`\|\|!\3\)return \3;let\{pieces:[\w$]+,cost:[\w$]+,\.\.\.([\w$]+)\}=\3;return \4\}/;
/** An open kind's answer with no closes (card signing-layer-says-when-it-closes), as minified: any other kind's result,
 *  and one that is no object, as it is; the kinds read from the one array its includes reads (`closeKinds` below). */
const NO_CLOSES = /(?:^|[^\w$])([\w$]+)=\(([\w$]+),([\w$]+)\)=>\{if\(!([\w$]+)\.includes\(\2\)\|\|typeof \3!=`object`\|\|!\3\)return \3;let\{closes:[\w$]+,\.\.\.([\w$]+)\}=\3;return \5\}/;
/** pool.buy.dry's answer with no out (card solana-buy-preview-complete), as minified: any other kind's result, and one
 *  that is no object, as it is. */
const NO_OUT = /(?:^|[^\w$])([\w$]+)=\(([\w$]+),([\w$]+)\)=>\{if\(typeof \3!=`object`\|\|!\3\|\|\2!==`pool\.buy\.dry`\)return \3;let\{out:[\w$]+,\.\.\.([\w$]+)\}=\3;return \4\}/;
/** pool.buy.dry's answer with no with_cash (card one-balance-buys-on-every-chain), as minified: any other kind's result,
 *  and one that is no object, as it is. */
const NO_CASH = /(?:^|[^\w$])([\w$]+)=\(([\w$]+),([\w$]+)\)=>\{if\(typeof \3!=`object`\|\|!\3\|\|\2!==`pool\.buy\.dry`\)return \3;let\{with_cash:[\w$]+,\.\.\.([\w$]+)\}=\3;return \4\}/;
/** A route event as a level reads it (card one-balance-buys-on-every-chain), as minified: the move event to the current
 *  level only, every other as it is (group: its name). */
const ROUTE_FOR = /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{return \2!==`current`&&Object\.hasOwn\(\3,`move`\)\?null:\3\}/;
/** pool.move.dry's priced answer with no max (card move-sends-what-it-shows), as minified: any other kind's result, the
 *  answer for an amount the move cannot send (no out), and one that is no object, as it is. */
const NO_MAX = /(?:^|[^\w$])([\w$]+)=\(([\w$]+),([\w$]+)\)=>\{if\(typeof \3!=`object`\|\|!\3\|\|\2!==`pool\.move\.dry`\|\|!Object\.hasOwn\(\3,`out`\)\)return \3;let\{max:[\w$]+,\.\.\.([\w$]+)\}=\3;return \4\}/;
/** kit-v1.15's own level (card move-sends-what-it-shows), as minified: the answer shaper's first stage, the dry move's max
 *  strip (`let r=F(t,n);if(e===\`1.15\`)return r;`) with the next stage built on what it returns; the state shaper's
 *  full-state branch naming kit-v1.15 first after the current level; the route function letting kit-v1.15 have the move
 *  event. Each is read (groups: the function's name, then the stage's or clause's text) and taken out of the text the
 *  checks below read, so each of them reads the form it was written for. */
const MAX_STAGE = /(function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)\)\{if\(\3===`current`\)return \5;)let ([\w$]+)=([\w$]+)\(\4,\5\);if\(\3===`1\.15`\)return \6;let ([\w$]+)=([\w$]+)\(\4,\6\);/;
const STATE_115 = /(function ([\w$]+)\(([\w$]+),[\w$]+\)\{if\(\3===`current`)\|\|\3===`1\.15`\|\|/;
const ROUTE_115 = /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{return \2!==`current`&&\2!==`1\.15`&&Object\.hasOwn\(\3,`move`\)\?null:\3\}/;
/** pool.buy.dry's answer with no buys (card buy-any-amount-on-every-chain), as minified: any other kind's result, and
 *  null or one that is no object, as it is. */
const NO_BUYS = /(?:^|[^\w$])([\w$]+)=\(([\w$]+),([\w$]+)\)=>\{if\(\3===null\|\|\2!==`pool\.buy\.dry`\|\|typeof \3!=`object`\)return \3;let\{buys:[\w$]+,\.\.\.([\w$]+)\}=\3;return \4\}/;
/** kit-v1.16's own level (card buy-any-amount-on-every-chain), as minified: the answer shaper's first stage, the dry
 *  buy's buys strip (`let r=B(t,n);if(e===\`1.16\`)return r;`) with the max strip built on what it returns; the state
 *  shaper's full-state branch naming kit-v1.16 first after the current level; the route function letting kit-v1.16 have
 *  the move event. Each is read and taken out of the text before kit-v1.15's are, so each check below reads the form it
 *  was written for. */
const BUYS_STAGE = /(function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)\)\{if\(\3===`current`\)return \5;)let ([\w$]+)=([\w$]+)\(\4,\5\);if\(\3===`1\.16`\)return \6;let ([\w$]+)=([\w$]+)\(\4,\6\);/;
const STATE_116 = /(function ([\w$]+)\(([\w$]+),[\w$]+\)\{if\(\3===`current`)\|\|\3===`1\.16`\|\|/;
const ROUTE_116 = /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{return \2!==`current`&&\2!==`1\.16`&&\2!==`1\.15`&&Object\.hasOwn\(\3,`move`\)\?null:\3\}/;
/** The open kinds (packages/kit/src/signpage/messages.ts OPEN_KINDS): each one's ok answer carries closes from kit 1.13. */
export const OPEN_KINDS = ["withdraw.open", "signin.open", "backup.open", "export.open", "signout", "pool.withdraw"];

/** The pairs of a `key:\`value\`` object literal, as an object. */
const pairsOf = (src) => Object.fromEntries(src.split(",").map((p) => p.split(":").map((x) => x.replace(/`/g, ""))));

/** The hello's path, as minified: the handler setting the level from a hello, the shaper reading it, the post sending
 *  the shaper's output, each the matched code or null; and the shaper's progress branch right after its state branch
 *  with the stage function it calls (the matched code or null) and that function's stage map (its pairs or null). */
function helloPath(given) {
  // card move-sends-what-it-shows: kit-v1.15's level read and taken out first (MAX_STAGE, STATE_115, ROUTE_115); `js` is
  // the text with it out, which a build before kit 1.16 already is
  let js = given;
  // card buy-any-amount-on-every-chain: kit-v1.16's level read and taken out before it (BUYS_STAGE, STATE_116, ROUTE_116),
  // leaving the text a kit 1.16 build is: the max strip on the given answer
  const buysAt = BUYS_STAGE.exec(js);
  if (buysAt) js = js.replace(buysAt[0], () => `${buysAt[1]}let ${buysAt[8]}=${buysAt[9]}(${buysAt[4]},${buysAt[5]});`);
  const state116At = STATE_116.exec(js);
  if (state116At) js = js.replace(state116At[0], () => `${state116At[1]}||`);
  const route116At = ROUTE_116.exec(js);
  if (route116At) js = js.replace(route116At[0], () => `function ${route116At[1]}(${route116At[2]},${route116At[3]}){return ${route116At[2]}!==\`current\`&&${route116At[2]}!==\`1.15\`&&Object.hasOwn(${route116At[3]},\`move\`)?null:${route116At[3]}}`);
  const maxAt = MAX_STAGE.exec(js);
  if (maxAt) js = js.replace(maxAt[0], () => `${maxAt[1]}let ${maxAt[8]}=${maxAt[9]}(${maxAt[4]},${maxAt[5]});`);
  const stateAt = STATE_115.exec(js);
  if (stateAt) js = js.replace(stateAt[0], () => `${stateAt[1]}||`);
  const route115At = ROUTE_115.exec(js);
  if (route115At) js = js.replace(route115At[0], () => `function ${route115At[1]}(${route115At[2]},${route115At[3]}){return ${route115At[2]}!==\`current\`&&Object.hasOwn(${route115At[3]},\`move\`)?null:${route115At[3]}}`);
  const reader = READER.exec(js)?.[1];
  const lv = LEVEL.exec(js);
  const level = lv?.[1];
  // the levels below the current one, each `i(1,N)?\`1.N\`` read as "1.N" (a level whose number is not its name as
  // "1.N->1.M"), and the threshold's version from its own `X=\`1.7\`.split(\`.\`).map(Number)`
  const levels = lv ? [...lv[6].matchAll(/\(1,(\d{1,4})\)\?`1\.(\d{1,4})`/g)].map((x) => (x[1] === x[2] ? `1.${x[2]}` : `1.${x[1]}->1.${x[2]}`)) : null;
  // (or, as the minifier writes kit 1.10's, `X=C.split(...)` with C the one `C=\`1.10\`` in the bundle)
  const split = lv ? new RegExp(`(?:^|[^\\w$])${esc(lv[5])}=(?:\`(\\d{1,4}\\.\\d{1,4})\`|([\\w$]+))\\.split\\(\`\\.\`\\)\\.map\\(Number\\)`).exec(js) : null;
  const named = split?.[2] ? [...js.matchAll(new RegExp(`(?:^|[^\\w$.])${esc(split[2])}=\`(\\d{1,4}\\.\\d{1,4})\`[,;]`, "g"))] : [];
  const kit = split?.[1] ?? (named.length === 1 ? named[0][1] : null);

  // (card signing-layer-says-when-it-closes: with the closed notice's hello flag set in the same expression, `,i=!0`)
  const assign = reader && level ? new RegExp(`let ([\\w$]+)=${esc(reader)}\\([\\w$]+\\);if\\(\\1!==null\\)return void\\(([\\w$]+)=${esc(level)}\\(\\1\\)(?:,[\\w$]+=!0)?\\)`).exec(js) : null;
  const v = assign ? esc(assign[2]) : null;
  const shaper = v ? new RegExp(`([\\w$]+)=\\(([\\w$]+),([\\w$]+)\\)=>\\{if\\(\`ok\`in \\2\\)return \\2\\.ok&&\\3!==void 0\\?\\{\\.\\.\\.\\2,result:([\\w$]+)\\(${v},\\3,\\2\\.result\\)\\}:\\2;if\\(\\2\\.type===\`state\`\\)return\\{\\.\\.\\.\\2,state:([\\w$]+)\\(${v},\\2\\.state\\)\\};`).exec(js) : null;
  // card pool-deposit-stages (review P3 2): the functions the shaper itself calls, the state shaper (for every state
  // answer and event) and the answer shaper; the state shaper's kit-v1.6 and kit-v1.5 branches each through the pool
  // filter, and the answer shaper's kit-v1.6 branch through that state shaper with every other kind's result as it is
  // (deposit.confirm keeps moved_out at kit-v1.6)
  const filter = POOL_FILTER.exec(js)?.[1];
  const noDec = NO_DECIMALS.exec(js)?.[1];
  const noDet = NO_DETAIL.exec(js)?.[1];
  const stateFn = shaper ? esc(shaper[5]) : null;
  const poolOps = filter && stateFn
    ? (new RegExp(`function ${stateFn}\\(([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`\\)return \\2;if\\(\\1===\`1\\.6\`\\)return\\{\\.\\.\\.\\2,ops:${esc(filter)}\\(\\2\\.ops\\)\\};if\\(\\1===\`1\\.5\`\\)return\\{\\.\\.\\.\\2,ops:${esc(filter)}\\(\\2\\.ops\\)\\.map\\(`).exec(js)?.[0] ??
      // card signpage-state-holdings: every level below the current one first takes the positions with no decimals
      (noDec
        ? new RegExp(`function ${stateFn}\\(([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`\\)return \\2;let ([\\w$]+)=${esc(noDec)}\\(\\2\\);if\\(\\1===\`1\\.7\`\\)return \\3;if\\(\\1===\`1\\.6\`\\)return\\{\\.\\.\\.\\3,ops:${esc(filter)}\\(\\3\\.ops\\)\\};if\\(\\1===\`1\\.5\`\\)return\\{\\.\\.\\.\\3,ops:${esc(filter)}\\(\\3\\.ops\\)\\.map\\(`).exec(js)?.[0] ??
          // card kit-portfolio-reads: every level below the current one first takes each op's detail, kit-v1.8 its own level
          // (the op map read as any function here; `detail` below holds it to the strip NO_DETAIL reads)
          // card portfolio-shows-pool-trades: kit-v1.9 its own level first, each op with no pool_amount (`amount` below)
          new RegExp(`function ${stateFn}\\(([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`\\)return \\2;(?:if\\(\\1===\`1\\.9\`\\)return\\{\\.\\.\\.\\2,ops:\\2\\.ops\\.map\\([\\w$]+\\)\\};)?let ([\\w$]+)=\\{\\.\\.\\.\\2,ops:\\2\\.ops\\.map\\([\\w$]+\\)\\};if\\(\\1===\`1\\.8\`\\)return \\3;let ([\\w$]+)=${esc(noDec)}\\(\\3\\);if\\(\\1===\`1\\.7\`\\)return \\4;if\\(\\1===\`1\\.6\`\\)return\\{\\.\\.\\.\\4,ops:${esc(filter)}\\(\\4\\.ops\\)\\};if\\(\\1===\`1\\.5\`\\)return\\{\\.\\.\\.\\4,ops:${esc(filter)}\\(\\4\\.ops\\)\\.map\\(`).exec(js)?.[0] ??
          // card portfolio-counts-money-an-open-buy-holds: every level below the current one first takes each position's
          // asset_held (the strip read as any function here; `held` below holds it to NO_ASSET_HELD and kit-v1.10's level
          // to it), kit-v1.9 and every level below built on what it returns
          new RegExp(`function ${stateFn}\\(([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`\\)return \\2;let ([\\w$]+)=[\\w$]+\\(\\2\\);(?:if\\(\\1===\`1\\.10\`\\)return [\\w$]+;)?(?:if\\(\\1===\`1\\.9\`\\)return\\{\\.\\.\\.\\3,ops:\\3\\.ops\\.map\\([\\w$]+\\)\\};)?let ([\\w$]+)=\\{\\.\\.\\.\\3,ops:\\3\\.ops\\.map\\([\\w$]+\\)\\};if\\(\\1===\`1\\.8\`\\)return \\4;let ([\\w$]+)=${esc(noDec)}\\(\\4\\);if\\(\\1===\`1\\.7\`\\)return \\5;if\\(\\1===\`1\\.6\`\\)return\\{\\.\\.\\.\\5,ops:${esc(filter)}\\(\\5\\.ops\\)\\};if\\(\\1===\`1\\.5\`\\)return\\{\\.\\.\\.\\5,ops:${esc(filter)}\\(\\5\\.ops\\)\\.map\\(`).exec(js)?.[0] ??
          // card buy-spends-several-pieces: every level below the current one first takes each pool entry's making, kit-v1.11
          // its own level (`making` below holds the strip to NO_MAKING), the asset_held strip built on what it returns and
          // kit-v1.10 its own level on that, every lower level built on the asset_held strip's result
          new RegExp(`function ${stateFn}\\(([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`(?:(?:\\|\\|\\1===\`1\\.14\`)?(?:\\|\\|\\1===\`1\\.13\`)?\\|\\|\\1===\`1\\.12\`)?\\)return \\2;let ([\\w$]+)=[\\w$]+\\(\\2\\);if\\(\\1===\`1\\.11\`\\)return \\3;let ([\\w$]+)=[\\w$]+\\(\\3\\);if\\(\\1===\`1\\.10\`\\)return \\4;if\\(\\1===\`1\\.9\`\\)return\\{\\.\\.\\.\\4,ops:\\4\\.ops\\.map\\([\\w$]+\\)\\};let ([\\w$]+)=\\{\\.\\.\\.\\4,ops:\\4\\.ops\\.map\\([\\w$]+\\)\\};if\\(\\1===\`1\\.8\`\\)return \\5;let ([\\w$]+)=${esc(noDec)}\\(\\5\\);if\\(\\1===\`1\\.7\`\\)return \\6;if\\(\\1===\`1\\.6\`\\)return\\{\\.\\.\\.\\6,ops:${esc(filter)}\\(\\6\\.ops\\)\\};if\\(\\1===\`1\\.5\`\\)return\\{\\.\\.\\.\\6,ops:${esc(filter)}\\(\\6\\.ops\\)\\.map\\(`).exec(js)?.[0] ?? null
        : null))
    : null;
  const decimals = noDec && poolOps && poolOps.includes(`=${noDec}(`) ? poolOps : null;
  const detail = noDet && poolOps && poolOps.includes(`.map(${noDet})};`) ? poolOps : null;
  // card portfolio-shows-pool-trades: kit-v1.9's level sends each op with no pool_amount, and every level below it too
  // (the detail strip takes it first)
  const noPool = NO_POOL_AMOUNT.exec(js)?.[1];
  const strip = noDet ? NO_DETAIL.exec(js)?.[0] : undefined;
  const amount = noPool && detail && new RegExp(`===\`1\\.9\`\\)return\\{\\.\\.\\.[\\w$]+,ops:[\\w$]+\\.ops\\.map\\(${esc(noPool)}\\)\\};`).test(detail) && strip?.includes(`=${noPool}(`) ? detail : null;
  // card portfolio-counts-money-an-open-buy-holds: kit-v1.10's level returns the state with no asset_held, the one every
  // lower level is built on (`poolOps`' last form reads that every level below builds on the strip's result)
  const noHeld = NO_ASSET_HELD.exec(js)?.[1];
  // (card buy-spends-several-pieces: or on the making strip's result, kit-v1.11's level, which the given state is not)
  const held = noHeld && poolOps && new RegExp(`\\{if\\(([\\w$]+)===\`current\`(?:(?:\\|\\|\\1===\`1\\.14\`)?(?:\\|\\|\\1===\`1\\.13\`)?\\|\\|\\1===\`1\\.12\`)?\\)return ([\\w$]+);(?:let ([\\w$]+)=[\\w$]+\\(\\2\\);if\\(\\1===\`1\\.11\`\\)return \\3;let ([\\w$]+)=${esc(noHeld)}\\(\\3\\);if\\(\\1===\`1\\.10\`\\)return \\4;|let ([\\w$]+)=${esc(noHeld)}\\(\\2\\);if\\(\\1===\`1\\.10\`\\)return \\5;)`).test(poolOps) ? poolOps : null;
  // card buy-spends-several-pieces: kit-v1.11's level returns the state with no making, the one the asset_held strip and
  // every lower level is built on (`poolOps`' last form)
  const noMaking = NO_MAKING.exec(js)?.[1];
  const making = noMaking && poolOps && new RegExp(`\\{if\\(([\\w$]+)===\`current\`(?:(?:\\|\\|\\1===\`1\\.14\`)?(?:\\|\\|\\1===\`1\\.13\`)?\\|\\|\\1===\`1\\.12\`)?\\)return ([\\w$]+);let ([\\w$]+)=${esc(noMaking)}\\(\\2\\);if\\(\\1===\`1\\.11\`\\)return \\3;let [\\w$]+=[\\w$]+\\(\\3\\);`).test(poolOps) ? poolOps : null;
  const result16 = shaper && stateFn
    ? (new RegExp(`function ${esc(shaper[4])}\\(([\\w$]+),([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`\\)return \\3;if\\((?:\\1===\`1\\.(?:[789]|10)\`\\|\\|)*\\1===\`1\\.6\`\\)return \\2===\`state\`\\?${stateFn}\\(\\1,\\3\\):\\3;`).exec(js)?.[0] ??
      // card buy-spends-several-pieces: every level below the current one reads the result with no dry pieces and cost
      // (`dry` below holds the function to NO_DRY), every branch on that
      new RegExp(`function ${esc(shaper[4])}\\(([\\w$]+),([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`\\)return \\3;let ([\\w$]+)=[\\w$]+\\(\\2,\\3\\);if\\((?:\\1===\`1\\.(?:[789]|1[01])\`\\|\\|)*\\1===\`1\\.6\`\\)return \\2===\`state\`\\?${stateFn}\\(\\1,\\4\\):\\4;`).exec(js)?.[0] ??
      // card signing-layer-says-when-it-closes: every level below the current one first reads the result with no closes
      // (`closes` below holds the function to NO_CLOSES), kit-v1.12 its own level on that, the dry strip and every lower
      // branch built on what it returns
      new RegExp(`function ${esc(shaper[4])}\\(([\\w$]+),([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`\\)return \\3;let ([\\w$]+)=[\\w$]+\\(\\2,\\3\\);if\\(\\1===\`1\\.12\`\\)return \\4;let ([\\w$]+)=[\\w$]+\\(\\2,\\4\\);if\\((?:\\1===\`1\\.(?:[789]|1[01])\`\\|\\|)*\\1===\`1\\.6\`\\)return \\2===\`state\`\\?${stateFn}\\(\\1,\\5\\):\\5;`).exec(js)?.[0] ??
      // card solana-buy-preview-complete: every level below the current one first reads the result with no dry out (`out`
      // below holds the function to NO_OUT), kit-v1.13 its own level on that, the closes strip and every lower branch
      // built on what it returns
      new RegExp(`function ${esc(shaper[4])}\\(([\\w$]+),([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`\\)return \\3;let ([\\w$]+)=[\\w$]+\\(\\2,\\3\\);if\\(\\1===\`1\\.13\`\\)return \\4;let ([\\w$]+)=[\\w$]+\\(\\2,\\4\\);if\\(\\1===\`1\\.12\`\\)return \\5;let ([\\w$]+)=[\\w$]+\\(\\2,\\5\\);if\\((?:\\1===\`1\\.(?:[789]|1[01])\`\\|\\|)*\\1===\`1\\.6\`\\)return \\2===\`state\`\\?${stateFn}\\(\\1,\\6\\):\\6;`).exec(js)?.[0] ??
      // card one-balance-buys-on-every-chain: every level below the current one first reads the result with no dry
      // with_cash (`cash` below holds the function to NO_CASH), kit-v1.14 its own level on that, the out strip and every
      // lower branch built on what it returns
      new RegExp(`function ${esc(shaper[4])}\\(([\\w$]+),([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`\\)return \\3;let ([\\w$]+)=[\\w$]+\\(\\2,\\3\\);if\\(\\1===\`1\\.14\`\\)return \\4;let ([\\w$]+)=[\\w$]+\\(\\2,\\4\\);if\\(\\1===\`1\\.13\`\\)return \\5;let ([\\w$]+)=[\\w$]+\\(\\2,\\5\\);if\\(\\1===\`1\\.12\`\\)return \\6;let ([\\w$]+)=[\\w$]+\\(\\2,\\6\\);if\\((?:\\1===\`1\\.(?:[789]|1[01])\`\\|\\|)*\\1===\`1\\.6\`\\)return \\2===\`state\`\\?${stateFn}\\(\\1,\\7\\):\\7;`).exec(js)?.[0] ?? null)
    : null;
  const noDry = NO_DRY.exec(js)?.[1];
  const dry = noDry && result16 && new RegExp(`\\)return [\\w$]+;let [\\w$]+=${esc(noDry)}\\(`).test(result16) ? result16 : null;
  // review of edc6815f: at 1.8 the answer shaper's kit-v1.6 branch also takes kit-v1.7 (`e===\`1.7\`||e===\`1.6\``), so a
  // kit-v1.7 app's deposit.confirm keeps its facts; a 1.7-era build has no such alternative
  const result17 = result16 && /===`1\.7`\|\|/.test(result16) ? result16 : null;
  // card kit-portfolio-reads: at 1.9 that branch takes kit-v1.8 too, so its deposit.confirm keeps its facts
  const result18 = result16 && /===`1\.8`\|\|/.test(result16) ? result16 : null;
  // card portfolio-shows-pool-trades: at 1.10 it takes kit-v1.9 too
  const result19 = result16 && /===`1\.9`\|\|/.test(result16) ? result16 : null;
  // card portfolio-counts-money-an-open-buy-holds: at 1.11 it takes kit-v1.10 too
  const result110 = result16 && /===`1\.10`\|\|/.test(result16) ? result16 : null;
  // card buy-spends-several-pieces: at 1.12 it takes kit-v1.11 too
  const result111 = result16 && /===`1\.11`\|\|/.test(result16) ? result16 : null;
  // card signing-layer-says-when-it-closes: at 1.13 every level below the current one is sent each open kind's answer
  // with no closes (the strip first, kit-v1.12 its own level on it), the strip's kinds the bundle's one OPEN_KINDS array;
  // and kit-v1.12 is sent the state in full, as the current level is (closes is in no state)
  const noCloses = NO_CLOSES.exec(js);
  const kindsAt = noCloses ? new RegExp(`(?:^|[^\\w$.])${esc(noCloses[4])}=\\[((?:\`[a-z.]+\`,)*\`[a-z.]+\`)\\]`).exec(js) : null;
  const closeKinds = kindsAt ? kindsAt[1].split(",").map((k) => k.slice(1, -1)) : null;
  const closes = (noCloses && result16 && new RegExp(`\\{if\\(([\\w$]+)===\`current\`\\)return ([\\w$]+);let ([\\w$]+)=${esc(noCloses[1])}\\([\\w$]+,\\2\\);if\\(\\1===\`1\\.12\`\\)return \\3;`).test(result16) ||
    // (card solana-buy-preview-complete: or on the out strip's result, kit-v1.13's level, which the given answer is not)
    (noCloses && result16 && new RegExp(`\\{if\\(([\\w$]+)===\`current\`\\)return ([\\w$]+);let ([\\w$]+)=[\\w$]+\\([\\w$]+,\\2\\);if\\(\\1===\`1\\.13\`\\)return \\3;let ([\\w$]+)=${esc(noCloses[1])}\\([\\w$]+,\\3\\);if\\(\\1===\`1\\.12\`\\)return \\4;`).test(result16)) ||
    // (card one-balance-buys-on-every-chain: or below kit-v1.14's level and the out strip's)
    (noCloses && result16 && new RegExp(`\\{if\\(([\\w$]+)===\`current\`\\)return ([\\w$]+);let ([\\w$]+)=[\\w$]+\\([\\w$]+,\\2\\);if\\(\\1===\`1\\.14\`\\)return \\3;let ([\\w$]+)=[\\w$]+\\([\\w$]+,\\3\\);if\\(\\1===\`1\\.13\`\\)return \\4;let ([\\w$]+)=${esc(noCloses[1])}\\([\\w$]+,\\4\\);if\\(\\1===\`1\\.12\`\\)return \\5;`).test(result16)))
    ? result16
    : null;
  const state112 = poolOps && /^function [\w$]+\(([\w$]+),([\w$]+)\)\{if\(\1===`current`(?:\|\|\1===`1\.14`)?(?:\|\|\1===`1\.13`)?\|\|\1===`1\.12`\)return \2;/.test(poolOps) ? poolOps : null;
  // card solana-buy-preview-complete: kit-v1.13 is sent each pool.buy.dry answer with no out (the strip first, kit-v1.13
  // its own level on it), and the state in full, as the current level is (out is in no state)
  const noOut = NO_OUT.exec(js)?.[1];
  const out = noOut && result16 && (new RegExp(`\\{if\\(([\\w$]+)===\`current\`\\)return ([\\w$]+);let ([\\w$]+)=${esc(noOut)}\\([\\w$]+,\\2\\);if\\(\\1===\`1\\.13\`\\)return \\3;`).test(result16) ||
    // (card one-balance-buys-on-every-chain: or on the with_cash strip's result, kit-v1.14's level)
    new RegExp(`\\{if\\(([\\w$]+)===\`current\`\\)return ([\\w$]+);let ([\\w$]+)=[\\w$]+\\([\\w$]+,\\2\\);if\\(\\1===\`1\\.14\`\\)return \\3;let ([\\w$]+)=${esc(noOut)}\\([\\w$]+,\\3\\);if\\(\\1===\`1\\.13\`\\)return \\4;`).test(result16)) ? result16 : null;
  // card one-balance-buys-on-every-chain: kit-v1.14 is sent each pool.buy.dry answer with no with_cash (the strip first,
  // kit-v1.14 its own level on it), and the state in full, as the current level is (with_cash is in no state)
  const noCash = NO_CASH.exec(js)?.[1];
  const cash = noCash && result16 && new RegExp(`\\{if\\(([\\w$]+)===\`current\`\\)return ([\\w$]+);let ([\\w$]+)=${esc(noCash)}\\([\\w$]+,\\2\\);if\\(\\1===\`1\\.14\`\\)return \\3;`).test(result16) ? result16 : null;
  const state114 = poolOps && /^function [\w$]+\(([\w$]+),([\w$]+)\)\{if\(\1===`current`\|\|\1===`1\.14`(?:\|\|\1===`1\.13`)?(?:\|\|\1===`1\.12`)?\)return \2;/.test(poolOps) ? poolOps : null;
  const state113 = poolOps && /^function [\w$]+\(([\w$]+),([\w$]+)\)\{if\(\1===`current`(?:\|\|\1===`1\.14`)?\|\|\1===`1\.13`(?:\|\|\1===`1\.12`)?\)return \2;/.test(poolOps) ? poolOps : null;
  const post = shaper ? new RegExp(`=\\(([\\w$]+),([\\w$]+)\\)=>\\{let ([\\w$]+)=${esc(shaper[1])}\\(\\1,\\2\\);\\3!==null&&[\\w$]+\\.parent\\.postMessage\\(\\3,`).exec(js) : null;
  // the progress branch, read where the shaper's state branch ends (sticky): a route event (no stage) is sent at every
  // level but kit-v1.4 (the current level only, before kit-v1.5 had its own), a stage through the stage function at the level, dropped when it gives null
  let branch = null;
  // since kit 1.15 a route event goes through the route function (ROUTE_FOR) at levels above kit-v1.4: `route` is that
  // function when the progress branch calls it
  const routeAt = ROUTE_FOR.exec(js);
  let route = null;
  if (shaper) {
    const m = esc(shaper[2]);
    const routeFor = esc(routeAt?.[1] ?? "\u0000");
    const re = new RegExp(`if\\(${m}\\.type!==\`progress\`\\)return ${m};if\\(!\\(\`stage\`in ${m}\\)\\)return (?:${v}===\`current\`\\?${m}:null|${v}===\`1\\.4\`\\?null:${m}|${v}===\`1\\.4\`\\?null:${routeFor}\\(${v},${m}\\));let ([\\w$]+)=([\\w$]+)\\(${v},${m}\\.stage\\);return \\1===null\\?null:\\1===${m}\\.stage\\?${m}:\\{\\.\\.\\.${m},stage:\\1\\}\\}`, "y");
    re.lastIndex = shaper.index + shaper[0].length;
    branch = re.exec(js);
    if (branch && routeAt && branch[0].includes(`:${routeAt[1]}(`)) route = routeAt[0];
  }
  // the stage function: the current level and a stage kit-v1.4 has pass as they are, else the map's stage, else null
  const stage = branch ? new RegExp(`function ${esc(branch[2])}\\(([\\w$]+),([\\w$]+)\\)\\{return (?:\\1===\`current\`|\\1!==\`1\\.4\`)\\|\\|[\\w$]+\\.has\\(\\2\\)\\?\\2:[\\w$]+\\(([\\w$]+),\\2\\)\\?\\3\\[\\2\\]:null\\}`).exec(js) : null;
  const map = stage ? new RegExp(`(?:^|[^\\w$])${esc(stage[3])}=Object\\.freeze\\(\\{((?:[a-z_]+:\`[a-z_]+\`,)+[a-z_]+:\`[a-z_]+\`)\\}\\)`).exec(js) : null;
  // card move-sends-what-it-shows: kit-v1.15 is sent each pool.move.dry priced answer with no max (the strip the answer
  // shaper's first stage, kit-v1.15 its own level on it, every lower stage built on what it returns), the state in full
  // (the state shaper's), and the move event (the route function the progress branch calls)
  const noMax = NO_MAX.exec(given)?.[1];
  const max = maxAt && shaper && maxAt[2] === shaper[4] && maxAt[7] === noMax && typeof result16 === "string" ? maxAt[0] : null;
  const state115 = stateAt && shaper && stateAt[2] === shaper[5] && typeof poolOps === "string" ? stateAt[0] : null;
  const route115 = route115At && route && routeAt?.[1] === route115At[1] ? route115At[0] : null;
  // card buy-any-amount-on-every-chain: kit-v1.16 is sent each pool.buy.dry answer with no buys (the strip the answer
  // shaper's first stage, kit-v1.16 its own level on it, the max strip and every lower stage built on what it returns),
  // the state in full, and the move event
  const noBuys = NO_BUYS.exec(given)?.[1];
  const buys = buysAt && max && buysAt[2] === shaper[4] && buysAt[7] === noBuys && buysAt[9] === noMax ? buysAt[0] : null;
  const state116 = state116At && state115 && state116At[2] === shaper[5] ? state116At[0] : null;
  const route116 = route116At && route115 && route116At[1] === route115At[1] ? route116At[0] : null;
  return {
    assign: assign?.[0] ?? null,
    shaper: shaper?.[0] ?? null,
    post: post?.[0] ?? null,
    progress: branch && stage ? `${branch[0]} ${stage[0]}` : null,
    progressMap: map ? pairsOf(map[1]) : null,
    kit,
    levels,
    poolOps,
    result16,
    decimals,
    result17,
    detail,
    result18,
    amount,
    result19,
    held,
    result110,
    making,
    dry,
    result111,
    closes,
    closeKinds,
    state112,
    out,
    state113,
    cash,
    state114,
    route,
    max,
    state115,
    route115,
    buys,
    state116,
    route116,
  };
}

/** The pool deposit op's tx reads, as minified (card pool-deposit-op-txs): U_X's listing; each tx kept only once both
 *  RPCs answered it (a read that fails or answers null throws, two that disagree throw; review P2-a); the NEAR move tx
 *  read FINAL on both, its one execute_intents carrying this move's own intent alone (its signer and nonce; review P1);
 *  and the op adding a move tx only once final, never one let go. */
const OP_TXS = {
  landed: /`getSignaturesForAddress`,\[[\w$]+\.u,\{commitment:`finalized`,limit:1e3\}\]/,
  every: /`getTransaction`,\[[\w$]+,\{commitment:`finalized`,encoding:`json`,maxSupportedTransactionVersion:0\}\]\)\);if\(([\w$]+)\.some\(([\w$]+)=>typeof \2!=`object`\|\|!\2\)\)throw Error\(`[^`]*`\);let\[([\w$]+),([\w$]+)\]=\1\.map\(([\w$]+)=>[\w$]+\(\5,[\w$]+,[\w$]+\.u,[\w$]+\.program\)\);if\(\3!==\4\)throw Error\(/,
  nearFinal: /function ([\w$]+)\([\w$]+,([\w$]+)\)\{[^]{0,200}?method_name:([\w$]+)[^]{0,60}?if\(\3!==`execute_intents`[^]{0,300}?\.signed\.length!==1\)return!1;[^]{0,200}?let ([\w$]+)=JSON\.parse\([\w$]+\.payload\);return typeof \4==`object`&&!!\4&&\4\.signer_id===\2\.signer&&\4\.nonce===\2\.nonce\}async function [\w$]+\([\w$]+,[\w$]+,([\w$]+)\)\{[^]{0,200}?sender_account_id:([\w$]+),wait_until:`FINAL`\}\)[^]{0,300}?final_execution_status!==`FINAL`[^]{0,200}?`SuccessValue`[^]{0,200}?\.signer_id!==\6\|\|[\w$]+\.receiver_id!==`intents\.near`\?!1:Array\.isArray\(([\w$]+)\.actions\)&&\7\.actions\.length===1&&\1\(\7\.actions\[0\],\5\)\}catch\{return!1\}\},\[([\w$]+),([\w$]+)\]=await Promise\.all\(\[[\w$]+\([\w$]+\[0\]\),[\w$]+\([\w$]+\[1\]\)\]\);return \8&&\9\}/,
  moveShown: /\.filter\(([\w$]+)=>\1\.final===!0&&\1\.dropped!==!0&&typeof \1\.hash==`string`\)\.map\(([\w$]+)=>\(\{chain:`near`,hash:\2\.hash\}\)\);return ([\w$]+)\.length===0\?[\w$]+:[\w$]+\([\w$]+,\3\)\}/,
};
const opTxsOf = (js) => Object.fromEntries(Object.entries(OP_TXS).map(([k, re]) => [k, re.exec(js)?.[0] ?? null]));

/** Every post to the frame's parent, as written or as minified: the one through the shaper is the only one there may be. */
const POSTS = /parent\.postMessage\(/g;

/** What the check keeps of the reads: the index, the served bundle's sha384, the stage maps, the key lists, the hello's
 *  path, the count of posts to the parent. */
export function facts(index, js) {
  const maps = [...js.matchAll(PAIRS)]
    .map((m) => pairsOf(m[1]))
    .filter((o) => Object.hasOwn(o, "quote_checked") && Object.hasOwn(o, "halted"));
  const keys = [...js.matchAll(ARRAYS)].map((m) => m[1].split(",").map((s) => s.slice(1, -1))).filter((l) => l[0] === "release" && l.includes("ops"));
  return { index, sha384: sha384(js), maps, keys, hello: helloPath(js), posts: (js.match(POSTS) ?? []).length, opTxs: opTxsOf(js) };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The same stage map in any key order. */
const sameMap = (m, want) => !!m && typeof m === "object" && same(Object.keys(m).sort(), Object.keys(want).sort()) && Object.entries(want).every(([k, v]) => m[k] === v);

/** The version and levels a build is judged at: this card's, or (`era`) an earlier build's, for its own records. */
export const ERA = { kit: KIT, levels: LEVELS };
/** The verdict on an answer { index, sha384, maps, keys, hello, posts }, at `era`'s kit and levels. */
export function judge(a, era = ERA) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const h = a?.hello;
  if (typeof h?.assign !== "string" || typeof h?.shaper !== "string" || typeof h?.post !== "string")
    bad("the bundle reads no kit hello: an app on any kit is sent everything, which kit-v1.4 refuses whole");
  // the progress branch is the shaper's: read only where a shaper was found, else the line above names it
  else if (typeof h?.progress !== "string")
    bad("progress and route events do not go through the shaper's stage map: an app on kit-v1.4 is sent a stage or a route event it cannot read");
  else if (!sameMap(h.progressMap, MAP)) bad(`the progress stage function reads a map other than kit-v1.4's (${JSON.stringify(h.progressMap)})`);
  // card pool-deposit-stages: the version read in full, the levels below it, the pool deposit's op left out below it
  if (typeof h?.assign === "string" && typeof h?.shaper === "string" && typeof h?.post === "string") {
    if (h.kit !== era.kit) bad(`the page reads an app in full from kit-v${h.kit ?? "?"}, not kit-v${era.kit}: a kit-v${era.kit} app's ${era.kit === "1.7" ? "pool deposit op" : era.kit === "1.8" ? "position decimals" : era.kit === "1.9" ? "op detail" : era.kit === "1.10" ? "op pool_amount" : era.kit === "1.11" ? "position asset_held" : era.kit === "1.12" ? "pool making" : era.kit === "1.13" ? "open answer's closes" : era.kit === "1.14" ? "dry buy's out" : era.kit === "1.15" ? "dry buy's with_cash and move route event" : era.kit === "1.16" ? "dry move's max" : "dry buy's buys"} has no level of its own`);
    if (!same(h.levels, era.levels)) bad(`the page's levels below the current one are ${JSON.stringify(h.levels)}, not ${JSON.stringify(era.levels)}: an older kit's app is sent what it cannot read`);
    if (era.kit !== "1.7" && typeof h.decimals !== "string") bad("the state sent below the current level keeps each position's decimals, which kit-v1.7 refuses the whole state for");
    if (typeof h.poolOps !== "string") bad("the state sent to kit-v1.6 and kit-v1.5 does not leave the pool_deposit op out");
    if (typeof h.result16 !== "string") bad("kit-v1.6's answers do not go through its own level: its deposit.confirm is sent without moved_out");
    if (era.kit !== "1.7" && typeof h.result17 !== "string") bad("kit-v1.7's answers do not go through its own level: its deposit.confirm is sent with no facts");
    if (era.kit !== "1.7" && era.kit !== "1.8" && typeof h.detail !== "string") bad("the state sent below the current level keeps each op's detail, for which a kit-v1.8 app drops the op");
    if (era.kit !== "1.7" && era.kit !== "1.8" && typeof h.result18 !== "string") bad("kit-v1.8's answers do not go through its own level: its deposit.confirm is sent with no facts");
    const before19 = ["1.7", "1.8", "1.9"].includes(era.kit);
    if (!before19 && typeof h.amount !== "string") bad("the state sent below the current level keeps each op's pool_amount, for which a kit-v1.9 app drops the op");
    if (!before19 && typeof h.result19 !== "string") bad("kit-v1.9's answers do not go through its own level: its deposit.confirm is sent with no facts");
    const before110 = before19 || era.kit === "1.10";
    if (!before110 && typeof h.held !== "string") bad("the state sent below the current level keeps each position's asset_held, which kit-v1.10 refuses the whole state for");
    if (!before110 && typeof h.result110 !== "string") bad("kit-v1.10's answers do not go through its own level: its deposit.confirm is sent with no facts");
    const before111 = before110 || era.kit === "1.11";
    if (!before111 && typeof h.making !== "string") bad("the state sent below the current level keeps each pool entry's making, which kit-v1.11 refuses the whole state for");
    if (!before111 && typeof h.dry !== "string") bad("pool.buy.dry's answer sent below the current level keeps its pieces and cost, which kit-v1.11 refuses the whole answer for");
    if (!before111 && typeof h.result111 !== "string") bad("kit-v1.11's answers do not go through its own level: its deposit.confirm is sent with no facts");
    const before112 = before111 || era.kit === "1.12";
    if (!before112 && typeof h.closes !== "string") bad("an open kind's answer sent below the current level keeps closes, which kit-v1.12 refuses the whole answer for");
    else if (!before112 && !same(h.closeKinds, OPEN_KINDS)) bad(`the closes strip reads the kinds ${JSON.stringify(h.closeKinds)}, not the open kinds ${JSON.stringify(OPEN_KINDS)}`);
    if (!before112 && typeof h.state112 !== "string") bad("kit-v1.12 is not sent the state in full: it loses a field it reads");
    const before113 = before112 || era.kit === "1.13";
    if (!before113 && typeof h.out !== "string") bad("pool.buy.dry's answer sent below the current level keeps its out, which kit-v1.13 refuses the whole answer for");
    if (!before113 && typeof h.state113 !== "string") bad("kit-v1.13 is not sent the state in full: it loses a field it reads");
    const before114 = before113 || era.kit === "1.14";
    if (!before114 && typeof h.cash !== "string") bad("pool.buy.dry's answer sent below the current level keeps its with_cash, which kit-v1.14 refuses the whole answer for");
    if (!before114 && typeof h.state114 !== "string") bad("kit-v1.14 is not sent the state in full: it loses a field it reads");
    if (!before114 && typeof h.route !== "string") bad("a route event is sent below the current level as it is: kit-v1.14 is sent the move event, which it cannot read");
    const before115 = before114 || era.kit === "1.15";
    if (!before115 && typeof h.max !== "string") bad("pool.move.dry's answer sent below the current level keeps its max, which kit-v1.15 refuses the whole answer for");
    if (!before115 && typeof h.state115 !== "string") bad("kit-v1.15 is not sent the state in full: it loses a field it reads");
    if (!before115 && typeof h.route115 !== "string") bad("kit-v1.15 is not told the move event, which it reads: its buy loses the Cash move it waits on");
    const before116 = before115 || era.kit === "1.16";
    if (!before116 && typeof h.buys !== "string") bad("pool.buy.dry's answer sent below the current level keeps its buys, which kit-v1.16 refuses the whole answer for");
    if (!before116 && typeof h.state116 !== "string") bad("kit-v1.16 is not sent the state in full: it loses a field it reads");
    if (!before116 && typeof h.route116 !== "string") bad("kit-v1.16 is not told the move event, which it reads: its buy loses the Cash move it waits on");
  }
  if (a?.posts !== 1)
    bad(`the bundle holds ${Number.isInteger(a?.posts) ? a.posts : "no count of"} parent.postMessage( calls, not exactly one: a post past the shaper sends an older kit what it cannot read`);
  const maps = a?.maps ?? [];
  const map = maps.find((m) => same(Object.keys(m).sort(), Object.keys(MAP).sort()));
  if (!map) bad("the bundle has no kit-v1.4 deposit stage map over every deposit stage");
  else {
    for (const [from, to] of Object.entries(map)) if (!V1_4.includes(to)) bad(`the map sends kit-v1.4 ${from} as ${to}, a stage it does not have`);
    if (map.refund_move === "done") bad("the map sends a refund still moving as done");
    for (const [from, to] of Object.entries(MAP)) if (map[from] !== to) bad(`the map sends kit-v1.4 ${from} as ${map[from]}, not ${to}`);
  }
  if (!(a?.keys ?? []).some((l) => same([...l].sort(), [...V1_4_KEYS].sort()))) bad("the bundle has no kit-v1.4 state field list of exactly its twelve fields");
  // card pool-deposit-op-txs: a tx shown on the pool_deposit op is one the device read on both RPCs
  const o = a?.opTxs;
  if (typeof o?.landed !== "string" || typeof o?.every !== "string") bad("the pool deposit op's txs are not read on both of the pool chain's RPCs: a tx one RPC alone names may be shown, or a landed deposit shows none");
  if (typeof o?.nearFinal !== "string") bad("a refund move's tx is not read FINAL with success on both NEAR RPCs, sent by the release relayer to intents.near, carrying that move's own intent alone");
  if (typeof o?.moveShown !== "string") bad("the pool deposit op shows a refund move's tx before it is read final");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
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
