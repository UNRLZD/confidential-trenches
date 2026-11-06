#!/usr/bin/env node
// Live check of card evm-rpc-spare-list: an EVM read walks an ordered list of providers, never stopping at two. On
// mainnet, with the first two providers of each list held down:
//   - the kit's pool scan (evmPoolBuyQuote through the kit's public entry, on its own pinned providers, as the device
//     runs it), for a Base and a Robinhood buy: quotes as the device runs them until one ends ok (the warm-up, none
//     started past WARMUP_MS), then HELD quotes 1.5 s apart with the first two scan providers held, each way below in
//     turn: "refused" (no connection, a browser's "Failed to fetch") and "503" (HTTP 503 "No server is available to
//     handle this request", bloXroute's answer for 10 minutes on 5 Nov 17:59-18:09Z);
//   - the helper's caller read (apps/helper/src/rpc/rpc.ts createRpc, /v1/rpc/<chain>, its list the configured
//     provider then SWAP_RPCS), an eth_getLogs of the chain's PoolManager over the newest 100 blocks, with its first two
//     held the same ways and a third: "limit" (-32011 "request limit reached", mainnet.base.org's answer to every
//     eth_getLogs on 5 Nov);
//   - the helper's caller read of an address-less Transfer filter (eth_getLogs over 1,000 blocks, Transfer's topic and
//     topic 2 a W, no address: a restore's W read, card evm-transfer-rpc-spares) with nothing held: PublicNode answers it
//     -32701 "Please specify an address..." at every span over 1 block (read 2026-11-05 20:07Z, and by the wallet lead
//     18:47-18:58Z), so the read walks on past it; on the checkout's reader, and on HELPER_HOST's POST /v1/rpc/<chain>
//     with the app's Origin (--base, the deployed helper).
// It passes when
//   - each chain's scan list has a third provider on a host of its own, and its answer to the browser's CORS preflight
//     from the app's origin allows that origin and content-type, as does its POST's answer;
//   - a warm-up quote ends ok, every held quote ends ok under the bound (60 s), and every held quote asked the third
//     for logs;
//   - every held helper read answers 200 with a JSON-RPC result list, from a provider past the first two;
//   - every address-less Transfer read answers 200 with a JSON-RPC result list, never an error.
//   node scripts/live-checks/evm-rpc-spare-list.mjs [--base <url>] [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2. --record writes the run, for the test's replay (evm-rpc-spare-list.answers.json).
// Reads only: no key, no transaction, no money moves.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EvmQuoteError, evmPoolBuyQuote, evmPoolVenues } from "../../packages/kit/src/index.ts";

export const APP_ORIGIN = "https://confidential.unrealized.trade";
export const HELPER = "https://api.confidential.unrealized.trade";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// a W as topic 2: any address reads the same way (an empty list is a list)
const W_TOPIC = "0x" + "0".repeat(24) + "809286a10000000000000000000000000000078e";
export const BOUND_MS = 60_000;
export const MODES = ["refused", "503"];
export const HELPER_MODES = ["refused", "503", "limit"];
export const HELD = 2; // quotes per mode
export const WARMUP_MS = 240_000;
/** The wait before each held quote: on Base past maxLag blocks (50 of its 200 ms blocks, 10 s), so the quote's scan
 *  always has blocks to ask the list for. 1.5 s after the warm-up the third's head stood at or behind the blocks the
 *  warm-up read, and the held quote asked it its head and no getLogs (live run 42135737951, 2026-11-06 00:18:37Z:
 *  "first two asked 2, third getLogs 0", an ok quote); past maxLag the scan either reads past the warm-up's blocks or
 *  catches up to the agreed block on the list (quote.ts scanPools). */
export const HELD_GAP_MS = { base: 11_500, robinhood: 1_500 };
/** The least scan providers a chain lists: Base four (card base-rpc-list-fix: with the first two held, a third that
 *  answers no logs still leaves another), Robinhood three. */
export const MIN_SCANS = { base: 4, robinhood: 3 };
const ZERO = "0x0000000000000000000000000000000000000000";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
// the tokens of evm-scan-second-provider (base-hook) and evm-quote-lag-held (robinhood TORCH)
const CLANKER_COIN = "0x530ac7167531304a854087204092a2bf83051b07";
const CLANKER_HOOK = "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc";
const TORCH = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1111";
const v4 = (currencyIn, currency, fee, tickSpacing, hooks = ZERO) => ({ venue: "uniswap-v4", currencyIn, hops: [{ currency, fee, tickSpacing, hooks, hookData: "0x" }] });
export const CASES = [
  ["base-hook", { chain: "base", token: CLANKER_COIN, amountIn: 10n ** 15n, slippageBps: 300, route: v4(BASE_WETH, CLANKER_COIN, 0x800000, 200, CLANKER_HOOK) }, "ok"],
  ["robinhood-torch", { chain: "robinhood", token: TORCH, amountIn: 10n ** 15n, slippageBps: 300, route: v4(ZERO, TORCH, 3000, 60) }, "ok"],
];

const host = (u) => (typeof u === "string" ? new URL(u).hostname : "none");

/** The verdict on a run ({ scans: { [chain]: [url...] }, preflight: { [url]: {...} }, cases: { [name]: { first, held } },
 *  helper: { [chain]: { list: [url...], held: [{ mode, status, results, answeredBy }] } } }). */
export function check(run) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "PASS" : "FAIL"} ${text}`);
  };
  const origin = (o) => o === "*" || o === APP_ORIGIN;
  for (const [name, req, want] of CASES) {
    const list = Array.isArray(run?.scans?.[req.chain]) ? run.scans[req.chain] : [];
    const least = MIN_SCANS[req.chain] ?? 3;
    say(list.length >= least && new Set(list.map(host)).size === list.length, `${req.chain} scan list of ${list.length}, each on its own host: ${list.map(host).join(", ") || "none"} (${least} at least)`);
    // every provider past the two held: the device reaches each only from the app's origin
    for (const [i, u] of [[2, list[2]], ...list.slice(3).map((x, k) => [k + 3, x])]) {
      const p = typeof u === "string" ? run?.preflight?.[u] : undefined;
      const allowed = p !== undefined && p.status >= 200 && p.status < 300 && origin(p.allow) && (p.headers === "*" || /(^|,)\s*content-type\s*(,|$)/i.test(p.headers ?? "")) && origin(p.post);
      say(allowed, `${req.chain} ${i === 2 ? "third" : i === 3 ? "fourth" : `#${i + 1}`} scan provider preflight from ${APP_ORIGIN}: ${p === undefined ? "not read" : `${p.status}, allow-origin ${p.allow ?? "none"}, allow-headers ${p.headers ?? "none"}; POST allow-origin ${p.post ?? "none"}`}`);
    }
    const c = run?.cases?.[name];
    const warm = [];
    for (let i = 0, at = 0; Array.isArray(c?.first) && i < c.first.length && at < WARMUP_MS; at += Number(c.first[i].ms) || 0, i++) warm.push(c.first[i]);
    say(warm.some((q) => q.code === want), `${name}: every provider answering, quotes end ${warm.map((q) => `${q.code} (${q.ms} ms)`).join(", ") || "not run"}; one ${want} wanted, none started past ${WARMUP_MS} ms`);
    const held = Array.isArray(c?.held) ? c.held : [];
    for (const m of MODES) {
      const qs = held.filter((q) => q.mode === m);
      say(qs.length >= HELD, `${name}, first two ${m}: ${qs.length} held quotes, ${HELD} needed`);
      for (const q of qs) {
        say(q.code === want && q.ms < BOUND_MS, `${name}, first two ${m}: ends ${q.code}${q.message ? `: ${q.message}` : ""} in ${q.ms} ms (${want} under ${BOUND_MS} ms wanted)`);
        say(q.heldAsked > 0 && q.thirdLogs > 0, `${name}, first two ${m}: the first two asked ${q.heldAsked} times, the third ${q.thirdLogs} getLogs`);
      }
    }
  }
  for (const chain of ["base", "robinhood"]) {
    const h = run?.helper?.[chain];
    const list = Array.isArray(h?.list) ? h.list : [];
    say(list.length >= 3, `helper ${chain} caller list of ${list.length}: ${list.map(host).join(", ") || "none"}`);
    for (const m of HELPER_MODES) {
      const r = (Array.isArray(h?.held) ? h.held : []).find((x) => x.mode === m);
      const past = r !== undefined && list.indexOf(r.answeredBy) >= 2;
      say(r !== undefined && r.status === 200 && Number.isInteger(r.results) && past, `helper ${chain}, first two ${m}: ${r === undefined ? "not run" : `HTTP ${r.status}, ${r.results ?? "no"} logs, answered by ${host(r.answeredBy)}`} (200 from the third or later wanted)`);
    }
  }
  for (const chain of ["base", "robinhood"]) {
    for (const where of ["checkout", "deployed"]) {
      const r = run?.addressless?.[chain]?.[where];
      const good = r !== undefined && r.status === 200 && Number.isInteger(r.results);
      say(good, `${where === "deployed" ? "deployed helper" : "helper"} ${chain}, an address-less Transfer read of 1,000 blocks: ${r === undefined ? "not run" : `HTTP ${r.status}, ${Number.isInteger(r.results) ? `${r.results} logs` : `error ${r.error ?? "none"}`}`}${r?.answeredBy ? `, answered by ${host(r.answeredBy)}` : ""} (a list wanted)`);
    }
  }
  return { ok, lines };
}

/** The 1,000-block address-less Transfer filter up to block `to`, as one JSON-RPC request. */
const addresslessBody = (to) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x" + (to - 999n).toString(16), toBlock: "0x" + to.toString(16), topics: [TRANSFER, null, W_TOPIC] }] });
const resultOf = (status, text) => {
  try {
    const j = JSON.parse(text);
    return { status, results: Array.isArray(j.result) ? j.result.length : null, error: j.error === undefined ? undefined : `${j.error.code} ${String(j.error.message).slice(0, 80)}` };
  } catch {
    return { status, results: null, error: String(text).slice(0, 80) };
  }
};
async function headOf(url) {
  const head = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
  return BigInt(head.result) - 5n;
}
/** The address-less read on the checkout's reader (createRpc with the server's deps) and on the deployed helper. */
async function addressless(chain, base) {
  const { createRpc } = await import("../../apps/helper/src/rpc/rpc.ts");
  const { SWAP_RPCS } = await import("../../apps/helper/src/data/evm/swaps.ts");
  const { providerHolds } = await import("../../apps/helper/src/limits/limits.ts");
  const to = await headOf(chain === "base" ? "https://base.gateway.tenderly.co" : "https://robinhood.daybreak-rpc.network");
  let answeredBy = null;
  const rpc = createRpc({}, { holds: providerHolds(), pinned: SWAP_RPCS, log: () => {}, fetch: async (u, init) => ((answeredBy = String(u)), fetch(u, init)) });
  const a = await rpc.handle(chain, "application/json", addresslessBody(to), "203.0.113.8");
  const checkout = { ...resultOf(a.status, a.body), answeredBy };
  let deployed;
  try {
    const r = await fetch(`${base}/v1/rpc/${chain}`, { method: "POST", headers: { "content-type": "application/json", Origin: APP_ORIGIN }, body: addresslessBody(to), signal: AbortSignal.timeout(20_000) });
    deployed = { ...resultOf(r.status, await r.text()), commit: r.headers.get("x-helper-commit") };
  } catch (e) {
    deployed = { status: 0, results: null, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 80) };
  }
  return { checkout, deployed };
}

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

const bodyOf = (init) => {
  try {
    return [JSON.parse(String(init?.body))].flat();
  } catch {
    return [];
  }
};
/** A fetch where `held` URLs answer as `mode` says and the rest go to the network. */
const holding = (real, held, mode, n) => async (u, init) => {
  const url = String(u);
  if (!held.includes(url) || mode === null) return real(u, init);
  n.heldAsked++;
  if (mode === "refused") throw new TypeError("Failed to fetch");
  if (mode === "503") return new Response("No server is available to handle this request", { status: 503 });
  const body = bodyOf(init);
  const answers = body.map((c) => ({ jsonrpc: "2.0", id: c?.id ?? null, error: { code: -32011, message: "request limit reached" } }));
  return new Response(JSON.stringify(Array.isArray(JSON.parse(String(init.body))) ? answers : answers[0]), { status: 200, headers: { "content-type": "application/json" } });
};

/** One quote through the kit's public entry, the list's first two held as `mode` (null: not held). */
async function quote(req, list, mode) {
  const real = globalThis.fetch;
  const n = { heldAsked: 0, thirdLogs: 0 };
  const inner = holding(real, list.slice(0, 2), mode, n);
  globalThis.fetch = async (u, init) => {
    if (String(u) === list[2] && bodyOf(init).some((c) => c?.method === "eth_getLogs")) n.thirdLogs++;
    return inner(u, init);
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

/** The helper's caller read on `chain` with its list's first two held as `mode`: the helper's own createRpc, with the
 *  server's deps (its provider holds and SWAP_RPCS as the pinned list, apps/helper/src/server.ts). */
async function helperRead(chain, mode) {
  const { createRpc, RPC_UPSTREAMS } = await import("../../apps/helper/src/rpc/rpc.ts");
  const { SWAP_RPCS } = await import("../../apps/helper/src/data/evm/swaps.ts");
  const { providerHolds } = await import("../../apps/helper/src/limits/limits.ts");
  const list = [...new Set([RPC_UPSTREAMS[chain].fallback, ...SWAP_RPCS[chain]])];
  let answeredBy = null;
  const n = { heldAsked: 0 };
  const inner = holding(fetch, list.slice(0, 2), mode, n);
  const rpc = createRpc({}, { holds: providerHolds(), pinned: SWAP_RPCS, log: () => {}, fetch: async (u, init) => ((answeredBy = String(u)), inner(u, init)) });
  const head = await fetch(list[2], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
  const to = BigInt(head.result) - 5n;
  const pm = evmPoolVenues()[chain].poolManager;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: pm, fromBlock: "0x" + (to - 99n).toString(16), toBlock: "0x" + to.toString(16) }] });
  const a = await rpc.handle(chain, "application/json", body, "203.0.113.7");
  let results = null;
  try {
    const j = JSON.parse(a.body);
    if (Array.isArray(j.result)) results = j.result.length;
  } catch {}
  return { list, row: { mode, status: a.status, results, answeredBy, heldAsked: n.heldAsked } };
}

export async function measure(venues = evmPoolVenues(), base = HELPER) {
  const scans = {};
  for (const c of ["base", "robinhood"]) {
    const s = venues[c]?.scan;
    // a kit before this card pinned one spare, `spare` (the bad answer's run at 66d7b60)
    scans[c] = s === undefined ? [] : [s.url, ...(s.spares ?? (s.spare === undefined ? [] : [s.spare])).map((x) => x.url)];
  }
  const run = { recorded: new Date().toISOString(), base, scans, preflight: await preflight(Object.values(scans).flatMap((l) => l.slice(2))), cases: {}, helper: {}, addressless: {} };
  for (const chain of ["base", "robinhood"]) {
    run.addressless[chain] = await addressless(chain, base);
    for (const [where, r] of Object.entries(run.addressless[chain])) console.log(`${where} helper ${chain} address-less Transfer read: HTTP ${r.status}, ${r.results ?? `error ${r.error}`}${r.answeredBy ? ` by ${host(r.answeredBy)}` : ""}${r.commit ? ` at ${r.commit.slice(0, 7)}` : ""}`);
  }
  for (const chain of ["base", "robinhood"]) {
    const h = (run.helper[chain] = { list: [], held: [] });
    for (const m of HELPER_MODES) {
      const { list, row } = await helperRead(chain, m);
      h.list = list;
      h.held.push(row);
      console.log(`helper ${chain} first two ${m}: HTTP ${row.status}, ${row.results ?? "no"} logs, answered by ${host(row.answeredBy)}`);
    }
  }
  for (const [name, req, want] of CASES) {
    const list = scans[req.chain];
    const c = (run.cases[name] = { first: [], held: [] });
    const t0 = performance.now();
    for (let i = 0; performance.now() - t0 < WARMUP_MS && !c.first.some((q) => q.code === want); i++) {
      const q = await quote(req, list, null);
      c.first.push(q);
      console.log(`${name} all answering ${i}: ${q.code} ${q.ms} ms${q.message ? `: ${q.message}` : ""}`);
    }
    for (const m of MODES) {
      for (let i = 0; i < HELD; i++) {
        await new Promise((r) => setTimeout(r, HELD_GAP_MS[req.chain] ?? 1500));
        const q = await quote(req, list, m);
        c.held.push(q);
        console.log(`${name} first two ${m} ${i}: ${q.code} ${q.ms} ms, first two asked ${q.heldAsked}, third getLogs ${q.thirdLogs}${q.message ? `: ${q.message}` : ""}`);
      }
    }
  }
  return run;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const b = process.argv.indexOf("--base");
    const run = await measure(evmPoolVenues(), b > 0 ? process.argv[b + 1].replace(/\/$/, "") : HELPER);
    const at = process.argv.indexOf("--record");
    if (at > 0) writeFileSync(process.argv[at + 1], JSON.stringify(run, null, 1) + "\n");
    const r = check(run);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? "PASS evm-rpc-spare-list" : "FAIL evm-rpc-spare-list");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.log(`ERROR evm-rpc-spare-list: ${e?.message ?? e}`);
    process.exit(2);
  }
}
