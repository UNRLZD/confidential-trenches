#!/usr/bin/env node
// Live check of card pool-deposit-address on SIGN_HOST (https://sign.confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - naming ahead (deposit-name.ts): the page's namer is handed the page's pinned pools less NEAR, each with its scope
//     (main.ts pagePoolScopes), names the vault's scope and each pool's, each in its own try (one scope that fails names
//     the rest), an EVM pool's as Base or Robinhood (not Solana), and writes each pool's record with the scope's planned
//     index, its one-time id and, on an EVM pool, its EVM address (the key zeroed first);
//   - pool.address (pool-deposit-address.ts): wired on the page with the pools, the deposit record read and the namer's
//     wait, and nothing more; it answers the asked chain's own pool, from that pool scope's record read back (the seed
//     backed up), the address on Solana the one-time id's own key and on an EVM pool the record's EVM address;
//   - a cross-chain quote (an origin asset or an amount) with no follow wired, or on a page whose pools are not pinned on
//     mainnet (the only network 1Click pays out on), is refused: the answer starts not_allowed and the host returns
//     before any quote is asked when the page passes no `checked` or its network is not mainnet; the page passes its own
//     network (review F2);
//   - a pool quote whose min out is under the pool's smallest deposit is refused "floor" after the kit's check, at the
//     ladders' least rungs: 0.01 SOL, 0.001 ETH on Base and Robinhood (review F3).
// What each does is held by the card's tests (packages/signpage/test/deposit-name.test.ts and
// pool-deposit-address.test.ts); the recorded answers are facts() over each tree's packages/signpage/index.html and
// public/app.js (this file reaches no package code: the import check holds it).
//   node scripts/live-checks/pool-deposit-address.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-deposit-address";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");
const Q = "`";

// main.ts pagePoolScopes: the pinned pools less NEAR, each with its scope.
const POOLS_FN = new RegExp(`function (${N})\\(\\)\\{return ${N}\\.flatMap\\(${N}=>${N}\\.chain===${Q}near${Q}\\?\\[\\]:\\[\\{chain:${N}\\.chain,scope:${N}\\.scope\\}\\]\\)\\}`);
// deposit-name.ts nameNow: the vault's scope, then each pool's (EVM unless Solana), each named in its own try.
const SCOPES = new RegExp(`\\.\\.\\.\\(${N}\\.pools\\?\\.\\(\\)\\?\\?\\[\\]\\)\\.map\\(${N}=>\\(\\{scope:${N}\\.scope,evm:${N}\\.chain!==${Q}solana${Q}\\}\\)\\)`);
const EACH = new RegExp(`for\\(let\\{scope:${N},evm:${N}\\}of ${N}\\)try\\{await ${N}\\(${N},${N},${N},${N},${N}\\)\\}catch\\{\\}`);
// deposit-name.ts nameScope: the planned index of the scope, the id, the EVM address (key zeroed), then the record.
const PLAN = new RegExp(`\\.planDeposit\\((${N}),${N}=>${N}\\(${N},${N}\\)\\.precommitment\\);if\\(${N}\\.ref\\.kind!==${Q}deposit${Q}\\|\\|${N}\\.scope!==\\1\\)throw`);
const EVM_NAME = new RegExp(
  `if\\((${N})\\)\\{let (${N})=${N}\\(${N},${N},${N}\\);\\2\\.secretKey\\.fill\\(0\\),(${N})=\\2\\.address\\}await ${N}\\.nameDeposit\\(\\{entropy:${N}\\},\\{scope:${N},index:${N},id:${N}\\.id,\\.\\.\\.\\3===void 0\\?\\{\\}:\\{evm:\\3\\}\\}\\)`,
);
// pool-deposit-address.ts walletOf and the record read.
const WALLET_FN = new RegExp(`function (${N})\\(${N},${N}\\)\\{return ${N}===${Q}solana${Q}\\?${N}\\.evm===void 0\\?${N}\\.encode\\(${N}\\.decode\\(${N}\\.id\\)\\):null:${N}\\.evm\\?\\?null\\}`);
const READ_FN = (w) =>
  new RegExp(`function (${N})\\(${N},${N},${N}\\)\\{if\\(!${N}\\|\\|!${N}\\.status\\|\\|!${N}\\.deposit\\|\\|${N}\\(${N}\\.status\\)\\|\\|${N}\\.deposit\\.scope!==${N}\\.toString\\(\\)\\)return null;let ${N}=${esc(w)}\\(${N},${N}\\.deposit\\);`);
// The host: the answer's first value; the asked chain's pool; that scope's record read back; no origin: its address.
const HOST_SRC = (h) =>
  `function ${esc(h)}\\(${N}\\)\\{return\\(${N},(${N})\\)=>\\{let (${N})=\\{error:${Q}(\\w+)${Q}\\};return\\{after:\\(async\\(\\)=>\\{let (${N})=${N}\\.chain,(${N})=${N}\\.pools\\(\\)\\.find\\(${N}=>${N}\\.chain===\\4\\);if\\(\\5===void 0\\)return;` +
  `let ${N}=${N}\\[\\4\\],(${N})=${N}\\.origin_asset!==void 0\\|\\|${N}\\.amount!==void 0;await ${N}\\.named\\?\\.\\(\\)\\.catch\\(\\(\\)=>\\{\\}\\);let (${N})=(${N})\\(await ${N}\\.read\\(\\5\\.scope\\),\\4,\\5\\.scope\\);if\\(!\\7\\)return;` +
  `if\\(!\\6\\)return void\\(\\2=\\{result:\\{chain:\\4,address:\\7\\.wallet,asset:${N}\\}\\}\\);`;
const HOST = (h) => new RegExp(HOST_SRC(h));
// ...and then, with no follow (`checked`) passed, it returns before any quote is asked.
const GATE = (h) => new RegExp(`${HOST_SRC(h)}if\\(\\1===void 0\\|\\|(${N})\\.checked===void 0\\|\\|\\9\\.network!==${Q}mainnet${Q}\\)return;`);
const WIRED = (h) => new RegExp(`"pool\\.address":${esc(h)}\\(\\{pools:${N},network:${N},read:${N}\\.depositRead,named:\\(\\)=>${N}\\.named\\(\\)\\}\\)`);
// pool-deposit-quote.ts: the kit's check with no vault floor, then the pool's own floor per chain, at the ladders' least rungs.
const FLOOR = new RegExp(`let (${N})=${N}\\(${N},${N},\\{\\.\\.\\.${N}\\.check,intoVault:!1\\}\\);return \\1\\.minAmountOut<(${N})\\[${N}\\.chain\\]&&${N}\\(${Q}floor${Q}\\)`);
const FLOOR_TABLE = (t) => new RegExp(`${esc(t)}=Object\\.freeze\\(\\{solana:(${N})\\.min,base:(${N})\\.min,robinhood:\\2\\.min\\}\\)`);
const LADDER = (n, one, min) => new RegExp(`${esc(n)}=Object\\.freeze\\(\\{one:${one}n,min:${min}n\\}\\)`);
const NAMER = (p) => new RegExp(`=${N}\\(\\{top:!${N},scope:${N},pools:${esc(p)},`);

/** The facts the verdict reads, from SIGN_HOST's index.html and /app.js. */
export function facts(index, js) {
  const pools = POOLS_FN.exec(js)?.[1];
  const wallet = WALLET_FN.exec(js)?.[1];
  const read = wallet ? READ_FN(wallet).exec(js)?.[1] : undefined;
  const host = new RegExp(`"pool\\.address":(${N})\\(\\{pools:${N},`).exec(js)?.[1];
  const table = FLOOR.exec(js)?.[2];
  const ladders = table ? FLOOR_TABLE(table).exec(js) : null;
  return {
    index,
    sha384: sha384(js),
    namerPools: !!pools && NAMER(pools).test(js),
    namesEach: SCOPES.test(js) && EACH.test(js),
    namesRecord: PLAN.test(js) && EVM_NAME.test(js),
    sameChain: !!read && HOST(host ?? "").exec(js)?.[8] === read,
    unfollowed: !!host && WIRED(host).test(js) && GATE(host).exec(js)?.[3] === "not_allowed",
    floored: !!ladders && LADDER(ladders[1], "1000000", "10000000").test(js) && LADDER(ladders[2], "100000000000000", "1000000000000000").test(js),
  };
}

export const WHY = {
  namerPools: "the page's namer is not handed the pinned pools (less NEAR) with their scopes: no pool's U_X is named ahead",
  namesEach: "the namer does not name each pool's scope (an EVM pool as Base or Robinhood), or one scope that fails stops the rest",
  namesRecord: "a pool's record is not written from its scope's planned index and one-time id, or an EVM pool's carries no EVM address (or its key is not zeroed)",
  sameChain: "pool.address does not answer the asked chain's own pool from that scope's record read back (Solana: the one-time id's key; EVM: the record's address)",
  unfollowed: "a cross-chain quote with no follow wired, or on a page not pinned on mainnet, is not refused not_allowed before any quote is asked, or pool.address is wired with more than its pools, network, read and wait",
  floored: "a pool quote whose min out is under the pool's smallest deposit (0.01 SOL; 0.001 ETH on Base and Robinhood) is not refused floor",
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
