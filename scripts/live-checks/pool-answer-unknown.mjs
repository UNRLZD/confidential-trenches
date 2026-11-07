#!/usr/bin/env node
// Live check of card pool-answer-unknown on SIGN_HOST (https://sign.confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - deposit (pool-deposit.ts): a read back after U's send that does not check out answers "sent" with the sends of
//     notes still open, never failed (an app told failed may ask the user to deposit again);
//   - deposit: a mark one RPC holds and the other not yet is pending, never built again or stuck;
//   - vault buy (trade.ts): a provider read that fails past its retry before any signature answers down, at the pick
//     (before the kit runs) and in place of the kit's plain failed, never over its price check.
// What each does is held by the card's tests (packages/signpage/test/pool-deposit.test.ts and trade.test.ts, each
// "card pool-answer-unknown"); the recorded answers are facts() over each tree's packages/signpage/index.html and
// public/app.js (this file reaches no package code: the import check holds it).
//   node scripts/live-checks/pool-answer-unknown.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-answer-unknown";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The minified marks of each piece, as the bundle spells them. */
const Q = "[`\"']";
const UNREAD = new RegExp(`[\\w$]+\\.code===${Q}failed${Q}&&[\\w$]+\\(\\)\\.length\\?\\{stage:${Q}sent${Q},txs:[\\w$]+\\(\\)\\}`);
const ONE = new RegExp(`===${Q}one${Q}\\?${Q}pending${Q}`);
const PICK = new RegExp(`[\\w$]+ instanceof [\\w$]+\\?${Q}down${Q}:${Q}failed${Q}`);
const RECORD = new RegExp(`[\\w$]+&&![\\w$]+&&[\\w$]+===${Q}failed${Q}\\?${Q}down${Q}:[\\w$]+`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), unread: UNREAD.test(js), one: ONE.test(js), pick: PICK.test(js), record: RECORD.test(js) };
}

/** The verdict on an answer { index, sha384, unread, one, pick, record }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.unread !== true) bad("a pool deposit whose read back does not check out after its send is answered failed: the app shows a deposit that may land as failed");
  if (a?.one !== true) bad("a pool deposit whose mark only one RPC holds is built again or stuck: a deposit that landed may be asked again");
  if (a?.pick !== true) bad("a vault buy or sell whose provider read fails at the pick is answered failed: the app takes an outage as a no");
  if (a?.record !== true) bad("a vault buy whose blockhash, mint or build read fails before signing is answered failed: the app takes an outage as a no");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
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
