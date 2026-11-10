#!/usr/bin/env node
// Live check of card sol-settle-failed-is-not-unspent on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), it is a released build from
// release-111 on (a packages/signpage/releases/release-<N>.json, N >= 111, names its sha384 for SIGN_HOST), and in it, as
// minified, the Solana pool send's read-back (src/pool-buy.ts sendAndSettle, the buy's and each withdraw part's):
//   - settle: the note's settle that throws is not known yet (null), never "unspent", and it is asked with the slots it
//     is handed;
//   - verdict: not_landed only when the settle RETURNS unspent, asked at each RPC's slot of the read that saw the
//     blockhash past (pastAt: one getEpochInfo at finalized per RPC, the height and the slot one bank's); a settle that
//     throws decides nothing, and past the reads the answer is "sent" (a withdraw keeps its owed send);
//   - hosts: the page's buy and withdraw settles hand those slots to the wallet's solanaSettleSpent (minSlots);
//   - none of the old shape: no settle's throw read as {kind: "unspent"} anywhere in the bundle.
// What each does is held by the card's tests (packages/signpage/test/pool-buy.test.ts: the four unlanded paths with a
// settle that throws, C3's seats from before the spend, each ending's time; test/pool-withdraw.test.ts and
// test/pool-testnet.test.ts: the withdraw's 502 with the settle throwing, its owed send kept and carried). The recorded
// answers are facts() over a tree's packages/signpage/index.html and public/app.js (build-app.mjs), or SIGN_HOST's own
// page. A build of release-110 or earlier carries the old shape, and the release ledger tells a release-111-or-later
// build from any other. This file reaches no package code (the import check holds it). The PR's own build runs
// judge(read, { ledger: false }) in scripts/ci/bundle-checks.mjs, since it is cut as a release only after its merge.
// After: sign
//   node scripts/live-checks/sol-settle-failed-is-not-unspent.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "sol-settle-failed-is-not-unspent";
export const SIGN = "https://confidential.unrealized.trade";
/** The first release whose pool send holds the rule: release-110 (73b79695) is the last without it. */
export const FIXED_FROM = 111;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const esc = (n) => n.replace(/\$/g, "\\$");
const count = (js, re) => (js.match(new RegExp(re.source, "g")) ?? []).length;

// the settle: `spent = async (minSlots) => { if (settled) return true; const s = await h.settle(noteId, minSlots).then(
// spent?, () => null); settled = s === true; return s }`
const SETTLE = new RegExp(String.raw`(?<g>${I})=async (?<m>${I})=>\{if\((?<h>${I})\)return!0;let (?<r>${I})=await ${I}\.settle\(${I}\.noteId,\k<m>\)\.then\((?<x>${I})=>\k<x>\.kind===\`spent\`,\(\)=>null\);return \k<h>=\k<r>===!0,\k<r>\}`);
// the verdict, in the unlanded reads: `past = await pastAt(rpcs, last); s = await spent(past ?? undefined); if (s) {...}
// else if (s === false && past !== null) return not_landed`
const VERDICT = (g) => new RegExp(String.raw`let (?<p>${I})=await (?<pa>${I})\(${I}\.rpcs,${I}\),(?<s>${I})=await ${esc(g)}\(\k<p>\?\?void 0\);if\(\k<s>\)\{let (?<a>${I})=await ${I}\(${I},${I}\);if\(\k<a>\)return \k<a>\}else if\(\k<s>===!1&&\k<p>!==null\)return\{stage:\`not_landed\`,txs:${I}\}`);
// pastAt: each RPC's finalized slot once both are past, one getEpochInfo bank each, else null
const PAST_AT = (pa) => new RegExp(String.raw`async function ${esc(pa)}\((${I}),(${I})\)\{try\{let (${I})=await Promise\.all\(\1\.map\(async (${I})=>\{let (${I})=await \4\(\`getEpochInfo\`,\[\{commitment:\`finalized\`\}\]\);return (${I})\(\5\?\.blockHeight\)>\2\?\6\(\5\?\.absoluteSlot\):null\}\)\);return \3\[0\]!==null&&\3\[1\]!==null\?\[\3\[0\],\3\[1\]\]:null\}catch\{return null\}\}`);
// the page's buy and withdraw settles: solanaSettleSpent({ ..., noteId, program: pin.program, minSlots, rpcs: ... })
const HOSTS = new RegExp(String.raw`noteId:${I},program:${I}\.program,minSlots:${I},rpcs:${I}\(\)`);
// the old shape: a settle's throw read as unspent
const OLD = /\.catch\(\(\)=>\(\{kind:`unspent`\}\)\)/;

/** What the check keeps of SIGN_HOST's page: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const g = SETTLE.exec(js)?.groups;
  const v = g ? VERDICT(g.g).exec(js)?.groups : undefined;
  return {
    index,
    sha384: sha384(js),
    settle: Boolean(g),
    verdict: Boolean(v) && PAST_AT(v.pa).test(js),
    hosts: count(js, HOSTS) >= 2,
    old: OLD.test(js),
  };
}

/** SIGN_HOST's /app.js sha384 in every release list from FIXED_FROM on (packages/signpage/releases/). */
export function fixedReleases(dir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages/signpage/releases")) {
  const out = new Set();
  for (const f of readdirSync(dir)) {
    const n = /^release-(\d+)\.json$/.exec(f)?.[1];
    if (n === undefined || Number(n) < FIXED_FROM) continue;
    const list = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    for (const x of list.hosts?.SIGN_HOST?.files ?? []) if (x.path === "/app.js") out.add(x.sha384);
  }
  return out;
}

/** The verdict on an answer { index, sha384, settle, verdict, hosts, old }, against the release lists' bundles `fixed`
 *  (none with `ledger: false`). */
export function judge(a, { ledger = true, fixed = ledger ? fixedReleases() : null } = {}) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.settle !== true) bad("a pool send's settle that throws is not held as not known yet, or is not asked with the slots it is handed");
  if (a?.verdict !== true) bad("a pool send answers not_landed on a settle that did not return unspent at the slots of the read that saw its blockhash past: a landed buy or withdraw part may be told it never happened");
  if (a?.hosts !== true) bad("the page's buy and withdraw settles do not hand the verdict's slots to solanaSettleSpent: seats from before the spend may answer unspent");
  if (a?.old !== false) bad("the bundle still reads a settle's throw as unspent");
  if (fixed && !fixed.has(a?.sha384)) bad(`SIGN_HOST's /app.js is not a release-${FIXED_FROM}-or-later build: ${a?.sha384 ?? "not read"}`);
  return { ok: !lines.length, lines };
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
