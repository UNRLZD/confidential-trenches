#!/usr/bin/env node
// Live check of card sell-first-read-waits-out-a-throttle on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - kept: the decimals read (pool-kinds.ts keptTokenDecimals) answers from the page's store before any read, the store
//     keyed per chain and token (a Solana key as it is, an EVM address in lower case), and keeps what it read;
//   - wired: that store is the page's one (testnetPoolDeps' decimals), the Solana buy keeps its own read in it (the buy
//     host's outDecimals), the EVM buy reads through it with no wait (waits:0; the EVM buy is in the testnet build only,
//     so on SIGN_HOST's mainnet build its host is absent: "none"), and the sell reads through it;
//   - wait: a provider that fails is asked again only after the page's one wait rule (read-waits.ts readWaits, card
//     start-reads-wait-out-a-throttle: the wallet's throttleWaitMs from 1 s, doubling, up to 10 s, a Retry-After to
//     10 s), none with waits 0; past the rule's total the failure is thrown;
//   - down: the sell answers down only for a failed read, not_allowed for two answers that disagree.
// What each does is held by the card's tests (packages/signpage/test/pool-kinds-decimals.test.ts, the page's buy-then-
// sell test in positions.test.ts); the recorded answers are facts() over each tree's packages/signpage/index.html and
// public/app.js (this file reaches no package code: the import check holds it). The card's proof on what is deployed is
// the app's devnet sell run (card app-sell-e2e-in-the-app); this check holds the code that run depends on.
// After: sign
//   node scripts/live-checks/sell-first-read-waits-out-a-throttle.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sell-first-read-waits-out-a-throttle";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");
// the read: async function F(chain,token,rpcs,o={}){let k=o.kept??S,a=k.get(..);if(a!==void 0)return a;
const READ = new RegExp(`async function (${N})\\(${N},${N},${N},(${N})=\\{\\}\\)\\{let (${N})=\\2\\.kept\\?\\?(${N}),(${N})=\\3\\.get\\(${N},${N}\\);if\\(\\5!==void 0\\)return \\5;`);
const BODY = 1_500;
// the EVM buy's host (pool-buy-evm.ts evmBuyHost): the kit's quote and build, then the token's decimals
const EVM_BUY_HOST = new RegExp(`quote:${N},build:${N},decimals:`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const out = { index, sha384: sha384(js), kept: false, wired: { page: false, solanaBuy: false, evmBuy: false, sell: false }, wait: false, down: false };
  const m = READ.exec(js);
  if (!m) return out;
  const [, F, , , S] = m;
  const body = js.slice(m.index, m.index + BODY);
  // the store: S made by a factory keyed per chain and token, and the read keeps what it read in the store it read
  const made = new RegExp(`[,; ]${esc(S)}=(${N})\\(\\)`).exec(js);
  const factory = made ? new RegExp(`function ${esc(made[1])}\\(\\)\\{let (${N})=new Map,(${N})=\\((${N}),(${N})\\)=>${Q}\\$\\{\\3\\} \\$\\{\\3===${Q}solana${Q}\\?\\4:\\4\\.toLowerCase\\(\\)\\}${Q};return\\{get:`).test(js) : false;
  out.kept = factory && new RegExp(`${esc(m[3])}\\.keep\\(${N},${N},${N}\\),${N}\\}`).test(body);
  out.wired = {
    page: new RegExp(`rpcs:${N}=>[^]{0,120}?,decimals:${esc(S)},`).test(js),
    solanaBuy: new RegExp(`outDecimals:\\((${N}),(${N}),(${N})\\)=>\\{[^}]{0,80}${esc(S)}\\.keep\\(${Q}solana${Q},\\3,\\2\\)\\}`).test(js),
    // the EVM buy is in the testnet build only (pool-testnet.ts evmBuy): "none" where the build holds no EVM buy host
    evmBuy: new RegExp(`decimals:${N}=>${esc(F)}\\([^)]{0,80}\\{waits:0\\}\\)`).test(js) || (EVM_BUY_HOST.test(js) ? false : "none"),
    sell: new RegExp(`after:${esc(F)}\\(${N},${N}\\.token,${N},\\{kept:`).test(js),
  };
  // the wait: none with waits 0, else the request's waits or the rule's own; null (its bound spent): the failure thrown
  const loop = new RegExp(`(${N})=(${N})\\.waits===0\\?null:(?:\\2\\.waits\\?\\?)?(${N})\\(\\)[^]*?(${N})=\\1===null\\?null:\\1\\.next\\((${N})\\);if\\(\\4===null\\)throw \\5;`).exec(body);
  // the rule: next(e) = T(pause, Retry-After of e, B), its bound on a clock (card start-reads-wait-out-a-throttle)
  const fn = loop ? new RegExp(`function ${esc(loop[3])}\\((${N})=${N}\\)\\{let (${N})=\\1\\(\\),(${N})=0,(${N})=0(?:,${N}=!1)?;return\\{next\\((${N})\\)\\{let (${N})=(${N})\\(\\3,(${N})\\(\\5\\),(${N})\\);`).exec(js) : null;
  const def = fn ? new RegExp(`[,; ]${esc(fn[9])}=Object\\.freeze\\(\\{firstMs:(${N}),maxMs:(${N}),afterMaxMs:\\2\\}\\)`).exec(js) : null;
  if (fn && def) {
    const T = fn[7];
    const rule = new RegExp(`function ${esc(T)}\\((${N}),(${N}),(${N})=${N}\\)\\{let ${N}=Number\\.isFinite\\(\\1\\)&&\\1>0\\?Math\\.min\\(\\1\\*2,\\3\\.maxMs\\):\\3\\.firstMs,${N}=typeof \\2==${Q}number${Q}&&Number\\.isFinite\\(\\2\\)&&\\2>0\\?Math\\.min\\(\\2,\\3\\.afterMaxMs\\):0;return Math\\.max\\(`).test(js);
    const value = (name) => (/^[\d.e]+$/.test(name) ? name : new RegExp(`[,; ]${esc(name)}=([\\d.e]+)[,;]`).exec(js)?.[1]);
    out.wait = rule && Number(value(def[1])) === 1_000 && Number(value(def[2])) === 10_000;
  }
  // down only for a failed read: a rule's refusal (two answers that disagree) is not_allowed (a sign out's stop, since
  // card start-reads-wait-out-a-throttle, failed)
  const no = new RegExp(`,(${N})=>\\{(${N})=\\1 instanceof ${N}\\?(${N}):(?:\\1 instanceof ${N}\\?${N}:)?(${N})\\}\\)(?:\\.then\\(\\(\\)=>${N}\\(${N},${N}\\)\\))?,answer:\\(\\)=>\\2\\}`).exec(js.slice(js.indexOf(`after:${F}(`)));
  if (no) out.down = new RegExp(`[,; ]${esc(no[4])}=Object\\.freeze\\(\\{error:${Q}down${Q}\\}\\)`).test(js) && new RegExp(`[,; ]${esc(no[3])}=Object\\.freeze\\(\\{error:${Q}not_allowed${Q}\\}\\)`).test(js);
  return out;
}

const NO_KEPT = "BAD a token's decimals are not kept for the session: every sell reads them again, on a provider a buy just throttled";
const NO_WIRED = (w) => `BAD the kept decimals are not the page's one store on every path: ${w} reads or keeps apart`;
const NO_WAIT = "BAD the sell's first read does not wait out a provider that fails on the wallet's throttle rule: one throttle answers down";
const NO_DOWN = "BAD the sell's first read answers down for two answers that disagree, or not_allowed for a failed read";

/** The verdict on an answer { index, sha384, kept, wired, wait, down }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.kept !== true) lines.push(NO_KEPT);
  for (const w of ["page", "solanaBuy", "evmBuy", "sell"]) if (a?.wired?.[w] !== true && !(w === "evmBuy" && a?.wired?.[w] === "none")) lines.push(NO_WIRED(w));
  if (a?.wait !== true) lines.push(NO_WAIT);
  if (a?.down !== true) lines.push(NO_DOWN);
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
