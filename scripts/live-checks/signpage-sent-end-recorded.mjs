#!/usr/bin/env node
// Live check of card signpage-sent-end-recorded on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// signed out, moving no money and signing nothing: the served /app.js is the one index.html pins (its sha384), and in
// it, as minified:
//   - sent: a Solana pool buy's op is written at "sent" under the request's id with its transaction, each tx's blockhash,
//     last height and notes kept beside it on the device (src/positions.ts recordPoolBuy: a sent with no transaction
//     writes nothing);
//   - asked: the page asks that write at the run's "sent" answer, with the answer's transactions and what the run told
//     for each (src/pool-testnet.ts recordedBuy);
//   - round: the run tells sendAt (the signed bytes' blockhash, its last height, its notes) and sent only for the buy's
//     own transaction, never while it sends a first round's release (src/pool-buy.ts sendAndSettle's `round`);
//   - legs: each sent tx is marked a leg, an end keeps the mark on the legs alone, and src/trade-fill.ts sums a buy's
//     marked legs, never a piece's release;
//   - end: the end is written onto that same op only while it reads "sent", never over an end, never a refusal over
//     sent, and an end with no transactions keeps sent's (recordPoolBuy);
//   - settle: a reload ends a Solana buy op left at sent from its own txs, each read on both RPCs (src/positions.ts
//     settleSentBuys over trade.ts txEnd), any unknown left as it is, an op past its blockhash's life (90 s and 13 s of
//     finality) read at the slow pace, with the end the page would have shown: the op's stage from its legs' by
//     pool-buy.ts legsStage;
//   - lock: the page holds a buy's trade lock (trade.ts tradeLock) while its run lives, and the settle leaves an op whose
//     lock another tab holds;
//   - marks: each leg's end read as the run reads it: landed, by pool-buy.ts lateBuyEnd over the note's mark and whose
//     spend it is; failed on chain, not_landed when the note or a piece's note reads SPENT, not known while one is
//     RESERVED, else refused;
//   - two: a RESERVED note is freed (the follow's not_landed) only once the lower of both RPCs' finalized heights is past
//     its last height (../../wallet/src/pool/solana-restore.ts solanaSettleReserved), never on one RPC's word.
// What each does is held by packages/signpage/test/positions.test.ts, pool-buy.test.ts, trade-fill.test.ts and
// pool-testnet.test.ts (the card's tests and their mutants); a real sent-then-landed buy is the owner's next trade.
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
const esc = (n) => n.replace(/\$/g, "\\$");
// recordPoolBuy's sent put: the op at "sent" under the request's id, with its transaction and each tx's fields beside it
// (device-only), kept only when every tx has them
const SENT = new RegExp(`if\\(${ID}===\`sent\`\\)\\{if\\(${ID}\\.length===0\\|\\|\`error\`in ${ID}\\)return;let ${ID}=${ID}\\.result\\.txs\\.map\\(${ID}=>${ID}\\(${ID}\\)\\),${ID}=${ID}\\.every\\(${ID}=>${ID}!==null\\)\\?${ID}\\.map\\(\\(${ID},${ID}\\)=>\\(\\{\\.\\.\\.${ID},\\.\\.\\.${ID}\\[${ID}\\]\\}\\)\\):${ID};await ${ID}\\.put\\(\`ops\`,${ID},\\{kind:\`buy\`,stage:${ID},txs:${ID},`);
// recordedBuy: the sent answer's transactions handed to that write, each with what its run told (pool-buy.ts sendAt)
const ASKED = new RegExp(`${ID}\\.result\\.stage===\`sent\`&&${ID}\\(${ID}\\.result\\.txs\\.map\\(`);
const AT = new RegExp(`txs:${ID}\\.map\\(${ID}=>\\(\\{\\.\\.\\.${ID},\\.\\.\\.${ID}\\.get\\(${ID}\\.hash\\)\\}\\)\\)\\}\\};for\\(let ${ID} of ${ID}\\)${ID}\\.delete\\(${ID}\\.hash\\)`);
// sendAndSettle: sendAt (from the signed bytes, with the notes) and sent, each guarded by the same `!round` and the
// sent guard, sendAt first
const ROUND = new RegExp(`!(${ID})&&!(${ID})&&(${ID})\\[0\\]&&\\3\\[1\\]\\)try\\{${ID}\\.sendAt\\?\\.\\(${ID},${ID}\\(${ID}\\)\\.message\\.blockhash,${ID},\\{id:${ID}\\.noteId,attempt:${ID}\\.attempt,pieces:${ID}\\.map\\(${ID}=>${ID}\\.r\\.noteId\\),program:${ID}\\.program,feePayer:${ID}\\.feePayer,wallet:${ID}\\.wallet\\.address,nullifier:BigInt\\(${ID}\\.publicSignals\\[1\\]\\)\\.toString\\(\\),context:${ID}\\.binding\\.context\\.toString\\(\\)\\}\\)\\}catch\\{\\}if\\(!\\1&&!\\2&&\\3\\[0\\]&&\\3\\[1\\]&&\\(\\2=!0,`);
// recordPoolBuy: the legs the sent op marked kept on an end's txs, every sent tx marked; trade-fill: a buy's marked legs
// read (none marked: its first)
const REC_LEGS = new RegExp(`let ${ID}=new Set\\(${ID}&&Array\\.isArray\\(${ID}\\.txs\\)\\?${ID}\\.txs\\.flatMap\\(${ID}=>${ID}\\?\\.leg===!0&&typeof ${ID}\\.hash==\`string\`\\?\\[${ID}\\.hash\\]:\\[\\]\\):\\[\\]\\),${ID}=\`error\`in ${ID}\\?\\[\\]:${ID}\\.result\\.txs\\.map\\(${ID}=>\\(\\{chain:${ID}\\.chain,hash:${ID}\\.hash,\\.\\.\\.${ID}===\`sent\`\\|\\|${ID}\\.has\\(${ID}\\.hash\\)\\?\\{leg:!0\\}:\\{\\}\\}\\)\\)`);
const FILL_LEGS = new RegExp(`let (${ID})=(${ID})\\.txs\\.filter\\(${ID}=>${ID}\\.leg===!0\\),${ID}=\\2\\.kind===\`buy\`\\?\\(\\1\\.length>0\\?\\1:\\2\\.txs\\.slice\\(0,1\\)\\)\\.map\\(${ID}=>${ID}\\.hash\\):\\2\\.txs\\.map\\(${ID}=>${ID}\\.hash\\)`);
// recordPoolBuy: an op already there is written over only while it is this buy's "sent", and never by a refusal; an
// end with no transactions keeps sent's
const END = new RegExp(`${ID}\\.kind===\`buy\`&&${ID}\\.stage===\`sent\`;if\\(${ID}!==void 0&&\\(!${ID}\\|\\|\`error\`in ${ID}\\)\\)return;[^;]*;if\\(${ID}===\`sent\`\\?${ID}:!${ID}\\.has\\(${ID}\\)\\)return;let ${ID}=[^;]*,${ID}=${ID}\\.length===0&&${ID}&&Array\\.isArray\\(${ID}\\.txs\\)\\?${ID}\\.txs:${ID};`);
// settleSentBuys: a Solana buy op at sent, every tx with its fields; past its first read's blockhash life read at the
// slow pace (60 s), another tab's run (its trade lock held) left; each tx read on both RPCs (txEnd), any unknown left;
// each leg's end by legEnd, any not known left; the op's stage legsStage's, written only while the op still reads sent
const SETTLE = new RegExp(`if\\(${ID}\\?\\.kind!==\`buy\`\\|\\|${ID}\\.chain!==\`solana\`\\|\\|${ID}\\.stage!==\`sent\`\\|\\|!Array\\.isArray\\(${ID}\\.txs\\)\\|\\|${ID}\\.txs\\.length===0\\)continue;.{0,200}let ${ID}=${ID}\\(\\),${ID}=${ID}\\.reads\\?\\.get\\(${ID}\\);if\\(${ID}!==void 0&&${ID}-${ID}\\.first>=(${ID})&&${ID}-${ID}\\.last<6e4(?:\\|\\|[^;]{0,160})?\\)continue;.{0,160}\\{sig:${ID}\\.hash,lvbh:${ID}\\[${ID}\\]\\.lvbh,blockhash:${ID}\\[${ID}\\]\\.blockhash\\}\\)\\)\\);if\\(${ID}\\.some\\(${ID}=>${ID}===\`unknown\`\\)\\)continue;let ${ID}=await Promise\\.all\\(${ID}\\.map\\(\\(${ID},${ID}\\)=>(${ID})\\(${ID},${ID}\\[${ID}\\]\\.note,${ID}\\)\\.catch\\(\\(\\)=>null\\)\\)\\);if\\(${ID}\\.some\\(${ID}=>${ID}===null\\)\\)continue;let (${ID})=(${ID})\\(${ID}\\),${ID}=!1;.{0,80}\\?\\.kind!==\`buy\`\\|\\|${ID}\\.stage!==\`sent\`\\?${ID}:\\(${ID}=!0,\\{\\.\\.\\.${ID}\\.reduce\\(.{0,60}\\),stage:(${ID})\\}\\)`);
// the slow pace's start: POOL_BLOCKHASH_LIFE_MS (90 s) and 13 s of finality
const PAST = (c) => new RegExp(`(?:^|[^\\w$])${esc(c)}=(${ID})\\+13e3`);
const LIFE = (c) => new RegExp(`(?:^|[^\\w$])${esc(c)}=9e4[,;]`);
// pool-buy.ts legsStage: every refused, refused; else not_landed
const LEGS = (f) => new RegExp(`function ${esc(f)}\\(${ID}\\)\\{let ${ID}=${ID}\\.filter\\(${ID}=>${ID}!==null\\);.{0,240}\\.every\\(${ID}=>${ID}===\`refused\`\\)\\?\`refused\`:\`not_landed\`\\}`);
// trade.ts tradeLock, and the page's hold of it for the run (released at its records, or at once with no run)
const TRADE_LOCK = (f) => new RegExp(`(?:^|[^\\w$])${esc(f)}=${ID}=>\`ct-wallet/trade/\\$\\{${ID}\\}\``);
const HOLD = (f) => new RegExp(`${ID}&&${ID}\\.request\\(${esc(f)}\\(${ID}\\.id\\),\\{mode:\`exclusive\`\\},\\(\\)=>${ID}\\)\\.catch\\(\\(\\)=>\\{\\}\\)`);
// legEnd: the run's marks (lateBuyEnd for a landed leg; a failed one's notes SPENT, RESERVED or not read)
const LEG_END = (f) => new RegExp(`async function ${esc(f)}\\((${ID}),(${ID}),(${ID})\\)\\{if\\(\\1===\`not_landed\`\\)return\`not_landed\`;if\\(\\1===\`filled\`\\)return ${ID}\\(await \\3\\.note\\(\\2\\.id\\),\\2\\.attempt,\\(\\)=>\\3\\.owner\\(\\2\\)\\);let (${ID})=await Promise\\.all\\(\\[\\2\\.id,\\.\\.\\.\\2\\.pieces\\]\\.map\\(async ${ID}=>\\(await \\3\\.note\\(${ID}\\)\\)\\?\\.state\\)\\);return \\4\\.some\\(${ID}=>${ID}===\`SPENT\`\\)\\?\`not_landed\`:\\4\\.some\\(${ID}=>${ID}===void 0\\|\\|${ID}===\`RESERVED\`\\)\\?null:\`refused\`\\}`);
// solanaSettleReserved: the lower of both RPCs' finalized heights
const TWO = new RegExp(`BigInt\\(Math\\.min\\(${ID}\\[0\\]\\.height,${ID}\\[1\\]\\.height\\)\\)`);

// the settle's lock probe and its legs' reads, each read on its own so a near miss of one names that mark alone
const PROBE = new RegExp(`\\.reads\\?\\.get\\(${ID}\\);if\\([^;]{0,80}?${ID}\\.locks&&await ${ID}\\.locks\\.request\\((${ID})\\(${ID}\\),\\{mode:\`exclusive\`,ifAvailable:!0\\},async ${ID}=>${ID}===null\\)\\)continue;`);
const LEG_CALL = new RegExp(`let ${ID}=await Promise\\.all\\(${ID}\\.map\\(\\(${ID},${ID}\\)=>(${ID})\\(${ID},${ID}\\[${ID}\\]\\.note,${ID}\\)\\.catch\\(\\(\\)=>null\\)\\)\\);`);

const settleOf = (js) => {
  const m = SETTLE.exec(js);
  const life = m === null ? null : PAST(m[1]).exec(js);
  const p = PROBE.exec(js);
  const c = LEG_CALL.exec(js);
  return {
    settle: m !== null && m[3] === m[5] && LEGS(m[4]).test(js) && life !== null && LIFE(life[1]).test(js),
    lock: p !== null && TRADE_LOCK(p[1]).test(js) && HOLD(p[1]).test(js),
    marks: c !== null && LEG_END(c[1]).test(js),
  };
};

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), sent: SENT.test(js), asked: ASKED.test(js) && AT.test(js), round: ROUND.test(js), legs: REC_LEGS.test(js) && FILL_LEGS.test(js), end: END.test(js), ...settleOf(js), two: TWO.test(js) };
}

/** The verdict on an answer { index, sha384, sent, asked, round, legs, end, settle, lock, marks, two }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.sent !== true) bad("sent: no op is written at sent under the request's id: a buy whose end is not known has no record");
  if (a?.asked !== true) bad("asked: the page asks no op write at the run's sent answer");
  if (a?.round !== true) bad("round: a first round's release may be told sent: the op could name a release, read filled");
  if (a?.legs !== true) bad("legs: a split tap's legs are not marked and summed: its figures are one leg's");
  if (a?.end !== true) bad("end: the end is not written onto the sent op alone (an end written over, or sent's txs dropped)");
  if (a?.settle !== true) bad("settle: no reload ends a sent buy op from its txs on both RPCs as the page would: a closed page's buy stays sent");
  if (a?.lock !== true) bad("lock: another tab's live run is not held by its trade lock: a settle may end it under the run");
  if (a?.marks !== true) bad("marks: a reload's end does not read the notes' spent and owner marks as the run does");
  if (a?.two !== true) bad("two: a reserved note is freed on one RPC's height, so not_landed is not both RPCs' word");
  if (lines.length === 0) lines.push("ok  a pool buy's op reads sent with its legs from its send, then its one end, as the run would give it, on both RPCs' word");
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
