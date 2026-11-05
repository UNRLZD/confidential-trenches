#!/usr/bin/env node
// Runs: once, it reads no host: the kit at the checkout against each chain's pinned scan providers, run at merge with its recorded answers
// Live check of card evm-scan-second-provider: an EVM buy's pool scan never stops at one bad scan provider. Through the
// kit's public entry (evmPoolBuyQuote, on the kit's own pinned providers, as the device runs it), for a Base and a
// Robinhood buy: quotes as the device runs them (the first scan provider answering) until one ends as the case says,
// none started past WARMUP_MS (a cold scan reads the whole depth on the first and keeps what came back for the next, as
// on GitHub's runners, where a cold quote can end at the bound: evm-quote-warm-round, 2026-11-05), then HELD quotes with the first
// scan provider held, 1.5 s apart, each way below in turn:
//   - "refused": every request to it fails with no connection (a browser's "Failed to fetch");
//   - "no logs": it answers every getLogs with an error and no logs (-32602 "block range extends beyond current head
//     block", base.rpc.blxrbdn.com's and blastapi's answer past their head, 2026-11-05 16:13Z).
// It passes when
//   - each chain pins a second scan provider on another host, and its answer to the browser's CORS preflight from the
//     app's origin allows that origin and content-type, as does its POST's answer (the device calls it from the browser);
//   - a quote with the first answering ends as the case says, and every held quote does, each under the bound (60 s);
//   - every held quote asked the second provider for logs, so the second, not the first, carried its scan.
// A cold scan of the whole depth on the second alone is not asked: no keyless second carries Base's 1M or Robinhood's
// 10M blocks within the bound (the venue's notes); the second carries what the first leaves of the newest blocks.
//   node scripts/live-checks/evm-scan-second-provider.mjs [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2. --record writes the run, for the test's replay
// (evm-scan-second-provider.answers.json). Reads only: no key, no transaction, no money moves.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EvmQuoteError, evmPoolBuyQuote, evmPoolVenues } from "../../packages/kit/src/index.ts";

export const APP_ORIGIN = "https://confidential.unrealized.trade";
export const BOUND_MS = 60_000;
export const MODES = ["refused", "no logs"];
export const HELD = 2; // quotes per mode
export const WARMUP_MS = 240_000; // the warm-up's time: no quote of it starts past this
const ZERO = "0x0000000000000000000000000000000000000000";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
// the tokens of evm-quote-warm-round (base-hook) and evm-quote-lag-held (robinhood TORCH)
const CLANKER_COIN = "0x530ac7167531304a854087204092a2bf83051b07";
const CLANKER_HOOK = "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc";
const TORCH = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1111"; // evm-quote-lag-held.mjs
const v4 = (currencyIn, currency, fee, tickSpacing, hooks = ZERO) => ({ venue: "uniswap-v4", currencyIn, hops: [{ currency, fee, tickSpacing, hooks, hookData: "0x" }] });
// [name, request, the outcome every quote must end in]
export const CASES = [
  ["base-hook", { chain: "base", token: CLANKER_COIN, amountIn: 10n ** 15n, slippageBps: 300, route: v4(BASE_WETH, CLANKER_COIN, 0x800000, 200, CLANKER_HOOK) }, "ok"],
  ["robinhood-torch", { chain: "robinhood", token: TORCH, amountIn: 10n ** 15n, slippageBps: 300, route: v4(ZERO, TORCH, 3000, 60) }, "ok"],
];

/** The verdict on a run ({ preflight: { [url]: {...} }, scans: { [chain]: { first, spare } }, cases: { [name]: { first,
 *  held: [{ mode, code, ms, firstAsked, spareLogs }] } } }). */
export function check(run) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "PASS" : "FAIL"} ${text}`);
  };
  const origin = (o) => o === "*" || o === APP_ORIGIN;
  for (const [name, req, want] of CASES) {
    const s = run?.scans?.[req.chain];
    const host = (u) => (typeof u === "string" ? new URL(u).hostname : "none");
    say(typeof s?.spare === "string" && host(s.spare) !== host(s.first), `${req.chain} pins a second scan provider on another host: ${host(s?.first)}, then ${host(s?.spare)}`);
    const p = typeof s?.spare === "string" ? run?.preflight?.[s.spare] : undefined;
    const allowed = p !== undefined && p.status >= 200 && p.status < 300 && origin(p.allow) && (p.headers === "*" || /(^|,)\s*content-type\s*(,|$)/i.test(p.headers ?? "")) && origin(p.post);
    say(allowed, `${req.chain} second scan provider preflight from ${APP_ORIGIN}: ${p === undefined ? "not read" : `${p.status}, allow-origin ${p.allow ?? "none"}, allow-headers ${p.headers ?? "none"}; POST allow-origin ${p.post ?? "none"}`}`);
    const c = run?.cases?.[name];
    // the warm-up's quotes, each started within WARMUP_MS of the first
    const warm = [];
    for (let i = 0, at = 0; Array.isArray(c?.first) && i < c.first.length && at < WARMUP_MS; at += Number(c.first[i].ms) || 0, i++) warm.push(c.first[i]);
    say(warm.some((q) => q.code === want), `${name}: the first scan provider answering, quotes end ${warm.map((q) => `${q.code} (${q.ms} ms)`).join(", ") || "not run"}; one ${want} wanted, none started past ${WARMUP_MS} ms`);
    const held = Array.isArray(c?.held) ? c.held : [];
    for (const m of MODES) {
      const qs = held.filter((q) => q.mode === m);
      say(qs.length >= HELD, `${name}, first ${m}: ${qs.length} held quotes, ${HELD} needed`);
      for (const q of qs) {
        say(q.code === want && q.ms < BOUND_MS, `${name}, first ${m}: ends ${q.code}${q.message ? `: ${q.message}` : ""} in ${q.ms} ms (${want} under ${BOUND_MS} ms wanted)`);
        say(q.firstAsked > 0 && q.spareLogs > 0, `${name}, first ${m}: the first asked ${q.firstAsked} times, the second ${q.spareLogs} getLogs`);
      }
    }
  }
  return { ok, lines };
}

/** Each chain's second scan provider's answer to the browser's preflight of a JSON POST from APP_ORIGIN, and its POST's. */
async function preflight(urls) {
  const out = {};
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: "OPTIONS", headers: { Origin: APP_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }, signal: AbortSignal.timeout(10_000) });
      const post = await fetch(u, { method: "POST", headers: { Origin: APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(10_000) });
      await post.text();
      out[u] = { status: r.status, allow: r.headers.get("access-control-allow-origin"), headers: r.headers.get("access-control-allow-headers"), post: post.headers.get("access-control-allow-origin") };
    } catch (e) {
      out[u] = { status: 0, allow: null, headers: null, post: null, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 120) };
    }
  }
  return out;
}

/** One quote through the kit's public entry, the first scan provider `first` held as `mode` (null: not held). */
async function quote(req, first, spare, mode) {
  const real = globalThis.fetch;
  const n = { firstAsked: 0, spareLogs: 0 };
  globalThis.fetch = async (u, init) => {
    const url = String(u);
    let body = [];
    try {
      body = [JSON.parse(String(init?.body))].flat();
    } catch {}
    if (url === spare && body.some((c) => c?.method === "eth_getLogs")) n.spareLogs++;
    if (url !== first || mode === null) return real(u, init);
    n.firstAsked++;
    if (mode === "refused") throw new TypeError("Failed to fetch");
    const r = await real(u, init);
    if (!body.some((c) => c?.method === "eth_getLogs")) return r;
    const out = await r.json();
    const swapped = out.map((a) => (body[a?.id]?.method === "eth_getLogs" ? { jsonrpc: "2.0", id: a.id, error: { code: -32602, message: "block range extends beyond current head block" } } : a));
    return new Response(JSON.stringify(swapped), { status: 200, headers: { "content-type": "application/json" } });
  };
  const t = performance.now();
  let code = "ok";
  let message;
  try {
    await evmPoolBuyQuote(req);
  } catch (e) {
    if (!(e instanceof EvmQuoteError)) throw e;
    code = e.code;
    message = String(e.message).slice(0, 300);
  } finally {
    globalThis.fetch = real;
  }
  return { ...(mode === null ? {} : { mode }), code, ...(message === undefined ? {} : { message }), ms: Math.round(performance.now() - t), ...(mode === null ? {} : n) };
}

export async function measure(venues = evmPoolVenues()) {
  const scans = {};
  for (const c of ["base", "robinhood"]) scans[c] = { first: venues[c]?.scan?.url ?? null, spare: venues[c]?.scan?.spare?.url ?? null };
  const run = { recorded: new Date().toISOString(), scans, preflight: await preflight(Object.values(scans).map((s) => s.spare).filter((u) => typeof u === "string")), cases: {} };
  for (const [name, req] of CASES) {
    const { first, spare } = scans[req.chain];
    const c = (run.cases[name] = { first: [], held: [] });
    const t0 = performance.now();
    for (let i = 0; performance.now() - t0 < WARMUP_MS && !c.first.some((q) => q.code === CASES.find((x) => x[0] === name)[2]); i++) {
      const q = await quote(req, first, spare, null);
      c.first.push(q);
      console.log(`${name} first answering ${i}: ${q.code} ${q.ms} ms${q.message ? `: ${q.message}` : ""}`);
    }
    for (const m of MODES) {
      for (let i = 0; i < HELD; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const q = await quote(req, first, spare, m);
        c.held.push(q);
        console.log(`${name} first ${m} ${i}: ${q.code} ${q.ms} ms, first asked ${q.firstAsked}, second getLogs ${q.spareLogs}${q.message ? `: ${q.message}` : ""}`);
      }
    }
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
    console.log(r.ok ? "PASS evm-scan-second-provider" : "FAIL evm-scan-second-provider");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.log(`ERROR evm-scan-second-provider: ${e?.message ?? e}`);
    process.exit(2);
  }
}
