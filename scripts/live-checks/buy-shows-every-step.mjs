#!/usr/bin/env node
// Live check of card buy-shows-every-step on SIGN_HOST (https://confidential.unrealized.trade): a buy or a move from
// Cash says which step it is on, how long each took, its tx, and the exact error when one stops. The owner's buys of
// 15 Nov 15:17-15:20Z failed with nothing on the device saying where. Reads only: nothing is signed or sent. What it
// holds, from the served /app.js (the one index.html pins, its sha384), as minified (packages/signpage/src/trace.ts,
// cash-to-pool.ts, withdraw/handoff.ts, pool-deposit-follow.ts):
//   - trace: the `[ct-trace]` line, one JSON object to the console, its fields from the allowlist (the error the only
//     free text) with any secret-sized run in an error replaced;
//   - move: the move's own steps, the hand-off's proof start and end and the relay's send, the vault's payout, and a
//     failed move's why as its op's code (withdraw_<its end>);
//   - follow: each 1Click status read of the quote's deposit address, 1Click's first sight of the deposit, the money at
//     the one-time wallet, each pool deposit from it, a round that threw;
//   - tap: the buy's wait on the move, never ended by one read that throws or never answers, and its end said
//     (tap_unread; card cash-buy-waits-for-its-move: each read bounded on its own, the wait ending settled when the
//     move's money is in and nothing more lands or proves, its fixed wait_over clock gone).
// What each line carries and never carries is held by packages/signpage/test/buy-shows-every-step.test.ts, the tap's
// wait by test/tap-wait-bad-read.test.ts (red at 23eab91ab). The recorded answers are facts() over this card's build
// (packages/signpage/scripts/build-app.mjs --out, good) and over SIGN_HOST as served before the card (bad).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/buy-shows-every-step.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "buy-shows-every-step";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";

/** The tag's const (group 1), the line it writes, and the field allowlist with the error its only free text. */
const TAG = new RegExp(`(${N})=\`\\[ct-trace\\]\``);
const lineOf = (tag) => `\${${tag}} \${JSON.stringify(`;
const ALLOW = /\{tx:([\w$]+),address:\1,quote:\1,move:\1,status:([\w$]+),stage:\2,amount:\/\^\\d\{1,40\}\(\?:\\\.\\d\{1,30\}\)\?\$\/,error:null\}/;
const REDACT = "/\\d{30,}|[0-9a-fA-F]{64,}|[1-9A-HJ-NP-Za-km-z]{80,}/g";
const MOVE = ["`proof_start`", "`proof_done`", "`relay_sent`", "`vault_payout`", "`withdraw_failed`:`withdraw_${"];
const FOLLOW = ["(`status`,{address:", "(`intents`,{address:", "(`arrived`,{address:", "(`pool_deposit`,{address:", "(`follow`,{stage:`round_failed`,error:"];
const TAP = ["`tap_unread`", "with nothing more landing or proving", "the read of what one tap spends did not answer in ${"];

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const tag = TAG.exec(js);
  return {
    index,
    sha384: sha384(js),
    trace: tag !== null && js.includes(lineOf(tag[1])) && ALLOW.test(js) && js.includes(REDACT),
    move: MOVE.every((m) => js.includes(m)),
    follow: FOLLOW.every((m) => js.includes(m)),
    tap: TAP.every((m) => js.includes(m)),
  };
}

export const SAYS = Object.freeze({
  trace: "the signing page writes no [ct-trace] line from the allowlist: a buy that stops says nothing on the device, or a line could carry a field that is not public",
  move: "a move from Cash does not trace its proof, its relay and the vault's payout, or a failed move keeps no why in its record",
  follow: "the move's follow does not trace 1Click's status reads, the money at the one-time wallet and each pool deposit",
  tap: "the buy's wait on the move is ended by one bad read, or holds on one read, with nothing said",
});

/** The verdict on an answer { index, sha384, trace, move, follow, tap }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(SAYS)) if (a?.[k] !== true) bad(`${k}: ${SAYS[k]}`);
  if (lines.length === 0) lines.push("ok  a buy and a move from Cash write a [ct-trace] line per step, a failed move keeps why, and the tap's wait outlives one bad read");
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
