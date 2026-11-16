#!/usr/bin/env node
// Live check of card fresh-walk-reads-each-range-once on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified, the pool
// sync's walk confirms each run of the wide read (packages/wallet/src/pool/evm.ts wideOf, the helper's keyed route's one
// call for the pool's logs) this way:
//   - others: on the sync's sources of another operator than the wide source's, by its name ("helper") and by its URL's
//     company both, never a seat: Robinhood's second seat is the wide source's own route, whose answer is the wide
//     read's word again (release 161: a run stood on the helper's word twice);
//   - race: the first two of them asked at once, the rest only once both fail;
//   - stands: the first to agree ends the run's read (the rest aborted), so the walk waits on no slow provider
//     (release 161: Robinhood walked 11.5-11.7 s after Solana on its build, 5.4-6.1 s on release 159's, as the run
//     waited on both seats);
//   - gated: each provider's calls of a run go one after another, none once the run stands, so a paced provider's
//     queue (Robinhood's own RPC reads one event a call, three a run) holds no call no one waits for.
// What each does is held by the card's tests (packages/wallet/test/pool-evm.test.ts, "fresh-walk-reads-each-range-
// once"); the recorded answers are facts() over each build's packages/signpage index.html and app.js (this file reaches
// no package code: the import check holds it). How fast a fresh sign-in walks is first-sign-in-reads-fast's, and what
// it reads evm-tree-reads-only-when-needed's.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/fresh-walk-reads-each-range-once.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "fresh-walk-reads-each-range-once";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
const N = "[\\w$]+";

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  // the sources past the wide source's operator: `.filter(s => wide !== void 0 && s.op !== op && (host === null ||
  // hostOf(s.rpc) !== host) && !sameProvider(s.rpc, wide))`
  const others = new RegExp(`\\.filter\\((${N})=>(${N})!==void 0&&\\1\\.op!==${N}&&\\((${N})===null\\|\\|${N}\\(\\1\\.rpc\\)!==\\3\\)&&!${N}\\(\\1\\.rpc,\\2\\)\\)`).test(js);
  // the first two asked at once, then one at a time: `for (let i = 0; i < l.length; i += i === 0 ? 2 : 1) { let a = l.slice(i, i === 0 ? 2 : i + 1)`
  const race = new RegExp(`for\\(let (${N})=0;\\1<(${N})\\.length;\\1\\+=\\1===0\\?2:1\\)\\{let ${N}=\\2\\.slice\\(\\1,\\1===0\\?2:\\1\\+1\\)`).test(js);
  // the run's read ended once one agreed
  const stands = new RegExp(`finally\\{${N}\\.abort\\(Error\\(${Q}the run stands${Q}\\)\\)`).test(js);
  // `let last = Promise.resolve(); ... last.then(() => (ac.signal.throwIfAborted(), r(method, params)))`
  const gated = new RegExp(`let (${N})=Promise\\.resolve\\(\\);return Object\\.assign\\(\\((${N}),(${N})\\)=>\\{let (${N})=\\1\\.then\\(\\(\\)=>\\(${N}\\.signal\\.throwIfAborted\\(\\),(${N})\\(\\2,\\3\\)\\)\\);return \\1=\\4\\.catch\\(\\(\\)=>\\{\\}\\),\\4\\},\\{url:\\5\\.url\\}\\)`).test(js);
  return { index, sha384: sha384(js), others, race, stands, gated };
}

const NO_OTHERS = "BAD a run of the wide read stands on a seat, so the wide source's own route can give its word twice";
const NO_RACE = "BAD a run of the wide read is not asked of two other operators at once";
const NO_STANDS = "BAD a run of the wide read waits on every provider asked, the slowest included";
const NO_GATED = "BAD a run's calls still go out once the run stands, holding a paced provider's next read behind them";

/** The verdict on an answer { index, sha384, others, race, stands, gated }. */
export function judge(a) {
  const lines = [];
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) lines.push("BAD SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) lines.push("BAD SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.others !== true) lines.push(NO_OTHERS);
  if (a?.race !== true) lines.push(NO_RACE);
  if (a?.stands !== true) lines.push(NO_STANDS);
  if (a?.gated !== true) lines.push(NO_GATED);
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
