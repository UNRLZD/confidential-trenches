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
//   - quotes (read only, never signed or sent; skipped with --local, as on a pull request's build): each chain's pool
//     index synced cold on its two readers and served, then the helper's top QUOTE_ROWS list rows by liquidity, each
//     quoted by the tap's own quote (the kit's evmPoolBuyQuoteTap) once cold and WARM_RUNS times warm. Each tap ends
//     in a quote or a refusal whose name is true (NAMED), asks at most EVM_BUY_TAP_QUOTES kit quotes, gets no 429, and
//     each warm tap ends within WARM_MAX_MS. The index sync's limits are reported, never judged, until each
//     chain's index ships with the release.
// What each part does is held by the signing page's tests (test/pool-carry-evm.test.ts, test/pool-evm-trade-open.test.ts,
// test/pool-mainnet-evm.test.ts, scripts/build-network.test.mjs). scripts/ci/bundle-checks.mjs runs read and judge on
// a pull request's own build.
// After: sign
// Bundle: read sign
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
import { EVM_BUY_TAP_QUOTES, evmPoolBuyQuote, evmPoolBuyQuoteTap, evmPoolIndexRefresh } from "../../packages/kit/src/index.ts";
import { HELPER } from "./evm-deposit-on-mainnet.mjs";

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

/** The quotes part: rows read per chain, warm runs per row, the warm bound, the buy (0.00098 ETH) and its slippage. */
export const QUOTE_ROWS = 5;
export const WARM_RUNS = 3;
export const WARM_MAX_MS = 2_000;
export const QUOTE_AMOUNT = 980_000_000_000_000n;
/** A tap's refusal whose name is true and shown: the coin has no route a buy may take (not_allowed), more pools than a
 *  quote reads (too_many_pools, the kit's bound), or no standard or pinned pool the device can price it against
 *  (no_reference). Any other (no_quote, quote_check_failed, a provider's fault) fails. */
export const NAMED = Object.freeze(["not_allowed", "too_many_pools", "no_reference"]);

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

/** The quotes part's lines (see the header). */
function judgeQuotes(qs, say) {
  for (const chain of ["base", "robinhood"]) {
    const c = qs?.chains?.[chain];
    const ix = c?.index;
    say(ix?.served === true, `[${chain}] the pool index synced and served: ${ix ? `${ix.pools} pools to ${ix.covers} in ${ix.ms} ms, limited ${JSON.stringify(ix.limited)}` : "not read"}`);
    say(Array.isArray(c?.rows) && c.rows.length > 0, `[${chain}] the helper's list rows read: ${c?.rows?.length ?? 0}`);
    for (const r of c?.rows ?? []) {
      const runs = Array.isArray(r.runs) ? r.runs : [];
      const ends = runs.map((u) => (u.ok ? "ok" : u.code)).join(",");
      const s429 = runs.reduce((n, u) => n + Object.values(u.hosts ?? {}).reduce((m, h) => m + (h.s429 ?? 0), 0), 0);
      const most = Math.max(0, ...runs.map((u) => u.quotes ?? Infinity));
      // a refusal as much as a quote: the user waits on either
      const warm = runs.filter((u) => u.kind === "warm").map((u) => u.ms);
      const ms = runs.map((u) => `${u.kind} ${u.ms}`).join(", ");
      say(runs.length === 1 + WARM_RUNS && runs.every((u) => u.ok === true || NAMED.includes(u.code)), `[${chain}] ${r.symbol} ${r.coin} ends in a quote or a true named refusal: ${ends || "no run"}`);
      say(most <= EVM_BUY_TAP_QUOTES, `[${chain}] ${r.symbol} asks ${most} kit quotes a tap at most (bound ${EVM_BUY_TAP_QUOTES})`);
      say(s429 === 0, `[${chain}] ${r.symbol} taps got ${s429} answers of 429`);
      say(warm.every((x) => x <= WARM_MAX_MS), `[${chain}] ${r.symbol} warm taps end within ${WARM_MAX_MS} ms: ${ms}`);
    }
  }
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
  if (run?.quotes !== undefined) judgeQuotes(run.quotes, say);
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** The quotes part of a run (see the header), real mainnet reads only: { chains: { base, robinhood } }. `chains` the
 *  chains read, `coins` each chain's coins quoted beside the helper's top rows (card
 *  robinhood-quotes-inside-provider-limits: FRONG, the owner's). Each tap's hosts: its posts (requests), the JSON-RPC
 *  calls in them and the answers of 429. */
export async function readQuotes(fetchFn = fetch, { chains: which = ["base", "robinhood"], coins = {} } = {}) {
  const counts = {};
  const real = globalThis.fetch;
  const counted = async (url, init) => {
    const host = new URL(typeof url === "string" ? url : url.url).host;
    const c = (counts[host] ??= { requests: 0, calls: 0, s429: 0 });
    c.requests++;
    try {
      const b = JSON.parse(typeof init?.body === "string" ? init.body : "null");
      c.calls += Array.isArray(b) ? b.length : b === null ? 0 : 1;
    } catch {
      c.calls++;
    }
    const r = await fetchFn(url, init);
    if (r.status === 429) c.s429++;
    return r;
  };
  globalThis.fetch = counted;
  const take = () => {
    const out = structuredClone(counts);
    for (const k of Object.keys(counts)) delete counts[k];
    return out;
  };
  try {
    const chains = {};
    for (const chain of which) {
      take();
      const t = performance.now();
      const { sync, served } = await evmPoolIndexRefresh(chain, null, counted);
      const index = { ms: Math.round(performance.now() - t), served, covers: sync?.coversThrough ?? null, pools: sync?.pools?.length ?? null, error: sync?.error?.code ?? null, limited: sync?.stats?.limited ?? null, hosts: take() };
      const r = await fetchFn(`${HELPER}/v1/market/lists?chain=${chain}`, { redirect: "error" });
      if (r.status !== 200) throw new Error(`helper lists ${chain}: HTTP ${r.status}`);
      const lists = (await r.json())?.lists ?? {};
      const seen = new Map();
      for (const v of Object.values(lists)) for (const x of Array.isArray(v) ? v : []) if (typeof x?.token === "string" && !seen.has(x.token)) seen.set(x.token, x);
      const top = [...seen.values()].sort((a, b) => Number(b.liq_usd ?? 0) - Number(a.liq_usd ?? 0)).slice(0, QUOTE_ROWS);
      for (const [token, symbol] of Object.entries(coins[chain] ?? {})) if (!top.some((x) => x.token.toLowerCase() === token.toLowerCase())) top.push({ token, symbol, liq_usd: seen.get(token)?.liq_usd ?? null });
      const rows = [];
      for (const x of top) {
        const runs = [];
        for (const kind of ["cold", ...Array(WARM_RUNS).fill("warm")]) {
          let quotes = 0;
          take();
          const t0 = performance.now();
          let end;
          try {
            const q = await evmPoolBuyQuoteTap({ chain, token: x.token, amountIn: QUOTE_AMOUNT, slippageBps: 300 }, { quote: (req) => (quotes++, evmPoolBuyQuote(req)) });
            end = { ok: true, route: q.route };
          } catch (e) {
            end = { ok: false, code: e?.code ?? "thrown", message: String(e?.message ?? e).slice(0, 200) };
          }
          runs.push({ kind, ms: Math.round(performance.now() - t0), quotes, ...end, hosts: take() });
        }
        rows.push({ coin: x.token, symbol: String(x.symbol ?? "").slice(0, 32), liq_usd: x.liq_usd ?? null, runs });
      }
      chains[chain] = { index, rows };
    }
    return { readAt: new Date().toISOString(), chains };
  } finally {
    globalThis.fetch = real;
  }
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
    if (!a.includes("--local")) run.quotes = await readQuotes(fetch);
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
