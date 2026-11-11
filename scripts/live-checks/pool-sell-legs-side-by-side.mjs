// Live check for card pool-sell-legs-side-by-side: SIGN_HOST's served bundle carries the side-by-side sell.
//   - turn: a sale of several wallets starts every leg at once; a leg after the first waits its turn (the leg before it
//     sent or ended) before any read its sale prices on, a sign out asked meanwhile ending it, and after the turn asks
//     its blockhash and the deposit's pages in one round with its quote (packages/signpage/src/pool-sell.ts sellRun);
//   - listed: the sale's list of wallets is made with no read at the tap, from the spent notes and the last whole
//     positions pass (keptListed), the finder only when none is kept (packages/signpage/src/pool-testnet.ts sellHost).
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
// the leg's turn awaited, a sign out after it refused, then (its venue reader between) the blockhash and the deposit's
// pages started only when there was a turn
const TURN = new RegExp(`(${N})=${N}\\?\\.opened;if\\(\\1&&\\(await \\1,${N}\\.stopped\\?\\.\\(\\)\\)\\)return\\{error:\`failed\`\\};[^;]{0,200};if\\(\\1\\)\\{${N}=${N}\\(${N}\\(${N}\\)\\),${N}=${N}\\(Promise\\.all\\(\\[${N},${N}\\]\\)\\.then\\(`);
// the sale's wallets: the passes held off, then (for a sale) the kept pass's listing read; a listing: the Ws derived from
// the spent notes with no read
const LISTED = new RegExp(`wallets:async\\(\\)=>\\{let ${N}=${N}\\.preempt\\(\\),${N}=null;try\\{let (${N})=${N}\\?${N}\\(await\\(await ${N}\\.store\\(\\)\\)\\.get\\(\`meta\`,${N}\\)\\):null;if\\(\\1!==null\\)\\{let ${N}=await ${N}\\(await ${N}\\(\\),${N}\\),${N}=await ${N}\\.seed64\\(\\),${N};try\\{${N}=${N}\\(${N},\\[\\{id:${N}\\.program,chain:\`sol\`,spent:${N}\\}\\]\\)\\}finally\\{${N}\\.fill\\(0\\)\\}`);

/** What the check keeps of SIGN_HOST's page: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), turn: TURN.test(js), listed: LISTED.test(js) };
}

/** The verdict on an answer { index, sha384, turn, listed }. */
export function judge(a) {
  const lines = [];
  const bad = (l) => lines.push(`BAD ${l}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.turn !== true) bad("a sale of several wallets reads a later leg's sale only after the leg before it sent: each leg's reads wait out every sale before it");
  if (a?.listed !== true) bad("a sale reads the finder at the tap: its list of wallets waits on a read the last whole positions pass already made");
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
