#!/usr/bin/env node
// Live check of card sol-w-sweep on SIGN_HOST (https://confidential.unrealized.trade). The signing page's pool sell
// (packages/signpage/src/pool-sell.ts, checked by rules/pool.ts) empties a fresh Solana wallet W into the user's pool
// balance, so what SIGN_HOST serves is what a device signs. What it proves, and only that: the served /app.js is the one
// index.html pins (its sha384), and its text carries the card's rules, each found by a mark of the bundle's shape (the
// minifier renames, never restructures them):
//   - a full sell deposits W's surplus with its proceeds (a reserve under 0), a partial sell leaves it on W;
//   - a full sell keeps on W only what lifts the rent back's sweep to the floor once W's token account is closed (the
//     floor, the sweep's fee, mark and a page's opening on each tree, one frame's fee, less rent(165)), and the cost of
//     each claim owed by W's volume accounts as the sell reads them, or the venue's own on a cashback coin; rent(0) only
//     when that is refused or would leave the sell's note under the floor; the reserve cap leaves out what the sweep
//     carries on;
//   - the sell's rule: a reserve under 0 or over the cap only on a full sell, priced exactly from the device's reads;
//   - a sweep that leaves W exactly what each owed cashback claim costs later (rent(0), a frame's fee, the claim
//     account's rent), at most two, checked by the sweep's rule;
//   - the sweep goes on when every account kept is a volume account owed cashback only (the kit's plan marks them),
//     W ending "owed" (its record kept) when the rest is under the floor.
// It does not prove those lines run: that is the signing page's tests at the released commit (test/pool-sell.test.ts,
// rules-pool.test.ts), and that the served files are that commit's build is signpage-release's.
//   node scripts/live-checks/sol-w-sweep.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sol-w-sweep";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "a full sell deposits W's surplus": new RegExp(`(${I})=(${I})\\.fee\\+\\2\\.made\\+\\2\\.rents\\+\\2\\.after-\\2\\.lamports,${I}=\\1>0n\\|\\|!\\2\\.keeps\\?\\1:0n`),
  "a full sell keeps what lifts the sweep to the floor, a page's opening on each tree and each owed claim's cost": new RegExp(`function ${I}\\((${I}),(${I})=0\\)\\{let (${I})=${I}\\(\\1\\)>1000000n\\?${I}\\(\\1\\):${I},(${I})=(${I})\\(\\1,88\\),${I}=\\3\\+\\((${I})\\+\\5\\(\\1,${I}\\)\\+2n\\*\\4\\)\\+\\6-\\5\\(\\1,165\\)\\+${I}\\(\\1,\\2\\)`),
  "the full sell's keep counts W's volume accounts owed a claim, on either RPC's read": new RegExp(`\\.map\\(async (${I})=>(${I})\\.cashback&&\\1===${I}\\?!0:\\(await ${I}\\(${I},${I}=>${I}\\(${I},${I}\\(${I}\\.address,\\1\\),\`confirmed\`\\)\\)\\)\\.some\\((${I})=>!\\(\`none\`in \\3\\)&&\\3\\.owner===\\1&&${I}\\(\\1,\\3\\.data\\)>0n\\)\\)\\)\\.then\\((${I})=>\\4\\.filter\\(Boolean\\)\\.length\\)\\]\\),${I}=${I}\\?${I}\\(${I},${I}\\):${I}\\(${I},${I}\\)`),
  "rent(0) only when a full sell's keep is refused or leaves its note under the floor": new RegExp(`function (${I})\\((${I})\\)\\{if\\(!\\2\\.keeps&&\\2\\.base!==void 0\\)\\{let (${I})=\\1\\(\\{\\.\\.\\.\\2,base:void 0\\}\\);return\`refused\`in \\3\\|\\|\\3\\.value<\\(\\2\\.floor\\?\\?0n\\)\\?\\1\\(\\{\\.\\.\\.\\2,after:\\2\\.base,swept:0n,base:void 0\\}\\):\\3\\}`),
  "the sell prices a full sell with that fallback, at the sweep's floor": new RegExp(`\\.\\.\\.(${I})\\?\\{\\}:\\{swept:(${I})-(${I}),base:\\3,floor:${I}\\}`),
  "the reserve cap leaves out what the sweep carries on": new RegExp(`(${I})-\\((${I})\\.swept\\?\\?0n\\)>${I}\\|\\|\\1>=\\2\\.minOut`),
  "the sell's rule prices a reserve under 0 or over the cap exactly, full sells only": new RegExp(`let (${I})=0n;if\\((${I})<0n\\|\\|\\2>(${I})\\)\\{let (${I})=${I};if\\(\\4===void 0\\|\\|\\4\\.full!==!0\\|\\|[^{}]*?\\|\\|\\4\\.owed>2\\)return ${I}\\(\`reserve\`\\);let (${I})=\\4\\.fee\\+\\4\\.made\\+${I}\\(\\4\\.rent,${I},\\4\\.held,\\4\\.next\\)-\\4\\.lamports,(${I})=${I}\\(\\4\\.rent,\\4\\.owed\\),(${I})=${I}\\(\\4\\.rent,0\\);if\\(\\2===\\5\\+\\6\\)\\1=\\6-\\7;else if\\(\\2!==\\5\\+\\7\\)return ${I}\\(\`reserve\`\\)\\}if\\(\\2-\\1>\\3\\)return ${I}\\(\`reserve\`\\)`),
  "an owed claim's cost: rent(0), a frame's fee and the claim account's rent": new RegExp(`(${I})=\\((${I}),(${I})\\)=>\\3===0\\?0n:${I}\\(\\2,0\\)\\+BigInt\\(\\3\\)\\*\\(${I}\\+${I}\\(\\2,165\\)\\)`),
  "the sweep's rule leaves exactly that, for at most two": new RegExp(`\\|\\|(${I})<0\\|\\|\\1>2\\?${I}\\(\`sweep_reads\`\\):${I}\\+5000n\\+${I}\\(${I},${I},${I}\\)\\+${I}\\(${I},\\1\\)===`),
  "the sweep goes on when only owed-cashback accounts are kept": new RegExp(`function ${I}\\((${I})\\)\\{return \\1\\.length>2\\|\\|\\1\\.some\\((${I})=>\\2\\.cashback!==!0\\)\\?null:\\1\\.length\\}`),
  "W owed, not dropped, when the rest is under the floor": new RegExp(`\\{end:(${I})>0\\?\`owed\`:\`floor\`,`),
  "the plan marks a volume account owed only cashback": new RegExp(`\\.\\.\\.(${I})\\.other\\.length===0&&\\1\\.amount>0n\\?\\{cashback:!0\\}:\\{\\}`),
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
