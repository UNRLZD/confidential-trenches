#!/usr/bin/env node
// Live check of card start-reads-wait-out-a-throttle on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - rule: one wait for a kind's next attempt (packages/signpage/src/read-waits.ts readWaits): the wallet's
//     throttleWaitMs from 1 s, doubling, at most 10 s, a Retry-After to 10 s, and null (down) once the waits would pass
//     30 s in all; the Retry-After read only from the page client's transport fault;
//   - faults: only that fault waits (waitsOn: an instance of the class named SolanaRpcTransportError);
//   - stop: a wait ends at the sign out's abort (waitUnless), and the attempts loop (readsWaited) answers failed once
//     it is aborted, before and after each wait;
//   - wired: the decimals read, the sell's plan, each sale, the buy and both deposits start their waits from the rule,
//     the buy and both deposits through the attempts loop on their host's wait and sign out;
//   - rentBack: the rent back's tries wait on throttleWaitMs in the same bounds, never a flat second.
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
export function facts(index, js) {
  const out = { index, sha384: sha384(js), rule: false, faults: false, stop: false, wired: { decimals: false, sell: false, buy: false, deposits: 0 }, rentBack: false };
  // the bounds, the Retry-After of the transport fault, and the rule: next(e) = T(pause, A(e), B), null past 30 s
  const def = new RegExp(`[,; ](${N})=Object\\.freeze\\(\\{firstMs:1e3,maxMs:1e4,afterMaxMs:1e4\\}\\),(${N})=(${N})=>\\3 instanceof (${N})\\?\\3\\.afterMs:null;function (${N})\\(\\)\\{let (${N})=0,(${N})=0;return\\{next\\((${N})\\)\\{let (${N})=(${N})\\(\\6,\\2\\(\\8\\),\\1\\);return \\7\\+\\9>3e4\\?null:\\(\\6=\\9,\\7\\+=\\9,\\9\\)\\}\\}\\}`).exec(js);
  if (!def) return out;
  const [, B, A, , X, R, , , , , T] = def;
  // T: the wallet's throttleWaitMs (pause doubled to maxMs, else firstMs; a Retry-After to afterMaxMs; the larger)
  const throttle = new RegExp(`function ${esc(T)}\\((${N}),(${N}),(${N})=${N}\\)\\{let ${N}=Number\\.isFinite\\(\\1\\)&&\\1>0\\?Math\\.min\\(\\1\\*2,\\3\\.maxMs\\):\\3\\.firstMs,${N}=typeof \\2==${Q}number${Q}&&Number\\.isFinite\\(\\2\\)&&\\2>0\\?Math\\.min\\(\\2,\\3\\.afterMaxMs\\):0;return Math\\.max\\(`).test(js);
  // X: the page client's transport fault (kit send.ts SolanaRpcTransportError)
  const transport = new RegExp(`[,; ]${esc(X)}=class extends Error\\{[^]{0,200}?this\\.name=${Q}SolanaRpcTransportError${Q}`).test(js);
  out.rule = throttle && transport;
  // waitsOn: the transport fault alone
  const on = new RegExp(`[,; ](${N})=(${N})=>\\2 instanceof ${esc(X)},`).exec(js.slice(def.index));
  out.faults = on !== null && transport;
  // waitUnless and the attempts loop
  const unless = new RegExp(`function (${N})\\((${N}),(${N}),(${N})\\)\\{return \\4===void 0\\?\\2\\(\\3\\):\\4\\.aborted\\?Promise\\.resolve\\(\\):new Promise\\((${N})=>\\{let (${N})=\\(\\)=>\\5\\(\\);\\4\\.addEventListener\\(${Q}abort${Q},\\6,\\{once:!0\\}\\)`).exec(js);
  const C = unless?.[1];
  const loop = C ? new RegExp(`async function (${N})\\((${N}),(${N}),(${N})\\)\\{let (${N})=\\3\\?\\?\\([^]{0,60}?\\),(${N})=${esc(R)}\\(\\);for\\(;;\\)\\{let (${N})=\\{\\},(${N})=await \\2\\(\\7\\);if\\(!\\(${Q}fault${Q}in \\7\\)\\)return \\8;if\\(\\4\\?\\.aborted\\)return\\{error:${Q}failed${Q}\\};let (${N})=\\6\\.next\\(\\7\\.fault\\);if\\(\\9===null\\)return \\8;if\\(await ${esc(C)}\\(\\5,\\9,\\4\\),\\4\\?\\.aborted\\)return\\{error:${Q}failed${Q}\\}\\}\\}`).exec(js) : null;
  out.stop = loop !== null;
  const L = loop?.[1];
  out.wired = {
    // the decimals read: no wait only with waits 0, the rule's next, the wait ended by the sign out, then a throw
    decimals: new RegExp(`=${N}\\.waits===0\\?null:${esc(R)}\\(\\)[^]{0,900}?=${N}===null\\?null:${N}\\.next\\(${N}\\);if\\(${N}===null\\)throw ${N};if\\(await ${esc(C ?? "\u0000")}\\(${N},${N},${N}\\.signal\\),${N}\\.signal\\?\\.aborted\\)throw new ${N}\\}`).test(js),
    // the sell: its sales' loop and its plan's, each from the rule, each wait ended by the sign out
    sell: count(new RegExp(`,(${N})=${esc(R)}\\(\\);for\\(`), js) >= 2 && count(new RegExp(`await ${esc(C ?? "\u0000")}\\(${N},${N},${N}\\.signal\\),${N}\\.stopped\\?\\.\\(\\)\\|\\|${N}\\.signal\\?\\.aborted\\)return\\{error:${Q}failed${Q}\\}`), js) >= 2,
    // the buy and both deposits: the attempts loop on the host's wait and sign out
    buy: L !== undefined && new RegExp(`return ${esc(L)}\\((${N})=>${N}\\(${N},${N},\\1\\),(${N})\\.wait,\\2\\.signal\\)\\}async function ${N}\\(${N},${N},${N}\\)\\{let ${N}=null,${N}=null,${N}=null,${N}=!1`).test(js),
    deposits: L === undefined ? 0 : count(new RegExp(`${esc(L)}\\(${N}=>${N}\\(${N},${N},(?:${N},)?${N}\\),${N}\\.wait,${N}\\.signal\\)\\}async function ${N}\\(${N},${N},${N}(?:,${N})?\\)\\{if\\(${N}!==null&&\\(${N}\\.kind!==${Q}pool\\.deposit${Q}`), js),
  };
  // the rent back: each try after the first waits T(pause, A(last), B)
  out.rentBack = new RegExp(`${N}>0&&await ${N}\\((${N})=${esc(T)}\\(\\1,${esc(A)}\\(${N}\\),${esc(B)}\\)\\)`).test(js);
  return out;
}

const NO_RULE = "BAD no one wait for a kind's next attempt on the wallet's throttle rule (from 1 s, doubling to 10 s, down past 30 s)";
const NO_FAULTS = "BAD a wait is not kept to the page client's transport fault: another error waits, or none does";
const NO_STOP = "BAD a sign out does not end a kind's wait: a kind asked before it can run after it";
const NO_WIRED = (w) => `BAD ${w} does not wait on the one rule before its signature`;
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
