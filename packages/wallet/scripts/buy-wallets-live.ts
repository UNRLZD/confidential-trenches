// The wallet's own restore reads for the live check of card wallet-per-buy (scripts/live-checks/wallet-per-buy.mjs runs
// this file, with scripts/net-window.mjs imported first, and judges what it prints). It runs buyWallets, the reader the
// device runs, for Ws j = 0..3 of the published A.8 test seed (test/vectors/a8.json: the all-zero entropy and its label;
// never any other key), on Solana mainnet and Base, each on two RPCs:
//   - the helper's /v1/rpc/{chain}, through solanaHelperHoldings or evmHelperHoldings exactly as the device builds them;
//   - a public RPC device-direct (api.mainnet-beta.solana.com, base-rpc.publicnode.com), through the same reader on its own url-less queue at HOLDINGS_RPC_LIMIT, as
//     holdingsRoute builds the helper's.
// Every request is recorded as it goes out (route, method, the W it names, minContextSlot or block hash, HTTP status,
// the answer's context slot), and it prints one JSON record on stdout:
//   node --import ./scripts/net-window.mjs packages/wallet/scripts/buy-wallets-live.ts [--helper <origin>]
import { readFileSync } from "node:fs";
import { SOLANA_PUBLIC_RPC_URL, solanaJsonRpc, solanaPacedRpc, type SolanaRpc } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { buyWallets, evmHelperHoldings, evmHoldingsReader, HOLDINGS_RPC_LIMIT, solanaHelperHoldings, solanaHoldingsReader, type BuyChain, type HoldingsReader, type SpentNote } from "../src/pool/buy-wallets.ts";

const A8 = JSON.parse(readFileSync(new URL("../test/vectors/a8.json", import.meta.url), "utf8")) as { inputs: { entropy: string }; l: string };
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(Buffer.from(A8.inputs.entropy, "hex"))));
const L = BigInt(`0x${A8.l}`);
const arg = (k: string, dflt: string): string => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : dflt);
const HELPER = arg("--helper", "https://api.confidential.unrealized.trade");
// solana-rpc.publicnode.com refuses getTokenAccountsByOwner (HTTP 403, 2026-11-03 06:10Z): the kit's public RPC instead
const PUBLIC = { sol: SOLANA_PUBLIC_RPC_URL, base: "https://base-rpc.publicnode.com" };
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// the spent notes whose Ws are j = 0..3: a deposit (j 0) and change notes 0..2 (j 1..3)
const SPENT: SpentNote[] = [{ ref: { kind: "deposit", s: 1n, i: 0 }, label: L }, ...[0, 1, 2].map((j) => ({ ref: { kind: "change" as const, l: L, j }, label: L }))];

type Call = { route: string; method: string; owner?: string; min?: number; at?: string; status: number; slot?: number; ms: number };
const calls: Call[] = [];
const t0 = Date.now();
const real = globalThis.fetch;
globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
  const q = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
  const p = q.params ?? [];
  const last = p[p.length - 1] as { minContextSlot?: number; blockHash?: string } | undefined;
  const owner = typeof p[0] === "string" ? p[0] : q.method === "eth_call" ? `0x${String((p[0] as { data?: string }).data).slice(-40)}` : undefined;
  const c: Call = { route: String(u), method: q.method, status: 0, ms: Date.now() - t0 };
  if (owner !== undefined) c.owner = owner;
  if (typeof last?.minContextSlot === "number") c.min = last.minContextSlot;
  if (typeof last?.blockHash === "string") c.at = last.blockHash;
  calls.push(c);
  const r = await real(u, init);
  c.status = r.status;
  if (r.ok) {
    try {
      const slot = ((await r.clone().json()) as { result?: { context?: { slot?: unknown } } }).result?.context?.slot;
      if (typeof slot === "number") c.slot = slot;
    } catch { /* not JSON: the reader refuses it */ }
  }
  return r;
}) as typeof fetch;

/** The reader on a public RPC: the reader the device runs, on its own url-less queue at HOLDINGS_RPC_LIMIT. */
function publicReader(chain: BuyChain, url: string): HoldingsReader {
  const bare = solanaJsonRpc(url);
  const own: SolanaRpc = (method, params) => bare(method, params);
  const rpc = solanaPacedRpc(own, HOLDINGS_RPC_LIMIT);
  return chain === "sol" ? solanaHoldingsReader(rpc) : evmHoldingsReader(rpc, [BASE_USDC]);
}

const plain = (h: { native: bigint; tokens: ReadonlyMap<string, { amount: bigint; frozen: boolean }>; unreadable: readonly string[] }) => ({
  native: String(h.native),
  tokens: Object.fromEntries([...h.tokens].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, { amount: String(v.amount), frozen: v.frozen }])),
  unreadable: [...h.unreadable],
});

async function route(chain: "sol" | "base", rpc: "helper" | "public") {
  const reader = rpc === "helper"
    ? (chain === "sol" ? solanaHelperHoldings(HELPER) : evmHelperHoldings(HELPER, "base", [BASE_USDC]))
    : publicReader(chain === "sol" ? "sol" : "evm", PUBLIC[chain]);
  const t = Date.now();
  const r = await buyWallets(SEED, [{ id: `${chain}-${rpc}`, chain: chain === "sol" ? "sol" : "evm", spent: SPENT, reader }]);
  return {
    chain, rpc, url: rpc === "helper" ? `${HELPER}/v1/rpc/${chain === "sol" ? "solana" : "base"}` : PUBLIC[chain], ms: Date.now() - t,
    wallets: r.wallets.map((w) => ({ j: w.j, address: w.address, holdings: plain(w.holdings) })).sort((a, b) => a.j - b.j),
    failed: r.failed,
  };
}

// one route at a time on each chain, so two readers never share one upstream's budget; the two chains side by side
const readAt = new Date().toISOString();
const [sol, base] = await Promise.all([
  (async () => [await route("sol", "helper"), await route("sol", "public")])(),
  (async () => [await route("base", "helper"), await route("base", "public")])(),
]);
process.stdout.write(`${JSON.stringify({ readAt, limit: HOLDINGS_RPC_LIMIT, routes: [...sol, ...base], calls })}\n`);
