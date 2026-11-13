#!/usr/bin/env node
// Live check of card buy-spends-several-pieces on APP_HOST (https://ct-app.unrealized.trade) and SIGN_HOST
// (https://confidential.unrealized.trade): the screens and the signing page of a buy that spends several pieces. Its
// helper's half is buy-spends-several-pieces.mjs (HELPER_HOST). Reads only: nothing is signed or sent. What it holds,
// and only that: each host serves the script its index.html pins (its sha384), and, each found by a mark of the
// minified bundle's shape:
//   - SIGN_HOST's pool.buy.dry answers, for an amount, the pieces the buy's pick spends and what they cost for good
//     (packages/signpage/src/pools.ts poolBuyDryKind, as minified: `{result:{tap_max:u,pieces:p.length,cost:KB(`);
//   - SIGN_HOST's state.pools tells the money whose proofs are still being made apart from what a tap can take now
//     (packages/wallet/src/pool/balances.ts, the entry's `making`, as minified: `...a===void 0?{}:{making:jB(t.making,t.d)}`);
//   - SIGN_HOST's buy of several pieces writes its owed record (W's l and j, its notes, the blockhash's last height)
//     before anything is sent, and refuses with no place to write it (src/pool-buy.ts, as minified:
//     `if(!e.piecesOwed)return zz();await e.piecesOwed.put({address:`), so a W the pieces paid and the buy never
//     reached is found and swept back into the pool;
//   - SIGN_HOST sends the pieces as one bundle on the helper's pieces route (src/pool-testnet.ts helperPoolSendPieces:
//     `/v1/pool/solana/pieces` with `{pool,txs}`);
//   - APP_HOST's trade box asks pool.buy.dry with the typed amount and keeps the cost it answers for this coin
//     (apps/terminal/src/screens/trade/TradeBox.tsx: `e(`pool.buy.dry`,{chain:`solana`,token:r,amount:t})`), and
//     draws the Fee row (`trade-cost`): a dash until that cost comes, then the cost;
//   - APP_HOST's proof state reads `making` (apps/terminal/src/screens/trade/model.ts proofStatus).
// The numbers themselves (the pick, the cost, the tiers, the sweep) are held by packages/signpage/test/pool-buy.test.ts,
// pool-buy-tiers.test.ts, pool-sell.test.ts and packages/wallet/test/pool-balances.test.ts at the released commit. The
// recorded answers are facts() over each host's build (apps/terminal/dist; packages/signpage index.html and
// public/app.js, the build the deploy makes). The check runs on a pull request's own build too
// (scripts/ci/bundle-checks.mjs).
// After: app sign
// Bundle: read app
//   node scripts/live-checks/buy-spends-several-pieces-screens.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "buy-spends-several-pieces-screens";
export const APP = "https://ct-app.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const Q = "[`\"']";
const q = (w) => `${Q}${w}${Q}`;

export const SIGN_MARKS = Object.freeze({
  dry: new RegExp(`\\{result:\\{tap_max:${N},pieces:(${N})\\.length,cost:${N}\\(\\1\\.reduce\\(`),
  making: new RegExp(`\\.\\.\\.${N}===void 0\\?\\{\\}:\\{making:${N}\\((${N})\\.making,\\1\\.d\\)\\}`),
  owed: new RegExp(`if\\(!(${N})\\.piecesOwed\\)return ${N}\\(\\);await \\1\\.piecesOwed\\.put\\(\\{address:${N}\\.address,l:${N}\\.wallet\\.l\\.toString\\(\\),j:${N}\\.wallet\\.j,primary:${N}\\.noteId,pieces:`),
  route: new RegExp(`${q("/v1/pool/solana/pieces")},\\{pool:${N},txs:${N}\\.map\\(`),
});
export const APP_MARKS = Object.freeze({
  ask: new RegExp(`${N}\\(${q("pool\\.buy\\.dry")},\\{chain:${q("solana")},token:${N},amount:${N}\\}\\)\\.outcome\\.then\\(${N}=>\\{if\\(!${N}\\)return;if\\(${N}\\.ok\\)return void\\(${N}\\.result\\.cost!==void 0&&${N}\\(\\{key:${N},cost:${N}\\.result\\.cost\\}\\)\\)`),
  row: new RegExp(`"data-testid":${q("trade-cost")},children:\\[[^\\]]{0,160}children:${N}===null\\?${q("—")}:${N}\\(${N}\\)`),
  making: new RegExp(`${N}\\.making!==void 0&&${N}\\(${N}\\.making\\)===!0\\?${q("making")}`),
});

/** The script an index.html pins, and its integrity. */
const pinned = (index) => {
  const m = /<script[^>]*\bsrc="([^"]+\.js)"[^>]*\bintegrity="([^"]+)"/.exec(index ?? "") ?? /<script[^>]*\bintegrity="([^"]+)"[^>]*\bsrc="([^"]+\.js)"/.exec(index ?? "");
  if (!m) return null;
  return m[1].endsWith(".js") ? { src: m[1], integrity: m[2] } : { src: m[2], integrity: m[1] };
};

const carries = (marks, js) => Object.fromEntries(Object.entries(marks).map(([k, re]) => [k, re.test(js ?? "")]));

/** What the check keeps of the reads: each host's index, its served script's sha384, and the marks read from it. */
export function facts(app, sign) {
  return { app: { index: app.index, sha384: sha384(app.js), ...carries(APP_MARKS, app.js) }, sign: { index: sign.index, sha384: sha384(sign.js), ...carries(SIGN_MARKS, sign.js) } };
}

export const SAYS = Object.freeze({
  "sign.dry": "the signing page's pool.buy.dry answers no pieces and cost for an amount: the Fee row stays a dash",
  "sign.making": "the signing page's state tells no money still being made apart from what a tap takes now",
  "sign.owed": "the signing page's buy of several pieces sends with no owed record written first: a W its pieces paid and its buy never reached is not swept back",
  "sign.route": "the signing page does not send a buy's pieces as one bundle on the helper's pieces route",
  "app.ask": "the trade box does not ask pool.buy.dry for the typed amount's cost",
  "app.row": "the trade box draws no Fee row (a dash, then the page's cost)",
  "app.making": "the trade box does not read the proofs still being made",
});

/** The verdict on an answer { app: { index, sha384, ask, row, making }, sign: { index, sha384, dry, making, owed, route } }. */
export function judge(a) {
  const lines = [];
  for (const [host, name] of [["app", "APP_HOST"], ["sign", "SIGN_HOST"]]) {
    const pin = pinned(a?.[host]?.index);
    if (!pin) lines.push(`BAD ${name}'s index.html pins no script`);
    else if (pin.integrity !== a[host].sha384) lines.push(`BAD ${name}'s served script is not the one index.html pins`);
  }
  for (const [k, say] of Object.entries(SAYS)) {
    const [host, mark] = k.split(".");
    if (a?.[host]?.[mark] !== true) lines.push(`BAD ${say}`);
  }
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (origin, path) => {
    const r = await fetchFn(`${origin}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${origin}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const host = async (origin) => {
    const index = await get(origin, "/");
    const pin = pinned(index);
    if (!pin) return { index, js: "" };
    return { index, js: await get(origin, pin.src.startsWith("/") ? pin.src : `/${pin.src}`) };
  };
  const [app, sign] = await Promise.all([host(APP), host(SIGN)]);
  return facts(app, sign);
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
