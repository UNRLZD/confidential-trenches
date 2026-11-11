#!/usr/bin/env node
// Live check of card sell-right-after-a-buy on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and only
// that: the host serves the script its index.html pins (its sha384), and that script
//   - writes W's buy record when the buy's run tells the amount W received (packages/signpage/src/pool-testnet.ts
//     recordedBuy, as minified: `route:e=>(d(e),`out`in e&&s())`), so the sale's plan, the sell box's preview and the
//     positions have W's token from the buy's Filled, not from its Final (devnet runs 11 and 12, 11 Nov: not_funded for
//     54 s after Filled);
//   - takes that record back at a not_landed or refused end, only when it is this buy's own (src/positions.ts
//     recordPoolBuy, as minified: `r?.mint===s.mint&&r.received===s.received&&delete t[n.wallet]`);
//   - reads the buy as a trade's to its land and as a background pass's after it, its hosts' hold given back at its
//     early sent (pool-testnet.ts buyReads, as minified: `let n=`trade`;return{rpcs:KG(e,()=>n),kind:()=>n,release:t,
//     landed:()=>{n=`pass`}}`), on one pair whose each call goes as that kind says (kindSwitched, as minified:
//     `[0,1].map(n=>Lh(e.trade[n],(r,i)=>e[t()][n](r,i)))`), the land told by the run once its read-back landed
//     (pool-buy.ts, as minified: `if(!F)return k(P?M:[],j);e.landed?.()`), so the reads that tell Filled are a trade's
//     and a sale tapped after Filled reads first (devnet run 11: 20 throttles in 16.3 s, drawn by the buy's reads to
//     Final).
// The behaviour itself is held by the tests that build it (packages/signpage/test/sell-right-after-a-buy.test.ts,
// positions.test.ts, passes-yield.test.ts and pool-buy.test.ts). The recorded answers are facts() over the signing
// page's build (build-app.mjs, the build the deploy makes): good at this card's head, before at its base.
// After: sign
//   node scripts/live-checks/sell-right-after-a-buy.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sell-right-after-a-buy";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const Q = "[`\"']";
/** The buy's route: each fact into the run's facts, then W's record once it is the amount out. */
const EARLY = new RegExp(`route:(${N})=>\\((${N})\\(\\1\\),${Q}out${Q}in \\1&&${N}\\(\\)\\)`);
/** The end's take-back: W's record deleted only when it is this buy's token and amount. */
const TAKE_BACK = new RegExp(`(${N})\\?\\.mint===(${N})\\.mint&&\\1\\.received===\\2\\.received&&delete ${N}\\[`);
/** The buy's reads: a trade's at first, the hold given back at the release, the kind set to pass at the land alone. */
const RELEASE = new RegExp(`let (${N})=${Q}trade${Q};return\\{rpcs:${N}\\(${N},\\(\\)=>\\1\\),kind:\\(\\)=>\\1,release:${N},landed:\\(\\)=>\\{\\1=${Q}pass${Q}\\}\\}`);
/** The run's land: told once the read-back loop has landed, right after its not-landed return. */
const LANDED = new RegExp(`return ${N}\\(${N}\\?${N}:\\[\\],${N}\\);${N}\\.landed\\?\\.\\((?:${N}\\.noteId,${N}\\.attempt,${N}\\.withdrawnValue)?\\)`);
/** The pair: each seat the trade pair's provider, each call on the kind's pair at that call. */
const SWITCH = new RegExp(`\\[0,1\\]\\.map\\((${N})=>${N}\\((${N})\\.trade\\[\\1\\],\\((${N}),(${N})\\)=>\\2\\[${N}\\(\\)\\]\\[\\1\\]\\(\\3,\\4\\)\\)\\)`);

/** The script an index.html pins, and its integrity. */
const pinned = (index) => {
  const m = /<script[^>]*\bsrc="([^"]+\.js)"[^>]*\bintegrity="([^"]+)"/.exec(index ?? "") ?? /<script[^>]*\bintegrity="([^"]+)"[^>]*\bsrc="([^"]+\.js)"/.exec(index ?? "");
  if (!m) return null;
  return m[1].endsWith(".js") ? { src: m[1], integrity: m[2] } : { src: m[2], integrity: m[1] };
};

/** What the check keeps of the read: the index, its served script's sha384, and each mark read from it. */
export function facts(sign) {
  return { index: sign.index, sha384: sha384(sign.js), early: EARLY.test(sign.js), takeBack: TAKE_BACK.test(sign.js), release: RELEASE.test(sign.js), pair: SWITCH.test(sign.js), landed: LANDED.test(sign.js) };
}

/** The verdict on an answer { index, sha384, early, takeBack, release, pair, landed }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = pinned(a?.index);
  if (!pin) bad("SIGN_HOST's index.html pins no script");
  else if (pin.integrity !== a.sha384) bad("SIGN_HOST's served script is not the one index.html pins");
  if (a?.early !== true) bad("the buy's record is written only at its end: a sale, the preview and the positions do not have W's token at Filled");
  if (a?.takeBack !== true) bad("a buy that did not land keeps its record: a position shows that was never bought");
  if (a?.release !== true) bad("the buy's reads do not go as the background's from its land, or switch at its sent: a sale tapped after Filled waits, or Filled does");
  if (a?.pair !== true) bad("the buy's pair does not read as its kind says at each call");
  if (a?.landed !== true) bad("the buy's run does not tell its land: its reads stay a trade's to Final");
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${SIGN}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  const pin = pinned(index);
  return facts({ index, js: pin ? await get(pin.src.startsWith("/") ? pin.src : `/${pin.src}`) : "" });
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
