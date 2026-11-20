#!/usr/bin/env node
// Live check of card taps-wait-inside-the-page on SIGN_HOST (https://confidential.unrealized.trade).
// What it holds, signed out, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as
// minified:
//   - WAIT: the pool kinds' handler sends a checked pool.buy through the page's prepared wait before its flow and its
//     Cash check (src/pool-kinds.ts afterPrepared: `n===\`pool.buy\`&&e.prepared?F(e.prepared(t.chain),o,e.stop?.()):o()`),
//     and the page hands its own wait to the pool kinds (main.ts testnetPoolDeps(..., (chain) => testnet.prepared(chain))
//     and testnetPoolDeps's `...n?{prepared:n}:{}`): a buy tapped while the device prepares its chain's spend waits for
//     it inside the request instead of answering not_funded;
//   - BOUND: that wait is src/tap-prepare.ts tapPrepared, bounded at 20 s from the tap (TAP_PREPARE_MS, `let t=e.now()+X`
//     with X 2e4, inside the tap's one 30 s bound), each next look a 250 ms step after a pass that ended at once, a sign
//     out ending it; the page's wait takes the front and joins the chain's pass in flight (`pass:()=>M.get(e)??...`),
//     never a prover run of its own beside it (no note proved twice);
//   - SPENDABLE: state.pools' spendable is computed (balances.ts: `return{...e,spendable:`) and left out of every state
//     an app of kit 1.19 or below is sent (kit-version.ts noSpendable: `e.pools===void 0?e:{...e,pools:e.pools.map(({spendable:e,...t})=>t)}`),
//     so an older app keeps reading its state.
// What the wait does is held by packages/signpage/test/tap-prepare.test.ts and tap-prepare-page.test.ts; spendable by
// packages/wallet/test/pool-spendable.test.ts and packages/signpage/test/kit-version.test.ts.
// The recorded answers are facts() over each tree's packages/signpage/index.html and app.js as build-app.mjs builds them.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/taps-wait-inside-the-page.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "taps-wait-inside-the-page";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const ID = "[\\w$]+";
// the handler: a pool.buy through the prepared wait, its flow (with Cash first) only after it
const HANDLER = new RegExp(`return (${ID})===\`pool\\.buy\`&&(${ID})\\.prepared\\?${ID}\\(\\2\\.prepared\\((${ID})\\.chain\\),(${ID}),\\2\\.stop\\?\\.\\(\\)\\):\\4\\(\\)\\}`);
// the page's deps carry the wait, and main hands the page's own to them
const DEPS = new RegExp(`\\.\\.\\.(${ID})\\?\\{prepared:\\1\\}:\\{\\}\\}`);
const MAIN = new RegExp(`\\(${ID}\\?\\.flow,(${ID})\\?\\(\\)=>\\1\\.outSignal\\(\\):void 0,\\1\\?(${ID})=>\\1\\.prepared\\(\\2\\):void 0\\)`);
// the wait itself: its bound from the tap, its look, its pass, its step
const BOUND = new RegExp(`var (${ID})=2e4,[\\s\\S]{0,400}?async function ${ID}\\((${ID})\\)\\{let (${ID})=\\2\\.now\\(\\)\\+\\1,[\\s\\S]{0,300}?!await \\2\\.preparing\\(\\)\\.catch\\(\\(\\)=>!1\\)\\)return;[\\s\\S]{0,200}?Math\\.min\\(250-[\\s\\S]{0,500}?\\2\\.pass\\(\\)[\\s\\S]{0,200}?<250&&`);
// the page's wait: the front first, then the pass in flight joined
const PAGE = new RegExp(`prepared:async (${ID})=>\\{let (${ID})=await ${ID}\\.tap\\(\\)\\.catch\\(\\(\\)=>null\\);if\\(\\2!==null\\)try\\{await ${ID}\\(\\{preparing:\\(\\)=>${ID}\\(\\1\\),pass:\\(\\)=>${ID}\\.get\\(\\1\\)\\?\\?`);
const SPENDABLE = /return\{\.\.\.[\w$]+,spendable:[\w$]+\(/;
const NO_SPENDABLE = /([\w$]+)=>\1\.pools===void 0\?\1:\{\.\.\.\1,pools:\1\.pools\.map\(\(\{spendable:[\w$]+,\.\.\.([\w$]+)\}\)=>\2\)\}/;

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), wait: HANDLER.test(js) && DEPS.test(js) && MAIN.test(js), bound: BOUND.test(js) && PAGE.test(js), spendable: SPENDABLE.test(js) && NO_SPENDABLE.test(js) };
}

/** The verdict on an answer { index, sha384, wait, bound, spendable }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.wait !== true) bad("a pool.buy tapped while its chain's spend is prepared goes to its flow at once: refused not_funded, or Cash moved for money the pool holds");
  if (a?.bound !== true) bad("the tap's wait for its chain's spend is not the bounded one that joins the pass in flight");
  if (a?.spendable !== true) bad("state.pools carries no spendable, or an app of kit 1.19 or below is sent it");
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
