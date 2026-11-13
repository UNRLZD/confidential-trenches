#!/usr/bin/env node
// Live check of card evm-pass-in-two-seconds: a Base or Robinhood landing's pass on SIGN_HOST
// (https://confidential.unrealized.trade), the reads between the landing and its proof, takes about 2 s (3 rounds of a
// host's answer), not 16 (the owner's mainnet copy, lrb run: pass 15.9 s of ready 25.85 s). What each part does, and
// the 3 rounds against 900 ms hosts, is held by the wallet's test/pool-evm-pass-rounds.test.ts (27 rounds, 24.4 s
// before this card) and test/pool-evm.test.ts; this check holds that SIGN_HOST serves that code. It passes only when
// SIGN_HOST's served /app.js is the one its index.html pins (its sha384), and in it, as minified, each exactly once:
//   - held (packages/wallet/src/pool/evm.ts evmPool feeAt): a held period's first block is taken as held, with no read
//     of it on both RPCs (the shape before this card, heldBlock's `x?.hash===h.hash&&y?.hash===h.hash?h.block:null`,
//     is gone);
//   - fee (evmPool now): the pool's time read asks the helper's period fee at once (relayFees.get of that period);
//   - batched (evmTreeSync round): the seats' logs past the held part are read in the same round trip as the finalized
//     anchor and the views, judged by that anchor once it is in (evmAgreedLogs with `{fin:<the anchor's read>}`);
//   - cut (evmTreeSync trees and evmPool trees): a period's cut is the round's leaves below the held first block
//     (`events.findIndex(e=>e.block>=first.number)`), the pool handing the sync that block;
//   - newest (evmTreeSync trees): a newest read takes the last round when its anchor is at or past the caller's now;
//   - depth (evmTreeSync depthAt): the depth at a block the last round found at its height is that round's, no read.
// After: sign
//   node scripts/live-checks/evm-pass-in-two-seconds.mjs [--local] [--record <file>]
//   PASS exit 0, FAIL 1, error 2. --local judges this tree's SIGN_HOST build (signBuilt) in SIGN_HOST's place; --record
//   writes what the run read, which evm-pass-in-two-seconds.test.mjs replays. Reads only.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

export const KEY = "evm-pass-in-two-seconds";
export const SIGN = "https://confidential.unrealized.trade";

const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");
const count = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length;
const once = (re, js) => count(re, js) === 1;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** feeAt's held block: `let u=c.get(i)?.block??await rE(t,i,o,s)`. */
const HELD = new RegExp(`let (${N})=(${N})\\.get\\((${N})\\)\\?\\.block\\?\\?await (${N})\\((${N}),\\3,(${N}),(${N})\\)`);
/** heldBlock before this card: `return a?.hash===r.hash&&o?.hash===r.hash?r.block:null`. */
const HELD_READ = new RegExp(`(${N})\\?\\.hash===(${N})\\.hash&&(${N})\\?\\.hash===\\2\\.hash\\?\\2\\.block:null`);
/** evmPool now: `async now(e){let t=await a.now(e);return typeof t==\`bigint\`&&t>0n&&d.get(t-t%fw,e).catch(()=>{}),t}`. */
const FEE = new RegExp(`async now\\((${N})\\)\\{let (${N})=await ${N}\\.now\\(\\1\\);return typeof \\2==\`bigint\`&&\\2>0n&&${N}\\.get\\(\\2-\\2%${N},\\1\\)\\.catch\\(\\(\\)=>\\{\\}\\),\\2\\}`);
/** The round's early pages, a later round's tail of one page's span: `D=E(_w,C),M=null;d&&!p&&!m&&w.number>u&&
 *  w.number-u<=10000n&&(M=IT(t,y,b,u+1n,{fin:D,anchor:w},v,l.length,C,c),M.catch(()=>{}));let[P,F,I,L,R,z]=await
 *  Promise.all([D,`. */
const BATCHED = new RegExp(`(${N})=${N}\\(${N},(${N})\\),(${N})=null;${N}&&!${N}&&!${N}&&(${N})\\.number>(${N})&&\\4\\.number-\\5<=10000n&&\\(\\3=(${N})\\(${N},${N},${N},\\5\\+1n,\\{fin:\\1,anchor:\\4\\},${N},${N}\\.length,\\2,${N}\\),\\3\\.catch\\(\\(\\)=>\\{\\}\\)\\);let\\[${N}(?:,${N}){5}\\]=await Promise\\.all\\(\\[\\1,`);
/** The sync's cut below the first block: `let t=i.events.findIndex(e=>e.block>=r.number);t<0&&(t=i.events.length);`. */
const CUT = new RegExp(`let (${N})=(${N})\\.events\\.findIndex\\((${N})=>\\3\\.block>=(${N})\\.number\\);\\1<0&&\\(\\1=\\2\\.events\\.length\\);`);
/** evmPool trees: `async trees(e,t,n){let r=n?.newest===!0?void 0:c.get(e);if(r===void 0)return a.trees(e,t,n);try{return
 *  await a.trees(e,t,{...n,first:r.block})}catch(i){if(!(i instanceof rT)||!await u(e,r,t))throw i;return a.trees(e,t,n)}}`
 *  (the search only when nothing is held, or the held block was replaced). */
const HANDS = new RegExp(`async trees\\((${N}),(${N}),(${N})\\)\\{let (${N})=\\3\\?\\.newest===!0\\?void 0:${N}\\.get\\(\\1\\);if\\(\\4===void 0\\)return (${N})\\.trees\\(\\1,\\2,\\3\\);try\\{return await \\5\\.trees\\(\\1,\\2,\\{\\.\\.\\.\\3,first:\\4\\.block\\}\\)\\}catch\\((${N})\\)\\{if\\(!\\(\\6 instanceof ${N}\\)\\|\\|!await (${N})\\(\\1,\\4,\\2\\)\\)throw \\6;return \\5\\.trees\\(\\1,\\2,\\3\\)\\}\\}`);
/** trees' newest read: `let i=n?.newest===!0&&O!==null&&O.anchor.timestamp*1000n>=e-1n?O:await P(t,r);`. */
const NEWEST = new RegExp(`let (${N})=(${N})\\?\\.newest===!0&&(${N})!==null&&\\3\\.anchor\\.timestamp\\*1000n>=(${N})-1n\\?\\3:await (${N})\\((${N}),(${N})\\);`);
/** depthAt: `let i=O;if(r!==void 0&&i!==null&&i.firsts.has(\`${e}:${r}\`))return Promise.resolve(`. */
const DEPTH = new RegExp(`let (${N})=${N};if\\((${N})!==void 0&&\\1!==null&&\\1\\.firsts\\.has\\(\`\\$\\{(${N})\\}:\\$\\{\\2\\}\`\\)\\)return Promise\\.resolve\\(`);

/** What the check keeps of SIGN_HOST's build: its pin and sha384, and each part found exactly once. */
export function pageFacts(index, js) {
  return {
    pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null,
    sha384: sha384(js),
    held: once(HELD, js) && count(HELD_READ, js) === 0,
    fee: once(FEE, js),
    batched: once(BATCHED, js),
    cut: once(CUT, js) && once(HANDS, js),
    newest: once(NEWEST, js),
    depth: once(DEPTH, js),
  };
}

/** SIGN_HOST's index and /app.js through `fetchFn` (bundle-checks: the build, as the host serves it): { from, page }. */
export async function readBundle(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`SIGN_HOST ${p}: HTTP ${r.status}`);
    return r.text();
  };
  return { from: SIGN, page: pageFacts(await get("/"), await get("/app.js")) };
}

/** The verdict on { page }: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = run?.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(p?.held === true, "[SIGN_HOST] a held period's first block is taken with no read of it again (held)");
  say(p?.fee === true, "[SIGN_HOST] the pool's time read asks the helper's period fee at once, beside the pass's reads (fee)");
  say(p?.batched === true, "[SIGN_HOST] a round reads its logs in the same round trip as the finalized anchor and the views (batched)");
  say(p?.cut === true, "[SIGN_HOST] a period's cut is the round's leaves below the held first block, with no root time read (cut)");
  say(p?.newest === true, "[SIGN_HOST] a newest read takes the pass's own round, with no wait for a later block (newest)");
  say(p?.depth === true, "[SIGN_HOST] the bind's depth at the first block is the round's that found it, with no read (depth)");
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** SIGN_HOST's index and /app.js, or this tree's build with `local`. */
export async function read(fetchFn = fetch, { local = false } = {}) {
  const page = local ? pageFacts(readFileSync(path.join(signBuilt(), "index.html"), "utf8"), readFileSync(path.join(signBuilt(), "public/app.js"), "utf8")) : (await readBundle(fetchFn)).page;
  return { readAt: new Date().toISOString(), from: local ? "local build" : SIGN, page };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = await read(fetch, { local: a.includes("--local") });
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(verdict === "PASS" ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
