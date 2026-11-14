#!/usr/bin/env node
// Live check of card one-balance-buys-on-every-chain on SIGN_HOST (https://confidential.unrealized.trade): a Solana buy
// above what one tap of the pool spends moves its shortfall from Cash (the NEAR vault) into the Solana pool inside the
// same tap, over NEAR Intents (vault, 1Click, the pool's U_X: the Blindfill v2 lite paper's route), and buys the whole
// ask when it lands; the trade box's Max counts Cash. Reads only: nothing is signed or sent. What it holds, and only
// that: SIGN_HOST serves the script its index.html pins (its sha384), and, each found by a mark of the minified bundle's
// shape (packages/signpage/src/cash-to-pool.ts, src/main.ts, src/kit-version.ts):
//   - move: the mover names each move's follow op `cash/<chain>/<time>` and checks the quote before the vault pays it:
//     a NEAR implicit account as its deposit address (/^[0-9a-f]{64}$/), the USDC asked as its amount in, at least the
//     shortfall as its min out;
//   - tap: a pool.buy whose ask is above one tap's spend asks the mover for the shortfall, tells the app the move runs
//     ({ move: "cash" }, the flow's own step), and waits for it before the buy;
//   - max: pool.buy.dry's answer carries with_cash beside tap_max;
//   - level: a kit-v1.14 app is read at its own level and sent pool.buy.dry with with_cash left out (its schema
//     refuses the whole answer for it);
//   - version: the page reads every kit at 1.15 and above in full (SIGNPAGE_KIT_VERSION `1.15`);
//   - poolMove: the page answers pool.move and pool.move.dry itself, each checked first (the pair, the amount), and a
//     dry from Cash names the route the v2 lite paper names: out of the vault, NEAR Intents, into the pool;
//   - toCash: a pool's money moves back to Cash (src/pool-to-cash.ts): its dry names pool_out, NEAR Intents to NEAR,
//     into the vault, and the page quotes each pool coin (SOL, Base's and Robinhood's ETH on 1Click) into Cash;
//   - poolToPool: a pool's money moves into another chain's pool through Cash (src/pool-to-cash.ts onward): its dry
//     names the six steps (out of the pool and into the vault, then out of the vault and into the other pool), and
//     once in the vault Cash's own move of the USDC less its fee runs under `<op>/on`;
//   - leftCounted: every leftover counts in the balance (state.deposit_wallets): the deposit follow writes what U_X
//     holds each in_pool round (0 before a carry), the list counts an in_pool op's left before its end, and the page
//     reads each W's tail record (meta `w-tail/`) from its own store.
// The numbers (sizes, the wait's bound, each refusal) are packages/signpage/test/cash-to-pool.test.ts,
// pool-kinds-cash.test.ts and kit-version.test.ts at the released commit. The recorded answers are facts() over
// packages/signpage/scripts/build-app.mjs's build (mainnet, as SIGN_HOST serves) and SIGN_HOST as served before.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/one-balance-buys-on-every-chain.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "one-balance-buys-on-every-chain";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (v) => v.replace(/\$/g, "\\$");

/** The implicit-account rule (group: its name): the bundle has several of the same text, under their own names. */
const IMPLICIT = new RegExp(`(${N})=/\\^\\[0-9a-f\\]\\{64\\}\\$/`, "g");
/** The quote's check before the vault pays (group 1: the rule's name). */
const checkOf = (rule) => new RegExp(`\`error\`in (${N})\\|\\|!${esc(rule)}\\.test\\(\\1\\.address\\)\\|\\|\\1\\.amountIn!==(${N})\\|\\|\\1\\.minOut<(${N})\\)return`);
/** The move's follow op id. */
const MOVE_ID = new RegExp(`\`cash/\\$\\{${N}\\}/\\$\\{${N}\\.now\\(\\)\\}\``);
/** The tap: the shortfall asked of the mover, the app told, then the wait. Its tap read only when Cash or a move on its
 *  way can add to it (`any()`), and since pool.move the move's op id told with it; the form before either read too. */
const TAP = new RegExp(
  [
    `(${N})=await (${N})\\.tapMax\\((${N})\\);if\\(\\1<(${N})\\.amount&&await \\2\\.need\\(\\4\\.amount-\\1\\)\\)\\{try\\{${N}\\?\\.route\\?\\.\\(\\{move:\`cash\`\\}\\)\\}catch\\{\\}`,
    `(${N})=await (${N})\\.any\\(\\)\\?await \\6\\.tapMax\\((${N})\\):(${N})\\.amount;if\\(\\5<\\8\\.amount&&await \\6\\.need\\(\\8\\.amount-\\5\\)\\)\\{try\\{${N}\\?\\.route\\?\\.\\(\\{move:\`cash\`\\}\\)\\}catch\\{\\}`,
    `(${N})=await (${N})\\.any\\(\\)\\?await \\10\\.tapMax\\((${N})\\):(${N})\\.amount,(${N})=\\9<\\12\\.amount\\?await \\10\\.need\\(\\12\\.amount-\\9\\):null;if\\(\\13!==null\\)\\{try\\{${N}\\?\\.route\\?\\.\\(\\{move:\`cash\`,op:\\13\\}\\)\\}catch\\{\\}`,
  ].join("|"),
);
/** The tap on every pool chain (since Cash moves to Base and Robinhood too): the chain's tap read, the want (Solana's
 *  gap to one tap, an EVM chain's whole asked rung), the mover asked for it, the move op told, then the wait; and the
 *  want itself, Solana's the ask less the tap. */
const TAP_ALL = new RegExp(`(${N})=await (${N})\\.any\\((${N})\\)\\?await \\2\\.tapMax\\(\\3,${N}\\):(${N})\\.amount,(${N})=\\1<\\4\\.amount\\?(${N})\\(\\1\\):null,(${N})=\\5===null\\?null:await \\2\\.need\\(\\3,\\5\\);if\\(\\7!==null\\)\\{try\\{${N}\\?\\.route\\?\\.\\(\\{move:\`cash\`,op:\\7\\}\\)\\}catch\\{\\}`);
const tapAll = (js) => {
  const m = TAP_ALL.exec(js);
  if (m === null) return false;
  const want = new RegExp(`(?:^|[^\\w$])${esc(m[6])}=(${N})=>${esc(m[3])}===\`solana\`\\?${esc(m[4])}\\.amount-\\1:`);
  return want.test(js);
};
/** pool.buy.dry's answer with with_cash. */
const MAX = new RegExp(`\\{\\.\\.\\.(${N}),result:\\{\\.\\.\\.\\1\\.result,with_cash:${N}\\}\\}`);
/** kit-v1.14's level in the version chain, and its strip of with_cash. */
const LEVEL = new RegExp(`${N}\\(1,14\\)\\?\`1\\.14\`:${N}\\(1,13\\)\\?\`1\\.13\``);
const STRIP = new RegExp(`${N}!==\`pool\\.buy\\.dry\`\\)return ${N};let\\{with_cash:${N},\\.\\.\\.(${N})\\}=${N};return \\1`);

/** pool.move's kind, its ask checked before the mover is asked; and a move from Cash's steps (group 1: the chain). */
const MOVE_KIND = new RegExp(`\\{"pool\\.move":\\((${N}),${N}\\)=>\\{let (${N})=${N}\\(\\1\\);if\\(\`error\`in \\2\\)return \\2;`);
const TO_CASH_STEPS = new RegExp(`\\[\\{step:\`pool_out\`,chain:(${N})\\},\\{step:\`intents\`,chain:\`near\`\\},\\{step:\`vault_in\`,chain:\`near\`\\}\\]`);
/** The six steps of a pool-to-pool dry: the pool-to-Cash steps' function, then the Cash-to-pool steps' one. */
const POOL_TO_POOL = (js) => {
  const out = new RegExp(`(?:^|[^\\w$])(${N})=${N}=>\\[\\{step:\`pool_out\``).exec(js)?.[1];
  const into = new RegExp(`(?:^|[^\\w$])(${N})=${N}=>\\[\\{step:\`vault_out\``).exec(js)?.[1];
  if (out === undefined || into === undefined) return false;
  const six = new RegExp(`steps:\\[\\.\\.\\.${esc(out)}\\(${N}\\),\\.\\.\\.${esc(into)}\\(${N}\\)\\]`);
  const onward = new RegExp(`\\.onward\\.move\\(${N},${N}-${N},\`\\$\\{${N}\\}/on\`\\)`);
  return six.test(js) && onward.test(js);
};
/** The leftovers counted: the follow's holds (0 before a carry, and its write), an in_pool op's left listed, W tails read. */
const HOLDS_ZERO = new RegExp(`\\.floor\\)await ${N}\\.holds\\?\\.\\(0n\\),`);
const HOLDS_WRITE = new RegExp(`(${N})=async (${N})=>\\{let (${N})=\\2\\.toString\\(\\);await ${N}\\.update\\(\`ops\`,${N},(${N})=>${N}\\(\\4\\)&&\\4\\.follow\\.left!==\\3&&\\(\\2!==0n\\|\\|\\4\\.follow\\.left!==void 0\\)\\?\\{\\.\\.\\.\\4,follow:\\{\\.\\.\\.\\4\\.follow,left:\\3\\}\\}:void 0\\)\\};[^;]{0,200}holds:\\1,`);
// (card leftovers-carry-to-cash: a short op's left listed too)
const LISTED = new RegExp(`if\\((${N})\\.stage!==\`in_pool\`(?:&&\\1\\.stage!==\`short\`)?\\|\\|\\1\\.follow\\.left===void 0\\|\\|`);
const TAILS = new RegExp(`async function ${N}\\((${N})\\)\\{let (${N})=\\(await \\1\\.keys\\(\`meta\`\\)\\)\\.filter\\((${N})=>\\3\\.startsWith\\((${N})\\)\\);return Promise\\.all\\(\\2\\.map\\((${N})=>\\1\\.get\\(\`meta\`,\\5\\)`);
const leftCounted = (js) => {
  const t = TAILS.exec(js);
  return HOLDS_ZERO.test(js) && HOLDS_WRITE.test(js) && LISTED.test(js) && t !== null && new RegExp(`[,;]${esc(t[4])}=\`w-tail/\``).test(js);
};
const MOVE_STEPS = new RegExp(`\\[\\{step:\`vault_out\`,chain:\`near\`\\},\\{step:\`intents\`,chain:(${N})\\},\\{step:\`pool_in\`,chain:\\1\\}\\]`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and the marks read from it. */
export function facts(index, js) {
  const rules = [...js.matchAll(IMPLICIT)].map((m) => m[1]);
  return {
    index,
    sha384: sha384(js),
    move: rules.some((r) => checkOf(r).test(js)) && MOVE_ID.test(js),
    tap: TAP.test(js) || tapAll(js),
    max: MAX.test(js),
    level: LEVEL.test(js) && STRIP.test(js),
    version: /`1\.15`/.test(js),
    poolMove: MOVE_KIND.test(js) && /"pool\.move\.dry":(?:\([\w$,]*\)|[\w$]+)=>\{/.test(js) && MOVE_STEPS.test(js),
    toCash: TO_CASH_STEPS.test(js) && ["sol", "base", "hood"].every((c) => js.includes(`nep141:${c}.omft.near`)),
    poolToPool: POOL_TO_POOL(js),
    leftCounted: leftCounted(js),
  };
}

export const SAYS = Object.freeze({
  move: "the signing page has no move from Cash into a pool checked before the vault pays (a NEAR implicit deposit address, the USDC asked, at least the shortfall): a buy above the pool's money cannot use Cash",
  tap: "a Solana pool.buy above one tap's spend does not move its shortfall from Cash and wait for it in the same tap: the buy is refused not_funded",
  max: "the signing page's pool.buy.dry answers no with_cash: the trade box's Max is the pool's money alone, not the whole balance",
  level: "a kit-v1.14 app is not sent pool.buy.dry's answer with with_cash left out: its schema refuses the whole answer, and its Fee and Max with it",
  version: "the signing page does not read a kit 1.15 app in full: with_cash and the move step never reach the app that draws them",
  poolMove: "the signing page answers no pool.move or pool.move.dry of its own, checked first, with Cash's route out of the vault, over NEAR Intents and into the pool: Portfolio's Move cannot move money between chains",
  toCash: "the signing page moves no pool's money back to Cash (out of the pool, over NEAR Intents, into the vault, for SOL and both ETH pools): money in a pool cannot reach Cash or another chain",
  poolToPool: "the signing page moves no pool's money into another chain's pool (out of the pool into the vault, then Cash's own move into the other pool): Portfolio's Move between two pools cannot run",
  leftCounted: "the balance does not count every leftover (what U_X holds after a deposit, written each round and 0 before a carry; a W's tail under the least size): money the user still has reads as gone",
});

/** The verdict on an answer { index, sha384, move, tap, max, level, version, poolMove }. */
export function judge(a) {
  const lines = [];
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) lines.push("BAD SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) lines.push("BAD SIGN_HOST's served /app.js is not the one index.html pins");
  for (const [k, say] of Object.entries(SAYS)) if (a?.[k] !== true) lines.push(`BAD ${say}`);
  return { ok: lines.length === 0, lines };
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
