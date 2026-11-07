#!/usr/bin/env node
// Live check of card pool-deposit-sent-end on SIGN_HOST (https://sign.confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified (review 7: each mark
// pins the helpers and the hand-off its rule rests on, not only the rule's own shape):
//   - Solana end read (pool-deposit.ts noteEnd): the note's own record first, read only (records: no note store opened;
//     past INCOMING: landed only at its recorded value), its record's sends, then both RPCs' finalized heights with their slots (finals: getEpochInfo at finalized,
//     through the both-RPCs helper), every send past its last valid height on every one, then the failed-on-both read,
//     then the mark at those slots; a mark on one RPC no end; no mark with every send dead "expired" (no end: the pass
//     builds it again), never dead; a mark at another value dead only when no send succeeded on both; at the value,
//     landed only through the leaf check;
//   - Solana mark read (markOf): at finalized, each RPC's at its height's slot (minContextSlot), through an account read
//     that sends it;
//   - Solana run's hand-off: the ask's open sends only (open(): its sends less the settled ones), with landed and whole;
//   - EVM end read (noteEndEvm): the note's own record first, read only (records), its sends' highest nonce, U's finalized nonce on both RPCs
//     before the round; no Deposited with the nonce past on both "expired"; a Deposited above the finalized block no end;
//     landed only at the note's value;
//   - EVM run's hand-off: the seed and keys zeroed before the store read, then the ask's notes still INCOMING;
//   - each run: a rung's (an EVM note's) landing posts no stage, since "filled" ends the trade in the app;
//   - each kind: filled, or part_filled with no open note, is the end, posted once (after the answer: the answer's own
//     stage); else its open notes read on once its locks are let go (the Solana kind also when its run throws), their end
//     posted unless the reads stopped;
//   - each kind's reads: stopped only at sign out (no give-up on a clock), the sign out read before each note's read and
//     inside each end read before each of its RPC reads (the stop helper), the pass started on "expired" (a new landing
//     window for that note), a "may land" read counted as such only inside its landing window (Solana 120 s, EVM 1,500 s),
//     backing off, ending only once every open note is landed or dead, then filled (only with the whole ask sent),
//     part_filled or not_landed; each kind's wait ended by the sign out, its timer cleared (delta review of 09542dc6);
//   - EVM run's hand-off, when its store read fails: every note of the ask handed over as open, never none.
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
// the end reads' stop: a read after the sign out refused before it goes out (delta review low 4)
const STOP = new RegExp(`function (${N})\\((${N})\\)\\{if\\(\\2\\.signal\\?\\.aborted\\)throw (?:new )?Error\\(${Q}signed out${Q}\\)\\}`, "g");
// the reads' wait: ended at the sign out, its timer cleared (low 4)
const WAIT = new RegExp(`function (${N})\\((${N}),(${N})\\)\\{return new Promise\\((${N})=>\\{if\\(\\3\\?\\.aborted\\)return \\4\\(\\);let (${N})=\\(\\)=>\\{clearTimeout\\((${N})\\),\\3\\?\\.removeEventListener\\(${Q}abort${Q},\\5\\),\\4\\(\\)\\},\\6=setTimeout\\(\\5,\\2\\);\\3\\?\\.addEventListener\\(${Q}abort${Q},\\5,\\{once:!0\\}\\)\\}\\)\\}`, "g");
// each kind's reads wait on it, with their host's sign-out signal, unless the host brings its own
const WAITS = (wait) => new RegExp(`=(${N})\\.wait\\?\\?\\((${N})=>(?:${wait})\\(\\2,\\1\\.signal\\)\\)`, "g");
// the Solana end's wait inside a note's reads (the mark read again while an RPC is behind): the stop read after it, and
// that wait the one each note's end is given
const STOP_WAIT = (wait, stop) => new RegExp(`let (${N})=(${N})\\.wait\\?\\?\\((${N})=>(?:${wait})\\(\\3,\\2\\.signal\\)\\),(${N})=async (${N})=>\\{await \\1\\(\\5\\),(?:${stop})\\(\\2\\)\\}[^]{0,400}?let ${N}=await ${N}\\(\\2,${N},${N},${N},\\4,${N}=>void`, "g");
// noteEnd (see the header), calling finals, failedOnBoth, markOf, bothLanded and the stop by name
const SOL_END = (finals, mark, failed, landed, stop) => new RegExp(
  `let (${N})=(${N})\\.sends\\[0\\]\\.value,(${N})=\\(await (${N})\\.records\\(\\)\\)\\.find\\(${N}=>${N}\\.scope===${N}&&${N}\\.precommitment===\\2\\.precommitment\\);if\\(\\3!==void 0&&\\3\\.state!==${Q}INCOMING${Q}\\)return \\3\\.state===${Q}PLANNED${Q}\\?null:\\3\\.leaf\\?\\.value===\\1\\?${Q}landed${Q}:${Q}dead${Q};let (${N})=\\3\\?\\.sends\\?\\.length\\?\\3\\.sends:\\2\\.sends;${N}\\(\\5\\[\\5\\.length-1\\]\\.signature\\),(?:${stop})\\(\\4\\);let (${N})=await (?:${finals})\\(\\4\\),(${N})=\\5\\.map\\(${N}=>\\6\\.every\\(${N}=>${N}\\.height>${N}\\.last_valid_block_height\\)\\);(?:${stop})\\(\\4\\);let (${N})=\\7\\.every\\(Boolean\\)\\?\\7:await (?:${failed})\\(\\4,\\5,\\7\\);(?:${stop})\\(\\4\\);let (${N})=await (?:${mark})\\(\\4,\\2\\.precommitment,\\[\\6\\[0\\]\\.slot,\\6\\[1\\]\\.slot\\],${N}\\);return \\9===${Q}one${Q}\\?null:\\9===null\\?\\8\\.every\\(Boolean\\)\\?${Q}expired${Q}:null:\\((?:${stop})\\(\\4\\),\\9\\.value===\\1\\?\\((?:${stop})\\(\\4\\),await ${N}\\(${N},${N},\\2\\.precommitment,\\9\\),${Q}landed${Q}\\):await (?:${landed})\\(\\4,\\5\\)\\?null:${Q}dead${Q}\\)\\}`,
);
// the Solana run's hand-off: open() is its sends less the settled ones, and the hand-off keeps only those
const OPEN = new RegExp(`(${N})=\\(\\)=>${N}\\.filter\\((${N})=>!${N}\\.has\\(\\2\\.hash\\)\\)`, "g");
const SOL_LEFT = (open) => new RegExp(`let (${N})=new Set\\((?:${open})\\(\\)\\.map\\(${N}=>${N}\\.hash\\)\\),(${N})=\\[\\];for\\(let ${N} of ${N}\\.filter\\(${N}=>\\1\\.has\\(${N}\\.send\\.signature\\)\\)\\)\\{[^]{0,240}?\\}${N}\\.left\\?\\.\\(\\{notes:\\2,landed:${N}>0,whole:${N}===0\\}\\)`);
// noteEndEvm (see the header), the stop read before U's nonce and before the round
const EVM_END = (stop) => new RegExp(
  `(${N})=\\(await (${N})\\.records\\(\\)\\)\\.find\\(${N}=>${N}\\.scope===${N}&&${N}\\.precommitment===${N}\\.precommitment\\);if\\(\\1!==void 0&&\\1\\.state!==${Q}INCOMING${Q}\\)return \\1\\.state===${Q}PLANNED${Q}\\?null:\\1\\.leaf\\?\\.value===(${N})\\.value\\?${Q}landed${Q}:${Q}dead${Q};let (${N})=\\(\\1\\?\\.evmSends\\?\\?\\[\\]\\)\\.reduce\\(\\((${N}),(${N})\\)=>\\6\\.nonce>\\5\\?\\6\\.nonce:\\5,\\3\\.nonce\\),(${N})=\\1\\?\\.evmSends\\?\\.\\[\\1\\.evmSends\\.length-1\\];\\7!==void 0&&${N}\\(\\7\\.hash\\),(?:${stop})\\(\\2\\);let (${N})=await ${N}\\(\\2\\.rpcs,async\\(${N},(${N})\\)=>${N}\\(await ${N}\\(${Q}eth_getTransactionCount${Q},\\[\\3\\.u,${Q}finalized${Q}\\]\\),${Q}rpc \\$\\{\\9\\} finalized nonce${Q}\\)\\);(?:${stop})\\(\\2\\);let (${N})=await \\2\\.round\\(\\),(${N})=\\10\\.events\\.find\\(${N}=>${N}\\.kind===${Q}deposit${Q}&&${N}\\.precommitment===\\3\\.precommitment\\);return \\11===void 0\\?\\8\\[0\\]>\\4&&\\8\\[1\\]>\\4\\?${Q}expired${Q}:null:\\11\\.block>\\10\\.finalBlock\\?null:\\11\\.value===\\3\\.value\\?${Q}landed${Q}:${Q}dead${Q}`,
);
// the EVM run's hand-off: seed and keys zeroed first, then each kept note still INCOMING; a store read that fails hands
// every kept note over as open (low 5)
const EVM_LEFT = new RegExp(`finally\\{${N}\\.fill\\(0\\);for\\(let ${N} of ${N}\\)${N}\\.fill\\(0\\);let (${N})=${N};if\\(${N}!==null&&${N}\\.length>0&&\\1!==null\\)\\{let (${N})=\\[\\];try\\{for\\(let\\[(${N}),(${N})\\]of (${N})\\)\\(await \\1\\.get\\(\\3\\)\\)\\?\\.state===${Q}INCOMING${Q}&&\\2\\.push\\(\\4\\)\\}catch\\{\\2=\\[\\.\\.\\.\\5\\.values\\(\\)\\]\\}${N}\\.left\\?\\.\\(\\{notes:\\2,landed:${N}>0,whole:${N}\\}\\)`);
// a kind's end: filled, or part_filled with no open note; anything else read on once its locks are let go, its end
// posted unless the reads gave up (null)
const ENDED = `\`stage\`in (${N})&&\\(\\1\\.stage===${Q}filled${Q}\\|\\|\\1\\.stage===${Q}part_filled${Q}&&\\((${N})===null\\|\\|\\2\\.notes\\.length===0\\)\\)`;
const AFTER = `\\.then\\(\\(\\)=>\\{let (${N})=${N};if\\(\\1!==null&&(${N})!==null\\)return ${N}\\(\\1\\.h,\\1\\.left\\)\\.then\\((${N})=>void\\(\\3!==null&&\\2\\.progress\\(\\3\\)\\),\\(\\)=>\\{\\}\\)\\}\\)`;
// the Solana kind: its run awaited in a try whose finally reads the hand-off (a throw too)
// answered, an end goes as the run's own stage (filled or part_filled), once
const POSTED = `;${N}\\?${N}\\?${N}\\?\\.progress\\(\\1\\.stage\\):`;
const SOL_KIND = [new RegExp(`${N}=null;try\\{${N}=await ${N}\\(${N},${N}\\)\\}finally\\{try\\{let ${N}=${N},${N}=${N}!==null&&${ENDED}${POSTED}`), new RegExp(`\\.finally\\(${N}\\)${AFTER}`)];
const EVM_KIND = [new RegExp(`${N}=${ENDED}${POSTED}`), new RegExp(`${Q}failed${Q}\\},${N}\\(\\)\\}\\)${AFTER}`)];
// a run's landing posts no stage: the Solana rung's landing returns at its proof's start; the EVM note's goes on
const SOL_RUNG = new RegExp(`[,{ ;](${N})=await ${N}\\.move\\(${N}\\.id,${Q}INCOMING${Q},${Q}UNSPENT${Q},\\{leaf:${N}\\}\\);for\\(let ${N} of ${N}\\)${N}\\.add\\(${N}\\.signature\\);let ${N}=${N}\\?await ${N}\\(${N},${N}\\):null;return [^;]{0,80}?,${N}&&${N}\\+\\+,${N}\\.landed\\?\\.\\(\\1\\),${Q}landed${Q}\\}`);
const EVM_RUNG = new RegExp(`if\\((${N})\\.kind===${Q}landed${Q}\\)\\{${N}\\+\\+,\\1\\.hash!==void 0&&${N}\\.push\\(\\{chain:${N},hash:\\1\\.hash\\}\\),\\1\\.filled&&\\(${N}-=${N}<\\1\\.note\\.leaf\\.value\\?${N}:\\1\\.note\\.leaf\\.value\\);continue\\}`);
// the reads (see the header): the sign out read before each note's read; a "may land" read (null) keeps the reads at their
// base wait only inside the note's landing window (the waited ms less the note's window start, kept anew on "expired")
const LOOP = new RegExp(
  `for\\(;;\\)\\{let (${N})=!0,(${N})=!1;for\\(let\\[(${N}),(${N})\\]of (${N})\\.notes\\.entries\\(\\)\\)\\{if\\((${N})\\[\\3\\]!==null\\)continue;if\\((${N})\\.signal\\?\\.aborted\\)return null;let (${N})=await ${N}\\([^;]*?,(${N})=>void\\(\\9!==(${N})\\[\\3\\]&&\\(\\10\\[\\3\\]=\\9,(${N})\\[\\3\\]=(${N})\\)\\)\\)\\.catch\\(\\(\\)=>${Q}fault${Q}\\);\\8===${Q}landed${Q}\\|\\|\\8===${Q}dead${Q}\\?\\6\\[\\3\\]=\\8:\\8===${Q}expired${Q}\\?\\2=!0:\\8===null&&\\12-\\11\\[\\3\\]<(\\d[\\d.e+]*)&&\\(\\1=!1\\)\\}if\\(\\6\\.every\\(${N}=>${N}!==null\\)\\)break;\\2&&\\7\\.settle\\?\\.\\(\\),\\1\\|\\|\\((${N})=${N}\\),await ${N}\\(\\14\\),\\12\\+=\\14,\\1&&\\(\\14=Math\\.min\\(\\14\\*2,${N}\\)\\)\\}return \\7\\.signal\\?\\.aborted\\?null:\\5\\.whole&&\\6\\.length>0&&\\6\\.every\\(${N}=>${N}===${Q}landed${Q}\\)\\?${Q}filled${Q}:\\5\\.landed\\|\\|\\6\\.includes\\(${Q}landed${Q}\\)\\?${Q}part_filled${Q}:${Q}not_landed${Q}`,
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
  const stop = any(names(STOP, js));
  const windows = [...js.matchAll(LOOP)].map((m) => Number(m[13])).sort((x, y) => x - y);
  return {
    index,
    sha384: sha384(js),
    solFinals: fm !== null,
    solMark: mm !== null,
    solEnd: SOL_END(finals, mark, any(names(FAILED, js)), any(names(LANDED, js)), stop).test(js),
    solLeft: SOL_LEFT(any(names(OPEN, js))).test(js),
    solKind: SOL_KIND.every((r) => r.test(js)),
    evmEnd: EVM_END(stop).test(js),
    evmLeft: EVM_LEFT.test(js),
    evmKind: EVM_KIND.every((r) => r.test(js)),
    solRung: SOL_RUNG.test(js),
    evmRung: EVM_RUNG.test(js),
    loops: (js.match(LOOP) ?? []).length,
    windows: JSON.stringify(windows) === JSON.stringify([120_000, 1_500_000]),
    waits: (js.match(WAITS(any(names(WAIT, js)))) ?? []).length === 2,
    stopWait: (js.match(STOP_WAIT(any(names(WAIT, js)), stop)) ?? []).length === 1,
  };
}

export const WHY = {
  solFinals: "a Solana send's expiry is read on one RPC, or from a height with no slot its mark read is held to",
  solMark: "a Solana mark is read with no slot pin (a node behind its height's view reads no mark), or on one RPC",
  solEnd: "a Solana deposit's end is read off its captured sends, before its mark, with a read after the sign out, or told not_landed while the pass builds it again: the app may hear not_landed for a deposit that lands; or the reads are not handed its newest send",
  solLeft: "a Solana run hands the reads sends it already settled, or no hand-off at all",
  solKind: "a Solana deposit whose run ends with a send still open (or throws past it) tells the app nothing more, or part filled while it may still land",
  evmEnd: "an EVM deposit's end is read off its first send, before U's nonce, on a Deposited not final, with a read after the sign out, or told not_landed while the pass builds it again; or the reads are not handed its newest send",
  evmLeft: "an EVM run hands the reads nothing, reads the store before zeroing the seed and keys, or hands no note over when that read fails (part_filled told while a note may land, or nothing after sent)",
  evmKind: "an EVM deposit whose run ends with a send still open tells the app nothing more, or part filled while it may still land",
  solRung: "a Solana rung's landing is posted as filled, which ends the trade in the app at the first rung",
  evmRung: "an EVM note's landing is posted as filled, which ends the trade in the app at the first note",
  loops: "a kind's reads after its run never stop at sign out (or not before each note's read), give up on a clock (a top-up that lands later is never told), never back off (a send that may land read every few seconds for ever), never start the pass, or end before each open note is landed or dead",
  windows: "a kind's reads keep a send that may land at their base wait past its landing window (Solana 120 s, EVM 1,500 s), or never at it, or start no new window for a send any pass sends anew",
  waits: "a kind's reads wait on a timer the sign out does not end",
  stopWait: "a Solana end's wait inside a note's reads goes on past the sign out, so the mark's reads again go out after it",
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
