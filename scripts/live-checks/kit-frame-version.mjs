#!/usr/bin/env node
// Live check of card kit-frame-version on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and its code, as minified, sends an app on an
// older kit only what that kit reads (packages/signpage/src/kit-version.ts):
//   - it reads the kit's hello ({ v: 1, type: "hello", kit }, packages/kit/src/signpage/messages.ts HelloMessage), the
//     version an app names, and reads an app that names none as kit-v1.4 (kit-v1 to kit-v1.4 are public tags): the
//     request handler sets the page's level from the hello's version (`let c=zc(i);if(c!==null)return void(r=Bc(c))`),
//     the one shaper reads that level for every answer's result and every state event, and the one post sends what the
//     shaper returns (`a=(t,n)=>{let r=i(t,n);r!==null&&e.parent.postMessage(r,...)`);
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
//     its state through that state shaper and every other result (deposit.confirm's moved_out) as it is.
// A page without them sends a kit-v1.4 app a state with a stage or field that kit refuses whole, so that app stops
// receiving states. That the page applies them to every state, answer and event it posts is
// packages/signpage/test/kit-version.test.ts's, against kit-v1.4's own schema, with its mutant sweep.
// The recorded answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg) of each tree (mainnet, as
// SIGN_HOST serves; this file reaches no package code: the import check holds it).
// After: sign
//   node scripts/live-checks/kit-frame-version.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "kit-frame-version";
/** The kit version the page reads every app at in full (packages/kit/src/signpage/messages.ts SIGNPAGE_KIT_VERSION), and
 *  its levels below that, newest first, down to kit-v1.4's (packages/signpage/src/kit-version.ts KitLevel). */
export const KIT = "1.7";
export const LEVELS = ["1.6", "1.5"];
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

/** The pairs of a `key:\`value\`` object literal, as an object. */
const pairsOf = (src) => Object.fromEntries(src.split(",").map((p) => p.split(":").map((x) => x.replace(/`/g, ""))));

/** The hello's path, as minified: the handler setting the level from a hello, the shaper reading it, the post sending
 *  the shaper's output, each the matched code or null; and the shaper's progress branch right after its state branch
 *  with the stage function it calls (the matched code or null) and that function's stage map (its pairs or null). */
function helloPath(js) {
  const reader = READER.exec(js)?.[1];
  const lv = LEVEL.exec(js);
  const level = lv?.[1];
  // the levels below the current one, each `i(1,N)?\`1.N\`` read as "1.N" (a level whose number is not its name as
  // "1.N->1.M"), and the threshold's version from its own `X=\`1.7\`.split(\`.\`).map(Number)`
  const levels = lv ? [...lv[6].matchAll(/\(1,(\d{1,4})\)\?`1\.(\d{1,4})`/g)].map((x) => (x[1] === x[2] ? `1.${x[2]}` : `1.${x[1]}->1.${x[2]}`)) : null;
  const kit = lv ? (new RegExp(`(?:^|[^\\w$])${esc(lv[5])}=\`(\\d{1,4}\\.\\d{1,4})\`\\.split\\(\`\\.\`\\)\\.map\\(Number\\)`).exec(js)?.[1] ?? null) : null;

  const assign = reader && level ? new RegExp(`let ([\\w$]+)=${esc(reader)}\\([\\w$]+\\);if\\(\\1!==null\\)return void\\(([\\w$]+)=${esc(level)}\\(\\1\\)\\)`).exec(js) : null;
  const v = assign ? esc(assign[2]) : null;
  const shaper = v ? new RegExp(`([\\w$]+)=\\(([\\w$]+),([\\w$]+)\\)=>\\{if\\(\`ok\`in \\2\\)return \\2\\.ok&&\\3!==void 0\\?\\{\\.\\.\\.\\2,result:([\\w$]+)\\(${v},\\3,\\2\\.result\\)\\}:\\2;if\\(\\2\\.type===\`state\`\\)return\\{\\.\\.\\.\\2,state:([\\w$]+)\\(${v},\\2\\.state\\)\\};`).exec(js) : null;
  // card pool-deposit-stages (review P3 2): the functions the shaper itself calls, the state shaper (for every state
  // answer and event) and the answer shaper; the state shaper's kit-v1.6 and kit-v1.5 branches each through the pool
  // filter, and the answer shaper's kit-v1.6 branch through that state shaper with every other kind's result as it is
  // (deposit.confirm keeps moved_out at kit-v1.6)
  const filter = POOL_FILTER.exec(js)?.[1];
  const stateFn = shaper ? esc(shaper[5]) : null;
  const poolOps = filter && stateFn
    ? (new RegExp(`function ${stateFn}\\(([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`\\)return \\2;if\\(\\1===\`1\\.6\`\\)return\\{\\.\\.\\.\\2,ops:${esc(filter)}\\(\\2\\.ops\\)\\};if\\(\\1===\`1\\.5\`\\)return\\{\\.\\.\\.\\2,ops:${esc(filter)}\\(\\2\\.ops\\)\\.map\\(`).exec(js)?.[0] ?? null)
    : null;
  const result16 = shaper && stateFn
    ? (new RegExp(`function ${esc(shaper[4])}\\(([\\w$]+),([\\w$]+),([\\w$]+)\\)\\{if\\(\\1===\`current\`\\)return \\3;if\\(\\1===\`1\\.6\`\\)return \\2===\`state\`\\?${stateFn}\\(\\1,\\3\\):\\3;`).exec(js)?.[0] ?? null)
    : null;
  const post = shaper ? new RegExp(`=\\(([\\w$]+),([\\w$]+)\\)=>\\{let ([\\w$]+)=${esc(shaper[1])}\\(\\1,\\2\\);\\3!==null&&[\\w$]+\\.parent\\.postMessage\\(\\3,`).exec(js) : null;
  // the progress branch, read where the shaper's state branch ends (sticky): a route event (no stage) is sent at every
  // level but kit-v1.4 (the current level only, before kit-v1.5 had its own), a stage through the stage function at the level, dropped when it gives null
  let branch = null;
  if (shaper) {
    const m = esc(shaper[2]);
    const re = new RegExp(`if\\(${m}\\.type!==\`progress\`\\)return ${m};if\\(!\\(\`stage\`in ${m}\\)\\)return (?:${v}===\`current\`\\?${m}:null|${v}===\`1\\.4\`\\?null:${m});let ([\\w$]+)=([\\w$]+)\\(${v},${m}\\.stage\\);return \\1===null\\?null:\\1===${m}\\.stage\\?${m}:\\{\\.\\.\\.${m},stage:\\1\\}\\}`, "y");
    re.lastIndex = shaper.index + shaper[0].length;
    branch = re.exec(js);
  }
  // the stage function: the current level and a stage kit-v1.4 has pass as they are, else the map's stage, else null
  const stage = branch ? new RegExp(`function ${esc(branch[2])}\\(([\\w$]+),([\\w$]+)\\)\\{return (?:\\1===\`current\`|\\1!==\`1\\.4\`)\\|\\|[\\w$]+\\.has\\(\\2\\)\\?\\2:[\\w$]+\\(([\\w$]+),\\2\\)\\?\\3\\[\\2\\]:null\\}`).exec(js) : null;
  const map = stage ? new RegExp(`(?:^|[^\\w$])${esc(stage[3])}=Object\\.freeze\\(\\{((?:[a-z_]+:\`[a-z_]+\`,)+[a-z_]+:\`[a-z_]+\`)\\}\\)`).exec(js) : null;
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
  };
}

/** Every post to the frame's parent, as written or as minified: the one through the shaper is the only one there may be. */
const POSTS = /parent\.postMessage\(/g;

/** What the check keeps of the reads: the index, the served bundle's sha384, the stage maps, the key lists, the hello's
 *  path, the count of posts to the parent. */
export function facts(index, js) {
  const maps = [...js.matchAll(PAIRS)]
    .map((m) => pairsOf(m[1]))
    .filter((o) => Object.hasOwn(o, "quote_checked") && Object.hasOwn(o, "halted"));
  const keys = [...js.matchAll(ARRAYS)].map((m) => m[1].split(",").map((s) => s.slice(1, -1))).filter((l) => l[0] === "release" && l.includes("ops"));
  return { index, sha384: sha384(js), maps, keys, hello: helloPath(js), posts: (js.match(POSTS) ?? []).length };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The same stage map in any key order. */
const sameMap = (m, want) => !!m && typeof m === "object" && same(Object.keys(m).sort(), Object.keys(want).sort()) && Object.entries(want).every(([k, v]) => m[k] === v);

/** The verdict on an answer { index, sha384, maps, keys, hello, posts }. */
export function judge(a) {
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
    if (h.kit !== KIT) bad(`the page reads an app in full from kit-v${h.kit ?? "?"}, not kit-v${KIT}: a kit-v${KIT} app's pool deposit op has no level of its own`);
    if (!same(h.levels, LEVELS)) bad(`the page's levels below the current one are ${JSON.stringify(h.levels)}, not ${JSON.stringify(LEVELS)}: a kit-v1.6 app is sent what it has no kind for`);
    if (typeof h.poolOps !== "string") bad("the state sent to kit-v1.6 and kit-v1.5 does not leave the pool_deposit op out");
    if (typeof h.result16 !== "string") bad("kit-v1.6's answers do not go through its own level: its deposit.confirm is sent without moved_out");
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
