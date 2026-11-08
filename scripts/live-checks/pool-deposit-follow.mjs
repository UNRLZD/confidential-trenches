#!/usr/bin/env node
// Live check of card pool-deposit-follow on SIGN_HOST (https://sign.confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - the floor (pool-deposit-quote.ts solanaPoolDepositFloor): a pool quote's least delivery is the ladder's least rung
//     (0.01 SOL) plus the worst-case deposit cost (mark address empty, both trees at a new page) plus U_X's rent floor;
//     the floor is read at quote time on both RPCs with the higher fee (pool-deposit-address.ts readSolanaPoolFloor), and
//     a quote is refused "floor" when its context floor is under the rung or its min out (not its amount out) is under the
//     floor, after the kit's check;
//   - the wiring (main.ts): pool.address is handed the price, that floor read and the follow's `quoted`, and the follow's
//     page deps run pool.deposit on Solana through the flow's depositFrom with the op's own U_{s,i}, and the
//     refund mover;
//   - from U_X alone (review H1): runPoolDeposit with a fixed source takes U_{s,i}'s planned deposit note or its next
//     arrival, never the newest-used-or-planned pick, and refuses a U the store never planned or whose address is not
//     the op's U_X; the kind hands its fixed source to the run; depositFrom checks the request by the pool rule before
//     the kind runs;
//   - chain first (pool-deposit-follow.ts): U_X's balance is read at finalized on both RPCs, the lower one counts, the
//     follow deposits only once that is at or over the floor and counts only filled or part_filled as landed, and the
//     1Click status is read with the op's own refund id;
//   - the refund carry (rules/refund.ts checkPoolRefundQuote): a move of a refund under U_{s,i} goes to X's own coin,
//     to U_X, refunds to U_{s,i} itself, and its min out is at least the floor; the key opened for it is the op's own
//     refund id.
// What each does is held by the card's tests (packages/signpage/test/pool-deposit-follow.test.ts, pool-refund-move.test.ts,
// pool-refund-carry.test.ts, pool-deposit-quote.test.ts, pool-deposit-address.test.ts); the recorded answers are facts()
// over each tree's packages/signpage/index.html and public/app.js (this file reaches no package code: the import check
// holds it).
//   node scripts/live-checks/pool-deposit-follow.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-deposit-follow";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");
const Q = "`";

// solanaPoolDepositFloor(fee, rent): the rung, the worst-case cost at fee and rent, U_X's rent at 0 bytes.
const FLOOR_FN = new RegExp(
  `function (${N})\\((${N}),(${N})\\)\\{return (${N})\\.min\\+${N}\\(\\2,\\3,\\{stateSize:0,labelSize:0\\},\\{mark:0n,statePage:0n,labelPage:0n\\}\\)\\+${N}\\(\\3,0\\)\\}`,
);
const LADDER = (n) => new RegExp(`${esc(n)}=Object\\.freeze\\(\\{one:1000000n,min:10000000n\\}\\)`);
// readSolanaPoolFloor: the floor at readSolanaPoolCosts' fee and rent; the costs: the fee on both RPCs, the higher.
const FLOOR_READ = new RegExp(`async function (${N})\\((${N}),(${N}),(${N})\\)\\{let\\{fee:(${N}),rent:(${N})\\}=await (${N})\\(\\2,\\3,\\4\\);return ${N}\\(\\5,\\6\\)\\}`);
const COSTS = (c) =>
  new RegExp(
    `async function ${esc(c)}\\((${N}),${N},${N}\\)\\{let (${N})=await ${N}\\(\\1\\),(${N})=await Promise\\.all\\(\\1\\.map\\(async ${N}=>\\{[^}]*getLatestBlockhash[\\s\\S]{0,400}?getFeeForMessage[\\s\\S]{0,200}?\\}\\)\\);return\\{fee:\\3\\[0\\]>\\3\\[1\\]\\?\\3\\[0\\]:\\3\\[1\\],rent:\\2\\}\\}`,
  );
// pool-deposit-quote.ts: the context floor at least the rung; after the kit's check, min out at least the floor.
const QUOTE_FLOOR = new RegExp(
  `\\(typeof (${N})\\.floor!=${Q}bigint${Q}\\|\\|\\1\\.floor<${N}\\[\\1\\.chain\\]\\)&&(${N})\\(${Q}floor${Q}\\)[\\s\\S]{0,1400}?let (${N})=${N}\\(${N},${N},\\{\\.\\.\\.\\1\\.check,intoVault:!1\\}\\);return \\3\\.minAmountOut<\\1\\.floor&&\\2\\(${Q}floor${Q}\\),\\3\\}`,
);
// main.ts: pool.address with the price, the floor read and the follow's quoted.
const WIRED = new RegExp(
  `"pool\\.address":${N}\\(\\{pools:${N},network:${N},read:${N}\\.depositRead,named:\\(\\)=>${N}\\.named\\(\\),priced:${N},floor:(${N}),checked:\\((${N}),(${N}),(${N}),(${N})\\)=>(${N})\\.quoted\\(\\2,\\3,\\4,\\5\\)\\}\\)`,
);
const FLOOR_WIRE = (u) =>
  new RegExp(`[,;]${esc(u)}=async\\((${N}),(${N})\\)=>\\{let (${N})=${N}\\(\\);return \\1===${Q}solana${Q}&&\\3!==null&&${N}!==void 0\\?${N}\\(\\3,${N}\\.program,\\2\\):null\\}`);
const FOLLOW_INST = (f) => new RegExp(`[,;]${esc(f)}=${N}\\?null:${N}\\(\\{store:\\(\\)=>${N}\\(\\),decimals:${N}=>${N}\\[${N}\\[${N}\\]\\],deps:\\((${N}),(${N})\\)=>(${N})\\(\\1,\\2\\)\\}\\)`);
const FOLLOW_DEPS = (d) =>
  new RegExp(
    `[,;]${esc(d)}=\\(${N},${N}\\)=>\\{let (${N})=${N}\\(\\);if\\(${N}\\.chain!==${Q}solana${Q}\\|\\|\\1===null\\|\\|${N}===void 0\\)return null;let ${N}=${N}\\.program;return (${N})\\(\\{rpcs:\\1,program:${N},deposit:\\((${N}),(${N}),(${N})\\)=>${N}\\(\\((${N}),(${N})\\)=>(${N})===null\\?null:\\8\\.depositFrom\\(\\6,\\{s:BigInt\\(\\3\\.s\\),i:\\3\\.i,u:\\3\\.u\\},\\7\\),${Q}solana${Q},${N}\\.SOL,\\4,\\5\\),refund:${N}\\(\\{`,
  );
// pool-deposit-follow.ts solanaPoolFollowDeps: both RPCs; the status with the refund id; the balance at finalized; the floor.
const READS =
  new RegExp(
    `function ${N}\\((${N})\\)\\{let (${N})=(${N})=>Promise\\.all\\(\\[\\3\\(\\1\\.rpcs\\[0\\]\\),\\3\\(\\1\\.rpcs\\[1\\]\\)\\]\\);return\\{status:\\((${N}),(${N})\\)=>${N}\\(\\4\\.address,\\4\\.u,\\1\\.fetch\\?\\?fetch,\\5,Date\\.now\\(\\),\\4\\.refund_id\\),` +
      `balances:(${N})=>\\2\\(async (${N})=>${N}\\(await \\7\\(${Q}getBalance${Q},\\[\\6\\.u,\\{commitment:${Q}finalized${Q}\\}\\]\\)\\)\\),` +
      `costs:async (${N})=>\\{let\\{fee:(${N}),rent:(${N})\\}=await ${N}\\(\\1\\.rpcs,\\1\\.program,\\8\\.u\\),(${N})=${N}\\(\\9,\\10\\)`,
  );
// followPoolQuote: the lower balance; at or over the floor, the deposit; filled or part_filled counts as landed.
const LOOP = new RegExp(
  `let\\[(${N}),(${N})\\]=await (${N})\\.balances\\((${N})\\),(${N})=\\1<\\2\\?\\1:\\2,(${N})=\\5>=\\3\\.ladder\\.min\\?await \\3\\.costs\\(\\4\\):null;if\\(\\6!==null&&\\5>=\\6\\.floor\\)\\{let (${N})=${N}\\(\\3\\.ladder,\\5,\\6\\.perRung,\\6\\.keep\\);if\\(\\7>0n\\)\\{let (${N})=await \\3\\.deposit\\(\\4,\\7,\\3\\.signal\\);\\(\\8===${Q}filled${Q}\\|\\|\\8===${Q}part_filled${Q}\\)&&`,
);
// pool-deposit.ts runPoolDeposit's fixed source (review H1): U_{s,i}'s own deposit note or its next arrival, a U the
// store never planned refused, and the newest-used-or-planned fallback skipped; pool-testnet.ts depositFrom: the request
// checked by the pool rule as a deposit, then the Solana kind run with the fixed source.
const FIXED = new RegExp(
  `if\\((${N})!==void 0\\)\\{if\\(\\1\\.s!==${N}\\|\\|${N}\\(\\1\\)\\.address!==\\1\\.u\\)return\\{error:${Q}not_allowed${Q}\\};if\\(${N}\\.has\\(\\1\\.i\\)\\)return\\{stage:${Q}not_landed${Q},txs:\\[\\]\\};` +
    `let (${N})=${N}\\.find\\((${N})=>\\3\\.ref\\.kind===${Q}deposit${Q}&&\\3\\.ref\\.s===\\1\\.s&&\\3\\.ref\\.i===\\1\\.i\\);if\\(\\2===void 0\\)return\\{error:${Q}not_allowed${Q}\\};` +
    `(${N})=\\{s:\\1\\.s,i:\\1\\.i\\},(${N})=\\2\\.state===${Q}PLANNED${Q}\\?\\2\\.ref:${N}\\(\\1\\.i\\)\\}` +
    `[^]{0,4000}?if\\(\\1===void 0&&${N}===0&&\\4\\.i===${N}&&${N}\\.ref\\.kind===${Q}second${Q}\\)\\{\\4=null,\\5=null;continue\\}`,
);
// pool-deposit.ts poolDepositKind: the kind's third parameter (the fixed source) is the run's third argument (review 2 L1)
const KIND = new RegExp(`return\\((${N}),(${N}),(${N})\\)=>\\{if\\(\\1!==null&&\\(\\1\\.kind!==${Q}pool\\.deposit${Q}[^]{0,1600}?=await ${N}\\(${N},\\1,\\3\\)\\}finally\\{`);
const FROM_ENTRY = new RegExp(
  `depositFrom:\\((${N}),(${N}),(${N})\\)=>\\{let (${N});try\\{\\4=${N}\\(\\{\\.\\.\\.\\1,kind:${Q}pool\\.deposit${Q}\\}\\)\\}catch\\{return\\{error:${Q}not_allowed${Q}\\}\\}` +
    `return \\4\\.chain!==${Q}solana${Q}\\|\\|${N}===void 0\\?\\{error:${Q}not_allowed${Q}\\}:${N}\\(\\4,\\3,\\2\\)\\}`,
);
// rules/refund.ts checkPoolRefundQuote, and the mover's key open (poolRefundMover).
const REFUND_RULE = new RegExp(
  `if\\((${N})\\.destinationAsset!==${N}\\[(${N})\\]\\)return (${N})\\(${Q}destinationAsset${Q}\\);if\\(\\1\\.recipient!==(${N})\\.wallet\\)return \\3\\(${Q}recipient${Q}\\);if\\(\\1\\.recipientType!==${Q}DESTINATION_CHAIN${Q}\\)return \\3\\(${Q}recipientType${Q}\\);` +
    `if\\(\\1\\.refundTo!==(${N})\\.id\\)return \\3\\(${Q}refundTo${Q}\\);if\\(\\1\\.refundType!==${Q}INTENTS${Q}\\)return \\3\\(${Q}refundType${Q}\\);let (${N})=${N}\\(\\1,${N},\\{\\.\\.\\.\\4\\.check,intoVault:!1\\}\\);return \\6\\.minAmountOut<\\4\\.floor\\?\\3\\(${Q}floor${Q}\\):${N}\\(\\6,\\{kind:${Q}refund${Q}`,
);
const REFUND_HEAD = new RegExp(`[;{]try\\{${N}\\((${N}),(${N})\\.wallet,(${N})\\.id\\)\\}catch\\{return (${N})\\(${Q}deposit_wallet${Q}\\)\\}if\\(typeof \\2\\.floor!=${Q}bigint${Q}\\|\\|\\2\\.floor<${N}\\[\\1\\]\\)return \\4\\(${Q}floor${Q}\\);`);
const REFUND_KEY = new RegExp(`let (${N})=${N}\\((${N}),BigInt\\((${N})\\.s\\),\\3\\.i\\);try\\{if\\(\\1\\.id!==\\3\\.refund_id\\)throw Error\\(`);

/** The facts the verdict reads, from SIGN_HOST's index.html and /app.js. */
export function facts(index, js) {
  const fl = FLOOR_FN.exec(js);
  const rd = FLOOR_READ.exec(js);
  const wired = WIRED.exec(js);
  const inst = wired ? FOLLOW_INST(wired[6]).exec(js) : null;
  const deps = inst ? FOLLOW_DEPS(inst[3]).exec(js) : null;
  return {
    index,
    sha384: sha384(js),
    floor: !!fl && LADDER(fl[4]).test(js) && QUOTE_FLOOR.test(js),
    floorRead: !!rd && COSTS(rd[7]).test(js),
    wired: !!wired && FLOOR_WIRE(wired[1]).test(js) && !!deps,
    chainFirst: READS.test(js) && LOOP.test(js),
    fromUX: FIXED.test(js) && KIND.test(js) && FROM_ENTRY.test(js),
    refundCarry: REFUND_HEAD.test(js) && REFUND_RULE.test(js) && REFUND_KEY.test(js),
  };
}

export const WHY = {
  floor: "a pool quote is not refused floor under the rung (0.01 SOL) plus the worst-case deposit cost plus U_X's rent floor, on its min out after the kit's check",
  floorRead: "the floor is not read at quote time from the fee on both RPCs (the higher) and the rent",
  wired: "pool.address is not handed the floor read and the follow's quoted, or the follow's deps do not run pool.deposit on Solana with the refund mover",
  chainFirst: "the follow does not read U_X's balance at finalized on both RPCs (the lower counting), deposit only at or over the floor, count only filled or part_filled, or read the status with the op's refund id",
  fromUX: "the follow's deposit does not run from U_X alone (its own deposit note or next arrival, never the newest used or the planned U, and only a U whose address is the op's U_X), the kind does not hand the run its fixed source, or the page's depositFrom does not check the request by the pool rule first",
  refundCarry: "a refund's move is not held to X's own coin, to U_X, refunding to U_{s,i}, with min out at least the floor, or its key is not the op's own refund id",
};

/** The verdict on an answer (facts()). */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const [k, why] of Object.entries(WHY)) if (a?.[k] !== true) bad(why);
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
