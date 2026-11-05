#!/usr/bin/env node
// Live check of card evm-quote-lag-held: a warm pool quote ends ok when one provider of the agreeing pair lags. Through
// the kit's public entry (evmPoolBuyQuote, on the kit's own pinned providers, as the device runs it), for each case
// below one provider's latest block is answered LAG blocks back (its own head read, then that block asked by number in
// its place), from a cold quote on: the cold quote, then N warm quotes 1.5 s apart. It passes when
//   - each case has N warm quotes, every one ending as the case says (the review of b282ce0, MEDIUM-A: publicnode 100
//     back refused 9 of 10 Robinhood warm quotes rpc_disagree in about 0.5 s);
//   - the lagging provider was asked for its head in the cold quote, which asks the venue's providers in its order,
//     so the run put it in the pair (a run that never asked it proves nothing).
// The cold quote's outcome is shown, not judged: a cold Robinhood quote's later rounds can outlast the state some
// providers keep (an rpc_error naming "historical state", seen with no lag too, 2026-11-05 10:00Z), a matter apart.
//   node scripts/live-checks/evm-quote-lag-held.mjs [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2. --record writes the run (each quote's time, outcome and the lagger's head
// asks) to <file>, for the test's replay (evm-quote-lag-held.answers.json).
// Reads only: no key, no transaction, no money moves.
// Runs: pending evm-quote-lag-held, it fails on the kit at e031ad4 (the bad answer, 2 of 10 Base warm quotes ok); it joins the app's list, beside evm-quote-warm-round, when this card ships
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EvmQuoteError, evmPoolBuyQuote } from "../../packages/kit/src/index.ts";

export const N = 10;
const ZERO = "0x0000000000000000000000000000000000000000";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
// the tokens and hooks (packages/kit/test/evm-quote-record.ts)
// TORCH on Robinhood: its native v4 pool, fee 0.3%, tick spacing 60 (GeckoTerminal's trending list, apps/helper/src/data/
// evm/fixtures/gt-robinhood-trending-1h.json; quoted ok on the kit's providers 2026-11-05 10:00Z: USDG, the kit's
// recorded Robinhood case, refuses too_many_pools now, its pools paired with more than 1,024 currencies)
const TORCH = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1111";
const CLANKER_COIN = "0x530ac7167531304a854087204092a2bf83051b07";
const CLANKER_HOOK = "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc";
const v4 = (currencyIn, currency, fee, tickSpacing, hooks = ZERO) => ({ venue: "uniswap-v4", currencyIn, hops: [{ currency, fee, tickSpacing, hooks, hookData: "0x" }] });
// [name, request, the lagging provider's host, how many blocks back, the outcome every quote must end in]: each
// lagger is the venue's first or second provider, so the first quote, with nothing measured, asks it in the pair; each
// lag is the venue's maxLag (Robinhood 100, Base 5), so its head pairs with an up-to-date one
export const CASES = [
  ["robinhood-publicnode-100", { chain: "robinhood", token: TORCH, amountIn: 10n ** 15n, slippageBps: 300, route: v4(ZERO, TORCH, 3000, 60) }, "robinhood-rpc.publicnode.com", 100, "ok"],
  ["base-blastapi-5", { chain: "base", token: CLANKER_COIN, amountIn: 10n ** 15n, slippageBps: 300, route: v4(BASE_WETH, CLANKER_COIN, 0x800000, 200, CLANKER_HOOK) }, "base-mainnet.public.blastapi.io", 5, "ok"],
];

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** The verdict on a run ({ cases: { [name]: { cold: { ms, code, lagHeads }, quotes: [{ ms, code, lagHeads }] } } }). */
export function check(run) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "PASS" : "FAIL"} ${text}`);
  };
  for (const [name, , host, lag, want] of CASES) {
    const quotes = run?.cases?.[name]?.quotes;
    const cold = run?.cases?.[name]?.cold;
    const n = Array.isArray(quotes) ? quotes.length : 0;
    const asked = Number.isInteger(cold?.lagHeads) ? cold.lagHeads : 0;
    say(asked > 0, `${name}: ${host} answering ${lag} blocks back was asked for its head ${asked} times in the cold quote`);
    if (cold !== undefined) lines.push(`INFO ${name}: the cold quote ${cold.code} in ${cold.ms} ms${cold.message === undefined ? "" : `: ${cold.message}`}`);
    say(n >= N, `${name}: ${n} warm quotes, ${N} needed`);
    if (n === 0) continue;
    const wrong = quotes.filter((q) => q.code !== want);
    say(wrong.length === 0, `${name}: ${n - wrong.length} of ${n} warm quotes end ${want}${wrong.length ? ` (others: ${[...new Set(wrong.map((q) => `${q.code} at quote ${quotes.indexOf(q) + 1}, ${q.ms} ms${q.message === undefined ? "" : `: ${q.message}`}`))].join("; ")})` : ""}`);
    const ms = quotes.map((q) => q.ms);
    lines.push(`INFO ${name}: warm p50 ${Math.round(pct(ms, 50))} ms, p95 ${Math.round(pct(ms, 95))} ms over ${n}; the lagger's head asks per warm quote ${quotes.map((q) => q.lagHeads).join(",")}`);
  }
  return { ok, lines };
}

/** `fetch` with `host`'s latest block answered `lag` blocks back: a batch asking eth_getBlockByNumber("latest") reads
 *  that provider's own head first, then asks for that block by number in its place. `count` counts each such batch. */
export function lagging(real, host, lag, count) {
  return async (u, init) => {
    if (new URL(String(u)).hostname !== host || typeof init?.body !== "string") return real(u, init);
    const body = JSON.parse(init.body);
    const latest = (c) => c?.method === "eth_getBlockByNumber" && c.params?.[0] === "latest";
    if (!Array.isArray(body) || !body.some(latest)) return real(u, init);
    count();
    const r = await real(u, { ...init, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] }) });
    const n = BigInt((await r.json()).result);
    const back = "0x" + (n - BigInt(lag)).toString(16);
    return real(u, { ...init, body: JSON.stringify(body.map((c) => (latest(c) ? { ...c, params: [back, ...c.params.slice(1)] } : c))) });
  };
}

/** A cold quote and N warm ones of each case, 1.5 s apart, through the kit's public evmPoolBuyQuote with the case's
 *  provider lagging from the cold quote on. */
export async function measure(n = N) {
  const run = { recorded: new Date().toISOString(), cases: {} };
  const real = globalThis.fetch;
  try {
    for (const [name, req, host, lag] of CASES) {
      const quotes = [];
      let heads = 0;
      globalThis.fetch = lagging(real, host, lag, () => heads++);
      for (let i = 0; i <= n; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1500));
        const before = heads;
        const t = performance.now();
        let code = "ok";
        let message;
        try {
          await evmPoolBuyQuote(req);
        } catch (e) {
          if (!(e instanceof EvmQuoteError)) throw e;
          code = e.code;
          message = String(e.message).slice(0, 300);
        }
        quotes.push({ ms: Math.round(performance.now() - t), code, lagHeads: heads - before, ...(message === undefined ? {} : { message }) });
        console.log(`${name} ${i === 0 ? "cold" : i} ${quotes[i].ms} ms ${code} (lagger heads ${quotes[i].lagHeads})${message === undefined ? "" : `: ${message}`}`);
      }
      run.cases[name] = { cold: quotes[0], quotes: quotes.slice(1) };
    }
  } finally {
    globalThis.fetch = real;
  }
  return run;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const run = await measure();
    const at = process.argv.indexOf("--record");
    if (at > 0) writeFileSync(process.argv[at + 1], JSON.stringify(run, null, 1) + "\n");
    const r = check(run);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? "PASS evm-quote-lag-held" : "FAIL evm-quote-lag-held");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.log(`ERROR evm-quote-lag-held: ${e?.message ?? e}`);
    process.exit(2);
  }
}
