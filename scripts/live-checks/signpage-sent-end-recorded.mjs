#!/usr/bin/env node
// Live check of card signpage-sent-end-recorded on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// signed out, moving no money and signing nothing: the served /app.js is the one index.html pins (its sha384), and in
// it, as minified:
//   - sent: a Solana pool buy's op is written at "sent" under the request's id with its transaction, each tx's blockhash
//     and last height kept beside it on the device (src/positions.ts recordPoolBuy: a sent with no transaction writes
//     nothing);
//   - asked: the page asks that write at the run's "sent" answer, with the answer's transactions and the blockhash and
//     last height the run told for each (src/pool-testnet.ts recordedBuy; src/pool-buy.ts sendAt, from the signed bytes);
//   - end: the end is written onto that same op only while it reads "sent", never over an end, never a refusal over
//     sent, and an end with no transactions keeps sent's (recordPoolBuy);
//   - settle: a reload ends a Solana buy op left at sent from its own txs, each read on both RPCs (src/positions.ts
//     settleSentBuys over trade.ts txEnd), any unknown left as it is, with the end the page would have shown: each tx's
//     end as the run reads it (failed on both: refused) and the op's stage from them by pool-buy.ts legsStage;
//   - two: a RESERVED note is freed (the follow's not_landed) only once the lower of both RPCs' finalized heights is past
//     its last height (../../wallet/src/pool/solana-restore.ts solanaSettleReserved), never on one RPC's word.
// What each does is held by packages/signpage/test/positions.test.ts (the card's tests and their mutants); a real
// sent-then-landed buy is the owner's next trade.
// The recorded answers are facts() over a built tree's index.html and app.js (good: this card's branch, built with
// packages/signpage/scripts/build-app.mjs --out; bad: main 2d870021c's sources, built the same way).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/signpage-sent-end-recorded.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-sent-end-recorded";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const ID = "[\\w$]+";
// recordPoolBuy's sent put: the op at "sent" under the request's id, with its transaction and each tx's blockhash and
// last height beside it (device-only), kept only when every tx has them
const SENT = new RegExp(`if\\(${ID}===\`sent\`\\)\\{if\\(${ID}\\.length===0\\|\\|\`error\`in ${ID}\\)return;let ${ID}=${ID}\\.result\\.txs\\.map\\(${ID}=>${ID}\\(${ID}\\)\\),${ID}=${ID}\\.every\\(${ID}=>${ID}!==null\\)\\?${ID}\\.map\\(\\(${ID},${ID}\\)=>\\(\\{\\.\\.\\.${ID},\\.\\.\\.${ID}\\[${ID}\\]\\}\\)\\):${ID};await ${ID}\\.put\\(\`ops\`,${ID},\\{kind:\`buy\`,stage:${ID},txs:${ID},`);
// recordedBuy: the sent answer's transactions handed to that write, each with the blockhash and last height its run told
// (pool-buy.ts sendAt, called with the signature from the signed bytes' own blockhash)
const ASKED = new RegExp(`${ID}\\.result\\.stage===\`sent\`&&${ID}\\(${ID}\\.result\\.txs\\.map\\(`);
const AT = new RegExp(`txs:${ID}\\.map\\(${ID}=>\\(\\{\\.\\.\\.${ID},\\.\\.\\.${ID}\\.get\\(${ID}\\.hash\\)\\}\\)\\)\\}\\};for\\(let ${ID} of ${ID}\\)${ID}\\.delete\\(${ID}\\.hash\\)`);
const TOLD = new RegExp(`${ID}\\.sendAt\\?\\.\\(${ID},${ID}\\(${ID}\\)\\.message\\.blockhash,${ID}\\)`);
// settleSentBuys: a Solana buy op at sent, every tx with its fields, ended from both RPCs' reads (txEnd), any unknown
// left, the end written by noted() only while the op still reads sent
const SETTLE = new RegExp(`if\\(${ID}\\?\\.kind!==\`buy\`\\|\\|${ID}\\.chain!==\`solana\`\\|\\|${ID}\\.stage!==\`sent\`\\|\\|!Array\\.isArray\\(${ID}\\.txs\\)\\|\\|${ID}\\.txs\\.length===0\\)continue;.{0,240}\\{sig:${ID}\\.hash,lvbh:${ID}\\[${ID}\\]\\.lvbh,blockhash:${ID}\\[${ID}\\]\\.blockhash\\}\\)\\)\\);if\\(${ID}\\.some\\(${ID}=>${ID}===\`unknown\`\\)\\)continue;let (${ID})=(${ID})\\(${ID}\\.map\\(${ID}=>(${ID})\\[${ID}\\]\\)\\),${ID}=!1;.{0,80}\\?\\.kind!==\`buy\`\\|\\|${ID}\\.stage!==\`sent\`\\?${ID}:\\(${ID}=!0,\\{\\.\\.\\.${ID}\\.reduce\\(.{0,60}\\),stage:(${ID})\\}\\)`);
// the tx ends' stages the settle maps through (failed on both RPCs: refused, as the run answers it) and the legs rule
// it takes the op's stage from (pool-buy.ts legsStage: every refused, refused; else not_landed), each where it is defined
const esc = (n) => n.replace(/\$/g, "\\$");
const LEG_MAP = (m) => new RegExp(`(?:^|[^\\w$])${esc(m)}=\\{filled:\`filled\`,failed:\`refused\`,not_landed:\`not_landed\`\\}`);
const LEGS = (f) => new RegExp(`function ${esc(f)}\\(${ID}\\)\\{let ${ID}=${ID}\\.filter\\(${ID}=>${ID}!==null\\);.{0,240}\\.every\\(${ID}=>${ID}===\`refused\`\\)\\?\`refused\`:\`not_landed\`\\}`);
const settleOf = (js) => {
  const m = SETTLE.exec(js);
  return m !== null && m[1] === m[4] && LEG_MAP(m[3]).test(js) && LEGS(m[2]).test(js);
};
// recordPoolBuy: an op already there is written over only while it is this buy's "sent", and never by a refusal; an
// end with no transactions keeps sent's
const END = new RegExp(`${ID}\\.kind===\`buy\`&&${ID}\\.stage===\`sent\`;if\\(${ID}!==void 0&&\\(!${ID}\\|\\|\`error\`in ${ID}\\)\\)return;[^;]*;if\\(${ID}===\`sent\`\\?${ID}:!${ID}\\.has\\(${ID}\\)\\)return;let ${ID}=[^;]*,${ID}=${ID}\\.length===0&&${ID}&&Array\\.isArray\\(${ID}\\.txs\\)\\?${ID}\\.txs:${ID};`);
// solanaSettleReserved: the lower of both RPCs' finalized heights
const TWO = new RegExp(`BigInt\\(Math\\.min\\(${ID}\\[0\\]\\.height,${ID}\\[1\\]\\.height\\)\\)`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), sent: SENT.test(js), asked: ASKED.test(js) && AT.test(js) && TOLD.test(js), end: END.test(js), settle: settleOf(js), two: TWO.test(js) };
}

/** The verdict on an answer { index, sha384, sent, asked, end, settle, two }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.sent !== true) bad("sent: no op is written at sent under the request's id: a buy whose end is not known has no record");
  if (a?.asked !== true) bad("asked: the page asks no op write at the run's sent answer");
  if (a?.end !== true) bad("end: the end is not written onto the sent op alone (an end written over, or sent's txs dropped)");
  if (a?.settle !== true) bad("settle: no reload ends a sent buy op from its txs on both RPCs: a closed page's buy stays sent");
  if (a?.two !== true) bad("two: a reserved note is freed on one RPC's height, so not_landed is not both RPCs' word");
  if (lines.length === 0) lines.push("ok  a pool buy's op reads sent with its transaction from its send, then its one end, not_landed only on both RPCs' word");
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
