#!/usr/bin/env node
// Live check of card sol-buy-takes-the-best-venue-it-can-trade on SIGN_HOST (https://confidential.unrealized.trade): a
// Solana buy fills through the best pool of a venue the page pins a table for, held to the coin's whole market, and the
// dry the app asks answers the tap's own decision. Reads only: nothing is signed or sent. What it holds, and only that:
// SIGN_HOST serves the script its index.html pins (its sha384), and, each found by a mark of the minified bundle's shape
// (packages/signpage/src/page-rpc.ts solanaBuyVenue, src/pool-buy.ts, src/pools.ts poolBuyDryKind, the kit's
// trade/solana/pool-buy.ts QUOTE check):
//   - decide: one decision over the reference's set and its pools under the depth cutoff (`shallow`) on the venues the
//     kit builds, the best on a pinned venue, venue_not_pinned with none, below_reference when its out is under the
//     reference's E less the slippage (x * 10000 < E * (10000 - bps));
//   - tap: the tap takes that decision on its reference, the pinned venues and the ask's slippage, and returns its
//     refusal before the venue's read;
//   - dry: pool.buy.dry takes the same decision on the same reference read, the page's pins and the ask's slippage_bps,
//     and returns its refusal;
//   - quote: the kit's QUOTE check, which every buy passes before W signs, finds the venue's pool in the set or under the
//     cutoff and fails a venue whose E is under the market's less the slippage.
// The behaviour (a coin whose deepest pool is on a venue the page cannot trade fills on its pinned one; a pinned pool far
// below that market refused below_reference; the dry and the tap answering the same per venue state) is
// packages/signpage/test/pool-buy.test.ts at the released commit. The recorded answers are facts() over
// packages/signpage/scripts/build-app.mjs's build of each tree (mainnet, as SIGN_HOST serves).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/sol-buy-takes-the-best-venue-it-can-trade.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sol-buy-takes-the-best-venue-it-can-trade";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (v) => v.replace(/\$/g, "\\$");

/** The decision (groups: the function, the reference, the pins, the slippage). */
const DECIDE = new RegExp(
  `function (${N})\\((${N}),(${N}),(${N})\\)\\{if\\(!Number\\.isInteger\\(\\4\\)\\|\\|\\4<0\\|\\|\\4>=1e4\\)return\\{error:\`quote_check_failed\`\\};` +
    `let (${N})=\\[\\.\\.\\.\\2\\?\\.pools\\?\\?\\[\\],\\.\\.\\.\\2\\?\\.shallow\\?\\?\\[\\]\\]\\.filter\\(${N}=>${N}\\.includes\\(${N}\\.venue\\)\\);if\\(\\5\\.length===0\\)return\\{error:\`quote_check_failed\`\\};` +
    `let (${N})=[^;]*?\\(\\5\\.filter\\(${N}=>\\3\\.has\\(${N}\\.venue\\)\\)\\);if\\(\\6===null\\)return\\{error:\`venue_not_pinned\`\\};` +
    `let (${N})=\\2\\.expectedOut;return \\6\\.expectedOut\\*10000n<\\7\\*BigInt\\(1e4-\\4\\)\\?\\{error:\`below_reference\`\\}:\\{pool:\\6\\}\\}`,
);
/** The tap: the decision on the reference, the venues of the pinned tables it read and the ask's slippage, its refusal returned (group: the result). */
const tapOf = (f) => new RegExp(`(${N})=${esc(f)}\\(${N},new Set\\(${N}\\.keys\\(\\)\\),${N}\\.slippageBps\\);if\\(\`error\`in \\1\\)return ${N}\\(\\1\\.error\\);let ${N}=\\1\\.pool`);
/** The dry: the decision on the awaited reference read, the page's pins and the ask's slippage_bps, its refusal returned. */
const dryOf = (f) =>
  new RegExp(
    `(${N})=${N}\\.slippage_bps===void 0\\?0:${N}\\.slippage_bps;[^]{0,400}?\\.then\\((${N})=>\\(\\{ref:\\2\\}\\),\\(\\)=>null\\):null[^]{0,300}?(${N})=(${N})===null\\?null:${esc(f)}\\(\\4\\.ref,${N}\\([^)]*\\),\\1\\);if\\(\\3!==null&&\`error\`in \\3\\)return \\3;`,
  );
/** The kit's QUOTE check: the venue's pool in the set or under the cutoff, its E held to the market's. */
const QUOTE = new RegExp(
  `(${N})=\\[\\.\\.\\.(${N})\\?\\.pools\\?\\?\\[\\],\\.\\.\\.\\2\\?\\.shallow\\?\\?\\[\\]\\]\\.find\\([^;]*?;[^]{0,600}?\\1\\.expectedOut\\*10000n<\\2\\.expectedOut\\*BigInt\\(1e4-(${N})\\)\\?${N}\\(\`QUOTE\`,\`the venue's E `,
);

/** What the check keeps of the reads: the index, the served bundle's sha384, and the marks read from it. */
export function facts(index, js) {
  const d = DECIDE.exec(js);
  return {
    index,
    sha384: sha384(js),
    decide: d !== null,
    tap: d !== null && tapOf(d[1]).test(js),
    dry: d !== null && dryOf(d[1]).test(js),
    quote: QUOTE.test(js),
  };
}

export const SAYS = Object.freeze({
  decide: "the signing page has no one venue decision (the best pool on a pinned venue, held to the coin's market): a buy of a coin whose deepest pool is on a venue the page cannot trade is refused, or one through a thin pinned pool is taken",
  tap: "the signing page's buy does not take the venue decision before its venue's read: it refuses a coin its pinned venue could fill",
  dry: "the signing page's pool.buy.dry does not answer the tap's venue decision: the trade box says a buy fills that the tap refuses",
  quote: "the kit's check before W signs does not hold the venue's out to the coin's market: a pool seeded beside the real market could be bought",
});

/** The verdict on an answer { index, sha384, decide, tap, dry, quote }. */
export function judge(a) {
  const lines = [];
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) lines.push("BAD SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) lines.push("BAD SIGN_HOST's served /app.js is not the one index.html pins");
  for (const [k, say] of Object.entries(SAYS)) if (a?.[k] !== true) lines.push(`BAD ${say}`);
  return { ok: lines.length === 0, lines };
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
