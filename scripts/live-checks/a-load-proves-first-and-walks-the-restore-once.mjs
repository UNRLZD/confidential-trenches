#!/usr/bin/env node
// Live check of card a-load-proves-first-and-walks-the-restore-once on SIGN_HOST (https://confidential.unrealized.trade).
// What it holds, signed out, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as
// minified:
//   - first: the page's restore is given the pool flow's first proof passes (main.ts `firstPass`), and a load's resume
//     walks nothing before they settle, handing them RESUME_FIRST_PASS_MAX_MS (20 s, `2e4`), the bound past which a
//     pass that never started is not waited for (src/pool-restore.ts resume);
//   - pass: a load's resume reads its pools as a pass (`pass`, behind every trade's read), a run the user asks for as a
//     trade (`pass`:`trade` on the run's owed flag, handed to the pools);
//   - sync: a run the user asks for while a load's resume runs stops that run and starts its own (the `.owed` loop), so
//     a Sync is never told the resume's end, and starts none when this tab signed out meanwhile.
// What each does is held by the card's tests (packages/signpage/test/pool-restore.test.ts L1-L10); the signed-in part
// (Max inside seconds of a load, no helper 429, one "restore: <chain> walked" line per chain a load) is a signed-in walk.
// The recorded answers are facts() over each tree's packages/signpage/index.html and public/app.js.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/a-load-proves-first-and-walks-the-restore-once.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "a-load-proves-first-and-walks-the-restore-once";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const ID = "[\\w$]+";
// the restore's host is handed the pool flow's first passes, with the bound; the resume walks after them
const HANDED = new RegExp(`firstPass:(${ID})=>${ID}\\?\\.firstPass\\(\\1\\)\\?\\?Promise\\.resolve\\(\\)`);
const WAITS = new RegExp(`(${ID})\\.firstPass&&await \\1\\.firstPass\\(\\1\\.firstPassMaxMs\\?\\?2e4\\)`);
// the run's read kind from its owed flag, handed to the pools (the host's, or pagePools')
const PASS = new RegExp(`let (${ID})=(${ID})\\?\`pass\`:\`trade\`,(${ID})=(${ID})\\.pools\\?\\4\\.pools\\(\\1\\):${ID}\\(${ID},\\1\\)`);
// a run the user asks for stops a load's resume, waits its end, then starts its own, unless this tab signed out
// meanwhile (the epoch taken first, compared last)
const SYNC = new RegExp(`let (${ID})=(${ID});for\\(;(${ID})\\?\\.owed;\\)\\{let (${ID})=\\3;${ID}\\?\\.abort\\(\\),await \\4\\.done\\}return (?:\\2===\\1|\\1===\\2)\\?${ID}\\(!1\\):null`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), first: HANDED.test(js) && WAITS.test(js), pass: PASS.test(js), sync: SYNC.test(js) };
}

/** The verdict on an answer { index, sha384, first, pass, sync }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.first !== true) bad("a load's restore reads beside its first proof pass: the first proof waits on the restore's reads");
  if (a?.pass !== true) bad("a load's restore reads as a trade: its walk goes beside the user's own reads");
  if (a?.sync !== true) bad("a Sync joins a load's restore: it is told the load's end with nothing walked for it");
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
