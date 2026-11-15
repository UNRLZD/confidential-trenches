#!/usr/bin/env node
// Live check of card dlmm-pair-never-priced-at-zero: on SIGN_HOST (https://confidential.unrealized.trade) a Meteora DLMM
// pair whose read list misses the bin arrays the agreed reads walk is read again on those arrays, never priced at 0.
// The reference read plans a scanned pair's list from one provider's first read of the pair alone; a first read whose
// active_id is moved by one bin array (+70 bins on a buy, -70 on a sell) planned bin arrays the agreed reads never walk,
// the walk found no out, `?? 0n` priced the pair at 0 and another venue won the pick (the re-check of PR 801's
// probe: "no pool pays out" at 0.1, 1 and 5 SOL, 15 Nov). What the read does is held by packages/kit/test/
// solana-dlmm.test.ts (card dlmm-pair-never-priced-at-zero); this check holds that SIGN_HOST serves that code. It passes
// only when SIGN_HOST's served /app.js is the one its index.html pins (its sha384), and in it, as minified, each exactly
// once:
//   - plan (packages/kit/src/trade/solana/pool.ts judgeDlmm): the bin arrays a swap from each provider's agreed active
//     bin names; any not in the read, "replan" with both sets (a read already re-planned: a disagreement, "the DLMM
//     pair's active bin left the bin arrays read");
//   - walk: each provider's read walks only its own arrays (`new Map(own[k].map(ix => [ix, read.get(ix) ?? null]))`);
//   - relook (lookScanned): a "replan" verdict is read again on its list and judged; a second "replan" is a
//     disagreement ("the <kind>'s read list moved twice").
// After: sign
// Bundle: read sign
//   node scripts/live-checks/dlmm-pair-never-priced-at-zero.mjs [--local] [--record <file>]
//   PASS exit 0, FAIL 1, error 2. --local judges this tree's SIGN_HOST build (signBuilt) in SIGN_HOST's place; --record
//   writes what the run read, which dlmm-pair-never-priced-at-zero.test.mjs replays. Reads only: no key, no transaction.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

export const KEY = "dlmm-pair-never-priced-at-zero";
export const SIGN = "https://confidential.unrealized.trade";

const N = "[\\w$]+";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const esc = (s) => s.replace(/[$]/g, "\\$");

/** judgeDlmm's plan as minified: `let p=Ad(r.side,f.solIsX),m=[Od(s[0].activeId,p),Od(s[1].activeId,p)];if(!m.every(e=>
 *  e.every(e=>n.includes(e)))){if(o)return{kind:\`bad\`,why:\`the DLMM pair's active bin left the bin arrays read\`};let
 *  n=[...new Set([...m[0],...m[1]])],i=[...t.slice(0,rp.arrays),...n.map(t=>ud(e,t))];return{kind:\`replan\`,list:i,
 *  judge:(t,a)=>ap(e,i,n,r,t,a,!0)}}`. Group 1 is the own-arrays name the walk must use. */
const PLAN = new RegExp(
  `let (${N})=${N}\\(${N}\\.side,${N}\\.solIsX\\),(${N})=\\[(${N})\\((${N})\\[0\\]\\.activeId,\\1\\),\\3\\(\\4\\[1\\]\\.activeId,\\1\\)\\];` +
    `if\\(!\\2\\.every\\((${N})=>\\5\\.every\\((${N})=>(${N})\\.includes\\(\\6\\)\\)\\)\\)\\{if\\(${N}\\)return\\{kind:\`bad\`,why:\`the DLMM pair's active bin left the bin arrays read\`\\};` +
    `let (${N})=\\[\\.\\.\\.new Set\\(\\[\\.\\.\\.\\2\\[0\\],\\.\\.\\.\\2\\[1\\]\\]\\)\\],(${N})=\\[\\.\\.\\.${N}\\.slice\\(0,${N}\\.arrays\\),\\.\\.\\.\\8\\.map\\(${N}=>${N}\\(${N},${N}\\)\\)\\];` +
    `return\\{kind:\`replan\`,list:\\9,judge:\\((${N}),(${N})\\)=>(${N})\\(${N},\\9,\\8,${N},\\10,\\11,!0\\)\\}\\}`,
  "g",
);
/** The relook as minified: `l.kind===\`replan\`&&([o,s]=await a(l.list),l=l.judge(o,s),l.kind===\`replan\`&&(l={kind:\`bad\`,
 *  why:\`the ${n.name}'s read list moved twice\`}))`. */
const RELOOK = new RegExp(
  `(${N})\\.kind===\`replan\`&&\\(\\[(${N}),(${N})\\]=await ${N}\\(\\1\\.list\\),\\1=\\1\\.judge\\(\\2,\\3\\),\\1\\.kind===\`replan\`&&\\(\\1=\\{kind:\`bad\`,why:\`the \\$\\{${N}\\.name\\}'s read list moved twice\`\\}\\)\\)`,
  "g",
);
/** The walk's arrays for one read, from the plan's own-arrays name: `new Map(m[e].map(e=>[e,n.get(e)??null]))`. */
const walkOf = (own) => new RegExp(`new Map\\(${esc(own)}\\[(${N})\\]\\.map\\((${N})=>\\[\\2,(${N})\\.get\\(\\2\\)\\?\\?null\\]\\)\\)`, "g");

/** What the check keeps of SIGN_HOST's build: its pin and sha384, and how often each part is found. */
export function pageFacts(index, js) {
  const plans = [...js.matchAll(PLAN)];
  const own = plans.length === 1 ? plans[0][2] : null;
  return {
    pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null,
    sha384: sha384(js),
    plan: plans.length,
    walk: own === null ? 0 : [...js.matchAll(walkOf(own))].length,
    relook: [...js.matchAll(RELOOK)].length,
  };
}

/** SIGN_HOST's index and /app.js through `fetchFn`: { from, page }. */
export async function readBundle(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`SIGN_HOST ${p}: HTTP ${r.status}`);
    return r.text();
  };
  return { from: SIGN, page: pageFacts(await get("/"), await get("/app.js")) };
}

/** The verdict on { page }: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = run?.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(p?.plan === 1, `[SIGN_HOST] a DLMM read whose bin arrays miss the ones either agreed active bin walks is planned again from both (plan found ${p?.plan ?? 0} times, want 1)`);
  say(p?.walk === 1, `[SIGN_HOST] each provider's read walks only the bin arrays a swap from its own active bin names (walk found ${p?.walk ?? 0} times, want 1)`);
  say(p?.relook === 1, `[SIGN_HOST] a re-planned pair is read again and judged, and a second miss is a disagreement, never a 0 (relook found ${p?.relook ?? 0} times, want 1)`);
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** SIGN_HOST's index and /app.js, or this tree's build with `local`. */
export async function read(fetchFn = fetch, { local = false } = {}) {
  const page = local ? pageFacts(readFileSync(path.join(signBuilt(), "index.html"), "utf8"), readFileSync(path.join(signBuilt(), "public/app.js"), "utf8")) : (await readBundle(fetchFn)).page;
  return { readAt: new Date().toISOString(), from: local ? "local build" : SIGN, page };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = await read(fetch, { local: a.includes("--local") });
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(verdict === "PASS" ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
