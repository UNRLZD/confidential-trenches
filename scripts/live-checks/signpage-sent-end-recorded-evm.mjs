#!/usr/bin/env node
// Live check of card signpage-sent-end-recorded-evm on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// signed out, moving no money and signing nothing: the served /app.js is the one index.html pins (its sha384), and in
// it, as minified:
//   - sent: a Base or Robinhood pool buy's op is written under the request's id at "sent", with no transaction until a
//     release is read, each leg's W beside it on the device, never over an op already there (src/pool-buy-evm.ts
//     runEvmPoolBuy);
//   - end: each leg's end is noted onto that op alone (evmBuyOpNoted through noteLeg): a leg's end is never written over
//     but a refusal on the helper's word;
//   - legs: once every leg has an end, the op's stage is the run's own rule over them (legsEnd);
//   - skip: the load's settle of trade ops (src/trade.ts settleTradeOps and tradeSettleDue) leaves a Base or Robinhood
//     op, so an EVM buy's sent op is never refused "failed" for having no transaction;
//   - carry: the carry pass ends a rest leg whose page died after the send (src/pool-carry-evm.ts, restRecordEnd) onto
//     the op its record names, and carries no W whose leg's end is not known yet;
//   - freed: the EVM RESERVED settle ends a rest leg whose release never landed not_landed, by its freed note's
//     nullifier (src/pool-testnet.ts settleEvmReserved, noteFreedRests);
//   - restore: a load's restore writes no trade/<chain>/<tx> op for a buy one of the device's own buy ops names
//     (src/pool-sell-evm.ts restoreEvmTrades), so a buy is one row.
// What each does is held by packages/signpage/test/pool-buy-evm.test.ts, pool-carry-evm.test.ts, trade.test.ts and
// restore-evm-trades.test.ts (the card's tests and their mutants); a real Base buy is the owner's next trade.
// The recorded answers are facts() over a built tree's index.html and app.js (good: this card's branch, built with
// packages/signpage/scripts/build-app.mjs --out; bad: main 58f22d390's sign sources, built the same way with --pkg).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/signpage-sent-end-recorded-evm.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-sent-end-recorded-evm";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const ID = "[\\w$]+";
const esc = (n) => n.replace(/\$/g, "\\$");
// runEvmPoolBuy: the request's op at sent (no tx, each leg's W, never over an op there), written before the sends: the
// posted flag and the sends follow it
const SENT = new RegExp(`if\\(${ID}!==void 0\\)\\{let (${ID})=\\{kind:\`buy\`,stage:\`sent\`,txs:\\[\\],created_ms:Number\\(${ID}\\(\\)\\),chain:${ID}\\.chain,token:${ID}\\(${ID}\\),legs:${ID}\\.map\\(${ID}=>\\(\\{w:${ID}\\(${ID}\\.kind===\`whole\`\\?${ID}\\.x\\.w:${ID}\\.leg\\.w\\)\\}\\)\\)\\};await ${ID}\\.ops\\(${ID},${ID}=>${ID}===void 0\\?\\1:void 0\\)\\.catch\\(\\(\\)=>\\{\\}\\)\\}${ID}=!0;let ${ID}=await Promise\\.all\\(`);
// noteLeg: a leg's end onto the request's op through evmBuyOpNoted
const NOTE_LEG = new RegExp(`(?:^|[^\\w$])(${ID})=\\((${ID}),(${ID}),(${ID}),(${ID})\\)=>\\2\\.ops===void 0\\?Promise\\.resolve\\(\\):\\2\\.ops\\(\\3,${ID}=>(${ID})\\(${ID},\\4,\\5,\\2\\.price\\?\\.\\(\\)\\?\\?null\\)\\)\\.catch\\(\\(\\)=>\\{\\}\\)`);
// evmBuyOpNoted: a leg's end never written over but a refusal by a chain's end; an end with no tx keeps sent's
const NOTED = (f) => new RegExp(`function ${esc(f)}\\(${ID},${ID},${ID},${ID}\\)\\{.{0,200}?let (${ID})=${ID}\\.legs\\[${ID}\\]\\?\\.end;if\\(\\1!==void 0&&\\(\\1\\.stage!==\`refused\`\\|\\|${ID}\\.stage===\`refused\`\\)\\)return;.{0,400}?txs:(${ID})\\.txs\\.length>0\\?\\2\\.txs:${ID}\\.txs\\?\\?\\[\\]`);
// watch: each end noted onto the op (ended) before W's holding leaves pending: filled, owed_back, both not_landed
const ENDED = (n) => new RegExp(`(?:^|[^\\w$])(${ID})=async (${ID})=>\\((${ID})!==null&&await ${esc(n)}\\(${ID},\\3\\.id,\\3\\.leg,\\2\\),\\{stage:\\2\\.stage,txs:\\2\\.txs\\}\\)`);
const FIRST_FILLED = (s) => new RegExp(`\\.end===\`filled\`\\)\\{let (${ID})=${ID}===null\\?null:await ${esc(s)}\\(\\{stage:\`filled\`,txs:${ID},out:[^;]{0,200}\\}\\);return await ${ID}\\.record\\(${ID}\\.w,\\{\\.\\.\\.${ID}\\.holding,state:\`filled\``);
// (owed_back by noteLeg itself, its return the literal evm-buy-end-carries-its-tx reads)
const FIRST_BACK = (n) => new RegExp(`(${ID})!==null&&await ${esc(n)}\\(${ID},\\1\\.id,\\1\\.leg,\\{stage:\`owed_back\`,txs:${ID}\\}\\),await ${ID}\\.record\\(${ID}\\.w,\\{\\.\\.\\.${ID}\\.holding,state:\`withdrawn\``);
const FIRST_NONE = (s) => new RegExp(`let (${ID})=await ${esc(s)}\\(\\{stage:\`not_landed\`,txs:\\[\\]\\}\\);return await ${ID}\\.unrecord\\(`, "g");
// evmBuyOpNoted: once every leg has an end, the op's stage is legsEnd's over them; a refusal stays on not_landed
const LEGS_CALL = new RegExp(`if\\(${ID}\\.some\\(${ID}=>${ID}\\.end===void 0\\)\\)return ${ID};let (${ID})=(${ID})\\(${ID}\\.map\\(${ID}=>${ID}\\.end\\)\\);if\\(${ID}\\.stage===\`refused\`&&\\1\\.stage===\`not_landed\`\\)return ${ID};`);
const LEGS_END = (f) => new RegExp(`function ${esc(f)}\\(${ID}\\)\\{let ${ID}=${ID}\\.flatMap\\(${ID}=>${ID}\\?\\.txs\\?\\?\\[\\]\\),${ID}=${ID}\\.map\\(${ID}=>${ID}\\?\\.stage\\?\\?\`sent\`\\);return ${ID}\\.every\\(${ID}=>${ID}===\`filled\`\\)\\?\\{stage:\`filled\`,txs:${ID}\\}:${ID}\\.some\\(${ID}=>${ID}===\`sent\`\\|\\|${ID}===\`signed\`\\)\\?\\{stage:\`sent\`,txs:${ID}\\}:${ID}\\.some\\(${ID}=>${ID}===\`filled\`\\|\\|${ID}===\`part_filled\`\\)\\?\\{stage:\`part_filled\`,txs:${ID}\\}:${ID}\\.some\\(${ID}=>${ID}===\`owed_back\`\\)\\?\\{stage:\`owed_back\`,txs:${ID}\\}:${ID}\\.some\\(${ID}=>${ID}===\`refused\`\\)\\?\\{stage:\`refused\`,txs:${ID}\\}:\\{stage:\`not_landed\`,txs:${ID}\\}\\}`);
// trade.ts evmChainOp, and its two uses: tradeSettleDue and settleTradeOps leave a Base or Robinhood op
const EVM_OP = new RegExp(`(?:^|[^\\w$])(${ID})=(${ID})=>\\2\\.chain===\`base\`\\|\\|\\2\\.chain===\`robinhood\`;`);
const DUE = (g) => new RegExp(`&&!${esc(g)}\\(${ID}\\)&&\\[\`pending\`,\`signed\`,\`sent\`\\]\\.includes\\(String\\(${ID}\\.stage\\)\\)`);
const SETTLE = (g) => new RegExp(`\\|\\|${esc(g)}\\(${ID}\\)\\|\\|!\\[\`pending\`,\`signed\`,\`sent\`\\]\\.includes\\(String\\(${ID}\\.stage\\)\\)`);
// carryEvmOwed: a drawn rest W's leg ended from its record (restRecordEnd) onto the op it names; W held while not known
const CARRY = new RegExp(`if\\((${ID})\\.rest\\)\\{let (${ID})=${ID}\\[\\1\\.w\\],(${ID})=${ID}\\(\\2\\),(${ID})=${ID}\\(\\1\\.release\\);if\\(\\3!==null&&\\4!==null&&${ID}\\.ops!==void 0\\)\\{let (${ID})=await (${ID})\\(${ID}\\.rpcs,\\1\\.w,\\2,\\4,${ID}\\.chain,${ID}\\(\\)\\)\\.catch\\(\\(\\)=>null\\);if\\(\\5===null&&typeof \\2\\.adapter==\`string\`\\)return\\[\\{w:\\1\\.w,end:\`pending\`\\}\\];if\\(${ID}\\.signal\\?\\.aborted\\)return\\[\\];\\5!==null&&await (${ID})\\(\\{ops:${ID}\\.ops\\},\\3\\.id,\\3\\.leg,\\5\\)\\}\\}`);
// restRecordEnd: a receipt agreed on both ends the leg; past the window, no receipt on either RPC is owed_back
const REST_END = (f) => new RegExp(`async function ${esc(f)}\\(${ID},${ID},${ID},${ID},${ID},${ID}\\)\\{.{0,900}?if\\((${ID})!==null\\)return \\1===\`ok\`\\?\\{stage:\`filled\`,txs:${ID},\\.\\.\\.${ID}\\}:\\{stage:\`owed_back\`,txs:${ID}\\};.{0,200}?return ${ID}===null\\|\\|${ID}<=${ID}\\+300000n\\?null:`);
// noteFreedRests, its wbuy key, and its call on the EVM RESERVED settle's freed notes (by their nullifiers)
const FREED = new RegExp(`async function (${ID})\\(${ID},${ID},${ID},${ID}\\)\\{let (${ID})=new Set\\(${ID}\\.map\\(String\\)\\);for\\(let (${ID}) of Object\\.values\\(${ID}\\(await ${ID}\\.get\\(\`meta\`,(${ID})\\)\\)\\)\\)\\{let (${ID})=${ID}\\(\\3\\);\\5!==null&&\\3\\.chain===${ID}&&typeof \\3\\.nullifier==\`string\`&&\\2\\.has\\(\\3\\.nullifier\\)&&await (${ID})\\(\\{ops:${ID}\\},\\5\\.id,\\5\\.leg,\\{stage:\`not_landed\`,txs:\\[\\]\\}\\)\\}\\}`);
const WBUY = (k) => new RegExp(`(?:^|[^\\w$])${esc(k)}=\`owed/wbuy-evm\``);
const FREED_CALL = (f) => new RegExp(`\\.freed\\.length>0\\)\\{let (${ID})=await ${ID}\\.store\\(\\);await ${esc(f)}\\(\\1,async\\((${ID}),(${ID})\\)=>void await \\1\\.update\\(\`ops\`,\\2,\\3\\),${ID},\\(await ${ID}\\.list\\(\\)\\)\\.filter\\(${ID}=>${ID}\\.freed\\.includes\\(${ID}\\.id\\)\\)\\.map\\(${ID}=>${ID}\\(${ID},${ID}\\.ref\\)\\.nullifierHash\\)\\)`);
// restoreEvmTrades: a buy op's txs, and a not-ended one's legs' Ws, each name a spend that gets no trade op
const RESTORE = new RegExp(`if\\(${ID}\\?\\.kind===\`buy\`&&${ID}\\.chain===${ID}\\.chain\\)\\{if\\(Array\\.isArray\\(${ID}\\.txs\\)\\)for\\(let ${ID} of ${ID}\\.txs\\)typeof ${ID}\\?\\.hash==\`string\`&&(${ID})\\.add\\(${ID}\\.hash\\.toLowerCase\\(\\)\\);if\\(\\(${ID}\\.stage===\`sent\`\\|\\|${ID}\\.stage===\`refused\`\\)&&Array\\.isArray\\(${ID}\\.legs\\)\\)for\\(let ${ID} of ${ID}\\.legs\\)typeof ${ID}\\?\\.w==\`string\`&&(${ID})\\.add\\(${ID}\\.w\\.toLowerCase\\(\\)\\)\\}\\}.{0,1200}?if\\(!\\1\\.has\\(${ID}\\.tx\\.toLowerCase\\(\\)\\)&&!\\2\\.has\\(${ID}\\.w\\.toLowerCase\\(\\)\\)\\)`);

const noteLegOf = (js) => NOTE_LEG.exec(js);
/** Each mark of the bundle, by name: true when its minified shape is there. */
export const MARKS = {
  sent: (js) => SENT.test(js),
  end: (js) => {
    const n = noteLegOf(js);
    if (n === null || !NOTED(n[6]).test(js)) return false;
    const e = ENDED(n[1]).exec(js);
    return e !== null && FIRST_FILLED(e[1]).test(js) && FIRST_BACK(n[1]).test(js) && (js.match(FIRST_NONE(e[1])) ?? []).length === 2;
  },
  legs: (js) => {
    const m = LEGS_CALL.exec(js);
    return m !== null && LEGS_END(m[2]).test(js);
  },
  skip: (js) => {
    const g = EVM_OP.exec(js);
    return g !== null && DUE(g[1]).test(js) && SETTLE(g[1]).test(js);
  },
  carry: (js) => {
    const c = CARRY.exec(js);
    const n = noteLegOf(js);
    return c !== null && n !== null && c[7] === n[1] && REST_END(c[6]).test(js);
  },
  freed: (js) => {
    const f = FREED.exec(js);
    const n = noteLegOf(js);
    return f !== null && n !== null && f[6] === n[1] && WBUY(f[4]).test(js) && FREED_CALL(f[1]).test(js);
  },
  restore: (js) => RESTORE.test(js),
};

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const out = { index, sha384: sha384(js) };
  for (const [k, m] of Object.entries(MARKS)) out[k] = typeof m === "function" ? m(js) : m.test(js);
  return out;
}

const WHY = {
  sent: "sent: no EVM buy op is written at sent under the request's id: a Base or Robinhood buy whose end is not known has no record",
  end: "end: a leg's end is not noted onto the request op alone (an end written over, or a second op)",
  legs: "legs: the op's stage is not the run's own legs rule (legsEnd) over every leg's end",
  skip: "skip: the load's trade settle refuses a Base or Robinhood op with no transaction (an EVM buy's sent op ends failed)",
  carry: "carry: no carry pass ends a rest leg whose page died: a multi-leg Base or Robinhood buy stays sent",
  freed: "freed: no settle ends a rest leg whose release never landed: a multi-leg Base or Robinhood buy stays sent",
  restore: "restore: a load's restore writes a trade op beside the buy's own op: two rows for one buy",
};

/** The verdict on an answer { index, sha384, ...marks }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const [k, why] of Object.entries(WHY)) if (a?.[k] !== true) bad(why);
  if (lines.length === 0) lines.push("ok  a Base or Robinhood pool buy's op reads sent from its send, then its one end by its legs, ended after a reload too");
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
