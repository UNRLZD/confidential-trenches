/// <reference types="node" />
// Card solana-quote-under-1s: the stage times of a Solana quote on real routes, and the KPI bound (quote complete
// under 1 s with every device check: p50 < 1,000 ms and p95 < 1,300 ms). Each run is runSolanaTrade --dry on fresh
// deps (new provider functions, so new paced queues, and no SolanaWalletLinks carried over: the page's first quote),
// through the deployed helper's Jupiter build and the two providers the page uses, and every S-check runs as on a
// real trade. Nothing is signed or sent: the dry flow fills the signature slot with random bytes, and its dryRunSolanaSet
// simulates the set after the quote is complete.
//
// "Quote complete" is the moment the trade asks for its signatures: onProgress("signed"), which the dry flow calls
// right after the checks pass (the signer is a placeholder), before the dry send's own simulation. The stages come
// from timing every call the trade makes, as it leaves its provider's queue:
//   first   the reference pool reads, the blockhash and the mint, begun together at the start
//   build   each helper /swap/v2/build call
//   tables  the build's lookup tables, read on both providers
//   simA/B  each simulateTransaction on provider A and B (sim1 the wallet's four accounts, sim2 its written wSOL ones)
//   again   the pre-state read again after the simulations
//   checks  from the last call's answer to "signed": the checks S1-S13 on the bytes, on the device
//
//   node packages/kit/test/solana-quote-timing.ts --dry [--n 20] [--gap-ms 4000] [--route side:mint:amount]...
//     [--wallet <address>] [--out <file>] [--no-bound]
// Exits 1 when the bound fails (red), or when any run is refused or its checks fail.
import { writeFileSync } from "node:fs";
import {
  readSolanaReference,
  runSolanaTrade,
  solanaHelperRpc,
  solanaJsonRpc,
  solanaSendPaths,
  type SolanaRpc,
  type SolanaTradeRecord,
} from "../src/index.ts";

if (!process.argv.includes("--dry")) {
  console.error("this script runs only with --dry: it simulates and never sends");
  process.exit(2);
}
const args = (k: string) => process.argv.flatMap((v, i) => (process.argv[i - 1] === k ? [v] : []));
const HELPER = args("--helper")[0] ?? "https://api.confidential.unrealized.trade";
const PROVIDER_A = "https://solana-rpc.publicnode.com";
const SLIPPAGE_BPS = 500;
// A wallet that holds SOL, wSOL (FVee…8qQi) and EQM29…pump (the card's measured wallet: a buy from it writes its wSOL
// account, so the second simulation runs). Read live each run; it is a stand-in, never a wallet of ours.
const WALLET = args("--wallet")[0] ?? "9UnZnrFJ1CXCmCorgGU9NvYkX5np1h4v4ympx3Nrdw3v";
const ROUTES = (args("--route").length ? args("--route") : [
  "buy:EQM29p2pzrRMUckhb5umAzSgjEhnCy8gNKSVfVnrpump:10000000",
  "buy:MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump:10000000",
  "sell:EQM29p2pzrRMUckhb5umAzSgjEhnCy8gNKSVfVnrpump:50000000000",
]).map((r) => {
  const [side, mint, amount] = r.split(":");
  if ((side !== "buy" && side !== "sell") || !mint || !amount) throw new Error(`--route ${r} is not side:mint:amount`);
  return { side, mint, amount: BigInt(amount) } as const;
});
const N = Number(args("--n")[0] ?? 20);
const GAP_MS = Number(args("--gap-ms")[0] ?? 4000);

type Call = { at: "A" | "B" | "helper" | "ref"; method: string; start: number; end: number; keys?: number };

async function once(route: (typeof ROUTES)[number]) {
  const calls: Call[] = [];
  const t0 = performance.now();
  const rel = () => performance.now() - t0;
  const timed = (rpc: SolanaRpc, at: "A" | "B"): SolanaRpc => async (method, params) => {
    const start = rel();
    try {
      return await rpc(method, params);
    } finally {
      const keys = method === "simulateTransaction" ? ((params[1] as { accounts?: { addresses?: unknown[] } })?.accounts?.addresses?.length ?? 0) : method === "getMultipleAccounts" ? (params[0] as unknown[]).length : undefined;
      calls.push({ at, method, start, end: rel(), ...(keys !== undefined ? { keys } : {}) });
    }
  };
  // fresh provider functions each run: new paced queues, as on a page just opened
  const a = timed(solanaJsonRpc(PROVIDER_A, { timeoutMs: 15_000 }), "A");
  const b = timed(solanaHelperRpc(HELPER, { timeoutMs: 15_000 }), "B");
  let signedAt: number | null = null;
  const record: SolanaTradeRecord = await runSolanaTrade(
    { side: route.side, token: route.mint, slippageBps: SLIPPAGE_BPS, wallets: [WALLET], legs: [{ wallet: WALLET, amount: route.amount, arm: { own: true } }] },
    {
      helper: HELPER,
      providers: [a, b],
      reference: async (q, providers) => {
        const start = rel();
        try {
          return await readSolanaReference(providers, q);
        } finally {
          calls.push({ at: "ref", method: "reference", start, end: rel() });
        }
      },
      fetch: async (url: string, init: RequestInit) => {
        const start = rel();
        try {
          return await fetch(url, init);
        } finally {
          calls.push({ at: "helper", method: "build", start, end: rel() });
        }
      },
      paths: solanaSendPaths({ helper: solanaHelperRpc(HELPER) }),
      dry: true,
      onProgress: (s) => { if (s === "signed") signedAt = rel(); },
    },
  );
  const total = rel();
  const leg = record.legs[0] as SolanaTradeRecord["legs"][number];
  const quote = signedAt ?? NaN;
  const before = calls.filter((c) => c.end <= quote);
  const span = (xs: Call[]) => (xs.length ? Math.max(...xs.map((c) => c.end)) - Math.min(...xs.map((c) => c.start)) : 0);
  const builds = before.filter((c) => c.method === "build");
  const buildEnd = builds.length ? Math.max(...builds.map((c) => c.end)) : 0;
  const sims = before.filter((c) => c.method === "simulateTransaction");
  const firstSim = sims.length ? Math.min(...sims.map((c) => c.start)) : quote;
  const lastSim = sims.length ? Math.max(...sims.map((c) => c.end)) : quote;
  const stage = {
    first: Math.max(0, ...before.filter((c) => c.method === "reference" || c.method === "getLatestBlockhash").map((c) => c.end)),
    build: span(builds),
    buildCalls: builds.length,
    tables: span(before.filter((c) => c.method === "getMultipleAccounts" && c.start >= Math.min(...builds.map((x) => x.start)) && c.end <= firstSim && c.start > (builds[0]?.end ?? 0) - 1)),
    simA1: span(sims.filter((c) => c.at === "A" && c.keys === 4)),
    simB1: span(sims.filter((c) => c.at === "B" && c.keys === 4)),
    simA2: span(sims.filter((c) => c.at === "A" && c.keys !== 4)),
    simB2: span(sims.filter((c) => c.at === "B" && c.keys !== 4)),
    sims: lastSim - firstSim,
    again: span(before.filter((c) => c.method === "getMultipleAccounts" && c.start >= lastSim - 1)),
    checks: quote - Math.max(0, ...before.map((c) => c.end)),
    buildEndToFirstSim: firstSim - buildEnd,
  };
  const ok = !leg.refused && leg.verdict?.ok === true && leg.dry?.state === "simulated";
  return {
    route: `${route.side} ${route.mint.slice(0, 5)}… ${route.amount}`,
    ok,
    quote: Math.round(quote),
    total: Math.round(total),
    kitQuoteMs: leg.quoteMs === undefined ? null : Math.round(leg.quoteMs),
    stage: Object.fromEntries(Object.entries(stage).map(([k, v]) => [k, Math.round(v)])),
    secondSimulation: sims.some((c) => c.keys !== 4),
    checksRun: leg.verdict?.results.map((x) => `${x.id}${x.ok ? "" : "!"}`).join(" ") ?? null,
    refused: leg.refused ?? null,
    simulationErrors: leg.simulationErrors ?? null,
    rpcCalls: { A: calls.filter((c) => c.at === "A" && c.end <= quote).length, B: calls.filter((c) => c.at === "B" && c.end <= quote).length },
    calls: calls.sort((x, y) => x.start - y.start).map((c) => `${c.at} ${c.method}${c.keys !== undefined ? `/${c.keys}` : ""} ${Math.round(c.start)}-${Math.round(c.end)}`),
  };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
};
const runs: Awaited<ReturnType<typeof once>>[] = [];
for (let i = 0; i < N; i++) {
  for (const route of ROUTES) {
    let r;
    try {
      r = await once(route);
    } catch (e) {
      r = { route: `${route.side} ${route.mint.slice(0, 5)}…`, ok: false, quote: NaN, error: String((e as Error)?.message ?? e).slice(0, 200) } as unknown as Awaited<ReturnType<typeof once>>;
    }
    runs.push(r);
    console.error(`${i} ${r.route} ok=${r.ok} quote=${r.quote}ms ${JSON.stringify(r.stage ?? {})}${r.refused ? ` refused: ${r.refused}` : ""}`);
    await new Promise((res) => setTimeout(res, GAP_MS));
  }
}
const good = runs.filter((r) => r.ok);
const quotes = good.map((r) => r.quote);
const stageNames = Object.keys(good[0]?.stage ?? {});
const table = Object.fromEntries(["quote", ...stageNames].map((k) => {
  const xs = good.map((r) => (k === "quote" ? r.quote : (r.stage as Record<string, number>)[k] as number));
  return [k, { p50: pct(xs, 50), p95: pct(xs, 95) }];
}));
const byRoute = Object.fromEntries(ROUTES.map((rt) => {
  const name = `${rt.side} ${rt.mint.slice(0, 5)}… ${rt.amount}`;
  const xs = good.filter((r) => r.route === name).map((r) => r.quote);
  return [name, { n: xs.length, p50: xs.length ? pct(xs, 50) : null, p95: xs.length ? pct(xs, 95) : null }];
}));
const p50 = quotes.length ? pct(quotes, 50) : Infinity;
const p95 = quotes.length ? pct(quotes, 95) : Infinity;
const bound = { p50Under: 1_000, p95Under: 1_300, pass: p50 < 1_000 && p95 < 1_300 };
const summary = { dry: true, at: new Date().toISOString(), helper: HELPER, providers: [PROVIDER_A, `${HELPER}/v1/rpc/solana`], wallet: WALLET, n: runs.length, ok: good.length, secondSimulation: good.filter((r) => r.secondSimulation).length, table, byRoute, bound };
const out = args("--out")[0];
if (out) writeFileSync(out, `${JSON.stringify({ ...summary, runs }, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
const failed = runs.length - good.length;
if (failed) console.error(`${failed} run(s) refused or failed`);
if (failed || (!bound.pass && !process.argv.includes("--no-bound"))) process.exit(1);
