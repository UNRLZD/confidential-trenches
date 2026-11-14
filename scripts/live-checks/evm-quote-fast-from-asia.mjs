#!/usr/bin/env node
// Live check of card evm-quote-fast-from-asia: a warm Base buy sends its first round of reads at once, beside its scan,
// never after it. Before the card each warm quote first waited for two trips to the scan provider (its head, then the
// logs since the last scan), from this Mac about 220 ms before any read (2026-11-14 19:0xZ). Through the
// kit's public entry (evmPoolBuyQuote, on the kit's own pinned providers, as the device runs it), for each case of
// evm-quote-warm-round: one cold quote, then N_WARM quotes 1.5 s apart, each request timed; it passes when
//   - every quote ends as the case says (the quote's answer, or the refusal the case expects);
//   - at least MIN_BESIDE of the warm quotes send their first read (eth_call) before any answer of the scan provider
//     (eth_blockNumber, eth_getLogs) comes back: such a quote has no trip before its reads. The rest may have had no
//     held head (the watch's read failed or came late), and then agree on a block and scan first, as before.
// It measures where it runs: the warm p95 under a second is evm-quote-warm-round's rule, here only printed.
// After: app
// Bundle: out EVM RPC quotes
//   node scripts/live-checks/evm-quote-fast-from-asia.mjs [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2. --record writes the run to <file>, for the test's replay
// (evm-quote-fast-from-asia.answers.json). Reads only: no key, no transaction, no money moves.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EvmQuoteError, evmPoolBuyQuote } from "../../packages/kit/src/index.ts";
import { CASES } from "./evm-quote-warm-round.mjs";

export const N_WARM = 10;
export const MIN_BESIDE = 8;
const SCAN = new Set(["eth_blockNumber", "eth_getLogs"]);

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** The verdict on a run ({ cases: { [name]: { quotes: [{ ms, code, firstRead, scanBefore }] } } }): `firstRead` is the
 *  ms from the quote's start to its first read sent (null: none), `scanBefore` the scan provider's answers that came
 *  back before it. */
export function check(run) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "PASS" : "FAIL"} ${text}`);
  };
  for (const [name, , want] of CASES) {
    const quotes = run?.cases?.[name]?.quotes;
    const n = Array.isArray(quotes) ? quotes.length : 0;
    say(n >= N_WARM + 1, `${name}: ${n} quotes, ${N_WARM + 1} needed (one cold, ${N_WARM} warm)`);
    if (n < 2) continue;
    const wrong = quotes.filter((q) => q.code !== want);
    say(wrong.length === 0, `${name}: ${n - wrong.length} of ${n} quotes end ${want}${wrong.length ? ` (others: ${[...new Set(wrong.map((q) => q.code))].join(", ")})` : ""}`);
    const warm = quotes.slice(1);
    const beside = warm.filter((q) => typeof q.firstRead === "number" && q.scanBefore === 0).length;
    const trips = warm.map((q) => (typeof q.scanBefore === "number" ? q.scanBefore : "none"));
    say(beside >= MIN_BESIDE, `${name}: ${beside} of ${warm.length} warm quotes send their first read before any scan answer (${MIN_BESIDE} needed; scan answers before the first read: ${trips.join(" ")})`);
    lines.push(`INFO ${name}: warm p50 ${Math.round(pct(warm.map((q) => q.ms), 50))} ms, p95 ${Math.round(pct(warm.map((q) => q.ms), 95))} ms over ${warm.length}`);
  }
  return { ok, lines };
}

/** One cold and `n` warm quotes of each case, 1.5 s apart, through the kit's public evmPoolBuyQuote, each request it
 *  sends timed by its methods. */
export async function measure(n = N_WARM) {
  const run = { recorded: new Date().toISOString(), cases: {} };
  const real = globalThis.fetch;
  let log = null;
  globalThis.fetch = async (u, init) => {
    let methods = [];
    try {
      const b = JSON.parse(String(init?.body));
      methods = (Array.isArray(b) ? b : [b]).map((x) => String(x?.method));
    } catch {}
    const e = log === null ? null : { methods, sent: performance.now(), back: null };
    if (e !== null) log.push(e);
    try {
      return await real(u, init);
    } finally {
      if (e !== null) e.back = performance.now();
    }
  };
  try {
    for (const [name, req] of CASES) {
      const quotes = [];
      for (let i = 0; i <= n; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1500));
        log = [];
        const t = performance.now();
        let code = "ok";
        try {
          await evmPoolBuyQuote(req);
        } catch (e) {
          if (!(e instanceof EvmQuoteError)) throw e;
          code = e.code;
        }
        const ms = Math.round(performance.now() - t);
        const L = log;
        log = null;
        const read = L.find((e) => e.methods.includes("eth_call"));
        const scanBefore = read === undefined ? null : L.filter((e) => e.methods.some((m) => SCAN.has(m)) && e.back !== null && e.back <= read.sent).length;
        quotes.push({ ms, code, firstRead: read === undefined ? null : Math.round(read.sent - t), scanBefore });
        console.log(`${name} ${i} ${ms} ms ${code}, first read at ${quotes[i].firstRead} ms, scan answers before it ${scanBefore}`);
      }
      run.cases[name] = { quotes };
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
    console.log(r.ok ? "PASS evm-quote-fast-from-asia" : "FAIL evm-quote-fast-from-asia");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.log(`ERROR evm-quote-fast-from-asia: ${e?.message ?? e}`);
    process.exit(2);
  }
}
