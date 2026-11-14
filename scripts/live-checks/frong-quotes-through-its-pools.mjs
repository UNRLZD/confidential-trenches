#!/usr/bin/env node
// Live check frong-quotes-through-its-pools: FRONG on Robinhood (0x6245e67a…) is quoted, buy and sell, through a pool
// that fills. Every FRONG tap had refused too_many_pools (robinhood-quotes-inside-provider-limits' runs, 2026-11-13
// 23:1xZ to 23:5xZ, 12 taps): while its held pools with USDG could not give the route's amount from any of USDG's
// markets, the buy quote left those markets unquoted, took USDG for a currency with no market, read its pools with
// other currencies one level further, and USDG pairs with more than EVM_QUOTE_MAX_OTHER (card
// frong-quotes-through-its-pools, packages/kit/src/checks/evm/quote.ts quoteMarkets). It reads, after every sign deploy:
//   - buy: the device's own Robinhood pool index synced cold on its two readers, then FRONG quoted by the tap's own
//     quote (the kit's evmPoolBuyQuoteTap) at QUOTE_AMOUNT once cold and WARM_RUNS times warm;
//   - sell: SELL_AMOUNT of FRONG sold by evmPoolSellQuote, once cold and once warm, as the first of HOLDERS whose FRONG
//     balance both of two Robinhood providers read at SELL_AMOUNT or more (W in the quote's own reads; read only, the
//     sale's probe is an eth_call), from WETH's 1% v3 pool's route as bought.
// It passes when every buy tap and every sell ends in a quote. Nothing is signed or sent. The kit asks the providers
// for the quotes; the holders' balances are read here through provider-answer.mjs. No holder with SELL_AMOUNT on both
// providers, or a provider with no answer: INCONCLUSIVE (exit 3), never a pass.
// After: sign
// Bundle: out the quotes are the kit's own on real Robinhood mainnet providers, which a build cannot hold
//   node scripts/live-checks/frong-quotes-through-its-pools.mjs [--record <file>]
//   node scripts/live-checks/frong-quotes-through-its-pools.mjs --answer <file>     judge a recorded run
//   PASS exit 0, FAIL 1, error 2, INCONCLUSIVE 3.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evmPoolBuyQuote, evmPoolBuyQuoteTap, evmPoolIndexRefresh, evmPoolSellQuote } from "../../packages/kit/src/index.ts";
import { evmPoolVenues } from "../../packages/kit/src/trade/evm/buy-unpinned.ts";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

export const KEY = "frong-quotes-through-its-pools";
export const FRONG = "0x6245e67affa44a23077f0ea7f981a8dc743a0c47";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const QUOTE_AMOUNT = 980_000_000_000_000n; // evm-buy-and-sell-on-mainnet.mjs QUOTE_AMOUNT
export const WARM_RUNS = 3;
// 1,000 FRONG: about 0.001 ETH (100 FRONG was below the pool's least deposit, 2026-11-14 02:2xZ)
export const SELL_AMOUNT = 1_000n * 10n ** 18n;
// FRONG holders read 2026-11-14 02:2xZ (Transfer logs of the last 200,000 blocks, then balanceOf): 290,558 and 394,744
export const HOLDERS = ["0x54428883e2a817170e4956459c87b1be96624bf5", "0x786275619e55cd38af81ead6232212420c36fe58"];

const big = (_, v) => (typeof v === "bigint" ? v.toString() : v);
const ended = (f) => f().then((q) => ({ ok: true, route: JSON.parse(JSON.stringify(q.route, big)) }), (e) => ({ ok: false, code: String(e?.code ?? e?.name ?? "thrown"), message: String(e?.message ?? e).slice(0, 300) }));

/** The holder the sale is quoted as: the first of HOLDERS that two providers both read at SELL_AMOUNT or more. */
async function holderOf(fetchFn) {
  const urls = evmPoolVenues().robinhood.providers.filter((u) => !evmPoolVenues().robinhood.quoteLast?.includes(u)).slice(0, 2);
  const lines = [];
  for (const w of HOLDERS) {
    const as = await Promise.all(urls.map((u) => rpcAnswer(u, "eth_call", [{ to: FRONG, data: "0x70a08231" + w.slice(2).padStart(64, "0") }, "latest"], { fetchFn })));
    const bad = as.find((a) => a.noAnswer !== undefined || a.error !== undefined || typeof a.result !== "string");
    if (bad !== undefined) {
      lines.push(`${w}: ${bad.noAnswer ?? JSON.stringify(bad.error ?? bad.result)}`);
      continue;
    }
    const bals = as.map((a) => BigInt(a.result));
    lines.push(`${w}: ${bals.join(" and ")}`);
    if (bals.every((b) => b >= SELL_AMOUNT)) return { w, lines };
  }
  return { w: null, lines };
}

export async function read(fetchFn = fetch) {
  const readAt = new Date().toISOString();
  const t0 = performance.now();
  const sync = await evmPoolIndexRefresh("robinhood", null, fetchFn);
  const index = { served: sync.served, ms: Math.round(performance.now() - t0) };
  const buys = [];
  for (const kind of ["cold", ...Array(WARM_RUNS).fill("warm")]) {
    const t = performance.now();
    const end = await ended(() => evmPoolBuyQuoteTap({ chain: "robinhood", token: FRONG, amountIn: QUOTE_AMOUNT, slippageBps: 300 }, { quote: (r) => evmPoolBuyQuote(r) }));
    buys.push({ kind, ms: Math.round(performance.now() - t), ...end });
  }
  const { w, lines } = await holderOf(fetchFn);
  const sells = [];
  if (w !== null) {
    const head = await rpcAnswer(evmPoolVenues().robinhood.providers[0], "eth_blockNumber", [], { fetchFn });
    const boughtBlock = typeof head.result === "string" ? BigInt(head.result) - 5n : null;
    for (const kind of ["cold", "warm"]) {
      if (boughtBlock === null) break;
      const t = performance.now();
      const end = await ended(() => evmPoolSellQuote({ chain: "robinhood", token: FRONG, w, amountIn: SELL_AMOUNT, slippageBps: 300, bought: { venue: "uniswap-v3", tokens: [WETH, FRONG], fees: [10000] }, boughtBlock, sent: [] }));
      sells.push({ kind, ms: Math.round(performance.now() - t), ...end });
    }
  }
  return { readAt, index, buys, holder: { w, lines }, sells };
}

/** The verdict on one run: PASS when every buy tap and every sell ends in a quote. */
export function judge(run) {
  const lines = [];
  const say = (ok, line) => lines.push(`${ok ? "ok " : "BAD"} ${line}`);
  const of = (us) => us.map((u) => (u.ok ? `ok/${u.ms}` : `${u.code}/${u.ms}`)).join(", ");
  say(run.index?.served === true, `the pool index synced and served in ${run.index?.ms} ms`);
  say(run.buys.length === 1 + WARM_RUNS && run.buys.every((u) => u.ok), `FRONG's ${run.buys.length} buy taps each end in a quote: ${of(run.buys)}`);
  for (const u of run.buys.filter((x) => !x.ok)) say(false, `buy ${u.kind}: ${u.message}`);
  if (run.holder.w === null) {
    lines.push(`--  no holder read at ${SELL_AMOUNT} FRONG on two providers: ${run.holder.lines.join("; ")}: INCONCLUSIVE`);
    return { verdict: lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "INCONCLUSIVE", lines };
  }
  say(run.sells.length === 2 && run.sells.every((u) => u.ok), `FRONG's sells as ${run.holder.w} each end in a quote: ${of(run.sells)}`);
  for (const u of run.sells.filter((x) => !x.ok)) say(false, `sell ${u.kind}: ${u.message}`);
  return { verdict: lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS", lines };
}

const CODE = { PASS: EXIT.PASS, FAIL: EXIT.FAIL, INCONCLUSIVE: EXIT.INCONCLUSIVE };

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = a.includes("--answer") ? JSON.parse(readFileSync(a[a.indexOf("--answer") + 1], "utf8")) : await read();
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify(run, null, 1)}\n`);
    const v = judge(run);
    for (const l of v.lines) console.log(l);
    console.log(`${KEY}: ${v.verdict}`);
    process.exit(CODE[v.verdict]);
  } catch (e) {
    console.log(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
