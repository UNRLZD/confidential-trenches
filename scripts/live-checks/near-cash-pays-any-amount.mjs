#!/usr/bin/env node
// Live check of card near-cash-pays-any-amount: Cash on NEAR pays a buy or a withdraw for any amount it shows. Before it,
// no NEAR buy had ever been paid out (the vault's spends() held 2 rows, 15 Nov 00:37Z): the helper's fee quote lived 100
// blocks (about 57 s) while the device took 60-70 s from the quote to the send, so every request was let go; and a NEAR
// buy needed one note covering the amount and its fee while the box offers all of Cash. What it holds on what is
// deployed, and only that:
//   - HELPER_HOST's mainnet USDC quote (GET /v1/withdraw/fee) stays open at least MIN_LEFT blocks past the higher of the
//     release pair's final heights, read right after it: a request's whole life (apps/helper/src/withdraw/fee.ts
//     FEE_QUOTE_WINDOW_BLOCKS, 1,200; 100 before);
//   - SIGN_HOST's served /app.js is the one its index.html pins (sha384), and its NEAR buy plans its payout over notes
//     (MARK below: the record's log line naming how many notes pay it, written only by the planned pick).
// The recorded answers: good, this card's helper quoter on the live mainnet pair (fee.ts createFeeQuoter at the card's
// branch) and its SIGN_HOST build (scripts/signpage-built.mjs); bad, HELPER_HOST and SIGN_HOST as served at release 146.
// After: helper sign
//   node scripts/live-checks/near-cash-pays-any-amount.mjs [--record <file>] [--answer <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "near-cash-pays-any-amount";
export const HELPER = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // gitleaks:allow (a public account id)
export const PAIR = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
/** A request's last send is 570 s after its quote at most (600 s less check 9's 30 s): 1,008 blocks at mainnet's 0.566 s.
 *  The helper prices at the lower final, so its 1,200 reads a little under that here. */
export const MIN_LEFT = 1_100;
/** near-buy.ts begin's log line: only the planned pick writes it. */
export const MARK = "near buy recorded, paid from ";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** What the check keeps of the reads. */
export function facts({ quote, height, index, js }) {
  return { quote, height, index, sha384: sha384(js), planned: js.includes(MARK) };
}

/** The verdict on an answer { quote, height, index, sha384, planned }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  let q;
  try {
    q = JSON.parse(a?.quote ?? "");
  } catch {
    q = undefined;
  }
  const until = q?.valid_until_block;
  if (!Number.isSafeInteger(until) || !Number.isSafeInteger(a?.height) || a.height <= 0) bad("HELPER_HOST's quote or the pair's final height is not a height");
  else if (until - a.height < MIN_LEFT) bad(`HELPER_HOST's quote closes ${until - a.height} blocks past the final height, under ${MIN_LEFT}: a slow device's request is priced at the fee now and let go`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.planned !== true) bad(`SIGN_HOST's NEAR buy does not plan its payout over notes (${JSON.stringify(MARK)} not in the bundle): an amount no one note covers is refused`);
  return { ok: lines.length === 0, lines };
}

/** The higher of the pair's final heights. */
export async function finalHeight(fetchFn = fetch) {
  const hs = await Promise.all(
    PAIR.map(async (url) => {
      const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { finality: "final" } }) });
      const h = (await r.json())?.result?.header?.height;
      if (!Number.isSafeInteger(h)) throw new Error(`${url}: no final height`);
      return h;
    }),
  );
  return Math.max(...hs);
}

export async function read(fetchFn = fetch) {
  const r = await fetchFn(`${HELPER}/v1/withdraw/fee?token=${USDC}`, { redirect: "error", headers: { origin: APP } });
  const quote = await r.text();
  if (r.status !== 200) throw new Error(`/v1/withdraw/fee: HTTP ${r.status}`);
  const height = await finalHeight(fetchFn);
  const get = async (path) => {
    const s = await fetchFn(`${SIGN}${path}`, { redirect: "error", headers: { "cache-control": "no-cache" } });
    if (s.status !== 200) throw new Error(`${path}: HTTP ${s.status}`);
    return s.text();
  };
  const index = await get("/");
  return facts({ quote, height, index, js: await get("/app.js") });
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
