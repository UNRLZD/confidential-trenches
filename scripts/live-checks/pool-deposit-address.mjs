#!/usr/bin/env node
// Live check of card pool-deposit-address on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - naming ahead (deposit-name.ts): the page's namer is handed the page's pinned pools less NEAR, each with its scope
//     (main.ts pagePoolScopes), names the vault's scope and each pool's, each in its own try (one scope that fails names
//     the rest), an EVM pool's as Base or Robinhood (not Solana), and writes each pool's record with the scope's planned
//     index, its one-time id and, on an EVM pool, its EVM address (the key zeroed first);
//   - pool.address (pool-deposit-address.ts): wired on the page with the pools, the deposit record read and the namer's
//     wait, and nothing more; it answers the asked chain's own pool, from that pool scope's record read back (the seed
//     backed up), the address on Solana the one-time id's own key and on an EVM pool the record's EVM address;
//   - a cross-chain quote (an origin asset or an amount) with no follow or floor read wired, or on a page whose pools are not pinned on
//     mainnet (the only network 1Click pays out on; a plain send of the pool's own coin to U_X too, card
//     deposit-takes-each-pools-own-coin review P3-c), is refused: the answer starts not_allowed and the host returns
//     before any quote is asked when the page passes no `checked`, no `floor` or its network is not mainnet; the page passes
//     its own network (review F2), and since card pool-deposit-follow the follow's `quoted`, the price and the floor read;
//   - since card helper-says-why-a-vendor-refused, pool.address reads the page's stop once as a request arrives and checks
//     it after each wait (the namer's, both record reads, the floor read, the follow's write), and hands it to the floor
//     read and the quote's ask; the page's floor hands it on to the Solana floor's reads, each checked before it starts
//     (the fee read names U_X): a sign out during any of them answers not_allowed, as a signed-out page does, with
//     nothing after it run;
//   - a pool quote whose min out is under its context floor is refused "floor" after the kit's check, and a context floor
//     under the ladders' least rungs (0.01 SOL, 0.001 ETH on Base and Robinhood) is refused (review F3);
//   - since card move-one-confidential-swap, pool.address is wired confidential with the keyless tell (`hidden` calls
//     the tell with the page's fetch and the request's stop), and after the quote's check it waits for the tell on the
//     stop, checks the stop after it, and answers an address only when 1Click answered "hidden" (the tell's own body is
//     held by that card's live check).
// What each does is held by the card's tests (packages/signpage/test/deposit-name.test.ts and
// pool-deposit-address.test.ts); the recorded answers are facts() over each tree's packages/signpage/index.html and
// public/app.js (this file reaches no package code: the import check holds it).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/pool-deposit-address.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-deposit-address";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");
const Q = "`";

// main.ts pagePoolScopes: the pinned pools less NEAR, each with its scope.
const POOLS_FN = new RegExp(`function (${N})\\(\\)\\{return ${N}\\.flatMap\\(${N}=>${N}\\.chain===${Q}near${Q}\\?\\[\\]:\\[\\{chain:${N}\\.chain,scope:${N}\\.scope\\}\\]\\)\\}`);
// deposit-name.ts nameNow: the vault's scope, then each pool's (EVM unless Solana), each named in its own try.
// each pool's scope with its chain (card deposit-takes-each-pools-own-coin: a pool's U_X still holding money stays named)
const SCOPES = new RegExp(`\\.\\.\\.\\(${N}\\.pools\\?\\.\\(\\)\\?\\?\\[\\]\\)\\.map\\((${N})=>\\(\\{scope:\\1\\.scope,evm:\\1\\.chain!==${Q}solana${Q},chain:\\1\\.chain\\}\\)\\)`);
const EACH = new RegExp(`for\\(let\\{scope:(${N}),evm:(${N}),chain:(${N})\\}of ${N}\\)try\\{await ${N}\\(${N},${N},${N},\\1,\\2,\\3\\)\\}catch\\{\\}`);
// deposit-name.ts nameScope: the planned index of the scope, the id, the EVM address (key zeroed), then the record: read
// first with no lock, and nameDeposit asked unless it already holds this scope's index, id and address or a higher
// index (card signpage-passes-yield-to-a-trade: a naming that changes nothing asks no exclusive seed lock).
const PLAN = new RegExp(`\\.planDeposit\\((${N}),${N}=>${N}\\(${N},${N}\\)\\.precommitment\\);if\\(${N}\\.ref\\.kind!==${Q}deposit${Q}\\|\\|${N}\\.scope!==\\1\\)throw`);
const EVM_NAME = new RegExp(
  `if\\((${N})\\)\\{let (${N})=${N}\\(${N},${N},(${N})\\);\\2\\.secretKey\\.fill\\(0\\),(${N})=\\2\\.address\\}` +
    `let (${N})=${N}\\(await (${N})\\.get\\(${Q}meta${Q},${N}\\((${N})\\)\\)\\.catch\\(\\(\\)=>void 0\\)\\);` +
    `\\5!==void 0&&\\5\\.scope===\\7\\.toString\\(\\)&&\\(\\5\\.index>\\3\\|\\|\\5\\.index===\\3&&\\5\\.id===(${N})\\.id&&\\5\\.evm===\\4\\)\\|\\|` +
    // a pool's record on an index below the planned one stays while its U_X still holds money (`held`; card
    // deposit-takes-each-pools-own-coin review P1): only that scope's own record, only a lower index, a failed read kept
    `(${N})!==void 0&&(${N})\\.held!==void 0&&\\5!==void 0&&\\5\\.scope===\\7\\.toString\\(\\)&&\\5\\.index<\\3&&await \\10\\.held\\(\\9,\\5\\)\\.catch\\(\\(\\)=>!0\\)\\|\\|` +
    `await \\6\\.nameDeposit\\(\\{entropy:${N}\\},\\{scope:\\7,index:\\3,id:\\8\\.id,\\.\\.\\.\\4===void 0\\?\\{\\}:\\{evm:\\4\\}\\}\\)`,
);
// pool-deposit-address.ts walletOf and the record read.
const WALLET_FN = new RegExp(`function (${N})\\(${N},${N}\\)\\{return ${N}===${Q}solana${Q}\\?${N}\\.evm===void 0\\?${N}\\.encode\\(${N}\\.decode\\(${N}\\.id\\)\\):null:${N}\\.evm\\?\\?null\\}`);
const READ_FN = (w) =>
  new RegExp(`function (${N})\\(${N},${N},${N}\\)\\{if\\(!${N}\\|\\|!${N}\\.status\\|\\|!${N}\\.deposit\\|\\|${N}\\(${N}\\.status\\)\\|\\|${N}\\.deposit\\.scope!==${N}\\.toString\\(\\)\\)return null;let ${N}=${esc(w)}\\(${N},${N}\\.deposit\\);`);
// The host: the answer's first value; the asked chain's pool; that scope's record read back; no origin: its address.
const HOST_SRC = (h) =>
  `function ${esc(h)}\\(${N}\\)\\{return\\(${N},(${N})\\)=>\\{let (${N})=\\{error:${Q}(\\w+)${Q}\\}(?:,${N}=${N}\\.stop\\?\\.\\(\\),${N}=\\(\\)=>${N}\\?\\.aborted===!0)?;return\\{after:\\(async\\(\\)=>\\{let (${N})=${N}\\.chain,(${N})=${N}\\.pools\\(\\)\\.find\\(${N}=>${N}\\.chain===\\4\\);if\\(\\5===void 0\\)return;` +
  `let ${N}=${N}\\[\\4\\],(${N})=${N}\\.origin_asset!==void 0\\|\\|${N}\\.amount!==void 0;(?:if\\(await ${N}\\.named\\?\\.\\(\\)\\.catch\\(\\(\\)=>\\{\\}\\),${N}\\(\\)\\)return void\\(\\2=\\{error:${Q}not_allowed${Q}\\}\\)|await ${N}\\.named\\?\\.\\(\\)\\.catch\\(\\(\\)=>\\{\\}\\));let (${N})=(${N})\\(await ${N}\\.read\\(\\5\\.scope\\),\\4,\\5\\.scope\\);(?:if\\(${N}\\(\\)\\)return void\\(\\2=\\{error:${Q}not_allowed${Q}\\}\\);)?if\\(!\\7\\)return;` +
  `if\\(!\\6\\)return void\\(\\2=\\{result:\\{chain:\\4,address:\\7\\.wallet,asset:${N}\\}\\}\\);`;
const HOST = (h) => new RegExp(HOST_SRC(h));
// ...and then, with no follow (`checked`), no floor read passed or off mainnet, it returns before any quote is asked, a
// plain send too (card deposit-takes-each-pools-own-coin review P3-c); after it, the origin's plain-send test: the
// origin equal to the chain's own entry of the destination table (POOL_DEPOSIT_DESTINATION, PLAIN_TABLE below), nothing
// wider.
const GATE = (h) => new RegExp(`${HOST_SRC(h)}if\\(\\1===void 0\\|\\|(${N})\\.checked===void 0\\|\\|\\9\\.floor===void 0\\|\\|\\9\\.network!==${Q}mainnet${Q}\\)return;let (${N})=${N}\\.origin_asset;if\\(typeof \\10!=${Q}string${Q}\\)return;let (${N})=(${N})\\(\\4,\\10\\)[,;]`);
const PLAIN_FN = (f) => new RegExp(`${esc(f)}=\\((${N}),(${N})\\)=>Object\\.hasOwn\\((${N}),\\1\\)&&\\2===\\3\\[\\1\\]`);
const PLAIN_TABLE = (t) => new RegExp(`${esc(t)}=Object\\.freeze\\(\\{solana:${Q}nep141:sol\\.omft\\.near${Q},base:${Q}nep141:base\\.omft\\.near${Q},robinhood:${Q}nep141:hood\\.omft\\.near${Q}\\}\\)`);
/** The gate's plain-send test is the destination table's own entry for the chain (card deposit-takes-each-pools-own-coin). */
function plainGated(js, h) {
  const g = GATE(h).exec(js);
  if (!g) return false;
  const t = PLAIN_FN(g[12]).exec(js)?.[3];
  return !!t && PLAIN_TABLE(t).test(js);
}
// (card move-one-confidential-swap: the confidential pair, between the follow's quoted and the stop, is required)
const PAIR = `confidential:!0,hidden:\\((${N}),(${N})\\)=>${N}\\(\\5,fetch,\\6\\),`;
const WIRED = (h) => new RegExp(`"pool\\.address":${esc(h)}\\(\\{pools:${N},network:${N},read:${N}\\.depositRead,named:\\(\\)=>${N}\\.named\\(\\),priced:${N},floor:${N},checked:\\((${N}),(${N}),(${N}),(${N})\\)=>${N}\\.quoted\\(\\1,\\2,\\3,\\4\\),${PAIR}stop:${N}\\}\\)`);
// card move-one-confidential-swap: inside the host, after the quote's check, the tell on the stop, the stop checked after
// it, an address only on "hidden"
const TELL = (out, stop, deps, stopped) =>
  new RegExp(
    `if\\(${deps}\\.confidential===!0\\)\\{let (${N})=${deps}\\.hidden===void 0\\?${Q}down${Q}:await ${deps}\\.hidden\\(${N}\\.depositAddress,${stop}\\)\\.catch\\(\\(\\)=>${Q}down${Q}\\);` +
      `if\\(${stopped}\\(\\)\\)return void\\(${out}=\\{error:${Q}not_allowed${Q}\\}\\);if\\(\\1!==${Q}hidden${Q}\\)return void\\(${out}=\\{error:\\1===${Q}public${Q}\\?${Q}quote_check_failed${Q}:${Q}down${Q}\\}\\)\\}`,
  );
function confidential(js, h) {
  if (!WIRED(h).test(js)) return false;
  const m = STOP_HEAD(h).exec(js);
  if (!m) return false;
  const end = js.indexOf("function ", m.index + m[0].length);
  const body = js.slice(m.index, end < 0 ? undefined : end);
  return (body.match(new RegExp(TELL(...m.slice(1).map(esc)).source, "g")) ?? []).length === 1;
}
// pool-deposit-quote.ts: the kit's check with no vault floor, then the quote's own floor (card pool-deposit-follow: the
// least rung plus the deposit's cost, which that card's live check holds).
// card helper-says-why-a-vendor-refused: the stop read once (the answer, the stop, the deps, the check), then each wait
const STOP_HEAD = (h) =>
  new RegExp(`function ${esc(h)}\\(${N}\\)\\{return\\(${N},${N}\\)=>\\{let (${N})=\\{error:${Q}not_allowed${Q}\\},(${N})=(${N})\\.stop\\?\\.\\(\\),(${N})=\\(\\)=>\\2\\?\\.aborted===!0;return\\{after:`);
function stopsEachWait(js, h) {
  const m = STOP_HEAD(h).exec(js);
  if (!m) return false;
  const [out, stop, deps, stopped] = m.slice(1).map(esc);
  const end = js.indexOf("function ", m.index + m[0].length);
  const body = js.slice(m.index, end < 0 ? undefined : end);
  const stoppedAnswer = `if\\(${stopped}\\(\\)\\)return void\\(${out}=\\{error:${Q}not_allowed${Q}\\}\\);`;
  return (
    new RegExp(`if\\(await ${deps}\\.named\\?\\.\\(\\)\\.catch\\(\\(\\)=>\\{\\}\\),${stopped}\\(\\)\\)return void\\(${out}=\\{error:${Q}not_allowed${Q}\\}\\);`).test(body) &&
    // the records read before, and again before the answer: on a 1Click quote and on a plain send (card
    // deposit-takes-each-pools-own-coin), each checked against the stop
    (body.match(new RegExp(`=${N}\\(await ${deps}\\.read\\(${N}\\.scope\\),${N},${N}\\.scope\\);${stoppedAnswer}`, "g")) ?? []).length === 3 &&
    new RegExp(`=await ${deps}\\.floor\\(${N},${N}\\.wallet,${stop}\\)\\}catch\\{${out}=\\{error:${Q}down${Q}\\};return\\}${stoppedAnswer}`).test(body) &&
    new RegExp(`=await ${N}\\(${N},${deps}\\.fetch,void 0,void 0,${stop}\\)\\}`).test(body) &&
    // the follow's write, then the stop, then the answer: on a 1Click quote and on a plain send
    (body.match(new RegExp(`if\\(await ${deps}\\.checked\\([^;]*?\\),${stopped}\\(\\)\\)return void\\(${out}=\\{error:${Q}not_allowed${Q}\\}\\);(?:return void\\()?${out}=\\{result:`, "g")) ?? []).length === 2 &&
    floorStopped(js, h)
  );
}
// delta review P3-5: the page's floor (main.ts floorFor) hands the stop to the Solana floor (readSolanaPoolFloor), which
// hands it to its reads (readSolanaPoolCosts): checked before they start, before each blockhash read, before each fee
// read (whose message names U_X)
function floorStopped(js, h) {
  const floor = new RegExp(`"pool\\.address":${esc(h)}\\(\\{[^}]*?,floor:(${N}),`).exec(js)?.[1];
  const sol = floor && new RegExp(`${esc(floor)}=async\\((${N}),${N},(${N})\\)=>\\{if\\(\\1!==${Q}solana${Q}\\)return ${N}\\.floor\\(\\1\\);let ${N}=${N}\\(\\);return ${N}!==null&&${N}!==void 0\\?(${N})\\(${N},${N}\\.program,${N},\\2\\):null\\}`).exec(js)?.[3];
  const costs = sol && new RegExp(`async function ${esc(sol)}\\(${N},${N},${N},(${N})\\)\\{let\\{fee:${N},rent:${N}\\}=await (${N})\\(${N},${N},${N},\\1\\);`).exec(js)?.[2];
  return !!costs && new RegExp(`async function ${esc(costs)}\\(${N},${N},${N},(${N})\\)\\{\\1\\?\\.throwIfAborted\\(\\);let ${N}=await ${N}\\(${N}\\),${N}=await Promise\\.all\\(${N}\\.map\\(async ${N}=>\\{\\1\\?\\.throwIfAborted\\(\\);[^]{0,400}?\\1\\?\\.throwIfAborted\\(\\);let ${N}=\\(await ${N}\\(${Q}getFeeForMessage${Q}`).test(js);
}
const FLOOR = new RegExp(`let (${N})=${N}\\(${N},${N},\\{\\.\\.\\.${N}\\.check,intoVault:!1\\}\\);return \\1\\.minAmountOut<(${N})\\.floor&&${N}\\(${Q}floor${Q}\\)`);
// ...with the context floor refused under the pool's least rung per chain.
const CTX_FLOOR = new RegExp(`\\(typeof (${N})\\.floor!=${Q}bigint${Q}\\|\\|\\1\\.floor<(${N})\\[\\1\\.chain\\]\\)&&${N}\\(${Q}floor${Q}\\)`);
const FLOOR_TABLE = (t) => new RegExp(`${esc(t)}=Object\\.freeze\\(\\{solana:(${N})\\.min,base:(${N})\\.min,robinhood:\\2\\.min\\}\\)`);
const LADDER = (n, one, min) => new RegExp(`${esc(n)}=Object\\.freeze\\(\\{one:${one}n,min:${min}n\\}\\)`);
const NAMER = (p) => new RegExp(`=${N}\\(\\{top:!${N},scope:${N},pools:${esc(p)},`);

/** The facts the verdict reads, from SIGN_HOST's index.html and /app.js. */
export function facts(index, js) {
  const pools = POOLS_FN.exec(js)?.[1];
  const wallet = WALLET_FN.exec(js)?.[1];
  const read = wallet ? READ_FN(wallet).exec(js)?.[1] : undefined;
  const host = new RegExp(`"pool\\.address":(${N})\\(\\{pools:${N},`).exec(js)?.[1];
  const table = FLOOR.test(js) ? CTX_FLOOR.exec(js)?.[2] : undefined;
  const ladders = table ? FLOOR_TABLE(table).exec(js) : null;
  return {
    index,
    sha384: sha384(js),
    namerPools: !!pools && NAMER(pools).test(js),
    namesEach: SCOPES.test(js) && EACH.test(js),
    namesRecord: PLAN.test(js) && EVM_NAME.test(js),
    sameChain: !!read && HOST(host ?? "").exec(js)?.[8] === read,
    unfollowed: !!host && WIRED(host).test(js) && GATE(host).exec(js)?.[3] === "not_allowed" && plainGated(js, host),
    stopped: !!host && stopsEachWait(js, host),
    confidential: !!host && confidential(js, host),
    floored: !!ladders && LADDER(ladders[1], "1000000", "10000000").test(js) && LADDER(ladders[2], "100000000000000", "1000000000000000").test(js),
  };
}

export const WHY = {
  namerPools: "the page's namer is not handed the pinned pools (less NEAR) with their scopes: no pool's U_X is named ahead",
  namesEach: "the namer does not name each pool's scope with its chain (an EVM pool as Base or Robinhood), or one scope that fails stops the rest",
  namesRecord: "a pool's record is not written from its scope's planned index and one-time id, or an EVM pool's carries no EVM address (or its key is not zeroed), or a record is kept other than a pool's own on a lower index while its U_X still holds money",
  sameChain: "pool.address does not answer the asked chain's own pool from that scope's record read back (Solana: the one-time id's key; EVM: the record's address)",
  unfollowed: "a cross-chain quote with no follow wired, or on a page not pinned on mainnet (a plain send of the pool's own coin too), is not refused not_allowed before any quote is asked, or pool.address is not wired with its pools, network, read, wait, price, floor read, the follow's quoted, the confidential mode with its keyless tell and the page's stop",
  stopped: "pool.address does not read the page's stop once as a request arrives, check it after each wait (the namer's, both record reads, the floor read, the follow's write) and hand it to the floor read and the quote's ask, or the floor read does not hand it on to its RPC reads: a sign out during one may still send a quote or a read",
  confidential:
    "pool.address is not wired confidential with the keyless tell, or does not wait for the tell on the page's stop, check the stop after it and answer an address only on hidden: a Move or a deposit may be a public swap",
  floored: "a pool quote whose min out is under its floor, or whose floor is under the pool's smallest deposit (0.01 SOL; 0.001 ETH on Base and Robinhood), is not refused floor",
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
