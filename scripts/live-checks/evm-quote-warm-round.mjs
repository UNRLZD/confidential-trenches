#!/usr/bin/env node
// Live check of card evm-quote-warm-round: a warm Base pool buy quotes in under a second at p95. Through the kit's
// public entry (evmPoolBuyQuote, on the kit's own pinned providers, as the device runs it), for each case below: one
// cold quote, then N_MIN quotes 1.5 s apart; it passes when
//   - each chain's venue lists at least three providers on different hosts (a quote decides on any two that agree, so
//     one that drops out leaves two);
//   - every quote of a case ends as the case says (the quote's answer, or the refusal the case expects), so a fast
//     refusal never counts as a fast quote;
//   - the warm quotes' p95 is under P95_MS;
//   - every listed provider of each chain answers the browser's CORS preflight from the app's origin (APP_ORIGIN) with an
//     access-control-allow-origin of * or that origin and content-type allowed, and its answer to a POST from there
//     carries the same allow-origin: the device runs the quote in the browser, and a provider without them is one it
//     never reaches (review of bc189de, L-5: base-public.nodies.app; re-review of fd9dd16, LOW-3: the POST's own).
//   node scripts/live-checks/evm-quote-warm-round.mjs [--record <file>] [--only <case,...>]
// PASS exit 0, FAIL exit 1, error exit 2. --record writes the run (each quote's time and outcome) to <file>, for the
// test's replay (evm-quote-warm-round.answers.json);
// --only measures those cases alone (a run to look at, never a pass: the cases left out fail).
// Reads only: no key, no transaction, no money moves.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EvmQuoteError, evmPoolBuyQuote, evmPoolVenues } from "../../packages/kit/src/index.ts";

export const P95_MS = 1000;
export const APP_ORIGIN = "https://confidential.unrealized.trade";
export const N_MIN = 20;
const ZERO = "0x0000000000000000000000000000000000000000";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
// the tokens and hooks (packages/kit/test/evm-quote-record.ts)
const CLANKER_COIN = "0x530ac7167531304a854087204092a2bf83051b07";
const CLANKER_HOOK = "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc";
const THIN = "0xf6e5fd9907b8ec70e399f34bb84fc2782db4dfe5";
const v4 = (currencyIn, currency, fee, tickSpacing, hooks = ZERO) => ({ venue: "uniswap-v4", currencyIn, hops: [{ currency, fee, tickSpacing, hooks, hookData: "0x" }] });
// [name, request, the outcome every quote must end in] (the kit's recorded cases, packages/kit/test/evm-quote-record.ts)
export const CASES = [
  // a Clanker v4 coin: WETH, dynamic fee, tick spacing 200, Clanker's hook
  ["base-hook", { chain: "base", token: CLANKER_COIN, amountIn: 10n ** 15n, slippageBps: 300, route: v4(BASE_WETH, CLANKER_COIN, 0x800000, 200, CLANKER_HOOK) }, "ok"],
  // a hookless native v4 pool that runs out before 100 ETH
  ["base-partial-v4", { chain: "base", token: THIN, amountIn: 10n ** 20n, slippageBps: 100, route: v4(ZERO, THIN, 3000, 60) }, "partial_fill"],
  // the cbBTC two-hop (card evm-quote-two-hop-rounds) and USDG on Robinhood (card evm-quote-many-pairs) are added back
  // by the cards that bring them under a second
];

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** The verdict on a run ({ cases: { [name]: { quotes: [{ ms, code }] } }, preflight: { [url]: { status, allow, headers } } })
 *  and the kit's venue list. */
export function check(run, venues = evmPoolVenues()) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "PASS" : "FAIL"} ${text}`);
  };
  for (const chain of ["base", "robinhood"]) {
    const urls = venues[chain]?.providers ?? [];
    const hosts = new Set(urls.map((u) => new URL(u).hostname));
    say(urls.length >= 3 && hosts.size === urls.length, `${chain} lists ${urls.length} providers on ${hosts.size} hosts (three at least, each its own host)`);
    for (const u of urls) {
      const p = run?.preflight?.[u];
      const origin = (o) => o === "*" || o === APP_ORIGIN;
      const allowed = p !== undefined && p.status >= 200 && p.status < 300 && origin(p.allow) && (p.headers === "*" || /(^|,)\s*content-type\s*(,|$)/i.test(p.headers ?? "")) && origin(p.post);
      say(allowed, `${chain} ${new URL(u).hostname} preflight from ${APP_ORIGIN}: ${p === undefined ? "not read" : `${p.status}, allow-origin ${p.allow ?? "none"}, allow-headers ${p.headers ?? "none"}; POST allow-origin ${p.post ?? "none"}`}`);
    }
  }
  for (const [name, , want] of CASES) {
    const quotes = run?.cases?.[name]?.quotes;
    const n = Array.isArray(quotes) ? quotes.length : 0;
    say(n >= N_MIN + 1, `${name}: ${n} quotes, ${N_MIN + 1} needed (one cold, ${N_MIN} warm)`);
    if (n < 2) continue;
    const wrong = quotes.filter((q) => q.code !== want);
    say(wrong.length === 0, `${name}: ${quotes.length - wrong.length} of ${quotes.length} quotes end ${want}${wrong.length ? ` (others: ${[...new Set(wrong.map((q) => (q.message === undefined ? q.code : `${q.code} at quote ${quotes.indexOf(q)}, ${q.ms} ms: ${q.message}`)))].join("; ")})` : ""}`);
    const warm = quotes.slice(1).map((q) => q.ms);
    const p95 = pct(warm, 95);
    say(p95 < P95_MS, `${name}: warm p50 ${Math.round(pct(warm, 50))} ms, p95 ${Math.round(p95)} ms over ${warm.length} (under ${P95_MS} ms)`);
  }
  return { ok, lines };
}

/** Each listed provider's answer to the browser's preflight of a JSON POST from APP_ORIGIN, and the POST's own
 *  allow-origin. */
export async function preflight(venues = evmPoolVenues()) {
  const out = {};
  for (const chain of ["base", "robinhood"]) {
    for (const u of venues[chain]?.providers ?? []) {
      try {
        const r = await fetch(u, { method: "OPTIONS", headers: { Origin: APP_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }, signal: AbortSignal.timeout(10_000) });
        const post = await fetch(u, { method: "POST", headers: { Origin: APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(10_000) });
        await post.text();
        out[u] = { status: r.status, allow: r.headers.get("access-control-allow-origin"), headers: r.headers.get("access-control-allow-headers"), post: post.headers.get("access-control-allow-origin") };
      } catch (e) {
        out[u] = { status: 0, allow: null, headers: null, post: null, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 120) };
      }
    }
  }
  return out;
}

/** Every request `f` makes, while it runs, summed per host and the methods of its body: the count, the median and
 *  longest time to the answer's headers, and each answer that was no 200 or held an error (fold 4 of the card's
 *  review: a cold quote on GitHub's runners took 79 to 99 s, one ending rpc_error, where the box took 10 to 15 s). */
export async function traced(f) {
  const real = globalThis.fetch;
  const log = [];
  globalThis.fetch = async (u, init) => {
    const t = performance.now();
    let m = "?";
    try {
      const b = JSON.parse(String(init?.body));
      m = [...new Set((Array.isArray(b) ? b : [b]).map((x) => x?.method))].join("+");
    } catch {}
    const e = { host: new URL(String(u)).hostname, m, ms: 0, bad: null };
    log.push(e);
    try {
      const r = await real(u, init);
      e.ms = Math.round(performance.now() - t);
      if (r.status !== 200) e.bad = `HTTP ${r.status}`;
      // an error inside a 200 answer, read off a copy so the kit reads the answer as it came
      r.clone().text().then((x) => {
        const err = /"error"\s*:\s*\{[^}]*"message"\s*:\s*"([^"]{0,100})/.exec(x)?.[1];
        if (err !== undefined) e.bad = `${e.bad ?? "error"}: ${err}`;
      }, () => {});
      return r;
    } catch (x) {
      e.ms = Math.round(performance.now() - t);
      e.bad = String(x?.name ?? x);
      throw x;
    }
  };
  try {
    await f();
  } finally {
    globalThis.fetch = real;
  }
  await new Promise((r) => setTimeout(r, 50));
  const by = new Map();
  for (const e of log) by.set(`${e.host} ${e.m}`, [...(by.get(`${e.host} ${e.m}`) ?? []), e]);
  return [...by].map(([k, es]) => {
    const ms = es.map((e) => e.ms).sort((a, b) => a - b);
    const bad = es.filter((e) => e.bad !== null);
    return { at: k, n: es.length, p50: ms[ms.length >> 1], max: ms.at(-1), bad: bad.length, why: [...new Set(bad.map((e) => e.bad))].slice(0, 3) };
  });
}

/** The preflights, then one cold and `n` warm quotes of each case, 1.5 s apart, through the kit's public
 *  evmPoolBuyQuote: each refusal with its message, and the cold quote's requests per provider (`traced`). */
export async function measure(n = N_MIN, only = null) {
  const run = { recorded: new Date().toISOString(), preflight: await preflight(), cases: {} };
  for (const [name, req] of CASES) {
    if (only !== null && !only.includes(name)) continue;
    const quotes = [];
    let cold = null;
    for (let i = 0; i <= n; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      const t = performance.now();
      let code = "ok";
      let message;
      const quote = async () => {
        try {
          await evmPoolBuyQuote(req);
        } catch (e) {
          if (!(e instanceof EvmQuoteError)) throw e;
          code = e.code;
          message = String(e.message).slice(0, 300);
        }
      };
      if (i === 0) cold = await traced(quote);
      else await quote();
      quotes.push({ ms: Math.round(performance.now() - t), code, ...(message === undefined ? {} : { message }) });
      console.log(`${name} ${i} ${quotes[i].ms} ms ${code}${message === undefined ? "" : `: ${message}`}`);
      if (i === 0) for (const c of cold) console.log(`  cold ${c.at}: ${c.n} requests, p50 ${c.p50} ms, max ${c.max} ms${c.bad ? `, ${c.bad} failed (${c.why.join(" | ")})` : ""}`);
    }
    run.cases[name] = { quotes, cold };
  }
  return run;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const o = process.argv.indexOf("--only");
    const run = await measure(N_MIN, o > 0 ? process.argv[o + 1].split(",") : null);
    const at = process.argv.indexOf("--record");
    if (at > 0) writeFileSync(process.argv[at + 1], JSON.stringify(run, null, 1) + "\n");
    const r = check(run);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? "PASS evm-quote-warm-round" : "FAIL evm-quote-warm-round");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.log(`ERROR evm-quote-warm-round: ${e?.message ?? e}`);
    process.exit(2);
  }
}
