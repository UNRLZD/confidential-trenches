// Records the device's EVM buy quote reads from Base and Robinhood Chain mainnet (card evm-pool-buy-quote): each case
// runs evmPoolBuyQuote on two public RPC providers and keeps every batch each provider was asked and answered, for
// test/evm-quote.test.ts to replay. Reads only: no key, no transaction, no money moves.
//   node packages/kit/test/evm-quote-record.ts            writes test/fixtures/evm-quote.json
//   node packages/kit/test/evm-quote-record.ts --speed 7  times 7 live quotes per chain (p50, p95), writes nothing
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evmJsonRpc, evmPoolBuyQuote, EvmQuoteError, type EvmPoolBuyQuoteRequest, type EvmRpc, type EvmRpcCall } from "../src/index.ts";

const PROVIDERS = {
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  robinhood: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org"],
} as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RH_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
// A Base token whose only pool found is a hooked native v4 pool (PoolManager Initialize log at block 53,4xx,xxx, read
// 2026-11-03 17:50Z on base-rpc.publicnode.com; its hook kept about 10% of a 0.001 ETH buy in that read)
const HOOKED_COIN = "0xf8e4cb8060649f6998bd7f917a4b4de27bea41e9";
const HOOK = "0xcd5198de17bd95f9c5cdaa761e61f0e569ee2444";
// A Base token with a hookless native v4 pool (0.3%, tick spacing 60) that runs out before 100 ETH: V4Quoter reverts
// NotEnoughLiquidity (read 2026-11-03 18:05Z on base-rpc.publicnode.com)
const THIN = "0xf6e5fd9907b8ec70e399f34bb84fc2782db4dfe5";

const v4 = (currencyIn: string, currency: string, fee: number, tickSpacing: number, hooks = ZERO) => ({
  venue: "uniswap-v4" as const,
  currencyIn,
  hops: [{ currency, fee, tickSpacing, hooks, hookData: "0x" }],
});
const v3 = (tokens: string[], fees: number[]) => ({ venue: "uniswap-v3" as const, tokens, fees });

// [name, request, the outcome the recording must show]
export const CASES: [string, EvmPoolBuyQuoteRequest, string][] = [
  ["base-ok", { chain: "base", token: USDC, amountIn: 10n ** 16n, slippageBps: 100, route: v3([BASE_WETH, USDC], [100]) }, "ok"],
  ["base-below", { chain: "base", token: USDC, amountIn: 10n ** 16n, slippageBps: 100, route: v3([BASE_WETH, USDC], [10000]) }, "below_reference"],
  ["base-partial-v4", { chain: "base", token: THIN, amountIn: 10n ** 20n, slippageBps: 100, route: v4(ZERO, THIN, 3000, 60) }, "partial_fill"],
  ["base-hook", { chain: "base", token: HOOKED_COIN, amountIn: 10n ** 15n, slippageBps: 300, route: v4(ZERO, HOOKED_COIN, 0, 60, HOOK) }, "ok"],
  ["robinhood-ok", { chain: "robinhood", token: USDG, amountIn: 10n ** 15n, slippageBps: 100, route: v4(ZERO, USDG, 100, 1) }, "ok"],
  ["robinhood-weth-v4", { chain: "robinhood", token: USDG, amountIn: 10n ** 15n, slippageBps: 100, route: v4(RH_WETH, USDG, 500, 10) }, "native_first"],
  ["robinhood-weth-v3", { chain: "robinhood", token: USDG, amountIn: 10n ** 15n, slippageBps: 100, route: v3([RH_WETH, USDG], [100]) }, "native_first"],
];

type Exchange = { calls: readonly EvmRpcCall[]; answers: readonly unknown[] };
const recording = (rpc: EvmRpc, log: Exchange[]): EvmRpc => async (calls) => {
  const answers = await rpc(calls);
  log.push({ calls, answers });
  return answers;
};
const outcome = async (req: EvmPoolBuyQuoteRequest, rpcs: readonly [EvmRpc, EvmRpc]) => {
  try {
    const q = await evmPoolBuyQuote(req, rpcs);
    return { code: "ok", detail: `Q ${q.amountOut} minOut ${q.minOut} R ${q.reference?.amountOut ?? "none"} hook ${q.hook ? `${q.hook.hookless} take ${q.hook.take} (${q.hook.takeBps} bps)` : "none"}` };
  } catch (e) {
    if (e instanceof EvmQuoteError) return { code: e.code, detail: e.message + (e.reference ? ` (reference ${JSON.stringify(e.reference.route)})` : "") };
    throw e;
  }
};
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const speed = process.argv.indexOf("--speed");
  if (speed > 0) {
    const n = Number(process.argv[speed + 1] ?? 5);
    for (const [name, req] of CASES.filter(([n]) => n === "base-ok" || n === "robinhood-ok" || n === "base-hook")) {
      const rpcs = PROVIDERS[req.chain as "base" | "robinhood"].map((u) => evmJsonRpc(u)) as unknown as [EvmRpc, EvmRpc];
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        const r = await outcome(req, rpcs);
        ms.push(performance.now() - t);
        if (r.code !== "ok") console.log(name, "run", i, r.code, r.detail);
      }
      ms.sort((a, b) => a - b);
      const pct = (p: number) => Math.round(ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)]!);
      console.log(`${name}: n=${n} p50 ${pct(50)} ms p95 ${pct(95)} ms (min ${Math.round(ms[0]!)}, max ${Math.round(ms[ms.length - 1]!)})`);
    }
  } else {
    const out: Record<string, unknown> = {};
    let bad = 0;
    for (const [name, req, want] of CASES) {
      const logs: [Exchange[], Exchange[]] = [[], []];
      const urls = PROVIDERS[req.chain as "base" | "robinhood"];
      const rpcs = [recording(evmJsonRpc(urls[0]), logs[0]), recording(evmJsonRpc(urls[1]), logs[1])] as const;
      const r = await outcome(req, rpcs);
      console.log(`${r.code === want ? "ok  " : "FAIL"} ${name}: ${r.code} (want ${want}) ${r.detail}`);
      if (r.code !== want) bad++;
      // the request's token is kept as "buys": gitleaks' generic-api-key rule reads a "token" key with a hex value as a secret
      const { token, ...rest } = req;
      out[name] = { recorded: new Date().toISOString(), providers: urls, request: { ...rest, buys: token }, outcome: r, exchanges: logs };
    }
    if (bad > 0) process.exit(1);
    writeFileSync(fileURLToPath(new URL("./fixtures/evm-quote.json", import.meta.url)), json(out) + "\n");
  }
}
