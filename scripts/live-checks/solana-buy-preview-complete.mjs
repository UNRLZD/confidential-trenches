#!/usr/bin/env node
// Live check of card solana-buy-preview-complete on SIGN_HOST (https://confidential.unrealized.trade): a Solana pool
// buy's dry answer says what the buy gets, so the trade box's You receive fills. Its screens' half is
// solana-buy-preview-complete-screens.mjs (APP_HOST). Reads only: nothing is signed or sent. What it holds, and only
// that: SIGN_HOST serves the script its index.html pins (its sha384), and, each found by a mark of the minified bundle's
// shape (packages/signpage/src/pools.ts poolBuyDryKind, src/kit-version.ts, packages/kit/src/trade/solana/pool-buy.ts):
//   - quote: pool.buy.dry with an amount starts the device's own quote of it (pageReference, side buy, on the page's
//     pair) before it reads the proofs, a failed read being no quote (`.catch(()=>null)`), so the quote adds no wait
//     after the proofs and the venue;
//   - out: its answer carries `out`, the best of pump's curve and PumpSwap in that quote (the venue the buy itself
//     takes, src/pool-buy.ts), its expected out at the mint's decimals, beside the pieces and cost, and none when the
//     quote or the decimals are not read;
//   - decimals: the venue read takes the mint's decimals from byte 44 of the mint both providers gave, after a length
//     check, and puts them on the venue it gives;
//   - level: a kit-v1.13 app is read at its own level (`(1,13)?`1.13``), and at that level pool.buy.dry's answer goes
//     with out left out (kit-v1.13's schema refuses the whole answer for it: its Fee and Max would go too);
//   - version: the page reads every kit at 1.14 and above in full (SIGNPAGE_KIT_VERSION `1.14`).
// The numbers (out equal to the buy's own quote on a curve coin and a PumpSwap coin, recorded from mainnet; no out when
// the quote's read fails; each level's strip) are packages/signpage/test/pool-buy-dry.test.ts and kit-version.test.ts at
// the released commit. The recorded answers are facts() over packages/signpage/scripts/build-app.mjs's build of each
// tree (mainnet, as SIGN_HOST serves).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/solana-buy-preview-complete.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "solana-buy-preview-complete";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (v) => v.replace(/\$/g, "\\$");

/** The quote started before the proofs' read (groups: the quote, the amount). */
const QUOTE = new RegExp(`(${N})=(${N})!==null&&\\2>0n\\?${N}\\(${N},\\{side:\`buy\`,token:${N},amount:\\2\\}\\)\\.catch\\(\\(\\)=>null\\):null,${N}=await ${N}\\.ready\\(\\)`);
/** The out of the best of the two venues in that quote, at the venue's decimals, in the answer (group: the quote). */
const outOf = (quote) =>
  new RegExp(
    `(${N})=\\(await ${esc(quote)}\\)\\?\\.pools\\.filter\\((${N})=>\\2\\.venue===\`pump-curve\`\\|\\|\\2\\.venue===\`pumpswap\`\\)\\.sort\\(\\((${N}),(${N})\\)=>\\3\\.expectedOut>\\4\\.expectedOut\\?-1:1\\)\\[0\\],(${N})=\\1!==void 0&&(${N})\\.decimals!==void 0&&\\1\\.expectedOut>0n\\?${N}\\(\\1\\.expectedOut,\\6\\.decimals\\):void 0;return\\{result:\\{tap_max:${N},pieces:(${N})\\.length,cost:${N}\\(\\7\\.reduce\\([^;]*?\\)\\),\\.\\.\\.\\5===void 0\\?\\{\\}:\\{out:\\5\\}\\}\\}`,
  );
/** The mint's decimals, byte 44 after a length check (group: the decimals). */
const DECIMALS = new RegExp(`if\\((${N})\\.data\\.length<82\\)throw Error\\(\`the mint is shorter than a mint\`\\);let (${N})=\\1\\.data\\[44\\]`);
/** kit-v1.13's level in the version chain. */
const LEVEL = new RegExp(`${N}\\(1,13\\)\\?\`1\\.13\`:${N}\\(1,12\\)\\?\`1\\.12\``);
/** The strip of a dry buy's out (group: its function). */
const STRIP = new RegExp(`(${N})=\\((${N}),(${N})\\)=>\\{if\\(typeof \\3!=\`object\`\\|\\|!\\3\\|\\|\\2!==\`pool\\.buy\\.dry\`\\)return \\3;let\\{out:${N},\\.\\.\\.(${N})\\}=\\3;return \\4\\}`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and the marks read from it. */
export function facts(index, js) {
  const quote = QUOTE.exec(js);
  const out = quote ? outOf(quote[1]).exec(js) : null;
  const dec = DECIMALS.exec(js);
  const strip = STRIP.exec(js);
  // the strip is what kit-v1.13's level returns: its result returned at that level, before any other strip
  const atLevel = strip ? new RegExp(`let (${N})=${esc(strip[1])}\\(${N},${N}\\);if\\(${N}===\`1\\.13\`\\)return \\1;`).test(js) : false;
  return {
    index,
    sha384: sha384(js),
    quote: quote !== null,
    out: out !== null,
    // the venue read gives the decimals it read, on both venues' venue objects
    decimals: dec !== null && (js.match(new RegExp(`decimals:${esc(dec[2])},`, "g")) ?? []).length >= 2,
    level: LEVEL.test(js) && atLevel,
    version: /`1\.14`/.test(js),
  };
}

export const SAYS = Object.freeze({
  quote: "the signing page's pool.buy.dry does not quote the asked amount beside the proofs: the box's You receive has nothing to draw",
  out: "the signing page's pool.buy.dry answers no out (the best venue's expected out at the mint's decimals): the box's You receive stays a dash",
  decimals: "the venue read gives no mint decimals read from the mint both providers gave: out cannot be written in whole tokens",
  level: "a kit-v1.13 app is not sent pool.buy.dry's answer with out left out: its schema refuses the whole answer, and its Fee and Max with it",
  version: "the signing page does not read a kit 1.14 app in full: out never reaches the app that draws it",
});

/** The verdict on an answer { index, sha384, quote, out, decimals, level, version }. */
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
