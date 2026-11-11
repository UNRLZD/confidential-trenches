// Live check for card pool-sell-legs-side-by-side: SIGN_HOST's served bundle carries the side-by-side sell.
//   - turn: a sale of several wallets starts every leg at once; a leg after the first waits its turn (the leg before it
//     sent or ended) before any read its sale prices on, a sign out asked meanwhile ending it, and after the turn asks
//     its blockhash and the deposit's pages in one round with its quote (packages/signpage/src/pool-sell.ts sellRun);
//   - listed: the sale's list of wallets is made with no read at the tap, from the spent notes and the last whole
//     positions pass (keptListed), the finder only when none is kept (packages/signpage/src/pool-testnet.ts sellHost);
//   - share: every seat of the page on the helper (the trade's pair, the pool pair, the settle pair, the pass's) is paced
//     to the helper's own share per caller, 42 per 10 s and 40 of one method (packages/signpage/src/page-rpc.ts
//     HELPER_SOLANA_LIMIT), so the legs wait their turn on the page, never the helper's 429;
//   - young: a sale's market and blockhash reads (read-waits.ts solanaSaleReads: getLatestBlockhash, isBlockhashValid, a
//     getMultipleAccounts naming the mint) are one answer for its legs while under 4 s old (pool-sell.ts
//     POOL_SELL_SHARED_READ_MS), never a failed one kept, and every one dropped after a wait (forgetYoung).
// What each does is held by the card's tests (packages/signpage/test/pool-sell.test.ts, pool-sell-listed.test.ts); the
// recorded answers are facts() over SIGN_HOST's index.html and the /app.js it pins. This file reaches no package code
// (the import check holds it). The PR's own build runs judge(read) in scripts/ci/bundle-checks.mjs.
// After: sign
//   node scripts/live-checks/pool-sell-legs-side-by-side.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-sell-legs-side-by-side";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const N = "[\\w$]+";
// the leg's turn awaited, a sign out after it refused and the tap's waits spent meanwhile answered down, then (its venue
// reader between) the blockhash and the deposit's pages started only when there was a turn
const TURN = new RegExp(`(${N})=${N}\\?\\.opened;if\\(\\1\\)\\{if\\(await \\1,${N}\\.stopped\\?\\.\\(\\)\\)return\\{error:\`failed\`\\};if\\(${N}\\.spent\\?\\.\\(\\)\\)return\\{error:\`down\`\\}\\}[^;]{0,200};if\\(\\1\\)\\{${N}=${N}\\(${N}\\(${N}\\)\\),${N}=${N}\\(Promise\\.all\\(\\[${N},${N}\\]\\)\\.then\\(`);
// the sale's wallets: the passes held off, then (for a sale) the kept pass's listing read; a listing: no spent note, no
// seed read; else the Ws derived from the spent notes with no read, the seed copy zeroed; a W neither a buy record nor
// the listing names read through the finder, those Ws only (review of 55d4c6eb, P2-A: a W from before a sign out)
const LISTED = new RegExp(`wallets:async\\(\\)=>\\{let ${N}=${N}\\.preempt\\(\\),${N}=null;try\\{let (${N})=${N}\\?${N}\\(await\\(await ${N}\\.store\\(\\)\\)\\.get\\(\`meta\`,${N}\\)\\):null;if\\(\\1!==null\\)\\{let (${N})=await ${N}\\(await ${N}\\(\\),${N}\\);if\\(\\2\\.length===0\\)return ${N}=\\[\\];let (${N})=await\\(await ${N}\\.store\\(\\)\\)\\.get\\(\`meta\`,\`owed/buy-sol\`\\)\\?\\?\\{\\},${N}=await ${N}\\.seed64\\(\\),(${N}),(${N}),(${N})=null;try\\{\\4=${N}\\(${N},\\[\\{id:${N}\\.program,chain:\`sol\`,spent:\\2\\}\\]\\),\\5=new Set\\(\\4\\.wallets\\.map\\(${N}=>${N}\\.address\\)\\.filter\\((${N})=>!Object\\.hasOwn\\(\\3,\\7\\)&&!\\1\\.has\\(\\7\\)\\)\\),\\4\\.failed\\.length===0&&\\5\\.size>0&&\\(\\6=${N}\\(${N},\\[\\{id:${N}\\.program,chain:\`sol\`,spent:\\2,reader:${N}\\(${N}\\)\\}\\]\\)\\)\\}finally\\{${N}\\.fill\\(0\\)\\}[^]{0,240}?\\6\\.read\\(\\{only:\\5,together:!0\\}\\)`);

// the helper's share as a limit, and each helper seat paced under it: the release's pair, then pageSolanaRpcs and
// pageSolanaSettleRpcs (provider A as before, the helper's seat with the limit), and the positions pass's helper reads
const LIMIT = new RegExp(`(?<![\\w$])(${N})=\\{windowMs:1e4,total:42,perMethod:40\\}`);
const seats = (l) => [
  new RegExp(`providers:\\[${N}\\(${N}\\(${N}\\)\\),${N}\\(${N}\\(${N}\\),${l}\\)\\]`),
  new RegExp(`=\\((${N})=\`trade\`\\)=>\\[${N}\\(${N}\\(${N},\\1\\)\\),${N}\\(${N}\\(${N},${N},\\1\\),${l}\\)\\],${N}=\\((${N})=\`trade\`\\)=>${N}\\(${N}\\(${N},${N},\\2\\)\\),${N}=\\((${N})=\`trade\`\\)=>\\[${N}\\(${N}\\(${N},\\3\\)\\),${N}\\(${N}\\(${N},${N},\\3\\),${l}\\)\\]`),
  new RegExp(`${N}\\(${N}\\(${N},${N}\\.signal,\`pass\`\\),${l}\\)`),
];
// the sale's pair: its stable reads kept, then its sale reads young under the bound on the host's clock; the bound
// 4 s; the young read: shared while under the bound, a failed one dropped, and a forget that drops all; the sale reads
// named; and the young reads forgotten after a leg's wait and after the plan's
const YOUNG = new RegExp(`rpcs:(${N})\\(${N}\\(${N}\\.rpcs,${N}\\(${N}\\.token\\)\\),(${N})\\(${N}\\.token\\),(${N}),\\(\\)=>Number\\(${N}\\.now\\?\\.\\(\\)\\?\\?BigInt\\(Date\\.now\\(\\)\\)\\)\\)`);
const youngOf = (js) => {
  const m = YOUNG.exec(js);
  if (!m) return false;
  const [, y, sale, bound] = m;
  const fn = new RegExp(`function ${y.replace(/\$/g, "\\$")}\\((${N}),(${N}),(${N}),(${N})\\)\\{let (${N})=\\[\\],(${N})=(${N})=>\\{let (${N})=new Map;return \\5\\.push\\(\\8\\),${N}\\(\\7,\\((${N}),(${N})\\)=>\\{if\\(!\\2\\(\\9,\\10\\)\\)return \\7\\(\\9,\\10\\);let (${N})=\`\\$\\{\\9\\} \\$\\{JSON\\.stringify\\(\\10\\)\\}\`,(${N})=\\4\\(\\),(${N})=\\8\\.get\\(\\11\\);if\\(\\13&&\\12-\\13\\.at<\\3\\)return \\13\\.read;let (${N})=Promise\\.resolve\\(\\7\\(\\9,\\10\\)\\),(${N})=\\{at:\\12,read:\\14\\};return \\8\\.set\\(\\11,\\15\\),\\14\\.catch\\(\\(\\)=>\\{\\8\\.get\\(\\11\\)===\\15&&\\8\\.delete\\(\\11\\)\\}\\),\\14\\}\\)\\};return Object\\.assign\\(\\[\\6\\(\\1\\[0\\]\\),\\6\\(\\1\\[1\\]\\)\\],\\{forget:\\(\\)=>\\5\\.forEach\\(${N}=>${N}\\.clear\\(\\)\\)\\}\\)\\}var (${N})=${N}=>${N}\\.forget\\?\\.\\(\\)`);
  const f = fn.exec(js);
  if (!f) return false;
  const forget = f[16].replace(/\$/g, "\\$");
  const esc = (x) => x.replace(/\$/g, "\\$");
  return (
    new RegExp(`(?<![\\w$])${esc(bound)}=4e3[,;]`).test(js) &&
    new RegExp(`(?<![\\w$])${esc(sale)}=(${N})=>\\((${N}),(${N})\\)=>\\2===\`getLatestBlockhash\`\\|\\|\\2===\`isBlockhashValid\`\\|\\|\\1!==null&&\\2===\`getMultipleAccounts\`&&Array\\.isArray\\(\\3\\[0\\]\\)&&\\3\\[0\\]\\.includes\\(\\1\\)[,;]`).test(js) &&
    // after a leg's wait (sellRuns), after a rebuild, and after the plan's wait
    (js.match(new RegExp(`(?<![\\w$])${forget}\\(${N}\\.rpcs\\)`, "g")) ?? []).length >= 3
  );
};
const shareOf = (js) => {
  const l = LIMIT.exec(js)?.[1];
  return !!l && seats(l.replace(/\$/g, "\\$")).every((r) => r.test(js));
};

/** What the check keeps of SIGN_HOST's page: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), turn: TURN.test(js), listed: LISTED.test(js), share: shareOf(js), young: youngOf(js) };
}

/** The verdict on an answer { index, sha384, turn, listed, share, young }. */
export function judge(a) {
  const lines = [];
  const bad = (l) => lines.push(`BAD ${l}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.turn !== true) bad("a sale of several wallets reads a later leg's sale only after the leg before it sent: each leg's reads wait out every sale before it");
  if (a?.listed !== true) bad("a sale reads the finder at the tap: its list of wallets waits on a read the last whole positions pass already made");
  if (a?.share !== true) bad("the page's helper seats are paced past the helper's share per caller: a sale's legs draw its 429 and wait it out");
  if (a?.young !== true) bad("each leg of a sale asks its market and blockhash again: the legs draw the providers' share with reads that are the same for each");
  return { ok: !lines.length, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
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
    console.log(`ERROR ${KEY}: ${String(e?.message ?? e).slice(0, 300)}`);
    process.exit(2);
  }
}
