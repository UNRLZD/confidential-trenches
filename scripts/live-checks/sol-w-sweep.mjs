#!/usr/bin/env node
// Live check of card sol-w-sweep on SIGN_HOST (https://confidential.unrealized.trade). The signing page's pool sell
// (packages/signpage/src/pool-sell.ts, checked by rules/pool.ts) empties a fresh Solana wallet W into the user's pool
// balance, so what SIGN_HOST serves is what a device signs. What it proves, and only that: the served /app.js is the one
// index.html pins (its sha384), and its text carries the card's rules, each found by a mark of the bundle's shape (the
// minifier renames, never restructures them):
//   - a full sell deposits W's surplus with its proceeds (a reserve under 0), a partial sell leaves it on W;
//   - a full sell keeps on W only what lifts the rent back's sweep to the floor once W's token account is closed (the
//     floor, the sweep's fee, mark and a page's opening on each tree, one frame's fee, less rent(165)), and the cost of
//     each claim owed by W's volume accounts as the sell reads them, or the venue's own on a cashback coin; rent(0) only
//     when that is refused or would leave the sell's note under the floor; the reserve cap leaves out what the sweep
//     carries on;
//   - the sell's rule: a full sell priced exactly from the device's reads and the min out the sell's bytes sign, its
//     keep or rent(0) only where the device falls back (the rule's own floor), at a rent rate the cap bounds, the cap
//     SOLANA_POOL_SELL_RESERVE_MAX's own value; every note at least the pool's least deposit; a reserve under 0 only on
//     a full sell;
//   - a sweep that leaves W exactly what each owed cashback claim costs later (rent(0), a frame's fee, the claim
//     account's rent), at most two, checked by the sweep's rule;
//   - the sweep goes on when every account kept is a volume account owed cashback only (the kit's plan marks them),
//     W ending "owed" (its record kept) when the rest is under the floor;
//   - an owed W's record dropped only when both RPCs read W empty, every other end (a fault, a load whose reads fail,
//     one reader's word that W holds a token) keeping it, a load that reads W as at its last end running no pass, and
//     the sell lock taken per owed W, so a sell tapped meanwhile waits for one W at most.
// It does not prove those lines run: that is the signing page's tests at the released commit (test/pool-sell.test.ts,
// rules-pool.test.ts), and that the served files are that commit's build is signpage-release's.
//   node scripts/live-checks/sol-w-sweep.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sol-w-sweep";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const esc = (n) => n.replace(/\$/g, "\\$");
/** A mark whose named group `cap` must be SOLANA_POOL_SELL_RESERVE_MAX as the bundle defines it: the transaction fee's
 *  most (SOLANA_POOL_TX_FEE_MAX: 5,000 a signature and 1,400,000 compute units at 1,000,000 micro-lamports), 145 bytes'
 *  rent and two pages' 216 at SOLANA_RENT_PER_BYTE_MAX, that rate 6,960 (rules/pool.ts). */
const capOf = (re) => ({
  test(js) {
    const cap = re.exec(js)?.groups?.cap;
    const terms = cap && new RegExp(`[,;]${esc(cap)}=(${I})\\+145n\\*(${I})\\+2n\\*216n\\*\\2[,;]`).exec(js);
    if (!terms) return false;
    const fee = new RegExp(`[,;]${esc(terms[1])}=(${I})\\+BigInt\\(14e5\\)\\*(${I})/1000000n[,;]`).exec(js);
    const is = (name, v) => new RegExp(`[,; ]${esc(name)}=${v}[,;]`).test(js);
    return Boolean(fee) && is(terms[2], "6960n") && is(fee[1], "5000n") && is(fee[2], "1000000n");
  },
});
/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "a full sell deposits W's surplus": new RegExp(`(${I})=(${I})\\.fee\\+\\2\\.made\\+\\2\\.rents\\+\\2\\.after-\\2\\.lamports,${I}=\\1>0n\\|\\|!\\2\\.keeps\\?\\1:0n`),
  "a full sell keeps what lifts the sweep to the floor, a page's opening on each tree and each owed claim's cost": new RegExp(`function ${I}\\((${I}),(${I})=0\\)\\{let (${I})=${I}\\(\\1\\)>1000000n\\?${I}\\(\\1\\):${I},(${I})=(${I})\\(\\1,88\\),${I}=\\3\\+\\((${I})\\+\\5\\(\\1,${I}\\)\\+2n\\*\\4\\)\\+\\6-\\5\\(\\1,165\\)\\+${I}\\(\\1,\\2\\)`),
  "the full sell's keep counts W's volume accounts owed a claim, on either RPC's read": new RegExp(`\\.map\\(async (${I})=>(${I})\\.cashback&&\\1===${I}\\?!0:\\(await ${I}\\(${I},${I}=>${I}\\(${I},${I}\\(${I}\\.address,\\1\\),\`confirmed\`\\)\\)\\)\\.some\\((${I})=>!\\(\`none\`in \\3\\)&&\\3\\.owner===\\1&&${I}\\(\\1,\\3\\.data\\)>0n\\)\\)\\)\\.then\\((${I})=>\\4\\.filter\\(Boolean\\)\\.length\\)\\]\\),${I}=${I}\\?${I}\\(${I},${I}\\):${I}\\(${I},${I}\\)`),
  "rent(0) only when a full sell's keep is refused or leaves its note under the floor": new RegExp(`function (${I})\\((${I})\\)\\{if\\(!\\2\\.keeps&&\\2\\.base!==void 0\\)\\{let (${I})=\\1\\(\\{\\.\\.\\.\\2,base:void 0\\}\\);return\`refused\`in \\3\\|\\|\\3\\.value<\\(\\2\\.floor\\?\\?0n\\)\\?\\1\\(\\{\\.\\.\\.\\2,after:\\2\\.base,swept:0n,base:void 0\\}\\):\\3\\}`),
  "the sell prices a full sell with that fallback, at the sweep's floor": new RegExp(`(?<f>${I})=(?<he>${I})\\((?<rent>${I})\\)>1000000n\\?\\k<he>\\(\\k<rent>\\):${I},[\\s\\S]{0,3000}?let (?<r0>${I})=${I}\\(\\k<rent>,0\\),${I}=${I}\\(\\{[^{}]*?\\.\\.\\.${I}\\?\\{\\}:\\{swept:${I}-\\k<r0>,base:\\k<r0>,floor:\\k<f>\\}`),
  "the reserve cap leaves out what the sweep carries on": new RegExp(`(${I})-\\((${I})\\.swept\\?\\?0n\\)>${I}\\|\\|\\1>=\\2\\.minOut`),
  "the sell's rule prices a full sell exactly from the signed min out, rent(0) only where the device falls back, every note at least the pool's least deposit, at a rent and a cap of their own constants": capOf(new RegExp(`let (?<mo>${I})=${I}\\(${I}\\.data,16\\);if\\(\\k<mo><${I}\\)return (?<x>${I})\\(\`min_out\`\\);[\\s\\S]{0,800}?if\\(typeof (?<s>${I})!=\`bigint\`\\|\\|\\k<s>>=\\k<mo>\\)return \\k<x>\\(\`reserve\`\\);let (?<y>${I})=0n,(?<b>${I})=${I};if\\(\\k<b>!==void 0&&\\k<b>\\.full===!0\\)\\{if\\([^{}]*?\\|\\|\\k<b>\\.rent\\.lamportsPerByte\\*\\k<b>\\.rent\\.factor>6960n\\|\\|[^{}]*?\\|\\|\\k<b>\\.owed>2\\)return \\k<x>\\(\`reserve\`\\);let (?<e>${I})=\\k<b>\\.fee\\+\\k<b>\\.made\\+${I}\\(\\k<b>\\.rent,${I},\\k<b>\\.held,\\k<b>\\.next\\)-\\k<b>\\.lamports,(?<t>${I})=${I}\\(\\k<b>\\.rent,\\k<b>\\.owed\\),(?<n>${I})=${I}\\(\\k<b>\\.rent,0\\),(?<r>${I})=(?<he>${I})\\(\\k<b>\\.rent\\)>1000000n\\?\\k<he>\\(\\k<b>\\.rent\\):${I},(?<i>${I})=\\k<e>\\+\\k<t>,(?<a>${I})=\\k<i>-\\(\\k<t>-\\k<n>\\)<=(?<cap>${I})&&\\k<i><\\k<mo>&&\\k<mo>-\\k<i>>=\\k<r>;if\\(\\k<s>!==\\(\\k<a>\\?\\k<i>:\\k<e>\\+\\k<n>\\)\\)return \\k<x>\\(\`reserve\`\\);\\k<a>&&\\(\\k<y>=\\k<t>-\\k<n>\\)\\}else if\\(\\k<s><0n\\)return \\k<x>\\(\`reserve\`\\);if\\(\\k<s>-\\k<y>>\\k<cap>\\|\\|\\k<mo>-\\k<s><1000000n\\)return \\k<x>\\(\`reserve\`\\);let (?<d>${I})=${I}\\([^()]*\\);return \\k<d>===\\k<mo>-\\k<s>\\?`)),
  "an owed claim's cost: rent(0), a frame's fee and the claim account's rent": new RegExp(`(${I})=\\((${I}),(${I})\\)=>\\3===0\\?0n:${I}\\(\\2,0\\)\\+BigInt\\(\\3\\)\\*\\(${I}\\+${I}\\(\\2,165\\)\\)`),
  "the sweep's rule leaves exactly that, for at most two": new RegExp(`\\|\\|(${I})<0\\|\\|\\1>2\\?${I}\\(\`sweep_reads\`\\):${I}\\+5000n\\+${I}\\(${I},${I},${I}\\)\\+${I}\\(${I},\\1\\)===`),
  "the sweep goes on when only owed-cashback accounts are kept": new RegExp(`function ${I}\\((${I})\\)\\{return \\1\\.length>2\\|\\|\\1\\.some\\((${I})=>\\2\\.cashback!==!0\\)\\?null:\\1\\.length\\}`),
  "W owed, not dropped, when the rest is under the floor": new RegExp(`\\{end:(${I})>0\\?\`owed\`:\`floor\`,`),
  "a load that reads W as it read at its last end runs no pass": new RegExp(`async function (?<xr>${I})\\((?<h>${I}),(?<x>${I}),(?<o>${I})\\)\\{let (?<s>${I})=await ${I}\\(\\k<x>\\)\\.catch\\(\\(\\)=>void 0\\);\\(\\k<s>===void 0\\|\\|\\k<s>!==\\k<o>\\.seen\\)&&await (?<zr>${I})\\(\\k<h>,\\k<o>,await ${I}\\(\\k<h>,\\k<x>\\),\\k<s>\\)\\}`),
  "an owed W's record is dropped only when both RPCs read W empty, kept on every other end with what W read as": new RegExp(`async function (?<xr>${I})\\((?<h>${I}),(?<x>${I}),(?<o>${I})\\)\\{let (?<s>${I})=await ${I}\\(\\k<x>\\)\\.catch\\(\\(\\)=>void 0\\);\\(\\k<s>===void 0\\|\\|\\k<s>!==\\k<o>\\.seen\\)&&await (?<zr>${I})\\(\\k<h>,\\k<o>,await ${I}\\(\\k<h>,\\k<x>\\),\\k<s>\\)\\}async function \\k<zr>\\((?<h2>${I}),(?<o2>${I}),(?<e2>${I}),(?<s2>${I})\\)\\{try\\{if\\(\\k<e2>===\`nothing\`\\)return await \\k<h2>\\.owed\\?\\.drop\\(\\k<o2>\\.address\\);let\\{seen:${I},\\.\\.\\.(?<rest>${I})\\}=\\k<o2>;await \\k<h2>\\.owed\\?\\.put\\(\\{\\.\\.\\.\\k<rest>,passes:\\k<o2>\\.passes\\+1,\\.\\.\\.\\k<s2>!==void 0&&\\(\\k<e2>===\`floor\`\\|\\|\\k<e2>===\`holds\`\\|\\|\\k<e2>===\`kept\`\\)\\?\\{seen:\\k<s2>\\}:\\{\\}\\}\\)\\}catch\\{\\}\\}`),
  "a load whose own reads fail keeps every record, and the sell lock is taken per owed W, never around the list": new RegExp(`async function (?<xr>${I})\\((?<h>${I}),(?<x>${I}),(?<o>${I})\\)\\{let (?<s>${I})=await ${I}\\(\\k<x>\\)\\.catch\\(\\(\\)=>void 0\\);\\(\\k<s>===void 0\\|\\|\\k<s>!==\\k<o>\\.seen\\)&&await (?<zr>${I})\\(\\k<h>,\\k<o>,await ${I}\\(\\k<h>,\\k<x>\\),\\k<s>\\)\\}async function \\k<zr>\\([\\s\\S]{0,400}?\\}catch\\{\\}\\}async function ${I}\\([^)]*\\)\\{[\\s\\S]{0,700}?catch\\((?<err>${I})\\)\\{for\\(let (?<r>${I}) of (?<list>${I})\\)${I}\\.told\\?\\.\\(\\{[\\s\\S]{0,200}?state:\`gave_up\`[\\s\\S]{0,200}?\\}\\),await \\k<zr>\\(${I},\\k<r>,\`gave_up\`\\);return\\}[\\s\\S]{0,200}?for\\(let\\{address:(?<a>${I})\\}of \\k<list>\\)if\\(!await (?<lk>${I})\\.request\\(\`ct-pool/sell\`,\\{mode:\`exclusive\`,ifAvailable:!0\\},async (?<l>${I})=>\\{if\\(!\\k<l>\\)return!1;[\\s\\S]{0,400}?await \\k<xr>\\([\\s\\S]{0,200}?\\),!0\\}\\)\\)return\\}`),
  "the plan marks a volume account owed only cashback": new RegExp(`\\.\\.\\.(${I})\\.other\\.length===0&&\\1\\.amount>0n\\?\\{cashback:!0\\}:\\{\\}`),
});

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle carries. */
export function facts(index, js) {
  return { index, sha384: sha384(js), carries: Object.fromEntries(Object.entries(MARKS).map(([k, w]) => [k, w.test(js)])) };
}

/** The verdict on an answer { index, sha384, carries }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(MARKS)) if (a?.carries?.[k] !== true) bad(`the served bundle has no ${k}`);
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
