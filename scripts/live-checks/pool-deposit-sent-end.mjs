#!/usr/bin/env node
// Live check of card pool-deposit-sent-end on SIGN_HOST (https://sign.confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - Solana deposit (pool-deposit.ts noteEnd): an open note of an ask is dead only when every send is past its last
//     valid height at finalized on BOTH RPCs (or failed on both), those heights read before a mark read that finds none;
//     a mark on one RPC only is no end;
//   - Solana kind (poolDepositKind): a run that ends past its ask's send with no end (not filled or part_filled) has its
//     open notes read on once its locks are let go, and their end goes to the app as a progress stage;
//   - EVM deposit (pool-deposit-evm.ts noteEndEvm): dead only when U's finalized nonce is past every send on BOTH RPCs,
//     read before the round that finds no Deposited naming the note; a Deposited above the finalized block is no end;
//   - EVM kind (poolDepositEvmKind): the same reads after its run, their end as a progress stage;
//   - each kind's reads end only once every open note is landed or dead, then filled, part_filled or not_landed.
// What each does is held by the card's tests (packages/signpage/test/pool-deposit.test.ts and pool-deposit-evm.test.ts,
// each "pool-deposit-sent-end"); the recorded answers are facts() over each tree's packages/signpage/index.html and
// public/app.js (this file reaches no package code: the import check holds it).
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
// Solana: the heights on both RPCs, each send past its last valid height on every one of them, then the failed-on-both
// read, then the mark; a mark on one RPC no end, none dead only when every send is
const SOL_DEAD = new RegExp(
  `let (${N})=await ${N}\\(${N}\\),(${N})=${N}\\.sends\\.map\\(${N}=>\\1\\.every\\(${N}=>${N}>${N}\\.last_valid_block_height\\)\\),(${N})=\\2\\.every\\(Boolean\\)\\?\\2:await ${N}\\(${N},${N}\\.sends,\\2\\),(${N})=await ${N}\\(${N},${N}\\.precommitment\\);return \\4===${Q}one${Q}\\?null:\\4===null\\?\\3\\.every\\(Boolean\\)\\?${Q}dead${Q}:null:`,
);
// EVM: U's finalized nonce on both RPCs, then the round; no Deposited: dead only past the nonce on both; one above the
// finalized block: no end
const EVM_DEAD = new RegExp(
  `\\[(${N})\\.u,${Q}finalized${Q}\\]\\)[^;]{0,80}\\),(${N})=await ${N}\\.round\\(\\),(${N})=\\2\\.events\\.find\\(${N}=>${N}\\.kind===${Q}deposit${Q}&&${N}\\.precommitment===\\1\\.precommitment\\);return \\3===void 0\\?(${N})\\[0\\]>\\1\\.nonce&&\\4\\[1\\]>\\1\\.nonce\\?${Q}dead${Q}:null:\\3\\.block>\\2\\.finalBlock\\?null:\\3\\.value===\\1\\.value\\?${Q}landed${Q}:${Q}dead${Q}`,
);
// a kind's reads after its run: let go of its locks first (the Solana kind's .finally, the EVM kind's .then), then its
// open notes read on, their end posted as progress
const AFTER = `\\.then\\(\\(\\)=>\\{let (${N})=${N};if\\(\\1!==null&&(${N})!==null\\)return ${N}\\(\\1\\.h,\\1\\.left\\)\\.then\\((${N})=>\\2\\.progress\\(\\3\\),\\(\\)=>\\{\\}\\)\\}\\)`;
const SOL_KIND = new RegExp(`\\.finally\\(${N}\\)${AFTER}`);
const EVM_KIND = new RegExp(`${Q}failed${Q}\\},${N}\\(\\)\\}\\)${AFTER}`);
// the run's end that is no end: answered, not filled or part_filled, its open notes kept for the reads
const SOL_KEEP = new RegExp(`\\?${N}\\.stage===${Q}part_filled${Q}&&${N}\\?\\.progress\\(${N}\\.stage\\):${N}!==null&&\\(${N}=\\{h:${N},left:${N}\\}\\)`);
const EVM_KEEP = new RegExp(`\\?${N}\\?\\.progress\\(${N}\\.stage\\):${N}!==null&&\\(${N}=\\{h:${N},left:${N}\\}\\)`);
// the reads: every open note read until each is landed or dead (a read that fails: null, read again), then the end
const LOOP = new RegExp(
  `for\\(;;\\)\\{for\\(let\\[(${N}),(${N})\\]of ${N}\\.notes\\.entries\\(\\)\\)(${N})\\[\\1\\]\\?\\?=await ${N}\\([^)]*\\2\\)\\.catch\\(\\(\\)=>null\\);if\\(\\3\\.every\\(${N}=>${N}!==null\\)\\)break;await ${N}\\(${N}\\)\\}return ${N}\\.whole&&\\3\\.length>0&&\\3\\.every\\(${N}=>${N}===${Q}landed${Q}\\)\\?${Q}filled${Q}:${N}\\.landed\\|\\|\\3\\.includes\\(${Q}landed${Q}\\)\\?${Q}part_filled${Q}:${Q}not_landed${Q}`,
  "g",
);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return {
    index,
    sha384: sha384(js),
    solDead: SOL_DEAD.test(js),
    solKind: SOL_KIND.test(js) && SOL_KEEP.test(js),
    evmDead: EVM_DEAD.test(js),
    evmKind: EVM_KIND.test(js) && EVM_KEEP.test(js),
    loops: (js.match(LOOP) ?? []).length,
  };
}

/** The verdict on an answer { index, sha384, solDead, solKind, evmDead, evmKind, loops }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.solDead !== true) bad("a Solana deposit's send is read dead on one RPC's height, or before its mark: the app may hear not_landed for a deposit that lands");
  if (a?.solKind !== true) bad("a Solana deposit whose run ends past its send with no end tells the app nothing more: the app sits at sent");
  if (a?.evmDead !== true) bad("an EVM deposit's send is read dead on one RPC's nonce, or on a Deposited not final: the app may hear not_landed for a deposit that lands");
  if (a?.evmKind !== true) bad("an EVM deposit whose run ends at sent tells the app nothing more: the app sits at sent");
  if (a?.loops !== 2) bad("a kind's reads after its run end before each open note is landed or dead: the app may hear an end that is not one");
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
