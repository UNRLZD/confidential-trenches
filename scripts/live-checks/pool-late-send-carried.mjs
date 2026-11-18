#!/usr/bin/env node
// Live check of card pool-late-send-carried on SIGN_HOST (https://confidential.unrealized.trade). What it can show is
// only that the rule shipped in SIGN_HOST's bundle: no account of ours holds money at a pool deposit's U_X a lost store
// named, and nobody on the team moves real money, so a carry itself is never run here. What it holds, signed out, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - window: each pool whose U_X the page reads keeps step 7's window on step 5's marker (the vault's `late`) before
//     its ids are read, so a load inside the 72 h reads them again;
//   - wired: the pool loop runs step 7 (readPoolLate) on a complete read of the scope, with the indices step 5 found
//     this try (its U_X and its NEAR money) left to step 5, and a throw of it is a reason by the pool's label;
//   - plan: step 7's plan (afterRestore) takes every lane, a lane the marker kept as read whole by its highest with
//     history (the index it was read to less the margin), so a kept lane is never left out;
//   - carry: each re-read U_X whose index holds a note this device planned on its own is left to its deposit follow,
//     one with no note gets its deposit note from planFound before the carry (carryUx), and a read that fails is a
//     reason named, never nothing;
//   - near: each re-read NEAR id's holdings are named as step 5 names an id holding money (nearHeldNamed), a failed
//     read a reason; nothing is carried from NEAR.
// What each does is held by the card's tests (packages/signpage/test/pool-restore.test.ts "pool-late-send-carried") and
// its mutants (packages/wallet/scripts/restore-wallets-mutants.mjs).
// The recorded answers are facts() over SIGN_HOST's index.html and /app.js: good, this card's build (--site
// packages/signpage); bad, SIGN_HOST as served before the card.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/pool-late-send-carried.mjs [--site <dir>] [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-late-send-carried";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const N = "[\\w$]+";
const Q = "`";
const esc = (n) => n.replace(/[$]/g, "\\$");
// the pool loop: the window kept (late) on the pass's time before the scope's U_X reader and its lanes are read
const WINDOW = new RegExp(`(${N})!==null&&await (${N})\\.late\\(\\1\\);let (${N})=(${N})\\.chain,`);
// the pool loop: step 7 on a complete read, step 5's found indices skipped, a throw named by the pool's label
const WIRED = new RegExp(
  `(${N})!==null&&(${N})\\.complete&&await (${N})\\(${N},\\{\\.\\.\\.(${N}),ux:${N}\\},\\2,(${N}),\\{rpcs:${N},pass:${N},opts:${N}\\.opts\\?\\?\\{\\}\\},${N},${N},${N},${N}\\.notesAt,\\{ux:new Set\\(${N}\\.keys\\(\\)\\),near:new Set\\(${N}\\.keys\\(\\)\\)\\}\\)\\.catch\\((${N})=>\\{if\\(${N}\\.aborted\\|\\|\\6 instanceof ${N}\\)throw \\6;${N}\\.retry\\.push\\(${Q}\\$\\{\\4\\.label\\}: step 7's re-read did not finish`,
);
// readPoolLate's plan: the lanes the marker keeps, as step 5 took them (kept.of, on each lane's highest note and its
// count of notes: card restore-residuals), then each lane read, or kept (its highest the index it was read to less
// 8 x 21), into afterRestore
const PLAN = (fn) =>
  new RegExp(
    `async function ${esc(fn)}\\(${N},(${N}),${N},(${N}),[^)]*\\)\\{let (${N})=await \\2\\.of\\(\\1\\.scope,${N}\\(\\1\\.notes,\\1\\.scope\\)\\.laneHighest,${N}\\(\\1\\.notes,\\1\\.scope\\)\\),(${N})=Array\\.from\\(\\{length:8\\},\\((${N}),(${N})\\)=>\\{let (${N})=${N}\\.lanes\\.find\\(${N}=>${N}\\.lane===\\6\\);if\\(\\7!==void 0\\)return \\7;let (${N})=\\3\\.get\\(\\6\\);if\\(\\8===void 0\\)throw Error\\(${Q}lane \\$\\{\\6\\} was neither read nor kept${Q}\\);` +
      `let (${N})=[^;]*,(${N})=Math\\.max\\(\\8-168,\\9\\.at\\(-1\\)\\?\\?-1\\);return\\{lane:\\6,notes:\\9,money:\\[\\],used:\\[\\],unread:\\[\\],highest:\\10>=\\6\\?\\10:null,readTo:\\8,reach:null\\}\\}\\)[^]{0,200}?try\\{(${N})=await ${N}\\(${N},\\{lane:${N}\\.lane,raiseDepositIndex:async\\(${N},(${N})\\)=>\\12\\},\\1\\.scope,\\4,${N}\\.pass\\)\\}finally`,
  );
// readPoolLate's U_X: a note this device planned skipped, planFound before the carry where none, a failed read named
const CARRY = new RegExp(
  `let (${N})=(${N})\\.get\\(${N}\\.i\\);if\\(\\1!==void 0&&!\\1\\.found\\)continue;[^]{0,200}?try\\{(${N})=await ${N}\\(${N}\\.ux,\\{chain:${N}\\.chain,s:${N}\\.scope\\.toString\\(\\),i:(${N})\\.i,u:${N},refund_id:\\4\\.id\\},\\1!==void 0\\|\\|\\((${N})=>${N}\\.found\\(${N}\\.scope,\\4\\.i,\\5\\)\\),${N}\\)\\}catch\\((${N})\\)\\{if\\(${N}\\.aborted\\|\\|\\6 instanceof ${N}\\)throw \\6;${N}\\.retry\\.push\\(${Q}\\$\\{${N}\\} was not read \\(`,
);
// readPoolLate's NEAR re-reads: each one's holdings named as step 5 names them, a failed read a reason
const NEAR = new RegExp(
  `if\\((${N})\\.due\\)for\\(let (${N}) of \\1\\.ids\\)\\{if\\(${N}\\.near\\.has\\(\\2\\.i\\)\\)continue;let (${N})=${Q}error${Q}in \\2\\?\\[\\{why:${Q}was not read on NEAR \\(\\$\\{\\2\\.error\\}\\): read again${Q},retry:!0\\}\\]:await ${N}\\(async\\(\\)=>\\2\\.held,\\2\\.id\\);for\\(let (${N}) of \\3\\)\\(${Q}error${Q}in \\2\\?(${N})\\.retry:\\4\\.retry\\?\\5\\.held:\\5\\.named\\)\\.push\\(`,
);
const once = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length === 1;

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const wired = once(WIRED, js) ? WIRED.exec(js) : null;
  return {
    index,
    sha384: sha384(js),
    window: once(WINDOW, js),
    wired: !!wired,
    plan: !!wired && once(PLAN(wired[3]), js),
    carry: once(CARRY, js),
    near: once(NEAR, js),
  };
}

export const WHY = Object.freeze({
  window: "a pool's ids keep no step 7 window on step 5's marker, so no later load reads them again",
  wired: "the restore runs no step 7 on a pool's ids, or reads again what step 5 found in the same try",
  plan: "step 7's plan leaves out a lane the marker kept, or takes its highest as its notes' alone",
  carry: "a late U_X is carried under a note this device planned, or with no note written first, or a failed read is not named",
  near: "a pool id NEAR re-reads holding money is not named as step 5 names it",
});

/** The verdict on an answer { index, sha384, window, wired, plan, carry, near }. */
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
