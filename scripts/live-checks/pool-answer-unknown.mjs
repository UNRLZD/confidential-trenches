#!/usr/bin/env node
// Live check of card pool-answer-unknown on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - deposit (pool-deposit.ts): a read back after U's send that does not check out answers "sent" with the sends of
//     notes still open, never failed (an app told failed may ask the user to deposit again);
//   - deposit: a mark one RPC holds and the other not yet is pending, never built again or stuck;
//   - deposit: a rung that landed counts whether or not an RPC names its tx, and every end that answers part_filled
//     (a mark on one RPC, a second note left short, a refusal of the read back or of the kit, any other fault) answers
//     it on that count with the landed list, never failed or down; the pass with no ask answers not_funded only when
//     that count is 0;
//   - the kit's pacing (send.ts): a slot calls the provider it was handed, and the paced wrapper hands it the
//     outermost wrapper it was given (never the bare provider under it), so the page's fault watch runs under it; a
//     paced provider called inside its own queue's slot is that slot's call, never queued behind it;
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
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The minified marks of each piece, as the bundle spells them. */
const Q = "[`\"']";
const UNREAD = new RegExp(`[\\w$]+\\.code===${Q}failed${Q}&&[\\w$]+\\(\\)\\.length\\?\\{stage:${Q}sent${Q},txs:[\\w$]+\\(\\)\\}`);
const ONE = new RegExp(`===${Q}one${Q}\\?${Q}pending${Q}`);
const PICK = new RegExp(`[\\w$]+ instanceof [\\w$]+\\?${Q}down${Q}:${Q}failed${Q}`);
const RECORD = new RegExp(`[\\w$]+&&![\\w$]+&&[\\w$]+===${Q}failed${Q}\\?${Q}down${Q}:[\\w$]+`);
// the landed count: bumped for each of the ask's notes landed beside the tx list (named or not); every part_filled
// after it on that count with that list, and the no-ask pass's not_funded only at a count of 0
const LANDED_AT = new RegExp(`([\\w$]+)\\.push\\(\\{chain:${Q}solana${Q},hash:[\\w$]+\\}\\),[\\w$]+&&([\\w$]+)\\+\\+,[\\w$]+\\.landed\\?\\.\\(`);
const esc = (s) => s.replace(/\$/g, "\\$");
const PART = (l) => `\\{stage:${Q}part_filled${Q},txs:${esc(l)}\\}`;
const LANDED_PATHS = [
  // a mark on one RPC
  (c, l) => `===${Q}one${Q}\\)return ${esc(c)}\\?${PART(l)}:\\{stage:${Q}not_landed${Q},txs:\\[\\]\\}`,
  // a second note left short
  (c, l) => `continue\\}return ${esc(c)}\\?${PART(l)}:await `,
  // the read back's refusal
  (c, l) => `\\{stage:${Q}not_landed${Q},txs:[\\w$]+\\}:${esc(c)}\\?${PART(l)}:`,
  // the kit's refusal
  (c, l) => ` instanceof [\\w$]+\\)return ${esc(c)}\\?${PART(l)}:[\\w$]+\\(\\)\\.length\\?\\{stage:${Q}sent${Q}`,
  // any other fault
  (c, l) => `if\\(${esc(c)}\\)return${PART(l)};`,
  // the pass with no ask
  (c) => `&&[\\w$]+\\.length===0&&${esc(c)}===0\\?\\{error:${Q}not_funded${Q}\\}`,
];
function landedHeld(js) {
  const m = LANDED_AT.exec(js);
  if (!m) return false;
  const after = js.slice(m.index, m.index + 20000);
  return LANDED_PATHS.every((p) => new RegExp(p(m[2], m[1])).test(after));
}
// the slot's call: the provider rpcSlot was handed (its first parameter, never another name taken from it), its queue
// marked while it runs; and the paced wrapper's own call inside its slot, which hands rpcSlot the wrapper it was given
// (its own first parameter), never the bare provider under it. No other function's header between either one's
// header and its mark.
const NOFN = "(?:(?!function )[\\s\\S])";
const SLOT = new RegExp(`function [\\w$]+\\(([\\w$]+),[\\w$]+,[\\w$]+\\)\\{${NOFN}{0,1500}?let ([\\w$]+)=([\\w$]+);\\3=[\\w$]+;try\\{return \\1\\([\\w$]+,[\\w$]+\\)\\}finally\\{\\3=\\2,`);
const INSLOT = new RegExp(`function [\\w$]+\\(([\\w$]+),[\\w$]+=[\\w$]+\\)\\{${NOFN}{0,200}?\\{if\\([\\w$]+===[\\w$]+\\)return \\1\\([\\w$]+,[\\w$]+\\);let [\\w$]+=[\\w$]+\\(\\1,[\\w$]+,[\\w$]+\\);return [\\w$]+\\.wait\\?`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), unread: UNREAD.test(js), one: ONE.test(js), pick: PICK.test(js), record: RECORD.test(js), landed: landedHeld(js), paced: SLOT.test(js) && INSLOT.test(js) };
}

/** The verdict on an answer { index, sha384, unread, one, pick, record, landed, paced }. */
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
  if (a?.landed !== true) bad("a pool deposit rung that landed with no tx named is left out of the answer: the app shows money that arrived as failed");
  if (a?.paced !== true) bad("the kit's pacing calls the bare provider past the page's fault watch: a vault buy's provider outage answers failed");
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
