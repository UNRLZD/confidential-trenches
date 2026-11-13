#!/usr/bin/env node
// Live check of card max-is-what-you-hold-after-a-trade on SIGN_HOST (https://confidential.unrealized.trade).
// What it holds, signed out, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as
// minified:
//   - tip: state.pools' Max (src/pools.ts withSolanaRent) prices each Solana tap at the tip the buy pays, mainnet's
//     (the kit's solanaPoolBuyTip(`mainnet`, k), SOLANA_POOL_JITO_TIP), by default, never at the proof's tip cap;
//   - spend: the wallet's solanaTapSpendOf asks that tip for the set's count of pieces (at most 4) and gives 0 for a tip
//     over a piece's cap (packages/wallet/src/pool/balances.ts);
//   - small: a proof pass counts as too_small only a note above 0 under the least piece (packages/wallet/src/pool/
//     queue.ts), so a whole release's change of 0 is never named as money that cannot move.
// What each does is held by the card's tests (packages/signpage/test/pool-buy-dry.test.ts, packages/wallet/test/
// pool-balances.test.ts and pool-queue-pass-reasons.test.ts, each from the owner's account as read 13 Nov 18:23Z); the
// signed-in part (Max on the owner's account after a trade) is the owner's next trade.
// The recorded answers are facts() over a built tree's index.html and app.js (good: this card's branch, built with
// packages/signpage/scripts/build-app.mjs --out) and over SIGN_HOST as served before the card (bad).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/max-is-what-you-hold-after-a-trade.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "max-is-what-you-hold-after-a-trade";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const ID = "[\\w$]+";
// withSolanaRent: its tip defaults to a function of k that asks the kit's tip on mainnet, and each Solana entry's spend
// is made with three arguments (rent, venue, that tip)
const TIP = new RegExp(`(${ID})=(${ID})=>${ID}\\(\`mainnet\`,\\2\\);function ${ID}\\(${ID},${ID},${ID},${ID}=\\1\\)\\{return Object\\.freeze\\(${ID}\\.map\\((${ID})=>\\3\\.chain===\`solana\`\\?${ID}\\(\\3\\.id,\\3\\.scope,${ID}\\(${ID},${ID},${ID}\\)\\):\\3\\)\\)\\}`);
// solanaTapSpendOf: the tap's tip for min(pieces, 4), refused when not a bigint, and no spend over the least cap
const SPEND = new RegExp(`if\\((${ID})=(${ID})\\(Math\\.min\\((${ID})\\.length,4\\)\\),typeof \\1!=\`bigint\`\\|\\|\\1<0n\\)throw Error\\(\`the tap's tip is not a bigint at least 0\`\\);if\\(\\1>${ID}\\)return 0n`);
// the pass's small count: an UNSPENT note above 0 whose chunk is none
const SMALL = new RegExp(`state===\`UNSPENT\`&&(${ID})\\.leaf!==void 0&&\\1\\.leaf\\.value>0n&&${ID}\\(${ID},\\1\\.leaf\\.value\\)===null`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), tip: TIP.test(js), spend: SPEND.test(js), small: SMALL.test(js) };
}

/** The verdict on an answer { index, sha384, tip, spend, small }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.tip !== true) bad("state.pools' Max is not priced at the mainnet buy's own tip: it counts the tip cap, 900,000 lamports a tap the buy keeps");
  if (a?.spend !== true) bad("the tap spend does not ask the tap's tip for its pieces: Max is not what the buy's pick funds");
  if (a?.small !== true) bad("a proof pass counts a change of 0 as too_small: the console names money that is not there");
  if (lines.length === 0) lines.push("ok  Max is priced at the tip the buy pays, and too_small counts only money");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  return facts(index, await get("/app.js"));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${arg("--answer") ? `answer ${arg("--answer")}` : SIGN})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
