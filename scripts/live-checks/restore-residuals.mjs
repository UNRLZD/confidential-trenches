#!/usr/bin/env node
// Live check of card restore-residuals on SIGN_HOST (https://confidential.unrealized.trade). What it can show is only
// that the rules shipped in SIGN_HOST's bundle: a second device on a lane and a second tab are not ours to stage on the
// live page, and nobody on the team moves real money. What it holds, signed out, and only that: the served /app.js is
// the one index.html pins (its sha384), and in it, as minified:
//   - kept: a lane kept on step 5's marker is skipped only while its highest note and its count of notes are both what
//     they were, and only on this run's own marker (delta review of c2761c71, ze1; a run's kept lanes never another's);
//   - part: a lane left part way goes on from its point only while its highest note and its count are both the same;
//   - shape: a kept entry holds its count, and its readTo is an index of its own lane (any other entry drops `read`);
//   - lock: step 5 waits for another tab's (the ids lock, on the run's signal) and reads, never skips (ze2);
//   - again: a request that joins once step 5 reads is read for by a run of its own once that run ends (ze2).
// What each does is held by the card's tests (packages/signpage/test/pool-restore.test.ts "restore-residuals", "P3-A",
// "P2-4") and its plants (packages/wallet/scripts/restore-wallets-mutants.mjs).
// The recorded answers are facts() over SIGN_HOST's index.html and /app.js: good, this card's build (--site
// packages/signpage); bad, SIGN_HOST as served before the card.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/restore-residuals.mjs [--site <dir>] [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "restore-residuals";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const N = "[\\w$]+";
// lanesKept.of: this run's marker only, each lane on its highest note and its count
const KEPT = new RegExp(
  `(${N})\\?\\.run===(${N})\\?new Map\\(\\(\\1\\.read\\?\\.\\[${N}\\.toString\\(\\)\\]\\?\\?\\[\\]\\)\\.filter\\(\\(\\[(${N}),,(${N}),(${N})\\]\\)=>\\4===\\((${N})\\[\\3\\]\\?\\?null\\)&&\\5===(${N})\\[\\3\\]\\)\\.map\\(\\(\\[(${N}),(${N})\\]\\)=>\\[\\8,\\9\\]\\)\\):new Map`,
);
// lanesKept.parts: a part point on its lane's highest note and its count
const PART = new RegExp(`\\.filter\\(\\(\\[(${N}),,,(${N}),(${N})\\]\\)=>\\2===\\((${N})\\[\\1\\]\\?\\?null\\)&&\\3===(${N})\\[\\1\\]\\)\\.map\\(\\(\\[(${N}),(${N}),(${N})\\]\\)=>\\[\\6,\\{readTo:\\7,highest:\\8\\}\\]\\)`);
// keptEntry: four fields, readTo an index of its own lane, the count checked
const SHAPE = new RegExp(`(${N})=>Array\\.isArray\\(\\1\\)&&\\1\\.length===4&&Number\\.isInteger\\(\\1\\[0\\]\\)&&\\1\\[0\\]>=0&&\\1\\[0\\]<8&&Number\\.isInteger\\(\\1\\[1\\]\\)&&\\1\\[1\\]>=0&&\\1\\[1\\]<=4294967295&&\\1\\[1\\]%8===\\1\\[0\\]&&\\(\\1\\[2\\]===null\\|\\|[^]{0,120}?\\)&&${N}\\(\\1\\[3\\]\\)`);
// step 5 under the ids lock, waited on the run's signal
const LOCK = (name) => new RegExp(`await ${N}\\(\\)\\.request\\(${name.replace(/[$]/g, "\\$")},\\{mode:\`exclusive\`,signal:(${N})\\},async\\(\\)=>\\{\\1\\.throwIfAborted\\(\\),await ${N}\\(\\)\\}\\)`);
const LOCK_NAME = new RegExp(`(${N})=\`ct-pool/restore-ids\``);
// a request joining once step 5 reads is marked, and the run's end starts a run of its own for it
const JOIN = new RegExp(`(${N})!==null&&\\((${N})\\.reading&&\\((${N})=!0\\),${N}\\(${N},\\2\\.finding\\?\`stalled\`:\\1\\)\\)`);
const AGAIN = (flag) => new RegExp(`await ${N},${flag.replace(/[$]/g, "\\$")}&&(${N})===(${N})&&!(${N})\\.signal\\.aborted&&(${N})===null&&(${N})\\(!1,(${N})\\.finding\\)`);
const count = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length;
const once = (re, js) => count(re, js) === 1;

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const name = once(LOCK_NAME, js) ? LOCK_NAME.exec(js)[1] : null;
  const join = once(JOIN, js) ? JOIN.exec(js) : null;
  return {
    index,
    sha384: sha384(js),
    kept: once(KEPT, js),
    part: once(PART, js),
    shape: once(SHAPE, js),
    lock: name !== null && once(LOCK(name), js) && !js.includes(`request(${name},{mode:\`exclusive\`,ifAvailable`),
    again: join !== null && once(AGAIN(join[3]), js),
  };
}

export const WHY = Object.freeze({
  kept: "a kept lane is skipped on its highest note alone, or on another run's marker",
  part: "a lane left part way goes on from its point on its highest note alone",
  shape: "a kept entry holds no note count, or one whose readTo is off its lane is taken",
  lock: "step 5 skips its ids while another tab reads them, never reading them after",
  again: "a request that joins a running id read is told done with none read for it",
});

/** The verdict on an answer { index, sha384, kept, part, shape, lock, again }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const [k, why] of Object.entries(WHY)) if (a?.[k] !== true) bad(why);
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
    const site = arg("--site");
    const answer = arg("--answer")
      ? JSON.parse(readFileSync(arg("--answer"), "utf8"))
      : site
        ? facts(readFileSync(`${site}/index.html`, "utf8"), readFileSync(`${site}/public/app.js`, "utf8"))
        : await read();
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
