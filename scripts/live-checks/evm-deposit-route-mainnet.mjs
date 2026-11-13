#!/usr/bin/env node
// Live check of card evm-deposit-route-mainnet on SIGN_HOST (https://confidential.unrealized.trade): money for Base's or
// Robinhood's pool, sent from another chain through NEAR Intents to U_X, is quoted at the device's own floor and carried
// on into the pool from U_X alone, as Solana's is. What it holds, and only that: the served /app.js is the one index.html
// pins (its sha384), and in it, as minified:
//   - floor (pool-deposit-quote.ts evmPoolDepositFloor, pool-deposit-evm.ts readEvmDepositPrice, pool-deposit-address.ts
//     readEvmPoolFloor): the EVM ladder's least rung (0.001 ETH) plus one deposit at the rule's capped gas (1,000,000)
//     and the tree's headroom, at 2 x base fee + U's tip (0.01 gwei), plus the L1 fee; the base fee read on both RPCs at
//     the newest block both hold, the two the same, the depths and the L1 fee bound read there;
//   - follow (pool-deposit-follow.ts evmPoolFollowDeps): U_X's balance polled on the one wallet reader when there is one
//     (its reading as both), else on each of the pool's two RPCs; the costs that floor, its per-rung cost the floor less
//     the rung, nothing kept; the deadline past on both RPCs' latest block time; the status with the op's refund id;
//     with a wallet reader, the reads that may end the follow on each of the pool's two RPCs (review P1); the refund kept;
//   - wired (pool-deposit-follow.ts evmQuoteRoute, main.ts): a quote's floor on Base and Robinhood is readEvmPoolFloor on
//     the page's pool there (its pin and pair from the flow's evmPoolOf), and the follow's deps are evmPoolFollowDeps on
//     that pool with the deposit from U_X (depositFrom with the op's own U_{s,i}), the refund mover at that floor and the
//     store's landed deposit note of (s,i) (review P2a); on a page whose network is not testnet a chain with no wallet
//     reader gets neither (decision M359: U_X's holdings never reach a public provider from the device), so no address
//     is shown that nothing follows;
//   - fromUX (pool-deposit-evm.ts, review H1's rule on EVM): a fixed source of another scope, or whose U^evm_{s,i} is not
//     the op's U_X, or whose deposit note the store never planned, is refused; one with a note still landing is read
//     again; the run's source is then that U alone (never the newest landed U or the planned index), and its opening pass
//     reads that U's notes alone, so no other U's landing is read or makes it wait (review P3); the EVM kind hands the run its fixed source; depositFrom routes Base and Robinhood to it.
//   - landed (pool-deposit-follow.ts evmLanded, review): each landed note of U_X's own sends read on both pool RPCs, its
//     receipt and the finalized block asked at once, the two alike, so every rung's tx reaches the op;
// Also read, and printed, never judged: whether the page has a wallet reader (`reader`: the helper's /v1/rpc route once
// card evm-pools-on-mainnet's pageEvmWalletRpc is wired in main.ts evmWalletRpc; until then mainnet quotes into Base and
// Robinhood stay off).
// What each does is held by the card's tests (packages/signpage/test/pool-deposit-evm.test.ts,
// pool-deposit-follow.test.ts, pool-deposit-address.test.ts, pool-testnet-evm-deposit.test.ts); the recorded answers are
// facts() over each tree's packages/signpage/index.html and public/app.js (this file reaches no package code: the import
// check holds it).
// After: sign
//   node scripts/live-checks/evm-deposit-route-mainnet.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-deposit-route-mainnet";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");
const Q = "`";
const T = `${Q}[^${Q}]*${Q}`; // a template literal

// evmPoolDepositFloor: the rung, the capped gas with the headroom at 2 x base fee + tip, the L1 fee
const FLOOR_FN = new RegExp(
  `function (${N})\\((${N})\\)\\{for\\(let (${N}) of\\[\\2\\.baseFee,\\2\\.tip,\\2\\.l1Fee\\]\\)if\\(typeof \\3!=${Q}bigint${Q}\\|\\|\\3<0n\\)throw new ${N}\\(${Q}floor${Q}\\);` +
    `return (${N})\\.min\\+\\((${N})\\+${N}\\(\\2\\.stateDepth,\\2\\.labelDepth\\)\\)\\*\\(2n\\*\\2\\.baseFee\\+\\2\\.tip\\)\\+\\2\\.l1Fee\\}`,
);
const LADDER = (n) => new RegExp(`[,;\\s]${esc(n)}=Object\\.freeze\\(\\{one:100000000000000n,min:1000000000000000n\\}\\)`);
const CONST = (n, v) => new RegExp(`[,;\\s]${esc(n)}=${v}[,;]`);
// readEvmPoolFloor: the floor of readEvmDepositPrice's reads
const FLOOR_READ = (fl) => new RegExp(`async function (${N})\\((${N}),(${N})\\)\\{return ${esc(fl)}\\(await (${N})\\(\\2,\\3\\)\\)\\}`);
// readEvmDepositPrice: the newest block both hold, its base fee on both and the two the same, the depths, the L1 fee at
// the cap's gas with the headroom; the tip U offers
const PRICE = (p) =>
  new RegExp(
    `async function ${esc(p)}\\((${N}),(${N}),(${N})\\)\\{let (${N})=\\{h:\\{rpcs:\\1,pin:\\2\\}\\},(${N})=await ${N}\\(\\(\\)=>${N}\\(\\1,${Q}latest${Q},void 0,\\3\\),\\3\\),(${N})=${N}\\(\\5\\.number\\),` +
      `(${N})=await ${N}\\(\\1,async\\((${N}),(${N})\\)=>${N}\\(\\(await \\8\\(${Q}eth_getBlockByNumber${Q},\\[\\6,!1\\]\\)\\)\\?\\.baseFeePerGas,${T}\\)\\);` +
      `\\(\\7\\[0\\]!==\\7\\[1\\]\\|\\|\\5\\.baseFeePerGas!==\\7\\[0\\]\\)&&${N}\\(${Q}the base fee${Q}\\);` +
      `let (${N})=await ${N}\\(\\4,\\6\\),(${N})=await ${N}\\(\\4,(${N})\\+${N}\\(\\10\\.state\\[0\\],\\10\\.label\\[0\\]\\),\\6\\);` +
      `return\\{baseFee:\\7\\[0\\],tip:(${N}),l1Fee:\\11\\[0\\],stateDepth:\\10\\.state\\[0\\],labelDepth:\\10\\.label\\[0\\]\\}\\}`,
  );
// evmPoolFollowDeps: both RPCs; U_X on the wallet reader alone when given; the costs; the clocks; the status
const DEPS = new RegExp(
  `function (${N})\\((${N})\\)\\{let (${N})=${N}=>Promise\\.all\\(\\[${N}\\(\\2\\.rpcs\\[0\\],0\\),${N}\\(\\2\\.rpcs\\[1\\],1\\)\\]\\),(${N})=async\\((${N}),(${N}),(${N})\\)=>${N}\\(await \\5\\(${Q}eth_getBalance${Q},\\[\\6,${Q}latest${Q}\\]\\),\\7\\);` +
    `return\\{status:\\((${N}),(${N})\\)=>${N}\\(\\8\\.address,\\8\\.u,\\2\\.fetch\\?\\?fetch,\\9,Date\\.now\\(\\),\\8\\.refund_id\\),` +
    `balances:async (${N})=>\\{if\\(\\2\\.wallet===void 0\\)return \\3\\(\\((${N}),(${N})\\)=>\\4\\(\\11,\\10\\.u,${T}\\)\\);let (${N})=await \\4\\(\\2\\.wallet,\\10\\.u,${T}\\);return\\[\\13,\\13\\]\\},` +
    `\\.\\.\\.\\2\\.wallet===void 0\\?\\{\\}:\\{chainBalances:(${N})=>\\3\\(\\((${N}),(${N})\\)=>\\4\\(\\15,\\14\\.u,${T}\\)\\)\\},` +
    `costs:async\\(\\)=>\\{let (${N})=await (${N})\\(\\2\\.rpcs,\\2\\.pin\\);return\\{floor:\\17,perRung:\\17-(${N})\\.min,keep:0n\\}\\},ladder:\\19,deposit:\\2\\.deposit,` +
    `past:async (${N})=>\\(await \\3\\(async\\((${N}),(${N})\\)=>${N}\\(\\(await \\21\\(${Q}eth_getBlockByNumber${Q},\\[${Q}latest${Q},!1\\]\\)\\)\\?\\.timestamp,${T}\\)\\*1000n\\)\\)\\.every\\((${N})=>\\23>BigInt\\(\\20\\.deadline_ms\\)\\),` +
    `\\.\\.\\.\\2\\.refund\\?\\{refund:\\2\\.refund\\}:\\{\\}`,
);
// the landed txs (review): with the store's notes, each landed note's send read on the pool's two RPCs
const LANDED_SPREAD = new RegExp(`\\.\\.\\.(${N})\\.notes===void 0\\?\\{\\}:\\{landed:\\((${N}),(${N}),(${N})\\)=>(${N})\\(\\1\\.rpcs,\\1\\.pin,\\1\\.notes,\\2,\\3,\\4\\)\\}`);
// evmLanded's one tx read: its receipt and the finalized block, both asked at once on one RPC
const LANDED_READ = (fn) =>
  new RegExp(`async function ${esc(fn)}\\(${N},${N},${N},${N}\\)\\{[^]{0,200}?eth_getTransactionReceipt${Q}[^]{0,80}?eth_getBlockByNumber${Q},\\[${Q}finalized${Q},!1\\]`);
const LANDED = (fn) => new RegExp(`async function ${esc(fn)}\\((${N}),(${N}),(${N}),(${N}),(${N}),(${N})\\)\\{[^]{0,900}?a landed note's send not read yet${Q}\\)\\}return ${N}\\}`);
// pool-deposit-follow.ts evmQuoteRoute: the pool for a quote into U_X (none on Solana, with no pool, or off testnet with
// no wallet reader), its floor readEvmPoolFloor there, and its follow evmPoolFollowDeps there with the deposit and the
// refund mover at that floor
const ROUTE = (deps) =>
  new RegExp(
    `function (${N})\\((${N})\\)\\{let (${N})=(${N})=>\\{if\\(\\4===${Q}solana${Q}\\)return null;let (${N})=\\2\\.pool\\(\\4\\);if\\(\\5===null\\)return null;let (${N})=\\2\\.wallet\\(\\4\\);` +
      `return \\2\\.network!==${Q}testnet${Q}&&\\6===void 0\\?null:\\{\\.\\.\\.\\5,\\.\\.\\.\\6===void 0\\?\\{\\}:\\{wallet:\\6\\}\\}\\};` +
      `return\\{floor:async (${N})=>\\{let (${N})=\\3\\(\\7\\);return \\8===null\\?null:(${N})\\(\\8\\.rpcs,\\8\\.pin\\)\\},` +
      `deps:\\((${N}),(${N}),(${N})\\)=>\\{let (${N})=\\3\\(\\10\\);return \\13===null\\?null:${esc(deps)}\\(\\{\\.\\.\\.\\13,deposit:\\11,refund:\\12\\(\\(\\)=>\\9\\(\\13\\.rpcs,\\13\\.pin\\)\\),\\.\\.\\.\\2\\.notes===void 0\\?\\{\\}:\\{notes:\\2\\.notes\\}\\}\\)\\}\\}\\}`,
  );
// main.ts: the route on the page's network, its pools and its wallet reader (none, a call of one function, or its name)
const ROUTE_CALL = (route) => new RegExp(`[,;](${N})=${esc(route)}\\(\\{network:(${N}),pool:(${N})=>(${N})\\?\\.evmPoolOf\\(\\3\\)\\?\\?null,wallet:(${N}=>void 0|${N}=>${N}\\(${N}\\)|${N}),notes:\\(\\)=>(${N})\\(\\)\\}\\)`);
/** pool-testnet.ts pageEvmWalletRpc on the mainnet build: no testnet return taken, the helper's route at TRADE_HELPER's
 *  /v1/rpc/{chain} (decision M359); evm-deposit-on-mainnet.mjs reads it by the same two marks. */
export const READER = (z) =>
  new RegExp(
    `[,; ]${esc(z)}=\\((${N}),(${N})=!1\\)=>\\{if\\(\\2\\)return;let (${N})=(${N})\\.get\\(\\1\\);if\\(\\3===void 0\\)\\{let (${N})=${N}\\((${N}),\\1\\);\\4\\.set\\(\\1,\\3=Object\\.assign\\(\\((${N}),(${N})\\)=>\\5\\(\\7,\\8\\),\\{url:${Q}\\$\\{\\6\\}/v1/rpc/\\$\\{\\1\\}${Q}\\}\\)\\)\\}return \\3\\}`,
  );
export const HELPER_AT = (h) => new RegExp(`[,; ]${esc(h)}=${Q}https://ct-api\\.unrealized\\.trade${Q}[,;]`);
const once = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length === 1;
/** The route's wallet reader (ROUTE_CALL's fifth group): "none" for `e=>void 0`; "wired" when it is the helper's reader
 *  (READER bound to HELPER_AT, each once), named itself, called as `e=>Z(e)`, or named by a `X=e=>Z(e)` beside it; else
 *  "other". */
export function readerOf(js, w) {
  if (/=>void 0$/.test(w)) return "none";
  const call = new RegExp(`^(${N})=>(${N})\\(\\1\\)$`).exec(w);
  const def = new RegExp(`[,;\\s]${esc(w)}=\\(?(${N})\\)?=>(${N})\\(\\1\\)[,;]`);
  const z = call ? call[2] : once(READER(w), js) ? w : once(def, js) ? def.exec(js)[2] : null;
  const r = z !== null && once(READER(z), js) ? READER(z).exec(js) : null;
  return r && once(HELPER_AT(r[6]), js) ? "wired" : "other";
}
const FLOOR_WIRE = (m) => new RegExp(`=async\\((${N}),(${N})(?:,${N})?\\)=>\\{if\\(\\1!==${Q}solana${Q}\\)return ${esc(m)}\\.floor\\(\\1\\);`);
const DEPS_WIRE = (m) =>
  new RegExp(`=\\((${N}),(${N})\\)=>\\{if\\(\\1\\.chain!==${Q}solana${Q}\\)\\{let (${N})=${esc(m)}\\.deps\\(\\1\\.chain,(${N}),(${N})=>(${N})\\(\\5,\\2\\)\\);return \\3===null\\?null:\\{\\.\\.\\.\\3,noted:(${N}),open:(${N})\\}\\}`);
// main.ts uxNoted (review P2a): the store's landed deposit note of (s,i) read on the page's notes
const NOTED = (v) => new RegExp(`[,;]${esc(v)}=async (${N})=>${N}\\(await ${N}\\(\\),\\1\\)[,;]`);
// main.ts uxOpen (review): a note of U_X's still INCOMING on the page's notes holds in_pool and the end
const OPEN = (v) => new RegExp(`[,;]${esc(v)}=async (${N})=>(${N})\\(await ${N}\\(\\),\\1\\)[,;]`);
const UX_OPEN = (fn) => new RegExp(`function ${esc(fn)}\\((${N}),(${N})\\)\\{return \\1\\.some\\((${N})=>\\3\\.state===${Q}INCOMING${Q}&&${N}\\(\\3,\\2\\)\\)\\}`);
// each mark finds the names it rests on itself, so a rule taken away fails its own mark only
const DEPS_NAME = new RegExp(`function (${N})\\((${N})\\)\\{let ${N}=${N}=>Promise\\.all\\(\\[${N}\\(\\2\\.rpcs\\[0\\],0\\),${N}\\(\\2\\.rpcs\\[1\\],1\\)\\]\\)`);
const READ_NAME = (rd) => new RegExp(`async function ${esc(rd)}\\(${N},${N}\\)\\{return `);
const DEPOSIT_FN = (v) =>
  new RegExp(`[,;]${esc(v)}=\\((${N}),(${N}),(${N})\\)=>${N}\\(\\((${N}),(${N})\\)=>(${N})===null\\?null:\\6\\.depositFrom\\(\\4,\\{s:BigInt\\(\\1\\.s\\),i:\\1\\.i,u:\\1\\.u\\},\\5\\),\\1\\.chain,${N}\\[${N}\\[\\1\\.chain\\]\\],\\2,\\3\\)`);
const REFUND_FN = (y) =>
  new RegExp(`[,;]${esc(y)}=\\((${N}),(${N})\\)=>${N}\\(\\{read:\\((${N}),(${N})\\)=>${N}\\(${Q}intents\\.near${Q},\\3\\.refund_id,\\4,\\3\\.origin,[^]{0,200}?floor:\\1,priced:[^]{0,300}?move:\\2\\.move,record:\\2\\.record\\}\\)`);
// the page's network: testnet only on the testnet build
const NETWORK = (n) => new RegExp(`[,;\\s]${esc(n)}=(?:${Q}mainnet${Q}|${N}\\?${Q}testnet${Q}:${Q}mainnet${Q})[,;]`);
// pool-deposit-evm.ts depositRunEvm's fixed source, and the loop on it
const FIXED = new RegExp(
  // the run's opening pass reads the fixed U's own notes alone (review P3, M359), so no other U's landing is read or waited on
  `for\\(let (${N}) of\\(await (${N})\\(\\)\\)\\.filter\\((${N})=>\\3\\.state===${Q}INCOMING${Q}\\)\\)\\{let (${N})=${N}\\(\\1\\.ref,${N}\\)\\.i;if\\((${N})!==void 0&&\\4!==\\5\\.i\\)continue;` +
    `[^]{0,1500}?if\\(\\5!==void 0\\)\\{if\\(\\5\\.s!==(${N})\\)return\\{error:${Q}not_allowed${Q}\\};let (${N})=${N}\\((${N}),\\5\\.s,\\5\\.i\\);if\\(${N}\\.push\\(\\7\\.secretKey\\),\\7\\.address!==\\5\\.u\\)return\\{error:${Q}not_allowed${Q}\\};` +
    `if\\(${N}\\.has\\(\\5\\.i\\)\\)return\\{stage:${Q}not_landed${Q},txs:\\[\\]\\};if\\(!\\(await \\2\\(\\)\\)\\.some\\((${N})=>\\9\\.ref\\.kind===${Q}deposit${Q}&&\\9\\.ref\\.i===\\5\\.i\\)\\)return\\{error:${Q}not_allowed${Q}\\}\\}` +
    `[^]{0,700}?if\\(\\5===void 0\\?[^]{0,200}?:(${N})=await (${N})\\((${N}),\\{kind:${Q}deposit${Q},s:\\6,i:\\5\\.i\\},null,(${N})\\),\\10===null&&`,
);
// pool-deposit-evm.ts poolDepositEvmKind: its third parameter is the run's fourth argument
const KIND = new RegExp(
  `return\\((${N}),(${N}),(${N})\\)=>\\{if\\(\\1!==null&&\\(\\1\\.kind!==${Q}pool\\.deposit${Q}\\|\\|\\1\\.chain===${Q}solana${Q}\\)\\|\\|!${N}\\)return\\{error:${Q}not_allowed${Q}\\};let (${N})=${N}\\(\\2\\)[^]{0,600}?=await ${N}\\(\\{\\.\\.\\.${N},sent:${N},progress:${N},left:${N}=>void\\(${N}=${N}\\)\\},\\1,\\4,\\3\\)`,
);
// pool-testnet.ts depositFrom: Base and Robinhood to the chain's EVM kind with the same fixed source
const FROM_ENTRY = new RegExp(
  `depositFrom:\\((${N}),(${N}),(${N})\\)=>\\{let (${N});try\\{\\4=${N}\\(\\{\\.\\.\\.\\1,kind:${Q}pool\\.deposit${Q}\\}\\)\\}catch\\{return\\{error:${Q}not_allowed${Q}\\}\\}` +
    `return \\4\\.chain===${Q}solana${Q}\\?${N}===void 0(?:\\|\\|!${N}\\(${Q}solana${Q}\\))?\\?\\{error:${Q}not_allowed${Q}\\}:${N}\\(\\4,\\3,\\2\\):${N}\\(\\4\\.chain\\)\\?\\.\\(\\4,\\3,\\2\\)\\?\\?\\{error:${Q}not_allowed${Q}\\}\\}`,
);

// evmLanded reads each send by the tx read whose receipt and finalized block it asks
const LANDED_READ_OF = (js, fn) => {
  // both RPCs at once, each by the one tx read, apart refused
  const m = new RegExp(`async function ${esc(fn)}\\((${N}),${N},${N},(${N}),${N},${N}\\)\\{[^]{0,120}?await Promise\\.all\\(\\[(${N})\\(\\1\\[0\\],(${N}),\\2\\.u,${N}\\.pool\\),\\3\\(\\1\\[1\\],\\4,\\2\\.u,${N}\\.pool\\)\\]\\);if\\(${N}!==${N}\\)throw`).exec(js);
  return !!m && LANDED_READ(m[3]).test(js);
};

/** The facts the verdict reads, from SIGN_HOST's index.html and /app.js. */
export function facts(index, js) {
  const fl = FLOOR_FN.exec(js);
  const rd = fl ? FLOOR_READ(fl[1]).exec(js) : null;
  const pr = rd ? PRICE(rd[4]).exec(js) : null;
  const deps = DEPS.exec(js);
  const dn = DEPS_NAME.exec(js);
  const rt = dn ? ROUTE(dn[1]).exec(js) : null;
  const rc = rt ? ROUTE_CALL(rt[1]).exec(js) : null;
  const fw = rc ? FLOOR_WIRE(rc[1]).test(js) : false;
  const dw = rc ? DEPS_WIRE(rc[1]).exec(js) : null;
  const op = dw ? OPEN(dw[8]).exec(js) : null;
  const ls = LANDED_SPREAD.exec(js);
  return {
    index,
    sha384: sha384(js),
    floor: !!fl && LADDER(fl[4]).test(js) && CONST(fl[5], "1000000n").test(js) && !!pr && pr[12] === fl[5] && CONST(pr[13], "10000000n").test(js),
    follow: !!deps && READ_NAME(deps[18]).test(js) && LADDER(deps[19]).test(js),
    wired: !!rt && READ_NAME(rt[9]).test(js) && !!rc && readerOf(js, rc[5]) !== "other" && NETWORK(rc[2]).test(js) && fw && !!dw && DEPOSIT_FN(dw[4]).test(js) && REFUND_FN(dw[6]).test(js) && NOTED(dw[7]).test(js) && !!op && UX_OPEN(op[2]).test(js),
    fromUX: FIXED.test(js) && KIND.test(js) && FROM_ENTRY.test(js),
    landed: !!ls && LANDED(ls[5]).test(js) && LANDED_READ_OF(js, ls[5]),
    reader: rc === null ? "unread" : readerOf(js, rc[5]),
  };
}

export const WHY = {
  floor: "a quote into an EVM pool is not held to the rung (0.001 ETH) plus one deposit at the capped gas (1,000,000) and headroom at 2 x base fee + tip (0.01 gwei) plus the L1 fee, read on both RPCs at one block, the base fees the same",
  follow: "the EVM follow does not poll U_X on the one wallet reader (else both RPCs), cost one deposit at that floor with nothing kept, read the deadline on both clocks, or read the status with the op's refund id",
  wired: "Base's and Robinhood's quote floor and follow are not the page's pool there with the deposit from U_X and the refund mover, or their wallet reader is neither none nor the helper's route, or a non-testnet page with no wallet reader still quotes",
  landed: "the EVM follow does not read each landed note's send of U_X's on the pool's two RPCs (its receipt and the finalized block on each, the two alike) into the op's txs",
  fromUX: "an EVM deposit's fixed source is not U_X alone (its scope, its address, a deposit note the store planned, no other U's landing), the kind does not hand it to the run, or depositFrom does not route Base and Robinhood with it",
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
    console.log(`reader: ${answer?.reader ?? "unread"} (mainnet quotes into Base and Robinhood need the helper's wallet reader)`);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
