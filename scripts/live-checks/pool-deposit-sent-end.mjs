#!/usr/bin/env node
// Live check of card pool-deposit-sent-end on SIGN_HOST (https://sign.confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified (review 7: each mark
// pins the helpers and the hand-off its rule rests on, not only the rule's own shape):
//   - Solana end read (pool-deposit.ts noteEnd): the note's own record first (past INCOMING: landed only at its recorded
//     value), its record's sends, then both RPCs' finalized heights with their slots (finals: getEpochInfo at finalized,
//     through the both-RPCs helper), every send past its last valid height on every one, then the failed-on-both read,
//     then the mark at those slots; a mark on one RPC no end; no mark with every send dead "expired" (no end: the pass
//     builds it again), never dead; a mark at another value dead only when no send succeeded on both; at the value,
//     landed only through the leaf check;
//   - Solana mark read (markOf): at finalized, each RPC's at its height's slot (minContextSlot), through an account read
//     that sends it;
//   - Solana run's hand-off: the ask's open sends only (open(): its sends less the settled ones), with landed and whole;
//   - EVM end read (noteEndEvm): the note's own record first, its sends' highest nonce, U's finalized nonce on both RPCs
//     before the round; no Deposited with the nonce past on both "expired"; a Deposited above the finalized block no end;
//     landed only at the note's value;
//   - EVM run's hand-off: the seed and keys zeroed before the store read, then the ask's notes still INCOMING;
//   - each kind: filled, or part_filled with no open note, is the end; else its open notes read on once its locks are let
//     go (the Solana kind also when its run throws), their end posted unless the reads gave up;
//   - each kind's reads: stopped at sign out, the pass started on "expired", backing off, giving up at 36e5 ms, ending
//     only once every open note is landed or dead, then filled (only with the whole ask sent), part_filled or
//     not_landed.
// What each does is held by the card's tests (packages/signpage/test/pool-deposit.test.ts and pool-deposit-evm.test.ts,
// each "pool-deposit-sent-end" and "review 8"); the recorded answers are facts() over each tree's
// packages/signpage/index.html and public/app.js (this file reaches no package code: the import check holds it).
//   node scripts/live-checks/pool-deposit-sent-end.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-deposit-sent-end";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
const N = "[\\w$]+";
const esc = (x) => x.replace(/[$]/g, "\\$");
// the Solana runner's both-RPCs helper: f on rpcs[0] and rpcs[1]
const BOTH = new RegExp(`(${N})=\\((${N}),(${N})\\)=>Promise\\.all\\(\\[\\3\\(\\2\\.rpcs\\[0\\]\\),\\3\\(\\2\\.rpcs\\[1\\]\\)\\]\\)`, "g");
// finals: each RPC's finalized height with its slot, one getEpochInfo
const FINALS = (both) => new RegExp(`async function (${N})\\(${N}\\)\\{return (?:${both})\\(${N},async ${N}=>\\{let (${N})=await ${N}\\(${Q}getEpochInfo${Q},\\[\\{commitment:${Q}finalized${Q}\\}\\]\\);return\\{height:BigInt\\(${N}\\(\\2\\?\\.blockHeight\\)\\),slot:${N}\\(\\2\\?\\.absoluteSlot\\)\\}\\}\\)\\}`);
// the account read that sends minContextSlot when given one
const ACCOUNT = new RegExp(`async function (${N})\\(${N},${N},${N},(${N})\\)\\{let ${N}=await ${N}\\(${Q}getAccountInfo${Q},\\[${N},\\{encoding:${Q}base64${Q},commitment:${N},\\.\\.\\.\\2===void 0\\?\\{\\}:\\{minContextSlot:\\2\\}\\}\\]\\)`, "g");
// markOf: each RPC's mark at finalized, at its slot (a node behind: -32016, read again), RPC 0 and RPC 1
const MARK = (account) => new RegExp(`async function (${N})\\(${N},${N},(${N}),(${N})\\)\\{let ${N}=${N}\\(${N}\\.pin\\.program,${N}\\),(${N})=async\\((${N}),(${N})\\)=>\\{for\\(let ${N}=0;;${N}\\+\\+\\)try\\{return await (?:${account})\\(\\5,${N},${Q}finalized${Q},\\2\\?\\.\\[\\6\\]\\)\\}catch\\(${N}\\)\\{if\\(\\2===void 0\\|\\|[^}]*\\}\\},\\[${N},${N}\\]=await Promise\\.all\\(\\[\\4\\(${N}\\.rpcs\\[0\\],0\\),\\4\\(${N}\\.rpcs\\[1\\],1\\)\\]\\)`);
// failedOnBoth: a send dead when expired or failed at finalized on EVERY RPC; bothLanded: a send succeeded on every RPC
const FAILED = new RegExp(`async function (${N})\\(${N},${N},(${N})\\)\\{let (${N})=await ${N}\\(${N},${N},${N}=>${N}\\?\\.confirmationStatus===${Q}finalized${Q}&&${N}\\.err!==null&&${N}\\.err!==void 0\\);return ${N}\\.map\\(\\(${N},(${N})\\)=>\\2\\[\\4\\]\\|\\|\\3\\.every\\(${N}=>${N}\\[\\4\\]\\)\\)\\}`, "g");
const LANDED = new RegExp(`async function (${N})\\(${N},${N}\\)\\{let (${N})=await ${N}\\(${N},${N},${N}=>${N}\\?\\.confirmationStatus===${Q}finalized${Q}&&${N}\\.err===null\\);return ${N}\\.some\\(\\(${N},(${N})\\)=>\\2\\.every\\(${N}=>${N}\\[\\3\\]\\)\\)\\}`, "g");
// noteEnd (see the header), calling finals, failedOnBoth, markOf and bothLanded by name
const SOL_END = (finals, mark, failed, landed) => new RegExp(
  `let (${N})=(${N})\\.sends\\[0\\]\\.value,(${N})=await (${N})\\.notes\\(\\),(${N});try\\{\\5=\\(await \\3\\.list\\(\\)\\)\\.find\\(${N}=>${N}\\.scope===${N}&&${N}\\.precommitment===\\2\\.precommitment\\)\\}finally\\{\\4\\.end\\?\\.\\(\\)\\}if\\(\\5!==void 0&&\\5\\.state!==${Q}INCOMING${Q}\\)return \\5\\.state===${Q}PLANNED${Q}\\?null:\\5\\.leaf\\?\\.value===\\1\\?${Q}landed${Q}:${Q}dead${Q};let (${N})=\\5\\?\\.sends\\?\\.length\\?\\5\\.sends:\\2\\.sends,(${N})=await (?:${finals})\\(\\4\\),(${N})=\\6\\.map\\(${N}=>\\7\\.every\\(${N}=>${N}\\.height>${N}\\.last_valid_block_height\\)\\),(${N})=\\8\\.every\\(Boolean\\)\\?\\8:await (?:${failed})\\(\\4,\\6,\\8\\),(${N})=await (?:${mark})\\(\\4,\\2\\.precommitment,\\[\\7\\[0\\]\\.slot,\\7\\[1\\]\\.slot\\],${N}\\);return \\10===${Q}one${Q}\\?null:\\10===null\\?\\9\\.every\\(Boolean\\)\\?${Q}expired${Q}:null:\\10\\.value===\\1\\?\\(await ${N}\\(${N},${N},\\2\\.precommitment,\\10\\),${Q}landed${Q}\\):await (?:${landed})\\(\\4,\\6\\)\\?null:${Q}dead${Q}\\}`,
);
// the Solana run's hand-off: open() is its sends less the settled ones, and the hand-off keeps only those
const OPEN = new RegExp(`(${N})=\\(\\)=>${N}\\.filter\\((${N})=>!${N}\\.has\\(\\2\\.hash\\)\\)`, "g");
const SOL_LEFT = (open) => new RegExp(`let (${N})=new Set\\((?:${open})\\(\\)\\.map\\(${N}=>${N}\\.hash\\)\\),(${N})=\\[\\];for\\(let ${N} of ${N}\\.filter\\(${N}=>\\1\\.has\\(${N}\\.send\\.signature\\)\\)\\)\\{[^]{0,240}?\\}${N}\\.left\\?\\.\\(\\{notes:\\2,landed:${N}>0,whole:${N}===0\\}\\)`);
// noteEndEvm (see the header)
const EVM_END = new RegExp(
  `if\\((${N})!==void 0&&\\1\\.state!==${Q}INCOMING${Q}\\)return \\1\\.state===${Q}PLANNED${Q}\\?null:\\1\\.leaf\\?\\.value===(${N})\\.value\\?${Q}landed${Q}:${Q}dead${Q};let (${N})=\\(\\1\\?\\.evmSends\\?\\?\\[\\]\\)\\.reduce\\(\\((${N}),(${N})\\)=>\\5\\.nonce>\\4\\?\\5\\.nonce:\\4,\\2\\.nonce\\),(${N})=await ${N}\\(${N}\\.rpcs,async\\(${N},(${N})\\)=>${N}\\(await ${N}\\(${Q}eth_getTransactionCount${Q},\\[\\2\\.u,${Q}finalized${Q}\\]\\),${Q}rpc \\$\\{\\7\\} finalized nonce${Q}\\)\\),(${N})=await ${N}\\.round\\(\\),(${N})=\\8\\.events\\.find\\(${N}=>${N}\\.kind===${Q}deposit${Q}&&${N}\\.precommitment===\\2\\.precommitment\\);return \\9===void 0\\?\\6\\[0\\]>\\3&&\\6\\[1\\]>\\3\\?${Q}expired${Q}:null:\\9\\.block>\\8\\.finalBlock\\?null:\\9\\.value===\\2\\.value\\?${Q}landed${Q}:${Q}dead${Q}`,
);
// the EVM run's hand-off: seed and keys zeroed first, then each kept note still INCOMING
const EVM_LEFT = new RegExp(`finally\\{${N}\\.fill\\(0\\);for\\(let ${N} of ${N}\\)${N}\\.fill\\(0\\);let (${N})=${N};if\\(${N}!==null&&${N}\\.length>0&&\\1!==null\\)try\\{let (${N})=\\[\\];for\\(let\\[(${N}),(${N})\\]of ${N}\\)\\(await \\1\\.get\\(\\3\\)\\)\\?\\.state===${Q}INCOMING${Q}&&\\2\\.push\\(\\4\\);${N}\\.left\\?\\.\\(\\{notes:\\2,landed:${N}>0,whole:${N}\\}\\)`);
// a kind's end: filled, or part_filled with no open note; anything else read on once its locks are let go, its end
// posted unless the reads gave up (null)
const ENDED = `\`stage\`in (${N})&&\\(\\1\\.stage===${Q}filled${Q}\\|\\|\\1\\.stage===${Q}part_filled${Q}&&\\((${N})===null\\|\\|\\2\\.notes\\.length===0\\)\\)`;
const AFTER = `\\.then\\(\\(\\)=>\\{let (${N})=${N};if\\(\\1!==null&&(${N})!==null\\)return ${N}\\(\\1\\.h,\\1\\.left\\)\\.then\\((${N})=>void\\(\\3!==null&&\\2\\.progress\\(\\3\\)\\),\\(\\)=>\\{\\}\\)\\}\\)`;
// the Solana kind: its run awaited in a try whose finally reads the hand-off (a throw too)
const SOL_KIND = [new RegExp(`${N}=null;try\\{${N}=await ${N}\\(${N},${N}\\)\\}finally\\{try\\{let ${N}=${N},${N}=${N}!==null&&${ENDED}`), new RegExp(`\\.finally\\(${N}\\)${AFTER}`)];
const EVM_KIND = [new RegExp(`${N}=${ENDED};`), new RegExp(`${Q}failed${Q}\\},${N}\\(\\)\\}\\)${AFTER}`)];
// the reads (see the header)
const LOOP = new RegExp(
  `for\\(;;\\)\\{if\\((${N})\\.signal\\?\\.aborted\\)return null;let (${N})=!0,(${N})=!1;for\\(let\\[(${N}),(${N})\\]of (${N})\\.notes\\.entries\\(\\)\\)\\{if\\((${N})\\[\\4\\]!==null\\)continue;let (${N})=await ${N}\\([^;]*?\\)\\.catch\\(\\(\\)=>${Q}fault${Q}\\);\\8===${Q}landed${Q}\\|\\|\\8===${Q}dead${Q}\\?\\7\\[\\4\\]=\\8:\\8===${Q}expired${Q}\\?\\3=!0:\\8===null&&\\(\\2=!1\\)\\}if\\(\\7\\.every\\(${N}=>${N}!==null\\)\\)break;if\\(\\3&&\\1\\.settle\\?\\.\\(\\),\\2\\|\\|\\((${N})=${N}\\),(${N})\\+\\9>36e5\\)return null;await ${N}\\(\\9\\),\\10\\+=\\9,\\2&&\\(\\9=Math\\.min\\(\\9\\*2,${N}\\)\\)\\}return \\1\\.signal\\?\\.aborted\\?null:\\6\\.whole&&\\7\\.length>0&&\\7\\.every\\(${N}=>${N}===${Q}landed${Q}\\)\\?${Q}filled${Q}:\\6\\.landed\\|\\|\\7\\.includes\\(${Q}landed${Q}\\)\\?${Q}part_filled${Q}:${Q}not_landed${Q}`,
  "g",
);
const names = (re, js, k = 1) => [...js.matchAll(re)].map((m) => esc(m[k]));
const any = (xs) => (xs.length ? xs.join("|") : "(?!)");

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const both = any(names(BOTH, js));
  const fm = FINALS(both).exec(js);
  const finals = fm ? esc(fm[1]) : "(?!)";
  const mm = MARK(any(names(ACCOUNT, js))).exec(js);
  const mark = mm ? esc(mm[1]) : "(?!)";
  return {
    index,
    sha384: sha384(js),
    solFinals: fm !== null,
    solMark: mm !== null,
    solEnd: SOL_END(finals, mark, any(names(FAILED, js)), any(names(LANDED, js))).test(js),
    solLeft: SOL_LEFT(any(names(OPEN, js))).test(js),
    solKind: SOL_KIND.every((r) => r.test(js)),
    evmEnd: EVM_END.test(js),
    evmLeft: EVM_LEFT.test(js),
    evmKind: EVM_KIND.every((r) => r.test(js)),
    loops: (js.match(LOOP) ?? []).length,
  };
}

export const WHY = {
  solFinals: "a Solana send's expiry is read on one RPC, or from a height with no slot its mark read is held to",
  solMark: "a Solana mark is read with no slot pin (a node behind its height's view reads no mark), or on one RPC",
  solEnd: "a Solana deposit's end is read off its captured sends, before its mark, or told not_landed while the pass builds it again: the app may hear not_landed for a deposit that lands",
  solLeft: "a Solana run hands the reads sends it already settled, or no hand-off at all",
  solKind: "a Solana deposit whose run ends with a send still open (or throws past it) tells the app nothing more, or part filled while it may still land",
  evmEnd: "an EVM deposit's end is read off its first send, before U's nonce, on a Deposited not final, or told not_landed while the pass builds it again",
  evmLeft: "an EVM run hands the reads nothing, or reads the store before zeroing the seed and keys",
  evmKind: "an EVM deposit whose run ends with a send still open tells the app nothing more, or part filled while it may still land",
  loops: "a kind's reads after its run never stop, never back off, never start the pass, or end before each open note is landed or dead",
};

/** The verdict on an answer (facts()). */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const [k, why] of Object.entries(WHY)) if (k === "loops" ? a?.loops !== 2 : a?.[k] !== true) bad(why);
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
