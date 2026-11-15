// Live check for card pool-sell-record-never-stays-sent: SIGN_HOST's served bundle ends every pool sell record and
// stops a rent back at a sign out.
//   - rebuilt: a sale built again after WrongAccount (nothing moved) writes its leg back to pending with no signature,
//     awaited before the rebuilt sale's first read (packages/signpage/src/pool-sell.ts sellRuns, poolSellKind's
//     `rebuilt`), so a page closed before the rebuilt sale signs leaves a record the dead-record settle ends;
//   - every read: the dead-record settle (settleDeadSellOps) runs at every state read, first and on no RPC, its store
//     bounded, never once per load behind a flag (packages/signpage/src/pool-testnet.ts solanaRead), so a record a second
//     tab left when it died is ended too;
//   - stops: a rent back ends at a sign out (pool-sell.ts rentBack): before each try and after each wait, a throttle's
//     included, and before W's key is derived; a resumed list's waits are cut by the sign out's signal (waitUnless) and
//     the list stops at it (resumeRentBacks).
// What each does is held by the card's tests (packages/signpage/test/pool-sell.test.ts, pool-testnet.test.ts); the
// recorded answers are facts() over SIGN_HOST's index.html and the /app.js it pins. This file reaches no package code
// (the import check holds it). The PR's own build runs judge(read) in scripts/ci/bundle-checks.mjs.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/pool-sell-record-never-stays-sent.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-sell-record-never-stays-sent";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (x) => x.replace(/\$/g, "\\$");

// the kind's hook: the record's writes awaited, the leg back to pending with no signature, the record's txs from its
// legs again, and the record put, awaited (a write that fails throws: nothing built again)
export const REBUILT_LEG = new RegExp(`rebuilt:async (${N})=>\\{await ${N},${N}\\(\\1,\\{tx:null,stage:\`pending\`\\}\\),${N}\\.txs=${N}\\(\\),await ${N}\\.put\\(\`ops\`,${N}\\.id,${N}\\(\\)\\)\\}`);
// the leg's host passes it on, and the sale's loop awaits it before the rebuilt attempt forgets its young reads
export const REBUILT_PASS = new RegExp(`rebuilt:async\\(\\)=>\\{await ${N}\\.rebuilt\\?\\.\\(${N}\\),await ${N}\\.rebuilt\\?\\.\\(\\)\\}`);
export const REBUILT_CALL = new RegExp(`if\\(!(${N})\\.rebuild\\|\\|${N}>=${N}\\)return ${N};await (${N})\\.rebuilt\\?\\.\\(\\),${N}\\(\\2\\.rpcs\\),${N}\\+\\+\\}`);
const rebuiltOf = (js) => REBUILT_LEG.test(js) && REBUILT_PASS.test(js) && REBUILT_CALL.test(js);

// the state read's Solana part: right after its proof pass is armed and before any settle that waits, the dead settle on
// the bounded store, its failure swallowed; groups 4 the settle's function, 2 the store's bound
export const EVERY_READ = new RegExp(`${N}\\(\\),(${N})&&await (${N})\\(${N}\\.store\\(\\),(${N}),\`the wallet store\`\\)\\.then\\((${N})=>(${N})\\((${N})\\(\\4,\\3\\),\\1\\)\\)\\.catch\\(\\(\\)=>\\{\\}\\),(${N})\\)return await \\7;`);
// the dead settle: the unfinished records read first, then the held locks, and only those not held settled
const deadSettle = (f) => new RegExp(`async function ${esc(f)}\\((${N}),(${N})\\)\\{let (${N})=\\[\\];for\\(let (${N}) of await \\1\\.keys\\(\`ops\`\\)\\)${N}\\(await \\1\\.get\\(\`ops\`,\\4\\)\\)&&\\3\\.push\\(\\4\\);if\\(\\3\\.length===0\\)return;let (${N})=new Set\\(\\(\\(await \\2\\.query\\(\\)\\)\\.held\\?\\?\\[\\]\\)`);
// the old shape: once a load, behind a flag set after the settle
export const ONCE = new RegExp(`(${N})&&!(${N})&&\\(await (${N})\\(await ${N}\\.store\\(\\),\\1\\),\\2=!0\\)`);
const everyReadOf = (js) => {
  const m = EVERY_READ.exec(js);
  return m !== null && deadSettle(m[5]).test(js) && !ONCE.test(js);
};

// the rent back's stop: its own error, the sign out read from the host's stop and its signal
export const STOP_ERROR = new RegExp(`(${N})=Error\\(\`a sign out\`\\)`);
const stopsOf = (js) => {
  const e = STOP_ERROR.exec(js)?.[1];
  if (e === undefined) return false;
  const S = esc(e);
  // rentBack: the sign out read (a load's pass; a sale's own rent back is the tap's run, which a sign out lets finish,
  // card sign-out-stops-the-pages-reads), then W's key: none derived after it; every sleep: stopped before and after, the
  // host's wait or the sell lock's nap between
  const out = `(${N})=\\(\\)=>${N}\\.sale!==!0&&\\(${N}\\.stopped\\?\\.\\(\\)===!0\\|\\|${N}\\.signal\\?\\.aborted===!0\\)`;
  const key = new RegExp(`async function ${N}\\(${N},${N},${N}\\)\\{let ${out},${N}=\\[\\],${N}=async\\(\\)=>\\{[^}]{0,80}\\},${N}=async\\(\\)=>\\{if\\(\\1\\(\\)\\)throw ${S};let ${N}=${N}\\(await`).exec(js);
  if (!key) return false;
  const r = esc(key[1]);
  const sleep = new RegExp(`=async (${N})=>\\{if\\(${r}\\(\\)\\)throw ${S};if\\(!(${N})\\)await ${N}\\.wait\\(\\1\\);else if\\(!await \\2\\.nap\\(\\1\\)\\)throw ${N};if\\(${r}\\(\\)\\)throw ${S}\\}`);
  // each try: after its wait (a throttle's doubling included), the sign out read before the step runs; a step that
  // throws it is never read as a fault to try again
  const tries = new RegExp(`if\\(${N}>0&&await ${N}\\(${N}\\(${N}\\)\\?${N}=${N}\\(${N},${N}\\(${N}\\),${N}\\):${N}\\.firstMs\\),${r}\\(\\)\\)throw ${S};try\\{return\\{ok:await ${N}\\(\\)\\}\\}catch\\((${N})\\)\\{if\\(\\1===${N}\\|\\|\\1===${N}\\|\\|\\1===${S}\\)throw \\1;`);
  // resumeRentBacks: its wait cut by the signal (waitUnless), the sign out read, and the list stopped at it
  const resume = new RegExp(`(${N})=(${N})=>(${N})\\((${N})\\.wait,\\2,\\4\\.signal\\),(?<stop>${N})=\\(\\)=>\\4\\.stopped\\?\\.\\(\\)===!0\\|\\|\\4\\.signal\\?\\.aborted===!0`);
  const m = resume.exec(js);
  if (!m) return false;
  const unless = new RegExp(`function ${esc(m[3])}\\((${N}),(${N}),(${N})\\)\\{return \\3\\?\\.aborted\\?Promise\\.resolve\\(\\):new Promise\\(`);
  const list = new RegExp(`for\\(let ${N} of ${N}\\)\\{if\\(${esc(m.groups.stop)}\\(\\)\\)return!0;`);
  return sleep.test(js) && tries.test(js) && unless.test(js) && list.test(js);
};

/** What the check keeps of SIGN_HOST's page: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), rebuilt: rebuiltOf(js), everyRead: everyReadOf(js), stops: stopsOf(js) };
}

/** The verdict on an answer { index, sha384, rebuilt, everyRead, stops }. */
export function judge(a) {
  const lines = [];
  const bad = (l) => lines.push(`BAD ${l}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.rebuilt !== true) bad("a sale built again after WrongAccount keeps its leg sent on the failed signature: a page closed before the rebuilt sale signs leaves the record sent for good");
  if (a?.everyRead !== true) bad("the dead sell records are settled once a load: a record another tab left when it died stays open until a reload");
  if (a?.stops !== true) bad("a rent back runs on past a sign out: its throttle waits are not cut, or it reads or signs after it");
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
