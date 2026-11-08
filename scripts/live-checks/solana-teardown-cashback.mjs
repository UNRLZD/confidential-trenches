#!/usr/bin/env node
// Live check of card solana-teardown-cashback on SIGN_HOST (https://confidential.unrealized.trade). The signing
// page's pool sell runs the kit's teardown after a full sell (packages/signpage/src/pool-sell.ts rentBack, checked by
// rules/pool.ts checkSolanaTeardownFrames, the kit's checkSolanaTeardown), so the teardown a device signs is the one
// SIGN_HOST serves. What it proves, and only that: the served /app.js is the one index.html pins (its sha384), and its
// text carries the cashback claims and their rules, each found by a mark of the bundle's shape (the minifier renames,
// never restructures them; packages/kit/src/checks/solana/checks.ts and src/trade/solana/build.ts):
//   - PumpSwap's claim_cashback and pump's claim_cashback_v2, by their discriminators (their on-chain IDLs);
//   - the plan's read of the volume account's own claim account, refused when it is not that account;
//   - the refusal of a volume close before its claim in the same frame;
//   - the refusal of a close of the claim's WSOL account anywhere but right after its claim, to the wallet;
//   - the simulation's claim paid in full: the volume account's claim account left with exactly what it held less the
//     claim;
//   - a claim that does not simulate planned around (review L2 of 5592a871, M1 and L1 of 11c963f9): only when SIM alone
//     refuses a plan that claims, the claims' frame errs on both providers and every frame before it is clean on both
//     (one provider's error stays a refusal, read again); the failing program's claim alone goes off when both
//     providers name it, at most twice; the other closes still go, the owed volume account stays open, and the pool
//     sell's rent back ends "owed", so W stays owed and a later pass claims it.
// It does not prove those lines run or refuse: that is the kit's tests at the released commit
// (test/solana-teardown-cashback.test.ts, a mainnet wallet owed 12,742,862 recorded on two RPCs, and planted frames
// that claim to another account), and that the served files are that commit's build is signpage-release's.
// After: sign
//   node scripts/live-checks/solana-teardown-cashback.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "solana-teardown-cashback";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "PumpSwap's claim_cashback": /\[37,58,35,126,190,53,228,197\]/,
  "pump's claim_cashback_v2": /\[122,243,204,65,94,116,29,55\]/,
  "the volume account's own claim account read, any other refused": new RegExp(`!==(${I})\\.mint\\|\\|${I}\\.encode\\(${I}\\.subarray\\(32,64\\)\\)!==\\1\\.uva\\)throw Error\\(\`\\$\\{${I}\\} is not the volume account's \\$\\{\\1\\.mint\\} account\`\\)`),
  "a volume close before its claim in the frame refused": new RegExp(`if\\((${I})&&!${I}\\.includes\\(\\1\\)\\)\\{${I}\\.push\\(\`\\$\\{${I}\\}: close of \\$\\{${I}\\} before its claim in this frame\`\\)`),
  "the claim's WSOL closed only right after its claim, to the wallet": new RegExp(`${I}\\[1\\]\\?\\.key!==(${I})\\|\\|${I}\\[2\\]\\?\\.key!==\\1\\|\\|!${I}\\[0\\]\\?\\.writable\\|\\|!${I}\\[1\\]\\?\\.writable\\|\\|!${I}\\(${I}\\[${I}-1\\],(${I})\\)\\)\\{${I}\\.push\\(\`\\$\\{${I}\\}: close of \\$\\{\\2\\.to\\} not right after its claim\`\\)`),
  "a refusal planned around only when SIM alone refuses a claim": new RegExp(`if\\((${I})\\.ok\\|\\|!\\1\\.plan\\|\\|\\1\\.plan\\.claim\\.length===0\\|\\|\\1\\.results\\.some\\((${I})=>!\\2\\.ok&&\\2\\.id!==\`SIM\`\\)`),
  "planned around only when the claims' frame errs on both providers and every frame before it is clean on both": new RegExp(`if\\(!(${I})\\.slice\\(0,-1\\)\\.every\\(\\(\\[(${I}),(${I})\\]\\)=>(${I})\\(\\2\\)&&\\4\\(\\3\\)\\)\\)return null;let\\[(${I}),(${I})\\]=\\1\\.at\\(-1\\);if\\(!(${I})\\(\\5\\)\\|\\|!\\7\\(\\6\\)\\)return null;`),
  "the failing program's claim alone off when both providers name it": new RegExp(`(${I})=typeof (${I})==\`string\`&&\\2===(${I})&&(${I})\\.includes\\(\\2\\)\\?\\2:null,(${I})=\`its claim did not simulate on either provider: A \\$\\{${I}\\(${I}\\)\\}, B \\$\\{${I}\\(${I}\\)\\}\`,(${I})=\\{\\.\\.\\.${I}\\};for\\(let (${I}) of \\1===null\\?\\4:\\[\\1\\]\\)\\6\\[\\7\\]=\\5;`),
  "a teardown refused at SIM planned again at most twice, one more program's claims off each time": new RegExp(`for\\(let (${I})=0;\\1<2;\\1\\+\\+\\)\\{let (${I})=${I}\\((${I})\\.verdict,\\3\\.wires,\\3\\.reads\\.simulations,\\3\\.reads\\.unclaimed\\);if\\(\\2===null\\|\\|Object\\.keys\\(\\2\\)\\.length===Object\\.keys\\(\\3\\.reads\\.unclaimed\\?\\?\\{\\}\\)\\.length\\)return \\3;\\3=await ${I}\\(${I}\\(${I},${I},\\2\\),\\2\\)\\}`),
  "W left owed when the teardown keeps an unclaimed account": new RegExp(`return ${I}\\((${I})\\.ok\\.unclaimed===void 0\\?\`kept\`:\`owed\`,\\1\\.ok\\.keep\\.map`),
  // card sol-w-sweep, the review of c1fd2d20 (2a): the record is dropped only when both RPCs read W empty, so an owed
  // end (and every other) keeps it
  "an owed rent back keeps its record": /\{try\{if\(([\w$]+)===`nothing`\)return await [\w$]+\.owed\?\.drop\(/,
  "the claim paid in full in the simulation": new RegExp(`if\\((${I})!==(${I})\\.fromAmount-\\2\\.amount&&${I}\\.push\\(\`\\$\\{${I}\\}: \\$\\{\\2\\.from\\} holds \\$\\{\\1\\?\\?\`nothing read\`\\} after the claim \\(want \\$\\{\\2\\.fromAmount-\\2\\.amount\\}\\)\`\\)`),
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
