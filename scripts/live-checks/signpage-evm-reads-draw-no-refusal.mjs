#!/usr/bin/env node
// Live check of card signpage-evm-reads-draw-no-refusal on SIGN_HOST (https://confidential.unrealized.trade). Release
// 130's signed-in page synced the Robinhood pool index on rpc.mainnet.chain.robinhood.com and robinhood.api.pocket.network
// in 1,000 spans of 10,000 blocks, 20 calls a post; Robinhood's own answered its 6th post 429 with
// access-control-allow-origin "*,*", which Chrome refuses as CORS (CDP capture 13 Nov 18:0xZ; sign live run 43477001550,
// signpage-signin-kinds: 24 console lines). What it holds, signed out, and only that: the served /app.js is the one
// index.html pins (its sha384), and in it, as minified:
//   - readers: the Robinhood index reads Robinhood's own and the helper's keyed route
//     (/v1/rpc/robinhood?keyed=only), in 500,000-block spans (5e5), one span a batch and one batch at once, every batch
//     inside the helper's 10 calls (batchMax:10): a cold index 42 calls on each, where it was 2,001 on Robinhood's own;
//   - lock: the page's index sync runs one tab at a time (the Web Lock ct-evm-index/{chain}, ifAvailable).
// That the two readers serve those spans and agree is evm-pool-index's live check; that the signed-in page draws no
// CORS line is signpage-signin-kinds's (its "no page error or CSP violation").
// After: sign
// Bundle: read sign
//   node scripts/live-checks/signpage-evm-reads-draw-no-refusal.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-evm-reads-draw-no-refusal";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
// the Robinhood venue's index: its two readers, its span, one span a batch, one batch at once, the helper's batch cap
const READERS = new RegExp(
  `readers:Object\\.freeze\\(\\[${Q}https://rpc\\.mainnet\\.chain\\.robinhood\\.com${Q},${Q}https://ct-api\\.unrealized\\.trade/v1/rpc/robinhood\\?keyed=only${Q}\\]\\),span:5e5,perBatch:1,parallel:1,margin:7119,cap:131072,batchMax:10\\}`,
);
// the page's index sync under the device's one Web Lock a chain
const LOCK = new RegExp(`\\.request\\(${Q}ct-evm-index/\\$\\{[\\w$]+\\}${Q},\\{ifAvailable:!0\\}`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), readers: READERS.test(js), lock: LOCK.test(js) };
}

export const NO_READERS = "BAD the Robinhood index does not read Robinhood's own and the helper's keyed route in 500,000-block spans, one batch of at most 10 at a time";
export const NO_LOCK = "BAD the page's index sync is not one tab at a time (ct-evm-index/{chain})";

/** The verdict on an answer { index, sha384, readers, lock }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(m.startsWith("BAD ") ? m : `BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.readers !== true) bad(NO_READERS);
  if (a?.lock !== true) bad(NO_LOCK);
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
