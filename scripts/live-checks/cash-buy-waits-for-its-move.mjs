#!/usr/bin/env node
// Live check of card cash-buy-waits-for-its-move on SIGN_HOST (https://confidential.unrealized.trade): a buy from Cash
// swaps once its money lands, however long the move takes. The owner's buy 2 of 15 Nov moved all of Cash into the
// Solana pool and never swapped: the tap waited a fixed 180 s from the tap, the move took about 117 s to its pool
// deposits, and the notes' proofs were not made by the 180 s mark, so the pool buy answered not_funded. Reads only:
// nothing is signed or sent. What it holds, from the served /app.js (the one index.html pins, its sha384), as minified
// (packages/signpage/src/cash-to-pool.ts, main.ts):
//   - wait: the tap's wait follows the move to its landing (the mover's landing, its line landed or stopped), then the
//     chain's landing notes and their proofs (proving, two idle reads end it, its line settled), with no fixed clock
//     from the tap (no "asked after N ms" line, no wait_over);
//   - stops: a part whose quote's deadline passed with nothing delivered stops the wait; an op with no part on its way
//     stops it at once;
//   - coming: a move counts as on its way until each part reaches the pool or stops, never dropped by a clock (the
//     build before it dropped it at 18e4 ms, so Max counted the money nowhere);
//   - wired: the page's tap deps give the mover's landing and the notes' proving read (INCOMING, making, HELD with no
//     ready proof; and, its chain's queue open, a landed UNSPENT note its piece rule proves, until the chain's next epoch
//     turn and the margin from the tap's first sight of it: an EVM note waits UNSPENT for its period's turn).
// What each does is held by packages/signpage/test/cash-buy-waits-for-its-move.test.ts (red at 9cf75cbda: the pool buy
// asked at the 180 s mark, not_funded). The recorded answers are facts() over this card's build
// (packages/signpage/scripts/build-app.mjs, good) and over SIGN_HOST as served before the card (bad).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/cash-buy-waits-for-its-move.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "cash-buy-waits-for-its-move";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";

/** The wait: the landing's line, then the proving loop's two idle reads, and its settled end. */
const LANDED = new RegExp(`stage:${N}\\.landed\\?\`landed\`:\`stopped\``);
const PROVING = new RegExp(`await ${N}\\.proving\\(${N},${N}\\)\\.catch\\(\\(\\)=>!1\\)\\?0:${N}\\+1,!\\(${N}>=2\\)`);
const SETTLED = "with nothing more landing or proving";
/** The fixed clock from the tap, as the build before the card wrote it. */
const CLOCK = ["asked after ${", "`wait_over`"];
const STOPS = ["the quote's deadline passed with nothing delivered", "no part of this move is on its way"];
/** coming: by each part's stop, never by its age. */
const COMING = new RegExp(`coming:(${N})=>${N}\\.filter\\((${N})=>\\2\\.chain===\\1&&\\2\\.reached===null\\)`);
const AGED = new RegExp(`coming:${N}=>${N}\\.filter\\(${N}=>${N}\\.chain===${N}&&${N}\\.now\\(\\)-${N}\\.since<=`);
const WIRED = new RegExp(`moved:${N}=>${N}\\(\\)\\.landing\\(${N}\\),proving:async\\((${N}),(${N})\\)=>[^]{0,400}?\\{chain:\\1,open:${N},seen:\\2,now:Date\\.now\\(\\)\\}`);
const NOTES = new RegExp(
  `(${N})\\.state===\`INCOMING\`\\|\\|${N}\\?\\.has\\(\\1\\.id\\)===!0\\|\\|\\1\\.state===\`HELD\`\\?${N}=!0:(${N})!==void 0&&\\2\\.open&&\\1\\.state===\`UNSPENT\`&&\\1\\.leaf!==void 0&&${N}\\((${N})\\[\\2\\.chain\\]\\.pieces,\\1\\.leaf\\.value\\)!==null&&[^;]{0,120}?\\2\\.now<\\2\\.seen\\.get\\(\\1\\.id\\)\\+\\3\\[\\2\\.chain\\]\\.epochMs\\+${N}`,
);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return {
    index,
    sha384: sha384(js),
    wait: LANDED.test(js) && PROVING.test(js) && js.includes(SETTLED) && CLOCK.every((m) => !js.includes(m)),
    stops: STOPS.every((m) => js.includes(m)),
    coming: COMING.test(js) && !AGED.test(js),
    wired: WIRED.test(js) && NOTES.test(js),
  };
}

export const SAYS = Object.freeze({
  wait: "the tap's wait for a move from Cash is a clock from the tap, not the move's landing and its notes' proofs: a slow move ends in not_funded with its money in the pool",
  stops: "a part past its quote's deadline with nothing delivered, or an op with no part on its way, does not stop the tap's wait",
  coming: "a move on its way is dropped from what is coming by its age: past it, its money counts nowhere and a second tap may move it again",
  wired: "the page's tap gives no move landing or notes' proving read, or that read drops a landed note waiting for its queue's epoch turn: the wait cannot follow the move to its proof",
});

/** The verdict on an answer { index, sha384, wait, stops, coming, wired }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(SAYS)) if (a?.[k] !== true) bad(`${k}: ${SAYS[k]}`);
  if (lines.length === 0) lines.push("ok  a buy from Cash waits on its move's landing and its notes' proofs, stops at a real stop, and the move counts as coming until it lands");
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
