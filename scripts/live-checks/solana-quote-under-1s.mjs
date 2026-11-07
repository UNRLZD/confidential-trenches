#!/usr/bin/env node
// Live check of card solana-quote-under-1s: a Solana buy quote completes in under 1 s with every device check, on the
// deployed hosts. Each run is the kit's runSolanaTrade --dry (nothing is signed or sent: the dry flow fills the
// signature slot with random bytes) on a fresh set of deps, through HELPER_HOST's Jupiter build and its /v1/rpc/solana
// (provider B) and PublicNode's keyless RPC (provider A), buying 0.01 SOL of EQM29…pump from a stand-in wallet that holds
// SOL and wSOL (so the tx writes its wSOL account and the second simulation runs). Every call the trade makes is timed as
// it leaves its provider's queue; "quote complete" is onProgress("signed"), the moment the trade asks for signatures.
// Connections are held as a page holds them (one HTTP/2 agent a run, warmed by one read to each host, untimed).
// It passes only when, on every run: the leg is not refused and S1-S13 each ran and passed; both providers answered a
// blockhash and a simulation; the second simulation ([wallet, wSOL]) ran on both; the build went out before the reference
// answered (the card's first lever); the second simulation went out before the first answered, on each provider (its
// second); and over the runs the quote is complete at p50 < 1,000 ms and p95 < 1,300 ms.
//   node scripts/live-checks/solana-quote-under-1s.mjs [--base <helper origin>] [--runs <n>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes the run, which judge() reads as the test replays it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { readSolanaReference, runSolanaTrade, solanaHelperRpc, solanaJsonRpc, solanaSendPaths } from "../../packages/kit/src/index.ts";

const KEY = "solana-quote-under-1s";
export const MINT = "EQM29p2pzrRMUckhb5umAzSgjEhnCy8gNKSVfVnrpump";
/** A stand-in that holds SOL and wSOL (FVee…8qQi), read live; never a wallet of ours, and nothing is signed for it. */
export const WALLET = "9UnZnrFJ1CXCmCorgGU9NvYkX5np1h4v4ympx3Nrdw3v";
export const WSOL = "FVee2JCpMd9k17iP1LLCSP28wwLt5N172pULCqUo8qQi";
export const BUY_LAMPORTS = 10_000_000n;
export const SLIPPAGE_BPS = 500;
export const RUNS = 5;
/** The helper's /v1/rpc takes 16 calls of one caller in 10 s (apps/helper/src/rpc/rpc.ts RPC_CLIENT_MAX); a quote and its
 * dry send ask about 14 of provider B, so runs go 10 s apart. */
export const GAP_MS = 10_000;
export const P50_MS = 1_000;
export const P95_MS = 1_300;
export const CHECKS = Array.from({ length: 13 }, (_, i) => `S${i + 1}`);
const PROVIDER_A = "https://solana-rpc.publicnode.com";

const args = (k) => process.argv.flatMap((v, i) => (process.argv[i - 1] === k ? [v] : []));
const pct = (xs, p) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

/** One run's verdict lines and its quote time, from its record alone (no network). */
function judgeRun(r, i) {
  const lines = [];
  const bad = (s) => lines.push(`BAD run ${i}: ${s}`);
  const calls = r.calls ?? [];
  const isSim = (c) => c.method === "simulateTransaction";
  const done = (c) => c.end <= r.quote;
  if (r.refused) bad(`refused: ${String(r.refused).slice(0, 200)}`);
  const ran = new Map((r.checks ?? []).map((c) => [c.id, c.ok]));
  const missing = CHECKS.filter((id) => ran.get(id) !== true);
  if (missing.length) bad(`checks not run or not passed: ${missing.join(" ")}`);
  if (!Number.isFinite(r.quote)) bad("the quote never asked for its signatures");
  for (const at of ["A", "B"]) {
    if (!calls.some((c) => c.at === at && c.method === "getLatestBlockhash" && done(c))) bad(`provider ${at} answered no blockhash`);
    if (!calls.some((c) => c.at === at && isSim(c) && done(c) && c.keys?.[0] === WALLET && c.keys.length === 4)) bad(`provider ${at} answered no simulation`);
  }
  const ref = calls.find((c) => c.method === "reference");
  const build = calls.find((c) => c.method === "build");
  if (!ref || !build) bad("no reference read or no build");
  else if (!(build.start < ref.end)) bad(`the build went out at ${build.start} ms, after the reference answered at ${ref.end} ms`);
  for (const at of ["A", "B"]) {
    const first = calls.find((c) => c.at === at && isSim(c) && done(c) && c.keys?.length === 4 && c.keys[0] === WALLET);
    const second = calls.find((c) => c.at === at && isSim(c) && done(c) && c.keys?.length === 2 && c.keys[0] === WALLET && c.keys[1] === WSOL);
    if (!second) bad(`provider ${at} ran no second simulation of the wallet's wSOL account`);
    else if (first && !(second.start < first.end)) bad(`provider ${at}'s second simulation went out at ${second.start} ms, after the first answered at ${first.end} ms`);
  }
  return { lines, quote: r.quote };
}

/** The verdict on a recorded or live set of runs. */
export function judge(rec) {
  const runs = rec?.runs ?? [];
  const lines = [];
  if (runs.length < RUNS) lines.push(`BAD ${runs.length} runs, want ${RUNS}`);
  const quotes = [];
  runs.forEach((r, i) => {
    const j = judgeRun(r, i);
    lines.push(...j.lines);
    if (Number.isFinite(j.quote)) quotes.push(j.quote);
  });
  if (quotes.length) {
    const p50 = pct(quotes, 50);
    const p95 = pct(quotes, 95);
    const line = `the quote complete: p50 ${Math.round(p50)} ms, p95 ${Math.round(p95)} ms over ${quotes.length} (bound p50 < ${P50_MS}, p95 < ${P95_MS})`;
    lines.push(p50 < P50_MS && p95 < P95_MS ? `ok  ${line}` : `BAD ${line}`);
  }
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

async function once(base) {
  const calls = [];
  const t0 = performance.now();
  const rel = () => performance.now() - t0;
  const timed = (rpc, at) => async (method, params) => {
    const start = rel();
    let err;
    try {
      return await rpc(method, params);
    } catch (e) {
      err = String(e?.message ?? e).slice(0, 80);
      throw e;
    } finally {
      const keys = method === "simulateTransaction" ? params[1]?.accounts?.addresses : method === "getMultipleAccounts" ? params[0] : undefined;
      calls.push({ at, method, start: Math.round(start), end: Math.round(rel()), ...(keys ? { keys } : {}), ...(err ? { err } : {}) });
    }
  };
  let signedAt = NaN;
  const record = await runSolanaTrade(
    { side: "buy", token: MINT, slippageBps: SLIPPAGE_BPS, wallets: [WALLET], legs: [{ wallet: WALLET, amount: BUY_LAMPORTS, arm: { own: true } }] },
    {
      helper: base,
      providers: [timed(solanaJsonRpc(PROVIDER_A, { timeoutMs: 15_000 }), "A"), timed(solanaHelperRpc(base, { timeoutMs: 15_000 }), "B")],
      reference: async (q, providers) => {
        const start = rel();
        try {
          return await readSolanaReference(providers, q);
        } finally {
          calls.push({ at: "ref", method: "reference", start: Math.round(start), end: Math.round(rel()) });
        }
      },
      fetch: async (url, init) => {
        const start = rel();
        const r = await fetch(url, init);
        const body = await r.text();
        calls.push({ at: "helper", method: "build", start: Math.round(start), end: Math.round(rel()), status: r.status });
        return new Response(body, { status: r.status, headers: r.headers });
      },
      paths: solanaSendPaths({ helper: solanaHelperRpc(base) }),
      dry: true,
      onProgress: (s) => { if (s === "signed") signedAt = rel(); },
    },
  );
  const leg = record.legs[0];
  return { quote: Math.round(signedAt), refused: leg?.refused ?? null, checks: (leg?.verdict?.results ?? []).map((x) => ({ id: x.id, ok: x.ok })), calls: calls.sort((x, y) => x.start - y.start) };
}

// Node's fetch is undici; a run's HTTP/2 agent is made from the class of the global dispatcher Node sets on a first fetch.
const DISPATCHER = Symbol.for("undici.globalDispatcher.1");
async function connections(base) {
  const old = globalThis[DISPATCHER];
  globalThis[DISPATCHER] = new old.constructor({ allowH2: true, keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000 });
  await old.close?.().catch(() => undefined);
  await Promise.all([
    fetch(`${base}/health`).then((r) => r.arrayBuffer()),
    fetch(PROVIDER_A, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' }).then((r) => r.arrayBuffer()),
  ]).catch(() => undefined);
}

async function main() {
  const base = args("--base")[0] ?? process.env.HELPER_HOST ?? "https://api.confidential.unrealized.trade";
  const n = Number(args("--runs")[0] ?? RUNS);
  await fetch(`${base}/health`).then((r) => r.arrayBuffer()).catch(() => undefined);
  const runs = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) await new Promise((ok) => setTimeout(ok, GAP_MS));
    await connections(base);
    runs.push(await once(base));
  }
  const rec = { key: KEY, at: new Date().toISOString(), base, runs };
  const file = args("--record")[0];
  if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
  const v = judge(rec);
  for (const r of runs) console.log(`    run quote ${r.quote} ms${r.refused ? ` refused: ${r.refused}` : ""}`);
  for (const l of v.lines) console.log(l);
  console.log(`live-check ${KEY}: ${v.ok ? "PASS" : "FAIL"} (${base}, ${runs.length} runs)`);
  return v.ok ? 0 : 1;
}

if (import.meta.main) {
  main().then((c) => process.exit(c), (e) => { console.error(`live-check ${KEY}: ERROR: ${e?.message ?? e}`); process.exit(2); });
}
