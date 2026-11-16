#!/usr/bin/env node
// Live check of card evm-withdraw-waits-out-a-throttle on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - faults: the EVM withdraw's steps wait on the page's step faults (pool-withdraw.ts stepWaitsOn) and on the EVM
//     reads' own two, EvmUnansweredError and EvmLagError (pool-withdraw-evm.ts evmStepWaitsOn), through the withdraw's
//     one step loop (stepWaited, whose `on` defaults to the page's step faults);
//   - plan: the EVM plan step (notes, plan, To, costs, Max fee) goes through the loop on those faults, and asks the exit
//     once a run per first W (`asked[ws[0]] ??= await exit(ws[0])`), so a rerun after a throttle asks it again only
//     for another W;
//   - part: each EVM part goes through the loop on those faults, with its own signed mark;
//   - signed: the part's signed mark is set right before W signs the release (the EVM signer, "evm.withdraw"), so a
//     fault after it is never made again;
//   - free: the EVM part's failed free of its held note ends it naming the free (stop "free"), never a wait over it;
//   - stop: the page's EVM withdraw host passes the session's sign out, which ends a wait with nothing signed.
// What each does is held by the card's tests (packages/signpage/test/pool-withdraw-evm.test.ts, "card
// evm-withdraw-waits-out-a-throttle"); the recorded answers are facts() over each tree's packages/signpage/index.html
// and public/app.js (this file reaches no package code: the import check holds it).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-withdraw-waits-out-a-throttle.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-withdraw-waits-out-a-throttle";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const out = { index, sha384: sha384(js), faults: false, plan: false, part: false, signed: false, free: false, stop: false };
  // the EVM reads' two faults, by their names (wallet pool/evm.ts)
  const named = (name) => [...js.matchAll(new RegExp(`[,; ](${N})=class extends Error\\{(?:(?!=class )[^]){0,120}?this\\.name=${Q}${name}${Q}`, "g"))].map((m) => m[1]);
  const unanswered = named("EvmUnansweredError");
  const lag = named("EvmLagError");
  // the step loop: its `on` parameter, defaulting to the page's step faults
  const loop = new RegExp(`async function (${N})\\((${N}),(${N}),(${N})=(${N})\\)\\{let ${N}=${N}\\(${N}\\(\\2\\)\\);for\\(;;\\)\\{let (${N})=\\{signed:!1\\};try\\{return await \\3\\(\\6\\)\\}catch\\((${N})\\)\\{if\\(\\6\\.signed\\|\\|\\2\\.stop\\?\\.aborted\\|\\|!\\4\\(\\7\\)\\)throw \\7;`).exec(js);
  if (loop === null || unanswered.length === 0 || lag.length === 0) return out;
  const [, G, , , , stepOn] = loop;
  const either = (names) => `(?:${names.map(esc).join("|")})`;
  const evmOn = new RegExp(`[,; ](${N})=(${N})=>${esc(stepOn)}\\(\\2\\)\\|\\|(?:\\2 instanceof ${either(unanswered)}\\|\\|\\2 instanceof ${either(lag)}|\\2 instanceof ${either(lag)}\\|\\|\\2 instanceof ${either(unanswered)})[,;]`).exec(js)?.[1];
  out.faults = evmOn !== undefined;
  if (evmOn === undefined) return out;
  // the plan step through the loop on the EVM faults, its kept exit answers passed in; in its body the exit asked once
  // per first W, keyed by that W
  const plan = new RegExp(`=await ${esc(G)}\\(${N},\\(\\)=>(${N})\\(${N},${N},${N},${N},(${N})\\),${esc(evmOn)}\\)`).exec(js);
  if (plan !== null) {
    const head = new RegExp(`async function ${esc(plan[1])}\\((${N}),(${N}),(${N}),(${N}),(${N})\\)\\{`).exec(js);
    const body = head === null ? "" : js.slice(head.index, head.index + 4000);
    out.plan = head !== null && new RegExp(`${esc(head[1])}\\.exit&&\\(${esc(head[2])}=${esc(head[5])}\\[(${N})\\[0\\]\\]\\?\\?=await ${esc(head[1])}\\.exit\\(\\1\\[0\\]\\)\\)`).test(body);
  }
  // each part through the loop on the EVM faults, its attempt's mark passed last
  out.part = new RegExp(`=await ${esc(G)}\\(${N},(${N})=>${N}\\([^;]{0,300}?,\\1\\),${esc(evmOn)}\\)`).test(js);
  // the signed mark right before the EVM signer ("evm.withdraw"), after the part's wallet check; that stop's name
  const signer = [...js.matchAll(new RegExp(`function (${N})\\(${N},${N},${N},${N},${N},${N}=!1\\)\\{let ${N}=${N}\\(${Q}evm\\.withdraw${Q},`, "g"))].map((m) => m[1]);
  const signed = signer.length === 0 ? null : new RegExp(`&&(${N})\\(${Q}wallet${Q}\\),(${N})&&\\(\\2\\.signed=!0\\);let ${N}=${either(signer)}\\(`).exec(js);
  out.signed = signed !== null;
  // the part's failed free: the part stops naming it, with the EVM part's own stop
  out.free = signed !== null && new RegExp(`,${Q}HELD${Q},${Q}UNSPENT${Q},\\{attempt:${N}\\}\\)\\.then\\(\\(\\)=>!0,\\(\\)=>!1\\)&&${esc(signed[1])}\\(${Q}free${Q}\\)`).test(js);
  // the page's EVM withdraw host: its owed notes, the test hooks, then the session's sign out
  out.stop = new RegExp(`owedNotes:${N},\\.\\.\\.(${N})\\.now\\?\\{now:\\1\\.now\\}:\\{\\},\\.\\.\\.\\1\\.wait\\?\\{wait:\\1\\.wait\\}:\\{\\},stop:${N}\\.signal\\}`).test(js);
  return out;
}

const NO_FAULTS = "BAD the EVM withdraw's steps do not wait on the EVM reads' own faults (unanswered, lagging) beside the page's";
const NO_PLAN = "BAD the EVM withdraw's plan does not wait out a throttle, or a rerun asks the exit again for the same W";
const NO_PART = "BAD an EVM withdraw part does not wait out a throttle before W signs";
const NO_SIGNED = "BAD an EVM withdraw part is not marked signed before W signs: a signed part could be made again";
const NO_FREE = "BAD an EVM part's failed free of its held note is silent: the run could wait over a note it holds";
const NO_STOP = "BAD the page's EVM withdraw host passes no sign out: a wait would hold the seed's lock";

/** The verdict on an answer { index, sha384, faults, plan, part, signed, free, stop }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.faults !== true) lines.push(NO_FAULTS);
  if (a?.plan !== true) lines.push(NO_PLAN);
  if (a?.part !== true) lines.push(NO_PART);
  if (a?.signed !== true) lines.push(NO_SIGNED);
  if (a?.free !== true) lines.push(NO_FREE);
  if (a?.stop !== true) lines.push(NO_STOP);
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
