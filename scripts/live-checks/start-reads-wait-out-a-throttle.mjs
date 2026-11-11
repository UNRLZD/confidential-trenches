#!/usr/bin/env node
// Live check of card start-reads-wait-out-a-throttle on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - rule: one wait for a kind's next attempt (packages/signpage/src/read-waits.ts readWaits): the wallet's
//     throttleWaitMs from 1 s, doubling, at most 10 s, a Retry-After to 10 s, and null (down) once the next wait would
//     end past 30 s on the device's clock from the request's arrival (tapWaits: one bound per request id, a host's
//     clock); the Retry-After read only from the page client's transport fault;
//   - faults: only that fault waits (waitsOn: an instance of the class named SolanaRpcTransportError);
//   - stop: a wait ends at the sign out's abort (waitUnless, its own timer cleared), and the attempts loop (readsWaited)
//     answers failed once it is aborted, before and after each wait; a deposit waits on both its host's stops (stopOf);
//   - wired: the decimals read, the sell's plan, each sale, the buy and both deposits start their waits from the rule,
//     the buy and both deposits through the attempts loop on their host's wait and sign out, each kind on its
//     request's one bound from its arrival (taps: 4); a sell's next wallet answers down once the waits are spent
//     (spent); the page's two deposit hosts pass the session's stop, aborted at a sign out's tap (stops: 2);
//   - rentBack: the rent back's tries wait on throttleWaitMs in the same bounds after a provider fault, else 1 s.
// What each does is held by the card's tests (packages/signpage/test/pool-sell.test.ts, pool-buy.test.ts,
// pool-deposit.test.ts, pool-deposit-evm.test.ts, pool-kinds-decimals.test.ts, each "card start-reads-wait-out-a-
// throttle"); the recorded answers are facts() over each tree's packages/signpage/index.html and public/app.js (this file
// reaches no package code: the import check holds it). The card's proof on what is deployed is the app's devnet sell run
// (card app-sell-e2e-in-the-app); this check holds the code that run depends on.
// After: sign
//   node scripts/live-checks/start-reads-wait-out-a-throttle.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "start-reads-wait-out-a-throttle";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");
const count = (re, s) => [...s.matchAll(new RegExp(re.source, "g"))].length;

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
// a sell's next wallet whose turn comes once the waits are spent answers down without starting (its sale may be handed
// more after the waits: card pool-sell-legs-side-by-side's earlier reads and turn)
export const SPENT = new RegExp(`\\.then\\(\\(\\)=>(${N})\\.stopped\\?\\.\\(\\)\\?\\{error:${Q}failed${Q}\\}:(${N})\\.spent\\(\\)\\?\\{error:${Q}down${Q}\\}:${N}\\(${N},\\{\\.\\.\\.${N},amount:${N}\\.units,shareBps:void 0\\},${N},${N}\\.w,\\2(?:,[^;]{0,240}?)?\\)\\)`);

export function facts(index, js) {
  const out = { index, sha384: sha384(js), rule: false, faults: false, stop: false, wired: { decimals: false, sell: false, spent: false, buy: false, deposits: 0, stops: 0, taps: 0 }, rentBack: false };
  // the bounds, the device's clock, the Retry-After of the transport fault, and the rule: next(e) = T(pause, A(e), B),
  // null (and spent from then on) once max(the clock since the tap began, the waits so far) + the pause passes 30 s
  const def = new RegExp(`[,; ](${N})=Object\\.freeze\\(\\{firstMs:1e3,maxMs:1e4,afterMaxMs:1e4\\}\\),(${N})=\\(\\)=>Date\\.now\\(\\),(${N})=(${N})=>\\4 instanceof (${N})\\?\\4\\.afterMs:null;function (${N})\\((${N})=\\2\\)\\{let (${N})=\\7\\(\\),(${N})=0,(${N})=0,(${N})=!1;return\\{next\\((${N})\\)\\{let (${N})=(${N})\\(\\9,\\3\\(\\12\\),\\1\\);return \\11\\|\\|Math\\.max\\(\\7\\(\\)-\\8,\\10\\)\\+\\13>3e4\\?\\(\\11=!0,null\\):\\(\\9=\\13,\\10\\+=\\13,\\13\\)\\},spent:\\(\\)=>\\11\\}\\}`).exec(js);
  if (!def) return out;
  const [, B, , A, , X, R] = def;
  const T = def[14];
  // T: the wallet's throttleWaitMs (pause doubled to maxMs, else firstMs; a Retry-After to afterMaxMs; the larger)
  const throttle = new RegExp(`function ${esc(T)}\\((${N}),(${N}),(${N})=${N}\\)\\{let ${N}=Number\\.isFinite\\(\\1\\)&&\\1>0\\?Math\\.min\\(\\1\\*2,\\3\\.maxMs\\):\\3\\.firstMs,${N}=typeof \\2==${Q}number${Q}&&Number\\.isFinite\\(\\2\\)&&\\2>0\\?Math\\.min\\(\\2,\\3\\.afterMaxMs\\):0;return Math\\.max\\(`).test(js);
  // X: the page client's transport fault (kit send.ts SolanaRpcTransportError)
  const transport = new RegExp(`[,; ]${esc(X)}=class extends Error\\{[^]{0,200}?this\\.name=${Q}SolanaRpcTransportError${Q}`).test(js);
  // the request's one bound (tapWaits): by the request's id, else a fresh one; and a host's clock (clockOf)
  const tap = new RegExp(`function (${N})\\((${N}),(${N})\\)\\{if\\(typeof \\2\\?\\.id!=${Q}string${Q}\\)return ${esc(R)}\\(\\3\\);[^]{0,200}?${N}\\.get\\(\\2\\.id\\);`).exec(js);
  const clock = new RegExp(`[,; ](${N})=(${N})=>\\(\\)=>Number\\(\\2\\.now\\?\\.\\(\\)\\?\\?Date\\.now\\(\\)\\)`).exec(js);
  out.rule = throttle && transport && tap !== null && clock !== null;
  // waitsOn: the transport fault alone
  const on = new RegExp(`[,; ](${N})=(${N})=>\\2 instanceof ${esc(X)},`).exec(js.slice(def.index));
  out.faults = on !== null && transport;
  const W = on?.[1] ?? "\u0000";
  // waitUnless (a host's wait or a timer of its own, cleared at the abort; settled on a reject) and the attempts loop
  const unless = new RegExp(`function (${N})\\((${N}),(${N}),(${N})\\)\\{return \\4\\?\\.aborted\\?Promise\\.resolve\\(\\):new Promise\\((${N})=>\\{let (${N}),(${N})=\\(\\)=>\\{clearTimeout\\(\\6\\),\\4\\?\\.removeEventListener\\(${Q}abort${Q},\\7\\),\\5\\(\\)\\};\\4\\?\\.addEventListener\\(${Q}abort${Q},\\7,\\{once:!0\\}\\),\\2===void 0\\?\\6=setTimeout\\(\\7,\\3\\):\\2\\(\\3\\)\\.then\\(\\7,\\7\\)\\}\\)\\}`).exec(js);
  const C = unless?.[1] ?? "\u0000";
  const loop = new RegExp(`async function (${N})\\((${N}),(${N}),(${N}),(${N})\\)\\{for\\(;;\\)\\{let (${N})=\\{\\},(${N})=await \\2\\(\\6\\);if\\(!\\(${Q}fault${Q}in \\6\\)\\)return \\7;if\\(\\4\\?\\.aborted\\)return\\{error:${Q}failed${Q}\\};let (${N})=\\5\\.next\\(\\6\\.fault\\);if\\(\\8===null\\)return \\7;if\\(await ${esc(C)}\\(\\3,\\8,\\4\\),\\4\\?\\.aborted\\)return\\{error:${Q}failed${Q}\\}\\}\\}`).exec(js);
  // stopOf: a deposit host's two stops as one
  const either = new RegExp(`[,; ](${N})=(${N})=>\\2\\.signal!==void 0&&\\2\\.stop!==void 0\\?AbortSignal\\.any\\(\\[\\2\\.signal,\\2\\.stop\\]\\):\\2\\.signal\\?\\?\\2\\.stop[;,]`).exec(js);
  out.stop = unless !== null && loop !== null && either !== null;
  const L = loop?.[1] ?? "\u0000";
  const TW = tap?.[1] ?? "\u0000";
  const TL = clock?.[1] ?? "\u0000";
  const S = either?.[1] ?? "\u0000";
  out.wired = {
    // the decimals read: no wait only with waits 0, else the request's bound; its wait ended by the sign out, then a
    // throw; and the sell's request starts its bound there, at its arrival
    decimals: new RegExp(`=(${N})\\.waits===0\\?null:\\1\\.waits\\?\\?${esc(R)}\\(\\)[^]{0,900}?=${N}===null\\?null:${N}\\.next\\(${N}\\);if\\(${N}===null\\)throw ${N};if\\(await ${esc(C)}\\((${N})\\.wait,${N},\\2\\.signal\\),\\2\\.signal\\?\\.aborted\\)throw new ${N}\\}`).test(js) && new RegExp(`,(${N})=${esc(TW)}\\(${N},${N}\\.now\\);return\\{running:!0,after:${N}\\(${N},${N}\\.token,${N},\\{kept:${N},waits:\\1,`).test(js),
    // the sell: its plan and sales on one bound (a host's clock by default), each wait ended by the sign out
    sell: new RegExp(`async function ${N}\\(${N},${N},${N},${N}=\\{\\},(${N})=${esc(R)}\\(${esc(TL)}\\(${N}\\)\\)\\)\\{let ${N},${N}=Object\\.assign`).test(js) && count(new RegExp(`await ${esc(C)}\\((${N})\\.wait,${N},\\1\\.signal\\),\\1\\.stopped\\?\\.\\(\\)\\|\\|\\1\\.signal\\?\\.aborted\\)return\\{error:${Q}failed${Q}\\}`), js) >= 2,
    // a wallet whose turn comes once the waits are spent answers down without starting
    spent: SPENT.test(js),
    // the buy and both deposits: the attempts loop on the host's wait, sign out and the bound
    buy: new RegExp(`async function ${N}\\(${N},${N},(${N})=${esc(R)}\\(${esc(TL)}\\(${N}\\)\\)\\)\\{let (${N})=Object\\.assign\\(Object\\.create\\(${N}\\),\\{rpcs:${N}\\(${N}\\.rpcs,${N}\\(null\\)\\)\\}\\);return ${esc(L)}\\(${N}=>${N}\\(\\2,${N},${N}\\),\\2\\.wait,\\2\\.signal,\\1\\)\\}async function ${N}\\(${N},${N},${N}\\)\\{let ${N}=null,${N}=null,${N}=null,${N}=!1`).test(js),
    // the deposits wait on both their stops (stopOf)
    deposits: count(new RegExp(`${esc(L)}\\(${N}=>${N}\\(${N},${N},(?:${N},)?${N}\\),(${N})\\.wait,${esc(S)}\\(\\1\\),${N}\\)\\}async function ${N}\\(${N},${N},${N}(?:,${N})?\\)\\{if\\(${N}!==null&&\\(${N}\\.kind!==${Q}pool\\.deposit${Q}`), js),
    // the page's two deposit hosts: the follow's signal and, apart, a stop a sign out's tap aborts (as signingOut does)
    stops: [...js.matchAll(new RegExp(`,signal:(${N})\\.signal,stop:(${N})\\.signal,end:\\(\\)=>\\{`, "g"))].filter((m) => m[1] !== m[2] && new RegExp(`[,;{]${esc(m[2])}\\.abort\\(\\),${esc(m[2])}=new AbortController`).test(js)).length,
    // each kind (buy, sell, both deposits) takes its request's bound at its arrival, before its locks
    taps: count(new RegExp(`return\\{error:${Q}not_allowed${Q}\\};let ${N}=${esc(TW)}\\(${N}\\),`), js),
  };
  // the rent back: each try after the first waits T(pause, A(last), B) after a provider fault, else the first step
  out.rentBack = new RegExp(`${N}>0&&await ${N}\\(${esc(W)}\\((${N})\\)\\?(${N})=${esc(T)}\\(\\2,${esc(A)}\\(\\1\\),${esc(B)}\\):${esc(B)}\\.firstMs\\)`).test(js);
  return out;
}

const NO_RULE = "BAD no one wait for a kind's next attempt on the wallet's throttle rule (from 1 s, doubling to 10 s, down past 30 s)";
const NO_FAULTS = "BAD a wait is not kept to the page client's transport fault: another error waits, or none does";
const NO_STOP = "BAD a sign out does not end a kind's wait: a kind asked before it can run after it";
const NO_WIRED = (w) => `BAD ${w} does not wait on the one rule before its signature`;
const NO_SPENT = "BAD a sell's next wallet starts after the tap's waits are spent";
const NO_STOPS = "BAD a deposit's wait does not end at the sign out's tap: its host waits on the follow's signal alone";
const NO_TAPS = "BAD a kind does not take its request's one bound: a tap's waits start again at each step";
const NO_RENT_BACK = "BAD the rent back's tries wait a flat second, not on the one rule";

/** The verdict on an answer { index, sha384, rule, faults, stop, wired, rentBack }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.rule !== true) lines.push(NO_RULE);
  if (a?.faults !== true) lines.push(NO_FAULTS);
  if (a?.stop !== true) lines.push(NO_STOP);
  for (const w of ["decimals", "sell", "buy"]) if (a?.wired?.[w] !== true) lines.push(NO_WIRED(w));
  // the Solana deposit and the EVM deposit, both in each build
  if (a?.wired?.deposits !== 2) lines.push(NO_WIRED("deposits"));
  // the buy, the sell and both deposits each on its request's one bound
  if (a?.wired?.taps !== 4) lines.push(NO_TAPS);
  if (a?.wired?.spent !== true) lines.push(NO_SPENT);
  // the Solana deposit's host and the EVM deposit's, on the page
  if (a?.wired?.stops !== 2) lines.push(NO_STOPS);
  if (a?.rentBack !== true) lines.push(NO_RENT_BACK);
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
