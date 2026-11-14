#!/usr/bin/env node
// Live check of card leftovers-carry-to-cash on SIGN_HOST (https://confidential.unrealized.trade): what a one-time wallet
// keeps under one deposit's floor (a U_X a deposit left money at, a short deposit's U_X, a W's tail) goes whole to Cash,
// one wallet a send, and stays counted on its wallet until then. Reads only: nothing is signed or sent. What it holds,
// and only that: SIGN_HOST serves the script its index.html pins (its sha384), and, each found by a mark of the minified
// bundle's shape (packages/signpage/src/leftover-carry.ts, carry-cash-sol.ts, rules/pool.ts, pool-deposit-follow.ts,
// main.ts):
//   - floor: under the vault's least deposit (1 USDC, 1000000n) at the device's price nothing is asked: the leftover is
//     kept ("under"), tried again next pass;
//   - record: Cash's quote's address checked on the chain, the open carry (to, amount, quote, sends []) written before
//     the send, a write that fails sending nothing;
//   - sources: a U_X's newest op ended in the pool or short with its left over 0;
//   - short: the follow writes what U_X holds each time it shows short (Base's "Short deposit" counted and carried);
//   - rule: the Solana send is one transfer of exactly the amount, the wallet's whole lamports less the one fee;
//   - loop: the carry runs one tab's pass at a time (the ct-carry-cash lock), its open record under meta owed/;
//   - evmRule: Base's and Robinhood's send is one plain transfer at the read gas (Base 21,000, Robinhood its estimate), to
//     a deposit address with no code on both RPCs;
//   - evmRecord: an EVM send is written (hash, nonce) before it leaves, and one no RPC ever saw is quoted again;
//   - evmTail: an EVM W ending empty or carried keeps what it holds as a counted tail (w-tail/base|robinhood/<W>);
//   - evmWired: the page gives Base and Robinhood their sender on the chain's own pool pair.
// The numbers and every refusal are packages/signpage/test/leftover-carry.test.ts, carry-cash-sol.test.ts and
// deposit-left-counted.test.ts at the released commit. The recorded answers are facts() over
// packages/signpage/scripts/build-app.mjs's build (mainnet, as SIGN_HOST serves) and SIGN_HOST as served before.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/leftovers-carry-to-cash.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "leftovers-carry-to-cash";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";

const FLOOR = new RegExp(`let (${N})=await (${N})\\.sendable\\((${N}),${N}\\.signal\\)\\.catch\\(\\(\\)=>null\\);if\\(\\1===null\\)return\\{src:\\3,end:\`unread\`\\};let (${N})=\\1>0n\\?${N}\\.worth\\(\\3\\.chain,\\1\\):0n;if\\(\\4===null\\|\\|\\4<1000000n\\)return\\{src:\\3,end:\`under\`\\}`);
const RECORD = new RegExp(`if\\(\`error\`in (${N})\\|\\|!(${N})\\.onChain\\((${N})\\.chain,\\1\\.address\\)\\)return\\{src:\\3,end:\`refused\`\\};let (${N})=\\{to:\\1\\.address,amount:(${N})\\.toString\\(\\),quote:${N},quotedMs:String\\(\\2\\.now\\(\\)\\),sends:\\[\\]\\};try\\{await \\2\\.keep\\(\\3,\\4\\)\\}catch\\{return\\{src:\\3,end:\`fault\`\\}\\}return ${N}\\(await ${N}\\.send\\(\\3,\\4,`);
const SOURCES = new RegExp(`\\((${N})\\.stage===\`in_pool\`&&\\1\\.final===!0\\|\\|\\1\\.stage===\`short\`\\)&&\\1\\.follow\\.left!==void 0&&/\\^\\[0-9\\]\\{1,78\\}\\$/\\.test\\(\\1\\.follow\\.left\\)&&BigInt\\(\\1\\.follow\\.left\\)!==0n&&`);
const SHORT = new RegExp(`\\(await (${N})\\(\`short\`\\),await (${N})\\.holds\\?\\.\\((${N})\\)(?:,${N}=!0)?\\)`, "g");
const RULE = new RegExp(`if\\((${N})\\((${N})\\.data,4\\)!==(${N})\\.amount\\)return (${N})\\(\`amount\`\\);if\\(\\3\\.amount!==\\3\\.lamports-5000n\\)return \\4\\(\`carry_whole\`\\)`);
const LOOP = /\.request\(`ct-carry-cash`,\{ifAvailable:!0\},/;
const OPEN_KEY = new RegExp(`=(${N})=>\`owed/carry-cash-\\$\\{\\1\\.chain\\}-\\$\\{\\1\\.address\\}\``);
// Base and Robinhood (src/carry-cash-evm.ts, rules/pool.ts checkEvmCashCarry, pool-carry-evm.ts, main.ts)
const EVM_RULE = new RegExp(`if\\((${N})\\)\\{if\\((${N})<21000n\\|\\|\\2>100000n\\)return (${N})\\(\`gas_over_cap\`\\);if\\((${N})\\.gasLimit!==\\2\\)return \\3\\(\`gas_limit\`\\)\\}else\\{if\\(\\4\\.gasLimit!==21000n\\)return \\3\\(\`gas_limit\`\\);if\\(\\2!==21000n\\)return \\3\\(\`gas_estimate\`\\)\\}`);
const EVM_RECORD = new RegExp(`return (${N})\\.fill\\(0\\),\\1=null,await (${N})\\(\\{\\.\\.\\.(${N}),sends:\\[\\.\\.\\.\\3\\.sends,\\{hash:[^}]{0,80},nonce:(${N})\\.nonce\\.toString\\(\\)\\}\\]\\}\\),await Promise\\.allSettled\\((${N})\\.map\\((${N})=>\\6\\(\`eth_sendRawTransaction\``);
const EVM_UNSENT = new RegExp(`for\\(let (${N}) of (${N})\\)if\\(await (${N})\\(\`eth_getTransactionByHash\`,\\[\\1\\]\\)!==null\\)return!0;return!1\\}\\);return (${N})\\[0\\]\\|\\|\\4\\[1\\]\\?\`pending\`:[^;]{0,260}\\.every\\((${N})=>\\5\\[0\\]===(${N})&&\\5\\[1\\]===\\6\\)\\?\`dead\`:\`pending\``);
const EVM_TAIL = new RegExp(`(${N})===\`empty\`\\|\\|\\1===\`landed\`\\)\\{if\\((${N})!==null&&\\2>0n\\)\\{let (${N})=\\{chain:(${N})\\((${N})\\.chain\\),address:(${N})\\.w,l:\\6\\.l\\.toString\\(\\),j:\\6\\.j,amount:\\2\\.toString\\(\\)\\};await (${N})\\.update\\(\`meta\`,(${N})\\(\\5\\.chain,\\6\\.w\\),\\(\\)=>\\3\\)\\}`);
// the deposit address a plain account on both RPCs: the rule refuses code (or two answers apart), the sender reads it
const EVM_NO_CODE = new RegExp(`\\|\\|${N}\\(${N}\\?\\.toHasCode,(${N})=>typeof \\1==\`boolean\`\\)\\)return ${N}\\(\`to\`\\)`);
const EVM_CODE_READ = new RegExp(`let (${N})=await ${N}\\(\`eth_getCode\`,\\[${N},${N}\\.tag\\]\\);if\\(typeof \\1!=\`string\`[^;]{0,80}\\)throw Error\\(\`not code\`\\);return \\1!==\`0x\``);
const TAIL_NAMES = /\{solana:`sol`,base:`base`,robinhood:`robinhood`\}/;
const EVM_WIRED = new RegExp(`sender:(${N})=>\\1===\`solana\`\\?${N}:(${N})\\(\\1\\)`);
const EVM_SENDER = new RegExp(`let (${N})=${N}\\?\\.evmPoolOf\\((${N})\\)\\?\\?null;${N}\\.set\\(\\2,\\1===null\\?null:${N}\\(\\{chain:\\2,network:\\1\\.pin\\.network,rpcs:\\1\\.rpcs,`);

/** What the check keeps of the reads: the index, the served bundle's sha384, and the marks read from it. */
export function facts(index, js) {
  return {
    index,
    sha384: sha384(js),
    floor: FLOOR.test(js),
    record: RECORD.test(js),
    sources: SOURCES.test(js),
    short: (js.match(SHORT) ?? []).length >= 2,
    rule: RULE.test(js),
    loop: LOOP.test(js) && OPEN_KEY.test(js),
    evmRule: EVM_RULE.test(js) && EVM_NO_CODE.test(js) && EVM_CODE_READ.test(js),
    evmRecord: EVM_RECORD.test(js) && EVM_UNSENT.test(js),
    evmTail: EVM_TAIL.test(js) && TAIL_NAMES.test(js),
    evmWired: EVM_WIRED.test(js) && EVM_SENDER.test(js),
  };
}

export const SAYS = Object.freeze({
  floor: "the carry does not keep a leftover under the vault's least deposit (1 USDC at the device's price) on its wallet, counted, to try again: it asks for a quote the vault refuses, or drops it",
  record: "the carry does not check Cash's deposit address on the chain and write its open record before the send (a write that fails must send nothing): a reload could send twice",
  sources: "the carry does not take a U_X whose newest op ended in the pool or shows short with money left: the owner's Robinhood 0.0009941 ETH stays on U_X",
  short: "the deposit follow does not write a short deposit's U_X money as its left: Base's Short deposit is neither counted nor carried",
  rule: "the Solana carry is not held to one transfer of exactly the wallet's whole lamports less the one fee",
  loop: "the page does not run the carry one tab at a time with its open record under meta owed/",
  evmRule: "the Base and Robinhood carry is not held to one plain send at the read gas (Base exactly 21,000; Robinhood its agreed estimate, under 100,000) to a deposit address both RPCs read as holding no code",
  evmRecord: "the Base and Robinhood carry does not write its send (hash and nonce) before it leaves, or never quotes again a send no RPC ever saw: a reload could send twice or wait forever",
  evmTail: "an EVM W ending empty or carried does not keep what it still holds as a counted tail: the money reads as gone",
  evmWired: "the page gives Base and Robinhood no carry sender on the chain's own pool pair: their leftovers stay on the wallet",
});

/** The verdict on an answer { index, sha384, floor, record, sources, short, rule, loop, evmRule, evmRecord, evmTail, evmWired }. */
export function judge(a) {
  const lines = [];
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) lines.push("BAD SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) lines.push("BAD SIGN_HOST's served /app.js is not the one index.html pins");
  for (const [k, say] of Object.entries(SAYS)) if (a?.[k] !== true) lines.push(`BAD ${say}`);
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
