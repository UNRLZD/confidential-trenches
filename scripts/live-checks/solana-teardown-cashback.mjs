#!/usr/bin/env node
// Live check of card solana-teardown-cashback on SIGN_HOST (https://sign.confidential.unrealized.trade). The signing
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
//     claim.
// It does not prove those lines run or refuse: that is the kit's tests at the released commit
// (test/solana-teardown-cashback.test.ts, a mainnet wallet owed 12,742,862 recorded on two RPCs, and planted frames
// that claim to another account), and that the served files are that commit's build is signpage-release's.
//   node scripts/live-checks/solana-teardown-cashback.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "solana-teardown-cashback";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "PumpSwap's claim_cashback": /\[37,58,35,126,190,53,228,197\]/,
  "pump's claim_cashback_v2": /\[122,243,204,65,94,116,29,55\]/,
  "the volume account's own claim account read, any other refused": new RegExp(`!==(${I})\\.mint\\|\\|${I}\\.encode\\(${I}\\.subarray\\(32,64\\)\\)!==\\1\\.uva\\)throw Error\\(\`\\$\\{${I}\\} is not the volume account's \\$\\{\\1\\.mint\\} account\`\\)`),
  "a volume close before its claim in the frame refused": new RegExp(`if\\((${I})&&!${I}\\.includes\\(\\1\\)\\)\\{${I}\\.push\\(\`\\$\\{${I}\\}: close of \\$\\{${I}\\} before its claim in this frame\`\\)`),
  "the claim's WSOL closed only right after its claim, to the wallet": new RegExp(`${I}\\[1\\]\\?\\.key!==(${I})\\|\\|${I}\\[2\\]\\?\\.key!==\\1\\|\\|!${I}\\[0\\]\\?\\.writable\\|\\|!${I}\\[1\\]\\?\\.writable\\|\\|!${I}\\(${I}\\[${I}-1\\],(${I})\\)\\)\\{${I}\\.push\\(\`\\$\\{${I}\\}: close of \\$\\{\\2\\.to\\} not right after its claim\`\\)`),
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
