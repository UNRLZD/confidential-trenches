#!/usr/bin/env node
// Live check of card move-from-cash-spends-every-note on SIGN_HOST (https://confidential.unrealized.trade): the Move
// screen from Cash into a pool on Solana, Base or Robinhood (pool.move and pool.move.dry, from near) moves up to the
// whole of Cash, however many notes hold it. Before the card the move and its dry were held to Cash's largest note
// (cashMover's ready and bounds: `usdc + fee > cash`, Max that note less its fee), so Cash split over notes each under
// the move refused it. Reads only: nothing is signed or sent. What it holds, from the served /app.js (the one
// index.html pins, its sha384), as minified (packages/signpage/src/cash-to-pool.ts):
//   - plan: planCashExact, the move's one plan over every Cash note: its least part above the fee, at least 1Click's
//     least read live and bringing at least the pool's floor; its Max every note whole less its fee, each one that
//     gives that part; one note that pays it with no change or one a later move sends, else the Cash form's planner of
//     an exact sum at that least part (withdraw/checks.ts planCashWithdraw), else the nearest amounts a plan sends;
//   - move: the mover's pool.move plans with it (the notes, the fee, the pool's floor and 1Click's least read now, down
//     when the floor is not read) and sends that plan's parts through the buy's own sender (sendParts: every part's
//     quote checked before any note leaves Cash), refusing an amount no plan sends;
//   - dry: pool.move.dry from Cash prices that same plan: its out each part's least, its Fee a relay fee a part, its
//     Max the plan's, and for an amount no plan sends the plan's max, min, below and above.
// What the plan sends for which notes, floors and prices is held by
// packages/signpage/test/move-from-cash-spends-every-note.test.ts (red at 65913ef75). The recorded answers are facts()
// over this card's build (packages/signpage/scripts/build-app.mjs --out, good) and over SIGN_HOST as served before the
// card (bad). The money run is the owner's Move from split Cash.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/move-from-cash-spends-every-note.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "move-from-cash-spends-every-note";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (v) => v.replace(/\$/g, "\\$");

/** planCashExact's head: its least part over the fee, 1Click's least and the pool's floor, and Max over every note at
 *  that part (group 1: its name; 2 the notes, 3 the fee, 4 the amount, 8 the least part, 10 Max). */
const PLAN = new RegExp(`function (${N})\\((${N}),(${N}),(${N}),(${N}),(${N}),(${N})\\)\\{if\\(\\3<0n\\|\\|\\4<=0n\\)return null;let (${N})=${N}\\((${N})=>\\9>\\3&&\\9>=\\(\\7\\?\\?0n\\)&&\\5\\(\\9\\)>=\\6\\);if\\(\\8===null\\)return null;let (${N})=${N}\\(\\2,\\3,\\8\\)`);
/** Its split: the Cash form's planner of the exact amount at that least part, else the nearest amounts at it. */
const splitOf = (m) =>
  new RegExp(`let (${N})=${N}\\(${esc(m[2])},${esc(m[4])},${esc(m[3])},${esc(m[8])}\\);return \\1===null\\?\\{fee:${esc(m[3])},max:${esc(m[10])},part:${esc(m[8])},parts:null,\\.\\.\\.${N}\\(${esc(m[2])},${esc(m[4])},${N}\\(${esc(m[3])},${esc(m[8])}\\)\\)\\}`);
/** The mover's plan of an exact move: the price, the notes, the fee, the floor and 1Click's least read now, planned by
 *  planCashExact at the device's price, down with no floor read (group 1: its name). */
const plannedOf = (plan) =>
  new RegExp(`(${N})=async\\((${N}),(${N})\\)=>\\{let (${N})=${N}\\.price\\(\\2\\);if\\(\\4===null\\|\\|\\3<=0n\\|\\|[^;]{0,80}\\)return\\{error:\`not_allowed\`\\};let\\[(${N}),(${N}),(${N}),(${N})\\]=await Promise\\.all\\(\\[[^;]{0,400}?\\]\\);return typeof \\7==\`bigint\`\\?${esc(plan)}\\(\\6,\\5,\\3,(${N})=>${N}\\(\\9,\\4,\\2\\),\\7,\\8\\)\\?\\?\\{error:\`not_allowed\`\\}:\\{error:\`down\`\\}`);
/** pool.move's mover move: that plan, refused with nothing sent when it sends nothing, its parts sent by the sender the
 *  buy's move uses (group 6). */
const moveOf = (planned) =>
  new RegExp(`move:\\((${N}),(${N}),(${N})\\)=>${N}\\(async\\(\\)=>\\{let (${N})=await ${esc(planned)}\\(\\1,\\2\\);if\\(\`error\`in \\4\\)return \\4;if\\(\\4\\.parts===null\\)return\\{error:\\2>\\4\\.max\\?\`not_funded\`:[^{}]{0,80}\\};let (${N})=await (${N})\\(\\1,\\4\\.parts,\\3,\\4\\.fee\\)`);
/** A buy's move from Cash: its parts sent under cash/<chain>/<ms> (group 2: the sender). */
const BUY_SEND = new RegExp(`let (${N})=await (${N})\\((${N}),(${N}),\`cash/\\$\\{\\3\\}/\\$\\{${N}\\.now\\(\\)\\}\`,(${N})\\)`);
/** pool.move.dry from Cash: the mover's plan, its limits when it sends nothing, else out the parts' least, Fee a relay
 *  fee a part, Max the plan's. */
const DRY = new RegExp(`(${N})=await (${N})\\.plan\\((${N}),(${N})\\.usdc\\);if\\(\`error\`in \\1\\)return \\1;if\\(\\1\\.parts===null\\)return (${N})\\((${N}),\\1\\.max,\\1\\);let (${N})=\\1\\.parts\\.reduce\\(\\((${N}),(${N})\\)=>\\8\\+\\9\\.least,0n\\),(${N})=\\1\\.fee\\*BigInt\\(\\1\\.parts\\.length\\);return\\{result:\\{out:${N}\\(\\7,${N}\\[\\3\\]\\),fee:${N}\\(\\10,${N}\\),steps:\\6,max:${N}\\(\\1\\.max\\)\\}\\}`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const p = PLAN.exec(js);
  const body = p === null ? "" : js.slice(p.index, js.indexOf("}function ", p.index) < 0 ? undefined : js.indexOf("}function ", p.index) + 1);
  const planned = p === null ? null : plannedOf(p[1]).exec(js);
  const move = planned === null ? null : moveOf(planned[1]).exec(js);
  const buy = BUY_SEND.exec(js);
  return {
    index,
    sha384: sha384(js),
    plan: p !== null && splitOf(p).test(body),
    move: move !== null && buy !== null && move[6] === buy[2],
    dry: DRY.test(js),
  };
}

export const SAYS = Object.freeze({
  plan: "the move out of Cash is not planned over every note at a least part each quote takes: Max and the plan are Cash's largest note, or a part its quote refuses",
  move: "pool.move from Cash does not send that plan's parts through the buy's own sender: it is held to one note, or a note may leave Cash before every part's quote is checked",
  dry: "pool.move.dry from Cash does not price that plan: its out, Fee and Max are one note's, not every note's",
});

/** The verdict on an answer { index, sha384, plan, move, dry }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(SAYS)) if (a?.[k] !== true) bad(`${k}: ${SAYS[k]}`);
  if (lines.length === 0) lines.push("ok  a Move from Cash into a pool is planned over every Cash note, priced from that plan, and sent part by part once every quote is checked");
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
