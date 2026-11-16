#!/usr/bin/env node
// Live check of card restore-waits-out-a-near-throttle on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - rule: the one throttle rule (packages/kit/src/throttle.ts throttleWaitMs: from 1 s, doubling to 10 s, a longer
//     Retry-After honoured up to 10 s);
//   - wait: the vault reads' throttle wait (packages/kit/src/vault/throttle.ts vaultAskWaited): an answer that is no
//     throttle ends the stretch and is given back, a throw that is no throttle is thrown as it is, a throttle waits the
//     rule's pause and asks again, and a stretch that would end past 30 s throws VaultThrottled;
//   - kinds: a throttle is HTTP 429 (status 429, or the exit tool's plain "HTTP 429", its Retry-After read) or a rate
//     limit in a 200 (codes 15, -429, 429), nothing else;
//   - wired: vaultSync's every view goes through the wait and a VaultThrottled stops the sync ("rpc") with its reason,
//     and the restore's config read (the wallet's readConfig) goes through it with a fresh state per provider.
// What each does is held by the card's tests (packages/kit/test/vault-sync.test.ts and
// packages/signpage/test/near-vault-restore.test.ts); the recorded answers are facts() over each tree's
// packages/signpage/index.html and public/app.js (this file reaches no package code: the import check holds it).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/restore-waits-out-a-near-throttle.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "restore-waits-out-a-near-throttle";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const out = { index, sha384: sha384(js), rule: false, wait: false, kinds: false, wired: { sync: false, config: false } };
  // the rule: its bounds object and the function over it
  const rule = new RegExp(
    `function (${N})\\((${N}),(${N}),(${N})=(${N})\\)\\{let (${N})=Number\\.isFinite\\(\\2\\)&&\\2>0\\?Math\\.min\\(\\2\\*2,\\4\\.maxMs\\):\\4\\.firstMs,(${N})=typeof \\3==${Q}number${Q}&&Number\\.isFinite\\(\\3\\)&&\\3>0\\?Math\\.min\\(\\3,\\4\\.afterMaxMs\\):0;return Math\\.max\\(\\6,\\7\\)\\}`,
  ).exec(js);
  const bounds = rule !== null && new RegExp(`[,; ]${esc(rule[5])}=Object\\.freeze\\(\\{firstMs:1e3,maxMs:1e4,afterMaxMs:1e4\\}\\)`).test(js);
  out.rule = rule !== null && bounds;
  // VaultThrottled
  const thrown = new RegExp(`[,; ](${N})=class extends Error\\{constructor\\((${N})\\)\\{super\\(\\2\\),this\\.name=${Q}VaultThrottled${Q}\\}\\}`).exec(js)?.[1];
  // the wait
  const wait = new RegExp(
    `async function (${N})\\((${N}),(${N}),(${N}),(${N}),(${N})\\)\\{for\\(;;\\)\\{let (${N});try\\{let (${N})=await \\2\\(\\);if\\(\\7=(${N})\\(\\8\\),\\7===null\\)return \\5\\.since=null,\\8\\}catch\\((${N})\\)\\{if\\(\\6\\?\\.aborted\\)throw \\6\\.reason;if\\(\\7=(${N})\\(\\10\\),\\7===null\\)throw \\10\\}let (${N})=Date\\.now\\(\\);\\5\\.since\\?\\?=\\12;let (${N})=(${N})\\(\\5\\.pause,\\7\\.afterMs\\);if\\(\\12-\\5\\.since\\+\\13>3e4\\)throw new (${N})\\([^;]{0,240}?\\);\\5\\.pause=\\13,await (${N})\\(\\13,\\6\\)\\}\\}`,
  ).exec(js);
  out.wait = wait !== null && rule !== null && wait[14] === rule[1] && thrown !== undefined && wait[15] === thrown;
  if (wait === null) return out;
  const [, W, , , , , , , , answerOf, , throwOf] = wait;
  // the kinds: HTTP 429 (status, or the plain message) with its Retry-After; a rate limit in a 200 by its codes
  const t429 = new RegExp(
    `function ${esc(throwOf)}\\((${N})\\)\\{if\\(!\\(\\1 instanceof Error\\)\\)return null;let (${N})=\\1\\.status;if\\(\\2!==429&&\\(\\2!==void 0\\|\\|\\1\\.message!==${Q}HTTP 429${Q}\\)\\)return null;let (${N})=\\1\\.retryAfterMs;return\\{words:${Q}HTTP 429${Q},afterMs:typeof \\3==${Q}number${Q}\\?\\3:null\\}\\}`,
  ).test(js);
  const codes = new RegExp(`function ${esc(answerOf)}\\((${N})\\)\\{return!(${N})\\(\\1\\)\\|\\|!\\2\\(\\1\\.error\\)\\|\\|!(${N})\\.has\\(\\1\\.error\\.code\\)\\?null:`).exec(js);
  const set = codes !== null && new RegExp(`[,; ]${esc(codes[3])}=new Set\\(\\[15,-429,429\\]\\)`).test(js);
  out.kinds = t429 && set;
  // vaultSync's view read: through the wait, a VaultThrottled a stop ("rpc") with its reason
  out.wired.sync =
    thrown !== undefined &&
    new RegExp(`=await ${esc(W)}\\(\\(\\)=>${N}\\((${N})\\.query\\((${N}),(${N})\\),\\3\\),\\1\\.name,String\\(\\2\\.method_name\\),${N},\\3\\)\\}catch\\((${N})\\)\\{throw \\3\\?\\.aborted\\?\\3\\.reason:\\4 instanceof ${esc(thrown)}\\?new ${N}\\(${Q}rpc${Q},\\4\\.message\\)`).test(js);
  // the config read: through the wait, a fresh state ({pause:0,since:null}) per provider
  const fresh = [...js.matchAll(new RegExp(`[,; ](${N})=\\(\\)=>\\(\\{pause:0,since:null\\}\\)`, "g"))].map((m) => esc(m[1]));
  out.wired.config = fresh.length > 0 && new RegExp(`=await ${esc(W)}\\(\\(\\)=>(${N})\\.query\\(${N},(${N})\\),\\1\\.name,${Q}config${Q},(?:${fresh.join("|")})\\(\\),\\2\\)`).test(js);
  return out;
}

const NO_RULE = "BAD the bundle holds no one throttle rule (from 1 s, doubling to 10 s, a Retry-After up to 10 s)";
const NO_WAIT = "BAD the vault's reads do not wait out a throttle on the one rule within 30 s, ending in VaultThrottled";
const NO_KINDS = "BAD a throttle is not HTTP 429 (with its Retry-After) and a rate limit in a 200 (15, -429, 429) alone";
const NO_SYNC = "BAD vaultSync's views do not go through the throttle wait: a NEAR provider's 429 stops the restore at once";
const NO_CONFIG = "BAD the restore's config read does not go through the throttle wait: a 429 there stalls the restore";

/** The verdict on an answer { index, sha384, rule, wait, kinds, wired: { sync, config } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.rule !== true) lines.push(NO_RULE);
  if (a?.wait !== true) lines.push(NO_WAIT);
  if (a?.kinds !== true) lines.push(NO_KINDS);
  if (a?.wired?.sync !== true) lines.push(NO_SYNC);
  if (a?.wired?.config !== true) lines.push(NO_CONFIG);
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
