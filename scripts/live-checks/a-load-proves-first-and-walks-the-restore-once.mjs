#!/usr/bin/env node
// Live check of card a-load-proves-first-and-walks-the-restore-once on SIGN_HOST (https://confidential.unrealized.trade).
// What it holds, signed out, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as
// minified:
//   - first: the page's restore is given the pool flow's first proof passes (main.ts `firstPass`), and a load's resume
//     waits on them, at most RESUME_FIRST_PASS_MAX_MS (20 s, `2e4`), before it reads (src/pool-restore.ts resume);
//   - walks: the marker that step 5 is owed keeps each failed walk by scope with its tries and next ask, on the growing
//     pauses WALK_PAUSES_MS ([0,3e4,12e4,3e5,6e5]), and a resume walks a pool only when the marker owes its walk (the
//     `walk` / `store` choice), so a returning device stops walking four chains on every load.
// What each does is held by the card's tests (packages/signpage/test/pool-restore.test.ts L1-L5); the signed-in part
// (the first proof inside 5 s of a load, no helper 429, no repeated "restore: <chain> walked" line) is a signed-in walk.
// The recorded answers are facts() over each tree's packages/signpage/index.html and public/app.js.
// After: sign
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
// the restore's host is handed the pool flow's first passes; the resume waits on them, bounded at 20 s
const HANDED = new RegExp(`firstPass:\\(\\)=>${ID}\\?\\.firstPass\\(\\)\\?\\?Promise\\.resolve\\(\\)`);
const WAITS = new RegExp(`${ID}\\.firstPass&&await ${ID}\\(${ID}\\.firstPassMaxMs\\?\\?2e4,${ID}\\.firstPass\\(\\)\\)`);
// the walks owed, on their pauses, and the resume's choice of what to walk
const PAUSES = /Object\.freeze\(\[0,3e4,12e4,3e5,6e5\]\)/;
const CHOICE = new RegExp(`if\\(${ID}\\?\\.walks===void 0\\)return\`walk\`;let ${ID}=${ID}\\.walks\\[${ID}\\.scope\\.toString\\(\\)\\]`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), first: HANDED.test(js) && WAITS.test(js), walks: PAUSES.test(js) && CHOICE.test(js) };
}

/** The verdict on an answer { index, sha384, first, walks }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.first !== true) bad("a load's restore reads beside its first proof pass: the first proof waits on the restore's reads");
  if (a?.walks !== true) bad("a load walks every pool again while step 5 is owed: a returning device walks four chains on every load");
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
