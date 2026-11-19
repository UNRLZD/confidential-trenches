#!/usr/bin/env node
// Live check of card rent-backs-resume-private on SIGN_HOST (https://confidential.unrealized.trade). A page load named
// every owed buy wallet W, and its token accounts, to the page's public RPC provider: the load's rent-back run passed
// each W whose state had changed (and every W a restore found) on both seats, so one load linked the account's Ws to
// each other and to the device's address there. The signing page (packages/signpage/src/pool-sell.ts resumeRentBacks,
// src/pool-testnet.ts backsSchedule) now makes a run before the page's first tap idle: it reads the Ws on the helper's
// seat alone (the route the positions' pass already reads every W on) and passes none; the page's first tap books the
// passes at a time drawn after it, whose reads stay on both seats before anything is signed. What it proves, and only
// that: the served /app.js is the one index.html pins (its sha384), and its text carries these rules, each found by a
// mark of the bundle's shape (the minifier renames, never restructures them):
//   - an idle run stops after the helper's find read, before any pass, a ride held and nothing counted, each W's
//     RETURNING amount taken from that read (display alone);
//   - the schedule: idle until the first tap's drawn time; that time books one run however the idle runs ended; a ride
//     waits for it; a later tap moves nothing;
//   - each run is idle until then, and is handed so to resumeRentBacks;
//   - a tap of the page's flow books it: a buy or sell a load's start after it, a deposit or withdraw the ride's gap.
// It does not prove those lines run, nor watch a browser's at-load requests: that is the signing page's tests at the
// released commit (test/pool-testnet.test.ts "rent-backs-resume-private", a page load counted by host; test/pool-sell.
// test.ts; test/rent-back-schedule.test.ts), and that the served files are that commit's build is signpage-release's.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/rent-backs-resume-private.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "rent-backs-resume-private";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const esc = (n) => n.replace(/\$/g, "\\$");
const R = String.raw;
/** A mark whose named groups name other code the bundle must hold too: `more(groups)` gives each further pattern. */
const tied = (main, more) => ({
  test(js) {
    const g = main.exec(js)?.groups;
    return Boolean(g) && more(g).every((p) => new RegExp(p).test(js));
  },
});

/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "an idle run stops after the helper's find read, before any pass: its ride held, no pass counted, each W's RETURNING amount that read's": new RegExp(
    R`if\((?<td>${I})\.length===0\)return (?<f>${I})!==null\|\|(?<rd>${I})===null;if\((?<o>${I})\.idle===!0\)\{for\(let (?<w>${I}) of \k<td>\)\{let (?<l>${I})=\k<rd>\?\.get\(\k<w>\)\?\.lamports;if\(\k<l>===void 0\)continue;[^]{0,400}?await ${I}\.owed\.put\(\{\.\.\.(?<r>${I}),lamports:(?<s>${I})\.toString\(\)\}\)\}\)\)return!0\}return \k<o>\.held\?\.\(\),\k<f>!==null\|\|\k<rd>===null[;}]`,
  ),
  "the schedule: idle until the page's first tap's drawn time, which books one run however the idle runs ended; a ride waits for it; a later tap moves nothing": tied(
    new RegExp(R`take\(\)\{return (?<n>${I})\|\|(?<e>${I})\(\)<(?<i>${I})\|\|\k<e>\(\)<(?<a>${I})&&!\((?<u>${I})\(\)&&\((?<l>${I})\|\|(?<s>${I})\(\)\)\)\?!1:\(\k<n>=!0,\k<u>\(\)&&\(\k<l>=!1\),!0\)\},acted:\k<u>,act\((?<t>${I})=\k<e>\(\)\+(?<dr>${I})\(\)\)\{(?<c>${I})===void 0&&\(\k<c>=\k<t>,\k<l>=!0\)\}`),
    (g) => [
      // acted: the first tap's time is past
      R`[,{]${esc(g.u)}=\(\)=>${esc(g.c)}!==void 0&&${esc(g.e)}\(\)>=${esc(g.c)}[,;]`,
      // the ride's due: its booked time past
      R`[,{]${esc(g.s)}=\(\)=>(${I})!==void 0&&${esc(g.e)}\(\)>=\1[,;]`,
    ],
  ),
  "each run before then is idle, and is handed so to the rent backs": tied(
    new RegExp(R`if\((${I})&&(?<sn>${I})\.take\(\)\)\{let (?<n>${I})=!\k<sn>\.acted\(\),(?<r>${I})=\k<sn>\.takeRide\(\),(?<h>${I})=!1,`),
    (g) => [R`await (${I})\((${I}),(${I}),\{\.\.\.${esc(g.r)}===void 0\?\{\}:\{ride:!0,held:\(\)=>void\(${esc(g.h)}=!0\)\},\.\.\.${esc(g.n)}\?\{idle:!0\}:\{\}\}\)`],
  ),
  "a tap of the page's flow books the passes: a buy or sell a load's start after it, a deposit or withdraw the ride's gap": tied(
    new RegExp(R`flow:\((?<t>${I}),(${I})\)=>\((?<sn>${I})\.act\(\k<t>\.kind===` + "`pool.buy`" + R`\|\|\k<t>\.kind===` + "`pool.sell`" + R`\?void 0:(?<ra>${I})\(Date\.now\(\)\)\),`),
    (g) => [R`[,; ]${esc(g.ra)}=(${I})=>\1\+(${I})\(\)[,;]`],
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
