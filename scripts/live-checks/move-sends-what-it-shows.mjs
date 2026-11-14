#!/usr/bin/env node
// Live check of card move-sends-what-it-shows on SIGN_HOST (https://confidential.unrealized.trade) and APP_HOST
// (https://ct-app.unrealized.trade). What it holds, and only that: the served /app.js is the one index.html pins (its
// sha384), and in it (packages/signpage/src/cash-to-pool.ts moveDry, poolMoveKinds):
//   - pool.move.dry answers an amount the move cannot send with what it can: max and, each when there is one, min,
//     below and above, and no out (`limits`);
//   - each priced answer names max, the most the move can send now (`priced`: Cash's, a pool's to Cash, a pool's to
//     another pool in one confidential swap and through Cash; card move-one-confidential-swap added the third);
//   - a move out of a pool to another pool reads the destination pool's deposit floor first and answers down when it
//     cannot read it (`floor`), checking what the move brings there against it;
//   - pool.move, from Cash or out of a pool, runs that same dry first and starts nothing when it answers no out, below_min
//     under a floor (`hold`), so no move parks its money in Cash for a floor the second leg cannot clear.
// And APP_HOST's page scripts (apps/terminal/src/screens/portfolio/MoveSheet.tsx, move-source.tsx): the move sheet reads
// that answer (`limits`), its Max is the page's (`max`), and an amount the move cannot send draws Min or Try with each
// amount a tap that types it (`tries`). What the dry answers for which notes, floors and prices is held by
// packages/signpage/test/move-sends-what-it-shows.test.ts; what the sheet draws, at 390 and 1440, by
// apps/terminal/test/portfolio/run.mjs (move-max, move-min, move-try).
// The recorded answers are facts() over this card's builds (packages/signpage/scripts/build-app.mjs --out, mainnet, and
// apps/terminal's vite build) and over the hosts as served before it.
// After: app sign
// Bundle: read app
//   node scripts/live-checks/move-sends-what-it-shows.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "move-sends-what-it-shows";
export const SIGN = "https://confidential.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** pool.move.dry's own function, as minified (group: its name): three arguments, the first line choosing the asset's
 *  decimals by whether the move leaves Cash. */
const DRY = /async function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)\)\{let [\w$]+=\4\.from===`near`\?/;
/** pool.move holding every move to that dry (groups: the answer, the dry's name): a move from Cash or out of a pool
 *  starts only on an answer with out, and an answer with min is refused below_min. */
const HOLD = /let ([\w$]+)=await ([\w$]+)\([\w$]+\(\),[^;]{0,40}\);return`error`in \1\?\1:`out`in \1\.result\?[\w$]+\.from===`near`\?[\w$]+\(\)\.move\([^()]*\):[\w$]+\(\)\.move\([^()]*\):\{error:\1\.result\.min===void 0\?[^{}]{0,120}:`below_min`\}/;
/** The answer for an amount the move cannot send: max, the steps, and min, below and above each when given. */
const LIMITS = /\{result:\{max:[\w$]+\([\w$]+\),steps:[\w$]+,\.\.\.([\w$]+)\.min===void 0\?\{\}:\{min:[\w$]+\(\1\.min\)\},\.\.\.\1\.below===void 0\?\{\}:\{below:[\w$]+\(\1\.below\)\},\.\.\.\1\.above===void 0\?\{\}:\{above:[\w$]+\(\1\.above\)\}\}\}/;
/** A priced answer naming max. */
const PRICED = /fee:[\w$]+(?:\([^()]*\))?,steps:[\w$]+,max:[\w$]+\([\w$.]+\)\}\}/g;
/** The destination pool's floor read before a pool to pool move: down without it, then what the move brings there. */
const FLOOR = /if\(([\w$]+)\.floor===null\)return\{error:`down`\};let ([\w$]+)=\1\.floor,([\w$]+)=[\w$]+=>\{let [\w$]+=[\w$]+\.usdcOf\(/;
/** The app's marks: the dry's limits read, Max from the page, each amount it can send a tap. */
const APP_MARKS = {
  limits: /kind:[`"]limits[`"],value:/,
  max: /"data-control":[`"]move-max[`"],"data-max":/,
  tries: /"data-control":[`"]move-try[`"],"data-amount":/,
};

/** What the check keeps of SIGN_HOST's reads: the index, the served bundle's sha384, and the facts read from it. */
export function facts(index, js) {
  const dry = DRY.exec(js);
  const hold = HOLD.exec(js);
  // the dry's own text: from its name to the next top-level function
  const at = dry ? dry.index : -1;
  const end = at < 0 ? -1 : js.indexOf("}function ", at);
  const body = at < 0 ? "" : js.slice(at, end < 0 ? undefined : end);
  return {
    index,
    sha384: sha384(js),
    hold: !!(dry && hold && hold[2] === dry[1]),
    limits: LIMITS.test(body),
    priced: (body.match(PRICED) ?? []).length,
    floor: FLOOR.test(body),
  };
}

/** Which of the app's marks any of APP_HOST's page scripts carries. */
export const appOf = (scripts) => Object.keys(APP_MARKS).filter((k) => scripts.some((js) => APP_MARKS[k].test(js)));

/** The verdict on an answer { index, sha384, hold, limits, priced, floor, app }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.limits !== true) bad("pool.move.dry answers no amount it can send for one it cannot: the sheet has no Max, Min or Try to show");
  // four priced answers since card move-one-confidential-swap: Cash's, a pool's to Cash, a pool's to another pool in one
  // confidential swap, and a pool's to another pool through Cash (a page with no one-swap route)
  if (a?.priced !== 4) bad(`pool.move.dry names max on ${Number.isInteger(a?.priced) ? a.priced : "no"} of its 4 priced answers: Max is not what the move sends`);
  if (a?.floor !== true) bad("a pool to pool dry does not read the destination pool's floor first: a move under it ends with its money in Cash");
  if (a?.hold !== true) bad("pool.move does not hold to its dry: a move the dry refuses still leaves Cash or its pool");
  const app = Array.isArray(a?.app) ? a.app : [];
  const missing = Object.keys(APP_MARKS).filter((k) => !app.includes(k));
  if (missing.length) bad(`APP_HOST's scripts lack the move sheet's ${missing.join(", ")}: its Max or its hint is not what the page can send`);
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (origin, path) => {
    const r = await fetchFn(`${origin}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${origin}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const page = await get(APP, "/");
  const srcs = [...page.matchAll(/<script\b[^>]*\bsrc="(\/[^"]+)"/gi)].map((m) => m[1]);
  if (srcs.length === 0) throw new Error("APP_HOST's page names no script");
  const scripts = [];
  for (const src of srcs) scripts.push(await get(APP, src));
  return { ...facts(await get(SIGN, "/"), await get(SIGN, "/app.js")), app: appOf(scripts) };
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
