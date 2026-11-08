#!/usr/bin/env node
// Live check of card sol-sell-deposit-back-floor on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384), it is the /app.js of a written release
// list from this card's release on (packages/signpage/releases/release-<N>.json, N >= FIRST_RELEASE), so its bytes are
// a build of source whose tests ran; and in it, as minified, the Solana sell's rule (packages/signpage/src/rules/pool.ts
// checkSolanaSell) takes the kit's release floor at the rent read and refuses a deposit back under it by name:
// `kept = minOut - reserve < solanaPoolNoteFloor(rent), last = <the last instruction>; if (kept && last.program ===
// pin.program) return refuse("deposit_floor")`. Every sell the device signs passes that rule first. What the floor is, and that the device
// then builds the venue's sell alone (the sale kept on W for the next sell or the rent back's sweep), is held by the
// card's tests (packages/signpage/test/pool-sell.test.ts and rules-pool.test.ts "release floor", "deposit_floor") and
// their mutants (scripts/rent-back-mutants.mjs "floor F", test/rules-pool-mutants.mjs).
// The recorded answers are facts() over a tree's packages/signpage/index.html and public/app.js, or SIGN_HOST's own
// page. This file reaches no package code (the import check holds it). The PR's own build runs judge(read, { ledger:
// false }) in scripts/ci/bundle-checks.mjs, since it is cut as a release only after its merge.
// After: sign
//   node scripts/live-checks/sol-sell-deposit-back-floor.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "sol-sell-deposit-back-floor";
export const SIGN = "https://confidential.unrealized.trade";
/** This card's release: the first list whose signing page refuses a sell's deposit back under the floor (release-107,
 *  cut at 6d3509b8). */
export const FIRST_RELEASE = 107;
const RELEASES = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages/signpage/releases");
/** The SIGN_HOST /app.js of every written release list from FIRST_RELEASE on: its sha384 to its release. */
export function releasedAppJs(dir = RELEASES, from = FIRST_RELEASE) {
  const out = new Map();
  for (const f of readdirSync(dir)) {
    const n = /^release-(\d+)\.json$/.exec(f)?.[1];
    if (n === undefined || Number(n) < from) continue;
    const app = JSON.parse(readFileSync(path.join(dir, f), "utf8")).hosts?.SIGN_HOST?.files?.find((x) => x.path === "/app.js");
    if (typeof app?.sha384 === "string") out.set(app.sha384, `release-${n}`);
  }
  return out;
}
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
// let kept = minOut - reserve < floor(rent), last = body.at(-1); if (kept && last.program === pin.program) return
// refuse("deposit_floor")
const FLOOR = new RegExp(`let (${N})=${N}-${N}<${N}\\(${N}\\),(${N})=${N}\\.at\\(-1\\);if\\(\\1&&\\2\\.program===${N}\\.program\\)return ${N}\\([\`"']deposit_floor[\`"']\\)`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and whether the bundle holds the mark. */
export function facts(index, js) {
  return { index, sha384: sha384(js), floor: FLOOR.test(js) };
}

/** The verdict on an answer { index, sha384, floor }, against the release lists' /app.js files (none with `ledger:
 *  false`). */
export function judge(a, { ledger = true, released = ledger ? releasedAppJs() : null } = {}) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (released && !released.has(a?.sha384)) bad(`SIGN_HOST's served /app.js is the /app.js of no release list of this card's on: bytes no tested source built`);
  if (a?.floor !== true) bad("the bundle's Solana sell signs a deposit back under the kit's release floor: a note no release can take whole");
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
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
