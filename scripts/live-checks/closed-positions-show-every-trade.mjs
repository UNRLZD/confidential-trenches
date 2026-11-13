#!/usr/bin/env node
// Live check of card closed-positions-show-every-trade: every buy and sell the user made shows in Portfolio, a coin sold
// in full as a closed position. Two roots, read on mainnet 13 Nov: a Solana buy of several pieces pays its fresh wallet
// by a plain release (tag 2) before its tag 3 (33SLRx then 55LqP9, 18:05Z), and the rebuild's read of the wallet stopped
// at the tag 2 and marked it "no buy" for good, so a device signed in again had neither the buy nor its sale; and a Base
// or Robinhood buy and sale wrote no op at all (CASHCAT on Robinhood, 0xd55fa259 at 21:05Z, 0x6de337ed at 21:06Z), so
// the app's trade book never saw them. It reads what SIGN_HOST serves: the page, then every script the page names, and
// checks the bundle holds:
//   - the wallet read goes past a plain release to the tag 3, and a release with nothing after it is "no buy" only once
//     it is SOL_RELEASE_FINAL_MS (600,000 ms) old (packages/wallet/src/pool/buy-wallets.ts solanaBuyReader);
//   - a "no buy" mark counts only at this read's value (2), so a wallet the old read marked is read again
//     (src/sol-buy-records.ts BUY_NONE_MARK, buyNoneMarked);
//   - a filled Base or Robinhood trade's op is keyed by its chain and transaction (src/pool-buy-evm.ts evmTradeKey);
//   - it names the token units that moved, the ETH at 18 decimals and its USD when priced (evmTradeOp);
//   - the buy's and the sale's filled ends write it (the read-backs' `traded`).
// And two more gaps the same card closes: a buy whose run ended "sent" on a page closed before its follow wrote no op,
// and the rebuild skipped every wallet with this device's own buy record; and a device restored or signed in again had
// no Base or Robinhood trade at all. So the bundle also holds:
//   - the rebuild's skip list holds the page's running buys, and a wallet with this device's own buy record only once
//     its trades were read (src/sol-buy-records.ts tradesDone);
//   - the EVM restore keeps each spend's transaction, fee and amount bought from the pool's events
//     (packages/wallet/src/pool/evm-restore.ts), and writes each buy's and sale's op from them, run once the notes are
//     written (src/pool-sell-evm.ts restoreEvmTrades, src/pool-restore.ts).
// The behaviour is the package's own tests: packages/signpage/test/closed-pieces-buy.test.ts (mainnet's 18:05Z
// transactions, red before), pool-buy-evm.test.ts and pool-sell-evm.test.ts ("trade op"), restore-evm-trades.test.ts
// (the CASHCAT round trip's recorded answers) and packages/wallet/test/pool-evm-restore.test.ts.
// After: sign --host sign
// Bundle: read sign
//   node scripts/live-checks/closed-positions-show-every-trade.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the marks each file holds, its pin and its sha384, not the files), so the check's
// test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "closed-positions-show-every-trade";
export const SIGN_URL = "https://confidential.unrealized.trade/";
// a minifier may quote a string with any of the three quotes and rename any identifier
const Q = "[`\"']";
const ID = "[\\w$]+";
/** The marks, and what the bundle holds when the change is in place. */
export const MARKS = {
  sign: [
    ["a plain release is read past, and is no buy only once old", new RegExp(`return ${ID}\\(${ID}!==null&&Date\\.now\\(\\)-${ID}\\*1e3>6e5\\?${Q}none${Q}:null\\)`)],
    ["a no-buy mark counts only at this read's value", new RegExp(`\\(${ID},${ID}\\)=>${ID}\\(${ID}\\)\\[${ID}\\]===2[,;]`)],
    ["an EVM trade's op is keyed by its chain and transaction", new RegExp(`=\\(${ID},${ID}\\)=>(?:\`trade/\\$\\{${ID}\\}/\\$\\{${ID}\\(${ID}\\)\\}\`|${Q}trade/${Q}\\+${ID}\\+${Q}/${Q}\\+${ID}\\(${ID}\\))`)],
    ["the op names the units, the ETH at 18 decimals and its USD", new RegExp(`\\{units:${ID}\\(${ID},${ID}\\)\\},pool_amount:${ID}\\(${ID},18\\),\\.\\.\\.${ID}===null\\?\\{\\}:\\{amount_usd:${ID}\\}`)],
    ["a filled buy writes it", new RegExp(`traded\\?\\.\\(${ID}\\(${Q}buy${Q},${ID}\\.chain,${ID}\\.release\\.tx,`)],
    ["a filled sale writes it", new RegExp(`traded\\?\\.\\(${ID}\\(${Q}sell${Q},${ID}\\.chain,${ID}\\.deposit\\.tx,`)],
    ["the trades' read skips the wallets a buy on this page runs for", new RegExp(`done:async\\(\\)=>new Set\\(\\[\\.\\.\\.await ${ID}\\(await ${ID}\\.store\\(\\),${ID}\\),\\.\\.\\.${ID}\\]\\)`)],
    ["a wallet with this device's own buy record is skipped only once its trades were read", new RegExp(`\\.rebuilt!==!0&&Object\\.hasOwn\\(${ID},${ID}\\)\\?\\[${ID}\\]:\\[\\]`)],
    ["a restore's pool events give each spend's transaction, fee and amount bought", new RegExp(`tx:${ID}\\(${ID}\\),fee:${ID}\\(${ID},2\\),out:${ID}\\.kind===${Q}buy${Q}\\?${ID}\\(${ID},6\\):null`)],
    ["a restore writes each EVM sale's op from its deposit back", new RegExp(`${ID}\\(${Q}sell${Q},${ID}\\.chain,${ID}\\.tx,${ID}\\.token,null,null,${ID}\\.value,null,`)],
    ["the restore runs it once the notes are written", new RegExp(`\\(\\{chain:${ID}\\.chain,read:${ID},store:await\\(${ID}\\.held\\?${ID}\\.held\\(\\):${ID}\\.store\\(\\)\\),spends:${ID}\\.spends,returns:${ID}\\.returns,signal:${ID}\\}\\)`)],
  ],
};
export const NAMES = { sign: MARKS.sign.map(([n]) => n) };

/** The page's scripts: the `src` of each script tag, with its `integrity` when it has one. */
export const scriptsOf = (html) =>
  [...html.matchAll(/<script\b[^>]*>/gi)].flatMap((m) => {
    const src = /\bsrc="([^"]+)"/i.exec(m[0])?.[1];
    return src ? [{ src, integrity: /\bintegrity="([^"]+)"/i.exec(m[0])?.[1] ?? null }] : [];
  });
/** A script's sha384, as an integrity attribute names it. */
export const sha384 = (text) => `sha384-${createHash("sha384").update(text).digest("base64")}`;
/** The names of `host`'s marks a script holds. */
export const marksIn = (host, text) => MARKS[host].filter(([, re]) => re.test(text)).map(([n]) => n);

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { sign: { source, pageStatus, js: [{ url, status, found }] } }; one that holds no host fails. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const hosts = ["sign"].filter((h) => rec[h] !== undefined);
  say(hosts.length > 0, `hosts read: ${hosts.join(", ") || "none"}`);
  for (const host of hosts) {
    const h = rec[host];
    say(h.pageStatus === 200, `${host}: the page answers ${h.pageStatus ?? "nothing"}`);
    const js = h.js ?? [];
    say(js.length > 0 && js.every((f) => f.status === 200), `${host}: ${js.length} script(s) named by the page, each answering 200`);
    // each script's bytes are the ones its page pins: the browser runs no other, so marks in another file prove nothing
    const off = js.filter((f) => typeof f.integrity !== "string" || f.integrity !== f.sha384);
    say(off.length === 0, off.length ? `${host}: not the script its page pins: ${off.map((f) => f.url).join(", ")}` : `${host}: each script is the one its page pins`);
    const held = new Set(js.flatMap((f) => f.found ?? []));
    const miss = NAMES[host].filter((n) => !held.has(n));
    say(miss.length === 0, miss.length ? `${host}: the scripts lack: ${miss.join("; ")}` : `${host}: ${NAMES[host].join("; ")}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function host(name, url, fetchFn) {
  const http = async (u) => {
    const r = await fetchFn(u, { redirect: "manual" });
    return { status: r.status, text: await r.text() };
  };
  const page = await http(url);
  const rec = { source: url, pageStatus: page.status, js: [] };
  for (const { src, integrity } of scriptsOf(page.text)) {
    const f = await http(new URL(src, url).href);
    rec.js.push({ url: src, status: f.status, integrity, sha384: sha384(f.text), found: marksIn(name, f.text) });
  }
  return rec;
}

/** What SIGN_HOST serves, read with `fetchFn` (scripts/ci/bundle-checks.mjs passes one that answers from the
 *  build). */
export async function collect({ fetchFn = fetch } = {}) {
  return { at: new Date().toISOString(), sign: await host("sign", SIGN_URL, fetchFn) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const h = opt("--host", "sign");
  try {
    if (h !== "sign") throw new Error(`--host sign, not ${h}`);
    const rec = await collect();
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.sign.source})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `f` answers from the build
 *  folders as the host would; `dirs` names them (card ci-stops-costing-reruns, moved from bundle-checks.mjs). */
export async function bundle(f) {
  return judge(await collect({ fetchFn: f }));
}
