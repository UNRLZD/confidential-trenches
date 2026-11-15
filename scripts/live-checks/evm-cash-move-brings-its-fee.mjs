#!/usr/bin/env node
// Live check of card evm-cash-move-brings-its-fee on SIGN_HOST (https://confidential.unrealized.trade): a Base or
// Robinhood buy paid from Cash moves enough to land in one tap, and the trade box shows You receive and Fee above
// tap_max on both chains. Reads only: nothing is signed or sent. What it holds, from the served /app.js (the one
// index.html pins, its sha384), as minified:
//   - tap: cashFirst asks the page's size of the move (`short`) on every pool chain after the tap read, and on Base and
//     Robinhood has no size of its own to fall back to (the want is Solana's gap, else null): the asked rung alone,
//     whose note spends the ask less its own relay fee, is never moved (src/cash-to-pool.ts cashFirst);
//   - sizing: the size is the tap's own plan (planEvmBuy) carrying the whole ask over the ready notes and the notes the
//     move brings, each at EVM_MOVE_FEE_ROOM times the epoch's relay fee (src/pool-buy-evm.ts evmMovedPieces,
//     evmMoveShort);
//   - move: the mover lands that size as whole rungs, each with one deposit's gas from U_X (src/cash-to-pool.ts
//     evmMoveOf, read by the mover's Base and Robinhood branch);
//   - dry: pool.buy.dry on Base and Robinhood above tap_max prices that sized plan's cost plus the move's
//     (src/pool-buy-evm.ts evmBuyDry with main.ts's fee and moved);
//   - max: its with_cash (the box's Max and its bound on a typed amount) is the most one tap buys with that same move,
//     each size priced by evmMoveOf against Cash's largest note (main.ts withCash, src/pool-buy-evm.ts evmMostWithCash),
//     not the largest rung Cash makes.
// What each does is held by packages/signpage/test/evm-cash-move-brings-its-fee.test.ts (the real cashFirst and mover
// over a model of the pool: red at aa325bd01), cash-to-pool.test.ts and pool-buy-evm-dry-preview.test.ts, and the
// terminal's harness (apps/terminal/test/trade-reads-after-buy: You receive and Fee above tap_max on Base and Robinhood).
// The recorded answers are facts() over a built tree's index.html and app.js (good: this card's branch, built with
// packages/signpage/scripts/build-app.mjs --out) and over SIGN_HOST as served before the card (bad).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-cash-move-brings-its-fee.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-cash-move-brings-its-fee";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (v) => v.replace(/\$/g, "\\$");

/** cashFirst's size asked on every pool chain, after the tap read (no chain test before it). */
const TAP_SHORT = new RegExp(`(${N})!==null&&\\1<(${N})\\.amount&&(${N})\\.short\\?await \\3\\.short\\((${N}),(${N}),\\2\\.amount\\)`);
/** The want: Solana's gap to one tap, nothing on any other chain (no asked rung). */
const WANT = new RegExp(`(?:^|[^\\w$])${N}=(${N})=>${N}===\`solana\`\\?${N}\\.amount-\\1:null[,;]`);
/** The notes a move brings, each at the fee room over the epoch fee, a rung that fee would eat left out. */
const PIECES = new RegExp(`let (${N})=(${N})\\*(${N});return ${N}\\(${N},${N}\\)\\.notes\\.filter\\((${N})=>\\1<\\4\\)\\.map\\(\\((${N}),(${N})\\)=>\\(\\{noteId:\`move#\\$\\{\\6\\}\`,chunk:\\5,fee:\\1\\}\\)\\)`);
/** The tap's own plan of the whole ask over the ready and moved notes, kept only when it carries the ask exactly. */
const PLAN = new RegExp(`\\{kind:\`pool\\.buy\`,chain:\`base\`,token:null,amount:(${N}),slippageBps:0,decimals:0\\},(${N}),(${N})\\);return (${N})\\.amount===\\1\\?\\4:null`);
/** evmMoveOf: the size up to whole least rungs, its notes counted, one deposit's gas each (group 1: its name). */
const MOVE_OF = new RegExp(`function (${N})\\((${N}),(${N}),(${N}),(${N})\\)\\{let (${N})=${N}\\[\\5\\];if\\(\\2<=0n\\|\\|\\3<0n\\|\\|\\2>=1n<<127n\\)return null;let (${N})=\\(\\2\\+\\6-1n\\)/\\6\\*\\6,(${N})=${N}\\(${N}\\[\\5\\],\\7\\)\\.notes\\.length,(${N})=\\7\\+BigInt\\(\\8\\)\\*\\3,`);
/** The mover's Base and Robinhood branch sizes its quote by it, at the pool's floor less its least rung. */
const moverUses = (name) => new RegExp(`typeof (${N})!=\`bigint\`\\?null:${esc(name)}\\((${N}),\\1>${N}\\[(${N})\\]\\?\\1-${N}\\[\\3\\]:0n,${N},\\3\\);(${N})=(${N})\\?\\.left\\?\\?\\2,(${N})=\\5\\?\\.usdc\\?\\?null`);
/** pool.buy.dry above tap_max: the sized plan's cost plus the move's, only with a fee read and a priced move. */
const DRY = [new RegExp(`${N}>${N}&&(${N})\\.fee!==void 0&&\\1\\.moved!==void 0`), new RegExp(`\\{plan:(${N})\\.plan,cost:${N}\\(\\1\\.plan\\)\\+${N}\\}`)];
/** main.ts gives the dry the pool's own epoch fee read and the move's price. */
const DRY_DEPS = new RegExp(`fee:\\(\\)=>${N}\\?\\.evmFeeNow\\((${N})\\)\\?\\?Promise\\.resolve\\(null\\),moved:async`);

/** main.ts's with_cash on Base and Robinhood: at the epoch's fee read, a move's size paid when evmMoveOf's USDC and the
 *  withdraw fee fit Cash's largest note. */
const maxOf = (moveOf) => new RegExp(`evmFeeNow\\(${N}\\)\\.catch\\(\\(\\)=>null\\)\\?\\?null\\][\\s\\S]{0,300}?${N}\\(${N},${N},(${N})=>\\{let (${N})=${esc(moveOf)}\\(\\1,${N},${N},${N}\\);return \\2!==null&&\\2\\.usdc\\+${N}<=${N}\\}`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const moveOf = MOVE_OF.exec(js)?.[1];
  return {
    index,
    sha384: sha384(js),
    tap: TAP_SHORT.test(js) && WANT.test(js),
    sizing: PIECES.test(js) && PLAN.test(js),
    move: moveOf !== undefined && moverUses(moveOf).test(js),
    dry: DRY.every((r) => r.test(js)) && DRY_DEPS.test(js),
    max: moveOf !== undefined && maxOf(moveOf).test(js),
  };
}

export const SAYS = Object.freeze({
  tap: "Base and Robinhood: a buy from Cash moves the asked rung alone (or nothing for an ask that is no rung), not the size the page's plan needs: the note it brings spends the ask less its own fee, and the tap is refused",
  sizing: "the move from Cash on Base and Robinhood is not sized by the tap's own plan over the notes it brings, each paying its own relay fee",
  move: "the mover does not land the sized move as whole rungs with one deposit's gas each: part of it may never become a note the tap spends",
  dry: "Base and Robinhood: above tap_max the trade box gets no You receive or Fee for the buy that moves from Cash",
  max: "Base and Robinhood: the box's Max with Cash is not what one tap buys with the sized move: it allows an amount the tap cannot carry, or refuses one it can",
});

/** The verdict on an answer { index, sha384, tap, sizing, move, dry, max }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(SAYS)) if (a?.[k] !== true) bad(`${k}: ${SAYS[k]}`);
  if (lines.length === 0) lines.push("ok  a Base or Robinhood buy from Cash moves what the tap's plan needs, every note paying its own fee, and the box prices it above tap_max");
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
