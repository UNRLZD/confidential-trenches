#!/usr/bin/env node
// Live check of card rh-cold-quote: a first quote of a Robinhood token this device never scanned answers with its real
// best pool within BOUND_MS, never rpc_error at the scan's bound. Through the kit's public entry (evmPoolBuyQuote, on
// the kit's own pinned providers, as the device runs it), in a fresh process (no scan kept): one cold quote of TORCH,
// whose 100 pools with other currencies (99 of them seeded currencies whose only pool is that one, read 2026-11-06
// 01:3xZ) held main's cold quote to rpc_error at 58-61 s, then WARM quotes 1.5 s apart. It passes when
//   - the cold quote ends ok under BOUND_MS (the card's 10 s);
//   - every warm quote ends ok (their times are printed; Robinhood's warm bound is card evm-quote-warm-round's).
// The cold quote's requests per host are printed (traced, as evm-quote-warm-round has them).
//   node scripts/live-checks/rh-cold-quote.mjs [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2. --record writes the run to <file>, for the test's replay
// (rh-cold-quote.answers.json). Reads only: no key, no transaction, no money moves.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EvmQuoteError, evmPoolBuyQuote } from "../../packages/kit/src/index.ts";
import { traced } from "./evm-quote-warm-round.mjs";

export const BOUND_MS = 10_000;
export const WARM = 5;
const ZERO = "0x0000000000000000000000000000000000000000";
const TORCH = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1111"; // evm-quote-lag-held.mjs
// TORCH's quote route: its hookless native 0.3% pool (Q 268.7e18 for 0.001 ETH, 2026-11-06 01:5xZ)
export const REQ = { chain: "robinhood", token: TORCH, amountIn: 10n ** 15n, slippageBps: 300, route: { venue: "uniswap-v4", currencyIn: ZERO, hops: [{ currency: TORCH, fee: 3000, tickSpacing: 60, hooks: ZERO, hookData: "0x" }] } };

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** The verdict on a run ({ cold: { ms, code, message?, hosts }, warm: [{ ms, code, message? }] }). */
export function check(run) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "PASS" : "FAIL"} ${text}`);
  };
  const c = run?.cold;
  if (c === undefined) say(false, "cold: not run");
  else say(c.code === "ok" && c.ms < BOUND_MS, `cold: the quote ends ${c.code} in ${c.ms} ms${c.message ? `: ${c.message}` : ""} (ok under ${BOUND_MS} ms wanted)`);
  const warm = Array.isArray(run?.warm) ? run.warm : [];
  if (c?.code === "ok") {
    say(warm.length >= WARM, `warm: ${warm.length} quotes (${WARM} wanted)`);
    const wrong = warm.filter((q) => q.code !== "ok");
    say(wrong.length === 0, `warm: ${warm.length - wrong.length} of ${warm.length} end ok${wrong.length ? ` (others: ${[...new Set(wrong.map((q) => q.code))].join(", ")})` : ""}`);
    if (warm.length > 0) lines.push(`INFO warm: p50 ${pct(warm.map((q) => q.ms), 50)} ms, p95 ${pct(warm.map((q) => q.ms), 95)} ms`);
  }
  return { ok, lines };
}

const once = async (f) => {
  const t = performance.now();
  let code = "ok";
  let message;
  try {
    await f();
  } catch (e) {
    if (!(e instanceof EvmQuoteError)) throw e;
    code = e.code;
    message = String(e.message).slice(0, 300);
  }
  return { ms: Math.round(performance.now() - t), code, ...(message === undefined ? {} : { message }) };
};

/** One cold quote with its requests per host, then WARM quotes 1.5 s apart once it ends ok. */
export async function measure() {
  let cold;
  const hosts = await traced(async () => void (cold = await once(() => evmPoolBuyQuote(REQ))));
  const run = { recorded: new Date().toISOString(), cold: { ...cold, hosts }, warm: [] };
  console.log(`cold ${cold.ms} ms ${cold.code}${cold.message === undefined ? "" : `: ${cold.message}`}`);
  for (const x of hosts) console.log(`  ${x.at}: ${x.n} requests, p50 ${x.p50} ms, max ${x.max} ms${x.bad ? `, ${x.bad} failed (${x.why.join(" | ")})` : ""}`);
  if (cold.code !== "ok") return run;
  for (let i = 0; i < WARM; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    run.warm.push(await once(() => evmPoolBuyQuote(REQ)));
    console.log(`warm ${i + 1} ${run.warm[i].ms} ms ${run.warm[i].code}`);
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
    console.log(r.ok ? "PASS rh-cold-quote" : "FAIL rh-cold-quote");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.log(`ERROR rh-cold-quote: ${e?.message ?? e}`);
    process.exit(2);
  }
}
