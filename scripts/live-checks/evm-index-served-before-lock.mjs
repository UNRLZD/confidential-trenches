#!/usr/bin/env node
// Live check of card evm-index-served-before-lock on SIGN_HOST (https://confidential.unrealized.trade). Release 176's
// page served the device's kept EVM pool index (or the shipped snapshot) to the kit's quote only inside the Web Lock
// ct-evm-index/{chain} (pool-testnet.ts evmIndexServe), so a tab that found the lock held by another was served none
// and its quote scanned the chain's Initialize logs from the depth: a mainnet read-only Robinhood quote in such a tab
// (18 Nov 19:01Z, Node, main 2e427f24b's page code with the lock held) read 56 Initialize getLogs below the snapshot's
// end (117,445,721), from block 107,627,310, and ended stale_quote at 33 s, where the fixed page's read none, every one
// from block 117,445,722.
// What it holds, signed out, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as
// minified, the index sync runs serve, then the lock:
//   - serve, before the lock: reads the kept index (the store's get) or the snapshot and writes nothing to the store;
//   - sync, under ct-evm-index/{chain} (ifAvailable): the only write to the store (its put).
// That the serve feeds a quote is packages/signpage/test/pool-testnet-evm-queue.test.ts's (a tab without the lock is
// served the kept index; two tabs' writes never interleave).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-index-served-before-lock.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2. Reads only: no key, no transaction, no money moves.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-index-served-before-lock";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const W = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");
const ARGS = `(?:${W}(?:,${W})*)?`;
// serve(chain,network,stop).catch(()=>{}).then(()=>stop.aborted?void 0:locks?locks.request(`ct-evm-index/${chain}`,{ifAvailable:!0},free=>free===null?void 0:sync()):sync())
const RUN = new RegExp(`(${W})\\(${ARGS}\\)\\.catch\\(\\(\\)=>\\{\\}\\)\\.then\\(\\(\\)=>${W}\\.aborted\\?void 0:(${W})\\?\\2\\.request\\(\`ct-evm-index/\\$\\{${W}\\}\`,\\{ifAvailable:!0\\},${W}=>${W}===null\\?void 0:(${W})\\(\\)\\):\\3\\(\\)\\)`);
const LOCK_MARK = "`ct-evm-index/${";

/** The bundle's code around the index lock: the 2,000 characters before its name and 200 after (none: no lock). */
export const excerptOf = (js) => {
  const i = js.indexOf(LOCK_MARK);
  return i < 0 ? "" : js.slice(Math.max(0, i - 2000), i + 200);
};

/** What the check keeps of the reads: the index, the served bundle's sha384, and its code around the index lock. */
export function facts(index, js) {
  return { index, sha384: sha384(js), excerpt: excerptOf(js) };
}

export const NO_SERVE_FIRST = "BAD the page's index sync does not serve the kept index before it takes ct-evm-index/{chain}";
export const SERVE_WRITES = "BAD the serve before the lock reads no kept index, or writes to the store";
export const SYNC_NO_WRITE = "BAD the sync under the lock does not hold the store's write";

/** The serve-then-lock shape in an excerpt: [] when it holds, else the lines that name what is missing. */
export function shape(x) {
  const m = RUN.exec(x ?? "");
  if (m === null) return [NO_SERVE_FIRST];
  const [, serve, , sync] = m;
  const s0 = x.search(new RegExp(`[,{ ]${esc(serve)}=async\\(${ARGS}\\)=>\\{`));
  const y0 = x.search(new RegExp(`[,{ ]${esc(sync)}=async\\(\\)=>\\{`));
  if (s0 < 0 || y0 < 0 || y0 < s0 || y0 > m.index) return [NO_SERVE_FIRST];
  const serveBody = x.slice(s0, y0);
  const syncBody = x.slice(y0, m.index);
  const bad = [];
  if (!/\?\.get\(/.test(serveBody) || /\.put\(/.test(serveBody)) bad.push(SERVE_WRITES);
  if (!/\?\.put\(/.test(syncBody)) bad.push(SYNC_NO_WRITE);
  return bad;
}

/** The verdict on an answer { index, sha384, excerpt }. */
export function judge(a) {
  const lines = [];
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) lines.push("BAD SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) lines.push("BAD SIGN_HOST's served /app.js is not the one index.html pins");
  lines.push(...shape(a?.excerpt));
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
