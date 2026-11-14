#!/usr/bin/env node
// Live check of card move-sends-or-says-why on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and only
// that: the served /app.js is the one index.html pins (its sha384), and in it (packages/signpage/src/pool-to-cash.ts,
// pool-withdraw.ts, pool-withdraw-evm.ts):
//   - a move out of a pool is written leaving with its send-by, MOVE_SEND_MS (5 min) from the tap (`sendBy`);
//   - the run's claim refuses to send once the move ended or passed its send-by (`claim`);
//   - the follow ends a move nothing claimed by its send-by failed, not_sent (`expiry`);
//   - both pool runs, Solana's and the EVM pools', claim right before a note is RESERVED to leave (`runs`: 2; 3 from
//     release 142, whose Cash withdraw request claims the same way, wallet withdraw/request.ts).
// So a Move sends or shows failed in bounded time, never Processing for good. What each does for which records and
// clocks is held by packages/signpage/test/move-sends-or-says-why.test.ts.
// The recorded answers are facts() over this card's build (packages/signpage/scripts/build-app.mjs --out, mainnet), its
// base's (43351a214, release 137) and SIGN_HOST as served before it.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/move-sends-or-says-why.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "move-sends-or-says-why";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The move's record with its send-by (groups: the tap's time, the bound's name). */
const SEND_BY = /created_ms:([\w$]+),send_by_ms:\1\+([\w$]+)\}/;
/** The claim's refusal. */
const CLAIM = /if\([\w$]+\?\.claimed_ms===void 0\|\|[\w$]+\.stage===`failed`\)throw Error\(`the move may no longer send`\)/;
/** The follow's end of a move nothing claimed in time. */
const EXPIRY = /stage:`failed`,error:`not_sent`/;
/** A run's claim, right before its note is RESERVED to leave. */
const RUNS = /await [\w$]+\.claim\?\.\(\),await [\w$]+\.move\([\w$.]+,`HELD`,`RESERVED`/g;

/** What the check keeps of SIGN_HOST's reads: the index, the served bundle's sha384, and the facts read from it. */
export function facts(index, js) {
  const s = SEND_BY.exec(js);
  // the bound's own value: 5 min, as minified (3e5)
  const bound = s ? new RegExp(`(?:^|[,;{ ])${s[2].replace(/\$/g, "\\$")}=(3e5|300000)[,;]`).test(js) : false;
  return { index, sha384: sha384(js), sendBy: bound, claim: CLAIM.test(js), expiry: EXPIRY.test(js), runs: (js.match(RUNS) ?? []).length };
}

/** The verdict on an answer { index, sha384, sendBy, claim, expiry, runs }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.sendBy !== true) bad("a move out of a pool is not written with a 5 min send-by before its quote: nothing bounds it");
  if (a?.claim !== true) bad("the run's claim does not refuse a move that ended or passed its send-by: a move shown failed could still send");
  if (a?.expiry !== true) bad("the follow does not end an unclaimed move failed at its send-by: Processing for good");
  if (!Number.isInteger(a?.runs) || a.runs < 2) bad(`${Number.isInteger(a?.runs) ? a.runs : "no"} of the 2 pool runs claim before a release leaves`);
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${SIGN}${path}: HTTP ${r.status}`);
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
