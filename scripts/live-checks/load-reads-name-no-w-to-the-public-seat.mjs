#!/usr/bin/env node
// Live check of card load-reads-name-no-w-to-the-public-seat on SIGN_HOST (https://confidential.unrealized.trade). A
// page load with a buy of several pieces owed its end (its own note spent, its W's SOL perhaps still there) read that
// W's history on both seats, the public provider's too, with no tap: one load named the W there, and with several owed,
// several Ws together. The signing page (packages/signpage/src/pool-testnet.ts resumeOwedPieces, pool-spend.ts
// spendOwnerOne) now reads it on the helper's seat alone until the page's first tap's drawn time (the rent backs'
// backsSchedule.acted): an "other" strands W as before (its rent back reads W on both seats before W signs anything);
// a "mine", which drops the record, waits for the tap and both seats. The found-W scan reads on the pair's second seat,
// the helper's, in every build (the testnet build read one W a request on the public devnet RPC). The load's other W
// reads stay on both seats, each a money move in flight whose read gates a signature or a verdict: an owed withdraw's
// send onward (W signs it, sent to both seats), the follow of this page's own buy that ended sent, a kept sell's
// verdict (its signature, no W address). What it proves, and only that: the served /app.js is the one index.html pins
// (its sha384), and its text carries these rules, each found by a mark of the bundle's shape (the minifier renames,
// never restructures them):
//   - before the page's first tap an owed piece's owner is read on the helper's seat alone, past it on both;
//   - one seat's "mine" decides nothing (kept for both seats); its "other" is taken;
//   - the one-seat owner is the pair's own rule on one seat (every seat's spend found and the same, else not known),
//     and the pair's owner is that rule on both;
//   - the found-W scan reads the Ws on the pair's second seat, in batches, with no one-W-a-request read.
// It does not prove those lines run, nor watch a browser's at-load requests: that is the signing page's tests at the
// released commit (test/pool-testnet.test.ts "load-reads-name-no-w-to-the-public-seat", a page load counted by host;
// test/pool-withdraw.test.ts "spendOwnerOne"; test/pool-found.test.ts), and that the served files are that commit's
// build is signpage-release's.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/load-reads-name-no-w-to-the-public-seat.mjs [--record <file>] [--answer <file> | --build <packages/signpage>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "load-reads-name-no-w-to-the-public-seat";
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
// the owed pieces' owner read, to its seats' choice: the settle pair, whether the tap's drawn time is past, the seats
const OWNER = R`owner:async (?<r>${I})=>\{let (?<p>${I})=(?<sr>${I})\(` + "`pass`" + R`\),(?<b>${I})=(?<sn>${I})\.acted\(\),(?<rs>${I})=\k<b>\?\k<p>:\[\k<p>\[1\]\],`;

/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "before the page's first tap an owed piece's owner is read on the helper's seat alone, past it on both": new RegExp(
    OWNER + R`(${I})=await Promise\.all\(\k<rs>\.map\(`,
  ),
  "one seat's mine decides nothing, its other is taken": new RegExp(
    OWNER + R`[^]{0,600}?(?<o>${I})=\k<b>\?await (${I})\(\k<p>,[^]{0,120}?\):await (${I})\(\k<p>\[1\],[^]{0,120}?\);return \k<o>===null\?null:\k<o>===` + "`other`\\?`other`" + R`:\k<b>\?` + "`mine`" + R`:null\}`,
  ),
  "the one-seat owner is the pair's own rule on one seat, and the pair's is that rule on both": tied(
    new RegExp(R`async function (?<one>${I})\((${I}),(${I}),(${I}),(${I}),(${I}),(${I}),(${I})\)\{return (?<core>${I})\(\[\2\],\3,\4,\5,\6,\7,void 0,\8\)\}`),
    (g) => [
      // the core: every seat's spend found, all the same, else not known
      R`async function ${esc(g.core)}\((${I}),[^)]*\)\{[^]{0,700}?(${I})=await Promise\.all\(\1\.map\([^]{0,80}?\)\),(${I})=\2\[0\];if\(!\3\|\|\2\.some\((${I})=>!\4\)\)return null;if\(\2\.some\((${I})=>\5\.sig!==\3\.sig\|\|\5\.mine!==\3\.mine\)\)`,
      // the pair's owner: the core on its two seats as given
      R`async function (${I})\((${I}),(${I}),(${I}),(${I}),(${I}),(${I}),(${I}),(${I})\)\{return ${esc(g.core)}\(\2,\3,\4,\5,\6,\7,\8,\9\)\}`,
    ],
  ),
  "the found-W scan reads the Ws on the pair's second seat, in batches, with no one-W-a-request read": tied(
    new RegExp(R`for\(let (${I}) of await (?<h>${I})\((${I}),(${I})\(` + "`pass`" + R`\)\[1\]\)\)await (${I})\.put\(\{address:\1\.address,l:\1\.l\.toString\(\),j:\1\.j,mints:\[\],passes:0,found:!0\}\)`),
    (g) => [R`async function ${esc(g.h)}\((${I}),(${I})\)\{let (${I})=(${I})=>\{if\(\4===null\)return 0n;[^]{0,300}?for\(let (${I})=0;\5<\1\.length;\5\+=100\)\{[^]{0,120}?await \2\(` + "`getMultipleAccounts`" + R`[^]{0,400}?\}\)\}return (${I})\}`],
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
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : arg("--build") ? facts(readFileSync(`${arg("--build")}/index.html`, "utf8"), readFileSync(`${arg("--build")}/public/app.js`, "utf8")) : await read();
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
