#!/usr/bin/env node
// Live check evm-buy-and-sell-on-mainnet: SIGN_HOST (https://confidential.unrealized.trade) buys and sells from
// the Base and Robinhood pools, and each trade has its way back into the pool. It passes only when SIGN_HOST's served
// /app.js is the one its index.html pins (its sha384), and in it:
//   - rule (src/pool-testnet.ts POOL_WITHDRAW_BUILT, poolWayOut; evm-deposit-on-mainnet.mjs pageFacts): the build
//     carries Solana's, Base's and Robinhood's withdraw, and its one rule reads that table, the only gate of the EVM
//     buy, its follow, the carry, the sale and its follow;
//   - withdraw: every mark of the EVM withdraw (evm-withdraw-mainnet.mjs WITHDRAW_MARKS);
//   - buy: the EVM pool buy's signature (src/evm-send.ts EVM_BUY_SIGNATURE) and its route search ("uniswap-v4");
//   - carry: the carry of a refused buy's ETH on W back into the pool (src/pool-carry-evm.ts: its open record
//     "owed/carry-evm-open" and its done Ws "owed/carry-evm"), so a buy that misses its floor leaves nothing on W;
//   - sell: the Sell typed data W signs (packages/kit/src/trade/evm/sell-unpinned.ts) and the sale's open record
//     (src/pool-sell-evm.ts EVM_OPEN_SELLS_KEY, followed until its return lands in the pool);
//   - pins: both mainnet pools (evm-pools-on-mainnet.mjs PINS), and no testnet pool.
// What each part does is held by the signing page's tests (test/pool-carry-evm.test.ts, test/pool-evm-trade-open.test.ts,
// test/pool-mainnet-evm.test.ts, scripts/build-network.test.mjs). scripts/ci/bundle-checks.mjs runs read and judge on
// a pull request's own build.
// After: sign
//   node scripts/live-checks/evm-buy-and-sell-on-mainnet.mjs [--local] [--record <file>]
//   PASS exit 0, FAIL 1, error 2. --local judges this tree's SIGN_HOST build (signBuilt) in SIGN_HOST's place;
//   --record writes what the run read, which evm-buy-and-sell-on-mainnet.test.mjs replays.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";
import { pageFacts as depositFacts } from "./evm-deposit-on-mainnet.mjs";
import { PINS } from "./evm-pools-on-mainnet.mjs";
import { WITHDRAW_MARKS } from "./evm-withdraw-mainnet.mjs";
import { EXIT } from "./provider-answer.mjs";

export const KEY = "evm-buy-and-sell-on-mainnet";
export const SIGN = "https://confidential.unrealized.trade";
/** Each part's marks in the bundle, as the sources write them. */
export const MARKS = Object.freeze({
  buy: Object.freeze(["buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)", "uniswap-v4"]),
  carry: Object.freeze(["owed/carry-evm-open", "owed/carry-evm"]),
  sell: Object.freeze([
    "Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)",
    "owed/sell-evm",
  ]),
});
/** The testnet pools (the kit's evmTestnetVenues): none in SIGN_HOST's build. */
export const TESTNET_POOLS = Object.freeze(["0xeb967dfc1b4ffb22942f833c76866ea85fc42266", "0xed9fac860e6bc5e932455232eedca8b71c44da4d"]);

/** What the check keeps of SIGN_HOST's build: its pin and sha384, the rule, and each part's marks found. */
export function pageFacts(index, js) {
  const d = depositFacts(index, js);
  const found = (ms) => ms.filter((m) => js.includes(m));
  return {
    pin: d.pin,
    sha384: d.sha384,
    rule: d.rule,
    withdraw: WITHDRAW_MARKS.filter((m) => js.includes(m)).length,
    buy: found(MARKS.buy),
    carry: found(MARKS.carry),
    sell: found(MARKS.sell),
    pools: Object.values(PINS).map((p) => p.pool).filter((p) => js.includes(p)),
    testnet: found(TESTNET_POOLS),
  };
}

/** The verdict on one run { page }: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = run?.page;
  const all = (k) => Array.isArray(p?.[k]) && MARKS[k].every((m) => p[k].includes(m));
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(p?.rule === true, "[SIGN_HOST] the build carries Solana's, Base's and Robinhood's withdraw, and its one rule reads that table");
  say(p?.withdraw === WITHDRAW_MARKS.length, `[SIGN_HOST] the build carries the EVM withdraw: ${p?.withdraw ?? "not read"}/${WITHDRAW_MARKS.length} marks`);
  say(all("buy"), `[SIGN_HOST] the build carries the EVM pool buy: ${p?.buy?.length ?? "not read"}/${MARKS.buy.length} marks`);
  say(all("carry"), `[SIGN_HOST] a refused buy's ETH on W has its way back into the pool (the carry): ${p?.carry?.length ?? "not read"}/${MARKS.carry.length} marks`);
  say(all("sell"), `[SIGN_HOST] the build carries the EVM pool sale and its open record: ${p?.sell?.length ?? "not read"}/${MARKS.sell.length} marks`);
  const pools = Object.values(PINS).map((x) => x.pool);
  say(Array.isArray(p?.pools) && pools.every((x) => p.pools.includes(x)), `[SIGN_HOST] the build pins both mainnet pools: ${p?.pools?.join(", ") || "none"}`);
  say(Array.isArray(p?.testnet) && p.testnet.length === 0, `[SIGN_HOST] the build names no testnet pool: ${p?.testnet?.join(", ") || "none"}`);
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** SIGN_HOST's index and /app.js (or this tree's build). */
export async function read(fetchFn = fetch, local = false) {
  let index;
  let js;
  if (local) {
    index = readFileSync(path.join(signBuilt(), "index.html"), "utf8");
    js = readFileSync(path.join(signBuilt(), "public/app.js"), "utf8");
  } else {
    const get = async (p) => {
      const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
      if (r.status !== 200) throw new Error(`SIGN_HOST ${p}: HTTP ${r.status}`);
      return r.text();
    };
    index = await get("/");
    js = await get("/app.js");
  }
  return { readAt: new Date().toISOString(), from: local ? "local build" : SIGN, page: pageFacts(index, js) };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = await read(fetch, a.includes("--local"));
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
