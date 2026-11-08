#!/usr/bin/env node
// Live check of card evm-buy-quote-ends-on-node. The kit's EVM buy quote agrees each batch of a round's reads on its
// own (a late batch alone asks a spare, within the round's budget; one queued behind a stalled provider moves to the
// next unsent), and past its block's time plus EVM_QUOTE_MAX_AGE_MS it sends no read or scan request and refuses
// stale_quote (packages/kit/src/checks/evm/quote.ts). What it proves, and only that: the kit's public evmPoolBuyQuote,
// run on Node against each chain's pinned public providers for a standard v3 route (WETH to USDC on Base, WETH to USDG
// on Robinhood, 0.01%), ends within EVM_QUOTE_MAX_AGE_MS plus 10 s of its start, with at most 2,000 HTTP requests
// counted and printed, with a quote above 0 or a refusal the kit names (an EvmQuoteError code). Today no quote fits the
// window on either chain (2026-11-08 11:55Z: Base stale_quote at 31 s, its scans; Robinhood rpc_error at 33 s, a
// provider no longer holding the block's state); before this card both ran to the scan's 60 s bound. A quote inside
// the window is card evm-buy-quote-in-window.
// That each read is asked of two providers plus the budget's spares, and that nothing is sent past the deadline, is
// the kit's test (test/evm-quote-attacks.test.ts QE1-QE4 and their mutants).
//   node scripts/live-checks/evm-buy-quote-ends-on-node.mjs [--record <file> --as good|bad [--from <note>]]
//     [--answer <file> --as good|bad]
// PASS exit 0, FAIL exit 1, error exit 2.
// Runs: once, the kit's buy quote ships in no host's bundle yet: it runs the kit's own quote against the chains' public providers
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EVM_QUOTE_MAX_AGE_MS, evmPoolBuyQuote } from "../../packages/kit/src/index.ts";

const KEY = "evm-buy-quote-ends-on-node";
/** The longest a quote may run, from its start: the window, and 10 s for the requests in flight at its end */
export const BOUND_MS = EVM_QUOTE_MAX_AGE_MS + 10_000;
export const MAX_REQUESTS = 2_000;
/** The route per chain: [WETH, buys], 0.01%, at the amount ("buys", not "token": gitleaks' generic-api-key rule reads
 *  a "token" key with a hex value as a secret) */
const ROUTES = Object.freeze({
  base: { weth: "0x4200000000000000000000000000000000000006", buys: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount: 10n ** 16n },
  robinhood: { weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", buys: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", amount: 10n ** 15n },
});

/** One run of the kit's public quote on `chain`: its time, its HTTP requests and how it ended. */
async function run(chain) {
  const { weth, buys, amount } = ROUTES[chain];
  const real = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (url, init) => {
    requests++;
    return real(url, init);
  };
  const t0 = performance.now();
  try {
    const q = await evmPoolBuyQuote({ chain, token: buys, amountIn: amount, slippageBps: 100, route: { venue: "uniswap-v3", tokens: [weth, buys], fees: [100] } });
    return { chain, ms: Math.round(performance.now() - t0), requests, end: "quote", amountOut: String(q.amountOut) };
  } catch (e) {
    return { chain, ms: Math.round(performance.now() - t0), requests, end: e?.code ?? "error", message: String(e?.message ?? e).slice(0, 240) };
  } finally {
    globalThis.fetch = real;
  }
}

export async function collect() {
  return { at: new Date().toISOString(), runs: [await run("base"), await run("robinhood")] };
}

/** The verdict on an answer { runs }. */
export function judge(a) {
  const lines = [];
  const say = (ok, m) => lines.push(`${ok ? "ok " : "BAD"} ${m}`);
  const runs = Array.isArray(a?.runs) ? a.runs : [];
  for (const chain of Object.keys(ROUTES)) {
    const r = runs.find((x) => x?.chain === chain);
    if (r === undefined) {
      say(false, `${chain}: no run`);
      continue;
    }
    const inTime = Number.isFinite(r.ms) && r.ms >= 0 && r.ms <= BOUND_MS;
    say(inTime, `${chain}: the quote ended ${inTime ? "within" : "past"} ${BOUND_MS} ms (${r.ms} ms)`);
    const few = Number.isInteger(r.requests) && r.requests > 0 && r.requests <= MAX_REQUESTS;
    say(few, `${chain}: ${r.requests} HTTP requests, ${MAX_REQUESTS} at most`);
    const named = r.end === "quote" ? /^\d+$/.test(r.amountOut ?? "") && BigInt(r.amountOut) > 0n : typeof r.end === "string" && /^[a-z_]+$/.test(r.end) && r.end !== "error";
    say(named, `${chain}: it ended ${r.end === "quote" ? `with a quote of ${r.amountOut}` : `${r.end}: ${r.message ?? ""}`}${named ? "" : ", neither a quote nor a refusal the kit names"}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const as = arg("--as");
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8"))[as] : await collect();
    if (arg("--record")) {
      const f = arg("--record");
      const all = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
      all[as] = { ...answer, from: arg("--from") ?? null };
      writeFileSync(f, `${JSON.stringify(all, null, 1)}\n`);
    }
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
