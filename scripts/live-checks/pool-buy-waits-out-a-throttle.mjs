#!/usr/bin/env node
// Live check of card pool-buy-waits-out-a-throttle on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - step: a withdraw step's loop (packages/signpage/src/pool-withdraw.ts stepWaited): each attempt with its own
//     signed mark; a fault once the step is signed, a sign out, or a fault that does not wait is thrown at once; the
//     others wait the page's one rule (read-waits.ts readWaits, its next(e): null throws) through waitUnless on the
//     host's wait and sign out, and a sign out after the wait is ReadStopped;
//   - faults: the step waits on the page client's transport fault (waitsOn) or a busy answer (ReadBusy) only;
//   - wired: the withdraw's plan step and each part go through the loop, the part's signed mark set right before W
//     signs the release, and the page's withdraw host passes the session's sign out (stop);
//   - exit: the exit's 1Click ask answered 429 or a 5xx throws ReadBusy (pool-exit.ts);
//   - scan: a pool scan's transport fault is kept, never "no pools", and a reference that names no pool throws it
//     (page-rpc.ts pageReference), so a buy's attempts wait it out.
// What each does is held by the card's tests (packages/signpage/test/pool-withdraw-throttle.test.ts and
// reference-scan-fault.test.ts); the recorded answers are facts() over each tree's packages/signpage/index.html and
// public/app.js (this file reaches no package code: the import check holds it).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/pool-buy-waits-out-a-throttle.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-buy-waits-out-a-throttle";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const out = { index, sha384: sha384(js), step: false, faults: false, wired: { plan: false, part: false, signed: false, stop: false }, exit: false, scan: false };
  // the page client's transport fault, by its name (kit send.ts SolanaRpcTransportError), and ReadBusy
  const transport = [...js.matchAll(new RegExp(`[,; ](${N})=class extends Error\\{(?:(?!=class )[^]){0,200}?this\\.name=${Q}SolanaRpcTransportError${Q}`, "g"))].map((m) => m[1]);
  const busy = new RegExp(`[,; ](${N})=class extends Error\\{code;constructor\\((${N})\\)\\{super\\(${Q}a busy answer \\(HTTP \\$\\{\\2\\}\\)${Q}\\),this\\.name=${Q}ReadBusy${Q},this\\.code=\\2===429\\?${Q}http_429${Q}:${Q}http_5xx${Q}\\}\\}`).exec(js)?.[1];
  const stopped = new RegExp(`[,; ](${N})=class extends Error\\{constructor\\(\\)\\{super\\(${Q}signed out while the reads waited${Q}\\),this\\.name=${Q}ReadStopped${Q}\\}\\}`).exec(js)?.[1];
  if (transport.length === 0 || busy === undefined || stopped === undefined) return out;
  const isTransport = `(?:${transport.map(esc).join("|")})`;
  // waitsOn: an instance of the transport fault; the step's faults: waitsOn or ReadBusy
  const waitsOn = new RegExp(`[,; ](${N})=(${N})=>\\2 instanceof ${isTransport}[,;]`).exec(js)?.[1];
  const stepOn = waitsOn === undefined ? undefined : new RegExp(`[,; ](${N})=(${N})=>${esc(waitsOn)}\\(\\2\\)\\|\\|\\2 instanceof ${esc(busy)}[,;]`).exec(js)?.[1];
  out.faults = stepOn !== undefined;
  // the step: a fresh bound per step (readWaits on the host's clock), each attempt's own signed mark, the throws, the
  // rule's wait on the host's wait and sign out, ReadStopped after it
  const step = new RegExp(
    `async function (${N})\\((${N}),(${N})\\)\\{let (${N})=(${N})\\((${N})\\(\\2\\)\\);for\\(;;\\)\\{let (${N})=\\{signed:!1\\};try\\{return await \\3\\(\\7\\)\\}catch\\((${N})\\)\\{if\\(\\7\\.signed\\|\\|\\2\\.stop\\?\\.aborted\\|\\|!(${N})\\(\\8\\)\\)throw \\8;let (${N})=\\4\\.next\\(\\8\\);if\\(\\10===null\\)throw \\8;if\\(await (${N})\\(\\2\\.wait,\\10,\\2\\.stop\\),\\2\\.stop\\?\\.aborted\\)throw new ${esc(stopped)}\\}\\}\\}`,
  ).exec(js);
  if (step === null || step[9] !== stepOn) return out;
  const [, G, , , , R, C, , , , , U] = step;
  // readWaits (its 30 s bound and its next), the host's clock (clockOf), waitUnless (ended at an abort)
  const rule = new RegExp(`function ${esc(R)}\\((${N})=${N}\\)\\{let (${N})=\\1\\(\\),(${N})=0,(${N})=0,(${N})=!1;return\\{next\\((${N})\\)\\{[^]{0,120}?>3e4\\?\\(\\5=!0,null\\)`).test(js);
  const clock = new RegExp(`[,; ]${esc(C)}=(${N})=>\\(\\)=>Number\\(\\1\\.now\\?\\.\\(\\)\\?\\?Date\\.now\\(\\)\\)`).test(js);
  const unless = new RegExp(`function ${esc(U)}\\((${N}),(${N}),(${N})\\)\\{return \\3\\?\\.aborted\\?Promise\\.resolve\\(\\)`).test(js);
  out.step = rule && clock && unless;
  // the plan step and each part through the loop; the part's signed mark right before W signs the release
  out.wired.plan = new RegExp(`=await ${esc(G)}\\(${N},\\(\\)=>${N}\\(${N},${N},${N},${N}\\)\\);`).test(js);
  out.wired.part = new RegExp(`=await ${esc(G)}\\(${N},(${N})=>${N}\\([^;]{0,240}?,void 0,\\1\\)\\);`).test(js);
  out.wired.signed = new RegExp(`\\.address!==${N}\\.address&&${N}\\(${Q}wallet${Q}\\),(${N})&&\\(\\1\\.signed=!0\\);let ${N}=${N}\\(${N},${N}\\);`).test(js);
  // the page's withdraw host: the session's sign out, beside its exit and claim, into the run
  out.wired.stop = new RegExp(`\\.\\.\\.${N}\\?\\{claim:${N}\\}:\\{\\},stop:${N}\\.signal\\},\\{\\.\\.\\.${N}\\},${N}\\.to,${N}\\.amount,${N}\\.maxFee\\)`).test(js);
  // the exit's busy answer
  out.exit = new RegExp(`if\\((${N})\\.status===429\\|\\|\\1\\.status>=500&&\\1\\.status<=599\\)throw new ${esc(busy)}\\(\\1\\.status\\)`).test(js);
  // the scan's fault kept, and thrown by a reference that names no pool
  out.scan = new RegExp(`\\.catch\\((${N})=>\\(\\1 instanceof ${isTransport}&&\\((${N})\\?\\?=\\1\\),\\[\\]\\)\\)\\)\\),${N}=${N}\\(${N},${N}\\),(${N})=async (${N})=>\\{let (${N})=await \\4;if\\(\\5===null&&\\2!==null\\)throw \\2;return \\5\\}`).test(js);
  return out;
}

const NO_STEP = "BAD a withdraw step does not wait on the page's one rule (from 1 s, doubling to 10 s, 30 s a step), ended by a sign out";
const NO_FAULTS = "BAD a withdraw step's wait is not kept to the transport fault and the busy answer";
const NO_WIRED = (w) => `BAD the withdraw's ${w} does not wait out a throttle before its signature`;
const NO_SIGNED = "BAD a withdraw part is not marked signed before W signs: a signed part could be made again";
const NO_STOP = "BAD the page's withdraw host passes no sign out: a wait would hold the seed's lock";
const NO_EXIT = "BAD the exit's busy 1Click answer ends the withdraw at once";
const NO_SCAN = "BAD a throttled pool scan reads as no pools: the buy answers quote_check_failed at once";

/** The verdict on an answer { index, sha384, step, faults, wired, exit, scan }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.step !== true) lines.push(NO_STEP);
  if (a?.faults !== true) lines.push(NO_FAULTS);
  for (const w of ["plan", "part"]) if (a?.wired?.[w] !== true) lines.push(NO_WIRED(w));
  if (a?.wired?.signed !== true) lines.push(NO_SIGNED);
  if (a?.wired?.stop !== true) lines.push(NO_STOP);
  if (a?.exit !== true) lines.push(NO_EXIT);
  if (a?.scan !== true) lines.push(NO_SCAN);
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
