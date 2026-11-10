#!/usr/bin/env node
// Live check of card pool-sell-share-across-wallets on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384), it is the /app.js of a written release
// list from this card's release on (packages/signpage/releases/release-<N>.json, N >= FIRST_RELEASE), so its bytes are
// a build of source whose tests ran; and in it, as minified:
//   - schema: the kit's pool.sell params take a share (share_bps) or an amount, exactly one
//     (`"pool.sell":e=>x(e)&&Object.hasOwn(e,"amount")!==Object.hasOwn(e,"share_bps")`);
//   - units: the sell's units come from the total of the device's own reads of every wallet (packages/signpage/src/
//     pool-sell.ts planPoolSell): a share of that total, all of it at 10,000, a typed amount as it is, and refused when
//     over it (`u=a.shareBps===void 0?a.amount:a.shareBps===1e4?t:t*BigInt(a.shareBps)/10000n;if(u<=0n||u>t)return`);
//   - legs: each wallet's sale runs as units, never a share (`{...a,amount:l.units,shareBps:void 0}`);
//   - rule: the Solana sell's rule refuses a share (`if(a.shareBps!==void 0)return X("amount")` right after its kind).
// That the plan reads each wallet on two providers, sells smallest first, and that each sale is today's complete one
// (its quote check, owed record before its send, rent back) is held by the card's tests (packages/signpage/test/
// pool-sell.test.ts "pool-sell-share-across-wallets") and its devnet run (pool-sell-share-across-wallets.md).
// The recorded answers are facts() over a tree's packages/signpage/index.html and public/app.js, or SIGN_HOST's own
// page. This file reaches no package code (the import check holds it). The PR's own build runs judge(read, { ledger:
// false }) in scripts/ci/bundle-checks.mjs, since it is cut as a release only after its merge.
// After: sign
//   node scripts/live-checks/pool-sell-share-across-wallets.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "pool-sell-share-across-wallets";
export const SIGN = "https://confidential.unrealized.trade";
/** This card's release: the first list cut after release-109 (main's newest when this card merged origin/main
 *  4ae503b1) can hold its build. */
export const FIRST_RELEASE = 110;
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
const Q = "[`\"']";
const SCHEMA = new RegExp(`"pool\\.sell":(${N})=>${N}\\(\\1\\)&&Object\\.hasOwn\\(\\1,${Q}amount${Q}\\)!==Object\\.hasOwn\\(\\1,${Q}share_bps${Q}\\)`);
const UNITS = new RegExp(`(${N})=(${N})\\.shareBps===void 0\\?\\2\\.amount:\\2\\.shareBps===1e4\\?(${N}):\\3\\*BigInt\\(\\2\\.shareBps\\)\\/10000n;if\\(\\1<=0n\\|\\|\\1>\\3\\)return`);
const LEGS = new RegExp(`\\{\\.\\.\\.${N},amount:${N}\\.units,shareBps:void 0\\}`);
const RULE = new RegExp(`if\\((${N})\\.kind!==${Q}pool\\.sell${Q}\\|\\|\\1\\.chain!==${Q}solana${Q}\\)return (${N})\\(${Q}kind${Q}\\);if\\(\\1\\.shareBps!==void 0\\)return \\2\\(${Q}amount${Q}\\)`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and whether the bundle holds each mark. */
export function facts(index, js) {
  return { index, sha384: sha384(js), schema: SCHEMA.test(js), units: UNITS.test(js), legs: LEGS.test(js), rule: RULE.test(js) };
}

/** The verdict on an answer { index, sha384, schema, units, legs, rule }, against the release lists' /app.js files
 *  (none with `ledger: false`). */
export function judge(a, { ledger = true, released = ledger ? releasedAppJs() : null } = {}) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (released && !released.has(a?.sha384)) bad("SIGN_HOST's served /app.js is the /app.js of no release list of this card's on: bytes no tested source built");
  if (a?.schema !== true) bad("the page takes no pool.sell share (share_bps or an amount, exactly one)");
  if (a?.units !== true) bad("the sell's units are not the device's own total of every wallet's holding (a share of it, or an amount refused over it)");
  if (a?.legs !== true) bad("the wallets' sales do not each run as units");
  if (a?.rule !== true) bad("the Solana sell's rule does not refuse a share: a share could reach signed bytes");
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
