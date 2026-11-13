#!/usr/bin/env node
// Live check of card fresh-money-spendable-at-once on SIGN_HOST (https://confidential.unrealized.trade). Reads only:
// nothing is signed or sent.
// The fault (owner, 12 Nov 08:48Z): money that had just landed in the Solana pool (a sell's money back, a buy's change)
// could not be spent until the next 60 s round: the proof queue made a newest-root proof for a deposit's own note only,
// and a withdraw of any other fresh note waited on the pool's time for the next boundary. What this proves, and only
// that: the served /app.js is the one index.html pins (its sha384), and it carries, each found by a mark of the bundle's
// shape (packages/wallet/src/pool/queue.ts, packages/signpage/src/pool-withdraw.ts, packages/signpage/src/pool-buy.ts):
//   - the queue proves a note of any kind that landed this epoch on the newest root, once that cut holds its leaf;
//   - a withdraw part proves such a note on the newest root, with no boundary wait;
//   - a buy spends the smallest chunk that pays, and of one chunk a proof on the epoch root before one on the newest root;
//   - a root index is named only below the tree size both RPCs agreed on.
// It does not prove a tap's timing: that is packages/wallet/test/pool-queue.test.ts, packages/signpage/test/
// pool-withdraw.test.ts and pool-buy.test.ts at the released commit, and the mainnet copy's run. The check runs on a
// pull request's own build too (scripts/ci/bundle-checks.mjs).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/fresh-money-spendable-at-once.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "fresh-money-spendable-at-once";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const Q = "[`'\"]"; // a string's quote, as the minifier picks it
const s = (w) => `${Q}${w}${Q}`;
export const MARKS = Object.freeze({
  "the queue proves a note of any kind that landed this epoch on the newest root": new RegExp(
    `instanceof Error\\?${I}\\.failed\\.push\\(\\{noteId:${I}\\.id,error:${I}\\(${I}\\)(?:,reason:${s("network")})?\\}\\):${I}\\.leaf\\.leafIndex<BigInt\\(${I}\\.stateTree\\.size\\)&&${I}\\.push\\(\\{n:${I},trees:${I},root:${s("newest")}\\}\\)`,
  ),
  "a withdraw part proves a fresh note on the newest root with no boundary wait": new RegExp(
    `=${s("epoch")};for\\(let ${I}=!1;!${I}\\(${I}\\);\\)\\{let ${I}=await ${I}\\(${I}\\+1n,\\{newest:!0\\}\\);if\\(${I}\\(${I}\\)\\)\\{${I}=${I},${I}=${s("newest")}`,
  ),
  "a buy spends the smallest chunk that pays, and of one chunk a proof on the epoch root before one on the newest root": new RegExp(
    `\\.sort\\(\\((${I}),(${I})\\)=>\\1\\.chunk<\\2\\.chunk\\?-1:[^;]{0,40}\\1\\.root===\\2\\.root\\?0:\\1\\.root===${s("epoch")}\\?-1:1\\)`,
  ),
  "a root index is named only below the tree size both RPCs agreed on": new RegExp(
    `Math\\.min\\(\\(${I}\\.data\\.length-${I}\\)\\/${I},${I}-${I}\\*${I}\\);for\\(let ${I}=${I}-1;${I}>=0;${I}--\\)`,
  ),
});

/** What the check keeps of the bundle: the index, the served bundle's sha384, the marks it carries. */
export function facts(index, js) {
  return { index, sha384: sha384(js), carries: Object.fromEntries(Object.entries(MARKS).map(([k, re]) => [k, re.test(js)])) };
}

export async function readBundle(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
}

/** The verdict on a bundle's facts: BAD for no pin, another bundle than the pinned one, or any mark missing. */
export function judgeBundle(b) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(b?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== b.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(MARKS)) {
    if (b?.carries?.[k] !== true) bad(`the served bundle does not carry: ${k}`);
    else lines.push(`ok ${k}`);
  }
  const ok = !lines.some((l) => l.startsWith("BAD"));
  return { ok, verdict: ok ? "PASS" : "FAIL", lines };
}

export const read = readBundle;
export const judge = judgeBundle;

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
    console.log(`${v.verdict} ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
