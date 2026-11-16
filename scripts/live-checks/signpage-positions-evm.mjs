#!/usr/bin/env node
// Live check of card signpage-positions-evm, on SIGN_HOST alone (card live-checks-read-mainnet-only: the card's Base
// Sepolia run, read back on two testnet RPCs, is signpage-positions-evm-testnet.mjs's, run once). It passes only when
// SIGN_HOST's served /app.js:
//   - is the one its index.html pins (its sha384);
//   - carries the state read that joins each EVM chain's positions after Solana's (JOIN), so a deploy that drops it
//     serves a page whose Base and Robinhood positions are never read;
//   - carries the EVM positions pass (its agreed balance's refusal, PASS_MARK): the mainnet build pins both EVM pools
//     (card evm-pools-on-mainnet), so a deploy that leaves the pass out serves a page that never shows a Base or
//     Robinhood position.
// What it cannot see from outside: the page's state itself, which needs a seed; packages/signpage/test/
// positions-evm.test.ts holds the pass.
// After: sign
// Bundle: out the served SIGN_HOST's marks; a pull request's build holds them in packages/signpage/test/positions-evm.test.ts
//   node scripts/live-checks/signpage-positions-evm.mjs [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read (its `page`), so the check's test can
//   replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

const KEY = "signpage-positions-evm";
export const SIGN = "https://confidential.unrealized.trade";
/** src/positions-evm.ts agreedBalance's refusal: only the EVM positions pass carries it. */
export const PASS_MARK = "balanceOf: the two RPCs differ";
/** src/pool-testnet.ts's state read, as minified: Solana's read first, then each EVM chain's,
 *  `positions:async()=>{let[e,...t]=await Promise.all([c.read(),...[`base`,`robinhood`].map(`, or since card
 *  move-sends-or-says-why (T1) each read bounded by STATE_READ_MS:
 *  `...Promise.all([Tz(Bt.read(),r5,`solana's positions`).catch(()=>null),...[`base`,`robinhood`].map(`. */
export const JOIN = /positions:async\(\)=>\{let ?(?:[\w$]+=[\w$]+,)*\[[\w$]+,\.\.\.[\w$]+\]=await Promise\.all\(\[(?:[\w$]+\.read\(\)|[\w$]+\([\w$]+\.read\(\),[\w$]+,`solana's positions`\)\.catch\(\(\)=>null\)),\.\.\.\[[`"]base[`"],[`"]robinhood[`"]\]\.map\(/g;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
/** What the check keeps of SIGN_HOST: its index's /app.js pin, the served bundle's sha384, and the two marks' counts. */
export function pageFacts(index, js) {
  return { pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null, sha384: sha384(js), marks: { pass: js.split(PASS_MARK).length - 1, join: [...js.matchAll(JOIN)].length } };
}

/** The page's lines: [`ok `|`BAD` + text]. */
export function judgePage(p) {
  return [
    `${typeof p?.pin === "string" && p.pin === p.sha384 ? "ok " : "BAD"} [SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`,
    `${p?.marks?.join >= 1 ? "ok " : "BAD"} [SIGN_HOST] /app.js joins each EVM chain's positions into the state read (join ${p?.marks?.join ?? "?"})`,
    `${p?.marks?.pass >= 1 ? "ok " : "BAD"} [SIGN_HOST] the mainnet build carries the EVM positions pass (both mainnet EVM pools pinned; pass ${p?.marks?.pass ?? "?"})`,
  ];
}

/** The check on one run: { page }. */
export function judge(rec) {
  const lines = judgePage(rec?.page);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), false);
  return { ok: verdict === "PASS", verdict, lines };
}

/** The run's read: SIGN_HOST's index and /app.js. */
export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`SIGN_HOST ${path}: HTTP ${r.status}`);
    return r.text();
  };
  return { readAt: new Date().toISOString(), page: pageFacts(await get("/"), await get("/app.js")) };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const rec = await read();
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    const { verdict, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
