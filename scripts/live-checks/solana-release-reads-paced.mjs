#!/usr/bin/env node
// Live check of card solana-release-reads-paced on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - release: the release's trade deps (trade.ts releaseTradeDeps) make provider A (PublicNode) and the helper's route
//     each under the kit's paced wrapper (send.ts solanaPacedRpc), and the reference reads on the pair the kit hands
//     it (flow.ts gives its paced providers), never on a pair of its own;
//   - pair: the page's Solana pair (pool-testnet.ts pageSolanaRpcs, which every pool buy, sell, withdraw, settle and
//     restore read takes) is the same two providers, each under the paced wrapper;
//   - timed: the kit's timed reads (send.ts solanaTimedRpc) call the provider inside its turn and time that call, then
//     pace the timed call under the limit the provider's queue already holds, so a wait for a turn never counts
//     against the read's timeout; and the reference's reads (pool.ts readSolanaReference), the rent read (pool-buy.ts
//     readSolanaRent) and the tx-end reads (send.ts readSolanaTxEnd) go through it;
//   - price: the page's price read (kit price/pool-usd.ts) takes each try through it, the try's bound taken at its turn
//     (none sent once the read's bound has ended) and its timeout the read's own NoAnswer, which slow() asks again.
// What each does is held by the card's tests (packages/kit/test/solana-pool.test.ts, packages/signpage/test/trade.test.ts
// and page-rpc.test.ts, each "card solana-release-reads-paced"); the recorded answers are facts() over each tree's
// packages/signpage/index.html and public/app.js (this file reaches no package code: the import check holds it).
//   node scripts/live-checks/solana-release-reads-paced.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "solana-release-reads-paced";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
const N = "[\\w$]+";
const NOFN = "(?:(?!function )[\\s\\S])";
const esc = (s) => s.replace(/\$/g, "\\$");
// the kit's paced wrapper: a call inside its own queue's slot is that slot's call, any other takes a slot (rpcSlot)
const PACED = new RegExp(`function (${N})\\((${N}),${N}=${N}\\)\\{${NOFN}{0,200}?\\{if\\(${N}===${N}\\)return \\2\\(${N},${N}\\);let ${N}=${N}\\(\\2,${N},${N}\\);return ${N}\\.wait\\?`);
// the timed read: its bound taken when its turn comes, the provider called inside the wrapper, synchronously, and that
// call timed (with the caller's late error); then the timed wrapper (never the provider under it) paced under the limit
// the provider's queue already names
const TIMED = (p) =>
  new RegExp(`function (${N})\\((${N}),(${N}),(${N})\\)\\{let (${N})=${N}\\(\\2,\\((${N}),(${N})\\)=>\\{let (${N}),(${N});try\\{\\9=typeof \\3==${Q}function${Q}\\?\\3\\(\\):\\3,\\8=Promise\\.resolve\\(\\2\\(\\6,\\7\\)\\)\\}catch\\((${N})\\)\\{return Promise\\.reject\\(\\10\\)\\}return ${N}\\(\\8,\\9,\\4\\)\\}\\)${NOFN}{0,200}?\\.limits\\.values\\(\\)\\.next\\(\\)\\.value;return (${N})\\?${esc(p)}\\(\\5,\\11\\):\\5\\}`);
// every name the bundle binds to `url` (a module may keep its own copy of the constant), as one alternation
const urlVar = (js, url) => {
  const names = [...js.matchAll(new RegExp(`(?<![\\w$])(${N})=${Q}${url.replace(/[.]/g, "\\.")}${Q}`, "g"))].map((m) => esc(m[1]));
  return names.length ? `(?:${names.join("|")})` : undefined;
};

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const p = PACED.exec(js)?.[1];
  const a = urlVar(js, "https://solana-rpc.publicnode.com");
  const h = urlVar(js, "https://ct-api.unrealized.trade");
  const t = p ? TIMED(p).exec(js)?.[1] : undefined;
  const release =
    !!(p && a && h) &&
    new RegExp(`providers:\\[${esc(p)}\\(${N}\\(${a}\\)\\),${esc(p)}\\(${N}\\(${h}\\)\\)\\],reference:\\((${N}),(${N})\\)=>${N}\\(\\2,\\1\\)`).test(js);
  const pair =
    !!(p && a && h) &&
    new RegExp(`=\\(\\)=>\\{let\\[(${N}),(${N})\\]=\\[${N}\\(${a}\\),${N}\\(${h}\\)\\];return\\[${esc(p)}\\(\\1\\),${esc(p)}\\(\\2\\)\\]\\}`).test(js);
  const timed =
    !!t &&
    // the reference's reads, a failed one read as no answer (pool.ts readSolanaReference)
    new RegExp(`\\.map\\((${N})=>Promise\\.resolve\\(\\)\\.then\\(\\(\\)=>${esc(t)}\\(\\1,${N}\\)\\(${Q}getMultipleAccounts${Q},\\[${N},\\{encoding:${Q}base64${Q},commitment:${Q}confirmed${Q}\\}\\]\\)\\)\\.then\\((${N})=>${N}\\(\\2,${N}\\.length\\),\\(\\)=>null\\)`).test(js) &&
    // the rent read (pool-buy.ts readSolanaRent)
    new RegExp(`${esc(t)}\\(${N},${N}\\)\\(${Q}getAccountInfo${Q},\\[${N},\\{encoding:${Q}base64${Q},commitment:${Q}confirmed${Q}\\}\\]\\)`).test(js) &&
    // the tx-end reads (send.ts readSolanaTxEnd)
    new RegExp(`let (${N})=${esc(t)}\\(${N},${N}\\),${N}=\\((${N}),(${N})\\)=>Promise\\.resolve\\(\\)\\.then\\(\\(\\)=>\\1\\(\\2,\\3\\)\\)`).test(js);
  // the price read (kit price/pool-usd.ts call): each try through the timed read, its bound taken at its turn and none
  // sent once the read has ended or its bound has passed, its timeout the read's own NoAnswer, which its slow() asks again
  const priceAt = t ? new RegExp(`let (${N})=${esc(t)}\\(${N},\\(\\)=>\\{if\\(${N}\\.stopped\\)throw Error\\(${Q}\\$\\{${N}\\}: not asked again, the read ended before its turn${Q}\\);let (${N})=${N}\\.end-Date\\.now\\(\\);if\\(\\2<=0\\)throw new (${N})\\(${Q}\\$\\{${N}\\}: no turn inside the read's bound${Q}\\);return Math\\.min\\(${N},\\2\\)\\},(${N})=>new \\3\\(${Q}\\$\\{${N}\\}: no answer in \\$\\{\\4\\} ms${Q}\\)\\);try\\{return await Promise\\.resolve\\(\\)\\.then\\(\\(\\)=>\\1\\(${N},${N}\\)\\)\\}`).exec(js) : null;
  const price = !!priceAt && new RegExp(`=(${N})=>\\1 instanceof ${esc(priceAt[3])}\\|\\|`).test(js);
  return { index, sha384: sha384(js), release, pair, timed, price };
}

/** The verdict on an answer { index, sha384, release, pair, timed, price }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.release !== true) bad("the release's reference reads on a pair outside the trade's pace: a release under load can trip a provider's limit and be refused as down");
  if (a?.pair !== true) bad("the page's Solana pair is made unpaced: pool buy, sell, withdraw and settle reads skip the provider's queue");
  if (a?.timed !== true) bad("the kit's reference, rent or tx-end reads skip the provider's queue or count their wait against their timeout: a read behind a full pace is refused as down");
  if (a?.price !== true) bad("the page's price read counts its wait for a turn against its try's bound: behind a full pace it fails as no answer");
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
