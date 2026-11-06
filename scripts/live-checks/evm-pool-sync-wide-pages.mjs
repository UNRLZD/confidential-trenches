#!/usr/bin/env node
// Live check of card evm-pool-sync-wide-pages on SIGN_HOST (https://sign.confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384), and the wallet's EVM pool sync in it
// (packages/wallet/src/pool/evm.ts evmPoolLogPager, readLogs, evmTreeSync), as minified:
//   - pages each provider on its own (a Map by the seat's provider URL), from a first page of 100,000 blocks, growing
//     to a widest page of at least that;
//   - is the pager the pool sync reads the pool's own filter with (its address and the three event topics);
//   - never halves a page on no answer in time where the rules say so (slowHalves false): such a page is asked again
//     as a throttle is, or taken back to the widest its provider answered.
// At today's 10,000-block page a month-old Base pool (about 13M blocks at 200 ms) was about 1,300 pages a provider, so
// a new device's restore took minutes. The pager's paths are held by packages/wallet/test/pool-evm.test.ts (card
// evm-pool-sync-wide-pages: the 13M-block span, a refusal on one provider, the held sync).
// The recorded answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg) of this card's tree
// (mainnet, as SIGN_HOST serves) and over SIGN_HOST as served before this card's deploy; this file reaches no package
// code (the import check holds it).
//   node scripts/live-checks/evm-pool-sync-wide-pages.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-pool-sync-wide-pages";
export const SIGN = "https://sign.confidential.unrealized.trade";
/** The pool sync's first page, in blocks (packages/wallet/src/pool/evm.ts EVM_POOL_LOG_PAGE_BLOCKS). */
export const FIRST = 100_000;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** evmPoolLogPager: a Map of pages by the provider's URL (else its index), each new one at the first size. */
const PAGER = /function ([\w$]+)\(\)\{let ([\w$]+)=new Map;return\{rules:\{max:([\w$]+),ceilingPages:(\d+),slowHalves:(!0|!1)\},of\(([\w$]+),([\w$]+)\)\{let ([\w$]+)=\6\.url,([\w$]+)=typeof \8==`string`\?\8:`rpc \$\{\7\}`,([\w$]+)=\2\.get\(\9\);return \10===void 0&&\2\.set\(\9,\10=\{size:([\w$]+),answered:null\}\),\10\}\}\}/;
/** readLogs' throttle branch: a throttle, a one-block page, or any timeout where the rules do not halve on one. */
const RETRY = /if\(([\w$]+)!==null&&\(\1\.kind===`throttle`\|\|([\w$]+)===([\w$]+)\|\|!([\w$]+)\)\)\{if\(\+\+([\w$]+)>=\d+\)throw ([\w$]+);/;
/** The rules' slowHalves read into readLogs' own name: `let{max:l,slowHalves:u}=o.rules`. */
const RULES = /let\{max:[\w$]+,slowHalves:([\w$]+)\}=[\w$]+\.rules/;
/** Every top-level bigint constant `X=123n`, by its name. */
const BIGS = /(?:^|[,;{\s(])([\w$]+)=(\d+)n(?=[,;)}])/g;

/** What the check keeps of the reads: the index, the served bundle's sha384, and the facts read from the bundle. */
export function facts(index, js) {
  const bigs = new Map();
  for (const m of js.matchAll(BIGS)) if (!bigs.has(m[1])) bigs.set(m[1], Number(m[2]));
  const p = PAGER.exec(js);
  const retry = RETRY.exec(js);
  const rules = RULES.exec(js);
  const fn = p?.[1];
  // the pool sync makes its pager, then its pool filter: the pool's address and its three topics in one position
  const used = fn !== undefined && new RegExp(`=${fn.replace(/\$/g, "\\$")}\\(\\),[\\w$]+=\\{address:[\\w$]+,topics:\\[\\[[\\w$]+,[\\w$]+,[\\w$]+\\]\\]\\}`).test(js);
  return {
    index,
    sha384: sha384(js),
    pager: p?.[0] ?? null,
    first: p ? (bigs.get(p[11]) ?? null) : null,
    max: p ? (bigs.get(p[3]) ?? null) : null,
    slowHalves: p ? p[5] === "!0" : null,
    usedBySync: used,
    retry: retry !== null && rules !== null && retry[4] === rules[1] ? retry[0] : null,
  };
}

/** The verdict on an answer { index, sha384, pager, first, max, slowHalves, usedBySync, retry }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.pager !== "string") {
    bad("the bundle's pool sync has no page for each provider: it pages from 10,000 blocks, about 1,300 pages a provider for a month-old Base pool");
    return { ok: false, lines };
  }
  if (a.first !== FIRST) bad(`the pool sync's first page is ${a.first} blocks, not ${FIRST}`);
  if (typeof a.max !== "number" || a.max < FIRST) bad(`the pool sync's widest page is ${a.max} blocks, under its first ${FIRST}`);
  if (a.slowHalves !== false) bad("the pool sync halves a page on no answer in time");
  if (a.usedBySync !== true) bad("the pool sync does not read the pool's logs with this pager");
  if (typeof a.retry !== "string") bad("the pager's reads do not ask a page with no answer in time again at its size");
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
